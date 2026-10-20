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
import { promises as fs, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import * as core from './core.js'
import * as codec from './codec.js'
import * as store from './store.js'
import * as prompts from './prompts.js'

import * as score from './score.js'
import * as memory from './memory.js'
import * as jobs from './jobs.js'
import * as jobsStore from './jobs-store.js'
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
})

export const Config = Schema

/** 默认工作区在用户目录下，首次打开时可由界面改写。 */
function defaultWorkspace() {
  return path.join(homedir(), 'LifeCard')
}

/** 从配置 + 运行时状态解析当前工作区。 */
let runtimeWorkspace = null

async function currentWorkspace(config) {
  if (runtimeWorkspace !== null) return runtimeWorkspace
  const configured = typeof config?.workspace === 'string' && config.workspace.trim() !== '' ? config.workspace.trim() : ''
  runtimeWorkspace = configured !== '' ? path.resolve(configured) : defaultWorkspace()
  return runtimeWorkspace
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

async function readBody(req, limit = 64 * 1024 * 1024) {
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

/** 路由内统一的错误包装：永远返回 JSON，不让异常冒成 500 空响应。 */
function guard(handler) {
  return async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      writeJson(res, 500, { ok: false, error: { code: 'internal', message: String(error?.message ?? error) } })
    }
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
function insideWorkspace(ws, rel) {
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
      message: 'lens 卡是永不可导出的偏好透镜——它描述的是「你怎么看」，不是一个人。',
    }
  }
  const consent = data?.consent
  if (consent !== null && typeof consent === 'object') {
    if (String(consent.basis) === 'fictional' && (kind === 'real' || kind === 'self')) {
      return {
        code: 'consent-required',
        message: 'kind 是 ' + String(kind) + ' 的卡不能用 consent.basis: fictional 来绕过同意——要么去拿到同意，要么把 kind 改成 fictional。',
      }
    }
    if (String(consent.basis) === 'family-agreed' && (consent.recorded_at === undefined || String(consent.recorded_at).trim() === '')) {
      return {
        code: 'consent-incomplete',
        message: 'consent.basis 是 family-agreed 时必须填 recorded_at（家属同意的日期），否则不能导出。',
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
    try {
      const handle = await llm.stream({
        provider: candidate.provider,
        model: candidate.model,
        system: input.system,
        messages,
        temperature: 0.2,
        maxTokens: 4000,
      })
      const text = await collectStream(handle)
      if (text !== '') return { ok: true, text, model: `${candidate.provider}/${candidate.model}`, attempts }
      attempts.push(`${candidate.provider}/${candidate.model}: 空响应`)
    } catch (error) {
      attempts.push(`${candidate.provider}/${candidate.model}: ${String(error?.message ?? error)}`)
    }
  }
  return {
    ok: false,
    error: 'AI 试了几次都没回上话。可以过一会儿再试，或者在卡片里直接手写。',
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
  // 注意 `buddy` 虽然能列出模型，但它的 transport 在本机会失败——所以不排在首位。
  const preferred = ['deepseek-official', 'deepseek-account', 'deepseek', 'buddy']
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
 * 全部路由。每个方法一个 key，浏览器侧 `POST /api/dsh-lifecard/<method>`。
 * @param {any} ctx
 * @param {() => Promise<string>} workspace
 * @param {any} config
 */
function buildApi(ctx, workspace, config) {
  const root = async (body) => {
    // 允许请求里带 workspace（首次选择文件夹），否则用当前工作区
    if (typeof body?.workspace === 'string' && body.workspace.trim() !== '') {
      const abs = path.resolve(body.workspace.trim())
      runtimeWorkspace = abs
      return abs
    }
    return await workspace()
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
        defaults: { workspace: defaultWorkspace() },
        summary,
        relations: prompts.RELATION_TYPES,
      }
    },

    /** 建工作区（首次使用时选一个文件夹）。 */
    'workspace.init': async (body) => {
      const ws = await root(body)
      const opened = await store.openWorkspace(ws, { create: true })
      if (!opened.ok) return { ok: false, error: opened.error }
      runtimeWorkspace = ws
      return { ok: true, workspace: ws, created: true }
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
        const safe = insideWorkspace(ws, body.path)
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
        const safe = insideWorkspace(ws, body.path)
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
      const id = core.safeId(data.id ?? data.name ?? '')
      if (id === '') return { ok: false, error: '这张卡还没有名字，先给它起一个。' }
      data.id = id
      data.lifecard = core.DATA_VERSION
      let rel
      if (typeof body?.path === 'string' && body.path.endsWith('.card.md')) {
        const safe = insideWorkspace(ws, body.path)
        if (safe.ok !== true) return { ok: false, error: safe.error }
        rel = safe.rel
      } else {
        rel = store.cardRelPath(id, data.world)
      }
      const written = await store.writeCard(ws, rel, data, Array.isArray(body?.sections) ? body.sections : [], { force: body?.force === true })
      return written
    },

    /** 看某张卡以前的样子（快照在每次保存时自动留，只是以前没露出来）。 */
    'card.history': async (body) => {
      const ws = await root(body)
      const safe = insideWorkspace(ws, body?.path)
      if (safe.ok !== true) return { ok: false, error: safe.error }
      const rel = safe.rel
      if (!rel.endsWith('.card.md')) return { ok: false, error: '这个位置不是一张卡。' }
      return store.listSnapshots(ws, rel)
    },

    /** 读某一版历史原文（只用来看看和找回，不会被当成当前卡）。 */
    'card.version': async (body) => {
      const ws = await root(body)
      const safe = insideWorkspace(ws, body?.path)
      if (safe.ok !== true) return { ok: false, error: safe.error }
      const rel = safe.rel
      if (!rel.endsWith('.card.md')) return { ok: false, error: '这个位置不是一张卡。' }
      return store.readSnapshot(ws, rel, body?.stamp)
    },

    /** 把某个历史版本恢复成当前内容。恢复前会再留一份新快照，所以这一步本身也能撤销。 */
    'card.restore': async (body) => {
      const ws = await root(body)
      const safe = insideWorkspace(ws, body?.path)
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
      const safe = insideWorkspace(ws, body?.path)
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
      const abs = path.resolve(filePath.replace(/^~(?=\/|$)/, homedir()))
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
      const safe = insideWorkspace(ws, body?.path)
      if (safe.ok !== true) return { ok: false, error: safe.error }
      const rel = safe.rel
      const card = await store.readCard(ws, rel)
      if (!card.ok) return card
      const saved = await store.writeAvatar(ws, card.data?.id, body?.base64)
      if (saved.ok !== true) return saved
      return { ok: true, path: rel, avatar: saved.path, bytes: saved.bytes }
    },

    /** 去头像，回到首字方块。 */
    'avatar.remove': async (body) => {
      const ws = await root(body)
      const safe = insideWorkspace(ws, body?.path)
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
      const safe = insideWorkspace(ws, body?.path)
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
        const safeRaw = insideWorkspace(ws, rawRel)
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
      const safe = insideWorkspace(ws, body?.path)
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
      return { ok: true, ...saved }
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
      return {
        ok: true,
        markdown: text,
        path: saved.ok === true ? saved.path : null,
        unsupportedNumbers: invented,
        warning: invented.length === 0
          ? null
          : `这版里有 ${invented.length} 个数字在你材料里找不到：${invented.slice(0, 8).join('、')}。投之前自己核一遍，拿不出处的最好删掉。`,
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
      const mem = await memory.readMemory(process.env)
      if (mem.found !== true) {
        return { ok: true, found: false, people: [], reason: '这台电脑上没有找到记忆文件。' }
      }
      const people = memory.findPeople(mem.text)
      return {
        ok: true,
        found: true,
        files: mem.files.length,
        chars: mem.chars,
        people, // 已经含 clues / missing，界面直接就能画
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
      const mem = await memory.readMemory(process.env)
      if (mem.found !== true) return { ok: false, error: '这台电脑上没有找到记忆文件，没什么可导入的。' }
      const all = memory.findPeople(mem.text)
      if (all.length === 0) return { ok: false, error: '记忆里没有认出具体的人。' }
      const wanted = Array.isArray(body?.people) && body.people.length > 0
        ? all.filter((p) => body.people.includes(p.name !== '' ? `${p.kin}:${p.name}` : p.kin))
        : all
      if (wanted.length === 0) return { ok: false, error: '勾选的人一个都没对上。' }
      const md = memory.renderMemoryMaterial(wanted, { read_at: new Date().toISOString().slice(0, 10) })
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
      const saved = await store.saveProposal(ws, aboutId, proposal, chosen)
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
      const safe = insideWorkspace(ws, body?.json)
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
      const safe = insideWorkspace(ws, body?.json)
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
      const safe = insideWorkspace(ws, body?.json)
      if (safe.ok !== true) return { ok: false, error: safe.error }
      const rel = safe.rel
      if (!rel.endsWith('.json') || rel.endsWith('.checked.json')) return { ok: false, error: '这个位置不是一份建议。' }
      if (!Array.isArray(body?.checked)) return { ok: false, error: '没有收到你勾选的条目。' }
      const written = await store.writeCheckedFile(ws, rel, body.checked)
      return { ok: true, checked: written.checked }
    },

    /** doctor：数据体检 + 把宿主能力写进 diagnostics.json。 */
    'doctor.run': async (body) => {
      const ws = await root(body)
      const summary = await store.doctor(ws)
      // 宿主段：只有宿主侧才知道的能力，如实写下来
      const host = {
        ran: true,
        at: new Date().toISOString(),
        dshVersion: ctx.get?.('version') ?? undefined,
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
      const { questions } = prompts.questionsFor(relationId)
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
      const answeredIds = new Set(answered.map((a) => a.q))
      const cov = core.coverage(data, sections)
      const filled = new Set(cov.filled.map((f) => f.key))
      const todo = questions.filter((q) => {
        if (answeredIds.has(q.id)) return false
        const sealed = answered.find((a) => a.q === q.id && a.reason === 'sealed')
        if (sealed !== undefined) return false
        // fills 里还有空字段才问
        return q.fills.some((f) => !filled.has(f))
      })
      const deferred = answered.filter((a) => a.status === 'deferred').map((a) => a.q)
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
        askedAlready: answeredIds.size,
        sealed: answered.filter((a) => a.reason === 'sealed').map((a) => a.q),
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
      const date = new Date().toISOString().slice(0, 10)
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
  }
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
  const id = core.safeId(String(json?.name ?? path.basename(fileName, path.extname(fileName))))
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
    if (!entry.name.includes(safe) && safe !== '') continue
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
function registerInterviewSkill(ctx) {
  const skills = ctx.reflect?.get?.('skills', false)
  if (skills === undefined || skills === null || typeof skills.register !== 'function') {
    ctx.logger?.warn?.('[lifecard] 没有 skills 服务，访谈 skill 未注册（不影响卡库功能）')
    return
  }
  const body = interviewSkillBody()
  if (body === '') {
    ctx.logger?.warn?.('[lifecard] 找不到 skills/lifecard-interview/SKILL.md，访谈 skill 未注册')
    return
  }
  const { frontmatter, content } = splitSkillFile(body)
  ctx.effect(
    () => skills.register({
      name: 'lifecard-interview',
      description: frontmatter.description ?? '引导式对话访谈，把一张人物卡问出来。',
      whenToUse: frontmatter.whenToUse,
      content,
      source: 'lifecard',
      invocation: { modelInvocable: true, userInvocable: true },
    }),
    'dsh-lifecard: lifecard-interview skill',
  )
}

/** SKILL.md 与 lib/ 同包，用 import.meta.url 定位，不依赖 cwd。 */
function interviewSkillPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'lifecard-interview', 'SKILL.md')
}

let interviewSkillCache
function interviewSkillBody() {
  if (interviewSkillCache === undefined) {
    try {
      interviewSkillCache = readFileSync(interviewSkillPath(), 'utf8')
    } catch {
      interviewSkillCache = ''
    }
  }
  return interviewSkillCache
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
  const workspace = () => currentWorkspace(config)
  const api = buildApi(ctx, workspace, config ?? {})

  registerInterviewSkill(ctx)

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/dsh-lifecard',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          writeJson(res, 405, { ok: false, error: { code: 'method-error', message: '只用 POST' } })
          return
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
          const body = await readBody(req)
          const result = await handler(body)
          writeJson(res, 200, result)
        } catch (error) {
          writeJson(res, 500, { ok: false, error: { code: 'internal', message: String(error?.message ?? error) } })
        }
      },
    }),
    'dsh-lifecard: /api/dsh-lifecard routes',
  )
}

export { defaultWorkspace, buildApi, callModel }
