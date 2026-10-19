# Life Cards 交接文档

> 写于 2026-10-19 21:00 左右。给下一个接手这个项目的人（或下一个我）看。
> 读完这一份就该能直接开工，不用再去翻聊天记录。

---

## 一句话现状

**插件已经装好、在跑、测过了。** 侧边栏里能用，访谈 skill 已经注册进 DSH 并且模型能看见，全量测试 405 项通过，对一个真实运行的 DSH 实例做的端到端验收 14/14 通过。**P0（上传 GitHub 前的准备）和 P1（陈旧文档）已经做完，P2 的功能扩展做了 4 项（共 6 项）。**

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

**不是**角色扮演平台，**不是**云端服务，**不是**简历生成器。

---

## 在哪

```
<仓库根>/
```

**注意：这不是 git 仓库。** 没有 `.git`，没有任何版本控制。要上传 GitHub 之前第一件事就是 `git init`，否则一次误删就没救了。

```
LifeCard/
├── HANDOFF.md          ← 本文件
├── SPEC.md             496 行，唯一数据契约。文档互相矛盾时以它为准
├── README.md           项目介绍（"为什么"），有几处数字陈旧，见文末
├── 使用指南.md         早期文档，已被 SPEC 取代，留作背景
├── 策划书.md           同上
├── 策划书-第二部分.md   同上
├── skills/lifecard-interview/SKILL.md   顶层副本（历史遗留，不随包安装）
├── .bak/               3 个旧 md 的备份
├── .bak-20261018/      2026-10-18 整份快照
└── plugin/             ← 真正的成品，所有代码在这里
```

### plugin/ 内部

| 文件 | 行数 | 职责 |
|---|---|---|
| `lib/client.js` | 1855 | **整个侧边栏界面**。纯手写，没有 React 依赖注入以外的框架 |
| `lib/index.js` | 1101 | 宿主侧：23 条 HTTP 路由、调用模型、**注册访谈 skill**（:994 起） |
| `lib/core.js` | 833 | 零依赖：YAML 子集解析/序列化、卡片校验、覆盖率、**引文校验门** |
| `lib/store.js` | 685 | 工作区、快照、墓碑 `redactions.jsonl`、提案、`applyProposal`、doctor |
| `lib/codec.js` | 676 | PNG tEXt 读写、CCv2/CCv3/CHARX、双 chunk 导出、保真字段 |
| `lib/prompts.js` | 430 | 11 类关系 × 问题库、`buildAnalyzePrompt` |
| `skills/lifecard-interview/SKILL.md` | 192 | **会随包安装的那份**访谈 skill |
| `test/` | 12 个 .mjs | 约 1500 行，405 项断言 |
| `locale/{zh,en}.json` | — | 侧栏 tab 的标题与描述 |
| `cordis.patch.yml` | — | 装进 profile 时插入的插件条目 |
| `node_modules/@deepseek-ai/schemastery` | — | 软链，见下面坑 #2 |

---

## 现在能跑吗——验证证据

三条证据，都能自己复跑：

```bash
cd .../LifeCard/plugin

# 1. 全量单元测试：405 项
node test/all.mjs
# → roundtrip 9 / codec 37 / store 38 / json-extract 10 / prompt 140
#   client-smoke 15 / skill-register 18 / render-all 56

# 2. 对真实运行的 DSH 做端到端验收：14/14
node test/live.mjs http://127.0.0.1:49192

# 3. 界面文案自检（含"黑话零命中"）：44 项，已含在 all.mjs 里
node test/render-all.mjs
```

**2026-10-20 03:40 的实测结果**：`all.mjs` 405 项全过；`live.mjs` 14/14 全过。

live 那 14 项验的是：插件已激活 / 宿主有 llm / 建工作区 / 卡被列出 / 材料被列出 / 分析跑通 / 有可采纳条目 / 默认不勾选 / 每条都有引文 / 采纳成功 / 导出 PNG / 双 chunk 同源 / doctor 跑通 / 宿主段已写。

**访谈 skill 确认可见**：本次会话注入的 skill 目录里已经有 `lifecard-interview`，描述是"引导式访谈，在对话里把一张人物卡问出来。用于「帮我建一张 XX 的卡」「继续上次那个访谈」「这张卡还缺什么」"。也就是说**用户现在在对话里说"帮我建一张我妈的卡"就会触发它**。这条不用再验了。

> 界面是不是新的？客户端 bundle 文件 `lib/client.js` 最后修改 13:45，桌面 App 进程启动于 20:08，**进程比文件新，所以跑的就是重写后的界面**。

---

## 装在哪、怎么生效

- 插件目录软链：`~/.dsh/profiles/desktop/node_modules/dsh-lifecard` → `.../LifeCard/plugin`
- profile 补丁：`~/.dsh/profiles/desktop/cordis.patch.yml` 第 1546–1548 行
  ```yaml
  - insert:
      - id: lifecard
        name: 'dsh-lifecard'
  ```
- `schemastery` 软链：`~/.dsh/profiles/desktop/node_modules/@deepseek-ai/schemastery` 存在
- **desktop profile 被 Electron 独占，改完必须重启 App 才生效，没有热重载。**
- 当前桌面实例端口 **49192**（早先是 49204，会变，以运行时上下文给的 GUI URL 为准）。
- `POST /api/dsh-lifecard/state.get` **不需要 token 就能打**（其它 `/api/*` 路由要 401），所以外部脚本能验插件。

完整的 23 条路由：

```
state.get  workspace.init  workspace.inspect  workspace.list
card.get  card.save  card.delete
import.cards  import.text  import.textFile
export.card  export.json
material.add  material.list
analyze.run
proposal.list  proposal.get  proposal.apply
doctor.run
interview.questions  interview.plan  interview.record  interview.history
```

---

## 已经做完的四轮改造（知道"为什么现在是这样"用）

1. **文档评审 → SPEC.md 定案**。四份原始文档互相矛盾，重写成 496 行的 SPEC.md 做唯一契约。kind 扩到 8 值（real/fictional/hybrid/self/lens/world/system/relation），必需字段按 kind 分层。
2. **砍掉"手机随手记"**。iOS Safari 到 27.2、Chrome for Android 155 都还不支持 File System Access API，这条做不到，改成"文本导入 + 角色卡导入 + AI 分析"。
3. **访谈从命令改成 skill**。用户明确要求"内置一个引导式建卡的 skill，在对话里给选项引导用户回答，最终构建出卡片"。所以访谈是 skill（对话里跑），不是侧边栏里的一个表单。
4. **界面按 IT 小白标准重写**。原来卡片编辑是把 `JSON.stringify` 塞进 textarea，被用户批评"太粗糙"。现在换成真表单（名字/称呼/他是谁下拉/关系/状态/正文四段/能力编辑器/禁忌/知情），按钮文案全部改成人话（"改这张卡"、"接着聊"、"写完了多少"），技术黑话（JSON/chunk/tEXt/CHARX/Zod/YAML/proposal/workspace）从界面上全部清除——`render-all.mjs` 有一条断言专门扫这个。

---

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
| 位置 | 现在写的 | 应该是 |
|---|---|---|
| `README.md:27` | 「96 项测试全部通过」 | 405 项 |
| `plugin/README.md:159` | `# 全部测试（96 项）` | 405 项 |
| `plugin/README.md:29` | 侧栏会出现**人物档案** | **Life Cards** |

另外 `plugin/README.md` 里的目录树和"三个入口"图还是旧说法，需要对着现在的界面重写一遍。

### P2 — 功能扩展（用户明确说要"借鉴成熟产品的功能设计"）

**进度：六项全部完成并提交**（1 打分、2 字数估算、3 头像裁剪、4 世界书编辑、5 概念→生成、6 版本历史）。

已经调研过两个 MIT 项目，**功能设计可以自由学，但代码按功能重写不要搬**（无 LICENSE 的仓库按著作权法默认保留一切权利，小改不改变；GPL/AGPL 有传染性，都不能并进来）。

值得抄的，按性价比排：

1. **离线体检打分 0–100**（来自 Cardwright）。现在 `doctor.run` 只做数据检查，不打分。加点：必填字段完整度、token 预算、占位符残留、`{{user}}` 冒名、世界书健康度，给出 0–100 分 + 每个问题可一键跳到对应字段。**不打模型，纯本地算，很便宜，用户感知强。**
2. **每字段实时 token 估算**（~4 字符/token，离线无 tokenizer 就够用）。酒馆用户非常在意 token 预算。
3. **头像与 2:3 裁剪**。现在导入的卡带图，但没有"换个头像"。
4. **世界书（Lorebook）可视化编辑**。现在只能整段 JSON 改，对小白不友好。
5. **概念 → 生成**（来自 Cardwright/airole）：先把"想要什么样的人"存成一个 concept，后续所有 AI 编辑都带上它。
6. **版本历史**。`store.js` 已经有快照机制（存全文，不存 diff），但界面上没有"看看以前的样子 / 回到某一版"。

### P3 — 待定的产品决定
- **`defaultWorkspace()` 返回 `homedir()/LifeCard`**（`lib/index.js:42-44`）。是否改成 `homedir()/Documents/Life Cards`？改的话，注意用户已经 seed 过 `~/LifeCard`，要处理迁移或兼容。
- 顶层 `skills/lifecard-interview/SKILL.md` 与 `plugin/skills/lifecard-interview/SKILL.md` 内容完全相同（md5 `02e0a2a6daf930b669ed4d9c594d793e`）。**只有 plugin 里那份会随包安装**。建议删掉顶层那份，或明确标成"设计稿，改内容必须同步两份"。
- 四份原始文档（使用指南/策划书/策划书-第二部分）已被 SPEC.md 取代。是保留作背景材料，还是归档到 `docs/archive/`？

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
node test/all.mjs                                      # 期望 311 通过
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  http://127.0.0.1:49192/api/dsh-lifecard/state.get \
  -H 'content-type: application/json' -d '{}'          # 期望 200
node test/live.mjs http://127.0.0.1:49192              # 期望 14/14
```

三条都绿，就可以直接从 P0 开始。有一条红，先修环境再说功能。
