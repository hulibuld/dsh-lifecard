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
} finally {
  await fs.rm(ws, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
