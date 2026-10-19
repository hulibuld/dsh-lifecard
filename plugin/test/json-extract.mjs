// 模型输出不总是纯 JSON。这个测试锁住 extractJson 的容错边界。
import { extractJson } from '../lib/index.js'

let pass = 0, fail = 0
const t = (n, c, x) => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, x === undefined ? '' : String(x).slice(0, 200)) } }

const cases = [
  ['纯 JSON', '{"a":1}', true],
  ['带 json 围栏', '好的：\n```json\n{"a":1}\n```\n以上', true],
  ['带无标记围栏', '```\n{"a":1}\n```', true],
  ['前后有解释', '分析如下 {"a":1} 以上是我的判断', true],
  ['截断在对象中间', '{"items":[{"field":"x","value":1},{"field":"y"', true],
  ['截断在字符串中间', '{"items":[{"field":"x","value":"木', true],
  ['空字符串', '', false],
  ['纯文字', '我不知道该怎么分析这个材料。', false],
  ['坏 JSON', '{"a": }', false],
]

for (const [name, input, shouldParse] of cases) {
  const r = extractJson(input)
  const parsed = r !== undefined
  t(name, parsed === shouldParse, parsed ? JSON.stringify(r) : 'undefined')
}

// 截断修复要保住已完整的部分
{
  const r = extractJson('{"items":[{"field":"x","value":1},{"field":"y"')
  t('截断修复保住第一条', r?.items?.[0]?.field === 'x', r)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
