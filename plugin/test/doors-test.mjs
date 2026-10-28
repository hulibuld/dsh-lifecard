// 「我在哪扇门里」必须跟着人走，不能靠「当前在哪一屏」去猜。
//
// 真事故（用户 2026-10-24 报）：开酒馆、开写小说，点「聊着建」，界面都在说
// 「你在记录一个现实里的人」。根因是 mode 从 view 推——一进访谈页 view 就是
// interview，推出来只能是 real。
//
// 为什么必须单独一个测试文件：render-all.mjs 是「给组件直接塞 mode」的写法，
// 它测的是「拿到 mode 之后画得对不对」，测不出「点门之后 mode 有没有跟上」。
// 这条路径只有真的点一遍才看得见，所以这里用会记录调用的假组件从根部点下去。
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const t = (n, c, x) => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, x === undefined ? '' : String(x).slice(0, 400)) } }

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ── 假 React（只够把根组件跑起来并留下 hook 槽）──────────────────
let hookStore = []
let hookIndex = 0
const fakeReact = {
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

const module = { exports: {} }
const openAt = source.indexOf('factory: (require) => {')
const closeAt = source.lastIndexOf('\n});')
let body = source.slice(openAt + 'factory: (require) => {'.length, closeAt)
body = body.replace(/\}\s*$/, '')
const factory = new Function('require', 'module', 'exports', 'window', 'document', body + '\n')
const api = factory(fakeRequire, module, module.exports, fakeWindow, document)

const registered = []
api.apply({
  get: (name) => (name === 'betterSidebar' ? { registerTab: (d) => { registered.push(d); return () => {} } } : undefined),
  effect: (fn) => { fn(); return () => {} },
})
const Root = api.LifeCardTab

// ── 一路展开，把「函数型节点」都渲染掉，留下纯 DOM 树 ──────────
// 顺便记下每一个组件被调用时收到的 props：门的名字就是这么传下去的。
const seenProps = new Map()
const rendered = []

function deepRender(node, depth = 0) {
  if (node === null || node === undefined || depth > 45) return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map((n) => deepRender(n, depth + 1)).filter((n) => n !== null)
  if (typeof node !== 'object') return null
  if (typeof node.type === 'function') {
    const name = node.type.name || ''
    if (name !== '') {
      seenProps.set(name, node.props ?? {})
      rendered.push({ name, props: node.props ?? {} })
    }
    const savedStore = hookStore
    const savedIndex = hookIndex
    // 子组件各自一份状态，不然整棵树会共用一个槽位数组
    if (name !== 'LifeCardTab') { hookStore = []; hookIndex = 0 }
    let out
    try { out = node.type(node.props ?? {}) } finally { hookStore = savedStore; hookIndex = savedIndex }
    return deepRender(out, depth + 1)
  }
  return { type: node.type, props: node.props ?? {}, children: deepRender(node.props?.children, depth + 1) }
}

function findNodes(node, pred, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const n of node) findNodes(n, pred, out); return out }
  if (typeof node !== 'object') return out
  if (pred(node)) out.push(node)
  findNodes(node.children, pred, out)
  return out
}
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node !== 'object') return ''
  return textOf(node.children)
}
const clickButtonWith = (tree, wanted) => {
  const hit = findNodes(tree, (n) => n.type === 'button' && typeof n.props?.onClick === 'function' && textOf(n).includes(wanted))[0]
  if (hit === undefined) return false
  hit.props.onClick()
  return true
}

const STATE = {
  ok: true, workspace: '/tmp/x', exists: true, home: '/Users/joy',
  hasLlm: true, defaults: { workspace: '/tmp/x' }, summary: {}, relations: [],
}
const LISTING = {
  ok: true, workspace: '/tmp/x', cards: [], worlds: [], systems: [], relations: [],
  materials: [], errors: [], proposals: [], avatars: {},
}

/** 从头渲染一次根组件（hook 槽由 presets 指定）。 */
function renderRoot(presets = {}) {
  hookIndex = 0
  hookStore = []
  for (const [k, v] of Object.entries(presets)) hookStore[Number(k)] = v
  const tree = Root({ visible: true })
  return deepRender(tree)
}

// 根组件的槽：0 view / 1 state / 2 listing / 3 busy / 4 error / 5 toast /
// 6 activeCard / 7 proposal / 8 doctor / 9 interviewFor / 10 showMore /
// 11 activeWorld / 12 pendingAbout / 13 introSeen / 14 materialFor / 15 ref /
// 16 chat / 17 chats / 24 door / 25 activeBook / 26 books（实测，每次加 state 都要重探）
const base = (view, extra = {}) => ({ 0: view, 1: STATE, 2: LISTING, 3: '', 4: null, 5: null, 6: null, 7: null, 8: null, 9: null, 10: false, 11: null, 12: '', 13: true, 14: null, ...extra })

console.log('\n=== 1. 点哪扇门，「聊着建」就说哪扇门的话 ===')
for (const [doorLabel, doorId, expectWord, forbidWord] of [
  ['真实人物记录', 'real', '现实里的人', null],
  ['写小说', 'novel', '小说角色', '现实里的人'],
  ['酒馆', 'tavern', '可以演的虚构角色', '现实里的人'],
]) {
  // ① 进门口那一屏，点门的名字
  const doors = renderRoot(base('doors'))
  const picked = clickButtonWith(doors, doorLabel)
  if (!picked) { t(`找得到「${doorLabel}」这扇门`, false, textOf(doors).slice(0, 200)); continue }
  const viewAfterDoor = hookStore[0]
  t(`点「${doorLabel}」进到那一屏`, viewAfterDoor === (doorId === 'real' ? 'home' : doorId), String(viewAfterDoor))

  // ② 在那一扇门的首页点「聊着建」（酒馆那扇门是「立一个人」，写小说也是）
  const home = renderRoot({ ...base(viewAfterDoor), 24: doorId })
  const wanted = doorId === 'real' ? '陪我聊聊' : (doorId === 'tavern' ? '聊着立一个能演的角色' : '聊着立一个小说角色')
  const clicked = clickButtonWith(home, wanted)
  const viewAfterClick = hookStore[0]
  t(`「${doorLabel}」里点得动聊着建`, clicked === true)
  t(`点完进到聊着建那一屏（${doorLabel}）`, viewAfterClick === 'interview', String(viewAfterClick))

  // ③ 关键：这一屏说的话，是不是这一扇门的
  const interview = renderRoot({ ...base('interview'), 24: doorId })
  const words = textOf(interview)
  t(`「${doorLabel}」的聊着建说的是「${expectWord}」`, words.includes(expectWord), words.slice(0, 300))
  if (forbidWord !== null) {
    t(`「${doorLabel}」的聊着建不再说「${forbidWord}」`, !words.includes(forbidWord), words.slice(0, 300))
  }
}

console.log('\n=== 2. 门记住之后，进别的子页面也不丢 ===')
{
  // 从酒馆门进「聊着建」，再进卡片页、分析页——门还是酒馆
  for (const view of ['interview', 'card', 'analyze', 'import', 'newCard']) {
    const tree = renderRoot({ ...base(view), 24: 'tavern' })
    const json = JSON.stringify(seenProps.get('HomeView') ?? {})
    // 只有首页类视图才会渲染 HomeView；别的时候检查标题栏那句话
    if (view === 'interview') {
      const words = textOf(tree)
      t(`酒馆门进「${view}」还认得是酒馆`, words.includes('可以演的虚构角色') || words.includes('酒馆'), words.slice(0, 200))
    } else if (view === 'card') {
      t(`酒馆门进「${view}」不变成真实人物门`, !textOf(tree).includes('贴一份招聘说明'), textOf(tree).slice(0, 200))
    } else {
      t(`酒馆门进「${view}」不崩`, tree !== null)
    }
  }
}

console.log('\n=== 3. 没选过门时按真实人物算（老用户直接进首页也不会错）===')
{
  const home = renderRoot({ ...base('home') })
  const words = textOf(home)
  t('默认那扇门是真实人物记录', words.includes('下一步') || words.includes('认识的人') || words.includes('还没有档案'), words.slice(0, 200))
}

console.log('\n=== 4. 列表里能直接删卡（不用先进去滚到底）===')
{
  // 真事故：建错几张（比如「复制一份来演」试了几次），想删就得先点开卡、
  // 滚到最下面才找得到删除——列表里完全删不了。
  const listing = {
    ok: true, workspace: '/tmp/x', errors: [], materials: [], worlds: [], proposals: [], avatars: {},
    cards: [
      { id: 'lin', path: 'people/lin.card.md', name: '林小雨', kind: 'fictional', coverage: 40, tags: [] },
      { id: 'mama', path: 'people/mama.card.md', name: '妈妈', kind: 'real', relation: '母亲', coverage: 62, tags: [] },
    ],
  }
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') })
    return { ok: true, json: async () => ({ ok: true, exists: true, workspace: '/tmp/x', relations: [], cards: [], materials: [], worlds: [], proposals: [], errors: [] }) }
  }
  try {
    const tree = renderRoot({ ...base('home'), 2: listing })
    // 每张卡旁边都得有一个「删掉「X」」的按钮
    const trash = findNodes(tree, (n) => n.type === 'button' && typeof n.props?.title === 'string' && n.props.title.startsWith('删掉'))
    // 卡有正反两面，两面各留一个删除入口（翻到背面也能删），所以每张卡两个。
    const trashNames = [...new Set(trash.map((b) => b.props.title))]
    t('列表里每张卡都有删除按钮', trashNames.length === 2, trashNames)
    t('删除按钮带名字，不会删错人', trash.some((b) => b.props.title.includes('林小雨')) && trash.some((b) => b.props.title.includes('妈妈')), trash.map((b) => b.props.title))

    // 点一下：先问一句，问的话要说清后果
    const asked = []
    const realConfirm = fakeWindow.confirm
    fakeWindow.confirm = (msg) => { asked.push(String(msg)); return true }
    const lin = trash.find((b) => b.props.title.includes('林小雨'))
    lin.props.onClick({ stopPropagation() {} })
    await new Promise((r) => setTimeout(r, 40))
    t('删之前先问一句', asked.length === 1, asked)
    t('问的时候说清卡里的东西一起没', asked[0].includes('一起删掉'), asked[0])
    t('并且说清材料不受影响', asked[0].includes('材料是另一份文件'), asked[0])
    const del = calls.find((c) => c.url.includes('card.delete'))
    t('真的发了删除请求', del !== undefined, calls.map((c) => c.url.split('/').pop()))
    t('删的是点的那一张，不是第一张', String(del?.body ?? '').includes('people/lin.card.md'), del?.body)

    // 点「取消」就什么都不做
    fakeWindow.confirm = () => false
    calls.length = 0
    const again = renderRoot({ ...base('home'), 2: listing })
    const lin2 = findNodes(again, (n) => n.type === 'button' && typeof n.props?.title === 'string' && n.props.title.includes('林小雨'))[0]
    lin2.props.onClick({ stopPropagation() {} })
    await new Promise((r) => setTimeout(r, 30))
    t('点取消就一个请求都不发', calls.filter((c) => c.url.includes('card.delete')).length === 0, calls.map((c) => c.url.split('/').pop()))
    fakeWindow.confirm = realConfirm
  } finally {
    globalThis.fetch = realFetch
  }
}

console.log('\n=== 5. 「还等着你看的建议」只在它那扇门里提醒 ===')
{
  // 真事故（用户 2026-10-25 报）：在酒馆里写着小说，头顶一直挂着
  // 「关于『妈妈』的建议」；记录真人的时候又挂着小说角色的建议。
  const listing = {
    ok: true, workspace: '/tmp/x', errors: [], materials: [], worlds: [], avatars: {},
    cards: [
      { id: 'mama', path: 'people/mama.card.md', name: '妈妈', kind: 'real', relation: '母亲', coverage: 60, tags: [] },
      { id: 'lin', path: 'people/lin.card.md', name: '林小雨', kind: 'fictional', coverage: 40, tags: [] },
    ],
    proposals: [
      { json: 'proposals/mama.json', about: '妈妈', accepted: 3, adopted: 0, rejected: 0, generated_at: '2026-10-25' },
      { json: 'proposals/lin.json', about: '林小雨', accepted: 2, adopted: 0, rejected: 0, generated_at: '2026-10-25' },
      { json: 'proposals/nobody.json', about: '还没有卡的人', accepted: 1, adopted: 0, rejected: 0, generated_at: '2026-10-25' },
    ],
  }
  // 只截「还等着你看的建议」那一段：卡列表里出现虚构角色是正常的
  // （真人那扇门也让人看见所有卡），要验的是**建议那一栏**有没有串门。
  const proposalsPart = (text) => {
    const i = text.indexOf('还等着你看的建议')
    return i < 0 ? '' : text.slice(i)
  }

  // 现实那扇门（view=home）：只该看见妈妈 + 还没建卡的那个人
  const real = textOf(renderRoot({ ...base('home'), 2: listing }))
  const realP = proposalsPart(real)
  t('现实门里有「还等着你看的建议」这一栏', realP !== '', real.slice(0, 200))
  t('现实门里能看见「关于「妈妈」」', realP.includes('妈妈'), realP.slice(0, 200))
  t('现实门里看不见虚构角色林小雨的建议', !realP.includes('林小雨'), realP.slice(0, 200))
  t('现实门里能看见还没建卡那个人的建议（它也可能是真人）', realP.includes('还没有卡的人'), '')

  // 写小说那扇门：只该看见林小雨
  const novelDoor = textOf(renderRoot({ ...base('novel'), 2: listing, 24: 'novel' }))
  const novelP = proposalsPart(novelDoor)
  t('写小说门里能看见林小雨的建议', novelP.includes('林小雨'), novelP.slice(0, 200))
  t('写小说门里看不见妈妈的建议', !novelP.includes('妈妈'), novelP.slice(0, 200))

  // 酒馆那扇门：虚构角色照样算它这扇门的
  const tavernDoor = textOf(renderRoot({ ...base('tavern'), 2: listing, 24: 'tavern' }))
  const tavernP = proposalsPart(tavernDoor)
  t('酒馆门里能看见虚构角色的建议', tavernP.includes('林小雨'), tavernP.slice(0, 200))
  t('酒馆门里看不见真人的建议', !tavernP.includes('妈妈'), tavernP.slice(0, 200))
}

console.log('\n=== 6. 酒馆门里点卡是「打开这张卡」，不是直接开演 ===')
await (async () => {
  // 用户报的：在「可以拿来演的角色」里点一张卡，直接就开了一场新对话，
  // 想先看看这张卡上写了什么都做不到。
  const LIN = { id: 'lin', path: 'people/lin.card.md', name: '林小雨', kind: 'fictional', coverage: 40, tags: [] }
  const LIST = {
    ok: true, workspace: '/tmp/x', errors: [], materials: [], worlds: [], proposals: [], avatars: {},
    cards: [LIN, { id: 'mama', path: 'people/mama.card.md', name: '妈妈', kind: 'real', relation: '母亲', coverage: 62, tags: [] }],
  }
  const CARD = {
    ok: true, path: 'people/lin.card.md',
    data: { lifecard: '0.1', id: 'lin', kind: 'fictional', world: 'reality', name: '林小雨' },
    sections: [{ title: '自述', body: '她在便利店上夜班。' }],
    validation: { ok: true, issues: [] },
    coverage: { percent: 40, filled: 3, empty: [{ label: '口癖' }], rows: [], sourceLevels: [], unmarkedRatio: 0 },
  }
  const calls = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: String(init?.body ?? '') })
    return { ok: true, json: async () => ({ ok: true, exists: true, workspace: '/tmp/x', relations: [], cards: [], materials: [], worlds: [], proposals: [], errors: [], items: [] }) }
  }
  try {
    const tavernHome = renderRoot({ ...base('tavern'), 2: LIST, 24: 'tavern', 17: [] })
    // 卡面正面只有头像和名字，名字下面是「详细信息」；点这张卡本身是翻面。
    const cardBtn = findNodes(tavernHome, (n) => n.type === 'button' && textOf(n).includes('详细信息'))[0]
    t('酒馆门里看得到那张卡', textOf(tavernHome).includes('林小雨') && cardBtn !== undefined, textOf(tavernHome).slice(0, 300))
    if (cardBtn !== undefined) {
      cardBtn.props.onClick()
      // openCard 会先等 card.get 回来再切屏，所以要让出一轮
      await new Promise((r) => setTimeout(r, 10))
      t('点卡是打开这张卡', hookStore[0] === 'card', String(hookStore[0]))
    }
    t('点卡不会直接开一场新会话', calls.filter((c) => c.url.includes('tavern.start')).length === 0, calls.map((c) => c.url.split('/').pop()))

    // 卡页上不再有「和 TA 演一段」：演不演由列表里那个圆点决定
    const tavernCard = renderRoot({ ...base('card'), 2: LIST, 6: CARD, 24: 'tavern' })
    t('卡页上没有「和 TA 演一段」', !textOf(tavernCard).includes('和 TA 演一段'), textOf(tavernCard).slice(0, 300))
  } finally {
    globalThis.fetch = realFetch
  }
})()

console.log('\n=== 6b. 列表里能直接进修改（不用先点开再去卡页上找） ===')
{
  const LIST = {
    ok: true, workspace: '/tmp/x', errors: [], materials: [], worlds: [], proposals: [], avatars: {},
    cards: [{ id: 'lin', path: 'people/lin.card.md', name: '林小雨', kind: 'fictional', coverage: 10, tags: [] }],
  }
  const tree = renderRoot({ ...base('tavern'), 2: LIST, 24: 'tavern' })
  const editBtn = findNodes(tree, (n) => n.type === 'button' && typeof n.props?.title === 'string' && n.props.title.startsWith('改'))[0]
  t('每张卡都有「改」按钮', editBtn !== undefined, textOf(tree).slice(0, 200))
  if (editBtn !== undefined) t('「改」按钮带名字，不会点错人', editBtn.props.title.includes('林小雨'), editBtn.props.title)
}

console.log('\n=== 6c. 每扇门都能先挑「现在用哪张卡」 ===')
{
  const LIST = {
    ok: true, workspace: '/tmp/x', errors: [], materials: [], worlds: [], proposals: [], avatars: {},
    cards: [
      { id: 'lin', path: 'people/lin.card.md', name: '林小雨', kind: 'fictional', coverage: 40, tags: [] },
      { id: 'mama', path: 'people/mama.card.md', name: '妈妈', kind: 'real', relation: '母亲', coverage: 62, tags: [] },
    ],
  }
  for (const [view, doorId, want, pinId] of [
    ['tavern', 'tavern', '现在演谁', 'lin'],
    ['novel', 'novel', '现在写谁', 'lin'],
    ['home', 'real', '这扇门先看谁', 'mama'],
  ]) {
    const pins = { real: doorId === 'real' ? pinId : '', tavern: doorId === 'tavern' ? pinId : '', novel: doorId === 'novel' ? pinId : '' }
    const tree = renderRoot({ ...base(view), 2: LIST, 24: doorId, 29: pins })
    const words = textOf(tree)
    t(`${doorId} 那扇门能挑「${want}」`, words.includes(want), words.slice(0, 260))
    // 不再有下拉框：改成每张卡右上角一个圆点
    t(`${doorId} 不再用下拉框挑卡`, findNodes(tree, (n) => n.type === 'select').length === 0)
    const dots = findNodes(tree, (n) => n.type === 'button' && n.props?.['data-pinned'] !== undefined)
    // 这扇门里真正列出来的卡：酒馆/小说只列虚构角色，现实那扇门列真人。
    const listed = doorId === 'real' ? LIST.cards : LIST.cards.filter((c) => c.kind === 'fictional')
    t(`${doorId} 每张列出来的卡都有右上角的圆点`, dots.length === listed.length, dots.length)
    const green = dots.filter((n) => n.props['data-pinned'] === 'yes')
    t(`${doorId} 选着的那张是绿的`, green.length === 1 && green[0].props.style.background === 'var(--lc-doctor)', green.map((n) => n.props.title))
    const red = dots.filter((n) => n.props['data-pinned'] === 'no')
    t(`${doorId} 没选的是红的`, red.length === dots.length - green.length && red.every((n) => n.props.style.background === 'var(--lc-danger-soft)'), red.length)
    if (doorId === 'tavern') {
      const greenDot = green[0]
      const posted = []
      const realFetch = globalThis.fetch
      globalThis.fetch = async (url, init) => {
        posted.push({ url: String(url), body: String(init?.body ?? '') })
        return { ok: true, json: async () => ({ ok: true }) }
      }
      try {
        greenDot.props.onClick({ stopPropagation() {} })
        await new Promise((r) => setTimeout(r, 10))
      } finally {
        globalThis.fetch = realFetch
      }
      t('点绿的那张会取消（空 id 也发得出去）', posted.some((c) => c.body.includes('"id":""')), posted.map((c) => c.body).slice(0, 2))
      // 没挑卡时页面上要说清楚「这一场不读卡上的设定」。
      const none = renderRoot({ ...base('tavern'), 2: LIST, 24: 'tavern', 29: { real: '', tavern: '', novel: '' } })
      const noneWords = textOf(none)
      t('没挑卡时酒馆说清不读卡上的设定', noneWords.includes('不读卡上的设定') && noneWords.includes('把人立起来'), noneWords.slice(0, 300))
      const novelNone = renderRoot({ ...base('novel'), 2: LIST, 24: 'novel', 29: { real: '', tavern: '', novel: '' } })
      t('没挑卡时写小说说清不读设定', textOf(novelNone).includes('只按写作方法来写'), textOf(novelNone).slice(0, 300))
    }
  }
}

console.log('\n=== 7. 卡列表里的百分比要说明白是什么 ===')
{
  const LIST = {
    ok: true, workspace: '/tmp/x', errors: [], materials: [], worlds: [], proposals: [], avatars: {},
    cards: [{ id: 'lin', path: 'people/lin.card.md', name: '林小雨', kind: 'fictional', coverage: 10, tags: [] }],
  }
  const words = textOf(renderRoot({ ...base('home'), 2: LIST }))
  t('百分比旁边写着「写全」', words.includes('写全 10%'), words.slice(0, 200))
  t('不再只甩一个裸数字', !/(^|[^全 ])10%/.test(words.replace('写全 10%', '')), words.slice(0, 200))
}

console.log('\n=== 13. 门能收起来，也能装回来 ===')
{
  // 三扇门都在的时候：每扇门上都藏着一个「收起来」的按钮（鼠标放上去才露）
  const full = renderRoot(base('doors'))
  const hides = findNodes(full, (n) => typeof n.props?.['data-door-hide'] === 'string')
  t('三扇门各有一个收起来的按钮', hides.length === 3, hides.map((n) => n.props['data-door-hide']))
  t('没有收起来的门就没有灰门', findNodes(full, (n) => typeof n.props?.['data-door-dead'] === 'string').length === 0, '')

  // 收掉酒馆之后：酒馆那块不摆了，改摆一块灰黑的门
  const one = renderRoot(base('doors', { 1: { ...STATE, hidden_doors: ['tavern'] } }))
  const tree = one
  const dead = findNodes(tree, (n) => typeof n.props?.['data-door-dead'] === 'string')
  t('收起来的门变成一块灰门', dead.length === 1 && dead[0].props['data-door-dead'] === 'tavern', dead.length)
  t('灰门上没有「推门进去」', !textOf(dead[0]).includes('推门进去'), textOf(dead[0]).slice(0, 40))
  const backs = findNodes(tree, (n) => typeof n.props?.['data-door-show'] === 'string')
  t('灰门上有装回来的按钮', backs.length === 1 && backs[0].props['data-door-show'] === 'tavern', backs.length)

  // 点「装回来」要真的发请求
  const posts = []
  const before = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    posts.push(`${String(url)} ${String(init?.body ?? '')}`)
    return { ok: true, status: 200, json: async () => ({ ok: true, hidden_doors: [] }) }
  }
  await backs[0].props.onClick()
  globalThis.fetch = before
  t('装回来会请求把门放出来', posts.some((b) => b.includes('door.set') && b.includes('"hidden":false')), posts)
}

{
  // 2026-10-28：卡从「一行字」改成「一张卡」——正面只有头像和名字，
  // 点卡片翻面看简介；门上的删除入口是垃圾桶（叉容易看成「关闭」）。
  const cabinet = {
    cards: [
      { id: 'lin', path: 'people/lin.card.md', name: '林小雨', kind: 'fictional', coverage: 40, tags: [], intro: '在城南的旧书店做事。' },
    ],
    worlds: [], relations: [], materials: [], proposals: [], errors: [], systems: [], redactions: [],
  }
  const tree = renderRoot({ ...base('tavern'), 2: cabinet, 24: 'tavern', 17: [] })
  const faces = findNodes(tree, (n) => n.type === 'div' && n.props?.['data-face'] !== undefined)
  const front = faces.filter((n) => n.props['data-face'] === 'front')
  const back = faces.filter((n) => n.props['data-face'] === 'back')
  t('每张卡都有正反两面', front.length >= 1 && back.length === front.length, `${front.length}/${back.length}`)
  const frontText = front.map((n) => textOf(n)).join(' ')
  const backText = back.map((n) => textOf(n)).join(' ')
  t('正面只有名字和一个「详细信息」', frontText.includes('林小雨') && frontText.includes('详细信息'), frontText.slice(0, 160))
  t('正面不铺简介和百分比', !frontText.includes('写全') && !frontText.includes('这张卡还没写自述'), frontText.slice(0, 160))
  t('背面写简介和「写全多少」', backText.includes('写全 40%') && backText.includes('在城南的旧书店做事'), backText.slice(0, 160))
  t('点正面会翻面', typeof front[0]?.props?.onClick === 'function', typeof front[0]?.props?.onClick)
  t('点背面会翻回来', typeof back[0]?.props?.onClick === 'function', typeof back[0]?.props?.onClick)

  // 收起来的按钮在「选门」那一屏，不在门里的首页。
  const doorsScreen = renderRoot(base('doors'))
  const hides = findNodes(doorsScreen, (n) => n.type === 'button' && n.props?.['data-door-hide'] !== undefined)
  // 叉容易被读成「关闭」，所以按钮里不再有「×」这两个字，只剩一个图标。
  t('收起按钮不再写成「×」', hides.length === 3 && !hides.some((b) => textOf(b).includes('×')), hides.map((b) => textOf(b)))
  t('收起按钮的提示写的是「收起来」', hides.every((b) => String(b.props?.title ?? '').includes('收起来')), hides.map((b) => b.props?.title))

  // 收起来的那扇门：灰黑，放上去能装回来，并且列清里面有什么（分模块，装回来方便）
  const dead = renderRoot(base('doors', { 1: { ...STATE, hidden_doors: ['novel', 'tavern'] } }))
  const deadNodes = findNodes(dead, (n) => n.type === 'div' && n.props?.['data-door-dead'] !== undefined)
  const deadText = deadNodes.map((n) => textOf(n)).join(' ')
  t('收起来的门变灰黑，还看得见名字', deadNodes.length === 2 && deadText.includes('写小说'), deadText.slice(0, 120))
  t('收起来的门里列清了有哪些模块', deadText.includes('书架与章节') && deadText.includes('会话存档'), deadText.slice(0, 200))
  t('收起来的门上有装回来的按钮', deadText.includes('装回来'), deadText.slice(0, 200))
}

console.log(`\n${pass} passed, ${fail} failed`)

process.exit(fail === 0 ? 0 : 1)
