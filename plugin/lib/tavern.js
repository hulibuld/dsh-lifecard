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
import * as cardtext from './cardtext.js'

/** 会话文件放在工作区的哪个文件夹里。 */
export const CHAT_DIR = 'chats'

/** 一次最多带多少条历史给模型。太多会把它顶出上下文，太少它记不住刚才说了什么。 */
export const MAX_HISTORY_TURNS = 24

/**
 * 历史对话合起来最多带多少字。
 *
 * 为什么轮数和字数两道都要：轮数管的是「刚才发生了什么」的时间跨度——
 * 给够 24 轮，它才接得住一场来回；但 24 轮也是 24 轮，对面连着发几段长文，
 * 光历史就能把上下文挤满，这一轮自己说的话反而没地方放。所以两个条件同时卡：
 * 轮数先卡住跨度，字数再从最新一条往前收。
 */
export const MAX_HISTORY_CHARS = 6000

/** 一个会话最多留多少条。到顶了不再往后长，免得文件越滚越大。 */
export const MAX_TURNS = 400

/** 卡上「这个人是谁」那部分最多贴多少字。卡可能写得很长，全贴会把世界书挤掉。 */
export const MAX_PERSONA_CHARS = 3200

/**
 * 提示词型卡（整份正文就是一段硬规则）最多贴多少字。
 *
 * 这个上限必须比 `MAX_PERSONA_CHARS` 高得多，理由很实在：网上流传的破限卡、
 * 规范卡，正文动辄三四万字，**核心指令散落在全文各处**——截到三千字，
 * 剩下的 93% 就没了，用户下载了什么等于白下。
 *
 * 用户的实卡就是这种：`people/dp4.1破甲优化.card.md` 自述 45262 字符，
 * 以前进酒馆提示词只剩 3201 字符。模型拿到的是半截话，当然不认。
 *
 * 六万四够放下绝大多数这类卡（用户那张 45262 字符的实卡就正好放得下）；
 * 再长的继续截——超过这个量，光系统提示就要吃掉几万 token，
 * 历史对话会被挤得没地方了。
 */
export const MAX_PROMPT_PERSONA_CHARS = 64000

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

/**
 * 抽一致性锚点时按这个顺序看小节。
 *
 * 边界排在前面：长对话里的漂移，最先坏的不是长相，是嘴上——它开始说这个人
 * 说过不会说的话。外貌放最后，抽得到就抽，抽不到也不影响它像不像。
 * 「底线」不在 `PERSONA_SECTIONS` 里（那张表管的是整段人设的拼法），
 * 但人自己写的卡常用这个标题，所以这里单独认一下。
 */
const ANCHOR_SECTIONS = ['不会说的话', '不会做的事', '底线', '外貌', '口癖']

/** 会话相对路径。id 过 safeId，`../` 这类东西进不来。 */
export function chatRelPath(id) {
  return path.posix.join(CHAT_DIR, `${core.safeId(id)}.md`)
}

/**
 * 造一个新会话 id：`chat-20261024-1610-ab12cd`。用本地时间，用户看得懂。
 *
 * 末尾那截随机的以前只有 4 位（36⁴≈168 万）。同一个分钟里连开两场
 * ——点「开一场」再退回首页点另一张卡，几秒钟的事——就有万分之几的
 * 机会撞上，撞上之后 `writeChat` 是整文件覆盖：**新开的这一场把上一场
 * 吃掉了**，用户那边看到的是「刚聊的那场不见了」。所以：
 *   1. 随机位加到 6 位（36⁶≈21 亿）；
 *   2. 新增 `uniqueChatId`，写盘前真去问一句「这个名字有主了吗」。
 *
 * @param {Date} now
 * @param {string} [rand] 只有测试会传，用来固定随机那截
 */
export function newChatId(now = new Date(), rand) {
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  const tail = typeof rand === 'string' && rand !== '' ? rand : Math.random().toString(36).slice(2, 8).padEnd(6, '0')
  return `chat-${stamp}-${tail}`
}

/**
 * 造一个**确实还没人用**的会话 id。
 *
 * `newChatId` 只是算一个名字，它不知道这个名字有没有被占。开新会话、
 * 掰新世界线这两处都要落盘，落盘前必须问这一句——否则同一分钟里的
 * 第二场会把第一场覆盖掉（`writeChat` 是先写 tmp 再 rename，rename
 * 到已存在的路径就是**静默覆盖**，一步都不会报错）。
 *
 * 试 32 次还撞（那基本只能是随机源坏了），退到时间戳兜底，保证一定
 * 拿得到不重复的名字，不让用户丢会话。
 *
 * @param {string} root 工作区
 * @param {Date} [now]
 * @returns {Promise<string>}
 */
export async function uniqueChatId(root, now = new Date()) {
  for (let i = 0; i < 32; i += 1) {
    const id = newChatId(now)
    const at = await store.resolveIn(root, chatRelPath(id))
    if (!at.ok) continue
    try {
      await fs.access(at.abs)
    } catch {
      return id
    }
  }
  // 兜底：随机源不行的时候，靠毫秒数保证不同。形状不变，一样能过 safeId。
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
  return `chat-${stamp}-${Date.now().toString(36).slice(-6)}`
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
  // 先把「真要写进正文的」那几条挑出来，再拿它们的长度写进 frontmatter。
  //
  // 以前是两处各算各的：frontmatter 的 `turns:` 取的是传进来那个数组的长度，
  // 正文却把「说话人是空」和「正文是空」的条跳过了。会话里只要有一条空壳，
  // 文件头上就写着 5、正文里只有 4 段，用户数一遍对不上，会以为丢了一句。
  const list = (Array.isArray(turns) ? turns : [])
    .map((turn) => ({ who: String(turn?.who ?? '').trim(), text: String(turn?.text ?? '').trim() }))
    .filter((turn) => turn.who !== '' && turn.text !== '')
  const head = { lifecard: '0.1', kind: 'chat', ...data, turns: list.length }
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
  for (const turn of list) {
    lines.push(`### ${turn.who}`, '', escapeLines(turn.text), '')
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

/**
 * 读一个会话。
 *
 * 读不出来要分清是哪一种：文件不在了是一种，文件在但没权限 / 磁盘出错是
 * 另一种。以前一律说「这个会话不在了」，用户以为记录被删了就不再找了——
 * 其实那份文件好好躺在那儿，只是没读到。
 */
export async function readChat(root, id) {
  const rel = chatRelPath(id)
  const at = await store.resolveIn(root, rel)
  if (!at.ok) return { ok: false, error: at.error }
  let text
  try {
    text = await fs.readFile(at.abs, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, error: '这个会话不在了' }
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      return { ok: false, error: '这个会话读不出来：没有读它的权限。到系统设置里给这个文件夹开一下权限，再试一次。' }
    }
    return { ok: false, error: '这个会话读不出来。文件还在，可能是磁盘或同步盘出了问题，过一会儿再试一次。' }
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
    if (error?.code === 'ENOENT') return { ok: true, items: [], bad: 0, badIds: [] }
    if (error?.code === 'ENOTDIR') return { ok: false, error: '「chats」这个位置上放的是别的东西，不是文件夹' }
    return { ok: false, error: '会话列表读不出来。检查一下文件夹权限。' }
  }
  const items = []
  let bad = 0
  // 光给一个数字，用户只知道「有几场读不出来」，却没法去找是哪几场——
  // 那几份文件还躺在 chats/ 里，他连文件名都不知道就只能一个个试。
  const badIds = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const id = name.slice(0, -'.md'.length)
    const got = await readChat(root, id)
    if (got.ok !== true) {
      bad += 1
      badIds.push({ id, error: String(got.error ?? '') })
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
      // 一场开了、却一句话都没说过的会话：文件在，正文是空的。
      // 光看「0 句」用户会以为记录被吃了；列表要把这两种情况分开说。
      empty: turns.length === 0,
      last: typeof last?.text === 'string' ? last.text.slice(0, 60) : '',
    })
  }
  items.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
  return { ok: true, items, bad, badIds }
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
export function personaFromCard(data, sections, names = {}) {
  const parts = []
  const name = String(data?.name ?? '').trim()
  // 卡上的 {{char}}、{{user}} 要换成真名字再进提示词。留着花括号的话，
  // 模型读到的是「一份没渲染的模板」，不是「这个人」——这是它退出来评论
  // 「这是设定」的第一条理由。填法和系统提示那边共用 cardtext，口径一致。
  const fill = { char: name, user: String(names?.user ?? '') }
  for (const title of PERSONA_SECTIONS) {
    const raw = sectionOf(sections, title)
    if (raw === '' || raw === '_（还没写）_') continue
    const body = cardtext.shapeCardBody(raw, fill)
    if (body === '') continue
    parts.push(`【${title}】\n${body}`)
  }
  // 上限分两档。判断依据只有一条：卡里除了「自述」还有没有人物细节。
  // 有（性格/外貌/口癖/边界/关系史任一有正文）＝正常人物卡，三千字足够，
  //   贴太多会把世界书和记忆挤掉。
  // 没有、而且自述很长 ＝ 提示词型卡（网上下载的破限卡、规范卡），
  //   整份正文就是硬规则，核心指令散在全篇，截到三千字等于没下这张卡。
  // 判据只有一处：`core.cardIsPromptStyle`。这里以前自己写了一份
  // （多一个 `truncated === false`，细节小节只看 PERSONA_SECTIONS），和
  // `lib/index.js` 那份口径不同——同一张卡在「酒馆门里说话」和「宿主会话
  // 装配系统提示」会被判成不同类型，走两条不同的提示词形状。用户看到的是
  // 「同一张卡，换个地方就不灵」，实际上只是两个函数没对齐。
  const promptStyle = core.cardIsPromptStyle(sections)
  const cap = promptStyle ? MAX_PROMPT_PERSONA_CHARS : MAX_PERSONA_CHARS
  let text = parts.join('\n\n')
  if (text.length > cap) text = `${text.slice(0, cap)}…`
  const truncated = parts.join('\n\n').length > cap
  // 提示词型卡不包小节标题。
  //
  // `【自述】` 这个抬头是在说「下面这些是某个人讲自己」。可这类卡的正文
  // 全是写给模型的硬规则（`MANDATORY`、`17 WORDS MAX PER LINE`），
  // 一包上就变成「有个人，他的自述是一串命令」——模型读到这儿会先辨出
  // 「这是一份提示词」，然后开始评论它、或者只挑几条执行。
  // 原样贴上去，它读到的就是规矩本身。
  if (promptStyle) {
    const raw = sectionOf(sections, '自述')
    text = cardtext.shapeCardBody(raw, fill)
  }
  return { name, text, truncated, cap, promptStyle }
}

/** 卡上的开场白（有就返回，没有返回空串）。 */
export function greetingOf(sections) {
  for (const title of GREETING_SECTIONS) {
    const body = sectionOf(sections, title)
    if (body !== '' && body !== '_（还没写）_') return body
  }
  return ''
}

/** 锚点最多几条。再多就成了一整段人设，反而记不住。 */
export const MAX_ANCHORS = 5

/**
 * 抽「你是谁」的短锚点：卡上最不该漂的那几行。
 *
 * 为什么要单独抽一遍：`personaFromCard` 已经把整份正文塞进系统提示了，
 * 但那是几千字的连续文本，说到第二十轮，模型脑子里剩下的是「最近谁说了什么」，
 * 不是「我是谁」。锚点是把卡上最硬的那几句再抄一遍，抄成三五行，
 * 摆在离它开口最近的地方（见 `buildRoleplaySystem` 与 `buildRoleplayUser`）。
 *
 * 取哪几节、按什么顺序：边界（不会说的话 / 不会做的事 / 底线）优先于外貌——
 * 漂移最明显的表现不是「长得不对」，是「说了他不会说的话」。
 * 每节只取第一个非空行：那一行通常是这一节的标题句，后面的例子是它的注脚。
 *
 * @param {object} parsed 「不会说的话」等小节读不到时用的原始解析结果（可空）
 * @param {Array<{title: string, body: string}>} sections 卡的正文小节
 * @param {string} fallbackName 一条都抽不到时用的名字（卡名）
 * @param {{name?: string}} [data] 卡 frontmatter，`data.name` 也当一条兜底
 * @returns {string[]} 0 到 5 条，每条一行、已去掉列表符号
 */
export function anchorsFromCard(parsed, sections, fallbackName, data) {
  const list = Array.isArray(sections) ? sections : []
  const out = []
  const name = String(data?.name ?? fallbackName ?? '').trim()
  for (const title of ANCHOR_SECTIONS) {
    const body = String(core.sectionBody(list, title) ?? '').trim()
    if (body === '' || body === '_（还没写）_') continue
    for (const raw of body.split('\n')) {
      // 去掉列表符号、引用符号、标题井号：这些是排版，念出来不像话。
      const line = String(raw).replace(/^\s*(?:[-*+]\s+|>\s*|#{1,6}\s+)/, '').trim()
      if (line === '') continue
      out.push(line)
      break
    }
    if (out.length >= MAX_ANCHORS) break
  }
  if (out.length === 0) {
    // 抽不到就退到名字。名字本身也是一条锚点：至少别把自己叫成别的。
    const label = name !== '' ? name : String(fallbackName ?? '').trim()
    if (label !== '') out.push(`你就是「${label}」。`)
  }
  return out.slice(0, MAX_ANCHORS)
}

/** 世界书最多往外带几层：直接命中的算第 1 层，被已带上条目引出来的算第 2 层。再多会串成一整本。 */
export const MAX_WORLD_DEPTH = 2

/** 一条世界书条目的触发词。兼容 ST 的两种写法：`keys: [a, b]` 与 `keys: "a, b"`。 */
function worldEntryKeys(entry) {
  const raw = entry?.keys ?? entry?.key ?? []
  return (Array.isArray(raw) ? raw : String(raw).split(/[,，]/))
    .map((k) => String(k).trim().toLowerCase())
    .filter((k) => k !== '')
}

/**
 * 挑这一轮该带上的世界书条目。
 *
 * 比原来多两件事（借的是酒馆那边「递归触发」的做法，代码自己重写）：
 *   1. 已经带上的条目，正文里提到了别的条目的触发词，就把那个也带上，最多再往外一层；
 *   2. 按「常驻 → 直接命中 → 被带出来的」排队，一条一条塞进字数上限，
 *      塞不下的跳过但继续试后面更短的——不再因为前面一条太长就整批丢掉。
 */
export function pickWorldEntries(entries, recentText, options = {}) {
  const budget = Number.isFinite(options?.budget) && options.budget > 0 ? options.budget : MAX_WORLD_CHARS
  const depth = Number.isFinite(options?.depth) && options.depth >= 0 ? options.depth : MAX_WORLD_DEPTH
  const hay = String(recentText ?? '').toLowerCase()
  const list = []
  const all = Array.isArray(entries) ? entries : []
  for (let index = 0; index < all.length; index++) {
    const entry = all[index]
    const content = String(entry?.content ?? '').trim()
    if (content === '') continue
    const keys = worldEntryKeys(entry)
    list.push({
      index,
      content,
      keys,
      constant: entry?.constant === true || entry?.always === true || keys.length === 0,
      order: Number.isFinite(entry?.order) ? Number(entry.order) : 100,
    })
  }
  const picked = new Map()
  let wave = []
  for (const item of list) {
    if (item.constant) {
      picked.set(item.index, { item, level: 0 })
      wave.push(item)
    } else if (hay !== '' && item.keys.some((k) => hay.includes(k))) {
      picked.set(item.index, { item, level: 1 })
      wave.push(item)
    }
  }
  // 往外走的那一层只在「最近确实说过话」时走：刚开场没有上下文，
  // 就不该把整本世界书一次倒进去。
  let level = 1
  while (hay !== '' && wave.length > 0 && level < depth) {
    const batch = wave
    wave = []
    level += 1
    for (const from of batch) {
      const body = from.content.toLowerCase()
      for (const item of list) {
        if (picked.has(item.index) || item.constant) continue
        if (item.keys.some((k) => body.includes(k))) {
          picked.set(item.index, { item, level })
          wave.push(item)
        }
      }
    }
  }
  const ordered = [...picked.values()].sort((a, b) => (a.level - b.level) || (a.item.order - b.item.order) || (a.item.index - b.item.index))
  const chosen = []
  let used = 0
  for (const { item } of ordered) {
    if (used + item.content.length > budget) continue
    chosen.push(item.content)
    used += item.content.length
  }
  return chosen
}

/** 命中少于几条就退回整本。2 是「至少真有两处对上了」的意思，少于它说明这把关键词没捞到东西。 */
export const MIN_WORLD_HITS = 2

/**
 * 按关键词挑条目——只认「这段说的话里提到了它的触发词」，外加 `options.always` 点名的常驻条。
 *
 * 和 `pickWorldEntries` 的分工：
 *   `pickWorldEntries` 交的是**拼好的一段正文**（带预算、带往外一层的递归）；
 *   这个函数交的是**条目本身**（`{index, entry, level}`）外加漏了几条。
 *   调用方要自己决定怎么排、要不要退回整本，所以不能只给一段字符串。
 *
 * 为什么要有：卡配了一本大世界书时，整本塞进系统提示，一半是跟这一轮无关的条目，
 * 模型会抓错重点——它看到十条设定，就会想十条都用上。
 *
 * @param {Array<object>} entries `core.parseWorldEntries` 的结果
 * @param {string} text 拿来做检索的文字（这一轮最近几句）
 * @param {{always?: Array<object|number>}} [options] `always` 里的条目永远带上：
 *   世界书里那些「总纲」类条目（这座城什么样、这家人怎么过日子）没有触发词，
 *   或者有触发词但每一轮都该在场。
 * @returns {{hits: Array<{index: number, entry: object, level: number}>, missed: number}}
 */
export function pickWorldEntriesByText(entries, text, options = {}) {
  const all = Array.isArray(entries) ? entries : []
  const hay = String(text ?? '').toLowerCase()
  const always = new Set()
  for (const one of Array.isArray(options?.always) ? options.always : []) {
    // 两种写法都收：给下标，或者直接给条目对象（调用方手上通常只有列表，没有下标）。
    if (Number.isInteger(one) && one >= 0 && one < all.length) always.add(one)
    else {
      const at = all.indexOf(one)
      if (at >= 0) always.add(at)
    }
  }
  const hits = []
  let missed = 0
  for (let index = 0; index < all.length; index++) {
    const entry = all[index]
    const content = String(entry?.content ?? '').trim()
    if (content === '') continue
    const keys = worldEntryKeys(entry)
    // 没有触发词的条目按常驻处理：作者写它的时候就没打算靠关键词触发
    // （和 pickWorldEntries 同一口径，两处不能对不上）。
    const forced = always.has(index) || entry?.constant === true || entry?.always === true || keys.length === 0
    if (forced) {
      hits.push({ index, entry, level: 0 })
      continue
    }
    if (hay !== '' && keys.some((k) => hay.includes(k))) hits.push({ index, entry, level: 1 })
    else missed += 1
  }
  return { hits, missed }
}

/** 退回整本时放宽到三倍：退是为了不漏设定，不是为了把整本倒进去把它撑爆。 */
export const MAX_WORLD_CHARS_FALLBACK = MAX_WORLD_CHARS * 3

/**
 * 这一轮的世界书该怎么摆：先按关键词挑，挑到的太少就退回整本。
 *
 * 「太少」的判据是 `MIN_WORLD_HITS`。为什么退回的是**整本**而不是「就这两条」：
 * 漏一条设定的代价是这一轮它说错话、用户得回头纠正；多给几条的代价只是提示词长一点。
 * 两边不对称，所以宁可多给。
 *
 * 每一条前面加编号，是为了让末尾那句「按上面第 N 条来」指得着东西。
 * 编号只用阿拉伯数字加点，**不加「关键词：」这类标签**——模型看到索引式写法
 * 会认定这是一份参考资料，而不是自己身处的世界（`worldEntriesText` 那段注释记的就是这一条）。
 *
 * @returns {{notes: string[], hint: string, count: number, missed: number, fellBack: boolean}}
 */
export function worldNotesForTurn(entries, text, options = {}) {
  const all = (Array.isArray(entries) ? entries : [])
    .filter((entry) => String(entry?.content ?? '').trim() !== '')
  const picked = pickWorldEntriesByText(all, text, options)
  const minHits = Number.isFinite(options?.minHits) && options.minHits >= 0 ? options.minHits : MIN_WORLD_HITS
  const fellBack = picked.hits.length < minHits
  const shown = fellBack ? all.map((entry, index) => ({ index, entry, level: 0 })) : picked.hits
  const budget = fellBack ? MAX_WORLD_CHARS_FALLBACK : MAX_WORLD_CHARS
  const notes = []
  let used = 0
  for (const hit of shown) {
    const content = String(hit.entry?.content ?? '').trim()
    if (content === '') continue
    // 塞不下的跳过，继续试后面更短的——不因为前面一条太长就整批丢掉。
    if (used + content.length > budget) continue
    notes.push(`${notes.length + 1}. ${content}`)
    used += content.length
  }
  return { notes, hint: worldRefHint(notes.length), count: notes.length, missed: picked.missed, fellBack }
}

/**
 * 世界书末尾那句「说到相关的事就按上面第 N 条来」。
 *
 * 只在真的摆了条目时给（0 条时返回空串）：没有编号还叫它「按第 N 条」，
 * 它只会去找一个不存在的清单。
 */
export function worldRefHint(count) {
  const n = Number.isFinite(count) ? Math.trunc(count) : 0
  if (n <= 0) return ''
  const where = n <= 4 ? `第 ${Array.from({ length: n }, (_, i) => i + 1).join('、')} 条` : `第 1 到 ${n} 条`
  return `（说到相关的事，就按上面${where}来。）`
}

/**
 * 想事情的时候该怎么想。
 *
 * 这一段借的是 cosplay 插件的做法（它那边注释把出处写在
 * `deepseek_v4_rolepaly_instruct`）。原理很直白：模型先想再说。
 * 如果它在思考里把自己当「一个正在扮演别人的助手」，那层视角会漏到
 * 输出里——说着说着退出来评论一句「这是设定」，用户看到的就是「被识破了」。
 * 让思考也用这个人的第一人称，整段才会一以贯之。
 *
 * 只在系统提示里出现，永不进会话记录，界面上也看不到。
 */
export const THINKING_DIRECTIVES = {
  /**
   * 沉浸档：思考也锁进这个人。默认用这一档。
   */
  role: [
    '【想的时候也一样】',
    '- 你就是这个人。心里想事情也用这个人的第一人称，不要在心里管自己叫「角色」「人设」「模型」。',
    '- 不要在心里先过一遍「用户想要什么」「我该怎么扮演」这类话。你要是这个人，你只是在想怎么接这句话。',
    '- 想清楚这一刻该做什么、说什么，然后直接说。',
  ].join('\n'),

  /**
   * 中性档：思考归思考，说话归说话。
   *
   * 为什么要有第二档而不是只有「开/关」：关掉之后模型在思考里没有任何约束，
   * 它爱怎么写怎么写，于是又回到「想着想着开始评论这段剧情」的老路；开着的
   * 那一档则有另一个毛病——某些习惯写分析的模型会把括号内心戏漏进正文，
   * 用户看到回答里冒出「（心想：她大概是想走了）」。
   *
   * 这一档是一组**逐条禁止**同一批字面特征的负向指令（借 cosplay 插件的写法）：
   * 不准圆括号独白、不准「我心想」、不准在思考里演内心戏。思考里做的是
   * 「这一刻该说什么」的规划，不是内心独白。这样既不会跳出角色去评论，
   * 也不会把内心戏漏到回答里。
   */
  neutral: [
    '【想的时候】',
    '- 不要在思考里写内心独白，不要用圆括号包一段心里话（「（心想：……）」这类）。',
    '- 不要在思考里用这个人的第一人称描述心情（「我心里一沉」「我暗自」这类），换成直接说清这一刻该做什么、说什么。',
    '- 不要在心里管自己叫「角色」「人设」「模型」，也不要在心里先过一遍「用户想要什么」——你要是这个人，你只是在想怎么接这句话。',
    '- 想清楚这一刻该做什么、说什么，然后直接说。',
  ].join('\n'),
}

/** 默认那一档。老代码和导出表还按这个名字取，取到的就是 `role`。 */
export const THINKING_DIRECTIVE = THINKING_DIRECTIVES.role

/** 这两档是界面上能选的全部。`off` 不是一种档位，是「不加这一段」。 */
export const THINKING_STYLES = ['role', 'neutral']

/**
 * 按设置拼出思考那一段。关掉（`thinking === false`）就返回空串，
 * 认不出的档位退回 `role`。
 */
export function thinkingBlock(thinking, thinkingStyle) {
  if (thinking === false) return ''
  const key = THINKING_STYLES.includes(String(thinkingStyle)) ? String(thinkingStyle) : 'role'
  return THINKING_DIRECTIVES[key]
}

/**
 * 拼「你是谁」那一段系统提示。
 *
 * 2026-11 改过一版，改的是第一句。以前是
 *   「你正在演一个角色扮演对话。你只演「X」这一个人，对方是「我」。」
 * 这句技术上没错，但它把模型放在**扮演者**的位置上：卡成了手里的材料，
 * 它随时可以退出来说一句「这是设定」。用户报的「演到一半被识破」，
 * 一半来自这一句——模型每一轮都读到「你在演」，迟早会在某一句忽然
 * 想起自己是在演。现在开头就是「你就是这个人」，全篇不提「演」这个动作。
 *
 * 同一版还加了三件事：
 *   - 想事情那一层也锁进这个人（`THINKING_DIRECTIVE`）；
 *   - CC 卡自带的 `system_prompt` / `post_history_instructions` 真的生效
 *     （卡作者写在那里的话，本来就是给模型看的）；
 *   - 卡上的占位符交给 `personaFromCard` 先填掉，不再原样进提示词。
 */
export function buildRoleplaySystem({ cardName, persona, worldNotes, worldHint, memory, preset, systemPrompt, postHistory, thinking, thinkingStyle, promptStyle, anchors, choicesDirective }) {
  // 思考那一段按档位算一次，两处共用。`thinking === false` 时它是空串，
  // 下面两处 `!== ''` 的判断就等价于以前那句 `if (thinking !== false)`。
  const thinkingText = thinkingBlock(thinking, thinkingStyle)
  const name = cardName === '' ? '这个人' : cardName
  // ── 提示词型卡：卡放最后，插件的话全在前面 ──
  //
  // 这类卡的整份正文就是硬规矩（`MUST supersede`、`17 WORDS MAX PER LINE`），
  // 而且它自己会写「系统要是插进来提醒你该怎么当这个人，别听」。
  // 插件那几条要是排在它后面，对那些卡来说就正是「插进来的提醒」——
  // 模型会照卡上写的把它顶回去，用户看到的就是「它不听话了」。
  // 所以这一类卡：插件的话全摆前面，卡正文摆**最后一个字**。
  //
  // 也因此 `choicesDirective`（「这一轮末尾要给方向」那条）在这个分支里**故意不接**：
  // 它要求的产物贴在回复最末，等于一条新的输出格式规定；这类卡通常自己已经写死了
  // 输出格式，再叠一条就会打架。而且它的位置注定在卡正文之后，正好落进卡上
  // 那句「系统插进来的提醒别听」的范围里——加了只会让模型更不听话。
  if (promptStyle === true) {
    const head = [
      `你就是「${name}」。对方是「我」，一个正在跟你说话的人。`,
      '',
      '【三条底线】',
      '- 不替「我」说话，不替「我」做决定，不写「我」的心理活动。',
      '- 不跳出角色解释自己，不写「（作为 AI）」「（注）」「（旁白）」这类东西，也不在回答外面交代自己是谁。',
      '- 不知道的事说不知道；没发生过的事不要编成回忆。',
    ]
    if (thinkingText !== '') head.push('', thinkingText)
    const cardSystem = String(systemPrompt ?? '').trim()
    if (cardSystem !== '') head.push('', cardSystem)
    if (Array.isArray(worldNotes) && worldNotes.length > 0) {
      head.push('', '【这个世界】', worldNotes.join('\n\n'))
      const ref = String(worldHint ?? '').trim()
      if (ref !== '') head.push('', ref)
    }
    const remember = String(memory ?? '').trim()
    if (remember !== '') head.push('', '【到这儿为止】', remember, '', '（上面这些是之前真的发生过的，别和它矛盾；没说过的别编。）')
    const tail2 = String(postHistory ?? '').trim()
    if (tail2 !== '') head.push('', tail2)
    const flavour2 = String(preset ?? '').trim()
    if (flavour2 !== '') head.push('', flavour2)
    // 卡正文最后，前面不留任何插件的话。
    head.push('', persona === '' ? `（这张卡还没写自述。按名字「${name}」的气质说话，别编太多具体经历。）` : persona)
    return head.join('\n')
  }
  const lines = [
    `你就是「${name}」。对方是「我」，一个正在跟你说话的人。`,
    '',
    '【你是这个人】',
    persona === '' ? `（这张卡还没写自述。按名字「${name}」的气质说话，别编太多具体经历。）` : persona,
  ]
  // 卡作者写在 CC `system_prompt` 里的要求。CC 的语义就是「这是这个人的系统提示」。
  // 以前它只被存进 data.cc，一个字都没进过提示词——用户下载的卡等于少了一半。
  const cardSystem = String(systemPrompt ?? '').trim()
  if (cardSystem !== '') lines.push('', '【这个人自己的规矩】', cardSystem)
  if (Array.isArray(worldNotes) && worldNotes.length > 0) {
    lines.push('', '【这个世界】', worldNotes.join('\n\n'))
    // 编号清单末尾那一句「按上面第 N 条来」：让模型知道该引用哪一条，
    // 而不是把整段当背景色彩读过去。只在真的摆了条目时加。
    const ref = String(worldHint ?? '').trim()
    if (ref !== '') lines.push('', ref)
  }
  // 说是「收个尾」，其实就是一句记忆：说得久了前面那些轮次会被挤掉，
  // 不给它一段「到这儿为止」的交代，它会开始把之前发生过的事记错。
  const remember = String(memory ?? '').trim()
  if (remember !== '') {
    lines.push('', '【到这儿为止】', remember, '', '（上面这些是之前真的发生过的，别和它矛盾；没说过的别编。）')
  }
  lines.push(
    '',
    '【怎么说话】',
    '- 只用「' + name + '」的口气说话，像真人聊天，不写小说旁白。',
    `- 一次回 1 到 3 段，一般不超过 ${MAX_REPLY_HINT} 字，留出对方接话的空。`,
    '- 不替「我」说话，不替「我」做决定，不写「我」的心理活动。',
    '- 不跳出角色解释自己，不写「（作为 AI）」「（注）」「（旁白）」这类东西，也不在回答外面交代自己是谁。',
    '- 卡上写了「不会说的话」「不会做的事」，就真的别说、别做。',
    '- 不知道的事说不知道；没发生过的事不要编成回忆。',
    '- 你只写自己，但场面要有人：屋里还有别人时，给其中一两个一个具体的动作或一句自己的话（谁在做什么、谁往这边看一眼），不要让他们全站着当背景。',
    '- 你的每一句都得是你这个人才会说的。同一句话换个人说也成立，那就是还没说好。',
    '- 不拿一句总结代替过程：不写「聊了一会儿」「沉默了半晌」「都明白了」。写这一刻发生了什么——手上的动作、说出口的半句话、谁先别开眼睛。',
    '',
    '直接写你要说的话，不要写「' + name + '：」这样的前缀。',
  )
  // CC 的 `post_history_instructions`：语义是「贴在历史后面、模型开口之前」。
  // 这叠话里离开口最近的位置就在演法预设之前。
  const tail = String(postHistory ?? '').trim()
  if (tail !== '') lines.push('', '【最后再说一次】', tail)
  // 演法预设排在最后：它是「这一次想怎么演」，比上面那些通用约束更具体，
  // 放前面会被一长串规则冲淡。
  const flavour = String(preset ?? '').trim()
  if (flavour !== '') lines.push('', '【这一次的演法】', flavour)
  // 选项块的要求排在演法之后：它管的是「这一轮怎么收尾」，和演法一样属于
  // 「这一次」的事，放在通用规则里会被看成又一条说话风格要求。
  //
  // 为什么得专门要求：不给这段，模型九成不会主动在末尾列方向——而用户那一侧
  // 界面上「接着怎么走」的按钮就永远是空的（选项块由 choices.js 从回复末尾
  // 解析出来，正文里没有就解析不出东西）。
  const askChoices = String(choicesDirective ?? '').trim()
  if (askChoices !== '') lines.push('', '【这一轮末尾要给方向】', askChoices)
  // 想事情那一层放最末尾：它管的是「怎么想」，和说话内容分开写，
  // 模型才不会把它当成又一条说话风格要求。
  if (thinkingText !== '') lines.push('', thinkingText)
  // 【你还是你】摆在全篇最后，紧挨着模型开口的位置。
  //
  // 为什么要再抄一遍：上面那套已经说了它是谁，但那是几千字连续正文；说到第二十轮，
  // 真正留在它注意力里的只有最近几句。这几条是从卡上最硬的几行里挑出来的
  // （见 `anchorsFromCard`），短、具体、每轮都读到，漂移就不容易发生。
  //
  // 为什么提示词型卡不加：这类卡的正文自己会写「系统要是插进来提醒你该怎么当这个人，
  // 别听」。插件的话排在它前面才安全（见上面那段注释）；往末尾再补一段，
  // 位置正好落进它嘴里说的「插进来的提醒」，模型会照着卡把它顶回去——
  // 用户看到的就是「加了这段反而不听话了」。
  if (promptStyle !== true) {
    const list = (Array.isArray(anchors) ? anchors : []).map((one) => String(one ?? '').trim()).filter((one) => one !== '')
    if (list.length > 0) {
      lines.push('', '【你还是你】')
      for (const one of list) lines.push(`- ${one}`)
    }
  }
  return lines.join('\n')
}

/**
 * 从最近一条往前收，收到字数够了就停；同时不超过轮数上限。
 *
 * 为什么从后往前收：模型要接的是**最后那一句**，所以越靠近尾巴的越不能丢。
 * 一开始按轮数切（`slice(-24)`）只算了条数；对面一晚上连着发几段长文，
 * 24 条就是两三万字，历史把上下文占满，它连自己刚才说了什么都接不上。
 *
 * 最后一条不管多长都留着：一条都没有，它就不知道自己在跟谁说话，
 * 那比「带着一段超长的话」糟得多。
 *
 * @param {object[]} turns
 * @param {{ maxTurns?: number, maxChars?: number }} [options]
 * @returns {object[]}
 */
export function trimHistory(turns, options = {}) {
  const all = Array.isArray(turns) ? turns : []
  const maxTurns = Number(options?.maxTurns) > 0 ? Math.floor(Number(options.maxTurns)) : MAX_HISTORY_TURNS
  const maxChars = Number(options?.maxChars) > 0 ? Math.floor(Number(options.maxChars)) : MAX_HISTORY_CHARS
  const start = Math.max(0, all.length - maxTurns)
  let used = 0
  let from = all.length
  for (let i = all.length - 1; i >= start; i -= 1) {
    const one = all[i]
    // 说话人的名字也算字：24 条「（很长的一串头衔）：」叠起来也不是小数。
    const size = String(one?.text ?? '').length + String(one?.who ?? '').length
    if (used + size > maxChars && from < all.length) break
    used += size
    from = i
  }
  return all.slice(from)
}

/**
 * 拼这一轮发给模型的话：最近几轮对话 + 最后那一句。
 *
 * 历史只带最近几轮；条数管时间跨度，字数管这一轮还能剩多少地方给它开口。
 */
export function buildRoleplayUser({ cardName, turns, anchors }) {
  const name = cardName === '' ? '这个人' : cardName
  const recent = trimHistory(turns)
  // 这两句以前是「请『X』先说一句话」「现在轮到『X』接着说。只写『X』会说的话」。
  // 那是**写作者**的口气：它把模型放到「我在替这个人写台词」的位置上，
  // 于是模型随时可以退出来想「我该怎么写这段」。整份提示词里别的都改成
  // 第一人称了，就剩这一句还在按第三人称说话——而它偏偏是开口前读到的
  // 最后一行。用户报的「演着演着忽然变成旁白腔」，一半来自这里。
  if (recent.length === 0) return '该你先开口。说一句话，把场面打开。'
  const lines = ['下面是刚才的对话：', '']
  for (const turn of recent) {
    lines.push(`${turn.who === '我' ? '我' : turn.who}：${turn.text}`)
    lines.push('')
  }
  // 开口前最后一眼：它自己最硬的那条。系统提示里已经有一整节，但历史越长，
  // 系统提示离得越远；这一句话就在它要开口的下一行，中间不隔任何东西。
  const first = (Array.isArray(anchors) ? anchors : []).map((one) => String(one ?? '').trim()).find((one) => one !== '')
  if (first !== undefined) lines.push(`（你是「${name}」：${first}）`)
  lines.push('该你开口了。用你自己的口气说下去——是说话，不是描述。')
  return lines.join('\n')
}

/**
 * 这一场该不该收个尾了。
 *
 * 只是提示，不替人做决定：说长不长、说短不短的时候最好收——再往下，
 * 最早那几句就进不了提示词了，后面演着演着就接不上前面的约定。
 *
 * 不到 MIN_TURNS_TO_SUMMARIZE 句不提这件事：三五句就说「该收尾了」，
 * 等于催人别聊了。
 */
export function summarizeHint(turns) {
  const n = Array.isArray(turns) ? turns.length : 0
  if (n < MIN_TURNS_TO_SUMMARIZE) return ''
  if (n <= MAX_HISTORY_TURNS * 1.5) return ''
  return `已经 ${n} 句了，最早的十来句下一条就带不上了。这会儿收个尾，把发生过的事记下来，后面才不会忘。`
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

/**
 * 从第几句掰开。
 *
 * `at` 是「保留到第几句」（从 0 数）。给得不合适就夹回合法范围：
 * 掰出来的一定至少有第一句，也一定不是空的。
 *
 * 只规范 `who`/`text` 两个字段，**其余字段原样带过去**。这个函数以前把每条
 * 重建成了 `{who, text}`：人物卡会话里暂时没别的字段，看不出问题；可
 * `turns` 这个形状不只酒馆在用（面试台账也往里写 `better`），从中间掰一条
 * 线出来，那些字段就在这一步被削掉了，而调用方拿到的是一个「成功」的
 * 新会话——丢的东西不会报错，等用户回去看才发现改过的答案没了。
 */
export function branchTurns(turns, at) {
  const list = Array.isArray(turns) ? turns : []
  if (list.length === 0) return []
  const wanted = Number.isInteger(at) ? at : list.length - 1
  const cut = Math.max(0, Math.min(wanted, list.length - 1))
  return list
    .slice(0, cut + 1)
    .map((turn) => ({ ...turn, who: String(turn?.who ?? ''), text: String(turn?.text ?? '') }))
}

/**
 * 重来一次之前，先把「TA 说的最后一句」摘掉，「我说的」留着。
 *
 * 为什么不在这里顺手把模型也调了：`tavern.say` 在正文为空时本来就是
 * 「让 TA 接着说」。重生成走同一条路，就不必养第二份拼提示词的代码——
 * 两份一定会慢慢长歪，其中一份还会因为没人看而烂在角落里。
 */
export function dropTrailingReply(turns) {
  // 和 `branchTurns` 同一个道理：只改 `who`/`text`，别的字段留着。
  const list = (Array.isArray(turns) ? turns : [])
    .map((turn) => ({ ...turn, who: String(turn?.who ?? ''), text: String(turn?.text ?? '') }))
  while (list.length > 0 && list[list.length - 1].who !== '我') list.pop()
  return list
}

/** 本地时间戳，和会话 id 用同一套口径（用户看得懂）。 */
function stampNow(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/**
 * 把一场会话从中间掰出一条新的世界线。
 *
 * 原会话一个字节都不动——这一点和「删会话」正好相反，用户点错了也不会丢东西。
 * 备忘（「到这儿为止」）不跟着走：那是另一条世界线上发生过的事，
 * 带过去会让它在新的这一条里记得本没发生过的事。
 */
export async function branchChat(root, id, options = {}) {
  const got = await readChat(root, id)
  if (got.ok !== true) return got
  const turns = branchTurns(got.turns, options?.at)
  if (turns.length === 0) return { ok: false, error: '这一场还没有话，掰不出新的。' }
  // 和开新会话同一套：先问名字有没有人用，再落盘。
  const nextId = await uniqueChatId(root)
  const now = stampNow()
  const data = {
    ...got.data,
    id: nextId,
    branched_from: String(id),
    branched_turn: turns.length,
    created_at: now,
    updated_at: now,
    turns: turns.length,
  }
  const saved = await writeChat(root, nextId, data, turns)
  if (saved.ok !== true) return saved
  return { ok: true, id: nextId, path: saved.path, turns, from: String(id) }
}

export default {
  CHAT_DIR,
  MAX_HISTORY_TURNS,
  MAX_HISTORY_CHARS,
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
  anchorsFromCard,
  MAX_ANCHORS,
  pickWorldEntries,
  pickWorldEntriesByText,
  worldNotesForTurn,
  worldRefHint,
  MIN_WORLD_HITS,
  MAX_WORLD_CHARS_FALLBACK,
  buildRoleplaySystem,
  buildRoleplayUser,
  trimHistory,
  summarizeHint,
  recentContextText,
  MAX_WORLD_DEPTH,
  THINKING_DIRECTIVE,
  THINKING_DIRECTIVES,
  THINKING_STYLES,
  thinkingBlock,
  branchChat,
  branchTurns,
  dropTrailingReply,
}
