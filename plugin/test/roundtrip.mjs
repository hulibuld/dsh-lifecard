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
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
