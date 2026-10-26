/**
 * tavern —— 酒馆里的对话（角色扮演）。
 *
 * 这一层只做四件事，别的什么都不管：
 *   1. 把一次对话存成一个能直接打开看的 Markdown 文件（`chats/<id>.md`）；
 *   2. 从角色卡里捞出「这个人是谁、怎么说话、不肯说什么」；
 *   3. 从世界书里按关键词挑出这一轮该带上的条目；
 *   4. 拼出一段给模型的话，让它只演一个人。
 *
 * 为什么不用 JSON：用户是拿 Finder 直接翻文件夹的人，出问题时要能用眼看。
 * 一个会话写坏成半截，Markdown 还能读出来一半；JSON 只会整份报废。
 *
 * 这里**不碰** HTTP、不碰模型，纯粹是数据与文字。路由在 index.js 里。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import * as core from './core.js'
import * as store from './store.js'

/** 会话文件放在工作区的哪个文件夹里。 */
export const CHAT_DIR = 'chats'

/** 一次最多带多少条历史给模型。太多会把它顶出上下文，太少它记不住刚才说了什么。 */
export const MAX_HISTORY_TURNS = 24

/** 一个会话最多留多少条。到顶了不再往后长，免得文件越滚越大。 */
export const MAX_TURNS = 400

/** 卡上「这个人是谁」那部分最多贴多少字。卡可能写得很长，全贴会把世界书挤掉。 */
export const MAX_PERSONA_CHARS = 3200

/** 世界书条目合起来最多贴多少字。 */
export const MAX_WORLD_CHARS = 2200

/** 一条回复最多多少字——给模型的建议值，写在提示词里。 */
export const MAX_REPLY_HINT = 160

/** 收尾那段记忆在小节里的标题。 */
export const MEMORY_TITLE = '到这儿为止'

/** 少于这么多轮，收尾没意义（三五句都记不住，那就不该开这一场）。 */
export const MIN_TURNS_TO_SUMMARIZE = 8

/** 正文小节里属于「这个人是谁」的那几节，按这个顺序拼。 */
const PERSONA_SECTIONS = ['自述', '性格', '外貌', '口癖', '不会说的话', '不会做的事', '关系史']

/** 开场白所在的小节。 */
const GREETING_SECTIONS = ['开场白', '备选开场']

/** 会话相对路径。id 过 safeId，`../` 这类东西进不来。 */
export function chatRelPath(id) {
  return path.posix.join(CHAT_DIR, `${core.safeId(id)}.md`)
}

/** 造一个新会话 id：`chat-20261024-1610-ab12`。用本地时间，用户看得懂。 */
export function newChatId(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `chat-${stamp}-${Math.random().toString(36).slice(2, 6)}`
}

/** 一行 YAML 值。字符串一律用 JSON 引号包起来——那本身就是合法 YAML。 */
function yamlValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value === null) return 'null'
  return JSON.stringify(String(value ?? ''))
}

/**
 * 一段正文里，行首的 `#` 会被当成标题。
 *
 * 这一层是给「模型回话」用的：TA 随手写个 `## 第二天` 或 `### 她`，
 * 读回来的时候就会把后面半场对话当成「备忘」吞掉，甚至把说话人改成小标题。
 * 所以写盘前给行首的 `#` 加一个反斜杠，读的时候再削掉——文件照样是人
 * 能直接看懂的纯文本，但解析器不会再认错。
 */
function escapeLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => (/^#{1,6}\s/.test(line) ? `\\${line}` : line))
    .join('\n')
}

/** 反过来：行首那个反斜杠只在它挡着一个 `#` 的时候才削。 */
function unescapeLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => (/^\\(#{1,6}\s)/.test(line) ? line.slice(1) : line))
    .join('\n')
}

/**
 * 把一个会话写成 Markdown。
 *
 * 形状：
 * ```
 * ---
 * lifecard: "0.1"
 * kind: chat
 * id: chat-20261024-1610-ab12
 * card: people/zhang-san.card.md
 * card_name: 张三
 * ...
 * ---
 *
 * ## 对话
 *
 * ### 我
 * 你来了。
 *
 * ### 张三
 * 我来了。
 * ```
 * 用 `### 说话人` 而不是「张三：」前缀，是因为用户可能自己打出「：」，
 * 那样读回来就分不清谁是谁了。
 */
export function renderChatMarkdown(data, turns) {
  const head = { lifecard: '0.1', kind: 'chat', ...data }
  const lines = ['---']
  for (const [key, value] of Object.entries(head)) {
    if (value === undefined) continue
    // 备忘是正文里的段，不是一行 frontmatter；数组/对象也别往 YAML 里塞
    if (key === 'notes' || value !== null && typeof value === 'object') continue
    lines.push(`${key}: ${yamlValue(value)}`)
  }
  lines.push('---', '')
  for (const note of Array.isArray(data?.notes) ? data.notes : []) {
    const title = String(note?.title ?? '').trim()
    if (title === '') continue
    lines.push(`## ${title}`, '', escapeLines(String(note?.body ?? '').trim()), '')
  }
  lines.push('## 对话', '')
  for (const turn of Array.isArray(turns) ? turns : []) {
    const who = String(turn?.who ?? '').trim()
    const text = String(turn?.text ?? '').trim()
    if (who === '' || text === '') continue
    lines.push(`### ${who}`, '', escapeLines(text), '')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * 反过来：把文件读成 `{data, turns, notes}`。
 *
 * 解析失败不抛——返回 `{ok:false}`，让路由把原因说给用户听。
 * @returns {{ok: boolean, data?: object, turns?: Array<{who: string, text: string}>, error?: string}}
 */
export function parseChatText(text) {
  const parsed = core.parseCard(String(text ?? ''))
  if (parsed.ok !== true) {
    return { ok: false, error: `这个会话文件读不出来：${(parsed.errors ?? []).join('；') || '格式不对'}` }
  }
  const turns = []
  const body = core.sectionBody(parsed.sections, '对话')
  let cur = null
  for (const raw of String(body).split(/\r?\n/)) {
    const hit = /^###\s+(.+?)\s*$/.exec(raw)
    if (hit !== null) {
      if (cur !== null && cur.text.trim() !== '') turns.push({ who: cur.who, text: unescapeLines(cur.text.trim()) })
      cur = { who: hit[1].trim(), text: '' }
      continue
    }
    if (cur === null) continue
    cur.text += `${raw}\n`
  }
  if (cur !== null && cur.text.trim() !== '') turns.push({ who: cur.who, text: unescapeLines(cur.text.trim()) })
  const notes = []
  for (const section of parsed.sections ?? []) {
    const title = String(section?.title ?? '').trim()
    if (title === '' || title === '对话') continue
    notes.push({ title, body: unescapeLines(String(section.body ?? '').trim()) })
  }
  return { ok: true, data: parsed.data ?? {}, turns, notes }
}

/** 读一个会话。 */
export async function readChat(root, id) {
  const rel = chatRelPath(id)
  const at = await store.resolveIn(root, rel)
  if (!at.ok) return { ok: false, error: at.error }
  let text
  try {
    text = await fs.readFile(at.abs, 'utf8')
  } catch {
    return { ok: false, error: '这个会话不在了' }
  }
  const parsed = parseChatText(text)
  if (parsed.ok !== true) return parsed
  return { ok: true, path: rel, text, ...parsed }
}

/** 写一个会话（覆盖）。 */
export async function writeChat(root, id, data, turns) {
  const rel = chatRelPath(id)
  const at = await store.resolveIn(root, rel)
  if (!at.ok) return { ok: false, error: at.error }
  await fs.mkdir(path.dirname(at.abs), { recursive: true })
  const text = renderChatMarkdown({ ...data, turns: (turns ?? []).length }, turns)
  try {
    // 先写临时文件再改名：磁盘满、掉电、进程被杀的时候，原来那份还是完整的。
    // 会话是整文件重写，没有这一步就是在拿用户聊了半天的那份东西赌运气。
    const tmp = `${at.abs}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, at.abs)
  } catch {
    return { ok: false, error: '这个会话没能存下来。检查一下文件夹权限或者磁盘是不是满了。' }
  }
  return { ok: true, path: rel, turns: (turns ?? []).length }
}

/** 删一个会话。 */
export async function deleteChat(root, id) {
  const rel = chatRelPath(id)
  const at = await store.resolveIn(root, rel)
  if (!at.ok) return { ok: false, error: at.error }
  try {
    await fs.unlink(at.abs)
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, gone: true }
    return { ok: false, error: '这个会话没能删掉。检查一下文件权限。' }
  }
  return { ok: true }
}

/**
 * 列会话。
 *
 * 读文件失败要如实报（`bad` 计数），不能当成「没有会话」——那是两件事，
 * 混起来用户会以为自己的记录被吃了。
 */
export async function listChats(root) {
  const dir = path.join(root, CHAT_DIR)
  let names
  try {
    names = await fs.readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, items: [], bad: 0 }
    if (error?.code === 'ENOTDIR') return { ok: false, error: '「chats」这个位置上放的是别的东西，不是文件夹' }
    return { ok: false, error: '会话列表读不出来。检查一下文件夹权限。' }
  }
  const items = []
  let bad = 0
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const id = name.slice(0, -'.md'.length)
    const got = await readChat(root, id)
    if (got.ok !== true) {
      bad += 1
      continue
    }
    const turns = got.turns ?? []
    const last = turns[turns.length - 1]
    items.push({
      id: String(got.data?.id ?? id),
      path: got.path,
      card: String(got.data?.card ?? ''),
      card_name: String(got.data?.card_name ?? got.data?.card ?? ''),
      world: String(got.data?.world ?? ''),
      world_name: String(got.data?.world_name ?? ''),
      created_at: String(got.data?.created_at ?? ''),
      updated_at: String(got.data?.updated_at ?? ''),
      turns: turns.length,
      last: typeof last?.text === 'string' ? last.text.slice(0, 60) : '',
    })
  }
  items.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
  return { ok: true, items, bad }
}

/** 取某个小节的正文（没有就空串）。 */
function sectionOf(sections, title) {
  return String(core.sectionBody(sections, title) ?? '').trim()
}

/**
 * 从一张角色卡里抽出「这个人是谁」。
 *
 * 只取角色那一面：自述、性格、外貌、口癖、边界、关系史。不取材料来源、
 * 不取创作备注——那些是给作者看的，贴进对话会让 TA 忽然开始谈自己怎么写的。
 */
export function personaFromCard(data, sections) {
  const parts = []
  for (const title of PERSONA_SECTIONS) {
    const body = sectionOf(sections, title)
    if (body === '' || body === '_（还没写）_') continue
    parts.push(`【${title}】\n${body}`)
  }
  let text = parts.join('\n\n')
  if (text.length > MAX_PERSONA_CHARS) text = `${text.slice(0, MAX_PERSONA_CHARS)}…`
  const name = String(data?.name ?? '').trim()
  return { name, text }
}

/** 卡上的开场白（有就返回，没有返回空串）。 */
export function greetingOf(sections) {
  for (const title of GREETING_SECTIONS) {
    const body = sectionOf(sections, title)
    if (body !== '' && body !== '_（还没写）_') return body
  }
  return ''
}

/**
 * 按关键词挑世界书条目。
 *
 * 规则与酒馆那套一致，只取最要紧的三条：
 *   - `constant: true` 的条目每轮都带（那是「世界的基本设定」）；
 *   - 别的条目在最近说过的话里出现关键词时才带；
 *   - 合起来不超过 MAX_WORLD_CHARS。
 *
 * 关键词兼容 ST 的两种写法：`keys: [a, b]` 与 `keys: "a, b"`。
 */
export function pickWorldEntries(entries, recentText) {
  const hay = String(recentText ?? '').toLowerCase()
  const always = []
  const hit = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const content = String(entry?.content ?? '').trim()
    if (content === '') continue
    const rawKeys = entry?.keys ?? entry?.key ?? []
    const keys = (Array.isArray(rawKeys) ? rawKeys : String(rawKeys).split(/[,，]/))
      .map((k) => String(k).trim().toLowerCase())
      .filter((k) => k !== '')
    const isConstant = entry?.constant === true || entry?.always === true || keys.length === 0
    if (isConstant) {
      always.push({ content, keys })
      continue
    }
    if (hay === '') continue
    if (keys.some((k) => hay.includes(k))) hit.push({ content, keys })
  }
  const chosen = []
  let used = 0
  for (const item of [...always, ...hit]) {
    if (used + item.content.length > MAX_WORLD_CHARS) continue
    chosen.push(item.content)
    used += item.content.length
  }
  return chosen
}

/**
 * 拼「你是谁」那一段系统提示。
 *
 * 刻意写死几句约束：不替对方说话、不跳出角色解释、不加括号注释。
 * 这三样是角色扮演最容易崩的地方，不写清楚模型每次都会犯。
 */
export function buildRoleplaySystem({ cardName, persona, worldNotes, memory, preset }) {
  const name = cardName === '' ? '这个人' : cardName
  const lines = [
    `你正在演一个角色扮演对话。你只演「${name}」这一个人，对方是「我」。`,
    '',
    `【你是谁】`,
    persona === '' ? `（这张卡还没写自述。按名字「${name}」的气质演，别编太多具体经历。）` : persona,
  ]
  if (Array.isArray(worldNotes) && worldNotes.length > 0) {
    lines.push('', '【这个世界】', worldNotes.join('\n\n'))
  }
  // 说是「收个尾」，其实就是一句记忆：说得久了前面那些轮次会被挤掉，
  // 不给它一段「到这儿为止」的交代，它会开始把之前发生过的事记错。
  const remember = String(memory ?? '').trim()
  if (remember !== '') {
    lines.push('', '【到这儿为止】', remember, '', '（上面这些是之前真的发生过的，别和它矛盾；没说过的别编。）')
  }
  lines.push(
    '',
    '【怎么演】',
    '- 只用「' + name + '」的口气说话，像真人聊天，不写小说旁白。',
    `- 一次回 1 到 3 段，一般不超过 ${MAX_REPLY_HINT} 字，留出给对方接话的空。`,
    '- 不替「我」说话，不替「我」做决定，不写「我」的心理活动。',
    '- 不跳出角色解释自己，不写「（作为 AI）」「（注）」「（旁白）」这类东西。',
    '- 卡上写了「不会说的话」「不会做的事」，就真的别说、别做。',
    '- 不知道的事说不知道；没发生过的事不要编成回忆。',
    '',
    '直接写你要说的话，不要写「' + name + '：」这样的前缀。',
  )
  // 演法预设排在最后：它是「这一次想怎么演」，比上面那些通用约束更具体，
  // 放前面会被一长串规则冲淡。
  const flavour = String(preset ?? '').trim()
  if (flavour !== '') lines.push('', '【这一次的演法】', flavour)
  return lines.join('\n')
}

/**
 * 拼这一轮发给模型的话：最近几轮对话 + 最后那一句。
 *
 * 历史只带最近 MAX_HISTORY_TURNS 条；带太多既慢又容易让它忘掉最开始的人设。
 */
export function buildRoleplayUser({ cardName, turns }) {
  const name = cardName === '' ? '这个人' : cardName
  const recent = (Array.isArray(turns) ? turns : []).slice(-MAX_HISTORY_TURNS)
  if (recent.length === 0) return `请「${name}」先说一句话，把场面打开。`
  const lines = ['下面是刚才的对话：', '']
  for (const turn of recent) {
    lines.push(`${turn.who === '我' ? '我' : turn.who}：${turn.text}`)
    lines.push('')
  }
  lines.push(`现在轮到「${name}」接着说。只写「${name}」会说的话。`)
  return lines.join('\n')
}

/**
 * 挑「这一轮该带上哪些世界书条目」时需要看的文字：最近几轮 + 这一句。
 */
/**
 * 拼「把前面这些收一收」的那两段话。
 *
 * 只让它记事实：发生过什么、关系有什么变化、什么事还没了。不要它评论、
 * 不要它抒情——收尾一旦变成总结陈词，下一轮它会照着那个腔调演。
 */
export function buildSummaryPrompt({ cardName, turns }) {
  const name = cardName === '' ? '这个人' : cardName
  const lines = []
  for (const turn of Array.isArray(turns) ? turns : []) {
    const who = String(turn?.who ?? '').trim()
    const text = String(turn?.text ?? '').trim()
    if (who === '' || text === '') continue
    lines.push(`${who}：${text}`)
  }
  const system = [
    '你要把一段角色扮演的对话压缩成一份「备忘」。',
    '只写到这里为止真的发生过的事：谁说了什么要紧的、两个人的关系有什么变化、还有什么没解决。',
    '不要评论，不要总结「这段对话体现了什么」，不要写成信或者散文。',
    '用三到六句话，用第三人称陈述，不用引号复述原话。',
  ].join('\n')
  const user = `扮演的是「${name}」，对面是「我」。下面是这一段对话：\n\n${lines.join('\n')}\n\n请写成备忘。`
  return { system, user }
}

/**
 * 「把这一场里最能代表 TA 的几句挑出来」要发给模型的话。
 *
 * 挑出来之后会写进这张卡的「对话示例」小节。这一小节是下次演 TA 时
 * 最有效的材料之一：比「性格：沉默寡言」有用得多，因为它是真的话。
 */
export function buildExamplePrompt({ cardName, turns }) {
  const name = cardName === '' ? '这个人' : cardName
  const lines = []
  for (const turn of Array.isArray(turns) ? turns : []) {
    const who = String(turn?.who ?? '').trim()
    const text = String(turn?.text ?? '').trim()
    if (who === '' || text === '') continue
    lines.push(`${who}：${text}`)
  }
  const system = [
    `你要从一段对话里挑出最能代表「${name}」怎么说话的几句。`,
    '挑的是**TA 说的话**，不是「我」说的。',
    '挑四到八句。短句优先。要能看出这个人说话的节奏、用词习惯、回避什么、什么时候会突然多说两句。',
    '每句原样抄下来，一个字都不要改，不要加解释，不要加编号。',
    '一行一句，前面写「TA：」。挑不出来就只输出一个「无」。',
  ].join('\n')
  const user = `扮演的是「${name}」，对面是「我」。下面是这一段对话：\n\n${lines.join('\n')}\n\n请挑出最能代表 TA 说话方式的几句。`
  return { system, user }
}

/**
 * 把模型挑出来的那几行收干净。
 *
 * 它会不老实：加编号、加「TA：」以外的前缀、加解释、或者干脆用引号包起来。
 * 这里只认「TA：」后面的内容，别的都丢掉；同一句重复的只留一次。
 */
export function cleanExamples(text, limit = 8) {
  const out = []
  const seen = new Set()
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    let line = raw.trim()
    if (line === '' || line === '无' || line === '沒有' || line === '没有') continue
    line = line.replace(/^[-*•\d.、．)\s]+/, '')
    line = line.replace(/^(TA|ta|Ta|她|他)\s*[：:]\s*/, '')
    line = line.replace(/^[「“"']|[」”"']$/g, '').trim()
    if (line === '' || line.length < 2) continue
    if (seen.has(line)) continue
    seen.add(line)
    out.push(line)
    if (out.length >= limit) break
  }
  return out
}

export function recentContextText(turns) {
  return (Array.isArray(turns) ? turns : [])
    .slice(-6)
    .map((t) => String(t?.text ?? ''))
    .join('\n')
}

export default {
  CHAT_DIR,
  MAX_HISTORY_TURNS,
  MAX_TURNS,
  MAX_PERSONA_CHARS,
  MAX_WORLD_CHARS,
  MAX_REPLY_HINT,
  MEMORY_TITLE,
  MIN_TURNS_TO_SUMMARIZE,
  buildSummaryPrompt,
  buildExamplePrompt, cleanExamples,
  chatRelPath,
  newChatId,
  renderChatMarkdown,
  parseChatText,
  readChat,
  writeChat,
  deleteChat,
  listChats,
  personaFromCard,
  greetingOf,
  pickWorldEntries,
  buildRoleplaySystem,
  buildRoleplayUser,
  recentContextText,
}
