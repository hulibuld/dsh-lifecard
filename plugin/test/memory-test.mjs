/**
 * 记忆提取测试。
 *
 * 这一层的风险不在「能不能提出来」，而在「提错了」。错认一个人名比没有更糟：
 * 用户会以为软件认识他爸。所以这里的断言大多是**否定**的——
 * 「这句里没人」「这个人没名字」「这行不该被当成名字」。
 */

import * as memory from '../lib/memory.js'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import os from 'node:os'

let pass = 0
let fail = 0
const t = (name, cond, extra) => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name}${extra === undefined ? '' : ` — ${extra}`}`) }
}

console.log('\n记忆提取')

// ── 1. 认人 ──────────────────────────────────────────────
{
  const p = memory.findPeople('**父亲＝张三**，1970 年生。')
  t('等号写法认得出人', p.length === 1 && p[0].name === '张三')
  t('关系词也带出来了', p[0].kin === '父亲')
}
{
  const p = memory.findPeople('**爷爷**在 a 市做手艺。')
  t('加粗包住的关系词认得出', p.length >= 1 && p[0].kin === '爷爷')
  t('爷爷没有名字时不瞎编', p[0].name === '')
}
{
  const p = memory.findPeople('师傅王先生只收过父亲一个徒弟。')
  t('关系词后粘名字能认', p.some((x) => x.kin === '师傅' && x.name === '王先生'))
}
{
  // 这句里「奶奶」只是「爷爷奶奶家」的一部分，不是另一个人
  const p = memory.findPeople('**爷爷**现身体还好，住爷爷奶奶家（离用户家一公里）。')
  const kins = p.map((x) => x.kin)
  t('「住爷爷奶奶家」不算又认出个奶奶', !kins.includes('奶奶'), kins.join(','))
}
{
  const p = memory.findPeople('父亲在 XXXX 公司，母亲在 YYYY 公司。')
  const kins = p.map((x) => x.kin).sort()
  t('一句话里并列两个人，都要认出来', kins.includes('父亲') && kins.includes('母亲'), kins.join(','))
}
{
  const p = memory.findPeople('父亲在 XXXX 公司（工程师）')
  t('「父亲在浙江」不把「在浙江」当人名', p.every((x) => x.name === ''))
}

// ── 2. 非人 ──────────────────────────────────────────────
{
  t('没有关系词的行不算人', memory.findPeople('今天想去外地。').length === 0)
  t('空文本不算人', memory.findPeople('').length === 0)
  t('只提职业不提关系，不算', memory.findPeople('他是工程师。').length === 0)
}

// ── 3. 合并与去重 ────────────────────────────────────────
{
  const p = memory.findPeople('父亲在b 市。父亲＝张三。父亲是教授。')
  const fathers = p.filter((x) => x.kin === '父亲')
  t('同一个人不重复出现', fathers.length === 1, `出现 ${fathers.length} 次`)
  t('后文出现的名字归并到同一条', fathers[0].name === '张三')
  t('归并后句子都留着', fathers[0].lines.length >= 2)
}

// ── 4. 缺什么 ────────────────────────────────────────────
{
  const p = memory.findPeople('母亲在 YYYY 公司上班。')[0]
  t('没名字就标缺名字', p.missing.includes('名字'))
  t('没出生时间就标出来', p.missing.includes('出生时间'))
  const q = memory.findPeople('父亲＝张三，1970 年生，在 XXXX 公司上班。')[0]
  t('信息齐了就不标缺', q.missing.length === 0, q.missing.join(','))
}

// ── 5. 归到题库 ──────────────────────────────────────────
{
  const bank = (s) => memory.findPeople(s)[0]?.bank
  t('父亲→父母那套题', bank('父亲＝张三，1970 年生。') === 'parent')
  t('爷爷→祖辈那套题', bank('爷爷是手艺人，1970 年生。') === 'grandparent')
  t('师傅→老师那套题', bank('师傅是手艺人，1970 年生。') === 'teacher')
  t('姐姐→兄弟姐妹那套题', bank('姐姐是医生，1998 年生。') === 'sibling')
}

// ── 6. 材料渲染 ──────────────────────────────────────────
{
  const people = memory.findPeople('父亲＝张三，1970 年生，在 XXXX 公司上班。母亲在 YYYY 公司上班。')
  const md = memory.renderMemoryMaterial(people, { read_at: '2026-10-20' })
  t('材料有大标题', md.includes('# 从记忆里认出来的人'))
  t('材料写明只有提到过的句子', md.includes('只有提到过的句子'))
  t('材料带摘录时间', md.includes('2026-10-20'))
  t('每个人一个二级标题', (md.match(/^## /gm) ?? []).length === people.length)
  t('缺东西的人标出还缺什么', md.includes('还缺'))
  t('没名字的人用关系词当标题', md.includes('## 母亲'))
}

// ── 6b. 一人一份材料 ─────────────────────────────────────
// 一人一份是为了隔离：AI 读父亲那份时，手上不该有爷爷的句子。
// 混在一起写出来的卡，最容易出现「把爷爷的手艺安到父亲头上」。
{
  const people = memory.findPeopleIn([
    { label: '本机记忆', text: '父亲＝张三，1970 年生，在 XXXX 公司上班。母亲在 YYYY 公司。爷爷是手艺人，身体还好。' },
  ])
  const father = people.find((p) => p.name === '张三')
  const one = memory.renderPersonMaterial(father, { read_at: '2026-10-20' })
  t('一个人的材料有自己的标题', one.includes('# 父亲：张三'))
  t('只写一个人（没有别人的名字）', !one.includes('爷爷'))
  t('写明了只有提到过他的句子', one.includes('只有提到过他的句子'))
  t('带摘录时间', one.includes('2026-10-20'))
  t('有自己的原话小标题', one.includes('## 提到他的原话'))
  t('原话是引用块', one.includes('\n> '))
  // 逐字保留：AI 说的每句都要能指回这些原话，改一个字就指不回去了。
  t('原话逐字留在材料里', one.includes('1970 年生'))
  t('来自哪几个文件也说清了', one.includes('来自：'))

  const mother = people.find((p) => p.kin === '母亲')
  if (mother === undefined) {
    t('母亲被认出来了（构造用）', false)
  } else {
    const another = memory.renderPersonMaterial(mother)
    t('缺东西的人材料里单列一栏', another.includes('## 还缺什么'))
    t('说清还缺哪几样', another.includes('没写到'))
    t('不缺的人不出现这一栏', !one.includes('## 还缺什么'))
    t('没给时间时不留空括号', !another.includes('摘录时间：undefined'))
  }
  t('空人也能渲染（不崩）', typeof memory.renderPersonMaterial({ kin: '某人', name: '', lines: [], missing: [] }) === 'string')
}

// ── 7. 读文件 ────────────────────────────────────────────
{
  const root = path.join(tmpdir(), 'lc-mem-' + Date.now())
  await fs.mkdir(path.join(root, 'runtime'), { recursive: true })
  await fs.writeFile(path.join(root, 'runtime', 'USER.md'), '父亲＝张三，1970 年生。', 'utf8')
  const got = await memory.readMemory({ HOME: '/nonexistent-xyz', MNEMON_DATA_DIR: root })
  t('按 MNEMON_DATA_DIR 找得到', got.found === true)
  t('读到了正文', got.text.includes('张三'))
  t('记下了找到几个文件', got.files.length === 1)
  await fs.rm(root, { recursive: true, force: true })
}
{
  const got = await memory.readMemory({ HOME: '/definitely-not-here-' + Date.now() })
  t('找不到时如实说找不到', got.found === false)
  t('找不到时正文是空的', got.text === '')
}
{
  // 记忆文件是空的，等于没有
  const root = path.join(tmpdir(), 'lc-mem-empty-' + Date.now())
  await fs.mkdir(path.join(root, 'runtime'), { recursive: true })
  await fs.writeFile(path.join(root, 'runtime', 'USER.md'), '   \n', 'utf8')
  const got = await memory.readMemory({ HOME: '/nope-xyz', MNEMON_DATA_DIR: root })
  t('空文件不算找到', got.found === false)
  await fs.rm(root, { recursive: true, force: true })
}

// ── 7b. 红点开关（同名不同关系） ────────────────────────────────
{
  const { tmpdir: tdir } = await import('node:os')
  const store = await import('../lib/store.js')
  const root = path.join(tdir(), 'lc-memst-' + Date.now())
  await store.openWorkspace(root, { create: true })
  await store.rememberMemoryPeople(root, [
    { kin: '父亲', name: '张三', missing: [] },
    { kin: '朋友', name: '张三', missing: ['出生时间'] },
    { kin: '母亲', name: '李四', missing: ['名字', '出生时间'] },
  ])
  const st = (name, relation) => store.memoryStatusOf(root, { name, relation })

  t('关系对上才认人（张三/朋友）', (await st('张三', '朋友')).missing.includes('出生时间'))
  t('同名但关系对不上，不认', (await st('张三', '同事')).from_memory === false)
  t('信息齐的不亮红点', (await st('张三', '父亲')).flag === false)
  // 只有一个同名的人时，关系改个说法也还认得出来
  t('关系改说法仍认得出（李四/妈）', (await st('李四', '妈')).flag === true)
  t('没记过的人绝不亮红点', (await st('王先生', '朋友')).flag === false)
  t('没名字不亮红点', (await st('', '朋友')).flag === false)
  await fs.rm(root, { recursive: true, force: true })
}

// ── 7c. 散文里认人：严格模式（项目档案走这一路） ────────────────
//
// 记忆文件是短句，「父亲＝张三」写得清清楚楚。
// 项目档案是散文，满篇「父亲关系」「奶奶家吃饭」「父亲手里」——
// 用同一把尺子会认出一堆叫「关系」「家吃饭」「手里」的人。
{
  // 每一行都停在一个「看起来像名字」的词上——这正是真实档案里的样子：
  // 换行、标点把关系词和后面那串字隔开，粘人名的正则就以为捡到宝了。
  const prose = [
    '那几年父亲关系',
    '在奶奶家吃饭',
    '父亲手里拿着个碗',
    '父亲那篇稿子收了',
    '导师组副教授也来了',
  ].join('\n')

  // 不严格：这是记忆文件走的路径，散文上会误判
  const loose = memory.findPeople(prose)
  t('不严格时，散文里会误判出名字（对照，说明为什么需要严格模式）',
    loose.some((p) => p.name !== ''), JSON.stringify(loose.map((p) => p.name)))

  // 严格：关系词后面粘着的那串字不再当名字
  const strict = memory.findPeople(prose, true)
  t('严格模式下认不出「关系」', !strict.some((p) => p.name === '关系'))
  t('严格模式下认不出「家吃饭」', !strict.some((p) => p.name === '家吃饭'))
  t('严格模式下认不出「手里」', !strict.some((p) => p.name === '手里'))
  t('严格模式下认不出「那篇」', !strict.some((p) => p.name === '那篇'))
  t('严格模式下认不出「组副教授」', !strict.some((p) => p.name.includes('副教授')))

  // 但真正写清名字的两种写法，严格模式下照样认得出来
  const clear = '父亲＝张三。师傅王先生只收过父亲一个徒弟。'
  const clearHits = memory.findPeople(clear, true)
  t('严格模式下等号写法照样认得出', clearHits.some((p) => p.name === '张三'))
  t('严格模式下带称呼的写法照样认得出', clearHits.some((p) => p.name === '王先生'))

  // 严格模式下裸的关系词（没名没姓）仍然认，只是名字为空
  const bare = memory.findPeople('父亲在 XXXX 公司。', true)
  t('严格模式下裸的关系词还认（名字留空）', bare.some((p) => p.kin === '父亲' && p.name === ''))
}

// ── 7d. 多来源合并：档案只补充你已经写过的人，不凭空造人 ────────────
{
  const sources = [
    { label: '本机记忆', text: '父亲＝张三。爷爷在 a 市做手艺。' },
    { label: '某份档案', text: '父亲关系不好。爷爷的手艺很好。老师那天也在。', strict: true },
  ]
  const people = memory.findPeopleIn(sources)
  const father = people.find((p) => p.kin === '父亲')
  t('记忆里写过的人，档案里的句子会并进来', father !== undefined && father.lines.length >= 2)
  t('并进来之后名字还在', father?.name === '张三')
  t('两份来源都记上了', (father?.sources ?? []).length === 2)
  t('记忆里没有、档案里只说「老师」的，不凭空造一个人',
    !people.some((p) => p.kin === '老师'))
  t('档案里那个「关系」没被当成人名', !people.some((p) => p.name === '关系'))

  // 档案里写清了名字的，仍然要认——那可能正是记忆里没记全的人
  const sources2 = [
    { label: '本机记忆', text: '父亲＝张三。' },
    { label: '某份档案', text: '老师＝王建国。', strict: true },
  ]
  t('档案里用等号写清名字的新人，认得出来',
    memory.findPeopleIn(sources2).some((p) => p.name === '王建国'))

  // 反过来：关系词不在表里的（表哥、二舅、发小），一律不认。
  // 宁可漏掉一个真实存在的人，也不要在列表里摆一个来历不明的空壳——
  // 用户点进去发现什么都没有，比少一个人更伤。
  const sources3 = [
    { label: '本机记忆', text: '父亲＝张三。' },
    { label: '某份档案', text: '表哥＝周立。', strict: true },
  ]
  t('关系词表里没有的称呼（表哥）不认', !memory.findPeopleIn(sources3).some((p) => p.name === '周立'))
}

// ── 8. 守「不联网、不调模型」 ────────────────────────────
{
  const src = await fs.readFile(new URL('../lib/memory.js', import.meta.url), 'utf8')
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  t('只 import 了 node 自带模块', imports.every((i) => i.startsWith('node:')), imports.join(','))
  t('没有 fetch', !/\bfetch\s*\(/.test(src))
  t('不调模型', !/callModel|ctx\.llm/.test(src))
  t('不写任何文件（只读记忆）', !/fs\.writeFile|fs\.write|appendFile/.test(src))
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
