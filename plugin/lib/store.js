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
function localDate(now = new Date()) {
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

/** 读工作区配置；没有就给默认值（不写盘）。 */
export async function readConfig(root) {
  try {
    const text = await fs.readFile(path.join(root, CONFIG_NAME), 'utf8')
    const json = JSON.parse(text)
    return { ...defaultConfig(), ...json }
  } catch {
    return defaultConfig()
  }
}

/** 写配置。 */
export async function writeConfig(root, patch) {
  const current = await readConfig(root)
  const next = { ...current, ...patch }
  await fs.writeFile(path.join(root, CONFIG_NAME), JSON.stringify(next, null, 2) + '\n', 'utf8')
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
function resolveIn(root, rel) {
  const base = path.resolve(root)
  const abs = path.resolve(base, String(rel ?? ''))
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    return { ok: false, error: '路径在工作区外面，拒绝访问' }
  }
  return { ok: true, abs }
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
  const at = resolveIn(root, relPath)
  if (!at.ok) return { ok: false, path: relPath, error: at.error }
  const abs = at.abs
  let text
  try {
    text = await fs.readFile(abs, 'utf8')
  } catch {
    return { ok: false, path: relPath, error: '文件不存在' }
  }
  const redactions = await readRedactions(root)
  const hit = hitsRedaction(redactions, relPath, text)
  if (hit !== undefined) {
    return { ok: false, path: relPath, error: `这条记录已被撤回（${hit.reason ?? '未说明原因'}），不再显示` }
  }
  const parsed = core.parseCard(text)
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
  const at = resolveIn(root, relPath)
  if (!at.ok) return { ok: false, path: relPath, error: at.error }
  const abs = at.abs
  await fs.mkdir(path.dirname(abs), { recursive: true })
  // 快照：旧内容存全文（快照是审计依据，不能只存 diff）
  try {
    const old = await fs.readFile(abs, 'utf8')
    const snapDir = path.join(root, '.lifecard/snapshots', relPath.replace(/[\\/]/g, '__'))
    await fs.mkdir(snapDir, { recursive: true })
    await fs.writeFile(path.join(snapDir, `${await freeStamp(snapDir, new Date())}.md`), old, 'utf8')
  } catch {
    // 首次写入，没有旧内容
  }
  const text = core.stringifyCard(data, sections)
  await fs.writeFile(abs, text, 'utf8')
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
 */
export async function appendMaterial(root, name, content) {
  const safe = core.safeId(name).replace(/\.md$/i, '')
  const date = localDate()
  const fileName = safe.startsWith(date) ? `${safe}.md` : `${date}-${safe}.md`
  const rel = path.posix.join('materials', fileName)
  const at = resolveIn(root, rel)
  if (!at.ok) return { ok: false, error: at.error }
  const abs = at.abs
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.appendFile(abs, (content.endsWith('\n') ? content : content + '\n'), 'utf8')
  const full = await fs.readFile(abs, 'utf8')
  return { ok: true, path: rel, sha256: sha256(full) }
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
export async function writeAvatar(root, cardId, base64) {
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
  if (buf.length > 8 * 1024 * 1024) return { ok: false, error: `图片有 ${(buf.length / 1048576).toFixed(1)}MB，太大了。头像不需要这么大，请重新截一次` }
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
  const record = {
    spec: core.PROPOSAL_VERSION,
    about: { id: aboutId },
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
  const withChecked = items.map((item, index) => {
    const key = describeValue(item) + '\u0000' + `证据：${item.evidence?.material ?? ''}${item.evidence?.line_start !== undefined ? ' L' + item.evidence.line_start : item.verified_line !== undefined ? ' L' + item.verified_line : ''}「${truncate(item.evidence?.quote, 80)}」`
    // 只认精确指纹。曾经这里有一层「按描述前缀匹配」的宽松回退，
    // 结果只要有一条勾选行的描述是另一条的前缀，两条都会被判为已勾——
    // 没勾的条目被写进卡，等于绕过了「只读 [x]」这道闸门。
    const picked = sidecar === null ? checked.has(key) : sidecar.includes(index)
    return { ...item, index, checked: picked }
  })
  return { ok: true, mdRel, record, items: withChecked, checkedCount: withChecked.filter((i) => i.checked).length }
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
    const rel = path.posix.join('proposals', entry.name)
    try {
      const record = JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8'))
      out.push({
        json: rel,
        about: record.about?.id ?? entry.name.replace(/\.json$/, ''),
        generated_at: record.generated_at,
        accepted: Array.isArray(record.accepted) ? record.accepted.length : 0,
        rejected: Array.isArray(record.rejected) ? record.rejected.length : 0,
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
  const target = await findCardByRelOrId(root, aboutId)
  if (target === null) return { ok: false, error: `找不到 ${aboutId} 这张卡` }
  const card = await readCard(root, target)
  if (!card.ok) return card
  const chosen = read.items.filter((i) => i.checked)
  if (chosen.length === 0) return { ok: false, error: '还没有勾选任何一条。先点一下要留下的条目。' }

  const data = { ...card.data }
  const sections = (card.sections ?? []).map((s) => ({ ...s }))
  const applied = []
  for (const item of chosen) {
    const ok = applyItem(data, sections, item)
    if (ok) applied.push(describeValue(item))
  }
  const written = await writeCard(root, target, data, sections)
  if (!written.ok) return written
  return { ok: true, path: target, applied: applied.length, appliedLabels: applied, skipped: chosen.length - applied.length }
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
  if (field === '') return false
  if (RESERVED_FIELDS.has(field)) return false

  // 正文小节
  const sectionNames = ['自述', '性格', '场景', '开场白', '备选开场', '对话示例', '创作者备注', '关系史', '不会说的话', '不会做的事', '外貌', '口癖', '备注']
  if (sectionNames.includes(field)) {
    const text = typeof value === 'string' ? value : describeValue(item)
    const found = sections.find((s) => s.title === field)
    if (found === undefined) sections.push({ title: field, body: text })
    else found.body = found.body.trim() === '' ? text : `${found.body.trim()}\n${text}`
    return true
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
      return added
    }
    if (Array.isArray(value)) {
      // 同理：competency/taboos 一次给一组也要能收
      let added = false
      for (const v of value) {
        if (v === null || v === undefined) continue
        const row = typeof v === 'object' && v !== null ? v : { label: String(v) }
        list.push(row)
        added = true
      }
      data[field] = list
      return added
    }
    list.push(typeof value === 'object' && value !== null ? value : { label: String(value ?? describeValue(item)) })
    data[field] = list
    return true
  }

  // 普通字段
  data[field] = value
  return true
}

/** 按 id 或相对路径找卡。 */
export async function findCardByRelOrId(root, relOrId) {
  if (relOrId.endsWith('.card.md')) {
    // 路径来自外部时可能带 ../ 或绝对路径，先确认它没跑出工作区
    const at = resolveIn(root, relOrId)
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
      issues.push({ path: card.path, level: 'warn', field: 'world', message: `world "${card.world}" 不存在（worlds/ 下没有这个 id）` })
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
  readRedactions,
  appendRedaction,
  sha256,
  cardRelPath,
  readCard,
  writeCard,
  listAll,
  appendMaterial,
  readMaterials,
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
