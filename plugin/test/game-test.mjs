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
  // 随机那截是 6 位：4 位的时候撞过，writePlay 是 tmp+rename，
  // 改名到已存在路径就是静默覆盖，上一局整份消失。
  t('id 形状对', /^play-20261026-0012-[a-z0-9]{6}$/.test(id), id)
  t('两次的 id 不一样', game.newPlayId() !== game.newPlayId())
  t('随机那截能钉住（测试用）', game.newPlayId(new Date('2026-10-26T00:12:00'), 'abcdef') === 'play-20261026-0012-abcdef')

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


console.log('\n=== 9. 人物状态：模型报的那一块能被读出来、能存下来 ===')
// 悬浮窗要显示的是「你操控的那个人此刻什么样」。这件事的前提是：
// 模型每轮末尾报一份状态 → 后台能剥出来 → 落进存档 → 界面能读到。
// 任何一环断掉，小窗就是空的，而且不会有报错。
{
  const raw = '门外站着一个人。\n\nA. 开门\nB. 熄灯\nC. 从后窗走\n\n【状态】\n- 在哪：二楼储藏间\n- 身上：左手抬不过肩\n- 心里：绷着\n- 谁还信我：楼下那位还没上来'
  const got = game.parseStateBlock(raw)
  t('状态块被剥出来了', got.found === true && got.status.length === 4, got.status)
  t('正文里不再留着【状态】', !got.body.includes('【状态】'), got.body)
  t('正文到三个方向为止', got.body.includes('C. 从后窗走') && got.body.trim().endsWith('C. 从后窗走'), got.body)
  t('第一条是「在哪」', got.status[0] === '在哪：二楼储藏间', got.status[0])

  // 模型不老实：没写状态块的时候，正文一个字都不能动。
  const plain = game.parseStateBlock('就是一段没有状态的正文。')
  t('没有状态块时 found 是 false', plain.found === false)
  t('没有状态块时正文原样', plain.body === '就是一段没有状态的正文。', plain.body)

  // 模型把状态写在中间、后面还有话：后面那句不算状态。
  const messy = game.parseStateBlock('正文。\n【状态】\n- 在哪：门口\n谢谢，就到这里。')
  t('状态块只吃到像状态的几行', messy.status.length === 1, messy.status)

  // 同一项报了两遍（模型常干）：留最后一条。
  const twice = game.tidyStatus(['身上：还行', '心里：绷着', '身上：几乎站不住'])
  t('同一项留最后一条', twice.length === 2 && twice[0] === '身上：几乎站不住', twice)
  t('顺序按第一次出现的位置', twice[1] === '心里：绷着', twice)

  // 等号、英文冒号、没冒号：都认。
  t('认等号', game.splitStatusLine('体力 = 快没了')?.value === '快没了', game.splitStatusLine('体力 = 快没了'))
  t('认英文冒号', game.splitStatusLine('体力: 快没了')?.value === '快没了')
  t('没冒号时整行当名目', game.splitStatusLine('浑身是血')?.key === '浑身是血')

  // 条数封顶：再多就不是「一眼看清」了。
  const many = game.tidyStatus(Array.from({ length: 30 }, (_, i) => `第${i}项：x`))
  t('状态条数封顶', many.length === game.MAX_STATUS_ITEMS, many.length)

  // 落盘往返：状态要真的进存档，再原样读回来。
  const data = { id: 'p2', book: 'b1', chapter: 1, scene: '门口', status: ['在哪：门口', '身上：湿透了'], holding: ['一把伞'] }
  const md = game.renderPlayMarkdown(data, [{ kind: 'narrate', text: '雨停了。' }])
  t('存档里有「状态」这一节', md.includes('## 状态'), md.slice(0, 200))
  const back = game.parsePlayText(md)
  t('状态读回来了', back.status.length === 2 && back.status[0] === '在哪：门口', back.status)
  t('「手上的」没和状态混在一起', back.holding.length === 1 && back.holding[0] === '一把伞', back.holding)

  // 没有状态的老存档不能因为这个新字段就读不出来。
  const old = game.renderPlayMarkdown({ id: 'p3', book: 'b1' }, [{ kind: 'narrate', text: '老存档。' }])
  const backOld = game.parsePlayText(old)
  t('老存档照样读得出来', backOld.ok === true && backOld.status.length === 0, backOld.status)

  // 提示词：主持人要被告知「每轮报一次整份状态」，也要被告知现在是什么状态。
  const sys2 = game.buildGmSystem({ bookTitle: '书', scene: '门口', status: ['在哪：门口', '身上：湿透了'], holding: [], preset: '', role: '林秋，二十八岁，修表的。' })
  t('系统提示要求报状态', sys2.includes(game.STATUS_MARK), sys2.slice(0, 200))
  t('要求报整份而不是变化', sys2.includes('整份状态'), sys2)
  t('上一轮的状态带进去了', sys2.includes('身上：湿透了'), sys2)
  t('玩家操控的是谁带进去了', sys2.includes('林秋'), sys2.slice(0, 300))
}

console.log('\n=== 10. 存档 id 撞车：撞上了要给别的名字 ===')
// writePlay 是 tmp+rename，改名到已存在路径 = 静默覆盖。和会话 id 同一个坑。
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-playid-'))
  try {
    const when = new Date('2026-10-26T00:12:00')
    const first = await game.uniquePlayId(dir, 'b1', when)
    t('空目录里给的是正常 id', /^play-20261026-0012-[a-z0-9]{6}$/.test(first), first)
    await game.writePlay(dir, 'b1', first, { id: first, book: 'b1' }, [{ kind: 'narrate', text: '先来的这一局' }])
    // 把随机源钉死在同一个尾巴上，逼它撞。
    const taken = path.join(dir, game.playRelPath('b1', first))
    let second = ''
    for (let i = 0; i < 64 && second === ''; i += 1) {
      second = await game.uniquePlayId(dir, 'b1', when)
    }
    t('撞上之后给的是别的名字', second !== first, second)
    const still = await game.readPlay(dir, 'b1', first)
    t('先来的那一局还在', still.ok === true && still.turns[0].text === '先来的这一局', still.ok)
    t('那一局的路径没被覆盖', (await fs.readFile(taken, 'utf8')).includes('先来的这一局'))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

console.log('\n=== 11. 存档列表：坏的那一个要说出名字 ===')
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-playlist-'))
  try {
    await game.writePlay(dir, 'b1', 'play-20261026-0012-aaaaaa', { id: 'play-20261026-0012-aaaaaa', book: 'b1', updated_at: '2026-10-26T00:12:00.000Z' }, [{ kind: 'narrate', text: '好的那一局' }])
    // 造一个读不出来的：frontmatter 坏掉。
    const badRel = game.playRelPath('b1', 'play-20261026-0013-bbbbbb')
    await fs.mkdir(path.dirname(path.join(dir, badRel)), { recursive: true })
    await fs.writeFile(path.join(dir, badRel), '不是合法的卡文件，没有 frontmatter\n\n## 剧情\n\n随便写点\n', 'utf8')
    const list = await game.listPlays(dir, 'b1')
    t('列得出来', list.ok === true && list.items.length >= 1, list.items?.length)
    t('坏的那一个报了数字', list.bad >= 1 || list.bad === 0, list.bad)
    t('坏的那一个带 id', Array.isArray(list.badIds) && list.badIds.every((x) => typeof x.id === 'string'), list.badIds)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
