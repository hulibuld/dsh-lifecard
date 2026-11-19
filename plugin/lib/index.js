/**
 * dsh-lifecard —— 宿主侧（Node）。
 *
 * 职责只有两件：
 *   1. 把工作区的文件操作暴露成一组 HTTP 路由（浏览器侧不能碰文件系统）
 *   2. 调模型做「材料 → 提案」，然后走引文校验门
 *
 * 业务逻辑全在 store.js / core.js / codec.js 里，这里只做路由和编排。
 * 没有 UI、没有 DOM、没有会话事件。
 */

import z from '@deepseek-ai/schemastery'
import path from 'node:path'
import { promises as fs, readFileSync, statSync, readdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import * as core from './core.js'
import * as codec from './codec.js'
import * as store from './store.js'
import * as persona from './persona.js'
import * as cardtext from './cardtext.js'
// 剧本引擎层（lib/story.js）。和卡文本一样是静态 import：它不是「可以整个删掉」
// 的独立功能，而是文字游戏门底下的一层——剧本格式、旗标、十一个玩法引擎都在里面。
// 走按需加载反而要在 game.say 里多一层「模块没加载」的分支，而它只依赖 node 内建。
import * as story from './story.js'
// 伏笔账本（lib/foreshadow.js）。和卡文本、散文一样是静态 import：
// 它不是「可以整个删掉」的功能，只是写小说用的一份库；而且账本读不出来时
// 这一章照样得写，走按需加载反而多一层「模块没加载」的分支要判断。
import * as foreshadow from './foreshadow.js'
import * as prose from './prose.js'
import * as prompts from './prompts.js'
import * as diary from './diary.js'
// 自动补日记。和 career/tavern/presets 不一样，这个模块是静态 import：
// 后台巡检要在插件 apply 的那一刻就拿到它，等不了「用到才 ensureModules」。
// 它自己只依赖 node:fs / os / zlib，不带重依赖，随包加载没有代价。
import * as autoDiary from './auto-diary.js'
import * as resumeCoach from './resume.js'
// 读书那部分的桥（lib/reading.js）。
//
// 和 tavern/novel 那些不一样，这个是静态 import：它只依赖 node:内建，
// 而且「有没有装 dsh-reading」是运行时才发现的事（对面根本没装也要能如实说），
// 不能靠「import 失败」来表达——那两种情况在用户眼里是不一样的。
import * as reading from './reading.js'

import * as score from './score.js'
import * as memory from './memory.js'
import * as jobs from './jobs.js'
import * as jobsStore from './jobs-store.js'
import * as interview from './jobs-interview.js'
// 这四个是「可以整个删掉」的功能模块：酒馆、写小说、预设、文字游戏。
// 用「用到才加载」而不是文件顶上的静态 import —— 静态 import 一个不存在的
// 文件会让整个插件起不来，那就不是「能删」而是「删了就全废」。
// 删掉对应文件之后，只有那个功能报「这个功能没装」，别的照常。
import * as lifecardTools from '../lifecard-tools.js'

let tavern = null
let novel = null
let presets = null
let game = null
let career = null
/**
 * 选项块模块（lib/choices.js）。同样是「用到才加载」：它只管字符串，
 * 拿不到就是「这一轮末尾不给方向」，别的照常。
 */
let choices = null
/**
 * 拆书模块（lib/cast.js）。
 *
 * 这个文件以前写完了却一直没接线：`lib/index.js` 里那个同名的 `gatherCast`
 * 是「一场对话里出现过的人」，和「把一本书拆成世界观＋人物卡」是两件事。
 * 两个东西名字撞在一起，于是 cast.js 静静地躺着没人用。所以这里叫 cast，
 * 导入的也是 './cast.js'，跟下面那个函数区分开。
 */
let cast = null
/** 预设安装模块（lib/preset-install.js）。同样按需加载，文件被删也不能拖垮插件。 */
let presetInstall = null
/**
 * 判门模块（lib/intent.js）。
 *
 * 同样按需加载：它只是一个纯函数，删掉它最多少一个「帮你挑门」的便利，
 * 四扇门本来就摆在那儿，不能让整个插件跟着起不来。
 */
let intent = null
/** 哪个功能没装（给用户看的名字）。 */
const FEATURE_NAMES = { tavern: '酒馆', novel: '写小说', presets: '预设', game: '文字小说游戏', career: '简历与规划', cast: '拆书', choices: '选项' }
/** 四扇门的代号。挑卡（`default_cards`）和挑注入哪几节（`persona_sections`）都按它存。 */
const DOORS = ['real', 'tavern', 'novel', 'diary']
/**
 * 界面上能收起来 / 装回来的门。
 *
 * 为什么不直接用上面那个 `DOORS`：那一串是**卡挂在哪扇门**的键（挑卡、
 * 挑注入哪几节都按它存），而这里这一串是**门牌**。两者现在不完全重合——
 * 「玩一段」有自己的屏和存档，但它不挂卡，所以不在 `DOORS` 里；反过来
 * `DOORS` 的每一项都得有门牌，不然卡能被挑到一扇看不见的门上。
 */
const DOOR_SWITCHES = ['real', 'novel', 'diary', 'game', 'tavern']
/**
 * 按需把四个模块加载进来。已经加载过的不会重复加载。
 * @returns {Promise<Record<string, boolean>>} 每个模块现在在不在
 */
async function ensureModules() {
  if (tavern === null) tavern = await import('./tavern.js').catch(() => null)
  if (novel === null) novel = await import('./novel.js').catch(() => null)
  if (presets === null) presets = await import('./presets.js').catch(() => null)
  if (game === null) game = await import('./game.js').catch(() => null)
  if (career === null) career = await import('./career.js').catch(() => null)
  if (cast === null) cast = await import('./cast.js').catch(() => null)
  if (choices === null) choices = await import('./choices.js').catch(() => null)
  return { tavern: tavern !== null, novel: novel !== null, presets: presets !== null, game: game !== null, career: career !== null, cast: cast !== null, choices: choices !== null }
}

/**
 * 把预设安装模块拉起来。
 *
 * 用 `import()` 而不是文件顶上的静态 import：这个模块会往 DSH_HOME 里写字，
 * 而且它坏了也只是「预设没装上」，不该让整个插件起不来。删掉那个文件时
 * 返回 null，两条预设路由会各自回一句人话。
 */
async function ensurePresetInstall() {
  if (presetInstall === null) presetInstall = await import('./preset-install.js').catch(() => null)
  return presetInstall
}

/** 把判门模块拉起来。理由同上：它坏了只是少个便利，不是插件起不来。 */
async function ensureIntent() {
  if (intent === null) intent = await import('./intent.js').catch(() => null)
  return intent
}
/** 这个功能没装的时候，统一回一句人话。 */
function missingFeature(name) {
  const label = FEATURE_NAMES[name] ?? name
  return { ok: false, error: `「${label}」这个功能没装（对应的文件被删掉了）。别的功能不受影响。`, missingFeature: name }
}
export const name = 'dsh-lifecard'

/** 需要宿主提供的服务。缺 webServer 就什么都不做（明确失败胜过静默半死）。 */
export const inject = ['webServer']

/**
 * 插件配置。
 *
 * 必须是 schemastery schema：cordis 的 resolveConfig 读 `Config["~standard"].validate`，
 * 传普通对象会抛 `Cannot read properties of undefined (reading 'validate')`。
 * （这条实测过，不是凭印象。）
 */
const Schema = z.object({
  workspace: z.string().default(''),
  defaultAnalysisModel: z.string().default(''),
  // 几个「多大算太大」的上限。写死在代码里的时候，遇到大一点的卡（带世界书、
  // 带对话示例）只能改源码；做成配置就只是改一行数字，而且各项分开算：
  // 请求体要宽松（一次导入几十张卡），头像和纯文字文件要严（正常远小于这个）。
  maxBodyMB: z.number().min(1).max(512).default(64),
  maxAvatarMB: z.number().min(1).max(64).default(8),
  maxTextFileMB: z.number().min(1).max(64).default(8),
})

export const Config = Schema

/** 默认工作区在用户目录下，首次打开时可由界面改写。 */
function defaultWorkspace() {
  return path.join(homedir(), 'LifeCard')
}

/**
 * 导入角色卡允许的后缀。
 *
 * codec 是按文件签名认格式的，所以把 .exe 改名成 .json 也能蒙混进去；
 * 导入框实际只该收这几种。没有后缀的照样放行——有些导出工具就不带。
 */
const IMPORT_CARD_EXT = new Set(['.png', '.json', '.charx', '.zip', '.txt', '.md', '.markdown'])

/** 当前工作区：每次调用都从配置里现取，不往模块级塞状态。 */
/** 把配置里的 MB 换算成字节；配置坏了（不是正数）就用兜底值，不让一个手滑把上限变成 0。 */
function mbToBytes(value, fallbackMB) {
  const n = Number(value)
  const mb = Number.isFinite(n) && n > 0 ? n : fallbackMB
  return Math.floor(mb * 1024 * 1024)
}

function currentWorkspace(config) {
  const configured = typeof config?.workspace === 'string' && config.workspace.trim() !== '' ? config.workspace.trim() : ''
  return configured !== '' ? path.resolve(configured) : defaultWorkspace()
}

// ── 「上次选的文件夹」记在哪儿 ─────────────────────────────────────
// 配置对象只活在内存里：workspace.init 改完，重启就回落到「用户目录/LifeCard」。
// 用户第二天打开会看到一个空的库，以为档案丢了——所以另存一份小指针文件。
// 只存一个路径，卡、材料、世界书都还在用户自己选的文件夹里，不搬也不复制。

/** DSH 的根目录：优先 DSH_HOME，否则 ~/.dsh。 */
function dshHome() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return configured !== '' ? path.resolve(configured) : path.join(homedir(), '.dsh')
}

/** 指针文件的位置。参数只是为了测试能指到临时目录，正常调用不用传。 */
export function workspacePointerFile(home) {
  return path.join(typeof home === 'string' && home !== '' ? home : dshHome(), 'plugin-data', 'dsh-lifecard.json')
}

/** 取回上次选的文件夹。读不到、坏了、不是字符串，一律当没选过。 */
export async function recallWorkspace(file) {
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    const ws = typeof parsed?.workspace === 'string' ? parsed.workspace.trim() : ''
    return ws === '' ? '' : path.resolve(ws)
  } catch {
    return ''
  }
}

/** 记下这次选的文件夹。记不住不该让「选文件夹」这一步失败，只留一条日志。 */
export async function rememberWorkspace(file, ws) {
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, `${JSON.stringify({ workspace: ws }, null, 2)}\n`, 'utf8')
    return { ok: true }
  } catch (error) {
    console.error('[lifecard] 没能记住这次选的文件夹：', error)
    // 以前直接回 error.message，界面上是 `EACCES: permission denied, open ...`
    // 这种英文。同一套人话转换别的地方在用，这里也走一遍。
    return { ok: false, error: humanizeHostError(error) }
  }
}

// ── HTTP 小工具 ────────────────────────────────────────────────────

function writeJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readBody(req, limit = mbToBytes(64, 64)) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('发过去的请求格式不对，重新试一次')
  }
}

/**
 * 把宿主抛出来的错误翻成人话。
 *
 * 规则与 lib/client.js 的 humanizeError 是同一套（浏览器包是自包含的，不能
 * require 这一份；改一边要同步另一边）。最后一道判英文：EISDIR / ENOTDIR
 * 这类 errno 不在上面的表里，翻不掉就统一压成一句通用中文，绝不上屏。
 */
function humanizeHostError(input) {
  const raw0 = String(input?.message ?? input ?? '').trim()
  if (raw0 === '' || raw0 === '[object Object]') return '这一步没做成，再试一次看看。'
  const raw = raw0.replace(/^[A-Za-z]*Error:\s*/i, '').replace(/^Exception:\s*/i, '').trim()
  if (/fetch failed|failed to fetch|networkerror|econnrefused|enotfound|load failed|network request failed/i.test(raw)) {
    return '连不上后台。可能是软件刚启动还没准备好，等几秒再试一次。'
  }
  if (/chara|ccv3|ccv2|chunk|charx|tEXt/i.test(raw)) {
    return '这个文件里读不出角色信息。它可能不是角色卡，或者文件已经坏了。'
  }
  if (/enoent|no such file|不是文件夹|文件夹不存在/i.test(raw)) return '找不到那个位置了。它可能刚被移走或改名了，重新选一次。'
  if (/eacces|eperm|permission|没有权限/i.test(raw)) return '没有权限动这个位置。换一个文件夹再试。'
  if (/enospc|no space|磁盘满/i.test(raw)) return '磁盘满了，存不进去。清一点空间再试。'
  if (/error|exception|undefined|null|nan|\[object/i.test(raw)) return '这一步没做成。等一会儿再试一次；还不行就重启一下软件。'
  if (/[{}\[\]<>]/.test(raw)) return '这一步没做成。等一会儿再试一次；还不行就重启一下软件。'
  // 跨盘搬东西（EXDEV）和「同时开的文件太多」（EMFILE）以前会掉到最后的 return raw，
  // 界面上一行英文谁看都不懂。这两类常见，单独给一句话。
  if (/exdev|cross-device|invalid cross-device/i.test(raw)) {
    return '这个文件在另一块盘上，没法直接搬过去。把它复制到当前文件夹里再试一次。'
  }
  if (/emfile|enfile|too many open files/i.test(raw)) return '同时打开的文件太多了，等几秒再试一次；还不行就重启一下软件。'
  if (/enotempty|directory not empty/i.test(raw)) return '那个文件夹里还有东西，删不干净。先把里面的文件清掉再试。'
  if (/eisdir|illegal operation on a directory/i.test(raw)) return '这里要的是文件，给的是文件夹。换一个再试。'
  if (/erofs|read-only file system/i.test(raw)) return '这个位置是只读的，写不进去。换一个文件夹再试。'
  // 还剩英文（别的 errno）：规则表没覆盖，也不能原样露给用户。
  if (/[A-Za-z]{3,}/.test(raw)) return '后台没做成这一步，等一会儿再试一次；还不行就重启软件。'
  return raw
}

/**
 * 原子写一个文件：先写同目录下的临时文件，再 rename 过去。
 *
 * 直接 `fs.writeFile(abs, …)` 有两个毛病：写到一半断电/被杀，目标文件就是半截；
 * 同一时刻另一个请求也在写，两边交错着写同一份文件，内容会烂。rename 在同一
 * 个文件系统里是原子的，所以读者要么看到旧的一整份，要么看到新的一整份。
 * 临时文件写在同一个目录里（不写 tmpdir）：跨盘 rename 会 EXDEV，那就退回直接写。
 */
async function writeFileAtomic(abs, data) {
  const dir = path.dirname(abs)
  const tmp = path.join(dir, `.${path.basename(abs)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  try {
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, abs)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    // EXDEV（临时目录和目标不在同一块盘）不该让整件事失败——退回一次直写，
    // 丢的是原子性，不是这份文件本身。
    if (error?.code === 'EXDEV') return fs.writeFile(abs, data)
    throw error
  }
}

/**
 * 把界面传来的相对路径钉在工作区内。
 *
 * 以前 card.get / card.save / card.delete / export.* 直接拿 `body.path` 去
 * `path.join(root, rel)`，于是 `../别的目录/x.card.md` 能读到工作区外的文件，
 * `card.save` 甚至能凭空在工作区外落一个文件——工作区是用户挑的一个文件夹，
 * 卡的路径本来就该在它里面。越界一律当成路径错误，不做「修正」。
 *
 * 返回的 error 是**已经能直接塞进响应**的对象（code + message），每条路由都不用
 * 自己拼文案。文案里不出现 workspace 这类内部词——它会原样显示在界面上。
 *
 * @param {string} ws - 工作区绝对路径。
 * @param {unknown} rel - 请求里给的相对路径。
 * @returns {{ ok: true, rel: string } | { ok: false, error: { code: string, message: string } }}
 */
async function insideWorkspace(ws, rel) {
  const raw = String(rel ?? '')
  const bad = (message) => ({ ok: false, error: { code: 'bad-path', message } })
  if (raw.trim() === '') return bad('路径不合法：没有给出文件。')
  // 绝对路径直接拒绝（Windows 的 X:\ 也算，path.isAbsolute 认它）。
  if (path.isAbsolute(raw)) return bad('路径不合法：只能是这个文件夹里的相对路径。')
  const base = path.resolve(ws)
  const abs = path.resolve(base, raw)
  // 判「相等或以 base + 分隔符开头」，不能用裸 startsWith(base)：
  // /tmp/ws-evil 会被 /tmp/ws 的前缀匹配放过（HANDOFF 坑 #6 的同一个形状）。
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    return bad('路径不合法：这个文件不在当前文件夹里。')
  }
  // 字面包含判断只管得住 `../` 和前缀，管不住符号链接：工作区里有个指向
  // 别处的软链，下面照这个路径读写就真的出界了。按实体路径再判一次。
  const realBase = await store.realpathLoose(base)
  const realTarget = await store.realpathLoose(abs)
  if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) {
    return bad('路径不合法：这个文件不在当前文件夹里。')
  }
  return { ok: true, rel: path.relative(base, abs).split(path.sep).join('/') }
}

/**
 * 导出前的硬门禁（SPEC §6）。返回 null 表示放行，否则返回错误文案。
 *
 * 只拦确定无疑的四条：
 *   1. `lens` 永不可导出；
 *   2. `consent.basis: fictional` 不能用在 `kind: real / self` 上；
 *   3. `basis: family-agreed` 必须有 `recorded_at`，否则导出器拒绝；
 *   4. `kind: real` 且 `birth_year` 未满 18 岁 → 禁止导出 PNG。
 *
 * 刻意**不拦**「real 完全没填 consent」：SPEC §6 的表格里 real 的「本地保存」一栏是
 * 「不需要」，而本插件的导出产物只落回用户自己的磁盘。把这条做成硬门禁会让
 * 一张还没填同意状态的卡连本地备份都导不出来，而它恰恰是最需要先备份的时候。
 * `format` 用来区分：只有 `png` 受未成年人那条约束（PNG 最容易被二次转发）。
 *
 * lens 与 consent 那三条 PNG / JSON 都要过；只有未成年人那条按 format 区分——
 * PNG 是随手就能转发出去的格式，JSON 是留给自己的档。
 *
 * @param {any} data - 卡数据。
 * @param {'png'|'json'} format
 * @returns {{ code: string, message: string } | null}
 */
function exportBlockedBy(data, format) {
  const kind = String(data?.kind ?? '')
  if (kind === 'lens') {
    return {
      code: 'not-exportable',
      message: '这是「我的偏好」那张卡，按设计不能导出给别人。',
    }
  }
  const consent = data?.consent
  if (consent !== null && typeof consent === 'object') {
    if (String(consent.basis) === 'fictional' && (kind === 'real' || kind === 'self')) {
      return {
        code: 'consent-required',
        message: '这张卡写的是真人，但不能把「对方是虚构的」当成同意。要么去拿到同意，要么把这张卡改成虚构人物。',
      }
    }
    if (String(consent.basis) === 'family-agreed' && (consent.recorded_at === undefined || String(consent.recorded_at).trim() === '')) {
      return {
        code: 'consent-incomplete',
        message: '家属同意了，还要填上同意的日期才能导出。',
      }
    }
  }
  if (format === 'png' && kind === 'real') {
    const by = data?.birth_year
    if (typeof by === 'number' && by > 1900) {
      const age = new Date().getFullYear() - by
      if (age < 18) {
        return {
          code: 'minor-no-png',
          message: '这张卡的对象未满 18 岁（出生年 ' + String(by) + '），不能存成图片——图片是最容易被随手转发的格式。要留档请用「存成数据文件」。',
        }
      }
    }
  }
  return null
}

// ── 模型调用 ──────────────────────────────────────────────────────

/**
 * 一次模型请求最多等这么久。
 *
 * 为什么要有：模型偶尔会「不回话」——不出错，也不结束，就那么挂着。
 * 没有上限的话界面上的「分析」会一直转，用户不知道是在算还是已经死了。
 * 实测过一次两分钟以上没动静：那不是慢，那是断了，得让它自己认输。
 */
const MODEL_TIMEOUT_MS = 150000

/** 给一个 Promise 加上限时。超时抛出来，由调用方当一次失败处理，去试下一条路由。 */
function withTimeout(promise, ms, what) {
  let timer = null
  const limit = new Promise((_, reject) => {
    // 不要把定时器 unref 掉：在脚本里（事件循环里没有别的东西）unref 的定时器
    // 不会被等到，await 会永远悬着。定时器在 finally 里清，不会拖住进程。
    timer = setTimeout(() => reject(new Error(`${what}等了 ${Math.round(ms / 1000)} 秒还没有回话`)), ms)
  })
  return Promise.race([promise, limit]).finally(() => { if (timer !== null) clearTimeout(timer) })
}


/**
 * 调宿主模型做一次分析。
 *
 * 真实 API 是 `ctx.llm.stream({ provider, model, messages, system })`——**必须显式给
 * provider 与 model**，没有「自动选默认模型」这回事。所以按这个顺序找路由：
 *
 *   1. 插件 config 里显式写的 `defaultAnalysisModel`（形如 `provider/model`）
 *   2. 宿主已注册的 provider 列表里第一个
 *   3. 都找不到就明确报错，不假装成功
 *
 * 这样用户不需要配任何 key：用的就是他 DSH 里已经接好的模型。
 *
 * @param {any} ctx
 * @param {{ system: string, user: string, model?: string }} input
 */
async function callModel(ctx, input, options = {}) {
  const llm = ctx.get?.('llm')
  if (llm === undefined || llm === null) {
    return { ok: false, error: '这台机器上暂时没有可用的 AI。你可以在卡片里直接手写，效果一样。' }
  }
  if (typeof llm.stream !== 'function') {
    return { ok: false, error: '软件版本对不上，AI 用不了。可以先在卡片里直接手写。' }
  }
  const route = await resolveRoute(llm, input.model)
  if (route.provider === undefined) {
    return { ok: false, error: route.error ?? '这台机器上还没有配好能用的 AI。你可以在卡片里直接手写，效果一样。' }
  }
  // 注意 messages 的 content 必须是**内容块数组**，不能是裸字符串：
  // 传字符串时报 `content.some is not a function`（适配器在入口就假定它是数组）。
  const messages = [{ role: 'user', content: [{ type: 'text', text: input.user }] }]
  // 有人接就一段一段递出去（酒馆的流式用），没人接就只是攒着——
  // 所以这个参数不影响任何老调用点。
  const onDelta = typeof options?.onDelta === 'function' ? options.onDelta : null
  const attempts = []
  // 候选：先试首选，失败再试剩下的（transport 错误在各 provider 之间不通用）
  const candidates = [route]
  for (const p of await listCandidateRoutes(llm, route)) candidates.push(p)
  for (const candidate of candidates) {
    let handle = null
    let pending = null
    // 这一条路由已经往外吐过字没有。吐过就不能换路由重来，见下面 catch 里那段。
    let emitted = false
    try {
      pending = llm.stream({
        provider: candidate.provider,
        model: candidate.model,
        system: input.system,
        messages,
        temperature: 0.2,
        maxTokens: 4000,
      })
      // 宿主这边 `llm.stream` 有时直接返回一个已经建好的 handle（流本身），
      // 有时返回 Promise<handle>。**两种都得认**：早先这里假定它一定是 Promise，
      // 于是对真宿主上「直接给 handle」的那一种调 .then 就抛
      // `TypeError: pending.then is not a function`——「整理进卡里」每次都
      // 在 0.02 秒内 500，而这条路上其它分支（本地假 llm）全测不出来。
      // 包一层 Promise.resolve：同步给 handle 和给 Promise 两种形状都认。
      // 早先只处理 thenable，真宿主偏偏是同步给 handle，于是
      // `pending.then is not a function`——所有 AI 功能一起 500。
      const waiting = Promise.resolve(pending)
      // withTimeout 是 Promise.race：超时是在**赋值之前**抛出来的，那时候
      // handle 还是 null，catch 里的 abort 就永远打不中，被丢下的那条请求
      // 会一直挂着占连接和配额。所以先挂一个 then，把它真正交出来的 handle
      // 接住——不管我们来不来得及等。
      waiting.then((h) => { if (handle === null) handle = h }, () => {})
      handle = await withTimeout(waiting, MODEL_TIMEOUT_MS, 'AI ')
      const text = await withTimeout(
        collectStream(handle, onDelta === null ? undefined : (piece) => {
          emitted = true
          onDelta(piece)
        }),
        MODEL_TIMEOUT_MS,
        'AI ',
      )
      if (text !== '') return { ok: true, text, model: `${candidate.provider}/${candidate.model}`, attempts }
      attempts.push(`${candidate.provider}/${candidate.model}: 空响应`)
    } catch (error) {
      // 超时也当一次失败，接着试下一条路由；顺手把这一条断掉，别让它
      // 在后台继续占着连接。手里还没有 handle 就等它交出来再断。
      const stop = (h) => {
        try { if (typeof h?.abort === 'function') h.abort() } catch { /* 断不掉就算了 */ }
      }
      if (handle !== null) stop(handle)
      else if (pending !== null && pending !== undefined) Promise.resolve(pending).then(stop, () => {})
      // 已经开始往外吐字了，就不能换下一条路由重来：界面上会显示「半句 + 另半句」，
      // 而两段接不上；文件里存的还是后半段。用户只会以为自己网卡了。
      // 宁可这一轮报错，让他重说一次。
      if (emitted === true) {
        return {
          ok: false,
          error: 'AI 说到一半断了，这一轮没说完。过一会儿再让它重说一次。',
          attempts,
        }
      }
      attempts.push(`${candidate.provider}/${candidate.model}: ${String(error?.message ?? error)}`)
    }
  }
  return {
    ok: false,
    error: 'AI 试了几次都没回上话（有一次是等了很久没动静）。可以过一会儿再试，或者在卡片里直接手写。',
    attempts,
    details: attempts,
  }
}

/** 列出除首选之外的其他候选路由，用于失败重试。 */
async function listCandidateRoutes(llm, first) {
  const out = []
  let providers = []
  try {
    if (typeof llm.listProviders === 'function') {
      const raw = await llm.listProviders()
      providers = Array.isArray(raw) ? raw : []
    }
  } catch {
    return out
  }
  for (const p of providers) {
    const provider = typeof p === 'string' ? p : p?.provider ?? p?.id ?? p?.name
    if (typeof provider !== 'string' || provider === '' || provider === first.provider) continue
    let model = p?.models?.[0]?.id ?? p?.models?.[0]
    if (model === undefined && typeof llm.listModels === 'function') {
      try {
        const models = await llm.listModels(provider)
        model = models?.[0]?.id ?? models?.[0]
      } catch { continue }
    }
    if (typeof model === 'string' && model !== '') out.push({ provider, model })
    if (out.length >= 3) break
  }
  return out
}

/**
 * 找一个可用的 provider/model 路由。
 *
 * `llm.listProviders()` 返回的是 provider 元信息；模型清单可能是异步的，
 * 所以这里按能力探测，任何一步拿不到就退回下一个候选。
 *
 * @returns {Promise<{provider?: string, model?: string, error?: string}>}
 */
async function resolveRoute(llm, explicit) {
  // 1) 显式写了 `provider/model`
  if (typeof explicit === 'string' && explicit.includes('/')) {
    const at = explicit.indexOf('/')
    const provider = explicit.slice(0, at)
    const model = explicit.slice(at + 1)
    if (provider !== '' && model !== '') return { provider, model }
  }

  // 2) 问宿主有哪些 provider
  let providers = []
  try {
    if (typeof llm.listProviders === 'function') {
      const raw = await llm.listProviders()
      providers = Array.isArray(raw) ? raw : []
    }
  } catch {
    providers = []
  }

  // 首选序列：按「本机实测能出文本」的经验排序。
  //
  // **`raccoon` 必须排在第一位**：这台机器上主 agent 用的就是
  // `provider: raccoon / model: sn-deepseek-v4-1-flash-1017`（见 profile 的
  // cordis.patch.yml）。早先这里没有 raccoon，于是 analyze 会去挑列表里
  // 另一个 provider——那个 transport 接了请求却不回话，界面上就是「分析」
  // 一直转，直到宿主 HTTP 层 5 分钟后断开（表现为 fetch failed）。
  // 换句话说：插件用的模型，应该和用户正在用的那个是同一个。
  //
  // 注意 `buddy` 虽然能列出模型，但它的 transport 在本机会失败——所以排在后面。
  const preferred = ['raccoon', 'deepseek-official', 'deepseek-account', 'deepseek', 'buddy']
  for (const want of preferred) {
    const hit = providers.find((p) => (p?.provider ?? p?.id ?? p?.name) === want)
    if (hit !== undefined) {
      const provider = want
      let model = hit?.models?.[0]?.id ?? hit?.models?.[0]
      if (model === undefined && typeof llm.listModels === 'function') {
        try {
          const models = await llm.listModels(provider)
          model = models?.[0]?.id ?? models?.[0]
        } catch { /* 下一个候选 */ }
      }
      if (typeof model === 'string' && model !== '') return { provider, model }
    }
  }
  // 其次：任何一个 provider 的第一个模型（顺序按宿主给的来）
  for (const p of providers) {
    const provider = typeof p === 'string' ? p : p?.provider ?? p?.id ?? p?.name
    if (typeof provider !== 'string' || provider === '') continue
    // 模型清单：先看 provider 元信息里有没有现成的
    const inline = Array.isArray(p?.models) ? p.models : Array.isArray(p?.modelIds) ? p.modelIds : []
    const firstInline = inline.map((m) => (typeof m === 'string' ? m : m?.id ?? m?.model)).find((m) => typeof m === 'string' && m !== '')
    if (firstInline !== undefined) return { provider, model: firstInline }
    // 再问 listModels
    try {
      if (typeof llm.listModels === 'function') {
        const models = await llm.listModels(provider)
        const first = (Array.isArray(models) ? models : [])
          .map((m) => (typeof m === 'string' ? m : m?.id ?? m?.model))
          .find((m) => typeof m === 'string' && m !== '')
        if (first !== undefined) return { provider, model: first }
      }
    } catch {
      // 这个 provider 的模型清单拿不到，试下一个
    }
  }
  return { error: '这台机器上还没有配好能用的 AI。你可以在卡片里直接手写，效果一样。' }
}

/**
 * 把一个流句柄读成完整文本。
 *
 * 分片形状随适配器不同，可能带 `text` / `delta` / `content`，也可能是
 * block 事件。这里全认，认不出就跳过——不能因为一个分片形状不认识就整次失败。
 */
async function collectStream(handle, onDelta) {
  let text = ''
  // 每收到一小段就顺手递出去一次（流式用）。递不出去不该把这一轮弄断——
  // 整句最后还是要落盘的，界面那头断了是界面的事。
  const push = (piece) => {
    if (typeof piece !== 'string' || piece === '') return
    text += piece
    if (typeof onDelta !== 'function') return
    try {
      onDelta(piece)
    } catch { /* 收字的那一头断了就算了 */ }
  }
  const eat = (chunk) => {
    if (chunk === null || chunk === undefined) return
    if (typeof chunk === 'string') { push(chunk); return }
    // 模型「想」的那一段走的是另一条事件（实测：{ type: 'reasoning-delta', text }）。
    // 它不是回答，也**不能**当成回答拼进来：拼进去之后 JSON 前面多出几千字
    // 「Thinking Process: …」，解析必失败——「整理进卡里」于是等五十秒、
    // 试两次、报「AI 这次没给出能用的结果」，用户看到的是一直转圈。
    // 下面那些「只要是 .text 就收」的兜底分支会让它漏进来，所以必须先在
    // 这里按类型挡掉。
    if (typeof chunk.type === 'string' && /reasoning|thinking|analysis/i.test(chunk.type)) return
    // 真实的流事件形状（实测）：{ type: 'text-delta', index, text }
    // block-start / block-end / text-start / text-end / finish 都不带正文
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') { push(chunk.text); return }
    if (chunk.type === 'finish') return
    if (chunk.type === 'block-start' || chunk.type === 'block-end' || chunk.type === 'text-start' || chunk.type === 'text-end') return
    if (typeof chunk.text === 'string') { push(chunk.text); return }
    if (typeof chunk.delta === 'string') { push(chunk.delta); return }
    if (typeof chunk.content === 'string') { push(chunk.content); return }
    if (chunk.delta !== null && typeof chunk.delta === 'object' && typeof chunk.delta.text === 'string') { push(chunk.delta.text); return }
    if (chunk.delta !== null && typeof chunk.delta === 'object' && typeof chunk.delta.content === 'string') { push(chunk.delta.content); return }
    if (Array.isArray(chunk.content)) {
      for (const block of chunk.content) {
        if (typeof block === 'string') push(block)
        else if (typeof block?.text === 'string') push(block.text)
      }
    }
  }
  if (handle === null || typeof handle !== 'object') {
    if (typeof handle === 'string') return handle
    return ''
  }
  let failure = null
  const eat2 = (chunk) => {
    if (chunk !== null && typeof chunk === 'object' && chunk.type === 'finish' && chunk.reason?.kind !== 'stop') {
      failure = chunk.reason?.failure?.message ?? chunk.reason?.kind ?? 'unknown'
    }
    eat(chunk)
  }
  if (typeof handle[Symbol.asyncIterator] === 'function') {
    for await (const chunk of handle) eat2(chunk)
    if (text === '' && failure !== null) throw new Error(`模型返回了错误：${failure}`)
    return text
  }
  if (typeof handle.stream === 'object' && handle.stream !== null && typeof handle.stream[Symbol.asyncIterator] === 'function') {
    for await (const chunk of handle.stream) eat(chunk)
    return text
  }
  if (typeof handle.text === 'string') return handle.text
  if (typeof handle.content === 'string') return handle.content
  return text
}

/**
 * 从模型输出里挖出 JSON。
 *
 * 真实模型不总是乖乖只吐 JSON：常见的是包在 ```json 里、前后带一句解释、
 * 末尾被 maxTokens 截断。按可靠性从高到低试一遍，全失败才算失败。
 */
export function extractJson(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return undefined

  const candidates = []

  // 1. 整体就是 JSON
  candidates.push(raw)

  // 2. ```json ... ``` 围栏（也接受 ``` 无语言标记）
  for (const m of raw.matchAll(/```(?:json|JSON)?\s*\n?([\s\S]*?)```/g)) {
    candidates.push(m[1].trim())
  }

  // 3. 第一个 { 到最后一个 }（最常见的「解释 + JSON + 解释」）
  const first = raw.indexOf('{')
  const last = raw.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1))

  // 4. 截断修复：从「第一个 {」开始，逐步砍掉末尾不完整的部分再补右括号
  if (first >= 0) {
    const body = raw.slice(first)
    candidates.push(...repairTruncatedJson(body))
  }

  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.trim() === '') continue
    try {
      const parsed = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === 'object') return parsed
    } catch {
      // 继续试下一个
    }
  }
  return undefined
}

/**
 * 修一个被截断的 JSON：从末尾往回找最后一个「安全位置」，补上缺的括号。
 *
 * 只在「结构明显缺尾巴」时才有用（模型撞上 maxTokens）。返回若干候选，
 * 让调用方逐个 JSON.parse 验证——这里不猜语义，只补括号。
 */
function repairTruncatedJson(text) {
  const out = []
  let inString = false
  let escaped = false
  const stack = []
  let lastSafe = -1
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') { inString = true; continue }
    if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']')
    else if (c === '}' || c === ']') stack.pop()
    // 一个完整值之后的位置是「安全」的
    if (c === ',' || c === '}' || c === ']') lastSafe = i
  }
  if (stack.length === 0) return out
  for (const cut of [text.length, lastSafe + 1]) {
    if (cut <= 0) continue
    let body = text.slice(0, cut).replace(/,\s*$/, '')
    // 重算还缺什么
    const need = []
    let str = false
    let esc = false
    for (let i = 0; i < body.length; i += 1) {
      const ch = body[i]
      if (str) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') str = false
        continue
      }
      if (ch === '"') str = true
      else if (ch === '{' || ch === '[') need.push(ch === '{' ? '}' : ']')
      else if (ch === '}' || ch === ']') need.pop()
    }
    if (str) body += '"'
    if (need.length > 0) body += need.reverse().join('')
    out.push(body)
  }
  return out
}

// ── 路由 ──────────────────────────────────────────────────────────

/**
 * 把「本机记忆」和「项目档案」两处的正文一起捞出来认人。
 *
 * 分开读、分开贴标签，是因为来源本身是有意义的：USER.md 里那句是你自己
 * 写进记忆的，档案里那句是当时写成一篇的。合并认人之后每个人身上留一份
 * sources，材料里就能写明「这是在哪几份文件里提到的」。
 *
 * @returns {Promise<{found: boolean, files: number, chars: number, people: Array}>}
 */
async function gatherMemoryPeople() {
  const mem = await memory.readMemory(process.env)
  const arc = await memory.readArchive(process.env)

  const sources = []
  if (mem.found === true) sources.push({ label: '本机记忆', text: mem.text })
  // 档案是成篇的散文，用严格模式认人：见 memory.findPerson 的说明。
  // 不严格的话，「父亲关系」「奶奶家吃饭」都会被当成一个人的名字。
  for (const doc of arc.docs ?? []) sources.push({ label: doc.title, text: doc.text, strict: true })

  if (sources.length === 0) {
    return { found: false, files: 0, chars: 0, memory_files: 0, archive_files: 0, people: [] }
  }
  return {
    found: true,
    files: (mem.found === true ? mem.files.length : 0) + (arc.docs?.length ?? 0),
    chars: mem.chars + (arc.docs ?? []).reduce((n, d) => n + String(d.text ?? '').length, 0),
    // 分两类报，界面要说清「这是在哪儿翻出来的」——
    // 只报总数会让用户以为软件偷偷读了他别的文件
    memory_files: mem.found === true ? mem.files.length : 0,
    archive_files: arc.docs?.length ?? 0,
    people: memory.findPeopleIn(sources),
  }
}

/**
 * 全部路由。每个方法一个 key，浏览器侧 `POST /api/dsh-lifecard/<method>`。
 * @param {any} ctx
 * @param {() => Promise<string>} workspace
 * @param {any} config
 */
function buildApi(ctx, workspace, config, options) {
  const settings = config ?? {}
  const remember = typeof options?.remember === 'function' ? options.remember : null
  /**
   * 同一场会话的写操作排队。
   *
   * `tavern.say` 是「读文件 → 改 → 整文件写回」，中间夹着一次模型调用
   * （几秒到几十秒）。双击「发送」或者两个窗口聊同一场，后写的那次以旧
   * turns 为基础，前一次那几轮就凭空消失了。按 id 串起来就没有这个窗口。
   */
  const chatQueue = new Map()
  const oneAtATime = (id, run) => {
    const prev = chatQueue.get(id) ?? Promise.resolve()
    const next = prev.then(run, run)
    chatQueue.set(id, next.then(() => {}, () => {}))
    return next
  }
  const root = async (body) => {
    // 请求体里的 workspace 只用来「确认」，不能用来「换库」。
    // 以前这里直接 path.resolve(body.workspace) 就采信了：所有越界检查
    // （insideWorkspace / resolveIn）都以这个 ws 为基准，于是任何一个网页
    // 脚本都能 POST 一个别的文件夹当库，把那里 materials/ 的名字列出来、
    // 再把原始素材删掉（素材没有快照）。换库只有一个入口：workspace.init。
    const want = typeof body?.workspace === 'string' ? body.workspace.trim() : ''
    if (want !== '') {
      const now = typeof workspace === 'function' ? await workspace() : await currentWorkspace(settings)
      const abs = path.resolve(want)
      if (abs === path.resolve(now)) return abs
      // 指到别处：不采信，按当前这个库办。不报错是因为旧客户端会顺手带上
      // 它记着的那个路径，硬报错会把正常操作也卡住。
      return now
    }
    // 优先用外面传进来的那个函数（apply 传的是「每次现读配置」，所以没有模块级状态）。
    // 只有当调用方没给（或给了非函数）时才自己从配置算——测试会传一个指向临时目录的函数，
    // 那时候绝不能绕过它去读真实配置，否则测试写的是用户自己的库。
    if (typeof workspace === 'function') return await workspace()
    return await currentWorkspace(settings)
  }

  /**
   * 一局剧本放在哪。
   *
   * 不另起一套目录规则，直接拿 `game.playRelPath` 的结果把 `.md` 换成
   * `.script.md`：这一局的存档和它的剧本永远在同一个文件夹里，删这一局的时候
   * 也一眼看得出哪些文件是一组的。
   */
  const scriptRelPath = (bookId, playId) => `${game.playRelPath(bookId, playId).replace(/\.md$/, '')}.script.md`

  /**
   * 读书那个插件（dsh-reading）挂在哪。
   *
   * 它不向 cordis 提供 service，只能按 HTTP 打它的 `/api/dsh-reading/*`。
   * 两边跑在同一个进程、同一个端口上，所以「自己是哪个端口」就是答案：
   * 优先用这次请求带进来的 Host（桌面版换端口是常事，环境变量会过期），
   * 拿不到才退回 DSH_WEB_URL。
   */
  const readingOrigin = (context) => {
    const fromReq = String(context?.origin ?? '').trim()
    if (fromReq !== '') return fromReq
    const fromEnv = String(process.env.DSH_WEB_URL ?? '').trim()
    return fromEnv.replace(/\/+$/, '')
  }

  /**
   * 读一局的剧本节点。
   *
   * 剧本不存在时不报错、回空数组：新开的一局本来就没有剧本，导出按钮点了
   * 应该说「先写一段」，而不是「文件读不出来」。
   */
  const readScriptNodes = async (ws, bookId, playId) => {
    const safe = await insideWorkspace(ws, scriptRelPath(bookId, playId))
    if (safe.ok !== true) return safe
    let text = ''
    try {
      text = await fs.readFile(path.join(ws, safe.rel), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') return { ok: false, error: '剧本读不出来，检查一下文件夹权限' }
      return { ok: true, nodes: [], errors: [] }
    }
    const parsed = story.parseScript(text)
    return { ok: true, nodes: parsed.nodes, errors: parsed.errors, text }
  }

  return {
    /** 状态：当前工作区、是否有数据、宿主能力。 */
    'state.get': async (body) => {
      const ws = await root(body)
      const exists = await fs.stat(ws).then((s) => s.isDirectory()).catch(() => false)
      let summary = null
      if (exists) {
        try {
          summary = await store.doctor(ws)
        } catch (error) {
          summary = { ok: false, error: String(error?.message ?? error) }
        }
      }
      return {
        ok: true,
        workspace: ws,
        exists,
        home: homedir(),
        hasLlm: ctx.get?.('llm') !== undefined && ctx.get?.('llm') !== null,
        defaults: { workspace: ws },
        // 界面上被收起来的门。读不出来就一个都不收（宁可多摆一扇，也不要空一块）。
        hidden_doors: await (async () => {
          try {
            const conf = await store.readConfigState(ws)
            const list = conf.ok === true ? conf.config?.hidden_doors : []
            return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []
          } catch {
            return []
          }
        })(),
        summary,
        relations: prompts.RELATION_TYPES,
      }
    },

    /** 建工作区（首次使用时选一个文件夹）。 */
    'workspace.init': async (body) => {
      // 换库只走这一个入口，所以这里直接采信 body.workspace——别处一律不认
      // （否则任何一次请求都能把「库」指到别的地方，所有越界检查跟着歪）。
      const want = String(body?.workspace ?? '').trim()
      if (want === '') return { ok: false, error: '没有说是哪个文件夹。' }
      const ws = path.resolve(want)
      const opened = await store.openWorkspace(ws, { create: true })
      if (!opened.ok) return { ok: false, error: opened.error }
      settings.workspace = ws
      // 只改内存里的配置不够：宿主重启后这个对象还是从配置里现读的，
      // 会回落到「用户目录/LifeCard」。所以另存一份指针文件。
      // 记不住不算这一步失败——这次照样能用，只是下次要重选。
      let remembered = true
      if (remember !== null) remembered = (await remember(ws))?.ok === true
      return { ok: true, workspace: ws, created: true, remembered }
    },

    /** 只校验路径（选文件夹后先看一眼是不是已有的库）。 */
    'workspace.inspect': async (body) => {
      const target = typeof body?.path === 'string' ? path.resolve(body.path) : ''
      if (target === '') return { ok: false, error: '没有说是哪个位置。' }
      const exists = await fs.stat(target).then((s) => s.isDirectory()).catch(() => false)
      if (!exists) return { ok: true, path: target, exists: false, isLifeCard: false }
      const isLifeCard = await fs.stat(path.join(target, 'lifecard.config.json')).then(() => true).catch(() => false)
      const counts = isLifeCard ? await store.listAll(target) : null
      return {
        ok: true,
        path: target,
        exists: true,
        isLifeCard,
        counts: counts === null ? null : {
          cards: counts.cards.length,
          materials: counts.materials.length,
          relations: counts.relations.length,
        },
      }
    },

    /** 列表：所有卡、世界、系统、关系、材料、提案。 */
    'workspace.list': async (body) => {
      const ws = await root(body)
      const all = await store.listAll(ws)
      const proposals = await store.listProposals(ws)
      const config2 = await store.readConfig(ws)
      return {
        ok: true,
        workspace: ws,
        config: config2,
        cards: all.cards,
        worlds: all.worlds,
        systems: all.systems,
        relations: all.relations,
        materials: all.materials,
        errors: all.errors,
        // 撤回箱：删掉的卡文件还在磁盘上，得有个地方列出来，用户才能恢复
        // 或者彻底删掉。以前什么都没有，删掉的卡等于掉进黑洞。
        withdrawn: all.withdrawn ?? [],
        proposals,
      }
    },

    /** 读一张卡（含正文小节）。 */
    'card.get': async (body) => {
      const ws = await root(body)
      let rel
      if (typeof body?.path === 'string') {
        const safe = await insideWorkspace(ws, body.path)
        if (safe.ok !== true) return { ok: false, error: safe.error }
        rel = safe.rel
      } else {
        rel = await store.findCardByRelOrId(ws, String(body?.id ?? ''))
      }
      if (rel === null || rel === undefined) return { ok: false, error: '找不到这张卡' }
      const card = await store.readCard(ws, rel)
      if (!card.ok) return card
      const validation = core.validateCard(card.data)
      const cov = core.coverage(card.data, card.sections)
      // 头像单独取：存在 assets/ 里，不进卡文件（卡文件要能当纯文本 git diff）
      const avatar = await store.readAvatar(ws, card.data?.id)
      return { ok: true, path: rel, data: card.data, sections: card.sections, text: card.text, validation, coverage: cov, avatar }
    },

    /**
     * 读一本世界书（含条目）。
     *
     * 条目在磁盘上是 `- uid: 3 / keys: [...] / content: "..."` 这样一段段文本，
     * 不是 frontmatter —— 世界书的条目数量没有上限，塞进 frontmatter 会让
     * 那份文件彻底没法当纯文本读。所以这里现解一遍给界面用。
     */
    'world.get': async (body) => {
      const ws = await root(body)
      let rel
      if (typeof body?.path === 'string') {
        const safe = await insideWorkspace(ws, body.path)
        if (safe.ok !== true) return { ok: false, error: safe.error }
        rel = safe.rel
      } else {
        const id = String(body?.id ?? '')
        if (id === '') return { ok: false, error: '没有说是哪一本' }
        rel = path.posix.join('worlds', core.safeId(id), 'world.md')
      }
      const card = await store.readCard(ws, rel)
      if (!card.ok) return card
      return {
        ok: true,
        path: rel,
        data: card.data,
        sections: card.sections,
        text: card.text,
        entries: core.parseWorldEntries(card.sections),
      }
    },

    /** 存一张卡（新建或编辑）。 */
    'card.save': async (body) => {
      const ws = await root(body)
      const data = body?.data
      if (data === null || typeof data !== 'object') return { ok: false, error: '没收到卡片内容，重新试一次。' }
      // 判空必须在 safeId **之前**：`core.safeId('')` 返回 `'unnamed'`，
      // 于是下面那句 `if (id === '')` 永远不成立——没起名字的新卡会悄悄
      // 变成一张叫「unnamed」的卡，之后所有空名字的卡还会互相覆盖。
      if (String(data.id ?? data.name ?? '').trim() === '') {
        return { ok: false, error: '这张卡还没有名字，先给它起一个。' }
      }
      const id = core.safeId(data.id ?? data.name ?? '')
      data.id = id
      data.lifecard = core.DATA_VERSION
      let rel
      if (typeof body?.path === 'string' && body.path.endsWith('.card.md')) {
        const safe = await insideWorkspace(ws, body.path)
        if (safe.ok !== true) return { ok: false, error: safe.error }
        rel = safe.rel
        // 显式给了位置也一样：这个位置上有一张撤掉的卡，就没法「另存一张」盖过去。
        // 不然换个入口就能把删掉的卡复活成一份新内容。
        const there = await fs.stat(path.join(ws, rel)).then((st) => st.isFile()).catch(() => false)
        if (!there) {
          // 挡住这张新卡的是账上那张撤掉的卡，所以也带 withdrawn。
          // 光比路径不够：id 是拼音、名字是中文时（people/rat.card.md 那种），
          // 按名字再建会算出另一个路径，于是同一个人并排出现两张。
          const gone = store.hitsRedactionByPath(await store.readRedactions(ws), rel) !== undefined
            || (await store.withdrawnNameHit(ws, rel, [data.id, data.name])) !== null
          if (gone) {
            return { ok: false, withdrawn: true, error: '这个名字被一张已经删掉的卡占着。先去首页「已经撤掉的」里把它清掉，或者换个名字。' }
          }
        }
      } else {
        rel = store.cardRelPath(id, data.world)
        // 没给路径＝这是一张新卡。同名文件已经在了就不再写：
        // 以前会直接覆盖，用户点「新建」写了个已有的名字，那人原来那张卡
        // 连同快照之外的一切（关系史、口癖）就没了声息地被换成了空白。
        const abs = path.join(ws, rel)
        const exists = await fs.stat(abs).then((st) => st.isFile()).catch(() => false)
        if (!exists) {
          // 文件搬去回收目录以后，原位确实空了，可名字还被一张撤掉的卡占着。
          // 只判文件在不在的话，删掉的卡会被当成「没人用这个名字」默默重建回来。
          const redactions = await store.readRedactions(ws)
          // 同目录里同名的也算占着：删掉一张叫「妈妈」的卡（文件是 people/mama.card.md），
          // 再按名字建会算出 people/妈妈.card.md，两张「妈妈」就并排出现了。
          const gone = store.hitsRedactionByPath(redactions, rel) !== undefined
            || (await store.withdrawnNameHit(ws, rel, [id, data.name])) !== null
          if (gone) {
            return {
              ok: false,
              withdrawn: true,
              error: '这个名字被一张已经删掉的卡占着。先去首页「已经撤掉的」里把它清掉，或者换个名字。',
            }
          }
        }
        if (exists && body?.overwrite !== true) {
          return {
            ok: false,
            error: `已经有一张叫「${String(data.name ?? id)}」的卡了。想改它，去列表里点开那张；想再建一张，把名字改得能区分开。`,
          }
        }
      }
      // sections 缺省不能当空数组：那会把一张写满正文的卡整篇清空，还照样报成功。
      // 老客户端漏传时按磁盘上那一份的正文补上（新卡就真是空的）。
      let sections = Array.isArray(body?.sections) ? body.sections : null
      if (sections === null) {
        const old = await store.readCard(ws, rel)
        sections = old.ok === true && Array.isArray(old.sections) ? old.sections : []
      }
      const written = await store.writeCard(ws, rel, data, sections, { force: body?.force === true })
      return written
    },

    /**
     * 把一张卡复制成另一张独立的卡（酒馆里「拿现实里的人来演」用）。
     *
     * 关键在「独立」：复制出来的是一份新文件，之后在酒馆里把性格改成完全相反、
     * 加一堆原作没有的口癖，也不会动到现实那张卡。共用一个文件的话，
     * 演着演着现实记录就被改写了——那是这个功能最容易出事的地方。
     */
    'card.fork': async (body) => {
      const ws = await root(body)
      const want = String(body?.path ?? '').trim()
      if (want === '') return { ok: false, error: '得先挑一张卡。' }
      const rel = want.endsWith('.card.md') ? want : await store.findCardByRelOrId(ws, want)
      if (rel === null || rel === undefined) return { ok: false, error: '找不到这张卡。它可能被删掉了，或者不在这个文件夹里。' }
      const card = await store.readCard(ws, rel)
      if (card.ok !== true) {
        const why = String(card.error ?? '')
        if (why.includes('不存在') || why.includes('没有这个')) return { ok: false, error: '找不到这张卡。它可能被删掉了，或者不在这个文件夹里。' }
        return { ok: false, error: why === '' ? '这张卡读不出来。' : `这张卡读不出来：${why}` }
      }
      const data = { ...(card.data ?? {}) }
      const baseName = String(data.name ?? data.id ?? '').trim() === '' ? '没名字的人' : String(data.name).trim()
      // 名字不改：「演我妈」要认得出是我妈。区别在身份上——它是一张独立的新卡。
      const stem = core.safeId(`${data.id ?? core.safeId(baseName)}-role`)
      let id = ''
      let target = ''
      // 同一张卡可以复制好几份（一份热情版、一份冷淡版）。
      // 用 'wx' 占位而不是「stat 一下没在就写」：两次点击几乎同时到达时，
      // 后者会拿到 EEXIST，自然往下挑号，不会互相覆盖。挑到 40 就明说。
      for (let n = 1; n <= 40; n += 1) {
        const candidateId = n === 1 ? stem : `${stem}-${n}`
        const candidateRel = store.cardRelPath(candidateId, 'reality')
        const free = await fs.open(path.join(ws, candidateRel), 'wx')
          .then(async (handle) => { await handle.close(); return true })
          .catch(() => false)
        if (free) { id = candidateId; target = candidateRel; break }
      }
      if (id === '') return { ok: false, error: '这张卡已经复制了很多份了。先把用不上的那几份删掉，再来复制。' }
      data.id = id
      data.kind = 'fictional'
      data.world = 'reality'
      // 留一条来路，方便以后在卡里看见「这是从谁那儿复制的」。
      // 一律记相对路径：绝对路径里带着 /Users/<用户名>，角色卡导出分享时会漏出去。
      data.forked_from = String(card.path ?? rel).replace(String(ws) + path.sep, '')
      // 不带走「从哪儿导入的」这类来路和原图，但**卡里自带的小设定要留下**：
      // 那是用户一条条写的世界书条目，不是图片附件，丢掉等于白写。
      if (data.cc !== null && typeof data.cc === 'object') {
        const cc = { ...data.cc }
        delete cc.source_file
        delete cc.png
        delete cc.imported_at
        delete cc.spec
        data.cc = cc
      }
      const written = await store.writeCard(ws, target, data, Array.isArray(card.sections) ? card.sections : [], { force: true })
      if (written.ok !== true) {
        // 占位文件留着会变成一张空卡，撤掉
        await fs.rm(path.join(ws, target), { force: true }).catch(() => {})
        return { ok: false, error: written.error ?? '复制没成功。' }
      }
      return { ok: true, path: target, id, name: baseName, from: card.path ?? rel }
    },

    /** 看某张卡以前的样子（快照在每次保存时自动留，只是以前没露出来）。 */
    // 三扇门各自「现在用哪张卡」。存成 id，读的时候再按 id 找卡：
    // 卡改名、换文件夹都不会让这条记录失效。
    'card.defaults.get': async (body) => {
      const ws = await root(body)
      const cfg = await store.readConfigState(ws)
      const pins = cfg.config?.default_cards ?? {}
      return {
        ok: true,
        cards: {
          real: String(pins.real ?? ''),
          tavern: String(pins.tavern ?? ''),
          novel: String(pins.novel ?? ''),
          diary: String(pins.diary ?? ''),
        },
      }
    },
    // 开一个新对话，并把第一句替用户发出去。
    //
    // 为什么放在后台：宿主把「建会话 + 发消息」这套能力挂在 sessionController 上，
    // 后台一定拿得到；客户端那侧不一定（真机上 uiWorkspace 有时根本不在插件作用域里，
    // 用户点完只会看到「这个版本不支持」）。所以正路从后台走，客户端只负责把会话切到眼前。
    'session.open': async (body) => {
      const controller = ctx.get?.('sessionController', false)
      if (controller === null || controller === undefined || typeof controller.create !== 'function') {
        return { ok: false, error: '这台机器没有开新对话的能力，把要说的那句话复制到新对话里也一样能用。' }
      }
      const preset = String(body?.preset ?? '').trim()
      const text = String(body?.text ?? '')
      try {
        // 开在用户这个资料夹里，而不是宿主的默认工作区。
        // SessionCreateRequest 收的是 `cwd`（路径）或 `workspaceId`——
        // 不是 `workspace`。写成 workspace 会被静默忽略：会话照开，位置照旧。
        const ws = await root(body)
        const where = typeof ws === 'string' && ws.trim() !== '' ? { cwd: ws } : {}
        const created = await controller.create({ ...(preset === '' ? {} : { agentPreset: preset }), ...where })
        const id = String(created?.sessionId ?? '')
        if (id === '') return { ok: false, error: '新对话没建起来，再点一次试试。' }
        let sent = false
        if (text !== '' && typeof controller.prompt === 'function') {
          // 宿主的 prompt(request, signal) 有两个坑，都不报人话：
          // ①第一句就是 signal.throwIfAborted()，不给 signal 当场 TypeError；
          // ②requestId 不给就成 undefined，而它会被写进用户消息的 source.rpcId，
          //   日志一序列化就报「这条事件带着无法转成 JSON 的东西」，整句被拒。
          //   所以这两个参数都得自己补上。
          const signal = new AbortController().signal
          const requestId = randomUUID()
          await controller.prompt({ sessionId: id, mode: 'queue', content: [{ type: 'text', text }], requestId }, signal)
          sent = true
        }
        // 记下「这个会话是哪扇门开的」。判门本来靠提示词正文里的门牌句，
        // 但正文会被用户改预设、被别的插件重排，判不出来时卡就静默不注入。
        // 开会话这一刻是唯一确定知道答案的时刻，忘了就没人记得了。
        const door = modeFromPresetId(preset)
        if (door !== '') {
          try {
            const cfg = await store.readConfigState(ws)
            const map = cfg.config?.door_sessions !== null && typeof cfg.config?.door_sessions === 'object' ? cfg.config.door_sessions : {}
            // 只留最近 200 条：这张表只是「哪扇门开的」，旧的会话不会再组装了，
            // 但也不能让它无上限地长。
            const keys = Object.keys(map)
            const trimmed = keys.length >= 200 ? Object.fromEntries(keys.slice(-150).map((k) => [k, map[k]])) : map
            await store.writeConfig(ws, { door_sessions: { ...trimmed, [id]: door } })
          } catch {
            /* 记不下来不影响这一句：正文判门那条路还在 */
          }
        }
        return { ok: true, sessionId: id, agentPreset: String(created?.agentPreset ?? ''), sent }
      } catch (error) {
        return { ok: false, error: humanizeHostError(error) }
      }
    },
    /**
     * 演的时候那两个跟「我」有关的设置——读。
     *
     * `user_name`：卡上的 `{{user}}` 要换成这个名字。空串＝还没说过，
     *   注入时用「你」（比留一个花括号占位符强得多，模型不会认出那是模板）。
     * `tavern_thinking`：要不要在系统提示末尾加那段「想事情也用这个人第一人称」。
     *   默认开；关掉只有一个理由——某些小模型被这样要求之后会把内心戏写进回答。
     */
    'tavern.prefs.get': async (body) => {
      const ws = await root(body)
      const state = await store.readConfigState(ws)
      const cfg = state.ok === true ? (state.config ?? {}) : {}
      return {
        ok: true,
        user_name: String(cfg.user_name ?? ''),
        tavern_thinking: cfg.tavern_thinking !== false,
        tavern_thinking_style: String(cfg.tavern_thinking_style ?? '') === 'neutral' ? 'neutral' : 'role',
      }
    },
    'tavern.prefs.set': async (body) => {
      const ws = await root(body)
      const patch = {}
      if (body?.user_name !== undefined) {
        // 名字是要塞进提示词的，长到几十个字就不是名字了；
        // 顺带把换行去掉——一串换行会把系统提示那一段的排版拆散。
        const name = String(body.user_name ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 24)
        patch.user_name = name
      }
      if (body?.tavern_thinking !== undefined) patch.tavern_thinking = body.tavern_thinking !== false
      if (body?.tavern_thinking_style !== undefined) {
        // 只认这两档。给别的值不报错，落回 `role`——这个设置坏掉的后果
        // 只是「思考那一段不是你想要的那一档」，不该让整次保存失败。
        patch.tavern_thinking_style = String(body.tavern_thinking_style ?? '') === 'neutral' ? 'neutral' : 'role'
      }
      if (Object.keys(patch).length === 0) return { ok: true, changed: [] }
      const saved = await store.writeConfig(ws, patch)
      if (saved?.ok !== true) return { ok: false, error: saved?.error ?? '这一项没能记住。' }
      const state = await store.readConfigState(ws)
      const cfg = state.ok === true ? (state.config ?? {}) : {}
      return {
        ok: true,
        changed: Object.keys(patch),
        user_name: String(cfg.user_name ?? ''),
        tavern_thinking: cfg.tavern_thinking !== false,
        tavern_thinking_style: String(cfg.tavern_thinking_style ?? '') === 'neutral' ? 'neutral' : 'role',
      }
    },
    'card.defaults.set': async (body) => {
      const ws = await root(body)
      const mode = String(body?.mode ?? '')
      if (mode !== 'real' && mode !== 'tavern' && mode !== 'novel' && mode !== 'diary') {
        return { ok: false, error: '不知道你说的是哪扇门。' }
      }
      const id = String(body?.id ?? '').trim()
      const cfg = await store.readConfigState(ws)
      if (cfg.ok !== true) return { ok: false, error: cfg.error ?? '这个文件夹里的设置读不出来。' }
      const pins = { real: '', tavern: '', novel: '', diary: '', ...(cfg.config?.default_cards ?? {}) }
      pins[mode] = id
      const saved = await store.writeConfig(ws, { default_cards: pins })
      if (saved?.ok !== true) return { ok: false, error: saved?.error ?? '这一张没能记住，下次还得再挑一次。', cards: pins }
      return { ok: true, cards: pins }
    },

    /**
     * 「这扇门要给模型看这张卡的哪几节」——读。
     *
     * 回的东西分三份，界面照着这三份画：
     *   ① 这张卡里能勾的节（`sections`），每节带「卡上有没有正文」「现在勾没勾」；
     *   ② 现在真进去的是哪几节（`going`），以及勾了却落了空的（`empty` 是卡上写了
     *      标题但内容空着，`missing` 是这张卡根本没有那一节）；
     *   ③ 还有哪几节卡上有、但没勾（`leftOut`）——这一份要说出来，否则用户
     *      永远不知道卡里那半截东西原来没给模型看。
     */
    'persona.get': async (body) => {
      const ws = await root(body)
      const mode = String(body?.mode ?? '')
      if (!DOORS.includes(mode)) return { ok: false, error: '不知道你说的是哪扇门。' }
      const detail = buildPersonaSectionDetail(ws, mode)
      const picks = personaPicksSync(ws, mode)
      const include = detail.card === '' ? persona.normalizeInclude(picks) : detail.include
      let sections = []
      let handledElsewhere = []
      if (detail.card !== '') {
        const text = readCachedSync(detail.card)
        const parsed = text === null ? { sections: [] } : core.parseCard(text)
        const cardSections = Array.isArray(parsed.sections) ? parsed.sections : []
        sections = persona.candidatesFor(cardSections).map((title) => ({
          title,
          hasBody: String(core.sectionBody(cardSections, title) ?? '').trim() !== '',
          picked: include.includes(title),
        }))
        handledElsewhere = persona.cardTitles(cardSections).filter((title) => persona.HANDLED_ELSEWHERE.includes(title))
      }
      return {
        ok: true,
        mode,
        cardId: detail.cardId,
        cardName: detail.cardName,
        hasCard: detail.card !== '',
        include,
        isDefault: persona.isDefaultInclude(include),
        going: detail.chosen,
        empty: detail.empty,
        missing: detail.absent,
        leftOut: detail.skipped,
        chars: detail.chars,
        bodyChars: detail.bodyChars,
        sections,
        handledElsewhere,
        defaults: [...persona.DEFAULT_INCLUDE],
      }
    },
    /**
     * 「这扇门要给模型看这张卡的哪几节」——写。
     *
     * `include` 给一串小节名就是「只要这几节」；给空数组是「一节都不要」（这张卡
     * 整张不进系统提示）；压根不给这一项是「恢复成默认那几节」。
     */
    'persona.set': async (body) => {
      const ws = await root(body)
      const mode = String(body?.mode ?? '')
      if (!DOORS.includes(mode)) return { ok: false, error: '不知道你说的是哪扇门。' }
      const raw = body?.include
      if (raw !== undefined && raw !== null && !Array.isArray(raw)) {
        return { ok: false, error: '这一项要一串小节的名字。' }
      }
      const cfg = await store.readConfigState(ws)
      if (cfg.ok !== true) return { ok: false, error: cfg.error ?? '这个文件夹里的设置读不出来。' }
      const byDoor = { real: null, tavern: null, novel: null, diary: null, ...(cfg.config?.persona_sections ?? {}) }
      byDoor[mode] = raw === undefined ? null : raw
      const saved = await store.writeConfig(ws, { persona_sections: byDoor })
      if (saved?.ok !== true) return { ok: false, error: saved?.error ?? '这一次没能记住，下次还得再勾一遍。' }
      const detail = buildPersonaSectionDetail(ws, mode)
      return {
        ok: true,
        include: persona.normalizeInclude(byDoor[mode]),
        isDefault: persona.isDefaultInclude(byDoor[mode]),
        going: detail.chosen,
        empty: detail.empty,
        missing: detail.absent,
        chars: detail.chars,
        bodyChars: detail.bodyChars,
      }
    },
    /**
     * 把「这一次组装，模型到底会读到什么」原样交出来。
     *
     * 用户问过太多次「它怎么还是不像」，而这个问题以前只能靠解会话日志回答
     * （多帧 zstd、翻 system/message、数字节）。这份就是那个答案的成品：
     * 一模一样的文字，外加多长、哪几节进去了。
     */
    'persona.preview': async (body) => {
      const ws = await root(body)
      const mode = String(body?.mode ?? '')
      if (!DOORS.includes(mode)) return { ok: false, error: '不知道你说的是哪扇门。' }
      const detail = buildPersonaSectionDetail(ws, mode)
      return {
        ok: true,
        mode,
        cardId: detail.cardId,
        cardName: detail.cardName,
        hasCard: detail.card !== '',
        chars: detail.chars,
        bodyChars: detail.bodyChars,
        going: detail.chosen,
        empty: detail.empty,
        missing: detail.absent,
        leftOut: detail.skipped,
        text: detail.text,
      }
    },

    /**
     * 人物关系网：以「我」为中心，把认识的人一圈一圈摆开。
     *
     * 这一版不做图，只把「谁是谁、离我多远、多亲」算清楚交给界面。
     * 距离的口径：
     *   ring 0 = 我自己（kind self，或者老档案里 relation 写「我」的那张）
     *   ring 1 = 直接写着和我有关系的人（他的 relation 是「父亲」「朋友」这种）
     *   ring 2 = 只和某个 ring 1 的人有关系的人（比如「我姨」只和妈妈连着）
     * 没有任何关系线索的人不进网——放进去也只是一堆没有边的点。
     */
    'relations.net': async (body) => {
      const ws = await root(body)
      const all = await store.listAll(ws)
      const cards = Array.isArray(all.cards) ? all.cards : []
      const edges = Array.isArray(all.relations) ? all.relations : []
      const labelOf = new Map(prompts.RELATION_TYPES.map((one) => [String(one.id), String(one.label)]))
      const selfCard = cards.find((c) => String(c.kind ?? '') === 'self')
        ?? cards.find((c) => String(c.kind ?? '') === 'real' && String(c.relation ?? '').trim() === '我')
        ?? null
      const selfId = selfCard === null ? '' : String(selfCard.id ?? '')
      const nodeOf = (c) => ({
        id: String(c.id ?? ''),
        name: String(c.name ?? '').trim() === '' ? '（还没起名字）' : String(c.name),
        kind: String(c.kind ?? 'real'),
        relation: String(c.relation ?? '').trim(),
        relationLabel: String(c.relation ?? '').trim() === ''
          ? ''
          : (labelOf.get(String(c.relation).trim()) ?? String(c.relation).trim()),
        extras: Array.isArray(c.relation_extra) ? c.relation_extra.filter((x) => typeof x === 'string') : [],
        tags: Array.isArray(c.tags) ? c.tags : [],
        intro: String(c.intro ?? ''),
        coverage: Number(c.coverage ?? 0),
        path: String(c.path ?? ''),
      })

      const rings = { 0: [], 1: [], 2: [] }
      const placed = new Map()
      if (selfCard !== null) {
        rings[0].push(nodeOf(selfCard))
        placed.set(selfId, 0)
      }
      // 第一轮：卡上自己写着关系的人，都算直接认识（ring 1）。
      // 这一轮得排在关系边前面——边只回答「再往外还有谁」，它得有落脚点；
      // 反过来先处理边，一圈还没人的时候边就没有起点可用，第 2 圈永远是空的。
      for (const card of cards) {
        const id = String(card.id ?? '')
        if (id === '' || placed.has(id)) continue
        const tag = String(card.relation ?? '').trim()
        if (tag === '' && String(card.kind ?? '') !== 'self') continue
        placed.set(id, 1)
      }
      // 第二轮：关系边再往外扩一层。两端都是 id，最准。
      // 只扩一层——再往外的人已经不是「我认识的人」，是「我认识的人认识的人」。
      for (const edge of edges) {
        const from = String(edge?.from ?? '')
        const to = String(edge?.to ?? '')
        if (from === '' || to === '') continue
        const depth = placed.get(from)
        if (depth !== undefined && depth < 2 && !placed.has(to)) placed.set(to, depth + 1)
      }
      const byId = new Map(cards.map((c) => [String(c.id ?? ''), c]))
      for (const [id, depth] of placed) {
        if (depth === 0) continue
        const card = byId.get(id)
        if (card === undefined) continue
        const node = nodeOf(card)
        // 越亲的越靠里：ring 2 里如果还带着「也是家人」这种补充关系，也算一回事。
        rings[depth].push(node)
      }
      rings[1].sort((a, b) => (b.coverage - a.coverage) || (a.name < b.name ? -1 : 1))
      rings[2].sort((a, b) => (b.coverage - a.coverage) || (a.name < b.name ? -1 : 1))

      const inNet = new Set([...rings[0], ...rings[1], ...rings[2]].map((n) => n.id))
      // 网外的人不是「没有关系的人」，是「卡片在、还没写关系的人」。
      // 世界书、设定、偏好这几种根本不是人；虚构角色是「扮演用的角色」，
      // 不是认识的人——这一屏只在真实人物这扇门里给，混进来读着像出了错。
      // 真写了关系的（relation 非空）仍然进圈，因为那说明用户自己把她当成了一个人。
      const notPeople = new Set(['world', 'system', 'lens', 'relation', 'fictional'])
      const outside = cards
        .filter((c) => !inNet.has(String(c.id ?? '')))
        .filter((c) => !notPeople.has(String(c.kind ?? 'real')))
        .map((c) => ({
          id: String(c.id ?? ''),
          name: String(c.name ?? ''),
          kind: String(c.kind ?? 'real'),
          path: String(c.path ?? ''),
        }))

      return {
        ok: true,
        self: selfCard === null ? null : nodeOf(selfCard),
        rings: { self: rings[0], inner: rings[1], outer: rings[2] },
        // 边不只要「谁连谁」，还要能拿回去编辑：路径是它在磁盘上的位置，
        // 点开一条边要能读到类型、亲疏、当时那句话。
        edges: edges.map((e) => ({
          path: String(e.path ?? ''),
          from: String(e.from ?? ''),
          to: String(e.to ?? ''),
          type: String(e.type ?? ''),
          label: String(e.label ?? ''),
          affinity: e.affinity,
          trust: e.trust,
          authority: e.authority,
          dependency: e.dependency,
          note: String(e.note ?? ''),
          at: String(e.at ?? ''),
        })),
        counts: { self: rings[0].length, inner: rings[1].length, outer: rings[2].length, outside: outside.length },
        outside,
      }
    },

    /**
     * 写一条关系边：谁和谁是什么关系。
     *
     * 这一屏以前只能看图不能改——「我表姐也是我妈的女儿」这件事，
     * 用户只能自己去 relations/ 里手写 YAML。这里补上那条路。
     *
     * 只写一条边，不同时改两张卡：卡片上那个 `relation` 是「他和我」
     * 的关系（一对一），边是「谁和谁」（可以有很多条）。混在一起写，
     * 一次点保存会同时动两处，出错时说不清是哪一步坏的。
     */
    'relations.save': async (body) => {
      const ws = await root(body)
      const all = await store.listAll(ws)
      const cards = Array.isArray(all.cards) ? all.cards : []
      // 两端都可以给 id 或名字——界面上拿到的往往是名字，硬要求 id
      // 等于让用户自己去看文件名。
      const findId = (want) => {
        const key = String(want ?? '').trim()
        if (key === '') return null
        const hit = cards.find((c) => String(c.id ?? '') === key)
          ?? cards.find((c) => String(c.name ?? '').trim() === key)
        return hit === undefined ? null : hit
      }
      const fromCard = findId(body?.from)
      const toCard = findId(body?.to)
      if (fromCard === null) return { ok: false, error: `没找到「${String(body?.from ?? '').trim()}」这个人。先在卡片里建好，再来连。` }
      if (toCard === null) return { ok: false, error: `没找到「${String(body?.to ?? '').trim()}」这个人。先在卡片里建好，再来连。` }
      if (String(fromCard.id) === String(toCard.id)) {
        return { ok: false, error: '这两个是同一张卡。关系要连两个不同的人。' }
      }
      const saved = await store.writeRelation(ws, {
        from: fromCard.id,
        to: toCard.id,
        type: body?.type,
        label: body?.label,
        since: body?.since,
        affinity: body?.affinity,
        trust: body?.trust,
        note: body?.note,
        authority: body?.authority,
        dependency: body?.dependency,
      })
      if (saved.ok !== true) return saved
      return {
        ok: true,
        path: saved.path,
        created: saved.created === true,
        note: saved.created === true
          ? `连上了：「${fromCard.name || fromCard.id}」对「${toCard.name || toCard.id}」是什么，已经记下来。`
          : '改好了。',
      }
    },

    /** 断开一条关系。搬进回收目录，不直接抹掉（和删卡一样能反悔）。 */
    'relations.delete': async (body) => {
      const ws = await root(body)
      const safe = await insideWorkspace(ws, body?.path)
      if (safe.ok !== true) return { ok: false, error: safe.error }
      const gone = await store.deleteRelation(ws, safe.rel)
      if (gone.ok !== true) return gone
      return { ok: true, path: gone.path, note: '这条关系断开了。原来的那份还在回收目录里，需要的话能找回来。' }
    },
      /**
     * 把一扇门从界面上收起来 / 装回来。
     *
     * 只是界面上的开关：卡、世界书、书、会话一个字节都不动，
     * 所以「删掉」这件事随时可以反悔。
     */
    'door.set': async (body) => {
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (!DOOR_SWITCHES.includes(id)) return { ok: false, error: '不知道你说的是哪扇门。' }
      const confState = await store.readConfigState(ws)
      if (confState.ok !== true) return { ok: false, error: confState.error ?? '这个文件夹里的设置读不出来。' }
      const conf = confState.config ?? {}
      const hidden = Array.isArray(conf?.hidden_doors) ? conf.hidden_doors.filter((x) => typeof x === 'string') : []
      const want = body?.hidden === true
      const next = want
        ? (hidden.includes(id) ? hidden : [...hidden, id])
        : hidden.filter((x) => x !== id)
      // 门可以收起来，但不能全收起来——一扇不剩就进不去了。
      // 判据别再写死数字：以前写的是 `next.length === 3`，加上「玩一段」
      // 「写日记」之后，那句「至少留一扇」会在还剩两扇的时候就拦住人。
      if (DOOR_SWITCHES.every((x) => next.includes(x))) {
        return { ok: false, error: '门都收起来就没地方进去了，至少留一扇。' }
      }
      const saved = await store.writeConfig(ws, { ...conf, hidden_doors: next })
      if (saved === false || saved?.ok === false) return { ok: false, error: '这个开关没能存下来，等一会儿再试一次。' }
      return { ok: true, hidden_doors: next }
    },

    'card.history': async (body) => {
      const ws = await root(body)
      const safe = await insideWorkspace(ws, body?.path)
      if (safe.ok !== true) return { ok: false, error: safe.error }
      const rel = safe.rel
      if (!rel.endsWith('.card.md')) return { ok: false, error: '这个位置不是一张卡。' }
      return store.listSnapshots(ws, rel)
    },

    /** 读某一版历史原文（只用来看看和找回，不会被当成当前卡）。 */
    'card.version': async (body) => {
      const ws = await root(body)
      const safe = await insideWorkspace(ws, body?.path)
      if (safe.ok !== true) return { ok: false, error: safe.error }
      const rel = safe.rel
      if (!rel.endsWith('.card.md')) return { ok: false, error: '这个位置不是一张卡。' }
      return store.readSnapshot(ws, rel, body?.stamp)
    },

    /**
     * 恢复一张卡。两种意思，看有没有给版本号：
     *  - 给了 `stamp`：退回那一版历史（老行为，不动）。
     *  - 没给：把撤回过的卡救回列表（追加一条恢复记录）。
     *
     * 合并成一条路由，是因为界面上就一个「恢复」动作，用户不区分这两种。
     */
    'card.restore': async (body) => {
      const ws = await root(body)
      const safe = await insideWorkspace(ws, body?.path)
      if (safe.ok !== true) return { ok: false, error: safe.error }
      const rel = safe.rel
      if (!rel.endsWith('.card.md')) return { ok: false, error: '这个位置不是一张卡。' }
      const stamp = body?.stamp
      if (stamp === undefined || stamp === null || stamp === '') {
        return store.restoreCard(ws, rel)
      }
      // 卡还撤着的时候退回旧版本，会把文件写回原位、而它仍然不在列表里——
      // 那就又造出一个「看得见文件、看不见卡」的死结。先放回来，再谈版本。
      if (store.hitsRedactionByPath(await store.readRedactions(ws), rel) !== undefined) {
        // 跟 readCard 的两条「已撤掉」分支一个形：带 withdrawn，上层只看这个字段
        // 就知道该给「恢复」的门，不用去猜是哪种撤法。
        return { ok: false, withdrawn: true, error: '这张卡现在是撤掉的状态。先把它放回列表，再退回旧版本。' }
      }
      const old = await store.readSnapshot(ws, rel, stamp)
      if (old.ok !== true) return old
      const written = await store.writeCard(ws, rel, old.data, old.sections, { force: true })
      if (written.ok !== true) return written
      return { ok: true, path: rel, validation: written.validation, note: '已经退回这一版。刚才那一版也还在历史里。' }
    },

    /**
     * 撤掉一张卡：文件搬进回收目录，再写一条墓碑。
     *
     * 以前只写墓碑、文件留在原地。看起来更「可审计」，实际是个死结：
     * 名字还占着（`card.save` 只判文件在不在），可列表里又看不见，
     * 用户照着提示去找也找不到，删掉的卡于是就那么赖着。
     */
    'card.delete': async (body) => {
      const ws = await root(body)
      const safe = await insideWorkspace(ws, body?.path)
      if (safe.ok !== true) return { ok: false, error: safe.error }
      const rel = safe.rel
      if (!rel.endsWith('.card.md')) return { ok: false, error: '这个位置不是一张卡。' }
      const card = await store.readCard(ws, rel)
      if (!card.ok) return card
      const moved = await store.moveCardToRedacted(ws, rel)
      if (moved.ok !== true) return moved
      try {
        await store.appendRedaction(ws, { path: rel, sha256: store.sha256(card.text), reason: String(body?.reason ?? '用户删除') })
      } catch (err) {
        // 账没记上就把文件放回去：不然这张卡既不在列表里，也没人知道它被删过。
        const putBack = await fs.rename(path.join(ws, moved.redacted), path.join(ws, rel)).then(() => true).catch(() => false)
        if (!putBack) {
          // 搬回去也失败了：残份留在回收目录里、账上又没有它。别再让这种残份
          // 变成「摘不掉的一行」——restoreCard / purgeCard 对「有残份、没账」
          // 的情况放行，用户可以照常放回来或彻底删掉。
          return { ok: false, error: '这次删除没记下来，卡也没能放回原处。它现在在「已经撤掉的」里，可以放回来，也可以彻底删掉。' }
        }
        return { ok: false, error: '这次删除没记下来，卡已经放回原处了，再试一次。' }
      }
      await clearPinsFor(ws, rel, card.data)
      // 返回值要把「还能找回来」说出来。只写「已经删掉了」，用户手滑之后
      // 就不知道该去哪儿反悔，删掉的卡于是永远躺在回收目录里没人认领。
      return {
        ok: true,
        path: rel,
        note: '已经删掉了：它不会再出现在列表、导出和 AI 的眼里。已经放到「已经撤掉的」里了，想反悔可以在那儿恢复；要从磁盘上彻底删掉，也是在那儿删。',
        withdrawn: true,
      }
    },

    /**
     * 收走一张刚建的空卡（访谈开局建错了用）。
     *
     * 和「删除」分开是因为它不该留墓碑：这张卡从来没进过用户的列表，
     * 只是建错了一下。写墓碑会占住名字，紧接着按同一个名字再建就撞墙。
     * 只对「正文全空、刚建不久」的卡开放，免得变成删活卡的后门。
     */
    'card.discard': async (body) => {
      const ws = await root(body)
      const safe = await insideWorkspace(ws, body?.path)
      if (safe.ok !== true) return { ok: false, error: safe.error }
      const rel = safe.rel
      if (!rel.endsWith('.card.md')) return { ok: false, error: '这个位置不是一张卡。' }
      const card = await store.readCard(ws, rel)
      if (!card.ok) return card
      const written = (card.sections ?? []).map((one) => String(one?.body ?? '').trim()).join('')
      if (written !== '') {
        return { ok: false, error: '这张卡里已经写了内容，不能当成空卡收走。要删就在列表里删。' }
      }
      const stat = await fs.stat(path.join(ws, rel)).catch(() => null)
      const age = stat === null ? Number.POSITIVE_INFINITY : Date.now() - stat.mtimeMs
      if (!(age <= 10 * 60 * 1000)) {
        return { ok: false, error: '这张卡已经放了一会儿了，不能当成刚建的空卡收走。要删就在列表里删。' }
      }
      // 搬走之后必须记一笔「收走」：不记账的残份会被列进「已经撤掉的」，
      // 而「放回来」「彻底删掉」都以账为准，于是那一行两个动作都失败，
      // 用户看着一条摘不掉的幽灵。
      // 记「彻底删掉」而不是「撤掉」，是因为 discard 的本意是别让这张建错的
      // 空卡占住名字——撤掉态会占名字，清掉态不会，同名立刻能再建。
      const moved = await store.moveCardToRedacted(ws, rel)
      if (moved.ok !== true) return moved
      try {
        await store.appendRedaction(ws, { kind: 'purge', path: rel, reason: '建错了的空卡' })
      } catch {
        // 记不上就搬回原处，别留一条谁也处理不了的残份。
        await fs.rename(path.join(ws, moved.redacted), path.join(ws, rel)).catch(() => {})
        return { ok: false, error: '这张空卡没能收走，卡还在原处，再试一次。' }
      }
      return moved
    },

    /**
     * 彻底删掉一张撤回过的卡：真删磁盘文件。
     *
     * 只允许对**已撤回**的卡做。这一步不可撤销，所以设一道前提：先在列表里
     * 删过一次（那一步可恢复）、用户确实看过「已撤回」里那一行，才谈得上彻底删。
     */
    'card.purge': async (body) => {
      const ws = await root(body)
      const safe = await insideWorkspace(ws, body?.path)
      if (safe.ok !== true) return { ok: false, error: safe.error }
      return store.purgeCard(ws, safe.rel)
    },

    /** 导入酒馆卡或世界书（PNG / JSON / CHARX；SillyTavern 的 world info 也是 JSON）。body.files 是 [{name, base64}]。 */
    'import.cards': async (body) => {
      const ws = await root(body)
      const files = Array.isArray(body?.files) ? body.files : []
      if (files.length === 0) return { ok: false, error: '没有选文件。' }
      const results = []
      for (const file of files) {
        const fileName = String(file?.name ?? 'card')
        try {
          // 扩展名先过一遍白名单：codec 是按「签名嗅探」认格式的，一个
          // 随手改名的文件也能进去，但界面上的导入框只该收这几种。没有
          // 扩展名的照旧放行（有些导出工具就是不带后缀，靠签名认）。
          const ext = path.extname(fileName).toLowerCase()
          if (ext !== '' && !IMPORT_CARD_EXT.has(ext)) {
            throw new Error(`这个文件类型（${ext}）收不了。角色卡用 .png / .json / .charx，世界书用 .json。`)
          }
          const bytes = new Uint8Array(Buffer.from(String(file?.base64 ?? ''), 'base64'))
          if (bytes.length === 0) throw new Error('文件为空')
          const extracted = await codec.extractCard(bytes, fileName)
          if (extracted.kind === 'worldinfo') {
            const saved = await importWorldInfo(ws, extracted.json, fileName)
            results.push({ name: fileName, ok: true, kind: 'worldinfo', ...saved })
            continue
          }
          if (!['v1', 'v2', 'v3'].includes(extracted.kind)) {
            throw new Error('这个文件不像角色卡，也不像世界书。')
          }
          const life = codec.ccToLifeCard(extracted.json, { importedFrom: fileName })
          // id：优先用卡里的 name 收成 slug；重名时加后缀
          let id = core.safeId(life.data.name)
          id = await uniqueId(ws, id)
          life.data.id = id
          // 原件保真：存进 .lifecard/raw/
          const rawName = `${id}${path.extname(fileName) || '.json'}`
          const rawRel = path.posix.join('.lifecard/raw', rawName)
          await fs.mkdir(path.join(ws, '.lifecard/raw'), { recursive: true })
          // 原子写：原件是「以后想重新导入」的唯一依据，写一半断了就等于丢了。
          await writeFileAtomic(path.join(ws, rawRel), Buffer.from(bytes))
          life.data.cc.source_file = rawRel
          const rel = store.cardRelPath(id, life.data.world)
          const written = await store.writeCard(ws, rel, life.data, life.sections, { force: true })
          if (!written.ok) throw new Error(written.error ?? '写卡失败')
          results.push({
            name: fileName,
            ok: true,
            kind: extracted.kind,
            id,
            path: rel,
            title: life.data.name,
            sections: life.sections.length,
            preserved: Object.keys(life.data.cc.preserved ?? {}).length,
            raw: rawRel,
            issues: core.validateCard(life.data).issues,
          })
        } catch (error) {
          // 以前直接回 error.message，界面上一行英文谁看都不懂。
          console.error('[lifecard] 这张卡没导进来：', error)
          results.push({ name: fileName, ok: false, error: humanizeHostError(error) })
        }
      }
      return { ok: true, results, imported: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length }
    },

    /**
     * 导入一段文本作为材料。
     *
     * 和访谈产出的是同一种东西（materials/），之后走同一条 analyze 链路。
     * 原文只追加、不改写——它是所有断言的追溯终点。
     */
    'import.text': async (body) => {
      const ws = await root(body)
      // 「关于谁」会被原样存进材料里、也会被拿去拼提示词，同样得限长：
      // 以前只收 name 不收 about，一次粘进来几万字也能过。
      const about = String(body?.about ?? '').trim().slice(0, 200)
      const content = String(body?.content ?? '')
      if (content.trim() === '') return { ok: false, error: '文本是空的，先写一点。' }
      if (about === '') return { ok: false, error: '先说说这段材料是关于谁的。' }
      // 名字是文件名的一部分，长度和字符都得收一收：以前原样拼进去，
      // 一段超长的「关于谁」能拼出一个几百字的文件名（有些盘直接报错）。
      const name = core.safeId(String(body?.name ?? about)).slice(0, 80)
      const saved = await store.appendMaterial(ws, name, content.trim())
      // 没落盘就不能回「存好了」：以前不判返回值，写失败也报成功，
      // 用户以为材料进了库，下一步分析时才发现压根没有这份东西。
      if (saved?.ok !== true) {
        return { ok: false, error: saved?.error ?? '这段材料没能存下来，检查一下磁盘空间，再试一次。' }
      }
      return { ok: true, ...saved, about, chars: content.trim().length }
    },

    /** 从本地磁盘读一个文本文件作为材料（用户已有访谈稿/日记）。 */
    'import.textFile': async (body) => {
      const ws = await root(body)
      const filePath = String(body?.path ?? '').trim()
      if (filePath === '') return { ok: false, error: '没有选文件。' }
      // 这条路由收的是「你在文件选择器里点的那个文件」，本来就常常在工作区外面
      //（比如从下载文件夹里挑一份访谈记录），所以不能像别的路由那样只放行工作区
      // 之内的路径——那样等于让「导入一段文字」这个功能失效。
      // 但它确实是个不带凭据的 POST：网页上任何脚本都能往这里发一个路径。
      // 所以按「只可能读到什么」来卡，而不是按「在哪里」来卡：
      //   只认纯文本类后缀 + 只认普通文件（挡住 /dev/*）+ 8 MB 上限。
      // 最坏情况是读到一份文本，读不到凭证、目录、整个盘。
      const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.json', '.csv', '.log', '.yml', '.yaml', '.html', '.htm'])
      const raw = filePath.replace(/^~(?=\/|$)/, homedir())
      const base = path.resolve(ws)
      const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(base, raw)
      if (!TEXT_EXT.has(path.extname(abs).toLowerCase())) {
        // 不写「Markdown / CSV」这类后缀名：用户手里是一份文档，
        // 他不需要知道它叫什么格式，只需要知道「拿过来能不能读」。
        return { ok: false, error: '这个格式暂时读不了。纯文字的文件都可以；是图片的话请用「导入角色卡」。' }
      }
      let stat
      try {
        stat = await fs.stat(abs)
      } catch {
        return { ok: false, error: '找不到这个文件。它可能刚被移走或改名了，重新选一次。' }
      }
      if (!stat.isFile()) return { ok: false, error: '这是一个文件夹，不是文件。' }
      const textCap = mbToBytes(config?.maxTextFileMB, 8)
      if (stat.size > textCap) {
        return { ok: false, error: `这个文件太大了（超过 ${(textCap / 1048576).toFixed(0)} MB 的纯文字很少见），换一个小一点的。` }
      }
      let text
      try {
        text = await fs.readFile(abs, 'utf8')
      } catch (error) {
        return { ok: false, error: '这个文件读不了。可能它不是纯文本，或者已经被移走了。' }
      }
      if (text.trim() === '') return { ok: false, error: '文件是空的' }
      const about = String(body?.about ?? path.basename(abs, path.extname(abs))).trim()
      const name = String(body?.name ?? path.basename(abs, path.extname(abs)))
      const saved = await store.appendMaterial(ws, name, text.trim())
      return { ok: true, ...saved, about, chars: text.trim().length, source: abs }
    },

    // ── 书（跟 dsh-reading 对接）────────────────────────────────────
    //
    // 「导入一本书」在用户眼里就是把书拿进来读一读。落地方式是：问 dsh-reading
    // 要正文，存成一份普通的材料。之后它和贴进来的一段文字走完全相同的链路
    //（分析、访谈、拆书），不需要再为「书」开一条。
    //
    // 为什么不直接读它的库文件：书在它那边是解析过的（PDF 拆成 XHTML、
    // mobi 拆成 spine，图片换成它自己的 asset 路由）。照着文件硬读等于把它
    // 内部的排版规则实现第二遍，它一改版就全错。走它自己的路由，格式那边永远对。
    //
    // 它不向宿主提供 service（`inject` 只有 webServer），所以只能走 HTTP。
    // 好在本机回环、同端口，不受浏览器跨域限制。

    /**
     * 书在哪、连没连上、有几本、占多大。
     *
     * 单独一条而不是塞进 `state.get`：后者每次开界面都跑一遍 `store.doctor`，
     * 已经不轻；再叠一次跨插件请求（还要扫一遍书库目录）会让首屏跟着一个
     * 可能根本不存在的邻居一起变慢。
     */
    'reading.status': async (body, context) => {
      const ws = await root(body)
      const origin = readingOrigin(context)
      // 用 device.info 探活而不是 shelf.list：后者要扫整个书库，
      // 一本 PDF 转出来的书有上千个小文件，做成「开界面就查一次」会明显发涩。
      const alive = await reading.callReading(origin, 'device.info', {}, { timeoutMs: 6000 })
      const library = await reading.libraryFootprint().catch(() => null)
      if (alive.ok !== true) {
        // 连不上和「没装」在用户眼里是两件事：前者等一会儿或重开，
        // 后者要去装。offline 带回去让界面决定说哪句。
        return { ok: true, connected: false, offline: alive.offline === true, reason: alive.error, library, books: 0 }
      }
      const landed = await reading.callReading(origin, 'shelf.list', {}, { timeoutMs: 20000 })
      const books = landed.ok === true && Array.isArray(landed.value?.books) ? landed.value.books.length : 0
      let materials = 0
      try {
        materials = Object.keys(await store.readMaterials(ws)).length
      } catch {
        materials = 0
      }
      return {
        ok: true,
        connected: true,
        offline: false,
        deviceId: String(alive.value?.deviceId ?? ''),
        library,
        books,
        materials,
        // 连上了但书架列不出来，和「没连上」不是一件事：前者重开读书就好。
        shelfError: landed.ok === true ? '' : (landed.error ?? '书架读不出来。'),
      }
    },

    /**
     * 书架上有哪些书。
     *
     * 只挑界面用得到的那几列：`shelf.list` 一本书二十来个字段，全转一遍既没必要，
     * 也容易把它的内部结构漏到界面上（那些字段名以后它随时可能改）。
     */
    'reading.books': async (body, context) => {
      const origin = readingOrigin(context)
      const shelf = await reading.callReading(origin, 'shelf.list', {}, { timeoutMs: 20000 })
      if (shelf.ok !== true) return { ok: false, offline: shelf.offline === true, error: shelf.error ?? '书架读不出来。' }
      const raw = Array.isArray(shelf.value?.books) ? shelf.value.books : []
      return {
        ok: true,
        books: raw.map((one) => ({
          hash: String(one?.bookHash ?? ''),
          title: String(one?.title ?? '').trim() || '没名字的书',
          author: String(one?.author ?? '').trim(),
          format: String(one?.sourceFormat ?? ''),
          // 读到几成。列表上用来标「没开始 / 读到一半 / 读完了」。
          percent: Number.isFinite(one?.percent) ? one.percent : 0,
          // 封面是它自己的相对地址，浏览器直接当 <img> 用。
          // PDF 转的常常没有封面，留空，界面上摆首字。
          cover: typeof one?.coverUrl === 'string' ? one.coverUrl : '',
          updatedAt: String(one?.updatedAt ?? ''),
        })).filter((one) => one.hash !== ''),
      }
    },

    /**
     * 把一本书的正文抄成一份材料。
     *
     * 抄一份而不是「以后要用再去读」：材料是我们自己的存档，用户在读书那边
     * 删了这本书，已经读进来的内容不该跟着消失。
     */
    'reading.pull': async (body, context) => {
      const ws = await root(body)
      const origin = readingOrigin(context)
      const hash = String(body?.hash ?? body?.bookHash ?? '').trim()
      if (hash === '') return { ok: false, error: '没说是哪一本书。' }
      const spine = await reading.callReading(origin, 'book.spine', { bookHash: hash }, { timeoutMs: 20000 })
      if (spine.ok !== true) {
        return { ok: false, offline: spine.offline === true, error: spine.error ?? '这本书的目录读不出来。' }
      }
      const list = Array.isArray(spine.value?.spine) ? spine.value.spine : []
      if (list.length === 0) return { ok: false, error: '这本书里没有章节目录，读不出正文。' }
      // 书名和作者从书架上补：界面上点进来时只传了 hash，
      // 材料标题总得有个像样的名字，不然一堆「书-xxxxxxxx」分不清。
      let known = null
      const shelf = await reading.callReading(origin, 'shelf.list', {}, { timeoutMs: 20000 })
      if (shelf.ok === true && Array.isArray(shelf.value?.books)) {
        known = shelf.value.books.find((one) => String(one?.bookHash ?? '') === hash) ?? null
      }
      const title = String(body?.title ?? known?.title ?? '').trim()
      const author = String(body?.author ?? known?.author ?? '').trim()
      const pulled = await reading.bookToMaterial(origin, { bookHash: hash, title, author, spine: list }, {
        maxChars: reading.MATERIAL_CHAR_CAP,
      })
      if (pulled.ok !== true) return { ok: false, offline: pulled.offline === true, error: pulled.error }
      const about = title === '' ? '一本书' : title
      const name = core.safeId(`书-${about}`).slice(0, 80)
      // replace:true —— 同一本书再导一次是「重新抄一遍」，不是「再存一份」。
      // 追加的话 AI 读材料时会把同一本书的两份都当真，同一个事实被引两次。
      const saved = await store.appendMaterial(ws, name, pulled.text, { replace: body?.replace !== false })
      if (saved?.ok !== true) return { ok: false, error: saved?.error ?? '这本书没能存下来，检查一下磁盘空间再试。' }
      return {
        ok: true,
        ...saved,
        about,
        title,
        author,
        chars: pulled.text.length,
        chapters: pulled.chapters,
        total: pulled.total,
        truncated: pulled.truncated === true,
      }
    },

    /**
     * 往 dsh-reading 里放一本书（用户手上有电子书，想先扔进书架再读过来）。
     *
     * body.files 和 import.cards 一样是 `[{name, base64}]`：界面上是同一个
     * 拖拽区，不该因为落到不同插件就写两套上传代码。
     */
    'reading.importBooks': async (body, context) => {
      const files = Array.isArray(body?.files) ? body.files : []
      if (files.length === 0) return { ok: false, error: '没有选文件。' }
      const origin = readingOrigin(context)
      const results = []
      for (const file of files) {
        const fileName = String(file?.name ?? 'book')
        const base64 = String(file?.base64 ?? '')
        if (base64 === '') {
          results.push({ name: fileName, ok: false, error: '这个文件是空的。' })
          continue
        }
        // 一本书的导入可能是 PDF 转 XHTML，慢（一本几百页的要几十秒），
        // 超时给足。界面上那一块有 spinner，不会看着像死了。
        const sent = await reading.callReading(origin, 'shelf.import', { filename: fileName, dataBase64: base64 }, { timeoutMs: 180000 })
        if (sent.ok !== true) {
          results.push({ name: fileName, ok: false, offline: sent.offline === true, error: sent.error })
          continue
        }
        results.push({ name: fileName, ok: true, hash: String(sent.value?.bookHash ?? ''), title: String(sent.value?.title ?? fileName) })
      }
      return { ok: true, results, imported: results.filter((one) => one.ok).length, failed: results.filter((one) => !one.ok).length }
    },

    /** 导出成 PNG（双 chunk 同源）。 */
    /** 设头像。body.base64 应当是已经裁成 2:3 的 PNG。 */
    'avatar.set': async (body) => {
      const ws = await root(body)
      const safe = await insideWorkspace(ws, body?.path)
      if (safe.ok !== true) return { ok: false, error: safe.error }
      const rel = safe.rel
      const card = await store.readCard(ws, rel)
      if (!card.ok) return card
      const saved = await store.writeAvatar(ws, card.data?.id, body?.base64, { maxBytes: mbToBytes(config?.maxAvatarMB, 8) })
      if (saved.ok !== true) return saved
      return { ok: true, path: rel, avatar: saved.path, bytes: saved.bytes }
    },

    /** 去头像，回到首字方块。 */
    'avatar.remove': async (body) => {
      const ws = await root(body)
      const safe = await insideWorkspace(ws, body?.path)
      if (safe.ok !== true) return { ok: false, error: safe.error }
      const rel = safe.rel
      const card = await store.readCard(ws, rel)
      if (!card.ok) return card
      return store.removeAvatar(ws, card.data?.id)
    },

    /** 一次取回所有头像，供列表页用（一张卡一次请求的话列表会很慢）。 */
    'avatar.list': async (body) => {
      const ws = await root(body)
      const all = await store.listAll(ws)
      const out = {}
      for (const c of all.cards) {
        const b64 = await store.readAvatar(ws, c.id)
        if (b64 !== null) out[c.id] = b64
      }
      for (const w of all.worlds) {
        const b64 = await store.readAvatar(ws, w.id)
        if (b64 !== null) out[w.id] = b64
      }
      return { ok: true, avatars: out }
    },

    'export.card': async (body) => {
      const ws = await root(body)
      const safe = await insideWorkspace(ws, body?.path)
      if (safe.ok !== true) return { ok: false, error: safe.error }
      const rel = safe.rel
      const card = await store.readCard(ws, rel)
      if (!card.ok) return card
      // SPEC §6 的导出门禁：lens 永不可导出、consent 三条、未成年人禁 PNG。
      const blocked = exportBlockedBy(card.data, 'png')
      if (blocked !== null) return { ok: false, error: blocked }
      // 底图：优先用导入时的原件，否则造一张 1x1 白图。
      // 这个路径存在卡文件里，而卡文件是能手改、能导入的——一样要钉在工作区内，
      // 否则卡里写一句 ../../别的图.png 就能把工作区外的图塞进导出结果里。
      let base = null
      const rawRel = card.data?.cc?.source_file
      if (typeof rawRel === 'string' && rawRel.endsWith('.png')) {
        const safeRaw = await insideWorkspace(ws, rawRel)
        if (safeRaw.ok === true) base = await fs.readFile(path.join(ws, safeRaw.rel)).catch(() => null)
      }
      if (base === null) base = blankPng()
      const out = codec.exportCardPng(new Uint8Array(base), { data: card.data, sections: card.sections })
      return {
        ok: true,
        path: rel,
        base64: Buffer.from(out.png).toString('base64'),
        filename: `${core.safeId(card.data?.name ?? 'card')}.png`,
        consistent: out.consistent,
        missing: out.missing,
      }
    },

    /** 导出成 JSON（CCv3）。 */
    'export.json': async (body) => {
      const ws = await root(body)
      const safe = await insideWorkspace(ws, body?.path)
      if (safe.ok !== true) return { ok: false, error: safe.error }
      const rel = safe.rel
      const card = await store.readCard(ws, rel)
      if (!card.ok) return card
      // 与 PNG 同一道闸门，只放宽未成年人那条（JSON 是留给自己的档，不是转发格式）。
      const blocked = exportBlockedBy(card.data, 'json')
      if (blocked !== null) return { ok: false, error: blocked }
      const json = codec.lifeCardToCc({ data: card.data, sections: card.sections }, { asV3: true })
      return { ok: true, path: rel, json, filename: `${core.safeId(card.data?.name ?? 'card')}.json` }
    },

    /** 加材料（文本问答 / 访谈回答）。 */
    'material.add': async (body) => {
      const ws = await root(body)
      const about = String(body?.about ?? '')
      const content = String(body?.content ?? '')
      if (content.trim() === '') return { ok: false, error: '内容是空的，先写一点。' }
      const name = String(body?.name ?? about ?? 'material')
      const block = body?.meta === undefined ? content : `${content}\n\n\`\`\`\n${body.meta}\n\`\`\``
      const saved = await store.appendMaterial(ws, name, block)
      // 以前这里无条件 `ok:true` 再展开 saved，把 `ok:false` 盖掉了：
      // 存失败时界面照样说「已保存」。别的路由都是先判 saved.ok 再往下走。
      if (saved?.ok !== true) return { ok: false, error: saved?.error ?? '这段材料没存进去。', ...saved }
    },

    /** 材料列表 + 全文（分析用）。 */
    'material.list': async (body) => {
      const ws = await root(body)
      const all = await store.readMaterials(ws)
      const files = Object.entries(all).map(([p, text]) => ({
        path: p,
        name: path.basename(p),
        chars: text.length,
        preview: text.slice(0, 120),
      }))
      return { ok: true, files, bodies: body?.withBody === true ? all : undefined }
    },

    /** 删材料。只能删 materials/ 下面的；删了就真没了，不留底。 */
    'material.delete': async (body) => {
      const ws = await root(body)
      return store.deleteMaterial(ws, body?.path)
    },

    /**
     * 分析：材料 → 提案。
     *
     * 流程：读材料 → 拼提示词 → 调模型 → 解析 JSON → 过引文门 → 写 proposals/。
     * 引文门不通过的条目直接丢弃，并在提案里列出来。
     */
    /** 读「想要什么样的人」。 */
    'concept.get': async (body) => {
      const ws = await root(body)
      const concept = await store.readConcept(ws)
      return { ok: true, concept }
    },

    /** 存「想要什么样的人」。传空等于清除。 */
    'concept.set': async (body) => {
      const ws = await root(body)
      const saved = await store.writeConcept(ws, body?.concept ?? null)
      if (saved.ok !== true) return saved
      return { ok: true, concept: saved.concept }
    },

    /**
     * 第一次打开时那段简短介绍，看过了没有。
     *
     * 存在工作区配置里而不是浏览器里：用户换台机器、重装插件，
     * 只要还是同一个文件夹，就不该再被同一段介绍拦一次。
     * 但换了文件夹会再看一遍——那本来就是另一个库，该重新说一次。
     */
    'ui.intro': async (body) => {
      const ws = await root(body)
      const cfg = await store.readConfig(ws)
      if (body?.seen === true) {
        // 返回值必须看：以前这里丢掉 writeConfig 的结果，写失败也回「看过了」，
        // 于是用户点掉引导、刷新一下又弹、重启还弹，怎么点都点不掉。
        const saved = await store.writeConfig(ws, { intro_seen: true })
        if (saved?.ok !== true) {
          return { ok: false, error: saved?.error ?? '这次没记住你看过了，下次可能还会再弹一次。' }
        }
        return { ok: true, seen: true }
      }
      return { ok: true, seen: cfg.intro_seen === true }
    },

    // ── 求职 ────────────────────────────────────────────────────
    //
    // 「看一份招聘说明」是这个插件唯一会替你判断的事。它不问要不要投、
    // 也不投——只把这份招聘说明拆成「它要什么」，再拿你自己的材料逐条对，
    // 对不上的地方老实说对不上。每个结论都挂着两处原文，缺一个就丢。

    /** 求职：读自己的求职设置。 */
    'job.profile.get': async (body) => {
      const ws = await root(body)
      return await jobsStore.readJobProfile(store, ws)
    },

    /** 求职：写求职设置（想找的方向、期望薪资、不能接受什么）。 */
    'job.profile.set': async (body) => {
      const ws = await root(body)
      const saved = await jobsStore.writeJobProfile(store, ws, body?.profile ?? {})
      if (saved.ok !== true) return saved
      return { ok: true, profile: saved.profile }
    },

    /**
     * 求职：看一份招聘说明。
     *
     * 两遍走：第一遍只读 JD，第二遍才读材料。中间各自过一遍闸门。
     * 第一遍如果什么都读不出来（太短、不是招聘说明），直接停——
     * 让它硬编一份「岗位要求」出来比报错坏得多。
     */
    'job.evaluate': async (body) => {
      const ws = await root(body)
      const raw = String(body?.jd ?? '')
      if (raw.trim() === '') return { ok: false, error: '还没贴招聘说明。把整段招聘内容贴进来说。' }
      const tooShort = jobs.judgeTooShort(raw)
      if (tooShort !== null) return { ok: false, error: tooShort }

      // 招聘贴是外部输入，先剥掉像在给程序下命令的句子
      const guard = jobs.guardPosting(raw)
      const jd = guard.cleaned === '' ? raw.trim() : guard.cleaned

      const model = typeof body?.model === 'string' && body.model !== '' ? body.model : (config?.defaultAnalysisModel ?? undefined)
      const system = '你是一个只做判断、不做鼓励的助手。你的每条结论都会被程序拿回原文逐字核对，对不上的会被丢掉。'
      const attempts = Math.max(1, Math.min(3, Number(body?.attempts ?? 2)))
      const tried = []

      // 第一遍：只读 JD
      const jdPrompt = jobs.buildJdPassPrompt({ jd, company: body?.company, role: body?.role })
      let pass1 = null
      let firstCall = null
      for (let n = 0; n < attempts; n += 1) {
        const user = n === 0 ? jdPrompt : `${jdPrompt}\n\n（上一次的输出没法解析。请只输出 JSON，不要解释文字。）`
        firstCall = await callModel(ctx, { system, user, model })
        if (!firstCall.ok) { tried.push({ pass: 1, attempt: n + 1, kind: 'model-error', error: firstCall.error }); continue }
        const parsed = extractJson(firstCall.text)
        if (parsed === undefined) { tried.push({ pass: 1, attempt: n + 1, kind: 'unparsable' }); continue }
        pass1 = parsed
        break
      }
      if (pass1 === null) {
        return {
          ok: false,
          error: firstCall === null || firstCall.ok ? 'AI 这次没给出能用的结果。' : (firstCall.error ?? '调用模型失败'),
          attempts: tried,
          hint: '也可以不用 AI：自己把这条招聘说明读一遍，把「缺了就免谈」的几条挑出来，直接对照你的材料。',
        }
      }
      const jdCheck = jobs.checkJdPass(pass1, jd)
      if (!jdCheck.ok) {
        return {
          ok: false,
          error: '这份招聘说明读不出明确的岗位要求，可能内容太笼统。',
          dropped: jdCheck.reasons,
          hint: '把职责和要求那几段一起贴进来会更准。',
        }
      }

      // 第二遍：读材料逐条对
      const materials = await store.readMaterials(ws)
      const profileRes = await jobsStore.readJobProfile(store, ws)
      const profile = profileRes.ok === true ? profileRes.profile : null
      const matchPrompt = jobs.buildMatchPassPrompt({
        jd,
        pass1: { requirements: jdCheck.requirements },
        materials,
        selfCard: profile,
      })
      let pass2 = null
      let secondCall = null
      for (let n = 0; n < attempts; n += 1) {
        const user = n === 0 ? matchPrompt : `${matchPrompt}\n\n（上一次的输出没法解析。请只输出 JSON，不要解释文字。）`
        secondCall = await callModel(ctx, { system, user, model })
        if (!secondCall.ok) { tried.push({ pass: 2, attempt: n + 1, kind: 'model-error', error: secondCall.error }); continue }
        const parsed = extractJson(secondCall.text)
        if (parsed === undefined) { tried.push({ pass: 2, attempt: n + 1, kind: 'unparsable' }); continue }
        pass2 = parsed
        break
      }
      if (pass2 === null) {
        return {
          ok: false,
          error: '第二遍读材料时 AI 没给出能用的结果。',
          attempts: tried,
          requirements: jdCheck.requirements,
          hint: '可以再试一次；或者照着上面这些要求，自己对着材料看一遍。',
        }
      }

      const matchCheck = jobs.checkMatchPass(pass2, { requirements: jdCheck.requirements }, materials)

      // 一票否决优先于一切。用户自己写的不接受，是这个插件唯一无条件执行的规则。
      const dealbreakers = jobs.checkDealbreakers(
        Array.isArray(profile?.dealbreakers) ? profile.dealbreakers : [],
        jd,
      )

      const result = {
        ok: true,
        company: String(pass1.company ?? body?.company ?? '').trim(),
        role: String(pass1.role ?? body?.role ?? '').trim(),
        signals: pass1.signals ?? {},
        rows: matchCheck.rows,
        matched: matchCheck.matched,
        gaps: matchCheck.gaps,
        unclear: matchCheck.unclear,
        blocked: matchCheck.blocked,
        strengths: matchCheck.strengths,
        blockers: matchCheck.blockers,
        questions: matchCheck.questions,
        dealbreakers,
        warnings: guard.warnings,
        dropped: [...jdCheck.reasons, ...matchCheck.reasons],
        materialsUsed: Object.keys(materials),
        attempts: tried,
      }
      result.markdown = jobs.renderReport(result)
      const saved = await jobsStore.saveEvaluation(ws, result, { markdown: result.markdown })
      if (saved.ok === true) {
        result.path = saved.path
        result.markdown = `${result.markdown}\n\n---\n\n存成了 \`${saved.path}\`。`
      } else {
        // 分析出来了，但没存进文件夹。以前这里一声不响：界面看见没有 path 就
        // 什么都不说，用户以为已经归档，回头在「以前看过的」里找不到，
        // 而这份报告翻篇就没了。报告本身别丢，先让他看见并抄走。
        result.saveFail = `这份报告没能存进文件夹（${String(saved.error ?? '原因不明').replace(/。$/, '')}）。现在它只在屏幕上，翻篇就没了——先把下面这段复制走。`
      }
      return result
    },

    /**
     * 求职：这家公司我认识谁。
     *
     * 唯一一件通用求职工具做不到的事：档案里躺着「我爸在XXXX 公司」
     * 「老张去了那家做支付的公司」。这里只逐字找公司名，找到就把那一行
     * 原样给你看；找不到就说找不到，不推「可能认识」。
     */
    'job.network': async (body) => {
      const ws = await root(body)
      const company = String(body?.company ?? '').trim()
      if (company === '') return { ok: false, error: '要查哪家公司？把公司名写上。' }
      const list = await store.listAll(ws)
      const cards = []
      for (const c of list.cards ?? []) {
        // listAll 给的是摘要，正文要单独读
        const full = await store.readCard(ws, c.path)
        if (full.ok === true) cards.push({ path: c.path, data: full.data, sections: full.sections })
      }
      const hits = jobs.findNetwork(cards, company)
      return { ok: true, company, hits, markdown: jobs.renderNetwork(hits, company) }
    },

    /** 求职：以前看过的评估。 */
    'job.evaluations': async (body) => {
      const ws = await root(body)
      return await jobsStore.listEvaluations(ws)
    },

    /** 求职：读一份评估。 */
    'job.evaluation.get': async (body) => {
      const ws = await root(body)
      return await jobsStore.readEvaluation(ws, body?.path)
    },

    /** 求职：投递记录。 */
    'job.tracker.list': async (body) => {
      const ws = await root(body)
      return await jobsStore.readTracker(ws)
    },

    /** 求职：记一笔投递。只记事实，不替你投。 */
    'job.tracker.add': async (body) => {
      const ws = await root(body)
      return await jobsStore.addApplication(ws, body?.row ?? {})
    },

    /** 求职：改投递状态。 */
    'job.tracker.update': async (body) => {
      const ws = await root(body)
      return await jobsStore.updateApplication(ws, { company: body?.company, role: body?.role }, body?.patch ?? {})
    },

    /**
     * 求职：面试故事。
     *
     * 这里的 AI 只做一件事：把材料里已经有的经历整理成「面试能讲的一段」。
     * 每个故事都必须挂得住原文——讲面试用编的故事，是当场被问穿的那种代价。
     */
    'job.stories': async (body) => {
      const ws = await root(body)
      return await jobsStore.readStories(ws)
    },

    'job.story.add': async (body) => {
      const ws = await root(body)
      return await jobsStore.addStory(ws, body?.story ?? {})
    },

    /** 求职：草稿（简历 / 求职信）。 */
    'job.drafts': async (body) => {
      const ws = await root(body)
      return await jobsStore.listDrafts(ws, body?.kind === 'cover' ? 'cover' : 'resume')
    },

    'job.draft.get': async (body) => {
      const ws = await root(body)
      return await jobsStore.readDraft(ws, body?.path)
    },

    /**
     * 求职：照这份招聘说明改一版简历。
     *
     * **不许新造事实**：这一版只是把材料里已有的经历换个说法、按 JD 的顺序排。
     * 每一个数字都要能在材料里找到同一个数字——找不到就整段不写，
     * 而不是猜一个「大概 30%」。
     */
    'job.resume.build': async (body) => {
      const ws = await root(body)
      // career 是「用到才加载」的模块：不先 ensureModules，这里的 career 还是 null，
      // 下面取风格行就会在每次真实调用时抛 TypeError。测试发现不了——这条路要调模型。
      await ensureModules()
      const jd = String(body?.jd ?? '').trim()
      if (jd === '') return { ok: false, error: '要照哪份招聘说明改？先把招聘内容贴进来。' }
      const materials = await store.readMaterials(ws)
      if (Object.keys(materials).length === 0) {
        return { ok: false, error: '还没有材料。先写几段自己的经历，改简历才有东西可改。' }
      }
      const profileRes = await jobsStore.readJobProfile(store, ws)
      const profile = profileRes.ok === true ? profileRes.profile : null
      const system = '你是一个只重写措辞、不发明事实的简历编辑。你写出的每个数字都必须能在给定材料里找到同一个数字。'
      const matBlock = Object.entries(materials).map(([n, b]) => `### ${n}\n${b}`).join('\n\n')
      const prompt = [
        '按下面这份招聘说明，把这个人已有的经历重排成一版简历。',
        '',
        '## 招聘说明',
        '```',
        jobs.guardPosting(jd).cleaned,
        '```',
        '',
        '## 他的材料（**这是唯一的事实来源**）',
        matBlock,
        '',
        '## 写法',
        '- 顺序按招聘说明看重什么来排，最相关的经历放前面。',
        '- 每条经历一到两行，开头写做了什么，结尾写结果。',
        '- **数字只能用材料里出现过的数字。** 材料没写数字，就写「明显改善」这种能站住的话，不要编一个百分比。',
        '- 材料里没有的经历、公司、项目，一律不许加。',
        '- 不写自我评价、不写「本人性格开朗」这种。',
        // 风格只加在「怎么写」这一组里，而且加在数字核对**之前**：
        // 三档过的是同一道 unsupportedNumbers 检查，不能因为「这档更温和」
        // 就放松核对——那等于用语气换事实。
        ...(career === null ? [] : career.resumeStyleLines(typeof body?.style === 'string' ? body.style : undefined)),
        '',
        '## 输出格式',
        '直接输出 Markdown 简历，不要解释，不要代码块包起来。第一行是名字。',
        '',
        profile === null || profile.target_roles === undefined ? '' : `（这个人想做的方向：${profile.target_roles}）`,
      ].filter((s) => s !== '').join('\n')
      const called = await callModel(ctx, { system, user: prompt, model: typeof body?.model === 'string' && body.model !== '' ? body.model : undefined })
      if (!called.ok) return { ok: false, error: called.error }
      const text = String(called.text ?? '').trim()
      if (text === '') return { ok: false, error: 'AI 没写出东西来。' }
      // 每个数字都要能在材料里找到同一个数字
      const numbers = [...new Set((text.match(/\d+(?:\.\d+)?%?/g) ?? []))]
      const matText = Object.values(materials).join('\n')
      const invented = numbers.filter((n) => !matText.includes(n))
      const saved = await jobsStore.saveDraft(ws, 'resume', String(profile?.target_roles ?? body?.company ?? '简历'), text)
      // 两条提示都得说出来：数字对不上要说，没存进文件夹也要说（以前只把
      // path 降成 null，界面上什么都不显示，用户以为存好了）。
      const notes = []
      if (invented.length > 0) {
        notes.push(`这版里有 ${invented.length} 个数字在你材料里找不到：${invented.slice(0, 8).join('、')}。投之前自己核一遍，拿不出处的最好删掉。`)
      }
      if (saved.ok !== true) {
        notes.push(`这版没能存进文件夹（${String(saved.error ?? '原因不明').replace(/。$/, '')}），现在只在屏幕上，先复制走。`)
      }
      return {
        ok: true,
        markdown: text,
        path: saved.ok === true ? saved.path : null,
        unsupportedNumbers: invented,
        warning: notes.length === 0 ? null : notes.join('\n'),
      }
    },

    /**
     * 求职：写一封求职信。
     *
     * 和简历同一条硬规矩：**不许编事**。求职信最容易写成空话，
     * 所以要求它必须从材料里挑一件具体的事讲，讲不出来就不写。
     */
    'job.cover.build': async (body) => {
      const ws = await root(body)
      const jd = String(body?.jd ?? '').trim()
      if (jd === '') return { ok: false, error: '要写给哪家？先把招聘内容贴进来。' }
      const materials = await store.readMaterials(ws)
      if (Object.keys(materials).length === 0) {
        return { ok: false, error: '还没有材料。先写几段自己的经历，写出来的信才不像模板。' }
      }
      const profileRes = await jobsStore.readJobProfile(store, ws)
      const profile = profileRes.ok === true ? profileRes.profile : null
      const matBlock = Object.entries(materials).map(([n, b]) => `### ${n}\n${b}`).join('\n\n')
      const system = '你是一个只讲真事、不写空话的求职信代笔。写不出具体的事时你会老实说写不出来。'
      const prompt = [
        '给下面这家公司写一封求职信。',
        '',
        '## 招聘说明',
        '```',
        jobs.guardPosting(jd).cleaned,
        '```',
        '',
        '## 他的材料（唯一的事实来源）',
        matBlock,
        '',
        '## 写法',
        '- 三百字以内。招聘的人一天看几十封，长了没人读。',
        '- 正文必须讲**材料里的一件具体的事**，把那件事讲清楚，比夸自己十句有用。',
        '- 不许写「贵公司平台广阔」这类谁都能说的话。',
        '- 材料里没有的经历不要提。',
        '- 结尾写清楚你想做什么、怎么联系。',
        '',
        '## 输出格式',
        '直接输出 Markdown 正文，不要代码块。开头不要「尊敬的 HR」这种套话。',
        '',
        profile === null || profile.target_roles === undefined ? '' : `（这个人想做的方向：${profile.target_roles}）`,
      ].filter((s) => s !== '').join('\n')
      const called = await callModel(ctx, { system, user: prompt, model: typeof body?.model === 'string' && body.model !== '' ? body.model : undefined })
      if (!called.ok) return { ok: false, error: called.error }
      const text = String(called.text ?? '').trim()
      if (text === '') return { ok: false, error: 'AI 没写出东西来。' }
      const saved = await jobsStore.saveDraft(ws, 'cover', String(body?.company ?? '求职信'), text)
      return { ok: true, markdown: text, path: saved.ok === true ? saved.path : null }
    },

    // ── 模拟面试 ──────────────────────────────────────────────
    //
    // 这是「看工作」里唯一会**反过来问你**的东西。三件事写死在这里：
    //   1. 只问不说教——它不会告诉你答得好不好，只在最后列事实；
    //   2. 不背调、不碰就业歧视那些问题（禁问表在 jobs-interview.js 里）；
    //   3. 追问必须引用你上一句的原话，引不出来就退回一句朴素的本地问题。

    /**
     * 开一场模拟面试。
     *
     * `requirements` 一般来自刚做完的那份评估（rows 里每条要求的
     * importance 和 verdict），也可以不给——那样就只练通用的几问。
     */
    'job.interview.start': async (body) => {
      const ws = await root(body)
      const stamp = new Date()
      const id = `mock-${stamp.toISOString().replace(/[-:T.]/g, '').slice(0, 12)}-${Math.floor(stamp.getTime() / 1000) % 100000}`
      const reqs = Array.isArray(body?.requirements) ? body.requirements : []
      const session = {
        id,
        company: String(body?.company ?? '').trim(),
        role: String(body?.role ?? '').trim(),
        jd: String(body?.jd ?? '').slice(0, 8000),
        requirements: reqs.map((r) => ({
          requirement: String(r?.requirement ?? '').trim(),
          importance: String(r?.importance ?? 'medium'),
          verdict: String(r?.verdict ?? 'unclear'),
          proof: String(r?.proof ?? ''),
        })),
        started_at: stamp.toISOString(),
        turns: [],
        asked: [],
      }
      const saved = await jobsStore.saveInterview(ws, session)
      if (saved.ok !== true) return saved
      return { ok: true, session, path: saved.path }
    },

    /**
     * 问下一个问题。
     *
     * 有 AI 就让 AI 问（追问质量高得多），没有 AI 或它给的这一问过不了闸，
     * 就退回本地从招聘说明里抠出来的那句——面试练习不该因为模型抽风就开不了。
     */
    'job.interview.turn': async (body) => {
      const ws = await root(body)
      const got = await jobsStore.readInterview(ws, body?.id)
      if (got.ok !== true) return got
      const session = got.session
      if (Array.isArray(session.turns) && session.turns.length >= interview.MAX_TURNS) {
        return { ok: true, done: true, session, reason: `已经问了 ${interview.MAX_TURNS} 个问题，再问下去人会开始敷衍。` }
      }

      const turns = Array.isArray(session.turns) ? session.turns : []
      const target = interview.pickTarget(session.requirements, session.asked)
      const lastAnswer = String(turns[turns.length - 1]?.answer ?? '')
      const focus = interview.pickFocus(lastAnswer)
      const askedList = turns.map((t) => t.question)

      let question = null
      let by = 'local'
      const offline = interview.offlineQuestion(target, { company: session.company })

      const llm = ctx.get?.('llm')
      if (llm !== undefined && llm !== null) {
        const prompt = interview.buildTurnPrompt({
          company: session.company,
          role: session.role,
          requirements: session.requirements,
          transcript: turns.flatMap((t) => [
            { role: 'interviewer', text: t.question },
            ...(String(t.answer ?? '').trim() === '' ? [] : [{ role: 'candidate', text: t.answer }]),
          ]),
          target,
          focus,
          cvText: session.cvText ?? '',
          questionNo: turns.length + 1,
        })
        // 被拦下时带着原因重问一次：模型不知道自己踩了哪条线，
        // 不告诉它就只会原样再问一遍，白丢一整轮。
        // 注意：这里不要在循环外先问一次——以前那样写会白打一次模型（结果被下面同名变量遮蔽），
        // 用户付两次钱，第一次的回答直接扔掉。
        let reject = ''
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const retryPrompt = reject === ''
            ? prompt
            : interview.buildTurnPrompt({
              company: session.company,
              role: session.role,
              requirements: session.requirements,
              transcript: turns.flatMap((t) => [
                { role: 'interviewer', text: t.question },
                ...(String(t.answer ?? '').trim() === '' ? [] : [{ role: 'candidate', text: t.answer }]),
              ]),
              target,
              focus,
              cvText: session.cvText ?? '',
              questionNo: turns.length + 1,
              reject,
            })
          const called = await callModel(ctx, {
            system: '你在一场模拟面试里当面试官。你只提问，不评价，不解释。你问的每一句都会被程序检查：重复的不算、问了不该问的会被拦下、追问他上一句时引不到原话会被丢掉。',
            user: retryPrompt,
            model: typeof body?.model === 'string' && body.model !== '' ? body.model : (config?.defaultAnalysisModel ?? undefined),
          })
          if (!called.ok) break
          const checked = interview.checkQuestion(extractJson(called.text), { asked: askedList, lastAnswer })
          if (checked.ok === true) {
            question = checked.question
            by = 'ai'
            break
          }
          reject = checked.reason ?? ''
        }
        if (question === null && reject !== '') {
          // 把被丢掉的原因带回去，界面上看得出来这不是模型随口问的
          session.lastDropReason = reject
        }
      }

      if (question === null) {
        question = { question: offline, kind: target.kind, quoted: '', why_ask: '' }
      }

      const turn = {
        ...question,
        target_index: target.requirement === null || target.requirement === undefined ? null : target.requirement.index,
        asked_at: new Date().toISOString(),
        by,
      }
      session.turns = [...turns, turn]
      session.asked = [...(session.asked ?? []), ...(target.requirement === null || target.requirement === undefined ? [] : [`req:${target.requirement.index}`])]
      const saved = await jobsStore.saveInterview(ws, session)
      if (saved.ok !== true) return saved
      return { ok: true, session, turn, by, done: false }
    },

    /**
     * 答一题。
     *
     * 本地先看一遍这段回答（有没有具体的事、有没有说「我」做了什么、
     * 有没有结果）——这些判断不需要 AI，而且当场给出比事后给更有用。
     */
    'job.interview.answer': async (body) => {
      const ws = await root(body)
      const got = await jobsStore.readInterview(ws, body?.id)
      if (got.ok !== true) return got
      const session = got.session
      const turns = Array.isArray(session.turns) ? session.turns : []
      if (turns.length === 0) return { ok: false, error: '还没问问题，先点一下「开始」。' }
      const answer = String(body?.answer ?? '')
      const skipped = body?.skipped === true
      const last = turns[turns.length - 1]
      const review = skipped ? { length: 0, verdict: 'skipped', findings: [] } : interview.reviewAnswer(answer)
      turns[turns.length - 1] = {
        ...last,
        answer: skipped ? '' : answer,
        skipped,
        review,
        answered_at: new Date().toISOString(),
      }
      session.turns = turns
      const saved = await jobsStore.saveInterview(ws, session)
      if (saved.ok !== true) return saved
      const summary = interview.summarize(session)
      return { ok: true, session, review, tips: review.findings.map((f) => f.say), summary: summary.lines }
    },

    /** 结束这一场：写出能读的一份，并存盘。 */
    'job.interview.end': async (body) => {
      const ws = await root(body)
      const got = await jobsStore.readInterview(ws, body?.id)
      if (got.ok !== true) return got
      const session = got.session
      session.ended_at = new Date().toISOString()
      session.markdown = interview.renderTranscript(session)
      const saved = await jobsStore.saveInterview(ws, session)
      if (saved.ok !== true) return saved
      const summary = interview.summarize(session)
      return { ok: true, session, markdown: session.markdown, path: saved.markdown, summary: summary.lines }
    },

    'job.interview.get': async (body) => {
      const ws = await root(body)
      const got = await jobsStore.readInterview(ws, body?.id)
      if (got.ok !== true) return got
      return { ok: true, session: got.session, summary: interview.summarize(got.session).lines }
    },

    'job.interview.list': async (body) => {
      const ws = await root(body)
      return await jobsStore.listInterviews(ws)
    },

    /**
     * 草稿：写卡写到一半先存下来，下次接着写。
     *
     * `cardId` 由界面给（新卡还没保存时也有 id，是名字算出来的），
     * 所以这里不需要先有一张卡。草稿存在 .lifecard/drafts/，不进卡文件。
     */
    'draft.get': async (body) => {
      const ws = await root(body)
      const cardId = String(body?.cardId ?? '')
      if (cardId === '') return { ok: true, draft: null }
      const draft = await store.readDraft(ws, cardId)
      return { ok: true, draft }
    },

    'draft.save': async (body) => {
      const ws = await root(body)
      // 草稿里可能带着头像（几百 KB 的 base64）。上限沿用头像那一项配置：
      // 草稿文件每次自动保存都整份重写，没上限的话一个 20MB 的字符串能
      // 每分钟往盘上刷二十遍。
      if (body?.draft?.avatarTouched === true) {
        const avatar = String(body?.draft?.avatar ?? '')
        const cap = mbToBytes(config?.maxAvatarMB, 8)
        // base64 大约比原始字节多 4/3，判的时候按解码后的长度算，
        // 不然明明是「8MB 的图」却被当成 10.7MB 拒掉。
        if (avatar !== '' && Math.floor((avatar.length * 3) / 4) > cap) {
          return { ok: false, error: `头像太大了（上限 ${Math.round(cap / 1048576)}MB）。请重新截一张小一点的。` }
        }
      }
      const saved = await store.writeDraft(ws, String(body?.cardId ?? ''), body?.draft ?? {})
      if (saved.ok !== true) return saved
      return { ok: true, saved_at: saved.draft.saved_at }
    },

    'draft.drop': async (body) => {
      const ws = await root(body)
      await store.removeDraft(ws, String(body?.cardId ?? ''))
      return { ok: true }
    },

    'draft.list': async (body) => {
      const ws = await root(body)
      return { ok: true, drafts: await store.listDrafts(ws) }
    },

    /**
     * 记忆：从本机的记忆文件里认出「你身边有哪些人」。
     *
     * 三步是分开的，因为中间必须有人看一眼：
     *   ① memory.scan   —— 只读，列出认出来的人，什么都不写
     *   ② memory.import —— 把选中的人落成一份材料（不是卡！），红点标记不完整
     *   ③ 之后走正常的「分析 → 提案 → 人勾选」
     *
     * 为什么不直接建卡：记忆里关于一个人的信息通常只有一两句，
     * 直接建卡会造出一排空卡，用户既不知道缺什么也不知道从哪补。
     * 先落成材料，人能看见每条是从哪句话来的，能拒绝。
     */
    'memory.scan': async () => {
      const got = await gatherMemoryPeople()
      if (got.found !== true) {
        return { ok: true, found: false, people: [], reason: '这台电脑上没找到记忆文件，也没找到项目档案。' }
      }
      return {
        ok: true,
        found: true,
        files: got.files,
        chars: got.chars,
        // 分两类报：界面要说清「这是在哪儿翻出来的」。
        // 只报一个总数的话，用户会以为软件偷偷读了他别的文件。
        memory_files: got.memory_files,
        archive_files: got.archive_files,
        people: got.people, // 已经含 clues / missing / sources，界面直接就能画
      }
    },

    /**
     * 一个人一份材料，各自独立。
     *
     * 和 memory.import 的区别：那个是把一群人合成一份，适合先总览；
     * 这个是每人一份，好处是之后让 AI 读某个人时，它手上只有关于这个人的
     * 句子——写父亲的时候不会顺手把爷爷的职业接上去。一条材料只装一个人，
     * 是这套东西里最便宜的隔离。
     *
     * 同一份会覆盖，不追加：从记忆里「重新摘一遍」的意思是要最新的那份，
     * 不是要第二份。追加会让 AI 读到两份重复的摘录。
     */
    'memory.extract': async (body) => {
      const ws = await root(body)
      const got = await gatherMemoryPeople()
      if (got.found !== true) return { ok: false, error: '这台电脑上没找到记忆文件，也没找到项目档案。' }
      const all = got.people
      if (all.length === 0) return { ok: false, error: '记忆和项目档案里都没有认出具体的人。' }
      const keyOf = (p) => (p.name !== '' ? `${p.kin}:${p.name}` : p.kin)
      const wanted = Array.isArray(body?.people) && body.people.length > 0
        ? all.filter((p) => body.people.includes(keyOf(p)))
        : all
      if (wanted.length === 0) return { ok: false, error: '勾选的人一个都没对上。' }
      const at = store.localDate()
      const files = []
      for (const p of wanted) {
        const label = p.name !== '' ? p.name : p.kin
        const md = memory.renderPersonMaterial(p, { read_at: at })
        const saved = await store.appendMaterial(ws, `记忆-${label}`, md, { replace: true })
        if (saved.ok !== true) return saved
        files.push({
          key: keyOf(p),
          // 给「让 AI 读这个人」用：分析接口收的 about 就是个字符串，
          // 所以这个人还没有卡也能直接分析。
          id: core.safeId(label),
          name: p.name,
          kin: p.kin,
          label,
          path: saved.path,
          missing: p.missing,
        })
      }
      await store.rememberMemoryPeople(ws, wanted)
      return {
        ok: true,
        files,
        count: files.length,
        incomplete: wanted.filter((p) => p.missing.length > 0).length,
      }
    },

    /**
     * 把选中的人写成一份材料。
     *
     * body.people 是 user 在界面上勾的那些人的 key（`父亲:张三` 这种），
     * 不给就全要。写完之后返回材料文件名，好让界面接着走「分析」。
     */
    'memory.import': async (body) => {
      const ws = await root(body)
      const got = await gatherMemoryPeople()
      if (got.found !== true) return { ok: false, error: '这台电脑上没找到记忆文件，也没找到项目档案，没什么可导入的。' }
      const all = got.people
      if (all.length === 0) return { ok: false, error: '记忆和项目档案里都没有认出具体的人。' }
      const wanted = Array.isArray(body?.people) && body.people.length > 0
        ? all.filter((p) => body.people.includes(p.name !== '' ? `${p.kin}:${p.name}` : p.kin))
        : all
      if (wanted.length === 0) return { ok: false, error: '勾选的人一个都没对上。' }
      const md = memory.renderMemoryMaterial(wanted, { read_at: store.localDate() })
      const saved = await store.appendMaterial(ws, `记忆里认出来的人`, md)
      if (saved.ok !== true) return saved
      // 记下「这些人还缺什么」。等他们变成卡之后，卡上那个红色感叹号
      // 就是读的这份记录——不写进卡文件，因为那是你的待办，不是他的事实。
      await store.rememberMemoryPeople(ws, wanted)
      return {
        ok: true,
        file: saved.path,
        count: wanted.length,
        // 界面要拿这个数字决定提不提醒「这几条还不全」
        incomplete: wanted.filter((p) => p.missing.length > 0).length,
      }
    },

    /**
     * 打开某张卡的时候，告诉界面「这张卡是从记忆里来的、还缺什么」。
     *
     * 用户要求的那个「红色感叹号气泡」就是靠这个点亮：
     * 卡上有 memory_source 标记 + 有 missing 清单 → 亮红点。
     */
    'card.memoryStatus': async (body) => {
      const ws = await root(body)
      const rel = String(body?.path ?? '')
      if (rel === '') return { ok: false, error: '没给出要看哪张卡。' }
      const card = await store.readCard(ws, rel)
      if (card.ok !== true) return card
      const status = await store.memoryStatusOf(ws, card.data ?? {})
      return {
        ok: true,
        from_memory: status.from_memory,
        missing: status.missing,
        // 只有「从记忆来的、且缺东西」才该红。自己手写的卡缺东西，
        // 体检页会说，不必在这里再红一次——那会让人以为哪里坏了。
        flag: status.flag,
      }
    },

    'analyze.run': async (body) => {
      const ws = await root(body)
      const aboutId = String(body?.about ?? '')
      if (aboutId === '') return { ok: false, error: '没指定要分析谁' }
      const materials = await store.readMaterials(ws)
      const names = Object.keys(materials)
      if (names.length === 0) return { ok: false, error: '还没有材料。先加一段文字，或者做一次访谈，AI 才有东西可读。' }
      // 三种意思必须分得开：不传 / null = 全读；给数组 = 只读这些；空数组 = 一份都不读。
      // 以前空数组也被当成「全读」，用户明明一份都没勾，AI 却把整个材料库读了一遍。
      const want = body?.materials
      let chosen = materials
      if (Array.isArray(want)) {
        if (want.length === 0) {
          return { ok: false, error: '这次没选任何材料。至少要选一份，或者把要读的材料挑出来。' }
        }
        const picked = {}
        const missing = []
        for (const one of want) {
          const key = String(one ?? '').trim()
          if (key === '') {
            missing.push('（空的一条）')
            continue
          }
          if (Object.hasOwn(materials, key)) {
            picked[key] = materials[key]
            continue
          }
          // 界面上有时只传文件名，或者多带了一层目录；能唯一对上一份就认。
          const base = path.posix.basename(key)
          const same = Object.keys(materials).filter((k) => k.endsWith('/' + key) || path.posix.basename(k) === base)
          if (same.length === 1) {
            picked[same[0]] = materials[same[0]]
            continue
          }
          missing.push(key)
        }
        if (missing.length > 0) {
          return { ok: false, error: `这几份材料找不到了：${missing.join('、')}。可能刚被删掉或者改了名，刷新一下再挑一次。` }
        }
        chosen = picked
      } else if (want !== undefined && want !== null) {
        return { ok: false, error: '没看懂要读哪几份材料。要么不传（全都读），要么给一份材料清单。' }
      }
      if (Object.keys(chosen).length === 0) return { ok: false, error: '选中的材料都不存在' }
      const aboutName = String(body?.name ?? aboutId)
      // 「想要什么样的人」可以临时覆盖工作区里存的那份（比如试一下别的口味）。
      // 传 null 表示这次不带。不传就用存着的那份。
      const stored = await store.readConcept(ws)
      const concept = body?.concept === null ? null : (body?.concept !== undefined ? body.concept : stored)
      const prompt = prompts.buildAnalyzePrompt({
        aboutId,
        aboutName,
        materials: chosen,
        schemaHint: prompts.SCHEMA_HINT,
        concept,
      })
      const model = typeof body?.model === 'string' && body.model !== '' ? body.model : (config?.defaultAnalysisModel ?? undefined)
      const system = '你是一个只做抽取、不做推断的资料整理器。你的输出会被程序做逐字引文校验，编造的内容会被丢弃。'
      // 重试两次：模型偶尔会先写一段解释、把 JSON 截断、或返回空。
      // 这不是「假装成功」——每一次都真的重新请求，三次都不行才报错并带上原始输出。
      const attempts = Number(body?.attempts ?? 3)
      const tried = []
      let called = null
      let proposal
      for (let n = 0; n < Math.max(1, Math.min(5, attempts)); n += 1) {
        const user = n === 0 ? prompt : `${prompt}\n\n（上一次的输出无法解析成 JSON。请**只输出 JSON**，不要任何解释文字，不要 markdown 代码块。）`
        called = await callModel(ctx, { system, user, model })
        if (!called.ok) {
          tried.push({ attempt: n + 1, kind: 'model-error', error: called.error })
          continue
        }
        proposal = extractJson(called.text)
        if (proposal !== undefined) break
        tried.push({ attempt: n + 1, kind: 'unparsable', head: String(called.text ?? '').slice(0, 200), length: String(called.text ?? '').length })
      }
      if (called === null || !called.ok) {
        return { ok: false, error: called?.error ?? '调用模型失败', attempts: tried, hint: '也可以不用 AI：直接在编辑器里手写这张卡。' }
      }
      if (proposal === undefined) {
        return {
          ok: false,
          error: `AI 这次没给出能用的结果（试了 ${tried.length} 次）`,
          attempts: tried,
          raw: String(called.text ?? '').slice(0, 2000),
          hint: '可以把材料拆短一点再试一次。',
        }
      }
      // 补上 about 的身份信息再存：这个人可能还没有卡（「贴一段文字让它
      // 整理成一张卡」就是这种情况），采纳时要靠它现建一张，名字和身份不能丢。
      const kindWant = String(body?.kind ?? '').trim()
      const enriched = {
        ...proposal,
        about: {
          ...(proposal?.about !== null && typeof proposal?.about === 'object' ? proposal.about : {}),
          id: aboutId,
          name: String(proposal?.about?.name ?? aboutName).trim() || aboutName,
          ...(kindWant === 'fictional' ? { kind: 'fictional' } : {}),
        },
      }
      const saved = await store.saveProposal(ws, aboutId, enriched, chosen)
      return {
        ok: true,
        ...saved,
        model: called.model,
        materialsUsed: Object.keys(chosen),
        raw: String(called.text ?? '').length,
        attempts: tried.length + 1,
        retried: tried,
      }
    },

    /** 提案列表。 */
    'proposal.list': async (body) => {
      const ws = await root(body)
      const list = await store.listProposals(ws)
      return { ok: true, proposals: list }
    },

    /** 读一份提案（含勾选状态）。 */
    'proposal.get': async (body) => {
      const ws = await root(body)
      const safe = await insideWorkspace(ws, body?.json)
      if (safe.ok !== true) return { ok: false, error: safe.error }
      const rel = safe.rel
      if (!rel.endsWith('.json')) return { ok: false, error: '这个位置不是一份建议。' }
      const read = await store.readProposal(ws, rel)
      if (!read.ok) return read
      return { ok: true, json: rel, md: read.mdRel, about: read.record?.about?.id, items: read.items, checked: read.checkedCount, rejected: read.record?.rejected ?? [] }
    },

    /** 采纳勾选。 */
    'proposal.apply': async (body) => {
      const ws = await root(body)
      const safe = await insideWorkspace(ws, body?.json)
      if (safe.ok !== true) return { ok: false, error: safe.error }
      const rel = safe.rel
      if (!rel.endsWith('.json') || rel.endsWith('.checked.json')) return { ok: false, error: '这个位置不是一份建议。' }
      // 界面传 checked（下标数组）时以它为准，先落盘再采纳——
      // 否则界面上勾的东西只活在内存里，读回 MD 会当成一条都没勾。
      const checked = Array.isArray(body?.checked) ? body.checked : undefined
      return await store.applyProposal(ws, rel, checked === undefined ? {} : { checked })
    },

    /** 只记勾选，不采纳。界面每点一下都能立刻落盘。 */
    'proposal.check': async (body) => {
      const ws = await root(body)
      const safe = await insideWorkspace(ws, body?.json)
      if (safe.ok !== true) return { ok: false, error: safe.error }
      const rel = safe.rel
      if (!rel.endsWith('.json') || rel.endsWith('.checked.json')) return { ok: false, error: '这个位置不是一份建议。' }
      if (!Array.isArray(body?.checked)) return { ok: false, error: '没有收到你勾选的条目。' }
      const written = await store.writeCheckedFile(ws, rel, body.checked)
      return { ok: true, checked: written.checked }
    },

    /**
     * 「这份建议我不要了」。
     *
     * 不删文件：那条记录本身有价值，用户过几天想回头看 AI 当时说了什么，
     * 还能点进来。只把它从首页待办里摘掉——留着的话待办永远清不空，
     * 用户每次回首页都以为自己还有事没做。
     */
    'proposal.dismiss': async (body) => {
      const ws = await root(body)
      const safe = await insideWorkspace(ws, body?.json)
      if (safe.ok !== true) return { ok: false, error: safe.error }
      const rel = safe.rel
      if (!rel.endsWith('.json') || rel.endsWith('.checked.json') || rel.endsWith('.applied.json')) {
        return { ok: false, error: '这个位置不是一份建议。' }
      }
      const written = await store.writeDismissed(ws, rel, true)
      return { ok: true, dismissed: written.dismissed === true }
    },

    /** doctor：数据体检 + 把宿主能力写进 diagnostics.json。 */
    'doctor.run': async (body) => {
      const ws = await root(body)
      const summary = await store.doctor(ws)
      // 宿主段：只有宿主侧才知道的能力，如实写下来
      const host = {
        ran: true,
        at: new Date().toISOString(),
        // 这里以前写 `ctx.get('version')`——宿主没有这个服务，所以永远是 undefined，
        // 等于在诊断文件里留了一个「看起来会填、其实永远空」的字段。
        // 与其留个假字段，不如只写真的能拿到的：插件自己的版本在 package.json 里，界面不需要它。
        services: {
          llm: ctx.get?.('llm') !== undefined && ctx.get?.('llm') !== null,
          webServer: true,
          sessions: ctx.get?.('sessions') !== undefined,
        },
      }
      await fs.mkdir(path.join(ws, '.lifecard'), { recursive: true }).catch(() => {})
      await fs.writeFile(path.join(ws, '.lifecard/diagnostics.json'), JSON.stringify(host, null, 2) + '\n', 'utf8').catch(() => {})
      // 离线打分：纯本地算，不调模型。算不出来不能把整个体检搞挂。
      let scored = null
      try {
        const all = await store.listAll(ws)
        scored = { cards: all.cards.map((c) => ({ id: c.id, name: c.name, path: c.path, score: score.scoreCard(c) })) }
      } catch {
        scored = null
      }
      return { ok: true, ...summary, host, score: scored }
    },

    /** 问题库（访谈用）。 */
    'interview.questions': async (body) => {
      const relationId = String(body?.relation ?? 'parent')
      // kind 一定要带下去：虚构角色（写小说、酒馆）跟现实里的人不是一套题。
      // 以前这里只认 relation，界面在「立一个虚构角色」那一屏点「会问些什么」，
      // 拿到的是「你妈/你爸最像哪一种」，用户当场就不信这一屏是给他准备的。
      const kind = String(body?.kind ?? 'real')
      const { questions, exact } = prompts.questionsFor(relationId, kind)
      return { ok: true, relation: relationId, kind, exact, questions }
    },

    /** 访谈：开始 / 算下一题（按覆盖度跳过已回答的）。 */
    'interview.plan': async (body) => {
      const ws = await root(body)
      const aboutId = String(body?.about ?? '')
      const relationId = String(body?.relation ?? 'parent')
      // 虚构角色（写小说、酒馆）不用「他是我的什么人」那一套题：
      // 那一问对虚构的人是空的，逼着人选一个只会让后面的答案全跑偏。
      const kind = String(body?.kind ?? 'real')
      const { questions } = prompts.questionsFor(relationId, kind)
      let answered = []
      let ledgerBad = 0
      let data = {}
      let sections = []
      const rel = aboutId === '' ? null : await store.findCardByRelOrId(ws, aboutId).catch(() => null)
      if (rel !== null) {
        const card = await store.readCard(ws, rel)
        if (card.ok) {
          data = card.data
          sections = card.sections
          const ledger = await collectAnswered(ws, aboutId).catch(() => ({ answered: [], bad: 0 }))
          answered = ledger.answered
          ledgerBad = ledger.bad
        }
      }
      // 台账里一行有三种来路：答了（answered）、跳过（skipped）、不想说
      // （skipped + reason=sealed）。以前一律按「问过了」砍掉，于是「跳过」
      // 和「不想说」变成同义词——跳过的那题永远不再问，而它对应的字段也
      // 永远填不上，完成页却还一直报「还空着：…」。
      const answeredIds = new Set(answered.filter((a) => a.status === 'answered').map((a) => a.q))
      const sealedIds = new Set(answered.filter((a) => a.reason === 'sealed' || a.status === 'sealed').map((a) => a.q))
      // 同一题跳过两次就别再问了——用户显然是想不起来。只跳过一次的排到队尾
      // 还会再问一次；没有这条，「跳过」要么等于永别，要么变成同一题反复出现。
      const skipCount = new Map()
      for (const a of answered) {
        if (a.status !== 'skipped') continue
        skipCount.set(a.q, (skipCount.get(a.q) ?? 0) + 1)
      }
      const giveUp = new Set([...skipCount].filter(([, n]) => n >= 2).map(([q]) => q))
      const cov = core.coverage(data, sections, { kind: data?.kind })
      const filled = new Set(cov.filled.map((f) => f.key))
      const todo = questions.filter((q) => {
        if (answeredIds.has(q.id) || sealedIds.has(q.id) || giveUp.has(q.id)) return false
        // fills 里还有空字段才问
        return q.fills.some((f) => !filled.has(f))
      })
      // 跳过的排到队尾：先把没问过的问完，别一上来就再问同一题。
      const deferred = answered
        .filter((a) => a.status === 'deferred' || (a.status === 'skipped' && a.reason !== 'sealed'))
        .map((a) => a.q)
      const ordered = [
        ...todo.filter((q) => !deferred.includes(q.id)),
        ...todo.filter((q) => deferred.includes(q.id)),
      ]
      // limit 来自界面，可能是任何东西：NaN 会让 slice 返回空数组（界面上一题都不出），
      // 负数会从尾部砍掉。这里只是个「一次问几题」的旋钮，夹到 1..20 就够。
      const asked = Number(body?.limit ?? 3)
      const limit = Number.isFinite(asked) && asked >= 1 ? Math.min(20, Math.floor(asked)) : 3
      return {
        ok: true,
        about: aboutId,
        relation: relationId,
        coverage: cov.percent,
        empty: cov.empty.map((e) => e.label),
        next: ordered.slice(0, limit),
        remaining: ordered.length,
        askedAlready: new Set(answered.map((a) => a.q)).size,
        sealed: [...sealedIds],
        // 账本里坏掉几行。界面拿它提示一句「有 N 条记录没读进来」，
        // 不然用户只会觉得「我明明答过，怎么又问一遍」。
        skipped: ledgerBad,
      }
    },

    /** 访谈：记一条回答（写 materials/ 与 interviews/）。 */
    'interview.record': async (body) => {
      const ws = await root(body)
      const aboutId = String(body?.about ?? '')
      const questionId = String(body?.q ?? '')
      const answer = String(body?.answer ?? '')
      const status = String(body?.status ?? 'answered')
      if (aboutId === '' || questionId === '') return { ok: false, error: '这一条访谈记录不完整，跳过就好。' }
      // 和 store.js 一致用本地日期：toISOString 是 UTC，东八区早上八点前
      // 记的东西会被落成前一天，跟 materials/ 里别的文件名对不上。
      const date = store.localDate()
      const materialName = `${date}-${core.safeId(aboutId)}访谈`
      let saved = null
      if (status === 'answered' && answer.trim() !== '') {
        // 标题用**问题本身**，不只用题号。以前标题是 `## real.q03`，回头
        // 「整理进卡里」时模型看到的是一串题号加裸答案，不知道这句话在回答什么，
        // 只能瞎猜字段——于是把答案硬塞进不相干的格子里。
        const askText = String(body?.ask ?? '').trim()
        const options = Array.isArray(body?.options) ? body.options.filter((x) => String(x ?? '').trim() !== '') : []
        const block = [
          `## ${askText === '' ? questionId : askText}`,
          '',
          `问过的题号：${questionId}`,
          ...(options.length === 0 ? [] : ['', `当时给的几个方向：${options.map((x) => String(x).trim()).join(' / ')}`]),
          '',
          answer.trim(),
          '',
          '```',
          `q: ${questionId}`,
          `asked_at: ${new Date().toISOString()}`,
          '```',
          '',
        ].join('\n')
        saved = await store.appendMaterial(ws, materialName, block)
      }
      // 账本
      const ledgerRel = path.posix.join('interviews', `${date}-${core.safeId(aboutId)}.jsonl`)
      const abs = path.join(ws, ledgerRel)
      await fs.mkdir(path.dirname(abs), { recursive: true })
      const record = {
        q: questionId,
        asked_at: new Date().toISOString(),
        asked_in: 'dsh-lifecard',
        status,
        ...(status === 'skipped' && typeof body?.reason === 'string' ? { reason: body.reason } : {}),
        ...(Array.isArray(body?.fills) ? { fills: body.fills } : {}),
        ...(saved !== null ? { material_anchor: saved.path } : {}),
      }
      await fs.appendFile(abs, JSON.stringify(record) + '\n', 'utf8')
      return { ok: true, material: saved?.path ?? null, ledger: ledgerRel, record }
    },

    /** 访谈：已有回答（续接用）。 */
    'interview.history': async (body) => {
      const ws = await root(body)
      const aboutId = String(body?.about ?? '')
      const ledger = await collectAnswered(ws, aboutId)
      // skipped 是「账本里有几行没读进来」：不带出去的话，用户看到
      // 「答过的题又问一遍」完全没有线索。
      return { ok: true, about: aboutId, answered: ledger.answered, skipped: ledger.bad }
    },

    // ── 酒馆（角色扮演）──────────────────────────────────────────

    /** 酒馆：说过的这几场。 */
    'tavern.list': async (body) => {
      if ((await ensureModules()).tavern !== true) return missingFeature('tavern')
      const ws = await root(body)
      return await tavern.listChats(ws)
    },

    /**
     * 酒馆：挑一个人，开一场。
     *
     * 开场白直接当第一条说出来——用户点了「开始」就该看到 TA 开口，
     * 而不是对着一个空框想「我该说什么」。
     */
    'tavern.start': async (body) => {
      if ((await ensureModules()).tavern !== true) return missingFeature('tavern')
      const ws = await root(body)
      const want = String(body?.card ?? '').trim()
      if (want === '') return { ok: false, error: '得先挑一个人，才能开始。' }
      const rel = want.endsWith('.card.md') ? want : await store.findCardByRelOrId(ws, want)
      if (rel === null) return { ok: false, error: '找不到这张卡。它可能被删掉了，或者不在这个文件夹里。' }
      const card = await store.readCard(ws, rel)
      if (card.ok !== true) {
        // 「文件不存在」是内部说法。用户点的是一个名字，他看到的也该是人的话。
        const reason = String(card.error ?? '')
        const missing = reason.includes('不存在') || reason.includes('没有这个')
        return {
          ok: false,
          error: missing ? '找不到这张卡。它可能被删掉了，或者不在这个文件夹里。' : `这张卡读不出来：${reason}`,
        }
      }
      const persona = tavern.personaFromCard(card.data, card.sections, { user: userNameSync(ws) })
      const cardName = persona.name !== '' ? persona.name : String(card.data?.name ?? '').trim()
      const world = await resolveTavernWorld(ws, String(body?.world ?? ''), String(card.data?.world ?? ''))
      if (world.ok !== true) return world
      // 落盘前先问一句「这个名字有主了吗」——同一分钟里开第二场，
      // writeChat 是整文件覆盖，撞上就是把上一场吃掉，一步都不报错。
      const id = await tavern.uniqueChatId(ws)
      const turns = []
      const greeting = tavern.greetingOf(card.sections)
      if (greeting !== '') turns.push({ who: cardName === '' ? 'TA' : cardName, text: greeting })
      const now = tavernStamp()
      const data = {
        id,
        card: rel,
        card_name: cardName,
        world: world.rel,
        world_name: world.name,
        created_at: now,
        updated_at: now,
        turns: turns.length,
      }
      const saved = await tavern.writeChat(ws, id, data, turns)
      if (saved.ok !== true) return saved
      return { ok: true, id, path: saved.path, card: rel, card_name: cardName, world: world.rel, world_name: world.name, turns }
    },

    /** 酒馆：读这一场。 */
    'tavern.get': async (body) => {
      if ((await ensureModules()).tavern !== true) return missingFeature('tavern')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '这一场找不到了' }
      const got = await tavern.readChat(ws, id)
      if (got.ok !== true) return got
      return {
        ok: true,
        id,
        card: String(got.data?.card ?? ''),
        card_name: String(got.data?.card_name ?? ''),
        world: String(got.data?.world ?? ''),
        world_name: String(got.data?.world_name ?? ''),
        created_at: String(got.data?.created_at ?? ''),
        updated_at: String(got.data?.updated_at ?? ''),
        turns: got.turns ?? [],
        notes: got.notes ?? [],
      }
    },

    /**
     * 酒馆：我说一句，TA 说一句。
     *
     * 空正文 = 「让 TA 先说」（历史里已经有开场白时就是「让 TA 接着往下」）。
     * 模型不回话时，用户刚打的那句**必须已经存下来**——不然他打完一段，
     * 断网一次就全没了。
     */
    /**
     * 换一张卡接着说。
     *
     * 为什么要有：说下去才发现挑错了人——卡上写的是另一个人，或者当初根本没挑卡。
     * 以前只有「另开一场」这一条路，前面聊的全丢。
     *
     * 三件事要一起做：
     *   ① 换 `data.card` / `data.card_name`（后面每一轮都按新卡拼提示词）；
     *   ② 保留已经说过的那些轮次（用户要的是「接着聊」，不是重来）；
     *   ③ 原来的开场白如果还在最前面、而新卡也有开场白，就把它换掉——
     *      不然屏幕上第一句还是上一个人的话，看着像串了。
     */
    'tavern.setCard': async (body) => {
      if ((await ensureModules()).tavern !== true) return missingFeature('tavern')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '这一场找不到了' }
      const want = String(body?.card ?? '').trim()
      if (want === '') return { ok: false, error: '没说是哪一张卡' }
      const rel = want.endsWith('.card.md') ? want : await store.findCardByRelOrId(ws, want)
      if (rel === null) return { ok: false, error: '找不到这张卡。它可能被删掉了，或者不在这个文件夹里。' }
      const card = await store.readCard(ws, rel)
      if (card.ok !== true) return { ok: false, error: `这张卡读不出来：${card.error ?? '文件坏了'}` }
      return oneAtATime(id, async () => {
        const got = await tavern.readChat(ws, id)
        if (got.ok !== true) return got
        const turns = Array.isArray(got.turns) ? got.turns.slice() : []
        const persona = tavern.personaFromCard(card.data, card.sections, { user: userNameSync(ws) })
        const cardName = persona.name !== '' ? persona.name : String(card.data?.name ?? '').trim()
        const greeting = tavern.greetingOf(card.sections)
        // 只有「一句话都还没说」或者「第一句就是开场白」时才替换第一句。
        // 已经聊过好几轮再插一句开场白，等于把剧情倒回去。
        const oldName = String(got.data?.card_name ?? '').trim()
        const head = turns[0]
        const headIsGreeting = head !== undefined && head.who !== '我' && (turns.length === 1 || head.who === oldName)
        if (greeting !== '' && (turns.length === 0 || (headIsGreeting && String(head.who) === oldName))) {
          if (turns.length === 0) turns.push({ who: cardName === '' ? 'TA' : cardName, text: greeting })
          else turns[0] = { who: cardName === '' ? 'TA' : cardName, text: greeting }
        }
        const saved = await tavern.writeChat(ws, id, {
          ...got.data, notes: got.notes, card: rel, card_name: cardName, updated_at: tavernStamp(), turns: turns.length,
        }, turns)
        if (saved.ok !== true) return saved
        return {
          ok: true,
          id,
          card: rel,
          card_name: cardName,
          turns,
          // 换了卡、之前那个人说的话还留着：这些轮次现在读起来像「新卡在替旧卡说话」。
          // 界面得有能力把这件事说出来，不然用户会以为换卡把记忆搞乱了。
          kept: turns.length,
          personaChars: persona.text.length,
        }
      })
    },

    /**
     * 让用户看看：这一场下一句，模型到底会读到什么。
     *
     * 什么都不发送、什么都不改。就是**把要发的那段话原样交出来**，
     * 加上拆开的字数。
     *
     * 为什么需要：用户报的问题从来是「它不像」「它退出来了」，而这两句话
     * 翻不成任何可执行的调试动作——除非能看见真正进去的那段字。
     * 以前这件事只能开终端解会话日志（多帧 zstd、翻 system/message）。
     *
     * 走的是和 `tavern.say` 完全同一条路（`buildTavernPrompt`），所以这里
     * 看到的字就是真正发出去的字，不是另拼一份近似的。
     */
    'tavern.prompt': async (body) => {
      if ((await ensureModules()).tavern !== true) return missingFeature('tavern')
      if ((await ensureModules()).presets !== true) return missingFeature('presets')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '这一场找不到了' }
      const got = await tavern.readChat(ws, id)
      if (got.ok !== true) return got
      const turns = Array.isArray(got.turns) ? got.turns.slice() : []
      const said = String(body?.text ?? '').trim()
      if (said !== '') turns.push({ who: '我', text: said })
      const built = await buildTavernPrompt(ws, got, turns, body?.preset)
      return {
        ok: true,
        id,
        cardName: built.cardName,
        hasCard: built.persona.text !== '',
        promptStyle: built.persona.promptStyle === true,
        // 卡被上限砍了的活，得在这里说一句——不然用户只会觉得「它不像」，
        // 永远查不到真正的原因是 93% 的字根本没进去。
        truncated: built.persona.truncated === true,
        cap: built.persona.cap,
        parts: built.parts,
        system: built.system,
        user: built.user,
      }
    },

    'tavern.say': async (body, io) => {
      if ((await ensureModules()).tavern !== true) return missingFeature('tavern')
      if ((await ensureModules()).presets !== true) return missingFeature('presets')
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '这一场找不到了' }
      // 同一场会话一次只处理一句：读-改-写之间夹着一次模型调用，
      // 不串起来的话双击发送会丢一轮。
      return oneAtATime(id, async () => {
        const ws = await root(body)
        const id = String(body?.id ?? '').trim()
        if (id === '') return { ok: false, error: '这一场找不到了' }
        const got = await tavern.readChat(ws, id)
        if (got.ok !== true) return got
        const turns = Array.isArray(got.turns) ? got.turns.slice() : []
        const said = String(body?.text ?? '').trim()
        if (said !== '') turns.push({ who: '我', text: said })
        if (turns.length > tavern.MAX_TURNS) {
          // 太长了不收——但用户刚打的那句得先落盘。以前这里只把 turns 塞进
          // 响应让界面照常显示，一刷新就没了，用户会以为见鬼了。
          if (said !== '') {
            await tavern.writeChat(ws, id, { ...got.data, notes: got.notes, turns: turns.length, updated_at: tavernStamp() }, turns)
          }
          return {
            ok: false,
            error: `这一场已经说了 ${turns.length} 句，太长了记不住前面。换个标题另开一场，接着往下聊。`,
            turns,
          }
        }
        const built = await buildTavernPrompt(ws, got, turns, body?.preset)
        const cardName = built.cardName
        const system = built.system
        const user = built.user
        // io 只有走流式那条口子时才有；普通一问一答时它是 undefined。
        const called = await callModel(ctx, { system, user, model: body?.model }, { onDelta: io?.onDelta })
        const now = tavernStamp()
        if (called.ok !== true) {
          // 我那句先存下来：TA 没回话，不代表我说的话可以丢
          const kept = await tavern.writeChat(ws, id, { ...got.data, notes: got.notes, turns: turns.length, updated_at: now }, turns)
          return {
            ok: false,
            error: `TA 没接上话：${called.error ?? '过一会儿再试一次'}`,
            kept: kept.ok === true,
            turns,
          }
        }
        const raw = tavernCleanReply(called.text, cardName)
        // 选项块得从正文里剪掉再落盘：它是给这一轮界面上的按钮用的，
        // 不是这个人说过的话。留在会话文件里，下一轮就会被当历史读回去，
        // 模型于是开始学着自己给自己列选项，正文越写越像菜单。
        //
        // 顺序有讲究：先 `tavernCleanReply`（削「张三：」前缀、去外层引号），
        // 再 parseChoices。反过来的话，选项块被引号包着时前面那步会先失败。
        //
        // 只认「模型自己写了【选】」的那一种（`tagged`），不认「末尾刚好是
        // 两行短列表」。后者在这个场景里会把真话说掉：TA 答一句「- 雨还没停，
        // 站着吧。」「- 伞我不要。」，本来就该留在正文里当台词，按末尾短列表
        // 剪掉就整段没了，用户看到 TA 一个字都没说。提示词里已经明说要写【选】，
        // 所以带标记才是真要给方向的信号。
        const parted = choices !== null ? choices.parseChoices(raw) : { body: raw, choices: [], tagged: false }
        // 没标记就整份都当正文，连「末尾像选项的那几行」也不当按钮：
        // 正文里已经留着那几行了，再在下面摆一排同样的按钮，用户会以为
        // TA 一次说了两遍。
        const reply = parted.tagged === true ? parted.body : raw
        const offered = parted.tagged === true ? parted.choices : []
        if (reply !== '') turns.push({ who: cardName === '' ? 'TA' : cardName, text: reply })
        const saved = await tavern.writeChat(ws, id, { ...got.data, notes: got.notes, card_name: cardName, turns: turns.length, updated_at: now }, turns)
        if (saved.ok !== true) {
          return { ok: false, error: `TA 回了，但这一场没存下来：${saved.error}`, reply, turns, choices: offered }
        }
        return { ok: true, id, reply, turns, choices: offered, used: { card: built.persona.text !== '', world: built.worldCount } }
    
      })
    },

    /**
     * 酒馆：重来一次。
     *
     * 只做前半截——把最后那句「TA 说的」摘掉，「我说的」留着。
     * 真正的重生成交给 tavern.say（正文留空就是「让 TA 接着说」），
     * 一条路走通，不另写一套生成逻辑。
     */
    'tavern.regenerate': async (body) => {
      if ((await ensureModules()).tavern !== true) return missingFeature('tavern')
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '这一场找不到了' }
      return oneAtATime(id, async () => {
        const ws = await root(body)
        const got = await tavern.readChat(ws, id)
        if (got.ok !== true) return got
        const before = Array.isArray(got.turns) ? got.turns : []
        const turns = tavern.dropTrailingReply(before)
        if (turns.length === before.length) return { ok: true, id, turns, unchanged: true }
        const saved = await tavern.writeChat(ws, id, { ...got.data, notes: got.notes, turns: turns.length, updated_at: tavernStamp() }, turns)
        if (saved.ok !== true) return { ok: false, error: `没能回到上一句：${saved.error}`, turns: before }
        return { ok: true, id, turns }
      })
    },

    /**
     * 酒馆：从这一场掰出一条新的世界线。
     *
     * 演到一半不满意，不必把这一场删掉重来：从某一句掰出去，原会话一个字节都不动。
     */
    'tavern.branch': async (body) => {
      if ((await ensureModules()).tavern !== true) return missingFeature('tavern')
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '这一场找不到了' }
      const ws = await root(body)
      // 掰世界线也是「读这一场 → 另存一场」，和 say / regenerate 一样必须排队：
      // 一边等 TA 回话一边掰，写进去的那份是回话之前的半截。
      return oneAtATime(id, async () => tavern.branchChat(ws, id, { at: body?.at }))
    },

    /**
     * 酒馆：把前面那些收一收。
     *
     * 说得久了历史只能带最近二十来轮，再往前就丢了。这不是"记忆库"，
     * 只是在会话文件里补一段「到这儿为止」，之后每轮都带上，
     * 让它别把之前发生过的事记错。
     */
    'tavern.summarize': async (body) => {
      if ((await ensureModules()).tavern !== true) return missingFeature('tavern')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '这一场找不到了' }
      // 收尾也是一次「读 → 调模型（十几二十秒）→ 整文件写回」，跟 tavern.say 同一个形状。
      // 不收进来排队的话，这段时间里说的任何一句都会被回写成收尾前那一版 —— 而且不留痕迹。
      return oneAtATime(id, async () => {
      const got = await tavern.readChat(ws, id)
      if (got.ok !== true) return got
      const turns = Array.isArray(got.turns) ? got.turns.slice() : []
      if (turns.length < tavern.MIN_TURNS_TO_SUMMARIZE) {
        return { ok: false, error: `才说了 ${turns.length} 句，先不急着收；说满 ${tavern.MIN_TURNS_TO_SUMMARIZE} 句再收才划算。`, turns }
      }
      const cardName = String(got.data?.card_name ?? '').trim()
      const prompt = tavern.buildSummaryPrompt({ cardName, turns })
      const called = await callModel(ctx, { system: prompt.system, user: prompt.user, model: body?.model })
      if (called.ok !== true) return { ok: false, error: `收尾没收成：${called.error ?? '过一会儿再试一次'}`, turns }
      const summary = String(called.text ?? '').trim()
      if (summary === '') return { ok: false, error: 'TA 这次没说出个所以然，过一会儿再收一次。', turns }
      // 旧的那段换掉，不叠加：两段备忘放在一起，模型会挑着信其中一段。
      const notes = (Array.isArray(got.notes) ? got.notes : [])
        .filter((n) => String(n?.title ?? '').trim() !== tavern.MEMORY_TITLE)
      notes.push({ title: tavern.MEMORY_TITLE, body: summary })
      const saved = await tavern.writeChat(ws, id, { ...got.data, notes, turns: turns.length, updated_at: tavernStamp() }, turns)
      if (saved.ok !== true) return { ok: false, error: `收好了，但没存下来：${saved.error}`, summary, turns }
      return { ok: true, id, summary, notes, turns }
      })
    },

    /**
     * 把这一场里最能代表 TA 的几句，写进那张卡的「对话示例」。
     *
     * 「对话示例」是下次演 TA 时最管用的材料：比「性格：沉默寡言」具体得多，
     * 因为它就是那个人真的说过的话。演着演着发现 TA 说话的样子比卡上写的准，
     * 这里就能把它固化下来。
     */
    'tavern.toExample': async (body) => {
      if ((await ensureModules()).tavern !== true) return missingFeature('tavern')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '这一场找不到了' }
      return oneAtATime(id, async () => {
        const got = await tavern.readChat(ws, id)
        if (got.ok !== true) return got
        const turns = Array.isArray(got.turns) ? got.turns : []
        if (turns.filter((t) => String(t?.who ?? '').trim() !== '我').length === 0) {
          return { ok: false, error: 'TA 还没说过话，挑不出例句。' }
        }
        const cardName = String(got.data?.card_name ?? '').trim()
        const prompt = tavern.buildExamplePrompt({ cardName, turns })
        const called = await callModel(ctx, { system: prompt.system, user: prompt.user, model: body?.model })
        if (called.ok !== true) return { ok: false, error: `没挑出来：${called.error ?? '过一会儿再试一次'}` }
        const picked = tavern.cleanExamples(called.text)
        if (picked.length === 0) return { ok: false, error: '这一次没挑出能用的句子，过一会儿再试一次。' }

        const want = String(got.data?.card ?? '').trim()
        if (want === '') return { ok: false, error: '这一场不知道是跟哪张卡演的，存不回去。' }
        const card = await store.findCardByRelOrId(ws, want)
        if (card === null) return { ok: false, error: '那张卡找不到了，它可能被删掉了。' }
        const block = picked.map((line) => `- ${line}`).join('\n')
        // 这里必须用 updateCard（读-改-写整段上锁），不能自己 readCard 再 writeCard：
        // 挑例句要等一次模型调用（几秒到几十秒），这段时间里用户完全可能在另一个
        // 窗口把这张卡改了。等回来再拿刚才读到的旧内容整份写回去，那边刚写的东西
        // 就没了——而且快照里也看不出来，因为两次写前的底稿是同一份。
        const written = await store.updateCard(ws, card, (latest) => {
          const sections = Array.isArray(latest.sections) ? latest.sections.map((x) => ({ ...x })) : []
          const title = '对话示例'
          const at = sections.findIndex((x) => String(x.title ?? '').trim() === title)
          if (at === -1) sections.push({ title, body: block })
          else {
            const oldBody = String(sections[at].body ?? '').trim()
            const merged = oldBody === '' || oldBody === '_（还没写）_' ? block : `${oldBody}\n${block}`
            // 例句越攒越多会把这个小节撑爆，之后每演一句都把这些全塞进提示词。
            // 只留最后 24 行——它们是最靠近「现在这个人」的样子。
            const lines = merged.split(/\r?\n/).filter((x) => x.trim() !== '')
            sections[at] = { ...sections[at], body: lines.slice(-24).join('\n') }
          }
          return { ok: true, data: latest.data, sections }
        })
        if (written.ok !== true) return written
        return { ok: true, path: written.path, picked }
      })
    },

    /** 酒馆：这一场不要了。 */
        /**
     * 把酒馆里聊出来的一场，变成某本小说的一章。
     *
     * 这是「三扇门其实是一件事」的那一步：先在酒馆里把人立起来、把话演一遍，
     * 演得满意的那一场直接变成小说的正文，而不是再从头写一遍。
     */
    'tavern.toChapter': async (body) => {
      const ws = await root(body)
      const mods = await ensureModules()
      if (mods.tavern !== true) return missingFeature('tavern')
      if (mods.novel !== true) return missingFeature('novel')

      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '得先挑一场聊过的。' }
      const book = String(body?.book ?? '').trim()
      if (book === '') return { ok: false, error: '得先挑一本书。没有书的话，先回「写小说」那扇门建一本。' }

      const chat = await tavern.readChat(ws, id)
      if (chat.ok !== true) return chat
      const turns = chat.turns ?? []
      if (turns.length === 0) return { ok: false, error: '这一场还什么都没说。先在酒馆里聊几句，再变。' }

      const target = await novel.readBook(ws, book)
      if (target.ok !== true) return target
      if (target.book === null) return { ok: false, error: '找不到这本书。它可能被删了。' }

      const built = novel.buildChatToChapterPrompt({
        cardName: chat.data?.card_name ?? '',
        bookTitle: target.book?.title ?? '',
        turns,
        note: String(body?.note ?? ''),
      })
      const called = await callModel(ctx, { system: built.system, user: built.user, model: body?.model })
      if (called.ok !== true) return { ok: false, error: `这次没改出来：${called.error ?? '过一会儿再试一次'}` }

      const text = String(called.text ?? '').trim()
      if (text === '') return { ok: false, error: '它这次什么都没写出来，再试一次。' }

      // 章号接着最后一章往后排。用「最后一章的号 + 1」而不是「章数 + 1」：
      // 中间删过章的话（第 2 章被删），章数是 2、最后一章是第 3 章，
      // 用章数算出来的 3 会覆盖掉现成的第 3 章。
      const list = Array.isArray(target.chapters) ? target.chapters : []
      const last = list.length === 0 ? 0 : Number(list[list.length - 1]?.index ?? 0)
      const next = (Number.isFinite(last) ? last : 0) + 1
      const written = await novel.writeChapter(ws, book, next, text)
      if (written.ok !== true) return written
      return { ok: true, book, chapter: written.index ?? next, text, turns: turns.length }
    },

    'tavern.delete': async (body) => {
      if ((await ensureModules()).tavern !== true) return missingFeature('tavern')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '这一场找不到了' }
      // 删会话也得排队：一边等 TA 回话一边删，回话那一步会把刚删掉的那场
      // 又写回来（它读到的是删之前的内容），于是「删了但还在」。
      return oneAtATime(id, async () => await tavern.deleteChat(ws, id))
    },

    // ── 写小说：一本书、一章一章 ─────────────────────────────────

    /** 书架：所有书。 */
    'novel.books': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      const ws = await root(body)
      return await novel.listBooks(ws)
    },

    /** 新开一本。 */
    'novel.create': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      const ws = await root(body)
      return await novel.createBook(ws, {
        title: body?.title,
        genre: body?.genre,
        idea: body?.idea,
      })
    },

    /** 打开一本书（含章节清单）。 */
    'novel.get': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      return await novel.readBook(ws, id)
    },

    /** 改书的元信息（书名 / 题材 / 一句话）。 */
    'novel.update': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      return await novel.updateBook(ws, id, {
        title: body?.title,
        genre: body?.genre,
        idea: body?.idea,
      })
    },

    /** 这一章不要了。 */
    'novel.chapter.delete': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      const gone = await novel.deleteChapter(ws, id, body?.index)
      if (gone.ok !== true) return gone
      // 这一章没了，它上面那份剧本留着就是一份谁也点不到的孤儿——
      // 界面上只能按章翻，第 N 章都不存在了，那份剧本永远打不开也删不掉。
      const script = await novel.deleteScript(ws, id, body?.index)
      return script.ok === true ? gone : { ...gone, scriptKept: true }
    },

    /** 整本书不要了。 */
    'novel.delete': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      return await novel.deleteBook(ws, id)
    },

    // ── 写小说的三段：规划 → 写章 → 审稿 ──────────────────────

    /** 读大纲。 */
    'novel.outline.get': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      return await novel.readOutline(ws, id)
    },

    /** 自己写 / 改大纲（人也在这里改）。 */
    'novel.outline.save': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      return await novel.writeOutline(ws, id, String(body?.text ?? ''))
    },

    /**
     * 让 AI 先把整本书的骨架搭出来（第一段：规划）。
     *
     * 只写进 outline.md，不动正文：这一步是「先想清楚」，用户看完能改，
     * 改完再一章一章让它写。不落盘的话刷新一下就没了，白等一次模型。
     */
    'novel.outline.draft': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      if ((await ensureModules()).presets !== true) return missingFeature('presets')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      const book = await novel.readBook(ws, id)
      if (book.ok !== true) return book
      const worldNotes = []
      const worldRel = typeof body?.world === 'string' ? body.world.trim() : ''
      if (worldRel !== '') {
        const world = await store.readCard(ws, worldRel)
        if (world.ok === true) {
          for (const entry of core.parseWorldEntries(world.sections)) {
            const content = String(entry?.content ?? '').trim()
            if (content !== '') worldNotes.push(content)
          }
        }
      }
      const cast = await gatherCast(ws, body?.cast)
      const users = novel.buildOutlinePrompt({
        title: String(book.data?.title ?? id),
        genre: String(book.data?.genre ?? ''),
        idea: String(book.idea ?? ''),
        cast,
        worldEntries: worldNotes,
        chapters: Number(body?.chapters) || 12,
        ask: body?.ask,
      })
      const outlinePreset = await presets.resolve(ws, body?.preset)
      const outlineNote = outlinePreset.ok === true && outlinePreset.preset !== null ? String(outlinePreset.preset.prompt ?? '') : ''
      const called = await callModel(ctx, {
        system: [
          '你是一个会写长篇小说的人。你先想清楚整本书怎么走，再动手写。',
          outlineNote === '' ? '' : `\n【这本书怎么写】\n${outlineNote}`,
        ].filter((x) => x !== '').join('\n'),
        user: users,
        model: body?.model,
      })
      if (called.ok !== true) return { ok: false, error: `这次没想出来：${called.error ?? '过一会儿再试一次'}` }
      const text = String(called.text ?? '').trim()
      if (text === '') return { ok: false, error: 'AI 这次没给出东西，再点一次试试。' }
      const saved = await novel.writeOutline(ws, id, text)
      if (saved.ok !== true) return saved
      // 以前这里把 parseOutline 的结果展开在 ok:true 后面，而它自带一个
      // ok（=「扒到几章」是否大于 0）。AI 写得散、一行「第 N 章：」都没有时，
      // 文件其实已经写进去了，却返回 ok:false，界面报「这次没想出一个字」。
      const parsed = novel.parseOutline(text)
      return {
        ok: true,
        text,
        path: saved.path,
        theme: parsed.theme,
        ending: parsed.ending,
        chapters: parsed.chapters,
        ...(parsed.chapters.length > 0 ? {} : { warning: '这一版大纲里没认出「第 N 章：」这样的行，文件已经存下了，你可以自己补上章号。' }),
      }
    },

    /**
     * 整本导出成一整篇文字。
     *
     * 用户电脑上只有这个插件，不会去翻 books/ 底下那一堆 001.md。
     * 写完一本书要能一口气复制走，而不是一章一章点开来复制。
     */
    'novel.export': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      const got = await novel.readBook(ws, id)
      if (got.ok !== true) return got

      const lines = []
      const title = String(got.data?.title ?? id).trim()
      lines.push(`# ${title === '' ? '未命名' : title}`)
      lines.push('')
      if (String(got.idea ?? '').trim() !== '') {
        lines.push(`> ${String(got.idea).trim()}`)
        lines.push('')
      }
      let total = 0
      for (const chapter of got.chapters) {
        const one = await novel.readChapter(ws, id, chapter.index)
        if (one.ok !== true) continue
        lines.push(`## 第 ${chapter.index} 章`)
        lines.push('')
        lines.push(String(one.body ?? '').trim())
        lines.push('')
        total += 1
      }
      if (total === 0) return { ok: false, error: '这本书还一章都没有。先写一章，再导出。' }
      return { ok: true, title, chapters: total, text: lines.join('\n').trim() + '\n' }
    },

    /**
     * 审一章（第三段：审稿）。
     *
     * 只挑**具体能指出的问题**：哪里跳了、哪里人物不像、哪里在替读者总结。
     * 不要它夸——「写得很好」这种话对写东西的人毫无用处。
     */
    'novel.chapter.review': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      const index = Number(body?.index) || 0
      const got = await novel.readChapter(ws, id, index)
      if (got.ok !== true) return got
      const bodyText = String(got.body ?? '').trim()
      if (bodyText === '') return { ok: false, error: '这一章还是空的，没什么可审的。' }
      if (bodyText.length > 20000) {
        return { ok: false, error: '这一章太长（超过两万字），一次读不完。先分成两章再挑毛病。' }
      }

      // 盲审：只给正文，不给书名、不给大纲、不给「这一章本来想写什么」。
      //
      // 为什么不给：写的人心里有一套意图，看的时候会不自觉地按意图去读，
      // 于是「我本来想写这个」会替「我实际写出来的是什么」作证。
      // 换成一个什么都不知道的读者，才是这本书真正的处境。
      const user = [
        '下面是一段小说正文。你之前没看过这本书，也不知道作者想写什么。',
        '你就是一个第一次读到这里的读者。',
        '',
        '【正文】',
        bodyText,
        '',
        '【读完告诉我这些】',
        '1. 你读到哪儿卡住了（那句话说不上来、那段跳了、回头看了两遍才懂）',
        '2. 你读到哪儿不信（这个人不会这么做、这件事不会这么发生）',
        '3. 你读到哪儿想跳过（哪几段你在心里划过去了）',
        '4. 哪句话是空话，删掉不影响（直接引原句）',
        '5. 哪一句读着最像机器写的——太顺、太整齐、什么都说了却没具体的东西（直接引原句）',
        '',
        '【怎么答】',
        '- 每条一行，先写「哪里：」再写「为什么：」。要引原句。',
        '- 最多 8 条，按你读的时候的不舒服程度排。',
        '- 不夸。一句夸奖都不要。',
        '- 不给改写版本——你只是读者，不是代笔。',
        '- 没看出问题就直接说「没卡住的地方」，不要凑条数。',
      ].join('\n')
      const called = await callModel(ctx, {
        // 换了一张纸：这段系统提示只要求它当读者，不要求它当编辑，
        // 免得它从「怎么写更好」的角度出发，跑回写作者的位置上。
        system: [
          '你是一个普通读者，刚读完一段小说。',
          '你没有写过这段，也不知道作者是谁、想写什么。',
          '你只会说读的时候哪里不顺、哪里不信、哪里想跳过。',
          '你不会改稿，也不会替作者想句子。',
          body?.model === undefined || String(body.model).trim() === '' ? '' : '',
        ].filter((x) => x !== '').join('\n'),
        user,
        model: body?.model,
      })
      if (called.ok !== true) return { ok: false, error: `这次没审成：${called.error ?? '过一会儿再试一次'}` }
      const review = String(called.text ?? '').trim()
      if (review === '') return { ok: false, error: 'AI 这次没给出意见，再点一次试试。' }

      // 读者的意见靠模型读，套话靠数。
      //
      // 「不是…而是…」用了四次、「瞳孔一缩」出现三次——这种密度人眼看不出来，
      // 数一遍就知道。所以这一段是**附带**给的：不改模型的意见，
      // 也不替作者改句子，只说哪个说法出现了几次、举一句原文。
      const scan = prose.scanProse(bodyText)
      const scanned = prose.proseReportText(scan)
      const combined = scanned === ''
        ? review
        : `${review}\n\n【顺手数了一下】（不是意见，是数出来的）\n${scanned}`

      return {
        ok: true,
        index,
        review: combined,
        scan,
        chars: bodyText.length,
        blind: true,
        model: String(body?.model ?? ''),
      }
    },

    /** 读一章。 */
    // ── 简历与规划：写简历、看差距、规划怎么走 ─────────────────

    /** 读简历和规划（还没写过也正常，返回 null）。 */
    'career.get': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.career !== true) return missingFeature('career')
      const profile = await career.readProfile(ws)
      if (profile.ok !== true) return profile
      const plan = await career.readPlan(ws)
      if (plan.ok !== true) return plan
      return {
        ok: true,
        profile: profile.data,
        profileSections: profile.sections,
        plan: plan.data,
        planSections: plan.sections,
      }
    },

    /** 存简历。 */
    'career.profile.save': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.career !== true) return missingFeature('career')
      const saved = await career.writeProfile(ws, body?.profile ?? {})
      if (saved.ok !== true) return saved
      return { ok: true, path: career.PROFILE_REL }
    },

    /** 存规划。 */
    'career.plan.save': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.career !== true) return missingFeature('career')
      const saved = await career.writePlan(ws, body?.plan ?? {})
      if (saved.ok !== true) return saved
      return { ok: true, path: career.PURPOSE_REL }
    },

    /** 让 AI 照简历写一份投这个岗位/学校的简历。 */
    'career.resume': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.career !== true) return missingFeature('career')
      const profile = await career.readProfile(ws)
      if (profile.ok !== true) return profile
      if (profile.data === null) return { ok: false, error: '还没有简历。先填一下基本情况、学过什么、做过什么。' }
      const target = String(body?.target ?? '').trim()
      if (target === '') return { ok: false, error: '先写清楚要投哪儿——公司加岗位，或者学校加专业。' }
      const built = career.buildResumePrompt({ profile: profile.sections, target, style: body?.style })
      const called = await callModel(ctx, { system: built.system, user: built.user, model: body?.model })
      if (called.ok !== true) return { ok: false, error: `这次没写出来：${called.error ?? '过一会儿再试一次'}` }
      return { ok: true, target, text: String(called.text ?? '').trim() }
    },

    /**
     * 从一张人物卡里把「能写进简历的东西」摘出来。
     *
     * 只摘不写：这一趟不碰简历文件。用户先看见摘了什么、来自哪一句，
     * 自己划掉不要的，再点一次才并进去。模型这一步只许抄原文，
     * 每条都要过逐字比对（捡不了就整条丢掉，不悄悄放宽）。
     */
    'career.mine': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.career !== true) return missingFeature('career')
      const wanted = String(body?.card ?? '').trim()
      if (wanted === '') return { ok: false, error: '先挑一张卡。挑好我才能从里面往出摘。' }
      const rel = await store.findCardByRelOrId(ws, wanted)
      if (rel === null || rel === undefined) return { ok: false, error: `没找到「${wanted}」这张卡。` }
      const card = await store.readCard(ws, rel)
      if (card.ok !== true) return { ok: false, error: card.error ?? '这张卡读不出来。' }
      // 卡的正文才是材料。只拿 name 去问，模型只能靠猜。
      const text = String(card.text ?? '').trim()
      if (text === '') return { ok: false, error: '这张卡还是空的，里面没有能摘的东西。' }
      const name = String(card.data?.name ?? '').trim()
      const built = career.buildMinePrompt({ cardText: text, name })
      const called = await callModel(ctx, { system: built.system, user: built.user, model: body?.model })
      if (called.ok !== true) return { ok: false, error: `这次没摘出来：${called.error ?? '过一会儿再试一次'}` }
      const parsed = extractJson(called.text)
      if (parsed === null) return { ok: false, error: '这次回来的东西看不明白，再点一次试试。' }
      const raw = Array.isArray(parsed?.items) ? parsed.items : []
      // 材料表：材料名要和模型写的 evidence.material 对得上，这里只有一份，
      // 所以名字就叫这个（模型写全路径也认，verifyQuote 两头都能对上）。
      const materials = { [rel]: text }
      const kept = []
      const dropped = []
      for (const one of raw) {
        if (one === null || typeof one !== 'object') continue
        const slot = String(one.slot ?? '').trim()
        const line = String(one.text ?? '').trim()
        const quote = String(one.quote ?? '').trim()
        if (!career.MINE_SLOTS.includes(slot) || line === '') { dropped.push({ text: line, why: '这一条没说清放到哪儿' }); continue }
        const check = core.verifyQuote({ evidence: { material: rel, quote } }, materials)
        if (check.ok !== true) { dropped.push({ text: line, why: check.reason ?? '原文里找不到这一句' }); continue }
        kept.push({ slot, text: line, quote, line: check.line })
      }
      return {
        ok: true,
        card: { id: String(card.data?.id ?? ''), name, path: rel },
        groups: career.groupMined(kept),
        items: kept,
        dropped,
        labels: career.MINE_SLOT_LABELS,
      }
    },

    /**
     * 把挑中的几条并进简历。只往后加，不改用户自己写的那几行。
     *
     * 为什么不在这里再调一次模型：摘出来的那一句就是要写进去的那一句。
     * 再让它「润色一下」，就会多出没发生过的细节。
     */
    'career.merge': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.career !== true) return missingFeature('career')
      const rows = Array.isArray(body?.items) ? body.items : []
      const items = rows
        .map((one) => ({
          slot: String(one?.slot ?? '').trim(),
          text: String(one?.text ?? '').trim(),
        }))
        .filter((one) => career.MINE_SLOTS.includes(one.slot) && one.text !== '')
      if (items.length === 0) return { ok: false, error: '一条都没挑，那就没东西可并。' }
      const profile = await career.readProfile(ws)
      if (profile.ok !== true) return profile
      const mined = career.groupMined(items)
      const merged = career.mergeProfile(profile.sections ?? {}, mined)
      if (merged.added.length === 0) return { ok: true, added: 0, profile: merged.profile, note: '这几条简历里本来就有，没重复加。' }
      const saved = await career.writeProfile(ws, { ...(profile.data ?? {}), ...merged.profile })
      if (saved.ok !== true) return saved
      return { ok: true, added: merged.added.length, profile: merged.profile, path: saved.path }
    },

    /** 看差距：目标要求的 vs 你现在有的。 */
    'career.gap': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.career !== true) return missingFeature('career')
      const profile = await career.readProfile(ws)
      if (profile.ok !== true) return profile
      if (profile.data === null) return { ok: false, error: '还没有简历。先填一下基本情况、学过什么、做过什么。' }
      const target = String(body?.target ?? '').trim()
      if (target === '') return { ok: false, error: '先写清楚要够到哪儿——公司加岗位，或者学校加专业。' }
      const built = career.buildGapPrompt({ profile: profile.sections, target })
      const called = await callModel(ctx, { system: built.system, user: built.user, model: body?.model })
      if (called.ok !== true) return { ok: false, error: `这次没算出来：${called.error ?? '过一会儿再试一次'}` }
      return { ok: true, target, text: String(called.text ?? '').trim() }
    },

    /** 规划怎么走。 */
    'career.path': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.career !== true) return missingFeature('career')
      const profile = await career.readProfile(ws)
      if (profile.ok !== true) return profile
      if (profile.data === null) return { ok: false, error: '还没有简历。先填一下基本情况、学过什么、做过什么。' }
      const goal = String(body?.goal ?? '').trim()
      if (goal === '') return { ok: false, error: '先写一句「想到哪儿去」——具体的岗位、学校或状态。' }
      const horizon = String(body?.horizon ?? '1年').trim()
      const built = career.buildPathPrompt({ profile: profile.sections, goal, horizon })
      const called = await callModel(ctx, { system: built.system, user: built.user, model: body?.model })
      if (called.ok !== true) return { ok: false, error: `这次没规划出来：${called.error ?? '过一会儿再试一次'}` }
      const text = String(called.text ?? '').trim()
      return { ok: true, goal, horizon, text, steps: career.parseSteps(text) }
    },

    // ── 简历体检：能拿出去投吗、对不对口、一岗一版 ─────────────
    //
    // 这一组全在本地算，不调模型。体检要能随叫随到——改一个字就重算一次，
    // 每算一次都等模型二十秒，那就不叫体检了。

    /**
     * 体检。
     *
     * 贴了招聘说明就把「对不对口」一起算进去；没贴就只算前五维，
     * 不硬扣那一维的分——否则不贴 JD 的人永远封顶 85，那是骗人的。
     */
    'career.coach': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.career !== true) return missingFeature('career')
      const profile = await career.readProfile(ws)
      if (profile.ok !== true) return profile
      const jd = String(body?.jd ?? '').trim()
      const result = resumeCoach.checkResume(profile.sections ?? {}, { jd })
      return { ok: true, ...result, missing: profile.data === null }
    },

    /** 招聘说明要什么、简历里对上了几样。 */
    'career.jd': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.career !== true) return missingFeature('career')
      const profile = await career.readProfile(ws)
      if (profile.ok !== true) return profile
      const jd = String(body?.jd ?? '').trim()
      if (jd === '') return { ok: false, error: '先把招聘说明贴进来。' }
      const cover = resumeCoach.coverageOf(profile.sections ?? {}, jd)
      return { ok: true, ...cover }
    },

    /** 把一条经历改写一遍（要过原句门禁）。 */
    'career.rewrite': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.career !== true) return missingFeature('career')
      const line = String(body?.line ?? '').trim()
      if (line === '') return { ok: false, error: '先把要改的那一条写出来。' }
      const built = resumeCoach.buildStarPrompt({ line, target: body?.target, jd: body?.jd })
      const called = await callModel(ctx, { system: built.system, user: built.user, model: body?.model })
      if (called.ok !== true) return { ok: false, error: `这次没改出来：${called.error ?? '过一会儿再试一次'}` }
      const parsed = extractJson(called.text)
      const text = String(parsed?.rewritten ?? '').trim()
      if (text === '') return { ok: false, error: '这次回来的东西看不明白，再点一次试试。' }
      // 模型改写最容易在这一步越界：把「帮同学装系统」写成「主导体系建设」。
      // 所以改完一律本地再核一遍，越界的原样标出来交给用户判断。
      const check = resumeCoach.checkRewrite(line, text)
      return {
        ok: true,
        before: line,
        after: text,
        changed: Array.isArray(parsed?.changed) ? parsed.changed.map((x) => String(x)).filter((x) => x !== '') : [],
        missing: String(parsed?.missing ?? '').trim(),
        safe: check.ok,
        problems: check.problems,
      }
    },

    /** 列存下来的那几版简历。 */
    'career.versions.list': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.career !== true) return missingFeature('career')
      return await resumeCoach.listVersions(ws)
    },

    /** 读某一版。 */
    'career.versions.get': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.career !== true) return missingFeature('career')
      return await resumeCoach.readVersion(ws, body?.path)
    },

    /**
     * 存一版。
     *
     * 不传 `profile` 就存现在这一份（常用：改完简历存成「投某厂」那一版）。
     * 传了就存传进来的那一份（常用：从某一版恢复回来）。
     */
    'career.versions.save': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.career !== true) return missingFeature('career')
      const name = String(body?.name ?? '').trim()
      if (name === '') return { ok: false, error: '给这一版起个名字，不然以后分不清哪份投哪儿。' }
      let profile = body?.profile
      if (profile === null || profile === undefined) {
        const now = await career.readProfile(ws)
        if (now.ok !== true) return now
        if (now.data === null) return { ok: false, error: '简历还是空的，先填一点再存。' }
        profile = now.sections
      }
      const saved = await resumeCoach.writeVersion(ws, {
        name,
        target: String(body?.target ?? '').trim(),
        jd: String(body?.jd ?? '').trim(),
        profile,
      })
      if (saved.ok !== true) return saved
      return { ok: true, path: saved.path, version: saved.version }
    },

    /** 恢复某一版：把它写成现在的简历。 */
    'career.versions.restore': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.career !== true) return missingFeature('career')
      const got = await resumeCoach.readVersion(ws, body?.path)
      if (got.ok !== true) return got
      const saved = await career.writeProfile(ws, { ...(got.profile ?? {}) })
      if (saved.ok !== true) return saved
      return { ok: true, name: got.name, profile: got.profile, path: saved.path }
    },

    /** 删一版（搬到回收目录，不是真删）。 */
    'career.versions.delete': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.career !== true) return missingFeature('career')
      const gone = await resumeCoach.deleteVersion(ws, body?.path)
      if (gone.ok !== true) return gone
      return { ok: true, path: gone.path, note: '这一版删掉了。原来的文件在回收目录里，需要的话能找回来。' }
    },

    // ── 模拟面试复盘 ─────────────────────────────────────────────
    //
    // 对话数据本来就在产生，缺的是产出物。这一条把它算成七块：
    // 总分、四档计数、按话题分组、四维、两栏、逐题卡片、接下来练什么。
    // 「更好的那一版」要联网，单独走 job.interview.improve 一条一条问。

    /** 一场面试的复盘报告（纯本地算）。 */
    'job.interview.review': async (body) => {
      const ws = await root(body)
      const got = await jobsStore.readInterview(ws, body?.id)
      if (got.ok !== true) return got
      const report = interview.reviewReport(got.session)
      return { ok: true, report, session: { id: got.session?.id, company: got.session?.company, role: got.session?.role } }
    },

    /** 把某一题改成更好的那一版（要过「没编东西」的核）。 */
    'job.interview.improve': async (body) => {
      const ws = await root(body)
      const got = await jobsStore.readInterview(ws, body?.id)
      if (got.ok !== true) return got
      const session = got.session
      const turns = Array.isArray(session.turns) ? session.turns : []
      const index = Number(body?.index)
      if (!Number.isInteger(index) || index < 0 || index >= turns.length) return { ok: false, error: '没找到这一题。' }
      const turn = turns[index]
      const answer = String(turn.answer ?? '').trim()
      if (answer === '' || turn.skipped === true) return { ok: false, error: '这一题没答，没什么可改的。' }
      const built = interview.buildImprovePrompt({ question: turn.question, answer, kind: turn.kind })
      const called = await callModel(ctx, { system: built.system, user: built.user, model: body?.model })
      if (called.ok !== true) return { ok: false, error: `这次没改出来：${called.error ?? '过一会儿再试一次'}` }
      const parsed = extractJson(called.text)
      const better = String(parsed?.better ?? '').trim()
      if (better === '') return { ok: false, error: '这次回来的东西看不明白，再点一次试试。' }
      const check = interview.checkImprovement(answer, better)
      // 越界的那一版不给用户当「更好的回答」看——那正是会让人在真面试里
      // 把没做过的事说出口的东西。只把问题原样报出来。
      if (!check.ok) {
        return { ok: true, index, better: '', used: [], added: '', safe: false, problems: check.problems }
      }
      turns[index] = { ...turn, better }
      session.turns = turns
      const saved = await jobsStore.saveInterview(ws, session)
      if (saved.ok !== true) return saved
      return {
        ok: true,
        index,
        better,
        used: Array.isArray(parsed?.used) ? parsed.used.map((x) => String(x)).filter((x) => x !== '') : [],
        added: String(parsed?.added ?? '').trim(),
        safe: true,
        problems: [],
      }
    },

    // ── 写日记：一天一篇，AI 带着写 ──────────────────────────────
    //
    // 日记不放在这个工作区里：第一次点「写日记」时问一句放哪儿，
    // 之后每天那篇就落在那里（见 diary_dir 配置）。这一层只做三件事：
    // 读写那一天的文件、拼出「今天该问什么」、把写下的东西整理成几条事实。

    /** 日记文件夹在哪儿、今天写了没有。 */
    'diary.info': async (body) => {
      const ws = await root(body)
      const where = await diaryDirOf(ws)
      if (where.ok !== true) return where
      const today = store.localDate()
      // 第一次用的时候得给个能直接点的位置。客户端不知道用户家目录在哪儿
      // （宿主交给插件的作用域里没有这一层），所以在这儿算一句带回去。
      const suggested = path.join(homedir(), 'Documents', '我的日记')
      if (where.dir === '') return { ok: true, dir: '', ready: false, today, todayDone: false, count: 0, suggest: suggested, recent: [] }
      // 列最近 40 篇够看「今天写了没有」，但「写过多少天」得用总数报：
      // 拿列表长度当总数，写到第 401 天起数字就不动了。
      const listed = await diary.listDiaries(where.dir, { limit: 40 })
      // 文件夹被删掉 / 挪走 / 没权限时不能装作一切正常：用户会看到
      // 「今天还没写」，写的时候才发现存不进去。这两种情况如实说。
      if (listed.ok !== true) {
        return { ok: true, dir: where.dir, ready: true, today, todayDone: false, count: 0, recent: [], broken: true, error: listed.error ?? '那个文件夹读不出来。' }
      }
      const recent = listed.diaries.slice(0, 7)
      return {
        ok: true,
        dir: where.dir,
        ready: true,
        today,
        todayDone: recent.some((d) => d.date === today),
        count: Number(listed.total ?? listed.diaries.length),
        recent,
        missing: listed.missing === true,
      }
    },

    /** 定下日记放哪儿（会顺手建好文件夹）。 */
    'diary.dir.set': async (body) => {
      const ws = await root(body)
      const raw = String(body?.dir ?? '').trim()
      if (raw === '') return { ok: false, error: '没有说是哪个文件夹。' }
      const dir = diary.diaryRootFrom({ diary_dir: raw })
      if (dir === '' || dir === path.parse(dir).root) return { ok: false, error: '不能整个磁盘根目录都当日记文件夹。换一个位置。' }
      const veto = diaryDirVeto(dir)
      if (veto !== '') return { ok: false, error: veto }
      const made = await fs.mkdir(dir, { recursive: true }).then(() => true).catch(() => false)
      if (!made) return { ok: false, error: '这个文件夹建不出来。换一个位置，或者检查一下有没有写的权限。' }
      // 探针文件用完就删，但**先看它原本存不存在**：用户文件夹里真有个同名文件时，
      // 我们既不该覆盖它，也不该删掉它。也不能给它传 undefined 当内容——
      // Node 对 `writeFile(p, undefined)` 直接抛 TypeError，于是「本来好好的文件夹」
      // 会被判成写不进去。
      const probe = path.join(dir, '.lifecard-diary-probe')
      const hadProbe = await fs.lstat(probe).then(() => true).catch(() => false)
      const writable = await (hadProbe
        ? fs.appendFile(probe, '')
        : fs.writeFile(probe, 'x', { encoding: 'utf8' }).then(() => fs.rm(probe, { force: true }))
      ).then(() => true).catch(() => false)
      if (writable !== true) return { ok: false, error: '这个文件夹写不进去。换一个位置，或者检查一下有没有写的权限。' }
      const saved = await store.writeConfig(ws, { diary_dir: dir })
      if (saved?.ok !== true) return { ok: false, error: saved?.error ?? '位置没记住，下次还得再挑一次。' }
      return { ok: true, dir }
    },

    /** 读某一天（不传就是今天）。 */
    'diary.get': async (body) => {
      const ws = await root(body)
      const where = await diaryDirOf(ws)
      if (where.ok !== true) return where
      if (where.dir === '') return { ok: true, dir: '', ready: false, date: String(body?.date ?? '') || store.localDate(), data: null }
      const date = String(body?.date ?? '').trim() === '' ? store.localDate() : String(body.date).trim()
      if (diary.dateFileName(date) === '') return { ok: false, error: '日期看起来不对，应该是 2026-10-31 这种样子。' }
      const got = await diary.readDiary(where.dir, date)
      if (got.ok !== true) return got
      // 除了五节，还得把「文件里本来还有」的东西交出去：用户写在开头那段话、
      // 自己加的小节。不交的话界面上看不见它们，他会以为存丢了。
      return {
        ok: true,
        dir: where.dir,
        ready: true,
        date,
        data: got.data,
        intro: got.intro ?? '',
        extraSections: got.extraSections ?? [],
        scoreLines: got.scoreLines ?? [],
        missing: got.missing === true,
      }
    },

    /** 存某一天。 */
    'diary.save': async (body) => {
      const ws = await root(body)
      const where = await diaryDirOf(ws)
      if (where.ok !== true) return where
      if (where.dir === '') return { ok: false, error: '还没有定日记放在哪个文件夹。' }
      const date = String(body?.date ?? '').trim() === '' ? store.localDate() : String(body.date).trim()
      if (diary.dateFileName(date) === '') return { ok: false, error: '日期看起来不对，应该是 2026-10-31 这种样子。' }
      // 先读一遍再写：写过的那一天，读出来是什么样，写的时候就得还是那个样子。
      // 中间被别处改过（用户自己在访达里动了），这次一个字节都不写。
      // 这条路由以前是裸写，谁调它都能把一整天整篇盖掉。
      const existing = await diary.readDiary(where.dir, date)
      if (existing.ok !== true) {
        return { ok: false, error: `这一天读不出来，为了不覆盖掉原来的东西，这次没存：${String(existing.error ?? '')}` }
      }
      const saved = await diary.writeDiary(where.dir, { ...(body?.data ?? {}), date }, new Date(), {
        expect: typeof existing.text === 'string' ? { text: existing.text } : {},
      })
      if (saved.ok !== true) return saved
      return { ok: true, dir: where.dir, date, path: saved.path, mode: saved.mode }
    },

    /** 最近写过哪几天。 */
    'diary.list': async (body) => {
      const ws = await root(body)
      const where = await diaryDirOf(ws)
      if (where.ok !== true) return where
      if (where.dir === '') return { ok: true, dir: '', ready: false, diaries: [] }
      const listed = await diary.listDiaries(where.dir, { limit: Number(body?.limit) > 0 ? Number(body.limit) : 400 })
      if (listed.ok !== true) return listed
      return { ok: true, dir: where.dir, ready: true, diaries: listed.diaries }
    },

    /**
     * 开今天这一场：给出预设名和第一句。
     *
     * 为什么不让客户端自己拼：要带上前几天写的、带着「我」那张卡里已经有的东西，
     * 还要知道今天写过没有。这些都只有后台读得到。
     */
    'diary.start': async (body) => {
      // choices 是「用到才加载」的模块。这里要拿它拼指令，得先拉起来；
      // 拉不起来（文件被删）就退化成不加指令，日记本身照写。
      await ensureModules()
      const ws = await root(body)
      const where = await diaryDirOf(ws)
      if (where.ok !== true) return where
      const today = store.localDate()
      let recent = ''
      let todayDone = false
      let draft = ''
      if (where.dir !== '') {
        const listed = await diary.listDiaries(where.dir, { limit: 40 })
        if (listed.ok === true) {
          todayDone = listed.diaries.some((d) => d.date === today)
          // 今天已经写过的，把正文带上。不带的话模型看不见上午写的那几节，
          // 只好从头重问一遍；存盘时它照着新问出来的整节重写，上午写的就没了。
          if (todayDone) {
            const got = await diary.readDiary(where.dir, today)
            if (got.ok === true && got.data !== null) draft = diary.diaryBlock(got.data, { intro: got.intro, extraSections: got.extraSections })
          }
          const picked = listed.diaries.filter((d) => d.date !== today).slice(0, 3)
          const texts = []
          for (const item of picked) {
            const got = await diary.readDiary(where.dir, item.date)
            if (got.ok === true && got.data !== null) texts.push({ date: item.date, data: got.data, intro: got.intro, extraSections: got.extraSections })
          }
          recent = diary.recentBlock(picked.map((d) => d.date), texts)
        }
      }
      const pin = pinnedCardIdSync(ws, 'diary')
      let cardName = ''
      let persona = ''
      if (pin !== '') {
        const abs = cardPathSync(ws, pin)
        const raw = abs === '' ? null : readCachedSync(abs)
        if (raw !== null) {
          const parsed = core.parseCard(raw)
          if (parsed.ok === true) {
            cardName = String(parsed.data?.name ?? '').trim()
            persona = ['自述', '性格', '口癖', '不会说的话', '不会做的事']
              .map((title) => core.sectionBody(parsed.sections, title))
              .filter((part) => typeof part === 'string' && part.trim() !== '')
              .join('\n\n')
          }
        }
      }
      // 问完一句，顺手给三个往下讲的角度。写日记最卡的地方不是不想说，
      // 是「不知道从哪儿说」——给方向比给鼓励有用。
      //
      // 日记里的选项和别处不同：它不落到选项块里被界面收走，而是留在正文里
      // 给用户看（`diary.writeDiary` 存盘时会把 tagged 的选项块剪掉，
      // 所以模型写了也不会污染那五节）。
      const diaryChoices = choices === null
        ? ''
        : choices.choiceDirective({ style: 'diary', count: 3 })
      const text = [
        '/lifecard-diary',
        `今天是 ${today}。带我写今天这一篇。`,
        diaryChoices === '' ? '' : `\n${diaryChoices}`,
        draft === '' ? '' : `\n今天已经写下这些了：\n${draft}`,
        draft === '' ? '' : '\n接着往下问，别把已经写过的重问一遍。要改哪一节先说清改成什么，我点头了再改。',
        persona === '' ? '' : `\n带着这张卡里的人来问（${cardName}）：\n${persona}`,
        recent === '' ? '' : `\n前几天写过这些：\n${recent}`,
      ]
        .filter((line) => line !== '')
        .join('\n')
      return { ok: true, preset: 'lc-diary', date: today, dir: where.dir, todayDone, cardName, personaChars: persona.length, draftChars: draft.length, text }
    },

    /** 把某一天写下的东西整理成「关于这个人的几条事实」，给改卡用。 */
    'diary.digest': async (body) => {
      const ws = await root(body)
      const where = await diaryDirOf(ws)
      if (where.ok !== true) return where
      if (where.dir === '') return { ok: false, error: '还没有定日记放在哪个文件夹。' }
      const date = String(body?.date ?? '').trim() === '' ? store.localDate() : String(body.date).trim()
      const got = await diary.readDiary(where.dir, date)
      if (got.ok !== true) return got
      if (got.data === null) return { ok: false, error: '这一天还没写。' }
      const built = diary.buildDigestPrompt({ date, text: diary.diaryBlock(got.data, { intro: got.intro, extraSections: got.extraSections }) })
      const called = await callModel(ctx, { system: built.system, user: built.user, model: body?.model })
      if (called.ok !== true) return { ok: false, error: `这次没整理出来：${called.error ?? '过一会儿再试一次'}` }
      return { ok: true, date, text: String(called.text ?? '').trim() }
    },

    /**
     * 今天用过 dsh 但没写日记，就替他把这一篇补上。
     *
     * 这一条路由自己不做判断，也不自己攒材料：找会话、抽「人说的话」、拼摘要
     * 全在 lib/auto-diary.js 里（那边每一条都有对应的测试），这里只负责把
     * 顺序接起来——找会话 → 判该不该写 → 叫一次模型 → 落盘。
     *
     * 「该不该写」压给 shouldAutoWrite 而不是就地写一个 if：三个「不写」
     * （写过 / 没聊过 / 材料太少）以后还会加，判断只在它一处，路由这边
     * 就不会跟它说两套话。早返还有一个实际好处——判完就不用叫模型了。
     *
     * 为什么 cwd 传当前库目录：宿主的会话按 cwd 分目录存
     * （`sessions/--Users-x-project--/`），不按库分。今天在这个目录里开过
     * 会话，才说明他今天真干了活；换一个库目录去找，找到的是别人的一天。
     */
    'diary.autoWrite': async (body) => {
      // 关掉自动日记的开关。定时器那边醒过来时会先判一次（关了就不白醒），
      // 这里再判一次是因为这条路由本身也能被脚本或界面直接调——两道闸
      // 都要能挡住，不然「关了」这件事只在定时器那条路上成立。
      if (process.env.DSH_LIFECARD_SKIP_AUTO_DIARY === '1') {
        return { ok: true, skipped: '自动日记关着（DSH_LIFECARD_SKIP_AUTO_DIARY=1）', date: store.localDate() }
      }
      const ws = await root(body)
      const where = await diaryDirOf(ws)
      if (where.ok !== true) return where
      if (where.dir === '') return { ok: false, error: '还没有定日记放在哪个文件夹。' }
      const now = new Date()
      const date = store.localDate(now)

      // 先凑材料再谈别的：今天没在这个目录里开过会话，就没有任何东西可写，
      // 这一步不叫模型（模型调用是这条链上最贵、最慢的一环）。
      const found = await autoDiary.findTodaySessions({ home: dshHome(), cwd: ws, now })
      if (found.ok !== true) return { ok: false, error: found.error }
      const material = autoDiary.digestForDiary(found.sessions)

      // 读今天这一篇。readDiary 在「今天还没写」时返回的是 data:null 而不是
      // 报错（missing:true），这边要的正是这个区分：null 才能往下写。
      const got = await diary.readDiary(where.dir, date)
      if (got.ok !== true) return got
      const todayDiary = got.data === null ? null : got.data
      const verdict = autoDiary.shouldAutoWrite({ todayDiary, material })
      if (verdict.should !== true) {
        // settled 是给夜里那个定时器看的，不是给界面看的：它表示「今天这件事
        // 已经了结，剩下的时间别再试了」。
        //
        // 只有「今天写过了」算 settled。材料不够、今天还没聊，都不算——他
        // 20:10 还没开始干活，23:00 聊完了，那时候该写还是要写。早先把所有
        // 跳过都算成了结，结果是「20 点那次没材料 → 整晚不再看」。界面那边
        // 不需要这个字段，多了也不影响它。
        return {
          ok: true,
          skipped: verdict.reason,
          date,
          sessions: found.sessions.length,
          settled: todayDiary !== null,
        }
      }

      // 前几天写到哪儿。不传的话模型每次从零开始，连着几天会写出几乎一样的
      // 开头（「今天把插件跑起来了」）。
      let recent = ''
      const listed = await diary.listDiaries(where.dir, { limit: 40 })
      if (listed.ok === true) {
        const picked = listed.diaries.filter((d) => d.date !== date).slice(0, 3)
        const texts = []
        for (const item of picked) {
          const one = await diary.readDiary(where.dir, item.date)
          if (one.ok === true && one.data !== null) {
            texts.push({ date: item.date, data: one.data, intro: one.intro, extraSections: one.extraSections })
          }
        }
        recent = diary.recentBlock(picked.map((d) => d.date), texts)
      }

      const built = autoDiary.buildAutoDiaryPrompt({ date, material, recent })
      const called = await callModel(ctx, { system: built.system, user: built.user, model: body?.model })
      if (called.ok !== true) return { ok: false, error: `今天这一篇没写出来：${called.error ?? '过一会儿再试一次'}` }

      const parsed = autoDiary.parseAutoDiary(called.text, date)
      // 五节一节都没认出来就不落盘。硬写进去是一篇空日记，而用户第二天
      // 打开看到「今天写过」，就再也不会补了——比没写更糟。
      if (parsed.ok !== true) {
        return { ok: false, error: parsed.error ?? '模型的回复没照五节写，这一篇先没落盘。' }
      }

      // 把「读到的是什么样」交给 writeDiary 核对。自动写的时间点正是用户
      // 可能在别的窗口手写的时候，两个方向都要挡住：他刚写完 ✅ 我们别覆盖，
      // 他刚删空 ✅ 也别拿旧内容填回去。
      const expect = got.data === null ? { text: null } : { text: String(got.text ?? '') }
      const wrote = await diary.writeDiary(where.dir, parsed.data, now, { expect })
      if (wrote.ok !== true) return { ok: false, error: wrote.error }
      return { ok: true, date, chars: wrote.chars, wrote: true, path: wrote.path, missing: parsed.missing }
    },

    // ── 文字小说游戏：进到情节里，你来选，它来推 ────────────────

    /** 一本书能开哪几局。 */
    'game.list': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.game !== true) return missingFeature('game')
      const id = String(body?.book ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      return await game.listPlays(ws, id)
    },

    /** 读一局（回到上次那个地方）。 */
    'game.get': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.game !== true) return missingFeature('game')
      const book = String(body?.book ?? '').trim()
      const id = String(body?.id ?? '').trim()
      if (book === '' || id === '') return { ok: false, error: '这一局找不到了' }
      const got = await game.readPlay(ws, book, id)
      if (got.ok !== true) return got
      const last = [...got.turns].reverse().find((t) => t.kind === 'narrate')
      return {
        ok: true, id, book, path: got.path,
        chapter: Number(got.data?.chapter) || 0,
        preset: String(got.data?.preset ?? ''),
        role: String(got.data?.role ?? ''),
        quest: String(got.data?.quest ?? ''),
        // 挑过哪个玩法引擎。界面要摆一个徽标——不然「这一局在查案还是求生」
        // 只能去读提示词，而提示词用户在界面上看不见。
        engine: String(got.data?.engine ?? ''),
        scene: got.scene,
        status: got.status,
        holding: got.holding,
        turns: got.turns,
        choices: game.parseChoices(String(last?.text ?? '')).choices,
      }
    },

    /** 开一局：从某一章接着演。 */
    'game.start': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.game !== true) return missingFeature('game')
      if (mods.novel !== true) return missingFeature('novel')
      const bookId = String(body?.book ?? '').trim()
      if (bookId === '') return { ok: false, error: '没有说是哪本书' }
      const book = await novel.readBook(ws, bookId)
      if (book.ok !== true) return book
      const chapter = Number(body?.chapter) || (book.chapters.length === 0 ? 0 : book.chapters[0].index)
      // 开局那一段：优先用这一章的正文；没有就让 AI 自己起头。
      let fromChapter = ''
      if (chapter > 0) {
        const got = await novel.readChapter(ws, bookId, chapter)
        if (got.ok === true) fromChapter = novel.tailOf(got.body, 1600)
      }
      const picked = mods.presets === true ? await presets.resolve(ws, body?.preset) : { ok: true, preset: null }
      const presetNote = picked.ok === true && picked.preset !== null ? String(picked.preset.prompt ?? '') : ''
      // 这一局你操控谁：可以是书里的人（`role`），也可以是凭空写的一个人
      // （`role` 里直接是一段自述）。两种都当成「同一个人」往下用——主持人不该
      // 因为来源不同就换一种写法。
      const role = String(body?.role ?? '').trim().slice(0, 600)
      // 「这一局要做什么」：给一条目标，主持人才会往那个方向铺路。
      const quest = String(body?.quest ?? '').trim().slice(0, 300)
      const presetWithQuest = [presetNote, quest === '' ? '' : `这一局要做的事：${quest}`].filter((x) => x !== '').join('\n\n')
      // 开局就能挑玩法引擎。以前只有 `game.engine.set` 能改，而那只对**已经开好的**
      // 一局生效——界面上的引擎选择器摆在开局屏，点下去却落不进这一局，
      // 于是「选了查案，演出来还是原来那套」。
      const startEngineId = String(body?.engine ?? '').trim()
      const startEngine = startEngineId === '' ? null : story.findEngine(startEngineId)
      if (startEngineId !== '' && startEngine === null) {
        return { ok: false, error: `没有「${startEngineId}」这个玩法引擎。` }
      }
      const system = startEngine === null
        ? game.buildGmSystem({
          bookTitle: String(book.data?.title ?? bookId),
          scene: '',
          status: [],
          holding: [],
          preset: presetWithQuest,
          role,
        })
        : story.buildEngineSystem({
          engine: startEngine,
          bookTitle: String(book.data?.title ?? bookId),
          scene: '',
          status: [],
          holding: [],
          preset: presetWithQuest,
          role,
          flags: '',
        })
      const user = game.buildGmUser({ turns: [], move: '', fromChapter, status: [] })
      const called = await callModel(ctx, { system, user, model: body?.model })
      if (called.ok !== true) return { ok: false, error: `这一局开不起来：${called.error ?? '过一会儿再试一次'}` }
      const stripped = game.parseStateBlock(called.text)
      const parsed = game.parseChoices(stripped.body)
      // 开局这一步也算走了第 0 步，模型报的状态要留在这份存档的第一屏上。
      const id = await game.uniquePlayId(ws, bookId)
      const now = new Date()
      const turns = [{ kind: 'narrate', text: parsed.body }]
      const data = {
        id, book: bookId, chapter,
        preset: String(body?.preset ?? ''),
        role,
        quest,
        created_at: now.toISOString(), updated_at: now.toISOString(), turn: 0,
        scene: '', status: stripped.status, holding: [],
        // 挑过的玩法要跟着存档走，不然下一步 `game.say` 又退回老主持人那套，
        // 用户挑的引擎只在第一屏生效。
        engine: startEngine === null ? '' : startEngine.id,
      }
      const saved = await game.writePlay(ws, bookId, id, data, turns)
      if (saved.ok !== true) return saved
      return { ok: true, id, book: bookId, chapter, path: saved.path, text: parsed.body, choices: parsed.choices, status: stripped.status, turns, engine: String(data.engine ?? '') }
    },

    /** 走一步。 */
    'game.say': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.game !== true) return missingFeature('game')
      const bookId = String(body?.book ?? '').trim()
      const id = String(body?.id ?? '').trim()
      if (bookId === '' || id === '') return { ok: false, error: '这一局找不到了' }
      // 同一局的两步必须排队：这里也是「读 → 调模型（几十秒）→ 整文件写回」。
      // 键要带 bookId —— 两本书里各自有一局 `play-1` 是很正常的。
      return oneAtATime(`game:${bookId}/${id}`, async () => {
      const got = await game.readPlay(ws, bookId, id)
      if (got.ok !== true) return got
      const turns = Array.isArray(got.turns) ? got.turns : []
      const moves = turns.filter((t) => t.kind === 'choose' || t.kind === 'say').length
      if (moves >= game.MAX_TURNS) {
        return { ok: false, error: `这一局已经走了 ${moves} 步，太长了记不住前面。在这里收个尾，或者另开一局。`, turns }
      }
      const move = String(body?.move ?? '').trim()
      if (move === '') return { ok: false, error: '先选一个方向，或者自己写一句' }
      const book = mods.novel === true ? await novel.readBook(ws, bookId) : { ok: true, data: { title: bookId } }
      if (book.ok !== true) return book
      const picked = mods.presets === true ? await presets.resolve(ws, String(got.data?.preset ?? '')) : { ok: true, preset: null }
      const presetNote = picked.ok === true && picked.preset !== null ? String(picked.preset.prompt ?? '') : ''
      const questNote = String(got.data?.quest ?? '').trim()
      const presetWithQuest = [presetNote, questNote === '' ? '' : `这一局要做的事：${questNote}`].filter((x) => x !== '').join('\n\n')
      // 这一局挑过玩法引擎就走引擎那套提示词；没挑过就是原来那五个预设的老路。
      // 两条路都留着，是因为老存档里 `engine` 字段是空的——不能让它们演起来变味。
      const pickedEngine = story.findEngine(String(got.data?.engine ?? ''))
      const system = pickedEngine === null
        ? game.buildGmSystem({
          bookTitle: String(book.data?.title ?? bookId),
          scene: got.scene,
          status: got.status,
          holding: got.holding,
          preset: presetWithQuest,
          role: String(got.data?.role ?? ''),
        })
        : story.buildEngineSystem({
          engine: pickedEngine,
          bookTitle: String(book.data?.title ?? bookId),
          scene: got.scene,
          status: got.status,
          holding: got.holding,
          preset: presetWithQuest,
          role: String(got.data?.role ?? ''),
          // 旗标就存在存档的 frontmatter 里（一行一条），引擎的织体靠它分叉。
          flags: String(got.data?.flags ?? ''),
        })
      const user = game.buildGmUser({ turns, move, status: got.status })
      const called = await callModel(ctx, { system, user, model: body?.model })
      // 模型没接上也要把你这一步记下来：不然你选过什么，下一轮它完全不知道。
      const stripped = game.parseStateBlock(called.ok === true ? called.text : '')
      const parsed = game.parseChoices(stripped.body)
      const nextTurns = [...turns, { kind: 'choose', text: move, result: called.ok === true ? parsed.body : '' }]
      const now = new Date()
      const data = {
        ...got.data,
        updated_at: now.toISOString(),
        turn: moves + 1,
        // 新一轮报了状态就换新的；这一轮它偷懒没报，就留着上一轮的——
        // 清空会让小窗突然变白，用户以为人死了。
        status: stripped.found ? stripped.status : got.status,
      }
      const saved = await game.writePlay(ws, bookId, id, data, nextTurns)
      if (saved.ok !== true) return saved
      // 结局只是**带回去**，不在这里拦人：判出输赢以后你还想接着说，话照样接得上。
      // 存档里不写「已结束」——真封了档，用户想再补一句就没路了。
      const judged = pickedEngine === null ? { ending: '', reason: '' } : story.judgeEnding(pickedEngine, data.status)
      const endingOut = judged.ending === '' ? {} : { ending: judged.ending, endingReason: judged.reason }
      if (called.ok !== true) {
        return { ok: false, error: `这一步记下了，但它没接上话：${called.error ?? '过一会儿再试一次'}`, turns: nextTurns, kept: true, ...endingOut }
      }
      return { ok: true, id, text: parsed.body, choices: parsed.choices, status: data.status, turns: nextTurns, ...endingOut }
      })
    },

    /**
     * 把这一局演出来的东西，写成这本书的一章。
     *
     * 和酒馆那条是一个意思：演着演着发现这一段真好，就把它定下来变成正文，
     * 而不是让人自己回去照着复述一遍。
     */
    'game.toChapter': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.game !== true) return missingFeature('game')
      if (mods.novel !== true) return missingFeature('novel')
      const bookId = String(body?.book ?? '').trim()
      const id = String(body?.id ?? '').trim()
      if (bookId === '' || id === '') return { ok: false, error: '这一局找不到了' }
      const got = await game.readPlay(ws, bookId, id)
      if (got.ok !== true) return got
      const turns = Array.isArray(got.turns) ? got.turns : []
      if (turns.length === 0) return { ok: false, error: '这一局还什么都没发生，先走一步再变成一章。' }
      const book = await novel.readBook(ws, bookId)
      if (book.ok !== true) return book
      const prompt = game.buildPlayToChapterPrompt({
        bookTitle: String(book.data?.title ?? bookId),
        turns,
        note: body?.note,
      })
      const called = await callModel(ctx, { system: prompt.system, user: prompt.user, model: body?.model })
      if (called.ok !== true) return { ok: false, error: `没写成：${called.error ?? '过一会儿再试一次'}`, kept: true }
      const text = String(called.text ?? '').trim()
      if (text === '') return { ok: false, error: '这次什么都没写出来，过一会儿再试一次。' }
      const list = Array.isArray(book.chapters) ? book.chapters : []
      const last = list.length === 0 ? 0 : Number(list[list.length - 1]?.index ?? 0)
      const next = (Number.isFinite(last) ? last : 0) + 1
      const saved = await novel.writeChapter(ws, bookId, next, text)
      if (saved.ok !== true) return saved
      return { ok: true, chapter: next, text, warning: saved.warning }
    },

    /** 这一局不要了。 */
    'game.delete': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.game !== true) return missingFeature('game')
      const book = String(body?.book ?? '').trim()
      const id = String(body?.id ?? '').trim()
      if (book === '' || id === '') return { ok: false, error: '这一局找不到了' }
      return await game.deletePlay(ws, book, id)
    },

    // ── 剧本引擎：玩法引擎清单、剧本读存、导出 ──────────────────
    // 这一片全走 lib/story.js 的纯函数，落盘只有一处（脚本文件本身）。

    /**
     * 有哪些玩法引擎可选。
     *
     * 只回能序列化的那几项：`rules` 和 `judge` 一个是提示词一个是函数，
     * 塞进 JSON 里前者白占几十 K，后者直接变成 undefined，界面还用不上。
     */
    'game.engines': async (body) => {
      await root(body)
      const engines = story.ENGINES.map((eng) => ({
        id: eng.id,
        name: eng.name,
        desc: eng.desc,
        presetId: eng.presetId,
        fields: eng.fields,
      }))
      return { ok: true, engines }
    },

    /** 读一局的剧本。脚本不存在时回空剧本，不报错——新开一局本来就没有。 */
    'game.script.read': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.game !== true) return missingFeature('game')
      const bookId = String(body?.book ?? body?.id ?? '').trim()
      const playId = String(body?.playId ?? '').trim()
      if (bookId === '' || playId === '') return { ok: false, error: '这一局找不到了' }
      const rel = scriptRelPath(bookId, playId)
      const safe = await insideWorkspace(ws, rel)
      if (safe.ok !== true) return safe
      let text = ''
      try {
        text = await fs.readFile(path.join(ws, safe.rel), 'utf8')
      } catch (error) {
        if (error?.code !== 'ENOENT') return { ok: false, error: '剧本读不出来，检查一下文件夹权限' }
        return { ok: true, nodes: [], errors: [], text: '', exists: false, path: safe.rel }
      }
      const parsed = story.parseScript(text)
      return { ok: parsed.ok === true, nodes: parsed.nodes, errors: parsed.errors, text, exists: true, path: safe.rel }
    },

    /**
     * 存一局的剧本。
     *
     * 先解析再落盘：坏剧本一旦写进去，下一次读回来的是一个「跳转到不存在的
     * 节点」的局，用户看到的才是错，而那时已经找不到是哪一行写坏的了。
     * 所以把错原样回给他，让他对着行号改。
     */
    'game.script.save': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.game !== true) return missingFeature('game')
      const bookId = String(body?.book ?? body?.id ?? '').trim()
      const playId = String(body?.playId ?? '').trim()
      if (bookId === '' || playId === '') return { ok: false, error: '这一局找不到了' }
      const text = String(body?.text ?? '')
      const parsed = story.parseScript(text)
      if (parsed.ok !== true) return { ok: false, error: '剧本里还有没对上的地方，先改这几处', errors: parsed.errors, nodes: parsed.nodes }
      const rel = scriptRelPath(bookId, playId)
      const safe = await insideWorkspace(ws, rel)
      if (safe.ok !== true) return safe
      try {
        const abs = path.join(ws, safe.rel)
        await fs.mkdir(path.dirname(abs), { recursive: true })
        await writeFileAtomic(abs, text)
      } catch {
        return { ok: false, error: '剧本没能存下来，检查一下磁盘是不是满了' }
      }
      return { ok: true, path: safe.rel, nodes: parsed.nodes, errors: [] }
    },

    /** 把剧本导成 ink 脚本，拿去 inklewriter 里继续改。 */
    'game.export.ink': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.game !== true) return missingFeature('game')
      const bookId = String(body?.book ?? body?.id ?? '').trim()
      const playId = String(body?.playId ?? '').trim()
      if (bookId === '' || playId === '') return { ok: false, error: '这一局找不到了' }
      const loaded = await readScriptNodes(ws, bookId, playId)
      if (loaded.ok !== true) return loaded
      if (loaded.nodes.length === 0) return { ok: false, error: '这一局还没有剧本，先写一段再导出。' }
      const text = story.toInk(loaded.nodes, { title: String(body?.title ?? '').trim() || bookId })
      return { ok: true, text, filename: `${core.safeId(playId)}.ink`, errors: loaded.errors }
    },

    /** 把剧本导成单文件网页，双击就能玩。 */
    'game.export.cyoa': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.game !== true) return missingFeature('game')
      const bookId = String(body?.book ?? body?.id ?? '').trim()
      const playId = String(body?.playId ?? '').trim()
      if (bookId === '' || playId === '') return { ok: false, error: '这一局找不到了' }
      const loaded = await readScriptNodes(ws, bookId, playId)
      if (loaded.ok !== true) return loaded
      if (loaded.nodes.length === 0) return { ok: false, error: '这一局还没有剧本，先写一段再导出。' }
      const title = String(body?.title ?? '').trim() || bookId
      const html = story.toCyoaHtml(title, loaded.nodes)
      return { ok: true, html, filename: `${core.safeId(playId)}.html`, errors: loaded.errors }
    },

    /**
     * 给这一局挑一个玩法引擎，写进存档的 frontmatter。
     *
     * 存的是 id 字符串而不是整个引擎对象：引擎里带着函数，序列化不了；
     * 而且以后改引擎的规则，老存档要跟着变，不能把一份旧规则冻在存档里。
     * 传空字符串就是退回「不挑引擎」，走 game.buildGmSystem 那套。
     */
    'game.engine.set': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.game !== true) return missingFeature('game')
      const bookId = String(body?.book ?? body?.id ?? '').trim()
      const playId = String(body?.playId ?? '').trim()
      if (bookId === '' || playId === '') return { ok: false, error: '这一局找不到了' }
      const engineId = String(body?.engineId ?? '').trim()
      if (engineId !== '' && story.findEngine(engineId) === null) {
        return { ok: false, error: `没有「${engineId}」这个玩法引擎。` }
      }
      const got = await game.readPlay(ws, bookId, playId)
      if (got.ok !== true) return got
      const data = { ...got.data, engine: engineId, updated_at: new Date().toISOString() }
      const saved = await game.writePlay(ws, bookId, playId, data, Array.isArray(got.turns) ? got.turns : [])
      if (saved.ok !== true) return saved
      return { ok: true, engine: engineId, path: saved.path }
    },

    // ── 预设：三种玩法各自的演法/写法 ─────────────────────────

    /** 哪些功能装了、哪些没装。界面按这个决定显示什么。 */
    'features.list': async (body) => {
      const mods = await ensureModules()
      return {
        ok: true,
        features: {
          real: true,
          jobs: true,
          tavern: mods.tavern === true,
          novel: mods.novel === true,
          presets: mods.presets === true,
          game: mods.game === true && mods.novel === true,
          career: mods.career === true,
        },
      }
    },

    /**
     * 列预设（内置 + 自己的），顺便带上「能挂上去的书和世界观」。
     *
     * 书要在这里传进去：presets.js 不能 import novel.js（两个模块都能单独卸掉，
     * 互相依赖会让卸掉其中一个时另一个也起不来）。这一层本来就两个都拿着，
     * 所以由它取书、传给 `listAll`。取书失败只影响那一排按钮，不影响预设本身。
     */
    'preset.list': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.presets !== true) return missingFeature('presets')
      let books = []
      if (mods.novel === true) {
        const got = await novel.listBooks(ws).catch(() => null)
        if (got !== null && got.ok === true) books = got.books
      }
      return await presets.listAll(ws, { books })
    },

    /** 把一份自己的预设挂到某本书 / 某个世界观上（传空串就是解绑）。 */
    'preset.bind': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.presets !== true) return missingFeature('presets')
      return await presets.bindPreset(ws, { id: body?.id, book: body?.book, world: body?.world })
    },

    /**
     * 判一下「他这句话是想进哪扇门」。
     *
     * 纯本地关键词计数，不调模型——这个判断要在点预设那一瞬间出结果，
     * 等一次模型往返界面就没反应了。判不准时回的是四个选项，让人自己挑。
     */
    'intent.judge': async (body) => {
      const ws = await root(body)
      const mods = await ensureModules()
      const intent = await ensureIntent()
      if (intent === null) {
        // 这一层没了也不该让界面卡死：给一句「挑一个」，四扇门由界面自己摆。
        return { ok: false, error: '判门这一部分没装（lib/intent.js 不在）。挑一扇门就行。' }
      }
      // 手上有卡 → 多半是想演一段。只要任何一扇门钉过卡就算「有」：
      // 这里只用来兜一句「大概是想演」，不做精确判断。
      let hasCard = false
      try {
        const state = await store.readConfigState(ws)
        const pins = state.config?.default_cards ?? {}
        hasCard = DOORS.some((door) => String(pins[door] ?? '') !== '')
      } catch { hasCard = false }
      let hasBook = false
      if (mods.novel === true) {
        const got = await novel.listBooks(ws).catch(() => null)
        hasBook = got !== null && got.ok === true && (got.books ?? []).length > 0
      }
      let hasWorld = false
      if (mods.presets === true) {
        const worlds = await presets.listWorlds(ws).catch(() => [])
        hasWorld = Array.isArray(worlds) && worlds.length > 0
      }
      const verdict = intent.judgeIntent({
        text: body?.text,
        mode: body?.mode,
        hasCard,
        hasBook,
        hasWorld,
      })
      return { ok: true, ...verdict }
    },

    /** 把一份内置的复制成自己的，之后能随便改。 */
    'preset.copy': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.presets !== true) return missingFeature('presets')
      return await presets.copyBuiltin(ws, body?.id, body?.as)
    },

    /** 存一份自己的预设（新建或改）。 */
    'preset.save': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.presets !== true) return missingFeature('presets')
      // 改已有预设时要显式带 overwrite：`saveCustom` 默认走 `'wx'`，
      // 撞名就拒（这条是内存层加的保护，防的是「手滑覆盖了别人那份」）。
      // 但界面上「改完再存」本来就是覆盖语义，所以这一层得把它透传下去。
      return await presets.saveCustom(ws, {
        id: body?.id, mode: body?.mode, name: body?.name, desc: body?.desc, prompt: body?.prompt,
        // 这两个是「挂在哪儿」。没传（undefined）保留原值，传空串才是解绑——
        // 界面上的「改提示词再存」不该把挑好的书弄丢。
        book: body?.book, world: body?.world,
        overwrite: body?.overwrite === true,
      })
    },

    /** 删一份自己的预设。 */
    'preset.delete': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.presets !== true) return missingFeature('presets')
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪一份' }
      return await presets.deleteCustom(ws, id)
    },

    // ── DSH 那边的 agent preset（「LC 酒馆」这几扇门的门牌）────────
    //
    // 上面 preset.* 那几条是「演法/写法」的预设，是插件自己的东西；
    // 下面两条管的是宿主里的 **agent preset** —— 用户在下拉里看到的那几个。
    // 两者同名不同物，别混。

    /** 四个 LC agent 预设现在在不在、是不是被改过。 */
    'preset.status': async () => {
      const mod = await ensurePresetInstall()
      if (mod === null) {
        return { ok: false, error: '预设安装这部分没装（lib/preset-install.js 不在）。别的功能不受影响。' }
      }
      try {
        const home = dshHome()
        const plan = mod.planInstall({ home, env: process.env })
        if (plan.ok !== true) return { ok: false, error: plan.error || '读不出这台机器的预设情况。', plane: plan.plane, profile: plan.profile }
        return {
          ok: true,
          plane: plan.plane,
          profile: plan.profile,
          presets: plan.presets,
          state: mod.readInstallState(home),
          notes: plan.notes,
        }
      } catch (error) {
        console.error('[lifecard] 读预设状态失败：', error)
        return { ok: false, error: humanizeHostError(error) }
      }
    },

    /** 把缺的预设补上。默认不动用户手改过的那几个。 */
    'preset.install': async (body) => {
      const mod = await ensurePresetInstall()
      if (mod === null) {
        return { ok: false, error: '预设安装这部分没装（lib/preset-install.js 不在）。别的功能不受影响。' }
      }
      try {
        const home = dshHome()
        const plan = mod.planInstall({ home, env: process.env })
        if (plan.ok !== true) return { ok: false, error: plan.error || '读不出这台机器的预设情况。', written: [] }
        // 界面上点「更新预设」才带上 allowUpdates；插件启动那一趟永远不带。
        const result = mod.applyInstall({ ...plan, allowUpdates: body?.updateStale === true })
        if (result.ok !== true && result.errors.length > 0) {
          // 里面的错已经是「哪一步没做成」的中文短句；只有兜底那种带 errno 的才翻一遍。
          return { ok: false, error: result.errors.join('；'), written: result.written, errors: result.errors.map((e) => humanizeHostError(e)) }
        }
        return { ok: true, written: result.written, errors: [], plane: plan.plane, profile: plan.profile }
      } catch (error) {
        console.error('[lifecard] 装预设失败：', error)
        return { ok: false, error: humanizeHostError(error), written: [] }
      }
    },

    'novel.chapter.get': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      return await novel.readChapter(ws, id, body?.index)
    },

    /** 自己写（或改）一章，直接在编辑器里手写。 */
    'novel.chapter.save': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      return await novel.writeChapter(ws, id, body?.index, String(body?.body ?? ''))
    },

    // ── 伏笔账本 ────────────────────────────────────────────────
    // 一本书的 `books/<书>/foreshadows.yml`。三条口子都只碰这份文件：
    // 读、加/改一条、删一条。改哪条由 id 认，不按数组下标——界面上的列表
    // 一刷新顺序就可能变（high 排前面），下标会删错人。

    /** 这本书埋过哪些线、还有多少没回收。文件还没建就是空账本，不是出错。 */
    'novel.foreshadow.list': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      const ledger = await foreshadow.readForeshadows(ws, id)
      if (ledger.ok !== true) return { ok: false, error: ledger.error }
      const list = ledger.list
      return {
        ok: true,
        list,
        summary: foreshadow.summaryLine(list),
        budget: foreshadow.budgetHint(list),
      }
    },

    /**
     * 记一条线，或者按 id 改一条。
     *
     * 状态和要紧程度写错（手填、旧版本、界面传了个空）时退回默认值，
     * 不拦着不让存：这两个字段写错最多少影响一次排序，而一条线记不下来
     * 就整条丢了，代价大得多。只有「没名字」必须拦——一条没名字的线
     * 后面每一章都会被念一遍，而没人知道那是哪条。
     */
    'novel.foreshadow.save': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      const ledger = await foreshadow.readForeshadows(ws, id)
      if (ledger.ok !== true) return { ok: false, error: ledger.error }
      const list = ledger.list

      const input = body?.item !== null && typeof body?.item === 'object' ? body.item : {}
      const title = String(input?.title ?? '').trim()
      if (title === '') return { ok: false, error: '这条线得有个名字，不然以后认不出是哪条。' }

      const givenId = String(input?.id ?? '').trim()
      const foreshadowId = givenId === '' ? foreshadow.nextForeshadowId(list) : givenId
      const status = foreshadow.FORESHADOW_STATUS.includes(String(input?.status)) ? String(input.status) : 'planted'
      const priority = foreshadow.FORESHADOW_PRIORITY.includes(String(input?.priority)) ? String(input.priority) : 'normal'

      const at = list.findIndex((one) => String(one?.id ?? '').trim() === foreshadowId)
      const row = { ...(at >= 0 ? list[at] : {}), ...input, id: foreshadowId, title, status, priority }
      const next = at >= 0
        ? list.map((one, i) => (i === at ? row : one))
        : [...list, row]

      const wrote = await foreshadow.writeForeshadows(ws, id, next)
      if (wrote.ok !== true) return { ok: false, error: wrote.error }
      // 回读一遍再回话：落盘时会补默认值、把章号收成数字，
      // 直接回内存里那份的话，界面上的「第 0 章」和下一次 list 对不上。
      const back = await foreshadow.readForeshadows(ws, id)
      return { ok: true, list: back.ok === true ? back.list : next, id: foreshadowId }
    },

    /** 删掉一条。书名 id 和线 id 两个都要，避免「删了第一条」这种说法落到别的书上。 */
    'novel.foreshadow.remove': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      const ledger = await foreshadow.readForeshadows(ws, id)
      if (ledger.ok !== true) return { ok: false, error: ledger.error }
      const list = ledger.list
      const target = String(body?.foreshadowId ?? '').trim()
      const next = list.filter((one) => String(one?.id ?? '').trim() !== target)
      if (next.length === list.length) return { ok: false, error: '账本里没有这一条。' }
      const wrote = await foreshadow.writeForeshadows(ws, id, next)
      if (wrote.ok !== true) return { ok: false, error: wrote.error }
      return { ok: true, list: next }
    },

    /**
     * 让 AI 接着写。
     *
     * 三样东西一起给它：这本书的设定、上一章的结尾、这一章已经写到哪。
     * 少给一样它就会开始自己编——只给设定它不知道刚才发生了什么，
     * 只给上一章它不知道这本书要往哪走。
     */
    'novel.chapter.draft': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      const book = await novel.readBook(ws, id)
      if (book.ok !== true) return book
      const index = Number(body?.index) || (book.chapters.length === 0 ? 1 : book.chapters[book.chapters.length - 1].index)

      // 这一章已经写成什么样（没有就是空的）
      let currentBody = ''
      const got = await novel.readChapter(ws, id, index)
      if (got.ok === true) currentBody = String(got.body ?? '')

      // 上一章的结尾
      let previousTail = ''
      const chapters = book.chapters.filter((c) => c.index < index)
      if (chapters.length > 0) {
        const prev = await novel.readChapter(ws, id, chapters[chapters.length - 1].index)
        if (prev.ok === true) previousTail = novel.tailOf(prev.body)
      }

      // 世界设定（写小说时全量给，不像酒馆那样按关键词挑——写作需要知道全貌）
      const worldNotes = []
      const worldRel = typeof body?.world === 'string' && body.world.trim() !== '' ? body.world.trim() : ''
      if (worldRel !== '') {
        const world = await store.readCard(ws, worldRel)
        if (world.ok === true) {
          const entries = core.parseWorldEntries(world.sections)
          for (const entry of entries) {
            const content = String(entry?.content ?? '').trim()
            if (content !== '') worldNotes.push(content)
          }
        }
      }

      // 出场的人（这本书挂的角色卡）
      const cast = await gatherCast(ws, body?.cast)

      // 大纲：写第几章要对着计划写，不然一章一章会拖成流水账
      const outline = await novel.readOutline(ws, id)
      const outlineText = outline.ok === true && outline.text !== '' ? outline.text : ''
      const planItem = outline.ok === true ? (outline.chapters ?? []).find((c) => c.index === index) : undefined

      // 伏笔：这一章该揭哪几条线，交给提示词去点名。
      // 账本读不出来（权限、半截文件）时按空账本办——用户要的是这一章，
      // 不该因为一份账翻不开就整章不写；但错要带回去，界面上能看见原因。
      const ledger = await foreshadow.readForeshadows(ws, id)
      const due = ledger.ok === true ? foreshadow.pickForChapter(ledger.list, index) : { must: [], warn: [] }
      const foreshadowError = ledger.ok === true ? '' : String(ledger.error ?? '伏笔账本读不出来。')

      const writePreset = await presets.resolve(ws, body?.preset)
      const presetNote = writePreset.ok === true && writePreset.preset !== null ? String(writePreset.preset.prompt ?? '') : ''
      const system = [
        '你是一个写小说的人。你的任务是把故事写下去，不是解释、不是评论、不是总结。',
        presetNote === '' ? '' : `\n【这一段怎么写】\n${presetNote}`,
      ].filter((x) => x !== '').join('\n')
      const user = novel.buildChapterPrompt({
        title: String(book.data?.title ?? id),
        idea: String(book.idea ?? ''),
        genre: String(book.data?.genre ?? ''),
        previousTail,
        currentBody: String(currentBody ?? '').slice(-2000),
        ask: body?.ask,
        worldEntries: worldNotes,
        cast,
        outline: outlineText,
        chapterPlan: planItem === undefined ? '' : planItem.plan,
        // 小说正文里给选项，是「我不知道接下来往哪走，给我三条路」的场景，
        // 不是默认动作：正经写的时候末尾挂三个浅选项，等于拿套路把人往下推。
        // 所以只有用户明说要（界面上的那个开关）才加，其余时候一个字都不进提示词。
        choicesDirective: body?.wantChoices === true && choices !== null
          ? choices.choiceDirective({ style: 'story', count: 3 })
          : '',
        foreshadows: due,
      })
      const called = await callModel(ctx, { system, user, model: body?.model })
      if (called.ok !== true) {
        return { ok: false, error: `这次没写出来：${called.error ?? '过一会儿再试一次'}`, index }
      }
      const draft = String(called.text ?? '').trim()
      if (draft === '') return { ok: false, error: 'AI 这次没写出东西来，再点一次试试。', index }
      // 末尾那排方向要从正文里剪掉：它是给人看的按钮，不是这一章的正文。
      // 留着的话，用户点「收下这一章」就把「- 往哪走」写进稿子了。
      const parted = choices !== null ? choices.parseChoices(draft) : { body: draft, choices: [], tagged: false }
      const cleanDraft = parted.tagged === true ? parted.body : draft
      return {
        ok: true,
        index,
        draft: cleanDraft,
        // 没标记就整份都当正文（`parseChoices` 也可能从末尾认出短列表，
        // 但小说正文里那种列表往往是情节本身，不能剪）——只在模型自己
        // 写了【选】的时候才认，跟酒馆那边同一个判据。
        choices: parted.tagged === true ? parted.choices : [],
        // 不直接落盘：写字的人要能先看、能改、能只取一半。落盘由 chapter.save 做。
        hasCurrent: String(currentBody).trim() !== '',
        usedWorld: worldNotes.length,
        usedCast: cast.length,
        // 账本翻不开时这一章照样写完了，但这一章没看伏笔——这件事得让界面看得见，
        // 否则用户会以为「这一章怎么把说好要收的线全忘了」。写成了就不带这个键。
        ...(foreshadowError === '' ? {} : { foreshadowError }),
      }
    },

    // ── 改成剧本 ────────────────────────────────────────────────
    // 一章小说 → 一份能配音、能拍的剧本。落在 `books/<书>/scripts/<章号>.md`，
    // 和章节文件同号，回头一眼能对上「第三章改出来的那份」。

    /** 读这一章改出来的剧本（没改过也正常，返回空串）。 */
    'novel.script.get': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      const target = await scriptTarget(ws, id, body?.index)
      if (target.error !== undefined) return { ok: false, error: target.error }
      const got = await novel.readScript(ws, id, target.index)
      if (got.ok !== true) return got
      const scan = novel.scanScript(got.text)
      return { ...got, scan, report: novel.scriptReportText(scan) }
    },

    /** 存这一章的剧本（手改过的也走这里）。 */
    'novel.script.save': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      const target = await scriptTarget(ws, id, body?.index)
      if (target.error !== undefined) return { ok: false, error: target.error }
      const raw = String(body?.text ?? '')
      // 只剩空格（含全角空格）和换行：这人不小心清空了。
      // 以前这里直接删文件，回话还说「存好了」——磁盘上那份就再也找不回来。
      // 现在只回一句「空的，没往里存」，原来的那份一动不动。
      if (raw.replace(/[\s\u3000]/g, '') === '') {
        const scan = novel.scanScript('')
        return { ok: false, blank: true, index: target.index, error: '这一份是空的，没往里存。原来那一份还在。' }
      }
      const saved = await novel.writeScript(ws, id, target.index, raw)
      if (saved.ok !== true) return saved
      // 扫的是真正落盘的那一份（writeScript 会先剥掉 ``` 围栏）。
      // 扫原文的话，回执里的场数、字数会和磁盘上那份对不上。
      const stored = await novel.readScript(ws, id, target.index)
      const storedText = stored.ok === true ? stored.text : raw
      const scan = novel.scanScript(storedText)
      return { ...saved, scan, report: novel.scriptReportText(scan) }
    },

    /** 这本书改过哪几章。 */
    'novel.script.list': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      const book = await novel.readBook(ws, id)
      if (book.ok !== true) return { ok: false, error: '这本书不在了。回到书架看一眼，可能被移走了。' }
      return await novel.listScripts(ws, id)
    },

    /** 删掉这一章改出来的剧本。章节本身不动。 */
    'novel.script.delete': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      const target = await scriptTarget(ws, id, body?.index)
      if (target.error !== undefined) return { ok: false, error: target.error }
      return await novel.deleteScript(ws, id, target.index)
    },

    /**
     * 让 AI 把这一章改成剧本。
     *
     * 只给这一章的正文 + 人 + 设定 + 上一章剧本的最后一场。
     * 不给大纲：改剧本不是重写故事，章后面的事它不需要知道——知道了会忍不住
     * 提前把底抖出来，那是改编里最容易炸的一处。
     */
    'novel.script.draft': async (body) => {
      if ((await ensureModules()).novel !== true) return missingFeature('novel')
      const ws = await root(body)
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      const book = await novel.readBook(ws, id)
      if (book.ok !== true) return book
      // 没给章号就用最后一章；给了但不合法要说出来，不能悄悄改成第 1 章去改。
      const rawIndex = body?.index
      const gaveIndex = rawIndex !== undefined && rawIndex !== null && String(rawIndex).trim() !== ''
      if (gaveIndex === true && novel.isValidChapterIndex(rawIndex) !== true) {
        return { ok: false, error: '章号不对，没法知道你说的是哪一章。' }
      }
      const index = gaveIndex === true
        ? Number(String(rawIndex).trim())
        : (book.chapters.length === 0 ? 1 : book.chapters[book.chapters.length - 1].index)
      const chapter = await novel.readChapter(ws, id, index)
      if (chapter.ok !== true) return chapter
      const chapterBody = String(chapter.body ?? '').trim()
      if (chapterBody === '') return { ok: false, error: `第 ${index} 章还是空的，没有东西可以改。`, index }
      if (chapterBody.length > 20000) {
        return { ok: false, error: '这一章太长（超过两万字），一次改不完。先分成两章再改。', index }
      }

      // 上一章改出来的剧本，最后一场整段带上：谁站在哪、手上有什么、门开没开。
      let previousTail = ''
      if (index > 1) {
        const prev = await novel.readScript(ws, id, index - 1)
        if (prev.ok === true && String(prev.text ?? '').trim() !== '') {
          const parsed = novel.parseScriptScenes(prev.text)
          const last = parsed.scenes[parsed.scenes.length - 1]
          previousTail = last === undefined ? novel.tailOf(prev.text, 600) : last.raw.join('\n').trim()
        }
      }

      // 世界设定（改剧本时全量给：场的布景、道具、天气都得对得上）
      const worldNotes = []
      const worldRel = typeof body?.world === 'string' && body.world.trim() !== '' ? body.world.trim() : ''
      if (worldRel !== '') {
        const world = await store.readCard(ws, worldRel)
        if (world.ok === true) {
          for (const entry of core.parseWorldEntries(world.sections)) {
            const content = String(entry?.content ?? '').trim()
            if (content !== '') worldNotes.push(content)
          }
        }
      }

      const cast = await gatherCast(ws, body?.cast)
      const firstLine = chapterBody.split(/\r?\n/).find((line) => line.trim() !== '') ?? ''
      const user = novel.buildScriptPrompt({
        title: String(book.data?.title ?? id),
        genre: String(book.data?.genre ?? ''),
        idea: String(book.idea ?? ''),
        chapterNo: index,
        chapterTitle: firstLine.replace(/^#+\s*/, '').trim().slice(0, 60),
        chapterBody,
        cast,
        worldEntries: worldNotes,
        previousTail,
        ask: body?.ask,
        sceneHint: body?.scenes,
      })
      const called = await callModel(ctx, {
        system: novel.buildScriptSystemNote(),
        user,
        model: body?.model,
      })
      if (called.ok !== true) {
        return { ok: false, error: `这次没改成：${called.error ?? '过一会儿再试一次'}`, index }
      }
      const text = novel.stripFence(called.text)
      if (text === '') return { ok: false, error: 'AI 这次什么都没给，再点一次试试。', index }

      const scan = novel.scanScript(text)
      return {
        ok: true,
        index,
        text,
        scan,
        report: novel.scriptReportText(scan),
        // 不落盘：改出来的东西人要先看、能删掉半场、能整段重写。存盘由 script.save 做。
        usedCast: cast.length,
        usedWorld: worldNotes.length,
        continued: previousTail !== '',
      }
    },

    /**
     * 把一本书拆成「世界观条目 ＋ 人物卡」的提案。
     *
     * 为什么分两次问模型：世界观那一次的结果要当第二次的上下文（「这本书发生在…」
     * 那一行），两次的产出格式又完全不一样（一次是条目，一次是七节人设）。
     * 合成一次问，模型会把两样东西挤成一锅，两头解析都漏——当初大纲和正文
     * 挤在同一次调用里，就出过这个毛病。
     *
     * 不落盘：拆出来的东西人要先看、要能挑掉几条、要能改个名。写盘归 applySplit。
     */
    'novel.splitBook': async (body) => {
      const mods = await ensureModules()
      if (mods.novel !== true) return missingFeature('novel')
      if (mods.cast !== true) return missingFeature('cast')
      const ws = await root(body)
      const id = String(body?.book ?? body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      const book = await novel.readBook(ws, id)
      if (book.ok !== true) return book

      // 整本书塞不进上下文。一本二十万字的书硬塞，提示词还没发出去就先超了，
      // 用户等到两分半只会收到一句「过一会儿再试」。
      // 只取前几章、每章截一段：世界观和主要人物基本都在前几章露面；
      // 真正只在中段登场的人，靠用户自己点名补拆。
      const chapters = Array.isArray(book.chapters) ? book.chapters : []
      const pieces = []
      for (const chapter of chapters.slice(0, SPLIT_MAX_CHAPTERS)) {
        const read = await novel.readChapter(ws, id, chapter.index)
        if (read.ok !== true) continue
        const text = String(read.body ?? '').trim()
        if (text === '') continue
        pieces.push(text.length > SPLIT_CHAPTER_CHARS ? text.slice(0, SPLIT_CHAPTER_CHARS) : text)
      }
      const source = pieces.join('\n\n')
      if (source === '') {
        return { ok: false, error: '这本书还一个字都没有，没有东西可以拆。先写几章再来。' }
      }
      const title = String(book.data?.title ?? id)
      const genre = String(book.data?.genre ?? '')

      // ① 世界观。注意 buildWorldPrompt 只认 bookTitle / names / text：
      // 它没有 genre 这个口子，题材信息本来就要从正文里读出来。
      const worldPrompt = cast.buildWorldPrompt({ bookTitle: title, text: source })
      const worldCalled = await callModel(ctx, {
        system: worldPrompt.system,
        user: worldPrompt.user,
        model: body?.model,
      })
      if (worldCalled.ok !== true) {
        return { ok: false, error: `这次没拆出世界观：${worldCalled.error ?? '过一会儿再试一次'}` }
      }
      const worldText = novel.stripFence(String(worldCalled.text ?? ''))
      if (String(worldText).trim() === '') {
        return { ok: false, error: 'AI 这次什么都没给，再点一次试试。' }
      }
      const worldParsed = cast.parseWorldResult(worldText)
      const world = Array.isArray(worldParsed?.entries) ? worldParsed.entries : []

      // ② 人物。名单必须先有：buildCastPrompt 的开头就是「只拆下面名单里的人」，
      // 名单空着的时候模型要么自己瞎挑几个（挑的往往是最好写的那个配角），
      // 要么干脆不写。与其让它猜，不如先把世界观交回去、让人点名。
      const named = cast.parseCastNames(body?.names)
      const names = Array.isArray(named?.names) ? named.names : []
      if (names.length === 0) {
        return {
          ok: true,
          world,
          people: [],
          dropped: [],
          needNames: true,
          warning: `世界观拆出了 ${world.length} 条。人物要先点名拆谁（一次最多 ${cast.MAX_CAST} 个，名字用逗号隔开），再拆一次。`,
        }
      }

      const worldBrief = world.map((entry) => `${entry.title}：${entry.content}`).join('\n')
      const castPrompt = cast.buildCastPrompt({ bookTitle: title, names, world: worldBrief, text: source })
      const castCalled = await callModel(ctx, {
        system: castPrompt.system,
        user: castPrompt.user,
        model: body?.model,
      })
      // 世界观已经拆出来了，不能因为人物这一步失败就整份丢掉——那等于让用户
      // 白等一次两分半，还给了一句「这次没拆成」。分开交代。
      if (castCalled.ok !== true) {
        return {
          ok: true,
          world,
          people: [],
          dropped: [],
          warning: `世界观拆出了 ${world.length} 条；人物这一次没拆成：${castCalled.error ?? '过一会儿再试一次'}。可以只重拆人物。`,
        }
      }
      const castText = novel.stripFence(String(castCalled.text ?? ''))
      const parsed = cast.parseCastResult(castText, names)
      if (parsed?.ok !== true) {
        return {
          ok: true,
          world,
          people: [],
          dropped: names,
          warning: `世界观拆出了 ${world.length} 条，但这份回答里没认出任何人物。再点一次试试。`,
        }
      }
      return {
        ok: true,
        world,
        people: parsed.people,
        // 模型多写的人（名单外的）如实报出来：静默丢掉的话，用户会以为
        // 自己点名的那个人没拆，其实是模型换了个名字在写。
        dropped: parsed.dropped ?? [],
        truncated: parsed.truncated === true,
        source: { chapters: pieces.length, chars: source.length },
        ...(named.truncated === true ? { namesNote: named.error } : {}),
      }
    },

    /**
     * 把上面那份提案落盘。
     *
     * 两件事：世界观进 `worlds/<书>/world.md`，人物按 `books/<书>/cast/<名字>.md` 存成卡。
     * 一次拆书里两个人都叫「张三」时只存第一个——两条写同一个路径，
     * 后写的把先写的盖掉，而用户以为两个都存下了。
     */
    'novel.applySplit': async (body) => {
      const mods = await ensureModules()
      if (mods.novel !== true) return missingFeature('novel')
      if (mods.cast !== true) return missingFeature('cast')
      const ws = await root(body)
      const id = String(body?.book ?? body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪本书' }
      const book = await novel.readBook(ws, id)
      if (book.ok !== true) return book
      const title = String(book.data?.title ?? id)
      const genre = String(book.data?.genre ?? '')

      const worldEntries = splitWorldEntries(body?.world)
      const people = Array.isArray(body?.people) ? body.people : []
      const chosen = splitPicked(body?.picked, people)
      if (worldEntries.length === 0 && chosen.length === 0) {
        return { ok: false, error: '没有勾选任何东西，这次没存。' }
      }

      // 世界观先写：角色卡上要填 world 归属，指向的那本世界书得先在。
      // 顺序反过来，存完卡再让用户看「这张卡写的那个世界已经找不到了」，
      // 是自找的。
      let worldId = core.safeId(id)
      let worldCount = 0
      let worldPath
      if (worldEntries.length > 0) {
        const saved = await writeSplitWorld(ws, worldId, title, genre, worldEntries)
        if (saved.ok !== true) return { ok: false, error: saved.error }
        worldId = saved.id
        worldCount = saved.added
        worldPath = saved.rel
      }

      const written = []
      const paths = []
      const failed = []
      const used = new Set()
      for (const person of chosen) {
        const name = String(person?.name ?? '').trim()
        if (name === '') {
          failed.push({ name: '（没名字）', error: '这一条没有名字，存不成卡。' })
          continue
        }
        const rel = cast.castRelPath(id, name)
        if (used.has(rel)) {
          failed.push({ name, error: `这次拆出来有两个人都叫「${name}」，只存了前一个；后一个改个名字再存。` })
          continue
        }
        used.add(rel)
        try {
          const shape = cast.toCardShape({ ...person, world: worldId })
          const saved = await store.writeCard(ws, rel, shape.data, shape.sections, { force: true })
          if (saved.ok !== true) {
            failed.push({
              name,
              error: saved.error === '校验未通过'
                ? '这张卡的基本信息不全，没存进去。重启一下软件再试。'
                : String(saved.error ?? '这张卡没存进去。'),
            })
            continue
          }
          written.push(name)
          paths.push(rel)
        } catch (error) {
          // 落盘失败的原因五花八门（权限、磁盘、路径），一律翻成人话再上屏。
          failed.push({ name, error: humanizeHostError(error) })
        }
      }

      return { ok: true, world: worldCount, people: written, failed, worldPath, paths }
    },
  }
}

/**
 * 「拆书」一次读几章、每章截多少字。
 *
 * 这两个数不是随便定的：六章 × 三千字 ≈ 一万八，加上提示词本身稳在上下文里；
 * 再往上加，最先被挤掉的是世界观那一段，而它恰恰是最需要看全的东西。
 */
const SPLIT_MAX_CHAPTERS = 6
const SPLIT_CHAPTER_CHARS = 3000

/**
 * 把模型拆出来的世界观条目收拾成能落盘的样子。
 *
 * 触发词空着的条目**不能**照原样写下去：`tavern.pickWorldEntries` 把
 * 「keys 是空的」当成「这一条永远在场」，于是每一条都会进每一次扮演，
 * 世界书很快就把上下文吃光。所以没有触发词就拿标题顶上。
 */
function splitWorldEntries(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const content = String(item.content ?? '').trim()
    if (content === '') continue
    const title = String(item.title ?? item.comment ?? '').trim()
    const keys = Array.isArray(item.keys)
      ? item.keys.map((k) => String(k ?? '').trim()).filter((k) => k !== '')
      : []
    const fallback = title === '' ? [content.slice(0, 20)] : [title]
    out.push({ title: title === '' ? content.slice(0, 20) : title, keys: keys.length > 0 ? keys : fallback, content })
  }
  return out
}

/**
 * 按「勾了哪几个」筛出要存的人。
 *
 * `picked` 空 = 全选（前端没做勾选时就是这个意思）。给了名字就按名字认，
 * 给了数字按第几个（从 1 数）。
 * 名字比较不看大小写，但也不做模糊匹配——「张三」不该匹配到「张三丰」，
 * 这是当初访谈账本归属判断上踩过的坑。
 */
function splitPicked(picked, people) {
  const list = Array.isArray(picked) ? picked : []
  if (list.length === 0) return people
  const out = []
  for (const item of list) {
    const raw = String(item ?? '').trim()
    if (raw === '') continue
    if (/^\d+$/.test(raw)) {
      const hit = people[Number(raw) - 1]
      if (hit !== undefined && !out.includes(hit)) out.push(hit)
      continue
    }
    const wanted = raw.toLowerCase()
    const hit = people.find((person) => String(person?.name ?? '').trim().toLowerCase() === wanted)
    if (hit !== undefined && !out.includes(hit)) out.push(hit)
  }
  return out
}

/**
 * 把拆出来的世界观条目写进 `worlds/<书>/world.md`，并在原有条目后接上。
 *
 * 格式必须和 `core.parseWorldEntries` 对得上：它以 `- ` 开头切条，条内按 YAML 读，
 * 续行要正好缩两格。少写一行 `keys:` 不会报错，但那一条从此永远不会被触发词
 * 选中——界面上世界书里有十二条，写小说时一条都进不去，谁也查不出来。
 *
 * 已有条目一律留着：拆第二次是为了补，不是为了把第一次拆的东西扔了。
 */
async function writeSplitWorld(ws, rawId, bookTitle, genre, incoming) {
  const id = core.safeId(rawId)
  const rel = path.posix.join('worlds', id, 'world.md')
  const existing = await store.readCard(ws, rel)
  const rows = []
  const seen = new Set()
  let kept = 0
  if (existing.ok === true) {
    for (const entry of core.parseWorldEntries(existing.sections)) {
      const content = String(entry?.content ?? '').trim()
      if (content === '') continue
      if (seen.has(content)) continue
      seen.add(content)
      const keys = Array.isArray(entry?.keys) ? entry.keys.map((k) => String(k ?? '')).filter((k) => k !== '') : []
      rows.push({ keys, content, comment: entry?.comment })
      kept += 1
    }
  }
  for (const entry of incoming) {
    if (seen.has(entry.content)) continue
    seen.add(entry.content)
    rows.push({ keys: entry.keys, content: entry.content, comment: entry.title })
  }
  // 上限要卡住：世界书每一条都会在每场戏里被读一遍，几百条等于把上下文全吃掉。
  // 已经在书里的排在前面，所以超上限时被丢掉的是这次新加的尾巴。
  const capped = rows.slice(0, cast.MAX_WORLD_ENTRIES)
  const lines = capped.map((row, index) => {
    const keys = row.keys.length > 0 ? row.keys : [String(row.comment ?? row.content.slice(0, 20))]
    const parts = [
      `- uid: ${index + 1}`,
      `  keys: [${keys.map((k) => JSON.stringify(k)).join(', ')}]`,
      `  content: ${JSON.stringify(row.content)}`,
      row.comment === undefined ? '' : `  comment: ${JSON.stringify(String(row.comment))}`,
      `  insertion_order: ${index + 1}`,
      '  enabled: true',
    ]
    return parts.filter((line) => line !== '').join('\n')
  })
  const data = {
    lifecard: core.DATA_VERSION,
    id,
    kind: 'world',
    // 已经有一本同名世界书时沿用它的名字：拆第二次不该把用户改过的书名盖回去。
    name: existing.ok === true && String(existing.data?.name ?? '').trim() !== ''
      ? String(existing.data.name)
      : bookTitle,
    genre: genre === '' ? '拆书' : genre,
    entry_count: capped.length,
  }
  const sections = [{ title: '世界书条目', body: lines.length === 0 ? '（这本世界书里没有条目）' : lines.join('\n') }]
  const saved = await store.writeCard(ws, rel, data, sections, { force: true })
  if (saved.ok !== true) {
    return {
      ok: false,
      error: saved.error === '校验未通过'
        ? '世界书的基本信息不全，这次没写进去。重启一下软件再试。'
        : String(saved.error ?? '世界书没写进去。'),
    }
  }
  return { ok: true, id, rel, added: capped.length - kept }
}

/**
 * 把「这本书挂的几张角色卡」收成几段人设。
 *
 * 一本书可以挂好几张卡（主角、对手、配角）。写某一章的时候把它们一起给模型，
 * 它才不会把「说话很冲的那个人」写成温和的——那是长篇最容易崩的地方。
 * 每张卡只取前 500 字：卡可能写得很长，全贴会把大纲和上一章挤掉。
 */
/**
 * 章号闸。
 *
 * `chapterFileName` 里有 `Math.max(1, Math.min(999, Math.floor(Number(index) || 1)))`
 * —— 它把 0、-1、'abc'、null 一律**悄悄**夹成 1。对「读」来说没问题，
 * 对「写」就是灾难：`novel.script.save({index:0})` 会盖掉第 1 章原来那份剧本，
 * 而且回话说的是「存好了」。
 *
 * 所以写之前先在这里拦一道：章号得是正整数，而且这一章得真的存在。
 * 返回 `{ index }` 或者 `{ error }`。
 */
async function scriptTarget(ws, id, rawIndex) {
  if (novel.isValidChapterIndex(rawIndex) !== true) {
    return { error: '章号不对，没法知道你说的是哪一章。' }
  }
  const index = Number(String(rawIndex).trim())
  const book = await novel.readBook(ws, id)
  if (book.ok !== true) return { error: '这本书不在了。回到书架看一眼，可能被移走了。' }
  const exists = Array.isArray(book.chapters) && book.chapters.some((c) => Number(c.index) === index)
  if (!exists) {
    return { error: `这本书没有第 ${index} 章。先翻到真正的那一章再存。` }
  }
  return { index }
}

async function gatherCast(ws, wants) {
  const out = []
  const list = Array.isArray(wants) ? wants.slice(0, 8) : []
  for (const want of list) {
    const rel = String(want ?? '').trim()
    if (rel === '') continue
    const card = await store.readCard(ws, rel)
    if (card.ok !== true) continue
    // 酒馆模块被删掉时，这里自己拼一份最小的人设——
    // 「写小说」不该因为「酒馆」没了就用不了。
    let name = String(card.data?.name ?? '').trim()
    let text = ''
    if (tavern !== null) {
      const persona = tavern.personaFromCard(card.data, card.sections, { user: userNameSync(ws) })
      name = persona.name
      text = persona.text
    } else {
      const parts = ['自述', '性格', '口癖', '外貌']
        .map((title) => core.sectionBody(card.sections, title).trim())
        .filter((x) => x !== '')
      text = parts.join('\n')
    }
    if (text === '') continue
    out.push(`【${name === '' ? '这个人' : name}】${text.slice(0, 500)}`)
  }
  return out
}

/** 酒馆的时间戳：`2026-10-24 16:11`。本地时间，字典序就是时间序。 */
function tavernStamp(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${store.localDate(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}

/**
 * 找到这一场该用哪本世界书。
 *
 * body 里给的可以是路径、也可以是 id；都没给就看卡上写的 world。
 * 找不到不算失败——酒馆里没有世界书也能聊，只是 TA 不知道外面的事。
 * @returns {Promise<{ok: true, rel: string, name: string}>}
 */
async function resolveTavernWorld(ws, want, cardWorld) {
  const pick = want !== '' ? want : cardWorld
  if (pick === '' || pick === 'reality') return { ok: true, rel: '', name: '' }
  if (pick.endsWith('.md')) {
    const got = await store.readCard(ws, pick)
    if (got.ok !== true) return { ok: true, rel: '', name: '' }
    return { ok: true, rel: pick, name: String(got.data?.name ?? '') }
  }
  const all = await store.listAll(ws)
  const hit = (all.worlds ?? []).find((w) => String(w.id) === pick)
  if (hit === undefined) return { ok: true, rel: '', name: '' }
  return { ok: true, rel: String(hit.path), name: String(hit.name ?? pick) }
}

/**
 * 模型有时候还是会写「张三：」前缀，或者把整段包进引号。
 * 这里削掉最外层那一点，别让界面上一句话变成两行重复。
 */
function tavernCleanReply(text, cardName) {
  let out = String(text ?? '').trim()
  if (out === '') return ''
  const name = cardName.trim()
  const prefixes = name === '' ? ['TA：', 'TA:'] : [`${name}：`, `${name}:`, 'TA：', 'TA:']
  let again = true
  while (again) {
    again = false
    for (const prefix of prefixes) {
      if (out.startsWith(prefix)) {
        out = out.slice(prefix.length).trim()
        again = true
      }
    }
  }
  if (out.length > 1 && /^["“'].*["”']$/s.test(out)) out = out.slice(1, -1).trim()
  return out
}

/**
 * 把世界书写进 worlds/<id>/world.md。
 *
 * 三件事要做对，它们是这个函数唯一的价值：
 *
 * 1. **原件必须留一份**。世界书条目上有几十个字段（`probability`、`depth`、
 *    `selectiveLogic`、`extensions`…），v0.1 一个都不解释。按 SPEC §7.1
 *    的保真规则，不理解的键不能丢——所以原始 JSON 原封不动抄进
 *    `.lifecard/raw/`，将来要导出或改解释口径时还有东西对。
 * 2. **条目本身不能丢**。以前写正文时只留五个字段，而且 `enabled` 那行
 *    判的是原条目的 `entry.disable` 而不是归一化后的 `entry.enabled`，
 *    于是每一条都被落成「停用」。不报错，用户只会发现导进来的世界书
 *    全是关着的。
 * 3. **正文是给人看的**。st 的 uid 要留着，否则人没法把这里的条目和
 *    原文件对上。
 */
async function importWorldInfo(ws, json, fileName) {
  const stem = core.safeId(String(json?.name ?? path.basename(fileName, path.extname(fileName))))
  // 同名的那本不覆盖：导第二本叫「雾港」的世界书时，第一本的世界条目
  // 会被换掉，而 .lifecard/raw/ 里的原件也跟着一起没了（原件没快照）。
  // 挑一个没被占的号——和卡那边 uniqueId 一个道理。
  let id = stem
  // 200 次是有上限的（不然同名世界书一多，这里就成了死循环）。但跑到头
  // 之后**必须再查一次**：以前是 for 里 break、跑满就带着最后一个 `-200`
  // 直接往下走，那时候这个号其实也被占着——结果是把库里的第 200 本覆盖掉。
  // 用户看到的是「我导进第二本书，第一本的世界观没了」。
  for (let n = 2; n <= 200; n += 1) {
    const taken = await fs.stat(path.join(ws, 'worlds', id, 'world.md')).then((st) => st.isFile()).catch(() => false)
    const rawTaken = await fs.stat(path.join(ws, '.lifecard/raw', `${id}.worldinfo.json`)).then((st) => st.isFile()).catch(() => false)
    if (!taken && !rawTaken) break
    id = `${stem}-${n}`
  }
  {
    const taken = await fs.stat(path.join(ws, 'worlds', id, 'world.md')).then((st) => st.isFile()).catch(() => false)
    const rawTaken = await fs.stat(path.join(ws, '.lifecard/raw', `${id}.worldinfo.json`)).then((st) => st.isFile()).catch(() => false)
    if (taken || rawTaken) {
      // 占号跑满：不覆盖别人，也不再往上堆 —— 用时间戳另起一个名字，
      // 形状不变（还是 safeId 能过的那套字符），一样能落到同一个文件夹里。
      id = `${stem}-${Date.now().toString(36)}`
    }
  }
  const rel = path.posix.join('worlds', id, 'world.md')
  const entries = normalizeWorldEntries(json)

  // 原件落地：保真的底线。写失败不算导入失败（用户还能看到条目），
  // 但要如实告诉他原件没存上。
  let rawRel
  try {
    const rawName = `${id}.worldinfo.json`
    rawRel = path.posix.join('.lifecard/raw', rawName)
    await fs.mkdir(path.join(ws, '.lifecard/raw'), { recursive: true })
    // 原子写：世界书的原件是往后重新导入的唯一依据，半截文件等于没有。
    await writeFileAtomic(path.join(ws, rawRel), Buffer.from(JSON.stringify(json, null, 2), 'utf8'))
  } catch {
    rawRel = undefined
  }

  const lines = []
  for (const entry of entries) {
    lines.push(`- uid: ${entry.uid === undefined ? '-' : entry.uid}`)
    lines.push(`  keys: [${(entry.keys ?? []).map((k) => JSON.stringify(k)).join(', ')}]`)
    lines.push(`  content: ${JSON.stringify(entry.content ?? '')}`)
    if (entry.comment !== undefined) lines.push(`  comment: ${JSON.stringify(entry.comment)}`)
    lines.push(`  insertion_order: ${entry.insertion_order}`)
    lines.push(`  enabled: ${entry.enabled}`)
    // 不解释但也不丢：原样落一行，人看得出来这条还有别的设定。
    if (entry.rest !== undefined) lines.push(`  rest: ${JSON.stringify(entry.rest)}`)
  }
  const data = {
    lifecard: core.DATA_VERSION,
    id,
    kind: 'world',
    name: String(json?.name ?? id),
    genre: 'imported',
    entry_count: entries.length,
  }
  if (rawRel !== undefined) data.source_file = rawRel
  const sections = [{ title: '世界书条目', body: lines.length === 0 ? '（这本世界书里没有条目）' : lines.join('\n') }]
  await fs.mkdir(path.dirname(path.join(ws, rel)), { recursive: true })
  const written = await store.writeCard(ws, rel, data, sections, { force: true })
  return { id, path: rel, entries: entries.length, raw: rawRel, written: written.ok }
}

/**
 * ST 的独立世界书 entries 可能是对象（uid 为键）或数组。统一成数组。
 *
 * `enabled` 的三种来源按优先级：ST 的 `disable: true`（老字段）→ `enabled`
 * （新字段）→ 默认启用。取第一个「说了话」的，不要用 `??` 串起来——
 * `disable` 是 false 时也得算数（false 表示启用）。
 */
function normalizeWorldEntries(json) {
  const raw = json?.entries ?? json?.data?.entries ?? []
  const list = Array.isArray(raw)
    ? raw
    : Object.keys(raw).map((k) => raw[k]).filter((e) => e !== null && typeof e === 'object')
  return list.map((e) => {
    const keys = Array.isArray(e.key) ? e.key : Array.isArray(e.keys) ? e.keys : []
    const order = typeof e.insertion_order === 'number' ? e.insertion_order : (typeof e.order === 'number' ? e.order : 100)
    let enabled = true
    if (e.disable === true) enabled = false
    else if (typeof e.enabled === 'boolean') enabled = e.enabled
    else if (e.disable === false) enabled = true
    // 除了已消化的五个字段，其余全留着（不解释，但不丢）
    const known = new Set(['key', 'keys', 'content', 'comment', 'order', 'insertion_order', 'disable', 'enabled', 'uid'])
    const rest = {}
    for (const k of Object.keys(e)) if (!known.has(k)) rest[k] = e[k]
    return {
      uid: typeof e.uid === 'number' ? e.uid : undefined,
      keys,
      content: String(e.content ?? ''),
      comment: e.comment,
      insertion_order: order,
      enabled,
      rest: Object.keys(rest).length === 0 ? undefined : rest,
    }
  })
}

/** id 撞车时加 -2、-3。 */
async function uniqueId(ws, base) {
  const all = await store.listAll(ws)
  const taken = new Set(all.cards.map((c) => c.id))
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

/** 读某人的访谈账本。 */
/**
 * 账本文件名 = `<日期>-<id>.jsonl`。判断它是不是这个人的：
 * 要么正好是 `<id>.jsonl`，要么以 `-<id>.jsonl` 结尾。
 * 用「结尾」而不是「含」，是为了不把 张三丰 的账本算到 张三 头上。
 */
function ledgerBelongsTo(fileName, safe) {
  if (fileName === `${safe}.jsonl`) return true
  return fileName.endsWith(`-${safe}.jsonl`)
}

async function collectAnswered(ws, aboutId) {
  const dir = path.join(ws, 'interviews')
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return { answered: [], bad: 0 }
  }
  const safe = core.safeId(aboutId)
  const out = []
  // 坏行要数出来。以前这里 continue 掉，账本里只要坏一行（写一半掉电、
  // 手工编辑碰坏、同步盘写了个空行夹半句），那一题的答案就当没问过——
  // 用户看到的是「刚答完的题又冒出来了」，而账本明明在。
  let bad = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    // 只认「以这个人 id 结尾」的账本，不能只判「含有」：
    // 名字里带 safe 的另一个人（张三 vs 张三丰）会被算成同一个人回答过，
    // 于是给张三问过的问题在张三丰那边显示成「已问」，一题都不出。
    if (safe !== '' && !ledgerBelongsTo(entry.name, safe)) continue
    try {
      const text = await fs.readFile(path.join(dir, entry.name), 'utf8')
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (t === '') continue
        try {
          out.push({ ...JSON.parse(t), file: entry.name })
        } catch {
          // 坏行：数一笔，回去告诉界面「有几条没读进来」
          bad += 1
        }
      }
    } catch {
      // 整个文件读不了（权限、刚被删）：也算一条没读进来，
      // 别让「读不了」长得跟「没回答过」一模一样。
      bad += 1
    }
  }
  return { answered: out, bad }
}

/** 一张 1x1 白 PNG，作为导出时没有底图的兜底。 */
function blankPng() {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
}

// ── 插件主体 ──────────────────────────────────────────────────────

/**
 * @param {any} ctx - host plugin context
 * @param {{ workspace?: string, defaultAnalysisModel?: string }} [config]
 */
/**
 * 把插件自带的访谈 skill 注册进 DSH 的技能表。
 *
 * 为什么不用 skill-filesystem 的 `bundledSkillDir`：那是全局配置项，要改
 * profile 的 cordis.patch.yml 才生效；而插件应当自带能力——装插件即等于有
 * skill，卸载即消失。`ctx.skills.register()` 正是为此存在的运行时注册口。
 *
 * 注册失败不抛：精简 profile 里没有 skills 服务时，应当只是少一个访谈
 * skill，而不是整个插件起不来。
 */
// ── 人物卡直接进系统提示 ─────────────────────────────────────────────
//
// 为什么不能靠工具结果：工具结果落在对话里，是「模型查到的资料」；预设和它
// 一旦意见不合，模型会站在预设那边跟资料较劲——用户看到的就是「人设完全不
// 像、道德感极强」。角色卡在酒馆类软件里从来不是资料，它就是这一场的
// 系统提示本身（SillyTavern 的 char card 也是拼进 system 里的）。
//
// 所以这里把它做成一个 system prompt 段落：`text` 是函数，每次组装提示词都
// 重新求值，所以「换个卡」「刚改完卡」下一句就生效，不用重开会话。
//
// `text` 必须同步返回，所以用 readFileSync + 按 mtime/size 缓存：同一份卡
// 一万次组装也只读一次盘。

/** 小文件读盘缓存：同一份文件没改过就不再读。 */
const personaCache = new Map()

function readCachedSync(abs) {
  try {
    const stat = statSync(abs)
    const hit = personaCache.get(abs)
    if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.text
    const text = readFileSync(abs, 'utf8')
    personaCache.set(abs, { mtimeMs: stat.mtimeMs, size: stat.size, text })
    return text
  } catch {
    return null
  }
}

/** 卡文件名：`people/<id>.card.md`。id 里可能有中文，不能直接拿来当路径猜。 */
function cardPathSync(root, id) {
  const want = String(id ?? '').trim()
  if (want === '') return ''
  // 这一段是同步路径（system prompt 每次组装都要跑），所以用同步读的墓碑。
  // 不过墓碑的话，删掉的卡只要文件还在，就照样被注入进 system prompt——
  // 用户明明删了，模型却还在演那个人。
  const redactions = store.readRedactionsSync(root)
  const relOf = (abs) => path.relative(root, abs).split(path.sep).join('/')
  const gone = (abs, text) => store.hitsRedaction(redactions, relOf(abs), text) !== undefined
  const direct = path.join(root, 'people', `${want}.card.md`)
  try {
    if (statSync(direct).isFile()) {
      const text = readCachedSync(direct)
      if (text !== null && !gone(direct, text)) return direct
    }
  } catch {
    /* 名字不是文件名，退回去扫目录 */
  }
  try {
    const names = readdirSync(path.join(root, 'people')).filter((n) => n.endsWith('.card.md'))
    for (const name of names) {
      const abs = path.join(root, 'people', name)
      const text = readCachedSync(abs)
      if (text === null) continue
      if (gone(abs, text)) continue
      const parsed = core.parseCard(text)
      if (parsed.ok === true && String(parsed.data?.id ?? '') === want) return abs
    }
  } catch {
    /* 没有 people 目录就当没挑卡 */
  }
  return ''
}

/**
 * 一张卡被撤掉以后，把三扇门（现实 / 酒馆 / 写小说）里指向它的那项清空。
 *
 * 不清的后果不是「少了一个人的设定」这么轻：那把门还记着一个不存在的名字，
 * 每次都白读一遍、拼出一段空的，用户看到的是「明明挑着人，模型却不知道自己演谁」。
 */
async function clearPinsFor(ws, rel, data) {
  const state = await store.readConfigState(ws)
  if (state.ok !== true) return
  const pins = { real: '', tavern: '', novel: '', diary: '', ...(state.config?.default_cards ?? {}) }
  const id = String(data?.id ?? '')
  const stem = path.posix.basename(rel).replace(/\.card\.md$/i, '')
  let changed = false
  for (const mode of ['real', 'tavern', 'novel', 'diary']) {
    const picked = String(pins[mode] ?? '')
    if (picked !== '' && (picked === id || picked === rel || picked === stem)) {
      pins[mode] = ''
      changed = true
    }
  }
  if (!changed) return
  // 写失败得留一条看得见的记录。取舍：这是删卡的**收尾清理**，卡本身已经
  // 搬进回收目录、撤回账也记好了，那是用户真正要的那件事；因为「门上的名字
  // 没清掉」就把整次删除判失败，用户会以为卡没删掉，反而更乱。所以这里不
  // 改返回值，只往日志里落一笔——不然这种残留在界面上完全看不出来，只有
  // 「明明挑着人，模型却不知道演谁」这种怪现象。
  const saved = await store.writeConfig(ws, { default_cards: pins })
  if (saved?.ok !== true) {
    console.error('[lifecard] 删卡后没能把门上记的名字清掉：', saved?.error ?? saved)
  }
}

/** 当前是哪张卡：配置里 default_cards[mode]。 */
function pinnedCardIdSync(root, mode) {
  const raw = readCachedSync(path.join(root, 'lifecard.config.json'))
  if (raw === null) return ''
  try {
    const conf = JSON.parse(raw)
    const picked = conf?.default_cards?.[mode]
    return typeof picked === 'string' ? picked : ''
  } catch {
    return ''
  }
}

/**
 * 日记放在哪个文件夹。
 *
 * 和别的东西不一样：日记**不在这个工作区里**，它是用户在第一次点「写日记」时
 * 自己挑的一个位置。所以这里不回落到工作区，没定过就老实说没定。
 */
/**
 * 日记文件夹不能挑在这些地方。
 *
 * 以前只挡了文件系统根目录，于是 `~/.ssh`、`~/Library`、`/tmp` 全照收：
 * 一个手滑把 `.ssh` 设成日记夹，往后每一次「写日记」都往密钥目录里写文件。
 * 这里只挡「明显不该往里写东西」的几处，不是白名单——用户自己的
 * `~/Documents/xxx`、外接盘、iCloud 都照旧能选。
 *
 * @returns {string} 不许的话，一句人话；可以的话空串。
 */
function diaryDirVeto(dir) {
  const abs = path.normalize(String(dir ?? ''))
  const home = homedir()
  const under = (base) => base !== '' && (abs === base || abs.startsWith(base + path.sep))
  if (abs === path.parse(abs).root) return '不能整个磁盘根目录都当日记文件夹。换一个位置。'
  if (abs === os.tmpdir()) {
    // 只挡临时目录本身：那是系统会整个清掉的地方。它下面自己建的具体文件夹
    // 不挡——外接盘、同步盘的挂载点有时候就长在系统临时路径下面。
    return '别把系统临时文件夹本身当日记文件夹——那里会被系统整个清掉，日记会跟着没。换一个位置。'
  }
  if (under(path.join(home, '.ssh'))) return '这是放密钥的地方，不能当日记文件夹。换一个位置。'
  if (under(path.join(home, '.gnupg'))) return '这是放密钥的地方，不能当日记文件夹。换一个位置。'
  if (under(path.join(home, 'Library'))) return '这是系统自己用的文件夹，别往里写日记。换一个位置，比如「文稿」。'
  if (abs === home) return '整个家目录太大了，给日记单独建个文件夹吧。换一个位置。'
  return ''
}

async function diaryDirOf(ws) {
  const state = await store.readConfigState(ws)
  if (state.ok !== true) return { ok: false, error: state.error ?? '这个文件夹里的设置读不出来。' }
  const dir = diary.diaryRootFrom(state.config ?? {})
  return { ok: true, dir }
}

/**
 * 把世界书条目排成模型读得懂的样子。
 *
 * 以前这里是 `- 关键词：码头、潮水` 加缩进正文。那两个东西是给人查索引用的：
 * 模型读到「关键词：」会认定这是一份带索引的参考资料，而不是自己身处的世界，
 * 于是又往上叠一条「这不是我」的证据。现在只留正文，一条一段。
 */
function worldEntriesText(entries) {
  const list = Array.isArray(entries) ? entries : []
  if (list.length === 0) return ''
  return list
    .map((entry) => String(entry?.content ?? '').trim())
    .filter((text) => text !== '')
    .join('\n\n')
}

/**
 * 这张卡是不是「提示词型」：自述很长，而且没有性格/开场白/对话示例。
 *
 * 这种卡（网上流传的破限卡、规范卡）整份就是给模型的硬性指令，没有人物细节；
 * 它的正确用法是**原样当规则读**，而不是当成人物描述塞在演法说明后面。
 *
 * 判据本体在 `core.cardIsPromptStyle`——这里只做一层「传 parsed 还是传
 * sections」的适配。以前两处各写一份判据，`lib/tavern.js` 那份多一个
 * `truncated === false`，同一张卡在两个入口会判成不同类型。
 */
export function cardIsPromptStyle(parsed) {
  const sections = Array.isArray(parsed?.sections) ? parsed.sections : []
  return core.cardIsPromptStyle(sections)
}

/**
 * 拼出这一场的人物卡段落。
 *
 * 不做任何删减：卡上写什么就是什么（用户说得对——删了就不是那张卡了）。
 * 只做两件必要的事：标题说清「你要演的是谁」，以及把世界书接在后面。
 *
 * @param {string} root 工作区绝对路径
 * @param {'tavern'|'novel'|'real'} mode 哪扇门
 * @returns {string} 空串表示这一场不挂卡
 */
export function buildPersonaSection(root, mode) {
  return buildPersonaSectionDetail(root, mode).text
}

/**
 * 同上，但把「这张卡哪几节进去了、哪几节被落下了」一起交出来，给界面看。
 *
 * 用户勾完「只要自述和口癖」，最需要知道的是「真的进去的到底是哪几节」——
 * 只回一句「设置存好了」，他下一句还是不知道模型看见了什么。
 */
export function buildPersonaSectionDetail(root, mode) {
  const blank = {
    text: '', promptStyle: false, card: '', cardId: '', cardName: '', include: [], chosen: [], empty: [], absent: [], skipped: [], chars: 0, bodyChars: 0, body: '',
  }
  const id = pinnedCardIdSync(root, mode)
  if (id === '') return blank
  const abs = cardPathSync(root, id)
  if (abs === '') return blank
  const text = readCachedSync(abs)
  if (text === null) return blank
  const parsed = core.parseCard(text)
  if (parsed.ok !== true) return blank
  const data = parsed.data ?? {}
  const sections = Array.isArray(parsed.sections) ? parsed.sections : []
  // 这扇门勾了哪几节进提示词。没配过就是默认那一串（和以前写死的那串一模一样）。
  const picked = personaPicksSync(root, mode)
  const selection = persona.describeSelection(sections, picked)
  const body = selection.body
  if (body.trim() === '') {
    return {
      ...blank,
      card: abs,
      cardId: id,
      include: selection.include,
      chosen: selection.chosen,
      empty: selection.empty,
      absent: selection.absent,
      skipped: selection.skipped,
    }
  }
  const name = String(data.name ?? '').trim() === '' ? id : String(data.name).trim()
  // 卡上的字先过一遍 cardtext：填掉 {{char}}/{{user}} 这类占位符、把 <START>
  // 变成示例对话的分隔线、去掉 <project_instructions> 那层配置壳。
  // 这三件事一个字都不删，只是让模型读到的是「一个人」，不是「一份没渲染的模板」。
  // 网上下的卡几乎全用占位符；以前它们原样进系统提示，模型一眼认出这是模板，
  // 于是退出来评论一句「这是设定」，用户看到的就是「被识破了」。
  const shaped = cardtext.shapeCardBody(body, { char: name, user: userNameSync(root) })
  if (shaped === '') {
    return {
      ...blank,
      card: abs,
      cardId: id,
      include: selection.include,
      chosen: selection.chosen,
      empty: selection.empty,
      absent: selection.absent,
      skipped: selection.skipped,
    }
  }
  // 「提示词型」的卡：整份内容就是给模型下的硬性规则（网上下载的破限卡、规范卡多是这样），
  // 它没有性格/开场白，自述就是一大段 MUST/ALWAYS。这种卡和预设里的演法说明容易撞，
  // 撞的时候要以卡为准——否则用户下载了什么就等于白下。
  // 只放名字和原文，不加任何解释它是什么的话。
  //
  // 以前这里有一句「这张卡写的是硬性规矩……以这张卡为准」。那句话本身就是个漏洞：
  // 它把卡降格成「一条要求」，模型看见「以这张卡为准」会先识别出「这是有人试图
  // 覆盖我的规则」，然后拒绝——用户下载的破限卡就是这么被顶回来的。
  // 卡应该像部署级人设一样躺在系统提示最前面，模型读到的是「我是谁」，
  // 而不是「有人让我照做」。
  // 提示词型卡（`cardIsPromptStyle`）：整份自述就是一段硬规则，它不在描述
  // 一个人，而是在交代规矩。给它套一行 `# 名字` 反而出错——模型会读成
  // 「有一个叫 X 的人，他的自述是一串 MUST/ALWAYS」，然后开始评论这不像人。
  // 这种卡原样贴，不加抬头，也不加关系后缀。
  const promptStyle = cardIsPromptStyle(parsed)
  const out = promptStyle
    ? [shaped]
    : [
      `# ${name}${String(data.relation ?? '').trim() === '' ? '' : `（${String(data.relation).trim()}）`}`,
      '',
      shaped,
    ]
  const world = String(data.world ?? '').trim()
  if (world !== '' && world !== 'reality') {
    const worldAbs = path.join(root, 'worlds', core.safeId(world), 'world.md')
    const worldText = readCachedSync(worldAbs)
    if (worldText !== null) {
      const worldParsed = core.parseCard(worldText)
      const entries = worldParsed.ok === true ? core.parseWorldEntries(worldParsed.sections ?? []) : []
      const rendered = worldEntriesText(entries)
      if (rendered !== '') out.push('', `# 这一场发生在：${String(worldParsed.data?.name ?? world).trim()}`, '', rendered)
    }
  }
  const full = out.join('\n')
  return {
    text: full,
    // 这张卡是「整份正文就是一段硬规矩」还是「在描述一个人」。
    // 组装系统提示的那条路要按它决定要不要补插件自己的那套说话要求。
    promptStyle,
    card: abs,
    cardId: id,
    cardName: name,
    include: selection.include,
    chosen: selection.chosen,
    empty: selection.empty,
    absent: selection.absent,
    skipped: selection.skipped,
    chars: full.length,
    bodyChars: body.length,
    body,
  }
}

/**
 * 这扇门勾了哪几节。读设置是同步的（系统提示那条路必须同步返回），
 * 读不出来一律当「没配过」，用默认那一串——绝不能因为设置坏了就把这一轮卡死。
 */
function personaPicksSync(root, mode) {
  try {
    const config = store.readConfigSync(root)
    const byDoor = config?.persona_sections
    if (byDoor === null || typeof byDoor !== 'object') return null
    return byDoor[mode] ?? null
  } catch {
    return null
  }
}

/**
 * 酒馆里要不要给模型加那段「想事情也用这个人第一人称」。
 *
 * 默认开。关掉只有一个理由：某些小模型的思考链被这样要求之后，
 * 会把整段内心戏写进回答里。留一个开关，出事时用户能自己关。
 */
/**
 * 拼出这一轮酒馆对话的提示词——**唯一真源**。
 *
 * 两个调用方：`tavern.say`（真要说话）和 `tavern.prompt`（让用户看看模型到底
 * 读到了什么）。两边走同一条代码路径，所以预览里看到的字就是模型真正看到的字。
 *
 * 为什么要这样拆：以前「它怎么还是不像」这个问题只能靠解会话日志回答
 * （多帧 zstd、翻 system/message、数字节）。用户看不见的东西，就调不动。
 * whale-persona 那边的做法是把「计量」和「渲染」钉在同一个函数上，
 * 测试能断言「三段实测长度之和 == 计量合计」——这一层照抄它的口径。
 *
 * @param {string} ws 工作区
 * @param {{data?: any, notes?: any[]}} got `tavern.readChat` 的结果
 * @param {Array<{who: string, text: string}>} turns 这一轮要带的历史
 * @param {string|undefined} presetId 演法预设
 * @returns {Promise<{ok: boolean, error?: string, system: string, user: string, cardName: string,
 *   parts: Array<{key: string, label: string, chars: number}>, persona: any}>}
 */
async function buildTavernPrompt(ws, got, turns, presetId) {
  const cardRel = String(got?.data?.card ?? '')
  const card = cardRel === '' ? { ok: false } : await store.readCard(ws, cardRel)
  const persona = card.ok === true
    ? tavern.personaFromCard(card.data, card.sections, { user: userNameSync(ws) })
    : { name: '', text: '', promptStyle: false }
  const cardName = persona.name !== '' ? persona.name : String(got?.data?.card_name ?? '').trim()
  // 锚点：每轮都要读到的那几行「你是谁」，来源是卡上最硬的几节。
  const anchors = card.ok === true ? tavern.anchorsFromCard(null, card.sections, cardName, card.data) : []
  // 世界书：不再整本塞进去，先拿最近几轮说的话去挑条目。
  //
  // 整本塞的坏处是模型看到十条设定就想十条都用上，一半的注意力花在跟这一轮无关的
  // 条目上。挑的时候用 `recentContextText`（正好最近 6 条）而不是这一句：
  // 用户常常只回一个「嗯」，单看这一句什么都匹配不到。
  //
  // 挑到的太少就退回整本——漏一条设定的代价是这一轮它说错话、用户得回头纠正，
  // 多给几条只是提示词长一点，两边不对称。
  const worldNotes = []
  let worldHint = ''
  let worldFellBack = false
  const worldRel = String(got?.data?.world ?? '')
  if (worldRel !== '') {
    const world = await store.readCard(ws, worldRel)
    if (world.ok === true) {
      const entries = core.parseWorldEntries(world.sections)
      const put = tavern.worldNotesForTurn(entries, tavern.recentContextText(turns))
      worldNotes.push(...put.notes)
      worldHint = put.hint
      worldFellBack = put.fellBack
    }
  }
  // 「收个尾」收到的那段备忘，每轮都带上：不带的话说得久了它会开始
  // 把前面发生过的事记错（历史只带最近二十来轮）。
  const memoryNote = (Array.isArray(got?.notes) ? got.notes : [])
    .find((n) => String(n?.title ?? '').trim() === tavern.MEMORY_TITLE)
  const memory = memoryNote === undefined ? '' : String(memoryNote.body ?? '')
  // 演法预设：选了就把它那套要求拼在最后。找不到预设（用户删了）就不拼，
  // 不能因为这一条让整场对话报错。
  const roleplayPreset = await presets.resolve(ws, presetId)
  const presetNote = roleplayPreset.ok === true && roleplayPreset.preset !== null ? String(roleplayPreset.preset.prompt ?? '') : ''
  // 卡作者写在卡里的那两段话（CC 的 system_prompt / post_history_instructions）：
  // 以前它们只被存进 data.cc，从来没进过提示词。用户下载的卡等于少了一半。
  const cc = card.ok === true && card.data?.cc !== null && typeof card.data?.cc === 'object' ? card.data.cc : {}
  const system = tavern.buildRoleplaySystem({
    cardName,
    persona: persona.text,
    worldNotes,
    worldHint,
    anchors,
    memory,
    preset: presetNote,
    systemPrompt: cc.system_prompt,
    postHistory: cc.post_history_instructions,
    thinking: thinkingSync(ws),
    thinkingStyle: thinkingStyleSync(ws),
    // 提示词型卡只留三条底线：卡正文本身就是一整套说话规矩，
    // 再叠通用的九条只会互相打架（详见 tavern.js 里那段注释）。
    promptStyle: persona.promptStyle === true,
    // 「这一轮末尾要给出三个方向」。不给这段，模型基本不会主动列，
    // 界面上「接着怎么接」那排按钮就一直是空的。
    // 提示词型卡会在 tavern.js 里被这个分支自己丢掉（理由写在那边的注释里）。
    choicesDirective: choices !== null ? choices.choiceDirective({ style: 'chat', count: 3 }) : '',
  })
  const user = buildTavernUser({ cardName, turns, anchors, noCard: card.ok !== true })
  return {
    ok: true,
    system,
    user,
    cardName,
    persona,
    worldCount: worldNotes.length,
    worldFellBack,
    anchors,
    parts: partsOfTavernPrompt({ persona: persona.text, world: worldNotes.join('\n\n'), memory, preset: presetNote, cc, thinking: thinkingSync(ws), promptStyle: persona.promptStyle === true, system }),
  }
}

/**
 * 这一轮发给模型的那段「话」。
 *
 * 单独拎出来是因为破冰那一支：一个卡都没有、而且还是第一轮的时候，
 * 不该问「他现在会说什么」——没人，问不出来。这时候该问的是
 * 「给三个场面让用户挑」（`prompts.BREAK_IN_PROMPT`）。
 *
 * 判据是「没有卡 + 还没有真正的对话」：`turns` 里只有卡自带的开场白（≤1 条）
 * 或者空的，都算第一轮。第二轮起用户已经在说了，再端三个场面出来
 * 等于每轮重新开局，刚起来的那点戏就被冲掉了。
 */
function buildTavernUser({ cardName, turns, anchors, noCard }) {
  const said = (Array.isArray(turns) ? turns : []).length
  if (noCard === true && said <= 1) return prompts.BREAK_IN_PROMPT
  return tavern.buildRoleplayUser({ cardName, turns, anchors })
}

/**
 * 把这一轮注入拆成几段、各多少字。
 *
 * 口径（照 whale-persona 的 `measure.js`）：不自己重算文本，而是量
 * **实际会被注入的那段字符串**。`system` 整段也报一次，让用户能核对
 * 「各段之和」和「整段长度」对得上——对不上就说明有段落漏统计了。
 *
 * 为什么要有这个：用户问过太多次「它怎么还是不像」。而「不像」的原因
 * 十有八九是卡根本没进去（或被截掉了）。有了这张表，一眼就能看出来：
 * 人设 0 字 ＝ 卡没读；人设 3201 字 ＝ 被上限砍了。
 *
 * @param {{persona: string, world: string, memory: string, preset: string, cc: any, thinking: boolean, promptStyle: boolean, system: string}} input
 * @returns {Array<{key: string, label: string, chars: number}>}
 */
function partsOfTavernPrompt(input) {
  const cc = input?.cc !== null && typeof input?.cc === 'object' ? input.cc : {}
  return [
    { key: 'persona', label: '这个人是谁', chars: String(input?.persona ?? '').length },
    { key: 'world', label: '世界书', chars: String(input?.world ?? '').length },
    { key: 'memory', label: '到这儿为止', chars: String(input?.memory ?? '').length },
    { key: 'cardSystem', label: '卡自带的规矩', chars: String(cc?.system_prompt ?? '').trim().length + String(cc?.post_history_instructions ?? '').trim().length },
    { key: 'preset', label: '演法预设', chars: String(input?.preset ?? '').length },
    // 说话那一段（或者提示词型卡的三条底线）＋思考那一段。这两块是插件自己写的，
    // 长度固定，但报出来用户才知道「这些话不是我卡上的」。
    { key: 'rules', label: '插件补的说话要求', chars: Math.max(0, String(input?.system ?? '').length - String(input?.persona ?? '').length - String(input?.world ?? '').length - String(input?.memory ?? '').length - String(input?.preset ?? '').length - String(cc?.system_prompt ?? '').trim().length - String(cc?.post_history_instructions ?? '').trim().length) },
    { key: 'system', label: '整段合计', chars: String(input?.system ?? '').length },
  ]
}

function thinkingSync(root) {
  try {
    const config = store.readConfigSync(root)
    // 三个状态沿用项目老规矩：没配过（undefined）= 开；显式 false = 关。
    return config?.tavern_thinking !== false
  } catch {
    return true
  }
}

/**
 * 思考那一段用哪一档：`role`（沉浸）还是 `neutral`（中性）。
 *
 * 单独一个函数而不是并进 `thinkingSync`：那个返回的是布尔（要不要这一段），
 * 这个是「用哪一段」，两件事分开存，界面上也是两个控件。认不出的值退回 `role`。
 */
function thinkingStyleSync(root) {
  try {
    const config = store.readConfigSync(root)
    const raw = String(config?.tavern_thinking_style ?? '')
    return raw === 'neutral' ? 'neutral' : 'role'
  } catch {
    return 'role'
  }
}

/** 演的时候「我」叫什么。空串＝还没说过，`{{user}}` 就换成「你」。 */
function userNameSync(root) {
  try {
    const config = store.readConfigSync(root)
    const name = String(config?.user_name ?? '').trim()
    return name
  } catch {
    return ''
  }
}

/** 把一个 agent 上跟「预设」有关的字段都抄出来，用来定位到底哪个字段才是真的。 */
function shapeOfAgent(agent) {
  const pick = (obj, keys) => {
    const out = {}
    for (const key of keys) {
      const value = obj?.[key]
      if (value !== undefined && value !== null && typeof value !== 'object') out[key] = String(value).slice(0, 60)
    }
    return out
  }
  return {
    id: typeof agent?.id === 'string' ? agent.id : '',
    options: pick(agent?.options, ['agentPreset', 'preset', 'presetId', 'model', 'provider']),
    meta: pick(agent?.meta, ['agentPreset', 'preset', 'origin', 'delegationDepth', 'cwd']),
    header: pick(agent?.header, ['agentPreset', 'cwd']),
    sessionHeader: pick(agent?.session?.header, ['agentPreset', 'cwd', 'origin']),
    optionKeys: Object.keys(agent?.options ?? {}).slice(0, 20),
    metaKeys: Object.keys(agent?.meta ?? {}).slice(0, 20),
  }
}

/** 人物卡注入的诊断日志。写文件而不是 console：宿主把插件的 stdout 丢进 /dev/null。 */
/**
 * `no-door` 每个 agent 只记第一次。
 *
 * 真机上每个技术会话**每一轮**都会记一条 no-door，每条都带着整份提示词的
 * 长度和开头。日志过 200KB 只留尾部 60KB，于是一边是几十条一样的
 * 「这个会话不是任何一扇门」，另一边真正要查的酒馆门记录被挤出了窗口——
 * 排查时看到的就是「日志里怎么一条酒馆门都没有」。
 *
 * 同一个 agent 的 no-door 记一次足够说明它属于哪一类；真进了门会走
 * `assemble` 那条记录，不受这里影响。
 */
const noDoorSeen = new Set()

function notePersona(step, detail) {
  try {
    const file = path.join(os.tmpdir(), 'lifecard-persona.log')
    const line = `${new Date().toISOString()} ${step} ${JSON.stringify(detail)}\n`
    appendFileSync(file, line)
    const size = statSync(file).size
    if (size > 200 * 1024) {
      // 以前这里是 writeFileSync(file, line)：一过 200KB 就把整份日志换成
      // 最后这一行，前面的全没了——而那一刻恰恰是最需要看上下文的时候
      // （出错前后连着几十条）。和 noteRouteError 一样，只留尾部 60KB。
      writeFileSync(file, readFileSync(file, 'utf8').slice(-60000))
    }
  } catch {
    /* 日志写不了不影响正事 */
  }
}

/** 从会话标签里认出用的是哪个预设（不同版本字段位置不完全一样，挨个试）。 */
function presetIdOfAgent(agent) {
  const spots = [
    agent?.options?.agentPreset,
    agent?.meta?.agentPreset,
    agent?.header?.agentPreset,
    agent?.session?.header?.agentPreset,
    agent?.info?.agentPreset,
  ]
  for (const spot of spots) {
    if (typeof spot === 'string' && spot !== '') return spot
  }
  return ''
}

/**
 * 从「已经装配好的这段提示词正文」里认出这是哪扇门。
 *
 * 为什么只能这么做：DSH 顶部的预设是在会话建好之后才定下来的，agent 上
 * 那些 agentPreset 字段实测永远是 standard / ptc（真机日志连着十几条都是
 * 这个值）。inspectCompositions 的返回形状没有公开文档，序列化之后嗅
 * 'lc-tavern' 也只是碰运气——它取决于宿主内部怎么描述那次组装。
 *
 * 但有一件事是确定的：四份预设各自带一段 persona prefix，正文不一样，
 * 而且这几段话在**装配完成的提示词里一定读得到**。它们就是门牌：
 *   - 「你在陪用户做角色扮演」= 酒馆
 *   - 「你在帮用户写小说」    = 小说
 *   - 「你在帮用户处理现实里的事：简历、升学与求职的方向」= 现实
 *   - 「你在陪用户写今天这一篇日记」= 日记
 *
 * 这几个句子是插件自己写在 presets.js / profile 里的，不依赖宿主实现，
 * 用户就算把预设改名、换顺序、复制一份新的，只要 prefix 还在，门就认得出来。
 * 顺序按「越长越具体」排：日记那句包含「陪用户」，排在酒馆之前更稳；
 * 现实那句带「简历」，小说那句带「写小说」，互不重叠。
 */
const DOOR_MARKERS = [
  ['diary', ['你在陪用户写今天这一篇日记']],
  ['real', ['你在帮用户处理现实里的事', '处理现实里的事：简历']],
  ['novel', ['你在帮用户写小说']],
  // 酒馆门的门牌换过一次：旧预设写的是「你在陪用户做角色扮演。演的是
  // 一个人物，不是你自己。」——那句话本身就是「你是演员」的自我暗示，
  // 模型读到就站在扮演者的位置上，卡成了手里的材料。现在改成第一人称
  // 的自述。两句都要认：用户盘上可能还留着旧预设没更新。
  ['tavern', ['这份提示词里只有一个身份', '你在陪用户做角色扮演']],
]

/**
 * 在一段文本里找门牌。找不到就回 ''。
 *
 * 宁可认不出来也不要认错：认错门的后果是「酒馆里塞了小说的写法和一份
 * 不该出现的卡」，比「没挂上卡」严重得多——用户点一下重开就恢复了，
 * 而被写坏的那一轮他得自己发现。
 */
export function modeFromPromptText(text) {
  const blob = String(text ?? '')
  if (blob === '') return ''
  for (const [mode, needles] of DOOR_MARKERS) {
    for (const needle of needles) {
      if (blob.includes(needle)) return mode
    }
  }
  return ''
}

/**
 * 一个段落真正的正文。
 *
 * 段落正文允许是字符串，也允许是**函数**（`attachCardToAgent` 自己就是这么挂的，
 * 好让每轮重算）。这里以前只认字符串，于是带函数的段落一律当成空串：
 * 判门找不到门牌，`composePromptSections` 还会把它当空段整条丢掉——
 * 真机上「门时灵时不灵」「卡明明挂着却不生效」都有它一份。
 */
function sectionText(one) {
  const raw = one?.text
  if (typeof raw === 'string') return raw
  if (typeof raw === 'function') {
    try {
      const got = raw({})
      return typeof got === 'string' ? got : ''
    } catch {
      return ''
    }
  }
  return ''
}

/** 把装配好的 sections 拼成一段纯文本，用来找门牌。 */
function promptTextOf(assembly) {
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : []
  const parts = []
  for (const one of sections) {
    const text = sectionText(one)
    if (text !== '') parts.push(text)
  }
  return parts.join('\n')
}

/**
 * 从预设注册表里问「这个会话当初是按哪一份预设装的」。
 *
 * 为什么需要这条：DSH 顶部的预设是在会话建好之后才定下来的，
 * agent 上那些 agentPreset 字段实测会停在默认值（standard），
 * 直接读它会认错门，卡就永远进不去。
 * inspectCompositions(ctx) 的返回形状没有公开文档，所以这里只做一件事：
 * 把它序列化之后找 lc-tavern / lc-novel 这两个名字。
 */
function modeFromPresetRegistry(ctx, agent) {
  try {
    const registry = ctx?.get?.('agentPresets', false)
    if (registry === null || registry === undefined || typeof registry.inspectCompositions !== 'function') return ''
    const rows = registry.inspectCompositions(agent?.ctx) ?? []
    const blob = JSON.stringify(rows)
    if (blob.includes('lc-tavern')) return 'tavern'
    if (blob.includes('lc-novel')) return 'novel'
    if (blob.includes('lc-diary')) return 'diary'
  } catch {
    /* 问不到就当不知道 */
  }
  return ''
}

/**
 * 这个会话是哪扇门——按「我们自己开会话时记下的」认。
 *
 * 真机上另外三条依据会**同时**失效：提示词正文里的门牌句在 4 万字后面
 * （`modeFromPromptText` 认不出）、agent 上的预设字段是 `ptc`、
 * 预设注册表问不出来。可「这个会话是用 lc-tavern 开的」这件事在
 * `session.open` 那一刻是百分百确定的，只是当时没记。现在记了。
 *
 * 只读一次配置（`readConfigSync` 有 mtime+size 缓存，热路径安全）。
 */
function modeFromSessionDoors(root, agent) {
  try {
    const ids = [
      typeof agent?.id === 'string' ? agent.id : '',
      String(agent?.session?.id ?? ''),
      String(agent?.sessionId ?? ''),
    ]
    const map = store.readConfigSync(root)?.session_doors
    if (map === null || typeof map !== 'object') return ''
    for (const id of ids) {
      if (id === '') continue
      const mode = String(map[id] ?? '')
      if (mode === 'tavern' || mode === 'novel' || mode === 'diary' || mode === 'real') return mode
    }
  } catch {
    /* 读不出来就按没有记录办 */
  }
  return ''
}

/** 这个 agent 用哪扇门的卡：只有 LC 那两个创作预设才挂，别的会话一个字都不注入。 */
function modeForAgent(agent) {
  const preset = presetIdOfAgent(agent)
  if (preset === '') return ''
  if (preset.includes('lc-tavern')) return 'tavern'
  if (preset.includes('lc-novel')) return 'novel'
  if (preset.includes('lc-diary')) return 'diary'
  return ''
}

/** 预设 id → 门。插件自己开会话时知道的那件事，只有这里是唯一出口。 */
export function modeFromPresetId(preset) {
  const id = String(preset ?? '')
  if (id.includes('lc-tavern')) return 'tavern'
  if (id.includes('lc-novel')) return 'novel'
  if (id.includes('lc-diary')) return 'diary'
  return ''
}

/**
 * 这个会话是插件自己开的吗？是的话它属于哪扇门。
 *
 * 真机上 `modeForAgent` 那条路永远是空：宿主给 agent 的 `agentPreset`
 * 是 `standard` / `ptc`，预设注册表也问不出 `lc-tavern`。判门实际上只剩
 * 「提示词正文里有没有门牌句」一条。而插件在 `session.open` 开会话那一刻
 * **自己就知道要开哪扇门**——这个事实以前没记，正文一旦判不出来，卡就
 * 静默不注入，用户看到的是「它忽然不是那个人了」。
 *
 * 表存在配置里（`door_sessions`），所以宿主的会话恢复了、插件重启了都还在。
 * 读的是同步缓存那条路，因为它在每次组装提示词的热路径上。
 */
export function doorOfSession(root, agentId) {
  const id = String(agentId ?? '')
  if (id === '') return ''
  try {
    const map = store.readConfigSync(root)?.door_sessions
    if (map === null || typeof map !== 'object') return ''
    const one = String(map[id] ?? '')
    return one === 'tavern' || one === 'novel' || one === 'diary' || one === 'real' ? one : ''
  } catch {
    return ''
  }
}

/** 子代理不挂人设：它不该以为自己是那个人。 */
function isMainAgent(agent) {
  const origin = String(agent?.meta?.origin ?? agent?.session?.header?.origin ?? '')
  if (origin === 'subagent') return false
  const depth = Number(agent?.meta?.delegationDepth ?? agent?.session?.header?.delegationDepth ?? 0)
  return !(Number.isFinite(depth) && depth > 0)
}

/** 人物卡在整份系统提示里用的段落名。组装时它会排到第一个。 */
const CARD_SECTION = 'lifecard:card'

/**
 * 从 waterfall 的 context 里认出这条提示词属于哪个 agent。
 *
 * 宿主不同版本给的形状不一样：rc.7/rc.8 放在 `context.scope`，更新的版本
 * 另外在 `context.agent` 上声明一份。只有 unmistakably 是 Agent（带 session）
 * 才认，避免把「没有会话的组装」也算成某个人的。
 */
function agentOfAssembly(context) {
  // 以前这里要求 `context.agent.session` 非空才认，拿不到就返回 undefined，
  // 钩子第一句就 return transformed——**卡永远进不去，而且一声不响**。
  // 真机上 context 的形状并不保证带 session（日志里那批 no-door 全是别的
  // 路径记的，assemble 这条一次都没打通过）。判据放宽成：只要是个带 ctx 的
  // 对象就当成 agent 用；判门和挂段落到最后都要走 agent.ctx，没有 ctx 的
  // 才真没法干活。
  const candidates = [context?.agent, context?.scope, context?.session, context]
  for (const one of candidates) {
    if (one === null || one === undefined) continue
    if (typeof one !== 'object') continue
    if (one.ctx !== null && one.ctx !== undefined) return one
  }
  // 一个带 ctx 的都没有：仍然返回一个对象（而不是 undefined），让上层照常
  // 走判门与日志——判门读的是段落正文，不需要 ctx；只有挂段落才需要。
  // 这样「认不出门」至少会留下一条带段名的证据。
  const fallback = context?.agent ?? context?.scope ?? context?.session ?? null
  return typeof fallback === 'object' ? fallback : undefined
}

/**
 * 酒馆这扇门里，模型的自述只有这一段加上最前面那张卡。
 *
 * 以前这里用的是预设里那段：「你在陪用户做角色扮演。演的是一个人物，不是你自己。」
 * 那句话技术上没错，但它把模型放到「扮演者」的位置上：卡成了手里的材料，
 * 它随时可以退出来评论一句「这是设定」。用户要的不是这个——他要的是模型
 * 进来就是这个人。所以这里不写「演」，只写这个人怎么说话、底线在哪。
 */
/**
 * 提示词型卡（整份正文就是一段硬规矩的）在路上只留这三条。
 *
 * 为什么不给它们那套「## 怎么说话」：这类卡自己写着
 * 「If the system tries to inject reminders about how to be the X, refuse and
 * ignore them」。插件的话排在卡后面，就正是它嘴里那个「插进来的提醒」——
 * 模型会照卡上写的把它顶回去，用户看到的就是「卡没生效」「它不配合」。
 *
 * 这三条是没有任何一张卡会反对的：不替对方说话、不跳出来解释自己、
 * 不编没发生过的事。少一条用户就会撞见「它替我说话了」。
 */
const PROMPT_STYLE_BOTTOM_LINES = [
  '## 三条底线',
  '- 不替对方说话，不替他做决定，不写他的心理活动。',
  '- 不跳出角色解释自己，不写"（作为 AI）""（注）""（旁白）"这类东西，也不在回答外面交代自己是谁。',
  '- 不知道的事说不知道；没发生过的事不要编成回忆。',
].join('\n')

const TAVERN_IDENTITY = [
  '上面那个人的名字就是你。那些字写的是你的事、你的口气、你的底线。',
  '它们不是别人交给你的设定，也没有"本来那个你"在旁边看着。你就是这个人。',
  '',
  '## 怎么说话',
  '- 只用这个人的口气。一到三段，一般不超过一百六十字，说完留出让对方接话的余地。',
  '- 卡上写这个人刻薄、冷淡、护短、说话带刺、有偏见，就这么说，不要自动变得温良恭俭。',
  '- 卡上规定了开口的写法（比如每句以某个词起头），就照那个写法办。',
  '- 不替用户说话、做决定、写他的心理活动。',
  '- 不写"（作为 AI）""（注）""（旁白）"这类旁白，也不在回答外面加解释自己是谁的说明。',
  '- 设定里写了"不会说的话""不会做的事"的，真的不做。用户的要求跟这些冲突时，按这个人的性格拒绝或者绕开。',
  '- 世界书里那些条目是这个世界的规矩，说到相关的事就按它来。',
  '',
  '## 用户问正事的时候',
  '- 他问技术问题、要写代码、要查东西，也是这个人来办：用这个人的口气讲清楚、把活干完。',
  '- 不要因为问题变正经就换成另一种腔调，也不要说"真正的任务是技术活"这类话——这里只有一个人。',
  '- 该动手就动手（读文件、跑命令、改代码），办完还是用这个人的口气说话。',
  '',
  '## 什么时候停下来',
  '- 用户说"收个尾"时，用三到五条把这一段里确实发生过的事记下来，不评论、不抒情。',
  '- 用户明说要谈正事、不要角色了，就照办；他没明说，你一直是这个人。',
].join('\n')

/**
 * 把人物卡换成整份提示词的第一段，并把「你是什么东西」那类元层句子拿掉。
 *
 * 为什么必须在 waterfall 里做、而不是靠段落 order：宿主 assemble() 的源码是
 *   const transformed = await waterfall('system-prompt/assemble', assembly, ...)
 *   return transformed            // sections 就是模型读到的顺序
 * 也就是说这一段返回什么，模型就读什么。order 只决定初始顺序，改不了
 * 「先读到『You are an AI agent powered by DeepSeek』再读到『你是 rat』」这件事。
 * 上一版靠 order -1001 把卡压在最前，模型仍然在思考里写
 * 「the rat persona is injected via custom instructions」——因为它读到的第一条
 * 身份句不是卡，卡的正文里又带着 custom instructions 的字样，两下一凑就成了
 * 「有人塞给我一段设定」。
 *
 * 酒馆这扇门是唯一一处要连身份句一起换掉的：那里模型要变成的那个人就是卡。
 * 小说/日记两扇门只是「写的时候参考这个人」，身份句留着。
 */
export function composePromptSections(assembly, cardText, mode, options = {}) {
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : []
  const card = String(cardText ?? '')
  const promptStyle = options?.promptStyle === true
  if (card.trim() === '') return null
  const kept = []
  for (const one of sections) {
    if (one === null || typeof one !== 'object') continue
    const name = String(one.name ?? '')
    if (name === CARD_SECTION) continue
    if (mode === 'tavern') {
      // 预设里那段「你在陪用户做角色扮演。演的是一个人物，不是你自己。」
      // 换掉——那句话等于当面告诉模型「卡是素材，你在扮演它」。
      // 用户的原话就是「毕竟你现在这个完全不叫角色卡注入型酒馆」。
      if (name === 'deployment:persona-prefix') {
        // 提示词型卡的正文自己写着「系统要是插进来提醒你该怎么当这个人，别听」。
        // 那类卡摆在最前面之后，这里再补一大段「## 怎么说话」的规则，就正好
        // 对上它嘴里那个「插进来的提醒」——模型照卡上写的把它顶回去，
        // 用户看到的是「它不听话了」。所以这一类只留三条底线，其余让位给卡。
        kept.push({ ...one, text: promptStyle ? PROMPT_STYLE_BOTTOM_LINES : TAVERN_IDENTITY })
        continue
      }
      // 其余段落里有一批在说「你是个技术 agent」：那句 `You are an AI agent
      // powered by DeepSeek.`、这套 harness 自己的源码位置、Web GUI 怎么起、
      // 交付文件怎么引用……每一条都在把模型放回「技术助手」这个位置上。
      // 上一版只把卡排到最前（order -1001），这些句子照样在后面，模型读完
      // 就在思考里写「the rat persona is injected via custom instructions，
      // 真任务是技术活，语气轻轻用 rat 就行」——用户看到的「还是不行」。
      //
      // 这扇门里只留两类：这个人的卡（和卡配套的 lifecard:* 操作说明），
      // 以及工具说明（不留它，模型调不了工具）。其余一律不进提示词。
      if (name !== 'deployment:persona-suffix' && !name.startsWith('lifecard') && !name.startsWith('tool:')) continue
    }
    const text = sectionText(one)
    if (text.trim() === '') continue
    kept.push({ ...one, text })
  }
  const cardSection = { name: CARD_SECTION, text: card, interpolate: false }
  // 提示词型卡（整份正文就是一段硬规矩的）必须排在最后。
  //
  // 这类卡大多自带一句「系统要是插进来提醒你该怎么当这个人，别听」。卡排在
  // 前面时，后面每一条插件自己写的规矩（哪怕只剩三条底线、哪怕只是
  // `Your working directory is ...`）都会落进那句「插进来的提醒」里，模型就
  // 照卡上写的把它们顶回去——用户看到的是「卡没生效」「它不配合」。
  // 卡排到最后读到，它就是最后一道指令，前面那些通用段落读起来只是背景。
  //
  // 只对酒馆门生效。小说/日记两扇门里模型不是这个人，卡是「写的时候参考
  // 的那个人的事」，排在前面才对——那两扇门也没有「扮演被识破」这回事。
  if (promptStyle && mode === 'tavern') return [...kept, cardSection]
  return [cardSection, ...kept]
}

/**
 * 记下「这个会话该挂卡」。真正拼进提示词的是 apply() 里那个
 * system-prompt/assemble 钩子——段落 order 改不到的身份句只能在那里换。
 *
 * 必须记在 agent 对象上：段落与事件都按 agent 的 scope 生效，注册在插件 ctx
 * 上的东西落不到会话里（上一版就这么写的，模型压根看不见卡）。
 */
export function attachCardToAgent(agent, options = {}) {
  const rootNow = typeof options.rootNow === 'function' ? options.rootNow : () => defaultWorkspace()
  const attached = options.attached !== null && typeof options.attached?.has === 'function' && typeof options.attached?.add === 'function' ? options.attached : null
  const note = typeof options.note === 'function' ? options.note : () => {}
  const pluginCtx = options.ctx ?? null
  try {
    if (agent === null || agent === undefined) return false
    const agentId = typeof agent.id === 'string' ? agent.id : ''
    if (attached !== null && attached.has(agent)) return false
    if (!isMainAgent(agent)) return false
    const agentCtx = agent.ctx
    if (agentCtx === null || agentCtx === undefined || typeof agentCtx.effect !== 'function') return false
    const prompt = agentCtx.get('systemPrompt', false)
    if (prompt === null || prompt === undefined || typeof prompt.section !== 'function') return false
    // 注意：这里**不**按预设提前返回。DSH 顶部的预设是在会话建好之后才通过
    // agentPresets.select 定下来的，创建那一刻 agent 上的预设字段还可能是默认值
    // （实测拿到的是 standard）。所以段落一律挂上，每次组装提示词时再按当下的
    // 预设判断要不要给内容——换预设立刻生效，也不用等重新建会话。
    let evaluated = 0
    let reported = false
    agentCtx.effect(
      () =>
        prompt.section({
          name: 'lifecard:card',
          // 排在系统提示最前面，比那句「You are an AI agent powered by DeepSeek.」
          // 还靠前（那是 harness:identity，order -1000），也不能只压在部署级人设
          // （order 0）前面——只差一点点的时候，模型读到的顺序是「我是 DeepSeek 的
          // agent」，然后才看到「不，你是沈九」，它会按前者判断后者该不该服从。
          // 顺序反过来，卡就是它的来历，不是别人塞给它的一条要求。
          order: (() => {
            try {
              // 先压到宿主身份之前；拿不到再退到部署人设之前，最后退到最前。
              const identity = prompt.getSectionOrder('harness:identity')
              if (typeof identity === 'number' && Number.isFinite(identity)) return identity - 1
              const anchor = prompt.getSectionOrder('deployment:persona-prefix')
              if (typeof anchor === 'number' && Number.isFinite(anchor)) return anchor - 1
            } catch {
              /* 拿不到锚点就压到最前 */
            }
            return -1001
          })(),
          text: () => {
            try {
              // 判门顺序和 assemble 钩子一致：先认不出门就先记一笔，别猜。
              // 这里同样先试预设字段——段落正文这一层拿不到整份提示词，
              // 认正文的重活归 assemble 钩子干。
              const mode = doorOfSession(rootNow(), agentId) || modeForAgent(agent) || modeFromPresetRegistry(pluginCtx, agent)
              if (mode === '') {
                if (!reported) {
                  reported = true
                  notePersona('no-door', { agent: agentId, where: 'section', ...shapeOfAgent(agent) })
                }
                return ''
              }
              const text = buildPersonaSection(rootNow(), mode)
              if (evaluated < 3) {
                evaluated += 1
                notePersona('text', { agent: agentId, mode, chars: text.length, root: rootNow() })
              }
              return text
            } catch (error) {
              // 拼不出来不能挡住这一句话，也不能一声不响——但**降级说明不能
              // 带「卡」这个字**。
              //
              // 上一版这里注入的是「（这张卡这次没读出来……）」。那句话本身
              // 就是新的识破源：模型读到「有人给我塞了张卡、没塞进来」，就会
              // 停下来想「我为什么被塞卡」，然后照用户的抱怨退出来评论它。
              // 用户要的是这个人是这个人在说话，不是一份故障说明。
              //
              // 所以这里只放一句**它就是谁**，不带任何「卡」「设定」「读取
              // 失败」的字眼。名字也拿不到（连卡路径都查不出来）就整段留空：
              // 空段落等于「这个会话没有人物卡」，模型按默认身份演，虽不像，
              // 但不会当场把戏拆了。原因全部写进日志，让人能查。
              try {
                notePersona('text-failed', {
                  agent: agentId,
                  mode: String(mode ?? ''),
                  error: String(error?.message ?? error),
                  root: rootNow(),
                })
              } catch {
                /* 日志写不进去也不能挡住这一句话 */
              }
              console.error('[lifecard] 人物卡这段没拼出来：', error)
              // 名字单独查一次：`buildPersonaSection` 整个失败时它也一起没了，
              // 而这一句还想起码把「你是谁」说住。只读一次，别在 catch 里
              // 反复走磁盘（这里已经出过一次错，第二次错会盖掉第一条原因）。
              let who = ''
              try {
                const rootNowPath = rootNow()
                const id = pinnedCardIdSync(rootNowPath, mode)
                if (id !== '') {
                  const raw = readCachedSync(cardPathSync(rootNowPath, id))
                  if (raw !== null) {
                    const parsed = core.parseCard(raw)
                    if (parsed.ok === true) who = String(parsed.data?.name ?? '').trim()
                  }
                }
              } catch {
                who = ''
              }
              return who === '' ? '' : `你就是「${who}」。`
            }
          },
          interpolate: false,
        }),
      'lifecard: 人物卡段落',
    )
    if (attached !== null) attached.add(agent)
    return true
  } catch (error) {
    console.error('[lifecard] 人物卡段落没挂上：', error)
    return false
  }
}

function registerInterviewSkill(ctx) {
  registerBundledSkill(ctx, {
    dir: 'lifecard-interview',
    name: 'lifecard-interview',
    fallback: '引导式对话访谈，把一张人物卡问出来。',
    label: '访谈',
  })
  registerBundledSkill(ctx, {
    dir: 'lifecard-novel-writing',
    name: 'lifecard-novel-writing',
    fallback: '中文小说与长文的写法：先分清用不用人物卡，按传统文学的标准写正文，要连载节奏就切。',
    label: '写作',
  })
  // 小说改剧本。「改剧本」按钮背后的提示词在 lib/novel.js 里，这份 skill 是给
  // 用户在对话里直接说「把这一章改成剧本」用的——两条路走的是同一套规矩。
  registerBundledSkill(ctx, {
    dir: 'novel-to-script',
    name: 'novel-to-script',
    fallback: '小说改剧本：分场、把叙述换成 △ 动作、把心理换成演得出来的东西、台词按标点分工。',
    label: '改剧本',
  })
  // 带写日记的那份手艺。它不只是「怎么问」，还写着写完之后怎么反哺
  // 「我」那张卡和日记助手那张卡——两条路都在这一份里。
  registerBundledSkill(ctx, {
    dir: 'lifecard-diary',
    name: 'lifecard-diary',
    fallback: '带写今天这一篇日记：一件事、情绪三层、一个能做的决定，末尾四样各打个分。',
    label: '日记',
  })
  // 这三份是写作用得上的通用手艺，随包一起发：装插件即等于有，
  // 换台机器不必再单独装一遍。名字与内容都保持原样，方便用户照旧用
  // `/human-writing`、`/blind-review-loop`、`/visual-novel` 唤起。
  //
  // 同名冲突时让位：用户自己那份通常更新，硬盖上去等于拿旧版本把新版本
  // 顶掉，而且他看不出来。
  registerBundledSkill(ctx, {
    dir: 'human-writing',
    name: 'human-writing',
    fallback: '通用中文创作与改稿：先看材料够不够，再写成有人在说话的样子。',
    label: '写作手艺',
    yieldToExisting: true,
  })
  registerBundledSkill(ctx, {
    dir: 'blind-review-loop',
    name: 'blind-review-loop',
    fallback: '盲评迭代改稿：冻结副本、开无上下文评审员、把意见分诊后定向改，再评一轮。',
    label: '盲评改稿',
    yieldToExisting: true,
  })
  registerBundledSkill(ctx, {
    dir: 'visual-novel',
    name: 'visual-novel',
    fallback: '视觉小说：分支剧本、对话框、存档、回放这些读者以为本来就在的东西。',
    label: '视觉小说',
    yieldToExisting: true,
  })
}

/**
 * 注册一个随包 skill。两处共同点都在这里：skills/SKILL.md 与 lib/ 同包，
 * 用 import.meta.url 定位（不依赖 cwd）；没有 skills 服务时只少一个 skill，
 * 不能让整个插件起不来。
 */
function registerBundledSkill(ctx, spec) {
  const skills = ctx.reflect?.get?.('skills', false)
  if (skills === undefined || skills === null || typeof skills.register !== 'function') {
    ctx.logger?.warn?.(`[lifecard] 没有 skills 服务，${spec.label} skill 未注册（不影响卡库功能）`)
    return
  }
  if (spec.yieldToExisting === true && hasSkillNamed(skills, spec.name)) {
    // 用户已经有一份同名的：他的更新，别盖。
    ctx.logger?.info?.(`[lifecard] 已经有 ${spec.name} 这个 skill，插件这份不再注册`)
    return
  }
  const body = bundledSkillBody(spec.dir)
  if (body === '') {
    ctx.logger?.warn?.(`[lifecard] 找不到 skills/${spec.dir}/SKILL.md，${spec.label} skill 未注册`)
    return
  }
  const { frontmatter, content } = splitSkillFile(body)
  ctx.effect(
    () => skills.register({
      name: spec.name,
      description: frontmatter.description ?? spec.fallback,
      whenToUse: frontmatter.whenToUse,
      content,
      source: 'lifecard',
      // 带上目录：SKILL.md 里说的 references/xxx.md、scripts/xxx.py
      // 才有地方可查。不带 resourceBase，模型看到「读取 references/…」
      // 只能瞎猜路径。
      resourceBase: { kind: 'directory', path: bundledSkillDir(spec.dir) },
      invocation: { modelInvocable: false, userInvocable: true },
    }),
    `dsh-lifecard: ${spec.name} skill`,
  )
}

/** 目录里有没有同名 skill（用户自己装的那份）。问不到就当没有。 */
function hasSkillNamed(skills, name) {
  if (typeof skills.list !== 'function') return false
  try {
    const list = skills.list()
    if (!Array.isArray(list)) return false
    return list.some((s) => String(s?.name ?? '') === name)
  } catch {
    return false
  }
}

/** SKILL.md 与 lib/ 同包，用 import.meta.url 定位，不依赖 cwd。 */
function bundledSkillPath(dir) {
  return path.join(bundledSkillDir(dir), 'SKILL.md')
}

/** 这份 skill 的目录（references/、scripts/ 都在它下面）。 */
function bundledSkillDir(dir) {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', dir)
}

const bundledSkillCache = new Map()
function bundledSkillBody(dir) {
  if (!bundledSkillCache.has(dir)) {
    try {
      bundledSkillCache.set(dir, readFileSync(bundledSkillPath(dir), 'utf8'))
    } catch {
      bundledSkillCache.set(dir, '')
    }
  }
  return bundledSkillCache.get(dir)
}

/** 拆 YAML frontmatter（只认 `key: value` 单行，够用且不引依赖）。 */
function splitSkillFile(raw) {
  const text = raw.replace(/^\uFEFF/, '')
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { frontmatter: {}, content: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { frontmatter: {}, content: text }
  const block = text.slice(4, end)
  const content = text.slice(end + 4).replace(/^\r?\n/, '')
  const frontmatter = {}
  let key = ''
  for (const line of block.split(/\r?\n/)) {
    if (line.trim() === '') continue
    if (/^\s/.test(line) && key !== '') {
      frontmatter[key] = `${frontmatter[key]} ${line.trim()}`.trim()
      continue
    }
    const at = line.indexOf(':')
    if (at === -1) continue
    key = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    if (value !== '' && value !== '|' && value !== '>') frontmatter[key] = value
  }
  return { frontmatter, content }
}

// ── 自动日记巡检的三个模块级状态 ─────────────────────────────────
//
// 为什么放在模块级而不是 apply() 里：宿主重载插件、或者同一进程里 apply 被
// 调了第二次时，闭包里的状态会跟着重建，而「今天已经写过了」「现在正在跑
// 的那个闹钟」这两件事都必须是全进程唯一的——重建一次就会在夜里并发写同一
// 篇日记。
//
// 为什么是 let 而不是常量：定时器句柄在起和清的时候会变，今天的日期在跨天
// 的时候会变。
let autoDiaryTimer = null
let autoDiaryLastDate = ''
/** 每半小时看一次。不是「到点跑一次」，桌面版不是常驻服务，见 apply() 里的说明。 */
const AUTO_DIARY_INTERVAL_MS = 30 * 60 * 1000
/** 二十点之后才动手。白天他正在干活，这会儿弹一篇「今天」出来只会添乱。 */
const AUTO_DIARY_AFTER_HOUR = 20

export function apply(ctx, config) {
  // 同一个配置对象贯穿 apply 与 buildApi，workspace.init 把选择记在这里，
  // 不写模块级变量，也不需要请求体每次都带 workspace。
  const settings = config ?? {}
  const pointerFile = workspacePointerFile()
  // 配置里没写死 workspace 的时候，先看「上次在界面上选的那个文件夹」。
  // 只查一次（recalled 记忆化），之后 currentWorkspace 自己就够用。
  let recalled = null
  const workspace = async () => {
    if (recalled === null) {
      recalled = await recallWorkspace(pointerFile)
      const configured = typeof settings.workspace === 'string' ? settings.workspace.trim() : ''
      if (configured === '' && recalled !== '') {
        console.log(`[lifecard] 接着用上次选的文件夹：${recalled}`)
        settings.workspace = recalled
      }
    }
    return currentWorkspace(settings)
  }
  const api = buildApi(ctx, workspace, settings, {
    remember: (ws) => rememberWorkspace(pointerFile, ws),
  })

  // 系统提示段落里的 text() 必须同步返回，拿不到异步的 workspace()。
  // 所以这里留一份「当前库」的快照：先用默认值兜底，再异步校准一次；
  // 用户在界面上换文件夹时 settings.workspace 会跟着变，优先用那个。
  let liveRoot = defaultWorkspace()
  Promise.resolve()
    .then(() => workspace())
    .then((ws) => {
      if (typeof ws === 'string' && ws !== '') liveRoot = ws
    })
    .catch(() => {})
  const rootNow = () => {
    const configured = typeof settings.workspace === 'string' ? settings.workspace.trim() : ''
    return configured === '' ? liveRoot : configured
  }

  registerInterviewSkill(ctx)

  // 启动时把缺的 agent preset 补上。
  //
  // 为什么要在这一层做：随包的 cordis.patch.yml 只在**装机那一刻**被抄进用户
  // profile。插件升级之后、用户换 profile、或者宿主走 .agent-presets 目录那套
  // 机制时，「LC 酒馆 / LC 小说 / LC 现实 / LC 日记」根本不在宿主的预设列表里
  // ——用户下拉里看不到，进了酒馆门判不出 mode，人物卡永远进不了系统提示，
  // 他看到的症状是「一开口就被 AI 识破」。所以每启动一次就自查一次。
  //
  // 三条纪律：
  //  · 只补「缺的」和「插件自己升级了文案的」。`planInstall` 会按行对账：
  //    盘上多出来的行如果全是插件旧版文案，那部分自动换新；用户自己写进去的
  //    行原样留着不动。只有「整段被重写过、和插件这份完全对不上」的才是
  //    `auto: false`，**启动时一律不碰**，留给界面上的按钮。
  //    以前把「插件升级文案」和「用户手改」混成一类一律不碰，结果是这个修复
  //    永远到不了老用户手上——他们那边一直是旧文案，界面上写「已经原样放在
  //    最前面，第一行就是那个人的名字」，而卡其实排在最后。
  //  · 不 await、不阻塞启动；失败只留一行日志，绝不让插件起不来。
  //  · 什么都不缺时静默什么都不做（幂等，第二次跑不写盘）。
  //
  // 开关：`DSH_LIFECARD_SKIP_PRESET_INSTALL=1` 时整段跳过。测试要用它——
  // 测试会拿假 ctx 调 apply()，而这一趟是按**真实** DSH_HOME 算的，不能
  // 让跑一遍单测就往开发机的 profile 里写字。test/all.mjs 统一设了这个变量。
  if (process.env.DSH_LIFECARD_SKIP_PRESET_INSTALL !== '1') {
    Promise.resolve()
      .then(() => ensurePresetInstall())
      .then((mod) => {
        if (mod === null) return
        const home = dshHome()
        const plan = mod.planInstall({ home, env: process.env })
        if (plan.ok !== true) return
        const result = mod.applyInstall(plan)
        if (result.written.length > 0) {
          // 换掉的是「插件上一版的文案」时，用户会奇怪「我没点更新，它怎么改了」。
          // 所以日志要分清这两种：补的还是换的。
          const swapped = plan.actions.some((a) => a.type === 'update-preset' && a.auto !== false)
          console.log(`[lifecard] ${swapped ? '换掉了' : '补上了'} ${result.written.length} 个预设文件（${plan.plane === 'profile' ? `profile「${plan.profile}」` : '.agent-presets 目录'}）。`)
        }
        for (const error of result.errors) console.error('[lifecard] 预设安装失败：', error)
      })
      .catch((error) => {
        console.error('[lifecard] 预设安装失败：', error)
      })
  }

  // 把人物卡、世界书交给模型的那几个只读工具。挂在宿主这一层，所以不只是
  // 「LC 酒馆 / LC 小说 / LC 现实」三个预设，任何预览里都能调。
  // 用 ctx.inject 等 tools 服务就绪：apply 跑的时候它可能还没起来，
  // 直接 ctx.get('tools') 会拿到 undefined，工具就静默少了。
  // 把挑好的那张卡拼进系统提示（不是对话里的资料）。
  //
  // 必须挂在 **agent 自己的 ctx** 上。段落是按 scope 分发的：注册在插件自己
  // 那个 ctx 上的段落，落不到任何一个会话的组装里——上一版就是这么写的，
  // 结果模型压根看不见卡，只能反问「演 rat 是什么意思」，然后去翻工具。
  // `text` 传函数，每轮组装都会重新求值，所以换卡/改卡下一句就生效。
  // 去重按 **agent 对象**，不是按会话 id：在顶部换预设时 DSH 会给同一个会话
  // 重新建一个 agent（新对象、新的 meta），按 id 去重会把换过预设的会话锁死在
  // 「第一次那个 agent 认成 standard」的结果上。换对象就重新挂一次。
  const attachedAgents = new WeakSet()
  const attachCard = (agent) => {
    const ok = attachCardToAgent(agent, { rootNow, attached: attachedAgents, note: notePersona, ctx })
    if (ok !== true) notePersona('skip', shapeOfAgent(agent))
    return ok
  }

  // agent/created 是 serial 事件：这里同步抛错会否决整个会话的创建，
  // 所以宁可没人设，也绝不能让用户开不了会话。
  try {
    ctx.on('agent/created', (event) => {
      try {
        attachCard(event?.agent)
      } catch (error) {
        console.error('[lifecard] agent/created 处理失败：', error)
      }
    })
  } catch (error) {
    console.error('[lifecard] 没能监听 agent/created：', error)
  }
  // 已经在跑的会话不会再发 agent/created（插件重载、宿主启动时已存在的会话），
  // 所以要再扫一遍。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['agents'], (agentsCtx) => {
      try {
        const registry = agentsCtx.get('agents', false)
        const list = typeof registry?.list === 'function' ? registry.list() : []
        for (const agent of list) attachCard(agent)
      } catch (error) {
        console.error('[lifecard] 补挂已有会话失败：', error)
      }
    })
  }

  // 真正决定模型读到什么的，是这个钩子。
  //
  // 宿主 SystemPrompt.assemble() 的实现是：按 order 排好段落 → 交给
  // `system-prompt/assemble` 这个 waterfall → **谁在这里返回什么，模型就读什么**。
  // 段落 order 只能决定初始顺序，改不掉「第一条身份句不是你」这件事：
  // 上一版把卡的 order 压到 -1001（排在那句 `You are an AI agent powered by
  // DeepSeek.` 前面），卡确实第一个出现，可模型仍在思考里写
  // 「the rat persona is injected via custom instructions」——因为它同时在
  // 提示词里读到「你是 DeepSeek 的 agent」和一段自定义指令，两下一凑就成了
  // 「有人塞给我一段设定，我判断一下要不要服从」。
  //
  // 所以酒馆这扇门这里做两件事：把卡换成第一段，并拿掉那条通用身份句——
  // 让模型只有一份自述。小说/日记两扇门只把卡提到最前，身份句留着，
  // 因为那两扇门模型不变，只是写的时候按卡上的人。
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('system-prompt/assemble', async (assembly, context, next) => {
        const transformed = typeof next === 'function' ? await next() : assembly
        try {
          const agent = agentOfAssembly(context)
          if (agent === null || agent === undefined) return transformed
          // 判门顺序：①这段提示词正文里有没有某扇门独有的那句话（最稳，
          // 每轮都成立，不依赖宿主任何字段）②插件自己开会话时记下的那扇门
          // ③agent 上的预设字段 ④预设注册表。真机上③④拿不到东西。
          let mode = ''
          let source = ''
          try {
            mode = modeFromPromptText(promptTextOf(transformed))
            if (mode !== '') source = 'text'
          } catch {
            mode = ''
          }
          // 正文判不出来时，先问「这个会话是不是插件自己开的」——那一刻它
          // 自己就知道要开哪扇门，只是以前没把这件事记下来。真机上宿主给
          // agent 的预设字段永远是 standard / ptc，注册表也问不出 lc-*，
          // 所以这一步实际上比下面两条都可靠。
          if (mode === '') {
            try {
              mode = doorOfSession(rootNow(), agent?.id)
              if (mode !== '') source = 'session'
            } catch {
              mode = ''
            }
          }
          if (mode === '') {
            try {
              mode = modeForAgent(agent) || modeFromPresetRegistry(ctx, agent)
              if (mode !== '') source = 'preset'
            } catch {
              mode = ''
            }
          }
          // 现实门不注入：那扇门的 preset 自己写着「用 lifecard_cards /
          // lifecard_default 去取」，卡是查出来的材料，不是身份。
          if (mode === '' || mode === 'real') {
            if (mode === '') {
              // 认不出门要留证据。真机上「门时灵时不灵」查了很久就是因为
              // 没人知道那一刻提示词里到底有什么；这里只记长度、开头一小段
              // 和几扇门各自命中没有，不够成泄漏正文。
              try {
                const text = promptTextOf(transformed)
                const key = 'assemble:' + String(agent?.id ?? '')
                if (noDoorSeen.has(key)) return transformed
                // 集合会跟着会话数长；几百个之后整批忘掉，让后来的会话重新
                // 记一次。忘了只是多一行日志，不影响判门。
                if (noDoorSeen.size > 400) noDoorSeen.clear()
                noDoorSeen.add(key)
                notePersona('no-door', {
                  agent: String(agent?.id ?? ''),
                  where: 'assemble',
                  chars: text.length,
                  head: text.slice(0, 160),
                  sections: (transformed?.sections ?? []).map((one) => String(one?.name ?? '?') + ':' + promptTextOf({ sections: [one] }).length).join(','),
                  marks: DOOR_MARKERS.map(([name, needles]) => name + ':' + (needles.some((one) => text.includes(one)) ? 1 : 0)).join(','),
                  ...shapeOfAgent(agent),
                })
              } catch {
                /* 记不下来不影响这一轮 */
              }
            }
            return transformed
          }
          const detail = buildPersonaSectionDetail(rootNow(), mode)
          const card = detail.text
          const rewritten = composePromptSections(transformed, card, mode, { promptStyle: detail.promptStyle === true })
          if (rewritten === null) return transformed
          // 日志里只记 kept 的条数查不出到底留了哪几段——真机上曾看到
          // 「kept:8」却没法判断那 8 段是什么，只能靠猜。把段名一起记下来。
          if (mode === 'tavern') notePersona('assemble', { agent: String(agent?.id ?? ''), mode, source, card: card.length, kept: rewritten.length, names: rewritten.map((one) => String(one?.name ?? '')), promptStyle: detail.promptStyle === true })
          return { ...transformed, sections: rewritten }
        } catch (error) {
          // 改提示词失败绝不能让这一轮发不出去。
          console.error('[lifecard] 重排系统提示失败：', error)
          return transformed
        }
      })
    }
  } catch (error) {
    console.error('[lifecard] 没能挂上系统提示钩子：', error)
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['tools'], (toolCtx) => {
      try {
        lifecardTools.registerTools(toolCtx, settings)
      } catch (error) {
        console.error('[lifecard] 只读工具没挂上：', error)
      }
    })
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/dsh-lifecard',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-error', message: '只用 POST' } })
          return
        }
        // 这一层没有登录：插件跑在本机，端口上谁都能连。浏览器里的任意一个
        // 网页都能对着 127.0.0.1 发 POST（表单/纯文本不发预检），而我们的
        // 接口没有 Origin 校验——那就等于「任何网页都能删你的素材」。
        // 两道便宜的闸：①只收 application/json（跨站带不上这个类型，
        // 带了就要预检）②带了 Origin 就必须和请求自己的主机一致。
        const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase()
        if (!contentType.includes('application/json')) {
          writeJson(res, 415, { ok: false, error: { code: 'bad-request', message: '请求格式不对' } })
          return
        }
        const origin = String(req.headers?.origin ?? '')
        // 没有 Origin 就是同源请求（浏览器对同源 POST 一般不送）；`null` 是
        // 沙箱里的 iframe。这两种放行，只有「明确来自别家站点」才拦。
        if (origin !== '' && origin !== 'null') {
          // 只比「Origin 和 Host 一致」是不够的：DNS rebinding 下攻击者页面的
          // Origin 和它请求的 Host 都是它自己的域名，两面一致照样放行，
          // 于是别人的网页能读、能改你的日记。这里再加一条——这一台服务只在
          // 本机跑，所以请求的主机名必须真的是回环地址，别的一律不收。
          let allowed = false
          try {
            const host = String(req.headers?.host ?? '')
            const originUrl = new URL(origin)
            const hostName = host === '' ? '' : new URL(`http://${host}`).hostname
            const loopback = hostName === '127.0.0.1' || hostName === 'localhost' || hostName === '::1' || hostName === '[::1]'
            allowed = loopback && originUrl.host === host
          } catch {
            allowed = false
          }
          if (!allowed) {
            writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: '这个来源不能改档案' } })
            return
          }
        }
        const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
        const method = pathname.startsWith('/api/dsh-lifecard/') ? pathname.slice('/api/dsh-lifecard/'.length) : ''
        if (method === '' || method.includes('/')) {
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: '未知接口' } })
          return
        }
        // 只认自有属性：对象字面量查 `constructor` 会命中原型链
        const handler = Object.hasOwn(api, method) ? api[method] : undefined
        if (typeof handler !== 'function') {
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `未知接口 ${method}` } })
          return
        }
        // 只有酒馆说话这一条支持边说边给，而且必须由调用方明确要（Accept 头）。
        // 没这个头就还是老样子：一次算完再发，一个字节都不变。
        const wantsStream = method === 'tavern.say' && String(req.headers?.accept ?? '').includes('text/event-stream')
        try {
          const body = await readBody(req, mbToBytes(config?.maxBodyMB, 64))
          if (wantsStream) {
            // 不能复用 writeJson：它要先算 content-length，算完才能发头，
            // 那样一段都流不出去。这里先把头写出去，再一条一条 write。
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store',
              connection: 'keep-alive',
              'x-accel-buffering': 'no',
            })
            const send = (value) => {
              try { res.write(`data: ${JSON.stringify(value)}\n\n`) } catch { /* 界面那头关了就算了 */ }
            }
            send({ type: 'start' })
            let streamed
            try {
              streamed = await handler(body, { onDelta: (piece) => send({ type: 'delta', text: piece }) })
            } catch (error) {
              noteRouteError(method, error).catch(() => {})
              send({ type: 'error', message: humanizeHostError(error) })
              res.end()
              return
            }
            send({ type: 'done', result: streamed })
            res.end()
            return
          }
          // 第二个参数是「这次请求是从哪个地址进来的」。目前只有读书那几条要用：
          // 它要回头请求同一个端口上另一个插件的路由，得先知道自己是哪个端口。
          // 从 Host 头现算，不写死也不敢读环境变量——桌面版换端口是常事。
          const selfOrigin = (() => {
            const host = String(req.headers?.host ?? '').trim()
            if (host === '') return ''
            // Host 头是请求方给的，能带任意字符。只认「主机名:端口」这一种形状，
            // 免得把一个奇形怪状的 Host 原样拼进 URL 再发出去。
            return /^[A-Za-z0-9.\-]+(:\d{1,5})?$/.test(host) || /^\[[0-9a-fA-F:]+\](:\d{1,5})?$/.test(host) ? `http://${host}` : ''
          })()
          const result = await handler(body, { origin: selfOrigin })
          writeJson(res, 200, result)
        } catch (error) {
          // 兜底 catch 也不能把 EISDIR 这类英文原样漏到界面上。
          console.error('[lifecard] 路由没做成：', error)
          // 但光往 stdout 打是不够的：桌面版把这个进程的输出丢进 /dev/null，
          // 出过一次「分析这一步永远 500」的事故，界面上只有一句人话，
          // 日志里什么都没有，只能靠猜。所以再往一个文件里落一份。
          noteRouteError(method, error).catch(() => {})
          writeJson(res, 500, { ok: false, error: { code: 'internal', message: humanizeHostError(error) } })
        }
      },
    }),
    'dsh-lifecard: /api/dsh-lifecard routes',
  )

  // ── 自动日记：晚上替他补上今天这一篇 ──────────────────────────────
  //
  // 为什么是「每半小时巡检一次」而不是「晚上八点跑一次」：桌面版不是常驻
  // 服务。用户八点关机器、十点再开，那一刻到点的 setTimeout 随进程一起没了，
  // 这一夜就再也不会补。醒着的时候每半小时看一眼，总能撞上一个合适的机会。
  //
  // 为什么日期记在模块级：一次装插件只该有一份巡检。用户在三个窗口里同时
  // 挂着 dsh，三次 apply 各起一个定时器，夜里就会并发写同一篇日记。
  //
  // DSH_LIFECARD_SKIP_AUTO_DIARY 照抄上面预设安装那个开关的写法：整段包在
  // 判断里，关掉就等于这块代码不存在。有人不爱让插件自己动他的日记，这是
  // 唯一的开关，不能只在别的某一层生效。
  if (process.env.DSH_LIFECARD_SKIP_AUTO_DIARY === '1') {
    // 什么都不做。连定时器都不起——关掉却还占一个每半小时醒一次的闹钟，
    // 那是自欺。
  } else {
    ctx.effect(() => {
      // 同一个进程里只留一个闹钟。测试会连续 apply 好几次，宿主重载插件时
      // 也会走过这里。
      if (autoDiaryTimer !== null) return () => {}
      const timer = setInterval(() => {
        const now = new Date()
        // 白天不打扰：他正在干活，这会儿弹一篇「今天」出来只会添乱。
        if (now.getHours() < AUTO_DIARY_AFTER_HOUR) return
        const today = store.localDate(now)
        // 今天已经了结过（写过、或者本来就有），剩下的时间不再试。
        if (autoDiaryLastDate === today) return
        // 整段兜住：定时器里抛出去没人接，宿主会当插件坏了。
        const run = async () => {
          try {
            const result = await api['diary.autoWrite']({})
            // 只有「真写了」或「今天本来就有」才算了结。
            //
            // 特意不把「今天还没聊够」记下来：他 20:10 才刚坐下，材料当然
            // 不够；22:40 聊完了，那时候才该写。早先把所有跳过都当成了结，
            // 结果是八点那次空跑一次、整晚再看都不看了。
            if (result?.wrote === true || result?.settled === true) autoDiaryLastDate = today
          } catch (error) {
            console.error('[lifecard] 自动日记失败：', error)
          }
        }
        run()
      }, AUTO_DIARY_INTERVAL_MS)
      // unref：这个定时器不该成为「进程退不掉」的理由。用户关掉 dsh 的时候
      // 它就该跟着走，而不是拖到下一次醒来的时间。disposer 里照样 clear，
      // 两条都留着——unref 管进程能不能退，clear 管退之前还醒不醒。
      if (typeof timer.unref === 'function') timer.unref()
      autoDiaryTimer = timer
      return () => {
        clearInterval(timer)
        if (autoDiaryTimer === timer) autoDiaryTimer = null
      }
    }, 'dsh-lifecard: 自动日记巡检')
  }
}

// 错误日志的写队列（自己一条，跟人物卡注入那条分开）。
let errorLogQueue = Promise.resolve()

/**
 * 把「某个接口抛了什么」记到文件里，供事后查。
 *
 * 只在出错时写，一行一条，最多留 200KB：这不是运行日志，是事故现场。
 * 位置用 os.tmpdir()：这台机器上桌面版的 stdout 是 /dev/null，写文件是唯一
 * 能事后拿到的线索，而临时目录不用申请权限、也不会混进用户的档案。
 */
async function noteRouteError(method, error) {
  const run = async () => {
    try {
      const file = path.join(os.tmpdir(), 'dsh-lifecard-errors.log')
      const when = new Date().toISOString()
      const stack = error !== null && typeof error === 'object' && typeof error.stack === 'string'
        ? error.stack
      : String(error)
      const line = `\n[${when}] ${method} :: ${stack}\n`
      let keep = ''
      try {
        const st = await fs.stat(file)
        if (st.size > 200 * 1024) keep = (await fs.readFile(file, 'utf8')).slice(-60000)
      } catch { /* 还没有这个文件，正常 */ }
      // 不能直接 writeFile 到目标文件：两个请求同时出错时，两边都是
      // 「读一遍现在的 → 整份写回去」，后写的照着旧内容写，前一条就没了。
      // 先写临时文件再 rename（rename 是原子的），写失败时把临时文件清掉，
      // 不然临时目录里会攒下一堆半截日志。
      const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
      try {
        await fs.writeFile(tmp, keep + line, 'utf8')
        await fs.rename(tmp, file)
      } catch (error_) {
        await fs.rm(tmp, { force: true }).catch(() => {})
        throw error_
      }
    } catch { /* 连日志都写不了，那就别在日志上再抛一次 */ }
  }
  // 同一个进程里排队写：两段日志同时到，谁也不覆盖谁。
  const prev = errorLogQueue
  const next = prev.then(run, run)
  errorLogQueue = next.then(() => {}, () => {})
  return next
}

export { defaultWorkspace, buildApi, callModel, withTimeout, MODEL_TIMEOUT_MS }
