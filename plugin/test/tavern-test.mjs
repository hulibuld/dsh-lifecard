/**
 * 酒馆（角色扮演）的回归测试。
 *
 * 这一层最容易坏在三处，所以三处都钉死：
 *   1. 文件格式——写出去读回来必须一模一样（用户会拿 Finder 直接改）；
 *   2. 人设与世界书——卡上写了「不会说的话」就真别让它说，世界书按关键词才带；
 *   3. 「TA 没回话」的时候我说的话不能丢（这是最气人的那种丢数据）。
 *
 * 不需要起服务器：直接 buildApi() 拿路由表调；工作区是 tmpdir 下的临时目录。
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as api from '../lib/index.js'
import * as store from '../lib/store.js'
import * as tavern from '../lib/tavern.js'

let pass = 0, fail = 0
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400)) }
}

const stamp = Date.now()
const ws = path.join(tmpdir(), 'lifecard-tavern-' + stamp)
await fs.mkdir(ws, { recursive: true })
await store.openWorkspace(ws, { create: true })

/** 造一个假的宿主 ctx：`llm.stream()` 直接给 handle（和真宿主一样）。 */
const makeCtx = (reply) => ({
  webServer: { register: () => () => {} },
  reflect: { get: () => undefined },
  effect: (fn) => { fn(); return () => {} },
  logger: { warn: () => {} },
  get: (name) => (name === 'llm' ? {
    listProviders: async () => [{ provider: 'raccoon', models: [{ id: 'm' }] }],
    listModels: async () => [],
    stream: () => (async function* () {
      yield { type: 'text-delta', text: reply() }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  } : undefined),
})

console.log('\n=== 1. 会话文件：写出去读回来还是那个样子 ===')
{
  t('路径钉在 chats/ 里', tavern.chatRelPath('x') === 'chats/x.md', tavern.chatRelPath('x'))
  t('../ 这类东西只会在 chats/ 里变成一个怪名字', tavern.chatRelPath('../outside').startsWith('chats/'), tavern.chatRelPath('../outside'))
  t('怪名字里没有斜杠（跑不到别的文件夹）', !tavern.chatRelPath('../outside').slice('chats/'.length).includes('/'), tavern.chatRelPath('../outside'))
  const id = tavern.newChatId(new Date('2026-10-24T16:11:00'))
  t('会话 id 带日期和时分', /^chat-20261024-1611-[a-z0-9]{4}$/.test(id), id)

  const turns = [
    { who: '我', text: '你来了。' },
    { who: '张三', text: '我来了。\n路上买了两个橘子。' },
    { who: '我', text: '他说：这不是钱的事。' },
  ]
  const data = { id: 'chat-test', card: 'people/zhang-san.card.md', card_name: '张三', created_at: '2026-10-24 16:11', updated_at: '2026-10-24 16:12' }
  const text = tavern.renderChatMarkdown(data, turns)
  t('开头是 frontmatter', text.startsWith('---\n'), text.slice(0, 20))
  t('写进去的是 kind: chat', text.includes('kind: "chat"') || text.includes('kind: chat'), text.slice(0, 200))
  const back = tavern.parseChatText(text)
  t('读得回来', back.ok === true, back)
  t('条数对得上', back.turns.length === 3, back.turns)
  t('说话人对得上', back.turns.map((x) => x.who).join('/') === '我/张三/我', back.turns.map((x) => x.who))
  t('多行正文没断', back.turns[1].text === '我来了。\n路上买了两个橘子。', back.turns[1])
  t('正文里的冒号不会被当成说话人', back.turns[2].text === '他说：这不是钱的事。', back.turns[2])
  t('卡路径也存住了', back.data.card === 'people/zhang-san.card.md', back.data)
  t('读坏的当成读不出来', tavern.parseChatText('这不是卡片格式').ok === false)
}

console.log('\n=== 2. 存盘、列表、删除 ===')
{
  const data = { id: 'chat-a', card: 'people/a.card.md', card_name: '甲', created_at: '2026-10-24 10:00', updated_at: '2026-10-24 10:05' }
  const wrote = await tavern.writeChat(ws, 'chat-a', data, [{ who: '我', text: '你好' }, { who: '甲', text: '你好啊' }])
  t('存得下来', wrote.ok === true, wrote)
  t('落在 chats/ 里', wrote.path === 'chats/chat-a.md', wrote.path)
  const got = await tavern.readChat(ws, 'chat-a')
  t('读得回来', got.ok === true, got)
  t('会话里那两句话都在', (got.turns ?? []).length === 2, got.turns)

  const data2 = { ...data, id: 'chat-b', card_name: '乙', updated_at: '2026-10-24 12:00' }
  await tavern.writeChat(ws, 'chat-b', data2, [{ who: '我', text: '新的' }])
  const list = await tavern.listChats(ws)
  t('列表能列出来', list.ok === true && list.items.length === 2, list)
  t('最近说过的排在前面', list.items[0].id === 'chat-b', list.items.map((x) => x.id))
  t('列表里带名字和最后一句', list.items[0].card_name === '乙' && list.items[0].last === '新的', list.items[0])

  // 坏文件：要算进 bad，不许当成「没有会话」
  await fs.writeFile(path.join(ws, 'chats', 'chat-broken.md'), '完全不是这种格式', 'utf8')
  const list2 = await tavern.listChats(ws)
  t('读不出来的会话单独计数', list2.bad === 1, list2)
  t('别的会话照常列出来', list2.items.length === 2, list2.items.length)

  const gone = await tavern.deleteChat(ws, 'chat-a')
  t('删得掉', gone.ok === true, gone)
  const list3 = await tavern.listChats(ws)
  t('删完就不在列表里了', !list3.items.some((x) => x.id === 'chat-a'), list3.items.map((x) => x.id))
  t('删不存在的不报错', (await tavern.deleteChat(ws, 'chat-a')).ok === true)

  const out = await tavern.readChat(ws, '../outside')
  t('越界的会话 id 读不到任何东西', out.ok === false, out)
}

console.log('\n=== 3. 从卡里捞人设 ===')
{
  const sections = [
    { title: '自述', body: '在纱厂做了三十年，手指头压坏过一根。' },
    { title: '口癖', body: '老说「我跟你说」。' },
    { title: '不会说的话', body: '不会说「我爱你」。' },
    { title: '开场白', body: '你来了？饭在锅里。' },
    { title: '创作者备注', body: '这是作者随手记的设定笔记，不该念出来。' },
  ]
  const got = tavern.personaFromCard({ name: '母亲' }, sections)
  t('名字取到了', got.name === '母亲', got.name)
  t('自述进人设', got.text.includes('纱厂'), got.text)
  t('口癖进人设', got.text.includes('我跟你说'), got.text)
  t('边界（不会说的话）进人设', got.text.includes('不会说'), got.text)
  t('创作者备注不进人设', !got.text.includes('作者随手记'), got.text)
  t('太长的会截断', tavern.personaFromCard({ name: 'x' }, [{ title: '自述', body: '啊'.repeat(9000) }]).text.length <= tavern.MAX_PERSONA_CHARS + 1)
  t('开场白单独取出来', tavern.greetingOf(sections) === '你来了？饭在锅里。', tavern.greetingOf(sections))
  t('没写开场白就返回空串', tavern.greetingOf([{ title: '自述', body: '只有自述' }]) === '')
  t('占位符不算开场白', tavern.greetingOf([{ title: '开场白', body: '_（还没写）_' }]) === '')
}

console.log('\n=== 4. 世界书：常驻的每轮都带，别的按关键词 ===')
{
  const entries = [
    { content: '这里一年下八个月雨。', constant: true },
    { keys: ['王城', '白银之城'], content: '王城阿斯特兰在河湾上。' },
    { keys: '码头，船', content: '码头只在退潮时能靠船。' },
    { keys: ['矿'], content: '矿上早就不出煤了。' },
  ]
  const hit = tavern.pickWorldEntries(entries, '我们到了王城的门口')
  t('常驻条目总在', hit.some((x) => x.includes('八个月雨')), hit)
  t('命中关键词的条目在', hit.some((x) => x.includes('阿斯特兰')), hit)
  t('没命中的条目不带', !hit.some((x) => x.includes('退潮')), hit)
  const hit2 = tavern.pickWorldEntries(entries, '去码头看看')
  t('逗号串的 keys 也认', hit2.some((x) => x.includes('退潮')), hit2)
  const empty = tavern.pickWorldEntries(entries, '')
  t('什么都没说的时候只带常驻的', empty.length === 1 && empty[0].includes('八个月雨'), empty)
  const many = tavern.pickWorldEntries(
    Array.from({ length: 30 }, (_, i) => ({ content: `第${i}条`.padEnd(400, '啊'), constant: true })),
    '',
  )
  t('合起来不超过上限', many.join('').length <= tavern.MAX_WORLD_CHARS, many.join('').length)
}

console.log('\n=== 5. 给模型的话：演法约束必须写进去 ===')
{
  const system = tavern.buildRoleplaySystem({ cardName: '张三', persona: '【自述】厂里退休的钳工。', worldNotes: ['这里一年下八个月雨。'] })
  t('说明了只演一个人', system.includes('只演「张三」'), system.slice(0, 120))
  t('不许替「我」说话', system.includes('不替「我」说话'), '')
  t('不许跳出角色加注释', system.includes('旁白'), '')
  t('不写名字前缀', system.includes('不要写「张三：」'), '')
  t('世界书带进去了', system.includes('八个月雨'), '')
  const first = tavern.buildRoleplayUser({ cardName: '张三', turns: [] })
  t('没有历史时请 TA 先说', first.includes('先说'), first)
  const next = tavern.buildRoleplayUser({ cardName: '张三', turns: [{ who: '我', text: '在吗' }, { who: '张三', text: '在。' }] })
  t('有历史时把对话带上', next.includes('我：在吗') && next.includes('张三：在。'), next)
  t('最后那句是「轮到张三」', next.includes('轮到「张三」'), next)
}

console.log('\n=== 6. 路由：开一场、说一句 ===')
{
  const fakeLlm = {
    listProviders: async () => [{ provider: 'raccoon', models: [{ id: 'sn-deepseek-v4-1-flash-1017' }] }],
    listModels: async () => [],
    stream: async () => (async function* () {
      yield { type: 'text-delta', text: '张三：我在的。\n你坐。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
  const ctx = {
    webServer: { register: () => () => {} },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
    get: (name) => (name === 'llm' ? fakeLlm : undefined),
  }
  const table = api.buildApi(ctx, async () => ws, { workspace: ws })

  // 造一张有开场白的卡
  const card = {
    lifecard: '0.1', id: 'zhang-san', kind: 'fictional', world: 'reality', name: '张三',
  }
  await store.writeCard(ws, 'people/zhang-san.card.md', card, [
    { title: '自述', body: '厂里退休的钳工，手很稳。' },
    { title: '开场白', body: '来了？自己找地方坐。' },
  ])

  const started = await table['tavern.start']({ card: 'people/zhang-san.card.md' })
  t('开得起来', started.ok === true, started)
  t('第一句是卡上的开场白', started.turns?.[0]?.text === '来了？自己找地方坐。', started.turns)
  t('第一句的说话人是卡名', started.turns?.[0]?.who === '张三', started.turns)
  t('存到 chats/ 里了', String(started.path).startsWith('chats/'), started.path)

  const said = await table['tavern.say']({ id: started.id, text: '我路过，进来看看。' })
  t('TA 回话了', said.ok === true, said)
  t('回话里削掉了「张三：」前缀', said.reply === '我在的。\n你坐。', said.reply)
  t('我那句也记下来了', said.turns.some((x) => x.text === '我路过，进来看看。'), said.turns)
  t('TA 那句也记下来了', said.turns.some((x) => x.who === '张三' && x.text.includes('你坐')), said.turns)

  const got = await table['tavern.get']({ id: started.id })
  t('再打开还是那几句', got.ok === true && (got.turns ?? []).length === 3, got.turns)

  const listed = await table['tavern.list']({})
  t('列表里能看到这一场', listed.ok === true && listed.items.some((x) => x.id === started.id), listed)

  const missing = await table['tavern.start']({ card: 'people/没有这个人.card.md' })
  t('找不到卡时说人话', missing.ok === false && /找不到/.test(String(missing.error)), missing)
  const noCard = await table['tavern.start']({})
  t('没挑人不能开始', noCard.ok === false, noCard)

  const gone = await table['tavern.delete']({ id: started.id })
  t('删得掉这一场', gone.ok === true, gone)
}

console.log('\n=== 7. TA 没回话时，我说的话不许丢 ===')
{
  const brokenLlm = {
    listProviders: async () => [{ provider: 'raccoon', models: [{ id: 'm' }] }],
    listModels: async () => [],
    stream: async () => { throw new Error('连不上') },
  }
  const ctx = {
    webServer: { register: () => () => {} },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
    get: (name) => (name === 'llm' ? brokenLlm : undefined),
  }
  const table = api.buildApi(ctx, async () => ws, { workspace: ws })
  await store.writeCard(ws, 'people/li-si.card.md', { lifecard: '0.1', id: 'li-si', kind: 'fictional', world: 'reality', name: '李四' }, [
    { title: '自述', body: '开出租的。' },
  ])
  const started = await table['tavern.start']({ card: 'people/li-si.card.md' })
  t('没有开场白也能开', started.ok === true && started.turns.length === 0, started)

  const said = await table['tavern.say']({ id: started.id, text: '师傅，去火车站。' })
  t('回不上话要如实说', said.ok === false && /没接上话/.test(String(said.error ?? '')), said)
  const got = await table['tavern.get']({ id: started.id })
  t('我说那句已经存下来了', (got.turns ?? []).some((x) => x.text === '师傅，去火车站。'), got.turns)

  // 没配模型时也不许抛
  const bare = api.buildApi({ get: () => undefined }, async () => ws, {})
  const again = await bare['tavern.say']({ id: started.id, text: '喂？' })
  t('没模型时返回人话', again.ok === false && typeof again.error === 'string' && again.error !== '', again)

  // 太长就该收尾，而不是继续往后堆
  const longTurns = Array.from({ length: tavern.MAX_TURNS + 1 }, () => ({ who: '我', text: '嗯' }))
  await tavern.writeChat(ws, 'chat-long', { id: 'chat-long', card: '', card_name: '某人' }, longTurns)
  const tooLong = await bare['tavern.say']({ id: 'chat-long', text: '还在吗' })
  t('太长的会话会拦住', tooLong.ok === false && /太长了/.test(String(tooLong.error ?? '')), tooLong)
}

console.log('\n=== 8. 收个尾：把前面发生过的事记下来，之后每轮都带上 ===')
{
  const lines = []
  let lastUser = ''
  const sumLlm = {
    listProviders: async () => [{ provider: 'raccoon', models: [{ id: 'm' }] }],
    listModels: async () => [],
    stream: async (opt) => {
      lastUser = JSON.stringify(opt ?? {})
      return (async function* () {
        yield { type: 'text-delta', text: '张三在门口遇到了我，两个人说起厂里倒闭的事，还没谈完。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const ctxSum = {
    webServer: { register: () => () => {} },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
    get: (name) => (name === 'llm' ? sumLlm : undefined),
  }
  const table = api.buildApi(ctxSum, async () => ws, { workspace: ws })
  await store.writeCard(ws, 'people/wang.card.md', { lifecard: '0.1', id: 'wang', kind: 'fictional', world: 'reality', name: '张三' }, [
    { title: '自述', body: '钳工。' },
  ])
  const started = await table['tavern.start']({ card: 'people/wang.card.md' })
  const id = started.id

  // 才两轮：不该收，且要说清为什么
  const early = await table['tavern.summarize']({ id })
  t('才说两句时先不收', early.ok === false && /先不急着收/.test(String(early.error)), early)

  // 补到够长
  const many = []
  for (let i = 0; i < 10; i++) many.push(i % 2 === 0 ? { who: '我', text: `第${i}句我说的话` } : { who: '张三', text: `第${i}句他说的话` })
  await tavern.writeChat(ws, id, { ...started, card_name: '张三' }, many)

  const done = await table['tavern.summarize']({ id })
  t('说够十句就能收', done.ok === true, done)
  t('收出来一段备忘', typeof done.summary === 'string' && done.summary.length > 0, done.summary)
  t('提示词里带着对话原文', lastUser.includes('第0句我说的话'), lastUser.slice(0, 200))
  t('提示词明说了不要评论、不要写成散文', lastUser.includes('不要评论'), lastUser.slice(0, 400))

  const back = await tavern.readChat(ws, id)
  const note = (back.notes ?? []).find((n) => n.title === tavern.MEMORY_TITLE)
  t('备忘写进了会话文件', note !== undefined, back.notes)
  t('备忘的小节标题叫「到这儿为止」', note?.title === '到这儿为止', note?.title)
  t('原来那些话一句没丢', (back.turns ?? []).length === many.length, (back.turns ?? []).length)

  // 收第二次：旧的那段要被换掉，不许叠成两段
  const again = await table['tavern.summarize']({ id })
  t('可以再收一次', again.ok === true, again)
  const back2 = await tavern.readChat(ws, id)
  t('再收一次不会叠成两段', (back2.notes ?? []).filter((n) => n.title === tavern.MEMORY_TITLE).length === 1, back2.notes)

  // 之后每轮的系统提示里要带上这段备忘
  let seenSystem = ''
  const sayLlm = {
    listProviders: async () => [{ provider: 'raccoon', models: [{ id: 'm' }] }],
    listModels: async () => [],
    stream: async (opt) => {
      seenSystem = String(opt?.system ?? opt?.messages?.map((m) => m.content).join('\n') ?? '')
      return (async function* () {
        yield { type: 'text-delta', text: '嗯。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const ctxSay = { ...ctxSum, get: (name) => (name === 'llm' ? sayLlm : undefined) }
  const table2 = api.buildApi(ctxSay, async () => ws, { workspace: ws })
  await table2['tavern.say']({ id, text: '接着说' })
  t('之后每一轮都把备忘带上了', seenSystem.includes('到这儿为止'), seenSystem.slice(0, 200))
  t('带的是备忘的内容', seenSystem.includes('厂里倒闭') || seenSystem.includes('还没谈完'), seenSystem.slice(0, 400))
  void lines
}

console.log('\n=== 8. 回话里带小标题不能把后面半场对话吃掉 ===')
{
  const turns = [
    { who: '我', text: '今晚下雪了吗？' },
    { who: '张三', text: '下了。\n\n## 天气\n\n雪下了一整天。\n\n### 她\n\n这句是她说的。' },
    { who: '我', text: '那她冷不冷。' },
  ]
  const data = { id: 'chat-head', card: 'people/zhang-san.card.md', card_name: '张三' }
  const text = tavern.renderChatMarkdown(data, turns)
  const back = tavern.parseChatText(text)
  t('读回来还是三条', back.ok === true && back.turns.length === 3, back.turns?.length)
  t('第三条没被当成备忘吞掉', back.turns?.[2]?.text === '那她冷不冷。', back.turns?.[2])
  t('说话人没被小标题串改', back.turns?.[1]?.who === '张三', back.turns?.[1])
  t('小标题原样留在正文里（用户看得见）', String(back.turns?.[1]?.text).includes('## 天气'), back.turns?.[1])
  t('备忘里没有混进对话', (back.notes ?? []).length === 0, back.notes)
}

console.log('\n=== 9. 「收个尾」收到的那段，下一句话之后还在 ===')
{
  const id = 'chat-mem'
  const many = []
  for (let n = 0; n < 5; n += 1) {
    many.push({ who: '我', text: `第 ${n} 句` })
    many.push({ who: '张三', text: `回第 ${n} 句` })
  }
  await tavern.writeChat(ws, id, { id, card: 'people/zhang-san.card.md', card_name: '张三', updated_at: '2026-10-24 20:00' }, many)
  const memLlm = {
    listProviders: async () => [{ provider: 'raccoon', models: [{ id: 'm' }] }],
    listModels: async () => [],
    stream: () => (async function* () {
      yield { type: 'text-delta', text: '厂子倒闭那年他还在那儿。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
  const ctxMem = {
    webServer: { register: () => () => {} },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
    get: (name) => (name === 'llm' ? memLlm : undefined),
  }
  const tableMem = api.buildApi(ctxMem, async () => ws, { workspace: ws })
  const sum = await tableMem['tavern.summarize']({ id })
  t('收尾成功', sum.ok === true, sum.error)
  const afterSum = await tavern.readChat(ws, id)
  t('备忘写进文件了', (afterSum.notes ?? []).some((x) => x.title === tavern.MEMORY_TITLE), afterSum.notes)
  await tableMem['tavern.say']({ id, text: '后来呢？' })
  const afterSay = await tavern.readChat(ws, id)
  t('再说一句之后备忘还在（以前这里会被静默摘掉）', (afterSay.notes ?? []).some((x) => x.title === tavern.MEMORY_TITLE), afterSay.notes)
  t('备忘的内容也还在', String((afterSay.notes ?? []).find((x) => x.title === tavern.MEMORY_TITLE)?.body ?? '').includes('倒闭'), afterSay.notes)
  t('文件里那一段字没被抹（用户拿 Finder 也能看见）', String(afterSay.text ?? '').includes(`## ${tavern.MEMORY_TITLE}`), String(afterSay.text).slice(0, 120))
}

console.log('\n=== 10. 太长了不收，但刚打的那句不能丢 ===')
{
  const id = 'chat-long'
  const many = []
  for (let n = 0; n < tavern.MAX_TURNS + 2; n += 1) many.push({ who: '我', text: `第 ${n} 句` })
  await tavern.writeChat(ws, id, { id, card: 'people/zhang-san.card.md', card_name: '张三' }, many)
  const tableLong = api.buildApi(makeCtx(() => '嗯。'), async () => ws, { workspace: ws })
  const r = await tableLong['tavern.say']({ id, text: '最后这句' })
  t('太长了会拒绝并说清为什么', r.ok === false && String(r.error).includes('太长'), r.error)
  const back = await tavern.readChat(ws, id)
  t('刚打的那句已经落盘（界面照显的东西刷新之后还在）', (back.turns ?? []).some((x) => x.text === '最后这句'), (back.turns ?? []).length)
}

console.log('\n=== 11. 同时点两次发送不会丢一轮 ===')
{
  const id = 'chat-race'
  await tavern.writeChat(ws, id, { id, card: 'people/zhang-san.card.md', card_name: '张三' }, [])
  const tableRace = api.buildApi(makeCtx(() => '嗯。'), async () => ws, { workspace: ws })
  await Promise.all([
    tableRace['tavern.say']({ id, text: '第一句' }),
    tableRace['tavern.say']({ id, text: '第二句' }),
  ])
  const back = await tavern.readChat(ws, id)
  const texts = (back.turns ?? []).map((x) => x.text)
  t('两句都在（以前后写的那次会以旧内容为基础把前一句吞掉）', texts.includes('第一句') && texts.includes('第二句'), texts)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
