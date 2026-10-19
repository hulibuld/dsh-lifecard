import { readFileSync } from 'node:fs'
import * as K from '../lib/codec.js'
import * as C from '../lib/core.js'

const S = (n) => new Uint8Array(readFileSync(new URL('./samples/' + n, import.meta.url)))

const TT = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = TT[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

let pass = 0, fail = 0
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)) }
}

console.log('=== 1. PNG 双 chunk 读取 ===')
{
  const r = await K.extractCard(S('seraphina.png'), 'seraphina.png')
  t('识别为 PNG', r.source === 'png:ccv3', r.source)
  t('ccv3 优先', r.json.spec === 'chara_card_v3', r.json.spec)
  t('name 正确', r.json.data.name === '塞拉菲娜', r.json.data.name)
}

console.log('=== 2. 只有 chara 的旧卡 ===')
{
  const r = await K.extractCard(S('old-v2-only.png'), 'old.png')
  t('退回 chara', r.source === 'png:chara', r.source)
  t('是 V2', r.json.spec === 'chara_card_v2')
}

console.log('=== 3. JSON 识别 ===')
{
  for (const [f, kind] of [['seraphina.ccv2.json', 'v2'], ['seraphina.ccv3.json', 'v3']]) {
    const r = await K.extractCard(S(f), f)
    t(f + ' -> ' + kind, r.kind === kind, r.kind)
  }
  const w = await K.extractCard(S('eldoria.worldinfo.json'), 'eldoria.worldinfo.json')
  t('world info 识别', w.kind === 'worldinfo', w.kind)
}

console.log('=== 4. 保真：不认识的键零丢失 ===')
{
  const r = await K.extractCard(S('seraphina.ccv2.json'), 'x.ccv2.json')
  const life = K.ccToLifeCard(r.json, { id: 'sera' })
  const cc = life.data.cc
  const kept = { ...(cc.fields ?? {}), ...(cc.preserved ?? {}) }
  t('extensions 保留', kept.extensions !== undefined, Object.keys(kept))
  t('extensions 深嵌套完整', JSON.stringify(kept.extensions?.['third_party/nested']) === JSON.stringify({ deep: [1, 2, 3] }))
  t('extensions 里的未知命名空间保留', kept.extensions?.['unknown-key'] === 'keep me', JSON.stringify(kept.extensions))
  t('book 扩展保留', kept.character_book?.extensions?.['book/ext'] === true, JSON.stringify(kept.character_book?.extensions))
  t('character_book 整体保真', kept.character_book !== undefined && kept.character_book.entries.length === 2)

  // 写回并重新解码，比对 preserved
  const back = K.lifeCardToCc(life, { asV3: false })
  t('写回 extensions', back.data.extensions?.['third_party/nested']?.deep?.[2] === 3, JSON.stringify(back.data.extensions))
  t('写回 extensions 未知键', back.data.extensions?.['unknown-key'] === 'keep me')
  t('写回 book entry 未知键', back.data.character_book.entries[0].comment === 'core')
  t('写回 entry priority', back.data.character_book.entries[0].priority === 10)
  t('写回 entry position', back.data.character_book.entries[0].position === 'before_char')
}

console.log('=== 5. V3 → V2 投影时去掉 V3 专属字段 ===')
{
  const r = await K.extractCard(S('seraphina.ccv3.json'), 'x.ccv3.json')
  const life = K.ccToLifeCard(r.json, { id: 'sera' })
  t('nickname 进卡', life.data.nickname === '菲娜', life.data.nickname)
  const v2 = K.lifeCardToCc(life, { asV3: false })
  const v3 = K.lifeCardToCc(life, { asV3: true })
  t('V2 无 assets', v2.data.assets === undefined)
  t('V2 无 nickname', v2.data.nickname === undefined)
  t('V3 有 assets', v3.data.assets !== undefined)
  t('V3 的 data ⊇ V2 的 data', K.sameSource(v3, v2).ok, { missing: K.sameSource(v3, v2).missing })
  t('V3 spec 正确', v3.spec === 'chara_card_v3' && v3.spec_version === '3.0')
}
function diff(sup, sub, path = '') {
  const out = []
  if (sub === null || typeof sub !== 'object') { if (sup !== sub) out.push(path); return out }
  if (Array.isArray(sub)) { if (!Array.isArray(sup)) { out.push(path); return out } sub.forEach((v, i) => out.push(...diff(sup[i], v, path + '[' + i + ']'))); return out }
  for (const k of Object.keys(sub)) { if (!(k in sup)) out.push(path + '.' + k); else out.push(...diff(sup[k], sub[k], path + '.' + k)) }
  return out
}

console.log('=== 6. 导出 PNG：双 chunk 同源 ===')
{
  const r = await K.extractCard(S('seraphina.ccv2.json'), 'x.ccv2.json')
  const life = K.ccToLifeCard(r.json, { id: 'sera' })
  const base = S('old-v2-only.png')
  const { png, consistent } = K.exportCardPng(base, life)
  t('同源（V3 ⊇ V2）', consistent)
  const cmp = K.compareChunks(png)
  t('两 chunk 都在', cmp.v2 !== null && cmp.v3 !== null, cmp)
  t('比对一致', cmp.ok === true, cmp.mismatch)
  // 再读回来
  const again = await K.extractCard(png, 'out.png')
  t('导出后能读回', again.json.data.name === '塞拉菲娜')
  t('读回的是 V3（ST 行为）', again.json.spec === 'chara_card_v3')
}

console.log('=== 7. 卡 → CC → 卡 往返 ===')
{
  const r = await K.extractCard(S('seraphina.ccv3.json'), 'x.ccv3.json')
  const life = K.ccToLifeCard(r.json, { id: 'sera' })
  const text = C.stringifyCard(life.data, life.sections)
  const parsed = C.parseCard(text)
  t('生成的 md 可解析', parsed.ok, parsed.errors)
  const v = C.validateCard(parsed.data)
  t('校验通过', v.ok, v.issues)
  const backCc = K.lifeCardToCc(parsed)
  t('正文回到 description', backCc.data.description.includes('草药师'), backCc.data.description?.slice(0, 20))
  t('备选开场还原成数组', backCc.data.alternate_greetings.length === 2, backCc.data.alternate_greetings)
  t('tags 保留', backCc.data.tags.includes('奇幻'))
}

console.log('=== 8. CHARX（zip）===')
{
  // 用 node 自己造一个 zip（store 方式）
  const { deflateSync } = await import('node:zlib')
  const cardJson = Buffer.from(JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: '查克斯', description: '来自 charx', extensions: {} } }), 'utf8')
  const zip = makeZip([{ name: 'card.json', data: cardJson }, { name: 'assets/icon.png', data: S('old-v2-only.png') }])
  const r = await K.extractCard(new Uint8Array(zip), 'test.charx')
  t('CHARX 识别', r.source === 'charx', r.source)
  t('读出名字', r.json.data.name === '查克斯')
  t('附件也在', r.rawFiles['assets/icon.png'] !== undefined, Object.keys(r.rawFiles ?? {}))
}
function makeZip(files) {
  const local = [], central = []
  let offset = 0
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8')
    const data = Buffer.from(f.data)
    const comp = data  // store，简化
    const crc = crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(0, 8)
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12); lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28)
    local.push(lh, nameBuf, comp)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14)
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32)
    ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42)
    central.push(ch, nameBuf)
    offset += lh.length + nameBuf.length + comp.length
  }
  const localBuf = Buffer.concat(local)
  const centralBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(localBuf.length, 16); eocd.writeUInt16LE(0, 20)
  return Buffer.concat([localBuf, centralBuf, eocd])
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
