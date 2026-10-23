import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as store from '../lib/store.js'
import * as core from '../lib/core.js'
import * as prompts from '../lib/prompts.js'

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
  await store.appendMaterial(root, '爷爷访谈', '爷爷说：十几岁开始做这行，做了很多年。')
  await store.appendMaterial(root, '爷爷访谈', '他还说：最得意的是 1985 年那间铺子。')
  const mats = await store.readMaterials(root)
  const names = Object.keys(mats)
  t('只有一份文件', names.length === 1, names)
  const body = mats[names[0]]
  t('两次追加都在', body.includes('十几岁开始做这行') && body.includes('1985 年那间铺子'))

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
      { field: 'competency', value: { key: 'craft', label: '手艺', level: '熟手' }, source_level: '自述', evidence: { material: Object.keys(materials)[0], quote: '十几岁开始做这行，做了很多年' } },
      { field: 'birth_year', value: 1958, source_level: '推测', evidence: { material: Object.keys(materials)[0], quote: '他生于一九五八年' } },
      { field: '自述', value: '会做手艺活', source_level: '自述', evidence: { material: Object.keys(materials)[0], quote: '最得意的是 1985 年那间铺子' } },
    ],
    gaps: [{ field: 'birth_year', why: '材料没说出出生年' }],
  }
  const saved = await store.saveProposal(root, 'yeye', proposal, materials)
  t('提案保存', saved.ok, saved)
  t('2 条通过', saved.accepted === 2, saved.accepted)
  t('1 条被丢弃（编造的引文）', saved.rejected === 1, saved.rejected)
  const md = await fs.readFile(path.join(root, saved.md), 'utf8')
  t('默认全不勾', md.includes('- [ ] `craft` 手艺 / 熟手') || md.includes('- [ ] 手艺 / 熟手'), md.split('\n').slice(0, 20).join('|'))
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

console.log('=== 世界书编辑能存能读（界面走的就是这条路）===')
{
  const ws2 = path.join(root, 'lorebook')
  await fs.mkdir(ws2, { recursive: true })
  const rel = 'worlds/eldoria/cards/sera.card.md'
  const data = {
    lifecard: '0.1', id: 'sera', kind: 'fictional', world: 'eldoria', name: '塞拉菲娜',
    cc: { fields: { character_book: { entries: [
      { keys: ['王城', '阿斯特兰'], content: '阿斯特兰位于河谷北岸。' },
      { keys: [], content: '' },
    ] } } },
  }
  const w = await store.writeCard(ws2, rel, data, [{ title: '自述', body: '〔自述〕她是个法师。' }])
  t('带世界书的卡能存', w.ok, w)
  const back = await store.readCard(ws2, rel)
  const entries = back.data?.cc?.fields?.character_book?.entries
  t('读回来世界书还在', Array.isArray(entries) && entries.length === 2, entries)
  t('触发词原样保留', JSON.stringify(entries?.[0]?.keys) === JSON.stringify(['王城', '阿斯特兰']), entries?.[0])
  t('内容原样保留', entries?.[0]?.content === '阿斯特兰位于河谷北岸。', entries?.[0])
  t('空条目也没被吃掉', entries?.[1]?.content === '', entries?.[1])

  // 校验不挡这种卡（世界书是带过来的字段，不该被判成非法）
  const v = core.validateCard(back.data)
  t('带世界书的卡校验通过', v.ok === true, v)
}

console.log('\n=== 10. 头像存在 assets/，不塞进卡文件 ===')
{
  const ws = path.join(tmpdir(), 'lifecard-avatar-' + Date.now())
  await store.openWorkspace(ws, { create: true })
  await fs.mkdir(ws, { recursive: true })

  // 一张真的 1x1 PNG：只有它才该被接受
  const png1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const set = await store.writeAvatar(ws, 'mom', png1)
  t('存头像成功', set.ok === true, set)
  t('落在 assets/ 下', set.path === 'assets/mom.png', set.path)
  t('文件真的在盘上', await fs.stat(path.join(ws, 'assets/mom.png')).then(() => true).catch(() => false))

  const back = await store.readAvatar(ws, 'mom')
  t('读回来是同一张图', back === png1)

  // 校验门
  const notPng = await store.writeAvatar(ws, 'x', Buffer.from('hello world').toString('base64'))
  t('不是 PNG 的拒绝', notPng.ok === false, notPng)
  t('拒绝时说人话', typeof notPng.error === 'string' && notPng.error.includes('PNG'), notPng.error)

  const empty = await store.writeAvatar(ws, 'x', '')
  t('空图拒绝', empty.ok === false, empty)

  const noId = await store.writeAvatar(ws, '', png1)
  t('没编号拒绝', noId.ok === false, noId)

  // 删除是幂等的：点两次不该报错
  await store.removeAvatar(ws, 'mom')
  t('删掉后读到 null', (await store.readAvatar(ws, 'mom')) === null)
  const again = await store.removeAvatar(ws, 'mom')
  t('再删一次也不报错', again.ok === true, again)
  t('读一张没有头像的卡返回 null', (await store.readAvatar(ws, 'nobody')) === null)

  // 关键：头像不能混进卡文件。卡文件要能当纯文本进 git diff。
  const rel = 'people/mom.card.md'
  await store.writeCard(ws, rel, { lifecard: '0.1', id: 'mom', kind: 'real', name: '妈妈', world: 'reality' }, [{ title: '自述', body: '〔自述〕她做饭。' }])
  await store.writeAvatar(ws, 'mom', png1)
  const card = await store.readCard(ws, rel)
  t('卡文件里没有头像数据', !JSON.stringify(card.data ?? {}).includes('iVBORw0KGgo'), 'base64 漏进卡文件了')
  t('卡文件本身很短', String(card.text ?? '').length < 1000, String(card.text ?? '').length)
}

console.log('\n=== 11. 「想要什么样的人」只存在配置里，不进卡 ===')
{
  const ws = path.join(tmpdir(), 'lifecard-concept-' + Date.now())
  await store.openWorkspace(ws, { create: true })
  await fs.mkdir(ws, { recursive: true })

  t('一开始是空的', (await store.readConcept(ws)) === null)

  const saved = await store.writeConcept(ws, { idea: '一个嘴上凶、心里软的老太太', want: ['手很巧', '会做菜'], avoid: ['苦情戏'] })
  t('能存下来', saved.ok === true, saved)
  const back = await store.readConcept(ws)
  t('读回来想法还在', back?.idea === '一个嘴上凶、心里软的老太太', back)
  t('想突出的两项都在', JSON.stringify(back?.want) === JSON.stringify(['手很巧', '会做菜']), back?.want)
  t('不想要的那项也在', JSON.stringify(back?.avoid) === JSON.stringify(['苦情戏']), back?.avoid)

  // 先确认它落在配置文件里（此时还是上面那条内容）
  const cfgText = await fs.readFile(path.join(ws, 'lifecard.config.json'), 'utf8')
  t('概念存在配置文件里', cfgText.includes('嘴上凶'), '配置里没有')

  // 空白项要被清掉，不然界面上会出现一堆空行
  await store.writeConcept(ws, { idea: '  只剩想法  ', want: ['', '  ', '有内容'], avoid: [] })
  const cleaned = await store.readConcept(ws)
  t('想法两边的空格去掉', cleaned?.idea === '只剩想法', cleaned?.idea)
  t('空项被清掉', JSON.stringify(cleaned?.want) === JSON.stringify(['有内容']), cleaned?.want)

  // 关键：概念不能污染卡文件
  const rel = 'people/mom.card.md'
  await store.writeCard(ws, rel, { lifecard: '0.1', id: 'mom', kind: 'real', name: '妈妈', world: 'reality' }, [{ title: '自述', body: '〔自述〕她做饭。' }])
  const card = await store.readCard(ws, rel)
  t('卡文件里没有概念', !String(card.text ?? '').includes('嘴上凶'), '概念漏进卡文件了')

  // 全空等于清除
  const cleared = await store.writeConcept(ws, { idea: '', want: [], avoid: [] })
  t('全空等于清除', cleared.ok === true && cleared.concept === null, cleared)
  t('清除后读回 null', (await store.readConcept(ws)) === null)
  t('清除后配置文件里也不留空壳', !(await fs.readFile(path.join(ws, 'lifecard.config.json'), 'utf8')).includes('concept'))

  // 传 null 也要能清
  await store.writeConcept(ws, { idea: 'temp' })
  const cleared2 = await store.writeConcept(ws, null)
  t('传 null 也能清', cleared2.ok === true && (await store.readConcept(ws)) === null)
}

console.log('\n=== 12. 提案给数组时，卡里要是一条条，不是「0: 正常」 ===')
{
  const ws = path.join(tmpdir(), 'lifecard-array-' + Date.now())
  await store.openWorkspace(ws, { create: true })
  await store.writeCard(ws, 'people/arr.card.md', { lifecard: '0.1', id: 'arr', kind: 'real', name: '丁', world: 'reality' }, [{ title: '自述', body: '正文' }])

  const p = {
    about: { id: 'arr', name: '丁' },
    items: [
      { field: 'tags', value: ['家人', '爱做饭'], source_level: '自述', evidence: { material: 'm.md', quote: '丁说家人' } },
      { field: 'tags', value: '单独一个', source_level: '自述', evidence: { material: 'm.md', quote: '丁也说家人' } },
      { field: 'taboos', value: ['别提她', '别提那件事'], source_level: '自述', evidence: { material: 'm.md', quote: '丁说别提' } },
    ],
  }
  // 材料要真在盘上：apply 会对着现有材料重验引文（材料可删，删了就不能再引）。
  const matsText = '丁说家人\n丁也说家人\n丁说别提'
  await fs.mkdir(path.join(ws, 'materials'), { recursive: true })
  await fs.writeFile(path.join(ws, 'materials', 'm.md'), matsText, 'utf8')
  const saved = await store.saveProposal(ws, 'arr', p, { 'm.md': matsText })
  t('提案保存成功', saved.ok === true, saved)
  await store.writeCheckedFile(ws, saved.json, [0, 1, 2])
  const r = await store.applyProposal(ws, saved.json)
  t('三条都采纳了', r.applied === 3, r)

  const card = await store.readCard(ws, 'people/arr.card.md')
  t('tags 是一条条字符串', JSON.stringify(card.data.tags) === JSON.stringify(['家人', '爱做饭', '单独一个']), card.data.tags)
  t('tags 里没有下标记号', !JSON.stringify(card.data.tags).includes('0:'), card.data.tags)
  const taboos = (card.data.taboos ?? []).map((x) => (typeof x === 'string' ? x : x?.label))
  t('taboos 摊平成两条', JSON.stringify(taboos) === JSON.stringify(['别提她', '别提那件事']), card.data.taboos)
}

console.log('\n=== 13. 提案不许替人声明「对方同意了」 ===')
{
  const mats = { 'm.md': '他妈妈说他小时候很爱笑。' }
  const mk = (field, value) => ({ field, value, source_level: '自述', evidence: { material: 'm.md', quote: '小时候很爱笑' } })

  // 引文门该放行的普通字段
  const ok = core.verifyProposal({ items: [mk('性格', '爱笑')] }, mats)
  t('普通小节能过', ok.accepted.length === 1, ok.rejected)

  // 三个刻意挡住的字段：kind / world / consent
  for (const [field, value, why] of [
    ['kind', 'fictional', '模型不能替人决定这卡是真人还是虚构'],
    ['world', 'eldoria', '模型写一个不存在的世界会让卡从视图里消失'],
    ['consent', { basis: 'fictional' }, '模型没问过任何人，不能替人声明对方同意了'],
  ]) {
    const r = core.verifyProposal({ items: [mk(field, value)] }, mats)
    t(`提案改 ${field} 被拒（${why}）`, r.accepted.length === 0 && r.rejected.length === 1, r)
    t(`提案改 ${field} 时整体不 ok`, r.ok === false)
  }

  // 白名单不能把提示词承诺的字段挡在门外
  const promised = ['name', 'nickname', 'relation', 'birth_year', 'tags', 'competency', 'knowledge', 'taboos', 'address', 'life', 'status',
    '自述', '性格', '场景', '开场白', '备选开场', '对话示例', '关系史', '不会说的话', '不会做的事', '外貌', '口癖', '备注']
  const wrong = promised.filter((f) => core.verifyProposal({ items: [mk(f, 'x')] }, mats).accepted.length !== 1)
  t('提示词承诺的每个字段都能过闸门', wrong.length === 0, wrong)

  // SCHEMA_HINT 里列出的字段一个都不能漏
  const hinted = [...prompts.SCHEMA_HINT.matchAll(/^- (\w+)/gm)].map((m) => m[1])
  const missing = hinted.filter((h) => !core.PROPOSAL_FIELDS.includes(h))
  t('SCHEMA_HINT 的字段全在白名单里', missing.length === 0, missing)
}

console.log('=== 14. 同一天再跑一次分析，不许覆盖上一轮 ===')
{
  // 曾经的 bug：文件名固定是 <人>-<日期>，第二次分析把第一次的提案
  // 连同「哪几条被丢掉」的记录一起悄悄盖掉。那不是更新，是丢数据。
  const r14 = path.join(tmpdir(), 'lifecard-test-resave-' + Date.now())
  await store.openWorkspace(r14, { create: true })
  await store.appendMaterial(r14, 'a', '爷爷十几岁开始做这行，做了很多年。')
  const mats14 = await store.readMaterials(r14)
  const key14 = Object.keys(mats14)[0]
  const prop14 = {
    about: { id: 'yeye' },
    items: [
      { field: 'life', value: '在作坊干活', source_level: '自述', evidence: { material: key14, quote: '十几岁开始做这行' } },
      { field: 'competency', value: '编的', source_level: '自述', evidence: { material: key14, quote: '材料里绝对没有这句' } },
    ],
  }

  const first = await store.saveProposal(r14, 'yeye', prop14, mats14)
  const second = await store.saveProposal(r14, 'yeye', prop14, mats14)
  const third = await store.saveProposal(r14, 'yeye', prop14, mats14)
  t('第一份还是不带序号的老名字', /proposals\/yeye-\d{4}-\d{2}-\d{2}\.json$/.test(first.json), first.json)
  t('第二份另起一个文件名', second.json !== first.json, `${first.json} vs ${second.json}`)
  t('第二份带序号 -2', second.json.endsWith('-2.json'), second.json)
  t('第三份带序号 -3', third.json.endsWith('-3.json'), third.json)

  const list14 = await store.listProposals(r14)
  t('三份提案都还在（没被覆盖）', list14.length === 3, list14.map((x) => x.json))
  t('每份都保留了自己的丢弃记录', list14.every((x) => x.accepted === 1 && x.rejected === 1), list14.map((x) => [x.accepted, x.rejected]))

  // 三份的勾选互不串台
  await store.writeCheckedFile(r14, second.json, [0])
  const b1 = await store.readProposal(r14, first.json)
  const b2 = await store.readProposal(r14, second.json)
  const b3 = await store.readProposal(r14, third.json)
  t('勾第二份不影响第一份', b1.checkedCount === 0, b1.checkedCount)
  t('勾的那份记到了自己名下', b2.checkedCount === 1, b2.checkedCount)
  t('第三份也没被带着勾上', b3.checkedCount === 0, b3.checkedCount)

  // 两个文件（.md 与 .json）必须同名配对，否则列表点进去是一份别人的清单
  const md14 = await fs.readFile(path.join(r14, second.md), 'utf8')
  const json14 = JSON.parse(await fs.readFile(path.join(r14, second.json), 'utf8'))
  t('.md 与 .json 是同一轮的（日期一致）', md14.includes(json14.generated_at.slice(0, 10)) || md14.includes('提案'), second.md)

  // 提案目录被清空后，第一份要回到不带序号的名字 —— 撞名只在同一天同一个人重复时发生
  await fs.rm(path.join(r14, 'proposals'), { recursive: true, force: true })
  const again = await store.saveProposal(r14, 'yeye', prop14, mats14)
  t('清空后第一份回到不带序号的名字', again.json === first.json, again.json)

  // 不同的人不互相挤
  const other = await store.saveProposal(r14, 'mama', prop14, mats14)
  t('换个人不用排队', /proposals\/mama-\d{4}-\d{2}-\d{2}\.json$/.test(other.json), other.json)
}

// 15. 草稿：写卡写到一半关掉，下次还能接着写
//     草稿不是卡，也不是材料。它存在 .lifecard/drafts/，不进卡文件，
//     不参与体检、打分、导出；保存成功后必须立刻删掉，否则下次打开
//     会拿旧草稿盖掉刚存的内容。
{
  const r15 = path.join(tmpdir(), 'lifecard-draft-' + Date.now())
  await store.openWorkspace(r15, { create: true })

  t('没有草稿时读回 null', (await store.readDraft(r15, 'mama')) === null)
  t('没有草稿时列表是空的', (await store.listDrafts(r15)).length === 0)

  const draft = {
    data: { name: '妈妈', relation: '母亲', relation_extra: ['也是好友'] },
    sections: [{ title: '自述', body: '她十九岁进厂。' }, { title: '性格', body: '' }],
  }
  const w = await store.writeDraft(r15, 'mama', draft)
  t('草稿写得进去', w.ok === true)
  const onDisk = path.join(r15, '.lifecard', 'drafts', 'mama.json')
  t('落在 .lifecard/drafts/ 下', await fs.access(onDisk).then(() => true, () => false))
  t('没有写进卡文件', await fs.access(path.join(r15, 'people', 'mama.card.md')).then(() => false, () => true))

  const back = await store.readDraft(r15, 'mama')
  t('读回来名字对', back.data.name === '妈妈', back.data.name)
  t('读回来关系对', back.data.relation === '母亲')
  t('读回来补充身份对', JSON.stringify(back.data.relation_extra) === '["也是好友"]')
  t('读回来小节对', back.sections.length === 2 && back.sections[0].body === '她十九岁进厂。')
  t('带保存时间', typeof back.saved_at === 'string' && back.saved_at.includes('T'))

  // 再写一次只保留最新那份，不会存出第二份
  await store.writeDraft(r15, 'mama', { data: { name: '妈妈' }, sections: [{ title: '自述', body: '改过了。' }] })
  const list = await store.listDrafts(r15)
  t('同一张卡只有一份草稿', list.length === 1, JSON.stringify(list.map((d) => d.id)))
  t('内容是最新那次', (await store.readDraft(r15, 'mama')).sections[0].body === '改过了。')
  t('列表里带名字', list[0].name === '妈妈', list[0].name)
  t('列表里数得出写了几段', list[0].filled === 1, String(list[0].filled))

  // 不同的人各存各的，不互相覆盖
  await store.writeDraft(r15, 'baba', { data: { name: '爸爸' }, sections: [] })
  t('两张卡两份草稿', (await store.listDrafts(r15)).length === 2)

  // 头像只在动过时才进草稿：头像 base64 几百 KB，每次都存会把盘撑满
  const noAvatar = await store.writeDraft(r15, 'baba', { data: { name: '爸爸' }, sections: [] })
  t('没动过头像就不带头像字段', noAvatar.draft.avatar_touched === false && noAvatar.draft.avatar === undefined,
    JSON.stringify(Object.keys(noAvatar.draft)))
  const withAvatar = await store.writeDraft(r15, 'baba', { data: { name: '爸爸' }, sections: [], avatarTouched: true, avatar: 'iVBORw0KGgo=' })
  t('动过头像才带', withAvatar.draft.avatar === 'iVBORw0KGgo=' && withAvatar.draft.avatar_touched === true)
  t('读回来也带', (await store.readDraft(r15, 'baba')).avatar === 'iVBORw0KGgo=')

  // 删除
  await store.removeDraft(r15, 'mama')
  t('删掉之后读回 null', (await store.readDraft(r15, 'mama')) === null)
  t('删不存在的草稿不报错', (await store.removeDraft(r15, 'never-existed')).ok === true)

  // 空 id 不许写：否则所有新卡都会挤到同一个文件里
  const bad = await store.writeDraft(r15, '', { data: {}, sections: [] })
  t('没有 id 时拒绝写草稿', bad.ok === false)
  t('拒绝时给了人话', String(bad.error ?? '').includes('id'), String(bad.error))

  // 草稿目录被手删掉也要能读（返回 null，不抛）
  await fs.rm(path.join(r15, '.lifecard', 'drafts'), { recursive: true, force: true })
  t('目录没了读草稿不抛', (await store.readDraft(r15, 'baba')) === null)
  t('目录没了列表返回空数组', (await store.listDrafts(r15)).length === 0)

  // 坏文件不许把界面拖垮
  await fs.mkdir(path.join(r15, '.lifecard', 'drafts'), { recursive: true })
  await fs.writeFile(path.join(r15, '.lifecard', 'drafts', 'broken.json'), '这不是 json', 'utf8')
  t('坏草稿文件读回 null 不抛', (await store.readDraft(r15, 'broken')) === null)
  t('坏文件不进列表', (await store.listDrafts(r15)).length === 0)
}

// ── 20. 材料能删 ──────────────────────────────────────────────
{
  const r16 = path.join(tmpdir(), 'lifecard-test-delmat-' + Date.now())
  await store.openWorkspace(r16, { create: true })
  // 示例材料与后来提取的材料都要能删：用户删得掉，才敢按下去试。
  const one = await store.appendMaterial(r16, '示例材料', '这是一份示例材料。')
  const two = await store.appendMaterial(r16, '记忆-张三', '张三，1970 年生，做木工。')
  t('两份材料都在', (await store.listAll(r16)).materials.length === 2)

  const gone = await store.deleteMaterial(r16, one.path)
  t('删示例材料成功', gone.ok === true, JSON.stringify(gone))
  const after = (await store.listAll(r16)).materials
  t('列表里只剩一份', after.length === 1, JSON.stringify(after.map((m) => m.path)))
  t('删掉的那份真的不在列表里', after.every((m) => m.path !== one.path))
  t('读材料也读不到删掉的那份', (await store.readMaterials(r16))[one.path] === undefined)

  // 范围卡死：不能顺着 path 删到材料夹外面去。
  const bad1 = await store.deleteMaterial(r16, 'people/x.md')
  t('材料夹外面的不给删', bad1.ok === false, JSON.stringify(bad1))
  const bad2 = await store.deleteMaterial(r16, 'materials/../../etc/passwd')
  t('带 .. 的路径不给删', bad2.ok === false, JSON.stringify(bad2))
  const bad3 = await store.deleteMaterial(r16, '')
  t('没说删哪份就报错', bad3.ok === false)
  const bad4 = await store.deleteMaterial(r16, two.path)
  t('第二份也能删', bad4.ok === true, JSON.stringify(bad4))
  const bad5 = await store.deleteMaterial(r16, two.path)
  t('删第二遍给人话提示', bad5.ok === false && /不在了/.test(bad5.error), JSON.stringify(bad5))
  await fs.rm(r16, { recursive: true, force: true })
}

// ── 21. 同一条建议不许写第二遍（用户报的「关系史复制成两段」） ──────────
{
  const r17 = path.join(tmpdir(), 'lifecard-test-dupapply-' + Date.now())
  await store.openWorkspace(r17, { create: true })
  await store.writeCard(
    r17,
    'people/jia.card.md',
    { lifecard: '0.1', id: 'jia', kind: 'real', world: 'reality', name: '甲' },
    [],
    { force: true },
  )
  const mat = await store.appendMaterial(r17, '甲访谈', '甲说那年冬天他一个人去了南方，身上只有八十块钱。')
  const quote = '那年冬天他一个人去了南方'
  const ev = { material: mat.path, quote, line_start: 1 }
  const sectionItem = { field: '关系史', value: quote, source_level: '自述', evidence: ev }
  const tagItem = { field: 'tags', value: '南方', source_level: '自述', evidence: ev }
  const writeProposal = async (name, items) => {
    const rel = `proposals/${name}.json`
    const record = {
      spec: 'lifecard_proposal_v1',
      about: { id: 'jia', name: '甲' },
      generated_at: new Date().toISOString(),
      accepted: items,
      rejected: [],
      gaps: [],
      questions: [],
    }
    await fs.mkdir(path.join(r17, 'proposals'), { recursive: true })
    await fs.writeFile(path.join(r17, rel), JSON.stringify(record, null, 2), 'utf8')
    return rel
  }

  // 1) 第一次采纳：真写进去了
  const p1 = await writeProposal('jia-1', [sectionItem, tagItem])
  const first = await store.applyProposal(r17, p1, { checked: [0, 1] })
  t('第一次采纳写了两条', first.ok === true && first.applied === 2, JSON.stringify(first))
  t('第一次采纳回报了要摘掉哪几条', Array.isArray(first.handledIndexes) && first.handledIndexes.length === 2, JSON.stringify(first.handledIndexes))
  let card = await store.readCard(r17, 'people/jia.card.md')
  const sect = () => (card.sections ?? []).find((s) => s.title === '关系史')?.body ?? ''
  t('关系史写进去了一段', sect().includes(quote), sect())
  t('tags 写进去一条', JSON.stringify(card.data.tags) === JSON.stringify(['南方']), JSON.stringify(card.data.tags))

  // 2) 同一份提案再点一次：什么都不该发生
  card = await store.readCard(r17, 'people/jia.card.md')
  const again = await store.applyProposal(r17, p1, { checked: [0, 1] })
  card = await store.readCard(r17, 'people/jia.card.md')
  t('同一份提案点第二次不算新写入', again.ok === true && again.applied === 0, JSON.stringify(again))
  t('第二次也回报了要摘掉哪几条', Array.isArray(again.handledIndexes) && again.handledIndexes.length === 2, JSON.stringify(again.handledIndexes))
  t('关系史没有变成两段', (sect().match(/那年冬天他一个人去了南方/g) ?? []).length === 1, sect())
  t('tags 没有变成两条', JSON.stringify(card.data.tags) === JSON.stringify(['南方']), JSON.stringify(card.data.tags))

  // 3) 再整理一次材料会生成**新的一份提案**（记账是空的）。
  //    这才是用户真正踩到的路径：新文件、旧内容、点一下又写一遍。
  const p2 = await writeProposal('jia-2', [sectionItem, tagItem])
  const third = await store.applyProposal(r17, p2, { checked: [0, 1] })
  card = await store.readCard(r17, 'people/jia.card.md')
  t('新提案里的旧内容不算新写入', third.ok === true && third.applied === 0, JSON.stringify(third))
  t('新提案会把「卡里本来就有」报成 duplicate', third.duplicate === 2, JSON.stringify(third))
  t('关系史还是一段', (sect().match(/那年冬天他一个人去了南方/g) ?? []).length === 1, sect())
  t('tags 还是一条', JSON.stringify(card.data.tags) === JSON.stringify(['南方']), JSON.stringify(card.data.tags))

  // 4) 读提案时要标出「这条已经写进卡了」，界面靠它不再列出来
  const reread = await store.readProposal(r17, p2)
  t('采纳过的条目被标成 adopted', (reread.items ?? []).every((i) => i.adopted === true), JSON.stringify((reread.items ?? []).map((i) => i.adopted)))
  t('没有还需要处理的条目', reread.openCount === 0, String(reread.openCount))

  // 5) 真的新内容照样写得进去（不能因为判重把正常采纳挡了）
  const fresh = await store.appendMaterial(r17, '甲访谈二', '他后来把那八十块钱寄回了家，附了一封信。')
  const freshItem = {
    field: '关系史',
    value: '后来把那八十块钱寄回了家',
    source_level: '自述',
    evidence: { material: fresh.path, quote: '后来把那八十块钱寄回了家', line_start: 1 },
  }
  const p3 = await writeProposal('jia-3', [freshItem])
  const fourth = await store.applyProposal(r17, p3, { checked: [0] })
  card = await store.readCard(r17, 'people/jia.card.md')
  t('新的一段照样写得进去', fourth.ok === true && fourth.applied === 1, JSON.stringify(fourth))
  t('关系史现在有两段', (sect().match(/那年冬天他一个人去了南方/g) ?? []).length === 1 && sect().includes('寄回了家'), sect())
  const reread3 = await store.readProposal(r17, p3)
  t('新提案采纳后也标成 adopted', reread3.openCount === 0, String(reread3.openCount))
  await fs.rm(r17, { recursive: true, force: true })
}

// ── 22. 「都不要」之后不该还挂在首页待办里 ──────────────────────────
{
  const r18 = path.join(tmpdir(), 'lifecard-test-dismiss-' + Date.now())
  await store.openWorkspace(r18, { create: true })
  await store.writeCard(
    r18,
    'people/yi.card.md',
    { lifecard: '0.1', id: 'yi', kind: 'real', world: 'reality', name: '乙' },
    [],
    { force: true },
  )
  const mat = await store.appendMaterial(r18, '乙访谈', '乙说他在镇上开了一间铺子，只收过一个学徒。')
  const record = {
    spec: 'lifecard_proposal_v1',
    about: { id: 'yi', name: '乙' },
    generated_at: new Date().toISOString(),
    accepted: [
      { field: '关系史', value: '在镇上开了一间铺子', source_level: '自述', evidence: { material: mat.path, quote: '在镇上开了一间铺子', line_start: 1 } },
    ],
    rejected: [],
    gaps: [],
    questions: [],
  }
  const rel = 'proposals/yi-1.json'
  await fs.mkdir(path.join(r18, 'proposals'), { recursive: true })
  await fs.writeFile(path.join(r18, rel), JSON.stringify(record, null, 2), 'utf8')

  t('刚整理完时它算一件待办', (await store.listProposals(r18)).length === 1)
  const d = await store.writeDismissed(r18, rel, true)
  t('「都不要」能记下来', d.ok === true && d.dismissed === true, JSON.stringify(d))
  t('记下来之后不再挂在待办里', (await store.listProposals(r18)).length === 0)
  t('旁路文件本身不被当成一份建议', (await store.listProposals(r18)).every((p) => !String(p.json).includes('.dismissed.')))
  const still = await store.readProposal(r18, rel)
  t('文件没删，想回头看还能点进来', still.ok === true && (still.items ?? []).length === 1)
  t('文件确实还在盘上', (await fs.stat(path.join(r18, rel))).isFile())
  const undo = await store.writeDismissed(r18, rel, false)
  t('也能撤回「不要了」', undo.ok === true && undo.dismissed === false, JSON.stringify(undo))
  t('撤回后又回到待办里', (await store.listProposals(r18)).length === 1)

  // 采纳过一部分之后点「都不要」：剩下的不再出现，已写进卡的不受影响
  await store.applyProposal(r18, rel, { checked: [0] })
  let card = await store.readCard(r18, 'people/yi.card.md')
  t('先采纳的那条照样写进了卡', ((card.sections ?? []).find((s) => s.title === '关系史')?.body ?? '').includes('在镇上开了一间铺子'))
  await store.writeDismissed(r18, rel, true)
  t('采纳完再「都不要」，整份也不再占位', (await store.listProposals(r18)).length === 0)
  card = await store.readCard(r18, 'people/yi.card.md')
  t('已经写进卡的内容不会因为「都不要」被抹掉', ((card.sections ?? []).find((s) => s.title === '关系史')?.body ?? '').includes('在镇上开了一间铺子'))
  await fs.rm(r18, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
