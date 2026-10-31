/**
 * lifecard-tools — 把 LifeCard 里的人物卡、世界书交给 DSH 自己的对话。
 *
 * 为什么单独一个文件：酒馆和写小说原来是在插件自己的界面里说话。用户要的是
 * 「和正常对话一样，在新会话里打开」——那就不能自建聊天框，得让 DSH 的普通
 * 会话能读到这些卡。这个文件就是那条通路：模型想演谁、想写谁，先来这儿把人和
 * 世界取走；聊出来的东西（日记）也从这儿写回去。
 *
 * 默认只读。会写盘的只有四把工具，而且都有一道门：改卡走 approved + 原句核对，
 * 写日记只写用户这一回亲口讲的那一天、绝不静默覆盖。其余工具只看不改，
 * 免得模型手一滑把用户写的东西洗掉。
 *
 * 挂法（见 cordis.patch.yml）：宿主那一层插一行本文件，预设里的
 * plugins 再引用一次，于是「LC 酒馆 / LC 小说」这些门里也能用。
 */
import path from 'node:path'
import os from 'node:os'
import { readdir } from 'node:fs/promises'

import * as core from './lib/core.js'
import * as store from './lib/store.js'
import { DIARY_SECTIONS, diaryRootFrom, readDiary, listDiaries, writeDiary, diaryBlock } from './lib/diary.js'

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
 * 把这一组工具挂到 ctx.tools 上。
 *
 * 由 lib/index.js 的 apply 在 tools 服务就绪后调用（宿主那一层注册一次），
 * 所以不只是 LC 几个预设，任何预设里都能调。
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
      // 卡上写什么就给什么：不删、不改写。删过的卡就不是那张卡了（用户原话）。
      const personaText = persona
      const worldWant = String(args.world ?? '').trim() === '' ? String(data.world ?? '') : String(args.world)
      const entries = await worldEntries(root, worldWant)
      const out = [`# 要演的人：${cardLine(data)}`, '', personaText === '' ? '（这张卡的正文还是空的，先按名字和关系演）' : personaText]
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
      '已经有同名的卡时，默认只补空缺：原来写过的小节和字段一个字都不动，返回里会说补了哪几节。',
      '只有用户明确要求整张重写时，才带 mode: "replace" 与 confirm_replace: true；缺一次就只回一句确认，不写。',
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
      mode: {
        type: 'string',
        enum: ['merge', 'replace'],
        description: '同名已有卡时怎么办：merge（默认）只补空缺；replace 整张重写，必须同时带 confirm_replace: true。',
      },
      confirm_replace: { type: 'boolean', description: '整张重写时的第二次确认。用户第二次明确说要覆盖才传 true。' },
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

      const id = core.safeId(name)
      const incoming = {
        lifecard: core.DATA_VERSION,
        id,
        kind: 'fictional',
        name,
        world: String(args.world ?? '').trim() === '' ? 'reality' : String(args.world).trim(),
      }
      const relation = String(args.relation ?? '').trim()
      if (relation !== '') incoming.relation = relation
      const rel = store.cardRelPath(id, incoming.world)
      const mode = args.mode === 'replace' ? 'replace' : 'merge'

      const existingRel = await findExisting(root, rel, id)
      if (existingRel !== null) {
        const already = await store.readCard(root, existingRel)
        if (already.ok !== true) {
          if (already.withdrawn === true || isWithdrawnAt(root, existingRel)) return withdrawnNote(existingRel, '卡')
          return `已经有一张同名的卡（${existingRel}），可这会儿读不出来：${String(already.error ?? '读不出来')}。先把它弄好，再来写。`
        }
        if (mode === 'replace') {
          if (args.confirm_replace !== true) {
            return [
              `已经有一张同名的卡：${existingRel}`,
              '整张重写会连身份、关系、原来写过的小节一起换掉，换完就找不回来了。',
              '确定要整张重写，就再调一次，带 mode: "replace" 和 confirm_replace: true。',
              '只想往里补，就不用改参数——默认只补空缺，原来的字一个不动。',
            ].join('\n')
          }
          const replaced = await store.writeCard(root, existingRel, incoming, sections)
          if (replaced.ok !== true) return `没能写成：${String(replaced.error ?? '存盘失败')}`
          return `整张换掉了：${replaced.path}\n${sections.length} 段，每段都对着材料里的原句核过。这次是按用户第二次确认整张覆盖写的。`
        }
        const mergedData = mergeData(already.data, incoming)
        const mergedSections = mergeSections(already.sections, sections)
        if (mergedSections.added.length === 0 && mergedData.filled.length === 0) {
          return `这张卡已经有了，这次没有可补的：${existingRel}\n原有的内容一个字没动。\nmerged: true`
        }
        const saved = await store.writeCard(root, existingRel, mergedData.data, mergedSections.sections)
        if (saved.ok !== true) return `没能写成：${String(saved.error ?? '存盘失败')}`
        const bits = []
        if (mergedSections.added.length > 0) bits.push(`补了 ${mergedSections.added.length} 节：${mergedSections.added.join('、')}`)
        if (mergedData.filled.length > 0) bits.push(`补了 ${mergedData.filled.length} 项：${mergedData.filled.join('、')}`)
        return [
          `补好了（没有重写）：${saved.path}`,
          ...bits,
          '原来写过的内容一个字没动，身份也还是原来的。',
          'merged: true',
        ].join('\n')
      }

      // 只比路径会漏：id 是拼音、名字是中文时（people/rat.card.md 那种），
      // 按名字再写会算出另一个路径，于是同一个人并排出现两张，点「放回来」就重了。
      const heldCard = await store.withdrawnNameHit(root, rel, [id, name])
      if (isWithdrawnAt(root, rel) || heldCard !== null) {
        return withdrawnNote(heldCard?.path ?? rel, '卡')
      }
      const saved = await store.writeCard(root, rel, incoming, sections)
      if (saved.ok !== true) return `没能写成：${String(saved.error ?? '存盘失败')}`
      return `写好了：${saved.path}\n${sections.length} 段，每段都对着材料里的原句核过。\n要接着补，就再调一次 lifecard_import_character（同名的卡默认只补空缺，已有的字不动）。`
    },
  )

  register(
    'lifecard_import_world',
    [
      '把材料里的一套设定整理成世界书。**只有用户明确同意之后才调用。**',
      '流程同 lifecard_import_character：先读材料、把候选条目（触发词 + 内容 + 依据原句）列给用户看，',
      '等用户点头，再带 approved: true 调这一次。每条都要附原句，逐字比对，对不上整次不写。',
      '已经有同名的世界书时，默认只补空缺：新条目加进去，触发词对得上的并进已有条目，原来的条目一个字不动。',
      '只有用户明确要求整份重写时，才带 mode: "replace" 与 confirm_replace: true；缺一次就只回一句确认，不写。',
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
      mode: {
        type: 'string',
        enum: ['merge', 'replace'],
        description: '同名已有世界书时怎么办：merge（默认）只补空缺、按触发词并条目；replace 整份重写，必须同时带 confirm_replace: true。',
      },
      confirm_replace: { type: 'boolean', description: '整份重写时的第二次确认。用户第二次明确说要覆盖才传 true。' },
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
      const incoming = {
        lifecard: core.DATA_VERSION,
        id,
        kind: 'world',
        name,
        genre: String(args.genre ?? '').trim(),
        entry_count: entries.length,
      }
      const rel = path.posix.join('worlds', id, 'world.md')
      const mode = args.mode === 'replace' ? 'replace' : 'merge'

      const existingRel = await findWorld(root, rel, name)
      if (existingRel !== null) {
        const already = await store.readCard(root, existingRel)
        if (already.ok !== true) {
          if (already.withdrawn === true || isWithdrawnAt(root, existingRel)) return withdrawnNote(existingRel, '世界书')
          return `已经有一本同名的世界书（${existingRel}），可这会儿读不出来：${String(already.error ?? '读不出来')}。先把它弄好，再来写。`
        }
        if (mode === 'replace') {
          if (args.confirm_replace !== true) {
            return [
              `已经有一本同名的世界书：${existingRel}`,
              '整份重写会把原来的条目全换掉，换完就找不回来了。',
              '确定要整份重写，就再调一次，带 mode: "replace" 和 confirm_replace: true。',
              '只想往里加，就不用改参数——默认只补空缺，原来的条目一个不动。',
            ].join('\n')
          }
          const body = entries.map((e) => renderWorldEntry(e)).join('\n')
          const replaced = await store.writeCard(root, existingRel, incoming, [{ title: '世界书条目', body }])
          if (replaced.ok !== true) return `没能写成：${String(replaced.error ?? '存盘失败')}`
          return `整份换掉了：${replaced.path}\n${entries.length} 条，每条都对着材料里的原句核过。这次是按用户第二次确认整份覆盖写的。`
        }
        const oldBody = core.sectionBody(already.sections ?? [], '世界书条目')
        const merged = mergeWorldBlocks(oldBody, entries)
        const mergedData = mergeData(already.data, { ...incoming, entry_count: 0 })
        mergedData.data.entry_count = merged.total
        const hasSection = (already.sections ?? []).some((one) => one?.title === '世界书条目')
        const sections = hasSection
          ? (already.sections ?? []).map((one) => (one?.title === '世界书条目' ? { title: '世界书条目', body: merged.body } : one))
          : [...(already.sections ?? []), { title: '世界书条目', body: merged.body }]
        const saved = await store.writeCard(root, existingRel, mergedData.data, sections)
        if (saved.ok !== true) return `没能写成：${String(saved.error ?? '存盘失败')}`
        const bits = []
        if (merged.added.length > 0) bits.push(`新加 ${merged.added.length} 条：${merged.added.join('、')}`)
        if (merged.joined.length > 0) bits.push(`并进已有条目 ${merged.joined.length} 条：${merged.joined.join('、')}`)
        if (mergedData.filled.length > 0) bits.push(`补了 ${mergedData.filled.length} 项：${mergedData.filled.join('、')}`)
        if (bits.length === 0) bits.push('这次的条目都已经在里面了')
        return [
          `补好了（没有重写）：${saved.path}`,
          ...bits,
          '原来的条目一个字没动。',
          'merged: true',
        ].join('\n')
      }

      const heldWorld = await store.withdrawnNameHit(root, rel, [id, name])
      if (isWithdrawnAt(root, rel) || heldWorld !== null) {
        return withdrawnNote(heldWorld?.path ?? rel, '世界书')
      }
      const body = entries.map((e) => renderWorldEntry(e)).join('\n')
      const saved = await store.writeCard(root, rel, incoming, [{ title: '世界书条目', body }])
      if (saved.ok !== true) return `没能写成：${String(saved.error ?? '存盘失败')}`
      return `写好了：${saved.path}\n${entries.length} 条，每条都对着材料里的原句核过。`
    },
  )

  // ── 写日记顺手养卡：改「我」那张，和陪你写日记的那个助手 ────────────
  //
  // 日记写得越久，越会攒下卡上没有的东西：新认识的人、新的底线、一个说法
  // 被推翻了、一件小事反复出现。这里只做两件事——把「我」那张卡补准，
  // 把日记助手的性子按用户的原话调准。规矩和提炼成卡那组一样：没同意不写、
  // 每一条都要指得出是哪一天哪句话，对不上整次拒绝。

  register(
    'lifecard_refine_card',
    [
      '写日记时顺手把两张卡养准：用户在真实人物记录里那**张「我」自己的卡**，和**陪你写日记的那个助手**。',
      '**只有用户明确同意之后才调用。**先把打算改什么列给他看（改哪一节、改成什么、依据哪一天哪句话），',
      '等他说「可以」，再带 approved: true 调这一次。',
      '每一条都要附一句依据原话（quote），写之前逐字比对；对不上整次不写。',
      '不给 approved: true 时不写任何东西，只告诉你还差哪一步。',
      '默认只补空缺：原来写过的小节和字段一个字都不动，返回里会说补了哪几节。',
      '只有用户明确要求整节重写时，才带 mode: "replace" 与 confirm_replace: true。',
    ].join('\n'),
    {
      target: {
        type: 'string',
        enum: ['self', 'diary'],
        description: '改哪张卡：self 是用户自己那张（「我」），diary 是陪你写日记的那个助手。',
      },
      approved: { type: 'boolean', description: '用户是否已经明确同意写入。必须为 true 才会真的改卡。' },
      from: {
        type: 'string',
        enum: ['diary', 'material'],
        description: '依据从哪来：diary（默认，最近写的日记）还是 material（导入的材料）。',
      },
      date: { type: 'string', description: '只拿这一天的日记做依据，例如 2026-10-31。不填就看最近写的几篇。' },
      material: { type: 'string', description: 'from 是 material 时必填：材料的路径或文件名。' },
      name: { type: 'string', description: '这张卡还没有的时候，用它起名字。改已有的卡不用填。' },
      fields: {
        type: 'array',
        description: '结构字段。每项 { key, value, quote }：key 是字段名（如 relation / tags / competency），value 是新值，quote 是依据原话。',
      },
      sections: {
        type: 'array',
        description: '正文小节。每项 { title, body, quote }：title 用已有的小节名（自述/性格/关系史/口癖/外貌/不会说的话…），body 是要写进去的话，quote 是依据原话。',
      },
      mode: {
        type: 'string',
        enum: ['merge', 'replace'],
        description: '已有内容怎么办：merge（默认）只补空缺；replace 整份重写，必须同时带 confirm_replace: true。',
      },
      confirm_replace: { type: 'boolean', description: '整份重写时的第二次确认。' },
    },
    ['target', 'approved'],
    async (args) => {
      const root = await resolveRoot(config)
      const target = String(args.target ?? '').trim()
      if (target !== 'self' && target !== 'diary') {
        return '要说清改哪一张：target 写 self（用户自己那张）或 diary（陪你写日记的那个助手）。'
      }

      const rowsSections = Array.isArray(args.sections) ? args.sections : []
      const rowsFields = Array.isArray(args.fields) ? args.fields : []
      if (rowsSections.length === 0 && rowsFields.length === 0) {
        return '一处要改的都没有，那就没东西可写。先定下要补哪几节、哪几个字段。'
      }

      const got = await refineSource(root, args)
      if (got.ok !== true) return got.error
      const source = got.text

      const bad = []
      const sections = []
      for (const row of rowsSections) {
        const title = String(row?.title ?? '').trim()
        const body = String(row?.body ?? '').trim()
        const quote = String(row?.quote ?? '').trim()
        if (title === '' || body === '') { bad.push('（有一节没写小节名或内容是空的）'); continue }
        if (quote === '') { bad.push(`「${title}」这一节没给原句`); continue }
        if (!hasQuote(source, quote)) { bad.push(`「${title}」引的原句在${got.where}里找不到：${quote.slice(0, 40)}…`); continue }
        sections.push({ title, body })
      }
      const fields = []
      for (const row of rowsFields) {
        const key = String(row?.key ?? '').trim()
        const quote = String(row?.quote ?? '').trim()
        if (key === '') { bad.push('（有一个字段没写字段名）'); continue }
        if (row?.value === undefined || row?.value === null) { bad.push(`字段 ${key} 没给新值`); continue }
        if (quote === '') { bad.push(`字段 ${key} 没给原句`); continue }
        if (!hasQuote(source, quote)) { bad.push(`字段 ${key} 引的原句在${got.where}里找不到：${quote.slice(0, 40)}…`); continue }
        if (!core.PROPOSAL_FIELDS.includes(key)) { bad.push(`字段 ${key} 不是卡上允许写的名字`); continue }
        fields.push({ key, value: row.value })
      }
      if (bad.length > 0) {
        return `这一版没写。下面这些对不上：\n${bad.map((b) => `- ${b}`).join('\n')}\n\n改好之后再来一次。`
      }

      const held = target === 'self' ? await findSelfCard(root) : await findDiaryAssistant(root)
      if (args.approved !== true) {
        const lines = [
          '还没写。先把这一版列给用户看，等他明确说要，再带 approved: true 重调一次。',
          '',
          `改哪张：${target === 'self' ? '「我」那张卡' : '日记助手那张卡'}`,
          held === null ? '这张卡现在还没有，等你说要，会新建一张。' : `现在是：${held.card?.path ?? held.path}`,
          `依据：${got.where}`,
        ]
        if (sections.length > 0) lines.push('', '补这几节：', ...sections.map((x) => `- ${x.title}：${x.body.slice(0, 60)}${x.body.length > 60 ? '…' : ''}`))
        if (fields.length > 0) lines.push('', '补这几个字段：', ...fields.map((x) => `- ${x.key}：${String(x.value).slice(0, 60)}`))
        return lines.join('\n')
      }

      const mode = args.mode === 'replace' ? 'replace' : 'merge'
      const existing = held === null ? null : held.card ?? held
      const existingRel = existing === null ? null : (existing.path ?? held.path ?? null)

      let card = null
      if (existingRel !== null) {
        const read = await store.readCard(root, existingRel)
        if (read.ok !== true) {
          if (read.withdrawn === true || isWithdrawnAt(root, existingRel)) return withdrawnNote(existingRel, '卡')
          return `这张卡这会儿读不出来：${String(read.error ?? '读不出来')}。先把它弄好，再来改。`
        }
        card = read
      }

      if (card === null) {
        const fallbackName = target === 'self' ? '我' : '日记助手'
        const name = String(args.name ?? '').trim() === '' ? fallbackName : String(args.name).trim()
        const id = core.safeId(name)
        const incoming = {
          lifecard: core.DATA_VERSION,
          id,
          kind: target === 'self' ? 'self' : 'fictional',
          name,
          world: 'reality',
        }
        if (target === 'self') incoming.relation = '我'
        const rel = store.cardRelPath(id, incoming.world)
        const heldName = await store.withdrawnNameHit(root, rel, [id, name])
        if (isWithdrawnAt(root, rel) || heldName !== null) return withdrawnNote(heldName?.path ?? rel, '卡')
        const mergedData = mergeData(incoming, Object.fromEntries(fields.map((f) => [f.key, f.value])))
        const saved = await store.writeCard(root, rel, mergedData.data, sections)
        if (saved.ok !== true) return `没能写成：${String(saved.error ?? '存盘失败')}`
        let pinNote = ''
        if (target === 'diary') {
          const state = await store.readConfigState(root)
          const pins = { ...(state.config?.default_cards ?? {}), diary: id }
          await store.writeConfig(root, { default_cards: pins })
          pinNote = '\n写日记已经默认用这张卡了。'
        }
        return [
          `建好了一张新卡：${saved.path}`,
          sections.length > 0 ? `写了 ${sections.length} 节：${sections.map((x) => x.title).join('、')}` : '',
          fields.length > 0 ? `写了 ${fields.length} 个字段：${fields.map((x) => x.key).join('、')}` : '',
          `依据：${got.where}`,
          '每一条都对着依据原句核过。',
        ].filter((x) => x !== '').join('\n') + pinNote
      }

      const data = card.data ?? {}
      if (mode === 'replace') {
        if (args.confirm_replace !== true) {
          return [
            `这张卡现在是这样：${existingRel}`,
            '整份重写会把原来写过的内容一起换掉，换完就找不回来了。',
            '确定要整份重写，就再调一次，带 mode: "replace" 和 confirm_replace: true。',
            '只想往里补，就不用改参数——默认只补空缺，原来的字一个不动。',
          ].join('\n')
        }
        const incoming = { ...data }
        for (const f of fields) incoming[f.key] = f.value
        const saved = await store.writeCard(root, existingRel, incoming, sections)
        if (saved.ok !== true) return `没能写成：${String(saved.error ?? '存盘失败')}`
        return `整份换掉了：${saved.path}\n这是按用户第二次确认整份覆盖写的。`
      }

      const incoming = Object.fromEntries(fields.map((f) => [f.key, f.value]))
      const mergedData = mergeData(data, incoming)
      const mergedSections = mergeSections(card.sections, sections)
      if (mergedSections.added.length === 0 && mergedData.filled.length === 0) {
        return `这张卡已经有了，这次没有可补的：${existingRel}\n原有的内容一个字没动。\nmerged: true`
      }
      const saved = await store.writeCard(root, existingRel, mergedData.data, mergedSections.sections)
      if (saved.ok !== true) return `没能写成：${String(saved.error ?? '存盘失败')}`
      const bits = []
      if (mergedSections.added.length > 0) bits.push(`补了 ${mergedSections.added.length} 节：${mergedSections.added.join('、')}`)
      if (mergedData.filled.length > 0) bits.push(`补了 ${mergedData.filled.length} 项：${mergedData.filled.join('、')}`)
      return [
        `补好了（没有重写）：${saved.path}`,
        ...bits,
        `依据：${got.where}`,
        '原来写过的内容一个字没动。',
        'merged: true',
      ].join('\n')
    },
  )

  // ── 写今天这一篇 ──────────────────────────────────────────────────
  //
  // 为什么必须有个工具：日记是在**新会话**里聊的，聊天框里的字不会自己变成
  // 文件。没有这个工具时，用户陪着 AI 聊完一整篇，那一篇只活在对话记录里，
  // 磁盘上一个字都没有——「每天一篇存在自己文件夹里」这句承诺是空的。
  //
  // 它和上面几把工具不是一类：不改别人的卡、不改已经定下来的东西，只把用户
  // 这一回亲口讲的话落到他指定的那一天。所以不要 approved，但**绝不静默覆盖**：
  // 这一天已经有内容时，凡是「原来有、这次要写空的」小节都拦下来报给模型。
  register(
    'lifecard_diary_save',
    [
      '把今天这一篇日记存进用户自己的文件夹（一天一篇，文件名就是日期）。',
      '**用户讲完、你把这五节收好之后**再调；不要边聊边存，也不要替他写。',
      'section 的 title 只认这五个：今天最值得讲的一件事 / 当时在想什么 / 情绪往下三层 / 我做了什么决定 / 下一步。',
      '「下一步」一条一行，写成他能勾掉的事。',
      '这一天原来写过东西时，只会更新；凡是要把原来写的东西弄空的，会拦下来让你先问用户。',
    ].join('\n'),
    {
      date: { type: 'string', description: '哪一天，例如 2026-10-31。不填就是今天。' },
      sections: {
        type: 'array',
        description: '五节正文。每项 { title, body }：title 用那五个小节名之一，body 是用户自己说的话（不要替他润色成书面语）。',
      },
      scores: {
        type: 'object',
        description: '可选：健康 / 工作 / 关系 / 玩 各一个 0 到 10 的整数。用户不想打就别传。',
      },
      confirm_overwrite: {
        type: 'boolean',
        description: '这一天原来有内容、这次要少写几节时，问过用户、他确认要删，才传 true。',
      },
    },
    ['sections'],
    async (args) => {
      const root = await resolveRoot(config)
      const state = await store.readConfigState(root)
      if (state.ok !== true) return '读不出来日记放在哪儿。'
      const dir = diaryRootFrom(state.config)
      if (dir === '') {
        return '还没有挑日记放在哪个文件夹。让用户在首页点一次「写日记」，挑好位置之后再存。'
      }

      const date = String(args.date ?? '').trim() === '' ? store.localDate() : String(args.date).trim()
      const rows = Array.isArray(args.sections) ? args.sections : []
      if (rows.length === 0) return '一节都没有，那就没东西可存。'

      const wanted = {}
      const unknown = []
      for (const row of rows) {
        const title = matchSection(String(row?.title ?? '').trim())
        const body = Array.isArray(row?.body)
          ? row.body.map((x) => String(x ?? '').trim()).filter((x) => x !== '').join('\n')
          : String(row?.body ?? '').trim()
        if (title === '') { unknown.push(String(row?.title ?? '')); continue }
        // 同一节写了两遍就接起来，别让后一段悄悄盖掉前一段。
        wanted[title] = wanted[title] === undefined || wanted[title] === '' ? body : `${wanted[title]}\n${body}`
      }
      if (unknown.length > 0) {
        return [
          `这几节的标题我没认出来：${unknown.join('、')}`,
          `只认这五个：${DIARY_SECTIONS.join(' / ')}。`,
          '翻成上面的说法再来一次；实在有第六件事要说，就并进「今天最值得讲的一件事」。',
        ].join('\n')
      }

      const scores = {}
      const rawScores = args.scores !== null && typeof args.scores === 'object' ? args.scores : {}
      for (const [key, value] of Object.entries(rawScores)) {
        const n = Number(value)
        if (!Number.isFinite(n)) continue
        scores[String(key).trim()] = Math.max(0, Math.min(10, Math.round(n)))
      }

      const existing = await readDiary(dir, date)
      if (existing.ok !== true) {
        return `这一天读不出来，为了不把原来的东西弄丢，这次没写：${String(existing.error ?? '')}`
      }

      const before = existing.data === null ? {} : existing.data
      // 用户手改过这篇：多出来的小节、自己在 frontmatter 里加的键，写回去都会原样
      // 带着走（这一层在 writeDiary 里），所以不再为这个拦人，只在结果里说一句。
      const known = new Set([...DIARY_SECTIONS, '今天这四样'])
      const extra = (existing.sections ?? [])
        .filter((s) => s?.title !== '_intro' && !known.has(String(s?.title ?? '')) && String(s?.body ?? '').trim() !== '')
        .map((s) => String(s.title))

      // 会动到旧内容的三件事都得先问用户：
      // ① 把一节弄空 ② 一节这次写了另一段（旧那段会被换掉）③ 改掉原来打的分
      const losing = []
      const replacing = []
      for (const title of DIARY_SECTIONS) {
        if (!Object.hasOwn(wanted, title)) continue
        const old = before[title]
        const oldText = Array.isArray(old) ? old.join('\n') : String(old ?? '')
        const newText = Array.isArray(wanted[title]) ? wanted[title].join('\n') : String(wanted[title] ?? '')
        if (oldText.trim() === '') continue
        if (newText.trim() === '') { losing.push(title); continue }
        // 接着往下写（新内容把原来那段原样带在开头、后面又加了几句）不算换掉，
        // 那正是「一天里接着写」该有的样子；整段重写才拦。
        if (squash(newText).startsWith(squash(oldText))) continue
        replacing.push(title)
      }
      const oldScores = before.scores !== null && typeof before.scores === 'object' ? before.scores : {}
      const rescoring = Object.keys(scores).filter((name) => oldScores[name] !== undefined && Number(oldScores[name]) !== Number(scores[name]))

      if ((losing.length > 0 || replacing.length > 0 || rescoring.length > 0) && args.confirm_overwrite !== true) {
        const lines = [`${date} 这一天已经有内容了，这次没写：`]
        if (losing.length > 0) lines.push(`会弄空这几节：${losing.join('、')}`)
        if (replacing.length > 0) lines.push(`会换掉这几节原来写的：${replacing.join('、')}`)
        if (rescoring.length > 0) lines.push(`会改掉这几样原来的分：${rescoring.join('、')}`)
        lines.push('先问一句用户：是改这一天，还是另起一天。他确认要改，再带 confirm_overwrite: true 重调一次。')
        lines.push('想保留原来那段就接着写、把新内容接在后面，别整段重写。')
        return lines.join('\n')
      }

      const payload = { ...wanted, date }
      // 分数一格一格地算：这次只说了两个格子，另外两个不该被抹掉。
      const mergedScores = { ...oldScores, ...scores }
      if (Object.keys(mergedScores).length > 0) payload.scores = mergedScores
      // 已经写过、这次没提到的节，把原来的留着——「接着写」不该把上午写的删掉。
      for (const title of DIARY_SECTIONS) {
        if (payload[title] !== undefined) continue
        const old = before[title]
        if (Array.isArray(old) ? old.length > 0 : String(old ?? '').trim() !== '') payload[title] = old
      }

      const saved = await writeDiary(dir, payload, new Date(), { expect: { text: existing.text } })
      if (saved.ok !== true) {
        if (saved.conflict === true) {
          return [
            '这一天在我们说话的时候被改过了（可能是你自己在访达里动的）。',
            '为了不把你外面改的内容盖掉，这次没存。重新打开这一篇、把要补的那几节再说一遍就行。',
          ].join('\n')
        }
        return `没能存下来：${String(saved.error ?? '写盘失败')}`
      }
      const wrote = DIARY_SECTIONS.filter((title) => {
        const value = payload[title]
        return Array.isArray(value) ? value.length > 0 : String(value ?? '').trim() !== ''
      })
      return [
        `${existing.data === null ? '存好了' : '这一篇更新好了'}：${path.join(dir, saved.path)}`,
        `写了 ${wrote.length} 节：${wrote.join('、')}`,
        existing.data === null ? '' : '这一篇原来写的内容，这次没提到的都留着。',
        extra.length > 0 ? `你自己在这一篇里加的那几节（${extra.join('、')}）原样留着，没动。` : '',
        saved.snapshot !== '' ? '改之前的旧版本另存了一份，在同一个文件夹的「.lifecard/旧版本」里。' : '',
        '用户自己用访达就能打开改；下次再点「写日记」会接着这一篇。',
      ].filter((x) => x !== '').join('\n')
    },
  )

  return true
}

/** 把模型写的小节名对上那五个固定的说法（多写几个字、少写几个字都认）。 */
function matchSection(title) {
  const want = String(title ?? '').trim()
  if (want === '') return ''
  if (DIARY_SECTIONS.includes(want)) return want
  const rules = [
    ['今天最值得讲的一件事', /最值得讲|那件事|今天的事/],
    ['当时在想什么', /在想什么|当时想|心里想/],
    ['情绪往下三层', /三层|情绪/],
    ['我做了什么决定', /决定|怎么办/],
    ['下一步', /下一步|接下来|要做的事/],
  ]
  for (const [canon, pattern] of rules) if (pattern.test(want)) return canon
  return ''
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

/**
 * 反哺卡时用的「依据」：一串能逐字比对的原文，外加一句「这是从哪儿来的」。
 *
 * 用户没挑日子就看最近写的三篇（和日记助手看到的一样）；挑了日子就只认那一天，
 * 那一天的日记读不出来时宁可报错，也不退回「看最近几篇」——退回去就会
 * 拿着一篇不相干的日记改卡，而且改完看不出来。
 */
async function refineSource(root, args) {
  const from = String(args.from ?? 'diary').trim()
  if (from === 'material') {
    const materials = await store.readMaterials(root)
    const picked = pickMaterial(materials, args.material)
    if (picked === null) return { ok: false, error: `没找到「${String(args.material ?? '')}」这份材料，先确认材料名。` }
    return { ok: true, text: String(materials[picked] ?? ''), where: `材料「${picked}」` }
  }

  const state = await store.readConfigState(root)
  if (state.ok !== true) return { ok: false, error: '读不出来日记放在哪儿。' }
  const dir = diaryRootFrom(state.config)
  if (dir === '') return { ok: false, error: '还没有挑日记放在哪个文件夹，先让用户在首页点一次「写日记」。' }

  const want = String(args.date ?? '').trim()
  if (want !== '') {
    const got = await readDiary(dir, want)
    if (got.ok !== true) return { ok: false, error: String(got.error ?? '这一天的日记读不出来。') }
    if (got.data === null) return { ok: false, error: `没有 ${want} 这一天写的日记。` }
    return { ok: true, text: diaryBlock(got.data), where: `${want} 这一篇日记` }
  }

  const listed = await listDiaries(dir, { limit: 3 })
  if (listed.ok !== true) return { ok: false, error: String(listed.error ?? '日记列不出来。') }
  if (listed.diaries.length === 0) return { ok: false, error: '还一篇日记都没写过，没有可以当依据的东西。' }
  const parts = []
  const dates = []
  for (const item of listed.diaries) {
    const got = await readDiary(dir, item.date)
    if (got.ok !== true || got.data === null) continue
    parts.push(`【${item.date}】\n${diaryBlock(got.data)}`)
    dates.push(item.date)
  }
  if (parts.length === 0) return { ok: false, error: '最近这几篇日记都读不出来。' }
  return { ok: true, text: parts.join('\n\n'), where: `日记（${dates.join('、')}）` }
}

/** 用户自己那张卡（kind 是 self）。没有回 null。 */
async function findSelfCard(root) {
  const all = await store.listAll(root)
  const cards = Array.isArray(all.cards) ? all.cards : []
  const hit = cards.find((c) => String(c.kind ?? '') === 'self')
  if (hit === undefined) {
    // 老档案里「我」常常是 kind:real + relation:我（用户自己就是这么建的）。
    // 认它，但只在没有真正的 self 卡时认。
    const byRelation = cards.find((c) => String(c.relation ?? '').trim() === '我' && String(c.kind ?? '') === 'real')
    if (byRelation === undefined) return null
    const read = await store.readCard(root, byRelation.path)
    return read.ok === true ? read : null
  }
  const read = await store.readCard(root, hit.path)
  return read.ok === true ? read : null
}

/** 现在陪用户写日记的那个助手。没挑过就按「日记助手」这个名字找。回 null 表示还没有。 */
async function findDiaryAssistant(root) {
  const state = await store.readConfigState(root)
  const pin = String(state.config?.default_cards?.diary ?? '').trim()
  if (pin !== '') {
    const card = await findCard(root, pin)
    if (card !== null) return card
  }
  const named = await findCard(root, '日记助手')
  return named === null ? null : named
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

/** 这个名字现在是不是被一张已撤掉的卡占着（撤掉记录还在，文件可能还在也可能被彻底删了）。 */
function isWithdrawnAt(root, rel) {
  const redactions = store.readRedactionsSync(root)
  return store.hitsRedactionByPath(redactions, rel) !== undefined
}

/** 占着名字时的说法：给出两条真能走通的路，别让人再撞一次。 */
function withdrawnNote(rel, what) {
  return [
    `这个名字被一张已经撤掉的${what}占着：${rel}`,
    `想去救它，就到首页「已经撤掉的」里恢复；不想要了，就在那儿彻底删掉，名字才空出来。`,
  ].join('\n')
}

/** 这张卡是不是已经有了：先看算出来的位置，再按 id 或名字找。找到回相对路径，没有回 null。 */
async function findExisting(root, rel, id) {
  const direct = await store.findCardByRelOrId(root, rel)
  if (direct !== null) return direct
  return await store.findCardByRelOrId(root, id)
}

/** 这本世界书是不是已经有了：先看算出来的位置，再按名字在所有世界书里找。 */
async function findWorld(root, rel, name) {
  const direct = await store.readCard(root, rel)
  if (direct.ok === true) return rel
  let dirs = []
  try {
    dirs = await readdir(path.join(root, 'worlds'))
  } catch {
    return null
  }
  for (const dir of dirs) {
    const candidate = path.posix.join('worlds', dir, 'world.md')
    const got = await store.readCard(root, candidate)
    if (got.ok === true && String(got.data?.name ?? '').trim() === name) return candidate
  }
  return null
}

/** 合并前置字段：只填空缺，绝不改已有的（身份、关系、归到哪本书都算已有）。 */
function mergeData(existingData, incomingData) {
  const data = { ...(existingData ?? {}) }
  const filled = []
  for (const [key, value] of Object.entries(incomingData ?? {})) {
    const cur = data[key]
    const empty = cur === undefined || cur === null || (typeof cur === 'string' && cur.trim() === '')
    if (!empty || value === undefined || value === null) continue
    if (typeof value === 'string' && value.trim() === '') continue
    data[key] = value
    filled.push(key)
  }
  return { data, filled }
}

/** 合并小节：已有正文一个字不动，只补空缺（还没有这一节，或那一节本来是空的）。 */
function mergeSections(existingSections, incomingSections) {
  const sections = (existingSections ?? []).map((one) => ({ title: one?.title, body: String(one?.body ?? '') }))
  const at = new Map(sections.map((one, i) => [one.title, i]))
  const added = []
  for (const one of incomingSections ?? []) {
    const title = String(one?.title ?? '').trim()
    const body = String(one?.body ?? '').trim()
    if (title === '' || body === '') continue
    if (at.has(title)) {
      const i = at.get(title)
      if (String(sections[i].body ?? '').trim() === '') {
        sections[i].body = body
        added.push(title)
      }
      continue
    }
    sections.push({ title, body })
    at.set(title, sections.length - 1)
    added.push(title)
  }
  return { sections, added }
}

/** 把「世界书条目」小节切成一条块一行数组（`- ` 开头算新的一条），块里原有字段全留着。 */
function splitWorldBlocks(body) {
  const blocks = []
  let cur = null
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (/^-\s/.test(line)) {
      if (cur !== null) blocks.push(cur)
      cur = [line]
      continue
    }
    if (cur === null) continue
    cur.push(line)
  }
  if (cur !== null) blocks.push(cur)
  return blocks
}

/** 一条块的触发词。借 parseWorldEntries 认形状，author 手写的 uid/constant 等字段都还在。 */
function blockKeys(lines) {
  const parsed = core.parseWorldEntries([{ title: '世界书条目', body: lines.join('\n') }])
  const keys = parsed?.[0]?.keys
  return (Array.isArray(keys) ? keys : []).map((k) => String(k).trim()).filter((k) => k !== '')
}

/** 只改一条块里的 keys 那行，别的行一个字不碰。 */
function blockWithKeys(lines, keys) {
  const text = JSON.stringify(keys)
  let done = false
  const out = lines.map((line) => {
    if (done || !/^\s*keys:/.test(line)) return line
    done = true
    return line.replace(/^(\s*)keys:.*$/, `$1keys: ${text}`)
  })
  if (!done) out.splice(1, 0, `  keys: ${text}`)
  return out
}

/** 世界书合并：触发词对得上的并进已有条目（只把新触发词补进 keys），对不上的追加成新条目。 */
function mergeWorldBlocks(existingBody, incomingEntries) {
  const blocks = splitWorldBlocks(existingBody)
  const added = []
  const joined = []
  for (const entry of incomingEntries ?? []) {
    const keys = (entry?.keys ?? []).map((k) => String(k).trim()).filter((k) => k !== '')
    const label = keys.join(' / ') || '常驻'
    const hit = keys.length === 0 ? -1 : blocks.findIndex((lines) => blockKeys(lines).some((k) => keys.includes(k)))
    if (hit === -1) {
      const fresh = [`- keys: ${JSON.stringify(keys)}`, '  insertion_order: 100', '  content: |-']
      for (const line of String(entry?.content ?? '').split(/\r?\n/)) fresh.push(`    ${line}`)
      blocks.push(fresh)
      added.push(label)
      continue
    }
    const union = blockKeys(blocks[hit])
    for (const k of keys) if (!union.includes(k)) union.push(k)
    blocks[hit] = blockWithKeys(blocks[hit], union)
    joined.push(label)
  }
  return { body: blocks.map((lines) => lines.join('\n')).join('\n'), added, joined, total: blocks.length }
}
