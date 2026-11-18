/**
 * intent —— 从用户那句话里猜他这次想进哪扇门。
 *
 * 为什么是「猜」而不是「问模型」：这段判断要在用户点预设的那一瞬间出结果。
 * 等一次模型往返（几秒到几十秒）才能把界面画出来，人只会觉得「点了没反应」，
 * 于是再点一次——同一个动作被点两遍，比猜错更糟。所以这里只做纯本地的
 * 关键词计数，几十微秒就回来，判错了界面上还有四个选项兜底。
 *
 * 判错了会怎样：不确定就返回 confident:false，界面把四扇门摆出来让人自己挑。
 * 所以这里的目标不是「猜得准」，而是「猜得清楚」——宁可说不确定，也别硬猜。
 */

/** 四扇门的代号。和界面上的门一一对应。 */
export const DOOR_IDS = ['novel', 'game', 'tavern', 'diary']

/** 四扇门的名字。给界面上的按钮用。 */
export const DOOR_NAMES = { novel: '写小说', game: '文字小说游戏', tavern: '酒馆', diary: '日记' }

/**
 * 每扇门的一句话说明。
 *
 * 和 `presets.MODES` 里那几句是同一个意思，但这里不能去 import 它：
 * presets.js 会反向用到这个模块的名词（「这一段的调子」那几排按钮要显示门户），
 * 两个文件互相 import 会在加载顺序上打架。四句话而已，各写一份。
 */
const DOOR_DESCS = {
  novel: '一章一章往下写',
  game: '进到情节里，你来选，它来推',
  tavern: '和 TA 你一句我一句地演',
  diary: '把今天记下来',
}

/** 「像是要……」那半句。拼在 why 里，读起来像人说的话。 */
const DOOR_PHRASES = {
  novel: '像是要写小说',
  game: '像是要玩一局',
  tavern: '像是要演一段',
  diary: '像是要记日记',
}

/**
 * 四组关键词。
 *
 * 挑词的规矩：**只收那些出现了就基本没别的解释的词**。
 * 「写」「玩」「聊」这类单字不收——它们在任何句子里都出现，
 * 收了等于每句话都命中四扇门，判门就退化成随机。
 */
const KEYWORDS = {
  novel: ['写小说', '连载', '开一本', '章节', '大纲', '文风', '长篇', '短篇', '投稿', '改稿', '润色'],
  game: ['文字游戏', '玩一局', '选一个', '剧情往哪走', '互动', '扮演主角', '存档', '结局'],
  tavern: ['陪她', '陪他', '演一个', '角色扮演', '对戏', '聊天', '人设', '这张卡', '开场白'],
  diary: ['日记', '今天', '记录一下', '心情', '复盘'],
}

/**
 * 判门。
 *
 * @param {{ text?: string, mode?: string, hasCard?: boolean, hasBook?: boolean, hasWorld?: boolean }} input
 *   `text` 是用户自己那句话；`mode` 是他已经点进去的那扇门（有值就不再猜）。
 *   `hasCard/hasBook/hasWorld` 是他工作区里现有的东西——只用来给「一组词都没命中」
 *   那种情况兜个底，不参与关键词计分。
 * @returns {{ mode: string, confident: boolean, why: string, options: Array<{ mode: string, name: string, desc: string, reason: string }> }}
 */
export function judgeIntent(input) {
  const src = input !== null && typeof input === 'object' ? input : {}
  // 用户可能把一整章贴进来。截一下：判断本身是线性的，但没必要为了一段
  // 两万字的正文去扫 34 个关键词。
  const text = String(src.text ?? '').slice(0, 20000)

  const hits = {}
  for (const id of DOOR_IDS) hits[id] = KEYWORDS[id].filter((word) => text.includes(word))

  // 选项永远给四条：它是「说不清就让人挑」的那一手，不是「猜到了就不用给」。
  // 猜到了界面上不显示（confident:true 时界面不画），但数据照样齐整。
  const options = DOOR_IDS.map((id) => ({
    mode: id,
    name: DOOR_NAMES[id],
    desc: DOOR_DESCS[id],
    // 命中过就报命中的词（人一看就知道「哦，是因为我说了这句」），
    // 没命中就退回这句门自己的说明，不留空。
    reason: hits[id].length > 0 ? `你说到「${hits[id].join('」「')}」` : DOOR_DESCS[id],
  }))

  // 已经在门里了：不猜。判门是为了「该进哪扇门」，人已经进去了就没这个问题。
  const already = DOOR_IDS.includes(String(src.mode ?? ''))
  if (already === true) {
    return { mode: String(src.mode), confident: true, why: '你已经在这扇门里了。', options }
  }

  const scored = DOOR_IDS.filter((id) => hits[id].length > 0)
  if (scored.length === 1) {
    const id = scored[0]
    return {
      mode: id,
      confident: true,
      why: `你说到「${hits[id].join('」「')}」，${DOOR_PHRASES[id]}。`,
      options,
    }
  }
  if (scored.length > 1) {
    // 几组都命中：命中词最多的那扇门才是答案；并列就说不清——
    // 这时候硬挑一个，用户会觉得「它根本没听我说话」。
    const best = Math.max(...scored.map((id) => hits[id].length))
    const top = scored.filter((id) => hits[id].length === best)
    if (top.length === 1) {
      const id = top[0]
      return {
        mode: id,
        confident: true,
        why: `你说到「${hits[id].join('」「')}」，${DOOR_PHRASES[id]}。`,
        options,
      }
    }
    const names = top.map((id) => DOOR_NAMES[id])
    return {
      mode: '',
      confident: false,
      why: names.length === 2
        ? `你说的又像${names[0]}，又像${names[1]}，分不清——挑一个？`
        : `你说的像${names.join('、')}，分不清——挑一个？`,
      options,
    }
  }

  // 一组词都没命中。手上有卡的人多半是想演一段（卡就是为演准备的），
  // 但这是猜，所以 confident 是 false，界面照样给四个选项。
  if (src.hasCard === true) {
    return {
      mode: 'tavern',
      confident: false,
      why: '没看出你要干什么，不过你手上有卡——大概是想演一段。挑一个？',
      options,
    }
  }
  return {
    mode: '',
    confident: false,
    why: '没看出你想干什么。挑一个，我照着准备。',
    options,
  }
}

/** 界面上那句提示。判不出来时摆在选项上面。 */
export function buildOptionHint(mode) {
  const want = String(mode ?? '').trim()
  if (DOOR_IDS.includes(want) === true) {
    return `按「${DOOR_NAMES[want]}」来准备。想干别的，就在下面换一扇门。`
  }
  return '挑一个，我照着准备。挑错了随时能换。'
}

/**
 * 从模型的回答里抠出「该进哪扇门」。
 *
 * 现在这条路没接（判门走本地关键词），但它得留着：关键词判不出来的时候，
 * 以后可以拿用户那句话问一次模型，让它按格式回一句【去哪】写小说。
 * 这条路一旦接上，模型回什么都可能，所以这里只认那个标记后面的那一行。
 *
 * @param {string} text
 * @returns {'novel'|'game'|'tavern'|'diary'|''}
 */
export function parseIntentReply(text) {
  const src = String(text ?? '')
  const MARK = '【去哪】'
  const at = src.indexOf(MARK)
  if (at === -1) return ''
  const rest = src.slice(at + MARK.length)
  // 只认标记后面第一行有字的内容：再往后就是模型自己的解释，容易误伤。
  const line = rest.split(/\r?\n/).map((s) => s.trim()).find((s) => s !== '')
  if (line === undefined || line === '') return ''
  // 先认代号（它出现在英文句子或括号里时边界不一定是空格，所以用前后非字母判）。
  for (const id of DOOR_IDS) {
    if (new RegExp(`(^|[^a-z])${id}([^a-z]|$)`, 'i').test(line) === true) return id
  }
  // 再认中文名。「文字小说游戏」里没有「写小说」，四条名字互不包含，不会串。
  for (const id of DOOR_IDS) {
    if (line.includes(DOOR_NAMES[id]) === true) return id
  }
  return ''
}

export default { DOOR_IDS, DOOR_NAMES, judgeIntent, buildOptionHint, parseIntentReply }
