// 写日记：一天一篇、自己指定的文件夹、带得动模型问话。
//
// 这一层容易做错的地方：
//   1. 日记不能落进档案文件夹（用户原话「日记不用存插件」），位置由他自己挑；
//   2. 一天一个文件、文件名就是日期，手改过的坏日期不能造出读不回来的文件；
//   3. 一次问一件事——提示词里那几条是这一层唯一的功能，漏一条就退化成问卷；
//   4. 改「我」那张卡、改日记助手那张卡，都要先问过用户（approved），
//      不许模型自己闷头改。
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as diary from '../lib/diary.js'
import * as api from '../lib/index.js'
import * as store from '../lib/store.js'

let pass = 0, fail = 0
const t = (n, c, x) => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, String(x === undefined ? '' : JSON.stringify(x)).slice(0, 400)) } }

const ws = await fs.mkdtemp(path.join(tmpdir(), 'lc-diary-'))
const diaryDir = path.join(tmpdir(), `lc-diary-books-${Date.now()}`)
const exists = (p) => fs.stat(p).then((s) => s.isFile()).catch(() => false)

const ctx = {
  webServer: { register: () => () => {} },
  reflect: { get: () => undefined },
  effect: (fn) => { fn(); return () => {} },
  logger: { warn: () => {} },
  get: () => undefined,
}

try {
  console.log('\n=== 1. 文件名就是日期，坏日子一个都不造 ===')
  {
    t('正常日期', diary.dateFileName('2026-10-31') === '2026-10-31.md', diary.dateFileName('2026-10-31'))
    t('闰年 2 月 29 号认', diary.dateFileName('2024-02-29') === '2024-02-29.md', diary.dateFileName('2024-02-29'))
    t('平年 2 月 29 号不认', diary.dateFileName('2025-02-29') === '', diary.dateFileName('2025-02-29'))
    t('13 月不认', diary.dateFileName('2026-13-01') === '', diary.dateFileName('2026-13-01'))
    t('45 号不认', diary.dateFileName('2026-10-45') === '', diary.dateFileName('2026-10-45'))
    t('带路径的不认', diary.dateFileName('../evil') === '', diary.dateFileName('../evil'))
    t('空的不认', diary.dateFileName('') === '' && diary.dateFileName(undefined) === '', '')
    t('前后空格抹掉', diary.dateFileName(' 2026-11-01 ') === '2026-11-01.md', diary.dateFileName(' 2026-11-01 '))
  }

  console.log('\n=== 2. 日记放哪儿：用户自己定，没定就是空 ===')
  {
    t('没配就是空串', diary.diaryRootFrom({}) === '', diary.diaryRootFrom({}))
    t('配了就是那个绝对路径', diary.diaryRootFrom({ diary_dir: '/tmp/x/diary' }) === '/tmp/x/diary', diary.diaryRootFrom({ diary_dir: '/tmp/x/diary' }))
    t('~ 展开成家目录', diary.diaryRootFrom({ diary_dir: '~/日记' }) === path.join(process.env.HOME ?? '', '日记'), diary.diaryRootFrom({ diary_dir: '~/日记' }))
    t('不碰工作区里的任何路径', !diary.diaryRootFrom({ diary_dir: '/tmp/x/diary' }).includes('.lifecard'), '')
  }

  console.log('\n=== 3. 写下去再读回来，五个小节和四样打分都在 ===')
  {
    const data = {
      date: '2026-10-31',
      '今天最值得讲的一件事': '下午开会的时候，我把那份方案推回去了。\n说完心里有点抖。',
      '当时在想什么': '怕他们觉得我不好配合。',
      '情绪往下三层': '表面是紧张；往下是怕被当成刺头；再往下是不想再当那个什么都答应的人。',
      '我做了什么决定': '这周内把那版稿子重写一遍，只留一条主线。',
      下一步: ['周一先把主线写成一页纸', '周三拿给老周看'],
      scores: { 健康: 6, 工作: 8, 关系: 5, 玩: 2 },
    }
    const text = diary.renderDiaryMarkdown(data)
    t('文件以三条横线开头', text.startsWith('---\n'), text.slice(0, 20))
    t('frontmatter 记了文件类型', text.includes('kind: lifecard-diary'), '')
    t('frontmatter 记了日期', text.includes('date: 2026-10-31'), '')
    t('五个小节都写出来了', diary.DIARY_SECTIONS.every((s) => text.includes('## ' + s)), diary.DIARY_SECTIONS)
    t('「下一步」一行一条', text.includes('- 周一先把主线写成一页纸'), '')
    t('四样打分写成了「名字 分」', text.includes('- 健康 6') && text.includes('- 玩 2'), '')
    t('正文里的换行保留', text.includes('我把那份方案推回去了。\n说完心里有点抖。'), '')

    const back = diary.parseDiaryText(text)
    t('能读回来', back.ok === true, back)
    t('日期读对', back.data.date === '2026-10-31', back.data.date)
    t('「下一步」读成数组', Array.isArray(back.data.下一步) && back.data.下一步.length === 2, back.data.下一步)
    t('自由文字小节原样读回', back.data['我做了什么决定'].includes('只留一条主线'), back.data['我做了什么决定'])
    t('四样打分读回四个数', back.data.scores.健康 === 6 && back.data.scores.工作 === 8 && back.data.scores.关系 === 5 && back.data.scores.玩 === 2, back.data.scores)

    const notDiary = diary.parseDiaryText('---\nkind: lifecard-person-card\ndate: 2026-10-31\n---\n\n## 自述\n\n我是个木匠。\n')
    t('别的文件会说清「不是日记」', notDiary.ok === false && notDiary.error.includes('不是日记'), notDiary)
    const broken = diary.parseDiaryText('这是一段话，没有 frontmatter。')
    t('格式不对给人话', broken.ok === false && typeof broken.error === 'string' && broken.error.length > 4, broken)
  }

  console.log('\n=== 4. 一篇一篇落到磁盘上 ===')
  {
    const one = await diary.writeDiary(diaryDir, {
      date: '2026-10-30',
      '今天最值得讲的一件事': '把攒了三个月的信都拆了。',
      下一步: ['回一封'],
      scores: { 健康: 5 },
    })
    t('写成功了', one.ok === true, one)
    t('文件叫 2026-10-30.md', one.path === '2026-10-30.md', one.path)
    t('真的在磁盘上', await exists(path.join(diaryDir, '2026-10-30.md')), '')
    t('没留下临时文件', (await fs.readdir(diaryDir)).every((n) => !n.includes('.tmp-')), await fs.readdir(diaryDir))

    const got = await diary.readDiary(diaryDir, '2026-10-30')
    t('读得回来', got.ok === true && got.data !== null, got)
    t('内容对', got.data['今天最值得讲的一件事'] === '把攒了三个月的信都拆了。', got.data)

    const missing = await diary.readDiary(diaryDir, '2026-09-01')
    t('没写过的那天是「没有」不是错', missing.ok === true && missing.missing === true, missing)

    const bad = await diary.readDiary(diaryDir, '2026-13-01')
    t('坏日期读的时候也是人话', bad.ok === false && !/ENOENT|ENOTDIR/.test(bad.error), bad)

    const noDir = await diary.writeDiary('', { date: '2026-10-30' })
    t('没定文件夹时不写，说清楚原因', noDir.ok === false && noDir.error.includes('还没定'), noDir)

    const second = await diary.writeDiary(diaryDir, {
      date: '2026-10-31',
      '今天最值得讲的一件事': '今天什么都没做。',
    })
    t('第二天也能写', second.ok === true, second)

    const listed = await diary.listDiaries(diaryDir)
    t('列出来两条', listed.ok === true && listed.diaries.length === 2, listed)
    t('新的在前', listed.diaries[0].date === '2026-10-31', listed.diaries.map((d) => d.date))
    t('每条带日期和字数', listed.diaries.every((d) => d.date !== '' && typeof d.chars === 'number'), listed.diaries)

    await fs.writeFile(path.join(diaryDir, 'notes.md'), '别的笔记', 'utf8')
    await fs.writeFile(path.join(diaryDir, '2026-09-2.md'), '形状不对', 'utf8')
    await fs.writeFile(path.join(diaryDir, '2026-1-01.md'), '形状不对', 'utf8')
    const again = await diary.listDiaries(diaryDir)
    t('别的笔记与形状不对的名字都不算日记', again.diaries.length === 2, again.diaries.map((d) => d.file))

    const none = await diary.listDiaries(path.join(diaryDir, 'nope'))
    t('文件夹还没建时是「没有」不是错', none.ok === true && none.diaries.length === 0, none)
  }

  console.log('\n=== 5. 给模型的话：一次只问一件事，情绪往下三层 ===')
  {
    const sys = diary.buildDiarySystem({ cardName: '老陈', persona: '说话慢，爱用短句。' })
    t('说清自己在陪谁写', sys.includes('今天的日记'), '')
    t('带上那张卡的语气', sys.includes('说话慢，爱用短句。'), '')
    t('第一问是「哪件事最值得讲」', sys.includes('今天哪件事最值得讲'), '')
    t('明说一次只问一件事', sys.includes('一次只问一件事'), '')
    t('情绪问到第三层就停', sys.includes('第三层'), '')
    t('不写他的日记', sys.includes('不写他的日记'), '')
    t('不评价他的生活', sys.includes('不评价他的生活'), '')
    t('不提「卡上写着」', !sys.includes('卡上写着'), '')

    const plain = diary.buildDiarySystem({})
    t('没有卡也能用', plain.includes('今天的日记') && !plain.includes('你就是'), plain.slice(0, 60))

    const user = diary.buildDiaryUser({ today: '2026-10-31', recent: '【2026-10-30】\n拆了信。' })
    t('今天没写就直说', user.includes('今天还一个字没写'), user)
    t('带上前面几天', user.includes('拆了信'), '')
    t('结尾仍是「先开口问一句」', user.includes('先开口问一句'), '')

    const withDraft = diary.buildDiaryUser({ today: '2026-10-31', draft: '下午开了个会。' })
    t('写过就接着写，不从头问', withDraft.includes('今天已经写下的') && withDraft.includes('下午开了个会。'), withDraft)

    const empty = diary.recentBlock([], {})
    t('第一篇时的空块有话说', empty.includes('第一篇'), empty)
    const filled = diary.recentBlock([{ date: '2026-10-30' }], { '2026-10-30': '拆了信。' })
    t('写过就把那天的内容带出来', filled.includes('2026-10-30') && filled.includes('拆了信。'), filled)

    const digest = diary.buildDigestPrompt({ date: '2026-10-31', text: '【今天最值得讲的一件事】\n开会。' })
    t('整理提示词说不许推测', digest.system.includes('不要推'), digest.system)
    t('整理提示词要原话做依据', digest.system.includes('原话'), '')
    t('整理提示词限了条数', digest.system.includes('最多 8 条'), '')
    t('整理提示词带上日期与原文', digest.user.includes('2026-10-31') && digest.user.includes('开会。'), digest.user)

    const block = diary.diaryBlock({ '今天最值得讲的一件事': '开会。', 下一步: ['写一页纸'], scores: { 健康: 6 } })
    t('整理成模型看的块时只给有内容的小节', block.includes('【今天最值得讲的一件事】') && !block.includes('当时在想什么'), block)
    t('打分也带过去', block.includes('健康 6'), block)
    t('空日记说清是空的', diary.diaryBlock({}) === '（这一篇还是空的）', diary.diaryBlock({}))
  }

  console.log('\n=== 6. 路由：没定文件夹时先让用户挑 ===')
  {
    await store.openWorkspace(ws, { create: true })
    const table = api.buildApi(ctx, async () => ws, { workspace: ws })

    const info0 = await table['diary.info']({})
    t('还没定文件夹时 ready 是假的', info0.ok === true && info0.ready === false && info0.dir === '', info0)
    t('这时候也说清今天是哪天', /^\d{4}-\d{2}-\d{2}$/.test(String(info0.today ?? '')), info0.today)

    const badSet = await table['diary.dir.set']({ dir: '   ' })
    t('没给位置要拦', badSet.ok === false && String(badSet.error).includes('文件夹'), badSet)

    const set = await table['diary.dir.set']({ dir: diaryDir })
    t('定位置成功', set.ok === true && set.dir === diaryDir, set)
    t('位置记进了配置文件', (await store.readConfigState(ws)).config?.diary_dir === diaryDir, (await store.readConfigState(ws)).config?.diary_dir)
    t('日记没有写进档案文件夹', !(await fs.readdir(ws)).includes(diaryDir), await fs.readdir(ws))

    const info1 = await table['diary.info']({})
    t('定好之后 ready 是真的', info1.ok === true && info1.ready === true, info1)
    t('数得出写过几天', info1.count === 2, info1.count)

    const get = await table['diary.get']({ date: '2026-10-30' })
    t('读得到那一天', get.ok === true && get.data !== null && get.data['今天最值得讲的一件事'] === '把攒了三个月的信都拆了。', get)
    const none = await table['diary.get']({ date: '2026-01-01' })
    t('没写过的那天不报错', none.ok === true && none.data === null && none.missing === true, none)
    const badDate = await table['diary.get']({ date: '2026-13-40' })
    t('坏日期给人话', badDate.ok === false && String(badDate.error).includes('日期看起来不对'), badDate)

    const saved = await table['diary.save']({ date: '2026-11-01', data: { '今天最值得讲的一件事': '把碗洗了。' } })
    t('存得下去', saved.ok === true && saved.path === '2026-11-01.md', saved)
    t('磁盘上真有这一篇', await exists(path.join(diaryDir, '2026-11-01.md')), '')

    const list = await table['diary.list']({})
    t('列得出三条', list.ok === true && list.diaries.length === 3, list.diaries?.length)

    const start = await table['diary.start']({})
    t('开今天这一篇成功', start.ok === true, start)
    t('用的是日记那套预设', start.preset === 'lc-diary', start.preset)
    t('第一句是让 skill 上场', String(start.text).startsWith('/lifecard-diary'), String(start.text).split('\n')[0])
    t('第一句带上今天', String(start.text).includes(String(start.date)), start.text)
    t('带上前几天写的', String(start.text).includes('把碗洗了。') || String(start.text).includes('拆了信'), String(start.text).slice(0, 200))
  }

  console.log('\n=== 7. 日记助手的卡：挑一张就带上它的语气，不挑也能用 ===')
  {
    const table = api.buildApi(ctx, async () => ws, { workspace: ws })
    const cardPath = path.join(ws, 'people', '小满.card.md')
    await fs.mkdir(path.dirname(cardPath), { recursive: true })
    await fs.writeFile(cardPath, '---\nlifecard: "0.1"\nid: 小满\nkind: fictional\nworld: reality\nname: 小满\n---\n\n## 自述\n\n问话很轻，不催人。\n\n## 性格\n\n话少。\n', 'utf8')

    await table['card.defaults.set']({ mode: 'diary', id: '小满' })
    const picked = await table['diary.start']({})
    t('挑的卡被认出来了', picked.ok === true && picked.cardName === '小满', picked.cardName)
    t('卡里的语气也带上了', picked.personaChars > 0, picked.personaChars)

    const defaults = await table['card.defaults.get']({})
    t('四扇门都有默认卡的位置', defaults.ok === true && defaults.cards !== null && 'diary' in defaults.cards, defaults.cards)
    t('日记这一格的默认卡记住了', defaults.cards.diary === '小满', defaults.cards.diary)

    await table['card.defaults.set']({ mode: 'diary', id: '' })
    const cleared = await table['diary.start']({})
    t('不挑卡也能开始', cleared.ok === true && cleared.cardName === '', cleared.cardName)
  }

  console.log('\n=== 8. 键都齐了 ===')
  {
    const want = ['DIARY_SECTIONS', 'DIARY_LIST_SECTIONS', 'DIMENSIONS', 'dateFileName', 'diaryFileName', 'diaryRootFrom',
      'renderDiaryMarkdown', 'parseDiaryText', 'readDiary', 'writeDiary', 'listDiaries',
      'recentBlock', 'buildDiarySystem', 'buildDiaryUser', 'buildDigestPrompt', 'diaryBlock']
    t('默认导出带齐了', want.every((k) => diary.default[k] !== undefined), want.filter((k) => diary.default[k] === undefined))
    t('四个格子就是人生设计那四个', diary.DIMENSIONS.join('/') === '健康/工作/关系/玩', diary.DIMENSIONS)
    t('五个小节顺序固定', diary.DIARY_SECTIONS[0] === '今天最值得讲的一件事' && diary.DIARY_SECTIONS[4] === '下一步', diary.DIARY_SECTIONS)
  }
} finally {
  await fs.rm(ws, { recursive: true, force: true }).catch(() => {})
  await fs.rm(diaryDir, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
