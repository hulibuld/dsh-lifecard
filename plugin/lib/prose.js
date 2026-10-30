/**
 * 顺手数一下「像 AI 写的」那些地方。
 *
 * 模型审稿（`novel.chapter.review`）问的是「哪里卡住、哪里不信、哪里想跳过」，
 * 那是读者的判断，靠它自己读。但有一类毛病不靠判断也能数出来：
 * 「不是…而是…」连着用了四次、「瞳孔一缩」出现了三次、每五百字五个「似乎」。
 * 这种地方人一眼看不出密度，数出来才知道。
 *
 * 所以这里做的是**统计**，不是评价：只报告「哪个说法出现了几次、举一句原文」，
 * 不替作者改句子，也不说「这段写得不好」。
 *
 * 三条纪律：
 * 1. 只数，不判。这里没有分数，也没有「合格/不合格」。
 * 2. 举原句要举完整的短句，让人能自己判断是不是该改。
 * 3. 查不到就说查不到，不要为了显得有用而凑数。
 */

/** 严重程度只是「先看哪个」的顺序，不是错误等级。 */
const ORDER = { 先看: 0, 顺便看: 1 }

/** 一、套话：说出来等于没说，删掉不影响任何信息。 */
const FILLER_WORDS = [
  ['此外', '删掉，或者直接接着说下一件事'],
  ['总而言之', '删掉，接着写就行'],
  ['综上所述', '删掉'],
  ['不可否认', '改成「确实」，或者直接陈述'],
  ['显而易见', '删掉，把看得见的东西写出来'],
  ['值得注意的是', '删掉，直接写值得注意的那件事'],
  ['需要指出的是', '删掉'],
  ['众所周知', '删掉'],
  ['从某种意义上说', '删掉，直接说'],
  ['不言而喻', '删掉，让读者自己体会'],
  ['意味深长', '用具体的话或表情替代'],
]

/** 二、句式：不是错，是密度一高就露出「同一个脑子在写」。 */
const PATTERNS = [
  [/不是[^。！？\n]{1,30}而是/g, '先说什么不是什么，再另起一句说什么', '先看'],
  [/没有[^。！？\n]{1,30}只是/g, '直接陈述事实', '先看'],
  [/让[^。！？\n]{1,15}(?:感到|觉得|意识到|想起)/g, '去掉「让」，写他自己感到的那个动作', '先看'],
  [/令[^。！？\n]{1,15}(?:感到|觉得|想起)/g, '同上', '先看'],
  [/与此同时/g, '「同时」或「这时候」', '先看'],
  [/当[^。！？\n]{1,40}时/g, '拆成两句，别把时间条件套在前面', '顺便看'],
  [/于是[^。！？\n]{1,20}然而/g, '拆成两句', '顺便看'],
  [/随即[^。！？\n]{1,20}紧接着/g, '留一个连接词就够', '顺便看'],
  [/不禁[^。！？\n]{0,8}/g, '直接写动作', '顺便看'],
]

/** 三、身体模板：情绪一动就用同一套身体反应。 */
const BODY = [
  [/瞳孔[^。！？\n]{0,5}(?:缩|一缩)/g, '写他眼睛具体在看什么', '顺便看'],
  [/身体[^。！？\n]{0,5}(?:一僵|僵住|僵了)/g, '「他停住了」「动作顿了一下」', '顺便看'],
  [/倒(?:吸|抽)[^。！？\n]{0,5}凉气/g, '写他在那儿看到了什么', '顺便看'],
  [/呼吸[^。！？\n]{0,5}(?:一滞|滞住)/g, '「他屏住呼吸」或者删掉', '顺便看'],
  [/心头[^。！？\n]{0,5}(?:一暖|暖了|暖)/g, '写身上哪儿热了一下', '顺便看'],
  [/心里[^。！？\n]{0,5}(?:一沉|沉了|沉)/g, '「胃里一阵发紧」或「手脚发凉」', '顺便看'],
  [/嘴角[^。！？\n]{0,5}(?:勾起|上扬|翘起)/g, '写他脸上具体的表情', '顺便看'],
  [/眼神[^。！？\n]{0,5}(?:闪烁|游移)/g, '写他在躲什么', '顺便看'],
]

/** 四、大词：本来要具体写的地方，用一个大词糊过去。 */
const BIG_WORDS = [
  ['至关重要', '「关键」「要命」'],
  ['深入探讨', '写他们真的说了什么'],
  ['充满活力', '写具体在动的东西'],
  ['不可磨灭', '写那件事本身'],
  ['焕然一新', '写变了什么'],
  ['翻天覆地', '写变了什么'],
  ['命运的齿轮', '删掉'],
  ['无声地诉说', '写它具体是什么样子'],
  ['空气中弥漫着', '写闻到的、看到的'],
  ['交织在一起', '写两件事怎么缠上的'],
]

/** 五、形容词脱钩：把一个挂在物件上的词，摘下来挂到抽象的东西上（「他做事很平」）。 */
const DETACHED = [
  [
    /(?:做法|判断|方案|稿子|这话|这句话|逻辑|节奏|关系|思路|风格|口气|语气)(?:很|挺|太|够|有点|特别|十分|非常)?(?:稳|平|沉|轻|重)/g,
    '「稳」是车和地基的属性，「平」是地的属性。写清他做了什么，别把物件上的词摘下来挂到做法上',
    '先看',
  ],
  [
    /(?:做事|做人|办事|下笔|分析|推理)(?:很|挺|太|够|有点|特别)?(?:稳|平|沉|轻|重)/g,
    '同上：把它翻成他到底在做什么动作',
    '先看',
  ],
]

/** 六、糊词：一个两个是语气，一堆就是没想清楚。 */
const FUZZY = ['似乎', '也许', '大概', '仿佛', '好像', '隐约', '莫名', '某种', '一丝', '些许']

/** 每 500 字允许几个糊词（超过就算「太多」）。 */
const FUZZY_PER_500 = 3

/** 取命中位置前后一小段，人能看出是哪一句。 */
function excerpt(text, index, length) {
  const start = Math.max(0, index - 10)
  const end = Math.min(text.length, index + length + 10)
  const cut = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return cut.length > 32 ? `${cut.slice(0, 32)}…` : cut
}

function countOf(text, word) {
  let count = 0
  let from = 0
  for (;;) {
    const at = text.indexOf(word, from)
    if (at < 0) return count
    count += 1
    from = at + word.length
  }
}

/**
 * 数一遍。
 * @param {string} text 正文
 * @returns {{chars:number,total:number,byOrder:object,hits:Array,fuzzy:object}}
 */
export function scanProse(text) {
  const source = String(text ?? '')
  const chars = source.replace(/\s+/g, '').length
  const hits = []

  for (const [word, advice] of FILLER_WORDS) {
    const count = countOf(source, word)
    if (count === 0) continue
    const at = source.indexOf(word)
    hits.push({ kind: 'filler', label: `「${word}」`, count, advice, sample: excerpt(source, at, word.length), order: '先看' })
  }

  for (const [pattern, advice, order] of PATTERNS) {
    const found = []
    pattern.lastIndex = 0
    let match = pattern.exec(source)
    while (match !== null) {
      found.push({ index: match.index, text: match[0] })
      if (found.length >= 20) break
      match = pattern.exec(source)
    }
    if (found.length === 0) continue
    hits.push({
      kind: 'pattern',
      label: patternLabel(found[0].text),
      count: found.length,
      advice,
      sample: excerpt(source, found[0].index, found[0].text.length),
      order,
    })
  }

  for (const [pattern, advice, order] of BODY) {
    const found = []
    pattern.lastIndex = 0
    let match = pattern.exec(source)
    while (match !== null) {
      found.push({ index: match.index, text: match[0] })
      if (found.length >= 20) break
      match = pattern.exec(source)
    }
    if (found.length === 0) continue
    hits.push({
      kind: 'body',
      label: `「${found[0].text}」这类身体反应`,
      count: found.length,
      advice,
      sample: excerpt(source, found[0].index, found[0].text.length),
      order,
    })
  }

  for (const [pattern, advice, order] of DETACHED) {
    const found = []
    pattern.lastIndex = 0
    let match = pattern.exec(source)
    while (match !== null) {
      found.push({ index: match.index, text: match[0] })
      if (found.length >= 20) break
      match = pattern.exec(source)
    }
    if (found.length === 0) continue
    hits.push({
      kind: 'detached',
      label: `「${found[0].text}」这类说法`,
      count: found.length,
      advice,
      sample: excerpt(source, found[0].index, found[0].text.length),
      order,
    })
  }

  for (const [word, advice] of BIG_WORDS) {
    const count = countOf(source, word)
    if (count === 0) continue
    const at = source.indexOf(word)
    hits.push({ kind: 'big', label: `「${word}」`, count, advice, sample: excerpt(source, at, word.length), order: '先看' })
  }

  let fuzzyCount = 0
  for (const word of FUZZY) fuzzyCount += countOf(source, word)
  const per500 = chars === 0 ? 0 : Math.round((fuzzyCount / (chars / 500)) * 10) / 10
  const fuzzy = { count: fuzzyCount, per500, tooMany: chars >= 500 && per500 > FUZZY_PER_500 }

  hits.sort((a, b) => (ORDER[a.order] ?? 9) - (ORDER[b.order] ?? 9) || b.count - a.count)
  const byOrder = { 先看: 0, 顺便看: 0 }
  for (const hit of hits) byOrder[hit.order] = (byOrder[hit.order] ?? 0) + hit.count

  return {
    ok: true,
    chars,
    total: hits.reduce((sum, hit) => sum + hit.count, 0),
    byOrder,
    hits,
    fuzzy,
  }
}

/** 正则命中的原句开头几字，用来当标签（「不是…而是」）。 */
function patternLabel(matched) {
  const text = String(matched ?? '')
  if (text.startsWith('不是')) return '「不是…而是」这种句式'
  if (text.startsWith('没有')) return '「没有…只是」这种句式'
  if (/^让/.test(text)) return '「让某人感到/觉得」这种句式'
  if (/^令/.test(text)) return '「令人感到」这种句式'
  if (text.startsWith('与此同时')) return '「与此同时」'
  if (/^当/.test(text)) return '「当…时」这种句式'
  if (/^于是/.test(text)) return '「于是…然而」连着用'
  if (/^随即/.test(text)) return '「随即…紧接着」连着用'
  if (/^不禁/.test(text)) return '「不禁…」'
  return `「${text.slice(0, 6)}」这类句式`
}

/**
 * 把数出来的结果写成一段人能读的话。
 * 一条都没有时返回空串（调用方就别贴一段「没查出问题」占地方）。
 */
export function proseReportText(scan) {
  const data = scan && scan.ok === true ? scan : null
  if (data === null) return ''
  const lines = []

  for (const hit of data.hits) {
    // 只出现一次、篇幅又短：算不上密度问题，别拿一条孤例占版面。
    // 但一章里出现一次「命运的齿轮」也值得说，所以门槛按篇幅走。
    // 套话与大词出现一次就该看见；句式与身体模板要成密度才说，否则一句一个不算毛病。
    if (hit.kind !== 'filler' && hit.kind !== 'big' && hit.kind !== 'detached' && hit.count < 2 && data.chars < 800) continue
    lines.push(`- ${hit.label}用了 ${hit.count} 次，例如「${hit.sample}」——${hit.advice}`)
  }
  if (data.fuzzy.tooMany === true) {
    lines.push(`- 「似乎 / 大概 / 仿佛」这类词每五百字 ${data.fuzzy.per500} 个（一共 ${data.fuzzy.count} 个）——想清楚的地方不用这些词`)
  }

  return lines.join('\n')
}
