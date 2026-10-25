/**
 * game —— 文字小说游戏：进到一本书的某一段情节里，你来选，它来推。
 *
 * 和「写小说」的区别：
 *   写小说 = 一个人写，AI 打下手。
 *   玩 = 你站在书里那个人的位置上，每一次只能做一件事，AI 按你的选择往下推。
 *
 * 所以这一层的核心不是「生成好看的文字」，而是**状态要记住**：
 * 你上一轮选了什么、丢了什么、谁开始不信你了——这些必须写进盘里，
 * 不然它会一边往下推一边把前面的事忘干净。
 *
 * 落盘形状：`books/<书 id>/plays/<存档 id>.md`
 *   frontmatter: id / book / chapter / preset / mode / created_at / updated_at / turn
 *   `## 现在`     —— 当前局面，一句话
 *   `## 手上的`   —— 手里的东西/状态（可以是空的）
 *   `## 剧情`     —— 一轮一轮往下：旁白 + 你选了什么 + 结果
 *
 * 这一层只碰磁盘与文字：不调模型、不碰 HTTP。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import * as core from './core.js'
import { bookRelPath } from './novel.js'

/** 存档放在书的目录底下。 */
export const PLAY_DIR = 'plays'

/** 一局最多推多少轮。到顶不是「不能玩了」，是提示该收尾了。 */
export const MAX_TURNS = 300

/** 带上最近多少轮给模型看。多了会挤掉设定，少了它记不住。 */
export const MAX_HISTORY_TURNS = 18

/** 当前局面那一节的标题。 */
export const SCENE_TITLE = '现在'
/** 手上有什么那一节的标题。 */
export const HOLD_TITLE = '手上的'
/** 剧情流水那一节的标题。 */
export const STORY_TITLE = '剧情'

/** 一局存档的路径。 */
export function playRelPath(bookId, playId) {
  return path.posix.join(bookRelPath(bookId), PLAY_DIR, `${core.safeId(playId)}.md`)
}

/** 新存档 id：`play-20261026-0012-xxxx`。 */
export function newPlayId(now = new Date()) {
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const time = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
  const salt = Math.random().toString(36).slice(2, 6)
  return `play-${stamp}-${time}-${salt}`
}

/**
 * 一局的 Markdown。
 *
 * 用「## 现在」「## 剧情」这种能看懂的小节，不用嵌套列表——
 * 用户想手工改一句局面，在 Finder 里直接改就行。
 */
/**
 * 正文里行首的 `#` 和 `>` 要加反斜杠。
 *
 * 不加的话：模型写出一行 `## 三年前`，读回来时会被当成新的一节，
 * 后面的对话整段被吞掉。这种坏法不会报错，只是内容没了。
 */
function escapeLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => (/^\s*(#{1,6}\s|>)/.test(line) ? line.replace(/^(\s*)/, '$1\\') : line))
    .join('\n')
}

/** 读回来的时候把上面加的反斜杠去掉。 */
function unescapeLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^(\s*)\\([#>])/, '$1$2'))
    .join('\n')
}

/**
 * 玩家自己写的那一段要压成一行。
 *
 * `> 我：...` 只有第一行被这个前缀包住，后面几行是**裸的**：只要续行以 `## `
 * 开头，下一次读回来就会在那一行把「剧情」这一节切断，后面的所有轮次一起消失。
 * 换行压成空格就够了 —— 这一步玩家写的是动作或一句话，不需要多段结构。
 */
function oneLine(text) {
  return String(text ?? '').replace(/[\r\n]+/g, ' ').trim()
}

export function renderPlayMarkdown(data, turns) {
  const head = { lifecard: core.DATA_VERSION, kind: 'play', ...data }
  const lines = ['---']
  for (const [key, value] of Object.entries(head)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'object') continue
    lines.push(`${key}: ${JSON.stringify(String(value))}`)
  }
  lines.push('---', '')
  const scene = String(data?.scene ?? '').trim()
  if (scene !== '') lines.push(`## ${SCENE_TITLE}`, '', scene, '')
  const holding = Array.isArray(data?.holding) ? data.holding.filter((x) => String(x ?? '').trim() !== '') : []
  if (holding.length > 0) lines.push(`## ${HOLD_TITLE}`, '', ...holding.map((h) => `- ${oneLine(h)}`), '')
  lines.push(`## ${STORY_TITLE}`, '')
  for (const turn of Array.isArray(turns) ? turns : []) {
    const kind = String(turn?.kind ?? 'say')
    if (kind === 'narrate') {
      lines.push(escapeLines(String(turn?.text ?? '').trim()), '')
    } else if (kind === 'choose') {
      lines.push(`> 我：${oneLine(turn?.text)}`, '')
      const result = String(turn?.result ?? '').trim()
      if (result !== '') lines.push(escapeLines(result), '')
    } else {
      lines.push(`> 我：${oneLine(turn?.text)}`, '')
      const reply = String(turn?.text2 ?? '').trim()
      if (reply !== '') lines.push(escapeLines(reply), '')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** 反过来：读回一局。 */
export function parsePlayText(text) {
  const parsed = core.parseCard(String(text ?? ''))
  if (parsed.ok !== true) {
    return { ok: false, error: `这一局读不出来：${(parsed.errors ?? []).join('；') || '格式不对'}` }
  }
  const data = parsed.data ?? {}
  const sections = parsed.sections ?? []
  const pick = (title) => sections.find((s) => String(s.title ?? '') === title)
  const scene = String(pick(SCENE_TITLE)?.body ?? '').trim()
  const holding = String(pick(HOLD_TITLE)?.body ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter((line) => line !== '')
  const turns = []
  const body = String(pick(STORY_TITLE)?.body ?? '')
  let pending = ''
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('> 我：')) {
      // 上一段是旁白，收尾；然后开新的选择
      if (pending.trim() !== '') turns.push({ kind: 'narrate', text: unescapeLines(pending.trim()) })
      pending = ''
      turns.push({ kind: 'choose', text: unescapeLines(line.slice('> 我：'.length).trim()), result: '' })
      continue
    }
    const last = turns[turns.length - 1]
    if (last !== undefined && last.kind === 'choose' && last.result === '') {
      last.result = line
    } else {
      pending = pending === '' ? line : `${pending}\n${line}`
    }
  }
  if (pending.trim() !== '') turns.push({ kind: 'narrate', text: unescapeLines(pending.trim()) })
  return { ok: true, data, scene, holding, turns }
}

/** 读一局。 */
export async function readPlay(root, bookId, playId) {
  const rel = playRelPath(bookId, playId)
  let text
  try {
    text = await fs.readFile(path.join(root, rel), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, error: '这一局不在了' }
    return { ok: false, error: '这一局读不出来，检查一下文件夹权限' }
  }
  const got = parsePlayText(text)
  if (got.ok !== true) return got
  return { ok: true, ...got, path: rel }
}

/** 写一局（临时文件 + 改名，掉电不能写坏存档）。 */
export async function writePlay(root, bookId, playId, data, turns) {
  const rel = playRelPath(bookId, playId)
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  try {
    const tmp = `${abs}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    await fs.writeFile(tmp, renderPlayMarkdown(data, turns), 'utf8')
    await fs.rename(tmp, abs)
  } catch {
    return { ok: false, error: '这一局没能存下来，检查一下磁盘是不是满了' }
  }
  return { ok: true, path: rel }
}

/** 删一局。 */
export async function deletePlay(root, bookId, playId) {
  try {
    await fs.unlink(path.join(root, playRelPath(bookId, playId)))
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, gone: true }
    return { ok: false, error: '这一局没能删掉' }
  }
  return { ok: true }
}

/** 列一本书的所有存档（按最后改动倒序）。 */
export async function listPlays(root, bookId) {
  const dir = path.join(root, bookRelPath(bookId), PLAY_DIR)
  let names
  try {
    names = await fs.readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, items: [] }
    return { ok: false, error: '存档列表读不出来' }
  }
  const items = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const got = await readPlay(root, bookId, name.replace(/\.md$/, ''))
    if (got.ok !== true) continue
    const turns = got.turns.filter((t) => t.kind === 'choose').length
    items.push({
      id: String(got.data?.id ?? name.replace(/\.md$/, '')),
      book: bookId,
      chapter: Number(got.data?.chapter) || 0,
      preset: String(got.data?.preset ?? ''),
      scene: String(got.scene ?? '').slice(0, 60),
      turns,
      updated_at: String(got.data?.updated_at ?? ''),
    })
  }
  items.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
  return { ok: true, items }
}

/**
 * 让 AI 主持一局的话。
 *
 * 关键几条：
 *   - 它只描述「发生了什么」，不替玩家决定任何事。
 *   - 每次必须给出三个能走的方向，且三个方向都要有代价，
 *     没有代价的选项等于没有选择。
 *   - 局面和手上的东西要跟着变，不能一百轮还站在原地。
 */
export function buildGmSystem({ bookTitle, scene, holding, preset }) {
  const lines = [
    `你在主持一个文字小说游戏。这个故事来自《${bookTitle}》。`,
    '',
    '【你是谁】',
    '你是那个「世界」本身：写景、写别人的反应、写事情怎么往下走。你不是故事里的任何一个人。',
    '',
    '【每一轮你要做什么】',
    '1. 先用两三段写清**这一刻发生了什么**（看见了什么、谁说了什么、局面怎么变了）。',
    '2. 最后给出三个可以走的方向，格式固定：',
    '   A. ……',
    '   B. ……',
    '   C. ……',
    '3. 三个方向必须是**做得出来的具体动作**，不是「继续」「观察」这种空话。',
    '4. 三个都要有代价：选了这个就会失去那个。不要给一个明显更好的选项。',
    '',
    '【绝对不做】',
    '- 不替玩家决定他说什么、做什么、想什么。',
    '- 不写「你可以选择」这种话，直接把三个方向列出来。',
    '- 不提前揭晓后面才该知道的事。',
    '- 不写「（作为 AI）」这类跳出的话。',
    '- 不用「命运的齿轮」这种空话起头。',
  ]
  if (String(scene ?? '').trim() !== '') {
    lines.push('', `【${SCENE_TITLE}】`, String(scene).trim())
  }
  if (Array.isArray(holding) && holding.length > 0) {
    lines.push('', `【${HOLD_TITLE}】`, ...holding.map((h) => `- ${h}`))
  }
  const flavour = String(preset ?? '').trim()
  if (flavour !== '') lines.push('', '【这一局的玩法】', flavour)
  return lines.join('\n')
}

/** 玩家说了一句话之后的这一轮。 */
export function buildGmUser({ turns, move, fromChapter }) {
  const lines = []
  const start = String(fromChapter ?? '').trim()
  if (start !== '') {
    lines.push('【开局这一段，来自这本书的正文】', start, '', '（从这里接着往下演，不要重写上面这段。）', '')
  }
  const recent = (Array.isArray(turns) ? turns : []).slice(-MAX_HISTORY_TURNS * 2)
  if (recent.length > 0) {
    lines.push('【前面发生过的】')
    for (const turn of recent) {
      if (turn.kind === 'narrate') lines.push(String(turn.text ?? '').trim())
      else if (turn.kind === 'choose') lines.push(`我选了：${String(turn.text ?? '').trim()}`, String(turn.result ?? '').trim())
      else lines.push(`我：${String(turn.text ?? '').trim()}`, String(turn.text2 ?? '').trim())
    }
    lines.push('')
  }
  const said = String(move ?? '').trim()
  if (said === '') {
    lines.push('先开个头：把此刻的局面写出来，再给三个方向。')
  } else {
    lines.push(`我这一步：${said}`, '', '写清这一步之后发生了什么，再给三个方向。')
  }
  return lines.filter((x) => x !== null && x !== undefined).join('\n')
}

/**
 * 「这一局演到这里，把它写成小说的一章」要发给模型的话。
 *
 * 和酒馆那一天用的是同一个思路，但有一处不一样：这里玩家是**选了方向**
 * 才往下走的，所以改写的重点不是「保住对话」，而是「保住他选的那几步」——
 * 那几步才是这一段剧情真正的骨架，不能因为改写成小说就被抹平。
 */
export function buildPlayToChapterPrompt({ bookTitle, turns, note }) {
  const system = [
    '你是一个写小说的人。下面这一段是玩出来的剧情，你要把它改写成这本书的一章正文。',
    '',
    `这本书叫《${String(bookTitle ?? '').trim() === '' ? '未命名' : String(bookTitle).trim()}》。`,
    '',
    '怎么改：',
    '1. 写成小说，不是剧本、不是「他做了一个选择」这种记录。',
    '2. **玩家选过的那几步必须保留**：他选了什么，就一定发生过什么，不能因为不好写就跳过。',
    '3. 可以补动作、天气、别人脸上的表情、没说出口的话——这些本来就该在。',
    '4. 不要新加人和新情节。这一段里没出现的人，不要凭空让他进来。',
    '5. 八百到一千五百字。分几段，不要写小标题。',
    '6. 只输出正文，不要解释你改了什么。',
  ].join('\n')

  const lines = []
  const recent = Array.isArray(turns) ? turns : []
  if (recent.length > 0) {
    lines.push('【这一局是怎么走过来的】')
    for (const turn of recent) {
      const kind = String(turn?.kind ?? 'say')
      if (kind === 'narrate') lines.push(String(turn.text ?? '').trim())
      else if (kind === 'choose') lines.push(`（我选了：${String(turn.text ?? '').trim()}）`, String(turn.result ?? '').trim())
      else lines.push(`（我说：${String(turn.text ?? '').trim()}）`, String(turn.text2 ?? '').trim())
    }
  }
  const hint = String(note ?? '').trim()
  if (hint !== '') lines.push('', `【这一章想往哪走】${hint}`)
  lines.push('', '把上面这一段写成小说正文。')
  return { system, user: lines.join('\n') }
}

/**
 * 从 AI 那一段里把三个方向拆出来。
 *
 * 模型经常不老实：写在正文里、用「1. 2. 3.」、用「- 」，或者干脆只给两个。
 * 这里尽力认，认不出就返回空数组——界面上还有输入框，用户照样能自己写。
 */
export function parseChoices(text) {
  const raw = String(text ?? '')
  const lines = raw.split(/\r?\n/)
  const found = []
  let bodyEnd = lines.length
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    const m = /^(?:([A-Ca-c])[.、．)]|([1-3])[.、．)]|[-*•])\s*(.+)$/.exec(line)
    if (m === null) continue
    const label = (m[1] ?? m[2] ?? '·').toUpperCase()
    const content = String(m[3] ?? '').trim()
    if (content === '') continue
    // 认出来的第一条之前的内容算正文
    if (found.length === 0) bodyEnd = i
    found.push({ label, text: content })
    if (found.length >= 3) break
  }
  const body = lines.slice(0, bodyEnd).join('\n').trim()
  return { body: body === '' ? raw.trim() : body, choices: found }
}

export default {
  PLAY_DIR, MAX_TURNS, MAX_HISTORY_TURNS,
  SCENE_TITLE, HOLD_TITLE, STORY_TITLE,
  playRelPath, newPlayId, renderPlayMarkdown, parsePlayText,
  readPlay, writePlay, deletePlay, listPlays,
  buildGmSystem, buildGmUser, buildPlayToChapterPrompt, parseChoices,
}
