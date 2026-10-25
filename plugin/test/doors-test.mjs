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
  useEffect: () => { hookIndex++ },
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

const module = { exports: {} }
const openAt = source.indexOf('factory: (require) => {')
const closeAt = source.lastIndexOf('\n});')
let body = source.slice(openAt + 'factory: (require) => {'.length, closeAt)
body = body.replace(/\}\s*$/, '')
const factory = new Function('require', 'module', 'exports', 'window', 'document', body + '\n')
const api = factory(fakeRequire, module, module.exports, fakeWindow, document)

const registered = []
api.apply({
  get: (name) => (name === 'betterSidebar' ? { registerTab: (d) => { registered.push(d); return () => {} } } : undefined),
  effect: (fn) => { fn(); return () => {} },
})
const Root = api.LifeCardTab

// ── 一路展开，把「函数型节点」都渲染掉，留下纯 DOM 树 ──────────
// 顺便记下每一个组件被调用时收到的 props：门的名字就是这么传下去的。
const seenProps = new Map()
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
  const tree = Root({ visible: true })
  return deepRender(tree)
}

// 根组件的槽：0 view / 1 state / 2 listing / 3 busy / 4 error / 5 toast /
// 6 activeCard / 7 proposal / 8 doctor / 9 interviewFor / 10 showMore /
// 11 activeWorld / 12 pendingAbout / 13 introSeen / 14 materialFor / 15 ref /
// 16 chat / 17 chats / 23 door（实测见文件顶注释）
const base = (view, extra = {}) => ({ 0: view, 1: STATE, 2: LISTING, 3: '', 4: null, 5: null, 6: null, 7: null, 8: null, 9: null, 10: false, 11: null, 12: '', 13: true, 14: null, ...extra })

console.log('\n=== 1. 点哪扇门，「聊着建」就说哪扇门的话 ===')
for (const [doorLabel, doorId, expectWord, forbidWord] of [
  ['真实人物记录', 'real', '现实里的人', null],
  ['写小说', 'novel', '小说角色', '现实里的人'],
  ['酒馆', 'tavern', '可以演的虚构角色', '现实里的人'],
]) {
  // ① 进门口那一屏，点门的名字
  const doors = renderRoot(base('doors'))
  const picked = clickButtonWith(doors, doorLabel)
  if (!picked) { t(`找得到「${doorLabel}」这扇门`, false, textOf(doors).slice(0, 200)); continue }
  const viewAfterDoor = hookStore[0]
  t(`点「${doorLabel}」进到那一屏`, viewAfterDoor === (doorId === 'real' ? 'home' : doorId), String(viewAfterDoor))

  // ② 在那一扇门的首页点「聊着建」（酒馆那扇门是「立一个人」，写小说也是）
  const home = renderRoot({ ...base(viewAfterDoor), 23: doorId })
  const wanted = doorId === 'real' ? '陪我聊聊' : (doorId === 'tavern' ? '聊着立一个能演的角色' : '聊着立一个小说角色')
  const clicked = clickButtonWith(home, wanted)
  const viewAfterClick = hookStore[0]
  t(`「${doorLabel}」里点得动聊着建`, clicked === true)
  t(`点完进到聊着建那一屏（${doorLabel}）`, viewAfterClick === 'interview', String(viewAfterClick))

  // ③ 关键：这一屏说的话，是不是这一扇门的
  const interview = renderRoot({ ...base('interview'), 23: doorId })
  const words = textOf(interview)
  t(`「${doorLabel}」的聊着建说的是「${expectWord}」`, words.includes(expectWord), words.slice(0, 300))
  if (forbidWord !== null) {
    t(`「${doorLabel}」的聊着建不再说「${forbidWord}」`, !words.includes(forbidWord), words.slice(0, 300))
  }
}

console.log('\n=== 2. 门记住之后，进别的子页面也不丢 ===')
{
  // 从酒馆门进「聊着建」，再进卡片页、分析页——门还是酒馆
  for (const view of ['interview', 'card', 'analyze', 'import', 'newCard']) {
    const tree = renderRoot({ ...base(view), 23: 'tavern' })
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
    t('列表里每张卡都有删除按钮', trash.length === 2, trash.map((b) => b.props.title))
    t('删除按钮带名字，不会删错人', trash.some((b) => b.props.title.includes('林小雨')) && trash.some((b) => b.props.title.includes('妈妈')), trash.map((b) => b.props.title))

    // 点一下：先问一句，问的话要说清后果
    const asked = []
    const realConfirm = fakeWindow.confirm
    fakeWindow.confirm = (msg) => { asked.push(String(msg)); return true }
    const lin = trash.find((b) => b.props.title.includes('林小雨'))
    lin.props.onClick({ stopPropagation() {} })
    await new Promise((r) => setTimeout(r, 40))
    t('删之前先问一句', asked.length === 1, asked)
    t('问的时候说清卡里的东西一起没', asked[0].includes('一起删掉'), asked[0])
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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
