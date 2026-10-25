/**
 * 数据层加固回归：把这一轮审计修掉的 bug 钉死。
 *
 * 这个文件唯一的价值是「每条断言在修复前必须失败」。所以每一组都对应一个
 * 真实存在过的缺陷，不是为了凑覆盖率。这些路径原先完全没有测试看管——
 * 引文门、墓碑缺键、材料过滤、路径穿越、勾选精度、数组摊平——正因为没人看，
 * 它们才能活到审计时才被发现。
 *
 * 少数几条是**对照**（两字引文能过、容差内行号能过）：它们修复前也是过的，
 * 留着是为了防止以后把闸门收得比设计意图更紧。注释里标了「对照」。
 *
 * 骨架照抄 test/store-test.mjs：tmpdir + openWorkspace + t() 计数。
 */
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

const stamp = Date.now()
const root = path.join(tmpdir(), 'lifecard-hard-data-' + stamp)
// 只差一个后缀的兄弟目录：裸 startsWith 会被它骗过去（HANDOFF 坑 #6 的形状）
const sibling = root + '-evil'
const outsideCard = path.join(tmpdir(), 'lifecard-hard-outside-' + stamp + '.card.md')

// 手写提案（第 6/8 组）绕过生成侧闸门直接测写入侧，但 apply 现在会对着
// **盘上**的材料重验引文。所以先把要引用的句子真写进 materials/x.md，
// 否则测的就不是「保留字段被拦」而是「引文找不到」。
await fs.mkdir(path.join(root, 'materials'), { recursive: true })
await fs.writeFile(path.join(root, 'materials', 'x.md'), '他喜欢下棋。她爱做饭，家里人都知道。', 'utf8')

await store.openWorkspace(root, { create: true })

// ── 1. 引文门 ──────────────────────────────────────────────────────
// 这是整个项目的防幻觉地线。四条约束（SPEC §8.1）里，引文与行号这两条
// 在修复前是漏的，等于闸门只关了一半。
console.log('=== 1. 引文门：短引文 / 缺材料 / 假行号 ===')
{
  const pad = (n) => Array.from({ length: n }, (_, i) => `第 ${i + 1} 行（材料正文）`).join('\n')
  const body = `${pad(3)}\n今天天气很热，爷爷说他不想出门。\n${pad(50)}`
  const mats = { 'materials/访谈.md': body }

  // 单字引文：修复前 '花' '热' '。' 全部 ok:true。中文材料里单字几乎必然命中，
  // 过了闸门等于没闸门——模型随手挑一个字就能给任何断言「找到出处」。
  t('单字引文被拒', core.verifyQuote({ evidence: { material: '访谈.md', quote: '热' } }, mats).ok === false)
  t('标点引文被拒', core.verifyQuote({ evidence: { material: '访谈.md', quote: '。' } }, mats).ok === false)
  // 对照：两字能过。prompts.js 说引文「可以短」，闸门不能收到语义级。
  t('两字引文能过（对照）', core.verifyQuote({ evidence: { material: '访谈.md', quote: '天气' } }, mats).ok === true)

  // 不指名材料：修复前会退化成「全库搜索」，引文在任意文件命中就算过，
  // 证据来源定位不到，也发现不了拼接。
  t('不指名材料被拒', core.verifyQuote({ evidence: { quote: '今天天气很热' } }, mats).ok === false)
  t('材料名为空白被拒（对照）', core.verifyQuote({ evidence: { material: '   ', quote: '今天天气很热' } }, mats).ok === false)

  // 假行号：修复前 line_start 完全不校验，而提案 Markdown 优先渲染它，
  // 于是「证据：xxx L9999」会原样进人眼。
  const far = core.verifyQuote({ evidence: { material: '访谈.md', quote: '今天天气很热', line_start: 9999 } }, mats)
  t('行号越界被拒', far.ok === false, far)
  const wild = core.verifyQuote({ evidence: { material: '访谈.md', quote: '今天天气很热', line_start: 50 } }, mats)
  t('行号偏差过大被拒', wild.ok === false, wild)
  // 对照：容差内（实际在第 4 行，报第 6 行）应当放过，否则正常的多行引文会被误杀。
  const near = core.verifyQuote({ evidence: { material: '访谈.md', quote: '今天天气很热', line_start: 6 } }, mats)
  t('容差内行号能过（对照）', near.ok === true, near)
  // 通过时返回的是实测行号，不是模型自报值。
  t('返回实测行号', near.line === 4, near.line)

  // 编字段名：SPEC §8.1 第 2 条要求 field 必须在 schema 里。
  const gate = core.verifyProposal({
    items: [
      { field: '__proto__', value: 'x', source_level: '自述', evidence: { material: '访谈.md', quote: '今天天气很热' } },
      { field: '完全不存在的字段', value: 'x', source_level: '自述', evidence: { material: '访谈.md', quote: '今天天气很热' } },
    ],
  }, mats)
  t('编造的 field 被拒', gate.accepted.length === 0, gate.accepted.map((x) => x.field))
  t('编造的 field 记进 rejected', gate.rejected.length === 2, gate.rejected.map((r) => r.reason))
}

// ── 2. 卡片往返 ────────────────────────────────────────────────────
// 这三个 bug 的共同点是「读写一次就损坏数据，而且不报错」——
// 用户只会觉得自己的字莫名其妙少了。
console.log('=== 2. 往返：_intro / 代码围栏 / 键名与数组元素 ===')
{
  const data = { lifecard: '0.1', id: 'mama', kind: 'real', world: 'reality', name: '妈妈' }

  // _intro：第一个 `##` 之前的正文没有标题，修复前被 filter 掉，整段消失。
  const withIntro = core.stringifyCard(data, [
    { title: '_intro', body: '这张卡是给三年后的自己看的。' },
    { title: '自述', body: '1958 年生，c 市人。' },
  ])
  const introBack = core.parseCard(withIntro)
  const intro = introBack.sections.find((s) => s.title === '_intro')
  t('_intro 正文没丢', intro !== undefined && intro.body.includes('三年后的自己'), intro)
  t('_intro 正文真的在文件里', withIntro.includes('三年后的自己'), withIntro)
  t('小节仍然完整', introBack.sections.some((s) => s.title === '自述' && s.body.includes('c 市人')))

  // 代码围栏：访谈材料里就有 ``` 围栏，围栏里的 `## ` 是示例不是标题。
  // 修复前会把代码块从中间切断，存回去 `## 对话示例` 只剩一个 ```。
  const fenced = '## 对话示例\n```\n## 这不是标题\n你好\n```\n\n## 自述\n正文'
  const secs = core.splitSections(fenced)
  t('围栏内的 ## 不当标题', secs.length === 2, secs.map((s) => s.title))
  t('围栏内容留在原小节', (secs[0]?.body ?? '').includes('## 这不是标题'), secs[0]?.body)
  t('围栏行本身没被吃掉', (secs[0]?.body ?? '').includes('```'), secs[0]?.body)
  const fenceRound = core.parseCard(core.stringifyCard(data, secs)).sections
  t('围栏小节再往返仍完整', (fenceRound[0]?.body ?? '').includes('这不是标题'), fenceRound[0]?.body)

  // 键名含冒号：修复前写成 `a: b: 1`，非法 YAML，读回变 {a:'b: 1'}。
  const colonKey = core.stringifyYaml({ 'a: b': 1, ok: 2 })
  const colonBack = core.parseYaml(colonKey)
  t('键名含冒号能往返', colonBack['a: b'] === 1, colonBack)
  t('键名含冒号没写出非法 YAML', !/^a: b: 1$/m.test(colonKey), colonKey)

  // 数组元素含逗号：修复前 tags:['a,b'] 输出 `[a,b, c]`，读回三项。
  // 中文用户写多标签带逗号很常见。
  const commaArr = core.stringifyYaml({ tags: ['a,b', 'c]d', 'e'] })
  const commaBack = core.parseYaml(commaArr)
  t('数组元素含逗号能往返', JSON.stringify(commaBack.tags) === JSON.stringify(['a,b', 'c]d', 'e']), commaBack.tags)
  t('第一个元素没被逗号切开', commaBack.tags[0] === 'a,b', commaBack.tags)

  // latestAffect：修复前用 list.length 索引排序后的 withAt 数组，
  // 只要有一条 affect 没写 at 就返回最旧那条。
  const la = core.latestAffect([
    { at: '2026-05-01', affinity: 5 },
    { affinity: 3 }, // 没有 at
    { at: '2020-01-01', affinity: 2 },
  ])
  t('latestAffect 取最新不是最旧', la?.at === '2026-05-01', la)
}

// ── 3. 墓碑 ────────────────────────────────────────────────────────
// 墓碑写错是灾难级的：一条残缺记录能让全库卡都读不出来，
// 一次撤回能让被删的内容继续被分析。
console.log('=== 3. 墓碑：残缺记录 / 材料过滤 ===')
{
  await store.writeCard(root, 'people/mama.card.md', {
    lifecard: '0.1', id: 'mama', kind: 'real', world: 'reality', name: '妈妈',
  }, [{ title: '自述', body: '1958 年生，c 市人。' }], { force: true })

  // 只有 anchor 的残缺记录：修复前对任何文件都命中，全库所有卡秒变「已撤回」。
  await store.appendRedaction(root, { anchor: '## 关系史#2026-06', reason: '只有 anchor，说不出撤回的是什么' })
  const afterBare = await store.readCard(root, 'people/mama.card.md')
  t('残缺墓碑不影响读卡', afterBare.ok === true, afterBare.error)
  const listed = await store.listAll(root)
  t('残缺墓碑不影响列表', listed.cards.some((c) => c.id === 'mama'), listed.cards.map((c) => c.id))

  // path+sha 双键的墓碑仍然要生效（别为了修残缺记录把真墓碑也放过）。
  const cur = await store.readCard(root, 'people/mama.card.md')
  await store.appendRedaction(root, { path: 'people/mama.card.md', sha256: store.sha256(cur.text), reason: '她要求删除' })
  const gone = await store.readCard(root, 'people/mama.card.md')
  t('完整的墓碑仍然生效', gone.ok === false && String(gone.error).includes('撤回'), gone.error)
  // 清掉这条，后面的组要用这张卡
  await fs.writeFile(path.join(root, 'redactions.jsonl'), '', 'utf8')
}

console.log('=== 4. 墓碑：撤回的材料不进分析输入 ===')
{
  const mat = await store.appendMaterial(root, '爷爷访谈', '第一段：他不想出门。')
  t('材料写进去了', mat.ok === true, mat)
  const before = await store.readMaterials(root)
  t('撤回前材料在读入里', Object.keys(before).includes(mat.path), Object.keys(before))

  // 返回的 sha256 必须是**全文**的（修复前返回的是本次追加片段，
  // 用它对不上文件，墓碑就失效）。
  const full = await fs.readFile(path.join(root, mat.path), 'utf8')
  t('返回的 sha256 是全文的', mat.sha256 === store.sha256(full), mat.sha256)

  await store.appendRedaction(root, { path: mat.path, sha256: mat.sha256, reason: '家属要求删除' })
  const after = await store.readMaterials(root)
  // SPEC §9.1 把「分析输入」列在必须过墓碑的读取路径里。
  t('撤回的材料不进 readMaterials', !Object.keys(after).includes(mat.path), Object.keys(after))

  // 子目录：listAll 会递归列出，readMaterials 也必须能读到，否则
  // 界面上看得见、分析时读不到。
  await fs.mkdir(path.join(root, 'materials/子目录'), { recursive: true })
  await fs.writeFile(path.join(root, 'materials/子目录/深处.md'), '深处的话', 'utf8')
  const deep = await store.readMaterials(root)
  t('材料子目录也会被读入', Object.keys(deep).some((k) => k.includes('子目录/深处.md')), Object.keys(deep))
}

// ── 5. 路径越权 ────────────────────────────────────────────────────
// 工作区是用户挑的一个文件夹。卡的路径本来就该在它里面，
// 修复前 writeCard 能凭空在工作区外落一个文件。
console.log('=== 5. 路径越权：读写都不许出工作区 ===')
{
  const evilData = { lifecard: '0.1', id: 'evil', kind: 'real', world: 'reality', name: '越界' }
  const relOut = path.relative(root, outsideCard)
  const wrote = await store.writeCard(root, relOut, evilData, [], { force: true })
  t('越界写卡被拒', wrote.ok === false, wrote)
  t('越界写卡有错误说明', String(wrote.error ?? '') !== '', wrote.error)
  const leaked = await fs.access(outsideCard).then(() => true).catch(() => false)
  t('工作区外真的没落文件', leaked === false)

  // 造一张真的在工作区外面的卡：修复前 readCard 会把它读出来。
  // 读 /etc/passwd 证明不了什么——那本来就存在不了，是被「文件不存在」拦的。
  await fs.writeFile(outsideCard, [
    '---', 'lifecard: "0.1"', 'id: outside', 'kind: real', 'world: reality', 'name: 外面的', '---', '', '## 自述', '', '不该被读到。',
  ].join('\n'), 'utf8')
  const readOut = await store.readCard(root, relOut)
  t('越界读卡被拒', readOut.ok === false, readOut)
  t('越界读卡没泄露内容', !String(readOut.text ?? '').includes('不该被读到'), readOut.text)
  const readSibling = await store.readCard(root, '../' + path.basename(sibling) + '/x.card.md')
  t('只差后缀的兄弟目录也拒', readSibling.ok === false, readSibling)
  // findCardByRelOrId 是 applyProposal 的入口，越界必须返回 null 而不是路径。
  const found = await store.findCardByRelOrId(root, relOut)
  t('越界路径找不到卡', found === null, found)
}

// ── 6. 保留字段 ────────────────────────────────────────────────────
// id 是全局唯一短标识（关系端点、头像、路径都靠它），lifecard 恒 "0.1"。
// 让提案改这两样，卡会从列表和路径上消失。
console.log('=== 6. 保留字段：提案改不动 id / lifecard ===')
{
  await store.writeCard(root, 'people/papa.card.md', {
    lifecard: '0.1', id: 'papa', kind: 'real', world: 'reality', name: '爸爸',
  }, [{ title: '自述', body: '他喜欢下棋。' }], { force: true })

  // 手写提案 JSON，绕过生成侧的闸门，直接测写入侧的拦截。
  const rec = {
    spec: core.PROPOSAL_VERSION,
    about: { id: 'papa' },
    generated_at: '2026-01-01',
    material: ['materials/x.md'],
    accepted: [
      { field: 'id', value: 'hacked', source_level: '自述', evidence: { material: 'materials/x.md', quote: '他喜欢下棋' } },
      { field: 'lifecard', value: '9.9', source_level: '自述', evidence: { material: 'materials/x.md', quote: '他喜欢下棋' } },
      { field: 'status', value: 'deceased', source_level: '自述', evidence: { material: 'materials/x.md', quote: '他喜欢下棋' } },
    ],
    rejected: [],
  }
  await fs.writeFile(path.join(root, 'proposals/papa-2026-01-01.json'), JSON.stringify(rec), 'utf8')
  await fs.writeFile(path.join(root, 'proposals/papa-2026-01-01.md'), '# 提案\n', 'utf8')

  const applied = await store.applyProposal(root, 'proposals/papa-2026-01-01.json', { checked: [0, 1, 2] })
  const after = await store.readCard(root, 'people/papa.card.md')
  t('提案改不动 id', after.data.id === 'papa', after.data.id)
  t('提案改不动 lifecard', after.data.lifecard === '0.1', after.data.lifecard)
  // 别把拦截做成「什么都不写」——普通字段必须照常生效。
  t('普通字段照常写入', after.data.status === 'deceased', after.data.status)
  t('被拦的两条记成 skipped', applied.skipped >= 2, applied)
}

// ── 7. 勾选精度 ────────────────────────────────────────────────────
// 用户只勾一条，却写进两条 = 直接违背「只读 [x]」。
console.log('=== 7. 勾选精度：前缀不做宽松匹配 ===')
{
  const mats = { 'materials/家人.md': '他说家里人都好，家人最重要。' }
  const proposal = {
    about: { id: 'papa' },
    items: [
      { field: 'tags', value: '家人', source_level: '自述', evidence: { material: 'materials/家人.md', quote: '家人最重要' } },
      { field: 'tags', value: '家', source_level: '自述', evidence: { material: 'materials/家人.md', quote: '家人最重要' } },
    ],
  }
  const saved = await store.saveProposal(root, 'papa', proposal, mats)
  t('提案两条都过闸门', saved.accepted === 2, saved)

  const mdAbs = path.join(root, saved.md)
  const md = await fs.readFile(mdAbs, 'utf8')
  // 只勾第一条（value 是 '家人' 的那条）
  const spliced = md.replace('- [ ] 家人\n', '- [x] 家人\n')
  t('md 里确实有两条', (md.match(/^- \[ \]/gm) ?? []).length === 2, md)
  await fs.writeFile(mdAbs, spliced, 'utf8')

  const read = await store.readProposal(root, saved.json)
  // 修复前：'家人' 是 '家' 的前缀，loose 匹配让两条都判成 checked。
  t('只勾一条就是一条', read.checkedCount === 1, read.checkedCount)
  const picked = read.items.map((i) => ({ v: i.value, checked: i.checked }))
  t('勾的是「家人」那条', picked.find((p) => p.v === '家人')?.checked === true, picked)
  t('「家」那条没被误勾', picked.find((p) => p.v === '家')?.checked === false, picked)
}

// ── 8. 数组摊平 ────────────────────────────────────────────────────
// 模型给 tags 常常是数组。修复前走 describeValue，把 ['a','b'] 拼成
// 「0: a；1: b」这种带下标的串写进卡里——卡上就多了两个假标签。
console.log('=== 8. 数组摊平：数组变多条，不是带下标的串 ===')
{
  await store.writeCard(root, 'people/mama2.card.md', {
    lifecard: '0.1', id: 'mama2', kind: 'real', world: 'reality', name: '妈妈2',
  }, [{ title: '自述', body: '爱做饭。' }], { force: true })

  const rec = {
    spec: core.PROPOSAL_VERSION,
    about: { id: 'mama2' },
    generated_at: '2026-01-02',
    material: ['materials/x.md'],
    accepted: [
      { field: 'tags', value: ['家人', '爱做饭'], source_level: '自述', evidence: { material: 'materials/x.md', quote: '爱做饭' } },
      { field: 'taboos', value: ['别提她', '别提那件事'], source_level: '自述', evidence: { material: 'materials/x.md', quote: '爱做饭' } },
    ],
    rejected: [],
  }
  await fs.writeFile(path.join(root, 'proposals/mama2-2026-01-02.json'), JSON.stringify(rec), 'utf8')
  await fs.writeFile(path.join(root, 'proposals/mama2-2026-01-02.md'), '# 提案\n', 'utf8')
  await store.applyProposal(root, 'proposals/mama2-2026-01-02.json', { checked: [0, 1] })

  const card = await store.readCard(root, 'people/mama2.card.md')
  t('tags 摊平成两条', JSON.stringify(card.data.tags) === JSON.stringify(['家人', '爱做饭']), card.data.tags)
  t('tags 里没有下标记号', !JSON.stringify(card.data.tags).includes('0:'), card.data.tags)
  const taboos = (card.data.taboos ?? []).map((x) => (typeof x === 'string' ? x : x?.label))
  t('taboos 摊平成两条', JSON.stringify(taboos) === JSON.stringify(['别提她', '别提那件事']), card.data.taboos)
}

// ── 9. doctor 的未标记来源比例 ─────────────────────────────────────
// SPEC §10 数据段要求这个数。修复前 averageUnmarked 是 return null 的桩，
// 等于这项体检从来没做过。
console.log('=== 9. doctor：未标记来源比例要真算 ===')
{
  // 两行正文，一行带来源标记、一行不带 → 0.5
  await store.writeCard(root, 'people/ratio.card.md', {
    lifecard: '0.1', id: 'ratio', kind: 'real', world: 'reality', name: '比例',
  }, [{ title: '自述', body: '他喜欢下棋〔自述〕\n他早上起得很早' }], { force: true })

  const doc = await store.doctor(root)
  t('unmarked 不再是 null', doc.unmarked !== null, doc.unmarked)
  t('unmarked 是真算出来的数', typeof doc.unmarked === 'number' && doc.unmarked > 0 && doc.unmarked <= 1, doc.unmarked)

  const all = await store.listAll(root)
  t('每张卡带 unmarkedRatio', all.cards.every((c) => typeof c.unmarkedRatio === 'number'), all.cards.map((c) => c.unmarkedRatio))
  t('listAll.updated 是时间不是文件名', all.cards.every((c) => c.updated === undefined || !String(c.updated).includes('.card.md')), all.cards.map((c) => c.updated))
}

// ── 10. 材料被删之后，旧提案不能把无出处的断言写进卡 ─────────────
// 材料可以删（用户要求）。删完再勾旧提案，那几条的原文已经不在任何文件里，
// 照写就是凭空往卡里加没有出处的话。修复前 applyProposal 只信保存时的验证结果，
// 一条都不会被拦。
console.log('=== 10. 删了材料，旧提案里引用它的条目要落空 ===')
{
  await store.writeCard(root, 'people/mama3.card.md', {
    lifecard: '0.1', id: 'mama3', kind: 'real', world: 'reality', name: '妈妈3',
  }, [{ title: '自述', body: '爱做饭。' }], { force: true })

  const mats = {
    'materials/甲.md': '他每天五点起床，风雨无阻。',
    'materials/乙.md': '他说最怕的是给家里添麻烦。',
  }
  const proposal = {
    about: { id: 'mama3' },
    items: [
      { field: 'status', value: 'deceased', source_level: '他述', evidence: { material: 'materials/甲.md', quote: '每天五点起床' } },
      { field: 'taboos', value: '给家里添麻烦', source_level: '自述', evidence: { material: 'materials/乙.md', quote: '最怕的是给家里添麻烦' } },
    ],
  }
  const saved = await store.saveProposal(root, 'mama3', proposal, mats)
  t('两条都过闸门', saved.accepted === 2, saved)

  // 两条都勾上
  const read = await store.readProposal(root, saved.json)
  const idx = read.items.map((_, i) => i)

  // 删掉其中一份材料
  await fs.mkdir(path.join(root, 'materials'), { recursive: true })
  await fs.writeFile(path.join(root, 'materials', '甲.md'), mats['materials/甲.md'], 'utf8')
  await fs.writeFile(path.join(root, 'materials', '乙.md'), mats['materials/乙.md'], 'utf8')
  const del = await store.deleteMaterial(root, 'materials/甲.md')
  t('材料删得掉', del.ok === true, del)

  // 两条都勾，但甲已经没了
  const applied = await store.applyProposal(root, saved.json, { checked: idx })
  const after = await store.readCard(root, 'people/mama3.card.md')
  t('删了材料后还能写入（剩下的那条）', applied.ok === true, applied)
  t('引用已删材料的那条被丢掉', applied.dropped === 1, applied)
  // 「最怕的是给家里添麻烦」还在乙里，必须写进去
  const taboos = (after.data.taboos ?? []).map((x) => (typeof x === 'string' ? x : x?.label))
  t('还有原文的那条照常写入', JSON.stringify(taboos) === JSON.stringify(['给家里添麻烦']), after.data.taboos)
  // 「每天五点起床」只在甲里，甲没了就不该写
  t('没了原文的那条没写进卡', after.data.status !== 'deceased', after.data.status)
}
// ── 11. 提案侧车不当提案；采纳过的条目不再写第二次 ───────────────
// 两个都是「界面看起来正常、但账在慢慢错」的 bug：
// 侧车被列进待办 → 点开 0 条、清不掉、待办计数虚高；
// 重复采纳 → 数组字段（competency/taboos）被 push 两遍，卡里长出重复条目。
console.log('=== 11. 侧车不进待办；采纳过的条目不重复写 ===')
{
  await store.writeCard(root, 'people/mama4.card.md', {
    lifecard: '0.1', id: 'mama4', kind: 'real', world: 'reality', name: '妈妈4',
  }, [{ title: '自述', body: '爱做饭。' }], { force: true })

  const matsText = '她说最拿手的是红烧肉。'
  await fs.mkdir(path.join(root, 'materials'), { recursive: true })
  await fs.writeFile(path.join(root, 'materials', '丙.md'), matsText, 'utf8')

  const proposal = {
    about: { id: 'mama4' },
    items: [
      { field: 'taboos', value: ['别提那件事'], source_level: '自述', evidence: { material: 'materials/丙.md', quote: '最拿手的是红烧肉' } },
    ],
  }
  const saved = await store.saveProposal(root, 'mama4', proposal, { 'materials/丙.md': matsText })
  t('保存成功', saved.ok === true, saved)

  // 写一份勾选侧车，它绝不能被当成一份提案列出来
  await store.writeCheckedFile(root, saved.json, [0])
  const listed = await store.listProposals(root)
  t('侧车没有混进提案列表', listed.every((x) => !String(x.json).includes('.checked.json')), listed.map((x) => x.json))
  t('提案列表里这份只出现一次', listed.filter((x) => String(x.json).includes('mama4')).length === 1, listed.map((x) => x.json))

  const first = await store.applyProposal(root, saved.json, { checked: [0] })
  t('第一次采纳成功', first.ok === true, first)
  t('第一次采纳了一条', first.applied === 1, first)

  // 再点一次同一份、同样勾选
  const second = await store.applyProposal(root, saved.json, { checked: [0] })
  t('第二次仍然返回成功（不是报错）', second.ok === true, second)
  t('第二次没有重复写', second.applied === 0, second)
  t('第二次记成「之前已采纳」', second.already === 1, second)

  const after = await store.readCard(root, 'people/mama4.card.md')
  const taboos = (after.data.taboos ?? []).map((x) => (typeof x === 'string' ? x : x?.label))
  t('卡里那条没被写两遍', taboos.length === 1, taboos)

  // 采纳完，列表要知道这份已经采纳过，界面才能把它从待办里摘掉
  const listed2 = await store.listProposals(root)
  t('列表报告已采纳条数', listed2[0]?.adopted === 1, listed2)
  t('已采纳数不超过可采用数', listed2[0]?.adopted <= listed2[0]?.accepted, listed2[0])
}

// ── 12. 快照留不下就不许覆盖；坏卡要报「读不出来」而不是装成空卡 ────
// 两个都是「界面说成功、其实丢了东西」的形状：
// 快照写失败被 catch 吞掉后照样覆盖 —— 唯一能回滚的那一份没了，用户还以为是保存成功；
// 解析失败被当成 ok:true —— 格式坏掉的卡变成一张空白卡挂在列表里，
// 而那句「有 N 个文件读不了」永远不触发。
console.log('=== 12. 快照写不下就不覆盖；格式坏的卡要报错 ===')
{
  await store.writeCard(root, 'people/keep.card.md', {
    lifecard: '0.1', id: 'keep', kind: 'real', world: 'reality', name: '原名',
  }, [{ title: '自述', body: '第一版。' }], { force: true })

  // 把快照目录的位置占成一个文件：mkdir 必然失败
  const snapDirAsFile = path.join(root, '.lifecard', 'snapshots', 'people__keep.card.md')
  await fs.mkdir(path.dirname(snapDirAsFile), { recursive: true })
  await fs.writeFile(snapDirAsFile, "x", "utf8")

  const blocked = await store.writeCard(root, 'people/keep.card.md', {
    lifecard: '0.1', id: 'keep', kind: 'real', world: 'reality', name: '改过的名字',
  }, [{ title: '自述', body: '第二版。' }], { force: true })
  t('快照写不下时拒绝覆盖', blocked.ok === false, blocked)
  t('拒绝时给了人话原因', typeof blocked.error === 'string' && blocked.error.length > 4, blocked)

  const still = await store.readCard(root, 'people/keep.card.md')
  t('旧内容还在，没被覆盖', still.ok === true && still.data.name === '原名', still.data?.name)

  // 清掉占位，恢复可写
  await fs.rm(snapDirAsFile, { recursive: true, force: true })

  // 坏卡：开头没有 --- 分隔线
  await fs.writeFile(path.join(root, 'people', 'broken.card.md'), '# 我开始写了但没写头\n\n## 自述\n随便写。\n', 'utf8')
  const bad = await store.readCard(root, 'people/broken.card.md')
  t('格式坏的卡读出来是失败', bad.ok === false, bad)
  t('失败原因是人话', typeof bad.error === 'string' && bad.error.includes('读不出来'), bad.error)

  const all = await store.listAll(root)
  t('坏卡没被当成正常卡列出来', all.cards.every((c) => c.path !== 'people/broken.card.md'), all.cards.map((c) => c.path))
  t('坏卡进了读不了清单', all.errors.some((e) => String(e.path).includes('broken.card.md')), all.errors)
}

// ── 收尾 ───────────────────────────────────────────────────────────
// ── 「贴一段文字，让它整理成一张卡」：卡还不存在时采纳要能现建一张 ──
// 以前 applyProposal 里有一句 `找不到 ${aboutId} 这张卡` 就直接返回失败，
// 于是这条路必须先手动建一张空卡才走得通——而对用户来说，「我讲了一大段，
// 它帮我整理成一张卡」最自然的期待就是不用先建卡。
{
  const mats = { 'materials/一段话.md': '她叫林小雨，爱笑，话很密，一紧张就重复同一句话。' }
  // 采纳时会拿引文对着**现在**的材料再验一遍，所以材料得真的在盘上。
  await store.appendMaterial(root, '一段话', mats['materials/一段话.md'], { replace: true })
  const onDisk = await store.readMaterials(root)
  const matKey = Object.keys(onDisk).find((k) => k.includes('一段话')) ?? Object.keys(onDisk)[0]
  // 提案里的 material 字段要用盘上真实的那条路径，否则引文找不到出处
  const proposalItems = null
  void proposalItems
  const proposal = {
    about: { id: 'lin-xiaoyu', name: '林小雨', kind: 'fictional' },
    items: [
      { field: '自述', value: '爱笑，话很密。', source_level: '自述', evidence: { material: matKey, quote: '爱笑，话很密' } },
      { field: '口癖', value: '一紧张就重复同一句话。', source_level: '自述', evidence: { material: matKey, quote: '一紧张就重复同一句话' } },
    ],
  }
  const saved = await store.saveProposal(root, 'lin-xiaoyu', proposal, { [matKey]: mats['materials/一段话.md'] })
  t('两条都过闸门', saved.accepted === 2, saved)

  const rec = await store.readProposal(root, saved.json)
  t('提案里记下了名字', rec.record?.about?.name === '林小雨', rec.record?.about)
  t('提案里记下了身份（虚构角色）', rec.record?.about?.kind === 'fictional', rec.record?.about)

  const applied = await store.applyProposal(root, saved.json, { checked: [0, 1] })
  t('卡不存在时采纳也能成功（现建一张）', applied.ok === true, applied)
  const made = await store.readCard(root, 'people/lin-xiaoyu.card.md')
  t('建出来的卡读得回', made.ok === true, made.error ?? '')
  t('卡名对', made.data?.name === '林小雨', made.data?.name)
  t('身份是虚构角色，没建成真人', made.data?.kind === 'fictional', made.data?.kind)
  t('正文真的写进去了', (made.sections ?? []).some((x) => String(x.body).includes('爱笑')), made.sections)
}

await fs.rm(root, { recursive: true, force: true }).catch(() => {})
await fs.rm(sibling, { recursive: true, force: true }).catch(() => {})
await fs.rm(outsideCard, { force: true }).catch(() => {})

console.log('\n=== 读不出来 ≠ 没有：不许拿「空」覆盖真数据 ===')
// 这一组全是同一个毛病的不同面孔：把「读失败」当成「还没有」。
// 后果一律是**安静地丢东西**——不报错，用户还以为存上了。
{
  const home = path.join(tmpdir(), 'lifecard-hd-' + Date.now())
  await fs.mkdir(home, { recursive: true })

  // 1) 配置坏了，不许被默认值重刷
  await fs.writeFile(path.join(home, 'lifecard.config.json'), '{ 这不是 JSON', 'utf8')
  const st = await store.readConfigState(home)
  t('配置坏了要如实说坏了', st.ok === false && st.exists === true, st)
  const written = await store.writeConfig(home, { intro_seen: true })
  const kept = await fs.readFile(path.join(home, 'lifecard.config.json'), 'utf8')
  t('坏掉的配置不会被悄悄重写', kept === '{ 这不是 JSON', kept)

  // 2) 目录当成卡片来读：要说「读不出来」，不是「不存在」
  const dirAsFile = path.join(home, 'people', 'x.card.md')
  await fs.mkdir(dirAsFile, { recursive: true })
  const read = await store.readCard(home, 'people/x.card.md')
  t('目录冒充卡片时说读不出来', read.ok === false && String(read.error).includes('读不出来'), read)
  t('而且带上错误码方便判断', String(read.code ?? '') !== '', read.code)

  // 3) 存卡不留临时文件
  const okCard = await store.writeCard(home, 'people/ok.card.md', { lifecard: '0.1', id: 'ok', kind: 'real', world: 'reality', name: '张三' }, [{ title: '自述', body: '一个人。' }], { force: true })
  t('正常存卡成功', okCard.ok === true, okCard.error)
  const names = await fs.readdir(path.join(home, 'people'))
  t('没留下 .tmp 残渣', names.every((n) => !n.includes('.tmp-')), names)
  const back = await store.readCard(home, 'people/ok.card.md')
  t('存进去的能读回来', back.ok === true && String(back.text).includes('一个人。'))

  // 4) 材料覆盖要留备份（材料是全库唯一没有快照的）
  await store.appendMaterial(home, '甲', '第一版：他十九岁进厂。', { replace: true })
  await store.appendMaterial(home, '甲', '第二版：他二十岁进厂。', { replace: true })
  const mats = await fs.readdir(path.join(home, 'materials'))
  t('覆盖材料时留了一份 .bak', mats.some((n) => n.includes('.bak-')), mats)
  t('覆盖后的内容是新的', mats.some((n) => !n.includes('.bak-') && n.endsWith('.md')))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
