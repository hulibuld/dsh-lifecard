/**
 * game.js 的测试：文字小说游戏的存档层。
 *
 * 这一层只碰磁盘与文字。要验的两件事：
 *   1. 一局能原样往返（旁白、你选了什么、结果分得开）
 *   2. 模型不老实的时候，三个方向还能被认出来（它是会乱来的）
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as game from '../lib/game.js'

let pass = 0
let fail = 0
const t = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name}${detail === '' ? '' : `  ← ${detail}`}`) }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-game-'))
try {
  console.log('\n=== 1. 存档路径与 id ===')
  t('存档在书目录下', game.playRelPath('b1', 'p1') === 'books/b1/plays/p1.md', game.playRelPath('b1', 'p1'))
  t('id 打平路径分隔符', game.playRelPath('b1', '../x') === 'books/b1/plays/..-x.md')
  const id = game.newPlayId(new Date('2026-10-26T00:12:00'))
  t('id 形状对', /^play-20261026-0012-[a-z0-9]{4}$/.test(id), id)
  t('两次的 id 不一样', game.newPlayId() !== game.newPlayId())

  console.log('\n=== 2. 往返：旁白 / 你选的 / 结果 ===')
  const data = { id: 'p1', book: 'b1', chapter: 3, preset: 'game-detect', created_at: '2026-10-26T00:00:00.000Z', updated_at: '2026-10-26T00:10:00.000Z', turn: 1, scene: '雨还在下，门口站着一个人。', holding: ['一把伞', '半张地图'] }
  const turns = [
    { kind: 'narrate', text: '你推开门。\n\n外面的雨比刚才大。' },
    { kind: 'choose', text: '把伞递过去', result: '对方愣了一下，接过来，没道谢。' },
    { kind: 'narrate', text: '你们站在门廊下，谁都没说话。' },
  ]
  const md = game.renderPlayMarkdown(data, turns)
  t('正文里写了「现在」这一节', md.includes('## 现在'))
  t('正文里写了「手上的」这一节', md.includes('## 手上的'))
  t('正文里写了「剧情」这一节', md.includes('## 剧情'))
  t('你选的那一步带「> 我：」', md.includes('> 我：把伞递过去'))
  t('手上的东西写成列表', md.includes('- 一把伞') && md.includes('- 半张地图'))

  const back = game.parsePlayText(md)
  t('读回来成功', back.ok === true, back.error ?? '')
  t('局面读回来对', back.scene === '雨还在下，门口站着一个人。', back.scene)
  t('手上的读回来对', back.holding.length === 2 && back.holding[1] === '半张地图', JSON.stringify(back.holding))
  t('步数对', back.turns.filter((x) => x.kind === 'choose').length === 1)
  const chosen = back.turns.find((x) => x.kind === 'choose')
  t('你选的那句读回来对', chosen.text === '把伞递过去', chosen.text)
  t('那一步的结果读回来对', chosen.result.includes('没道谢'), chosen.result)
  t('旁白读回来对', back.turns.some((x) => x.kind === 'narrate' && x.text.includes('雨比刚才大')))

  console.log('\n=== 3. 正文里带 Markdown 标记也不会把存档读坏 ===')
  const tricky = [
    { kind: 'narrate', text: '## 一段小标题\n\n普通正文。' },
    { kind: 'choose', text: '选「带#号的那个」', result: '结果里也有 # 号。' },
  ]
  const md2 = game.renderPlayMarkdown({ ...data, scene: '', holding: [] }, tricky)
  const back2 = game.parsePlayText(md2)
  t('带 # 的正文还能读回来', back2.ok === true)
  t('带 # 的结果还在', back2.turns.find((x) => x.kind === 'choose').result.includes('# 号'))

  console.log('\n=== 4. 存 / 读 / 列 / 删 ===')
  const saved = await game.writePlay(tmp, 'b1', 'p1', data, turns)
  t('写盘成功', saved.ok === true, JSON.stringify(saved))
  t('文件落在 books/b1/plays/p1.md', saved.path === 'books/b1/plays/p1.md', saved.path)
  const got = await game.readPlay(tmp, 'b1', 'p1')
  t('读回来成功', got.ok === true)
  t('读回来的 chapter 是 3', Number(got.data.chapter) === 3)
  const none = await game.readPlay(tmp, 'b1', 'nope')
  t('读不存在的报人话', none.ok === false && String(none.error).includes('不在了'), none.error)

  await game.writePlay(tmp, 'b1', 'p2', { ...data, id: 'p2', updated_at: '2026-10-26T01:00:00.000Z' }, [{ kind: 'narrate', text: '第二局' }])
  const listed = await game.listPlays(tmp, 'b1')
  t('列出两局', listed.ok === true && listed.items.length === 2, String(listed.items?.length))
  t('按最后改动倒序', listed.items[0].id === 'p2', listed.items.map((x) => x.id).join(','))
  t('列表里带这一步走了几步', listed.items.find((x) => x.id === 'p1').turns === 1)
  const noDir = await game.listPlays(tmp, 'no-such-book')
  t('书不存在时是空列表不是报错', noDir.ok === true && noDir.items.length === 0)

  const del = await game.deletePlay(tmp, 'b1', 'p2')
  t('删掉成功', del.ok === true)
  t('删完就列不出来', (await game.listPlays(tmp, 'b1')).items.length === 1)
  t('删不存在的不报错', (await game.deletePlay(tmp, 'b1', 'p2')).ok === true)

  console.log('\n=== 5. 写盘是原子的（不留临时文件） ===')
  const names = await fs.readdir(path.join(tmp, 'books', 'b1', 'plays'))
  t('没留下 .tmp- 文件', names.every((n) => !n.includes('.tmp-')), names.join(','))

  console.log('\n=== 6. 拆三个方向：模型乱写的时候也得认出来 ===')
  const plain = game.parseChoices('你站在门口。\n\nA. 推门进去\nB. 转身走\nC. 敲两下')
  t('认 A/B/C 三行', plain.choices.length === 3, JSON.stringify(plain.choices))
  t('第一个方向内容对', plain.choices[0].text === '推门进去')
  t('正文不含方向列表', plain.body === '你站在门口。', plain.body)

  const numbered = game.parseChoices('段落一。\n\n1. 左边\n2. 右边\n3. 原地')
  t('认 1/2/3 三行', numbered.choices.length === 3)
  t('编号也记下来', numbered.choices[0].label === '1')

  const dashed = game.parseChoices('段落。\n\n- 拿伞\n- 不拿\n- 问一句')
  t('认 - 开头的三行', dashed.choices.length === 3)

  const onlyTwo = game.parseChoices('段落。\n\nA. 一个\nB. 两个')
  t('只给两个也认两个', onlyTwo.choices.length === 2)

  const noneAtAll = game.parseChoices('就是一段没有选项的正文。')
  t('完全没有选项时返回空数组', noneAtAll.choices.length === 0)
  t('没有选项时正文是全文', noneAtAll.body === '就是一段没有选项的正文。')

  const messy = game.parseChoices('开始。\nA. \nB. 有内容\n\n更多正文')
  t('空的内容跳过', messy.choices.length === 1 && messy.choices[0].text === '有内容')

  console.log('\n=== 7. 主持人的话：几条硬要求 ===')
  const sys = game.buildGmSystem({ bookTitle: '测试书', scene: '', holding: [], preset: '' })
  t('说清自己是谁', sys.includes('主持'))
  t('要求三个方向', sys.includes('三个'))
  t('要求有代价', sys.includes('代价'))
  t('不许替玩家决定', sys.includes('不替玩家决定'))
  t('不许说「你可以选择」', sys.includes('你可以选择'))
  const withAll = game.buildGmSystem({ bookTitle: '书', scene: '现在在雨里。', holding: ['一把伞'], preset: '每步都要扣时间。' })
  t('局面带进去了', withAll.includes('现在在雨里'))
  t('手上的带进去了', withAll.includes('一把伞'))
  t('玩法带进去了', withAll.includes('每步都要扣时间'))

  const userNoMove = game.buildGmUser({ turns: [], move: '', fromChapter: '第一章的结尾。' })
  t('开局带上书里的那一段', userNoMove.includes('第一章的结尾'))
  t('开局说要先开个头', userNoMove.includes('开个头'))
  const userWithMove = game.buildGmUser({ turns: [{ kind: 'choose', text: '推门', result: '门开了。' }], move: '走进去' })
  t('走一步时带上我这一步', userWithMove.includes('我这一步：走进去'))
  t('走一步时带上前面发生过的', userWithMove.includes('门开了'))
} finally {
  await fs.rm(tmp, { recursive: true, force: true })
}

console.log('\n=== 7. 玩家写的那段带换行和小标题，不能把后面的剧情吃掉 ===')
// `> 我：...` 只保护第一行。以前续行是裸的：只要它以 `## ` 开头，下次读回来
// 就会在那一行把「剧情」这一节切断，这一句之后的**所有轮次**一起消失，
// 而且不报错、不提示，界面上就是「后面那段呢」。
{
  const turns = [
    { kind: 'narrate', text: '雨还在下。' },
    { kind: 'choose', text: '我把伞递过去\n## 三年前\n那时候也下过这样一场雨。', result: '她没有接。' },
    { kind: 'narrate', text: '她把门推开一条缝。' },
  ]
  const text = game.renderPlayMarkdown({ id: 'p1', book: 'b1', title: '试' }, turns)
  const back = game.parsePlayText(text)
  t('带小标题的玩家输入也能读回来', back.ok === true, back.error)
  t('轮次数没少', (back.turns ?? []).length === 3, (back.turns ?? []).length)
  t('写完那一句之后的旁白还在', (back.turns ?? []).some((x) => String(x.text ?? '').includes('门推开一条缝')), back.turns)
  t('玩家那句里的小标题被压成一行', String((back.turns ?? [])[1]?.text ?? '').includes('三年前'), (back.turns ?? [])[1])
}

console.log('\n=== 8. 「把这一局写成小说的一章」要发给模型的话 ===')
// 这一段最要紧的一条是「玩家选过的那几步不能丢」：玩出来的东西一旦被
// 改写成小说就抹掉选择，用户会觉得自己白走了那些步。
{
  const turns = [
    { kind: 'narrate', text: '雨把路灯泡成一团黄。' },
    { kind: 'choose', text: '我把伞递过去', result: '她没接，只是看着我的手。' },
    { kind: 'say', text: '走吧。', text2: '她终于接过去了。' },
  ]
  const p = game.buildPlayToChapterPrompt({ bookTitle: '雨里的门', turns, note: '停在她接伞那一刻' })
  t('要求写成小说而不是剧本', String(p.system).includes('不是剧本'), p.system.slice(0, 80))
  t('要求保留玩家选过的那几步', String(p.system).includes('必须保留'), p.system)
  t('不许新加人和情节', String(p.system).includes('不要新加人'), p.system)
  t('带上了书名', String(p.system).includes('雨里的门'), p.system.slice(0, 120))
  t('正文里有选的那一步', String(p.user).includes('我把伞递过去'), p.user)
  t('带上了「这一章想往哪走」', String(p.user).includes('停在她接伞那一刻'), p.user)
  t('段落顺序是「先旁白、再选择」', String(p.user).indexOf('路灯') < String(p.user).indexOf('我把伞'), p.user)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
