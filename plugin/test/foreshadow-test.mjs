/**
 * foreshadow.js 的测试：一本书的伏笔账本。
 *
 * 要验的四件事：
 *   1. 这份 YAML 用户能直接看、直接改——写出去再读回来不能走样；
 *   2. 坏行只坏那一行，别的记录照读（账本是手改的，一定会被改坏）；
 *   3. 编号只往上走，不复用已经写进正文里的号；
 *   4. 「这一章该提哪几条」要挑得准——该收的漏了等于白记，埋太久的漏了那条线就死了。
 */

import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as fs2 from 'node:fs'
import * as foreshadow from '../lib/foreshadow.js'

let pass = 0
let fail = 0
const t = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name}${detail === '' ? '' : `  ← ${detail}`}`) }
}

const ws = path.join(tmpdir(), `lifecard-foreshadow-${Date.now()}`)
await fs.mkdir(ws, { recursive: true })

const sample = [
  { id: 'fs-001', title: '码头那封信', status: 'planted', priority: 'high', source: 'plan', planted_chapter: 3, expected_resolve: 12, resolved_chapter: 0, notes: '' },
  { id: 'fs-002', title: '老陈的左手', status: 'progressing', priority: 'normal', source: 'plan', planted_chapter: 5, expected_resolve: 9, resolved_chapter: 0, notes: '他一直在袖子里藏着' },
  { id: 'fs-003', title: '账本上少掉的一页', status: 'resolved', priority: 'low', source: 'backfill', planted_chapter: 2, expected_resolve: 7, resolved_chapter: 8, notes: '被他自己撕了' },
]

console.log('\n=== 1. 常量与路径 ===')
{
  t('四种状态', foreshadow.FORESHADOW_STATUS.join('|') === 'planted|progressing|resolved|abandoned', foreshadow.FORESHADOW_STATUS)
  t('三档要紧程度', foreshadow.FORESHADOW_PRIORITY.join('|') === 'high|normal|low', foreshadow.FORESHADOW_PRIORITY)
  t('活跃上限是 15', foreshadow.ACTIVE_LIMIT === 15, foreshadow.ACTIVE_LIMIT)
  t('埋太久是 30 章', foreshadow.STALE_CHAPTERS === 30, foreshadow.STALE_CHAPTERS)
  t('账本路径在书下面', foreshadow.foreshadowRelPath('雾港') === 'books/雾港/foreshadows.yml', foreshadow.foreshadowRelPath('雾港'))
  t('书 id 过 safeId', foreshadow.foreshadowRelPath('../etc') === 'books/..-etc/foreshadows.yml' || !foreshadow.foreshadowRelPath('../etc').includes('/../'), foreshadow.foreshadowRelPath('../etc'))
}

console.log('\n=== 2. 写出去再读回来，一个字不走样 ===')
{
  const text = foreshadow.renderForeshadows(sample)
  t('以 - id: 起头', text.startsWith('- id: fs-001'), text.slice(0, 40))
  t('其余字段缩两格', text.includes('\n  title: 码头那封信'), text.slice(0, 120))
  t('结尾有一个换行', text.endsWith('\n') && !text.endsWith('\n\n'), JSON.stringify(text.slice(-6)))
  t('一条记录九行', text.trimEnd().split('\n').length === 27, text.trimEnd().split('\n').length)

  const back = foreshadow.parseForeshadows(text)
  t('解析回来 ok', back.ok === true, back)
  t('三条都在', back.list.length === 3, back.list.length)
  t('没有坏行就不报 skipped', back.skipped === undefined, back.skipped)
  t('标题原样', back.list[0].title === '码头那封信', back.list[0].title)
  t('章号是数字不是字符串', back.list[0].planted_chapter === 3 && typeof back.list[0].planted_chapter === 'number', typeof back.list[0].planted_chapter)
  t('空 notes 读回来是空串', back.list[0].notes === '', back.list[0].notes)
  t('notes 里的中文还在', back.list[1].notes === '他一直在袖子里藏着', back.list[1].notes)
  t('状态还在', back.list[2].status === 'resolved', back.list[2].status)
  t('来源还在', back.list[2].source === 'backfill', back.list[2].source)
  t('空账本写成空串', foreshadow.renderForeshadows([]) === '', JSON.stringify(foreshadow.renderForeshadows([])))
  t('传 null 不炸', foreshadow.renderForeshadows(null) === '', foreshadow.renderForeshadows(null))
}

console.log('\n=== 3. 带引号、带冒号、带单引号的值 ===')
{
  const odd = [
    { id: 'fs-001', title: '他说: 我不去', status: 'planted', priority: 'normal', source: 'plan', planted_chapter: 1, expected_resolve: 0, resolved_chapter: 0, notes: "他姐姐's 名字" },
    { id: 'fs-002', title: '', status: 'planted', priority: 'normal', source: 'plan', planted_chapter: 1, expected_resolve: 0, resolved_chapter: 0, notes: '' },
  ]
  const text = foreshadow.renderForeshadows(odd)
  t('带冒号的套了单引号', text.includes("title: '他说: 我不去'"), text.split('\n')[1])
  t('单引号翻倍', text.includes("notes: '他姐姐''s 名字'"), text.split('\n')[8])
  const back = foreshadow.parseForeshadows(text)
  t('带冒号的读回来一字不差', back.list[0].title === '他说: 我不去', back.list[0].title)
  t('单引号读回来还是一个', back.list[0].notes === "他姐姐's 名字", back.list[0].notes)
  t('空标题那条被丢掉', back.list.length === 1, back.list.length)
  t('丢掉的那条计进 skipped', back.skipped === 1, back.skipped)
}

console.log('\n=== 4. 手改坏了也只坏一行 ===')
{
  const messy = [
    '# 我自己在旁边记一句',
    '',
    '- id: fs-001',
    '  title: 码头那封信',
    '  status: planted',
    '',
    '- title: 没有编号的一条',
    '  status: planted',
    '- id: fs-003',
    '  status: progressing',            // 没有 title
    '- id: fs-004',
    '  title: 墙上的划痕',
    '  这个人乱写的一行',
    '  planted_chapter: 7',
    '  expected_resolve: 20',
    '  这是一行没有冒号的废话',
    '- 不认识的写法',
    '- id: fs-005',
    '  title:  前后有空格的标题  ',
  ].join('\n')
  const got = foreshadow.parseForeshadows(messy)
  t('坏行不影响整体', got.ok === true, got.ok)
  t('只留下三条完整的', got.list.length === 3, got.list.map((x) => x.id))
  t('缺编号缺标题的各自计一次', got.skipped === 2, got.skipped)
  t('缺着的章号按 0 算', got.list[0].planted_chapter === 0, got.list[0].planted_chapter)
  t('后面还能接着读', got.list[2].id === 'fs-005' && got.list[2].title === '前后有空格的标题', got.list[2])
  t('空文本是空账本', foreshadow.parseForeshadows('').list.length === 0, foreshadow.parseForeshadows(''))
  t('传 null 是空账本', foreshadow.parseForeshadows(null).ok === true, foreshadow.parseForeshadows(null))
  t('完全不认识的文本不崩', foreshadow.parseForeshadows('随便写点什么').list.length === 0, foreshadow.parseForeshadows('随便写点什么'))
}

console.log('\n=== 5. 落盘：文件不在不是错 / 写得进读得回 ===')
{
  const missing = await foreshadow.readForeshadows(ws, '还没写过的书')
  t('文件不在也 ok', missing.ok === true, missing)
  t('文件不在给空账本', missing.list.length === 0, missing.list)
  t('文件不在标了 missing', missing.missing === true, missing.missing)

  const wrote = await foreshadow.writeForeshadows(ws, '雾港', sample)
  t('写得进去', wrote.ok === true, wrote)
  t('回报条数', wrote.count === 3, wrote.count)

  const abs = path.join(ws, foreshadow.foreshadowRelPath('雾港'))
  const onDisk = fs2.readFileSync(abs, 'utf8')
  t('文件真的在书目录里', onDisk.startsWith('- id: fs-001'), onDisk.slice(0, 30))
  t('目录不存在会自己建', fs2.existsSync(path.dirname(abs)), path.dirname(abs))

  const back = await foreshadow.readForeshadows(ws, '雾港')
  t('读得回来', back.ok === true && back.list.length === 3, back)
  t('读回来没有 missing', back.missing === undefined, back.missing)

  // 不留临时文件：写到一半失败会 rm，写成了会改名走。
  const left = (await fs.readdir(path.dirname(abs))).filter((n) => n.includes('.tmp-'))
  t('没有留下临时文件', left.length === 0, left)

  const overwrite = await foreshadow.writeForeshadows(ws, '雾港', [sample[0]])
  const after = await foreshadow.readForeshadows(ws, '雾港')
  t('整份覆盖，不是追加', overwrite.ok === true && after.list.length === 1, after.list.length)

  const empty = await foreshadow.writeForeshadows(ws, '空书', [])
  t('空账本也写得下', empty.ok === true && empty.count === 0, empty)
  const emptyBack = await foreshadow.readForeshadows(ws, '空书')
  t('空文件读回来还是空账本', emptyBack.ok === true && emptyBack.list.length === 0, emptyBack)
}

console.log('\n=== 6. 编号只往上走 ===')
{
  t('空账本从 001 起', foreshadow.nextForeshadowId([]) === 'fs-001', foreshadow.nextForeshadowId([]))
  t('接着往下走', foreshadow.nextForeshadowId([{ id: 'fs-001' }, { id: 'fs-002' }]) === 'fs-003', foreshadow.nextForeshadowId([{ id: 'fs-002' }]))
  // 删掉 fs-002 之后条数只剩 2，但号不能回头——正文里可能已经写着 fs-003 了。
  t('中间删了号也不复用', foreshadow.nextForeshadowId([{ id: 'fs-001' }, { id: 'fs-003' }]) === 'fs-004', foreshadow.nextForeshadowId([{ id: 'fs-001' }, { id: 'fs-003' }]))
  t('乱写的 id 不算数', foreshadow.nextForeshadowId([{ id: '随手一写' }, { id: 'fs-007' }]) === 'fs-008', foreshadow.nextForeshadowId([{ id: 'fs-007' }]))
  t('超过三位继续加', foreshadow.nextForeshadowId([{ id: 'fs-999' }]) === 'fs-1000', foreshadow.nextForeshadowId([{ id: 'fs-999' }]))
  t('空数组给 001', foreshadow.nextForeshadowId(null) === 'fs-001', foreshadow.nextForeshadowId(null))
}

console.log('\n=== 7. 这一章该提哪几条 ===')
{
  const list = [
    { id: 'fs-001', title: '该收的低', status: 'planted', priority: 'low', planted_chapter: 3, expected_resolve: 12 },
    { id: 'fs-002', title: '该收的高', status: 'progressing', priority: 'high', planted_chapter: 4, expected_resolve: 12 },
    { id: 'fs-003', title: '该收的但已经放弃了', status: 'abandoned', priority: 'high', planted_chapter: 4, expected_resolve: 12 },
    { id: 'fs-004', title: '埋得久但还没到 30 章', status: 'planted', priority: 'normal', planted_chapter: 1 },
    { id: 'fs-005', title: '刚埋的', status: 'planted', priority: 'high', planted_chapter: 11 },
    { id: 'fs-006', title: '超期了', status: 'progressing', priority: 'high', planted_chapter: 2, expected_resolve: 10 },
    { id: 'fs-007', title: '已回收的', status: 'resolved', priority: 'high', planted_chapter: 2, expected_resolve: 10, resolved_chapter: 10 },
  ]
  const got = foreshadow.pickForChapter(list, 12)
  t('该收的两条都挑出来了', got.must.length === 2, got.must.map((x) => x.id))
  t('放弃的那条不算该收', !got.must.some((x) => x.id === 'fs-003'), got.must.map((x) => x.id))
  t('high 排在前面', got.must[0].id === 'fs-002', got.must.map((x) => x.priority))
  t('还没到 30 章的不进提醒', !got.warn.some((x) => x.id === 'fs-004'), got.warn.map((x) => x.id))
  t('超期的也进了提醒', got.warn.some((x) => x.id === 'fs-006' && x.overdue === true), got.warn)
  t('刚埋的不进提醒', !got.warn.some((x) => x.id === 'fs-005'), got.warn.map((x) => x.id))
  t('已回收的不进提醒', !got.warn.some((x) => x.id === 'fs-007'), got.warn.map((x) => x.id))
  t('提醒里也算得清埋了多久', got.warn.find((x) => x.id === 'fs-006').stale_by === 10, got.warn.find((x) => x.id === 'fs-006'))
  t('提醒里 high 在前', got.warn[0].priority === 'high', got.warn.map((x) => x.priority))
  t('该收的不会同时进提醒', !got.warn.some((x) => x.id === 'fs-001'), got.warn.map((x) => x.id))

  // 「埋太久」要真过 30 章才提：第 40 章时，第 1 章埋的那条已经 39 章没动。
  const stale = foreshadow.pickForChapter([
    { id: 'fs-010', title: '第 1 章埋的', status: 'planted', priority: 'normal', planted_chapter: 1 },
    { id: 'fs-011', title: '第 20 章埋的', status: 'planted', priority: 'high', planted_chapter: 20 },
  ], 40)
  t('埋过 30 章的那条进了提醒', stale.warn.some((x) => x.id === 'fs-010'), stale.warn.map((x) => x.id))
  t('没到 30 章的不提', !stale.warn.some((x) => x.id === 'fs-011'), stale.warn.map((x) => x.id))
  t('埋了多久说得清', stale.warn.find((x) => x.id === 'fs-010').stale_by === 39, stale.warn.find((x) => x.id === 'fs-010'))

  const none = foreshadow.pickForChapter([], 3)
  t('空账本两个都是空数组', none.must.length === 0 && none.warn.length === 0, none)
  t('传 null 不炸', foreshadow.pickForChapter(null, 3).must.length === 0, foreshadow.pickForChapter(null, 3))
  t('刚好 30 章也算埋太久', foreshadow.pickForChapter([{ id: 'fs-001', title: 'x', status: 'planted', planted_chapter: 1, expected_resolve: 0 }], 31).warn.length === 1, '')
  const justUnder = foreshadow.pickForChapter([{ id: 'fs-001', title: 'x', status: 'planted', planted_chapter: 2, expected_resolve: 0 }], 31)
  t('差一章还不算', justUnder.warn.length === 0, justUnder.warn)
  const custom = foreshadow.pickForChapter([{ id: 'fs-001', title: 'x', status: 'planted', planted_chapter: 1, expected_resolve: 0 }], 5, { staleChapters: 3 })
  t('能改「多久算久」', custom.warn.length === 1, custom.warn)
}

console.log('\n=== 8. 手上挂太多时说一句 ===')
{
  const make = (n, status = 'planted') => Array.from({ length: n }, (_, i) => ({ id: `fs-${String(i + 1).padStart(3, '0')}`, title: `第 ${i + 1} 条`, status, planted_chapter: 1 }))
  t('空账本不说话', foreshadow.budgetHint([]) === '', foreshadow.budgetHint([]))
  t('刚好 15 条不说话', foreshadow.budgetHint(make(15)) === '', foreshadow.budgetHint(make(15)))
  const over = foreshadow.budgetHint(make(18))
  t('超过 15 条说一句', over.includes('18') && over.length > 0, over)
  t('说清了上限是多少', over.includes('15'), over)
  t('说的是人话，没有「状态机」这类词', !/状态机|枚举|字段/.test(over), over)
  t('不出现「请」和「建议您」', !/请|建议您/.test(over), over)
  t('已回收的不算活跃', foreshadow.budgetHint([...make(10), ...make(10, 'resolved')]) === '', foreshadow.budgetHint([...make(10), ...make(10, 'resolved')]))
  t('放弃的也不算活跃', foreshadow.budgetHint([...make(10), ...make(10, 'abandoned')]) === '', '')
}

console.log('\n=== 9. 一行概览 ===')
{
  t('空账本给空串', foreshadow.summaryLine([]) === '', foreshadow.summaryLine([]))
  const line = foreshadow.summaryLine(sample)
  t('报得出总数', line.includes('3 条'), line)
  t('报得出已埋', line.includes('已埋 1'), line)
  t('报得出进行中', line.includes('进行中 1'), line)
  t('报得出已回收', line.includes('已回收 1'), line)
  t('没回收的算得对', line.includes('没回收的 2 条'), line)
  // 写到第 8 章时：fs-001 说好第 12 章（还没到），fs-002 说好第 9 章（也还没到）。
  t('没到期的说没到', line.includes('还没到该收的时候'), line)
  t('是人话', !/状态机|枚举|字段/.test(line), line)
  t('不出现「请」和「建议您」', !/请|建议您/.test(line), line)

  // 账本里最后出现过的是第 10 章（说明已经写到那儿了）：说好第 3 章揭的那条就算超期。
  const overdue = foreshadow.summaryLine([
    { id: 'fs-001', title: 'a', status: 'planted', planted_chapter: 1, expected_resolve: 3, resolved_chapter: 0 },
    { id: 'fs-002', title: 'b', status: 'planted', planted_chapter: 10, expected_resolve: 19, resolved_chapter: 0 },
  ])
  t('该收几条也说得清', overdue.includes('1 条该收了'), overdue)
  const allResolved = foreshadow.summaryLine([{ id: 'fs-001', title: 'a', status: 'resolved', planted_chapter: 1, expected_resolve: 2, resolved_chapter: 2 }])
  t('全收完了也说得出来', allResolved.includes('没回收的 0 条'), allResolved)
}

console.log('\n=== 10. 默认导出把该带的都带上 ===')
{
  for (const name of ['FORESHADOW_STATUS', 'FORESHADOW_PRIORITY', 'ACTIVE_LIMIT', 'STALE_CHAPTERS', 'foreshadowRelPath', 'parseForeshadows', 'renderForeshadows', 'readForeshadows', 'writeForeshadows', 'nextForeshadowId', 'pickForChapter', 'budgetHint', 'summaryLine']) {
    t(`默认导出有 ${name}`, foreshadow.default[name] !== undefined, name)
  }
  t('默认导出的是同一个函数', foreshadow.default.parseForeshadows === foreshadow.parseForeshadows, '')
}

await fs.rm(ws, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
