/**
 * 客户端会调的那些接口，宿主这边真的都在。
 *
 * 为什么要单独测这一条：界面和宿主是两份代码，靠一个字符串名字对上。
 * 名字写错、路由改名、忘了往外暴露，测试和界面会一起「看起来正常」——
 * 但用户点下去就是 404。之前 `proposal.check` 就是这样漏过一次。
 *
 * 做法：从 client.js 里把所有 `call('xxx'` 抠出来，然后拿 buildApi()
 * 逐个确认真的有这个函数。不需要起服务器。
 */
import { readFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as api from '../lib/index.js'

let pass = 0, fail = 0
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : String(extra).slice(0, 400)) }
}

const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const called = [...new Set([...clientSource.matchAll(/\bcall\(\s*'([a-z][a-zA-Z.]*)'/g)].map((m) => m[1]))].sort()

const ctx = {
  webServer: { register: () => () => {} },
  reflect: { get: () => undefined },
  effect: (fn) => { fn(); return () => {} },
  logger: { warn: () => {} },
  get: () => undefined,
  llm: undefined,
}
const ws = path.join(tmpdir(), 'lifecard-routes-' + Date.now())
await fs.mkdir(ws, { recursive: true })
const table = api.buildApi(ctx, async () => ws, { workspace: ws })

console.log('=== 1. 界面上每一个 call 都能对上宿主的接口 ===')
t('从界面里抠出了若干接口调用', called.length > 8, called.length)
for (const name of called) {
  t(`界面要的 ${name} 宿主有`, typeof table[name] === 'function', Object.keys(table).filter((k) => k.includes(name.slice(0, 4))))
}

console.log('\n=== 2. 头像三件事都能用 ===')
{
  const png1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const rel = 'people/tu.card.md'
  await table['card.save']({ workspace: ws, path: rel, data: { lifecard: '0.1', id: 'tu', kind: 'real', name: '老图', world: 'reality' }, sections: [{ title: '自述', body: '〔自述〕他爱钓鱼。' }] })

  const set = await table['avatar.set']({ workspace: ws, path: rel, base64: png1 })
  t('设头像成功', set.ok === true, set)
  t('返回了落点', typeof set.avatar === 'string' && set.avatar.startsWith('assets/'), set.avatar)

  const got = await table['card.get']({ workspace: ws, path: rel })
  t('读卡时带回头像', got.avatar === png1, String(got.avatar).slice(0, 20))

  const list = await table['avatar.list']({ workspace: ws })
  t('列表页能一次拿到头像', list.ok === true && list.avatars?.tu === png1, list.avatars ? Object.keys(list.avatars) : list)

  const bad = await table['avatar.set']({ workspace: ws, path: rel, base64: 'bm90IGEgcG5n' })
  t('非 PNG 被拒绝', bad.ok === false, bad)

  const gone = await table['avatar.remove']({ workspace: ws, path: rel })
  t('去头像成功', gone.ok === true, gone)
  const after = await table['card.get']({ workspace: ws, path: rel })
  t('去掉后读不到', after.avatar === null, after.avatar)
}

console.log('\n=== 3. 宿主暴露的接口一个都不重名 ===')
{
  const names = Object.keys(table)
  t('接口数量合理', names.length >= 25, names.length)
  t('没有重复', new Set(names).size === names.length)
  t('全是小写点号命名', names.every((n) => /^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)+$/.test(n)), names.filter((n) => !/^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)+$/.test(n)))
}

console.log('\n=== 4. 导入世界书：条目一个不丢，字段不写错 ===')
{
  // 一份照着 ST 真实导出结构做的世界书。字段故意给满，因为这里要验的
  // 就是「不理解的字段也不能丢」——丢了用户不会收到任何报错。
  const book = {
    name: '北洋往事',
    description: '民国背景的世界设定集',
    entries: {
      3: {
        uid: 3,
        key: ['天津', '租界'],
        keysecondary: ['一九二八'],
        comment: '天津卫',
        content: '天津九国租界，洋楼与贫民窟并排。',
        order: 42,
        disable: false,
        probability: 100,
        depth: 4,
        selectiveLogic: 0,
        extensions: { position: 4, exclude_recursion: false },
      },
      4: {
        uid: 4,
        key: ['码头'],
        comment: '码头',
        content: '码头上扛包的苦力按件计钱。',
        order: 7,
        disable: true,
      },
    },
  }
  const base64 = Buffer.from(JSON.stringify(book), 'utf8').toString('base64')
  const imported = await table['import.cards']({ workspace: ws, files: [{ name: 'beiyang.json', base64 }] })
  t('世界书导入成功', imported.ok === true && imported.imported === 1, JSON.stringify(imported).slice(0, 200))
  const rec = imported.results?.[0] ?? {}
  t('认出这是世界书而不是角色卡', rec.kind === 'worldinfo', rec.kind)
  t('两条条目都在', rec.entries === 2, rec.entries)

  const rel = rec.path
  const card = await table['card.get']({ workspace: ws, path: rel })
  t('世界书落成了 world.md', card.ok === true, card.ok)
  const body = (card.sections ?? []).map((s) => s.body).join('\n')

  // 两个以前写错的字段
  t('顺序用了原来的 order，不是默认 100', body.includes('insertion_order: 42'), body.slice(0, 300))
  t('第二条的顺序也对', body.includes('insertion_order: 7'))
  t('启用的条目没被写成停用', /uid: 3[\s\S]*?enabled: true/.test(body), body.slice(0, 300))
  t('停用的条目没被写成启用', /uid: 4[\s\S]*?enabled: false/.test(body))

  // 原来完全丢掉的字段
  t('uid 留下来了', body.includes('uid: 3') && body.includes('uid: 4'), body.slice(0, 200))
  t('不理解的字段没丢（写进 rest）', body.includes('keysecondary') && body.includes('probability') && body.includes('depth'), body.slice(0, 400))

  // 保真底线：原件要留一份
  t('原件存进了 .lifecard/raw/', typeof rec.raw === 'string' && rec.raw.startsWith('.lifecard/raw/'), rec.raw)
  const rawText = await fs.readFile(path.join(ws, rec.raw), 'utf8').catch(() => null)
  t('原件内容能读回来', rawText !== null && rawText.includes('keysecondary'), rawText === null ? '读不到' : 'ok')
  const rawJson = rawText === null ? null : JSON.parse(rawText)
  t('原件是原样，不是加工过的', rawJson?.entries?.['3']?.keysecondary?.[0] === '一九二八', rawJson?.entries?.['3'])

  // 工作区里要能被认出来
  const doctor = await table['doctor.run']({ workspace: ws })
  t('体检认得这本世界书', (doctor.counts?.worlds ?? 0) >= 1, doctor.counts)

  // ── 导进来之后，界面上读得到吗 ──
  // 这一段防的是「导入成功但用户在界面上什么都看不到」：数据落盘了，
  // 列表里没有、点不进去，对用户来说就是导入失败了。
  console.log('\n=== 5. 导进来的世界书，界面上读得到 ===')
  const listing = await table['workspace.list']({ workspace: ws })
  const listed = (listing.worlds ?? []).find((w) => w.id === '北洋往事') ?? (listing.worlds ?? [])[0] ?? {}
  t('列表里有这本世界书', (listing.worlds ?? []).length >= 1, JSON.stringify(listing.worlds))
  t('列表带上了条目数', listed.entry_count === 2, listed.entry_count)

  // 用 typeof 兜一层：接口整个不存在时，后面每一条都该报 FAIL，
  // 而不是这么早就 TypeError 崩掉、把剩下的断言全跳过。
  const getWorld = typeof table['world.get'] === 'function' ? table['world.get'] : async () => ({ ok: false, error: '没有 world.get 这个接口' })
  const detail = await getWorld({ workspace: ws, path: listed.path })
  t('点得进去', detail.ok === true, JSON.stringify(detail).slice(0, 200))
  t('条目解出来了', Array.isArray(detail.entries) && detail.entries.length === 2, detail.entries)
  t('条目内容对得上', detail.entries?.[0]?.content === '天津九国租界，洋楼与贫民窟并排。', detail.entries?.[0])
  t('触发词解出来了', JSON.stringify(detail.entries?.[0]?.keys) === JSON.stringify(['天津', '租界']), detail.entries?.[0]?.keys)
  t('开关状态解出来了', detail.entries?.[0]?.enabled === true && detail.entries?.[1]?.enabled === false,
    [detail.entries?.[0]?.enabled, detail.entries?.[1]?.enabled])
  t('关着的那条内容也在', String(detail.entries?.[1]?.content ?? '').includes('扛包'), detail.entries?.[1])

  const byId = await getWorld({ workspace: ws, id: '北洋往事' })
  t('按 id 也点得进去', byId.ok === true && Array.isArray(byId.entries) && byId.entries.length === 2, byId.error)

  const outside = await getWorld({ workspace: ws, path: '../../../etc/hosts' })
  t('不许越界读文件', outside.ok === false, outside)

  const notBook = await getWorld({ workspace: ws })
  t('没说是哪一本就说清楚', notBook.ok === false && String(notBook.error ?? '').includes('哪一本'), notBook)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
