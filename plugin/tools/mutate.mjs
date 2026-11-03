/**
 * 变异验证：把某处代码故意改坏，看说好要拦住它的那条测试红不红。
 *
 * 为什么要有这个工具：
 *   过去每一轮审查之后，都是一个个人在 /tmp 里手工拷贝、手工改一行、手工跑一遍。
 *   这件事出过两次事故——一行 `// MUTATION:` 注释被 `git add -A` 扫进了 HEAD；
 *   另一次用 `git checkout HEAD --` 回滚，把同事还没提交的改动一起带走了。
 *   而且「我变异验证过了」这句话没有留下任何凭据，下一个读代码的人只能信。
 *
 * 判据（照 0.6.4 / 0.9.3 那几条教训）：
 *   · 改坏之后测试**红了** = 那条断言真的在干活。
 *   · 改坏之后测试**还是绿的** = 这条断言等于没写（下面标成 GREEN）。
 *     这不是工具报错，是这一趟要交给你的东西。
 *   · 改坏之后测试**根本跑不起来**（连「N passed」那行都没有）= 什么也没证明，
 *     标成 BROKEN 并且算一次失败。踩过这个坑：早先脚本没把 `node_modules` 带进
 *     副本，`lib/index.js` 一 import schemastery 就炸，六个变异全「红」——
 *     全是假的。
 *
 * 用法：
 *   node tools/mutate.mjs           全部跑一遍
 *   node tools/mutate.mjs --only M7 只跑名字里带 M7 的
 *   node tools/mutate.mjs --list    只看登记了哪些
 *
 * 一律在系统临时目录里做，**绝不碰仓库**。这个文件不随包发布（不在 package.json
 * 的 files 里），它是开发时用的。
 */

import { cpSync, readFileSync, writeFileSync, rmSync, mkdtempSync, symlinkSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..')

/**
 * 登记表。每条：把 `file` 里的 `from` 改成 `to`，然后只跑 `test`。
 *
 * 写 `from` 的时候要挑**够长够独特**的一整行——太短会匹配到别处，那样改坏的不是
 * 你以为的那处，红绿都不可信。工具会检查「这段字符串在文件里出现几次」，
 * 一次都不是就直接报错，不猜。
 */
const MUTATIONS = [
  {
    name: 'M1 空数组当成「没配过」',
    file: 'lib/persona.js',
    from: 'if (!Array.isArray(raw)) return [...DEFAULT_INCLUDE]',
    to: 'if (!Array.isArray(raw) || raw.length === 0) return [...DEFAULT_INCLUDE]',
    test: 'test/persona-pick-test.mjs',
    note: '空数组 = 一节都不带，不许退回默认',
  },
  {
    name: 'M2 同步读配置永远吃缓存',
    file: 'lib/store.js',
    from: 'if (hit !== undefined && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.config',
    to: 'if (hit !== undefined) return hit.config',
    test: 'test/persona-pick-test.mjs',
    note: '改完勾选下一句就生效',
  },
  {
    name: 'M3 「没给模型看」把走别的路的也算进去',
    file: 'lib/persona.js',
    from: '!list.includes(title) && !HANDLED_ELSEWHERE.includes(title)',
    to: '!list.includes(title)',
    test: 'test/persona-pick-test.mjs',
    note: '世界书条目走世界书那条路，不许报成「没给模型看」',
  },
  {
    name: 'M4 同名节只取第一份',
    file: 'lib/persona.js',
    from: 'const body = sectionBody(sections, title)',
    to: 'const body = Array.isArray(sections) ? (sections.find((one) => String(one?.title ?? "").trim() === title)?.body ?? "") : ""',
    test: 'test/persona-pick-test.mjs',
    note: '同一节写两遍（早上一次、晚上补一次）第二份不许被吃掉',
  },
  {
    name: 'M5 勾选乱序不收敛',
    file: 'lib/persona.js',
    from: 'const known = SECTION_ORDER.filter((title) => want.has(title))',
    to: 'const known = order.filter((title) => SECTION_ORDER.includes(title))',
    test: 'test/persona-pick-test.mjs',
    note: '勾选的顺序按表收敛，不按用户点按的先后',
  },
  {
    name: 'M6 设置读不出来就崩（默认那串没了）',
    file: 'lib/persona.js',
    from: 'if (!Array.isArray(raw)) return [...DEFAULT_INCLUDE]',
    to: 'if (!Array.isArray(raw)) return []',
    test: 'test/persona-test.mjs',
    note: '读不出来一律当「没配过」',
  },
  {
    name: 'M7 没挑卡也摆「给模型看哪几节」',
    file: 'lib/client.js',
    from: "String(pinId ?? '') === ''\n        ? null\n        : h(Btn, { size: 'sm', icon: 'card', onClick: () => onOpenPersona?.(), title: '这张卡的哪几节给 AI 看——没勾的那几节，它一个字都看不到' }, '给模型看哪几节'),",
    to: "h(Btn, { size: 'sm', icon: 'card', onClick: () => onOpenPersona?.(), title: '这张卡的哪几节给 AI 看——没勾的那几节，它一个字都看不到' }, '给模型看哪几节'),",
    test: 'test/render-all.mjs',
    note: '入口不能指向一个还不存在的东西',
  },
  {
    name: 'M8 勾选框无视「现在勾没勾」',
    file: 'lib/client.js',
    from: 'checked: one.picked === true,',
    to: 'checked: true,',
    test: 'test/render-all.mjs',
    note: '勾上的那几节要真的显示成勾着的',
  },
  {
    name: 'M9 存的过程中勾得动',
    file: 'lib/client.js',
    from: 'disabled: busy,\n                    onChange',
    to: 'disabled: false,\n                    onChange',
    test: 'test/render-all.mjs',
    note: '连点两下是两次写',
  },
  {
    name: 'M10 还没挑人也摆勾选框',
    file: 'lib/client.js',
    from: "? h(Note, { tone: 'warn', icon: 'warning' },\n            `${doorName}这扇门还没挑人。先回到上一屏，在卡片右上角点一下那个圆点挑一张，再回来勾。`)",
    to: "? h('div', null, h('div', '还没挑人。'), h('input', { type: 'checkbox', checked: false, onChange: () => {} }))",
    test: 'test/render-all.mjs',
    note: '还没挑人时不能摆出一堆白勾的框',
  },
  {
    name: 'M11 一章都没有时「导出整本」还能点',
    file: 'lib/client.js',
    from: 'disabled: busy !== \'\' || chapters.length === 0, onClick: exportBook',
    to: 'disabled: busy !== \'\', onClick: exportBook',
    test: 'test/render-all.mjs',
    note: '点了只会得到一句「还一章都没有」，不如先让他看见「0 章」',
  },
]

// ── 参数 ──────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
if (argv.includes('--list')) {
  for (const m of MUTATIONS) console.log(`${m.name}  →  ${m.file}  /  ${m.test}`)
  process.exit(0)
}
const onlyIndex = argv.indexOf('--only')
const only = onlyIndex === -1 ? '' : String(argv[onlyIndex + 1] ?? '').trim()
const chosen = only === '' ? MUTATIONS : MUTATIONS.filter((m) => m.name.includes(only))
if (chosen.length === 0) {
  console.error(`没有名字带「${only}」的变异。先用 --list 看登记了哪些。`)
  process.exit(1)
}

// ── 跑 ────────────────────────────────────────────────────────────
let caught = 0
let missed = 0
let broken = 0
const missedNames = []
const brokenNames = []

for (const m of chosen) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lc-mut-'))
  try {
    // 副本里不带 node_modules，但必须软链回真仓库那份：`lib/index.js` 一 import
    // `@deepseek-ai/schemastery` 就炸，测试会在第一行死掉——那样「红了」什么也不证明。
    cpSync(SRC, dir, { recursive: true, filter: (src) => !src.includes('node_modules') && !src.includes('/.git') })
    const link = path.join(dir, 'node_modules')
    if (!existsSync(link)) symlinkSync(path.join(SRC, 'node_modules'), link)

    const abs = path.join(dir, m.file)
    if (!existsSync(abs)) {
      console.log(`BROKEN  找不到要改的文件  ${m.name}  (${m.file})`)
      broken += 1
      brokenNames.push(m.name)
      continue
    }
    const text = readFileSync(abs, 'utf8')
    const hits = text.split(m.from).length - 1
    if (hits !== 1) {
      // 匹配到零处说明登记表过时了（代码改了、这段没了）；多于一处说明这段不够独特，
      // 改坏的可能不是你以为的那一处——红绿都不可信。两种都不许蒙混过去。
      console.log(`BROKEN  这段要改的字符串出现 ${hits} 次（要正好 1 次，改登记表）  ${m.name}`)
      broken += 1
      brokenNames.push(m.name)
      continue
    }
    writeFileSync(abs, text.replace(m.from, m.to))

    const run = spawnSync(process.execPath, [m.test], { cwd: dir, encoding: 'utf8' })
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
    const line = /(\d+) passed, (\d+) failed/.exec(out)
    if (line === null) {
      console.log(`BROKEN  测试根本没跑起来（没有「N passed」那一行）  ${m.name}`)
      console.log(`        ${out.split('\n').find((l) => l.trim() !== '') ?? ''}`)
      broken += 1
      brokenNames.push(m.name)
      continue
    }
    if (run.status !== 0) {
      caught += 1
      console.log(`拦住     ${m.name}   [${line[1]} passed / ${line[2]} failed]`)
    } else {
      missed += 1
      missedNames.push(m.name)
      console.log(`没拦住   ${m.name}   ← 这条断言等于没写`)
    }
    if (m.note !== undefined) console.log(`         ${m.note}`)
    console.log(`         ${m.test}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n跑了 ${chosen.length} 处：拦住 ${caught}，没拦住 ${missed}，没跑起来 ${broken}。`)
if (missedNames.length > 0) console.log(`没拦住的是：\n  ${missedNames.join('\n  ')}`)
if (brokenNames.length > 0) console.log(`没跑起来的是（登记表要改，别当成果）：\n  ${brokenNames.join('\n  ')}`)
// 只有「没跑起来」才算这个工具自己出错。没拦住是一条结论，不是故障——
// 但它是这一趟要知道的事，所以退 0，让调用方能连着后面的活继续做。
process.exit(broken === 0 ? 0 : 1)