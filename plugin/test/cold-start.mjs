/**
 * 「装上去是空的」的测试。
 *
 * 用户的原话：以后别人从 npm 或 GitHub 上装下来，库默认是空的。
 * 空的不是「没有界面」，是**没有任何一张卡、一份材料、一条提案**——
 * 别人打开看到的第一屏，就是他自己的库该有的样子，不是谁的演示数据。
 *
 * 所以这里钉两件事：
 * ① 新建一个库之后，除了配置文件和空文件夹，盘上一个内容文件都没有；
 * ② 随包发出去的文件里，没有名字像演示数据的（示例 / sample / demo / fixture）。
 *
 * 第②条为什么也要测：演示数据最容易在调试时被顺手塞进 skills/ 或 lib/，
 * 然后跟着 `files` 一起发出去。发出去就收不回来了——npm 的版本号不能复用。
 *
 * 要注意的口径：`test/` 里的样例（seraphina、eldoria）是测试夹具，不进包，
 * 所以这里判的是「随包发的文件」，不是整个仓库。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

import * as store from '../lib/store.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(here, '..')

const results = []
function t(name, ok, detail) {
  results.push({ name, ok: ok === true, detail })
  console.log(`  ${ok === true ? 'PASS' : 'FAIL'} ${name}${ok === true || detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`)
}

/** 把 package.json 里那种 files 模式翻成正则（只支持 `*` 与 `**`，够用了）。 */
function patternToRegExp(pattern) {
  const p = pattern.replace(/\\/g, '/')
  let out = ''
  for (let i = 0; i < p.length; i += 1) {
    const ch = p[i]
    if (ch === '*') {
      if (p[i + 1] === '*') {
        // `**/` 连前面的斜杠一起吃，`skills/**/*` 才能同时匹配一层和三层
        if (p[i + 2] === '/') { out += '(?:.*/)?'; i += 2 } else { out += '.*'; i += 1 }
      } else out += '[^/]*'
    } else if (ch === '/') out += '/'
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`)
}

/** 走一遍插件目录，问「这个文件会不会跟着包发出去」。 */
async function shippedFiles() {
  const pkg = JSON.parse(await fs.readFile(path.join(pluginDir, 'package.json'), 'utf8'))
  const patterns = Array.isArray(pkg.files) ? pkg.files.map(patternToRegExp) : []
  const out = []
  const walk = async (rel) => {
    const abs = path.join(pluginDir, rel)
    const entries = await fs.readdir(abs, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) { await walk(child); continue }
      if (!entry.isFile()) continue
      if (patterns.some((re) => re.test(child))) out.push(child)
    }
  }
  await walk('')
  return out
}

console.log('\n== 新建一个库：盘上除了配置和空文件夹，没有别的东西 ==')
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-cold-'))
  try {
    const opened = await store.openWorkspace(dir, { create: true })
    t('库建起来了', opened.ok === true, opened)

    const all = await store.listAll(dir)
    t('一张卡都没有', all.cards.length === 0, all.cards.length)
    t('一份材料都没有', all.materials.length === 0, all.materials.length)
    t('一个世界书都没有', all.worlds.length === 0, all.worlds.length)
    t('没有体系、没有关系、没有撤掉的卡', all.systems.length === 0 && all.relations.length === 0 && all.withdrawn.length === 0, {
      systems: all.systems.length, relations: all.relations.length, withdrawn: all.withdrawn.length,
    })

    // 顶层只该有配置文件和骨架文件夹。多出来的每个文件都得解释得清。
    const top = await fs.readdir(dir, { withFileTypes: true })
    const extra = top.filter((e) => e.isFile() && e.name !== 'lifecard.config.json').map((e) => e.name)
    t('顶层没有多余的文件', extra.length === 0, extra)

    // 每个骨架文件夹都必须是空的（尤其是 materials / proposals / people）。
    const notEmpty = []
    const walk = async (rel) => {
      const entries = await fs.readdir(path.join(dir, rel), { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        const child = `${rel}/${entry.name}`
        if (entry.isDirectory()) { await walk(child); continue }
        if (entry.name === 'lifecard.config.json' && rel === '') continue
        notEmpty.push(child)
      }
    }
    await walk('')
    t('骨架文件夹里一个文件都没有', notEmpty.length === 0, notEmpty)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

console.log('\n== 随包发出去的文件里没有演示数据 ==')
{
  const files = await shippedFiles()
  t('确实能列出要发出去的文件', files.length > 10, files.length)
  // 判据只看文件名与路径：演示数据不会叫「说明」，它总叫 示例 / sample / demo。
  const suspect = files.filter((f) => /示例|样例|演示|sample|demo|fixture|例卡/i.test(f))
  t('没有名字像演示数据的文件', suspect.length === 0, suspect)
  // 夹具待在 test/ 里、跟着测试走；它不该进包。
  const testsShipped = files.filter((f) => /(^|\/)test\//.test(f))
  t('测试夹具没有跟着包发出去', testsShipped.length === 0, testsShipped)
  // 顺手确认关键文件确实在包里——别把「没有演示数据」测成「什么都没打包」。
  for (const need of ['lib/index.js', 'lib/novel.js', 'cordis.patch.yml']) {
    t(`${need} 在包里`, files.includes(need), files.slice(0, 5))
  }
}

const failed = results.filter((r) => r.ok !== true).length
console.log(`\n${results.length - failed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
