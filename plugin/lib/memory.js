/**
 * LifeCard memory —— 从本机的记忆文件里认出「你身边有哪些人」。
 *
 * 只跑在宿主侧（Node）。不联网、不调模型。
 *
 * 为什么要有这一层：用户脑子里的人是散在记忆里的——「父亲在 XXXX 公司」
 * 「爷爷在 a 市做手艺」——每条都只说了半件事。人不会为了做卡把这些重抄一遍，
 * 但软件可以先把它们捞出来，摆成「这几个人我认出来了，要不要开始」。
 *
 * 三条硬规矩：
 *   1. **只认明确说了的人**。宁可漏，不许猜。名字猜错比没有更糟——
 *      用户会以为软件认识他爸。
 *   2. **只搬跟这个人有关的句子**，不搬整段记忆。记忆里有升学规划、账号运营、
 *      写作观，那些不是这个人的事。
 *   3. **说清楚缺什么**。记忆里通常只有一两句，卡必然是残的。
 *      残不是错，但要让人一眼看见「这条还没写完」，别以为已经好了。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * 记忆文件的默认位置。
 *
 * 之所以写死几个候选而不是问用户：这是本机约定俗成的落点，
 * 让一个 IT 小白去找「你的记忆文件在哪」是荒谬的。找不到就老实说找不到。
 *
 * MNEMON_DATA_DIR 环境变量优先——装了记忆插件的人可能改过位置。
 */
function candidateRoots(env) {
  const out = []
  const custom = String(env?.MNEMON_DATA_DIR ?? '').trim()
  if (custom !== '') {
    const expanded = custom.startsWith('~/')
      ? path.join(String(env?.HOME ?? ''), custom.slice(2))
      : custom
    out.push(path.join(expanded, 'runtime'))
  }
  const home = String(env?.HOME ?? '')
  if (home !== '') {
    out.push(path.join(home, '.mnemon', 'runtime'))
    out.push(path.join(home, '.mnemon'))
  }
  return out
}

/** 记忆里认人的线索。这些词一出现，基本就是在说某个人。 */
const KIN_WORDS = [
  '父亲', '母亲', '爸爸', '妈妈', '爷爷', '奶奶', '外公', '外婆',
  '姥爷', '姥姥', '哥哥', '姐姐', '弟弟', '妹妹', '儿子', '女儿',
  '丈夫', '妻子', '老公', '老婆', '师傅', '师父', '老师', '导师',
  '舅舅', '叔叔', '阿姨', '姑姑', '姨夫', '姑父', '表哥', '表姐',
]

/**
 * 从一行文本里找「关系词 + 姓名」。
 *
 * 只认两种最明确的写法，其余一律不认：
 *   **父亲＝张三**        等号前后各一个词
 *   **父亲张三**          关系词后面直接粘着两个字以上的名字
 * 以及裸的 `父亲在 XXXX 公司`（只知道关系，不知道名字）。
 *
 * 为什么不认「他父亲叫张三」这类更复杂的句式：
 * 中文人名没有分隔符，「叫」后面跟几个字全看语感，正则判不准。
 * 判不准就不判——错认一个人名会让整张卡从根上错。
 *
 * @param {string} line
 * @param {boolean} strict 严格模式：不认「关系词后面直接粘名字」那一种。
 *   记忆文件是短句（「父亲＝张三，1970 年生」），粘着写不会误判；
 *   项目档案是散文，满篇「父亲关系」「父亲手里」「奶奶家吃饭」，
 *   那种地方关系词后面跟的从来不是名字。两种文体不能用同一把尺子。
 */
function findPerson(line, strict = false) {
  const text = String(line ?? '').replace(/\*\*/g, '')

  // 写法一：父亲＝张三 / 父亲=张三
  const eq = text.match(/(父亲|母亲|爸爸|妈妈|爷爷|奶奶|外公|外婆|姥爷|姥姥|哥哥|姐姐|弟弟|妹妹|丈夫|妻子|老公|老婆|师傅|师父|导师|老师)\s*[＝=]\s*([\u4e00-\u9fa5]{2,4})/)
  if (eq !== null) {
    const name = eq[2].replace(/(生|是|在|的|现|曾|已).*$/, '')
    return [{ kin: eq[1], name: name.length >= 2 ? name : '' }]
  }

  // 写法二：师傅王先生 / 导师XX 教授 —— 名字后面跟着一个称呼后缀。
  //
  // 单独立出来，是因为「王先生」这种叫法后面往往直接接动词
  // （「师傅王先生只收过父亲一个徒弟」），靠标点断开判不出来。
  // 「先生」「院士」这类后缀是明确的称呼结尾，认它不容易误伤：
  // 「爷爷在 a 市做手艺」里没有后缀，仍然走下面那条更严的判断。
  const titled = text.match(/(父亲|母亲|爷爷|奶奶|外公|外婆|师傅|师父|导师|老师)([\u4e00-\u9fa5]{1,2}(?:先生|女士|医生|教授|院士))/)
  // 「父亲是教授」的后缀是「教授」，但前面的「是」是动词不是姓——
  // 姓用一个字是常见的（「王先生」全名就两字），所以这里只挡动词/虚词。
  // 「导师组副教授」里的「组副」也不是姓：职务词一律不当名字。
  if (
    titled !== null
    && !/^(是|在|的|有|已|曾|现|当|做|说|叫|和|与|给|把|被|从|到|也|还|都|就|不|没|这|那|一|个|位|名|们)/.test(titled[2])
    && !/[副正级位等们]/.test(titled[2])
  ) {
    return [{ kin: titled[1], name: titled[2] }]
  }

  // 写法三：父亲张三 —— 关系词后紧跟 2~3 个汉字，紧跟标点或括号
  //
  // 散文里这一条会疯狂误判，所以 strict 模式直接跳过它。
  if (!strict) {
    const glued = text.match(/(父亲|母亲|爷爷|奶奶|外公|外婆|师傅|师父)([\u4e00-\u9fa5]{2,3})(?=[，。、；：\s）)（(「【]|$)/)
    if (glued !== null) {
      const tail = glued[2]
      // 「父亲在浙江」这种不是名字
      if (!/^(在|是|的|有|已|曾|现|住|做|说|和|与|给|把|被|从|到|今|去|来|也|还|都|就|走|身|用|只)/.test(tail)) {
        // 「住爷爷奶奶家」里的「奶奶家」不是名字——关系词本身不能当人名
        if (!KIN_WORDS.some((k) => tail.includes(k))) return [{ kin: glued[1], name: tail }]
      }
    }
  }

  // 写法三：只知道关系词，没有名字。
  //
  // 逗号前后分开数：一句「**爷爷**a 市手艺……现身体还好，住爷爷奶奶家」
  // 里「奶奶」只是「爷爷奶奶家」这个词的一部分，不是另一个人。
  // 所以只认「关系词出现在分句开头」的位置——真正在讲这个人的句子，
  // 关系词几乎总在句首或紧跟标点；被顺手带一句的，都在中间。
  //
  // 宁可漏：多一个人，界面上就多一张「点开什么都没有」的空卡。
  const seen = []
  for (const clause of text.split(/[，,、]/)) {
    const head = clause.trim().replace(/^\*+/, '')
    for (const k of KIN_WORDS) {
      if (!head.startsWith(k)) continue
      if (k === '父亲' && /父亲节/.test(head)) continue
      if (!seen.includes(k)) seen.push(k)
    }
  }
  return seen.map((kin) => ({ kin, name: '' }))
}

/**
 * 从一段记忆文本里切出「句子」。中文句子按这几个标点断。
 * @returns {string[]}
 */
function sentences(text) {
  return String(text ?? '')
    .split(/[。；\n]/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/**
 * 把关系词归到一个「题库」上，好让访谈知道该问什么。
 * 对不上就回 parent——父母那套题（他为你做过什么、你们怎么吵、
 * 你第一次发现他是普通人的时刻）几乎对任何人都成立。
 */
function bankOf(kin) {
  if (['父亲', '母亲', '爸爸', '妈妈'].includes(kin)) return 'parent'
  if (['爷爷', '奶奶', '外公', '外婆', '姥爷', '姥姥'].includes(kin)) return 'grandparent'
  if (['哥哥', '姐姐', '弟弟', '妹妹'].includes(kin)) return 'sibling'
  if (['丈夫', '妻子', '老公', '老婆'].includes(kin)) return 'partner'
  if (['师傅', '师父', '导师', '老师'].includes(kin)) return 'teacher'
  if (['儿子', '女儿'].includes(kin)) return 'parent'
  return 'parent'
}

/**
 * 读记忆文件。
 *
 * 只读 USER.md 与 MEMORY.md——这两个是插件自己维护的投影，
 * memories.json 是内部结构，格式随时会变，不该依赖。
 *
 * @returns {Promise<{found: boolean, files: string[], chars: number, text: string}>}
 */
export async function readMemory(env = process.env) {
  for (const dir of candidateRoots(env)) {
    const files = []
    let text = ''
    for (const name of ['USER.md', 'MEMORY.md']) {
      const abs = path.join(dir, name)
      try {
        const body = await fs.readFile(abs, 'utf8')
        if (String(body).trim() === '') continue
        files.push(abs)
        text += body + '\n'
      } catch { /* 这个候选位置没有这个文件，试下一个 */ }
    }
    if (files.length > 0) return { found: true, dir, files, chars: text.length, text }
  }
  return { found: false, dir: null, files: [], chars: 0, text: '' }
}

/**
 * 看看记忆里能认出多少人。**不做任何写入**，界面先给用户看这个。
 *
 * @param {string} text readMemory 拿到的正文
 * @param {boolean} strict 严格模式，见 findPerson
 * @returns {Array<{kin: string, name: string, bank: string, lines: string[], clues: string[], missing: string[]}>}
 */
export function findPeople(text, strict = false) {
  /** @type {Map<string, {kin: string, name: string, bank: string, lines: string[], clues: string[]}>} */
  const byKey = new Map()

  for (const s of sentences(text)) {
    for (const hit of findPerson(s, strict)) {
      const key = hit.name !== '' ? `${hit.kin}:${hit.name}` : hit.kin
      const cur = byKey.get(key) ?? { kin: hit.kin, name: hit.name, bank: bankOf(hit.kin), lines: [], clues: [] }
      // 同一个人可能被提到很多次，句子攒起来——它们是之后做卡的原料
      if (!cur.lines.includes(s)) cur.lines.push(s)
      if (cur.name === '' && hit.name !== '') cur.name = hit.name
      byKey.set(key, cur)
    }
  }

  // 只知道关系、不知道名字的那种（「母亲在YYYY 公司」），如果同一关系
  // 后来又出现了名字（「母亲＝李梅」），合并成一条——否则列表里会有
  // 一个「母亲」和一个「母亲：李梅」，看起来像两个人。
  const out = []
  for (const p of byKey.values()) {
    const named = [...byKey.values()].find((x) => x.kin === p.kin && x.name !== '')
    if (p.name === '' && named !== undefined) {
      for (const l of p.lines) if (!named.lines.includes(l)) named.lines.push(l)
      continue
    }
    out.push(p)
  }

  // 去重（合并时同一个对象可能被 push 两次）
  const seen = new Set()
  const unique = out.filter((p) => {
    const k = `${p.kin}:${p.name}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  return unique.map(finalize)
}

/**
 * 把一条认出来的记录收尾：算线索、算「还缺什么」。
 *
 * 单独抽出来，是因为读项目档案那一路（findPeopleIn）也要走同一套判据。
 * 两处各写一份，早晚有一处漏改，界面上就会出现「材料里说缺三样、
 * 卡上的红点说只缺一样」这种自相矛盾的话。
 */
function finalize(p) {
  const blob = p.lines.join(' ')
  // 缺什么：这三样是「卡片能不能用」的最低线。缺了不是错，
  // 是「还要问」——界面上的红点就挂在缺得最多的那张上。
  const missing = []
  if (p.name === '') missing.push('名字')
  if (!/\d{4}\s*年|出生|生[于日]|\d{4}\.\d{2}/.test(blob)) missing.push('出生时间')
  if (!/做|工作|职|在.{2,10}(局|院|公司|学校|厂)|退休|手艺人|老师|工程师/.test(blob)) missing.push('做什么的')
  return {
    kin: p.kin,
    name: p.name,
    bank: p.bank,
    lines: p.lines,
    clues: p.lines.slice(0, 3),
    missing,
    sources: p.sources ?? [],
  }
}

/**
 * 从项目档案的正文里取出人起的标题。
 *
 * 档案开头是一段 frontmatter，`title:` 那一行就是这篇的题目。
 * 读不到就退回文件名——有个不好看的名字，也好过一堆无名氏。
 */
function titleOf(body, fileName) {
  const m = String(body ?? '').match(/^---\r?\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m)
  if (m !== null) return m[1].trim()
  return String(fileName ?? '').replace(/\.md$/, '')
}

/**
 * 读项目档案（记忆插件里那些成篇的文档）。
 *
 * 用户用记忆插件时，写得最细的往往不是 USER.md，而是这些档案：
 * 《家世与人物关系》《父亲张三权威信息补录》。只读 USER.md 会漏掉大半。
 *
 * **只读 active**：archived 是用户主动收起来的，再翻出来等于不尊重那个动作。
 *
 * @returns {Promise<{found: boolean, dir: string|null, docs: Array<{title: string, path: string, text: string}>}>}
 */
export async function readArchive(env = process.env) {
  for (const dir of candidateRoots(env)) {
    const docDir = path.join(dir, 'documents', 'active')
    let names = []
    try {
      names = await fs.readdir(docDir)
    } catch { continue /* 这个候选位置没有档案，试下一个 */ }
    const docs = []
    for (const name of names.sort()) {
      if (!name.endsWith('.md')) continue
      const abs = path.join(docDir, name)
      try {
        const body = await fs.readFile(abs, 'utf8')
        if (String(body).trim() === '') continue
        docs.push({ title: titleOf(body, name), path: abs, text: body })
      } catch { /* 单份读不了不该拖垮整批 */ }
    }
    if (docs.length > 0) return { found: true, dir: docDir, docs }
  }
  return { found: false, dir: null, docs: [] }
}

/**
 * 从好几处来源里一起认人。
 *
 * 为什么不把几份正文拼成一个大字符串：拼完就分不清「这是你自己写的」
 * 和「这是档案里记的」了。分开认、再按「关系+名字」合并，
 * 每个人身上留一份 `sources`，界面上就能说清「这个人是在哪几份文件里提到的」。
 *
 * @param {Array<{label: string, text: string, strict?: boolean}>} sources
 * @returns {Array} 与 findPeople 同形状，多一个 sources
 */
export function findPeopleIn(sources) {
  /** @type {Map<string, {kin: string, name: string, bank: string, lines: string[], sources: string[]}>} */
  const byKey = new Map()

  const list = Array.isArray(sources) ? sources : []

  // 先跑「不严格」的那几份（本机记忆），把它们提到的人都记下来。
  // 这一步是后面筛档案的尺子：档案里只提了「老师」「导师」这种没名没姓的，
  // 算不算一个人，取决于你自己写没写过这么个人。
  //   写过 → 档案里的那些句子是给这个人的补充
  //   没写过 → 八成只是散文里的一个过路人，收进来就是一张空卡
  const known = new Set()
  for (const { label, text, strict } of list) {
    if (strict === true) continue
    for (const p of findPeople(text, false)) known.add(p.kin)
  }

  for (const { label, text, strict } of list) {
    for (const p of findPeople(text, strict === true)) {
      // 档案里没名没姓、而且本机记忆里也从来没有这个人 → 不要
      if (strict === true && p.name === '' && !known.has(p.kin)) continue
      const key = p.name !== '' ? `${p.kin}:${p.name}` : p.kin
      const cur = byKey.get(key)
      if (cur === undefined) {
        byKey.set(key, {
          kin: p.kin,
          name: p.name,
          bank: p.bank,
          lines: [...p.lines],
          sources: label === '' ? [] : [label],
        })
      } else {
        for (const l of p.lines) if (!cur.lines.includes(l)) cur.lines.push(l)
        if (cur.name === '' && p.name !== '') cur.name = p.name
        if (label !== '' && !cur.sources.includes(label)) cur.sources.push(label)
      }
    }
  }

  // 只知道关系、后面又出现了名字的，合并成一条（与 findPeople 同一套规则）
  const out = []
  for (const p of byKey.values()) {
    const named = [...byKey.values()].find((x) => x.kin === p.kin && x.name !== '')
    if (p.name === '' && named !== undefined) {
      for (const l of p.lines) if (!named.lines.includes(l)) named.lines.push(l)
      for (const s of p.sources) if (!named.sources.includes(s)) named.sources.push(s)
      continue
    }
    out.push(p)
  }

  const seen = new Set()
  return out
    .filter((p) => {
      const k = `${p.kin}:${p.name}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .map(finalize)
}

/**
 * 把认出来的人变成「材料」，好让分析那一步能读到。
 *
 * 为什么不直接建卡：记忆里的信息一定是残的，直接建卡会造出一堆
 * 「只有一句话」的卡，体检分很低但也没法补——因为用户不知道缺什么。
 * 先落成材料，走正常的「分析 → 提案 → 人勾选」那条路，
 * 人能看见每一条到底是从哪句话来的，能拒绝。
 *
 * @returns {string} 一段可以直接写进 materials/ 的 Markdown
 */
export function renderMemoryMaterial(people, meta = {}) {
  const lines = []
  lines.push('# 从记忆里认出来的人')
  lines.push('')
  lines.push('> 这份是从本机记忆里摘出来的片段。只有提到过的句子，没有推断。')
  if (typeof meta.read_at === 'string') lines.push(`> 摘录时间：${meta.read_at}`)
  lines.push('')
  for (const p of people) {
    const title = p.name === '' ? p.kin : `${p.kin}：${p.name}`
    lines.push(`## ${title}`)
    lines.push('')
    // 写清「这是从哪儿看到的」：将来在卡上看到一句关于父亲的话，
    // 想知道它凭什么出现在这里，得能一路追回原标题。
    if (Array.isArray(p.sources) && p.sources.length > 0) {
      lines.push(`> 来自：${p.sources.join('、')}`)
      lines.push('')
    }
    for (const l of p.lines) lines.push(`- ${l}`)
    if (p.missing.length > 0) lines.push('', `（还缺：${p.missing.join('、')}）`)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * 一个人一份材料。
 *
 * 和上面那份「一次全给你」不同，这里只写一个人：之后让 AI 读的时候，
 * 它手上只有关于这个人的句子，不会顺手把父亲的职业写到爷爷头上。
 * 一条材料只装一个人，是这套东西里最便宜的隔离。
 *
 * @param {{kin: string, name: string, lines: string[], sources?: string[], missing: string[]}} person
 * @param {{read_at?: string}} [meta]
 * @returns {string} 一段 Markdown
 */
export function renderPersonMaterial(person, meta = {}) {
  const title = person.name === '' ? person.kin : `${person.kin}：${person.name}`
  const lines = []
  lines.push(`# ${title}`)
  lines.push('')
  lines.push('> 这份是从本机记忆和项目档案里摘出来的原话。只有提到过他的句子，没有推断。')
  if (typeof meta.read_at === 'string') lines.push(`> 摘录时间：${meta.read_at}`)
  if (Array.isArray(person.sources) && person.sources.length > 0) {
    lines.push(`> 来自：${person.sources.join('、')}`)
  }
  lines.push('')
  if (Array.isArray(person.missing) && person.missing.length > 0) {
    lines.push('## 还缺什么')
    lines.push('')
    lines.push(`这份材料里没写到：${person.missing.join('、')}。可以补，也可以先空着。`)
    lines.push('')
  }
  lines.push('## 提到他的原话')
  lines.push('')
  // 原话用引用块，一行一句。逐字保留是刻意的：AI 说的每一句都要能
  // 指回这些行，改一个字就指不回去了。
  for (const l of person.lines) lines.push(`> ${l}`)
  lines.push('')
  return lines.join('\n')
}

/**
 * 这份摘录里提到的人名/称呼，用来给卡片打「不完整」标记。
 * 导出卡的时候要用它拦一下：从记忆来的卡不该被当成写好的卡。
 */
export function isFromMemory(data) {
  return data?.memory_source === true
}
