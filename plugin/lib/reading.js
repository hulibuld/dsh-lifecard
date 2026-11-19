/**
 * dsh-reading 的桥（`lib/reading.js`）。
 *
 * 为什么是 HTTP 转发而不是 `import`：dsh-reading 不向 cordis 提供任何 service
 * （它的 `index.js` 只有 `export const inject = ['webServer']`，从头到尾没有
 * `ctx.provide` / `ctx.set`），所以拿不到对象，只能打它自己那套路由。
 *
 * 好在两边跑在同一台机器的同一个 web 端口上：LifeCard 的后台直接回环请求
 * `/api/dsh-reading/<method>`，不受浏览器跨域限制，也不经过用户的操作。
 *
 * 这一层只做三件事：转发、把错误翻成人话、把「没装 / 没开」和「出错了」分开。
 * 具体的书怎么解析、书库怎么组织，全是 dsh-reading 的事，这里一概不碰。
 */

import path from 'node:path'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'

/** dsh-reading 的路由前缀（`lib/routes.js:94` 的 `API_PREFIX`，两边必须一致）。 */
export const READING_API = '/api/dsh-reading'

/**
 * 书库默认根（照抄 dsh-reading `lib/paths.js` 的 `DEFAULT_LIBRARY_DIR` + `root`）。
 *
 * 为什么这里要自己算一遍：dsh-reading 没把「书库在哪」暴露成任何路由，
 * `device.info` 只回一个设备 id。用户在界面上问「我的书存哪儿了」时，
 * 我们只能按它自己的规则推一遍。推不出来也不影响别的——书架列表走的是
 * 它自己的 `shelf.list`，那是唯一权威。
 */
export function defaultLibraryRoot() {
  return path.join(homedir(), '.dsh-reading', 'dsh-reading')
}

/**
 * 一次转发。超时短一点：这是本机回环，慢就说明对面卡住了，
 * 让用户干等三十秒不如早点说「它在忙」。
 *
 * @param {string} origin 形如 `http://127.0.0.1:61306`
 * @param {string} method dsh-reading 的方法名，如 `shelf.list`
 * @param {object} body
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ ok: true, value: any } | { ok: false, code: string, error: string, offline?: boolean }>}
 */
export async function callReading(origin, method, body = {}, options = {}) {
  const base = String(origin ?? '').replace(/\/+$/, '')
  if (base === '') return { ok: false, code: 'no-origin', offline: true, error: '不知道这个软件开在哪个地址上，读不到书架。' }
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs)
  let res
  try {
    res = await fetch(`${base}${READING_API}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller?.signal,
    })
  } catch (error) {
    if (timer !== null) clearTimeout(timer)
    const aborted = error?.name === 'AbortError'
    return {
      ok: false,
      code: aborted ? 'timeout' : 'offline',
      offline: true,
      error: aborted
        ? '读书那部分没应答。它可能正在导入一本很大的书，等一会儿再试。'
        : '没连上读书那部分。可能是它没装，或者刚启动还没准备好。',
    }
  }
  if (timer !== null) clearTimeout(timer)
  // 404 有两种：dsh-reading 没装（整个前缀没人认，落到宿主的兜底页），
  // 或者装了但没有这个方法（版本太老）。两种对用户是同一句话：这条走不通。
  if (res.status === 404) {
    return { ok: false, code: 'not-installed', offline: true, error: '这台机器上没找到「读书」那个插件。' }
  }
  let json = null
  try {
    json = await res.json()
  } catch {
    // 前缀被别的东西接了（比如宿主把一个 HTML 404 页回过来）。
    return { ok: false, code: 'not-installed', offline: true, error: '这台机器上没找到「读书」那个插件。' }
  }
  if (json === null || typeof json !== 'object') {
    return { ok: false, code: 'bad-response', error: '读书那部分回的话没看懂。' }
  }
  if (json.ok !== true) {
    const err = json.error ?? {}
    return {
      ok: false,
      code: typeof err.code === 'string' ? err.code : 'failed',
      error: typeof err.message === 'string' && err.message !== '' ? err.message : '读书那部分没做成这一步。',
    }
  }
  return { ok: true, value: json.value }
}

/**
 * 书库在磁盘上的实况：在不在、几本、多大。
 *
 * 这只用来回答「书存在哪儿了」和「占了多少地方」，不参与「有哪些书」——
 * 后者一律以 `shelf.list` 为准，那边才是解析过 meta 的权威结果。
 *
 * @param {string} [root]
 * @returns {Promise<{ path: string, exists: boolean, bookDirs: number, bytes: number }>}
 */
export async function libraryFootprint(root = defaultLibraryRoot()) {
  const booksRoot = path.join(root, 'books')
  let names = []
  try {
    names = await fs.readdir(booksRoot, { withFileTypes: true })
  } catch {
    return { path: root, exists: false, bookDirs: 0, bytes: 0 }
  }
  const dirs = names.filter((entry) => entry.isDirectory() && /^[0-9a-f]{16}$/.test(entry.name))
  // 只统计书目录里的一层文件大小。整棵树递归在一本 PDF 转出来的书上是几万个
  // 小文件，为了一个「占了多少 MB」跑一遍要好几秒，不值得。
  let bytes = 0
  for (const entry of dirs) {
    const at = path.join(booksRoot, entry.name)
    let files = []
    try {
      files = await fs.readdir(at, { withFileTypes: true })
    } catch {
      continue
    }
    for (const file of files) {
      if (file.isDirectory()) continue
      const size = await fs.stat(path.join(at, file.name)).then((s) => s.size).catch(() => 0)
      bytes += size
    }
  }
  return { path: root, exists: true, bookDirs: dirs.length, bytes }
}

/**
 * 把一章 XHTML 剥成纯文字。
 *
 * 为什么不直接用 dsh-reading 的 `chapterText`：那个函数在 store 里，
 * 没有暴露成路由；而且它保留的空白规则是给阅读器排版用的（有缩进、有空行），
 * 塞进材料里给 AI 读时那些空白只会变成噪声。
 *
 * 这里的取舍：块级元素换行、行内元素直接拼、`<script>` / `<style>` 整段丢。
 * 图片一律去掉——材料里一句「[图]」比一串 asset 路由有用得多。
 *
 * @param {string} html
 * @returns {string}
 */
export function htmlToText(html) {
  let text = String(html ?? '')
  text = text.replace(/<!--[\s\S]*?-->/g, '')
  text = text.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  text = text.replace(/<img\b[^>]*>/gi, '')
  // 块级边界换成换行，剩下的标签直接去掉。
  text = text.replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article|blockquote|pre)\b[^>]*>/gi, '\n')
  text = text.replace(/<[^>]+>/g, '')
  // 实体只解最常出现的几个：解全表要一张几百项的表，而剩下那些在正文里极少见，
  // 原样留着（`&nbsp;` 之类）比引错一张表更安全。
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, '&')
  // 全角空格当缩进留着，行首的普通空格去掉；连续空行压成一个。
  text = text.replace(/[ \t\u00a0]+/g, ' ')
  text = text.replace(/ *\n */g, '\n')
  text = text.replace(/\n{3,}/g, '\n\n')
  return text.trim()
}

/**
 * 取一章的纯文字。
 *
 * @param {string} origin
 * @param {string} bookHash 16 位或 64 位都行，dsh-reading 自己归一
 * @param {string} href spine 里的 href
 * @returns {Promise<{ ok: true, text: string } | { ok: false, error: string, offline?: boolean }>}
 */
export async function fetchChapterText(origin, bookHash, href) {
  const base = String(origin ?? '').replace(/\/+$/, '')
  if (base === '') return { ok: false, offline: true, error: '不知道这个软件开在哪个地址上。' }
  const url = `${base}${READING_API}/chapter?book=${encodeURIComponent(bookHash)}&href=${encodeURIComponent(href)}`
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller === null ? null : setTimeout(() => controller.abort(), 20000)
  let res
  try {
    res = await fetch(url, { signal: controller?.signal })
  } catch {
    if (timer !== null) clearTimeout(timer)
    return { ok: false, offline: true, error: '取这一章的时候断开了，再试一次。' }
  }
  if (timer !== null) clearTimeout(timer)
  if (res.status === 404) return { ok: false, error: '这一章找不到了，可能书被换过。' }
  if (!res.ok) return { ok: false, error: '这一章读不出来。' }
  const html = await res.text().catch(() => '')
  const text = htmlToText(html)
  if (text === '') return { ok: false, error: '这一章是空的，可能里面全是图。' }
  return { ok: true, text }
}

/**
 * 一份材料最多取多少字。
 *
 * 为什么有上限：一本书几十万字，全塞进材料里，之后「让 AI 读一读」那一步
 * 会在模型那边撑爆上下文，而且用户要的往往只是「这个人/这本书大概是讲什么的」。
 * 八万字大约是一本中篇的正文量，够读出人物和语气。
 */
export const MATERIAL_CHAR_CAP = 80000

/**
 * 把一本书的正文取成一份材料文本。
 *
 * 按 spine 顺序逐章取，够了就停。为什么按章而不是让 dsh-reading 一次给全书：
 * 它没有「全书纯文本」这个接口，而且按章取失败只丢一章，能接着往下走。
 *
 * @param {string} origin
 * @param {{ bookHash: string, title?: string, author?: string, spine: Array<{href: string, index?: number}> }} book
 * @param {{ maxChars?: number, onProgress?: (done: number, total: number) => void }} [options]
 * @returns {Promise<{ ok: true, text: string, chapters: number, total: number, truncated: boolean } | { ok: false, error: string, offline?: boolean }>}
 */
export async function bookToMaterial(origin, book, options = {}) {
  const spine = Array.isArray(book?.spine) ? book.spine : []
  const capped = Number.isFinite(options.maxChars) ? options.maxChars : MATERIAL_CHAR_CAP
  if (spine.length === 0) return { ok: false, error: '这本书里没有章节目录，读不出正文。' }
  const head = []
  const title = String(book?.title ?? '').trim()
  const author = String(book?.author ?? '').trim()
  if (title !== '') head.push(`# ${title}${author === '' ? '' : `（${author}）`}`)

  const hrefs = spine.map((entry) => String(entry?.href ?? '')).filter((one) => one !== '')
  if (hrefs.length === 0) return { ok: false, error: '这本书里没有章节目录，读不出正文。' }

  // 一章一个请求，串行读一本三十章的书要三十个来回。四个一起发，
  // 本机回环经得起，而且顺序由下面的下标还原，不会乱。
  const CONCURRENCY = 4
  const pieces = new Array(hrefs.length).fill('')
  let cursor = 0
  let done = 0
  const worker = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= hrefs.length) return
      const got = await fetchChapterText(origin, book.bookHash, hrefs[index])
      // 一章读不出来不该让整本书作废：留空，接着读下一章。
      // 但如果一章都没成，那要如实说，不能回一份只有标题的空材料。
      if (got.ok === true) {
        pieces[index] = got.text.trim()
        done += 1
        if (typeof options.onProgress === 'function') options.onProgress(done, hrefs.length)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, hrefs.length) }, worker))

  const parts = []
  let total = 0
  let truncated = false
  for (const piece of pieces) {
    if (piece === '') continue
    if (total + piece.length > capped) {
      parts.push(piece.slice(0, Math.max(0, capped - total)))
      truncated = true
      break
    }
    parts.push(piece)
    total += piece.length
  }
  if (parts.length === 0) return { ok: false, error: '这本书的正文一个字都没读出来。' }
  const body = parts.join('\n\n')
  const text = head.length === 0 ? body : `${head.join('\n')}\n\n${body}`
  return { ok: true, text, chapters: parts.length, total: hrefs.length, truncated }
}
