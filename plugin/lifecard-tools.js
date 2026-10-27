/**
 * lifecard-tools — 把 LifeCard 里的人物卡、世界书交给 DSH 自己的对话。
 *
 * 为什么单独一个文件：酒馆和写小说原来是在插件自己的界面里说话。用户要的是
 * 「和正常对话一样，在新会话里打开」——那就不能自建聊天框，得让 DSH 的普通
 * 会话能读到这些卡。这个文件就是那条通路：一组只读工具，模型想演谁、想写谁，
 * 先来这儿把人和世界取走。
 *
 * 只读。改卡还是走插件界面，免得模型手一滑把用户写的东西洗掉。
 *
 * 挂法（见 cordis.patch.yml）：宿主那一层插一行本文件，预设里的
 * plugins 再引用一次，于是「LC 酒馆 / LC 小说」这些门里也能用。
 */
import path from 'node:path'
import os from 'node:os'

import * as core from './lib/core.js'
import * as store from './lib/store.js'

// 这几个和 lib/index.js 里是同一套约定。故意在这里重写一遍、不从 index.js
// import：工具是被主插件在 apply 里调起来的，反过来 import index.js 会绕成
// 循环依赖，宿主加载时可能拿到半截模块。
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv)
  return path.join(os.homedir(), '.dsh')
}

function pointerFile() {
  return path.join(dshHome(), 'plugin-data', 'dsh-lifecard.json')
}

async function recalledWorkspace() {
  try {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(pointerFile(), 'utf8')
    const parsed = JSON.parse(raw)
    return typeof parsed?.workspace === 'string' && parsed.workspace.trim() !== '' ? path.resolve(parsed.workspace) : ''
  } catch {
    return ''
  }
}

function defaultRoot() {
  return path.join(os.homedir(), 'LifeCard')
}

const textOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  render: (_args, value) => [{ type: 'text', text: value.text }],
}

/** 配置里写的路径（支持 ~ 开头）。 */
function configuredWorkspace(config) {
  const raw = typeof config?.workspace === 'string' ? config.workspace.trim() : ''
  if (raw === '') return ''
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2))
  return path.resolve(raw)
}

/**
 * 这个工具在哪个文件夹里找卡：
 * ① 预设里写死的 workspace ② 用户在插件里上次选的文件夹 ③ 默认的 ~/LifeCard。
 */
async function resolveRoot(config) {
  const configured = configuredWorkspace(config)
  if (configured !== '') return configured
  try {
    const recalled = await recalledWorkspace()
    if (typeof recalled === 'string' && recalled !== '') return recalled
  } catch { /* 读不到指针就退回默认位置 */ }
  return defaultRoot()
}

const KIND_LABEL = { real: '现实里的人', fictional: '虚构角色', self: '自己', hybrid: '半真半虚构' }

function kindOf(card) {
  const kind = String(card?.kind ?? '')
  return KIND_LABEL[kind] ?? (kind === '' ? '没写是哪种' : kind)
}

/** 「妈妈（现实里的人 · 母亲）」这种一行摘要。 */
function cardLine(card) {
  const bits = [kindOf(card)]
  const relation = String(card?.relation ?? '').trim()
  if (relation !== '') bits.push(relation)
  const world = String(card?.world ?? '').trim()
  if (world !== '' && world !== 'reality') bits.push(`世界：${world}`)
  return `${card?.name ?? '(还没起名字)'}（${bits.join(' · ')}）`
}

/** 按 id / 名字 / 路径找一张卡。 */
async function findCard(root, wanted) {
  const want = String(wanted ?? '').trim()
  if (want === '') return null
  // findCardByRelOrId 回的是**相对路径**（不是卡本身），按 id 和名字都能查到。
  const rel = await store.findCardByRelOrId(root, want)
  if (typeof rel !== 'string' || rel === '') return null
  const read = await store.readCard(root, rel)
  return read?.ok === true ? read : null
}

/** 读世界书条目；找不到返回空数组。 */
async function worldEntries(root, wanted) {
  const want = String(wanted ?? '').trim()
  if (want === '') return []
  const all = await store.listAll(root)
  const worlds = Array.isArray(all.worlds) ? all.worlds : []
  const hit = worlds.find((w) => String(w.id ?? '') === want || String(w.name ?? '').trim() === want || String(w.path ?? '') === want)
  if (hit === undefined) return []
  const read = await store.readCard(root, hit.path)
  if (read?.ok !== true) return []
  const parsed = core.parseWorldEntries(read.sections ?? [])
  return Array.isArray(parsed) ? parsed : []
}

function entriesToText(entries) {
  if (entries.length === 0) return '（这本世界书里还没有条目）'
  return entries.map((e, i) => {
    const keys = Array.isArray(e.keys) ? e.keys.join('、') : String(e.keys ?? '')
    const always = e.constant === true ? '（每轮都带上）' : (keys === '' ? '' : `（说到${keys}时带上）`)
    return `${i + 1}. ${String(e.content ?? '').trim()}${always}`
  }).join('\n')
}

/**
 * 把 5 个只读工具挂到 ctx.tools 上。
 *
 * 由 lib/index.js 的 apply 在 tools 服务就绪后调用（宿主那一层注册一次），
 * 所以不只是 LC 三个预设，任何预设里都能调。
 */
export function registerTools(ctx, config) {
  if (ctx?.tools?.register === undefined) return false
  /** 统一注册：把「字符串或抛错」变成模型看得懂的文本。 */
  function register(toolName, description, properties, required, run) {
    ctx.tools.register({
      name: toolName,
      description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      output: textOutput,
      async execute(args) {
        try {
          return { text: String(await run(args ?? {}) ?? '') }
        } catch (error) {
          return { text: `这一步没做成：${error instanceof Error ? error.message : String(error)}` }
        }
      },
    })
  }

  register(
    'lifecard_cards',
    [
      '列出用户在 LifeCard 里写的人物卡（名字、是现实里的人还是虚构角色、关系）。',
      '演一个人之前、写一章之前先调它，确认要用的卡叫什么。',
    ].join('\n'),
    {
      kind: { type: 'string', enum: ['real', 'fictional'], description: '可选：只要现实里的人，或只要虚构角色。' },
    },
    [],
    async (args) => {
      const root = await resolveRoot(config)
      const all = await store.listAll(root)
      const cards = Array.isArray(all.cards) ? all.cards : []
      if (cards.length === 0) return `这个文件夹里还没有卡：${root}`
      const want = String(args.kind ?? '')
      const picked = want === '' ? cards : cards.filter((c) => String(c.kind ?? '') === want)
      if (picked.length === 0) return `没有「${KIND_LABEL[want] ?? want}」这一类卡。全部卡：\n` + cards.map((c) => `- ${cardLine(c)}`).join('\n')
      return `一共 ${picked.length} 张：\n` + picked.map((c) => `- ${cardLine(c)}`).join('\n')
    },
  )

  register(
    'lifecard_card',
    [
      '取一张卡的全部内容：自述、性格、说话习惯、边界、开场白、对话示例。',
      '演这个人的时候，按这里的「说话习惯」和「不会说的话」来说话，别自己编。',
    ].join('\n'),
    {
      card: { type: 'string', description: '卡的名字，或者卡的 id（不知道就先调 lifecard_cards）。' },
    },
    ['card'],
    async (args) => {
      const root = await resolveRoot(config)
      const card = await findCard(root, args.card)
      if (card === null) return `没找到叫「${String(args.card ?? '')}」的卡。`
      const data = card.data ?? {}
      const sections = Array.isArray(card.sections) ? card.sections : []
      const lines = [`${cardLine(data)}`]
      const tags = Array.isArray(data.tags) ? data.tags : []
      if (tags.length > 0) lines.push(`标签：${tags.join('、')}`)
      const body = sections
        .filter((s) => s?.title !== undefined && String(s.body ?? '').trim() !== '')
        .map((s) => `## ${s.title}\n${String(s.body).trim()}`)
        .join('\n\n')
      lines.push(body === '' ? '（这张卡正文还是空的）' : body)
      return lines.join('\n')
    },
  )

  register(
    'lifecard_default',
    [
      '用户在 LifeCard 里为每扇门选好的「现在用哪张卡」：酒馆那扇门现在演谁、写小说那扇门现在写谁。',
      '用户没特别指定的时候，就按这里说的来。',
    ].join('\n'),
    {},
    [],
    async () => {
      const root = await resolveRoot(config)
      const state = await store.readConfigState(root)
      const pins = state.config?.default_cards ?? {}
      const rows = [
        ['tavern', '酒馆（现在的演的是谁）'],
        ['novel', '写小说（现在写的是谁）'],
        ['real', '真实人物记录（首页先看谁）'],
      ]
      const out = []
      for (const [key, label] of rows) {
        const id = String(pins[key] ?? '').trim()
        if (id === '') { out.push(`${label}：还没选`); continue }
        const card = await findCard(root, id)
        out.push(`${label}：${card === null ? `${id}（这张卡可能被删了）` : cardLine(card.data)}`)
      }
      return out.join('\n')
    },
  )

  register(
    'lifecard_roleplay',
    [
      '一次取齐「演这一段」要用的东西：这个人的全部设定 + 会用到的那本世界书 + 之前收过尾的摘要。',
      '不给 card 就用用户为酒馆门选好的那一张。',
    ].join('\n'),
    {
      card: { type: 'string', description: '可选：要演谁（名字或 id）。不给就按用户选好的默认卡。' },
      world: { type: 'string', description: '可选：要用的世界书名字或 id。不给就用这张卡自己挂的那本。' },
    },
    [],
    async (args) => {
      const root = await resolveRoot(config)
      let wanted = String(args.card ?? '').trim()
      if (wanted === '') {
        const state = await store.readConfigState(root)
        wanted = String(state.config?.default_cards?.tavern ?? '').trim()
      }
      if (wanted === '') return '还没有挑要演谁。先在 LifeCard 的酒馆那扇门里选一张卡（「现在演谁」）。'
      const card = await findCard(root, wanted)
      if (card === null) return `没找到叫「${wanted}」的卡。`
      const data = card.data ?? {}
      const sections = Array.isArray(card.sections) ? card.sections : []
      const persona = [
        core.sectionBody(sections, '自述'),
        core.sectionBody(sections, '性格'),
        core.sectionBody(sections, '口癖'),
        core.sectionBody(sections, '外貌'),
        core.sectionBody(sections, '不会说的话'),
        core.sectionBody(sections, '不会做的事'),
        core.sectionBody(sections, '场景'),
      ].filter((s) => typeof s === 'string' && s.trim() !== '').join('\n\n')
      const worldWant = String(args.world ?? '').trim() === '' ? String(data.world ?? '') : String(args.world)
      const entries = await worldEntries(root, worldWant)
      const out = [`# 要演的人：${cardLine(data)}`, '', persona === '' ? '（这张卡的正文还是空的，先按名字和关系演）' : persona]
      if (worldWant !== '' && worldWant !== 'reality') {
        out.push('', `# 世界书：${worldWant}`, entriesToText(entries))
      } else {
        out.push('', '# 世界书', '（这一场没有挂世界书，按现实或你俩当下的场景演）')
      }
      const greeting = String(core.sectionBody(sections, '开场白') ?? '').trim()
      if (greeting !== '') out.push('', '# 卡上写的开场白（可以参考它开口，不必一字不差）', greeting)
      const examples = String(core.sectionBody(sections, '对话示例') ?? '').trim()
      if (examples !== '') out.push('', '# 这个人说话的样例', examples.slice(-1600))
      return out.join('\n')
    },
  )

  register(
    'lifecard_world',
    [
      '看一本世界书里有哪些条目：什么情况下会带进来、内容是什么。',
      '写小说要保证设定前后一致时用；演的时候也可以先看一眼规矩。',
    ].join('\n'),
    {
      world: { type: 'string', description: '世界书的名字或 id。' },
    },
    ['world'],
    async (args) => {
      const root = await resolveRoot(config)
      const all = await store.listAll(root)
      const worlds = Array.isArray(all.worlds) ? all.worlds : []
      if (worlds.length === 0) return '这个文件夹里还没有世界书。'
      const names = worlds.map((w) => `- ${w.name ?? w.id}（${w.entry_count ?? 0} 条）`).join('\n')
      const entries = await worldEntries(root, args.world)
      if (entries.length === 0) return `没找到「${String(args.world ?? '')}」这本世界书。现有的：\n${names}`
      return `《${String(args.world)}》里的条目：\n${entriesToText(entries)}`
    },
  )

  // ── 从导入的材料里提炼：先读，再（经用户同意）写 ───────────────────
  //
  // 这一组是唯一会写盘的。规矩是死的：
  //   1. 没带 approved=true 一律不写，只回「先把候选列给用户看」；
  //   2. 每一段/每一条都必须附一句材料里的原句，写之前逐字比对；
  //   3. 对不上就整次拒绝，并说清是哪一条对不上 —— 不猜、不模糊匹配。
  // 理由：小说和日记一旦被「大概提炼」，卡上就会多出用户没写过的话，
  // 而这种错不会报错，只会慢慢变成「我什么时候写过这个」。

  register(
    'lifecard_materials',
    [
      '列出这个文件夹里所有材料（导入的小说、日记、访谈原文）。',
      '想把材料里的人或世界提炼成卡/世界书时，先用它看有哪些材料可用。',
    ].join('\n'),
    {},
    [],
    async () => {
      const root = await resolveRoot(config)
      const materials = await store.readMaterials(root)
      const rels = Object.keys(materials).sort()
      if (rels.length === 0) return '这个文件夹里还没有材料。先把文字导进来，再说提炼。'
      const lines = rels.map((rel) => `- ${rel}（${String(materials[rel] ?? '').length} 字）`)
      return `现有材料 ${rels.length} 份：\n${lines.join('\n')}`
    },
  )

  register(
    'lifecard_material',
    [
      '读一份材料的正文。想提炼人物或世界观，先把它读进来。',
      '材料很长时会截断，并告出总字数。',
    ].join('\n'),
    {
      material: { type: 'string', description: '材料的路径或文件名，比如 materials/2026-10-26-某篇小说.md。' },
    },
    ['material'],
    async (args) => {
      const root = await resolveRoot(config)
      const materials = await store.readMaterials(root)
      const picked = pickMaterial(materials, args.material)
      if (picked === null) {
        const rels = Object.keys(materials).sort()
        return rels.length === 0
          ? '这个文件夹里还没有材料。'
          : `没找到「${String(args.material ?? '')}」这份材料。现有的：\n${rels.map((r) => `- ${r}`).join('\n')}`
      }
      const text = String(materials[picked] ?? '')
      const cap = 12000
      const head = text.slice(0, cap)
      const tail = text.length > cap ? `\n\n（后面还有 ${text.length - cap} 字没显示，需要的话按段落分几次读。）` : ''
      return `# ${picked}（共 ${text.length} 字）\n\n${head}${tail}`
    },
  )

  register(
    'lifecard_import_character',
    [
      '把材料里的一个人写成角色卡。**只有用户明确同意之后才调用。**',
      '流程：先用 lifecard_materials / lifecard_material 读材料，把打算写成什么列给用户看（名字、几段、每段大意），',
      '等用户说「可以 / 就这么写」，再带 approved: true 调这一次。',
      '每一段都必须附一句材料里的原句（quote），写之前会逐字比对；对不上整次不写。',
      '不给 approved: true 时不会写任何东西，只会告诉你还差哪一步。',
    ].join('\n'),
    {
      approved: { type: 'boolean', description: '用户是否已经明确同意写入。必须为 true 才会真的建卡。' },
      material: { type: 'string', description: '素材从哪来：材料的路径或文件名。' },
      name: { type: 'string', description: '这个人叫什么。' },
      world: { type: 'string', description: '归到哪本世界书下；不填就是 reality。' },
      relation: { type: 'string', description: '和「我」的关系（可选）。' },
      sections: {
        type: 'array',
        description: '要写进卡的段落。每项 { title, body, quote }：title 用小节名（自述/性格/场景/口癖/外貌/不会说的话…），body 是要写进卡的话，quote 是材料里支撑它的原句。',
      },
    },
    ['approved', 'material', 'name', 'sections'],
    async (args) => {
      const root = await resolveRoot(config)
      const name = String(args.name ?? '').trim()
      if (name === '') return '这个人的名字是空的，先问清他叫什么。'

      const materials = await store.readMaterials(root)
      const picked = pickMaterial(materials, args.material)
      if (picked === null) return `没找到「${String(args.material ?? '')}」这份材料，先确认材料名。`
      const source = String(materials[picked] ?? '')

      const rows = Array.isArray(args.sections) ? args.sections : []
      if (rows.length === 0) return '一段都没有，那就没东西可写。先定下要写哪几段。'
      const bad = []
      const sections = []
      for (const row of rows) {
        const title = String(row?.title ?? '').trim()
        const body = String(row?.body ?? '').trim()
        const quote = String(row?.quote ?? '').trim()
        if (title === '' || body === '') { bad.push(`（有一段没写小节名或内容是空的）`); continue }
        if (quote === '') { bad.push(`「${title}」这一段没给原句`); continue }
        if (!hasQuote(source, quote)) { bad.push(`「${title}」引的原句在材料里找不到：${quote.slice(0, 40)}…`); continue }
        sections.push({ title, body })
      }
      if (bad.length > 0) {
        return `这一版没写。下面这些对不上材料：\n${bad.map((b) => `- ${b}`).join('\n')}\n\n改好之后再来一次。`
      }

      if (args.approved !== true) {
        const preview = sections.map((x) => `- ${x.title}：${x.body.slice(0, 60)}${x.body.length > 60 ? '…' : ''}`).join('\n')
        return [
          `还没写。先把这一版列给用户看，等他明确说要，再带 approved: true 重调一次。`,
          '',
          `人物：${name}`,
          `材料：${picked}`,
          `段落：`,
          preview,
        ].join('\n')
      }

      const data = {
        lifecard: core.DATA_VERSION,
        id: core.safeId(name),
        kind: 'fictional',
        name,
        world: String(args.world ?? '').trim() === '' ? 'reality' : String(args.world).trim(),
      }
      const relation = String(args.relation ?? '').trim()
      if (relation !== '') data.relation = relation
      const rel = store.cardRelPath(data.id, data.world)
      const saved = await store.writeCard(root, rel, data, sections)
      if (saved.ok !== true) return `没能写成：${String(saved.error ?? '存盘失败')}`
      return `写好了：${saved.path}\n${sections.length} 段，每段都对着材料里的原句核过。\n要接着补，就再调一次 lifecard_import_character（同名会覆盖，段落以这次为准）。`
    },
  )

  register(
    'lifecard_import_world',
    [
      '把材料里的一套设定整理成世界书。**只有用户明确同意之后才调用。**',
      '流程同 lifecard_import_character：先读材料、把候选条目（触发词 + 内容 + 依据原句）列给用户看，',
      '等用户点头，再带 approved: true 调这一次。每条都要附原句，逐字比对，对不上整次不写。',
    ].join('\n'),
    {
      approved: { type: 'boolean', description: '用户是否已经明确同意写入。必须为 true 才会真的建世界书。' },
      material: { type: 'string', description: '素材从哪来：材料的路径或文件名。' },
      name: { type: 'string', description: '这本世界书叫什么（地方/时代/势力都行）。' },
      genre: { type: 'string', description: '一句话说这是什么类型的设定（可选）。' },
      entries: {
        type: 'array',
        description: '条目数组。每项 { keys, content, quote }：keys 是触发用的关键词（字符串或数组），content 是这条设定本身，quote 是材料里支撑它的原句。',
      },
    },
    ['approved', 'material', 'name', 'entries'],
    async (args) => {
      const root = await resolveRoot(config)
      const name = String(args.name ?? '').trim()
      if (name === '') return '这本世界书的名字是空的，先问清它叫什么。'

      const materials = await store.readMaterials(root)
      const picked = pickMaterial(materials, args.material)
      if (picked === null) return `没找到「${String(args.material ?? '')}」这份材料，先确认材料名。`
      const source = String(materials[picked] ?? '')

      const rows = Array.isArray(args.entries) ? args.entries : []
      if (rows.length === 0) return '一条设定都没有，那就没东西可写。'
      const bad = []
      const entries = []
      for (const row of rows) {
        const content = String(row?.content ?? '').trim()
        const quote = String(row?.quote ?? '').trim()
        const rawKeys = row?.keys
        const keys = (Array.isArray(rawKeys) ? rawKeys : String(rawKeys ?? '').split(/[,，、]/))
          .map((k) => String(k).trim()).filter((k) => k !== '')
        if (content === '') { bad.push('有一条没有内容'); continue }
        if (quote === '') { bad.push(`「${content.slice(0, 20)}…」这条没给原句`); continue }
        if (!hasQuote(source, quote)) { bad.push(`「${content.slice(0, 20)}…」引的原句在材料里找不到`); continue }
        entries.push({ keys, content, insertion_order: 100 })
      }
      if (bad.length > 0) {
        return `这一版没写。下面这些对不上材料：\n${bad.map((b) => `- ${b}`).join('\n')}\n\n改好之后再来一次。`
      }

      if (args.approved !== true) {
        const preview = entries.map((e) => `- [${e.keys.join(' / ') || '常驻'}] ${e.content.slice(0, 50)}${e.content.length > 50 ? '…' : ''}`).join('\n')
        return [
          '还没写。先把这一版列给用户看，等他明确说要，再带 approved: true 重调一次。',
          '',
          `世界书：${name}`,
          `材料：${picked}`,
          `条目：`,
          preview,
        ].join('\n')
      }

      const id = core.safeId(name)
      const data = {
        lifecard: core.DATA_VERSION,
        id,
        kind: 'world',
        name,
        genre: String(args.genre ?? '').trim(),
        entry_count: entries.length,
      }
      const body = entries.map((e) => renderWorldEntry(e)).join('\n')
      const rel = path.posix.join('worlds', id, 'world.md')
      const saved = await store.writeCard(root, rel, data, [{ title: '世界书条目', body }])
      if (saved.ok !== true) return `没能写成：${String(saved.error ?? '存盘失败')}`
      return `写好了：${saved.path}\n${entries.length} 条，每条都对着材料里的原句核过。`
    },
  )

  return true
}

/** 比对原句时先把空白和换行抹平：材料里的一句常被折行，逐字比会假失败。 */
function squash(text) {
  return String(text ?? '').replace(/\s+/g, '')
}

/** 材料里到底有没有这句话。宁可放过折行，绝不放过「差不多」。 */
function hasQuote(source, quote) {
  const q = squash(quote)
  if (q === '') return false
  return squash(source).includes(q)
}

/** 按路径、文件名、或独一无二的片段找那份材料。找不到回 null。 */
function pickMaterial(materials, want) {
  const key = String(want ?? '').trim()
  if (key === '') return null
  const rels = Object.keys(materials)
  if (Object.hasOwn(materials, key)) return key
  const norm = key.replace(/\\/g, '/')
  const same = rels.filter((rel) => rel === norm || rel.endsWith('/' + norm) || path.posix.basename(rel) === norm)
  if (same.length === 1) return same[0]
  if (same.length > 1) return same[0]
  const loose = rels.filter((rel) => rel.includes(norm))
  return loose.length === 1 ? loose[0] : null
}

/** 一条世界书条目 → `- ` 开头的 YAML 块（parseWorldEntries 认这个形状）。 */
function renderWorldEntry(entry) {
  const keys = Array.isArray(entry.keys) ? entry.keys : []
  const lines = [`- keys: ${JSON.stringify(keys)}`]
  lines.push(`  insertion_order: ${Number.isFinite(entry.insertion_order) ? entry.insertion_order : 100}`)
  lines.push('  content: |-')
  for (const line of String(entry.content ?? '').split(/\r?\n/)) lines.push(`    ${line}`)
  return lines.join('\n')
}
