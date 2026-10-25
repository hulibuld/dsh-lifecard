# Life Cards 交接文档

> 写于 2026-10-19 21:00 左右。给下一个接手这个项目的人（或下一个我）看。
> 读完这一份就该能直接开工，不用再去翻聊天记录。

---

## 一句话现状

**插件已经装好、在跑、测过了。** 侧边栏里能用，访谈 skill 已经注册进 DSH 并且模型能看见，全量测试 **1494 项**通过，对一个真实运行的 DSH 实例做的端到端验收 **15/15** 通过。**P0（上传 GitHub 前的准备）、P1（陈旧文档）、P2（六项功能扩展）全部做完。** 之后又做了四轮加固：数据层 20 处隐患、编码/路由层 20 处隐患、世界书导入与展示，以及一批界面死路修复。

**P3 之后新加的三块**（2026-10-20）：
- **关系视角改造**：访谈页不再问「你们是什么关系（父母/祖辈/伴侣）」，改成「他是我的什么人」（父亲 / 母亲 / 爷爷 / 奶奶 / 伴侣 / 好友 / 兄弟姐妹 / 同学 / 老师 / 同事 / 亲戚 / 我自己 / 虚构角色 / 自己填），并且可以勾「还有别的吗」（也是伴侣 / 也是家人 / 也是好友 / 也是同事 / 也是老师 / 也是对手）。「这是谁」那栏改名「他叫什么」，跟关系不再重复。
- **写卡草稿**：卡片编辑表单停手 1.5 秒自动存草稿到 `.lifecard/drafts/`，下次打开这张卡会问「接着上次写」还是「不要了，从头写」。草稿不自动恢复（用户可能故意放弃那一版），保存成功后自动删。
- **看工作（求职）**：把一份招聘说明贴进来，得到「哪里会卡住你」的顺序化清单，每条挂两处原文；带「这家公司我认识谁」（用关系网找人）、投递记录、面试故事、照招聘说明改简历/求职信。**不自动投递**。

---

## 这东西是什么

本地优先的人物档案库。把现实里的人（家人、朋友、同事、你自己）、虚构角色、以及他们之间的关系，写成一组 Markdown + YAML 文件，放在用户自己选的文件夹里。

**三个入口，两条链路：**

```
入口 A｜完整角色卡   PNG / JSON / CHARX → 直接出卡        纯格式搬运，不调模型
入口 B｜对话访谈     它问，你答 → materials/  ─┐
入口 C｜文本导入     访谈稿 / 聊天记录 / 日记 → materials/ ─┤
                                          ↓
            AI 分析 → 引文校验 → proposals/ → 人勾选 → 写进卡
```

B 和 C 产出同一种东西（材料），之后走完全相同的一条链。**每条 AI 断言必须带原文引文，找不到原文直接丢弃**——这是整个项目的核心闸门，别把它优化掉。

**不是**角色扮演平台，**不是**云端服务。它现在能帮你看工作、改简历，但那是**用你自己写过的材料**去重组，不是简历生成器——它不会替你编一个数字。

---

## 在哪

```
<仓库根>/
```

**这已经是 git 仓库了**（`git init -b main` 已做，`main` 分支，首次提交 `4fa96c7`）。要上传 GitHub 只差 `git remote add` + `push`。

```
LifeCard/
├── HANDOFF.md          ← 本文件
├── SPEC.md             496 行，唯一数据契约。文档互相矛盾时以它为准
├── README.md           项目介绍（"为什么"），有几处数字陈旧，见文末
├── 使用指南.md         早期文档，已被 SPEC 取代，留作背景
├── 策划书.md           同上
├── 策划书-第二部分.md   同上
├── .bak/               3 个旧 md 的备份
├── .bak-20261018/      2026-10-18 整份快照
└── plugin/             ← 真正的成品，所有代码在这里
```

### plugin/ 内部

| 文件 | 行数 | 职责 |
|---|---|---|
| `lib/client.js` | 4063 | **整个侧边栏界面**。纯手写，没有 React 依赖注入以外的框架 |
| `lib/index.js` | 2191 | 宿主侧：64 条 HTTP 路由、调用模型、**注册访谈 skill**、路径越界闸、导出 consent 闸 |
| `lib/store.js` | 1333 | 工作区、快照、墓碑 `redactions.jsonl`、提案与勾选旁路、头像、概念、草稿、doctor |
| `lib/core.js` | 1019 | 零依赖：YAML 子集解析/序列化、卡片校验、覆盖率、**引文校验门** |
| `lib/codec.js` | 785 | PNG tEXt/iTXt 读写、CCv2/CCv3/CHARX、双 chunk 导出、保真字段 |
| `lib/prompts.js` | 497 | 14 类关系视角 × 问题库（带 `bank` 映射）、`buildAnalyzePrompt` |
| `lib/jobs.js` | 607 | **求职纯逻辑**：两遍读法、五档重要性 + 三档证据、一票否决、关系网找人、报告渲染。不联网不调模型 |
| `lib/jobs-interview.js` | 434 | **模拟面试纯逻辑**：出题、判回答、读下一轮重点、收尾总结。三道闸：不碰背调／不编数字／不查隐私。不联网 |
| `lib/jobs-store.js` | 437 | 求职落盘：评估报告、投递表、故事银行、面试存档、简历/求职信草稿、求职设置（存在 self 卡上） |
| `lib/score.js` | 329 | **纯本地**体检打分 0–100、字数估算、占位符与世界书健康度 |
| `lib/memory.js` | 454 | 从本机记忆文件里认出「你身边的人」，给出还缺什么 |
| `skills/lifecard-interview/SKILL.md` | 192 | **会随包安装的那份**访谈 skill |
| `test/` | 16 个在 `all.mjs` 里 + `live.mjs`，另有 `make-samples.mjs` | 1494 项断言 |
| `locale/{zh,en}.json` | — | 侧栏 tab 的标题与描述 |
| `cordis.patch.yml` | — | 装进 profile 时插入的插件条目 |
| `node_modules/@deepseek-ai/schemastery` | — | 软链，见下面坑 #2 |

---

## 现在能跑吗——验证证据

三条证据，都能自己复跑：

```bash
cd .../LifeCard/plugin

# 1. 全量单元测试：1494 项
node test/all.mjs
# → roundtrip 23 / codec 52 / store 157 / score 51 / memory 72 / jobs 148
#   interview 112 / json-extract 10 / prompt 238 / client-smoke 27
#   skill-register 20 / routes 85 / hardening-routes 46 / hardening-data 54
#   render-all 255 / wording 16

# 2. 对真实运行的 DSH 做端到端验收：15/15
node test/live.mjs "$DSH_GUI"          # $DSH_GUI = 运行时上下文里那个 GUI URL
# 退出码：0 = 真验过且全过 / 1 = 有项没过 / 2 = 没验（端口上没有本插件）
# 这一步的 2 不算绿。以前跳过也返回 0，「没装」和「装好全过」长得一样。

# 3. 界面文案自检：黑话零命中（界面 255 项 + 后台回话 16 项，已含在 all.mjs 里）
node test/render-all.mjs
node test/wording-test.mjs
```

**2026-10-22 23:36 的实测结果**：`all.mjs` 1494 项全过；`live.mjs` 15/15 全过；`state.get` 200；git 工作区干净。

live 那 15 项验的是：插件已激活 / 宿主有 llm / 建工作区 / 卡被列出 / 材料被列出 / 分析跑通 / 有可采纳条目 / 默认不勾选 / 每条都有引文 / 采纳成功 / 导出 PNG / 双 chunk 同源 / doctor 跑通 / 宿主段已写 / 跑完把工作区指回原来的。

**访谈 skill 确认可见**：本次会话注入的 skill 目录里已经有 `lifecard-interview`，描述是"引导式访谈，在对话里把一张人物卡问出来。用于「帮我建一张 XX 的卡」「继续上次那个访谈」「这张卡还缺什么」"。也就是说**用户现在在对话里说"帮我建一张我妈的卡"就会触发它**。这条不用再验了。

> **界面是不是新的？** 桌面 App 进程启动之后改过的 `lib/client.js`，**必须重启 App 才进界面**（desktop profile 被 Electron 独占，没有热重载）。
> 判断办法：比 `ps -o lstart= -p <App 进程 pid>` 与 `ls -l plugin/lib/client.js` 的时间。文件比进程新 → 界面上还是旧的。
> 宿主侧（`index.js` / `store.js` / `score.js`）用同一个进程，所以同样要重启。这是排查"改了没效果"时的第一件事。

---

## 装在哪、怎么生效

- 插件目录软链：`~/.dsh/profiles/desktop/node_modules/dsh-lifecard` → `.../LifeCard/plugin`
- profile 补丁：`~/.dsh/profiles/desktop/cordis.patch.yml` 第 1602–1604 行（行号会随别的插件增删而变，用 `grep -n lifecard` 找）
  ```yaml
  - insert:
      - id: lifecard
        name: 'dsh-lifecard'
  ```
- `schemastery` 软链：`~/.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery` 存在
- **desktop profile 被 Electron 独占，改完必须重启 App 才生效，没有热重载。**
- **端口每次重启都会变**（见过 49204 / 49192 / 53872）。不要写死，以运行时上下文给的 GUI URL 为准，或从 `ps aux | grep dsh-desktop-host` 里看 `--port`。
- `POST /api/dsh-lifecard/state.get` **不需要 token 就能打**（其它 `/api/*` 路由要 401），所以外部脚本能验插件。

完整的 **64 条**路由（与运行时 `buildApi` 的键一一对上，2026-10-22 实测）：

```
state.get  workspace.init  workspace.inspect  workspace.list
card.get  card.save  card.delete  card.memoryStatus
world.get
card.history  card.version  card.restore
avatar.set  avatar.remove  avatar.list
import.cards  import.text  import.textFile
export.card  export.json
material.add  material.list  material.delete
analyze.run
proposal.list  proposal.get  proposal.check  proposal.apply
doctor.run
interview.questions  interview.plan  interview.record  interview.history
concept.get  concept.set
ui.intro
draft.get  draft.save  draft.drop  draft.list
memory.scan  memory.import  memory.extract
job.profile.get  job.profile.set  job.evaluate  job.evaluations  job.evaluation.get
job.network  job.tracker.list  job.tracker.add  job.tracker.update
job.stories  job.story.add  job.drafts  job.draft.get  job.resume.build  job.cover.build
job.interview.start  job.interview.turn  job.interview.answer
job.interview.end  job.interview.get  job.interview.list
```

---

## 已经做完的四轮改造（知道"为什么现在是这样"用）

1. **文档评审 → SPEC.md 定案**。四份原始文档互相矛盾，重写成 496 行的 SPEC.md 做唯一契约。kind 扩到 8 值（real/fictional/hybrid/self/lens/world/system/relation），必需字段按 kind 分层。
2. **砍掉"手机随手记"**。iOS Safari 到 27.2、Chrome for Android 155 都还不支持 File System Access API，这条做不到，改成"文本导入 + 角色卡导入 + AI 分析"。
3. **访谈从命令改成 skill**。用户明确要求"内置一个引导式建卡的 skill，在对话里给选项引导用户回答，最终构建出卡片"。所以访谈是 skill（对话里跑），不是侧边栏里的一个表单。
4. **界面按 IT 小白标准重写**。原来卡片编辑是把 `JSON.stringify` 塞进 textarea，被用户批评"太粗糙"。现在换成真表单（名字/称呼/他是谁下拉/关系/状态/正文四段/能力编辑器/禁忌/知情），按钮文案全部改成人话（"改这张卡"、"接着聊"、"写完了多少"），技术黑话（JSON/chunk/tEXt/CHARX/Zod/YAML/proposal/workspace）从界面上全部清除——`render-all.mjs` 有一条断言专门扫这个。

---

## 第五轮：无上下文三审（2026-10-22 晚）

用 `dsh-plugin-team` 开了四个没看过本项目对话的审查员（契约 / 质量 / 文档 / 基线），一共报 48 条。逐条复现后修掉 40 条，8 条记为「先不动」。

**修掉的里最要紧的六件**（都在 `git log` 里，提交信息写清了为什么）：

1. **client 的 `inject` 里写了第三方 `betterSidebar`** —— Cordis 对未就绪 inject 会挂起整个 fiber，`apply` 一句都不执行。干净 profile 上装完就是这个结果：左边图标没有、主区域空白，用户以为插件没装上。现在只 `inject: ['slots']`，右侧栏那个入口走 `ctx.get('betterSidebar')` 的可选分支。**这条是「发布给别人装」的阻断项。**
2. **导出被拦的提示把内部词摆到界面上** —— `lens`、`kind`、`consent.basis`、`recorded_at`。而 `test/wording-test.mjs` 只扫单行字面量、抓不到字符串拼接，所以一直是绿的（假安全感）。现在文案全改人话，断言改成「真调一次 `export.card` 拿返回的 message 比禁用词」。
3. **采纳面板会把对象值 `JSON.stringify` 出来** —— 屏幕上出现 `knows: ["榫卯"]；does_not_know: []`，能力等级显示英文 `expert`。
4. **材料删掉后，旧提案还能把无出处的断言写进卡** —— 材料现在能删，但 `applyProposal` 只信保存时的验证结果。现在写卡前对着现有材料重验一遍，找不到的进 `dropped` 并在界面上说清「有几条因为原文没了没写」。
5. **同一个提案采纳第二次会给卡里塞重复条目** —— `competency`/`taboos` 是数组，重复 push 就长出两条一样的。现在按指纹记账，第二次点采纳什么都不写（也不报错）；旁路文件 `.checked.json`/`.applied.json` 也不再被当成提案列进「还等着你看的建议」。
6. **快照备份不下来也照样覆盖旧卡** —— `writeCard` 里那个 `catch {}` 把权限、磁盘满一起吞了。现在只有「本来就没有这张卡」（ENOENT）可以跳过，其它一律不写并说明原因。顺带：`parseCard` 失败以前当成功，坏卡变成一张空白卡挂在列表里，那句「有 N 个文件读不了」永远不触发——现在会进 `errors`。

**另外还改了**：`import.textFile` 补了读盘边界（只认纯文本类后缀 + 普通文件 + 8MB 上限；这条是「从文件选择器挑一个工作区外的文件」的正当流程，所以不能按「只许工作区内」来卡）；`card.save` 不再接受 `body.force` 跳校验；去掉模块级 `runtimeWorkspace`；样式在 `ctx.effect` 里挂/回收；`package.json` 补 `exports` 的 `./locale/*.json` 与 `./icon.svg`、`icon` 字段、`engines`；`live.mjs` 跳过时退出码改成 2（以前「没装」和「装好全过」都是 0）。

**六条「记了不修」后来全修了**（2026-10-22 晚，用户说「现在修」）：几个上限（请求体 / 头像 / 纯文字文件）改成配置项 `maxBodyMB`/`maxAvatarMB`/`maxTextFileMB`；主色调改成 `var(--dsw-alias-*, 兜底色)`，跟着宿主主题走；`job.interview.turn` 循环外那次白打的模型删掉（以前结果被同名变量遮蔽，用户付两次钱）；访谈账本改成按人名精确匹配（张三不再读到张三丰的记录）；同名新建不再覆盖已有卡（返回人话并叫人改名，带 `path` 的保存照旧）；`doctor` 里那个永远为空的 `dshVersion` 删掉。

**顺手挖出一个更要紧的**：第五轮为修「模块级工作区状态」把 `root()` 改成只认配置，结果**把注入进来的工作区函数绕过了** —— 整套接口测试从此往用户真实的 `~/LifeCard` 里写（测试全绿，用户的 people/ 里多出测试卡）。已改成「注入的函数优先，没有才读配置」，加了三条断言钉住，并清掉污染文件。教训：为了消掉模块级状态而改动 `root()` 这种「所有路由共用的入口」，必须同时验证测试的隔离还成立。

## 第六轮：第二轮无上下文审查（2026-10-22 深夜）

按用户要求又开了一轮「没看过本项目对话」的审查团队，并额外把已有的 6 条低优先项修掉、把两份重复的 SKILL.md 合成一份（见 `git log`）。

**这一轮的团队没跑起来**：四个成员里有三个直接失败，报 `no adapter registered for provider "raccoon"`（`NO_ADAPTER`），一个上下文耗尽。也就是说**外部审查这一轮实际上没提供任何结论**。我没有等它，自己按同样的三个轴（契约 / 质量 / 文档）扫了一遍，只报能复现的：

1. **[真问题，已修] 验收脚本会把用户正在用的窗口变成空库** —— `test/live.mjs` 为了让端到端验收能真写文件，会把运行中实例的工作区临时指到 `/tmp` 下，跑完 `rm -rf`。以前恢复那一句写在脚本最末尾，**中途一超时就执行不到**（实测：模型那次 5 分钟没回话，脚本炸了，实例留在 `/tmp/lifecard-live-1792681879531`，用户那一屏就是空的）。现在恢复放进 `finally`，并且每个请求带超时（默认 2 分钟，模型那一步 7 分钟）；恢复失败会明确打印「请到『更多工具 → 换个文件夹』重新选 `<原路径>`」。live 从 14 项变 15 项，多的那条就是「跑完把工作区指回原来的」。
2. **[真问题，已清] 删掉的测试卡，历史版本永远留在盘上** —— `~/LifeCard/.lifecard/snapshots/` 里有 17 个属于 `lens-x` / `zsan` / `zsanfeng` 的快照，那三张卡早就不在了。这是我自己早前拿真实实例点界面留下的残渣，已清（用户自己那张卡的 2 份历史保留）。
3. **[文案] 一处英文格式名漏到界面上** —— `import.textFile` 的拒绝提示写着「纯文本、Markdown、数据文件都可以」。改成「纯文字的文件都可以；是图片的话请用『导入角色卡』」。理由：用户手里是一份文档，他不需要知道它叫什么格式。

**核对过、确认没问题的**：64 条路由与 `buildApi` 的键一一对上；所有取路径的路由都过 `insideWorkspace`（脚本逐个路由块扫过，没有漏的）；`npm pack` 18 个文件齐全；`lib/` 里没有 `TODO`/`FIXME`/`console.log`。

**结论**：代码侧可交付。当前 **1494 项**测试 + **15/15** 端到端验收全过（2026-10-22 23:52 实测）。

## 踩过的坑（这一段最值钱，别重犯）

1. **cordis `resolveConfig` 读 `Config["~standard"].validate`**，传普通对象会抛 `Cannot read properties of undefined (reading 'validate')`。必须用 schemastery 的 `z.object(...)` 定义 config。
2. **软链插件目录时，包内解析不到 `@deepseek-ai/schemastery`**。解法：在 `plugin/node_modules/@deepseek-ai/` 里建软链。
3. **`ctx.llm.stream()` 必须显式给 provider + model**，没有"自动选默认"。`listProviders()` 也不包含 buddy 这类内置路由。
4. **`messages[].content` 必须是内容块数组** `[{type:'text', text:'...'}]`。传裸字符串会报 `content.some is not a function`。
5. **流事件真实形状**：`{type:'text-delta', index, text}`。`block-start` / `block-end` / `finish` 都不带正文。
6. **`walk()` 的 relDir 末尾没有斜杠**，`startsWith('materials/')` 永远假 → materials 一直返回 0。改用 `isUnder()`。这是最阴的一个 bug，因为不报错，只是空。
7. **YAML 序列化三个坑**：行内 map 会被当标量；数组对象项的嵌套值会拼成同一行；多行字符串必须用 `key: |` 块标量。
8. **`asV3` 判定**：`options.asV3` 显式给了要以它为准，否则 `cc.spec === 'v3'` 会覆盖调用方意图。
9. **`extractJson` 要容错**：围栏、前后解释文字、以及**截断修复**（补括号）。模型经常输出到一半就断。
10. **分析会间歇失败** → 加 3 次重试 + 提示词里明确"只输出 JSON"。
11. **`ctx.skills.register()` 的注册法**：用 `ctx.reflect?.get?.('skills', false)` 探测，再 `ctx.effect(() => skills.register({...}))`。**不要把 `skills` 加进 `export const inject`**——精简 profile 里没有这个服务，加了会导致整个插件起不来。没有 skills 服务时降级（打一条 warn，卡库功能照常）。
12. **测试自己的坑**（`render-all.mjs`）：
    - 假 `createElement` 必须把 children 塞进 `props.children`，否则按钮文字全丢。
    - 收集器必须真调用函数组件（维护 `hookStore`/`hookIndex`），否则只抓到根组件。
    - **黑话检查只能扫"真实渲染出的可见文字"**，扫源码字符串字面量会把 `proposal` 这种代码标识符当文案，假失败。
    - 要拿根组件必须用 `api.LifeCardTab`，不能 `api.apply()` 注册的那个 `component` 箭头函数（它返回元素不是渲染树）。
13. **`package.json` 的 `files` 漏了 `skills/`** → 文件在仓库、用户装不到。已修为 `"skills/**/SKILL.md"`。**发布前一定要复核这一条。**

---

## 没做完的，按优先级

### P0 — 上传 GitHub 之前必须做（✅ 已全部完成）
1. **`git init` 并首次提交**。现在零版本控制，一次误删就没了。
2. **修 `package.json:44` 的死链**：`"test": "node test/smoke.mjs"` 指向不存在的文件，`pnpm test` 直接失败。改成 `node test/all.mjs`。
3. **补 LICENSE 文件**。`package.json` 写着 MIT 但没有 LICENSE 文本，GitHub 上会显示"未授权"。
4. **加 `.gitignore`**：至少忽略 `plugin/node_modules/`（里面是软链）。

### P1 — 文档陈旧（✅ 已完成）
| 位置 | 原来写的 | 现在是 |
|---|---|---|
| `README.md:27` | 「96 项测试全部通过」 | 1494 项 |
| `plugin/README.md:178` | `# 全部测试（96 项）` | 1494 项 |
| `plugin/README.md:29` | 侧栏会出现**人物档案** | **Life Cards** |

`plugin/README.md` 的目录树与"三个入口"图已对着现在的界面重写（commit `43266e6`）。

### P2 — 功能扩展（✅ 六项全部完成并提交）

已经调研过两个 MIT 项目（Cardwright、airole），**功能设计可以自由学，但代码按功能重写不要搬**（无 LICENSE 的仓库按著作权法默认保留一切权利，小改不改变；GPL/AGPL 有传染性，都不能并进来）。实际没搬任何外部代码。

| # | 功能 | 落在哪 | 界面上叫什么 |
|---|---|---|---|
| 1 | 离线体检打分 0–100 | `lib/score.js`（纯本地，只 import core.js） | 体检页的总分 + 「还能补的卡」 |
| 2 | 每字段字数估算 | `lib/client.js` 的 `roughSize` / `sizeTag` | 表单顶部「正文现在大约 N 字」 |
| 3 | 头像与 2:3 裁剪 | `store.writeAvatar/readAvatar/removeAvatar` + `AvatarPicker` | 卡表单顶部的「头像」 |
| 4 | 世界书可视化编辑 | `BookEditor`；落点是 `data.cc.fields.character_book` | 「这张卡自带的小设定」 |
| 5 | 概念 → 生成 | `store.readConcept/writeConcept` + `concept.get/set` | 首页的「想要什么样的人」 |
| 6 | 版本历史 | `store.listSnapshots/readSnapshot/restoreSnapshot` + `HistoryPanel` | 卡详情底部「以前的样子」 |

### P2.5 — 三轮加固（不在原计划里，已做完，连同 P2.7 共四轮）

1. **数据层 20 处隐患**（commit `610dd73`）：引文门短引文/假行号/不指名材料被拒、墓碑残缺记录、路径越界读写、保留字段 id/lifecard 改不动、数组元素被摊平成一串、doctor 的 `unmarked` 恒为 null、`readBlock` 吞同级兄弟键、`latestAffect` 排序错。
2. **编码/路由层 20 处隐患**（commit `8fb9072` 之后）：PNG tEXt 的 CRC 少算 chunk type、顶层未知键被挪进 `data`、裸 UTF-8 载荷读不出、压缩 iTXt 静默变空、latin1 解码静默坏中文、导出没有 SPEC §6 的 consent/lens/未成年闸、13 条吃路径的路由可越界、`export.card` 的底图路径来自卡内容（第二处越界）、`interview.plan` 的 limit 没夹紧。
3. **测试补齐**：`test/hardening-routes.mjs`（46 项）+ `test/hardening-data.mjs`（54 项）。这两个文件的用例**都用「修复前的代码」验过会红**，不是补个绿了事。

### P2.6 — 「看不到插件」的排查与修复（commit `0ba07f9`）

**结论先行：插件一直是装好、在跑、测过的。** 用户说"没看到插件被加载出来"，查下来三条证据都指向"加载成功"：

| 查什么 | 怎么查 | 结果 |
|---|---|---|
| 宿主半边 | `curl -X POST .../api/dsh-lifecard/state.get -d '{}'` | 200，返回 workspace 与 1 张示例卡 |
| 插件激活状态 | `plugin_manager` 列 253 条里找 `include:lifecard` | `enabled:true`、`fiberPhase:"active"` |
| 客户端 tab | `cordis_inspect_query` 的 client/Slots，看 `sidebar.right.pane.tab` 的 occupants | 有 `dsh-better-sidebar:lifecard`、`active:true` |

**真正的原因**：入口太深。lifecard 只往 better-sidebar 注册了 tab，而 better-sidebar 把它投影到 **DSH 原生右侧栏的「+ / 新标签页」列表**里一个叫「Life Cards」的胶囊。左侧栏那排图标里没有它。对不熟悉右侧栏「+」的人，等于插件不存在。

**修法**（`lib/client.js` 的 `apply()`）：同时往 `sidebar.panellist` 注册一个图标（`order: 35`）、往 `main` 注册配对的面板页，两边用同一个 id `lifecard` 配对 —— 这是 DSH 左侧栏图标的标准注册法（`task-board`、`skill-explorer`、`mnemon` 都是这么做的，`panellist` 的 `id` 必须等于 `main` 的 `key`，外壳靠这个把左侧图标和中间页面配起来）。右侧栏那个 tab 保留。

三处细节，改动时别退回去：
- `PanelIcon` 的 `size` 由外壳给（`SidebarPanelIconOwnerProps { size, active }`），要跟着走，不能写死。
- `PanelPage` 自己撑满高度（`height:100%` + `flexDirection:column` + `minHeight:0`），否则里面那层滚不动。
- `slots` 座位不存在时（老外壳、精简 profile）只少一个入口，**不能抛错**。`inject` 数组已加 `'slots'`。

`test/client-smoke.mjs` 就此从 15 项加到 27 项，锁住这几点：`inject` 含 `slots`、两个座位都注册、`main.key === panellist.id`、图标能画且跟着 `size`、页面能渲染、缺 `slots` 时优雅退化。

### P2.7 — 导进来的世界书在界面上看不见（本轮修的）

**症状**：导入一本酒馆世界书（worldinfo），提示"导入完成：1 张成功"，然后首页什么都没有。用户合理判断是导入失败。

**三条真实原因，都不报错**：

| 哪一层 | 问题 | 后果 |
|---|---|---|
| 检测 | `codec.detectJsonKind` 把"带 name/description 的世界书"判成 V1 角色卡 | 条目全丢，卡里多一本空世界书 |
| 落盘 | `enabled` 那行判的是 `entry.disable`（归一化后恒 undefined） | 每一条都写成"停用" |
| 显示 | `workspace.list` 返回了 `worlds`，但 `HomeView` 从没用过它 | 数据到了前端，屏幕上没有入口 |

**修法**：
1. `plugin/lib/codec.js` 的 `detectJsonKind` 判定顺序改成 spec → 世界书 → V2/V3 → V1，并用 `V1_MARKERS` 区分"只有名字"的极简卡。
2. `plugin/lib/index.js` 的 `importWorldInfo` 修 `enabled`、补 `uid`/`rest`/`entry_count`/`source_file`，原件抄进 `.lifecard/raw/<id>.worldinfo.json`。
3. `plugin/lib/core.js` 新增 `parseWorldEntries(sections)`（按 `- ` 切段再逐段 parseYaml，坏段跳过、不连坐）。
4. `plugin/lib/store.js` 的 `listAll` 给每本世界书带上 `entry_count`。
5. `plugin/lib/index.js` 新增路由 `world.get`（按 path 或 id 读一本，返回解好的条目）。
6. `plugin/lib/client.js` 新增 `WorldRow`（列表行）、`WorldView`（详情：条目正文、触发词、开关、搜索、用到它的卡）、`VIEWS.world`，并在 `HomeView` 增加"世界书 · N"分组；`doImport` 的提示改成分开报"N 张卡、M 本世界书"。

**为什么世界书不进卡列表**：它没有覆盖度、不参与体检打分，混进卡列表会显示成"这张卡才写了 20%"。

**测试**：`roundtrip` +10（条目解析）、`routes-test` +12（导入到显示的整条链路）、`render-all` +17（世界书列表行/详情/空/未取到、编辑表单的世界下拉、手写触发词、搜索联动、世界下拉不留空值、卡片能点回所属世界书）。合计 651 → 710 → 722 → 725 → 736 → 741 → 934 → **1152**。新增断言用 `git show HEAD:plugin/lib/...` 的旧代码验过会红 10 项。

### P3 — 还没做的（都需要人点头）

1. **`defaultWorkspace()` 返回 `homedir()/LifeCard`**（`lib/index.js:42-44`）。是否改成 `homedir()/Documents/Life Cards`？改的话用户已经 seed 过 `~/LifeCard`，要处理迁移或兼容。
2. ~~顶层那份 SKILL.md~~ **已删**（2026-10-22，用户定「只留一份」）。现在只有 `plugin/skills/lifecard-interview/SKILL.md` 一份，改它就行，没有第二处要同步。
3. **四份原始文档**（使用指南/策划书/策划书-第二部分）已被 SPEC.md 取代。保留作背景材料，还是归档到 `docs/archive/`？
4. ~~**同一天对同一个人跑两次分析，第二次会覆盖第一次的提案与遗留记录**~~ → **已修（commit 见 `lib/store.js` 的 `freeProposalBase`）**。第一次仍用不带序号的老名字，撞上了才依次试 `-2`、`-3`；三个文件（`.md` / `.json` / `.checked.json`）一起占名，勾选不串台。`test/store-test.mjs` 第 14 组 12 项锁住，并用修复前的 `store.js` 验过会红 6 项。
5. **本地 HTTP 端点没有 Origin/CSRF 校验**，且任何请求都能用 `body.workspace` 改当前库。这是宿主 `/api` 的暴露面，不是本插件能单独修的，建议在宿主侧做 Origin 白名单。

### P2.8 — 界面上的「点了没反应」与小别扭（本轮修的）

这一轮不是加功能，是**替用户去点**。做法：在 `test/render-all.mjs` 里把渲染树的
`onClick` 真调一遍（`deepRender` 只走一遍、不展开组件，所以另写了一个 `expand()`
把函数型节点就地展开成纯 DOM 树才能抓到 `<button>`），然后断言状态被改成了什么。
这样「点了不跳」「跳了但还带着上一个人」不再只能靠人手点才发现。

| 症状 | 真原因 | 修法 |
|---|---|---|
| 首页点「还等着你看的建议」没反应 | `onProposal(p.json)` 传的是文件路径，面板要的是一份取回来的建议 | 统一成 `showProposal(p)`，先 `proposal.get` 再定位到人 |
| 分析页「看看读出了什么」白点 | 直接 `setProposal + setView(card)`，而那一页手上没有 `activeCard` | 同上，走同一个入口 |
| 刚看完某人的卡，回首页点「整理材料 / 聊着建」，那页还选着刚才那个人 | `interviewFor` 从没被清过 | 新增 `go(next)`：进这两页前先 `setInterviewFor(null)` |
| `card.get` 失败时把错误说明当卡塞进 `activeCard` | 路由失败时是「成功回话 + `ok:false`」，不抛错 | 两处都加 `if (detail?.ok !== true) throw`，失败时清空 |
| 「更多工具」看不出能展开 | 箭头图标不跟着开合转 | 包一层 `span` 加 `rotate(90deg)` + 过渡 |
| 体检页「还能补的卡」只列名字，点了没反应 | 那一行是 `div`，没有点击目标 | 改成 `button`，点了直接打开那张卡（`DoctorView` 多接一个 `onOpenCard`） |
| 有没有别的「死按钮」没人查过 | 只靠人手点 | 加一条扫街断言：把 10 个视图全渲染一遍，逐个 `<button>` 查 `onClick` |
| 文件夹选错了就永远改不回来 | 「选文件夹」页只在没有工作区时才可达，进去也没有返回 | 「更多工具」里加「换个文件夹」；已选过时那一页可以退回来 |

**测试**：`render-all` 92 → 104 → 107 → 118 → **123**（首页「聊着建」「整理材料」点得动 / 跳对页 / 不再带着上一个人，6 项；箭头收起不转、展开转，2 项；体检页「还能补的卡」点得动 / 落到那张卡 / 路径对，3 项）。新增断言用 `git show HEAD:plugin/lib/client.js` 验过会红 6 项。

### P2.8 — 界面上看不见头像（本轮修的）

`avatar.list`、`avatar.set` 早就有了，卡详情页和编辑表单也都能显示、能裁，
但**首页的卡列表从没用过**：`HomeView` 只画首字方块。用户存了头像，回到
首页却看不到，会以为没存上。

修法三处：
1. `refresh()` 里 `workspace.list` 之后追加一次 `avatar.list`，把整张头像表
   挂到 `listing.avatars` 上（一张卡一次请求，列表会变慢，所以一次取回）。
   取不到就整份当没有，不影响列表本身。
2. `CardRow` / `WorldRow` 新增 `photo` 参数并转给 `Avatar`；三组卡列表与
   世界书列表都传 `avatars[id]`。
3. 世界书详情页的大头像也接上（`listing.avatars[data.id]`）。

**测试**：`render-all` 123 → 128（列表行带头像时画 `<img>` 不画首字、首页
整棵树里真有 `has-photo` 方块）。两条都用「去掉 `photo` 传参」验过会红。

### P2.9 — 后台说的话里有技术黑话（本轮修的）

`render-all.mjs` 那条「黑话零命中」只扫**客户端渲染出来的文字**。后台路由的
`error` / `note` / `hint`、校验器的 `message`、打分器的 `fix` 是另一条路——
它们藏在 `lib/*.js` 里，客户端断言永远看不见，但一样会摆到用户眼前。

真实事故：用户点导出，界面弹出「这张卡的对象未满 18 岁（**birth_year: 2015**）…
要留档请用「**导出 JSON**」」——一句中文里塞了字段名和格式名。

这一轮把 20 多处扫干净，并新建 `test/wording-test.mjs`（12 项）把这条路堵上：
它从 `lib/{index,store,core,score,codec}.js` 里抠出所有
`error:` / `message:` / `note:` / `hint:` / `fix:` / `reason:` 和
`add('warn'|'error', …)` 的中文字面量，用与 `render-all` 同一套词表扫。
`${...}` 里的插值先剥掉再扫（那是代码不是文案，字段名叫 lifecard 不该算黑话）。

改过的几处举例：`materials/ 里没有材料` → 「还没有材料。先加一段文字，或者做一次访谈」；
`提案 JSON 读不了` → 「这份建议的文件读不了」；`所有模型路由都失败了：provider/model…`
→ 「AI 试了几次都没回上话」（原始详情挪到 `details` 字段，界面不显示）；
`约 N 个 token` → 「约 N 字」。

**顺手加的测试工具**（`test/render-all.mjs` 里）：`expand(node)` 把函数型节点就地展开成纯 DOM 树——`deepRender` 只「走」一遍不替换节点，直接用 `collectButtons` 抓不到 `<button>`；`h0(name, props)` 从 `seen` 里按组件名渲染一个；`clickByText(tree, '文字')` 找到含该文字的按钮并真的调它的 `onClick`。

---

## 用户是谁、该怎么跟他说话

李四，大学生，汉语言文学专业，**自述"IT 小白，基本上啥都不懂"**。所以：

- 任何技术内容**从最基础的概念讲起**，不要跳过名词解释。
- 界面上不出现 JSON/chunk/schema/proposal/workspace 这类词——这条已经做进测试断言了，别破坏。
- 他的验收方式是"打开看看能不能用"，不是读代码。**改完一定要重启 App 让他自己点一遍。**
- 他在意"指向性非常明确的按键"，讨厌"让人看了不知道是干什么的名字"。

---

## 给接手的人的第一句话

先跑这三条，确认环境是活的：

```bash
cd <仓库根>/plugin
node test/all.mjs                                      # 期望 736 通过
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "$DSH_GUI/api/dsh-lifecard/state.get" \
  -H 'content-type: application/json' -d '{}'          # 期望 200
node test/live.mjs "$DSH_GUI"                          # 期望 15/15
```

三条都绿，就可以直接从 P0 开始。有一条红，先修环境再说功能。
