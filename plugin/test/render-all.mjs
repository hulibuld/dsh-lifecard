// 逐个视图用「真实形状的数据」渲染一遍，走到最深的分支。
//
// 为什么要这个：client-smoke 只渲染了首屏（此时还没有数据），
// 而绝大多数视图（卡片详情、编辑表单、访谈、分析、提案）都要 data 到位才出现。
// 那些分支里的 JSX 一旦写错（用了没定义的小组件、字段名拼错、访问了 undefined 的属性），
// 只有用户点到那里才会炸。这个测试就是替用户去点一遍。
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const t = (n, c, x) => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, x === undefined ? '' : String(x).slice(0, 500)) } }

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ── 假 React ──────────────────────────────────────────────────────
let hookStore = []
let hookIndex = 0
const fakeReact = {
  // 关键：React 把子节点放进 props.children，组件读的就是这个。
  // 早先我把 children 单独挂在节点上，结果 <Btn>改这张卡</Btn> 里的字全丢了。
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

// ── 假 DOM（尽量别让组件真的去碰浏览器 API）────────────────────────
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

// ── 执行 bundle ───────────────────────────────────────────────────
const module = { exports: {} }
const openAt = source.indexOf('factory: (require) => {')
const closeAt = source.lastIndexOf('\n});')
let body = source.slice(openAt + 'factory: (require) => {'.length, closeAt)
body = body.replace(/\}\s*$/, '')
const factory = new Function('require', 'module', 'exports', 'window', 'document', body + '\n')
const api = factory(fakeRequire, module, module.exports, fakeWindow, document)

const registered = []
api.apply({
  get: (name) => (name === 'betterSidebar'
    ? { registerTab: (d) => { registered.push(d); return () => {} } }
    : undefined),
  effect: (fn) => { fn(); return () => {} },
})
const tab = registered[0]
const Root = api.LifeCardTab

// ── 捏真实形状的数据 ──────────────────────────────────────────────
const RELATIONS = [
  { id: 'parent', label: '父母', hint: '他们为你做过的具体事、期待与你的落差', min: 12 },
  { id: 'friend', label: '朋友', hint: '怎么认识的、一起干过最蠢的事', min: 8 },
]

const CARD_DATA = {
  lifecard: '0.1',
  id: 'mama',
  kind: 'real',
  world: 'reality',
  name: '妈妈',
  address: '妈',
  relation: '母亲',
  status: 'active',
  birth_year: 1968,
  tags: ['家人', '爱做饭'],
  competency: [{ key: '做红烧肉', level: '精通', evidence: [{ kind: '自述', what: '她说这是外婆传的' }] }],
  taboos: [{ label: '外公去世那年' }],
  knowledge: [{ label: '老家的邻居都叫得出名字' }],
  consent: { basis: 'family-agreed', recorded_at: '2026-10-01' },
}

const CARD_DETAIL = {
  ok: true,
  path: 'cards/mama.card.md',
  data: CARD_DATA,
  sections: [
    { title: '自述', body: '她一辈子在厨房和工厂之间来回。' },
    { title: '性格', body: '嘴上凶，事后会默默把饭端出来。' },
    { title: '关系史', body: '1998 年她把我从外婆家接回去。' },
    { title: '外貌', body: '' },
  ],
  validation: { ok: true, issues: [{ level: 'warn', message: '有个字段写法不对', field: 'competency' }] },
  coverage: {
    percent: 62, filled: 5,
    empty: [{ label: '口癖' }, { label: '不会做的事' }],
    rows: [], sourceLevels: [], unmarkedRatio: 0,
  },
}

const LISTING = {
  ok: true,
  workspace: '/tmp/x',
  cards: [
    { id: 'mama', path: 'cards/mama.card.md', name: '妈妈', kind: 'real', relation: '母亲', coverage: 62, tags: ['家人'] },
    { id: 'lao-zhang', path: 'cards/lao-zhang.card.md', name: '老张', kind: 'real', coverage: 30, tags: [], issues: [{ level: 'error', message: '缺字段' }] },
    { id: 'sera', path: 'cards/sera.card.md', name: '塞拉菲娜', kind: 'fictional', coverage: 88, tags: ['小说'] },
    { id: 'world-1', path: 'cards/world-1.card.md', name: '北境', kind: 'world', coverage: 20, tags: [] },
  ],
  worlds: [{ id: 'beijing', path: 'worlds/beijing.world.md', name: '北京', genre: '现实', entry_count: 2 }],
  systems: [],
  relations: [],
  materials: [
    { path: 'materials/mama-interview.md', name: 'mama-interview.md', chars: 3200 },
    { path: 'materials/chat.md', name: 'chat.md', chars: 800 },
  ],
  errors: [],
  proposals: [{ json: 'proposals/p1.json', about: '妈妈', accepted: 5, rejected: 2 }],
}

const STATE = {
  ok: true, workspace: '/tmp/x', exists: true, home: '/Users/joy',
  hasLlm: true, defaults: { workspace: '/Users/joy/Documents/Life Cards' },
  summary: { counts: { cards: 4 } }, relations: RELATIONS,
}

const PROPOSAL = {
  json: 'proposals/p1.json',
  about: { id: 'mama', name: '妈妈' },
  items: [
    { field: '自述', value: '她十九岁进厂。', checked: true, evidence: { material: 'mama-interview.md', quote: '我十九岁就进厂了' }, verified_line: 12, source_level: '自述' },
    { field: 'competency', value: { key: '做红烧肉', level: '精通' }, checked: false, evidence: { quote: '红烧肉她会做' } },
  ],
  rejected: [{ field: 'x', why: '原文里找不到这句' }],
  md: 'proposals/p1.md',
}

const DOCTOR = {
  ok: true,
  counts: { cards: 4, worlds: 1, relations: 2, materials: 2, redactions: 0 },
  host: { services: { llm: true } },
  issues: [{ level: 'error', path: 'cards/x.card.md', field: 'kind', message: 'kind 值不合法' }],
  score: {
    cards: [
      { id: 'mama', name: '妈妈', path: 'cards/mama.card.md', score: { score: 82, grade: '可用', tokens: 620 } },
      { id: 'lao-zhang', name: '老张', path: 'cards/lao-zhang.card.md', score: { score: 41, grade: '需要补', tokens: 90 } },
      { id: 'sera', name: '塞拉菲娜', path: 'cards/sera.card.md', score: { score: 96, grade: '很好', tokens: 1400 } },
    ],
  },
}

const WORLD = {
  ok: true,
  path: 'worlds/beijing.world.md',
  data: { lifecard: '0.1', id: 'beijing', kind: 'world', name: '北京', genre: '现实', entry_count: 2 },
  sections: [{ title: '世界书条目', body: '' }],
  entries: [
    { uid: 3, keys: ['北洋', '一九二八'], content: '那一年下了很大的雪。', comment: '背景', insertion_order: 42, enabled: true },
    { uid: 4, keys: [], content: '绿皮车，窗户能摇下来。', comment: '', insertion_order: 7, enabled: false },
  ],
}

// ── 迷你渲染器 ────────────────────────────────────────────────────
const seen = new Map()
const visibleText = []

function deepRender(node, depth = 0) {
  if (node === null || node === undefined || depth > 45) return
  if (typeof node === 'string') { visibleText.push(node); return }
  if (typeof node === 'number') { visibleText.push(String(node)); return }
  if (Array.isArray(node)) { for (const n of node) deepRender(n, depth + 1); return }
  if (typeof node !== 'object') return

  if (typeof node.type === 'function') {
    const name = node.type.name || ''
    if (name !== '') seen.set(name, node.type)
    const savedStore = hookStore
    const savedIndex = hookIndex
    hookStore = []
    hookIndex = 0
    let out
    try {
      out = node.type(node.props ?? {})
    } catch (e) {
      throw new Error(`组件 ${name || '(匿名)'} 渲染失败：${e.message}`)
    } finally {
      hookStore = savedStore
      hookIndex = savedIndex
    }
    deepRender(out, depth + 1)
    return
  }

  // 只把「用户真的会读到」的属性算进来。key / className / style / value 这些
  // 是给 React 和 CSS 看的，不是文案；早先全扫进去，把 `lc-btn doctor` 和
  // `proposals/p1.json` 那种内部标识符当成了黑话，误报。
  const READABLE = ['title', 'placeholder', 'alt', 'aria-label']
  for (const k of READABLE) {
    const v = node.props?.[k]
    if (typeof v === 'string') visibleText.push(v)
  }
  deepRender(node.children, depth + 1)
}

/** 把 Root 推到指定 hook 初值再整棵树渲染下去。 */
function renderRoot(name, presets) {
  hookIndex = 0
  hookStore = []
  for (const [k, v] of Object.entries(presets)) hookStore[Number(k)] = v
  try {
    const tree = Root({ visible: true })
    deepRender(tree)
    t(name, tree !== null && tree !== undefined)
    return tree
  } catch (e) {
    t(name, false, e.stack)
    return null
  }
}

/** 从 `seen` 里取一个组件按名字渲染（要求它此前已被整棵树访问到过）。 */
function h0(name, props) {
  const C = seen.get(name)
  if (C === undefined) return null
  hookIndex = 0
  hookStore = []
  return C(props ?? {})
}

/** 单独渲染一个子组件（独立 hook 槽）。presets 用来把它推到某个状态。 */
function renderOne(name, Component, props, presets = {}) {
  hookIndex = 0
  hookStore = []
  for (const [k, v] of Object.entries(presets)) hookStore[Number(k)] = v
  try {
    const tree = Component(props)
    deepRender(tree)
    t(name, tree !== null && tree !== undefined)
    return tree
  } catch (e) {
    t(name, false, e.stack)
    return null
  }
}

// ── 逐个视图渲染 ──────────────────────────────────────────────────
// hook 槽顺序（照 LifeCardTab 的 useState 声明）：
// 0 view / 1 state / 2 listing / 3 busy / 4 error / 5 toast /
// 6 activeCard / 7 proposal / 8 doctor / 9 interviewFor / 10 showMore
const base = (view, extra = {}) => ({ 0: view, 1: STATE, 2: LISTING, 3: '', 4: null, 5: null, 6: null, 7: null, 8: null, 9: null, 10: false, ...extra })

renderRoot('首页（有数据）', base('home'))
renderRoot('首页（空）', base('home', { 2: { ok: true, cards: [], materials: [], proposals: [], worlds: [], errors: [] } }))
renderRoot('首页（展开更多工具）', base('home', { 10: true }))

// ── 点一下会怎样：首页那几个入口是「从头开始」的意思 ────────────────
// 渲染树里的 onClick 是真的闭包，调它就能看到状态被改成了什么。
// 以前没有这一层，所以「点了不跳」「跳了但还带着上一个人」这类错只能靠人点。
//
// 注意：deepRender 只「走」一遍，函数型节点留在原地没有被调用结果替换。
// 想找真正的 <button> 得先把组件展开成一棵纯 DOM 树。
function expand(node, depth = 0) {
  if (node === null || node === undefined || depth > 45) return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((n) => expand(n, depth + 1)).filter((n) => n !== null)
  if (typeof node !== 'object') return null
  if (typeof node.type === 'function') {
    const savedStore = hookStore
    const savedIndex = hookIndex
    hookStore = []
    hookIndex = 0
    let out
    try { out = node.type(node.props ?? {}) } finally { hookStore = savedStore; hookIndex = savedIndex }
    return expand(out, depth + 1)
  }
  const kids = node.props?.children
  return { type: node.type, props: node.props ?? {}, children: kids === undefined ? [] : expand(kids, depth + 1) }
}
const flatButtons = (tree, out = []) => {
  if (tree === null || tree === undefined) return out
  if (Array.isArray(tree)) { for (const n of tree) flatButtons(n, out); return out }
  if (typeof tree !== 'object') return out
  if (tree.type === 'button' && typeof tree.props?.onClick === 'function') out.push(tree)
  flatButtons(tree.children, out)
  return out
}
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return ''
  return textOf(node.children)
}
const clickByText = (tree, wanted) => {
  const hit = flatButtons(expand(tree)).find((b) => textOf(b).includes(wanted))
  if (hit === undefined) return false
  hit.props.onClick()
  return true
}
const hasRotate = (tree) => {
  let found = false
  const walk = (n) => {
    if (n === null || n === undefined || found === true) return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (typeof n !== 'object') return
    const tr = n.props?.style?.transform
    if (typeof tr === 'string' && tr.includes('rotate(90deg)')) found = true
    walk(n.children)
  }
  walk(expand(tree))
  return found
}

{
  // 刚看完「妈妈」的卡，回首页点「聊着建」——访谈页不能还开着妈妈。
  const tree = renderRoot('首页（带着上一个人进访谈）', base('home', { 9: { id: 'mama', name: '妈妈' } }))
  const clicked = clickByText(tree, '聊着建')
  t('首页「聊着建」点得动', clicked === true)
  t('点「聊着建」跳到访谈页', hookStore[0] === 'interview', String(hookStore[0]))
  t('点「聊着建」不再带着上一个人', hookStore[9] === null, JSON.stringify(hookStore[9]))
}
{
  const tree = renderRoot('首页（带着上一个人去整理材料）', base('home', { 9: { id: 'mama', name: '妈妈' } }))
  const clicked = clickByText(tree, '份材料')
  t('首页「整理材料」点得动', clicked === true)
  t('点「整理材料」跳到分析页', hookStore[0] === 'analyze', String(hookStore[0]))
  t('点「整理材料」不再带着上一个人', hookStore[9] === null, JSON.stringify(hookStore[9]))
}
{
  // 选错文件夹以前就没路可退了：档案全在那边，换不回来。
  const tree = renderRoot('首页（想换文件夹）', base('home', { 10: true }))
  const clicked = clickByText(tree, '换个文件夹')
  t('「换个文件夹」点得动', clicked === true)
  t('点它跳到选文件夹那页', hookStore[0] === 'setup', String(hookStore[0]))
}
{
  // 已经有档案的时候，选文件夹那页要能退回来（否则点进去就是死胡同）。
  const tree = renderRoot('选文件夹（已经选过）', base('setup'))
  const back = clickByText(tree, '')
  void back
  const head = expand(tree)
  let hasBack = false
  const walk = (n) => {
    if (n === null || n === undefined) return
    if (Array.isArray(n)) { n.forEach(walk); return }
    if (typeof n !== 'object') return
    if (n.props?.title === '回到列表') hasBack = true
    walk(n.children)
  }
  walk(head)
  t('已经选过文件夹时，那一页能退回来', hasBack === true)
}
{
  // 「更多工具」的箭头要跟着开合转，否则看不出这是能展开的。
  const closed = renderRoot('首页（更多工具收起）', base('home', { 10: false }))
  t('收起时箭头不转', hasRotate(closed) === false)
  const opened = renderRoot('首页（更多工具展开）', base('home', { 10: true }))
  t('展开时箭头转过来', hasRotate(opened) === true)
}
renderRoot('卡片详情', base('card', { 6: CARD_DETAIL }))
renderRoot('卡片详情＋建议面板', base('card', { 6: CARD_DETAIL, 7: PROPOSAL }))
// 首页那条「还等着你看的建议」点进来时，那个人可能还没有卡。以前 activeCard
// 是 null 就直接退回首页，用户点了没反应。这时要能单独把清单摊开。
{
  const before = visibleText.length
  renderRoot('建议清单（那个人还没有卡）', base('card', { 6: null, 7: PROPOSAL }))
  const joined = visibleText.slice(before).join('|')
  t('没有卡时建议清单照样摊得开', joined.includes('AI 从材料里读出来的东西'), joined.slice(0, 200))
  t('没有卡时说清楚这个人还没卡', joined.includes('还没有卡'), joined.slice(0, 200))
  // 没卡时点「采纳」只会得到「找不到这张卡」。按钮必须换成「去建这张卡」。
  t('没有卡时不给死路按钮', !joined.includes('就用这 '), joined.slice(0, 200))
  t('没有卡时给一条去建卡的路', joined.includes('去建这张卡'), joined.slice(0, 200))
}
// 归到某本世界书里的卡：详情页要能点回那本书。
// 断言要看这一次渲染出来的文字，不能看全局的 visibleText——首页本来就
// 列着「北京」，全局断言永远为真，等于没测。
{
  const before = visibleText.length
  renderRoot('卡片详情（属于一本世界书）', base('card', {
    6: { ...CARD_DETAIL, data: { ...CARD_DATA, kind: 'fictional', world: 'beijing', name: '林小姐' } },
    2: { ...LISTING, cards: [...LISTING.cards, { id: 'lin', path: 'people/lin.card.md', name: '林小姐', kind: 'fictional', world: 'beijing', coverage: 40, tags: [] }] },
  }))
  const slice = visibleText.slice(before)
  // slice 是「一段一段文字」的数组，按元素精确比会漏掉带前后空格的片段
  t('卡片详情里能点回那本世界书', slice.join('|').includes('北京'), slice.join(' | ').slice(0, 200))
  t('现实世界的卡不显示书名', (() => {
    const b2 = visibleText.length
    renderRoot('卡片详情（现实世界）', base('card', { 6: CARD_DETAIL }))
    const s2 = visibleText.slice(b2)
    const joined = s2.join('|')
    return !joined.includes('北京') && !joined.includes('beijing') && !joined.includes('reality')
  })())
}
renderRoot('卡片详情（虚拟角色卡）', base('card', {
  6: { ...CARD_DETAIL, data: { ...CARD_DATA, kind: 'fictional', world: 'north', name: '塞拉菲娜', consent: { basis: 'fictional' } } },
}))
renderRoot('添加', base('import'))
renderRoot('让 AI 读材料', base('analyze'))
renderRoot('让 AI 读材料（已有材料）', base('analyze', { 9: { id: 'mama', name: '妈妈' } }))
// 「让 AI 读材料」跑完那个「看看读出了什么」以前是 setProposal + setView(card)，
// 但那一页手上没有 activeCard（用户可能一张卡都没打开过），一样白点。
// 现在两条入口都走同一个 showProposal：先按 about 找到卡并打开。
{
  const before = visibleText.length
  renderRoot('读完了，等着看结果', base('analyze', { 9: { id: 'mama', name: '妈妈' } }))
  const joined = visibleText.slice(before).join('|')
  t('分析页给的是「开始读」', joined.includes('开始读'), joined.slice(0, 160))
}
renderRoot('陪他聊聊', base('interview'))
renderRoot('陪他聊聊（从卡片进来）', base('interview', { 9: { id: 'mama', name: '妈妈', relationLabel: '母亲' } }))
renderRoot('一本世界书', base('world', { 11: WORLD }))
renderRoot('一本世界书（空的）', base('world', { 11: { ...WORLD, entries: [] } }))
renderRoot('一本世界书（没拿到）', base('world'))
renderRoot('检查一下', base('doctor', { 8: DOCTOR }))

// 每个视图里都不许有「按下去什么都不做」的按钮。
// 这类错最难受：按钮长得像能点的，点了只是没反应，人以为软件坏了。
{
  const views = [
    ['首页', base('home')],
    ['首页（空）', base('home', { 2: { ok: true, cards: [], materials: [], proposals: [], worlds: [], errors: [] } })],
    ['卡片详情', base('card', { 6: CARD_DETAIL })],
    ['建议清单', base('card', { 6: null, 7: PROPOSAL })],
    ['添加', base('import')],
    ['让 AI 读材料', base('analyze')],
    ['陪他聊聊', base('interview')],
    ['一本世界书', base('world', { 11: WORLD })],
    ['检查一下', base('doctor', { 8: DOCTOR })],
    ['新建一张卡', base('newCard')],
  ]
  const dead = []
  for (const [label, presets] of views) {
    const before = visibleText.length
    const tree = renderRoot('（死按钮检查）' + label, presets)
    const root = expand(tree)
    for (const b of flatButtons(root)) {
      // 有 onClick 的都算活的；null 也算（Btn 组件对 undefined 也会塞进 props）
      if (typeof b.props.onClick !== 'function') dead.push(`${label}：「${textOf(b).slice(0, 20)}」`)
    }
    // 顺带看有没有「既没 onClick 也没 disabled」的裸 button 节点
    const walk = (n) => {
      if (n === null || n === undefined) return
      if (Array.isArray(n)) { n.forEach(walk); return }
      if (typeof n !== 'object') return
      if (n.type === 'button' && n.props?.onClick === undefined && n.props?.disabled === undefined) {
        dead.push(`${label}（裸 button）：「${textOf(n).slice(0, 20)}」`)
      }
      walk(n.children)
    }
    walk(root)
    void before
  }
  t('没有按下去什么都不做的按钮', dead.length === 0, dead.join(' | '))
}
// 体检页的「还能补的卡」要能点进去。只给一行名字、点了没反应，
// 等于告诉人「这儿不好」却不给路。
{
  let opened = null
  const tree = h0('DoctorView', { report: DOCTOR, onRun: async () => {}, onOpenCard: (c) => { opened = c } })
  const clicked = tree === null ? false : clickByText(tree, '老张')
  t('体检页「还能补的卡」点得动', clicked === true)
  t('点得到的是那一张卡', opened !== null && opened.name === '老张', JSON.stringify(opened))
  t('点得到的是它的路径', opened !== null && opened.path === 'cards/lao-zhang.card.md', JSON.stringify(opened))
}
renderRoot('新建一张卡', base('newCard'))
renderRoot('选个文件夹', base('home', { 1: { ...STATE, exists: false } }))
renderRoot('连不上后台', base('home', { 1: null, 4: 'TypeError: fetch failed' }))
renderRoot('正在打开', base('home', { 1: null }))
renderRoot('出错提示条', base('home', { 4: '保存失败：磁盘满了' }))
renderRoot('成功提示条', base('home', { 5: { message: '导入完成：2 张成功', tone: 'ok' } }))

// 搜索要连世界书一起筛。以前只筛卡，搜一个卡里没有的词，下面还是整整齐齐
// 列着所有世界书，看着像「搜到了」。
if (seen.has('HomeView')) {
  const before = visibleText.length
  renderOne('首页（搜不到任何东西）', seen.get('HomeView'), {
    state: STATE, listing: LISTING, onOpen: () => {}, onOpenWorld: () => {},
    onNavigate: () => {}, onMore: () => {}, showMore: false, busy: '', onDoDoctor: () => {},
  }, { 0: 'zzz-不存在的词' })
  const slice = visibleText.slice(before).join('\n')
  t('搜不到时世界书也不列出来', slice.includes('没找到') && !slice.includes('世界书 · '), slice.slice(0, 200))

  const before2 = visibleText.length
  renderOne('首页（搜世界书的名字）', seen.get('HomeView'), {
    state: STATE, listing: LISTING, onOpen: () => {}, onOpenWorld: () => {},
    onNavigate: () => {}, onMore: () => {}, showMore: false, busy: '', onDoDoctor: () => {},
  }, { 0: '北京' })
  const slice2 = visibleText.slice(before2).join('\n')
  t('搜世界书的名字能搜到', slice2.includes('世界书 · 1'), slice2.slice(0, 200))
}

// ── 直接渲染各个子组件 ─────────────────────────────────────────────
// CardView 默认不在编辑态，要单独把它推到「编辑中」才能渲染出 CardForm
if (seen.has('CardView')) {
  renderOne('卡片详情（正在编辑）', seen.get('CardView'), {
    card: CARD_DETAIL, proposal: null, setProposal: () => {}, flash: () => {},
    onRefresh: async () => {}, onDeleted: async () => {},
    onInterview: () => {}, onAnalyze: () => {},
  }, { 0: true })
}

// CardView 的 hook 槽：0 editing / 1 busy / 2 err / 3 showExport / 4 showHistory
if (seen.has('CardView')) {
  renderOne('卡片详情（历史展开）', seen.get('CardView'), {
    card: CARD_DETAIL, proposal: null, setProposal: () => {}, flash: () => {},
    onRefresh: async () => {}, onDeleted: async () => {},
    onInterview: () => {}, onAnalyze: () => {},
  }, { 4: true })
}

if (seen.has('CardForm')) {
  renderOne('编辑表单（真实卡）', seen.get('CardForm'), { card: CARD_DETAIL, onCancel: () => {}, onSaved: async () => {} })
  renderOne('编辑表单（刚建的空卡）', seen.get('CardForm'), {
    card: { path: 'cards/new.card.md', data: { lifecard: '0.1', id: 'new', kind: 'real', name: '' }, sections: [] },
    onCancel: () => {}, onSaved: async () => {},
  })
  renderOne('编辑表单（含提案）', seen.get('CardForm'), { card: CARD_DETAIL, proposal: PROPOSAL, onCancel: () => {}, onSaved: async () => {} })
  // 导进来过世界书时，「属于哪个世界」要从手填变成下拉——手填一个不存在的 id
  // 会让这张卡从所有按世界分组的视图里消失（doctor 也会报 warn）。
  // CardForm 的 hook 槽：0 data / 1 avatar / 2 avatarTouched / 3 sections / 4 busy / 5 err / 6 more
  // 「属于哪个世界」在折叠区里，要推 more 才看得见。
  renderOne('编辑表单（有世界书可选）', seen.get('CardForm'), {
    card: CARD_DETAIL, worlds: LISTING.worlds, onCancel: () => {}, onSaved: async () => {},
  }, { 6: true })
  // world 是 real/fictional/hybrid 的必填字段。下拉里绝不能给一个空串的
  // 选项，否则用户选一下这张卡就变成「缺必需字段 world」的坏卡。
  const worldSelect = (() => {
    // 「属于哪个世界」在折叠区里，要先把 more 推成 true 才渲染得出来。
    const tree = renderOne('编辑表单（折叠区展开）', seen.get('CardForm'), {
      card: CARD_DETAIL, worlds: LISTING.worlds, onCancel: () => {}, onSaved: async () => {},
    }, { 6: true })
    const found = []
    const dig = (n) => {
      if (n === null || n === undefined || typeof n !== 'object') return
      if (Array.isArray(n)) { for (const x of n) dig(x); return }
      if (n.type === 'select' && n.props?.className === 'lc-select') found.push(n)
      for (const c of n.children ?? []) dig(c)
      dig(n.props?.children)
    }
    dig(tree)
    return found
  })()
  const worldOptions = worldSelect.length === 0 ? [] : (worldSelect[worldSelect.length - 1].children ?? []).map((o) => String(o?.props?.value ?? ''))
  t('「属于哪个世界」的下拉里没有空值', worldOptions.every((v) => v !== ''), worldOptions.join(','))
  t('「属于哪个世界」永远有 reality 兜底', worldOptions.includes('reality'), worldOptions.join(','))

  renderOne('新建表单（没有世界书）', seen.get('CardForm'), {
    card: { path: 'cards/new.card.md', data: { lifecard: '0.1', id: 'new', kind: 'real', name: '' }, sections: [] },
    worlds: [], onCancel: () => {}, onSaved: async () => {},
  }, { 6: true })
}

if (seen.has('ProposalPanel')) {
  renderOne('建议面板', seen.get('ProposalPanel'), { proposal: PROPOSAL, onClose: () => {}, onApplied: async () => {} })
}

if (seen.has('HistoryPanel')) {
  const HV = [
    { stamp: '2026-10-19T15-40-01-123Z', when: '2026-10-19T15:40:01.123Z', bytes: 820 },
    { stamp: '2026-10-18T09-02-11-004Z', when: '2026-10-18T09:02:11.004Z', bytes: 640 },
  ]
  renderOne('历史（正在找）', seen.get('HistoryPanel'), { card: CARD_DETAIL, onClose: () => {}, onRestored: async () => {} })
  renderOne('历史（有两个旧版本）', seen.get('HistoryPanel'), { card: CARD_DETAIL, onClose: () => {}, onRestored: async () => {} }, { 0: HV })
  renderOne('历史（一条都没有）', seen.get('HistoryPanel'), { card: CARD_DETAIL, onClose: () => {}, onRestored: async () => {} }, { 0: [] })
  renderOne('历史（正在看某一版）', seen.get('HistoryPanel'), { card: CARD_DETAIL, onClose: () => {}, onRestored: async () => {} }, {
    0: HV,
    3: { stamp: HV[0].stamp, data: CARD_DATA, sections: [{ title: '自述', body: '她那时候还没写这些。' }] },
  })
  renderOne('历史（读不出来的错误）', seen.get('HistoryPanel'), { card: CARD_DETAIL, onClose: () => {}, onRestored: async () => {} }, { 0: HV, 1: '找不到那个位置了。' })
}

if (seen.has('CompetencyEditor')) {
  renderOne('能力编辑器（有数据）', seen.get('CompetencyEditor'), { items: CARD_DATA.competency, onChange: () => {} })
  renderOne('能力编辑器（空）', seen.get('CompetencyEditor'), { items: undefined, onChange: () => {} })
}

if (seen.has('AvatarPicker')) {
  renderOne('头像选择器（还没有）', seen.get('AvatarPicker'), { photo: null, name: '妈妈', onChange: () => {} })
  renderOne('头像选择器（已有）', seen.get('AvatarPicker'), { photo: 'iVBORw0KGgo=', name: '妈妈', onChange: () => {} })
}

if (seen.has('BookEditor')) {
  renderOne('世界书编辑器（有条目）', seen.get('BookEditor'), {
    entries: [{ keys: ['王城'], content: '阿斯特兰位于河谷北岸' }, { keys: [], content: '' }],
    onChange: () => {},
  })
  renderOne('世界书编辑器（空的）', seen.get('BookEditor'), { entries: [], onChange: () => {} })
  renderOne('世界书编辑器（没传值）', seen.get('BookEditor'), { onChange: () => {} })
}

if (seen.has('ListEditor')) {
  renderOne('列表编辑器（有数据）', seen.get('ListEditor'), { items: CARD_DATA.taboos, onChange: () => {} })
  renderOne('列表编辑器（空）', seen.get('ListEditor'), { items: undefined, onChange: () => {} })
}

if (seen.has('CardRow')) {
  renderOne('列表行（干净）', seen.get('CardRow'), { card: LISTING.cards[0], onOpen: () => {} })
  renderOne('列表行（有错）', seen.get('CardRow'), { card: LISTING.cards[1], onOpen: () => {} })
  renderOne('列表行（世界）', seen.get('CardRow'), { card: LISTING.cards[3], onOpen: () => {} })
  renderOne('世界书列表行', seen.get('WorldRow'), { world: LISTING.worlds[0], onOpen: () => {} })
  renderOne('世界书详情', seen.get('WorldView'), { world: WORLD, listing: LISTING, onOpenCard: () => {} })
  renderOne('世界书详情（摘出来一条）', seen.get('WorldView'), { world: WORLD, listing: LISTING, onOpenCard: () => {} }, { 0: '北洋' })
  // 这里曾经有个「整理材料」按钮，点了跳去「让 AI 读你写的材料」，可那一页
  // 要先选一个人，跟这本世界书没有关系。按钮做不到它字面上说的事就先拿掉。
  {
    const before = visibleText.length
    renderOne('世界书详情（没有跑偏的按钮）', seen.get('WorldView'), { world: WORLD, listing: LISTING, onOpenCard: () => {} })
    const joined = visibleText.slice(before).join('|')
    t('世界书页不放通往人物分析的按钮', !joined.includes('整理材料'), joined.slice(0, 200))
  }
  // 人手工改过文本文件时，触发词可能写成 `keys: 北洋`（字符串）而不是数组。
  // 这时界面上要说得出「北洋」，不能显示「没有触发词」。
  renderOne('世界书详情（触发词手写成一串）', seen.get('WorldView'), {
    world: { ...WORLD, entries: [{ uid: 9, keys: '手写的', content: '一样能搜到。', enabled: true }] },
    listing: LISTING, onOpenCard: () => {},
  }, { 0: '手写' })
}

// 遍历渲染完之后再核对：所有子组件都该被访问到过。
const missing = []
for (const want of ['CardForm', 'ProposalPanel', 'HistoryPanel', 'BookEditor', 'AvatarPicker', 'CompetencyEditor', 'ListEditor', 'CardRow',
  'HomeView', 'CardView', 'ImportView', 'AnalyzeView', 'InterviewView', 'DoctorView',
  'NewCardView', 'SetupView', 'Field', 'Action', 'WorldRow', 'WorldView']) {
  if (!seen.has(want)) missing.push(want)
}
t('抓到了所有子组件', missing.length === 0, '缺：' + missing.join(', ') + '；实际：' + [...seen.keys()].join(', '))

// ── 契约：注册信息 ────────────────────────────────────────────────
t('tab.id 是 lifecard', tab.id === 'lifecard', tab.id)
t('tab.title 是 Life Cards', tab.title === 'Life Cards', tab.title)
t('tab.single 为真', tab.single === true)
t('tab.icon 是函数', typeof tab.icon === 'function')
t('tab.component 是函数', typeof tab.component === 'function')

// ── 契约：真实渲染出的可见文字里不能有技术黑话 ─────────────────────
const forbidden = ['JSON', 'chunk', 'tEXt', 'CHARX', 'CCv2', 'CCv3', 'Zod', 'schema', 'YAML',
  'proposal', 'materials/', 'doctor', 'workspace', '.lifecard', 'tombstone', '墓碑', 'frontmatter']
const unique = [...new Set(visibleText)]
t('真的渲染出了大量可见文字', unique.length > 80, `${unique.length} 段`)

const offenders = []
for (const word of forbidden) {
  const hit = unique.find((s) => s.includes(word))
  if (hit !== undefined) offenders.push(`${word} ← 「${hit.slice(0, 70)}」`)
}
t('界面文案里没有技术黑话', offenders.length === 0, offenders.join(' | '))

// ── 契约：关键按钮/文案必须真的出现 ────────────────────────────────
const all = unique.join('\n')
for (const [label, word] of [
  ['「改这张卡」按钮', '改这张卡'],
  ['「接着聊」按钮', '接着聊'],
  ['「导出角色卡」按钮', '导出角色卡'],
  ['人话的能力等级', '精通'],
  ['人话的状态', '还在'],
  ['覆盖度说法', '写完了多少'],
  ['体检分数', '分 · '],
  ['补卡提示', '还能补的卡'],
  ['历史入口', '以前的样子'],
  ['概念入口', '你想让 TA 是什么样的人'],
  ['世界书分组', '世界书 · '],
  ['世界书条数', '条设定'],
  ['世界下拉的现实世界', '现实世界（不属于哪本书）'],
  ['手写的触发词也认', '「手写的」'],
]) {
  t(`出现了 ${label}`, all.includes(word), word)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
