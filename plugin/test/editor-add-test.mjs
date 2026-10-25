// 列表类小编辑器（「会什么」「禁忌」「标签」这些）的「再加一条」必须真的加一行。
//
// 真事故（用户 2026-10-24 报）：点「再加一条」没反应。
// 根因是空行靠「值里带一个空串」占位，而保存那层每次都会把空串过掉，
// 下一次渲染又只剩一行——点几次都是一行。
//
// 为什么不能塞进 render-all.mjs：那边的假 React 每次展开子组件都会把 hook
// 状态清空（这是它刻意的设计，为了逐个视图独立渲染），所以「点一下 → 状态变
// → 再渲染」这条链它跑不出来。这个文件用一个按组件名保留状态的迷你运行时。
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const t = (n, c, x) => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, x === undefined ? '' : String(x).slice(0, 400)) } }

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ── 按组件名保留状态的迷你运行时 ──────────────────────────────────
const stores = new Map()
let current = null
let slotIndex = 0

function storeFor(fn) {
  const name = fn.name || '(匿名)'
  if (!stores.has(name)) stores.set(name, { name, slots: [] })
  return stores.get(name)
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
  useEffect: () => { slotIndex++ },
  useMemo: (fn) => fn(),
  useRef: (init) => {
    const i = slotIndex++
    const st = current.slots
    if (st[i] === undefined) st[i] = { current: init }
    return st[i]
  },
  useCallback: (fn) => fn,
}

let spec = null
const fakeWindow = {
  __ModuleLoader__: { load(s) { spec = s } },
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
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) })
globalThis.FileReader = class {}
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')
globalThis.Blob = class {}
globalThis.URL.createObjectURL = () => 'blob:x'
globalThis.URL.revokeObjectURL = () => {}

new Function('window', 'document', 'globalThis', 'console', source)(fakeWindow, globalThis.document, globalThis, console)
const api = spec.factory(
  (name) => (name === 'react' ? fakeReact : { jsx: fakeReact.createElement, jsxs: fakeReact.createElement, Fragment: 'Fragment' }),
  { exports: {} }, {}, fakeWindow, globalThis.document,
)
api.apply({ get: () => undefined, effect: (fn) => { fn(); return () => {} } })

// ── 渲染工具：碰到函数组件就真的调它（状态按组件名留存）────────────
const seen = new Map()

function renderComponent(fn, props) {
  const store = storeFor(fn)
  const savedCurrent = current
  const savedIndex = slotIndex
  current = store
  slotIndex = 0
  let out
  try {
    out = fn(props ?? {})
  } finally {
    current = savedCurrent
    slotIndex = savedIndex
  }
  return expand(out)
}

function expand(node, depth = 0) {
  if (node === null || node === undefined || depth > 45) return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((n) => expand(n, depth + 1)).filter((n) => n !== null)
  if (typeof node !== 'object') return null
  if (typeof node.type === 'function') {
    const name = node.type.name || ''
    if (name !== '') seen.set(name, node.type)
    return expand(renderComponent(node.type, node.props), depth + 1)
  }
  const kids = node.props?.children
  return { type: node.type, props: node.props ?? {}, children: kids === undefined ? [] : expand(kids, depth + 1) }
}

const collect = (node, pred, out = []) => {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const n of node) collect(n, pred, out); return out }
  if (typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  collect(node.children, pred, out)
  return out
}
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return ''
  return textOf(node.children)
}

// 两个编辑器藏在「改这张卡」的表单里，所以要先走到那一屏：
// 给 Root 摆好槽位（0 view='card' / 1 state / 2 listing / 6 activeCard），
// 再把 CardView 的 0 号槽（editing）推成 true，CardForm 才会出现。
const CARD = {
  ok: true,
  path: 'people/x.card.md',
  data: { lifecard: '0.1', id: 'x', kind: 'real', world: 'reality', name: '测试', relation: '朋友', status: 'active', tags: [] },
  sections: [{ title: '自述', body: '一句话。' }],
  validation: { ok: true, issues: [] },
  coverage: { percent: 30, filled: 2, empty: [], rows: [], sourceLevels: [], unmarkedRatio: 0 },
}
const STATE = { ok: true, workspace: '/tmp/x', exists: true, hasLlm: true, relations: [], summary: {} }
const LISTING = { ok: true, workspace: '/tmp/x', cards: [], materials: [], worlds: [], systems: [], errors: [], proposals: [], avatars: {} }

function renderRootPresets() {
  const rootStore = storeFor(api.LifeCardTab)
  rootStore.slots = []
  rootStore.slots[0] = 'card'
  rootStore.slots[1] = STATE
  rootStore.slots[2] = LISTING
  rootStore.slots[6] = CARD
  rootStore.slots[13] = true
}

// 第一遍：认出 CardView（这一遍是只读态）
renderRootPresets()
renderComponent(api.LifeCardTab, { visible: true })
const cardViewFn = seen.get('CardView')

// 第二遍：把 CardView 推成编辑态，CardForm 出现，里面的两个编辑器就进 seen 了
if (cardViewFn !== undefined) {
  stores.clear()
  renderRootPresets()
  current = storeFor(cardViewFn)
  slotIndex = 0
  storeFor(cardViewFn).slots[0] = true
  seen.clear()
  renderComponent(api.LifeCardTab, { visible: true })
}
t('走到了「改这张卡」的表单', seen.get('CardForm') !== undefined)

/** 反复点「再加…」，看行数涨不涨。 */
function countRows(componentName, { placeholder, addLabel, times = 3, initialItems = [] }) {
  const C = seen.get(componentName)
  if (C === undefined) return { found: false }
  const store = storeFor(C)
  store.slots = []          // 每家单独从零开始
  let items = initialItems
  const render = () => renderComponent(C, { items, onChange: (v) => { items = v }, placeholder })
  const count = (tree) => collect(tree, (n) => n.type === 'input' && n.props?.placeholder === placeholder).length
  const before = count(render())
  for (let n = 0; n < times; n += 1) {
    const btn = collect(render(), (b) => b.type === 'button' && textOf(b).includes(addLabel))[0]
    if (btn === undefined) return { found: true, noButton: true, addLabel, before }
    btn.props.onClick({ stopPropagation() {} })
  }
  return { found: true, before, after: count(render()) }
}

console.log('\n=== 列表编辑器：点「再加」要真的多一行 ===')
{
  const got = countRows('ListEditor', { placeholder: '某件事', addLabel: '再加一条' })
  t('找得到「一行一条」的编辑器', got.found === true)
  t('找得到「再加一条」按钮', got.noButton !== true, got)
  t('点一次就多一行', got.after > got.before, JSON.stringify(got))
  t('点三次之后有四行（初始一行 + 三行）', got.after >= 4, JSON.stringify(got))
}

{
  const got = countRows('CompetencyEditor', { placeholder: '做红烧肉', addLabel: '再加一件' })
  t('找得到「会什么」的编辑器', got.found === true)
  t('找得到「再加一件」按钮', got.noButton !== true, got)
  t('点一次就多一行', got.after > got.before, JSON.stringify(got))
  t('点三次之后有四行', got.after >= 4, JSON.stringify(got))
}

console.log('\n=== 填了字之后再加，已填的不能丢 ===')
{
  const C = seen.get('ListEditor')
  const store = storeFor(C)
  store.slots = []
  let items = []
  const props = { onChange: (v) => { items = v }, placeholder: '某件事' }
  let tree = renderComponent(C, { ...props, items })
  // 第一行填上字
  const first = collect(tree, (n) => n.type === 'input' && n.props?.placeholder === '某件事')[0]
  first.props.onChange({ target: { value: '他妻子去世这件事' } })
  tree = renderComponent(C, { ...props, items })
  t('填的字进了 items', Array.isArray(items) && items.some((x) => String(x?.label ?? '') === '他妻子去世这件事'), JSON.stringify(items))
  // 再加一条，已填的那行还得在
  const add = collect(tree, (b) => b.type === 'button' && textOf(b).includes('再加一条'))[0]
  add.props.onClick({ stopPropagation() {} })
  tree = renderComponent(C, { ...props, items })
  const values = collect(tree, (n) => n.type === 'input' && n.props?.placeholder === '某件事').map((n) => String(n.props.value ?? ''))
  t('再加一条之后，刚写的那条还在', values.includes('他妻子去世这件事'), JSON.stringify(values))
  t('并且多出了一个空行可以写', values.filter((v) => v === '').length >= 1, JSON.stringify(values))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
