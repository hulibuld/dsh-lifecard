/**
 * 人物关系网：以「我」为中心，把认识的人一圈一圈摆开。
 *
 * 这一层容易做错的地方（都是「界面上看不出问题、真用起来才发现」那种）：
 *   1. 「我」那张卡有两种写法——新档案是 kind self，老档案是 kind real +
 *      relation 写「我」。只认一种，老用户进来就是一片空白；
 *   2. 卡片上写着关系、但彼此之间没连成边，也得进圈（否则只有一条边的网）；
 *   3. 两个都没有的人不能凭空消失——他们只是还没写关系，卡片还在；
 *   4. 圈里越亲的越靠前，不能按文件名排；
 *   5. 空库不是错，是「还没开始」。
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as api from '../lib/index.js'
import * as store from '../lib/store.js'

let pass = 0, fail = 0
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400)) }
}

const ws = await fs.mkdtemp(path.join(tmpdir(), 'lc-net-'))
await store.openWorkspace(ws, { create: true })

const ctx = {
  webServer: { register: () => () => {} },
  reflect: { get: () => undefined },
  effect: (fn) => { fn(); return () => {} },
  logger: { warn: () => {} },
  get: () => undefined,
}
const table = api.buildApi(ctx, async () => ws, { workspace: ws })
const callNet = async () => table['relations.net']({})

const put = (rel, data, sections = []) => store.writeCard(
  ws, rel,
  { lifecard: '0.1', world: 'reality', ...data },
  sections,
  { force: true },
)

try {
  console.log('\n=== 1. 空库：不是错，是「还没开始」 ===')
  {
    const r = await callNet()
    t('空库也回 ok', r.ok === true, r.error)
    t('没有中心', r.self === null, r.self)
    t('三圈都是空数组（不是 undefined）',
      Array.isArray(r.rings.self) && Array.isArray(r.rings.inner) && Array.isArray(r.rings.outer),
      r.rings)
    t('计数是 0', r.counts.inner === 0 && r.counts.outer === 0 && r.counts.outside === 0, r.counts)
    t('没有人落在网外', r.outside.length === 0, r.outside)
  }

  console.log('\n=== 2. 「我」的两种写法都认 ===')
  {
    // 老档案的写法：kind real + relation 我
    await put('people/wo-old.card.md', { id: 'wo-old', kind: 'real', name: '老档案里的我', relation: '我' })
    const old = await callNet()
    t('老档案（real + relation 我）被认成中心', old.self?.id === 'wo-old', old.self)

    // 新档案的写法：kind self
    await put('people/wo.card.md', { id: 'wo', kind: 'self', name: '钱禹舟', relation: '我' })
    const fresh = await callNet()
    t('kind self 优先当中心', fresh.self?.id === 'wo', fresh.self)
    t('中心落在第 0 圈', fresh.rings.self.length === 1 && fresh.rings.self[0].id === 'wo', fresh.rings.self)
    t('中心不重复出现在别的圈里',
      !fresh.rings.inner.some((n) => n.id === 'wo') && !fresh.rings.outer.some((n) => n.id === 'wo'),
      fresh.rings)
  }

  console.log('\n=== 3. 卡上写着关系的人进第 1 圈 ===')
  {
    // 父亲的卡写得多（自述 + 性格 + 关系史 + 能力），亲戚那张只有自述。
    // 覆盖度就是靠这些撑起来的：写得多的排在前面。
    await put('people/dad.card.md', {
      id: 'dad', kind: 'real', name: '钱俊锋', relation: 'father',
      competency: '修机器', knowledge: '厂里的事', address: '爸',
    }, [
      { title: '自述', body: '在厂里做了三十年钳工。' },
      { title: '性格', body: '话少，动手快。' },
      { title: '关系史', body: '小时候他骑自行车带我去看病。' },
    ])
    await put('people/li.card.md', { id: 'li', kind: 'real', name: '李雷', relation: 'friend', relation_extra: ['也是同事'] })
    await put('people/chen.card.md', { id: 'chen', kind: 'real', name: '陈默' }) // 没写关系
    const r = await callNet()
    const inner = r.rings.inner.map((n) => n.id)
    t('父亲进第 1 圈', inner.includes('dad'), inner)
    t('朋友进第 1 圈', inner.includes('li'), inner)
    t('关系词被翻成人话', r.rings.inner.find((n) => n.id === 'dad')?.relationLabel === '父亲', r.rings.inner)
    t('补充关系也带出来',
      (r.rings.inner.find((n) => n.id === 'li')?.extras ?? []).includes('也是同事'),
      r.rings.inner.find((n) => n.id === 'li'))
    t('没写关系的人不进网', !inner.includes('chen'), inner)
    t('但他没消失，落在网外', r.outside.some((n) => n.id === 'chen'), r.outside)
    t('网外的人也数得清', r.counts.outside === 1, r.counts)
    // 世界书、设定这几种根本不是人，不能混进「还没写关系的人」那一行。
    await put('worlds/demo/card.card.md', { id: 'demo-world', kind: 'world', name: '一个世界' })
    const withWorld = await callNet()
    t('世界里那几张不算人', !withWorld.outside.some((n) => n.id === 'demo-world'), withWorld.outside)
  }

  console.log('\n=== 4. 越亲的越靠前 ===')
  {
    // 覆盖度 55 的父亲该排在覆盖度 20 的亲戚前面——按文件名排就反过来。
    await put('people/yi.card.md', { id: 'yi', kind: 'real', name: '我姨', relation: 'relative' }, [
      { title: '自述', body: '在老家。' },
    ])
    await put('people/dad2.card.md', { id: 'dad2', kind: 'real', name: '钱俊锋二号', relation: 'father' })
    const r = await callNet()
    const inner = r.rings.inner
    const rank = (id) => inner.findIndex((n) => n.id === id)
    // 写了两张「父亲」，字多的那张覆盖度高。名字排序 + 覆盖度倒序，规则是
    // 「先看覆盖度，一样再看名字」，所以覆盖度高的必须在前。
    t('覆盖度高的排在前面',
      rank('dad') < rank('yi'),
      inner.map((n) => [n.id, n.coverage]))
    t('每个人都在结果里带着自己那张卡的路径',
      inner.every((n) => typeof n.path === 'string' && n.path !== ''),
      inner.map((n) => n.path))
  }

  console.log('\n=== 5. 关系边：只和某个一圈的人有关系的人进第 2 圈 ===')
  {
    // 一张没写主关系、但和父亲之间有边的卡：只能通过父亲认识。
    await put('people/niece.card.md', { id: 'niece', kind: 'real', name: '小满' })
    await store.writeCard(ws, 'relations/dad--niece.relation.md', {
      lifecard: '0.1', kind: 'relation', id: 'dad--niece', from: 'dad', to: 'niece',
      structure: { type: '亲戚' },
    }, [], { force: true })
    const r = await callNet()
    t('通过父亲认识的人进第 2 圈', r.rings.outer.some((n) => n.id === 'niece'), r.rings.outer.map((n) => n.id))
    t('他不被算成直接认识', !r.rings.inner.some((n) => n.id === 'niece'), r.rings.inner.map((n) => n.id))
    t('边也一并回给界面', r.edges.some((e) => e.from === 'dad' && e.to === 'niece'), r.edges)
    t('第 2 圈的人数对得上', r.counts.outer === 1, r.counts)
  }

  console.log('\n=== 6. 网外的人：卡在，只是还没写关系 ===')
  {
    const r = await callNet()
    const outside = r.outside.map((n) => n.id)
    t('没写关系的人都在网外', outside.includes('chen'), outside)
    t('网外的人带着名字和路径，点得开',
      r.outside.every((n) => typeof n.name === 'string' && typeof n.path === 'string'),
      r.outside)
    t('网外的人不会被算成中心', r.self?.id === 'wo', r.self)
  }

  console.log('\n=== 7. 坏文件不崩整张网 ===')
  {
    // 一张 frontmatter 残缺的卡：列表那边会把它放进 errors，这里不能跟着倒。
    await fs.writeFile(path.join(ws, 'people', 'broken.card.md'), '这不是一张卡\n', 'utf8')
    const r = await callNet()
    t('有坏文件时整张网还出得来', r.ok === true, r.error)
    t('中心还在', r.self?.id === 'wo', r.self)
    t('好卡没被坏卡带倒', r.rings.inner.length >= 3, r.rings.inner.map((n) => n.id))
  }

  console.log('\n=== 8. 名字空了也不能在图上留一个空白 ===')
  {
    await put('people/nameless.card.md', { id: 'nameless', kind: 'real', name: '', relation: 'friend' })
    const r = await callNet()
    const hit = r.rings.inner.find((n) => n.id === 'nameless')
    t('没名字的人在网里还是有个说法', hit?.name === '（还没起名字）', hit)
  }
  console.log('\n=== 9. 连两个人：这一屏以前只能看图不能改 ===')
  {
    const save = async (body) => table['relations.save'](body)
    // 陈默在这份档案里没写「和我什么关系」，一直在网外。
    const before = await callNet()
    t('还没连的时候他在网外', before.outside.some((n) => n.id === 'chen'), before.outside.map((n) => n.id))

    const r = await save({ from: 'dad', to: 'chen', type: 'friend', note: '厂里一起干了二十年' })
    t('连上了', r.ok === true, r.error)
    t('第一次连是新建', r.created === true, r.created)
    t('回话里说了这两个人', String(r.note ?? '').includes('陈默'), r.note)

    const after = await callNet()
    t('连完他从网外进来了', !after.outside.some((n) => n.id === 'chen'), after.outside.map((n) => n.id))
    t('落在第二圈（只和一圈里的人有关系）', after.rings.outer.some((n) => n.id === 'chen'), after.rings.outer.map((n) => n.id))
    const edge = after.edges.find((e) => e.from === 'dad' && e.to === 'chen')
    t('边也回给界面了', edge !== undefined, after.edges)
    t('边上带着路径（断开要它）', typeof edge?.path === 'string' && edge.path.endsWith('.relation.md'), edge)
    t('边上带着那句原话', edge?.note === '厂里一起干了二十年', edge)

    // 再连一次，只改那句原话：类型不能丢（丢了这条线就变成「不知道是什么关系」）
    const again = await save({ from: 'dad', to: 'chen', note: '后来他调走了' })
    t('再连一次是改，不是新建', again.created === false, again.created)
    const after2 = await callNet()
    const edge2 = after2.edges.find((e) => e.from === 'dad' && e.to === 'chen')
    t('类型没被冲掉', edge2?.type === 'friend', edge2)
    t('原话换成新的', edge2?.note === '后来他调走了', edge2)

    // 自己连自己 / 找不到人
    const self1 = await save({ from: 'dad', to: 'dad', type: 'friend' })
    t('自己连自己被拦下', self1.ok === false, self1)
    t('并且说清为什么', String(self1.error ?? '').includes('同一张卡'), self1.error)
    const ghost = await save({ from: 'dad', to: '查无此人', type: 'friend' })
    t('找不到的人连不上', ghost.ok === false, ghost)
    t('并且说清是哪一步', String(ghost.error ?? '').includes('查无此人'), ghost.error)

    // 名字也能当键（界面上拿到的常常是名字）
    const byName = await save({ from: '钱俊锋', to: '陈默', note: '用名字连' })
    t('用名字也能连', byName.ok === true, byName.error)

    // 断开
    const cut = await table['relations.delete']({ path: edge.path })
    t('断开了', cut.ok === true, cut.error)
    t('断开后说明原份还在', String(cut.note ?? '').includes('回收'), cut.note)
    const after3 = await callNet()
    t('断开的那条不在列表里了', !after3.edges.some((e) => e.from === 'dad' && e.to === 'chen'), after3.edges)
    const gone = await table['relations.delete']({ path: edge.path })
    t('再断一次不炸', gone.ok === false, gone)
  }

  console.log('\n=== 10. 写关系用的是和写卡同一套保护 ===')
  {
    // 手改过的边再存一次：得留个底，不能悄悄盖掉。
    await put('relations/dad--chen.relation.md', {
      id: 'dad--chen', kind: 'relation', from: 'dad', to: 'chen',
      structure: { type: 'friend' }, affect: [{ at: '2026-10-01', affinity: -2 }],
    })
    const r = await table['relations.save']({ from: 'dad', to: 'chen', affinity: 1 })
    t('改一条已有的边也存得下', r.ok === true, r.error)
    const text = await fs.readFile(path.join(ws, 'relations', 'dad--chen.relation.md'), 'utf8')
    t('旧的 affect 那一条还在（是按时间追加，不是覆盖）',
      text.includes('2026-10-01') && text.includes('-2'), text.slice(0, 500))
    const snaps = await fs.readdir(path.join(ws, '.lifecard', 'snapshots', 'relations__dad--chen.relation.md')).catch(() => [])
    t('改之前留了一份底', snaps.length >= 1, snaps)
  }
} finally {
  await fs.rm(ws, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
