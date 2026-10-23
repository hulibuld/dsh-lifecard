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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
