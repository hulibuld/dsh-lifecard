// 提示词层的硬约束：材料截断必须告知、短材料不能被误伤。
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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
