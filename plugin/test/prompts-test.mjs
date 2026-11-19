/**
 * 破冰提示词的回归测试。
 *
 * 这一条钉的是「一个人都还没挑的时候，模型被要求干什么」。
 * 要求本身是文字，测不出好坏；能测的是**判据还在不在**：
 * 少了「三个」它会只给一个，少了「场景」它会退回人物介绍——
 * 用户拿到一段四平八稳的自我介绍，读完没有可回的话。
 */
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as api from '../lib/index.js'
import * as store from '../lib/store.js'
import * as tavern from '../lib/tavern.js'
import * as prompts from '../lib/prompts.js'

let pass = 0, fail = 0
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400)) }
}

const P = prompts.BREAK_IN_PROMPT

console.log('=== 1. 内容判据 ===')
{
  t('有这个东西', typeof P === 'string' && P.trim() !== '', typeof P)
  t('要三个', P.includes('三个'), P.slice(0, 80))
  t('要的是「场面」，不是人物介绍', P.includes('场面'), P.slice(0, 120))
  t('三个要不一样：日常', P.includes('日常'), '')
  t('三个要不一样：冲突', P.includes('冲突'), '')
  t('三个要不一样：意外', P.includes('意外'), '')
  t('每个只写两行（不让它写小小说）', P.includes('两行'), '')
  t('要它写这个人开口的第一句话', P.includes('第一句话'), '')
  t('让用户挑一个', P.includes('挑一个'), '')
  t('不要广告腔', P.includes('广告腔') || P.includes('推销'), '')
  t('不要 A/B 选项标签', P.includes('A 选项'), '')
}

console.log('=== 2. 真的被酒馆那条路用上 ===')
{
  const here = path.dirname(fileURLToPath(import.meta.url))
  const src = await fs.readFile(path.join(here, '..', 'lib', 'index.js'), 'utf8')
  t('lib/index.js 引用了 prompts.BREAK_IN_PROMPT', src.includes('prompts.BREAK_IN_PROMPT'), '')
  // 只在没卡的时候用：有卡还端三个场面出来，等于每轮重新开局。
  t('用之前先判了没卡', /noCard === true[^\n]*\n?[^\n]*BREAK_IN_PROMPT|BREAK_IN_PROMPT[\s\S]{0,200}noCard/.test(src) || src.includes('if (noCard === true && said <= 1) return prompts.BREAK_IN_PROMPT'), '')
  t('只在第一轮用（有个「还没有真正说过话」的判据）', src.includes('said <= 1'), '')
}

console.log('=== 3. 跟别的 export 一起挂在 default 上 ===')
{
  t('default 里有 BREAK_IN_PROMPT', prompts.default.BREAK_IN_PROMPT === P, Object.keys(prompts.default))
  t('default 里原有那些还在', typeof prompts.default.SCHEMA_HINT === 'string' && Array.isArray(prompts.default.RELATION_TYPES), '')
}

console.log('=== 4. 真跑一遍：没卡的第一轮拿到的是破冰，第二轮起不是 ===')
{
  const stamp = Date.now()
  const ws = path.join(tmpdir(), 'lifecard-prompts-' + stamp)
  await fs.mkdir(ws, { recursive: true })
  await store.openWorkspace(ws, { create: true })
  const ctx = {
    webServer: { register: () => () => {} },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
    get: () => undefined,
  }
  const table = api.buildApi(ctx, async () => ws, { workspace: ws })

  // 一场没有卡的聊天（卡被删了、或者用户根本还没挑人，都会落到这个形状）。
  await tavern.writeChat(ws, 'chat-nocard', { id: 'chat-nocard', card: '', card_name: '' }, [])
  const first = await table['tavern.prompt']({ id: 'chat-nocard' })
  t('第一轮：发给模型的正是破冰那一段', first.ok === true && String(first.user).startsWith('这个人还没有。'), String(first.user ?? '').slice(0, 40))
  t('第一轮：里面要三个场面', String(first.user).includes('三个场面'), '')

  // 用户已经接了一句——这时候再端三个场面出来，等于每轮重新开局。
  await tavern.writeChat(ws, 'chat-nocard', { id: 'chat-nocard', card: '', card_name: '' }, [
    { who: '我', text: '第一个吧。' },
    { who: 'TA', text: '行，那就第一个。' },
  ])
  const later = await table['tavern.prompt']({ id: 'chat-nocard' })
  t('第二轮起不再问破冰', later.ok === true && !String(later.user).startsWith('这个人还没有。'), String(later.user ?? '').slice(0, 40))
  t('第二轮起照常请 TA 开口', String(later.user).includes('该你开口了'), String(later.user ?? '').slice(-60))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
