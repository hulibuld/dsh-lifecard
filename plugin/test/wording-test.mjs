/**
 * 界面上不能出现的黑话，在「后台返回给界面的那句话」里同样不能出现。
 *
 * render-all.mjs 已经扫过客户端渲染出来的文字，但它扫不到这些：
 * 后台路由的 `error` / `note` / `hint`、校验器的 `message`、打分器的 `fix`。
 * 这些字符串是直接摆到用户眼前的，而它们藏在 lib/*.js 里，
 * 客户端那条断言永远看不见它们。
 *
 * 之前的真实事故：用户点导出，界面弹出
 * 「这张卡的对象未满 18 岁（birth_year: 2015）…要留档请用「导出 JSON」」
 * —— 一句中文里塞了字段名和格式名。这条断言就是为了让这种事别再发生。
 *
 * 只看「会被显示出去」的那些键，不扫注释——注释里写 token / YAML 是给
 * 维护者看的，不是给用户看的。误报会让这条断言被人删掉，那比没有更糟。
 */
import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : String(extra).slice(0, 500)) }
}

// 和 render-all.mjs 里那份保持同一套词。那边扫界面，这边扫后台回话。
const forbidden = ['JSON', 'json', 'chunk', 'tEXt', 'CHARX', 'CCv2', 'CCv3', 'Zod', 'schema', 'YAML',
  'proposal', 'materials/', 'doctor', 'workspace', '.lifecard', 'tombstone', '墓碑', 'frontmatter']
// 路由回话（index/store）是用户点「导出」时直接看到的，字段名一个都不许露。
// core 的体检提示是数据诊断，字段名是定位用的，先不套这一层（另案处理）。
const routeForbidden = ['lens', 'kind', 'world', 'consent', 'basis', 'recorded_at', 'snapshot']

const files = ['index', 'store', 'core', 'score', 'codec', 'memory', 'jobs', 'jobs-store', 'jobs-interview']

/** 抠出「会显示给用户」的字符串字面量。只认单行，宁可漏也别误报。 */
function shownStrings(source) {
  const out = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    // { ok: false, error: '...' } / { message: '...' } / findings 的 fix / hint / reason / note
    for (const m of line.matchAll(/(?:error|message|note|hint|fix|reason)\s*:\s*(?:'([^']*)'|`([^`]*)`)/g)) {
      out.push({ line: i + 1, text: m[1] ?? m[2] })
    }
    // add('warn', '...') / add('error', '...')
    for (const m of line.matchAll(/add\(\s*'(?:warn|error|info)'\s*,\s*(?:'([^']*)'|`([^`]*)`)/g)) {
      out.push({ line: i + 1, text: m[1] ?? m[2] })
    }
  }
  return out
}

console.log('=== 1. 后台回给界面的话里没有黑话 ===')
let total = 0
for (const name of files) {
  const source = readFileSync(new URL(`../lib/${name}.js`, import.meta.url), 'utf8')
  const strings = shownStrings(source)
  total += strings.length
  const offenders = []
  for (const s of strings) {
    if (!/[\u4e00-\u9fff]/.test(s.text)) continue
    // `${...}` 里的东西是代码，不是文案——界面上看到的是它算出来的值。
    // 不剥掉的话，`${String(data.lifecard)}` 会因为字段名叫 lifecard 而误报。
    const shown = s.text.replace(/\$\{[^}]*\}/g, '')
    const words = name === 'index' || name === 'store' ? forbidden.concat(routeForbidden) : forbidden
    const bad = words.filter((w) => shown.includes(w))
    if (bad.length > 0) offenders.push(`lib/${name}.js:${s.line} [${bad.join(',')}] ${s.text.slice(0, 120)}`)
  }
  t(`lib/${name}.js 回给界面的 ${strings.length} 句话是干净的`, offenders.length === 0, offenders.join(' | '))
}
t('确实扫到了成规模的文案（不是一条都没扫到）', total > 60, `${total} 条`)

console.log('\n=== 2. 那条历史事故原话不再出现 ===')
const allText = files.map((n) => readFileSync(new URL(`../lib/${n}.js`, import.meta.url), 'utf8')).join('\n')
t('导出被拦时不再冒出 birth_year', !allText.includes('birth_year: ' + "' + String(by)"), '')
t('导出被拦时不会让人去找「导出 JSON」', !allText.includes('要留档请用「导出 JSON」'))
t('没材料时不会指着 materials/ 说话', !allText.includes('materials/ 里没有材料'))
t('删卡的成功提示里不出现墓碑和 .lifecard', !/已记墓碑/.test(allText))

console.log('\n=== 3. 界面上那句「这台机器上暂时没有可用的 AI」还在 ===')
// 换个说法可以，但必须仍然是人话：既不能说 llm / provider，也不能什么都不说。
const indexSource = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
const noAi = indexSource.match(/error: '([^']*没有可用的 AI[^']*)'/g) ?? []
t('没有 AI 时有中文提示', noAi.length >= 1, noAi)
t('提示里不出现 llm / provider', noAi.every((s) => !/llm|provider/i.test(s)))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
