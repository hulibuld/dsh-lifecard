/**
 * 「顺手数了一下」的测试。
 *
 * 这个东西只做统计，不做评价，所以测试也只钉两件事：
 * ① 该数出来的数得出来（套话、句式、身体模板、大词、糊词密度）
 * ② 不该数的别乱报（正常句子、单次出现的句式、空文本）
 *
 * 判错的代价：一份好稿子被机器指着说「用了 1 次此外」——作者会开始不信这个功能。
 */

import * as prose from '../lib/prose.js'

const results = []
function t(name, ok, detail) {
  results.push({ name, ok: ok === true, detail })
  console.log(`  ${ok === true ? 'PASS' : 'FAIL'} ${name}${ok === true || detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}

console.log('\n== 套话与大词：出现一次就该看见 ==')
{
  const scan = prose.scanProse('此外，天亮了。命运的齿轮开始转动。')
  const labels = scan.hits.map((h) => h.label).join('|')
  t('「此外」被数出来', labels.includes('此外'), labels)
  t('「命运的齿轮」被数出来', labels.includes('命运的齿轮'), labels)
  t('两条都给了一句原文', scan.hits.length === 2 && scan.hits.every((h) => String(h.sample ?? '') !== ''), scan.hits.map((h) => h.sample))

  const clean = prose.scanProse('他把煤筐放在门口，蹲下去系鞋带。鞋带断了一根。')
  t('干净的句子一条都不报', clean.total === 0 && clean.hits.length === 0, clean.hits)
  t('干净句子也说得出字数', clean.chars > 0, clean.chars)
}

console.log('\n== 句式：一次不算毛病，成密度才算 ==')
{
  const once = prose.scanProse('这不是钱的事，而是人的事。')
  // 数出来的原始结果里会有它（只数不判），但报告里不该出现——一句一个不算毛病。
  t('同一句只出现一次时报告里不列', !prose.proseReportText(once).includes('不是…而是'), prose.proseReportText(once))

  const many = prose.scanProse([
    '这不是钱的事，而是人的事。',
    '这不是快慢的事，而是有没有人的事。',
    '这不是谁对谁错，而是谁先走的事。',
  ].join('\n'))
  const hit = many.hits.find((h) => h.label.includes('不是…而是'))
  t('连着用三次就数出来', hit !== undefined && hit.count === 3, hit)
  t('数出来时给的是完整短句的片段', hit !== undefined && hit.sample.includes('不是'), hit?.sample)

  const bujin = prose.scanProse('他不禁笑了。她不禁回头看。我又不禁想起那年的雪。')
  const bujinHit = bujin.hits.find((h) => h.label.includes('不禁'))
  t('「不禁」用了三次被数出来', bujinHit !== undefined && bujinHit.count === 3, bujinHit)
}

console.log('\n== 身体模板：情绪一动就同一套反应 ==')
{
  const scan = prose.scanProse('他瞳孔一缩。她也瞳孔一缩。屋里没人说话，他又瞳孔一缩。')
  const hit = scan.hits.find((h) => h.kind === 'body')
  t('「瞳孔一缩」出现三次被数出来', hit !== undefined && hit.count === 3, hit)
  t('给的改法是写具体在看的什么', hit !== undefined && hit.advice.includes('看'), hit?.advice)

  const onceBody = prose.scanProse('他瞳孔一缩，把手里的碗放下了。')
  t('只出现一次的身体反应报告里不列（短稿）', !prose.proseReportText(onceBody).includes('瞳孔'), prose.proseReportText(onceBody))
}

console.log('\n== 糊词：按每五百字的密度算 ==')
{
  const short = prose.scanProse('他似乎来过，也许没有。')
  t('短稿不算密度（五百字以下不判太多）', short.fuzzy.tooMany === false, short.fuzzy)

  const long = ('他似乎来过。也许没有。仿佛有人在楼下等他。大概是这样。隐约听见过脚步。' + '他把门关上，坐了一会儿，什么也没做。'.repeat(40))
  const scan = prose.scanProse(long)
  t('五百字以上、糊词扎堆就判太多', scan.fuzzy.tooMany === true, scan.fuzzy)
  t('算出了每五百字几个', scan.fuzzy.per500 > 3, scan.fuzzy.per500)

  const report = prose.proseReportText(scan)
  t('报告里说清是每五百字几个', report.includes('每五百字'), report)
}

console.log('\n== 报告：没有就不占地方 ==')
{
  t('一条都没有时报告是空的', prose.proseReportText(prose.scanProse('他把煤筐放下，走了。')) === '', prose.proseReportText(prose.scanProse('他把煤筐放下，走了。')))
  const empty = prose.scanProse('')
  t('空文本不炸', empty.ok === true && empty.chars === 0 && empty.total === 0, empty)

  const sample = prose.scanProse('此外，他走了。')
  const text = prose.proseReportText(sample)
  t('报告一行一条，带「用了 N 次」', text.includes('用了 1 次'), text)
  t('举的原文不超过一行（截断过长的）', sample.hits.every((h) => h.sample.length <= 40), sample.hits.map((h) => h.sample.length))
}

console.log('\n== 形容词脱钩：物件上的词挂到了抽象东西上 ==')
{
  const scan = prose.scanProse('他做事很平，一段一段往下推。这个判断很沉。')
  const labels = scan.hits.filter((h) => h.kind === 'detached').map((h) => h.label).join('|')
  t('「做事很平」被数出来', labels.includes('做事很平'), labels)
  t('「判断很沉」被数出来', labels.includes('判断很沉'), labels)
  t('报告里出现一次就说，不等密度', prose.proseReportText(scan).includes('物件上的词'), prose.proseReportText(scan))

  const fine = prose.scanProse('这条路很平，车开上去不颠。这辆车坐得真稳。')
  t('挂在具体东西上就不报', fine.total === 0 && fine.hits.length === 0, fine.hits)

  const natural = prose.scanProse('他说话很轻，怕吵醒里屋的人。')
  t('「说话很轻」这种还原得出来的不报', natural.total === 0 && natural.hits.length === 0, natural.hits)
}

console.log('\n== 排序：先把话说等于没说的排前面 ==')
{
  const scan = prose.scanProse('于是天亮了然而他还在。此外，他走了。瞳孔一缩。不禁笑了。不禁又笑了。')
  const fillerAt = scan.hits.findIndex((h) => h.kind === 'filler')
  const bodyAt = scan.hits.findIndex((h) => h.kind === 'body')
  t('套话排在身体模板前面', fillerAt >= 0 && bodyAt >= 0 && fillerAt < bodyAt, scan.hits.map((h) => `${h.kind}:${h.count}`))
  t('总条数等于各条次数相加', scan.total === scan.hits.reduce((sum, h) => sum + h.count, 0), { total: scan.total, hits: scan.hits.length })
}

const failed = results.filter((r) => r.ok !== true)
console.log(`\nprose-test: ${results.length - failed.length} passed, ${failed.length} failed`)
if (failed.length > 0) {
  for (const r of failed) console.log(`  - ${r.name}`)
  process.exit(1)
}
