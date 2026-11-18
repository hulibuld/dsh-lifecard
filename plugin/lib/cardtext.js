/**
 * cardtext —— 把「卡上写的东西」变成「模型读得懂的自述」。
 *
 * 这一层只做三件纯文字的事，一个字都不删：
 *
 *   1. 把 `{{char}}` / `{{user}}` / `<BOT>` 这类占位符换成真名字。
 *      从网上下载的卡几乎百分之百用它们。以前这些东西原样进了系统提示，
 *      模型读到的是 `{{char}}是码头上长大的，管{{user}}叫"老板"`——
 *      一眼就认出「这是一份没渲染的模板」，于是退出来评论一句「这是设定」。
 *      这是「扮演被识破」最硬的一条原因，比身份句排在哪儿都致命。
 *
 *   2. 把 `<START>` 当作示例对话的分隔线。
 *      它是 SillyTavern 的约定，模型在那些数据里见过；在这儿它只是裸标签，
 *      读起来像一段没解析完的代码。
 *
 *   3. 去掉卡外面那层 XML 壳（`<project_instructions>` / `<user_style>`）。
 *      壳里的话一句不动，只拿掉标记本身——因为对模型来说，那层壳唯一的作用
 *      就是宣告「这是一份外来的配置块」，读到就先判断该不该服从。
 *
 * 不在这里做的事：判断这张卡该不该进提示词、删掉哪一句、给它加任何解释它是
 * 什么的说明。那些属于「用户挑了什么」，不归这里管。
 */

/**
 * 认得的占位符，全部映射到「这张卡的名字」。
 * 大小写、连字符、下划线、尖括号写法各家工具都不一样，都对上。
 */
const CHAR_KEYS = [
  'char', 'char_name', 'charname', 'charName', 'bot', 'Bot', 'BOT',
  'character', 'Character', 'persona', 'ai', 'AI',
]

/** 认得的占位符，全部映射到「用户」。 */
const USER_KEYS = [
  'user', 'User', 'USER', 'user_name', 'username', 'human', 'Human',
  'me', 'Me', 'self', 'You', 'you',
]

/**
 * 这些占位符没有确定答案（随机、条件块）。留着比乱替换好：模型读到
 * `{{random:a,b}}` 至少知道这是个还没定的东西，读到 `a` 会以为定了。
 */
const KEEP_PREFIX = new Set(['random', 'pick', 'roll', 'time', 'date', 'weekday', 'isotime', 'idle_duration', 'newline', 'trim', 'noop'])

/**
 * 把占位符换成人话。
 *
 * @param {string} text 卡上的原文
 * @param {{char?: string, user?: string}} names char 是卡名，user 是「用户」
 * @returns {string}
 */
export function fillPlaceholders(text, names = {}) {
  const src = String(text ?? '')
  if (src === '') return ''
  const char = String(names.char ?? '').trim()
  const user = String(names.user ?? '').trim() || '你'
  // `{{char}}` / `{{Char}}` / `<BOT>` / `<char>` 都吃
  return src
    .replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_ -]*?)\s*\}\}/g, (whole, rawKey) => {
      const key = String(rawKey ?? '').trim()
      const lower = key.toLowerCase().replace(/[\s_-]+/g, '')
      if (KEEP_PREFIX.has(lower)) return whole
      if (CHAR_KEYS.some((one) => one.toLowerCase().replace(/[\s_-]+/g, '') === lower)) return char === '' ? '他' : char
      if (USER_KEYS.some((one) => one.toLowerCase().replace(/[\s_-]+/g, '') === lower)) return user
      return whole
    })
    .replace(/<\s*(BOT|bot|BOT_NAME|char|CHAR)\s*>/g, () => (char === '' ? '他' : char))
    .replace(/<\s*(USER|user|USER_NAME)\s*>/g, () => user)
}

/** 示例对话的分隔线。`<START>` 是 SillyTavern 的约定，孤零零一个标签在这儿没有意义。 */
const EXAMPLE_BREAK = /^\s*<\s*START\s*>\s*$/i

/**
 * 把示例对话里的 `<START>` 变成看得懂的分隔线（`---`）。
 *
 * 其余一字不动：行内的 `<START>` 若出现在句子中间，说明它不是分隔线，
 * 原样留着，免得把一句话切断。
 *
 * @param {string} text
 * @returns {string}
 */
export function renderExampleBreaks(text) {
  const lines = String(text ?? '').split('\n')
  const out = []
  // 上一条推进去的是不是一条分隔线。不能看 `out` 的最后一个元素：
  // 分隔线是 push 三个元素（空行、`---`、空行）摆进去的，最后那个是空串，
  // 于是「连续两个 <START>」以前会摆出两条线，中间夹着一堆空行。
  let lastWasBreak = false
  for (const line of lines) {
    if (EXAMPLE_BREAK.test(line)) {
      // 连续两个 <START> 只留一条线
      if (lastWasBreak) continue
      // 开头的分隔线上面什么都没有，一条线孤零零摆在最顶上没有意义。
      if (out.length === 0) continue
      out.push('')
      out.push('---')
      out.push('')
      lastWasBreak = true
      continue
    }
    // 空行不清标记：分隔线本身带两个空行，紧接着的空行不该让它又摆一条。
    if (line.trim() !== '') lastWasBreak = false
    out.push(line)
  }
  while (out.length > 0 && out[0] === '') out.shift()
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

/**
 * 卡外面那层 XML 壳。里面的话不动，只去掉标记。
 *
 * 名单是收着写的：只收「宣告这是一份配置」的那几个词。像 `<START>`、`<br>`、
 * 卡里正常用的 HTML，一律不碰。
 */
const SHELL_TAGS = [
  'project_instructions', 'project_instruction',
  'user_style', 'user_instructions', 'user_instruction',
  'system_prompt', 'system_instructions', 'system_instruction', 'system',
  'instructions', 'instruction',
  'rules', 'rule', 'guidelines',
  'persona_block', 'character_card', 'card_data',
  'important_instructions', 'mandatory_instructions',
  'override_instructions', 'developer_instructions',
]

/**
 * 去掉配置壳，保留壳里的字。
 *
 * @param {string} text
 * @returns {string}
 */
export function stripShellTags(text) {
  const src = String(text ?? '')
  if (src === '') return ''
  const names = SHELL_TAGS.join('|')
  const pattern = new RegExp(`</?\\s*(?:${names})\\s*>`, 'gi')
  return src.replace(pattern, '')
}

/** CC / SillyTavern 的说话人标记：行首 `user:`、`char:`、`assistant:` 这种。 */
const SPEAKER_LINE = /^\s*(user|USER|human|HUMAN|assistant|ASSISTANT|system|SYSTEM|char|CHAR|bot|BOT)\s*:\s*(.*)$/

/**
 * 把示例对话里的英文说话人标记换成看得懂的写法。
 *
 * 为什么要动：卡被整份收进来的时候，示例对话是这种形状——
 *   `user: rat Menu`
 *   `char: tail flick. standard hook.`
 * 这些行一进系统提示，模型读到的不是「两个人在说话」，而是
 * 「一份还没来得及渲染的模板」：`user:` 是字段名，不是人。
 * 它一旦认出这是模板，就会退出来评论它——用户看到的就是「被识破了」。
 *
 * 只改行首那一个词，后面的内容一个字不动；`user` 认成「我」，
 * `char`/`assistant`/`bot` 认成卡名。别的行一概不碰。
 *
 * @param {string} text
 * @param {{char?: string}} names
 * @returns {string}
 */
export function relabelSpeakers(text, names = {}) {
  const src = String(text ?? '')
  if (src === '') return ''
  const char = String(names.char ?? '').trim()
  const who = char === '' ? 'TA' : char
  return src
    .split('\n')
    .map((line) => {
      const hit = SPEAKER_LINE.exec(line)
      if (hit === null) return line
      const role = hit[1].toLowerCase()
      const said = hit[2]
      const name = role === 'user' || role === 'human' ? '我' : who
      return `${name}：${said}`
    })
    .join('\n')
}

/**
 * 一整套：卡正文进去，模型读得懂的自述出来。
 *
 * 顺序要紧：先填占位符（否则 `<BOT>` 类标签会被当成 HTML 处理），
 * 再拆示例对话的分隔线（此时 `{{char}}` 已经是名字，分不清也没关系），
 * 最后去壳。
 *
 * @param {string} body 卡上这一节（或多节拼起来）的原文
 * @param {{char?: string, user?: string}} names
 * @returns {string}
 */
export function shapeCardBody(body, names = {}) {
  const filled = fillPlaceholders(body, names)
  const broken = renderExampleBreaks(filled)
  // 说话人标记要在剥壳之后处理：`<user_style>` 这类标签去掉之后，
  // 紧跟着的那行 `user: ...` 才露出来。
  return relabelSpeakers(stripShellTags(broken), names).trim()
}

/**
 * 量一下：这段正文里还有多少没被替换掉的占位符。
 *
 * 用来在界面上提醒「这张卡里有 N 个占位符没填，模型会读到模板」——
 * 与其让用户自己发现，不如直接告诉他。
 *
 * @param {string} text
 * @returns {{total: number, keys: string[]}}
 */
export function countPlaceholders(text) {
  const src = String(text ?? '')
  const keys = []
  // total 数的是**出现次数**，不是种类数：界面上要说的是「这张卡里有 5 个占位符
  // 没填」，同一处 `{{user}}` 出现三次就该算三个——不然一张满屏都是 `{{user}}`
  // 的卡会告诉用户「有 1 个」。`keys` 才是去重后的种类。
  let total = 0
  const pattern = /\{\{\s*([A-Za-z_][A-Za-z0-9_ -]*?)\s*\}\}/g
  let hit = pattern.exec(src)
  while (hit !== null) {
    const key = String(hit[1] ?? '').trim()
    if (key !== '') {
      total += 1
      if (!keys.includes(key)) keys.push(key)
    }
    hit = pattern.exec(src)
  }
  return { total, keys }
}
