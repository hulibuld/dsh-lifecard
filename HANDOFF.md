# Life Cards 交接文档

> 写于 2026-10-19 21:00 左右。给下一个接手这个项目的人（或下一个我）看。
> 读完这一份就该能直接开工，不用再去翻聊天记录。

---

## 一句话现状

**插件已经装好、在跑、测过了。** 侧边栏里能用，访谈 skill 已经注册进 DSH 并且模型能看见，全量测试 **622 项**通过，对一个真实运行的 DSH 实例做的端到端验收 **14/14** 通过。**P0（上传 GitHub 前的准备）、P1（陈旧文档）、P2（六项功能扩展）全部做完。** 之后又做了三轮加固：数据层 20 处隐患、编码/路由层 20 处隐患、测试补到 622 项。

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

**这已经是 git 仓库了**（`git init -b main` 已做，`main` 分支，首次提交 `4fa96c7`）。要上传 GitHub 只差 `git remote add` + `push`。

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
| `lib/client.js` | 2548 | **整个侧边栏界面**。纯手写，没有 React 依赖注入以外的框架 |
| `lib/index.js` | 1346 | 宿主侧：32 条 HTTP 路由、调用模型、**注册访谈 skill**、路径越界闸、导出 consent 闸 |
| `lib/store.js` | 1074 | 工作区、快照、墓碑 `redactions.jsonl`、提案与勾选旁路、头像、概念、doctor |
| `lib/core.js` | 946 | 零依赖：YAML 子集解析/序列化、卡片校验、覆盖率、**引文校验门** |
| `lib/codec.js` | 761 | PNG tEXt/iTXt 读写、CCv2/CCv3/CHARX、双 chunk 导出、保真字段 |
| `lib/prompts.js` | 454 | 11 类关系 × 问题库、`buildAnalyzePrompt` |
| `lib/score.js` | 329 | **纯本地**体检打分 0–100、字数估算、占位符与世界书健康度 |
| `skills/lifecard-interview/SKILL.md` | 192 | **会随包安装的那份**访谈 skill |
| `test/` | 12 个在 `all.mjs` 里 + `live.mjs`，另有 2 个工具 | 622 项断言 |
| `locale/{zh,en}.json` | — | 侧栏 tab 的标题与描述 |
| `cordis.patch.yml` | — | 装进 profile 时插入的插件条目 |
| `node_modules/@deepseek-ai/schemastery` | — | 软链，见下面坑 #2 |

---

## 现在能跑吗——验证证据

三条证据，都能自己复跑：

```bash
cd .../LifeCard/plugin

# 1. 全量单元测试：622 项
node test/all.mjs
# → roundtrip 9 / codec 37 / store 121 / score 51 / json-extract 10 / prompt 154
#   client-smoke 27 / skill-register 18 / routes 36 / hardening-routes 46
#   hardening-data 54 / render-all 59

# 2. 对真实运行的 DSH 做端到端验收：14/14
node test/live.mjs "$DSH_GUI"          # $DSH_GUI = 运行时上下文里那个 GUI URL

# 3. 界面文案自检（含"黑话零命中"）：59 项，已含在 all.mjs 里
node test/render-all.mjs
```

**2026-10-20 11:20 的实测结果**：`all.mjs` 622 项全过；`live.mjs` 14/14 全过。

live 那 14 项验的是：插件已激活 / 宿主有 llm / 建工作区 / 卡被列出 / 材料被列出 / 分析跑通 / 有可采纳条目 / 默认不勾选 / 每条都有引文 / 采纳成功 / 导出 PNG / 双 chunk 同源 / doctor 跑通 / 宿主段已写。

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

完整的 32 条路由：

```
state.get  workspace.init  workspace.inspect  workspace.list
card.get  card.save  card.delete
card.history  card.version  card.restore
avatar.set  avatar.remove  avatar.list
import.cards  import.text  import.textFile
export.card  export.json
material.add  material.list
analyze.run
proposal.list  proposal.get  proposal.check  proposal.apply
doctor.run
interview.questions  interview.plan  interview.record  interview.history
concept.get  concept.set
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
| 位置 | 原来写的 | 现在是 |
|---|---|---|
| `README.md:27` | 「96 项测试全部通过」 | 622 项 |
| `plugin/README.md:178` | `# 全部测试（96 项）` | 622 项 |
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

### P2.5 — 三轮加固（不在原计划里，已做完）

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

### P3 — 还没做的（都需要人点头）

1. **`defaultWorkspace()` 返回 `homedir()/LifeCard`**（`lib/index.js:42-44`）。是否改成 `homedir()/Documents/Life Cards`？改的话用户已经 seed 过 `~/LifeCard`，要处理迁移或兼容。
2. **顶层 `skills/lifecard-interview/SKILL.md` 与 `plugin/skills/lifecard-interview/SKILL.md` 内容完全相同**（md5 `02e0a2a6daf930b669ed4d9c594d793e`）。**只有 plugin 里那份会随包安装**。建议删掉顶层那份，或明确标成"设计稿，改内容必须同步两份"。
3. **四份原始文档**（使用指南/策划书/策划书-第二部分）已被 SPEC.md 取代。保留作背景材料，还是归档到 `docs/archive/`？
4. ~~**同一天对同一个人跑两次分析，第二次会覆盖第一次的提案与遗留记录**~~ → **已修（commit 见 `lib/store.js` 的 `freeProposalBase`）**。第一次仍用不带序号的老名字，撞上了才依次试 `-2`、`-3`；三个文件（`.md` / `.json` / `.checked.json`）一起占名，勾选不串台。`test/store-test.mjs` 第 14 组 12 项锁住，并用修复前的 `store.js` 验过会红 6 项。
5. **本地 HTTP 端点没有 Origin/CSRF 校验**，且任何请求都能用 `body.workspace` 改当前库。这是宿主 `/api` 的暴露面，不是本插件能单独修的，建议在宿主侧做 Origin 白名单。

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
node test/all.mjs                                      # 期望 610 通过
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "$DSH_GUI/api/dsh-lifecard/state.get" \
  -H 'content-type: application/json' -d '{}'          # 期望 200
node test/live.mjs "$DSH_GUI"                          # 期望 14/14
```

三条都绿，就可以直接从 P0 开始。有一条红，先修环境再说功能。
