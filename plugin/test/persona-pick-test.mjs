/**
 * 「这张卡哪几节进系统提示」——挑节的规矩、以及三条读写路由。
 *
 * 为什么要单独一个文件：`persona-test.mjs` 盯的是「挑好的卡原样进提示词」，
 * 这一份盯的是「用户能不能只让某几节进去」。两件事的失败长得很不一样：
 * 前者坏了是模型不知道演谁，后者坏了是模型**看到了一堆他不打算给它看的东西**，
 * 而且界面上没有任何地方会说自己多了什么。
 */
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import * as core from '../lib/core.js'
import * as persona from '../lib/persona.js'
import * as index from '../lib/index.js'

let pass = 0, fail = 0
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS', name) }
  else { fail++; console.log('  FAIL', name, extra === undefined ? '' : String(extra).slice(0, 400)) }
}
const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i])

const ws = await mkdtemp(path.join(os.tmpdir(), 'lc-pick-'))
const put = async (rel, text) => {
  const abs = path.join(ws, rel)
  await mkdir(path.dirname(abs), { recursive: true })
  await writeFile(abs, text)
}
const setConfig = (patch) => put('lifecard.config.json', JSON.stringify({ lifecard: '0.1', ...patch }, null, 2))

const card = [
  '---',
  'lifecard: "0.1"',
  'id: shen',
  'kind: fictional',
  'name: 沈九',
  'world: dock',
  '---',
  '',
  '## 自述',
  '你叫沈九，码头上长大的，说话短。',
  '',
  '## 性格',
  '【性格正文】不肯欠人情。',
  '',
  '## 口癖',
  '【口癖正文】行吧。',
  '',
  '## 妙妙',
  '【妙妙正文】这是网上那张卡自己起的节名。',
  '',
  '## 性格空壳',
  '',
  '## 世界书条目',
  '- keys: [码头]',
  '  content: 【卡内条目】这一节走世界书那条路，不按正文进提示词。',
  '',
  '## 创作者备注',
  '【备注正文】作者的话，不该念给模型听。',
  '',
].join('\n')
await put('people/shen.card.md', card)
await put(`worlds/${core.safeId('dock')}/world.md`, [
  '---',
  'lifecard: "0.1"',
  'id: dock',
  'kind: world',
  'name: 码头',
  '---',
  '',
  '## 世界书条目',
  '- keys: [码头]',
  '  content: 潮水一天涨落两次。',
  '',
].join('\n'))

await setConfig({ default_cards: { real: '', tavern: 'shen', novel: '', diary: '' } })

console.log('=== 1. 没配过这一项时，行为和以前一模一样 ===')
{
  const before = index.buildPersonaSection(ws, 'tavern')
  t('默认就把自述带上了', before.includes('码头上长大的'), '')
  t('默认把性格带上了', before.includes('【性格正文】'), '')
  t('默认把口癖带上了', before.includes('【口癖正文】'), '')
  t('默认不带上作者的备注', !before.includes('【备注正文】'), before.slice(0, 120))
  t('默认不带上自己起的节名', !before.includes('【妙妙正文】'), '')
  const detail = index.buildPersonaSectionDetail(ws, 'tavern')
  t('默认那一串就是 persona.DEFAULT_INCLUDE', same(detail.include, persona.DEFAULT_INCLUDE), detail.include)
  t('默认也算「没改过」', persona.isDefaultInclude(detail.include) === true)
  t('落下的那几节说得出来', detail.skipped.includes('妙妙') && detail.skipped.includes('创作者备注'), detail.skipped)
  t('走世界书那条路的不算「没给模型看」', !detail.skipped.includes('世界书条目'), detail.skipped)
  t('世界书照旧接在后面', detail.text.includes('# 这一场发生在：码头') && detail.text.includes('潮水一天涨落两次'), detail.text.slice(-120))
}

console.log('\n=== 2. 只勾两节，别的字一个都不进去 ===')
{
  await setConfig({ default_cards: { tavern: 'shen' }, persona_sections: { tavern: ['自述', '口癖'] } })
  const detail = index.buildPersonaSectionDetail(ws, 'tavern')
  t('自述进去了', detail.text.includes('码头上长大的'), '')
  t('口癖进去了', detail.text.includes('【口癖正文】'), '')
  t('性格没进去', !detail.text.includes('【性格正文】'), detail.text.slice(0, 200))
  t('真进去的就是那两节', same(detail.chosen, ['自述', '口癖']), detail.chosen)
  t('落下的节报得出来', detail.skipped.includes('性格') && detail.skipped.includes('妙妙') && detail.skipped.includes('创作者备注'), detail.skipped)
  t('标题行还是这个人的名字', detail.text.split('\n')[0] === '# 沈九', detail.text.split('\n')[0])
  t('世界书不受勾选影响', detail.text.includes('潮水一天涨落两次'), '')
  t('第一行加正文，正文比整段短', detail.bodyChars > 0 && detail.bodyChars < detail.chars, `${detail.bodyChars}/${detail.chars}`)
}

console.log('\n=== 3. 空数组 = 一节都不要（这张卡整张不进提示词） ===')
{
  await setConfig({ default_cards: { tavern: 'shen' }, persona_sections: { tavern: [] } })
  t('一个字都不给', index.buildPersonaSection(ws, 'tavern') === '', index.buildPersonaSection(ws, 'tavern').slice(0, 80))
  const detail = index.buildPersonaSectionDetail(ws, 'tavern')
  t('认得出是哪张卡，只是没带内容', detail.card !== '' && detail.text === '', detail.card)
  t('不是「默认」那一份', persona.isDefaultInclude(detail.include) === false)
  t('空数组和没配过是两回事', same(persona.normalizeInclude([]), []) && !same(persona.normalizeInclude(null), []))
}

console.log('\n=== 4. 恢复默认 ===')
{
  await setConfig({ default_cards: { tavern: 'shen' }, persona_sections: { tavern: null } })
  t('回到默认那一串', same(index.buildPersonaSectionDetail(ws, 'tavern').include, persona.DEFAULT_INCLUDE))
  t('性格又进去了', index.buildPersonaSection(ws, 'tavern').includes('【性格正文】'), '')
}

console.log('\n=== 5. 卡上自己起的小节名也能勾 ===')
{
  await setConfig({ default_cards: { tavern: 'shen' }, persona_sections: { tavern: ['妙妙', '自述'] } })
  const detail = index.buildPersonaSectionDetail(ws, 'tavern')
  t('勾到了那张卡自己的节名', detail.text.includes('【妙妙正文】'), '')
  t('顺序按认识的那张表排，认不出的排在后头', same(detail.include, ['自述', '妙妙']), detail.include)
  const dup = persona.normalizeInclude(['口癖', '自述', '口癖', '  ', null])
  t('重名、空串、非字符串都收拾干净', same(dup, ['自述', '口癖']), dup)
}

console.log('\n=== 6. 「写了标题没写内容」和「这张卡没这一节」要分开说 ===')
{
  await setConfig({ default_cards: { tavern: 'shen' }, persona_sections: { tavern: ['自述', '性格空壳', '关系史'] } })
  const detail = index.buildPersonaSectionDetail(ws, 'tavern')
  t('空壳那一节被单列出来', detail.empty.includes('性格空壳'), detail.empty)
  t('这张卡没有的那一节进另一栏', detail.absent.includes('关系史'), detail.absent)
  t('没内容的不出现在真进去了那一栏', !detail.chosen.includes('性格空壳') && !detail.chosen.includes('关系史'), detail.chosen)
  t('它们都不影响剩下的节', detail.text.includes('码头上长大的'), detail.text.slice(0, 80))
}

console.log('\n=== 7. 改完下一句就生效（同步那份缓存不许把旧值钉住） ===')
{
  // 关键在这一对：长度一样、只换了一个勾。按「时间+大小」认缓存的做法会在这里失效。
  await setConfig({ default_cards: { tavern: 'shen' }, persona_sections: { tavern: ['自述', '性格'] } })
  t('先读到的是性格', index.buildPersonaSection(ws, 'tavern').includes('【性格正文】'), '')
  await setConfig({ default_cards: { tavern: 'shen' }, persona_sections: { tavern: ['自述', '口癖'] } })
  const after = index.buildPersonaSection(ws, 'tavern')
  t('换成口癖之后立刻变', after.includes('【口癖正文】') && !after.includes('【性格正文】'), after.slice(0, 200))
  const detail = index.buildPersonaSectionDetail(ws, 'tavern')
  t('说明里也是新那一份', same(detail.chosen, ['自述', '口癖']), detail.chosen)
}

console.log('\n=== 8. 纯逻辑那一层 ===')
{
  t('候选里有世界书条目之外的节', !persona.candidatesFor(core.parseCard(card).sections).includes('世界书条目'), persona.candidatesFor(core.parseCard(card).sections))
  t('候选里认得的排前面，自起的按卡上顺序排后面', same(persona.candidatesFor(core.parseCard(card).sections), ['自述', '性格', '口癖', '妙妙', '性格空壳', '创作者备注']), persona.candidatesFor(core.parseCard(card).sections))
  t('没配过和显式勾默认那串，看起来一样', persona.isDefaultInclude(persona.DEFAULT_INCLUDE) === true)
  t('少一节就不算默认', persona.isDefaultInclude(persona.DEFAULT_INCLUDE.slice(0, -1)) === false)
  t('乱七八糟的输入收敛成默认', same(persona.normalizeInclude('自述'), persona.DEFAULT_INCLUDE) && same(persona.normalizeInclude(42), persona.DEFAULT_INCLUDE))
  const sections = core.parseCard(card).sections
  // 同一节写两遍是人最自然的写法（早上写一次、晚上补一次）。0.9.1 那一轮就是
  // 在这里用 `find` 只取第一份，把第二份静默吃掉。挑节这条路不能把那个坑带回来。
  const twice = core.parseCard(card.replace('## 口癖', '## 自述\n【第二份自述】\n\n## 口癖')).sections
  const picked = persona.selectBody(twice, ['自述'])
  t('同一节写两遍，两份都在', picked.includes('码头上长大的') && picked.includes('【第二份自述】'), picked)
  t('没勾的节一个字都不带', !persona.selectBody(sections, ['自述']).includes('【口癖正文】'), persona.selectBody(sections, ['自述']))
}

console.log('\n=== 9. 三条路由 ===')
{
  const ctx = {
    webServer: { register: () => () => {} },
    reflect: { get: () => undefined },
    effect: (fn) => { fn(); return () => {} },
    logger: { warn: () => {} },
    get: () => undefined,
    llm: undefined,
  }
  const table = index.buildApi(ctx, async () => ws, { workspace: ws })

  await setConfig({ default_cards: { tavern: 'shen' } })
  const got = await table['persona.get']({ mode: 'tavern' })
  t('读得到这扇门现在用哪张卡', got.ok === true && got.cardName === '沈九' && got.hasCard === true, got)
  t('列出这张卡能勾的每一节', Array.isArray(got.sections) && got.sections.length === 6, got.sections)
  t('每节带着「卡上有没有正文」', got.sections.find((s) => s.title === '性格').hasBody === true && got.sections.find((s) => s.title === '性格空壳').hasBody === false, got.sections)
  t('每节带着「现在勾没勾」', got.sections.every((s) => typeof s.picked === 'boolean'), got.sections)
  t('默认状态下勾的就是默认那几节', got.isDefault === true && same(got.include, persona.DEFAULT_INCLUDE), got.include)
  t('没带上哪几节说得出来', got.leftOut.includes('妙妙') && got.leftOut.includes('创作者备注'), got.leftOut)
  t('世界书那节标明走别的路', got.handledElsewhere.includes('世界书条目'), got.handledElsewhere)

  const set = await table['persona.set']({ mode: 'tavern', include: ['自述', '口癖'] })
  t('改得了', set.ok === true, set)
  t('改完就说清哪几节进去了', same(set.going, ['自述', '口癖']), set.going)
  const got2 = await table['persona.get']({ mode: 'tavern' })
  t('再读一次是新那一份', same(got2.include, ['自述', '口癖']) && got2.isDefault === false, got2.include)
  t('哪几节勾了也报出来了', got2.sections.find((s) => s.title === '性格').picked === false && got2.sections.find((s) => s.title === '自述').picked === true, got2.sections)

  const back = await table['persona.set']({ mode: 'tavern' })
  t('不给这一项就是恢复默认', back.ok === true && back.isDefault === true, back)
  t('恢复默认之后真的回到那一串', same((await table['persona.get']({ mode: 'tavern' })).include, persona.DEFAULT_INCLUDE))

  const none = await table['persona.set']({ mode: 'tavern', include: [] })
  t('给空数组就是一节都不要', none.ok === true && none.chars === 0, none)
  await table['persona.set']({ mode: 'tavern' })

  const preview = await table['persona.preview']({ mode: 'tavern' })
  t('预览就是把真给模型看的东西拿出来', preview.ok === true && preview.text === index.buildPersonaSection(ws, 'tavern'), `${preview.chars} / ${index.buildPersonaSection(ws, 'tavern').length}`)
  t('预览也说得出多长', preview.chars === preview.text.length && preview.chars > 0, preview.chars)
  t('预览里有第一行那个名字', preview.text.startsWith('# 沈九'), preview.text.slice(0, 40))

  const badMode = await table['persona.set']({ mode: 'nope', include: [] })
  table['persona.get']({ mode: 'nope' })
  t('不知道哪扇门就不动设置', badMode.ok === false, badMode)
  const badShape = await table['persona.set']({ mode: 'tavern', include: '自述' })
  t('勾选写成一串字符串时挡下来', badShape.ok === false, badShape)
  const stillOk = await table['persona.get']({ mode: 'tavern' })
  t('挡下来之后设置没被弄坏', stillOk.ok === true && stillOk.isDefault === true, stillOk.include)

  await setConfig({ default_cards: { tavern: '' } })
  const noCard = await table['persona.get']({ mode: 'tavern' })
  t('没挑卡时也回一份说得清的', noCard.ok === true && noCard.hasCard === false && noCard.sections.length === 0, noCard)
  t('没挑卡时按默认那几节报', noCard.isDefault === true && same(noCard.include, persona.DEFAULT_INCLUDE), noCard.include)
}

await rm(ws, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)