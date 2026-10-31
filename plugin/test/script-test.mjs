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

console.log('\n=== 10.12 模型真会写出来的那些样子（审查员 49f9a6d8 的十二条） ===')
{
  const S = (raw) => novel.scanScript(raw)
  const kinds = (raw) => S(raw).issues.map((i) => i.kind)
  const base = (body) => `第1场\n客厅 日 内\n【出场人物】甲\n${body}`

  // ① 整行加粗的台词：以前 dialogues=0、报「没归位」。
  {
    const sc = novel.parseScriptScenes(base('△ 他把碗放下。\n**甲（没抬头）说："走。"**'))
    t('加粗的台词照样读得出来', sc.scenes[0].dialogues.length === 1, String(sc.scenes[0].dialogues.length))
    t('加粗台词不报没归位', !kinds(base('△ 他把碗放下。\n**甲（没抬头）说："走。"**')).includes('stray'), JSON.stringify(kinds(base('△ 他把碗放下。\n**甲（没抬头）说："走。"**'))))
  }

  // ② 场头单独一行加粗 / 井号。
  for (const head of ['**客厅 日 内**', '## 客厅 日 内', '*客厅 日 内*']) {
    const sc = novel.parseScriptScenes(`第1场\n${head}\n【出场人物】甲\n△ 站着。`)
    t(`单独一行的场头读得出来：${head}`, sc.scenes[0].place === '客厅' && sc.scenes[0].inOut === '内', JSON.stringify({ place: sc.scenes[0].place, inOut: sc.scenes[0].inOut }))
  }

  // ③ 场头后面跟一句备注。
  {
    const sc = novel.parseScriptScenes('第1场\n客厅 日 内（回忆场，可加旧滤镜）\n【出场人物】甲\n△ 站着。')
    t('场头后面带备注，地点还是干净的', sc.scenes[0].place === '客厅' && sc.scenes[0].dayNight === '日', JSON.stringify({ place: sc.scenes[0].place, dayNight: sc.scenes[0].dayNight }))
    t('场头带备注不报没场头', !kinds('第1场\n客厅 日 内（回忆场，可加旧滤镜）\n【出场人物】甲\n△ 站着。').includes('no-head'), '')
  }

  // ④ 台词后面紧跟一个括注。
  {
    const said = novel.parseDialogueLine('甲说："走。"（把门带上）')
    t('台词后面的括注并进这一句', said !== null && said.text === '走。' && said.paren === '把门带上', JSON.stringify(said))
    t('台词后括注不报没归位', !kinds(base('△ 站着。\n甲说："走。"（把门带上）')).includes('stray'), '')
  }

  // ⑤ 一个人跨行说两段。
  {
    const sc = novel.parseScriptScenes(base('△ 站着。\n甲说："我跟你说，\n这事儿没完。"'))
    t('跨行的两段话并成一句', sc.scenes[0].dialogues.length === 1 && sc.scenes[0].dialogues[0].text === '我跟你说，这事儿没完。', JSON.stringify(sc.scenes[0].dialogues))
  }

  // ⑥ 名字里带空格。
  {
    const sc = novel.parseScriptScenes('第1场\n客厅 日 内\n【出场人物】林 小雨、甲\n△ 站着。')
    t('有顿号时名字里的空格不当分隔', sc.scenes[0].cast[0] === '林 小雨' && sc.scenes[0].cast.length === 2, JSON.stringify(sc.scenes[0].cast))
    const sc2 = novel.parseScriptScenes('第1场\n客厅 日 内\n【出场人物】林小雨 甲 乙\n△ 站着。')
    t('没有分隔符时空格照旧当分隔', sc2.scenes[0].cast.length === 3, JSON.stringify(sc2.scenes[0].cast))
  }

  // 「甲又说」不能变成一个人叫「甲又」。
  t('「甲又说」读成甲', (novel.parseDialogueLine('甲又说："我等你。"') ?? {}).who === '甲', JSON.stringify(novel.parseDialogueLine('甲又说："我等你。"')))

  // ⑦ 括注节拍行。
  for (const beat of ['（沉默）', '（他站起来）']) {
    t(`括注节拍不当没归位：${beat}`, !kinds(base(`△ 他把碗放下。\n${beat}`)).includes('stray'), JSON.stringify(kinds(base(`△ 他把碗放下。\n${beat}`))))
  }

  // ⑧ 只有心里话（或只有一行「（沉默）」）的场，算是空场。
  // 一场戏里只有一句心里想的，拍出来就是一个站着不动的空镜头，
  // 配音也一句词都没有。以前这两种算作不空，于是这种场一条提示都不报。
  t('只有一句心里话算空场', kinds(base('（心里想：他不会回来了。）')).includes('empty-scene'), JSON.stringify(kinds(base('（心里想：他不会回来了。）'))))
  t('只有一行沉默算空场', kinds(base('（沉默）')).includes('empty-scene'), JSON.stringify(kinds(base('（沉默）'))))
  t('有动作就不是空场', !kinds(base('△ 他把碗放下。\n（心里想：他不会回来了。）')).includes('empty-scene'), JSON.stringify(kinds(base('△ 他把碗放下。\n（心里想：他不会回来了。）'))))
  // 心里话一场最多一句，这条一直写在提示词里，可扫描器从来不看。
  {
    const three = kinds(base('△ 他站着。\n（心里想：他不会回来了。）\n（心里想：雨还在下。）'))
    t('心里话超过一句要报', three.includes('too-many-thoughts'), JSON.stringify(three))
    const one = kinds(base('△ 他站着。\n（心里想：他不会回来了。）'))
    t('一句心里话不许报', !one.includes('too-many-thoughts'), JSON.stringify(one))
  }

  // ⑨ 「停留 3 分钟」不是秒，「停留 2 秒」才是。
  t('停留 3 分钟不算时长', !kinds(base('△ 队伍在门口停留 3 分钟才挪一步。')).includes('camera'), JSON.stringify(kinds(base('△ 队伍在门口停留 3 分钟才挪一步。'))))
  t('停留 2 秒算时长', kinds(base('△ 他在门口停留 2 秒才挪一步。')).includes('camera'), JSON.stringify(kinds(base('△ 他在门口停留 2 秒才挪一步。'))))

  // ⑩ 「他放慢动作」是戏，「用慢动作」是分镜。
  t('放慢动作不误报', !kinds(base('△ 他放慢动作，把碗轻轻放下。')).includes('camera'), JSON.stringify(kinds(base('△ 他放慢动作，把碗轻轻放下。'))))
  t('用慢动作要报', kinds(base('△ 这段用慢动作。')).includes('camera'), JSON.stringify(kinds(base('△ 这段用慢动作。'))))

  // ⑪ 中文语言标记的围栏。
  t('认中文语言标记的围栏', novel.stripFence('```剧本\n第1场\n客厅 日 内\n△ 站着。\n```') === '第1场\n客厅 日 内\n△ 站着。', JSON.stringify(novel.stripFence('```剧本\n第1场\n客厅 日 内\n△ 站着。\n```')))

  // ⑫ 围栏后面多说的话要丢掉。
  {
    const got = novel.stripFence('```\n第1场\n客厅 日 内\n【出场人物】甲\n△ 站着。\n```\n以上是第1场，需要我再展开吗？')
    t('围栏后面多说的话不留在正文里', !got.includes('以上是第1场'), JSON.stringify(got))
    t('围栏后面多说的话不产生没归位', !kinds('```\n第1场\n客厅 日 内\n【出场人物】甲\n△ 站着。\n```\n以上是第1场，需要我再展开吗？').includes('stray'), '')
  }
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

console.log('\n=== 18. 落盘这一层：章号、重名、失败话术 ===')
{
  // 章号：`chapterFileName` 自己还留着兜底（读的时候无害），但**写盘前**必须先过
  // `isValidChapterIndex`——它以前把 0 / -1 / 'abc' 全夹成 1，写下去就是盖掉第 1 章。
  t('0 不是合法章号', novel.isValidChapterIndex(0) === false, '')
  t('-1 不是合法章号', novel.isValidChapterIndex(-1) === false, '')
  t('1.9 不是合法章号', novel.isValidChapterIndex(1.9) === false, '')
  t("'abc' 不是合法章号", novel.isValidChapterIndex('abc') === false, '')
  t('null 不是合法章号', novel.isValidChapterIndex(null) === false, '')
  t('1 是合法章号', novel.isValidChapterIndex(1) === true, '')
  t("'3' 也认（界面上是字符串）", novel.isValidChapterIndex('3') === true, '')
  t('超过上限也不行', novel.isValidChapterIndex(100000) === false, '')

  const ctx3 = {
    webServer: { register: () => () => {} },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
    get: () => undefined,
  }
  const ws3 = path.join(tmpdir(), `lc-script-land-${process.pid}-${Date.now()}`)
  await fs.mkdir(ws3, { recursive: true })
  await store.openWorkspace(ws3, { create: true })
  const table3 = api.buildApi(ctx3, async () => ws3, { workspace: ws3 })
  const made3 = await table3['novel.create']({ title: '落盘那本' })
  const id3 = made3.id
  await table3['novel.chapter.save']({ id: id3, index: 1, body: '第一章。' })
  await table3['novel.chapter.save']({ id: id3, index: 2, body: '第二章。' })

  // 改剧本也别拿非法章号去改：以前悄悄改成第 1 章。
  for (const bad of [0, -1, 'abc', 1.9]) {
    const r = await table3['novel.script.draft']({ id: id3, index: bad })
    t(`改剧本时章号 ${JSON.stringify(bad)} 会被挡下来`, r.ok !== true, JSON.stringify(r).slice(0, 120))
  }
  // 不给章号：用最后一章，不许报错。
  const auto = await novel.readChapter(ws3, id3, 2)
  t('书里第 2 章在（下面那几组要用）', auto.ok === true, JSON.stringify(auto).slice(0, 100))

  // 同一章写成 1.md 和 001.md 两份：列出来只许一条，不许并列两条 1。
  const dir = path.join(ws3, 'books', id3, 'scripts')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, '1.md'), '第1场\n客厅 日 内\n【出场人物】甲\n△ 甲站着。', 'utf8')
  await fs.writeFile(path.join(dir, '001.md'), '第1场\n客厅 夜 内\n【出场人物】甲\n△ 甲坐着。', 'utf8')
  await fs.writeFile(path.join(dir, '002.MD'), '第1场\n门外 日 外\n【出场人物】乙\n△ 乙走过。', 'utf8')
  const listed3 = await novel.listScripts(ws3, id3)
  const ones = listed3.scripts.filter((x) => x.index === 1)
  t('1.md 和 001.md 只算一条', ones.length === 1, JSON.stringify(listed3.scripts.map((x) => x.file)))
  t('留的是名字规范的那份（001.md）', ones.length === 1 && ones[0].file === '001.md', ones.map((x) => x.file))
  t('002.MD 也认成第 2 章', listed3.scripts.some((x) => x.index === 2 && x.file === '002.MD'), JSON.stringify(listed3.scripts.map((x) => x.file)))

  // 写失败的话术：不许一律报「磁盘满了」。用一个必然失败的路径（拿文件当目录）。
  const blocker = path.join(ws3, 'books', id3, 'scripts')
  await fs.rm(blocker, { recursive: true, force: true })
  await fs.writeFile(blocker, 'not a dir', 'utf8')
  const failed = await novel.writeScript(ws3, id3, 1, '第1场\n客厅 日 内\n△ 站着。')
  t('写不进去时能说清是没存上', failed.ok !== true, JSON.stringify(failed).slice(0, 140))
  t('写不进去时不硬说「磁盘满了」', !String(failed.error ?? '').includes('磁盘'), String(failed.error ?? ''))
  const leftovers = await fs.readdir(path.join(ws3, 'books', id3)).catch(() => [])
  t('写失败不留临时文件', leftovers.every((x) => !x.includes('.tmp-')), JSON.stringify(leftovers))

  // 书的位置被文件夹占住时也不许出现「命令行」这种词。
  const broken = await table3['novel.get']({ id: '不存在的那本' })
  t('书不在时话说得干净', broken.ok !== true && !String(broken.error ?? '').includes('命令行'), String(broken.error ?? ''))

  await fs.rm(ws3, { recursive: true, force: true })
}

await fs.rm(ws, { recursive: true, force: true })

// ── 审查员 ab79af5e 那一批的回归（他挑的都是「静默丢东西」）────────────
// 这组的意义不在「修好了」，而在「以后谁再改坏，这里会红」。
{
  const kinds = (text) => novel.scanScript(text).issues.map((x) => x.kind)
  const parse = (text) => novel.parseScriptScenes(text)

  // ① 跨行续词不许吞掉后面的行：早先只要「冒号 + 开引号 + 行尾没闭引号」就一路吞，
  //    最多吞掉整整一场，吞掉的东西哪一栏都不进，扫描器一条不报。
  {
    const t1 = '第1场\n旧书店　夜　内\n【出场人物】甲、乙\n△她把伞靠在门边。\n甲说："走。"（转身）\n乙说："别急。"'
    const got = parse(t1).scenes[0].dialogues.map((d) => d.who)
    t('台词后面带括注，下一句台词不许被吞', got.length === 2 && got[1] === '乙', JSON.stringify(got))
    t('带括注的台词也不许报「没归位」', !kinds(t1).includes('stray'), JSON.stringify(kinds(t1)))
  }
  {
    // 台词后面紧跟一句还没改成动作的叙述：那句叙述要报 stray（提醒人改），
    // 但下一句台词一句都不许丢。
    const t2 = '第1场\n旧书店　夜　内\n【出场人物】林小雨、陈默\n△她把伞靠在门边。\n林小雨说："我等了三个钟头。"她低着头，没看他。\n陈默说："我知道。"\n△陈默没有看她。'
    const said = parse(t2).scenes[0].dialogues.map((d) => d.who)
    t('台词后紧跟叙述，下一句台词不许被吞', said.includes('林小雨') && said.includes('陈默'), JSON.stringify(said))
    t('没改成动作的叙述要报出来', kinds(t2).includes('stray'), JSON.stringify(kinds(t2)))
  }
  {
    // 漏一个闭引号：以前会把下一整场（场号、场头、出场人物）并进这句台词。
    const t3 = '第1场\n旧书店　夜　内\n【出场人物】甲\n△她把伞靠在门边。\n甲说："你听我说。\n第2场\n门外　夜　外\n【出场人物】乙\n乙说："开门。"'
    t('漏闭引号不许把下一场并进来', parse(t3).counts.scenes === 2, JSON.stringify(parse(t3).counts))
    t('下一场那句台词还在', parse(t3).scenes[1].dialogues.some((d) => d.who === '乙'), JSON.stringify(parse(t3).scenes[1].dialogues))
  }
  {
    // 正常的跨行续词照样要能合起来，别为了修上面的把这条改坏。
    const t4 = '第1场\n客厅　夜　内\n【出场人物】甲\n甲说："我跟你说，\n这事儿没完。"'
    const said = parse(t4).scenes[0].dialogues
    t('正常的跨行续词还能合起来', said.length === 1 && said[0].text.includes('这事儿没完'), JSON.stringify(said))
  }

  // ② 场头里带「里面 / 外头」：地名要留下，不许整段被当内外词吞掉。
  {
    const one = (h) => parse(`第1场\n${h}\n【出场人物】甲\n△站着。`).scenes[0]
    t('「院子里面」地名留得住', one('院子里面 日 内').place === '院子', JSON.stringify(one('院子里面 日 内')))
    t('「店外头」地名留得住', one('店外头 夜 外').place === '店', JSON.stringify(one('店外头 夜 外')))
  }

  // ③④ 镜头词：戏里的摄像机、升格成、黑场子不许报；真分镜一条都不许漏。
  {
    const on = (line) => kinds(`第1场\n客厅 日 内\n【出场人物】甲\n△他把碗放下。\n${line}`)
    const noReport = [
      '△婚礼上，他扛着摄像机满场跑。',
      '△这几年的日子，把他的性子升格成了一种沉默。',
      '△院里的黑场子里堆着煤。',
      '△他把窗帘拉上，屋里暗下来，像淡入的夜。',
    ]
    for (const line of noReport) t(`戏里的东西不报成镜头话：${line.slice(0, 12)}`, !on(line).includes('camera'), JSON.stringify(on(line)))

    const mustReport = [
      '△特写她的手。',
      '△近景：她的眼睛。',
      '△俯拍：旧书店全貌。',
      '△摇镜从书架扫到门口。',
      '△推镜到伞尖。',
      '△加一个定格。',
      '△插一个回忆闪回。',
      '△配乐起，BGM盖住雨声。',
      '△光线：侧逆光，暖调。',
      '△画面渐暗，转场。',
      '△镜头从门外推进到脸上。',
      '△切到陈默翻账本的手。',
    ]
    for (const line of mustReport) t(`真分镜要报出来：${line.slice(0, 12)}`, on(line).includes('camera'), JSON.stringify(on(line)))
  }

  // ⑤ 中文剧本最标准的不带引号台词，不许整行作废。
  {
    const one = parse('第1场\n客厅 日 内\n【出场人物】甲\n甲：走吧。\n△他推开门。').scenes[0]
    t('不带引号的台词认得出', one.dialogues.length === 1 && one.dialogues[0].who === '甲', JSON.stringify(one.dialogues))
    t('不带引号的台词不报「没归位」', !kinds('第1场\n客厅 日 内\n【出场人物】甲\n甲：走吧。\n△他推开门。').includes('stray'), '')
    const paren = novel.parseDialogueLine('林小雨（低声）：走吧。')
    t('不带引号也能带括注', paren !== null && paren.who === '林小雨' && paren.paren === '低声', JSON.stringify(paren))
  }

  // ⑥ 括注节拍算动作：写了「（他把碗放下）」就不该再说「这一场只有台词、没有动作」。
  {
    const beats = '第1场\n客厅 日 内\n【出场人物】甲\n（他把碗放下）\n甲说："吃吧。"'
    t('括注节拍不算「没有动作」', !kinds(beats).includes('no-action'), JSON.stringify(kinds(beats)))
  }

  // ⑦ 场号：第1幕 / 幕1 / 场次3 都要认。
  {
    for (const head of ['第1幕', '幕1', '场次3', '1.']) {
      const n = parse(`${head}\n客厅 日 内\n【出场人物】甲\n△站着。`).counts.scenes
      t(`场号写法「${head}」认得出`, n === 1, String(n))
    }
    // 「1.」单独一行、场头下一行：不许把「1. 他推开门。」那种编号行也认了。
    t('「1.」后面跟着真场头才算场号', parse('1.\n门外 夜 外\n【出场人物】乙\n△站着。').counts.scenes === 1, '')
    t('「1. 他推开门。」不算场号', parse('第1场\n客厅 日 内\n【出场人物】甲\n1. 他推开门。').counts.scenes === 1, JSON.stringify(parse('第1场\n客厅 日 内\n【出场人物】甲\n1. 他推开门。').counts))
  }

  // ⑧ 【出场人物】写「无」或者空着，不算「写清了谁在这场」；「无」也不是人名。
  {
    for (const empty of ['', '无', '-', '（无）']) {
      const text = `第1场\n客厅 日 内\n【出场人物】${empty}\n△站着。`
      const scene = parse(text).scenes[0]
      t(`出场人物写「${empty}」不算写清了`, scene.declared !== true, JSON.stringify(scene.cast))
      t(`出场人物写「${empty}」要提示`, kinds(text).includes('no-cast'), JSON.stringify(kinds(text)))
    }
  }

  // ⑨ 台词的两个硬上限以前是「整行作废」，现在是「照常认下来」。
  {
    const longParen = novel.parseDialogueLine(`林小雨（${'把伞收起来。'.repeat(20).slice(0, 80)}）说："你拿着吧。"`)
    t('括注 80 字也照常认', longParen !== null && longParen.who === '林小雨' && longParen.text === '你拿着吧。', JSON.stringify(longParen && { who: longParen.who, text: longParen.text }))
    const longName = novel.parseDialogueLine(`${'站在门口那个人'.repeat(4).slice(0, 28)}说："你来了。"`)
    t('名字 28 字也照常认', longName !== null && longName.who.startsWith('站在门口'), JSON.stringify(longName && longName.who))
    const halfParen = novel.parseDialogueLine('甲(低声)说："走吧。"')
    t('半角括号进括注、不进人名', halfParen !== null && halfParen.who === '甲' && halfParen.paren === '低声', JSON.stringify(halfParen))
    const tailed = novel.parseDialogueLine('甲说："好。"他转身走了。')
    t('台词后面跟一句叙述，台词照样认得出', tailed !== null && tailed.text === '好。' && tailed.rest === '他转身走了。', JSON.stringify(tailed))
  }

  // ⑩ 日夜白名单：日间 / 晚间 / 早 都算。
  {
    for (const day of ['日间', '晚间', '早']) {
      const scene = parse(`第1场\n客厅 ${day} 内\n【出场人物】甲\n△站着。`).scenes[0]
      t(`日夜写法「${day}」认得出`, scene.dayNight === day && scene.place === '客厅', JSON.stringify({ place: scene.place, dayNight: scene.dayNight }))
    }
    const clock = parse('第1场\n客厅 深夜两点 内\n【出场人物】甲\n△站着。').scenes[0]
    t('「深夜两点」当场头认得出', clock.dayNight === '深夜两点' && clock.place === '客厅', JSON.stringify({ place: clock.place, dayNight: clock.dayNight }))
  }

  // ⑪ 库函数层也校验这一章在不在，不然会写出一份永远显示不出来的孤儿剧本。
  {
    const ws4 = await fs.mkdtemp(path.join(tmpdir(), 'lc-script-target-'))
    await store.openWorkspace(ws4, { create: true })
    const made = await novel.createBook(ws4, { title: '孤儿排查' })
    await novel.writeChapter(ws4, made.id, 1, '正文')
    const orphan = await novel.writeScript(ws4, made.id, 7, '第1场\n客厅 日 内\n△站着。')
    t('写不存在的第 7 章会被挡下', orphan.ok !== true, JSON.stringify(orphan).slice(0, 120))
    const orphanPath = path.join(ws4, 'books', novel.bookFolderName(made.id), 'scripts', '007.md')
    t('挡下来之后不留孤儿文件', !(await fs.stat(orphanPath).catch(() => null)), '')
    await fs.rm(ws4, { recursive: true, force: true })
  }

  // ⑫ 写盘失败真的会留下 `.tmp-` 的那条路径：上面「写失败不留临时文件」用的是
  //    「拿文件当 scripts 目录」，`mkdir` 就先炸了，tmp 根本没被创建，那条断言是空转的。
  //    这里让目标 001.md 变成目录：写入成功、rename 失败，残骸才真会出现。
  {
    const ws5 = await fs.mkdtemp(path.join(tmpdir(), 'lc-script-tmp-'))
    await store.openWorkspace(ws5, { create: true })
    const made = await novel.createBook(ws5, { title: '残骸排查' })
    await novel.writeChapter(ws5, made.id, 1, '正文')
    const scripts = path.join(ws5, 'books', novel.bookFolderName(made.id), 'scripts')
    await fs.mkdir(path.join(scripts, '001.md'), { recursive: true })
    const failed = await novel.writeScript(ws5, made.id, 1, '第1场\n客厅 日 内\n△站着。')
    t('rename 失败要说得清', failed.ok !== true, JSON.stringify(failed).slice(0, 120))
    const left = await fs.readdir(scripts).catch(() => [])
    t('rename 失败之后不留 .tmp- 残骸', left.every((x) => !x.includes('.tmp-')), JSON.stringify(left))
    await fs.rm(ws5, { recursive: true, force: true })
  }

  // ⑬ readScript 的坏内容分支：非法 UTF-8 不许当成一份正常剧本摆出来。
  {
    const ws6 = await fs.mkdtemp(path.join(tmpdir(), 'lc-script-bad-'))
    await store.openWorkspace(ws6, { create: true })
    const made = await novel.createBook(ws6, { title: '坏文件排查' })
    await novel.writeChapter(ws6, made.id, 1, '正文')
    await novel.writeScript(ws6, made.id, 1, '第1场\n客厅 日 内\n△站着。')
    const file = path.join(ws6, 'books', novel.bookFolderName(made.id), 'scripts', '001.md')
    await fs.writeFile(file, Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x00]))
    const bad = await novel.readScript(ws6, made.id, 1)
    t('读不出来的剧本不许当成正常的一份', bad.ok !== true, JSON.stringify(bad).slice(0, 120))
    t('坏文件要说出「内容坏了」', String(bad.error ?? '').includes('坏'), String(bad.error ?? ''))
    await fs.rm(ws6, { recursive: true, force: true })
  }

  // ⑳ 模型爱把整份剧本写成 markdown：列表符、加粗标签、井号场头。
  {
    const plain = '第1场\n旧书店·门厅 夜 内\n【出场人物】林小雨、陈默\n【关键道具】红伞\n△她把伞靠在门边。\n陈默（没抬头）说："伞放门边。"'
    const markdown = '### 第1场 旧书店·门厅 夜 内\n\n**【出场人物】** 林小雨、陈默\n\n**【关键道具】** 红伞\n\n- △她把伞靠在门边。\n- 陈默（没抬头）说："伞放门边。"'
    const a = novel.parseScriptScenes(plain)
    const b = novel.parseScriptScenes(markdown)
    t('markdown 列表符和加粗标签不影响分场', b.counts.scenes === 1, JSON.stringify(b.counts))
    t('markdown 写法不报「没归位」', !novel.scanScript(markdown).issues.some((x) => x.kind === 'stray'), JSON.stringify(novel.scanScript(markdown).issues.map((x) => x.kind)))
    t('markdown 写法不报「没写谁在这场」', !novel.scanScript(markdown).issues.some((x) => x.kind === 'no-cast'), '')
    t('加粗标签里的名字照常读出来', JSON.stringify(b.scenes[0].cast) === JSON.stringify(['林小雨', '陈默']), JSON.stringify(b.scenes[0].cast))
    t('加粗标签里的道具照常读出来', JSON.stringify(b.scenes[0].props) === JSON.stringify(['红伞']), JSON.stringify(b.scenes[0].props))
    t('列表符后面的 △ 还是动作', b.scenes[0].actions.length === 1 && b.scenes[0].actions[0] === '她把伞靠在门边。', JSON.stringify(b.scenes[0].actions))
    t('列表符后面的人名不带圆点', b.scenes[0].dialogues.every((d) => !String(d.who).startsWith('-')), JSON.stringify(b.scenes[0].dialogues.map((d) => d.who)))
    t('两种写法读出来的场头一致', a.scenes[0].place === b.scenes[0].place && a.scenes[0].dayNight === b.scenes[0].dayNight && a.scenes[0].inOut === b.scenes[0].inOut, `${a.scenes[0].place}/${b.scenes[0].place}`)
  }

  // ⑲ 场记标签（时间/地点/服装/天气）不是台词，「音乐：」「光线：」却真是镜头话。
  {
    const base = '第1场\n客厅 日 内\n【出场人物】甲\n'
    for (const line of ['时间：深夜。', '地点：客厅。', '服装：一身黑。', '天气：下雨。']) {
      const got = novel.scanScript(`${base}${line}\n△站着。`)
      const scene = novel.parseScriptScenes(`${base}${line}\n△站着。`).scenes[0]
      t(`场记标签不当台词：${line}`, scene.dialogues.length === 0, JSON.stringify(scene.dialogues.map((d) => d.who)))
      t(`场记标签不进演员表：${line}`, !scene.cast.includes(String(line).split('：')[0]), JSON.stringify(scene.cast))
      t(`场记标签不报「没归位」：${line}`, !got.issues.some((x) => x.kind === 'stray'), JSON.stringify(got.issues.map((x) => x.kind)))
    }
    for (const line of ['音乐：轻快的钢琴。', '光线：偏暗。', '音效：雨声。', '镜头：从门外推进到脸上。']) {
      const got = novel.scanScript(`${base}${line}\n△站着。`)
      t(`写了镜头/音乐的话要报：${line}`, got.issues.some((x) => x.kind === 'camera'), JSON.stringify(got.issues.map((x) => x.kind)))
      t(`同一行不重复报「没归位」：${line}`, !got.issues.some((x) => x.kind === 'stray'), JSON.stringify(got.issues.map((x) => x.kind)))
    }
  }

  // ⑱ 场号重了要说出来：排班和配音靠它对场次。
  {
    const dup = '第1场\n客厅 日 内\n【出场人物】甲\n△站着。\n第1场\n门外 夜 外\n【出场人物】乙\n△走着。'
    const got = novel.scanScript(dup)
    t('场号重了要报', got.issues.some((x) => x.kind === 'dup-scene'), JSON.stringify(got.issues.map((x) => x.kind)))
    const okText = '第1场\n客厅 日 内\n【出场人物】甲\n△站着。\n第2场\n门外 夜 外\n【出场人物】乙\n△走着。'
    t('场号不重就不报', !novel.scanScript(okText).issues.some((x) => x.kind === 'dup-scene'), '')
  }

  // ⑰ 「秒」这一档：戏里的秒不许报，镜头话的秒必须报。
  //    判据是「谁在停」——主语是镜头/画面/黑场/定格这一类的才是在写时长。
  {
    const withLine = (line) => novel.scanScript(`第1场\n客厅 日 内\n【出场人物】甲\n${line}`)
    const reports = (line) => withLine(line).issues.some((x) => x.kind === 'camera')
    for (const line of ['△镜头停了两秒。', '△画面停住两秒。', '△黑场三秒。', '△定格2秒。', '△时长：15 秒。', '△第3秒，门开了。']) {
      t(`写镜头时长要报：${line}`, reports(line), JSON.stringify(withLine(line).issues))
    }
    for (const line of ['△他愣了两秒。', '△等我一秒。', '△三秒钟后他走了。', '△她一秒都没停。']) {
      t(`戏里的秒不报：${line}`, !reports(line), JSON.stringify(withLine(line).issues))
    }
  }

  // ⑯ △ 的同义字形：模型偶尔把希腊字母 Δ 或者 ▵ 当三角号打出来。
  //    认不出来的话整场变成「空场 + 没归位」两条提示，而人明明写了动作。
  {
    for (const mark of ['▵', 'Δ']) {
      const text = `第1场\n客厅 日 内\n【出场人物】甲\n${mark}他把碗放下。`
      const scene = parse(text).scenes[0]
      t(`「${mark}」也当动作行`, scene.actions.length === 1, JSON.stringify(scene.actions))
    }
  }

  // ⑮ 几条以前只有反向断言、改坏也不会红的：这里补正例。
  {
    t('只缺内外时必须报「没写场头」', kinds('第1场\n客厅 日\n【出场人物】甲\n△站着。').includes('no-head'), JSON.stringify(kinds('第1场\n客厅 日\n【出场人物】甲\n△站着。')))
    t('空场必须报「空场」', kinds('第1场\n客厅 日 内\n【出场人物】甲').includes('empty-scene'), JSON.stringify(kinds('第1场\n客厅 日 内\n【出场人物】甲')))
    t('只有台词没有动作必须报', kinds('第1场\n客厅 日 内\n【出场人物】甲\n甲说："走。"').includes('no-action'), '')
  }
}

// ⑰ 审查员 4bba667e / c6f9b494 / 48e2ff3a / 10cee65e 那一轮：
//    A 类「静默丢数据」、B 类「误报」、C 类「漏报」、D 类「落盘」。
//    这一组每一条都对应一份真的会出现的剧本写法，不是想象出来的。
{
  const scanOf = (body) => novel.scanScript(`第1场\n客厅 日 内\n【出场人物】甲\n${body}\n`)
  const kindsOf = (body) => scanOf(body).issues.map((x) => x.kind)
  const hasKind = (body, kind) => kindsOf(body).includes(kind)

  // A1 场号同行写了叙述：以前整句消失，只剩一条「这场没写人」。
  {
    const text = '第1场\n客厅 日 内\n【出场人物】甲\n△她推开门。\n\n第2场 她跑进雨里，没回头。\n厨房 夜 内\n△她在案板前站着。'
    const parsed = novel.parseScriptScenes(text)
    // 那句话属于**新开的那一场**（场号在同一行，句子跟在号后面）。
    t('场号同行那句叙述进「没归位」，不许无声消失', parsed.scenes[1].other.some((x) => x.includes('跑进雨里')), JSON.stringify(parsed.scenes.map((sc) => sc.other)))
    t('场号同行那句叙述也会被报出来', novel.scanScript(text).issues.some((x) => x.kind === 'stray'), JSON.stringify(novel.scanScript(text).issues))
    t('下一场的场头照常认', parsed.scenes[1].place === '厨房' && parsed.scenes[1].dayNight === '夜', JSON.stringify({ p: parsed.scenes[1].place, d: parsed.scenes[1].dayNight }))
  }

  // A2 【出场人物】紧跟下一场的场头：以前下一整场连场头一起被吞成人名。
  {
    const text = '第1场\n客厅 日 内\n【出场人物】甲\n厨房 夜 内\n△她切菜。'
    const parsed = novel.parseScriptScenes(text)
    t('标签下面是场头时要开新的一场', parsed.scenes.length === 2, parsed.scenes.length)
    t('新那一场的场头是真场头', parsed.scenes[1].place === '厨房', JSON.stringify(parsed.scenes[1].place))
    t('演员表里不许混进「厨房 夜 内」', parsed.scenes[0].cast.join(',') === '甲', JSON.stringify(parsed.scenes[0].cast))
    t('那一场的动作还在', parsed.scenes[1].actions.length === 1, JSON.stringify(parsed.scenes[1].actions))
  }

  // A3 中文数字「三、」跟阿拉伯数字一样要形状校验。
  {
    const text = '第1场\n客厅 日 内\n【出场人物】甲\n△她站着没动。\n三、他把碗放下，转身往门口走。\n△她抬起头。'
    const parsed = novel.parseScriptScenes(text)
    t('「三、」后面不是场头就不许切成新场', parsed.scenes.length === 1, parsed.scenes.length)
    t('「三、」那一行进「没归位」，不许消失', parsed.scenes[0].other.some((x) => x.includes('把碗放下')), JSON.stringify(parsed.scenes[0].other))
    t('「一、二楼的灯」不许被当成场号', novel.parseScriptScenes('第1场\n客厅 日 内\n【出场人物】甲\n△ 一、二楼的灯都灭了。').scenes.length === 1, '')
    t('真的「三、客厅 日 内」还是要认', novel.parseScriptScenes('一、客厅 日 内\n【出场人物】甲\n△她站着。\n三、客厅 夜 内\n△她坐着。').scenes.length === 2, novel.parseScriptScenes('一、客厅 日 内\n【出场人物】甲\n△她站着。\n三、客厅 夜 内\n△她坐着。').scenes.length)
  }

  // A4 标签下面写了一句叙述：以前被当成名字/道具名塞进去。
  {
    const parsed = novel.parseScriptScenes('第1场\n厨房 夜 内\n【关键道具】菜刀\n她把刀放在案板上\n△灯灭了。')
    t('标签下面那句叙述不进道具表', parsed.scenes[0].props.join(',') === '菜刀', JSON.stringify(parsed.scenes[0].props))
    t('标签下面那句叙述进「没归位」', parsed.scenes[0].other.some((x) => x.includes('案板')), JSON.stringify(parsed.scenes[0].other))
    const cast = novel.parseScriptScenes('第1场\n客厅 日 内\n【出场人物】甲、乙\n林小雨是女一号，脾气很硬\n△她站着。')
    t('人物简介那种整句不许当人名', !cast.scenes[0].cast.some((x) => x.length > 6), JSON.stringify(cast.scenes[0].cast))
  }

  // A5 场号同行带 tags：以前标签进了地名，道具静默丢失。
  {
    const parsed = novel.parseScriptScenes('第1场\n客厅 日 内\n【出场人物】甲\n\n第2场 客厅 夜 内 【关键道具】红伞\n△她站着。')
    t('场号同行的道具标签要认出来', parsed.scenes[1].props.join(',') === '红伞', JSON.stringify(parsed.scenes[1].props))
    t('场号同行的标签不许粘进地名', parsed.scenes[1].place === '客厅', JSON.stringify(parsed.scenes[1].place))
    t('场号同行的人名标签也要认', novel.parseScriptScenes('第1场 客厅 日 内 【出场人物】甲、乙\n△她站着。').scenes[0].cast.join(',') === '甲,乙', JSON.stringify(novel.parseScriptScenes('第1场 客厅 日 内 【出场人物】甲、乙\n△她站着。').scenes[0].cast))
  }

  // B1 台词括注里写的动作也算动作。
  {
    t('台词括注里写了动作就不报「没动作」', !hasKind(`甲（把碗放下，站起来）说："我走了。"\n乙（没抬头）说："走。"`, 'no-action'), JSON.stringify(kindsOf(`甲（把碗放下，站起来）说："我走了。"`)))
    t('只有台词、括注里也没动作时还是要报', hasKind('甲说："走。"', 'no-action'), '')
  }

  // B2 整行括注写得再长也是表演提示。
  {
    t('长括注也是表演提示，不许报「没归位」', !hasKind('（他把碗放下，转身往门口走，走到一半又停下来）\n甲说："我走了。"', 'stray'), JSON.stringify(kindsOf('（他把碗放下，转身往门口走，走到一半又停下来）\n甲说："我走了。"')))
    t('长括注也算这一场有动作', !hasKind('（他把碗放下，转身往门口走，走到一半又停下来）\n甲说："我走了。"', 'no-action'), '')
  }

  // B3 场记类标签：「场记／注意／提示／调度」以前当成人名。
  {
    for (const label of ['场记', '注意', '提示', '调度']) {
      const parsed = novel.parseScriptScenes(`第1场\n客厅 日 内\n【出场人物】甲\n${label}：她进门的动作。\n甲说："走。"`)
      t(`「${label}：」进备注，不进演员表`, !parsed.scenes[0].cast.includes(label), JSON.stringify(parsed.scenes[0].cast))
      t(`「${label}：」的内容收进备注`, parsed.scenes[0].notes.length === 1, JSON.stringify(parsed.scenes[0].notes))
    }
  }

  // B4 标签名带后缀。
  {
    t('【人物表】也认', novel.parseScriptScenes('第1场\n客厅 日 内\n【人物表】甲、乙\n△站着。').scenes[0].cast.join(',') === '甲,乙', JSON.stringify(novel.parseScriptScenes('第1场\n客厅 日 内\n【人物表】甲、乙\n△站着。').scenes[0].cast))
    t('【道具清单】也认', novel.parseScriptScenes('第1场\n客厅 日 内\n【道具清单】红伞、信\n△站着。').scenes[0].props.join(',') === '红伞,信', JSON.stringify(novel.parseScriptScenes('第1场\n客厅 日 内\n【道具清单】红伞、信\n△站着。').scenes[0].props))
    t('同一个人名只算一次', novel.parseScriptScenes('第1场\n客厅 日 内\n【出场人物】甲\n【人物表】甲\n△站着。').scenes[0].cast.join(',') === '甲', JSON.stringify(novel.parseScriptScenes('第1场\n客厅 日 内\n【出场人物】甲\n【人物表】甲\n△站着。').scenes[0].cast))
  }

  // B5 日夜词表不能再把「夜里」「白昼」当地名。
  {
    for (const word of ['夜晚', '夜里', '白昼', '早间', '午间', '早上', '黑天', '阴天', '雨天', '雨夜']) {
      const head = novel.parseSceneHeadLine(`客厅 ${word} 内`)
      t(`「${word}」认成日夜`, head !== null && head.dayNight === word && head.place === '客厅', JSON.stringify(head))
    }
  }

  // B6 整行套方括号的场头。
  {
    const scan = novel.scanScript('【第1场 客厅 日 内】\n【出场人物】甲\n△她站着。')
    t('【第1场 客厅 日 内】不许把「内】」当地名', scan.scenes[0].inOut === '内' && scan.scenes[0].place === '客厅', JSON.stringify({ p: scan.scenes[0].place, io: scan.scenes[0].inOut }))
    t('【第1场 客厅 日 内】不许报「没写场头」', !scan.issues.some((x) => x.kind === 'no-head'), JSON.stringify(scan.issues))
  }

  // B8 现场的声音不是配乐说明。
  {
    t('婚礼录像里的音乐是戏', !hasKind('△电视里在放婚礼录像，音乐响起来，全场鼓掌。', 'camera'), JSON.stringify(kindsOf('△电视里在放婚礼录像，音乐响起来，全场鼓掌。')))
    t('乐队起调子是戏', !hasKind('△台上乐队起了一个调子，音乐响起。', 'camera'), JSON.stringify(kindsOf('△台上乐队起了一个调子，音乐响起。')))
    t('「背景音乐渐弱」是说明，要报', hasKind('△背景音乐渐弱。', 'camera'), '')
  }

  // B9 「电视上在打上字幕」是现场画面。
  {
    t('电视上在打上字幕是戏', !hasKind('△电视上在打上字幕，一行一行往上滚。', 'camera'), JSON.stringify(kindsOf('△电视上在打上字幕，一行一行往上滚。')))
    t('「字幕：」是说明，要报', hasKind('字幕：三天后。', 'camera') || hasKind('字幕：三天后。', 'narrator'), '')
  }

  // B10 「绳子的长度」不是时长。
  {
    t('量绳子长度是戏', !hasKind('△他量了量绳子的长度，两米三。', 'camera'), JSON.stringify(kindsOf('△他量了量绳子的长度，两米三。')))
    t('「时长：15 秒」要报', hasKind('△时长：15 秒。', 'camera'), '')
  }

  // C1 括注和心里话两栏也要扫镜头词。
  {
    t('括注里的镜头话要报', hasKind('（镜头推近到她的脸）\n甲说："走。"', 'camera'), JSON.stringify(kindsOf('（镜头推近到她的脸）\n甲说："走。"')))
    t('心里话里的镜头话要报', hasKind('（心里想：镜头推近到她的脸）\n△ 他站着。', 'camera'), JSON.stringify(kindsOf('（心里想：镜头推近到她的脸）\n△ 他站着。')))
  }

  // C2 漏报的十来种分镜写法。
  {
    for (const line of [
      '△远镜头，她从门口进来。',
      '△中景，两个人在桌前。',
      '△镜头A：她进门。',
      '△镜号3：她进门。',
      '△3号机位拍她的手。',
      '△手持跟拍，她跑过走廊。',
      '△升格，雨滴在半空停住。',
      '△后切到她的脸。',
      '△画面转为黑白。',
      '△（镜头拉远）',
      '△镜头一：她站在门口',
      '△定格。',
      '△幻灯片式的回忆。',
    ]) {
      t(`分镜写法要报：${line}`, hasKind(line, 'camera'), JSON.stringify(kindsOf(line)))
    }
    // 反向：这些是戏，不许报。
    for (const line of [
      '△他举起相机，镜头对准窗外。',
      '△他对着镜头笑了一下。',
      '△她一秒都没停。',
      '△收音机里在念旁白。',
      '△桌上摊着一叠分镜稿。',
      '△他不懂运镜，也不懂剪辑。',
    ]) {
      t(`戏里的话不许报成镜头：${line}`, !hasKind(line, 'camera'), JSON.stringify(kindsOf(line)))
    }
  }

  // c6f9b494 要求的负向断言：叙述别被吃成台词。
  {
    t('「他想起一句话：雨停了。」不是台词', novel.parseDialogueLine('他想起一句话：雨停了。') === null, JSON.stringify(novel.parseDialogueLine('他想起一句话：雨停了。')))
    t('「那年冬天：雪下得很大。」不是台词', novel.parseDialogueLine('那年冬天：雪下得很大。') === null, '')
    t('「广播里说：列车晚点。」不是台词', novel.parseDialogueLine('广播里说：列车晚点。') === null, '')
    t('「母亲在信里写：别等我。」不是台词', novel.parseDialogueLine('母亲在信里写：别等我。') === null, '')
    t('单字名「念说：走。」还算台词', novel.parseDialogueLine('念说："走。"')?.who === '念', JSON.stringify(novel.parseDialogueLine('念说："走。"')))
    t('「白念说」不许被剥成「白」', novel.parseDialogueLine('白念说："走。"')?.who === '白念', JSON.stringify(novel.parseDialogueLine('白念说："走。"')))
    t('「张道说」不许被剥成「张」', novel.parseDialogueLine('张道说："走。"')?.who === '张道', JSON.stringify(novel.parseDialogueLine('张道说："走。"')))
    t('「林小雨道」还是「林小雨」', novel.parseDialogueLine('林小雨道："走。"')?.who === '林小雨', JSON.stringify(novel.parseDialogueLine('林小雨道："走。"')))
    t('「才开口说」不许当说话人', novel.parseDialogueLine('他顿了顿，看向窗外，才开口说："走。"') === null, JSON.stringify(novel.parseDialogueLine('他顿了顿，看向窗外，才开口说："走。"')))
    t('「才慢慢说」不许当说话人', novel.parseDialogueLine('林小雨沉默了一会儿，才慢慢说："走。"') === null, JSON.stringify(novel.parseDialogueLine('林小雨沉默了一会儿，才慢慢说："走。"')))
    t('「林小雨说」在逗号后面还是林小雨', novel.parseDialogueLine('这时候门开了，林小雨说："你来了。"')?.who === '林小雨', JSON.stringify(novel.parseDialogueLine('这时候门开了，林小雨说："你来了。"')))
    t('「甲：走吧。」无引号也算台词', novel.parseDialogueLine('甲：走吧。')?.who === '甲', JSON.stringify(novel.parseDialogueLine('甲：走吧。')))
  }

  // 一人连说两段。
  {
    const scan = novel.scanScript('第1场\n客厅 日 内\n【出场人物】甲\n△她站着。\n甲说："走。"\n"顺便把伞还了。"')
    t('一个人连说两段要算成一句两段的台词', scan.counts.dialogues === 1, JSON.stringify(scan.counts))
    t('连说两段时第二段不许报「没归位」', !scan.issues.some((x) => x.kind === 'stray'), JSON.stringify(scan.issues))
    t('第二段的话要接在第一段后面', String(scan.scenes[0].dialogues[0].text ?? '').includes('伞'), JSON.stringify(scan.scenes[0].dialogues[0]))
  }

  // 心里话与（沉默）不算「这一场有东西」。
  {
    t('只有一句心里话的场要报空场', hasKind('（心里想：他不会回来了。）', 'empty-scene'), JSON.stringify(kindsOf('（心里想：他不会回来了。）')))
    t('只有一行（沉默）的场要报空场', hasKind('（沉默）', 'empty-scene'), JSON.stringify(kindsOf('（沉默）')))
    t('一场三句心里话要报', hasKind('（心里想：一）\n（心里想：二）\n（心里想：三）', 'too-many-thoughts'), JSON.stringify(kindsOf('（心里想：一）\n（心里想：二）\n（心里想：三）')))
  }

  // D1 落盘前剥围栏、D2 字数口径、D3 非规范名也读得到。
  {
    const book = await novel.createBook(ws, { title: '落盘探针', idea: '一件事' })
    await novel.writeChapter(ws, book.id, 1, '第一章的正文。她推开门。')
    const wrapped = '```markdown\n第1场\n客厅 日 内\n【出场人物】甲\n△她站着。\n```'
    const saved = await novel.writeScript(ws, book.id, 1, wrapped)
    t('带围栏的剧本存得进去', saved.ok === true, JSON.stringify(saved))
    const back = await novel.readScript(ws, book.id, 1)
    t('落盘时围栏被剥掉了', back.ok === true && !String(back.text).includes('```'), JSON.stringify(back.text?.slice(0, 40)))
    t('落盘后的字数是去空白的字数', saved.chars === String(back.text).replace(/\s/g, '').length, JSON.stringify({ saved: saved.chars, real: String(back.text).replace(/\s/g, '').length }))
    const list = await novel.listScripts(ws, book.id)
    t('列表的字数和存的时候一个口径', list.scripts[0]?.chars === saved.chars, JSON.stringify({ l: list.scripts[0]?.chars, s: saved.chars }))
    t('全空白的剧本不许落盘', (await novel.writeScript(ws, book.id, 1, '```\n```')).ok === false, '')
    // 非规范名（1.md）：列得出来，也读得到。
    const alias = path.join(ws, 'books', book.id, 'scripts', '1.md')
    await fs.writeFile(alias, '第1场\n客厅 日 内\n【出场人物】甲\n△她站着。\n', 'utf8')
    await fs.unlink(path.join(ws, 'books', book.id, 'scripts', '001.md')).catch(() => null)
    const aliasList = await novel.listScripts(ws, book.id)
    t('非规范名的剧本列得出来', aliasList.scripts.length === 1 && aliasList.scripts[0].index === 1, JSON.stringify(aliasList.scripts))
    const aliasRead = await novel.readScript(ws, book.id, 1)
    t('非规范名的剧本读得到', aliasRead.ok === true && String(aliasRead.text).includes('她站着'), JSON.stringify(aliasRead))
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
