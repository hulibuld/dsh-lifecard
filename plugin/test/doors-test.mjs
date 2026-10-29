// 「我在哪扇门里」必须跟着人走，不能靠「当前在哪一屏」去猜。
//
// 真事故（用户 2026-10-24 报）：开酒馆、开写小说，点「聊着建」，界面都在说
// 「你在记录一个现实里的人」。根因是 mode 从 view 推——一进访谈页 view 就是
// interview，推出来只能是 real。
//
// 为什么必须单独一个测试文件：render-all.mjs 是「给组件直接塞 mode」的写法，
// 它测的是「拿到 mode 之后画得对不对」，测不出「点门之后 mode 有没有跟上」。
// 这条路径只有真的点一遍才看得见，所以这里用会记录调用的假组件从根部点下去。
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const t = (n, c, x) => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, x === undefined ? '' : String(x).slice(0, 400)) } }

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ── 假 React（只够把根组件跑起来并留下 hook 槽）──────────────────
let hookStore = []
let hookIndex = 0
const fakeReact = {
  createElement: (type, props, ...children) => {
    const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
    const merged = { ...(props ?? {}) }
    if (flat.length > 0) merged.children = flat.length === 1 ? flat[0] : flat
    return { type, props: merged, children: flat }
  },
  useState: (init) => {
    const i = hookIndex++
    if (hookStore[i] === undefined) hookStore[i] = typeof init === 'function' ? init() : init
    return [hookStore[i], (v) => { hookStore[i] = typeof v === 'function' ? v(hookStore[i]) : v }]
  },
  // effect 只记下来，不自动跑：绝大多数用例只关心「点下去变成哪一屏」，
  // 真跑起来会连带打一堆请求。要验「读不到东西时界面上有没有话说」的用例
  // 自己调 runRootEffects()——那正是这几个 bug 的现场。
  useEffect: (fn, deps) => {
    const i = hookIndex++
    if (rootRendering === true && typeof fn === 'function') rootEffects.push({ fn, deps })
  },
  useMemo: (fn) => fn(),
  useRef: (init) => { const i = hookIndex++; if (hookStore[i] === undefined) hookStore[i] = { current: init }; return hookStore[i] },
  useCallback: (fn) => fn,
}
const fakeRequire = (name) => {
  if (name === 'react') return fakeReact
  if (name === 'react/jsx-runtime') return { jsx: fakeReact.createElement, jsxs: fakeReact.createElement, Fragment: 'Fragment' }
  throw new Error('unexpected require: ' + name)
}
const fakeWindow = {
  __ModuleLoader__: { load(spec) { fakeWindow.__spec = spec } },
  addEventListener() {}, removeEventListener() {},
  confirm: () => true,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
}
globalThis.window = fakeWindow
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '', setAttribute() {}, appendChild() {}, click() {}, style: {} }),
  head: { appendChild() {} },
  body: { appendChild() {}, removeChild() {} },
  addEventListener() {}, removeEventListener() {},
}
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, exists: true, workspace: '/tmp/x', relations: [] }) })
globalThis.FileReader = class {}
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')
globalThis.Blob = class { constructor() {} }
globalThis.URL.createObjectURL = () => 'blob:x'
globalThis.URL.revokeObjectURL = () => {}

let rootEffects = []
let rootRendering = false

const module = { exports: {} }
const openAt = source.indexOf('factory: (require) => {')
const closeAt = source.lastIndexOf('\n});')
let body = source.slice(openAt + 'factory: (require) => {'.length, closeAt)
body = body.replace(/\}\s*$/, '')
const factory = new Function('require', 'module', 'exports', 'window', 'document', body + '\n')
const api = factory(fakeRequire, module, module.exports, fakeWindow, document)

const registered = []
// 宿主那儿「开一个新会话」这个能力。记下每一次调用：插件点的到底是
// 新会话，还是又在自己内部切一屏，看这个数组就够了。
const SESSIONS = []
const uiWorkspace = {
  startSession: (workspaceId, options) => {
    SESSIONS.push({ workspaceId, ...(options ?? {}) })
    return Promise.resolve()
  },
}
// 老版本宿主：根本没有 uiWorkspace 这个服务。
const NO_UI = { get: () => undefined, effect: (fn) => { fn(); return () => {} } }
api.apply({
  get: (name) => {
    if (name === 'betterSidebar') return { registerTab: (d) => { registered.push(d); return () => {} } }
    if (name === 'uiWorkspace') return uiWorkspace
    return undefined
  },
  effect: (fn) => { fn(); return () => {} },
})
const Root = api.LifeCardTab

// ── 一路展开，把「函数型节点」都渲染掉，留下纯 DOM 树 ──────────
// 顺便记下每一个组件被调用时收到的 props：门的名字就是这么传下去的。
const seenProps = new Map()
const seenType = new Map()
const rendered = []

function deepRender(node, depth = 0) {
  if (node === null || node === undefined || depth > 45) return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((n) => deepRender(n, depth + 1)).filter((n) => n !== null)
  if (typeof node !== 'object') return null
  if (typeof node.type === 'function') {
    const name = node.type.name || ''
    if (name !== '') {
      seenProps.set(name, node.props ?? {})
      seenType.set(name, node.type)
      rendered.push({ name, props: node.props ?? {} })
    }
    const savedStore = hookStore
    const savedIndex = hookIndex
    // 子组件各自一份状态，不然整棵树会共用一个槽位数组
    if (name !== 'LifeCardTab') { hookStore = []; hookIndex = 0 }
    let out
    try { out = node.type(node.props ?? {}) } finally { hookStore = savedStore; hookIndex = savedIndex }
    return deepRender(out, depth + 1)
  }
  return { type: node.type, props: node.props ?? {}, children: deepRender(node.props?.children, depth + 1) }
}

function findNodes(node, pred, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const n of node) findNodes(n, pred, out); return out }
  if (typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  findNodes(node.children, pred, out)
  return out
}
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return ''
  return textOf(node.children)
}
const clickButtonWith = (tree, wanted) => {
  const hit = findNodes(tree, (n) => n.type === 'button' && typeof n.props?.onClick === 'function' && textOf(n).includes(wanted))[0]
  if (hit === undefined) return false
  hit.props.onClick()
  return true
}

const STATE = {
  ok: true, workspace: '/tmp/x', exists: true, home: '/Users/joy',
  hasLlm: true, defaults: { workspace: '/tmp/x' }, summary: {}, relations: [],
}
const LISTING = {
  ok: true, workspace: '/tmp/x', cards: [], worlds: [], systems: [], relations: [],
  materials: [], errors: [], proposals: [], avatars: {},
}

/** 从头渲染一次根组件（hook 槽由 presets 指定）。 */
function renderRoot(presets = {}) {
  hookIndex = 0
  hookStore = []
  for (const [k, v] of Object.entries(presets)) hookStore[Number(k)] = v
  rootEffects = []
  rootRendering = true
  let tree = null
  try { tree = Root({ visible: true }) } finally { rootRendering = false }
  return deepRender(tree)
}

/**
 * 把根组件这一次渲染里挂上的 effect 真的跑一遍，等它把话说回来。
 *
 * 假 React 平时只占槽不跑 effect——大部分用例只关心「点下去切到哪一屏」。
 * 但「后台读不出来的时候界面上有没有话说」这件事，只有让 effect 真跑才看得见。
 */
async function runRootEffects() {
  const list = rootEffects
  rootEffects = []
  for (const { fn } of list) {
    try {
      const out = fn()
      if (out !== null && typeof out?.then === 'function') await out
    } catch (e) {
      // effect 自己炸了不影响界面；断言那边会看到界面上仍然什么都没说
    }
  }
  await new Promise((r) => setTimeout(r, 40))
}

// 根组件的槽：0 view / 1 state / 2 listing / 3 busy / 4 error / 5 toast /
// 6 activeCard / 7 proposal / 8 doctor / 9 interviewFor / 10 showMore /
// 11 activeWorld / 12 pendingAbout / 13 introSeen / 14 materialFor / 15 ref /
// 16 chat / 17 chats / 24 door / 25 activeBook / 26 books（实测，每次加 state 都要重探）
const base = (view, extra = {}) => ({ 0: view, 1: STATE, 2: LISTING, 3: '', 4: null, 5: null, 6: null, 7: null, 8: null, 9: null, 10: false, 11: null, 12: '', 13: true, 14: null, ...extra })

console.log('\n=== 1. 点哪扇门，点「聊一聊」就开哪扇门的新会话 ===')
for (const [doorLabel, doorId, expectWord, forbidWord, expectPreset, expectPhrase] of [
  ['真实人物记录', 'real', '现实里的人', null, 'lc-real', '帮我建一张新的人物卡'],
  ['写小说', 'novel', '小说角色', '现实里的人', 'lc-novel', '小说里的一个虚构角色'],
  ['酒馆', 'tavern', '可以演的虚构角色', '现实里的人', 'lc-tavern', '酒馆里要演的一个虚构角色'],
]) {
  // ① 进门口那一屏，点门的名字
  const doors = renderRoot(base('doors'))
  const picked = clickButtonWith(doors, doorLabel)
  if (!picked) { t(`找得到「${doorLabel}」这扇门`, false, textOf(doors).slice(0, 200)); continue }
  const viewAfterDoor = hookStore[0]
  t(`点「${doorLabel}」进到那一屏`, viewAfterDoor === (doorId === 'real' ? 'home' : doorId), String(viewAfterDoor))

  // ② 在那一扇门的首页点「聊一聊」：插件不再自己演一遍访谈，
  //    改成开一个新会话，输入框里摆好 skill 和一句意图。
  const home = renderRoot({ ...base(viewAfterDoor), 24: doorId })
  const before = SESSIONS.length
  const clicked = clickButtonWith(home, '聊一聊')
  // 现在是异步的：先让后台建会话，再拿出「开了哪一场」来断言。
  await new Promise((r) => setTimeout(r, 30))
  const viewAfterClick = hookStore[0]
  const session = SESSIONS[before] ?? {}
  t(`「${doorLabel}」里点得动聊一聊`, clicked === true)
  t(`点完不再切到插件里的访谈页（${doorLabel}）`, viewAfterClick !== 'interview', String(viewAfterClick))
  t(`点完开了一个新会话（${doorLabel}）`, SESSIONS.length === before + 1, JSON.stringify(SESSIONS.slice(-2)))
  t(`新会话带着访谈那个 skill（${doorLabel}）`, String(session.prompt ?? '').includes('/lifecard-interview'), JSON.stringify(session))
  t(`「${doorLabel}」用的是这扇门自己的预设`, session.agentPreset === expectPreset, String(session.agentPreset))
  t(`「${doorLabel}」那句意图说的就是这扇门`, String(session.prompt ?? '').includes(expectPhrase), JSON.stringify(session))
  t(`草稿是换掉上一份，不是往后接（${doorLabel}）`,
    session.whenDraftExists === 'replace' && session.clearPreviousDraft === false,
    JSON.stringify({ whenDraftExists: session.whenDraftExists, clearPreviousDraft: session.clearPreviousDraft }))

  // ③ 留作参考的那个访谈页自己还认得门（有入口才用得上，但代码没坏）
  const interview = renderRoot({ ...base('interview'), 24: doorId })
  const words = textOf(interview)
  t(`留着的那一屏仍说的是「${expectWord}」（${doorLabel}）`, words.includes(expectWord), words.slice(0, 300))
  if (forbidWord !== null) {
    t(`留着的那一屏不说「${forbidWord}」（${doorLabel}）`, !words.includes(forbidWord), words.slice(0, 300))
  }
}

console.log('\n=== 2. 门记住之后，进别的子页面也不丢 ===')
{
  // 从酒馆门进「聊着建」，再进卡片页、分析页——门还是酒馆
  for (const view of ['interview', 'card', 'analyze', 'import', 'newCard']) {
    const tree = renderRoot({ ...base(view), 24: 'tavern' })
    const json = JSON.stringify(seenProps.get('HomeView') ?? {})
    // 只有首页类视图才会渲染 HomeView；别的时候检查标题栏那句话
    if (view === 'interview') {
      const words = textOf(tree)
      t(`酒馆门进「${view}」还认得是酒馆`, words.includes('可以演的虚构角色') || words.includes('酒馆'), words.slice(0, 200))
    } else if (view === 'card') {
      t(`酒馆门进「${view}」不变成真实人物门`, !textOf(tree).includes('贴一份招聘说明'), textOf(tree).slice(0, 200))
    } else {
      t(`酒馆门进「${view}」不崩`, tree !== null)
    }
  }
}

console.log('\n=== 3. 没选过门时按真实人物算（老用户直接进首页也不会错）===')
{
  const home = renderRoot({ ...base('home') })
  const words = textOf(home)
  t('默认那扇门是真实人物记录', words.includes('下一步') || words.includes('认识的人') || words.includes('还没有档案'), words.slice(0, 200))
}

console.log('\n=== 4. 列表里能直接删卡（不用先进去滚到底）===')
{
  // 真事故：建错几张（比如「复制一份来演」试了几次），想删就得先点开卡、
  // 滚到最下面才找得到删除——列表里完全删不了。
  const listing = {
    ok: true, workspace: '/tmp/x', errors: [], materials: [], worlds: [], proposals: [], avatars: {},
    cards: [
      { id: 'lin', path: 'people/lin.card.md', name: '林小雨', kind: 'fictional', coverage: 40, tags: [] },
      { id: 'mama', path: 'people/mama.card.md', name: '妈妈', kind: 'real', relation: '母亲', coverage: 62, tags: [] },
    ],
  }
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') })
    return { ok: true, json: async () => ({ ok: true, exists: true, workspace: '/tmp/x', relations: [], cards: [], materials: [], worlds: [], proposals: [], errors: [] }) }
  }
  try {
    const tree = renderRoot({ ...base('home'), 2: listing })
    // 每张卡旁边都得有一个「删掉「X」」的按钮
    const trash = findNodes(tree, (n) => n.type === 'button' && typeof n.props?.title === 'string' && n.props.title.startsWith('删掉'))
    // 卡有正反两面，两面各留一个删除入口（翻到背面也能删），所以每张卡两个。
    const trashNames = [...new Set(trash.map((b) => b.props.title))]
    t('列表里每张卡都有删除按钮', trashNames.length === 2, trashNames)
    t('删除按钮带名字，不会删错人', trash.some((b) => b.props.title.includes('林小雨')) && trash.some((b) => b.props.title.includes('妈妈')), trash.map((b) => b.props.title))

    // 点一下：先问一句，问的话要说清后果
    const asked = []
    const realConfirm = fakeWindow.confirm
    fakeWindow.confirm = (msg) => { asked.push(String(msg)); return true }
    const lin = trash.find((b) => b.props.title.includes('林小雨'))
    lin.props.onClick({ stopPropagation() {} })
    await new Promise((r) => setTimeout(r, 40))
    t('删之前先问一句', asked.length === 1, asked)
    // 删卡现在不是「烧掉」，是从列表里撤下去（原文还在）。问的时候得照实说，
    // 再写「一起删掉」就是在骗人——下面「已经撤掉的」里明明能点回来。
    t('问的时候照实说它会去哪', asked[0].includes('已经撤掉的') && asked[0].includes('放回来'), asked[0])
    t('并且说清材料不受影响', asked[0].includes('材料是另一份文件'), asked[0])
    const del = calls.find((c) => c.url.includes('card.delete'))
    t('真的发了删除请求', del !== undefined, calls.map((c) => c.url.split('/').pop()))
    t('删的是点的那一张，不是第一张', String(del?.body ?? '').includes('people/lin.card.md'), del?.body)

    // 点「取消」就什么都不做
    fakeWindow.confirm = () => false
    calls.length = 0
    const again = renderRoot({ ...base('home'), 2: listing })
    const lin2 = findNodes(again, (n) => n.type === 'button' && typeof n.props?.title === 'string' && n.props.title.includes('林小雨'))[0]
    lin2.props.onClick({ stopPropagation() {} })
    await new Promise((r) => setTimeout(r, 30))
    t('点取消就一个请求都不发', calls.filter((c) => c.url.includes('card.delete')).length === 0, calls.map((c) => c.url.split('/').pop()))
    fakeWindow.confirm = realConfirm
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log('\n=== 5. 「还等着你看的建议」只在它那扇门里提醒 ===')
{
  // 真事故（用户 2026-10-25 报）：在酒馆里写着小说，头顶一直挂着
  // 「关于『妈妈』的建议」；记录真人的时候又挂着小说角色的建议。
  const listing = {
    ok: true, workspace: '/tmp/x', errors: [], materials: [], worlds: [], avatars: {},
    cards: [
      { id: 'mama', path: 'people/mama.card.md', name: '妈妈', kind: 'real', relation: '母亲', coverage: 60, tags: [] },
      { id: 'lin', path: 'people/lin.card.md', name: '林小雨', kind: 'fictional', coverage: 40, tags: [] },
    ],
    proposals: [
      { json: 'proposals/mama.json', about: '妈妈', accepted: 3, adopted: 0, rejected: 0, generated_at: '2026-10-25' },
      { json: 'proposals/lin.json', about: '林小雨', accepted: 2, adopted: 0, rejected: 0, generated_at: '2026-10-25' },
      { json: 'proposals/nobody.json', about: '还没有卡的人', accepted: 1, adopted: 0, rejected: 0, generated_at: '2026-10-25' },
    ],
  }
  // 只截「还等着你看的建议」那一段：卡列表里出现虚构角色是正常的
  // （真人那扇门也让人看见所有卡），要验的是**建议那一栏**有没有串门。
  const proposalsPart = (text) => {
    const i = text.indexOf('还等着你看的建议')
    return i < 0 ? '' : text.slice(i)
  }

  // 现实那扇门（view=home）：只该看见妈妈 + 还没建卡的那个人
  const real = textOf(renderRoot({ ...base('home'), 2: listing }))
  const realP = proposalsPart(real)
  t('现实门里有「还等着你看的建议」这一栏', realP !== '', real.slice(0, 200))
  t('现实门里能看见「关于「妈妈」」', realP.includes('妈妈'), realP.slice(0, 200))
  t('现实门里看不见虚构角色林小雨的建议', !realP.includes('林小雨'), realP.slice(0, 200))
  t('现实门里能看见还没建卡那个人的建议（它也可能是真人）', realP.includes('还没有卡的人'), '')

  // 写小说那扇门：只该看见林小雨
  const novelDoor = textOf(renderRoot({ ...base('novel'), 2: listing, 24: 'novel' }))
  const novelP = proposalsPart(novelDoor)
  t('写小说门里能看见林小雨的建议', novelP.includes('林小雨'), novelP.slice(0, 200))
  t('写小说门里看不见妈妈的建议', !novelP.includes('妈妈'), novelP.slice(0, 200))

  // 酒馆那扇门：虚构角色照样算它这扇门的
  const tavernDoor = textOf(renderRoot({ ...base('tavern'), 2: listing, 24: 'tavern' }))
  const tavernP = proposalsPart(tavernDoor)
  t('酒馆门里能看见虚构角色的建议', tavernP.includes('林小雨'), tavernP.slice(0, 200))
  t('酒馆门里看不见真人的建议', !tavernP.includes('妈妈'), tavernP.slice(0, 200))
}

console.log('\n=== 6. 酒馆门里点卡是「打开这张卡」，不是直接开演 ===')
await (async () => {
  // 用户报的：在「可以拿来演的角色」里点一张卡，直接就开了一场新对话，
  // 想先看看这张卡上写了什么都做不到。
  const LIN = { id: 'lin', path: 'people/lin.card.md', name: '林小雨', kind: 'fictional', coverage: 40, tags: [] }
  const LIST = {
    ok: true, workspace: '/tmp/x', errors: [], materials: [], worlds: [], proposals: [], avatars: {},
    cards: [LIN, { id: 'mama', path: 'people/mama.card.md', name: '妈妈', kind: 'real', relation: '母亲', coverage: 62, tags: [] }],
  }
  const CARD = {
    ok: true, path: 'people/lin.card.md',
    data: { lifecard: '0.1', id: 'lin', kind: 'fictional', world: 'reality', name: '林小雨' },
    sections: [{ title: '自述', body: '她在便利店上夜班。' }],
    validation: { ok: true, issues: [] },
    coverage: { percent: 40, filled: 3, empty: [{ label: '口癖' }], rows: [], sourceLevels: [], unmarkedRatio: 0 },
  }
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') })
    return { ok: true, json: async () => ({ ok: true, exists: true, workspace: '/tmp/x', relations: [], cards: [], materials: [], worlds: [], proposals: [], errors: [], items: [] }) }
  }
  try {
    const tavernHome = renderRoot({ ...base('tavern'), 2: LIST, 24: 'tavern', 17: [] })
    // 卡面正面只有头像和名字，名字下面是「详细信息」；点这张卡本身是翻面。
    const cardBtn = findNodes(tavernHome, (n) => n.type === 'button' && textOf(n).includes('详细信息'))[0]
    t('酒馆门里看得到那张卡', textOf(tavernHome).includes('林小雨') && cardBtn !== undefined, textOf(tavernHome).slice(0, 300))
    if (cardBtn !== undefined) {
      cardBtn.props.onClick()
      // openCard 会先等 card.get 回来再切屏，所以要让出一轮
      await new Promise((r) => setTimeout(r, 10))
      t('点卡是打开这张卡', hookStore[0] === 'card', String(hookStore[0]))
    }
    t('点卡不会直接开一场新会话', calls.filter((c) => c.url.includes('tavern.start')).length === 0, calls.map((c) => c.url.split('/').pop()))

    // 卡页上不再有「和 TA 演一段」：演不演由列表里那个圆点决定
    const tavernCard = renderRoot({ ...base('card'), 2: LIST, 6: CARD, 24: 'tavern' })
    t('卡页上没有「和 TA 演一段」', !textOf(tavernCard).includes('和 TA 演一段'), textOf(tavernCard).slice(0, 300))
  } finally {
    globalThis.fetch = realFetch
  }
})()

console.log('\n=== 6b. 列表里能直接进修改（不用先点开再去卡页上找） ===')
{
  const LIST = {
    ok: true, workspace: '/tmp/x', errors: [], materials: [], worlds: [], proposals: [], avatars: {},
    cards: [{ id: 'lin', path: 'people/lin.card.md', name: '林小雨', kind: 'fictional', coverage: 10, tags: [] }],
  }
  const tree = renderRoot({ ...base('tavern'), 2: LIST, 24: 'tavern' })
  const editBtn = findNodes(tree, (n) => n.type === 'button' && typeof n.props?.title === 'string' && n.props.title.startsWith('改'))[0]
  t('每张卡都有「改」按钮', editBtn !== undefined, textOf(tree).slice(0, 200))
  if (editBtn !== undefined) t('「改」按钮带名字，不会点错人', editBtn.props.title.includes('林小雨'), editBtn.props.title)
}

console.log('\n=== 6c. 每扇门都能先挑「现在用哪张卡」 ===')
{
  const LIST = {
    ok: true, workspace: '/tmp/x', errors: [], materials: [], worlds: [], proposals: [], avatars: {},
    cards: [
      { id: 'lin', path: 'people/lin.card.md', name: '林小雨', kind: 'fictional', coverage: 40, tags: [] },
      { id: 'mama', path: 'people/mama.card.md', name: '妈妈', kind: 'real', relation: '母亲', coverage: 62, tags: [] },
    ],
  }
  for (const [view, doorId, want, pinId] of [
    ['tavern', 'tavern', '现在演谁', 'lin'],
    ['novel', 'novel', '现在写谁', 'lin'],
    ['home', 'real', '这扇门先看谁', 'mama'],
  ]) {
    const pins = { real: doorId === 'real' ? pinId : '', tavern: doorId === 'tavern' ? pinId : '', novel: doorId === 'novel' ? pinId : '' }
    const tree = renderRoot({ ...base(view), 2: LIST, 24: doorId, 29: pins })
    const words = textOf(tree)
    t(`${doorId} 那扇门能挑「${want}」`, words.includes(want), words.slice(0, 260))
    // 不再有下拉框：改成每张卡右上角一个圆点
    t(`${doorId} 不再用下拉框挑卡`, findNodes(tree, (n) => n.type === 'select').length === 0)
    const dots = findNodes(tree, (n) => n.type === 'button' && n.props?.['data-pinned'] !== undefined)
    // 这扇门里真正列出来的卡：酒馆/小说只列虚构角色，现实那扇门列真人。
    const listed = doorId === 'real' ? LIST.cards : LIST.cards.filter((c) => c.kind === 'fictional')
    t(`${doorId} 每张列出来的卡都有右上角的圆点`, dots.length === listed.length, dots.length)
    const green = dots.filter((n) => n.props['data-pinned'] === 'yes')
    t(`${doorId} 选着的那张是绿的`, green.length === 1 && green[0].props.style.background === 'var(--lc-doctor)', green.map((n) => n.props.title))
    const red = dots.filter((n) => n.props['data-pinned'] === 'no')
    t(`${doorId} 没选的是红的`, red.length === dots.length - green.length && red.every((n) => n.props.style.background === 'var(--lc-danger-soft)'), red.length)
    if (doorId === 'tavern') {
      const greenDot = green[0]
      const posted = []
      const realFetch = globalThis.fetch
      globalThis.fetch = async (url, init) => {
        posted.push({ url: String(url), body: String(init?.body ?? '') })
        return { ok: true, json: async () => ({ ok: true }) }
      }
      try {
        greenDot.props.onClick({ stopPropagation() {} })
        await new Promise((r) => setTimeout(r, 10))
      } finally {
        globalThis.fetch = realFetch
      }
      t('点绿的那张会取消（空 id 也发得出去）', posted.some((c) => c.body.includes('"id":""')), posted.map((c) => c.body).slice(0, 2))
      // 没挑卡时页面上要说清楚「这一场不读卡上的设定」。
      const none = renderRoot({ ...base('tavern'), 2: LIST, 24: 'tavern', 29: { real: '', tavern: '', novel: '' } })
      const noneWords = textOf(none)
      t('没挑卡时酒馆说清不读卡上的设定', noneWords.includes('不读卡上的设定') && noneWords.includes('把人立起来'), noneWords.slice(0, 300))
      const novelNone = renderRoot({ ...base('novel'), 2: LIST, 24: 'novel', 29: { real: '', tavern: '', novel: '' } })
      t('没挑卡时写小说说清不读设定', textOf(novelNone).includes('只按写作方法来写'), textOf(novelNone).slice(0, 300))
    }
  }
}

console.log('\n=== 7. 卡列表里的百分比要说明白是什么 ===')
{
  const LIST = {
    ok: true, workspace: '/tmp/x', errors: [], materials: [], worlds: [], proposals: [], avatars: {},
    cards: [{ id: 'lin', path: 'people/lin.card.md', name: '林小雨', kind: 'fictional', coverage: 10, tags: [] }],
  }
  const words = textOf(renderRoot({ ...base('home'), 2: LIST }))
  t('百分比旁边写着「写全」', words.includes('写全 10%'), words.slice(0, 200))
  t('不再只甩一个裸数字', !/(^|[^全 ])10%/.test(words.replace('写全 10%', '')), words.slice(0, 200))
}

console.log('\n=== 13. 门能收起来，也能装回来 ===')
{
  // 三扇门都在的时候：每扇门上都藏着一个「收起来」的按钮（鼠标放上去才露）
  const full = renderRoot(base('doors'))
  const hides = findNodes(full, (n) => typeof n.props?.['data-door-hide'] === 'string')
  t('三扇门各有一个收起来的按钮', hides.length === 3, hides.map((n) => n.props['data-door-hide']))
  t('没有收起来的门就没有灰门', findNodes(full, (n) => typeof n.props?.['data-door-dead'] === 'string').length === 0, '')

  // 收掉酒馆之后：酒馆那块不摆了，改摆一块灰黑的门
  const one = renderRoot(base('doors', { 1: { ...STATE, hidden_doors: ['tavern'] } }))
  const tree = one
  const dead = findNodes(tree, (n) => typeof n.props?.['data-door-dead'] === 'string')
  t('收起来的门变成一块灰门', dead.length === 1 && dead[0].props['data-door-dead'] === 'tavern', dead.length)
  t('灰门上没有「推门进去」', !textOf(dead[0]).includes('推门进去'), textOf(dead[0]).slice(0, 40))
  const backs = findNodes(tree, (n) => typeof n.props?.['data-door-show'] === 'string')
  t('灰门上有装回来的按钮', backs.length === 1 && backs[0].props['data-door-show'] === 'tavern', backs.length)

  // 点「装回来」要真的发请求
  const posts = []
  const before = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    posts.push(`${String(url)} ${String(init?.body ?? '')}`)
    return { ok: true, status: 200, json: async () => ({ ok: true, hidden_doors: [] }) }
  }
  await backs[0].props.onClick()
  globalThis.fetch = before
  t('装回来会请求把门放出来', posts.some((b) => b.includes('door.set') && b.includes('"hidden":false')), posts)
}

{
  // 2026-10-28：卡从「一行字」改成「一张卡」——正面只有头像和名字，
  // 点卡片翻面看简介；门上的删除入口是垃圾桶（叉容易看成「关闭」）。
  const cabinet = {
    cards: [
      { id: 'lin', path: 'people/lin.card.md', name: '林小雨', kind: 'fictional', coverage: 40, tags: [], intro: '在城南的旧书店做事。' },
    ],
    worlds: [], relations: [], materials: [], proposals: [], errors: [], systems: [], redactions: [],
  }
  const tree = renderRoot({ ...base('tavern'), 2: cabinet, 24: 'tavern', 17: [] })
  const faces = findNodes(tree, (n) => n.type === 'div' && n.props?.['data-face'] !== undefined)
  const front = faces.filter((n) => n.props['data-face'] === 'front')
  const back = faces.filter((n) => n.props['data-face'] === 'back')
  t('每张卡都有正反两面', front.length >= 1 && back.length === front.length, `${front.length}/${back.length}`)
  const frontText = front.map((n) => textOf(n)).join(' ')
  const backText = back.map((n) => textOf(n)).join(' ')
  t('正面只有名字和一个「详细信息」', frontText.includes('林小雨') && frontText.includes('详细信息'), frontText.slice(0, 160))
  t('正面不铺简介和百分比', !frontText.includes('写全') && !frontText.includes('这张卡还没写自述'), frontText.slice(0, 160))
  t('背面写简介和「写全多少」', backText.includes('写全 40%') && backText.includes('在城南的旧书店做事'), backText.slice(0, 160))
  t('点正面会翻面', typeof front[0]?.props?.onClick === 'function', typeof front[0]?.props?.onClick)
  t('点背面会翻回来', typeof back[0]?.props?.onClick === 'function', typeof back[0]?.props?.onClick)

  // 收起来的按钮在「选门」那一屏，不在门里的首页。
  const doorsScreen = renderRoot(base('doors'))
  const hides = findNodes(doorsScreen, (n) => n.type === 'button' && n.props?.['data-door-hide'] !== undefined)
  // 叉容易被读成「关闭」，所以按钮里不再有「×」这两个字，只剩一个图标。
  t('收起按钮不再写成「×」', hides.length === 3 && !hides.some((b) => textOf(b).includes('×')), hides.map((b) => textOf(b)))
  t('收起按钮的提示写的是「收起来」', hides.every((b) => String(b.props?.title ?? '').includes('收起来')), hides.map((b) => b.props?.title))

  // 收起来的那扇门：灰黑，放上去能装回来，并且列清里面有什么（分模块，装回来方便）
  const dead = renderRoot(base('doors', { 1: { ...STATE, hidden_doors: ['novel', 'tavern'] } }))
  const deadNodes = findNodes(dead, (n) => n.type === 'div' && n.props?.['data-door-dead'] !== undefined)
  const deadText = deadNodes.map((n) => textOf(n)).join(' ')
  t('收起来的门变灰黑，还看得见名字', deadNodes.length === 2 && deadText.includes('写小说'), deadText.slice(0, 120))
  t('收起来的门里列清了有哪些模块', deadText.includes('书架与章节') && deadText.includes('会话存档'), deadText.slice(0, 200))
  t('收起来的门上有装回来的按钮', deadText.includes('装回来'), deadText.slice(0, 200))
}

console.log('\n=== 14. 撤掉的卡：看得见、放得回来、也删得干净 ===')
{
  // 2026-10-29：删掉的卡不是没了，是从列表里撤下去，原文还在磁盘上。
  // 以前界面上根本没有这一栏，于是删错的人找不回来，想清干净的人也找不到路——
  // 卡在中间，只能去翻文件夹。这一组就盯三件事：入口看得见、放得回来、彻底删得掉。
  const GONE = [
    { path: 'people/gone.card.md', id: 'gone', name: '老周', withdrawn_at: '2026-10-20T10:00:00.000Z' },
    { path: 'people/old.card.md', id: 'old', name: '小满', withdrawn_at: '2026-10-21T10:00:00.000Z' },
  ]
  const KEEP = { id: 'lin', path: 'people/lin.card.md', name: '林小雨', kind: 'fictional', coverage: 40, tags: [], intro: '在城南的旧书店做事。' }
  const noGone = { ...LISTING, cards: [KEEP] }
  const withGone = { ...LISTING, cards: [KEEP], withdrawn: GONE }

  // ① 一条都没有的时候，这一整区不许出现（不是渲染成空壳子）
  const clean = renderRoot({ ...base('home'), 2: noGone })
  const cleanWords = textOf(clean)
  t('没有撤掉的卡时，这一区整个不出现', !cleanWords.includes('已经撤掉的'), cleanWords.slice(0, 200))
  t('没有撤掉的卡时，也没有「放回来」', !cleanWords.includes('放回来'), '')

  // ② 有撤掉的：标题带张数，并且说清「看不见但原文还在」——不然没人敢点
  const rootTree = renderRoot({ ...base('home'), 2: withGone })
  const rootWords = textOf(rootTree)
  t('有撤掉的卡时出现「已经撤掉的」并带数量', rootWords.includes('已经撤掉的') && rootWords.includes('2'), rootWords.slice(0, 240))
  t('旁边说清「看不见，但原文还在」', rootWords.includes('看不见，但原文还在'), rootWords.slice(0, 240))
  t('默认收着，不先摆出一排按钮', !rootWords.includes('放回来') && !rootWords.includes('彻底删掉'), rootWords.slice(0, 300))
  t('收着的时候右边写着「展开」', rootWords.includes('展开'), rootWords.slice(0, 300))

  // ③ 点「展开」：两条各一行，每行两个按钮。
  //    这里按 React 的重渲染来：store 留着，hookIndex 归零再跑一遍 HomeView。
  const homeProps = seenProps.get('HomeView')
  const HomeViewC = seenType.get('HomeView')
  let homeStore = null
  const paintHome = () => { hookIndex = 0; hookStore = homeStore ?? []; const out = HomeViewC(homeProps); homeStore = hookStore; return deepRender(out) }
  const collapsed = paintHome()
  const toggle = findNodes(collapsed, (n) => n.type === 'button' && n.props?.['data-withdrawn-toggle'] !== undefined)[0]
  t('折叠区有一个能点开的按钮', toggle !== undefined)
  hookStore = homeStore
  toggle.props.onClick()
  const opened = paintHome()
  const openedWords = textOf(opened)
  t('点展开之后写着「收起」', openedWords.includes('收起'), openedWords.slice(0, 240))
  const rows = findNodes(opened, (n) => n.props?.['data-withdrawn-row'] !== undefined)
  t('展开后一条一行', rows.length === 2, rows.length)
  t('每行都看得见名字', rows.every((r) => /老周|小满/.test(textOf(r))), rows.map((r) => textOf(r)))
  t('每行都有「放回来」', rows.every((r) => textOf(r).includes('放回来')), rows.map((r) => textOf(r)))
  t('每行都有「彻底删掉」', rows.every((r) => textOf(r).includes('彻底删掉')), rows.map((r) => textOf(r)))
  t('展开后说清两条路各是什么意思', openedWords.includes('回到上面的列表') && openedWords.includes('删了就真没了'), openedWords.slice(0, 400))
  t('首页把「放回来」「彻底删掉」两件事都传下去了',
    typeof homeProps.onRestoreCard === 'function' && typeof homeProps.onPurgeCard === 'function',
    typeof homeProps.onRestoreCard + '/' + typeof homeProps.onPurgeCard)

  // ④ 点「放回来」：真的发请求，带的是那一条自己的位置
  const restores = findNodes(opened, (n) => n.props?.['data-withdrawn-restore'] !== undefined)
  const purges = findNodes(opened, (n) => n.props?.['data-withdrawn-purge'] !== undefined)
  t('两个按钮各两条', restores.length === 2 && purges.length === 2, `${restores.length}/${purges.length}`)

  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push(`${String(url)} ${String(init?.body ?? '')}`)
    return { ok: true, status: 200, json: async () => ({ ok: true, exists: true, workspace: '/tmp/x', relations: [], cards: [], materials: [], worlds: [], proposals: [], errors: [], withdrawn: [] }) }
  }
  try {
    await restores[0].props.onClick()
    await new Promise((r) => setTimeout(r, 20))
  } finally {
    globalThis.fetch = realFetch
  }
  t('点「放回来」会请求把它放回去', calls.some((c) => c.includes('card.restore')), calls)
  t('请求带的是这一条的位置', calls.some((c) => c.includes('card.restore') && c.includes('people/gone.card.md')), calls)

  // ⑤ 点「彻底删掉」：先问一次，问的话要说清原文一起没；取消就什么都不发
  const asked = []
  const posts = []
  const realConfirm = fakeWindow.confirm
  const realFetch2 = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    posts.push(`${String(url)} ${String(init?.body ?? '')}`)
    return { ok: true, status: 200, json: async () => ({ ok: true, exists: true, workspace: '/tmp/x', relations: [], cards: [], materials: [], worlds: [], proposals: [], errors: [], withdrawn: [] }) }
  }
  try {
    fakeWindow.confirm = (msg) => { asked.push(String(msg)); return false }
    await purges[0].props.onClick()
    await new Promise((r) => setTimeout(r, 20))
    t('点彻底删掉先问一次', asked.length === 1, asked)
    t('问的时候说清磁盘上的原文一起删、删了就真没了', asked[0].includes('磁盘上的原文一起删') && asked[0].includes('删了就真没了'), asked[0])
    t('只是不想看见的人，被告知点「放回来」就行', asked[0].includes('放回来'), asked[0])
    t('取消之后一个请求都不发', posts.length === 0, posts)

    fakeWindow.confirm = (msg) => { asked.push(String(msg)); return true }
    await purges[0].props.onClick()
    await new Promise((r) => setTimeout(r, 20))
  } finally {
    fakeWindow.confirm = realConfirm
    globalThis.fetch = realFetch2
  }
  t('确认之后才真的发彻底删掉', posts.some((c) => c.includes('card.purge')), posts)
  t('彻底删掉带的是这一条的位置', posts.some((c) => c.includes('card.purge') && c.includes('people/gone.card.md')), posts)

  // ⑥ 删卡的提示要提到能反悔，不然用户以为删完就没了
  const delCalls = []
  const realFetch3 = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    delCalls.push(`${String(url)} ${String(init?.body ?? '')}`)
    return { ok: true, status: 200, json: async () => ({ ok: true, exists: true, workspace: '/tmp/x', relations: [], cards: [], materials: [], worlds: [], proposals: [], errors: [], withdrawn: [] }) }
  }
  let delTree
  try {
    delTree = renderRoot(fakeWindow.confirm === realConfirm ? { ...base('home'), 2: withGone } : { ...base('home'), 2: withGone })
    const delBtn = findNodes(delTree, (n) => n.props?.['data-card-action'] === 'delete')[0]
    t('卡片上找得到删除按钮', delBtn !== undefined)
    await delBtn.props.onClick({ stopPropagation() {} })
    await new Promise((r) => setTimeout(r, 20))
  } finally {
    globalThis.fetch = realFetch3
  }
  const toast = hookStore[5]
  const toastWords = typeof toast === 'string' ? toast : String(toast?.message ?? toast?.text ?? '')
  t('删卡的提示提到可以反悔', toastWords.includes('反悔') && toastWords.includes('放回来'), toastWords)

  // ⑦ 文案扫一遍：不许露路径、不许露接口名、不许说「撤回」
  const visible = textOf(opened) + ' ' + findNodes(opened, (n) => typeof n.props?.title === 'string').map((n) => n.props.title).join(' ')
  t('渲染出来的字里没有文件后缀', !visible.includes('.card.md') && !visible.includes('.md'), visible.slice(0, 300))
  t('渲染出来的字里没有接口名', !visible.includes('withdrawn') && !visible.includes('card.'), visible.slice(0, 300))
  t('渲染出来的字里没有路径', !visible.includes('people/') && !visible.includes('/tmp/'), visible.slice(0, 300))
  t('渲染出来的字里没有「撤回」', !visible.includes('撤回'), visible.slice(0, 300))

  // ⑧ 卡全撤光：不能只给「还没有档案」——那正是这次要解的死结
  const allGone = renderRoot({ ...base('home'), 2: { ...LISTING, cards: [], withdrawn: GONE } })
  const allWords = textOf(allGone)
  t('卡全撤光时首页还给一个入口', allWords.includes('已经撤掉的') && !allWords.includes('还没有档案'), allWords.slice(0, 240))
}

console.log('\n=== 15. 「聊一聊」是开一个新会话，插件里不再自己演一遍 ===')
await (async () => {
  const CARD = {
    ok: true, path: 'people/lin.card.md',
    data: { lifecard: '0.1', id: 'lin', kind: 'fictional', world: 'reality', name: '林小雨' },
    sections: [{ title: '自述', body: '她在便利店上夜班。' }],
    validation: { ok: true, issues: [] },
    coverage: { percent: 40, filled: 3, empty: [{ label: '口癖' }], rows: [], sourceLevels: [], unmarkedRatio: 0 },
  }

  // ① 卡片页上补信息：新会话要认得「补哪一张」，不然先得问一遍我是谁。
  const beforeCard = SESSIONS.length
  const cardTree = renderRoot({ ...base('card'), 6: CARD })
  const cardClicked = clickButtonWith(cardTree, '聊一聊')
  await new Promise((r) => setTimeout(r, 30))
  const cardSession = SESSIONS[beforeCard] ?? {}
  t('卡片页上「聊一聊」点得动', cardClicked === true)
  t('卡片页点完不切到访谈页', hookStore[0] !== 'interview', String(hookStore[0]))
  t('卡片页点完开了一个新会话', SESSIONS.length === beforeCard + 1, JSON.stringify(SESSIONS.slice(-2)))
  t('新会话里带上了这张卡的名字', String(cardSession.prompt ?? '').includes('林小雨'), JSON.stringify(cardSession))
  t('新会话里带着访谈那个 skill', String(cardSession.prompt ?? '').includes('/lifecard-interview'), JSON.stringify(cardSession))
  t('卡片页那个按钮说的是「新开一个对话」', textOf(cardTree).includes('聊一聊（新开一个对话）'), textOf(cardTree).slice(0, 300))

  // ② 界面上得有一句灰字说清「在别处问」，不然点完不知道人跑哪去了。
  const homeTree = renderRoot({ ...base('home') })
  t('首页说清会在新对话里问', textOf(homeTree).includes('会在新对话里问'), textOf(homeTree).slice(0, 300))

  // ③ 老版本宿主没有「开新会话」这个能力：不能点了没反应。
  //    HOST 是模块级的、apply 时定死，所以要另起一个模块实例。
  const restoreWarn = console.warn
  console.warn = () => {}
  const api2 = factory(fakeRequire, { exports: {} }, {}, fakeWindow, document)
  api2.apply(NO_UI)
  console.warn = restoreWarn
  const Root2 = api2.LifeCardTab
  const renderRoot2 = (presets = {}) => {
    hookIndex = 0
    hookStore = []
    for (const [k, v] of Object.entries(presets)) hookStore[Number(k)] = v
    return deepRender(Root2({ visible: true }))
  }
  const beforeOld = SESSIONS.length
  const oldTree = renderRoot2({ ...base('home') })
  const oldClicked = clickButtonWith(oldTree, '聊一聊')
  // 先让后台那条路走完（异步），再看是不是把话交回给用户了。
  await new Promise((r) => setTimeout(r, 30))
  t('老版本宿主上也点得动（不是点了没反应）', oldClicked === true)
  t('老版本宿主上不会假装开了会话', SESSIONS.length === beforeOld, JSON.stringify(SESSIONS.slice(-2)))
  // 点了之后要把「该复制什么」摆出来：状态存在某个槽里，重新画一遍看结果
  const handoffAt = hookStore.findIndex((v) => v !== null && typeof v === 'object' && typeof v.prompt === 'string')
  t('老版本宿主上记下了该复制的那句话', handoffAt >= 0, JSON.stringify(hookStore.map((v) => typeof v)))
  const oldAfter = renderRoot2({ ...base('home'), ...(handoffAt >= 0 ? { [handoffAt]: hookStore[handoffAt] } : {}) })
  const oldWords = textOf(oldAfter)
  t('老版本宿主上说清要自己复制到新对话里', oldWords.includes('复制到新对话里'), oldWords.slice(0, 400))
  const handoffBox = findNodes(oldAfter, (n) => n.type === 'textarea' && typeof n.props?.value === 'string')[0]
  const handoffText = String(handoffBox?.props?.value ?? '')
  t('老版本宿主上把那句话原样摆出来了',
    handoffText.includes('/lifecard-interview') && handoffText.includes('帮我建一张新的人物卡'),
    handoffText.slice(0, 300))
  t('摆在框里的是只读的一句话，不会被人改坏',
    handoffBox !== undefined && handoffBox.props.readOnly === true, JSON.stringify(handoffBox?.props ?? null).slice(0, 200))
  t('旁边有「复制」，不用自己去拖选',
    findNodes(oldAfter, (n) => n.type === 'button' && textOf(n) === '复制').length === 1, oldWords.slice(0, 200))
  t('老版本宿主上不切到访谈页', hookStore[0] !== 'interview', String(hookStore[0]))

  // ④ 这些是给外壳看的名词，不该落到用户眼睛里。
  for (const [label, presets] of [['首页', { ...base('home') }], ['卡片页', { ...base('card'), 6: CARD }]]) {
    const tree = renderRoot(presets)
    const all = textOf(tree) + ' ' + findNodes(tree, (n) => typeof n.props?.title === 'string').map((n) => n.props.title).join(' ')
    t(`${label}的字里没有 startSession`, !all.includes('startSession'), all.slice(0, 300))
    t(`${label}的字里没有 uiWorkspace`, !all.includes('uiWorkspace'), all.slice(0, 300))
    t(`${label}的字里没有 agentPreset`, !all.includes('agentPreset'), all.slice(0, 300))
    t(`${label}的字里没有那三个预设名`, !/lc-(real|tavern|novel)/.test(all), all.slice(0, 300))
  }
})()


console.log('\n=== 16. 读不到、删不掉：这些地方以前一声不响 ===')

/** 直接渲染一个此前被整棵树访问过的子组件，槽由 presets 指定（从 0 数）。 */
function renderChild(name, props, presets = {}) {
  const C = seenType.get(name)
  if (C === undefined) return { dom: null, store: null }
  hookIndex = 0
  hookStore = []
  for (const [k, v] of Object.entries(presets)) hookStore[Number(k)] = v
  rootEffects = []
  rootRendering = true
  let out = null
  try { out = C(props ?? {}) } finally { rootRendering = false }
  const store = hookStore
  const dom = deepRender(out)
  // 故意不还原 hookStore：被点的按钮常是异步的，它的 setState 要把结果写回
  // 这一个槽里，还原了就等于把结果丢进另一个数组。
  return { dom, store }
}

/** 临时换掉 fetch，把每次请求记下来。answer(url, body) 决定返回什么。 */
function withFetch(answer) {
  const realFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, body) => {
    calls.push({ url: String(url), body: String(body?.body ?? '') })
    return { ok: true, json: async () => answer(String(url), String(body?.body ?? '')) }
  }
  calls.restore = () => { globalThis.fetch = realFetch }
  return calls
}

/** 临时换掉「问一句」，把问的话记下来。 */
function withConfirm(answer) {
  const real = fakeWindow.confirm
  const asked = []
  fakeWindow.confirm = (text) => { asked.push(String(text)); return answer }
  asked.restore = () => { fakeWindow.confirm = real }
  return asked
}

const tick = () => new Promise((r) => setTimeout(r, 60))

{
  // ── 简历读不出来时「再试一次」要真的重查 ──
  // 以前那个按钮只写了 `call('career.get', {})`，返回值被丢掉：点完界面还是
  // 空着转圈，用户只能一直点，以为是自己手慢。
  renderRoot(base('career'))   // 先让它被见过一次，下面才拿得到这个组件
  const calls = withFetch(() => ({ ok: true, profileSections: { 基本情况: '阿吉，二十八' }, plan: { goal: '换个能准点下班的工作', horizon: '1年' } }))
  const { dom, store } = renderChild('CareerView', { onBack() {}, flash() {} }, { 0: null, 6: '你的简历这一份读不出来' })
  t('读不出来的时候摆得出「再试一次」', findNodes(dom, (n) => n.type === 'button' && textOf(n).includes('再试一次')).length === 1, textOf(dom).slice(0, 160))
  const before = calls.length
  const clicked = clickButtonWith(dom, '再试一次')
  await tick()
  const again = calls.slice(before).filter((c) => c.url.includes('career.get'))
  t('点「再试一次」真的又去查了一遍', clicked === true && again.length === 1, JSON.stringify(calls.slice(-3)))
  t('查回来的东西被摆到界面上了', store[0] !== null && store[0] !== undefined && String(JSON.stringify(store[0])).includes('阿吉'), JSON.stringify(store[0]).slice(0, 200))
  t('查回来之后就不该还挂着那句错', store[6] === null || store[6] === undefined, String(store[6]))
  calls.restore()
}

{
  // ── 说过的场次读不出来：以前是安静消失 ──
  const calls = withFetch((url) => (url.includes('tavern.list') ? { ok: true, items: [], bad: 2 } : { ok: true }))
  renderRoot(base('tavern'))
  await runRootEffects()
  const saved = hookStore.slice()
  const idx = saved.findIndex((v) => typeof v === 'string' && v.includes('2 场读不出来'))
  t('场次读不出来时，插件自己知道要说', idx !== -1, JSON.stringify(saved.filter((v) => typeof v === 'string')).slice(0, 300))

  const shown = idx === -1 ? null : renderRoot(base('tavern', { [idx]: saved[idx] }))
  const words = shown === null ? '' : textOf(shown)
  t('酒馆里把「有 2 场读不出来」说出来了', words.includes('2 场读不出来'), words.slice(0, 300))
  t('并且说清别的场次不受影响', words.includes('别的场次不受影响'), words.slice(0, 300))
  calls.restore()
}

{
  // 列表整个读不出来（目录不对、没权限）也要说，而不是显示「还没说过话」。
  const calls = withFetch((url) => (url.includes('tavern.list')
    ? { ok: false, error: '会话列表读不出来。检查一下文件夹权限。' }
    : { ok: true }))
  renderRoot(base('tavern'))
  await runRootEffects()
  const said = hookStore.find((v) => typeof v === 'string' && v.includes('会话列表读不出来'))
  t('整张列表读不出来时也说一句', said !== undefined, JSON.stringify(hookStore.filter((v) => typeof v === 'string')).slice(0, 300))
  calls.restore()
}

{
  // 读得出来的时候不该多嘴。
  const calls = withFetch((url) => (url.includes('tavern.list') ? { ok: true, items: [{ id: 'c1', title: '雨夜' }], bad: 0 } : { ok: true }))
  renderRoot(base('tavern'))
  await runRootEffects()
  const noisy = hookStore.filter((v) => typeof v === 'string' && (v.includes('读不出来') || v.includes('没读出来')))
  t('一切都读得出来的时候不多嘴', noisy.length === 0, JSON.stringify(noisy))
  calls.restore()
}

{
  // ── 书架上的书能真的拿掉 ──
  const calls = withFetch((url) => (url.includes('novel.books') ? { ok: true, books: [] } : { ok: true }))
  const asked = withConfirm(true)
  // 书架在「已经有档案」那一屏里，所以得先有一张卡（空库那一屏只给三条路）。
  const shelf = { ...LISTING, cards: [{ id: 'mama', name: '妈妈', kind: 'fictional', coverage: 0.4 }] }
  const tree = renderRoot(base('novel', { 2: shelf, 26: [{ id: 'b1', title: '长夜' }] }))
  const hasBtn = findNodes(tree, (n) => n.type === 'button' && textOf(n).includes('不要这本了')).length === 1
  t('书架上每本书都有「不要这本了」', hasBtn === true, textOf(tree).slice(0, 300))
  const clicked = clickButtonWith(tree, '不要这本了')
  await tick()
  const del = calls.filter((c) => c.url.includes('novel.delete'))
  t('点「不要这本了」先问一句', clicked === true && asked.length === 1, JSON.stringify(asked))
  t('问的时候说清「章也一起删」', String(asked[0] ?? '').includes('章也一起删'), String(asked[0] ?? ''))
  t('确认之后真的发了删书的请求', del.length === 1 && JSON.parse(del[0].body).id === 'b1', JSON.stringify(calls.slice(-3)))
  asked.restore()

  // 反悔（点取消）就什么都不该发。
  const asked2 = withConfirm(false)
  const tree2 = renderRoot(base('novel', { 2: shelf, 26: [{ id: 'b1', title: '长夜' }] }))
  const before2 = calls.filter((c) => c.url.includes('novel.delete')).length
  clickButtonWith(tree2, '不要这本了')
  await tick()
  t('点取消之后一本书都没删', calls.filter((c) => c.url.includes('novel.delete')).length === before2, JSON.stringify(calls.slice(-3)))
  asked2.restore()
  calls.restore()
}

{
  // ── 章节能删 ──
  renderRoot(base('book', { 25: { id: 'b1', title: '长夜' } }))
  const calls = withFetch((url) => (url.includes('novel.chapter.delete')
    ? { ok: true, index: 2 }
    : { ok: true, book: { id: 'b1', data: { title: '长夜' }, idea: '', chapters: [] }, outline: { ok: true, chapters: [], theme: '', ending: '' } }))
  const asked = withConfirm(true)
  const { dom } = renderChild('BookView', { bookId: 'b1', onBack() {}, flash() {} }, {
    0: { id: 'b1', data: { title: '长夜' }, idea: '', chapters: [{ index: 1, title: '开头' }, { index: 2, title: '转折' }] },
    1: { ok: true, chapters: [], theme: '', ending: '' },
    2: 1,
    3: '',
  })
  const btn = findNodes(dom, (n) => n.type === 'button' && textOf(n).includes('删掉这一章'))
  t('章节列表里每章都有「删掉这一章」', btn.length === 2, textOf(dom).slice(0, 300))
  const clicked = clickButtonWith(dom, '删掉这一章')
  await tick()
  const del = calls.filter((c) => c.url.includes('novel.chapter.delete'))
  t('点「删掉这一章」先问一句', clicked === true && asked.length === 1, JSON.stringify(asked))
  t('问的时候说清「正文一起删」', /正文一起删/.test(String(asked[0] ?? '')), String(asked[0] ?? ''))
  t('确认之后发出了删这一章的请求',
    del.length === 1 && JSON.parse(del[0].body).id === 'b1' && JSON.parse(del[0].body).index === 1,
    JSON.stringify(del.map((c) => JSON.parse(c.body))))
  asked.restore()
  calls.restore()
}

{
  // ── 存档能删 ──
  renderRoot(base('game', { 25: { id: 'b1', title: '长夜' } }))
  const calls = withFetch((url) => (url.includes('game.delete')
    ? { ok: true }
    : (url.includes('game.list') ? { ok: true, items: [] } : { ok: true })))
  const asked = withConfirm(true)
  const { dom } = renderChild('GameView', { bookId: 'b1', onBack() {}, flash() {} }, {
    10: [{ id: 'p1', scene: '雨夜', turns: 4 }, { id: 'p2', scene: '码头', turns: 9 }],
  })
  const btn = findNodes(dom, (n) => n.type === 'button' && textOf(n).includes('删掉这一局'))
  t('存档列表里每局都有「删掉这一局」', btn.length === 2, textOf(dom).slice(0, 300))
  const clicked = clickButtonWith(dom, '删掉这一局')
  await tick()
  const del = calls.filter((c) => c.url.includes('game.delete'))
  t('点「删掉这一局」先问一句', clicked === true && asked.length === 1, JSON.stringify(asked))
  t('问的时候说清「删了就接不回来」', /接不回来/.test(String(asked[0] ?? '')), String(asked[0] ?? ''))
  t('确认之后发出了删这一局的请求',
    del.length === 1 && JSON.parse(del[0].body).book === 'b1' && JSON.parse(del[0].body).id === 'p1',
    JSON.stringify(del.map((c) => JSON.parse(c.body))))
  asked.restore()
  calls.restore()
}


console.log('\n=== 17. 空清单不许被翻成全读；收不走的空卡要说出来 ===')

const startBtnIn = (tree) => findNodes(tree, (n) => n.type === 'button' && textOf(n).includes('开始读'))[0]
// 分析页得有两份材料可选，否则它先走「还没有材料可以读」那一屏。
const WITH_MATS = { ...LISTING, materials: [{ path: 'materials/a.md', name: 'a' }, { path: 'materials/b.md', name: 'b' }] }

{
  // 一场访谈一句材料都没记下（虚构角色常见：聊完才发现没存成文件）。
  // 这条清单交给分析页时必须还是「一份不读」，不能被折成「没指定 = 全读」——
  // 折过去的后果是按一下「开始读」，别人的材料一起被读进这张卡。
  renderRoot(base('interview'))
  const props = seenProps.get('InterviewView')
  t('访谈页被渲染过（下面靠它拿 onAnalyze）', props !== undefined, JSON.stringify([...seenProps.keys()].slice(0, 12)))
  props?.onAnalyze?.({ id: 'lin', name: '林小雨', materials: [] })
  t('空清单带过去的是空数组，不是「没指定」',
    Array.isArray(hookStore[14]) && hookStore[14].length === 0, JSON.stringify(hookStore[14]))
  t('并且真的切到了分析页', hookStore[0] === 'analyze', String(hookStore[0]))
}

{
  // 到了分析页：按钮是灰的，一按就把别人的材料读进来了这条路必须堵死。
  const calls = withFetch(() => ({ ok: true, proposal: null, cards: [] }))
  // 也给上「这是关于谁」，否则按钮本来就是灰的，测不出材料那一路。
  const tree = renderRoot(base('analyze', { 2: WITH_MATS, 9: { name: '林小雨' }, 14: [] }))
  const words = textOf(tree)
  t('空清单进分析页时说清一份都没选', words.includes('现在一份都没选'), words.slice(0, 300))
  t('并说清要自己挑材料', words.includes('至少选一份'), words.slice(0, 300))
  const btn = startBtnIn(tree)
  t('空清单时「开始读」是灰的', btn?.props?.disabled === true, JSON.stringify(btn?.props?.disabled ?? null))
  t('灰着的时候一个读材料的请求都没发出去',
    calls.filter((c) => c.url.includes('analyze.run')).length === 0, JSON.stringify(calls.map((c) => c.url)))
  calls.restore()
}

{
  // 反面：没说读哪些（null）就是全读，这条以前能用，不能被我改坏。
  const tree = renderRoot(base('analyze', { 2: WITH_MATS, 9: { name: '林小雨' }, 14: null }))
  const words = textOf(tree)
  t('没指定材料时仍然是「不选 = 全读」', words.includes('不选 = 全读'), words.slice(0, 300))
  t('没指定材料时「开始读」点得动', startBtnIn(tree)?.props?.disabled !== true, JSON.stringify(startBtnIn(tree)?.props?.disabled ?? null))
}

{
  // 开局失败要收掉刚建的那张空卡。收掉了就说收掉了。
  renderRoot(base('interview'))
  const calls = withFetch((url) => {
    if (url.includes('interview.plan')) return { ok: false, error: 'AI 那边没响应' }
    if (url.includes('card.discard')) return { ok: true }
    if (url.includes('card.save')) return { ok: true, path: 'cards/lin.card.md' }
    return { ok: true }
  })
  const props = { state: { ok: true, relations: [] }, listing: { ok: true, cards: [] }, preset: { name: '林小雨' }, mode: 'novel', onDone() {}, onAnalyze() {}, flash() {} }
  const { dom, store } = renderChild('InterviewView', props, { 0: 'pick', 1: '林小雨', 12: false, 13: null })
  const clicked = clickButtonWith(dom, '开始聊')
  await tick()
  t('开局失败时会去收那张刚建的空卡',
    clicked === true && calls.filter((c) => c.url.includes('card.discard')).length === 1,
    JSON.stringify(calls.map((c) => c.url)))
  const said = String(store[13] ?? '')
  t('收走了就照实说收走了', said.includes('已经撤掉了'), said)
  t('收走了不再吓唬人去列表里找', !said.includes('没能收走'), said)
  t('收走了就不该挂那个去处', store[18] === null || store[18] === undefined, JSON.stringify(store[18]))
  calls.restore()
}

{
  // 收不掉（比如超过十分钟窗口）：界面必须说出来，并给一条能走的路，
  // 否则列表里留一张同名空卡，下次同名建卡撞「已经有一张叫…」，用户一头雾水。
  const calls = withFetch((url) => {
    if (url.includes('interview.plan')) return { ok: false, error: 'AI 那边没响应' }
    if (url.includes('card.discard')) return { ok: false, error: '超过十分钟了' }
    if (url.includes('card.save')) return { ok: true, path: 'cards/lin.card.md' }
    return { ok: true }
  })
  const props = { state: { ok: true, relations: [] }, listing: { ok: true, cards: [] }, preset: { name: '林小雨' }, mode: 'novel', onDone() {}, onAnalyze() {}, flash() {} }
  const { dom, store } = renderChild('InterviewView', props, { 0: 'pick', 1: '林小雨', 12: false, 13: null })
  clickButtonWith(dom, '开始聊')
  await tick()
  const said = String(store[13] ?? '')
  t('收不走的时候把这件事说出来', said.includes('没能收走'), said)
  t('并说清下一步做什么', said.includes('去列表里把它删掉'), said)
  t('不再谎称已经撤掉了', !said.includes('已经撤掉了'), said)
  const again = renderChild('InterviewView', props, { 0: 'pick', 1: '林小雨', 12: false, 13: store[13], 18: store[18] })
  const away = findNodes(again.dom, (n) => n.type === 'button' && textOf(n).includes('去列表里删掉它'))
  t('旁边给一个能点过去的去处', away.length === 1, textOf(again.dom).slice(0, 400))
  t('那句话说清是哪一张卡', textOf(again.dom).includes('「林小雨」那张空卡还在列表里'), textOf(again.dom).slice(0, 400))
  calls.restore()
}

console.log(`\n${pass} passed, ${fail} failed`)

process.exit(fail === 0 ? 0 : 1)
