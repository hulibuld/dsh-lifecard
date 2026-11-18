/**
 * 让 LifeCard 的四个 agent preset 真的存在。
 *
 * 为什么需要它：DSH 的 agent preset 有两套互不相通的存储平面。
 *
 *   1) profile 平面（桌面版）：预设是 profile 组合里的一行 ——
 *      `<DSH_HOME>/profiles/<profile>/cordis.patch.yml` 的 `- insert:` 块里
 *      `- id: preset-lc-*` / `name: '@deepseek-ai/dsh-agent-preset'`。
 *   2) agent-presets 平面：预设是目录 —— `<DSH_HOME>/.agent-presets/<id>/`
 *      下的 `agent.cordis.yml` + `preset.yml`。
 *
 * 而随包的 `cordis.patch.yml` 只在**装机那一刻**被抄进用户 profile。插件升级、
 * 换 profile、或者宿主走 agent-presets 平面时，四个 lc 预设根本不存在 ——
 * 用户看不到「LC 酒馆」，进了酒馆门判不出 mode，人物卡永远进不了系统提示。
 * 他看到的症状是「一开口就被 AI 识破」。
 *
 * 这个模块只做一件事：把「该有的那四行/那四个目录」补齐，幂等，不覆盖用户手改的。
 *
 * 零依赖纪律：只用 node:fs / node:path / node:os，不引 YAML 库、不开子进程
 * （插件运行期零 shell 是硬纪律）。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** 随包的那份补丁：它是「该是什么样」的唯一标准答案。 */
const BUNDLED_PATCH = path.join(HERE, '..', 'cordis.patch.yml')
/** 状态文件（写在用户自己的 DSH_HOME 里，和 workspace 指针同一个 plugin-data 目录）。 */
const STATE_NAME = 'lifecard-presets.json'
/** 备份最多留几份，多了删最老的。 */
const BACKUP_KEEP = 5
/**
 * id 白名单：字母数字开头，其余 . _ -，最长 64。
 * 结果只可能是一个目录名 —— 防 `../evil` 这种路径穿越。
 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

// ── 小工具 ────────────────────────────────────────────────────────

/**
 * 「可能的 DSH_HOME」按可能性排队。
 *
 * 为什么不止一条路：桌面版、命令行、免安装版给的环境变量各不相同。有的机器上
 * `DSH_HOME` 根本没设（那就该是 `~/.dsh`）；有的是从 profile 目录里起的进程，
 * 只有 `process.argv` 里带着 `…/profiles/desktop`；还有的宿主把 agent-presets
 * 的根单独指出去（`DSH_AGENT_PRESETS_ROOT`）。只认一条路，遇到另一种起法就会
 * 判成「找不到 DSH_HOME」，四个预设一个也装不上——用户看到的症状是一开口就被
 * 识破。借的是 whale-persona 的 candidateRoots 那套：多试几个根，用盘上真有
 * 东西的那个。顺序就是优先级。
 */
export function candidateHomeDirs(env = process.env, argv = process.argv) {
  const out = []
  const push = (value) => {
    const v = String(value ?? '').trim()
    if (v === '') return
    let abs = ''
    try { abs = path.resolve(v) } catch { return }
    if (!out.includes(abs)) out.push(abs)
  }
  // argv 里的 `…/profiles/<name>` 反推：桌面版和 `dsh --profile` 都这么起。
  // 它比一个默认路径更像「这次真的在用哪个」。
  for (const raw of Array.isArray(argv) ? argv : []) {
    const m = /^(.*)[\\/]profiles[\\/][^\\/]+/.exec(String(raw ?? ''))
    if (m !== null && String(m[1]).trim() !== '') push(m[1])
  }
  // agent-presets 的根常被单独指出去。它自己就是 `<home>/.agent-presets` 时退一级。
  const presetsRoot = String(env?.DSH_AGENT_PRESETS_ROOT ?? '').trim()
  if (presetsRoot !== '') {
    let abs = ''
    try { abs = path.resolve(presetsRoot) } catch { abs = '' }
    if (abs !== '') push(path.basename(abs) === '.agent-presets' ? path.dirname(abs) : abs)
  }
  push(env?.DSH_HOME)
  push(path.join(os.homedir(), '.dsh'))
  return out
}

/** 这个目录像不像一个 DSH_HOME：有 profiles/ 或 .agent-presets/ 或配置文件。 */
function looksLikeHome(dir) {
  if (dir === '') return false
  for (const name of ['profiles', '.agent-presets', 'config.yml', 'config.json', 'config.yaml']) {
    try {
      if (existsSync(path.join(dir, name))) return true
    } catch { /* 读不了就当没有 */ }
  }
  return false
}

/**
 * 用哪个 DSH_HOME。
 *
 * `DSH_HOME` 明写出来的时候直接用它——那是人给的话，不去猜。没写才顺着
 * `candidateHomeDirs` 找第一个盘上真有东西的；一个都没有才落回 `~/.dsh`。
 */
export function presetHomeDir(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (configured !== '') return path.resolve(configured)
  for (const dir of candidateHomeDirs(env)) {
    if (looksLikeHome(dir)) return dir
  }
  return path.join(os.homedir(), '.dsh')
}

/** 这个 id 能不能直接当目录名用。 */
export function isSafePresetId(id) {
  return ID_RE.test(String(id ?? ''))
}

function readText(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 备份一份。返回备份路径；原文件不在就不备份（也不报错）。 */
function backupFile(file) {
  if (!existsSync(file)) return ''
  const bak = `${file}.bak-${stamp()}-${process.pid}`
  copyFileSync(file, bak)
  pruneBackups(file)
  return bak
}

/** 同名备份只留最近 BACKUP_KEEP 份（时间戳在前，字典序即时间序）。 */
function pruneBackups(file) {
  const dir = path.dirname(file)
  const base = `${path.basename(file)}.bak-`
  let names = []
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(base)).sort()
  } catch {
    return
  }
  if (names.length <= BACKUP_KEEP) return
  for (const n of names.slice(0, names.length - BACKUP_KEEP)) {
    try {
      unlinkSync(path.join(dir, n))
    } catch { /* 删不掉就算了，留着不影响 */ }
  }
}

/** tmp + rename 原子写；跨盘 rename 失败时退回直接写，并把临时文件清掉。 */
function writeAtomic(file, text) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* 已经没了 */ }
    writeFileSync(file, text, 'utf8')
  }
}

/** 写前备份 + 原子写。 */
function writeWithBackup(file, text) {
  backupFile(file)
  writeAtomic(file, text)
}

// ── 解析 cordis.patch.yml ─────────────────────────────────────────
//
// 不上 YAML 库：插件零依赖。只认两件事 —— insert 块里的 preset-* 项，
// 以及 registry 段在不在。

/**
 * 顶层有没有 `- id: agent-preset-registry`。
 * 有 = 桌面版那套（预设＝组合里的一行）；没有 = .agent-presets 目录那套。
 */
export function patchHasRegistry(text) {
  return String(text ?? '').split(/\r?\n/).some((l) => /^-\s+id:\s*agent-preset-registry\s*$/.test(l))
}

/** 一个 insert 块的边界（含头行，不含尾）。 */
function insertBlocks(lines) {
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^-\s+insert:\s*$/.test(lines[i])) continue
    let end = i + 1
    while (end < lines.length && !/^- /.test(lines[end])) end += 1
    let hasPreset = false
    let itemIndent = -1
    for (let j = i + 1; j < end; j++) {
      const m = /^(\s*)- id:/.exec(lines[j])
      if (!m) continue
      if (itemIndent < 0) itemIndent = m[1].length
      if (/^\s*-\s*id:\s*preset-/.test(lines[j]) && m[1].length === itemIndent) hasPreset = true
    }
    out.push({ start: i, end, hasPreset, itemIndent })
  }
  return out
}

/**
 * 解析 profile 补丁里的 presets。
 *
 * 关键：一个 preset 项的结束判据是「顶层行，或**同层/更外层**的下一个 `- id:`」。
 * **不能**「见到缩进更深就停」—— `config.plugins` 里就有一行 `- id: persona`，
 * 那是人设行，停在那儿等于把整段人设切掉（whale-persona 0.17.5 首跑栽的就是这个）。
 *
 * @returns {Array<{id:string, name:string, blockStart:number, blockEnd:number, config:object}>}
 */
export function parsePatchPresets(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const out = []
  for (const block of insertBlocks(lines)) {
    for (let j = block.start + 1; j < block.end; j++) {
      const m = /^(\s*)- id:\s*(preset-[A-Za-z0-9._-]+)\s*$/.exec(lines[j])
      if (!m) continue
      const baseIndent = m[1].length
      let end = j + 1
      while (end < block.end) {
        const next = /^(\s*)- id:/.exec(lines[end])
        if (next !== null && next[1].length <= baseIndent) break
        end += 1
      }
      // 尾部的空行和注释不算这一项的：`# ── LC 小说…` 那种分节注释是**下一项**的
      // 标题，算进来会让「这一项改了没有」的比对永远为假，也让追加的位置多出空行。
      while (end > j + 1) {
        const tail = lines[end - 1]
        const indent = (/^(\s*)/.exec(tail) ?? ['', ''])[1].length
        const isBlankOrComment = tail.trim() === '' || tail.trim().startsWith('#')
        if (!isBlankOrComment || indent > baseIndent) break
        end -= 1
      }
      out.push(makePresetItem(lines, j, end, m[2]))
      j = end - 1
    }
  }
  return out
}

/** insert 块里的一项：loader 的 name 是包名，config 里的 name 才是显示名。 */
function makePresetItem(lines, start, end, insertId) {
  const block = lines.slice(start, end)
  let loaderName = ''
  const configIdx = block.findIndex((l) => /^\s+config:\s*$/.test(l))
  const headEnd = configIdx < 0 ? block.length : configIdx
  for (let i = 1; i < headEnd; i++) {
    const m = /^\s+name:\s*(.+?)\s*$/.exec(block[i])
    if (m !== null) {
      loaderName = unquote(m[1])
      break
    }
  }
  const cfg = { id: '', name: '', description: '', order: null, persona: null, pluginsYaml: '' }
  if (configIdx >= 0) {
    for (let i = configIdx + 1; i < block.length; i++) {
      const l = block[i]
      if (/^\s+plugins:\s*$/.test(l)) break
      let m = /^\s+id:\s*(\S*)\s*$/.exec(l)
      if (m !== null && cfg.id === '') { cfg.id = unquote(m[1]); continue }
      m = /^\s+name:\s*(.+?)\s*$/.exec(l)
      if (m !== null && cfg.name === '') { cfg.name = unquote(m[1]); continue }
      m = /^\s+description:\s*(.+?)\s*$/.exec(l)
      if (m !== null && cfg.description === '') { cfg.description = unquote(m[1]); continue }
      m = /^\s+order:\s*(\S*)\s*$/.exec(l)
      if (m !== null && cfg.order === null) {
        const n = Number(m[1])
        cfg.order = Number.isFinite(n) ? n : null
      }
    }
    cfg.pluginsYaml = pluginsYamlOf(block)
    cfg.persona = personaOf(cfg.pluginsYaml)
  }
  // 原样保留这项的字节（含缩进），profile 平面追加时就靠它 —— 不重新生成 YAML，
  // 因为标准答案就是随包那份，重新生成只会有差异风险。
  return {
    id: insertId,
    name: loaderName,
    blockStart: start,
    blockEnd: end,
    config: cfg,
    presetLines: block.slice(),
    baseIndent: (/^(\s*)/.exec(block[0]) ?? ['', ''])[1].length,
  }
}

function unquote(value) {
  const v = String(value ?? '').trim()
  if (v.length >= 2 && (v[0] === "'" || v[0] === '"') && v[v.length - 1] === v[0]) return v.slice(1, -1)
  return v
}

/** 把 `plugins:` 那一子树整段摘出来，去掉公共缩进 → 一份合法的顶层插件列表。 */
function pluginsYamlOf(block) {
  const idx = block.findIndex((l) => /^\s+plugins:\s*$/.test(l))
  if (idx < 0) return ''
  const body = block.slice(idx + 1)
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop()
  const first = body.find((l) => /^\s*- /.test(l))
  if (first === undefined) return ''
  const base = (/^(\s*)/.exec(first) ?? ['', ''])[1].length
  return body.map((l) => (l.trim() === '' ? '' : l.slice(base))).join('\n')
}

/** plugins 里的人设行：id / name / prefix 长度（长度用来判「用户手改过没有」）。 */
function personaOf(pluginsYaml) {
  if (pluginsYaml === '') return null
  const lines = pluginsYaml.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (!/^- id:\s*persona\s*$/.test(lines[i])) continue
    const item = { id: 'persona', name: '', prefixLength: 0, prefix: '' }
    for (let j = i + 1; j < lines.length && !/^- /.test(lines[j]); j++) {
      const m = /^\s+name:\s*(.+?)\s*$/.exec(lines[j])
      if (m !== null && item.name === '') item.name = unquote(m[1])
      if (/^\s+prefix:\s*\|/.test(lines[j])) {
        item.prefix = blockScalar(lines, j)
        item.prefixLength = item.prefix.length
        break
      }
    }
    return item
  }
  return null
}

/**
 * 插件**自己上一版**写进人设里的句子。用户那份里出现这些行，说明那是插件升级前的
 * 残留，不是用户写的字 —— 可以放心换掉。
 *
 * 往这个清单里加之前先想清楚：判错的代价是把用户亲手写的一句话删掉。所以只收
 * 「整句都是插件口气、用户不可能自己写出这句」的短语，不要收通用词。
 */
const OLD_PERSONA_LINES = [
  '**已经原样放在整份系统提示的最前面**',
  '**已经原样在系统提示的最前面**',
  '系统提示开头没有这样一节',
  '第一行就是那个人的名字',
]

function looksLikeOldBundledLine(line) {
  const s = String(line ?? '')
  return OLD_PERSONA_LINES.some((marker) => s.includes(marker))
}

/**
 * 拿插件自带的人设当基准，把用户那份里「多出来的行」挑出来并归位。
 *
 * 为什么不能只比长度：插件自己改文案会让长度变，用户改一个字也会让长度变，
 * 两种情况混成一个 `stale` 就只能一律不动 —— 那 plugin 修的文案永远到不了用户手上。
 * 所以按行对：对得上 want 的是插件的，对不上但像旧版残留的是插件的旧版，剩下的
 * 才是用户自己的字。
 *
 * @returns {{text:string, extras:string[], dropped:string[], noOverlap:boolean}}
 *   `text` 是「插件新版 + 用户那几行」合成的人设正文；`extras` 是用户自己写的行；
 *   `dropped` 是被认出来属于旧版、换掉时丢掉的插件行；`noOverlap` 为真表示两边
 *   几乎对不上（整段重写过），这时候不该拿 want 去盖它。
 */
export function mergePersonaPrefix(wantText, haveText) {
  const W = String(wantText ?? '').split('\n')
  const haveLines = String(haveText ?? '').split('\n').filter((l) => l.trim() !== '')
  const slots = new Map()
  const extras = []
  const dropped = []
  let cursor = 0
  for (const line of haveLines) {
    const at = W.indexOf(line, cursor)
    if (at >= 0) {
      cursor = at + 1
      continue
    }
    if (looksLikeOldBundledLine(line)) {
      dropped.push(line)
      continue
    }
    extras.push(line)
    // 挂在「上一个对得上的 want 行」后面；一行都没对上就是 -1，排最前。
    const key = cursor - 1
    if (!slots.has(key)) slots.set(key, [])
    slots.get(key).push(line)
  }
  const matched = cursor > 0
  const out = []
  if (slots.has(-1)) out.push(...slots.get(-1))
  for (let i = 0; i < W.length; i++) {
    out.push(W[i])
    if (slots.has(i)) out.push(...slots.get(i))
  }
  return {
    text: out.join('\n'),
    extras,
    dropped,
    noOverlap: !matched && haveLines.length > 0,
  }
}

/** 把一份人设正文塞回 presetLines 里 `prefix: |` 那个块标量的位置（缩进照原文）。 */
function withMergedPersona(presetLines, mergedText) {
  const lines = presetLines.slice()
  const head = lines.findIndex((l) => /^\s+prefix:\s*\|/.test(l))
  if (head < 0) return lines
  const headIndent = (/^(\s*)/.exec(lines[head]) ?? ['', ''])[1].length
  const bodyStart = head + 1
  let end = bodyStart
  while (end < lines.length) {
    if (lines[end].trim() === '') {
      end += 1
      continue
    }
    const indent = (/^(\s*)/.exec(lines[end]) ?? ['', ''])[1].length
    if (indent <= headIndent) break
    end += 1
  }
  let bodyEnd = end
  while (bodyEnd > bodyStart && lines[bodyEnd - 1].trim() === '') bodyEnd -= 1
  let bodyIndent = headIndent + 2
  for (let i = bodyStart; i < bodyEnd; i++) {
    if (lines[i].trim() !== '') {
      bodyIndent = (/^(\s*)/.exec(lines[i]) ?? ['', ''])[1].length
      break
    }
  }
  const body = mergedText
    .split('\n')
    .map((l) => (l.trim() === '' ? '' : ' '.repeat(bodyIndent) + l))
  return [...lines.slice(0, bodyStart), ...body, ...lines.slice(bodyEnd)]
}

/** 读 `key: |` / `key: |-` 的块标量正文（按最小缩进剥掉公共缩进）。 */
function blockScalar(lines, lineIdx) {
  const base = (/^(\s*)/.exec(lines[lineIdx]) ?? ['', ''])[1].length
  const body = []
  for (let i = lineIdx + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '') { body.push(''); continue }
    if ((/^(\s*)/.exec(l) ?? ['', ''])[1].length <= base) break
    body.push(l)
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop()
  const heads = body.filter((l) => l.trim() !== '')
  const min = heads.length === 0 ? 0 : Math.min(...heads.map((l) => (/^(\s*)/.exec(l) ?? ['', ''])[1].length))
  return body.map((l) => (l.trim() === '' ? '' : l.slice(min))).join('\n')
}

// ── 随包的那份补丁（标准答案）────────────────────────────────────

let bundledCache = null
/** 随包 cordis.patch.yml 里的四个预设。读不出来返回 { ok:false, error }。 */
function bundledPresets() {
  if (bundledCache !== null) return bundledCache
  const text = readText(BUNDLED_PATCH)
  if (text === null) {
    bundledCache = { ok: false, error: `找不到插件自带的 ${path.basename(BUNDLED_PATCH)}，不知道该装哪几个预设。`, presets: [], text: '' }
    return bundledCache
  }
  const presets = parsePatchPresets(text)
  if (presets.length === 0) {
    bundledCache = { ok: false, error: '插件自带的 cordis.patch.yml 里解析不出 preset 项。', presets: [], text }
    return bundledCache
  }
  const bad = presets.filter((p) => !isSafePresetId(p.config.id))
  if (bad.length > 0) {
    bundledCache = {
      ok: false,
      error: `插件自带的预设里有一项 id 不合法（${bad.map((p) => p.config.id || p.id).join('、')}），不敢往盘上写。`,
      presets: [],
      text,
    }
    return bundledCache
  }
  bundledCache = { ok: true, error: '', presets, text }
  return bundledCache
}

/** 测试用：把随包补丁的缓存丢掉。 */
export function resetBundledCache() {
  bundledCache = null
}

// ── 判平面 ───────────────────────────────────────────────────────

/** 当前 profile 名：宿主 argv 里的 `<DSH_HOME>/profiles/<name>` → 环境变量 → 只有一个 profile 时就用它。 */
function currentProfileName(home, env) {
  const root = path.join(home, 'profiles')
  const rootLower = root.toLowerCase()
  for (const arg of (process.argv ?? [])) {
    const raw = String(arg ?? '')
    if (raw === '' || raw.indexOf('profiles') < 0) continue
    let resolved = ''
    try {
      resolved = path.resolve(raw).toLowerCase()
    } catch {
      continue
    }
    if (resolved !== rootLower && !resolved.startsWith(rootLower + path.sep)) continue
    const name = resolved.slice(rootLower.length + 1).split(path.sep)[0] ?? ''
    if (ID_RE.test(name)) return name
  }
  for (const key of ['DSH_PROFILE', 'DSH_PROFILE_NAME']) {
    const v = String(env?.[key] ?? '').trim()
    if (ID_RE.test(v)) return v
  }
  // argv 与环境变量都没有：只有一个 profile 的机器上，那就是它。
  // （桌面版命令行里带 profile 路径，正常情况下走不到这里。）
  try {
    const dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    if (dirs.length === 1 && ID_RE.test(dirs[0])) return dirs[0]
  } catch { /* 没有 profiles 目录 */ }
  return ''
}

/**
 * 宿主用哪套 preset 机制。
 * @returns {{plane:'profile'|'agent-presets', profile:string, patchFile:string, registryPresent:boolean, home:string, why:string}}
 */
/**
 * `agent-presets` 那个目录在哪。
 *
 * 默认是 `<home>/.agent-presets`。但宿主可以用 `DSH_AGENT_PRESETS_ROOT` 把它
 * 单独指到别处（容器、共享盘、测试机都这么干）。只按 home 拼，在那个宿主上
 * 就是「写进了一个没人读的目录」——预设装不上，卡照样进不了系统提示。
 * 指过去的值本身就叫 `.agent-presets` 时它就是那个目录；否则当成它的上一级。
 */
export function agentPresetsDir(home, env = process.env) {
  const configured = String(env?.DSH_AGENT_PRESETS_ROOT ?? '').trim()
  if (configured !== '') {
    let abs = ''
    try { abs = path.resolve(configured) } catch { abs = '' }
    if (abs !== '') return path.basename(abs) === '.agent-presets' ? abs : path.join(abs, '.agent-presets')
  }
  return path.join(path.resolve(home), '.agent-presets')
}

export function detectPresetPlane(home, env = process.env) {
  const h = path.resolve(home || presetHomeDir(env))
  const profile = currentProfileName(h, env)
  const patchFile = profile === '' ? '' : path.join(h, 'profiles', profile, 'cordis.patch.yml')
  let registryPresent = false
  const text = patchFile === '' ? null : readText(patchFile)
  if (text !== null) registryPresent = patchHasRegistry(text)
  const plane = registryPresent ? 'profile' : 'agent-presets'
  const why = registryPresent
    ? `profile「${profile}」的 cordis.patch.yml 里有 agent-preset-registry 段：预设是这个组合里的一行（桌面版机制）`
    : (profile === ''
      ? '没探测到 profile：按传统的 .agent-presets 目录处理'
      : `profile「${profile}」没有 agent-preset-registry 段：按 .agent-presets 目录处理`)
  return { plane, profile, patchFile, registryPresent, home: h, presetsDir: agentPresetsDir(h, env), why }
}

// ── 计划 ─────────────────────────────────────────────────────────

function upsertBlocks(text, items) {
  // 找一个 insert 块：优先「里面已经有 preset-* 项」的最后一个，否则最后一个 insert 块。
  const lines = String(text ?? '').split(/\r?\n/)
  if (text === '' || text === null) lines.length = 0
  const blocks = insertBlocks(lines)
  const target = blocks.filter((b) => b.hasPreset).pop() ?? blocks[blocks.length - 1] ?? null
  const prepared = []
  if (target === null) {
    for (const item of items) prepared.push(...item.lines)
    return `${text ?? ''}${text && !text.endsWith('\n') ? '\n' : ''}- insert:\n${prepared.join('\n')}\n`
  }
  // 插到块里最后一个非空行之后（尾部空行留着，别把文件和下一个块粘起来）。
  let at = target.end
  while (at > target.start + 1 && lines[at - 1].trim() === '') at -= 1
  const indent = target.itemIndent >= 0 ? target.itemIndent : 4
  for (const item of items) {
    const delta = indent - item.baseIndent
    for (const raw of item.lines) {
      if (raw.trim() === '') { prepared.push(''); continue }
      prepared.push(delta >= 0 ? ' '.repeat(delta) + raw : raw.slice(-delta))
    }
  }
  const out = [...lines.slice(0, at), '', ...prepared, ...lines.slice(at)]
  return out.join('\n')
}

/**
 * 只读盘面，算出「该做什么」。不写盘。
 * @returns {{ok:boolean, error?:string, home:string, plane:string, profile:string, patchFile:string,
 *            actions:Array<object>, notes:string[], presets:Array<object>}}
 */
export function planInstall({ home, env = process.env } = {}) {
  const plane = detectPresetPlane(home, env)
  const bundle = bundledPresets()
  const notes = []
  const actions = []
  const presets = []
  if (bundle.ok !== true) {
    return { ok: false, error: bundle.error, home: plane.home, plane: plane.plane, profile: plane.profile, patchFile: plane.patchFile, actions: [], notes, presets: [] }
  }

  if (plane.plane === 'profile') {
    const file = plane.patchFile
    const text = file === '' ? null : readText(file)
    if (text === null) {
      return {
        ok: false,
        error: `找不到 profile 的组合文件（${file || '没探测到 profile'}）。这个 profile 还没被宿主建过，这次什么都没动。`,
        home: plane.home,
        plane: plane.plane,
        profile: plane.profile,
        patchFile: file,
        actions: [],
        notes,
        presets: [],
      }
    }
    const installed = new Map(parsePatchPresets(text).map((p) => [p.id, p]))
    const missing = []
    for (const want of bundle.presets) {
      const have = installed.get(want.id) ?? null
      const wantPrefix = want.config.persona?.prefix ?? ''
      const havePrefix = have?.config.persona?.prefix ?? ''
      const sameId = have !== null && have.config.id === want.config.id
      // 三方对账：插件新版 / 用户盘上那份 / 用户自己额外写的行。
      const merged = have === null ? null : mergePersonaPrefix(wantPrefix, havePrefix)
      // 盘上那份**已经等于**「插件新版 + 用户自己的行」时就不用动了（写完第二遍必须幂等）。
      const upToDate = merged !== null && !merged.noOverlap && merged.text === havePrefix
      const stale = have !== null && (sameId !== true || merged.noOverlap || !upToDate)
      // 差的部分全是插件自己的旧文案，用户一个字没写 → 可以直接换，不用问。
      const onlyOldBundled = have !== null
        && sameId === true
        && merged.noOverlap !== true
        && merged.extras.length === 0
        && merged.dropped.length > 0
      // 用户真写过东西 → 保留他的行，只把插件那部分换成新版。
      const userEdited = have !== null && sameId === true && merged.noOverlap !== true && merged.extras.length > 0
      presets.push({
        id: want.config.id,
        planeId: want.id,
        name: have?.config.name || want.config.name,
        installed: have !== null,
        stale,
        edited: userEdited,
        where: file,
      })
      if (have === null) {
        missing.push({
          type: 'append-preset',
          id: want.id,
          presetId: want.config.id,
          name: want.config.name,
          where: file,
          auto: true,
          lines: want.presetLines,
          baseIndent: want.baseIndent,
        })
      } else if (stale && merged.noOverlap) {
        // 整段人设被重写过，认不出哪句是谁的 —— 这种只能在界面上让用户点头。
        actions.push({
          type: 'update-preset',
          id: want.id,
          presetId: want.config.id,
          name: want.config.name,
          where: file,
          auto: false,
          lines: want.presetLines,
          baseIndent: want.baseIndent,
        })
        notes.push(`「${want.config.name || want.id}」的人设和插件这一版对不上（像是整段重写过）。没动它；要换成插件这一版，点「更新预设」。`)
      } else if (stale) {
        // 插件换了文案，或者用户在插件那份上加过自己的字：都自动更新，但用合并后的
        // 正文 —— 用户写的行原样留着，插件那几句换成新版。
        actions.push({
          type: 'update-preset',
          id: want.id,
          presetId: want.config.id,
          name: want.config.name,
          where: file,
          auto: true,
          lines: onlyOldBundled ? want.presetLines : withMergedPersona(want.presetLines, merged.text),
          baseIndent: want.baseIndent,
        })
        if (userEdited) {
          notes.push(`「${want.config.name || want.id}」里你自己写的 ${merged.extras.length} 行会原样留着，插件那部分换成新版。`)
        } else {
          notes.push(`「${want.config.name || want.id}」还是插件上一版的文案，会换成新版（你自己加的字不受影响）。`)
        }
      }
    }
    // 缺的排在前面（启动时先补缺的），更新类保持 auto:false。
    actions.unshift(...missing)
    if (missing.length > 0) {
      notes.push(`这个 profile 里缺 ${missing.length} 个 LC 预设（${missing.map((a) => a.presetId).join('、')}），会追加到 ${path.basename(file)} 的 insert 块末尾。`)
    }
    if (actions.length === 0) notes.push('四个 LC 预设都在，不用动。')
    return { ok: true, home: plane.home, plane: plane.plane, profile: plane.profile, patchFile: file, presetsDir: plane.presetsDir, actions, notes, presets }
  }

  // agent-presets 平面：一个预设一个目录。
  const base = plane.presetsDir
  for (const want of bundle.presets) {
    const id = want.config.id
    if (!isSafePresetId(id)) {
      return { ok: false, error: `预设 id 不合法：${id}`, home: plane.home, plane: plane.plane, profile: plane.profile, patchFile: plane.patchFile, presetsDir: plane.presetsDir, actions: [], notes, presets }
    }
    const dir = path.join(base, id)
    const files = presetFiles(want)
    const same = files.every((f) => (readText(path.join(dir, f.name)) ?? '') === f.text)
    presets.push({ id, planeId: want.id, name: want.config.name, installed: same, stale: false, where: dir })
    if (!same) {
      actions.push({ type: 'create-preset-dir', id, presetId: id, name: want.config.name, where: dir, auto: true, files })
    }
  }
  if (actions.length === 0) notes.push('四个 LC 预设在 .agent-presets 里都齐了，不用动。')
  else notes.push(`这个宿主按 .agent-presets 目录认预设，要建 ${actions.length} 个目录：${actions.map((a) => a.id).join('、')}。`)
  return { ok: true, home: plane.home, plane: plane.plane, profile: plane.profile, patchFile: plane.patchFile, presetsDir: plane.presetsDir, actions, notes, presets }
}

// ── agent-presets 平面要写的两个文件 ───────────────────────────────

function presetFiles(want) {
  const cfg = want.config
  const yaml = cfg.pluginsYaml === '' ? '' : `${cfg.pluginsYaml}\n`
  const agent = [
    `# dsh-lifecard 的 agent preset：${cfg.name || cfg.id}`,
    '# 由 dsh-lifecard 插件写入（来源：插件自带的 cordis.patch.yml）。',
    '# 要改这个预设，改插件里那份再让插件重写一次，或者直接改这里（插件只在内容不一致时重写）。',
    '',
    yaml.trimEnd(),
    '',
  ].join('\n')
  const meta = [
    `name: '${yamlQuote(cfg.name || cfg.id)}'`,
    `description: '${yamlQuote(cfg.description || '')}'`,
    `order: ${Number.isFinite(cfg.order) ? cfg.order : 9}`,
    '',
  ].join('\n')
  return [
    { name: 'agent.cordis.yml', text: agent },
    { name: 'preset.yml', text: meta },
  ]
}

/** 单引号标量：内部的单引号翻倍。 */
function yamlQuote(value) {
  return String(value ?? '').replace(/'/g, "''")
}

// ── 落盘 ─────────────────────────────────────────────────────────

function stateFile(home) {
  return path.join(home, 'plugin-data', STATE_NAME)
}

export function readInstallState(home) {
  const h = path.resolve(home || presetHomeDir())
  const text = readText(stateFile(h))
  if (text === null) return null
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

function writeInstallState(home, plane, presets) {
  const body = {
    installedAt: new Date().toISOString(),
    plane,
    presets: presets.map((p) => ({ id: p.id, planeId: p.planeId, where: p.where })),
  }
  writeAtomic(stateFile(home), `${JSON.stringify(body, null, 2)}\n`)
}

/**
 * 落盘。只做 plan 里的动作；`auto: false` 的（用户手改过的预设）默认跳过，
 * 界面上的按钮要更新时传 `allowUpdates: true`。
 * @returns {{ok:boolean, written:string[], errors:string[]}}
 */
export function applyInstall(plan) {
  const written = []
  const errors = []
  if (plan === null || typeof plan !== 'object' || plan.ok !== true) {
    return { ok: false, written, errors: [plan?.error ?? '没有可执行的安装计划。'] }
  }
  const home = path.resolve(plan.home || presetHomeDir())
  const allowUpdates = plan.allowUpdates === true
  const todo = (Array.isArray(plan.actions) ? plan.actions : []).filter((a) => a.auto !== false || allowUpdates)

  if (plan.plane === 'profile') {
    if (todo.length > 0) {
      const file = plan.patchFile
      if (file === '' || !existsSync(file)) {
        errors.push(`找不到 profile 的组合文件（${file || '未探测到'}），没动它。`)
      } else {
        const before = readText(file) ?? ''
        const next = editPatch(before, todo, errors)
        if (next !== null) {
          try {
            writeWithBackup(file, next)
            const after = readText(file)
            const bad = verifyPatchEdit(before, after, todo, plan.presets)
            if (bad !== '') {
              writeAtomic(file, before)
              errors.push(`${bad}已回滚，你的组合文件没变。`)
            } else {
              written.push(file)
            }
          } catch (error) {
            try { writeAtomic(file, before) } catch { /* 回滚失败也只能到此为止 */ }
            errors.push(`写 ${path.basename(file)} 没成功：${error?.message ?? error}`)
          }
        }
      }
    }
  } else {
    for (const action of todo) {
      const id = String(action.id ?? '')
      if (!isSafePresetId(id)) {
        errors.push(`预设 id 不合法（${id || '空'}），跳过。`)
        continue
      }
      const dir = path.join(plan.presetsDir || agentPresetsDir(home), id)
      try {
        mkdirSync(dir, { recursive: true })
        for (const file of (Array.isArray(action.files) ? action.files : [])) {
          const target = path.join(dir, file.name)
          if ((readText(target) ?? '') === file.text) continue
          writeWithBackup(target, file.text)
          written.push(target)
        }
      } catch (error) {
        errors.push(`建 ${id} 这个预设没成功：${error?.message ?? error}`)
      }
    }
  }

  if (written.length > 0) {
    try {
      writeInstallState(home, plan.plane, Array.isArray(plan.presets) ? plan.presets : [])
    } catch (error) {
      // 状态文件只是给界面看的，写不上不影响预设本身。
      errors.push(`预设已经写好了，但状态文件没写成：${error?.message ?? error}`)
    }
  }
  return { ok: errors.length === 0, written, errors }
}

/**
 * 把动作改进补丁文本：缺的追加，stale 的整段替换。
 * 拼不出来返回 null（原因进 errors）。
 */
function editPatch(before, actions, errors) {
  let text = before
  // 先替换（按 blockStart 从后往前，前面替换不会让后面的行号漂移），再追加。
  const updates = actions
    .filter((a) => a.type === 'update-preset' && Array.isArray(a.lines) && a.lines.length > 0)
    .map((a) => ({ action: a, span: parsePatchPresets(text).find((p) => p.id === a.id) ?? null }))
    .filter((x) => x.span !== null)
    .sort((x, y) => y.span.blockStart - x.span.blockStart)
  for (const { action, span } of updates) {
    const all = text.split(/\r?\n/)
    // lines 带着插件自带补丁里的原始缩进，整段平移到这里要求的层级。
    // 锚点取第一行非空行的缩进，不是每行各自对齐 baseIndent（那样会把
    // 第二层、第三层的缩进全压平，人设就解析不出来了）。
    const firstText = action.lines.find((l) => l.trim() !== '') ?? ''
    const anchor = (/^(\s*)/.exec(firstText) ?? ['', ''])[1].length
    const delta = span.baseIndent - anchor
    const repl = action.lines.map((raw) => {
      if (raw.trim() === '') return ''
      if (delta === 0) return raw
      if (delta > 0) return ' '.repeat(delta) + raw
      return raw.length > -delta ? raw.slice(-delta) : raw.trim()
    })
    text = [...all.slice(0, span.blockStart), ...repl, ...all.slice(span.blockEnd)].join('\n')
  }

  const appends = actions.filter((a) => a.type === 'append-preset')
  for (const action of appends) {
    if (!Array.isArray(action.lines) || action.lines.length === 0) {
      errors.push(`「${action.presetId ?? action.id}」这一段拼不出来（插件自带的补丁里没有它），跳过。`)
    }
  }
  const items = appends
    .filter((a) => Array.isArray(a.lines) && a.lines.length > 0)
    .map((a) => ({ lines: a.lines, baseIndent: Number(a.baseIndent) || 4 }))
  if (items.length > 0) {
    try {
      text = upsertBlocks(text, items)
    } catch (error) {
      errors.push(`拼补丁时出错：${error?.message ?? error}`)
      return null
    }
  }
  if (items.length === 0 && updates.length === 0) {
    if (errors.length === 0) errors.push('没有要改的预设。')
    return null
  }
  return text
}

/** 写后自检：改完还能解析出四项、每个动过的项都对得上、没混进制表符。 */
function verifyPatchEdit(before, after, actions, presets) {
  if (after === null) return '写完读不回来，'
  if (/\t/.test(after.replace(before, ''))) return '新增部分含制表符（YAML 会解析失败），'
  const got = parsePatchPresets(after)
  const byId = new Map(got.map((p) => [p.id, p]))
  for (const action of actions) {
    const hit = byId.get(action.id)
    if (hit === undefined) return `写完解析不出 ${action.id}，`
    if (action.type === 'update-preset' && hit.config.persona === null) return `${action.id} 改完人设不见了，`
  }
  // 没动过的那几项必须还是原样（防止拼错位置把邻项吃掉）。
  for (const preset of (Array.isArray(presets) ? presets : [])) {
    const touched = actions.some((a) => a.id === preset.planeId)
    if (touched || preset.installed !== true || preset.stale === true) continue
    const was = parsePatchPresets(before).find((p) => p.id === preset.planeId)
    const now = byId.get(preset.planeId)
    if (was !== undefined && now !== undefined && was.config.persona?.prefixLength !== now.config.persona?.prefixLength) {
      return `没打算动 ${preset.id}，但它被改了，`
    }
  }
  return ''
}
