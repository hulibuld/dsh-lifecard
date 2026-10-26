// 一把跑完全部测试。
import { spawnSync } from 'node:child_process'
const files = ['test/roundtrip.mjs', 'test/codec-test.mjs', 'test/store-test.mjs', 'test/score-test.mjs', 'test/memory-test.mjs', 'test/jobs-test.mjs', 'test/tavern-test.mjs', 'test/tools-test.mjs',
  'test/interview-test.mjs', 'test/json-extract.mjs', 'test/prompt.test.mjs', 'test/client-smoke.mjs', 'test/skill-register.mjs', 'test/routes-test.mjs', 'test/hardening-routes.mjs', 'test/hardening-data.mjs', 'test/render-all.mjs', 'test/draft-flush-test.mjs', 'test/editor-add-test.mjs', 'test/novel-test.mjs', 'test/doors-test.mjs', 'test/presets-test.mjs', 'test/game-test.mjs', 'test/modular-test.mjs', 'test/career-test.mjs', 'test/wording-test.mjs']

let failed = 0
let total = 0
for (const f of files) {
  const r = spawnSync(process.execPath, [f], { encoding: 'utf8' })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  const m = /(\d+) passed, (\d+) failed/.exec(out)
  if (m !== null) total += Number(m[1])
  const ok = r.status === 0
  console.log(`${ok ? '✓' : '✗'} ${f}  ${m === null ? '' : `${m[1]} 项`}`)
  if (!ok) { failed += 1; console.log(out.split('\n').filter((l) => l.includes('FAIL')).join('\n')) }
}
console.log(`\n合计 ${total} 项，${failed === 0 ? '全部通过' : `${failed} 个文件失败`}。`)
process.exit(failed === 0 ? 0 : 1)
