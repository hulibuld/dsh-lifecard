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

/** 按玩法筛预设。 */
export function forMode(mode) {
  const want = String(mode ?? '').trim()
  return BUILTIN.filter((p) => p.mode === want).map((p) => ({ ...p, builtin: true }))
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
 */
export function renderPresetMarkdown(data) {
  const head = { lifecard: core.DATA_VERSION, kind: 'preset', ...data }
  const lines = ['---']
  for (const [key, value] of Object.entries(head)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'object') continue
    lines.push(`${key}: ${JSON.stringify(String(value))}`)
  }
  lines.push('---', '', String(data?.prompt ?? '').trim(), '')
  return lines.join('\n')
}

/** 读一份自定义预设。 */
export function parsePresetText(text) {
  const parsed = core.parseCard(String(text ?? ''))
  if (parsed.ok !== true) return { ok: false, error: '这份预设读不出来，格式不对' }
  const intro = (parsed.sections ?? []).find((s) => s.title === '_intro')
  return {
    ok: true,
    data: parsed.data ?? {},
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
    })
  }
  return { ok: true, items }
}

/** 内置 + 自定义，按玩法分组。 */
export async function listAll(root) {
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
  return { ok: true, groups: out }
}

/** 拿一份预设（先找自定义，再找内置）。 */
export async function resolve(root, id) {
  const want = String(id ?? '').trim()
  if (want === '') return { ok: true, preset: null }
  const custom = await listCustom(root)
  if (custom.ok === true) {
    const hit = custom.items.find((p) => p.id === want)
    if (hit !== undefined) return { ok: true, preset: hit }
  }
  const builtin = findBuiltin(want)
  if (builtin !== null) return { ok: true, preset: { ...builtin, builtin: true } }
  // 找不到不报错：用户可能删了预设，但书或会话里还记着它。
  return { ok: true, preset: null }
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

/** 存一份自定义预设（新建或改）。 */
export async function saveCustom(root, input = {}) {
  const id = core.safeId(String(input.id ?? '').trim() === '' ? String(input.name ?? '').trim() : input.id)
  if (String(id).trim() === '') return { ok: false, error: '这份预设得有个名字' }
  if (findBuiltin(id) !== null) return { ok: false, error: '这个名字和内置的重了，换一个' }
  const rel = presetRelPath(id)
  const abs = path.join(root, rel)
  await fs.mkdir(path.join(root, PRESET_DIR), { recursive: true })
  const text = renderPresetMarkdown({
    id,
    mode: String(input.mode ?? 'tavern'),
    name: String(input.name ?? id),
    desc: String(input.desc ?? ''),
    prompt: String(input.prompt ?? ''),
  })
  const tmp = `${abs}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, abs)
  } catch {
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

export default {
  PRESET_DIR, MODES, BUILTIN,
  forMode, findBuiltin, presetRelPath, renderPresetMarkdown, parsePresetText,
  listCustom, listAll, resolve, copyBuiltin, saveCustom, deleteCustom,
}
