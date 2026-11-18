// 写小说：规划 → 写章 → 审稿。
//
// 这一层的价值不在「能存文件」（那太容易），而在三件容易做错的事：
//   1. 大纲要能被人改、改完能读回来（它是整本书唯一的走向依据）；
//   2. 章号不能乱：删了第三章，第四章还是第四章，不能突然变成第三章；
//   3. 让 AI 写某一章时，它拿到的必须是**这一章**的计划 + 上一章结尾 +
//      设定 + 人物——少一样它就会开始自己编。
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as novel from '../lib/novel.js'
import * as store from '../lib/store.js'

let pass = 0, fail = 0
const t = (n, c, x) => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, String(x === undefined ? '' : JSON.stringify(x)).slice(0, 400)) } }

const stamp = Date.now()
const ws = path.join(tmpdir(), 'lifecard-novel-' + stamp)
await fs.mkdir(ws, { recursive: true })
await store.openWorkspace(ws, { create: true })

console.log('\n=== 1. 章号：补零、字典序就是章序 ===')
{
  t('第 1 章是 001.md', novel.chapterFileName(1) === '001.md', novel.chapterFileName(1))
  t('第 12 章是 012.md', novel.chapterFileName(12) === '012.md', novel.chapterFileName(12))
  t('第 100 章是 100.md', novel.chapterFileName(100) === '100.md', novel.chapterFileName(100))
  t('反解 007 得 7', novel.chapterIndexOf('007.md') === 7, novel.chapterIndexOf('007.md'))
  t('不认识的文件名返回 0', novel.chapterIndexOf('大纲.md') === 0, novel.chapterIndexOf('大纲.md'))
  t('超上限夹住', novel.chapterFileName(9999) === '999.md', novel.chapterFileName(9999))
}

console.log('\n=== 2. 建一本书、写几章、读回来 ===')
{
  const made = await novel.createBook(ws, { title: '雾港', genre: '悬疑', idea: '一个港口城市里，三个人各自藏着一件事。' })
  t('建得起来', made.ok === true, made)
  t('书 id 是中文保留', made.id === '雾港', made.id)
  t('book.md 落在 books/<id>/ 下', String(made.path).startsWith('books/雾港/'), made.path)

  const c1 = await novel.writeChapter(ws, '雾港', 1, '# 第一章 雨\n\n雨下了三天。')
  t('第一章写得下', c1.ok === true, c1)
  t('章节按 001 命名', c1.path.endsWith('/001.md'), c1.path)
  const c2 = await novel.writeChapter(ws, '雾港', 0, '# 第二章 船\n\n船进港了。')
  t('index 给 0 表示接在后面（第 2 章）', c2.index === 2, c2)

  const book = await novel.readBook(ws, '雾港')
  t('书读得回来', book.ok === true, book)
  t('两章都在', book.chapters.length === 2, book.chapters.length)
  t('章题从正文第一行取', book.chapters[0].title === '第一章 雨', book.chapters[0].title)
  t('一句话简介存住了', book.idea.includes('港口城市'), book.idea)

  const got = await novel.readChapter(ws, '雾港', 1)
  t('单章读得回来', got.ok === true && got.body.includes('雨下了三天'), got.body)

  const shelf = await novel.listBooks(ws)
  t('书架列得出这本书', shelf.ok === true && shelf.books.some((b) => b.id === '雾港'), shelf.books)
  t('书架上带章数', shelf.books[0].chapters === 2, shelf.books[0])

  // 同名不覆盖：另起一本
  const again = await novel.createBook(ws, { title: '雾港' })
  t('同名新建不覆盖，另起一个号', again.ok === true && again.id !== '雾港', again)
}

console.log('\n=== 3. 删一章之后章号不重排 ===')
{
  await novel.createBook(ws, { title: '编号试验' })
  await novel.writeChapter(ws, '编号试验', 1, '一')
  await novel.writeChapter(ws, '编号试验', 2, '二')
  await novel.writeChapter(ws, '编号试验', 3, '三')
  const del = await novel.deleteChapter(ws, '编号试验', 2)
  t('删得掉第二章', del.ok === true, del)
  const book = await novel.readBook(ws, '编号试验')
  t('剩下 1 和 3', book.chapters.map((c) => c.index).join(',') === '1,3', book.chapters.map((c) => c.index))
  t('第三章还是第三章', book.chapters[1].index === 3, book.chapters[1].index)
}

console.log('\n=== 4. 大纲：能存、能读、能从模型输出里扒出来 ===')
{
  const raw = [
    '主线：三个人各自藏着一件事，最后在码头上撞见。',
    '',
    '第1章 主角在雨夜接到一通电话，去码头接一个陌生人。',
    '第2章 陌生人不见了，只留下一只箱子。',
    '第3章 打开箱子，里面是二十年前的报纸。',
    '',
    '结局：报纸上的照片里，三个人都在场。',
  ].join('\n')
  const parsed = novel.parseOutline(raw)
  t('扒得出主线', parsed.theme.includes('三个人各自藏着'), parsed.theme)
  t('扒得出三章', parsed.chapters.length === 3, parsed.chapters)
  t('每章的计划是具体的事', parsed.chapters[0].plan.includes('雨夜接到一通电话'), parsed.chapters[0])
  t('扒得出结局', parsed.ending.includes('三个人都在场'), parsed.ending)

  const wrote = await novel.writeOutline(ws, '雾港', raw)
  t('大纲存得下', wrote.ok === true, wrote)
  t('存完报章数', wrote.chapters === 3, wrote.chapters)
  const back = await novel.readOutline(ws, '雾港')
  t('大纲读得回来', back.ok === true, back.ok)
  t('读回来还有三章', back.chapters.length === 3, back.chapters.length)

  // 人改一行再存：改完要能读到新的
  const edited = raw.replace('去码头接一个陌生人', '去码头接一个不该出现的人')
  await novel.writeOutline(ws, '雾港', edited)
  const back2 = await novel.readOutline(ws, '雾港')
  t('人改过的那句是新的', back2.text.includes('不该出现的人'), back2.chapters[0].plan)

  // 乱的格式不该崩
  const messy = novel.parseOutline('随便写点什么\n没有主线也没有章节\n')
  t('乱七八糟的输出不崩、章数为 0', messy.ok === false && messy.chapters.length === 0, messy)
}

console.log('\n=== 5. 给 AI 的话：这一章的计划、上一章结尾、设定、人，都得在 ===')
{
  const prompt = novel.buildChapterPrompt({
    title: '雾港',
    idea: '三个人各自藏着一件事',
    genre: '悬疑',
    previousTail: '船进港了，汽笛响了三声。',
    currentBody: '他站在雨里。',
    ask: '写他打开箱子那一段',
    worldEntries: ['这座港口一年有三百天在下雨。'],
    cast: ['【老陈】话很少，习惯先看别人的鞋。'],
    outline: '第1章 …\n第2章 …',
    chapterPlan: '打开箱子，里面是二十年前的报纸。',
  })
  t('书名叫上了', prompt.includes('《雾港》'), '')
  t('这一章的计划在', prompt.includes('打开箱子，里面是二十年前的报纸'), '')
  t('整本书的大纲在', prompt.includes('第1章'), '')
  t('上一章结尾在', prompt.includes('汽笛响了三声'), '')
  t('这一章已写的在', prompt.includes('他站在雨里'), '')
  t('世界设定在', prompt.includes('三百天在下雨'), '')
  t('出场的人设在', prompt.includes('老陈'), '')
  t('作者这一句要求在', prompt.includes('打开箱子那一段'), '')
  t('明说了不写章节标题', prompt.includes('不写章节标题'), '')
  t('明说了只写这一章', prompt.includes('只写这一章'), '')
  t('要求形容词能还原到具体东西上', prompt.includes('能用手的场面'), '')
  t('要求不解释刚写出来的动作', prompt.includes('不解释刚写出来的东西'), '')
  t('要求比喻只在现场捞', prompt.includes('比喻只在现场捞'), '')
  t('对话框里的短回应允许留', prompt.includes('人物对话里「行」'), '')
  // 群像、人各有声、不拿总结代替过程、视角以内 —— 这四条来自用户拿来的那份
  // 「叙事守则」里能用的部分。写不进提示词就等于白说。
  t('要求在场的人各有落点', prompt.includes('不要全站着当背景'), '')
  t('要求台词不能互相换着说', prompt.includes('可以互换着说'), '')
  t('不许用一句总结代替过程', prompt.includes('不拿一句总结代替过程') && prompt.includes('一番盘问之后'), '')
  t('要求视角以内写', prompt.includes('视角以内写'), '')

  // 选项块：只有用户主动要「写到这里我想选下一步」时才加。正经写小说时挂着选项，
  // 等于每章最后都把作者往「三选一」的套路上推——正文会开始收向选项，而不是收向故事。
  const storyDirective = '这一章的最后，单独起一行写 【选】，下面给出 3 个方向。'
  const withChoices = novel.buildChapterPrompt({
    title: '雾港',
    idea: '三个人各自藏着一件事',
    genre: '悬疑',
    chapterPlan: '打开箱子，里面是二十年前的报纸。',
    choicesDirective: storyDirective,
  })
  t('要方向时提示词里有那一段', withChoices.includes('【这一章末尾要给方向】'), withChoices.slice(-400))
  t('要方向时指令原文在', withChoices.includes(storyDirective), '')
  t('方向那段排在最后一句要求之后', withChoices.indexOf('请写这一章') < withChoices.indexOf('【这一章末尾要给方向】'), '')
  t('不给就不要那一段', !prompt.includes('【这一章末尾要给方向】'), '')
  t('传空串也不加', !novel.buildChapterPrompt({ title: '雾港', idea: 'x', genre: '悬疑', choicesDirective: '  ' }).includes('【这一章末尾要给方向】'), '')

  const outlinePrompt = novel.buildOutlinePrompt({
    title: '雾港', genre: '悬疑', idea: '三个人', cast: [], worldEntries: [], chapters: 8, ask: '',
  })
  t('规划提示词要 8 章', outlinePrompt.includes('8 章'), '')
  t('规划提示词规定了输出格式', outlinePrompt.includes('第1章'), '')
  t('规划提示词要它写结局', outlinePrompt.includes('结局：'), '')
}

console.log('\n=== 5a. 伏笔：该收的、埋太久的，各占一段，位置摆对 ===')
{
  const must = [
    { id: 'fs-001', title: '码头那封信', status: 'planted', priority: 'high', planted_chapter: 3, expected_resolve: 9, notes: '谜底是他父亲' },
    { id: 'fs-002', title: '老陈的左手', status: 'progressing', priority: 'normal', planted_chapter: 5, expected_resolve: 9, notes: '' },
  ]
  const warn = [
    { id: 'fs-003', title: '墙上的划痕', status: 'planted', priority: 'normal', planted_chapter: 1, expected_resolve: 0, stale_by: 31 },
  ]
  const withFs = novel.buildChapterPrompt({
    title: '雾港', idea: 'x', genre: '悬疑', chapterPlan: '打开箱子', foreshadows: { must, warn },
  })
  t('该收的那一段在', withFs.includes('【这一章该收的线】'), '')
  t('每条一行、编号从 1 起', withFs.includes('1. 码头那封信——埋在第 3 章，这一章该揭了') && withFs.includes('2. 老陈的左手——埋在第 5 章，这一章该揭了'), withFs)
  t('只列 title 和章号，notes 一个字都不带进来', !withFs.includes('谜底是他父亲'), withFs)
  t('埋太久的那一段在', withFs.includes('【埋太久的】'), '')
  t('埋太久的写清了埋在第几章、多久没动', withFs.includes('- 墙上的划痕（第 1 章埋的，已经 31 章没动）'), withFs)
  t('埋太久的也说了怎么办', withFs.includes('顺手往前推一点，或者这一章就交代了'), '')
  t('顺序：计划 → 该收的 → 埋太久的', withFs.indexOf('【这一章要写的事】') < withFs.indexOf('【这一章该收的线】')
    && withFs.indexOf('【这一章该收的线】') < withFs.indexOf('【埋太久的】'), '')

  // 两段都不给：一个字都不多。空标题是最糟的——模型看见一个空段会自己填。
  const bare = novel.buildChapterPrompt({ title: '雾港', idea: 'x', genre: '悬疑', chapterPlan: '打开箱子' })
  t('不给伏笔就不加那两段', !bare.includes('【这一章该收的线】') && !bare.includes('【埋太久的】'), '')
  const emptyBoth = novel.buildChapterPrompt({ title: '雾港', idea: 'x', genre: '悬疑', foreshadows: { must: [], warn: [] } })
  t('给了空数组也不加', !emptyBoth.includes('【这一章该收的线】') && !emptyBoth.includes('【埋太久的】'), '')
  const nullFs = novel.buildChapterPrompt({ title: '雾港', idea: 'x', genre: '悬疑', foreshadows: null })
  t('传 null 不炸也不加', !nullFs.includes('【埋太久的】'), '')

  // 只有一段时，另一段的标题不能跟着露出来。
  const onlyMust = novel.buildChapterPrompt({ title: '雾港', idea: 'x', genre: '悬疑', chapterPlan: 'p', foreshadows: { must, warn: [] } })
  t('只有该收的时不出现「埋太久的」', onlyMust.includes('【这一章该收的线】') && !onlyMust.includes('【埋太久的】'), '')
  const onlyWarn = novel.buildChapterPrompt({ title: '雾港', idea: 'x', genre: '悬疑', chapterPlan: 'p', foreshadows: { must: [], warn } })
  t('只有埋太久的时不出现「该收的线」', onlyWarn.includes('【埋太久的】') && !onlyWarn.includes('【这一章该收的线】'), '')

  // 位置：两段都在「怎么写」之前，也都在选项段之前。
  const withChoices2 = novel.buildChapterPrompt({
    title: '雾港', idea: 'x', genre: '悬疑', chapterPlan: '打开箱子',
    foreshadows: { must, warn }, choicesDirective: '给三个方向',
  })
  t('伏笔段排在选项段之前', withChoices2.indexOf('【埋太久的】') < withChoices2.indexOf('【这一章末尾要给方向】'), '')

  // 超期那条：说好第几章揭要说出来，不能说成「已经 0 章没动」。
  const overdue = novel.buildChapterPrompt({
    title: '雾港', idea: 'x', genre: '悬疑',
    foreshadows: { must: [], warn: [{ id: 'fs-009', title: '超期那条', planted_chapter: 2, expected_resolve: 10, overdue: true, stale_by: 20 }] },
  })
  t('超期那条说清说好第几章揭', overdue.includes('说好第 10 章揭') && !overdue.includes('已经 0 章没动'), overdue)
}

console.log('\n=== 5b. 路由那条：只有 wantChoices 才把选项要求发出去 ===')
{
  // 上面钉的是函数。真正决定「发不发」的是路由：界面上的开关没打开时，
  // 提示词里必须一个字都不多——否则每一章末尾都挂三个路，写小说就变成点菜单。
  const api = await import('../lib/index.js')
  const seen = []
  const ctx = {
    webServer: { register: () => () => {} },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
    get: (name) => (name === 'llm' ? {
      listProviders: async () => [{ provider: 'r', models: [{ id: 'm' }] }],
      listModels: async () => [],
      stream: (req) => {
        seen.push(String(req.messages?.[0]?.content?.[0]?.text ?? ''))
        return (async function* () {
          yield { type: 'text-delta', text: '这一章写完了。' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    } : undefined),
  }
  const table = api.buildApi(ctx, async () => ws, { workspace: ws })
  const book = await novel.createBook(ws, { title: '雾港甲', genre: '悬疑', idea: '三个人' })
  t('书建好了', book.ok === true, book)

  const plain = await table['novel.chapter.draft']({ id: book.id, index: 1 })
  t('默认那次写得出来', plain.ok === true, plain)
  t('默认那次不带选项要求', !seen.at(-1).includes('【这一章末尾要给方向】'), seen.at(-1).slice(-200))

  const wanted = await table['novel.chapter.draft']({ id: book.id, index: 1, wantChoices: true })
  t('要方向那次也写得出来', wanted.ok === true, wanted)
  t('要方向那次带上了', seen.at(-1).includes('【这一章末尾要给方向】'), seen.at(-1).slice(-200))
  t('要方向那次问的是「往哪走」', seen.at(-1).includes('这一轮往哪走'), '')
}

console.log('\n=== 5c. 拆书路由：先给提案、再落盘 ===')
// 这一组钉的是 cast.js 和 index.js 之间那根线。
// cast.js 本身有 84 项测试，但它写完之后一直没接线——纯函数全绿，界面上却
// 没有任何入口能用到它。所以这里从 buildApi() 拿真路由表调，模型用假的：
// 只要有一根线没接上（提示词没把书名带过去、世界观没喂给第二次调用、
// 落盘路径和 castRelPath 对不上），这里就会红。
{
  const api = await import('../lib/index.js')
  const core = await import('../lib/core.js')

  const worldReply = [
    '## 北洋码头',
    '触发词：码头、卸货',
    '一年里有一半时间在下雪。',
    '',
    '## 记账规矩',
    '触发词：账本、欠条',
    '赊账记在蓝皮本上。',
  ].join('\n')
  const castReply = [
    '## 人物：张三',
    '### 自述',
    '记账人。',
    '### 不会说的话',
    '不说软话。',
    '',
    '## 人物：李四',
    '### 自述',
    '跑船的。',
    '',
    '## 人物：王五',
    '### 自述',
    '名单外的人。',
  ].join('\n')

  // 两段提示词长得完全不一样，所以按内容分派回答，而不是按调用次数——
  // 按次数分派的话，哪一天顺序变了这份测试就默默测错了东西。
  const seen = []
  const makeCtx = (options = {}) => ({
    webServer: { register: () => () => {} },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
    get: (name) => (name === 'llm' ? {
      listProviders: async () => [{ provider: 'r', models: [{ id: 'm' }] }],
      listModels: async () => [],
      stream: (req) => {
        const prompt = String(req.messages?.[0]?.content?.[0]?.text ?? '')
        seen.push(prompt)
        if (options.failOn !== undefined && options.failOn(prompt) === true) {
          throw new Error('宿主那头断了')
        }
        const text = prompt.includes('【要拆的人】') ? castReply : worldReply
        return (async function* () {
          yield { type: 'text-delta', text }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    } : undefined),
  })
  const table = api.buildApi(makeCtx(), async () => ws, { workspace: ws })

  const sample = await novel.createBook(ws, { title: '拆书样本', genre: '悬疑', idea: '一个码头，一本账。' })
  await novel.writeChapter(ws, sample.id, 1, '张三在码头卸货，手指头压过一回。')
  await novel.writeChapter(ws, sample.id, 2, '李四跑船回来，账本上少了三笔。')

  // ── 没点名：只交世界观，并且明确要名单 ──
  const first = await table['novel.splitBook']({ book: sample.id, names: '' })
  t('没点名也跑得通', first.ok === true, first)
  t('世界观拆出两条', first.world.length === 2, first.world.length)
  t('没点名时不猜人', first.people.length === 0, first.people.length)
  t('回话说「要先点名」', first.needNames === true, first.needNames)
  t('回话里说了上限是 8 个', String(first.warning).includes('8'), first.warning)
  t('点名那次没去问模型', seen.length === 1, seen.length)
  t('拆世界观那条带上了书名', seen[0].includes('《拆书样本》'), seen[0].slice(0, 80))
  t('拆世界观那条带上了正文', seen[0].includes('手指头压过一回'))
  t('世界观条目标题对', first.world[0].title === '北洋码头', first.world[0].title)
  t('世界观触发词带了过来', first.world[0].keys.join('|') === '码头|卸货', first.world[0].keys)

  // ── 点了名：两次调用，第二次吃到第一次的世界观 ──
  const second = await table['novel.splitBook']({ book: sample.id, names: '张三，李四' })
  t('点名后拆得出来', second.ok === true, second)
  t('两个人都拆到了', second.people.map((p) => p.name).join('|') === '张三|李四', second.people.map((p) => p.name))
  t('多写的王五被记进 dropped', (second.dropped ?? []).includes('王五'), second.dropped)
  t('多写的王五没混进人物', !second.people.some((p) => p.name === '王五'), second.people.map((p) => p.name))
  t('每人七节齐全', second.people.every((p) => p.sections.length === 7), second.people[0].sections.length)
  const noSay = second.people[0].sections.find((s) => s.title === '不会说的话')
  t('「不会说的话」没被口癖抢走', noSay.body === '不说软话。', noSay.body)
  t('第二次调用一共问了两次模型', seen.length === 3, seen.length)
  t('拆人物那条吃到了世界观', seen[2].includes('这本书发生在：北洋码头'), seen[2].slice(0, 200))
  t('拆人物那条带上了名单', seen[2].includes('【要拆的人】张三、李四'), seen[2].slice(0, 300))
  t('回了取料范围', second.source?.chapters === 2 && second.source?.chars > 0, second.source)

  // ── 落盘 ──
  const applied = await table['novel.applySplit']({ book: sample.id, world: second.world, people: second.people })
  t('applySplit 存得下', applied.ok === true, applied)
  t('世界观存了两条', applied.world === 2, applied.world)
  t('两个人都写进卡里', applied.people.join('|') === '张三|李四', applied.people)
  t('一条都没失败', Array.isArray(applied.failed) && applied.failed.length === 0, applied.failed)
  t('回了两个卡的路径', Array.isArray(applied.paths) && applied.paths.length === 2, applied.paths)
  t('卡落在 books/<书>/cast/ 下', String(applied.paths?.[0]).startsWith('books/拆书样本/cast/'), applied.paths?.[0])

  const worldCard = await store.readCard(ws, 'worlds/拆书样本/world.md')
  t('世界书写在 worlds/<书>/world.md', worldCard.ok === true, worldCard.error)
  const parsedWorld = worldCard.ok === true ? core.parseWorldEntries(worldCard.sections) : []
  t('世界书里读得回两条', parsedWorld.length === 2, parsedWorld.length)
  t('读回来带触发词', (parsedWorld[0]?.keys ?? []).includes('码头'), parsedWorld[0]?.keys)
  t('读回来带正文', String(parsedWorld[0]?.content ?? '').includes('下雪'), parsedWorld[0]?.content)
  t('读回来能认回标题', String(parsedWorld[0]?.comment ?? '') === '北洋码头', parsedWorld[0]?.comment)
  t('世界书归属是这本书', worldCard.data?.kind === 'world' && worldCard.data?.id === '拆书样本', worldCard.data)

  const zhangCard = await store.readCard(ws, 'books/拆书样本/cast/张三.md')
  t('人物卡写在 books/<书>/cast/ 下', zhangCard.ok === true, zhangCard.error)
  t('人物卡是本世界的人', zhangCard.data?.world === '拆书样本', zhangCard.data?.world)
  t('人物卡 kind 是 fictional', zhangCard.data?.kind === 'fictional', zhangCard.data?.kind)
  const zhangSelf = (zhangCard.sections ?? []).find((s) => s.title === '自述')
  t('人物卡正文进了小节', String(zhangSelf?.body ?? '').includes('记账人'), zhangSelf?.body)

  // ── 只勾一个人 ──
  const only = await table['novel.applySplit']({ book: sample.id, world: [], people: second.people, picked: ['李四'] })
  t('按名字只存勾中的那个', only.ok === true && only.people.join('|') === '李四', only.people)
  t('勾中的那张卡真在盘上', (await store.readCard(ws, 'books/拆书样本/cast/李四.md')).ok === true, '')
  const byIndex = await table['novel.applySplit']({ book: sample.id, world: [], people: second.people, picked: ['1'] })
  t('按第几个也能勾', byIndex.ok === true && byIndex.people.join('|') === '张三', byIndex.people)

  // ── 再拆一次不能把上一次的世界观盖掉 ──
  const again = await table['novel.applySplit']({ book: sample.id, world: second.world, people: [] })
  t('重复的世界观不重复写', again.ok === true && again.world === 0, again.world)
  const worldAgain = await store.readCard(ws, 'worlds/拆书样本/world.md')
  t('重复写之后还是两条', core.parseWorldEntries(worldAgain.sections).length === 2, core.parseWorldEntries(worldAgain.sections).length)

  // ── 同名：只存第一个，第二个如实报出来 ──
  const twins = await table['novel.applySplit']({
    book: sample.id,
    world: [],
    people: [{ name: '张三', sections: [] }, { name: '张三', sections: [] }],
  })
  t('同名的只写一张卡', twins.ok === true && twins.people.length === 1, twins.people)
  t('同名的第二个进 failed', twins.failed.length === 1 && twins.failed[0].name === '张三', twins.failed)
  t('同名失败说要改名', String(twins.failed[0]?.error).includes('两个人都叫'), twins.failed[0]?.error)

  // ── 边界：书是空的 / 书不在了 / 什么都没勾 ──
  const emptyBook = await novel.createBook(ws, { title: '空书样本' })
  const noText = await table['novel.splitBook']({ book: emptyBook.id, names: '张三' })
  t('没正文的书拆不了', noText.ok === false, noText)
  t('说的是人话', String(noText.error).includes('一个字都没有'), noText.error)
  const ghost = await table['novel.splitBook']({ book: '根本没有这本书' })
  t('书不在了也直说', ghost.ok === false && ghost.error === '这本书不在了', ghost.error)
  const noId = await table['novel.splitBook']({})
  t('没说是哪本书会直说', noId.ok === false && noId.error === '没有说是哪本书', noId.error)
  const nothing = await table['novel.applySplit']({ book: sample.id })
  t('什么都没勾就不写盘', nothing.ok === false && String(nothing.error).includes('没有勾选'), nothing.error)

  // ── 模型那一次挂了：世界观那口气不能白等 ──
  const halfCtx = makeCtx({ failOn: (prompt) => prompt.includes('【要拆的人】') })
  const halfTable = api.buildApi(halfCtx, async () => ws, { workspace: ws })
  const half = await halfTable['novel.splitBook']({ book: sample.id, names: '张三' })
  t('人物那次挂了不丢世界观', half.ok === true && half.world.length === 2, half)
  t('人物挂了要说清可以只重拆人物', String(half.warning).includes('只重拆人物'), half.warning)
  t('人物挂了就不给人物', half.people.length === 0, half.people.length)

  const deadCtx = makeCtx({ failOn: () => true })
  const deadTable = api.buildApi(deadCtx, async () => ws, { workspace: ws })
  const dead = await deadTable['novel.splitBook']({ book: sample.id, names: '张三' })
  t('模型全挂了就说没拆成', dead.ok === false && String(dead.error).includes('没拆出世界观'), dead.error)
  t('挂了也不往外抛英文', !/[A-Za-z]{4,}/.test(String(dead.error)), dead.error)
}

console.log('\n=== 5d. 伏笔账本：能记、能改、能删，写章时真的喂给了模型 ===')
// foreshadow.js 自己有 105 项测试，但它写完之后 lib/index.js 里一条引用都没有——
// 账本记得再准，没有路由就是界面上没有入口；`novel.chapter.draft` 那条路
// 也一直没把 `foreshadows` 传给 buildChapterPrompt，于是「这一章该收的线」
// 一次都没有进过提示词。这一组从 buildApi() 拿真路由表调，模型用假的，
// 钉的就是这两根线。
{
  const api = await import('../lib/index.js')
  const seen = []
  const ctx = {
    webServer: { register: () => () => {} },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
    get: (name) => (name === 'llm' ? {
      listProviders: async () => [{ provider: 'r', models: [{ id: 'm' }] }],
      listModels: async () => [],
      stream: (req) => {
        seen.push(String(req.messages?.[0]?.content?.[0]?.text ?? ''))
        return (async function* () {
          yield { type: 'text-delta', text: '这一章写完了。' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    } : undefined),
  }
  const table = api.buildApi(ctx, async () => ws, { workspace: ws })
  const made = await novel.createBook(ws, { title: '伏笔试验', genre: '悬疑', idea: '一封信压了二十年' })
  t('书建好了', made.ok === true, made)
  const bookId = made.id

  // ── 还没记过：空账本不是错 ──
  const blank = await table['novel.foreshadow.list']({ id: bookId })
  t('账本不存在时 list 还是 ok', blank.ok === true, blank)
  t('账本不存在时给空数组', Array.isArray(blank.list) && blank.list.length === 0, blank.list)
  t('空账本不给概览句（界面上不占一行）', blank.summary === '', blank.summary)
  t('空账本不给预算提醒', blank.budget === '', blank.budget)
  const noId = await table['novel.foreshadow.list']({})
  t('没说哪本书时会直说', noId.ok === false && noId.error === '没有说是哪本书', noId.error)

  // ── 记第一条：号从 fs-001 起 ──
  const first = await table['novel.foreshadow.save']({
    id: bookId,
    item: { title: '码头那封信', priority: 'high', planted_chapter: 2, expected_resolve: 3, notes: '谜底是他父亲' },
  })
  t('存得下第一条', first.ok === true, first)
  t('第一条的号是 fs-001', first.id === 'fs-001', first.id)
  t('存完 list 多一条', first.list.length === 1, first.list.length)
  t('没给状态的默认是 planted', first.list[0].status === 'planted', first.list[0].status)
  t('章号存成数字不是字符串', first.list[0].planted_chapter === 2, first.list[0].planted_chapter)

  const second = await table['novel.foreshadow.save']({ id: bookId, item: { title: '老陈的左手' } })
  t('第二条接着往下编号', second.id === 'fs-002', second.id)
  t('两条都在了', second.list.length === 2, second.list.length)
  t('没给要紧程度的默认是 normal', second.list[1].priority === 'normal', second.list[1].priority)

  // 这两条落盘了：list 路由读回来的是同一个账本，不是内存里的临时数组
  const listed = await table['novel.foreshadow.list']({ id: bookId })
  t('list 读得回两条', listed.ok === true && listed.list.length === 2, listed.list.length)
  t('list 记得住标题', listed.list.map((x) => x.title).join('|') === '码头那封信|老陈的左手', listed.list.map((x) => x.title))
  t('概览句里有条数', String(listed.summary).includes('伏笔 2 条'), listed.summary)
  t('两条都还没超预算', listed.budget === '', listed.budget)

  // ── 没名字不许存 ──
  const noTitle = await table['novel.foreshadow.save']({ id: bookId, item: { priority: 'high' } })
  t('缺 title 时存不下', noTitle.ok === false, noTitle)
  t('缺 title 的那句是中文原话', noTitle.error === '这条线得有个名字，不然以后认不出是哪条。', noTitle.error)
  const afterNoTitle = await table['novel.foreshadow.list']({ id: bookId })
  t('被拒的那次没往账本里多写一条', afterNoTitle.list.length === 2, afterNoTitle.list.length)

  // ── 同 id 更新：条数不变，字段变 ──
  const updated = await table['novel.foreshadow.save']({
    id: bookId,
    item: { id: 'fs-001', title: '码头那封信', status: 'progressing', planted_chapter: 2, expected_resolve: 4 },
  })
  t('按 id 更新存得下', updated.ok === true, updated)
  t('更新不多出一条', updated.list.length === 2, updated.list.length)
  t('状态改成了 progressing', updated.list.find((x) => x.id === 'fs-001').status === 'progressing', updated.list[0])
  t('说好回收的章也改了', updated.list.find((x) => x.id === 'fs-001').expected_resolve === 4, updated.list[0].expected_resolve)
  t('更新时没传的字段不被抹掉', updated.list.find((x) => x.id === 'fs-001').notes === '谜底是他父亲', updated.list[0].notes)

  // 写错的状态/要紧程度退回默认，而不是整条不让存
  const odd = await table['novel.foreshadow.save']({ id: bookId, item: { title: '写法写错的那条', status: '乱写', priority: '也不对' } })
  t('状态写错也存得下', odd.ok === true, odd)
  t('写错的状态退回 planted', odd.list.find((x) => x.title === '写法写错的那条').status === 'planted', odd.list)
  t('写错的要紧程度退回 normal', odd.list.find((x) => x.title === '写法写错的那条').priority === 'normal', odd.list)

  // ── 删 ──
  const beforeRemove = (await table['novel.foreshadow.list']({ id: bookId })).list.length
  const removed = await table['novel.foreshadow.remove']({ id: bookId, foreshadowId: 'fs-002' })
  t('删得掉一条', removed.ok === true, removed)
  t('删完少一条', removed.list.length === beforeRemove - 1, removed.list.length)
  t('删掉的那条真的不在了', !removed.list.some((x) => x.id === 'fs-002'), removed.list.map((x) => x.id))
  const ghost = await table['novel.foreshadow.remove']({ id: bookId, foreshadowId: 'fs-999' })
  t('删不存在的会直说', ghost.ok === false, ghost)
  t('删不存在的那句是中文原话', ghost.error === '账本里没有这一条。', ghost.error)
  const afterGhost = await table['novel.foreshadow.list']({ id: bookId })
  t('删不存在的那次没动账本', afterGhost.list.length === beforeRemove - 1, afterGhost.list.length)

  // 删完再加，号只往上走：fs-002 这个号可能已经写进正文里了，不能回收
  const afterRemoveSave = await table['novel.foreshadow.save']({ id: bookId, item: { title: '重新记一条' } })
  t('删过之后号不复用', afterRemoveSave.id === 'fs-004', afterRemoveSave.id)
}

console.log('\n=== 5e. 写这一章时，账本里该收的线真进了提示词，谜底没进 ===')
// 上面那一组钉的是路由；这一组钉的是「路由 → buildChapterPrompt」那一段。
// 最容易坏的样子是：账本记对了、路由也返回了，但 draft 里忘了把 `foreshadows`
// 传下去——模型看不到，这一章就把说好要收的线全忘了，而任何一条测试都不会红。
{
  const api = await import('../lib/index.js')
  const seen = []
  const ctx = {
    webServer: { register: () => () => {} },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
    get: (name) => (name === 'llm' ? {
      listProviders: async () => [{ provider: 'r', models: [{ id: 'm' }] }],
      listModels: async () => [],
      stream: (req) => {
        seen.push(String(req.messages?.[0]?.content?.[0]?.text ?? ''))
        return (async function* () {
          yield { type: 'text-delta', text: '这一章写完了。' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    } : undefined),
  }
  const table = api.buildApi(ctx, async () => ws, { workspace: ws })
  const made = await novel.createBook(ws, { title: '喂伏笔试验', genre: '悬疑', idea: '一封信压了二十年' })
  const bookId = made.id
  // 第 3 章要收的那条：埋在第 2 章、说好第 3 章揭。
  await table['novel.foreshadow.save']({
    id: bookId,
    item: { title: '码头那封信', status: 'planted', priority: 'high', planted_chapter: 2, expected_resolve: 3, notes: '谜底是他父亲' },
  })
  // 埋太久的那条：第 1 章埋的，写到第 3 章已经 2 章没动——不到 30 章，故意不该它出现。
  await table['novel.foreshadow.save']({
    id: bookId,
    item: { title: '墙上的划痕', status: 'planted', planted_chapter: 1, expected_resolve: 0 },
  })

  const drafted = await table['novel.chapter.draft']({ id: bookId, index: 3 })
  t('有账本也照样写得出来', drafted.ok === true, drafted)
  t('账本翻得开时不带 foreshadowError', drafted.foreshadowError === undefined, drafted.foreshadowError)
  const prompt = seen.at(-1)
  t('这一章该收的那段进了提示词', prompt.includes('【这一章该收的线】'), prompt.slice(0, 200))
  t('点了那条线的名字', prompt.includes('码头那封信'), '')
  t('说了这一章该揭了', prompt.includes('这一章该揭了'), '')
  t('说了它埋在第几章', prompt.includes('埋在第 2 章'), '')
  t('账本里 notes 写的谜底不许进提示词', !prompt.includes('谜底是他父亲'), '')
  t('还没到 30 章的那条不算埋太久', !prompt.includes('【埋太久的】'), '')

  // 换一章：第 4 章不该再收这条（说好的是第 3 章），也不该被当成超期——
  // 它是 planted 不是 progressing，pickForChapter 只对 progressing 报超期。
  await table['novel.chapter.draft']({ id: bookId, index: 4 })
  t('过了说好的那一章就不再点名要收', !seen.at(-1).includes('【这一章该收的线】'), seen.at(-1).slice(0, 200))

  // 账本翻了但已经收掉的线：不该再出现
  await table['novel.foreshadow.save']({
    id: bookId,
    item: { id: 'fs-001', title: '码头那封信', status: 'resolved', planted_chapter: 2, expected_resolve: 3, resolved_chapter: 3 },
  })
  const third = await table['novel.chapter.draft']({ id: bookId, index: 3 })
  t('收了之后同章再写不再点名', third.ok === true && !seen.at(-1).includes('【这一章该收的线】'), seen.at(-1).slice(0, 200))

  // 账本翻不开（这里把 foreshadows.yml 做成了一个同名目录，readFile 会 EISDIR）：
  // 这一章照样得写，但错要跟着返回值回去，界面才有据可查。
  const broken = await novel.createBook(ws, { title: '坏账本试验', genre: '悬疑' })
  await fs.mkdir(path.join(ws, 'books', broken.id, 'foreshadows.yml'), { recursive: true })
  const stillWrote = await table['novel.chapter.draft']({ id: broken.id, index: 1 })
  t('账本翻不开也照样写这一章', stillWrote.ok === true, stillWrote)
  t('账本翻不开时带了 foreshadowError', typeof stillWrote.foreshadowError === 'string' && stillWrote.foreshadowError !== '', stillWrote.foreshadowError)
  t('账本翻不开时提示词里没有伏笔那两段', !seen.at(-1).includes('【这一章该收的线】') && !seen.at(-1).includes('【埋太久的】'), '')
  const brokenList = await table['novel.foreshadow.list']({ id: broken.id })
  t('账本翻不开时 list 报错不假装空账本', brokenList.ok === false && typeof brokenList.error === 'string', brokenList)
}

console.log('\n=== 6. 取结尾：短的原样，长的裁掉前面 ===')
{
  t('短的原样返回', novel.tailOf('就一句话', 100) === '就一句话', novel.tailOf('就一句话', 100))
  const long = 'A'.repeat(1000) + '结尾这几个字'
  const tail = novel.tailOf(long, 20)
  t('长的只留后面', tail.endsWith('结尾这几个字') && tail.length <= 21, tail.length)
  t('裁掉的时候标了省略号', tail.startsWith('…'), tail.slice(0, 5))
}

await fs.rm(ws, { recursive: true, force: true }).catch(() => {})
console.log('\n=== 7. 书名里带「..」不能把工作区删掉 ===')
// 书 id 是从书名来的，而书名是用户能随便打的。以前 `bookRelPath('..')` 是 `'.'`，
// `deleteBook` 于是 `fs.rm(root + '.', {recursive:true})` —— 整个工作区（卡、材料、
// 提案、快照）一次删光。这一组就是拴住那个口的。
{
  t('「..」收成安全的目录名', novel.bookRelPath('..') === 'books/未命名', novel.bookRelPath('..'))
  t('「.」收成安全的目录名', novel.bookRelPath('.') === 'books/未命名', novel.bookRelPath('.') === 'books/未命名' ? 'books/未命名' : novel.bookRelPath('.'))
  t('「books」不会指回 books 自己', novel.bookRelPath('books') !== 'books', novel.bookRelPath('books'))
  t('中间的点压成一个', novel.bookRelPath('a..b') === 'books/a.b', novel.bookRelPath('a..b'))
  t('正常书名照旧', novel.bookRelPath('雨里的门') === 'books/雨里的门', novel.bookRelPath('雨里的门'))

  const them = path.join(ws, 'books', '活着')
  await fs.mkdir(path.join(them, 'chapters'), { recursive: true })
  await fs.writeFile(path.join(them, 'book.md'), 'lifecard: "0.1"\nkind: book\ntitle: 活着\n', 'utf8')
  await fs.writeFile(path.join(them, 'chapters', '001.md'), '正文', 'utf8')
  const before = await fs.readdir(ws)
  await novel.deleteBook(ws, '..')
  await novel.deleteBook(ws, '.')
  await novel.deleteBook(ws, '')
  const after = await fs.readdir(ws)
  // 判据不是「返回 ok:false」——sanitize 之后它们变成 books/未命名，删的是那个空目录，
  // 返回 ok:true 也没关系。真正的判据是：工作区里别的东西一个都没少。
  t('工作区一个文件都没少', JSON.stringify(before.sort()) === JSON.stringify(after.sort()), after)
  const alive = await fs.stat(path.join(them, 'chapters', '001.md')).then(() => true).catch(() => false)
  t('那本书的正文还在', alive)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
