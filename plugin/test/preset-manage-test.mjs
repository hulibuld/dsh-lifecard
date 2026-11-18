// 调子（预设）这一排：内置的抄一份来改、改完存、删掉自己那份、删的正好是选中那份。
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
let MINE = [
  { id: 'slow', mode: 'tavern', name: '慢热', desc: '先不说话', prompt: '一句一句慢慢来。', builtin: true, book: '', world: '' },
]
globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split('/').pop()
  const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
  calls.push({ method, body })
  const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })
  if (method === 'preset.list') {
    return reply({
      ok: true,
      groups: [{ mode: 'tavern', name: '酒馆', desc: '', items: MINE.map((p) => ({ ...p })) }],
      books: [], worlds: [],
    })
  }
  if (method === 'preset.copy') {
    const one = MINE.find((p) => p.id === body.id)
    if (one === undefined) return reply({ ok: false, error: '没有这份预设' })
    const id = `${body.id}-my`
    MINE = [...MINE, { ...one, id, name: `${one.name}（我的）`, builtin: false }]
    return reply({ ok: true, id })
  }
  if (method === 'preset.save') {
    const id = String(body.id ?? body.name ?? '').trim()
    const have = MINE.find((p) => p.id === id)
    if (have !== undefined && body.overwrite !== true) return reply({ ok: false, error: '已经有一份同名的预设了，换个名字再复制' })
    const next = { id, mode: body.mode ?? 'tavern', name: body.name, desc: body.desc ?? '', prompt: body.prompt, builtin: false, book: '', world: '' }
    MINE = have === undefined ? [...MINE, next] : MINE.map((p) => (p.id === id ? next : p))
    return reply({ ok: true, id })
  }
  if (method === 'preset.delete') {
    MINE = MINE.filter((p) => p.id !== body.id)
    return reply({ ok: true })
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
const EFFECTED = new Set(['PresetBar'])
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


// ── 调子这一排：能自己写、能改、能删 ──────────────────────────────
//
// 现场：`preset.copy` / `preset.save` / `preset.delete` 三条口子后台一直有，
// 界面一次没调过。`PresetBar` 里那个 `onManage` 参数写是写了，全文件没有
// 一个调用方传它——所以那颗「管理」按钮从来就没出现过，用户只能在内置那几份里挑。
const PresetBar = api.__PresetBar
t('找得到调子那一排（PresetBar）', typeof PresetBar === 'function')

if (typeof PresetBar === 'function') {
  const props = () => ({ mode: 'tavern', value: '', onChange: (v) => { picked.push(v) } })
  let picked = []
  const btn = (tree, label) => collect(tree, (x) => typeof x.type === 'function'
    && String(x.type.name ?? '') === 'Btn' && String(textOf(x)).includes(label))[0]

  // ① 台账：内置那份摆出来了，并且给得出「抄一份来改」。
  stores.clear(); calls.length = 0; picked = []
  renderComponent(PresetBar, props())
  await settle()
  let tree = renderComponent(PresetBar, props())
  await settle()

  t('去问了预设列表', calls.some((c) => c.method === 'preset.list'), JSON.stringify(calls.map((c) => c.method)))
  t('内置那份摆出来了', textOf(tree).includes('慢热'), textOf(tree).slice(0, 300))
  const manageBtn = btn(tree, '自己写一份')
  t('摆出「自己写一份 / 改一改」', manageBtn !== undefined, typeof manageBtn)

  // ② 点开面板：内置的给「抄一份来改」，不给「删掉」。
  manageBtn?.props.onClick()
  tree = renderComponent(PresetBar, props())
  await settle()
  t('点开之后是「自己的调子」那一块', textOf(tree).includes('自己的调子'), textOf(tree).slice(0, 400))
  t('内置那份标着「内置」', textOf(tree).includes('内置'), textOf(tree).slice(0, 500))
  t('内置那份没有「删掉」按钮', btn(tree, '删掉') === undefined, typeof btn(tree, '删掉'))
  const copyBtn = btn(tree, '抄一份来改')
  t('内置那份给得出「抄一份来改」', copyBtn !== undefined, typeof copyBtn)

  // ③ 抄一份：真发请求，抄完直接进编辑框，框里是它原话。
  if (copyBtn !== undefined) {
    calls.length = 0
    copyBtn.props.onClick()
    await settle()
    const copies = calls.filter((c) => c.method === 'preset.copy')
    t('点「抄一份来改」发 preset.copy', copies.length === 1, JSON.stringify(calls.map((c) => c.method)))
    t('带的是内置那份的 id', copies.length === 1 && copies[0].body?.id === 'slow', copies.length === 1 ? JSON.stringify(copies[0].body) : '')
    tree = renderComponent(PresetBar, props())
    await settle()
    const words = textOf(tree)
    t('抄完说清了抄出的是哪一份', words.includes('（我的）'), words.slice(-600))
    const promptBox = collect(tree, (x) => x.type === 'textarea' && String(x.props?.value ?? '').includes('一句一句慢慢来'))[0]
    t('编辑框里摆着它原来的话', promptBox !== undefined, typeof promptBox)
    t('抄完不用再点一下才生效（自动选中抄出来的那份）', picked.includes('slow-my'), JSON.stringify(picked))

    // ④ 改两个字存下去：要带 overwrite，不然后台按「撞名就拒」处理。
    if (promptBox !== undefined) {
      calls.length = 0
      promptBox.props.onChange({ target: { value: '一句一句慢慢来，先写他看见的。' } })
      tree = renderComponent(PresetBar, props())
      await settle()
      const saveBtn = btn(tree, '存好')
      t('摆出「存好」', saveBtn !== undefined, typeof saveBtn)
      saveBtn?.props.onClick()
      await settle()
      const saves = calls.filter((c) => c.method === 'preset.save')
      t('存的时候发 preset.save', saves.length === 1, JSON.stringify(calls.map((c) => c.method)))
      t('改已有那份要带 overwrite', saves.length === 1 && saves[0].body?.overwrite === true, saves.length === 1 ? JSON.stringify(saves[0].body) : '')
      t('带的是改过的原话', saves.length === 1 && String(saves[0].body?.prompt ?? '').includes('先写他看见的'), saves.length === 1 ? JSON.stringify(saves[0].body) : '')
      tree = renderComponent(PresetBar, props())
      await settle()
      t('存完说存好了', textOf(tree).includes('存好了'), textOf(tree).slice(-600))
      t('存完编辑框收起', collect(tree, (x) => x.type === 'textarea').length === 0, collect(tree, (x) => x.type === 'textarea').length)
    }
  }

  // ⑤ 从头写一份：名字空着不许存。
  tree = renderComponent(PresetBar, props())
  await settle()
  const freshBtn = btn(tree, '从头写一份')
  t('摆出「从头写一份」', freshBtn !== undefined, typeof freshBtn)
  if (freshBtn !== undefined) {
    freshBtn.props.onClick()
    tree = renderComponent(PresetBar, props())
    await settle()
    calls.length = 0
    const saveBtn = btn(tree, '存好')
    saveBtn?.props.onClick()
    await settle()
    t('名字空着就不发请求', calls.filter((c) => c.method === 'preset.save').length === 0, JSON.stringify(calls.map((c) => c.method)))
    tree = renderComponent(PresetBar, props())
    await settle()
    t('并且说清缺什么', textOf(tree).includes('得有个名字'), textOf(tree).slice(-600))
  }

  // ⑥ 删自己那份：要先确认，确认了才发；删的正好是选中那份就把选择也清掉。
  stores.clear(); calls.length = 0; picked = []
  renderComponent(PresetBar, { mode: 'tavern', value: 'slow-my', onChange: (v) => { picked.push(v) } })
  await settle()
  tree = renderComponent(PresetBar, { mode: 'tavern', value: 'slow-my', onChange: (v) => { picked.push(v) } })
  await settle()
  const manage2 = btn(tree, '自己写一份')
  manage2?.props.onClick()
  tree = renderComponent(PresetBar, { mode: 'tavern', value: 'slow-my', onChange: (v) => { picked.push(v) } })
  await settle()
  const delBtn = btn(tree, '删掉')
  t('自己写的那份给得出「删掉」', delBtn !== undefined, typeof delBtn)
  if (delBtn !== undefined) {
    calls.length = 0
    delBtn.props.onClick()
    tree = renderComponent(PresetBar, { mode: 'tavern', value: 'slow-my', onChange: (v) => { picked.push(v) } })
    await settle()
    t('删之前先问一句', textOf(tree).includes('真删'), textOf(tree).slice(-500))
    t('还没问完不发请求', calls.filter((c) => c.method === 'preset.delete').length === 0, JSON.stringify(calls.map((c) => c.method)))
    const realDel = btn(tree, '删')
    realDel?.props.onClick()
    await settle()
    const dels = calls.filter((c) => c.method === 'preset.delete')
    t('确认之后才真删', dels.length === 1, JSON.stringify(calls.map((c) => c.method)))
    t('删的是那一份', dels.length === 1 && dels[0].body?.id === 'slow-my', dels.length === 1 ? JSON.stringify(dels[0].body) : '')
    t('删掉的正好是选中那份，选择也清掉', picked.includes(''), JSON.stringify(picked))
    tree = renderComponent(PresetBar, { mode: 'tavern', value: 'slow-my', onChange: (v) => { picked.push(v) } })
    await settle()
    // 只看按钮列表：上面那句「删掉了：「慢热（我的）」」本身就带这个名字，
    // 拿整页文字判会永远为真。
    const gone = collect(tree, (x) => typeof x.type === 'function' && String(x.type.name ?? '') === 'Btn'
      && String(textOf(x)) === '慢热（我的）')[0]
    t('删完它就不在列表里了', gone === undefined, textOf(tree).slice(0, 500))
  }

  // ⑦ 后台报错：把原话摆出来。
  stores.clear(); calls.length = 0
  MINE = [{ id: 'slow', mode: 'tavern', name: '慢热', desc: '', prompt: '一句一句慢慢来。', builtin: true, book: '', world: '' }]
  renderComponent(PresetBar, props())
  await settle()
  tree = renderComponent(PresetBar, props())
  await settle()
  btn(tree, '自己写一份')?.props.onClick()
  tree = renderComponent(PresetBar, props())
  await settle()
  const copy2 = btn(tree, '抄一份来改')
  // 让后台报一次错
  const realFetchInTest = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: '预设列表读不出来，检查一下文件夹权限' }) })
  copy2?.props.onClick()
  await settle()
  tree = renderComponent(PresetBar, props())
  await settle()
  t('后台报错时把那句话摆出来', textOf(tree).includes('读不出来'), textOf(tree).slice(-600))
  globalThis.fetch = realFetchInTest
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
