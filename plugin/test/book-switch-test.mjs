// 从一本书换到另一本书时，手上没存的那份剧本不能就这么没了。
//
// 现场：写小说那扇门里打开一本书，把某一章改成剧本，手改了几处，没点「存好」，
// 直接点另一本书。BookView 不卸载，只是 bookId 变了——旧的 scriptText 要么
// 跟着新书显示（看着像这本书的剧本），要么被清掉（手改的那几场静静消失）。
// 两种都不行。
//
// render-all.mjs 测不出这件事：它的假 React 不跑 effect，也不管 deps 变化。
// 这里用一个会跑 effect、会比对 deps 的迷你运行时，把 BookView 真渲染两遍。
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const t = (n, c, x) => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, x === undefined ? '' : String(x).slice(0, 500)) } }

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ── 迷你 hooks 运行时（状态按组件名存，effect 比对 deps）──────────────
const stores = new Map()
let current = null
let slotIndex = 0
let pending = []

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
  body: { appendChild() {}, removeDocument() {}, appendChild() {}, removeChild() {} },
  addEventListener() {}, removeEventListener() {},
}
globalThis.FileReader = class {}
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')
globalThis.Blob = class { constructor() {} }
globalThis.URL.createObjectURL = () => 'blob:x'
globalThis.URL.revokeObjectURL = () => {}

// ── 假后台：记下每一次请求，按方法名回不同的东西 ─────────────────────
const calls = []
const SCRIPT_OF = {
  a: ['第1场', '客厅 日 内', '【出场人物】甲', '△ 他把碗放下。'].join('\n'),
  b: '',
}
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split('/').pop()
  const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
  calls.push({ method, body })
  const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })
  if (method === 'novel.get') {
    return reply({ ok: true, data: { title: body.id === 'a' ? '雨里的门' : '另一本' }, idea: '', chapters: [{ index: 1 }] })
  }
  if (method === 'novel.outline.get') return reply({ ok: true, text: '', chapters: [] })
  if (method === 'novel.chapter.get') return reply({ ok: true, body: '第一章的正文。' })
  if (method === 'novel.script.get') {
    const text = SCRIPT_OF[body.id] ?? ''
    return reply({ ok: true, text, report: text === '' ? '' : '共 1 场。' })
  }
  return reply({ ok: true })
}

// ── 执行 bundle ────────────────────────────────────────────────────
const module = { exports: {} }
const openAt = source.indexOf('factory: (require) => {')
const closeAt = source.lastIndexOf('\n});')
let code = source.slice(openAt + 'factory: (require) => {'.length, closeAt)
code = code.replace(/\}\s*$/, '')
const factory = new Function('require', 'module', 'exports', 'window', 'document', code + '\n')
const fakeRequire = (name) => {
  if (name === 'react') return fakeReact
  if (name === 'react/jsx-runtime') return { jsx: fakeReact.createElement, jsxs: fakeReact.createElement, Fragment: 'Fragment' }
  throw new Error('unexpected require: ' + name)
}
const api = factory(fakeRequire, module, module.exports, fakeWindow, document)

// 只跑 BookView 自己的 effect：别的组件的 effect 由外壳负责，这里跑只会打闲请求。
const EFFECTED = new Set(['BookView'])
function runPending() {
  const list = pending
  pending = []
  for (const { store, slot } of list) {
    if (!EFFECTED.has(store.name)) continue
    try {
      const out = slot.fn()
      if (typeof out === 'function') slot.cleanup = out
    } catch (e) { /* effect 里出错在真环境里也就 console 一下 */ }
  }
}

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

const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return ''
  return textOf(node.children)
}

function collect(node, pred, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const n of node) collect(n, pred, out); return out }
  if (typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  collect(node.children, pred, out)
  return out
}

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

// ── 走一遍：打开 a，改剧本，不存，换去 b ────────────────────────────
const BookView = api.__BookView
t('找得到写小说那一页（BookView）', typeof BookView === 'function')

if (typeof BookView === 'function') {
  const propsA = { bookId: 'a', onBack: () => {}, flash: () => {} }
  let tree = renderComponent(BookView, propsA)
  await settle()
  tree = renderComponent(BookView, propsA)
  await settle()

  // a 这一章本来有一份剧本，打开就该摆出来。
  const areas = collect(tree, (n) => n.type === 'textarea')
  const scriptBox = areas.find((n) => String(n.props?.value ?? '').includes('他把碗放下'))
  t('打开一本书，旧的剧本直接摆出来', scriptBox !== undefined, areas.map((n) => String(n.props?.value ?? '').slice(0, 24)))

  // 手改一处，不点「存好」。
  if (scriptBox !== undefined) {
    scriptBox.props.onChange({ target: { value: scriptBox.props.value + '\n△ 他抬头看了一眼。' } })
    tree = renderComponent(BookView, propsA)
    await settle()
    const words = JSON.stringify(collect(tree, (n) => typeof n.props?.children !== 'undefined' || typeof n.children !== 'undefined')
      .map((n) => textOf(n)))
    t('改完界面上说「还没存」', words.includes('还没存'), words.slice(0, 200))
  }

  calls.length = 0

  // 换书：同一个 BookView，bookId 从 a 变成 b。
  renderComponent(BookView, { bookId: 'b', onBack: () => {}, flash: () => {} })
  await settle()

  const saves = calls.filter((c) => c.method === 'novel.script.save')
  t('换书时替上一本把剧本存回去了', saves.length === 1, JSON.stringify(calls.map((c) => c.method)))
  t('存回的是原来那本书（不是新书）', saves.length === 1 && saves[0].body.id === 'a', saves.length === 1 ? JSON.stringify(saves[0].body).slice(0, 160) : '')
  t('存的是手改过的那一版', saves.length === 1 && String(saves[0].body.text).includes('他抬头看了一眼'), saves.length === 1 ? String(saves[0].body.text).slice(-60) : '')
  t('章号也跟着上一本', saves.length === 1 && Number(saves[0].body.index) === 1, saves.length === 1 ? saves[0].body.index : '')

  // 新书那边不许带着上一本的剧本。
  const treeB = renderComponent(BookView, { bookId: 'b', onBack: () => {}, flash: () => {} })
  await settle()
  const areasB = collect(treeB, (n) => n.type === 'textarea')
  t('新书上不会显示上一本的剧本', !areasB.some((n) => String(n.props?.value ?? '').includes('他把碗放下')), areasB.map((n) => String(n.props?.value ?? '').slice(0, 24)))
}

// ── 手快连点两章：先发出去的那一章晚回来，不许盖住后点的那一章 ────────────
// 现场：第 2 章的剧本请求慢，人在等待期间又点了第 3 章。第 2 章那份剧本
// 后到，落在框里就成了「标题是第 3 章、剧本是第 2 章的」。
if (typeof BookView === 'function') {
  stores.clear()
  calls.length = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    const method = String(url).split('/').pop()
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
    if (method === 'novel.get') {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { title: '雨里的门' }, idea: '', chapters: [{ index: 1 }, { index: 2 }, { index: 3 }] }) }
    }
    if (method === 'novel.chapter.get') {
      return { ok: true, status: 200, json: async () => ({ ok: true, body: `第 ${body.index} 章的正文。` }) }
    }
    if (method === 'novel.script.get') {
      const n = Number(body.index)
      if (n === 2) {
        // 第 2 章那份剧本故意晚到。
        await new Promise((r) => setTimeout(r, 60))
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, text: n === 2 ? '第1场\n客厅 日 内\n△ 慢的那一份。' : '', report: '' }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }

  const propsX = { bookId: 'a', onBack: () => {}, flash: () => {} }
  let treeX = renderComponent(BookView, propsX)
  await settle()
  treeX = renderComponent(BookView, propsX)
  await settle()

  // 章节列表里那两个「第 2 章」「第 3 章」按钮。
  // 按钮是组件（`Btn`）还没展开成 <button>，所以按组件名 + 上面那行字找。
  const goBtn = (n) => collect(treeX, (x) => typeof x.type === 'function' && String(x.type.name ?? '') === 'Btn'
    && String(textOf(x)).startsWith(`第 ${n} 章`))[0]
  const b2 = goBtn(2)
  const b3 = goBtn(3)
  t('找得到第 2 章和第 3 章的按钮', b2 !== undefined && b3 !== undefined, `2:${b2 !== undefined} 3:${b3 !== undefined}`)

  if (b2 !== undefined && b3 !== undefined) {
    b2.props.onClick()            // 慢的那一份先发出去
    b3.props.onClick()            // 人等不及，又点了第 3 章
    await settle()
    await new Promise((r) => setTimeout(r, 120))
    await settle()
    treeX = renderComponent(BookView, propsX)
    await settle()

    const areas = collect(treeX, (x) => x.type === 'textarea')
    const late = areas.find((x) => String(x.props?.value ?? '').includes('慢的那一份'))
    t('晚回来的第 2 章剧本不许落到第 3 章的框里', late === undefined, areas.map((x) => String(x.props?.value ?? '').slice(0, 20)))
    const bodyBox = areas.find((x) => String(x.props?.value ?? '').includes('章的正文'))
    t('正文也是最后点的那一章', bodyBox === undefined || String(bodyBox.props.value).includes('第 3 章'), bodyBox === undefined ? '' : String(bodyBox.props.value).slice(0, 30))
  }

  globalThis.fetch = realFetch
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
