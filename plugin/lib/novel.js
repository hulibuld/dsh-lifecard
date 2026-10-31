/**
 * novel —— 写小说：一本「书」、一章一章写下去。
 *
 * 为什么单独一层：写小说和「人物卡」不是同一件事。一张卡是「一个人是谁」，
 * 一本书是「一件事怎么发生」。共用同一份卡和世界书，但章节要的是另一套东西：
 * 顺序、前后文、每章想推进什么。
 *
 * 落盘形状（用户拿 Finder 就能看、能改）：
 * ```
 * books/<书 id>/
 *   book.md                 一本书：书名、题材、一句话讲什么
 *   chapters/001.md         第一章
 *   chapters/002.md         第二章
 * ```
 * 为什么不塞成一个文件：一章动辄几千字，全挤在一份里既难读也难改；
 * 分文件之后，用户想单独再看某一章、想用别的编辑器改，都方便。
 *
 * 这一层只碰磁盘与文字：不调模型、不碰 HTTP。路由在 index.js，界面在 client.js。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import * as core from './core.js'

/** 一本书放在工作区的哪个文件夹里。 */
export const BOOK_DIR = 'books'

/** 一章最多建议多少字——超过就提示「这一章有点长了」。不是硬限制。 */
export const CHAPTER_SOFT_LIMIT = 6000

/** 一本书最多留多少章（防止误操作长出一万个空章）。 */
export const MAX_CHAPTERS = 999

/** 书 id：来自书名，过一遍 safeId（中文保留）。 */
export function bookIdOf(title) {
  return core.safeId(String(title ?? '').trim() === '' ? '未命名' : title)
}

/** 书的目录（工作区相对路径）。 */
export function bookRelPath(id) {
  return path.posix.join(BOOK_DIR, bookFolderName(id))
}

/**
 * 把书名/目录名收成一段安全的文件夹名。
 *
 * `core.safeId` 只替换 `\ / : * ? " < > | # %` 和空白，**`.` 和 `..` 会原样过去**。
 * 而 `path.posix.join('books', '..')` 是 `'.'`、`join('books', '.')` 是 `'books'`，
 * 于是 `deleteBook('..')` 里的 `fs.rm(root + '.', {recursive:true})` 会把**整个工作区**
 * ——卡、材料、提案、`.lifecard/snapshots` ——一次删光。这不是理论问题：
 * id 从书名来，而书名是用户能打出来的。
 *
 * 所以这里单独收一道：去掉首尾的点、把连续的 `.` 压成一个，只剩点的时候退回「未命名」。
 */
export function bookFolderName(id) {
  const raw = String(id ?? '').trim()
  let name = core.safeId(raw)
  name = name.replace(/^\.+/, '').replace(/\.+$/, '').replace(/\.{2,}/g, '.')
  if (name === '' || name === '.' || /^\.+$/.test(name)) name = '未命名'
  if (name === BOOK_DIR) name = `${BOOK_DIR}-book`
  return name
}

/**
 * 书目录的绝对路径。所有读写都从这里出去，并且**再确认一次**落在 `books/` 里面
 * （`bookFolderName` 已经把危险形状挡住，这里是第二道，防以后有人绕过它拼路径）。
 */
export function bookAbs(root, id) {
  const rel = bookRelPath(id)
  const abs = path.join(root, rel)
  const base = path.join(root, BOOK_DIR)
  if (abs !== base && !abs.startsWith(base + path.sep)) return null
  return abs
}

/**
 * 章号能不能用。
 *
 * `chapterFileName` 以前会 `Math.max(1, ...)` 兜底：`0`、`-1`、`'abc'`、`null`
 * 全被悄悄夹成 1。读的时候无害，写的时候是灾——`novel.script.save({index:0})`
 * 会把第 1 章原来那份剧本整份盖掉，而界面上什么都没说。
 * 所以凡是**要写盘**的地方，先用这个判一遍。
 */
export function isValidChapterIndex(index) {
  if (typeof index === 'number') {
    return Number.isInteger(index) && index >= 1 && index <= MAX_CHAPTERS
  }
  const text = String(index ?? '').trim()
  if (!/^[0-9]{1,3}$/.test(text)) return false
  const n = Number(text)
  return Number.isInteger(n) && n >= 1 && n <= MAX_CHAPTERS
}

/** 章文件名：`001.md` —— 补零到三位，字典序就是章序。 */
export function chapterFileName(index) {
  const n = Math.max(1, Math.min(MAX_CHAPTERS, Math.floor(Number(index) || 1)))
  return `${String(n).padStart(3, '0')}.md`
}

/** 从 `002.md` 反解出章号。认不出返回 0。 */
export function chapterIndexOf(fileName) {
  const m = /^(\d{1,3})\.md$/i.exec(String(fileName ?? ''))
  return m === null ? 0 : Number(m[1])
}

/**
 * 一本书的 Markdown。
 *
 * 只用 frontmatter + 一段正文，不用 `##` 小节：书的元信息本来就少
 * （书名、题材、一句话、主要人物），塞成小节反而看着空。
 */
export function renderBookMarkdown(data) {
  const head = { lifecard: core.DATA_VERSION, kind: 'book', ...data }
  const lines = ['---']
  for (const [key, value] of Object.entries(head)) {
    if (value === undefined) continue
    if (value !== null && typeof value === 'object') continue
    lines.push(`${key}: ${JSON.stringify(String(value))}`)
  }
  lines.push('---', '')
  const idea = String(data?.idea ?? '').trim()
  if (idea !== '') lines.push(idea, '')
  return `${lines.join('\n').trimEnd()}\n`
}

/** 反过来：把 book.md 读成 `{data, idea}`。 */
export function parseBookText(text) {
  const parsed = core.parseCard(String(text ?? ''))
  if (parsed.ok !== true) {
    return { ok: false, error: `这本书的说明读不出来：${(parsed.errors ?? []).join('；') || '格式不对'}` }
  }
  const intro = (parsed.sections ?? []).find((s) => s.title === '_intro')
  return { ok: true, data: parsed.data ?? {}, idea: String(intro?.body ?? '').trim() }
}

/** 读一本书（含章节清单，不含各章正文——章节可能很多）。 */
export async function readBook(root, id) {
  const rel = path.posix.join(bookRelPath(id), 'book.md')
  const abs = path.join(root, rel)
  let text
  try {
    text = await fs.readFile(abs, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, error: '这本书不在了' }
    if (error?.code === 'EISDIR') return { ok: false, error: '这本书的位置被一个文件夹占住了，里面可能被别的东西动过。' }
    return { ok: false, error: '这本书打不开。用访达看一眼那个文件夹还在不在。' }
  }
  const parsed = parseBookText(text)
  if (parsed.ok !== true) return parsed
  const chapters = await listChapters(root, id)
  if (chapters.ok !== true) return chapters
  return { ok: true, path: rel, data: parsed.data, idea: parsed.idea, chapters: chapters.chapters }
}

/** 列一本书的章节（按章号排）。 */
export async function listChapters(root, id) {
  const dir = path.join(root, bookRelPath(id), 'chapters')
  let names
  try {
    names = await fs.readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, chapters: [] }
    return { ok: false, error: '章节列表读不出来。检查一下文件夹权限。' }
  }
  const chapters = []
  for (const name of names) {
    const index = chapterIndexOf(name)
    if (index === 0) continue
    const abs = path.join(dir, name)
    const stat = await fs.stat(abs).catch(() => null)
    if (stat === null || !stat.isFile()) continue
    let title = ''
    try {
      const text = await fs.readFile(abs, 'utf8')
      // 章题取正文第一行（`# 标题`）或第一句
      const first = text.split(/\r?\n/).find((line) => line.trim() !== '') ?? ''
      title = first.replace(/^#+\s*/, '').trim().slice(0, 60)
    } catch {
      title = ''
    }
    chapters.push({
      index,
      file: name,
      path: path.posix.join(bookRelPath(id), 'chapters', name),
      title,
      chars: stat.size,
      mtime: stat.mtime.toISOString(),
    })
  }
  chapters.sort((a, b) => a.index - b.index)
  return { ok: true, chapters }
}

/** 读一章的正文。 */
export async function readChapter(root, id, index) {
  const n = chapterIndexOf(chapterFileName(index))
  if (n === 0) return { ok: false, error: '章号不对' }
  const rel = path.posix.join(bookRelPath(id), 'chapters', chapterFileName(n))
  let text
  try {
    text = await fs.readFile(path.join(root, rel), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, error: `第 ${n} 章还没写` }
    return { ok: false, error: '这一章读不出来。检查一下文件夹权限。' }
  }
  return { ok: true, index: n, path: rel, body: text }
}

/**
 * 写一章。`index` 给 0 表示「接在最后一章后面」。
 *
 * 写盘用「临时文件 + 改名」：正文是整章重写，掉电/磁盘满的时候
 * 原来那一章必须还是完整的（和酒馆会话一个道理）。
 */
export async function writeChapter(root, id, index, body, when = new Date()) {
  const book = await readBook(root, id)
  if (book.ok !== true) return book
  const last = book.chapters.length === 0 ? 0 : book.chapters[book.chapters.length - 1].index
  let n = Number(index) || 0
  if (n <= 0) n = last + 1
  if (n > MAX_CHAPTERS) return { ok: false, error: `一本书最多 ${MAX_CHAPTERS} 章。` }
  const rel = path.posix.join(bookRelPath(id), 'chapters', chapterFileName(n))
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  const text = String(body ?? '')
  try {
    const tmp = `${abs}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, abs)
  } catch {
    return { ok: false, error: '这一章没能存下来。检查一下磁盘是不是满了。' }
  }
  // 书的 last_updated 跟着动。这一步失败了也要如实说：章节确实存下来了，
  // 只是书的「最后改过」没更新——不能报成功，也不能报「整章没存」。
  const nextData = { ...book.data, updated_at: when.toISOString() }
  const touched = await writeBookMeta(root, id, nextData, book.idea)
  return { ok: true, index: n, path: rel, chars: text.length, warning: touched.ok === true ? undefined : touched.error }
}

/** 删一章。删完不重排章号——用户手里的「第三章」不会突然变成第二章。 */
export async function deleteChapter(root, id, index) {
  const n = chapterIndexOf(chapterFileName(index))
  if (n === 0) return { ok: false, error: '章号不对' }
  const rel = path.posix.join(bookRelPath(id), 'chapters', chapterFileName(n))
  try {
    await fs.unlink(path.join(root, rel))
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, gone: true }
    return { ok: false, error: '这一章没能删掉。检查一下文件权限。' }
  }
  return { ok: true, index: n }
}

/** 写书的元信息（book.md）。 */
async function writeBookMeta(root, id, data, idea) {
  const rel = path.posix.join(bookRelPath(id), 'book.md')
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  const text = renderBookMarkdown({ ...data, idea: String(idea ?? '').trim() })
  const tmp = `${abs}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  // 这里必须自己兜住：`writeChapter` 是先写章、再更新这本书的
  // 「最后改过的时间」。更新这一步抛出去，调用方只会看到一句通用的失败，
  // 而那一章其实已经在盘上了——用户以为没存，再写一次就多出一章。
  try {
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, abs)
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {})
    return { ok: false, path: rel, error: '这本书的记录没能更新（章节本身可能已经存下来了）。检查一下磁盘空间。' }
  }
  return { ok: true, path: rel }
}

/** 新建一本书。同名不覆盖——另起一个号。 */
export async function createBook(root, input = {}) {
  const title = String(input.title ?? '').trim() === '' ? '未命名' : String(input.title).trim()
  const stem = bookIdOf(title)
  let id = stem
  let free = false
  for (let n = 1; n <= 200; n += 1) {
    id = n === 1 ? stem : `${stem}-${n}`
    const exists = await fs.stat(path.join(root, bookRelPath(id), 'book.md')).then((s) => s.isFile()).catch(() => false)
    if (!exists) { free = true; break }
  }
  // 循环跑完还占不到位置时必须报错。以前这里出了循环就直接往下写，
  // 于是同名第 201 本会**覆盖**看上去是第 200 本的那本 —— 而函数注释
  // 明明写着「同名不覆盖」。
  if (!free) return { ok: false, error: `同名「${title}」的书已经太多了，换个书名再建。` }
  const now = new Date()
  const data = {
    id,
    title,
    genre: String(input.genre ?? '').trim(),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  }
  const written = await writeBookMeta(root, id, data, input.idea)
  if (written.ok !== true) return written
  return { ok: true, id, path: written.path, title }
}

/** 改一本书的元信息（书名、题材、一句话）。 */
export async function updateBook(root, id, patch = {}) {
  const book = await readBook(root, id)
  if (book.ok !== true) return book
  const data = { ...book.data }
  if (typeof patch.title === 'string' && patch.title.trim() !== '') data.title = patch.title.trim()
  if (typeof patch.genre === 'string') data.genre = patch.genre.trim()
  data.updated_at = new Date().toISOString()
  const idea = typeof patch.idea === 'string' ? patch.idea : book.idea
  return writeBookMeta(root, id, data, idea)
}

/** 删一整本书（连章节）。 */
export async function deleteBook(root, id) {
  const rel = bookRelPath(id)
  // 第二道闸：删之前亲自确认这一条真的在 books/ 里面，且不是 books 本身。
  // 递归删掉的地方错一次就没有第二次机会，所以这里宁可多判一次。
  if (!rel.startsWith(`${BOOK_DIR}/`) || rel === BOOK_DIR || rel.includes('..')) {
    return { ok: false, error: '这个书名不对，没删。' }
  }
  const abs = bookAbs(root, id)
  if (abs === null || abs === path.join(root, BOOK_DIR)) return { ok: false, error: '这个书名不对，没删。' }
  try {
    await fs.rm(abs, { recursive: true, force: true })
  } catch {
    return { ok: false, error: '这本书没能删掉。检查一下文件权限。' }
  }
  return { ok: true }
}

/** 列所有书（按最后改动时间倒序）。 */
export async function listBooks(root) {
  const dir = path.join(root, BOOK_DIR)
  let names
  try {
    names = await fs.readdir(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, books: [] }
    return { ok: false, error: '书架读不出来。检查一下文件夹权限。' }
  }
  const books = []
  for (const entry of names) {
    if (!entry.isDirectory()) continue
    const got = await readBook(root, entry.name)
    if (got.ok !== true) continue
    books.push({
      id: String(got.data?.id ?? entry.name),
      title: String(got.data?.title ?? entry.name),
      genre: String(got.data?.genre ?? ''),
      idea: String(got.idea ?? '').slice(0, 80),
      chapters: got.chapters.length,
      words: got.chapters.reduce((n, c) => n + c.chars, 0),
      updated_at: String(got.data?.updated_at ?? ''),
    })
  }
  books.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
  return { ok: true, books }
}

/**
 * 「先规划，再写」——三段式的第一段：让 AI 把这本书的骨架搭出来。
 *
 * 为什么非要先规划：一口气让它「写一本小说」，它会写出一段很像开头的东西
 * 然后停下来，而且写着写着就跑偏——因为没有人告诉它这本书要往哪走。
 * OpenWrite 那套的核心就是这个：先把大纲钉住，再一章一章往里填。
 *
 * 产出是一份人看得懂的大纲（不是 JSON）：每章一行，写清这一章要发生什么。
 * 用户能直接改，改完再让它写——比让它吐结构化数据实在得多。
 */
export function buildOutlinePrompt({ title, genre, idea, cast, worldEntries, chapters, ask }) {
  const lines = [
    `你在帮一个人规划一部长篇小说。这本书叫《${title}》。`,
  ]
  if (genre !== '') lines.push(`题材：${genre}`)
  if (idea !== '') lines.push(`这本书想讲的是：${idea}`)
  if (Array.isArray(worldEntries) && worldEntries.length > 0) {
    lines.push('', '【这个世界的设定】', worldEntries.join('\n\n'))
  }
  if (Array.isArray(cast) && cast.length > 0) {
    lines.push('', '【主要人物】', cast.join('\n'))
  }
  if (String(ask ?? '').trim() !== '') lines.push('', `作者另外说：${String(ask).trim()}`)
  lines.push(
    '',
    '【怎么做】',
    `先想清楚这本书的整体走向，然后拆成 ${Number(chapters) > 0 ? chapters : 12} 章。`,
    '',
    '输出格式（严格遵守，我要直接拿这份当写作计划）：',
    '',
    '第一行写整本书的**主线**，用一句话，开头写「主线：」。',
    '然后每章一段，格式是：',
    '',
    '第1章 这一章要发生的事（一句话，要具体：谁做了什么、结果如何）',
    '第2章 …',
    '',
    '【要求】',
    '- 每章那一句必须是**具体发生的事**，不能是「主角成长了」这种空话。',
    '- 章与章之间要有因果：这一章的结果推动下一章。',
    '- 不要写章节标题的花活（不要「命运的齿轮」这种），就写发生了什么。',
    '- 最后一行写「结局：」加一句话，说清这本书最后落在哪儿。',
    '- 不要解释、不要评论、不要问我要不要继续，直接给这份计划。',
  )
  return lines.join('\n')
}

/** 从 AI 吐回来的大纲里扒出主线、各章、结局（它常常多写几句废话）。 */
export function parseOutline(text) {
  const raw = String(text ?? '')
  const line = (re) => {
    const hit = re.exec(raw)
    return hit === null ? '' : String(hit[1] ?? '').trim()
  }
  const theme = line(/(?:^|\n)\s*主线[：:]\s*(.+)/)
  const ending = line(/(?:^|\n)\s*结局[：:]\s*(.+)/)
  const chapters = []
  const re = /(?:^|\n)\s*第\s*(\d+)\s*章\s*[：:、.．\s]\s*(.+)/g
  let m = re.exec(raw)
  while (m !== null) {
    chapters.push({ index: Number(m[1]), plan: String(m[2]).trim() })
    m = re.exec(raw)
  }
  chapters.sort((a, b) => a.index - b.index)
  return { ok: chapters.length > 0, theme, ending, chapters }
}

/**
 * 拼「接着写这一章」的话：这一章已经写了什么 + 大纲 + 上一章结尾 + 设定。
 *
 * 四样都给，少一样它就会开始自己编：只给上一章，它不知道这本书要往哪走；
 * 只给设定，它不知道刚才发生了什么；不给大纲，它会一章一章拖成流水账。
 */
export function buildChapterPrompt({ title, idea, genre, previousTail, currentBody, ask, worldEntries, cast, outline, chapterPlan }) {
  const lines = []
  lines.push(`你在帮一个人写小说。这本书叫《${title}》。`)
  if (genre !== '') lines.push(`题材：${genre}`)
  if (idea !== '') lines.push(`这本书想讲的是：${idea}`)

  const plan = String(chapterPlan ?? '').trim()
  if (plan !== '') {
    lines.push('', '【这一章要写的事】', plan)
  }
  const outlineText = String(outline ?? '').trim()
  if (outlineText !== '') {
    lines.push('', '【整本书的计划】（只写你正在写的那一章，别提前写后面的）', outlineText)
  }
  if (Array.isArray(worldEntries) && worldEntries.length > 0) {
    lines.push('', '【这个世界的设定】', worldEntries.join('\n\n'))
  }
  if (Array.isArray(cast) && cast.length > 0) {
    lines.push('', '【出场的人】', cast.join('\n'))
  }
  if (String(previousTail ?? '').trim() !== '') {
    lines.push('', '【上一章的结尾】', String(previousTail).trim())
  }
  if (String(currentBody ?? '').trim() !== '') {
    lines.push('', '【这一章已经写到这里】', String(currentBody).trim())
  }
  lines.push(
    '',
    '【怎么写】',
    '- 直接写正文，不要复述设定，不要写「好的，我来写」这种话。',
    '- 接着上面的情节往下，不要重写已经写过的部分。',
    '- 这一章只把一件事写清楚：有人想做什么、被什么挡住、最后落在哪个具体的东西上。',
    '- 写到具体的东西为止：手上在做什么、屋里有什么声音、谁站在哪儿。不写「他很孤独」这种结论。',
    '- 对话不加「他笑着说」「她冷冷地说」这类提示语；让话自己站住，语气靠说的是什么。',
    '- 结尾停在具体的动作、物件或一句没接完的话上，不要总结这一章，也不要预告下一章。',
    '- 句式天然一点：「不是…而是…」「与此同时」「不禁」「瞳孔一缩」「命运的齿轮」这些一律不用。',
    '- 形容词要落得回一个能用手的场面：稳的是车和地基，平的是地和案板。不要写「他做事很平」「这个判断很沉」这种；要评价一个人，就写他做了什么。',
    '- 不解释刚写出来的东西：写完一个动作就往下走，不要在它后面紧跟一句替读者总结这意味了什么。',
    '- 比喻只在现场捞：用的东西得是这一场里真出现过的（门、碗、雨、他手上那根烟）。从别处搬一个漂亮东西过来形容这里，宁可不要。',
    '- 人物对话里「行」「我记着了」「你先说」这种短回应可以留——对面坐着人，接得住。叙述里不要出现「这句话很稳」这类没有对象的自我表态。',
    '- 每人按自己的性格和处境行动，不要为了推情节让谁临时变傻或变好。',
    '- 不写章节标题，标题我自己加。',
    '- 只写这一章，写到该收的地方就停，不要顺手把下一章也开了头。',
    '',
    ask === undefined || String(ask).trim() === '' ? '请写这一章，大约 800 到 1200 字。' : `这次想写的是：${String(ask).trim()}`,
  )
  return lines.join('\n')
}

/**
 * 大纲落盘：`books/<id>/outline.md`。
 *
 * 单独一份文件而不是塞进 book.md：大纲是**人会在上面反复改的东西**，
 * 和「书名、题材」那种填一次就不动的元信息不是一个性质。
 * 它也是「AI 写第几章」时唯一的依据，用户改一行就能改变整本书的走向。
 */
export async function readOutline(root, id) {
  const rel = path.posix.join(bookRelPath(id), 'outline.md')
  try {
    const text = await fs.readFile(path.join(root, rel), 'utf8')
    return { ok: true, text, ...parseOutline(text) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, text: '', theme: '', ending: '', chapters: [], missing: true }
    return { ok: false, error: '大纲读不出来。检查一下文件权限。' }
  }
}

/** 写大纲（整份覆盖）。 */
export async function writeOutline(root, id, text) {
  const rel = path.posix.join(bookRelPath(id), 'outline.md')
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  try {
    const tmp = `${abs}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    await fs.writeFile(tmp, String(text ?? ''), 'utf8')
    await fs.rename(tmp, abs)
  } catch {
    return { ok: false, error: '大纲没能存下来。检查一下磁盘是不是满了。' }
  }
  const parsed = parseOutline(text)
  return { ok: true, path: rel, chapters: parsed.chapters.length, theme: parsed.theme, ending: parsed.ending }
}

/**
 * 把一场酒馆对话改写成小说的正文。
 *
 * 为什么不让它「原样搬」：屏幕上是两个人的对白，直接贴进小说里是剧本，
 * 不是小说。要的是把「谁在什么时候说了什么、说的时候是什么样子」
 * 变成叙述。所以要求它保留对话原意，但不许加新的情节。
 */
export function buildChatToChapterPrompt({ cardName, bookTitle, turns, note }) {
  const lines = []
  lines.push('你在把一段已经发生过的对话，改写成小说的正文。')
  lines.push('')
  lines.push('## 对话里的人')
  lines.push(`- ${String(cardName ?? '').trim() === '' ? '对方' : cardName}（对话里的「TA」）`)
  lines.push('- 「我」（对话里的「我」，在小说里也用「我」）')
  lines.push('')

  lines.push('## 这一场谈了什么')
  for (const turn of turns) {
    const who = String(turn?.who ?? '').trim() === '我' ? '我' : (String(cardName ?? '').trim() === '' ? 'TA' : cardName)
    lines.push(`${who}：${String(turn?.text ?? '').trim()}`)
  }
  lines.push('')

  if (String(note ?? '').trim() !== '') {
    lines.push('## 这一章要往哪走')
    lines.push(String(note).trim())
    lines.push('')
  }

  const system = [
    '你是在改稿，不是在下判断。只说要做的事，不要评价这段对话好不好。',
    '',
    '硬要求：',
    '1. 写成小说正文，不是剧本。不要「A：xxx」这种一行一句的形式，谁说了什么要揉进叙述里。',
    '2. 对话的意思要保住。别删掉关键的那几句，也别替他们加没说过的内容。',
    '3. 可以把动作、停顿、屋里的样子补出来——只补「当时本来就在那儿」的东西。',
    '4. 不许加新的情节，不许替角色做决定，不许在结尾下判断或总结道理。',
    '5. 写 800 到 1500 字。不要小标题，不要分段编号，不要写「本章完」。',
    '6. 不要用「命运的齿轮」「不禁」「仿佛」这类词。',
    '',
    `这本书叫《${String(bookTitle ?? '').trim() === '' ? '没起名' : bookTitle}》。`,
  ].join('\n')

  return { system, user: lines.join('\n') }
}

// ── 改成剧本 ──────────────────────────────────────────────────────
//
// 小说和剧本不是同一件事。小说里「他想起十六岁那年的雨」写得再好，也没法拍、
// 没法配音；剧本里「△他把碗放下，看着门口」在小说里又太干。所以这里是
// **改写**，不是排版：叙述换成能演的动作，心理换成表情、动作和台词，
// 一章切成一串场。
//
// 落盘形状：`books/<书 id>/scripts/<章号>.md`，一章一份。为什么跟章号同名：
// 剧本是按章改出来的，章号就是它的身份；再编一套号，人回头想找
// 「第三章改出来的那份」就得多记一个数。

/** 剧本放在书目录下的哪个子文件夹。 */
export const SCRIPT_DIR = 'scripts'

/**
 * 剧本的落盘路径（工作区相对）。
 *
 * 章号过一遍 `chapterFileName`，和 `chapters/` 那边保持同一个三位数，
 * 于是 `scripts/003.md` 和 `chapters/003.md` 一眼能对上。
 */
export function scriptRelPath(id, index) {
  const n = chapterIndexOf(chapterFileName(index))
  return path.posix.join(bookRelPath(id), SCRIPT_DIR, chapterFileName(n))
}

/** 读一份剧本。没改过这一章也正常，返回空串。 */
export async function readScript(root, id, index) {
  const rel = scriptRelPath(id, index)
  const target = path.join(root, rel)
  try {
    const text = await fs.readFile(target, 'utf8')
    // 文件被别的软件写坏过（非法编码、混进 NUL）时，Node 不报错，
    // 只把这些字节换成替换字符。以前它就这样静静当成一份正常剧本显示出来。
    if (text.includes('\uFFFD') || text.includes('\u0000')) {
      return { ok: false, error: '这份剧本的内容坏了（可能被别的软件改过）。可以用访达打开那个文件看一眼，或者删掉重新改一份。' }
    }
    return { ok: true, path: rel, text }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // `scripts/1.md` 这种没补零的名字也算这一章（章列表里会显示「有剧本」）。
      // 只按规范名读的话，列表说有、打开却是空的——人只会以为剧本丢了。
      // 所以规范名读不到时，退回去找同章号的别的写法（只在读不到时才多一次目录读）。
      const fallback = await findScriptFile(root, id, index)
      if (fallback !== null) {
        try {
          const other = await fs.readFile(path.join(root, fallback.rel), 'utf8')
          if (other.includes('\uFFFD') || other.includes('\u0000')) {
            return { ok: false, error: '这份剧本的内容坏了（可能被别的软件改过）。可以用访达打开那个文件看一眼，或者删掉重新改一份。' }
          }
          return { ok: true, path: fallback.rel, text: other, alias: true }
        } catch {
          // 退路也读不到，就还是当没有。
        }
      }
      return { ok: true, path: rel, text: '', missing: true }
    }
    return { ok: false, error: '这份剧本读不出来。检查一下文件权限。' }
  }
}

/** 找这一章剧本的另一种文件名（`1.md`、`001.MD`）。找不到回 null。 */
async function findScriptFile(root, id, index) {
  const n = chapterIndexOf(chapterFileName(index))
  if (n === 0) return null
  const dir = path.join(root, bookRelPath(id), SCRIPT_DIR)
  const names = await fs.readdir(dir).catch(() => null)
  if (names === null) return null
  const candidates = names
    .filter((name) => chapterIndexOf(name) === n && name !== chapterFileName(n))
    .sort()
  if (candidates.length === 0) return null
  return { file: candidates[0], rel: path.posix.join(bookRelPath(id), SCRIPT_DIR, candidates[0]) }
}

/** 写一份剧本（整份覆盖，先写临时文件再改名）。 */
export async function writeScript(root, id, index, text) {
  if (isValidChapterIndex(index) !== true) {
    return { ok: false, error: '章号不对，没法知道你说的是哪一章。' }
  }
  const book = await readBook(root, id)
  if (book.ok !== true) return book
  const n = chapterIndexOf(chapterFileName(index))
  // 库函数也要自己看一眼这一章在不在：路由层会先过 scriptTarget，
  // 但别处（批量导入、模板复制）直接调这里就会写出一份永远显示不出来、
  // 删章也删不掉的孤儿剧本。
  if (!Array.isArray(book.chapters) || !book.chapters.some((c) => Number(c.index) === n)) {
    return { ok: false, error: `这本书没有第 ${n} 章。先翻到真正的那一章再存。` }
  }
  // 库函数自己也要挡一道：路由层会先拦空白，但别处直接调这里
  // 会安安静静写出一个 0 字节的文件，之后读回来是空的，人以为剧本没了。
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, error: '这一份是空的，没往里存。' }
  }
  const rel = scriptRelPath(id, n)
  const abs = path.join(root, rel)
  // 模型把整份剧本包在 ``` 里，界面又把这份原样交回来存。
  // 不剥就落盘，下一章 draft 会把上一章最后一场（带着围栏）带进去，
  // 那份新剧本第一行就成了「```」，扫描器一路报「没归位」。
  const body = stripFence(String(text))
  if (body.trim() === '') return { ok: false, error: '这一份是空的，没往里存。' }
  const tmp = `${abs}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(tmp, body, 'utf8')
    await fs.rename(tmp, abs)
  } catch (error) {
    // 写失败会把半截临时文件留在那儿，下次列剧本时又被当成 `名字.md.tmp-xxx` 混过去。
    await fs.unlink(tmp).catch(() => null)
    if (error?.code === 'ENOSPC') return { ok: false, error: '磁盘满了，这份剧本没存下来。' }
    if (error?.code === 'EACCES' || error?.code === 'EPERM') return { ok: false, error: '这个文件夹不让写。用访达看一眼它的权限。' }
    if (error?.code === 'EISDIR' || error?.code === 'ENOTDIR') return { ok: false, error: '那个位置上被别的东西占着，这份剧本没存下来。' }
    return { ok: false, error: '这份剧本没能存下来。再试一次；还是不行就先关掉重开。' }
  }
  // 字数跟报告、跟列表一个口径：去掉空白以后的字数。
  // 用 body.length 的话，同一份剧本存的时候一个数、列的时候另一个数、报告里第三个。
  return { ok: true, index: n, path: rel, chars: body.replace(/\s/g, '').length }
}

/** 删一份剧本。章不删，只删改出来的这份。 */
export async function deleteScript(root, id, index) {
  const rel = scriptRelPath(id, index)
  try {
    await fs.unlink(path.join(root, rel))
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, gone: true }
    return { ok: false, error: '这份剧本没能删掉。检查一下文件权限。' }
  }
  return { ok: true }
}

/** 列这本书已经改出来的剧本（按章号排）。 */
export async function listScripts(root, id) {
  const dir = path.join(root, bookRelPath(id), SCRIPT_DIR)
  let names
  try {
    names = await fs.readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, scripts: [] }
    return { ok: false, error: '剧本目录读不出来。检查一下文件夹权限。' }
  }
  const scripts = []
  // `1.md`、`001.md`、`002.MD` 会被读成同一个章号（章号正则不区分大小写、不要求补零）。
  // 同一个章号只报一条，按「名字最规范」的那份算：先比是不是三位补零，再比是不是小写。
  const seen = new Map()
  for (const name of names) {
    const index = chapterIndexOf(name)
    if (index === 0) continue
    const stat = await fs.stat(path.join(dir, name)).catch(() => null)
    if (stat === null || !stat.isFile()) continue
    const canonical = name === chapterFileName(index)
    const prev = seen.get(index)
    if (prev !== undefined) {
      // 已经有更好的那份就不换；都是非规范名时留字典序靠前的，至少两次结果一样。
      if (prev.canonical === true) continue
      if (canonical !== true && prev.file <= name) continue
    }
    let scenes = 0
    let chars = 0
    try {
      const text = await fs.readFile(path.join(dir, name), 'utf8')
      scenes = parseScriptScenes(text).scenes.length
      // 字数要和报告、和界面上那个数字一个口径：去掉空白以后的字数。
      // 以前这里用的是文件字节数（UTF-8 一个汉字三字节），
      // 同一份剧本在三个地方显示三个数字，人不知道该信哪个。
      chars = text.replace(/\s/g, '').length
    } catch {
      scenes = 0
      chars = 0
    }
    seen.set(index, {
      index,
      file: name,
      canonical,
      path: path.posix.join(bookRelPath(id), SCRIPT_DIR, name),
      chars,
      scenes,
      mtime: stat.mtime.toISOString(),
    })
  }
  for (const entry of seen.values()) scripts.push({ ...entry })
  scripts.sort((a, b) => a.index - b.index)
  return { ok: true, scripts }
}

/**
 * 拆一行场头：`客厅 日 内` → `{place:'客厅', dayNight:'日', inOut:'内'}`。
 *
 * 认不出来就回 null，不要硬拆。失败一次只是「这场没读到场头」，硬拆出来的
 * 假场头会让人以为分场错了——`林小雨（低声）说："走吧。"` 那行就曾经被当成
 * 一个叫「林小雨（低声）说」的地方。
 */
function parseSceneHeadLine(line) {
  // 这一支是公开导出的（`export { parseSceneHeadLine }`），别处会直接把
  // `**客厅 日 内**` 这样的行递进来。`scanScript` 入口先剥过壳，所以界面看不出来；
  // 两个入口行为不一致迟早出事，干脆在这里自己剥一次。
  // 场号和场头写在同一行很常见（`## 第3场 门外 夜 外`），
  // 别处直接把整行递进来时，场号得先摘掉，否则地名会变成「第3场 门外」。
  const raw = String(line ?? '').trim()
    // 整行套一层方括号（`【第1场 客厅 日 内】`、`[第2场 门外 夜 外]`）也要剥：
    // 只剥行首的「【第1场」会把行尾的「内】」留在地名里。
    .replace(/^[【\[]\s*/, '')
    .replace(/\s*[】\]]$/, '')
    .replace(/^[#>*_\s]+/, '')
    .replace(/[#>*_\s]+$/, '')
    .replace(/^(?:[【\[]?\s*第\s*[0-9０-９一二三四五六七八九十百零〇两]+\s*[场幕]\s*[】\]]?\s*[：:·.、]?|场景\s*[0-9０-９]+\s*[：:·.、]?|场次\s*[0-9０-９]+\s*[：:·.、]?)\s*/, '')
  if (raw === '') return null
  if (/^[△▲→▵Δ]/.test(raw) || raw.startsWith('【')) return null
  // 有冒号或引号的都是台词，不是地点。直角引号（「」『』）也算引号——
  // 台词写成 `林小雨：「走吧。」` 时，这一行照样不是场头。
  if (/[：:]/.test(raw) || /["“”「」『』]/.test(raw)) return null
  // 「客厅（日）内」「会议室（白天）内」：括号里只写时间/内外的，把它拽出来
  // 当分隔符用。其它括号（`客厅（二楼）`）留给下面的判据——那是地名的一部分，
  // 现在一律当「不是场头」，宁可漏也不瞎猜。
  // 行尾的括注（`客厅 日 内（回忆场，可加旧滤镜）`）是备注，不是地名的一部分。
  // 先整个剪掉；剪完还带括号的，才走下面「括号在地名中间」那条判据。
  const trimmedTail = raw.replace(/\s*[（(][^（()）]{0,60}[）)]\s*$/g, ' ').replace(/\s*【[^【】]{0,40}】\s*$/g, ' ').trim()
  const unwrapped = trimmedTail.replace(/[（(]\s*(日|夜|晨|清晨|黎明|早晨|上午|中午|下午|午后|黄昏|傍晚|晚上|深夜|半夜|凌晨|白天|内|外|内景|外景|室内|室外)\s*[）)]/g, ' $1 ')
  // 不拆 `·`：`旧书店·门厅`「省城·外滩」是地名的一部分，拆开会把地名改掉。
  // 全角斜杠和全角竖线要当分隔符：中文输入法下「客厅／日／内」是最常见的写法之一。
  const parts = unwrapped.split(/[\s/|、／｜]+/).filter((x) => x !== '')
  let dayNight = ''
  let inOut = ''
  // 「院子里面 夜 外」：`里面` 是内外词，后面又明写了「外」。
  // 明写的那个说了算——早先按先后顺序取第一个，地名成了「院子」、内外成了「内」，
  // 人明明写的是屋外，读出来是屋里，还一条不报。
  let inOutStrict = ''
  let inOutTail = ''
  const rest = []
  for (const part of parts) {
    if (isDayNightPart(part)) {
      // 第二个「日」「夜」是多余的，丢掉，不许掉进地名里。
      if (dayNight === '') dayNight = part
      continue
    }
    // 内景/室内 统一记成「内」；「里面 / 里边 / 室内」这类写法也认。
    // 「院子里面」这种：里面是内外词，院子是地名，得留下——
    // 早先整段都当内外词吞掉，一场戏的地点就变成空的，而且日夜内外都写了，
    // 一条提示都不报。
    const innerTail = /^(.*?)(?:里面|里边|里头)$/.exec(part)
    const outerTail = /^(.*?)(?:外面|外边|外头)$/.exec(part)
    const inner = /^(内|内景|室内|里面|里边|里头|室内景)$/.test(part) || innerTail !== null
    const outer = /^(外|外景|室外|外面|外边|外头|室外景)$/.test(part) || outerTail !== null
    if (inner || outer) {
      // 第二个「内」「外」也是多余的：以前它会被当成地名，
      // 「室内 日 内」读出来地点就成了「内」。
      // 单独的「内/外」最可信；「院子里面」这种带地名的只当备选，
      // 后面只要出现明写的「外」，就按「外」算。
      if (inner && part === '内' || part === '内景' || part === '室内' || part === '室内景') {
        if (inOutStrict === '') inOutStrict = '内'
      } else if (part === '外' || part === '外景' || part === '室外' || part === '室外景') {
        if (inOutStrict === '') inOutStrict = '外'
      } else if (inOutTail === '') {
        inOutTail = inner ? '内' : '外'
      }
      const leftover = innerTail !== null ? innerTail[1] : (outerTail !== null ? outerTail[1] : '')
      if (leftover !== '') rest.push(leftover)
      continue
    }
    rest.push(part)
  }
  inOut = inOutStrict !== '' ? inOutStrict : inOutTail
  const place = rest.join(' ')
  // 只写了「室内 日 内」、没写是哪儿：日夜内外认下来了，地点留空
  // （后面会报「没写清在哪儿」，但不该把整行丢掉）。
  if (place === '') {
    if (dayNight === '' && inOut === '') return null
    return { place: '', dayNight, inOut }
  }
  // 行尾的括注（`客厅 日 内（回忆场，可加旧滤镜）`）是给人看的备注。
  // 先把一个个「（…）」拿掉再判；拿完还带括号，说明括号在名字中间，才判不是场头。
  if (/[（()）]/.test(place)) return null
  // 地名不会带句读：「他推开门，外面天黑了 夜 内」不是场头。
  if (/[，。！？；]/.test(place)) return null
  // 既没写日夜也没写内外，那就得短到像个地名；一句叙述肯定不是场头。
  if (dayNight === '' && inOut === '' && place.length > 16) return null
  return { place, dayNight, inOut }
}

/**
 * 这一小段是不是「白天还是夜里」。
 *
 * 白名单以前只有「日 夜 晨 清晨 … 白天」这一串，模型把 `日间`、`晚间` 直接当
 * 场头写进来（`客厅 日间 内`），整段被当地名，于是报「没写清是白天还是夜里」——
 * 人明明写了。时刻写法（`深夜两点`、`凌晨三点`）一起认。
 */
function isDayNightPart(part) {
  const text = String(part ?? '').trim()
  if (text === '') return false
  if (/^(日|夜|日间|夜间|晨|清晨|黎明|早晨|早|早上|早间|上午|中午|午|午间|下午|午后|黄昏|傍晚|晚|晚上|晚间|深夜|半夜|凌晨|白天|白昼|夜晚|夜里|黑天|晴|阴|阴天|雨天|雨夜|雪天|月夜)$/.test(text)) return true
  // 深夜两点 / 凌晨三点半 / 早上七点
  return /^(?:凌晨|深夜|清晨|早晨|早上|上午|中午|下午|傍晚|晚上)?[0-9０-９一二三四五六七八九十百零〇两]{1,3}\s*点(?:半|一刻|[0-9０-９]{1,2}\s*分)?$/.test(text)
}

/**
 * 这些「说话人」其实不是人：旁白、画外音、字幕。
 *
 * 提示词里写着不许用旁白，可模型还是会写 `旁白："三年后。"`。以前这一行被
 * 当成合法台词，说话人「旁白」还被并进出场人物，整场演员表就多一个人。
 */
const NARRATOR_NAMES = ['旁白', '画外音', '画外', '字幕', '字幕卡', '说明字幕', '解说']

/**
 * 冒号左边这些字不是说话人，是场记标签。
 *
 * `音乐：轻快的钢琴。` `光线：偏暗。` 这种行以前会被读成「一个叫音乐的人在说话」：
 * 演员表里凭空多出「音乐」「光线」两个角色，占掉一句台词，
 * 而且因为台词正文里没有镜头词，扫描器一条不报——写了不该写的东西，却查不出来。
 *
 * 这里把它挡在台词之外：交给主循环按标签处理（收进备注，或者照常报成镜头话）。
 */
const STAGE_LABELS = [
  '时间', '地点', '场景', '场次时间', '服装', '化妆', '备注', '说明', '注', '天气',
  '氛围', '基调', '音效', '声音', '音乐', '配乐', '光线', '色温',
  '镜头', '景别', '机位', '特写', '分镜', '时长', '转场',
  '场记', '注意', '提示', '调度', '动作提示', '表演提示',
]

/**
 * 拆一行台词：`林小雨（把伞推回去）说："雨停了。"`
 *
 * 也认不带引号的写法：`甲：走吧。`（中文剧本和话剧台本最标准的样子）。
 */
export function parseDialogueLine(line, opts) {
  // `**甲（没抬头）说："走。"**`：模型爱给台词加粗，不剥壳整行就作废、台词消失。
  let raw = String(line ?? '').trim().replace(/^[*_`#>\s]+/, '').replace(/[*_`\s]+$/, '')
  if (raw === '' || /^[△▲→▵Δ]/.test(raw) || raw.startsWith('【')) return null
  // `甲：（低声）"走吧。"` —— 括号写在冒号后面。标准写法是 `甲（低声）："…"`，
  // 但这么写的剧本不少，整行作废太浪费：把括号挪到冒号前面再走同一条路。
  const afterColon = /^(.{1,30}?)\s*[：:]\s*([（(][^）)]{0,200}[）)])\s*(["“「『].*)$/.exec(raw)
  if (afterColon !== null) raw = `${afterColon[1]}${afterColon[2]}：${afterColon[3]}`
  // 冒号左边是「名字」或「名字（括号里一句）」，名字后面可以带一个说法词。
  // 名字放宽到 20 字：`角落里那个一直没说话的男人说` 这种写法在戏里很常见，
  // 卡在 12 字会整行作废，最后落进「没归位」。
  // 括号里那句可以很长（「把伞往回一推，声音低下去」）。
  // 引号三种都收：中文弯引号（“…”）、直角引号（「…」）、普通引号（"…"）。
  // 引号里的台词允许再套引号（`甲说："他说"好"就挂断了。"`），所以取到最后一个引号为止。
  // 台词后面还可以再跟一个括注（`甲说："走。"（把门带上）`）：那也是动作，不是台词的一部分。
  //
  // 括注放宽到 200 字：模型给一个动作写长括注（「从门边退开半步，把湿透的头发
  // 别到耳后，又像是想起什么似的停住」）非常常见，卡在 60 字整行就作废、台词消失。
  // 名字放宽到 30 字同理。半角括号也收（`甲(低声)说` 以前把「甲(低声)」整个人名收下）。
  //
  // 引号也可以没有：中文剧本、话剧台本最标准的写法就是 `甲：走吧。`。
  // 只是无引号这一支要求行尾有句末标点，否则一句描述会被当成台词。
  const SAYING = '(?:说|道|问|答|喊|叫|念|嚷|吼|应|叹|回|接|嘟囔|嘀咕|笑道|低声道|轻声道|冷笑道)?'
  const quoted = new RegExp('^([^：:（(]{1,30}?)\\s*(?:[（(]([^）)]{0,200})[）)])?\\s*' + SAYING + '\\s*[：:]\\s*["“「『](.*?)["”」』]\\s*(?:[（(]([^）)]{0,200})[）)])?\\s*$').exec(raw)
  let hit = quoted
  if (hit === null) {
    // 台词后面紧跟一句没改成动作的叙述：`甲说："好。"他转身走了。`
    // 严格那一支会把整行判废、台词一起丢掉。这一支只要求「引号后面那段里没有引号」，
    // 才不会把套引号的台词（`甲说："他说"好"就挂断了。"`）切错。
    const tailed = new RegExp('^([^：:（(]{1,30}?)\\s*(?:[（(]([^）)]{0,200})[）)])?\\s*' + SAYING + '\\s*[：:]\\s*["“「『](.*?)["”」』]\\s*([^"“”「」『』]{1,120})$').exec(raw)
    if (tailed !== null) hit = [tailed[0], tailed[1], tailed[2], tailed[3], undefined, tailed[4]]
  }
  if (hit === null) {
    // 不带引号：冒号后面直接是话，且话说到句末。
    // 这一支最容易闯祸：`他想起一句话：雨停了。` `那年冬天：雪下得很大。`
    // 都是小说正文，冒号左边一长串全是叙述。照单收下的话，最该被指出来的那种行
    // 反而成了「合法台词」，演员表里还多出一个叫「他想起一句话」的人。
    // 所以名字要过一道「像不像一个人」的检验。
    const bare = /^([^：:（(]{1,30}?)\s*(?:[（(]([^）)]{0,200})[）)])?\s*(?:说|道|问|答|喊|叫|念|嚷|吼|应|叹|回|接|嘟囔|嘀咕)?\s*[：:]\s*([^"“”「」『』]{1,200}?[。！？…~]+)\s*$/.exec(raw)
    if (bare !== null) {
      const candidate = stripSaying(String(bare[1] ?? '').trim())
      if (looksLikeSpeaker(candidate, String(bare[1] ?? '').trim(), opts?.names)) {
        hit = [bare[0], candidate, bare[2], bare[3], undefined]
      }
    }
  }
  if (hit === null) return null
  const body = String(hit[3] ?? '').trim()
  // 台词前后的括注（`甲（低声）说` 与 `甲说："…"（把门带上）`）都算这一句的表演提示。
  const parenText = [String(hit[2] ?? '').trim(), String(hit[4] ?? '').trim()].filter((x) => x !== '').join('；')
  // 先留一份没剥过的：剥后缀会顺手把「慢慢」「低声」这类副词吃掉，
  // 之后再看「逗号后面是不是叙述」就看不出来了（`才慢慢说` 剥完只剩「才」）。
  const rawWho = String(hit[1] ?? '').trim()
  let who = stripSaying(rawWho)
  // 「这时候门开了，林小雨说：」——冒号左边塞了半句叙述，
  // 以前整串被当成说话人，演员表里就多出一个叫「这时候门开了，林小雨」的人。
  // 逗号后面才是名字。
  const afterComma = /[，,。；;！？]\s*([^，,。；;！？]{1,20})$/.exec(rawWho)
  // 「他顿了顿，看向窗外，才开口说：」——逗号后面那截是叙述，不是名字。
  // 以前这类会被当成一个叫「才开口」的人，演员表里多一个幽灵角色，
  // 真正的问题（这行还没改成动作或台词）反而查不出来。
  if (afterComma !== null && !NARRATION_TAIL.test(afterComma[1])) who = stripSaying(afterComma[1])
  if (who === '') return null
  // 名字里不许有句读：有就说明冒号左边不是名字，是叙述。
  if (/[，,。；;！？：:]/.test(who)) return null
  // 名字里也不许有连续的空白（「他把碗放下 又拿起来」）。
  if (/\s{2,}/.test(who)) return null
  // 旁白不是人，不进台词、更不进演员表。
  if (NARRATOR_NAMES.includes(who) || STAGE_LABELS.includes(who)) return null
  // 「甲说："走。"乙说："等等。"」写在一行里：只认第一句，
  // 后面那半句跟着走，让上层报「这行没归位」，别把两个人的话拼成一句。
  // 判据要看「引号后面紧跟一个『某人说：』」——台词里套引号
  // （`甲说："他说"好"就挂断了。"`）没有那个冒号，不能误切。
  const second = /["”」』]\s*([^"“”「」『』\n]{1,20}?(?:说|道|问|喊|答|叫|嘟囔|嘀咕)[：:])\s*["“「『]/.exec(body)
  const text = second === null ? body : body.slice(0, second.index).trim()
  const rest = second === null
    ? String(hit[5] ?? '').trim()
    : `${second[1]} ${body.slice(second.index + second[0].length).trim()}`.trim()
  return {
    who,
    paren: parenText,
    text: text.trim(),
    rest,
    line: String(line ?? '').trim(),
  }
}

/** 「没人」的几种写法。它们不是人名。 */
const PLACEHOLDER_NAMES = ['无', '沒有', '-', '—', '–', '－', '略', '空', '暂无', '没有', '无人物', 'N/A', 'n/a', 'NA']

/**
 * 逗号后面那截是叙述、不是名字：「才开口」「终于开口」「才慢慢」「回头看」。
 *
 * 这些词出现在名字的位置上，说明冒号左边整句都是散文，主角还没开口。
 * 认错了会凭空多出一个演员（叫「才开口」），而这行本该被报成「还没归位」，
 * 检查就失效了。
 */
const NARRATION_TAIL = /(?:开口|继续|终于|忽然|突然|然后|于是|只好|这才|顿了顿|想了想|愣了一下|叹了口气|回过神|抬|低|转|笑|看|停|沉默|慢慢|轻声|低声)/

/** 明显是叙述里那种泛称主语，不是人名。 */
const PRONOUN_SPEAKERS = /^(?:他|她|我|你|它|谁|有人|某人|大家|众人|所有人|两人|三个人|他们|她们|我们|你们)$/

/**
 * 不带引号的那一支要不要认这行台词：冒号左边得像一个人。
 *
 * `甲：走吧。` 是台词；`他想起一句话：雨停了。` 是小说还没改过来。
 * 区别不在有没有冒号，在冒号左边那一串是不是一个人名。三条判据从宽到严：
 *
 * 1. 已经在【出场人物】里登记过的名字（`names`）一律认——作者自己写了这张表；
 * 2. 两到四个字、不含「说写想念问答的了吗着过」、不含空白，按人名认；
 * 3. 其余一律不认，让这行照常落进「没归位」，由人自己看要不要改。
 */
function looksLikeSpeaker(candidate, original, names) {
  const name = String(candidate ?? '').trim()
  if (name === '') return false
  const pool = Array.isArray(names) ? names : []
  if (pool.length > 0 && (pool.includes(name) || pool.includes(stripSaying(name)))) return true
  if (PRONOUN_SPEAKERS.test(name)) return false
  // 带这些字的多半是整句散文的主语：「母亲在信里写」「他想起一句话」。
  if (/[说写想念问答喊叫的了吗着过]/.test(name)) return false
  // 「那年冬天：雪下得很大。」「广播里说：列车晚点。」冒号左边是时间、地点，
  // 不是人。按时间起头、按方位收尾的那种一律不认。
  if (/^(?:那|这|此|其|当)[年月日天夜早晚]/.test(name)) return false
  if (name.length <= 4 && /(?:里|中|上|下|内|外|前|后|边|旁|间)$/.test(name)) return false
  // 单字（`甲：走吧。`、`乙说："等等。"`）在剧本里就是主角本人，得认。
  if (name.length < 1 || name.length > 4) return false
  // 剥之前那串比名字长太多，说明冒号左边还有别的字，是句子不是名字。
  if (String(original ?? '').trim().length > name.length + 1) return false
  return true
}

/**
 * 拆一行「心里想的」：`（心里想：他不会回来了。）`。
 *
 * 用户那份《小说改剧本》里，心理戏的最后一道口子是「最多一句心里想的」。
 * 这一行要单独认出来，否则它会被人当成出场人物（括号里那串全被 splitNames 收进 cast）。
 */
export function parseThoughtLine(line) {
  const raw = String(line ?? '').trim()
  if (raw === '') return null
  // 括号里那句心里话本身可能还带括号（「（心里想：他走了。（真的走了））」），
  // 所以取到最后一个右括号为止，而不是第一个。
  const bracketed = /^[（(]\s*([^（(]{0,6}?)\s*(?:心里想|心想|内心|心里|暗自)[：:]\s*([\s\S]*)[）)]\s*$/.exec(raw)
  if (bracketed !== null) {
    return { text: String(bracketed[2] ?? '').trim(), line: raw }
  }
  // 也有人不带括号，就这么写一行「心里想：他走了。」
  const bare = /^(?:心里想|心想|内心独白|内心|暗自)[：:]\s*([\s\S]*)$/.exec(raw)
  if (bare !== null) return { text: String(bare[1] ?? '').trim(), line: raw }
  return null
}

/**
 * 把「林小雨道」「老周问」「她喊着说」里那个说法词剥掉。
 *
 * 剧本里「谁说」和「怎么说的」常常粘在名字后面；不剥，统计出场人物时
 * 「林小雨道」和「林小雨」会被当成两个人。
 */
function stripSaying(name) {
  // 名字后面常粘着一串说法词：「林小雨低声说」「林小雨冷冷地说」
  // 「老周叹了口气说」。不剥干净，同一个人会在演员表里出现两次
  // （「林小雨」和「林小雨低声」），出场统计就跟着不对。
  // 一层剥一层会剩下「冷冷」，所以要一直剥到不再变短为止。
  const SAY = /(?:说|道|问|答|喊|叫|念|嚷|吼|笑|哭|应|叹|回|接|嘟囔|嘀咕)$/
  // 只剩两个字的时候不能照上面那串剥：「道」「问」「笑」「念」「应」「回」「叹」
  // 在中文姓名里到处都是（张道、苏问、王笑、白念、陈应、沈回、郑叹），
  // 剥掉就把一个人变成另一个人。只有这几个几乎不做名字末字的才敢剥。
  const SAFE_SAY = /(?:说|喊|叫|答|嚷|吼|哭)$/
  // 「甲又说」「乙接着说」：这几个字是连接，不是名字。
  const LINK = /(?:又|再|接着|然后|继续|随后|补了?一句|转了?头|回过?头)$/
  const ADVERB = /(?:低声|轻声|大声|高声|小声|冷冷|淡淡|慢慢|轻轻|急急|忙忙|缓缓|沉沉|咬着牙|皱着眉|瞪着眼|叹口气|叹了口气|没抬头|抬起头|转过身|别过头)$/
  let out = String(name ?? '').trim()
  for (let round = 0; round < 6; round++) {
    const before = out
    // 剥之前先看名字还剩多长：两个字的名字差不多就是全名了，
    // 除了「说/喊/叫」这一类，一个字都不动（`白念` 不许变成 `白`）。
    const mayStrip = out.length > 2
    if (mayStrip) out = out.replace(ADVERB, '')
    if (out.length > 2) out = out.replace(/[的地]$/, '')
    if (out.length > 2 || SAFE_SAY.test(out)) out = out.replace(SAY, '')
    if (out.length > 2) out = out.replace(/[的了着]$/, '')
    // 连接词紧跟单字人名（`甲又说` → `甲`）也得剥：正则先把「说」吃掉，
    // 剩下「甲又」已经只有两个字，光看长度就不敢动了，人就多一个「甲又」。
    if (out.length > 1) out = out.replace(LINK, '')
    if (out === before) break
  }
  // 行首的数字编号（`1. 甲说：…`）是清单号，不是名字的一部分。
  out = out.replace(/^[0-9０-９一二三四五六七八九十]{1,3}\s*[.．、]\s*/, '')
  return out.trim()
}

/** 把 `甲、乙 丙` 拆成名字数组。 */
function splitNames(text) {
  const src = String(text ?? '')
  // 「林 小雨、甲」：名字里带空格的人（复姓加名、外文名）很常见。
  // 一旦见到顿号或逗号，就说明作者已经在用分隔符了，空格只当作名字内部的分隔。
  const seps = /[、,，/]/.test(src) ? /[、,，/]+/ : /[、,，/\s]+/
  return src
    .split(seps)
    // 括注（「甲（主角）」「乙（配音：老周）」）是说明，不是名字的一部分；
    // 留着它跟人名表对不上，统计里就成了两个不同的人。
    .map((x) => x.trim().replace(/[（(][^）)]*[）)]/g, '').trim())
    // 「无」「—」「略」是没人的意思，不是一个人。留着它，演员表里就多一个幽灵角色。
    .filter((x) => x !== '' && !PLACEHOLDER_NAMES.includes(x))
}

/**
 * 把一份剧本读成「场」。
 *
 * 只认形式，不判好坏：哪几场、每场在哪儿、白天还是夜里、里面谁在、
 * 有几行动作、几句台词、有没有没归位的散行。判断交给 `scanScript`，
 * 改不改交给人。
 */
export function parseScriptScenes(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const total = lines.length
  // 剧名一行。模型常常顺手加个 markdown 井号（`# 《雨里的门》`），也是剧名。
  const titleLine = lines.find((line) => /^\s*(?:#+\s*)?《.+》\s*$/.test(line))
  const title = titleLine === undefined
    ? ''
    : String(titleLine).trim().replace(/^#+\s*/, '').replace(/^《/, '').replace(/》$/, '')
  const scenes = []
  let preamble = []
  let current = null
  let mode = ''

  // 用下标循环：跨行续词那一段要把下面几行吞掉，吞完得能把游标往前挪。
  for (let index = 0; index < lines.length; index++) {
    // 模型爱把整份剧本写成 markdown 列表（`- △她把伞靠在门边。`、`- 陈默：伞放门边。`）。
    // 行首那个圆点是排版，不是戏；不剥掉的话每一行都落进「没归位」，
    // 连演员表里都会多出一个叫「- 陈默」的人。
    const raw = String(lines[index] ?? '').trim().replace(/^[-*+•·]\s+/, '')
    // 场号前面可能是「【第1场】」「场景1」「1.」，后面可能是「：旧书店」。
    // 模型和人都爱写成这几种，只认「第N场」会把一份好剧本读成 0 场。
    // 场号的写法就是这些：第3场 / 第 3 场 / 【第3场】/ 场景3 / 场3 / SCENE 3 / 三、
    // 还有 markdown 和加粗壳子（`## 第3场`、`**第3场**`）——模型爱把标题加粗。
    // 一起认了，不然从别处粘回来的剧本整份读成 0 场。
    const sceneHit = SCENE_NO_RE.exec(raw)
    // 「1.」「2、」这种要先看后面是不是真场头。
    // 场内容里模型的编号行（`1. 他推开门。`、`1. 甲说："走。"`、人物清单）到处都是，
    // 一律当场号会把一份好剧本切成十几个假场，再连报三条误报。
    // 判据只有一条：点后面得真像一行场头（写了日夜或内外），
    // 或者这一行只剩编号、场头写在下一行。
    // 捕获组：1 第N场/第N幕、2 场景N、3 场次N、4 场N/幕N、5 SCENE N、6 N.、7 中文数字、8 同行场头。
    // `1.` 单独一行、场头写在下一行（`## 第3场` 那种只差一个 #）：
    // 下一行真像场头的话，这一行的编号就认。
    const nextIsHead = sceneHit !== null
      && String(sceneHit[8] ?? '').trim() === ''
      && looksLikeSceneHead(String(lines[index + 1] ?? '').trim())
    // 阿拉伯数字和中文数字这两种「编号 + 标点」写法一样要形状校验：
    // 正文里 `1. 他推开门。` 到处都是，`三、他把碗放下，转身往门口走。` 也一样，
    // 一律当场号会把叙述整行吞掉（还只报一句「第 3 场没有场头」）。
    const numberedOk = sceneHit === null
      || (sceneHit[6] === undefined && sceneHit[7] === undefined)
      || looksLikeSceneHead(sceneHit[8])
      || nextIsHead
    if (sceneHit !== null && numberedOk) {
      current = {
        no: sceneNumber(firstFilled(sceneHit[1], sceneHit[2], sceneHit[3], sceneHit[4], sceneHit[5], sceneHit[6], sceneHit[7])),
        place: '', dayNight: '', inOut: '',
        // 自己写没写【出场人物】。台词里出现的人也会并进 cast，但那是「说过话的」，
        // 不等于「写清楚谁在这一场」——两个概念要分开，否则 no-cast 永远不报。
        declared: false,
        cast: [], props: [], actions: [], dialogues: [], thoughts: [], beats: [], other: [], notes: [],
        // 原始行留着：上一章改出来的剧本，最后一场要整段带进下一章，
        // 靠「动作 + 台词」重建会丢掉场头那一行（客厅 日 内）。
        raw: [],
      }
      scenes.push(current)
      mode = ''
      // 加粗/标题壳子里的场头（`**第1场 客厅 日 内**`、`## 第3场 门外 夜 外`）：
      // 行尾的 `**` 会把「内」粘成「内**」，日夜内外就认不出来了。
      let inline = String(sceneHit[8] ?? '').trim().replace(/^[#>*_\s]+/, '').replace(/[#>*_\s]+$/, '').trim()
      // 场号同行还带着标签（`第2场 客厅 夜 内 【关键道具】红伞`）：
      // 把 【…】 那几段先切出来分派，剩下才是场头。
      // 以前整行当场头，标签进了地名，红伞这个道具就无声无息地没了。
      // 标签名可能带后缀（`【人物表】`、`【道具清单】`），标签后面也可能紧跟内容
      // （`【关键道具】红伞`），两截都要收。
      const tagRe = /[【\[]([^】\]]{0,40})[】\]]([^【\[]*)/g
      let tagHit = tagRe.exec(inline)
      while (tagHit !== null) {
        const tagName = String(tagHit[1] ?? '').trim()
        const tagBody = String(tagHit[2] ?? '').trim()
        inline = inline.replace(tagHit[0], ' ').trim()
        const body = tagBody.replace(/^[：:]/, '').trim()
        // 标签后面那截得真像几个名字。`【人物简介】林小雨是女一。` 后面是一句话，
        // 不是名字；以前整句会被塞进演员表，表里就多一个十一字长的「人」。
        if (!looksLikeNameList(body) && body !== '') {
          current.other.push(body)
        } else if (/^(?:出场人物|出场人员|人物|登场人物|角色)/.test(tagName)) {
          for (const name of splitNames(body)) {
            if (!current.cast.includes(name)) current.cast.push(name)
          }
          if (current.cast.length > 0) current.declared = true
        } else if (/^(?:关键道具|道具)/.test(tagName)) {
          for (const prop of splitNames(body)) {
            if (!current.props.includes(prop)) current.props.push(prop)
          }
        }
        tagHit = tagRe.exec(inline)
      }
      const head = inline === '' ? null : parseSceneHeadLine(inline)
      if (head !== null && (head.dayNight !== '' || head.inOut !== '' || head.place !== '')) {
        current.place = head.place
        current.dayNight = head.dayNight
        current.inOut = head.inOut
      } else if (inline !== '') {
        // 场号后面跟的不是场头，是一句叙述（`第2场 她跑进雨里，没回头。`）。
        // 以前整段就这么扔了：不进动作、不进散行、一条提示都没有，
        // 用户永远不会知道自己少了半句。留进散行，让扫描器报「没归位」。
        current.other.push(inline)
      }
      continue
    }
    if (current === null) {
      // 第一个场号之前的行（剧名下面的说明、人物表、「本剧改编自…」）
      // 以前直接 continue，静默丢掉，谁也不知道少了几行。
      // 剧名那一行不算「没进戏」，它是标题，上面已经认出来了。
      if (raw !== '' && !/^\s*(?:#+\s*)?《.+》\s*$/.test(raw)) preamble.push(raw)
      continue
    }
    if (raw === '') { mode = ''; current.raw.push(''); continue }
    current.raw.push(raw)

    // 这一栏的写法五花八门：【出场人物】、出场人物：、【 出场人物 】、【人物】、【登场人物】。
    // 只认一种，剩下的都读成「这场没写人」，演员表就排不出来。
    // 标签外面可能套一层加粗（`**【出场人物】** 林小雨、陈默`），一起剥。
    const castHit = /^\*{0,2}\s*[【\[]?\s*\*{0,2}\s*(?:出场人物|出场人员|人物|登场人物|角色)[^【\[\]】\n]{0,6}\s*\*{0,2}\s*[】\]]?\s*[：:]?\s*\*{0,2}\s*(.*)$/.exec(raw)
    if (castHit !== null) {
      const body = String(castHit[1] ?? '').trim()
      // `【人物简介】林小雨是女一。` 后面是一句话，不是名字。
      // 以前整句被当成一个演员，表里就多一个十一字长的「人」。
      if (body === '' || looksLikeNameList(body)) {
        mode = 'cast'
        for (const name of splitNames(body)) {
          if (!current.cast.includes(name)) current.cast.push(name)
        }
        // 标签后面一个名字都没有（空着、或者写「无」）不算写清了谁在这场。
        // 早先只要出现这四个字就算，这条检查于是只查「有没有写标签」。
        if (current.cast.length > 0) current.declared = true
      } else {
        mode = ''
        current.other.push(body)
      }
      continue
    }
    const propHit = /^\*{0,2}\s*[【\[]?\s*\*{0,2}\s*(?:关键道具|道具)[^【\[\]】\n]{0,6}\s*\*{0,2}\s*[】\]]?\s*[：:]?\s*\*{0,2}\s*(.*)$/.exec(raw)
    if (propHit !== null) {
      const body = String(propHit[1] ?? '').trim()
      if (body === '' || looksLikeNameList(body)) {
        mode = 'props'
        for (const prop of splitNames(body)) {
          if (!current.props.includes(prop)) current.props.push(prop)
        }
      } else {
        mode = ''
        current.other.push(body)
      }
      continue
    }
    // 「时间：深夜。」「地点：客厅。」这类场记信息。
    // 它们是正经剧本里有的东西，但**不是台词**——以前会被读成「一个叫时间的
    // 人在说话」，演员表里凭空多出「时间」「地点」两个角色，还占掉一句台词。
    // 这里单独收着，不报「没归位」（人写的是对的东西，只是不在我们认的五种行里）。
    // 注意别把「音乐：」「光线：」「音效：」收进来——那几样提示词里明写着不许写，
    // 收进备注等于把它们藏起来，扫描器就再也报不出来了。
    const noteHit = /^\*{0,2}\s*[【\[]?\s*\*{0,2}\s*(?:时间|地点|场景|场次时间|服装|化妆|备注|说明|注|天气|场记|注意|提示|调度|动作提示|表演提示)\s*\*{0,2}\s*[】\]]?\s*[：:]\s*\*{0,2}\s*(.*)$/.exec(raw)
    if (noteHit !== null) {
      const noteText = String(noteHit[1] ?? '').trim()
      if (noteText !== '') current.notes.push(noteText)
      mode = ''
      continue
    }

    // 动作行里夹着一句心里话（`△ 他站着。（心里想：他不回来了。）`）：
    // 把动作那段留下，心里那段拆出去单独算一条。这一条要在「△ 开头」那条之前，
    // 否则整行都进 actions，心里话就没人数了。
    // 行首记号三种都认：△（标准）、▲（模型偶尔写）、→（中文输入法里打得出）。
    const inlineThought = /^[△▲→]\s*([\s\S]*?)\s*[（(]\s*(?:[^（(]{0,6}?\s*)?(?:心里想|心想|内心|心里|暗自)[：:]([\s\S]*)[）)]\s*$/.exec(raw)
    if (inlineThought !== null) {
      const actionText = String(inlineThought[1] ?? '').trim()
      if (actionText !== '') current.actions.push(actionText)
      current.thoughts.push({ text: String(inlineThought[2] ?? '').trim(), line: raw })
      mode = ''
      continue
    }
    if (/^[△▲→▵Δ]/.test(raw)) {
      current.actions.push(raw.slice(1).trim())
      mode = ''
      continue
    }
    // 整行就是一个括注、又短（「（沉默）」「（他站起来）」）：那是节拍，不是没归位的行。
    // 心里话走下面的 parseThoughtLine，别在里被截走。
    // 整行就是一个括注：不管多长都是表演提示。
    // 早先限了 20 字，写得细一点的舞台提示（`（他把碗放下，转身往门口走，走到一半又停下来）`）
    // 就同时被判成「没归位」和「这一场没有动作」，两遍都错。
    const beat = /^[（(][^（()）]{1,120}[）)]$/.exec(raw)
    if (beat !== null && parseThoughtLine(raw) === null) {
      current.beats.push(raw)
      mode = ''
      continue
    }
    // 「（心里想：……）」单独是一种行：不算动作、不算台词，更不能当人名。
    const thought = parseThoughtLine(raw)
    if (thought !== null) {
      current.thoughts.push(thought)
      mode = ''
      continue
    }
    // 一个人连着说两段、换行写的那种：
    //   甲说："我跟你说，
    //   这事儿没完。"
    // 第一行只有开引号、没有闭引号，整行就废了。合并到出现闭引号那一行为止。
    // 只在「行里有名字 + 冒号 + 开引号，但没有闭引号」时才合并，
    // 否则会把一整段正常的动作行吞进来。
    // 「已经闭了引号」就不算跨行——哪怕后面还跟着一个括注（`甲说："走。"（转身）`）。
    // 那是完整的一句加一个动作注释，下面单行分支自己处理得了。
    const hasClosedQuote = /["”」』]\s*(?:（[^）]{0,60}）)?\s*$/.test(raw)
    if (current !== null && /[：:]\s*["“「『]/.test(raw) && !hasClosedQuote) {
      // 往下找闭引号，但**只许在同一段台词里找**：碰到场号、动作行、标签行、
      // 或者下一句台词的开口（又是一个「名字+冒号+引号」），立刻停手。
      // 早先没有这条边界，一路吞下去，最多吞掉整整一场（场号、场头、出场人物全没了），
      // 而且吞掉的东西不进任何一栏，扫描器一条都不报——这是唯一一类
      // 「用户永远不会知道自己少了什么」的错。
      let merged = raw
      let next = index + 1
      let closed = false
      while (next < lines.length && next <= index + 6) {
        const more = String(lines[next] ?? '').trim()
        if (more === '') break
        if (looksLikeSceneStart(more)) break
        if (/^[△▲→▵Δ]/.test(more)) break
        if (/^[【\[]/.test(more)) break
        // 续行里又出现「名字 + 冒号 + 开引号」：那是下一句台词，不是这句的续行。
        // （续行本身长这样也会被误停，但台词里再套「某某说：」的情况比丢一句台词罕见得多，
        //  而且被停下的那一行后面照常走正常分支，不会丢东西。）
        if (/[：:]\s*["“「『]/.test(more)) break
        merged = `${merged}\n${more}`
        next += 1
        if (/["”」』]\s*(?:（[^）]{0,60}）)?\s*$/.test(more)) { closed = true; break }
      }
      if (closed) {
        const joined = parseDialogueLine(merged.replace(/\n/g, ''), { names: current.cast })
        if (joined !== null) {
          // 行号跳过合并掉的那几行。
          index = next - 1
          current.dialogues.push(joined)
          if (joined.who !== '' && !current.cast.includes(joined.who)) current.cast.push(joined.who)
          // 合并进来的后半句（或者后头那句别人的话）照单行分支的规矩留一条原文，
          // 让扫描器报「这行没归位」。以前这里直接扔掉，整句台词就无声消失了。
          if (String(joined.rest ?? '') !== '') current.other.push(joined.rest)
          mode = ''
          continue
        }
      }
    }
    // 一个人连着说两段、第二段没写名字，只有一句引号：
    //   甲说："走。"
    //   "顺便把伞还了。"
    // 第二行整行只是一个引号句。当成「没归位」太亏——它明显还是甲在说。
    // 归到上一句的说话人，两句并成一句（中间留一个空格）。
    // 只紧跟上一条台词（`mode === 'dialogue'`）时才算：中间隔了一个动作，
    // 这句引号可能是另一个人在说话，也可能是引用一件东西上的字。
    const onlyQuote = /^["“「『]([\s\S]+)["”」』]\s*(?:[（(][^）)]{0,60}[）)])?\s*$/.exec(raw)
    if (onlyQuote !== null && mode === 'dialogue' && current.dialogues.length > 0) {
      const last = current.dialogues[current.dialogues.length - 1]
      const extra = String(onlyQuote[1] ?? '').trim()
      if (extra !== '' && String(last?.text ?? '') !== '') {
        last.text = `${last.text} ${extra}`.trim()
        mode = 'dialogue'
        continue
      }
    }
    const said = parseDialogueLine(raw, { names: current.cast })
    if (said !== null) {
      current.dialogues.push(said)
      // 说这句话的人也算出场的人：写没写【出场人物】是另一件事，扫的时候分开算。
      if (said.who !== '' && !current.cast.includes(said.who)) current.cast.push(said.who)
      // 一行里塞了两个人的话（`甲说："走。"乙说："等等。"`）：
      // 第二句原样留下，让扫描器报「这行没归位」，别让它悄悄消失。
      if (String(said.rest ?? '') !== '') current.other.push(said.rest)
      mode = 'dialogue'
      continue
    }
    // 场号下面紧跟的那一行常常就是「客厅 日 内」。
    if (headless(current)) {
      // `**客厅 日 内**` / `## 客厅 日 内` 单独占一行：跟同行写法一样先剥壳。
      const head = parseSceneHeadLine(raw.replace(/^[#>*_\s]+/, '').replace(/[#>*_\s]+$/, ''))
      // parseSceneHeadLine 认不出来会回 null（带句读的句子、台词、道具行都可能）。
      // 这里要求「写了白天夜里或屋里屋外」：只有地名的一行很可能是叙述
      // （「他把碗放下」只有五个字，看着也像地名），吞掉就再没人报了。
      if (head !== null && (head.dayNight !== '' || head.inOut !== '')) {
        current.place = head.place === '' ? current.place : head.place
        current.dayNight = head.dayNight === '' ? current.dayNight : head.dayNight
        current.inOut = head.inOut === '' ? current.inOut : head.inOut
        continue
      }
    }
    // 【出场人物】下面那行默认是名字，但模型经常直接接着写叙述。
    // 带句读的一律不算名字——否则「他把碗放下。」会被当成一个人，
    // 这一行也就再不会出现在「没归位」里。
    // 标签下面那几行默认是名字，可模型经常直接把下一场的场头、或者一句叙述
    // 接着写下去。这里先试场头：认得出就是下一场，别把它吞成演员名
    // （`【出场人物】甲` 紧跟 `厨房 夜 内`，以前第二场连场头一起被当成人名，
    // 一场戏整个消失，零提示）。
    if (mode === 'cast' || mode === 'props') {
      const maybeHead = parseSceneHeadLine(raw)
      if (maybeHead !== null && (maybeHead.dayNight !== '' || maybeHead.inOut !== '')) {
        // 它不是名字，是场头。
        // 这一场还没写场头 → 就地补上（别让这一场永远「没写场头」）。
        if (current.place === '' && current.dayNight === '' && current.inOut === '') {
          current.place = maybeHead.place
          current.dayNight = maybeHead.dayNight
          current.inOut = maybeHead.inOut
          mode = ''
          continue
        }
        // 这一场的场头已经齐了，标签下面又冒出一个场头：那是下一场，
        // 只是作者没写「第 2 场」这几个字。开一个新的空场号接着写，
        // 不然这一整场（连同后面的动作）都会被当成人名吞掉，一条提示都不报。
        current = {
          no: (scenes.length > 0 ? Number(scenes[scenes.length - 1].no) || scenes.length : scenes.length) + 1,
          place: maybeHead.place, dayNight: maybeHead.dayNight, inOut: maybeHead.inOut,
          declared: false,
          cast: [], props: [], actions: [], dialogues: [], thoughts: [], beats: [], other: [], notes: [],
          raw: [raw],
        }
        scenes.push(current)
        mode = ''
        continue
      } else if (looksLikeNameList(raw)) {
        if (mode === 'cast') {
          for (const name of splitNames(raw)) {
            if (!current.cast.includes(name)) current.cast.push(name)
          }
          if (current.cast.length > 0) current.declared = true
        } else {
          for (const prop of splitNames(raw)) {
            if (!current.props.includes(prop)) current.props.push(prop)
          }
        }
        continue
      } else {
        // 标签下面写了句叙述（`【关键道具】菜刀` 换行 `她把刀放在案板上`）：
        // 它不是名字。以前这条整行被当成人名/道具名塞进去，画面上少了这个动作，
        // 演员表里还多一个九字长的人。退出这一栏，让这行照常落进散行。
        mode = ''
      }
    }
    current.other.push(raw)
  }

  for (const scene of scenes) {
    // 空场只看有没有动作和台词。心里话和「（沉默）」不算——
    // 一场戏里只有一句「（心里想：他不会回来了。）」，拍出来就是一个
    // 站着不动的空镜头，配音也没台词可念。以前这两种算作不空，
    // 于是「只有一句心里话」的场一条提示都没有。
    scene.empty = scene.actions.length === 0 && scene.dialogues.length === 0
    scene.lines = scene.actions.length + scene.dialogues.length + scene.thoughts.length + scene.beats.length + scene.other.length
  }
  return {
    title,
    scenes,
    // 第一个场号之前那些行。不算问题，但要在报告里说一句「有几行没进戏」，
    // 免得人以为它们凭空不见了。
    preamble,
    counts: {
      scenes: scenes.length,
      actions: scenes.reduce((n, s) => n + s.actions.length, 0),
      dialogues: scenes.reduce((n, s) => n + s.dialogues.length, 0),
      thoughts: scenes.reduce((n, s) => n + s.thoughts.length, 0),
      beats: scenes.reduce((n, s) => n + s.beats.length, 0),
      notes: scenes.reduce((n, s) => n + s.notes.length, 0),
      scenesWithoutHead: scenes.filter((s) => s.dayNight === '' || s.inOut === '').length,
      emptyScenes: scenes.filter((s) => s.empty).length,
    },
    lines: total,
  }
}

/**
 * 场号：`1` 和 `一` 都认。
 *
 * 中文剧本里「第一场」写得比「第1场」还多；不认的话整份剧本会被读成
 * 「一场都没有」，后面的检查一条也跑不起来。
 */
function sceneNumber(text) {
  // 全角数字（「１」）经常从别的软件里粘过来，先归一成半角。
  const raw = String(text ?? '').trim().replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  if (/^\d+$/.test(raw)) return Number(raw)
  const DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (raw === '十') return 10
  let total = 0
  let section = 0
  let digit = 0
  for (const ch of raw) {
    if (DIGIT[ch] !== undefined) { digit = DIGIT[ch]; continue }
    if (ch === '十') { section += (digit === 0 ? 1 : digit) * 10; digit = 0; continue }
    if (ch === '百') { section += (digit === 0 ? 1 : digit) * 100; digit = 0; continue }
  }
  total = section + digit
  return total > 0 ? total : 1
}

/**
 * `1. 客厅 日 内` 这种带编号的场头：点后面得真像一行场头（有日夜或内外）。
 *
 * 只凭「数字 + 点」当场号太宽——`1. 他推开门。` 会被切成一场。
 */
function looksLikeSceneHead(inline) {
  const text = String(inline ?? '').trim()
  if (text === '') return false
  const head = parseSceneHeadLine(text)
  return head !== null && (head.dayNight !== '' || head.inOut !== '')
}

/**
 * 场号那一行。捕获组 1–6 是场号本身（数字或中文数字），7 是同一行后面带的场头。
 *
 * 认的写法：`第3场` / `【第3场】` / `第3幕` / `场景3` / `场3` / `场次3` / `幕3` /
 * `SCENE 3` / `3.`（后面点后面真像场头才算）/ `三、`。前面可以有 `第一章`、
 * markdown 壳子（`##`、`-`、`>`、`**`）、箭头。
 */
const SCENE_NO_RE = /^(?:[-–—•·*>#_\s→]*)(?:(?:第\s*[0-9０-９一二三四五六七八九十百零〇两]+\s*[章集卷幕]|Chapter\s*\d+|幕\s*[0-9０-９一二三四五六七八九十百零〇两]+)[\s·、:：.-]*)?(?:[【\[]?第\s*([0-9０-９一二三四五六七八九十百零〇两]+)\s*[场幕][】\]]?|场景\s*([0-9０-９一二三四五六七八九十百零〇两]+)|场次\s*([0-9０-９一二三四五六七八九十百零〇两]+)|[场幕]\s*([0-9０-９一二三四五六七八九十百零〇两]+)|(?:SCENE|Scene|scene)\s*([0-9０-９]+)|([0-9０-９]{1,3})\s*[.．、)）](?![0-9０-９])|([一二三四五六七八九十百零〇两]{1,4})\s*[、])\s*[*_\s]*[：:]?\s*(.*)$/

/**
 * 这一行是不是「场号行」——判断合并台词要不要停手时用。
 *
 * 比主循环宽：只要看起来是个场号就行，不管后面跟的是不是场头。
 * 少认一行的代价是「把下一场吞进这句台词里」，那种错没人会发现。
 */
function isSceneNumberLine(line) {
  const raw = String(line ?? '').trim()
  if (raw === '') return false
  const hit = SCENE_NO_RE.exec(raw)
  if (hit === null) return false
  // 只要认出了场号（任何一支）就算。`SCENE 3` 那支是英文字，也照样算。
  return hit[1] !== undefined || hit[2] !== undefined || hit[3] !== undefined
    || hit[4] !== undefined || hit[5] !== undefined || hit[6] !== undefined || hit[7] !== undefined
}

/** 合并台词时的停手判据。 */
function looksLikeSceneStart(line) {
  return isSceneNumberLine(line)
}

/** 几个捕获组里取第一个有字的。 */
function firstFilled(...values) {
  for (const value of values) if (value !== undefined && String(value).trim() !== '') return String(value).trim()
  return ''
}

/** 这行看着像一串名字吗（短、不带句读、不带动作）。 */
function looksLikeNames(line) {
  const raw = String(line ?? '').trim()
  if (raw === '' || raw.length > 40) return false
  if (/[。！？，；：]/.test(raw)) return false
  return true
}

/**
 * 标签**下面**紧接的一行是不是还在继续报名字。
 *
 * `looksLikeNames` 只要求「短、没句读」，可中文句子本来就可以不带句号：
 * `【关键道具】菜刀` 下面写「她把刀放在案板上」，它照样通过，
 * 于是这一行动作被当成道具名塞进清单，画面上少了这个动作，
 * 道具表里多一个九字长的东西。
 *
 * 判据换成「一个个数出来都像名字」：拆出来的每一段不超过六个字，
 * 而且要么分段多于一段、要么整行本来就短。一整句九个字没分隔的，
 * 按散文算。
 */
function looksLikeNameList(line) {
  const raw = String(line ?? '').trim()
  if (!looksLikeNames(raw)) return false
  const parts = raw.split(/[、,，/\s]+/).filter((x) => x !== '')
  if (parts.length === 0) return false
  if (parts.some((x) => x.length > 6)) return false
  return parts.length > 1 || raw.length <= 6
}

/** 这一场还没认出「在哪儿 / 日还是夜 / 内还是外」。 */
function headless(scene) {
  return scene.place === '' && scene.dayNight === '' && scene.inOut === ''
}

/**
 * 剧本里不该出现的东西。
 *
 * 这几组词不是文风问题：写进剧本就没人能拍。有一半来自用户给的
 * 《小说改剧本》：不写秒数时长、不写镜号景别机位运镜、不写成分镜、
 * 不用旁白代替对话。台词里出现「等我一秒」是正常的，所以只扫
 * 动作行和没归位的散行，不扫台词。
 */
// 「镜头」「特写」这些词在戏里也会当普通名词用：他举起相机，镜头对准窗外；
// 桌上一叠特写照片；院里的老式机位还架在那儿。所以不能见到就报，
// 得看写成什么样子——见 CAMERA_PATTERNS。
// 「旁白似的念白」「画外音一样的声音」是比喻，不是说明。所以不裸配，看写法。
const CAMERA_WORDS = []

/**
 * 真写成镜头说明的样子。命中才算问题。
 *
 * 分成几条是有意的：单纯出现「镜头」两个字不算，`镜头推近`「镜头摇过」
 * 「特写：」这种才是有人在写分镜。
 */
const CAMERA_PATTERNS = [
  // 「旁白」只认写成说明口吻的：`旁白：`、行首「旁白说」、或者「加了一段旁白」。
  // 裸的「旁白」不算——`△ 旁白的声音从隔壁传过来。` 是收音机里的声音，是戏。
  { word: '旁白', re: /旁白\s*[：:]|^\s*(?:△\s*)?旁白\s*(?:说|念|道|：|响起|响起来|\s*[，。])|(?:加|配|打上|插入|补)\s*(?:一段|段)?\s*旁白/ },
  { word: '画外音', re: /画外音\s*[：:]|^画外音|[，。！？]\s*画外音(?:响起|传来)|(?:加|配|插入)\s*画外音/ },
  { word: '画外', re: /画外\s*[：:]|（画外）|\(画外\)/ },
  // 「镜头慢慢拉开」「镜头缓缓推近」：副词夹在中间也要算。
  // 但「他对着镜头笑了一下」「拉开镜头盖」是戏，不是分镜——「笑」「盖」都不在动词表里。
  // 行首那个字是「镜头」才按分镜算：「镜头对准窗外」是分镜，
  // 「他举起相机，镜头对准窗外」是戏里那个人手里正好有台相机。
  { word: '镜头', re: /^\s*△?\s*镜头\s*(?:一路|慢慢|缓缓|轻轻|猛地|突然|迅速|远远)?\s*.{0,10}?(?:一\s*(?:转|推|拉|晃|摇)|推|拉|摇|移|跟|升|降|切|转|给|带到|扫过|停在|停住|定格|对准)|(?:推|拉|摇|移|跟|升|降)镜(?:头)?|镜头[：:]/ },
  // `切到陈默翻账本的手`：行首一个「切到/转到」就是分镜，戏里没人这么说话。
  { word: '切镜', re: /^(?:△\s*)?(?:切|转|划|摇|推|拉)到[^，。！？]{0,12}[。！？]?$|^(?:△\s*)?(?:切|转|划)到|(?:^|[，。；])\s*(?:后|再|又|直)?切到/ },
  // 「摄像机」在戏里是道具：婚礼上有人扛着、监控装在墙角。
  // 只有当这句话是在说「给到哪台机器」时才算分镜。
  { word: '摄像机', re: /^(?:△\s*)?(?:摄像机|摄影机|摇臂)\s*[：:]|(?:机位|镜头|特写|拍到|摇到|切到|摇臂)\s*(?:对准|给到|推到)?\s*(?:摄像机|摄影机|摇臂)|(?:摄像机|摄影机)\s*(?:推|拉|摇|跟|升|降)/ },
  // 景别写在行首就是分镜：`△中景，两个人在桌前。`「大远景」「远镜头」都算。
  // 但「远处的全景照片」这种是戏里的话，所以要求它落在行首。
  { word: '景别', re: /景别\s*[：:＝=]|(?:大远景|大特写|远镜头|中镜头|近镜头)|^(?:△\s*)?(?:远|全|中|近|特)景别?(?:\s*[：:，,。！？]|$)|^(?:△\s*)?(?:远|全|中|近|特)景[^，。！？]{0,8}[。！？]?$|^(?:△\s*)?空镜\s*[：:]/ },
  // `镜头A：`「镜号3：」「镜头一：」——分镜表里的编号写法，戏里没人这么写。
  // 只认后面跟冒号的，`他对着镜头笑了一下` 不算。
  { word: '镜号', re: /^(?:△\s*)?(?:镜头|镜号)\s*[A-Za-z0-9一二三四五六七八九十]{1,3}\s*[：:]|镜号\s*[A-Za-z0-9一二三四五六七八九十]{1,3}/ },
  // 「3号机位」「手持跟拍」「肩扛」都是拍摄说明。
  { word: '机位标记', re: /\d+\s*号机位|手持|肩扛|跟拍|稳定器/ },
  // 「特写她的手」就是分镜写法，不需要冒号。
  { word: '特写', re: /特写\s*[：:]|(?:给|来个|推到|切到)(?:一个|个)?特写|特写镜头|特写[^，。！？]{0,6}[她他它脸眼手嘴脚]/ },
  { word: '机位', re: /机位\s*[：:]|机位(?:在|从|放到|架在)|换个机位/ },
  // 「他不懂运镜，也不懂剪辑」是在说那个人不懂，不是分镜写法。
  { word: '运镜', re: /运镜\s*[：:]|^\s*(?:△\s*)?运镜/ },
  // 俯拍/仰拍/越轴/定格 当普通动词用的概率极低，直接裸认。
  { word: '机位角度', re: /俯拍|仰拍|越轴|航拍|俯视镜头|仰视镜头/ },
  { word: '定格', re: /定格\s*[：:]|(?:加|来|给|插)(?:一个|个)?定格|画面定格|定格画面|^(?:△\s*)?定格\s*(?:[，。！？；]|$)/ },
  { word: '闪回', re: /闪回\s*[：:]|(?:插|加|来)(?:一个|个)?(?:回忆)?闪回|闪回镜头/ },
  // 「婚礼录像里音乐响起来」「乐队起了一个调子，音乐响起」是现场的声音，是戏。
  // 只有在写成提示口吻时才报：`配乐：`、`背景音乐渐弱`、`插入一段配乐`。
  { word: '配乐', re: /(?:配乐|音乐|音效|声音)\s*[：:]|^(?:△\s*)?(?:配乐|音乐)\s*(?:起|响起|淡入|淡出)|(?:背景音乐|插曲)\s*(?:渐弱|渐强|起|响起|淡入|淡出)|插入?(?:一段)?(?:配乐|音乐)|(?:配乐|音乐)\s*(?:渐弱|渐强)/ },
  { word: '光线', re: /光线\s*[：:]|色温\s*[：:]|(?:打光|布光)\s*[：:]/ },
  // 「黑场」「淡入」「淡出」都是戏里也可能出现的词（院子里的黑场子、像淡入的夜）。
  // 跟转场动词搭配才算分镜。
  // 「画面渐暗，转场。」「转场。」单独一句也是分镜台词，不是戏。
  // 「画面转为黑白」也是在写调色说明。单写「画面暗下来」是戏，不管。
  { word: '调色', re: /画面\s*(?:转为|变成|切成|渐暗|渐亮|定格)|色调\s*[：:]|黑白画面|慢速快门|幻灯片式的?回忆/ },
  { word: '转场', re: /转场\s*[：:]|(?:淡入|淡出|叠化|黑场)\s*(?:转场|过场)?\s*[：:]|(?:切|转|划|叠)\s*(?:到|入|出)?\s*(?:黑场|下一场)|转场(?:特效|方式)|叠化|(?:^|[，。；])\s*转场\s*(?:$|[。！？])/ },
  { word: '分镜', re: /分镜\s*[：:]|分镜头?脚本|画分镜|分镜稿(?:是|谁|给)/ },
  // 「升格成」「规格升格」是常用词；只有写成素材处理才是分镜。
  // 「把性子升格成了一种沉默」「规格升格」都是日常说法。只有明摆着在说素材/镜头才算。
  { word: '升格', re: /升格(?:镜头|素材|处理)|素材升格|降格(?:镜头|素材|处理)|高帧率|(?:^|[，。；])\s*(?:升格|降格)\s*[，。！？；]|^(?:△\s*)?(?:升格|降格)\s*[：:]/ },
  // 「他放慢动作」是戏（动词「放」+ 宾语「慢动作」），
  // 「用了个慢动作」「慢动作镜头」才是分镜写法。
  { word: '慢动作', re: /慢动作\s*[：:]|用了?(?:一个|个)?慢动作|慢动作(?:镜头|特效|处理)|高帧率|慢镜头/ },
  { word: '时长', re: /时长\s*[：:＝=]|本场.{0,6}时长|(?:总|全片)时长/ },
]

/**
 * 这几个词可能只是戏里出现的东西：「电视上滚过一行字幕」「隔壁在放背景音乐」
 * 「门外有人说话，像旁白」。只有写成说明口吻（后面跟冒号、或者前面是「加/配/打上」）
 * 才按镜头词算。
 */
// 旁白 / 画外音 / 画外 不在这一组：它们不会在现场出现成一样东西，写上就是镜头话。
const AMBIGUOUS_WORDS = ['字幕', '背景音乐', 'BGM']
// 「电视上在打上字幕，一行一行往上滚」是现场画面里的事，不是在写分镜。
// 所以「打上」只认宾语紧跟的那种写法（`打上字幕：`、`配上字幕`），
// 而且允许中间隔一个「在」：`在打上字幕` 里那个「上」是动词补语，不是数字幕。
const AMBIGUOUS_HINT = /(?:加|配|配上|插入|叠)\s*(?:字幕|背景音乐|BGM|旁白|画外音|画外)|^(?:字幕|背景音乐|BGM|旁白|画外音|画外)[：:]/

/**
 * 「秒」单独拿出来按样子判。
 *
 * 动作行里写「他愣了两秒」是正常的——那是戏，不是镜头说明。真正不许的是
 * 「第 3 秒」「停留 2 秒」「本场 30 秒」这种把表掐在纸上。所以只在它跟
 * 这些词搭在一起时才报。
 */
// 「秒」的判据全都绑单位：`停留 3 分钟` 是戏，`停留 3 秒` 才是时长。
// 「秒」这一档最难：剧本里的「他愣了两秒」是戏，不是镜头话。
// 判据是「谁在停」——主语是镜头/画面/黑场/定格这一类的，才是在写时长。
// 顺带认中文数字（「画面停住两秒」比「停住 2 秒」写得更常见）。
const SECONDS_NUM = '[0-9０-９一二三四五六七八九十百两半]+'
const SECONDS_HINT = new RegExp(
  '(?:'
  + `第\\s*${SECONDS_NUM}\\s*秒`            // 第3秒
  + `|${SECONDS_NUM}\\s*秒(?:钟)?(?:时|处|的镜头|后切)`  // 三秒处、5秒后切
  + `|停留\\s*${SECONDS_NUM}\\s*秒`           // 停留 2 秒
  + `|本场.{0,6}${SECONDS_NUM}\\s*秒`          // 本场大约 30 秒
  + `|(?:镜头|画面|黑场|黑屏|定格|转场|字幕|空镜|特写|全景|近景|中景|远景|画外音)[^。！？\\n]{0,10}?${SECONDS_NUM}\\s*秒`  // 画面停住两秒
  + `|(?:时长|片长|长度)\\s*[：:]\\s*[^。！？\\n]{0,8}${SECONDS_NUM}`  // 时长：15 秒
  + `|(?:长达|持续|一共|共)\\s*${SECONDS_NUM}\\s*秒`  // 长达三秒钟
  + ')'
)

/** 这行里有没有镜头话。有就说中的是哪个词，没有回空串。 */
function cameraWordIn(line) {
  // 行首那对括号要先剥掉：`△（镜头拉远）`、`（特写：她的手）` 里的「镜头」「特写」
  // 就这么被括号挡在行首之外，判据一条也命中不了。
  const text = String(line ?? '').replace(/^\s*[（(]\s*/, '').replace(/\s*[）)]\s*$/, '')
  for (const word of CAMERA_WORDS) {
    if (text.includes(word)) return word
  }
  for (const rule of CAMERA_PATTERNS) {
    if (rule.re.test(text)) return rule.word
  }
  for (const word of AMBIGUOUS_WORDS) {
    if (text.includes(word) && AMBIGUOUS_HINT.test(text)) return word
  }
  const hit = SECONDS_HINT.exec(text)
  return hit === null ? '' : '秒'
}

/**
 * 数一遍这份剧本（只数，不评价）。
 *
 * `scanScript` 的活是「让作者一眼看见自己没注意到的东西」：哪一场没写日夜内外、
 * 哪一场是空的、哪句话写了机位、有多少行叙述还停在小说里没转成动作。
 */
export function scanScript(text) {
  // 自己先剥一层围栏：别人（测试、界面里粘回来的东西）未必先剥过。
  // 不剥的话，` ``` ` 那一行会被算成「第 1 场之前还有 1 行」外加一行没归位。
  const clean = stripFence(text)
  const parsed = parseScriptScenes(clean)
  const chars = String(clean ?? '').replace(/\s/g, '').length
  const issues = []

  if (parsed.scenes.length === 0) {
    issues.push({
      kind: 'no-scene',
      label: '没有认出任何一场',
      detail: '场次要单独一行写成「第1场」，后面一行写「客厅 日 内」。',
    })
  }

  const cameraHits = []
  const stray = []
  const narrators = []
  for (const scene of parsed.scenes) {
    for (const action of scene.actions) {
      // 动作行里夹了一句心里话（`△ 他站着。（心里想：…）`）：报出来，
      // 心里话该单独占一行，不然配音的时候没人知道这段话谁来念。
      if (/[（(]\s*(?:心里想|心想|内心|心里|暗自)\s*[：:]/.test(action)) {
        stray.push({ scene: scene.no, sample: `心里话跟动作写在一行了，拆开单独写一行：${action}` })
      }
      const word = cameraWordIn(action)
      if (word !== '') cameraHits.push({ scene: scene.no, word, sample: `△${action}` })
    }
    // 台词正文不再扫镜头词。角色张嘴说「你懂什么运镜」「旁白还没录呢」
    // 是在说话，不是有人在写分镜；把这种句子报成「写了拍不出来的东西」，
    // 人会以为这个检查在瞎报。真正不该出现的是「旁白：」这种当成台词写的说明行，
    // 那条在上面的 narrators 里单独管。
    // 「（镜头推近到她的脸）」「（心里想：镜头慢慢拉远）」一样是在写分镜。
    // 以前这两栏一条都不扫，写了也零提示——最容易被当成「写对了」。
    for (const beat of scene.beats) {
      // 节拍本身就是一整行括注（`（镜头拉远）`）。剥掉外层那对括号再看，
      // 不然「镜头」永远不在行首，判据一条也命中不了。
      const inner = String(beat).replace(/^[（(]\s*/, '').replace(/\s*[）)]$/, '')
      const word = cameraWordIn(inner)
      if (word !== '') cameraHits.push({ scene: scene.no, word, sample: beat })
    }
    for (const thought of scene.thoughts) {
      const word = cameraWordIn(String(thought?.text ?? ''))
      if (word !== '') cameraHits.push({ scene: scene.no, word, sample: `（心里想：${thought.text}）` })
    }
    for (const line of scene.other) {
      // 旁白 / 画外音 / 字幕行：解析器已经不把它当台词了，这里单独说一句为什么不行，
      // 不再重复报成镜头话、也不再重复报「没归位」——同一行数三遍只会让人不信这个检查。
      if (/^(?:旁白|画外音|画外|字幕|字幕卡|说明字幕|解说)\s*[：:]/.test(line)) {
        narrators.push({ scene: scene.no, sample: line })
        continue
      }
      const word = cameraWordIn(line)
      if (word !== '') {
        // 同一行不再报「没归位」：人写的是镜头话，说清这一件就够了。
        // 一行数两遍只会让他觉得这个检查在瞎报。
        cameraHits.push({ scene: scene.no, word, sample: line })
        continue
      }
      stray.push({ scene: scene.no, sample: line })
    }
  }

  if (Array.isArray(parsed.preamble) && parsed.preamble.length > 0) {
    issues.push({
      kind: 'preamble',
      label: `第 1 场之前还有 ${parsed.preamble.length} 行没进戏`,
      detail: '剧名下面写注释、或者先列一张人物表，这些行不算场里的内容。想留就放进动作行，不想留就删掉。',
      samples: parsed.preamble.slice(0, 3).map((line) => String(line).slice(0, 40)),
    })
  }

  if (narrators.length > 0) {
    issues.push({
      kind: 'narrator',
      label: `有 ${narrators.length} 处用的是旁白`,
      detail: '旁白一出来，画面上就得有人念；看戏的人也就从戏里出来了。能让人物说就让人物说，能用一个动作演出来更好。',
      samples: narrators.slice(0, 3).map((n) => `第 ${n.scene} 场：${n.sample}`),
    })
  }

  if (cameraHits.length > 0) {
    issues.push({
      kind: 'camera',
      label: `有 ${cameraHits.length} 处写了拍不出来的东西`,
      detail: '秒数、镜号、景别、机位、运镜、音乐、字幕都不进剧本。要么删，要么改成现场看得见的动作。',
      samples: cameraHits.slice(0, 3).map((h) => `第 ${h.scene} 场「${h.word}」：${h.sample}`),
    })
  }

  const noHead = parsed.scenes.filter((s) => s.dayNight === '' || s.inOut === '')
  if (noHead.length > 0) {
    issues.push({
      kind: 'no-head',
      label: `有 ${noHead.length} 场没写清是白天还是夜里、是屋里还是屋外`,
      detail: '排班、找场地、配光都靠这一行。写成「客厅 日 内」就够了。',
      samples: noHead.slice(0, 3).map((s) => `第 ${s.no} 场${s.place === '' ? '' : ` ${s.place}`}`),
    })
  }

  const noCast = parsed.scenes.filter((s) => s.declared !== true)
  if (noCast.length > 0) {
    issues.push({
      kind: 'no-cast',
      label: `有 ${noCast.length} 场没写谁在这场里`,
      detail: '【出场人物】空着，演员表就排不出来。',
      samples: noCast.slice(0, 3).map((s) => `第 ${s.no} 场`),
    })
  }

  // 场号重复：两场都叫「第1场」，排班和配音会直接对上错的那一场。
  // 解析器不替人改号（改了就不是作者写的号了），但要说出来。
  const seenNo = new Set()
  const dupNo = []
  for (const sc of parsed.scenes) {
    if (seenNo.has(sc.no)) dupNo.push(sc.no)
    seenNo.add(sc.no)
  }
  if (dupNo.length > 0) {
    issues.push({
      kind: 'dup-scene',
      label: `有 ${dupNo.length} 个场号重了`,
      detail: '场号是拿来对场次的：重了，排班和配音就会对上另一场。往下顺一遍号。',
      samples: dupNo.slice(0, 3).map((n) => `第 ${n} 场`),
    })
  }

  // 心里话一场最多一句：提示词里明写着，可一直没人查。
  // 三句心里话连着排，演员只能站在那儿不动，把心里的事念出来——
  // 那就不是戏了，是有声书。
  const tooManyThoughts = parsed.scenes.filter((sc) => sc.thoughts.length > 1)
  if (tooManyThoughts.length > 0) {
    issues.push({
      kind: 'too-many-thoughts',
      label: `有 ${tooManyThoughts.length} 场心里话超过一句`,
      detail: '心里话一场留一句就够，多出来的要么改成让人物说出来，要么改成一个动作演出来。',
      samples: tooManyThoughts.slice(0, 3).map((sc) => `第 ${sc.no} 场：${sc.thoughts.length} 句`),
    })
  }

  const empty = parsed.scenes.filter((s) => s.empty)
  if (empty.length > 0) {
    issues.push({
      kind: 'empty-scene',
      label: `有 ${empty.length} 场是空的`,
      detail: '一场里既没有动作也没有台词，这一场就什么也没发生。',
      samples: empty.slice(0, 3).map((s) => `第 ${s.no} 场`),
    })
  }

  // 按场看，不是看整份：第十章有动作，不代表第三场也有。
  // 只有台词没有动作的那一场，念出来就行，画面上什么也没有。
  // 「（他把碗放下）」是舞台提示，中文剧本传统里就是动作行。
  // 早先只认 △，于是写了动作的人被提示「这一场只有台词、没有动作」，
  // 他会去再补一个 △ 把同一件事写一遍。
  // 「括号里写了动作」也算动作：`甲（把碗放下，站起来）说："我走了。"`
  // 中文剧本里这就是在写动作，只不过写在了说的人旁边。
  // 早先只认 △ 和整行括注，于是这种场被提示「只有台词、没有动作」，
  // 人会去再补一个 △ 把同一件事写第二遍。
  const noAction = parsed.scenes.filter((sc) => sc.actions.length === 0
    && sc.beats.length === 0
    && !sc.dialogues.some((d) => String(d?.paren ?? '').trim() !== '')
    && sc.dialogues.length > 0)
  if (noAction.length > 0) {
    issues.push({
      kind: 'no-action',
      label: `有 ${noAction.length} 场只有台词、没有动作`,
      detail: '人在哪儿、手里拿着什么、说完做了什么，一句都没有的话，配音出来是一片空白。每场至少给一个 △ 动作。',
      samples: noAction.slice(0, 3).map((sc) => `第 ${sc.no} 场${sc.place === '' ? '' : ` ${sc.place}`}`),
    })
  }

  if (stray.length > 0) {
    issues.push({
      kind: 'stray',
      label: `有 ${stray.length} 行没归位`,
      detail: '这些行既不是场号、不是「△动作」、也不是「谁（…）说："…"」，多半是小说里的叙述还没改过来。',
      samples: stray.slice(0, 3).map((s) => `第 ${s.scene} 场：${s.sample}`),
    })
  }

  return {
    ok: parsed.scenes.length > 0,
    title: parsed.title,
    chars,
    counts: parsed.counts,
    scenes: parsed.scenes,
    issues,
    total: issues.length,
  }
}

/**
 * 剥掉外面的三引号围栏。
 *
 * 模型就算被要求「只给剧本本身」，也常把它包进 ``` 里。那一行进了剧本，
 * 第一场就没了场头，扫描器一路报「没归位」。剥的时候连语言标记一起去掉。
 */
export function stripFence(text) {
  let body = String(text ?? '').replace(/^\uFEFF/, '').trim()
  // 语言标记不一定是英文：模型写过 ```剧本、```txt、```markdown。
  // 只认 [a-zA-Z]* 的话，`剧本` 会留在正文第一行，整份剧本就多一行「第 1 场之前还有 1 行没进戏」。
  // 反引号围栏和波浪号围栏（`~~~`）都剥。早先只认反引号，
  // 模型用 `~~~` 围起来的那份剧本一行都没剥掉，第一场之前凭空多一行。
  const opened = /^(?:```|~~~)[^\n]{0,20}\r?\n?/.exec(body)
  if (opened === null) return body
  body = body.slice(opened[0].length)
  // 闭合围栏后面模型常补一句「以上是第 1 场，需要我再展开吗？」。
  // 那句不是剧本，但围栏本身会留下来变成一行「看起来像台词又不是」的东西。
  // 围栏闭上的那一刻，剧本就结束了；后面再说什么都不是剧本
  // （「以上是第 1 场，需要我再展开吗？」留在正文里，扫描器会把它算成一行没归位的东西）。
  const closed = /\r?\n?(?:```|~~~)(?:[\s\S]*)$/.exec(body)
  if (closed !== null) body = body.slice(0, closed.index)
  body = body.replace(/^(?:```|~~~)[^\n]{0,20}$/gm, '')
  // 万一模型在围栏里又套了一层，末尾剩下的围栏也剪掉。
  body = body.replace(/\r?\n?(?:```|~~~)\s*$/, '')
  return body.trim()
}

/** 把 `scanScript` 的结果说成人话（附在模型意见后面，不改它的话）。 */
export function scriptReportText(scan) {
  if (scan === null || scan === undefined) return ''
  const c = scan.counts ?? {}
  const lines = [`共 ${c.scenes ?? 0} 场，台词 ${c.dialogues ?? 0} 句，动作 ${c.actions ?? 0} 行。`]
  for (const issue of scan.issues ?? []) {
    lines.push(`· ${issue.label}${issue.detail === undefined ? '' : `：${issue.detail}`}`)
    for (const sample of issue.samples ?? []) lines.push(`  ${sample}`)
  }
  return lines.join('\n')
}

/**
 * 拆一行场头：`客厅 日 内`。
 *
 * 单独导出：测试和界面都要用同一条判据，别一边认「夜里」一边不认。
 */
export { parseSceneHeadLine }

/**
 * 把一章小说改成剧本。
 *
 * 提示词是照着用户那份《小说改剧本》蒸馏的：留下**改的时候真会出错的地方**
 * （分场、台词干活、心理不外露、叙述转动作、连续性、拍不出来的东西不写），
 * 丢掉那些只能当口号念的条款。全塞进去会让模型顾着数条款，一句也写不好。
 */
export function buildScriptPrompt({
  title, genre, idea, chapterNo, chapterTitle, chapterBody,
  cast, worldEntries, previousTail, ask, sceneHint,
}) {
  const lines = []
  lines.push(`你在把一部小说改成剧本。不是写小说，也不是写分镜。`)
  lines.push('')
  lines.push(`这本书叫《${String(title ?? '').trim() === '' ? '没起名' : title}》。`)
  if (String(genre ?? '').trim() !== '') lines.push(`题材：${String(genre).trim()}`)
  if (String(idea ?? '').trim() !== '') lines.push(`这本书讲的是：${String(idea).trim()}`)
  if (String(previousTail ?? '').trim() !== '') {
    lines.push('', '【上一章改出来的剧本，最后一场】（接着它的东西继续：谁站在哪、手上有什么、有没有伤）', String(previousTail).trim())
  }
  if (Array.isArray(worldEntries) && worldEntries.length > 0) {
    lines.push('', '【设定】', worldEntries.join('\n\n'))
  }
  if (Array.isArray(cast) && cast.length > 0) {
    lines.push('', '【人】', cast.join('\n'))
  }
  lines.push('', `【要改的是第 ${Number(chapterNo) || 1} 章${String(chapterTitle ?? '').trim() === '' ? '' : `：${String(chapterTitle).trim()}`}】`)
  lines.push(String(chapterBody ?? '').trim())
  if (String(ask ?? '').trim() !== '') lines.push('', `这一章改的时候注意：${String(ask).trim()}`)

  lines.push(
    '',
    '【怎么改】',
    '- 只改这一章。这一章写到哪儿就改到哪儿，不许替作者往下编——没写出来的情节、没交代的结局，就是没有，不要自己补。',
    '- 不加原著里没有的人和事，不改结局，不提前把后面的底说出来。原著里的关键台词、伏笔、反转、道具，一件都不许丢。',
    '- 分场只看两件事：地方变了，或者时间跳了（隔了很久、进了回忆、跟着另一拨人走了）。同一个地方只是换了人说话、换了个动作，不换场。别一人一句就换一场，也别把一整场揉成一大段。',
    `- 一场里得有事：谁想要什么、被什么挡住、这一场结束时局面跟开始时不一样。${Number(sceneHint) > 0 ? `这一章大约 ${Number(sceneHint)} 场。` : '场数由内容决定，别为了凑数拆。'}`,
    '- 开场晚一点进（从第一句有用的话或第一个动作开始），结尾早一点走（说完就走，做完就切）。',
    '- 每一句台词都要干活：推进、顶人、透露、遮掩、试探、拒绝、下决心、改主意。不干活的删掉，或者并进别的句子里。同一件事不说两遍。',
    '- 人物只能说自己知道的事。不许替作者解释设定——「她不知道，这个家族三百年来……」这种话不许出现在台词里。',
    '- 心理按这个顺序处理：先看能不能用表情和动作演出来（把碗放下、往门口看一眼），演不出来就让人物自己说出来，实在不行才给一句心里想的，写成「（心里想：……）」，最多一句。不用旁白念心理。',
    '- 小说里的叙述改成动作行：以「△」开头，一行一个连续的动作或画面，写清位置、朝向、谁对谁、手上拿着什么、结果怎么样。',
    '- 环境只留看得见听得见的几样（光、天气、声音、手上的东西），不写大段景物；拍不出来的比喻和气氛一律不写（「他感觉命运正在转动」这种不许出现）。',
    '- 台词格式：`角色名（情绪或动作）说："台词。"`。括号里写演得出来的东西（把伞推回来、盯着碗），不写「心里一沉」。',
    '- 标点有分工，别混着用：`！` 喊着说，`？` 问，`！？` 又惊又怒，`……` 话没说完或者停住，`~` 拖着音说（软、哄、玩笑）。',
    '- 连续性：上一场结束时谁站在哪、手上有什么、身上有没有伤、门开着还是关着、信在谁兜里——下一场要接得住，不能凭空消失。',
    '- 不写：秒数、时长、镜号、景别、机位、运镜、转场特效、音乐、字幕、旁白。',
    '- 每场结尾落在明确的地方：一句话说完、一个动作做完、一个决定下了。别在这场的半句台词还没落地时就换场。',
    '- 交之前自己过一遍：有没有谁说了他不该知道的事、道具断没断、原著里的情节漏没漏。发现就改，这些检查的话不要写出来。',
    '',
    '【输出格式】（照这个样子写。地名、人名、台词换成你这一章的，格式别改。）',
    '《剧本名》',
    '第1场',
    '旧书店·门厅　夜　内',
    '【出场人物】林小雨、陈默',
    '【关键道具】红伞、那封信',
    '△她把伞靠在门边，伞尖还在滴水。',
    '陈默（没抬头）说："伞放门边。"',
    '△林小雨没动，手还搭在门把上。',
    '林小雨（声音很低）说："我等了三个钟头。"',
    '',
    '第2场',
    '门外　夜　外',
    '【出场人物】林小雨',
    '【关键道具】红伞',
    '△她站在雨里，把伞举过头顶，又放下。',
    '（心里想：他不会回来了。）',
    '',
    '只给剧本本身。不要解释怎么改的，不要目录，不要写「以上是第 1 场」，也不要在最后问我满不满意。',
  )
  return lines.join('\n')
}

/**
 * 「改成剧本」这件事的系统提示。
 *
 * 单独一句：模型很容易滑回写小说的位置（于是全是景物和心理），
 * 或者滑到分镜剧本那边去（于是满页镜号）。先把位置钉住。
 */
export function buildScriptSystemNote() {
  return [
    '你是一个把小说改成剧本的编剧。改出来的东西要能直接拿去配音、拿去拍。',
    '你不写小说，不写分镜，也不写镜头说明。',
    '你只做一件事：把这一章的叙述换成动作行和台词，把它切成一串场。',
  ].join('\n')
}

/** 取一段结尾的若干字（给下一章当「上一章结尾」）。 */
export function tailOf(body, chars = 600) {
  const text = String(body ?? '').trim()
  if (text.length <= chars) return text
  return `…${text.slice(-chars)}`
}

export default {
  BOOK_DIR,
  CHAPTER_SOFT_LIMIT,
  MAX_CHAPTERS,
  bookIdOf,
  bookRelPath,
  isValidChapterIndex,
  chapterFileName,
  chapterIndexOf,
  renderBookMarkdown,
  parseBookText,
  readBook,
  listChapters,
  readChapter,
  writeChapter,
  deleteChapter,
  createBook,
  updateBook,
  deleteBook,
  listBooks,
  buildChapterPrompt,
  buildOutlinePrompt,
  parseOutline,
  readOutline,
  writeOutline,
  SCRIPT_DIR,
  scriptRelPath,
  readScript,
  writeScript,
  deleteScript,
  listScripts,
  parseDialogueLine,
  parseThoughtLine,
  parseSceneHeadLine,
  parseScriptScenes,
  scanScript,
  scriptReportText,
  stripFence,
  buildScriptPrompt,
  buildScriptSystemNote,
  tailOf,
}
