/**
 * story —— 剧本与玩法引擎层。
 *
 * 这一层解决的是「玩起来像什么」的问题，`lib/game.js` 解决的是「一局怎么存下来」。
 * 以前一局游戏只有五套预设（查案/求生/成长/关系/探索），玩法全靠一段提示词，
 * 没有可以数、可以判的东西：玩家说「我赢了」也行，说「算了」也行，结局永远悬着。
 *
 * 这里把十一个开源文字游戏引擎里真正能改变玩法的机制，落到纯数据 + 纯字符串上：
 *
 *   引擎      = 一组状态字段 + 一组必须遵守的规则 + 一个结局判定（纯函数）
 *   剧本      = 一份能用文字编辑器手写的 Markdown（节点 / 视觉槽 / 选项 / 条件行）
 *   旗标      = 「key = 值」的几行字，条件行按它决定出不出现
 *   导出      = ink 草稿 与 单文件 HTML，两样都不依赖这个插件也能跑
 *
 * 为什么不做成真移植：这个插件没有构建步骤、没有前端框架，界面全是手写的 `h()`
 * 调用。搬一份 ink 运行时进来，等于给一个纯 Markdown 工具塞一个编译器；能带走的
 * 是机制（旗标分叉、织体、对话树、多周目继承），不是那套源码。
 *
 * 这一层只碰字符串与纯函数：不读盘、不调模型、不碰 HTTP。
 * 路径那一侧（`plays/<书>/<局>.script.md`）由 index.js 用 game.playRelPath 算好再传进来，
 * 免得这里再去静态 import 一个「可以整个删掉」的模块，把插件拖死。
 */

/** 一个节点最多收多少个选项。再多就不是「三个方向」，是一份菜单。 */
export const MAX_CHOICES = 6

/** 一条状态字段最多几行。和 game.js 的 MAX_STATUS_ITEMS 同一个道理：多了就不叫一眼看清。 */
export const FIELD_MAX = 12

/** 选项跳到这几个词就算结局。大小写都认，中文也认。 */
const END_WORDS = ['结束', 'END', 'end', 'End', '完', '结局', '终']

/** 判定一个跳转目标是不是「结束」。 */
export function isEndTarget(target) {
  return END_WORDS.includes(String(target ?? '').trim())
}

/**
 * 把状态里的值读成一个整数。
 *
 * 模型写数字不老实：「体力：4」「体力：4/10」「体力：还剩 4 点」都见过。
 * 这里只取第一个整数，取不到给 NaN——NaN 在判定里一律当「这一项还不知道」，
 * 绝不因为读不出来就判玩家输。
 */
function numOf(value) {
  const m = /-?\d+/.exec(String(value ?? ''))
  return m === null ? NaN : Number(m[0])
}

/**
 * 把一行里的多件事拆开。
 *
 * 状态只有一行，所以 buildEngineSystem 要求「同一名目下有多件事时用「；」隔开」。
 * 这里同时认中文分号、英文分号和换行（用户手改存档时会用换行）。
 */
function listOf(value) {
  const text = String(value ?? '').trim()
  if (text === '') return []
  return text
    .split(/[；;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

/**
 * 「名字 数值」一行一条，读成 [{ name, value }]。
 *
 * 关系和声望都用这一种写法：不写死具体人名，引擎才能给任何一本书用。
 * 拆不出来的行直接丢——它可能是模型多写的一句解释，不能因此把整段判失败。
 */
function pairsOf(value) {
  const out = []
  for (const item of listOf(value)) {
    const m = /^(.+?)[\s：:=]+(-?\d+)\s*$/.exec(item)
    if (m === null) continue
    out.push({ name: String(m[1]).trim(), value: Number(m[2]) })
  }
  return out
}

/** 「是 / 对 / 成了」这类肯定说法。判定只认这几种开头，含糊的一律当没发生。 */
function isYes(value) {
  return /^(是|对|成了|谈成|达成|有|yes|true)$/i.test(String(value ?? '').trim())
}

// ─────────────────────────────────────────────────────────────
// 一、十一个玩法引擎
// ─────────────────────────────────────────────────────────────

/**
 * 每个引擎的形状是固定的四件东西：
 *   fields —— 这一局要盯住哪几类状态（写进存档的 ## 状态，也决定 buildEngineSystem 报什么）
 *   rules  —— 每轮追加给主持人的规则，具体到能照做
 *   judge  —— 拿状态快照判 'win' / 'lose' / ''，必须是纯函数、不许抛
 *   presetId —— 对得上的内置预设（前五个），新增的留空
 *
 * 判定阈值一律写进 rules 的最后一条：玩家和模型都得知道「怎样算赢」，
 * 藏起来的胜利条件不叫玩法，叫猜谜。
 */
export const ENGINES = [
  {
    id: 'detect',
    name: '查一件事',
    desc: '找线索、拼线索，最后指认',
    presetId: 'game-detect',
    fields: [
      { key: '线索', hint: '已经拿到手的东西或话，一条一条写，写清是在哪拿到的', max: 12 },
      { key: '疑点', hint: '还没想通的地方，一条一条写', max: 6 },
      { key: '指认', hint: '玩家最后指认的是谁；他还没开口就空着', max: 1 },
      { key: '真凶', hint: '真相里动手的那个人，只有揭底之后才写', max: 1 },
    ],
    rules: [
      '每一轮给出一段场景，场景里必须有一件能拿走的实物、或者一句能记住的话。',
      '线索藏在具体的物和话里，不直接说结论：写「账本上少了一页」，不写「有人撕了账本」。',
      '玩家选错不立刻死，但要让后面的路变窄：少一个人肯开门、少一处能去的地方。',
      '至少三条线索指向同一个人，缺一条也能推出来，但会很险；你自己记着是哪三条。',
      '「指认」只能由玩家明确说出名字之后才写进状态，不要替他填，也不要替他改。',
      '判结局：指认的人就是「真凶」算赢，指错了算输；两个字都没写就是还没查完。',
    ],
    judge(state) {
      const s = state ?? {}
      const who = String(s['指认'] ?? '').trim()
      if (who === '') return ''
      const truth = String(s['真凶'] ?? '').trim()
      // 真凶还没揭底就不判：没答案的时候判输，等于罚玩家查得太快。
      if (truth === '') return ''
      return who === truth ? 'win' : 'lose'
    },
  },
  {
    id: 'survive',
    name: '撑下去',
    desc: '资源有限，每天都要做取舍',
    presetId: 'game-survive',
    fields: [
      { key: '体力', hint: '整数，从 10 往下掉，掉到 0 就完了', max: 1 },
      { key: '时间', hint: '整数，还剩几天或几小时，只减不增', max: 1 },
      { key: '物资', hint: '整数，能换东西的那一份还剩多少', max: 1 },
      { key: '撑到第几天', hint: '整数，已经过去几天，从 0 开始', max: 1 },
    ],
    rules: [
      '每一轮至少消耗一样：时间一定少 1，体力和物资看玩家怎么做。',
      '三个数都报整数，不写「不多了」「快撑不住了」这种话——界面上要拿去判生死。',
      '不能让玩家什么都保住：每给一个方向，就写清它要花掉什么。',
      '环境也要消耗东西：天冷、下雨、伤口，都要落到体力上，不是只有做事才掉。',
      '判结局：体力、时间、物资任意一项掉到 0 或以下算输；「撑到第几天」到 30 天算赢。',
    ],
    judge(state) {
      const s = state ?? {}
      for (const key of ['体力', '时间', '物资']) {
        const v = numOf(s[key])
        if (Number.isFinite(v) && v <= 0) return 'lose'
      }
      const day = numOf(s['撑到第几天'])
      if (Number.isFinite(day) && day >= 30) return 'win'
      return ''
    },
  },
  {
    id: 'growth',
    name: '慢慢长起来',
    desc: '一段时间一段地过，看人怎么变',
    presetId: 'game-growth',
    fields: [
      { key: '手艺', hint: '已经能独立做成的具体事，一条一条写', max: 8 },
      { key: '年岁', hint: '整数，现在是哪一年、他多大', max: 1 },
      { key: '攒下的', hint: '钱、工具、人情，能带走的东西', max: 6 },
      { key: '还没学会的', hint: '卡住他的那一件事，一条一条写', max: 6 },
    ],
    rules: [
      '每一轮推进一段时间（几天、几个月），不是一个场景；开局就把节奏定死，后面不要忽快忽慢。',
      '变化要落在具体的技能和处境上：写「能独自给马钉掌了」，不写「他成长了」。',
      '每次给三个方向，每个都要花掉时间，花掉的时间不能再要回来。',
      '允许失败，失败留下痕迹：手抖、旧伤、别人不再找你，都不会自己好。',
      '这一局不判输赢：走到哪儿算哪儿，把「还没学会的」一条条划掉就是它全部的意思。',
    ],
    judge() {
      return ''
    },
  },
  {
    id: 'relation',
    name: '人和人之间',
    desc: '看关系怎么变，没有外敌',
    presetId: 'game-relation',
    fields: [
      { key: '关系', hint: '一个人一条，写成「名字 数值」，数值从 -5 到 10', max: 8 },
      { key: '没说出口的', hint: '谁有话没讲，一条一条写', max: 6 },
      { key: '最近一次见面', hint: '上一轮和谁见了、在哪儿', max: 1 },
    ],
    rules: [
      '没有外部敌人，冲突来自人和人之间说不出口的东西。',
      '每一轮发生一件小事，让某两个人的距离变近或变远，「关系」里的数值要跟着改。',
      '玩家的选择只有「说什么」和「不说什么」，不写打斗、不写追逐。',
      '关系用整数刻度写清楚：现在几分，比上一轮多了还是少了，不要只写「好了一点」。',
      '判结局：任何一段关系跌到 -4 或更低算输（那个人从此不再见他）；有人到 8 算赢。',
    ],
    judge(state) {
      const s = state ?? {}
      const pairs = pairsOf(s['关系'])
      if (pairs.length === 0) return ''
      if (pairs.some((p) => p.value <= -4)) return 'lose'
      if (pairs.some((p) => p.value >= 8)) return 'win'
      return ''
    },
  },
  {
    id: 'explore',
    name: '往没去过的地方走',
    desc: '探索未知，地图一点点展开',
    presetId: 'game-explore',
    fields: [
      { key: '去过的地方', hint: '一处一条，写清是怎么进去的', max: 12 },
      { key: '身上的东西', hint: '带进去的、还剩的，一条一条写', max: 8 },
      { key: '还没弄清的事', hint: '看见但没解释的，一条一条写', max: 8 },
    ],
    rules: [
      '每一轮揭开一块新地方，写清看到、听到、闻到什么。',
      '危险不滥用：不是每次进门都有东西扑上来，多数门后面只是空房间。',
      '未知的保持未知：不提前解释世界的规矩，玩家问三次也不给答案。',
      '身上的东西有限，带什么进去要付代价，用掉就没了——「身上的东西」里要划掉。',
      '这一局不判输赢：地图展开到哪儿算哪儿，走不动了就是走不动了。',
    ],
    judge() {
      return ''
    },
  },
  {
    id: 'deduce',
    name: '证词对不上',
    desc: '几份说法互相打架，你要指出哪一句在撒谎',
    presetId: '',
    fields: [
      { key: '证词', hint: '一条一句，前面写是谁说的，原话照抄', max: 16 },
      { key: '指认', hint: '指认那句原话；指对了写「对：原话」，指错了写「错：原话」，没指认就空着', max: 1 },
      { key: '追问', hint: '整数，还能再问几次人', max: 1 },
    ],
    rules: [
      '至少给三份证词，其中恰好一份在关键处对不上，另外两份互相印证——不要给两份假的。',
      '每份证词都要具体到能被原样复述的一句话，不写「他说了个大概」。',
      '玩家每追问一次，「追问」减 1；追问用完还没指认，就按现有的证词收场。',
      '指认之后不要立刻揭底：先写被指认的人怎么反应，再让真相自己浮出来。',
      '判结局：「指认」以「对：」开头算赢；以「错：」开头且「追问」已经用完算输；追问用完又没指认也算输。',
    ],
    judge(state) {
      const s = state ?? {}
      const said = String(s['指认'] ?? '').trim()
      const left = numOf(s['追问'])
      if (said.startsWith('对')) return 'win'
      const outOfTime = Number.isFinite(left) && left <= 0
      if (said.startsWith('错')) return outOfTime ? 'lose' : ''
      if (outOfTime) return 'lose'
      return ''
    },
  },
  {
    id: 'negotiate',
    name: '谈成一件事',
    desc: '手里有筹码，桌上有人不肯让',
    presetId: '',
    fields: [
      { key: '筹码', hint: '整数，只减不增，除非当场挣到新的', max: 1 },
      { key: '对方要的', hint: '他要什么，一条一条写', max: 6 },
      { key: '已经让掉的', hint: '让了什么、换回了什么，一条一条写，白让的不算', max: 8 },
      { key: '谈成', hint: '谈成了写「是」，没谈成就空着', max: 1 },
    ],
    rules: [
      '开局就把两边要什么摆明：你要的、他要的、两边都不肯让的那一条。',
      '每一次让步都要换回东西，白让不算，换回了什么要写进「已经让掉的」。',
      '「筹码」只减不增，除非玩家当场挣到新的，并且写清是怎么挣的。',
      '不要替玩家答应条件：他不点头，对方就一直等，等到筹码烧完为止。',
      '判结局：「谈成」写「是」算赢；「筹码」掉到 0 或以下而还没谈成，算输。',
    ],
    judge(state) {
      const s = state ?? {}
      if (isYes(s['谈成'])) return 'win'
      const chip = numOf(s['筹码'])
      if (Number.isFinite(chip) && chip <= 0) return 'lose'
      return ''
    },
  },
  {
    id: 'manage',
    name: '把日子过下去',
    desc: '收支、周转，撑不住就是撑不住',
    presetId: '',
    fields: [
      { key: '现钱', hint: '整数，手上能动的钱', max: 1 },
      { key: '欠账', hint: '整数，欠出去还没还的', max: 1 },
      { key: '连着几期亏', hint: '整数，连续赤字了几期，转正就清零', max: 1 },
      { key: '期数', hint: '整数，这是第几期', max: 1 },
    ],
    rules: [
      '每一轮算作一期（一天、一月都行，开局定死不要改），一期结一次账。',
      '每期结尾要把三个数写出来：进多少、出多少、现在剩多少。',
      '出现赤字就在「连着几期亏」上加 1，转正就清零，不许含糊过去。',
      '不允许凭空多出钱：要花钱就得先说清这钱从哪来，借的也要记进「欠账」。',
      '判结局：「连着几期亏」到 3 期算输；「现钱」到 10 且「欠账」不高于 0 算赢。',
    ],
    judge(state) {
      const s = state ?? {}
      const red = numOf(s['连着几期亏'])
      if (Number.isFinite(red) && red >= 3) return 'lose'
      const cash = numOf(s['现钱'])
      const debt = numOf(s['欠账'])
      if (Number.isFinite(cash) && Number.isFinite(debt) && cash >= 10 && debt <= 0) return 'win'
      return ''
    },
  },
  {
    id: 'faction',
    name: '站到哪一边',
    desc: '几股势力各有各的算盘，你必须得罪人',
    presetId: '',
    fields: [
      { key: '声望', hint: '一个势力一条，写成「名字 数值」，数值从 -10 到 10', max: 6 },
      { key: '盟友', hint: '现在肯为你出面的人，一个一条', max: 4 },
      { key: '欠下的人情', hint: '谁帮过你、你答应过什么，一条一条写', max: 8 },
    ],
    rules: [
      '至少三个势力，各有各要的东西，没有一个是纯好人。',
      '玩家每帮一边，另一边就要掉声望；不提供「两头讨好」的选项。',
      '声望掉到 -5 的势力会开始动手，要写清他们做了什么，不是只在数字上体现。',
      '结盟要付代价：答应一件事，就得罪另一个人，「欠下的人情」里要记着。',
      '判结局：所有势力的声望都到 -5 或更低算输（没人再跟你说话）；有声望到 6 且「盟友」不为空算赢。',
    ],
    judge(state) {
      const s = state ?? {}
      const pairs = pairsOf(s['声望'])
      if (pairs.length === 0) return ''
      if (pairs.every((p) => p.value <= -5)) return 'lose'
      const ally = String(s['盟友'] ?? '').trim()
      if (ally !== '' && pairs.some((p) => p.value >= 6)) return 'win'
      return ''
    },
  },
  {
    id: 'island',
    name: '人一个一个少',
    desc: '困在一处，活人越来越少',
    presetId: '',
    fields: [
      { key: '还活着的人', hint: '除你以外还活着的人，一个一条；一个都不剩就写「无」', max: 12 },
      { key: '天数', hint: '整数，困在这里第几天', max: 1 },
      { key: '信任', hint: '整数 0 到 10，活着的人还信你多少', max: 1 },
      { key: '少了谁', hint: '谁没了、怎么没的，一条一条写', max: 8 },
    ],
    rules: [
      '每一轮都要有人消耗掉一样东西：食物、药、一个位置，或者一份信任。',
      '死人要写清怎么死的，不要用一句「他没能撑过去」带过。',
      '「信任」低于 3 时，活着的人开始瞒着玩家做事，玩家会发现但阻止不了。',
      '不要替玩家安排谁死：让他的选择把人推到那一步，死是结果不是惩罚。',
      '判结局：「还活着的人」一个都不剩算输；「天数」到 21 天且还剩 2 个人以上算赢。',
    ],
    judge(state) {
      const s = state ?? {}
      const raw = String(s['还活着的人'] ?? '').trim()
      const alive = listOf(raw).filter((x) => x !== '无' && x !== '没有' && x !== '0')
      if (raw !== '' && alive.length === 0) return 'lose'
      const day = numOf(s['天数'])
      if (alive.length >= 2 && Number.isFinite(day) && day >= 21) return 'win'
      return ''
    },
  },
  {
    id: 'loop',
    name: '再来一遍',
    desc: '同一件事反复发生，只有你记得上一遍',
    presetId: '',
    fields: [
      { key: '周目', hint: '整数，这是第几遍', max: 1 },
      { key: 'carry', hint: '上一遍留下来的东西或知道的事，重开时要原样带进新一局', max: 8 },
      { key: '这一遍的目标', hint: '唯一的达成条件，写一句，中途不许改', max: 1 },
      { key: '达成', hint: '达成条件了写「是」，没达成就空着', max: 1 },
    ],
    rules: [
      '每一遍开头把「carry」原样带进来：上一遍知道的、留下的，这一遍的人还留着。',
      '每一遍必须栽一次（死、失败、被识破），重开时从栽之前那一步重新来，不回到开头。',
      '要让玩家看得见自己在重复：同一句话、同一个人、同一个下雨的下午，第二次出现时要有细微不同。',
      '「这一遍的目标」只有一个，开局定死，不许因为玩家快达成就偷偷改。',
      '判结局：「达成」写「是」算赢，赢了允许重开下一遍；没达成之前不判输。',
    ],
    judge(state) {
      const s = state ?? {}
      if (isYes(s['达成'])) return 'win'
      return ''
    },
  },
]

/**
 * 按 id 找引擎。也认预设 id（`game-detect`），因为老存档里存的是预设。
 *
 * 界面上报给用户的是短 id，存档里可能两种都出现过；两种都能认，
 * 老的一局才不会因为「引擎找不到」而突然变回没有玩法的状态。
 */
export function findEngine(id) {
  const want = String(id ?? '').trim()
  if (want === '') return null
  return ENGINES.find((e) => e.id === want) ?? ENGINES.find((e) => e.presetId === want) ?? null
}

// ─────────────────────────────────────────────────────────────
// 二、剧本：解析与反向序列化
// ─────────────────────────────────────────────────────────────

/**
 * 正文行里会把解析器带偏的几个前缀：`## `（新节点）、`@`（视觉槽 / 未知标记）、
 * `【选】`（切到选项段）。写剧本的人可能真的想写这几个字符，于是在前面加一个反斜杠。
 *
 * 和 game.js 的 escapeLines 是同一个教训：不转义不会报错，只会「内容悄悄没了」。
 */
function escapeBodyLine(text) {
  const raw = String(text ?? '')
  return /^(\s*)(##\s|@|【选】)/.test(raw) ? raw.replace(/^(\s*)/, '$1\\') : raw
}

function unescapeBodyLine(text) {
  return String(text ?? '').replace(/^(\s*)\\(?=##\s|@|【选】)/, '$1')
}

/** 条件行：`[if 好感 >= 3] 正文`。 */
const COND_LINE = /^\s*\[if\s+(.+?)\]\s?(.*)$/

/**
 * 把一个节点尾部的空行去掉。
 *
 * 渲染时用空行分隔节点和 `【选】`，读回来时这些空行会变成正文的一部分。
 * 两边都做一次裁剪，`parseScript(renderScript(x))` 才是恒等的——不然每存一次
 * 剧本就多一行空白，攒上十次正文里全是空行。
 */
function trimTail(node) {
  if (node === null || node === undefined) return
  const lines = node.lines
  while (lines.length > 0 && String(lines[lines.length - 1]?.text ?? '').trim() === '' && String(lines[lines.length - 1]?.cond ?? '') === '') {
    lines.pop()
  }
}

/**
 * 解析一份剧本。
 *
 * 认的语法（写手只需要记这四条）：
 *   `## 节点名`              起一个节点，第一个就是入口
 *   `@bg 一句话` / `@char 谁 在做什么`   可选的视觉槽（视觉小说那一路要的）
 *   `【选】` 之后每行 `- 文本（代价）-> 目标节点`   跳转；目标是「结束」/`END` 就是结局
 *   行首 `[if 条件] `       条件是假的，这一行就不出现（ink 的织体）
 *
 * 跳转目标不存在**不抛错**：把这条记进 errors，节点照样解析出来。
 * 写手正在写第五个节点的时候，第六个还不存在——这时抛错等于逼他一次写完。
 */
export function parseScript(text) {
  const raw = String(text ?? '')
  if (raw.trim() === '') {
    return { ok: false, errors: [{ error: '这个剧本是空的。' }], nodes: [] }
  }

  const nodes = []
  const errors = []
  const choiceRefs = []
  /** 记下每个「【选】」写在哪一行：写坏了（后面没跟上选项）要能指回去。 */
  const choiceMarks = []
  const seenAt = new Map()
  let cur = null
  let sawChoices = false

  const addError = (node, line, message) => {
    errors.push({ node: node === null ? '' : String(node.name ?? ''), line, error: message })
  }

  const lines = raw.split(/\r?\n/)
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1
    const line = lines[i]
    const trimmed = line.trim()

    // `## 节点名` —— 只认行首两个井号，`###` 和缩进过的都不算。
    const head = /^##\s+(.*)$/.exec(line)
    if (head !== null) {
      trimTail(cur)
      const name = String(head[1]).trim()
      if (name === '') {
        addError(cur, lineNo, '这一行节点没有名字。')
        cur = null
        sawChoices = false
        continue
      }
      if (seenAt.has(name)) addError({ name }, lineNo, `有两个节点都叫「${name}」，跳转会落到后面那一个。`)
      else seenAt.set(name, lineNo)
      cur = { name, bg: '', chars: [], lines: [], choices: [] }
      nodes.push(cur)
      sawChoices = false
      continue
    }

    if (cur === null) {
      if (trimmed !== '') addError(null, lineNo, '正文要写在 `## 节点名` 里面；这一行没有归属，先跳过了。')
      continue
    }

    if (/^@bg\b/.test(trimmed)) {
      cur.bg = String(trimmed.replace(/^@bg\s*/, '')).trim()
      continue
    }
    if (/^@char\b/.test(trimmed)) {
      const who = String(trimmed.replace(/^@char\s*/, '')).trim()
      if (who !== '') cur.chars.push(who)
      continue
    }
    if (/^【选】$/.test(trimmed)) {
      if (sawChoices) addError(cur, lineNo, '一个节点只能有一段「【选】」。')
      trimTail(cur)
      sawChoices = true
      choiceMarks.push({ node: cur, line: lineNo, got: cur.choices.length })
      continue
    }
    if (/^@/.test(trimmed)) {
      addError(cur, lineNo, `不认识的标记「${trimmed.split(/\s/)[0]}」，这一行当正文留着了。`)
      cur.lines.push({ cond: '', text: line })
      continue
    }

    if (sawChoices) {
      if (trimmed === '') continue
      const item = /^[-*]\s*(.*)$/.exec(trimmed)
      if (item === null) {
        addError(cur, lineNo, '【选】后面只认「- 文本 -> 目标节点」这种行。')
        continue
      }
      const whole = String(item[1]).trim().replace(/→/g, '->')
      const at = whole.lastIndexOf('->')
      if (at < 0) {
        addError(cur, lineNo, '这个选项没写「-> 目标节点」。')
        continue
      }
      const label = whole.slice(0, at).trim()
      const target = whole.slice(at + 2).trim()
      if (label === '') {
        addError(cur, lineNo, '这个选项没有写内容。')
        continue
      }
      if (target === '') {
        addError(cur, lineNo, '这个选项没写要跳到哪个节点。')
        continue
      }
      const choice = { text: label, target }
      cur.choices.push(choice)
      choiceRefs.push({ node: cur, choice, line: lineNo })
      continue
    }

    const cond = COND_LINE.exec(line)
    if (cond !== null) {
      cur.lines.push({ cond: String(cond[1]).trim(), text: unescapeBodyLine(cond[2]) })
      continue
    }
    cur.lines.push({ cond: '', text: unescapeBodyLine(line) })
  }
  trimTail(cur)

  // 跳转目标要等全部读完才验：写着写着节点才出现的顺序太正常了。
  const names = new Set(nodes.map((n) => n.name))
  for (const ref of choiceRefs) {
    if (isEndTarget(ref.choice.target)) continue
    if (names.has(ref.choice.target)) continue
    addError(ref.node, ref.line, `「${ref.choice.target}」这个节点不存在`)
  }

  // 记了「【选】」却一个选项都没收下：写手最常见的写坏方式（忘了写 `- 文本 -> 目标`）。
  // 必须在 errors 里说出来，否则这一个节点会被当成「线性推进」，玩家永远走不到下一段。
  for (const mark of choiceMarks) {
    const node = mark.node
    if (node === null) continue
    const after = choiceRefs.filter((r) => r.node === node).length
    if (after === mark.got) addError(node, mark.line, '「【选】」后面没有写任何选项。')
  }

  return { ok: errors.length === 0, nodes, errors }
}

/**
 * 反向：把节点数组写回剧本文字。
 *
 * `parseScript(renderScript(x))` 必须能还原 x，所以这里的排版不是「好看」，
 * 而是解析器认的唯一一种写法：头、视觉槽、正文、空行、`【选】`、选项。
 */
export function renderScript(nodes) {
  const list = Array.isArray(nodes) ? nodes : []
  const blocks = []
  for (const node of list) {
    const out = [`## ${String(node?.name ?? '').trim()}`]
    const bg = String(node?.bg ?? '').trim()
    if (bg !== '') out.push(`@bg ${bg}`)
    for (const who of Array.isArray(node?.chars) ? node.chars : []) {
      const text = String(who ?? '').trim()
      if (text !== '') out.push(`@char ${text}`)
    }
    for (const line of Array.isArray(node?.lines) ? node.lines : []) {
      const body = escapeBodyLine(String(line?.text ?? ''))
      const cond = String(line?.cond ?? '').trim()
      out.push(cond === '' ? body : `[if ${cond}] ${body}`)
    }
    const choices = Array.isArray(node?.choices) ? node.choices : []
    if (choices.length > 0) {
      out.push('', '【选】')
      for (const choice of choices) {
        out.push(`- ${String(choice?.text ?? '').trim()} -> ${String(choice?.target ?? '').trim()}`)
      }
    }
    blocks.push(out.join('\n'))
  }
  if (blocks.length === 0) return ''
  return `${blocks.join('\n\n')}\n`
}

// ─────────────────────────────────────────────────────────────
// 三、旗标与条件
// ─────────────────────────────────────────────────────────────

/**
 * 上一次 evalCond 为什么没看懂。
 *
 * 形状照 `store.lastConfigReadError()`：`{ error, cond }`，成功时清成 null。
 * 为什么不抛：条件行只是决定「这一行出不出现」，看错一个符号就整段剧本打不开，
 * 代价太大。宁可放行，把原因留在模块里让人自查。
 */
let condError = null

/** 读「上一次条件判断出的什么事」。没出过事返回 null。 */
export function lastCondError() {
  return condError
}

/**
 * 解析旗标：一行一条 `key = 值`。
 *
 * 数值就是数值（`好感 = 3` → 3），带引号的是文本（`老周 = "活着"`）。
 * 不带引号也不是数字的，当文本收下——手写的时候没人愿意给每个词加引号。
 */
export function parseFlags(text) {
  const out = {}
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('//')) continue
    const at = line.indexOf('=')
    if (at <= 0) continue
    const key = line.slice(0, at).trim()
    if (key === '') continue
    const value = line.slice(at + 1).trim()
    if (value.length >= 2) {
      const head = value[0]
      const tail = value[value.length - 1]
      if ((head === '"' && tail === '"') || (head === "'" && tail === "'")) {
        out[key] = value.slice(1, -1).replace(/\\(["'\\])/g, '$1')
        continue
      }
    }
    out[key] = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value
  }
  return out
}

/** 反向：文本值一律带引号，读回来才不会从字符串变成数字。 */
export function renderFlags(map) {
  const out = []
  for (const [key, value] of Object.entries(map ?? {})) {
    const name = String(key ?? '').trim()
    if (name === '') continue
    if (value === null || value === undefined) continue
    if (typeof value === 'number' && Number.isFinite(value)) out.push(`${name} = ${value}`)
    else if (typeof value === 'boolean') out.push(`${name} = ${value ? '是' : '否'}`)
    else out.push(`${name} = "${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
  }
  return out.join('\n')
}

/** `>=` `<=` `>` `<` `==` `!=` `=`，长的写在前面，免得 `>=` 被拆成 `>` 加 `=`。 */
const COMPARE = /^(.+?)\s*(>=|<=|==|!=|=|>|<)\s*(.+)$/

/** 「真」的几种写法。`否` 和 `0` 都算假——模型两种都写得出来。 */
function isTruthy(value) {
  if (value === undefined || value === null || value === false) return false
  if (value === 0 || value === '0') return false
  const text = String(value).trim()
  return text !== '' && text !== '否' && text !== 'no' && text !== 'false'
}

function operandOf(text) {
  const raw = String(text ?? '').trim()
  if (raw.length >= 2) {
    const head = raw[0]
    const tail = raw[raw.length - 1]
    if ((head === '"' && tail === '"') || (head === "'" && tail === "'")) return raw.slice(1, -1)
  }
  return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw
}

/**
 * 判断一个条件行成不成立。认四种写法：
 *   `好感 >= 3`     数值比较
 *   `线索数 > 2`    数值比较
 *   `老周 == 活着`   文本比较
 *   `!见过面`       旗标是假的
 *
 * 看不懂就返回 true：宁可多显示一行，也不让整段剧本因为一个符号打不开。
 * 原因记进 lastCondError()。
 */
export function evalCond(cond, flags) {
  condError = null
  const text = String(cond ?? '').trim()
  if (text === '') return true
  const map = flags === null || flags === undefined ? {} : flags

  if (text.startsWith('!')) {
    const key = text.slice(1).trim()
    if (key === '') {
      condError = { error: `看不懂这个条件：「${text}」。这一行先照常显示。`, cond: text }
      return true
    }
    return !isTruthy(map[key])
  }

  const m = COMPARE.exec(text)
  if (m === null) {
    condError = { error: `看不懂这个条件：「${text}」。这一行先照常显示。`, cond: text }
    return true
  }
  const key = String(m[1]).trim()
  const op = m[2]
  const right = operandOf(m[3])
  const left = map[key]
  const has = Object.prototype.hasOwnProperty.call(map, key)

  // 两边都是数才按数比：`3 >= 2` 和 `3 >= "2"` 在字符串里是两回事。
  const ln = Number(left)
  const numeric = has && typeof right === 'number' && Number.isFinite(ln) && String(left ?? '').trim() !== ''
  const a = numeric ? ln : String(left ?? '')
  const b = numeric ? /** @type {number} */ (right) : String(right ?? '')

  if (op === '=' || op === '==') return a === b
  if (op === '!=') return a !== b
  if (!numeric) {
    // 文本比大小没有意义；能走到这里说明写的人以为自己在比数。
    condError = { error: `「${text}」比较的不是数字，这一行先照常显示。`, cond: text }
    return true
  }
  if (op === '>') return a > b
  if (op === '<') return a < b
  if (op === '>=') return a >= b
  return a <= b
}

// ─────────────────────────────────────────────────────────────
// 四、导出
// ─────────────────────────────────────────────────────────────

/**
 * 节点名 → ink 里能用的 knot 名。
 *
 * ink 的 knot 名不吃空格，所以只做一件事：空白换成下划线。中文原样留着，
 * 人回去改的时候还认得出这是哪一段。
 */
function inkKnot(name, index) {
  const text = String(name ?? '').trim()
  if (text === '') return `节点${index + 1}`
  return text.replace(/\s+/g, '_')
}

/**
 * 导出成 ink 草稿（inkjs / inklewriter 那一路的语法）。
 *
 * 单向：这里不负责保证能编译，也不回读 ink。目标是「玩过的一局、改好的剧本，
 * 能拿到 inklewriter 里接着改」——条件行变成织体 `{cond: 文本}`，选项变成
 * `* [文本] -> 目标`，这就是 ink 里那两样东西最直白的写法。
 */
export function toInk(nodes, meta) {
  const list = Array.isArray(nodes) ? nodes : []
  const info = meta ?? {}
  const knots = new Map()
  list.forEach((node, i) => knots.set(String(node?.name ?? ''), inkKnot(node?.name, i)))

  const out = [
    '// 由 LifeCard 的文字游戏剧本导出。',
    '// 单向导出：这里是给人接着改的草稿，不保证 ink 编译器的语法全覆盖。',
    '// 拿到 inklewriter / inky 里可以继续改：knot 名、选项和条件都还在。',
  ]
  const title = String(info.title ?? '').trim()
  if (title !== '') out.push(`// 《${title}》`)
  out.push('')

  for (const node of list) {
    const name = String(node?.name ?? '')
    out.push(`=== ${knots.get(name)} ===`)
    const bg = String(node?.bg ?? '').trim()
    if (bg !== '') out.push(`// 背景：${bg}`)
    for (const who of Array.isArray(node?.chars) ? node.chars : []) {
      const text = String(who ?? '').trim()
      if (text !== '') out.push(`// 在场：${text}`)
    }
    for (const line of Array.isArray(node?.lines) ? node.lines : []) {
      const text = String(line?.text ?? '')
      const cond = String(line?.cond ?? '').trim()
      out.push(cond === '' ? text : `{${cond}: ${text}}`)
    }
    for (const choice of Array.isArray(node?.choices) ? node.choices : []) {
      const target = String(choice?.target ?? '').trim()
      const to = isEndTarget(target) ? 'END' : (knots.get(target) ?? target)
      out.push(`* [${String(choice?.text ?? '').trim()}] -> ${to}`)
    }
    out.push('')
  }
  out.push('-> END')
  return `${out.join('\n')}\n`
}

/** HTML 转义。正文里一个引号就能把属性值和整页结构搞坏，所以四个字符都要挡。 */
function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 导出成一个单文件 HTML（CYOAwesome 那一路：写手只写正文，分支由引擎生成）。
 *
 * 三条硬要求：
 *   1. 双击就能打开——不引任何外部资源，CSS 和 JS 都内联，没有 http(s) 地址；
 *   2. 正文全部转义后写进 DOM，页面里不存在「用户文本拼进 innerHTML」这一步；
 *   3. 没装这个插件、没网也能玩：节点、选项、条件全在文件里。
 *
 * 旗标是这一版唯一「活着」的状态：每走过一个节点就累加一次「走过:<节点名>」，
 * 条件行 `[if 走过:码头 >= 2]` 就能用上它。它不是完整的 ink，但足够让同一个
 * 节点第二次进来时不一样。
 */
export function toCyoaHtml(title, nodes) {
  const list = Array.isArray(nodes) ? nodes : []
  const name = String(title ?? '').trim() === '' ? '一个故事' : String(title).trim()

  const sections = list.map((node) => {
    const bg = String(node?.bg ?? '').trim()
    const cast = (Array.isArray(node?.chars) ? node.chars : []).map((x) => String(x ?? '').trim()).filter((x) => x !== '')
    const attrs = [`data-node="${escapeHtml(String(node?.name ?? ''))}"`]
    if (bg !== '') attrs.push(`data-bg="${escapeHtml(bg)}"`)
    if (cast.length > 0) attrs.push(`data-cast="${escapeHtml(cast.join('；'))}"`)
    const inner = []
    for (const line of Array.isArray(node?.lines) ? node.lines : []) {
      const cond = String(line?.cond ?? '').trim()
      const text = String(line?.text ?? '')
      if (text === '' && cond === '') { inner.push('<p data-line></p>'); continue }
      const condAttr = cond === '' ? '' : ` data-cond="${escapeHtml(cond)}"`
      inner.push(`<p data-line${condAttr}>${escapeHtml(text)}</p>`)
    }
    for (const choice of Array.isArray(node?.choices) ? node.choices : []) {
      inner.push(`<a href="#" data-choice data-target="${escapeHtml(String(choice?.target ?? ''))}">${escapeHtml(String(choice?.text ?? ''))}</a>`)
    }
    return `    <section ${attrs.join(' ')}>\n${inner.map((x) => `      ${x}`).join('\n')}\n    </section>`
  })

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #14130f; color: #ddd6c6; font-family: Georgia, "Songti SC", "Noto Serif CJK SC", serif; line-height: 1.85; }
  main { max-width: 34rem; margin: 0 auto; padding: 4rem 1.5rem 6rem; }
  h1 { font-size: 1.25rem; font-weight: normal; letter-spacing: .12em; color: #8d8574; margin: 0 0 2.5rem; }
  .bg { font-size: .85rem; letter-spacing: .2em; color: #6f6a5c; margin: 0 0 .4rem; }
  .cast { font-size: .9rem; color: #9c8f74; margin: 0 0 1.6rem; }
  p { margin: 0 0 1.1rem; white-space: pre-wrap; }
  a { display: block; margin: .6rem 0; padding: .55rem .9rem; color: #e8dfc8; text-decoration: none; border: 1px solid #3a352a; border-radius: 2px; }
  a:hover { background: #1f1d16; border-color: #6d6551; }
  .meta { margin-top: 3rem; font-size: .75rem; letter-spacing: .16em; color: #5b564a; }
  .end { color: #8d8574; font-size: .9rem; letter-spacing: .18em; margin: 2rem 0 1rem; }
  #deck { display: none; }
</style>
</head>
<body>
<main id="app"></main>
<div id="deck">
${sections.join('\n')}
</div>
<script>
(function () {
  var deck = document.getElementById('deck')
  var app = document.getElementById('app')
  var nodes = Array.prototype.map.call(deck.querySelectorAll('section'), function (sec) {
    return {
      name: sec.getAttribute('data-node') || '',
      bg: sec.getAttribute('data-bg') || '',
      cast: sec.getAttribute('data-cast') || '',
      lines: Array.prototype.map.call(sec.querySelectorAll('[data-line]'), function (p) {
        return { cond: p.getAttribute('data-cond') || '', text: p.textContent }
      }),
      choices: Array.prototype.map.call(sec.querySelectorAll('[data-choice]'), function (a) {
        return { text: a.textContent, target: a.getAttribute('data-target') || '' }
      })
    }
  })
  var at = {}
  nodes.forEach(function (n, i) { at[n.name] = i })
  var flags = { 步数: 0 }
  var END = ['结束', 'END', 'end', 'End', '完', '结局', '终']

  function isEnd(t) { return END.indexOf(String(t).trim()) >= 0 }
  function truthy(v) {
    if (v === undefined || v === null || v === false) return false
    if (v === 0 || v === '0') return false
    var s = String(v).trim()
    return s !== '' && s !== '否'
  }
  // 和 lib/story.js 的 evalCond 同一套写法：看不懂就当条件成立，宁可多显示一行。
  function evalCond(cond) {
    var text = String(cond || '').trim()
    if (text === '') return true
    if (text.charAt(0) === '!') return !truthy(flags[text.slice(1).trim()])
    var m = /^(.+?)\\s*(>=|<=|==|!=|=|>|<)\\s*(.+)$/.exec(text)
    if (m === null) return true
    var left = flags[m[1].trim()]
    var right = m[3].trim()
    if (/^-?\\d+(\\.\\d+)?$/.test(right)) right = Number(right)
    var a = typeof right === 'number' ? Number(left) : String(left === undefined ? '' : left)
    var b = right
    if (isNaN(a) && typeof b === 'number') return true
    if (m[2] === '=' || m[2] === '==') return a === b
    if (m[2] === '!=') return a !== b
    if (m[2] === '>') return a > b
    if (m[2] === '<') return a < b
    if (m[2] === '>=') return a >= b
    return a <= b
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined) node.textContent = text
    return node
  }
  function clear() { while (app.firstChild) app.removeChild(app.firstChild) }
  function ending(text) {
    clear()
    app.appendChild(el('h1', '', document.title))
    app.appendChild(el('div', 'end', text))
    var again = el('a', '', '从头再来一遍')
    again.href = '#'
    again.addEventListener('click', function (ev) {
      ev.preventDefault()
      flags = { 步数: 0 }
      show(0)
    })
    app.appendChild(again)
  }
  function show(index) {
    var node = nodes[index]
    if (node === undefined) { ending('这个节点不在了。'); return }
    flags['走过:' + node.name] = (flags['走过:' + node.name] || 0) + 1
    flags['步数'] = (flags['步数'] || 0) + 1
    clear()
    app.appendChild(el('h1', '', document.title))
    if (node.bg) app.appendChild(el('div', 'bg', node.bg))
    if (node.cast) app.appendChild(el('div', 'cast', node.cast))
    node.lines.forEach(function (line) {
      if (!evalCond(line.cond)) return
      app.appendChild(el('p', '', line.text))
    })
    if (node.choices.length === 0) {
      var next = index + 1
      if (next < nodes.length) {
        var more = el('a', '', '继续')
        more.href = '#'
        more.addEventListener('click', function (ev) { ev.preventDefault(); show(next) })
        app.appendChild(more)
      } else {
        ending('这一局到这里。')
        return
      }
    }
    node.choices.forEach(function (choice) {
      if (!evalCond(choice.cond || '')) return
      var link = el('a', '', choice.text)
      link.href = '#'
      link.addEventListener('click', function (ev) {
        ev.preventDefault()
        flags['选过:' + choice.target] = (flags['选过:' + choice.target] || 0) + 1
        if (isEnd(choice.target)) { ending('这一局到这里。'); return }
        var to = at[choice.target]
        if (to === undefined) { ending('「' + choice.target + '」这个节点不存在。'); return }
        show(to)
      })
      app.appendChild(link)
    })
    app.appendChild(el('div', 'meta', '第 ' + flags['步数'] + ' 步'))
  }
  if (nodes.length === 0) ending('这个剧本还是空的。')
  else show(0)
})()
</script>
</body>
</html>
`
}

// ─────────────────────────────────────────────────────────────
// 五、引擎与剧本的桥
// ─────────────────────────────────────────────────────────────

/**
 * 一局游戏的主持人提示词（带玩法引擎的版本）。
 *
 * 骨架和 `game.buildGmSystem` 一字不差地照抄（谁是/每轮做什么/报状态/绝对不做），
 * 只有三处不一样：
 *   1. 状态段要报哪几类，由引擎的 fields 决定，不是写死的那四个；
 *   2. 引擎的 rules 追加成【这一局的玩法】；
 *   3. flags 有值时多一段【已经定下来的事】，避免模型把上几轮定下的事又推翻。
 *
 * 为什么不改 buildGmSystem 本身：那五个老预设靠它，改一个字都可能让老存档
 * 演起来变味。两套并存，代价是多一个函数，收益是老玩法一个字不动。
 */
export function buildEngineSystem({ engine, bookTitle, scene, status, holding, preset, role, flags }) {
  const eng = engine === null || engine === undefined ? null : engine
  const title = String(bookTitle ?? '').trim() === '' ? '未命名' : String(bookTitle).trim()
  const fields = Array.isArray(eng?.fields) && eng.fields.length > 0 ? eng.fields : []
  const lines = [
    `你在主持一个文字小说游戏。这个故事来自《${title}》。`,
  ]
  if (eng !== null) lines.push(`这一局的玩法是「${String(eng.name ?? '').trim()}」：${String(eng.desc ?? '').trim()}`)
  lines.push(
    '',
    '【你是谁】',
    '你是那个「世界」本身：写景、写别人的反应、写事情怎么往下走。你不是故事里的任何一个人。',
    '',
    '【每一轮你要做什么】',
    '1. 先用两三段写清**这一刻发生了什么**（看见了什么、谁说了什么、局面怎么变了）。',
    '2. 最后给出三个可以走的方向，格式固定：',
    '   A. ……',
    '   B. ……',
    '   C. ……',
    '3. 三个方向必须是**做得出来的具体动作**，不是「继续」「观察」这种空话。',
    '4. 三个都要有代价：选了这个就会失去那个。不要给一个明显更好的选项。',
    '',
    '【每一轮最后再报一次状态】',
    '正文和三个方向写完之后，另起一段写 `【状态】`，下面按「名目：内容」一行一条：',
  )
  const statusKeys = fields.length > 0
    ? fields.map((f) => {
      const hint = String(f?.hint ?? '').trim().replace(/。$/, '')
      const cap = Number(f?.max) > 1 ? `；最多 ${Number(f.max)} 条` : ''
      return `   - ${String(f?.key ?? '').trim()}：……（${hint}${cap === '' ? '' : cap}）`
    })
    : ['   - 在哪：……', '   - 身上：……', '   - 心里：……', '   - 谁还信我：……']
  lines.push(...statusKeys)
  lines.push(
    '规矩：',
    '- 每次都要写**这一局的整份状态**，不是这一轮的变化。',
  )
  if (fields.length > 0) {
    lines.push(
      `- 名目固定用上面这 ${fields.length} 个，一个都不要少，也不要自己加新的。`,
      `- 每个名目最多 ${FIELD_MAX} 条，总条数压在一屏能看完的量上。`,
    )
  } else {
    lines.push(`- 名目固定用上面那四个，最多 ${FIELD_MAX} 条。`)
  }
  lines.push(
    '- 内容要具体到能拿来判事：不要写「有点累」，写「左手抬不过肩」；该是数的就写整数，不写「不多了」。',
    '- 同一个名目下有多件事时，用「；」隔开写在一行里，不要换行——换行会把状态段切断。',
    '- 状态必须和刚才写的情节对得上。这一轮他挨了一刀，体力就不能还写「没事」。',
    '- `【状态】` 这一块不会念给对方听，是给界面和结局判定看的；正文里该写什么还写什么，不要提「状态」这两个字。',
  )
  if (eng !== null && Array.isArray(eng.rules) && eng.rules.length > 0) {
    lines.push('', '【这一局的玩法】', ...eng.rules.map((r) => `- ${String(r ?? '').trim()}`))
  }
  lines.push(
    '',
    '【绝对不做】',
    '- 不替玩家决定他说什么、做什么、想什么。',
    '- 不写「你可以选择」这种话，直接把三个方向列出来。',
    '- 不提前揭晓后面才该知道的事。',
    '- 不写「（作为 AI）」这类跳出的话。',
    '- 不用「命运的齿轮」这种空话起头。',
  )
  const who = String(role ?? '').trim()
  if (who !== '') {
    lines.push('', '【玩家操控的是谁】', who, '', '写他身边发生的事，不要替他做决定；也不要把他写成另外一个人。')
  }
  if (String(scene ?? '').trim() !== '') {
    lines.push('', '【现在】', String(scene).trim())
  }
  const now = (Array.isArray(status) ? status : []).map((x) => String(x ?? '').trim()).filter((x) => x !== '')
  if (now.length > 0) {
    lines.push('', '【状态】（上一轮结束时是这样，这一轮接着往下推，该变就变）', ...now.map((s) => `- ${s}`))
  }
  if (Array.isArray(holding) && holding.length > 0) {
    lines.push('', '【手上的】', ...holding.map((h) => `- ${String(h ?? '').trim()}`))
  }
  const flagMap = typeof flags === 'string' ? parseFlags(flags) : (flags ?? {})
  const entries = Object.entries(flagMap).filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (entries.length > 0) {
    lines.push('', '【已经定下来的事】（这些不用再演一遍，也不要推翻）', ...entries.map(([k, v]) => `- ${k}：${String(v)}`))
  }
  const extra = String(preset ?? '').trim()
  if (extra !== '') lines.push('', '【这一局的额外要求】', extra)
  return lines.join('\n')
}

/**
 * 把状态快照理成一个普通对象。
 *
 * 存档里的 `## 状态` 是一串「名目：内容」的字符串（game.tidyStatus 的产品），
 * 而 judge 要的是 `{ 名目: 内容 }`。这里把三种输入都收下：
 * 字符串（当旗标式文本）、字符串数组（存档那一节）、已经是对象。
 */
function stateMapOf(state) {
  if (state === null || state === undefined) return {}
  if (typeof state === 'string') return parseFlags(state)
  if (Array.isArray(state)) {
    const out = {}
    for (const item of state) {
      const raw = String(item ?? '').trim().replace(/^[-*]\s*/, '')
      if (raw === '') continue
      const m = /^(.{1,16}?)\s*[：:=]\s*(.*)$/.exec(raw)
      // 拆不开的行不是字段（多半是模型多写的一句解释），丢掉，不拿它判输赢。
      if (m === null) continue
      out[String(m[1]).trim()] = String(m[2]).trim()
    }
    return out
  }
  if (typeof state === 'object') return state
  return {}
}

/**
 * 判这一局有没有结束。
 *
 * 包一层 try/catch 的理由不是「怕引擎写错」，而是：用户以后能自己注册引擎
 * （MTF / RasPG 那一路的模块化），他写的 judge 抛一个 TypeError，不该让整局
 * 卡死在「这一轮点不动了」。判不出来就当作还没结束，把原因留在 reason 里。
 */
export function judgeEnding(engine, state) {
  if (engine === null || engine === undefined) return { ending: '', reason: '' }
  if (typeof engine.judge !== 'function') return { ending: '', reason: '' }
  try {
    const raw = engine.judge(stateMapOf(state))
    const ending = raw === 'win' || raw === 'lose' ? raw : ''
    return { ending, reason: '' }
  } catch (error) {
    const detail = String(error?.message ?? error ?? '').trim()
    return { ending: '', reason: `这一局的结局判不出来：${detail === '' ? '引擎自己出的错' : detail}` }
  }
}
