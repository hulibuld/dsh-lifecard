/**
 * LifeCard core —— 零宿主依赖的纯逻辑层。
 *
 * 这一层只做三件事，不碰宿主、不联网、不写 UI：
 *   1. 解析 / 序列化一张 `.card.md`（YAML frontmatter + Markdown 正文小节）
 *   2. 校验它（kind 枚举、必需字段、来源等级、关系边方向）
 *   3. 计算覆盖率与提案校验（引文必须在材料里逐字出现）
 *
 * 之所以单独成文件：DSH 宿主侧和浏览器侧都要用它，而两边都不该自己再实现一遍。
 * 这里没有任何 `import`，是纯函数，可以在 node 里直接测。
 */

// ── 常量 ────────────────────────────────────────────────────────────

/** 数据格式版本。与包版本无关。 */
export const DATA_VERSION = '0.1'

/** 八个 kind，缺一个都会让某类文件解析失败。 */
export const KINDS = ['real', 'fictional', 'hybrid', 'self', 'lens', 'world', 'system', 'relation']

/** 四个来源等级。`推测` 进渲染时要带前缀。 */
export const SOURCE_LEVELS = ['自述', '他述', '文档', '推测']

/** 封闭枚举的能力等级。中英混用会让 lint 失去基准。 */
export const LEVELS = ['入门', '熟手', '精通', '专家']

/** consent.basis 的四个取值。 */
export const CONSENT_BASES = ['self', 'family-agreed', 'public-figure', 'fictional']

/** status 只作描述，不进任何拦截逻辑。 */
export const STATUSES = ['active', 'deceased', 'incapacitated', 'historical']

/** kind → 必需字段。注意 self / lens 与实体卡不同。 */
export const REQUIRED_BY_KIND = {
  real: ['lifecard', 'id', 'kind', 'name', 'world'],
  fictional: ['lifecard', 'id', 'kind', 'name', 'world'],
  hybrid: ['lifecard', 'id', 'kind', 'name', 'world'],
  self: ['lifecard', 'id', 'kind', 'name'],
  lens: ['lifecard', 'id', 'kind'],
  world: ['lifecard', 'id', 'kind', 'name'],
  system: ['lifecard', 'id', 'kind', 'name'],
  relation: ['lifecard', 'id', 'kind', 'from', 'to'],
}

/** 正文小节名 → CCv2 字段。固定映射，导出时直接投影。 */
export const SECTION_TO_CC = {
  自述: 'description',
  性格: 'personality',
  场景: 'scenario',
  开场白: 'first_mes',
  备选开场: 'alternate_greetings',
  对话示例: 'mes_example',
  创作者备注: 'creator_notes',
}

/** 本地扩展小节：不进 CC 投影，但会被分析与渲染读取。 */
export const LOCAL_SECTIONS = ['关系史', '不会说的话', '不会做的事', '外貌', '口癖', '备注']

/**
 * 提案里允许出现的 field。
 *
 * SPEC §8.1 第 2 条要求「field 必须在 schema 里存在」，但之前只判了非空，
 * 于是 `field: "__proto__"` 或者编一个字段名都能过闸门、被勾选、写进卡。
 *
 * 来源对齐 prompts.js：SCHEMA_HINT 的 11 个字段 + 提示词允许的正文小节。
 * 注意「除必需字段外任何字段都可以永远为空」（SPEC §2），所以这里是
 * **进提案的**白名单，不是卡的字段白名单——卡上额外字段不报错、不拦。
 *
 * 刻意**不在**白名单里的三个字段，不是漏了：
 *   - `kind`：这张卡是真人还是虚构，由建卡的人定，不由模型从材料里猜。
 *     猜错了，同一段材料会被当成可以随便写的虚构角色，或者反过来。
 *   - `world`：世界观归属是结构决定，模型写一个不存在的 world id 会让卡从
 *     任何视图中消失。
 *   - `consent`：**这条最重要。** 对方是否知情、依据是什么，是法律事实。
 *     模型不能替用户声明「对方同意了」——它没问过任何人。
 */
export const PROPOSAL_FIELDS = [
  // 结构字段（data）
  'name', 'nickname', 'relation', 'birth_year', 'tags', 'competency',
  'knowledge', 'taboos', 'address', 'life', 'status',
  // 正文小节
  '自述', '性格', '场景', '开场白', '备选开场', '对话示例', '创作者备注',
  '关系史', '不会说的话', '不会做的事', '外貌', '口癖', '备注',
]

/**
 * 正文类小节。这些字段的内容是成段的话，同一件事很容易被模型写成
 * 一句短的又说成一句长的，所以除完全重复外还做包含式去重。
 *
 * 结构字段（name、tags、birth_year…）不做包含式：`家` 是 `家人` 的子串，
 * 但它们是两个 tag；把短的那个当重复删掉，等于悄悄丢数据。
 */
const LONG_TEXT_FIELDS = new Set([
  '自述', '性格', '场景', '开场白', '备选开场', '对话示例', '创作者备注',
  '关系史', '不会说的话', '不会做的事', '外貌', '口癖', '备注',
  'knowledge', 'life', 'address',
])

/**
 * 去重时用的正文形态：去掉空白与标点、统一小写。
 *
 * 「他喜欢下棋。」和「他 喜欢下棋」是同一句话，只差标点和空格。
 * 模型重新整理同一份材料时，这种差别几乎必然出现——按原样比就漏了。
 */
function proposalTextKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 一条提案的值做成去重键。数组按元素摊平，对象按稳定序列化。 */
function proposalValueKey(item) {
  const v = item?.value
  if (typeof v === 'string') return proposalTextKey(v)
  if (Array.isArray(v)) {
    return v
      .map((x) => (typeof x === 'string' ? proposalTextKey(x) : proposalTextKey(JSON.stringify(x))))
      .filter((s) => s !== '')
      .sort()
      .join('|')
  }
  if (v === null || v === undefined) return ''
  if (typeof v === 'object') return proposalTextKey(JSON.stringify(v))
  return proposalTextKey(String(v))
}

/**
 * 模型自报的 line_start 与实际匹配位置允许相差几行。
 *
 * 多行引文的首行（`quote.split('\n')[0]`）与 quote 的真实起点常常差一两行
 * （前一行是说话人前缀、后一行是空行），所以留一点余量。
 * 但差出几十行就不是排版问题，是行号编的。
 */
const LINE_TOLERANCE = 5

// ── 极简 YAML（够用即可，零依赖）────────────────────────────────────
//
// 只支持 LifeCard 自己要用的子集：标量、带引号字符串、行内数组 `[a, b]`、
// 缩进块数组（`- key: v` / `- v`）、一层嵌套 map、多行 `|` 块。
// 不支持锚点、标签、复杂 flow 结构 —— 我们从来不产生它们。
//
// 为什么不用 js-yaml：core 的承诺是零运行时依赖；而且我们只需要读自己写的东西。

function stripComment(line) {
  // 只在引号外剥离 `#` 注释
  let inS = false
  let inD = false
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]
    if (c === "'" && !inD) inS = !inS
    else if (c === '"' && !inS) inD = !inD
    else if (c === '#' && !inS && !inD && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

function parseScalar(raw) {
  const s = raw.trim()
  if (s === '') return ''
  if (s === 'null' || s === '~') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^-?\d+\.\d+$/.test(s)) return Number(s)
  if (s.startsWith('"') && s.endsWith('"') && s.length > 1) {
    // 双引号串由 JSON.stringify 产生，反转义必须覆盖它可能写出的全部转义，
    // 否则值里带 tab / 反斜杠时会把 `\t` 这两个字符原样留在数据里。
    return s.slice(1, -1).replace(/\\(["\\ntr])/g, (_, c) => (
      c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c
    ))
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length > 1) return s.slice(1, -1).replace(/''/g, "'")
  if (s.startsWith('[') && s.endsWith(']')) {
    const body = s.slice(1, -1).trim()
    if (body === '') return []
    return splitFlow(body).map((piece) => parseScalar(piece))
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const body = s.slice(1, -1).trim()
    const out = {}
    if (body === '') return out
    for (const piece of splitFlow(body)) {
      // 键名可能带引号（`{"probability":80}`），也可能本身含冒号
      // （`{"a:b":1}`）。直接 indexOf(':') 会把引号留在键名上，
      // 读回来的对象于是多出一层转义。用 findMapColon 找真正的分隔符。
      const at = findFlowColon(piece)
      if (at < 0) continue
      out[parseKey(piece.slice(0, at))] = parseScalar(piece.slice(at + 1))
    }
    return out
  }
  return s
}

/**
 * 找 flow 映射（`{...}`）里真正分隔键值的冒号。
 *
 * 与 `findMapColon` 的差别：这里允许冒号后面紧跟任何字符。`JSON.stringify`
 * 产出的是 `{"probability":80}` 这种紧凑写法，冒号后面没有空格；而 `findMapColon`
 * 要求空格、`{` 或 `[`，于是把它判成"没有分隔符"，整个 piece 被丢掉。
 * 键名本身带引号，所以引号内的冒号（`{"a:b":1}`）要跳过。
 */
function findFlowColon(s) {
  let inS = false
  let inD = false
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]
    if (c === "'" && !inD) inS = !inS
    else if (c === '"' && !inS) inD = !inD
    else if (c === ':' && !inS && !inD) return i
  }
  return -1
}

/** 按逗号切 flow 列表，但忽略引号与嵌套括号里的逗号。 */
function splitFlow(body) {
  const out = []
  let depth = 0
  let inS = false
  let inD = false
  let cur = ''
  for (const c of body) {
    if (c === "'" && !inD) inS = !inS
    else if (c === '"' && !inS) inD = !inD
    else if (!inS && !inD) {
      if (c === '[' || c === '{') depth += 1
      else if (c === ']' || c === '}') depth -= 1
      else if (c === ',' && depth === 0) {
        out.push(cur.trim())
        cur = ''
        continue
      }
    }
    cur += c
  }
  if (cur.trim() !== '') out.push(cur.trim())
  return out
}

/**
 * 解析一个 YAML 子集文本。
 * @param {string} text - frontmatter 正文（不含两侧 `---`）。
 * @returns {Record<string, unknown>} 顶层对象。
 */
export function parseYaml(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const root = {}
  // 栈元素：{ indent, container, key } —— key 是“待填充”的父键名
  const stack = [{ indent: -1, container: root }]
  let i = 0

  const indentOf = (line) => {
    const m = /^(\s*)/.exec(line)
    return m === null ? 0 : m[1].length
  }

  while (i < lines.length) {
    const rawLine = lines[i]
    i += 1
    const line = stripComment(rawLine)
    if (line.trim() === '') continue
    const indent = indentOf(line)
    const content = line.trim()

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const frame = stack[stack.length - 1]

    // 列表项
    if (content === '-' || content.startsWith('- ')) {
      if (!Array.isArray(frame.pending)) {
        // 意外：父级不是数组。忽略这一行而不是抛错——一张卡写坏了不该让整库读不出来。
        continue
      }
      const rest = content === '-' ? '' : content.slice(2).trim()
      if (rest === '') {
        const child = {}
        frame.pending.push(child)
        stack.push({ indent, container: child, pending: undefined })
        continue
      }
      // 行内 map：`- {kind: 自述, what: ...}`。先认花括号，否则会被当标量。
      if (rest.startsWith('{') && rest.endsWith('}')) {
        frame.pending.push(parseScalar(rest))
        continue
      }
      const at = findMapColon(rest)
      if (at > 0) {
        const key = parseKey(rest.slice(0, at))
        const valueText = rest.slice(at + 1).trim()
        const item = {}
        // 值的下一层容器（嵌套 map / 嵌套数组）。列表项自己的帧仍要压栈，
        // 但 `- nested:` 后面还有子行时，子行必须写进 item[key] 而不是 item 本身，
        // 否则会丢一层键（`nested: {a: 1}` 退化成 `a: 1`）。
        let nested = null
        if (valueText === '' || valueText === '|' || valueText === '>') {
          if (valueText === '|' || valueText === '>') {
            const [block, next] = readBlock(lines, i, indent)
            item[key] = valueText === '>' ? block.replace(/\n/g, ' ') : block
            i = next
          } else {
            // 看下一行决定是嵌套 map 还是数组
            const look = peekContent(lines, i)
            if (look !== null && (look.text === '-' || look.text.startsWith('- '))) {
              item[key] = []
              nested = { indent, container: item, pending: item[key], parentKey: key }
            } else {
              const child = {}
              item[key] = child
              nested = { indent, container: child, pending: undefined }
            }
          }
        } else {
          item[key] = parseScalar(valueText)
        }
        frame.pending.push(item)
        stack.push({ indent, container: item, pending: undefined })
        if (nested !== null) stack.push(nested)
        continue
      }
      frame.pending.push(parseScalar(rest))
      continue
    }

    // 普通键
    const at = findMapColon(content)
    if (at <= 0) continue
    const key = parseKey(content.slice(0, at))
    const valueText = content.slice(at + 1).trim()

    if (valueText === '' ) {
      const look = peekContent(lines, i)
      if (look !== null && (look.text === '-' || look.text.startsWith('- '))) {
        const arr = []
        frame.container[key] = arr
        stack.push({ indent, container: frame.container, pending: arr, parentKey: key })
      } else {
        const child = {}
        frame.container[key] = child
        stack.push({ indent, container: child, pending: undefined })
      }
      continue
    }

    if (valueText === '|' || valueText === '>') {
      const [block, next] = readBlock(lines, i, indent)
      frame.container[key] = valueText === '>' ? block.replace(/\n/g, ' ') : block
      i = next
      continue
    }

    frame.container[key] = parseScalar(valueText)
  }

  return normalizeArrays(root)
}

/** 键名两侧若有引号（含冒号的键必须加），解析时要去掉。 */
function parseKey(raw) {
  const text = String(raw).trim()
  if (text.length < 2) return text
  const q = text[0]
  if ((q === '"' || q === "'") && text[text.length - 1] === q) {
    const val = parseScalar(text)
    return typeof val === 'string' ? val : text
  }
  return text
}

/** 找到 `key:` 的冒号位置（忽略引号里的冒号与 `http://` 之类）。 */
function findMapColon(s) {
  let inS = false
  let inD = false
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]
    if (c === "'" && !inD) inS = !inS
    else if (c === '"' && !inS) inD = !inD
    else if (c === ':' && !inS && !inD) {
      const nextCh = s[i + 1]
      if (nextCh === undefined || nextCh === ' ' || nextCh === '\t') return i
      // `a: {}` / `a: []` 这种紧贴的也算
      if (nextCh === '{' || nextCh === '[') return i
    }
  }
  return -1
}

function peekContent(lines, from) {
  for (let i = from; i < lines.length; i += 1) {
    const l = stripComment(lines[i])
    if (l.trim() === '') continue
    return { text: l.trim(), indent: /^(\s*)/.exec(l)[1].length }
  }
  return null
}

function readBlock(lines, from, parentIndent) {
  const out = []
  let i = from
  let blockIndent = null
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') {
      out.push('')
      i += 1
      continue
    }
    const ind = /^(\s*)/.exec(line)[1].length
    if (ind <= parentIndent) break
    if (blockIndent === null) blockIndent = ind
    out.push(line.slice(Math.min(blockIndent, ind)))
    i += 1
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return [out.join('\n'), i]
}

/**
 * 把 `pending` 标记里的数组挂回容器。
 * 解析器用“栈帧上的 pending 指针”来写数组，最后统一归一。
 */
function normalizeArrays(root) {
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) node[i] = walk(node[i])
      return node
    }
    if (node !== null && typeof node === 'object') {
      for (const key of Object.keys(node)) {
        if (node[key] === undefined) node[key] = null
        else node[key] = walk(node[key])
      }
    }
    return node
  }
  return walk(root)
}

/**
 * 这个值能否安全地跟在 `key: ` 后面（即不破坏结构）。
 * 全是标量的短数组可以；map、块数组、多行字符串不行。
 */
function isInlineValue(v) {
  if (v === null || v === undefined) return true
  if (typeof v !== 'object') return typeof v === 'string' ? !v.includes('\n') : true  // 多行走块标量
  if (Array.isArray(v)) return v.length === 0 || asInlineArray(v) !== null
  return Object.keys(v).length === 0
}

/**
 * 一个数组能否安全地写成 `[a, b, c]` 一行。
 * 纯标量且不太长才返回那行字符串，否则返回 null（调用方会写块数组）。
 */
function asInlineArray(arr) {
  if (arr.length === 0) return '[]'
  const allScalar = arr.every((v) => v === null || typeof v !== 'object')
  if (!allScalar) return null
  const line = `[${arr.map((v) => stringifyYaml(v, 0)).join(', ')}]`
  return line.length < 72 ? line : null
}

/** 序列化成 LifeCard 自己产生的那种子集 YAML。 */
export function stringifyYaml(value, indent = 0) {
  const pad = '  '.repeat(indent)
  const lines = []
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') {
    if (value.includes('\n')) return JSON.stringify(value)  // 只在非块路径用到；块路径由调用方处理
    return needsQuote(value) ? JSON.stringify(value) : value
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const inline = asInlineArray(value)
    if (inline !== null) return inline
    for (const item of value) {
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const keys = Object.keys(item)
        if (keys.length === 0) {
          lines.push(`${pad}- {}`)
          continue
        }
        const emit = (prefix, rawKey, value) => {
          const key = keyText(rawKey)
          const childIndent = indent + 2
          const innerPad = '  '.repeat(childIndent)
          if (typeof value === 'string' && value.includes('\n')) {
            lines.push(`${prefix}${key}: |`)
            for (const line of value.split('\n')) lines.push(line === '' ? '' : `${innerPad}${line}`)
            return
          }
          if (isInlineValue(value)) {
            lines.push(`${prefix}${key}: ${stringifyYaml(value, childIndent)}`)
            return
          }
          lines.push(`${prefix}${key}:`)
          for (const line of stringifyYaml(value, childIndent).split('\n')) lines.push(line)
        }
        emit(`${pad}- `, keys[0], item[keys[0]])
        for (const k of keys.slice(1)) emit(`${pad}  `, k, item[k])
      } else {
        lines.push(`${pad}- ${stringifyYaml(item, indent + 1)}`)
      }
    }
    return lines.join('\n')
  }
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined) continue
    const key = keyText(k)
    if (typeof v === 'string' && v.includes('\n')) {
      lines.push(`${pad}${key}: |`)
      for (const line of v.split('\n')) lines.push(line === '' ? '' : `${pad}  ${line}`)
    } else if (isInlineValue(v)) {
      lines.push(`${pad}${key}: ${stringifyYaml(v, indent + 1)}`)
    } else {
      lines.push(`${pad}${key}:`)
      for (const line of stringifyYaml(v, indent + 1).split('\n')) lines.push(line)
    }
  }
  return lines.join('\n')
}

/** 键名和值一样会被 YAML 误读：`a: b:` 是非法的。键名也走同一套判断。 */
function keyText(k) {
  const name = String(k)
  return needsQuote(name) ? JSON.stringify(name) : name
}

function needsQuote(s) {
  if (s === '') return true
  if (/^[\s]|[\s]$/.test(s)) return true
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true
  if (s.includes(': ') || s.includes(' #') || s.includes('\n')) return true
  // 行内数组用 `[a, b]` 表示，元素里带 `,` `[` `]` `{` `}` 会把结构切坏：
  // tags: ['a,b', 'c'] 会被读回三项。这些字符出现在中间也得加引号。
  if (/[,[\]{}]/.test(s)) return true
  if (['null', 'true', 'false', '~'].includes(s)) return true
  if (/^-?\d+(\.\d+)?$/.test(s)) return true
  return false
}

// ── 卡片：解析 / 序列化 ────────────────────────────────────────────

/**
 * 把一份 `.card.md` 文本拆成 frontmatter 与正文小节。
 * @param {string} text
 * @returns {{ data: Record<string, unknown>, sections: Array<{title: string, body: string}>, rawBody: string, ok: boolean, errors: string[] }}
 */
export function parseCard(text) {
  const errors = []
  const src = String(text ?? '').replace(/^\uFEFF/, '')
  const fence = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
  const m = fence.exec(src)
  if (m === null) {
    errors.push('文件开头少了那两行 `---` 分隔线，读不出卡片信息')
    return { data: {}, sections: splitSections(src), rawBody: src, ok: false, errors }
  }
  let data = {}
  try {
    data = parseYaml(m[1])
  } catch (error) {
    errors.push('文件开头那段格式不对，读不出来')
  }
  const rawBody = src.slice(m[0].length)
  return { data, sections: splitSections(rawBody), rawBody, ok: errors.length === 0, errors }
}

/** 按 `## 标题` 切小节。第一个标题之前的内容归到 `_intro`。 */
export function splitSections(body) {
  const out = []
  const lines = String(body ?? '').split(/\r?\n/)
  let cur = { title: '_intro', body: [] }
  // 围栏里的 `## xxx` 是代码/示例，不是小节标题。不认围栏的话，
  // 存回去会把代码块从中间切开（`## 对话示例` 只剩一个 ```）。
  let inFence = false
  let fenceChar = ''
  for (const line of lines) {
    const fence = /^\s*(```+|~~~+)/.exec(line)
    if (fence !== null) {
      if (!inFence) {
        inFence = true
        fenceChar = fence[1][0]
      } else if (fence[1][0] === fenceChar) {
        inFence = false
        fenceChar = ''
      }
      cur.body.push(line)
      continue
    }
    const h = inFence ? null : /^##\s+(.+?)\s*$/.exec(line)
    if (h !== null) {
      if (cur.body.join('\n').trim() !== '' || cur.title !== '_intro') out.push(cur)
      cur = { title: h[1].trim(), body: [] }
      continue
    }
    cur.body.push(line)
  }
  if (cur.body.join('\n').trim() !== '' || cur.title !== '_intro') out.push(cur)
  return out.map((s) => ({ title: s.title, body: s.body.join('\n').replace(/^\n+|\n+$/g, '') }))
}

/** 取某小节正文；没有就返回空串。 */
export function sectionBody(sections, title) {
  const found = sections.find((s) => s.title === title)
  return found === undefined ? '' : found.body
}

/**
 * 把「世界书条目」小节读回成一组对象。
 *
 * 世界书落盘时正文长这样（`plugin/lib/index.js` 的 importWorldInfo 写的）：
 *
 * ```
 * - uid: 3
 *   keys: ["北洋", "一九二八"]
 *   content: "那一年下了很大的雪。"
 *   insertion_order: 42
 *   enabled: true
 * ```
 *
 * 要按 `- ` 先切成一条条，再逐条交给 parseYaml —— 整段一次性喂进去
 * 会被当成一个 map，只有最后一条能留下来。解析失败的那条跳过而不是
 * 让整本世界书消失（磁盘上还有一个字都没丢的原件，别在这里拦人）。
 *
 * @param {Array<{title: string, body: string}>} sections
 * @returns {Array<object>}
 */
export function parseWorldEntries(sections) {
  const body = sectionBody(sections, '世界书条目')
  if (body.trim() === '') return []
  const blocks = []
  let cur = null
  for (const line of body.split(/\r?\n/)) {
    if (/^-\s/.test(line)) {
      if (cur !== null) blocks.push(cur)
      cur = [line.replace(/^-\s+/, '')]
      continue
    }
    if (cur === null) continue
    cur.push(line.replace(/^\s{2}/, ''))
  }
  if (cur !== null) blocks.push(cur)
  const out = []
  for (const block of blocks) {
    let entry
    try {
      entry = parseYaml(block.join('\n'))
    } catch {
      continue
    }
    if (entry === null || typeof entry !== 'object') continue
    out.push(entry)
  }
  return out
}

/** 把一张卡序列化回 Markdown。 */
export function stringifyCard(data, sections) {
  const head = stringifyYaml(data)
  const list = (sections ?? []).filter((s) => String(s.body ?? '').trim() !== '')
  // `_intro` 是第一个 `##` 之前的正文，没有标题。原来整条被 filter 掉，
  // 于是「读进来 → 存回去」会静默丢掉卡开头那段文字。
  const intro = list.filter((s) => s.title === '_intro').map((s) => String(s.body).trim()).join('\n\n')
  const body = list
    .filter((s) => s.title !== '_intro')
    .map((s) => `## ${s.title}\n\n${String(s.body).trim()}`)
    .join('\n\n')
  const parts = [intro, body].filter((part) => part !== '')
  return `---\n${head}\n---\n\n${parts.join('\n\n')}\n`
}

// ── 校验 ──────────────────────────────────────────────────────────

/**
 * 校验一张卡。
 * @param {Record<string, unknown>} data - frontmatter。
 * @param {{ fileName?: string }} [options]
 * @returns {{ ok: boolean, level: 'error'|'warn', issues: Array<{level: string, field?: string, message: string}> }}
 */
export function validateCard(data, options = {}) {
  const issues = []
  const add = (level, message, field) => issues.push({ level, message, field })

  const kind = data?.kind
  if (typeof kind !== 'string' || kind === '') {
    add('error', '缺少 kind。可选：' + KINDS.join(' / '), 'kind')
  } else if (!KINDS.includes(kind)) {
    add('error', `kind 的值 "${kind}" 不合法。可选：${KINDS.join(' / ')}`, 'kind')
  }

  if (typeof data?.lifecard === 'string' && data.lifecard !== DATA_VERSION) {
    add('warn', `这张卡的格式版本是 ${String(data.lifecard)}，本插件读的是 ${DATA_VERSION}（会按当前版本处理）`, 'lifecard')
  }
  if (data?.lifecard === undefined) add('error', '缺少 lifecard 版本字段（应为 "0.1"）', 'lifecard')

  const required = REQUIRED_BY_KIND[kind] ?? REQUIRED_BY_KIND.real
  for (const field of required) {
    const v = data?.[field]
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
      add('error', `缺少必需字段 ${field}`, field)
    }
  }

  if (kind === 'self' && data?.world === undefined) {
    // 允许缺省；只在别处引用这个 self 时才有意义
  }
  if (kind === 'lens' && data?.exportable !== false) {
    add('warn', 'lens 卡应显式写 exportable: false（它是永不可导出的偏好透镜）', 'exportable')
  }

  if (data?.level !== undefined && !LEVELS.includes(String(data.level))) {
    add('error', `level "${data.level}" 不在封闭枚举里：${LEVELS.join(' / ')}`, 'level')
  }

  for (const item of asArray(data?.competency)) {
    if (item === null || typeof item !== 'object') continue
    if (item.level !== undefined && !LEVELS.includes(String(item.level))) {
      add('error', `competency[${item.key ?? '?'}].level "${item.level}" 不在 ${LEVELS.join(' / ')} 里`, 'competency')
    }
    const ev = item.evidence
    if (ev !== undefined && typeof ev === 'string') {
      add('warn', `competency[${item.key ?? '?'}].evidence 应是数组（含 kind / what），不要写成一句话`, 'competency')
    }
    for (const e of asArray(ev)) {
      if (e === null || typeof e !== 'object') continue
      if (e.kind !== undefined && !SOURCE_LEVELS.includes(String(e.kind))) {
        add('error', `evidence.kind "${e.kind}" 不在 ${SOURCE_LEVELS.join(' / ')} 里`, 'competency')
      }
    }
  }

  if (data?.consent !== undefined && data.consent !== null) {
    const c = data.consent
    if (typeof c === 'object' && c.basis !== undefined && !CONSENT_BASES.includes(String(c.basis))) {
      add('error', `consent.basis "${c.basis}" 不在 ${CONSENT_BASES.join(' / ')} 里`, 'consent')
    }
    if (typeof c === 'object' && c.basis === 'family-agreed' && (c.recorded_at === undefined || c.recorded_at === '')) {
      add('error', 'consent.basis 是 family-agreed 时必须写 recorded_at', 'consent')
    }
    if (typeof c === 'object' && c.basis === 'fictional' && ['real', 'self'].includes(String(kind))) {
      add('error', 'kind 是 real / self 时不能用 consent.basis: fictional', 'consent')
    }
  }

  if (data?.status !== undefined && !STATUSES.includes(String(data.status))) {
    add('warn', `status "${data.status}" 不在 ${STATUSES.join(' / ')} 里（它只作描述，不拦任何操作）`, 'status')
  }

  if (kind === 'relation') {
    if (String(data?.from ?? '') === String(data?.to ?? '') && data?.from !== undefined) {
      add('error', '关系边的 from 与 to 不能是同一个人', 'from')
    }
  }

  // 卡上不该出现 system（它属于消费时选择，不是卡的属性）
  if (data?.system !== undefined) {
    add('warn', '卡上不应有 system 字段；系统在调用时用 --system 指定（见 SPEC §5）', 'system')
  }
  // affect 挂在关系边上，不在卡上
  if (data?.affect !== undefined) {
    add('warn', 'affect 属于关系边（relations/*.relation.md），不该出现在卡上', 'affect')
  }
  if (kind === 'real' || kind === 'fictional' || kind === 'hybrid') {
    const by = data?.birth_year
    if (typeof by === 'number' && by > 1900) {
      const age = new Date().getFullYear() - by
      if (age < 18 && data?.visibility !== 'private') {
        add('warn', `对象未满 18 岁（birth_year: ${by}），按 SPEC §6 应设 visibility: private`, 'visibility')
      }
    }
  }

  const hasError = issues.some((i) => i.level === 'error')
  return { ok: !hasError, level: hasError ? 'error' : issues.length > 0 ? 'warn' : 'ok', issues }
}

function asArray(v) {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

// ── 覆盖率 ────────────────────────────────────────────────────────

/**
 * 一张卡的字段覆盖情况。访谈用它决定下一个问什么。
 * @param {Record<string, unknown>} data
 * @param {Array<{title: string, body: string}>} sections
 */
export function coverage(data, sections, options) {
  // 虚构角色不问「是你的谁」「出生年」「同意状态」——那些是给真人用的字段。
  // 不算进分母，否则小说/酒馆门里聊完一整轮，页面上会永远写着
  // 「还空着：关系、出生年、同意状态」，怎么聊都填不满。
  const kind = String(options?.kind ?? data?.kind ?? '').trim()
  const fields = [
    { key: 'name', label: '名字', weight: 3 },
    { key: 'relation', label: '关系', weight: 2 },
    { key: 'birth_year', label: '出生年', weight: 1 },
    { key: 'address', label: '称呼', weight: 2 },
    { key: 'competency', label: '能力', weight: 3 },
    { key: 'knowledge', label: '知道什么', weight: 2 },
    { key: 'taboos', label: '禁忌话题', weight: 2 },
    { key: 'life', label: '生活约束', weight: 2 },
    { key: 'consent', label: '同意状态', weight: 1 },
  ]
  const sectionWeights = [
    { title: '自述', label: '自述', weight: 4 },
    { title: '性格', label: '性格', weight: 3 },
    { title: '关系史', label: '关系史', weight: 4 },
    { title: '不会说的话', label: '不会说的话', weight: 2 },
    { title: '外貌', label: '外貌', weight: 1 },
    { title: '口癖', label: '口癖', weight: 2 },
  ]

  const rows = []
  let got = 0
  let total = 0
  const realOnly = new Set(['relation', 'birth_year', 'consent'])
  for (const f of fields) {
    if (kind === 'fictional' && realOnly.has(f.key)) continue
    const v = data?.[f.key]
    const filled = v !== undefined && v !== null && String(typeof v === 'object' ? JSON.stringify(v) : v).trim() !== '' && String(typeof v === 'object' ? JSON.stringify(v) : v) !== '[]' && String(typeof v === 'object' ? JSON.stringify(v) : v) !== '{}'
    total += f.weight
    if (filled) got += f.weight
    rows.push({ ...f, filled, section: false })
  }
  const sourceLevels = collectSourceLevels(data, sections)
  for (const s of sectionWeights) {
    const body = sectionBody(sections, s.title)
    const filled = body.trim() !== ''
    total += s.weight
    if (filled) got += s.weight
    rows.push({ key: s.title, label: s.label, weight: s.weight, filled, section: true })
  }

  const pct = total === 0 ? 0 : Math.round((got / total) * 100)
  return {
    percent: pct,
    filled: rows.filter((r) => r.filled),
    empty: rows.filter((r) => !r.filled),
    rows,
    sourceLevels,
    unmarkedRatio: unmarkedRatio(sections),
  }
}

/** 统计四类来源标记在正文里出现的次数。 */
export function collectSourceLevels(data, sections) {
  const counts = Object.fromEntries(SOURCE_LEVELS.map((l) => [l, 0]))
  const text = (sections ?? []).map((s) => s.body).join('\n')
  for (const level of SOURCE_LEVELS) {
    const re = new RegExp(`〔\\s*${level}[^〕]*〕`, 'g')
    const hits = text.match(re)
    if (hits !== null) counts[level] += hits.length
  }
  for (const item of asArray(data?.competency)) {
    if (item === null || typeof item !== 'object') continue
    for (const e of asArray(item.evidence)) {
      if (e !== null && typeof e === 'object' && typeof e.kind === 'string' && counts[e.kind] !== undefined) {
        counts[e.kind] += 1
      }
    }
  }
  return counts
}

/**
 * 正文里没有被 `〔来源〕` 标记过的行所占比例。
 * 超过 30% 时 doctor 提示一次（不阻断）。
 */
export function unmarkedRatio(sections) {
  let total = 0
  let unmarked = 0
  for (const s of sections ?? []) {
    if (s.title === '_intro') continue
    for (const line of String(s.body ?? '').split('\n')) {
      const t = line.trim()
      if (t === '' || t.startsWith('>') || t.startsWith('- ') === false && /^#/.test(t)) continue
      total += 1
      if (!/〔[^〕]*〕\s*$/.test(t)) unmarked += 1
    }
  }
  return total === 0 ? 0 : unmarked / total
}

// ── 提案：定义与校验 ──────────────────────────────────────────────

/** 提案格式版本。 */
export const PROPOSAL_VERSION = 'lifecard_proposal_v1'

/**
 * 校验一条提案的“有据”条件：引文必须在材料里逐字出现。
 *
 * 这是整个项目的防幻觉地线。模型可以编，但它编的东西不会通过这里。
 * @param {{ evidence?: { material?: string, quote?: string, line_start?: number } }} item
 * @param {Record<string, string>} materials - 文件名 → 全文
 * @returns {{ ok: boolean, reason?: string, line?: number }}
 */
export function verifyQuote(item, materials) {
  const ev = item?.evidence
  if (ev === undefined || ev === null) return { ok: false, reason: '没有 evidence（每条断言必须带原文引文）' }
  const quote = typeof ev.quote === 'string' ? ev.quote.trim() : ''
  if (quote === '') return { ok: false, reason: 'evidence.quote 为空' }
  const materialName = typeof ev.material === 'string' ? ev.material : ''
  // 必须指名材料文件。不指就搜全部材料的话，引文可以在任意一份里命中，
  // 既定位不到证据来源，也发现不了「引文是两处拼起来的」。
  if (materialName.trim() === '') return { ok: false, reason: '没有指定材料文件（evidence.material 为空）' }
  const candidates = Object.entries(materials ?? {}).filter(([name]) => name === materialName || name.endsWith('/' + materialName) || materialName.endsWith('/' + name))
  if (candidates.length === 0) {
    return { ok: false, reason: `找不到材料文件 "${materialName}"` }
  }
  const norm = (s) => s.replace(/\s+/g, '')
  const target = norm(quote)
  // 一个字的引文（「花」「。」）在中文材料里几乎必然命中，过了闸门等于没闸门。
  // prompts.js 说引文「可以短」，所以只卡到 2——不为难正常的短引文。
  if (target.length < 2) return { ok: false, reason: '引文太短，不足两个字，不能作为证据' }
  for (const [, body] of candidates) {
    const hay = norm(body)
    if (hay.includes(target)) {
      // 定位行号（用原引文的首段找，找得到就报）
      const firstLine = quote.split('\n')[0].trim()
      const lines = String(body).split('\n')
      const at = lines.findIndex((l) => norm(l).includes(norm(firstLine)) && norm(firstLine) !== '')
      const line = at >= 0 ? at + 1 : undefined
      // 模型自报的 line_start 会被渲染进提案 Markdown（「证据：xxx L42」），
      // 假的也行就骗到人眼了。有就给个范围校验，离得太远说明引文是凑的。
      const claimed = typeof ev.line_start === 'number' ? ev.line_start : undefined
      if (claimed !== undefined && (claimed < 1 || claimed > lines.length)) {
        return { ok: false, reason: `evidence.line_start ${claimed} 超出了材料行数（共 ${lines.length} 行）` }
      }
      if (claimed !== undefined && line !== undefined && Math.abs(claimed - line) > LINE_TOLERANCE) {
        return { ok: false, reason: `evidence.line_start ${claimed} 与实际匹配位置 L${line} 相差太远（可能是编的）` }
      }
      return { ok: true, line: line ?? claimed }
    }
  }
  return { ok: false, reason: '引文在材料里找不到逐字对应（可能是模型补的）' }
}

/**
 * 校验整个提案：逐条过引文门，不通过的移进 rejected。
 *
 * 还要去重。同一条事实在同一份提案里出现两遍（模型把材料里一句话拆成
 * 两个「自述」条目，或者换个标点再说一遍），以前两条都会过闸门、被勾选、
 * 写进卡——用户整理一次材料，卡里就多一段重复的正文。
 * 这一步只在**同一 field 内**比：`name` 和 `自述` 里出现同一句话不是重复，
 * 那是两个字段各说各的。比对前先去掉空白和标点、统一大小写。
 *
 * 正文类小节（自述、场景、对话示例…）再做包含式去重：短的被长的吸收。
 * 结构字段不做，"家" 是 "家人" 的子串，但那是两个 tag。
 *
 * @param {object} proposal
 * @param {Record<string, string>} materials
 */
export function verifyProposal(proposal, materials) {
  const items = asArray(proposal?.items)
  const accepted = []
  const rejected = []
  /** field → 已经收下的条目（记下键和对象，长句吸收短句时要回撤）。 */
  const seen = new Map()

  for (const item of items) {
    if (item === null || typeof item !== 'object') {
      rejected.push({ item, reason: '条目不是对象' })
      continue
    }
    if (typeof item.field !== 'string' || item.field.trim() === '') {
      rejected.push({ item, reason: '缺少 field' })
      continue
    }
    // SPEC §8.1 第 2 条：field 必须在 schema 里存在。不校验的话，模型编一个
    // 字段名（或者 "__proto__"）也能进清单、被勾选、写进卡，闸门就形同虚设。
    if (!PROPOSAL_FIELDS.includes(item.field.trim())) {
      rejected.push({ item, reason: `"${item.field}" 不是这张卡认识的字段` })
      continue
    }
    if (item.source_level !== undefined && !SOURCE_LEVELS.includes(String(item.source_level))) {
      rejected.push({ item, reason: `source_level "${item.source_level}" 不在 ${SOURCE_LEVELS.join(' / ')} 里` })
      continue
    }
    const q = verifyQuote(item, materials)
    if (!q.ok) {
      rejected.push({ item, reason: q.reason })
      continue
    }

    const field = item.field.trim()
    const key = proposalValueKey(item)
    const prior = seen.get(field) ?? []
    let dup
    if (key !== '') {
      dup = prior.find((p) => p.key === key)
      if (dup === undefined && LONG_TEXT_FIELDS.has(field)) {
        dup = prior.find((p) => p.key !== '' && (key.includes(p.key) || p.key.includes(key)))
      }
    }
    if (dup !== undefined) {
      if (key.length > dup.key.length && key.includes(dup.key)) {
        // 新的这句更长、把前面那句整个包含进来了：留长的，把短的撤下来。
        // 「他喜欢下棋」和「他喜欢下棋，每天下午都要下一盘」是同一件事，
        // 留两句会让卡读起来像复读。
        const at = accepted.indexOf(dup.entry)
        if (at >= 0) accepted.splice(at, 1)
        seen.set(field, prior.filter((p) => p !== dup))
        rejected.push({ item: dup.item, reason: '和后面那条重复，只留了长的' })
      } else {
        rejected.push({ item, reason: '和前面那条重复' })
        continue
      }
    }

    const entry = { ...item, verified_line: q.line }
    accepted.push(entry)
    if (key !== '') {
      const list = seen.get(field) ?? []
      list.push({ key, item, entry })
      seen.set(field, list)
    }
  }
  return { accepted, rejected, ok: rejected.length === 0 }
}

// ── 关系 ──────────────────────────────────────────────────────────

/** 关系文件名：`<from>--<to>.relation.md`，两端都是 id。 */
export function relationFileName(from, to) {
  return `${safeId(from)}--${safeId(to)}.relation.md`
}

/** 卡文件名：`<id>.card.md`。 */
export function cardFileName(id) {
  return `${safeId(id)}.card.md`
}

/** 把任意字符串收成一个可做文件名的 id。中文字符保留（可读性优先）。 */
export function safeId(raw) {
  const s = String(raw ?? '').trim()
  if (s === '') return 'unnamed'
  return s
    // 控制字符（含 NUL）一律抹掉：它们会原样跟着路径走，Node 那一侧只会
    // ENOENT/EINVAL，排查起来像见鬼。
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|#%\s]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 80) || 'unnamed'
}

/** 从一条关系边读出方向与强度（用于关系图）。 */
export function relationEdge(data) {
  const latest = latestAffect(data?.affect)
  return {
    id: String(data?.id ?? ''),
    from: String(data?.from ?? ''),
    to: String(data?.to ?? ''),
    type: String(data?.structure?.type ?? ''),
    affinity: latest?.affinity,
    trust: latest?.trust,
    authority: numOr(data?.power?.authority, undefined),
    dependency: numOr(data?.power?.dependency, undefined),
    at: latest?.at,
  }
}

/** affect 是数组且带时间戳时，取最近一条。 */
export function latestAffect(affect) {
  const list = asArray(affect).filter((a) => a !== null && typeof a === 'object')
  if (list.length === 0) return undefined
  const withAt = list.filter((a) => typeof a.at === 'string')
  if (withAt.length === 0) return list[list.length - 1]
  // 排序后的数组长度是 withAt.length，不是 list.length。用 list.length 当索引，
  // 只要有一条 affect 没写 at，就会越界并回落到 withAt[last]（最旧的那条）。
  return withAt.slice().sort((a, b) => String(a.at).localeCompare(String(b.at)))[withAt.length - 1] ?? withAt[withAt.length - 1]
}

function numOr(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 反向视角：给一条边做「他对我」的对照显示用。 */
export function invertEdge(edge) {
  return { ...edge, from: edge.to, to: edge.from }
}

export default {
  DATA_VERSION,
  KINDS,
  SOURCE_LEVELS,
  LEVELS,
  CONSENT_BASES,
  STATUSES,
  REQUIRED_BY_KIND,
  SECTION_TO_CC,
  LOCAL_SECTIONS,
  PROPOSAL_VERSION,
  parseYaml,
  stringifyYaml,
  parseCard,
  stringifyCard,
  splitSections,
  sectionBody,
  parseWorldEntries,
  validateCard,
  coverage,
  collectSourceLevels,
  unmarkedRatio,
  verifyQuote,
  verifyProposal,
  relationFileName,
  cardFileName,
  safeId,
  relationEdge,
  latestAffect,
  invertEdge,
}
