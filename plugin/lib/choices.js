/**
 * choices —— 四个门（酒馆 / 写小说 / 写日记 / 文字游戏）共用的「选项」层。
 *
 * 为什么不继续长在 game.js 里：
 *   game.js 的 parseChoices 判据是「正文里碰到的第一条列表行」——它在游戏里够用，
 *   因为游戏每轮末尾一定要给方向；但小说正文里到处是「1. 他推开门」这种编号段落，
 *   照那个判据会把一大截正文剪成「选项」。四个门都要用的时候，宁可多一层，
 *   也不能让小说被剪掉。
 *
 * 所以这里的中心判据只有一条：
 *   只有「贴在正文末尾、连成一片、每条都短」的列表才算选项。
 *   中间出现的、只有一条的、句子很长的，一律还给正文。
 *
 * 这一层纯字符串进出：不调模型、不碰磁盘、不 import 任何东西。
 */

/** 选项块的分隔标记。AI 在正文之后单独起一行写这个，下面是选项。 */
export const CHOICE_MARK = '【选】'

/** 最多认几条选项。超过就截断——四个方向以上的选择，人反而不想选。 */
export const MAX_CHOICES = 4

/** 最少几条。只给一条等于没给选择，不如不给。 */
export const MIN_CHOICES = 2

/**
 * 一条选项最多多少字（按码点算，中文/emoji 都算一个）。
 * 40 是经验值：中文说清「做什么」通常 20 字以内，
 * 40 已经宽容到「把伞递过去，别看他（她会接吗）」这种带动作带解释的写法了。
 * 超过这个长度，它更像正文里的一句话，不像一个能点的方向。
 */
const MAX_ITEM_LEN = 40

/**
 * 除了标准标记，模型还会自己发明小标题。
 * 这些都当同一个意思：从这里往下是选项。
 */
const MARK_ALIASES = [CHOICE_MARK, '【选项】', '【选择】', '【接下来】', '【你可以】']

/**
 * 带编号/符号的行怎么拆。每条写清楚它拦的是什么。
 *   labelGroup = 0 表示这条没有编号，标签统一记作「·」。
 */
const ITEM_PATTERNS = [
  {
    // 阿拉伯数字：1. / 2、 / 3) / 4） —— 只认 1~2 位，拦掉「2026.10」这种年份开头；
    // (?!\d) 再拦一次「10.5 分」这种小数，别把小数点当编号后的点。
    re: /^(\d{1,2})\s*[.、．)）]\s*(?!\d)(.+)$/,
    labelGroup: 1,
    textGroup: 2,
  },
  {
    // 字母：A. / b) / C、 —— 上屏时统一大写，A 和 a 不该出现两种按钮。
    re: /^([A-Za-z])\s*[.、．)）]\s*(.+)$/,
    labelGroup: 1,
    textGroup: 2,
    upper: true,
  },
  {
    // 圈码：①~⑳。这类本来就自带顺序，后面不强制要空格或点。
    re: /^([①-⑳])\s*(.+)$/,
    labelGroup: 1,
    textGroup: 2,
  },
  {
    // 中文数字：一、 / 二. —— 老派写法，正文小说里少见，但模型爱用。
    re: /^([一二三四五六七八九十]{1,2})\s*[.、．)）]\s*(.+)$/,
    labelGroup: 1,
    textGroup: 2,
  },
  {
    // 项目符号：- * • · ▪ ◦。允许符号后没有空格（模型常写「-把伞递过去」）。
    re: /^[-*•·▪◦]\s*(.+)$/,
    labelGroup: 0,
    textGroup: 1,
  },
]

/**
 * 拦「---」「***」「· · ·」这类分隔线：它们长得像项目符号，但后面全是符号，
 * 当成选项会出现一个叫「--」的按钮。
 */
const JUNK_RE = /^[-—–=_*·•▪◦\s.。，,、]+$/

/**
 * 选项末尾的括号解释：把伞递过去（她会接吗）。
 * 只认「整句末尾」的括号，且括号里不能套括号——正文里的插入语不碰。
 */
const HINT_RE = /^(.+?)\s*[（(]([^（）()]{1,60})[）)]\s*$/

/** 有了【选】之后模型常直接一行一个方向，这些「旁注行」不能当选项。 */
const NOTE_START_RE = /^(?:以上|以下|注|说明|提示|备选|选项)/
const WRAPPED_RE = /^[（(【\[].*[）)】\]]$/

/** 按码点数长度：中文一个字算一个，不是按 UTF-16 单元算两个。 */
const len = (s) => [...String(s ?? '')].length

/** 去掉模型爱加的加粗和反引号——按钮上不需要这些装饰。 */
function tidy(s) {
  return String(s ?? '')
    .trim()
    .replace(/^(\*\*|__|`)+/, '')
    .replace(/(\*\*|__|`)+$/, '')
    .trim()
}

/** 拆出 hint：括号里的那句留给界面灰着显示，text 只留能点的部分。 */
function buildItem(label, rawText) {
  const m = HINT_RE.exec(rawText)
  if (m === null) return { label, text: rawText, hint: '' }
  const text = m[1].trim()
  // 括号前面什么都没有（「（沉默）」）就不算解释，整句原样留着
  if (text === '') return { label, text: rawText, hint: '' }
  return { label, text, hint: m[2].trim() }
}

/** 一行能不能当选项；不能就返回 null，让调用方当正文。 */
function parseItem(rawLine) {
  const line = String(rawLine ?? '').trim()
  if (line === '' || JUNK_RE.test(line)) return null
  for (const pat of ITEM_PATTERNS) {
    const m = pat.re.exec(line)
    if (m === null) continue
    const label = pat.labelGroup === 0 ? '·' : String(m[pat.labelGroup])
    const text = tidy(m[pat.textGroup])
    if (text === '' || JUNK_RE.test(text)) continue
    return buildItem(pat.upper === true ? label.toUpperCase() : label, text)
  }
  return null
}

/** 标记行：返回标记后面剩下的那截（可能是空的，也可能是同行的第一条）。 */
function matchMarker(line) {
  const s = String(line ?? '').trim()
  for (const mark of MARK_ALIASES) {
    if (!s.startsWith(mark)) continue
    // 模型常在标记后面接冒号或破折号：【选】：/【选】——
    const rest = s.slice(mark.length).replace(/^[：:、，,。\s\-—]+/, '')
    return { mark, rest }
  }
  return null
}

/**
 * 标记之后没有项目符号的裸行也算一条方向，但要挡三种：
 * 被括号/方括号整个包住的旁注、「以上/以下」开头的总结、超过 40 字的长句。
 */
function isPlainChoice(line) {
  const s = String(line ?? '').trim()
  if (s === '' || JUNK_RE.test(s)) return false
  if (s.startsWith('#') || s.startsWith('【')) return false
  if (WRAPPED_RE.test(s) || NOTE_START_RE.test(s)) return false
  if (len(s) > MAX_ITEM_LEN) return false
  return true
}

/**
 * 从 AI 那一段回复里拆出正文与选项。
 *
 * 认得出的形态：标准【选】标记、【选项】/【接下来】这类别名、1./A./①/一、
 * - * • 项目符号，以及标记之后一行一条的裸行；选项末尾的全角/半角括号拆成 hint。
 *
 * 两条口径，写死在这里，别处不要各写一套：
 *   - 有标记：标记之前的全部是正文，标记行本身不留在正文里（它是格式，不是内容）。
 *     但标记后一条都凑不出 2 条时，说明模型写岔了——这时不剪，body 返回完整原文。
 *   - 没标记：从末尾往上数，一整片连续的列表行才算选项。只要有一行不是列表、
 *     有一条超过 40 字、或者总数不到 2 条，就整块退回正文，body 返回完整原文。
 *
 * @returns {{body: string, choices: Array<{label: string, text: string, hint: string}>, tagged: boolean}}
 */
export function parseChoices(text) {
  const raw = String(text ?? '')
  const lines = raw.split(/\r?\n/)

  const markAt = lines.findIndex((line) => matchMarker(line) !== null)
  if (markAt >= 0) {
    const items = []
    const head = matchMarker(lines[markAt])
    // 标记和第一条写在同一行：【选】把伞递过去
    if (head !== null && head.rest !== '') {
      const inline = parseItem(head.rest)
      if (inline !== null) items.push(inline)
    }
    for (let i = markAt + 1; i < lines.length; i += 1) {
      const line = lines[i]
      // 第二个标记行（模型偶尔把【选】写两遍）只当分隔，不当内容
      if (matchMarker(line) !== null) continue
      if (line.trim() === '') continue
      const item = parseItem(line)
      if (item !== null) { items.push(item); continue }
      if (isPlainChoice(line)) items.push({ label: '·', text: tidy(line), hint: '' })
      // 认不出的行（解释、旁注、小标题）直接丢掉：标记之后没有正文
    }
    // 标记后面一条像样的方向都没有：这不是选项块，是模型自己写岔了。
    // 这时候连标记前后一起原样还回去——按「标记之前是正文」剪，会把标记后面
    // 那截内容（往往是正文续写）整段扔掉，比不认更糟。
    if (items.length < MIN_CHOICES) {
      return { body: raw.trim(), choices: [], tagged: true }
    }
    return {
      body: lines.slice(0, markAt).join('\n').trim(),
      choices: items.slice(0, MAX_CHOICES),
      tagged: true,
    }
  }

  // 没标记：从末尾往上走。尾部空行先跳过，空行以外一断就停——这就是「连续」。
  let end = lines.length - 1
  while (end >= 0 && lines[end].trim() === '') end -= 1
  const back = []
  let start = end + 1
  for (let i = end; i >= 0; i -= 1) {
    const item = parseItem(lines[i])
    if (item === null) break
    back.push(item)
    start = i
  }
  const items = back.reverse()

  // 条数不够、或者有一条太长，都说明这不是选项，是正文里的列表
  const usable = items.length >= MIN_CHOICES && items.every((it) => len(it.text) <= MAX_ITEM_LEN)
  if (!usable) return { body: raw.trim(), choices: [], tagged: false }

  return {
    body: lines.slice(0, start).join('\n').trim(),
    choices: items.slice(0, MAX_CHOICES),
    tagged: false,
  }
}

/** 每种风格问的东西不一样：剧情问「往哪走」，对话问「怎么接话」，日记问「从哪个角度讲」。 */
const STYLE_TEXT = {
  story: {
    frame: '这一轮往哪走',
    ask: '每条是「我」接下来能做的一件具体的事：往哪走、对谁说什么、动不动手。',
  },
  chat: {
    frame: '这一轮我可以怎么接',
    ask: '每条是「我」接下来能说出口的一句话，或者说这句话时顺手做的一个动作；用第一人称的口吻写，不要写成旁白。',
  },
  diary: {
    frame: '今天这件事，还能从哪个角度讲',
    ask: '每条是「我」可以顺着往下讲的一个角度，像朋友在旁边追问一句；不要写成「总结」「反思」这种词。',
  },
}

/**
 * 反过来：把选项拼成一段给模型看的「该怎么给选项」的要求。
 * 供 novel/tavern/diary 拼系统提示时用。
 *
 * @param {{count?: number, style?: 'story'|'chat'|'diary'}} options
 */
export function choiceDirective(options = {}) {
  const opts = options === null || typeof options !== 'object' ? {} : options
  const style = Object.prototype.hasOwnProperty.call(STYLE_TEXT, opts.style) ? opts.style : 'story'
  const conf = STYLE_TEXT[style]
  const want = Number(opts.count)
  // 条数钉死在 2~4：少于 2 不叫选择，多于 4 人就不挑了
  const count = Number.isFinite(want) && want > 0
    ? Math.min(MAX_CHOICES, Math.max(MIN_CHOICES, Math.round(want)))
    : 3
  return [
    `这一轮回复的最后，单独起一行写 ${CHOICE_MARK}，下面给出 ${count} 个方向，一个一行，用「- 」开头。`,
    `${conf.frame}：${conf.ask}`,
    '每条不超过 20 字，要能直接念出来当回答；不要写「继续」「随便看看」这种放到哪句话后面都成立的空话。',
    '想补一句解释，就写在选项后面的全角括号里，例如：把伞递过去（她会接吗）。界面会把它灰着显示。',
    '正文里不要出现「选项」「以上」「请选择」这些词，也不要再把方向重复一遍。',
    `例：\n${CHOICE_MARK}\n- 把伞递过去（她会接吗）\n- 转身走进雨里\n- 站在门口不动`,
  ].join('\n')
}

/**
 * 从模型回复里剥掉选项块，只留正文。给「这一段要存进小说正文」的场合用。
 * 内部走 parseChoices，保证两处口径一致——不要自己再写一套正则。
 */
export function stripChoices(text) {
  return parseChoices(text).body
}

/** 判断一段文本里有没有选项块（给界面决定要不要渲染选项条）。 */
export function hasChoices(text) {
  return parseChoices(text).choices.length >= MIN_CHOICES
}

export default {
  CHOICE_MARK, MAX_CHOICES, MIN_CHOICES,
  parseChoices, choiceDirective, stripChoices, hasChoices,
}
