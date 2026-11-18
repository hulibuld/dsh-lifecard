/**
 * 世界书按关键词触发的回归测试。
 *
 * 要钉住的是四件事：
 *   1. 说到才带——没提到关键词的条目不该跟着进来；
 *   2. 常驻条永远带——世界书的「总纲」没有触发词，靠这个字段活着；
 *   3. 挑得太少就退回整本——宁可多给几条，不能漏设定；
 *   4. 空世界书不炸（新工作区里这一条是常态，别让它把整场对话打断）。
 *
 * 纯函数，不起服务器、不碰磁盘。
 */
import * as tavern from '../lib/tavern.js'

let pass = 0, fail = 0
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400)) }
}

console.log('=== 1. 说到才带 ===')
{
  const entries = [
    { content: '这座城靠煤矿活着。', constant: true },
    { keys: ['矿'], content: '矿上三班倒。' },
    { keys: ['潮水'], content: '潮水一退，滩上全是螺。' },
  ]
  const hit = tavern.pickWorldEntriesByText(entries, '我今天下矿')
  const texts = hit.hits.map((x) => String(x.entry.content))
  t('提到「矿」就把矿那条带上', texts.includes('矿上三班倒。'), texts)
  t('没提到的「潮水」不带', !texts.includes('潮水一退，滩上全是螺。'), texts)
  t('常驻那条也在（没有触发词也带）', texts.includes('这座城靠煤矿活着。'), texts)
  t('漏掉的条数点得清', hit.missed === 1, hit.missed)

  const none = tavern.pickWorldEntriesByText(entries, '今天天气不错')
  t('一句都没对上的时候只剩常驻', none.hits.length === 1, none.hits.map((x) => x.entry.content))
  t('两条没命中都记在 missed 里', none.missed === 2, none.missed)

  const empty = tavern.pickWorldEntriesByText(entries, '')
  t('检索文本为空时也算不命中（只剩常驻）', empty.hits.length === 1, empty.hits.length)
}

console.log('=== 2. keys 的两种写法都认 ===')
{
  const asArray = { keys: ['码头', '潮水'], content: '码头那条街，涨潮就淹。' }
  const asString = { keys: '码头, 潮水', content: '涨潮的时候船都回来了。' }
  const entries = [asArray, asString]
  const a = tavern.pickWorldEntriesByText(entries, '我去码头')
  t('数组写法的 keys 命中', a.hits.some((x) => x.entry === asArray), a.hits.length)
  t('逗号字符串写法的 keys 也命中', a.hits.some((x) => x.entry === asString), a.hits.length)
  const b = tavern.pickWorldEntriesByText(entries, '码头')
  t('同一个词把两条都带出来', b.hits.length === 2, b.hits.length)
}

console.log('=== 3. always：点名要带的永远在 ===')
{
  const entries = [
    { keys: ['矿'], content: '矿上三班倒。' },
    { keys: ['潮水'], content: '潮水一退，滩上全是螺。' },
  ]
  const byIndex = tavern.pickWorldEntriesByText(entries, '今天天气不错', { always: [1] })
  t('always 给下标：那条带上了', byIndex.hits.some((x) => x.index === 1), byIndex.hits.map((x) => x.index))
  const byEntry = tavern.pickWorldEntriesByText(entries, '今天天气不错', { always: [entries[1]] })
  t('always 给条目对象：也带上了', byEntry.hits.some((x) => x.index === 1), byEntry.hits.map((x) => x.index))
  t('always 的不算漏', byEntry.missed === 1, byEntry.missed)
  const bogus = tavern.pickWorldEntriesByText(entries, '矿', { always: [99] })
  t('always 给了越界下标也不炸', bogus.hits.length === 1, bogus.hits.length)
}

console.log('=== 4. 挑得太少就退回整本 ===')
{
  const entries = [
    { keys: ['矿'], content: '矿上三班倒。' },
    { keys: ['潮水'], content: '潮水一退，滩上全是螺。' },
    { keys: ['供销社'], content: '供销社的柜台上有一层灰。' },
  ]
  const few = tavern.worldNotesForTurn(entries, '我去矿上')
  t('只命中一条 → 退回整本', few.fellBack === true, few)
  t('退回整本时三条都摆出来', few.count === 3, few.count)
  const many = tavern.worldNotesForTurn(entries, '矿上和潮水都说了')
  t('命中两条 → 不退回', many.fellBack === false, many)
  t('不退回时只摆命中的两条', many.count === 2, many.count)
  const forced = tavern.worldNotesForTurn(entries, '我去矿上', { minHits: 1 })
  t('minHits 调低之后一条也算命中', forced.fellBack === false && forced.count === 1, forced)
}

console.log('=== 5. 编号与那句「按第 N 条来」 ===')
{
  const entries = [
    { keys: ['矿'], content: '矿上三班倒。' },
    { keys: ['潮水'], content: '潮水一退，滩上全是螺。' },
  ]
  const put = tavern.worldNotesForTurn(entries, '矿上和潮水')
  t('每条前面有编号', put.notes[0].startsWith('1. ') && put.notes[1].startsWith('2. '), put.notes)
  t('编号里不出现「关键词：」（那会让它当成参考资料）', !put.notes.join('').includes('关键词'), put.notes)
  t('末尾那句指得出第几条', put.hint.includes('第 1、2 条'), put.hint)
  const none = tavern.worldNotesForTurn([], '随便说说')
  t('一条都没有时不加那句（没有编号还叫它按第几条，它会去找）', none.hint === '' && none.count === 0, none)
  t('worldRefHint(0) 是空串', tavern.worldRefHint(0) === '', tavern.worldRefHint(0))
  t('worldRefHint 条数多的时候给区间', tavern.worldRefHint(9).includes('第 1 到 9 条'), tavern.worldRefHint(9))
}

console.log('=== 6. 空世界书不炸 ===')
{
  t('空数组不炸', tavern.worldNotesForTurn([], '矿').count === 0, true)
  t('undefined 不炸', tavern.worldNotesForTurn(undefined, '矿').count === 0, true)
  t('pickWorldEntriesByText 收 undefined 也不炸', tavern.pickWorldEntriesByText(undefined, '矿').missed === 0, true)
  t('正文是空白的条目直接不算数', tavern.worldNotesForTurn([{ keys: ['矿'], content: '   ' }], '矿').count === 0, true)
  t('MIN_WORLD_HITS 是 2', tavern.MIN_WORLD_HITS === 2, tavern.MIN_WORLD_HITS)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
