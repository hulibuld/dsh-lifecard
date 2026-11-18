/**
 * intent.js 的测试：从用户那句话里判他这次想进哪扇门。
 *
 * 这一层全是纯函数，不碰模型、不碰磁盘、不碰网络——所以每个分支都能钉死。
 * 钉死它的理由：判门的结果决定界面画什么。判错一次，用户看到的就是
 * 「它根本没听我说话」；判不出来却没给选项，那一屏就卡在那儿没法往下走。
 */

import * as intent from '../lib/intent.js'

let pass = 0
let fail = 0
const t = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name}${detail === '' ? '' : `  ← ${detail}`}`) }
}

console.log('\n=== 1. 四扇门的代号和名字 ===')
t('四扇门', intent.DOOR_IDS.length === 4, intent.DOOR_IDS.join(','))
t('顺序是 写小说/游戏/酒馆/日记',
  intent.DOOR_IDS.join(',') === 'novel,game,tavern,diary', intent.DOOR_IDS.join(','))
t('每扇门都有中文名', intent.DOOR_IDS.every((id) => String(intent.DOOR_NAMES[id] ?? '') !== ''))
t('酒馆的名字就叫酒馆', intent.DOOR_NAMES.tavern === '酒馆', String(intent.DOOR_NAMES.tavern))

console.log('\n=== 2. 只命中一组词：直接判，并且说得出为什么 ===')
{
  const r = intent.judgeIntent({ text: '我想写小说，先把大纲列出来，再一章一章写' })
  t('写小说那组命中 → novel', r.mode === 'novel', r.mode)
  t('写小说有把握', r.confident === true)
  t('why 里点了命中的词', r.why.includes('大纲') || r.why.includes('写小说'), r.why)
  t('why 直接能给人看（结尾是句号）', r.why.endsWith('。'), r.why)
}
{
  const r = intent.judgeIntent({ text: '来玩一局文字游戏，剧情往哪走我来选一个' })
  t('文字游戏那组命中 → game', r.mode === 'game', r.mode)
  t('文字游戏有把握', r.confident === true)
  t('why 说了像玩一局', r.why.includes('玩一局'), r.why)
}
{
  const r = intent.judgeIntent({ text: '想角色扮演一下，你演一个冷脸的人，我们对着这场戏往下聊' })
  t('酒馆那组命中 → tavern', r.mode === 'tavern', r.mode)
  t('酒馆有把握', r.confident === true)
  t('why 说了像演一段', r.why.includes('演一段'), r.why)
}
{
  const r = intent.judgeIntent({ text: '今天心情有点闷，记录一下，顺便复盘' })
  t('日记那组命中 → diary', r.mode === 'diary', r.mode)
  t('日记有把握', r.confident === true)
  t('why 说了像记日记', r.why.includes('记日记'), r.why)
}

console.log('\n=== 3. 几组都命中：谁词多听谁的，一样多就说不清 ===')
{
  // 「章节」1 个 → novel；「存档」「结局」2 个 → game。game 多，判 game。
  const r = intent.judgeIntent({ text: '这段章节写完就存档，看看结局' })
  t('命中词多的那扇门赢', r.mode === 'game', r.mode)
  t('词多也算有把握', r.confident === true)
}
{
  // novel 1 个（写小说）、game 1 个（玩一局）：并列。
  const r = intent.judgeIntent({ text: '我想写小说，可我又想玩一局，你说呢' })
  t('并列时不硬猜（mode 空）', r.mode === '', r.mode)
  t('并列时 confident 是 false', r.confident === false)
  t('并列时 why 说得像人话', r.why.includes('分不清'), r.why)
  t('并列时仍然给四个选项', r.options.length === 4, String(r.options.length))
  t('并列时的 why 点了两扇门的名字',
    (r.why.includes('写小说') && r.why.includes('文字小说游戏')) || r.why.includes('、'), r.why)
}

console.log('\n=== 4. 一组词都没命中 ===')
{
  const r = intent.judgeIntent({ text: '帮我起个名字', hasCard: true })
  t('有卡就往酒馆猜', r.mode === 'tavern', r.mode)
  t('但这只是猜，不算有把握', r.confident === false)
  t('why 说清了是根据「有卡」猜的', r.why.includes('卡'), r.why)
  t('有卡猜错也给四个选项', r.options.length === 4)
}
{
  const r = intent.judgeIntent({ text: '帮我起个名字' })
  t('没词也没卡 → mode 空', r.mode === '', r.mode)
  t('没词也没卡 → 不算有把握', r.confident === false)
  t('why 让用户自己挑', r.why.includes('挑一个'), r.why)
  t('仍然给四个选项', r.options.length === 4)
}
{
  const r = intent.judgeIntent({ text: '随便看看', hasBook: true, hasWorld: true })
  t('有书有世界不算关键词命中', r.mode === '', r.mode)
  t('有书有世界也不硬猜', r.confident === false)
}

console.log('\n=== 5. 已经在门里了：不猜 ===')
for (const id of intent.DOOR_IDS) {
  const r = intent.judgeIntent({ text: '', mode: id })
  t(`已经在 ${id} 门里 → 直接确认`, r.mode === id && r.confident === true, `${r.mode}/${r.confident}`)
  t(`已经在 ${id} 门里 → why 说清楚了`, r.why === '你已经在这扇门里了。', r.why)
}
{
  // 已经在酒馆里，但用户说的话明明是写小说的词——人已经站在门里，
  // 这时再把他「挪」到另一扇门是无理的。
  const r = intent.judgeIntent({ text: '写小说大纲怎么写', mode: 'tavern' })
  t('已经进门时，关键词不改变门的判断', r.mode === 'tavern' && r.confident === true, r.mode)
}
{
  const r = intent.judgeIntent({ text: '写小说', mode: 'not-a-door' })
  t('不认识的 mode 当成没进门（照样按词判）', r.mode === 'novel' && r.confident === true, r.mode)
}

console.log('\n=== 6. 选项的形状 ===')
{
  const r = intent.judgeIntent({ text: '写小说' })
  t('options 是四条', r.options.length === 4)
  t('每条都有 mode', r.options.every((o) => intent.DOOR_IDS.includes(o.mode)))
  t('每条都有 name', r.options.every((o) => String(o.name ?? '') !== ''))
  t('每条都有 desc', r.options.every((o) => String(o.desc ?? '') !== ''))
  t('每条都有 reason', r.options.every((o) => String(o.reason ?? '') !== ''))
  t('四个 mode 不重复', new Set(r.options.map((o) => o.mode)).size === 4)
  // 命中过的门 reason 报词，没命中的门 reason 退回自己的 desc——都不能是空的。
  const novel = r.options.find((o) => o.mode === 'novel')
  const diary = r.options.find((o) => o.mode === 'diary')
  t('命中过的门 reason 点了词', novel.reason.includes('写小说'), novel.reason)
  t('没命中的门 reason 是它自己的说明', diary.reason === diary.desc, `${diary.reason} / ${diary.desc}`)
  t('判出来了也不用把选项藏起来（界面自己决定画不画）', r.confident === true && r.options.length === 4)
}

console.log('\n=== 7. 那句提示 ===')
t('有门时提示会点名那扇门', intent.buildOptionHint('novel').includes('写小说'), intent.buildOptionHint('novel'))
t('有门时提示提到能换', intent.buildOptionHint('game').includes('换'), intent.buildOptionHint('game'))
t('没门时提示就是让挑', intent.buildOptionHint('').includes('挑一个'), intent.buildOptionHint(''))
t('没门时也提到挑错能改', intent.buildOptionHint('').includes('换'), intent.buildOptionHint(''))
t('空参数不崩', typeof intent.buildOptionHint() === 'string' && intent.buildOptionHint().length > 0)

console.log('\n=== 8. 从模型回答里抠「去哪」（这条路现在没接，格式得先钉住） ===')
t('认 novel', intent.parseIntentReply('好。【去哪】novel') === 'novel', intent.parseIntentReply('好。【去哪】novel'))
t('认 game', intent.parseIntentReply('【去哪】game') === 'game')
t('认 tavern', intent.parseIntentReply('【去哪】tavern') === 'tavern')
t('认 diary', intent.parseIntentReply('【去哪】diary') === 'diary')
t('认中文：写小说', intent.parseIntentReply('【去哪】写小说') === 'novel', intent.parseIntentReply('【去哪】写小说'))
t('认中文：文字小说游戏', intent.parseIntentReply('【去哪】文字小说游戏') === 'game', intent.parseIntentReply('【去哪】文字小说游戏'))
t('认中文：酒馆', intent.parseIntentReply('【去哪】酒馆') === 'tavern')
t('认中文：日记', intent.parseIntentReply('【去哪】日记') === 'diary')
t('标记后面换行也算', intent.parseIntentReply('想了一下。\n【去哪】\n酒馆\n理由是……') === 'tavern')
t('标记前后有解释也不影响', intent.parseIntentReply('【去哪】game 因为他想玩') === 'game')
t('没有标记回空串', intent.parseIntentReply('我觉得应该去酒馆') === '')
t('标记后面是空的回空串', intent.parseIntentReply('【去哪】') === '')
t('标记后面只换行也回空串', intent.parseIntentReply('【去哪】\n\n  \n') === '')
t('不认识的回答回空串', intent.parseIntentReply('【去哪】某某某') === '')
t('空字符串回空串', intent.parseIntentReply('') === '')
t('null 不崩', intent.parseIntentReply(null) === '')
t('undefined 不崩', intent.parseIntentReply(undefined) === '')
// 边界：模型可能把门名写进英文句子里，"novelty" 这种词不该被认成 novel。
t('英文单词里夹着 id 不算（novelty ≠ novel）', intent.parseIntentReply('【去哪】novelty') === '', intent.parseIntentReply('【去哪】novelty'))

console.log('\n=== 9. 边界：不崩、不卡 ===')
{
  const r = intent.judgeIntent({})
  t('judgeIntent({}) 不崩', r !== null && typeof r === 'object')
  t('judgeIntent({}) 给出四个选项', r.options.length === 4)
  t('judgeIntent({}) 不算有把握', r.confident === false)
}
t('null 不崩', intent.judgeIntent(null).options.length === 4)
t('undefined 不崩', intent.judgeIntent(undefined).options.length === 4)
t('text 是 null 不崩', intent.judgeIntent({ text: null }).mode === '')
t('text 是数字不崩', intent.judgeIntent({ text: 12345 }).mode === '')
t('text 是数组不崩', intent.judgeIntent({ text: ['写小说'] }).mode === 'novel')
{
  // 用户可能把一整章正文贴进来。一万字要在一瞬间出结果——这里只验它能回来。
  const long = '写小说'.repeat(3333) // 9999 字
  const t0 = Date.now()
  const r = intent.judgeIntent({ text: long })
  const ms = Date.now() - t0
  t('一万字也判得出来', r.mode === 'novel' && r.confident === true, r.mode)
  t('一万字不卡（远小于 200ms）', ms < 200, `${ms}ms`)
}
{
  // 关键词密集但完全打散的一大段：不许爆栈、不许空回。
  const long = Array.from({ length: 4000 }, (_, i) => (i % 2 === 0 ? '章节' : '结局')).join(' ')
  const r = intent.judgeIntent({ text: long })
  t('打散的长文本也给出结构完整的答案',
    r.options.length === 4 && typeof r.why === 'string' && r.why !== '', r.mode)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
