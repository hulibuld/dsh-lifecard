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
 * 日记放进哪里：用户自己指定的那个文件夹。
 *
 * 没指定就返回空串，让调用方去问，而不是偷偷写进工作区——
 * 用户原话是「日记不用存插件」，那就一个字节都不该落在插件目录里。
 */
export function diaryRootFrom(config) {
  const raw = typeof config?.diary_dir === 'string' ? config.diary_dir.trim() : ''
  if (raw === '') return ''
  if (raw === '~') return path.join(process.env.HOME ?? '', '')
  if (raw.startsWith('~/')) return path.join(process.env.HOME ?? '', raw.slice(2))
  return path.resolve(raw)
}

// ── 读 / 写 ──────────────────────────────────────────────────────

/** 一篇日记写成 Markdown。空小节也留标题，让人打开就知道还能补什么。 */
export function renderDiaryMarkdown(data) {
  const d = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}
  const date = dateFileName(d.date) === '' ? localDate() : String(d.date)
  const mood = String(d.mood ?? '').trim()
  const scores = d.scores !== null && typeof d.scores === 'object' && !Array.isArray(d.scores) ? d.scores : {}
  const head = {
    lifecard: core.DATA_VERSION,
    kind: DIARY_KIND,
    date,
  }
  if (mood !== '') head.mood = mood
  const blocks = DIARY_SECTIONS.map((title) => {
    const value = d[title]
    const body = DIARY_LIST_SECTIONS.includes(title) ? renderList(value) : String(value ?? '').trim()
    return body === '' ? `## ${title}` : `## ${title}\n\n${body}`
  })
  // 打分单独放一段，写成「健康 6」这种最省事的形状：用户手改也方便。
  const scoreLines = DIMENSIONS.filter((name) => Number.isFinite(Number(scores[name])) && String(scores[name]).trim() !== '')
    .map((name) => `- ${name} ${Math.max(0, Math.min(10, Math.round(Number(scores[name]))))}`)
  blocks.push(scoreLines.length === 0 ? '## 今天这四样' : `## 今天这四样\n\n${scoreLines.join('\n')}`)
  return `---\n${core.stringifyYaml(head)}\n---\n\n${blocks.join('\n\n')}\n`
}

/** 反过来：把一篇日记读成 `{data, sections}`。读不成给人话。 */
export function parseDiaryText(text) {
  const parsed = core.parseCard(String(text ?? ''))
  if (parsed.ok !== true) return { ok: false, error: '这一篇日记读不出来，格式不对。' }
  const head = parsed.data ?? {}
  const kind = String(head.kind ?? '').trim()
  if (kind !== '' && kind !== DIARY_KIND) return { ok: false, error: '这个文件不是日记，是别的文件。' }
  const sections = Array.isArray(parsed.sections) ? parsed.sections : []
  const data = { date: String(head.date ?? '').trim() }
  const mood = String(head.mood ?? '').trim()
  if (mood !== '') data.mood = mood
  const scores = {}
  for (const title of DIARY_SECTIONS) {
    const body = core.sectionBody(sections, title)
    data[title] = DIARY_LIST_SECTIONS.includes(title) ? parseList(body) : String(body ?? '').trim()
  }
  for (const line of parseList(core.sectionBody(sections, '今天这四样'))) {
    const m = /^(.+?)\s+(\d{1,2})\s*$/.exec(line)
    if (m === null) continue
    const name = DIMENSIONS.find((d) => d === m[1].trim())
    if (name === undefined) continue
    scores[name] = Math.max(0, Math.min(10, Number(m[2])))
  }
  data.scores = scores
  return { ok: true, data, sections }
}

/** 一行一条的小节：读的时候去掉记号、还原转义。与 career.js 同一套约定。 */
function parseList(body) {
  const out = []
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    let line = raw.trim()
    if (line === '') continue
    if (/^#{1,6}\s/.test(line)) continue
    line = line.replace(/^\s*(?:[-*+]|\d+\s*[.、)．])\s*/, '').trim()
    if (line !== '') out.push(line)
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
 * 读这一天的日记。没有是正常状态（今天还没写），不报错。
 *
 * @param {string} dir 用户指定的日记文件夹
 * @param {string} date YYYY-MM-DD
 */
export async function readDiary(dir, date) {
  const name = dateFileName(date)
  if (name === '') return { ok: false, error: '日子不对，日记只认 年-月-日 这种写法。' }
  if (String(dir ?? '').trim() === '') return { ok: true, data: null, missing: true }
  const abs = path.join(dir, name)
  let text
  try {
    text = await fs.readFile(abs, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, data: null, missing: true, path: name }
    return { ok: false, error: '这一篇日记读不出来。检查一下那个文件夹的权限。' }
  }
  const parsed = parseDiaryText(text)
  if (parsed.ok !== true) return parsed
  return { ok: true, path: name, text, data: parsed.data, sections: parsed.sections }
}

/**
 * 写这一天的日记。
 *
 * 先写临时文件再改名：改名是一次替换，掉电或写满时要么还是旧的完整版、
 * 要么已经是新的完整版，不会留下半篇。
 *
 * @param {string} dir 用户指定的日记文件夹
 */
export async function writeDiary(dir, data, now = new Date()) {
  const input = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}
  const date = dateFileName(input.date) === '' ? localDate(now) : String(input.date)
  const name = dateFileName(date)
  if (name === '') return { ok: false, error: '日子不对，日记只认 年-月-日 这种写法。' }
  if (String(dir ?? '').trim() === '') return { ok: false, error: '还没定日记放在哪个文件夹。' }
  const text = renderDiaryMarkdown({ ...input, date })
  const abs = path.join(dir, name)
  const tmp = `${abs}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, abs)
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {})
    return { ok: false, error: '这一篇没能存下来。检查一下磁盘是不是满了。' }
  }
  return { ok: true, path: name, chars: text.length, data: { ...input, date } }
}

/**
 * 列出写过哪些天（新的在前）。
 *
 * 只认 `YYYY-MM-DD.md`，别的文件一概不看：用户会把这个文件夹拿去同步、
 * 放别的笔记、放图片，多认一个就是多一份「看起来像日记其实不是」的东西。
 */
export async function listDiaries(dir, options = {}) {
  if (String(dir ?? '').trim() === '') return { ok: true, diaries: [], missing: true }
  const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : 400
  let names
  try {
    names = await fs.readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, diaries: [], missing: true }
    return { ok: false, error: '那个日记文件夹读不出来。检查一下权限。' }
  }
  const diaries = []
  for (const name of names) {
    // dateFileName 返回的是带 .md 的文件名，这里得跟原文件名叫法对上，
    // 不然「2026-10-30.md」会被拼成「2026-10-30.md.md」，一条都列不出来。
    const file = dateFileName(String(name).replace(/\.md$/i, ''))
    if (file === '' || file !== name) continue
    const date = file.slice(0, -3)
    const abs = path.join(dir, name)
    let st
    try {
      st = await fs.stat(abs)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    diaries.push({ date, file: name, chars: st.size, mtime: st.mtime.toISOString() })
  }
  diaries.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
  return { ok: true, diaries: diaries.slice(0, limit) }
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
      return data !== null && typeof data === 'object' ? diaryBlock(data) : String(data ?? '').trim()
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

/** 把整份日记排成模型看的样子：只给有内容的小节。 */
export function diaryBlock(data) {
  const d = data !== null && typeof data === 'object' ? data : {}
  const lines = []
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
