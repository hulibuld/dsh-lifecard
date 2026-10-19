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
    throw new Error('请求体不是合法 JSON')
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
    return { ok: false, error: '当前宿主没有可用的 llm 服务。可以改用「手工建卡」——直接改卡的正文，效果一样。' }
  }
  if (typeof llm.stream !== 'function') {
    return { ok: false, error: 'llm 服务没有 stream() 方法（宿主版本可能不匹配）' }
  }
  const route = await resolveRoute(llm, input.model)
  if (route.provider === undefined) {
    return { ok: false, error: route.error ?? '宿主里没有已注册的模型 provider，无法分析。可以改用「手工建卡」。' }
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
    error: `所有模型路由都失败了：${attempts.join('；')}`,
    attempts,
    hint: '可以在插件配置里写 defaultAnalysisModel: "provider/model" 指定一个确定能用的。',
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
  return { error: providers.length === 0 ? '宿主没有注册任何模型 provider' : '找到了 provider 但拿不到任何模型 id；请在插件配置里写 defaultAnalysisModel: "provider/model"' }
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
      if (target === '') return { ok: false, error: '没给路径' }
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
      const rel = typeof body?.path === 'string' ? body.path : await store.findCardByRelOrId(ws, String(body?.id ?? ''))
      if (rel === null || rel === undefined) return { ok: false, error: '找不到这张卡' }
      const card = await store.readCard(ws, rel)
      if (!card.ok) return card
      const validation = core.validateCard(card.data)
      const cov = core.coverage(card.data, card.sections)
      return { ok: true, path: rel, data: card.data, sections: card.sections, text: card.text, validation, coverage: cov }
    },

    /** 存一张卡（新建或编辑）。 */
    'card.save': async (body) => {
      const ws = await root(body)
      const data = body?.data
      if (data === null || typeof data !== 'object') return { ok: false, error: '没有 data' }
      const id = core.safeId(data.id ?? data.name ?? '')
      if (id === '') return { ok: false, error: '缺少 id 或 name' }
      data.id = id
      data.lifecard = core.DATA_VERSION
      const rel = typeof body?.path === 'string' && body.path.endsWith('.card.md')
        ? body.path
        : store.cardRelPath(id, data.world)
      const written = await store.writeCard(ws, rel, data, Array.isArray(body?.sections) ? body.sections : [], { force: body?.force === true })
      return written
    },

    /** 删除一张卡（写墓碑，不真删文件——真删就不可审计了）。 */
    'card.delete': async (body) => {
      const ws = await root(body)
      const rel = String(body?.path ?? '')
      if (!rel.endsWith('.card.md')) return { ok: false, error: '路径不合法' }
      const card = await store.readCard(ws, rel)
      if (!card.ok) return card
      await store.appendRedaction(ws, { path: rel, sha256: store.sha256(card.text), reason: String(body?.reason ?? '用户删除') })
      return { ok: true, path: rel, note: '已记墓碑：读取与导出都不会再出现它；磁盘上的原文仍在 .lifecard/snapshots 里，可审计但不可用。' }
    },

    /** 导入酒馆卡（PNG / JSON / CHARX）。body.files 是 [{name, base64}]。 */
    'import.cards': async (body) => {
      const ws = await root(body)
      const files = Array.isArray(body?.files) ? body.files : []
      if (files.length === 0) return { ok: false, error: '没有文件' }
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
            throw new Error(`认不出这张卡的格式（detect: ${extracted.kind}）`)
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
      if (content.trim() === '') return { ok: false, error: '文本是空的' }
      if (about === '') return { ok: false, error: '要说明这段材料是关于谁的（about）' }
      const name = String(body?.name ?? about)
      const saved = await store.appendMaterial(ws, name, content.trim())
      return { ok: true, ...saved, about, chars: content.trim().length }
    },

    /** 从本地磁盘读一个文本文件作为材料（用户已有访谈稿/日记）。 */
    'import.textFile': async (body) => {
      const ws = await root(body)
      const filePath = String(body?.path ?? '').trim()
      if (filePath === '') return { ok: false, error: '没给文件路径' }
      const abs = path.resolve(filePath.replace(/^~(?=\/|$)/, homedir()))
      let text
      try {
        text = await fs.readFile(abs, 'utf8')
      } catch (error) {
        return { ok: false, error: `读不了这个文件：${String(error?.message ?? error)}` }
      }
      if (text.trim() === '') return { ok: false, error: '文件是空的' }
      const about = String(body?.about ?? path.basename(abs, path.extname(abs))).trim()
      const name = String(body?.name ?? path.basename(abs, path.extname(abs)))
      const saved = await store.appendMaterial(ws, name, text.trim())
      return { ok: true, ...saved, about, chars: text.trim().length, source: abs }
    },

    /** 导出成 PNG（双 chunk 同源）。 */
    'export.card': async (body) => {
      const ws = await root(body)
      const rel = String(body?.path ?? '')
      const card = await store.readCard(ws, rel)
      if (!card.ok) return card
      // 底图：优先用导入时的原件，否则造一张 1x1 白图
      let base = null
      const rawRel = card.data?.cc?.source_file
      if (typeof rawRel === 'string' && rawRel.endsWith('.png')) {
        base = await fs.readFile(path.join(ws, rawRel)).catch(() => null)
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
      const rel = String(body?.path ?? '')
      const card = await store.readCard(ws, rel)
      if (!card.ok) return card
      const json = codec.lifeCardToCc({ data: card.data, sections: card.sections }, { asV3: true })
      return { ok: true, path: rel, json, filename: `${core.safeId(card.data?.name ?? 'card')}.json` }
    },

    /** 加材料（文本问答 / 访谈回答）。 */
    'material.add': async (body) => {
      const ws = await root(body)
      const about = String(body?.about ?? '')
      const content = String(body?.content ?? '')
      if (content.trim() === '') return { ok: false, error: '内容为空' }
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
    'analyze.run': async (body) => {
      const ws = await root(body)
      const aboutId = String(body?.about ?? '')
      if (aboutId === '') return { ok: false, error: '没指定要分析谁' }
      const materials = await store.readMaterials(ws)
      const names = Object.keys(materials)
      if (names.length === 0) return { ok: false, error: 'materials/ 里没有材料，先加一段文本或做一次访谈' }
      const chosen = Array.isArray(body?.materials) && body.materials.length > 0
        ? Object.fromEntries(Object.entries(materials).filter(([k]) => body.materials.includes(k) || body.materials.includes(path.basename(k))))
        : materials
      if (Object.keys(chosen).length === 0) return { ok: false, error: '选中的材料都不存在' }
      const aboutName = String(body?.name ?? aboutId)
      const prompt = prompts.buildAnalyzePrompt({
        aboutId,
        aboutName,
        materials: chosen,
        schemaHint: prompts.SCHEMA_HINT,
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
          error: `模型没有返回可解析的 JSON（试了 ${tried.length} 次）`,
          attempts: tried,
          raw: String(called.text ?? '').slice(0, 2000),
          hint: '可以把材料拆短一点再试，或者在插件配置里换一个 defaultAnalysisModel。',
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
      const rel = String(body?.json ?? '')
      if (!rel.endsWith('.json')) return { ok: false, error: '路径不合法' }
      const read = await store.readProposal(ws, rel)
      if (!read.ok) return read
      return { ok: true, json: rel, md: read.mdRel, about: read.record?.about?.id, items: read.items, checked: read.checkedCount, rejected: read.record?.rejected ?? [] }
    },

    /** 采纳勾选。 */
    'proposal.apply': async (body) => {
      const ws = await root(body)
      const rel = String(body?.json ?? '')
      if (!rel.endsWith('.json')) return { ok: false, error: '路径不合法' }
      return await store.applyProposal(ws, rel)
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
      return { ok: true, ...summary, host }
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
      return {
        ok: true,
        about: aboutId,
        relation: relationId,
        coverage: cov.percent,
        empty: cov.empty.map((e) => e.label),
        next: ordered.slice(0, Number(body?.limit ?? 3)),
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
      if (aboutId === '' || questionId === '') return { ok: false, error: '缺少 about 或 q' }
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

/** 把材料写进 worlds/。 */
async function importWorldInfo(ws, json, fileName) {
  const id = core.safeId(String(json?.name ?? path.basename(fileName, path.extname(fileName))))
  const rel = path.posix.join('worlds', id, 'world.md')
  const entries = normalizeWorldEntries(json)
  const lines = []
  for (const entry of entries) {
    lines.push(`- keys: [${(entry.keys ?? []).map((k) => JSON.stringify(k)).join(', ')}]`)
    lines.push(`  content: ${JSON.stringify(entry.content ?? '').slice(0, 4000)}`)
    if (entry.comment !== undefined) lines.push(`  comment: ${JSON.stringify(entry.comment)}`)
    lines.push(`  insertion_order: ${Number(entry.insertion_order ?? 100)}`)
    if (entry.enabled !== undefined) lines.push(`  enabled: ${entry.enabled === true}`)
  }
  const data = { lifecard: core.DATA_VERSION, id, kind: 'world', name: String(json?.name ?? id), genre: 'imported' }
  const sections = [{ title: '世界书条目', body: lines.join('\n') }]
  await fs.mkdir(path.dirname(path.join(ws, rel)), { recursive: true })
  const written = await store.writeCard(ws, rel, data, sections, { force: true })
  return { id, path: rel, entries: entries.length, written: written.ok }
}

/** ST 的独立世界书 entries 可能是对象（uid 为键）或数组。统一成数组。 */
function normalizeWorldEntries(json) {
  const raw = json?.entries ?? json?.data?.entries ?? []
  const list = Array.isArray(raw)
    ? raw
    : Object.keys(raw).map((k) => raw[k]).filter((e) => e !== null && typeof e === 'object')
  return list.map((e) => ({
    keys: Array.isArray(e.key) ? e.key : Array.isArray(e.keys) ? e.keys : [],
    content: String(e.content ?? ''),
    comment: e.comment,
    insertion_order: e.order ?? e.insertion_order,
    enabled: e.disable === true ? false : e.enabled ?? true,
  }))
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
