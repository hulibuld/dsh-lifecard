// 简历与规划那两处：规划存不存得下来、存过的那一版看不看得到原文。
//
// 现场一：`career.path` 把规划算完只把文本回给界面，不落盘。用户等半分钟
// 看到一份规划，关掉这一页就没了，下次进来还得再让它想一遍。`career.plan.save`
// 这条口子一直有，界面一次没调过。
//
// 现场二：`career.versions.get` 也一直有，界面上只有「用这版」和「删」——
// 想先看一眼这版写了什么再决定换不换，只能换了再看。
//
// render-all.mjs 测不出这两件：它的假 React 不跑 effect，也点不出回调链。
// 这里用一个会跑 effect、会比对 deps 的迷你运行时真渲染 CareerView。
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

// ── 假后台 ─────────────────────────────────────────────────────────
const calls = []
let PROFILE = {
  基本情况: '某某师范大学 汉语言文学 大四',
  学过什么: ['中国古代文学｜熟'],
  做过什么: ['参与校刊编辑工作'],
  会用哪些工具: ['Word'],
  想去哪: '内容运营',
  还差什么: ['六级还没过'],
}
let PLAN = { goal: '', horizon: '4年', 终点长什么样: '', 分几步走: [], 现在这一步: '', 可能会卡在哪: '' }
let PATH_TEXT = ''
const VERS = [{ name: '校招-内容运营', target: '某厂 内容运营', updated_at: '2026-10-01', path: 'career/versions/校招-内容运营.md' }]
const VERS_TEXT = '# 校招-内容运营\n\n## 基本情况\n\n某某师范大学 汉语言文学 大四\n'

globalThis.fetch = async (url, opts = {}) => {
  const method = String(url).split('/').pop()
  const body = typeof opts.body === 'string' ? JSON.parse(opts.body) : {}
  calls.push({ method, body })
  const reply = (payload) => ({ ok: true, status: 200, json: async () => payload })
  if (method === 'career.get') {
    return reply({ ok: true, profile: PROFILE, profileSections: PROFILE, plan: PLAN, planSections: PLAN })
  }
  if (method === 'career.path') {
    return reply({
      ok: true, goal: body.goal, horizon: body.horizon, text: PATH_TEXT,
      steps: [{ text: '把六级过了', when: '第 1 个月', done: '考过 425' }],
    })
  }
  if (method === 'career.plan.save') { PLAN = { ...PLAN, ...body.plan }; return reply({ ok: true, path: 'career/purpose.md' }) }
  if (method === 'career.versions.list') return reply({ ok: true, versions: VERS })
  if (method === 'career.versions.get') return reply({ ok: true, path: body.path, name: '校招-内容运营', text: VERS_TEXT })
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

// 只跑 CareerView 自己的 effect：别的组件的 effect 由外壳负责。
const EFFECTED = new Set(['CareerView'])
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

// ── 一、把整份规划拆回四个字段 ────────────────────────────────────
const planFromText = api.__planFromText
t('拆规划的这段找得到', typeof planFromText === 'function')

if (typeof planFromText === 'function') {
  const four = planFromText([
    '## 终点长什么样',
    '四年后能独立带一个内容小组。',
    '',
    '## 分几步走',
    '- 把六级过了｜第 1 个月｜考过 425',
    '- 写完三篇稿｜第 2-3 个月｜发出去并拿到回复',
    '',
    '## 现在这一步',
    '先把六级报上。',
    '',
    '## 可能会卡在哪',
    '实习和课程撞期。',
  ].join('\n'), '进内容运营', '4年')

  t('第一节认出来了', four['终点长什么样'] === '四年后能独立带一个内容小组。', four['终点长什么样'])
  t('「分几步走」是数组', Array.isArray(four['分几步走']), four['分几步走'])
  t('两条步骤都在', four['分几步走'].length === 2, four['分几步走'])
  t('步骤里的 `- ` 剥掉了', four['分几步走'][0] === '把六级过了｜第 1 个月｜考过 425', four['分几步走'][0])
  t('「现在这一步」认出来了', four['现在这一步'] === '先把六级报上。', four['现在这一步'])
  t('「可能会卡在哪」认出来了', four['可能会卡在哪'] === '实习和课程撞期。', four['可能会卡在哪'])
  t('想到哪儿去带着', four.goal === '进内容运营', four.goal)
  t('管多久带着', four.horizon === '4年', four.horizon)
  t('标题行本身不混进正文', !four['终点长什么样'].includes('##'), four['终点长什么样'])

  const one = planFromText('这份规划没分节，就是一整段话。', 'g', '1年')
  t('认不出小节时整份塞进第一节', one['终点长什么样'] === '这份规划没分节，就是一整段话。', one['终点长什么样'])
  t('认不出小节时仍然带着目标', one.goal === 'g', one.goal)

  const starred = planFromText('## 分几步走\n* 第一步\n1. 第二步\n', '', '')
  t('`*` 和 `1.` 也当成一条', starred['分几步走'].length === 2, starred['分几步走'])

  const padded = planFromText('## 分几步走 这么做\n- 一条\n', '', '')
  t('标题后面多两个字的也认', padded['分几步走'].length === 1, padded['分几步走'])

  const none = planFromText('', '', '')
  t('空文本不炸', none['终点长什么样'] === '' && none['分几步走'].length === 0, none)
}

// ── 二、真渲染 CareerView：规划存得下来、旧版本看得到原文 ──────────────
const CareerView = api.__CareerView
t('找得到简历与规划那一屏（CareerView）', typeof CareerView === 'function')

if (typeof CareerView === 'function') {
  const props = { flash: () => {}, onBack: () => {}, cards: [], onOpenCard: () => {} }
  const byText = (tree, s) => collect(tree, (n) => {
    const kids = n.children
    return typeof kids === 'string' && kids === s
  })

  stores.clear()
  calls.length = 0
  PROFILE = { ...PROFILE }
  PLAN = { goal: '', horizon: '4年', 终点长什么样: '', 分几步走: [], 现在这一步: '', 可能会卡在哪: '' }
  PATH_TEXT = '## 终点长什么样\n四年后能独立带一个内容小组。\n\n## 分几步走\n- 把六级过了｜第 1 个月｜考过 425\n\n## 现在这一步\n先把六级报上。\n\n## 可能会卡在哪\n实习和课程撞期。'

  // 第一遍：effect 读 career.get，把简历摆上来。
  renderComponent(CareerView, props)
  await settle()
  t('一进来就去读了简历', calls.some((c) => c.method === 'career.get'), calls.map((c) => c.method))

  const fresh = renderComponent(CareerView, props)
  const freshText = textOf(fresh)
  t('简历摆出来了（不是死在转圈上）', freshText.includes('先数一遍写了什么'), freshText.slice(0, 500))
  // 不能用 `!freshText.includes('存下来')` 判：一岗一版那一节本身写着
  // 「存下来，以后被问『你当时投的那份写了什么』还找得到」。只看按钮。
  t('还没规划过就不摆「存下来」',
    collect(fresh, (n) => n.props?.onClick !== undefined && textOf(n) === '存下来').length === 0,
    freshText.slice(0, 1200))

  // 写一句目标，点「规划怎么走」
  {
    const goalInput = collect(fresh, (n) => n.type === 'input' && n.props?.placeholder === '想到哪儿去（一句具体的）')[0]
    t('有「想到哪儿去」那个框', goalInput !== undefined)
    if (goalInput !== undefined) goalInput.props.onChange({ target: { value: '进内容运营' } })
  }
  const withGoal = renderComponent(CareerView, props)
  const goBtn = collect(withGoal, (n) => n.props?.onClick !== undefined && textOf(n).includes('规划怎么走'))[0]
  t('有「规划怎么走」那颗按钮', goBtn !== undefined)
  calls.length = 0
  goBtn.props.onClick()
  await settle()
  t('点了就去规划了', calls.some((c) => c.method === 'career.path'), calls.map((c) => c.method))
  const asked = calls.find((c) => c.method === 'career.path')
  t('规划带上了那句目标', asked?.body?.goal === '进内容运营', asked?.body)
  t('规划带上了管多久', asked?.body?.horizon === '4年', asked?.body)

  const planned = renderComponent(CareerView, props)
  const plannedText = textOf(planned)
  t('规划结果摆出来了', plannedText.includes('四年后能独立带一个内容小组'), plannedText.slice(0, 2000))
  t('规划下面有「存下来」', plannedText.includes('存下来'), plannedText.slice(-2000))

  // 点「存下来」
  const saveBtn = collect(planned, (n) => n.props?.onClick !== undefined && textOf(n) === '存下来')[0]
  t('「存下来」是个按钮', saveBtn !== undefined)
  calls.length = 0
  saveBtn.props.onClick()
  await settle()
  const saved = calls.find((c) => c.method === 'career.plan.save')
  t('点了就去存了', saved !== undefined, calls.map((c) => c.method))
  t('存的是四个小节', saved?.body?.plan?.['终点长什么样'] === '四年后能独立带一个内容小组。', saved?.body?.plan)
  t('步骤按条存', Array.isArray(saved?.body?.plan?.['分几步走']) && saved.body.plan['分几步走'].length === 1, saved?.body?.plan?.['分几步走'])
  t('存的时候带着目标', saved?.body?.plan?.goal === '进内容运营', saved?.body?.plan?.goal)
  t('存的时候带着管多久', saved?.body?.plan?.horizon === '4年', saved?.body?.plan?.horizon)
  t('「可能会卡在哪」也存进去了', saved?.body?.plan?.['可能会卡在哪'] === '实习和课程撞期。', saved?.body?.plan?.['可能会卡在哪'])

  const done = renderComponent(CareerView, props)
  t('存好以后说清存到哪了', textOf(done).includes('career/purpose.md'), textOf(done).slice(-1200))
  t('存好以后按钮变成「再存一次」', collect(done, (n) => n.props?.onClick !== undefined && textOf(n) === '再存一次').length === 1)

  // 存过的那一版：看得见原文
  calls.length = 0
  const listBtn = collect(done, (n) => n.props?.onClick !== undefined && (textOf(n) === '看看存过哪些' || textOf(n) === '重新读一遍'))[0]
  t('有「看看存过哪些」', listBtn !== undefined)
  listBtn.props.onClick()
  await settle()
  t('去读了存过的那些', calls.some((c) => c.method === 'career.versions.list'), calls.map((c) => c.method))

  const listed = renderComponent(CareerView, props)
  const listedText = textOf(listed)
  t('那一版列出来了', listedText.includes('校招-内容运营'), listedText.slice(-1600))
  const peekBtn = collect(listed, (n) => n.props?.onClick !== undefined && textOf(n) === '看原文')[0]
  t('每一版都有「看原文」', peekBtn !== undefined, listedText.slice(-1200))

  calls.length = 0
  peekBtn.props.onClick()
  await settle()
  const asked2 = calls.find((c) => c.method === 'career.versions.get')
  t('点了就去读那一版', asked2 !== undefined, calls.map((c) => c.method))
  t('读的是点的那一版', asked2?.body?.path === 'career/versions/校招-内容运营.md', asked2?.body)

  const peeked = renderComponent(CareerView, props)
  const peekedText = textOf(peeked)
  t('原文摆出来了', peekedText.includes('某某师范大学 汉语言文学 大四'), peekedText.slice(-1600))
  t('说清是哪一版的原文', peekedText.includes('「校招-内容运营」这一版写的是'), peekedText.slice(-1600))
  t('这时候按钮变成「收起来」', collect(peeked, (n) => n.props?.onClick !== undefined && textOf(n) === '收起来').length >= 1)
  t('看原文没有动现在填的那份', String(storeFor(CareerView).slots[7]) === 'false', storeFor(CareerView).slots[7])

  const closeBtn = collect(peeked, (n) => n.props?.onClick !== undefined && textOf(n) === '收起来')[0]
  closeBtn.props.onClick()
  const closed = renderComponent(CareerView, props)
  t('收起来以后原文就不摆了', !textOf(closed).includes('「校招-内容运营」这一版写的是'), textOf(closed).slice(-1200))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
