/**
 * career —— 写简历、规划以后往哪走。
 *
 * 为什么单独一层：简历和「人物卡」不是一回事。卡记的是「一个人是谁」，
 * 这里记的是「他学过什么、做过什么、下一步去哪」——这些内容会变，而且用户要能自己改。
 *
 * 落盘形状（用户拿 Finder 就能看、能改）：
 * ```
 * career/
 *   profile.md    现在有什么：基本情况、学过什么、做过什么、会用哪些工具、想去哪、还差什么
 *   purpose.md    以后怎么走：终点长什么样、分几步走、现在这一步、可能会卡在哪
 * ```
 * 只有两份文件，不按日期分文件夹：简历只有一份，规划也只有一份，改了就覆盖。
 * 想留旧版本，让用户自己复制一份。
 *
 * 这一层只碰磁盘与文字：不调模型、不碰 HTTP。路由在 index.js，界面在 client.js。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import * as core from './core.js'
import { localDate } from './store.js'

/** 和简历有关的东西都放在工作区的这个文件夹里。 */
export const CAREER_DIR = 'career'

/** 「现在有什么」那份文件。路径写死，不从外面接收。 */
export const PROFILE_REL = 'career/profile.md'

/** 「以后怎么走」那份文件。路径写死，不从外面接收。 */
export const PURPOSE_REL = 'career/purpose.md'

/** 简历正文的六个小节。这个顺序就是写进文件的顺序。 */
export const PROFILE_SECTIONS = ['基本情况', '学过什么', '做过什么', '会用哪些工具', '想去哪', '还差什么']

/** 简历里一行一条的那几个小节，其余小节是一段自由文字。 */
export const PROFILE_LIST_SECTIONS = ['学过什么', '做过什么', '会用哪些工具', '还差什么']

/** 规划正文的四个小节。 */
export const PLAN_SECTIONS = ['终点长什么样', '分几步走', '现在这一步', '可能会卡在哪']

/** 规划里一行一条的那个小节。 */
export const PLAN_LIST_SECTIONS = ['分几步走']

/** frontmatter 里的 kind 值。用来分清这个文件到底是简历还是规划。 */
const PROFILE_KIND = 'career-profile'
const PLAN_KIND = 'career-plan'

// ── 一行一条的小节：写入 / 读出 ──────────────────────────────────────
//
// 一条内容里如果带换行，直接写进文件会被读成两条。所以写入前把换行记成 `\n`
// 这两个字符，读回来再还原；反斜杠本身也要先转义，否则分不清哪个 `\` 是原来的。
// 用户自己手写的内容不带这两个字符，写进去就是原样。

function escapeItem(text) {
  return String(text ?? '')
    .trim()
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
}

function unescapeItem(text) {
  return String(text ?? '').replace(/\\(\\|n|r)/g, (_, c) => (c === 'n' ? '\n' : c === 'r' ? '\r' : '\\'))
}

/** 把「学过什么」这类小节的值统一成一个字符串数组。 */
function asItems(value) {
  if (Array.isArray(value)) return value.map((v) => String(v ?? '').trim()).filter((v) => v !== '')
  const text = String(value ?? '').trim()
  if (text === '') return []
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+\s*[.、)．])\s*/, '').trim())
    .filter((line) => line !== '')
}

/** 写文件用：每条一行，内容里的换行已经转义过。 */
function renderList(value) {
  return asItems(value)
    .map(escapeItem)
    .filter((line) => line !== '')
    .map((line) => `- ${line}`)
    .join('\n')
}

/** 拼提示词用：原样输出，不转义，让模型看到的是正常的多行文字。 */
function plainList(value) {
  return asItems(value)
    .map((item) => `- ${item}`)
    .join('\n')
}

/** 一段自由文字。多行就原样保留。 */
function freeText(value) {
  if (Array.isArray(value)) return value.map((v) => String(v ?? '').trim()).filter((v) => v !== '').join('\n')
  return String(value ?? '').trim()
}

/** 读一个「一行一条」的小节：去掉行首的 `-`、`*`、`1.` 这些记号，再还原转义。 */
function parseList(body) {
  const out = []
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    let line = raw.trim()
    if (line === '') continue
    if (/^#{1,6}\s/.test(line)) continue
    line = line.replace(/^\s*(?:[-*+]|\d+\s*[.、)．])\s*/, '').trim()
    const text = unescapeItem(line)
    if (text !== '') out.push(text)
  }
  return out
}

// ── 整份文件：写入 / 读出 ──────────────────────────────────────────

/**
 * 一份文件：frontmatter + 若干 `## 小节`。
 *
 * 空小节也把标题写出来，用户打开文件就知道还能填什么，不用对着空白想字段名。
 */
function renderDoc(head, data, order, listSections) {
  const blocks = order.map((title) => {
    const body = listSections.includes(title) ? renderList(data?.[title]) : freeText(data?.[title])
    return body === '' ? `## ${title}` : `## ${title}\n\n${body}`
  })
  return `---\n${core.stringifyYaml(head)}\n---\n\n${blocks.join('\n\n')}\n`
}

/**
 * 读一份文件。读不成的时候给的是人话，不是解析器的报错。
 * @param {string} text
 * @param {{kind: string, sections: string[], listSections: string[], keep: string[], error: string, wrongKind: string}} spec
 */
function parseDoc(text, spec) {
  const parsed = core.parseCard(String(text ?? ''))
  if (parsed.ok !== true) return { ok: false, error: spec.error }
  const head = parsed.data ?? {}
  const kind = String(head.kind ?? '').trim()
  if (kind !== '' && kind !== spec.kind) return { ok: false, error: spec.wrongKind }

  const data = {}
  for (const key of spec.keep) {
    const value = head[key]
    if (value !== undefined && value !== null) data[key] = String(value).trim()
  }

  const sections = {}
  for (const title of spec.sections) {
    const body = core.sectionBody(parsed.sections ?? [], title)
    sections[title] = spec.listSections.includes(title) ? parseList(body) : String(body ?? '').trim()
    data[title] = sections[title]
  }
  return { ok: true, data, sections }
}

/** 读一份文件。找不到是正常状态（还没写过），不报错。 */
async function readDoc(root, rel, parse, label) {
  let text
  try {
    text = await fs.readFile(path.join(root, rel), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, data: null, sections: null, missing: true }
    return { ok: false, error: `${label}读不出来。检查一下这个文件夹的权限。` }
  }
  const parsed = parse(text)
  if (parsed.ok !== true) return parsed
  return { ok: true, path: rel, text, data: parsed.data, sections: parsed.sections }
}

/**
 * 写一份文件。
 *
 * 先写临时文件再改名：改名是一次替换，掉电或者磁盘写满的时候，
 * 原来那份要么还是旧的完整版本，要么已经是新的完整版本，不会留下半份。
 * `rel` 只由本文件里的常量传进来，外面传的路径一律不用。
 */
async function writeDoc(root, rel, text, label) {
  const abs = path.join(root, rel)
  const tmp = `${abs}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, abs)
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {})
    return { ok: false, error: `${label}没能存下来。检查一下磁盘是不是满了。` }
  }
  return { ok: true, path: rel, chars: text.length }
}

// ── 简历：profile.md ─────────────────────────────────────────────

/**
 * 简历写成 Markdown。
 *
 * 只写用户自己填进去的东西。没填的小节留一个标题空着，方便他下次接着写。
 */
export function renderProfileMarkdown(data) {
  const d = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}
  const name = String(d.name ?? '').trim()
  const updated = String(d.updated_at ?? '').trim()
  const head = {
    lifecard: core.DATA_VERSION,
    kind: PROFILE_KIND,
    name: name === '' ? '未命名' : name,
    updated_at: updated === '' ? localDate() : updated,
  }
  return renderDoc(head, d, PROFILE_SECTIONS, PROFILE_LIST_SECTIONS)
}

/** 反过来：把 profile.md 读成 `{data, sections}`。 */
export function parseProfileText(text) {
  return parseDoc(String(text ?? ''), {
    kind: PROFILE_KIND,
    sections: PROFILE_SECTIONS,
    listSections: PROFILE_LIST_SECTIONS,
    keep: ['name', 'updated_at'],
    error: '这份简历读不出来，格式不对',
    wrongKind: '这个文件不是简历，是别的文件。',
  })
}

/** 读简历。还没写过返回 `{ok: true, data: null}`——没简历是正常状态，不是出错。 */
export async function readProfile(root) {
  return readDoc(root, PROFILE_REL, parseProfileText, '简历')
}

/**
 * 写简历。
 *
 * 只收 `root` 和内容，不收路径：路径固定是 `career/profile.md`，
 * 内容里就算带了 path 也不会被用到，写不到 `career/` 外面去。
 */
export async function writeProfile(root, data, now = new Date()) {
  const input = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}
  const next = { ...input }
  next.updated_at = localDate(now)
  const text = renderProfileMarkdown(next)
  const written = await writeDoc(root, PROFILE_REL, text, '简历')
  if (written.ok !== true) return written
  return { ...written, data: next }
}

// ── 规划：purpose.md ─────────────────────────────────────────────

/** 规划写成 Markdown。`horizon` 是这段规划管多久（3个月、1年、4年这种）。 */
export function renderPlanMarkdown(data) {
  const d = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}
  const updated = String(d.updated_at ?? '').trim()
  const head = {
    lifecard: core.DATA_VERSION,
    kind: PLAN_KIND,
    horizon: String(d.horizon ?? '').trim(),
    updated_at: updated === '' ? localDate() : updated,
  }
  return renderDoc(head, d, PLAN_SECTIONS, PLAN_LIST_SECTIONS)
}

/** 反过来：把 purpose.md 读成 `{data, sections}`。 */
export function parsePlanText(text) {
  return parseDoc(String(text ?? ''), {
    kind: PLAN_KIND,
    sections: PLAN_SECTIONS,
    listSections: PLAN_LIST_SECTIONS,
    keep: ['horizon', 'updated_at'],
    error: '这份规划读不出来，格式不对',
    wrongKind: '这个文件不是规划，是别的文件。',
  })
}

/** 读规划。还没写过返回 `{ok: true, data: null}`。 */
export async function readPlan(root) {
  return readDoc(root, PURPOSE_REL, parsePlanText, '规划')
}

/** 写规划。路径同样写死，只写 `career/purpose.md`。 */
export async function writePlan(root, data, now = new Date()) {
  const input = data !== null && typeof data === 'object' && !Array.isArray(data) ? data : {}
  const next = { ...input }
  next.updated_at = localDate(now)
  const text = renderPlanMarkdown(next)
  const written = await writeDoc(root, PURPOSE_REL, text, '规划')
  if (written.ok !== true) return written
  return { ...written, data: next }
}

// ── 让模型干活的三段话 ────────────────────────────────────────────

/** 把简历的各小节排成模型看得懂的一段文字。空的小节不占地方。 */
function profileBlock(profile) {
  const lines = []
  for (const title of PROFILE_SECTIONS) {
    const body = PROFILE_LIST_SECTIONS.includes(title) ? plainList(profile?.[title]) : freeText(profile?.[title])
    if (body === '') continue
    lines.push(`【${title}】`, body, '')
  }
  if (lines.length === 0) return '（他还没填任何材料。）'
  return lines.join('\n').trimEnd()
}

/** 写简历的那两段话。只准写发生过的事。 */
export function buildResumePrompt({ profile, target } = {}) {
  const want = String(target ?? '').trim()
  const system = [
    '你在帮一个大学生写简历。',
    '你只写简历上该有的东西：学校专业、时间、做过的事、做出来的结果、会用哪些工具。',
    '',
    '写的时候守这几条：',
    '- 不许编造没发生过的事。材料里没写的就留空，不要替他补一段听起来不错的经历。',
    '- 句子要短，一句话说清一件事。',
    '- 不用「负责」「参与」「协助」这种看不出到底做了什么的话，直接写他做了什么。',
    '- 能量化就给数：写「改了四稿」「带了 12 个学生」，不写「多次」「大量」。',
    '- 不写自我评价，不写「学习能力强」「能吃苦」「热爱这一行」。招聘的人不看这些。',
    '- 没有经历的部分不要硬凑，空着比编一段强。',
    '',
    '输出直接用 Markdown，按「教育背景」「课程与成绩」「做过的事」「会用的工具」「想去的方向」分段。',
    '哪一段没有内容就整段不写，不要写「暂无」。',
    '不要解释你是怎么写的，不要问我问题，直接给简历。',
  ].join('\n')

  const user = [
    '下面是他自己填的材料：',
    '',
    profileBlock(profile),
    '',
    '【这份简历投给谁】',
    want === '' ? '（他没填目标。按上面「想去哪」那一段自己判断。）' : want,
    '',
    '【要你做什么】',
    '照上面的目标写一份能直接投出去的简历。他真有的东西写清楚，没有的不要编。',
  ].join('\n')

  return { system, user }
}

/** 做长期规划的那两段话。每一步都要能动手，也要能判断做完没做完。 */
export function buildPathPrompt({ profile, goal, horizon } = {}) {
  const aim = String(goal ?? '').trim()
  const span = String(horizon ?? '').trim()
  const system = [
    '你在帮一个人规划接下来一段时间怎么走。要的不是愿景，是能照着做的事。',
    '',
    '要求：',
    '- 每一步都要落到「下个月做什么」这个程度。不要写「多读书」「积累经验」「多了解这个行业」这种没法动手的话。',
    '- 每一步都必须写清楚：做完没做完怎么判断。判断标准要看得见（考了多少分、写完几篇、拿到谁的回复、投出去几份），不能是「有提升」。',
    '- 不许写鸡汤和大词。「提升自我」「赋能」「沉淀」「破圈」「找到热爱」「成为更好的自己」这类一概不许出现。',
    '- 如果他的目标和材料明显对不上（比如目标是进地质类院所的技术岗，但学过的课、做过的事全不沾边），要直说这个矛盾，放在最前面，不要绕过去，也不要替他圆场。',
    '- 步骤之间要有先后：前一步没做完，后一步不该开始，就在后一步里写清楚前置条件。',
    '- 时间要具体到月份或者「第几个月」，不要写「尽快」「适当时候」。',
    '',
    '输出用 Markdown，分四段：',
    '## 终点长什么样',
    '## 分几步走',
    '## 现在这一步',
    '## 可能会卡在哪',
    '「分几步走」每行一条，格式是：- 这一步做什么｜大概什么时候｜怎么算做完了。',
    '不要客套，不要鼓励，直接给规划。',
  ].join('\n')

  const user = [
    '【他现在有什么】',
    '',
    profileBlock(profile),
    '',
    '【他想到哪儿】',
    aim === '' ? '（他没写清楚要去哪。按上面「想去哪」那一段判断。）' : aim,
    '',
    '【这段规划管多久】',
    span === '' ? '（他没填。按一年算。）' : span,
    '',
    '【要你做什么】',
    '写一份从今天到那个终点的规划，落到下个月做什么。',
    '如果目标和上面的材料对不上，第一段就把这个矛盾说出来。',
  ].join('\n')

  return { system, user }
}

/** 差距分析的那两段话。缺的排前面，每条要具体。 */
export function buildGapPrompt({ profile, target } = {}) {
  const want = String(target ?? '').trim()
  const system = [
    '你在做一次差距分析：他要去的地方要求什么，他现在有什么，中间差什么。',
    '',
    '要求：',
    '- 把「目标要求的」和「他现在有的」并排列出来，一行一条，能对上的写在同一行。',
    '- 缺的东西写在最前面，不要藏在后面。',
    '- 每条必须具体到能看见：写「六级还没过」，不写「需要提升英语」；写「没写过学术论文」，不写「学术能力不足」。',
    '- 不要写「建议多实习」这种谁都能说的话。要说清楚是哪一类单位、做什么事、大概什么时候开始。',
    '- 材料里看不出来的地方，就写「看不出来」，不要猜。',
    '- 只谈事实和差距，不评价他这个人。',
    '',
    '输出用 Markdown，三段：',
    '## 差什么',
    '## 目标要什么、现在有什么',
    '## 先补哪一条',
    '「差什么」按要紧程度排，第一条要是最难绕过去的那一条。',
    '不要鼓励，不要总结，直接说差距。',
  ].join('\n')

  const user = [
    '【他现在有什么】',
    '',
    profileBlock(profile),
    '',
    '【目标】',
    want === '' ? '（他没填目标。按上面「想去哪」那一段判断。）' : want,
    '',
    '【要你做什么】',
    '把目标要求的和他现在有的并排列出来，缺的写在最前面。',
  ].join('\n')

  return { system, user }
}

// ── 从模型输出里扒步骤 ────────────────────────────────────────────

/** 按 `｜` 或 `|` 切三段，第三段之后的内容原样留在第三段里。 */
function splitPipes(text) {
  const parts = []
  let cur = ''
  for (const ch of String(text ?? '')) {
    if (parts.length < 2 && (ch === '｜' || ch === '|')) {
      parts.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  parts.push(cur)
  return parts.map((part) => part.trim())
}

/**
 * 从一段模型输出里抽出步骤。
 *
 * 认两种行：
 *   - 这一步做什么｜大概什么时候｜怎么算做完了
 *   1. 这一步做什么
 * 认不出来的行直接跳过，不报错——模型常常在前后写几句解释。
 * @returns {Array<{text: string, when: string, done: string}>}
 */
export function parseSteps(text) {
  const out = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    if (/^#{1,6}\s/.test(line)) continue
    if (/^[|｜]/.test(line)) continue

    let body = ''
    const bullet = /^[-*+]\s+(.+)$/.exec(line)
    if (bullet !== null) {
      body = bullet[1].trim()
    } else {
      const numbered = /^\d+\s*[.、)．]\s*(.+)$/.exec(line)
      if (numbered !== null) {
        body = numbered[1].trim()
      } else {
        const chinese = /^第\s*[\d一二三四五六七八九十]+\s*步\s*[:：、.．]?\s*(.+)$/.exec(line)
        if (chinese === null) continue
        body = chinese[1].trim()
      }
    }
    if (body === '') continue
    const [first = '', second = '', third = ''] = splitPipes(body)
    if (first === '' && second === '' && third === '') continue
    out.push({ text: first, when: second, done: third })
  }
  return out
}

export default {
  CAREER_DIR,
  PROFILE_REL,
  PURPOSE_REL,
  renderProfileMarkdown,
  parseProfileText,
  renderPlanMarkdown,
  parsePlanText,
  readProfile,
  writeProfile,
  readPlan,
  writePlan,
  buildResumePrompt,
  buildPathPrompt,
  buildGapPrompt,
  parseSteps,
}
