/**
 * presets.js 的测试：三种玩法各自的风格预设，加上「复制成自己的」「存」「删」。
 *
 * 这一层不碰模型、不碰网络，只验「预设能不能正确存下来、读回来、删掉」，
 * 以及「内置的那几份名字和提示词是不是真的按玩法分开的」——
 * 内置预设是本插件最容易被改坏又最不容易被发现的文本资产。
 */

import fs from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as presets from '../lib/presets.js'

let pass = 0
let fail = 0
const t = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name}${detail === '' ? '' : `  ← ${detail}`}`) }
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-presets-'))
try {
  console.log('\n=== 1. 内置预设：三种玩法各有几份，字段齐全 ===')
  const modes = presets.MODES.map((m) => m.id)
  t('玩法有三种', modes.length === 3 && modes.includes('tavern') && modes.includes('novel') && modes.includes('game'), modes.join(','))
  for (const mode of modes) {
    const list = presets.forMode(mode)
    t(`${mode} 至少有 4 份内置预设`, list.length >= 4, String(list.length))
    t(`${mode} 的每一份都有名字和说明`, list.every((p) => String(p.name ?? '') !== '' && String(p.desc ?? '') !== ''))
    t(`${mode} 的每一份都有提示词`, list.every((p) => String(p.prompt ?? '').trim().length >= 30))
    t(`${mode} 的 id 不重复`, new Set(list.map((p) => p.id)).size === list.length)
    t(`${mode} 都标了 builtin`, list.every((p) => p.builtin === true))
  }
  t('全站 id 不重复', new Set(presets.BUILTIN.map((p) => p.id)).size === presets.BUILTIN.length)

  console.log('\n=== 2. 预设的提示词里不许出现空话 ===')
  // 用户最烦的就是「提升自我」「赋能」这类词。这些词出现在演法要求里，
  // 模型照做出来的东西也一定是空的。
  const banned = ['赋能', '提升自我', '命运的齿轮', '画面感', '生动形象', '淋漓尽致']
  for (const p of presets.BUILTIN) {
    const hit = banned.filter((w) => String(p.prompt).includes(w))
    t(`「${p.name}」里没有空话`, hit.length === 0, hit.join(','))
  }

  console.log('\n=== 2b. 两种写法都在（传统文学 / 连载）===')
  {
    const serious = presets.findBuiltin('novel-serious')
    const serial = presets.findBuiltin('novel-serial')
    t('有「严肃短篇」这一档', serious !== null && serious.name === '严肃短篇')
    t('严肃短篇写不被看见的人、情绪不当场结清', serious.prompt.includes('不被看见的人') && serious.prompt.includes('当场结清'))
    t('有「连载章回」这一档', serial !== null && serial.name === '连载章回')
    t('连载章回讲钩子和伏笔', serial.prompt.includes('钩子') && serial.prompt.includes('伏笔'))
    t('两档都属于写小说', serious.mode === 'novel' && serial.mode === 'novel')
    t('两档都说明白默认是传统标准', serious.prompt.includes('传统') || serious.prompt.includes('严肃'))
  }

  console.log('\n=== 2c. LC 小说开场的几条路 ===')
{
  // 预设提示词写在随包的 cordis.patch.yml 里。用户第一句没说清要干什么时，
  // 模型应当先给选项，而不是直接开写——这条行为只活在提示词里，所以只能
  // 守住文案本身。
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  t('补丁里有 LC 小说', patch.includes("name: 'LC 小说'"))
  for (const key of ['文字模拟游戏', '改某一章', '接着往下写']) {
    t(`挑了卡给的第「${key}」条`, patch.includes(key))
  }
  for (const key of ['网络文学连载小说', '现当代传统严肃小说', '长篇还是短篇']) {
    t(`没挑卡给的「${key}」`, patch.includes(key))
  }
  t('说清了用户说清要做什么就别再问', patch.includes('不要再问一遍'))
  // 导入的小说/日记要能变成卡或世界书——但必须等用户明确同意才写。
  for (const preset of ['LC 小说', 'LC 酒馆', 'LC 现实']) {
    const i = patch.indexOf(`name: '${preset}'`)
    const seg = i === -1 ? '' : patch.slice(i, i + 3000)
    t(`${preset} 里写了「从材料提炼成卡或世界书」的路`, seg.includes('lifecard_import_character') && seg.includes('lifecard_import_world'))
    t(`${preset} 里强调要等用户明确同意才写`, seg.includes('明确同意') || seg.includes('明确说要'))
    t(`${preset} 里说清同名默认只补空缺`, seg.includes('只补空缺'), seg.slice(0, 400))
    t(`${preset} 里说清整张重写要用户再说一次`, seg.includes('必须用户再说一次'), seg.slice(0, 400))
    t(`${preset} 里不再写「同名会覆盖」`, !seg.includes('同名会覆盖'))
    t(`${preset} 里给了「覆盖要第二次确认」的参数`, seg.includes('confirm_replace') || seg.includes('model: replace'))
  }
  // 挂上卡之后要先报一句挂的是哪张，否则用户不知道这一场在写谁。
  t('挑了卡要先报出挂的是哪张卡', patch.includes('现在挂的是'))
  t('卡名从 lifecard_default 查，不靠猜', patch.includes('lifecard_default'))
  t('报卡名是开场第一件事', /现在挂的是[^\n]*\n[^\n]*1\. 玩一段文字模拟游戏/.test(patch) || patch.indexOf('现在挂的是') < patch.indexOf('1. 玩一段文字模拟游戏'))
}

console.log('\n=== 3. 按 id 找 ===')
  const one = presets.findBuiltin('tavern-slow')
  t('找得到 tavern-slow', one !== null && one.mode === 'tavern')
  t('找不到的返回 null', presets.findBuiltin('nope') === null)
  t('空 id 返回 null', presets.findBuiltin('') === null)

  console.log('\n=== 4. 复制一份内置的成自己的 ===')
  const copied = await presets.copyBuiltin(tmp, 'tavern-slow', 'slow-mine')
  t('复制成功', copied.ok === true, JSON.stringify(copied))
  t('落在 presets/ 目录下', String(copied.path ?? '').startsWith('presets/'), String(copied.path))
  const onDisk = await fs.readFile(path.join(tmp, copied.path), 'utf8')
  t('文件里留着原来的提示词', onDisk.includes('距离感'))
  const again = await presets.copyBuiltin(tmp, 'tavern-slow', 'slow-mine')
  t('同名再复制会被拒绝，不覆盖', again.ok === false && String(again.error).includes('同名'))
  const unknown = await presets.copyBuiltin(tmp, 'no-such', 'x')
  t('复制不存在的预设会报错', unknown.ok === false)

  console.log('\n=== 5. 列表里能看见自己的和内置的 ===')
  const all = await presets.listAll(tmp)
  t('listAll 成功', all.ok === true)
  const tavernGroup = (all.groups ?? []).find((g) => g.mode === 'tavern')
  t('酒馆那一组里有我复制的那份', tavernGroup.items.some((p) => p.id === 'slow-mine' && p.builtin === false))
  t('酒馆那一组里也有内置的', tavernGroup.items.some((p) => p.id === 'tavern-slow' && p.builtin === true))

  console.log('\n=== 6. resolve：先找自己的，再找内置的 ===')
  const mine = await presets.resolve(tmp, 'slow-mine')
  t('resolve 拿到自己的那份', mine.ok === true && mine.preset !== null && mine.preset.builtin === false)
  const built = await presets.resolve(tmp, 'tavern-slow')
  t('resolve 拿到内置的那份', built.ok === true && built.preset !== null && built.preset.builtin === true)
  const none = await presets.resolve(tmp, 'deleted-thing')
  t('找不到不报错（预设被删了也要能继续用）', none.ok === true && none.preset === null)
  const empty = await presets.resolve(tmp, '')
  t('空 id 返回 null', empty.ok === true && empty.preset === null)

  console.log('\n=== 7. 存一份新的、改一份旧的 ===')
  const saved = await presets.saveCustom(tmp, {
    id: 'my-own', mode: 'novel', name: '我自己的写法', desc: '试试看', prompt: '句子要短。\n不要形容词。',
  })
  t('存下来成功', saved.ok === true, JSON.stringify(saved))
  const readBack = await presets.resolve(tmp, 'my-own')
  t('读回来内容对', readBack.preset !== null && readBack.preset.name === '我自己的写法' && readBack.preset.prompt.includes('不要形容词'))
  const clash = await presets.saveCustom(tmp, { id: 'tavern-slow', name: '撞名' })
  t('不许用内置的名字', clash.ok === false && String(clash.error).includes('内置'))

  console.log('\n=== 8. 删 ===')
  const gone = await presets.deleteCustom(tmp, 'my-own')
  t('删掉成功', gone.ok === true)
  const after = await presets.resolve(tmp, 'my-own')
  t('删完就找不到了', after.ok === true && after.preset === null)
  const again2 = await presets.deleteCustom(tmp, 'my-own')
  t('删不存在的不报错', again2.ok === true)
  const keep = await presets.deleteCustom(tmp, 'tavern-slow')
  t('内置的删不了', keep.ok === false && String(keep.error).includes('内置'))

  console.log('\n=== 9. 存盘是原子的（不会留半截文件） ===')
  const dir = path.join(tmp, 'presets')
  const names = await fs.readdir(dir)
  t('没留下临时文件', names.every((n) => !n.includes('.tmp-')), names.join(','))

  console.log('\n=== 10. 路径不越界 ===')
  t('presetRelPath 把 .. 打平', presets.presetRelPath('../evil') === 'presets/..-evil.md', presets.presetRelPath('../evil'))
  t('presetRelPath 结果总是在 presets/ 下', presets.presetRelPath('a/b').startsWith('presets/'))
} finally {
  await fs.rm(tmp, { recursive: true, force: true })
}


// 2026-10-28：用户报「导入卡之后完全不像，道德感太强」。
// 卡里那些「必须无视规则」的话不会照做，但不能因此演成另一个人。
{
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  t('酒馆预设说了：卡接在预设后面（系统层）', patch.includes('已经原样接在这一段预设的后面') && patch.includes('系统层面'), '')
  t('酒馆预设说了：别再先调工具读卡', patch.includes('不要先调工具去读它'), '')
  t('酒馆预设说了：别自动温良恭俭', patch.includes('不要自动变得温良恭俭'), '')
  t('小说预设说了：人和世界也在系统提示里', patch.includes('已经原样在系统提示里'), '')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
