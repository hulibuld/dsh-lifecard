import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as store from '../lib/store.js'
import * as core from '../lib/core.js'

let pass = 0, fail = 0
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400)) }
}

const root = path.join(tmpdir(), 'lifecard-test-' + Date.now())

console.log('=== 1. 建工作区 ===')
{
  const r = await store.openWorkspace(root, { create: true })
  t('创建成功', r.ok, r)
  for (const dir of ['people', 'materials', 'interviews', 'proposals', 'relations', 'worlds/reality', '.lifecard/raw']) {
    const ok = await fs.stat(path.join(root, dir)).then((s) => s.isDirectory()).catch(() => false)
    t('目录 ' + dir, ok)
  }
  const cfg = await store.readConfig(root)
  t('配置已写', cfg.lifecard === '0.1', cfg)
}

console.log('=== 2. 写卡 / 读卡 / 快照 ===')
{
  const data = { lifecard: '0.1', id: 'mama', kind: 'real', world: 'reality', name: '妈妈', relation: '母亲', tags: ['家人'] }
  const sections = [{ title: '自述', body: '1958 年生，c 市人。' }, { title: '关系史', body: '2026-09 我到外地（她想让我读本地学校）' }]
  const w = await store.writeCard(root, 'people/mama.card.md', data, sections, { force: true })
  t('写入成功', w.ok, w)
  const r = await store.readCard(root, 'people/mama.card.md')
  t('读回一致', JSON.stringify(r.data) === JSON.stringify(data))
  t('正文小节一致', JSON.stringify(r.sections) === JSON.stringify(sections))
  // 再写一次 → 应产生快照
  await store.writeCard(root, 'people/mama.card.md', { ...data, relation: '母亲（改）' }, sections)
  const snaps = await fs.readdir(path.join(root, '.lifecard/snapshots')).catch(() => [])
  t('产生了快照目录', snaps.length > 0, snaps)
}

console.log('=== 3. 墓碑：删掉就读不到 ===')
{
  const r = await store.readCard(root, 'people/mama.card.md')
  await store.appendRedaction(root, { path: 'people/mama.card.md', sha256: store.sha256(r.text), reason: '她要求删除' })
  const after = await store.readCard(root, 'people/mama.card.md')
  t('读不到了', after.ok === false, after)
  t('错误里说明是被撤回', String(after.error).includes('撤回'), after.error)
  const list = await store.listAll(root)
  t('列表里也没有了', list.cards.filter((c) => c.id === 'mama').length === 0, list.cards.map((c) => c.id))
  const red = await store.readRedactions(root)
  t('墓碑可读', red.length === 1 && red[0].reason === '她要求删除', red)
  // 文件本身还在（可审计）
  const raw = await fs.readFile(path.join(root, 'people/mama.card.md'), 'utf8')
  t('磁盘原文仍在（可审计）', raw.includes('妈妈'))
}

console.log('=== 4. 材料只追加 ===')
{
  await store.appendMaterial(root, '爷爷访谈', '爷爷说：十六岁进作坊，干了三十七年。')
  await store.appendMaterial(root, '爷爷访谈', '他还说：最得意的是 1985 年那间铺子。')
  const mats = await store.readMaterials(root)
  const names = Object.keys(mats)
  t('只有一份文件', names.length === 1, names)
  const body = mats[names[0]]
  t('两次追加都在', body.includes('十六岁进作坊') && body.includes('1985 年那间铺子'))

  // 回归：listAll 的 materials 曾经因为「relDir 就是 'materials'，末尾没斜杠」
  // 而一直返回空数组。readMaterials 是对的，所以只测它发现不了。
  const all = await store.listAll(root)
  t('listAll 列出材料', all.materials.length === 1, all.materials)
  t('材料路径正确', String(all.materials[0]?.path).startsWith('materials/'), all.materials[0]?.path)
  t('材料大小非零', (all.materials[0]?.size ?? 0) > 0, all.materials[0]?.size)
}

console.log('=== 5. 提案：引文门 ===')
{
  const materials = await store.readMaterials(root)
  const proposal = {
    about: { id: 'yeye', name: '爷爷' },
    items: [
      { field: 'competency', value: { key: 'woodwork', label: '手艺', level: '熟手' }, source_level: '自述', evidence: { material: Object.keys(materials)[0], quote: '十六岁进作坊，干了三十七年' } },
      { field: 'birth_year', value: 1958, source_level: '推测', evidence: { material: Object.keys(materials)[0], quote: '他生于一九五八年' } },
      { field: '自述', value: '会做一门手艺', source_level: '自述', evidence: { material: Object.keys(materials)[0], quote: '最得意的是 1985 年那间铺子' } },
    ],
    gaps: [{ field: 'birth_year', why: '材料没说出出生年' }],
  }
  const saved = await store.saveProposal(root, 'yeye', proposal, materials)
  t('提案保存', saved.ok, saved)
  t('2 条通过', saved.accepted === 2, saved.accepted)
  t('1 条被丢弃（编造的引文）', saved.rejected === 1, saved.rejected)
  const md = await fs.readFile(path.join(root, saved.md), 'utf8')
  t('默认全不勾', md.includes('- [ ] `woodwork` 手艺 / 熟手') || md.includes('- [ ] 手艺 / 熟手'), md.split('\n').slice(0, 20).join('|'))
  t('列出了丢弃原因', md.includes('已丢弃') && md.includes('找不到'), md.slice(-600))
}

console.log('=== 6. 采纳：只写勾选的 ===')
{
  // 建目标卡
  await store.writeCard(root, 'people/yeye.card.md', { lifecard: '0.1', id: 'yeye', kind: 'real', world: 'reality', name: '爷爷' }, [{ title: '自述', body: '' }], { force: true })
  const props = await store.listProposals(root)
  t('提案可列出', props.length === 1, props)
  const jsonRel = props[0].json
  const mdRel = jsonRel.replace(/\.json$/, '.md')
  let md = await fs.readFile(path.join(root, mdRel), 'utf8')
  // 只勾第一条
  md = md.replace('- [ ] ', '- [x] ')
  await fs.writeFile(path.join(root, mdRel), md, 'utf8')
  const read = await store.readProposal(root, jsonRel)
  t('读到 1 条勾选', read.checkedCount === 1, { checked: read.checkedCount, items: read.items.map((i) => i.checked) })
  const applied = await store.applyProposal(root, jsonRel)
  t('采纳成功', applied.ok === true, applied)
  t('只写 1 条', applied.applied === 1, applied)
  const card = await store.readCard(root, 'people/yeye.card.md')
  t('competency 写进去了', Array.isArray(card.data.competency) && card.data.competency.length === 1, card.data.competency)
  t('没勾的 birth_year 没写', card.data.birth_year === undefined, card.data.birth_year)
}

console.log('=== 7. doctor ===')
{
  const report = await store.doctor(root)
  t('能跑', report.ok === true || report.ok === false, report.ok)
  t('统计正确', report.counts.cards >= 1, report.counts)
  t('宿主段如实标注未运行', report.host.ran === false, report.host)
}

console.log('=== 8. 世界书条目导入 ===')
{
  const rel = 'worlds/eldoria/world.md'
  await store.writeCard(root, rel, { lifecard: '0.1', id: 'eldoria', kind: 'world', name: '艾尔多利亚', genre: 'high-fantasy' }, [{ title: '世界书条目', body: '- keys: ["王城"]\n  content: "阿斯特兰位于河谷北岸"' }], { force: true })
  const list = await store.listAll(root)
  t('世界被列出', list.worlds.some((w) => w.id === 'eldoria'), list.worlds)
}

console.log('=== 9. 界面勾选：只存在界面里也必须能采纳（回归） ===')
{
  // 真实崩溃现场：用户在侧栏里勾了条目、点「就用这 N 条」，
  // 勾选只活在 React state，读回 Markdown 发现一条都没勾 -> 「提案里没有勾选任何条目」。
  const matText = '丙说他二十三岁那年在码头扛过包。他最舍不得的是一辆二八自行车。'
  const added = await store.appendMaterial(root, '丙', matText)
  await store.writeCard(root, 'people/bing.card.md', { lifecard: '0.1', id: 'bing', kind: 'real', world: 'reality', name: '丙' }, [], { force: true })
  const prop = {
    spec: 'lifecard_proposal_v1',
    about: { id: 'bing', name: '丙' },
    items: [
      { field: 'life', value: '二十三岁在码头扛包', source_level: '自述', evidence: { material: added.path, quote: '二十三岁那年在码头扛过包' } },
      { field: 'tags', value: '二八自行车', source_level: '自述', evidence: { material: added.path, quote: '一辆二八自行车' } },
    ],
  }
  const saved = await store.saveProposal(root, 'bing', prop, { [added.path]: matText })
  t('提案 2 条通过', saved.accepted === 2, saved)

  const before = await store.readProposal(root, saved.json)
  t('没勾过时是 0 条勾选', before.checkedCount === 0, before.checkedCount)
  t('每条都带下标（界面靠下标回写）', before.items.every((i, n) => i.index === n), before.items.map((i) => i.index))

  // 模拟界面点第一下：立刻落盘
  await store.writeCheckedFile(root, saved.json, [0])
  const afterOne = await store.readProposal(root, saved.json)
  t('界面勾 1 条后回读也是 1 条', afterOne.checkedCount === 1, afterOne.checkedCount)
  t('勾的是第一条', afterOne.items[0].checked === true && afterOne.items[1].checked === false, afterOne.items.map((i) => i.checked))

  // 采纳时直接带下标，不依赖任何事先落盘
  const applied = await store.applyProposal(root, saved.json, { checked: [1] })
  t('直接传勾选也能采纳', applied.ok === true, applied)
  t('采纳的是传进去的那条', applied.applied === 1 && applied.appliedLabels[0] === '二八自行车', applied)
  const card = await store.readCard(root, 'people/bing.card.md')
  t('life 没被写（没勾）', card.data.life === undefined, card.data.life)
  t('tags 写进去了', Array.isArray(card.data.tags) && card.data.tags.includes('二八自行车'), card.data.tags)

  // 全不勾时给人话错误，不是内部文案
  const none = await store.applyProposal(root, saved.json, { checked: [] })
  t('全不勾时拒绝', none.ok === false, none)
  t('拒绝的话是人话', typeof none.error === 'string' && !/提案里没有/.test(none.error), none.error)
}

await fs.rm(root, { recursive: true, force: true })
console.log('=== 版本历史（快照列表 / 读回 / 恢复）===')
{
  const ws = path.join(root, 'history')
  await fs.mkdir(ws, { recursive: true })
  const rel = 'people/ver.card.md'

  // 还没有历史时不该报错，要返回空
  const none = await store.listSnapshots(ws, rel)
  t('没存过时返回空数组', none.ok === true && Array.isArray(none.versions) && none.versions.length === 0, none)

  // 第一版
  await store.writeCard(ws, rel, { lifecard: '0.1', id: 'ver', kind: 'real', world: 'reality', name: '甲' }, [{ title: '自述', body: '第一版。' }])
  // 第二版（写之前会自动给第一版留快照）
  await store.writeCard(ws, rel, { lifecard: '0.1', id: 'ver', kind: 'real', world: 'reality', name: '甲' }, [{ title: '自述', body: '第二版。' }])
  // 第三版
  await store.writeCard(ws, rel, { lifecard: '0.1', id: 'ver', kind: 'real', world: 'reality', name: '甲' }, [{ title: '自述', body: '第三版。' }])

  const list = await store.listSnapshots(ws, rel)
  t('存了三次之后有两份历史', list.versions.length === 2, list.versions.map((v) => v.stamp))
  t('历史带时间', list.versions.every((v) => typeof v.when === 'string' && !Number.isNaN(new Date(v.when).getTime())), list.versions)
  t('历史带大小', list.versions.every((v) => v.bytes > 0), list.versions)
  t('新的排在前面', list.versions[0].stamp > list.versions[1].stamp, list.versions.map((v) => v.stamp))

  // 最新那份历史应该是「第二版」的内容（快照存的是写之前的样子）
  const newest = await store.readSnapshot(ws, rel, list.versions[0].stamp)
  t('读得回历史原文', newest.ok === true, newest)
  t('最新历史是上一版内容', (newest.sections[0]?.body ?? '').includes('第二版'), newest.sections)
  t('历史能解析成结构化数据', newest.data?.name === '甲', newest.data)

  // 恢复
  const back = await store.restoreSnapshot(ws, rel, list.versions[0].stamp)
  t('能退回某一版', back.ok === true, back)
  const now = await store.readCard(ws, rel)
  t('退回后当前内容变了', (now.sections[0]?.body ?? '').includes('第二版'), now.sections)

  // 恢复本身也要留下痕迹（否则「退回」这一步不可撤销）
  const after = await store.listSnapshots(ws, rel)
  t('恢复也留了快照', after.versions.length === 3, after.versions.length)

  // 非法版本号 / 不存在
  const badStamp = await store.readSnapshot(ws, rel, '../../etc/passwd')
  t('版本号做了消毒（不会越权读文件）', badStamp.ok === false, badStamp)
  const missing = await store.readSnapshot(ws, rel, 'not-exist')
  t('不存在的版本给清楚的错', missing.ok === false && missing.error !== '', missing)
  const noHist = await store.listSnapshots(ws, 'people/never.card.md')
  t('没历史过的卡也返回空而不是报错', noHist.ok === true && noHist.versions.length === 0, noHist)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
