/**
 * LifeCard store —— 工作区的读写。
 *
 * 只跑在宿主侧（Node）。浏览器侧一律经 HTTP 路由调这里，不直接碰文件。
 *
 * 设计约束（来自 SPEC §11）：
 *   - 文件系统是唯一真源；没有任何 KV 缓存充当第二真源。
 *   - `materials/` 只追加、不可编辑；`interviews/` 只追加。
 *   - 删除写墓碑到 `redactions.jsonl`，读取时先过墓碑。
 *   - 快照存全文，不存 diff。
 */

import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import * as core from './core.js'

/** 目录骨架。init 时一次性建出来。 */
const SKELETON = [
  'self',
  'people',
  'relations',
  'worlds/reality',
  'systems',
  'materials',
  'interviews',
  'proposals',
  'story/chapters',
  'story/state/snapshots',
  'assets',
  'jobs',
  'jobs/evaluations',
  '.lifecard/raw',
  '.lifecard/snapshots',
]

const CONFIG_NAME = 'lifecard.config.json'

/**
 * 提案不许改的结构字段。
 *
 * `id`（SPEC §2 全局唯一短标识，卡文件路径/关系端点/头像都靠它）和
 * `lifecard`（恒为 "0.1"）一旦被提案改写，卡会从列表和路径上消失。
 * 这不是「对一个人的判断」，所以不该走提案这条路。
 */
// 提案不许改的字段。前两个是结构约束（改了卡会从列表和路径上消失），
// 后三个是**事实与法律状态**，只有人能填：
//   kind    这张卡是真人还是虚构——猜错了，同一段材料会被当成可以随便写的角色
//   world   世界观归属是结构决定，写一个不存在的 id 会让卡从任何视图里消失
//   consent 对方是否知情、依据是什么。模型没问过任何人，不能替人声明「对方同意了」。
// 用户想改这三项，去卡片的编辑器里改——那里有确认动作，也有上下文。
const RESERVED_FIELDS = new Set(['id', 'lifecard', 'kind', 'world', 'consent'])

/**
 * 本地时区的 YYYY-MM-DD。
 *
 * 之前用 `new Date().toISOString().slice(0, 10)`，那是 UTC 日期：
 * 北京时间 0 点到 8 点之间写进来的材料/提案会被记成前一天，
 * 文件名和正文里的日期对不上。
 * @param {Date} [now]
 * @returns {string}
 */
/** 本地日期（YYYY-MM-DD）。别用 toISOString：那是 UTC，东八区早上八点前会差一天。 */
export function localDate(now = new Date()) {
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 10)
}

/** 默认配置。 */
export function defaultConfig() {
  return {
    lifecard: core.DATA_VERSION,
    name: '我的档案',
    default_system: 'reality-interview',
    locale: 'zh',
    created_at: new Date().toISOString(),
  }
}

// ── 工作区 ────────────────────────────────────────────────────────

/**
 * 打开一个工作区。目录不存在时按需创建。
 * @param {string} root - 绝对路径。
 * @param {{ create?: boolean }} [options]
 */
export async function openWorkspace(root, options = {}) {
  const abs = path.resolve(root)
  let exists = true
  try {
    const st = await fs.stat(abs)
    if (!st.isDirectory()) throw new Error(`不是文件夹：${abs}`)
  } catch {
    exists = false
  }
  if (!exists) {
    if (options.create !== true) return { ok: false, root: abs, exists: false, error: `文件夹不存在：${abs}` }
    await fs.mkdir(abs, { recursive: true })
  }
  if (options.create === true) {
    for (const dir of SKELETON) await fs.mkdir(path.join(abs, dir), { recursive: true })
    const configPath = path.join(abs, CONFIG_NAME)
    try {
      await fs.access(configPath)
    } catch {
      await fs.writeFile(configPath, JSON.stringify(defaultConfig(), null, 2) + '\n', 'utf8')
    }
  }
  return { ok: true, root: abs, exists: true }
}

/** 本地时间戳，给「覆盖前备份」这种文件名用。 */
function freeLocalStamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** 读工作区配置；没有就给默认值（不写盘）。 */
export async function readConfig(root) {
  return (await readConfigState(root)).config
}

/**
 * 读配置，并且**告诉调用方「是没有，还是读不出来」**。
 *
 * 以前只有 `readConfig` 一个口子：任何异常都 `return defaultConfig()`。
 * 于是 config.json 一旦读不出来（权限、损坏、同步盘没挂上），
 * 紧跟着的一次 `writeConfig` 会把整份配置按默认值重写回去 —— 用户的
 * 「想要什么样的人」「看过介绍了没有」全部归零，而且没人知道。
 */
export async function readConfigState(root) {
  let text
  try {
    text = await fs.readFile(path.join(root, CONFIG_NAME), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, exists: false, config: defaultConfig() }
    return { ok: false, exists: false, config: defaultConfig(), error: '这个文件夹里的设置读不出来。检查一下文件权限，再试一次。' }
  }
  try {
    const json = JSON.parse(text)
    return { ok: true, exists: true, config: { ...defaultConfig(), ...json } }
  } catch {
    return { ok: false, exists: true, config: defaultConfig(), error: '这个文件夹里的设置文件坏了。这一版没敢动它，先跳过。' }
  }
}

/**
 * 写配置。
 *
 * 先建目录：还没选文件夹（或选的那个被删了）时直接写文件会抛 ENOENT，
 * 界面拿到的是一句英文报错，人看不出「你还没选文件夹」。
 */
export async function writeConfig(root, patch) {
  const state = await readConfigState(root)
  // 「读不出来」不等于「还没有」：这时候照写会把整份设置按默认值重刷一遍。
  if (state.ok !== true) return state.config
  const next = { ...state.config, ...patch }
  const abs = path.join(root, CONFIG_NAME)
  const tmp = `${abs}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
    await fs.rename(tmp, abs)
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {})
  }
  return next
}

/**
 * 读「想要什么样的人」。
 *
 * 为什么存在 config 里而不是卡里：它是**你**的意图，不是那个人的事实。
 * 写进卡文件会被当成字段导出给别的工具，而别的工具分不清哪些是材料里
 * 写着的、哪些只是你希望它是这样。
 *
 * @returns {Promise<{idea: string, avoid: string[], want: string[], updated_at?: string}|null>}
 */
/**
 * 记下「这个人是从记忆里认出来的，还缺哪几样」。
 *
 * 为什么不写在卡上：卡文件是要能给人看、能导出的。把「这条是软件从记忆里
 * 猜的、还不全」写进卡，等于把内部状态漏给下游工具。它属于**你这边**的
 * 待办，不是那个人的事实——和 concept 一样放配置里。
 *
 * 存成 `{ [名字或关系]: ['名字', '出生时间'] }`。同名不同关系用 `关系:名字` 区分。
 */
export async function rememberMemoryPeople(root, people) {
  const map = {}
  for (const p of Array.isArray(people) ? people : []) {
    if (p === null || typeof p !== 'object') continue
    const key = String(p.name ?? '').trim() === '' ? String(p.kin ?? '') : `${p.kin}:${p.name}`
    if (key === '') continue
    const missing = Array.isArray(p.missing) ? p.missing.filter((m) => typeof m === 'string') : []
    map[key] = { kin: String(p.kin ?? ''), name: String(p.name ?? ''), missing }
  }
  const config = await readConfig(root)
  const merged = { ...(config?.memory_people ?? {}), ...map }
  await writeConfig(root, { memory_people: merged })
  return { ok: true, count: Object.keys(map).length }
}

/**
 * 这张卡是不是「从记忆里认出来的、还不全」。
 *
 * 只认「还不全」的那种。信息齐了就不红——红点必须代表「有事要做」，
 * 否则天天亮着，人就不看了。
 *
 * @returns {{from_memory: boolean, missing: string[], flag: boolean}}
 */
export async function memoryStatusOf(root, data) {
  const empty = { from_memory: false, missing: [], flag: false }
  const name = String(data?.name ?? '').trim()
  const relation = String(data?.relation ?? '').trim()
  if (name === '') return empty
  const config = await readConfig(root)
  const map = config?.memory_people
  if (map === null || typeof map !== 'object') return empty
  const candidates = Object.values(map).filter((v) => v !== null && typeof v === 'object' && String(v.name ?? '') === name)
  if (candidates.length === 0) return empty

  // 同名的人可能有好几个（重名的朋友、同名的亲戚）。这时关系是唯一的区分，
  // 必须让关系也对上；对不上就当不是同一个人，宁可不红。
  // 只有一个同名的人时才允许「关系改过」的宽松匹配——否则用户把「母亲」
  // 改成「妈」之后红点就再也不出现，而他明明还缺东西。
  let hit = candidates.find((v) => String(v.kin ?? '') !== '' && relation.includes(String(v.kin)))
  if (hit === undefined) {
    if (candidates.length > 1) return empty
    hit = candidates[0]
  }
  const missing = Array.isArray(hit.missing) ? hit.missing : []
  return { from_memory: true, missing, flag: missing.length > 0 }
}

export async function readConcept(root) {
  const config = await readConfig(root)
  const raw = config?.concept
  if (raw === null || typeof raw !== 'object') return null
  const idea = typeof raw.idea === 'string' ? raw.idea.trim() : ''
  const want = Array.isArray(raw.want) ? raw.want.map((s) => String(s).trim()).filter((s) => s !== '') : []
  const avoid = Array.isArray(raw.avoid) ? raw.avoid.map((s) => String(s).trim()).filter((s) => s !== '') : []
  if (idea === '' && want.length === 0 && avoid.length === 0) return null
  return {
    idea,
    want,
    avoid,
    ...(typeof raw.updated_at === 'string' ? { updated_at: raw.updated_at } : {}),
  }
}

/**
 * 写「想要什么样的人」。全空等于清除。
 * @param {{idea?: string, want?: string[], avoid?: string[]}|null} concept
 */
export async function writeConcept(root, concept) {
  const clean = (list) => (Array.isArray(list) ? list.map((s) => String(s).trim()).filter((s) => s !== '') : [])
  const idea = typeof concept?.idea === 'string' ? concept.idea.trim() : ''
  const want = clean(concept?.want)
  const avoid = clean(concept?.avoid)
  if (idea === '' && want.length === 0 && avoid.length === 0) {
    const current = await readConfig(root)
    const next = { ...current }
    delete next.concept
    await fs.writeFile(path.join(root, CONFIG_NAME), JSON.stringify(next, null, 2) + '\n', 'utf8')
    return { ok: true, concept: null }
  }
  const value = { idea, want, avoid, updated_at: new Date().toISOString() }
  await writeConfig(root, { concept: value })
  return { ok: true, concept: value }
}

// ── 草稿 ──────────────────────────────────────────────────────────
//
// 写卡写到一半关掉，以前就白写了。草稿是给人留的后路：把「还没点保存的
// 那半张卡」原样存下来，下次打开同一张卡时问一句「接着上次写的？」。
//
// 为什么放在 .lifecard/drafts/ 而不是卡文件里：
//   - 卡文件是归档，草稿是过程。过程不该进 git diff。
//   - 一张卡同时只有一份草稿，保存成功后立刻删掉，不会越积越多。
//   - 草稿永远不参与体检、打分、导出——它还没定稿。

const DRAFTS_DIR = '.lifecard/drafts'

function draftRelPath(cardId) {
  return path.posix.join(DRAFTS_DIR, `${core.safeId(cardId)}.json`)
}

/**
 * 存一份草稿。同一张卡反复存只保留最新那份。
 *
 * @param {string} root
 * @param {string} cardId 这张卡将来会用的 id（新卡还没 id 时由调用方先定一个）
 * @param {{ data?: object, sections?: Array<{title: string, body: string}>, avatarTouched?: boolean, avatar?: string|null }} draft
 */
export async function writeDraft(root, cardId, draft) {
  const id = String(cardId ?? '').trim()
  if (id === '') return { ok: false, error: '还没给这张卡一个 id，草稿没法存。' }
  const rel = draftRelPath(id)
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  const payload = {
    id: core.safeId(id),
    saved_at: new Date().toISOString(),
    data: draft?.data ?? {},
    sections: Array.isArray(draft?.sections) ? draft.sections : [],
    // 头像很大（几百 KB 的 base64）。草稿里只在用户真动过头像时才带，
    // 否则每存一次草稿都把同一个头像重写一遍，盘上全是重复。
    avatar_touched: draft?.avatarTouched === true,
    ...(draft?.avatarTouched === true ? { avatar: draft?.avatar ?? null } : {}),
  }
  // 草稿也是「写一半掉电就废」的那种文件，跟卡片一样走 tmp+rename。
  const tmp = `${abs}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  await fs.rename(tmp, abs)
  return { ok: true, draft: payload }
}

/**
 * 读草稿。没有就返回 null——「没有草稿」是正常状态，不是错误。
 * @returns {Promise<object|null>}
 */
export async function readDraft(root, cardId) {
  const id = String(cardId ?? '').trim()
  if (id === '') return null
  try {
    const text = await fs.readFile(path.join(root, draftRelPath(id)), 'utf8')
    const raw = JSON.parse(text)
    if (raw === null || typeof raw !== 'object') return null
    return {
      id: String(raw.id ?? core.safeId(id)),
      saved_at: typeof raw.saved_at === 'string' ? raw.saved_at : null,
      data: raw.data !== null && typeof raw.data === 'object' ? raw.data : {},
      sections: Array.isArray(raw.sections) ? raw.sections : [],
      avatar_touched: raw.avatar_touched === true,
      avatar: typeof raw.avatar === 'string' ? raw.avatar : null,
    }
  } catch {
    return null
  }
}

/** 删草稿。保存成功之后必须调它，否则下次打开会拿旧草稿盖掉刚存的内容。 */
export async function removeDraft(root, cardId) {
  const id = String(cardId ?? '').trim()
  if (id === '') return { ok: true }
  await fs.rm(path.join(root, draftRelPath(id)), { force: true })
  return { ok: true }
}

/** 列出所有草稿（界面用来提示「有 2 张卡还没写完」）。 */
export async function listDrafts(root) {
  const dir = path.join(root, DRAFTS_DIR)
  let names = []
  try {
    names = await fs.readdir(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    const d = await readDraft(root, id)
    if (d === null) continue
    out.push({
      id: d.id,
      name: typeof d.data?.name === 'string' ? d.data.name : '',
      saved_at: d.saved_at,
      filled: d.sections.filter((s) => String(s?.body ?? '').trim() !== '').length,
    })
  }
  return out.sort((a, b) => String(b.saved_at ?? '').localeCompare(String(a.saved_at ?? '')))
}

// ── 墓碑 ──────────────────────────────────────────────────────────

/**
 * 读全部墓碑。`redactions.jsonl` 只追加、不可删除。
 * @returns {Promise<Array<{at: string, path?: string, id?: string, sha256?: string, reason?: string}>>}
 */
export async function readRedactions(root) {
  const file = path.join(root, 'redactions.jsonl')
  let text = ''
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try {
      out.push(JSON.parse(t))
    } catch {
      // 坏行跳过，不让一行烂数据废掉整个撤回机制
    }
  }
  return out
}

/** 追加一条墓碑。 */
export async function appendRedaction(root, entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
  await fs.appendFile(path.join(root, 'redactions.jsonl'), line + '\n', 'utf8')
  return line
}

/**
 * 某个文件路径 + 内容是否命中墓碑。
 *
 * 一条墓碑至少要有一个**可比较的键**（path 或 sha256）才算数。
 * 之前没有这个下限：只写了 anchor 的残条会让三个 continue 全不触发，
 * 于是对任何文件都返回命中——`redactions.jsonl` 里手抖写进一条
 * `{anchor:"…", reason:"…"}`，全库的卡都会变成「已被撤回」。
 * anchor 只能当附加条件，不能单独承担撤回。
 */
function hitsRedaction(redactions, relPath, content) {
  const hash = content === undefined ? undefined : sha256(content)
  for (const r of redactions) {
    const hasPath = typeof r.path === 'string' && r.path !== ''
    const hasHash = typeof r.sha256 === 'string' && r.sha256 !== ''
    // 两个键都没有：这条墓碑说不出撤回的是什么，不能命中任何东西。
    if (!hasPath && !hasHash) continue
    if (hasPath && relPath !== undefined && r.path !== relPath) continue
    if (hasHash && hash !== undefined && r.sha256 !== hash) continue
    if (hasHash && hash === undefined) continue
    return r
  }
  return undefined
}

/**
 * 把工作区相对路径解析成绝对路径，并保证它没跑到工作区外面。
 *
 * 卡 id、文件名都可能来自外部（模型、导入的 JSON），
 * `path.join(root, '../x')` 会安静地写到工作区外。
 * 越界返回 `{ok:false}` 而不抛异常——上层路由是按返回值处理的。
 */
export async function resolveIn(root, rel) {
  const base = path.resolve(root)
  const abs = path.resolve(base, String(rel ?? ''))
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    return { ok: false, error: '路径在工作区外面，拒绝访问' }
  }
  // 上面只判了字面。符号链接能绕过去：工作区里放一个指向别处的软链，
  // 读写就真的落在工作区外面了。所以按实体路径再判一次。
  const realBase = await realpathLoose(base)
  const realTarget = await realpathLoose(abs)
  if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) {
    return { ok: false, error: '路径在工作区外面，拒绝访问' }
  }
  return { ok: true, abs }
}

/**
 * 求实体路径：从最深的、已经存在的那一层往上找到第一个存在的祖先，
 * 对它 realpath，再把还不存在的那几段拼回去。
 *
 * 目标文件往往还不存在（新建卡、新存一份材料），所以不能直接 realpath 整个
 * 路径；但它的父目录一般存在，那里才是软链可能藏身的地方。
 *
 * @param {string} abs
 * @returns {Promise<string>}
 */
export async function realpathLoose(abs) {
  const rest = []
  let head = abs
  for (;;) {
    try {
      const real = await fs.realpath(head)
      return rest.length === 0 ? real : path.join(real, ...rest.slice().reverse())
    } catch (err) {
      // 不存在（或中间某一级是文件）就往上退一层；别的原因（EACCES）就
      // 原样返回，让真正的读写去报那个错，这里不冒充结论。
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') return abs
      const parent = path.dirname(head)
      if (parent === head) return abs
      rest.push(path.basename(head))
      head = parent
    }
  }
}

export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

// ── 卡片读写 ──────────────────────────────────────────────────────

/**
 * 列出一张卡所在的相对路径。
 * 主世界实体在 `people/`，分支世界实体在 `worlds/<slug>/cards/`。
 */
export function cardRelPath(id, world) {
  const fileName = core.cardFileName(id)
  if (world === undefined || world === null || world === '' || world === 'reality') return path.posix.join('people', fileName)
  return path.posix.join('worlds', core.safeId(world), 'cards', fileName)
}

/**
 * 读一张卡（已过墓碑过滤）。
 * @returns {Promise<{ok: boolean, path?: string, text?: string, data?: object, sections?: object[], error?: string}>}
 */
export async function readCard(root, relPath) {
  const at = await resolveIn(root, relPath)
  if (!at.ok) return { ok: false, path: relPath, error: at.error }
  const abs = at.abs
  let text
  try {
    text = await fs.readFile(abs, 'utf8')
  } catch (error) {
    // 「没有这个文件」和「有，但读不出来」是两件事。以前一律翻成「文件不存在」，
    // 上层于是把权限问题、同步盘没挂上当「还没有这张卡」——`card.save` 的兜底
    // 会退化成空小节，`applyProposal` 会另建一张同名的卡。
    if (error?.code === 'ENOENT') return { ok: false, path: relPath, error: '文件不存在' }
    return {
      ok: false,
      path: relPath,
      code: String(error?.code ?? ''),
      error: '这个文件读不出来（可能被占用，或者没有读取权限）。关掉占着它的程序，或者检查一下权限。',
    }
  }
  const redactions = await readRedactions(root)
  const hit = hitsRedaction(redactions, relPath, text)
  if (hit !== undefined) {
    return { ok: false, path: relPath, error: `这条记录已被撤回（${hit.reason ?? '未说明原因'}），不再显示` }
  }
  const parsed = core.parseCard(text)
  // 解析失败要说失败。以前无论 parse 成不成一律 ok:true，于是格式坏掉的卡
  // 会以「一张什么都没有的卡」出现在列表里，而界面上那句「有 N 个文件读不了」
  // 永远不触发——用户看得见坏结果，却看不见原因。
  if (parsed.ok !== true) {
    return {
      ok: false,
      path: relPath,
      text,
      error: `这个文件读不出来：${(parsed.errors ?? []).join('；') || '格式不对'}`,
      parse: parsed,
    }
  }
  return { ok: true, path: relPath, text, data: parsed.data, sections: parsed.sections, parse: parsed }
}

/**
 * 造一个在本目录里没被占用的快照时间戳。
 *
 * 时间戳只精确到毫秒。程序化连续保存（AI 批量采纳、脚本、测试）
 * 很容易在同一毫秒里写完两次，直接写文件就会把上一份快照覆盖掉——
 * 那不是「历史」，那是悄悄丢数据。撞了就在后面加 -2、-3。
 */
async function freeStamp(dir, when) {
  const base = when.toISOString().replace(/[:.]/g, '-')
  let stamp = base
  for (let n = 2; n < 1000; n++) {
    const exists = await fs.access(path.join(dir, `${stamp}.md`)).then(() => true).catch(() => false)
    if (!exists) return stamp
    stamp = `${base}-${n}`
  }
  // 极端情况：同一毫秒里存了一千次。加随机尾巴，保证不覆盖。
  return `${base}-${Math.random().toString(36).slice(2, 8)}`
}

/** 写一张卡，并在写前留一份全文快照。 */
export async function writeCard(root, relPath, data, sections, options = {}) {
  const validation = core.validateCard(data)
  if (!validation.ok && options.force !== true) {
    return { ok: false, error: '校验未通过', validation }
  }
  const at = await resolveIn(root, relPath)
  if (!at.ok) return { ok: false, path: relPath, error: at.error }
  const abs = at.abs
  await fs.mkdir(path.dirname(abs), { recursive: true })
  // 快照：旧内容存全文（快照是审计依据，不能只存 diff）
  let old = null
  try {
    old = await fs.readFile(abs, 'utf8')
  } catch (err) {
    // 只有「本来就没有这张卡」可以放过去。别的读失败（权限、磁盘）必须
    // 让这次写入停下来：悄悄跳过快照再覆盖，等于把唯一的回滚依据丢了，
    // 而用户只会看到「保存成功」。
    if (err?.code !== 'ENOENT') {
      return { ok: false, path: relPath, error: '这张卡原来的内容读不出来，为了不覆盖掉它，这次没存。检查一下文件权限或磁盘空间，再试一次。' }
    }
  }
  if (old !== null) {
    try {
      const snapDir = path.join(root, '.lifecard/snapshots', relPath.replace(/[\\/]/g, '__'))
      await fs.mkdir(snapDir, { recursive: true })
      await fs.writeFile(path.join(snapDir, `${await freeStamp(snapDir, new Date())}.md`), old, 'utf8')
    } catch {
      // 快照留不下就不许覆盖：留不下快照还照写，就是「丢了一份文件还报成功」。
      return { ok: false, path: relPath, error: '这次改动之前的那一版没能备份下来，为了不丢掉它，这次没存。检查一下磁盘空间，再试一次。' }
    }
  }
  const text = core.stringifyCard(data, sections)
  // 落盘要走「临时文件 + 改名」。以前这里是 fs.writeFile 直接截断写：
  // 写一半掉电（或宿主把进程杀掉），留下的就是半张卡 —— parseCard 读不出来，
  // 下次打开是「这个文件读不出来」。卡是全库最要紧的那份数据，
  // 别的存档层（tavern/novel/game/presets/career）早就都改了，只有它漏着。
  try {
    const tmp = `${abs}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, abs)
  } catch {
    return { ok: false, path: relPath, error: '这一版没能存进文件里。检查一下磁盘是不是满了，再试一次。' }
  }
  return { ok: true, path: relPath, text, validation }
}

/**
 * 列出某张卡保存过的历史版本。
 *
 * 快照在 `writeCard` 里已经默默存了很久（存的是**写之前**的全文），
 * 但界面上从来没露出来过——等于用户有一份撤销药却没告诉他能吃。
 * 这里只负责「列出来」，读某一版走 readSnapshot。
 *
 * @returns {Promise<{ok: boolean, versions: {stamp: string, when: string, bytes: number}[]}>}
 */
export async function listSnapshots(root, relPath) {
  const snapDir = path.join(root, '.lifecard/snapshots', String(relPath).replace(/[\\/]/g, '__'))
  let entries
  try {
    entries = await fs.readdir(snapDir)
  } catch {
    return { ok: true, versions: [] }
  }
  const versions = []
  for (const name of entries) {
    if (!name.endsWith('.md')) continue
    const stamp = name.slice(0, -3)
    let bytes = 0
    try {
      bytes = (await fs.stat(path.join(snapDir, name))).size
    } catch {
      continue
    }
    // 文件名里的时间戳是 ISO 把 : 和 . 换成 - 得到的，换回来才能当日期读。
    // 同一毫秒撞车时会带 -2、-3 后缀，解析前要切掉。
    const bare = stamp.replace(/-(\d+)$/, '')
    const iso = bare.replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ':$1:$2.$3Z')
    const d = new Date(iso)
    versions.push({
      stamp,
      when: Number.isNaN(d.getTime()) ? stamp : d.toISOString(),
      bytes,
    })
  }
  // 新的在前
  versions.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0))
  return { ok: true, versions }
}

/**
 * 读某一版历史内容（原文）。
 *
 * 注意不做墓碑过滤：墓碑管的是「当前这张卡还算不算数」，
 * 历史版本是用来看/找回内容的，不是拿去用的。所以这里如实返回原文。
 */
export async function readSnapshot(root, relPath, stamp) {
  const safeStamp = String(stamp ?? '').replace(/[^0-9A-Za-z._-]/g, '')
  if (safeStamp === '') return { ok: false, error: '版本号不合法' }
  const abs = path.join(root, '.lifecard/snapshots', String(relPath).replace(/[\\/]/g, '__'), `${safeStamp}.md`)
  let text
  try {
    text = await fs.readFile(abs, 'utf8')
  } catch {
    return { ok: false, error: '这个版本已经不在了' }
  }
  const parsed = core.parseCard(text)
  return { ok: true, stamp: safeStamp, text, data: parsed.data, sections: parsed.sections }
}

/**
 * 把某一版历史退回成当前内容。
 *
 * 走的是 writeCard，所以「恢复」这个动作本身也会先给当前内容留一份快照——
 * 用户按错了还能再退回来。这一点比「恢复」本身重要。
 */
export async function restoreSnapshot(root, relPath, stamp) {
  const old = await readSnapshot(root, relPath, stamp)
  if (old.ok !== true) return old
  const written = await writeCard(root, relPath, old.data, old.sections, { force: true })
  if (written.ok !== true) return written
  return { ok: true, path: relPath, validation: written.validation, note: '已经退回这一版。刚才那一版也还在历史里。' }
}

/**
 * 扫描整个工作区，列出所有卡（已过墓碑过滤）。
 * @returns {Promise<{cards: object[], worlds: object[], systems: object[], relations: object[], errors: object[]}>}
 */
export async function listAll(root) {
  const redactions = await readRedactions(root)
  const cards = []
  const worlds = []
  const systems = []
  const relations = []
  const errors = []
  const materials = []

  const walk = async (relDir) => {
    const abs = path.join(root, relDir)
    let entries
    try {
      entries = await fs.readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const rel = path.posix.join(relDir.replace(/\\/g, '/'), entry.name)
      if (entry.isDirectory()) {
        await walk(rel)
        continue
      }
      const lower = entry.name.toLowerCase()
      if (lower.endsWith('.card.md')) {
        const r = await readCard(root, rel)
        if (!r.ok) {
          if (r.error !== undefined && !r.error.startsWith('这条记录已被撤回')) errors.push({ path: rel, error: r.error })
          continue
        }
        const cov = core.coverage(r.data, r.sections)
        // `updated` 以前写的是文件名（entry.name），名实不符，也没人读。
        // 改成真实修改时间；读不到就留空，不要编一个。
        const stat = await fs.stat(path.join(root, rel)).catch(() => null)
        cards.push({
          path: rel,
          id: String(r.data?.id ?? ''),
          name: String(r.data?.name ?? r.data?.nickname ?? entry.name.replace(/\.card\.md$/i, '')),
          kind: String(r.data?.kind ?? 'real'),
          world: String(r.data?.world ?? 'reality'),
          relation: r.data?.relation,
          status: r.data?.status,
          tags: Array.isArray(r.data?.tags) ? r.data.tags : [],
          coverage: cov.percent,
          empty: cov.empty.map((e) => e.label),
          unmarkedRatio: cov.unmarkedRatio,
          issues: core.validateCard(r.data).issues,
          updated: stat === null ? undefined : stat.mtime.toISOString(),
        })
      } else if (lower.endsWith('.relation.md')) {
        const r = await readCard(root, rel)
        if (r.ok) relations.push({ path: rel, ...core.relationEdge(r.data), data: r.data })
      } else if (lower.endsWith('.system.md')) {
        const r = await readCard(root, rel)
        if (r.ok) systems.push({ path: rel, id: r.data?.id, name: r.data?.name, kind: 'system' })
      } else if (lower === 'world.md') {
        const r = await readCard(root, rel)
        if (r.ok) {
          worlds.push({
            path: rel,
            id: r.data?.id,
            name: r.data?.name,
            genre: r.data?.genre,
            kind: 'world',
            // 列表上直接显示「几条」，省得为一本世界书再发一次请求。
            entry_count: Number(r.data?.entry_count ?? core.parseWorldEntries(r.sections).length),
          })
        }
      } else if (isUnder(relDir, 'materials')) {
        const stat = await fs.stat(path.join(root, rel)).catch(() => null)
        materials.push({ path: rel, name: entry.name, size: stat?.size ?? 0, mtime: stat?.mtime?.toISOString?.() })
      }
    }
  }
  await walk('people')
  await walk('self')
  await walk('worlds')
  await walk('systems')
  await walk('relations')
  await walk('materials')

  return { cards, worlds, systems, relations, errors, materials, redactions }
}

/**
 * relDir 是否就在某个顶层目录之下。
 *
 * 注意 `walk('materials')` 时 relDir 就是 `materials`（末尾没有斜杠），
 * 用 `startsWith('materials/')` 判断会漏掉根层文件——这曾让 materials 列表
 * 一直显示 0，而文件其实好好躺在磁盘上。
 */
function isUnder(relDir, top) {
  const d = String(relDir).replace(/\\/g, '/')
  return d === top || d.startsWith(top + '/')
}

// ── 材料 ──────────────────────────────────────────────────────────

/**
 * 追加一条材料。材料只追加、不改写：它是原话的存档，所有断言都要能追回这里。
 *
 * 返回的 `sha256` 是**追加后的全文** hash，不是本次片段。墓碑按全文比对，
 * 拿片段 hash 去写墓碑永远匹配不上，撤回会静默失效。
 * 注意：早期版本返回的是片段 hash，已经写进 `redactions.jsonl` 的旧记录
 * 与现在的全文 hash 对不上，那部分撤回不会命中。不做自动迁移——迁移要
 * 重算全部历史材料的 hash，是另一个决定。
 *
 * @param {string} root
 * @param {string} name - 文件名（不含扩展名时会补 .md）
 * @param {string} content
 * @param {{ replace?: boolean }} [options] - replace:true 时覆盖同名文件而不是追加
 */
export async function appendMaterial(root, name, content, options = {}) {
  const safe = core.safeId(name).replace(/\.md$/i, '')
  const date = localDate()
  const fileName = safe.startsWith(date) ? `${safe}.md` : `${date}-${safe}.md`
  const rel = path.posix.join('materials', fileName)
  const at = await resolveIn(root, rel)
  if (!at.ok) return { ok: false, error: at.error }
  const abs = at.abs
  const body = content.endsWith('\n') ? content : content + '\n'
  await fs.mkdir(path.dirname(abs), { recursive: true })
  // 默认是追加（人一次次贴材料，越攒越多，这本来就要追加）。
  // 但有些材料是「重新摘一遍」而不是「再补一条」——比如从记忆里重新提取
  // 某个人。那种情况必须覆盖，否则同一个人每点一次就多一份重复的旧摘录，
  // 而 AI 读的时候会把两份都当真，同一个事实被引用两次。
  if (options?.replace === true) {
    // 材料是全库唯一**没有快照**的存档层（删了就真没了）。覆盖之前先留一份
    // `.bak-<时间>`，至少用户自己手改过的那一版还能找回来。
    const had = await fs.stat(abs).then((s) => s.isFile()).catch(() => false)
    if (had) {
      const bak = `${abs}.bak-${freeLocalStamp()}`
      await fs.copyFile(abs, bak).catch(() => {})
    }
    const tmp = `${abs}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    await fs.writeFile(tmp, body, 'utf8')
    await fs.rename(tmp, abs)
  } else {
    await fs.appendFile(abs, body, 'utf8')
  }
  const full = await fs.readFile(abs, 'utf8')
  return { ok: true, path: rel, sha256: sha256(full) }
}

/**
 * 删一份材料。
 *
 * materials/ 原本是「只追加」的，因为人一次次贴材料本来就该越攒越多。
 * 但从记忆里提取出来的东西往往是一次性的——试一下、看一眼、不对就删。
 * 不许删的话，用户连试都不敢试（按一下就在盘上留一份他爸的摘录）。
 * 所以这里开一个口子，范围卡死：只能删 materials/ 下面实在存在的文件。
 *
 * 不写墓碑，理由：墓碑是按内容 sha 认的，而「同一天对同一个人重新提取」
 * 出来的内容常常一模一样，写了墓碑反而会把刚重新提取的那份挡在界面外，
 * 表现出来就是「点了保存，但哪里都没有」。
 */
export async function deleteMaterial(root, rel) {
  const p = String(rel ?? '').trim()
  if (p === '') return { ok: false, error: '没说要删哪一份' }
  const norm = p.replace(/\\/g, '/')
  if (!norm.startsWith('materials/')) return { ok: false, error: '只能删材料夹里的东西' }
  if (norm.includes('..')) return { ok: false, error: '这个位置不对' }
  const at = await resolveIn(root, norm)
  if (!at.ok) return { ok: false, error: at.error }
  try {
    await fs.unlink(at.abs)
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: false, error: '这份材料已经不在了，刷新一下看看' }
    return { ok: false, error: '删不掉，可能是文件正被别的东西占着' }
  }
  return { ok: true, path: norm }
}

/**
 * 读所有材料（给提案的引文校验、分析输入用）。key 是相对路径。
 *
 * 先过墓碑。SPEC §9.1 要求所有读取路径都过滤，分析输入也算一条——
 * 材料被撤回后如果还能进提示词，「撤回」就只是界面上的障眼法。
 * 子目录也要读：listAll 会递归列出子目录里的材料，这里不递归的话
 * 「列表里看得到、分析时用不到」，两边对不上。
 */
export async function readMaterials(root) {
  const out = {}
  const redactions = await readRedactions(root)
  const walk = async (relDir) => {
    let entries
    try {
      entries = await fs.readdir(path.join(root, relDir), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const rel = path.posix.join(relDir.replace(/\\/g, '/'), entry.name)
      if (entry.isDirectory()) {
        await walk(rel)
        continue
      }
      if (!entry.isFile()) continue
      let text
      try {
        text = await fs.readFile(path.join(root, rel), 'utf8')
      } catch {
        // 读不了就跳过，不阻断其他材料
        continue
      }
      if (hitsRedaction(redactions, rel, text) !== undefined) continue
      out[rel] = text
    }
  }
  await walk('materials')
  return out
}

// ── 头像 ──────────────────────────────────────────────────────────

/** 头像存哪儿：`assets/<卡 id>.png`。用 id 不用名字，改名不会丢图。 */
export function avatarRelPath(cardId) {
  return path.posix.join('assets', `${core.safeId(cardId)}.png`)
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * 存一张头像。传进来的应当是已经裁好的 PNG base64。
 *
 * 校验三层，任何一层不过都不写盘：
 *   ① base64 解不开 → 传的东西本身不完整
 *   ② 不是 PNG 头  → 前端裁剪本该输出 PNG，不是的话说明链路错了
 *   ③ 超过 8MB     → 头像不该这么大，大概率是没裁的原图
 *
 * @returns {Promise<{ok: boolean, path?: string, bytes?: number, error?: string}>}
 */
export async function writeAvatar(root, cardId, base64, options = {}) {
  const capBytes = Number.isFinite(Number(options?.maxBytes)) && Number(options.maxBytes) > 0
    ? Number(options.maxBytes)
    : 8 * 1024 * 1024
  const id = String(cardId ?? '').trim()
  if (id === '') return { ok: false, error: '这张卡还没有编号，先存一次再来设头像' }
  let buf
  try {
    buf = Buffer.from(String(base64 ?? ''), 'base64')
  } catch {
    return { ok: false, error: '图片数据读不出来，请重新选一次' }
  }
  if (buf.length === 0) return { ok: false, error: '图片是空的，请重新选一次' }
  if (!buf.subarray(0, 8).equals(PNG_SIG)) return { ok: false, error: '只认 PNG 图片，请换一张或重新截一次' }
  if (buf.length > capBytes) return { ok: false, error: `图片有 ${(buf.length / 1048576).toFixed(1)}MB，太大了（上限 ${(capBytes / 1048576).toFixed(0)}MB）。头像不需要这么大，请重新截一次` }
  const rel = avatarRelPath(id)
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, buf)
  return { ok: true, path: rel, bytes: buf.length }
}

/** 读一张头像，返回 base64；没有就返回 null（界面回落成首字方块）。 */
export async function readAvatar(root, cardId) {
  const id = String(cardId ?? '').trim()
  if (id === '') return null
  try {
    const buf = await fs.readFile(path.join(root, avatarRelPath(id)))
    return buf.toString('base64')
  } catch {
    return null
  }
}

/** 删头像。删不存在的文件不算错——用户点了两次不该看到红字。 */
export async function removeAvatar(root, cardId) {
  const id = String(cardId ?? '').trim()
  if (id === '') return { ok: true }
  await fs.rm(path.join(root, avatarRelPath(id)), { force: true })
  return { ok: true }
}

// ── 提案 ──────────────────────────────────────────────────────────

/**
 * 给今天这份提案找一个还没被占用的文件名。
 *
 * 之前文件名固定是 `<人>-<日期>`，同一天对同一个人再点一次「分析」，
 * 上一轮的提案就被静默覆盖了 —— 连带「哪几条因为找不到原话被丢掉」
 * 的记录也一起没了。那不是「更新」，是丢数据。
 *
 * 现在第一次仍然用不带序号的名字（旧库、旧测试、脚本都不受影响），
 * 撞上了才依次试 `-2`、`-3`。
 *
 * 三个文件一起占名：`.md`（给人勾）、`.json`（给机器读）、
 * `.checked.json`（你在界面上勾了哪几条）。只要有一个在，就算这个名字被占了。
 *
 * @param {string} dir 提案目录的绝对路径
 * @param {string} safe 已经消毒过的人名 id
 * @param {string} date 本地日期 YYYY-MM-DD
 * @returns {Promise<string>} 可用的文件基名（不含扩展名）
 */
async function freeProposalBase(dir, safe, date) {
  const taken = async (base) => {
    for (const name of [`${base}.md`, `${base}.json`, `${base}.checked.json`]) {
      const hit = await fs.access(path.join(dir, name)).then(() => true).catch(() => false)
      if (hit) return true
    }
    return false
  }
  for (let n = 1; n < 1000; n += 1) {
    const base = n === 1 ? `${safe}-${date}` : `${safe}-${date}-${n}`
    if (!(await taken(base))) return base
  }
  // 同一天一千份，不是正常使用。退化成带毫秒的名字，
  // 宁可名字难看，也不能覆盖。
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')
  for (let n = 1; ; n += 1) {
    const base = `${safe}-${date}-${stamp}${n === 1 ? '' : `-${n}`}`
    if (!(await taken(base))) return base
  }
}

/**
 * 存一份提案：Markdown（给人勾选）+ JSON（给机器读）。
 *
 * 关键：写盘前先过引文校验门。找不到原文的条目直接丢弃，
 * 并记进 rejected —— 这是整个项目的防幻觉地线。
 */
export async function saveProposal(root, aboutId, proposal, materials) {
  const gate = core.verifyProposal(proposal, materials)
  const date = localDate()
  const safe = core.safeId(aboutId)
  const abs = (rel) => path.join(root, rel)
  await fs.mkdir(abs('proposals'), { recursive: true })

  // 不覆盖上一轮：同一天同一个人的第二份提案会叫 `<人>-<日期>-2`。
  const base = await freeProposalBase(abs('proposals'), safe, date)
  const mdRel = path.posix.join('proposals', `${base}.md`)
  const jsonRel = path.posix.join('proposals', `${base}.json`)

  const md = renderProposalMarkdown({ aboutId, date, gate, proposal })
  await fs.writeFile(abs(mdRel), md, 'utf8')
  // about 里连名字和身份一起存：这个人可能还没有卡（「说一大段话让它整理成卡」
  // 就是这种情况），采纳时要靠这几个字段现建一张，名字不能丢。
  const aboutMeta = proposal?.about !== null && typeof proposal?.about === 'object' ? proposal.about : {}
  const record = {
    spec: core.PROPOSAL_VERSION,
    about: {
      id: aboutId,
      ...(typeof aboutMeta.name === 'string' && aboutMeta.name.trim() !== '' ? { name: aboutMeta.name.trim() } : {}),
      ...(typeof aboutMeta.kind === 'string' && aboutMeta.kind !== '' ? { kind: aboutMeta.kind } : {}),
      ...(typeof aboutMeta.world === 'string' && aboutMeta.world !== '' ? { world: aboutMeta.world } : {}),
    },
    generated_at: new Date().toISOString(),
    material: Object.keys(materials ?? {}),
    accepted: gate.accepted,
    rejected: gate.rejected,
  }
  await fs.writeFile(abs(jsonRel), JSON.stringify(record, null, 2) + '\n', 'utf8')
  return { ok: true, md: mdRel, json: jsonRel, accepted: gate.accepted.length, rejected: gate.rejected.length, gate }
}

/** 渲染成勾选清单。**默认全部不勾**——勾选是人的动作。 */
export function renderProposalMarkdown({ aboutId, date, gate, proposal }) {
  const lines = []
  lines.push(`# 提案：${aboutId}（${date}）`)
  lines.push('')
  lines.push('> 这份文件是**建议**，不是卡。在下面勾上你要的（把 `[ ]` 改成 `[x]`），')
  lines.push('> 然后在插件里点「采纳勾选项」，它才会写进卡。')
  lines.push('>')
  lines.push('> 每条都带原文引文。引文在材料里找不到逐字对应的，已经在生成时被丢弃了。')
  lines.push('')
  if (gate.accepted.length === 0 && gate.rejected.length === 0) {
    lines.push('_这次分析没有产出任何可采纳的条目。_')
  }
  const byField = new Map()
  for (const item of gate.accepted) {
    const field = String(item.field ?? '其他')
    if (!byField.has(field)) byField.set(field, [])
    byField.get(field).push(item)
  }
  for (const [field, items] of byField) {
    lines.push(`## ${field}`)
    lines.push('')
    for (const item of items) {
      const label = describeValue(item)
      const ev = item.evidence ?? {}
      const where = ev.line_start !== undefined ? `L${ev.line_start}` : item.verified_line !== undefined ? `L${item.verified_line}` : ''
      lines.push(`- [ ] ${label}`)
      lines.push(`      证据：${ev.material ?? ''}${where === '' ? '' : ' ' + where}「${truncate(ev.quote, 80)}」`)
      if (item.source_level !== undefined) lines.push(`      来源：${item.source_level}`)
      if (item.note !== undefined) lines.push(`      说明：${item.note}`)
    }
    lines.push('')
  }
  if (Array.isArray(proposal?.gaps) && proposal.gaps.length > 0) {
    lines.push('## 还空着的')
    lines.push('')
    lines.push('这些不是提案，是「卡里缺、材料里也没说」的地方。')
    lines.push('')
    for (const gap of proposal.gaps) {
      lines.push(`- \`${gap.field}\` — ${gap.why ?? ''}`)
    }
    lines.push('')
  }
  if (Array.isArray(proposal?.questions) && proposal.questions.length > 0) {
    lines.push('## 建议去问')
    lines.push('')
    for (const q of proposal.questions) {
      lines.push(`- ${q.ask}${Array.isArray(q.fills) ? `（填 ${q.fills.join(', ')}）` : ''}`)
    }
    lines.push('')
  }
  if (gate.rejected.length > 0) {
    lines.push('## 已丢弃')
    lines.push('')
    lines.push('下面这些**没有通过引文校验**（材料里找不到逐字对应），所以没进清单。')
    lines.push('它们很可能是模型补出来的东西——这正是不让 AI 直接写卡的原因。')
    lines.push('')
    for (const r of gate.rejected) {
      const what = describeValue(r.item)
      lines.push(`- ~~${truncate(what, 60)}~~ — ${r.reason}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function describeValue(item) {
  const v = item?.value
  if (v === null || v === undefined) return String(item?.field ?? '（空）')
  if (typeof v === 'string') return v
  if (typeof v !== 'object') return String(v)
  const keys = Object.keys(v)
  if (keys.length === 0) return '（空）'
  // competency / evidence 这类对象给一个人话摘要
  const label = v.label ?? v.key ?? v.name
  const level = v.level
  if (label !== undefined && level !== undefined) return `${label} / ${level}`
  if (label !== undefined) return String(label)
  return keys.map((k) => `${k}: ${typeof v[k] === 'object' ? JSON.stringify(v[k]) : v[k]}`).join('；')
}

function truncate(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ')
  return t.length <= n ? t : t.slice(0, n) + '…'
}

/**
 * 勾选状态旁路存一份 `proposals/<name>.checked.json`。
 *
 * 为什么需要它：Markdown 那份是**给人看**的清单，界面上的勾选如果只存在
 * React state 里，就永远落不到盘上，`applyProposal` 读回 MD 会发现一条都没勾。
 * 所以界面勾选走这个旁路文件；MD 里的 `[x]` 只作为「手改文件」的兼容入口。
 *
 * 存的是 accepted 数组的下标，不是引文指纹——指纹依赖 describeValue 的
 * 措辞，改个标点就对不上，下标在同一份提案内是稳定的。
 */
function checkedRelOf(jsonRel) {
  return jsonRel.replace(/\.json$/, '.checked.json')
}

/** 读旁路勾选（下标数组）。文件不存在时返回 null，表示「没人从界面勾过」。 */
export async function readCheckedFile(root, jsonRel) {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(root, checkedRelOf(jsonRel)), 'utf8'))
    if (!Array.isArray(raw?.checked)) return null
    return raw.checked.filter((n) => Number.isInteger(n) && n >= 0)
  } catch {
    return null
  }
}

/** 写旁路勾选。传空数组等于「全不勾」，仍然写出文件以表达明确意图。 */
export async function writeCheckedFile(root, jsonRel, checked) {
  const list = Array.isArray(checked) ? checked : []
  const clean = [...new Set(list.filter((n) => Number.isInteger(n) && n >= 0))].sort((a, b) => a - b)
  const abs = path.join(root, checkedRelOf(jsonRel))
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, JSON.stringify({ checked: clean, updated_at: new Date().toISOString() }, null, 2) + '\n', 'utf8')
  return { ok: true, checked: clean }
}

/**
 * 已经采纳过的条目标记。
 *
 * 采纳一次之后，提案文件本身还留在提案夹里（用户可能想回看「当时为什么这么写」）。
 * 但界面上的「还等着你看的建议」如果继续把它算进去，一个已经处理完的东西
 * 会永远挂在待办里；更糟的是再点一次采纳，数组型字段（competency、taboos）
 * 会被重复 push，卡里长出两条一模一样的记录。
 * 所以采纳成功时把「这条已经写进去了」按指纹记下来，下次跳过。
 */
/**
 * 「这份建议我不要了」的旁路文件。
 *
 * 采纳过一部分也会用到它：剩下的那几条不再采纳，整份就该从首页待办里消失。
 * 记在旁路而不是删文件——删了的话，用户过几天想回头看「当时 AI 说了什么」
 * 就再也找不到了，而那条记录本身是有价值的。
 */
function dismissedRelOf(jsonRel) {
  return jsonRel.replace(/\.json$/, '.dismissed.json')
}

export async function readDismissed(root, jsonRel) {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(root, dismissedRelOf(jsonRel)), 'utf8'))
    return raw?.dismissed === true
  } catch {
    return false
  }
}

export async function writeDismissed(root, jsonRel, dismissed = true) {
  const abs = path.join(root, dismissedRelOf(jsonRel))
  if (dismissed !== true) {
    await fs.rm(abs, { force: true })
    return { ok: true, dismissed: false }
  }
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, JSON.stringify({ dismissed: true, at: new Date().toISOString() }, null, 2) + '\n', 'utf8')
  return { ok: true, dismissed: true }
}

function appliedRelOf(jsonRel) {
  return jsonRel.replace(/\.json$/, '.applied.json')
}

/** 一条条目的稳定指纹：改的是哪个字段、写成什么值。 */
function itemFingerprint(item) {
  return String(item?.field ?? '') + '\u0000' + JSON.stringify(item?.value ?? null)
}

/** 读已采纳指纹。文件不存在时返回空表。 */
export async function readAppliedFile(root, jsonRel) {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(root, appliedRelOf(jsonRel)), 'utf8'))
    return new Set(Array.isArray(raw?.applied) ? raw.applied.filter((x) => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

async function writeAppliedFile(root, jsonRel, fingerprints) {
  const abs = path.join(root, appliedRelOf(jsonRel))
  try {
    await fs.mkdir(path.dirname(abs), { recursive: true })
    const list = [...new Set(fingerprints)].sort()
    await fs.writeFile(abs, JSON.stringify({ applied: list, updated_at: new Date().toISOString() }, null, 2) + '\n', 'utf8')
    return { ok: true }
  } catch {
    // 标记写不进去不该让采纳失败——卡已经写成功了，丢的只是「别重复采纳」的备忘。
    return { ok: false }
  }
}

/** 读一份提案的 JSON，并解析对应 Markdown 里的勾选状态。 */
export async function readProposal(root, jsonRel) {
  const abs = (rel) => path.join(root, rel)
  let record
  try {
    record = JSON.parse(await fs.readFile(abs(jsonRel), 'utf8'))
  } catch {
    return { ok: false, error: '这份建议的文件读不了，可能被改坏了。' }
  }
  const mdRel = jsonRel.replace(/\.json$/, '.md')
  let md = ''
  try {
    md = await fs.readFile(abs(mdRel), 'utf8')
  } catch {
    // 没有 md 就当作全不勾
  }
  // 界面勾选存在旁路文件里，优先级高于手改 MD
  const sidecar = await readCheckedFile(root, jsonRel)
  // 用引文片段做匹配键：md 里的顺序与 accepted 一致
  const checked = new Set()
  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^-\s+\[([ xX])\]\s+(.*)$/.exec(lines[i].trim())
    if (m === null) continue
    if (m[1].toLowerCase() !== 'x') continue
    // 用「勾选行 + 下两行」拼成指纹
    checked.add(m[2].trim() + '\u0000' + (lines[i + 1] ?? '').trim())
  }
  const items = Array.isArray(record.accepted) ? record.accepted : []
  // 已经写进卡的条目：界面不再列出来，也不许再采纳一次。
  // 光靠「这份提案的已采纳记账」不够——同一份材料再整理一次会生成新提案，
  // 那份新文件的记账是空的，同一条内容就又能被点一次。
  const done = await readAppliedFile(root, jsonRel)
  const withChecked = items.map((item, index) => {
    const key = describeValue(item) + '\u0000' + `证据：${item.evidence?.material ?? ''}${item.evidence?.line_start !== undefined ? ' L' + item.evidence.line_start : item.verified_line !== undefined ? ' L' + item.verified_line : ''}「${truncate(item.evidence?.quote, 80)}」`
    // 只认精确指纹。曾经这里有一层「按描述前缀匹配」的宽松回退，
    // 结果只要有一条勾选行的描述是另一条的前缀，两条都会被判为已勾——
    // 没勾的条目被写进卡，等于绕过了「只读 [x]」这道闸门。
    const picked = sidecar === null ? checked.has(key) : sidecar.includes(index)
    return { ...item, index, checked: picked, adopted: done.has(itemFingerprint(item)) }
  })
  return {
    ok: true,
    mdRel,
    record,
    items: withChecked,
    checkedCount: withChecked.filter((i) => i.checked).length,
    // 还没被采纳、也不是「卡里已经有了」的条数。界面用它决定这一份要不要
    // 继续摆在待办里。
    openCount: withChecked.filter((i) => i.adopted !== true).length,
  }
}

/** 列出所有提案文件。 */
export async function listProposals(root) {
  const dir = path.join(root, 'proposals')
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    // `<名字>.checked.json` / `<名字>.applied.json` 是提案的旁路备忘，不是提案本身。
    // 以前只按 .json 结尾筛，于是这两份侧车会被当成「还等着你看的建议」列出来：
    // 点开 0 条，清也清不掉，待办计数还虚高。
    if (entry.name.endsWith('.checked.json') || entry.name.endsWith('.applied.json') || entry.name.endsWith('.dismissed.json')) continue
    const rel = path.posix.join('proposals', entry.name)
    // 用户点过「都不要」的就从待办里消失。文件留着，想看还能点进来。
    if (await readDismissed(root, rel)) continue
    try {
      const record = JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8'))
      const done = await readAppliedFile(root, rel)
      out.push({
        json: rel,
        about: record.about?.id ?? entry.name.replace(/\.json$/, ''),
        generated_at: record.generated_at,
        accepted: Array.isArray(record.accepted) ? record.accepted.length : 0,
        rejected: Array.isArray(record.rejected) ? record.rejected.length : 0,
        // 已经写进卡的条数：界面据此把「整份都采纳完了」的建议从待办里摘掉。
        adopted: (Array.isArray(record.accepted) ? record.accepted : [])
          .filter((i) => done.has(itemFingerprint(i))).length,
      })
    } catch {
      // 坏文件跳过
    }
  }
  return out.sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at)))
}

/**
 * 采纳提案里被勾选的条目，写进卡。
 *
 * 只读 `[x]`。没勾的不写。这是「AI 不能直接写卡」的落地。
 */
export async function applyProposal(root, jsonRel, options = {}) {
  // 界面直接传勾选下标时先落盘，保证「看到的」和「写进去的」是同一份
  if (Array.isArray(options.checked)) {
    await writeCheckedFile(root, jsonRel, options.checked)
  }
  const read = await readProposal(root, jsonRel)
  if (!read.ok) return read
  const aboutId = read.record?.about?.id
  if (typeof aboutId !== 'string' || aboutId === '') return { ok: false, error: '提案里没有 about.id' }
  // 「一条都没勾」要在建卡之前判掉。以前是先建卡再判，于是点了采纳却又
  // 什么都没勾时，工作区里会多出一张空卡，界面上只看到一句「还没有勾选任何一条」——
  // 用户根本不知道刚才那次点击留下了一张空壳。
  const chosenFirst = read.items.filter((i) => i.checked)
  if (chosenFirst.length === 0) return { ok: false, error: '还没有勾选任何一条。先点一下要留下的条目。' }
  let target = await findCardByRelOrId(root, aboutId)
  if (target === null) {
    // 卡还不存在——这正是「说一大段话，让它整理成一张卡」的正常情况。
    // 以前这里直接报「找不到这张卡」，于是那条路必须先手动建一张空卡才走得通。
    // 现在按提案里的 about 现建一张：kind 跟着提案走（虚构角色别建成真人）。
    const about = read.record?.about ?? {}
    const name = String(about.name ?? aboutId).trim() === '' ? aboutId : String(about.name).trim()
    const kind = ['real', 'fictional', 'hybrid', 'self'].includes(String(about.kind)) ? String(about.kind) : 'real'
    target = cardRelPath(aboutId, about.world)
    const made = await writeCard(root, target, {
      lifecard: core.DATA_VERSION,
      id: aboutId,
      kind,
      world: String(about.world ?? 'reality'),
      name,
    }, [])
    if (made.ok !== true) return { ok: false, error: made.error ?? '这张卡没能建起来，重试一次。' }
  }
  const card = await readCard(root, target)
  if (!card.ok) return card
  const chosen = chosenFirst

  // 写进卡之前，引文要对着**现在**的材料再验一遍。
  //
  // 这个闸门本来是保存提案时过的，但材料可以被删（用户明确要求「材料要能删」）。
  // 删掉材料之后再勾选旧提案，那些引用它的断言就成了「引文已经不在任何文件里」，
  // 照写就是凭空往卡里加没有出处的话——那正是这个工具最不该做的事。
  // 所以这里重验一次，对不上的跳过并在返回值里报数，让界面能说清「有几条因为
  // 原文没了没写进去」。
  const materials = await readMaterials(root)
  // 已经采纳过的条目不再写第二次：数组型字段（competency / taboos / tags）
  // 会因此长出重复条目，而用户看到的只是「我又点了一下采纳」。
  const doneBefore = await readAppliedFile(root, jsonRel)
  const stillThere = []
  const dropped = []
  const already = []
  for (const item of chosen) {
    const q = core.verifyQuote(item, materials)
    if (!q.ok) { dropped.push({ field: item?.field ?? '', reason: q.reason }); continue }
    if (doneBefore.has(itemFingerprint(item))) { already.push(item?.field ?? ''); continue }
    stillThere.push(item)
  }
  if (stillThere.length === 0) {
    // 全都是「之前已经采纳过」的：这不是失败。再点一次采纳应该什么都不发生，
    // 而不是弹一句「原文都已经不在材料里了」把人吓一跳。
    if (already.length > 0) {
      // handledIndexes 要说全：界面据此把这几条从清单上摘掉。
      // 不带的话，重开面板它们还在，用户会以为采纳从来没生效。
      return {
        ok: true,
        path: target,
        applied: 0,
        appliedLabels: [],
        handled: chosen.length,
        handledIndexes: chosen.map((i) => i.index).filter((n) => n !== undefined),
        duplicate: 0,
        skipped: 0,
        dropped: dropped.length,
        already: already.length,
      }
    }
    return {
      ok: false,
      error: '勾选的这些条目，原文都已经不在材料里了（可能材料被删过），所以一条都没写。',
      dropped,
    }
  }

  const data = { ...card.data }
  const sections = (card.sections ?? []).map((s) => ({ ...s }))
  const applied = []
  // 卡里本来就有、这次没再写的条目，以及它们在这份提案里的下标。
  const duplicates = []
  // 界面上要摘掉的条目：写进去的 + 卡里本来就有的。
  // 不返回这个，界面就只能自己猜——猜错的表现就是「采纳完了它还在那儿，
  // 再点一下又写一遍」，这正是用户报的那个 bug。
  const handledIndexes = []
  for (const item of stillThere) {
    const status = applyItem(data, sections, item)
    if (status === 'ok') {
      applied.push(describeValue(item))
      if (item.index !== undefined) handledIndexes.push(item.index)
    } else if (status === 'duplicate') {
      duplicates.push(item?.field ?? '')
      if (item.index !== undefined) handledIndexes.push(item.index)
    }
    // blocked：不记指纹、也不列进 handled，下次还能再试
  }
  // 一条新内容都没有（全是卡里本来就有的）就不写盘：没必要留一个空快照，
  // 也没必要让 mtime 跳一下。
  if (applied.length > 0) {
    const written = await writeCard(root, target, data, sections)
    if (!written.ok) return written
  }
  // 记账只记真的落进卡的，否则下次会重写一遍。
  const doneNow = stillThere.filter((i) => applied.includes(describeValue(i)) || duplicates.includes(i?.field ?? ''))
  await writeAppliedFile(root, jsonRel, [...doneBefore, ...doneNow.map(itemFingerprint)])
  return {
    ok: true,
    path: target,
    applied: applied.length,
    appliedLabels: applied,
    // 写进去了 plus 卡里本来就有 —— 两条对用户都是「这条不用管了」。
    handled: handledIndexes.length,
    handledIndexes,
    duplicate: duplicates.length,
    skipped: stillThere.length - applied.length - duplicates.length,
    // 原文已经不在的条目单独报：它们不是「没勾」，是「勾了但证据没了」。
    dropped: dropped.length,
    // 之前已经采纳过、这次跳过的条数。
    already: already.length,
  }
}

/** 比正文内容用：把所有空白压成一个空格，免得换行/缩进不同就判成新内容。 */
function normalizeText(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * 更狠一点的比较：只留字，标点符号和空白全部去掉。
 *
 * 同一段材料被同一个模型读两次，第二次常常只是多一个逗号、换个句号。
 * 只比原文的话这种差别就躲过了判重，卡里照样长出两段几乎一样的正文。
 * 长度不到 6 个字的不这么比——太短的话「他走了」能命中一大片。
 */
function bareText(s) {
  const t = String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '')
  return t.length >= 6 ? t : ''
}

/**
 * 把一条提案落到 data 或 sections 上。
 *
 * 保留字段不许提案改。`id` 是 SPEC §2 的全局唯一短标识，卡文件路径、
 * 关系端点、头像都靠它；`lifecard` 恒为 "0.1"。让提案写这两个字段，
 * 等于让一次勾选把卡从列表和路径上抹掉。
 */
function applyItem(data, sections, item) {
  const field = String(item?.field ?? '')
  const value = item?.value
  // 返回值有三种：ok = 这次真写进去了；duplicate = 卡里本来就有这一条；
  // blocked = 这条不许提案改。分开报是为了让界面说人话——
  // 「已经有的」和「写不进去的」是两件事，混在一起用户会以为卡坏了。
  if (field === '') return 'blocked'
  if (RESERVED_FIELDS.has(field)) return 'blocked'

  // 正文小节
  const sectionNames = ['自述', '性格', '场景', '开场白', '备选开场', '对话示例', '创作者备注', '关系史', '不会说的话', '不会做的事', '外貌', '口癖', '备注']
  if (sectionNames.includes(field)) {
    const text = typeof value === 'string' ? value.trim() : describeValue(item)
    if (text === '') return 'blocked'
    const found = sections.find((s) => s.title === field)
    if (found === undefined) {
      sections.push({ title: field, body: text })
      return 'ok'
    }
    const body = String(found.body ?? '')
    // 已经写过的小节不再写第二遍。
    // 以前这里是无条件追加，于是同一段关系史会被写成两段：
    // 用户采纳完一次，回头再整理一次材料（新提案、新文件，之前那份的
    // 「已采纳」记账对不上），或者手滑连点两下，卡里就长出重复段落。
    // 正文是给人读的，重复段落比字段里多一个 tag 明显得多——所以这里按
    // 内容判重，而不是只靠「这一份提案的哪几条采纳过」。
    const bareBody = bareText(body)
    const bareNew = bareText(text)
    if (normalizeText(body).includes(normalizeText(text))) return 'duplicate'
    if (bareNew !== '' && bareBody.includes(bareNew)) return 'duplicate'
    found.body = body.trim() === '' ? text : `${body.trim()}\n${text}`
    return 'ok'
  }

  // 数组型字段：追加
  if (['competency', 'taboos', 'tags'].includes(field)) {
    const list = Array.isArray(data[field]) ? [...data[field]] : []
    if (field === 'tags') {
      // 模型给 tags 有时是一个字符串、有时是字符串数组。数组要一条条摊平，
      // 不能走 describeValue——那会拼成「0: 正常」这种带下标的串写进卡里。
      const vals = Array.isArray(value)
        ? value.map((v) => (typeof v === 'string' ? v : describeValue({ value: v })))
        : [typeof value === 'string' ? value : describeValue(item)]
      let added = false
      for (const v of vals) {
        const t = String(v).trim()
        if (t === '' || list.includes(t)) continue
        list.push(t)
        added = true
      }
      data[field] = list
      return added ? 'ok' : 'duplicate'
    }
    // competency / taboos：一次给一组也要能收，但已经在卡里的那一行不再加。
    const incoming = Array.isArray(value) ? value : [value]
    let added = false
    for (const v of incoming) {
      if (v === null || v === undefined) continue
      const row = typeof v === 'object' ? v : { label: String(v) }
      if (list.some((x) => JSON.stringify(x) === JSON.stringify(row))) continue
      list.push(row)
      added = true
    }
    data[field] = list
    return added ? 'ok' : 'duplicate'
  }

  // 普通字段
  if (JSON.stringify(data[field] ?? null) === JSON.stringify(value ?? null)) return 'duplicate'
  data[field] = value
  return 'ok'
}

/** 按 id 或相对路径找卡。 */
export async function findCardByRelOrId(root, relOrId) {
  if (relOrId.endsWith('.card.md')) {
    // 路径来自外部时可能带 ../ 或绝对路径，先确认它没跑出工作区
    const at = await resolveIn(root, relOrId)
    if (!at.ok) return null
    try {
      await fs.access(at.abs)
      return relOrId
    } catch {
      return null
    }
  }
  const all = await listAll(root)
  const hit = all.cards.find((c) => c.id === relOrId || c.name === relOrId)
  return hit === undefined ? null : hit.path
}

// ── 健康检查 ──────────────────────────────────────────────────────

/**
 * doctor：数据体检。
 *
 * 分成两段（见 SPEC §10）：数据段在任意环境跑；宿主段由一个自检写
 * `.lifecard/diagnostics.json`，这里读到就并进来，读不到就明写「未运行」。
 * 绝不假装探测过宿主能力。
 */
export async function doctor(root) {
  const all = await listAll(root)
  const config = await readConfig(root)
  const materials = await readMaterials(root)

  const issues = []
  for (const card of all.cards) {
    for (const issue of card.issues) {
      issues.push({ path: card.path, level: issue.level, field: issue.field, message: issue.message })
    }
  }
  // 悬空 world 引用
  const worldIds = new Set(all.worlds.map((w) => String(w.id ?? '')))
  worldIds.add('reality')
  for (const card of all.cards) {
    if (card.world !== undefined && card.world !== 'reality' && !worldIds.has(String(card.world))) {
      issues.push({ path: card.path, level: 'warn', field: 'world', message: '这张卡写的那个世界已经找不到了，去「世界」里重新选一个。' })
    }
  }
  // 悬空关系端点
  const ids = new Set(all.cards.map((c) => String(c.id)))
  for (const rel of all.relations) {
    if (!ids.has(rel.from)) issues.push({ path: rel.path, level: 'warn', field: 'from', message: `关系边的 from "${rel.from}" 指向不存在的卡` })
    if (!ids.has(rel.to)) issues.push({ path: rel.path, level: 'warn', field: 'to', message: `关系边的 to "${rel.to}" 指向不存在的卡` })
  }

  // 宿主段
  let hostSegment = { ran: false, note: '宿主段未运行（这是 CLI 段的结果）' }
  try {
    const diag = JSON.parse(await fs.readFile(path.join(root, '.lifecard/diagnostics.json'), 'utf8'))
    hostSegment = { ran: true, ...diag }
  } catch {
    // 没跑过，如实说
  }

  const summary = {
    ok: issues.every((i) => i.level !== 'error'),
    root,
    config,
    counts: {
      cards: all.cards.length,
      worlds: all.worlds.length,
      systems: all.systems.length,
      relations: all.relations.length,
      materials: all.materials.length,
      redactions: all.redactions.length,
    },
    issues,
    errors: all.errors,
    cards: all.cards.map((c) => ({ id: c.id, name: c.name, kind: c.kind, world: c.world, coverage: c.coverage, tags: c.tags })),
    unmarked: averageUnmarked(all),
    host: hostSegment,
    materials: Object.keys(materials),
  }
  return summary
}

/**
 * 全库「未标记来源比例」的平均值（SPEC §10 数据段要求）。
 *
 * listAll 已经逐卡算过 coverage.unmarkedRatio，这里只做平均。
 * 一张卡都没有时返回 null——「没数据」和「0%」不是一回事。
 * @param {{ cards?: Array<{ unmarkedRatio?: number }> }} all
 * @returns {number|null}
 */
function averageUnmarked(all) {
  const ratios = (all?.cards ?? [])
    .map((c) => c?.unmarkedRatio)
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (ratios.length === 0) return null
  return ratios.reduce((sum, v) => sum + v, 0) / ratios.length
}

export default {
  SKELETON,
  defaultConfig,
  openWorkspace,
  readConfig,
  writeConfig,
  readConcept,
  writeConcept,
  writeDraft,
  readDraft,
  removeDraft,
  listDrafts,
  rememberMemoryPeople,
  memoryStatusOf,
  readRedactions,
  appendRedaction,
  sha256,
  cardRelPath,
  readCard,
  writeCard,
  listAll,
  appendMaterial,
  deleteMaterial,
  readMaterials,
  readAppliedFile,
  readDismissed,
  writeDismissed,
  avatarRelPath,
  writeAvatar,
  readAvatar,
  removeAvatar,
  saveProposal,
  renderProposalMarkdown,
  readProposal,
  readCheckedFile,
  writeCheckedFile,
  listProposals,
  applyProposal,
  findCardByRelOrId,
  doctor,
}
