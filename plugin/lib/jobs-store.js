/**
 * LifeCard jobs/store —— 求职那几张表怎么落到磁盘上。
 *
 * 全部是纯文本：
 *   jobs/evaluations/<日期>-<公司>-<岗位>.md   一次评估的报告
 *   jobs/applications.md                       投递追踪表
 *   jobs/story-bank.md                         面试用的故事银行
 *   jobs/resumes/<日期>-<公司>.md              定制简历草稿
 *   jobs/covers/<日期>-<公司>.md               求职信草稿
 *
 * 为什么坚持 Markdown 而不是 JSON：这些东西用户要能自己打开改、能 git diff、
 * 能直接复制粘贴到招聘网站。做成 JSON 就锁在软件里了，软件一坏全没了。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

/** 投递状态。封闭枚举——自由字符串会让追踪表三个月后没法统计。 */
export const STATUSES = ['evaluated', 'applied', 'responded', 'interview', 'offer', 'rejected', 'discarded', 'skip']

/** 状态的中文说法。界面只说中文，不出现 applied 这种词。 */
export const STATUS_LABEL = {
  evaluated: '看过了',
  applied: '投了',
  responded: '有回音',
  interview: '面试中',
  offer: '拿到 offer',
  rejected: '被拒了',
  discarded: '自己不去了',
  skip: '不投',
}

const APPLICATIONS = 'jobs/applications.md'
const STORY_BANK = 'jobs/story-bank.md'

/**
 * 文件名的安全化。中文要留着（用户看得懂），只去掉路径分隔符和奇怪字符。
 */
export function safeName(raw, fallback = 'x') {
  const s = String(raw ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\n\r\t]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60)
  return s === '' ? fallback : s
}

function localDate(now = new Date()) {
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 10)
}

/** 落一个文件，自动建目录。路径必须落在工作区里。 */
async function writeInside(root, rel, body) {
  const base = path.resolve(root)
  const abs = path.resolve(base, rel)
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    return { ok: false, error: '路径在工作区外面，拒绝访问' }
  }
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body, 'utf8')
  return { ok: true, path: rel }
}

async function readInside(root, rel) {
  const got = await readInsideState(root, rel)
  return got.ok === true ? got.body : null
}

/**
 * 读一个文件，并说清楚「没有这个文件」和「有这个文件但读不出来」。
 *
 * 以前两种都返回 null。上面那几张表是整表重写的：读失败被当成空表，
 * 用户攒了三个月的投递记录就被一行新记录顶掉了；存评估报告时也一样，
 * 读不出来就当这个文件名空着，直接盖掉原来那份。
 *
 * @returns {Promise<{ok: true, exists: boolean, body: string|null} | {ok: false, error: string}>}
 */
async function readInsideState(root, rel) {
  const base = path.resolve(root)
  const abs = path.resolve(base, rel)
  if (abs !== base && !abs.startsWith(base + path.sep)) return { ok: false, error: '路径在工作区外面，拒绝访问' }
  try {
    return { ok: true, exists: true, body: await fs.readFile(abs, 'utf8') }
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, exists: false, body: null }
    return { ok: false, error: `这个文件读不出来（${rel}）。可能是权限、磁盘，或者文件正被别的软件占着。` }
  }
}

/**
 * 存一次评估。同名不覆盖——同一天看同一个岗位两次是很正常的
 * （改完简历再看一遍），第二次要能看见第一次的结论。
 *
 * @returns {Promise<{ok: boolean, path?: string, error?: string}>}
 */
export async function saveEvaluation(root, result, meta = {}) {
  const date = localDate()
  const company = safeName(result?.company, '没写公司')
  const role = safeName(result?.role, '没写岗位')
  const dir = 'jobs/evaluations'

  let rel = ''
  for (let n = 1; n <= 999; n += 1) {
    const suffix = n === 1 ? '' : `-${n}`
    const candidate = path.posix.join(dir, `${date}-${company}-${role}${suffix}.md`)
    // 判空位要判「在不在」，不是「读不读得出来」：读不出来多半说明它在，
    // 换个名字；真是别的错就直说，别拿它当空位把原来那份盖掉。
    const probe = await readInsideState(root, candidate)
    if (probe.ok !== true) return probe
    if (probe.exists !== true) { rel = candidate; break }
  }
  // 一天看过一千个同名岗位是不可能的，真撞上就用时间戳
  if (rel === '') rel = path.posix.join(dir, `${date}-${company}-${role}-${Date.now()}.md`)

  const body = typeof meta.markdown === 'string' ? meta.markdown : ''
  const saved = await writeInside(root, rel, body)
  if (!saved.ok) return saved
  return { ok: true, path: rel }
}

/**
 * 列所有评估。按文件名倒序（日期在最前面，所以等于按时间倒序）。
 */
export async function listEvaluations(root) {
  const dir = 'jobs/evaluations'
  const base = path.resolve(root)
  const abs = path.resolve(base, dir)
  if (!abs.startsWith(base)) return { ok: true, items: [] }
  let names = []
  // 读不出来（权限、磁盘、目录被换成文件）不等于「一条都没有」：以前一律
  // 返回空数组，界面就显示「你还没有…」，用户以为东西丢了。
  try { names = await fs.readdir(abs) } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, items: [] }
    return { ok: false, error: '这个文件夹读不出来。可能是权限、磁盘，或者它被挪走了。' }
  }
  const items = []
  for (const name of names.filter((n) => n.endsWith('.md')).sort().reverse()) {
    const rel = path.posix.join(dir, name)
    const stat = await fs.stat(path.join(root, rel)).catch(() => null)
    // 文件名是 `<日期>-<公司>-<岗位>[-序号].md`，拆回来给界面用
    const stem = name.replace(/\.md$/, '')
    const m = /^(\d{4}-\d{2}-\d{2})-(.+)$/.exec(stem)
    const rest = m === null ? stem : m[2]
    const parts = rest.split('-')
    items.push({
      path: rel,
      date: m === null ? '' : m[1],
      company: parts[0] ?? '',
      role: parts.slice(1).join('-') || '',
      bytes: stat === null ? 0 : stat.size,
      when: stat === null ? '' : stat.mtime.toISOString(),
    })
  }
  return { ok: true, items }
}

/** 读一份评估报告。 */
export async function readEvaluation(root, rel) {
  if (!String(rel ?? '').startsWith('jobs/evaluations/')) {
    return { ok: false, error: '这不是一份评估报告。' }
  }
  const body = await readInside(root, rel)
  if (body === null) return { ok: false, error: '找不到这份报告。' }
  return { ok: true, path: rel, markdown: body }
}

/**
 * 存一份简历或求职信草稿。`kind` 是 'resume' 或 'cover'。
 */
export async function saveDraft(root, kind, company, body) {
  const dir = kind === 'cover' ? 'jobs/covers' : 'jobs/resumes'
  const date = localDate()
  const name = safeName(company, '没写公司')
  let rel = ''
  for (let n = 1; n <= 999; n += 1) {
    const suffix = n === 1 ? '' : `-${n}`
    const candidate = path.posix.join(dir, `${date}-${name}${suffix}.md`)
    const probe = await readInsideState(root, candidate)
    if (probe.ok !== true) return probe
    if (probe.exists !== true) { rel = candidate; break }
  }
  if (rel === '') rel = path.posix.join(dir, `${date}-${name}-${Date.now()}.md`)
  return writeInside(root, rel, body)
}

export async function listDrafts(root, kind) {
  const dir = kind === 'cover' ? 'jobs/covers' : 'jobs/resumes'
  const base = path.resolve(root)
  const abs = path.resolve(base, dir)
  if (!abs.startsWith(base)) return { ok: true, items: [] }
  let names = []
  // 读不出来（权限、磁盘、目录被换成文件）不等于「一条都没有」：以前一律
  // 返回空数组，界面就显示「你还没有…」，用户以为东西丢了。
  try { names = await fs.readdir(abs) } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, items: [] }
    return { ok: false, error: '这个文件夹读不出来。可能是权限、磁盘，或者它被挪走了。' }
  }
  const items = []
  for (const name of names.filter((n) => n.endsWith('.md')).sort().reverse()) {
    const rel = path.posix.join(dir, name)
    const stat = await fs.stat(path.join(root, rel)).catch(() => null)
    items.push({ path: rel, name: name.replace(/\.md$/, ''), bytes: stat === null ? 0 : stat.size, when: stat === null ? '' : stat.mtime.toISOString() })
  }
  return { ok: true, items }
}

export async function readDraft(root, rel) {
  if (!String(rel ?? '').startsWith('jobs/resumes/') && !String(rel ?? '').startsWith('jobs/covers/')) {
    return { ok: false, error: '这不是一份草稿。' }
  }
  const body = await readInside(root, rel)
  if (body === null) return { ok: false, error: '找不到这份草稿。' }
  return { ok: true, path: rel, markdown: body }
}

// ── 投递追踪表 ──────────────────────────────────────────────────────

const TRACKER_HEADER = [
  '# 投递记录',
  '',
  '> 这张表只记事实：什么时候、投了哪家、后来怎样。',
  '> 它不会替你投任何东西——投递永远是你自己动手。',
  '',
  '| 日期 | 公司 | 岗位 | 状态 | 备注 |',
  '| --- | --- | --- | --- | --- |',
].join('\n')

/**
 * 读追踪表。空表（或文件不存在）返回空数组 + 表头准备好写。
 *
 * 用 Markdown 表格而不是 JSON：用户要能自己在编辑器里加一行。
 */
export async function readTracker(root) {
  const got = await readInsideState(root, APPLICATIONS)
  if (got.ok !== true) return got
  const body = got.body
  if (got.exists !== true) return { ok: true, rows: [], exists: false, layout: [] }
  const rows = []
  // 除了表里的行，文件里还可能有用户自己写的东西：一段备注、一个空行、
  // 一条不在格式里的记录。写回时要把它们原样放回去——整表重渲染会把
  // 它们悄悄删掉，而文档里明写着「这张表你能自己在文件夹里打开改」。
  const layout = []
  for (const line of body.replace(/\n$/, '').split('\n')) {
    const t = line.trim()
    const isTable = t.startsWith('|') && t.endsWith('|')
    // 按「没被转义的竖线」切，再把 \| 还原成 |：不然公司名里带一个竖线，
    // 后面每一列都会错位挤进备注里。
    const cells = isTable
      ? t.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
      : []
    // 表头与分隔行属于「原样保留」，不算数据行
    const isHeader = isTable && (cells[0] === '日期' || /^-+$/.test(cells[0] ?? ''))
    if (!isTable || isHeader || cells.length < 4) {
      layout.push({ kind: 'raw', line })
      continue
    }
    layout.push({ kind: 'row' })
    rows.push({
      date: cells[0] ?? '',
      company: cells[1] ?? '',
      role: cells[2] ?? '',
      status: cells[3] ?? '',
      note: cells.slice(4).join(' ') ?? '',
    })
  }
  return { ok: true, rows, exists: true, layout }
}

/**
 * 一格表格文字。竖线会把这一行切成多列，换行会把一行变成两行——公司名和
 * 岗位是模型从招聘说明里抄的，里面什么都有。所以竖线转义、换行压成空格。
 */
function cell(raw) {
  return String(raw ?? '').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')
}

function trackerRowLine(r) {
  return `| ${cell(r.date)} | ${cell(r.company)} | ${cell(r.role)} | ${cell(r.status)} | ${cell(r.note)} |`
}

/**
 * 把行写回去，同时保住用户自己加的东西。
 *
 * 表格行的位置按 layout 原位替换；行数变多时多出来的接在末尾；
 * 非表格行（标题、说明、手写备注）一字不动。新文件就从头铺一份表头。
 */
function renderTracker(rows, layout = []) {
  if (layout.length === 0) {
    const lines = TRACKER_HEADER.replace(/\n$/, '').split('\n')
    return [...lines, ...rows.map(trackerRowLine)].join('\n') + '\n'
  }
  const out = []
  let i = 0
  for (const item of layout) {
    if (item.kind !== 'row') { out.push(item.line); continue }
    if (i >= rows.length) continue
    out.push(trackerRowLine(rows[i]))
    i += 1
  }
  while (i < rows.length) { out.push(trackerRowLine(rows[i])); i += 1 }
  return out.join('\n') + '\n'
}

/**
 * 加一行投递记录。
 *
 * `status` 走封闭枚举。用户想写「等消息」这种自由文本，就写进备注，
 * 状态本身必须是一个能统计的值——三个月后回头看「投了 20 家几家有回音」
 * 才有答案。
 */
export async function addApplication(root, row) {
  const status = String(row?.status ?? 'applied')
  if (!STATUSES.includes(status)) {
    return { ok: false, error: `「${status}」不是一个能记的状态。` }
  }
  const current = await readTracker(root)
  // 读不出来就别写：这一写是整表重写，等于用一行顶掉用户记过的所有投递。
  if (current.ok !== true) return current
  const rows = [...current.rows, {
    date: String(row?.date ?? '').trim() === '' ? localDate() : String(row.date).trim(),
    company: String(row?.company ?? '').trim(),
    role: String(row?.role ?? '').trim(),
    status,
    note: String(row?.note ?? '').trim(),
  }]
  if (rows[rows.length - 1].company === '') return { ok: false, error: '至少写一下是哪家公司。' }
  const saved = await writeInside(root, APPLICATIONS, renderTracker(rows, current.layout ?? []))
  if (!saved.ok) return saved
  return { ok: true, count: rows.length }
}

/**
 * 改一行。按「公司 + 岗位」找，不按下标——
 * 用户手改过文件之后下标就对不上了，而公司名是稳定的。
 */
export async function updateApplication(root, target, patch) {
  const current = await readTracker(root)
  if (current.ok !== true) return current
  const company = String(target?.company ?? '').trim()
  const role = String(target?.role ?? '').trim()
  const at = current.rows.findIndex((r) => r.company === company && (role === '' || r.role === role))
  if (at < 0) return { ok: false, error: '没找到这条记录。' }
  const next = { ...current.rows[at] }
  if (patch?.status !== undefined) {
    const status = String(patch.status)
    if (!STATUSES.includes(status)) return { ok: false, error: `「${status}」不是一个能记的状态。` }
    next.status = status
  }
  if (patch?.note !== undefined) next.note = String(patch.note)
  if (patch?.date !== undefined) next.date = String(patch.date)
  const rows = [...current.rows]
  rows[at] = next
  const saved = await writeInside(root, APPLICATIONS, renderTracker(rows, current.layout ?? []))
  if (!saved.ok) return saved
  return { ok: true, row: next }
}

// ── 故事银行 ────────────────────────────────────────────────────────

const STORY_HEADER = [
  '# 面试故事',
  '',
  '> 面试官问「讲一次你解决难题的经历」，临时想是来不及的。',
  '> 平时把真事写下来，面试前翻一遍就够。',
  '',
  '> 每一条都从你自己的材料里来，不编。',
  '',
].join('\n')

/**
 * 读故事银行。每条是 `### 标题` 开头的一段。
 *
 * 没有要求用户按 STAR 填——那是给人看的框架，不是必须的格式。
 * 只要求三件事：什么情况、你做了什么、结果怎样。
 */
export async function readStories(root) {
  const body = await readInside(root, STORY_BANK)
  if (body === null) return { ok: true, stories: [], exists: false }
  const stories = []
  const chunks = body.split(/^### /m).slice(1)
  for (const chunk of chunks) {
    const lines = chunk.split('\n')
    const title = (lines[0] ?? '').trim()
    if (title === '') continue
    stories.push({ title, body: lines.slice(1).join('\n').trim() })
  }
  return { ok: true, stories, exists: true }
}

export async function addStory(root, story) {
  const title = String(story?.title ?? '').trim()
  if (title === '') return { ok: false, error: '给这段经历起个名字。' }
  const body = String(story?.body ?? '').trim()
  if (body === '') return { ok: false, error: '写一下发生了什么、你做了什么。' }
  const current = await readInside(root, STORY_BANK)
  const head = current === null ? STORY_HEADER : current.replace(/\s*$/, '\n\n')
  const saved = await writeInside(root, STORY_BANK, `${head}### ${title}\n\n${body}\n`)
  if (!saved.ok) return saved
  return { ok: true }
}

// ── 求职设置（在自己那张卡上）──────────────────────────────────────

/**
 * 读自己的求职设置。存在 `self` 卡的 `job:` 字段上——
 * 「我想找什么样的工作」是关于我自己的事实，属于这张卡。
 *
 * 全空的字段不返回，让界面能用 `??` 判断「填过没有」。
 */
export async function readJobProfile(store, root) {
  const list = await store.listAll(root)
  const self = (list.cards ?? []).find((c) => c.kind === 'self')
  if (self === undefined) return { ok: true, found: false, profile: null }
  const card = await store.readCard(root, self.path)
  if (card.ok !== true) return { ok: true, found: false, profile: null }
  const job = card.data?.job
  if (job === null || typeof job !== 'object') return { ok: true, found: true, profile: null }
  return { ok: true, found: true, profile: job, path: self.path }
}

// ── 模拟面试 ─────────────────────────────────────────────────

const INTERVIEW_DIR = 'jobs/interviews'

/**
 * 存一场模拟面试。
 *
 * 一场一次覆盖（同名同 id），不是每答一题写一个新文件——
 * 面试是一段对话，中途离开再回来应该回到同一场，而不是看见
 * 八个只答了一题的残稿。文件名里的 id 由调用方给。
 */
export async function saveInterview(root, session) {
  const id = safeName(session?.id, '')
  if (id === '') return { ok: false, error: '这场面试没有编号，存不了。' }
  const rel = path.posix.join(INTERVIEW_DIR, `${id}.json`)
  const saved = await writeInside(root, rel, JSON.stringify(session, null, 2))
  if (!saved.ok) return saved
  // 顺带留一份能读的 Markdown：用户可能想拿它复习，或者发给朋友看
  const mdRel = path.posix.join(INTERVIEW_DIR, `${id}.md`)
  if (typeof session?.markdown === 'string' && session.markdown !== '') {
    await writeInside(root, mdRel, session.markdown)
  }
  return { ok: true, path: rel, markdown: session.markdown === undefined ? null : mdRel }
}

export async function readInterview(root, id) {
  const safe = safeName(id, '')
  if (safe === '') return { ok: false, error: '没有给出是哪一场。' }
  const body = await readInside(root, path.posix.join(INTERVIEW_DIR, `${safe}.json`))
  if (body === null) return { ok: false, error: '找不到这场面试。' }
  try {
    return { ok: true, session: JSON.parse(body) }
  } catch {
    return { ok: false, error: '这场面试的文件坏了，读不出来。' }
  }
}

/**
 * 列以前练过的场次。新的在前。
 *
 * 只在真的练过之后才有东西——第一次点进来这里是空的，
 * 界面不该把空列表画成一块空白的框。
 */
export async function listInterviews(root) {
  const base = path.resolve(root)
  const abs = path.resolve(base, INTERVIEW_DIR)
  if (abs !== base && !abs.startsWith(base + path.sep)) return { ok: true, items: [] }
  let names = []
  // 读不出来（权限、磁盘、目录被换成文件）不等于「一条都没有」：以前一律
  // 返回空数组，界面就显示「你还没有…」，用户以为东西丢了。
  try { names = await fs.readdir(abs) } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, items: [] }
    return { ok: false, error: '这个文件夹读不出来。可能是权限、磁盘，或者它被挪走了。' }
  }
  const items = []
  for (const name of names.filter((n) => n.endsWith('.json')).sort().reverse()) {
    const rel = path.posix.join(INTERVIEW_DIR, name)
    let session = null
    try { session = JSON.parse(await fs.readFile(path.join(root, rel), 'utf8')) } catch { session = null }
    if (session === null) continue
    items.push({
      id: String(session.id ?? name.replace(/\.json$/, '')),
      company: String(session.company ?? ''),
      role: String(session.role ?? ''),
      started_at: String(session.started_at ?? ''),
      turns: Array.isArray(session.turns) ? session.turns.length : 0,
      answered: Array.isArray(session.turns)
        ? session.turns.filter((t) => String(t.answer ?? '').trim() !== '').length
        : 0,
      done: session.ended_at !== undefined,
    })
  }
  return { ok: true, items }
}

/**
 * 写求职设置。只覆盖传进来的键，不整块替换——
 * 用户在界面上只改了薪资，不该把「不能接受的事」清空。
 */
export async function writeJobProfile(store, root, patch) {
  const list = await store.listAll(root)
  const self = (list.cards ?? []).find((c) => c.kind === 'self')
  if (self === undefined) {
    return { ok: false, error: '还没有「我自己」这张卡。先在侧栏建一张，求职设置会存到它上面。' }
  }
  const card = await store.readCard(root, self.path)
  if (card.ok !== true) return { ok: false, error: '读不到「我自己」这张卡。' }
  const data = { ...card.data }
  const before = data.job === null || typeof data.job !== 'object' ? {} : data.job
  const next = { ...before }
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0)) {
      delete next[k]
    } else {
      next[k] = v
    }
  }
  if (Object.keys(next).length === 0) delete data.job
  else data.job = next
  const written = await store.writeCard(root, self.path, data, card.sections ?? [])
  if (written.ok !== true) return written
  return { ok: true, profile: Object.keys(next).length === 0 ? null : next }
}
