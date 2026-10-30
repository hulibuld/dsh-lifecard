// 「聊一聊」到底把用户送到哪儿去了？
//
// 真事故（用户 2026-10-29 报）：点「聊一聊」确实开了新会话，但输入框是空的，
// 预设和 skill 都没加载。根因是旧实现靠 uiWorkspace.startSession 往输入框里
// 「摆草稿」——摆草稿要等那一屏的输入框就绪，任何一环慢一点就被静默跳过。
//
// 现在的实现改成：自己建会话（顺手指定预设）→ 打开它 → 把第一句直接发出去。
// 这个文件只验这条链：建会话时带了哪个预设、发出去的那句话长什么样、
// 会话切到眼前没有、以及「预设没被认下来」「建会话失败」时会不会说出来。
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const t = (n, c, x) => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, x === undefined ? '' : String(x).slice(0, 400)) } }

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const openAt = source.indexOf('factory: (require) => {')
const closeAt = source.lastIndexOf('\n});')
let body = source.slice(openAt + 'factory: (require) => {'.length, closeAt)
body = body.replace(/\}\s*$/, '')

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (init) => ({ current: init }),
  useCallback: (fn) => fn,
  Fragment: 'fragment',
}
const fakeRequire = () => fakeReact
const fakeWindow = {}
const document = { head: { appendChild() {} }, createElement: () => ({ setAttribute() {}, appendChild() {} }), querySelector: () => null }

function load() {
  const module = { exports: {} }
  const factory = new Function('require', 'module', 'exports', 'window', 'document', body + '\n')
  return factory(fakeRequire, module, module.exports, fakeWindow, document)
}

console.log('\n=== 聊一聊：建会话、带预设、把第一句发出去 ===')

const calls = { created: [], prompted: [], opened: [] }
const remote = {
  create: async (req) => {
    calls.created.push(req)
    return { sessionId: `sess-${calls.created.length}`, agentPreset: req?.agentPreset }
  },
  prompt: async (req) => { calls.prompted.push(req) },
}
const ui = { openSession: (id) => { calls.opened.push(id) }, startSession: () => { throw new Error('不该再走摆草稿这条路') } }

const api = load()
api.__setHostServices(remote, ui)

const run = async (args) => api.__openInterviewSession(args)

// 一、真人门：预设是 lc-real，第一句里有 skill 手势与意图。
{
  const r = await run({ about: '妈妈', mode: 'real' })
  t('开了新会话', calls.created.length === 1, JSON.stringify(calls.created))
  t('建会话时指定了这扇门的预设', calls.created[0]?.agentPreset === 'lc-real', JSON.stringify(calls.created[0]))
  const text = String(calls.prompted[0]?.content?.[0]?.text ?? '')
  t('第一句里带着访谈那个 skill', text.includes('/lifecard-interview'), text)
  t('第一句说清要给谁补卡', text.includes('妈妈'), text)
  t('发消息用的是队列模式', calls.prompted[0]?.mode === 'queue', JSON.stringify(calls.prompted[0]))
  t('把新会话切到眼前了', calls.opened[0] === 'sess-1', JSON.stringify(calls.opened))
  t('回来时说自己办成了', r?.ok === true, JSON.stringify(r))
}

// 二、酒馆 / 小说门各走自己的预设，并说明这是虚构角色。
{
  const before = calls.created.length
  await run({ about: '', mode: 'tavern' })
  await run({ about: '', mode: 'novel' })
  t('酒馆门用 lc-tavern', calls.created[before]?.agentPreset === 'lc-tavern', JSON.stringify(calls.created[before]))
  t('小说门用 lc-novel', calls.created[before + 1]?.agentPreset === 'lc-novel', JSON.stringify(calls.created[before + 1]))
  const tavernText = String(calls.prompted[before]?.content?.[0]?.text ?? '')
  t('酒馆那张说清是虚构的', tavernText.includes('虚构'), tavernText)
  t('没给名字时说的是建一张新卡', tavernText.includes('帮我建一张新的人物卡'), tavernText)
}

// 三、宿主没认这套预设：不能假装成功，要照实说。
{
  const picky = { create: async () => ({ sessionId: 'sess-x', agentPreset: 'standard' }), prompt: async (req) => calls.prompted.push(req) }
  api.__setHostServices(picky, ui)
  const r = await run({ about: '张三', mode: 'real' })
  t('预设没被认下来时仍然算开成了', r?.ok === true, JSON.stringify(r))
  t('但把「实际跑的是哪套」说出来了', String(r?.note ?? '').includes('standard'), JSON.stringify(r))
}

// 四、建会话直接失败：不许静默，要把那句话交回去让人自己复制。
{
  const broken = { create: async () => { throw new Error('这台机器的会话服务没响应') }, prompt: async () => {} }
  api.__setHostServices(broken, ui)
  const r = await run({ about: '张三', mode: 'real' })
  t('建会话失败时如实报错', r?.ok === false, JSON.stringify(r))
  t('报错里带着可以自己复制的那句话', String(r?.prompt ?? '').includes('/lifecard-interview'), JSON.stringify(r))
  t('报错说的是人话，没有堆栈', String(r?.reason ?? '').includes('会话服务没响应') && !String(r?.reason ?? '').includes('    at '), String(r?.reason))
}

// 四b、后台建会话（真机走的就是这条）：后台返回 sessionId 就直接算开成。
{
  const posts = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    posts.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    if (String(url).endsWith('/session.open')) {
      return { ok: true, json: async () => ({ ok: true, sessionId: 'srv-1', agentPreset: 'lc-real', sent: true }) }
    }
    return { ok: true, json: async () => ({ ok: true }) }
  }
  const opened = []
  api.__setHostServices(null, { openSession: (id) => opened.push(id), startSession: () => { throw new Error('不该走摆草稿') } })
  const r = await api.__openInterviewSession({ about: '钱俊锋', mode: 'real' })
  globalThis.fetch = realFetch
  const asked = posts.find((p) => p.url.endsWith('/session.open'))
  t('后台那条路被用上了', asked !== undefined, JSON.stringify(posts.map((p) => p.url)))
  t('交给后台的预设对得上这扇门', asked?.body?.preset === 'lc-real', JSON.stringify(asked?.body))
  t('交给后台的第一句带着访谈那个 skill', String(asked?.body?.text ?? '').includes('/lifecard-interview'), JSON.stringify(asked?.body))
  t('后台建好的会话被切到眼前', opened[0] === 'srv-1', JSON.stringify(opened))
  t('这条路也说自己办成了', r?.ok === true, JSON.stringify(r))
}

// 五、老宿主（没有远程会话能力）：退回摆草稿，行为跟以前一样。
{
  const drafts = []
  const legacy = { startSession: (workspaceId, options) => { drafts.push({ workspaceId, ...(options ?? {}) }); return Promise.resolve() } }
  api.__setHostServices(null, legacy)
  const r = await api.__openInterviewSession({ about: '李四', mode: 'real' })
  t('老宿主上摆的是草稿', drafts.length === 1 && String(drafts[0]?.prompt ?? '').includes('/lifecard-interview'), JSON.stringify(drafts))
  t('老宿主上也带着预设', drafts[0]?.agentPreset === 'lc-real', JSON.stringify(drafts))
}

// 六、两样能力都没有：说清楚，别假装。
{
  api.__setHostServices(null, null)
  const r = await api.__openInterviewSession({ about: '', mode: 'real' })
  t('什么能力都没有时说自己办不到', r?.ok === false, JSON.stringify(r))
  t('并且把该复制的那句话一起交回来', String(r?.prompt ?? '').includes('/lifecard-interview'), JSON.stringify(r))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
