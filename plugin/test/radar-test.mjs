/**
 * radar.js 的测试：一本书的「吃书」检测。
 *
 * 这个模块的成败不在于能查出多少，而在于**查错多少**。一份满是假阳性的
 * 报告作者看两眼就再也不打开了，功能等于没有。所以这里的测试分成两半：
 *
 *   一半是「必须报」——真矛盾漏了，功能没用；
 *   一半是「必须不报」——正常写法被报出来，功能有害。
 *
 * 「必须不报」那半比「必须报」那半重要。每一条都是踩过的坑，注释里写了
 * 当时是怎么错的。
 */

import * as radar from '../lib/radar.js'

let pass = 0
let fail = 0
const t = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name}${detail === '' ? '' : `  ← ${detail}`}`) }
}

const book = (chapters) => radar.scanBook(chapters.map((body, i) => ({ index: i + 1, body })))
const holes = (chapters) => radar.findHoles(book(chapters))

console.log('\n=== 1. 中文数字 ===')
{
  t('十七 = 17', radar.cnum('十七') === 17, radar.cnum('十七'))
  t('二十 = 20', radar.cnum('二十') === 20, radar.cnum('二十'))
  t('三十五 = 35', radar.cnum('三十五') === 35, radar.cnum('三十五'))
  t('一百零八 = 108', radar.cnum('一百零八') === 108, radar.cnum('一百零八'))
  t('阿拉伯数字照样认', radar.cnum('42') === 42, radar.cnum('42'))
  t('不是数字的回 null', radar.cnum('忽然') === null, radar.cnum('忽然'))
  t('空串回 null', radar.cnum('') === null, radar.cnum(''))
}

console.log('\n=== 2. 名字：认得出来的 ===')
{
  t('阿昭 像名字', radar.looksLikeName('阿昭') === true)
  t('张三 像名字（数字开头但那是人名）', radar.looksLikeName('张三') === true)
  t('李四 像名字', radar.looksLikeName('李四') === true)
  // 张三李四这一组曾经被「数字开头一律不是名字」那条规则误杀，
  // 于是中文里最常见的一类人名全漏了。
  const s = book(['张三说道：「走。」', '李四笑道：「等。」'])
  t('张三 被认出来了', s.people.includes('张三'), JSON.stringify(s.people))
  t('李四 被认出来了', s.people.includes('李四'), JSON.stringify(s.people))
}

console.log('\n=== 3. 名字：认不出来的（宁少不误）===')
{
  // 每一条都是拿真实中文文本跑出来的误认。
  // 这一批是「单看这两个字/四个字就不像名字」的：黑名单 + 构词方式拦得住。
  for (const bad of ['忽然', '片刻', '众人', '大家', '直接', '不知', '第二', '一句', '不替他', '拿不准', '动笔前先']) {
    t(`「${bad}」不当名字`, radar.looksLikeName(bad) === false)
  }
  // 「免费渠」「远程访」是另一类：单看这四个字挑不出毛病，是**位置**不对
  // ——它们是「免费渠道」「远程访问」的词内片段，靠左边界与说话动词尾部
  // 判据拦。所以断言写在整本书的扫描结果上，不写在 looksLikeName 上。
  // 「远程访问用的是…」：说话动词表里的「问」被「访问」蹭到了，
  // 而「远程访」前面正好是换行，左边界判据拦不住。
  const s = book(['远程访问用的是 quick tunnel。', '免费渠道只有这一条。'])
  t('「远程访问」不会被认成人', s.people.length === 0, JSON.stringify(s.people))
  t('「免费渠道」不会被认成人', !s.people.includes('免费渠'), JSON.stringify(s.people))
  // 真在交代台词的句子照样要认出来。
  const s2 = book(['阿昭说道：「走。」', '阿昭笑道：「好。」'])
  t('真台词照样认得出来', s2.people.includes('阿昭'), JSON.stringify(s2.people))
}

console.log('\n=== 4. 属性抽取 ===')
{
  t('十七岁', radar.attrMentions('阿昭今年十七岁。', '阿昭').some((x) => x.attr === 'age' && x.value === 17))
  t('阿拉伯数字的岁数', radar.attrMentions('阿昭今年 17 岁。', '阿昭').some((x) => x.attr === 'age' && x.value === 17))
  t('身高一百七十五厘米', radar.attrMentions('阿昭身高一百七十五厘米。', '阿昭').some((x) => x.attr === 'height'))
  t('眼睛是灰色的', radar.attrMentions('阿昭的眼睛是灰色的。', '阿昭').some((x) => x.attr === 'eye' && x.value === '灰色'))
  // 同一句里第二个属性没重复名字，仍然归给他——这是中文最自然的写法。
  const both = radar.attrMentions('阿昭今年十七岁，眼睛是灰色的。', '阿昭')
  t('同一句里第二个属性也算他的', both.some((x) => x.attr === 'eye'), JSON.stringify(both))
  // 别人不该被算进来。
  t('别人的句子不算他的', radar.attrMentions('李四今年四十岁。', '阿昭').length === 0)
}

console.log('\n=== 5. 必须报：真矛盾 ===')
{
  // 年龄倒退
  const b = holes(['阿昭今年二十岁。阿昭说道：「我来了。」', '阿昭今年十七岁。阿昭说道：「嗯。」'])
  t('年龄倒退要报', b.some((h) => h.attr === 'age'), JSON.stringify(b.map((x) => x.title)))
  t('报出来带两个章号', b.length > 0 && b[0].left.chapter !== b[0].right.chapter)
  t('报出来带原句', b.length > 0 && String(b[0].left.sentence).includes('二十'))

  // 瞳色变了
  const c = holes(['阿昭的眼睛是灰色的。阿昭说道：「看什么。」', '阿昭的眼睛是蓝色的。阿昭说道：「怎么。」'])
  t('瞳色变了要报', c.some((h) => h.attr === 'eye'), JSON.stringify(c.map((x) => x.title)))

  // 死了又出场
  const d = holes(['张三说道：「我先走一步。」', '张三死了。', '张三说道：「又见面了。」'])
  t('死了又出场要报', d.some((h) => h.kind === 'dead'), JSON.stringify(d.map((x) => x.title)))
  t('死而复现那条认的是后一次出场', d.some((h) => h.kind === 'dead' && h.right.chapter === 3), JSON.stringify(d))

  // 中间那个值不能因为端点相同就被跳过（改设定改到一半，最典型的一种）
  const e = holes(['阿昭今年十七岁。阿昭说道：「一。」', '阿昭今年十九岁。阿昭说道：「二。」', '阿昭今年十七岁。阿昭说道：「三。」'])
  t('十七→十九→十七 要报出来', e.some((h) => h.attr === 'age'), JSON.stringify(e.map((x) => x.title)))
}

console.log('\n=== 6. 必须不报：正常写法 ===')
{
  // 跨年长大：书里时间往前走，年龄变大是对的。
  // 这一条如果误报，任何一本有跨年的书都会被刷满假警报。
  const grow = holes(['阿昭今年十七岁。阿昭说道：「走。」', '阿昭已经十九岁了。阿昭说道：「两年了。」'])
  t('年龄变大不报', grow.length === 0, JSON.stringify(grow.map((x) => x.title)))

  // 等级提升同理
  const lv = holes(['阿昭练气三层。阿昭说道：「一。」', '阿昭练气五层。阿昭说道：「二。」'])
  t('等级提升不报', lv.length === 0, JSON.stringify(lv.map((x) => x.title)))

  // 假设句里的「死」
  const hypo = holes(['张三说道：「你要是死了，我也不活。」', '张三说道：「回来了。」'])
  t('假设句里的死不报', hypo.length === 0, JSON.stringify(hypo.map((x) => x.title)))

  // 引号里的「死」是台词，不是设定
  const quoted = holes(['张三说道：「外面都在传你死了。」', '张三说道：「我好好的。」'])
  t('台词里的死不报', quoted.length === 0, JSON.stringify(quoted.map((x) => x.title)))

  // 骂人话
  const curse = holes(['张三说道：「该死。」', '张三说道：「走。」'])
  t('「该死」不当死亡', curse.length === 0, JSON.stringify(curse.map((x) => x.title)))

  // 同一章里写两遍不同值：初稿手误，报出来太吵
  const same = holes(['阿昭今年十七岁，又写她十七岁。阿昭说道：「嗯。」'])
  t('只有一章时不报', same.length === 0, JSON.stringify(same.map((x) => x.title)))
}

console.log('\n=== 7. 别名归并 ===')
{
  const chapters = [
    { index: 1, body: '阿昭今年二十岁。阿昭说道：「一。」' },
    { index: 3, body: '昭姐今年十七岁。昭姐说道：「二。」' },
  ]
  // 不归并：两个人，各自只有一条记录，比不出矛盾。
  const apart = radar.findHoles(radar.scanBook(chapters))
  t('不归并时比不出来', apart.length === 0, JSON.stringify(apart.map((x) => x.title)))
  // 归并之后：同一个人的年龄倒退，要报。
  const merged = radar.findHoles(radar.scanBook(chapters, { alias: { 阿昭: ['昭姐'] } }))
  t('归并之后报得出来', merged.some((h) => h.attr === 'age'), JSON.stringify(merged.map((x) => x.title)))
  t('归并后只有一个人', radar.scanBook(chapters, { alias: { 阿昭: ['昭姐'] } }).people.length === 1)
}

console.log('\n=== 8. 走路人名字（用户点名）===')
{
  // 书里全靠代称、认不出名字时，用户能自己点名。点了名的照收。
  const chapters = [{ index: 1, body: '老陈今年十七岁。' }, { index: 3, body: '老陈今年四十岁。' }]
  const auto = radar.findHoles(radar.scanBook(chapters))
  t('点名之后照收', radar.scanBook(chapters, { people: ['老陈'] }).names.includes('老陈'), JSON.stringify(radar.scanBook(chapters, { people: ['老陈'] }).names))
  // 但点名也要过 looksLikeName：手滑输入一句话不该变成一个人。
  t('点名不是名字的不收', !radar.scanBook(chapters, { people: ['这是一句话'] }).names.includes('这是一句话'))
}

console.log('\n=== 9. 报告 ===')
{
  const md = radar.renderReport('雾港', [
    { title: '阿昭的年龄倒回去了', left: { chapter: 3, sentence: '阿昭二十岁。' }, right: { chapter: 9, sentence: '阿昭十七岁。' } },
  ], { chapters: 12, chars: 30000 })
  t('报告有书名', md.includes('《雾港》'))
  t('报告说了扫了多少', md.includes('12 章'))
  t('报告列了两处原句', md.includes('阿昭二十岁') && md.includes('阿昭十七岁'))
  t('报告带章号', md.includes('第 3 章') && md.includes('第 9 章'))
  const empty = radar.renderReport('雾港', [], { chapters: 5, chars: 100 })
  t('没矛盾时说清「没找到」', empty.includes('没找到能坐实的矛盾'), empty)
  // 这一句很重要：不能让用户以为「0 处矛盾」等于「书没毛病」。
  t('没矛盾时也说清它的边界', empty.includes('说服不了人的地方'), empty)
}

console.log('\n=== 10. 真实中文文本零误报 ===')
{
  // 拿本机几份几万字的中文文档当「一本没有矛盾的书」。
  // 这个功能上线前，最怕的就是打开一本正常的书、刷出一屏假警报。
  const { readFileSync } = await import('node:fs')
  const files = [
    '/Users/joyfon620/Documents/knowledge base/02 领域/技术/本机环境坑.md',
    '/Users/joyfon620/Documents/knowledge base/02 领域/技术/DSH 插件配置与注入.md',
  ]
  let checked = 0
  for (const f of files) {
    let text = ''
    try { text = readFileSync(f, 'utf8') } catch { continue }
    checked += 1
    const paras = text.split(/\n\s*\n/).filter((x) => x.trim() !== '')
    const h = holes(paras)
    t(`${f.split('/').pop()} 零矛盾`, h.length === 0, JSON.stringify(h.map((x) => x.title)))
  }
  t('至少验到了一份真实文本', checked > 0, String(checked))
}

console.log('\n=== 11. 大文本不吃 CPU ===')
{
  // 三十万字扫一遍要在人能等的范围内。规则是纯字符串匹配，
  // 慢说明某条正则回溯爆了——那种问题只在长文本上才出现。
  const chapter = '阿昭今年十七岁，眼睛是灰色的。李四说道：「走罢。」窗外忽然下起雪，众人都不说话。'
  const chapters = []
  for (let i = 0; i < 400; i += 1) chapters.push({ index: i + 1, body: chapter.repeat(20) })
  const chars = chapters.reduce((n, c) => n + c.body.length, 0)
  const started = Date.now()
  radar.findHoles(radar.scanBook(chapters))
  const ms = Date.now() - started
  t(`约 ${Math.round(chars / 10000)} 万字扫完不超过 5 秒`, ms < 5000, `${ms}ms`)
}

// all.mjs 靠 `N passed, N failed` 这一行统计总数，格式要和别的测试一致。
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
