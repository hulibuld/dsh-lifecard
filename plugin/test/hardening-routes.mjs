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
import path from 'node:path'
import * as api from '../lib/index.js'
import * as store from '../lib/store.js'

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
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
