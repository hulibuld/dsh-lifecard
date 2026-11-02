/**
 * Resume coach —— 简历体检、招聘说明关键词覆盖、一岗一版。
 *
 * 这一层回答三个问题，全部在本地算完，不联网、不调模型：
 *   1. 这份简历现在能拿出去投吗？哪里最该改？（checkResume）
 *   2. 招聘说明里反复提到的那几样，我简历里写了吗？（coverageOf）
 *   3. 同一个岗位改过好几版，哪一版是投这家用的？（versions）
 *
 * 三条硬规矩，和 score.js 一脉相承：
 *   1. **不联网、不调模型。** 体检要能随叫随到，一秒钟出结果。
 *   2. **不打分就完了，要说去改哪里。** 每个扣分项都必须落到一句能动手的话。
 *   3. **没写 ≠ 写错。** 空着的小节只提醒、不报错；只有真的写坏了才算错。
 *
 * 为什么不做一个「总分 78 分」就完事：78 分和 81 分对人没有任何区别，
 * 而「你三条经历里有两条一个数字都没有」是有区别的。所以分数只是索引，
 * 真正要读的是 findings 里那几条。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import * as core from './core.js'
import { localDate } from './store.js'

/** 一岗一版存在工程目录的这儿。 */
export const VERSIONS_DIR = 'career/resumes'

/** 版本文件的 kind。用来分清这到底是一份简历版本还是别的文件。 */
const VERSION_KIND = 'career-resume-version'

/** 六个小节的名字。和 career.js 里那份必须一致，否则切换版本会对不上。 */
export const SECTIONS = ['基本情况', '学过什么', '做过什么', '会用哪些工具', '想去哪', '还差什么']

/** 一行一条的小节。 */
export const LIST_SECTIONS = ['学过什么', '做过什么', '会用哪些工具', '还差什么']

// ── 小工具 ────────────────────────────────────────────────────────

/** 抹掉空白，用来做「这句是不是出现过」的判断。 */
function squash(text) {
  return String(text ?? '').replace(/\s+/g, '')
}

/** 一段值统一成文字数组（和 career.js 的 asItems 同口径，但不导出私有函数）。 */
function itemsOf(value) {
  if (Array.isArray(value)) return value.map((v) => String(v ?? '').trim()).filter((v) => v !== '')
  const text = String(value ?? '').trim()
  if (text === '') return []
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*+]|\d+\s*[.、)．])\s*/, '').trim())
    .filter((line) => line !== '')
}

/** 一段自由文字。 */
function textOf(value) {
  if (Array.isArray(value)) return value.map((v) => String(v ?? '').trim()).filter((v) => v !== '').join('\n')
  return String(value ?? '').trim()
}

/** 界面上的档位。和 score.js 的 gradeOf 用同一套话，用户不用记两套。 */
export function gradeOf(score) {
  if (score >= 85) return '能投了'
  if (score >= 70) return '改两处就能投'
  if (score >= 50) return '还差得多'
  if (score >= 25) return '有几条，但还撑不起来'
  // 25 分以下才叫「基本是空的」：六格都填满、只是全都没数没结果，
  // 是「写得不够具体」，不是「什么都没写」。这两句读起来差很远。
  return '基本是空的'
}

// ── 体检：这份简历现在行不行 ──────────────────────────────────────

/**
 * 一看就是「看不出到底做了什么」的开头。这些动词本身不算错，
 * 错在它后面跟着的往往是「某项目」而不是「我做了什么」。
 */
const VAGUE_VERBS = ['参与', '配合', '协助', '帮助', '支持', '参加了', '负责跟进', '跟进']

/** 「负责」单独算一档：它是最常见的写法，也是最看不出到底做了什么的写法。 */
const DUTY_VERB = /^负责/

/** 空话大词。不是错，但写了等于没写。 */
const PUFF_WORDS = ['大量', '多次', '若干', '许多', '优秀的', '良好的', '认真地', '积极主动', '努力', '丰富', '较强', '较好', '一定的', '较强的']

/**
 * 自我评价。简历上一出现这类句子，表达这一维直接归零——
 * 不是因为写得差，是因为它占地方：招聘的人跳过的正是这些字。
 */
const SELF_PRAISE = /(学习能力强|认真负责|能吃苦|踏实肯干|沟通能力强|团队协作能力强|抗压能力强|积极主动|责任心强|热爱这一行|对.{0,6}有浓厚兴趣|善于学习)/

/** 结果信号。一件事最后怎么了，得有这一句。 */
const RESULT_WORDS = /(结果|最后|后来|所以|因此|上线|通过|降到|提到|省了|少了|多了|解决|搞定|拿到|入选|获奖|发表|签约|录用|转正|超额|第一|评为|采纳|被采用|整理出|做出|写出|做出|编出|做完|出齐|出到|产出|交付|上线|从[^，。]{0,8}到[^，。]{0,8})/

/** 数字信号：绝对数、比例、时效、次数都算。 */
const NUMBER_RE = /(?:\d+(?:\.\d+)?)\s*(?:%|％|个|人|次|天|周|月|年|小时|篇|份|元|块|门|科|名|场|条|字|页|GB|MB|倍)|(?:[一二三四五六七八九十百千两]+)\s*(?:个|人|次|天|周|月|年|篇|份|门|科|名|场|条|倍)/

/**
 * 没有数字时，这四种写法也算「量化」——这是从同类产品里抄的做法：
 * 不是所有人都有数可报，但每个人都有别的东西可以报。
 *   比例/时效（快了多少、占了百分之多少）、采纳（被用了、被评了）、
 *   覆盖规模（多少人看到/用上）、阶段进展（做到哪一步，如实写）。
 */
const SOFT_QUANT = /(多少|比例|翻|快了|慢了|提前|当天|当天就|一周内|一次就|全部|所有人|全班|全组|被采用|被采纳|用上了|在用|都在用|拿去用|有人用|已经上线|上线|第一版|第二版|初版|试运行|每周|每月|每天)/

/** 专业性的信号：具体工具名、具体方法名。空着的说「会电脑」，写了的说「用过 Excel 的透视表」。 */
const TOOL_HINT = /[A-Za-z][A-Za-z0-9+#._-]{1,15}/

/**
 * 体检一份简历。
 *
 * 六维打分的分值是照着同类产品的评分卡定的，但每一项都在本地算完：
 *   成果量化 25 / 专业性 20 / 经历结构 20 / 完整度 10 / 表达 10 / 岗位相关性 15。
 * 最后那一维只有贴了招聘说明时才算，没贴就把它的分值按比例摊到前五维——
 * 不贴 JD 也硬扣 15 分，等于凭空告诉用户「你有 85 分封顶」，那是骗人的。
 *
 * @param {object} profile career/profile.md 读出来的 data
 * @param {{jd?: string}} options 可选：贴了招聘说明就把「对不对口」也算进去
 */
export function checkResume(profile, options = {}) {
  const data = profile !== null && typeof profile === 'object' && !Array.isArray(profile) ? profile : {}
  const findings = []
  const push = (level, code, where, message, fix) => findings.push({ level, code, where, message, fix })

  const basic = textOf(data['基本情况'])
  const did = itemsOf(data['做过什么'])
  const studied = itemsOf(data['学过什么'])
  const tools = itemsOf(data['会用哪些工具'])
  const want = textOf(data['想去哪'])
  const gap = itemsOf(data['还差什么'])
  const allText = [basic, did.join('\n'), studied.join('\n'), tools.join('\n'), want, gap.join('\n')].filter((x) => x !== '').join('\n')
  const bodyText = allText

  // 一点内容都没有的时候，后面那些检查都没有意义，白送分还会让人误以为
  // 「我这简历有 50 分」。
  if (bodyText.trim() === '') {
    push('error', 'empty', '全篇', '简历还是空的，一个字都没有。', '先填「基本情况」（学校、专业、年级）和至少一条「做过什么」，其余的可以慢慢补。')
    return {
      score: 0,
      grade: gradeOf(0),
      breakdown: [],
      findings,
      hasJd: false,
      stats: { did: 0, studied: 0, tools: 0, quantified: 0, results: 0, vague: 0, puff: 0 },
    }
  }

  // ── 1) 成果量化 25 分 ──
  const quantified = did.filter((line) => NUMBER_RE.test(line))
  const softOnly = did.filter((line) => !NUMBER_RE.test(line) && SOFT_QUANT.test(line))
  let quantPoints = 0
  if (did.length > 0) {
    quantPoints = Math.round(((quantified.length + softOnly.length * 0.5) / did.length) * 25)
  }
  const noNumber = did.filter((line) => !NUMBER_RE.test(line) && !SOFT_QUANT.test(line))
  if (did.length === 0) {
    push('warn', 'no-work', '做过什么', '「做过什么」一条都没有。这一格空着，简历就只有名字和学校。', '写一件真做过的事，一行一条：做了什么、怎么做的、做出来什么。')
  } else if (noNumber.length > 0) {
    push(
      'warn',
      'no-number',
      '做过什么',
      `有 ${noNumber.length} 条既没有数、也没有别的能说明规模的东西：「${clip(noNumber[0])}」`,
      '四选一补上：一个数（3 份、30 人）、快了多少（提前两天）、被谁用了（班里在用）、做到哪一步（第一版已上线）。',
    )
  }

  // ── 2) 专业性 20 分 ──
  const toolCount = tools.length
  const latinCount = (allText.match(TOOL_HINT) ?? []).length
  let proPoints = 0
  if (toolCount === 0 && latinCount === 0) {
    push('tip', 'no-tools', '会用哪些工具', '「会用哪些工具」空着。这一格是招聘的人扫得最快的一格。', '把真用过的写进去：Excel、Python、Figma、剪映、SPSS 都算。写下具体到什么程度（Excel 的透视表比「熟练 Office」有用）。')
  } else {
    proPoints = Math.min(20, toolCount * 5 + Math.min(10, latinCount * 2))
    if (studied.length === 0) {
      proPoints = Math.round(proPoints * 0.7)
      push('tip', 'no-study', '学过什么', '「学过什么」空着，看不出你的专业底子。', '把相关课程写两三条：数据库原理、概率论、结构力学。')
    }
  }

  // ── 3) 经历结构 20 分 ──
  // 模糊动词在这一维上按系数打：写「参与」的条目不按满分算。
  const vagueOnes = did.filter((line) => VAGUE_VERBS.some((w) => line.startsWith(w)) || DUTY_VERB.test(line))
  const withResult = did.filter((line) => RESULT_WORDS.test(line))
  let structPoints = 0
  if (did.length > 0) {
    const solid = did.length - vagueOnes.length
    structPoints = Math.round(((solid + vagueOnes.length * 0.5) / did.length) * 12 + (withResult.length / did.length) * 8)
  }
  if (vagueOnes.length > 0) {
    push(
      'warn',
      'vague-verb',
      '做过什么',
      `有 ${vagueOnes.length} 条开头是「负责」「参与」「协助」这类，看不出你亲手做了什么：「${clip(vagueOnes[0])}」`,
      '换成你实际做的动作：写了、改了、搭了、跑了、统计了、谈成了。看不出谁做，招聘的人会以为你只是站在旁边。',
    )
  }
  if (did.length > 0 && withResult.length < did.length) {
    push('tip', 'no-result', '做过什么', `有 ${did.length - withResult.length} 条只说了做什么，没说最后怎么样。`, '每条后面加半句结果：交上去了、评了优、被采用了、问题解决了。')
  }

  // ── 4) 完整度 10 分 ──
  const filled = [basic, did.join(''), studied.join(''), tools.join(''), want, gap.join('')].filter((x) => String(x).trim() !== '').length
  const coverPoints = Math.round((filled / 6) * 10)
  if (basic === '') push('warn', 'no-basic', '基本情况', '「基本情况」空着。招聘的人第一眼要看的就是这一格。', '写上学校、专业、年级（或毕业时间），一行就够。')
  if (want === '') push('tip', 'no-target', '想去哪', '「想去哪」空着。不写目标，简历就不知道往哪儿靠。', '写一句具体的话：「想找后端开发实习，偏 Python」。')
  if (gap.length === 0) push('tip', 'no-gap', '还差什么', '「还差什么」空着。', '写一条你现在明显缺的：不会数据库、没做过团队项目。写出来才知道下一步补什么。')

  // ── 5) 表达 10 分 ──
  // 自我评价一出现直接归零：它占的是最显眼的位置，说的却是招聘的人不看的话。
  const praise = SELF_PRAISE.test(allText)
  const puffHits = PUFF_WORDS.filter((w) => allText.includes(w))
  const longOnes = did.filter((line) => line.length > 60)
  let expressPoints = 10
  if (praise) {
    expressPoints = 0
    push('warn', 'self-praise', '全篇', '写了自我评价（「认真负责」「学习能力强」这类）。', '整句删掉。这些话招聘的人直接跳过，占的地方不如换成一条事实。')
  } else {
    expressPoints = Math.max(0, 10 - puffHits.length * 2 - (longOnes.length > 0 ? 3 : 0))
  }
  if (puffHits.length > 0) {
    push('tip', 'puff', '全篇', `有 ${puffHits.length} 处空话：${puffHits.slice(0, 4).map((w) => `「${w}」`).join('、')}`, '删掉，换成具体的数或具体的事。删完句子会硬很多。')
  }
  if (longOnes.length > 0) {
    push('tip', 'too-long', '做过什么', `有 ${longOnes.length} 条超过 60 字，一眼看不清重点。`, '一条压到一行多一点。要展开的部分留给面试口头讲。')
  }
  if (did.length > 6) {
    push('tip', 'many-work', '做过什么', `写了 ${did.length} 条，太多了。一份简历只看二十秒。`, '留三条最相关的，其余删掉或并进同一条。')
  }

  // ── 6) 岗位相关性 15 分（只有贴了招聘说明才算）──
  const jd = String(options.jd ?? '').trim()
  let jdPoints = null
  let cover = null
  if (jd !== '') {
    cover = coverageOf(data, jd)
    jdPoints = cover.total === 0 ? null : Math.round((cover.covered / cover.total) * 15)
    if (cover.total > 0 && cover.percent < 50) {
      const missing = cover.terms.filter((t) => !t.has).slice(0, 4).map((t) => `「${t.term}」`).join('、')
      push(
        'warn',
        'misaligned',
        '全篇',
        `招聘说明里提到的 ${cover.total} 样，简历里只对上了 ${cover.covered} 样。没对上的有 ${missing}。`,
        '真做过的就写进去（写进「会用哪些工具」或「做过什么」）；确实没做过的，这一条就是面试会被问住的地方，先补上一件小的。',
      )
    }
  }

  const breakdown = [
    { key: 'quant', label: '成果量化', got: quantPoints, max: 25 },
    { key: 'pro', label: '专业性', got: proPoints, max: 20 },
    { key: 'struct', label: '经历结构', got: structPoints, max: 20 },
    { key: 'cover', label: '完整度', got: coverPoints, max: 10 },
    { key: 'express', label: '表达', got: expressPoints, max: 10 },
  ]
  if (jdPoints !== null) breakdown.push({ key: 'jd', label: '岗位相关性', got: jdPoints, max: 15 })

  const got = breakdown.reduce((acc, row) => acc + row.got, 0)
  const max = breakdown.reduce((acc, row) => acc + row.max, 0)
  const score = Math.max(0, Math.min(100, Math.round((got / Math.max(1, max)) * 100)))

  return {
    score,
    grade: gradeOf(score),
    breakdown,
    findings,
    hasJd: jdPoints !== null,
    coverage: cover === null ? null : { covered: cover.covered, total: cover.total, percent: cover.percent },
    stats: {
      did: did.length,
      studied: studied.length,
      tools: tools.length,
      quantified: quantified.length + softOnly.length,
      results: withResult.length,
      vague: vagueOnes.length,
      puff: puffHits.length,
    },
  }
}

/** 一条太长的话，界面上截一段显示，别把整条甩出来。 */
function clip(line, n = 28) {
  const s = String(line ?? '').trim()
  return s.length <= n ? s : `${s.slice(0, n)}…`
}

// ── 招聘说明：把「它要什么」抽成本地能比的词 ──────────────────────

/**
 * 这些词在招聘说明里到处都是，但没有任何区分度。
 * 留着它们，「对上了 6 样」会全是「要求」「工作」「经验」这种。
 */
const GENERIC = new Set([
  '岗位职责', '任职要求', '工作内容', '职位描述', '我们提供', '公司介绍', '团队介绍',
  '要求', '职责', '工作', '经验', '能力', '优先', '以上', '相关', '专业', '团队', '公司',
  '负责', '熟悉', '掌握', '了解', '能够', '具备', '参与', '进行', '以及', '或者', '并且',
  '本科', '硕士', '博士', '学历', '应届', '毕业生', '实习生', '全职', '兼职', '实习',
  '良好', '较强', '一定', '扎实', '基本', '至少', '需要', '具有', '优先考虑', '加分',
])

/** 判断一段话是不是「在提要求」，还是公司自夸、福利介绍。 */
const REQ_MARK = /熟悉|掌握|了解|具备|精通|能够|优先|经验|负责|参与|使用|要求|做过|独立|会\s*[A-Za-z一-龥]/

/**
 * 常见工种能力词。中文里「它要什么」很少能靠切词切准——
 * 「负责后端接口开发」切开还是整句，「、」隔开的又常常是「沟通能力」这种
 * 根本不在技能表里的词。所以两手并用：切词负责捡短块，这张表负责认
 * 那些一眼就知道是能力的东西。表里没有的短块照样收，不会漏。
 */
const CJK_SKILLS = [
  '数据分析', '数据挖掘', '数据清洗', '数据可视化', '数据建模', '统计分析',
  '前端开发', '后端开发', '全栈开发', '移动开发', '客户端开发', '服务端开发',
  '算法', '机器学习', '深度学习', '自然语言处理', '计算机视觉', '大模型',
  '测试', '自动化测试', '性能优化', '运维', '部署', '架构设计', '接口设计', '数据库设计',
  '产品设计', '产品经理', '需求分析', '用户研究', '原型设计', '交互设计', '视觉设计', '平面设计',
  '内容运营', '用户运营', '社群运营', '活动运营', '新媒体运营', '电商运营', '增长',
  '市场推广', '品牌', '广告投放', '商务拓展', '客户维护', '销售',
  '财务', '会计', '审计', '税务', '投资', '风控', '合规',
  '招聘', '培训', '绩效', '人力资源',
  '文案', '写作', '编辑', '翻译', '校对', '策划',
  '教学', '课程设计', '教研', '班主任',
  '项目管理', '团队协作', '沟通能力', '表达能力', '抗压能力', '执行力', '学习能力',
  '英语', '外语', '口语', '读写',
  '摄影', '剪辑', '视频制作', '平面排版', '制图', '测绘', 'GIS', '遥感',
  '实验设计', '仪器操作', '文献检索', '论文写作',
]

/** 英文技术词：Python、SQL、Excel、Figma、C++、Node.js 这种。 */
const LATIN_RE = /[A-Za-z][A-Za-z0-9+#._-]{1,15}/g

/** 这些英文词是句子里的连接词，不是技能。 */
const LATIN_STOP = new Set([
  'and', 'or', 'the', 'with', 'for', 'you', 'we', 'our', 'are', 'will', 'can', 'must',
  'able', 'good', 'nice', 'plus', 'etc', 'job', 'team', 'work', 'year', 'years', 'more',
])

/**
 * 从招聘说明里抽出「它在要什么」。
 *
 * 分两种来源，因为这两种的可信度不一样：
 *   1. **能力表命中**（`CJK_SKILLS`）——不管出现在哪一行都算。写职责里的
 *      「数据库设计」和写要求里的「数据库设计」是同一件事。
 *   2. **要求行里切出来的短块**——只从「熟悉 / 掌握 / 优先 / 经验」这类
 *      明显在提要求的话里切，职责行（「负责……开发」）不切。
 *      职责讲的是进去以后干什么，不是进门要有什么；把它算成要求，
 *      用户会看到一堆「负责后端接口开发 ✗」，读完只觉得被否定。
 *
 * 宁可漏几个，也不要把「公司提供五险一金」切成需求塞给用户看。
 *
 * @returns {string[]} 去重后的词，顺序按第一次出现的先后
 */
export function jdTerms(jd) {
  const text = String(jd ?? '')
  const out = []
  const seen = new Set()
  const add = (word) => {
    const w = String(word ?? '').trim()
    if (w === '') return
    if (w.length > 16) return
    if (GENERIC.has(w)) return
    if (seen.has(w)) return
    seen.add(w)
    out.push(w)
  }

  // 1) 能力表命中：全篇扫，命中长的优先（先放长的，短的重复就不再加）
  const skills = CJK_SKILLS.filter((one) => text.includes(one)).sort((a, b) => b.length - a.length)
  for (const one of skills) add(one)

  // 2) 要求行里切短块
  const DUTY_ONLY = /^\s*(?:岗位职责|工作内容|职位描述|职责|你将会?|主要工作)/
  for (const raw of text.split(/[。；;!！?\n]/)) {
    const line = raw.trim()
    if (line === '') continue
    if (DUTY_ONLY.test(line)) continue
    if (!REQ_MARK.test(line)) continue
    for (const piece of line.split(/[、，,／/（）()【】\[\]:：·]+/)) {
      const chunk = piece.trim()
      if (chunk === '') continue
      const bare = chunk
        .replace(/^(?:任职要求|岗位要求|要求|任职资格|我们希望你?|你需要?)[:：]?/, '')
        .replace(/^(?:熟练|熟悉|掌握|了解|会|具备|精通|能够|能|有|对|在|使用|独立|加分项?)+/, '')
        .replace(/(?:优先考虑|者优先|优先|的经验|经验|的能力|能力|等相关|等)+$/, '')
        .trim()
      const cjk = (bare.match(/[\u4e00-\u9fff]/g) ?? []).length
      // 2–9 个汉字之间才像一个「要求」。太短是残渣，太长是整句描述。
      if (cjk < 2 || cjk > 9) continue
      // 块里已经含了能力表里的词，就不另立一条——否则同一件事列两遍。
      if (skills.some((one) => bare.includes(one))) continue
      add(bare)
    }
  }

  // 3) 英文技术词：不受「哪一行」限制，写在职责里也算它要。
  for (const hit of text.match(LATIN_RE) ?? []) {
    if (LATIN_STOP.has(hit.toLowerCase())) continue
    if (hit.length < 2) continue
    add(hit)
  }
  // 一次列太多读不动。前 24 个是招聘说明里最靠前的那些，也就最像硬要求。
  return out.slice(0, 24)
}

/**
 * 招聘说明里的词，简历里对上了几样。
 *
 * 只做字面包含，不做同义扩展。「用户运营」和「社群运营」在对字面这里算两样——
 * 这是故意的：宁可少算一码，也不要替用户下「这就算对上了」的判断。
 *
 * @returns {{terms: Array<{term: string, has: boolean}>, covered: number, total: number, percent: number}}
 */
export function coverageOf(profile, jd) {
  const terms = jdTerms(jd)
  const data = profile !== null && typeof profile === 'object' && !Array.isArray(profile) ? profile : {}
  const hay = squash(
    [textOf(data['基本情况']), textOf(data['想去哪']), itemsOf(data['学过什么']).join(' '), itemsOf(data['做过什么']).join(' '), itemsOf(data['会用哪些工具']).join(' ')].join(' '),
  ).toLowerCase()
  const rows = terms.map((term) => ({ term, has: hay.includes(squash(term).toLowerCase()) }))
  const covered = rows.filter((r) => r.has).length
  const total = rows.length
  return { terms: rows, covered, total, percent: total === 0 ? 0 : Math.round((covered / total) * 100) }
}

// ── 一岗一版：存下来的几份简历 ────────────────────────────────────

/** 一版一个文件，文件名用名字推出来，撞了加序号。 */
export function versionRelPath(name) {
  return path.posix.join(VERSIONS_DIR, `${core.safeId(name) || 'v'}.md`)
}

/** 把一版简历写成 Markdown。贴过的招聘说明原样留着，下次还能比对。 */
export function renderVersionMarkdown(version) {
  const v = version !== null && typeof version === 'object' ? version : {}
  const head = {
    lifecard: core.DATA_VERSION,
    kind: VERSION_KIND,
    name: String(v.name ?? '').trim() || '未命名',
    target: String(v.target ?? '').trim(),
    updated_at: String(v.updated_at ?? '').trim() || localDate(),
  }
  const blocks = []
  const jd = String(v.jd ?? '').trim()
  if (jd !== '') blocks.push(`## 投的时候贴的那份招聘说明\n\n${jd}`)
  for (const title of SECTIONS) {
    const raw = v.profile?.[title]
    const body = LIST_SECTIONS.includes(title) ? itemsOf(raw).map((one) => `- ${one}`).join('\n') : textOf(raw)
    if (body === '') continue
    blocks.push(`## ${title}\n\n${body}`)
  }
  if (blocks.length === 0) blocks.push('## 基本情况\n\n（这一版还是空的。）')
  return `---\n${core.stringifyYaml(head)}\n---\n\n${blocks.join('\n\n')}\n`
}

/** 反过来读。读不成给人话。 */
export function parseVersionText(text) {
  const parsed = core.parseCard(String(text ?? ''))
  if (parsed.ok !== true) return { ok: false, error: '这一版简历读不出来，格式不对。' }
  const head = parsed.data ?? {}
  const kind = String(head.kind ?? '').trim()
  if (kind !== '' && kind !== VERSION_KIND) return { ok: false, error: '这个文件不是简历版本，是别的文件。' }
  const sections = parsed.sections ?? []
  const profile = {}
  for (const title of SECTIONS) {
    const body = core.sectionBody(sections, title)
    profile[title] = LIST_SECTIONS.includes(title) ? splitList(body) : String(body ?? '').trim()
  }
  return {
    ok: true,
    version: {
      name: String(head.name ?? '').trim(),
      target: String(head.target ?? '').trim(),
      updated_at: String(head.updated_at ?? '').trim(),
      jd: core.sectionBody(sections, '投的时候贴的那份招聘说明'),
      profile,
    },
  }
}

/** 读一个「一行一条」的小节。`- ` 剥掉，换行不还原——版本里的内容本来就是纯文字。 */
function splitList(body) {
  const out = []
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    if (/^#{1,6}\s/.test(line)) continue
    out.push(line.replace(/^\s*(?:[-*+]|\d+\s*[.、)．])\s*/, '').trim())
  }
  return out.filter((one) => one !== '')
}

/** 列所有存下来的版本，新的排在前面。 */
export async function listVersions(root) {
  const dir = path.join(root, VERSIONS_DIR)
  let names
  try {
    names = await fs.readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, versions: [] }
    return { ok: false, error: '存下来的那几版简历列不出来。检查一下这个文件夹的权限。' }
  }
  const versions = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const rel = path.posix.join(VERSIONS_DIR, name)
    let text
    try {
      text = await fs.readFile(path.join(root, rel), 'utf8')
    } catch {
      continue
    }
    const parsed = parseVersionText(text)
    if (parsed.ok !== true) continue
    const { profile, ...meta } = parsed.version
    versions.push({ ...meta, path: rel, words: Object.values(profile).flat().join('').length })
  }
  versions.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || a.name.localeCompare(b.name))
  return { ok: true, versions }
}

/** 读某一版。 */
export async function readVersion(root, rel) {
  const at = safeVersionPath(rel)
  if (at.ok !== true) return at
  let text
  try {
    text = await fs.readFile(path.join(root, at.rel), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, error: '这一版找不到了，可能已经删掉。' }
    return { ok: false, error: '这一版读不出来。检查一下这个文件夹的权限。' }
  }
  const parsed = parseVersionText(text)
  if (parsed.ok !== true) return parsed
  return { ok: true, path: at.rel, text, ...parsed.version }
}

/** 存一版。重名就覆盖同一版（用户就是要改这一版），不另造一份。 */
export async function writeVersion(root, version, now = new Date()) {
  const v = version !== null && typeof version === 'object' ? version : {}
  const name = String(v.name ?? '').trim()
  if (name === '') return { ok: false, error: '给这一版起个名字，不然以后分不清哪份投哪儿。' }
  const rel = versionRelPath(name)
  const next = { ...v, name, updated_at: localDate(now) }
  const text = renderVersionMarkdown(next)
  const abs = path.join(root, rel)
  const tmp = `${abs}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tmp, abs)
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {})
    return { ok: false, error: '这一版没能存下来。检查一下磁盘是不是满了。' }
  }
  return { ok: true, path: rel, chars: text.length, version: next }
}

/** 删一版。搬到回收目录，不是真删——简历版本删错了很气人。 */
export async function deleteVersion(root, rel) {
  const at = safeVersionPath(rel)
  if (at.ok !== true) return at
  const abs = path.join(root, at.rel)
  const dest = path.join(root, '.lifecard', 'redacted', VERSIONS_DIR, `${path.basename(at.rel)}.${Date.now()}`)
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.rename(abs, dest)
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, error: '这一版已经不在了。' }
    return { ok: false, error: '这一版没能删掉。检查一下这个文件夹的权限。' }
  }
  return { ok: true, path: at.rel, redacted: dest }
}

/**
 * 只收 `career/resumes/` 下面的一层 `.md`。
 *
 * 外面传进来的路径一律不用原来的字符串：先规范化，再确认它落在这一层里。
 * 这样 `../../etc/passwd` 和绝对路径都进不来。
 */
function safeVersionPath(rel) {
  const raw = String(rel ?? '').trim()
  if (raw === '') return { ok: false, error: '没说清是哪一版。' }
  const flat = path.posix.normalize(raw.replace(/\\/g, '/'))
  if (flat.startsWith('../') || flat.includes('/../') || path.posix.isAbsolute(flat)) {
    return { ok: false, error: '这个路径不对。' }
  }
  const base = path.posix.basename(flat)
  if (!base.endsWith('.md')) return { ok: false, error: '这不是一版简历文件。' }
  return { ok: true, rel: path.posix.join(VERSIONS_DIR, base) }
}

// ── 改写：把一条流水账改成一句话里带结果 ──────────────────────────

/**
 * 改写一条经历的提示词。
 *
 * 这一层最容易出事的地方：模型会「帮着写好一点」，把「帮同学装系统」
 * 写成「主导了校内技术支持体系的搭建」。所以提示词里最重要的不是
 * 「怎么写得好」，是三条不许。
 *
 * @param {{line: string, target?: string, jd?: string}} input
 */
export function buildStarPrompt({ line, target, jd } = {}) {
  const src = String(line ?? '').trim()
  const aim = String(target ?? '').trim()
  const posting = String(jd ?? '').trim()
  const system = [
    '你在帮人把简历上的一条经历改写得更清楚。',
    '',
    '只改这一条。原句里的每一样东西，改完都还能一一对上：谁做的、做了什么、结果是什么。',
    '',
    '三条不许：',
    '- 不许加原句里没有的事。原句没写带了几个学生，就不许写「带了 12 个学生」。',
    '- 不许把小事说大。「帮忙装系统」不许写成「主导体系建设」，「参加」不许写成「牵头」。',
    '- 不许加形容词。「出色地」「高效地」「充分地」一律不出现。',
    '',
    '要做的只有三件：',
    '1. 主语换成「我」。原来写「负责」「参与」的，换成你实际动手的那个动词。',
    '2. 顺序改成：做了什么 → 怎么做的 → 做出来什么。一句话，不分段。',
    '3. 原句里有数的保住数。没有数的，不许编。',
    '',
    '原句只有「做了什么」、没有结果的时候，不要硬编一个结果。给它一句',
    '「这条还缺结果——做完以后发生了什么，补一句就能用」，比编一个漂亮的结果有用。',
    '',
    '输出只有一个 JSON 对象，不要解释，不要 Markdown 围栏：',
    '{"rewritten":"改写后的那一句","changed":["改了哪几处，每处一行"],"missing":"还缺什么，没有就给空串"}',
  ].join('\n')

  const user = [
    '原句：',
    src === '' ? '（空）' : src,
    '',
    aim === '' ? '' : `这份简历投的是：${aim}`,
    posting === '' ? '' : `招聘说明里相关的部分：\n${posting.slice(0, 600)}`,
    '',
    '把这一条改写一下。原句里没有的东西一个字都不许加。',
  ].filter((one) => one !== '').join('\n')

  return { system, user }
}

/**
 * 检查模型改写回来的东西有没有越界。
 *
 * 判据是保守的：只在「改写后多出了原句没有的数字」和「改写后多出了
 * 原句没有的大词」这两件事上拦。语言上的重排、换动词、调顺序都不拦——
 * 那本来就是让它做的。
 *
 * @returns {{ok: boolean, problems: string[]}}
 */
export function checkRewrite(before, after) {
  const a = String(before ?? '')
  const b = String(after ?? '')
  const problems = []
  if (b.trim() === '') return { ok: false, problems: ['改写后是空的。'] }

  // 1) 数字：原句里没有一个数字，改写后冒出来一个，多半是编的。
  const numOf = (text) => (String(text).match(/\d+(?:\.\d+)?/g) ?? []).sort().join(',')
  const beforeNums = new Set(String(a).match(/\d+(?:\.\d+)?/g) ?? [])
  const afterNums = String(b).match(/\d+(?:\.\d+)?/g) ?? []
  for (const n of afterNums) {
    if (!beforeNums.has(n)) {
      problems.push(`改写后多了一个原句里没有的数：${n}。除非他真的做过，否则删掉。`)
    }
  }
  if (beforeNums.size > 0 && numOf(a) !== numOf(b)) {
    const lost = [...beforeNums].filter((n) => !afterNums.includes(n))
    if (lost.length > 0) problems.push(`原句里的数丢了：${lost.join('、')}。数不能丢，丢了这条就不如原来。`)
  }

  // 2) 大词：改写后新出现的那些夸大词
  const BIG = ['主导', '牵头', '负责全', '从零到一', '体系', '赋能', '闭环', '方法论', '顶层', '战略', '标杆', '颠覆', '卓越', '极致', 'significant']
  const appeared = BIG.filter((w) => b.includes(w) && !a.includes(w))
  if (appeared.length > 0) {
    problems.push(`改写后多了这几个大词：${appeared.map((w) => `「${w}」`).join('、')}。原句撑不起它们。`)
  }

  // 3) 长度暴涨：一句话变三句，读起来就不像简历了
  if (b.length > Math.max(60, a.length * 2.2)) {
    problems.push('改写后长了一倍多。简历上一条就一行多一点，长的部分留给面试讲。')
  }
  return { ok: problems.length === 0, problems }
}

export default {
  VERSIONS_DIR,
  SECTIONS,
  LIST_SECTIONS,
  gradeOf,
  checkResume,
  jdTerms,
  coverageOf,
  versionRelPath,
  renderVersionMarkdown,
  parseVersionText,
  listVersions,
  readVersion,
  writeVersion,
  deleteVersion,
  buildStarPrompt,
  checkRewrite,
}
