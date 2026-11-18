/**
 * auto-diary.js 的测试：把会话记录捡成一篇日记。
 *
 * 这一层有三件容易错的事，测试就盯着这三件：
 *   1. 一个真实会话里绝大多数事件不是「这个人说的话」——技能目录、时间快照、
 *      后台任务通知全挂着 user 的角色名。不按 source.kind 过一遍，日记会变成
 *      系统日志摘抄。
 *   2. 材料超长时得留最近的。留最早的等于给今天早上那份报错写日记。
 *   3. 模型写回来的标题花样太多（`###`、`**加粗**`、`【】`），而且会超字数。
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import * as auto from '../lib/auto-diary.js'
import { DIARY_SECTIONS } from '../lib/diary.js'
// 路由层：这一层的测试只调 buildApi，**不调 apply**。
// apply 的 effect 会同步执行、真的建出一个 setInterval（虽然 unref 过，
// 不会把进程挂住），而且它还会去装预设、读指针文件——测一条路由不该带这些。
import * as api from '../lib/index.js'
import * as store from '../lib/store.js'

let pass = 0
let fail = 0
const t = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name}${detail === '' ? '' : `  ← ${detail}`}`) }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-autodiary-'))

// 造一条会话事件。time 必须给：所有「是不是今天」的判断都压在它上面。
const ev = (type, data, time) => ({ type, seq: 0, time, data })

console.log('\n=== 1. sessionDirName：cwd 转目录名 ===')
t('基本形状', auto.sessionDirName('/Users/a/b') === '--Users-a-b--', auto.sessionDirName('/Users/a/b'))
t('根目录', auto.sessionDirName('/') === '----', auto.sessionDirName('/'))
t('末尾斜杠不影响', auto.sessionDirName('/Users/a/b/') === auto.sessionDirName('/Users/a/b'))
t('点号原样留着', auto.sessionDirName('/Users/x/.dsh/profiles/desktop') === '--Users-x-.dsh-profiles-desktop--', auto.sessionDirName('/Users/x/.dsh/profiles/desktop'))
// 只把 `/` 换成 `-`，空格原样留着。真机上 `--Users-joyfon620-.dsh-profiles-desktop--`
// 把点号留住了，说明转义是「只动斜杠」，不是 slug 化。
t('空格原样留着', auto.sessionDirName('/Users/a b/c d') === '--Users-a b-c d--', auto.sessionDirName('/Users/a b/c d'))
t('带中文', auto.sessionDirName('/Users/张三/日记') === '--Users-张三-日记--', auto.sessionDirName('/Users/张三/日记'))
t('空 cwd 回空串', auto.sessionDirName('') === '', auto.sessionDirName(''))

console.log('\n=== 2. extractText：只认人说的话 ===')
const now = Date.now()
const events = [
  ev('session', { version: 4, id: 's1', createdAt: now, cwd: '/tmp/x', origin: 'root' }, now),
  // 用户本人说的
  ev('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '今天把插件跑起来了' }] }, now + 1),
  // 宿主塞进来的旁白：角色是 user，但不是他说的
  ev('user/message', { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '可用技能清单……' }] }, now + 2),
  ev('user/message', { role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }] }, now + 3),
  // 模型说出口的话（text 块）+ 内心嘀咕（reasoning）与工具调用
  ev('assistant/message', { message: { role: 'assistant', content: [
    { type: 'reasoning', text: '我得先读 diary.js' },
    { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"lib/diary.js"}' },
    { type: 'text', text: '读完了，五节是固定的。' },
  ] } }, now + 4),
  // 以下三种都不能进
  ev('tool/result', { message: { role: 'tool', content: [{ type: 'text', text: '文件内容几千字' }] } }, now + 5),
  ev('system/message', { message: { role: 'system', content: [{ type: 'text', text: 'You are a coding agent' }] } }, now + 6),
  ev('subagent/descriptor', { version: 3, mode: 'continuable', label: '审计子代理' }, now + 7),
]
const got = auto.extractText(events)
t('抽出来成功', got.ok === true)
t('只留两条', got.turns.length === 2, JSON.stringify(got.turns.map((x) => x.text)))
t('用户那条标成「我」', got.turns[0].who === '我' && got.turns[0].text === '今天把插件跑起来了', JSON.stringify(got.turns[0]))
t('模型那条标成「TA」', got.turns[1].who === 'TA' && got.turns[1].text.includes('五节是固定的'), JSON.stringify(got.turns[1]))
t('工具返回没混进来', !got.turns.some((x) => x.text.includes('几千字')))
t('系统消息没混进来', !got.turns.some((x) => x.text.includes('coding agent')))
t('reasoning 没当成他说的话', !got.turns.some((x) => x.text.includes('先读 diary.js')))
t('tool-call 的 JSON 没混进来', !got.turns.some((x) => x.text.includes('file_path')))
t('chars 是字数总和', got.chars === got.turns.reduce((s, x) => s + x.text.length, 0), String(got.chars))

const longOne = '啊'.repeat(1200)
const clipped = auto.extractText([ev('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: longOne }] }, now)])
t('超长截到 800 字（带一个省略号）', clipped.turns[0].text.length === 801, String(clipped.turns[0].text.length))
t('截断后尾巴是省略号', clipped.turns[0].text.endsWith('…'))

const sysOnly = auto.extractText([ev('user/message', { role: 'user', content: [{ type: 'text', text: '<system-reminder>别读我</system-reminder>' }] }, now)])
t('包在 system-reminder 里的也跳过', sysOnly.turns.length === 0, JSON.stringify(sysOnly.turns))
// 真机上抓到的坑：宿主的委派提示把 source.kind 也写成 'user'，
// 正文顶着 `[dsh-mnemon:delegated review]` 的方括号标签，两万四千字。
// 光按 kind 过滤挡不住，得看正文头。
const delegated = auto.extractText([ev('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '[dsh-mnemon:delegated review]\nBounded completed checkpoint……' }] }, now)])
t('顶着 [dsh-*:...] 标签的委派提示不进材料', delegated.turns.length === 0, JSON.stringify(delegated.turns))
const realUser = auto.extractText([ev('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '[备忘] 明天记得补测试' }] }, now)])
t('正文开头就用方括号的真人发言留着', realUser.turns.length === 1, JSON.stringify(realUser.turns))
t('传字符串也能解析', auto.extractText(JSON.stringify([ev('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '行' }] }, now)])).turns.length === 1)
t('传垃圾不抛', auto.extractText(null).ok === false)

console.log('\n=== 3. digestForDiary：超长留最近的 ===')
const mk = (text, time) => ({ turns: [{ who: '我', text, time }] })
const many = [
  mk('最早的一句话', 1),
  mk('中间的一句话', 2),
  mk('最后的一句话', 3),
]
const full = auto.digestForDiary(many, { maxChars: 12000 })
t('没超就全给', full.includes('最早') && full.includes('最后'), full)
t('没超就不写省略提示', !full.includes('省略'), full)

// 预算只够最后两条：最早那条必须被丢掉，不是最晚那条。
// 每条成本 = 正文 6 字 + `我：` 2 字 + 换行 1 字 = 9 字；省略提示占 10 字，
// 所以 maxChars 取 32 时预算 22 字，正好装下最后两条（18）、装不下三条（27）。
const tight = auto.digestForDiary(many, { maxChars: 32 })
t('超长时砍最早的', !tight.includes('最早'), tight)
t('超长时保住最后的', tight.includes('最后'), tight)
t('砍了才加省略提示', tight.includes('省略'), tight)
t('最终串不超预算', tight.length <= 32, `${tight.length} / 32`)

const tinyBudget = auto.digestForDiary(many, { maxChars: 10 })
t('预算极小时也不炸', typeof tinyBudget === 'string' && tinyBudget.length <= 10, tinyBudget)
t('空会话给空串', auto.digestForDiary([]) === '')

console.log('\n=== 4. shouldAutoWrite：四种情形 ===')
// 要明显超过 AUTO_DIARY_MIN_CHARS（50 字），否则测的就不是「材料够不够」这条分支。
const enough = '今天在改一个插件的日记功能，来来回回折腾了好几个小时，才把会话记录那几个压缩文件里的时间戳和来源字段搞明白，中间还重构了两遍。'
const written = { ok: true, data: { date: '2026-11-19', [DIARY_SECTIONS[0]]: '早上写了' } }
const empty = { ok: true, data: null, missing: true }
t('没写过 + 材料足 → 写', auto.shouldAutoWrite({ todayDiary: empty, material: enough }).should === true)
t('写过了 → 不写', auto.shouldAutoWrite({ todayDiary: written, material: enough }).should === false)
t('写过了的理由', auto.shouldAutoWrite({ todayDiary: written, material: enough }).reason === '今天写过了')
t('没聊过 → 不写', auto.shouldAutoWrite({ todayDiary: empty, material: '' }).should === false)
t('没聊过的理由', auto.shouldAutoWrite({ todayDiary: empty, material: '' }).reason === '今天没聊过天')
const short = auto.shouldAutoWrite({ todayDiary: empty, material: '嗯' })
t('材料太短 → 不写', short.should === false)
t('太短的理由里带字数', short.reason.includes('1'), short.reason)
t('todayDiary 传 null 当成没写过', auto.shouldAutoWrite({ todayDiary: null, material: enough }).should === true)
t('todayDiary 传日记正文（字符串）也算写过', auto.shouldAutoWrite({ todayDiary: '早上写了', material: enough }).should === false)

console.log('\n=== 5. buildAutoDiaryPrompt：规矩写进去了 ===')
const prompt = auto.buildAutoDiaryPrompt({ date: '2026-11-19', material: '我：今天在改插件\nTA：改完了', recent: '【2026-11-18】昨天在写测试' })
t('system 里有字数区间', prompt.system.includes('50 到 500'), '')
t('system 里有五个标题', DIARY_SECTIONS.every((x) => prompt.system.includes(x)))
t('system 里说了不许改标题', prompt.system.includes('一个字都不能改'))
t('system 里说了只写发生过的', prompt.system.includes('不要补时间'))
t('system 里说了不够就写短', prompt.system.includes('别凑字'))
t('user 里放了材料', prompt.user.includes('今天在改插件'))
t('user 里带了日期', prompt.user.includes('2026-11-19'))
t('recent 接在 user 后面', prompt.user.includes('昨天在写测试'))

console.log('\n=== 6. parseAutoDiary：模型写的花样子 ===')
const standard = [
  '## 今天最值得讲的一件事',
  '把插件里那个自动写日记的东西接上了。',
  '',
  '## 当时在想什么',
  '怕时间戳算错，跨天的会话会漏。',
  '',
  '## 情绪往下三层',
  '先是烦，后来有点兴奋。',
  '',
  '## 我做了什么决定',
  '按事件时间戳算，不按创建时间。',
  '',
  '## 下一步',
  '明天补测试。',
].join('\n')
const p1 = auto.parseAutoDiary(standard, '2026-11-19')
t('标准五节解析成功', p1.ok === true, p1.error ?? '')
t('五节都对上', p1.data.sections.length === 5 && p1.data.sections.every((x) => x.body !== ''), JSON.stringify(p1.missing))
t('第一节正文对', p1.data.sections[0].body.includes('自动写日记'), p1.data.sections[0].body)
t('没有缺节', p1.missing.length === 0)
t('没截断', p1.truncated === false)
t('data 摊平了（可以直接喂 writeDiary）', typeof p1.data[DIARY_SECTIONS[0]] === 'string', typeof p1.data[DIARY_SECTIONS[0]])

const h3 = standard.replace(/^## /gm, '### ')
const p2 = auto.parseAutoDiary(h3, '2026-11-19')
t('三级标题也认', p2.ok === true && p2.missing.length === 0, JSON.stringify(p2.missing))

const bold = standard.replace(/^## (.+)$/gm, '**$1**')
const p3 = auto.parseAutoDiary(bold, '2026-11-19')
t('加粗标题也认', p3.ok === true && p3.missing.length === 0, JSON.stringify(p3.missing))

const picked = standard.split('\n').filter((line, i) => !/^## (情绪往下三层|下一步)$/.test(line) && i < 8).join('\n')
const p4 = auto.parseAutoDiary(picked, '2026-11-19')
t('缺两节不报错', p4.ok === true, p4.error ?? '')
t('缺的节留空字符串', p4.data.sections.filter((x) => x.body === '').length >= 2, JSON.stringify(p4.data.sections.map((x) => x.body.length)))
t('缺的节名报出来', p4.missing.includes('下一步') || p4.missing.includes('情绪往下三层'), JSON.stringify(p4.missing))

// 每节塞 300 字，五节 1500 字，必须被砍到 500 以内。
const fat = DIARY_SECTIONS.map((title) => `## ${title}\n\n${'字'.repeat(300)}`).join('\n\n')
const p5 = auto.parseAutoDiary(fat, '2026-11-19')
t('超 500 字标 truncated', p5.truncated === true)
t('砍完不超 500 字', p5.chars <= auto.AUTO_DIARY_MAX_CHARS, `${p5.chars} / ${auto.AUTO_DIARY_MAX_CHARS}`)
t('等比例砍：每节都还有东西', p5.data.sections.every((x) => x.body !== ''), JSON.stringify(p5.data.sections.map((x) => x.body.length)))
t('砍断处有省略号', p5.data.sections[0].body.endsWith('…'), p5.data.sections[0].body.slice(-3))
t('五节等比例（长度差不超过 2 字）', Math.max(...p5.data.sections.map((x) => x.body.length)) - Math.min(...p5.data.sections.map((x) => x.body.length)) <= 2, JSON.stringify(p5.data.sections.map((x) => x.body.length)))

const p6 = auto.parseAutoDiary('今天挺累的，什么也没干成。', '2026-11-19')
t('一节都认不出 → ok:false', p6.ok === false, JSON.stringify(p6.missing))
t('认不出时不落空日记', p6.data.sections.length === 0)

const colon = auto.parseAutoDiary('## 今天最值得讲的一件事：把插件跑通了。\n\n## 当时在想什么：先别急着写。', '2026-11-19')
t('标题后面同一行接正文也认', colon.data[DIARY_SECTIONS[0]].includes('把插件跑通了'), colon.data[DIARY_SECTIONS[0]])
t('第二行同样接住', colon.data[DIARY_SECTIONS[1]].includes('先别急着写'), colon.data[DIARY_SECTIONS[1]])

const fenced = '```\n## 今天最值得讲的一件事\n这是示例\n```\n\n## 今天最值得讲的一件事\n真的那一节。'
const p7 = auto.parseAutoDiary(fenced, '2026-11-19')
t('围栏里的示例不当正文', p7.data[DIARY_SECTIONS[0]].includes('真的那一节'), p7.data[DIARY_SECTIONS[0]])

console.log('\n=== 7. findTodaySessions：真会话文件 ===')
const home = path.join(tmp, 'home')
const cwd = '/tmp/lc-auto project/我的日记'
const dirName = auto.sessionDirName(cwd)
const day = new Date()
const todayStart = new Date(day)
todayStart.setHours(9, 0, 0, 0)
const t0 = todayStart.getTime()

const writeSession = async (id, meta, lines) => {
  const dir = path.join(home, 'sessions', dirName, id)
  await fs.mkdir(dir, { recursive: true })
  const body = [JSON.stringify(meta), ...lines.map((x) => JSON.stringify(x))].join('\n') + '\n'
  await fs.writeFile(path.join(dir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(body, 'utf8')))
}

const mainId = 'session-main-0001'
await writeSession(
  mainId,
  { type: 'session', version: 4, id: mainId, createdAt: t0, cwd, isSeeded: false, origin: 'root', delegationDepth: 0, agentPreset: 'ptc' },
  [
    { type: 'turn/start', seq: 1, time: t0, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: t0 + 1000, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '帮我把自动写日记接上：我今天用了 DSH 但没写日记，希望它在后台自己补一篇' }] } },
    // 技能目录：角色是 user，但不是他说的
    { type: 'user/message', seq: 3, time: t0 + 1500, data: { role: 'user', source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: '可用技能……很长很长' }] } },
    { type: 'assistant/message', seq: 4, time: t0 + 2000, data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '先读文件' }, { type: 'text', text: '好，我先把会话记录的格式摸清楚：目录名是转义过的 cwd，里面是 zstd 压的 JSONL，子代理的会话得跳过。' }] } } },
    { type: 'tool/result', seq: 5, time: t0 + 2500, data: { message: { role: 'tool', content: [{ type: 'text', text: '一大堆文件内容' }] } } },
    { type: 'turn/end', seq: 6, time: t0 + 3000, data: { turn: 1 } },
  ],
)

const subId = 'session-sub-0002'
await writeSession(
  subId,
  { type: 'session', version: 4, id: subId, createdAt: t0 + 4000, cwd, isSeeded: false, origin: 'subagent', delegationDepth: 1, agentPreset: 'standard' },
  [
    { type: 'subagent/descriptor', seq: 0, time: t0 + 4001, data: { version: 3, label: '审计子代理' } },
    { type: 'user/message', seq: 1, time: t0 + 4002, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你负责审计这个插件的全部 skill，写一份报告。' }] } },
  ],
)

// 昨天开的会话、今天还在说：createdAt 是昨天，今天那几行得算进来。
const crossId = 'session-cross-0003'
const yesterday = t0 - 24 * 3600 * 1000
await writeSession(
  crossId,
  { type: 'session', version: 4, id: crossId, createdAt: yesterday, cwd, isSeeded: false, origin: 'root', delegationDepth: 0, agentPreset: 'standard' },
  [
    { type: 'user/message', seq: 1, time: yesterday + 1000, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '昨天说的那句话' }] } },
    { type: 'user/message', seq: 2, time: t0 + 500, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '今天接着说那个日记功能，卡在跨天的会话到底算哪一天这件事上，纠结了很久。' }] } },
  ],
)

// 同名撞车：另一个 cwd 转出来一模一样（`/tmp/lc auto project-我的日记`），
// 会话头里的 cwd 对不上，必须剔掉。
const otherCwd = '/tmp/lc auto project-我的日记'
const collideId = 'session-collide-0004'
await writeSession(
  collideId,
  { type: 'session', version: 4, id: collideId, createdAt: t0 + 6000, cwd: otherCwd, isSeeded: false, origin: 'root', delegationDepth: 0, agentPreset: 'standard' },
  [{ type: 'user/message', seq: 1, time: t0 + 6001, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '我是另一个目录的会话' }] } }],
)

const found = await auto.findTodaySessions({ home, cwd, now: day })
t('找到成功', found.ok === true, found.error ?? '')
const ids = found.sessions.map((x) => x.id)
t('子代理会话不进来', !ids.includes(subId), ids.join(','))
t('撞名的另一个目录不进来', !ids.includes(collideId), ids.join(','))
t('主会话和跨天会话都进来', ids.includes(mainId) && ids.includes(crossId), ids.join(','))
const main = found.sessions.find((x) => x.id === mainId)
// 不是文件大小、也不是行数，是「进了日记的字数」= turns 里那些 text 的长度和。
t('chars 只算人说的话', main.chars === main.turns.reduce((s, x) => s + x.text.length, 0) && main.chars > 0, String(main.chars))
t('技能目录没算进去', !main.turns.some((x) => x.text.includes('可用技能')))
t('工具返回没算进去', !main.turns.some((x) => x.text.includes('一大堆文件内容')))
t('带上了 turns 供 digest 用', Array.isArray(main.turns) && main.turns.length === 2, String(main.turns?.length))
t('lines 是条数', main.lines === 2, String(main.lines))
t('agentPreset 带出来了', main.agentPreset === 'ptc', main.agentPreset)
t('path 指向真实文件', main.path.endsWith('session.v4.jsonl.zstd'), main.path)
const cross = found.sessions.find((x) => x.id === crossId)
t('跨天会话只取今天的行', cross.turns.length === 1 && cross.turns[0].text.startsWith('今天接着说'), JSON.stringify(cross.turns.map((x) => x.text)))
t('按创建时间正序', found.sessions[0].id === crossId, ids.join(','))

const missingDir = await auto.findTodaySessions({ home: path.join(tmp, 'nope'), cwd: '/tmp/never/used', now: day })
t('目录不存在返空、不报错', missingDir.ok === true && missingDir.sessions.length === 0, JSON.stringify(missingDir))
const noCwd = await auto.findTodaySessions({ home, cwd: '', now: day })
t('cwd 为空也只返空', noCwd.ok === true && noCwd.sessions.length === 0)

// 整条链路走一遍：会话 → 材料 → 该不该写 → 模型那段话 → 解析。
const digest = auto.digestForDiary(found.sessions, { maxChars: 12000 })
t('材料拼得出来', digest.includes('帮我把自动写日记接上'), digest.slice(0, 120))
t('材料里没有子代理的话', !digest.includes('你负责审计这个插件'))
const verdict = auto.shouldAutoWrite({ todayDiary: null, material: digest })
t('这条材料够写一篇', verdict.should === true, verdict.reason)
const built = auto.buildAutoDiaryPrompt({ date: '2026-11-19', material: digest })
t('拼给模型的两段都不空', built.system.length > 100 && built.user.includes('帮我把自动写日记接上'))
const wrote = auto.parseAutoDiary(standard, '2026-11-19')
t('解析出来的能直接喂 writeDiary 的形状', typeof wrote.data.date === 'string' && Array.isArray(wrote.data.sections) && wrote.data.sections.length === 5)

console.log('\n=== 8. diary.autoWrite：接成路由之后还认不认这几件事 ===')
// 这一层测的是「线接对了没有」，不是 auto-diary.js 的判定逻辑（那是第 4 段）。
// 三件事各有一次真事故垫底：
//   1. 今天没用过 dsh（或换了库目录）→ 必须安静地跳过。以前这里会先去叫模型，
//      用户开着电脑没干活，半夜收到一篇凭空编的日记。
//   2. `DSH_LIFECARD_SKIP_AUTO_DIARY=1` → 一个字都不许落盘。关不掉的自动写
//      是最招人恨的那一类功能。
//   3. 同一天第二次 → 跳过。定时器每 30 分钟醒一次，没有这道闸，一晚上
//      能对着同一篇盖五六次，用户手写的那段话会被模型版本顶掉。
{
  const ctxRoute = {
    webServer: { register: () => () => {} },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
    get: () => undefined,
  }

  const oldHome = process.env.DSH_HOME
  const oldSwitch = process.env.DSH_LIFECARD_SKIP_AUTO_DIARY
  try {
    // ① 今天这个库目录里一次会话都没开过。
    const quietWs = path.join(tmp, 'ws-quiet')
    const quietDir = path.join(tmp, 'diary-quiet')
    const quietHome = path.join(tmp, 'home-quiet')
    await fs.mkdir(quietWs, { recursive: true })
    await fs.mkdir(quietHome, { recursive: true })
    await store.writeConfig(quietWs, { diary_dir: quietDir })
    process.env.DSH_HOME = quietHome
    delete process.env.DSH_LIFECARD_SKIP_AUTO_DIARY

    const quietTable = api.buildApi(ctxRoute, async () => quietWs, { workspace: quietWs })
    // ctx 里没有 llm：这条路上只要碰一次模型就会变成 ok:false（「没有可用的 AI」），
    // 所以「ok:true + skipped」这个组合本身就证明了它没去叫模型。
    let quiet = null
    let quietThrew = null
    try { quiet = await quietTable['diary.autoWrite']({}) } catch (error) { quietThrew = error }
    t('没会话时不抛', quietThrew === null, quietThrew?.message ?? '')
    t('没会话时 ok:true + skipped', quiet?.ok === true && typeof quiet?.skipped === 'string', JSON.stringify(quiet))
    t('跳过原因是「今天没聊过天」', quiet?.skipped === '今天没聊过天', quiet?.skipped)
    t('没材料时不算了结（夜里还要再看）', quiet?.settled === false, JSON.stringify(quiet))
    t('没会话时一个文件都没写', (await fs.readdir(quietDir).catch(() => [])).length === 0)

    // ② 开关关掉：连「找会话」都不该走到，直接回跳过。
    process.env.DSH_LIFECARD_SKIP_AUTO_DIARY = '1'
    const shutTable = api.buildApi(ctxRoute, async () => quietWs, { workspace: quietWs })
    const shut = await shutTable['diary.autoWrite']({})
    t('开关关着时也回 ok:true（不是报错）', shut?.ok === true, JSON.stringify(shut))
    t('开关关着时说明为什么跳过', String(shut?.skipped ?? '').includes('DSH_LIFECARD_SKIP_AUTO_DIARY=1'), shut?.skipped)
    t('开关关着时不动盘', (await fs.readdir(quietDir).catch(() => [])).length === 0)
    delete process.env.DSH_LIFECARD_SKIP_AUTO_DIARY

    // ③ 有材料、写成了、同一天再跑一次要跳过。
    const busyWs = path.join(tmp, 'ws-busy')
    const busyDir = path.join(tmp, 'diary-busy')
    const busyHome = path.join(tmp, 'home-busy')
    await fs.mkdir(busyWs, { recursive: true })
    await store.writeConfig(busyWs, { diary_dir: busyDir })
    process.env.DSH_HOME = busyHome
    // 会话目录名跟着「这个库目录」算，不是跟着第 7 段那个 cwd。
    const busyDirName = auto.sessionDirName(busyWs)
    const busyAt = new Date()
    busyAt.setHours(10, 0, 0, 0)
    const bt = busyAt.getTime()
    const busySession = path.join(busyHome, 'sessions', busyDirName, 'session-busy-0001')
    await fs.mkdir(busySession, { recursive: true })
    const busyLines = [
      { type: 'session', version: 4, id: 'session-busy-0001', createdAt: bt, cwd: busyWs, isSeeded: false, origin: 'root', delegationDepth: 0, agentPreset: 'standard' },
      { type: 'user/message', seq: 1, time: bt + 1000, data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '今天一直在接自动日记这条线，把会话记录里的时间戳、来源字段和压缩格式摸了一遍，中间改了两回判断顺序。' }] } },
      { type: 'assistant/message', seq: 2, time: bt + 2000, data: { message: { role: 'assistant', content: [{ type: 'text', text: '好，先把「今天写过了没有」放在判断最前面，再去看材料够不够。' }] } } },
    ]
    await fs.writeFile(
      path.join(busySession, 'session.v4.jsonl.zstd'),
      zlib.zstdCompressSync(Buffer.from(busyLines.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8')),
    )

    // 假模型：只回那五节，不连网。
    const seenRoute = []
    const fakeForDiary = {
      listProviders: async () => [{ provider: 'raccoon', models: [{ id: 'sn-deepseek-v4-1-flash-1017' }] }],
      listModels: async () => [],
      stream: async (opts) => {
        seenRoute.push(`${opts.provider}/${opts.model}`)
        return (async function* () {
          yield { type: 'text-delta', text: standard }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
    const busyCtx = { ...ctxRoute, get: (name) => (name === 'llm' ? fakeForDiary : undefined) }
    const busyTable = api.buildApi(busyCtx, async () => busyWs, { workspace: busyWs })

    const first = await busyTable['diary.autoWrite']({})
    t('有材料时写成了', first?.ok === true && first?.wrote === true, JSON.stringify(first))
    t('落盘字数在 50 到 500 之间', typeof first?.chars === 'number' && first.chars >= 50 && first.chars <= 500, String(first?.chars))
    t('回话里带日期', /^\d{4}-\d{2}-\d{2}$/.test(String(first?.date ?? '')), first?.date)
    t('模型只叫了一次', seenRoute.length === 1, seenRoute.join(','))
    const onDisk = await fs.readdir(busyDir).catch(() => [])
    t('盘上真的多了一篇', onDisk.includes(`${first?.date}.md`), onDisk.join(','))

    const second = await busyTable['diary.autoWrite']({})
    t('同一天第二次跳过', second?.ok === true && second?.skipped === '今天写过了', JSON.stringify(second))
    t('第二次的跳过才算「了结」', second?.settled === true, JSON.stringify(second))
    t('第二次没有再叫模型', seenRoute.length === 1, seenRoute.join(','))
    t('第二次没把文件写长（内容没被盖第二遍）', (await fs.readdir(busyDir).catch(() => [])).length === 1, String((await fs.readdir(busyDir).catch(() => [])).length))
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    if (oldSwitch === undefined) delete process.env.DSH_LIFECARD_SKIP_AUTO_DIARY
    else process.env.DSH_LIFECARD_SKIP_AUTO_DIARY = oldSwitch
  }
}

console.log('\n=== 9. default 导出齐不齐 ===')
for (const key of ['AUTO_DIARY_MIN_CHARS', 'AUTO_DIARY_MAX_CHARS', 'sessionDirName', 'findTodaySessions', 'extractText', 'digestForDiary', 'shouldAutoWrite', 'buildAutoDiaryPrompt', 'parseAutoDiary']) {
  t(`default 里有 ${key}`, auto.default?.[key] !== undefined)
}

await fs.rm(tmp, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
