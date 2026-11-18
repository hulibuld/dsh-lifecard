/**
 * foreshadow —— 一本书的伏笔账本。
 *
 * 为什么单独记一份账：一章一章往下写的时候，埋过的线全在人的脑子里。
 * 写到第二十章，第三章随手写的那封信早忘了；模型更忘——它每次只看得到
 * 上一章结尾和这一章的计划。账本就是替两边记着这些线。
 *
 * 落盘形状（`books/<书 id>/foreshadows.yml`），平铺的一层数组，不往下套：
 * ```yaml
 * - id: fs-001
 *   title: 码头那封信
 *   status: planted
 *   priority: high
 *   source: plan
 *   planted_chapter: 3
 *   expected_resolve: 12
 *   resolved_chapter: 0
 *   notes: ''
 * ```
 * 为什么是 YAML 而不是 JSON：这份东西用户要能拿眼睛看、拿 grep 找、
 * 拿编辑器改一行。一条记录一段，缩进只有两层，坏了也只坏一行。
 *
 * 这一层只碰磁盘与文字：不调模型、不碰 HTTP。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import * as core from './core.js'

/** 一条线走到哪一步了。 */
export const FORESHADOW_STATUS = ['planted', 'progressing', 'resolved', 'abandoned']

/** 要紧程度。high 的排在前面，模型先看到它。 */
export const FORESHADOW_PRIORITY = ['high', 'normal', 'low']

/** 手上同时挂着多少条没回收的线，就算多了——再往下埋就记不住了。 */
export const ACTIVE_LIMIT = 15

/** 埋下去这么多章还没动过，就该往前推一把，或者干脆不写了。 */
export const STALE_CHAPTERS = 30

/** 每条记录固定这九项，按这个顺序写出去。 */
const FIELDS = [
  'id', 'title', 'status', 'priority', 'source',
  'planted_chapter', 'expected_resolve', 'resolved_chapter', 'notes',
]

/** 这几项在文件里存的是数字，读回来也得是数字，不然比大小会串成字符串。 */
const NUMBER_FIELDS = ['planted_chapter', 'expected_resolve', 'resolved_chapter']

/** 账本放在哪：跟这本书的章节、大纲在同一个文件夹里。 */
export function foreshadowRelPath(bookId) {
  return path.posix.join('books', core.safeId(bookId), 'foreshadows.yml')
}

/** 去掉值外面那层引号（单双都认），单引号里的 `''` 还原成一个 `'`。 */
function unquote(raw) {
  const s = String(raw ?? '').trim()
  if (s.length >= 2) {
    const head = s[0]
    const tail = s[s.length - 1]
    if (head === "'" && tail === "'") return s.slice(1, -1).replace(/''/g, "'")
    if (head === '"' && tail === '"') return s.slice(1, -1).replace(/\\"/g, '"')
  }
  return s
}

/** 把一条记录里的数字项收成数字；收不成数字的按 0 算。 */
function withNumbers(row) {
  const out = { ...row }
  for (const key of NUMBER_FIELDS) {
    const n = Number(out[key])
    out[key] = Number.isFinite(n) ? n : 0
  }
  return out
}

/**
 * 读一份账本。
 *
 * 只认两种行：`- id: …` 起一条新的，`  key: value` 往当前这条里填。
 * 注释、空行、别的花样一律跳过；`id` 或 `title` 缺了的整条丢掉——
 * 一条既没编号又没说清是什么的线，留着只会让后面每一章都带上一句废话。
 *
 * @returns {{ ok: true, list: object[], skipped?: number }}
 */
export function parseForeshadows(text) {
  const list = []
  let skipped = 0
  let cur = null
  const flush = () => {
    if (cur === null) return
    if (String(cur.id ?? '').trim() === '' || String(cur.title ?? '').trim() === '') {
      skipped += 1
      return
    }
    list.push(withNumbers(cur))
  }
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const started = /^\s*-\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (started !== null) {
      flush()
      cur = { [started[1]]: unquote(started[2]) }
      continue
    }
    if (/^\s*(#|$)/.test(line)) continue
    const pair = /^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (pair === null || cur === null) continue
    cur[pair[1]] = unquote(pair[2])
  }
  flush()
  return skipped > 0 ? { ok: true, list, skipped } : { ok: true, list }
}

/** 这个值原样写出去会不会被 YAML 读错。会，就套单引号。 */
function needsQuote(value) {
  const s = String(value ?? '')
  if (s === '') return true
  if (s !== s.trim()) return true
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true
  return /[:#'"\n\r\t]/.test(s) || /\s#/.test(s)
}

/** 一个值写进账本长什么样。 */
function yamlValue(key, value) {
  if (NUMBER_FIELDS.includes(key)) {
    const n = Number(value)
    return String(Number.isFinite(n) ? n : 0)
  }
  const s = String(value ?? '')
  if (!needsQuote(s)) return s
  return `'${s.replace(/'/g, "''")}'`
}

/**
 * 把账本写成文本。一条记录以 `- id:` 起头，其余字段缩两格。
 *
 * 结尾补一个换行：文件末尾没有换行的话，下一次追加会和最后一行粘在一起。
 */
export function renderForeshadows(list) {
  const rows = Array.isArray(list) ? list : []
  const defaults = {
    status: 'planted',
    priority: 'normal',
    source: 'plan',
    planted_chapter: 0,
    expected_resolve: 0,
    resolved_chapter: 0,
    notes: '',
  }
  const out = []
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object') continue
    const row = { ...defaults, ...raw }
    FIELDS.forEach((key, i) => {
      const value = yamlValue(key, row[key])
      out.push(i === 0 ? `- ${key}: ${value}` : `  ${key}: ${value}`)
    })
  }
  return out.length === 0 ? '' : `${out.join('\n')}\n`
}

/**
 * 读这本书的账本。
 *
 * 文件不在不是出错——那只是还没记过伏笔，一本书第一次写的时候就是这样。
 */
export async function readForeshadows(root, bookId) {
  const rel = foreshadowRelPath(bookId)
  let text
  try {
    text = await fs.readFile(path.join(root, rel), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, list: [], missing: true }
    return { ok: false, error: '伏笔账本读不出来。检查一下文件权限。' }
  }
  return parseForeshadows(text)
}

/**
 * 整份覆盖写回去。
 *
 * 先在同一个文件夹里写一个临时文件再改名：写到一半断电/被杀，账本还是上一版，
 * 不会留下半条记录。跨盘改名会报 EXDEV，那就退回直写——丢的是原子性，不是这份账。
 */
export async function writeForeshadows(root, bookId, list) {
  const rel = foreshadowRelPath(bookId)
  const abs = path.join(root, rel)
  const text = renderForeshadows(list)
  const rows = Array.isArray(list) ? list : []
  try {
    await fs.mkdir(path.dirname(abs), { recursive: true })
  } catch {
    return { ok: false, error: '这本书的文件夹没能建起来。检查一下磁盘。' }
  }
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  try {
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, abs)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    if (error?.code === 'EXDEV') {
      try {
        await fs.writeFile(abs, text, 'utf8')
        return { ok: true, count: rows.length }
      } catch {
        return { ok: false, error: '伏笔账本没能存下来。检查一下磁盘是不是满了。' }
      }
    }
    return { ok: false, error: '伏笔账本没能存下来。检查一下磁盘是不是满了。' }
  }
  return { ok: true, count: rows.length }
}

/**
 * 下一条线的编号：现有最大号 + 1。
 *
 * 为什么取最大号而不是数条数：删掉一条 `fs-003` 之后数条数会算出 `fs-003`，
 * 而这个号可能已经写在某一章的正文或者大纲里了。号只往上走，不回头。
 */
export function nextForeshadowId(list) {
  let max = 0
  for (const one of Array.isArray(list) ? list : []) {
    const hit = /^fs-(\d+)$/.exec(String(one?.id ?? '').trim())
    if (hit !== null) max = Math.max(max, Number(hit[1]))
  }
  return `fs-${String(max + 1).padStart(3, '0')}`
}

/** high 排最前，同级保持原来的先后。 */
function byPriority(a, b) {
  const rank = (one) => {
    const i = FORESHADOW_PRIORITY.indexOf(String(one?.priority ?? 'normal'))
    return i < 0 ? 1 : i
  }
  return rank(a) - rank(b)
}

/**
 * 这一章该提哪几条线。
 *
 * `must`：说好了这一章要揭的（`expected_resolve` 正好是这一章）；
 * `warn`：埋太久没动的，和已经过了说好的回收章还没揭的。
 *
 * 只挑出来，不改账本——揭没揭、要不要放弃，是写完之后人的决定。
 *
 * @param {object[]} list
 * @param {number} chapterIndex
 * @param {{ staleChapters?: number }} [options]
 * @returns {{ must: object[], warn: object[] }}
 */
export function pickForChapter(list, chapterIndex, options = {}) {
  const n = Number(chapterIndex) || 0
  const stale = Number(options?.staleChapters) > 0 ? Number(options.staleChapters) : STALE_CHAPTERS
  const must = []
  const warn = []
  for (const one of Array.isArray(list) ? list : []) {
    if (one === null || typeof one !== 'object') continue
    const status = String(one.status ?? 'planted')
    const active = status === 'planted' || status === 'progressing'
    const planted = Number(one.planted_chapter) || 0
    const expected = Number(one.expected_resolve) || 0
    if (active && expected > 0 && expected === n) {
      must.push(one)
      continue
    }
    const gap = n - planted
    if (status === 'planted' && gap >= stale) warn.push({ ...one, stale_by: gap, overdue: false })
    else if (status === 'progressing' && expected > 0 && n > expected) warn.push({ ...one, stale_by: gap, overdue: true })
  }
  must.sort(byPriority)
  warn.sort(byPriority)
  return { must, warn }
}

/** 活跃数：埋下去还没回收的。放弃的不算，回收的更不算。 */
function activeCount(list) {
  return (Array.isArray(list) ? list : []).filter((one) => {
    const s = String(one?.status ?? 'planted')
    return s === 'planted' || s === 'progressing'
  }).length
}

/** 手上挂太多了就说一句；没超就是空串，调用方不用判断。 */
export function budgetHint(list) {
  const n = activeCount(list)
  if (n <= ACTIVE_LIMIT) return ''
  return `手上还有 ${n} 条没回收的伏笔，超过 ${ACTIVE_LIMIT} 条了：先回收或合并几条，再往下埋。`
}

/** 账本里出现过的最晚章号——没别的地方能知道「现在写到第几章」，就拿它当现在。 */
function latestChapter(list) {
  let max = 0
  for (const one of Array.isArray(list) ? list : []) {
    max = Math.max(max, Number(one?.planted_chapter) || 0, Number(one?.resolved_chapter) || 0)
  }
  return max
}

/** 一行中文概览。空账本返回空串——没记过就别在界面上占一行。 */
export function summaryLine(list) {
  const rows = Array.isArray(list) ? list : []
  if (rows.length === 0) return ''
  const count = (s) => rows.filter((one) => String(one?.status ?? 'planted') === s).length
  const planted = count('planted')
  const progressing = count('progressing')
  const resolved = count('resolved')
  const abandoned = count('abandoned')
  const active = planted + progressing
  const now = latestChapter(rows)
  const due = rows.filter((one) => {
    const s = String(one?.status ?? 'planted')
    if (s !== 'planted' && s !== 'progressing') return false
    const expected = Number(one?.expected_resolve) || 0
    return expected > 0 && expected <= now
  }).length

  const parts = [`伏笔 ${rows.length} 条`, `已埋 ${planted}`, `进行中 ${progressing}`, `已回收 ${resolved}`]
  if (abandoned > 0) parts.push(`已放弃 ${abandoned}`)
  const head = `${parts[0]}：${parts.slice(1).join('、')}`
  const tail = due > 0
    ? `没回收的 ${active} 条里 ${due} 条该收了。`
    : `没回收的 ${active} 条都还没到该收的时候。`
  return `${head}；${tail}`
}

export default {
  FORESHADOW_STATUS,
  FORESHADOW_PRIORITY,
  ACTIVE_LIMIT,
  STALE_CHAPTERS,
  foreshadowRelPath,
  parseForeshadows,
  renderForeshadows,
  readForeshadows,
  writeForeshadows,
  nextForeshadowId,
  pickForChapter,
  budgetHint,
  summaryLine,
}
