/**
 * 「从书架搬一本书进来」这条路。
 *
 * 这条路和别处不一样：东西在另一个插件里，而那个插件不向 cordis 交任何对象，
 * 只能打它自己的 HTTP 路由。所以测的重点不是「解析得准不准」，而是三件
 * 不测就会悄悄坏掉的事：
 *
 *   1. 「没装」「没开」「慢」「出错」必须分开——用户在界面上看到的
 *      分别是「去装那个插件」「等几秒」「再试一次」「这本书读不出来」，
 *      混成一句「失败」他就不知道该干什么。
 *   2. 一本书几十万字，必须按上限截断，而且**截断了要说出来**。
 *   3. 同一本书再导一次是「重抄一遍」不是「再存一份」——否则 AI 读材料时
 *      同一个事实被引两次，还会以为那是两个人说的。
 *
 * 这里起一个真的本机 HTTP 服务假装 dsh-reading。用真 fetch 而不是打桩：
 * 打桩测不到 404、非 JSON、连接被拒这几种真实分支，而那几种恰恰是
 * 用户最常遇到的（插件没装）。
 */
import { createServer } from 'node:http'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as api from '../lib/index.js'
import * as store from '../lib/store.js'
import * as reading from '../lib/reading.js'

let pass = 0, fail = 0
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : String(extra).slice(0, 500)) }
}

// ── 假的 dsh-reading ───────────────────────────────────────────────
// 行为按方法名分派。`slow` 让请求挂住，用来验超时。
const seenCalls = []
const SPINE = [
  { href: 'ch1.xhtml', index: 0 },
  { href: 'ch2.xhtml', index: 1 },
  { href: 'ch3.xhtml', index: 2 },
]
const CHARS = {
  'ch1.xhtml': '<html><body><h1>第一章</h1><p>海上有雾。</p><p>船没有回来。</p></body></html>',
  'ch2.xhtml': '<html><body><p>第二天雾散了。</p></body></html>',
  'ch3.xhtml': '<html><body><p>他说，明天出海。</p></body></html>',
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  seenCalls.push(url.pathname + url.search)
  const reply = (code, body, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type })
    res.end(typeof body === 'string' ? body : JSON.stringify(body))
  }

  // 取章节正文走 GET + query
  if (url.pathname === '/api/dsh-reading/chapter') {
    const href = url.searchParams.get('href') ?? ''
    if (CHARS[href] === undefined) return reply(404, { ok: false })
    return reply(200, CHARS[href], 'text/html; charset=utf-8')
  }

  if (url.pathname.startsWith('/api/dsh-reading/')) {
    const method = url.pathname.slice('/api/dsh-reading/'.length)
    let raw = ''
    req.on('data', (c) => { raw += c })
    req.on('end', () => {
      const body = raw === '' ? {} : JSON.parse(raw)
      if (method === 'device.info') return reply(200, { ok: true, value: { deviceId: 'mac-test' } })
      if (method === 'shelf.list') {
        return reply(200, {
          ok: true,
          value: {
            books: [
              { bookHash: 'aaa111', title: '海上', author: '某人', sourceFormat: 'epub', percent: 0.5 },
              { bookHash: 'bbb222', title: '', author: '', sourceFormat: 'txt', percent: 0 },
            ],
          },
        })
      }
      if (method === 'book.spine') {
        if (body.bookHash === 'bbb222') return reply(200, { ok: true, value: { spine: [] } })
        return reply(200, { ok: true, value: { spine: SPINE } })
      }
      if (method === 'slow.method') return // 挂住，永不回
      if (method === 'shelf.import') {
        if (body.filename === '坏书.pdf') {
          return reply(200, { ok: false, error: { code: 'bad-book', message: '这本书解析不了。' } })
        }
        return reply(200, { ok: true, value: { bookHash: 'ccc333', title: String(body.filename ?? '') } })
      }
      return reply(404, { ok: false })
    })
    return
  }
  reply(404, 'not found', 'text/plain')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

// ── htmlToText ────────────────────────────────────────────────────
{
  const text = reading.htmlToText('<html><head><style>p{color:red}</style></head><body><h1>标题</h1><p>第一段&nbsp;话。</p><img src="x.png"><p>第二段</p><script>bad()</script></body></html>')
  t('章节里的标签都剥掉了', text.includes('<') === false, text)
  t('块级元素之间会换行', text.split('\n').filter((l) => l.trim() !== '').length >= 3, JSON.stringify(text))
  t('style 里的样式表不会漏进来', text.includes('color') === false, text)
  t('script 不会漏进来', text.includes('bad()') === false, text)
  t('图片位置不会留一堆尖括号', text.includes('x.png') === false, text)
  t('&nbsp; 解成空格', text.includes('第一段 话。'), text)
  const empty = reading.htmlToText('<html><body><img src="a.png"></body></html>')
  t('整页都是图时结果为空', empty === '', JSON.stringify(empty))
}

// ── callReading 的四种「不行」必须分得开 ─────────────────────────
{
  const noOrigin = await reading.callReading('', 'shelf.list', {})
  t('没地址时说得清是不知道该发到哪', noOrigin.ok === false && noOrigin.offline === true && String(noOrigin.error).includes('地址'), JSON.stringify(noOrigin))

  const dead = await reading.callReading('http://127.0.0.1:1', 'shelf.list', {}, { timeoutMs: 3000 })
  t('连不上时标成离线', dead.ok === false && dead.offline === true, JSON.stringify(dead))
  t('连不上时给的是「没装或者没准备好」', String(dead.error).includes('没连上'), String(dead.error))

  const missing = await reading.callReading(origin, 'no.such.method', {}, { timeoutMs: 5000 })
  t('对面没有这个方法时标成没装', missing.ok === false && missing.code === 'not-installed', JSON.stringify(missing))

  const slow = await reading.callReading(origin, 'slow.method', {}, { timeoutMs: 300 })
  t('超时标成超时而不是出错', slow.ok === false && slow.code === 'timeout', JSON.stringify(slow))
  t('超时时说「等一会儿再试」', String(slow.error).includes('等一会儿'), String(slow.error))

  const ok = await reading.callReading(origin, 'device.info', {}, { timeoutMs: 5000 })
  t('正常时把 value 原样带回来', ok.ok === true && ok.value?.deviceId === 'mac-test', JSON.stringify(ok))
}

// ── bookToMaterial ────────────────────────────────────────────────
{
  const book = { bookHash: 'aaa111', title: '海上', author: '某人', spine: SPINE }
  const got = await reading.bookToMaterial(origin, book)
  t('整本按章拼起来', got.ok === true && got.chapters === 3, JSON.stringify(got).slice(0, 300))
  t('开头写上了书名和作者', got.text.startsWith('# 海上（某人）'), got.text.slice(0, 60))
  t('三章正文都在', got.text.includes('船没有回来') && got.text.includes('第二天雾散了') && got.text.includes('明天出海'), got.text.slice(0, 200))
  t('没截断时不谎报截断', got.truncated === false && got.total === 3, JSON.stringify({ t: got.truncated, n: got.total }))

  // 上限只够前两章：必须说「截断了」，而且章数只算真的收进来的。
  // 三章合起来三十来字，上限压到 12 才真的会在第二章中间切开。
  const cut = await reading.bookToMaterial(origin, book, { maxChars: 12 })
  t('超过上限时截断', cut.ok === true && cut.truncated === true, JSON.stringify(cut).slice(0, 200))
  t('截断后章数只算真的收进来的', cut.chapters < 3, String(cut.chapters))
  t('截断后总章数照实说整本有几节', cut.total === 3, String(cut.total))

  const noSpine = await reading.bookToMaterial(origin, { bookHash: 'x', spine: [] })
  t('没有章节目录时说得清', noSpine.ok === false && String(noSpine.error).includes('目录'), JSON.stringify(noSpine))

  const missing = await reading.bookToMaterial(origin, { bookHash: 'aaa111', spine: [{ href: 'nope.xhtml' }] })
  t('一章都读不出来时不交一份空材料', missing.ok === false, JSON.stringify(missing))
}

// ── 四条路由 ──────────────────────────────────────────────────────
const ws = path.join(tmpdir(), 'lifecard-reading-' + Date.now())
await fs.mkdir(ws, { recursive: true })
await store.openWorkspace(ws, { create: true })
const ctx = {
  webServer: { register: () => () => {} },
  reflect: { get: () => undefined },
  effect: (fn) => { fn(); return () => {} },
  logger: { warn() {} },
  get: () => undefined,
}
const table = api.buildApi(ctx, async () => ws, { workspace: ws })

{
  const st = await table['reading.status']({}, { origin })
  t('连上了就说连上了', st.ok === true && st.connected === true, JSON.stringify(st).slice(0, 300))
  t('报得出书架上有几本', st.books === 2, String(st.books))
  t('报得出书库在磁盘上占多大', typeof st.library?.bytes === 'number' && st.library.bytes >= 0, JSON.stringify(st.library))
  t('书库路径是给用户看的那种', String(st.library?.path ?? '').includes('.dsh-reading'), String(st.library?.path))

  // 地址优先级：请求头带来的 origin 优先，没有才退回环境变量。
  const fromEnv = String(process.env.DSH_WEB_URL ?? '').replace(/\/+$/, '')
  const noCtx = await table['reading.status']({}, undefined)
  t('没有 origin 时退回环境变量（环境变量没配就如实说连不上）',
    fromEnv === '' ? (noCtx.ok === true && noCtx.connected === false) : typeof noCtx.ok === 'boolean', JSON.stringify(noCtx).slice(0, 200))

  const offline = await table['reading.status']({}, { origin: 'http://127.0.0.1:1' })
  t('对面不在时不抛异常、照样回包', offline.ok === true && offline.connected === false, JSON.stringify(offline).slice(0, 200))
  t('对面不在时说清是没装还是没响应', offline.offline === true || offline.offline === false, String(offline.offline))
  t('对面不在时给一句人能读的话', typeof offline.reason === 'string' && offline.reason.length > 6, String(offline.reason))
}

{
  const bs = await table['reading.books']({}, { origin })
  t('书架列得出来', bs.ok === true && bs.books.length === 2, JSON.stringify(bs).slice(0, 200))
  t('每本只留界面要用的字段', Object.keys(bs.books[0]).sort().join(',') === 'author,cover,format,hash,percent,title,updatedAt', Object.keys(bs.books[0]).join(','))
  t('没名字的书给个占位名', bs.books[1].title === '没名字的书', bs.books[1].title)

  const dead = await table['reading.books']({}, { origin: 'http://127.0.0.1:1' })
  t('书架上不去时不抛异常', dead.ok === false && typeof dead.error === 'string', JSON.stringify(dead).slice(0, 200))
}

{
  const pull = await table['reading.pull']({ hash: 'aaa111', title: '海上' }, { origin })
  t('书能搬成一份材料', pull.ok === true && pull.chars > 0, JSON.stringify(pull).slice(0, 300))
  t('搬进来的是三章', pull.chapters === 3, String(pull.chapters))
  t('材料落在 materials/ 底下', String(pull.path).startsWith('materials/'), String(pull.path))

  const mats = await store.readMaterials(ws)
  const body = mats[pull.path] ?? ''
  t('材料里真的有正文', body.includes('船没有回来'), body.slice(0, 120))
  t('材料开头有书名', body.startsWith('# 海上'), body.slice(0, 60))

  // 同一本再搬一次：不许变成两份材料。
  const again = await table['reading.pull']({ hash: 'aaa111', title: '海上' }, { origin })
  const mats2 = await store.readMaterials(ws)
  const same = Object.keys(mats2).filter((k) => k.includes('书-海上'))
  t('同一本书再搬一次不会变成两份', again.ok === true && same.length === 1, JSON.stringify(same))

  const noHash = await table['reading.pull']({}, { origin })
  t('不说是哪本书时直接拦下', noHash.ok === false && String(noHash.error).includes('哪一本'), JSON.stringify(noHash))

  const emptyBook = await table['reading.pull']({ hash: 'bbb222' }, { origin })
  t('没有目录的书说清读不出正文', emptyBook.ok === false && String(emptyBook.error).includes('目录'), JSON.stringify(emptyBook))
}

{
  const up = await table['reading.importBooks']({
    files: [
      { name: '新书.epub', base64: Buffer.from('x').toString('base64') },
      { name: '坏书.pdf', base64: Buffer.from('y').toString('base64') },
    ],
  }, { origin })
  t('一次放两本，成一本败一本都如实说', up.ok === true && up.imported === 1 && up.failed === 1, JSON.stringify(up).slice(0, 300))
  t('没成的带着它自己的原因', String(up.results.find((r) => r.ok !== true)?.error ?? '').includes('解析不了'), JSON.stringify(up.results).slice(0, 300))

  const none = await table['reading.importBooks']({ files: [] }, { origin })
  t('一个文件都没给时说得清', none.ok === false || none.imported === 0, JSON.stringify(none).slice(0, 200))
}

server.close()
await fs.rm(ws, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
