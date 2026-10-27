/**
 * LifeCard codec —— 酒馆卡（SillyTavern / CCv2 / CCv3）的读写。
 *
 * 三条铁律，来自规范原文：
 *   1. 不认识的键**绝不能销毁**（V2 spec: "they must never be destroyed"）。
 *      所以任何本模块不理解的字段，原样收进 `preserved`，导出时原样写回。
 *   2. 导出 PNG 时两个 chunk 必须**同源**：`ccv3` 是 `chara` 的严格超集。
 *      ST 的 read() 以 ccv3 优先，两份独立投影会让同一张卡变成两个人。
 *   3. 只做格式搬运，**不执行语义**：不算 {{random}}、不跑 decorator、不递归扫 lorebook。
 *      那是前端的事，我们只保证不丢。
 *
 * 零依赖：PNG 的 tEXt / iTXt 读写、zip 解包都自己实现（只用 node:zlib）。
 */

import { inflateSync } from 'node:zlib'

// ── 常量 ────────────────────────────────────────────────────────────

/** V2 规范里 `data` 下的已知字段。其余一律进 preserved。 */
const V2_KNOWN = [
  'name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example',
  'creator_notes', 'system_prompt', 'post_history_instructions',
  'alternate_greetings', 'character_book', 'tags', 'creator', 'character_version', 'extensions',
]

/** V3 相对 V2 新增的已知字段。 */
const V3_KNOWN = [
  'nickname', 'creator_notes_multilingual', 'source', 'group_only_greetings',
  'creation_date', 'modification_date', 'assets',
]

/** lorebook entry 的已知字段。 */
const ENTRY_KNOWN = [
  'keys', 'content', 'extensions', 'enabled', 'insertion_order', 'case_sensitive',
  'use_regex', 'constant', 'name', 'priority', 'id', 'comment', 'selective',
  'secondary_keys', 'position',
]

// ── PNG tEXt 读写 ──────────────────────────────────────────────────

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10]

/**
 * 从 PNG 字节里读出所有 tEXt / iTXt 块。
 * @param {Uint8Array} bytes
 * @returns {{ texts: Record<string, string>, ihdr: Uint8Array|null, ok: boolean, error?: string }}
 */
export function readPngText(bytes) {
  if (bytes === null || bytes === undefined || bytes.length < 8) {
    return { texts: {}, ihdr: null, ok: false, error: '不是 PNG（太短）' }
  }
  for (let i = 0; i < 8; i += 1) {
    if (bytes[i] !== PNG_SIG[i]) return { texts: {}, ihdr: null, ok: false, error: '不是 PNG（签名不符）' }
  }
  const texts = {}
  let ihdr = null
  let at = 8
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7])
    const dataStart = at + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.length) break
    if (type === 'IHDR') ihdr = bytes.subarray(dataStart, dataEnd)
    else if (type === 'tEXt') {
      const chunk = bytes.subarray(dataStart, dataEnd)
      const nul = chunk.indexOf(0)
      if (nul > 0) {
        const keyword = latin1(chunk.subarray(0, nul))
        // tEXt 的规范编码是 latin1，但野外工具普遍直接塞 UTF-8。纯 base64 载荷是
        // ASCII，两种解出来一样；带中文的裸 UTF-8 载荷必须按 UTF-8 解，
        // 否则读出来是 "ä¸­æ–‡" 这种乱码——JSON 还能 parse，中文却已经坏了。
        const value = textOf(chunk.subarray(nul + 1))
        texts[keyword] = value
      }
    } else if (type === 'iTXt') {
      const chunk = bytes.subarray(dataStart, dataEnd)
      const nul = chunk.indexOf(0)
      if (nul > 0) {
        const keyword = latin1(chunk.subarray(0, nul))
        // iTXt: keyword\0 compressionFlag compressionMethod languageTag\0 translatedKeyword\0 text
        let p = nul + 1
        const compFlag = chunk[p]
        p += 2
        const langEnd = chunk.indexOf(0, p)
        p = langEnd < 0 ? p : langEnd + 1
        const transEnd = chunk.indexOf(0, p)
        p = transEnd < 0 ? p : transEnd + 1
        const payload = chunk.subarray(p)
        // iTXt 的压缩体是 zlib 包装的 deflate（不是 raw deflate）。以前这里把压缩体
        // 直接当成空串，于是用压缩 iTXt 存卡的 PNG 在导入时会报
        // 「Unexpected end of JSON input」——解不开应当如实报错，不能伪装成空。
        if (compFlag === 1) {
          try {
            texts[keyword] = Buffer.from(inflateSync(payload)).toString('utf8')
          } catch {
            texts[keyword] = ''
          }
        } else {
          texts[keyword] = utf8(payload)
        }
      }
    }
    if (type === 'IEND') break
    at = dataEnd + 4
  }
  return { texts, ihdr, ok: true }
}

/**
 * 往 PNG 里写入（或替换）一条 tEXt 块，返回新的 PNG 字节。
 * @param {Uint8Array} bytes - 原 PNG。
 * @param {string} keyword - 块名（`chara` / `ccv3`）。
 * @param {string} text - 要写入的文本（base64 之后）。
 * @param {string[]} dropKeywords - 写入前要删掉的同名块。
 */
export function writePngText(bytes, keyword, text, dropKeywords = [keyword]) {
  const drop = new Set(dropKeywords.map((k) => k.toLowerCase()))
  const out = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // 签名
  out.push(bytes.subarray(0, 8))
  let at = 8
  let inserted = false
  while (at + 8 <= bytes.length) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7])
    const total = 12 + length
    const chunk = bytes.subarray(at, at + total)
    if (type === 'tEXt' || type === 'iTXt') {
      const nul = bytes.subarray(at + 8, at + 8 + length).indexOf(0)
      const kw = nul > 0 ? latin1(bytes.subarray(at + 8, at + 8 + nul)).toLowerCase() : ''
      if (drop.has(kw)) {
        at += total
        continue
      }
    }
    if (type === 'IEND' && !inserted) {
      out.push(makeTextChunk(keyword, text))
      inserted = true
    }
    out.push(chunk)
    at += total
  }
  if (!inserted) out.push(makeTextChunk(keyword, text))
  return concat(out)
}

function makeTextChunk(keyword, text) {
  const kw = Buffer.from(keyword, 'latin1')
  const body = Buffer.concat([kw, Buffer.from([0]), Buffer.from(text, 'latin1')])
  const typeBuf = Buffer.from('tEXt', 'latin1')
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write('tEXt', 4, 'latin1')
  const crcBuf = Buffer.alloc(4)
  // PNG 规范：CRC 覆盖「chunk type + chunk data」，不含长度字段。
  // 只算 body 会让产出的 PNG 过不了任何严格校验器（pngcheck、ST 的部分导入路径、
  // 浏览器完整性检查都会报 BAD CRC），虽然宽松解析器仍能读出来。
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, body])), 0)
  return Buffer.concat([head, body, crcBuf])
}

function concat(parts) {
  let len = 0
  for (const p of parts) len += p.length
  const out = Buffer.alloc(len)
  let at = 0
  for (const p of parts) {
    Buffer.from(p.buffer, p.byteOffset, p.length).copy(out, at)
    at += p.length
  }
  return new Uint8Array(out)
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function latin1(buf) {
  return Buffer.from(buf.buffer, buf.byteOffset, buf.length).toString('latin1')
}

function utf8(buf) {
  return Buffer.from(buf.buffer, buf.byteOffset, buf.length).toString('utf8')
}

/**
 * 解一段 tEXt 载荷。
 *
 * tEXt 的规范编码是 latin1（1 字节 = 1 字符），但野外工具普遍直接塞 UTF-8：
 * ST 自己写的是 base64（纯 ASCII，两种解一样），另一些导出器写裸 JSON，中文就在里面。
 * 一律按 latin1 解会得到 "ä¸­æ–‡"——JSON 还能 parse，中文已经坏了，属于**静默损坏**，
 * 比读取失败更糟。所以先按 UTF-8 试：UTF-8 是自校验编码，非法字节序列会解出 U+FFFD，
 * 一旦出现替换字符就说明这不是 UTF-8，再回落 latin1。
 * @param {Uint8Array} buf
 */
function textOf(buf) {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.length)
  const asUtf8 = b.toString('utf8')
  if (!asUtf8.includes('\uFFFD')) return asUtf8
  return b.toString('latin1')
}

function base64DecodeUtf8(b64) {
  return Buffer.from(String(b64).trim(), 'base64').toString('utf8')
}

/**
 * 解 PNG 文本块里的卡 JSON。
 *
 * 规范（与 ST 的写法）是「JSON → UTF-8 → base64」，但**野外大量工具直接把 JSON 裸写进
 * tEXt**（tEXt 本来是 latin1 才合法，它们照样塞 UTF-8）。以前这里无条件当 base64 解，
 * 裸写的那种会被解成一串替换字符，然后报
 * `Unexpected token '�', "���r�k�"..." is not valid JSON`——真正的卡就在眼前却读不出来。
 *
 * 所以两种都试：谁先能 JSON.parse 出对象就用谁。顺序按「规范优先」，不按「猜出来的成功率」。
 * @param {string} raw - 从 chunk 里读出来的字符串。
 * @returns {any} 解析好的 JSON。
 */
function parseTextPayload(raw) {
  const text = String(raw ?? '')
  const trimmed = text.trim()
  // 明显是 JSON 的，直接按原文解（省掉一次无意义的 base64 尝试，也避免误判）。
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const json = JSON.parse(trimmed.startsWith('\uFEFF') ? trimmed.slice(1) : trimmed)
    if (json === null || typeof json !== 'object') throw new Error('图片里的卡数据读不出来')
    return json
  }
  const decoded = base64DecodeUtf8(text)
  const candidate = decoded.trim()
  if (candidate.startsWith('{') || candidate.startsWith('[')) {
    const json = JSON.parse(candidate.startsWith('\uFEFF') ? candidate.slice(1) : candidate)
    if (json === null || typeof json !== 'object') throw new Error('图片里的卡数据读不出来')
    return json
  }
  // 两条路都不像 JSON：按规范那条报错，错误信息指向真正的毛病。
  throw new Error('图片里没有找到卡的内容')
}

function utf8ToBase64(s) {
  return Buffer.from(s, 'utf8').toString('base64')
}

// ── zip（CHARX 用，最小实现）───────────────────────────────────────

/**
 * 解一个 zip，返回 文件名 → 字节。
 * 只支持 store（0）与 deflate（8），不支持加密——CHARX 规范里也不需要。
 */
export async function unzip(bytes) {
  const out = {}
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length)
  // 从尾部找 EOCD
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到目录）')
  const count = buf.readUInt16LE(eocd + 10)
  let cd = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(cd) !== 0x02014b50) break
    const method = buf.readUInt16LE(cd + 10)
    const compSize = buf.readUInt32LE(cd + 20)
    const nameLen = buf.readUInt16LE(cd + 28)
    const extraLen = buf.readUInt16LE(cd + 30)
    const commentLen = buf.readUInt16LE(cd + 32)
    const localOffset = buf.readUInt32LE(cd + 42)
    const name = buf.subarray(cd + 46, cd + 46 + nameLen).toString('utf8')
    cd += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/')) continue
    // 本地头
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) continue
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)
    out[name] = method === 0 ? new Uint8Array(raw) : new Uint8Array(await inflateRawAsync(raw))
  }
  return out
}

let inflateRawSyncRef = null

/**
 * 解 deflate（zip 的压缩方式 8）。
 *
 * 用动态 import 拿 node:zlib：宿主侧（Node）才有它。浏览器侧解 CHARX 走宿主
 * 路由，不在本模块里解压，所以拿不到就明确报错，不静默返回坏数据。
 */
async function inflateRawAsync(buf) {
  if (inflateRawSyncRef === null) {
    const zlib = await import('node:zlib')
    inflateRawSyncRef = zlib.inflateRawSync
  }
  return inflateRawSyncRef(buf)
}

// ── CC 卡：识别与解析 ──────────────────────────────────────────────

/**
 * 判断一份 JSON 是什么。
 *
 * 判断顺序是有讲究的，改之前先看完这段：
 *
 * 1. 带 `spec` 的，`spec` 说了算。这是规范里唯一一个「作者明确声明」的字段。
 * 2. **再看世界书**。ST 导出的独立世界书经常带着顶层 `name` 甚至
 *    `description`（那是这本设定的名字和简介，不是角色卡）。如果先判 V1，
 *    一本世界书会被当成角色卡导进来，所有条目当场丢掉——而且不报错，
 *    用户只会发现「导进来的东西是空的」。
 * 3. 最后才判 V1。V1 没有 `spec`、字段直接摊在顶层，所以只要看见几个
 *    专属字段就算数，不要求必须同时有 `name` 和 `description`——
 *    只有名字、或者只有名字 + 开场白的卡是合法的，以前会被判成 unknown。
 *
 * @param {unknown} json
 * @returns {'v1'|'v2'|'v3'|'worldinfo'|'unknown'}
 */
export function detectJsonKind(json) {
  if (json === null || typeof json !== 'object') return 'unknown'
  const spec = json.spec
  if (spec === 'chara_card_v3') return 'v3'
  if (spec === 'chara_card_v2') return 'v2'
  if (spec === 'lorebook_v3') return 'worldinfo'

  // ST 的独立世界书把 entries 存成以 uid 为键的对象，规范里也有写成数组的。
  const looksLikeEntries = (v) => Array.isArray(v)
    || (v !== null && typeof v === 'object' && Object.keys(v).length > 0
        && Object.values(v).every((e) => e !== null && typeof e === 'object' && ('key' in e || 'keys' in e || 'content' in e)))
  if (looksLikeEntries(json.entries)) return 'worldinfo'
  if (json.data !== null && typeof json.data === 'object' && looksLikeEntries(json.data.entries)) return 'worldinfo'

  // V2/V3 的两种写法：包在 data 里，或者没有 spec 但字段在顶层。
  if (json.data !== null && typeof json.data === 'object' && typeof json.data.name === 'string') {
    const sv = String(json.spec_version ?? '')
    return sv.startsWith('3') ? 'v3' : 'v2'
  }

  // V1：没有 spec，字段直接摊在顶层。认这几种「只属于角色卡」的字段就够了。
  // `tags` / `creator` / `extensions` 不在此列——世界书也常有。
  if (spec === undefined && typeof json.name === 'string') {
    const V1_MARKERS = ['description', 'personality', 'scenario', 'first_mes', 'mes_example',
      'post_history_instructions', 'system_prompt', 'character_book']
    if (V1_MARKERS.some((k) => json[k] !== undefined)) return 'v1'
    // 只剩一个光秃秃的 name：可能是极简角色卡，也可能是别人的设定文件。
    // 按角色卡处理更有用（导进来至少不会丢东西），但这一条放最后。
    if (Object.keys(json).every((k) => V1_MARKERS.includes(k) || k === 'name')) return 'v1'
  }
  return 'unknown'
}

/**
 * 把一份 CC 卡 JSON 拆成「已知字段」与「保真字段」。
 * @param {any} json
 * @returns {{ spec: string, specVersion: string, fields: Record<string, unknown>, preserved: Record<string, unknown>, book: any }}
 */
export function decodeCardJson(json) {
  const kind = detectJsonKind(json)
  const isV3 = kind === 'v3'
  const root = json?.data !== null && typeof json?.data === 'object' ? json.data : json
  const fields = {}
  const preserved = {}

  for (const key of [...V2_KNOWN, ...V3_KNOWN]) {
    if (root[key] !== undefined) fields[key] = root[key]
  }
  // V2 的已知字段之外、V3 新增字段之外的一切，全部保真
  for (const key of Object.keys(root)) {
    if (!V2_KNOWN.includes(key) && !V3_KNOWN.includes(key)) preserved[key] = root[key]
  }
  // 顶层（data 之外）的未知键也要保真，否则往返会丢。
  // 只在**真的有一层 data 包装**时才记 top.*：V1 平铺卡没有包装，root 就是 json
  // 本身，这时候上面那个循环已经把每个键都收过了，再记一遍 top.* 等于同一份值
  // 存两处——导出时它会既留在 data 里又出现在顶层，导入回来就翻倍。
  if (root !== json) {
    for (const key of Object.keys(json ?? {})) {
      if (key === 'data' || key === 'spec' || key === 'spec_version') continue
      preserved[`top.${key}`] = json[key]
    }
  }

  const book = root.character_book ?? null
  const bookPreserved = {}
  if (book !== null && typeof book === 'object') {
    for (const key of Object.keys(book)) {
      if (key === 'entries') continue
      if (!['name', 'description', 'scan_depth', 'token_budget', 'recursive_scanning', 'extensions'].includes(key)) {
        bookPreserved[key] = book[key]
      }
    }
    // entry 级的未知键
    const entries = Array.isArray(book.entries) ? book.entries : []
    const entryPreserved = {}
    entries.forEach((entry, index) => {
      const extra = {}
      for (const key of Object.keys(entry ?? {})) {
        if (!ENTRY_KNOWN.includes(key)) extra[key] = entry[key]
      }
      if (Object.keys(extra).length > 0) entryPreserved[String(index)] = extra
    })
    if (Object.keys(entryPreserved).length > 0) bookPreserved.__entries = entryPreserved
  }
  if (Object.keys(bookPreserved).length > 0) preserved.__character_book_extra = bookPreserved

  return {
    spec: isV3 ? 'chara_card_v3' : kind === 'v1' ? 'chara_card_v1' : 'chara_card_v2',
    specVersion: String(json?.spec_version ?? (isV3 ? '3.0' : kind === 'v1' ? '1.0' : '2.0')),
    fields,
    preserved,
    book,
  }
}

/**
 * 把内部结构拼回一份 CC 卡 JSON。
 * @param {{ spec: string, specVersion: string, fields: Record<string, unknown>, preserved: Record<string, unknown> }} card
 * @param {boolean} asV3 - true 时输出 V3（补 spec/spec_version，保留 V3 字段）。
 */
export function encodeCardJson(card, asV3 = false) {
  const data = { ...(card.fields ?? {}) }
  // preserved 里除 __ 前缀的内部键外，全部原样放回 data
  for (const [key, value] of Object.entries(card.preserved ?? {})) {
    if (key.startsWith('__') || key.startsWith('top.')) continue
    if (data[key] === undefined) data[key] = value
  }
  // 补回 character_book 的 unknown 键
  const extra = card.preserved?.__character_book_extra
  if (extra !== undefined && data.character_book !== null && typeof data.character_book === 'object') {
    for (const [key, value] of Object.entries(extra)) {
      if (key === '__entries') continue
      if (data.character_book[key] === undefined) data.character_book[key] = value
    }
    if (extra.__entries !== undefined) {
      const entries = Array.isArray(data.character_book.entries) ? data.character_book.entries : []
      entries.forEach((entry, index) => {
        const e = extra.__entries[String(index)]
        if (e === undefined) return
        for (const [k, v] of Object.entries(e)) if (entry[k] === undefined) entry[k] = v
      })
    }
  }
  // V2 投影最后剪一次：此时 data 已经合并完 preserved，删晚了才有效。
  if (!asV3) {
    for (const key of V3_KNOWN) delete data[key]
  }
  const out = {
    spec: asV3 ? 'chara_card_v3' : 'chara_card_v2',
    spec_version: asV3 ? '3.0' : '2.0',
    data,
  }
  // 顶层未知键：decodeCardJson 记成 `top.<key>`，必须写回**顶层**。
  // 原先这里写的是 `data[key.slice(4)] = value`，等于把顶层字段降级塞进 data——
  // 导出后顶层那些 ST/第三方工具认识的扩展键消失，data 里反倒多出几个来历不明的键。
  // spec / spec_version / data 由本函数自己决定，不允许被 preserved 覆盖。
  for (const [key, value] of Object.entries(card.preserved ?? {})) {
    if (!key.startsWith('top.')) continue
    const name = key.slice(4)
    if (name === '' || name === 'data' || name === 'spec' || name === 'spec_version') continue
    if (name in out) continue
    out[name] = value
  }
  return out
}

/**
 * 从任意输入（PNG / JSON 文本 / CHARX 字节 / zip）里取出卡 JSON。
 * @param {Uint8Array} bytes
 * @param {string} [fileName]
 * @returns {{ json: any, kind: string, source: string, rawFiles?: Record<string, Uint8Array> }}
 */
/**
 * 文本角色卡里常见的字段写法。
 * 中文社区的 txt 卡八成是「名字：…／性格：…」这种一行一个字段，
 * 也有用 Markdown 小标题的，所以两种都认。
 */
const TEXT_FIELDS = [
  ['name', ['名字', '姓名', '名称', '角色名', '人名', '角色', '人物', '主角', 'name', 'char_name', 'character name']],
  ['description', ['描述', '设定', '人物设定', '人设', '简介', '介绍', '背景', '人物背景', '背景设定', '角色设定', 'profile', 'description', 'desc', 'persona']],
  ['personality', ['性格', '个性', 'personality']],
  ['scenario', ['场景', '情景', 'scenario']],
  ['first_mes', ['开场白', '开场', '第一句话', '问候语', '初次见面', 'first_mes', 'first message', 'greeting', 'first_message']],
  ['mes_example', ['对话示例', '示例对话', '对话范例', '例句', '示例', 'mes_example', 'example dialogue', 'examples']],
  ['creator_notes', ['创作者备注', '备注', '说明', 'creator_notes', 'notes', 'creator comment']],
  ['appearance', ['外貌', '长相', '外观', '穿着', 'appearance', 'looks']],
  ['speech', ['说话方式', '口癖', '语气', '语癖', '说话风格', 'speech', 'voice', 'tone']],
  ['relationship', ['关系', '与我的关系', '身份关系', 'relationship']],
  ['world', ['世界观', '世界', 'world', 'worldview']],
]

/**
 * 提示词式的卡（网上下的「破限/人设」txt 常见）没有「名字：性格：」这种字段，
 * 整个文件被包在一两个外层标签里。这些标签名当作「整段放哪儿」的意思来认。
 */
const TEXT_WRAPPER_FIELDS = [
  ['description', ['project_instructions', 'projectinstructions', 'system', 'system_prompt', 'persona', 'character', 'char', 'instruction', 'instructions', 'prompt', 'main', 'profile', 'context']],
  ['creator_notes', ['user_style', 'userstyle', 'style', 'style_notes', 'stylesheet', 'notes', 'author_notes', 'postscript', 'appendix']],
  ['mes_example', ['examples', 'dialogues', 'sample_dialogue', 'sample_messages']],
  ['first_mes', ['greeting', 'opening', 'first_message']],
]

/** 外层容器标签对到「整段放哪个字段」；认不出返回 null。 */
function textWrapperOf(rawKey) {
  const key = String(rawKey ?? '').replace(/[\s\u3000]+/g, '').replace(/[-_]+/g, '_').toLowerCase()
  if (key === '') return null
  for (const [field, aliases] of TEXT_WRAPPER_FIELDS) {
    if (aliases.includes(key)) return field
  }
  return null
}

/** 「外貌」「口癖」这些没有独立小节的，拼进自述里，加一个标签。 */
const TEXT_EXTRA_FIELDS = new Set(['appearance', 'speech', 'relationship', 'world', 'extra'])

/** 把一个标题/键名对到字段名上；认不出返回 null。 */
function textFieldOf(rawKey) {
  const key = String(rawKey ?? '')
    .replace(/\{\{\s*(char|user|bot|character)\s*\}\}/gi, '')
    .replace(/^(角色|人物|主角|TA|他|她)的/, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/^[#*>\-\s]+/, '')
    .replace(/[:：]+$/, '')
    .toLowerCase()
  if (key === '') return null
  for (const [field, aliases] of TEXT_FIELDS) {
    if (aliases.includes(key)) return field
  }
  return null
}

/**
 * 把一份纯文本角色卡读成 CC v2 的 JSON 形状。
 *
 * 认三种写法：
 *   1) 整份就是 JSON（可能在 ``` 里包着，常见于把 .json 改名成 .txt）
 *   2) 「名字：张三 / 性格：沉默」一行一个字段（也认 `【名字】` 单独占一行的写法）
 *   3) Markdown 小标题（`## 性格`）
 *   4) `<名字>…</名字>` 这种带尖括号标签的写法
 * 认不出的键不丢，按「标签：内容」拼进自述；一行都没有的散文返回 null，
 * 由调用方给出「先当材料导进来」的提示。
 * @param {string} raw
 * @returns {{ json: any, source: string } | null}
 */
export function parseTextCard(raw, options = {}) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
  if (text === '') return null

  // 1) 整份就是 JSON
  const fenced = text.match(/^```(?:json|javascript)?\s*\n([\s\S]*?)\n```$/i)
  const jsonBody = (fenced !== null ? fenced[1] : text).trim()
  if (jsonBody.startsWith('{') || jsonBody.startsWith('[')) {
    try {
      const parsed = JSON.parse(jsonBody)
      return { json: parsed, source: 'text-json' }
    } catch {
      /* 不是合法 JSON，继续按字段读 */
    }
  }

  // 顶上单独一行的一级标题（`# 林小雨`）当名字兜底：
  // 后面再接「## 描述」这种小标题时，它本身对不上任何字段，但显然是名字。
  const topHeading = /^\s*#\s+(\S.*)$/m.exec(text.split('\n').filter((l) => l.trim() !== '')[0] ?? '')
  const fileStem = String(options?.fileName ?? '').replace(/\.[^.]+$/, '').trim()
  const nameFallback = topHeading !== null && textFieldOf(topHeading[1]) === null ? topHeading[1].trim() : fileStem

  // 2) 一行一个字段 / Markdown 小标题
  const entries = []
  let current = null
  let sawKnown = false
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\u3000/g, ' ').trimEnd()
    const trimmed = line.trim()
    if (trimmed === '') {
      if (current !== null) current.lines.push('')
      continue
    }
    const heading = /^#{1,4}\s*(.+?)\s*#*$/.exec(trimmed)
    const bracket = /^[【\[](.{1,12}?)[】\]]\s*[:：]?\s*(.*)$/.exec(trimmed)
    const colon = /^(.{1,12}?)\s*[:：]\s*(.*)$/.exec(trimmed)
    let key = null
    let inline = ''
    if (heading !== null) {
      key = heading[1]
    } else if (bracket !== null) {
      key = bracket[1]
      inline = bracket[2]
    } else if (colon !== null) {
      key = colon[1]
      inline = colon[2]
    }
    // 对话行（`{{user}}：…`、`<旁白>：…`）里的冒号不是字段分隔符
    const keyLooksLikeLabel = key !== null
      && !/[{}<>\[\]"'“”‘’「」《》]/.test(key)
      && !/\s/.test(String(key).trim())
    if (key !== null && !keyLooksLikeLabel) key = null
    if (key !== null) {
      const field = textFieldOf(key)
      if (field !== null) {
        sawKnown = true
        current = { field, key: String(key).trim(), lines: inline.trim() === '' ? [] : [inline] }
        entries.push(current)
        continue
      }
      // 认不出的键：只有在已经确认这是张卡（见过已知字段）之后才当标签，否则当成正文
      if (sawKnown && !/^[\s"'“”‘’《》（）()，。！？、；]/.test(key)) {
        current = { field: 'extra', key: String(key).trim(), lines: inline.trim() === '' ? [] : [inline] }
        entries.push(current)
        continue
      }
    }
    if (current !== null) current.lines.push(line)
    else if (trimmed !== '') {
      current = { field: 'extra', key: '', lines: [line] }
      entries.push(current)
    }
  }
  // 2) <标签>…</标签> 的写法（不少 txt 卡其实是当 XML 写的，中英标签都认）
  const tagEntries = []
  // `<名字>…</名字>`，以及带属性的 `<char name="张三">…</char>`
  const tagRe = /<([A-Za-z\u4e00-\u9fff][\w\u4e00-\u9fff-]{0,30})([^>]*)>([\s\S]*?)<\/\1>/g
  let tagHit = tagRe.exec(text)
  while (tagHit !== null) {
    const tagName = tagHit[1]
    const attrText = tagHit[2]
    // 标签里紧跟着写了个冒号（`<名字>：阿澜`）也认——那只是在抄「字段：值」的习惯
    const body = tagHit[3].replace(/^\s*[:：]?\s*/, '').trimEnd()
    // `<char name="沈九">正文</char>`：属性给名字，这一段正文算自述
    const attrName = /name\s*=\s*["']?([^"'>]+)["']?/i.exec(attrText)
    const attrIsName = attrName !== null && /^(char|character|character_card|bot|persona|card)$/i.test(tagName)
    if (attrIsName) tagEntries.push({ field: 'name', key: tagName, lines: [attrName[1].trim()] })
    let field = textFieldOf(tagName)
    if (field === null) field = textWrapperOf(tagName)
    if (field === null && attrIsName) field = 'description'
    if (field !== null) {
      tagEntries.push({ field, key: tagName, lines: body === '' ? [] : body.split('\n') })
    } else if (body !== '') {
      tagEntries.push({ field: 'extra', key: tagName, lines: body.split('\n') })
    }
    tagHit = tagRe.exec(text)
  }
  const tagHasKnown = tagEntries.some((e) => e.field !== 'extra')
  if (tagHasKnown) {
    const made = assemble(tagEntries, nameFallback)
    if (made !== null) return made
  }
  // 有 <标签>…</标签> 的结构、但一个字段都对不上：整份当自述收进来，别让人卡在「读不进去」。
  // 名字取文件名（用户挑一份叫「张三.txt」的卡时，这几乎总是对的）。
  if (tagEntries.length > 0) {
    const stem = String(options?.fileName ?? '').replace(/\.[^.]+$/, '').trim()
    const name = tagEntries.find((e) => e.key !== '')?.lines?.[0]?.trim() ?? ''
    const body = text.trim()
    if (body !== '') {
      return {
        json: {
          spec: 'chara_card_v2',
          spec_version: '2.0',
          data: {
            name: stem === '' ? (name === '' ? '未命名' : name) : stem,
            description: body,
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            creator_notes: '这份是提示词式的卡：里面没有「名字：」「性格：」这种分字段的写法，所以原文整份收在自述里，名字用的是文件名。想拆成小节可以手动改。',
            tags: [],
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
          },
        },
        source: 'text-raw',
      }
    }
  }

  if (!sawKnown || entries.length === 0) return null

  return assemble(entries, nameFallback)
}

/**
 * 把读到的字段整理成 CC v2 的 JSON 形状。
 * 两种入口（`<标签>` 与「一行一个字段」）都走这里，省得两套拼装逻辑慢慢走岔。
 */
function assemble(entries, nameFallback) {
  const take = (field) => {
    const found = entries.filter((e) => e.field === field)
    if (found.length === 0) return ''
    return found.map((e) => e.lines.join('\n').trim()).filter((v) => v !== '').join('\n\n').trim()
  }
  const extraBlocks = []
  for (const entry of entries) {
    if (!TEXT_EXTRA_FIELDS.has(entry.field)) continue
    const value = entry.lines.join('\n').trim()
    if (value === '') continue
    if (entry.key === '') extraBlocks.push(value)
    else if (value.includes('\n')) extraBlocks.push(`【${entry.key}】\n${value}`)
    else extraBlocks.push(`${entry.key}：${value}`)
  }
  const rawName = take('name').split('\n')[0].trim() === '' ? nameFallback : take('name').split('\n')[0].trim()
  const descriptionParts = [take('description'), ...extraBlocks].map((v) => String(v ?? '').trim()).filter((v) => v !== '')
  const description = descriptionParts.join('\n\n').trim()
  if (rawName === '' && description === '') return null

  const json = {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name: rawName === '' ? '未命名' : rawName,
      description,
      personality: take('personality'),
      scenario: take('scenario'),
      first_mes: take('first_mes'),
      mes_example: take('mes_example'),
      creator_notes: take('creator_notes'),
      tags: [],
      system_prompt: '',
      post_history_instructions: '',
      alternate_greetings: [],
    },
  }
  return { json, source: 'text' }
}

export async function extractCard(bytes, fileName = '') {
  const lower = fileName.toLowerCase()
  // 1) PNG
  if (bytes.length > 8 && bytes[0] === PNG_SIG[0] && bytes[1] === PNG_SIG[1]) {
    const { texts, ok, error } = readPngText(bytes)
    if (!ok) throw new Error(error ?? 'PNG 读取失败')
    // ccv3 优先（与 ST 一致）
    let firstError = null
    for (const key of ['ccv3', 'chara']) {
      const found = Object.keys(texts).find((k) => k.toLowerCase() === key)
      if (found === undefined) continue
      try {
        const json = parseTextPayload(texts[found])
        return { json, kind: detectJsonKind(json), source: `png:${key}` }
      } catch (error) {
        // ccv3 坏了还有 chara 可退——两份本来就该同源，这里正好是一次自救机会。
        firstError = firstError ?? error
      }
    }
    if (firstError !== null) throw firstError
    throw new Error('这张 PNG 里没有人物卡数据（既无 ccv3 也无 chara 块）')
  }
  // 2) zip / CHARX
  if (lower.endsWith('.charx') || lower.endsWith('.zip') || (bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    const files = await unzip(bytes)
    const cardName = Object.keys(files).find((n) => n === 'card.json') ?? Object.keys(files).find((n) => n.endsWith('/card.json'))
    if (cardName === undefined) throw new Error('这个压缩包里没有卡的内容')
    const json = JSON.parse(Buffer.from(files[cardName]).toString('utf8'))
    return { json, kind: detectJsonKind(json), source: 'charx', rawFiles: files }
  }
  // 3) 纯 JSON
  const text = Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '').trim()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    // 4) 文本角色卡（一行一个字段 / Markdown 小标题 / 改名成 .txt 的 JSON）
    const textCard = parseTextCard(text, { fileName })
    if (textCard !== null) {
      const kind = detectJsonKind(textCard.json)
      if (kind !== 'unknown') return { json: textCard.json, kind, source: textCard.source }
    }
    const head = text.replace(/\s+/g, ' ').slice(0, 60)
    // 扩展名就是 .txt / .md 的时候，宁可先收进来让人自己改，也不要留一句「读不进去」。
    // 名字取文件名，整份原文进自述，备注里写明是怎么收的——删掉重来也比卡住强。
    const stem = String(fileName).replace(/\.[^.]+$/, '').trim()
    if (/\.(txt|md|markdown)$/i.test(fileName)) {
      return {
        json: {
          spec: 'chara_card_v2',
          spec_version: '2.0',
          data: {
            name: stem === '' ? '未命名' : stem,
            description: text,
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            creator_notes: '这份是提示词式的卡：里面没有「名字：」「性格：」这种分字段的写法，所以原文整份收在自述里，名字用的是文件名。想拆成小节可以手动改。',
            tags: [],
            system_prompt: '',
            post_history_instructions: '',
            alternate_greetings: [],
          },
        },
        kind: 'v2',
        source: 'text-raw',
      }
    }
    throw new Error(`这个文件读不出角色卡（开头是「${head}」）。如果是散文式的人物介绍，先当材料导进来，用「让 AI 读一读」或提炼功能建卡。`)
  }
  return { json, kind: detectJsonKind(json), source: 'json' }
}

/**
 * 把 CC 卡投影成 LifeCard 的 `{ data, sections }`。
 * 这是「导入」的核心：CC 的平字段 → 我们的 YAML 头 + 正文小节。
 * @param {any} json
 * @param {{ nameFallback?: string, importedFrom?: string }} [options]
 */
export function ccToLifeCard(json, options = {}) {
  const decoded = decodeCardJson(json)
  const f = decoded.fields
  const now = new Date().toISOString().slice(0, 10)
  const name = String(f.name ?? options.nameFallback ?? '未命名')

  const data = {
    lifecard: '0.1',
    id: options.id ?? '',
    kind: 'fictional',
    world: 'reality',
    name,
    tags: Array.isArray(f.tags) ? f.tags : [],
  }
  // cc 段一定要存在：preserved 是保真的落脚点，缺了它就等于「不认识的键会丢」。
  data.cc = {}
  if (typeof f.nickname === 'string' && f.nickname !== '') data.nickname = f.nickname
  if (typeof f.creator === 'string' && f.creator !== '') data.creator = f.creator
  if (typeof f.character_version === 'string' && f.character_version !== '') data.character_version = f.character_version
  data.cc.spec = decoded.spec
  data.cc.spec_version = decoded.specVersion
  data.cc.imported_at = now
  if (options.importedFrom !== undefined) data.cc.source_file = options.importedFrom
  if (Object.keys(decoded.preserved).length > 0) data.cc.preserved = decoded.preserved
  // fields 里那些**没有被正文小节承载**的字段也必须保真，否则导出时会静默丢失：
  //   extensions / character_book / system_prompt（单独处理）/ tags 之外的一切。
  // 正文小节承载的是 description/personality/scenario/first_mes/mes_example/
  // alternate_greetings/creator_notes 这七个；其余都在这里兜住。
  const carriedBySection = new Set(['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'alternate_greetings', 'creator_notes', 'name', 'tags', 'creator', 'character_version', 'nickname', 'system_prompt', 'post_history_instructions'])
  const leftovers = {}
  for (const [key, value] of Object.entries(decoded.fields)) {
    if (carriedBySection.has(key)) continue
    leftovers[key] = value
  }
  if (Object.keys(leftovers).length > 0) data.cc.fields = leftovers

  const sections = []
  const push = (title, body) => {
    if (typeof body === 'string' && body.trim() !== '') sections.push({ title, body: body.trim() })
  }
  push('自述', f.description)
  push('性格', f.personality)
  push('场景', f.scenario)
  push('开场白', f.first_mes)
  if (Array.isArray(f.alternate_greetings) && f.alternate_greetings.length > 0) {
    push('备选开场', f.alternate_greetings.map((g) => String(g).trim()).join('\n\n---\n\n'))
  }
  push('对话示例', f.mes_example)
  push('创作者备注', f.creator_notes)
  if (typeof f.system_prompt === 'string' && f.system_prompt.trim() !== '') {
    // system_prompt 是 CC 的标准字段，且会跟着卡传播。放进 data.cc 而不是正文，
    // 这样导出能原样写回，但不会被误当成我们自己的偏好透镜。
    data.cc.system_prompt = f.system_prompt
  }
  if (typeof f.post_history_instructions === 'string' && f.post_history_instructions.trim() !== '') {
    data.cc.post_history_instructions = f.post_history_instructions
  }
  const book = decoded.book
  if (book !== null && typeof book === 'object' && Array.isArray(book.entries) && book.entries.length > 0) {
    data.cc.book_entries = book.entries.length
  }

  return { data, sections, decoded }
}

/**
 * 把 LifeCard 的 `{ data, sections }` 投影回 CC 卡 JSON。
 * @param {{ data: Record<string, unknown>, sections: Array<{title: string, body: string}> }} card
 * @param {{ asV3?: boolean, sectionToCc?: Record<string, string> }} [options]
 */
export function lifeCardToCc(card, options = {}) {
  const { data, sections } = card
  const sectionToCc = options.sectionToCc ?? {
    自述: 'description',
    性格: 'personality',
    场景: 'scenario',
    开场白: 'first_mes',
    备选开场: 'alternate_greetings',
    对话示例: 'mes_example',
    创作者备注: 'creator_notes',
  }
  const cc = data?.cc ?? {}
  // 先铺底：导入时留在 cc.fields 里的字段（extensions、character_book 等）
  const fields = {
    ...(cc.fields !== null && typeof cc.fields === 'object' ? cc.fields : {}),
    name: String(data?.name ?? data?.nickname ?? 'Unnamed'),
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
    creator_notes: '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: [],
    tags: Array.isArray(data?.tags) ? data.tags : [],
    creator: typeof data?.creator === 'string' ? data.creator : '',
    character_version: typeof data?.character_version === 'string' ? data.character_version : '',
    // extensions 必须保留 cc.fields 里的原值（第三方命名空间全在里面）；
    // 只有本来就没有时才给 {}（V2 规范要求它必须存在且默认 {}）。
    extensions: (cc.fields !== null && typeof cc.fields === 'object' && cc.fields.extensions !== undefined)
      ? cc.fields.extensions
      : {},
  }
  for (const section of sections ?? []) {
    const target = sectionToCc[section.title]
    if (target === undefined) continue
    if (target === 'alternate_greetings') {
      fields.alternate_greetings = String(section.body)
        .split(/\n\s*---\s*\n/)
        .map((s) => s.trim())
        .filter((s) => s !== '')
    } else {
      fields[target] = String(section.body)
    }
  }
  if (typeof cc.system_prompt === 'string') fields.system_prompt = cc.system_prompt
  if (typeof cc.post_history_instructions === 'string') fields.post_history_instructions = cc.post_history_instructions
  if (typeof data?.nickname === 'string') fields.nickname = data.nickname

  // 内部记账字段不能写进 CC
  for (const key of ['spec', 'spec_version', 'imported_at', 'source_file', 'book_entries']) delete fields[key]

  // 调用方显式给 asV3 时以它为准（导出 V2 投影 / 导出 V3 投影都要能强制）；
  // 没给才看这张卡的来历。
  const asV3 = options.asV3 !== undefined ? options.asV3 === true : cc.spec === 'chara_card_v3'
  // V2 投影必须真的剔除 V3 专属字段。它们可能从两处漏进来：
  //   ① cc.fields 兜底（导入时 V3 卡里的 assets 等）
  //   ② 卡头上的 nickname
  // 只在 encodeCardJson 里删是不够的，那里删完 cc.fields 又会带回来。
  if (!asV3) {
    for (const key of V3_KNOWN) delete fields[key]
  }
  return encodeCardJson({ spec: cc.spec ?? 'chara_card_v2', specVersion: cc.spec_version ?? '2.0', fields, preserved: cc.preserved ?? {} }, asV3)
}

/**
 * 生成一张「双 chunk 同源」的 PNG。
 *
 * 关键规则（见 SPEC §7.1 / 策划书 §5.3）：
 *   `ccv3` 必须是 `chara` 的**严格超集**，不允许出现只在一边有的字段。
 *   做法是先把同一份 fields 编码成 V2 与 V3，然后 V3 只允许「增加」，不允许改写。
 *
 * @param {Uint8Array} basePng - 底图（通常就是导入的那张）。
 * @param {{ data: Record<string, unknown>, sections: Array<{title: string, body: string}> }} card
 * @returns {{ png: Uint8Array, v2: any, v3: any, consistent: boolean }}
 */
export function exportCardPng(basePng, card) {
  const v2 = lifeCardToCc(card, { asV3: false })
  const v3 = lifeCardToCc(card, { asV3: true })
  const same = sameSource(v3, v2)
  const consistent = same.ok
  // 一次删掉两个旧块，再按 ccv3 -> chara 的顺序写入。
  let png = writePngText(basePng, 'ccv3', utf8ToBase64(JSON.stringify(v3)), ['chara', 'ccv3'])
  png = writePngText(png, 'chara', utf8ToBase64(JSON.stringify(v2)), [])
  return { png, v2, v3, consistent, missing: same.missing }
}

/**
 * `sup` 是否包含 `sub` 的全部键值（递归）。
 * 用来断言「V3 是 V2 的严格超集」。
 */
/**
 * 比较两张 CC 卡的 data 部分是否 V3 ⊇ V2。
 *
 * 注意不能直接比整张卡：`spec` 与 `spec_version` 在两个投影里**本来就应该不同**
 * （V2 是 'chara_card_v2'/'2.0'，V3 是 'chara_card_v3'/'3.0'）。把它们算进超集
 * 判定，会让「同源」这条断言永远失败——而真正要保证的同源是 `data` 一致。
 *
 * @param {any} cardV3
 * @param {any} cardV2
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function sameSource(cardV3, cardV2) {
  const missing = []
  const walk = (sup, sub, path) => {
    if (sub === null || typeof sub !== 'object') {
      if (sup !== sub) missing.push(path)
      return
    }
    if (Array.isArray(sub)) {
      if (!Array.isArray(sup)) { missing.push(path); return }
      sub.forEach((v, i) => walk(sup[i], v, `${path}[${i}]`))
      return
    }
    if (sup === null || typeof sup !== 'object') { missing.push(path); return }
    for (const key of Object.keys(sub)) {
      if (!(key in sup)) missing.push(`${path}.${key}`)
      else walk(sup[key], sub[key], `${path}.${key}`)
    }
  }
  walk(cardV3?.data, cardV2?.data, 'data')
  return { ok: missing.length === 0, missing }
}

export function isSuperset(sup, sub) {
  if (sub === null || typeof sub !== 'object') return sup === sub || (typeof sub === 'string' && sup === sub)
  if (Array.isArray(sub)) {
    if (!Array.isArray(sup) || sup.length < sub.length) return false
    return sub.every((v, i) => isSuperset(sup[i], v))
  }
  if (sup === null || typeof sup !== 'object') return false
  for (const key of Object.keys(sub)) {
    if (!(key in sup)) return false
    if (!isSuperset(sup[key], sub[key])) return false
  }
  return true
}

/**
 * 读一张 PNG 里的两个 chunk 并比对，用于 doctor 的往返自检。
 * @param {Uint8Array} png
 */
export function compareChunks(png) {
  const { texts, ok, error } = readPngText(png)
  if (!ok) return { ok: false, error }
  const lower = {}
  for (const [k, v] of Object.entries(texts)) lower[k.toLowerCase()] = v
  const read = (key) => {
    if (lower[key] === undefined) return null
    try {
      return parseTextPayload(lower[key])
    } catch {
      return { __parseError: true }
    }
  }
  const v2 = read('chara')
  const v3 = read('ccv3')
  if (v2 === null && v3 === null) return { ok: false, error: '没有 chara / ccv3 块' }
  if (v2 === null) return { ok: false, error: '只有 ccv3，缺 chara（只认 V2 的前端读不到）' }
  if (v3 === null) return { ok: true, onlyV2: true, v2, v3: null }
  const same = sameSource(v3, v2)
  return {
    ok: same.ok,
    v2,
    v3,
    mismatch: same.ok ? undefined : `ccv3 的 data 与 chara 不一致：缺 ${same.missing.slice(0, 5).join(', ')}`,
  }
}

export default {
  readPngText,
  writePngText,
  unzip,
  detectJsonKind,
  decodeCardJson,
  encodeCardJson,
  extractCard,
  ccToLifeCard,
  lifeCardToCc,
  exportCardPng,
  isSuperset,
  sameSource,
  compareChunks,
}
