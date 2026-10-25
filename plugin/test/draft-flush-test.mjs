// 编辑卡片的草稿：离开这一页时，最后那几个字不能丢。
//
// 用户被教会的规则是「它会自动存」。以前这条规则是假的：改动停下 1.5 秒才发
// 一次保存，而组件卸载（点「先不改」、切到别的卡、跳去别的页、关侧栏）只会
// clearTimeout——最后那几个字还压在定时器里，就跟着组件一起没了。
//
// 这个测试需要一个真的会跑 effect、会跑清理函数的迷你运行时（render-all.mjs
// 里的假 React 不跑 effect，所以那边验不了这件事）。做法：
//   1. 用假的 fetch 记下每一次请求；
//   2. 渲染整棵树，把 CardForm 这个组件函数抓出来（靠组件名登记）；
//   3. 改一句正文，再重渲染一次 CardForm（让「立刻存一次」的动作指向最新的字）；
//   4. 模拟卸载：把清理函数全跑一遍；
//   5. 断言那次卸载补发了一次保存，且存进去的是最新那句。
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const t = (n, c, x) => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, x === undefined ? '' : String(x).slice(0, 500)) } }

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ── 迷你 hooks 运行时（按组件名保存状态，支持 effect 与清理）──────────
const stores = new Map()          // 组件名 → { slots: [], }
let current = null                // 正在渲染的组件状态
let slotIndex = 0
let pending = []                  // 本轮渲染里新挂上的 effect

function storeFor(fn) {
  const name = fn.name || '(匿名)'
  if (!stores.has(name)) stores.set(name, { name, slots: [] })
  return stores.get(name)
}

const sameDeps = (a, b) => {
  if (a === undefined || b === undefined) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

const fakeReact = {
  createElement: (type, props, ...children) => {
    const flat = children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false)
    const merged = { ...(props ?? {}) }
    if (flat.length > 0) merged.children = flat.length === 1 ? flat[0] : flat
    return { type, props: merged, children: flat }
  },
  useState: (init) => {
    const i = slotIndex++
    const st = current.slots
    if (st[i] === undefined) st[i] = typeof init === 'function' ? init() : init
    return [st[i], (v) => { st[i] = typeof v === 'function' ? v(st[i]) : v }]
  },
  useRef: (init) => {
    const i = slotIndex++
    const st = current.slots
    if (st[i] === undefined) st[i] = { current: init }
    return st[i]
  },
  useEffect: (fn, deps) => {
    const i = slotIndex++
    const st = current.slots
    const prev = st[i]
    // 只在依赖变了（或第一次）时重挂；和 React 一样，否则清理函数每渲染一次就跑。
    const isEffect = prev !== null && prev !== undefined && typeof prev === 'object' && prev.type === 'effect'
    if (isEffect && sameDeps(prev.deps, deps)) return
    if (isEffect && typeof prev.cleanup === 'function') prev.cleanup()
    const slot = { type: 'effect', deps, cleanup: null, fn }
    st[i] = slot
    pending.push({ store: current, slot })
  },
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
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
globalThis.FileReader = class {}
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')
globalThis.Blob = class { constructor() {} }
globalThis.URL.createObjectURL = () => 'blob:x'
globalThis.URL.revokeObjectURL = () => {}

// 记下每一次请求：只关心「存草稿」这一条，别的照常回 OK。
const calls = []
globalThis.fetch = async (url, opts = {}) => {
  const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
  calls.push({ url: String(url), body })
  return { ok: true, status: 200, json: async () => ({ ok: true, exists: true, workspace: '/tmp/x', draft: null }) }
}

// ── 执行 bundle ───────────────────────────────────────────────────
const module = { exports: {} }
const openAt = source.indexOf('factory: (require) => {')
const closeAt = source.lastIndexOf('\n});')
let body = source.slice(openAt + 'factory: (require) => {'.length, closeAt)
body = body.replace(/\}\s*$/, '')
const factory = new Function('require', 'module', 'exports', 'window', 'document', body + '\n')
const fakeRequire = (name) => {
  if (name === 'react') return fakeReact
  if (name === 'react/jsx-runtime') return { jsx: fakeReact.createElement, jsxs: fakeReact.createElement, Fragment: 'Fragment' }
  throw new Error('unexpected require: ' + name)
}
const api = factory(fakeRequire, module, module.exports, fakeWindow, document)

const seen = new Map()

// 只跑 CardForm 自己的 effect：别的组件的 effect 在真实环境里由外壳负责，
// 这里跑它们只会制造噪音（而且它们假设了好几个外壳才有的东西）。
const EFFECTED = new Set(['CardForm'])

function runPending() {
  const list = pending
  pending = []
  for (const { store, slot } of list) {
    if (!EFFECTED.has(store.name)) continue
    try {
      const out = slot.fn()
      if (typeof out === 'function') slot.cleanup = out
    } catch (e) {
      // effect 里的失败不影响界面，真实环境里也是 console 一下就过去了
    }
  }
}

/** 渲染任意组件；状态按组件名保存，所以同一组件再渲染时接着上次的状态。 */
function renderComponent(fn, props) {
  const store = storeFor(fn)
  const savedCurrent = current
  const savedIndex = slotIndex
  current = store
  slotIndex = 0
  const out = fn(props ?? {})
  current = savedCurrent
  slotIndex = savedIndex
  runPending()
  return out
}

/** 把树一路展开（碰到函数组件就渲染它），顺便把组件名登记进 seen。 */
function deepRender(node, depth = 0) {
  if (node === null || node === undefined || depth > 45) return node
  if (Array.isArray(node)) return node.map((n) => deepRender(n, depth + 1))
  if (typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    const name = node.type.name || ''
    if (name !== '') seen.set(name, node.type)
    try {
      return deepRender(renderComponent(node.type, node.props), depth + 1)
    } catch (e) {
      return null
    }
  }
  if (Array.isArray(node.children)) node.children = node.children.map((n) => deepRender(n, depth + 1))
  return node
}

function collect(node, pred, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const n of node) collect(n, pred, out); return out }
  if (typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  collect(node.children, pred, out)
  return out
}

const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

/** 卸载一个组件：把它的清理函数从后往前跑一遍。 */
function unmount(fn) {
  const store = stores.get(fn.name)
  if (store === undefined) return
  for (let i = store.slots.length - 1; i >= 0; i--) {
    const slot = store.slots[i]
    if (slot !== null && slot !== undefined && typeof slot === 'object' && slot.type === 'effect' && typeof slot.cleanup === 'function') {
      try { slot.cleanup() } catch (e) { /* 和 React 一样：清理里出错不该拖垮别的 */ }
    }
  }
  stores.delete(fn.name)
}

// ── 捏一份够用的卡 ────────────────────────────────────────────────
const CARD = {
  ok: true,
  path: 'cards/mama.card.md',
  data: {
    lifecard: '0.1', id: 'mama', kind: 'real', world: 'reality', name: '妈妈',
    relation: '母亲', status: 'active', tags: [], consent: { basis: 'family-agreed', recorded_at: '2026-10-01' },
  },
  sections: [
    { title: '自述', body: '她一辈子在厨房和工厂之间来回。' },
    { title: '性格', body: '嘴上凶，事后会默默把饭端出来。' },
  ],
  validation: { ok: true, issues: [] },
  coverage: { percent: 62, filled: 2, empty: [], rows: [], sourceLevels: [], unmarkedRatio: 0 },
}
const STATE = { ok: true, workspace: '/tmp/x', exists: true, hasLlm: true, relations: [], summary: {} }
const LISTING = { ok: true, workspace: '/tmp/x', cards: [], materials: [], worlds: [], systems: [], errors: [], proposals: [], avatars: {} }

const Root = api.LifeCardTab
// LifeCardTab 的 hook 槽：0 view / 1 state / 2 listing / 3 busy / 4 error / 5 toast /
// 6 activeCard / 7 proposal / 8 doctor / 9 interviewFor / 10 showMore
const ROOT_PRESETS = { 0: 'card', 1: STATE, 2: LISTING, 6: CARD }
function applyRootPresets() {
  const store = storeFor(Root)
  for (const [k, v] of Object.entries(ROOT_PRESETS)) store.slots[Number(k)] = v
}

// 第一遍：还没见过 CardView，先把它认出来（这一遍它是只读态，不会出 CardForm）
applyRootPresets()
deepRender(renderComponent(Root, { visible: true }))
const cardViewFn = seen.get('CardView')
t('找得到卡片详情这个组件', cardViewFn !== undefined)

// 第二遍：hook 槽 0 = editing，推成「正在改这张卡」，CardForm 才会出现
stores.clear()
applyRootPresets()
if (cardViewFn !== undefined) storeFor(cardViewFn).slots[0] = true
seen.clear()
deepRender(renderComponent(Root, { visible: true }))

const CardForm = seen.get('CardForm')
t('找得到编辑表单（没有它就验不了这件事）', CardForm !== undefined)

if (CardForm !== undefined) {
  await settle()
  // 草稿页已经读过一次、并且用户手上还是有内容的状态：draftAsked 该是 true 了。
  const store = stores.get('CardForm')
  // 草稿槽：7 draft / 8 draftAsked / 9 savedPrint
  store.slots[8] = true
  store.slots[9] = ''

  const props = {
    card: CARD, worlds: [], onCancel: () => {}, onSaved: () => {},
  }
  const tree = deepRender(renderComponent(CardForm, props))

  // 先确认没有「每敲一个字就存一次」：还没到 1.5 秒，不该有请求出去。
  const saves = () => calls.filter((c) => c.url.includes('/draft.save'))
  t('还没到点的时候不会每次都发请求', saves().length === 0, JSON.stringify(calls.map((c) => c.url).slice(0, 4)))

  // 找到「自述」那条正文的输入框，把最后一句改掉。
  const areas = collect(tree, (n) => n.type === 'textarea')
  const target = areas.find((n) => String(n.props?.value ?? '').includes('厨房和工厂'))
  t('找得到正文档位（自述那一栏）', target !== undefined, `textarea 数量 ${areas.length}`)
  if (target !== undefined) {
    target.props.onChange({ target: { value: '她十九岁就进厂了。' } })
    // 改完再渲染一次：React 里 setState 之后就会重渲染，「立刻存一次」指向新的字。
    deepRender(renderComponent(CardForm, props))

    const before = saves().length
    t('改字之后、定时器到点之前，仍然一个请求都没发', before === 0, String(before))

    // 用户点「先不改」走人（或切到别的卡 / 跳到别的页）：组件卸载。
    unmount(CardForm)
    await settle()

    const after = saves()
    t('离开编辑页时补发了最后那一次保存', after.length === 1, JSON.stringify(calls.map((c) => c.url).slice(0, 6)))
    t('补发的是最新那句，不是上一版', after.length === 1
      && JSON.stringify(after[0].body).includes('她十九岁就进厂了。'), after.length === 1 ? JSON.stringify(after[0].body).slice(0, 300) : '没发出去')
    t('补发的那份草稿还带着别的正文', after.length === 1
      && JSON.stringify(after[0].body).includes('把饭端出来'), after.length === 1 ? JSON.stringify(after[0].body).slice(0, 300) : '没发出去')
  }
}

// ── 存好之后，那份草稿不许又被写回来 ────────────────────────────
// 卸载时会补发一次保存（上面那一段验的就是它）。可「点『存好』」走的也是
// 卸载那条路：save() 先 draft.drop、再 onSaved()，组件这时才卸载，补发的那次
// 落在 drop 之后 —— 草稿又回来了。下次打开这张卡会看到「上次写到一半，还留着。」，
// 点「接着上次写」还会把卡拉回旧版。这是数据回退，比丢草稿严重。
if (CardForm !== undefined) {
  calls.length = 0
  stores.clear()
  applyRootPresets()
  if (cardViewFn !== undefined) storeFor(cardViewFn).slots[0] = true
  seen.clear()
  deepRender(renderComponent(Root, { visible: true }))
  const Form2 = seen.get('CardForm')
  t('存好那一段也找得到编辑表单', Form2 !== undefined)

  if (Form2 !== undefined) {
    await settle()
    const store = stores.get('CardForm')
    store.slots[8] = true   // draftAsked
    store.slots[9] = ''     // savedPrint
    const props = { card: CARD, worlds: [], onCancel: () => {}, onSaved: () => {} }
    let tree = deepRender(renderComponent(Form2, props))

    // 改一句，让它落在「不足 1.5 秒就点了存好」的那个时间窗里。
    const areas = collect(tree, (n) => n.type === 'textarea')
    const target = areas.find((n) => String(n.props?.value ?? '').includes('厨房和工厂'))
    if (target !== undefined) target.props.onChange({ target: { value: '她十九岁就进厂了，一直做到厂子关门。' } })
    tree = deepRender(renderComponent(Form2, props))

    const saveBtn = collect(tree, (n) => n.type === 'button' && String(n.props?.children ?? '') !== '' && JSON.stringify(n.props?.children).includes('存好'))[0]
    t('找得到「存好」那个按钮', saveBtn !== undefined)
    if (saveBtn !== undefined) {
      saveBtn.props.onClick()
      await settle()
      const order = calls.map((c) => c.url.replace(/^.*\/api\/dsh-lifecard\//, ''))
      const dropAt = order.indexOf('draft.drop')
      t('点存好会真的存卡', order.includes('card.save'), JSON.stringify(order))
      t('存好了才删草稿', dropAt !== -1, JSON.stringify(order))

      // 真实现场：存好之后外壳会把这一页换掉，组件卸载。
      unmount(Form2)
      await settle()
      const after = calls.map((c) => c.url.replace(/^.*\/api\/dsh-lifecard\//, ''))
      const late = after.slice(dropAt + 1).filter((m) => m === 'draft.save')
      t('删掉草稿之后不许再写回来', late.length === 0, JSON.stringify(after))
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
