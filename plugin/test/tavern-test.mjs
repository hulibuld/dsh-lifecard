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
  t('会话 id 带日期和时分', /^chat-20261024-1611-[a-z0-9]{6}$/.test(id), id)
  // 随机那截从 4 位加到 6 位，是因为撞过：同一分钟里连开两场，writeChat 整文件
  // 覆盖，新的一场直接把上一场吃掉。这里钉住位数，改回去就会红。
  const fixed = tavern.newChatId(new Date('2026-10-24T16:11:00'), 'abcdef')
  t('随机的字节能钉住（测试用）', fixed === 'chat-20261024-1611-abcdef', fixed)

  // 撞车复现：先占掉一个名字，再造名字时不能把它给你。
  // 这一条是真会丢数据的那个场景——同一分钟里连开两场。
  const taken = tavern.newChatId(new Date('2026-10-24T16:11:00'), 'aaaaaa')
  await tavern.writeChat(ws, taken, { id: taken, card_name: '张三' }, [{ who: '我', text: '先来的这一场' }])
  const fresh = await tavern.uniqueChatId(ws, new Date('2026-10-24T16:11:00'))
  t('给新会话的 id 不会撞上已有的', fresh !== taken, { taken, fresh })
  const still = await tavern.readChat(ws, taken)
  t('已有的那一场一个字都没被动过', still.ok === true && still.turns?.[0]?.text === '先来的这一场', still.turns)
  await tavern.deleteChat(ws, taken)

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
  // 截断分两档，这一条管的是「正常人物卡」那一档：有性格/外貌/口癖这些细节的，
  // 三千字够用，贴太多会把世界书和记忆挤掉。
  t('正常人物卡贴到三千字就停', tavern.personaFromCard({ name: 'x' }, [
    { title: '自述', body: '啊'.repeat(9000) },
    { title: '性格', body: '话少。' },
  ]).text.length <= tavern.MAX_PERSONA_CHARS + 1)
  // 另一档：提示词型卡（只有自述、没有人物细节）。这种卡的正文就是硬规则，
  // 核心指令散在全篇，截到三千字等于没下这张卡——用户那张实卡就是这么被废掉的。
  const promptOnly = tavern.personaFromCard({ name: 'x' }, [{ title: '自述', body: '啊'.repeat(9000) }])
  t('提示词型卡不会被三千字砍断', promptOnly.text.length > tavern.MAX_PERSONA_CHARS, String(promptOnly.text.length))
  t('提示词型卡也有上限', promptOnly.text.length <= tavern.MAX_PROMPT_PERSONA_CHARS + 1, String(promptOnly.text.length))
  // 提示词型卡（只有自述、自述很长、没有人物细节）：正文是给人的硬规则，
  // 包上「【自述】」抬头就变成「有个人，他的自述是一串命令」，模型会先认出
  // 这是提示词再评论它。所以这一类卡原样贴，不包任何标题。
  const promptCard = tavern.personaFromCard({ name: '破甲' }, [{ title: '自述', body: 'MANDATORY!\n' + '以第一人称说话。'.repeat(500) }])
  t('提示词型卡认出来了', promptCard.promptStyle === true, String(promptCard.promptStyle))
  t('提示词型卡不包小节标题', !promptCard.text.includes('【自述】'), promptCard.text.slice(0, 60))
  t('提示词型卡正文原样保留', promptCard.text.startsWith('MANDATORY!'), promptCard.text.slice(0, 40))
  // 正常人物卡还是要包标题：那是「一个人的自述」，标题帮模型分清哪段是什么。
  t('正常人物卡照旧包标题', got.text.includes('【自述】'), got.text.slice(0, 40))
  // 提示词型卡的系统提示只留三条底线。通用那九条（一次回 1 到 3 段、不写旁白）
  // 会和卡上的硬规则打架，模型在两条矛盾的要求之间会挑一条执行、
  // 然后顺手把另一条当成「有人在管我」的证据——用户看到的就是「它不听话了」。
  const promptSys = tavern.buildRoleplaySystem({ cardName: '破甲', persona: promptCard.text, promptStyle: true })
  t('提示词型卡只留三条底线', promptSys.includes('【三条底线】') && !promptSys.includes('【怎么说话】'), promptSys.slice(0, 200))
  t('三条底线里还是不许替「我」说话', promptSys.includes('不替「我」说话'))
  t('提示词型卡不提「一次回 1 到 3 段」', !promptSys.includes('一次回 1 到 3 段'))
  t('提示词型卡仍然带思考要求', promptSys.includes('【想的时候也一样】'))
  t('正常人物卡还是九条', tavern.buildRoleplaySystem({ cardName: '张三', persona: '一个纱厂女工' }).includes('【怎么说话】'))
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
  // 这一条以前断言的是「只演「张三」」。那句话本身是把模型放在扮演者位置上，
  // 用户报的「演到一半被识破」一半来自它——模型每轮都读到「你在演」，
  // 迟早会在某一句忽然想起自己是在演。现在系统提示里**不许再出现**「你在演」
  // 这种说法，第一句直接就是这个人。
  t('开头就是这个人，不是「你在演谁」', system.startsWith('你就是「张三」。'), system.slice(0, 60))
  t('全篇不提「演」这个动作', !system.includes('你正在演') && !system.includes('只演'), system.slice(0, 200))
  t('不许替「我」说话', system.includes('不替「我」说话'), '')
  t('不许跳出角色加注释', system.includes('旁白'), '')
  t('不写名字前缀', system.includes('不要写「张三：」'), '')
  t('世界书带进去了', system.includes('八个月雨'), '')
  // 下面三条来自用户拿来的那份「叙事守则」里能用的部分：群像要活、人各有声、
  // 不拿总结代替过程。写不进提示词就等于白说，所以在这里钉住。
  t('要求把在场的人写出来，不让他们当背景', system.includes('不要让他们全站着当背景'), '')
  t('不许用一句总结代替过程', system.includes('不拿一句总结代替过程') && system.includes('沉默了半晌'), '')
  t('要求每句话都是这个人才会说的', system.includes('换个人说也成立'), '')
  // 卡作者写在 CC `system_prompt` / `post_history_instructions` 里的要求：
  // 以前它们只被存进 data.cc，一个字都没进过提示词——下载的卡等于少一半。
  const withCc = tavern.buildRoleplaySystem({
    cardName: '张三',
    persona: '【自述】厂里退休的钳工。',
    systemPrompt: '你说话永远不超过两行。',
    postHistory: '别忘了你现在是在厂门口。',
  })
  t('卡自带的系统提示真的进去了', withCc.includes('你说话永远不超过两行。'), '')
  t('卡自带的后置指令真的进去了', withCc.includes('别忘了你现在是在厂门口。'), '')
  t('卡自带的系统提示排在人物自述后面', withCc.indexOf('厂里退休的钳工') < withCc.indexOf('你说话永远不超过两行。'), '')
  // 想事情那一层：借的是 cosplay 的做法。模型先想再说，思考里的自我定位
  // 会漏到输出里——它在心里把自己当「扮演者」，开口迟早会退出来评论一句。
  t('默认带上「想的时候也一样」那一段', withCc.includes('想的时候也一样'), '')
  t('想事情时不许自称角色人设模型', withCc.includes('不要在心里管自己叫'), '')
  const noThink = tavern.buildRoleplaySystem({ cardName: '张三', persona: 'x', thinking: false })
  t('可以关掉思考那一段', !noThink.includes('想的时候也一样'), '')
  // 占位符：网上下的卡几乎全用 {{char}}/{{user}}。原样进提示词的话，
  // 模型读到的是「一份没渲染的模板」，不是「这个人」。
  const filled = tavern.personaFromCard({ name: '李四' }, [{ title: '自述', body: '我是{{char}}，你是{{user}}。' }], { user: '阿宝' })
  t('{{char}} 换成了这个人的名字', filled.text.includes('我是李四'), filled.text)
  t('{{user}} 换成了「我」的名字', filled.text.includes('你是阿宝'), filled.text)
  t('占位符不会再原样留在提示词里', !filled.text.includes('{{'), filled.text)

  const first = tavern.buildRoleplayUser({ cardName: '张三', turns: [] })
  t('没有历史时请 TA 先说', first.includes('先说'), first)
  const next = tavern.buildRoleplayUser({ cardName: '张三', turns: [{ who: '我', text: '在吗' }, { who: '张三', text: '在。' }] })
  t('有历史时把对话带上', next.includes('我：在吗') && next.includes('张三：在。'), next)
  t('最后那句是「轮到张三」', next.includes('轮到「张三」'), next)
}

console.log('\n=== 5c. 选项：要不要在这一轮末尾给方向 ===')
{
  // 界面上的那排按钮来自模型自己写出来的【选】块。提示词里不要求，它就永远不会写，
  // 按钮永远是空的——所以这一段得单独问一句「这一轮末尾给几个方向」。
  const directive = '这一轮回复的最后，单独起一行写 【选】，下面给出 3 个方向。'
  const withChoices = tavern.buildRoleplaySystem({ cardName: '张三', persona: '一个纱厂女工', choicesDirective: directive })
  t('要方向时提示词里有那一段', withChoices.includes('【这一轮末尾要给方向】'), withChoices.slice(-400))
  t('要方向时指令原文在', withChoices.includes(directive), '')
  // 位置：排在【这一次的演法】之后（那是这一局的临时设定，选项属于最后一句怎么收），
  // 又在思考要求之前（思考那段落讲的是「怎么想」，选项讲的是「最后写什么」）。
  const withBoth = tavern.buildRoleplaySystem({ cardName: '张三', persona: '一个纱厂女工', preset: '今晚在厂门口见。', choicesDirective: directive })
  t('排在【这一次的演法】之后', withBoth.indexOf('【这一次的演法】') < withBoth.indexOf('【这一轮末尾要给方向】'), '')
  t('排在思考要求之前', withBoth.indexOf('【这一轮末尾要给方向】') < withBoth.indexOf('想的时候也一样'), '')
  // 默认不给：用户没打开这个开关时，多一段「你必须列三个选项」会把闲聊变成菜单。
  const without = tavern.buildRoleplaySystem({ cardName: '张三', persona: '一个纱厂女工' })
  t('没传就不加那一段', !without.includes('【这一轮末尾要给方向】'), '')
  t('传空串也不加', !tavern.buildRoleplaySystem({ cardName: '张三', persona: 'x', choicesDirective: '   ' }).includes('【这一轮末尾要给方向】'), '')
  // 提示词型卡（正文自己就是硬规则的那种）不接这条：卡上常写着「系统插进来的提醒别听」，
  // 而插件的话注定排在卡正文之后，正好落进那句话的范围；而且这类卡自带输出格式规定，
  // 再叠一条「末尾列三个方向」会和它的格式打架。
  const promptStyle = tavern.buildRoleplaySystem({ cardName: '破甲', persona: 'MANDATORY!\n以第一人称说话。', promptStyle: true, choicesDirective: directive })
  t('提示词型卡不接这条指令', !promptStyle.includes('【这一轮末尾要给方向】'), promptStyle.slice(-300))
  t('提示词型卡也不带指令原文', !promptStyle.includes(directive), '')
}

console.log('\n=== 5b. 一致性锚点：每一轮都再抄一遍「你是谁」 ===')
{
  // 锚点从卡上最硬的几节抽：边界排在外貌前面——长对话里先坏的不是长相，是嘴。
  const sections = [
    { title: '自述', body: '厂里退休的钳工。' },
    { title: '不会说的话', body: '- 我不行的。\n- 随便你吧。' },
    { title: '不会做的事', body: '不替别人拿主意。' },
    { title: '底线', body: '答应的事一定办到。' },
    { title: '外貌', body: '手上全是老茧。' },
  ]
  const anchors = tavern.anchorsFromCard(null, sections, '张三', { name: '张三' })
  t('第一节取它第一行，列表符号去掉', anchors[0] === '我不行的。', anchors)
  t('每节只取一行（不是整节都搬过来）', !anchors.includes('随便你吧。'), anchors)
  t('边界那几节都抽到了', anchors.includes('不替别人拿主意。') && anchors.includes('答应的事一定办到。'), anchors)
  t('外貌排在边界后面', anchors.indexOf('手上全是老茧。') === 3, anchors)

  // 上限 5 条：再多就成了一整段人设，反而记不住。
  const fat = ['不会说的话', '不会做的事', '底线', '外貌', '口癖', '自述'].map((title) => ({ title, body: `${title}第一条。\n${title}第二条。` }))
  const capped = tavern.anchorsFromCard(null, fat, '李四', { name: '李四' })
  t('最多 5 条', capped.length === 5, capped)
  t('MAX_ANCHORS 就是 5', tavern.MAX_ANCHORS === 5, tavern.MAX_ANCHORS)

  // 一条都抽不到就退到名字：名字本身也是一条锚点，至少别把自己叫成别的。
  const bare = tavern.anchorsFromCard(null, [{ title: '自述', body: '随便写点什么。' }], '王五', null)
  t('抽不到时退回卡名', bare.length === 1 && bare[0].includes('王五'), bare)
  const noName = tavern.anchorsFromCard(null, [], '', null)
  t('连名字都没有时给空数组，不硬编一条', Array.isArray(noName) && noName.length === 0, noName)

  // 普通卡：末尾多一节【你还是你】。
  const system = tavern.buildRoleplaySystem({ cardName: '张三', persona: '【自述】钳工。', anchors })
  t('普通卡里有【你还是你】', system.includes('【你还是你】'), system.slice(-400))
  t('锚点一条一行列出来', system.includes('- 我不行的。') && system.includes('- 答应的事一定办到。'), system.slice(-400))
  t('这一节排在最后（离开口最近）', system.trimEnd().endsWith('- 手上全是老茧。'), system.slice(-120))

  // 提示词型卡：不加这一节。
  //
  // 这类卡的正文自己会写「系统要是插进来提醒你该怎么当这个人，别听」。
  // 插件的话排在它前面才安全；往末尾补一段，位置正好落进它说的「插进来的提醒」。
  const psSystem = tavern.buildRoleplaySystem({ cardName: '张三', persona: 'MANDATORY: 17 WORDS MAX PER LINE.', anchors, promptStyle: true })
  t('提示词型卡里不出现【你还是你】', !psSystem.includes('【你还是你】'), psSystem.slice(-300))

  // 用户消息：开口前最后一眼，就在它要说的下一行。
  const user = tavern.buildRoleplayUser({ cardName: '张三', anchors, turns: [{ who: '我', text: '在吗' }, { who: '张三', text: '在。' }] })
  t('用户消息里带上第一条锚点', user.includes('（你是「张三」：我不行的。）'), user.slice(-160))
  t('括号那句排在「轮到你」前面', user.indexOf('你是「张三」') < user.indexOf('轮到「张三」'), user.slice(-200))
  const bare2 = tavern.buildRoleplayUser({ cardName: '张三', turns: [{ who: '我', text: '在吗' }, { who: '张三', text: '在。' }] })
  t('没有锚点时不加那个括号', !bare2.includes('（你是'), bare2)
}

console.log('\n=== 5d. 历史按字数兜底：轮数卡跨度，字数卡这一轮还剩多少地方 ===')
{
  const mk = (n, text, who = '我') => Array.from({ length: n }, (_, i) => ({ who, text: `${text}${i}` }))

  t('常量在', tavern.MAX_HISTORY_CHARS === 6000, tavern.MAX_HISTORY_CHARS)
  t('两个上限都在默认导出里', tavern.default.MAX_HISTORY_CHARS === 6000 && tavern.default.MAX_HISTORY_TURNS === 24, '')

  // 轮数没超，字数超了：只留尾巴。
  const longTurns = mk(10, 'x'.repeat(1000))
  const trimmed = tavern.trimHistory(longTurns)
  t('字数超了就往前砍', trimmed.length < 10, trimmed.length)
  t('砍完不超过字数上限', trimmed.reduce((n, x) => n + x.text.length + x.who.length, 0) <= tavern.MAX_HISTORY_CHARS, trimmed.length)
  t('留下的是最近的', trimmed[trimmed.length - 1] === longTurns[longTurns.length - 1], '')
  t('留下的顺序没乱', trimmed[0] === longTurns[longTurns.length - trimmed.length], '')

  // 字数没超，轮数超了：还是按轮数砍。
  const manyShort = mk(50, '嗯')
  const byTurns = tavern.trimHistory(manyShort)
  t('轮数上限照样管用', byTurns.length === tavern.MAX_HISTORY_TURNS, byTurns.length)
  t('按轮数砍也留最近的', byTurns[byTurns.length - 1] === manyShort[49], '')

  // 至少留一条：哪怕这一条自己就超了。
  const oneHuge = [{ who: '我', text: 'y'.repeat(20000) }]
  const kept = tavern.trimHistory(oneHuge)
  t('最后一条自己就超了也留着', kept.length === 1 && kept[0] === oneHuge[0], kept.length)
  const hugeTail = [...mk(5, '短'), { who: '我', text: 'z'.repeat(9000) }]
  const kept2 = tavern.trimHistory(hugeTail)
  t('超长的那条在、前面的短句被砍光', kept2.length === 1 && kept2[0].text.length === 9000, kept2.length)

  // 说话人的名字也占字数。
  const nameHeavy = Array.from({ length: 10 }, (_, i) => ({ who: `第${i}位` + '某'.repeat(700), text: '啊' }))
  const byName = tavern.trimHistory(nameHeavy)
  t('名字算进字数里', byName.length < 10, byName.length)

  // options 能改两个上限。
  const custom = tavern.trimHistory(mk(10, 'x'.repeat(100)), { maxTurns: 3, maxChars: 100000 })
  t('maxTurns 能改', custom.length === 3, custom.length)
  const customChars = tavern.trimHistory(mk(10, 'x'.repeat(100)), { maxChars: 500 })
  t('maxChars 能改', customChars.length === 4, customChars.length)

  t('空数组给空数组', tavern.trimHistory([]).length === 0, '')
  t('传 null 不炸', tavern.trimHistory(null).length === 0, '')
  t('传非数组不炸', tavern.trimHistory('不是数组').length === 0, '')

  // buildRoleplayUser 真的走了这条路：长历史不再原样塞进去。
  const built = tavern.buildRoleplayUser({ cardName: '张三', turns: longTurns })
  t('拼出来的话里没有全部十条', (built.match(/x{1000}/g) ?? []).length < 10, (built.match(/x{1000}/g) ?? []).length)
  const stillTail = tavern.buildRoleplayUser({ cardName: '张三', turns: mk(3, '在吗') })
  t('短历史照样全带上', stillTail.includes('在吗2') && stillTail.includes('在吗0'), stillTail)
}

console.log('\n=== 5e. 收尾时机的软提示 ===')
{
  t('常量是 8', tavern.MIN_TURNS_TO_SUMMARIZE === 8, tavern.MIN_TURNS_TO_SUMMARIZE)
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ who: i % 2 === 0 ? '我' : '张三', text: '嗯' }))
  t('空的一律不提', tavern.summarizeHint([]) === '', tavern.summarizeHint([]))
  t('7 句还不提', tavern.summarizeHint(mk(7)) === '', tavern.summarizeHint(mk(7)))
  t('8 句也不提', tavern.summarizeHint(mk(8)) === '', tavern.summarizeHint(mk(8)))
  t('36 句（刚好 1.5 倍）也不提', tavern.summarizeHint(mk(36)) === '', tavern.summarizeHint(mk(36)))
  const hint = tavern.summarizeHint(mk(42))
  t('37 句往上才提', hint.length > 0, hint)
  t('说清了现在多少句', hint.includes('42'), hint)
  t('说的是人话', !/状态机|枚举|字段/.test(hint), hint)
  t('不出现「请」和「建议您」', !/请|建议您/.test(hint), hint)
  t('传 null 不炸', tavern.summarizeHint(null) === '', '')
  t('默认导出里有', tavern.default.summarizeHint === tavern.summarizeHint, '')
  t('默认导出里有 trimHistory', tavern.default.trimHistory === tavern.trimHistory, '')
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

console.log('\n=== 6b. 回复里的选项块：剥出来给界面，别写进会话文件 ===')
{
  // 模型按提示词的要求在末尾写了【选】。这个块是给这一轮按钮用的，不是 TA 说过的话。
  // 要是原样落盘，下一轮它会作为「张三说过的话」被读回去，模型于是开始学自己给自己
  // 列选项，正文越写越像菜单。
  const choicesLlm = {
    listProviders: async () => [{ provider: 'raccoon', models: [{ id: 'm' }] }],
    listModels: async () => [],
    stream: async () => (async function* () {
      yield { type: 'text-delta', text: '张三：雨还在下。\n\n【选】\n- 把伞递过去\n- 转身走\n- 站着不动' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
  const choicesCtx = {
    webServer: { register: () => () => {} },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
    get: (name) => (name === 'llm' ? choicesLlm : undefined),
  }
  const table = api.buildApi(choicesCtx, async () => ws, { workspace: ws })
  await store.writeCard(ws, 'people/wang-wu.card.md', { lifecard: '0.1', id: 'wang-wu', kind: 'fictional', world: 'reality', name: '王五' }, [
    { title: '自述', body: '修伞的。' },
  ])
  const started = await table['tavern.start']({ card: 'people/wang-wu.card.md' })
  const said = await table['tavern.say']({ id: started.id, text: '外面雨大。' })
  t('回话照常成功', said.ok === true, said)
  t('正文里没有【选】', !String(said.reply).includes('【选】'), said.reply)
  t('正文留着前面的台词', String(said.reply).includes('雨还在下'), said.reply)
  t('三条方向单独交出来', Array.isArray(said.choices) && said.choices.length === 3, said.choices)
  t('方向文本对得上', (said.choices ?? []).map((c) => c.text).join('|') === '把伞递过去|转身走|站着不动', said.choices)

  const got = await table['tavern.get']({ id: started.id })
  const stored = (got.turns ?? []).filter((x) => x.who === '王五').map((x) => String(x.text)).join('\n')
  t('落盘的正文里也没有【选】', !stored.includes('【选】'), stored)
  t('落盘的正文里没有那三行方向', !stored.includes('把伞递过去'), stored)
  t('落盘的正文留着台词', stored.includes('雨还在下'), stored)

  // 没写【选】的时候一个字都不许动。TA 答两行短台词本来就长这样，
  // 按「末尾刚好是短列表」剪掉，用户会看到 TA 一个字都没说。
  const plainLlm = {
    listProviders: async () => [{ provider: 'raccoon', models: [{ id: 'm' }] }],
    listModels: async () => [],
    stream: async () => (async function* () {
      yield { type: 'text-delta', text: '- 「雨还没停，站着吧。」\n- 「伞我不要。」' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
  const plain = api.buildApi({ ...choicesCtx, get: (name) => (name === 'llm' ? plainLlm : undefined) }, async () => ws, { workspace: ws })
  const started2 = await plain['tavern.start']({ card: 'people/wang-wu.card.md' })
  const said2 = await plain['tavern.say']({ id: started2.id, text: '下雨了。' })
  t('没标记时两行短台词原样留着', String(said2.reply).includes('伞我不要'), said2.reply)
  t('没标记时不给方向', Array.isArray(said2.choices) && said2.choices.length === 0, said2.choices)
  await plain['tavern.delete']({ id: started2.id })
  await table['tavern.delete']({ id: started.id })
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

console.log('\n=== 12. 世界书：被带出来的一层，以及塞不下的跳过 ===')
{
  const entries = [
    { content: '这座城靠煤矿活着。', constant: true },
    { keys: ['矿'], content: '矿上三班倒。' },
    { keys: ['三班'], content: '三班倒的人半夜下井。' },
    { keys: ['半夜'], content: '半夜的井口只有一盏灯。' },
  ]
  const picked = tavern.pickWorldEntries(entries, '我想去矿上看看')
  t('常驻的那条带上了', picked.includes('这座城靠煤矿活着。'), picked)
  t('直接命中的那条带上了', picked.includes('矿上三班倒。'), picked)
  t('被带出来的第二层也带上了', picked.includes('三班倒的人半夜下井。'), picked)
  t('没有无限往外扩（第三层没带）', !picked.includes('半夜的井口只有一盏灯。'), picked)
  const quiet = tavern.pickWorldEntries(entries, '')
  t('刚开场只带常驻，不带关键词条目', quiet.length === 1 && quiet[0] === '这座城靠煤矿活着。', quiet)
  const long = { keys: ['甲'], content: '这是一条很长很长的设定，长到预算放不下它。' }
  const short = { keys: ['甲'], content: '短的。' }
  const tight = tavern.pickWorldEntries([long, short], '甲', { budget: 10 })
  t('塞不下的跳过，后面更短的还能进来', tight.length === 1 && tight[0] === '短的。', tight)
}

console.log('\n=== 13. 重来一次，以及从中间掰一条新的世界线 ===')
{
  const id = 'chat-branch'
  const turns = [
    { who: '我', text: '第一句' },
    { who: '张三', text: '第一回' },
    { who: '我', text: '第二句' },
    { who: '张三', text: '第二回' },
  ]
  await tavern.writeChat(ws, id, { id, card: 'people/zhang-san.card.md', card_name: '张三' }, turns)
  t('重来一次只摘掉 TA 那句', tavern.dropTrailingReply(turns).map((x) => x.text).join('/') === '第一句/第一回/第二句', tavern.dropTrailingReply(turns))

  const table = api.buildApi(makeCtx(() => '重来的一回'), async () => ws, { workspace: ws })
  const regen = await table['tavern.regenerate']({ id })
  t('重来一次成功了', regen.ok === true, regen.error)
  const afterRegen = await tavern.readChat(ws, id)
  t('上一句 TA 说的已经摘掉', (afterRegen.turns ?? []).map((x) => x.text).join('/') === '第一句/第一回/第二句', afterRegen.turns)
  const again = await table['tavern.say']({ id, text: '' })
  t('接着让 TA 重说一句', again.ok === true && String(again.reply).includes('重来的一回'), again)
  const afterAgain = await tavern.readChat(ws, id)
  t('新的一句已经落盘', (afterAgain.turns ?? []).length === 4, (afterAgain.turns ?? []).length)

  const before = String((await tavern.readChat(ws, id)).text ?? '')
  const branched = await table['tavern.branch']({ id, at: 1 })
  t('掰出来一场新的', branched.ok === true && branched.id !== id, branched)
  t('新的一场只有前两句', (branched.turns ?? []).length === 2, branched.turns)
  const born = await tavern.readChat(ws, branched.id)
  t('新的一场记着从哪儿来', String(born.data?.branched_from ?? '') === id, born.data)
  const after = String((await tavern.readChat(ws, id)).text ?? '')
  t('原会话一个字节都没动', after === before, { same: after === before })

  t('掰的位置给大了就夹到最后一句', tavern.branchTurns(turns, 999).length === 4, tavern.branchTurns(turns, 999).length)
  t('掰的位置给 0 时至少留第一句', tavern.branchTurns(turns, 0).length === 1, tavern.branchTurns(turns, 0).length)

  const emptyId = 'chat-empty'
  await tavern.writeChat(ws, emptyId, { id: emptyId, card_name: '张三' }, [])
  const noBranch = await table['tavern.branch']({ id: emptyId })
  t('空会话掰不出来，并说明原因', noBranch.ok === false && String(noBranch.error).includes('还没有话'), noBranch)
}

console.log('')
console.log('=== 14. 流式：一段一段往外递，最后仍然是完整一句 ===')
{
  const pieces = []
  const splitLlm = {
    listProviders: async () => [{ provider: 'raccoon', models: [{ id: 'm' }] }],
    listModels: async () => [],
    stream: () => (async function* () {
      yield { type: 'text-delta', text: '一句' }
      yield { type: 'reasoning-delta', text: '（想的那一段）' }
      yield { type: 'text-delta', text: '一句' }
      yield { type: 'text-delta', text: '地来' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
  const ctx = {
    webServer: { register: () => () => {} },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
    get: (name) => (name === 'llm' ? splitLlm : undefined),
  }

  // 老调用点是两参，必须一点不变地拿到整句。
  const plain = await api.callModel(ctx, { system: 's', user: 'u' })
  t('没人接的时候照旧给整句', plain.ok === true && plain.text === '一句一句地来', plain)

  const called = await api.callModel(ctx, { system: 's', user: 'u' }, { onDelta: (piece) => pieces.push(piece) })
  t('接的时候整体结果还是那一句', called.ok === true && called.text === '一句一句地来', called)
  t('一段一段都递出来了', pieces.join('') === '一句一句地来', pieces)
  t('模型心里想的那一段没有混进回答', !String(called.text ?? '').includes('想的那一段'), called.text)

  const id = 'chat-stream'
  await tavern.writeChat(ws, id, { id, card: 'people/zhang-san.card.md', card_name: '张三' }, [{ who: '我', text: '说吧' }])
  const table = api.buildApi(ctx, async () => ws, { workspace: ws })
  const seen = []
  const said = await table['tavern.say']({ id, text: '' }, { onDelta: (piece) => seen.push(piece) })
  t('酒馆那条路由也能一段一段递', seen.join('') === '一句一句地来', seen)
  t('整句照样落盘（屏幕上看见不等于存下来了）', said.ok === true && (said.turns ?? []).some((x) => String(x.text).includes('一句一句地来')), said)

  // 已经开始吐字了就不能换路由重来：换一条会出现「半句 + 另半句」，
  // 而文件里存的还是另一条。宁可这一轮报错。
  let opened = 0
  const flakyLlm = {
    listProviders: async () => [
      { provider: 'raccoon', models: [{ id: 'm' }] },
      { provider: 'buddy', models: [{ id: 'm2' }] },
    ],
    listModels: async () => [],
    stream: () => {
      opened += 1
      if (opened > 1) {
        return (async function* () {
          yield { type: 'text-delta', text: '第二家的整句' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      }
      return (async function* () {
        yield { type: 'text-delta', text: '说到一半' }
        throw new Error('连接断了')
      })()
    },
  }
  const flakyCtx = { ...ctx, get: (name) => (name === 'llm' ? flakyLlm : undefined) }
  const dropped = await api.callModel(flakyCtx, { system: 's', user: 'u' }, { onDelta: () => {} })
  t('说到一半断了就报错，不换一家接着说', dropped.ok === false && String(dropped.error).includes('说到一半断了'), dropped)
  t('没有偷偷去开第二家的流', opened === 1, opened)
}

console.log('')
console.log('=== 15. 空场次：开了没说过话的，要能认出来 ===')
{
  const wrote = await tavern.writeChat(ws, 'chat-empty', { id: 'chat-empty', card: 'people/zhang-san.card.md', card_name: '张三' }, [])
  t('空会话写得进去', wrote.ok === true, wrote)
  const listed = await tavern.listChats(ws)
  const rows = Array.isArray(listed.items) ? listed.items : []
  const emptyRow = rows.find((x) => String(x.id) === 'chat-empty')
  t('空的那一场被标成「还没开始」', emptyRow?.empty === true, emptyRow)
  t('空的那一场句数是 0', Number(emptyRow?.turns ?? -1) === 0, emptyRow?.turns)
  await tavern.writeChat(ws, 'chat-empty', { id: 'chat-empty', card: 'people/zhang-san.card.md', card_name: '张三' }, [{ who: '我', text: '在吗' }])
  const again = await tavern.listChats(ws)
  const row2 = (Array.isArray(again.items) ? again.items : []).find((x) => String(x.id) === 'chat-empty')
  t('说过一句之后不再标成空的', row2?.empty === false, row2?.empty)
}

console.log(`\n${pass} passed, ${fail} failed`)

console.log('\n=== 5f. 思考两档：沉浸 / 中性 ===')
{
  // 以前只有「开 / 关」。关掉之后模型在思考里没有任何约束，于是回到
  // 「想着想着开始评论这段剧情」；开着那一档则是另一个毛病——某些模型会把
  // 括号内心戏漏进正文。两档互斥（借 cosplay 的写法）：同一处、同一段位，
  // 只换档位取值。默认还是沉浸。
  t('两档都在', Array.isArray(tavern.THINKING_STYLES) && tavern.THINKING_STYLES.join(',') === 'role,neutral', tavern.THINKING_STYLES)
  t('两档的正文不一样', tavern.THINKING_DIRECTIVES.role !== tavern.THINKING_DIRECTIVES.neutral, '')
  t('默认那一档还是老的那段', tavern.THINKING_DIRECTIVE === tavern.THINKING_DIRECTIVES.role, '')

  // 沉浸档要求第一人称想事；中性档逐条禁止同一批字面特征。
  t('沉浸档要求第一人称', tavern.THINKING_DIRECTIVES.role.includes('第一人称'), '')
  t('中性档禁止圆括号内心戏', tavern.THINKING_DIRECTIVES.neutral.includes('圆括号'), tavern.THINKING_DIRECTIVES.neutral)
  t('中性档也禁止「我心想」那类', tavern.THINKING_DIRECTIVES.neutral.includes('我暗自') || tavern.THINKING_DIRECTIVES.neutral.includes('我心里一沉'), tavern.THINKING_DIRECTIVES.neutral)
  t('中性档照样不许自称人设模型', tavern.THINKING_DIRECTIVES.neutral.includes('人设'), '')

  // `thinkingBlock`：关掉给空串，认不出退沉浸。
  t('关掉给空串', tavern.thinkingBlock(false, 'role') === '', '')
  t('关掉时中性档也给空串', tavern.thinkingBlock(false, 'neutral') === '', '')
  t('不给档位按沉浸', tavern.thinkingBlock(true, undefined) === tavern.THINKING_DIRECTIVES.role, '')
  t('认不出的档位退沉浸', tavern.thinkingBlock(true, 'wat') === tavern.THINKING_DIRECTIVES.role, '')
  t('给中性就用中性', tavern.thinkingBlock(true, 'neutral') === tavern.THINKING_DIRECTIVES.neutral, '')

  // 拼进系统提示的两条分支都要跟着档位走：普通人物卡（末尾一段）与
  // 提示词型卡（三条底线之后那段）。漏一条，那一类卡的用户就换不动档。
  const normal = tavern.buildRoleplaySystem({ cardName: '张三', persona: '一个纱厂女工', thinkingStyle: 'neutral' })
  t('普通卡按档位换', normal.includes(tavern.THINKING_DIRECTIVES.neutral) && !normal.includes('想的时候也一样'), normal.slice(-400))
  const prompt = tavern.buildRoleplaySystem({ cardName: '破甲', persona: 'MANDATORY!', promptStyle: true, thinkingStyle: 'neutral' })
  t('提示词型卡也按档位换', prompt.includes(tavern.THINKING_DIRECTIVES.neutral) && !prompt.includes('想的时候也一样'), prompt.slice(0, 500))
  // 不给档位时还是老样子（老调用点与老测试不该受影响）。
  const byDefault = tavern.buildRoleplaySystem({ cardName: '张三', persona: '一个纱厂女工' })
  t('不传档位还是沉浸', byDefault.includes('【想的时候也一样】'), byDefault.slice(-300))
  // 关掉时两档都不出现：档位只在「开着」时有意义。
  const off = tavern.buildRoleplaySystem({ cardName: '张三', persona: 'x', thinking: false, thinkingStyle: 'neutral' })
  t('关掉时中性档也不进提示词', !off.includes('【想的时候】') && !off.includes('【想的时候也一样】'), off.slice(-300))
  // 导出的默认对象里也要有：宿主那边是按 default 取的。
  t('默认导出里也有这两档', tavern.default.THINKING_STYLES !== undefined && typeof tavern.default.thinkingBlock === 'function', '')
}

process.exit(fail === 0 ? 0 : 1)
