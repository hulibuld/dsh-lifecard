// lifecard-tools：把卡和世界书交给模型的那 5 个只读工具。
//
// 为什么值得单独测：这些工具将来是「LC 酒馆 / LC 小说 / LC 现实」三个预设
// 唯一能读到用户档案的通道。它们坏掉不会让插件起不来——宿主会静默少几个
// 工具——所以只能靠测试盯着。
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import * as tools from '../lifecard-tools.js'
import * as store from '../lib/store.js'

let pass = 0, fail = 0
const t = (n, c, x) => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, x === undefined ? '' : String(x).slice(0, 400)) } }

const root = await mkdtemp(path.join(tmpdir(), 'lc-tools-'))

/** 造一个最小工作区：一张现实里的卡、一张虚构角色、一本世界书、一份设置。 */
async function seed() {
  await mkdir(path.join(root, 'people'), { recursive: true })
  await store.writeCard(root, 'people/mama.card.md', {
    lifecard: '0.1', id: 'mama', name: '妈妈', kind: 'real', world: 'reality', relation: '母亲',
  }, [
    { title: '自述', body: '一辈子在厂里做事，手上都是茧。' },
    { title: '口癖', body: '说话前先叹一口气。' },
    { title: '不会说的话', body: '不会说「我爱你」。' },
    { title: '开场白', body: '饭在锅里，自己盛。' },
  ])
  await store.writeCard(root, 'people/lin.card.md', {
    lifecard: '0.1', id: 'lin', name: '林小雨', kind: 'fictional', world: 'w1',
  }, [
    { title: '自述', body: '海边小镇长大的女孩，说话直。' },
  ])
  await store.writeCard(root, 'worlds/w1/world.md', {
    lifecard: '0.1', id: 'w1', name: '潮汐镇', kind: 'world', world: 'reality', genre: '幻想',
  }, [
    { title: '世界书条目', body: [
      '- keys: [潮汐, 海]',
      '  content: 每天涨潮两次，潮水退下去会露出旧码头。',
      '  constant: true',
      '- keys: [灯塔]',
      '  content: 灯塔已经三十年没亮过了。',
    ].join('\n') },
  ])
  await writeFile(path.join(root, 'lifecard.config.json'), JSON.stringify({
    lifecard: '0.1',
    name: '我的档案',
    default_cards: { real: 'mama', tavern: 'lin', novel: 'lin' },
  }, null, 2) + '\n', 'utf8')
}

await seed()

/** 假装是宿主：把 ctx.tools.register 收下来，稍后直接调。 */
const registered = new Map()
tools.apply({ tools: { register: (def) => { registered.set(def.name, def) } } }, { workspace: root })

console.log('\n=== 1. 五个工具都注册上了 ===')
for (const name of ['lifecard_cards', 'lifecard_card', 'lifecard_default', 'lifecard_roleplay', 'lifecard_world']) {
  t(`注册了 ${name}`, registered.has(name))
}
t('都带 parameters（模型要知道怎么传参）', [...registered.values()].every((d) => d.parameters?.type === 'object'))
t('都有 description', [...registered.values()].every((d) => typeof d.description === 'string' && d.description.length > 10))
t('都只有一次 execute', [...registered.values()].every((d) => typeof d.execute === 'function'))

const run = async (name, args) => {
  const out = await registered.get(name).execute(args ?? {})
  return out?.text ?? ''
}

console.log('\n=== 2. lifecard_cards：列卡、按门筛 ===')
{
  const all = await run('lifecard_cards')
  t('列出妈妈和林小雨', all.includes('妈妈') && all.includes('林小雨'), all)
  t('说清是现实里的人还是虚构角色', all.includes('现实里的人') && all.includes('虚构角色'), all)
  t('带上关系', all.includes('母亲'), all)
  const fic = await run('lifecard_cards', { kind: 'fictional' })
  t('只要虚构角色时不含妈妈', fic.includes('林小雨') && !fic.includes('妈妈'), fic)
  const real = await run('lifecard_cards', { kind: 'real' })
  t('只要现实里的人时不含林小雨', real.includes('妈妈') && !real.includes('林小雨'), real)
}

console.log('\n=== 3. lifecard_card：按名字取全文 ===')
{
  const mama = await run('lifecard_card', { card: '妈妈' })
  t('取到自述', mama.includes('手上都是茧'), mama)
  t('取到口癖', mama.includes('先叹一口气'), mama)
  t('取到「不会说的话」', mama.includes('不会说「我爱你」'), mama)
  t('开头一行说清这是什么人', mama.split('\n')[0].includes('妈妈') && mama.split('\n')[0].includes('现实里的人'), mama.split('\n')[0])
  const byId = await run('lifecard_card', { card: 'lin' })
  t('按 id 也取得到', byId.includes('海边小镇'), byId)
  const missing = await run('lifecard_card', { card: '没有这个人' })
  t('找不到时说人话，不抛错', missing.includes('没找到'), missing)
}

console.log('\n=== 4. lifecard_default：三扇门各自选的谁 ===')
{
  const text = await run('lifecard_default')
  t('酒馆门说的是林小雨', /酒馆[^\n]*林小雨/.test(text), text)
  t('写小说门说的是林小雨', /写小说[^\n]*林小雨/.test(text), text)
  t('真实门说的是妈妈', /真实人物记录[^\n]*妈妈/.test(text), text)
  t('三行都点到了', text.split('\n').length >= 3, text)
}

console.log('\n=== 5. lifecard_roleplay：一次取齐 ===')
{
  const text = await run('lifecard_roleplay')
  t('默认就是酒馆门选的那张卡', text.includes('林小雨'), text.slice(0, 200))
  t('带上自述', text.includes('海边小镇'), text.slice(0, 400))
  t('带上世界书（常驻条目）', text.includes('旧码头'), text.slice(-600))
  t('世界书说的是哪一本', text.includes('潮汐镇') || text.includes('w1'), text.slice(-400))
  const named = await run('lifecard_roleplay', { card: '妈妈' })
  t('点名演谁就演谁', named.includes('妈妈') && named.includes('手上都是茧'), named.slice(0, 200))
  t('没挂世界书时说清楚', named.includes('没有挂世界书'), named.slice(-300))
  t('带上开场白', named.includes('饭在锅里'), named)
}

console.log('\n=== 6. lifecard_world：条目和触发词 ===')
{
  const text = await run('lifecard_world', { world: '潮汐镇' })
  t('列出常驻条目', text.includes('旧码头'), text)
  t('说明是每轮都带', text.includes('每轮都带上'), text)
  t('列出关键词条目', text.includes('灯塔'), text)
  t('说明什么时候带上', text.includes('说到灯塔时带上'), text)
  const missing = await run('lifecard_world', { world: '没有这本' })
  t('找不到时把人话说完并列出已有的', missing.includes('没找到') && missing.includes('潮汐镇'), missing)
}

console.log('\n=== 7. 环境不对时也不炸 ===')
{
  const empty = new Map()
  tools.apply({ tools: { register: (def) => { empty.set(def.name, def) } } }, { workspace: path.join(root, 'nope') })
  const out = await empty.get('lifecard_cards').execute({})
  t('工作区不存在时给一句话，不是异常', typeof out?.text === 'string' && out.text.length > 0, out)
}

await rm(root, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
