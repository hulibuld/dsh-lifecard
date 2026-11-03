/**
 * persona —— 「人物卡里哪几节进系统提示」这件事的规矩。
 *
 * 以前这件事是写死的：`buildPersonaSection` 里有一串固定的标题，卡上有哪几节就
 * 一股脑拼进系统提示。用户从网上下的卡动辄四五十 KB，除了人物设定，往往还夹着
 * 大段「你必须服从」之类的元指令；他想要的可能只是「这个人怎么说话」，却没办法
 * 只要那一部分——要么整张进去，要么一个字都不进。
 *
 * 这一层只做纯逻辑，不碰盘：给定「这张卡里真的有哪些节」和「用户勾了哪几节」，
 * 算出该拼什么、拼出来多长、哪几节被落下了。读盘、读设置、拼世界书都在
 * `index.js` 里，那边才碰得到文件。
 *
 * 三种状态沿用项目里那条老规矩，别改成别的形状：
 *   `null`（或没配过）= 用默认的那几节
 *   `[]`             = 一节都不带，这张卡整张不进系统提示
 *   `['自述', ...]`  = 只带这几节
 */

import { sectionBody } from './core.js'

/** 可以进系统提示的小节，按拼进去的顺序排。 */
export const SECTION_ORDER = [
  '自述',
  '性格',
  '外貌',
  '口癖',
  '不会说的话',
  '不会做的事',
  '场景',
  '开场白',
  '对话示例',
  '关系史',
  '备注',
]

/**
 * 没配过时带哪几节。这一串必须和以前写死的那串一模一样，一个字、一个顺序都不能差：
 * 用户升级插件时没有配过这项，行为得跟升级前一模一样，否则等于偷偷换了他的模型输入。
 */
export const DEFAULT_INCLUDE = [
  '自述',
  '性格',
  '外貌',
  '口癖',
  '不会说的话',
  '不会做的事',
  '场景',
  '开场白',
  '对话示例',
]

/**
 * 这几节走别的路，不按正文注入。
 * `世界书条目` 由 `core.parseWorldEntries` 单独解析、单独按关键词挑，
 * 当成正文再塞一遍等于同一份东西进两次。
 */
export const HANDLED_ELSEWHERE = ['世界书条目']

/** 卡上写了标题的那些小节名，按它们在文件里出现的顺序。 */
export function cardTitles(sections) {
  const out = []
  for (const one of Array.isArray(sections) ? sections : []) {
    const title = String(one?.title ?? '').trim()
    if (title !== '' && !out.includes(title)) out.push(title)
  }
  return out
}

/** 卡上真有正文的小节名（标题写了但内容空的不算）。 */
export function titlesWithBody(sections) {
  return cardTitles(sections).filter((title) => String(sectionBody(sections, title) ?? '').trim() !== '')
}

/**
 * 界面上可以勾的候选：先排认识的那几节（按注入顺序），再排卡上自己写的小节名。
 *
 * 第二半是给网上下的卡留的：它们的节名五花八门（「说话习惯」「角色设定」），
 * 只给一份固定的表，用户想勾也勾不到。走别的路那几节（世界书条目）不列进来。
 */
export function candidatesFor(sections) {
  const inCard = cardTitles(sections)
  const known = SECTION_ORDER.filter((title) => inCard.includes(title))
  const other = inCard.filter((title) => !SECTION_ORDER.includes(title) && !HANDLED_ELSEWHERE.includes(title))
  return [...known, ...other]
}

/**
 * 把设置里存的那一份（可能是 null、可能是乱七八糟的东西）收敛成一份干净的标题表。
 *
 * 认不出的标题照收不误：卡上自己写的小节名也算数，`selectBody` 只挑卡上真有的，
 * 多带的那些自然什么也拼不出来，不会造成别的影响。
 */
export function normalizeInclude(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_INCLUDE]
  const want = new Set()
  const order = []
  for (const one of raw) {
    const title = String(one ?? '').trim()
    if (title === '' || want.has(title)) continue
    want.add(title)
    order.push(title)
  }
  const known = SECTION_ORDER.filter((title) => want.has(title))
  const extra = order.filter((title) => !SECTION_ORDER.includes(title))
  return [...known, ...extra]
}

/** 这份勾选是不是「默认那一份」。没配过和显式勾了一模一样的，在界面上应当看起来一样。 */
export function isDefaultInclude(include) {
  const list = normalizeInclude(include)
  return list.length === DEFAULT_INCLUDE.length && list.every((title, i) => title === DEFAULT_INCLUDE[i])
}

/** 按勾选把正文拼出来。没勾到的节一个字都不带，节与节之间空一行。 */
export function selectBody(sections, include) {
  const list = normalizeInclude(include)
  const parts = []
  for (const title of list) {
    const body = sectionBody(sections, title)
    if (typeof body === 'string' && body.trim() !== '') parts.push(body)
  }
  return parts.join('\n\n')
}

/**
 * 给界面用的一份说明：勾了哪几节、真进去的是哪几节、哪几节落了空、卡上还有什么没勾。
 *
 * `empty` 和 `absent` 要分开说。前者是「卡上有这一节，标题写了、内容空着」（该去补内容），
 * 后者是「这张卡里根本没有这一节」（勾了也没用）——两种都回一句「没带进去」，
 * 用户会以为是自己改坏了。
 */
export function describeSelection(sections, include) {
  const list = normalizeInclude(include)
  const rawTitles = cardTitles(sections)
  const chosen = []
  const empty = []
  const absent = []
  for (const title of list) {
    if (String(sectionBody(sections, title) ?? '').trim() !== '') chosen.push(title)
    else if (rawTitles.includes(title)) empty.push(title)
    else absent.push(title)
  }
  // 「卡上有、这次没勾」的那几节。走别的路的那几节要排掉：`世界书条目` 本来就
  // 不按正文注入，把它报成「没给模型看」是在撒谎——它进了，走的是世界书那条路。
  const skipped = titlesWithBody(sections).filter((title) => !list.includes(title) && !HANDLED_ELSEWHERE.includes(title))
  const body = selectBody(sections, list)
  return {
    include: list,
    isDefault: isDefaultInclude(list),
    chosen,
    empty,
    absent,
    skipped,
    chars: body.length,
    body,
  }
}