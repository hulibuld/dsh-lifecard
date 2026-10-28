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
import { promises as fs, readFileSync, statSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import os from 'node:os'
import * as core from './core.js'
import * as codec from './codec.js'
import * as store from './store.js'
import * as prompts from './prompts.js'

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
/** 哪个功能没装（给用户看的名字）。 */
const FEATURE_NAMES = { tavern: '酒馆', novel: '写小说', presets: '预设', game: '文字小说游戏', career: '简历与规划' }
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
  return { tavern: tavern !== null, novel: novel !== null, presets: presets !== null, game: game !== null, career: career !== null }
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
    return { ok: false, error: String(error?.message ?? error) }
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
  // 还剩英文（EISDIR 这类 errno）：规则表没覆盖，也不能原样露给用户。
  if (/[A-Za-z]{3,}/.test(raw)) return '后台没做成这一步，等一会儿再试一次；还不行就重启软件。'
  return raw
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
async function callModel(ctx, input) {
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
  const attempts = []
  // 候选：先试首选，失败再试剩下的（transport 错误在各 provider 之间不通用）
  const candidates = [route]
  for (const p of await listCandidateRoutes(llm, route)) candidates.push(p)
  for (const candidate of candidates) {
    let handle = null
    let pending = null
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
      const text = await withTimeout(collectStream(handle), MODEL_TIMEOUT_MS, 'AI ')
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
async function collectStream(handle) {
  let text = ''
  const eat = (chunk) => {
    if (chunk === null || chunk === undefined) return
    if (typeof chunk === 'string') { text += chunk; return }
    // 模型「想」的那一段走的是另一条事件（实测：{ type: 'reasoning-delta', text }）。
    // 它不是回答，也**不能**当成回答拼进来：拼进去之后 JSON 前面多出几千字
    // 「Thinking Process: …」，解析必失败——「整理进卡里」于是等五十秒、
    // 试两次、报「AI 这次没给出能用的结果」，用户看到的是一直转圈。
    // 下面那些「只要是 .text 就收」的兜底分支会让它漏进来，所以必须先在
    // 这里按类型挡掉。
    if (typeof chunk.type === 'string' && /reasoning|thinking|analysis/i.test(chunk.type)) return
    // 真实的流事件形状（实测）：{ type: 'text-delta', index, text }
    // block-start / block-end / text-start / text-end / finish 都不带正文
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') { text += chunk.text; return }
    if (chunk.type === 'finish') return
    if (chunk.type === 'block-start' || chunk.type === 'block-end' || chunk.type === 'text-start' || chunk.type === 'text-end') return
    if (typeof chunk.text === 'string') { text += chunk.text; return }
    if (typeof chunk.delta === 'string') { text += chunk.delta; return }
    if (typeof chunk.content === 'string') { text += chunk.content; return }
    if (chunk.delta !== null && typeof chunk.delta === 'object' && typeof chunk.delta.text === 'string') { text += chunk.delta.text; return }
    if (chunk.delta !== null && typeof chunk.delta === 'object' && typeof chunk.delta.content === 'string') { text += chunk.delta.content; return }
    if (Array.isArray(chunk.content)) {
      for (const block of chunk.content) {
        if (typeof block === 'string') text += block
        else if (typeof block?.text === 'string') text += block.text
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
      } else {
        rel = store.cardRelPath(id, data.world)
        // 没给路径＝这是一张新卡。同名文件已经在了就不再写：
        // 以前会直接覆盖，用户点「新建」写了个已有的名字，那人原来那张卡
        // 连同快照之外的一切（关系史、口癖）就没了声息地被换成了空白。
        const exists = await fs.stat(path.join(ws, rel)).then((st) => st.isFile()).catch(() => false)
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
        },
      }
    },
    'card.defaults.set': async (body) => {
      const ws = await root(body)
      const mode = String(body?.mode ?? '')
      if (mode !== 'real' && mode !== 'tavern' && mode !== 'novel') {
        return { ok: false, error: '不知道你说的是哪扇门。' }
      }
      const id = String(body?.id ?? '').trim()
      const cfg = await store.readConfigState(ws)
      if (cfg.ok !== true) return { ok: false, error: cfg.error ?? '这个文件夹里的设置读不出来。' }
      const pins = { real: '', tavern: '', novel: '', ...(cfg.config?.default_cards ?? {}) }
      pins[mode] = id
      await store.writeConfig(ws, { default_cards: pins })
      return { ok: true, cards: pins }
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
      if (id !== 'real' && id !== 'novel' && id !== 'tavern') return { ok: false, error: '不知道你说的是哪扇门。' }
      const confState = await store.readConfigState(ws)
      if (confState.ok !== true) return { ok: false, error: confState.error ?? '这个文件夹里的设置读不出来。' }
      const conf = confState.config ?? {}
      const hidden = Array.isArray(conf?.hidden_doors) ? conf.hidden_doors.filter((x) => typeof x === 'string') : []
      const want = body?.hidden === true
      const next = want
        ? (hidden.includes(id) ? hidden : [...hidden, id])
        : hidden.filter((x) => x !== id)
      if (next.length === 3) return { ok: false, error: '三扇门都收起来就没地方进去了，至少留一扇。' }
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

    /** 把某个历史版本恢复成当前内容。恢复前会再留一份新快照，所以这一步本身也能撤销。 */
    'card.restore': async (body) => {
      const ws = await root(body)
      const safe = await insideWorkspace(ws, body?.path)
      if (safe.ok !== true) return { ok: false, error: safe.error }
      const rel = safe.rel
      if (!rel.endsWith('.card.md')) return { ok: false, error: '这个位置不是一张卡。' }
      const old = await store.readSnapshot(ws, rel, body?.stamp)
      if (old.ok !== true) return old
      const written = await store.writeCard(ws, rel, old.data, old.sections, { force: true })
      if (written.ok !== true) return written
      return { ok: true, path: rel, validation: written.validation, note: '已经退回这一版。刚才那一版也还在历史里。' }
    },

    /** 删除一张卡（写墓碑，不真删文件——真删就不可审计了）。 */
    'card.delete': async (body) => {
      const ws = await root(body)
      const safe = await insideWorkspace(ws, body?.path)
      if (safe.ok !== true) return { ok: false, error: safe.error }
      const rel = safe.rel
      if (!rel.endsWith('.card.md')) return { ok: false, error: '这个位置不是一张卡。' }
      const card = await store.readCard(ws, rel)
      if (!card.ok) return card
      await store.appendRedaction(ws, { path: rel, sha256: store.sha256(card.text), reason: String(body?.reason ?? '用户删除') })
      return { ok: true, path: rel, note: '已经删掉了：它不会再出现在列表、导出和 AI 的眼里。磁盘上的原文我们还留着，方便你反悔。' }
    },

    /** 导入酒馆卡（PNG / JSON / CHARX）。body.files 是 [{name, base64}]。 */
    'import.cards': async (body) => {
      const ws = await root(body)
      const files = Array.isArray(body?.files) ? body.files : []
      if (files.length === 0) return { ok: false, error: '没有选文件。' }
      const results = []
      for (const file of files) {
        const fileName = String(file?.name ?? 'card')
        try {
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
          await fs.writeFile(path.join(ws, rawRel), Buffer.from(bytes))
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
          results.push({ name: fileName, ok: false, error: String(error?.message ?? error) })
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
      const about = String(body?.about ?? '').trim()
      const content = String(body?.content ?? '')
      if (content.trim() === '') return { ok: false, error: '文本是空的，先写一点。' }
      if (about === '') return { ok: false, error: '先说说这段材料是关于谁的。' }
      const name = String(body?.name ?? about)
      const saved = await store.appendMaterial(ws, name, content.trim())
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
        await store.writeConfig(ws, { intro_seen: true })
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
      const chosen = Array.isArray(body?.materials) && body.materials.length > 0
        ? Object.fromEntries(Object.entries(materials).filter(([k]) => body.materials.includes(k) || body.materials.includes(path.basename(k))))
        : materials
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
      const { questions, exact } = prompts.questionsFor(relationId)
      return { ok: true, relation: relationId, exact, questions }
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
      let data = {}
      let sections = []
      const rel = aboutId === '' ? null : await store.findCardByRelOrId(ws, aboutId).catch(() => null)
      if (rel !== null) {
        const card = await store.readCard(ws, rel)
        if (card.ok) {
          data = card.data
          sections = card.sections
          answered = await collectAnswered(ws, aboutId).catch(() => [])
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
        const block = `## ${questionId}\n\n> ${String(body?.ask ?? '').trim()}\n\n${answer.trim()}\n\n\`\`\`\nq: ${questionId}\nasked_at: ${new Date().toISOString()}\n\`\`\`\n`
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
      const answered = await collectAnswered(ws, aboutId)
      return { ok: true, about: aboutId, answered }
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
      const persona = tavern.personaFromCard(card.data, card.sections)
      const cardName = persona.name !== '' ? persona.name : String(card.data?.name ?? '').trim()
      const world = await resolveTavernWorld(ws, String(body?.world ?? ''), String(card.data?.world ?? ''))
      if (world.ok !== true) return world
      const id = tavern.newChatId()
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
    'tavern.say': async (body) => {
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
        const cardRel = String(got.data?.card ?? '')
        const card = cardRel === '' ? { ok: false } : await store.readCard(ws, cardRel)
        const persona = card.ok === true ? tavern.personaFromCard(card.data, card.sections) : { name: '', text: '' }
        const cardName = persona.name !== '' ? persona.name : String(got.data?.card_name ?? '').trim()
        const worldNotes = []
        const worldRel = String(got.data?.world ?? '')
        if (worldRel !== '') {
          const world = await store.readCard(ws, worldRel)
          if (world.ok === true) {
            const entries = core.parseWorldEntries(world.sections)
            worldNotes.push(...tavern.pickWorldEntries(entries, tavern.recentContextText(turns)))
          }
        }
        // 「收个尾」收到的那段备忘，每轮都带上：不带的话说得久了它会开始
        // 把前面发生过的事记错（历史只带最近二十来轮）。
        const memoryNote = (Array.isArray(got.notes) ? got.notes : [])
          .find((n) => String(n?.title ?? '').trim() === tavern.MEMORY_TITLE)
        const memory = memoryNote === undefined ? '' : String(memoryNote.body ?? '')
        // 演法预设：选了就把它那套要求拼在最后。找不到预设（用户删了）就不拼，
        // 不能因为这一条让整场对话报错。
        const roleplayPreset = await presets.resolve(ws, body?.preset)
        const presetNote = roleplayPreset.ok === true && roleplayPreset.preset !== null ? String(roleplayPreset.preset.prompt ?? '') : ''
        const system = tavern.buildRoleplaySystem({ cardName, persona: persona.text, worldNotes, memory, preset: presetNote })
        const user = tavern.buildRoleplayUser({ cardName, turns })
        const called = await callModel(ctx, { system, user, model: body?.model })
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
        const reply = tavernCleanReply(called.text, cardName)
        if (reply !== '') turns.push({ who: cardName === '' ? 'TA' : cardName, text: reply })
        const saved = await tavern.writeChat(ws, id, { ...got.data, notes: got.notes, card_name: cardName, turns: turns.length, updated_at: now }, turns)
        if (saved.ok !== true) {
          return { ok: false, error: `TA 回了，但这一场没存下来：${saved.error}`, reply, turns }
        }
        return { ok: true, id, reply, turns, used: { card: card.ok === true, world: worldNotes.length } }
    
      })
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
        const read = await store.readCard(ws, card)
        if (read.ok !== true) return read
        const sections = Array.isArray(read.sections) ? read.sections.map((x) => ({ ...x })) : []
        const title = '对话示例'
        const at = sections.findIndex((x) => String(x.title ?? '').trim() === title)
        const block = picked.map((line) => `- ${line}`).join('\n')
        if (at === -1) sections.push({ title, body: block })
        else {
          const oldBody = String(sections[at].body ?? '').trim()
          const merged = oldBody === '' || oldBody === '_（还没写）_' ? block : `${oldBody}\n${block}`
          // 例句越攒越多会把这个小节撑爆，之后每演一句都把这些全塞进提示词。
          // 只留最后 24 行——它们是最靠近「现在这个人」的样子。
          const lines = merged.split(/\r?\n/).filter((x) => x.trim() !== '')
          sections[at] = { ...sections[at], body: lines.slice(-24).join('\n') }
        }
        const written = await store.writeCard(ws, card, read.data, sections)
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
      return await tavern.deleteChat(ws, id)
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
      return await novel.deleteChapter(ws, id, body?.index)
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
      return { ok: true, index, review, chars: bodyText.length, blind: true, model: String(body?.model ?? '') }
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
      const built = career.buildResumePrompt({ profile: profile.sections, target })
      const called = await callModel(ctx, { system: built.system, user: built.user, model: body?.model })
      if (called.ok !== true) return { ok: false, error: `这次没写出来：${called.error ?? '过一会儿再试一次'}` }
      return { ok: true, target, text: String(called.text ?? '').trim() }
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
        scene: got.scene,
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
      const system = game.buildGmSystem({ bookTitle: String(book.data?.title ?? bookId), scene: '', holding: [], preset: presetNote })
      const user = game.buildGmUser({ turns: [], move: '', fromChapter })
      const called = await callModel(ctx, { system, user, model: body?.model })
      if (called.ok !== true) return { ok: false, error: `这一局开不起来：${called.error ?? '过一会儿再试一次'}` }
      const parsed = game.parseChoices(called.text)
      const id = game.newPlayId()
      const now = new Date()
      const turns = [{ kind: 'narrate', text: parsed.body }]
      const data = {
        id, book: bookId, chapter, preset: String(body?.preset ?? ''),
        created_at: now.toISOString(), updated_at: now.toISOString(), turn: 0, scene: '', holding: [],
      }
      const saved = await game.writePlay(ws, bookId, id, data, turns)
      if (saved.ok !== true) return saved
      return { ok: true, id, book: bookId, chapter, path: saved.path, text: parsed.body, choices: parsed.choices, turns }
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
      const system = game.buildGmSystem({ bookTitle: String(book.data?.title ?? bookId), scene: got.scene, holding: got.holding, preset: presetNote })
      const user = game.buildGmUser({ turns, move })
      const called = await callModel(ctx, { system, user, model: body?.model })
      // 模型没接上也要把你这一步记下来：不然你选过什么，下一轮它完全不知道。
      const parsed = game.parseChoices(called.ok === true ? called.text : '')
      const nextTurns = [...turns, { kind: 'choose', text: move, result: called.ok === true ? parsed.body : '' }]
      const now = new Date()
      const data = { ...got.data, updated_at: now.toISOString(), turn: moves + 1 }
      const saved = await game.writePlay(ws, bookId, id, data, nextTurns)
      if (saved.ok !== true) return saved
      if (called.ok !== true) {
        return { ok: false, error: `这一步记下了，但它没接上话：${called.error ?? '过一会儿再试一次'}`, turns: nextTurns, kept: true }
      }
      return { ok: true, id, text: parsed.body, choices: parsed.choices, turns: nextTurns }
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

    /** 列预设（内置 + 自己的）。 */
    'preset.list': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.presets !== true) return missingFeature('presets')
      return await presets.listAll(ws)
    },

    /** 把一份内置的复制成自己的，之后能随便改。 */
    'preset.copy': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.presets !== true) return missingFeature('presets')
      return await presets.copyBuiltin(ws, body?.id, body?.as)
    },

    /** 存一份自己的预设（新建或改）。 */
    'preset.save': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.presets !== true) return missingFeature('presets')
      return await presets.saveCustom(ws, { id: body?.id, mode: body?.mode, name: body?.name, desc: body?.desc, prompt: body?.prompt })
    },

    /** 删一份自己的预设。 */
    'preset.delete': async (body) => {
      const ws = await root(body); const mods = await ensureModules(); if (mods.presets !== true) return missingFeature('presets')
      const id = String(body?.id ?? '').trim()
      if (id === '') return { ok: false, error: '没有说是哪一份' }
      return await presets.deleteCustom(ws, id)
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
      })
      const called = await callModel(ctx, { system, user, model: body?.model })
      if (called.ok !== true) {
        return { ok: false, error: `这次没写出来：${called.error ?? '过一会儿再试一次'}`, index }
      }
      const draft = String(called.text ?? '').trim()
      if (draft === '') return { ok: false, error: 'AI 这次没写出东西来，再点一次试试。', index }
      return {
        ok: true,
        index,
        draft,
        // 不直接落盘：写字的人要能先看、能改、能只取一半。落盘由 chapter.save 做。
        hasCurrent: String(currentBody).trim() !== '',
        usedWorld: worldNotes.length,
        usedCast: cast.length,
      }
    },
  }
}

/**
 * 把「这本书挂的几张角色卡」收成几段人设。
 *
 * 一本书可以挂好几张卡（主角、对手、配角）。写某一章的时候把它们一起给模型，
 * 它才不会把「说话很冲的那个人」写成温和的——那是长篇最容易崩的地方。
 * 每张卡只取前 500 字：卡可能写得很长，全贴会把大纲和上一章挤掉。
 */
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
      const persona = tavern.personaFromCard(card.data, card.sections)
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
  for (let n = 2; n <= 200; n += 1) {
    const taken = await fs.stat(path.join(ws, 'worlds', id, 'world.md')).then((st) => st.isFile()).catch(() => false)
    const rawTaken = await fs.stat(path.join(ws, '.lifecard/raw', `${id}.worldinfo.json`)).then((st) => st.isFile()).catch(() => false)
    if (!taken && !rawTaken) break
    id = `${stem}-${n}`
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
    await fs.writeFile(path.join(ws, rawRel), Buffer.from(JSON.stringify(json, null, 2), 'utf8'))
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
    return []
  }
  const safe = core.safeId(aboutId)
  const out = []
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
          // 坏行跳过
        }
      }
    } catch {
      // 读不了跳过
    }
  }
  return out
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
  const direct = path.join(root, 'people', `${want}.card.md`)
  try {
    if (statSync(direct).isFile()) return direct
  } catch {
    /* 名字不是文件名，退回去扫目录 */
  }
  try {
    const names = readdirSync(path.join(root, 'people')).filter((n) => n.endsWith('.card.md'))
    for (const name of names) {
      const abs = path.join(root, 'people', name)
      const text = readCachedSync(abs)
      if (text === null) continue
      const parsed = core.parseCard(text)
      if (parsed.ok === true && String(parsed.data?.id ?? '') === want) return abs
    }
  } catch {
    /* 没有 people 目录就当没挑卡 */
  }
  return ''
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

/** 把世界书条目排成人能读、模型也好读的样子。 */
function worldEntriesText(entries) {
  const list = Array.isArray(entries) ? entries : []
  if (list.length === 0) return ''
  return list
    .map((entry) => {
      const keys = Array.isArray(entry?.keys) ? entry.keys.filter((k) => typeof k === 'string' && k !== '') : []
      const content = String(entry?.content ?? '').trim()
      const head = keys.length === 0 ? '（一直生效）' : `关键词：${keys.join('、')}`
      return `- ${head}\n  ${content.replace(/\n/g, '\n  ')}`
    })
    .join('\n')
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
  const id = pinnedCardIdSync(root, mode)
  if (id === '') return ''
  const abs = cardPathSync(root, id)
  if (abs === '') return ''
  const text = readCachedSync(abs)
  if (text === null) return ''
  const parsed = core.parseCard(text)
  if (parsed.ok !== true) return ''
  const data = parsed.data ?? {}
  const sections = Array.isArray(parsed.sections) ? parsed.sections : []
  const body = ['自述', '性格', '外貌', '口癖', '不会说的话', '不会做的事', '场景', '开场白', '对话示例']
    .map((title) => core.sectionBody(sections, title))
    .filter((part) => typeof part === 'string' && part.trim() !== '')
    .join('\n\n')
  if (body.trim() === '') return ''
  const name = String(data.name ?? '').trim() === '' ? id : String(data.name).trim()
  const out = [
    `# 你要演的人：${name}${String(data.relation ?? '').trim() === '' ? '' : `（${String(data.relation).trim()}）`}`,
    '',
    '下面这张卡就是这个人的全部设定，直接照它演——不要把它当成资料来引用，也不要在回答里提「卡上写着」。',
    '',
    body,
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
  return out.join('\n')
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

/** 这个 agent 用哪扇门的卡：只有 LC 那两个创作预设才挂，别的会话一个字都不注入。 */
function modeForAgent(agent) {
  const preset = presetIdOfAgent(agent)
  if (preset === '') return ''
  if (preset.includes('lc-tavern')) return 'tavern'
  if (preset.includes('lc-novel')) return 'novel'
  return ''
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
      invocation: { modelInvocable: true, userInvocable: true },
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

  // 把人物卡、世界书交给模型的那几个只读工具。挂在宿主这一层，所以不只是
  // 「LC 酒馆 / LC 小说 / LC 现实」三个预设，任何预览里都能调。
  // 用 ctx.inject 等 tools 服务就绪：apply 跑的时候它可能还没起来，
  // 直接 ctx.get('tools') 会拿到 undefined，工具就静默少了。
  // 把挑好的那张卡拼进系统提示（不是对话里的资料）。
  // 用 ctx.inject 等 systemPrompt 就绪；`text` 传函数，每轮重新求值，
  // 所以换卡/改卡下一句就生效。只对 LC 酒馆、LC 小说两个预设生效。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      try {
        const prompt = promptCtx.get('systemPrompt', false)
        if (prompt === undefined || prompt === null || typeof prompt.section !== 'function') {
          console.warn('[lifecard] 系统提示服务不可用，人物卡改由工具提供')
          return
        }
        let order = 500
        try {
          const anchorOrder = prompt.getSectionOrder('deployment:persona-suffix')
          if (typeof anchorOrder === 'number' && Number.isFinite(anchorOrder)) order = anchorOrder - 0.5
        } catch {
          /* 拿不到锚点就用手写的位置 */
        }
        promptCtx.effect(
          () =>
            prompt.section({
              name: 'lifecard:card',
              order,
              text: (assembly) => {
                try {
                  const mode = modeForAgent(assembly?.agent)
                  if (mode === '') return ''
                  return buildPersonaSection(rootNow(), mode)
                } catch {
                  // 提示词拼不出来也不能挡住这一句话。
                  return ''
                }
              },
              interpolate: false,
            }),
          'lifecard: 人物卡段落',
        )
      } catch (error) {
        console.error('[lifecard] 人物卡段落没挂上：', error)
      }
    })
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
          let sameHost = false
          try {
            const host = String(req.headers?.host ?? '')
            sameHost = host !== '' && new URL(origin).host === host
          } catch {
            sameHost = false
          }
          if (!sameHost) {
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
        try {
          const body = await readBody(req, mbToBytes(config?.maxBodyMB, 64))
          const result = await handler(body)
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
}

/**
 * 把「某个接口抛了什么」记到文件里，供事后查。
 *
 * 只在出错时写，一行一条，最多留 200KB：这不是运行日志，是事故现场。
 * 位置用 os.tmpdir()：这台机器上桌面版的 stdout 是 /dev/null，写文件是唯一
 * 能事后拿到的线索，而临时目录不用申请权限、也不会混进用户的档案。
 */
async function noteRouteError(method, error) {
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
    await fs.writeFile(file, keep + line, 'utf8')
  } catch { /* 连日志都写不了，那就别在日志上再抛一次 */ }
}

export { defaultWorkspace, buildApi, callModel, withTimeout, MODEL_TIMEOUT_MS }
