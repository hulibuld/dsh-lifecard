/**
 * auto-diary —— 他没写日记，就把这一天从聊天记录里捡回来。
 *
 * 为什么单开一层：diary.js 管的是「一篇日记长什么样、怎么写进磁盘」，
 * 这一层管的是「材料从哪儿来、够不够写、模型写歪了怎么兜」。两件事的
 * 变化频率完全不同：日记的落盘格式一年可能不动，而会话记录的压缩格式
 * 跟着 DSH 版本走，改起来得能单独改。
 *
 * 这一层不碰 HTTP、不调模型、不碰 diary 的磁盘写入——它只读会话记录、
 * 拼材料、解析模型回的那段字。真正落盘仍然交给 diary.writeDiary，
 * 这样日记那六道保护（留底、冲突检测、用户自加的小节原样带走）绕不过去。
 *
 * ## 会话记录为什么长这样
 *
 * DSH 把每个会话写成一个 JSONL 流，再用 zstd 压起来：
 * ```
 * <home>/sessions/<转义过的 cwd>/<session-id>/session.v4.jsonl.zstd
 * ```
 * 目录名那层是 `--` 包起来的 cwd，`/` 换成 `-`。实测这台机器上
 * `--Users-joyfon620-.dsh-profiles-desktop--` 对应的就是
 * `/Users/joyfon620/.dsh/profiles/desktop`——点号留着，斜杠变横杠。
 *
 * 为什么不用 shell 去 `ls` 这个目录：名字以 `--` 开头，`ls --Users-...`
 * 会被 getopt 当成一串长选项吃掉，`cd` 同理。所以这一层从头到尾只用
 * node 的 fs API，一次 shell 都不落。
 *
 * ## 材料为什么要挑
 *
 * 一个会话里 90% 的行不能进日记：工具返回（几千字的文件内容）、系统提示、
 * 技能目录、子代理结束通知、压缩检查点……这些东西搬进日记，读起来像一份
 * 日志，不像一个人的一天。所以 extractText 只认两件事：
 * `user/message` 里**真的是用户说的**那段（source.kind 为 `user`），
 * 和 `assistant/message` 里 type 为 `text` 的块（reasoning 是自己想给自己
 * 听的，不算说出口的话）。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import zlib from 'node:zlib'
import * as diary from './diary.js'

/** 材料短到这个数以下，就不值得叫模型写一篇了——写出来也是硬凑。 */
export const AUTO_DIARY_MIN_CHARS = 50

/** 一篇日记正文的上限。超过就不是日记了，是周报。 */
export const AUTO_DIARY_MAX_CHARS = 500

/** 单条消息进材料前的上限。一条几千字的工具输出对「今天发生了什么」没有信息量。 */
const TURN_CHARS = 800

/** 拼材料时省略头的固定提示。预先扣掉它的长度，保证最终串不超 maxChars。 */
const DIGEST_ELISION = '（更早的对话省略）\n'

// ── 日期 ─────────────────────────────────────────────────────────

/** 本地日期 `YYYY-MM-DD`。不能用 toISOString，那是 UTC，晚上八点后会跳天。 */
function localDay(now = new Date()) {
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 10)
}

/** 某一天的本地时间区间 [start, end)。跨天判断全靠它。 */
function dayRange(now = new Date()) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return { start: start.getTime(), end: end.getTime() }
}

// ── 会话目录 ─────────────────────────────────────────────────────

/**
 * cwd → 会话目录名。
 *
 * 规则实测就一条：`--` + 把 `/` 全换成 `-` + `--`。
 * 点号、空格、中文都原样留着（`--Users-joyfon620-.dsh-profiles-desktop--`
 * 里那个点就是证据），所以这里只动斜杠，别的一概不碰。
 *
 * 末尾的斜杠先削掉：`/Users/a/b/` 和 `/Users/a/b` 是同一个地方，
 * 转出来不该是两个目录。
 */
export function sessionDirName(cwd) {
  const raw = String(cwd ?? '').trim()
  if (raw === '') return ''
  // Windows 上 cwd 带反斜杠，先归一，否则转出来的名字永远对不上。
  const slashed = raw.replace(/\\/g, '/')
  const body = slashed.replace(/^\/+/, '').replace(/\/+$/, '')
  return `--${body.split('/').join('-')}--`
}

/** 默认的 DSH 家目录。和 DSH 自己的取值顺序一致：环境变量优先。 */
function defaultHome() {
  const env = String(process.env.DSH_HOME ?? '').trim()
  return env === '' ? path.join(os.homedir(), '.dsh') : env
}

/**
 * 在这一层目录里找会话文件。
 *
 * 只认 `session.*.jsonl.zstd`（DSH 现在的形状）和裸 `.jsonl`
 * （还没压缩的中间状态）。不认 `.gz`：DSH 从来没用过 gzip 写会话，
 * 加这条只会让「读不到」显得像「读到了但是空的」。
 */
async function findSessionFile(dir) {
  let names
  try {
    names = await fs.readdir(dir)
  } catch {
    return null
  }
  const hits = names.filter((n) => /^session\..*\.jsonl(?:\.zstd)?$/.test(n))
  if (hits.length === 0) return null
  // 同一目录里同时有两种时，压缩的那份是新的。
  hits.sort((a, b) => Number(b.endsWith('.zstd')) - Number(a.endsWith('.zstd')))
  return path.join(dir, hits[0])
}

/** 解开一个会话文件。读不动就 `{ok:false}`，不抛。 */
async function readSessionFile(abs) {
  let buf
  try {
    buf = await fs.readFile(abs)
  } catch {
    return { ok: false }
  }
  try {
    if (abs.endsWith('.zstd')) return { ok: true, text: zlib.zstdDecompressSync(buf).toString('utf8') }
    return { ok: true, text: buf.toString('utf8') }
  } catch {
    // 压坏了 / 版本对不上。一个坏会话不该让今天整篇日记写不成。
    return { ok: false }
  }
}

/** 一行一个事件。坏行跳过：写到一半的会话末尾会有半行。 */
function parseEvents(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const one = line.trim()
    if (one === '') continue
    try {
      const ev = JSON.parse(one)
      // 磁盘上是一行一个事件，但调用方（测试、别的模块）可能直接甩一个
      // JSON 数组进来。顺手摊平，省得他们为了喂进来再自己拆一次。
      if (Array.isArray(ev)) {
        for (const item of ev) if (item !== null && typeof item === 'object') out.push(item)
      } else if (ev !== null && typeof ev === 'object') out.push(ev)
    } catch {
      // 忽略半行
    }
  }
  return out
}

/** 第一行那个 `session` 事件。没有就回 null。 */
function sessionMeta(events) {
  for (const ev of events) {
    if (ev?.type === 'session') return ev
  }
  return null
}

/**
 * 这个会话算不算子代理的。
 *
 * 子代理的对话是「任务派发」，不是这个人今天过的日子。他的日记里
 * 不该出现「基线守护者回报：文件未被改动」这种句子。
 * 除了 session 头上的两个标记，再看有没有 `subagent/descriptor`——
 * 有些旧会话头里没写 origin，但一定会有这个事件。
 */
function isSubagent(meta, events) {
  if (meta !== null) {
    if (String(meta.origin ?? '') === 'subagent') return true
    if (Number(meta.delegationDepth ?? 0) > 0) return true
  }
  return events.some((ev) => ev?.type === 'subagent/descriptor')
}

/** 事件落在哪一天。没有时间戳的事件（比如 session 头）一律不算今天。 */
function eventTime(ev) {
  const raw = ev?.time ?? ev?.data?.time ?? ev?.createdAt
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function inRange(ev, start, end) {
  const t = eventTime(ev)
  return t >= start && t < end
}

/**
 * 找某个 home 下、某个 cwd 的、今天的会话。
 *
 * 「今天」的判法有三层，缺一层就漏人：
 *   1. 文件最后写于今天（`mtime` 落在区间里）——第一层粗筛，避免把上千个
 *      历史会话全解压一遍；
 *   2. 会话头里的 `cwd` 对得上——防止 `--a-b--` 这种转义把两个不同路径
 *      撞成同一个目录（`/a/b` 和 `/a-b` 都会转成 `--a-b--`）；
 *   3. 事件的时间戳落在今天——**跨天的长会话靠这一层**：昨天开的会话、
 *      今天还在说，它的 `createdAt` 是昨天，但今天那些行必须算进来；
 *      反过来说，昨天开的会话今天别动过（改了标题之类），事件全在昨天，
 *      这一层会把它剔掉。
 *
 * 目录不存在 = 今天这个 cwd 没聊过天，是正常状态，不是错误。
 *
 * 返回的每个 session 除了约定的几个字段，还带着 `turns`——digestForDiary
 * 就靠它拼材料，不然调用方还得再解压一遍。
 */
export async function findTodaySessions({ home, cwd, now = new Date() } = {}) {
  const root = String(home ?? '').trim() === '' ? defaultHome() : String(home).trim()
  const name = sessionDirName(cwd)
  // cwd 是空的就说明调用方没给，无从找起。返回空比猜一个目录安全。
  if (name === '') return { ok: true, sessions: [] }
  const dir = path.join(root, 'sessions', name)
  let ids
  try {
    ids = await fs.readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { ok: true, sessions: [] }
    return { ok: false, sessions: [], error: '会话目录读不出来。检查一下那个文件夹的权限。' }
  }

  const { start, end } = dayRange(now)
  const wantCwd = String(cwd ?? '').trim().replace(/\/+$/, '')
  const sessions = []

  for (const entry of ids) {
    const abs = await findSessionFile(path.join(dir, entry))
    if (abs === null) continue
    let st
    try {
      st = await fs.stat(abs)
    } catch {
      continue
    }
    // 粗筛：今天没被写过的文件里不可能有今天的事。
    if (!(st.mtimeMs >= start && st.mtimeMs < end)) continue

    const raw = await readSessionFile(abs)
    if (raw.ok !== true) continue
    const events = parseEvents(raw.text)
    const meta = sessionMeta(events)
    if (isSubagent(meta, events)) continue
    // 转义会撞名：`/a/b` 与 `/a-b` 转出来一模一样。会话头里存着真 cwd，
    // 对不上就说明这个会话属于另一个同名目录。
    const metaCwd = String(meta?.cwd ?? '').trim().replace(/\/+$/, '')
    if (metaCwd !== '' && wantCwd !== '' && metaCwd !== wantCwd) continue

    const today = events.filter((ev) => inRange(ev, start, end))
    if (today.length === 0) continue
    const got = extractText(today)
    // 一个字都抽不出来的会话不是「今天的会话」。真机上常见：宿主自己开的
    // idle review 会话，里面全是委派提示，过滤完一条人话都没有。把它算进来
    // 只会让调用方以为今天聊过天，实际材料是空的。
    if (got.turns.length === 0) continue

    sessions.push({
      id: String(meta?.id ?? entry),
      path: abs,
      createdAt: Number(meta?.createdAt ?? 0) || 0,
      cwd: metaCwd,
      origin: String(meta?.origin ?? ''),
      agentPreset: String(meta?.agentPreset ?? ''),
      chars: got.chars,
      // 条数，不是文件行数：调用方关心的是「今天说了几句话」。
      lines: got.turns.length,
      turns: got.turns,
    })
  }

  // 老会话在前，材料按时间读下来才像一天的流水。
  sessions.sort((a, b) => a.createdAt - b.createdAt)
  return { ok: true, sessions }
}

// ── 从事件里抽字 ─────────────────────────────────────────────────

/**
 * 消息体的 content 可能是字符串、也可能是块数组。只要 text 块。
 *
 * assistant 的 content 里混着 `reasoning`（模型自己嘀咕）和 `tool-call`
 * （一串 JSON 参数）。前者是它没打算说出口的话，后者是它动的手——
 * 两者搬进日记都会变成一句莫名其妙的句子。
 */
function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (String(block.type ?? '') !== 'text') continue
    if (typeof block.text === 'string' && block.text.trim() !== '') parts.push(block.text)
  }
  return parts.join('\n')
}

/** 用户消息里哪些是「这个人真的在说话」。其余都是宿主塞进来的旁白。 */
const USER_NOISE_KINDS = new Set([
  'agent-instructions',
  'runtime-context',
  'skill-catalog',
  'time-context',
  'dsh-mnemon',
  'tool-jobs',
  'compact-checkpoint',
  'subagent-settled',
  'developer',
  'system',
])

/**
 * 从事件数组里抽出能进日记的文字。
 *
 * 只认两种事件：
 *   - `user/message`：source.kind 必须是 `user`（或干脆没有 source）。
 *     一个真实会话里，用户角色的事件绝大多数不是用户说的——技能目录、
 *     时间快照、内存快照、后台任务完成通知，全都以 user 身份塞进来。
 *     不按 source.kind 过一遍，日记会变成一份系统日志摘抄。
 *   - `assistant/message`：只取 text 块。
 *
 * 其余一律跳过：`tool/call`、`tool/result`、`system/message`、
 * `subagent/descriptor`、`request/header`……
 *
 * 单条超过 800 字砍掉：长输出的信息密度极低，而且会把 12k 的材料预算
 * 一口吃掉，后面真正像人话的对话就挤不进去了。
 *
 * 还有一层没法只靠 source.kind 挡：宿主的委派提示也把 kind 写成 `user`。
 * 真机上抓到的例子是 `[dsh-mnemon:delegated review]` 开头的一整段 24000 字，
 * 里面是「待审证据」清单——它确实是机器塞进来的，但标签是用户。
 * 这种一律靠正文头的方括号标签 + `<system-reminder>` 认出来丢掉。
 */
export function extractText(events, options = {}) {
  const list = Array.isArray(events)
    ? events
    : typeof events === 'string'
      ? parseEvents(events)
      : null
  if (list === null) return { ok: false, turns: [], chars: 0, error: '事件不成数组。' }
  const limit = Number.isFinite(Number(options?.maxPerTurn)) && Number(options.maxPerTurn) > 0
    ? Math.floor(Number(options.maxPerTurn))
    : TURN_CHARS

  const turns = []
  let chars = 0
  for (const ev of list) {
    const type = String(ev?.type ?? '')
    const data = ev?.data !== null && typeof ev?.data === 'object' ? ev.data : {}
    // user 的事件把内容摊在 data 上，assistant 的包在 data.message 里。
    const msg = data.message !== null && typeof data.message === 'object' ? data.message : data
    let who = ''
    if (type === 'user/message') {
      const kind = String(data.source?.kind ?? msg.source?.kind ?? '')
      if (kind !== '' && kind !== 'user') continue
      if (USER_NOISE_KINDS.has(kind)) continue
      who = '我'
    } else if (type === 'assistant/message') {
      who = 'TA'
    } else {
      continue
    }
    let text = textOfContent(msg.content ?? data.content).trim()
    if (text === '') continue
    // 兜底一：包在 system-reminder 里的不是人话。
    // 兜底二：宿主的委派提示顶着 `[dsh-xxx:...]` 的方括号标签混进 user 身份，
    // 真机上那段 `[dsh-mnemon:delegated review]` 有两万四千字，全靠这一条拦住。
    if (/^<system-reminder>/.test(text)) continue
    if (/^\[(?:dsh|ds|system|runtime)-[a-z0-9._-]*:/i.test(text)) continue
    if (Array.from(text).length > limit) text = `${Array.from(text).slice(0, limit).join('')}…`
    turns.push({ who, text, time: eventTime(ev) })
    chars += text.length
  }
  return { ok: true, turns, chars }
}

// ── 拼材料 ───────────────────────────────────────────────────────

/**
 * 把若干会话的文字合成一段给模型看的材料。
 *
 * 超长时**留最近的、砍最早的**。反过来的话，模型读到的是今天早上
 * 那份报错，而晚上那场真正的谈话一个字都不剩——日记写给谁看？
 *
 * 预算里预扣了省略提示的长度，所以最终串一定不超 maxChars：
 * 调用方（路由那边）会拿它去卡上下文，超了就是超了。
 */
export function digestForDiary(sessions, options = {}) {
  const maxChars = Number.isFinite(Number(options?.maxChars)) && Number(options.maxChars) > 0
    ? Math.floor(Number(options.maxChars))
    : 12000
  const list = Array.isArray(sessions) ? sessions : []

  const flat = []
  for (const one of list) {
    const turns = Array.isArray(one?.turns) ? one.turns : []
    for (const t of turns) {
      const text = String(t?.text ?? '').trim()
      if (text === '') continue
      flat.push({ who: String(t?.who ?? '我'), text, time: Number(t?.time) || 0 })
    }
  }
  // 时间戳缺失的（不该有）按原顺序排在最前面，别让排序把它们搅乱。
  flat.sort((a, b) => a.time - b.time)

  if (flat.length === 0) return ''

  let budget = maxChars - DIGEST_ELISION.length
  if (budget < 0) budget = maxChars
  const picked = []
  let used = 0
  for (let i = flat.length - 1; i >= 0; i -= 1) {
    const one = flat[i]
    // `我：` 两个字符 + 换行。算在预算里，否则拼出来会比预算长一截。
    const cost = one.text.length + 3
    if (used + cost > budget) break
    picked.push(one)
    used += cost
  }
  picked.reverse()

  let head = ''
  if (picked.length === 0) {
    // 预算比最后一条还小：那就只留最后一条的尾巴。至少还有今天最后一句话。
    const last = flat[flat.length - 1]
    const chars = Array.from(last.text)
    const keep = Math.max(1, maxChars - 3)
    return `${last.who}：${chars.slice(Math.max(0, chars.length - keep)).join('')}`
  }
  if (picked.length < flat.length) head = DIGEST_ELISION

  return `${head}${picked.map((one) => `${one.who}：${one.text}`).join('\n')}`
}

// ── 该不该写 ─────────────────────────────────────────────────────

/** 今天这篇日记到底算不算「已经写过」。 */
function hasDiary(todayDiary) {
  if (todayDiary === null || todayDiary === undefined || todayDiary === false) return false
  if (typeof todayDiary === 'string') return todayDiary.trim() !== ''
  if (typeof todayDiary !== 'object') return Boolean(todayDiary)
  // readDiary 的返回值：`{ok:true, data:null, missing:true}` 是「还没写」。
  const data = todayDiary.data
  if (data === null || data === undefined) {
    // 调用方可能直接传了 diary.parseDiaryText 的 data（没有外层 ok/data）。
    const own = diary.DIARY_SECTIONS.some((title) => {
      const value = todayDiary[title]
      return Array.isArray(value) ? value.length > 0 : String(value ?? '').trim() !== ''
    })
    return own
  }
  if (typeof data === 'string') return data.trim() !== ''
  return diary.DIARY_SECTIONS.some((title) => {
    const value = data[title]
    return Array.isArray(value) ? value.length > 0 : String(value ?? '').trim() !== ''
  })
}

/** 材料长度。既收字符串，也收 digestForDiary 之外的 `{text}` / `{chars}`。 */
function materialLength(material) {
  if (material === null || material === undefined) return 0
  if (typeof material === 'string') return material.trim().length
  if (typeof material === 'object') {
    if (typeof material.text === 'string') return material.text.trim().length
    if (Number.isFinite(Number(material.chars))) return Number(material.chars)
  }
  return 0
}

/**
 * 今天这一天该不该自动写一篇。
 *
 * 三个「不写」，顺序是刻意的：先看有没有写过（写过就一个字都不该动，
 * 哪怕材料再足），再看今天有没有聊过（没聊过就没有材料），最后看材料
 * 够不够。任何一个提前返回都能省掉后面一次解压或一次模型调用。
 */
export function shouldAutoWrite({ todayDiary, material } = {}) {
  if (hasDiary(todayDiary)) return { should: false, reason: '今天写过了' }
  const len = materialLength(material)
  if (len === 0) return { should: false, reason: '今天没聊过天' }
  if (len < AUTO_DIARY_MIN_CHARS) {
    return { should: false, reason: `今天的材料只有 ${len} 字，不到 ${AUTO_DIARY_MIN_CHARS} 字，写出来是硬凑` }
  }
  return { should: true, reason: `今天有 ${len} 字材料，可以写` }
}

// ── 给模型的话 ───────────────────────────────────────────────────

/**
 * 拼给模型的两段话。体例跟着 diary.buildDiarySystem/buildDiaryUser：
 * system 说规矩，user 放材料。
 *
 * system 里反复念的四件事，都是模型真的会做错的地方：
 *   - 字数：不写死区间，它会写到 1200 字；
 *   - 标题：它会「优化」成「今天最值得记录的一件事」；
 *   - 不许编：它会补一个「下午三点，在咖啡馆」；
 *   - 材料不够就写短：它会为了凑满 500 字把一句话拆成三句。
 */
export function buildAutoDiaryPrompt({ date, material, recent = '' } = {}) {
  const day = String(date ?? '').trim() === '' ? localDay() : String(date).trim()
  const system = [
    '你在替这个人写今天的日记。他今天没顾上写，你从聊天记录里把他这一天捡回来。',
    '不是写总结报告，是替他把今天记下来——用他自己的口气，第一人称。',
    '',
    '# 只写材料里真的发生过的',
    '材料里没有的事，一个字都不要写。不要补时间、不要补地点、不要补人物，也不要替他推测动机。',
    '他的原话可以用，但别整段照抄。代码、报错、文件路径这些东西，写成「他在改一个插件」就够了，不要搬原始输出。',
    '',
    '# 篇幅：50 到 500 字',
    '全文五节加起来 50 到 500 字。材料多就写到接近 500，材料少就写短。',
    '材料不够就别凑字——80 字写完今天，比 500 字注水强。',
    '',
    '# 五节的标题一个字都不能改',
    '下面这五行照抄，不要加序号、不要加粗、不要换词、不要调整顺序：',
    ...diary.DIARY_SECTIONS.map((title) => `## ${title}`),
    '',
    '每节一到三句话。',
    '某一节今天确实没东西可说，就写一句「今天没碰这块」，不要留个空标题，也不要拿别的节的内容来填。',
    '「情绪往下三层」只写他自己说过的、或者话里明显露出来的情绪，不要替他造一个。',
    '「下一步」写他自己说了要做的事；他没说，就写「还没定」。',
    '',
    '# 语气',
    '像他本人在本子上随手记的，不是对外汇报。不要开头套话，不要结尾升华，不要写「今天又是充实的一天」。',
  ].join('\n')

  const body = String(material ?? '').trim()
  const user = [
    `日期：${day}`,
    '',
    '# 今天的聊天记录',
    body === '' ? '（今天没有聊天记录。）' : body,
  ]
  const tail = String(recent ?? '').trim()
  if (tail !== '') {
    user.push('', '# 前几天写到哪儿', tail, '', '这一篇往前接着写，别跟前几天写成一模一样的东西。')
  }
  return { system, user: user.join('\n') }
}

// ── 把模型写的正文收回来 ─────────────────────────────────────────

/** 标题前后的各种装饰。模型每次都不一样，这里一次收齐。 */
function headingMatcher(title) {
  const t = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // `## 标题` / `### 标题` / `#### 标题`（多到六级，模型爱用三级）
  // `**标题**` / `**标题：**` / `**【标题】**`
  // `【标题】` / `标题：`（单独成行，冒号后面没东西）
  return new RegExp(
    `^(?:` +
      `#{1,6}\\s*${t}\\s*[:：]?` +
      `|\\*\\*\\s*【?\\s*${t}\\s*】?\\s*[:：]?\\s*\\*\\*\\s*[:：]?` +
      `|【\\s*${t}\\s*】\\s*[:：]?` +
      `|${t}\\s*[:：]` +
    `)\\s*(.*)$`,
  )
}

/**
 * 把模型写回来的正文解析成 diary.writeDiary 要的 data。
 *
 * 为什么不直接扔给 diary.parseDiaryText：它只认 `^## `。模型给三级标题、
 * 给加粗、给 `【】`，都切不出节来，结果是一整段全落进 intro，五节全空。
 * 所以先在这里把三种写法统一成 `## 标题`，再交给那个久经考验的解析器——
 * 它认得同名小节合并、认得围栏、认得用户自己加的小标题。
 *
 * 五节缺哪节就留空字符串，不报错：模型少写一节是常事，为此让整篇写不成
 * 不值得。但五节**一节都没认出来**是另一种情况——那说明模型压根没照格式
 * 写，这时候强行落盘会写出一篇空日记，所以返回 ok:false 让调用方重试或放弃。
 *
 * 超长按节等比例砍：只砍一节会让那一节断在半句，等比例至少五节都还读得通。
 */
export function parseAutoDiary(text, date) {
  const raw = String(text ?? '').replace(/\r\n?/g, '\n')
  const titles = diary.DIARY_SECTIONS
  const matchers = titles.map((title) => ({ title, re: headingMatcher(title) }))

  const lines = raw.split('\n')
  const out = []
  let found = 0
  let inFence = false
  for (const line of lines) {
    // 围栏里的 `## 标题` 是示例代码，不是小节。模型偶尔会把格式说明
    // 连同正文一起贴回来，不过滤就会把示例当正文。
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    const trimmed = line.trim()
    let hit = null
    for (const one of matchers) {
      const m = one.re.exec(trimmed)
      if (m !== null) {
        hit = { title: one.title, rest: String(m[1] ?? '').trim() }
        break
      }
    }
    if (hit === null) {
      out.push(line)
      continue
    }
    found += 1
    out.push(`## ${hit.title}`)
    // `## 标题：今天就干了一件事` 这种一行写完的，把冒号后面那段接回去。
    if (hit.rest !== '') out.push('', hit.rest)
  }

  if (found === 0) {
    return {
      ok: false,
      data: { date: String(date ?? '').trim(), sections: [] },
      chars: 0,
      truncated: false,
      missing: titles.slice(),
      error: '模型的回复里一节都没认出来，没法落盘。',
    }
  }

  // 补一个 frontmatter 再交给 diary 的解析器：它要求文件开头有那两行。
  const day = diary.dateFileName(date) === '' ? localDay() : String(date).trim()
  const wrapped = `---\nlifecard: 0.1\nkind: lifecard-diary\ndate: ${day}\n---\n\n${out.join('\n')}\n`
  const parsed = diary.parseDiaryText(wrapped)

  const sections = []
  let total = 0
  for (const title of titles) {
    const body = parsed.ok === true ? String(parsed.data?.[title] ?? '').trim() : ''
    sections.push({ title, body })
    total += body.length
  }
  const missing = sections.filter((one) => one.body === '').map((one) => one.title)

  let truncated = false
  if (total > AUTO_DIARY_MAX_CHARS) {
    truncated = true
    const ratio = AUTO_DIARY_MAX_CHARS / total
    let used = 0
    for (let i = 0; i < sections.length; i += 1) {
      const one = sections[i]
      if (one.body === '') continue
      const chars = Array.from(one.body)
      // 最后一节吃剩下的余量，前面各节按比例砍——这样总数正好落在上限上，
      // 不会因为每节都向下取整而白扔掉十来个字。
      const quota = i === sections.length - 1
        ? Math.max(0, AUTO_DIARY_MAX_CHARS - used)
        : Math.floor(chars.length * ratio)
      if (chars.length > quota) one.body = chars.slice(0, quota).join('')
      // 砍断的地方给个省略号，读的人看得出来这不是他写到一半停了。
      if (quota > 0 && one.body !== '' && one.body.length < chars.length) {
        one.body = `${Array.from(one.body).slice(0, Math.max(1, quota - 1)).join('')}…`
      }
      used += one.body.length
    }
  }

  const data = { date: diary.dateFileName(day) === '' ? localDay() : day, sections }
  // 顺手摊平一遍：diary.writeDiary / renderDiaryMarkdown 读的是 `data[标题]`，
  // 摊平了就能直接 `writeDiary(dir, parsed.data)`，调用方不用再拆一次数组。
  for (const one of sections) data[one.title] = one.body
  const chars = sections.reduce((sum, one) => sum + one.body.length, 0)

  return { ok: true, data, chars, truncated, missing }
}

export default {
  AUTO_DIARY_MIN_CHARS,
  AUTO_DIARY_MAX_CHARS,
  sessionDirName,
  findTodaySessions,
  extractText,
  digestForDiary,
  shouldAutoWrite,
  buildAutoDiaryPrompt,
  parseAutoDiary,
}
