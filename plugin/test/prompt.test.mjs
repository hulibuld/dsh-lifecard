// 提示词层的硬约束：材料截断必须告知、短材料不能被误伤。
import { readFileSync } from 'node:fs'
import * as P from '../lib/prompts.js'

let pass = 0, fail = 0
const t = (n, c, x) => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, x === undefined ? '' : String(x).slice(0, 200)) } }

const base = { aboutId: 'x', aboutName: '甲', schemaHint: '- name' }

// 1. 短材料：原样进入，不报截断
{
  const p = P.buildAnalyzePrompt({ ...base, materials: { 'a.md': '甲说他当了二十年厨师。' } })
  t('短材料完整出现', p.includes('甲说他当了二十年厨师'))
  t('短材料不报截断', !p.includes('材料被截断'))
  t('有材料边界标记', p.includes('<<<MATERIAL name="a.md">>>') && p.includes('<<<END MATERIAL>>>'))
}

// 2. 超长材料：截断 + 明确告知
{
  const p = P.buildAnalyzePrompt({ ...base, materials: { 'long.md': '乙'.repeat(50000) } })
  t('超长材料被截断', p.length < 40000, p.length)
  t('告知截断', p.includes('材料被截断'))
  t('列出被截断的文件', p.includes('long.md'))
  t('明确禁止据未见内容断言', p.includes('不要根据没看到的内容做任何断言'))
}

// 3. 多文件：每个都有预算，不会一个吃掉全部
{
  const p = P.buildAnalyzePrompt({ ...base, materials: { 'a.md': '甲'.repeat(20000), 'b.md': '乙'.repeat(20000) } })
  t('两个文件都出现', p.includes('name="a.md"') && p.includes('name="b.md"'))
  t('两个都被标为截断', (p.match(/以下省略/g) ?? []).length === 2, (p.match(/以下省略/g) ?? []).length)
}

// 4. 提示词里有三条硬规则与「不可信输入」
{
  const p = P.buildAnalyzePrompt({ ...base, materials: { 'a.md': 'x' } })
  t('有逐字引文要求', p.includes('逐字'))
  t('有不可信输入声明', p.includes('不可信输入'))
  t('有来源等级枚举', p.includes('自述') && p.includes('推测'))
  t('要求只输出 JSON', p.includes('只输出 JSON'))
}

// 5. 问题库：每类都有题，且每题都能填字段
{
  for (const rel of P.RELATION_TYPES) {
    const { questions, exact } = P.questionsFor(rel.id)
    t(`${rel.label} 有题且精确命中`, exact && questions.length >= 5, `${questions.length} 题`)
    t(`${rel.label} 每题有 fills`, questions.every((q) => Array.isArray(q.fills) && q.fills.length > 0))
    t(`${rel.label} 每题有 why`, questions.every((q) => typeof q.why === 'string' && q.why.length > 4))
  }
}

// 6. 有选项的题必须有「都不像」这一项（问卷 vs 访谈的分界线）
{
  let checked = 0
  for (const rel of P.RELATION_TYPES) {
    for (const q of P.questionsFor(rel.id).questions) {
      if (!Array.isArray(q.options) || q.options.length === 0) continue
      checked += 1
      // 「开口」不一定要写「都不像」：说不上来 / 不记得了 / 想不出来 / 看心情 /
      // 不争 / 不想想这个 —— 这些都是同一个功能：不让用户被迫在错的选项里挑。
      const OPEN = /都不像|都不是|我自己说|我自己讲|说不清|说不上来|不知道|不记得|想不起|想不出来|想不清楚|没想清楚|还没|不想说|不想想|看心情|看情况|看是谁|什么都不|不出|没有了|不联系|不争|不会|大概会|已经不是|没有|/
      const hasOpen = q.options.some((o) => OPEN.test(o))
      t(`${q.id} 留了开口`, hasOpen, q.options)
    }
  }
  t('确实检查到带选项的题', checked > 20, checked)
}

// 9. 「想要什么样的人」只能影响取舍与提问，绝不能变成事实来源
{
  const material = { 'a.md': '她十六岁进厂，干了三十七年。' }

  // 没写概念时也要有这一段，且明确说「按材料本身的分量来」
  const none = P.buildAnalyzePrompt({ ...base, materials: material })
  t('没写概念时也有这一段', none.includes('我想要的这个人'))
  t('没写时说明按材料来', none.includes('没写'))

  const withConcept = P.buildAnalyzePrompt({
    ...base,
    materials: material,
    concept: { idea: '一个嘴上凶、心里软的老太太', want: ['手很巧'], avoid: ['苦情戏'] },
  })
  t('想法进了提示词', withConcept.includes('一个嘴上凶、心里软的老太太'))
  t('想突出的进了提示词', withConcept.includes('手很巧'))
  t('不想要的进了提示词', withConcept.includes('苦情戏'))

  // 最关键的一条：提示词里必须明确写「这不是事实来源」，
  // 否则模型会顺着期待编一条没有出处的断言，引文闸门拦得住但浪费一次调用。
  t('明确说了不是事实来源', withConcept.includes('不是事实来源'))
  t('说了没写的不能进 items', withConcept.includes('不能写进 items'))
  t('说了该去 questions', withConcept.includes('questions'))

  // 概念不能挤掉真正的规则
  t('三条硬规则还在', withConcept.includes('每条都必须带逐字引文') && withConcept.includes('不许推断') && withConcept.includes('不许总结成评价'))
  t('材料仍然完整出现', withConcept.includes('她十六岁进厂，干了三十七年'))

  // 只写想法、不写列表时也不能崩
  const partial = P.buildAnalyzePrompt({ ...base, materials: material, concept: { idea: '只写了个想法' } })
  t('只有想法时不出现空列表标题', !partial.includes('想突出的：、') && !partial.includes('不想要的：、'))
  t('只有想法时想法在', partial.includes('只写了个想法'))

  // concept 是空对象 = 等同于没写
  const empty = P.buildAnalyzePrompt({ ...base, materials: material, concept: {} })
  t('空概念走「没写」分支', empty.includes('没写'))
  t('空概念不出现杜撰的标题', !empty.includes('一句话概括：'))
}

// 10. 关系选项必须是「他是我的什么人」的视角，不是从关系类别出发的第三人称
//     用户原话：「父母」关系是什么鬼？肯定是父子关系嘛。但是父子关系也不够好，
//     要是女生呢？所以直接选：他是我的什么人？父亲、母亲、好友、爷爷、奶奶、情侣。
{
  const labels = P.RELATION_TYPES.map((r) => r.label)
  // 绝对不能出现这两个：它们是分类名，不是一个人
  t('没有「父母」这个选项', !labels.includes('父母'), labels.join(' / '))
  t('没有「祖辈」这个选项', !labels.includes('祖辈'), labels.join(' / '))
  t('没有「兄弟姐妹」以外含糊的辈分词', !labels.includes('长辈'), labels.join(' / '))

  // 用户点名要的六个必须都在
  for (const want of ['父亲', '母亲', '朋友', '爷爷', '奶奶', '伴侣']) {
    t(`有「${want}」这一项`, labels.includes(want), labels.join(' / '))
  }
  t('有「自己填」兜底', labels.includes('自己填'))

  // 父亲和母亲必须是两项，不能合成一项：用户明确说「父子不够好，要是女生呢」
  t('父亲母亲分成两项', labels.indexOf('父亲') !== labels.indexOf('母亲'))
  t('父亲在母亲前面', labels.indexOf('父亲') < labels.indexOf('母亲'))

  // id 要稳定（账本靠它续接），得是英文小写
  t('每个 id 都是小写英文', P.RELATION_TYPES.every((r) => /^[a-z][a-z0-9]*$/.test(r.id)), P.RELATION_TYPES.map((r) => r.id).join(','))

  // 每项都要有 bank，且 bank 必须真在题库里（否则会静默退回 parent）
  const banks = new Set(P.RELATION_TYPES.map((r) => r.bank))
  t('每项都指定了题库', P.RELATION_TYPES.every((r) => typeof r.bank === 'string' && r.bank !== ''))
  for (const b of banks) {
    t(`题库 ${b} 真的有题`, P.questionsFor(b).exact, b)
  }

  // 同类共享题库：父亲母亲问一样的题
  t('父亲和母亲共用一套题', P.RELATION_TYPES.find((r) => r.id === 'father').bank === P.RELATION_TYPES.find((r) => r.id === 'mother').bank)
  t('爷爷和奶奶共用一套题', P.RELATION_TYPES.find((r) => r.id === 'grandpa').bank === P.RELATION_TYPES.find((r) => r.id === 'grandma').bank)

  // 「自己填」不能没有题库可用
  t('自己填也有一套题', P.questionsFor('custom').questions.length >= 5)

  // hint 要是「你能想起来的具体事」，不能是「他是什么样的人」这种空话
  // hint 要指向「你能想起来的具体事」，不能是「他是什么样的人」这种空话。
  // 怎么判：不许出现纯抽象的评语词。
  // 一开始我写的是「必须含 具体/场景/事/话/手艺/时刻/地方」，结果
  // 「他负责什么、一天怎么过、他抱怨什么」被误判——它很具体，只是没用那几个字。
  // 断言比文案苛刻的时候，改断言，别去改文案凑字。
  const VAGUE = /\u6027\u683c|\u4eba\u54c1|\u4e3a\u4eba|\u7279\u70b9|\u4f18\u70b9|\u7f3a\u70b9|\u5f62\u8c61/
  const vague = P.RELATION_TYPES.filter((r) => VAGUE.test(r.hint) || r.hint.length < 8)
  t('每项 hint 都不说空话', vague.length === 0, vague.map((r) => r.label + ':' + r.hint).join(' | '))
  // 「自己填」不算关系类型，它是个兜底出口，不需要给抓手。
  const kinds = P.RELATION_TYPES.filter((r) => r.id !== 'custom')
  t('每种关系都给了不止一个抓手', kinds.every((r) => r.hint.includes('\u3001')), kinds.filter((r) => !r.hint.includes('\u3001')).map((r) => r.label).join(' / '))
}

// 11. 一个人可以同时是几种身份：补充那一栏要有，且不和主关系混在一起
{
  t('有补充身份的候选词', Array.isArray(P.RELATION_EXTRAS) && P.RELATION_EXTRAS.length >= 4, String(P.RELATION_EXTRAS?.length))
  // 用户举的例子：好友也可以是情侣，家人也可以是伴侣
  t('补充里能写「也是伴侣」', P.RELATION_EXTRAS.some((x) => x.includes('伴侣')), P.RELATION_EXTRAS.join(' / '))
  t('补充里能写「也是家人」', P.RELATION_EXTRAS.some((x) => x.includes('家人')), P.RELATION_EXTRAS.join(' / '))
  t('补充里能写「也是好友」', P.RELATION_EXTRAS.some((x) => x.includes('好友')), P.RELATION_EXTRAS.join(' / '))
  // 补充词不能说成主关系：主关系是那一个人，补充是「还有这一层」
  t('补充词都带「也是」前缀', P.RELATION_EXTRAS.every((x) => x.startsWith('也是')), P.RELATION_EXTRAS.join(' / '))
}

// 12. 浏览器侧那份兜底列表必须和宿主这份对得上
//     （两边各写一份是不得已：浏览器拿不到 node 模块。所以要有测试盯着）
{
  const clientSrc = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const block = clientSrc.slice(clientSrc.indexOf('const RELATION_FALLBACK = ['), clientSrc.indexOf('// 一个人常常不止一种身份'))
  t('浏览器侧有兜底列表', block.length > 100)
  const fbLabels = [...block.matchAll(/label: '([^']+)'/g)].map((m) => m[1])
  const hostLabels = P.RELATION_TYPES.map((r) => r.label).filter((l) => l !== '自己填')
  t('兜底列表顺序和宿主一致', JSON.stringify(fbLabels) === JSON.stringify(hostLabels),
    `浏览器：${fbLabels.join('/')} 宿主：${hostLabels.join('/')}`)
  // 补充词那份也要对得上
  // 切片终点停在「访谈第一屏只摆四个最常用的词」那段注释上：再往后的
  // RELATION_QUICK 是四个快捷词的副本，不是补充词，别把它算进来。
  const exBlock = clientSrc.slice(clientSrc.indexOf('const RELATION_EXTRAS = ['), clientSrc.indexOf('// 访谈第一屏只摆四个最常用的词'))
  const exClient = [...exBlock.matchAll(/'([^']+)'/g)].map((m) => m[1])
  t('补充词两边一致', JSON.stringify(exClient) === JSON.stringify(P.RELATION_EXTRAS),
    `浏览器：${exClient.join('/')} 宿主：${P.RELATION_EXTRAS.join('/')}`)

  // 第一屏那四个快捷词也有一份副本，同样要盯着。
  // 它只放四个：再多就成一排按钮墙了（用户原话「太长了看着，这么一长串的按键选项」）。
  const qBlock = clientSrc.slice(clientSrc.indexOf('const RELATION_QUICK = ['), clientSrc.indexOf('const SECTIONS_MAIN'))
  const quickLabels = [...qBlock.matchAll(/label: '([^']+)'/g)].map((m) => m[1])
  t('第一屏只摆四个词', quickLabels.length === 4, quickLabels.join(' / '))
  t('四个词是父亲母亲朋友伴侣',
    JSON.stringify(quickLabels) === JSON.stringify(['父亲', '母亲', '朋友', '伴侣']), quickLabels.join(' / '))
  // 这四个必须都是宿主真有的关系：点下去要真能改问题库
  const hostAll = P.RELATION_TYPES.map((r) => r.label)
  const missing = quickLabels.filter((l) => !hostAll.includes(l))
  t('四个词宿主侧都有', missing.length === 0, missing.join(' / '))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
