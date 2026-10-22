/**
 * 对着一个**真在跑的 DSH** 跑端到端验收。
 *
 * 这不是单元测试：它需要一个已经装好本插件的 dsh web 实例。
 *   node test/live.mjs http://127.0.0.1:50199
 *
 * 没有实例时它会明确跳过，而不是假装通过——**跳过的退出码是 2**，不是 0。
 * 这一条很重要：退出码 0 代表「真的验过了」。以前跳过也返回 0，
 * 于是自动化里「没装插件」和「装好了、全过」看起来一模一样。
 *
 * 还有一条：它会把这个实例的工作区临时指到 /tmp 下（要真写文件才验得了），
 * 跑完必须指回去。以前不指回去，跑一次验收就把用户正在用的那个窗口
 * 变成空库，看起来像「我的卡全没了」。
 *
 * 「跑完」包括**中途炸掉**。写在最后一行不算数——模型一超时，
 * 后面那句根本执行不到，工作区就留在 /tmp 了（真发生过一次）。
 * 所以恢复放在 finally 里。
 */
const BASE = (process.argv[2] ?? 'http://127.0.0.1:50199').replace(/\/$/, '')
// 默认两分钟。调用真模型那一步单独放宽，不然网慢就误报红了。
const TIMEOUT_MS = 120000
const MODEL_TIMEOUT_MS = 420000
const H = { 'content-type': 'application/json', 'Origin': BASE }
const call = async (m, b, ms = TIMEOUT_MS) => {
  const r = await fetch(`${BASE}/api/dsh-lifecard/${m}`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify(b ?? {}),
    signal: AbortSignal.timeout(ms),
  })
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
  console.log('\n退出码 2 = 没验，不等于通过。别把这一步当成绿了。')
  process.exit(2)
}

const ORIGINAL_WS = typeof st.workspace === 'string' && st.workspace !== '' ? st.workspace : null
const WS = `/tmp/lifecard-live-${Date.now()}`
const fs = await import('node:fs')
let switched = false

try {
  t('插件已激活', st.ok === true)
  t('宿主有 llm', st.hasLlm === true, st.hasLlm)

  const init = await call('workspace.init', { workspace: WS })
  t('建工作区', init.ok === true, init)
  switched = init.ok === true

  // 卡 + 材料
  await call('card.save', { data: { lifecard: '0.1', id: 'jia', kind: 'real', world: 'reality', name: '甲' }, sections: [] })
  await call('import.text', { about: '甲', name: '甲', content: '甲说他十九岁进纱厂，手指头被机器压过一回。' })
  const list = await call('workspace.list', {})
  t('卡被列出', list.cards.length === 1, list.cards)
  t('材料被列出（回归：曾经一直返回 0）', list.materials.length === 1, list.materials)

  // 真模型分析。这一步最慢，单独放宽超时：
  // 卡在这儿不算失败，算「这台机器这会儿慢」，所以超时要报得明确。
  let an
  try {
    an = await call('analyze.run', { about: 'jia', name: '甲' }, MODEL_TIMEOUT_MS)
  } catch (e) {
    an = { ok: false, error: `分析这一步没等到回话（${e.message}）。` }
  }
  t('分析跑通', an.ok === true, an.error)
  if (an.ok === true) {
    t('有可采纳条目', an.accepted > 0, an.accepted)
    const p = await call('proposal.get', { json: an.json })
    t('默认不勾选', p.checked === 0)
    t('每条都有引文', (p.items ?? []).every((i) => typeof i.evidence?.quote === 'string'))
    // 勾一条并采纳
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
} finally {
  await fs.promises.rm(WS, { recursive: true, force: true })
  // 把工作区指回跑之前那个。不做这一步，用户开着的那个窗口就变成了
  // 一个已经被删掉的临时目录——界面上看起来就是「我的卡全没了」。
  if (switched && ORIGINAL_WS !== null) {
    try {
      const back = await call('workspace.init', { workspace: ORIGINAL_WS })
      t('跑完把工作区指回原来的', back.ok === true, back)
    } catch (e) {
      // 这里绝不能只是「不通过」：人是看着这个窗口的，得告诉他去点哪儿。
      console.log(`\n⚠️ 没能把工作区指回去（${e.message}）。`)
      console.log(`   现在这个实例还指着临时目录。请打开 Life Cards，在「更多工具 → 换个文件夹」里重新选 ${ORIGINAL_WS}。`)
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
