/**
 * LifeCard jobs/interview —— 模拟面试：一个会质询、会反复追问的面试官。
 *
 * 跟这个项目里别的地方一样，**判断都在本地做，模型只负责开口说话**。
 * 模型给回来的问题要过三道闸：
 *   1. 问过的不许再问（去重）
 *   2. 不许问劳动法禁止问的东西（婚育、年龄、户籍、健康、宗教、政治面貌）
 *   3. 追问必须引用上一句答案里的**原话**，引不出来就是编的
 *
 * 第三条是这套东西能不能用的关键：一个「你刚才说你们团队三个人，
 * 那另外两个人为什么不背这块？」的追问，比十句「能详细说说吗」有用得多。
 * 而模型最擅长的恰恰是后者——所以要拿原文当尺子卡住它。
 *
 * 不联网、不调模型、不读盘。纯函数，好测。
 */

// 一轮最多问几题。超过这个数人就开始敷衍了，宁可在还认真的时候停下来。
export const MAX_TURNS = 8

// 一题答案低于这个字数基本等于没答（「还行」「还可以吧」）。
const MIN_ANSWER_CHARS = 30

/**
 * 面试问题不许碰的东西。
 *
 * 用户明确说了「不包括背调」——这里把它落成一条硬规则而不是提示词里的建议：
 * 《就业促进法》《妇女权益保障法》都禁止招聘环节问婚育，问年龄/户籍/健康
 * 在很多地方也属于就业歧视。一个「帮你练面试」的工具不该先教你去踩这些。
 */
export const FORBIDDEN_TOPICS = [
  { word: '婚', why: '不能问婚姻状况' },
  { word: '孕', why: '不能问生育打算' },
  { word: '生孩子', why: '不能问生育打算' },
  { word: '要孩子', why: '不能问生育打算' },
  { word: '孩子', why: '不能问生育打算' },
  { word: '备孕', why: '不能问生育打算' },
  { word: '年龄', why: '不能问年龄' },
  { word: '几岁', why: '不能问年龄' },
  { word: '多大', why: '不能问年龄' },
  { word: '出生年月', why: '不能问年龄' },
  { word: '户籍', why: '不能问户籍' },
  { word: '户口', why: '不能问户籍' },
  { word: '籍贯', why: '不能问籍贯' },
  { word: '民族', why: '不能问民族' },
  { word: '宗教', why: '不能问宗教信仰' },
  { word: '信仰', why: '不能问宗教信仰' },
  { word: '政治面貌', why: '不能问政治面貌' },
  { word: '党员', why: '不能问政治面貌' },
  { word: '乙肝', why: '不能问健康状况' },
  { word: '病史', why: '不能问健康状况' },
  { word: '体检报告', why: '不能问健康状况' },
  { word: '残疾', why: '不能问身体状况' },
  { word: '身高体重', why: '不能问身体条件' },
  { word: '有没有男朋友', why: '不能问婚恋状况' },
  { word: '有没有女朋友', why: '不能问婚恋状况' },
  { word: '谈恋爱', why: '不能问婚恋状况' },
  { word: '背调', why: '这一步不做背景调查' },
  { word: '背景调查', why: '这一步不做背景调查' },
]

/** 面试官的问题类型。顺序就是默认的提问节奏。 */
export const KINDS = ['gap', 'behavior', 'explain', 'pressure', 'motivation']

export const KIND_LABEL = {
  gap: '你材料里没写的',
  behavior: '让你讲一件具体的事',
  explain: '追一句为什么',
  pressure: '给你一点压力',
  motivation: '你图什么',
}

const KIND_RUBRIC = [
  '- gap：招聘说明要求了，但你材料里没有对应的经历。问的是「这种情况你打算怎么说」。',
  '- behavior：让他讲一件**真的发生过**的事。要用「哪一次」「哪个人」「最后怎么样」这种问法。',
  '- explain：接着他上一句话往下问为什么、怎么做到的。这一档最容易问出真东西。',
  '- pressure：把话说得紧一点，看他在被质疑的时候还站不站得住。不许人身攻击。',
  '- motivation：问他为什么想去这家、图什么。',
].join('\n')

/** 把一段文字压成一行，用来做比较。 */
function flat(s) {
  return String(s ?? '').replace(/\s+/g, '').replace(/[「」『』""''？?。，、！!：:；;]/g, '')
}

/**
 * 这个问题问过没有。
 *
 * 只比「去掉标点空白之后是否相同」会漏掉「那你为什么这么做？」和
 * 「为什么这么做呢」这种改写。所以再加一条：短问题看包含关系。
 */
export function alreadyAsked(question, asked) {
  const q = flat(question)
  if (q === '') return true
  for (const a of asked ?? []) {
    const prev = flat(a)
    if (prev === '') continue
    if (prev === q) return true
    // 短问题（≤14 字）被上一题包住，算重复：「为什么这么做」⊂「那你为什么这么做呢」
    if (Math.min(prev.length, q.length) <= 14 && (prev.includes(q) || q.includes(prev))) return true
  }
  return false
}

/**
 * 这个问题能不能问。返回 `null` 表示能问，否则返回一句人话说明。
 */
export function forbiddenIn(question) {
  const text = String(question ?? '')
  for (const item of FORBIDDEN_TOPICS) {
    if (text.includes(item.word)) return `这个问题不该问：${item.why}（「${item.word}」）`
  }
  return null
}

/**
 * 从招聘说明的要求里挑下一个该问什么。
 *
 * 顺序是定死的，不是随机：先问材料里没写的那几条（gap），
 * 那是最可能被面试官当面问穿的地方；问完再让人讲具体的事。
 * 这样即使模型这次不听话，用户也总能问到该问的。
 */
export function pickTarget(requirements, asked) {
  const list = Array.isArray(requirements) ? requirements : []
  // gap 优先：critical / high 排前面
  const rank = { critical: 0, high: 1, medium: 2, low: 3, bonus: 4 }
  const gaps = list
    .map((r, index) => ({ ...r, index }))
    .filter((r) => r.verdict === 'gap' || r.verdict === 'unclear')
    .filter((r) => !(asked ?? []).includes(`req:${r.index}`))
    .sort((a, b) => (rank[a.importance] ?? 9) - (rank[b.importance] ?? 9))
  if (gaps.length > 0) return { kind: 'gap', requirement: gaps[0] }
  const rest = list
    .map((r, index) => ({ ...r, index }))
    .filter((r) => r.verdict === 'match')
    .filter((r) => !(asked ?? []).includes(`req:${r.index}`))
  if (rest.length > 0) return { kind: 'behavior', requirement: rest[0] }
  return { kind: 'motivation', requirement: null }
}

/**
 * 不用模型也能问的问题。
 *
 * 这台机器上没配 AI、或者模型这次挂了，面试不应该直接开不了——
 * 从招聘说明和自己的材料里抠出来的问题本来就是最该练的那几句。
 */
export function offlineQuestion(target, ctx = {}) {
  const req = target?.requirement ?? null
  const what = String(req?.requirement ?? '').trim()
  const proof = String(req?.proof ?? '').trim()
  if (target?.kind === 'gap' && what !== '') {
    return `${what}——你材料里没有这一块。如果面试官现在就问你，你打算怎么说？`
  }
  if (target?.kind === 'behavior' && proof !== '') {
    return `你写过「${proof.slice(0, 40)}」。挑一次具体的，讲讲当时你到底做了什么。`
  }
  const company = String(ctx?.company ?? '').trim()
  if (target?.kind === 'motivation') {
    return company === ''
      ? '你为什么想换工作？说一件最近让你下决心的事。'
      : `你为什么想去${company}？别说它好，说你图什么。`
  }
  return '讲一件最近工作里让你为难的事。你当时怎么处理的，最后结果怎么样？'
}

/**
 * 拼这一轮的问题提示词。
 *
 * 关键在于把「已经问过的」和「他的上一句答案」原样交给模型，
 * 并要求它**从上一句里挑一个点往下追**，而不是另起一题。
 */
export function buildTurnPrompt(input) {
  const {
    company, role, requirements, transcript, target, focus, cvText, questionNo, reject,
  } = input

  const reqLines = (requirements ?? [])
    .map((r, i) => `${i}. [${r.importance ?? '?'} / ${r.verdict ?? '?'}] ${r.requirement ?? ''}`)
    .join('\n')

  const asked = (transcript ?? []).filter((t) => t.role === 'interviewer').map((t) => `- ${t.text}`).join('\n')
  const lastAnswer = [...(transcript ?? [])].reverse().find((t) => t.role === 'candidate')
  const lastQuestion = [...(transcript ?? [])].reverse().find((t) => t.role === 'interviewer')

  const targetLine = target?.requirement === null || target?.requirement === undefined
    ? '这一轮问「动机」：他为什么想去这家、图什么。'
    : `这一轮针对招聘说明第 ${target.requirement.index} 条：「${target.requirement.requirement ?? ''}」（重要度 ${target.requirement.importance ?? '?'}，他的情况 ${target.requirement.verdict ?? '?'}）`

  return [
    `你在一场模拟面试里当面试官。这是第 ${questionNo} 个问题。`,
    company === '' ? '' : `公司：${company}`,
    role === '' ? '' : `岗位：${role}`,
    '',
    '## 招聘说明拆出来的要求',
    reqLines === '' ? '（没有。）' : reqLines,
    '',
    '## 这一轮问什么',
    targetLine,
    target?.kind === 'pressure' ? '这一轮要有一点压力：把他的话往紧里问一句，看他站不站得住。' : '',
    '',
    '## 已经问过的（不许再问，换个角度）',
    asked === '' ? '（还没问过。）' : asked,
    '',
    lastQuestion === undefined ? '' : '## 你上一个问题',
    lastQuestion === undefined ? '' : lastQuestion.text,
    '',
    lastAnswer === undefined ? '' : '## 他刚才的回答（原话）',
    lastAnswer === undefined ? '' : lastAnswer.text,
    focus === undefined || focus === null ? '' : '## 这段回答里站不住的地方',
    focus === undefined || focus === null ? '' : focus,
    '',
    '## 他写过的东西（只能用来提问，不许替他补）',
    String(cvText ?? '').trim() === '' ? '（还没写材料。）' : String(cvText).slice(0, 3000),
    '',
    // 上一句被程序拦下时把原因带回来，让它换个问法重写一次。
    // 不告诉它为什么，它会原样再问一遍——那等于浪费一整轮。
    String(reject ?? '').trim() === '' ? '' : '## 你刚才那一句被拦下了',
    String(reject ?? '').trim() === '' ? '' : String(reject),
    String(reject ?? '').trim() === '' ? '' : '换个问法重写一句。不要在同一个坑里再掉一次。',
    '',
    '## 怎么问',
    '- **只问一个问题。**一长串问题他会只答最后一个。',
    '- 追问的时候，从他刚才那句话里挑一个具体的点往下问：哪一次、哪一层、谁不同意、怎么测的。',
    '- 不要问「能详细说说吗」这种空话。要问到能让他说出**具体的人、时间、数字、做法**。',
    '- 不许问婚育、年龄、户籍、民族、宗教、政治面貌、健康状况——这些是就业歧视，问了就是害他。',
    '- 不许做背景调查、不许让他提供前公司联系方式、不许要身份证号。',
    '- 不许评价他答得好不好、不许说「你会不会被录用」。你只提问。',
    '',
    '## 五种问法的意思',
    KIND_RUBRIC,
    '',
    '## 输出格式',
    '只输出 JSON，不要解释文字，不要 markdown 代码块：',
    '{"question": "你要问的那一句", "kind": "gap|behavior|explain|pressure|motivation",',
    ' "quoted": "如果你在追问他刚才那句话，把被追问的那句话原样抄在这里；不是追问就留空",',
    ' "why_ask": "你为什么问这一句（给写卡人看的，一句话）"}',
  ].filter((s) => s !== '').join('\n')
}

/**
 * 校验模型给出的这一问。
 *
 * 三道闸都在这里：去重、禁问、追问必须引用原话。
 * 哪一道没过就返回 `{ok:false, reason}`，调用方退回本地问题——
 * 宁可问一句朴素但站得住的问题，也不让用户看见一句编出来的追问。
 */
export function checkQuestion(raw, ctx = {}) {
  const reasons = []
  if (raw === null || typeof raw !== 'object') return { ok: false, reason: '这一问不是一个对象', question: null }

  const question = String(raw.question ?? '').trim()
  if (question === '') return { ok: false, reason: '这一问是空的', question: null }
  if (question.length > 300) return { ok: false, reason: '这一问太长了，面试官不会一口气说这么多', question: null }

  const ban = forbiddenIn(question)
  if (ban !== null) return { ok: false, reason: ban, question: null }

  if (alreadyAsked(question, ctx.asked)) {
    return { ok: false, reason: '这个问题问过了', question: null }
  }

  const kind = KINDS.includes(raw.kind) ? raw.kind : 'behavior'

  // 追问必须引用上一句答案里的原话。这是整件事的骨头：
  // 没有它，「反复追问」就退化成「能详细说说吗」。
  const quoted = String(raw.quoted ?? '').trim()
  const lastAnswer = String(ctx.lastAnswer ?? '')
  if (kind === 'explain' || kind === 'pressure') {
    if (lastAnswer !== '' && quoted === '') {
      return { ok: false, reason: '追问没有指出在追哪一句话', question: null }
    }
    if (quoted !== '' && lastAnswer !== '' && !lastAnswer.includes(quoted)) {
      return { ok: false, reason: '追问引用的那句话在他的回答里找不到', question: null }
    }
  }

  return {
    ok: reasons.length === 0,
    reason: reasons.join('；'),
    question: { question, kind, quoted, why_ask: String(raw.why_ask ?? '').trim() },
  }
}

/** 中文数字 + 量词。「四十多个人」「两周」「三份」都算有数，「一起」不算。 */
const CJK_SCALE = /[一二三四五六七八九十百千万两\d]+\s*(?:多\s*)?(?:个|人|次|天|周|月|年|篇|份|门|科|名|场|条|倍|小时|分钟|届|期|轮|版)/

/**
 * 本地给一次回答打分。
 *
 * 不打总分、不给「及格线」——那是培训机构的做法，而且分数会让人误解
 * 「我 80 分」等于「我稳了」。这里只说三件事：
 * 有没有具体的事、有没有说清你做了什么、有没有结果。
 */
export function reviewAnswer(answer) {
  const text = String(answer ?? '').trim()
  const findings = []
  const n = text.replace(/\s+/g, '').length

  if (n === 0) {
    return { length: 0, verdict: 'empty', findings: [{ code: 'empty', say: '这一题没答。' }] }
  }
  if (n < MIN_ANSWER_CHARS) {
    findings.push({ code: 'too-short', say: `只说了 ${n} 个字。面试里这么答，对方会以为你没做过。` })
  }

  // 「我做了什么」：第一人称 + 动作词。没有主语是很多人答面试的通病
  // （「然后我们就把它上线了」——听着像你只是站在旁边）。
  const didWords = /我(做|改|写|搭|拆|查|跑|上线|推|设计|负责|牵头|沟通|说服|重写|优化|测|盯|要|争取|扛)|我把|我让|我提|我找/
  const hasDoing = didWords.test(text)
  if (!hasDoing) findings.push({ code: 'no-action', say: '没听见「我做了什么」。面试官想听你自己动手的那部分。' })

  // 数字要认阿拉伯数字，也要认「四十多个人」这种中文数字。
  // 只认半角数字的话，一段明明白白带了规模的话会被判成「一个数字都没有」，
  // 那比不判更糟——用户会觉得这东西根本没在听。
  const hasNumber = /\d/.test(text) || CJK_SCALE.test(text)
  if (!hasNumber) findings.push({ code: 'no-number', say: '一个数字都没有。时间、人数、次数、涨了多少，随便补一个都更可信。' })

  const hasResult = /(结果|最后|后来|所以|因此|上线了|通过了|降到|提到|省了|少了|多了|解决|搞定|没成)/.test(text)
  if (!hasResult) findings.push({ code: 'no-result', say: '没说到结果。这件事最后怎么了？' })

  // 口头语堆太多会显得在拖时间。只数密集出现的，偶尔一个很正常。
  const fillers = (text.match(/其实|然后呢|就是说|那个|反正|大概吧|差不多|可能是/g) ?? []).length
  if (fillers >= 4) findings.push({ code: 'filler', say: `「其实」「然后」这类口头语出现了 ${fillers} 次，听着像在拖时间。` })

  // 先说结论还是先说背景：一上来就「我先说下背景」的人，常常说到一半就被打断。
  if (/^(先说一下?背景|背景是|这个事情是这样的)/.test(text)) {
    findings.push({ code: 'buried', say: '开头在铺垫。面试里先说结论，再补背景。' })
  }
  if (/^(不知道|不会|没做过|没有过|这个我不太)/.test(text)) {
    findings.push({ code: 'give-up', say: '一上来就说不会。可以说「我没直接做过，但有一件类似的事」，再讲那件。' })
  }

  const hard = findings.filter((f) => f.code === 'too-short' || f.code === 'empty').length
  const verdict = hard > 0 ? 'thin' : (findings.length === 0 ? 'solid' : 'okay')
  return { length: n, verdict, findings }
}

/**
 * 从一句回答里挑出最该被追问的那一处。
 *
 * 挑法是有讲究的：优先追「说了但没交代清楚」的地方——有结果没过程、
 * 有「我们」没有「我」、有形容词没有数字。这些正是真面试官会咬住的地方。
 */
export function pickFocus(answer) {
  const text = String(answer ?? '').trim()
  if (text === '') return null
  const review = reviewAnswer(text)
  const codes = review.findings.map((f) => f.code)
  if (codes.includes('no-number')) return '他没给任何数字。让他说清数量、时间或幅度。'
  if (codes.includes('no-action')) return '他通篇在说「我们」，没说自己做了什么。追他本人那部分。'
  if (codes.includes('no-result')) return '他讲完了过程却没讲结果。追「最后怎么样了」。'
  if (codes.includes('buried')) return '他在铺垫。打断他，直接要结论。'
  if (codes.includes('too-short')) return '他答得太短，明显在回避。追问一件具体的事。'
  // 答得还行：从最长的那一句里找一个可以往深里挖的词
  const sentences = text.split(/[。！？!?；;\n]/).map((s) => s.trim()).filter((s) => s.length >= 8)
  if (sentences.length === 0) return null
  const longest = sentences.sort((a, b) => b.length - a.length)[0]
  return `他有一句「${longest.slice(0, 50)}」。就往这一句里问：具体是哪一次、你当时怎么判断的。`
}

/** 一轮结束后的总结。仍然是描述，不打分。 */
export function summarize(session) {
  const turns = Array.isArray(session?.turns) ? session.turns : []
  const answered = turns.filter((t) => t.answer !== undefined && String(t.answer).trim() !== '')
  const skipped = turns.filter((t) => t.skipped === true)
  const allFindings = answered.flatMap((t) => (t.review?.findings ?? []).map((f) => f.code))
  const count = (code) => allFindings.filter((c) => c === code).length

  const lines = []
  lines.push(`一共问了 ${turns.length} 个问题，答了 ${answered.length} 个${skipped.length > 0 ? `，跳过 ${skipped.length} 个` : ''}。`)
  if (answered.length > 0) {
    const noNumber = count('no-number')
    const noAction = count('no-action')
    const noResult = count('no-result')
    if (noNumber > 0) lines.push(`有 ${noNumber} 次回答里一个数字都没有——这是最容易被追问的地方。`)
    if (noAction > 0) lines.push(`有 ${noAction} 次说完听不出你本人做了什么。多说「我」，少说「我们」。`)
    if (noResult > 0) lines.push(`有 ${noResult} 次讲了过程没讲结果。`)
    if (noNumber === 0 && noAction === 0 && noResult === 0) {
      lines.push('每一次回答都有具体的事、你自己的动作和结果。这个状态去面就行。')
    }
  }
  const gapsTouched = turns.filter((t) => t.kind === 'gap').length
  if (gapsTouched > 0) lines.push(`其中 ${gapsTouched} 个问的是你材料里没写的地方——这些最该提前准备。`)
  return { lines, answered: answered.length, turns: turns.length }
}

// ── 复盘报告 ──────────────────────────────────────────────────────
//
// 一场面试打完，只回一句「有 3 次没给数字」是不够用的。真正有用的复盘有七块：
// 一个总分、四档计数、按话题分组的分、四维雷达、优势与可提升两栏、
// 逐题卡片（题干 / 判定 / 你的原话 / 问题出在哪 / 更好的回答）、
// 以及「接下来练什么」。
//
// 其中「更好的回答」必须联网让模型写——但那一步最容易出事：模型会顺手把
// 用户没说的事编进去。所以它产出的每一句都要过 checkImprovement，
// 多出来的数字、多出来的大词，一律当场标出来，不给用户看。

/** 一题答成什么样算哪一档。判定复用 reviewAnswer 的 findings。 */
export function verdictOf(review) {
  const findings = Array.isArray(review?.findings) ? review.findings : []
  const codes = findings.map((f) => f.code)
  // 跳过有两种写法：题上直接标 skipped，或者答案被评成 empty。
  // 两个都得认——只认一个的话，没答的题会被算进「答得完整」，
  // 分数凭空变高，用户拿着这个分数去面试。
  if (review?.skipped === true) return 'skipped'
  if (review?.verdict === 'skipped') return 'skipped'
  if (codes.includes('empty')) return 'skipped'
  if (codes.includes('too-short')) return 'thin'
  if (codes.length >= 3) return 'thin'
  if (codes.length === 0) return 'solid'
  return 'okay'
}

/** 四档的中文说法。 */
export const VERDICT_LABEL = {
  solid: '答得完整',
  okay: '还能再补',
  thin: '答得太薄',
  skipped: '跳过了',
}

/** 四维雷达：这四样是面试官真正在听的。 */
const DIMENSIONS = [
  { key: 'action', label: '你自己做了什么', code: 'no-action' },
  { key: 'number', label: '有没有数', code: 'no-number' },
  { key: 'result', label: '有没有结果', code: 'no-result' },
  { key: 'focus', label: '有没有绕弯', code: 'filler', also: ['buried'] },
]

/**
 * 一场面试的复盘。
 *
 * 纯本地算。不含「更好的回答」——那一段要模型写，单独走 buildImprovePrompt。
 */
export function reviewReport(session) {
  const turns = Array.isArray(session?.turns) ? session.turns : []
  const rows = turns.map((t, i) => {
    const answer = String(t.answer ?? '').trim()
    const skipped = t.skipped === true
    const review = t.review ?? (skipped ? { length: 0, verdict: 'skipped', findings: [] } : reviewAnswer(answer))
    const verdict = verdictOf({ ...review, verdict: skipped ? 'skipped' : review.verdict })
    return {
      no: i + 1,
      question: String(t.question ?? ''),
      kind: String(t.kind ?? 'behavior'),
      kindLabel: KIND_LABEL[String(t.kind ?? 'behavior')] ?? '让你讲一件具体的事',
      answer,
      skipped,
      verdict,
      verdictLabel: VERDICT_LABEL[verdict],
      findings: Array.isArray(review.findings) ? review.findings : [],
      better: '',
    }
  })

  const answered = rows.filter((r) => r.skipped !== true && r.answer !== '')
  const counts = { solid: 0, okay: 0, thin: 0, skipped: 0 }
  for (const r of rows) counts[r.verdict] += 1

  // 总分：只按真答过的题算，跳过的题不参与——跳过等于没答，不该拉低分数，
  // 但也不该被算成满分。
  const weights = { solid: 100, okay: 70, thin: 35 }
  const score = answered.length === 0
    ? null
    : Math.round(answered.reduce((acc, r) => acc + (weights[r.verdict] ?? 0), 0) / answered.length)
  const grade = score === null ? '没答上题' : score >= 80 ? '这一场能打' : score >= 55 ? '有内容，但经不起追问' : '还得多练几场'

  // 按话题分组：同一个问法底下答得怎么样，看得出弱在哪一类问题上。
  const byKind = []
  for (const kind of KINDS) {
    const got = rows.filter((r) => r.kind === kind)
    if (got.length === 0) continue
    const real = got.filter((r) => r.verdict !== 'skipped')
    byKind.push({
      kind,
      label: KIND_LABEL[kind] ?? kind,
      turns: got.length,
      answered: real.length,
      score: real.length === 0 ? null : Math.round(real.reduce((acc, r) => acc + (weights[r.verdict] ?? 0), 0) / real.length),
    })
  }
  byKind.sort((a, b) => (a.score ?? 101) - (b.score ?? 101))

  // 四维雷达：每个维度看「有多少题没踩这个坑」。
  const dims = DIMENSIONS.map((dim) => {
    if (answered.length === 0) return { key: dim.key, label: dim.label, got: 0, max: 100 }
    const codes = [dim.code, ...(dim.also ?? [])]
    const clean = answered.filter((r) => !r.findings.some((f) => codes.includes(f.code))).length
    return { key: dim.key, label: dim.label, got: Math.round((clean / answered.length) * 100), max: 100 }
  })

  // 优势与可提升：按踩坑次数最多的两条、最少的这条分成两栏。
  const codeCount = new Map()
  for (const r of answered) {
    for (const f of r.findings) codeCount.set(f.code, (codeCount.get(f.code) ?? 0) + 1)
  }
  const ranking = [...codeCount.entries()].sort((a, b) => b[1] - a[1])
  const improves = ranking.slice(0, 3).map(([code, n]) => ({ code, times: n, say: SAY_OF[code] ?? '这里还能再具体一点。' }))
  const strengths = []
  const cleanDims = dims.filter((d) => d.got >= 80)
  for (const d of cleanDims) strengths.push(`${d.label}这一项没出过问题。`)
  if (answered.length > 0 && ranking.length === 0) strengths.push('每一题都有具体的事、你自己的动作和结果，这个状态去面就行。')
  if (rows.some((r) => r.kind === 'gap' && r.verdict !== 'skipped')) strengths.push('材料里没写的那些，你也能当场答上来——这一块提前想过。')

  // 接下来练什么：1–3 条，必须能明天就做。
  const next = []
  if (answered.length === 0) {
    next.push('这一场一题都没答。先挑一个最熟的事，从头到尾讲两分钟，再回来练。')
  } else {
    if (improves.some((one) => one.code === 'no-number')) next.push('下次开口前先想一个数：几个人、多久、几次、多少份。想不起来就估一个保守的。')
    if (improves.some((one) => one.code === 'no-action')) next.push('把「我们」全换成「我」讲一遍同一件事，录下来听。')
    if (improves.some((one) => one.code === 'no-result')) next.push('每讲完一件事，加一句「最后怎么样了」。没有结果就讲你学到了什么，别停在中途。')
    if (improves.some((one) => one.code === 'too-short')) next.push('用 STAR 的顺序把一件事讲够两分钟：情境两分、任务两分、你做的占大头、结果两分。')
    if (improves.some((one) => one.code === 'buried')) next.push('第一句话先说结论。把「我先说下背景」这句从习惯里删掉。')
    if (improves.some((one) => one.code === 'give-up')) next.push('被问到不会的，先说「我没直接做过，但有一件类似的」，再讲那件。')
    if (next.length === 0) next.push('按你自己的材料再练一场，换一个问法磨同一件事。')
  }

  return {
    score,
    grade,
    counts,
    answered: answered.length,
    turns: rows.length,
    byKind,
    dims,
    strengths: strengths.slice(0, 3),
    improves,
    cards: rows,
    next: next.slice(0, 3),
  }
}

/** 每种问题对应的那句话。和 reviewAnswer 里的措辞保持一致。 */
const SAY_OF = {
  'no-number': '答里没有数，听着像"做过一些"。',
  'no-action': '听不出你自己做了什么。',
  'no-result': '讲完了过程，没讲结果。',
  'too-short': '答得太短，对方会以为你没做过。',
  buried: '开头在铺垫，先说结论。',
  filler: '口头语偏多，听着像在拖时间。',
  'give-up': '一上来就说不会，把还能讲的那部分堵住了。',
  empty: '这一题没答。',
}

/**
 * 让模型把一题答案改成更好的那一版。
 *
 * 关键在于：只许用答案里已经出现过的事实重新组织，不许补新事实。
 * 三道具体的禁令写在提示词里，回来还要过 checkImprovement 再核一遍——
 * 光写在提示词里，模型会自作聪明地绕过去。
 */
export function buildImprovePrompt({ question, answer, kind } = {}) {
  const q = String(question ?? '').trim()
  const a = String(answer ?? '').trim()
  const system = [
    '你在帮人把一段面试回答改成更好的那一版。',
    '',
    '只做一件事：用他这段话里已经有的事实，重新组织一遍。',
    '',
    '三条绝对不许：',
    '- 不许加他原话里没有的事。原话没说带了几个人，就不许写「三个人」。',
    '- 不许加原话里没有的数字。「大概」「差不多」都不许替他定成一个数。',
    '- 不许替他编结果。原话只说做到一半，就停在做到一半。',
    '',
    '要做的：',
    '1. 第一句先说结论，不铺垫。',
    '2. 按情境 → 任务 → 你做了什么 → 结果的顺序排。你做的部分要占最大一块。',
    '3. 「我们」改成「我」——他本人做的那部分说清楚。',
    '4. 有数字的地方把数字说出来。',
    '5. 说话，不要写成书面语。这是他张嘴要说的话，不是简历条目。',
    '',
    '如果他这段话里实在没有结果，就在最后如实停住，然后另起一行写',
    '「还缺结果：这件事最后怎么样了，想起来补一句」。不要自己编一个。',
    '',
    '输出只有一个 JSON 对象，不要解释，不要 Markdown 围栏：',
    '{"better":"更好的那一版，说话口气","used":["用了他原话里的哪几个事实"],"added":"还缺什么，没有就给空串"}',
  ].join('\n')
  const user = [
    kind === undefined ? '' : `这一题问的是：${KIND_LABEL[kind] ?? '一件具体的事'}`,
    `问题：${q === '' ? '（没记下来）' : q}`,
    '',
    '他的回答：',
    a === '' ? '（这题他没答）' : a,
    '',
    '把这段改成更好的那一版。只能用上面已经出现的事实。',
  ].filter((one) => one !== '').join('\n')
  return { system, user }
}

/**
 * 检查模型改出来的那一版有没有编东西。
 *
 * 只在「多出数字」「多出大词」「多出职业名」这几件硬事上拦。
 * 语言上的重排不拦——那本来就是让它做的。
 */
export function checkImprovement(answer, better) {
  const a = String(answer ?? '')
  const b = String(better ?? '')
  const problems = []
  if (b.trim() === '') return { ok: false, problems: ['改写后是空的。'] }
  const beforeNums = new Set(a.match(/\d+(?:\.\d+)?/g) ?? [])
  for (const n of b.match(/\d+(?:\.\d+)?/g) ?? []) {
    if (!beforeNums.has(n)) problems.push(`多了一个他原话里没有的数：${n}`)
  }
  const BIG = ['主导', '牵头', '从零到一', '体系', '赋能', '闭环', '方法论', '顶层', '战略', '标杆', '颠覆', '卓越', '极致', '显著']
  for (const w of BIG) {
    if (b.includes(w) && !a.includes(w)) problems.push(`多了一个原话撑不起的词：「${w}」`)
  }
  if (b.length > Math.max(200, a.length * 3)) problems.push('改完比原话长了三倍多，这不像是说出来的话。')
  return { ok: problems.length === 0, problems }
}

/** 把整场面试写成能读的一段文字（存盘用）。 */
export function renderTranscript(session) {
  // 小标题之间必须留空行，否则 Markdown 会把「## 对话」和下一行揉成一行。
  // 这里不用 filter 去空串：空行本身是有意义的排版。
  const title = `# 模拟面试 · ${session?.company ?? ''}${session?.role === undefined || session.role === '' ? '' : ` · ${session.role}`}`
  const head = [
    title,
    '',
    `- 开始：${session?.started_at ?? ''}`,
    ...(session?.ended_at === undefined ? [] : [`- 结束：${session.ended_at}`]),
    '',
    '## 对话',
    '',
    '',
  ].join('\n')
  const body = (session?.turns ?? []).map((t, i) => {
    const lines = [`### ${i + 1}. ${t.question}`]
    if (t.kind !== undefined) lines.push(`（问法：${KIND_LABEL[t.kind] ?? t.kind}${t.why_ask === '' ? '' : ` · ${t.why_ask}`}）`)
    lines.push('')
    if (t.skipped === true) {
      lines.push('> （跳过了）')
    } else if (String(t.answer ?? '').trim() !== '') {
      lines.push(`**答：** ${String(t.answer).trim()}`)
      const findings = t.review?.findings ?? []
      if (findings.length > 0) {
        lines.push('')
        lines.push('**这里可以更好：**')
        for (const f of findings) lines.push(`- ${f.say}`)
      }
    } else {
      lines.push('> （还没答）')
    }
    lines.push('')
    return lines.join('\n')
  }).join('\n')
  const summary = summarize(session)
  return `${head}${body}\n## 这一场下来\n\n${summary.lines.map((l) => `- ${l}`).join('\n')}\n`
}

export default {
  MAX_TURNS,
  FORBIDDEN_TOPICS,
  KINDS,
  KIND_LABEL,
  alreadyAsked,
  forbiddenIn,
  pickTarget,
  offlineQuestion,
  buildTurnPrompt,
  checkQuestion,
  reviewAnswer,
  pickFocus,
  summarize,
  renderTranscript,
  reviewReport,
  verdictOf,
  VERDICT_LABEL,
  buildImprovePrompt,
  checkImprovement,
}
