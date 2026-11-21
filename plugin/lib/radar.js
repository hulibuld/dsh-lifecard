/**
 * radar —— 一本书的「吃书」检测：把所有章翻一遍，找出前后对不上的地方。
 *
 * 写长篇最难受的不是写不出来，是写着写着把自己前面写的东西忘了：
 * 第三章她还是十七岁，第十二章忽然成了十五；第六章那个人已经死了，第九章
 * 又推门进来。这种错自己看不出来——重读三十万字才发现，通常已经发出去好几天了。
 *
 * 让模型去查有两个毛病：它会编（报一条书里根本不存在矛盾），而且慢、要钱。
 * 这里换一条路：
 *
 *   抽取 = 确定性规则（句式模板 + 人名表 + 别名归并），一段文字里能认出的才认
 *   判定 = 纯集合比对（同一个人的同一项属性，前后值不同就是矛盾）
 *
 * 所以它是**零联网、零模型、零幻觉**的：给同一本书，永远给同一份结果；
 * 报出来的每一条都能点回原句去核对。宁可漏，不许冤枉——模糊的语义一律不猜。
 *
 * 这一层只碰字符串与纯函数：不读盘、不调模型、不碰 HTTP。
 * 读盘的那一侧（哪些章、叫什么）由 index.js 传 `{ index, title, body }[]` 进来。
 */

/** 属性名 → 人话。界面上直接摆这个，不摆 hoursAge 这种内部叫法。 */
export const ATTR_LABEL = {
  age: '年龄',
  height: '身高',
  eye: '瞳色',
  hair: '发色',
  alive: '死活',
  level: '等级',
  realm: '境界',
}

/** 这一条有多硬。`hard` = 能坐实（数字、死活）；`soft` = 只能算疑点。 */
export const SEVERITY_LABEL = { hard: '对不上', soft: '有点怪' }

/**
 * 哪些属性只能往上走，哪些一变就是错。
 *
 * 这一条决定了这份报告能不能看。年龄是最典型的：第一章十七岁、第十二章
 * 十九岁，中间隔了两年，这是**对的**。不区分这个，任何一本有跨年的书
 * 都会被报出一堆「年龄对不上」——十本里有十本是假阳性，报告就没人看了。
 *
 *   up   只允许不变或变大（年龄、身高、等级）。变小才报。
 *   flat 一点都不能变（瞳色、发色）。任何一个不同的值都报。
 *
 * 身高放 up 不放 flat：少年会长个，成年人不变，两种情况都说得通，
 * 只有「变矮」才是硬错。
 */
export const ATTR_MONOTONIC = { age: 'up', height: 'up', level: 'up', eye: 'flat', hair: 'flat' }

/** 两次记录之间，这个变化算不算矛盾。 */
export function isConflict(attr, before, after) {
  const mode = ATTR_MONOTONIC[attr] ?? 'flat'
  const a = before?.value
  const b = after?.value
  if (mode === 'up') {
    if (typeof a !== 'number' || typeof b !== 'number') return false
    // 只在「倒退」时算矛盾。变大、相等都放过——书里时间往前走，
    // 年龄身高等级跟着涨是常态，不是吃书。
    return b < a
  }
  if (typeof a === 'number' && typeof b === 'number') return a !== b
  return String(a ?? '').trim() !== String(b ?? '').trim()
}

/**
 * 中文数字 → 阿拉伯数字。只认到万位，够用了（没人会写「一千三百四十二岁」）。
 *
 * 为什么不用 `parseInt`：书里一律写「十七岁」，`parseInt('十七')` 是 NaN，
 * 整条线索就丢了。而数字是这里最硬的证据，丢了数字等于这个功能没用。
 */
const CN_DIGIT = { 〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const CN_UNIT = { 十: 10, 百: 100, 千: 1000, 万: 10000 }

export function cnum(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return null
  // 阿拉伯数字（含小数点）先走这条：书里混着写是常态。
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text)
  let total = 0
  let section = 0
  let digit = null
  let sawAny = false
  for (const ch of text) {
    if (ch in CN_DIGIT) {
      digit = CN_DIGIT[ch]
      sawAny = true
      continue
    }
    const unit = CN_UNIT[ch]
    if (unit === undefined) return null
    sawAny = true
    // 「十七」：十前面没有数字时按一算。
    const base = digit === null ? 1 : digit
    if (unit === 10000) {
      total = (total + section + base) * unit
      section = 0
    } else {
      section += base * unit
    }
    digit = null
  }
  if (!sawAny) return null
  return total + section + (digit === null ? 0 : digit)
}

/**
 * 这些词长得像名字，其实不是。
 *
 * 为什么非要有这张表：中文没有词边界，`([\u4e00-\u9fa5]{2,4}?)说` 这种
 * 「两到四个字 + 说话动词」的模板，第一个撞上的就是「忽然说」「众人都说」。
 * 不挡的话，一本书里会多出几十个叫「忽然」「片刻」「众人」的「人物」，
 * 每条都带着自己的属性记录，报告一打开全是废话。
 */
const NOT_A_NAME = new Set([
  '忽然', '突然', '顿时', '当下', '片刻', '此时', '此刻', '然后', '于是', '因此',
  '所以', '但是', '可是', '只是', '就是', '还是', '已经', '曾经', '似乎', '仿佛',
  '好像', '一边', '一面', '众人', '大家', '所有', '那些', '这些', '一切', '什么',
  '怎么', '为何', '因为', '如果', '虽然', '不过', '而且', '并且', '然而', '接着',
  '随即', '终于', '果然', '竟然', '居然', '慢慢', '轻轻', '缓缓', '静静', '默默',
  '悄悄', '连忙', '赶紧', '立刻', '马上', '一直', '始终', '仍旧', '依然',
  '两人', '三人', '几人', '二人', '一人', '有人', '没人', '别人', '自己', '对方',
  '双方', '旁人', '外人', '家人', '亲人', '女人', '男人', '孩子', '老者',
  '少年', '少女', '姑娘', '公子', '那人', '这人', '心里', '心中', '眼中',
  '眼前', '身后', '身上', '手里', '耳边', '脸上', '声音', '时候', '地方', '东西',
  '事情', '样子', '办法', '问题', '意思', '感觉', '知道', '觉得', '看见', '听见',
  // 下面这批是拿本机几万字中文文本跑出来的真阳性误认：
  // 这些词后面经常跟着「说/道」（「直接说」「不知说什么」），于是被判成人名。
  // 宁可让这张表更长，也不要让报告里出现「直接」这个人。
  '直接', '不知', '不能', '不要', '不用', '不会', '不该', '不是', '没有', '可以',
  '可能', '应该', '必须', '需要', '已经', '正在', '刚刚', '刚才', '现在', '以前',
  '以后', '之前', '之后', '第二', '第三', '第一', '第四', '第五', '每次', '每次',
  '精确', '验收', '一句', '一遍', '一处', '一条', '一样', '一些', '一篇', '一本',
  '一半', '一边', '一旦', '一起', '一直', '别人', '有的', '有时', '有点', '有效',
  '这个', '那个', '这里', '那里', '这样', '那样', '这种', '那种', '为什么', '怎么样',
  '意思是', '意思是说', '举例', '比如', '例如', '总之', '反正', '其实', '本来',
  '原来', '当然', '显然', '可能', '大概', '也许', '未必', '一定', '绝对', '肯定',
  '不好', '不对', '不少', '不再', '不再说', '不必', '不管', '不论', '不然', '否则',
])

/** 名字里出现这些字就不是名字——它们是量词、虚词、时间词。 */
const NAME_BAD_CHARS = /[的了着过是在有和与也都就还又却已正把被让给对向从个些这那什么怎为因但而且或如若虽然所以之其此该每各某另别再最更很太挺比较她了它您咱]/

/** 人称代词：单独出现时绝不能当名字。 */
const PRONOUNS = new Set(['他', '她', '它', '我', '你', '俺', '您', '咱', '俺们', '我们', '你们', '他们', '她们'])

/**
 * 这个字符串像不像一个人的名字。
 *
 * 「宁少不误」这条原则落在这里：认错了名字，后面每一条属性、每一次出场
 * 都会挂到一个不存在的人身上，报告就没法看了；漏认一个名字，只是少几条线索。
 * 所以判据往严里收。
 */
export function looksLikeName(raw) {
  const name = String(raw ?? '').trim()
  if (name.length < 2 || name.length > 4) return false
  if (!/^[\u4e00-\u9fa5]+$/.test(name)) return false
  if (PRONOUNS.has(name)) return false
  if (NOT_A_NAME.has(name)) return false
  if (NAME_BAD_CHARS.test(name)) return false
  if (name.includes('的') || name.includes('了')) return false
  // 以序数/量词开头的不是名字：「第二」「一句」「怎么」「几个」。
  // 注意不能一刀切掉「一二三」开头——「张三」「李四」「王五」是中文里
  // 最常见的一类人名，切了等于把最常见的人全漏掉。所以只挡「第二/第三」
  // 这种「第 + 数字」，以及后面紧跟量词的情形。
  if (/^第[一二三四五六七八九十百千万\d]/.test(name)) return false
  if (/^[每各几半]./.test(name)) return false
  if (/^[一二三四五六七八九十百千万\d][个条件只位名句篇本页次年月日时分秒种样些]/.test(name)) return false
  // 名字里面不能有虚词。真的人名（阿昭、李四、王小明、赵铁柱）不会含
  // 「不、没、准、前、后、机、制、稿」这些字；而「不替他」「拿不准」
  // 「动笔前先」「机制照」「稿子」全都含。这一条比逐条列黑名单稳，
  // 因为它拦的是构词方式，不是具体哪个词。
  if (/[不没别莫勿未非准前后机制稿条秒骂替]/.test(name)) return false
  return true
}

/**
 * 这个名字在正文里的位置像不像主语。
 *
 * 判据只有一条：它前面不能是虚词。句首、标点后面、行首都算合格。
 * 这一条挡掉了「不替他」「不能立刻」「事不好直」这类横跨词边界的假名字——
 * 它们后面虽然也常跟「说」「道」，但前面那一个字暴露了它们不是主语。
 */
function leftEdgeOk(text, at) {
  if (at <= 0) return true
  const before = String(text).slice(0, at)
  return NAME_LEFT_OK.test(before)
}

/**
 * 说话动词后面必须紧跟一个停顿。
 *
 * 这是「远程访**问**用的是…」「免费渠**道**」这两条误判的根：
 * 「问」「道」「说」在中文里既是说话动词，又是普通词的一部分（访问、渠道）。
 * 光看前面像不像主语救不了——「远程访问」正好在句首。
 *
 * 真在交代谁说了话时，这三个字后面一定是停顿：
 *   `阿昭说道：「…」`  `阿昭笑道，`  `阿昭问。`
 * 而在「访问用的是」「免费渠道」里，后面紧跟的是实词（用、的）。
 * 所以判据放在尾巴上，比放在头上稳。
 */
const SPEAK_TAIL_OK = /^[\s：:，,。！？!?、；;」』”"'\n\r\t—-]|^\/|^$/

/** 这个说话动词是不是真的在交代「谁说了话」。 */
function speakTailOk(text, endAt) {
  return SPEAK_TAIL_OK.test(String(text).slice(endAt))
}

/** 正则里要转义的字符。 */
function escapeRe(text) {
  return String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 属性模板要用到的词。人名部分一律懒惰，见 ATTR_RULES 上面的说明。 */
const AGE_WORDS = '今年|年方|年仅|已经|已'
const NUM = '\\d{1,4}|[一二三四五六七八九十百千万〇零]{1,6}'
const REALM = '练气|筑基|金丹|元婴|化神|炼神|返虚|大乘|渡劫|武徒|武士|武师|大武师|武灵|武宗|武尊|武皇|武圣|武帝'

/**
 * 属性模板。
 *
 * 人名一律 `{2,4}?`（懒惰）：贪婪的 `{2,4}` 会把「阿昭今年」整段吃成名字，
 * 于是「阿昭今年十七岁」抽出的人叫「阿昭今年」，「阿昭已经十九岁」抽出的人
 * 叫「阿昭已经」——两个「人」各成一套记录，永远比不出矛盾。这是本轮踩过的坑。
 *
 * 每条的约定：第 1 组是名字，最后一组是值。抽出来还要过 looksLikeName，
 * 过不了就整条丢掉。
 */
const ATTR_RULES = [
  { attr: 'age', re: new RegExp(`([\\u4e00-\\u9fa5]{2,4}?)\\s*(?:${AGE_WORDS})?\\s*(${NUM})\\s*岁`) },
  { attr: 'height', re: new RegExp(`([\\u4e00-\\u9fa5]{2,4}?)\\s*(?:身高|个头|身量)\\s*(?:有|约|大约|差不多)?\\s*(\\d{2,3}|[一二三四五六七八九十百]{2,6})\\s*(?:厘米|公分|cm)`) },
  { attr: 'eye', re: new RegExp(`([\\u4e00-\\u9fa5]{2,4}?)\\s*(?:的)?\\s*(?:眼睛|双眸|眼瞳|瞳色)(?:是|为|呈)?\\s*([\\u4e00-\\u9fa5]{1,2}色)`) },
  { attr: 'hair', re: new RegExp(`([\\u4e00-\\u9fa5]{2,4}?)\\s*(?:的)?\\s*(?:头发|发色)(?:是|为)?\\s*([\\u4e00-\\u9fa5]{1,2}色)`) },
  { attr: 'level', re: new RegExp(`([\\u4e00-\\u9fa5]{2,4}?)\\s*(?:已经|已|才|刚)?\\s*(?:${REALM})\\s*([一二三四五六七八九十\\d]{1,3})\\s*(?:层|重|阶|品)`) },
]

/** 说话动词：出现在名字后面，说明前面那串是个人。 */
const SPEAK_WORDS = '笑道|答道|问道|低声道|叫道|喊道|沉声道|冷声道|说|道|问|答|喊|叫'

/**
 * 名字前面必须是一个真正的边界。
 *
 * 只在「前面是虚词」时拒绝是不够的：中文最常见的误判来自**词内**——
 * 「远程访问用的是…」里，「远程访」后面正好跟着「问」，而「问」在说话
 * 动词表里，于是「远程访」被当成了一个人。这种错前面一个字是「程」，
 * 不在任何虚词表里，靠黑名单永远堵不完。
 *
 * 所以反过来判：名字前面**必须是**句首、换行、空格，或者标点。
 * 这条比黑名单严格得多，也稳定——它是中文里主语真实出现的位置分布，
 * 而不是一份永远补不全的例外清单。
 *
 * 代价是「后来阿昭说道」这种名字前面是「来」的会被漏掉。可以接受：
 * 漏一个名字只是少几条线索，认错一个名字会让整份报告变成笑话。
 */
const NAME_LEFT_OK = /(^|[\s，。！？；：、,.!?;:（(【[「『“"\n\r\t—…·])$/
const SPEAK_RE = new RegExp(`([\\u4e00-\\u9fa5]{2,4}?)\\s*(?:${SPEAK_WORDS})`)

/**
 * 切出 `index` 所在的那一句。找不到边界就退化成前后各二十字。
 *
 * 返回前要把 `stripQuoted` 留下的全角空格收掉：那句台词被抹成一个等长的
 * 空格串之后，切出来的句子会变成「李四说道：　　　　他身高一百七十五厘米」——
 * 摆进报告里像坏掉了。原文该是什么样，人对着书能查得到；这一句只是个定位。
 */
function sentenceAt(text, from, to) {
  const src = String(text ?? '')
  const marks = '。！？；\n'
  let start = from
  while (start > 0 && !marks.includes(src[start - 1])) start -= 1
  let end = to
  while (end < src.length && !marks.includes(src[end])) end += 1
  const piece = tidy(src.slice(start, Math.min(src.length, end + 1)))
  if (piece !== '') return piece
  return tidy(src.slice(Math.max(0, from - 20), Math.min(src.length, to + 20)))
}

/** 收掉用来占位的全角空格、连着的空白。 */
function tidy(raw) {
  return String(raw ?? '')
    .replace(/[\u3000]{1,}/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[，,、；;]\s*$/, '')
    .trim()
}

/**
 * 「阿昭今年十七岁，眼睛是灰色的。」这种句子，第二个属性没有重复名字。
 *
 * 要不要把「眼睛是灰色的」算到阿昭头上？算——这是中文最自然的写法，
 * 不算就等于漏掉书里大多数外貌设定。但只在一种情况下算：**同一句里，
 * 前面已经明确出现过这个名字**。跨句不猜（下一句的「他」可能是别人），
 * 隔着一个已经属于别人的属性也不猜（那会造出真·假矛盾）。
 *
 * 这里的做法是给每条规则额外跑一遍「无名版本」，只在同句已认主时采用。
 */
const BARE_RULES = [
  { attr: 'age', re: new RegExp(`(?:^|[，、；])\\s*(?:今年|年方|年仅|已经|已)?\\s*(${NUM})\\s*岁`) },
  { attr: 'height', re: new RegExp(`(?:^|[，、；])\\s*(?:身高|个头|身量)\\s*(?:有|约|大约|差不多)?\\s*(\\d{2,3}|[一二三四五六七八九十百]{2,6})\\s*(?:厘米|公分|cm)`) },
  { attr: 'eye', re: new RegExp(`(?:^|[，、；])\\s*(?:一双)?(?:眼睛|双眸|眼瞳|瞳色)(?:是|为|呈)?\\s*([\\u4e00-\\u9fa5]{1,2}色)`) },
  { attr: 'hair', re: new RegExp(`(?:^|[，、；])\\s*(?:头发|发色)(?:是|为)?\\s*([\\u4e00-\\u9fa5]{1,2}色)`) },
]

/** 这个人在这段文字里被冠上过的所有属性。只有名字完全相等才算。 */
export function attrMentions(text, name) {
  const src = String(text ?? '')
  const out = []
  for (const rule of ATTR_RULES) {
    // 全局扫：同一个人在同一段里可能出现两次。
    const re = new RegExp(rule.re.source, 'g')
    let m
    while ((m = re.exec(src)) !== null) {
      const who = String(m[1] ?? '').trim()
      if (who !== name) continue
      const rawValue = String(m[m.length - 1] ?? '').trim()
      const value = rule.attr === 'age' || rule.attr === 'height' ? cnum(rawValue) : rawValue
      if (value === null || value === '') continue
      out.push({
        attr: rule.attr,
        value,
        raw: rawValue,
        sentence: sentenceAt(src, m.index, m.index + m[0].length),
        at: m.index,
      })
    }
  }
  // 第二遍：同一句里已经认过主的，把后面不带名字的属性句也算进来。
  const owned = out.map((x) => sentenceAt(src, x.at, x.at))
  for (const rule of BARE_RULES) {
    const re = new RegExp(rule.re.source, 'g')
    let m
    while ((m = re.exec(src)) !== null) {
      const value0 = String(m[m.length - 1] ?? '').trim()
      const value = rule.attr === 'age' || rule.attr === 'height' ? cnum(value0) : value0
      if (value === null || value === '') continue
      const sentence = sentenceAt(src, m.index, m.index + m[0].length)
      // 这一句必须已经有这个名字的记录，否则不知道是谁的。
      if (!owned.includes(sentence)) continue
      // 同一个值已经在前面记过了就不再补一条：`阿昭十七岁，十七岁` 这种
      // 重复句式会记两遍，界面上同一条线索出现两次。
      if (out.some((x) => x.attr === rule.attr && x.value === value && x.sentence === sentence)) continue
      out.push({ attr: rule.attr, value, raw: value0, sentence, at: m.index })
    }
  }
  return out
}

/**
 * 从正文里认人。
 *
 * 只走两条路：被说话动词跟着的（`阿昭笑道`），被冠上属性的（`阿昭十七岁`）。
 * 两条都要过 looksLikeName。为什么不用「出现两次就算人」这种宽松判据：
 * 一本三十万字的书里，「忽然」「片刻」各出现几百次，全套进人名表之后，
 * 每一章都要拿它们当人名去比对属性，慢且毫无意义。
 */
export function harvestPeople(chapters) {
  const stat = new Map()
  const bump = (name, kind) => {
    if (!looksLikeName(name)) return
    if (!stat.has(name)) stat.set(name, { name, speaks: 0, attrs: 0 })
    const one = stat.get(name)
    if (kind === 'speak') one.speaks += 1
    else one.attrs += 1
  }
  for (const chapter of chapters) {
    // 引号里的话不是书在交代设定，是角色在说话。里面出现的人名不能当
    // 「这个人在这一章露过面」用，否则一句「阿昭早就死了」就能伪造一条死亡记录。
    const body = stripQuoted(String(chapter?.body ?? ''))
    if (body === '') continue
    let m
    const speak = new RegExp(SPEAK_RE.source, 'g')
    while ((m = speak.exec(body)) !== null) {
      if (!leftEdgeOk(body, m.index)) continue
      // 「张三说道：」这里，说话动词表里的「说」比「说道」短，懒惰匹配会先
      // 停在「说」，后面跟着的是「道」不是停顿，整条就被 tail 判据拒掉了。
      // 所以尾巴判据要顺着往后多看几个字：把紧跟着的说话动词也吞进去再判。
      let endAt = m.index + m[0].length
      const rest = new RegExp(`^(?:${SPEAK_WORDS})?`).exec(body.slice(endAt))
      if (rest !== null && rest[0] !== '') endAt += rest[0].length
      if (!speakTailOk(body, endAt)) continue
      bump(String(m[1] ?? '').trim(), 'speak')
    }
    for (const rule of ATTR_RULES) {
      const re = new RegExp(rule.re.source, 'g')
      while ((m = re.exec(body)) !== null) {
        if (!leftEdgeOk(body, m.index)) continue
        // 属性的值本身还要过一道：抽出来的「值」得真的像个值。
        // 「机制照 → 三」这种，是把「照三」当成等级序号了。
        const raw = String(m[m.length - 1] ?? '').trim()
        if (rule.attr === 'age' || rule.attr === 'height') {
          const n = cnum(raw)
          // 年龄只收 1–150，身高只收 50–260。超出这个范围的一定不是人的属性，
          // 是「三百年」「一万里」这种别的东西被模板蹭到了。
          if (n === null) continue
          if (rule.attr === 'age' && (n < 1 || n > 150)) continue
          if (rule.attr === 'height' && (n < 50 || n > 260)) continue
        }
        bump(String(m[1] ?? '').trim(), 'attr')
      }
    }
  }
  const people = []
  for (const one of stat.values()) {
    // 有一条属性记录就够判定了（「阿昭十七岁」）。只说了一句台词的也算：
    // 「张三说道」这种句式本身就是强证据——不是名字的四个字后面接「说道」，
    // 在中文里几乎不成立。以前这里要求说话满两次，于是只在开头和结尾各
    // 露一次面的关键角色全被漏掉，而「死了又出场」正是这种人身上最常见。
    if (one.attrs === 0 && one.speaks === 0) continue
    people.push(one)
  }
  people.sort((a, b) => (b.attrs * 2 + b.speaks) - (a.attrs * 2 + a.speaks) || a.name.localeCompare(b.name))
  return people
}

/**
 * 死活：谁在哪一章死了。
 *
 * 这是全书最硬的一条线索，也是网文里最常见的「吃书」：人明明死了，
 * 后面又推门进来。所以单独一套模板，不并进 ATTR_RULES——它的判定
 * 不是「值不同」，而是「死在前、活在后」，方向性更强。
 */
const DEATH_RES = [
  new RegExp(`([\\u4e00-\\u9fa5]{2,4}?)\\s*(?:就|便|终于|当场)?\\s*(?:死了|身亡|断气|咽气|殒命|陨落|阵亡)`),
  new RegExp(`([\\u4e00-\\u9fa5]{2,4}?)\\s*(?:被|遭)[^，。！？]{0,12}(?:杀死|害死|打死|刺死)`),
]

/**
 * 这几句不是「他死了」：是假设、是骂人、是「差点死」。
 *
 * 以前不挡这些，一本书里凡是写「你要是死了」的地方都会被当成死亡记录，
 * 然后全书每一处他出场都成了矛盾——一份满是假阳性的报告没人会再看第二眼。
 */
const DEATH_FALSE = /要是|如果|若是|若非|万一|倘若|假使|差点|险些|几乎|怕是要|也不会|不会死|不能死|不该死|该死|死了算了|死了一样|死也要|死都不|至死|装作|假装|诈死|死了又|死后|遗言|尸|棺材|坟墓|祭|追悼/

/**
 * 一句话里，死亡词前面有没有「假设/否定」的成分。
 *
 * DEATH_FALSE 只在同一句里搜，而「你要是死了」这种句子，条件词
 * 和死亡词之间常隔着好几个字（「你要是就这样死了」）。所以判定放宽到
 * 「死亡词之前 12 个字以内出现条件词」——这不影响真死亡（「他死了」
 * 前面 12 个字里不会有「要是」），但能挡住假设句。
 */
function looksHypothetical(sentence, atInSentence) {
  const head = String(sentence ?? '').slice(0, Math.max(0, atInSentence))
  return /要是|如果|若是|若非|万一|倘若|假使|差点|险些|几乎|不会|不能|不该|别|莫要/.test(head)
}

/** 引号与转述里的话不能当事实：那是角色说的话，不是书的设定。 */
function stripQuoted(text) {
  return String(text ?? '').replace(/「[^」]*」|“[^”]*”|『[^』]*』|"[^"]*"/g, (m) => '　'.repeat(m.length))
}

/**
 * 把整本书扫一遍，产出一份「观察记录」：谁、哪一项、什么值、在哪一章哪一句。
 *
 * 返回的 `observations` 是原始事实，不做任何判断；判断在 `findHoles` 里。
 * 分开是为了能单独测：抽取错了是抽取的事，判定错了是判定的事。
 */
export function scanBook(chapters, options = {}) {
  const list = Array.isArray(chapters) ? chapters : []
  const extra = Array.isArray(options.people) ? options.people : []
  const people = harvestPeople(list)
  // 人名表 = 认出来的人 + 用户点名的人。用户点的照收（他比我清楚书里有谁），
  // 但也要过 looksLikeName，免得手滑点了个空格或一句话进来。
  const names = new Set([
    ...people.map((p) => p.name),
    ...extra.filter((x) => typeof x === 'string' && looksLikeName(x)).map((x) => x.trim()),
  ])
  // 别名：用户给的 { 本名: [别名...] }。别名并到本名上，否则「阿昭」和「昭姐」
  // 会被当成两个人，各自成一套记录，谁也不会跟谁比。
  const aliasOf = new Map()
  const aliasMap = options.alias && typeof options.alias === 'object' ? options.alias : {}
  for (const [main, others] of Object.entries(aliasMap)) {
    const key = String(main ?? '').trim()
    if (key === '') continue
    names.add(key)
    const arr = Array.isArray(others) ? others : [others]
    for (const one of arr) {
      const alt = String(one ?? '').trim()
      if (alt === '' || alt === key) continue
      aliasOf.set(alt, key)
      names.add(alt)
    }
  }
  const canon = (name) => aliasOf.get(name) ?? name

  const observations = []
  const deaths = []
  // 出场记录：谁在哪一章说过话。判定「死了又出场」时用的是这一份而不是
  // 属性观察——一个人死而复现，最典型的样子是「他又开口说话」，
  // 而不是「他又被报了一次身高」。以前只靠属性观察，于是全靠属性撑着的
  // 那份记录里，一句台词都不算数，死了又回来这件事永远报不出来。
  const appearances = []
  for (const chapter of list) {
    const index = Number(chapter?.index ?? 0)
    const body = stripQuoted(String(chapter?.body ?? ''))
    if (body === '') continue
    for (const name of names) {
      for (const hit of attrMentions(body, name)) {
        observations.push({
          who: canon(name),
          shown: name,
          attr: hit.attr,
          value: hit.value,
          raw: hit.raw,
          chapter: index,
          sentence: hit.sentence,
        })
      }
      // 他在这一章说过话吗？说了就记一次出场。
      const speakRe = new RegExp(`${escapeRe(name)}\\s*(?:${SPEAK_WORDS})`, 'g')
      if (speakRe.test(body)) {
        const m2 = new RegExp(`${escapeRe(name)}[^，。！？]{0,4}`, 'g').exec(body)
        appearances.push({
          who: canon(name),
          chapter: index,
          sentence: m2 === null ? '' : sentenceAt(body, m2.index, m2.index + m2[0].length),
        })
      }
      // 死活单独扫，理由见 DEATH_FALSE 上面那段。
      for (const re of DEATH_RES) {
        const g = new RegExp(re.source, 'g')
        let m
        while ((m = g.exec(body)) !== null) {
          if (String(m[1] ?? '').trim() !== name) continue
          const sentence = sentenceAt(body, m.index, m.index + m[0].length)
          if (DEATH_FALSE.test(sentence)) continue
          // 死亡词在这句话里的位置：用它判断前面有没有「要是」「如果」。
          const atIn = sentence.indexOf(m[0])
          if (atIn >= 0 && looksHypothetical(sentence, atIn)) continue
          deaths.push({ who: canon(name), shown: name, chapter: index, sentence, at: m.index })
        }
      }
    }
  }
  // names 只留本名：别名并到本名之后，「昭姐」不该再作为一个人出现，
  // 否则界面上会显示「认出 2 个人」，其实是同一个人。
  const canonNames = [...new Set([...names].map(canon))]
  return {
    names: canonNames,
    people: [...new Set(people.map((p) => canon(p.name)))],
    observations, deaths, appearances,
  }
}

/**
 * 判定：同一项属性前后不一样，就是矛盾。
 *
 * 两条规矩：
 *   1. 只有**两个不同章节**给出的值不同才算——同一章里写两遍不同值，
 *      多半是初稿手误，也可能是回忆里的另一个人，报出来太吵。
 *   2. 数字取最早和最晚那一次比，中间不管。中间出现第三种值，
 *      单独再报一条——那通常意味着作者改设定改到一半。
 */
/** 把一对互相矛盾的记录变成一条给人看的线索。 */
function oneHole(first, last) {
  const mode = ATTR_MONOTONIC[first.attr] ?? 'flat'
  const verb = mode === 'up' ? '倒回去了' : '变来变去'
  return {
    kind: 'attr',
    severity: 'hard',
    attr: first.attr,
    who: first.who,
    // 摆在最前面的是「它到底是什么问题」，用户扫一眼就知道要不要看。
    title: `${first.who}的${ATTR_LABEL[first.attr] ?? first.attr}${verb}`,
    detail: `第 ${first.chapter} 章写「${first.raw}」，第 ${last.chapter} 章写「${last.raw}」`,
    left: { chapter: first.chapter, sentence: first.sentence, raw: first.raw },
    right: { chapter: last.chapter, sentence: last.sentence, raw: last.raw },
  }
}

export function findHoles(scan) {
  const observations = Array.isArray(scan?.observations) ? scan.observations : []
  const deaths = Array.isArray(scan?.deaths) ? scan.deaths : []
  const appearances = Array.isArray(scan?.appearances) ? scan.appearances : []
  const holes = []

  // 按「谁 + 哪一项」分组。
  const byKey = new Map()
  for (const one of observations) {
    const key = `${one.who}\u0000${one.attr}`
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(one)
  }

  for (const [, list] of byKey) {
    const sorted = [...list].sort((a, b) => a.chapter - b.chapter || a.at - b.at)
    // 只比「最早 vs 最晚」是不够的：第 1 章十七岁、第 5 章十九岁、第 8 章
    // 又回到十七岁，两个端点一模一样，中间那个十九岁就被整个跳过——
    // 而这恰恰是最典型的一种吃书（改设定改了一半）。
    // 所以要逐对看：拿「目前为止见过的最高/最近那个值」跟下一次比。
    let best = sorted[0]
    for (let i = 1; i < sorted.length; i += 1) {
      const now = sorted[i]
      if (now.chapter === best.chapter) {
        // 同一章里两个不同的值：初稿手误，也可能是两个人在一句话里被混了，
        // 报出来太吵，先不管，但把 best 换成后出现的那个。
        best = now
        continue
      }
      if (!isConflict(now.attr, best, now)) {
        // 没冲突：把 best 推进到「更新的那个」。单调属性要取更大的，
        // 否则「十七 → 十九 → 十七」在第二步会拿十七去比十七，判不出倒退。
        if ((ATTR_MONOTONIC[now.attr] ?? 'flat') === 'up'
          && typeof best.value === 'number' && typeof now.value === 'number' && now.value > best.value) {
          best = now
        }
        continue
      }
      holes.push(oneHole(best, now))
      best = now
    }
  }

  // 死了又出场：死亡那一章之后，还有他说话或带属性的记录。
  // 两份都看——只带属性（「他又被报了一次身高」）和只说话（「他又开口」）
  // 都说明这个人还在书里活着，任一出现都是矛盾。
  const lastSeen = new Map()
  for (const one of [...observations, ...appearances]) {
    const prev = lastSeen.get(one.who) ?? 0
    if (one.chapter > prev) lastSeen.set(one.who, one.chapter)
  }
  const seenDeath = new Map()
  for (const d of deaths) {
    // 同一个人的多次「死」只说第一次：后来那些多半是回忆、是传闻、
    // 是别人的同名，全报出来等于把一条真问题埋了。
    if (seenDeath.has(d.who)) continue
    seenDeath.set(d.who, d)
  }
  for (const [who, d] of seenDeath) {
    const after = lastSeen.get(who) ?? 0
    if (after <= d.chapter) continue
    const later = [...observations, ...appearances]
      .filter((x) => x.who === who && x.chapter > d.chapter)
      .sort((a, b) => a.chapter - b.chapter)[0]
    holes.push({
      kind: 'dead',
      severity: 'hard',
      attr: 'alive',
      who,
      title: `${who}死了之后又出场`,
      detail: `第 ${d.chapter} 章写「死了」，第 ${after} 章还在`,
      left: { chapter: d.chapter, sentence: d.sentence, raw: '死了' },
      right: later === undefined
        ? { chapter: after, sentence: '', raw: '' }
        : { chapter: later.chapter, sentence: later.sentence, raw: later.raw },
    })
  }

  // 排序：硬问题在前；同样硬的，章号靠后的先说——越晚出的错，越可能是
  // 写着写着忘了，也越值得马上回头改。
  holes.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'hard' ? -1 : 1
    return (b.right.chapter ?? 0) - (a.right.chapter ?? 0)
  })
  return holes
}

/**
 * 一份能拿走的报告（Markdown）。
 *
 * 为什么要能导出：作者拿着这份东西去改稿，对着屏幕一条条点太慢；
 * 存成文件可以在编辑器里逐条划掉，也能贴进自己的写作日志。
 */
export function renderReport(bookTitle, holes, summary = {}) {
  const title = String(bookTitle ?? '').trim() === '' ? '这本书' : String(bookTitle).trim()
  const lines = [`# 《${title}》吃书检查`, '']
  const chapters = Number(summary.chapters ?? 0)
  const chars = Number(summary.chars ?? 0)
  lines.push(`扫了 ${chapters} 章、${chars} 字，找出 ${holes.length} 处对不上的地方。`, '')
  if (holes.length === 0) {
    lines.push('没找到能坐实的矛盾。', '')
    lines.push('这只说明「数字、死活」这一类硬冲突没有，说服不了人的地方还得自己读。', '')
    return lines.join('\n')
  }
  for (const one of holes) {
    lines.push(`## ${one.title}`)
    lines.push('')
    lines.push(`- 说法一（第 ${one.left.chapter} 章）：${one.left.sentence}`)
    lines.push(`- 说法二（第 ${one.right.chapter} 章）：${one.right.sentence}`)
    lines.push('')
  }
  return lines.join('\n')
}

export default {
  ATTR_LABEL,
  SEVERITY_LABEL,
  cnum,
  looksLikeName,
  harvestPeople,
  attrMentions,
  scanBook,
  findHoles,
  renderReport,
}
