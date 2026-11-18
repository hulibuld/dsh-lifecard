/**
 * cast.js 的测试：拆书——把一本书拆成角色卡和世界书。
 *
 * 要验的三件事：
 *   1. 用户填的名单能被正确切开（分隔符他爱怎么写就怎么写）
 *   2. 模型乱写的输出还能被认出来（`## 人物：`、`**张三**`、`性格特点`、「未知」）
 *   3. 交出去的形状是 writeCard 直接能吃的——字段缺一个，整张卡就写不进去
 */

import * as cast from '../lib/cast.js'

let pass = 0
let fail = 0
const t = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  PASS ${name}`) }
  else { fail += 1; console.log(`  FAIL ${name}${detail === '' ? '' : `  ← ${detail}`}`) }
}

console.log('\n=== 1. parseCastNames：分隔符 / 去重 / 上限 ===')
{
  const a = cast.parseCastNames('张三，李四、王五\n赵六 钱七')
  t('四种分隔符都认', a.ok && a.names.length === 5, JSON.stringify(a.names))
  t('中文逗号切开', cast.parseCastNames('张三，李四').names.join('|') === '张三|李四')
  t('顿号切开', cast.parseCastNames('张三、李四').names.join('|') === '张三|李四')
  t('换行切开', cast.parseCastNames('张三\n李四').names.join('|') === '张三|李四')
  t('空格切开', cast.parseCastNames('张三 李四').names.join('|') === '张三|李四')

  const dup = cast.parseCastNames('张三，李四，张三')
  t('重复的只留一次', dup.names.join('|') === '张三|李四', JSON.stringify(dup.names))
  t('重复不算截断', dup.truncated === false)

  const many = cast.parseCastNames('一、二、三、四、五、六、七、八、九、十')
  t('超过 8 个截断到 8', many.names.length === cast.MAX_CAST, String(many.names.length))
  t('截断时 truncated 为 true', many.truncated === true)
  t('截断时留下前 8 个', many.names[0] === '一' && many.names[7] === '八')

  const empty = cast.parseCastNames('   ')
  t('空输入 ok:false', empty.ok === false)
  t('空输入 names 是空数组', empty.names.length === 0)
  t('空输入带一句能看懂的话', typeof empty.error === 'string' && empty.error.length > 0)
  t('null 进来也不炸', cast.parseCastNames(null).ok === false)
}

console.log('\n=== 2. buildCastPrompt：判据 / 名单 / 省略 ===')
{
  const p = cast.buildCastPrompt({ bookTitle: '长夜', names: ['张三', '李四'], text: '张三推开门。' })
  t('system 写了「不知道的留空」', p.system.includes('不知道的留空'))
  t('system 写了不写形容词', p.system.includes('不写形容词'))
  t('system 写了只拆点名的人', p.system.includes('名单外的人一个字都不写'))
  t('system 写了「未知」不许占位', p.system.includes('「未知」'))
  t('system 写了引文必须是原句', p.system.includes('必须是原文原句'))
  t('system 给了输出格式', p.system.includes('## 人物：<名字>') && p.system.includes('### 自述'))
  t('user 里有书名', p.user.includes('《长夜》'))
  t('user 里有名单', p.user.includes('张三') && p.user.includes('李四'))
  t('user 里有原文', p.user.includes('张三推开门。'))

  const big = '甲'.repeat(40000)
  const bp = cast.buildCastPrompt({ names: ['张三'], text: big })
  t('超长原文有省略标记', bp.user.includes('（中间省略）'))
  t('超长原文被压到 4 万以内', bp.user.length < 40000, String(bp.user.length))
  t('超长原文保留了开头', bp.user.includes('甲'.repeat(10)))
  // 掐头去尾：尾巴那截也得在，不然只能拆到书的前半段
  t('超长原文也保留结尾', bp.user.trimEnd().endsWith('甲'))

  const short = cast.buildCastPrompt({ names: ['张三'], text: '很短的一段。' })
  t('没超长就不加省略标记', !short.user.includes('（中间省略）'))
}

console.log('\n=== 3. parseCastResult：容错 ===')
{
  const text = [
    '## 人物：张三',
    '### 自述',
    '他是码头的记账人，想把妹妹送出去，被一笔旧账挡着。',
    '### 性格',
    '别人说完话他先看门口。',
    '### 外貌',
    '### 口癖',
    '「我记着了。」',
    '### 不会说的话',
    '不说软话。',
    '### 不会做的事',
    '不替人担保。',
    '### 关系史',
    '李四欠他一袋米。',
    '',
    '## 人物：李四',
    '### 自述',
    '跑船的。',
    '### 性格',
    '钱放桌上他先数一遍。',
    '### 外貌',
    '未知',
    '### 口癖',
    '暂无',
    '### 不会说的话',
    '—',
    '### 不会做的事',
    '',
    '### 关系史',
    '张三救过他一回。',
  ].join('\n')
  const r = cast.parseCastResult(text, ['张三', '李四'])
  t('两个人', r.ok && r.people.length === 2, String(r.people.length))
  t('第一个人名字对', r.people[0].name === '张三')
  t('自述进了对应那一节', r.people[0].sections.find((s) => s.title === '自述').body.includes('记账人'))
  t('七节都在', r.people[0].sections.length === cast.CAST_SECTIONS.length)
  t('空的外貌是空串', r.people[0].sections.find((s) => s.title === '外貌').body === '')
  t('没有 dropped', r.dropped.length === 0)

  // 「未知」「暂无」「—」都当空：它们会跟着这张卡一辈子
  const li = r.people[1]
  t('「未知」当空', li.sections.find((s) => s.title === '外貌').body === '')
  t('「暂无」当空', li.sections.find((s) => s.title === '口癖').body === '')
  t('「—」当空', li.sections.find((s) => s.title === '不会说的话').body === '')

  // 名单外的人
  const extra = cast.parseCastResult('## 人物：张三\n### 自述\n记账人。\n\n## 人物：王五\n### 自述\n路人。', ['张三'])
  t('名单外的人被丢掉', extra.people.length === 1)
  t('丢掉的名字记在 dropped 里', extra.dropped.includes('王五'), JSON.stringify(extra.dropped))

  // 模糊匹配
  const fuzzy = cast.parseCastResult('## 张三\n### 性格特点\n他先看门口。\n### 说话习惯\n「我记着了。」', ['张三'])
  t('「性格特点」匹到性格', fuzzy.people[0].sections.find((s) => s.title === '性格').body.includes('先看门口'))
  t('「说话习惯」匹到口癖', fuzzy.people[0].sections.find((s) => s.title === '口癖').body.includes('我记着了'))

  // 其它写法
  const alt = cast.parseCastResult('**张三**\n**自述**\n记账人。\n自述：也有人说他是先生。', ['张三'])
  t('**名字** 认', alt.people.length === 1 && alt.people[0].name === '张三')
  t('**小节** 认', alt.people[0].sections.find((s) => s.title === '自述').body.includes('记账人'))
  const hash = cast.parseCastResult('# 李四\n### 自述\n跑船的。', ['李四'])
  t('# 名字 认', hash.people.length === 1 && hash.people[0].name === '李四')

  // 超长自述
  const long = cast.parseCastResult(`## 张三\n### 自述\n${'甲'.repeat(5000)}`, ['张三'])
  const body = long.people[0].sections.find((s) => s.title === '自述').body
  t('超长自述被截断', body.length === cast.MAX_PERSONA_CHARS, String(body.length))
  t('截断时标 truncated', long.truncated === true)

  // 一段都没拆出来
  const none = cast.parseCastResult('这里什么都没有。', ['张三'])
  t('拆不出人时 ok:false', none.ok === false)
}

console.log('\n=== 4. buildWorldPrompt / parseWorldResult ===')
{
  const p = cast.buildWorldPrompt({ bookTitle: '长夜', text: '北边有个码头。' })
  t('world system 写了拆什么', p.system.includes('地方、规矩、势力、时间线、物件、称呼'))
  t('world system 要求触发词', p.system.includes('2–6 个触发词'))
  t('world system 给了格式', p.system.includes('## <条目标题>') && p.system.includes('触发词：'))
  t('world system 写了条数上限', p.system.includes(String(cast.MAX_WORLD_ENTRIES)))
  t('world user 里有书名', p.user.includes('《长夜》'))
  t('world user 里有原文', p.user.includes('北边有个码头。'))

  const text = [
    '## 北洋码头',
    '触发词：码头、北洋、卸货',
    '一年里有一半时间在下雪，船靠岸要等冰化。',
    '',
    '## 记账规矩',
    '触发词：账本，欠条，利息',
    '所有赊账记在蓝皮本上，年底算一次。',
    '',
    '## 老盐仓',
    '触发词：盐仓 仓门 钥匙',
    '仓门只有两把钥匙，一把在张家。',
  ].join('\n')
  const w = cast.parseWorldResult(text)
  t('三条', w.ok && w.entries.length === 3, String(w.entries.length))
  t('标题对', w.entries[0].title === '北洋码头')
  t('顿号分隔的触发词', w.entries[0].keys.join('|') === '码头|北洋|卸货', JSON.stringify(w.entries[0].keys))
  t('中文逗号分隔的触发词', w.entries[1].keys.join('|') === '账本|欠条|利息', JSON.stringify(w.entries[1].keys))
  t('空格分隔的触发词', w.entries[2].keys.join('|') === '盐仓|仓门|钥匙', JSON.stringify(w.entries[2].keys))
  t('正文里不含触发词那一行', !w.entries[0].content.includes('触发词'))
  t('正文对', w.entries[0].content.includes('下雪'))

  const noKeys = cast.parseWorldResult('## 天气\n一年下六个月雪。')
  t('没触发词用标题兜底', noKeys.entries[0].keys.join('|') === '天气', JSON.stringify(noKeys.entries[0].keys))

  const bold = cast.parseWorldResult('**码头**\n触发词：卸货\n一年有一半在下雪。')
  t('**标题** 认', bold.entries.length === 1 && bold.entries[0].title === '码头')

  const many = Array.from({ length: 45 }, (_, i) => `## 条${i + 1}\n触发词：k${i + 1}\n正文。`).join('\n\n')
  const mw = cast.parseWorldResult(many)
  t('超 40 条截断到 40', mw.entries.length === cast.MAX_WORLD_ENTRIES, String(mw.entries.length))
  t('截断时标 truncated', mw.truncated === true)

  const nw = cast.parseWorldResult('没有标题的一段话。')
  t('拆不出条目时 ok:false', nw.ok === false)
}

console.log('\n=== 5. toCardShape：writeCard 能直接吃 ===')
{
  const person = {
    name: '张三',
    sections: [
      { title: '自述', body: '记账人。' },
      { title: '性格', body: '先看门口。' },
      { title: '不会说的话', body: '不说软话。' },
    ],
  }
  const shape = cast.toCardShape(person)
  t('返回 data 与 sections', shape.data !== undefined && Array.isArray(shape.sections))
  t('sections 长度等于 CAST_SECTIONS', shape.sections.length === cast.CAST_SECTIONS.length, String(shape.sections.length))
  t('sections 顺序对', shape.sections.map((s) => s.title).join('|') === cast.CAST_SECTIONS.join('|'))
  const missing = shape.sections.find((s) => s.title === '关系史')
  t('缺的节是空串不是 undefined', missing !== undefined && missing.body === '', String(missing?.body))
  t('data.name 对', shape.data.name === '张三')
  t('data.kind 是 fictional', shape.data.kind === 'fictional')
  // validateCard 对 fictional 要 lifecard / id / kind / name / world，缺一个整张卡写不进去
  for (const key of ['lifecard', 'id', 'kind', 'name', 'world']) {
    t(`data 有 ${key}`, shape.data[key] !== undefined && String(shape.data[key]) !== '')
  }
  t('id 是安全文件名', shape.data.id === '张三', shape.data.id)

  // 同名小节被写了两遍要并起来，不能只留最后一份
  const twice = cast.toCardShape({ name: '李四', sections: [{ title: '自述', body: '上' }, { title: '自述', body: '下' }] })
  t('同名小节被并起来', twice.sections.find((s) => s.title === '自述').body.includes('上') && twice.sections.find((s) => s.title === '自述').body.includes('下'))

  // 名字里的标点不能把文件名切坏
  const odd = cast.toCardShape({ name: '张/三', sections: [] })
  t('名字里的斜杠被打平', !odd.data.id.includes('/'), odd.data.id)
}

console.log('\n=== 6. castRelPath：落盘位置 ===')
{
  t('形状对', cast.castRelPath('b1', '张三') === 'books/b1/cast/张三.md', cast.castRelPath('b1', '张三'))
  t('带 / 的名字被打平', cast.castRelPath('b1', '张/三') === 'books/b1/cast/张-三.md', cast.castRelPath('b1', '张/三'))
  t('带 ../ 的名字出不去', !cast.castRelPath('b1', '../x').includes('..'), cast.castRelPath('b1', '../x'))
  t('书 id 里的 ../ 也出不去', !cast.castRelPath('../evil', '张三').includes('..'), cast.castRelPath('../evil', '张三'))
  t('空名字有兜底', cast.castRelPath('b1', '').startsWith('books/b1/cast/'))
}

console.log('\n=== 7. 接线时会用到的几处关节 ===')
// 这一组不是给 cast.js 自己看的，是给 index.js 那两个路由看的：
// 路由把 cast.js 的返回值直接往 store.writeCard 和界面里递，
// 下面每一条都是「递过去的时候会不会错位」。
{
  // 小节名匹配的先后顺序：模型写「说话习惯」和写「不会说的话」都含「说话」，
  // 顺序反了就会把这一节最值钱的内容（他绝不说的话）当口癖抄走。
  t('「不会说的话」不会被口癖抢走', cast.matchSectionTitle('不会说的话') === '不会说的话', cast.matchSectionTitle('不会说的话'))
  t('「说话习惯」才归口癖', cast.matchSectionTitle('说话习惯') === '口癖', cast.matchSectionTitle('说话习惯'))
  t('「不做的事」归不会做的事', cast.matchSectionTitle('不做的事') === '不会做的事', cast.matchSectionTitle('不做的事'))
  t('「性格特点」归性格', cast.matchSectionTitle('性格特点') === '性格', cast.matchSectionTitle('性格特点'))
  t('认不出来的小节返回空串', cast.matchSectionTitle('随便乱写') === '', cast.matchSectionTitle('随便乱写'))

  // applySplit 要把书的 id 填进 world：拆出来的卡必须挂在这本书的世界书上，
  // 不填的话它落成 reality，之后写这本书时读不到这张卡。
  const withWorld = cast.toCardShape({ name: '张三', world: '雾港', sections: [] })
  t('world 能按书的 id 覆盖', withWorld.data.world === '雾港', withWorld.data.world)
  t('world 传空串落 reality', cast.toCardShape({ name: '张三', world: '  ' }).data.world === 'reality', cast.toCardShape({ name: '张三', world: '  ' }).data.world)
  // 完全不传 world 时得落 reality。
  //
  // 这条曾经钉的是**错的**现状：那一行写成
  // `String(person?.world ?? 'reality').trim() === '' ? 'reality' : String(person.world).trim()`，
  // 空判断用的是补过默认值的表达式（永远不为空），真写进去的却是原始值，
  // 于是 `person` 不带 world 时落盘得到字符串 `"undefined"` —— 卡的世界归属
  // 就变成一个叫 undefined 的世界，界面上显示「属于哪个世界：undefined」，
  // 那本书的世界书永远带不上。现在先算一遍再判空，这条断言跟着改成对的。
  t('不传 world 落 reality 而不是字符串 undefined', cast.toCardShape({ name: '张三' }).data.world === 'reality', cast.toCardShape({ name: '张三' }).data.world)

  // 小节名在 toCardShape 这一步也要归一：模型写「性格特点」，卡上得是「性格」，
  // 否则 writeCard 写进去的是一节 tavern 读不到的小节（不报错，就是那个人突然不像）。
  const renamed = cast.toCardShape({ name: '张三', sections: [{ title: '性格特点', body: '先看门口。' }] })
  t('小节名归一后再落盘', renamed.sections.find((s) => s.title === '性格').body === '先看门口。', renamed.sections.map((s) => `${s.title}:${s.body}`))

  // parseCastResult 的第二个参数两种形状都收：路由传数组，
  // 但界面上重拆时可能直接把输入框那串原文递进来。
  t('名单给数组能筛', cast.parseCastResult('## 张三\n### 自述\na\n\n## 王五\n### 自述\nb', ['张三']).people.length === 1)
  t('名单给一串也能筛', cast.parseCastResult('## 张三\n### 自述\na\n\n## 王五\n### 自述\nb', '张三').people.length === 1)
  t('名单空着不筛（宁可多留）', cast.parseCastResult('## 张三\n### 自述\na\n\n## 王五\n### 自述\nb', []).people.length === 2)

  // 正文里用来强调的一整行粗体不是标题：「**注意。**」带句号，
  // 以前会被当成一个人，于是世界观里无缘无故多一条叫「注意。」的设定。
  const bold = cast.parseWorldResult('**注意。**\n\n## 码头\n触发词：卸货\n一年一半在下雪。')
  t('带句号的粗体不当标题', bold.entries.length === 1 && bold.entries[0].title === '码头', JSON.stringify(bold.entries.map((e) => e.title)))

  // 三个上限被 index.js 直接引用来卡条数，改动会静默放开或者收紧
  t('MAX_CAST 是 8', cast.MAX_CAST === 8, String(cast.MAX_CAST))
  t('MAX_WORLD_ENTRIES 是 40', cast.MAX_WORLD_ENTRIES === 40, String(cast.MAX_WORLD_ENTRIES))
  t('默认导出带齐路由要用的函数', ['parseCastNames', 'buildCastPrompt', 'parseCastResult', 'buildWorldPrompt', 'parseWorldResult', 'toCardShape', 'castRelPath'].every((k) => typeof cast.default[k] === 'function'), Object.keys(cast.default))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
