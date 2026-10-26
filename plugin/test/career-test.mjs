// 简历与规划：写下去能读回来、坏文件不崩、给模型的话要带齐材料。
//
// 这一层容易做错的地方：
//   1. 简历是用户会自己在 Finder 里改的文件，格式必须经得起手改；
//   2. 一条内容里带换行或者竖线，不能把一行变成两行、把一个字段拆成两个；
//   3. 还没写简历是正常状态，不是出错；
//   4. 提示词里必须带齐他填过的东西，模型才有材料可用、才不会自己编。
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as career from '../lib/career.js'

let pass = 0, fail = 0
const t = (n, c, x) => { if (c) { pass++; console.log('  PASS', n) } else { fail++; console.log('  FAIL', n, String(x === undefined ? '' : JSON.stringify(x)).slice(0, 400)) } }

const ws = await fs.mkdtemp(path.join(tmpdir(), 'lc-career-'))
const exists = (p) => fs.stat(p).then((s) => s.isFile()).catch(() => false)

const profileData = {
  name: '林知远',
  updated_at: '2026-10-26',
  基本情况: '杭州师范大学 汉语言文学 大四\n想留在杭州。',
  学过什么: ['中国古代文学｜熟', '自然地理学基础｜入门'],
  做过什么: ['给教研室整理古籍书目｜2025 年暑假｜整理出 420 条', '在公众号写读书笔记｜2025 年全年｜发了 30 篇'],
  会用哪些工具: ['Word', 'Excel', 'EndNote'],
  想去哪: '考研考地质学，之后回杭州进地质类院所的技术岗。',
  还差什么: ['六级还没过', '没修过地质类专业课', '没有野外作业经历'],
}

const planData = {
  horizon: '1年',
  updated_at: '2026-10-26',
  终点长什么样: '2027 年 6 月拿到地质学学硕的录取通知。',
  分几步走: ['过六级｜今年 12 月｜考到 425 分以上', '补地质学基础课｜明年 3 月前｜做完两本教材的习题'],
  现在这一步: '先把六级报名报上。',
  可能会卡在哪: ['专业课没人带，容易看一半停下'],
}

try {
  console.log('\n=== 1. 路径写死在这三个常量里 ===')
  {
    t('CAREER_DIR 是 career', career.CAREER_DIR === 'career', career.CAREER_DIR)
    t('PROFILE_REL 是 career/profile.md', career.PROFILE_REL === 'career/profile.md', career.PROFILE_REL)
    t('PURPOSE_REL 是 career/purpose.md', career.PURPOSE_REL === 'career/purpose.md', career.PURPOSE_REL)
  }

  console.log('\n=== 2. 简历：写出去的形状 ===')
  {
    const text = career.renderProfileMarkdown(profileData)
    t('文件以三条横线开头', text.startsWith('---\n'), text.slice(0, 20))
    t('frontmatter 记了文件类型', text.includes('kind: career-profile'), '')
    t('frontmatter 记了姓名', text.includes('name: 林知远'), '')
    t('frontmatter 记了格式版本', /lifecard:\s*"?0\.1"?/.test(text), '')
    t('六个小节都写出来了', career.PROFILE_SECTIONS.every((s) => text.includes('## ' + s)), career.PROFILE_SECTIONS)
    t('小节顺序固定', text.indexOf('## 基本情况') < text.indexOf('## 学过什么'), '')
    t('学过什么是一行一条', text.includes('- 中国古代文学｜熟'), '')
    t('基本情况的换行原样保留', text.includes('大四\n想留在杭州'), '')
  }

  console.log('\n=== 3. 简历：写下去再读回来，字段和小节都对 ===')
  {
    const back = career.parseProfileText(career.renderProfileMarkdown(profileData))
    t('读得回来', back.ok === true, back)
    t('姓名对', back.data.name === '林知远', back.data.name)
    t('日期对', back.data.updated_at === '2026-10-26', back.data.updated_at)
    t('基本情况对', back.data.基本情况 === profileData.基本情况, back.data.基本情况)
    t('想去哪对', back.data.想去哪 === profileData.想去哪, back.data.想去哪)
    t('学过什么读回来是数组', Array.isArray(back.sections.学过什么), back.sections.学过什么)
    t('学过什么内容对', JSON.stringify(back.sections.学过什么) === JSON.stringify(profileData.学过什么), back.sections.学过什么)
    t('做过什么读回来是数组', Array.isArray(back.data.做过什么), typeof back.data.做过什么)
    t('做过什么内容对', JSON.stringify(back.data.做过什么) === JSON.stringify(profileData.做过什么), back.data.做过什么)
    t('会用哪些工具读回来是数组', JSON.stringify(back.data.会用哪些工具) === JSON.stringify(profileData.会用哪些工具), back.data.会用哪些工具)
    t('还差什么读回来是数组', JSON.stringify(back.data.还差什么) === JSON.stringify(profileData.还差什么), back.data.还差什么)
    t('sections 和 data 里的小节一致', JSON.stringify(back.sections.基本情况) === JSON.stringify(back.data.基本情况), '')
  }

  console.log('\n=== 4. 内容里带竖线和换行，不能把格式写坏 ===')
  {
    const tricky = {
      name: '林知远',
      updated_at: '2026-10-26',
      基本情况: '第一行\n第二行',
      学过什么: ['PS | PR 都会一点', 'Excel｜入门'],
      做过什么: ['写了一篇稿子\n改了三遍｜2025 秋｜发表了'],
      会用哪些工具: [],
      想去哪: '想进地质类院所',
      还差什么: ['六级没过'],
    }
    const text = career.renderProfileMarkdown(tricky)
    t('带换行的那条被记成一行', text.split('\n').filter((l) => l.startsWith('- ')).length === 4, text)
    t('换行转成了 \\n 记号', text.includes('\\n'), '')

    const back = career.parseProfileText(text)
    t('读回来还是两条课', back.data.学过什么.length === 2, back.data.学过什么)
    t('竖线原样保留', back.data.学过什么[0] === 'PS | PR 都会一点', back.data.学过什么[0])
    t('全角竖线也是内容', back.data.学过什么[1] === 'Excel｜入门', back.data.学过什么[1])
    t('一条里的换行原样还原', back.data.做过什么.length === 1 && back.data.做过什么[0].includes('\n改了三遍'), back.data.做过什么)
    t('空的小节读回来是空数组', Array.isArray(back.data.会用哪些工具) && back.data.会用哪些工具.length === 0, back.data.会用哪些工具)
    t('自由文字里的换行没丢', back.data.基本情况 === '第一行\n第二行', back.data.基本情况)
  }

  console.log('\n=== 5. 空简历也写得出来，读回来是空的不是坏的 ===')
  {
    const text = career.renderProfileMarkdown({ name: '林知远', updated_at: '2026-10-26' })
    t('空简历也写出六个标题', career.PROFILE_SECTIONS.every((s) => text.includes('## ' + s)), '')
    const back = career.parseProfileText(text)
    t('空简历读回来是 ok', back.ok === true, back)
    t('空的小节是空数组', back.ok === true && back.data.学过什么.length === 0, back.data)
    t('空的基本情况是空串', back.ok === true && back.data.基本情况 === '', back.data.基本情况)
  }

  console.log('\n=== 6. 还没写过简历：返回 null，不报错 ===')
  {
    const got = await career.readProfile(ws)
    t('没简历时 ok 是 true', got.ok === true, got)
    t('没简历时 data 是 null', got.data === null, got.data)
    t('没简历时 sections 是 null', got.sections === null, got.sections)
    const plan = await career.readPlan(ws)
    t('没规划时 ok 是 true、data 是 null', plan.ok === true && plan.data === null, plan)
  }

  console.log('\n=== 7. 文件坏了：说人话，不抛异常 ===')
  {
    const garbage = career.parseProfileText('随便一句乱码')
    t('乱码读不出来', garbage.ok === false, garbage)
    t('报错是人话', garbage.ok === false && garbage.error.includes('读不出来'), garbage.error)
    t('要求写格式不对', garbage.ok === false && garbage.error.includes('格式不对'), garbage.error)
    t('空文件也读不出来', career.parseProfileText('').ok === false, '')
    t('规划文件当简历读会被拦下', career.parseProfileText(career.renderPlanMarkdown(planData)).ok === false, '')
    t('规划乱码读不出来', career.parsePlanText('这不是规划').ok === false, '')
    t('规划空文件读不出来', career.parsePlanText('').ok === false, '')
  }

  console.log('\n=== 8. 写盘：文件确实落在 career/ 下面 ===')
  {
    const wrote = await career.writeProfile(ws, profileData)
    t('简历写得下', wrote.ok === true, wrote)
    t('返回的路径是 career/profile.md', wrote.path === 'career/profile.md', wrote.path)
    t('文件确实在 career/profile.md', await exists(path.join(ws, 'career/profile.md')), '')
    t('写的时候盖了写入日期', /^\d{4}-\d{2}-\d{2}$/.test(String(wrote.data.updated_at)), wrote.data.updated_at)

    const back = await career.readProfile(ws)
    t('读得回来', back.ok === true, back)
    t('姓名对', back.data.name === '林知远', back.data.name)
    t('课程读回来是数组', Array.isArray(back.data.学过什么) && back.data.学过什么.length === 2, back.data.学过什么)
    t('带上了文件路径', back.path === 'career/profile.md', back.path)

    // 改一条再写：覆盖，不叠加
    await career.writeProfile(ws, { ...profileData, 学过什么: ['地质学概论｜入门'] })
    const again = await career.readProfile(ws)
    t('再写一次是覆盖', again.data.学过什么.length === 1 && again.data.学过什么[0] === '地质学概论｜入门', again.data.学过什么)
  }

  console.log('\n=== 9. 规划：写下去再读回来 ===')
  {
    const text = career.renderPlanMarkdown(planData)
    t('frontmatter 记了文件类型', text.includes('kind: career-plan'), '')
    t('frontmatter 记了这段时间多长', text.includes('horizon: 1年'), '')
    t('四个小节都写出来了', career.PLAN_SECTIONS.every((s) => text.includes('## ' + s)), '')

    const back = career.parsePlanText(text)
    t('读得回来', back.ok === true, back)
    t('管多久对', back.data.horizon === '1年', back.data.horizon)
    t('终点对', back.data.终点长什么样 === planData.终点长什么样, back.data.终点长什么样)
    t('分几步走读回来是数组', Array.isArray(back.data.分几步走) && back.data.分几步走.length === 2, back.data.分几步走)
    t('步骤内容对', JSON.stringify(back.data.分几步走) === JSON.stringify(planData.分几步走), back.data.分几步走)
    t('现在这一步对', back.data.现在这一步 === planData.现在这一步, back.data.现在这一步)

    const wrote = await career.writePlan(ws, planData)
    t('规划写得下', wrote.ok === true, wrote)
    t('返回的路径是 career/purpose.md', wrote.path === 'career/purpose.md', wrote.path)
    t('文件确实在 career/purpose.md', await exists(path.join(ws, 'career/purpose.md')), '')
    const read = await career.readPlan(ws)
    t('规划读得回来', read.ok === true && read.data.horizon === '1年', read)
    t('规划里的步骤读回来还是两条', read.data.分几步走.length === 2, read.data.分几步走)
  }

  console.log('\n=== 10. 路径越界：只写 career/ 下面，外面传路径不认 ===')
  {
    const sub = path.join(ws, 'sub')
    await fs.mkdir(sub, { recursive: true })
    await career.writeProfile(sub, { name: '越界试验', 学过什么: ['测试｜入门'], path: '../越界.md', file: 'career/../越界.md' })
    t('还是写在 career/profile.md', await exists(path.join(sub, 'career', 'profile.md')), '')
    t('career/../ 那个文件没被创建', !(await exists(path.join(sub, '越界.md'))), '')
    t('上两级也没有被写到', !(await exists(path.join(ws, '越界.md'))), '')

    await fs.writeFile(path.join(sub, 'career', 'profile.md'), '随便一句乱码', 'utf8')
    const broken = await career.readProfile(sub)
    t('坏掉的简历读出来是 ok:false', broken.ok === false, broken)
    t('坏掉的简历给的是人话', broken.ok === false && broken.error.includes('读不出来'), broken.error)
  }

  console.log('\n=== 11. 写简历的提示词 ===')
  {
    const prompt = career.buildResumePrompt({ profile: profileData, target: '杭州某地质研究所 技术岗' })
    t('有 system 和 user', typeof prompt.system === 'string' && typeof prompt.user === 'string', '')
    t('system 明说不许编造', prompt.system.includes('不许编造'), '')
    t('system 不许用「负责」这种空话', prompt.system.includes('负责'), '')
    t('system 要求短句', prompt.system.includes('句子要短'), '')
    t('system 要求能量化就量化', prompt.system.includes('量化'), '')
    t('user 带上学校', prompt.user.includes('杭州师范大学'), '')
    t('user 带上课程', prompt.user.includes('中国古代文学'), '')
    t('user 带上做过的事', prompt.user.includes('整理出 420 条'), '')
    t('user 带上还差什么', prompt.user.includes('六级还没过'), '')
    t('user 带上目标', prompt.user.includes('杭州某地质研究所'), '')
    t('没填目标时也说清楚', career.buildResumePrompt({ profile: profileData }).user.includes('他没填'), '')
    t('没填材料时不崩', career.buildResumePrompt({}).system.length > 0, '')
  }

  console.log('\n=== 12. 做规划的提示词 ===')
  {
    const prompt = career.buildPathPrompt({ profile: profileData, goal: '2027 年考上地质学学硕', horizon: '1年' })
    t('user 带上目标', prompt.user.includes('2027 年考上地质学学硕'), '')
    t('user 带上管多久', prompt.user.includes('1年'), '')
    t('user 带上他的材料', prompt.user.includes('中国古代文学'), '')
    t('system 要求落到下个月', prompt.system.includes('下个月'), '')
    t('system 要求判断做完没做完', prompt.system.includes('做完没做完'), '')
    t('system 要求举例说明判断标准', prompt.system.includes('考了多少分'), '')
    t('system 不许写大词', prompt.system.includes('赋能'), '')
    t('system 要求直说矛盾', prompt.system.includes('矛盾'), '')
    t('没填目标时不崩', career.buildPathPrompt({ profile: profileData }).user.includes('他没写清楚'), '')
  }

  console.log('\n=== 13. 差异分析的提示词 ===')
  {
    const prompt = career.buildGapPrompt({ profile: profileData, target: '地质类院所 技术岗' })
    t('user 带上目标', prompt.user.includes('地质类院所'), '')
    t('user 带上他现在有的', prompt.user.includes('自然地理学基础'), '')
    t('system 要求并排', prompt.system.includes('并排'), '')
    t('system 要求缺的写最前面', prompt.system.includes('最前面'), '')
    t('system 要求具体到六级这种程度', prompt.system.includes('六级还没过'), '')
    t('system 不许评价人', prompt.system.includes('不评价他这个人'), '')
    t('没填目标时不崩', career.buildGapPrompt({ profile: profileData }).user.includes('他没填目标'), '')
  }

  console.log('\n=== 14. 从模型输出里扒步骤 ===')
  {
    const raw = [
      '## 分几步走',
      '- 过六级｜今年 12 月｜考到 425 分以上',
      '- 补地质学基础｜明年 3 月前｜做完两本教材的习题',
      '- 找一位老师写推荐信｜明年 6 月｜老师答应并写完',
      '',
      '1. 报名考研',
      '随便写点什么',
    ].join('\n')
    const steps = career.parseSteps(raw)
    t('认出三条带竖线的步骤', steps.length === 4, steps)
    t('步骤内容对', steps[0].text === '过六级', steps[0])
    t('时间对', steps[0].when === '今年 12 月', steps[0])
    t('完成标准对', steps[0].done === '考到 425 分以上', steps[0])
    t('第二条也在', steps[1].text === '补地质学基础', steps[1])
    t('编号行也认', steps[3].text === '报名考研', steps[3])
    t('编号行没写时间', steps[3].when === '', steps[3])
    t('没有把小节标题当步骤', steps.every((s) => !s.text.includes('分几步走')), '')
    t('没把乱写的行当步骤', steps.every((s) => s.text !== '随便写点什么'), '')

    const oneField = career.parseSteps('- 只写了做什么')
    t('只写一段也认，另外两段是空串', oneField.length === 1 && oneField[0].text === '只写了做什么' && oneField[0].when === '' && oneField[0].done === '', oneField)

    const ascii = career.parseSteps('- 做 A | 下个月 | 交三篇')
    t('半角竖线也认', ascii.length === 1 && ascii[0].text === '做 A' && ascii[0].done === '交三篇', ascii)

    const chinese = career.parseSteps('第一步：把六级报上名')
    t('「第一步」这种写法也认', chinese.length === 1 && chinese[0].text === '把六级报上名', chinese)

    t('满篇乱码返回空数组', career.parseSteps('胡写一通\n没有步骤。').length === 0, career.parseSteps('胡写一通\n没有步骤。'))
    t('空字符串返回空数组', career.parseSteps('').length === 0, '')
    t('没传内容也不炸', career.parseSteps(undefined).length === 0, '')
  }

  console.log('\n=== 15. 默认导出带齐了要给的函数 ===')
  {
    const want = [
      'CAREER_DIR', 'PROFILE_REL', 'PURPOSE_REL',
      'renderProfileMarkdown', 'parseProfileText', 'renderPlanMarkdown', 'parsePlanText',
      'readProfile', 'writeProfile', 'readPlan', 'writePlan',
      'buildResumePrompt', 'buildPathPrompt', 'buildGapPrompt', 'parseSteps',
    ]
    t('15 个名字都在默认导出里', want.every((k) => career.default[k] !== undefined), want.filter((k) => career.default[k] === undefined))
    t('默认导出里没有多余的东西', Object.keys(career.default).length === want.length, Object.keys(career.default))
  }
} finally {
  await fs.rm(ws, { recursive: true, force: true }).catch(() => {})
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
