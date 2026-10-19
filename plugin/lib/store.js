/**
 * LifeCard store —— 工作区的读写。
 *
 * 只跑在宿主侧（Node）。浏览器侧一律经 HTTP 路由调这里，不直接碰文件。
 *
 * 设计约束（来自 SPEC §11）：
 *   - 文件系统是唯一真源；没有任何 KV 缓存充当第二真源。
 *   - `materials/` 只追加、不可编辑；`interviews/` 只追加。
 *   - 删除写墓碑到 `redactions.jsonl`，读取时先过墓碑。
 *   - 快照存全文，不存 diff。
 */

import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import * as core from './core.js'

/** 目录骨架。init 时一次性建出来。 */
const SKELETON = [
  'self',
  'people',
  'relations',
  'worlds/reality',
  'systems',
  'materials',
  'interviews',
  'proposals',
  'story/chapters',
  'story/state/snapshots',
  'assets',
  '.lifecard/raw',
  '.lifecard/snapshots',
]

const CONFIG_NAME = 'lifecard.config.json'

/** 默认配置。 */
export function defaultConfig() {
  return {
    lifecard: core.DATA_VERSION,
    name: '我的档案',
    default_system: 'reality-interview',
    locale: 'zh',
    created_at: new Date().toISOString(),
  }
}

// ── 工作区 ────────────────────────────────────────────────────────

/**
 * 打开一个工作区。目录不存在时按需创建。
 * @param {string} root - 绝对路径。
 * @param {{ create?: boolean }} [options]
 */
export async function openWorkspace(root, options = {}) {
  const abs = path.resolve(root)
  let exists = true
  try {
    const st = await fs.stat(abs)
    if (!st.isDirectory()) throw new Error(`不是文件夹：${abs}`)
  } catch {
    exists = false
  }
  if (!exists) {
    if (options.create !== true) return { ok: false, root: abs, exists: false, error: `文件夹不存在：${abs}` }
    await fs.mkdir(abs, { recursive: true })
  }
  if (options.create === true) {
    for (const dir of SKELETON) await fs.mkdir(path.join(abs, dir), { recursive: true })
    const configPath = path.join(abs, CONFIG_NAME)
    try {
      await fs.access(configPath)
    } catch {
      await fs.writeFile(configPath, JSON.stringify(defaultConfig(), null, 2) + '\n', 'utf8')
    }
  }
  return { ok: true, root: abs, exists: true }
}

/** 读工作区配置；没有就给默认值（不写盘）。 */
export async function readConfig(root) {
  try {
    const text = await fs.readFile(path.join(root, CONFIG_NAME), 'utf8')
    const json = JSON.parse(text)
    return { ...defaultConfig(), ...json }
  } catch {
    return defaultConfig()
  }
}

/** 写配置。 */
export async function writeConfig(root, patch) {
  const current = await readConfig(root)
  const next = { ...current, ...patch }
  await fs.writeFile(path.join(root, CONFIG_NAME), JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

// ── 墓碑 ──────────────────────────────────────────────────────────

/**
 * 读全部墓碑。`redactions.jsonl` 只追加、不可删除。
 * @returns {Promise<Array<{at: string, path?: string, id?: string, sha256?: string, reason?: string}>>}
 */
export async function readRedactions(root) {
  const file = path.join(root, 'redactions.jsonl')
  let text = ''
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    return []
  }
  const out = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try {
      out.push(JSON.parse(t))
    } catch {
      // 坏行跳过，不让一行烂数据废掉整个撤回机制
    }
  }
  return out
}

/** 追加一条墓碑。 */
export async function appendRedaction(root, entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry })
  await fs.appendFile(path.join(root, 'redactions.jsonl'), line + '\n', 'utf8')
  return line
}

/** 某个文件路径 + 内容是否命中墓碑。 */
function hitsRedaction(redactions, relPath, content) {
  const hash = content === undefined ? undefined : sha256(content)
  for (const r of redactions) {
    if (r.path !== undefined && relPath !== undefined && r.path !== relPath) continue
    if (r.sha256 !== undefined && hash !== undefined && r.sha256 !== hash) continue
    if (r.sha256 !== undefined && hash === undefined) continue
    return r
  }
  return undefined
}

export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

// ── 卡片读写 ──────────────────────────────────────────────────────

/**
 * 列出一张卡所在的相对路径。
 * 主世界实体在 `people/`，分支世界实体在 `worlds/<slug>/cards/`。
 */
export function cardRelPath(id, world) {
  const fileName = core.cardFileName(id)
  if (world === undefined || world === null || world === '' || world === 'reality') return path.posix.join('people', fileName)
  return path.posix.join('worlds', core.safeId(world), 'cards', fileName)
}

/**
 * 读一张卡（已过墓碑过滤）。
 * @returns {Promise<{ok: boolean, path?: string, text?: string, data?: object, sections?: object[], error?: string}>}
 */
export async function readCard(root, relPath) {
  const abs = path.join(root, relPath)
  let text
  try {
    text = await fs.readFile(abs, 'utf8')
  } catch {
    return { ok: false, path: relPath, error: '文件不存在' }
  }
  const redactions = await readRedactions(root)
  const hit = hitsRedaction(redactions, relPath, text)
  if (hit !== undefined) {
    return { ok: false, path: relPath, error: `这条记录已被撤回（${hit.reason ?? '未说明原因'}），不再显示` }
  }
  const parsed = core.parseCard(text)
  return { ok: true, path: relPath, text, data: parsed.data, sections: parsed.sections, parse: parsed }
}

/** 写一张卡，并在写前留一份全文快照。 */
export async function writeCard(root, relPath, data, sections, options = {}) {
  const validation = core.validateCard(data)
  if (!validation.ok && options.force !== true) {
    return { ok: false, error: '校验未通过', validation }
  }
  const abs = path.join(root, relPath)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  // 快照：旧内容存全文（快照是审计依据，不能只存 diff）
  try {
    const old = await fs.readFile(abs, 'utf8')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const snapDir = path.join(root, '.lifecard/snapshots', relPath.replace(/[\\/]/g, '__'))
    await fs.mkdir(snapDir, { recursive: true })
    await fs.writeFile(path.join(snapDir, `${stamp}.md`), old, 'utf8')
  } catch {
    // 首次写入，没有旧内容
  }
  const text = core.stringifyCard(data, sections)
  await fs.writeFile(abs, text, 'utf8')
  return { ok: true, path: relPath, text, validation }
}

/**
 * 扫描整个工作区，列出所有卡（已过墓碑过滤）。
 * @returns {Promise<{cards: object[], worlds: object[], systems: object[], relations: object[], errors: object[]}>}
 */
export async function listAll(root) {
  const redactions = await readRedactions(root)
  const cards = []
  const worlds = []
  const systems = []
  const relations = []
  const errors = []
  const materials = []

  const walk = async (relDir) => {
    const abs = path.join(root, relDir)
    let entries
    try {
      entries = await fs.readdir(abs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const rel = path.posix.join(relDir.replace(/\\/g, '/'), entry.name)
      if (entry.isDirectory()) {
        await walk(rel)
        continue
      }
      const lower = entry.name.toLowerCase()
      if (lower.endsWith('.card.md')) {
        const r = await readCard(root, rel)
        if (!r.ok) {
          if (r.error !== undefined && !r.error.startsWith('这条记录已被撤回')) errors.push({ path: rel, error: r.error })
          continue
        }
        const cov = core.coverage(r.data, r.sections)
        cards.push({
          path: rel,
          id: String(r.data?.id ?? ''),
          name: String(r.data?.name ?? r.data?.nickname ?? entry.name.replace(/\.card\.md$/i, '')),
          kind: String(r.data?.kind ?? 'real'),
          world: String(r.data?.world ?? 'reality'),
          relation: r.data?.relation,
          status: r.data?.status,
          tags: Array.isArray(r.data?.tags) ? r.data.tags : [],
          coverage: cov.percent,
          empty: cov.empty.map((e) => e.label),
          issues: core.validateCard(r.data).issues,
          updated: entry.name,
        })
      } else if (lower.endsWith('.relation.md')) {
        const r = await readCard(root, rel)
        if (r.ok) relations.push({ path: rel, ...core.relationEdge(r.data), data: r.data })
      } else if (lower.endsWith('.system.md')) {
        const r = await readCard(root, rel)
        if (r.ok) systems.push({ path: rel, id: r.data?.id, name: r.data?.name, kind: 'system' })
      } else if (lower === 'world.md') {
        const r = await readCard(root, rel)
        if (r.ok) worlds.push({ path: rel, id: r.data?.id, name: r.data?.name, genre: r.data?.genre, kind: 'world' })
      } else if (isUnder(relDir, 'materials')) {
        const stat = await fs.stat(path.join(root, rel)).catch(() => null)
        materials.push({ path: rel, name: entry.name, size: stat?.size ?? 0, mtime: stat?.mtime?.toISOString?.() })
      }
    }
  }
  await walk('people')
  await walk('self')
  await walk('worlds')
  await walk('systems')
  await walk('relations')
  await walk('materials')

  return { cards, worlds, systems, relations, errors, materials, redactions }
}

/**
 * relDir 是否就在某个顶层目录之下。
 *
 * 注意 `walk('materials')` 时 relDir 就是 `materials`（末尾没有斜杠），
 * 用 `startsWith('materials/')` 判断会漏掉根层文件——这曾让 materials 列表
 * 一直显示 0，而文件其实好好躺在磁盘上。
 */
function isUnder(relDir, top) {
  const d = String(relDir).replace(/\\/g, '/')
  return d === top || d.startsWith(top + '/')
}

// ── 材料 ──────────────────────────────────────────────────────────

/**
 * 追加一条材料。材料只追加、不改写：它是原话的存档，所有断言都要能追回这里。
 * @param {string} root
 * @param {string} name - 文件名（不含扩展名时会补 .md）
 * @param {string} content
 */
export async function appendMaterial(root, name, content) {
  const safe = core.safeId(name).replace(/\.md$/i, '')
  const date = new Date().toISOString().slice(0, 10)
  const fileName = safe.startsWith(date) ? `${safe}.md` : `${date}-${safe}.md`
  const rel = path.posix.join('materials', fileName)
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.appendFile(abs, (content.endsWith('\n') ? content : content + '\n'), 'utf8')
  return { ok: true, path: rel, sha256: sha256(content) }
}

/** 读所有材料（给提案的引文校验用）。key 是相对路径。 */
export async function readMaterials(root) {
  const out = {}
  const dir = path.join(root, 'materials')
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue
    try {
      out[`materials/${entry.name}`] = await fs.readFile(path.join(dir, entry.name), 'utf8')
    } catch {
      // 读不了就跳过，不阻断其他材料
    }
  }
  return out
}

// ── 提案 ──────────────────────────────────────────────────────────

/**
 * 存一份提案：Markdown（给人勾选）+ JSON（给机器读）。
 *
 * 关键：写盘前先过引文校验门。找不到原文的条目直接丢弃，
 * 并记进 rejected —— 这是整个项目的防幻觉地线。
 */
export async function saveProposal(root, aboutId, proposal, materials) {
  const gate = core.verifyProposal(proposal, materials)
  const date = new Date().toISOString().slice(0, 10)
  const safe = core.safeId(aboutId)
  const mdRel = path.posix.join('proposals', `${safe}-${date}.md`)
  const jsonRel = path.posix.join('proposals', `${safe}-${date}.json`)
  const abs = (rel) => path.join(root, rel)
  await fs.mkdir(abs('proposals'), { recursive: true })

  const md = renderProposalMarkdown({ aboutId, date, gate, proposal })
  await fs.writeFile(abs(mdRel), md, 'utf8')
  const record = {
    spec: core.PROPOSAL_VERSION,
    about: { id: aboutId },
    generated_at: new Date().toISOString(),
    material: Object.keys(materials ?? {}),
    accepted: gate.accepted,
    rejected: gate.rejected,
  }
  await fs.writeFile(abs(jsonRel), JSON.stringify(record, null, 2) + '\n', 'utf8')
  return { ok: true, md: mdRel, json: jsonRel, accepted: gate.accepted.length, rejected: gate.rejected.length, gate }
}

/** 渲染成勾选清单。**默认全部不勾**——勾选是人的动作。 */
export function renderProposalMarkdown({ aboutId, date, gate, proposal }) {
  const lines = []
  lines.push(`# 提案：${aboutId}（${date}）`)
  lines.push('')
  lines.push('> 这份文件是**建议**，不是卡。在下面勾上你要的（把 `[ ]` 改成 `[x]`），')
  lines.push('> 然后在插件里点「采纳勾选项」，它才会写进卡。')
  lines.push('>')
  lines.push('> 每条都带原文引文。引文在材料里找不到逐字对应的，已经在生成时被丢弃了。')
  lines.push('')
  if (gate.accepted.length === 0 && gate.rejected.length === 0) {
    lines.push('_这次分析没有产出任何可采纳的条目。_')
  }
  const byField = new Map()
  for (const item of gate.accepted) {
    const field = String(item.field ?? '其他')
    if (!byField.has(field)) byField.set(field, [])
    byField.get(field).push(item)
  }
  for (const [field, items] of byField) {
    lines.push(`## ${field}`)
    lines.push('')
    for (const item of items) {
      const label = describeValue(item)
      const ev = item.evidence ?? {}
      const where = ev.line_start !== undefined ? `L${ev.line_start}` : item.verified_line !== undefined ? `L${item.verified_line}` : ''
      lines.push(`- [ ] ${label}`)
      lines.push(`      证据：${ev.material ?? ''}${where === '' ? '' : ' ' + where}「${truncate(ev.quote, 80)}」`)
      if (item.source_level !== undefined) lines.push(`      来源：${item.source_level}`)
      if (item.note !== undefined) lines.push(`      说明：${item.note}`)
    }
    lines.push('')
  }
  if (Array.isArray(proposal?.gaps) && proposal.gaps.length > 0) {
    lines.push('## 还空着的')
    lines.push('')
    lines.push('这些不是提案，是「卡里缺、材料里也没说」的地方。')
    lines.push('')
    for (const gap of proposal.gaps) {
      lines.push(`- \`${gap.field}\` — ${gap.why ?? ''}`)
    }
    lines.push('')
  }
  if (Array.isArray(proposal?.questions) && proposal.questions.length > 0) {
    lines.push('## 建议去问')
    lines.push('')
    for (const q of proposal.questions) {
      lines.push(`- ${q.ask}${Array.isArray(q.fills) ? `（填 ${q.fills.join(', ')}）` : ''}`)
    }
    lines.push('')
  }
  if (gate.rejected.length > 0) {
    lines.push('## 已丢弃')
    lines.push('')
    lines.push('下面这些**没有通过引文校验**（材料里找不到逐字对应），所以没进清单。')
    lines.push('它们很可能是模型补出来的东西——这正是不让 AI 直接写卡的原因。')
    lines.push('')
    for (const r of gate.rejected) {
      const what = describeValue(r.item)
      lines.push(`- ~~${truncate(what, 60)}~~ — ${r.reason}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

function describeValue(item) {
  const v = item?.value
  if (v === null || v === undefined) return String(item?.field ?? '（空）')
  if (typeof v === 'string') return v
  if (typeof v !== 'object') return String(v)
  const keys = Object.keys(v)
  if (keys.length === 0) return '（空）'
  // competency / evidence 这类对象给一个人话摘要
  const label = v.label ?? v.key ?? v.name
  const level = v.level
  if (label !== undefined && level !== undefined) return `${label} / ${level}`
  if (label !== undefined) return String(label)
  return keys.map((k) => `${k}: ${typeof v[k] === 'object' ? JSON.stringify(v[k]) : v[k]}`).join('；')
}

function truncate(s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ')
  return t.length <= n ? t : t.slice(0, n) + '…'
}

/** 读一份提案的 JSON，并解析对应 Markdown 里的勾选状态。 */
export async function readProposal(root, jsonRel) {
  const abs = (rel) => path.join(root, rel)
  let record
  try {
    record = JSON.parse(await fs.readFile(abs(jsonRel), 'utf8'))
  } catch {
    return { ok: false, error: '提案 JSON 读不了' }
  }
  const mdRel = jsonRel.replace(/\.json$/, '.md')
  let md = ''
  try {
    md = await fs.readFile(abs(mdRel), 'utf8')
  } catch {
    // 没有 md 就当作全不勾
  }
  // 用引文片段做匹配键：md 里的顺序与 accepted 一致
  const checked = new Set()
  const lines = md.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^-\s+\[([ xX])\]\s+(.*)$/.exec(lines[i].trim())
    if (m === null) continue
    if (m[1].toLowerCase() !== 'x') continue
    // 用「勾选行 + 下两行」拼成指纹
    checked.add(m[2].trim() + '\u0000' + (lines[i + 1] ?? '').trim())
  }
  const items = Array.isArray(record.accepted) ? record.accepted : []
  const withChecked = items.map((item) => {
    const key = describeValue(item) + '\u0000' + `证据：${item.evidence?.material ?? ''}${item.evidence?.line_start !== undefined ? ' L' + item.evidence.line_start : item.verified_line !== undefined ? ' L' + item.verified_line : ''}「${truncate(item.evidence?.quote, 80)}」`
    // 指纹不完全一致时退回「按描述前缀匹配」，避免一个空格差异就让勾选失效
    const loose = [...checked].some((c) => c.startsWith(describeValue(item)))
    return { ...item, checked: checked.has(key) || loose }
  })
  return { ok: true, mdRel, record, items: withChecked, checkedCount: withChecked.filter((i) => i.checked).length }
}

/** 列出所有提案文件。 */
export async function listProposals(root) {
  const dir = path.join(root, 'proposals')
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const rel = path.posix.join('proposals', entry.name)
    try {
      const record = JSON.parse(await fs.readFile(path.join(dir, entry.name), 'utf8'))
      out.push({
        json: rel,
        about: record.about?.id ?? entry.name.replace(/\.json$/, ''),
        generated_at: record.generated_at,
        accepted: Array.isArray(record.accepted) ? record.accepted.length : 0,
        rejected: Array.isArray(record.rejected) ? record.rejected.length : 0,
      })
    } catch {
      // 坏文件跳过
    }
  }
  return out.sort((a, b) => String(b.generated_at).localeCompare(String(a.generated_at)))
}

/**
 * 采纳提案里被勾选的条目，写进卡。
 *
 * 只读 `[x]`。没勾的不写。这是「AI 不能直接写卡」的落地。
 */
export async function applyProposal(root, jsonRel) {
  const read = await readProposal(root, jsonRel)
  if (!read.ok) return read
  const aboutId = read.record?.about?.id
  if (typeof aboutId !== 'string' || aboutId === '') return { ok: false, error: '提案里没有 about.id' }
  const target = await findCardByRelOrId(root, aboutId)
  if (target === null) return { ok: false, error: `找不到 ${aboutId} 这张卡` }
  const card = await readCard(root, target)
  if (!card.ok) return card
  const chosen = read.items.filter((i) => i.checked)
  if (chosen.length === 0) return { ok: false, error: '提案里没有勾选任何条目' }

  const data = { ...card.data }
  const sections = (card.sections ?? []).map((s) => ({ ...s }))
  const applied = []
  for (const item of chosen) {
    const ok = applyItem(data, sections, item)
    if (ok) applied.push(describeValue(item))
  }
  const written = await writeCard(root, target, data, sections)
  if (!written.ok) return written
  return { ok: true, path: target, applied: applied.length, appliedLabels: applied, skipped: chosen.length - applied.length }
}

/** 把一条提案落到 data 或 sections 上。 */
function applyItem(data, sections, item) {
  const field = String(item?.field ?? '')
  const value = item?.value
  if (field === '') return false

  // 正文小节
  const sectionNames = ['自述', '性格', '场景', '开场白', '备选开场', '对话示例', '创作者笔记', '创作者备注', '关系史', '不会说的话', '不会做的事', '外貌', '口癖', '备注']
  if (sectionNames.includes(field)) {
    const text = typeof value === 'string' ? value : describeValue(item)
    const found = sections.find((s) => s.title === field)
    if (found === undefined) sections.push({ title: field, body: text })
    else found.body = found.body.trim() === '' ? text : `${found.body.trim()}\n${text}`
    return true
  }

  // 数组型字段：追加
  if (['competency', 'taboos', 'tags'].includes(field)) {
    const list = Array.isArray(data[field]) ? [...data[field]] : []
    if (field === 'tags') {
      const v = typeof value === 'string' ? value : describeValue(item)
      if (!list.includes(v)) list.push(v)
    } else {
      list.push(typeof value === 'object' && value !== null ? value : { label: String(value ?? describeValue(item)) })
    }
    data[field] = list
    return true
  }

  // 普通字段
  data[field] = value
  return true
}

/** 按 id 或相对路径找卡。 */
export async function findCardByRelOrId(root, relOrId) {
  if (relOrId.endsWith('.card.md')) {
    try {
      await fs.access(path.join(root, relOrId))
      return relOrId
    } catch {
      return null
    }
  }
  const all = await listAll(root)
  const hit = all.cards.find((c) => c.id === relOrId || c.name === relOrId)
  return hit === undefined ? null : hit.path
}

// ── 健康检查 ──────────────────────────────────────────────────────

/**
 * doctor：数据体检。
 *
 * 分成两段（见 SPEC §10）：数据段在任意环境跑；宿主段由一个自检写
 * `.lifecard/diagnostics.json`，这里读到就并进来，读不到就明写「未运行」。
 * 绝不假装探测过宿主能力。
 */
export async function doctor(root) {
  const all = await listAll(root)
  const config = await readConfig(root)
  const materials = await readMaterials(root)

  const issues = []
  for (const card of all.cards) {
    for (const issue of card.issues) {
      issues.push({ path: card.path, level: issue.level, field: issue.field, message: issue.message })
    }
  }
  // 悬空 world 引用
  const worldIds = new Set(all.worlds.map((w) => String(w.id ?? '')))
  worldIds.add('reality')
  for (const card of all.cards) {
    if (card.world !== undefined && card.world !== 'reality' && !worldIds.has(String(card.world))) {
      issues.push({ path: card.path, level: 'warn', field: 'world', message: `world "${card.world}" 不存在（worlds/ 下没有这个 id）` })
    }
  }
  // 悬空关系端点
  const ids = new Set(all.cards.map((c) => String(c.id)))
  for (const rel of all.relations) {
    if (!ids.has(rel.from)) issues.push({ path: rel.path, level: 'warn', field: 'from', message: `关系边的 from "${rel.from}" 指向不存在的卡` })
    if (!ids.has(rel.to)) issues.push({ path: rel.path, level: 'warn', field: 'to', message: `关系边的 to "${rel.to}" 指向不存在的卡` })
  }

  // 宿主段
  let hostSegment = { ran: false, note: '宿主段未运行（这是 CLI 段的结果）' }
  try {
    const diag = JSON.parse(await fs.readFile(path.join(root, '.lifecard/diagnostics.json'), 'utf8'))
    hostSegment = { ran: true, ...diag }
  } catch {
    // 没跑过，如实说
  }

  const summary = {
    ok: issues.every((i) => i.level !== 'error'),
    root,
    config,
    counts: {
      cards: all.cards.length,
      worlds: all.worlds.length,
      systems: all.systems.length,
      relations: all.relations.length,
      materials: all.materials.length,
      redactions: all.redactions.length,
    },
    issues,
    errors: all.errors,
    cards: all.cards.map((c) => ({ id: c.id, name: c.name, kind: c.kind, world: c.world, coverage: c.coverage, tags: c.tags })),
    unmarked: averageUnmarked(all),
    host: hostSegment,
    materials: Object.keys(materials),
  }
  return summary
}

function averageUnmarked() {
  // 需要逐卡算，listAll 里已经算过 coverage；这里保守返回 null，细节在卡片上
  return null
}

export default {
  SKELETON,
  defaultConfig,
  openWorkspace,
  readConfig,
  writeConfig,
  readRedactions,
  appendRedaction,
  sha256,
  cardRelPath,
  readCard,
  writeCard,
  listAll,
  appendMaterial,
  readMaterials,
  saveProposal,
  renderProposalMarkdown,
  readProposal,
  listProposals,
  applyProposal,
  findCardByRelOrId,
  doctor,
}
