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
    return { ok: false, error: '这本书的命令行读不出来。检查一下文件夹权限。' }
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

/** 取一章结尾的若干字（给下一章当「上一章结尾」）。 */
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
  tailOf,
}
