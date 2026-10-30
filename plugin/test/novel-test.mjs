// 写小说：规划 → 写章 → 审稿。
//
// 这一层的价值不在「能存文件」（那太容易），而在三件容易做错的事：
//   1. 大纲要能被人改、改完能读回来（它是整本书唯一的走向依据）；
//   2. 章号不能乱：删了第三章，第四章还是第四章，不能突然变成第三章；
//   3. 让 AI 写某一章时，它拿到的必须是**这一章**的计划 + 上一章结尾 +
//      设定 + 人物——少一样它就会开始自己编。
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as novel from '../lib/novel.js'
import * as store from '../lib/store.js'

let pass = 0, fail = 0
const t = (n, c, x) => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, String(x === undefined ? '' : JSON.stringify(x)).slice(0, 400)) } }

const stamp = Date.now()
const ws = path.join(tmpdir(), 'lifecard-novel-' + stamp)
await fs.mkdir(ws, { recursive: true })
await store.openWorkspace(ws, { create: true })

console.log('\n=== 1. 章号：补零、字典序就是章序 ===')
{
  t('第 1 章是 001.md', novel.chapterFileName(1) === '001.md', novel.chapterFileName(1))
  t('第 12 章是 012.md', novel.chapterFileName(12) === '012.md', novel.chapterFileName(12))
  t('第 100 章是 100.md', novel.chapterFileName(100) === '100.md', novel.chapterFileName(100))
  t('反解 007 得 7', novel.chapterIndexOf('007.md') === 7, novel.chapterIndexOf('007.md'))
  t('不认识的文件名返回 0', novel.chapterIndexOf('大纲.md') === 0, novel.chapterIndexOf('大纲.md'))
  t('超上限夹住', novel.chapterFileName(9999) === '999.md', novel.chapterFileName(9999))
}

console.log('\n=== 2. 建一本书、写几章、读回来 ===')
{
  const made = await novel.createBook(ws, { title: '雾港', genre: '悬疑', idea: '一个港口城市里，三个人各自藏着一件事。' })
  t('建得起来', made.ok === true, made)
  t('书 id 是中文保留', made.id === '雾港', made.id)
  t('book.md 落在 books/<id>/ 下', String(made.path).startsWith('books/雾港/'), made.path)

  const c1 = await novel.writeChapter(ws, '雾港', 1, '# 第一章 雨\n\n雨下了三天。')
  t('第一章写得下', c1.ok === true, c1)
  t('章节按 001 命名', c1.path.endsWith('/001.md'), c1.path)
  const c2 = await novel.writeChapter(ws, '雾港', 0, '# 第二章 船\n\n船进港了。')
  t('index 给 0 表示接在后面（第 2 章）', c2.index === 2, c2)

  const book = await novel.readBook(ws, '雾港')
  t('书读得回来', book.ok === true, book)
  t('两章都在', book.chapters.length === 2, book.chapters.length)
  t('章题从正文第一行取', book.chapters[0].title === '第一章 雨', book.chapters[0].title)
  t('一句话简介存住了', book.idea.includes('港口城市'), book.idea)

  const got = await novel.readChapter(ws, '雾港', 1)
  t('单章读得回来', got.ok === true && got.body.includes('雨下了三天'), got.body)

  const shelf = await novel.listBooks(ws)
  t('书架列得出这本书', shelf.ok === true && shelf.books.some((b) => b.id === '雾港'), shelf.books)
  t('书架上带章数', shelf.books[0].chapters === 2, shelf.books[0])

  // 同名不覆盖：另起一本
  const again = await novel.createBook(ws, { title: '雾港' })
  t('同名新建不覆盖，另起一个号', again.ok === true && again.id !== '雾港', again)
}

console.log('\n=== 3. 删一章之后章号不重排 ===')
{
  await novel.createBook(ws, { title: '编号试验' })
  await novel.writeChapter(ws, '编号试验', 1, '一')
  await novel.writeChapter(ws, '编号试验', 2, '二')
  await novel.writeChapter(ws, '编号试验', 3, '三')
  const del = await novel.deleteChapter(ws, '编号试验', 2)
  t('删得掉第二章', del.ok === true, del)
  const book = await novel.readBook(ws, '编号试验')
  t('剩下 1 和 3', book.chapters.map((c) => c.index).join(',') === '1,3', book.chapters.map((c) => c.index))
  t('第三章还是第三章', book.chapters[1].index === 3, book.chapters[1].index)
}

console.log('\n=== 4. 大纲：能存、能读、能从模型输出里扒出来 ===')
{
  const raw = [
    '主线：三个人各自藏着一件事，最后在码头上撞见。',
    '',
    '第1章 主角在雨夜接到一通电话，去码头接一个陌生人。',
    '第2章 陌生人不见了，只留下一只箱子。',
    '第3章 打开箱子，里面是二十年前的报纸。',
    '',
    '结局：报纸上的照片里，三个人都在场。',
  ].join('\n')
  const parsed = novel.parseOutline(raw)
  t('扒得出主线', parsed.theme.includes('三个人各自藏着'), parsed.theme)
  t('扒得出三章', parsed.chapters.length === 3, parsed.chapters)
  t('每章的计划是具体的事', parsed.chapters[0].plan.includes('雨夜接到一通电话'), parsed.chapters[0])
  t('扒得出结局', parsed.ending.includes('三个人都在场'), parsed.ending)

  const wrote = await novel.writeOutline(ws, '雾港', raw)
  t('大纲存得下', wrote.ok === true, wrote)
  t('存完报章数', wrote.chapters === 3, wrote.chapters)
  const back = await novel.readOutline(ws, '雾港')
  t('大纲读得回来', back.ok === true, back.ok)
  t('读回来还有三章', back.chapters.length === 3, back.chapters.length)

  // 人改一行再存：改完要能读到新的
  const edited = raw.replace('去码头接一个陌生人', '去码头接一个不该出现的人')
  await novel.writeOutline(ws, '雾港', edited)
  const back2 = await novel.readOutline(ws, '雾港')
  t('人改过的那句是新的', back2.text.includes('不该出现的人'), back2.chapters[0].plan)

  // 乱的格式不该崩
  const messy = novel.parseOutline('随便写点什么\n没有主线也没有章节\n')
  t('乱七八糟的输出不崩、章数为 0', messy.ok === false && messy.chapters.length === 0, messy)
}

console.log('\n=== 5. 给 AI 的话：这一章的计划、上一章结尾、设定、人，都得在 ===')
{
  const prompt = novel.buildChapterPrompt({
    title: '雾港',
    idea: '三个人各自藏着一件事',
    genre: '悬疑',
    previousTail: '船进港了，汽笛响了三声。',
    currentBody: '他站在雨里。',
    ask: '写他打开箱子那一段',
    worldEntries: ['这座港口一年有三百天在下雨。'],
    cast: ['【老陈】话很少，习惯先看别人的鞋。'],
    outline: '第1章 …\n第2章 …',
    chapterPlan: '打开箱子，里面是二十年前的报纸。',
  })
  t('书名叫上了', prompt.includes('《雾港》'), '')
  t('这一章的计划在', prompt.includes('打开箱子，里面是二十年前的报纸'), '')
  t('整本书的大纲在', prompt.includes('第1章'), '')
  t('上一章结尾在', prompt.includes('汽笛响了三声'), '')
  t('这一章已写的在', prompt.includes('他站在雨里'), '')
  t('世界设定在', prompt.includes('三百天在下雨'), '')
  t('出场的人设在', prompt.includes('老陈'), '')
  t('作者这一句要求在', prompt.includes('打开箱子那一段'), '')
  t('明说了不写章节标题', prompt.includes('不写章节标题'), '')
  t('明说了只写这一章', prompt.includes('只写这一章'), '')
  t('要求形容词能还原到具体东西上', prompt.includes('能用手的场面'), '')
  t('要求不解释刚写出来的动作', prompt.includes('不解释刚写出来的东西'), '')
  t('要求比喻只在现场捞', prompt.includes('比喻只在现场捞'), '')
  t('对话框里的短回应允许留', prompt.includes('人物对话里「行」'), '')

  const outlinePrompt = novel.buildOutlinePrompt({
    title: '雾港', genre: '悬疑', idea: '三个人', cast: [], worldEntries: [], chapters: 8, ask: '',
  })
  t('规划提示词要 8 章', outlinePrompt.includes('8 章'), '')
  t('规划提示词规定了输出格式', outlinePrompt.includes('第1章'), '')
  t('规划提示词要它写结局', outlinePrompt.includes('结局：'), '')
}

console.log('\n=== 6. 取结尾：短的原样，长的裁掉前面 ===')
{
  t('短的原样返回', novel.tailOf('就一句话', 100) === '就一句话', novel.tailOf('就一句话', 100))
  const long = 'A'.repeat(1000) + '结尾这几个字'
  const tail = novel.tailOf(long, 20)
  t('长的只留后面', tail.endsWith('结尾这几个字') && tail.length <= 21, tail.length)
  t('裁掉的时候标了省略号', tail.startsWith('…'), tail.slice(0, 5))
}

await fs.rm(ws, { recursive: true, force: true }).catch(() => {})
console.log('\n=== 7. 书名里带「..」不能把工作区删掉 ===')
// 书 id 是从书名来的，而书名是用户能随便打的。以前 `bookRelPath('..')` 是 `'.'`，
// `deleteBook` 于是 `fs.rm(root + '.', {recursive:true})` —— 整个工作区（卡、材料、
// 提案、快照）一次删光。这一组就是拴住那个口的。
{
  t('「..」收成安全的目录名', novel.bookRelPath('..') === 'books/未命名', novel.bookRelPath('..'))
  t('「.」收成安全的目录名', novel.bookRelPath('.') === 'books/未命名', novel.bookRelPath('.') === 'books/未命名' ? 'books/未命名' : novel.bookRelPath('.'))
  t('「books」不会指回 books 自己', novel.bookRelPath('books') !== 'books', novel.bookRelPath('books'))
  t('中间的点压成一个', novel.bookRelPath('a..b') === 'books/a.b', novel.bookRelPath('a..b'))
  t('正常书名照旧', novel.bookRelPath('雨里的门') === 'books/雨里的门', novel.bookRelPath('雨里的门'))

  const them = path.join(ws, 'books', '活着')
  await fs.mkdir(path.join(them, 'chapters'), { recursive: true })
  await fs.writeFile(path.join(them, 'book.md'), 'lifecard: "0.1"\nkind: book\ntitle: 活着\n', 'utf8')
  await fs.writeFile(path.join(them, 'chapters', '001.md'), '正文', 'utf8')
  const before = await fs.readdir(ws)
  await novel.deleteBook(ws, '..')
  await novel.deleteBook(ws, '.')
  await novel.deleteBook(ws, '')
  const after = await fs.readdir(ws)
  // 判据不是「返回 ok:false」——sanitize 之后它们变成 books/未命名，删的是那个空目录，
  // 返回 ok:true 也没关系。真正的判据是：工作区里别的东西一个都没少。
  t('工作区一个文件都没少', JSON.stringify(before.sort()) === JSON.stringify(after.sort()), after)
  const alive = await fs.stat(path.join(them, 'chapters', '001.md')).then(() => true).catch(() => false)
  t('那本书的正文还在', alive)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
