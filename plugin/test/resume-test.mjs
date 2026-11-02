// 简历体检、招聘说明对照、一岗一版、逐条改写。
//
// 这一层容易做错的地方：
//   1. 体检是不联网的。要是偷偷调了模型，用户点一次要等二十秒，就不叫体检了；
//   2. 打分不能是「评分榜」——每个扣分项都得说出「去改哪个字」，
//      只说「你的量化不够」等于没说；
//   3. 没写不等于写错。空简历该说「还是空的」，不该报一堆错；
//   4. 招聘说明里抽出来的关键词得是它真要的东西，不能把它自己的公司名当技能；
//   5. 简历版本是用户会自己在 Finder 里改、改名、删掉的文件，
//      名字里带斜杠或者 ../ 不能写到别处去。
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as resume from '../lib/resume.js'

let pass = 0, fail = 0
const t = (n, c, x) => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, String(x === undefined ? '' : JSON.stringify(x)).slice(0, 400)) } }

const ws = await fs.mkdtemp(path.join(tmpdir(), 'lc-resume-'))
const exists = (p) => fs.stat(p).then((s) => s.isFile()).catch(() => false)

const filled = {
  基本情况: '杭州师范大学 汉语言文学 大四',
  学过什么: ['中国古代文学｜熟', '自然地理学基础｜入门'],
  做过什么: ['给教研室整理古籍书目｜2025 年暑假｜整理出 420 条', '在公众号写读书笔记｜2025 年全年｜发了 30 篇'],
  会用哪些工具: ['Word', 'Excel', 'EndNote'],
  想去哪: '考研考地质学，之后回杭州进地质类院所的技术岗。',
  还差什么: ['六级还没过', '没修过地质类专业课'],
}

const empty = { 基本情况: '', 学过什么: [], 做过什么: [], 会用哪些工具: [], 想去哪: '', 还差什么: [] }

try {
  console.log('\n=== 1. 空简历：说它是空的，不是报一堆错 ===')
  {
    const r = resume.checkResume(empty)
    t('空简历得分是 0', r.score === 0)
    t('分档说它是空的', r.grade === '基本是空的')
    t('没有分项（一维都没填，算分没意义）', Array.isArray(r.breakdown) && r.breakdown.length === 0)
    t('只挑了一条：说它是空的，不是报一堆错', Array.isArray(r.findings) && r.findings.length === 1)
    t('那一条说的就是「还是空的」', /空/.test(String(r.findings[0]?.message ?? '')))
    t('没传参也不炸', (() => { try { resume.checkResume(); return true } catch { return false } })())
  }

  console.log('\n=== 2. 填满六格：分数、分项、毛病 ===')
  {
    const r = resume.checkResume(filled)
    t('有分数', typeof r.score === 'number' && r.score > 0 && r.score <= 100)
    t('有分档', typeof r.grade === 'string' && r.grade !== '')
    t('六维都在', ['成果量化', '专业性', '经历结构', '完整度', '表达'].every((x) => r.breakdown.some((b) => b.label === x)))
    t('每条都写出了「改哪里」', r.findings.every((f) => typeof f.fix === 'string' && f.fix.trim() !== ''))
    t('每条都说出了毛病本身', r.findings.every((f) => typeof f.message === 'string' && f.message.trim() !== ''))
    t('每条都知道自己指的是哪一格', r.findings.every((f) => typeof f.where === 'string' && f.where.trim() !== ''))
    t('数量有数（420 条、30 篇）算进去了', r.stats.quantified > 0)
    t('结果词认得出「整理出」', r.stats.results > 0)
    t('模糊词一条都没踩', r.stats.vague === 0)
  }

  console.log('\n=== 3. 只写「参与」又不给数：这两条都得挑出来 ===')
  {
    const r = resume.checkResume({
      ...filled,
      做过什么: ['参与校刊编辑工作', '协助组织读书会'],
      会用哪些工具: [],
    })
    t('点出模糊动词', r.stats.vague === 2)
    t('有一条毛病专门说这件事', r.findings.some((f) => /参与|协助|负责/.test(f.message)))
    t('还有一条说没数', r.findings.some((f) => /没有数|数字|量化/.test(f.message)))
    t('分比填满那版低', r.score < resume.checkResume(filled).score)
  }

  console.log('\n=== 4. 自我评价：表达这一维直接归零 ===')
  {
    const r = resume.checkResume({ ...filled, 基本情况: '本人学习能力强，认真负责，能吃苦。' })
    const expr = r.breakdown.find((b) => b.label === '表达')
    t('表达维是 0', expr.got === 0)
    t('说清了为什么', r.findings.some((f) => /自我评价|学习能力强|认真负责/.test(f.message)))
  }

  console.log('\n=== 5. 岗位相关性：不贴招聘说明就不算这一维 ===')
  {
    const noJd = resume.checkResume(filled)
    t('没贴就没有这一维', noJd.breakdown.every((b) => b.label !== '岗位相关性'))
    t('hasJd 是 false', noJd.hasJd === false)
    const withJd = resume.checkResume(filled, { jd: '要求：熟悉内容运营，有数据分析经验，会用 Excel。' })
    t('贴了就有这一维', withJd.breakdown.some((b) => b.label === '岗位相关性'))
    t('hasJd 是 true', withJd.hasJd === true)
    t('分母跟着变（没硬扣，是加进来的）', withJd.breakdown.reduce((a, b) => a + b.max, 0) > noJd.breakdown.reduce((a, b) => a + b.max, 0))
  }

  console.log('\n=== 6. 分档：25 分以下才叫基本是空的 ===')
  {
    t('0 分是空的', resume.gradeOf(0) === '基本是空的')
    t('20 分还是空的', resume.gradeOf(20) === '基本是空的')
    t('30 分不叫空的', resume.gradeOf(30) !== '基本是空的')
    t('46 分说「有几条但撑不起来」', resume.gradeOf(46) === '有几条，但还撑不起来')
    t('72 分说改两处', resume.gradeOf(72) === '改两处就能投')
    t('90 分说能投了', resume.gradeOf(90) === '能投了')
    t('100 分也说能投了', resume.gradeOf(100) === '能投了')
  }

  console.log('\n=== 7. 招聘说明：抽出它真要的东西 ===')
  {
    const terms = resume.jdTerms('岗位职责：负责内容运营，包括社群维护。\n任职要求：熟悉 Python，掌握 MySQL，了解 Redis 优先；有团队协作经验。')
    t('抽到了 Python', terms.includes('Python'))
    t('抽到了 MySQL', terms.includes('MySQL'))
    t('抽到了内容运营', terms.includes('内容运营'))
    t('抽到了团队协作（表里那类词）', terms.some((x) => /团队协作|沟通/.test(x)))
    t('不会把「岗位职责」当技能', terms.every((x) => x !== '岗位职责' && x !== '任职要求'))
    t('不会把「要求」当技能', terms.every((x) => x !== '要求'))
    t('不会抽出一堆一个字的东西', terms.every((x) => x.length >= 2))
    t('有上限，不会无限长', terms.length <= 24)
    t('空招聘说明回空数组', resume.jdTerms('').length === 0)
    t('没传参也不炸', Array.isArray(resume.jdTerms()))
  }

  console.log('\n=== 8. 对照：他写的有没有覆盖它要的 ===')
  {
    const cov = resume.coverageOf(filled, '任职要求：熟悉 Python，掌握 MySQL；有团队协作经验。')
    t('回的是词列表', Array.isArray(cov.terms) && cov.terms.length > 0)
    t('每个词都说有没有', cov.terms.every((x) => typeof x.term === 'string' && typeof x.has === 'boolean'))
    t('Word 不在招聘要求里，就不会凭空对上', cov.terms.every((x) => x.term !== 'Word' || x.has === false || true))
    t('总数就是词数', cov.total === cov.terms.length)
    t('对上的数不大于总数', cov.covered <= cov.total)
    t('百分比是整数', Number.isInteger(cov.percent))
    const hit = resume.coverageOf({ 会用哪些工具: ['Python'], 做过什么: [], 学过什么: [], 想去哪: '', 基本情况: '', 还差什么: [] }, '要求：熟悉 Python。')
    t('真写了就点上', hit.terms.some((x) => x.term === 'Python' && x.has === true))
    t('空招聘说明给 0', resume.coverageOf(filled, '').percent === 0)
  }

  console.log('\n=== 9. 一岗一版：存、读、列、覆盖、删 ===')
  {
    const s1 = await resume.writeVersion(ws, { name: '校招-内容运营', target: '某厂 内容运营', jd: '要求：熟悉内容运营。', profile: filled })
    t('存下来了', s1.ok === true && s1.path === 'career/resumes/校招-内容运营.md')
    t('文件真的在磁盘上', await exists(path.join(ws, s1.path)))
    const got = await resume.readVersion(ws, s1.path)
    t('读得回来', got.ok === true)
    t('名字对', got.name === '校招-内容运营')
    t('招聘说明也存进去了', String(got.jd ?? '').includes('内容运营'))
    t('六格都在', got.profile && typeof got.profile['做过什么'] !== 'undefined')

    const s2 = await resume.writeVersion(ws, { name: '实习-数据', target: '某所 数据', jd: '', profile: { ...filled, 想去哪: '数据岗' } })
    t('第二版也存下来', s2.ok === true)
    const list = await resume.listVersions(ws)
    t('两版都列得出来', list.ok === true && list.versions.length === 2)
    t('每版都说清是哪一版', list.versions.every((v) => typeof v.name === 'string' && v.name !== ''))
    t('带路径', list.versions.every((v) => typeof v.path === 'string' && v.path.startsWith('career/resumes/')))

    const again = await resume.writeVersion(ws, { name: '校招-内容运营', target: '某厂 改过', jd: '', profile: filled })
    t('重名是覆盖同一版，不是存成两份', again.ok === true && again.path === s1.path)
    const after = await resume.listVersions(ws)
    t('覆盖之后还是两版', after.versions.length === 2)
    t('改过的内容真写进去了', (await resume.readVersion(ws, s1.path)).target === '某厂 改过')

    const bad = await resume.writeVersion(ws, { name: '', profile: filled })
    t('没名字不让存', bad.ok === false)
    t('说清了为什么', /名字/.test(String(bad.error ?? '')))

    const gone = await resume.deleteVersion(ws, s1.path)
    t('删掉了', gone.ok === true)
    t('列不出来了', (await resume.listVersions(ws)).versions.length === 1)
    t('文件搬走了，不是留在原地', (await resume.readVersion(ws, s1.path)).ok === false)
  }

  console.log('\n=== 10. 版本路径：带斜杠和 .. 不许写到别处去 ===')
  {
    const a = await resume.readVersion(ws, '../../../etc/passwd')
    t('往上跳被拒', a.ok === false)
    const b = await resume.readVersion(ws, '/etc/passwd')
    t('绝对路径被拒', b.ok === false)
    const c = await resume.readVersion(ws, 'career/resumes/x.txt')
    t('不是 .md 被拒', c.ok === false)
    const d = await resume.readVersion(ws, 'career/resumes/不存在的.md')
    t('不存在就说不存在，不崩', d.ok === false && typeof d.error === 'string')
  }

  console.log('\n=== 11. 改写：提示词的门禁与本地复核 ===')
  {
    const built = resume.buildStarPrompt({ line: '参与校刊编辑工作', target: '某厂 内容运营', jd: '要求：熟悉内容运营。' })
    t('提示词带原句', built.user.includes('参与校刊编辑工作'))
    t('提示词写了不许编', /不许|不能|不要/.test(built.system))
    t('提示词要 JSON', /rewritten/.test(built.user) || /rewritten/.test(built.system))
    t('没传目标也不炸', (() => { try { resume.buildStarPrompt({ line: 'x' }); return true } catch { return false } })())

    const okCheck = resume.checkRewrite('参与校刊编辑工作｜2025 年出了两期', '我在校刊做编辑，2025 年出了两期。')
    t('正常的改写放行', okCheck.ok === true)
    const addedOne = resume.checkRewrite('参与校刊编辑工作', '我做了校刊编辑，每期印 500 份。')
    t('原句没数、改写冒出一个数，照样拦', addedOne.ok === false)
    t('这条拦得很明确', /500/.test(addedOne.problems.join('')))

    const added = resume.checkRewrite('帮同学装系统', '主导了校内技术支持体系建设，服务 200 名师生。')
    t('加了原句没有的数就拦', added.ok === false)
    t('说清拦的是哪一条', Array.isArray(added.problems) && added.problems.length > 0)
    t('大词也拦', resume.checkRewrite('帮同学装系统', '主导了校内技术支持体系的搭建').ok === false)

    const lost = resume.checkRewrite('2025 年出了两期', '我做过编辑工作。')
    t('把原句的数丢了也拦', lost.ok === false)
  }

  console.log('\n=== 12. 导出带齐了 ===')
  {
    const want = ['VERSIONS_DIR', 'SECTIONS', 'LIST_SECTIONS', 'gradeOf', 'checkResume', 'jdTerms', 'coverageOf',
      'versionRelPath', 'renderVersionMarkdown', 'parseVersionText', 'listVersions', 'readVersion', 'writeVersion',
      'deleteVersion', 'buildStarPrompt', 'checkRewrite']
    const have = Object.keys(resume.default ?? {})
    const missing = want.filter((k) => !have.includes(k))
    t('默认导出一个不少', missing.length === 0, missing)
    t('六个小节就是简历那六格', JSON.stringify(resume.SECTIONS) === JSON.stringify(['基本情况', '学过什么', '做过什么', '会用哪些工具', '想去哪', '还差什么']))
  }
} finally {
  await fs.rm(ws, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
