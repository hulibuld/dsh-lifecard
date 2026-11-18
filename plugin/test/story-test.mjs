/**
 * story.js 的测试：剧本格式、旗标与条件、导出、十一个玩法引擎。
 *
 * 这一层全是纯字符串和纯函数，所以测试不碰磁盘也不调模型：给一段字，要一遍
 * 结构回来。真正要盯的是三件事：
 *   1. 存一次读一次，剧本不能变形（不然用户改两回就全是空行）
 *   2. 写坏了要报错但不能抛，也不能因此解析不出节点（写手是边写边存的）
 *   3. 引擎的 judge 只能回 win/lose/''，而且对空状态不许抛（它会挂在每轮末尾）
 */

import * as story from '../lib/story.js'

let pass = 0
let fail = 0
const t = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name}${detail === '' ? '' : `  ← ${detail}`}`) }
}

// ── 一份完整的剧本，后面好几节都拿它当底子 ──────────────────
const FULL = `## 码头
@bg 雨夜的码头
@char 老周 站在货箱旁边
雨下了一夜，货箱上全是水。
[if 好感 >= 3] 老周冲你点了点头。

【选】
- 走过去（他会不会认出我） -> 节点B
- 先躲起来 -> 节点C

## 节点B
他抬头看你，没说话。

【选】
- 说话 -> 结束
- 沉默 -> 节点C

## 节点C
什么都没有，只有雨。
`

console.log('\n=== 1. parseScript：结构 ===')
{
  const r = story.parseScript(FULL)
  t('解析成功', r.ok === true, JSON.stringify(r.errors))
  t('三个节点', r.nodes.length === 3, String(r.nodes.length))
  t('第一个节点是入口', r.nodes[0].name === '码头', r.nodes[0].name)
  t('节点名按顺序', r.nodes.map((n) => n.name).join(',') === '码头,节点B,节点C')
  t('@bg 收进 bg', r.nodes[0].bg === '雨夜的码头', r.nodes[0].bg)
  t('@char 收进 chars', r.nodes[0].chars.length === 1 && r.nodes[0].chars[0] === '老周 站在货箱旁边')
  t('bg 不在正文里', r.nodes[0].lines.every((l) => !l.text.includes('雨夜的码头')))
  t('正文保留原句', r.nodes[0].lines[0].text === '雨下了一夜，货箱上全是水。')
  t('没有条件的行 cond 为空', r.nodes[0].lines[0].cond === '')
  t('条件行拆出 cond', r.nodes[0].lines[1].cond === '好感 >= 3', r.nodes[0].lines[1].cond)
  t('条件行的正文不带 [if]', r.nodes[0].lines[1].text === '老周冲你点了点头。', r.nodes[0].lines[1].text)
  t('选项数对', r.nodes[0].choices.length === 2, String(r.nodes[0].choices.length))
  t('选项文本带括号里的代价', r.nodes[0].choices[0].text === '走过去（他会不会认出我）', r.nodes[0].choices[0].text)
  t('选项目标', r.nodes[0].choices[0].target === '节点B', r.nodes[0].choices[0].target)
  t('没有【选】的节点 choices 为空', r.nodes[2].choices.length === 0)
  t('errors 为空', r.errors.length === 0, JSON.stringify(r.errors))
}

console.log('\n=== 2. parseScript：坏输入不抛错 ===')
{
  const empty = story.parseScript('')
  t('空剧本 ok=false', empty.ok === false)
  t('空剧本 nodes 为空数组', Array.isArray(empty.nodes) && empty.nodes.length === 0)
  t('空剧本那句话对', empty.errors.length === 1 && empty.errors[0].error === '这个剧本是空的。', JSON.stringify(empty.errors))

  const blank = story.parseScript('   \n\n \t \n')
  t('只有空白也算空剧本', blank.ok === false && blank.errors[0].error === '这个剧本是空的。')

  const bad = story.parseScript('## A\n正文\n\n【选】\n- 走 -> 不存在\n\n## B\n正文B\n')
  t('坏跳转 ok=false', bad.ok === false)
  t('坏跳转仍解析出两个节点', bad.nodes.length === 2, String(bad.nodes.length))
  t('坏跳转恰好一条错', bad.errors.length === 1, JSON.stringify(bad.errors))
  t('坏跳转报出目标名', /「不存在」这个节点不存在/.test(bad.errors[0].error), bad.errors[0].error)
  t('坏跳转记了节点名', bad.errors[0].node === 'A', bad.errors[0].node)
  t('坏跳转记了行号', bad.errors[0].line === 5, String(bad.errors[0].line))
  t('坏跳转的正文没丢', bad.nodes[0].lines[0].text === '正文')

  const endOk = story.parseScript('## A\n【选】\n- 走 -> 结束\n- 再来 -> END\n')
  t('-> 结束 不算坏跳转', endOk.ok === true, JSON.stringify(endOk.errors))
  t('-> END 也不报错', endOk.errors.length === 0)

  const onlyHead = story.parseScript('## A\n')
  t('只有节点名也能解析', onlyHead.ok === true && onlyHead.nodes.length === 1)
  t('只有节点名时正文为空', onlyHead.nodes[0].lines.length === 0)

  const noChoice = story.parseScript('## A\n【选】\n')
  t('【选】后面没选项要报错', noChoice.ok === false, JSON.stringify(noChoice.errors))
  t('【选】空段的错误话术', noChoice.errors.some((e) => e.error.includes('没有写任何选项')), JSON.stringify(noChoice.errors))
  t('【选】空段仍然留节点', noChoice.nodes.length === 1)

  const noArrow = story.parseScript('## A\n【选】\n- 走\n')
  t('选项缺 -> 要报错', noArrow.errors.some((e) => e.error.includes('没写「-> 目标节点」')), JSON.stringify(noArrow.errors))

  const noTarget = story.parseScript('## A\n【选】\n- 走 ->\n')
  t('-> 后面空着要报错', noTarget.errors.some((e) => e.error.includes('没写要跳到哪个节点')), JSON.stringify(noTarget.errors))

  const noLabel = story.parseScript('## A\n【选】\n- -> B\n## B\nx\n')
  t('选项没内容要报错', noLabel.errors.some((e) => e.error.includes('没有写内容')), JSON.stringify(noLabel.errors))

  const orphan = story.parseScript('一段没有归属的正文\n## A\n正文\n')
  t('节点外的正文要报错', orphan.errors.some((e) => e.error.includes('没有归属')), JSON.stringify(orphan.errors))
  t('节点外的正文不影响后面的节点', orphan.nodes.length === 1)

  const noName = story.parseScript('## \n正文\n')
  t('节点名空着要报错', noName.errors.some((e) => e.error.includes('没有名字')), JSON.stringify(noName.errors))

  const dup = story.parseScript('## A\n一\n## A\n二\n')
  t('重名节点要报错', dup.errors.some((e) => e.error.includes('有两个节点都叫「A」')), JSON.stringify(dup.errors))
  t('重名节点两个都留着', dup.nodes.length === 2)

  const unknown = story.parseScript('## A\n@foo bar\n正文\n')
  t('不认识的 @ 标记要报错', unknown.errors.some((e) => e.error.includes('不认识的标记')), JSON.stringify(unknown.errors))
  t('不认识的 @ 那行留在正文里', unknown.nodes[0].lines.some((l) => l.text.includes('@foo')))

  const two = story.parseScript('## A\n【选】\n- x -> 结束\n【选】\n- y -> 结束\n')
  t('一个节点两段【选】要报错', two.errors.some((e) => e.error.includes('只能有一段')), JSON.stringify(two.errors))

  const junk = story.parseScript('## A\n【选】\n随便写一行\n- 走 -> 结束\n')
  t('【选】后不是选项要报错', junk.errors.some((e) => e.error.includes('只认')), JSON.stringify(junk.errors))
  t('杂行挡住之后真选项仍收下', junk.nodes[0].choices.length === 1)
}

console.log('\n=== 3. renderScript 往返 ===')
{
  const r = story.parseScript(FULL)
  const back = story.renderScript(r.nodes)
  const again = story.parseScript(back)
  t('往返后 ok', again.ok === true, JSON.stringify(again.errors))
  t('往返后节点数不变', again.nodes.length === r.nodes.length)
  t('往返后结构完全一致', JSON.stringify(again.nodes) === JSON.stringify(r.nodes))
  t('渲染出来有节点头', back.includes('## 码头'))
  t('渲染出来有视觉槽', back.includes('@bg 雨夜的码头') && back.includes('@char 老周 站在货箱旁边'))
  t('渲染出来有条件行', back.includes('[if 好感 >= 3] 老周冲你点了点头。'))
  t('渲染出来有【选】', back.includes('\n【选】\n'))
  t('渲染出来箭头前后有空格', back.includes('- 先躲起来 -> 节点C'))
  t('渲染结果以换行收尾', back.endsWith('\n'))
  t('存两次不会多出空行', story.renderScript(story.parseScript(back).nodes) === back)

  const empty = story.renderScript([])
  t('空数组渲染成空串', empty === '')
  t('非数组渲染成空串', story.renderScript(null) === '')
}

console.log('\n=== 4. 正文里像标记的行要能原样留住 ===')
{
  const tricky = story.parseScript('## A\n\\## 这一行不是节点\n\\@bg 这一行不是视觉槽\n\\【选】这一行不是选项段\n')
  t('反斜杠转义的 ## 不当节点', tricky.nodes.length === 1, String(tricky.nodes.length))
  const texts = tricky.nodes[0].lines.map((l) => l.text)
  t('反斜杠脱掉一层', texts[0] === '## 这一行不是节点', texts[0])
  t('转义的 @ 留在正文', texts[1] === '@bg 这一行不是视觉槽', texts[1])
  t('转义的【选】留在正文', texts[2] === '【选】这一行不是选项段', texts[2])
  const rt = story.parseScript(story.renderScript(tricky.nodes))
  t('这种正文也能往返', JSON.stringify(rt.nodes) === JSON.stringify(tricky.nodes))
}

console.log('\n=== 5. 旗标 ===')
{
  const map = story.parseFlags('好感 = 3\n老周 = "活着"\n线索数 = 5\n见过面 = 否\n不写引号 = 随便')
  t('数值读成数字', map['好感'] === 3, String(map['好感']))
  t('带引号读成文本', map['老周'] === '活着', String(map['老周']))
  t('不带引号也当文本', map['不写引号'] === '随便', String(map['不写引号']))
  t('否定也是文本', map['见过面'] === '否')
  t('负数是负数', story.parseFlags('体力 = -1')['体力'] === -1)

  const rendered = story.renderFlags(map)
  t('数值不加引号', rendered.includes('好感 = 3'), rendered)
  t('文本带引号', rendered.includes('老周 = "活着"'), rendered)
  const rt = story.parseFlags(rendered)
  t('旗标往返一致', JSON.stringify(rt) === JSON.stringify(map), JSON.stringify(rt))

  t('只剩数字时不变成字符串', typeof story.parseFlags(story.renderFlags({ n: 7 }))['n'] === 'number')
  t('布尔渲染成是/否', story.renderFlags({ 见过: true }) === '见过 = 是', story.renderFlags({ 见过: true }))
  t('引号会被转义', story.parseFlags(story.renderFlags({ q: '他说"走"' }))['q'] === '他说"走"')
  t('空 map 渲染成空串', story.renderFlags({}) === '')
  t('注释行跳过', Object.keys(story.parseFlags('# 注释\n好感 = 1')).length === 1)
  t('没等号的行跳过', Object.keys(story.parseFlags('随便一句\n好感 = 1')).length === 1)
  t('空文本解析成空对象', Object.keys(story.parseFlags('')).length === 0)
}

console.log('\n=== 6. evalCond ===')
{
  const flags = story.parseFlags('好感 = 3\n线索数 = 5\n老周 = "活着"\n见过面 = 否')
  t('数值 >= 成立', story.evalCond('好感 >= 3', flags) === true)
  t('数值 >= 不成立', story.evalCond('好感 >= 9', flags) === false)
  t('数值 > 成立', story.evalCond('线索数 > 2', flags) === true)
  t('数值 > 不成立', story.evalCond('线索数 > 5', flags) === false)
  t('数值 < 成立', story.evalCond('线索数 < 9', flags) === true)
  t('数值 == 数字', story.evalCond('好感 == 3', flags) === true)
  t('文本 == 成立', story.evalCond('老周 == 活着', flags) === true)
  t('文本 == 不成立', story.evalCond('老周 == 死了', flags) === false)
  t('文本 != 成立', story.evalCond('老周 != 死了', flags) === true)
  t('! 对「否」成立', story.evalCond('!见过面', flags) === true)
  t('! 对数字成立', story.evalCond('!好感', flags) === false)
  t('! 对没写过的旗标成立', story.evalCond('!没写过的', flags) === true)
  t('空条件是放行', story.evalCond('', flags) === true)
  t('看不懂也放行', story.evalCond('??', flags) === true)
  t('看不懂留了原因', story.lastCondError() !== null)
  t('原因里带原条件', story.lastCondError().cond === '??', JSON.stringify(story.lastCondError()))
  t('原因形状和 store 一致', typeof story.lastCondError().error === 'string')
  story.evalCond('好感 >= 1', flags)
  t('下一次判断成功就清空', story.lastCondError() === null)
  t('文本比大小放行并留原因', story.evalCond('老周 > 3', flags) === true && story.lastCondError() !== null)
  t('两边的数不相等就 false', story.evalCond('好感 = 4', flags) === false)
  t('单个 = 也当相等', story.evalCond('好感 = 3', flags) === true)
}

console.log('\n=== 7. toInk ===')
{
  const r = story.parseScript(FULL)
  const ink = story.toInk(r.nodes, { title: '码头' })
  t('有节点头', ink.includes('=== 码头 ==='), ink.slice(0, 200))
  t('有第二个节点头', ink.includes('=== 节点B ==='))
  t('选项是 * [', ink.includes('* [先躲起来] -> 节点C'), ink)
  t('中文括号的选项不坏', ink.includes('* [走过去（他会不会认出我）] -> 节点B'), ink)
  t('结局面渲染成 END', ink.includes('* [说话] -> END'), ink)
  t('末尾有 -> END', ink.trimEnd().endsWith('-> END'), ink.slice(-40))
  t('条件行变织体', ink.includes('{好感 >= 3: 老周冲你点了点头。}'), ink)
  t('正文原样', ink.includes('雨下了一夜，货箱上全是水。'))
  t('背景写进注释', ink.includes('// 背景：雨夜的码头'))
  t('在场写进注释', ink.includes('// 在场：老周 站在货箱旁边'))
  t('注释说明单向导出', ink.includes('单向导出'))
  t('注释说明不保证全覆盖', ink.includes('不保证 ink 编译器的语法全覆盖'))
  t('书名进注释', ink.includes('《码头》'))
  t('空数组不炸', typeof story.toInk([], {}) === 'string')
  t('空数组也有 -> END', story.toInk([], {}).includes('-> END'))
}

console.log('\n=== 8. toCyoaHtml ===')
{
  const r = story.parseScript(FULL)
  const html = story.toCyoaHtml('码头', r.nodes)
  t('是完整 HTML', html.startsWith('<!doctype html>'), html.slice(0, 20))
  t('有 html 收尾', html.trimEnd().endsWith('</html>'))
  t('有 charset', html.includes('<meta charset="utf-8">'))
  t('标题进来了', html.includes('<title>码头</title>'))
  t('没有外链 http', html.includes('http://') === false)
  t('没有外链 https', html.includes('https://') === false)
  t('没有外部 script src', html.includes('<script src') === false)
  t('没有外部样式表', html.includes('rel="stylesheet"') === false)
  t('正文进来了', html.includes('雨下了一夜，货箱上全是水。'))
  t('选项进来了', html.includes('先躲起来'))
  t('节点名成 data-node', html.includes('data-node="码头"'))
  t('条件成 data-cond', html.includes('data-cond="好感 &gt;= 3"'), html.match(/data-cond="[^"]*"/)?.[0])

  const nasty = story.parseScript('## A\n<b>"引号" & \'单引号\'</b>\n').nodes
  const escaped = story.toCyoaHtml('T', nasty)
  t('尖括号被转义', escaped.includes('&lt;b&gt;'), 'should not contain raw <b> in body')
  t('引号被转义', escaped.includes('&quot;'))
  t('与号被转义', escaped.includes('&amp;'))
  t('原始标签没有漏出去', escaped.includes('<b>"引号"') === false)
  t('空剧本也能出页面', story.toCyoaHtml('T', []).includes('<!doctype html>'))
  t('没标题时给个默认名', story.toCyoaHtml('', []).includes('<title>一个故事</title>'))
}

console.log('\n=== 9. 十一个引擎的形状 ===')
{
  const ids = ['detect', 'survive', 'growth', 'relation', 'explore', 'deduce', 'negotiate', 'manage', 'faction', 'island', 'loop']
  t('十一个引擎', story.ENGINES.length === 11, String(story.ENGINES.length))
  t('id 顺序对', story.ENGINES.map((e) => e.id).join(',') === ids.join(','), story.ENGINES.map((e) => e.id).join(','))
  for (const eng of story.ENGINES) {
    t(`${eng.id} 有 id`, typeof eng.id === 'string' && eng.id !== '')
    t(`${eng.id} 有中文名`, typeof eng.name === 'string' && eng.name.trim() !== '')
    t(`${eng.id} 有 desc`, typeof eng.desc === 'string' && eng.desc.trim() !== '')
    t(`${eng.id} fields 是数组且有内容`, Array.isArray(eng.fields) && eng.fields.length > 0)
    t(`${eng.id} 每个 field 有 key 和 hint`, eng.fields.every((f) => typeof f.key === 'string' && f.key !== '' && typeof f.hint === 'string' && f.hint !== ''))
    t(`${eng.id} rules 至少四条`, Array.isArray(eng.rules) && eng.rules.length >= 4, String(eng.rules?.length))
    t(`${eng.id} judge 是函数`, typeof eng.judge === 'function')
    t(`${eng.id} 空状态不抛`, (() => { try { eng.judge({}); return true } catch { return false } })())
    t(`${eng.id} 空状态回空串`, eng.judge({}) === '')
    t(`${eng.id} 没写空话`, eng.rules.every((r) => !/要生动|有画面感|命运的齿轮|作为 AI/.test(r)))
  }
  t('前五个对上内置预设', story.ENGINES.slice(0, 5).map((e) => e.presetId).join(',') === 'game-detect,game-survive,game-growth,game-relation,game-explore')
  t('后六个没有预设', story.ENGINES.slice(5).every((e) => e.presetId === ''))
  t('按 id 能找到', story.findEngine('detect').name === '查一件事')
  t('按预设 id 也能找到', story.findEngine('game-detect').id === 'detect')
  t('找不到回 null', story.findEngine('没有这个') === null)
  t('空 id 回 null', story.findEngine('') === null)
}

console.log('\n=== 10. judgeEnding：能判输赢的九个 ===')
{
  const j = (id, state) => story.judgeEnding(story.findEngine(id), state)

  const dWin = j('detect', { 指认: '老周', 真凶: '老周' })
  t('detect 指对了赢', dWin.ending === 'win', JSON.stringify(dWin))
  const dLose = j('detect', { 指认: '小李', 真凶: '老周' })
  t('detect 指错了输', dLose.ending === 'lose')
  t('detect 没揭底不判', j('detect', { 指认: '老周' }).ending === '', JSON.stringify(j('detect', { 指认: '老周' })))
  t('detect 没指认不判', j('detect', { 真凶: '老周' }).ending === '')

  t('survive 体力归零输', j('survive', { 体力: '0' }).ending === 'lose')
  t('survive 时间归零输', j('survive', { 时间: 0 }).ending === 'lose')
  t('survive 物资归零输', j('survive', { 物资: '0' }).ending === 'lose')
  t('survive 撑够天数赢', j('survive', { 撑到第几天: '30' }).ending === 'win')
  t('survive 中间不判', j('survive', { 体力: '4', 时间: '5' }).ending === '')

  t('relation 跌破阈值输', j('relation', { 关系: '老周 -4' }).ending === 'lose')
  t('relation 到 8 赢', j('relation', { 关系: '老周 8' }).ending === 'win')
  t('relation 中间不判', j('relation', { 关系: '老周 2' }).ending === '')
  t('relation 多个人里有一个崩了就输', j('relation', { 关系: '甲 3；乙 -5' }).ending === 'lose')

  t('deduce 指对了赢', j('deduce', { 指认: '对：我一直在屋里' }).ending === 'win')
  t('deduce 追问用完没指认输', j('deduce', { 追问: '0' }).ending === 'lose')
  t('deduce 指错了还有追问就不判', j('deduce', { 指认: '错：我没出门', 追问: '1' }).ending === '')
  t('deduce 指错且问完输', j('deduce', { 指认: '错：我没出门', 追问: '0' }).ending === 'lose')

  t('negotiate 谈成赢', j('negotiate', { 谈成: '是' }).ending === 'win')
  t('negotiate 筹码烧完输', j('negotiate', { 筹码: '0' }).ending === 'lose')
  t('negotiate 还有筹码不判', j('negotiate', { 筹码: '2' }).ending === '')

  t('manage 连亏三期输', j('manage', { 连着几期亏: '3' }).ending === 'lose')
  t('manage 现钱够还清赢', j('manage', { 现钱: '12', 欠账: '0' }).ending === 'win')
  t('manage 还欠着不算赢', j('manage', { 现钱: '12', 欠账: '3' }).ending === '')
  t('manage 亏两期不判', j('manage', { 连着几期亏: '2' }).ending === '')

  t('faction 全都敌对输', j('faction', { 声望: '甲 -5；乙 -6' }).ending === 'lose')
  t('faction 有人撑腰赢', j('faction', { 声望: '甲 6；乙 -2', 盟友: '老周' }).ending === 'win')
  t('faction 有声望没盟友不判', j('faction', { 声望: '甲 6；乙 -2' }).ending === '')

  t('island 一个不剩输', j('island', { 还活着的人: '无' }).ending === 'lose')
  t('island 撑到天数且有人赢', j('island', { 还活着的人: '甲；乙', 天数: '21' }).ending === 'win')
  t('island 人不够不判', j('island', { 还活着的人: '甲', 天数: '21' }).ending === '')

  t('loop 达成了赢', j('loop', { 达成: '是' }).ending === 'win')
  t('loop 没达成不判', j('loop', { 达成: '' }).ending === '')

  t('growth 不判输赢', j('growth', { 手艺: '钉掌' }).ending === '')
  t('explore 不判输赢', j('explore', { 去过的地方: '码头' }).ending === '')

  // 存档里的状态是一串「名目：内容」，judgeEnding 要能认这种形状。
  t('认存档那种字符串数组', j('detect', ['线索：账本', '指认：老周', '真凶：老周']).ending === 'win')
  t('认「名目: 内容」半角冒号', story.judgeEnding(story.findEngine('loop'), ['达成: 是']).ending === 'win')

  // 用户以后能自己注册引擎；他写的 judge 抛错不能把游戏卡死。
  const evil = { id: 'x', name: 'x', desc: 'x', presetId: '', fields: [], rules: ['a', 'b', 'c', 'd'], judge() { throw new TypeError('boom') } }
  const caught = story.judgeEnding(evil, {})
  t('judge 抛错也不抛出来', caught.ending === '', JSON.stringify(caught))
  t('judge 抛错留下原因', caught.reason.includes('boom'), caught.reason)
  t('没有引擎不判', story.judgeEnding(null, {}).ending === '')
  t('judge 不是函数不判', story.judgeEnding({ judge: 5 }, {}).ending === '')
  t('judge 乱回也不当结局', story.judgeEnding({ judge: () => 'maybe' }, {}).ending === '')
}

console.log('\n=== 11. buildEngineSystem ===')
{
  const eng = story.findEngine('detect')
  const sys = story.buildEngineSystem({
    engine: eng,
    bookTitle: '旧账',
    scene: '雨夜的码头',
    status: ['体力：还行'],
    holding: ['一把伞'],
    preset: '这一局要查清账本少的那一页。',
    role: '账房先生',
    flags: '好感 = 3\n老周 = 活着',
  })
  t('含引擎名', sys.includes('查一件事'), sys.slice(0, 120))
  t('含引擎 desc', sys.includes('找线索、拼线索，最后指认'))
  t('含书名', sys.includes('《旧账》'))
  t('含【你是谁】', sys.includes('【你是谁】'))
  t('含【每一轮你要做什么】', sys.includes('【每一轮你要做什么】'))
  t('含【每一轮最后再报一次状态】', sys.includes('【每一轮最后再报一次状态】'))
  t('含【绝对不做】', sys.includes('【绝对不做】'))
  t('含【这一局的玩法】', sys.includes('【这一局的玩法】'))
  t('含【已经定下来的事】', sys.includes('【已经定下来的事】'))
  t('含【玩家操控的是谁】', sys.includes('【玩家操控的是谁】'))
  t('含【现在】', sys.includes('【现在】'))
  t('含【这一局的额外要求】', sys.includes('【这一局的额外要求】'))
  t('含场景', sys.includes('雨夜的码头'))
  t('含角色', sys.includes('账房先生'))
  t('含手上的东西', sys.includes('一把伞'))
  t('旗标渲染成一行一条', sys.includes('- 好感：3') && sys.includes('- 老周：活着'), sys.match(/- 好感[^\n]*/)?.[0])
  for (const f of eng.fields) {
    t(`状态段含 ${f.key} 的 hint`, sys.includes(f.hint), f.hint)
  }
  t('状态段按 fields 报，不是固定的那四个', sys.includes('谁还信我') === false)
  t('规则全部进来了', eng.rules.every((r) => sys.includes(r)))
  // 「绝对不做」那五条本身就是把这些词写出来禁止的，所以不能断言全文没有这两句；
  // 要断言的是：它们只出现在禁令段里，没被当成写作示范漏到前面去。
  const banAt = sys.indexOf('【绝对不做】')
  t('「命运的齿轮」只出现在禁令段', sys.indexOf('命运的齿轮') > banAt, String(sys.indexOf('命运的齿轮')))
  t('「作为 AI」只出现在禁令段', sys.indexOf('（作为 AI）') > banAt, String(sys.indexOf('（作为 AI）')))

  const bare = story.buildEngineSystem({ engine: null, bookTitle: '', scene: '', status: [], holding: [], preset: '', role: '', flags: '' })
  t('没有引擎也给得出提示词', bare.includes('【你是谁】'))
  t('没有引擎用默认四个状态名目', bare.includes('在哪') && bare.includes('身上') && bare.includes('心里'))
  t('没有引擎就没有玩法段', bare.includes('【这一局的玩法】') === false)
  t('没有旗标就没有那一段', bare.includes('【已经定下来的事】') === false)
  t('没书名给个默认名', bare.includes('《未命名》'))

  const grow = story.buildEngineSystem({ engine: story.findEngine('growth'), bookTitle: 'x', scene: '', status: [], holding: [], preset: '', role: '', flags: {} })
  t('换引擎就换状态名目', grow.includes('手艺'))
  t('换引擎不报别人的字段', grow.includes('指认') === false)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
