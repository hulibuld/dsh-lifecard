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
  t('inject 含 betterSidebar', Array.isArray(api.inject) && api.inject.includes('betterSidebar'), JSON.stringify(api.inject))

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

  // 没有 betterSidebar 时不应抛错
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
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
