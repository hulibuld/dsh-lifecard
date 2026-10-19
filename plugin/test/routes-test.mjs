/**
 * 客户端会调的那些接口，宿主这边真的都在。
 *
 * 为什么要单独测这一条：界面和宿主是两份代码，靠一个字符串名字对上。
 * 名字写错、路由改名、忘了往外暴露，测试和界面会一起「看起来正常」——
 * 但用户点下去就是 404。之前 `proposal.check` 就是这样漏过一次。
 *
 * 做法：从 client.js 里把所有 `call('xxx'` 抠出来，然后拿 buildApi()
 * 逐个确认真的有这个函数。不需要起服务器。
 */
import { readFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as api from '../lib/index.js'

let pass = 0, fail = 0
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : String(extra).slice(0, 400)) }
}

const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const called = [...new Set([...clientSource.matchAll(/\bcall\(\s*'([a-z][a-zA-Z.]*)'/g)].map((m) => m[1]))].sort()

const ctx = {
  webServer: { register: () => () => {} },
  reflect: { get: () => undefined },
  effect: (fn) => { fn(); return () => {} },
  logger: { warn: () => {} },
  get: () => undefined,
  llm: undefined,
}
const ws = path.join(tmpdir(), 'lifecard-routes-' + Date.now())
await fs.mkdir(ws, { recursive: true })
const table = api.buildApi(ctx, async () => ws, { workspace: ws })

console.log('=== 1. 界面上每一个 call 都能对上宿主的接口 ===')
t('从界面里抠出了若干接口调用', called.length > 8, called.length)
for (const name of called) {
  t(`界面要的 ${name} 宿主有`, typeof table[name] === 'function', Object.keys(table).filter((k) => k.includes(name.slice(0, 4))))
}

console.log('\n=== 2. 头像三件事都能用 ===')
{
  const png1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const rel = 'people/tu.card.md'
  await table['card.save']({ workspace: ws, path: rel, data: { lifecard: '0.1', id: 'tu', kind: 'real', name: '老图', world: 'reality' }, sections: [{ title: '自述', body: '〔自述〕他爱钓鱼。' }] })

  const set = await table['avatar.set']({ workspace: ws, path: rel, base64: png1 })
  t('设头像成功', set.ok === true, set)
  t('返回了落点', typeof set.avatar === 'string' && set.avatar.startsWith('assets/'), set.avatar)

  const got = await table['card.get']({ workspace: ws, path: rel })
  t('读卡时带回头像', got.avatar === png1, String(got.avatar).slice(0, 20))

  const list = await table['avatar.list']({ workspace: ws })
  t('列表页能一次拿到头像', list.ok === true && list.avatars?.tu === png1, list.avatars ? Object.keys(list.avatars) : list)

  const bad = await table['avatar.set']({ workspace: ws, path: rel, base64: 'bm90IGEgcG5n' })
  t('非 PNG 被拒绝', bad.ok === false, bad)

  const gone = await table['avatar.remove']({ workspace: ws, path: rel })
  t('去头像成功', gone.ok === true, gone)
  const after = await table['card.get']({ workspace: ws, path: rel })
  t('去掉后读不到', after.avatar === null, after.avatar)
}

console.log('\n=== 3. 宿主暴露的接口一个都不重名 ===')
{
  const names = Object.keys(table)
  t('接口数量合理', names.length >= 25, names.length)
  t('没有重复', new Set(names).size === names.length)
  t('全是小写点号命名', names.every((n) => /^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)+$/.test(n)), names.filter((n) => !/^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)+$/.test(n)))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
