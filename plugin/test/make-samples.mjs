// 造几张符合规范的样本卡，供往返测试用（用户手上暂时没有真实卡）。
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'

const dir = new URL('./samples/', import.meta.url).pathname
mkdirSync(dir, { recursive: true })

// —— 1x1 红点 PNG（自己拼，零依赖）——
function tinyPng() {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  const ihdrData = Buffer.alloc(13)
  ihdrData.writeUInt32BE(1, 0)   // width
  ihdrData.writeUInt32BE(1, 4)   // height
  ihdrData[8] = 8                // bit depth
  ihdrData[9] = 2                // color type RGB
  ihdrData[10] = 0
  ihdrData[11] = 0
  ihdrData[12] = 0
  const raw = Buffer.from([0, 255, 0, 0])
  const idatData = deflateSync(raw)
  const mk = (type, data) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    const crcBuf = Buffer.alloc(4)
    crcBuf.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0)
    return Buffer.concat([head, data, crcBuf])
  }
  return Buffer.concat([sig, mk('IHDR', ihdrData), mk('IDAT', idatData), mk('IEND', Buffer.alloc(0))])
}
const T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }

// —— 样本 A：标准 CCv2 ——
const cardA = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '塞拉菲娜',
    description: '一位游历四方的草药师，背着旧皮包，包里都是晒干的叶子。',
    personality: '说话慢，回答问题前先想很久。不信陌生人，但会给人递水。',
    scenario: '在王城外的岔路口遇见旅行者。',
    first_mes: '（抬头看了你一眼，把包往肩上提了提）"路往北，别走夜路。"',
    mes_example: '<START>\n{{user}}: 你知道去王城怎么走吗？\n{{char}}: 知道。往北。"不过你最好明天再走。"',
    creator_notes: '给长对话用的，语气偏冷淡。',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: ['（蹲在路边翻包，没注意到你走过来）', '"又是你。"'],
    tags: ['奇幻', '草药师'],
    creator: '某作者',
    character_version: '1.2',
    extensions: { 'third_party/nested': { deep: [1, 2, 3] }, 'unknown-key': 'keep me' },
    character_book: {
      name: '草药笔记',
      description: '她的包',
      scan_depth: 4,
      token_budget: 500,
      recursive_scanning: false,
      extensions: { 'book/ext': true },
      entries: [
        { keys: ['药', '草药'], content: '她认得上百种草药，但只说得出三种的用法。', enabled: true, insertion_order: 100, case_sensitive: false, id: 1, comment: 'core', position: 'before_char', priority: 10 },
        { keys: ['王城'], content: '她去王城找过一个人，没找到。', enabled: true, insertion_order: 90, use_regex: false, constant: false },
      ],
    },
  },
}
writeFileSync(dir + 'seraphina.ccv2.json', JSON.stringify(cardA, null, 2))

// —— 样本 B：CCv3，带 V3 新增字段 ——
const cardB = JSON.parse(JSON.stringify(cardA))
cardB.spec = 'chara_card_v3'
cardB.spec_version = '3.0'
cardB.data.nickname = '菲娜'
cardB.data.creator_notes_multilingual = { zh: '中文备注', en: 'English notes' }
cardB.data.source = ['https://example.com/character/1']
cardB.data.group_only_greetings = ['（三人一起时）']
cardB.data.creation_date = 1750000000
cardB.data.modification_date = 1760000000
cardB.data.assets = [
  { type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' },
  { type: 'background', uri: 'embeded://assets/bg.webp', name: 'main', ext: 'webp' },
]
cardB.data.character_book.entries[0].use_regex = false
cardB.data.character_book.entries[0].constant = true
cardB.data.extensions['v3/only'] = { x: 1 }
writeFileSync(dir + 'seraphina.ccv3.json', JSON.stringify(cardB, null, 2))

// —— 样本 C：写进 PNG 的双 chunk 卡 ——
const base = tinyPng()
const b64 = (o) => Buffer.from(JSON.stringify(o), 'utf8').toString('base64')
function textChunk(kw, text) {
  const body = Buffer.concat([Buffer.from(kw, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')])
  const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write('tEXt', 4, 'latin1')
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([head, body, crcBuf])
}
const iendAt = base.length - 12
const v3like = JSON.parse(JSON.stringify(cardB)); v3like.data.nickname = '菲娜'
const png = Buffer.concat([
  base.subarray(0, iendAt),
  textChunk('chara', b64(cardA)),
  textChunk('ccv3', b64(v3like)),
  base.subarray(iendAt),
])
writeFileSync(dir + 'seraphina.png', png)

// —— 样本 D：只写 chara 的旧式 PNG（测「只有 V2」路径）——
const pngV2 = Buffer.concat([base.subarray(0, iendAt), textChunk('chara', b64(cardA)), base.subarray(iendAt)])
writeFileSync(dir + 'old-v2-only.png', pngV2)

// —— 样本 E：world info 独立文件 ——
writeFileSync(dir + 'eldoria.worldinfo.json', JSON.stringify({
  entries: {
    0: { uid: 0, key: ['王城', '白银之城'], keysecondary: [], comment: '首都', content: '王城阿斯特兰位于河谷北岸，城墙是白色的。', constant: false, selective: true, order: 100, position: 0, disable: false, excludeRecursion: false, probability: 100, useProbability: true, depth: 4, group: '', scanDepth: null, caseSensitive: null, matchWholeWords: null, useGroupScoring: null, automationId: '', role: null, vectorized: false, sticky: null, cooldown: null, delay: null },
  },
}, null, 2))

console.log('samples written to', dir)
