// 离线体检打分（lib/score.js）的单元测试。
//
// 这一层最容易出的问题是「同一个东西两套算法」——比如覆盖率在 core.js
// 里算一遍、这里又算一遍，两边慢慢漂开。所以测试里刻意拿 core.coverage
// 的结果做对账，而不是只看自己给的数字对不对。
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as score from '../lib/score.js'
import * as core from '../lib/core.js'

let pass = 0, fail = 0
const t = (n, c, x) => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, x === undefined ? '' : String(x).slice(0, 300)) } }

console.log('=== 1. token 估算 ===')
{
  t('纯中文按字算', score.estimateTokens('你好世界') === 4, score.estimateTokens('你好世界'))
  t('纯英文按 4 字符算', score.estimateTokens('abcdefgh') === 2, score.estimateTokens('abcdefgh'))
  // 2 个汉字 + 5 个非汉字字符（含空格），后者按 4 字符 1 token 上取整 = 2
t('混排分开算', score.estimateTokens('你好 abcd') === 4, score.estimateTokens('你好 abcd'))
  t('空串是 0', score.estimateTokens('') === 0, score.estimateTokens(''))
  t('null 也是 0', score.estimateTokens(null) === 0, score.estimateTokens(null))
  t('全角标点算中文', score.estimateTokens('。，、') === 3, score.estimateTokens('。，、'))

  const card = { data: { name: '妈妈', relation: '母亲' }, sections: [{ title: '自述', body: '一二三四五六七八九十' }] }
  const n = score.estimateCardTokens(card.data, card.sections)
  t('整卡估算大于正文', n > 10, n)
  t('整卡估算是整数', Number.isInteger(n), n)
}

console.log('=== 2. 占位符检查 ===')
{
  const clean = score.findPlaceholderIssues({}, [{ title: '自述', body: '我是个木匠。' }])
  t('干净的正文没有问题', clean.length === 0, clean)

  const leftover = score.findPlaceholderIssues({}, [{ title: '自述', body: '我是 {{char}}。' }])
  t('残留 {{char}} 会被抓到', leftover.some((i) => i.code === 'placeholder-leftover'), leftover)
  t('残留项给了修法', leftover.every((i) => typeof i.fix === 'string' && i.fix !== ''), leftover)

  const usurp = score.findPlaceholderIssues({}, [{ title: '自述', body: '{{user}} 每天五点起床。' }])
  t('自述里的 {{user}} 单独报「冒名」', usurp.some((i) => i.code === 'placeholder-in-self-narration'), usurp)
  t('冒名不会被重复报成残留', usurp.filter((i) => i.code === 'placeholder-leftover').length === 0, usurp)

  // 冒名只在自述里算；性格里的 {{user}} 是正当用法（角色在说「你」）
  const legit = score.findPlaceholderIssues({}, [{ title: '性格', body: '他见到 {{user}} 就笑。' }])
  t('非自述小节的 {{user}} 不算冒名', legit.every((i) => i.code !== 'placeholder-in-self-narration'), legit)
}

console.log('=== 3. 世界书健康度 ===')
{
  const none = score.scoreLorebook(undefined)
  t('没写世界书不扣分', none.points === null && none.ratio === null, none)
  t('没写世界书有说明', typeof none.note === 'string' && none.note !== '', none.note)

  const bad = score.scoreLorebook({
    entries: [
      { keys: ['王城'], content: '阿斯特兰位于河谷北岸' },
      { keys: [], content: '有内容但没触发词' },
      { keys: ['王城'], content: '重复的触发词' },
      { keys: ['废墟'], content: '' },
    ],
  })
  const codes = bad.findings.map((f) => f.code)
  t('空条目被抓到', codes.includes('lore-empty'), codes)
  t('没触发词被抓到', codes.includes('lore-no-keys'), codes)
  t('重复触发词被抓到', codes.includes('lore-dup-key'), codes)
  t('只有 1 条完全可用', bad.note.startsWith('1/4'), bad.note)

  const good = score.scoreLorebook({ entries: [{ keys: ['王城'], content: '阿斯特兰位于河谷北岸' }] })
  t('健康的世界书不报问题', good.findings.length === 0, good.findings)
  t('健康的世界书拿满分', good.points === good.max, good)
}

console.log('=== 3b. 世界书到底存在哪 ===')
{
  // 这条是回归：早先我按 data.lorebook 找世界书，永远是 undefined，
  // 于是「带世界书的卡」被当成「没写世界书」白送满分。真实位置在
  // data.cc.fields.character_book（codec.ccToLifeCard 就这么放的）。
  const viaCc = { cc: { fields: { character_book: { entries: [{ keys: ['王城'], content: '阿斯特兰' }] } } } }
  t('从 cc.fields 里找得到世界书', score.findLorebook(viaCc) !== undefined, score.findLorebook(viaCc))
  t('找到的是同一份', score.findLorebook(viaCc)?.entries?.[0]?.keys?.[0] === '王城', score.findLorebook(viaCc))

  const direct = { lorebook: { entries: [{ keys: ['x'], content: 'y' }] } }
  t('数据里的 lorebook 也认', score.findLorebook(direct) !== undefined, score.findLorebook(direct))

  t('两个都没有就返回 undefined', score.findLorebook({}) === undefined, score.findLorebook({}))
  t('空 entries 不算有世界书', score.findLorebook({ lorebook: { entries: [] } }) === undefined, '')

  // 带世界书的卡不该白拿那 10 分
  const bad = score.scoreCard({
    data: { lifecard: '0.1', id: 's', kind: 'fictional', world: 'eldoria', name: '塞拉菲娜', cc: { fields: { character_book: { entries: [{ keys: [], content: '' }] } } } },
    sections: [{ title: '自述', body: '〔自述〕她是个法师。' }],
  })
  const row = bad.breakdown.find((b) => b.key === 'lorebook')
  t('世界书有毛病时扣分', row.got < row.max, row)
  t('扣分时给出人话原因', bad.findings.some((f) => f.code.startsWith('lore-')), bad.findings.map((f) => f.code))
}

console.log('=== 4. 单卡打分 ===')
{
  const full = {
    data: {
      lifecard: '0.1', id: 'mama', kind: 'real', world: 'reality', name: '妈妈',
      relation: '母亲', birth_year: 1968, address: '妈',
      competency: [{ key: '做红烧肉', level: '精通' }],
      knowledge: [{ label: '老家的邻居' }],
      taboos: [{ label: '外公去世那年' }],
      life: '在城里带孩子',
      consent: { basis: 'family-agreed', recorded_at: '2026-10-01' },
    },
    sections: [
      { title: '自述', body: '〔自述〕她一辈子在厨房和工厂之间来回。' },
      { title: '性格', body: '〔他述〕嘴上凶，事后会默默把饭端出来。' },
      { title: '关系史', body: '〔自述〕1998 年她把我从外婆家接回去。' },
      { title: '不会说的话', body: '〔推测〕她大概不会说「我爱你」。' },
      { title: '外貌', body: '〔他述〕个子不到一米六，手很粗。' },
      { title: '口癖', body: '〔自述〕「吃了没有」。' },
    ],
  }
  const r = score.scoreCard(full)
  t('完整的卡分数高', r.score >= 85, r.score)
  t('分数在 0-100 之间', r.score >= 0 && r.score <= 100, r.score)
  t('有分档描述', typeof r.grade === 'string' && r.grade !== '', r.grade)
  t('六项构成合计等于总分', r.breakdown.reduce((a, b) => a + b.got, 0) === r.score, { sum: r.breakdown.reduce((a, b) => a + b.got, 0), score: r.score })
  t('每项都不超过上限', r.breakdown.every((b) => b.got <= b.max), r.breakdown)
  t('覆盖率与 core 一致', r.coverage === core.coverage(full.data, full.sections).percent, { score: r.coverage, core: core.coverage(full.data, full.sections).percent })

  // 空卡：不该崩，分数应该很低，而且要说「先补自述」
  const empty = score.scoreCard({ data: { lifecard: '0.1', id: 'x', kind: 'real', name: '' }, sections: [] })
  t('空卡不会崩', typeof empty.score === 'number', empty)
  t('空卡分数低', empty.score < 40, empty.score)
  t('空卡提示先补内容', empty.findings.some((f) => f.code === 'empty-card'), empty.findings.map((f) => f.code))

  // 缺必填：分数掉，且报 error
  const missing = score.scoreCard({ data: { lifecard: '0.1', id: 'x', kind: 'real', name: '甲' }, sections: [{ title: '自述', body: '甲是个木匠。' }] })
  t('缺 world 被标成错误', missing.findings.some((f) => f.code === 'missing-required' && f.field === 'world'), missing.findings)
  t('缺必填的人话字段名', missing.findings.some((f) => f.message.includes('属于哪个世界')), missing.findings.map((f) => f.message))

  // 占位符扣分
  const withPh = score.scoreCard({ data: full.data, sections: [{ title: '自述', body: '我是 {{user}}。' }] })
  const phRow = withPh.breakdown.find((b) => b.key === 'placeholder')
  t('占位符问题会扣分', phRow.got < phRow.max, phRow)

  // 每个 finding 都得能指出去改哪
  t('每条建议都带修法', r.findings.concat(empty.findings, missing.findings).every((f) => typeof f.fix === 'string' && f.fix !== ''), '')
}

console.log('=== 5. 整个工作区打分 ===')
{
  const none = score.scoreAll({ cards: [] })
  t('没卡时分数是 null', none.score === null, none)
  t('没卡时给了说明', typeof none.note === 'string' && none.note !== '', none.note)

  const all = score.scoreAll({
    cards: [
      { id: 'a', name: '甲', path: 'a.md', data: { lifecard: '0.1', id: 'a', kind: 'real', name: '甲', world: 'reality' }, sections: [{ title: '自述', body: '〔自述〕甲是木匠。' }] },
      { id: 'b', name: '乙', path: 'b.md', data: { lifecard: '0.1', id: 'b', kind: 'real', name: '乙', world: 'reality' }, sections: [] },
    ],
  })
  t('有卡时算平均数', Number.isInteger(all.score), all.score)
  t('逐卡都有分', all.cards.every((c) => Number.isInteger(c.score.score)), all.cards)
  t('说明里带张数', all.note.includes('2 张'), all.note)
}

console.log('=== 6. 接进 doctor 路由后仍是纯本地 ===')
{
  // 这条守的是「离线」这个承诺本身：score.js 不能 import 任何宿主代码。
  const src = await fs.readFile(new URL('../lib/score.js', import.meta.url), 'utf8')
  const imports = [...src.matchAll(/^import .*$/gm)].map((m) => m[0])
  t('只 import 了 core.js', imports.length === 1 && imports[0].includes("'./core.js'"), imports)
  t('没有 fetch', !/\bfetch\s*\(/.test(src))
  t('没有 node:fs', !/node:fs/.test(src))
  t('没有 ctx.', !/\bctx\./.test(src))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
