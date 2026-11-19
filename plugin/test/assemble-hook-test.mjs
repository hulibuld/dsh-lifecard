// system-prompt/assemble 这个钩子端到端跑一遍。
//
// 为什么专门一个文件：这个钩子是「卡进不进系统提示」的唯一通路，但它一直是
// 空白的——查真机日志时发现 `agentOfAssembly` 要求 `context.agent.session`
// 非空，而真机上 context 并不保证长那样，于是钩子第一句就 return，卡永远
// 进不去、日志里一条 assemble 都没有。这种「整条链路静默失效」只有真把
// apply() 跑起来、再拿几种不同的 context 形状去戳，才抓得住。
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'

import * as api from '../lib/index.js'

let pass = 0, fail = 0
const t = (n, c, x) => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, x === undefined ? '' : String(x).slice(0, 300)) } }

const root = await mkdtemp(path.join(os.tmpdir(), 'lc-assemble-'))
const put = async (rel, text) => {
  const abs = path.join(root, rel)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, text)
}
await put('people/shen.card.md', [
  '---',
  'lifecard: "0.1"',
  'id: shen',
  'kind: fictional',
  'name: 沈九',
  'world: reality',
  '---',
  '',
  '## 自述',
  '旧码头上修船的。',
].join('\n'))
await put('lifecard.config.json', JSON.stringify({ version: 1, default_cards: { tavern: 'shen', novel: '', real: '', diary: '' } }))

// 四扇门各自的牌子（真实 prefix 里那句独有的话）。
const MARK = {
  tavern: '这份提示词里只有一个身份，就是你。没有另一个身份在旁边等着接管。',
  novel: '你在帮用户写小说。',
  diary: '你在陪用户写今天这一篇日记。',
  real: '你在帮用户处理现实里的事：简历、升学与求职的方向、眼下该补什么。',
}

/** 一份像宿主组装出来的 assembly。 */
function assemblyOf(mark) {
  return {
    sections: [
      { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek.' },
      { name: 'deployment:persona-prefix', text: mark },
      { name: 'tool:read', text: 'Use the read tool.' },
      { name: 'deployment:persona-suffix', text: '收尾几句。' },
    ],
  }
}

// ── 把插件跑起来，手里攥住那个钩子 ────────────────────────────────
const handlers = []
const ctx = {
  get: () => undefined,
  effect: (fn) => { fn(); return () => {} },
  inject: () => {},
  on: (event, fn) => { if (event === 'system-prompt/assemble') handlers.push(fn); return () => {} },
  logger: { warn: () => {}, error: () => {} },
  webServer: { register: () => () => {} },
}
api.apply(ctx, { workspace: root })

t('钩子挂上了', handlers.length === 1, handlers.length)

const run = async (context, mark, opts = {}) => {
  const assembly = opts.assembly ?? assemblyOf(mark)
  const out = await handlers[0](assembly, context, async () => assembly)
  return out
}

// 真机上见到过的那几种 context 形状。一个都不能漏——漏哪个，那种会话里
// 卡就是静默地进不去。
const shapes = {
  'agent 带 session': { agent: { id: 'a1', session: { id: 's1' }, ctx: {} } },
  'agent 不带 session': { agent: { id: 'a2', ctx: {} } },
  '只有 scope': { scope: { id: 'a3', session: { id: 's3' }, ctx: {} } },
  '只有 session': { session: { id: 's4', ctx: {} } },
  '光秃秃一个 ctx（最坏情况）': { ctx: {} },
}

for (const [label, context] of Object.entries(shapes)) {
  const out = await run(context, MARK.tavern)
  const names = (out.sections ?? []).map((one) => String(one.name ?? ''))
  const blob = (out.sections ?? []).map((one) => String(one.text ?? '')).join('\n')
  t(`[${label}] 卡进来了`, blob.includes('旧码头上修船的') || names.includes('lifecard:card'), `${names.join(',')} | ${blob.slice(0, 120)}`)
}

// 认对门：酒馆门要真的换掉身份句和「角色扮演」那段。
{
  const out = await run(shapes['agent 带 session'], MARK.tavern)
  const blob = (out.sections ?? []).map((one) => String(one.text ?? '')).join('\n')
  t('酒馆门把「你是 DeepSeek 的 agent」拿掉了', !blob.includes('You are an AI agent'), blob.slice(0, 200))
  t('酒馆门把门牌那句也换掉了', !blob.includes('这份提示词里只有一个身份'))
  t('酒馆门里卡正文在', blob.includes('旧码头上修船的'))
  t('酒馆门留着工具说明（不然调不了工具）', blob.includes('Use the read tool.'))
  t('酒馆门留着收尾段', (out.sections ?? []).some((one) => one.name === 'deployment:persona-suffix'))
}

// 现实门不注入：那扇门的 preset 自己写着「用 lifecard_cards 去取」，
// 卡是查出来的材料，不是身份。
{
  const out = await run(shapes['agent 带 session'], MARK.real)
  const blob = (out.sections ?? []).map((one) => String(one.text ?? '')).join('\n')
  t('现实门一个字都不改', !blob.includes('旧码头上修船的'))
  t('现实门把那句技术身份句留着', blob.includes('You are an AI agent'))
}

// 认不出门时原样返回（宁可不动，也不要乱改别人的提示词）。
{
  const out = await run(shapes['agent 带 session'], '一段谁也不认识的话。')
  const blob = (out.sections ?? []).map((one) => String(one.text ?? '')).join('\n')
  t('认不出门就原样返回', blob.includes('You are an AI agent') && !blob.includes('旧码头上修船的'))
}

// 小说门：卡在最前，身份句留着（那扇门模型不变，只是写的时候按这个人）。
// 每扇门各钉各的卡，小说门这段得自己钉一次，不然它压根没挑人。
{
  await put('lifecard.config.json', JSON.stringify({ version: 1, default_cards: { tavern: 'shen', novel: 'shen', real: '', diary: '' } }))
  const out = await run(shapes['agent 带 session'], MARK.novel)
  const names = (out.sections ?? []).map((one) => String(one.name ?? ''))
  const blob = (out.sections ?? []).map((one) => String(one.text ?? '')).join('\n')
  t('小说门把卡提到最前', names[0] === 'lifecard:card', names.join(','))
  t('小说门留着身份句', blob.includes('You are an AI agent'))
  t('小说门不换掉部署人设', blob.includes('你在帮用户写小说。'))
}

// 没挑卡时不要往提示词里塞空壳。
{
  await put('lifecard.config.json', JSON.stringify({ version: 1, default_cards: { tavern: '', novel: '', real: '', diary: '' } }))
  const out = await run(shapes['agent 带 session'], MARK.tavern)
  const blob = (out.sections ?? []).map((one) => String(one.text ?? '')).join('\n')
  t('没挑卡时原样返回', blob.includes('You are an AI agent') && !blob.includes('旧码头上修船的'))
}

// 钩子绝不能把这一轮搞挂：判门或拼卡抛错都要退回原样。
{
  await put('lifecard.config.json', JSON.stringify({ version: 1, default_cards: { tavern: 'shen', novel: '', real: '', diary: '' } }))
  const broken = { sections: [{ get name() { throw new Error('boom') }, text: MARK.tavern }] }
  let threw = ''
  let out = null
  try {
    out = await handlers[0](broken, shapes['agent 带 session'], async () => broken)
  } catch (error) {
    threw = String(error && error.message)
  }
  t('段落读不动也不抛错', threw === '', threw)
  t('段落读不动时原样返回', out === broken || out !== null)

  const noSections = await handlers[0]({}, shapes['agent 带 session'], async () => ({}))
  t('没有 sections 也不崩', noSections !== null && noSections !== undefined)
}

await rm(root, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
