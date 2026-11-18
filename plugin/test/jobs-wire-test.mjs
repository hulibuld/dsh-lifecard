// 求职那一页的三处「看得见但点不动」：以前看过的报告、投递状态、写过的草稿。
//
// 现场：三条后台口子（job.evaluation.get / job.tracker.update / job.drafts +
// job.draft.get）一直有，界面一次没调过。「以前看过的」每行写着 cursor:'default'，
// 点不动；投递表只摆标签，改状态得自己去文件夹里手改 markdown；写过的简历除了
// 刚生成那一份，别的都只在 jobs/resumes 里躺着。
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

// 只跑 JobsView 自己的 effect：别的组件的 effect 由外壳负责，这里跑只会打闲请求。
const EFFECTED = new Set(['JobsView'])
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



// ── 求职那一页：三处「看得见、点不动」 ──────────────────────────
const JobsView = api.__JobsView
t('找得到求职那一页（JobsView）', typeof JobsView === 'function')

if (typeof JobsView === 'function') {
  const realFetch = globalThis.fetch
  const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })

  const EVAL_PATH = 'jobs/evaluations/2026-10-20-某公司-后端.md'
  const RESUME_PATH = 'jobs/resumes/2026-10-20-某公司.md'
  const COVER_PATH = 'jobs/covers/2026-10-20-某公司.md'

  const backend = () => {
    globalThis.fetch = async (url, opts = {}) => {
      const method = String(url).split('/').pop()
      const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
      calls.push({ method, body })
      if (method === 'job.profile.get') return reply({ ok: true, found: true, profile: { target_roles: '后端', compensation: '30k', dealbreakers: [] } })
      if (method === 'job.evaluations') {
        return reply({ ok: true, items: [{ path: EVAL_PATH, date: '2026-10-20', company: '某公司', role: '后端', bytes: 1200, when: '' }] })
      }
      if (method === 'job.evaluation.get') {
        if (body.path !== EVAL_PATH) return reply({ ok: false, error: '这不是一份评估报告。' })
        return reply({ ok: true, path: EVAL_PATH, markdown: '# 某公司 · 后端\n\n门就关着：要五年经验。' })
      }
      if (method === 'job.tracker.list') {
        return reply({ ok: true, rows: [{ date: '2026-10-20', company: '某公司', role: '后端', status: 'applied', note: '内推' }] })
      }
      if (method === 'job.tracker.update') {
        return reply({ ok: true, row: { date: '2026-10-20', company: body.company, role: body.role, status: body.patch?.status, note: '内推' } })
      }
      if (method === 'job.drafts') {
        const items = body.kind === 'cover'
          ? [{ path: COVER_PATH, name: '2026-10-20-某公司', bytes: 2048, when: '' }]
          : [{ path: RESUME_PATH, name: '2026-10-20-某公司', bytes: 4096, when: '' }]
        return reply({ ok: true, items })
      }
      if (method === 'job.draft.get') {
        return reply({ ok: true, path: body.path, markdown: '我做过一个交易系统，峰值 3000 笔每秒。' })
      }
      if (method === 'job.stories') return reply({ ok: true, stories: [] })
      return reply({ ok: true })
    }
  }

  const said = []
  const props = { onBack: () => {}, flash: (m) => { said.push(String(m)) } }
  const byText = (tree, label) => collect(tree, (x) => typeof x.type === 'function' && String(x.type.name ?? '') === 'Btn'
    && String(textOf(x)) === label)[0]
  const buttonByText = (tree, label) => collect(tree, (x) => x.type === 'button' && String(textOf(x)).includes(label))[0]
  const selectFor = (tree, value) => collect(tree, (x) => x.type === 'select' && String(x.props?.value ?? '') === value)[0]

  // ① 以前看过的：点了要能读回来
  stores.clear()
  calls.length = 0
  said.length = 0
  backend()
  renderComponent(JobsView, props)
  await settle()
  let tree = renderComponent(JobsView, props)
  await settle()

  t('摆出看过的公司', textOf(tree).includes('某公司'), textOf(tree).slice(0, 400))
  const oldRow = collect(tree, (x) => x.type === 'button' && String(x.props?.className ?? '').includes('lc-card-item'))[0]
  t('看过的每一行都是能点的按钮', oldRow !== undefined, typeof oldRow)

  if (oldRow !== undefined) {
    calls.length = 0
    await oldRow.props.onClick()
    await settle()
    const gets = calls.filter((c) => c.method === 'job.evaluation.get')
    t('点一下就去读那份报告', gets.length === 1, JSON.stringify(calls.map((c) => c.method)))
    t('带上的是列表里原样那个路径', gets.length === 1 && gets[0].body?.path === EVAL_PATH, gets.length === 1 ? JSON.stringify(gets[0].body) : '')

    tree = renderComponent(JobsView, props)
    await settle()
    const words = textOf(tree)
    t('报告的正文摆出来了', words.includes('门就关着'), words.slice(0, 800))
    t('这行标出「下面这份就是」', words.includes('下面这份就是'), words.slice(0, 800))
    t('给了「存一份」', byText(tree, '存一份') !== undefined)
    t('给了「收起来」', byText(tree, '收起来') !== undefined)

    const closeBtn = byText(tree, '收起来')
    if (closeBtn !== undefined) {
      closeBtn.props.onClick()
      await settle()
      tree = renderComponent(JobsView, props)
      await settle()
      // 判据不能用「门就关着」——页面开头那句说明里本来就有「哪些是门就关着的」。
      t('收起来之后正文就不摆了', !textOf(tree).includes('要五年经验'), textOf(tree).slice(0, 600))
    }
  }
  globalThis.fetch = realFetch

  // ② 我的投递：状态就地能改
  stores.clear()
  calls.length = 0
  said.length = 0
  backend()
  renderComponent(JobsView, props)
  await settle()
  tree = renderComponent(JobsView, props)
  await settle()

  const trackHead = buttonByText(tree, '我的投递')
  t('摆出「我的投递」入口', trackHead !== undefined, typeof trackHead)
  if (trackHead !== undefined) {
    trackHead.props.onClick()
    await settle()
    tree = renderComponent(JobsView, props)
    await settle()

    const picker = selectFor(tree, 'applied')
    t('每一条投递都是能改的下拉框', picker !== undefined, typeof picker)
    t('下拉框里是可记的那几种状态', picker !== undefined && collect(picker, (x) => x.type === 'option').length >= 6,
      picker === undefined ? '' : String(collect(picker, (x) => x.type === 'option').length))

    if (picker !== undefined) {
      calls.length = 0
      await picker.props.onChange({ target: { value: 'interview' } })
      await settle()
      const ups = calls.filter((c) => c.method === 'job.tracker.update')
      t('改状态真发出请求', ups.length === 1, JSON.stringify(calls.map((c) => c.method)))
      t('按「公司 + 岗位」定位那一行', ups.length === 1 && ups[0].body?.company === '某公司' && ups[0].body?.role === '后端',
        ups.length === 1 ? JSON.stringify(ups[0].body) : '')
      t('带的是新状态', ups.length === 1 && ups[0].body?.patch?.status === 'interview',
        ups.length === 1 ? JSON.stringify(ups[0].body) : '')

      tree = renderComponent(JobsView, props)
      await settle()
      const words = textOf(tree)
      t('改完就地变成新状态', words.includes('面试中'), words.slice(0, 800))
      // flash 是外壳给的一根回调，这里不渲染成文字——看它有没有被叫过。
      t('改完说一句「改好了」', said.includes('改好了'), JSON.stringify(said))
    }
  }
  globalThis.fetch = realFetch

  // ③ 写过的简历和求职信：翻得开
  stores.clear()
  calls.length = 0
  said.length = 0
  backend()
  renderComponent(JobsView, props)
  await settle()
  tree = renderComponent(JobsView, props)
  await settle()

  const draftHead = buttonByText(tree, '写过的简历和求职信')
  t('摆出「写过的简历和求职信」入口', draftHead !== undefined, typeof draftHead)
  if (draftHead !== undefined) {
    calls.length = 0
    draftHead.props.onClick()
    await settle()
    const reads = calls.filter((c) => c.method === 'job.drafts')
    t('点开才去翻文件夹（简历和求职信各问一次）', reads.length === 2, JSON.stringify(calls.map((c) => c.method)))
    t('两边都问了', reads.some((c) => c.body?.kind === 'resume') && reads.some((c) => c.body?.kind === 'cover'),
      JSON.stringify(reads.map((c) => c.body)))

    tree = renderComponent(JobsView, props)
    await settle()
    let words = textOf(tree)
    t('简历那一栏写着份数', words.includes('简历 · 1'), words.slice(0, 900))
    t('列表里摆出文件名', words.includes('2026-10-20-某公司'), words.slice(0, 900))

    const coverTab = byText(tree, '求职信 · 1')
    t('能给「求职信」那一栏', coverTab !== undefined, typeof coverTab)
    if (coverTab !== undefined) {
      coverTab.props.onClick()
      await settle()
      tree = renderComponent(JobsView, props)
      await settle()
      words = textOf(tree)
      t('切到求职信之后还能看见那一份', words.includes('2026-10-20-某公司'), words.slice(0, 900))
    }

    const openOne = collect(tree, (x) => x.type === 'button' && String(x.props?.className ?? '').includes('lc-card-item'))[0]
    t('每一份草稿都是能点的', openOne !== undefined, typeof openOne)
    if (openOne !== undefined) {
      calls.length = 0
      await openOne.props.onClick()
      await settle()
      const gets = calls.filter((c) => c.method === 'job.draft.get')
      t('点一份就去读它', gets.length === 1, JSON.stringify(calls.map((c) => c.method)))
      t('带上那份的路径', gets.length === 1 && String(gets[0].body?.path ?? '').startsWith('jobs/covers/'),
        gets.length === 1 ? JSON.stringify(gets[0].body) : '')

      tree = renderComponent(JobsView, props)
      await settle()
      words = textOf(tree)
      t('草稿正文摆出来了', words.includes('峰值 3000 笔每秒'), words.slice(0, 1200))
      t('给了「收起来」', byText(tree, '收起来') !== undefined)
    }
  }
  globalThis.fetch = realFetch

  // ④ 后台报错：把话摆出来，不要静默留白
  stores.clear()
  calls.length = 0
  {
    globalThis.fetch = async (url, opts = {}) => {
      const method = String(url).split('/').pop()
      const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
      calls.push({ method, body })
      if (method === 'job.profile.get') return reply({ ok: true, found: true, profile: {} })
      if (method === 'job.evaluations') {
        return reply({ ok: true, items: [{ path: EVAL_PATH, date: '2026-10-20', company: '某公司', role: '后端', bytes: 1200, when: '' }] })
      }
      if (method === 'job.evaluation.get') return reply({ ok: false, error: '这份报告被挪走了。' })
      if (method === 'job.tracker.list') return reply({ ok: true, rows: [] })
      if (method === 'job.stories') return reply({ ok: true, stories: [] })
      return reply({ ok: true })
    }
    renderComponent(JobsView, props)
    await settle()
    let t2 = renderComponent(JobsView, props)
    await settle()
    const row = collect(t2, (x) => x.type === 'button' && String(x.props?.className ?? '').includes('lc-card-item'))[0]
    if (row !== undefined) {
      await row.props.onClick()
      await settle()
      t2 = renderComponent(JobsView, props)
      await settle()
      t('读不出来时把话摆出来（不留白）', textOf(t2).includes('这份报告被挪走了'), textOf(t2).slice(0, 800))
    }
  }
  globalThis.fetch = realFetch
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
