/**
 * choices.js 的测试。
 *
 * 这一层只有一个真问题：**别把正文当选项剪掉**。
 * 小说正文里「1. 他推开门」遍地都是，剪错一次就是整段丢字。
 * 所以下面的用例一半在验「认得出」，一半在验「认不出时一个字不少」。
 */

import * as choices from '../lib/choices.js'

let pass = 0
let fail = 0
const t = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name}${detail === '' ? '' : `  ← ${detail}`}`) }
}

const texts = (arr) => arr.map((c) => c.text).join('|')

console.log('\n=== 1. 标准【选】标记 + 「- 」列表 ===')
{
  const src = '雨还在下。\n\n门口站着一个人，没打伞。\n\n【选】\n- 把伞递过去\n- 转身走\n- 站着不动'
  const r = choices.parseChoices(src)
  t('认出 3 条', r.choices.length === 3, String(r.choices.length))
  t('tagged 为真', r.tagged === true)
  t('正文在标记之前收住', r.body === '雨还在下。\n\n门口站着一个人，没打伞。', JSON.stringify(r.body))
  t('三条文本按序', texts(r.choices) === '把伞递过去|转身走|站着不动', texts(r.choices))
  t('标记行不进正文', !r.body.includes(choices.CHOICE_MARK))
}

console.log('\n=== 2. 无标记的「1. 2. 3.」结尾列表 ===')
{
  const src = '雨还在下。\n\n1. 把伞递过去\n2. 转身走\n3. 站着不动'
  const r = choices.parseChoices(src)
  t('认出 3 条', r.choices.length === 3, String(r.choices.length))
  t('tagged 为假', r.tagged === false)
  t('编号进 label', r.choices.map((c) => c.label).join(',') === '1,2,3', r.choices.map((c) => c.label).join(','))
  t('正文只剩前面那句', r.body === '雨还在下。', JSON.stringify(r.body))
}

console.log('\n=== 3. 正文中间的编号列表不能被误认（本模块的命门）===')
{
  const src = '他想起三件事：\n1. 那年冬天\n2. 母亲走的那天\n3. 门锁坏了\n\n他站起来，往门口走。'
  const r = choices.parseChoices(src)
  t('一条都不认', r.choices.length === 0, String(r.choices.length))
  t('body 等于原文去首尾空白', r.body === src.trim(), JSON.stringify(r.body))
  t('后半句还在', r.body.includes('他站起来，往门口走。'))
}

console.log('\n=== 4. 单条编号不算选项 ===')
{
  const src = '他数了数：\n1. 那年冬天'
  const r = choices.parseChoices(src)
  t('单条不认', r.choices.length === 0, String(r.choices.length))
  t('body 保住整段', r.body === src, JSON.stringify(r.body))
}

console.log('\n=== 5. 超过 40 字的编号行不算选项 ===')
{
  const long = `这是一条非常非常长的编号行${'啊'.repeat(36)}`
  const src = `他停了一下。\n1. ${long}\n2. 转身走`
  t('构造的那行长于 40 字', [...long].length > 40, String([...long].length))
  const r = choices.parseChoices(src)
  t('长行带崩整块，不认', r.choices.length === 0, String(r.choices.length))
  t('body 一字不少', r.body === src, JSON.stringify(r.body))
}

console.log('\n=== 6. A. / a) / ①②③ 三种都认 ===')
{
  const upper = choices.parseChoices('雨还在下。\n\nA. 把伞递过去\nB. 转身走\nC. 站着不动')
  t('A. B. C. 认 3 条', upper.choices.length === 3, String(upper.choices.length))
  t('label 是大写字母', upper.choices.map((c) => c.label).join(',') === 'A,B,C', upper.choices.map((c) => c.label).join(','))

  const lower = choices.parseChoices('雨还在下。\n\na) 把伞递过去\nb) 转身走\nc) 站着不动')
  t('a) b) c) 认 3 条', lower.choices.length === 3, String(lower.choices.length))
  t('小写也归一到大写', lower.choices.map((c) => c.label).join(',') === 'A,B,C', lower.choices.map((c) => c.label).join(','))

  const circled = choices.parseChoices('雨还在下。\n\n① 把伞递过去\n② 转身走\n③ 站着不动')
  t('①②③ 认 3 条', circled.choices.length === 3, String(circled.choices.length))
  t('圈码进 label', circled.choices.map((c) => c.label).join('') === '①②③', circled.choices.map((c) => c.label).join(''))
}

console.log('\n=== 7. 【选项】/【接下来】 也当标记 ===')
{
  const a = choices.parseChoices('雨还在下。\n\n【选项】\n1. 把伞递过去\n2. 转身走')
  t('【选项】认 2 条', a.choices.length === 2 && a.tagged === true, `${a.choices.length}/${a.tagged}`)
  t('【选项】的正文对', a.body === '雨还在下。', JSON.stringify(a.body))

  const b = choices.parseChoices('雨还在下。\n\n【接下来】\n- 把伞递过去\n- 转身走')
  t('【接下来】认 2 条', b.choices.length === 2 && b.tagged === true, `${b.choices.length}/${b.tagged}`)

  // 标记后面一行一条的裸行也该认：模型常把「- 」省掉
  const c = choices.parseChoices('雨还在下。\n\n【选】\n把伞递过去\n转身走')
  t('标记后的裸行也认', c.choices.length === 2, String(c.choices.length))
}

console.log('\n=== 8. 括号解释拆出 hint ===')
{
  const r = choices.parseChoices('雨还在下。\n\n【选】\n- 把伞递过去（她会接吗）\n- 转身走\n- 站着不动')
  t('text 不含括号内容', r.choices[0].text === '把伞递过去', r.choices[0].text)
  t('hint 是括号里那句', r.choices[0].hint === '她会接吗', r.choices[0].hint)
  t('没有括号的 hint 为空', r.choices[1].hint === '', JSON.stringify(r.choices[1].hint))
  t('text 里没有全角括号', !r.choices[0].text.includes('（'))

  const half = choices.parseChoices('雨还在下。\n\n【选】\n- 把伞递过去(她会接吗)\n- 转身走')
  t('半角括号也拆', half.choices[0].text === '把伞递过去' && half.choices[0].hint === '她会接吗', JSON.stringify(half.choices[0]))
}

console.log('\n=== 9. 5 条截到 MAX_CHOICES ===')
{
  const src = '雨还在下。\n\n【选】\n- 一\n- 二\n- 三\n- 四\n- 五'
  const r = choices.parseChoices(src)
  t('MAX_CHOICES 是 4', choices.MAX_CHOICES === 4, String(choices.MAX_CHOICES))
  t('截到 4 条', r.choices.length === 4, String(r.choices.length))
  t('留的是前四条', texts(r.choices) === '一|二|三|四', texts(r.choices))

  const noMark = choices.parseChoices('雨还在下。\n\n1. 一\n2. 二\n3. 三\n4. 四\n5. 五')
  t('无标记也截到 4 条', noMark.choices.length === 4, String(noMark.choices.length))
}

console.log('\n=== 10. 认不出时正文一字不差 ===')
{
  const src = '他推开门。\n\n外面的雨比刚才大，屋檐下积了一小片水。\n\n他站了一会儿，又退回去。'
  const r = choices.parseChoices(src)
  t('choices 为空', r.choices.length === 0, String(r.choices.length))
  t('body 严格等于原文', r.body === src, JSON.stringify(r.body))
  t('tagged 为假', r.tagged === false)

  const empty = choices.parseChoices('')
  t('空串不炸', empty.body === '' && empty.choices.length === 0, JSON.stringify(empty.body))
  t('null 不炸', choices.parseChoices(null).choices.length === 0)
}

console.log('\n=== 11. stripChoices 与 parseChoices().body 同口径 ===')
{
  const tagged = '雨还在下。\n\n【选】\n- 把伞递过去\n- 转身走'
  const plain = '雨还在下。\n\n1. 把伞递过去\n2. 转身走'
  const none = '他推开门。\n\n1. 他想起那年冬天\n\n他往门口走。'
  t('有标记场合一致', choices.stripChoices(tagged) === choices.parseChoices(tagged).body, JSON.stringify(choices.stripChoices(tagged)))
  t('无标记场合一致', choices.stripChoices(plain) === choices.parseChoices(plain).body, JSON.stringify(choices.stripChoices(plain)))
  t('认不出场合一致', choices.stripChoices(none) === choices.parseChoices(none).body)
  t('剥完不留【选】', !choices.stripChoices(tagged).includes(choices.CHOICE_MARK))
}

console.log('\n=== 12. hasChoices 正反两例 ===')
{
  t('有选项时为真', choices.hasChoices('雨还在下。\n\n【选】\n- 把伞递过去\n- 转身走') === true)
  t('纯正文时为假', choices.hasChoices('他推开门。\n\n外面的雨比刚才大。') === false)
  t('单条编号时为假', choices.hasChoices('他数了数：\n1. 那年冬天') === false)
}

console.log('\n=== 13. choiceDirective 三种风格 ===')
{
  const story = choices.choiceDirective({ style: 'story' })
  const chat = choices.choiceDirective({ style: 'chat' })
  const diary = choices.choiceDirective({ style: 'diary' })
  t('story 与 chat 不同', story !== chat)
  t('story 与 diary 不同', story !== diary)
  t('chat 与 diary 不同', chat !== diary)
  t('三种都提到【选】', [story, chat, diary].every((s) => s.includes(choices.CHOICE_MARK)))
  t('缺省落在 story', choices.choiceDirective() === story)
  t('未知风格不炸', typeof choices.choiceDirective({ style: 'nope' }) === 'string')
  t('条数下限被夹住', choices.choiceDirective({ count: 1 }).includes('给出 2 个方向'), choices.choiceDirective({ count: 1 }).split('\n')[0])
  t('条数上限被夹住', choices.choiceDirective({ count: 9 }).includes('给出 4 个方向'))
  t('要求里不带 markdown 标题', !/^#/m.test(story))
}

console.log('\n=== 14. 有标记但底下不像选项：一个字都不能丢 ===')
{
  // 模型把标记写岔了、底下只给一条。按「标记之前是正文」剪，会把标记后面那段
  // 正文续写整段扔掉；所以这种情况退回原文。
  const src = '雨还在下。\n\n【选】\n只有一条，而且还挺长的一句放在这里当正文看'
  const r = choices.parseChoices(src)
  t('标了记但只一条 → choices 为空', r.choices.length === 0, String(r.choices.length))
  t('body 仍是完整原文', r.body === src, JSON.stringify(r.body))
  t('tagged 仍如实报告', r.tagged === true)
  t('stripChoices 同口径', choices.stripChoices(src) === src)
}

console.log('\n=== 15. 默认导出齐 ===')
{
  const d = choices.default
  t('默认导出含七个', ['CHOICE_MARK', 'MAX_CHOICES', 'MIN_CHOICES', 'parseChoices', 'choiceDirective', 'stripChoices', 'hasChoices'].every((k) => k in d))
  t('常量对得上', d.CHOICE_MARK === '【选】' && d.MAX_CHOICES === 4 && d.MIN_CHOICES === 2, `${d.CHOICE_MARK}/${d.MAX_CHOICES}/${d.MIN_CHOICES}`)
}

console.log('\n=== 16. 接线用到的两条契约 ===')
{
  // 酒馆和小说各只用一种风格，钉住这两条，免得以后改文案时把接线那边
  // 依赖的字眼改掉（它们是把这段文本塞进提示词里的唯一凭据）。
  const chat = choices.choiceDirective({ style: 'chat', count: 3 })
  t('酒馆那条问的是「怎么接」', chat.includes('这一轮我可以怎么接'), chat.split('\n')[1])
  t('酒馆那条要三条', chat.includes('给出 3 个方向'), chat.split('\n')[0])
  const story = choices.choiceDirective({ style: 'story', count: 3 })
  t('小说那条问的是「往哪走」', story.includes('这一轮往哪走'), story.split('\n')[1])
  t('小说那条也说清了标记写法', story.includes(choices.CHOICE_MARK) && story.includes('用「- 」开头'), story)
  // 落盘时剥块用的也是同一套判据：酒馆只认标记，日记只认标记，
  // 所以「带标记的完整块」必须能被 stripChoices 剥干净。
  const block = `${choices.CHOICE_MARK}\n- 把伞递过去\n- 转身走\n- 站着不动`
  t('带标记的块剥得干净', choices.stripChoices(`雨还在下。\n\n${block}`) === '雨还在下。', JSON.stringify(choices.stripChoices(`雨还在下。\n\n${block}`)))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
