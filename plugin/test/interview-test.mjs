/**
 * 模拟面试那块的自测。
 *
 * 这块最要紧的不是「能不能问出问题」，是**问出来的东西干不干净**。
 * 所以断言集中在四条上：
 *   1. 就业歧视的问题一句都不许问（问了就是害用户）
 *   2. 追问必须引到上一句的原话（引不到就是编的）
 *   3. 问过的不许再问（否则像卡住了）
 *   4. 没配 AI 也开得了口（面试练习不该被模型绑架）
 */

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as iv from '../lib/jobs-interview.js'
import * as jobsStore from '../lib/jobs-store.js'

let pass = 0
let fail = 0
const t = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`) } else { fail += 1; console.log(`  FAIL ${name}${extra === undefined ? '' : ' — ' + String(extra)}`) }
}

const root = path.join(tmpdir(), 'lifecard-iv-' + Date.now())
await fs.mkdir(root, { recursive: true })

const REQS = [
  { requirement: '熟悉分布式事务', importance: 'critical', verdict: 'gap', proof: '' },
  { requirement: '带过三人以上团队', importance: 'high', verdict: 'gap', proof: '' },
  { requirement: '熟悉 Java', importance: 'medium', verdict: 'match', proof: '写过三年 Java' },
]

// ── 1. 不该问的东西 ────────────────────────────────────────────
console.log('\n=== 1. 就业歧视那些问题，一句都不许问 ===')
{
  const bans = [
    '你结婚了吗？',
    '有没有打算要孩子？',
    '你今年多大？',
    '你是哪里户口？',
    '你是什么民族？',
    '你有宗教信仰吗？',
    '你的政治面貌是什么？',
    '你有乙肝吗？',
    '能提供一下上一家的联系方式做背调吗？',
  ]
  for (const q of bans) {
    t(`拦住「${q.slice(0, 12)}…」`, iv.forbiddenIn(q) !== null)
  }
  t('拦住时说的是人话', String(iv.forbiddenIn('你结婚了吗')).includes('不该问'))
  t('正常技术问题不误伤', iv.forbiddenIn('你们的分库分表是怎么做的？') === null)
  t('「年龄」这两个字出现在技术问题里也会被拦（宁可错杀）', iv.forbiddenIn('这个接口的年龄字段怎么设计？') !== null)
  t('禁问项都写了理由', iv.FORBIDDEN_TOPICS.every((x) => typeof x.why === 'string' && x.why !== ''))
  t('不做背调写进了禁问表', iv.FORBIDDEN_TOPICS.some((x) => x.word === '背调'))
}

// ── 2. 去重 ───────────────────────────────────────────────────
console.log('\n=== 2. 问过的不许再问 ===')
{
  const asked = ['那你为什么这么做呢？', '你们团队一共几个人？']
  t('一字不差算重复', iv.alreadyAsked('你们团队一共几个人？', asked) === true)
  t('标点不同也算重复', iv.alreadyAsked('你们团队一共几个人', asked) === true)
  t('换个说法换个角度不算重复', iv.alreadyAsked('那次上线失败以后你怎么补救的？', asked) === false)
  t('短问题被上一句包含算重复', iv.alreadyAsked('为什么这么做', ['那你为什么这么做呢']) === true)
  t('空问题当重复处理', iv.alreadyAsked('   ', asked) === true)
  t('没问过任何问题时谁都不重复', iv.alreadyAsked('随便问一句', []) === false)
}

// ── 3. 从招聘说明里挑该问什么 ─────────────────────────────────
console.log('\n=== 3. 先问材料里没写的 ===')
{
  const p1 = iv.pickTarget(REQS, [])
  t('第一个问的是 gap 里最重要的那条', p1.kind === 'gap' && p1.requirement.index === 0)
  const p2 = iv.pickTarget(REQS, ['req:0'])
  t('问过第一条就换第二条', p2.requirement !== null && p2.requirement.index === 1)
  const p3 = iv.pickTarget(REQS, ['req:0', 'req:1'])
  t('gap 问完转去讲具体的事', p3.kind === 'behavior' && p3.requirement.index === 2)
  const p4 = iv.pickTarget(REQS, ['req:0', 'req:1', 'req:2'])
  t('全问完了就问动机', p4.kind === 'motivation' && p4.requirement === null)
  const p5 = iv.pickTarget([], [])
  t('一条要求都没有也能开一场（问动机）', p5.kind === 'motivation')
  t('挑目标不会把没对上的一条漏掉', iv.pickTarget(REQS, []).requirement.verdict === 'gap')
}

// ── 4. 没 AI 也能开口 ──────────────────────────────────────────
console.log('\n=== 4. 没配 AI 也问得出来 ===')
{
  const q1 = iv.offlineQuestion({ kind: 'gap', requirement: REQS[0] })
  t('gap 的问题把那条要求念出来了', q1.includes('分布式事务'))
  t('gap 的问题说了「你材料里没有」', q1.includes('没有'))
  t('gap 的问题是问句', q1.includes('？'))
  const q2 = iv.offlineQuestion({ kind: 'behavior', requirement: { ...REQS[2], proof: '写过三年 Java' } })
  t('behavior 的问题引了他写过的话', q2.includes('三年 Java'))
  const q3 = iv.offlineQuestion({ kind: 'motivation', requirement: null }, { company: '某公司' })
  t('motivation 的问题带上了公司名', q3.includes('某公司'))
  const q4 = iv.offlineQuestion({ kind: 'motivation', requirement: null }, {})
  t('没有公司名时不硬塞', !q4.includes('某公司') && q4.length > 10)
  const q5 = iv.offlineQuestion({ kind: 'motivation', requirement: null }, { company: '' })
  t('公司名是空串时也不硬塞', !q5.includes('想去？'))
  const all = [q1, q2, q3, q4, q5]
  t('本地问题里没有就业歧视的', all.every((q) => iv.forbiddenIn(q) === null))
  t('本地问题都够短（面试官不会一口气念三百字）', all.every((q) => q.length <= 120))
}

// ── 5. 校验模型给的那一问 ──────────────────────────────────────
console.log('\n=== 5. 模型给的这一问过不过得了闸 ===')
{
  const good = { question: '你刚才说你们三个人，另外两个人为什么不背这块？', kind: 'explain', quoted: '我们三个人', why_ask: '他说了团队规模但没说分工' }
  const ok = iv.checkQuestion(good, { asked: [], lastAnswer: '我们三个人做这块，后来我把它拆了。' })
  t('引到了原话就放行', ok.ok === true)
  t('放行时带出 kind', ok.question.kind === 'explain')
  t('放行时带出为什么问', ok.question.why_ask !== '')

  const noQuote = iv.checkQuestion({ question: '能详细说说吗？', kind: 'explain', quoted: '' }, { asked: [], lastAnswer: '我们三个人做这块。' })
  t('追问不指原话的被拦', noQuote.ok === false && noQuote.reason.includes('追哪一句'))

  const fakeQuote = iv.checkQuestion({ question: '你说的那个大促是怎么做的？', kind: 'explain', quoted: '双十一大促' }, { asked: [], lastAnswer: '我们三个人做这块。' })
  t('引的原话在他回答里找不到的被拦', fakeQuote.ok === false && fakeQuote.reason.includes('找不到'))

  const dup = iv.checkQuestion({ question: '你们团队几个人？', kind: 'behavior', quoted: '' }, { asked: ['你们团队几个人？'], lastAnswer: '' })
  t('重复的被拦', dup.ok === false && dup.reason.includes('问过'))

  const ban = iv.checkQuestion({ question: '你结婚了吗？', kind: 'behavior', quoted: '' }, { asked: [], lastAnswer: '' })
  t('问了不该问的被拦', ban.ok === false && ban.reason.includes('不该问'))

  const empty = iv.checkQuestion({ question: '   ' }, { asked: [], lastAnswer: '' })
  t('空问题被拦', empty.ok === false)

  const notObj = iv.checkQuestion('随便一句字符串', { asked: [], lastAnswer: '' })
  t('不是对象被拦', notObj.ok === false)

  const tooLong = iv.checkQuestion({ question: '问'.repeat(400) }, { asked: [], lastAnswer: '' })
  t('太长被拦', tooLong.ok === false)

  const unknownKind = iv.checkQuestion({ question: '那次上线你们怎么回滚的？', kind: '乱写的种类' }, { asked: [], lastAnswer: '' })
  t('种类不认识时兜底成 behavior 而不是丢掉', unknownKind.ok === true && unknownKind.question.kind === 'behavior')

  // behavior 不要求引原话——第一次问「讲一件具体的事」本来就没有上一句可追
  const behaviorNoQuote = iv.checkQuestion({ question: '讲一次线上出问题的经历。', kind: 'behavior', quoted: '' }, { asked: [], lastAnswer: '' })
  t('没有上一句答案时，behavior 不硬要原话', behaviorNoQuote.ok === true)
}

// ── 6. 本地看一段回答 ─────────────────────────────────────────
console.log('\n=== 6. 答得怎么样，不用 AI 也看得出来 ===')
{
  const empty = iv.reviewAnswer('')
  t('空回答标成没答', empty.verdict === 'empty')

  const thin = iv.reviewAnswer('还行吧，就那样。')
  t('太短的点出来', thin.findings.some((f) => f.code === 'too-short'))
  t('太短的说清只有几个字', thin.findings.find((f) => f.code === 'too-short').say.includes('个'))

  const solid = iv.reviewAnswer('去年双十一前，我负责的那个下单接口在压测里 TPS 只有 800，我把缓存从本地换成 Redis，又拆了两个同步调用，最后跑到 3200，第二天上线没出问题。')
  t('有数字有动作有结果的，不再挑刺', solid.verdict === 'solid', JSON.stringify(solid.findings))
  t('solid 里没有「没听见我做了什么」', !solid.findings.some((f) => f.code === 'no-action'))

  const noNumber = iv.reviewAnswer('我把那个模块重写了一遍，最后把性能问题解决了，大家都挺满意。')
  t('一个数字都没有的点出来', noNumber.findings.some((f) => f.code === 'no-number'))

  const noAction = iv.reviewAnswer('当时那个项目比较紧张，然后就被推迟了，最后也没上线。')
  t('听不出本人做了什么', noAction.findings.some((f) => f.code === 'no-action'))

  const noResult = iv.reviewAnswer('我先查了日志，然后改了配置，又找了两个人一起看，最后还是没搞定。')
  const codes = noResult.findings.map((f) => f.code)
  t('说了过程没给结果时……「没搞定」也算结果（不误伤）', !codes.includes('no-result'), JSON.stringify(codes))

  const buried = iv.reviewAnswer('先说一下背景，这个事情是这样的，去年公司……')
  t('开头铺垫被点出来', buried.findings.some((f) => f.code === 'buried'))

  const giveUp = iv.reviewAnswer('不知道，这个我没做过，不好意思。')
  t('一上来就说不会', giveUp.findings.some((f) => f.code === 'give-up'))

  const filler = iv.reviewAnswer('其实那个其实是这样，然后呢我们就，就是说，反正差不多就这样吧。')
  t('口头语太多被点出来', filler.findings.some((f) => f.code === 'filler'))

  t('挑刺的每一条都说清了怎么改', iv.reviewAnswer('还行。').findings.every((f) => f.say.length > 6))
  t('不给总分（分数会让人误以为稳了）', !('score' in solid))
}

// ── 7. 追问往哪里追 ───────────────────────────────────────────
console.log('\n=== 7. 下一句该追哪儿 ===')
{
  t('没答的时候不追', iv.pickFocus('') === null)
  const f1 = iv.pickFocus('我把那个模块重写了一遍，最后把性能问题解决了。')
  t('没数字时追数字', /数字|数量/.test(String(f1)))
  const f2 = iv.pickFocus('那个项目一共 5 个人做了 3 个月，最后被推迟了。')
  t('全是「我们」时追他本人', /本人|我/.test(String(f2)))
  const f3 = iv.pickFocus('我改了 3 次，最后通过了。')
  t('答得太短时追具体的事', String(f3).includes('具体'))
  const f4 = iv.pickFocus('去年双十一前，我负责的那个下单接口在压测里 TPS 只有 800，我把缓存从本地换成 Redis，又拆了两个同步调用，最后跑到 3200，第二天上线没出问题。')
  t('答得还行时也挑一句往下问', typeof f4 === 'string' && f4.includes('哪一次'))
}

// ── 8. 提示词 ─────────────────────────────────────────────────
console.log('\n=== 8. 提问的提示词里写了什么 ===')
{
  const p = iv.buildTurnPrompt({
    company: '某公司',
    role: '后端',
    requirements: REQS,
    transcript: [
      { role: 'interviewer', text: '讲讲你做过最复杂的一个系统。' },
      { role: 'candidate', text: '我们三个人做这块，后来我把它拆了。' },
    ],
    target: { kind: 'gap', requirement: { ...REQS[0], index: 0 } },
    focus: '他通篇在说「我们」。',
    cvText: '写过三年 Java。',
    questionNo: 2,
  })
  t('说了这是第几个问题', p.includes('第 2 个'))
  t('把公司名带进去了', p.includes('某公司'))
  t('把第几条要求带进去了', p.includes('分布式事务'))
  t('把已经问过的列出来了', p.includes('讲讲你做过最复杂的一个系统'))
  t('把上一句回答原样带进去了（追问要引得到）', p.includes('我们三个人做这块'))
  t('把该追的点带进去了', p.includes('通篇在说'))
  t('明确要求只问一个问题', p.includes('只问一个问题'))
  t('明确禁止「能详细说说吗」这种空话', p.includes('空话'))
  t('明确禁止评价答得好不好', p.includes('不许评价'))
  t('明确禁止问婚育', p.includes('婚育'))
  t('明确说不做背景调查', p.includes('背景调查'))
  t('要求 JSON 输出', p.includes('JSON'))
  t('要求的字段都在', ['question', 'kind', 'quoted', 'why_ask'].every((k) => p.includes(k)))
  t('没有把材料原文整段抄进提示词（只用来提问）', !p.includes('<!DOCTYPE'))
}

// ── 9. 一场下来怎么总结 ───────────────────────────────────────
console.log('\n=== 9. 一场下来总结什么 ===')
{
  const session = {
    id: 'x',
    company: '某公司',
    role: '后端',
    turns: [
      { question: 'Q1', kind: 'gap', answer: '不知道。', review: { findings: [{ code: 'too-short' }, { code: 'no-number' }] } },
      { question: 'Q2', kind: 'behavior', answer: '我重写了模块，结果好了。', review: { findings: [{ code: 'no-number' }] } },
      { question: 'Q3', kind: 'explain', answer: '', skipped: true, review: { findings: [] } },
    ],
  }
  const s = iv.summarize(session)
  t('说了问几个答几个跳几个', s.lines[0].includes('3 个') && s.lines[0].includes('2 个') && s.lines[0].includes('跳过 1 个'))
  t('说了几次没有数字', s.lines.some((l) => l.includes('2 次') && l.includes('数字')))
  t('说了有几个问的是材料里没写的', s.lines.some((l) => l.includes('材料里没写')))
  const perfect = iv.summarize({
    turns: [{ question: 'Q', kind: 'behavior', answer: 'ok', review: { findings: [] } }],
  })
  t('全都没刺的时候也给一句正面的话', perfect.lines.some((l) => l.includes('面就行')))
  t('一次都没答也不崩', iv.summarize({ turns: [] }).lines.length > 0)
  t('空 session 不抛异常', typeof iv.summarize(undefined).lines === 'object')
}

// ── 10. 存档 ─────────────────────────────────────────────────
console.log('\n=== 10. 练过的场次要存得住 ===')
{
  const session = {
    id: 'mock-1',
    company: '某公司',
    role: '后端',
    started_at: '2026-10-20T10:00:00.000Z',
    turns: [{ question: '讲讲你的项目。', kind: 'behavior', answer: '做过一个交易系统。', review: { findings: [] } }],
    markdown: iv.renderTranscript({ company: '某公司', role: '后端', started_at: '2026-10-20T10:00:00.000Z', turns: [{ question: '讲讲你的项目。', kind: 'behavior', answer: '做过一个交易系统。', review: { findings: [] } }] }),
  }
  const saved = await jobsStore.saveInterview(root, session)
  t('存得下', saved.ok === true)
  t('落在 jobs/interviews/', String(saved.path).startsWith('jobs/interviews/'))
  const back = await jobsStore.readInterview(root, 'mock-1')
  t('读得回来', back.ok === true && back.session.id === 'mock-1')
  t('读回来的问题一样', back.session.turns[0].question === '讲讲你的项目。')
  const mdSaved = await jobsStore.saveInterview(root, session)
  t('同时留了一份能读的', mdSaved.markdown !== null && String(mdSaved.markdown).endsWith('.md'))
  const md = await fs.readFile(path.join(root, 'jobs/interviews/mock-1.md'), 'utf8')
  t('那份里有人话的总结', md.includes('这一场下来'))
  t('没有 id 时拒绝', (await jobsStore.saveInterview(root, { turns: [] })).ok === false)
  t('读不存在的场次给人话', (await jobsStore.readInterview(root, 'nope')).ok === false)
  t('空 id 读的时候给人话', (await jobsStore.readInterview(root, '')).error.includes('哪一场'))
  const list = await jobsStore.listInterviews(root)
  t('列表里有这一场', list.ok === true && list.items.some((x) => x.id === 'mock-1'))
  t('列表带上了答了几题', list.items.find((x) => x.id === 'mock-1').answered === 1)
  const emptyRoot = path.join(tmpdir(), 'lifecard-iv-empty-' + Date.now())
  t('没练过时列表是空的而不是报错', (await jobsStore.listInterviews(emptyRoot)).items.length === 0)
  const evil = await jobsStore.saveInterview(root, { id: '../../evil', turns: [] })
  const evilAbs = path.resolve(root, String(evil.path ?? ''))
  t('id 里的路径符号被去掉，写不到工作区外面', evil.ok === true && evilAbs.startsWith(path.resolve(root) + path.sep))
}

// ── 11. 离线承诺 ──────────────────────────────────────────────
console.log('\n=== 11. 这一层不自己联网 ===')
{
  const src = await fs.readFile(new URL('../lib/jobs-interview.js', import.meta.url), 'utf8')
  t('没有 fetch', !/\bfetch\(/.test(src))
  t('没有 http 客户端', !/node:https?/.test(src))
  t('没有读写文件（纯逻辑）', !/node:fs/.test(src))
  t('没有直接调模型', !/llm\.stream|callModel/.test(src))
  t('一条 import 都没有', (src.match(/^import .*$/gm) ?? []).length === 0)
  t('最多八轮写在常量里', iv.MAX_TURNS === 8)

  // ── 第 9 组：被拦下之后要带着原因重问 ──
  // 模型不知道自己踩了哪条线。不告诉它就等于白丢一整轮，
  // 用户看到的是「AI 出了个题」，其实那句从没被用过。
  const base = {
    company: '某公司', role: '后端', requirements: [], transcript: [],
    target: { requirement: null }, questionNo: 2,
  }
  const without = iv.buildTurnPrompt(base)
  const withReject = iv.buildTurnPrompt({ ...base, reject: '这个问题不该问：不能问婚姻状况（「婚」）' })
  t('没说被拦时提示词里没有这一节', !without.includes('被拦下了'))
  t('被拦下时提示词里说清了被拦下', withReject.includes('被拦下了'))
  t('被拦下时把具体原因带进去', withReject.includes('不能问婚姻状况'))
  t('被拦下时要求换个问法', withReject.includes('换个问法'))
  t('被拦下时不许在同一个坑里再掉一次', withReject.includes('同一个坑'))
  t('重问时原来那几条规矩还在', withReject.includes('只问一个问题') && withReject.includes('不许问婚育'))
  t('重问时目标还是同一个', withReject.includes('这一轮问「动机」'))
  t('空字符串当场不生效', iv.buildTurnPrompt({ ...base, reject: '   ' }) === without)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
await fs.rm(root, { recursive: true, force: true }).catch(() => {})
