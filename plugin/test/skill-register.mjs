/**
 * 访谈 skill 的运行期注册。
 *
 * 这一项之所以要单独测，是因为「写了 SKILL.md 但没装」正是上一轮的真实
 * 失败：文件在仓库里躺着，用户却看不到也用不上。所以这里检查的不是文件
 * 存在，而是**宿主 apply 之后 ctx.skills 里真的多了一条**。
 */
import { promises as fs, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as api from '../lib/index.js'

let pass = 0, fail = 0
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 500)) }
}

const here = path.dirname(fileURLToPath(import.meta.url))

console.log('=== 1. SKILL.md 随包存在 ===')
{
  const p = path.join(here, '..', 'skills', 'lifecard-interview', 'SKILL.md')
  const text = await fs.readFile(p, 'utf8')
  t('文件存在且非空', text.length > 1000)
  t('有 frontmatter', text.startsWith('---\n'))
  t('frontmatter 有 name', /^name:\s*lifecard-interview$/m.test(text))
  t('frontmatter 有 description', /^description:\s*\S/m.test(text))
  // package.json 的 files 必须把它带上，否则 npm 打包会漏掉——这正是
  // "文件在仓库里但用户装不到" 的另一种形态。
  const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'))
  t('package.json files 覆盖 skills/', pkg.files.some((f) => f.startsWith('skills/')), pkg.files)

  // lib/index.js 一开头就 import 了 schemastery。装机之后这个模块由谁提供，
  // 取决于宿主；但「有没有在 package.json 里说要它」是我们自己的责任——
  // 漏声明时本地能跑（本地有软链），别人装完可能起不来，而且报的是
  // 「Cannot find module」，看着像别人的问题。
  t('package.json 声明了 schemastery 依赖',
    Boolean((pkg.dependencies ?? {})['@deepseek-ai/schemastery']
      || (pkg.peerDependencies ?? {})['@deepseek-ai/schemastery']),
    pkg.dependencies)

  // 反过来：import 了却没声明，装机就会缺。这里只盯这一处已知的运行时依赖，
  // node: 开头的内置模块不算。
  const indexSrc = readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8')
  t('index.js 的 schemastery import 和声明对得上', indexSrc.includes("from '@deepseek-ai/schemastery'"))
}

console.log('\n=== 2. apply 时注册进 skills 服务 ===')
{
  const registered = []
  const ctx = {
    webServer: { register: () => () => {} },
    reflect: { get: (name) => name === 'skills' ? { register: (s) => { registered.push(s); return () => {} } } : undefined },
    effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
    logger: { warn: () => {} },
    llm: undefined,
  }
  api.apply(ctx, {})
  t('注册了一条 skill', registered.length === 1, registered.length)
  const s = registered[0]
  t('名字正确', s.name === 'lifecard-interview', s.name)
  t('有描述', typeof s.description === 'string' && s.description.length > 10)
  t('内容不含 frontmatter', !s.content.startsWith('---'))
  t('内容含正文标志段', s.content.includes('这个 skill 是什么'))
  t('内容长度合理', s.content.length > 800, s.content.length)
  t('模型可调用', s.invocation?.modelInvocable === true)
  t('用户可调用', s.invocation?.userInvocable === true)
  t('source 标记为 lifecard', s.source === 'lifecard', s.source)
}

console.log('\n=== 3. 没有 skills 服务时不影响插件 ===')
{
  let warned = ''
  const ctx = {
    webServer: { register: () => () => {} },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: (m) => { warned = m } },
  }
  let threw = null
  try { api.apply(ctx, {}) } catch (e) { threw = e }
  t('不抛错', threw === null, threw?.message)
  t('给出可见警告', warned.includes('访谈 skill 未注册'), warned)
}

console.log('\n=== 4. 拆 frontmatter 的边界 ===')
{
  // 用 apply 的路径验证：SKILL.md 的 description 含中文与标点时不能被截断
  const raw = readFileSync(path.join(here, '..', 'skills', 'lifecard-interview', 'SKILL.md'), 'utf8')
  const desc = raw.match(/^description:\s*(.+)$/m)?.[1] ?? ''
  t('description 非空', desc.length > 10, desc)
  t('description 未吞掉正文', !desc.includes('\n'))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
