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
import { workspacePointerFile, recallWorkspace, defaultWorkspace } from './lib/index.js'

export const name = 'dsh-lifecard-tools'
export const inject = ['tools']

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
    const recalled = await recallWorkspace(workspacePointerFile())
    if (typeof recalled === 'string' && recalled !== '') return recalled
  } catch { /* 读不到指针就退回默认位置 */ }
  return defaultWorkspace()
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

export function apply(ctx, config) {
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
}
