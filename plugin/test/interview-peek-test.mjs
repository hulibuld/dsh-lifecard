// 访谈第一屏的两条「先看一眼」：会问什么、之前答过哪些。
//
// 现场：`interview.questions` 与 `interview.history` 两条后台口子一直有，
// 界面一次没调过。用户在这一屏只能看到「他一次只问一件具体的小事」这句
// 承诺——到底会问什么、之前答到哪儿了，得真开一场才知道；开完发现问的
// 不是自己想问的那类事，已经答出去的话也收不回来。
//
// 还有一处是「之前答过哪些」的本体：台账里只存题号（`real.q01`），
// 光把题号列出来用户看不懂那是哪一题，所以这一屏要顺手把题库拉下来，
// 把题号翻成问句。
//
// render-all.mjs 测不出这两件：它的假 React 不跑 effect，也点不出回调链。
// 这里用一个会跑 effect、会比对 deps 的迷你运行时真渲染 InterviewView。
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
  body: { appendChild() {}, removeDocument() {}, removeChild() {} },
  addEventListener() {}, removeEventListener() {},
}
globalThis.FileReader = class {}
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')
globalThis.Blob = class { constructor() {} }
globalThis.URL.createObjectURL = () => 'blob:x'
globalThis.URL.revokeObjectURL = () => {}


const calls = []
let QUESTIONS = []
let EXACT = true
let HISTORY = { answered: [], skipped: 0 }
const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })

globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split('/').pop()
  const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
  calls.push({ method, body })
  if (method === 'interview.questions') {
    return reply({ ok: true, relation: body.relation, kind: body.kind, exact: EXACT, questions: QUESTIONS })
  }
  if (method === 'interview.history') return reply({ ok: true, about: body.about, ...HISTORY })
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

const InterviewView = api.__InterviewView
t('访谈那一屏找得到', typeof InterviewView === 'function', typeof InterviewView)

// 只跑 InterviewView 自己的 effect：别的组件的 effect 由外壳负责。
const EFFECTED = new Set(['InterviewView'])
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
  if (Array.isArray(node)) return node.map(textOf).join('\n')
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

const settle = async () => {
  for (let i = 0; i < 60; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
  for (let i = 0; i < 60; i++) await Promise.resolve()
}

// ── 一、题库：问什么、按哪种题问 ──────────────────────────────────
if (typeof InterviewView === 'function') {
  QUESTIONS = [
    { id: 'real.q01', ask: '他最像哪一种？', options: ['话不多，但你一开口他就知道', '嘴上凶，事都办了'], why: '先定一下调子' },
    { id: 'real.q02', ask: '他做过最让你意外的一件事是什么？' },
  ]
  EXACT = true
  const props = { state: null, listing: { cards: [] }, preset: null, onRecorded() {}, flash() {}, onDone() {}, onAnalyze() {}, mode: 'real' }

  const first = renderComponent(InterviewView, props)
  t('第一屏就摆着「会问些什么」', textOf(first).includes('会问些什么'), textOf(first).slice(0, 600))
  t('还没点的时候不摆题库', !textOf(first).includes('他最像哪一种？'), textOf(first).slice(0, 600))
  t('没开过一场的时候不摆「之前答过哪些」', !textOf(first).includes('之前答过哪些'), textOf(first).slice(0, 600))

  const qBtn = collect(first, (n) => n.props?.onClick !== undefined && textOf(n) === '会问些什么')[0]
  t('那是一个能点的按钮', qBtn !== undefined)
  calls.length = 0
  qBtn.props.onClick()
  await settle()
  const asked = calls.find((c) => c.method === 'interview.questions')
  t('点了就去问后台题库', asked !== undefined, calls.map((c) => c.method))
  t('问的时候带上关系', String(asked?.body?.relation ?? '') !== '', asked?.body)
  t('现实里的人按 real 问', asked?.body?.kind === 'real', asked?.body)

  const opened = renderComponent(InterviewView, props)
  const openedText = textOf(opened)
  t('题库摆出来了', openedText.includes('他最像哪一种？'), openedText.slice(0, 1200))
  t('第二题也在', openedText.includes('他做过最让你意外的一件事'), openedText.slice(0, 1200))
  t('有选项就列选项', openedText.includes('可以选：'), openedText.slice(0, 1200))
  t('说了为什么问这个', openedText.includes('问这个是因为：先定一下调子'), openedText.slice(0, 1200))
  t('这时候按钮变成「收起题库」', collect(opened, (n) => n.props?.onClick !== undefined && textOf(n) === '收起题库').length >= 1)

  const again = collect(opened, (n) => n.props?.onClick !== undefined && textOf(n) === '收起题库')[0]
  calls.length = 0
  again.props.onClick()
  await settle()
  t('再点一次不重新问后台', calls.length === 0, calls.map((c) => c.method))
  const closed = renderComponent(InterviewView, props)
  t('收起来以后题库就不摆了', !textOf(closed).includes('他最像哪一种？'), textOf(closed).slice(0, 900))

  // 关系对不上：后台给的是最接近的一套，界面要说清这件事。
  EXACT = false
  QUESTIONS = [{ id: 'real.q01', ask: '他最像哪一种？' }]
  const title = collect(renderComponent(InterviewView, props), (n) => n.props?.onClick !== undefined && textOf(n) === '会问些什么')[0]
  title.props.onClick()
  await settle()
  const fallback = textOf(renderComponent(InterviewView, props))
  t('题库对不上时说一句', fallback.includes('跟他这条关系对不上'), fallback.slice(0, 1400))
  t('并且给出路：上面换个词', fallback.includes('换个词'), fallback.slice(0, 1400))
  t('不再说「后台没有这条关系的题库」', !fallback.includes('后台没有跟他这条关系对应的题库'), fallback.slice(0, 1400))
  EXACT = true
}

// ── 二、虚构角色按另一套题问 ──────────────────────────────────────
if (typeof InterviewView === 'function') {
  // 换一个组件名存槽位，免得跟上一条的状态串在一起。
  const fakeFiction = (props) => InterviewView(props)
  Object.defineProperty(fakeFiction, 'name', { value: 'InterviewViewFiction' })
  QUESTIONS = [{ id: 'ch.q01', ask: 'TA 一张嘴什么感觉？' }]
  EXACT = true
  const props = { state: null, listing: { cards: [] }, preset: null, onRecorded() {}, flash() {}, onDone() {}, onAnalyze() {}, mode: 'tavern' }
  const first = renderComponent(fakeFiction, props)
  const btn = collect(first, (n) => n.props?.onClick !== undefined && textOf(n) === '会问些什么')[0]
  calls.length = 0
  btn.props.onClick()
  await settle()
  const asked = calls.find((c) => c.method === 'interview.questions')
  t('酒馆里按虚构那一套问', asked?.body?.kind === 'fictional', asked?.body)
  const opened = textOf(renderComponent(fakeFiction, props))
  t('拿到的是角色那套题', opened.includes('TA 一张嘴什么感觉？'), opened.slice(0, 1000))
}

// ── 三、历史：题号要翻成问句 ──────────────────────────────────────
if (typeof InterviewView === 'function') {
  const fakeHist = (props) => InterviewView(props)
  Object.defineProperty(fakeHist, 'name', { value: 'InterviewViewHist' })
  QUESTIONS = [
    { id: 'real.q01', ask: '他最像哪一种？' },
    { id: 'real.q02', ask: '他做过最让你意外的一件事是什么？' },
  ]
  EXACT = true
  HISTORY = {
    answered: [
      { q: 'real.q01', status: 'answered', asked_at: '2026-10-01' },
      { q: 'real.q02', status: 'skipped', reason: 'sealed' },
      { q: 'real.q09', status: 'deferred' },
    ],
    skipped: 2,
  }
  const props = { state: null, listing: { cards: [] }, preset: { id: 'mama', name: '妈妈', relationLabel: '母亲' }, onRecorded() {}, flash() {}, onDone() {}, onAnalyze() {}, mode: 'real' }
  // 从卡片进来相位直接是 prep，会先跑一次 start()；这里只关心第一屏那条按钮，
  // 所以手动把它拨回 pick。
  const store = storeFor(fakeHist)
  store.slots[0] = 'pick'
  const first = renderComponent(fakeHist, props)
  const hBtn = collect(first, (n) => n.props?.onClick !== undefined && textOf(n) === '之前答过哪些')[0]
  t('从卡片进来时摆着「之前答过哪些」', hBtn !== undefined, textOf(first).slice(0, 900))
  calls.length = 0
  hBtn.props.onClick()
  await settle()
  const askedHist = calls.find((c) => c.method === 'interview.history')
  t('点了就去读台账', askedHist !== undefined, calls.map((c) => c.method))
  t('读的是这张卡的台账', askedHist?.body?.about === 'mama', askedHist?.body)
  t('顺手也拉了题库（用来翻题号）', calls.some((c) => c.method === 'interview.questions'), calls.map((c) => c.method))

  const opened = textOf(renderComponent(fakeHist, props))
  t('题号翻成了问句', opened.includes('他最像哪一种？'), opened.slice(0, 1600))
  t('第二条也翻了', opened.includes('他做过最让你意外的一件事是什么？'), opened.slice(0, 1600))
  t('没翻出来的那条退回题号，不空着', opened.includes('real.q09'), opened.slice(0, 1600))
  t('答过的标「答过了」', opened.includes('答过了'), opened.slice(0, 1600))
  t('说了「不想说」的标成「不想说」', opened.includes('不想说'), opened.slice(0, 1600))
  t('排到后面的也标出来', opened.includes('排到后面了'), opened.slice(0, 1600))
  t('账本读坏了几行要直说', opened.includes('账本里有 2 条记录没读进来'), opened.slice(0, 1600))
  t('不说这儿有答案原文（账本上本来就没有）', !opened.includes('他说过'), opened.slice(0, 1600))
}

// ── 四、后台报错就把话照摆 ────────────────────────────────────────
if (typeof InterviewView === 'function') {
  const fakeErr = (props) => InterviewView(props)
  Object.defineProperty(fakeErr, 'name', { value: 'InterviewViewErr' })
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: '题库文件读不出来。' }) })
  const props = { state: null, listing: { cards: [] }, preset: null, onRecorded() {}, flash() {}, onDone() {}, onAnalyze() {}, mode: 'real' }
  const first = renderComponent(fakeErr, props)
  const btn = collect(first, (n) => n.props?.onClick !== undefined && textOf(n) === '会问些什么')[0]
  btn.props.onClick()
  await settle()
  const tree = renderComponent(fakeErr, props)
  const opened = textOf(tree)
  // `Err` 把话放在 props.text 里（不是 children），textOf 走不到，所以直接找这个节点。
  const errNode = collect(tree, (n) => String(n.props?.text ?? '').includes('题库文件读不出来。'))[0]
  t('后台说读不出来就照摆', errNode !== undefined, opened.slice(0, 1200))
  t('读失败时不再补一句「题库读出来是空的」', !opened.includes('题库读出来是空的'), opened.slice(0, 1200))
  globalThis.fetch = realFetch
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
