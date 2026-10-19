/**
 * 对着一个**真在跑的 DSH** 跑端到端验收。
 *
 * 这不是单元测试：它需要一个已经装好本插件的 dsh web 实例。
 *   node test/live.mjs http://127.0.0.1:50199
 *
 * 没有实例时它会明确跳过，而不是假装通过。
 */
const BASE = (process.argv[2] ?? 'http://127.0.0.1:50199').replace(/\/$/, '')
const H = { 'content-type': 'application/json', 'Origin': BASE }
const call = async (m, b) => {
  const r = await fetch(`${BASE}/api/dsh-lifecard/${m}`, { method: 'POST', headers: H, body: JSON.stringify(b ?? {}) })
  if (!r.ok) throw new Error(`${m} -> HTTP ${r.status}`)
  return await r.json()
}

let pass = 0, fail = 0
const t = (n, c, x) => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)) } }

console.log(`live 验收：${BASE}`)
let st
try {
  st = await call('state.get', {})
} catch (e) {
  console.log(`\n跳过：${BASE} 上没有本插件的路由（${e.message}）。`)
  console.log('先用 dsh --profile <装了本插件的 profile> --port 50199 --no-open 起一个实例。')
  process.exit(0)
}

t('插件已激活', st.ok === true)
t('宿主有 llm', st.hasLlm === true, st.hasLlm)

const WS = `/tmp/lifecard-live-${Date.now()}`
const init = await call('workspace.init', { workspace: WS })
t('建工作区', init.ok === true, init)

// 卡 + 材料
await call('card.save', { data: { lifecard: '0.1', id: 'jia', kind: 'real', world: 'reality', name: '甲' }, sections: [] })
await call('import.text', { about: '甲', name: '甲', content: '甲说他十九岁进纱厂，手指头被机器压过一回。' })
const list = await call('workspace.list', {})
t('卡被列出', list.cards.length === 1, list.cards)
t('材料被列出（回归：曾经一直返回 0）', list.materials.length === 1, list.materials)

// 真模型分析
const an = await call('analyze.run', { about: 'jia', name: '甲' })
t('分析跑通', an.ok === true, an.error)
if (an.ok === true) {
  t('有可采纳条目', an.accepted > 0, an.accepted)
  const p = await call('proposal.get', { json: an.json })
  t('默认不勾选', p.checked === 0)
  t('每条都有引文', (p.items ?? []).every((i) => typeof i.evidence?.quote === 'string'))
  // 勾一条并采纳
  const fs = await import('node:fs')
  const mdPath = WS + '/' + p.md
  let md = fs.readFileSync(mdPath, 'utf8')
  md = md.replace('- [ ] ', '- [x] ')
  fs.writeFileSync(mdPath, md, 'utf8')
  const ap = await call('proposal.apply', { json: an.json })
  t('采纳成功', ap.ok === true, ap)
}

// 导出
const target = list.cards[0]
const ex = await call('export.card', { path: target.path })
t('导出 PNG', ex.ok === true, ex.error)
t('双 chunk 同源', ex.consistent === true, ex.missing)

// 体检
const d = await call('doctor.run', { workspace: WS })
t('doctor 跑通', d.ok !== undefined)
t('宿主段已写', d.host?.ran === true)

const fs = await import('node:fs')
await fs.promises.rm(WS, { recursive: true, force: true })

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
