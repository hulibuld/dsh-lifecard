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
  const p = memory.findPeople('**爷爷**在 a 市做手艺，用旧料把父亲打进了a 中学。')
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
  const p = memory.findPeople('父亲在XXXX 公司，母亲在YYYY 公司。')
  const kins = p.map((x) => x.kin).sort()
  t('一句话里并列两个人，都要认出来', kins.includes('父亲') && kins.includes('母亲'), kins.join(','))
}
{
  const p = memory.findPeople('父亲在XXXX 公司（工程师）')
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
  t('爷爷→祖辈那套题', bank('爷爷是手艺，1960 年生。') === 'grandparent')
  t('师傅→老师那套题', bank('师傅是手艺，1930 年生。') === 'teacher')
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
