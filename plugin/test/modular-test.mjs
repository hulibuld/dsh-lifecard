/**
 * 可拆卸测试：把某个功能的文件删掉，插件还得能起来、别的功能还得能用。
 *
 * 为什么必须真删文件：这个插件里的每个模块都是「用到才加载」的，
 * 如果哪天有人改回文件顶上的静态 import，一删文件整个插件就起不来——
 * 那种坏法在正常的单元测试里完全看不出来，因为它们都假定文件在。
 *
 * 做法：把 lib/ 整个复制到一个临时目录，删掉其中一个文件，
 * 用子进程真的 import 一遍，看它活着没有、报错说的是不是人话。
 */

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(here, '..')

let pass = 0
let fail = 0
const t = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name}${detail === '' ? '' : `  ← ${detail}`}`) }
}

/**
 * 复制一份 lib，删掉 `drop`（可以是多个），然后问一遍插件。
 * 临时目录放在 plugin/ 底下，这样 `@deepseek-ai/schemastery` 还能从
 * 上层的 node_modules 里找到。
 */
async function probe(drop) {
  const tmp = await fs.mkdtemp(path.join(pluginDir, '.tmp-modular-'))
  try {
    await fs.cp(path.join(pluginDir, 'lib'), path.join(tmp, 'lib'), { recursive: true })
    for (const name of drop) await fs.rm(path.join(tmp, 'lib', name), { force: true })
    const script = `
      const m = await import(${JSON.stringify(path.join(tmp, 'lib', 'index.js'))})
      const api = m.buildApi({ get: () => null }, async () => ${JSON.stringify(tmp)}, {})
      const out = { features: (await api['features.list']({})).features }
      out.stateOk = (await api['state.get']({})).ok === true
      out.tavern = await api['tavern.list']({})
      out.novel = await api['novel.books']({})
      out.game = await api['game.list']({ book: 'b' }) 
      out.preset = await api['preset.list']({})
      if (m.__anything !== 1) {}
      console.log(JSON.stringify(out))
    `
    const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { cwd: tmp })
    return JSON.parse(stdout.trim().split('\n').pop())
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

console.log('\n=== 0. 文件都在的时候，四个功能都能用 ===')
{
  const got = await probe([])
  t('四个功能都报「装了」', got.features.tavern && got.features.novel && got.features.presets && got.features.game, JSON.stringify(got.features))
  t('核心功能还在', got.stateOk === true)
  t('酒馆能列会话', got.tavern.ok === true, JSON.stringify(got.tavern))
  t('小说能列书', got.novel.ok === true)
  t('游戏能列存档', got.game.ok === true)
  t('预设能列', got.preset.ok === true)
}

console.log('\n=== 1. 删掉游戏 ===')
{
  const got = await probe(['game.js'])
  t('插件还起得来', got.stateOk === true)
  t('游戏报「没装」', got.features.game === false)
  t('酒馆照常', got.features.tavern === true && got.tavern.ok === true)
  t('小说照常', got.features.novel === true && got.novel.ok === true)
  t('预设照常', got.features.presets === true && got.preset.ok === true)
  t('游戏路由报人话', got.game.ok === false && String(got.game.error).includes('没装'), JSON.stringify(got.game))
  t('报错里点名是哪个功能', String(got.game.error).includes('文字小说游戏'), got.game.error)
  t('报错里说别的功能不受影响', String(got.game.error).includes('不受影响'), got.game.error)
}

console.log('\n=== 2. 删掉酒馆 ===')
{
  const got = await probe(['tavern.js'])
  t('插件还起得来', got.stateOk === true)
  t('酒馆报「没装」', got.features.tavern === false)
  t('小说照常（不因为酒馆没了就废）', got.features.novel === true && got.novel.ok === true)
  t('游戏照常', got.features.game === true && got.game.ok === true)
  t('酒馆路由报人话', got.tavern.ok === false && String(got.tavern.error).includes('酒馆'))
}

console.log('\n=== 3. 删掉写小说 ===')
{
  const got = await probe(['novel.js'])
  t('插件还起得来', got.stateOk === true)
  t('小说报「没装」', got.features.novel === false)
  t('酒馆照常', got.features.tavern === true && got.tavern.ok === true)
  t('小说路由报人话', got.novel.ok === false && String(got.novel.error).includes('写小说'))
}

console.log('\n=== 4. 删掉预设 ===')
{
  const got = await probe(['presets.js'])
  t('插件还起得来', got.stateOk === true)
  t('预设报「没装」', got.features.presets === false)
  t('酒馆照常（预设只是「可以不选」的东西）', got.features.tavern === true && got.tavern.ok === true)
  t('小说照常', got.features.novel === true && got.novel.ok === true)
  t('预设路由报人话', got.preset.ok === false && String(got.preset.error).includes('预设'))
}

console.log('\n=== 5. 一次删三个，只剩核心 ===')
{
  const got = await probe(['tavern.js', 'novel.js', 'presets.js', 'game.js'])
  t('插件仍然起得来', got.stateOk === true)
  t('四个功能全报「没装」', Object.values(got.features).filter((x) => x === false).length === 4, JSON.stringify(got.features))
  t('「真实人物记录」还在', got.features.real === true)
  t('「找工作」还在', got.features.jobs === true)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
