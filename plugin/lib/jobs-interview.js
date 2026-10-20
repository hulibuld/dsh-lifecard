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

  const hasNumber = /\d/.test(text)
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
}
