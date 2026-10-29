/**
 * 加固回归：路径必须钉在工作区内 + 导出必须过 SPEC §6 的门禁。
 *
 * 这两件事都是「不测就会悄悄退回去」的类型：路径校验一旦漏接一条路由，
 * 界面上完全看不出问题，只有越界读写发生时才暴露；导出门禁漏接则意味着
 * 一张 lens 卡、一张家属同意日期没填的卡、一张未成年人的卡能被导成 PNG
 * 随手转发出去。所以这里按路由逐条钉死。
 *
 * 不需要起服务器：直接 buildApi() 拿路由表调。工作区用 tmpdir 下的临时目录，
 * 另外造一个只差一个后缀的 `ws-evil` 兄弟目录，专门验前缀绕过
 * （HANDOFF 坑 #6 的同一个形状：/tmp/ws 不该放过 /tmp/ws-evil）。
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import * as os from 'node:os'
import path from 'node:path'
import * as api from '../lib/index.js'
import * as store from '../lib/store.js'
import * as core from '../lib/core.js'

let pass = 0, fail = 0
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400)) }
}

const stamp = Date.now()
const ws = path.join(tmpdir(), 'lifecard-hard-' + stamp)
const sibling = ws + '-evil' // 只差一个后缀：裸 startsWith 会被它骗过去
const inside = path.join(tmpdir(), 'lifecard-hard-outside-' + stamp)

await fs.mkdir(ws, { recursive: true })
await fs.mkdir(sibling, { recursive: true })
await fs.mkdir(inside, { recursive: true })
await store.openWorkspace(ws, { create: true })

const ctx = {
  webServer: { register: () => () => {} },
  reflect: { get: () => undefined },
  effect: (fn) => { fn(); return () => {} },
  logger: { warn: () => {} },
  get: () => undefined,
}
const table = api.buildApi(ctx, async () => ws, { workspace: ws })

const badPath = (r) => r.ok === false && r.error !== null && typeof r.error === 'object' && r.error.code === 'bad-path'
// 界面上会原样显示 error.message，所以不许出现内部词。
const humanText = (r) => typeof r.error?.message === 'string' && r.error.message !== '' && !/workspace|工作区/i.test(r.error.message)
// 行为断言用：拦截文案里一个技术词都不许有。
// wording-test 只扫单行字面量，抓不到 `'kind 是 ' + kind` 这种拼接，所以这里真调路由。
const TECH_WORDS = ['lens', 'kind', 'world', 'consent', 'basis', 'recorded_at', 'chunk', 'schema', 'JSON', 'json', 'proposal', 'frontmatter', 'snapshot', 'workspace', 'YAML']
const plainText = (r) => {
  const message = r.error?.message
  if (typeof message !== 'string' || message === '') return false
  return !TECH_WORDS.some((word) => message.includes(word))
}

const baseCard = (over = {}) => ({
  lifecard: '0.1',
  id: 'jia',
  kind: 'real',
  world: 'reality',
  name: '甲',
  ...over,
})

console.log('\n=== 1. 越界路径一律拒绝（读） ===')
{
  // 工作区外种一张真的卡，确认「被拒」不是因为读不到。
  await fs.mkdir(path.join(inside, 'people'), { recursive: true })
  await fs.writeFile(
    path.join(inside, 'people', 'secret.card.md'),
    '---\nlifecard: "0.1"\nid: secret\nkind: real\nworld: reality\nname: 外部机密\n---\n',
    'utf8',
  )
  const outCard = path.join(inside, 'people', 'secret.card.md')
  const got = await table['card.get']({ path: '../' + path.basename(inside) + '/people/secret.card.md' })
  t('card.get 拒绝越界', badPath(got), got)
  t('card.get 的拒绝文案是人话', humanText(got), got.error)

  const abs = await table['card.get']({ path: outCard })
  t('card.get 拒绝绝对路径', badPath(abs), abs)

  const dotdot = await table['card.get']({ path: 'people/../../' + path.basename(inside) + '/people/secret.card.md' })
  t('card.get 拒绝中间夹 ../', badPath(dotdot), dotdot)
}

console.log('\n=== 2. 前缀绕过（/tmp/ws 不该放过 /tmp/ws-evil） ===')
{
  const rel = path.basename(sibling) + '/people/x.card.md'
  const r = await table['card.get']({ path: '../' + rel })
  t('兄弟目录不被前缀骗过', badPath(r), r)

  const w = await table['card.save']({ path: '../' + rel, data: baseCard({ id: 'x', name: 'x' }), sections: [] })
  t('写入兄弟目录被拒', badPath(w), w)
  const leaked = await fs.readFile(path.join(sibling, 'people', 'x.card.md'), 'utf8').catch(() => null)
  t('兄弟目录里没有落下文件', leaked === null, leaked === null ? '' : leaked.slice(0, 80))
}

console.log('\n=== 3. 越界路径一律拒绝（写 / 删 / 历史 / 头像 / 提案） ===')
{
  const target = '../' + path.basename(inside) + '/people/pwned.card.md'
  const saved = await table['card.save']({ path: target, data: baseCard({ id: 'pwned' }), sections: [] })
  t('card.save 拒绝越界', badPath(saved), saved)
  const onDisk = await fs.readFile(path.join(inside, 'people', 'pwned.card.md'), 'utf8').catch(() => null)
  t('工作区外没有真的写出文件', onDisk === null, onDisk === null ? '' : onDisk.slice(0, 80))

  const del = await table['card.delete']({ path: target, reason: '测试' })
  t('card.delete 拒绝越界', badPath(del), del)

  for (const m of ['card.history', 'card.version', 'card.restore']) {
    const r = await table[m]({ path: target, stamp: '20260101-000000-000' })
    t(m + ' 拒绝越界', badPath(r), r)
  }

  for (const m of ['export.card', 'export.json']) {
    const r = await table[m]({ path: target })
    t(m + ' 拒绝越界', badPath(r), r)
  }

  for (const m of ['avatar.set', 'avatar.remove']) {
    const r = await table[m]({ path: target, base64: 'iVBORw0KGgo=' })
    t(m + ' 拒绝越界', badPath(r), r)
  }

  const propPath = '../' + path.basename(inside) + '/proposals/an.json'
  for (const m of ['proposal.get', 'proposal.apply', 'proposal.check']) {
    const r = await table[m]({ json: propPath })
    t(m + ' 拒绝越界', badPath(r), r)
  }

  const empty = await table['card.get']({ path: '   ' })
  t('空路径被拒', badPath(empty), empty)
}

console.log('\n=== 4. 合法路径一条都没被改坏 ===')
{
  const rel = 'people/jia.card.md'
  const saved = await table['card.save']({ path: rel, data: baseCard(), sections: [{ title: '自述', body: '〔自述〕他在纱厂待过。' }] })
  t('工作区内的 card.save 成功', saved.ok === true, saved)
  t('落到给定相对路径', saved.path === rel, saved.path)

  const got = await table['card.get']({ path: rel })
  t('工作区内的 card.get 成功', got.ok === true && got.data?.name === '甲', got.ok)
  const byId = await table['card.get']({ id: 'jia' })
  t('按 id 读也还能用', byId.ok === true && byId.data?.id === 'jia', byId.ok)

  const hist = await table['card.history']({ path: rel })
  t('card.history 能用', hist.ok === true, hist)

  const nested = await table['card.save']({ path: './people/jia.card.md', data: baseCard(), sections: [] })
  t('./ 前缀被规范化后仍然成功', nested.ok === true && nested.path === rel, nested.path ?? nested)
}

console.log('\n=== 5. 导出门禁：lens 永不可导出 ===')
{
  const rel = 'people/lens.card.md'
  await table['card.save']({ path: rel, data: baseCard({ id: 'lens', kind: 'lens', name: '透镜' }), sections: [] })
  const png = await table['export.card']({ path: rel })
  t('lens 导不出 PNG', png.ok === false, png.ok)
  t('lens 的拒绝码是 not-exportable', png.error?.code === 'not-exportable', png.error)
  t('lens 的拒绝文案是人话', humanText(png), png.error)
  const json = await table['export.json']({ path: rel })
  t('lens 也导不出 JSON', json.ok === false && json.error?.code === 'not-exportable', json.error)
}

console.log('\n=== 6. 导出门禁：consent 三条 ===')
{
  // 6a. real + basis=fictional —— SPEC 说这条不能用来绕过同意
  const relA = 'people/rea-fic.card.md'
  await table['card.save']({ path: relA, data: baseCard({ id: 'rea-fic', name: '乙', consent: { basis: 'fictional' } }), sections: [], force: true })
  const pngA = await table['export.card']({ path: relA })
  t('real + fictional consent 导不出 PNG', pngA.ok === false && pngA.error?.code === 'consent-required', pngA.error)
  const jsonA = await table['export.json']({ path: relA })
  t('real + fictional consent 也导不出 JSON', jsonA.ok === false && jsonA.error?.code === 'consent-required', jsonA.error)

  // 6b. self + basis=fictional 同样拒绝（SPEC 把 real / self 并列）
  const relSelf = 'people/self-fic.card.md'
  await table['card.save']({ path: relSelf, data: baseCard({ id: 'self-fic', kind: 'self', name: '我', consent: { basis: 'fictional' } }), sections: [], force: true })
  const selfPng = await table['export.card']({ path: relSelf })
  t('self + fictional consent 导不出', selfPng.ok === false && selfPng.error?.code === 'consent-required', selfPng.error)

  // 6c. family-agreed 缺 recorded_at
  const relB = 'people/fam.card.md'
  await table['card.save']({ path: relB, data: baseCard({ id: 'fam', name: '丙', consent: { basis: 'family-agreed' } }), sections: [], force: true })
  const pngB = await table['export.card']({ path: relB })
  t('family-agreed 缺日期导不出 PNG', pngB.ok === false && pngB.error?.code === 'consent-incomplete', pngB.error)
  const jsonB = await table['export.json']({ path: relB })
  t('family-agreed 缺日期也导不出 JSON', jsonB.ok === false && jsonB.error?.code === 'consent-incomplete', jsonB.error)

  // 6d. family-agreed 填了日期就放行
  await table['card.save']({ path: relB, data: baseCard({ id: 'fam', name: '丙', consent: { basis: 'family-agreed', recorded_at: '2026-10-01' } }), sections: [] })
  const pngB2 = await table['export.card']({ path: relB })
  t('补齐日期后能导出 PNG', pngB2.ok === true, pngB2.error ?? pngB2.ok)
}

console.log('\n=== 7. 导出门禁：未成年人禁止 PNG，但能导 JSON ===')
{
  const rel = 'people/minor.card.md'
  const year = new Date().getFullYear() - 10
  await table['card.save']({ path: rel, data: baseCard({ id: 'minor', name: '小丁', birth_year: year }), sections: [], force: true })
  const png = await table['export.card']({ path: rel })
  t('未成年 real 导不出 PNG', png.ok === false && png.error?.code === 'minor-no-png', png.error)
  t('未成年人那条文案是人话', humanText(png), png.error)
  const json = await table['export.json']({ path: rel })
  t('未成年 real 仍可导 JSON（留档）', json.ok === true, json.error ?? json.ok)

  // 成年人放行
  const adult = 'people/adult.card.md'
  await table['card.save']({ path: adult, data: baseCard({ id: 'adult', name: '戊', birth_year: 1970 }), sections: [], force: true })
  const adultPng = await table['export.card']({ path: adult })
  t('成年人能导出 PNG', adultPng.ok === true, adultPng.error ?? adultPng.ok)

  // 未成年但不是 real（fictional）不该被这条拦住
  const fic = 'people/minor-fic.card.md'
  await table['card.save']({ path: fic, data: baseCard({ id: 'minor-fic', kind: 'fictional', name: '虚构少年', birth_year: year }), sections: [] })
  const ficPng = await table['export.card']({ path: fic })
  t('虚构的少年不受未成年那条拦', ficPng.ok === true, ficPng.error ?? ficPng.ok)
}

console.log('\n=== 8. 导出门禁：不拦「real 完全没填 consent」（本地备份优先） ===')
{
  const rel = 'people/noconsent.card.md'
  await table['card.save']({ path: rel, data: baseCard({ id: 'noconsent', name: '己' }), sections: [] })
  const png = await table['export.card']({ path: rel })
  t('real 没填 consent 仍能导出 PNG', png.ok === true, png.error ?? png.ok)
  t('导出结果双 chunk 同源', png.consistent === true, png.missing)
  const json = await table['export.json']({ path: rel })
  t('real 没填 consent 也能导出 JSON', json.ok === true, json.error ?? json.ok)
  t('PNG 导出返回了 base64', typeof png.base64 === 'string' && png.base64.length > 100, String(png.base64 ?? '').length)
}

console.log('\n=== 9. 拦截文案里没有技术词（每种拦截真调一次路由） ===')
{
  // 重新种一张「家属同意但没填日期」的卡：6d 已经把 fam.card.md 补成能导出了。
  await table['card.save']({ path: 'people/fam-nodate.card.md', data: baseCard({ id: 'fam-nodate', name: '庚', consent: { basis: 'family-agreed' } }), sections: [], force: true })
  const cases = [
    ['「我的偏好」卡', 'people/lens.card.md', 'not-exportable'],
    ['真人却填了虚构同意', 'people/rea-fic.card.md', 'consent-required'],
    ['家属同意没填日期', 'people/fam-nodate.card.md', 'consent-incomplete'],
    ['未满 18 岁的真人卡', 'people/minor.card.md', 'minor-no-png'],
  ]
  for (const [name, rel, code] of cases) {
    const r = await table['export.card']({ path: rel })
    t(`${name}被拦下且 code 不变`, r.ok === false && r.error?.code === code, r)
    t(`${name}的提示没有技术词`, plainText(r), r.error?.message)
  }
  const normal = await table['export.card']({ path: 'people/adult.card.md' })
  t('能导出的正常卡没被误伤', normal.ok === true, normal.error ?? normal.ok)
}

console.log('\n=== 10. 后台兜底 catch 不漏英文（EISDIR 这类 errno） ===')
{
  let handler = null
  const sent = []
  const res = {
    status: 0,
    writeHead(status) { this.status = status },
    end(payload) { sent.push({ status: this.status, body: JSON.parse(String(payload)) }) },
  }
  const ctx2 = {
    webServer: { register: (options) => { handler = options.handler; return () => {} } },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
  }
  api.apply(ctx2, { workspace: ws })
  t('假 webServer 拿到了 handler', typeof handler === 'function', typeof handler)
  await handler({
    method: 'POST',
    url: '/api/dsh-lifecard/card.get',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { throw new Error('EISDIR: illegal operation on a directory, read') },
  }, res)
  const got = sent[0]
  t('兜底 catch 回 500', got?.status === 500, got?.status)
  t('兜底 catch 带 internal code', got?.body?.error?.code === 'internal', got?.body?.error)
  t('EISDIR 不会原样露到界面', typeof got?.body?.error?.message === 'string' && !/[A-Za-z]{3,}/.test(got.body.error.message), got?.body?.error?.message)
  t('兜底文案仍然是中文', /[\u4e00-\u9fff]/.test(String(got?.body?.error?.message ?? '')), got?.body?.error?.message)
}

await fs.rm(ws, { recursive: true, force: true }).catch(() => {})
await fs.rm(sibling, { recursive: true, force: true }).catch(() => {})
await fs.rm(inside, { recursive: true, force: true }).catch(() => {})

// ── 导出门禁的 error 必须是一句话，不是对象 ────────────────────
{
  // 曾经这里 return { ok:false, error: {code, message} }。
  // 界面把 error 直接塞进红字里显示：运气好显示成 [object Object]，
  // 运气不好 React 直接抛，用户看到的是白屏。门禁本身是对的，是形状错了。
  const api2 = api.buildApi({}, async () => ws, {})
  await api2['card.save']({ data: { lifecard: '0.1', id: 'lens-x', kind: 'lens', world: 'reality', name: '某透镜' }, sections: [] })
  const r = await api2['export.card']({ path: 'people/lens-x.card.md' })
  t('lens 卡导不出 PNG', r.ok === false, r)
  // 路由层的 error 是 {code, message}：code 给程序判，message 给人看。
  t('拦下来时带可判定的 code', r.error?.code === 'not-exportable', r)
  // 界面会把 message 原样显示出来，所以它一个字的技术词都不能有。
  const FORBIDDEN = /lens|kind|consent|basis|recorded_at|chunk|schema|json|JSON|proposal|frontmatter|snapshot|workspace|YAML/
  t('拦下来时 message 是人话', typeof r.error?.message === 'string' && r.error.message.length > 4 && !FORBIDDEN.test(r.error.message), r)
}
// ── 同名新建不许把已有的卡悄悄换掉 ──────────────────────────────────
{
  const api5 = api.buildApi({}, async () => ws, {})
  const first = await api5['card.save']({ data: { lifecard: '0.1', id: 'same', kind: 'real', world: 'reality', name: '同名', relation: '朋友' }, sections: [{ title: '关系史', body: '原来那张卡里写过的东西' }] })
  t('第一次新建没问题', first.ok === true, first)
  const again = await api5['card.save']({ data: { lifecard: '0.1', id: 'same', kind: 'real', world: 'reality', name: '同名' }, sections: [] })
  t('同名再来一次被拦下', again.ok === false, again)
  t('拦下时说的是人话、并且告诉人该怎么办', /已经有一张/.test(String(again.error)) && /改名|名字/.test(String(again.error)), again.error)
  const back = await api5['card.get']({ path: 'people/same.card.md' })
  t('原来那张卡的内容还在', back.ok === true && JSON.stringify(back.sections ?? []).includes('原来那张卡里写过的东西'), back.sections)
  const forced = await api5['card.save']({ path: 'people/same.card.md', data: { lifecard: '0.1', id: 'same', kind: 'real', world: 'reality', name: '同名' }, sections: [] })
  t('明确给路径的保存照旧能改这张卡', forced.ok === true, forced)
}

// ── 调用方传进来的工作区，不许被配置里的真实路径盖掉 ────────────────
// 这条曾经真出过事：路由层改成「每次都从配置现读工作区」之后，
// 传进来的临时目录被忽略，整套测试改成了往用户自己的库（~/LifeCard）里写，
// 而且是静默的——测试全绿，用户的 cards/ 里多出几份测试卡。
{
  const api4 = api.buildApi({}, async () => ws, {})
  const st = await api4['state.get']({})
  t('注入的工作区优先于配置', path.resolve(st.workspace) === path.resolve(ws), { got: st.workspace, want: ws })
  await api4['card.save']({ data: { lifecard: '0.1', id: 'only-temp', kind: 'real', world: 'reality', name: '只该落在临时目录' }, sections: [] })
  const landed = await fs.stat(path.join(ws, 'people', 'only-temp.card.md')).then((s) => s.isFile()).catch(() => false)
  t('新写的卡落在注入的那个目录里', landed === true)
  await fs.rm(path.join(ws, 'people', 'only-temp.card.md'), { force: true })
}

// ── 符号链接不能把读写带出工作区 ────────────────────────────────
// 字面包含判断只管得住 `../` 和前缀。工作区里放一个指向别处的软链，
// 以前 card.get / card.save 照那个路径读写，就真的落在工作区外面了。
{
  const outside = await fs.mkdtemp(path.join(tmpdir(), 'lifecard-outside-'))
  await fs.writeFile(path.join(outside, 'secret.card.md'), '---\nname: 别人的卡\n---\n\n不该被读到\n', 'utf8')
  const linkName = 'people-link'
  await fs.symlink(outside, path.join(ws, linkName))
  const apiLink = api.buildApi({}, async () => ws, {})

  const read = await apiLink['card.get']({ path: `${linkName}/secret.card.md` })
  t('顺着软链读工作区外的卡被拒', read.ok === false, read)
  t('拒绝时不会把外面的内容带出来', !JSON.stringify(read).includes('不该被读到'), read)

  const write = await apiLink['card.save']({
    path: `${linkName}/new.card.md`,
    data: { lifecard: '0.1', id: 'new', kind: 'real', world: 'reality', name: '新卡' },
    sections: [],
  })
  t('顺着软链往工作区外写卡被拒', write.ok === false, write)
  const landedOutside = await fs.stat(path.join(outside, 'new.card.md')).then(() => true).catch(() => false)
  t('工作区外没有真的落下文件', landedOutside === false)

  // 底层也一样：store 的读写闸不认符号链接
  t('store 读卡也认得出这是越界', (await store.readCard(ws, `${linkName}/secret.card.md`)).ok === false)

  // 软链本身指回工作区内部时不许误伤
  await fs.symlink(path.join(ws, 'people'), path.join(ws, 'people-self'))
  const inside = await apiLink['card.get']({ path: 'people-self/../people-self/' + 'nope.card.md' })
  const insideText = JSON.stringify(inside)
  t('指回工作区内部的软链不被误判成越界', inside.ok === false && !insideText.includes('不在当前文件夹') && insideText.includes('不存在'), inside)

  await fs.rm(path.join(ws, linkName), { force: true })
  await fs.rm(path.join(ws, 'people-self'), { force: true })
  await fs.rm(outside, { recursive: true, force: true })
}

// ── 访谈账本：名字带前缀的另一个人，不能算成同一个人回答过 ──────────
// 张三 与 张三丰 只是示例；真实场景是「老王」和「老王的儿子」这类 id。
{
  const api3 = api.buildApi({}, async () => ws, {})
  for (const [id, name] of [['zsan', '张三'], ['zsanfeng', '张三丰']]) {
    await api3['card.save']({ data: { lifecard: '0.1', id, kind: 'real', world: 'reality', name, relation: '朋友' }, sections: [] })
  }
  // 只给「张三」记一条已经问过的
  const rec = await api3['interview.record']({ about: 'zsan', q: 'friend.q01', ask: '怎么认识的', answer: '在单位食堂认识的，坐一桌' })
  t('访谈记录写得进账本', rec.ok === true, rec)

  const plain = await api3['interview.plan']({ about: 'zsan', relation: 'friend', limit: 20 })
  const neighbor = await api3['interview.plan']({ about: 'zsanfeng', relation: 'friend', limit: 20 })
  t('已问过的那题不再问', plain.next.every((q) => q.id !== 'friend.q01'), plain.next)
  t('另一个人一题都不该被算成已问', neighbor.next.some((q) => q.id === 'friend.q01'), neighbor.next)
  t('两个人的已问数不同', plain.askedAlready === 1 && neighbor.askedAlready === 0, { plain: plain.askedAlready, neighbor: neighbor.askedAlready })

  // 材料块的标题必须是「问题本身」。以前是 `## friend.q01`，回头「整理进卡里」
  // 时模型看到的是一串题号加裸答案，不知道这句话在回答什么，只能把答案
  // 硬塞进不相干的格子里。
  const recText = rec.material === null ? '' : await fs.readFile(path.join(ws, rec.material), 'utf8')
  t('访谈材料的标题是那句问题', recText.includes('## 怎么认识的'), recText.slice(0, 160))
  t('访谈材料里留着题号方便回查', recText.includes('问过的题号：friend.q01'), recText.slice(0, 200))
  const rec2 = await api3['interview.record']({ about: 'zsan', q: 'friend.q02', ask: '平时怎么称呼', answer: '叫老张', options: ['老张', '张哥'] })
  const rec2Text = await fs.readFile(path.join(ws, rec2.material), 'utf8')
  t('访谈材料带上当时给的几个方向', rec2Text.includes('老张 / 张哥'), rec2Text.slice(-260))
}

// ── 访谈：跳过 ≠ 不想说 ────────────────────────────────────────
// 「跳过」的意思是这题现在想不起来，回头还能问；「不想说」才是永别。
// 以前台账里只要有一行就按「问过了」砍掉，两个按钮于是变成同一件事：
// 跳过的题永远不再问，而它对应的字段永远填不上，完成页还一直报「还空着」。
{
  const api5 = api.buildApi({}, async () => ws, {})
  await api5['card.save']({ data: { lifecard: '0.1', id: 'zhangsan', kind: 'real', world: 'reality', name: '老王', relation: '朋友' }, sections: [] })
  const first = await api5['interview.plan']({ about: 'zhangsan', relation: 'friend', limit: 20 })
  const q1 = first.next[0]
  t('朋友这类问题出得来人', q1 !== undefined && typeof q1.id === 'string', first.next)
  // 跳过第一题（skipped，没有 sealed）
  await api5['interview.record']({ about: 'zhangsan', q: q1.id, ask: q1.ask, status: 'skipped' })
  const afterSkip = await api5['interview.plan']({ about: 'zhangsan', relation: 'friend', limit: 20 })
  t('跳过的题还在队列里，没被当成永别', afterSkip.next.some((q) => q.id === q1.id), afterSkip.next.map((q) => q.id))
  t('跳过的题排到最后，不挡别的题', afterSkip.next[0].id !== q1.id, afterSkip.next.map((q) => q.id))
  // 再把它记成「不想说」
  await api5['interview.record']({ about: 'zhangsan', q: q1.id, ask: q1.ask, status: 'skipped', reason: 'sealed' })
  const afterSeal = await api5['interview.plan']({ about: 'zhangsan', relation: 'friend', limit: 20 })
  t('说了不想说的题不再问', afterSeal.next.every((q) => q.id !== q1.id), afterSeal.next.map((q) => q.id))
  // 只跳过一次的会再问一次；跳过两次就别再问了，不然同一题会一直转回来
  const twice = afterSeal.next[0]
  if (twice !== undefined) {
    await api5['interview.record']({ about: 'zhangsan', q: twice.id, ask: twice.ask, status: 'skipped' })
    const after1 = await api5['interview.plan']({ about: 'zhangsan', relation: 'friend', limit: 20 })
    t('跳过一次的题还会再问一次', after1.next.some((q) => q.id === twice.id), after1.next.map((q) => q.id))
    await api5['interview.record']({ about: 'zhangsan', q: twice.id, ask: twice.ask, status: 'skipped' })
    const after2 = await api5['interview.plan']({ about: 'zhangsan', relation: 'friend', limit: 20 })
    t('跳过两次的题就不再问了', after2.next.every((q) => q.id !== twice.id), after2.next.map((q) => q.id))
  }
  t('不想说会进 sealed 名单', afterSeal.sealed.includes(q1.id), afterSeal.sealed)
  // 答过的题也不再问
  const q2 = afterSeal.next[0]
  await api5['interview.record']({ about: 'zhangsan', q: q2.id, ask: q2.ask, answer: '在单位食堂认识的，坐一桌' })
  const afterAnswer = await api5['interview.plan']({ about: 'zhangsan', relation: 'friend', limit: 20 })
  t('答过的题不再问', afterAnswer.next.every((q) => q.id !== q2.id), afterAnswer.next.map((q) => q.id))
  t('问过的题数把跳过和不想说都算进去', afterAnswer.askedAlready === 2, afterAnswer.askedAlready)
}

// ── 验收脚本不许把用户正在用的工作区指走 ────────────────────────
// 真实事故：live.mjs 把实例工作区指到 /tmp 下建库、跑完 rm -rf 就退出。
// 用户开着的那一屏因此变成一个已被删除的目录，看起来就是「我的卡全没了」。
{
  const live = await fs.readFile(new URL('./live.mjs', import.meta.url), 'utf8')
  t('验收脚本记得住跑之前是哪个工作区', /const ORIGINAL_WS =/.test(live) && /st\.workspace/.test(live))
  t('验收脚本跑完会把工作区指回去', /workspace\.init', \{ workspace: ORIGINAL_WS \}/.test(live))
  t('验收脚本里这句解释了为什么必须指回去', /指回/.test(live) && /卡全没了/.test(live))
}


// ── 模型调用必须有上限 ──
// 模型偶尔不回话：不出错也不结束。没有上限的话界面上那个「分析」会
// 永远转圈，用户分不清是在算还是已经死了。这里钉住限时本身。
{
  t('限时是分钟级不是毫秒级', api.MODEL_TIMEOUT_MS >= 60000, String(api.MODEL_TIMEOUT_MS))
  const fast = await api.withTimeout(Promise.resolve('好了'), 200, 'AI ')
  t('按时回来的原样返回', fast === '好了', String(fast))
  let slowMsg = ''
  try {
    await api.withTimeout(new Promise(() => {}), 30, 'AI ')
  } catch (e) { slowMsg = String(e?.message ?? e) }
  t('不回话的会被掐掉', slowMsg.includes('没有回话'), slowMsg)
  t('掐掉时说明等了多少秒', /\d+ 秒/.test(slowMsg), slowMsg)
}

// ── 模型路由：先用用户正在用的那个 provider ──
// 真实事故：这台机器上主 agent 用 `provider: raccoon`，而插件首选列表里
// 没有 raccoon，于是 analyze 去挑了另一个 transport——它接了请求不回话，
// 界面上的「分析」一直转，直到宿主 HTTP 层 5 分钟后断开（fetch failed）。
// 这里用一个假 llm 把顺序钉住：raccoon 在列表里就必须先用它。
{
  const seen = []
  const fakeLlm = {
    listProviders: async () => [
      { provider: 'buddy', models: [{ id: 'hy3' }] },
      { provider: 'raccoon', models: [{ id: 'sn-deepseek-v4-1-flash-1017' }] },
    ],
    listModels: async () => [],
    stream: async (opts) => {
      seen.push(`${opts.provider}/${opts.model}`)
      return (async function* () {
        yield { type: 'text-delta', text: '{"items":[],"gaps":[],"questions":[]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const ctx2 = { ...ctx, get: (name) => (name === 'llm' ? fakeLlm : undefined) }
  const table2 = api.buildApi(ctx2, async () => ws, { workspace: ws })
  await store.appendMaterial(ws, '路由试验材料', '甲说他十九岁进纱厂，手指头被机器压过一回。')
  const r = await table2['analyze.run']({ about: 'jia', name: '甲' })
  t('模型调用选了 raccoon（用户主 agent 用的那个）', String(seen[0] ?? '').startsWith('raccoon/'), seen)
  t('没落到 buddy 那种会卡住的 transport 上', !String(seen[0] ?? '').startsWith('buddy/'), seen)
  t('分析本身跑通（假模型回了合法 JSON）', r.ok === true, r.error)
}

// ── llm.stream 的两种形状都得认 ────────────────────────────────
// 真宿主上 `llm.stream()` 有时**直接返回一个已经建好的 handle**（流本身），
// 不是 Promise。早先这里假定它一定是 Promise，于是对那种形状调 .then 必抛
// `TypeError: pending.then is not a function`——「整理进卡里」在 0.02 秒内
// 500，而本地所有假 llm 都写成 `async () => (async function*(){…})()`
// （永远 thenable），所以这条路上翻了车也测不出来。
{
  const answer = '{"items":[],"gaps":[],"questions":[]}'
  const handleStream = () => (async function* () {
    yield { type: 'text-delta', text: answer }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()

  // 形状一：直接给 handle（同步返回值，没有 .then）
  const directLlm = {
    listProviders: async () => [{ provider: 'raccoon', models: [{ id: 'sn-deepseek-v4-1-flash-1017' }] }],
    listModels: async () => [],
    stream: () => handleStream(),
  }
  const directTable = api.buildApi({ ...ctx, get: (n) => (n === 'llm' ? directLlm : undefined) }, async () => ws, { workspace: ws })
  const direct = await directTable['analyze.run']({ about: 'jia', name: '甲' })
  t('stream 直接给 handle 时也跑得通', direct.ok === true, direct.error)
  t('stream 直接给 handle 时能读出回复', direct.ok === true && direct.json !== undefined && direct.md !== undefined, Object.keys(direct ?? {}))

  // 形状二：给 Promise<handle>（本地假 llm 一直是这一种，别改坏了）
  const promiseLlm = {
    listProviders: async () => [{ provider: 'raccoon', models: [{ id: 'sn-deepseek-v4-1-flash-1017' }] }],
    listModels: async () => [],
    stream: async () => handleStream(),
  }
  const promiseTable = api.buildApi({ ...ctx, get: (n) => (n === 'llm' ? promiseLlm : undefined) }, async () => ws, { workspace: ws })
  const promised = await promiseTable['analyze.run']({ about: 'jia', name: '甲' })
  t('stream 给 Promise 时也跑得通', promised.ok === true, promised.error)

  // 形状三：同一路流里先来一串 reasoning-delta（模型在「想」），再来正文。
  // 真宿主就是这么发的。以前 collectStream 只看「有没有 .text」，
  // 把「想」的那几千字一起拼进了回答 → JSON 前面挂满
  // 「Thinking Process: …」→ 解析失败 → 用户点「开始读」等到五十秒后
  // 收到一句「AI 这次没给出能用的结果」。
  const thinkingLlm = {
    listProviders: async () => [{ provider: 'raccoon', models: [{ id: 'sn-deepseek-v4-1-flash-1017' }] }],
    listModels: async () => [],
    stream: async () => (async function* () {
      yield { type: 'reasoning-start' }
      yield { type: 'reasoning-delta', text: 'Thinking Process:\n\n1. Analyze the request.\n' }
      yield { type: 'reasoning-delta', text: '2. The material says he worked 37 years.\n' }
      yield { type: 'reasoning-end' }
      yield { type: 'text-delta', text: answer }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
  const thinkingTable = api.buildApi({ ...ctx, get: (n) => (n === 'llm' ? thinkingLlm : undefined) }, async () => ws, { workspace: ws })
  const thought = await thinkingTable['analyze.run']({ about: 'jia', name: '甲' })
  t('想的那一段不会被当成回答（分析照样能成）', thought.ok === true, thought.error)
  t('回答里不夹着 Thinking Process', thought.ok === true && !String(thought.raw ?? '').includes('Thinking Process'), String(thought.raw ?? '').slice(0, 80))
}

// ── 酒馆里演的一场能变成小说的一章 ────────────────────────────
// 「三扇门其实是一件事」的那一步：先在酒馆里把人立起来、把话演一遍，
// 演得满意的那一场直接变成小说的正文。这条路上有两处最容易坏：
// 一本正经地写进了错的书，或者模型什么都没写却报了成功。
{
  // 这一段会被两处用到：`tavern.toChapter` 取它当正文，`novel.chapter.review` 取它当读者的意见。
  // 开头那句是专门用来钉「模型的话在最前面、数出来的在后面」的。
  const prose = '第一句是读者的意见：她把伞推回来的时候，我没懂她要说什么。\n他把伞往门里递了递，雨顺着伞骨往下淌。'
  const proseLlm = {
    listProviders: async () => [{ provider: 'raccoon', models: [{ id: 'sn-deepseek-v4-1-flash-1017' }] }],
    listModels: async () => [],
    stream: async () => (async function* () {
      yield { type: 'text-delta', text: prose }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
  const table3 = api.buildApi({ ...ctx, get: (n) => (n === 'llm' ? proseLlm : undefined) }, async () => ws, { workspace: ws })

  const made = await table3['novel.create']({ title: '雨里的门', idea: '一个人等着另一个人开口。' })
  t('先建一本小说', made.ok === true && String(made.id ?? '') !== '', JSON.stringify(made))
  const bookId = made.id

  // 酒馆得先有一张卡。这里现建一张虚构角色，不去依赖别的测试留下的东西。
  const card = await table3['card.save']({
    path: 'people/lin.card.md',
    data: { id: 'lin', kind: 'fictional', name: '林小雨', world: 'reality' },
    sections: [{ title: '自述', body: '在旧书店做事。' }, { title: '开场白', body: '雨还没停。' }],
  })
  t('先建一张能演的角色卡', card.ok === true, JSON.stringify(card).slice(0, 160))

  const started = await table3['tavern.start']({ card: 'lin' })
  t('酒馆开得起来', started.ok === true, JSON.stringify(started).slice(0, 160))

  const said = await table3['tavern.say']({ id: started.id, text: '伞给你。' })
  t('先说一句（拿到回复）', said.ok === true, JSON.stringify(said).slice(0, 160))

  const noBook = await table3['tavern.toChapter']({ id: started.id, book: '' })
  t('没挑书就说人话', noBook.ok === false && String(noBook.error).includes('一本书'), noBook.error)

  const badBook = await table3['tavern.toChapter']({ id: started.id, book: 'no-such-book' })
  t('书不存在时说人话', badBook.ok === false && String(badBook.error).includes('这本书不在了'), badBook.error)

  const conv = await table3['tavern.toChapter']({ id: started.id, book: bookId, note: '停在她没接伞那一刻' })
  t('变成一章成功', conv.ok === true, JSON.stringify(conv).slice(0, 200))
  t('章号是 1', Number(conv.chapter) === 1, String(conv.chapter))
  t('正文就是模型写的那段', conv.ok === true && conv.text === prose)

  const ch = await table3['novel.chapter.get']({ id: bookId, index: 1 })
  t('章真的落盘了', ch.ok === true && String(ch.body ?? '').includes('伞骨'), JSON.stringify(ch).slice(0, 120))

  // 第二场再变一次：不能覆盖第一章
  const conv2 = await table3['tavern.toChapter']({ id: started.id, book: bookId })
  t('第二次变成第 2 章', Number(conv2.chapter) === 2, String(conv2.chapter))
  const ch1 = await table3['novel.chapter.get']({ id: bookId, index: 1 })
  t('第一章没被覆盖', String(ch1.body ?? '').includes('伞骨'))

  // 「挑挑毛病」= 模型当读者 + 机器顺手数一遍套话。
  // 只靠模型读，密度这种毛病它看不出来（它读的是「哪里卡住」，不是「瞳孔一缩用了几次」）。
  {
    const chapter = await table3['novel.chapter.save']({
      id: bookId,
      index: 5,
      body: [
        '此外，雨还在下。',
        '这不是等人，而是等一个说法。',
        '他瞳孔一缩。她也瞳孔一缩。',
        '命运的齿轮开始转动。',
      ].join('\n'),
    })
    t('先写一章留着挑毛病', chapter.ok === true, JSON.stringify(chapter).slice(0, 140))

    const reviewed = await table3['novel.chapter.review']({ id: bookId, index: 5 })
    t('挑毛病跑得通', reviewed.ok === true, JSON.stringify(reviewed).slice(0, 160))
    t('模型的意见还在最前面', reviewed.ok === true && String(reviewed.review).startsWith('第一句是读者的意见'), String(reviewed.review).slice(0, 60))
    t('后面接着一段数出来的', reviewed.ok === true && String(reviewed.review).includes('顺手数了一下'), String(reviewed.review).slice(-80))
    t('数出来「此外」', reviewed.ok === true && String(reviewed.review).includes('此外'), String(reviewed.review).slice(-200))
    t('数出来「命运的齿轮」', reviewed.ok === true && String(reviewed.review).includes('命运的齿轮'), String(reviewed.review).slice(-200))
    t('扫描结果单独给了，别的界面也能用', reviewed.ok === true && reviewed.scan !== undefined && reviewed.scan.total >= 3, reviewed.ok === true ? reviewed.scan.total : reviewed.error)
  }

  // 空会话不许变出一张空章
  // 没有开场白的卡才会开出「一句话都还没说」的会话
  await table3['card.save']({
    path: 'people/kong.card.md',
    data: { id: 'kong', kind: 'fictional', name: '空白', world: 'reality' },
    sections: [{ title: '自述', body: '还没写。' }],
  })
  const empty = await table3['tavern.start']({ card: 'kong' })
  const emptyConv = await table3['tavern.toChapter']({ id: empty.id, book: bookId })
  t('还没说话就变，要说人话', emptyConv.ok === false && String(emptyConv.error).includes('还什么都没说'), emptyConv.error)
}

// ── 把这一场里 TA 说过的话挑几句写回卡里 ─────────────────────────
// 「性格：沉默寡言」模型只能猜；「他说话只答半句」是能照做的。
// 这一条要真的落在卡的「对话示例」小节上，不是只回一句 ok。
{
  const picks = '- 「雨还没停，站着吧。」\n- 「伞我不要。」'
  const exLlm = {
    listProviders: async () => [{ provider: 'raccoon', models: [{ id: 'sn-deepseek-v4-1-flash-1017' }] }],
    listModels: async () => [],
    stream: async () => (async function* () {
      yield { type: 'text-delta', text: picks }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })(),
  }
  const table4 = api.buildApi({ ...ctx, get: (n) => (n === 'llm' ? exLlm : undefined) }, async () => ws, { workspace: ws })

  await table4['card.save']({
    path: 'people/yu.card.md',
    data: { id: 'yu', kind: 'fictional', name: '余', world: 'reality' },
    sections: [{ title: '自述', body: '修伞的。' }],
  })
  const opened = await table4['tavern.start']({ card: 'yu' })
  t('开一场来演', opened.ok === true, JSON.stringify(opened).slice(0, 120))

  const noTalk = await table4['tavern.toExample']({ id: opened.id })
  t('TA 还没说话时挑不出来', noTalk.ok === false && String(noTalk.error).includes('还没说过话'), noTalk.error)

  await table4['tavern.say']({ id: opened.id, text: '你在修什么？' })
  const picked = await table4['tavern.toExample']({ id: opened.id })
  t('能挑出例句', picked.ok === true && Array.isArray(picked.picked) && picked.picked.length === 2, JSON.stringify(picked).slice(0, 200))
  t('挑出来的是 TA 说过的那两句', picked.ok === true && String(picked.picked[0]).includes('雨还没停'), JSON.stringify(picked.picked))

  const card = await table4['card.get']({ path: 'people/yu.card.md' })
  const examples = (card.sections ?? []).find((x) => String(x.title ?? '') === '对话示例')
  t('写进了「对话示例」', examples !== undefined && String(examples.body).includes('伞我不要'), JSON.stringify(examples))
  t('原来别的小节一个字没动', (card.sections ?? []).some((x) => String(x.title ?? '') === '自述' && String(x.body).includes('修伞的')))

  // 再挑一次：新增的接在后面，旧的不删
  await table4['tavern.say']({ id: opened.id, text: '那把伞谁的？' })
  const again = await table4['tavern.toExample']({ id: opened.id })
  t('再挑一次也成', again.ok === true, JSON.stringify(again).slice(0, 120))
  const card2 = await table4['card.get']({ path: 'people/yu.card.md' })
  const examples2 = (card2.sections ?? []).find((x) => String(x.title ?? '') === '对话示例')
  t('旧的例句还在（不是覆盖）', String(examples2.body).split(/\r?\n/).filter((x) => x.trim() !== '').length >= 2, String(examples2.body).slice(0, 200))

  // 名字没存的会话：存不回去，要说清楚
  const ghost = await table4['tavern.toExample']({ id: 'chat-nope' })
  t('会话不在时说人话', ghost.ok === false && String(ghost.error).includes('不在了'), ghost.error)
}

// ── 「上次选的文件夹」要记得住 ──────────────────────────────────
// 以前 workspace.init 只改内存里的 config（`settings.workspace = ws`），
// 一个字节都没落盘：重启之后回落 ~/LifeCard，第二天打开又是「先挑一个文件夹」，
// 用户看到的是空库，会以为档案丢了。现在记在 dsh 的 plugin-data 里
// （跟本机其他插件同一个约定），配置里写死了就不去动它。
{
  const home = path.join(tmpdir(), 'lifecard-home-' + stamp)
  const file = api.workspacePointerFile(home)
  t('指针文件落在 plugin-data 里', file === path.join(home, 'plugin-data', 'dsh-lifecard.json'), file)
  t('还没选过的时候读出来是空的', (await api.recallWorkspace(file)) === '')
  const wrote = await api.rememberWorkspace(file, ws)
  t('记得住', wrote.ok === true, wrote)
  t('再读出来还是刚才那个', path.resolve(await api.recallWorkspace(file)) === path.resolve(ws))
  const json = JSON.parse(await fs.readFile(file, 'utf8'))
  t('存的就是一个绝对路径', typeof json.workspace === 'string' && path.isAbsolute(json.workspace), json)
  await fs.writeFile(file, '这不是 JSON', 'utf8')
  t('文件坏了就当没记过，不许抛', (await api.recallWorkspace(file)) === '')
  await fs.writeFile(file, JSON.stringify({ workspace: 42 }), 'utf8')
  t('里面不是字符串也当没记过', (await api.recallWorkspace(file)) === '')
  t('读不到的路径不会崩', (await api.recallWorkspace(path.join(home, '没有这个文件.json'))) === '')

  // 路由层：state.get 要告诉界面「现在用的是哪个」，换文件夹那页才不会
  // 永远预填 ~/LifeCard、一点就把库切走。
  const remembered = []
  const table3 = api.buildApi({}, async () => ws, {}, { remember: async (w) => { remembered.push(w); return { ok: true } } })
  const st3 = await table3['state.get']({})
  t('state.get 说的就是现在这个库', path.resolve(st3.defaults.workspace) === path.resolve(ws), st3.defaults)
  const init3 = await table3['workspace.init']({ workspace: ws })
  t('切换成功', init3.ok === true, init3)
  t('切完把新位置记下来了', remembered.length === 1 && path.resolve(remembered[0]) === path.resolve(ws), remembered)
  t('记下来了就照实说', init3.remembered === true, init3)

  // 记不住不算失败：库已经能用了，只是下次还得再选一遍。
  const table4 = api.buildApi({}, async () => ws, {}, { remember: async () => ({ ok: false }) })
  const init4 = await table4['workspace.init']({ workspace: ws })
  t('记不住也照样能开始用', init4.ok === true, init4)
  t('记不住要照实说（界面据此提醒下次还得选）', init4.remembered === false, init4)
}

// ── 重启之后还记得上次选的文件夹 ────────────────────────────────
// 这条是「开始用」这一步唯一会被用户当成「档案丢了」的地方：以前选完只改内存，
// 宿主一重启就回落 ~/LifeCard，第二天打开是一张卡都没有的库。
// 这里走真路由（apply 注册出来的 handler），不是直接调函数。
{
  const home = path.join(tmpdir(), 'lifecard-home-apply-' + stamp)
  const ws2 = path.join(tmpdir(), 'lifecard-ws-apply-' + stamp)
  const ws3 = path.join(tmpdir(), 'lifecard-ws-third-' + stamp)
  await fs.mkdir(path.join(home, 'plugin-data'), { recursive: true })
  await fs.mkdir(ws2, { recursive: true })
  await fs.mkdir(ws3, { recursive: true })
  await api.rememberWorkspace(path.join(home, 'plugin-data', 'dsh-lifecard.json'), ws2)

  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  let handler = null
  const ctx3 = {
    webServer: { register: (spec) => { handler = spec.handler; return () => {} } },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    get: () => undefined,
    logger: { warn: () => {} },
  }
  const post = async (method, body, extra = {}) => {
    let status = 0
    let text = ''
    const res = {
      writeHead: (code) => { status = code },
      end: (b) => { text = String(b ?? '') },
    }
    const payload = typeof extra.raw === 'string' ? extra.raw : JSON.stringify(body ?? {})
    // 真客户端是 fetch(..., {headers:{'content-type':'application/json'}})，
    // 路由那两道闸（只收 JSON、Origin 同源）得照着真实请求来测。
    const headers = { 'content-type': 'application/json', ...(extra.headers ?? {}) }
    const req = {
      method: 'POST',
      url: `/api/dsh-lifecard/${method}`,
      headers,
      async *[Symbol.asyncIterator]() {
        if (extra.noChunks === true) return
        yield Buffer.from(payload)
      },
      on: (event, fn) => { if (event === 'end') fn(); if (event === 'data') fn(Buffer.from(payload)) },
    }
    await handler(req, res)
    return { status, body: text === '' ? null : JSON.parse(text) }
  }

  try {
    api.apply(ctx3, {})
    const st = await post('state.get', {})
    t('重启之后接着用上次选的文件夹', path.resolve(st.body?.workspace ?? '') === path.resolve(ws2), st.body)
    t('换文件夹那一页预填的也是这个', path.resolve(st.body?.defaults?.workspace ?? '') === path.resolve(ws2), st.body?.defaults)

    // 再换一个：这一次要真的写进指针文件，下一次 apply 才有得读。
    const moved = await post('workspace.init', { workspace: ws3 })
    t('换文件夹成功', moved.body?.ok === true, moved.body)
    const pointer = JSON.parse(await fs.readFile(path.join(home, 'plugin-data', 'dsh-lifecard.json'), 'utf8'))
    t('换完把新位置写进指针文件', path.resolve(pointer.workspace) === path.resolve(ws3), pointer)

    // 配置里写死了就以配置为准：别人的 cordis.yml 不会被这个指针改掉。
    // （ctx3.webServer.register 每次都把 handler 换成最新注册的那个。）
    api.apply(ctx3, { workspace: ws })
    const st2 = await post('state.get', {})
    t('配置写死了就听配置的', path.resolve(st2.body?.workspace ?? '') === path.resolve(ws), st2.body)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
}

// ── 兜底 catch 要留下事发现场 ──────────────────────────────────────
// 桌面版把插件进程的 stdout 丢进 /dev/null。出过一次「分析永远 500」的
// 事故：界面上只有一句人话，日志里什么都没有，只能靠猜。所以兜底 catch
// 除了回人话，还得把 stack 落一份到文件里。
{
  const logFile = path.join(tmpdir(), 'dsh-lifecard-errors.log')
  let saved = ''
  try { saved = await fs.readFile(logFile, 'utf8') } catch { /* 本来就没有 */ }
  try { await fs.rm(logFile, { force: true }) } catch { /* 忽略 */ }

  let handler = null
  const ctxLog = {
    webServer: { register: (spec) => { handler = spec.handler; return () => {} } },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
    get: () => undefined,
  }
  // maxBodyMB 压到 1：发一份 1.5MB 的请求体，readBody 一定抛。
  api.apply(ctxLog, { workspace: ws, maxBodyMB: 1 })
  let status = 0
  let text = ''
  const res = {
    writeHead: (code) => { status = code },
    end: (b) => { text = String(b ?? '') },
  }
  const big = JSON.stringify({ pad: 'x'.repeat(1500 * 1024) })
  const req = {
    method: 'POST',
    url: '/api/dsh-lifecard/state.get',
    headers: { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(big) },
    on: (event, fn) => { if (event === 'end') fn(); if (event === 'data') fn(Buffer.from(big)) },
  }
  await handler(req, res)
  // 落日志是「别挡住回话」的写法（不 await），所以这里等一下文件落盘
  await new Promise((r) => setTimeout(r, 60))
  t('请求体太大时给 500，不是崩掉', status === 500, `${status} ${text.slice(0, 80)}`)
  t('返回的还是人话，不是英文异常', /[\u4e00-\u9fa5]/.test(text), text.slice(0, 200))

  let logged = ''
  try { logged = await fs.readFile(logFile, 'utf8') } catch (e) { logged = '<读不到：' + e.message + '>' }
  t('出错时把现场写进了文件', logged.includes('state.get'), logged.slice(0, 200))
  t('文件里带着 stack（不是一句话）', /at .+:\d+:\d+/.test(logged), logged.slice(0, 300))

  // 恢复现场：别把测试制造的这条留在那台机器的 /tmp 里
  try { await fs.rm(logFile, { force: true }) } catch { /* 忽略 */ }
  if (saved !== '') { try { await fs.writeFile(logFile, saved, 'utf8') } catch { /* 忽略 */ } }
}

console.log('\n=== card.fork：拿现实里的卡复制一份来演 ===')
{
  // 酒馆里「拿现实里的人来演」必须是一份独立的副本。共用同一个文件的话，
  // 演一场把性格改成完全相反，现实那张记录就被改写了——这是这个功能
  // 最容易出事的地方，所以按文件内容钉死。
  const src = 'people/fork-src.card.md'
  const madeSrc = await table['card.save']({
    path: src,
    data: baseCard({ id: 'fork-src', name: '老周', relation: '同事', address: '周哥' }),
    sections: [{ title: '自述', body: '〔自述〕他在厂里干了二十年。' }],
  })
  t('先建一张现实里的卡', madeSrc.ok === true, madeSrc)

  const first = await table['card.fork']({ path: src })
  t('card.fork 成功', first.ok === true, first)
  t('复制出来的是另一份文件', first.path !== src, first)
  t('复制出来的 id 带 -role', String(first.id).startsWith('fork-src-role'), first)
  t('名字不变（演的还是这个人）', first.name === '老周', first)

  const copied = await store.readCard(ws, first.path)
  t('复制出来的卡读得回来', copied.ok === true, copied)
  t('复制出来的卡是虚构角色', copied.data?.kind === 'fictional', copied.data?.kind)
  t('复制出来的卡记着从谁那儿来的', copied.data?.forked_from === src, copied.data?.forked_from)
  t('正文一起复制过去', JSON.stringify(copied.sections ?? []).includes('纱厂') || JSON.stringify(copied.sections ?? []).includes('厂里干了二十年'), copied.sections)

  // 改副本不该动到原卡
  const changed = await table['card.save']({
    path: first.path,
    data: { ...copied.data, name: '老周（热情版）', address: '周哥' },
    sections: [{ title: '自述', body: '〔自述〕他一进门就跟所有人打招呼。' }],
  })
  t('副本能改', changed.ok === true, changed)
  const after = await store.readCard(ws, src)
  t('改副本之后原卡一个字都没变', after.data?.name === '老周' && JSON.stringify(after.sections ?? []).includes('厂里干了二十年'), [after.data?.name, after.sections])

  // 同一张卡可以复制好几份，不许互相覆盖
  const second = await table['card.fork']({ path: src })
  t('再复制一份还是成功', second.ok === true, second)
  t('第二份换了文件名，没覆盖第一份', second.path !== first.path, [first.path, second.path])

  const missing = await table['card.fork']({ path: 'people/nobody.card.md' })
  t('找不到的卡说人话', missing.ok === false && String(missing.error).includes('找不到'), missing)
}

console.log('\n=== 16. 复制来演：小设定要留下、来路不带家目录 ===')
{
  const src = 'people/lao-zhang.card.md'
  await store.writeCard(ws, src, {
    lifecard: '0.1', id: 'lao-zhang', kind: 'real', world: 'reality', name: '老张',
    cc: { spec: 'chara_card_v2', source_file: 'laozhang.png', fields: { character_book: { entries: [{ keys: ['茶馆'], content: '镇上有家老茶馆。' }] } } },
  }, [{ title: '自述', body: '话不多的人。' }])

  const forked = await table['card.fork']({ path: src })
  t('复制成功', forked.ok === true, forked)
  const copy = await store.readCard(ws, forked.path)
  t('副本读得回来', copy.ok === true, copy.error ?? copy.ok)
  const book = copy.data?.cc?.fields?.character_book
  t('卡里自带的小设定一条没丢', Array.isArray(book?.entries) && book.entries.length === 1, copy.data?.cc)
  t('来路标记被清掉了（不再指着原图）', copy.data?.cc?.source_file === undefined && copy.data?.cc?.spec === undefined, copy.data?.cc)
  t('来路记的是相对路径，不是 /Users/…', String(copy.data?.forked_from ?? '').startsWith('people/'), copy.data?.forked_from)

  // 第 41 次复制要说人话，不能盖掉别人
  const many = await table['card.fork']({ path: src })
  t('再复制一份换号不覆盖', many.ok === true && many.path !== forked.path, [forked.path, many.path])
}

console.log('\n=== 17. card.save 漏传 sections 不许把正文清空 ===')
{
  const rel = 'people/keep-body.card.md'
  await store.writeCard(ws, rel, { lifecard: '0.1', id: 'keep-body', kind: 'real', world: 'reality', name: '留字的人' }, [
    { title: '自述', body: '这段话不能因为一次保存就没了。' },
  ])
  const before = await store.readCard(ws, rel)
  const posted = await table['card.save']({ path: rel, data: { ...before.data, name: '留字的人' } })
  t('保存成功', posted.ok === true, posted)
  const after = await store.readCard(ws, rel)
  t('正文还在', after.ok === true && after.sections.some((x) => String(x.body).includes('不能因为一次保存就没了')), after.sections)
}

console.log('\n=== 18. 同名世界书不再原地覆盖 ===')
{
  const worldJson = (name) => Buffer.from(JSON.stringify({ name, entries: { 0: { uid: 0, key: ['雾'], keysecondary: [], comment: '', content: `${name}的条目`, constant: false, selective: true, insertion_order: 10, enabled: true } } }), 'utf8').toString('base64')
  const first = await table['import.cards']({ files: [{ name: 'a.json', base64: worldJson('雾港') }] })
  const second = await table['import.cards']({ files: [{ name: 'b.json', base64: worldJson('雾港') }] })
  t('第一本导进来了', first.ok === true && Array.isArray(first.results), first)
  const p1 = first.results?.[0]?.path
  const p2 = second.results?.[0]?.path
  t('第二本另存一份，不覆盖第一本', typeof p1 === 'string' && typeof p2 === 'string' && p1 !== p2, [p1, p2])
  const one = await store.readCard(ws, String(p1))
  t('第一本还在、条目没被换掉', one.ok === true && one.text.includes('雾港的条目'), one.ok)
}

console.log('\n=== 19. 别的网页不能偷偷动档案 ===')
{
  let handler = null
  const ctx3 = {
    webServer: { register: (options) => { handler = options.handler; return () => {} } },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
    get: () => undefined,
  }
  api.apply(ctx3, { workspace: ws })
  const send = async (method, body, headers) => {
    let status = 0
    let text = ''
    const res = { writeHead: (c) => { status = c }, end: (b) => { text = String(b ?? '') } }
    const payload = JSON.stringify(body ?? {})
    const req = {
      method: 'POST',
      url: `/api/dsh-lifecard/${method}`,
      headers,
      async *[Symbol.asyncIterator]() { yield Buffer.from(payload) },
      on: () => {},
    }
    await handler(req, res)
    return { status, body: text === '' ? null : JSON.parse(text) }
  }

  const plain = await send('state.get', {}, { 'content-type': 'text/plain' })
  t('不是 JSON 的请求一律不收（浏览器跨站发不出 JSON）', plain.status === 415, plain.status)
  const cross = await send('state.get', {}, { 'content-type': 'application/json', origin: 'https://evil.example', host: '127.0.0.1:50084' })
  t('别家网页来的请求挡掉', cross.status === 403, cross.status)
  const same = await send('state.get', {}, { 'content-type': 'application/json', origin: 'http://127.0.0.1:50084', host: '127.0.0.1:50084' })
  t('自己的界面照旧能用', same.status === 200 && same.body?.ok === true, same.status)
  const bare = await send('state.get', {}, { 'content-type': 'application/json' })
  t('不带 Origin 的本地调用也照旧能过', bare.status === 200, bare.status)
}

console.log('\n=== 20. 请求体里指定的 workspace 不能换库 ===')
{
  const other = path.join(tmpdir(), 'lifecard-other-' + stamp)
  await fs.mkdir(path.join(other, 'materials'), { recursive: true })
  await fs.writeFile(path.join(other, 'materials', '别人的素材.md'), '不该被看到', 'utf8')
  const peek = await table['workspace.list']({ workspace: other })
  t('用别的路径当 workspace 也只在当前库里找', JSON.stringify(peek).includes('别人的素材') === false, String(peek).slice(0, 200))
}

console.log('\n=== 21. 虚构角色的完成度不把「关系/出生年/同意」算进去 ===')
{
  const data = { lifecard: '0.1', id: 'lin', kind: 'fictional', world: 'reality', name: '林小雨' }
  const sections = [{ title: '自述', body: '爱笑，话密。' }, { title: '口癖', body: '老说「就是说」。' }]
  const realCov = core.coverage({ ...data, kind: 'real' }, sections)
  const ficCov = core.coverage(data, sections)
  t('真人的表里有关系那一项', realCov.rows.some((r) => r.key === 'relation'), realCov.rows.map((r) => r.key))
  t('虚构角色的表里没有关系/出生年/同意状态', ['relation', 'birth_year', 'consent'].every((k) => !ficCov.rows.some((r) => r.key === k)), ficCov.rows.map((r) => r.key))
  t('虚构角色的「还空着」里也不会出现关系', (ficCov.empty ?? []).every((r) => !['关系', '出生年', '同意状态'].includes(r.label)), (ficCov.empty ?? []).map((r) => r.label))
  t('虚构角色的完成度因此能顶到 100%', ficCov.percent >= realCov.percent, [ficCov.percent, realCov.percent])
}

console.log('\n=== 22. 三扇门各自「现在用哪张卡」存得住 ===')
{
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-pins-'))
  await store.openWorkspace(ws)
  const table = api.buildApi({ get: () => undefined }, async () => ws, {})
  const first = await table['card.defaults.get']({})
  t('没设过时三扇门都是空的', first.ok === true && first.cards.real === '' && first.cards.tavern === '' && first.cards.novel === '', JSON.stringify(first))
  const set = await table['card.defaults.set']({ mode: 'tavern', id: 'lin' })
  t('能记住酒馆这扇门用谁', set.ok === true && set.cards.tavern === 'lin', JSON.stringify(set))
  const back = await table['card.defaults.get']({})
  t('再读出来还是那一张', back.cards.tavern === 'lin', JSON.stringify(back))
  t('别的门没被顺手改掉', back.cards.real === '' && back.cards.novel === '', JSON.stringify(back))
  const cfg = await store.readConfig(ws)
  t('写进的是这个文件夹的 config.json', cfg?.default_cards?.tavern === 'lin', JSON.stringify(cfg?.default_cards))
  const bad = await table['card.defaults.set']({ mode: 'nope', id: 'lin' })
  t('不认识的门直接拒绝', bad.ok === false && String(bad.error).includes('哪扇门'), JSON.stringify(bad))
  const other = await api.buildApi({ get: () => undefined }, async () => ws, {})['card.defaults.set']({ mode: 'novel', id: 'a' })
  t('再换一本「写小说」的那张', other.ok === true && other.cards.novel === 'a' && other.cards.tavern === 'lin', JSON.stringify(other))
  await fs.rm(ws, { recursive: true, force: true })
}

console.log('\n=== 22b. 三扇门能收起来、也能装回来 ===')
{
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-doors-'))
  await store.openWorkspace(ws)
  const table = api.buildApi({ get: () => undefined }, async () => ws, {})
  const before = await table['state.get']({})
  t('一开始一扇都没收', Array.isArray(before.hidden_doors) && before.hidden_doors.length === 0, JSON.stringify(before.hidden_doors))
  const hid = await table['door.set']({ id: 'tavern', hidden: true })
  t('能把酒馆收起来', hid.ok === true && hid.hidden_doors.includes('tavern'), JSON.stringify(hid))
  const after = await table['state.get']({})
  t('state.get 也说它被收了', after.hidden_doors.includes('tavern'), JSON.stringify(after.hidden_doors))
  const cfg = await store.readConfig(ws)
  t('写进了这个文件夹的设置', Array.isArray(cfg?.hidden_doors) && cfg.hidden_doors.includes('tavern'), JSON.stringify(cfg?.hidden_doors))
  const back = await table['door.set']({ id: 'tavern', hidden: false })
  t('也能装回来', back.ok === true && !back.hidden_doors.includes('tavern'), JSON.stringify(back))
  const bad = await table['door.set']({ id: 'nope', hidden: true })
  t('不认识的门直接拒绝', bad.ok === false && String(bad.error).includes('哪扇门'), JSON.stringify(bad))
  await table['door.set']({ id: 'novel', hidden: true })
  await table['door.set']({ id: 'tavern', hidden: true })
  const two = await table['door.set']({ id: 'real', hidden: true })
  t('三扇门全收起来会被拦住', two.ok === false && String(two.error).includes('至少留一扇'), JSON.stringify(two))
  await table['door.set']({ id: 'tavern', hidden: false })
  const again = await table['door.set']({ id: 'novel', hidden: true })
  t('收两次不会重复记', again.ok === true && again.hidden_doors.filter((x) => x === 'novel').length === 1, JSON.stringify(again.hidden_doors))
  // 收门只是界面开关：卡一个字节都不能少
  await store.writeCard(ws, 'people/keep.card.md', { lifecard: '0.1', id: 'keep', kind: 'fictional', world: 'reality', name: '留着' }, [{ title: '自述', body: '还在。' }])
  await table['door.set']({ id: 'tavern', hidden: true })
  const cards = await table['workspace.list']({})
  t('收门不影响卡', cards.ok === true && (cards.cards ?? []).some((c) => c.id === 'keep'), JSON.stringify((cards.cards ?? []).length))
  await fs.rm(ws, { recursive: true, force: true })
}

console.log('\n=== 23. 文本角色卡（.txt）也能导进来 ===')
{
  const ws = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-txt-'))
  const table = api.buildApi({ get: () => undefined }, async () => ws, {})
  const txt = [
    '名字：陈默',
    '性格：话少，说了就做',
    '背景：在城南开一家修表铺',
    '开场白：修表铺的灯是黄色的。',
  ].join('\n')
  const one = await table['import.cards']({ files: [{ name: '陈默.txt', base64: Buffer.from(txt, 'utf8').toString('base64') }] })
  t('文本卡导入成功', one.ok === true && one.imported === 1, JSON.stringify(one).slice(0, 200))
  const row = one.results[0] ?? {}
  t('落成了卡文件', typeof row.path === 'string' && row.path.endsWith('.card.md'), row.path)
  t('名字对', row.title === '陈默', row.title)
  const read = await store.readCard(ws, row.path)
  t('读回来有性格和开场白', read.ok === true && String(read.sections.find((x) => x.title === '性格')?.body ?? '').includes('话少'), read.ok)

  const prose = await table['import.cards']({ files: [{ name: '散文.txt', base64: Buffer.from('他坐在院子里修一把旧椅子。\n天快黑了。', 'utf8').toString('base64') }] })
  t('没有字段的 txt 也整份收进来，不会卡在「读不进去」', prose.imported === 1 && (prose.results[0]?.path ?? '').endsWith('.card.md'), JSON.stringify(prose.results[0]).slice(0, 160))
  await fs.rm(ws, { recursive: true, force: true })
}

console.log('\n=== 24. 撤掉的卡：列表看得到、能恢复、能彻底删 ===')
{
  // 单独一个工作区，不依赖前面各组留下的东西。
  const ws2 = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-withdrawn-'))
  const table2 = api.buildApi({ get: () => undefined }, async () => ws2, {})

  const made = await table2['card.save']({
    path: 'people/old.card.md',
    data: { lifecard: '0.1', id: 'old', kind: 'real', world: 'reality', name: '旧人' },
    sections: [{ title: '自述', body: '会被删掉的人。' }],
  })
  t('先建一张卡', made.ok === true, JSON.stringify(made).slice(0, 160))

  const before = await table2['workspace.list']({})
  t('列表一开始就带着「已经撤掉的」这一栏', Array.isArray(before.withdrawn) && before.withdrawn.length === 0, before.withdrawn)

  const del = await table2['card.delete']({ path: 'people/old.card.md' })
  t('删除成功', del.ok === true, JSON.stringify(del).slice(0, 200))
  t('删除的回话告诉你去哪儿找回', String(del.note).includes('已经撤掉的') && !String(del.note).includes('撤回'), del.note)

  const listed = await table2['workspace.list']({})
  t('删掉之后不在正常列表里', listed.cards.every((c) => c.path !== 'people/old.card.md'), listed.cards.map((c) => c.path))
  const row = (listed.withdrawn ?? []).find((x) => x.path === 'people/old.card.md')
  t('列表里多出「已经撤掉的」这一条', row !== undefined, listed.withdrawn)
  t('那一条带着名字和编号', row?.name === '旧人' && row?.id === 'old', row)

  const gone = await table2['card.get']({ path: 'people/old.card.md' })
  t('撤掉的卡打不开', gone.ok === false, JSON.stringify(gone).slice(0, 160))
  t('打不开时说的是人话，还给指了回来的路', String(gone.error).includes('恢复'), gone.error)

  // 恢复：不需要版本号，直接救回列表。
  const back = await table2['card.restore']({ path: 'people/old.card.md' })
  t('不带版本号就是恢复撤掉的卡', back.ok === true, JSON.stringify(back).slice(0, 200))
  const reopened = await table2['card.get']({ path: 'people/old.card.md' })
  t('恢复后打得开', reopened.ok === true && reopened.data?.name === '旧人', reopened.error ?? reopened.data?.name)
  t('恢复以后不再带「撤掉了」的标记', reopened.withdrawn !== true, reopened)
  const after = await table2['workspace.list']({})
  t('恢复后不在「已经撤掉的」里', (after.withdrawn ?? []).every((x) => x.path !== 'people/old.card.md'), after.withdrawn)

  const liveRestore = await table2['card.restore']({ path: 'people/old.card.md' })
  t('活卡不能恢复', liveRestore.ok === false && String(liveRestore.error).includes('没有被撤掉'), JSON.stringify(liveRestore))

  // 彻底删：活卡一律拒绝，只有撤掉的才让删。
  const purgeLive = await table2['card.purge']({ path: 'people/old.card.md' })
  t('活卡不许彻底删', purgeLive.ok === false && String(purgeLive.error).includes('还在列表里'), JSON.stringify(purgeLive))
  t('活卡被拒之后文件还在', await fs.access(path.join(ws2, 'people/old.card.md')).then(() => true).catch(() => false))

  const purgeMaterial = await table2['card.purge']({ path: 'materials/x.md' })
  t('不是卡片文件不给删', purgeMaterial.ok === false, JSON.stringify(purgeMaterial))

  await table2['card.delete']({ path: 'people/old.card.md' })
  const purged = await table2['card.purge']({ path: 'people/old.card.md' })
  t('撤掉的卡可以彻底删', purged.ok === true, JSON.stringify(purged).slice(0, 200))
  t('彻底删真删了文件', (await fs.stat(path.join(ws2, 'people/old.card.md')).catch(() => null)) === null)
  const dead = await table2['card.get']({ path: 'people/old.card.md' })
  t('彻底删之后再打开是「文件不存在」', dead.ok === false && String(dead.error).includes('文件不存在'), dead.error)
  t('「已经撤掉的」里也清掉了', ((await table2['workspace.list']({})).withdrawn ?? []).every((x) => x.path !== 'people/old.card.md'))

  // 越界：新路由也得钉在工作区里。
  const evil = '../' + path.basename(inside) + '/people/pwned.card.md'
  const evilRestore = await table2['card.restore']({ path: evil })
  t('card.restore 拒绝越界', badPath(evilRestore), evilRestore)
  const evilPurge = await table2['card.purge']({ path: evil })
  t('card.purge 拒绝越界', badPath(evilPurge), evilPurge)
  t('越界那边没有可删的文件', await fs.access(path.join(inside, 'people', 'pwned.card.md')).then(() => true).catch(() => false) === false)

  // 带版本号还是老行为：退回历史版本，不许被「恢复撤掉的卡」抢走。
  await table2['card.save']({
    path: 'people/hist.card.md',
    data: { lifecard: '0.1', id: 'hist', kind: 'real', world: 'reality', name: '旧版人' },
    sections: [{ title: '自述', body: '第一版。' }],
  })
  await table2['card.save']({
    path: 'people/hist.card.md',
    data: { lifecard: '0.1', id: 'hist', kind: 'real', world: 'reality', name: '新版人' },
    sections: [{ title: '自述', body: '第二版。' }],
  })
  const history = await table2['card.history']({ path: 'people/hist.card.md' })
  const oldest = (history.versions ?? []).at(-1)?.stamp
  const rolled = await table2['card.restore']({ path: 'people/hist.card.md', stamp: oldest })
  const histCard = await store.readCard(ws2, 'people/hist.card.md')
  t('带版本号仍然退回历史版本', rolled.ok === true && String(histCard?.sections?.find((x) => x.title === '自述')?.body ?? '').includes('第一版'), { rolled, stamp: oldest })
  await fs.rm(ws2, { recursive: true, force: true })
}


console.log('\n=== 25. 删掉的卡要真的让出名字和门 ===')
{
  const ws3 = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-redacted-'))
  const table3 = api.buildApi({ get: () => undefined }, async () => ws3, {})
  const people = path.join(ws3, 'people')
  const trash = path.join(ws3, '.lifecard/redacted/people')

  const gone = await table3['card.save']({
    path: 'people/gone.card.md',
    data: { lifecard: '0.1', id: 'gone', kind: 'real', world: 'reality', name: '走掉的人' },
    sections: [{ title: '自述', body: '会被删掉的人。' }],
  })
  const keep = await table3['card.save']({
    path: 'people/keep.card.md',
    data: { lifecard: '0.1', id: 'keep', kind: 'real', world: 'reality', name: '留着的人' },
    sections: [{ title: '自述', body: '不删的人。' }],
  })
  t('两张卡都建好了', gone.ok === true && keep.ok === true, { gone, keep })

  await table3['card.defaults.set']({ mode: 'tavern', id: 'gone' })
  await table3['card.defaults.set']({ mode: 'real', id: 'keep' })
  t('酒馆那扇门先挑的是要被删的那张', api.buildPersonaSection(ws3, 'tavern').includes('走掉的人'))

  const del = await table3['card.delete']({ path: 'people/gone.card.md' })
  t('删除成功', del.ok === true, JSON.stringify(del).slice(0, 200))
  const stillThere = await fs.stat(path.join(people, 'gone.card.md')).then(() => true).catch(() => false)
  t('删掉之后 people 里没有这个文件了', stillThere === false)
  const names = await fs.readdir(people).catch(() => [])
  t('readdir 里也不再出现它（不是靠墓碑过滤出来的）', names.every((n) => n !== 'gone.card.md'), names)
  const inTrash = await fs.stat(path.join(trash, 'gone.card.md')).then((st) => st.isFile()).catch(() => false)
  t('回收目录里有它，原文没丢', inTrash === true)
  const listed = await table3['workspace.list']({})
  t('列表「已经撤掉的」里能看到它', (listed.withdrawn ?? []).some((x) => x.path === 'people/gone.card.md' && x.name === '走掉的人'), listed.withdrawn)

  const pins = await table3['card.defaults.get']({})
  t('酒馆那扇门不再指着删掉的卡', String(pins.cards?.tavern ?? '') === '', pins)
  t('别的门不受影响', String(pins.cards?.real ?? '') === 'keep', pins)
  t('删掉以后酒馆那扇门拼不出东西', api.buildPersonaSection(ws3, 'tavern') === '', api.buildPersonaSection(ws3, 'tavern').slice(0, 80))
  t('现实那扇门照旧', api.buildPersonaSection(ws3, 'real').includes('留着的人'))

  const again = await table3['card.save']({
    data: { lifecard: '0.1', id: 'gone', kind: 'real', world: 'reality', name: '走掉的人' },
    sections: [{ title: '自述', body: '同名再建一次。' }],
  })
  t('同名再建被挡住，说的是人话', again.ok === false && String(again.error).includes('被一张已经删掉的卡占着'), again)
  t('挡住新卡的是一条撤掉的记录，返回体也带标记', again.ok === false && again.withdrawn === true, again)

  // 老式的账：文件还在原地、只写了墓碑。这种人也不能被注入进 system prompt。
  await table3['card.save']({
    path: 'people/legacy.card.md',
    data: { lifecard: '0.1', id: 'legacy', kind: 'real', world: 'reality', name: '老账里的人' },
    sections: [{ title: '自述', body: '原位还留着。' }],
  })
  await table3['card.defaults.set']({ mode: 'novel', id: 'legacy' })
  const legacyText = await fs.readFile(path.join(people, 'legacy.card.md'), 'utf8')
  await store.appendRedaction(ws3, { path: 'people/legacy.card.md', sha256: store.sha256(legacyText), reason: '用户删除' })
  t('原位还在的撤掉卡也不进 system prompt', api.buildPersonaSection(ws3, 'novel') === '', api.buildPersonaSection(ws3, 'novel').slice(0, 80))

  // readCard 的两条「已撤掉」分支必须长一个样：一条是文件已经搬进回收目录、
  // 原位 ENOENT；一条是文件还在原位、只是账上记着撤掉（老式记录）。以前只有
  // 前者带 withdrawn:true，上层拿这个字段决定「给不给恢复入口」时就漏了一半。
  const movedRead = await store.readCard(ws3, 'people/gone.card.md')
  const legacyRead = await store.readCard(ws3, 'people/legacy.card.md')
  t('搬走的那张打不开', movedRead.ok === false, JSON.stringify(movedRead).slice(0, 200))
  t('原位还在的那张也打不开', legacyRead.ok === false, JSON.stringify(legacyRead).slice(0, 200))
  t('搬走的那张带着「撤掉了」这个标记', movedRead.withdrawn === true, movedRead)
  t('原位还在的那张也带同一个标记', legacyRead.withdrawn === true, legacyRead)
  t('两条分支的返回形状一样', Object.keys(movedRead).sort().join(',') === Object.keys(legacyRead).sort().join(','), { moved: Object.keys(movedRead).sort(), legacy: Object.keys(legacyRead).sort() })
  t('两条分支的说法一字不差', String(movedRead.error) === String(legacyRead.error), { moved: movedRead.error, legacy: legacyRead.error })
  t('两处都提到「撤掉」、都说了怎么找回来', [movedRead.error, legacyRead.error].every((x) => String(x).includes('撤掉') && String(x).includes('恢复')), [movedRead.error, legacyRead.error])
  t('两处都不出现「撤回」这个词', [movedRead.error, legacyRead.error].every((x) => !String(x).includes('撤回')), [movedRead.error, legacyRead.error])
  const legacyRoute = await table3['card.get']({ path: 'people/legacy.card.md' })
  t('走路由也一样带着标记', legacyRoute.ok === false && legacyRoute.withdrawn === true, JSON.stringify(legacyRoute).slice(0, 200))

  // 撤着的卡不许直接退回旧版本：那会把文件写回原位，而它照样不在列表里。
  await table3['card.save']({
    path: 'people/hist2.card.md',
    data: { lifecard: '0.1', id: 'hist2', kind: 'real', world: 'reality', name: '有版本的人' },
    sections: [{ title: '自述', body: '第一版。' }],
  })
  await table3['card.save']({
    path: 'people/hist2.card.md',
    data: { lifecard: '0.1', id: 'hist2', kind: 'real', world: 'reality', name: '有版本的人' },
    sections: [{ title: '自述', body: '第二版。' }],
  })
  const hist = await table3['card.history']({ path: 'people/hist2.card.md' })
  const anyStamp = (hist.versions ?? []).at(-1)?.stamp
  t('先攒出一个旧版本', typeof anyStamp === 'string' && anyStamp !== '', hist)
  await table3['card.delete']({ path: 'people/hist2.card.md' })
  const blockedVersion = await table3['card.restore']({ path: 'people/hist2.card.md', stamp: anyStamp })
  t('撤掉的卡不能直接退回旧版本', blockedVersion.ok === false && String(blockedVersion.error).includes('撤掉的状态'), blockedVersion)
  t('这一条也带 withdrawn，跟读卡那两条一个形', blockedVersion.ok === false && blockedVersion.withdrawn === true, blockedVersion)
  t('而且没有偷偷把文件写回列表', (await table3['workspace.list']({})).cards.every((x) => x.path !== 'people/hist2.card.md'))

  // 放回列表以后再退版本，就不该被当成「还撤着」拦下来。
  const backAgain = await table3['card.restore']({ path: 'people/hist2.card.md' })
  t('先放回列表', backAgain.ok === true, JSON.stringify(backAgain).slice(0, 200))
  const versionNow = await table3['card.restore']({ path: 'people/hist2.card.md', stamp: anyStamp })
  t('恢复之后带版本号调不会被误判', versionNow.ok === true && versionNow.withdrawn !== true, JSON.stringify(versionNow).slice(0, 200))

  const purged = await table3['card.purge']({ path: 'people/gone.card.md' })
  t('彻底删成功', purged.ok === true, JSON.stringify(purged).slice(0, 200))
  const trashLeft = await fs.stat(path.join(trash, 'gone.card.md')).then(() => true).catch(() => false)
  t('回收目录里也清了', trashLeft === false)
  const afterPurgeRead = await store.readCard(ws3, 'people/gone.card.md')
  t('彻底删掉之后不再挂着「撤掉了」的标记', afterPurgeRead.ok === false && afterPurgeRead.withdrawn !== true, afterPurgeRead)
  t('彻底删掉之后说的是「文件不存在」', String(afterPurgeRead.error).includes('文件不存在'), afterPurgeRead.error)

  const rebuilt = await table3['card.save']({
    data: { lifecard: '0.1', id: 'gone', kind: 'real', world: 'reality', name: '走掉的人' },
    sections: [{ title: '自述', body: '清掉之后重建。' }],
  })
  t('清掉之后能用同一个名字重建', rebuilt.ok === true, JSON.stringify(rebuilt).slice(0, 200))

  // 提案采纳：卡被删掉的时候不许「复活」出一张同名的。
  const mat = await store.appendMaterial(ws3, '家人', '他说家里人都好，家人最重要。\n')
  const proposal = {
    about: { id: 'prop', name: '提案里的人', kind: 'real', world: 'reality' },
    items: [{ field: 'tags', value: '家人', source_level: '自述', evidence: { material: mat.path, quote: '家人最重要' } }],
  }
  const saved = await store.saveProposal(ws3, 'prop', proposal, { [mat.path]: await fs.readFile(path.join(ws3, mat.path), 'utf8') })
  t('提案存下来了', saved.ok !== false && saved.accepted === 1, saved)
  await table3['card.save']({
    path: 'people/prop.card.md',
    data: { lifecard: '0.1', id: 'prop', kind: 'real', world: 'reality', name: '提案里的人' },
    sections: [],
  })
  await table3['card.delete']({ path: 'people/prop.card.md' })
  const revive = await table3['proposal.apply']({ json: saved.json, checked: [0] })
  t('删掉的卡不会被提案悄悄复活', revive.ok === false && String(revive.error).includes('删过一次'), JSON.stringify(revive).slice(0, 240))
  t('而且确实没有建出新文件', await fs.stat(path.join(people, 'prop.card.md')).then(() => false).catch(() => true))
  await table3['card.purge']({ path: 'people/prop.card.md' })
  const afterPurge = await table3['proposal.apply']({ json: saved.json, checked: [0] })
  t('清掉之后提案可以照常建卡', afterPurge.ok === true, JSON.stringify(afterPurge).slice(0, 240))

  // 访谈开局建错了的空卡：能收走，而且不留墓碑占名字。
  const fresh = await table3['card.save']({
    path: 'people/fresh.card.md',
    data: { lifecard: '0.1', id: 'fresh', kind: 'real', world: 'reality', name: '空卡' },
    sections: [],
  })
  t('先建一张空卡', fresh.ok === true, fresh)
  const discarded = await table3['card.discard']({ path: 'people/fresh.card.md' })
  t('空卡能收走', discarded.ok === true, JSON.stringify(discarded).slice(0, 200))
  t('收走以后目录里也没有它', await fs.stat(path.join(people, 'fresh.card.md')).then(() => false).catch(() => true))
  const freshAgain = await table3['card.save']({
    path: 'people/fresh.card.md',
    data: { lifecard: '0.1', id: 'fresh', kind: 'real', world: 'reality', name: '空卡' },
    sections: [],
  })
  t('同一个名字马上能再建（没留墓碑）', freshAgain.ok === true, JSON.stringify(freshAgain).slice(0, 200))

  const full = await table3['card.save']({
    path: 'people/full.card.md',
    data: { lifecard: '0.1', id: 'full', kind: 'real', world: 'reality', name: '写过东西的卡' },
    sections: [{ title: '自述', body: '这里有内容。' }],
  })
  t('再建一张有内容的卡', full.ok === true, full)
  const refused = await table3['card.discard']({ path: 'people/full.card.md' })
  t('新路由收不走写过内容的卡', refused.ok === false && String(refused.error).includes('已经写了内容'), refused)
  t('拒绝之后文件还在', await fs.stat(path.join(people, 'full.card.md')).then((st) => st.isFile()).catch(() => false))

  // 放了很久的空卡也不能当「刚建的空卡」收掉——不然这就是删活卡的后门。
  const old = await table3['card.save']({
    path: 'people/old-empty.card.md',
    data: { lifecard: '0.1', id: 'old-empty', kind: 'real', world: 'reality', name: '放了很久的空卡' },
    sections: [],
  })
  t('放久的空卡建好了', old.ok === true, old)
  const past = new Date(Date.now() - 60 * 60 * 1000)
  await fs.utimes(path.join(people, 'old-empty.card.md'), past, past)
  const tooOld = await table3['card.discard']({ path: 'people/old-empty.card.md' })
  t('放久了的空卡不许走这条路', tooOld.ok === false && String(tooOld.error).includes('放了一会儿'), tooOld)

  // ── repair round 2 的四条 finding ───────────────────────────────
  // R1：card.discard 收走的空卡不能变成「已经撤掉的」里一行摘不掉的幽灵。
  const ghostRow = (await table3['workspace.list']({})).withdrawn.filter((w) => w.path === 'people/fresh.card.md')
  t('收走的空卡不在「已经撤掉的」里多出一行', ghostRow.length === 0, ghostRow)

  // R2：彻底删掉必须连历史版本一起删——文案承诺「磁盘上的原文一起删」。
  const snapData = { lifecard: '0.1', id: 'snap', kind: 'real', world: 'reality', name: '有历史的人' }
  await table3['card.save']({ path: 'people/snap.card.md', data: { ...snapData }, sections: [{ title: '自述', body: '第一版。' }] })
  await table3['card.save']({ path: 'people/snap.card.md', data: { ...snapData }, sections: [{ title: '自述', body: '第二版。' }] })
  const snapDir = path.join(ws3, '.lifecard/snapshots', 'people__snap.card.md')
  t('先攒出一个历史版本', await fs.stat(snapDir).then((st) => st.isDirectory()).catch(() => false))
  await table3['card.delete']({ path: 'people/snap.card.md' })
  const snapPurged = await table3['card.purge']({ path: 'people/snap.card.md' })
  t('彻底删成功', snapPurged.ok === true, JSON.stringify(snapPurged).slice(0, 200))
  t('历史版本也一起删掉了', await fs.stat(snapDir).then(() => false).catch(() => true))

  // R3：列在「已经撤掉的」里、但原文读不出来的残份，也要能放回来、能彻底删。
  const ghostData = { lifecard: '0.1', id: 'ghost', kind: 'real', world: 'reality', name: '读不出的残份' }
  await table3['card.save']({ path: 'people/ghost.card.md', data: { ...ghostData }, sections: [{ title: '自述', body: '原文读不出来。' }] })
  const ghostMoved = await store.moveCardToRedacted(ws3, 'people/ghost.card.md')
  t('把卡搬进回收目录（故意不记账）', ghostMoved.ok === true, ghostMoved)
  const ghostTrash = path.join(ws3, ghostMoved.redacted)
  await fs.chmod(ghostTrash, 0o000)
  t('读不出来的残份照样列在「已经撤掉的」里', (await store.listWithdrawn(ws3)).some((w) => w.path === 'people/ghost.card.md'))
  const ghostBack = await table3['card.restore']({ path: 'people/ghost.card.md' })
  t('读不出来的残份也能放回来', ghostBack.ok === true, JSON.stringify(ghostBack).slice(0, 200))
  t('放回来之后原位确实有文件了', await fs.stat(path.join(people, 'ghost.card.md')).then((st) => st.isFile()).catch(() => false))
  await fs.chmod(path.join(people, 'ghost.card.md'), 0o644)

  const ghost2Data = { lifecard: '0.1', id: 'ghost2', kind: 'real', world: 'reality', name: '第二个残份' }
  await table3['card.save']({ path: 'people/ghost2.card.md', data: { ...ghost2Data }, sections: [{ title: '自述', body: '也是读不出来。' }] })
  const ghost2Moved = await store.moveCardToRedacted(ws3, 'people/ghost2.card.md')
  await fs.chmod(path.join(ws3, ghost2Moved.redacted), 0o000)
  const ghost2Purged = await table3['card.purge']({ path: 'people/ghost2.card.md' })
  t('读不出来的残份也删得掉', ghost2Purged.ok === true, JSON.stringify(ghost2Purged).slice(0, 200))
  t('删完以后不在「已经撤掉的」里了', (await store.listWithdrawn(ws3)).every((w) => w.path !== 'people/ghost2.card.md'))

  // R4：被丢掉的条目有两种原因，后端要把两个数分开给。
  const dupMat = await store.appendMaterial(ws3, '重复', '他喜欢下棋。他喜欢下棋。\n')
  const dupProposal = {
    about: { id: 'dupwho', name: '重复的人', kind: 'real', world: 'reality' },
    items: [
      { field: '自述', value: '他喜欢下棋。', source_level: '自述', evidence: { material: dupMat.path, quote: '他喜欢下棋' } },
      { field: '自述', value: '他喜欢 下棋!', source_level: '自述', evidence: { material: dupMat.path, quote: '他喜欢下棋' } },
    ],
  }
  const dupSaved = await store.saveProposal(ws3, 'dupwho', dupProposal, { [dupMat.path]: await fs.readFile(path.join(ws3, dupMat.path), 'utf8') })
  t('只收一条、另一条判重复', dupSaved.ok !== false && dupSaved.accepted === 1 && dupSaved.rejected === 1, dupSaved)
  t('重复的条数单独给出来', dupSaved.rejectedDuplicate === 1, dupSaved)
  t('引文对不上的条数是 0', dupSaved.rejectedQuote === 0, dupSaved)
  const dupListed = ((await table3['proposal.list']({})).proposals ?? []).find((x) => x.json === dupSaved.json)
  t('提案列表那一行也分得清重复', dupListed !== undefined && dupListed.rejectedDuplicate === 1 && dupListed.rejectedQuote === 0, dupListed)

  await fs.rm(ws3, { recursive: true, force: true })
}

console.log('\n=== 26. 撤掉的名字按名字也拦；空材料不是全读；备份不算材料 ===')
{
  // 用户库里的坑：id 是拼音、名字是中文（people/rat.card.md 这种）。
  // 以前只按「算出来的路径 + id」拦，按名字建卡能另造一张同名卡出来，
  // 首页和「已经撤掉的」各一个「妈妈」，点放回来变两张。
  const ws13 = await fs.mkdtemp(path.join(tmpdir(), 'lc-name-' + stamp + '-'))
  await store.openWorkspace(ws13, { create: true })
  const cp13 = api.buildApi(ctx, async () => ws13, { workspace: ws13 })
  const made = await cp13['card.save']({
    data: baseCard({ id: 'mama', name: '妈妈', relation: '母亲' }),
    sections: [{ title: '自述', body: '一辈子在纺织厂。' }],
  })
  t('先建一张 id 拼音、名字中文的卡', made.ok === true, made.error)
  t('它落在 people/mama.card.md', made.path === 'people/mama.card.md', made)
  t('删掉它', (await cp13['card.delete']({ path: made.path })).ok === true)
  const byName = await cp13['card.save']({ data: baseCard({ name: '妈妈' }), sections: [] })
  t('按中文名字重新建卡被拦住（以前会另建一张同名卡）', byName.ok === false, byName)
  t('拦住时说的是那句话，还带着标记', byName.withdrawn === true && String(byName.error).includes('已经删掉的卡占着'), byName)
  const leaked = await fs.stat(path.join(ws13, 'people', '妈妈.card.md')).then(() => true).catch(() => false)
  t('拦住的时候磁盘上没有多出 people/妈妈.card.md', leaked === false)
  const byPath = await cp13['card.save']({ path: 'people/妈妈.card.md', data: baseCard({ name: '妈妈' }), sections: [] })
  t('直接点名那个位置也一样拦住', byPath.ok === false && byPath.withdrawn === true, byPath)
  t('彻底删掉它', (await cp13['card.purge']({ path: made.path })).ok === true)
  const freed = await cp13['card.save']({ data: baseCard({ name: '妈妈' }), sections: [] })
  t('清掉之后同一个名字能正常建卡', freed.ok === true, freed.error)
  // 不同目录同名不许互相拦。
  const inWorld = await cp13['card.save']({
    path: 'worlds/wx/cards/阿岩.card.md',
    data: baseCard({ id: 'ayan', name: '阿岩', world: 'wx' }),
    sections: [],
  })
  t('先在世界里建一张叫阿岩的卡', inWorld.ok === true, inWorld.error)
  await cp13['card.delete']({ path: 'worlds/wx/cards/阿岩.card.md' })
  const otherDir = await cp13['card.save']({ data: baseCard({ id: 'ayan2', name: '阿岩' }), sections: [] })
  t('别的目录里有同名撤掉的卡，不挡 people 这边', otherDir.ok === true, otherDir.error)

  // 覆盖材料会留下 材料.md.bak-<时间戳>，以前它会被当成正式材料一起喂给模型。
  await store.appendMaterial(ws13, '摘录', '她十九岁进厂，手指头被机器压过一回。')
  await fs.writeFile(path.join(ws13, 'materials', '摘录.md.bak-20261029'), '她十八岁进厂。', 'utf8')
  await fs.writeFile(path.join(ws13, 'materials', '摘录.md.tmp-77'), '半个文件', 'utf8')
  const mats = Object.keys(await store.readMaterials(ws13))
  const onlyMat = mats[0] ?? ''
  t('读材料时只剩那一份正式的', mats.length === 1 && onlyMat.includes('摘录'), mats)
  t('备份与临时残骸不算材料', !mats.some((one) => /\.(bak|tmp)-/.test(one)), mats)
  const listed = await cp13['workspace.list']({})
  const listedMats = (listed.materials ?? []).map((one) => String(one.path ?? one.material ?? one.name ?? ''))
  t('列表里同样不出现备份', !listedMats.some((one) => /\.(bak|tmp)-/.test(one)), listedMats)
  t('列表里还看得到那份正式材料', listedMats.some((one) => one.includes('摘录')), listedMats)

  // 三种意思必须分得开：不传 = 全读；[] = 一份都不读；[路径] = 只读这些。
  const seen = []
  const fakeLlm = {
    listProviders: async () => [{ provider: 'raccoon', models: [{ id: 'sn-deepseek-v4-1-flash-1017' }] }],
    listModels: async () => [],
    stream: async (opts) => {
      seen.push(opts.model)
      return (async function* () {
        yield { type: 'text-delta', text: '{"items":[],"gaps":[],"questions":[]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
  const cp13m = api.buildApi({ ...ctx, get: (name) => (name === 'llm' ? fakeLlm : undefined) }, async () => ws13, { workspace: ws13 })
  const none = await cp13m['analyze.run']({ about: 'mama', materials: [] })
  t('一份都没选时说人话，不当成「全读」', none.ok === false && String(none.error).includes('没选任何材料'), none)
  t('一份都没选时根本不去调模型', seen.length === 0, seen)
  const all = await cp13m['analyze.run']({ about: 'mama' })
  t('不传材料清单还是全读，会真的去调模型', seen.length > 0 && all.ok === true, { ok: all.ok, error: all.error, seen })
  const before = seen.length
  const missing = await cp13m['analyze.run']({ about: 'mama', materials: ['materials/没这份.md'] })
  t('点名的材料不存在就报出来，不静默跳过', missing.ok === false && String(missing.error).includes('找不到'), missing)
  t('报错里点名是哪一份', String(missing.error).includes('没这份'), missing.error)
  t('材料找不到时不调模型', seen.length === before, seen)
  const only = await cp13m['analyze.run']({ about: 'mama', materials: [onlyMat] })
  t('只给一份时只读那一份', only.ok === true, only.error)
  await fs.rm(ws13, { recursive: true, force: true })
}

console.log('\n=== 27. 后台替用户开新对话（session.open）===')

{
  const made = []
  const sent = []
  const controller = {
    create: async (req) => {
      made.push(req)
      return { sessionId: 'sess-9', agentPreset: req?.agentPreset ?? 'standard' }
    },
    prompt: async (req) => { sent.push(req) },
  }
  const table2 = api.buildApi({ get: (name) => (name === 'sessionController' ? controller : undefined) }, async () => ws, {})
  const ok = await table2['session.open']({ preset: 'lc-tavern', text: '/lifecard-interview\n帮我建一张新的人物卡' })
  t('建会话时把预设带过去', made.length === 1 && made[0]?.agentPreset === 'lc-tavern', made)
  t('建好之后把第一句发出去', sent.length === 1 && String(sent[0]?.content?.[0]?.text ?? '').includes('/lifecard-interview'), sent)
  t('发消息是队列模式', sent[0]?.mode === 'queue', sent[0])
  t('回执里带着会话号', ok.ok === true && ok.sessionId === 'sess-9', ok)
  t('回执里说清实际用的是哪套预设', ok.agentPreset === 'lc-tavern', ok)
  t('回执里说清第一句发出去了', ok.sent === true, ok)

  const noText = await table2['session.open']({ preset: 'lc-real' })
  t('不给第一句也照样只建会话', noText.ok === true && noText.sent === false, noText)

  const boom = api.buildApi({ get: (name) => (name === 'sessionController' ? { create: async () => { throw new Error('会话服务没响应') }, prompt: async () => {} } : undefined) }, async () => ws, {})
  const bad = await boom['session.open']({ preset: 'lc-real', text: 'x' })
  t('建会话失败时说人话，不抛给前端', bad.ok === false && !String(bad.error).includes('    at '), bad)

  const none = api.buildApi({ get: () => undefined }, async () => ws, {})
  const missing = await none['session.open']({ preset: 'lc-real', text: 'x' })
  t('这台机器没有会话服务时如实说', missing.ok === false && String(missing.error).includes('复制'), missing)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
