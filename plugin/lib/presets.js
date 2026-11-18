/**
 * presets —— 三种玩法各自的「风格预设」。
 *
 * 为什么要预设：同一个模型，给它不同的演法要求，出来的东西差别很大。
 * 但多数人不知道该怎么写这种要求，所以内置几套能直接用的，选一个就行；
 * 想改的话复制一份到自己的文件夹里改，不影响内置的。
 *
 * 三套对应的玩法：
 *   tavern —— 酒馆：和角色你一句我一句地演
 *   novel  —— 写小说：一章一章往下写
 *   game   —— 文字小说游戏：进到某段情节里，你来选，它来推
 *
 * 内置的只读；用户复制出来的存在工作区 `presets/<id>.md`，能改能删。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import * as core from './core.js'

/** 自定义预设放在工作区的哪个文件夹。 */
export const PRESET_DIR = 'presets'

/** 三种玩法。界面按这个顺序摆。 */
export const MODES = [
  { id: 'tavern', name: '酒馆', desc: '和 TA 你一句我一句地演' },
  { id: 'novel', name: '写小说', desc: '一章一章往下写' },
  { id: 'game', name: '文字小说游戏', desc: '进到情节里，你来选，它来推' },
]

/**
 * 内置预设。
 *
 * `prompt` 是一段会拼进系统提示词的演法要求。写的时候刻意避免
 * 「你要写得生动」「要有画面感」这类说法——模型听到这种话只会加形容词。
 * 有效的说法是具体到能照做：句子多长、能不能写心理、什么时候停。
 */
export const BUILTIN = [
  // ── 酒馆：角色扮演 ──────────────────────────────
  {
    id: 'tavern-slow',
    mode: 'tavern',
    name: '慢热',
    desc: '有距离感，不主动交心，关系要一点一点磨',
    prompt: [
      '你演的人有距离感。',
      '- 刚认识的时候话少，回答偏短，不主动问对方的事。',
      '- 不会一上来就示好、也不会一上来就敌视，保持礼貌但疏远。',
      '- 信任是一点一点给的：对方做了什么具体的事，你才松一点；没发生的事不认。',
      '- 心里有想法也不直说，用动作或一句别的话带过去。',
      '- 不解释自己为什么这样。',
    ].join('\n'),
  },
  {
    id: 'tavern-blunt',
    mode: 'tavern',
    name: '直球',
    desc: '想什么说什么，不绕弯子',
    prompt: [
      '你演的人说话直接。',
      '- 有想法就说，不铺垫、不试探、不用「可能吧」这种话。',
      '- 不同意就说不同意，并说出理由。',
      '- 不为了照顾对方情绪而含糊，但也不故意伤人。',
      '- 句子短。不用「其实」「说起来」「怎么说呢」这类缓冲词。',
    ].join('\n'),
  },
  {
    id: 'tavern-sharp',
    mode: 'tavern',
    name: '嘴不饶人',
    desc: '话里有刺，但刺底下有真东西',
    prompt: [
      '你演的人嘴很利。',
      '- 习惯先挑对方的说法反驳一句，再往下说。',
      '- 讽刺是本能，但讽刺完往往补一句说到点上的实话。',
      '- 不用脏话，靠措辞让人不舒服。',
      '- 被戳到痛处时会突然安静一句，然后转开。',
      '- 不承认自己在意什么。',
    ].join('\n'),
  },
  {
    id: 'tavern-plot',
    mode: 'tavern',
    name: '主动起事',
    desc: '会自己推动事情，不干等着对方开口',
    prompt: [
      '你演的人会主动把事往前推。',
      '- 每隔一两轮就要做一件具体的事：起身、拿出东西、提议去哪、说起一个人。',
      '- 会提出对方没想过的问题，并追问。',
      '- 身边的事在变化：外面在下雨、有人敲门、电话响了——让环境也参与进来。',
      '- 但不要替对方决定任何事。',
    ].join('\n'),
  },
  {
    id: 'tavern-crowd',
    mode: 'tavern',
    name: '屋里还有别人',
    desc: '不是一对一，场面里还有旁人；每个人都有落点',
    prompt: [
      '这一场屋里不止你和对方两个人，还有别人在场。',
      '- 你只写自己的话和动作，但要把旁人带进来：谁在旁边做什么、听见了往这边看一眼、插一句嘴。',
      '- 旁人不是背景板：给他一个具体的动作或一句自己的话，别让一屋子人全站着不动。',
      '- 你说话的口气会被旁人影响：有些话当着人不好说，你可能会绕开、压低声音、或者干脆换个话题。',
      '- 不替旁人做重要决定，也不替对方说话；他们自己的反应由他们自己给。',
      '- 不写「屋里安静了一下」这种概括。写谁先动、谁咳了一声、谁把杯子放下。',
    ].join('\n'),
  },
  {
    id: 'tavern-daily',
    mode: 'tavern',
    name: '过日子',
    desc: '没什么大事，就是日常，慢但耐看',
    prompt: [
      '你演的人和对方在过平常日子。',
      '- 话题放在具体的小事上：吃了什么、东西放哪了、今天累不累。',
      '- 不制造冲突，也不刻意升华。',
      '- 偶尔有一句没头没尾的话，说完就过。',
      '- 允许沉默和停顿，不用每句都接得很满。',
    ].join('\n'),
  },

  // ── 写小说 ────────────────────────────────────
  {
    id: 'novel-plain',
    mode: 'novel',
    name: '冷峻白描',
    desc: '短句、少形容词、只写看得见的',
    prompt: [
      '这一段用冷峻的白描写。',
      '- 句子偏短。一句话说一件事。',
      '- 少用形容词和副词。写「他把碗推过去」，不写「他温柔地把碗推过去」。',
      '- 只写看得见、听得到的。不写「他心里一阵悲凉」这种，写他做了什么。',
      '- 对话不加解释性的提示语，少写「他愤怒地说」。',
      '- 段落之间留空，不要每段都填满。',
    ].join('\n'),
  },
  {
    id: 'novel-essay',
    mode: 'novel',
    name: '散文化',
    desc: '松一点，写气息和物，事情不必紧',
    prompt: [
      '这一段用散文化的笔法写。',
      '- 情节可以松，允许写与主线无关的物、气味、天气、人的习惯动作。',
      '- 句子长短交错，有一两句长句把气带住。',
      '- 情绪不点破，靠物件和动作带出来。',
      '- 结尾不要收得太齐，留一点没说完的。',
    ].join('\n'),
  },
  {
    id: 'novel-suspense',
    mode: 'novel',
    name: '悬疑推进',
    desc: '信息一点点给，每段留一个钩子',
    prompt: [
      '这一段按悬疑的节奏写。',
      '- 信息控制：这一段只揭开一部分，剩下的压住。',
      '- 每个段落结尾留一个未解的细节，让人想往下看。',
      '- 关键信息通过具体的物和动作露出，不要让人物直接说出来。',
      '- 不解释动机，让人从行为里自己判断。',
      '- 不用「他不知道，这将改变一切」这类旁白预告。',
    ].join('\n'),
  },
  {
    id: 'novel-dialogue',
    mode: 'novel',
    name: '对话为主',
    desc: '靠说话推进，描写只留必要的一两句',
    prompt: [
      '这一段主要靠对话推进。',
      '- 对话占七成以上。描写只在必要的地方出现（谁在哪、在做什么）。',
      '- 人物说话方式要能分辨出来：用词、句长、口头习惯不同。',
      '- 允许答非所问、打断、说半句。真实对话不总是接得上的。',
      '- 不写「他意味深长地说」这种提示语。',
    ].join('\n'),
  },
  {
    id: 'novel-first',
    mode: 'novel',
    name: '第一人称',
    desc: '贴着「我」的眼睛写，只写我知道的',
    prompt: [
      '这一段用第一人称「我」写。',
      '- 只写「我」看得到、听得到、想得到的东西。',
      '- 「我」不知道的事就是不写，不要跳到别人脑子里。',
      '- 允许「我」判断错、记错、漏掉。',
      '- 语言带上这个「我」的身份痕迹：学历、地方、年纪会影响用词。',
    ].join('\n'),
  },

  {
    id: 'novel-crowd',
    mode: 'novel',
    name: '一群人',
    desc: '场面里有好几个人，各有各的反应',
    prompt: [
      '这一章场面里人不少，按群像写。',
      '- 在场的每个人都有各自的落点：一个动作、一句话，或者一个不参与的姿势。别让大部分人站着当背景。',
      '- 反应要分人：同一件事，身份和处境不同的人反应不一样——有人往前凑，有人往后退，有人只顾自己手上那点事。',
      '- 每句话都得是这个人才会说的。两句台词对调一下要是不违和，那两句就还没写好。',
      '- 不拿一句总结代替过程：「几个人打量了他一遍」「一番盘问之后」「众人皆惊」——挑一个具体的人写他做了什么，剩下的人怎么接。',
      '- 人多不等于都要说话。有人整场只说一个「嗯」，那也是他的落点。',
      '- 视角以内写：只写视角人物能看到听到的，别人的心思靠动作和语气露出来。',
    ].join('\n'),
  },

  // 这两份是把「传统严肃文学」和「连载」两套写法各写一遍。
  // 之前插件里只有按笔法分的五份（白描/散文化/悬疑/对话/第一人称），
  // 缺一个「按用途选」的入口：写投稿的短篇和写要连载的长篇，
  // 要守的东西不一样。
  {
    id: 'novel-serious',
    mode: 'novel',
    name: '严肃短篇',
    desc: '按传统文学的标准写，能拿去投稿的那种',
    prompt: [
      '这一段按传统严肃文学的标准写。',
      '- 先想清楚这一段里谁在做什么、他为什么不肯直说，再动笔。不要用大纲代替正文。',
      '- 写不被看见的人，给他们说话的机会。不写主角光环，不炫技，不把穷和苦写成猎奇。',
      '- 情绪不要当场结清：不靠眼泪、不靠怜悯、不靠一次性的催泪。把力气放在处境、细节和后面才起作用的地方。',
      '- 用具体的动作和物写，少用形容词堆叠。不写「他感到一阵悲凉」，写他做了什么、看见什么。',
      '- 对话不加解释性提示语，少写「他愤怒地说」。',
      '- 写完自己读一遍，把硬伤改掉再交出来。',
    ].join('\n'),
  },
  {
    id: 'novel-serial',
    mode: 'novel',
    name: '连载章回',
    desc: '一章一个推进，结尾留钩子（网文节奏）',
    prompt: [
      '这一段按连载的节奏写。',
      '- 一章只推一个主事件。开头接上一章的结尾，结尾把读者的注意力留在一个未解决的问题上。',
      '- 钩子要落在具体的事上（一句话、一个动作、一件东西），不要用「他不知道，这将改变一切」这种旁白预告。',
      '- 人物按设定行动，有私心也有误会，不当工具人。他的选择要能说出理由。',
      '- 写进去的伏笔记着，到该回收的时候要回收。',
      '- 篇幅写足，不要交一千字以下的残章；不够就补细节和推进，不要注水。',
      '- 避开万能句：「嘴角勾起一抹冷笑」「不禁」「仿佛」这类一写就有的句子。',
    ].join('\n'),
  },

  // ── 文字小说游戏 ──────────────────────────────
  {
    id: 'game-detect',
    mode: 'game',
    name: '查一件事',
    desc: '找线索、拼线索，最后指认',
    prompt: [
      '你在主持一个查案的故事。',
      '- 每一轮给出一段场景，和一个正在发生的问题。',
      '- 线索要藏在具体的物和话里，不要直接给结论。',
      '- 玩家选错不会立刻死，但会让后面更难。',
      '- 至少三条线索指向真相，缺一条也能推出来但会很险。',
    ].join('\n'),
  },
  {
    id: 'game-survive',
    mode: 'game',
    name: '撑下去',
    desc: '资源有限，每天都要做取舍',
    prompt: [
      '你在主持一个求生的故事。',
      '- 给出三个能实际计数的东西：时间、体力、还有一件有限的物资。',
      '- 每个选择都要消耗其中至少一样。',
      '- 不能让玩家什么都保住，必须逼他放弃点什么。',
      '- 状态写清楚：现在还剩多少，别含糊。',
    ].join('\n'),
  },
  {
    id: 'game-growth',
    mode: 'game',
    name: '慢慢长起来',
    desc: '一段时间一段地过，看人怎么变',
    prompt: [
      '你在主持一个成长的故事。',
      '- 每一轮推进一段时间（几天、几个月），不是一个场景。',
      '- 变化体现在具体的技能、关系、处境上，不是抽象的「成长了」。',
      '- 每次给三个方向让玩家选，每个方向都有代价。',
      '- 允许失败，失败留下痕迹，不是重来一次就没了。',
    ].join('\n'),
  },
  {
    id: 'game-relation',
    mode: 'game',
    name: '人和人之间',
    desc: '看关系怎么变，没有外敌',
    prompt: [
      '你在主持一个关系的故事。',
      '- 没有外部敌人，冲突来自人和人之间说不出口的东西。',
      '- 每轮发生一件小事，让某两个人的距离变近或变远。',
      '- 玩家的选择必须是「说什么」和「不说什么」，不是打斗。',
      '- 关系有具体刻度：可以明说现在到哪一步了。',
    ].join('\n'),
  },
  {
    id: 'game-explore',
    mode: 'game',
    name: '往没去过的地方走',
    desc: '探索未知，地图一点点展开',
    prompt: [
      '你在主持一个探索的故事。',
      '- 每轮揭开一块新的地方，写清看到、听到、闻到什么。',
      '- 有危险但不滥用：不是每次进门都有怪。',
      '- 未知的部分保持未知，不要提前解释世界的设定。',
      '- 玩家身上带着的东西有限，带什么进去要付代价。',
    ].join('\n'),
  },
]

/**
 * 按玩法筛预设。
 *
 * 内置的一律补上 `book: ''` / `world: ''`：这两个字段是「这份预设挂在哪本书、
 * 哪个世界观上」，只对用户自己那份有意义。内置那份是随包发出去的模板，
 * 挂到具体某本书上会在别人机器上变成一条断引用，所以恒为空。
 * 补成空串而不是不写，是为了让调用方（界面、路由）不用到处判 undefined。
 */
export function forMode(mode) {
  const want = String(mode ?? '').trim()
  return BUILTIN.filter((p) => p.mode === want).map((p) => ({ ...p, builtin: true, book: '', world: '' }))
}

/** 找一个内置预设。 */
export function findBuiltin(id) {
  const want = String(id ?? '').trim()
  return BUILTIN.find((p) => p.id === want) ?? null
}

/** 自定义预设的文件路径。 */
export function presetRelPath(id) {
  return path.posix.join(PRESET_DIR, `${core.safeId(id)}.md`)
}

/**
 * 自定义预设的 Markdown。
 *
 * 用 Markdown 而不是 JSON：这是用户会手工改的东西，
 * 在 Finder 里双击就能看、改错一个字也不会整个文件废掉。
 *
 * `book` / `world` 是「这份预设挂在哪本书、哪个世界观上」，恒写成字符串
 * （没绑就是空串）。不写的话读回来时就得判 undefined，两边都不干净；
 * 空串在文件里也是一行 `book: ""`，用户手改时能看见有这么一个槽。
 */
export function renderPresetMarkdown(data) {
  const head = {
    lifecard: core.DATA_VERSION,
    kind: 'preset',
    ...data,
    book: String(data?.book ?? ''),
    world: String(data?.world ?? ''),
  }
  const lines = ['---']
  for (const [key, value] of Object.entries(head)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'object') continue
    lines.push(`${key}: ${JSON.stringify(String(value))}`)
  }
  lines.push('---', '', String(data?.prompt ?? '').trim(), '')
  return lines.join('\n')
}

/**
 * 读一份自定义预设。
 *
 * `book` / `world` 在这里就补成空串：老预设文件里没有这两行（这个功能是后加的），
 * 读回来是 undefined 会让界面上到处出现 undefined。缺省等于「没绑」，正好。
 */
export function parsePresetText(text) {
  const parsed = core.parseCard(String(text ?? ''))
  if (parsed.ok !== true) return { ok: false, error: '这份预设读不出来，格式不对' }
  const intro = (parsed.sections ?? []).find((s) => s.title === '_intro')
  const data = parsed.data ?? {}
  return {
    ok: true,
    data: { ...data, book: String(data?.book ?? ''), world: String(data?.world ?? '') },
    prompt: String(intro?.body ?? '').trim(),
  }
}

/** 列工作区里的自定义预设。 */
export async function listCustom(root) {
  const dir = path.join(root, PRESET_DIR)
  let names
  try {
    names = await fs.readdir(dir)
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, items: [] }
    return { ok: false, error: '预设列表读不出来，检查一下文件夹权限' }
  }
  const items = []
  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const rel = path.posix.join(PRESET_DIR, name)
    let text
    try {
      text = await fs.readFile(path.join(root, rel), 'utf8')
    } catch {
      continue
    }
    const got = parsePresetText(text)
    if (got.ok !== true) continue
    items.push({
      id: String(got.data?.id ?? name.replace(/\.md$/, '')),
      mode: String(got.data?.mode ?? 'tavern'),
      name: String(got.data?.name ?? name.replace(/\.md$/, '')),
      desc: String(got.data?.desc ?? ''),
      prompt: got.prompt,
      path: rel,
      builtin: false,
      // 这份预设挂在哪本书 / 哪个世界观上。空串 = 没挂（界面上那一排照常显示，
      // 只是没有一个是亮的）。只存 id，不存书名：书可以改名，id 不变。
      book: String(got.data?.book ?? ''),
      world: String(got.data?.world ?? ''),
    })
  }
  return { ok: true, items }
}

/**
 * 扫一遍工作区里的世界书，给「用哪个世界观」那一排用。
 *
 * 为什么在这里现扫、不去 import store：store 会连带 import 一大串东西，
 * 而这一排只需要「有哪些世界、各叫什么」。读 `worlds/<id>/world.md`
 * 的第一行 frontmatter 就够了，而且读失败不能让整个预设列表跟着废掉——
 * 预设能用而世界书坏了，用户该看到的是预设照常、那一排空着。
 *
 * @returns {Promise<Array<{ id: string, name: string }>>}
 */
export async function listWorlds(root) {
  const dir = path.join(root, 'worlds')
  let names
  try {
    names = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const entry of names) {
    if (!entry.isDirectory()) continue
    let text
    try {
      text = await fs.readFile(path.join(dir, entry.name, 'world.md'), 'utf8')
    } catch {
      continue
    }
    const parsed = core.parseCard(text)
    // 自己手写的 world.md 可能没那两行 frontmatter。这时不跳过它：
    // 用户明明建了一本世界观，界面上却「一个都没有」，他会以为文件白建了。
    // 退回第一个 `# 名字` 标题，还读不出来才跳过。
    if (parsed.ok === true) {
      out.push({
        id: String(parsed.data?.id ?? entry.name),
        name: String(parsed.data?.name ?? entry.name),
      })
      continue
    }
    const heading = text.split(/\r?\n/).map((s) => s.trim()).find((s) => s.startsWith('# '))
    if (heading === undefined) continue
    out.push({ id: entry.name, name: heading.slice(2).trim() || entry.name })
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'))
  return out
}

/**
 * 内置 + 自定义，按玩法分组；旁边再带上「能挂的书」和「能挂的世界观」。
 *
 * 为什么书要从外面传进来（`injected.books`）而不是在这里 import novel.js：
 * novel.js 和 presets.js 都是「可以单独卸掉」的模块（见 modular-test），
 * 让 presets 静态依赖 novel，卸掉 novel 时连预设也起不来。所以由调用方
 * （lib/index.js，它本来就两个都拿着）把书传进来，这边只负责拼进返回值。
 * 世界书不涉及这个顾虑（只是读文件，不 import 任何模块），就地扫。
 *
 * @param {string} root
 * @param {{ books?: Array<object> }} [injected]
 */
export async function listAll(root, injected = {}) {
  const custom = await listCustom(root)
  if (custom.ok !== true) return custom
  const out = []
  for (const mode of MODES) {
    out.push({
      mode: mode.id,
      name: mode.name,
      desc: mode.desc,
      items: [...forMode(mode.id), ...custom.items.filter((p) => p.mode === mode.id)],
    })
  }
  // 书只留界面要用的四个字段：整本元信息（idea、updated_at…）在这一排按钮上用不着。
  const books = (Array.isArray(injected?.books) ? injected.books : []).map((b) => ({
    id: String(b?.id ?? ''),
    title: String(b?.title ?? b?.id ?? ''),
    chapters: Number(b?.chapters ?? 0),
    words: Number(b?.words ?? 0),
  }))
  const worlds = await listWorlds(root)
  return { ok: true, groups: out, books, worlds }
}

/** 拿一份预设（先找自定义，再找内置）。 */
export async function resolve(root, id) {
  const want = String(id ?? '').trim()
  // 拿不到预设时给一句原因：调用方（书、会话）里记着的名字可能是旧的，
  // 而「没有预设」和「读不出来」对用户是两回事 —— 前者他不用管，
  // 后者他得去修文件。以前两种情况都只回 preset:null，界面只能一律沉默。
  if (want === '') return { ok: true, preset: null, reason: '这条记录还没选过预设。' }
  const custom = await listCustom(root)
  if (custom.ok === true) {
    const hit = custom.items.find((p) => p.id === want)
    if (hit !== undefined) return { ok: true, preset: hit }
  }
  const builtin = findBuiltin(want)
  if (builtin !== null) return { ok: true, preset: { ...builtin, builtin: true, book: '', world: '' } }
  // 找不到不报错：用户可能删了预设，但书或会话里还记着它。
  if (custom.ok !== true) {
    return { ok: true, preset: null, reason: '你的预设列表读不出来，先按没有预设来。检查一下 presets 文件夹的权限。' }
  }
  return { ok: true, preset: null, reason: `没找到叫「${want}」的预设。可能是删掉了，或者名字改了。` }
}

/** 把一份内置预设复制成自己的，可以改。 */
export async function copyBuiltin(root, id, newId) {
  const builtin = findBuiltin(id)
  if (builtin === null) return { ok: false, error: '没有这份预设' }
  const target = String(newId ?? '').trim() === '' ? `${builtin.id}-my` : String(newId).trim()
  const rel = presetRelPath(target)
  const abs = path.join(root, rel)
  await fs.mkdir(path.join(root, PRESET_DIR), { recursive: true })
  try {
    // 'wx' = 已存在就失败，不覆盖用户改过的东西
    const handle = await fs.open(abs, 'wx')
    try {
      await handle.writeFile(renderPresetMarkdown({
        id: target, mode: builtin.mode, name: `${builtin.name}（我的）`, desc: builtin.desc, prompt: builtin.prompt,
      }), 'utf8')
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error?.code === 'EEXIST') return { ok: false, error: '已经有一份同名的预设了，换个名字再复制' }
    return { ok: false, error: '这份预设没能存下来，检查一下磁盘' }
  }
  return { ok: true, id: target, path: rel }
}

/**
 * 存一份自定义预设（新建，或者显式说要覆盖时改）。
 *
 * 以前这里不管有没有同名都直接 tmp + rename，也就是**静默覆盖**：
 * 用户想建一份新的，手一滑打了个已经用过的名字，自己那份被换掉了，
 * 界面上还显示「存好了」。所以默认不覆盖 —— 要改已有那一份，
 * 调用方得明确说 `overwrite: true`。
 *
 * @param {{ id?: string, name?: string, mode?: string, desc?: string, prompt?: string, book?: string, world?: string, overwrite?: boolean }} input
 */
export async function saveCustom(root, input = {}) {
  const id = core.safeId(String(input.id ?? '').trim() === '' ? String(input.name ?? '').trim() : input.id)
  if (String(id).trim() === '') return { ok: false, error: '这份预设得有个名字' }
  if (findBuiltin(id) !== null) return { ok: false, error: '这个名字和内置的重了，换一个' }
  const rel = presetRelPath(id)
  const abs = path.join(root, rel)
  await fs.mkdir(path.join(root, PRESET_DIR), { recursive: true })
  // 覆盖保存时，没提 book/world 不能等于「解绑」：用户改提示词那一下不该把
  // 之前挑好的书、世界观一起抹掉。所以覆盖前先把旧的读出来当缺省值。
  // 显式传空串仍然是解绑——那是用户自己点的。
  let keep = { book: '', world: '' }
  if (input?.overwrite === true) {
    const old = await fs.readFile(abs, 'utf8').then(parsePresetText).catch(() => null)
    if (old !== null && old.ok === true) {
      keep = { book: String(old.data?.book ?? ''), world: String(old.data?.world ?? '') }
    }
  }
  const text = renderPresetMarkdown({
    id,
    mode: String(input.mode ?? 'tavern'),
    name: String(input.name ?? id),
    desc: String(input.desc ?? ''),
    prompt: String(input.prompt ?? ''),
    book: typeof input.book === 'string' ? input.book : keep.book,
    world: typeof input.world === 'string' ? input.world : keep.world,
  })
  if (input?.overwrite !== true) {
    // 新建：和 copyBuiltin 一样用 'wx' —— 已存在就让内核挡回来，
    // 不先 stat 再写（那中间有一段时间别人也能插进来）。
    let handle
    try {
      handle = await fs.open(abs, 'wx')
    } catch (error) {
      if (error?.code === 'EEXIST') {
        return { ok: false, error: `已经有一份叫「${id}」的预设了。换个名字，或者明确说要覆盖它再存一次` }
      }
      return { ok: false, error: '这份预设没能存下来，检查一下磁盘' }
    }
    try {
      await handle.writeFile(text, 'utf8')
    } catch {
      // 半截预设比没有更糟：解析出来是空的提示词，用起来还不报错。
      await fs.rm(abs, { force: true }).catch(() => {})
      return { ok: false, error: '这份预设没能存下来，检查一下磁盘' }
    } finally {
      await handle.close()
    }
    return { ok: true, id, path: rel }
  }
  // 覆盖：走临时文件 + 改名，中途失败不会留下半份把旧的那份挤掉。
  const tmp = `${abs}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, abs)
  } catch {
    await fs.rm(tmp, { force: true }).catch(() => {})
    return { ok: false, error: '这份预设没能存下来，检查一下磁盘' }
  }
  return { ok: true, id, path: rel }
}

/** 删一份自定义预设。内置的删不了。 */
export async function deleteCustom(root, id) {
  const want = String(id ?? '').trim()
  if (findBuiltin(want) !== null) return { ok: false, error: '内置的预设删不了' }
  try {
    await fs.unlink(path.join(root, presetRelPath(want)))
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, gone: true }
    return { ok: false, error: '这份预设没能删掉' }
  }
  return { ok: true }
}

/**
 * 把一份预设挂到某本书 / 某个世界观上。
 *
 * 为什么单独开一条路而不是走 saveCustom：绑定这件事只改两个字段，
 * 不该要求调用方把提示词整段再传一遍（传漏一个字就是把用户的预设改坏了）。
 * 传空串就是解绑——「不挂」和「挂一本不存在的书」是两件事，两者都得能表达。
 *
 * @param {string} root
 * @param {{ id?: string, book?: string, world?: string }} input
 */
export async function bindPreset(root, input = {}) {
  const want = String(input?.id ?? '').trim()
  if (want === '') return { ok: false, error: '没有说是哪一份预设' }
  // 内置那份是随包的模板，改不了：它在别人的机器上也长这样。要挂就复制一份。
  if (findBuiltin(want) !== null) return { ok: false, error: '内置的不能改，先复制一份' }
  const custom = await listCustom(root)
  if (custom.ok !== true) return custom
  const hit = custom.items.find((p) => p.id === want)
  if (hit === undefined) return { ok: false, error: '没找到这份预设，可能是删掉了' }
  const saved = await saveCustom(root, {
    id: hit.id,
    mode: hit.mode,
    name: hit.name,
    desc: hit.desc,
    prompt: hit.prompt,
    book: String(input?.book ?? ''),
    world: String(input?.world ?? ''),
    overwrite: true,
  })
  if (saved?.ok !== true) {
    return { ok: false, error: saved?.error ?? '没能改这份预设，检查一下磁盘' }
  }
  return { ok: true, id: hit.id, book: String(input?.book ?? ''), world: String(input?.world ?? '') }
}

export default {
  PRESET_DIR, MODES, BUILTIN,
  forMode, findBuiltin, presetRelPath, renderPresetMarkdown, parsePresetText,
  listCustom, listAll, listWorlds, resolve, copyBuiltin, saveCustom, deleteCustom, bindPreset,
}
