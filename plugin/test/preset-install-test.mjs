/**
 * 预设安装测试：四个 LC agent preset 到底有没有被铺到宿主的盘面上。
 *
 * 为什么值得单独测：这套东西坏起来是**静默**的。预设没装上的时候插件照常
 * 起得来、路由照常通、界面照常开，只有用户那边表现为「看不到 LC 酒馆」
 * 和「一开口就被 AI 识破」。没人会想到去查 profile 的 cordis.patch.yml。
 *
 * 全部在 mkdtemp 造的假 DSH_HOME 里跑，绝不碰真实 ~/.dsh。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pluginDir = path.resolve(here, '..')
const bundled = fs.readFileSync(path.join(pluginDir, 'cordis.patch.yml'), 'utf8')

const mod = await import(path.join(pluginDir, 'lib', 'preset-install.js'))

let pass = 0
let fail = 0
const t = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`) }
  else {
    fail += 1
    console.log(`  FAIL ${name}${extra === undefined ? '' : `  ← ${JSON.stringify(extra).slice(0, 400)}`}`)
  }
}

const tmpDirs = []
/** 造一个假 DSH_HOME。 */
const makeHome = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-preset-'))
  tmpDirs.push(dir)
  return dir
}
const read = (file) => fs.readFileSync(file, 'utf8')
const has = (file) => fs.existsSync(file)
const lines = (text) => text.split(/\r?\n/)
/** 某个 preset 项在原文里的那几行（用来做「字一个没变」的断言）。 */
const spanOf = (text, id) => {
  const all = lines(text)
  const p = mod.parsePatchPresets(text).find((x) => x.id === id)
  return p === undefined ? null : all.slice(p.blockStart, p.blockEnd).join('\n')
}

// ── 1. 解析 ──────────────────────────────────────────────────────
console.log('\n=== 1. 从补丁里切出预设 ===')
{
  const got = mod.parsePatchPresets(bundled)
  t('切出四个预设', got.length === 4, got.map((p) => p.id))
  const tavern = got.find((p) => p.id === 'preset-lc-tavern')
  t('有 preset-lc-tavern', tavern !== undefined)
  t('loader 名是 dsh-agent-preset', tavern?.name === '@deepseek-ai/dsh-agent-preset', tavern?.name)
  t('config.id 是 lc-tavern（不带 preset- 前缀）', tavern?.config.id === 'lc-tavern', tavern?.config.id)
  t('显示名是 LC 酒馆', tavern?.config.name === 'LC 酒馆', tavern?.config.name)
  t('order 读出来了', tavern?.config.order === 2, tavern?.config.order)
  // 这一条是 whale-persona 0.17.5 首跑栽过的坑：config.plugins 里有
  // `- id: persona`，见到缩进更深就停会把整段人设切掉。
  t('没被里面的 - id: persona 切断（人设还在）', tavern?.config.persona?.prefixLength > 500, tavern?.config.persona?.prefixLength)
  t('人设那段是 dsh-persona', tavern?.config.persona?.name === '@deepseek-ai/dsh-persona', tavern?.config.persona?.name)
  t('人设后面那两个工具也还在', /- id: tool-fs-search/.test(tavern?.config.pluginsYaml ?? ''))
  t('四项都有 config.id', got.every((p) => p.config.id !== ''), got.map((p) => p.config.id))
  t('四项的人设长度都不一样（不是同一段被复制四遍）', new Set(got.map((p) => p.config.persona?.prefixLength)).size === 4)
}

console.log('\n=== 2. 有多个 insert 块时都能解析 ===')
{
  const two = [
    '- id: agent-preset-registry',
    '  name: "@deepseek-ai/dsh-agent-preset-registry"',
    '- insert:',
    '    - id: preset-aaa',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: lc-aaa',
    "        name: 'AAA'",
    '        plugins:',
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              prefix: |-',
    '                第一段人设',
    '          - id: tool-fs',
    "            name: '@deepseek-ai/dsh-tool-fs'",
    '',
    '# 中间的注释',
    '- insert:',
    '    - id: preset-bbb',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: lc-bbb',
    "        name: 'BBB'",
    '',
  ].join('\n')
  const got = mod.parsePatchPresets(two)
  t('两个块里的预设都切出来了', got.length === 2, got.map((p) => p.id))
  t('块顺序对', got[0]?.id === 'preset-aaa' && got[1]?.id === 'preset-bbb')
  t('第一项的人设没被块边界吃掉', got[0]?.config.persona?.prefix === '第一段人设', got[0]?.config.persona?.prefix)
  t('第二项也解析了 config', got[1]?.config.id === 'lc-bbb' && got[1]?.config.name === 'BBB')
  // 这份 fixture 头上有 registry 行 → profile 平面；抽掉它就该判成 agent-presets。
  t('有 registry 的文本判成 profile 平面', mod.patchHasRegistry(two) === true)
  t('抽掉 registry 就判成 agent-presets 平面', mod.patchHasRegistry(two.replace('- id: agent-preset-registry', '- id: something-else')) === false)
}

// ── 3. profile 平面：都在的时候什么都不做 ─────────────────────────
/**
 * 造一份「桌面版 profile」的组合文件：registry 段 + 后面那个 insert 块。
 *
 * registry 段是关键 —— 判平面就看它在不在。真实机器上这一段在文件里，
 * 而随包的 cordis.patch.yml 只是 insert 片段，两者要拼起来才是 profile 的样子。
 */
const profileText = () => `- id: agent-preset-registry
  name: "@deepseek-ai/dsh-agent-preset-registry"
  config:
    default: standard
    selectedDefault: ptc

${bundled}`

const profileHome = () => {
  const home = makeHome()
  fs.mkdirSync(path.join(home, 'profiles', 'desktop'), { recursive: true })
  fs.writeFileSync(path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'), profileText(), 'utf8')
  return home
}
const ENV = { DSH_PROFILE: 'desktop' }

console.log('\n=== 3. profile 平面：四个都在 → 不动盘面 ===')
{
  const home = profileHome()
  const plan = mod.planInstall({ home, env: ENV })
  t('判成 profile 平面', plan.plane === 'profile', plan.plane)
  t('profile 名认对了', plan.profile === 'desktop', plan.profile)
  t('找到的是那个 profile 的组合文件', plan.patchFile === path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'), plan.patchFile)
  t('没有要做的动作', plan.ok === true && plan.actions.length === 0, plan.actions?.map((a) => a.type))
  t('四个都报已装', plan.presets.length === 4 && plan.presets.every((p) => p.installed === true))
  t('四个都不 stale（就是插件自带那份）', plan.presets.every((p) => p.stale === false), plan.presets.map((p) => p.stale))
  const before = read(plan.patchFile)
  const out = mod.applyInstall(plan)
  t('apply 什么都没写', out.written.length === 0, out.written)
  t('文件一个字节没变', read(plan.patchFile) === before)
  t('没留备份（没写就不该备份）', fs.readdirSync(path.dirname(plan.patchFile)).filter((n) => n.includes('.bak-')).length === 0)
}

// ── 4. profile 平面：缺一个就补一个，别的字不能动 ──────────────────
console.log('\n=== 4. profile 平面：缺 lc-diary → 追加，别的三项一字不变 ===')
{
  const home = profileHome()
  const file = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml')
  const full = read(file)
  const diary = mod.parsePatchPresets(full).find((p) => p.id === 'preset-lc-diary')
  const all = lines(full)
  // 手写一份「少了 lc-diary」的组合：连它后面的空行一起拿掉。
  let end = diary.blockEnd
  while (end < all.length && all[end].trim() === '') end += 1
  const partial = [...all.slice(0, diary.blockStart), ...all.slice(end)].join('\n')
  fs.writeFileSync(file, partial, 'utf8')

  const plan = mod.planInstall({ home, env: ENV })
  const append = plan.actions.filter((a) => a.type === 'append-preset')
  t('正好一条 append-preset', plan.ok === true && append.length === 1, plan.actions.map((a) => a.type))
  t('缺的是 lc-diary', append[0]?.id === 'preset-lc-diary' && append[0]?.presetId === 'lc-diary', append[0]?.id)
  t('其它三个仍在 plan 里报已装', plan.presets.filter((p) => p.installed === true).length === 3)
  t('diary 报未装', plan.presets.find((p) => p.id === 'lc-diary')?.installed === false)

  const out = mod.applyInstall(plan)
  t('写成功了', out.ok === true, out.errors)
  t('写的就是那个组合文件', out.written.length === 1 && out.written[0] === file, out.written)

  const after = read(file)
  t('lc-diary 真的出现了', after.includes('- id: preset-lc-diary') && after.includes('id: lc-diary'))
  t('能解析出四项了', mod.parsePatchPresets(after).length === 4)
  t('人设也一起写进去了', mod.parsePatchPresets(after).find((p) => p.id === 'preset-lc-diary')?.config.persona?.prefixLength > 500)
  // 「其它三个的字一个没变」——按项比对原文那几行。
  for (const id of ['preset-lc-tavern', 'preset-lc-novel', 'preset-lc-real']) {
    t(`${id} 一字未变`, spanOf(partial, id) === spanOf(after, id))
  }
  t('原有内容整体是纯前缀（只是后面多了东西）', after.startsWith(partial))
  t('留了一份备份', fs.readdirSync(path.dirname(file)).some((n) => n.includes('.bak-')))
  t('备份内容和改之前一模一样', read(fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.bak-')).map((n) => path.join(path.dirname(file), n))[0]) === partial)

  // 幂等：再算一次、再写一次都不该有动作。
  const plan2 = mod.planInstall({ home, env: ENV })
  t('第二遍 plan 没动作了', plan2.actions.length === 0, plan2.actions.map((a) => a.type))
  const out2 = mod.applyInstall(plan2)
  t('第二遍 apply 没写任何文件', out2.written.length === 0, out2.written)
  t('第二遍之后文件也没变', read(file) === after)
}

/** 按行号把人设正文整段换掉（测试要造各种盘上状态，直接改文本最省事）。 */
function rewritePersona(file, presetId, bodyLines) {
  const all = lines(read(file))
  const item = mod.parsePatchPresets(read(file)).find((p) => p.id === presetId)
  const head = item.blockStart + item.presetLines.findIndex((l) => /^\s+prefix:\s*\|/.test(l))
  const headIndent = (/^(\s*)/.exec(all[head]) ?? ['', ''])[1].length
  let end = head + 1
  while (end < all.length) {
    if (all[end].trim() === '') { end += 1; continue }
    if ((/^(\s*)/.exec(all[end]) ?? ['', ''])[1].length <= headIndent) break
    end += 1
  }
  const indent = ' '.repeat(headIndent + 2)
  fs.writeFileSync(file, [...all.slice(0, head + 1), ...bodyLines.map((l) => indent + l), ...all.slice(end)].join('\n'), 'utf8')
}

console.log('\n=== 4b. 用户手写过：自动换插件那部分，用户写的行留着 ===')
{
  const home = profileHome()
  const file = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml')
  // 造真实情形：盘上是插件**上一版**文案 + 用户自己加的一句。
  const want = mod.parsePatchPresets(fs.readFileSync('./cordis.patch.yml', 'utf8')).find((p) => p.id === 'preset-lc-tavern')
  const oldBody = want.config.persona.prefix
    .replace(
      '- 用户在侧边栏为酒馆这扇门挑好的那张卡，**已经原样写进这份系统提示里了**（系统层面，不是对话里的资料）。它可能在你读到的头一段，也可能在你读到的最后一段——位置不重要，别去找「第一行」。',
      '- 用户为酒馆这扇门挑好的那张卡，**已经原样放在整份系统提示的最前面**（第一行就是那个人的名字，系统层面，不是对话里的资料）。那就这个人本身。',
    )
    .split('\n')
  t('夹具造出了旧版那句', oldBody.join('\n').includes('已经原样放在整份系统提示的最前面'))
  oldBody.splice(oldBody.findIndex((l) => l.includes('演的是一个人物，不是你自己')) + 1, 0, '（用户自己加的一句：多用短句。）')
  rewritePersona(file, 'preset-lc-tavern', oldBody)

  const plan = mod.planInstall({ home, env: ENV })
  const tavern = plan.presets.find((p) => p.id === 'lc-tavern')
  t('认出手改过（stale）', tavern?.stale === true)
  t('标成 user edited', tavern?.edited === true)
  const action = plan.actions.find((a) => a.type === 'update-preset' && a.id === 'preset-lc-tavern')
  t('给出 update-preset 且是自动的', action !== undefined && action.auto === true)
  t('notes 说了自己写的行会留着', plan.notes.some((n) => n.includes('行会原样留着')))
  const body = (action?.lines ?? []).join('\n')
  t('合并后的正文里有用户那句', body.includes('用户自己加的一句'))
  t('合并后的正文里没有旧版那句', !body.includes('已经原样放在整份系统提示的最前面'))
  t('合并后的正文里有新版那句', body.includes('别去找「第一行」'))
  const out = mod.applyInstall(plan)
  t('默认 apply 就写了', out.written.length >= 1, out.written)
  const after = mod.parsePatchPresets(read(file)).find((p) => p.id === 'preset-lc-tavern')?.config.persona?.prefix ?? ''
  t('写完之后用户那句话还在', after.includes('用户自己加的一句'))
  t('写完之后旧版那句没了', !after.includes('已经原样放在整份系统提示的最前面'))
  t('写完之后人设没被削掉', after.length > 800, after.length)
  const again = mod.planInstall({ home, env: ENV })
  t('第二遍没有 update-preset 了', again.actions.every((a) => a.type !== 'update-preset'), again.actions.map((a) => a.type))
}

console.log('\n=== 4c. 只有插件旧版文案残留：直接换成新版，不用问 ===')
{
  const home = profileHome()
  const file = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml')
  const want = mod.parsePatchPresets(fs.readFileSync('./cordis.patch.yml', 'utf8')).find((p) => p.id === 'preset-lc-tavern')
  const oldBody = want.config.persona.prefix
    .replace(
      '- 用户在侧边栏为酒馆这扇门挑好的那张卡，**已经原样写进这份系统提示里了**（系统层面，不是对话里的资料）。它可能在你读到的头一段，也可能在你读到的最后一段——位置不重要，别去找「第一行」。',
      '- 用户为酒馆这扇门挑好的那张卡，**已经原样放在整份系统提示的最前面**（第一行就是那个人的名字，系统层面，不是对话里的资料）。那就这个人本身。',
    )
    .split('\n')
  rewritePersona(file, 'preset-lc-tavern', oldBody)

  const plan = mod.planInstall({ home, env: ENV })
  const tavern = plan.presets.find((p) => p.id === 'lc-tavern')
  t('认出旧版残留（stale）', tavern?.stale === true)
  t('不算用户手写', tavern?.edited !== true)
  const action = plan.actions.find((a) => a.type === 'update-preset' && a.id === 'preset-lc-tavern')
  t('自动更新', action?.auto === true)
  t('正文直接用插件这一版', (action?.lines ?? []).join('\n').includes('别去找「第一行」'))
  t('notes 说会换成新版', plan.notes.some((n) => n.includes('还是插件上一版的文案')))
  const out = mod.applyInstall(plan)
  t('直接写了', out.written.length >= 1, out.written)
  t('写完之后旧句没了', !read(file).includes('已经原样放在整份系统提示的最前面'))
  const again = mod.planInstall({ home, env: ENV })
  t('第二遍没有动作了', again.actions.length === 0, again.actions.map((a) => a.type))
}

console.log('\n=== 4d. 整段重写过：不自动盖，等用户点头 ===')
{
  const home = profileHome()
  const file = path.join(home, 'profiles', 'desktop', 'cordis.patch.yml')
  rewritePersona(file, 'preset-lc-tavern', ['（这里是我自己写的一整段人设，和插件那份完全不一样。）'])

  const plan = mod.planInstall({ home, env: ENV })
  const tavern = plan.presets.find((p) => p.id === 'lc-tavern')
  t('认成 stale', tavern?.stale === true)
  const action = plan.actions.find((a) => a.type === 'update-preset' && a.id === 'preset-lc-tavern')
  t('给出 update-preset 但不是自动的', action !== undefined && action.auto === false)
  t('notes 说了整段重写过', plan.notes.some((n) => n.includes('整段重写过')))
  const out = mod.applyInstall(plan)
  t('默认 apply 不碰它', out.written.length === 0, out.written)
  t('用户自己那段还在', read(file).includes('我自己写的一整段人设'))
  const forced = mod.applyInstall({ ...plan, allowUpdates: true })
  t('显式 allowUpdates 才写', forced.written.length === 1, forced.written)
  t('更新后人设换回插件那版', read(file).includes('这份提示词里只有一个身份') && !read(file).includes('我自己写的一整段人设'))
}

console.log('\n=== 4e. mergePersonaPrefix 单元行为 ===')
{
  const W = ['a1', 'a2', 'a3'].join('\n')
  const plain = mod.mergePersonaPrefix(W, W)
  t('一模一样时没有 extras', plain.extras.length === 0 && plain.dropped.length === 0)
  t('一模一样时不报 noOverlap', plain.noOverlap === false)
  t('一模一样时正文就是 want', plain.text === W)

  const withExtra = mod.mergePersonaPrefix(W, ['a1', '我加的', 'a2', 'a3'].join('\n'))
  t('多出来那行进 extras', withExtra.extras.join('|') === '我加的')
  t('那行还挂在 a1 后面', withExtra.text === ['a1', '我加的', 'a2', 'a3'].join('\n'))

  const withOld = mod.mergePersonaPrefix(W, ['a1', '**已经原样放在整份系统提示的最前面**', 'a2', 'a3'].join('\n'))
  t('旧版残留进 dropped', withOld.dropped.length === 1)
  t('旧版残留不进 extras', withOld.extras.length === 0)
  t('正文里没有那句旧的', !withOld.text.includes('已经原样放在整份系统提示的最前面'))

  const rewritten = mod.mergePersonaPrefix(W, '完全不一样\n还是不一样')
  t('整段不同时 noOverlap 为真', rewritten.noOverlap === true)

  const emptyHave = mod.mergePersonaPrefix(W, '')
  t('空正文不算 noOverlap', emptyHave.noOverlap === false && emptyHave.text === W)
}

console.log('\n=== 5. agent-presets 平面：建四个目录 ===')
{
  const home = makeHome()
  const plan = mod.planInstall({ home, env: {} })
  t('判成 agent-presets 平面', plan.plane === 'agent-presets', plan.plane)
  t('四个建目录动作', plan.ok === true && plan.actions.length === 4, plan.actions.map((a) => a.type))
  t('动作类型是 create-preset-dir', plan.actions.every((a) => a.type === 'create-preset-dir'))
  t('目录名不带 preset- 前缀', plan.actions.every((a) => /^(lc-)/.test(a.id)), plan.actions.map((a) => a.id))
  t('四个 id 就是那四个', plan.actions.map((a) => a.id).sort().join(',') === 'lc-diary,lc-novel,lc-real,lc-tavern', plan.actions.map((a) => a.id))

  const out = mod.applyInstall(plan)
  t('写成功了', out.ok === true, out.errors)
  const dir = path.join(home, '.agent-presets', 'lc-tavern')
  t('lc-tavern 目录建出来了', has(dir))
  t('有 preset.yml', has(path.join(dir, 'preset.yml')))
  t('有 agent.cordis.yml', has(path.join(dir, 'agent.cordis.yml')))
  const preset = read(path.join(dir, 'preset.yml'))
  t('preset.yml 有 name', preset.includes("name: 'LC 酒馆'"), preset)
  t('preset.yml 有 description', preset.includes('description:'))
  t('preset.yml 有 order', /^order: 2$/m.test(preset), preset)
  const agent = read(path.join(dir, 'agent.cordis.yml'))
  t('agent.cordis.yml 里有 dsh-persona', agent.includes('@deepseek-ai/dsh-persona'))
  t('prefix 是块标量 |-', /^\s*prefix: \|-$/m.test(agent), agent.split('\n').filter((l) => l.includes('prefix:')))
  t('块标量里确实有人设正文', agent.includes('这份提示词里只有一个身份，就是你。没有另一个身份在旁边等着接管。'))
  t('人设正文比块头缩进深（YAML 要求）', (() => {
    const ls = agent.split('\n')
    const head = ls.findIndex((l) => /prefix: \|-/.test(l))
    const headIndent = head < 0 ? -1 : (/^(\s*)/.exec(ls[head]) ?? ['', ''])[1].length
    let body = -1
    for (let i = head + 1; i < ls.length; i++) if (ls[i].trim() !== '') { body = (/^(\s*)/.exec(ls[i]) ?? ['', ''])[1].length; break }
    return head >= 0 && body > headIndent
  })())
  t('那两个工具也搬过来了', agent.includes('@deepseek-ai/dsh-tool-fs') && agent.includes('@deepseek-ai/dsh-tool-fs-search'))
  t('没有留下半截临时文件', fs.readdirSync(dir).every((n) => !n.includes('.tmp-')))
  t('四个目录都建了', ['lc-tavern', 'lc-novel', 'lc-real', 'lc-diary'].every((id) => has(path.join(home, '.agent-presets', id, 'agent.cordis.yml'))))
  t('写完后四个都报已装', mod.planInstall({ home, env: {} }).presets.every((p) => p.installed === true))

  // 幂等
  const plan2 = mod.planInstall({ home, env: {} })
  t('第二遍 plan 没动作了', plan2.actions.length === 0, plan2.actions.map((a) => a.id))
  const out2 = mod.applyInstall(plan2)
  t('第二遍 apply 没写文件', out2.written.length === 0, out2.written)

  // 状态文件
  const state = mod.readInstallState(home)
  t('写了状态文件', state !== null && state.plane === 'agent-presets', state?.plane)
  t('状态文件里有四个预设', state?.presets?.length === 4, state?.presets?.length)
  t('状态文件里有时间', typeof state?.installedAt === 'string' && state.installedAt.includes('T'))
  t('读不存在的 home 时返回 null', mod.readInstallState(path.join(home, 'nope')) === null)
}

// ── 6. id 校验 ──────────────────────────────────────────────────
console.log('\n=== 6. 非法 id 挡住，不许路径穿越 ===')
{
  t('ID_RE 放行 lc-tavern', mod.isSafePresetId('lc-tavern') === true)
  t('ID_RE 放行带点的', mod.isSafePresetId('lc.tavern_1') === true)
  t('ID_RE 拦 ../evil', mod.isSafePresetId('../evil') === false)
  t('ID_RE 拦 a/b', mod.isSafePresetId('a/b') === false)
  t('ID_RE 拦绝对路径', mod.isSafePresetId('/etc/passwd') === false)
  t('ID_RE 拦空串', mod.isSafePresetId('') === false)
  t('ID_RE 拦点开头', mod.isSafePresetId('.hidden') === false)
  t('ID_RE 拦超长', mod.isSafePresetId('a'.repeat(65)) === false)

  const home = makeHome()
  const evilPlan = {
    ok: true,
    home,
    plane: 'agent-presets',
    presets: [],
    actions: [{ type: 'create-preset-dir', id: '../evil', auto: true, files: [{ name: 'x.yml', text: 'x\n' }] }],
  }
  const out = mod.applyInstall(evilPlan)
  t('apply 拒绝了非法 id', out.ok === false && out.errors.length > 0, out.errors)
  t('真的没建出 home 外面的目录', !has(path.join(home, '..', 'evil')) && !has(path.join(home, 'evil')))
  t('home 里什么都没多出来', fs.readdirSync(home).length === 0, fs.readdirSync(home))
  t('plan 无效时 apply 老实回错', mod.applyInstall(null).ok === false)
}

console.log('\n=== 7. 找不到 profile 组合文件时说人话 ===')
{
  const home = makeHome()
  fs.mkdirSync(path.join(home, 'profiles', 'desktop'), { recursive: true })
  // 有 registry 段才判成 profile 平面，但文件本身不存在的情形：
  // 这里直接指一个空 profile 目录 → 判成 agent-presets 平面（不会乱写）。
  const plan = mod.planInstall({ home, env: ENV })
  t('没组合文件时不冒充 profile 平面', plan.plane === 'agent-presets', plan.plane)
  t('没有动作也不炸', plan.ok === true && plan.actions.length === 4)
}

console.log('\n=== 8. 备份最多留 5 份 ===')
{
  const home = makeHome()
  const profileDir = path.join(home, 'profiles', 'desktop')
  fs.mkdirSync(profileDir, { recursive: true })
  const patch = path.join(profileDir, 'cordis.patch.yml')
  // 从带 registry 段的 profile 组合出发（否则会被判成 agent-presets 平面，
  // 压根不往这个文件写，备份自然一份都没有）。
  const full = profileText()
  const partial = (() => {
    const diary = mod.parsePatchPresets(full).find((p) => p.id === 'preset-lc-diary')
    const all = lines(full)
    let end = diary.blockEnd
    while (end < all.length && all[end].trim() === '') end += 1
    return [...all.slice(0, diary.blockStart), ...all.slice(end)].join('\n')
  })()
  fs.writeFileSync(patch, partial, 'utf8')
  for (let i = 0; i < 7; i += 1) {
    // 每轮先把 diary 拿掉，再让插件补回来 —— 每轮都会写一次、留一份备份。
    const now = read(patch)
    const p = mod.parsePatchPresets(now).find((x) => x.id === 'preset-lc-diary')
    if (p !== undefined) {
      const all = lines(now)
      let end = p.blockEnd
      while (end < all.length && all[end].trim() === '') end += 1
      fs.writeFileSync(patch, [...all.slice(0, p.blockStart), ...all.slice(end)].join('\n'), 'utf8')
    }
    const plan = mod.planInstall({ home, env: ENV })
    mod.applyInstall(plan)
  }
  const baks = fs.readdirSync(profileDir).filter((n) => n.includes('.bak-'))
  t('备份没无限堆', baks.length <= 5, baks.length)
  t('确实留了备份', baks.length >= 1, baks.length)
}

// ── 9. 找 DSH_HOME：一条路认死会漏掉另外几种起法 ─────────────────
console.log('\n=== 9. 候选根：桌面版 / 命令行 / 免安装版都能找着 ===')
{
  const home = makeHome()
  fs.mkdirSync(path.join(home, 'profiles', 'desktop'), { recursive: true })

  // DSH_HOME 明写出来就用它，不去猜别处——那是人给的话。
  t('DSH_HOME 写了就直接用', mod.presetHomeDir({ DSH_HOME: home }) === path.resolve(home), mod.presetHomeDir({ DSH_HOME: home }))
  // 没写就顺着候选找：这个假 home 里有 profiles/，够得上「像个 DSH_HOME」。
  const found = mod.candidateHomeDirs({}, []).includes(path.resolve(home))
  t('候选根里有 ~/.dsh 兜底', mod.candidateHomeDirs({}, []).some((x) => x.endsWith('/.dsh') || x.endsWith('\\.dsh')), mod.candidateHomeDirs({}, []))
  t('没写 DSH_HOME 时不用空串', mod.presetHomeDir({}) !== '', mod.presetHomeDir({}))

  // argv 里带着 profile 路径（桌面版就这么起）：从它反推 home，优先级最高。
  const argvDirs = mod.candidateHomeDirs({ DSH_HOME: '/nonexistent/other' }, [`${path.join(home, 'profiles', 'desktop')}`])
  t('argv 里的 profile 路径能反推 home', argvDirs[0] === path.resolve(home), argvDirs)
  t('argv 反推的排在 DSH_HOME 前面', argvDirs.indexOf(path.resolve(home)) < argvDirs.indexOf(path.resolve('/nonexistent/other')), argvDirs)

  // DSH_AGENT_PRESETS_ROOT 常被单独指出去：它是 `<home>/.agent-presets` 时退一级。
  fs.mkdirSync(path.join(home, '.agent-presets'), { recursive: true })
  const presetRoots = mod.candidateHomeDirs({ DSH_AGENT_PRESETS_ROOT: path.join(home, '.agent-presets') }, [])
  t('.agent-presets 根退一级得到 home', presetRoots.includes(path.resolve(home)), presetRoots)
  const customRoots = mod.candidateHomeDirs({ DSH_AGENT_PRESETS_ROOT: path.join(home, 'somewhere') }, [])
  t('指到别处时原样当一个根', customRoots.includes(path.resolve(path.join(home, 'somewhere'))), customRoots)

  // 去重：同一个根从两条路都能得出来时只留一条。
  const dup = mod.candidateHomeDirs({ DSH_HOME: home, DSH_AGENT_PRESETS_ROOT: path.join(home, '.agent-presets') }, [`${path.join(home, 'profiles', 'desktop')}`])
  t('同一个根只留一条', dup.length === new Set(dup).size, dup)

  // 顺序稳定：argv > agent-presets 根 > DSH_HOME > ~/.dsh。
  const order = mod.candidateHomeDirs({ DSH_HOME: '/b', DSH_AGENT_PRESETS_ROOT: '/c' }, ['/a/profiles/x'])
  t('四段的顺序是 argv → presets → DSH_HOME → 兜底', order.join('|') === '/a|/c|/b|' + path.join(os.homedir(), '.dsh'), order.join('|'))
}

// ── 10. 自定义 .agent-presets 根 ─────────────────────────────────
// 宿主可以把预设目录单独指出去。只按 home 拼，写进去的是没人读的地方。
console.log('\n=== 10. .agent-presets 指到别处时跟着走 ===')
{
  const home = makeHome()
  const elsewhere = makeHome()

  const plain = mod.agentPresetsDir(home, {})
  t('不指的时候就是 <home>/.agent-presets', plain === path.join(path.resolve(home), '.agent-presets'), plain)

  const pointed = mod.agentPresetsDir(home, { DSH_AGENT_PRESETS_ROOT: elsewhere })
  t('指到别处时用那个根下面的 .agent-presets', pointed === path.join(path.resolve(elsewhere), '.agent-presets'), pointed)

  const already = mod.agentPresetsDir(home, { DSH_AGENT_PRESETS_ROOT: path.join(elsewhere, '.agent-presets') })
  t('指过去的值本身就是 .agent-presets 时不再叠一层', already === path.join(path.resolve(elsewhere), '.agent-presets'), already)

  // 整条链路：探测平面要带上这个目录，装的时候写进那儿。
  const plane = mod.detectPresetPlane(home, { DSH_AGENT_PRESETS_ROOT: elsewhere, DSH_HOME: home })
  t('探测结果带上预设目录', plane.presetsDir === path.join(path.resolve(elsewhere), '.agent-presets'), plane.presetsDir)

  const plan = mod.planInstall({ home, env: { DSH_AGENT_PRESETS_ROOT: elsewhere, DSH_HOME: home } })
  t('没 profile 时按目录平面走', plan.plane === 'agent-presets', plan.plane)
  t('计划要建四个目录', plan.actions.length === 4, plan.actions.map((a) => a.id))
  t('计划指向自定义根', plan.actions.every((a) => String(a.where).startsWith(path.resolve(elsewhere))), plan.actions.map((a) => a.where))
  const done = mod.applyInstall(plan)
  t('装成功了', done.ok === true && done.errors.length === 0, done.errors)
  t('文件真写在自定义根里', has(path.join(elsewhere, '.agent-presets', 'lc-tavern', 'preset.yml')), '')
  t('别处一个都没写', !has(path.join(home, '.agent-presets', 'lc-tavern', 'preset.yml')), '')
}

// 收尾
for (const dir of tmpDirs) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录，删不掉无所谓 */ }
}
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exitCode = 1
