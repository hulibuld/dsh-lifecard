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
// 「开一个新会话」这个宿主能力。谁点「聊一聊」都该落到这儿，而不是插件自己切屏。
const SESSIONS = []
api.apply({
  get: (name) => {
    if (name === 'betterSidebar') return { registerTab: (d) => { registered.push(d); return () => {} } }
    if (name === 'uiWorkspace') {
      return { startSession: (workspaceId, options) => { SESSIONS.push({ workspaceId, ...(options ?? {}) }); return Promise.resolve() } }
    }
    return undefined
  },
  effect: (fn) => { fn(); return () => {} },
})
const tab = registered[0]
const Root = api.LifeCardTab

// ── 捏真实形状的数据 ──────────────────────────────────────────────
// 关系选项是「他是我的什么人」的答案，不是关系类别。
// 以前这里是 parent/「父母」，界面一列出来就是「父母 / 祖辈 / 伴侣」，
// 用户对着自己妈妈要选「父母」，读起来像在填表格。
const RELATIONS = [
  { id: 'father', label: '父亲', hint: '他为你做过的具体事、期待与你的落差', min: 12 },
  { id: 'mother', label: '母亲', hint: '她为你做过的具体事、期待与你的落差', min: 12 },
  { id: 'grandpa', label: '爷爷', hint: '手艺与职业细节、说过的老话', min: 10 },
  { id: 'grandma', label: '奶奶', hint: '手艺与职业细节、说过的老话', min: 10 },
  { id: 'partner', label: '伴侣', hint: '初见场景、吵架的模式、对方的雷区', min: 10 },
  { id: 'friend', label: '朋友', hint: '怎么认识的、一起干过最蠢的事', min: 8 },
  { id: 'custom', label: '自己填', hint: '上面都没有？直接写你们的关系', min: 8 },
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
  // 头像单独取：存在 assets/ 里，不在卡文件里，所以是列表额外带回来的一张表。
  avatars: { mama: 'iVBORw0KGgo=' },
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

const PROPOSAL_OBJECTS = {
  json: 'proposals/p2.json',
  about: { id: 'mama', name: '妈妈' },
  items: [
    { field: 'knowledge', value: { knows: ['榫卯'], does_not_know: ['电路'] }, checked: true },
    { field: 'address', value: { them_to_me: ['老张'], me_to_them: ['张叔'] }, checked: true },
    { field: 'life', value: { dietary: ['清淡'], physical: ['腿不好'] }, checked: true },
    { field: 'competency', value: { key: '做红烧肉', level: 'expert' }, checked: true },
  ],
  rejected: [],
  md: 'proposals/p2.md',
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

const homeTree = renderRoot('首页（有数据）', base('home'))
{
  // 材料必须在首页有一栏。以前只在「更多工具」里报个数字，用户从记忆里
  // 提出来一堆东西之后回首页找不到——不知道存哪了，也没法看、没法删。
  const homeText = homeTree === null ? '' : JSON.stringify(expand(homeTree))
  t('首页有「材料」这一栏', homeText.includes('材料 · 2'), homeText.slice(0, 400))
  t('首页列出每一份材料', homeText.includes('mama-interview.md'), homeText.slice(0, 400))
  t('每份材料旁边能「看」', homeText.includes('"看"') || homeText.includes('看'), homeText.slice(0, 400))
  t('每份材料旁边能「删」', homeText.includes('"删"') || homeText.includes('删'), homeText.slice(0, 400))
}
// ── 已经撤掉的卡：入口要看得见，展开后两条路都要有 ──────────────────
// 删掉的卡不是没了，是从列表里撤下去、原文还在磁盘上。以前这一栏根本不存在，
// 删错的人找不回来，想清干净的人也找不到路——卡在中间，只能去翻文件夹。
const GONE_ITEMS = [
  { path: 'cards/gone.card.md', id: 'gone', name: '老周', withdrawn_at: '2026-10-20T10:00:00.000Z' },
  { path: 'cards/old.card.md', id: 'old', name: '小满', withdrawn_at: '2026-10-21T10:00:00.000Z' },
]
/** 展开后的纯 DOM 树里，用户真的读得到的字（含 title）。 */
const textIn = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textIn).join('')
  if (typeof node !== 'object') return ''
  const title = typeof node.props?.title === 'string' ? node.props.title : ''
  return title + textIn(node.children)
}
/** 按条件收节点：找按钮就看它，别去数 JSON 字符串（props 和 children 会各算一次）。 */
const collectIn = (node, pred, out = []) => {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const n of node) collectIn(n, pred, out); return out }
  if (typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  collectIn(node.children, pred, out)
  return out
}
const hasAttr = (name) => (n) => Object.prototype.hasOwnProperty.call(n.props ?? {}, name)
{
  const page = renderRoot('首页（有撤掉的卡）', base('home', { 2: { ...LISTING, withdrawn: GONE_ITEMS } }))
  const pageTree = expand(page)
  const pageText = textIn(pageTree)
  t('有撤掉的卡时首页有这一栏', pageText.includes('已经撤掉的'), pageText.slice(0, 300))
  t('这一栏标题带张数', pageText.includes('已经撤掉的 · 2'), pageText.slice(0, 300))
  t('这一栏说清「看不见，但原文还在」', pageText.includes('看不见，但原文还在'), pageText.slice(0, 300))
  t('默认收着，不先铺开两个按钮', !pageText.includes('放回来') && !pageText.includes('彻底删掉'), pageText.slice(0, 300))

  const none = renderRoot('首页（没有撤掉的卡）', base('home'))
  t('没有撤掉的卡时这一栏整块不出现', !textIn(expand(none)).includes('已经撤掉的'), '')

  t('撤掉的卡有独立的渲染块', seen.has('WithdrawnSection'), [...seen.keys()].includes('WithdrawnSection'))
  const open = renderOne('撤掉的卡（展开）', seen.get('WithdrawnSection'), {
    items: GONE_ITEMS, open: true, onToggle: () => {}, onRestore: () => {}, onPurge: () => {},
  })
  const openTree = expand(open)
  const openText = textIn(openTree)
  t('展开后一条一行', collectIn(openTree, hasAttr('data-withdrawn-row')).length === 2, openText.slice(0, 300))
  t('每条都有「放回来」', collectIn(openTree, hasAttr('data-withdrawn-restore')).length === 2, openText.slice(0, 300))
  t('每条都有「彻底删掉」', collectIn(openTree, hasAttr('data-withdrawn-purge')).length === 2, openText.slice(0, 300))
  t('展开后按钮写着「收起」', openText.includes('收起'), openText.slice(0, 300))
  t('撤掉的卡都画出了名字', openText.includes('老周') && openText.includes('小满'), openText.slice(0, 300))
  t('展开后说清两条路各是什么', openText.includes('回到上面的列表') && openText.includes('删了就真没了'), openText.slice(0, 400))
  t('这一块不露路径和后缀', !openText.includes('.card.md') && !openText.includes('cards/') && !openText.includes('/tmp/'), openText.slice(0, 300))
  t('这一块不说「撤回」', !openText.includes('撤回'), openText.slice(0, 300))

  const shut = renderOne('撤掉的卡（收着）', seen.get('WithdrawnSection'), {
    items: GONE_ITEMS, open: false, onToggle: () => {}, onRestore: () => {}, onPurge: () => {},
  })
  const shutTree = expand(shut)
  t('只给「展开」不给按钮', textIn(shutTree).includes('展开') && collectIn(shutTree, hasAttr('data-withdrawn-restore')).length === 0, textIn(shutTree).slice(0, 200))
  t('空列表时整块不画', seen.get('WithdrawnSection')({ items: [], open: true }) === null, '')
}

renderRoot('首页（空）', base('home', { 2: { ok: true, cards: [], materials: [], proposals: [], worlds: [], errors: [] } }))
renderRoot('首页（展开更多工具）', base('home', { 10: true }))
renderRoot('记忆（从首页进来）', base('memory'))
renderRoot('下一步（从首页进来）', base('jobs'))

// ── 第一次打开时那段简短介绍 ────────────────────────────────────
// 只出现一次。写长了没人读，所以这里连内容一起钉住。
// hook 槽 13 = introSeen：null 还不知道 / true 看过了 / false 该介绍
{
  const before = visibleText.length
  renderRoot('首页（第一次打开）', base('home', { 13: false }))
  const joined = visibleText.slice(before).join('|')
  t('第一次打开有介绍', joined.includes('这是做什么的'), joined.slice(0, 160))
  t('介绍说清了要写什么', joined.includes('他做过什么'))
  t('介绍说了两种开始方式', joined.includes('边聊边建') && joined.includes('拖进来'))
  t('介绍说清了卡存在自己选的文件夹里', joined.includes('纯文本'))
  t('介绍末尾有个「知道了」', joined.includes('知道了'))
  const seenBefore = visibleText.length
  renderRoot('首页（介绍看过了）', base('home', { 13: true }))
  const gone = visibleText.slice(seenBefore).join('|')
  t('看过之后这段不再出现', !gone.includes('这是做什么的'), gone.slice(0, 160))
  const emptyBefore = visibleText.length
  renderRoot('首页（空库第一次打开）', base('home', { 2: { ok: true, cards: [], materials: [], proposals: [], worlds: [], errors: [] }, 13: false }))
  const emptyJoined = visibleText.slice(emptyBefore).join('|')
  t('库里什么都没有的时候也先介绍一遍', emptyJoined.includes('这是做什么的'))
}

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
/** 数一棵纯 DOM 树里有几个「带照片的头像方块」。 */
function countPhotos(tree) {
  if (tree === null || tree === undefined) return 0
  if (Array.isArray(tree)) return tree.reduce((acc, n) => acc + countPhotos(n), 0)
  if (typeof tree !== 'object') return 0
  const own = tree.type === 'div' && String(tree.props?.className ?? '').includes('has-photo') ? 1 : 0
  return own + countPhotos(tree.children)
}
const flatInputs = (tree, out = []) => {
  if (tree === null || tree === undefined) return out
  if (Array.isArray(tree)) { for (const n of tree) flatInputs(n, out); return out }
  if (typeof tree !== 'object') return out
  if (tree.type === 'input') out.push(tree)
  flatInputs(tree.children, out)
  return out
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

await (async () => {
  // 首页点「聊一聊」：不再进插件里的访谈页，改成开一个新会话，
  // 输入框里摆好 skill 和一句意图（后端宿主负责真开，这里记调用）。
  const tree = renderRoot('首页（点聊一聊）', base('home', { 9: { id: 'mama', name: '妈妈' } }))
  const before = SESSIONS.length
  const clicked = clickByText(tree, '聊一聊')
  // 现在是异步的：先让后台建会话，再断言「开了哪一场」。
  await new Promise((r) => setTimeout(r, 30))
  const session = SESSIONS[before] ?? {}
  t('首页「聊一聊」点得动', clicked === true)
  t('点「聊一聊」不再切到插件里的访谈页', hookStore[0] !== 'interview', String(hookStore[0]))
  t('点「聊一聊」开了一个新会话', SESSIONS.length === before + 1, JSON.stringify(SESSIONS.slice(-2)))
  t('新会话里带着访谈那个 skill', String(session.prompt ?? '').includes('/lifecard-interview'), JSON.stringify(session))
  t('首页用的是真实人物那套预设', session.agentPreset === 'lc-real', String(session.agentPreset))
  t('首页不带某个人进去问', !String(session.prompt ?? '').includes('妈妈'), JSON.stringify(session))
  const homeWords = textIn(expand(tree))
  t('界面上说清是在新对话里问', homeWords.includes('会在新对话里问'), homeWords.slice(0, 300))
})();
await (async () => {
  // 卡片页上补信息：新会话得知道「补哪一张」，不然第一句还得问我是谁。
  const tree = renderRoot('卡片详情（想补信息）', base('card', { 6: CARD_DETAIL }))
  const before = SESSIONS.length
  const clicked = clickByText(tree, '聊一聊')
  // 现在是异步的：先让后台建会话，再断言「开了哪一场」。
  await new Promise((r) => setTimeout(r, 30))
  const session = SESSIONS[before] ?? {}
  t('卡片页「聊一聊」点得动', clicked === true)
  t('卡片页点完不切到插件里的访谈页', hookStore[0] !== 'interview', String(hookStore[0]))
  t('卡片页点完开了一个新会话', SESSIONS.length === before + 1, JSON.stringify(SESSIONS.slice(-2)))
  t('新会话带上了这张卡的名字', String(session.prompt ?? '').includes('妈妈'), JSON.stringify(session))
  t('新会话里带着访谈那个 skill', String(session.prompt ?? '').includes('/lifecard-interview'), JSON.stringify(session))
  const cardWords = textIn(expand(tree))
  t('卡片页说清会在新对话里问', cardWords.includes('会在新对话里问'), cardWords.slice(0, 300))
  t('卡片页的按钮上写着「新开一个对话」', cardWords.includes('聊一聊（新开一个对话）'), cardWords.slice(0, 300))
})();

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
{
  // 有好几张卡的时候不许偷偷选第一张：没留意就点「开始读」，
  // 材料会整理到别人卡上。
  const before = visibleText.length
  renderRoot('让 AI 读材料（还没选人）', base('analyze'))
  const joined = visibleText.slice(before).join('|')
  t('有好几张卡时先让人自己选', joined.includes('先选一个人'), joined.slice(0, 200))
  t('说了为什么要自己选', joined.includes('免得材料整理到别人卡上'), joined.slice(0, 200))
}

// 刚存完一段文字、那个人还没有卡：「让 AI 读一读」不能跳过去就断了线。
// 以前这两头是分开的——按钮不传人，父层也不记人，到了分析页「整理谁」是空的，
// 用户得在一张空选择框里自己再想一遍刚才写的是谁。
{
  const flatSelects = (tree, out = []) => {
    if (tree === null || tree === undefined) return out
    if (Array.isArray(tree)) { for (const n of tree) flatSelects(n, out); return out }
    if (typeof tree !== 'object') return out
    if (tree.type === 'select') out.push(tree)
    flatSelects(tree.children, out)
    return out
  }

  // TextImport 只在「一段文字」那一页才出现，先把它渲染出来登记一下
  // TextImport 只在「一段文字」那一页才出现：把 ImportView 本身按那页渲染一次，登记一下
  renderOne('添加（一段文字）', seen.get('ImportView'), { busy: '', listing: LISTING, onImport: () => {}, onAnalyze: () => {} }, { 1: 'text' })

  let got = null
  const saved = renderOne('添加（一段文字，刚存好了）', seen.get('TextImport'), { onAnalyze: (x) => { got = x } }, {
    0: '爷爷', 1: '', 2: false,
    3: { tone: 'ok', text: '存好了（120 字）。', path: 'materials/2026-10-24-爷爷.md' },
  })
  t('存完之后有「让 AI 读一读」', clickByText(saved, '让 AI 读一读'))
  t('带过去的是刚存的那个人', got !== null && got.name === '爷爷', JSON.stringify(got))
  t('也带上了刚存的那份材料', got !== null && got.path === 'materials/2026-10-24-爷爷.md', JSON.stringify(got))

  const before = visibleText.length
  const tree = renderRoot('让 AI 读材料（那个人还没有卡）', base('analyze', { 9: { name: '爷爷' } }))
  const joined = visibleText.slice(before).join('|')
  t('只有名字也能直接开始读', joined.includes('爷爷'), joined.slice(0, 200))
  t('说清楚会先进建议、不是写进空卡', joined.includes('先放进「建议」'), joined.slice(0, 300))
  t('选择框里选中的就是这个人', flatSelects(expand(tree)).some((sel) => sel.props?.value === '爷爷'), JSON.stringify(flatSelects(expand(tree)).map((x) => x.props?.value)))
  t('还是能开始读（按钮没被禁用）', flatButtons(expand(tree)).some((b) => textOf(b).includes('开始读') && b.props.disabled !== true))
}

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
function findNodes(node, pred, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const item of node) findNodes(item, pred, out); return out }
  if (pred(node)) out.push(node)
  if (node.children !== undefined) findNodes(node.children, pred, out)
  return out
}

renderRoot('陪他聊聊', base('interview'))
renderRoot('陪他聊聊（从卡片进来）', base('interview', { 9: { id: 'mama', name: '妈妈', relationLabel: '母亲' } }))
// 「还有什么」点开之后的样子：收起时只是一行灰字，摊开才有输入框。
// InterviewView 的 hook 槽：0 phase / 1 name / 2 relation / 3 customRelation / 4 showExtras / 5 extrasText
renderOne('陪他聊聊（把「还有什么」点开了）', seen.get('InterviewView'), { state: STATE, listing: LISTING }, { 0: 'pick', 4: true })
renderOne('陪他聊聊（已经在横线里写了爷爷）', seen.get('InterviewView'), { state: STATE, listing: LISTING }, { 0: 'pick', 3: '爷爷' })
{
  // 「结束这次访谈」（以前叫「今天到这」）挤在「跳过 / 不想说」旁边，
  // 手一滑整场就结束、输入框里写了半页的话跟着丢，结束页还说「你说的都记下来了」。
  // 现在：稿子非空先问一句；问了不该没人敢继续，所以「不结束」要真的不结束。
  // InterviewView 的 hook 槽（续上）：6 customFocus / 7 plan / 8 queue / 9 current /
  // 10 answer / 11 log / 12 busy / 13 err / 14 aboutId / 15 dropped / 16 ref
  const Q = { id: 'cooking-1', ask: '你妈做饭的时候有什么固定动作？', options: ['先把菜全切好'], fills: ['habit'] }
  {
    // 答题时屏幕上必须看得见「这一题问的是什么」。
    // 以前问题只写进日志气泡，而气泡是答完才追加的 —— 用户在答第 N 题时，
    // 屏幕上最后一条还是第 N-1 题，写什么都像在答上一题。
    const live = renderOne('陪他聊聊（这一题的问题看得见）', seen.get('InterviewView'), { state: STATE, listing: LISTING }, { 0: 'talk', 9: Q, 10: '' })
    const askNodes = findNodes(live, (n) => n.props?.['data-current-ask'] !== undefined)
    t('答题时显示这一题的问题', askNodes.length === 1 && textOf(askNodes[0]).includes('有什么固定动作'), String(askNodes.length))

    // 上一题的选项只是回看用：它们不能再点，否则会把答案填进「这一题」。
    const cur = renderOne('陪他聊聊（带着上一题的记录）', seen.get('InterviewView'), { state: STATE, listing: LISTING }, {
      0: 'talk', 9: Q, 10: '',
      11: [{ role: 'bot', text: '你妈说话声音大吗？', options: ['大', '不大'] }, { role: 'me', text: '大' }],
    })
    const past = findNodes(cur, (n) => n.props?.['data-past-option'] === 'yes')
    t('上一题的选项留着但点不动', past.length === 2 && past.every((n) => typeof n.props.onClick !== 'function'), String(past.length))

    // 记完这一题、下一组问题没要到：错误提示旁边要有一个真的能点的「再问一题」。
    const stuck = renderOne('陪他聊聊（下一组问题没要到）', seen.get('InterviewView'), { state: STATE, listing: LISTING }, {
      0: 'talk', 8: [], 9: Q, 10: '', 12: false, 13: '刚才那一句已经记下了，这里是没接上',
    })
    const retry = flatButtons(expand(stuck)).find((b) => textOf(b).includes('再问一题'))
    t('没要到下一组问题时给一个能点的「再问一题」', retry !== undefined && typeof retry.props.onClick === 'function')
  }

  const asked = []
  const realConfirm = fakeWindow.confirm
  fakeWindow.confirm = (msg) => { asked.push(String(msg)); return false }
  const tree = renderOne('陪他聊聊（写了半句还没点记下）', seen.get('InterviewView'), { state: STATE, listing: LISTING }, { 0: 'talk', 9: Q, 10: '她喜欢先把菜都切好再下锅' })
  const clicked = clickByText(tree, '结束这次访谈')
  t('访谈页的「结束这次访谈」点得动', clicked === true)
  t('有没记下的话时，结束会先问一句', asked.length === 1 && asked[0].includes('记下'), JSON.stringify(asked))
  t('问了之后回答「先不结束」就留在这一题', hookStore[0] === 'talk', String(hookStore[0]))
  fakeWindow.confirm = (msg) => { asked.push(String(msg)); return true }
  clickByText(tree, '结束这次访谈')
  t('确认结束才走到结束页', hookStore[0] === 'done', String(hookStore[0]))
  t('结束页知道刚才那一题没存进去', hookStore[15] === true, String(hookStore[15]))
  fakeWindow.confirm = realConfirm
  // 结束页不能一边丢了稿子一边说「你说的都记下来了」。
  const before = visibleText.length
  renderOne('陪他聊聊（结束页：刚才那题没记下）', seen.get('InterviewView'), { state: STATE, listing: LISTING },
    { 0: 'done', 7: { coverage: 62, empty: ['口癖', '不会做的事'] }, 15: true })
  const joined = visibleText.slice(before).join('|')
  t('结束页照实说那一题没存进去', joined.includes('没有存进去'), joined.slice(0, 240))
  t('结束页不再说「你说的都记下来了」', !joined.includes('都记下来了'), joined.slice(0, 240))
  const before2 = visibleText.length
  renderOne('陪他聊聊（结束页：都记下了）', seen.get('InterviewView'), { state: STATE, listing: LISTING },
    { 0: 'done', 7: { coverage: 62, empty: ['口癖', '不会做的事'] }, 15: false })
  const joined2 = visibleText.slice(before2).join('|')
  t('正常结束还是说「都记下来了」', joined2.includes('都记下来了'), joined2.slice(0, 240))
  t('正常结束会列出还空着什么', joined2.includes('口癖'), joined2.slice(0, 240))
}
// 「开始聊」按下去这一下：卡会不会被悄悄改掉 / 空卡会不会留下来。
// 这两件事都只在请求失败或重名的时候才现形，静态渲染看不出来，所以要把
// 按钮真的点一次、等 Promise 落地，再把发出去的请求对一遍。
{
  const realFetch = globalThis.fetch
  const realConfirm = fakeWindow.confirm
  const swap = (handler) => { globalThis.fetch = handler }
  const wait = () => new Promise((r) => setTimeout(r, 30))

  // ① 问题没准备出来（AI 那边不响应）：刚建的空卡要收回去
  {
    const calls = []
    swap(async (url, opts = {}) => {
      calls.push({ url: String(url), body: JSON.parse(opts.body ?? '{}') })
      if (String(url).includes('interview.plan')) return { ok: true, status: 200, json: async () => ({ ok: false, error: 'AI 那边没响应' }) }
      if (String(url).includes('card.save')) return { ok: true, status: 200, json: async () => ({ ok: true, path: 'cards/wang-shu.card.md' }) }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    })
    const tree = renderOne('陪他聊聊（问题没准备出来）', seen.get('InterviewView'),
      { state: STATE, listing: { ...LISTING, cards: [] }, preset: null, onRecorded: () => {}, flash: () => {}, onDone: () => {}, onAnalyze: () => {} },
      { 0: 'pick', 1: '王叔' })
    t('点得到「开始聊」', clickByText(tree, '开始聊'))
    await wait()
    // 这里必须走「收走一张刚建的空卡」那条路，不能走「删除」：删除会写墓碑、
    // 占住名字，用户紧接着换个名字重来就会撞上「这个名字被一张删掉的卡占着」。
    const del = calls.filter((c) => c.url.includes('card.discard') || c.url.includes('card.delete'))
    t('问题没准备出来时把刚建的空卡收走了', del.length === 1 && del[0].body.path === 'cards/wang-shu.card.md', JSON.stringify(calls.map((c) => c.url)))
    t('收走的是刚建的空卡，不是删一张真卡', del.length === 1 && del[0].url.includes('card.discard'), JSON.stringify(calls.map((c) => c.url)))
    const said = hookStore.filter((v) => typeof v === 'string').join(' | ')
    t('撤卡时告诉用户那张空卡去哪了', said.includes('撤掉'), said.slice(0, 300))
  }

  // ② 名字撞上已有的卡：要么先问一句，要么不许动旧卡上已经写过的关系
  {
    const calls = []
    const asks = []
    fakeWindow.confirm = (msg) => { asks.push(String(msg)); return true }
    swap(async (url, opts = {}) => {
      calls.push({ url: String(url), body: JSON.parse(opts.body ?? '{}') })
      if (String(url).includes('card.get')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, path: 'cards/mama.card.md', data: { id: 'mama', name: '妈妈', relation: '母亲' }, sections: [] }) }
      }
      if (String(url).includes('interview.plan')) return { ok: true, status: 200, json: async () => ({ ok: true, next: [], coverage: { percent: 0, empty: [] } }) }
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    })
    const tree = renderOne('陪他聊聊（名字撞上已有的卡）', seen.get('InterviewView'),
      { state: STATE, listing: LISTING, preset: null, onRecorded: () => {}, flash: () => {}, onDone: () => {}, onAnalyze: () => {} },
      { 0: 'pick', 1: '妈妈', 2: 'father' })
    t('点得到「开始聊」', clickByText(tree, '开始聊'))
    await wait()
    t('名字撞上了会先问一句', asks.length === 1 && asks[0].includes('已经有一张'), JSON.stringify(asks))
    const save = calls.filter((c) => c.url.includes('card.save'))
    t('旧卡上写着的关系没被这次点的改掉', save.length === 1 && save[0].body.data.relation === '母亲', JSON.stringify(save.map((c) => c.body.data?.relation)))
  }

  // ③ 名字撞上了但用户点了「取消」：什么都不该写
  {
    const calls = []
    fakeWindow.confirm = () => false
    swap(async (url, opts = {}) => {
      calls.push({ url: String(url), body: JSON.parse(opts.body ?? '{}') })
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    })
    const tree = renderOne('陪他聊聊（重名但说要换名字）', seen.get('InterviewView'),
      { state: STATE, listing: LISTING, preset: null, onRecorded: () => {}, flash: () => {}, onDone: () => {}, onAnalyze: () => {} },
      { 0: 'pick', 1: '妈妈' })
    clickByText(tree, '开始聊')
    await wait()
    t('说不换了就一个请求都不发', calls.length === 0, JSON.stringify(calls.map((c) => c.url)))
  }

  fakeWindow.confirm = realConfirm
  swap(realFetch)
}

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
    // 「下一步」这一页以前没进这个清单：招聘说明没填、点评没跑、投递表空的时候，
    // 里面有几处按钮是画出来但点不动的。
    ['下一步', base('jobs')],
    ['下一步（看过一份工作）', base('jobs', { 4: {
      ok: true, company: '某公司', role: '后端', score: 72, blocked: [], gaps: [],
      rows: [{ index: 0, requirement: '会 Go', importance: 'high', verdict: 'match', proof: '写了三年 Go' }],
      dealbreakers: [], warnings: [], dropped: [], questions: [], at: '2026-10-23 10:00',
    }, 14: false })],
    ['从记忆里认人', base('memory')],
    ['以前的样子', base('card', { 6: CARD_DETAIL })],
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
    onStartInterview: () => {}, onAnalyze: () => {},
  }, { 0: true })
}

// CardView 的红点：卡片是从记忆里认出来的、记忆里只写了半句时，
// 名字旁边要挂「还缺 N 样」。挂错（不缺点也挂）等于没挂。
if (seen.has('CardView')) {
  const tree = renderOne('卡片详情（从记忆来的、还缺东西）', seen.get('CardView'), {
    card: CARD_DETAIL, proposal: null, setProposal: () => {}, flash: () => {},
    onRefresh: async () => {}, onDeleted: async () => {},
    onStartInterview: () => {}, onAnalyze: () => {},
  }, { 5: { ok: true, from_memory: true, missing: ['名字', '出生时间'], flag: true } })
  const text = JSON.stringify(expand(tree))
  t('红点说出了还缺几样', text.includes('还缺 2 样'))
  t('红点解释了这几样是哪来的', text.includes('聊一聊'))
}

// CardView 的 hook 槽：0 editing / 1 busy / 2 err / 3 showExport / 4 showHistory / 5 memFlag
if (seen.has('CardView')) {
  renderOne('卡片详情（历史展开）', seen.get('CardView'), {
    card: CARD_DETAIL, proposal: null, setProposal: () => {}, flash: () => {},
    onRefresh: async () => {}, onDeleted: async () => {},
    onStartInterview: () => {}, onAnalyze: () => {},
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

if (seen.has('ProposalPanel')) {
  // 用户报的：采纳过的条目还留在列表里，看着像没生效，再点一次就把同一段话
  // 又写进卡里（「关系史复制成两段」）。这里断言写进去过的不再出现。
  const ADOPTED = {
    json: 'proposals/p3.json',
    about: { id: 'jia', name: '建国' },
    items: [
      { index: 0, field: '关系史', value: '那年冬天他一个人去了南方。', checked: false, adopted: true },
      { index: 1, field: '性格', value: '话少，但答应了就一定做。', checked: false },
    ],
    rejected: [],
    md: 'proposals/p3.md',
  }
  const from = visibleText.length
  renderOne('建议面板（有一条已经写进过卡）', seen.get('ProposalPanel'), { proposal: ADOPTED, onClose: () => {}, onApplied: async () => {} })
  const text = visibleText.slice(from).join('\n')
  t('写进过卡的那条不再列出来', !text.includes('那年冬天他一个人去了南方'), text)
  t('还没写的那条照样列出来', text.includes('话少，但答应了就一定做'), text)
  t('说了有几条已经写进去了', text.includes('1 条之前已经写进卡了'), text)
  // 用户报的：「都不要」等于什么都没发生，那份建议一直占着首页的位置。
  // 现在这一下要真把整份从待办里撤掉，所以它不能长得像「关掉」。
  t('「都不要」是一个真动作，不是关窗口', text.includes('都不要'), text)
  t('「都不要」不用「关闭 / 收起」这种说法', !/关掉这份|收起建议|关闭建议/.test(text), text)
}

if (seen.has('ProposalPanel')) {
  // 旧版把对象值 JSON.stringify 上屏：knows: ["榫卯"]；does_not_know: []
  // 英文程度 expert 也直接露出来。这里用真实形状断言说人话。
  const from = visibleText.length
  renderOne('建议面板（对象值说人话）', seen.get('ProposalPanel'), { proposal: PROPOSAL_OBJECTS, onClose: () => {}, onApplied: async () => {} })
  const text = visibleText.slice(from).join('\n')
  t('knowledge 说成「知道 / 不知道」', /知道：榫卯/.test(text) && /不知道：电路/.test(text), text)
  t('address 说成「他叫你 / 你叫他」', /他叫你：老张/.test(text) && /你叫他：张叔/.test(text), text)
  t('life 说成「吃 / 身体」', /吃：清淡/.test(text) && /身体：腿不好/.test(text), text)
  t('competency 的等级是中文', /做红烧肉：精通/.test(text), text)
  t('对象值不再抖出字段名 / JSON / 英文等级', !/knows|does_not_know|them_to_me|me_to_them|JSON|expert/.test(text), text)
}

if (seen.has('ProposalPanel')) {
  // 被丢掉的条目现在有两种原因：引文对不上，或者和前面那条重复。以前界面
  // 一律说「在材料里找不到原话 / AI 编的东西进不来」，于是用户明明说过的话
  // 被当成模型瞎编——重复的事实反而被说成了不存在的证据。
  const DUP_ONLY = {
    json: 'proposals/p4.json',
    about: { id: 'mama', name: '妈妈' },
    items: [],
    rejected: [
      { item: { field: 'tags', value: '家人' }, reason: '和前面那条重复' },
      { item: { field: '自述', value: '她每天下午四点做饭。' }, reason: '和后面那条重复，只留了长的' },
    ],
    md: 'proposals/p4.md',
  }
  const from = visibleText.length
  renderOne('建议面板（丢掉的都是重复的）', seen.get('ProposalPanel'), { proposal: DUP_ONLY, onClose: () => {}, onApplied: async () => {} })
  const text = visibleText.slice(from).join('\n')
  t('丢掉的全是重复时说「重复」', text.includes('重复'), text)
  t('不再把重复说成 AI 编的', !text.includes('AI 编'), text)
  t('不再一律说「找不到原话」', !text.includes('找不到原话'), text)
  t('说清重复的两条是怎么处理的', text.includes('只留了一条') || text.includes('只留了长的'), text)
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

if (seen.has('MemoryView')) {
  // 记忆页有三种状态：还没读到 / 记忆里没人 / 认出了一堆人。
  // 第三种最容易出事：每个人的红点挂错了，用户会以为这张卡已经能用了。
  const MEM_PEOPLE = {
    ok: true, found: true, files: 2, chars: 5823,
    people: [
      { kin: '父亲', name: '张三', bank: 'parent', lines: ['父亲＝张三，1970 年生，在 XXXX 公司上班。'], clues: ['父亲＝张三，1970 年生，在 XXXX 公司上班。'], missing: [] },
      { kin: '母亲', name: '', bank: 'parent', lines: ['母亲在 YYYY 公司上班。'], clues: ['母亲在 YYYY 公司上班。'], missing: ['名字', '出生时间'] },
    ],
  }
  renderOne('记忆（还没读到）', seen.get('MemoryView'), { onBack: () => {}, onDone: () => {} }, { 0: null, 1: null })
  renderOne('记忆（认出两个人）', seen.get('MemoryView'), { onBack: () => {}, onDone: () => {} }, { 0: MEM_PEOPLE, 1: ['父亲:张三', '母亲'] })
  renderOne('记忆（这台电脑没有记忆）', seen.get('MemoryView'), { onBack: () => {}, onDone: () => {} }, {
    0: { ok: true, found: false, people: [], reason: '这台电脑上没有找到记忆文件。' }, 1: [],
  })
  const tree = renderOne('记忆（一个都没认出来）', seen.get('MemoryView'), { onBack: () => {}, onDone: () => {} }, {
    0: { ok: true, found: true, files: 1, chars: 200, people: [] }, 1: [],
  })
  t('记忆页说得清「一个都没认出来」', tree !== null && JSON.stringify(expand(tree)).includes('没有提到具体的人'))

  // 存完材料之后那一栏。
  // 没有它用户点完「存成材料」就断了线：不知道存哪了、也不知道下一步该点谁。
  const MADE = [{
    key: '父亲:张三', id: 'zhangsan', name: '张三', kin: '父亲', label: '张三',
    path: 'materials/2026-10-22-记忆-张三.md', missing: [],
  }, {
    key: '母亲', id: '母亲', name: '', kin: '母亲', label: '母亲',
    path: 'materials/2026-10-22-记忆-母亲.md', missing: ['名字', '出生时间'],
  }]
  const madeTree = renderOne('记忆（存完材料之后）', seen.get('MemoryView'), { onBack: () => {}, onDone: () => {} }, {
    0: MEM_PEOPLE, 1: ['父亲:张三', '母亲'], 2: false, 3: null,
    4: { tone: 'ok', text: '存好了，一人一份，共 2 份。' }, 5: MADE,
  })
  const madeText = madeTree === null ? '' : JSON.stringify(expand(madeTree))
  t('存完材料后列出每个人', madeText.includes('张三') && madeText.includes('母亲'), madeText.slice(0, 300))
  t('每个人后面有「让 AI 读」的按钮', madeText.includes('让 AI 读'), madeText.slice(0, 300))
  t('说清下一步是挑一个人', madeText.includes('挑一个人'), madeText.slice(0, 300))
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
  // 列表里的头像：头像存在 assets/ 里、不在卡文件里，所以是列表额外带回来的。
  // 这条断言锁住「带回来了要真的画出来」——之前 avatar.list 早就存在，
  // 但列表从来没用过它，用户看到的永远是首字方块。
  const withPhotoRaw = renderOne('列表行（有头像）', seen.get('CardRow'), {
    card: LISTING.cards[0], onOpen: () => {}, photo: 'iVBORw0KGgo=',
  })
  // CardRow 内部还有 Avatar 这个函数组件，得先就地展开才看得到真正的 <img>。
  const withPhoto = expand(withPhotoRaw)
  const photoImg = (function find(node) {
    if (node === null || node === undefined) return null
    if (Array.isArray(node)) { for (const n of node) { const hit = find(n); if (hit !== null) return hit } return null }
    if (typeof node !== 'object') return null
    if (node.type === 'img') return node
    return find(node.children)
  })(withPhoto)
  t('列表行有头像时画出的是图片', photoImg !== null && String(photoImg.props?.src ?? '').includes('base64'))
  // 光「单独渲染 CardRow 能画头像」不够——列表得真的把 foto 传下来。
  // 首页整棵树里有几个 has-photo 方块，就说明有几行拿到了头像。
  const homeTree = expand(renderRoot('首页（带头像）', base('home')))
  t('首页整棵树里真的画出了头像', countPhotos(homeTree) >= 1, countPhotos(homeTree))
  t('列表行有头像时不再画首字', (function find(node) {
    if (node === null || node === undefined) return false
    if (Array.isArray(node)) return node.some(find)
    if (typeof node !== 'object') return false
    if (node.type === 'div' && String(node.props?.className ?? '').includes('has-photo')) return true
    return find(node.children)
  })(withPhoto))
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

// ── 下一步（求职 / 面试 / 简历） ─────────────────────────────────
// 求职页最容易犯的错是「报喜不报忧」：把匹配的列一堆，把挡住的藏在最后。
// 这里的断言按屏幕上出现的先后顺序核对。
{
  const before = visibleText.length
  renderRoot('下一步（空表单）', base('jobs'))
  const joined = visibleText.slice(before).join('|')
  t('求职页有招聘说明输入框', joined.includes('招聘说明'), joined.slice(0, 200))
  t('求职页说清了要贴整段', joined.includes('整段'))
  t('求职页的按钮说的是看工作', joined.includes('看看这份工作'))
  // 这个入口叫「下一步」，不叫「看工作」——它管的不只是找工作
  const homeBefore = visibleText.length
  renderRoot('首页（有下一步入口）', base('home'))
  const homeJoined = visibleText.slice(homeBefore).join('|')
  t('首页那个入口叫「下一步」', homeJoined.includes('下一步'), homeJoined.slice(0, 200))
  t('首页不再叫「看工作」', !homeJoined.includes('看工作'))
  t('求职设置默认收起', joined.includes('你想找什么样的工作'))
  t('求职页不出现投递按钮', !joined.includes('一键投递') && !joined.includes('自动投递'))
}
{
  const REPORT = {
    company: '某公司',
    role: '后端工程师',
    path: 'jobs/evaluations/2026-10-20-某公司-后端工程师.md',
    dealbreakers: [{ word: '加班', line: '能适应高强度加班节奏。' }],
    blocked: [{ index: 0, requirement: '5 年以上 Java 开发经验', importance: 'critical', jd_quote: '5 年以上 Java 开发经验', proof: '', verdict: 'gap' }],
    matched: [{ index: 1, requirement: '后端开发', proof: '我做过后端开发', verdict: 'match' }],
    gaps: [{ index: 0, requirement: '5 年以上 Java 开发经验', importance: 'critical' }, { index: 2, requirement: '分布式经验', importance: 'medium' }],
    unclear: [{ index: 3, requirement: '带过团队' }],
    questions: ['团队现在多少人？'],
    warnings: ['招聘说明里有一句像在给程序下命令的话。'],
    dropped: ['「会 Go」的引文在招聘说明里找不到，丢了。'],
  }
  // 报告组件只有「读过一份 JD」之后才出现在树上，所以要先把 JobsView
  // 推到有报告的那一格，让它把 JobReport 交给 seen。
  renderOne('下一步（已经读过一份）', seen.get('JobsView'), { onBack: () => {}, flash: () => {} }, { 4: REPORT })
  const before = visibleText.length
  const tree = renderOne('求职报告（有挡住的也有对得上的）', seen.get('JobReport'), { report: REPORT })
  const joined = visibleText.slice(before).join('|')
  t('报告页渲染出来了', tree !== null)
  t('报告里有不能接受那条', joined.includes('你写过不能接受这个'))
  t('报告里有挡住的', joined.includes('硬要求没对上'))
  t('报告里有对得上的', joined.includes('拿得出来的'))
  t('报告里有看不出来的', joined.includes('材料里看不出来'))
  t('报告里有该问的问题', joined.includes('面试前该问清楚'))
  t('报告里有丢掉的那段', joined.includes('丢掉的'))
  t('报告页不出现「投」这种诱导', !joined.includes('建议投递'))

  // 报告没能存进文件夹时，最上面要说清楚。以前这种情况接口照样返回成功、
  // 只是没有 path，界面上什么都不显示，用户以为已经归档了。
  const noSave = visibleText.length
  renderOne('求职报告（没存进文件夹）', seen.get('JobReport'), {
    report: { ...REPORT, path: undefined, saveFail: '这份报告没能存进文件夹（磁盘满了）。现在它只在屏幕上，翻篇就没了——先把下面这段复制走。' },
  })
  const joinedNoSave = visibleText.slice(noSave).join('|')
  t('没存进文件夹时报告最上面会说', joinedNoSave.includes('没能存进文件夹'))
  t('没存进文件夹时不会说「已经存下来了」', !joinedNoSave.includes('已经存下来了'))
  t('没存进文件夹时报告内容还在', joinedNoSave.includes('硬要求没对上'))

  // 顺序：一票否决在最前，其次挡住，最后才是对得上的
  const iDeal = joined.indexOf('你写过不能接受这个')
  const iBlock = joined.indexOf('硬要求没对上')
  const iMatch = joined.indexOf('拿得出来的')
  t('一票否决排在挡住之前', iDeal >= 0 && iDeal < iBlock)
  t('挡住排在对得上之前', iBlock >= 0 && iBlock < iMatch)
}
{
  // 「这家公司我认识谁」是这一页独有的东西，按钮和结果都得真的出得来
  const before = visibleText.length
  renderOne('下一步（报告之后能问认识谁）', seen.get('JobsView'), { onBack: () => {}, flash: () => {} }, {
    4: { company: '某公司', role: '后端', blocked: [], matched: [], gaps: [], unclear: [], questions: [], warnings: [], dropped: [] },
  })
  const joined = visibleText.slice(before).join('|')
  t('报告下面有「认识谁」这个按钮', joined.includes('我认识这家公司的人吗'))
  t('这一块没有替人决定要不要去问', !joined.includes('快去联系'))
}
{
  const before = visibleText.length
  renderOne('下一步（认识的谁查出来了）', seen.get('JobsView'), { onBack: () => {}, flash: () => {} }, {
    4: { company: '某公司', role: '后端', blocked: [], matched: [], gaps: [], unclear: [], questions: [], warnings: [], dropped: [] },
    12: { ok: true, company: '某公司', hits: [{ path: 'people/baba.card.md', name: '爸爸', relation: '父亲', field: '地址', line: 'XXXX 公司' }] },
  })
  const joined = visibleText.slice(before).join('|')
  t('认识的人显示出来了', joined.includes('爸爸'))
  t('带着那句原话', joined.includes('XXXX 公司'))
  t('说了这是原话、决定权在人', joined.includes('你自己定'))
}
{
  const before = visibleText.length
  renderOne('下一步（没人提到这家公司）', seen.get('JobsView'), { onBack: () => {}, flash: () => {} }, {
    4: { company: '某公司', role: '后端', blocked: [], matched: [], gaps: [], unclear: [], questions: [], warnings: [], dropped: [] },
    12: { ok: true, company: '某公司', hits: [] },
  })
  const joined = visibleText.slice(before).join('|')
  t('没人提到时说的是「没写下来」不是「没门路」', joined.includes('不代表你没门路'))
}
{
  // 投递表：展开前只看到一个「我的投递」和条数；展开后才见行
  const before = visibleText.length
  renderOne('下一步（投递表收起）', seen.get('JobsView'), { onBack: () => {}, flash: () => {} }, { 15: false, 16: [] })
  const joined = visibleText.slice(before).join('|')
  t('投递表默认收起但看得见入口', joined.includes('我的投递'))
  t('没有记录时说「还没记」', joined.includes('还没记'))

  const before2 = visibleText.length
  renderOne('下一步（投递表展开）', seen.get('JobsView'), { onBack: () => {}, flash: () => {} }, {
    15: true,
    16: [{ date: '2026-10-20', company: '某公司', role: '后端', status: 'applied', note: '内推' }],
  })
  const joined2 = visibleText.slice(before2).join('|')
  t('展开后看得到公司', joined2.includes('某公司'))
  t('状态说的是中文', joined2.includes('投了'))
  t('备注也显示出来', joined2.includes('内推'))
  t('说清了这张表能自己改', joined2.includes('自己在文件夹里打开改'))
}
{
  // 面试故事：空的时候给入口，有内容时能读
  const before = visibleText.length
  renderOne('下一步（还没有故事）', seen.get('JobsView'), { onBack: () => {}, flash: () => {} }, { 17: true, 18: [] })
  const joined = visibleText.slice(before).join('|')
  t('故事区说清了为什么要写', joined.includes('临时想是来不及的'))
  t('故事区给了写法指引', joined.includes('什么情况'))

  const before2 = visibleText.length
  renderOne('下一步（有面试故事）', seen.get('JobsView'), { onBack: () => {}, flash: () => {} }, {
    17: true,
    18: [{ title: '一次线上事故', body: '凌晨两点被告警叫起来。' }],
  })
  const joined2 = visibleText.slice(before2).join('|')
  t('故事标题显示出来', joined2.includes('一次线上事故'))
  t('故事正文显示出来', joined2.includes('凌晨两点'))
}
{
  const before = visibleText.length
  renderOne('求职报告（什么都没对上）', seen.get('JobReport'), {
    report: { company: '', role: '', blocked: [], matched: [], gaps: [], unclear: [], questions: [], warnings: [], dropped: [] },
  })
  const joined = visibleText.slice(before).join('|')
  t('空报告不崩且说得出是「这份工作」', joined.includes('这份工作'))
  t('空报告不显示「丢掉的」段', !joined.includes('丢掉的'))
}

// ── 照这份改简历 / 写封求职信 ──────────────────────────────────
{
  const REPORT = { company: '某公司', role: '后端工程师', blocked: [], matched: [], gaps: [], unclear: [], questions: [], warnings: [], dropped: [] }
  const before = visibleText.length
  // 槽位：20 written / 21 writing（都排在最后，前面是老槽位）
  renderOne('下一步（写了简历，有对不上的数字）', seen.get('JobsView'), { onBack: () => {}, flash: () => {} }, {
    4: REPORT,
    20: { kind: 'resume', markdown: '# 李四\n\n## 经历\n- 把接口耗时降了 40%', path: 'jobs/resumes/x.md', warning: '这版里有 1 个数字在你材料里找不到：40%。投之前自己核一遍。' },
    23: null,
  })
  const joined = visibleText.slice(before).join('|')
  t('简历区标题说人话', joined.includes('改好的简历'))
  t('简历正文显示出来', joined.includes('把接口耗时降了'))
  t('编的数字要当面提醒', joined.includes('在你材料里找不到'))
  t('提醒说了怎么办', joined.includes('自己核一遍'))
  t('给了存成文件的路', joined.includes('存成文件'))

  const before2 = visibleText.length
  renderOne('下一步（写了求职信）', seen.get('JobsView'), { onBack: () => {}, flash: () => {} }, {
    4: REPORT,
    20: { kind: 'cover', markdown: '我做过一次交易系统重构。', path: null, warning: null },
    23: null,
  })
  const joined2 = visibleText.slice(before2).join('|')
  t('求职信区标题说人话', joined2.includes('写好的求职信'))
  t('没有警告就不吓人', !joined2.includes('在你材料里找不到'))
  t('没存盘就不说存哪儿了', !joined2.includes('也存了一份在工作文件夹里'))

  // 没看过工作的时候，两个按钮都不该出现——不知道照谁改
  const before3 = visibleText.length
  renderOne('下一步（还没看过任何工作）', seen.get('JobsView'), { onBack: () => {}, flash: () => {} }, { 4: null })
  const joined3 = visibleText.slice(before3).join('|')
  t('没看过工作就不给改简历', !joined3.includes('照这份改简历'))
  t('没看过工作就不给写求职信', !joined3.includes('写封求职信'))
}

{
  // 模拟面试：这一页反过来问用户，最要紧的是「不许越界问人」和「不主动投递」
  const SESSION = {
    id: 'mock-1',
    company: '某公司',
    role: '后端',
    started_at: '2026-10-20T10:00:00.000Z',
    turns: [
      { question: '讲讲你做过最复杂的一个系统。', kind: 'behavior', answer: '做过一个交易系统。', review: { findings: [] }, by: 'ai', asked_at: '2026-10-20T10:01:00.000Z' },
      { question: '你说的那个交易系统，峰值多少笔？', kind: 'explain', quoted: '交易系统', answer: '', by: 'ai', asked_at: '2026-10-20T10:02:00.000Z' },
    ],
  }

  let before = visibleText.length
  renderOne('模拟面试（还没开始）', seen.get('JobsView'), { onBack: () => {}, flash: () => {} }, {
    4: { company: '某公司', role: '后端', blocked: [], matched: [], gaps: [], unclear: [], questions: [], warnings: [], dropped: [] },
    23: true,
  })
  let joined = visibleText.slice(before).join('|')
  t('面试页说了它会追着问', joined.includes('咬住'))
  t('面试页说了不碰婚育年龄', joined.includes('结没结婚'))
  t('面试页说了不做背调', joined.includes('不做背景调查'))
  t('面试页有开始的按钮', joined.includes('开始练'))
  t('面试页没有「一键投递」这类诱导', !joined.includes('一键投递') && !joined.includes('自动投递'))

  before = visibleText.length
  renderOne('模拟面试（问到第二题）', seen.get('MockView'), { company: '某公司', role: '后端', requirements: [], onBack: () => {}, flash: () => {} }, {
    0: SESSION,
  })
  joined = visibleText.slice(before).join('|')
  t('问题显示出来了', joined.includes('讲讲你做过最复杂的一个系统'))
  t('追问指出了追的是哪一句', joined.includes('交易系统'))
  t('答过的显示出来了', joined.includes('做过一个交易系统'))
  t('有作答的输入框', joined.includes('就当对面坐着人'))
  t('可以跳过一题', joined.includes('这题跳过'))
  t('可以中途结束', joined.includes('今天到这'))

  before = visibleText.length
  renderOne('模拟面试（这一题答完给了提示）', seen.get('MockView'), { company: '某公司', role: '后端', requirements: [], onBack: () => {}, flash: () => {} }, {
    0: SESSION,
    4: ['没听见「我做了什么」。', '一个数字都没有。'],
  })
  joined = visibleText.slice(before).join('|')
  t('答完之后说清哪里能更好', joined.includes('可以再具体一点'))
  t('提示是真的说出来了', joined.includes('一个数字都没有'))
  // 提示出现时通常已经自动问出下一题了，所以这时该能直接接着答
  t('给完提示就能接着答下一题', joined.includes('就当对面坐着人'))

  before = visibleText.length
  renderOne('模拟面试（练完了）', seen.get('MockView'), { company: '某公司', role: '后端', requirements: [], onBack: () => {}, flash: () => {} }, {
    0: { ...SESSION, ended_at: '2026-10-20T10:09:00.000Z', markdown: '# 模拟面试' },
    5: ['一共问了 2 个问题，答了 1 个。', '有 1 次回答里一个数字都没有。'],
    6: '这一场结束了。',
  })
  joined = visibleText.slice(before).join('|')
  t('结束语出来了', joined.includes('这一场结束了'))
  t('总结说清答了几题', joined.includes('一共问了 2 个问题'))
  t('总结点出没有数字', joined.includes('一个数字都没有'))
  t('能再练一场', joined.includes('再练一场'))
  t('能把这一场存成文件', joined.includes('存成文件'))

  before = visibleText.length
  renderOne('模拟面试（以前练过的）', seen.get('MockView'), { company: '某公司', role: '后端', requirements: [], onBack: () => {}, flash: () => {} }, {
    0: null,
    7: [{ id: 'mock-1', company: '某公司', role: '后端', started_at: '2026-10-20T10:00:00.000Z', turns: 2, answered: 1, done: true }],
  })
  joined = visibleText.slice(before).join('|')
  t('以前练过的那一场显示出来了', joined.includes('以前练过的'))
  t('写着问了几个答了几个', joined.includes('问了 2 个'))
  t('练完了有标记', joined.includes('练完了'))
}

// 遍历渲染完之后再核对：所有子组件都该被访问到过。
const missing = []
for (const want of ['CardForm', 'ProposalPanel', 'HistoryPanel', 'BookEditor', 'AvatarPicker', 'CompetencyEditor', 'ListEditor', 'CardRow',
  'HomeView', 'CardView', 'ImportView', 'AnalyzeView', 'InterviewView', 'DoctorView',
  'NewCardView', 'SetupView', 'Field', 'Action', 'WorldRow', 'WorldView', 'MemoryView', 'JobsView', 'MockView']) {
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
  'proposal', 'materials/', 'doctor', 'workspace', '.lifecard', 'tombstone', '墓碑', 'frontmatter',
  // 「开一个新会话」是跟外壳打交道，这些名字不该落到用户眼睛里：
  // 用户要看见的是「聊一聊」和「会在新对话里问」。
  'startSession', 'uiWorkspace', 'agentPreset', 'lc-real', 'lc-tavern', 'lc-novel', '/lifecard-interview']
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
  ['「聊一聊」按钮', '聊一聊'],
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
  // 用户原话：「父母关系是什么鬼？肯定是父子关系嘛」「直接选：他是我的什么人？」
  ['访谈问的是「他是我的什么人」', '他是我的什么人'],
  ['关系选项里有「父亲」', '父亲'],
  ['关系选项里有「母亲」', '母亲'],
  ['关系选项里有「朋友」', '朋友'],
  ['关系选项里有「伴侣」', '伴侣'],
  // 用户原话：「留下父亲、母亲、朋友、伴侣四个，并排放，底下放横线让用户自己填。
  // 因为太长了看着，这么一长串的按键选项。」
  ['横线上能自己填', '或者直接写：爷爷 / 高中班主任 / 隔壁王叔'],
  // 用户原话：「「还有什么」默认折叠收起，折叠收起状态下只能看到灰色弱化字的
  // 「还有什么」几个字，没有输入框。展开就有输入框了。」
  ['「还有什么」收着时只有一行字', '还有什么'],
  ['补充身份写了也认', '也是伴侣、也是家人、也是同事'],
]) {
  t(`出现了 ${label}`, all.includes(word), word)
}

// 旧说法不许回来：删掉它是因为它和「他叫什么」在问同一件事，
// 两栏并排，用户不知道该在哪一栏写「妈」。
for (const gone of ['你们是什么关系', '这是谁']) {
  t(`旧说法「${gone}」不再出现`, !all.includes(gone), all.slice(0, 200))
}

{
  // 搜索要一起筛材料：只筛卡不筛材料，看着像「筛过了」。
  const nm = visibleText.length
  renderOne('首页（搜「妈妈」）', seen.get('HomeView'), { state: STATE, listing: LISTING, onOpen: () => {}, onOpenWorld: () => {}, onNavigate: () => {}, onProposal: () => {}, busy: '', onDoDoctor: () => {}, showMore: false, onMore: () => {}, intro: true, onIntroDone: () => {}, onMaterial: () => {}, onDeleteMaterial: () => {} }, { 0: '妈妈' })
  const only = visibleText.slice(nm).join('|')
  t('搜「妈妈」时不相关的材料不列出来', only.includes('mama-interview') === false, only.slice(0, 260))
  const nm2 = visibleText.length
  renderOne('首页（搜「interview」）', seen.get('HomeView'), { state: STATE, listing: LISTING, onOpen: () => {}, onOpenWorld: () => {}, onNavigate: () => {}, onProposal: () => {}, busy: '', onDoDoctor: () => {}, showMore: false, onMore: () => {}, intro: true, onIntroDone: () => {}, onMaterial: () => {}, onDeleteMaterial: () => {} }, { 0: 'interview' })
  const mats = visibleText.slice(nm2).join('|')
  t('搜材料名也能把材料搜出来', mats.includes('mama-interview'), mats.slice(0, 260))
}


// ── 把界面上每个能点、能改的地方都点一遍 ──────────────────────
// 为什么要有这一段：静态渲染只证明「画得出来」，不证明「点得动」。
// 曾经有一处 onChange 调了别的函数里的局部变量（dropReport），画面上完全
// 看不出问题，用户一打字就抛错、报告也不跟着清。这一段就是把每个
// onClick / onChange / onSubmit 都真的调一次，看会不会当场炸。
function pokeHandlers(tree, label) {
  const fakeEvent = {
    target: { value: 'x', checked: false, files: [] },
    preventDefault() {}, stopPropagation() {}, key: 'Enter', shiftKey: false,
  }
  const errors = []
  const walk = (node, depth) => {
    if (node === null || node === undefined || depth > 30) return
    if (Array.isArray(node)) { for (const n of node) walk(n, depth + 1); return }
    if (typeof node !== 'object') return
    for (const key of ['onClick', 'onChange', 'onSubmit', 'onFocus', 'onBlur']) {
      const fn = node.props?.[key]
      if (typeof fn !== 'function') continue
      try {
        const out = fn(fakeEvent)
        if (out !== null && out !== undefined && typeof out.then === 'function') out.then(() => {}).catch(() => {})
      } catch (e) {
        errors.push(`${key}: ${e.message}`)
      }
    }
    walk(node.children, depth + 1)
  }
  walk(tree, 0)
  return errors
}

for (const [label, tree] of [
  ['首页', homeTree],
  ['下一步', renderRoot('再看一眼下一步', base('jobs'))],
  ['整理材料', renderRoot('再看一眼整理材料', base('analyze'))],
  ['从记忆里认人', renderRoot('再看一眼记忆页', base('memory'))],
  ['体检', renderRoot('再看一眼体检页', base('doctor', { 8: DOCTOR }))],
]) {
  const errs = pokeHandlers(expand(tree), label)
  t(`${label}上每个按钮都点得动`, errs.length === 0, errs.slice(0, 3).join(' / '))
}

// ── 2026-10-24 前端审查那一批 ────────────────────────────────
// 这一段钉的都是「点下去之后才会露出来」的错：标题看着正常、日志一片绿，
// 但用户真的按了，屏幕上没有反应，或者档案被悄悄切走。
{
  // P0-1：已经有档案、从首页「换个文件夹」进来时，这一页不能装成第一次设置。
  // 以前预填 ~/LifeCard、主按钮写着「就用这个文件夹」，一点就把库切到空文件夹，
  // 界面上没有一个字说「原来那些卡还在别处」。
  const st = { ok: true, exists: true, workspace: '/tmp/lc-old', defaults: { workspace: '/tmp/lc-old' }, relations: RELATIONS }
  const tree = renderOne('选文件夹（已经有档案）', seen.get('SetupView'), { state: st, onDone: async () => {} }, { 0: '/tmp/lc-old' })
  const words = textOf(expand(tree))
  t('有档案时标题说的是「换一个文件夹」', words.includes('换一个文件夹放档案'), words.slice(0, 80))
  t('不再装成第一次设置', !words.includes('先挑一个文件夹放你的档案'))
  t('先说明原来的卡不会跟过来', words.includes('不会跟过来'))
  t('标题里不出现文件夹路径之外的内部说法', !/workspace/i.test(words))
}
{
  // 换到一个不一样的文件夹：先问一句。答「取消」，就一个请求都不许发。
  const asked = []
  const done = []
  const posts = []
  const realConfirm = fakeWindow.confirm
  const realFetch = globalThis.fetch
  fakeWindow.confirm = (msg) => { asked.push(String(msg)); return false }
  globalThis.fetch = async (url) => { posts.push(String(url)); return { ok: true, json: async () => ({ ok: true }) } }
  const st = { ok: true, exists: true, workspace: '/tmp/lc-old', defaults: { workspace: '/tmp/lc-new' }, relations: RELATIONS }
  const tree = renderOne('选文件夹（要换到别处）', seen.get('SetupView'), { state: st, onDone: async (w) => { done.push(w) } }, { 0: '/tmp/lc-new' })
  const clicked = clickByText(tree, '开始吧')
  await new Promise((r) => setTimeout(r, 30))
  t('换到别的文件夹时要先问一句', clicked === true && asked.length === 1, `asked=${asked.length}`)
  t('问的时候把「原来的卡不会跟过来」说清楚', asked.length === 1 && asked[0].includes('不会跟过来'), asked[0])
  // 别的组件自己也会发 state.get 之类的请求，这里只数「有没有真的去换库」。
  const switched = posts.filter((u) => u.includes('workspace.init'))
  t('答取消就什么都不做', done.length === 0 && switched.length === 0, JSON.stringify({ done, switched }))
  fakeWindow.confirm = realConfirm
  globalThis.fetch = realFetch
}
{
  // 点名要换、也确认了，但后台说这个位置用不了：错误要摆在这一页上，
  // 不许吞掉之后照样绿字说「好了，可以开始了」。
  const realConfirm = fakeWindow.confirm
  fakeWindow.confirm = () => true
  const st = { ok: true, exists: true, workspace: '/tmp/lc-old', defaults: { workspace: '/tmp/lc-new' }, relations: RELATIONS }
  const tree = renderOne('选文件夹（换了但没成）', seen.get('SetupView'), {
    state: st,
    onDone: async () => { throw new Error('这个文件夹写不进去。换一个你自己的文件夹试试。') },
  }, { 0: '/tmp/lc-new' })
  const clicked = clickByText(tree, '开始吧')
  await new Promise((r) => setTimeout(r, 40))
  t('「开始吧」点得动', clicked === true)
  t('用不了的时候把原因摆在页面上', String(hookStore[3] ?? '').includes('写不进去'), String(hookStore[3]))
  fakeWindow.confirm = realConfirm
}
{
  // 分析页「看看读出了什么」：读失败时以前把 {ok:false} 当建议交上去，
  // ProposalPanel 拿到空清单，显示绿字「这一份里没有还没写进去的了」。
  const handed = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false, error: '这份建议读不出来' }) })
  const RESULT = { accepted: 1, rejected: 0, json: { items: [] } }
  const tree = renderOne('分析页（建议读不出来）', seen.get('AnalyzeView'), {
    listing: LISTING, state: { ok: true, workspace: '/tmp/x', exists: true }, flash: () => {},
    onProposal: (p) => { handed.push(p) }, presetAbout: null, presetMaterials: null,
    onBack: () => {}, onNeedMaterial: () => {},
  }, { 0: 'mama', 4: RESULT })
  const clicked = clickByText(tree, '看看读出了什么')
  await new Promise((r) => setTimeout(r, 30))
  t('「看看读出了什么」点得动', clicked === true)
  t('读不出来就不把空建议交上去', handed.length === 0, handed)
  globalThis.fetch = realFetch
}
{
  // 「一段文字」那一栏不能因为切一下 tab 就被卸载：粘了一半的长稿子，
  // 手滑点一下「角色卡文件」再点回来，字全没了，既没提示也没有草稿。
  const tree = renderOne('添加（停在角色卡文件这一栏）', seen.get('ImportView'), { busy: '', onImport: () => {}, onAnalyze: () => {}, listing: LISTING }, { 1: 'card' })
  const dom = expand(tree)
  const findTextarea = (n, out = []) => {
    if (n === null || n === undefined) return out
    if (Array.isArray(n)) { n.forEach((x) => findTextarea(x, out)); return out }
    if (typeof n !== 'object') return out
    if (n.type === 'textarea' && String(n.props?.placeholder ?? '').includes('把文字贴在这里')) out.push(n)
    findTextarea(n.children, out)
    return out
  }
  t('「一段文字」那一栏一直挂着（只是藏起来）', findTextarea(dom).length === 1)
  const hidden = (n, seen2 = false) => {
    if (n === null || n === undefined) return seen2
    const mine = n?.props?.style?.display === 'none' || seen2
    if (Array.isArray(n)) return n.some((x) => hidden(x, mine))
    if (typeof n !== 'object') return false
    if (n.type === 'textarea' && String(n.props?.placeholder ?? '').includes('把文字贴在这里')) return mine
    return hidden(n.children, mine)
  }
  t('停在角色卡那一栏时它是藏着的', hidden(dom) === true)
}
{
  // 模拟面试：后台回「开不了」（不是网络抛错，是后台自己的 ok:false）时，
  // 按钮不能永远卡在「正在开始…」——这一页没有第二个入口，用户只能退出去重进。
  // 以前只有 catch 里复位 busy，这条 ok:false 的出口直接 return 了。
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: false, error: '这一份读不出公司名，先在招聘说明里写上公司。' }) })
  const tree = renderOne('模拟面试（后台说开不了）', seen.get('MockView'), { company: '某公司', role: '后端', requirements: [], onBack: () => {}, flash: () => {} }, { 2: true })
  const clicked = clickByText(tree, '正在开始…')
  await new Promise((r) => setTimeout(r, 40))
  t('「正在开始…」那个按钮点得着', clicked === true)
  t('后台说开不了时按钮不会永远卡住', hookStore[2] === false, String(hookStore[2]))
  t('并且把后台那句话说出来', String(hookStore[3] ?? '').includes('公司'), String(hookStore[3]))
  globalThis.fetch = realFetch
}
{
  // 首页那行路径：留着（选错文件夹的人靠它找回去），但要说清是什么。
  const tree = renderRoot('首页（路径标签）', base('home'))
  const words = textOf(expand(tree))
  t('路径前面写着「档案在：」', !words.includes('/tmp/') || words.includes('档案在：'), words.includes('档案在：'))
}

// ── 三扇门：一进来先问「你要用哪个」 ────────────────────────────
// 这个插件的三件事不一样：写身边的真人、写虚构人物、拿角色卡跟 AI 演。
// 以前三者共用一屏，写小说的人看到「贴一份招聘说明」只会莫名其妙。
{
  const doors = expand(renderRoot('进门（三扇门）', base('doors')))
  const text = textOf(doors)
  t('进门先问用哪个', text.includes('你要用哪个'), text.slice(0, 120))
  t('有「真实人物记录」这扇门', text.includes('真实人物记录'))
  t('有「写小说」这扇门', text.includes('写小说'))
  t('有「酒馆（角色扮演）」这扇门', text.includes('酒馆'))
  t('进门这一屏不列卡（还没选门）', !text.includes('认识的人'))

  // 真实人物那扇门：找工作的入口在
  const real = expand(renderRoot('真实人物门首页', base('home')))
  const realText = textOf(real)
  t('真实人物门里有「下一步」', realText.includes('下一步'))
  t('真实人物门里有「从记忆里认人」', realText.includes('从记忆里认人'))
  t('真实人物门里列出认识的人', realText.includes('认识的人'))
  t('每扇门都能换', flatButtons(real).some((b) => textOf(b).includes('换门')))

  // 写小说那扇门：找工作的入口不许出现，材料栏也不许
  const novel = expand(renderRoot('写小说门首页', base('novel')))
  const novelText = textOf(novel)
  t('写小说门里没有「下一步」（找工作只属于真实人物那扇门）', !novelText.includes('下一步'), novelText.slice(0, 160))
  t('写小说门里没有「从记忆里认人」', !novelText.includes('从记忆里认人'))
  t('写小说门里没有材料栏', !novelText.includes('材料 ·'))
  t('写小说门里把真人的卡说清在哪儿', !novelText.includes('认识的人') || novelText.includes('真实人物记录'))
  t('写小说门里能换门', flatButtons(novel).some((b) => textOf(b).includes('换门')))

  // 酒馆那扇门：同样没有找工作
  const tavern = expand(renderRoot('酒馆门首页', base('tavern')))
  const tavernText = textOf(tavern)
  t('酒馆门里没有「下一步」', !tavernText.includes('下一步'), tavernText.slice(0, 160))
  t('酒馆门里能换门', flatButtons(tavern).some((b) => textOf(b).includes('换门')))
  t('进门那一屏没有换门按钮（已经在门口了）', !flatButtons(doors).some((b) => textOf(b).includes('换门')))

  // 点一扇门，要真的进那一屏
  const picked = []
  renderOne('选门（点写小说）', seen.get('DoorsView'), { state: STATE, onPick: (m) => picked.push(m) }, {})
  const doorButtons = flatButtons(expand(renderOne('选门（再渲染一次拿按钮）', seen.get('DoorsView'), { state: STATE, onPick: (m) => picked.push(m) }, {})))
  const novelBtn = doorButtons.find((b) => textOf(b).includes('写小说'))
  t('找得到「写小说」那个按钮', novelBtn !== undefined)
  if (novelBtn !== undefined) {
    novelBtn.props.onClick()
    t('点「写小说」带出的是 novel', picked[0] === 'novel', JSON.stringify(picked))
  }
  void picked
}

// ── 酒馆：一处能开口的地方 ────────────────────────────────────────
// 角色卡和世界书管得再好，没有「和 TA 说话」这一屏，那两样就是摆设。
{
  const CHAT = {
    id: 'chat-20261024-1611-abcd',
    card_name: '张三',
    turns: [
      { who: '张三', text: '来了？自己找地方坐。' },
      { who: '我', text: '我路过，进来看看。' },
    ],
  }
  // 先让整棵树走到那一屏，TavernView 才会进 seen
  renderRoot('酒馆（聊天屏）', base('tavernChat'))
  t('酒馆聊天那一屏渲染得出来', seen.get('TavernView') !== undefined)

  const tree = renderOne('酒馆（已经说了几句）', seen.get('TavernView'), { chat: CHAT, onChat: () => {}, onBack: () => {} })
  const text = textOf(expand(tree))
  t('标题写着和谁在演', text.includes('和「张三」在演'), text.slice(0, 120))
  t('对方说的那句在屏上', text.includes('自己找地方坐'), text)
  t('我说的那句也在屏上', text.includes('我路过'), text)
  t('屏上有几个说话人的名字', text.includes('张三') && text.includes('我'), text)
  t('说了几句有个数', /\d+ 句/.test(text), text.slice(0, 160))
  t('退出前说清「存过了」', text.includes('还能接着说'), text.slice(-160))

  // 空输入框：发送要是灰的，免得点了没反应
  const emptyButtons = flatButtons(expand(renderOne('酒馆（还没打字）', seen.get('TavernView'), { chat: CHAT, onChat: () => {}, onBack: () => {} }, { 0: '' })))
  const sendBtn = emptyButtons.find((b) => textOf(b).includes('说这句'))
  t('没打字时「说这句」按不动', sendBtn !== undefined && sendBtn.props.disabled === true, sendBtn === undefined ? '没找到按钮' : '')

  // 说一句：后台收到了、界面跟着长出新的一轮
  const posts = []
  const realFetch = globalThis.fetch
  let updated = null
  globalThis.fetch = async (url, init) => {
    posts.push({ url: String(url), body: init?.body === undefined ? '' : String(init.body) })
    return { ok: true, json: async () => ({ ok: true, turns: [...CHAT.turns, { who: '我', text: '我路过，进来看看。' }, { who: '张三', text: '坐吧。' }] }) }
  }
  try {
    const typed = renderOne('酒馆（打了一句话）', seen.get('TavernView'), { chat: CHAT, onChat: (c) => { updated = c }, onBack: () => {} }, { 0: '我路过，进来看看。' })
    const clicked = clickByText(typed, '说这句')
    t('「说这句」点得动', clicked === true)
    await new Promise((r) => setTimeout(r, 30))
    t('点了之后真的问了后台', posts.some((x) => x.url.includes('tavern.say')), posts.map((x) => x.url).join(' | '))
    t('把我说的话一起带过去了', posts.some((x) => x.body.includes('我路过')), posts.map((x) => x.body).join(' | '))
    t('回来之后对话长了一轮', Array.isArray(updated?.turns) && updated.turns.length === 4, JSON.stringify(updated?.turns))
  } finally {
    globalThis.fetch = realFetch
  }

  // TA 没回话：我那句已经在文件里了，屏上要照实说
  let keptBack = null
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ ok: false, error: 'TA 没接上话：连不上', turns: [...CHAT.turns, { who: '我', text: '喂？' }] }),
  })
  try {
    const typed = renderOne('酒馆（TA 没回话）', seen.get('TavernView'), { chat: CHAT, onChat: (c) => { keptBack = c }, onBack: () => {} }, { 0: '喂？' })
    clickByText(typed, '说这句')
    await new Promise((r) => setTimeout(r, 30))
    t('回不上话时如实说', String(hookStore[2] ?? '').includes('没接上话'), String(hookStore[2]))
    t('我那句照样留在屏上（不会让人再打一遍）', (keptBack?.turns ?? []).some((x) => x.text === '喂？'), JSON.stringify(keptBack?.turns))
  } finally {
    globalThis.fetch = realFetch
  }

  // 删这一场要先问一句
  const delTree = renderOne('酒馆（想删掉这一场）', seen.get('TavernView'), { chat: CHAT, onChat: () => {}, onBack: () => {} })
  const delClicked = clickByText(delTree, '这一场不要了')
  t('「这一场不要了」点得动', delClicked === true)
  t('点完先问一句，不直接删', hookStore[3] === true, String(hookStore[3]))

  // 没有开场白的卡：不能是一片死白
  const bare = renderOne('酒馆（这张卡没写开场白）', seen.get('TavernView'), { chat: { id: 'chat-x', card_name: '', turns: [] }, onChat: () => {}, onBack: () => {} })
  const bareText = textOf(expand(bare))
  t('没开场白时说清怎么开始', bareText.includes('先说'), bareText.slice(0, 200))
  t('没名字的时候用「TA」顶上', bareText.includes('TA'), bareText.slice(0, 120))
}

// ── 酒馆：收个尾 ──────────────────────────────────────────────────
// 说得久了只带最近二十来轮给模型，再往前它就记不住。收尾就是把前面
// 发生过的事写成几句，存进会话文件、之后每轮都带上。
{
  const CHAT = {
    id: 'chat-20261024-1611-abcd',
    card_name: '张三',
    turns: [
      { who: '张三', text: '来了？自己找地方坐。' },
      { who: '我', text: '我路过，进来看看。' },
    ],
  }
  const withMemory = { ...CHAT, notes: [{ title: '到这儿为止', body: '张三在门口遇到了我，说起厂里倒闭的事。' }] }
  const tree = renderOne('酒馆（已经收过一次尾）', seen.get('TavernView'), { chat: withMemory, onChat: () => {}, onBack: () => {} })
  const text = textOf(expand(tree))
  t('收过尾的场次会亮出那段备忘', text.includes('前面这些已经收好了'), text.slice(0, 200))
  t('备忘的内容在屏上', text.includes('厂里倒闭'), text.slice(0, 240))
  t('有话可收时「收个尾」按得动', flatButtons(expand(tree)).some((b) => textOf(b).includes('收个尾')))

  const plain = renderOne('酒馆（还没收过尾）', seen.get('TavernView'), { chat: CHAT, onChat: () => {}, onBack: () => {} })
  t('没收过尾时不出现那段备忘', !textOf(expand(plain)).includes('前面这些已经收好了'), textOf(expand(plain)).slice(0, 160))

  // 点「收个尾」：后台回一段备忘，界面要立刻接上
  const posts = []
  const realFetch = globalThis.fetch
  let back = null
  globalThis.fetch = async (url, init) => {
    posts.push(String(url))
    return {
      ok: true,
      json: async () => ({ ok: true, summary: '说到厂里倒闭，还没谈完。', notes: [{ title: '到这儿为止', body: '说到厂里倒闭，还没谈完。' }], turns: CHAT.turns }),
    }
  }
  try {
      const withCb = renderOne('酒馆（点收个尾）', seen.get('TavernView'), { chat: CHAT, onChat: (c) => { back = c }, onBack: () => {} })
    const clicked = clickByText(withCb, '收个尾')
    t('「收个尾」点得动', clicked === true)
    await new Promise((r) => setTimeout(r, 30))
    t('点了之后真的去收了', posts.some((u) => u.includes('tavern.summarize')), posts.join(' | '))
    t('收完把新的备忘带回来了', Array.isArray(back?.notes) && back.notes.some((n) => n.title === '到这儿为止'), JSON.stringify(back?.notes))
  } finally {
    globalThis.fetch = realFetch
  }
  void back
}

// ── 酒馆：说过的那几场要能回去 ────────────────────────────────────
// 退出一场之后就找不回来了，等于每场都只活一次——列表是回来的路。
{
  const rows = [
    { id: 'chat-1', card_name: '张三', turns: 12, last: '坐吧。', updated_at: '2026-10-24 16:30' },
    { id: 'chat-2', card_name: '', turns: 3, last: '', updated_at: '2026-10-24 15:00' },
  ]
  const picked = []
  const tree = renderOne('酒馆首页（说过的场次）', seen.get('HomeView'), {
    state: STATE, listing: LISTING, mode: 'tavern', chats: rows,
    onOpen: () => {}, onOpenWorld: () => {}, onNavigate: () => {}, onProposal: () => {},
    busy: '', onDoDoctor: () => {}, showMore: false, onMore: () => {},
    intro: false, onIntroDone: () => {}, onMaterial: () => {}, onDeleteMaterial: () => {},
    onOpenChat: (row) => picked.push(row),
  })
  const text = textOf(expand(tree))
  t('首页有「说过的场次」这一栏', text.includes('说过的场次'), text.slice(0, 200))
  t('场次里写着和谁在演', text.includes('和「张三」'), text.slice(0, 240))
  t('没名字的那场用「TA」顶上', text.includes('和「TA」'), text.slice(0, 240))
  t('场次里有句数', text.includes('12 句'), text.slice(0, 240))
  t('场次里有最后一句', text.includes('坐吧'), text.slice(0, 240))

  const clicked = clickByText(tree, '和「张三」')
  t('点一场能接着回去', clicked === true)
  t('回去时把那一场交给后台', picked[0]?.id === 'chat-1', JSON.stringify(picked[0]))
}

{
  // 一场都没说过的时候不要空着横一条「说过的场次 · 0」
  const tree = renderOne('酒馆首页（还没说过）', seen.get('HomeView'), {
    state: STATE, listing: LISTING, mode: 'tavern', chats: [],
    onOpen: () => {}, onOpenWorld: () => {}, onNavigate: () => {}, onProposal: () => {},
    busy: '', onDoDoctor: () => {}, showMore: false, onMore: () => {},
    intro: false, onIntroDone: () => {}, onMaterial: () => {}, onDeleteMaterial: () => {},
    onOpenChat: () => {},
  })
  const text = textOf(expand(tree))
  t('没说过的时候不出现空的场次栏', !text.includes('说过的场次'), text.slice(0, 200))
}

// ── 2026-10-24 第二轮：门做大了、酒馆里真人卡收起、聊着建按门分题 ──────────
{
  const doors = expand(renderRoot('进门那一屏（三扇门都是大卡）', base('doors')))
  const doorText = textOf(doors)
  const doorJson = JSON.stringify(doors)
  t('进门那一屏有三扇门（三句「推门进去」）', (doorText.match(/推门进去/g) ?? []).length === 3, [(doorText.match(/推门进去/g) ?? []).length, doorText.slice(0, 200)])
  t('三扇门名字都在', ['真实人物记录', '写小说', '酒馆'].every((x) => doorText.includes(x)), doorText.slice(0, 200))
  t('门卡是大卡片（圆角 16）', doorJson.includes('"borderRadius":16'), doorJson.slice(0, 200))
  // 门是竖着的：三扇并排、每扇各自撑到整高（不是三个横躺的卡片叠着）
  t('三扇门横向并排', doorJson.includes('"flexWrap":"wrap"') && doorJson.includes('"alignItems":"stretch"'), doorJson.slice(0, 200))
  // 门本身是 3 块；里面的元素（图标/标题/说明/推门）也带 flex，所以只数 ≥3
  const doorWidths = (doorJson.match(/"flex":"1 1 30%"/g) ?? []).length
  t('每扇门各自平分宽度（至少三扇）', doorWidths >= 3, doorWidths)
  t('每扇门是竖长的（有最低高度，不是一条横栏）', (doorJson.match(/"minHeight":2[0-9][0-9]/g) ?? []).length >= 3, (doorJson.match(/"minHeight":\d+/g) ?? []).slice(0, 6))
  t('门有门楣（顶上一道色带）', doorJson.includes('"height":6'), '')
  t('门有门槛（底下写着推门进去）', doorText.includes('推门进去'), '')
  t('门有把手', doorJson.includes('"borderRadius":999') && doorJson.includes('"width":7'), '')
  t('门里竖着排（图标在上、说明在中、推门在底）', doorJson.includes('"flexDirection":"column"') && doorJson.includes('"alignItems":"center"'), doorJson.slice(0, 160))
  t('整屏高度被占满', doorJson.includes('"minHeight":"100%"'), doorJson.slice(0, 160))
}

{
  // 酒馆门里真人卡默认收起：一进去就看见父母同学的一排卡，不太舒服，
  // 也分不清哪些是拿来演的。收起不等于藏起来——得说清它们在哪儿。
  const tree = expand(renderRoot('酒馆门首页（真人卡默认收起）', base('tavern')))
  const text = textOf(tree)
  t('酒馆门里说清真人卡有多少张', text.includes('现实里认识的人 · 2'), text.slice(0, 300))
  t('默认不铺开真人卡', !text.includes('老张'), text.slice(0, 300))
  t('有「展开看看」', text.includes('展开看看'), text.slice(0, 300))
  t('说清完整记录在另一扇门', text.includes('真实人物记录'), text.slice(0, 300))
  t('说清拿去演是复制一份', text.includes('复制一份独立的角色卡'), text.slice(0, 300))
}

{
  // 展开之后：卡片列出来；点一张，问「要不要复制一份来演」。
  const Home = seen.get('HomeView')
  const props = {
    state: STATE, listing: LISTING, mode: 'tavern', chats: [],
    onOpen: () => {}, onOpenWorld: () => {}, onNavigate: () => {}, onProposal: () => {},
    busy: '', onDoDoctor: () => {}, showMore: false, onMore: () => {},
    intro: false, onIntroDone: () => {}, onMaterial: () => {}, onDeleteMaterial: () => {},
    onOpenChat: () => {}, onForkCard: () => {},
  }
  const opened = expand(renderOne('酒馆门首页（展开真人卡）', Home, props, { 1: true }))
  const openedText = textOf(opened)
  t('展开之后列出真人卡', openedText.includes('老张'), openedText.slice(0, 300))
  t('展开之后能收起', openedText.includes('先收起'), openedText.slice(0, 300))
  // 点一张卡＝把「要不要复制」那句话问出来
  // 卡面正面只有头像和名字，名字下面那个「详细信息」才是打开卡页的入口
  // （点整张卡本身是翻面——翻面不在这里断言，它属于卡面自己的行为）。
  const row = flatButtons(opened).find((b) => typeof b.props?.title === 'string' && b.props.title.includes('老张') && textOf(b).includes('详细信息'))
  if (row === null || row === undefined) t('真人的卡能点', false, '没找到这一行')
  else {
    row.props.onClick()
    const asked = expand(renderOne('酒馆门首页（问了要不要复制来演）', Home, props, { 1: true, 2: { name: '老张', path: 'cards/lao-zhang.card.md' } }))
    const askedText = textOf(asked)
    t('点真人的卡会先问一句', askedText.includes('复制一份来演'), askedText.slice(0, 400))
    t('问的时候说清原来那张不会被改', askedText.includes('原来那张一个字都不会动'), askedText.slice(0, 400))
    t('可以不复制', askedText.includes('先不'), askedText.slice(0, 400))
  }
}

{
  // 聊着建：从已有的卡点「接着聊」进来，不再问一遍「他是我的什么人」。
  const Interview = seen.get('InterviewView')
  const prep = expand(renderOne('接着聊（直接从卡上接着问）', Interview,
    { state: STATE, listing: LISTING, preset: { id: 'mama', name: '妈妈' }, mode: 'real' }, { 0: 'prep' }))
  const prepText = textOf(prep)
  t('接着聊时标题带名字', prepText.includes('接着聊 妈妈'), prepText.slice(0, 300))
  t('接着聊时说不问已经写过的', prepText.includes('已经写过的，就不再问了'), prepText.slice(0, 300))
  t('接着聊时不再问「他是我的什么人」', !prepText.includes('他是我的什么人'), prepText.slice(0, 300))

  // 现实那扇门：第一屏照旧先问关系
  const real = expand(renderOne('边聊边建（现实里的人）', Interview,
    { state: STATE, listing: LISTING, mode: 'real' }, { 0: 'pick' }))
  const realText = textOf(real)
  t('现实那扇门问「他是我的什么人」', realText.includes('他是我的什么人'), realText.slice(0, 300))
  t('现实那扇门是紫色（interview）', JSON.stringify(real).includes('--lc-interview-soft'), realText.slice(0, 200))

  // 酒馆那扇门：问的是「TA 叫什么」，不出现关系；配色换成 analyze
  const fictional = expand(renderOne('边聊边立一个人（酒馆的角色）', Interview,
    { state: STATE, listing: LISTING, mode: 'tavern' }, { 0: 'pick' }))
  const ficText = textOf(fictional)
  const ficJson = JSON.stringify(fictional)
  t('虚构角色问「TA 叫什么」', ficText.includes('TA 叫什么'), ficText.slice(0, 300))
  t('虚构角色不问「他是我的什么人」', !ficText.includes('他是我的什么人'), ficText.slice(0, 300))
  t('虚构角色说清这不是现实里的人', ficText.includes('虚构角色') && ficText.includes('不是现实里的谁'), ficText.slice(0, 400))
  t('虚构角色的颜色和现实不一样（analyze）', ficJson.includes('--lc-analyze-soft') && !ficJson.includes('--lc-interview-soft'), ficText.slice(0, 200))
  t('虚构角色的第一问从怎么说话起', ficText.includes('TA 怎么说话'), ficText.slice(0, 400))
}

{
  // 同名两张卡（酒馆里「复制一份来演」造出来的副本正好同名）：
  // 从原卡点「接着聊」，不能把整场访谈记到副本上。
  const Interview = seen.get('InterviewView')
  const bodies = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    bodies.push(String(init?.body ?? ''))
    return {
      ok: true,
      json: async () => ({
        ok: true,
        next: [{ id: 'q1', ask: '你妈做饭有什么固定动作？', options: ['先把菜切好'], fills: ['habit'] }],
        remaining: 1, coverage: 10, empty: [],
      }),
    }
  }
  const TWINS = {
    ...LISTING,
    cards: [
      { path: 'people/lao-zhang-role.card.md', id: 'lao-zhang-role', name: '老张', kind: 'fictional', world: 'reality' },
      { path: 'people/lao-zhang.card.md', id: 'lao-zhang', name: '老张', kind: 'real', world: 'reality' },
    ],
  }
  const tree = renderOne('同名两张卡（从原卡接着聊）', Interview,
    { state: STATE, listing: TWINS, preset: { id: 'lao-zhang', name: '老张' }, mode: 'real' }, { 0: 'pick', 1: '老张' })
  const go = flatButtons(expand(tree)).find((b) => textOf(b).includes('开始聊'))
  if (go === undefined) t('同名两张卡时找得到「开始聊」', false)
  else {
    go.props.onClick()
    await new Promise((r) => setTimeout(r, 30))
    const plan = bodies.find((b) => b.includes('"about"')) ?? ''
    t('带 preset.id 进来时按 id 找那张卡，不按名字', plan.includes('"lao-zhang"'), plan.slice(0, 200))
    t('没写进那份同名的副本', !plan.includes('lao-zhang-role'), plan.slice(0, 200))
  }
  globalThis.fetch = realFetch
}

{
  // 「再试一次」以前写成 setPhase('prep')：相位本来就是 prep，React 同值
  // 直接 bail out，按钮按了没反应；虚构那两扇门里连退路都没有，等于死页。
  const Interview = seen.get('InterviewView')
  const bodies = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    bodies.push(String(init?.body ?? ''))
    return {
      ok: true,
      json: async () => ({
        ok: true, next: [{ id: 'q1', ask: 'TA 说话有什么习惯？', options: ['爱重复'], fills: ['口癖'] }],
        remaining: 1, coverage: 10, empty: [],
      }),
    }
  }
  const tree = expand(renderOne('接着聊失败（虚构角色）', Interview,
    { state: STATE, listing: LISTING, preset: { id: 'lin', name: '林小雨' }, mode: 'tavern' },
    { 0: 'prep', 13: '没法准备问题，等一会儿再试' }))
  const text = textOf(tree)
  t('准备失败时说清发生了什么', text.includes('没法准备问题'), text.slice(0, 300))
  const retry = flatButtons(tree).find((b) => textOf(b).includes('再试一次'))
  t('虚构角色也有退回改名字的按钮', flatButtons(tree).some((b) => textOf(b).includes('重新填一下名字')), text.slice(0, 300))
  if (retry === undefined) t('准备失败时有「再试一次」', false)
  else {
    retry.props.onClick()
    await new Promise((r) => setTimeout(r, 30))
    t('「再试一次」真的又去准备了一次（以前是个死按钮）', bodies.some((b) => b.includes('"about"')), JSON.stringify(bodies).slice(0, 300))
  }
  globalThis.fetch = realFetch
}

{
  // 分析页那两栏「想突出的 / 不想要的」是边打边存的草稿：只有点「存一下」
  // 或失焦才落盘。改了字直接点「开始读」，以前发出去的还是上一次存的那份，
  // 读出来的东西跟屏幕上写的不一样。
  const bodies = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    bodies.push(String(init?.body ?? ''))
    return { ok: true, json: async () => ({ ok: true, accepted: 0, rejected: 0, json: { items: [] } }) }
  }
  const tree = renderOne('分析页（概念刚改完就点开始读）', seen.get('AnalyzeView'), {
    listing: LISTING, state: { ok: true, workspace: '/tmp/x', exists: true }, flash: () => {},
    onProposal: () => {}, presetAbout: { id: 'mama', name: '妈妈' }, presetMaterials: null,
    onBack: () => {}, onNeedMaterial: () => {},
  }, { 0: 'mama', 10: '把她说得倔一点，别写成温柔的' })
  const go = flatButtons(expand(tree)).find((b) => textOf(b).includes('开始读'))
  if (go === undefined) t('分析页有「开始读」', false)
  else {
    go.props.onClick()
    await new Promise((r) => setTimeout(r, 30))
    const analyze = bodies.find((b) => b.includes('"about"')) ?? ''
    t('刚改完的概念会一起发出去', analyze.includes('倔一点'), JSON.stringify(bodies).slice(0, 400))
    t('同时把改完的概念存下来', bodies.some((b) => b.includes('concept.set') || (b.includes('倔一点') && !b.includes('"about"'))), JSON.stringify(bodies).slice(0, 300))
    t('发给后台的概念不会是上一次存的那份', !analyze.includes('上一次'), analyze.slice(0, 300))
  }
  globalThis.fetch = realFetch
}

{
  // 「再加一条」以前点了没反应：空行是靠「值里带一个空串」占位的，
  // 而保存那层每次都会把空串过掉 → 下一次渲染又只剩一行。
  // 这条用会保留 hook 状态的写法，真的点两次、数行数。
  const ListEditor = seen.get('ListEditor')
  const CompetencyEditor = seen.get('CompetencyEditor')
  t('找得到列表编辑器', ListEditor !== undefined && CompetencyEditor !== undefined)


  // 这两个编辑器的「再加一条」由 test/editor-add-test.mjs 单独测：
  // 那边的运行时会在点击后保留状态，这里（render-all）每次展开子组件都会清空状态，
  // 跑不出「点一下 → 状态变 → 再渲染」这条链。
}

{
  // 写小说和酒馆里读完材料就该有一张能用的卡，不该再访谈一遍。
  // 虚构角色才给这个一键；真人的卡要人自己填关系，不能一键生成。
  const RESULT = { accepted: 2, rejected: 0, json: { items: [] } }
  const fakeFetch = async () => ({ ok: true, json: async () => ({ ok: true, applied: 2, path: 'people/lin.card.md' }) })
  const realFetch = globalThis.fetch

  globalThis.fetch = fakeFetch
  const fiction = renderOne('分析页（虚构角色，读完能一键建卡）', seen.get('AnalyzeView'), {
    listing: LISTING, state: { ok: true, workspace: '/tmp/x', exists: true }, flash: () => {},
    onProposal: () => {}, presetAbout: { name: '林小雨', kind: 'fictional' }, presetMaterials: null,
    onBack: () => {}, onNeedMaterial: () => {}, onAppliedCard: () => {},
  }, { 0: 'lin', 4: RESULT })
  t('虚构角色给「直接建成角色卡」', textOf(fiction).includes('直接建成角色卡'))
  t('并说明不用再访谈一遍', textOf(fiction).includes('不用再访谈一遍'))

  const real = renderOne('分析页（真人，不给一键建卡）', seen.get('AnalyzeView'), {
    listing: LISTING, state: { ok: true, workspace: '/tmp/x', exists: true }, flash: () => {},
    onProposal: () => {}, presetAbout: { name: '妈妈', kind: 'real' }, presetMaterials: null,
    onBack: () => {}, onNeedMaterial: () => {}, onAppliedCard: () => {},
  }, { 0: 'mama', 4: RESULT })
  t('真人不给「直接建成角色卡」', textOf(real).includes('直接建成角色卡') === false)
  t('真人还是走「看看读出了什么」', textOf(real).includes('看看读出了什么'))
  globalThis.fetch = realFetch
}

{
  // 首页以前只有标题和一排按钮，一大片空。现在顶上有一排数字：
  // 有几张卡、几份材料、几条等着看。数字是内容，也让人知道还差什么。
  const home = renderRoot('首页（顶上那排数字）', base('home'))
  const words = JSON.stringify(expand(home))
  t('首页标出「材料」这个数', words.includes('"材料"'))
  t('首页标出「待你看」这个数', words.includes('待你看'))
  t('真人门里说的是「认识的人」', words.includes('认识的人'))

  const novelHome = JSON.stringify(expand(renderRoot('首页（写小说门，带书架数）', base('novel'))))
  t('写小说门多一个「书」这个数', novelHome.includes('"书"'))
}

// ── 2026-10-26 前端审查那一批 ─────────────────────────────────────
// 先把这几个组件注册进 seen（它们只在对应那一屏才被渲染到）。
renderRoot('书（逐章写，先注册组件）', base('book', { 25: { id: 'demo', title: '示范' } }))
renderRoot('简历与规划（先注册组件）', base('career'))
renderRoot('玩一段（先注册组件）', base('game', { 25: { id: 'demo', title: '示范' } }))
renderRoot('导入（先注册组件）', base('import'))
renderRoot('酒馆里的一场（先注册组件）', base('tavernChat'))

{
  // P0：改完大纲点「存好」，以前整屏白屏。
  // novel.outline.save 回的 chapters 是「几条」这个数字，而本地那份是逐章数组。
  // 这里就按服务端真实形状（数字）喂进去：渲染不出来就说明又被盖掉了。
  const BOOK = { ok: true, id: 'demo', data: { title: '长夜', genre: '悬疑' }, idea: '一个镇子', chapters: [{ index: 1 }, { index: 2 }] }
  const tree = renderOne('逐章写（大纲存回来后 chapters 是数字）', seen.get('BookView'), { bookId: 'demo', flash: () => {}, onBack: () => {} }, { 0: BOOK, 1: { ok: true, chapters: 12, text: '主线：找人', theme: '找人', ending: '找到了' }, 2: 1, 3: '第一章写了一半' })
  const words = textOf(expand(tree))
  t('大纲是数字也不白屏', tree !== null)
  t('书名叫出来了', words.includes('长夜'), words.slice(0, 200))
  t('存好这一章的按钮还在', words.includes('存好这一章'), words.slice(0, 400))
  t('列出了两章的正文框', words.includes('正文'), words.slice(0, 400))
}

{
  // 改成剧本：改出来的那一份要能摆出来、能存、能删。
  // 槽位按 BookView 里 useState 的次序排：0 书、1 大纲、2 章号、3 正文、12 剧本、13 报告。
  const BOOK = { ok: true, id: 'demo', data: { title: '长夜' }, chapters: [{ index: 1 }] }
  const SCRIPT = '第1场\n旧书店·门厅　夜　内\n【出场人物】林小雨\n△ 她站在门里，伞尖滴水。\n林小雨（把伞往里递）说："雨太大了。"'
  const tree = renderOne('改成剧本（有一份改好的）', seen.get('BookView'), { bookId: 'demo', flash: () => {}, onBack: () => {} },
    { 0: BOOK, 1: { ok: true, chapters: 1, text: '', theme: '', ending: '' }, 2: 1, 3: '第一章写了一半', 12: SCRIPT, 13: '共 1 场，台词 1 句，动作 1 行。' })
  const words = textOf(expand(tree))
  t('有「改成剧本」这一节', words.includes('改成剧本'), words.slice(0, 300))
  // 正文在 textarea 的 value 里，textOf 取不到，所以认带出来的字数和按钮。
  t('剧本摆出来了（字数和「重改一份」都出来了）', words.includes('51 字') && words.includes('重改一份'), words.slice(-300))
  t('说清改出来的是什么', words.includes('能配音') || words.includes('△'), words.slice(-300))
  t('有存好的按钮', words.includes('存好这份剧本'), words.slice(-300))
  t('有删掉的按钮', words.includes('删掉这份'), words.slice(-300))
  t('数出来的结果也摆着', words.includes('共 1 场'), words.slice(-300))
  t('字数列出来', words.includes('字'), words.slice(-200))
  // 改剧本这一节自己报错：全页那个 err 在最底下，剧本框本身就三百像素高，
  // 报错落到屏幕外等于没报。
  const withErr = renderOne('改成剧本（这一节自己的报错）', seen.get('BookView'), { bookId: 'demo', flash: () => {}, onBack: () => {} },
    { 0: BOOK, 1: { ok: true, chapters: 1, text: '', theme: '', ending: '' }, 2: 1, 3: '第一章写了一半', 12: SCRIPT, 13: '', 15: '这一章还空着，没什么可改的。' })
  const errWords = textOf(expand(withErr))
  t('改剧本这一节的报错就摆在这一节里', errWords.includes('这一章还空着'), errWords.slice(-260))
  // 哪一章已经改过剧本：章列表上给个标记，不然只有翻进去才知道。
  const withMark = renderOne('改过剧本的章有标记', seen.get('BookView'), { bookId: 'demo', flash: () => {}, onBack: () => {} },
    { 0: BOOK, 1: { ok: true, chapters: 1, text: '', theme: '', ending: '' }, 2: 1, 3: '第一章写了一半', 16: [1] })
  t('改过剧本的那一章有标记', textOf(expand(withMark)).includes('有剧本'), textOf(expand(withMark)).slice(0, 400))
}

{
  // P1：简历文件读不出来时，以前只有一个永远转的圈。
  const tree = renderOne('简历读不出来（有话说）', seen.get('CareerView'), { flash: () => {}, onBack: () => {} }, { 0: null, 6: '你的简历这一份读不出来' })
  const words = textOf(expand(tree))
  t('简历读不出来时说清楚', words.includes('读不出来'), words.slice(0, 300))
  t('给一个「再试一次」', words.includes('再试一次'), words.slice(0, 300))
}

{
  // P1：界面一直写着「退出再进来还能接着走」，但入口根本没做。
  const tree = renderOne('玩一段（有存档可以接着走）', seen.get('GameView'), { bookId: 'demo', flash: () => {}, onBack: () => {} }, { 0: null, 10: [{ id: 'play-1', scene: '镇口', turns: 3 }] })
  const words = textOf(expand(tree))
  t('列出之前玩到一半的', words.includes('之前玩到一半的'), words.slice(0, 400))
  t('存档能点回去', words.includes('镇口'), words.slice(0, 400))
  t('告诉人走了几步', words.includes('走了 3 步'), words.slice(0, 400))
}

{
  // P2：拖进来不认识的格式，以前什么都不发生。
  const tree = renderOne('导入（拖错了格式）', seen.get('ImportView'), { busy: '', onImport: () => {}, onAnalyze: () => {}, listing: LISTING }, { 3: '这些认不出来：头像.jpg。只认角色卡文件（.png / .json / .charx / .zip）。' })
  t('拖错格式要说一句', textOf(expand(tree)).includes('认不出来'), textOf(expand(tree)).slice(0, 300))
}

{
  // P2：「到这儿为止」的备忘重进会话后以前看不见（chat 里带着，界面读不到）。
  const chat = { id: 'chat-1', card_name: '老张', world_name: '', turns: [{ who: '老张', text: '来了' }], notes: [{ title: '到这儿为止', body: '他答应明天去河边' }] }
  const tree = renderOne('酒馆（重进后备忘还在）', seen.get('TavernView'), { chat, onChat: () => {}, onBack: () => {}, flash: () => {} }, { 4: chat.notes })
  t('重进会话还看得见那段备忘', textOf(expand(tree)).includes('他答应明天去河边'), textOf(expand(tree)).slice(0, 400))
  t('能挑几句进卡里', textOf(expand(tree)).includes('挑几句进卡里'), textOf(expand(tree)).slice(0, 400))
}

{
  // 文案门禁补两条：不许把绝对路径摆给用户看，也不许把 markdown 的星号漏出来。
  const doorsWords = textOf(expand(renderRoot('选门（路径不摆出来）', base('doors'))))
  t('选门那一屏不显示绝对路径', doorsWords.includes('/tmp/x') === false, doorsWords.slice(0, 300))
  t('只说档案在选的那个文件夹里', doorsWords.includes('档案就在你选的那个文件夹里'), doorsWords.slice(0, 300))

  const analyze = textOf(expand(renderRoot('分析页（不放星号）', base('analyze'))))
  t('界面文案不漏 markdown 的星号', analyze.includes('**') === false, analyze.slice(0, 300))
  t('导入那一屏也说清只认原文', textOf(expand(renderRoot('导入（文案）', base('import')))).includes('只认原文里写过的'), '')

{
  // 访谈结束点「整理进卡里」时必须带上一路上写下的材料路径。
  // 不带的话分析页一条都不勾，而「一条都不勾」= 全读——别人说的也被读进这张卡。
  let got = null
  // InterviewView 槽：0 phase / 1 name / 2 relation / 12 busy / 14 aboutId / 15 dropped / 16 materialPaths
  const tree = renderOne('访谈结束（带着材料去整理）', seen.get('InterviewView'), {
    state: STATE, listing: LISTING, preset: { id: 'mama', name: '妈妈' },
    onRecorded: async () => {}, flash: () => {}, onDone: () => {}, mode: 'real',
    onAnalyze: (about) => { got = about },
  }, { 0: 'done', 1: '妈妈', 14: 'mama', 16: ['materials/m1.md', 'materials/m2.md'] })
  const btn = flatButtons(expand(tree)).find((b) => textOf(b).includes('整理进卡里'))
  if (btn !== undefined) btn.props.onClick()
  t('整理进卡里带上了材料路径', got !== null && Array.isArray(got.materials) && got.materials.length === 2, JSON.stringify(got))
  t('带的是那两份材料', got !== null && got.materials.includes('materials/m1.md'), JSON.stringify(got))
}

}

// 2026-10-26：「开始读」一直转圈，用户以为卡死了。
// 这一趟是真的慢（模型先想一遍再写），所以必须把时间预期说出来，
// 长材料还要再说清楚会更慢——否则转圈半分钟人就点第二次了。
{
  const view = seen.get('AnalyzeView')
  const LIST = { ok: true, workspace: '/tmp/x', cards: [{ id: 'mama', path: 'cards/mama.card.md', name: '妈妈', kind: 'real', coverage: 62 }], materials: [{ path: 'materials/a.md', name: 'a.md', chars: 800 }], errors: [], proposals: [] }
  const props = { listing: LIST, state: { ok: true, workspace: '/tmp/x', exists: true }, presetAbout: { id: 'mama', name: '妈妈' }, presetMaterials: null, flash: () => {}, onProposal: () => {}, onBack: () => {}, onNeedMaterial: () => {} }

  // 忙：按钮字变了，并且有一句时间预期
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })
  let tree = renderOne('分析（正在读）', view, props, { 0: 'mama', 2: true, 3: null, 4: null, 10: null })
  let text = textOf(expand(tree))
  t('忙着的时候按钮上写着「正在读」', text.includes('正在读'))
  t('忙着的时候说清要等多久，别让人以为卡死了', text.includes('半分钟到一分钟'))
  t('还没开始读时不说这句', !textOf(expand(renderOne('分析（没在读）', view, props, { 0: 'mama', 2: false, 3: null, 4: null, 10: null }))).includes('半分钟到一分钟'))

  // 长材料：说清会更慢，并给出大概多少千字
  const BIG = { ...LIST, materials: [{ path: 'materials/big.md', name: 'big.md', chars: 45263 }] }
  tree = renderOne('分析（长材料）', view, { ...props, listing: BIG }, { 0: 'mama', 2: true, 3: null, 4: null, 10: null })
  text = textOf(expand(tree))
  t('材料长的时候说清会更慢', text.includes('一两分钟'))
  t('长材料时把字数说出来', text.includes('45 千字') || text.includes('45千字'))
}


// ── 读不到的东西要说清楚；删不掉的入口要真的有 ──────────────────────
// 这一组是「界面一声不响」的现场：材料里混了备份文件、有文件读不了、
// 一份材料都没选、书架上删不掉。都是用户看得见、但界面上没话说的地方。

{
  // 存材料是先写临时文件再改名。改名那一步被打断，就留下 `.妈妈.md.bak-1234`
  // 这种残骸，它一直被当成一份材料摆在列表里：用户看到两份「妈妈」，
  // 点开其中一份是空的，还以为自己写丢了。
  const JUNK = {
    ...LISTING,
    cards: [{ id: 'sera', path: 'cards/sera.card.md', name: 'Sera', kind: 'fictional', coverage: 50 }],
    materials: [
      { path: 'materials/mama.md', name: '妈妈访谈.md', chars: 800 },
      { path: 'materials/.mama.md.bak-1234', name: '.妈妈访谈.md.bak-1234', chars: 0 },
      { path: 'materials/mama.md.tmp-99', name: '妈妈访谈.md.tmp-99', chars: 0 },
    ],
  }
  // 材料栏只在「真实人物记录」那扇门里铺开；写小说那扇门只报一个数字。
  const realText = textIn(expand(renderRoot('首页（材料里混了备份文件）', base('home', { 2: { ...JUNK, cards: [{ id: 'mama', path: 'cards/mama.card.md', name: '妈妈', kind: 'real', coverage: 60 }] } }))))
  t('材料栏只算真的那几份', realText.includes('材料 · 1'), realText.slice(0, 400))
  t('备份文件不摆在材料列表里', !realText.includes('bak') && !realText.includes('tmp'), realText.slice(0, 400))
  const novelText = textIn(expand(renderRoot('小说门（材料里混了备份文件）', base('novel', { 2: JUNK }))))
  t('「读那 N 段材料」也只算真的', novelText.includes('读那 1 段材料'), novelText.slice(0, 400))
}

{
  // 只报「有 5 个文件读不了」等于没说：用户不知道是哪几个，只能一格一格翻。
  const BROKEN = {
    ...LISTING,
    errors: [
      { path: 'people/妈妈.card.md', error: '读不出来' },
      { path: 'people/老张.card.md', error: '读不出来' },
      { path: 'worlds/长夜.world.md', error: '读不出来' },
      { path: 'people/阿吉.card.md', error: '读不出来' },
      { path: 'people/小满.card.md', error: '读不出来' },
    ],
  }
  const text = textIn(expand(renderRoot('首页（有文件读不了）', base('home', { 2: BROKEN }))))
  t('说清有几个文件读不了', text.includes('5 个文件读不了'), text.slice(0, 500))
  t('把读不了的几个名字点出来', text.includes('「妈妈」') && text.includes('「老张」'), text.slice(0, 500))
  t('超过三个就收成「还有 N 个」', text.includes('还有 2 个'), text.slice(0, 500))
  t('不把文件路径摆到界面上', !text.includes('.card.md') && !text.includes('people/'), text.slice(0, 500))
  t('说清别的没受影响', text.includes('没影响别的'), text.slice(0, 500))
}

{
  // 首页这条路：访谈没收下材料，分析页不许把「空」当成「没指定」。
  const page = renderRoot('首页（聊完一场没记下材料）', base('analyze', { 9: { name: '林小雨' }, 14: [] }))
  const pageText = textIn(expand(page))
  t('从首页进分析页时空清单停在「一份都没选」', pageText.includes('现在一份都没选'), pageText.slice(0, 400))
}

{
  const view = seen.get('AnalyzeView')
  const LIST = {
    ok: true, workspace: '/tmp/x',
    cards: [{ id: 'mama', path: 'cards/mama.card.md', name: '妈妈', kind: 'real', coverage: 62 }],
    materials: [
      { path: 'materials/a.md', name: 'a.md', chars: 800, size: 2048 },
      { path: 'materials/b.md', name: 'b.md', chars: 900, size: 2048 },
    ],
    errors: [], proposals: [],
  }
  const props = { listing: LIST, state: { ok: true, workspace: '/tmp/x', exists: true }, presetAbout: { id: 'mama', name: '妈妈' }, presetMaterials: null, flash: () => {}, onProposal: () => {}, onBack: () => {}, onNeedMaterial: () => {} }

  // 默认：一份都没挑 = 全读。
  const all = renderOne('分析（默认全读）', view, props, { 0: '妈妈', 1: null, 2: false, 3: null, 4: null, 10: null })
  const allText = textOf(expand(all))
  t('默认说清「不选 = 全读」', allText.includes('不选 = 全读'), allText.slice(0, 400))
  const allBtn = collectIn(expand(all), (n) => n.type === 'button' && textOf(n).includes('开始读'))[0]
  t('默认状态下「开始读」点得动', allBtn?.props?.disabled !== true, JSON.stringify(allBtn?.props?.disabled))

  // 一份都不选（明确取消）：不许再偷偷全读，按钮也得灰掉并说清怎么办。
  const none = renderOne('分析（一份都不选）', view, props, { 0: '妈妈', 1: [], 2: false, 3: null, 4: null, 10: null })
  const noneText = textOf(expand(none))
  t('一份都没选时把话说清楚', noneText.includes('现在一份都没选'), noneText.slice(0, 400))
  t('并说清该怎么办', noneText.includes('至少选一份'), noneText.slice(0, 400))
  const noneBtn = collectIn(expand(none), (n) => n.type === 'button' && textOf(n).includes('开始读'))[0]
  t('一份都没选时「开始读」是灰的', noneBtn?.props?.disabled === true, JSON.stringify(noneBtn?.props?.disabled))

  // 从「全读」里点掉一份：不是回弹成全读，而是「只读剩下的那几份」。
  // 注意别用 expand() 再找一遍：展开会重挂组件、状态就丢了，点下去写的是
  // 另一份槽位。renderOne 已经把整棵树展开好，直接在里面找那一行。
  const picked = renderOne('分析（点掉一份）', view, props, { 0: '妈妈', 1: null, 2: false, 3: null, 4: null, 10: null })
  const row = collectIn(picked, (n) => typeof n.props?.onClick === 'function' && textOf(n).includes('a.md'))[0]
  t('材料行点得动', row !== undefined, textOf(picked).slice(0, 300))
  row?.props?.onClick()
  const after = hookStore[1]
  t('点掉一份之后只剩另一份（不是又变回全读）',
    Array.isArray(after) && after.length === 1 && String(after[0]).includes('b.md'), JSON.stringify(after))

  const onlyOne = renderOne('分析（只挑了一份）', view, props, { 0: '妈妈', 1: ['materials/b.md'], 2: false, 3: null, 4: null, 10: null })
  t('只挑一份的时候说「已选 1 份」', textOf(expand(onlyOne)).includes('已选 1 份'), textOf(expand(onlyOne)).slice(0, 400))

  // 点掉最后一份：停在「一份都不读」，不许回弹成全读。
  const lastOne = renderOne('分析（点掉最后一份）', view, props, { 0: '妈妈', 1: ['materials/b.md'], 2: false, 3: null, 4: null, 10: null })
  const lastRow = collectIn(lastOne, (n) => typeof n.props?.onClick === 'function' && textOf(n).includes('b.md'))[0]
  t('最后一份也点得动', lastRow !== undefined, textOf(lastOne).slice(0, 300))
  lastRow?.props?.onClick()
  t('点掉最后一份后停在一份都不读（不是又变回全读）',
    Array.isArray(hookStore[1]) && hookStore[1].length === 0, JSON.stringify(hookStore[1]))

  // 一场访谈一句材料都没记下：带过来的清单是空的，页面必须停在「一份不读」。
  // 以前空清单被折成「没指定」，一按「开始读」把别人的材料一起读了。
  const fromTalk = renderOne('分析（访谈没记下材料）', view, { ...props, presetMaterials: [] }, { 0: '妈妈', 2: false, 3: null, 4: null, 10: null })
  const fromTalkText = textOf(expand(fromTalk))
  t('访谈没记下材料时停在「一份都没选」', fromTalkText.includes('现在一份都没选'), fromTalkText.slice(0, 400))
  t('并说清要自己挑材料', fromTalkText.includes('至少选一份'), fromTalkText.slice(0, 400))
  const fromTalkBtn = collectIn(expand(fromTalk), (n) => n.type === 'button' && textOf(n).includes('开始读'))[0]
  t('这时「开始读」是灰的', fromTalkBtn?.props?.disabled === true, JSON.stringify(fromTalkBtn?.props?.disabled))
}

{
  // 书架：`拿掉这本书`后台一直有，界面从来没接过，用户只能在文件管理器里翻目录。
  const SHELF = { ...LISTING, cards: [{ id: 'sera', path: 'cards/sera.card.md', name: 'Sera', kind: 'fictional', coverage: 50 }] }
  const tree = renderRoot('写小说门（书架上有书）', base('novel', { 2: SHELF, 26: [{ id: 'b1', title: '长夜' }] }))
  const words = textIn(expand(tree))
  t('书架上每本书都有「不要这本了」', words.includes('不要这本了'), words.slice(0, 400))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
