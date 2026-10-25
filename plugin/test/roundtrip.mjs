import * as C from '../lib/core.js'

const cases = [
  { name: '空卡', data: { lifecard: '0.1', id: 'x', kind: 'real', name: '甲', world: 'reality' }, sections: [] },
  { name: '含冒号', data: { lifecard: '0.1', id: 'a', kind: 'real', name: '甲', world: 'reality', note: '注意: 这里' }, sections: [{ title: '自述', body: '他喜欢足球: 每天都看' }] },
  { name: '含井号', data: { lifecard: '0.1', id: 'a', kind: 'real', name: '甲', world: 'reality', tags: ['a #b', 'c'] }, sections: [] },
  { name: '多行', data: { lifecard: '0.1', id: 'a', kind: 'real', name: '甲', world: 'reality', bio: '第一行\n第二行' }, sections: [] },
  { name: '数字与布尔', data: { lifecard: '0.1', id: 'a', kind: 'real', name: '甲', world: 'reality', birth_year: 1958, active: true, ratio: 0.75, zero: 0 }, sections: [] },
  { name: '空数组空map', data: { lifecard: '0.1', id: 'a', kind: 'real', name: '甲', world: 'reality', tags: [], meta: {} }, sections: [] },
  { name: '深层嵌套', data: { lifecard: '0.1', id: 'a', kind: 'relation', from: 'a', to: 'b', structure: { type: 'parent', since: '2000-01-01', address: { them_to_me: ['小四'], me_to_them: ['妈'] } }, affect: [{ at: '2026-10-17', affinity: 4, note: '先否定再帮忙' }] }, sections: [{ title: '关系史', body: '2026-09 我到外地（她想让我读本地学校）' }] },
  { name: '引号内容', data: { lifecard: '0.1', id: 'a', kind: 'real', name: '甲', world: 'reality', quote: '他说"记吧，别忘了"' }, sections: [] },
  { name: '中文与特殊字符', data: { lifecard: '0.1', id: 'a', kind: 'real', name: '爷爷', world: 'reality', tags: ['家人', '手艺'], label: '〔自述〕测试' }, sections: [{ title: '不会说的话', body: '「我为你骄傲」——她从没说过' }] },
]

let pass = 0, fail = 0
for (const c of cases) {
  const text = C.stringifyCard(c.data, c.sections)
  const back = C.parseCard(text)
  const dataOk = JSON.stringify(back.data) === JSON.stringify(c.data)
  const sectOk = JSON.stringify(back.sections) === JSON.stringify(c.sections)
  if (dataOk && sectOk && back.ok) { pass++; console.log('  PASS', c.name) }
  else {
    fail++
    console.log('  FAIL', c.name)
    if (!dataOk) { console.log('    expected:', JSON.stringify(c.data)); console.log('    actual  :', JSON.stringify(back.data)); console.log(text) }
    if (!sectOk) { console.log('    sections:', JSON.stringify(back.sections)) }
    if (!back.ok) console.log('    errors:', back.errors)
  }
}
// ── 世界书条目：一段段文本要能读回成一组对象 ───────────────────────
// 条目不是 frontmatter（一本世界书可能几百条），落盘是 `- uid: 3` 这样的列表。
// 按 `- ` 切开再逐条解析；解析坏了的那条跳过，别让整本世界书消失。
console.log('\n=== 世界书条目 ===')
{
  const sections = [{ title: '世界书条目', body: [
    '- uid: 3',
    '  keys: ["北洋", "一九二八"]',
    '  content: "那一年下了很大的雪。"',
    '  comment: "背景"',
    '  insertion_order: 42',
    '  enabled: true',
    '- uid: 4',
    '  keys: []',
    '  content: "绿皮车"',
    '  insertion_order: 7',
    '  enabled: false',
  ].join('\n') }]
  const list = C.parseWorldEntries(sections)
  const check = (name, cond, extra) => { if (cond) { pass++; console.log('  PASS', name) } else { fail++; console.log('  FAIL', name, extra ?? '') } }
  check('两条都解出来了', list.length === 2, JSON.stringify(list))
  check('uid 是数字', list[0]?.uid === 3, list[0]?.uid)
  check('触发词是数组', JSON.stringify(list[0]?.keys) === JSON.stringify(['北洋', '一九二八']), list[0]?.keys)
  check('正文带中文', list[0]?.content === '那一年下了很大的雪。', list[0]?.content)
  check('停用状态保住了', list[1]?.enabled === false, list[1]?.enabled)
  check('空触发词不会变成空串', Array.isArray(list[1]?.keys) && list[1].keys.length === 0, list[1]?.keys)
  check('没有这个标题就给空数组', C.parseWorldEntries([{ title: '自述', body: 'x' }]).length === 0)
  check('正文为空也给空数组', C.parseWorldEntries([{ title: '世界书条目', body: '  ' }]).length === 0)
  // 真实世界里正文可能被人手改过：条目前面多一行说明、或中间有空行。
  // 这些都不该让后面的条目消失。
  const messy = C.parseWorldEntries([{ title: '世界书条目', body: '这本是从别处导进来的。\n- uid: 1\n  content: "第一条"\n\n- uid: 2\n  content: "第二条"' }])
  check('前言和空行不影响条目', messy.length === 2 && messy[1].content === '第二条', JSON.stringify(messy))
  check('跳过不是条目的东西', messy.every((e) => typeof e === 'object' && e !== null), JSON.stringify(messy))

  // `rest` 是导入时用 JSON.stringify 压成一行的（`{"probability":80}`，冒号后面
  // 没有空格）。解析器一开始用找 frontmatter 冒号的那套规则，要求冒号后跟空格/
  // `{`/`[`，于是整段被当成"没有分隔符"丢掉——条目看起来正常，但那几十个不认识
  // 的字段全没了，而且不报错。
  const rest = { probability: 80, extensions: { depth: 4 }, nested: { a: { b: [1, 2] } } }
  const withRest = C.parseWorldEntries([{ title: '世界书条目', body: '- uid: 1\n  rest: ' + JSON.stringify(rest) }])
  check('紧凑写法的 rest 读得回来', JSON.stringify(withRest[0]?.rest) === JSON.stringify(rest), JSON.stringify(withRest[0]?.rest))
  check('rest 的键名不带引号', withRest[0]?.rest?.probability === 80, Object.keys(withRest[0]?.rest ?? {}).join(','))
  const colonKey = C.parseWorldEntries([{ title: '世界书条目', body: '- uid: 2\n  rest: ' + JSON.stringify({ 'a:b': 1 }) }])
  check('键名里带冒号也切得对', colonKey[0]?.rest?.['a:b'] === 1, JSON.stringify(colonKey[0]?.rest))
  // 正文本身可能是 Markdown 列表，`- ` 开头的行不该被当成新条目
  const listy = C.parseWorldEntries([{ title: '世界书条目', body: '- uid: 3\n  content: ' + JSON.stringify('- 第一项\n- 第二项') }])
  check('正文里的列表不被切成两条', listy.length === 1 && listy[0].content === '- 第一项\n- 第二项', JSON.stringify(listy))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
