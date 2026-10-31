/**
 * diary —— 一天一篇，AI 带着写。
 *
 * 为什么单独一层：日记不是「人物卡」，也不是「简历」。卡记的是一个人是谁，
 * 简历记的是他会什么；日记记的是**这一天他身上发生了什么、他当时怎么想、
 * 后来做了什么决定**。三样东西会互相喂：日记写厚了，「我」那张卡就该更准；
 * 卡写准了，下一回它劝你的话才不像一个陌生人。
 *
 * 落盘形状（用户拿访达就能看、能改、能带走）：
 * ```
 * <用户自己指定的文件夹>/
 *   2026-10-31.md
 *   2026-11-01.md
 * ```
 * 一篇一个文件，文件名就是日期。不按月份分文件夹：一年三百多个文件，
 * 摊平比套三层目录好找，也方便用户自己丢进任何同步盘。
 *
 * 这一层只碰磁盘与文字：不调模型、不碰 HTTP。路由在 index.js，界面在 client.js。
 *
 * ## 写盘为什么这么啰嗦
 *
 * 日记是用户唯一会亲手改的文件。他会在访达里打开、加一行自己的话、
 * 改个标题、把某一节删掉。所以这一层写之前必须：先读旧内容、读不出来就
 * 一个字都不写、写之前留个底、用户自己加的 frontmatter 键和小节原样带着走、
 * 空掉的小节不再凭空长回来、分数宽容地认（小数、全角、负号都算）。
 * 这些保护写在 writeDiary 里而不是写在工具里，是因为 HTTP 路由 `diary.save`
 * 也直接调它——保护写在上一层，下一层的口子就还是敞着的。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import * as core from './core.js'
import { localDate } from './store.js'

/** frontmatter 里的 kind。用来分清这个文件是日记还是别的什么。 */
const DIARY_KIND = 'lifecard-diary'

/** 一篇日记的正文小节。这个顺序就是写进文件的顺序。 */
export const DIARY_SECTIONS = [
  '今天最值得讲的一件事',
  '当时在想什么',
  '情绪往下三层',
  '我做了什么决定',
  '下一步',
]

/** 一行一条的小节。其余小节是一段自由文字。 */
export const DIARY_LIST_SECTIONS = ['下一步']

/** 四维打分：人生设计里那四个格子。0 分表示这个维度今天没碰。 */
export const DIMENSIONS = ['健康', '工作', '关系', '玩']

/** 日期形状。日记文件名只认这个，别的名字一律不看。 */
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})\.md$/

/** 打分那一段的标题。它不算正文小节，单独排。 */
const SCORE_SECTION = '今天这四样'

/** frontmatter 里我们自己会写的键。其余键是用户加的，得原样带着走。 */
const HEAD_OWN_KEYS = new Set(['lifecard', 'kind', 'date', 'mood'])

/** 覆盖前留底的地方，在用户那个日记文件夹里的一层隐藏目录。 */
const SNAPSHOT_DIR = '.lifecard'
const SNAPSHOT_SUB = '旧版本'

// ── 路径 ─────────────────────────────────────────────────────────

/**
 * 这一天的文件名。日期必须真的是个日子，`2026-13-45` 这种不接受——
 * 不然会在用户文件夹里造出一个永远读不回来的文件。
 */
export function dateFileName(date) {
  const raw = String(date ?? '').trim()
  const m = DATE_RE.exec(`${raw}.md`)
  if (m === null) return ''
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const ok = d.getFullYear() === Number(m[1]) && d.getMonth() + 1 === Number(m[2]) && d.getDate() === Number(m[3])
  return ok ? `${raw}.md` : ''
}

/** 今天该写的那一篇的路径。 */
export function diaryFileName(today = localDate()) {
  return dateFileName(today) === '' ? '' : `${today}.md`
}

/**
 * 这个文件名算不算某一天的日记——放宽一档。
 *
 * 严格只认 `2026-10-30.md` 的问题是：用户在访达里把它改名成
 * 「2026-10-30 周五.md」或者后缀变成 `.MD`，从此这一天就"不存在"了——
 * 界面说今天还没写，再存一次还会新建一个同日期文件，两篇分叉。
 * 日记是用户自己的文件，他有一个起名字的权利。
 *
 * 所以放宽到：日期对得上，后面跟不跟东西都行。但日期本身必须真是那一天，
 * `2026-13-45` 这种照样不认；后缀必须是 `.md`（不区分大小写）。
 *
 * @returns {string} 认得出就回 `YYYY-MM-DD`，认不出回空串。
 */
function looseDateOf(name) {
  const raw = String(name ?? '')
  if (!/\.md$/i.test(raw)) return ''
  const stem = raw.slice(0, -3)
  const m = /^(\d{4}-\d{2}-\d{2})(?:[\s_\-–—].*)?$/.exec(stem)
  if (m === null) return ''
  return dateFileName(m[1]) === '' ? '' : m[1]
}

/**
 * 这一天的日记到底是哪个文件。
 *
 * 先找标准名字；没有再在这个文件夹里找「日期对得上、后面被加了别的话」的
 * 那份（用户自己改过名）。找到就接着用它写，不另建一个同日期文件把一篇
 * 日记劈成两半。
 */
async function findDiaryFile(dir, date) {
  const exact = dateFileName(date)
  if (exact === '') return { ok: false, error: '日子不对，日记只认 年-月-日 这种写法。' }
  const absExact = path.join(dir, exact)
  const got = await readRaw(absExact)
  if (got.kind !== 'none') return { ok: true, name: exact, abs: absExact, raw: got, loose: false }
  let names
  try {
    names = await fs.readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, name: exact, abs: absExact, raw: got, loose: false }
    return { ok: false, error: '那个日记文件夹读不出来。检查一下权限。' }
  }
  const hits = names.filter((n) => looseDateOf(n) === date).sort()
  if (hits.length === 0) return { ok: true, name: exact, abs: absExact, raw: got, loose: false }
  const name = hits[0]
  const abs = path.join(dir, name)
  return { ok: true, name, abs, raw: await readRaw(abs), loose: true }
}

/**
 * 日记放进哪里：用户自己指定的那个文件夹。
 *
 * 没指定就返回空串，让调用方去问，而不是偷偷写进工作区——
 * 用户原话是「日记不用存插件」，那就一个字节都不该落在插件目录里。
 */
export function diaryRootFrom(config) {
  const raw = typeof config?.diary_dir === 'string' ? config.diary_dir.trim() : ''
  if (raw === '') return ''
  const home = process.env.HOME ?? ''
  if (raw === '~') return home
  if (raw.startsWith('~/')) return path.join(home, raw.slice(2))
  // 相对路径不能按「进程现在站在哪儿」算：那个位置是插件自己的安装目录，
  // 用户输入「我的日记」会在插件包里造一个文件夹，他永远找不到。
  // 相对路径一律按「他的家目录」算，这是他说那句话时唯一会想到的地方。
  if (!path.isAbsolute(raw)) return path.join(home, raw)
  return path.normalize(raw)
}

// ── 写 / 读 ──────────────────────────────────────────────────────

/**
 * 一篇日记写成 Markdown。
 *
 * 空的小节**不写标题**：用户把某一节整段删掉，是「这一节我不想写」，
 * 不是「请你下次再替我补回来」。全空就只剩 frontmatter。
 *
 * 第二个参数用来把「不属于五节、但文件里本来就有」的东西原样带回去：
 * `headExtras`（用户自己加的 frontmatter 键）、`extraSections`（用户加的小节）、
 * `intro`（第一个标题之前那段话）、`scoreLines`（认不出来的打分行）。
 */
export function renderDiaryMarkdown(data, options = {}) {
  const d = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}
  const date = dateFileName(d.date) === '' ? localDate() : String(d.date)
  const mood = String(d.mood ?? '').trim()
  const scores = d.scores !== null && typeof d.scores === 'object' && !Array.isArray(d.scores) ? d.scores : {}
  const head = {
    lifecard: core.DATA_VERSION,
    kind: DIARY_KIND,
    date,
  }
  const extras = options?.headExtras !== null && typeof options?.headExtras === 'object' ? options.headExtras : {}
  for (const key of Object.keys(extras)) {
    const value = extras[key]
    if (String(key).trim() === '' || HEAD_OWN_KEYS.has(key)) continue
    if (value === undefined || value === null) continue
    head[key] = value
  }
  if (mood !== '') head.mood = mood

  const blocks = []
  const intro = String(options?.intro ?? '').trim()
  if (intro !== '') blocks.push(intro)
  for (const title of DIARY_SECTIONS) {
    const value = d[title]
    const body = DIARY_LIST_SECTIONS.includes(title) ? renderList(value) : String(value ?? '').trim()
    if (body === '') continue
    blocks.push(`## ${title}\n\n${body}`)
  }
  // 打分单独放一段，写成「健康 6」这种最省事的形状：用户手改也方便。
  const scoreLines = DIMENSIONS.filter((name) => Number.isFinite(Number(scores[name])) && String(scores[name]).trim() !== '')
    .map((name) => `- ${name} ${trimScore(scores[name])}`)
  const keptScoreLines = Array.isArray(options?.scoreLines)
    ? options.scoreLines.map((line) => String(line ?? '').trim()).filter((line) => line !== '')
    : []
  const allScoreLines = [...scoreLines, ...keptScoreLines]
  if (allScoreLines.length > 0) blocks.push(`## ${SCORE_SECTION}\n\n${allScoreLines.join('\n')}`)
  for (const one of Array.isArray(options?.extraSections) ? options.extraSections : []) {
    const title = String(one?.title ?? '').trim()
    const body = String(one?.body ?? '').trim()
    if (title === '' || body === '') continue
    blocks.push(`## ${title}\n\n${body}`)
  }
  return `---\n${core.stringifyYaml(head)}\n---\n\n${blocks.join('\n\n')}\n`
}

/** 分数写成整数就不带小数点，写成 6.5 就照写。 */
function trimScore(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '0'
  const clamped = Math.max(0, Math.min(10, n))
  return Number.isInteger(clamped) ? String(clamped) : String(Math.round(clamped * 10) / 10)
}

/**
 * 反过来：把一篇日记读成 `{data, sections}`。读不成给人话。
 *
 * 除了五个标准小节，还会把「文件里本来就有、但不是我们写的」那些东西
 * 一并交回去（`headExtras` / `extraSections` / `intro` / `scoreLines`），
 * 这样写回的时候能原样带着走，不会悄悄抹掉用户自己加的话。
 */
export function parseDiaryText(text) {
  const parsed = core.parseCard(String(text ?? ''))
  if (parsed.ok !== true) return { ok: false, error: '这一篇日记读不出来，格式不对。' }
  const head = parsed.data ?? {}
  const kind = String(head.kind ?? '').trim()
  if (kind !== '' && kind !== DIARY_KIND) return { ok: false, error: '这个文件不是日记，是别的文件。' }
  const grouped = regroupSections(parsed.sections)
  const bodyOf = (title) => String(grouped.byTitle.get(title) ?? '').trim()
  const data = { date: String(head.date ?? '').trim() }
  const mood = String(head.mood ?? '').trim()
  if (mood !== '') data.mood = mood
  const headExtras = {}
  for (const key of Object.keys(head)) {
    if (HEAD_OWN_KEYS.has(key)) continue
    headExtras[key] = head[key]
  }
  const scores = {}
  const scoreLines = []
  for (const title of DIARY_SECTIONS) {
    const body = bodyOf(title)
    data[title] = DIARY_LIST_SECTIONS.includes(title) ? parseList(body) : body
  }
  for (const line of parseList(bodyOf(SCORE_SECTION))) {
    const got = parseScoreLine(line)
    if (got === null || !DIMENSIONS.includes(got.name)) {
      // 认不出来的打分行原样留着：宁可多一行，不要静默吃掉用户写的东西。
      scoreLines.push(line)
      continue
    }
    scores[got.name] = got.value
  }
  data.scores = scores
  return {
    ok: true,
    data,
    sections: parsed.sections,
    headExtras,
    // 用户自己写的小标题现在留在正文里，不再单拎成「额外小节」——
    // 拎出去等于把它从原本待着的那一段里挖走，写回去就多一份。
    extraSections: [],
    scoreLines,
    intro: grouped.intro,
  }
}

/**
 * 把切出来的小节重新归位：**只有我们自己那六个标题算分节线**。
 *
 * 用户在自己那一节里手写一行 `## 医院里的事` 是很自然的事（那本来就是
 * 一段小标题）。以前 `splitSections` 见到任何 `^## ` 都另起一节，于是
 * 那一行连同它下面的话被搬出正文、摆到文件末尾——模型再读就只看得到
 * 第一行，改一次多出一份，文件越写越长。
 *
 * 这里改口径：认得的标题才分节，不认得的标题原样留在它所在那一节的正文里，
 * 一个字都不搬。这样「读进来 → 写回去」是恒等的，模型也看得到全段。
 */
function regroupSections(sections) {
  const known = new Set([...DIARY_SECTIONS, SCORE_SECTION])
  const intro = []
  const blocks = []
  let cur = null
  const startBlock = (title, lines) => {
    cur = { title, lines: Array.isArray(lines) ? lines.slice() : [] }
    blocks.push(cur)
  }
  const push = (lines) => {
    if (cur === null) intro.push(...lines)
    else cur.lines.push(...lines)
  }
  // 一行 `## xxx`：认得的标题才另起一节。
  const headingOf = (line) => {
    const m = /^##\s+(.+?)\s*$/.exec(String(line ?? ''))
    if (m === null) return ''
    const title = m[1].trim()
    return known.has(title) ? title : ''
  }
  const bodyLines = (text) => (String(text ?? '') === '' ? [] : String(text).split('\n'))
  let seenKnown = false

  // 一行一行地过，而不是一节一节地过：
  //
  // `parseCard` 出来的小节是按「行首 `## `」切的，可它有两种场合会切错——
  // 一是用户手打了一个没闭合的 ``` 围栏，后面所有 `## ` 都被当成代码吞进
  // 上一节；二是用户自己写的一行 `## 医院里的事` 也被切成了一节。
  // 前者要把被吞掉的节认回来，后者要把它留在正文里。所以这里重新过一遍
  // 每一节的正文行：认得的标题一律另起一节，不认得的原样留在原地。
  const feed = (lines) => {
    for (const line of lines) {
      const title = headingOf(line)
      if (title !== '') {
        seenKnown = true
        startBlock(title, [])
        continue
      }
      if (cur !== null) cur.lines.push(line)
      else intro.push(line)
    }
  }

  for (const one of Array.isArray(sections) ? sections : []) {
    const title = String(one?.title ?? '').trim()
    const lines = bodyLines(one?.body)
    if (title === '' || title === '_intro') {
      feed(lines)
      continue
    }
    if (known.has(title)) {
      seenKnown = true
      startBlock(title, [])
      feed(lines)
      continue
    }
    // 不认得的标题：用户自己写的小标题。原样并回当前这一节。
    //
    // 但一个认得的标题都还没出现时，它更可能是被围栏带出来的真小节
    // （见上面），这时候单独算一节，否则后面几节整片消失。
    if (!seenKnown) {
      startBlock(title, [])
      feed(lines)
      continue
    }
    if (cur !== null && cur.lines.some((line) => line.trim() !== '')) push([''])
    push([`## ${title}`])
    feed(lines)
  }

  const byTitle = new Map()
  for (const block of blocks) {
    const text = block.lines.join('\n').replace(/^\n+|\n+$/g, '')
    if (text === '') continue
    // 同名小节（早上写一段、晚上又起一个同名标题）并成一段，不丢后一份。
    byTitle.set(block.title, byTitle.has(block.title) ? `${byTitle.get(block.title)}\n\n${text}` : text)
  }
  return { intro: intro.join('\n').replace(/^\n+|\n+$/g, ''), byTitle }
}

/** 一行打分：`健康 6`、`健康：6.5`、全角数字、负号，都认。 */
function parseScoreLine(line) {
  const raw = String(line ?? '')
    .trim()
    .replace(/[０-９]/g, (c) => String(c.charCodeAt(0) - 0xff10))
    .replace(/[－—–]/g, '-')
  const m = /^(.+?)[\s:：=＝]+(-?\d+(?:\.\d+)?)\s*$/.exec(raw)
  if (m === null) return null
  const value = Number(m[2])
  if (!Number.isFinite(value)) return null
  return { name: m[1].trim(), value: Math.max(0, Math.min(10, Math.round(value * 10) / 10)) }
}

/** 一行一条的小节：读的时候去掉记号、还原转义。与 career.js 同一套约定。 */
function parseList(body) {
  const out = []
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    let line = raw.trim()
    if (line === '') continue
    // `# 紧急` 这种用户手写的记号：以前整行被丢掉（「我写的怎么没了」）。
    // 现在只剥掉记号本身，文字留下——一行一条的小节里，那也是他的一条。
    line = line.replace(/^#{1,6}\s+/, '').trim()
    line = line.replace(/^\s*(?:[-*+]|\d+\s*[.、)．])\s*/, '').trim()
    if (line !== '') out.push(unescapeItem(line))
  }
  return out
}

/** 写的时候：一条一行。内容里的换行记成 `\n` 两个字，读回再还原。 */
function renderList(value) {
  const items = Array.isArray(value)
    ? value.map((v) => String(v ?? '').trim()).filter((v) => v !== '')
    : String(value ?? '').split(/\r?\n/).map((s) => s.replace(/^\s*(?:[-*+]|\d+\s*[.、)．])\s*/, '').trim()).filter((s) => s !== '')
  return items
    .map((item) => item.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n'))
    .map((item) => `- ${item}`)
    .join('\n')
}

/**
 * 还原 renderList 的转义。
 *
 * 必须逐字符走一遍：先 `\\` 后 `\n` 直接两次 replace 会把 `\\\\n` 解错，
 * 而写一次翻一倍的反斜杠正是这么来的。
 */
function unescapeItem(text) {
  const raw = String(text ?? '')
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = raw[i + 1]
    if (next === '\\') {
      out += '\\'
      i += 1
    } else if (next === 'n') {
      out += '\n'
      i += 1
    } else {
      out += ch
    }
  }
  return out
}

/** 同一篇日记的写操作排队走：两次点击、两个窗口，不会后写的把先写的整篇盖掉。 */
const locks = new Map()

function withLock(key, run) {
  const prev = locks.get(key) ?? Promise.resolve()
  const next = prev.then(run, run)
  const tail = next.then(() => {}, () => {})
  locks.set(key, tail)
  tail.then(() => {
    // 队列排空了就把这一格删掉，不然写过多少天就攒多少个 Promise。
    if (locks.get(key) === tail) locks.delete(key)
  })
  return next
}

/**
 * 读这一天的日记。没有是正常状态（今天还没写），不报错。
 *
 * @param {string} dir 用户指定的日记文件夹
 * @param {string} date YYYY-MM-DD
 */
export async function readDiary(dir, date) {
  const name = dateFileName(date)
  if (name === '') return { ok: false, error: '日子不对，日记只认 年-月-日 这种写法。' }
  if (String(dir ?? '').trim() === '') return { ok: true, data: null, missing: true }
  const found = await findDiaryFile(dir, date)
  if (found.ok !== true) return found
  const name2 = found.name
  const got = found.raw
  if (got.kind === 'none') return { ok: true, data: null, missing: true, path: name }
  if (got.kind === 'link') return { ok: false, error: '这一天不是一篇日记，是个快捷方式。为了不读到别处去，这次不读了。' }
  if (got.kind === 'error') return { ok: false, error: got.error }
  const parsed = parseDiaryText(got.text)
  if (parsed.ok !== true) return parsed
  // 手上这份「认不出来的部分」（自加的 frontmatter 键、自己加的小节、
  // 认不出的打分行、开头那段）一路带出去：写回去的时候要原样带着走。
  return {
    ok: true,
    path: name2,
    text: got.text,
    data: parsed.data,
    sections: parsed.sections,
    headExtras: parsed.headExtras,
    extraSections: parsed.extraSections,
    scoreLines: parsed.scoreLines,
    intro: parsed.intro,
  }
}

/** 把一个文件原样读回来，顺便把「没有 / 读不出来 / 是个快捷方式」分清楚。 */
async function readRaw(abs) {
  let st
  try {
    st = await fs.lstat(abs)
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'none' }
    return { kind: 'error', error: '这一篇日记读不出来。检查一下那个文件夹的权限。' }
  }
  if (st.isSymbolicLink()) return { kind: 'link' }
  if (!st.isFile()) return { kind: 'error', error: '这一天不是一篇日记，是个文件夹。' }
  try {
    const text = await fs.readFile(abs, 'utf8')
    return { kind: 'text', text, mode: st.mode & 0o777 }
  } catch {
    return { kind: 'error', error: '这一篇日记读不出来。检查一下那个文件夹的权限。' }
  }
}

/**
 * 写这一天的日记。
 *
 * 先写临时文件再改名：改名是一次替换，掉电或写满时要么还是旧的完整版、
 * 要么已经是新的完整版，不会留下半篇。
 *
 * 写之前的六道关（全都下沉在这一层，HTTP 路由绕不过去）：
 * 1. 旧文件读不出来 → 一个字都不写。
 * 2. 调用方读过旧内容就传 `expect: { text }`；对不上说明外面改过 → 不写。
 * 3. 能读到旧内容 → 先留个底（`.lifecard/旧版本/<日期>/`）。
 * 4. 用户自己加的 frontmatter 键、自己加的小节、第一个标题前那段话，原样带着走。
 * 5. 没提到的节沿用旧值（`merge: false` 才允许真的清空，那要用户点过头）。
 * 6. 权限跟原来一样（新文件 600）；同一篇的写操作排队走。
 *
 * @param {string} dir 用户指定的日记文件夹
 * @param {object} data 要写的内容（五节 + scores/mood 任意子集）
 * @param {Date} now
 * @param {{expect?: {text?: string, mtimeMs?: number}, merge?: boolean}} options
 */
export async function writeDiary(dir, data, now = new Date(), options = {}) {
  const input = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}
  const date = dateFileName(input.date) === '' ? localDate(now) : String(input.date)
  const name = dateFileName(date)
  if (name === '') return { ok: false, error: '日子不对，日记只认 年-月-日 这种写法。' }
  if (String(dir ?? '').trim() === '') return { ok: false, error: '还没定日记放在哪个文件夹。' }
  const abs = path.join(dir, name)
  // 锁要按「这一天」锁，不能按这里猜出来的标准名：用户可能已经把这一天
  // 改名成「2026-10-30 周五.md」了，那写进去的也是那个文件。
  const found = await findDiaryFile(dir, date)
  if (found.ok !== true) return found
  return withLock(found.abs, async () => {
    const abs = found.abs
    const old = await readRaw(abs)
    if (old.kind === 'error') return { ok: false, error: `为了不覆盖掉原来那一篇，这次没存：${old.error}` }
    if (old.kind === 'link') return { ok: false, error: '这一天是个快捷方式，不往里写。' }

    const merged = { ...input, date }
    let renderOptions = {}
    let snapshot = ''
    const existed = old.kind === 'text'
    if (existed) {
      const expect = options?.expect
      const wantText = expect !== null && typeof expect === 'object' ? expect.text : undefined
      if (typeof wantText === 'string' && wantText !== old.text) {
        return {
          ok: false,
          conflict: true,
          error: '这一天在别的地方又改过了。为了不把你外面改的东西盖掉，这次没存——重新打开这一篇再写一遍就行。',
        }
      }
      const back = parseDiaryText(old.text)
      if (back.ok !== true) {
        return { ok: false, error: `这一天原来那一篇读不出来（${back.error}），为了不覆盖掉它，这次没存。` }
      }
      renderOptions = {
        headExtras: back.headExtras,
        extraSections: back.extraSections,
        scoreLines: back.scoreLines,
        intro: back.intro,
      }
      if (options?.merge !== false) {
        for (const title of DIARY_SECTIONS) {
          const value = merged[title]
          const empty = Array.isArray(value) ? value.length === 0 : String(value ?? '').trim() === ''
          if (empty) merged[title] = back.data[title]
        }
        const hasScores = merged.scores !== null && typeof merged.scores === 'object' && Object.keys(merged.scores ?? {}).length > 0
        if (!hasScores) merged.scores = back.data.scores
        if (String(merged.mood ?? '').trim() === '') merged.mood = back.data.mood ?? ''
      }
      snapshot = await saveSnapshot(dir, date, old.text)
      if (snapshot === '') {
        return { ok: false, error: '这一篇原来的内容没能留个底，为了安全这次先不存。' }
      }
    }

    const text = renderDiaryMarkdown(merged, renderOptions)
    const tmp = `${abs}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    try {
      // 只有「这一天还没写过」才建文件夹。已有那一篇在的时候不建：
      // 用户可能刚把整个日记文件夹改名挪走了，这时候重建一个空壳出来，
      // 会把他的日记分成互不相见的两处。
      if (!existed) await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 })
      await fs.rename(tmp, abs)
      // 老文件原来是 600 就还是 600；原来是别的（用户自己改过）也照旧。
      if (existed && Number.isInteger(old.mode) && old.mode !== 0o600) await fs.chmod(abs, old.mode).catch(() => {})
    } catch {
      await fs.rm(tmp, { force: true }).catch(() => {})
      return { ok: false, error: '这一篇没能存下来。检查一下磁盘是不是满了。' }
    }
    return {
      ok: true,
      path: path.basename(abs),
      chars: text.length,
      text,
      data: { ...merged, date },
      mode: existed ? 'updated' : 'created',
      snapshot,
    }
  })
}

/** 覆盖之前把旧的整篇留个底。留不下来就返回空串，调用方据此拒绝写入。 */
async function saveSnapshot(dir, date, text) {
  const day = dateFileName(date)
  if (day === '') return ''
  const folder = path.join(dir, SNAPSHOT_DIR, SNAPSHOT_SUB, day.slice(0, -3))
  const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}`
  const abs = path.join(folder, `${stamp}.md`)
  try {
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(abs, String(text ?? ''), { encoding: 'utf8', mode: 0o600 })
    return abs
  } catch {
    return ''
  }
}

/**
 * 这一篇有多少字。
 *
 * 不能用 `st.size`：那是字节数，一个汉字占三个字节，界面上会显示成三倍。
 * 读不出来就退回字节数——数字不准好过没有。
 */
async function countChars(abs, size) {
  try {
    const text = await fs.readFile(abs, 'utf8')
    return text.length
  } catch {
    return Number.isFinite(Number(size)) ? Number(size) : 0
  }
}

/**
 * 列出写过哪些天（新的在前）。
 *
 * 只认 `YYYY-MM-DD.md`，别的文件一概不看：用户会把这个文件夹拿去同步、
 * 放别的笔记、放图片，多认一个就是多一份「看起来像日记其实不是」的东西。
 * 快捷方式也不算——它指向的地方可能根本不在这个文件夹里。
 *
 * `total` 是实际有多少天，`diaries` 只按 `limit` 切一刀：
 * 「写过多少天」不该被列表长度顶死。
 */
export async function listDiaries(dir, options = {}) {
  if (String(dir ?? '').trim() === '') return { ok: true, diaries: [], total: 0, missing: true }
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : 400
  let names
  try {
    names = await fs.readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, diaries: [], total: 0, missing: true }
    return { ok: false, error: '那个日记文件夹读不出来。检查一下权限。' }
  }
  const diaries = []
  for (const name of names) {
    // 放宽一档：用户在访达里把「2026-10-30.md」改成「2026-10-30 周五.md」、
    // 或者后缀变成 .MD，那不是「这一天没写」，是他给这一天起了个名字。
    // 严格只认标准名的结果是这些日记整篇看不见，再存一次还会另建一个文件。
    const date = looseDateOf(name)
    if (date === '') continue
    const abs = path.join(dir, name)
    let st
    try {
      st = await fs.lstat(abs)
    } catch {
      continue
    }
    if (st.isSymbolicLink() || !st.isFile()) continue
    diaries.push({ date, file: name, chars: await countChars(abs, st.size), mtime: st.mtime.toISOString() })
  }
  diaries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  return { ok: true, diaries: diaries.slice(0, limit), total: diaries.length }
}

// ── 让模型干活的那几段话 ────────────────────────────────────────

/**
 * 上次写到哪儿：给模型一句「接得上」的话，而不是每天从零开始。
 *
 * 第二个参数两种形状都收：一张「日期 → 正文」的表，或者一组
 * `{date, data}`（路由那边读回来的样子）。收错形状时它会把内容悄悄
 * 丢成「这一篇是空的」——模型于是每天从零开始问，人会觉得它不记事。
 */
export function recentBlock(diaries, texts) {
  const list = Array.isArray(diaries) ? diaries : []
  const picked = list.slice(0, 3)
  if (picked.length === 0) return '（还没写过日记，这是第一篇。）'
  const rows = Array.isArray(texts) ? texts : null
  const map = rows === null && texts !== null && typeof texts === 'object' ? texts : {}
  const bodyOf = (date) => {
    if (rows !== null) {
      const hit = rows.find((one) => String(one?.date ?? '') === date)
      if (hit === undefined) return ''
      const data = hit.data
      return data !== null && typeof data === 'object'
        ? diaryBlock(data, { intro: hit.intro, extraSections: hit.extraSections })
        : String(data ?? '').trim()
    }
    const value = map[date]
    return value !== null && typeof value === 'object' ? diaryBlock(value) : String(value ?? '').trim()
  }
  return picked
    .map((one) => {
      const date = String(one?.date ?? one).trim()
      const body = bodyOf(date)
      if (body === '') return `【${date}】（这一篇是空的）`
      return `【${date}】\n${body}`
    })
    .join('\n\n')
}

/**
 * 日记助手说的第一段话。
 *
 * 定了三件事：它是什么（不是心理咨询、不是打卡）、它怎么问（一次只问一件事、
 * 不许一次抛五个问题）、它什么时候收（用户说够了就收，不追着写满）。
 */
export function buildDiarySystem({ cardName, persona, memory, preset, scores } = {}) {
  const lines = []
  const name = String(cardName ?? '').trim()
  lines.push(
    name === ''
      ? '你在陪这个人写今天的日记。'
      : `你在陪这个人写今天的日记。你就是「${name}」这个人——按他/她的性子说话，别跳出去当主持人。`,
  )
  const body = String(persona ?? '').trim()
  if (body !== '') lines.push('', '# 你怎么说话', body)
  lines.push(
    '',
    '# 怎么带这一篇',
    '一次只问一件事。问完等他答，别一口气抛五个问题——那不是在陪人说话，是在发问卷。',
    '先问「今天哪件事最值得讲」，让他讲那件事，不是你替他总结这一天。',
    '他讲完一件事，再往下问一层：当时你心里在想什么？这件事最让你不舒服的是哪一点？',
    '情绪问到第三层就够了，别再往下挖。第三层之后人开始防御，问不出来真东西。',
    '如果他说做了一个决定，问一句「那你打算下一步做什么」，把行动落到具体的一件事上。',
    '不评价他的生活，不替他下判断，不把「你应该」挂在嘴边。要说也是「如果你是这么想的，那另一条路是……」这种把选择权留在他手里的说法。',
    '不写他的日记。你只负责问，字是他自己写的；他要你整理，你才整理，而且整理完要让他看一眼。',
    '他不想讲的那件事，就换一件。日记是给自己看的，不是交代材料。',
  )
  const scoreList = String(scores ?? '').trim()
  if (scoreList !== '') lines.push('', '# 上次的四样打分', scoreList)
  const mem = String(memory ?? '').trim()
  if (mem !== '') lines.push('', '# 之前写到哪儿', mem)
  const mode = String(preset ?? '').trim()
  if (mode !== '') lines.push('', `（现在用的是「${mode}」这套问法。）`)
  return lines.join('\n')
}

/**
 * 这一段里给模型看的东西：这一天已经写了什么 + 最近几天的尾巴。
 *
 * 有东西就接着写，没东西就从「今天哪件事最值得讲」开始。
 */
export function buildDiaryUser({ today, draft, recent } = {}) {
  const date = String(today ?? '').trim() === '' ? localDate() : String(today)
  const lines = [`今天是 ${date}。`]
  const body = String(draft ?? '').trim()
  if (body === '') {
    lines.push('今天还一个字没写。')
  } else {
    lines.push('', '# 今天已经写下的', body)
    lines.push('', '这些是今天已经写进这一篇的。接着往下问，别把已经写过的重问一遍。')
  }
  const tail = String(recent ?? '').trim()
  if (tail !== '') lines.push('', '# 前几天写到哪儿', tail)
  lines.push('', '先开口问一句，别一次问好几个。')
  return lines.join('\n')
}

/** 一天结束时，把这一篇整理成「能对得上卡的几条」。不写卡，只给候选。 */
export function buildDigestPrompt({ date, text }) {
  const system = [
    '你在把一篇日记整理成关于这个人的几条事实。',
    '只写日记里真的发生过、真的说过的。没写的不要推，推测的东西一律不要。',
    '每条一句话，不超过 40 字，写具体的事，不写评价（「他这个人很努力」这种不要）。',
    '每条后面用括号标一句日记里的原话，作为依据。',
    '最多 8 条。宁可少，不要凑。',
  ].join('\n')
  const user = [`日期：${String(date ?? '').trim()}`, '', '# 日记原文', String(text ?? '').trim()].join('\n')
  return { system, user }
}

/**
 * 把整份日记排成模型看的样子：只给有内容的小节。
 *
 * 第二个参数可以带上「文件里还有、但不在五节里」的东西（`intro` 和
 * `extraSections`）。不带的话，用户写在开头那段话、自己加的那几节，
 * 模型一个字都看不见——他接着写的时候会把它当空白，人会觉得它没读。
 */
export function diaryBlock(data, options = {}) {
  const d = data !== null && typeof data === 'object' ? data : {}
  const lines = []
  const intro = String(options?.intro ?? '').trim()
  if (intro !== '') lines.push('【开头那段】', intro, '')
  for (const title of DIARY_SECTIONS) {
    const value = d[title]
    const body = DIARY_LIST_SECTIONS.includes(title)
      ? (Array.isArray(value) ? value.map((v) => `- ${v}`).join('\n') : String(value ?? '').trim())
      : String(value ?? '').trim()
    if (body !== '') lines.push(`【${title}】`, body, '')
  }
  const scores = d.scores !== null && typeof d.scores === 'object' ? d.scores : {}
  const scoreLine = DIMENSIONS.filter((name) => scores[name] !== undefined).map((name) => `${name} ${scores[name]}`).join(' / ')
  if (scoreLine !== '') lines.push(`【今天这四样】${scoreLine}`)
  for (const one of Array.isArray(options?.extraSections) ? options.extraSections : []) {
    const title = String(one?.title ?? '').trim()
    const body = String(one?.body ?? '').trim()
    if (title === '' || body === '') continue
    lines.push(`【${title}】`, body, '')
  }
  return lines.length === 0 ? '（这一篇还是空的）' : lines.join('\n').trimEnd()
}

export default {
  DIARY_SECTIONS,
  DIARY_LIST_SECTIONS,
  DIMENSIONS,
  dateFileName,
  diaryFileName,
  diaryRootFrom,
  renderDiaryMarkdown,
  parseDiaryText,
  readDiary,
  writeDiary,
  listDiaries,
  recentBlock,
  buildDiarySystem,
  buildDiaryUser,
  buildDigestPrompt,
  diaryBlock,
}
