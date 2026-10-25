// 在没有浏览器的情况下，对客户端 bundle 做一次「能加载、能注册、组件能渲染」的检查。
// 用极简的假 React（只记录调用），验证：
//   1. bundle 是 __ModuleLoader__ 格式
//   2. 导出 apply / inject
//   3. apply 会在 betterSidebar 上注册 tab
//   4. 组件函数能被调用而不抛错（空数据 / 有数据各一次）
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const t = (n, c, x) => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, x === undefined ? '' : String(x).slice(0, 300)) } }

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
t('是 ModuleLoader 格式', source.startsWith('window.__ModuleLoader__.load({'))
t('有 factory', source.includes('factory: (require) =>'))
// 后台有几条路由把 error 写成 {code, message}（导出门禁那几条）。
// 界面拿到的是这个东西本身，塞进红字里就是 [object Object]，
// 严重时 React 直接抛、用户看到白屏。所以 call() 必须统一压成一句话。
// 这条只能查源码里那段归一化还在——call() 没有对外导出，测不到运行时。
t('call() 会把对象形状的 error 压成一句话', source.includes("typeof json.error === 'object'") && source.includes('json.error.message'))

// 假 React：createElement 返回一个可检查的树节点
const hookStore = []
let hookIndex = 0
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false) }),
  useState: (init) => { const i = hookIndex++; if (hookStore[i] === undefined) hookStore[i] = typeof init === 'function' ? init() : init; return [hookStore[i], (v) => { hookStore[i] = typeof v === 'function' ? v(hookStore[i]) : v }] },
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

// 假 window / document
const registered = []
const fakeDocument = {
  getElementById: () => null,
  createElement: () => ({ id: '', textContent: '', setAttribute() {}, appendChild() {} }),
  head: { appendChild() {} },
  addEventListener() {},
  removeEventListener() {},
}
const fakeWindow = { __ModuleLoader__: { load(spec) { spec.__loaded = true; fakeWindow.__spec = spec } }, addEventListener() {}, removeEventListener() {}, confirm: () => true }
globalThis.window = fakeWindow
globalThis.document = fakeDocument
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, exists: true, workspace: '/tmp/x', relations: [] }) })
globalThis.FileReader = class {}
globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary')
globalThis.Blob = class {}
globalThis.URL = { createObjectURL: () => 'blob:', revokeObjectURL() {} }

// 执行 bundle
// 结构是：window.__ModuleLoader__.load({ id, factory: (require) => { ...body... } });
// 取 body：从第一行 factory 声明之后，到最后一个「}\n});」之前。
const module = { exports: {} }
const exportsObj = module.exports
const openAt = source.indexOf('factory: (require) => {')
const closeAt = source.lastIndexOf('\n});')
// 文件尾是「}\n});」——去掉 factory 自己的闭合花括号那一行

let body = source.slice(openAt + 'factory: (require) => {'.length, closeAt)
// body 末尾多一个「}」（factory 的闭合），剥掉
body = body.replace(/\}\s*$/, '')
const factory = new Function('require', 'module', 'exports', 'window', 'document', body + '\n')
let factoryReturn = null
try {
  factoryReturn = factory(fakeRequire, module, exportsObj, fakeWindow, fakeDocument)
  t('bundle 执行不抛错', true)
} catch (e) {
  t('bundle 执行不抛错', false, e.stack)
}

// factory 内部 `return module.exports`——new Function 会把它作为返回值给出
const api = factoryReturn ?? module.exports
// 上面的正则可能没剥干净，兼容从 __spec 里取
const spec = fakeWindow.__spec
t('有 apply 导出', typeof (api.apply ?? spec?.factory) === 'function' || typeof api.apply === 'function')

if (typeof api.apply === 'function') {
  // inject 里**不许**出现第三方宿主服务。
  //
  // betterSidebar 是另装的插件，不在随附运行时里。Cordis 对未就绪的 inject
  // 会挂起整个 fiber：apply 一句都不执行，连本插件自带的左侧栏图标和主面板
  // 也一起消失——干净 profile 上用户看到的就是「插件没装上」。
  // 它只该走 apply 里 ctx.get('betterSidebar') 的可选分支。
  t('inject 不含第三方 betterSidebar', Array.isArray(api.inject) && !api.inject.includes('betterSidebar'), JSON.stringify(api.inject))

  // 假 ctx
  const effects = []
  const ctx = {
    get: (name) => name === 'betterSidebar' ? { registerTab: (desc) => { registered.push(desc); return () => {} } } : undefined,
    // 真实宿主会立即执行 effect 回调并保留 disposer；测试里同样执行它，
    // 否则注册永远不会发生（这本身就是一次「假测试通过」的教训）。
    effect: (fn) => { const d = fn(); effects.push(d ?? (() => {})); return () => {} },
  }
  api.apply(ctx)
  t('注册了 tab', registered.length === 1, registered.length)
  const tab = registered[0]
  t('tab id', tab.id === 'lifecard', tab.id)
  t('tab 标题', tab.title === 'Life Cards', tab.title)
  t('有描述', typeof tab.description === 'string' && tab.description.length > 5)
  t('single（单实例）', tab.single === true)
  t('有图标工厂', typeof tab.icon === 'function')
  t('有组件', typeof tab.component === 'function')

  hookIndex = 0
  hookStore.length = 0
  let tree = null
  try {
    tree = tab.component({ visible: true, ctx, store: {}, scope: {}, tab: {} })
    t('组件能渲染（初次加载态）', tree !== null && tree !== undefined)
  } catch (e) {
    t('组件能渲染（初次加载态）', false, e.stack)
  }

  // 再渲染一次（模拟已有状态：数据到位）
  hookIndex = 0
  hookStore.length = 0
  hookStore[0] = { home: 'home' }
  try {
    const tree2 = tab.component({ visible: true, ctx, store: {}, scope: {}, tab: {} })
    t('组件能渲染（二次）', tree2 !== null)
  } catch (e) {
    t('组件能渲染（二次）', false, e.stack)
  }

  // 既没有 betterSidebar、也没有 slots 时不应抛错：
  // 精简 profile 就是这种状态，它必须能起来（这是用户给的硬约束）。
  const ctx2 = { get: () => undefined, effect: () => {} }
  const warn = console.warn
  let warned = ''
  console.warn = (...a) => { warned = a.join(' ') }
  try {
    api.apply(ctx2)
    t('缺 betterSidebar 时优雅退化', warned.includes('better-sidebar'), warned)
  } catch (e) {
    t('缺 betterSidebar 时优雅退化', false, e.message)
  } finally { console.warn = warn }

  // ── 左侧栏入口（面板图标 + 主区域页面）────────────────────────────
  // 用户上次找不到插件，是因为入口只在右侧栏的「+」菜单里。
  // 这一组锁住「左侧栏那排图标里也有它」，别以后改着改着又没了。
  t('inject 含 slots', Array.isArray(api.inject) && api.inject.includes('slots'), JSON.stringify(api.inject))

  // 假 slots：inject 立即调用回调（真宿主也是座位一出现就调用），register 记账
  const slotRegistrations = []
  const makeSlots = () => ({
    inject: (name, fn) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    register: (spec, component) => { slotRegistrations.push({ spec, component }); return () => {} },
  })
  const ctxSlots = {
    slots: makeSlots(),
    get: (name) => name === 'betterSidebar' ? { registerTab: () => () => {} } : undefined,
    effect: (fn) => { const d = fn(); return () => {} },
  }
  let slotsError = null
  try { api.apply(ctxSlots) } catch (e) { slotsError = e }
  t('有 slots 时 apply 不抛错', slotsError === null, slotsError?.message)

  const mainReg = slotRegistrations.find((r) => r.spec.name === 'main')
  const navReg = slotRegistrations.find((r) => r.spec.name === 'sidebar.panellist')
  t('注册了主区域页面', mainReg !== undefined, slotRegistrations.map((r) => r.spec.name).join(','))
  t('注册了左侧栏图标', navReg !== undefined, slotRegistrations.map((r) => r.spec.name).join(','))
  t('两边的 id 配对（左侧栏 id === 主区域 key）',
    mainReg !== undefined && navReg !== undefined && mainReg.spec.key === navReg.spec.id,
    `${mainReg?.spec.key} vs ${navReg?.spec.id}`)
  t('左侧栏 id 是 lifecard', navReg?.spec.id === 'lifecard', navReg?.spec.id)
  t('左侧栏有位置顺序', typeof navReg?.spec.order === 'number')
  t('左侧栏有名字', typeof navReg?.spec.label === 'function' && navReg.spec.label() === 'Life Cards', navReg?.spec.label?.())

  // 图标组件能被外壳调用（外壳会塞一个 size 进来）
  let iconTree = null
  try { iconTree = navReg.component({ size: 16, active: false }) } catch (e) { iconTree = e }
  t('图标组件能画', iconTree !== null && typeof iconTree === 'object' && iconTree.type === 'svg', String(iconTree?.message ?? ''))
  t('图标跟着外壳给的尺寸走', iconTree?.props?.width === 16, iconTree?.props?.width)

  // 主区域页面能渲染
  hookIndex = 0
  hookStore.length = 0
  let pageTree = null
  try { pageTree = mainReg.component({}) } catch (e) { pageTree = e }
  t('主区域页面能渲染', pageTree !== null && typeof pageTree === 'object' && pageTree.type === 'div', String(pageTree?.message ?? ''))

  // 座位不存在时（老外壳 / 精简 profile）不能把启动搞挂
  const ctxNoSlots = {
    get: () => ({ registerTab: () => () => {} }),
    effect: (fn) => { const d = fn(); return () => {} },
  }
  let noSlotsError = null
  try { api.apply(ctxNoSlots) } catch (e) { noSlotsError = e }
  t('没有 slots 时优雅退化', noSlotsError === null, noSlotsError?.message)
}

// 「都不要」之后提示不能说成「这些卡里本来就有」——那是采纳那条路的话。
// 用户会以为自己点错了，再去点一遍。
{
  t('「不要了」的提示与采纳分开', source.includes("r?.dismissed === true"), '')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
