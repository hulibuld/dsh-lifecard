/**
 * cast —— 拆书：把一本书里的人拆成角色卡，把设定拆成世界书。
 *
 * 为什么单独一层：拆书是「一次性把整本书过一遍」，和访谈（一问一答）、
 * 酒馆（演一场）都不是同一种活。它只做三件事——拼 prompt、解析模型输出、
 * 把结果整理成 `store.writeCard` 能直接吃的形状。
 *
 * **这一层不碰磁盘**：不读材料、不建目录、不写文件。落盘由 index.js 负责，
 * 因为那边才有工作区、快照、写入队列。这里保持纯函数，才能在 node 里直接测。
 *
 * 为什么解析要写得这么宽：模型不会老实按格式来。`## 人物：张三`、`## 张三`、
 * `**张三**` 它随时会换着写；小节名会写成「性格特点」；空的地方它会填「未知」。
 * 每一条容错都是实测撞出来的，不是防御性编程。
 */

import { DATA_VERSION, safeId } from './core.js'

/** 拆一本书最多拆几个人。超过就只拆前 N 个——一次拆二十个人，模型会每个都写得像简历。 */
export const MAX_CAST = 8

/** 每个人的自述最多多少字。超了截断，并在结果里标 truncated。 */
export const MAX_PERSONA_CHARS = 4000

/** 一本书最多拆多少条世界观。 */
export const MAX_WORLD_ENTRIES = 40

/**
 * 角色卡的那几节，顺序即渲染顺序。
 * 和 tavern.PERSONA_SECTIONS 对齐——两边不一致的话，拆出来的卡在扮演时
 * 会少读一节，而且不报错，只是那个人突然变得不像。
 */
export const CAST_SECTIONS = ['自述', '性格', '外貌', '口癖', '不会说的话', '不会做的事', '关系史']

/** 原文超过这么多字就掐头去尾。整本小说塞进去，模型只在开头认真，后面开始抄。 */
const MAX_SOURCE_CHARS = 30000

/**
 * 这些词出现在某一节里，等于那一节没写。
 *
 * 为什么宁可留空也不留「未知」：卡是要反复读的。一节写着「未知」，
 * 之后每一场扮演都会把「未知」当成这个人身上确定的事，越演越空。
 * 空节至少会让调用方知道这里没料，能去补。
 */
const EMPTY_PLACEHOLDERS = new Set([
  '未知', '待补充', '暂无', '无', '无内容', '空', '略', '待定', '同上', '不祥', '不详',
  '未提及', '未提到', '未说明', '没有', '无此项', 'n/a', 'na', 'none', 'null', 'tbd',
  '-', '—', '——', '–', '...', '…',
])

/**
 * 小节名的模糊匹配表。
 *
 * 顺序有讲究：「不会说的话」「不会做的事」必须排在「口癖」前面。
 * 模型写「说话习惯」时含「说话」，写「不会说的话」时也含「说话」，
 * 先匹到口癖就把那一节最值钱的内容（他绝不说的话）当成口癖抄走了。
 */
const SECTION_HINTS = [
  { title: '不会说的话', words: ['不会说的话', '不会说', '绝不说', '说不出', '禁语', '不会开口', '不说的话'] },
  { title: '不会做的事', words: ['不会做的事', '不会做', '绝不做', '不做的事', '底线', '禁区', '不会干'] },
  { title: '口癖', words: ['口癖', '口头禅', '说话习惯', '语言习惯', '说话方式', '常用语', '语气'] },
  { title: '关系史', words: ['关系史', '关系', '人际', '羁绊', '纠葛'] },
  { title: '自述', words: ['自述', '简介', '介绍', '概述', '背景', '他是谁', '人物小传', '小传'] },
  { title: '性格', words: ['性格', '个性', '脾气', '性情', '人格'] },
  { title: '外貌', words: ['外貌', '长相', '外形', '容貌', '形象', '穿着', '模样'] },
]

/** 归一化一个小节名：去空白、去标点、去序号，方便比对。 */
function normalizeHead(raw) {
  return String(raw ?? '')
    .replace(/^[\s\d.、,，)）:：\-*#]+/, '')
    .replace(/[\s:：*#]+$/g, '')
    .replace(/[\s*`"'「」『』【】\[\]（）()]/g, '')
    .trim()
}

/**
 * 把任意一个小节名对到 CAST_SECTIONS 里的一节；对不上返回空串。
 *
 * 两级：先看是不是一模一样（「自述」），再看包含（「性格特点」→ 性格）。
 * 只做一层包含，不做编辑距离——那玩意儿会把「不做的事」判成「做的事」。
 */
export function matchSectionTitle(raw) {
  const head = normalizeHead(raw)
  if (head === '') return ''
  for (const title of CAST_SECTIONS) {
    if (normalizeHead(title) === head) return title
  }
  for (const hint of SECTION_HINTS) {
    for (const word of hint.words) {
      if (head.includes(word)) return hint.title
      // 反过来的包含只在 head 够长时才认：一个字的「人」「性」能匹中一大片，
      // 会把正文里的普通一行当成小节标题切走。
      if (head.length >= 2 && word.includes(head)) return hint.title
    }
  }
  return ''
}

/** 这一节是不是空（空串、纯符号、或「未知」这类占位）。 */
function isBlankBody(body) {
  const text = String(body ?? '').trim()
  if (text === '') return true
  const bare = text
    .replace(/^[（(【\[「『"'*`]+/, '')
    .replace(/[）)】\]」』"'*`]+$/, '')
    .replace(/[。．.！!？?，,、；;：:]+$/g, '')
    .trim()
    .toLowerCase()
  if (bare === '') return true
  return EMPTY_PLACEHOLDERS.has(bare)
}

/**
 * 校验用户填的「要拆谁」。
 *
 * 分隔符一律认：中文逗号、英文逗号、顿号、分号、换行、空格、斜杠。
 * 用户在输入框里怎么打都算，让他在「，」和「,」之间纠结没有意义。
 *
 * @returns {{ok: boolean, names: string[], error?: string, truncated?: boolean}}
 */
export function parseCastNames(input) {
  const raw = String(input ?? '')
  const parts = raw.split(/[,，、;；\n\r\t\s/|]+/)
  const names = []
  const seen = new Set()
  for (const part of parts) {
    const name = part.trim()
    if (name === '') continue
    // 去重按原样比：中文名没有大小写，但用户可能混着打英文名。
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  if (names.length === 0) {
    return { ok: false, names: [], error: '先写要拆谁：名字之间用逗号或顿号隔开。', truncated: false }
  }
  if (names.length > MAX_CAST) {
    return {
      ok: true,
      names: names.slice(0, MAX_CAST),
      truncated: true,
      error: `一次最多拆 ${MAX_CAST} 个人，这次只拆前 ${MAX_CAST} 个。`,
    }
  }
  return { ok: true, names, truncated: false }
}

/** 原文掐头去尾：中间那段直接丢，并留一个显眼的标记，免得模型以为书就这么短。 */
function clipSource(text) {
  const src = String(text ?? '')
  if (src.length <= MAX_SOURCE_CHARS) return { body: src, clipped: false }
  const half = Math.floor(MAX_SOURCE_CHARS / 2)
  return { body: `${src.slice(0, half)}\n\n（中间省略）\n\n${src.slice(-half)}`, clipped: true }
}

/** 拼「拆人物」那两段话。 */
export function buildCastPrompt(input = {}) {
  const bookTitle = String(input.bookTitle ?? '').trim()
  const names = Array.isArray(input.names) ? input.names.map((n) => String(n ?? '').trim()).filter((n) => n !== '') : parseCastNames(input.names).names
  const world = String(input.world ?? '').trim()
  const { body, clipped } = clipSource(input.text)

  const system = [
    '你在从一本书的正文里拆人物。拆出来的不是书评，是角色卡——之后每一场扮演都直接拿这几节当依据，写错一句，往后每一场都跟着错。',
    '',
    '【只拆点名的人】',
    '- 只拆下面名单里的人。名单外的人一个字都不写，哪怕他戏份更多、更好写、更有意思。',
    '- 名单里有人在原文里根本没出现，就整个人跳过，不要写一段「原文未提及此人」。',
    '',
    '【每一节怎么写】',
    '- 每一节都要落在具体的事上，但不知道的留空。不要拿「未知」「待补充」「暂无」「—」占位：那些词会跟着这张卡一辈子，之后每次读都读到它，等于这一节是废的。从原文里确实看不出来的，就整节留空。',
    '- 自述：写他是谁、他要什么、他被什么挡住。三件事都要能指回原文里的一个场面。不写「他是一个复杂的人」「她内心很矛盾」这种评价。',
    '- 性格：写他会做什么。不写形容词堆——写「别人说完话他先看门口」，不写「他很谨慎」；写「钱放桌上他先数一遍」，不写「他精明」。要让人不看名字也能从行为里认出他。',
    '- 外貌：只写原文里写到过的（头发、个子、手上的疤、常穿的那件衣服）。原文没写就留空，不要按身份给他补一套。',
    '- 口癖：抄原文里的原话，加引号。原文里没有就留空，不要替他发明一句口头禅。',
    '- 不会说的话 / 不会做的事：这两节是这张卡最值钱的地方。写清他绝不会说什么、绝不会做什么——哪怕被逼到墙角也不会的那一件，以及为什么。给原句，或者给一条明确的类型（「不说软话」「从不叫人外号」）。',
    '- 关系史：只写原文里已经发生过的关系：谁救过谁、谁欠谁、谁在哪一件事上翻了脸。没写到的关系不要补，不要写「他们之间有一种微妙的关系」。',
    '',
    '【引文】',
    '- 正文里凡是用引号括起来的话，必须是原文原句。原文里没有的话一个字都不要编。',
    '- 拿不准是不是原话，就别加引号，改成叙述。',
    '',
    '【输出格式】（照这个样子写，七节按这个顺序写全）',
    '## 人物：<名字>',
    '### 自述',
    '<正文>',
    '### 性格',
    '<正文>',
    '### 外貌',
    '### 口癖',
    '### 不会说的话',
    '### 不会做的事',
    '### 关系史',
    '',
    '不要写前言、不要写总结、不要写「以下是」、不要给每个人加小标题以外的装饰。空着的小节保留标题，下面留一个空行就行。',
  ].join('\n')

  const lines = []
  lines.push(bookTitle === '' ? '下面是一本书的正文。' : `下面是一本书的正文，书名《${bookTitle}》。`)
  if (world !== '') lines.push(`这本书发生在：${world}`)
  lines.push('', `【要拆的人】${names.join('、')}`)
  if (clipped) lines.push('', '（原文太长，中间那段没有给你。只按看到的写，看不到的不要猜，也不要提「省略」这件事。）')
  lines.push('', '【原文】', body.trim() === '' ? '（原文为空）' : body)

  return { system, user: lines.join('\n') }
}

/** 去掉名字两头的引号、括号、markdown 记号，以及尾巴上的身份注（`张三（主角）`）。 */
function cleanName(raw) {
  return String(raw ?? '')
    .replace(/^[#*\s"'「『【（(]+/, '')
    .replace(/["'」』】）)\s]+$/, '')
    .replace(/[（(【\[][^）)】\]]*[）)】\]]\s*$/, '')
    .replace(/^人物\s*[:：]\s*/, '')
    .trim()
}

/**
 * 解析模型拆出来的人物。
 *
 * 认的写法（模型会随时换）：
 *   `## 人物：张三` / `## 张三` / `# 张三` / `**张三**`
 *   小节：`### 自述` / `**自述**` / `自述：`
 *
 * 名单外的人丢掉并记进 dropped，而不是静默合并——用户要能知道模型多写了谁。
 *
 * @param {string} text
 * @param {string[]} names - 用户点名要拆的人
 */
export function parseCastResult(text, names) {
  const allowed = []
  const list = Array.isArray(names) ? names : parseCastNames(names).names
  for (const n of list) {
    const k = String(n ?? '').trim()
    if (k !== '') allowed.push({ key: k.toLowerCase(), name: k })
  }
  // 名单是空的（调用方没给或全被过滤掉了）就不筛——宁可多留一个人，
  // 也不要把整段结果全丢掉，用户至少还能看见模型拆出来的东西。
  const filter = allowed.length > 0

  const order = []
  const people = new Map()
  const dropped = []
  const droppedSeen = new Set()
  let cur = null
  let curSection = ''

  const beginPerson = (rawName) => {
    const name = cleanName(rawName)
    if (name === '') { cur = null; curSection = ''; return }
    const key = name.toLowerCase()
    let hit = allowed.find((a) => a.key === key)
    if (hit === undefined) hit = allowed.find((a) => key.startsWith(a.key))
    if (filter && hit === undefined) {
      if (!droppedSeen.has(key)) { droppedSeen.add(key); dropped.push(name) }
      cur = null
      curSection = ''
      return
    }
    const finalName = hit === undefined ? name : hit.name
    const k = finalName.toLowerCase()
    if (!people.has(k)) {
      people.set(k, { name: finalName, bodies: new Map() })
      order.push(k)
    }
    cur = people.get(k)
    curSection = ''
  }

  const beginSection = (title) => {
    if (cur === null) return false
    curSection = title
    if (!cur.bodies.has(title)) cur.bodies.set(title, [])
    return true
  }

  const pushLine = (line) => {
    if (cur === null || curSection === '') return
    cur.bodies.get(curSection).push(line)
  }

  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  for (const raw of lines) {
    const line = raw.trimEnd()

    // 1) 标题行
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h !== null) {
      const level = h[1].length
      const head = h[2].trim()
      if (head === '') continue
      // `## 人物：张三` 无论几级都是人
      if (/^人物\s*[:：]/.test(head)) { beginPerson(head); continue }
      // 先当小节认（`## 自述` 确实有人这么写）。认出来但还没开始写人，
      // 说明这是一段没挂到任何人身上的残留标题，丢掉，不要凭空造一个叫「自述」的人。
      const title = matchSectionTitle(head)
      if (title !== '') {
        if (cur !== null) beginSection(title)
        continue
      }
      beginPerson(head)
      continue
    }

    // 2) 粗体行：可能是 `**张三**`，也可能是 `**自述**`
    const b = /^\*\*(.+?)\*\*\s*[：:]?\s*$/.exec(line)
    if (b !== null) {
      const inner = b[1].trim()
      const title = matchSectionTitle(inner)
      if (title !== '' && cur !== null) { beginSection(title); continue }
      // 正文里用来强调的一整行粗体（`**注意**`）不该被当成一个人：
      // 名字不会带句读，也不会写成一整句。
      if (inner.length <= 20 && !/[，。！？；：、]/.test(inner)) { beginPerson(inner); continue }
    }

    // 3) `自述：正文` 这种一行写完的
    const c = /^([^\s：:]{2,12})\s*[：:]\s*(.*)$/.exec(line.trim())
    if (c !== null && cur !== null) {
      const title = matchSectionTitle(c[1])
      if (title !== '') {
        beginSection(title)
        if (c[2].trim() !== '') pushLine(c[2])
        continue
      }
    }

    pushLine(line)
  }

  const out = []
  let truncated = false
  for (const key of order) {
    const person = people.get(key)
    const sections = CAST_SECTIONS.map((title) => {
      const parts = (person.bodies.get(title) ?? [])
      // 同名小节可能被写了两次（模型写着写着又起一次头），并起来而不是取最后一个
      let body = parts.join('\n').trim()
      if (isBlankBody(body)) body = ''
      if (title === '自述' && body.length > MAX_PERSONA_CHARS) {
        body = body.slice(0, MAX_PERSONA_CHARS).trim()
        truncated = true
      }
      return { title, body }
    })
    out.push({ name: person.name, sections })
  }

  return { ok: out.length > 0, people: out, dropped, truncated }
}

/** 拼「拆世界观」那两段话。 */
export function buildWorldPrompt(input = {}) {
  const bookTitle = String(input.bookTitle ?? '').trim()
  const names = Array.isArray(input.names) ? input.names.map((n) => String(n ?? '').trim()).filter((n) => n !== '') : []
  const { body, clipped } = clipSource(input.text)

  const system = [
    '你在从一本书的正文里拆世界观。拆出来的东西会作为世界书条目存下来，之后写这个世界的任何一场戏都会先读到它。',
    '',
    '【拆什么】',
    '- 只拆「这个世界怎么运转」：地方、规矩、势力、时间线、物件、称呼。',
    '- 一条只讲一件事。把「北洋政府」和「码头的规矩」塞进同一条，之后哪一场都用不上。',
    '- 每条都要能被后面的写作直接用上。不写「这是一个架空世界」「时代背景复杂」这种废话——那种句子放进世界书，之后每次都要再读一遍还没用。',
    '- 原文里没写清楚的不要补。可以用原文推出来的，写清楚你是从哪句推的。',
    '',
    '【触发词】',
    '- 每条给 2–6 个触发词。判据是：写这个世界的东西时，正文里一出现这些词，就该想起这一条。',
    '- 触发词要具体：地名、人名、机构名、行话、年代数字。「社会」「生活」这种词一片文章里到处都是，当触发词等于每条都被触发。',
    '',
    '【输出格式】（照这个样子写）',
    '## <条目标题>',
    '触发词：a、b、c',
    '<正文，一段，写这条设定是什么、怎么用>',
    '',
    `最多 ${MAX_WORLD_ENTRIES} 条。按重要性排序，越靠前越该被记住。`,
    '不要写前言、不要写总结、不要编号。',
  ].join('\n')

  const lines = []
  lines.push(bookTitle === '' ? '下面是一本书的正文，请把它的世界观拆出来。' : `下面是一本书的正文，书名《${bookTitle}》，请把它的世界观拆出来。`)
  if (names.length > 0) lines.push(`书里主要的人：${names.join('、')}`)
  if (clipped) lines.push('', '（原文太长，中间那段没有给你。只按看到的写，看不到的不要猜。）')
  lines.push('', '【原文】', body.trim() === '' ? '（原文为空）' : body)

  return { system, user: lines.join('\n') }
}

/** 一行是不是「触发词：a、b」。 */
const TRIGGER_LINE = /^\s*(?:触发词|关键词|关键字|触发|keys?)\s*[:：]\s*(.*)$/i

/** 把触发词那行切成数组。三种分隔符都认：顿号、逗号、空格。 */
function splitKeys(value) {
  const raw = String(value ?? '')
    .replace(/^[\[【（(「『]+/, '')
    .replace(/[\]】）)」』]+$/, '')
  return raw
    .split(/[、，,;；\/|]+|\s+/)
    .map((k) => k.replace(/^["'「『]+|["'」』]+$/g, '').trim())
    .filter((k) => k !== '')
}

/** 解析模型拆出来的世界观。 */
export function parseWorldResult(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let cur = null
  let seenHeading = false

  const begin = (title) => {
    if (cur !== null) blocks.push(cur)
    cur = { title: String(title ?? '').trim(), lines: [] }
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const h = /^#{1,4}\s+(.*)$/.exec(line)
    if (h !== null && h[1].trim() !== '') {
      begin(h[1])
      seenHeading = true
      continue
    }
    // `**标题**` 独占一行当成标题；带句号的粗体是正文里的强调，不当标题
    const b = /^\*\*(.+?)\*\*\s*[：:]?\s*$/.exec(line)
    if (b !== null && !TRIGGER_LINE.test(line) && !/[。！？!?]$/.test(b[1].trim())) {
      begin(b[1])
      seenHeading = true
      continue
    }
    if (cur === null) {
      // 开头没标题的引导语直接丢；整份没有标题时再把它们当第一条的正文
      if (!seenHeading) continue
      continue
    }
    cur.lines.push(raw)
  }
  if (cur !== null) blocks.push(cur)

  const entries = []
  for (const block of blocks) {
    const title = String(block.title ?? '').trim()
    if (title === '') continue
    let keys = []
    const kept = []
    let tookTrigger = false
    for (const line of block.lines) {
      const m = TRIGGER_LINE.exec(line)
      if (m !== null && !tookTrigger) {
        keys = splitKeys(m[1])
        tookTrigger = true
        continue
      }
      kept.push(line)
    }
    const content = kept.join('\n').trim()
    if (content === '' && keys.length === 0) continue
    // 没写触发词就用标题兜底：标题本身就是这一条最准的检索词
    entries.push({ title, keys: keys.length > 0 ? keys : [title], content })
  }

  const truncated = entries.length > MAX_WORLD_ENTRIES
  return {
    ok: entries.length > 0,
    entries: truncated ? entries.slice(0, MAX_WORLD_ENTRIES) : entries,
    truncated,
  }
}

/**
 * 把 parseCastResult 的单个人转成 `store.writeCard(root, relPath, data, sections)` 能吃的形状。
 *
 * `writeCard` 会先跑 `core.validateCard`，而 fictional 的必需字段是
 * `lifecard / id / kind / name / world` —— 少一个就整张卡写不进去。
 * 所以这五个在这里一次给全，调用方拿到就能直接写。
 *
 * 只做形状转换，不碰磁盘。
 *
 * @returns {{data: object, sections: Array<{title: string, body: string}>}}
 */
export function toCardShape(person) {
  const name = String(person?.name ?? '').trim()
  const given = Array.isArray(person?.sections) ? person.sections : []
  const byTitle = new Map()
  for (const s of given) {
    const title = matchSectionTitle(s?.title) || String(s?.title ?? '').trim()
    if (title === '') continue
    const body = String(s?.body ?? '').trim()
    if (!byTitle.has(title)) byTitle.set(title, [])
    if (body !== '') byTitle.get(title).push(body)
  }
  // 空节也保留（空串）：writeCard → stringifyCard 会把空节过滤掉，
  // 但调用方和界面要靠这个长度判断「这个人的卡拆全了没有」。
  const sections = CAST_SECTIONS.map((title) => ({
    title,
    body: (byTitle.get(title) ?? []).join('\n\n').trim(),
  }))

  const data = {
    lifecard: DATA_VERSION,
    id: safeId(name === '' ? 'unnamed' : name),
    kind: 'fictional',
    name: name === '' ? '没名字的人' : name,
    // 世界归属默认落在 reality；拆书时调用方会传书的 world 覆盖掉它。
    //
    // 这里以前是一句自相矛盾的三元：判断用的是补过默认值的
    // `String(person?.world ?? 'reality')`（永远不为空），写进去的却是原始值
    // `String(person.world)`。传进来的 `person` 没带 `world` 时，条件成立、
    // 于是落进文件的是字符串 `"undefined"` —— 卡的世界归属就变成了一个字面
    // 叫 undefined 的世界，界面上显示「属于哪个世界：undefined」，而那本书
    // 的世界书永远带不上。先算一遍再判空。
    world: (() => {
      const want = String(person?.world ?? '').trim()
      return want === '' ? 'reality' : want
    })(),
  }
  return { data, sections }
}

/**
 * 一本书拆出来的角色卡落在哪：`books/<bookId>/cast/<safeName>.md`。
 *
 * 单独一个 `cast/` 目录而不是塞进 `people/`：拆出来的这些是书里的人，
 * 和用户现实里认识的人不是一回事，混在一起会让首页一眼看不出哪张是哪张。
 */
export function castRelPath(bookId, name) {
  return `books/${folderName(bookId, '未命名')}/cast/${folderName(name, 'unnamed')}.md`
}

/**
 * 收一段安全的文件夹名。
 *
 * 和 `novel.bookFolderName` 同一套规则，抄一份而不是 import：
 * 那一层拖着 fs，这里要保持纯函数（测试直接 import 就能跑）。
 * 两边规则必须一致——不一致的话，书在 `books/某某/`，拆出来的卡落到
 * `books/某某-2/`，界面上就看不见了。
 *
 * `safeId` 不碰 `.`，而 `path.posix.join('books','..')` 是 `'.'`，
 * 一个叫 `..` 的书名能把整份目录写到工作区外面去。
 */
function folderName(raw, fallback) {
  const text = String(raw ?? '').trim()
  let name = safeId(text === '' ? fallback : text)
  name = name.replace(/^\.+/, '').replace(/\.+$/, '').replace(/\.{2,}/g, '.')
  if (name === '' || name === '.') name = fallback
  if (name === 'books') name = 'books-book'
  return name
}

export default {
  MAX_CAST,
  MAX_PERSONA_CHARS,
  MAX_WORLD_ENTRIES,
  CAST_SECTIONS,
  parseCastNames,
  buildCastPrompt,
  parseCastResult,
  buildWorldPrompt,
  parseWorldResult,
  toCardShape,
  castRelPath,
  matchSectionTitle,
}
