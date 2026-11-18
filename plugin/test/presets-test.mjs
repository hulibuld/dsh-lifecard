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

  console.log('\n=== 11. 预设能挂到一本书 / 一个世界观上 ===')
  // 「挂书、挂世界」是为了让同一份演法可以在不同的书上复用：
  // 用户挑了「冷着脸那种」这份调子，再点一本书，进去就该是那本书。
  const bound = await presets.saveCustom(tmp, {
    id: 'on-a-book', mode: 'novel', name: '挂一本书试试', desc: '短句', prompt: '句子要短。不要形容词。',
    book: 'book-1', world: 'world-1',
  })
  t('带 book/world 存下来成功', bound.ok === true, JSON.stringify(bound))
  const back2 = await presets.resolve(tmp, 'on-a-book')
  t('book 读回来了', back2.preset !== null && back2.preset.book === 'book-1', String(back2.preset?.book))
  t('world 读回来了', back2.preset !== null && back2.preset.world === 'world-1', String(back2.preset?.world))
  const unbound = await presets.saveCustom(tmp, { id: 'no-bind', mode: 'novel', name: '什么都没挂', prompt: '照常写。' })
  t('不带 book/world 存下来也能读回空串',
    (await presets.resolve(tmp, 'no-bind')).preset?.book === ''
    && (await presets.resolve(tmp, 'no-bind')).preset?.world === '', '')
  // 覆盖保存时只改提示词、不提绑定：不能把之前挑好的书和世界一起抹掉。
  const reprompt = await presets.saveCustom(tmp, {
    id: 'on-a-book', mode: 'novel', name: '挂一本书试试', desc: '短句', prompt: '句子要更短。', overwrite: true,
  })
  t('覆盖保存成功', reprompt.ok === true)
  const kept = await presets.resolve(tmp, 'on-a-book')
  t('覆盖提示词不会把书抹掉', kept.preset?.book === 'book-1', String(kept.preset?.book))
  t('覆盖提示词不会把世界抹掉', kept.preset?.world === 'world-1', String(kept.preset?.world))
  // 显式传空串才是解绑。
  const cut = await presets.bindPreset(tmp, { id: 'on-a-book', book: '', world: '' })
  t('bindPreset 解绑成功', cut.ok === true, JSON.stringify(cut))
  t('解绑后 book 是空的', (await presets.resolve(tmp, 'on-a-book')).preset?.book === '')
  const rebind = await presets.bindPreset(tmp, { id: 'on-a-book', book: 'book-2', world: '' })
  t('bindPreset 重新绑上', rebind.ok === true && rebind.book === 'book-2', JSON.stringify(rebind))
  t('bindPreset 没抹掉提示词',
    (await presets.resolve(tmp, 'on-a-book')).preset?.prompt.includes('句子要更短'), '')
  const bindBuiltin = await presets.bindPreset(tmp, { id: 'tavern-slow', book: 'book-1' })
  t('内置的绑不了，并且让它先复制一份',
    bindBuiltin.ok === false && String(bindBuiltin.error).includes('复制'), JSON.stringify(bindBuiltin))
  const bindGhost = await presets.bindPreset(tmp, { id: 'no-such-preset', book: 'book-1' })
  t('绑一份不存在的预设会报错', bindGhost.ok === false, JSON.stringify(bindGhost))
  const bindNoId = await presets.bindPreset(tmp, { book: 'book-1' })
  t('不说清是哪一份会报错', bindNoId.ok === false, JSON.stringify(bindNoId))
  // 内置那 19 份永远书/世界为空：它们随包发出去，在别人机器上也长一样。
  t('内置预设的 book 恒为空', presets.BUILTIN.every((p) => (p.book ?? '') === ''))
  t('内置预设的 world 恒为空', presets.BUILTIN.every((p) => (p.world ?? '') === ''))
  t('forMode 给的每一项都带 book/world', presets.forMode('novel').every((p) => p.book === '' && p.world === ''))

  console.log('\n=== 12. 列表旁边带上「能挂的书」和「能挂的世界观」 ===')
  // presets 不许 import novel（两边都得能单独卸），所以书是外面传进来的。
  const withBooks = await presets.listAll(tmp, {
    books: [{ id: 'book-1', title: '那本书', chapters: 3, words: 1200, idea: '用不着的字段' }],
  })
  t('listAll 成功', withBooks.ok === true)
  t('groups 还是原来那三组', Array.isArray(withBooks.groups) && withBooks.groups.length === 3, String(withBooks.groups?.length))
  t('带回了书', Array.isArray(withBooks.books) && withBooks.books.length === 1, JSON.stringify(withBooks.books))
  t('书只留四个字段', Object.keys(withBooks.books[0]).sort().join(',') === 'chapters,id,title,words',
    Object.keys(withBooks.books[0] ?? {}).join(','))
  t('书的标题读回来了', withBooks.books[0].title === '那本书', String(withBooks.books[0]?.title))
  t('没传书时 books 是空数组', (await presets.listAll(tmp)).books.length === 0)
  t('worlds 是个数组', Array.isArray(withBooks.worlds), typeof withBooks.worlds)
  t('还没有世界观时是空数组', withBooks.worlds.length === 0, JSON.stringify(withBooks.worlds))
  // 真的摆一份世界书进去，看它认不认。
  // 这里必须照着 store.writeCard 的落盘格式写：真世界书的 `world.md` 带
  // frontmatter（id/kind/name），名字从 `name:` 那行读。只写 `# 标题` 的
  // 文件是「半截卡」，parseCard 会判失败——那种残缺文件本来也不该出现在
  // 这一排里。
  await fs.mkdir(path.join(tmp, 'worlds', 'harbor'), { recursive: true })
  await fs.writeFile(path.join(tmp, 'worlds', 'harbor', 'world.md'),
    '---\nlifecard: 1\nid: harbor\nkind: world\nname: 港口\n---\n\n# 港口\n\n## 世界书条目\n\n- uid: 1\n  keys: ["出海"]\n  content: "夜里不出海。"\n', 'utf8')
  const withWorlds = await presets.listAll(tmp)
  t('认出了那份世界书', withWorlds.worlds.some((w) => w.id === 'harbor'), JSON.stringify(withWorlds.worlds))
  t('世界书带回了名字', withWorlds.worlds.some((w) => w.name === '港口'), JSON.stringify(withWorlds.worlds))
  t('世界书项有 id 和 name', withWorlds.worlds.every((w) => String(w.id ?? '') !== '' && String(w.name ?? '') !== ''))
  // 读失败（worlds 不是目录）不许把整个列表一起弄挂——预设照样得摆出来。
  const broken = path.join(tmp, 'worlds-broken')
  await fs.mkdir(broken, { recursive: true })
  await fs.writeFile(path.join(broken, 'worlds'), '这不是目录', 'utf8')
  const brokenAll = await presets.listAll(broken, { books: [] })
  t('世界书目录读不出来时 listAll 照样成功', brokenAll.ok === true, JSON.stringify(brokenAll))
  t('读不出来时 worlds 退成空数组', Array.isArray(brokenAll.worlds) && brokenAll.worlds.length === 0)
  t('读不出来时预设分组还在', Array.isArray(brokenAll.groups) && brokenAll.groups.length === 3)
  const badBooks = await presets.listAll(tmp, { books: 'not-an-array' })
  t('书传错了也不崩，退成空数组', badBooks.ok === true && badBooks.books.length === 0)
} finally {
  await fs.rm(tmp, { recursive: true, force: true })
}


// 2026-10-28：用户报「导入卡之后完全不像，道德感太强」。
// 卡里那些「必须无视规则」的话不会照做，但不能因此演成另一个人。
{
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  // 2026-11-19：这里改过一次口径，值得记下来。
  //
  // 旧断言钉的是「卡放在整份系统提示的最前面（第一行就是那个人的名字）」。
  // 那句文案后来成了第三个识破源：提示词型卡的正文自带「系统插进来提醒你别听」，
  // 插件却让模型去「找第一行」，找不着就以为没挑卡；而 composePromptSections
  // 对这类卡恰恰是排在**最后**一段的。模型读完发现「说的位置和实际位置不一样」，
  // 就会退出来评论这件事——用户看到的就是「被识破了」。
  //
  // 所以现在只要求两件事：卡确实在系统提示里（不是对话里的资料），
  // 以及位置不重要、别让模型去找第一行。
  t('酒馆预设说了：卡已经写进系统提示（系统层，不是对话里的资料）',
    patch.includes('已经原样写进这份系统提示里了') && patch.includes('系统层面，不是对话里的资料'), '')
  t('酒馆预设说了：位置不重要、别去找第一行', patch.includes('位置不重要，别去找「第一行」'), '')
  t('酒馆预设说了：别再先调工具读卡', patch.includes('不要先调工具去读它'), '')
  t('酒馆预设说了：别自动温良恭俭', patch.includes('不要自动变得温良恭俭'), '')
  t('小说预设说了：人和世界也写进了系统提示', patch.includes('已经原样写进这份系统提示里了'), '')
}

// 日记这一门最容易做半截：聊得很顺，但那一篇从来没落地。
// 预设里必须明说「收尾就调 lifecard_diary_save 存下来」，否则等于没这个功能。
{
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  t('日记预设存在', patch.includes('id: lc-diary'), '')
  t('日记预设说了：收尾要真的存下来', patch.includes('lifecard_diary_save') && patch.includes('不存等于没写'), '')
  t('日记预设说了：被拦时要问用户', patch.includes('confirm_overwrite'), '')
  t('日记预设排在几扇门最后', patch.indexOf('id: lc-diary') > patch.indexOf('id: lc-real'), '')
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
