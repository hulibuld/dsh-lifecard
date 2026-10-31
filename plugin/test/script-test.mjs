/**
 * 小说改剧本。
 *
 * 这一层的重点不在「能把一段字存进 `scripts/001.md`」，而在四件容易做错的事：
 *   1. 分场要按地方变、时间跳来切，不能一人一句就切一场（那是分镜）；
 *   2. 剧本里不该出现的东西（秒数、镜号、景别、机位、BGM）必须数得出来——
 *      它们混进去，下一个环节的人第一步就是拿笔划掉；
 *   3. 数出来的东西不能冤枉台词：「等我一秒」是正常说话，不是写时长；
 *   4. 改第二遍时要带上上一章剧本的最后一场，否则谁站在哪、手上有什么会重新编一遍。
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as novel from '../lib/novel.js'
import * as store from '../lib/store.js'
import * as api from '../lib/index.js'

let pass = 0, fail = 0
const t = (n, c, x) => {
  if (c) { pass++; console.log('  PASS', n) }
  else { fail++; console.log('  FAIL', n, String(x === undefined ? '' : JSON.stringify(x)).slice(0, 500)) }
}

const stamp = Date.now()
const ws = path.join(tmpdir(), 'lifecard-script-' + stamp)
await fs.mkdir(ws, { recursive: true })
await store.openWorkspace(ws, { create: true })

// 一份像样的剧本：两场，第一场夜/内/雨，第二场日/外。
const SAMPLE = [
  '# 《雨里的门》',
  '',
  '第1场',
  '旧书店·门厅　夜　内',
  '【出场人物】林小雨、陈默',
  '【关键道具】一把湿伞、一本账本',
  '△ 林小雨站在门里，手里攥着那把湿伞，伞尖滴水。',
  '△ 陈默从书架后面出来，手还搭在账本上。',
  '陈默（没抬头）说："伞放门边，别带进来。"',
  '林小雨（把伞往里递了递）说："雨太大了，放外边就湿回去了。"',
  '',
  '第2场',
  '街口　日　外',
  '【出场人物】林小雨',
  '【关键道具】一把湿伞',
  '△ 林小雨站在街口，伞还攥在手里，雨停了。',
  '林小雨（看着对街的卷帘门）说："……他今天要不要开门。"',
  '',
].join('\n')

console.log('\n=== 1. 拆场号：认得「场景名 日夜 内外」的几种写法 ===')
{
  const a = novel.parseSceneHeadLine('旧书店·门厅　夜　内')
  t('认得地方、夜、内', a.place.includes('旧书店') && a.dayNight === '夜' && a.inOut === '内', a)
  const b = novel.parseSceneHeadLine('街口 日 外')
  t('空格分开也认得', b.place === '街口' && b.dayNight === '日' && b.inOut === '外', b)
  const c = novel.parseSceneHeadLine('医院走廊|白天|室内')
  t('竖线加「室内」也认得', c.place === '医院走廊' && c.inOut === '内', c)
  t('认不出来的行不硬塞', novel.parseSceneHeadLine('林小雨（低声）说："走吧。"') === null)
}

console.log('\n=== 2. 台词：角色名、括号里的东西、说了什么 ===')
{
  const one = novel.parseDialogueLine('陈默（没抬头）说："伞放门边，别带进来。"')
  t('拆出谁在说', one !== null && one.who === '陈默', one)
  t('拆出括号里写的动作', one !== null && one.paren === '没抬头', one)
  t('拆出台词本身', one !== null && one.text === '伞放门边，别带进来。', one)
  const two = novel.parseDialogueLine('林小雨："我不冷。"')
  t('没有「说」字也认', two !== null && two.who === '林小雨' && two.text === '我不冷。', two)
  t('动作行不是台词', novel.parseDialogueLine('△ 他把伞靠在门边。') === null)
}

console.log('\n=== 3. 分场统计：场数、台词数、动作行数 ===')
{
  const parsed = novel.parseScriptScenes(SAMPLE)
  t('剧名读出来了', parsed.title === '雨里的门', parsed.title)
  t('剧名带 markdown 井号也认得', novel.parseScriptScenes('# 《雨里的门》\n\n第1场\n街口　日　外\n△ 她站着。').title === '雨里的门')
  t('切出两场', parsed.counts.scenes === 2, parsed.counts)
  t('第一场有 2 句台词', parsed.scenes[0].dialogues.length === 2, parsed.scenes[0].dialogues.length)
  t('第一场有 2 行动作', parsed.scenes[0].actions.length === 2, parsed.scenes[0].actions)
  t('对话里出现的人自动并进出场人物', parsed.scenes[0].cast.includes('陈默') && parsed.scenes[0].cast.includes('林小雨'), parsed.scenes[0].cast)
  t('【关键道具】读出来了', parsed.scenes[0].props.some((x) => x.includes('湿伞')), parsed.scenes[0].props)
  t('每场都留了原始行（接上一场时要用）', Array.isArray(parsed.scenes[0].raw) && parsed.scenes[0].raw.join('\n').includes('第1场') === false && parsed.scenes[0].raw.join('\n').includes('林小雨站在门里'), parsed.scenes[0].raw)
}

console.log('\n=== 4. 数一遍：干净剧本不报，塞了镜头语言就报 ===')
{
  const clean = novel.scanScript(SAMPLE)
  t('干净剧本没有硬伤', clean.ok === true, clean.issues)
  t('数得对：两场、三句台词', clean.counts.scenes === 2 && clean.counts.dialogues === 3, clean.counts)

  const dirty = novel.scanScript([
    '第1场',
    '旧书店　夜　内',
    '△ 特写：伞尖滴水。',
    '△ 他站了三秒，镜头推近。',
    '陈默说："等我一秒。"',
    '',
    '第2场',
    '街口　日　外',
    '△ 风把招牌吹得响。',
  ].join('\n'))
  const kinds = dirty.issues.map((x) => x.kind)
  t('报出镜头语言', kinds.includes('camera'), kinds)
  t('台词里的「等我一秒」不算写时长', !dirty.issues.some((x) => x.kind === 'camera' && String(x.samples ?? '').includes('等我一秒')), dirty.issues)
  t('第 2 场没写出场人物也报出来', kinds.includes('no-cast'), kinds)
  t('空场（只有动作没有台词）不算硬伤，但能数出来', dirty.counts.scenes === 2, dirty.counts)

  const empty = novel.scanScript('')
  t('空文件不炸', empty.ok === false && empty.issues.length > 0, empty.issues)

  const report = novel.scriptReportText(clean)
  t('报告先说数出来的结果', report.includes('共 2 场') && report.includes('台词'), report.slice(0, 80))
}

console.log('\n=== 5. 提示词：把原著改编的规矩写进去 ===')
{
  const prompt = novel.buildScriptPrompt({
    title: '雨里的门',
    genre: '悬疑',
    idea: '一个人等着另一个人开口。',
    chapterNo: 3,
    chapterTitle: '第一章 雨',
    chapterBody: '# 第一章 雨\n\n雨下了三天。她站在门里，伞尖滴水。',
    // 路由里 gatherCast 给的就是这种一行一个人的字符串。
    cast: ['【林小雨】在旧书店做事，说话只答半句。'],
    worldEntries: ['这座城每年下四个月的雨。'],
    previousTail: '第2场\n街口　日　外\n△ 她的伞还攥在手里。',
  })
  t('给了章号', prompt.includes('第 3 章') || prompt.includes('第3章'), prompt.slice(0, 80))
  t('带上了这一章的正文', prompt.includes('雨下了三天'), prompt.slice(-400))
  t('带上了人物', prompt.includes('林小雨'), '')
  t('带上了设定', prompt.includes('四个月的雨'), '')
  t('带上了上一章最后一场（接得住位置和道具）', prompt.includes('她的伞还攥在手里'), '')
  // 这几条以前是拿单字包含当断言的（`includes('△')`、`includes('秒')`）——
  // 把整行规矩改坏，甚至把这一条删掉，测试照样全绿。断言整句，才拦得住。
  t('要求叙述转 △ 动作', prompt.includes('以「△」开头') && prompt.includes('一行一个连续的动作'), '')
  t('动作行要写清位置朝向和结果', prompt.includes('写清位置、朝向、谁对谁、手上拿着什么、结果怎么样'), '')
  t('钉死了台词格式', prompt.includes('`角色名（情绪或动作）说："台词。"`'), '')
  t('括号里只写演得出来的东西', prompt.includes('不写「心里一沉」'), '')
  t('心理的三优先顺序', prompt.includes('先看能不能用表情和动作演出来'), '')
  t('心里话要带括号写成一行', prompt.includes('（心里想：……）'), '')
  t('标点分工说清了', prompt.includes('`！？`') && prompt.includes('`……`'), '')
  t('不许写镜头景别机位', prompt.includes('镜号、景别、机位、运镜'), '')
  t('不许写秒数时长', prompt.includes('不写：秒数、时长'), '')
  t('不许写字幕旁白音乐', prompt.includes('字幕、旁白'), '')
  t('忠于原著：不许加人改结局', prompt.includes('不加原著里没有的人和事') && prompt.includes('不改结局'), '')
  t('关键台词伏笔道具不许丢', prompt.includes('伏笔、反转、道具'), '')
  t('人物只能说自己知道的事', prompt.includes('人物只能说自己知道的事'), '')
  t('连续性要接住道具和伤', prompt.includes('信在谁兜里'), '')
  t('不许替作者往下编', prompt.includes('不许替作者往下编'), '')
  t('有输出格式的样例', prompt.includes('第1场') && prompt.includes('【出场人物】'), '')
  t('自检要内部做完不输出', prompt.includes('这些检查的话不要写出来'), '')
  t('不要解释也不要反问', prompt.includes('不要解释怎么改的') && prompt.includes('问我满不满意'), '')

  // 结构断言：规矩是一条条列的，把这些条删掉一半，测试必须红。
  const howSection = prompt.split('【怎么改】')[1]?.split('【输出格式】')[0] ?? ''
  const bullets = howSection.split('\n').filter((line) => line.trim().startsWith('- '))
  t('「怎么改」是逐条列的', bullets.length >= 16, `只有 ${bullets.length} 条`)

  const note = novel.buildScriptSystemNote()
  t('系统提示钉住位置：是编剧', note.includes('编剧'), note.slice(0, 60))
  t('系统提示不许写小说腔', note.includes('小说'), '')
}

console.log('\n=== 6. 路由往返：改 → 存 → 读 → 列 → 删 ===')
{
  const scripted = [
    '# 《雨里的门》',
    '',
    '第1场',
    '旧书店·门厅　夜　内',
    '【出场人物】林小雨、陈默',
    '△ 林小雨站在门里，伞尖滴水。',
    '陈默（没抬头）说："伞放门边。"',
  ].join('\n')

  const fakeLlm = {
    listProviders: async () => [{ provider: 'raccoon', models: [{ id: 'sn-deepseek-v4-1-flash-1017' }] }],
    listModels: async () => [],
    stream: async () => (async function* () {
      yield { type: 'text-delta', text: scripted }
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

  const made = await table['novel.create']({ title: '雨里的门', idea: '一个人等着另一个人开口。' })
  t('先建一本书', made.ok === true, JSON.stringify(made).slice(0, 120))
  const id = made.id
  await table['novel.chapter.save']({ id, index: 1, body: '# 第一章 雨\n\n雨下了三天。她站在门里，伞尖滴水。' })

  const emptyGet = await table['novel.script.get']({ id, index: 1 })
  t('还没改过也能问，回空串不报错', emptyGet.ok === true && String(emptyGet.text ?? '') === '', JSON.stringify(emptyGet).slice(0, 120))

  const drafted = await table['novel.script.draft']({ id, index: 1 })
  t('改得出剧本', drafted.ok === true, JSON.stringify(drafted).slice(0, 200))
  t('改完顺便数了一遍', drafted.ok === true && drafted.scan !== undefined && drafted.scan.counts.scenes === 1, drafted.ok === true ? drafted.scan.counts : drafted.error)
  t('带上了给界面的报告', drafted.ok === true && String(drafted.report ?? '').includes('共 1 场'), drafted.ok === true ? String(drafted.report).slice(0, 60) : '')

  const notSavedYet = await table['novel.script.get']({ id, index: 1 })
  t('改完先不落盘（人要先看一眼）', notSavedYet.ok === true && String(notSavedYet.text ?? '') === '', JSON.stringify(notSavedYet).slice(0, 120))

  const saved = await table['novel.script.save']({ id, index: 1, text: drafted.text })
  t('存得下', saved.ok === true, JSON.stringify(saved).slice(0, 160))
  t('存在 scripts/001.md', String(saved.path ?? '').endsWith('scripts/001.md'), saved.path)

  const got = await table['novel.script.get']({ id, index: 1 })
  t('读得回来', got.ok === true && String(got.text).includes('伞放门边'), String(got.text).slice(0, 80))

  const listed = await table['novel.script.list']({ id })
  t('列得出改过哪几章', listed.ok === true && listed.scripts.length === 1 && Number(listed.scripts[0].index) === 1, JSON.stringify(listed).slice(0, 160))

  const badBook = await table['novel.script.draft']({ id: '没有这本书', index: 1 })
  t('书不存在时说人话', badBook.ok === false && String(badBook.error).includes('这本书'), badBook.error)

  const noIndex = await table['novel.script.draft']({ id, index: 9 })
  t('章不存在时说人话', noIndex.ok === false && String(noIndex.error).includes('第 9 章'), noIndex.error)

  const removed = await table['novel.script.delete']({ id, index: 1 })
  t('删得掉', removed.ok === true, JSON.stringify(removed).slice(0, 120))
  const afterDelete = await table['novel.script.get']({ id, index: 1 })
  t('删完就空了', afterDelete.ok === true && String(afterDelete.text ?? '') === '', JSON.stringify(afterDelete).slice(0, 120))

  const chapterStillThere = await table['novel.chapter.get']({ id, index: 1 })
  t('删剧本不动小说正文', chapterStillThere.ok === true && String(chapterStillThere.body).includes('雨下了三天'), String(chapterStillThere.body).slice(0, 60))
}

console.log('\n=== 7. 太长的章不许硬改（一次改不完） ===')
{
  const ctx = {
    webServer: { register: () => () => {} },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
    get: () => undefined,
  }
  const table = api.buildApi(ctx, async () => ws, { workspace: ws })
  const made = await table['novel.create']({ title: '很长的书' })
  await table['novel.chapter.save']({ id: made.id, index: 1, body: '雨'.repeat(21000) })
  const tooLong = await table['novel.script.draft']({ id: made.id, index: 1 })
  t('超过两万字的章让人先分成两章', tooLong.ok === false && String(tooLong.error).includes('分成两章'), tooLong.error)

  const madeEmpty = await table['novel.create']({ title: '空的书' })
  const emptyChapter = await table['novel.chapter.save']({ id: madeEmpty.id, index: 1, body: '' })
  t('空章存得下（占个位）', emptyChapter.ok === true, JSON.stringify(emptyChapter).slice(0, 120))
  const nothingToDo = await table['novel.script.draft']({ id: madeEmpty.id, index: 1 })
  t('空章说没什么可改的', nothingToDo.ok === false && String(nothingToDo.error).includes('没有东西可以改'), nothingToDo.error)
}

console.log('\n=== 8. 真实剧本里那些写法都要认得 ===')
{
  // 名字后面粘着「道 / 问 / 喊着说」，统计出场人物时不能算成另一个人。
  const a = novel.parseDialogueLine('林小雨道："走吧。"')
  t('「道」剥得掉', a !== null && a.who === '林小雨', a)
  const b = novel.parseDialogueLine('老周问："走不走？"')
  t('「问」剥得掉', b !== null && b.who === '老周', b)
  const c = novel.parseDialogueLine('林小雨喊着说："等等我！"')
  t('「喊着说」剥得掉', c !== null && c.who === '林小雨', c)

  // 直角引号也是引号：不少剧本和竖排小说都这么写。
  const d = novel.parseDialogueLine('林小雨：「走吧。」')
  t('直角引号认得', d !== null && d.text === '走吧。', d)
  const e = novel.parseDialogueLine('林小雨说：「走吧。」')
  t('直角引号 + 说认得', e !== null && e.who === '林小雨' && e.text === '走吧。', e)

  // 场头不能把台词认成地名。
  const scene = novel.parseScriptScenes(['《雨里的门》', '第1场', '旧书店 夜 内', '【出场人物】林小雨', '林小雨：「走吧。」', '△ 她把伞收起来。'].join('\n'))
  t('直角引号的台词没被当成场头', scene.scenes[0].place === '旧书店', scene.scenes[0].place)
  t('直角引号的台词算进台词数', scene.counts.dialogues === 1, scene.counts)

  // 带句读的行不是场头（地名里不会有逗号句号）。
  const bad = novel.parseScriptScenes(['第1场', '他推开门，外面天黑了 夜 内'].join('\n'))
  t('带逗号的句子不当场头', bad.scenes[0].place === '', bad.scenes[0].place)

  // 「他愣了两秒」是戏，不是镜头说明；「第 3 秒」才是。
  const s1 = novel.scanScript(['第1场', '客厅 日 内', '【出场人物】甲', '△ 他愣了两秒，才把门关上。'].join('\n'))
  t('「愣了两秒」不算写时长', s1.issues.every((i) => i.kind !== 'camera'), s1.issues.map((i) => i.kind))
  const s2 = novel.scanScript(['第1场', '客厅 日 内', '【出场人物】甲', '△ 第 3 秒，门开了。'].join('\n'))
  t('「第 3 秒」算写时长', s2.issues.some((i) => i.kind === 'camera'), s2.issues.map((i) => i.kind))
  const s3 = novel.scanScript(['第1场', '客厅 日 内', '【出场人物】甲', '△ 画面停留 2 秒。'].join('\n'))
  t('「停留 2 秒」算写时长', s3.issues.some((i) => i.kind === 'camera'), s3.issues.map((i) => i.kind))

  // 不给大纲是刻意的，但提示词里必须明说「不许替作者往下编」。
  const prompt = novel.buildScriptPrompt({ title: '试', chapterNo: 2, chapterBody: '他走了。' })
  t('提示词里写清不许自己往下编', prompt.includes('不许替作者往下编'), prompt.length)
}

console.log('\n=== 9. 改第二章时，把上一章剧本的最后一场带过去 ===')
{
  let seenPrompt = ''
  const fakeLlm = {
    listProviders: async () => [{ provider: 'raccoon', models: [{ id: 'sn-deepseek-v4-1-flash-1017' }] }],
    listModels: async () => [],
    stream: async (req) => {
      seenPrompt = JSON.stringify(req ?? {})
      return (async function* () {
        yield { type: 'text-delta', text: '第1场\n门口 夜 外\n【出场人物】陈默\n△ 他站在雨里。' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const ctx = {
    webServer: { register: () => () => {} },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
    get: (name) => (name === 'llm' ? fakeLlm : undefined),
  }
  const table = api.buildApi(ctx, async () => ws, { workspace: ws })
  const made = await table['novel.create']({ title: '接住的那本书' })
  const id = made.id
  await table['novel.chapter.save']({ id, index: 1, body: '第一章 他推开门。' })
  await table['novel.chapter.save']({ id, index: 2, body: '第二章 雨停了。' })
  await table['novel.script.save']({
    id, index: 1,
    text: '第1场\n旧书店 夜 内\n【出场人物】林小雨、陈默\n【关键道具】红伞\n△ 她把红伞靠在门边，伞尖滴水。\n陈默（没抬头）说："伞放门边。"',
  })

  const second = await table['novel.script.draft']({ id, index: 2 })
  t('第二章改得出来', second.ok === true, JSON.stringify(second).slice(0, 200))
  t('说了这是接着上一章改的', second.ok === true && second.continued === true, second.ok === true ? second.continued : '')
  // 拼进提示词的东西得真到模型手里：伞、门边、谁说的话，一个字都不能丢。
  t('上一场整段带进了提示词（道具与台词都在）',
    seenPrompt.includes('红伞') && seenPrompt.includes('伞放门边'), seenPrompt.slice(0, 300))
  t('上一场的位置也带过去了', seenPrompt.includes('旧书店'), seenPrompt.slice(0, 300))

  // 第一章没有剧本时不许瞎编一段「上一场」。
  const made2 = await table['novel.create']({ title: '没接上的书' })
  await table['novel.chapter.save']({ id: made2.id, index: 1, body: '第一章。' })
  await table['novel.chapter.save']({ id: made2.id, index: 2, body: '第二章。' })
  seenPrompt = ''
  const second2 = await table['novel.script.draft']({ id: made2.id, index: 2 })
  t('上一章没改过就不带上一场', second2.ok === true && second2.continued === false, second2.ok === true ? second2.continued : '')
}

console.log('\n=== 10. 空白剧本不落盘 ===')
{
  const ctx = {
    webServer: { register: () => () => {} },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
    get: () => undefined,
  }
  const table = api.buildApi(ctx, async () => ws, { workspace: ws })
  const made = await table['novel.create']({ title: '空白的那本' })
  const id = made.id
  await table['novel.chapter.save']({ id, index: 1, body: '第一章。' })
  // 存进来是空壳：以前直接删文件、回话还说「存好了」，磁盘上那份就再也找不回来。
  // 现在只回一句「空的，没往里存」，原来那份一动不动。
  const blank = await table['novel.script.save']({ id, index: 1, text: '   \n\n  ' })
  t('存空壳会被挡下来', blank.ok !== true && blank.blank === true, JSON.stringify(blank).slice(0, 160))
  t('挡下来的时候话说清楚了', String(blank.error ?? '').includes('空的'), String(blank.error ?? ''))
  const listed = await table['novel.script.list']({ id })
  t('书里不会留一个 0 场的空文件', listed.ok === true && listed.scripts.length === 0, JSON.stringify(listed).slice(0, 160))

  // 有内容的那份存下去之后，再存一次空壳，原来那份必须还在。
  await table['novel.script.save']({ id, index: 1, text: '第1场\n客厅 日 内\n【出场人物】甲\n△ 甲走进来。' })
  const kept = await table['novel.script.save']({ id, index: 1, text: '\u3000 \n' })
  t('全角空格也算空壳', kept.ok !== true && kept.blank === true, JSON.stringify(kept).slice(0, 160))
  const still = await table['novel.script.get']({ id, index: 1 })
  t('存空壳不许把原来那份抹掉', String(still.text).includes('甲走进来'), String(still.text).slice(0, 80))

  // 章号不对：0、负数、非数字、不存在的章，都不许悄悄盖到第 1 章去。
  for (const bad of [0, -1, 'abc', 9]) {
    const r = await table['novel.script.save']({ id, index: bad, text: '第1场\n客厅 日 内\n【出场人物】乙\n△ 有人进来。' })
    t(`章号 ${JSON.stringify(bad)} 会被挡下来`, r.ok !== true, JSON.stringify(r).slice(0, 160))
  }
  const untouched = await table['novel.script.get']({ id, index: 1 })
  t('章号不对的时候第 1 章没被盖掉', String(untouched.text).includes('甲走进来'), String(untouched.text).slice(0, 60))

  const noBook = await table['novel.script.get']({ id: '根本没有这本书', index: 1 })
  t('书不存在时说书不在了', noBook.ok !== true && String(noBook.error ?? '').includes('不在'), JSON.stringify(noBook).slice(0, 160))
  // 存完再存一次，覆盖而不是追加。
  await table['novel.script.save']({ id, index: 1, text: '第1场\n客厅 日 内\n【出场人物】甲\n△ 甲走进来。' })
  await table['novel.script.save']({ id, index: 1, text: '第1场\n客厅 夜 内\n【出场人物】甲\n△ 甲退出去。' })
  const again = await table['novel.script.get']({ id, index: 1 })
  t('再存一次是覆盖，不是追加', String(again.text).includes('退出去') && !String(again.text).includes('走进来'), String(again.text).slice(0, 80))
  t('存完只有一份', (await table['novel.script.list']({ id })).scripts.length === 1, '')
}

console.log('\n=== 10.5 删章的时候，那一章的剧本跟着走 ===')
{
  const ws2 = path.join(tmpdir(), `lc-script-del-${process.pid}-${Date.now()}`)
  await fs.mkdir(ws2, { recursive: true })
  await store.openWorkspace(ws2, { create: true })
  const ctx2 = {
    logger: { warn: () => {} },
    get: () => undefined,
  }
  const table2 = api.buildApi(ctx2, async () => ws2, { workspace: ws2 })
  const made = await table2['novel.create']({ title: '删章那本' })
  const id = made.id
  await table2['novel.chapter.save']({ id, index: 1, body: '第一章。' })
  await table2['novel.chapter.save']({ id, index: 2, body: '第二章。' })
  await table2['novel.script.save']({ id, index: 1, text: '第1场\n客厅 日 内\n【出场人物】甲\n△ 甲走进来。' })
  await table2['novel.script.save']({ id, index: 2, text: '第1场\n厨房 夜 内\n【出场人物】乙\n△ 乙站住。' })
  await table2['novel.chapter.delete']({ id, index: 1 })
  const left = await table2['novel.script.list']({ id })
  t('删掉的那一章，剧本也不留', left.ok === true && left.scripts.every((x) => x.index !== 1), JSON.stringify(left.scripts))
  t('别的章剧本还在', left.ok === true && left.scripts.some((x) => x.index === 2), JSON.stringify(left.scripts))
  await fs.rm(ws2, { recursive: true, force: true })
}

console.log('\n=== 10.6 场号的各种写法（从别处粘回来也要认） ===')
{
  const plan = (head) => {
    const p = novel.parseScriptScenes([head, '客厅 日 内', '【出场人物】甲', '△ 站着。'].join('\n'))
    return { n: p.counts.scenes, no: p.scenes[0]?.no ?? 0, place: p.scenes[0]?.place ?? '' }
  }
  const cases = [
    ['第3场', 3], ['第 3 场', 3], ['【第3场】', 3], ['场景3', 3], ['场3', 3],
    ['SCENE 3', 3], ['三、', 3], ['## 第3场', 3], ['**第3场**', 3], ['第一章 第3场', 3],
    ['第1章·第2场', 2], ['第１场', 1],
  ]
  for (const [head, want] of cases) {
    const got = plan(head)
    t(`场号「${head}」认得出是第 ${want} 场`, got.n === 1 && got.no === want && got.place === '客厅', JSON.stringify(got))
  }
  // 反过来：场内清单号不能被当成场号，否则一份好剧本被切成十几个假场。
  const inScene = novel.parseScriptScenes([
    '第1场', '客厅 日 内', '【出场人物】甲',
    '1. 他推开门。', '2. 他把伞放下。', '3.15 米宽的门。', '△ 站着。',
  ].join('\n'))
  t('场内清单号不切场', inScene.counts.scenes === 1, JSON.stringify(inScene.counts))
  // 「1.」当第一场也照样认——但点后面得真像场头。
  const numbered = novel.parseScriptScenes(['1. 客厅 日 内', '【出场人物】甲', '△ 站着。', '2. 门外 夜 外', '△ 走了。'].join('\n'))
  t('纯编号场头也认', numbered.counts.scenes === 2 && numbered.scenes[1].no === 2, JSON.stringify(numbered.counts))
}

console.log('\n=== 10.7 冒号左边塞了半句叙述、一行里两个人说话 ===')
{
  // 「这时候门开了，林小雨说：」——以前整串是说话人，演员表里就多出一个人。
  const muddy = novel.parseDialogueLine('这时候门开了，林小雨说："你来了。"')
  t('冒号左边的叙述不算名字', muddy !== null && muddy.who === '林小雨', JSON.stringify(muddy))
  t('台词本身没被截坏', muddy !== null && muddy.text === '你来了。', JSON.stringify(muddy))

  // 台词里套引号不能被当成「第二个人在说话」。
  const nested = novel.parseDialogueLine('甲说："他说"好"就挂断了。"')
  t('台词里的引号不算换人', nested !== null && nested.text === '他说"好"就挂断了。' && nested.rest === '', JSON.stringify(nested))

  // 一行两个人：只认第一句，第二句留成「没归位」，不许悄悄消失。
  const two = novel.parseScriptScenes(['第1场', '客厅 日 内', '【出场人物】甲', '△ 他站着。', '甲说："走。"乙说："等等。"', '△ 走了。'].join('\n'))
  t('一行两个人只算一句台词', two.counts.dialogues === 1, JSON.stringify(two.counts))
  t('第二句进了没归位', two.scenes[0].other.some((x) => String(x).includes('乙说')), JSON.stringify(two.scenes[0].other))

  // 一句话说完就没了的那种，不能被切。
  const plain = novel.parseDialogueLine('林小雨说："走吧。"')
  t('普通一句台词不被切', plain !== null && plain.text === '走吧。' && plain.rest === '', JSON.stringify(plain))
}

console.log('\n=== 10.8 模型真会写出来的那几种样子 ===')
{
  const shape = (raw) => {
    const s = novel.scanScript(novel.stripFence(raw))
    return { scenes: s.counts.scenes, actions: s.counts.actions, dialogues: s.counts.dialogues, issues: s.issues.map((i) => i.kind) }
  }
  const body = ['【出场人物】甲', '△ 他站着。', '甲说："走。"'].join('\n')

  const fenced = shape('```markdown\n第1场\n客厅 日 内\n' + body + '\n```')
  t('包在代码块里也能读', fenced.scenes === 1 && fenced.dialogues === 1, JSON.stringify(fenced))
  t('代码块不算问题', !fenced.issues.includes('stray'), JSON.stringify(fenced.issues))

  const bold = shape('**第1场 客厅 日 内**\n' + body)
  t('加粗的场头认得出', bold.scenes === 1, JSON.stringify(bold))
  t('加粗场头的日夜内外没被 `**` 粘坏', !bold.issues.includes('no-head'), JSON.stringify(bold.issues))

  const hash = shape('## 第3场 门外 夜 外\n' + body)
  t('markdown 标题的场头认得出', hash.scenes === 1 && !hash.issues.includes('no-head'), JSON.stringify(hash))

  // 模型爱在前面先说一句「好的，我按你的要求改成了剧本」。这行不算进戏，
  // 但要说出来，别让人以为它凭空不见了。
  const chatty = shape('好的，我按你的要求改成了剧本。\n\n第1场\n客厅 日 内\n' + body)
  t('开场那句话会被点出来', chatty.issues.includes('preamble'), JSON.stringify(chatty.issues))
  t('开场那句话不影响场数', chatty.scenes === 1, JSON.stringify(chatty))
}

console.log('\n=== 10.9 中文输入法下那些写法 ===')
{
  const head = (raw) => {
    const p = novel.parseScriptScenes('第1场\n' + raw + '\n【出场人物】甲\n△ 站着。')
    const s = p.scenes[0] ?? {}
    return { scenes: p.counts.scenes, place: s.place, dayNight: s.dayNight, inOut: s.inOut }
  }

  // 全角斜杠：中文输入法下「客厅／日／内」是最常见的写法之一，
  // 以前这一行读出来地点为空、日夜内外全空，整场等于没有场头。
  const full = head('客厅／日／内')
  t('全角斜杠的场头读得出来', full.place === '客厅' && full.dayNight === '日' && full.inOut === '内', JSON.stringify(full))
  const fullBar = head('客厅｜夜｜外')
  t('全角竖线的场头读得出来', fullBar.place === '客厅' && fullBar.dayNight === '夜' && fullBar.inOut === '外', JSON.stringify(fullBar))

  // 时间写在括号里
  const paren = head('客厅（日）内')
  t('括号里写时间的场头读得出来', paren.place === '客厅' && paren.dayNight === '日' && paren.inOut === '内', JSON.stringify(paren))

  // 地名自己带括号的，认不出来就不要硬猜：它会被报成「这行没归位」，
  // 让人自己看一眼，比瞎拆成「客厅（二楼）」好。
  const tricky = head('客厅（二楼）日 内')
  t('带括注的地名不瞎拆', tricky.place !== '客厅（二楼）日 内', JSON.stringify(tricky))

  // 全角空格：`客厅　日　内`（U+3000）也得认
  const ideo = head('客厅\u3000日\u3000内')
  t('全角空格的场头读得出来', ideo.place === '客厅' && ideo.dayNight === '日', JSON.stringify(ideo))

  // `甲：（低声）"走吧。"` —— 括号写在冒号后面
  const late = novel.parseDialogueLine('甲：（低声）"走吧。"')
  t('括号写在冒号后面也认', late !== null && late.who === '甲' && late.paren === '低声' && late.text === '走吧。', JSON.stringify(late))

  // 外国名字里的点不是分隔符
  const foreign = novel.parseDialogueLine('迈克尔·柯里昂说："记住我这句话。"')
  t('外国名字整个算一个人', foreign !== null && foreign.who === '迈克尔·柯里昂', JSON.stringify(foreign))
}

console.log('\n=== 10.10 镜头话的两难：什么算分镜，什么是戏里的人手里有台相机 ===')
{
  const issue = (line) => novel.scanScript('第1场\n客厅 日 内\n【出场人物】甲\n' + line).issues.map((i) => i.kind)

  // 该报：行首就是「镜头」，后面跟的是运镜动作。
  for (const line of ['△ 镜头慢慢拉开。', '△ 镜头缓缓推近。', '△ 镜头对准门口。', '△ 镜头一转。', '△ 镜头一路跟着他出了门。', '△ 摄像机跟着他走。', '△ 镜头：他背对着门。']) {
    t(`分镜写法报得出来：${line}`, issue(line).includes('camera'), JSON.stringify(issue(line)))
  }

  // 不该报：同几个字出现在戏里。
  for (const line of ['△ 他举起相机，镜头对准窗外。', '△ 拉开镜头盖。', '△ 他对着镜头笑了一下。', '△ 她一秒都没停。', '△ 收音机里在念旁白。', '△ 桌上摊着一叠分镜稿。']) {
    t(`正常戏份不误报：${line}`, !issue(line).includes('camera'), JSON.stringify(issue(line)))
  }
}

console.log('\n=== 10.11 markdown 列表符与箭头 ===')
{
  const shape = (raw) => { const s = novel.scanScript(raw); return { scenes: s.counts.scenes, actions: s.counts.actions, thoughts: s.counts.thoughts, issues: s.issues.map((i) => i.kind) } }

  // 模型爱把场次写成 markdown 列表。以前整份读成 0 场。
  const bullet = shape('- 第1场\n- 客厅 日 内\n【出场人物】甲\n△ 站着。')
  t('减号列表的场头认得出', bullet.scenes === 1, JSON.stringify(bullet))
  t('减号列表不报「没有一场」', !bullet.issues.includes('no-scene'), JSON.stringify(bullet.issues))

  const ordered = shape('1) 客厅 日 内\n【出场人物】甲\n△ 站着。')
  t('有序列表的场头认得出', ordered.scenes === 1, JSON.stringify(ordered))

  // 箭头当动作行：中文输入法里 → 比 △ 好打，模型也常写。
  const arrow = shape('第1场\n客厅 日 内\n【出场人物】甲\n→ 他推开门。')
  t('箭头算动作行', arrow.actions === 1, JSON.stringify(arrow))
  t('箭头不算没归位', !arrow.issues.includes('stray'), JSON.stringify(arrow.issues))

  // 箭头 + 心里话：拆成两样。
  const both = shape('第1场\n客厅 日 内\n【出场人物】甲\n→ 他站着。（心里想：他走了。）')
  t('箭头行里的心里话拆得出来', both.thoughts === 1 && both.actions === 1, JSON.stringify(both))
}

console.log('\n=== 11. 提示词自己的样例，必须能被解析器原样吃下去 ===')
{
  // 以前样例里写的是占位符「场景名 日/夜 内/外」，模型照抄就写成
  // 「场景名 夜 外」，四项全错，而且日夜内外都非空，扫描器还报不出来。
  const prompt = novel.buildScriptPrompt({ title: '雨里的门', chapterNo: 1, chapterBody: '雨下了三天。' })
  t('样例里没有占位符「日/夜 内/外」', !prompt.includes('日/夜 内/外'), prompt.slice(-900))
  // 把样例那几行原样抠出来，喂给解析器。
  const tail = prompt.slice(prompt.indexOf('《剧本名》'))
  const sample = tail.slice(0, tail.indexOf('只给剧本本身')).trim()
  const parsed = novel.parseScriptScenes(sample)
  t('样例是两场', parsed.counts.scenes === 2, parsed.counts)
  t('样例的场头四项都对', parsed.scenes[0].place !== '' && parsed.scenes[0].dayNight === '夜' && parsed.scenes[0].inOut === '内', parsed.scenes[0])
  t('样例的台词认得出', parsed.counts.dialogues === 2, parsed.counts)
  t('样例的道具认得出', parsed.scenes[0].props.includes('红伞'), parsed.scenes[0].props)
  const scan = novel.scanScript(sample)
  t('样例自己扫一遍零问题', scan.issues.length === 0, scan.issues.map((i) => i.kind + ':' + i.label))
}

console.log('\n=== 12. 心里想的那一句，不能被人当成出场人物 ===')
{
  const p = novel.parseScriptScenes(['第1场', '客厅 日 内', '【出场人物】甲', '△ 他站着。', '（心里想：他不会回来了。）'].join('\n'))
  t('括号里的心里话不进出场人物', p.scenes[0].cast.length === 1 && p.scenes[0].cast[0] === '甲', p.scenes[0].cast)
  t('单独算成一类', p.scenes[0].thoughts.length === 1 && p.scenes[0].thoughts[0].text === '他不会回来了。', p.scenes[0].thoughts)
  t('心里话不算台词', p.counts.dialogues === 0, p.counts)
  t('也不报「没归位」', novel.scanScript(['第1场', '客厅 日 内', '【出场人物】甲', '△ 他站着。', '（心里想：他不会回来了。）'].join('\n')).issues.every((i) => i.kind !== 'stray'), '')

  const halfWidth = novel.parseThoughtLine('(心想：完了)')
  t('半角括号也认', halfWidth !== null && halfWidth.text === '完了', halfWidth)
  t('不是心里话的不乱认', novel.parseThoughtLine('（他把碗放下）') === null, '')
}

console.log('\n=== 13. 台词里套引号、场号写中文数字 ===')
{
  const nested = novel.parseDialogueLine('甲说："他说"好"就挂断了。"')
  t('台词里再套引号也解析得出来', nested !== null && nested.text.includes('就挂断了'), nested)
  const p = novel.parseScriptScenes(['第一场', '客厅 日 内', '【出场人物】甲', '△ 他站着。', '第二场', '门外 夜 外', '【出场人物】甲', '△ 他走了。'].join('\n'))
  t('「第一场」认得出', p.counts.scenes === 2, p.counts)
  t('「第二场」的号是 2', p.scenes[1].no === 2, p.scenes.map((x) => x.no))
  const twelve = novel.parseScriptScenes(['第十二场', '客厅 日 内'].join('\n'))
  t('「第十二场」是 12', twelve.scenes[0].no === 12, twelve.scenes[0].no)
}

console.log('\n=== 14. 场号下面紧跟的叙述，不许被当成地名吞掉 ===')
{
  // 只有地名的一行看着也像叙述，所以场头必须写了日夜或内外才算数。
  const p = novel.parseScriptScenes(['第1场', '他把碗放下', '△ 他站着。'].join('\n'))
  t('没写日夜内外的短句不当场头', p.scenes[0].place === '', p.scenes[0].place)
  t('它落在「没归位」里，能被数出来', novel.scanScript(['第1场', '他把碗放下', '△ 他站着。'].join('\n')).issues.some((i) => i.kind === 'stray'), '')

  // 【出场人物】下面直接接叙述，也不能当成人名。
  const q = novel.parseScriptScenes(['第1场', '客厅 日 内', '【出场人物】甲、乙', '他把碗放下。', '△ 他站着。'].join('\n'))
  t('出场人物下面那行叙述不当人名', q.scenes[0].cast.length === 2, q.scenes[0].cast)
  t('那行报出来了', novel.scanScript(['第1场', '客厅 日 内', '【出场人物】甲、乙', '他把碗放下。', '△ 他站着。'].join('\n')).issues.some((i) => i.kind === 'stray'), '')
}

console.log('\n=== 15. 镜头词：戏里出现的东西不算，写成说明才算 ===')
{
  const head = ['第1场', '客厅 日 内', '【出场人物】甲'].join('\n') + '\n'
  const cam = (line) => novel.scanScript(head + line).issues.some((i) => i.kind === 'camera')
  t('电视上滚过字幕是戏', cam('△ 电视屏幕上滚过一行字幕：明早停水。') === false, '')
  t('隔壁放背景音乐是戏', cam('△ 隔壁在放背景音乐，很轻。') === false, '')
  t('「加字幕」是镜头话', cam('△ 加字幕：三年后。') === true, '')
  // 「字幕：三年后」以前报镜头话。现在它算旁白那一类——同一个毛病报一次就够，
  // 报成两条只会让人觉得这个检查在乱咬。
  const sub = novel.scanScript(head + '字幕：三年后。')
  t('单独一行「字幕：三年后」算旁白', sub.issues.some((i) => i.kind === 'narrator'), sub.issues.map((i) => i.kind))
  t('它不再重复报成镜头话', sub.issues.every((i) => i.kind !== 'camera'), sub.issues.map((i) => i.kind))
  t('旁白直接报', cam('△ 旁白响起。') === true, '')
  t('镜头推近直接报', cam('△ 镜头推近。') === true, '')
  // 常见时刻也得认，不然好端端的场头被当成没写日夜。
  const noon = novel.parseScriptScenes(['第1场', '客厅 午后 内'].join('\n'))
  t('「午后」算写了日夜', noon.scenes[0].dayNight === '午后', noon.scenes[0])
  const dawn = novel.parseScriptScenes(['第1场', '门口 凌晨 外'].join('\n'))
  t('「凌晨」算写了日夜', dawn.scenes[0].dayNight === '凌晨', dawn.scenes[0])
}

console.log('\n=== 16. 模型把剧本包进三引号里，得先剥掉 ===')
{
  const raw = ['```markdown', '第1场', '客厅 日 内', '【出场人物】甲', '△ 他站着。', '```'].join('\n')
  const out = novel.stripFence(raw)
  t('围栏剥掉了', !out.includes('```'), out)
  t('剥完就认得出场头', novel.parseScriptScenes(out).counts.scenes === 1, novel.parseScriptScenes(out).counts)
  t('剥完不再报「没归位」', novel.scanScript(out).issues.every((i) => i.kind !== 'stray'), '')
  t('本来就干净的剧本原样不动', novel.stripFence('第1场\n客厅 日 内') === '第1场\n客厅 日 内', '')
  t('只有半截围栏也好办', novel.stripFence('```\n第1场\n客厅 日 内').trim().startsWith('第1场'), novel.stripFence('```\n第1场\n客厅 日 内'))
}

console.log('\n=== 17. 场号的几种真实写法都要认 ===')
{
  const one = (head) => novel.parseScriptScenes([head, '【出场人物】甲', '△ 站着。'].join('\n'))
  t('「第1场 旧书店 夜 内」一行写完', one('第1场 旧书店 夜 内').scenes[0].place === '旧书店', one('第1场 旧书店 夜 内').scenes[0])
  t('「【第1场】」带方括号', one('【第1场】旧书店 夜 内').counts.scenes === 1, '')
  t('「1. 旧书店 夜 内」有人就这么写', one('1. 旧书店 夜 内').scenes[0].place === '旧书店', '')
  t('「场景1 旧书店 夜 内」也认', one('场景1 旧书店 夜 内').scenes[0].place === '旧书店', '')
  t('全角数字「１.」认得出', one('１. 旧书店 夜 内').counts.scenes === 1, '')
  t('全角「场景３」号是 3', one('场景３ 门口 夜 外').scenes[0].no === 3, one('场景３ 门口 夜 外').scenes[0].no)
  t('「第一场：旧书店」冒号后面当场名', one('第一场：旧书店').scenes[0].place === '旧书店', one('第一场：旧书店').scenes[0])
  const withNo = (head) => novel.parseScriptScenes(['第1场', head, '【出场人物】甲', '△ 站着。'].join('\n')).scenes[0]
  t('场名带「内」字不被拆', withNo('内务府 日 内').place === '内务府' && withNo('内务府 日 内').inOut === '内', withNo('内务府 日 内'))
  t('场名带「外」字不被拆', withNo('外滩 夜 外').place === '外滩' && withNo('外滩 夜 外').inOut === '外', withNo('外滩 夜 外'))
}

await fs.rm(ws, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
