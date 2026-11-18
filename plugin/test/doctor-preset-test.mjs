// 检查那一屏：四条 LC 预设装没装、缺的能不能一键补上。
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
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split('/').pop()
  const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
  calls.push({ method, body })
  const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })
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
const EFFECTED = new Set(['DoctorView'])
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

// 让挂起的 promise 都跑完。数字别抠得太紧：`load` 现在会多问一次
// 「这本书哪几章改过剧本」，链上多几个 await，12 个微任务轮次就不够了，
// 于是断言看到的是「还没加载完」的中间态——那是测试的问题，不是代码的。
const settle = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 60; i++) await Promise.resolve()
}


// ── 四条 LC 预设：看得见、补得上 ─────────────────────────────────
//
// 现场：`preset.status` / `preset.install` 两条后台口子一直有，界面一次没调过。
// 后果最隐蔽的那种——预设没装上时，酒馆里那张卡带不进对话（挂卡靠的是预设里
// 那段提示词），而界面上没有任何地方能看见、也没有任何地方能补装。
// 用户看到的只是「说好了演，它却当自己是助手」。
const DoctorView = api.__DoctorView
t('找得到检查那一屏（DoctorView）', typeof DoctorView === 'function')

if (typeof DoctorView === 'function') {
  const realFetch = globalThis.fetch

  // ① 四个都装好了：不摆「补上」按钮，也不吓人。
  stores.clear()
  calls.length = 0
  let restore = () => {}
  {
    const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })
    globalThis.fetch = async (url, opts = {}) => {
      const method = String(url).split('/').pop()
      const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
      calls.push({ method, body })
      if (method === 'preset.status') {
        return reply({
          ok: true, plane: 'profile', profile: 'desktop',
          presets: [
            { id: 'lc-tavern', name: 'LC 酒馆', installed: true, stale: false },
            { id: 'lc-novel', name: 'LC 小说', installed: true, stale: false },
            { id: 'lc-real', name: 'LC 现实', installed: true, stale: false },
            { id: 'lc-diary', name: 'LC 日记', installed: true, stale: false },
          ],
          notes: ['· 四个 LC 预设都在，不用动。'],
        })
      }
      return reply({ ok: true })
    }
    restore = () => { globalThis.fetch = realFetch }

    const props = { report: null, onRun: async () => {}, onOpenCard: () => {} }
    renderComponent(DoctorView, props)
    await settle()
    const tree = renderComponent(DoctorView, props)
    await settle()

    t('打开检查页就去问预设的情况', calls.some((c) => c.method === 'preset.status'), JSON.stringify(calls.map((c) => c.method)))
    const words = textOf(tree)
    t('四个预设的名字都摆出来了', ['LC 酒馆', 'LC 小说', 'LC 现实', 'LC 日记'].every((x) => words.includes(x)), words.slice(0, 400))
    t('装好的标「在」', words.includes('在'), words.slice(0, 400))
    const fillBtn = collect(tree, (x) => typeof x.type === 'function' && String(x.type.name ?? '') === 'Btn'
      && String(textOf(x)) === '把缺的补上')[0]
    t('四个都在的时候不摆「把缺的补上」', fillBtn === undefined, typeof fillBtn)

    // 就算一份报告都没有，这一块也得在：预设没装是「能不能用」的问题，
    // 不该等到用户先去点「开始检查」才看得见。
    t('还没点「开始检查」也能看见预设这一块', words.includes('调子装好了没'), words.slice(0, 300))
  }
  restore()

  // ② 缺一个：说得清哪个缺、给得出「补上」，按下去真发请求。
  stores.clear()
  calls.length = 0
  {
    let installed = false
    const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })
    globalThis.fetch = async (url, opts = {}) => {
      const method = String(url).split('/').pop()
      const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
      calls.push({ method, body })
      if (method === 'preset.status') {
        return reply({
          ok: true, plane: 'profile', profile: 'desktop',
          presets: [
            { id: 'lc-tavern', name: 'LC 酒馆', installed, stale: false },
            { id: 'lc-novel', name: 'LC 小说', installed: true, stale: false },
            { id: 'lc-real', name: 'LC 现实', installed: true, stale: false },
            { id: 'lc-diary', name: 'LC 日记', installed: true, stale: false },
          ],
          notes: installed ? ['· 四个 LC 预设都在，不用动。'] : ['要补 1 个：lc-tavern。'],
        })
      }
      if (method === 'preset.install') {
        installed = true
        return reply({ ok: true, written: ['lc-tavern'], errors: [] })
      }
      return reply({ ok: true })
    }
    restore = () => { globalThis.fetch = realFetch }

    const props = { report: null, onRun: async () => {}, onOpenCard: () => {} }
    renderComponent(DoctorView, props)
    await settle()
    let tree = renderComponent(DoctorView, props)
    await settle()

    const words = textOf(tree)
    t('缺的那个标「没装」', words.includes('没装'), words.slice(0, 400))
    t('说清了没装的后果（卡带不进对话）', words.includes('带不进对话'), words.slice(0, 800))
    t('后台给的那句交代也摆出来了', words.includes('要补 1 个'), words.slice(0, 600))

    const fillBtn = collect(tree, (x) => typeof x.type === 'function' && String(x.type.name ?? '') === 'Btn'
      && String(textOf(x)) === '把缺的补上')[0]
    t('缺的时候摆出「把缺的补上」', fillBtn !== undefined, typeof fillBtn)

    if (fillBtn !== undefined) {
      calls.length = 0
      fillBtn.props.onClick()
      await settle()
      const installs = calls.filter((c) => c.method === 'preset.install')
      t('点「补上」真发出装预设的请求', installs.length === 1, JSON.stringify(calls.map((c) => c.method)))
      t('默认不动用户手改过的那几个（不带 updateStale）', installs.length === 1 && installs[0].body?.updateStale !== true, installs.length === 1 ? JSON.stringify(installs[0].body) : '')

      tree = renderComponent(DoctorView, props)
      await settle()
      const after = textOf(tree)
      t('装完说清装了什么', after.includes('装好了'), after.slice(0, 600))
      // 装完必须再问一次，不然界面还停在「没装」，人以为白点了。
      // `calls` 在点之前清过，所以这里就该是「先 install、后 status」这一次。
      const afterOrder = calls.map((c) => c.method)
      t('装完重新问了一次，界面跟着变', afterOrder.includes('preset.install') && afterOrder.indexOf('preset.status') > afterOrder.indexOf('preset.install'), JSON.stringify(afterOrder))
      const stillFill = collect(tree, (x) => typeof x.type === 'function' && String(x.type.name ?? '') === 'Btn'
        && String(textOf(x)) === '把缺的补上')[0]
      t('装齐之后那个按钮就不摆了', stillFill === undefined, typeof stillFill)
    }
  }
  restore()

  // ③ 有旧版本：另外给一个「连旧的也一起换成新版」，并且要先说清会盖掉手改。
  stores.clear()
  calls.length = 0
  {
    const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })
    globalThis.fetch = async (url, opts = {}) => {
      const method = String(url).split('/').pop()
      const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
      calls.push({ method, body })
      if (method === 'preset.status') {
        return reply({
          ok: true, plane: 'profile', profile: 'desktop',
          presets: [
            { id: 'lc-tavern', name: 'LC 酒馆', installed: true, stale: true },
            { id: 'lc-novel', name: 'LC 小说', installed: true, stale: false },
            { id: 'lc-real', name: 'LC 现实', installed: true, stale: false },
            { id: 'lc-diary', name: 'LC 日记', installed: true, stale: false },
          ],
          notes: [],
        })
      }
      return reply({ ok: true, written: [] })
    }
    restore = () => { globalThis.fetch = realFetch }

    const props = { report: null, onRun: async () => {}, onOpenCard: () => {} }
    renderComponent(DoctorView, props)
    await settle()
    let tree = renderComponent(DoctorView, props)
    await settle()

    const words = textOf(tree)
    t('旧版本标成「旧版本」', words.includes('旧版本'), words.slice(0, 400))
    t('说清了换新版会盖掉手改', words.includes('手改过的调子'), words.slice(-500))

    const upBtn = collect(tree, (x) => typeof x.type === 'function' && String(x.type.name ?? '') === 'Btn'
      && String(textOf(x)).includes('换成新版'))[0]
    t('有旧版本时摆出「连旧的也一起换成新版」', upBtn !== undefined, typeof upBtn)
    if (upBtn !== undefined) {
      calls.length = 0
      upBtn.props.onClick()
      await settle()
      const installs = calls.filter((c) => c.method === 'preset.install')
      t('点它才带 updateStale:true', installs.length === 1 && installs[0].body?.updateStale === true, installs.length === 1 ? JSON.stringify(installs[0].body) : '')
    }
    tree = renderComponent(DoctorView, props)
    await settle()
  }
  restore()

  // ④ 后台报错：把话摆出来，不要静默留白。
  stores.clear()
  calls.length = 0
  {
    const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })
    globalThis.fetch = async (url, opts = {}) => {
      const method = String(url).split('/').pop()
      const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
      calls.push({ method, body })
      if (method === 'preset.status') return reply({ ok: false, error: '预设安装这部分没装（lib/preset-install.js 不在）。别的功能不受影响。' })
      return reply({ ok: true })
    }
    restore = () => { globalThis.fetch = realFetch }

    const props = { report: null, onRun: async () => {}, onOpenCard: () => {} }
    renderComponent(DoctorView, props)
    await settle()
    const tree = renderComponent(DoctorView, props)
    await settle()
    t('后台报错时把那句话摆出来', textOf(tree).includes('预设安装这部分没装'), textOf(tree).slice(0, 600))
  }
  restore()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
