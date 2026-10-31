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

// 让挂起的 promise 都跑完。数字别抠得太紧：`load` 现在会多问一次
// 「这本书哪几章改过剧本」，链上多几个 await，12 个微任务轮次就不够了，
// 于是断言看到的是「还没加载完」的中间态——那是测试的问题，不是代码的。
const settle = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 60; i++) await Promise.resolve()
}

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
    // 关键：不能两次 onClick 同步连发。同步连发时第二次点下去，第一次的
    // `chapter.get` 还在飞、第一个过号检查就把它拦住了，`script.get` 之后那道
    // 检查根本走不到——测试于是永远绿，把那一行删掉也不红（审查员实测过）。
    // 这里先放行一帧，让第 2 章的 `chapter.get` 回来、`script.get` 正挂在
    // 那 60ms 里，再点第 3 章：走到 `script.get` 之后那道检查，才是真的在测它。
    await new Promise((r) => setTimeout(r, 0))
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

// ── 点顶上返回离开这一屏：组件直接卸载，没机会弹窗问「还没存，走不走」 ──────
// 现场：改完剧本，不点「存好这份剧本」，直接点顶上那个返回箭头回书架。
// BookView 卸载，scriptText 跟着没了——手改的那几场静静消失，一句提示都没有。
if (typeof BookView === 'function') {
  stores.clear()
  calls.length = 0
  SCRIPT_OF.x = SCRIPT_OF.a
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    const method = String(url).split('/').pop()
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
    const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })
    if (method === 'novel.get') return reply({ ok: true, data: { title: '雨里的门' }, idea: '', chapters: [{ index: 1 }] })
    if (method === 'novel.outline.get') return reply({ ok: true, text: '', chapters: [] })
    if (method === 'novel.chapter.get') return reply({ ok: true, body: '第一章的正文。' })
    if (method === 'novel.script.get') {
      const text = SCRIPT_OF.x ?? ''
      calls.push({ method, body })
      return reply({ ok: true, text, report: '' })
    }
    calls.push({ method, body })
    return reply({ ok: true })
  }

  const propsU = { bookId: 'x', onBack: () => {}, flash: () => {} }
  let treeU = renderComponent(BookView, propsU)
  await settle()
  treeU = renderComponent(BookView, propsU)
  await settle()

  const areasU = collect(treeU, (n) => n.type === 'textarea')
  const boxU = areasU.find((n) => String(n.props?.value ?? '').includes('他把碗放下'))
  t('找得到剧本框（卸载那一组）', boxU !== undefined, areasU.map((n) => String(n.props?.value ?? '').slice(0, 20)))

  if (boxU !== undefined) {
    // 什么都没改就先卸载：不该冒出任何保存请求。
    calls.length = 0
    for (const slot of storeFor(BookView).slots) {
      if (slot !== null && typeof slot === 'object' && slot.type === 'effect' && typeof slot.cleanup === 'function') slot.cleanup()
    }
    await settle()
    t('没改过就离开，不写盘', calls.filter((c) => c.method === 'novel.script.save').length === 0, JSON.stringify(calls.map((c) => c.method)))

    // 手改一处，还是不点「存好」，直接离开。
    boxU.props.onChange({ target: { value: boxU.props.value + '\n△ 他抬头看了一眼。' } })
    treeU = renderComponent(BookView, propsU)
    await settle()
    calls.length = 0
    for (const slot of storeFor(BookView).slots) {
      if (slot !== null && typeof slot === 'object' && slot.type === 'effect' && typeof slot.cleanup === 'function') slot.cleanup()
    }
    await settle()

    const savesU = calls.filter((c) => c.method === 'novel.script.save')
    t('离开这一屏时替人把没存的剧本收好了', savesU.length === 1, JSON.stringify(calls.map((c) => c.method)))
    t('收好的是这本书这一章', savesU.length === 1 && savesU[0].body.id === 'x' && Number(savesU[0].body.index) === 1, savesU.length === 1 ? JSON.stringify(savesU[0].body).slice(0, 120) : '')
    t('收好的是手改过的那一版', savesU.length === 1 && String(savesU[0].body.text).includes('他抬头看了一眼'), savesU.length === 1 ? String(savesU[0].body.text).slice(-40) : '')
  }

  globalThis.fetch = realFetch
}

// ── 「重改一份」不许悄悄盖掉改了没存的那一份 ────────────────────────────
if (typeof BookView === 'function') {
  stores.clear()
  calls.length = 0
  const realFetch = globalThis.fetch
  let confirmAsked = 0
  let confirmAnswer = false
  const realConfirm = fakeWindow.confirm
  fakeWindow.confirm = () => { confirmAsked += 1; return confirmAnswer }
  globalThis.fetch = async (url, opts = {}) => {
    const method = String(url).split('/').pop()
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
    const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })
    if (method === 'novel.get') return reply({ ok: true, data: { title: '雨里的门' }, idea: '', chapters: [{ index: 1 }] })
    if (method === 'novel.outline.get') return reply({ ok: true, text: '', chapters: [] })
    if (method === 'novel.chapter.get') return reply({ ok: true, body: '第一章的正文。' })
    if (method === 'novel.script.get') return reply({ ok: true, text: SCRIPT_OF.a, report: '' })
    calls.push({ method, body })
    return reply({ ok: true, text: '第1场\n客厅 日 内\n△ 新的。', report: '' })
  }

  const propsR = { bookId: 'a', onBack: () => {}, flash: () => {} }
  let treeR = renderComponent(BookView, propsR)
  await settle()
  treeR = renderComponent(BookView, propsR)
  await settle()

  const boxR = collect(treeR, (x) => x.type === 'textarea').find((x) => String(x.props?.value ?? '').includes('他把碗放下'))
  if (boxR !== undefined) {
    boxR.props.onChange({ target: { value: boxR.props.value + '\n△ 手改的。' } })
    treeR = renderComponent(BookView, propsR)
    await settle()

    const redo = collect(treeR, (x) => typeof x.type === 'function' && String(x.type.name ?? '') === 'Btn'
      && String(textOf(x)).includes('重改一份'))[0]
    t('改过之后按钮变成「重改一份」', redo !== undefined, '')

    if (redo !== undefined) {
      // 人点「取消」：一次模型调用都不该发出去，框里那一份也不许动。
      confirmAnswer = false
      calls.length = 0
      confirmAsked = 0
      redo.props.onClick()
      await settle()
      t('重改之前先问一句', confirmAsked === 1, String(confirmAsked))
      t('点取消就不重改', calls.filter((c) => c.method === 'novel.script.draft').length === 0, JSON.stringify(calls.map((c) => c.method)))
      treeR = renderComponent(BookView, propsR)
      await settle()
      const stillThere = collect(treeR, (x) => x.type === 'textarea').some((x) => String(x.props?.value ?? '').includes('手改的'))
      t('点取消之后手改的那份还在', stillThere, '')

      // 人点「继续」：这时才真的重改。
      confirmAnswer = true
      calls.length = 0
      confirmAsked = 0
      const redo2 = collect(treeR, (x) => typeof x.type === 'function' && String(x.type.name ?? '') === 'Btn'
        && String(textOf(x)).includes('重改一份'))[0]
      if (redo2 !== undefined) redo2.props.onClick()
      await settle()
      t('点继续才真的重改', calls.filter((c) => c.method === 'novel.script.draft').length === 1, JSON.stringify(calls.map((c) => c.method)))
    }
  }

  fakeWindow.confirm = realConfirm
  globalThis.fetch = realFetch
}

// ── 删的是别的章，不许把当前章正在写的正文和剧本一起抹掉 ─────────────────
// 现场：停在第 2 章写了一小段没点存，顺手把第 1 章删掉。
// 以前 removeChapter 不问 n 是不是当前章就 setBodyDirty(false)、清剧本，
// 第 2 章新写的那一段跟着没了，正文连个确认框都没有。
if (typeof BookView === 'function') {
  stores.clear()
  calls.length = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    const method = String(url).split('/').pop()
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
    const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })
    if (method === 'novel.get') return reply({ ok: true, data: { title: '雨里的门' }, idea: '', chapters: [{ index: 1 }, { index: 2 }] })
    if (method === 'novel.outline.get') return reply({ ok: true, text: '', chapters: [] })
    // 假后台要记住存进去的东西：删完别的章会重读这一章，
    // 要是每次都回同一句旧正文，就分不清「真丢」和「假后台不会存」了。
    if (method === 'novel.chapter.get') {
      return reply({ ok: true, body: diskBody[body.index] ?? `第 ${body.index} 章的旧正文。` })
    }
    if (method === 'novel.chapter.save') {
      calls.push({ method, body })
      diskBody[body.index] = String(body.body ?? '')
      return reply({ ok: true })
    }
    if (method === 'novel.script.get') {
      return reply({ ok: true, text: diskScript[body.index] ?? (body.index === 2 ? '第1场\n客厅 日 内\n△ 第 2 章原来那份。' : ''), report: '' })
    }
    if (method === 'novel.script.save') {
      calls.push({ method, body })
      diskScript[body.index] = String(body.text ?? '')
      return reply({ ok: true, report: '' })
    }
    calls.push({ method, body })
    return reply({ ok: true })
  }

  const diskBody = {}
  const diskScript = {}
  const propsD = { bookId: 'a', onBack: () => {}, flash: () => {} }
  let treeD = renderComponent(BookView, propsD)
  await settle()
  treeD = renderComponent(BookView, propsD)
  await settle()

  // 翻到第 2 章。
  const goTwo = collect(treeD, (x) => typeof x.type === 'function' && String(x.type.name ?? '') === 'Btn'
    && String(textOf(x)).startsWith('第 2 章'))[0]
  if (goTwo !== undefined) {
    goTwo.props.onClick()
    await settle()
    treeD = renderComponent(BookView, propsD)
    await settle()

    const boxes = collect(treeD, (x) => x.type === 'textarea')
    const bodyBox = boxes.find((x) => String(x.props?.value ?? '').includes('第 2 章的旧正文'))
    const scriptBox = boxes.find((x) => String(x.props?.value ?? '').includes('第 2 章原来那份'))
    t('切到第 2 章：正文和剧本都在', bodyBox !== undefined && scriptBox !== undefined, `正文:${bodyBox !== undefined} 剧本:${scriptBox !== undefined}`)

    if (bodyBox !== undefined && scriptBox !== undefined) {
      // 第 2 章正文补一段（不存），剧本也手改一处（不存）。
      bodyBox.props.onChange({ target: { value: String(bodyBox.props.value) + '\n刚写的这一小段。' } })
      scriptBox.props.onChange({ target: { value: String(scriptBox.props.value) + '\n△ 手改的一行。' } })
      treeD = renderComponent(BookView, propsD)
      await settle()

      // 对第 1 章点「删掉这一章」。
      calls.length = 0
      const delOne = collect(treeD, (x) => typeof x.type === 'function' && String(x.type.name ?? '') === 'Btn'
        && String(textOf(x)) === '删掉这一章')[0]
      t('找得到「删掉这一章」', delOne !== undefined, '')
      if (delOne !== undefined) {
        delOne.props.onClick()
        await settle()
        await new Promise((r) => setTimeout(r, 30))
        await settle()

        // 该存的先存了：第 2 章正文一次、剧本一次。
        const bodySaves = calls.filter((c) => c.method === 'novel.chapter.save')
        const scriptSaves = calls.filter((c) => c.method === 'novel.script.save')
        t('删别的章之前，先把当前章正文存好', bodySaves.length === 1 && Number(bodySaves[0].body.index) === 2, JSON.stringify(calls.map((c) => c.method)))
        t('删别的章之前，先把当前章剧本存好', scriptSaves.length === 1 && Number(scriptSaves[0].body.index) === 2, JSON.stringify(calls.map((c) => c.method)))
        t('新写的正文真的写进去了', bodySaves.length === 1 && String(bodySaves[0].body.body).includes('刚写的这一小段'), bodySaves.length === 1 ? String(bodySaves[0].body.body).slice(-40) : '')
        t('删的是第 1 章，不是第 2 章', calls.filter((c) => c.method === 'novel.chapter.delete').every((c) => Number(c.body.index) === 1), JSON.stringify(calls.filter((c) => c.method === 'novel.chapter.delete').map((c) => c.body.index)))

        // 删完之后人还应该停在第 2 章，框里的东西还在。
        treeD = renderComponent(BookView, propsD)
        await settle()
        const after = collect(treeD, (x) => x.type === 'textarea')
        const stillThere = after.some((x) => String(x.props?.value ?? '').includes('刚写的这一小段'))
        t('删完别的章，人还停在第 2 章、写的还在', stillThere, after.map((x) => String(x.props?.value ?? '').slice(0, 24)))
      }
    }
  }

  globalThis.fetch = realFetch
}

// ── 同一章里点「存好这一章」，不许误触剧本守卫把手改的剧本弄没 ─────────────
// 现场：手改剧本（没存）→ 点「存好这一章」→ 以前 load(chapterIndex) 又走一遍
// openChapter，同一章也当「换过去」，弹「剧本还没存，换过去就没了」。
// 点「好」手改消失且不发任何保存；点「取消」正文也没存上。
if (typeof BookView === 'function') {
  stores.clear()
  calls.length = 0
  const realFetch = globalThis.fetch
  let confirmAsked = 0
  let confirmAnswer = false
  const realConfirm = fakeWindow.confirm
  fakeWindow.confirm = () => { confirmAsked += 1; return confirmAnswer }
  globalThis.fetch = async (url, opts = {}) => {
    const method = String(url).split('/').pop()
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
    const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })
    if (method === 'novel.get') return reply({ ok: true, data: { title: '雨里的门' }, idea: '', chapters: [{ index: 1 }] })
    if (method === 'novel.outline.get') return reply({ ok: true, text: '', chapters: [] })
    if (method === 'novel.chapter.get') return reply({ ok: true, body: '第一章的正文。' })
    if (method === 'novel.script.get') return reply({ ok: true, text: SCRIPT_OF.a, report: '' })
    calls.push({ method, body })
    return reply({ ok: true })
  }

  const propsS = { bookId: 'a', onBack: () => {}, flash: () => {} }
  let treeS = renderComponent(BookView, propsS)
  await settle()
  treeS = renderComponent(BookView, propsS)
  await settle()

  const boxes = collect(treeS, (x) => x.type === 'textarea')
  const boxS = boxes.find((x) => String(x.props?.value ?? '').includes('他把碗放下'))
  const bodyS = boxes.find((x) => String(x.props?.value ?? '').includes('第一章的正文'))
  t('找得到正文框和剧本框（同章重读那一组）', boxS !== undefined && bodyS !== undefined, `${boxS !== undefined}/${bodyS !== undefined}`)

  if (boxS !== undefined) {
    boxS.props.onChange({ target: { value: String(boxS.props.value) + '\n△ 手改的。' } })
    treeS = renderComponent(BookView, propsS)
    await settle()

    const saveBox = collect(treeS, (x) => typeof x.type === 'function' && String(x.type.name ?? '') === 'Btn'
      && String(textOf(x)).includes('存好这一章'))[0]
    t('找得到「存好这一章」', saveBox !== undefined, '')
    if (saveBox !== undefined) {
      confirmAnswer = true
      confirmAsked = 0
      calls.length = 0
      saveBox.props.onClick()
      await settle()
      await new Promise((r) => setTimeout(r, 30))
      await settle()

      t('同一章重读不该弹「剧本还没存」', confirmAsked === 0, String(confirmAsked))
      t('点「存好这一章」时剧本一次都没被清掉（没有意外保存请求）', calls.filter((c) => c.method === 'novel.script.save').length === 0, JSON.stringify(calls.map((c) => c.method)))
      treeS = renderComponent(BookView, propsS)
      await settle()
      const still = collect(treeS, (x) => x.type === 'textarea').some((x) => String(x.props?.value ?? '').includes('手改的'))
      t('存完正文，手改的剧本还在', still, collect(treeS, (x) => x.type === 'textarea').map((x) => String(x.props?.value ?? '').slice(0, 24)))
    }
  }

  fakeWindow.confirm = realConfirm
  globalThis.fetch = realFetch
}

// ── 点了「改成剧本」又马上换书：草稿不许串到新书上去 ────────────────────
if (typeof BookView === 'function') {
  stores.clear()
  calls.length = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    const method = String(url).split('/').pop()
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
    const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })
    if (method === 'novel.get') return reply({ ok: true, data: { title: body.id }, idea: '', chapters: [{ index: 1 }] })
    if (method === 'novel.outline.get') return reply({ ok: true, text: '', chapters: [] })
    if (method === 'novel.chapter.get') return reply({ ok: true, body: `${body.id} 的正文。` })
    if (method === 'novel.script.get') return reply({ ok: true, text: '', report: '' })
    if (method === 'novel.script.draft') {
      // 慢一点回来，好让人在等的期间换书。
      await new Promise((r) => setTimeout(r, 60))
      calls.push({ method, body })
      return reply({ ok: true, text: `${body.id} 书刚改出来的剧本`, report: '', scan: { issues: [] } })
    }
    calls.push({ method, body })
    return reply({ ok: true })
  }

  const propsX2 = { bookId: 'a', onBack: () => {}, flash: () => {} }
  let treeX2 = renderComponent(BookView, propsX2)
  await settle()
  treeX2 = renderComponent(BookView, propsX2)
  await settle()

  const runBtn = collect(treeX2, (x) => typeof x.type === 'function' && String(x.type.name ?? '') === 'Btn'
    && String(textOf(x)).includes('改成剧本'))[0]
  t('找得到「把这一章改成剧本」', runBtn !== undefined, '')
  if (runBtn !== undefined) {
    runBtn.props.onClick()
    await settle()
    // 这一章的正文得先存一次（keepBody 之前 bodyDirty 为假，不会发）
    renderComponent(BookView, { bookId: 'b', onBack: () => {}, flash: () => {} })
    await new Promise((r) => setTimeout(r, 150))
    await settle()
    const treeB2 = renderComponent(BookView, { bookId: 'b', onBack: () => {}, flash: () => {} })
    await settle()
    const areas = collect(treeB2, (x) => x.type === 'textarea')
    const leaked = areas.find((x) => String(x.props?.value ?? '').includes('刚改出来的剧本'))
    t('换成另一本书后，上一本书的草稿不许显示出来', leaked === undefined, areas.map((x) => String(x.props?.value ?? '').slice(0, 24)))

    // 再卸载一次：不许把 A 的稿写成 B 的剧本。
    calls.length = 0
    for (const slot of storeFor(BookView).slots) {
      if (slot !== null && typeof slot === 'object' && slot.type === 'effect' && typeof slot.cleanup === 'function') slot.cleanup()
    }
    await settle()
    const bad = calls.filter((c) => c.method === 'novel.script.save' && String(c.body.text).includes('刚改出来的剧本'))
    t('卸载时不许把上一本书的稿写成这本书的剧本', bad.length === 0, JSON.stringify(bad.map((c) => c.body)))
  }

  globalThis.fetch = realFetch
}

// ── 存剧本的过程中又改了一句：这一版不许被当成已存 ──────────────────────
if (typeof BookView === 'function') {
  stores.clear()
  calls.length = 0
  const realFetch = globalThis.fetch
  let releaseSave = null
  globalThis.fetch = async (url, opts = {}) => {
    const method = String(url).split('/').pop()
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
    const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })
    if (method === 'novel.get') return reply({ ok: true, data: { title: '雨里的门' }, idea: '', chapters: [{ index: 1 }] })
    if (method === 'novel.outline.get') return reply({ ok: true, text: '', chapters: [] })
    if (method === 'novel.chapter.get') return reply({ ok: true, body: '第一章的正文。' })
    if (method === 'novel.script.get') return reply({ ok: true, text: SCRIPT_OF.a, report: '' })
    if (method === 'novel.script.save') {
      calls.push({ method, body })
      // 故意挂住，等测试放行——模拟「存的过程中人又改了一句」。
      await new Promise((r) => { releaseSave = r })
      return reply({ ok: true, report: '共 1 场。' })
    }
    calls.push({ method, body })
    return reply({ ok: true })
  }

  const propsW = { bookId: 'a', onBack: () => {}, flash: () => {} }
  let treeW = renderComponent(BookView, propsW)
  await settle()
  treeW = renderComponent(BookView, propsW)
  await settle()

  const boxW = collect(treeW, (x) => x.type === 'textarea').find((x) => String(x.props?.value ?? '').includes('他把碗放下'))
  if (boxW !== undefined) {
    boxW.props.onChange({ target: { value: String(boxW.props.value) + '\n△ 手改的。' } })
    treeW = renderComponent(BookView, propsW)
    await settle()

    const saveW = collect(treeW, (x) => typeof x.type === 'function' && String(x.type.name ?? '') === 'Btn'
      && String(textOf(x)).includes('存好这份剧本'))[0]
    if (saveW !== undefined) {
      saveW.props.onClick()
      await settle()
      // 存的过程中 textarea 该是只读的。
      treeW = renderComponent(BookView, propsW)
      await settle()
      const busyBox = collect(treeW, (x) => x.type === 'textarea').find((x) => String(x.props?.value ?? '').includes('他把碗放下'))
      t('存的过程中剧本框是只读的', busyBox === undefined || busyBox.props.readOnly === true, busyBox === undefined ? '' : String(busyBox.props.readOnly))
      if (typeof releaseSave === 'function') releaseSave()
      await settle()
      await new Promise((r) => setTimeout(r, 20))
      await settle()
      treeW = renderComponent(BookView, propsW)
      await settle()
      const words = JSON.stringify(collect(treeW, (n) => true).map((n) => textOf(n)))
      t('存完之后标记清掉了', words.includes('还没存') === false, words.slice(0, 160))
      // 存好之后，章列表上那个「有剧本」的小标记要立刻挂上。
      // 以前只有退出这本书再进来才看得见（load 才会重新问一次 list），
      // 人会以为自己没存上，又存一遍。
      t('存好之后章列表立刻挂上「有剧本」', words.includes('有剧本'), words.slice(0, 200))
    }
  }

  globalThis.fetch = realFetch
}

// ── 拿到草稿就立刻翻章：这份草稿只能落在它那一章 ──────────────────────────
// 审查员报的：第 2 章点「改成剧本」，稿子还在路上就翻去第 3 章，
// 回来以后稿子落进第 3 章的框，人一存就写成 books/x/scripts/003.md。
if (typeof BookView === 'function') {
  stores.clear()
  calls.length = 0
  const realFetch = globalThis.fetch
  let releaseDraft = null
  globalThis.fetch = async (url, opts = {}) => {
    const method = String(url).split('/').pop()
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
    const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })
    if (method === 'novel.get') return reply({ ok: true, data: { title: '雨里的门' }, idea: '', chapters: [{ index: 1 }, { index: 2 }, { index: 3 }] })
    if (method === 'novel.outline.get') return reply({ ok: true, text: '', chapters: [] })
    if (method === 'novel.chapter.get') return reply({ ok: true, body: `第 ${body.index} 章的正文。` })
    if (method === 'novel.script.get') return reply({ ok: true, text: '', report: '' })
    if (method === 'novel.script.draft') {
      // 故意挂住：模拟「第 2 章的稿子还在路上」。
      await new Promise((r) => { releaseDraft = r })
      return reply({ ok: true, text: '第 2 章刚改出来的剧本', report: '共 1 场。' })
    }
    calls.push({ method, body })
    return reply({ ok: true })
  }

  const propsD = { bookId: 'a', onBack: () => {}, flash: () => {} }
  let treeD = renderComponent(BookView, propsD)
  await settle()
  treeD = renderComponent(BookView, propsD)
  await settle()

  // 先翻到第 2 章。
  const go2 = collect(treeD, (x) => typeof x.type === 'function' && String(x.type.name ?? '') === 'Btn'
    && String(textOf(x)).includes('第 2 章'))[0]
  go2?.props?.onClick()
  await settle()
  treeD = renderComponent(BookView, propsD)
  await settle()

  const draftBtn = collect(treeD, (x) => typeof x.type === 'function' && String(x.type.name ?? '') === 'Btn'
    && String(textOf(x)).includes('把这一章改成剧本'))[0]
  if (draftBtn !== undefined) {
    draftBtn.props.onClick()
    await settle()
    // 稿子还在路上，人翻去第 3 章。
    treeD = renderComponent(BookView, propsD)
    const go3 = collect(treeD, (x) => typeof x.type === 'function' && String(x.type.name ?? '') === 'Btn'
      && String(textOf(x)).includes('第 3 章'))[0]
    go3?.props?.onClick()
    await settle()
    if (typeof releaseDraft === 'function') releaseDraft()
    await settle()
    await new Promise((r) => setTimeout(r, 20))
    await settle()
    treeD = renderComponent(BookView, propsD)
    await settle()

    const boxes = collect(treeD, (x) => x.type === 'textarea').map((x) => String(x.props?.value ?? ''))
    t('晚到的草稿不许落进第 3 章的框', boxes.every((v) => v.includes('第 2 章刚改出来的剧本') === false), JSON.stringify(boxes).slice(0, 200))
    const saves = calls.filter((c) => c.method === 'novel.script.save')
    t('更没有把它当第 3 章存下去', saves.every((c) => c.body.index !== 3), JSON.stringify(saves).slice(0, 200))
  }

  globalThis.fetch = realFetch
}

// ── 正文没读出来：章号也得跟标题对上，不能停在 0 ─────────────────────────
// 审查员报的：读第 2 章时后台报错，章号停在旧值（初值 0），屏幕上写「写第 0 章」，
// 一点存，后台把 index 0 当成「接在最后一章后面」，凭空多出一章。
if (typeof BookView === 'function') {
  stores.clear()
  calls.length = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    const method = String(url).split('/').pop()
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
    const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })
    if (method === 'novel.get') return reply({ ok: true, data: { title: '雨里的门' }, idea: '', chapters: [{ index: 1 }, { index: 2 }] })
    if (method === 'novel.outline.get') return reply({ ok: true, text: '', chapters: [] })
    if (method === 'novel.chapter.get') {
      calls.push({ method, body })
      if (Number(body.index) === 2) return reply({ ok: false, error: '这一章的正文读不出来。' })
      return reply({ ok: true, body: '第一章的正文。' })
    }
    if (method === 'novel.script.get') return reply({ ok: true, text: '', report: '' })
    calls.push({ method, body })
    return reply({ ok: true })
  }

  const propsE = { bookId: 'a', onBack: () => {}, flash: () => {} }
  let treeE = renderComponent(BookView, propsE)
  await settle()
  treeE = renderComponent(BookView, propsE)
  await settle()
  const go2e = collect(treeE, (x) => typeof x.type === 'function' && String(x.type.name ?? '') === 'Btn'
    && String(textOf(x)).includes('第 2 章'))[0]
  go2e?.props?.onClick()
  await settle()
  treeE = renderComponent(BookView, propsE)
  await settle()

  const wordsE = JSON.stringify(collect(treeE, (n) => true).map((n) => textOf(n)))
  t('读不出来时标题不写「写第 0 章」', wordsE.includes('写第 0 章') === false, wordsE.slice(0, 200))
  t('读不出来时标题跟着点的那一章', wordsE.includes('第 2 章'), wordsE.slice(0, 240))
  // 正文没读出来，存的动作必须禁用：不然一存就把空壳写到第 2 章去。
  const saveE = collect(treeE, (x) => typeof x.type === 'function' && String(x.type.name ?? '') === 'Btn'
    && String(textOf(x)).includes('存好这一章'))[0]
  t('读不出来时「存好这一章」是灰的', saveE === undefined || saveE.props?.disabled === true, String(saveE?.props?.disabled))

  globalThis.fetch = realFetch
}

// ── 顶栏 / 换门直接切屏前，先把这一屏没存的收好 ────────────────────────
// 以前顶栏那个「←」直接换屏，BookView 卸载时谁也来不及问一句，写了半天的正文就没了。
if (typeof BookView === 'function') {
  stores.clear()
  calls.length = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, opts = {}) => {
    const method = String(url).split('/').pop()
    const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
    const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })
    if (method === 'novel.get') return reply({ ok: true, data: { title: '雨里的门' }, idea: '', chapters: [{ index: 1 }] })
    if (method === 'novel.outline.get') return reply({ ok: true, text: '', chapters: [] })
    if (method === 'novel.chapter.get') return reply({ ok: true, body: '第一章的正文。' })
    if (method === 'novel.script.get') return reply({ ok: true, text: '', report: '' })
    calls.push({ method, body })
    return reply({ ok: true })
  }

  const flush = { current: null }
  const propsF = { bookId: 'a', onBack: () => {}, flash: () => {}, flushRef: flush }
  let treeF = renderComponent(BookView, propsF)
  await settle()
  treeF = renderComponent(BookView, propsF)
  await settle()

  t('干净的时候 flush 直接放行（不用等一帧）', flush.current !== null && flush.current() === true, String(flush.current))

  // 写一段正文，不存。
  const bodyBox = collect(treeF, (x) => x.type === 'textarea').find((x) => String(x.props?.value ?? '').includes('第一章的正文'))
  if (bodyBox !== undefined) {
    bodyBox.props.onChange({ target: { value: '第一章的正文。\n我又写了一句。' } })
    treeF = renderComponent(BookView, propsF)
    await settle()
    const out = flush.current()
    t('有没存的正文时 flush 要给一个约定（等它）', out !== true, String(out))
    await Promise.resolve(out).catch(() => false)
    await settle()
    const saved = calls.filter((c) => c.method === 'novel.chapter.save')
    t('离开之前把这段正文存下来了', saved.length >= 1 && String(saved[saved.length - 1].body.body ?? '').includes('我又写了一句'), JSON.stringify(saved).slice(0, 200))
  }

  globalThis.fetch = realFetch
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
