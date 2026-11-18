import * as T from '../lib/cardtext.js'

let pass = 0, fail = 0
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300)) }
}

console.log('=== 1. 占位符 ===')
{
  t('{{char}} 换成名字', T.fillPlaceholders('{{char}}笑了', { char: '张三' }) === '张三笑了')
  t('{{user}} 换成名字', T.fillPlaceholders('{{user}}在看', { char: '张三', user: '阿宝' }) === '阿宝在看')
  t('没给 user 就用「你」', T.fillPlaceholders('{{user}}在看', { char: '张三' }) === '你在看')
  t('<BOT> 也认', T.fillPlaceholders('<BOT>笑了', { char: '张三' }) === '张三笑了')
  t('随机类占位符留着', T.fillPlaceholders('{{random:a,b}}', { char: '张三' }).includes('{{random'))
  // 认不出来的不能乱填：填错了比留着更糟——模型会把填错的那个当真。
  t('不认识的占位符原样留着', T.fillPlaceholders('{{unknown}}', { char: '张三' }).includes('{{unknown'))
}

console.log('=== 2. 示例对话分隔线 ===')
{
  const one = T.renderExampleBreaks('你好\n<START>\n再见')
  t('孤零零的 <START> 变成分隔线', one.includes('---') && !one.includes('<START>'), one)
  // 行内的不是分隔线，是句子的一部分。
  t('行内的 <START> 不动', T.renderExampleBreaks('他说 <START> 这个词').includes('<START>'))
  t('连续两个只留一条线', (T.renderExampleBreaks('前面\n<START>\n<START>\n后面').match(/---/g) ?? []).length === 1)
  // 开头的 <START> 上面什么都没有，一条线孤零零摆在最顶上没有意义。
  t('开头的分隔线不摆', T.renderExampleBreaks('<START>\n你好') === '你好')
}

console.log('=== 3. 配置壳 ===')
{
  const out = T.stripShellTags('<project_instructions>\n规矩\n</project_instructions>')
  t('去掉了 project_instructions', !out.includes('project_instructions'), out)
  t('壳里的字留着', out.includes('规矩'), out)
  // 用户卡里正常用的 HTML 不能碰。
  t('不碰 <br>', T.stripShellTags('一行<br>两行').includes('<br>'))
  t('大小写都认', !T.stripShellTags('<SYSTEM_PROMPT>x</SYSTEM_PROMPT>').includes('SYSTEM_PROMPT'))
}

console.log('=== 4. 说话人标记 ===')
{
  // CC 整份导入时，示例对话长这样：`user: ...` / `char: ...`。
  // 这两个词是字段名不是人，模型读到会认出「这是模板」。
  const out = T.relabelSpeakers('user: 我想吃饭\nchar: 饿了？', { char: '张三' })
  t('user 换成「我」', out.startsWith('我：'), out)
  t('char 换成卡名', out.includes('张三：饿了？'), out)
  t('英文标记不再原样留着', !/^user\s*:/m.test(out) && !/^char\s*:/m.test(out), out)
  // 普通行一个字都不能动——卡里正经写着的「user:」可能是正文的一部分。
  t('不含标记的行不动', T.relabelSpeakers('这是一句话', { char: '张三' }) === '这是一句话')
  // 句中的不算行首标记。
  t('句中的 user: 不动', T.relabelSpeakers('他说 user: 是字段名', { char: '张三' }).includes('他说 user:'))
  t('没给卡名就用 TA', T.relabelSpeakers('char: 嗯', {}) === 'TA：嗯')
}

console.log('=== 5. 一整套 ===')
{
  // 顺序：先填占位符（否则 <BOT> 会被当 HTML），再拆分隔线（此时名字已就位），
  // 再去壳（<user_style> 去掉后那行 user: 才露出来），最后改说话人标记。
  const raw = [
    '<user_style>',
    '{{char}}是只老鼠。',
    '<START>',
    'user: 你在干嘛',
    'char: 啃东西',
    '</user_style>',
  ].join('\n')
  const out = T.shapeCardBody(raw, { char: '阿鼠', user: '阿宝' })
  t('占位符填了', out.includes('阿鼠是只老鼠'), out)
  t('壳去掉了', !out.includes('user_style'), out)
  t('分隔线出来了', out.includes('---'), out)
  t('说话人改好了', out.includes('我：你在干嘛') && out.includes('阿鼠：啃东西'), out)
  t('头尾没留空白', out === out.trim())
}

console.log('=== 6. 还剩多少占位符 ===')
{
  // `{{random:a,b}}` 不在认得的那套形状里（冒号逗号不是标识符的一部分），
  // 所以它既不会被替换、也不会被数进来——原样留着就是想要的结果。
  const got = T.countPlaceholders('{{char}} 和 {{user}} 还有 {{other}}')
  // total 是出现次数，keys 是种类数：同一处 {{user}} 出现三次要算三个。
  t('数得出来（算出现次数）', got.total === 3, got)
  t('报了是哪几个（去重）', Array.isArray(got.keys) && got.keys.length === 3, got)
  t('同一个占位符出现两次算两个', T.countPlaceholders('{{user}}{{user}}').total === 2)
  t('干净的卡是 0', T.countPlaceholders('没有占位符').total === 0)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
