/**
 * LifeCard score —— 离线体检打分。
 *
 * 这一层做一件事：把「这份档案写得好不好用」算成一个 0–100 的数，
 * 并且把分数拆成几条人看得懂的扣分理由。
 *
 * 三条硬规矩：
 *   1. **不联网、不调模型。** 纯本地算，随叫随到。
 *   2. **不是评分榜，是待办清单。** 每个扣分项都必须能指出「去改哪里」。
 *   3. **没写 ≠ 写错。** 空着的字段只扣分、不报错；只有真的写坏了才算错。
 *
 * 为什么需要它：本来只有一个「有没有写坏」的二元检查。二元检查的问题
 * 是——一张 40 分和一张 95 分的卡，在它眼里都是「没发现错误」。
 */

import * as core from './core.js'

/**
 * token 估算：不引入 tokenizer，按经验值算。
 *
 * 中文大约 1 个字 = 1 个 token 左右（BPE 里常用汉字多数单独成 token），
 * 英文大约 4 个字符 = 1 个 token。混排时按字符类别分开算再相加，
 * 比「一律 4 字符」准得多，也比接一个真正的 tokenizer 便宜得多。
 *
 * 这个数是**估算**，界面上必须说清楚是估算，不能说成精确值。
 */
export function estimateTokens(text) {
  const s = String(text ?? '')
  if (s === '') return 0
  let cjk = 0
  let other = 0
  for (const ch of s) {
    const code = ch.codePointAt(0)
    // 中日韩统一表意文字 + 全角标点 + 假名
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0x3000 && code <= 0x303f)
    ) {
      cjk += 1
    } else {
      other += 1
    }
  }
  return cjk + Math.ceil(other / 4)
}

/** 整张卡（含正文小节）的 token 估算。 */
export function estimateCardTokens(data, sections) {
  const header = estimateTokens(serializeForCount(data))
  const body = estimateTokens((sections ?? []).map((s) => `${s.title ?? ''}\n${s.body ?? ''}`).join('\n'))
  return header + body
}

function serializeForCount(data) {
  if (data === null || typeof data !== 'object') return String(data ?? '')
  const parts = []
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue
    parts.push(k)
    if (typeof v === 'object') parts.push(serializeForCount(v))
    else parts.push(String(v))
  }
  return parts.join(' ')
}

/** 常见占位符。`{{user}}` 出现在「角色第一人称」位置会被当成冒名。 */
const PLACEHOLDERS = ['{{char}}', '{{user}}', '{{persona}}', '<BOT>', '<USER>']

/**
 * 找占位符误用。
 *
 * 两类问题分开报：
 *   - 残留：`{{char}}` 这种该被替换掉的占位符还在正文里。酒馆会替换它，
 *     但如果这张卡是给别的前端用的，就会原样显示成一串花括号。
 *   - 冒名：自述小节里用 `{{user}}` 指代「我」。这样导出到酒馆后，
 *     读者会看到自己的名字出现在角色自述里。
 */
export function findPlaceholderIssues(data, sections) {
  const issues = []
  const secs = Array.isArray(sections) ? sections : []
  const selfNarration = secs.find((s) => s.title === '自述')
  if (selfNarration !== undefined) {
    const body = String(selfNarration.body ?? '')
    if (/\{\{\s*user\s*\}\}/i.test(body)) {
      issues.push({
        level: 'warn',
        code: 'placeholder-in-self-narration',
        field: '自述',
        message: '「自述」里用了 {{user}} 指代角色自己。导出后读者会看到自己的名字。',
        fix: '把「自述」里的 {{user}} 改成「我」，或者写成角色的名字。',
      })
    }
  }
  const scanTargets = [
    ...secs.map((s) => ({ where: String(s.title ?? '正文'), text: String(s.body ?? '') })),
    ...Object.entries(data ?? {})
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => ({ where: k, text: String(v) })),
  ]
  for (const target of scanTargets) {
    for (const ph of PLACEHOLDERS) {
      const re = new RegExp(ph.replace(/[{}]/g, '\\$&'), 'i')
      if (re.test(target.text)) {
        const already = target.where === '自述' && ph === '{{user}}' && issues.some((i) => i.code === 'placeholder-in-self-narration')
        if (already) continue
        issues.push({
          level: 'warn',
          code: 'placeholder-leftover',
          field: target.where,
          message: `「${target.where}」里还留着 ${ph} 没有替换。`,
          fix: `把 ${ph} 换成具体的人名，或者删掉。`,
        })
      }
    }
  }
  return issues
}

/**
 * 从一张卡里找出它的世界书。
 *
 * 世界书没有自己的字段：导入 CC 卡时，`character_book` 原样躺在
 * `data.cc.fields.character_book` 里（见 codec.js 的 ccToLifeCard）。
 * 早先我按 `data.lorebook` 找，永远找不到——于是所有带世界书的卡都被
 * 当成「没写世界书」白送满分。这里把两个位置都认上。
 */
export function findLorebook(data) {
  const direct = data?.lorebook
  if (Array.isArray(direct?.entries) && direct.entries.length > 0) return direct
  const fromCc = data?.cc?.fields?.character_book
  if (Array.isArray(fromCc?.entries) && fromCc.entries.length > 0) return fromCc
  // 有位置但一条都没有 = 没有世界书。返回 undefined 比返回空壳更清楚，
  // 调用方不用再判断一次「里面到底有没有东西」。
  return undefined
}

/** 世界书（lorebook）健康度：条目数、空条目、重复 keys、超长条目。 */
export function scoreLorebook(lorebook) {
  const entries = Array.isArray(lorebook?.entries) ? lorebook.entries : []
  const findings = []
  let points = 0
  const max = 20
  if (entries.length === 0) {
    // 没写世界书不扣分——很多现实里的卡根本不需要
    return { ratio: null, max, points: null, findings, note: '没写世界书（不是问题）' }
  }
  const seenKeys = new Map()
  let usable = 0
  for (let n = 0; n < entries.length; n += 1) {
    const e = entries[n]
    const content = String(e?.content ?? '').trim()
    const keys = Array.isArray(e?.keys) ? e.keys.filter((k) => String(k ?? '').trim() !== '') : []
    if (content === '') {
      findings.push({ level: 'warn', code: 'lore-empty', field: `世界书 #${n + 1}`, message: `第 ${n + 1} 条世界书是空的。`, fix: '补上内容，或者删掉这一条。' })
      continue
    }
    if (keys.length === 0) {
      findings.push({ level: 'warn', code: 'lore-no-keys', field: `世界书 #${n + 1}`, message: `第 ${n + 1} 条世界书没有触发词，永远不会被用到。`, fix: '给它加一个触发词（比如地名、人名）。' })
      continue
    }
    let duplicated = false
    for (const k of keys) {
      const key = String(k)
      if (seenKeys.has(key)) {
        duplicated = true
        findings.push({ level: 'warn', code: 'lore-dup-key', field: `世界书 #${n + 1}`, message: `触发词「${key}」在第 ${seenKeys.get(key)} 条里已经用过。`, fix: '换个触发词，或者把两条合并。' })
      } else {
        seenKeys.set(key, n + 1)
      }
    }
    if (estimateTokens(content) > 400) {
      findings.push({ level: 'warn', code: 'lore-too-long', field: `世界书 #${n + 1}`, message: `第 ${n + 1} 条世界书太长了（约 ${estimateTokens(content)} 字），会挤掉别的内容。`, fix: '拆成几条，或者删掉不重要的部分。' })
    }
    // 触发词撞车的那条不算「可用」：它和前面那条抢同一个词，实际只会有一条生效
    if (!duplicated) usable += 1
  }
  points = Math.round((usable / entries.length) * max)
  return { ratio: entries.length === 0 ? null : usable / entries.length, max, points, findings, note: `${usable}/${entries.length} 条可用` }
}

/**
 * 给一张卡打分。返回 0–100 与逐条扣分理由。
 *
 * 分值构成（合计 100）：
 *   必填字段        20   —— 少一个就是 error，导出会坏
 *   正文覆盖        30   —— 访谈的目标就是把它填满
 *   长度合理        15   —— 太短没法演，超长会吃光上下文
 *   占位符干净      10   —— 残留与冒名
 *   来源可追溯      15   —— 有多少段落写了来源标记
 *   世界书          10   —— 写了才计分，没写按满分算
 */
export function scoreCard(card, options = {}) {
  const data = card?.data ?? {}
  const sections = Array.isArray(card?.sections) ? card.sections : []
  const kind = String(data.kind ?? 'real')
  const findings = []
  let total = 0

  // 1. 必填字段 20 分
  const required = core.REQUIRED_BY_KIND[kind] ?? core.REQUIRED_BY_KIND.real
  const missingRequired = required.filter((f) => {
    const v = data[f]
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
  })
  const requiredPoints = required.length === 0 ? 20 : Math.round(((required.length - missingRequired.length) / required.length) * 20)
  total += requiredPoints
  for (const f of missingRequired) {
    findings.push({ level: 'error', code: 'missing-required', field: f, message: `少了一个必填项：${fieldLabel(f)}。`, fix: `在卡里补上${fieldLabel(f)}。` })
  }

  // 2. 正文覆盖 30 分
  const cov = core.coverage(data, sections)
  const coveragePoints = cov.percent === undefined ? 0 : Math.round((cov.percent / 100) * 30)
  total += coveragePoints
  for (const row of (cov.empty ?? []).slice(0, 6)) {
    findings.push({ level: 'tip', code: 'empty-field', field: row.key, message: `${row.label}还空着。`, fix: `补一句就行，不用写长。` })
  }

  // 3. 长度 15 分
  //
  // 「空」的判定不能只看 token 数：一张只填了 id/kind 的卡，frontmatter 本身
  // 就有几十个 token，会卡在 80 那条线上面被当成「偏少」。要单独看正文有没有字。
  const tokens = estimateCardTokens(data, sections)
  const hasBody = sections.some((s) => String(s.body ?? '').trim() !== '')
  let lengthPoints = 15
  if (!hasBody) {
    lengthPoints = 0
    findings.push({ level: 'warn', code: 'empty-card', field: '正文', message: '这张卡还只有名字，没有任何内容。', fix: '先补「自述」，一句话也行。' })
  } else if (tokens < 80) {
    lengthPoints = 8
    findings.push({ level: 'tip', code: 'too-short', field: '正文', message: `内容偏少（约 ${tokens} 字），读起来会很单薄。`, fix: '补一段「性格」或一件具体的事。' })
  } else if (tokens > (options.tokenBudget ?? 3000)) {
    lengthPoints = 9
    findings.push({ level: 'tip', code: 'too-long', field: '正文', message: `内容偏长（约 ${tokens} 字），会占掉很多对话的余地。`, fix: '把重复的描述合并，或者拆成两张卡。' })
  }
  total += lengthPoints

  // 4. 占位符 10 分
  //
  // 空卡不白送这 10 分。「没有写错占位符」在一张空卡上是没有意义的——
  // 白送会让一张只有名字的卡一开局就有 40 分，那个数字就没用了。
  const phIssues = findPlaceholderIssues(data, sections)
  const phPoints = !hasBody ? 0 : phIssues.length === 0 ? 10 : Math.max(0, 10 - phIssues.length * 4)
  total += phPoints
  findings.push(...phIssues)

  // 5. 来源可追溯 15 分
  const text = sections.map((s) => String(s.body ?? '')).join('\n')
  const marked = /〔\s*(自述|他述|文档|推测)/g.test(text) || core.collectSourceLevels(data, sections) !== undefined
  const marks = countSourceMarks(text)
  const sourcePoints = text.trim() === '' ? 0 : marks > 0 ? 15 : 6
  total += sourcePoints
  if (text.trim() !== '' && marks === 0) {
    findings.push({
      level: 'tip',
      code: 'no-source-mark',
      field: '正文',
      message: '正文里没有写过来源标记，以后分不清哪句是本人说的。',
      fix: '在段首加〔自述〕或〔他述〕这类标记，写明这句话是谁说的。',
    })
  }

  // 6. 世界书 10 分（没写按满分，但空卡不送）
  const lore = scoreLorebook(findLorebook(data))
  const lorePoints = !hasBody ? (lore.points === null ? 0 : Math.round((lore.points / lore.max) * 10)) : (lore.points === null ? 10 : Math.round((lore.points / lore.max) * 10))
  total += lorePoints
  findings.push(...lore.findings)

  const score = Math.max(0, Math.min(100, total))
  return {
    score,
    grade: gradeOf(score),
    tokens,
    breakdown: [
      { key: 'required', label: '必填项', got: requiredPoints, max: 20 },
      { key: 'coverage', label: '内容完整度', got: coveragePoints, max: 30 },
      { key: 'length', label: '篇幅', got: lengthPoints, max: 15 },
      { key: 'placeholder', label: '占位符', got: phPoints, max: 10 },
      { key: 'source', label: '来源标注', got: sourcePoints, max: 15 },
      { key: 'lorebook', label: '世界书', got: lorePoints, max: 10 },
    ],
    findings,
    coverage: cov.percent,
  }
}

function countSourceMarks(text) {
  const hits = String(text ?? '').match(/〔\s*(自述|他述|文档|推测)/g)
  return hits === null ? 0 : hits.length
}

function fieldLabel(field) {
  const map = {
    lifecard: '数据版本',
    id: '编号',
    kind: '类型',
    name: '名字',
    world: '属于哪个世界',
    from: '关系从谁出发',
    to: '关系指向谁',
  }
  return map[field] ?? field
}

function gradeOf(score) {
  if (score >= 90) return '很好'
  if (score >= 75) return '可用'
  if (score >= 55) return '还差点'
  return '需要补'
}

/** 给整个工作区算一个总分：所有卡的加权平均。 */
export function scoreAll(all) {
  const cards = Array.isArray(all?.cards) ? all.cards : []
  if (cards.length === 0) {
    return { score: null, grade: null, cards: [], note: '还没有档案' }
  }
  // 逐卡带上 index.js 路由同款形状：{ id, name, path, score }。
  // 两处各写一套形状，界面就会一半能读一半读不到。
  const scored = cards.map((c) => ({ id: c.id, name: c.name, path: c.path, score: scoreCard(c) }))
  const sum = scored.reduce((acc, s) => acc + s.score.score, 0)
  const score = Math.round(sum / scored.length)
  return { score, grade: gradeOf(score), cards: scored, note: `${scored.length} 张卡的平均分` }
}

export default { estimateTokens, estimateCardTokens, findPlaceholderIssues, findLorebook, scoreLorebook, scoreCard, scoreAll }
