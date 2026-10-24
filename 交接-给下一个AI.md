# 交接：给下一个接手 Life Cards 的 AI

> 写于 2026-10-24 01:20。上一轮上下文快满了，把「现在是什么状态、怎么验证、还剩什么没修、哪些线绝对不能碰」写在这里。
> 读完这份 + `HANDOFF.md`（工程细节、踩过的坑、历史决策）就能直接开工，不用翻聊天记录。
> 用户是电脑小白（他自称「IT 小白」），验收方式是「打开点一遍看能不能用」，不看代码。

---

## 0. 三十秒定位

- 项目：`/Users/joyfon620/Documents/deepseek-harness/default-workspace/LifeCard/`
- 是什么：DSH（DeepSeek Harness）的侧边栏插件，本地优先的人物档案库——把身边的人写成 Markdown+YAML 的「卡」，带关系网、题料、AI 抽取（**每条断言必须有原文引文**）、求职与模拟面试。
- 代码在哪：全部在 `plugin/`。`plugin/lib/` 12 个模块（新增 `tavern.js` 387 行），`plugin/test/` 20 个文件。
- 当前状态：`main` 分支，工作区干净，HEAD = `a12f9b7`，共 99 次提交。
- 测试：全量 **1891 项**通过（19 个测试文件）；对一个真实运行的实例做端到端验收 **22 项全过**（`test/live.mjs`，含两次真模型调用：分析 + 酒馆里让 TA 回一句）。
- 发布：**没有发到 GitHub，也不许由你发**（用户明确「不发，我自己发」）。`research/` 已被 `.gitignore` 排除（用户说「调研报告不要发」）。
- 给朋友用的试用包：`dist/LifeCard-试用版.zip`（已拷到 `~/Desktop/`），里面有 `先看这里.md` 和 `install.command`。

---

## 1. 开工前必须跑的三条验证（全绿再动手）

```bash
cd /Users/joyfon620/Documents/deepseek-harness/default-workspace/LifeCard/plugin

# ① 全量单元/渲染测试。期望「合计 1891 项，全部通过。」
node test/all.mjs

# ② 端到端验收（打一个真实运行的 DSH 实例）。期望 15 passed, 0 failed。
#    退出码：0 = 全过；2 = 没找到实例（等于没验，不算通过）；1 = 有失败。
#    例外：如果「分析跑通」这一条失败，后面 4 条会连带跳过，只跑 11 项。
#    那是宿主那条模型路由的问题（见第 7 节），不是插件逻辑坏了。
node test/live.mjs http://127.0.0.1:<端口>

# ③ 确认插件在宿主里激活了。期望 200。
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:<端口>/api/dsh-lifecard/state.get \
  -H 'content-type: application/json' -d '{}'
```

**端口每次重启 DSH 都会变**（历史值 49192 → 53872 → 61837 → 56399 → 59411 → 50402 …）。正确取法：读当前会话的运行时上下文里那句 `Current DeepSeek Harness Web GUI URL`，别照抄文档里的旧端口。
`live.mjs` **必须在 `plugin/` 目录下跑**（它按相对路径找样本文件）。`test/all.mjs` 也一样——在 `LifeCard/` 根目录下跑会报「0 项、17 个文件失败」，那是没跑起来，不是测试坏了。

---

## 2. 环境与生效方式（最容易踩的一条）

- 插件是用**软链**装进 desktop profile 的：
  `~/.dsh/profiles/desktop/node_modules/dsh-lifecard → 上面的 plugin/`
  所以改源码立刻进磁盘，但**桌面 App 不会自动加载**。
- **desktop profile 被 App 独占、没有热重载**。改完 **lib/** 里的东西，必须让用户**完全退出 DSH App 再打开**；只改 `client.js` 时让用户 **Cmd+Shift+R 硬刷新**也常常够，但保险的做法仍是重启。
- 宿主侧（`index.js` 等）改动不重启就不会生效——`curl` 新路由返回 `{"ok":false,"error":{"code":"not-found",…}}` 就是这个问题，**不是 bug**。
- **绝不在 App 运行时删除/替换正在加载的插件目录**：会触发文件监听重载失败、适配器注销（表现为 `no adapter registered for provider "raccoon"`）。而且**编辑大文件时赶上一个保存中途的重载，也会让入口 import 失败**（`web boot: 1 entry did not activate`），下一次保存就好了，别慌。
- 别用 `dsh plugin add <路径>` 装：它底层是 pnpm add，会重解析整棵依赖树、把 profile 里所有插件按锁文件重装一遍，**会冲掉手工打过补丁的插件**。

---

## 3. 代码地图（改哪儿看哪儿）

`plugin/lib/`（行数为实测）：

| 文件 | 行 | 职责 | 关键导出 / 位置 |
|---|---|---|---|
| `client.js` | 4354 | 整个界面（手写 React.createElement，无构建步骤），一个 tab + 主区域页 + 左侧栏图标 | `LifeCardTab` 根组件；`VIEWS`；各视图 `HomeView` / `NewCardView` / `ImportView` / `InterviewView` / `MemoryView` / `AnalyzeView` / `ProposalPanel` / `CardView` / `CardForm` / `HistoryPanel` / `DoctorView` / `JobsView` / `MockView`；`call()` 在文件上部（它把对象形状的 error 压成一句话） |
| `index.js` | 2316 | 宿主插件：注册 webServer 路由、skill、`callModel` | `buildApi(ctx, workspace, config)`（导出的，测试就用它直接调路由，不用起服务器）；`callModel` + `withTimeout` + `MODEL_TIMEOUT_MS`（150 秒上限）；`exportBlockedBy`（导出门禁） |
| `store.js` | 1572 | 磁盘层：读写卡/材料/提案/草稿/快照/头像/墓碑/求职 | `resolveIn`（越界闸）、`readMaterials`、`saveProposal`、`applyProposal`→`applyItem`（三态 `applied/duplicate/skipped`）、`deleteMaterial`、`writeDraft/readDraft`、`listSnapshots/restoreSnapshot` |
| `core.js` | 1019 | 数据契约：YAML 解析、卡解析/校验、覆盖度、**引文闸门** | `verifyQuote`、`verifyProposal`、`PROPOSAL_FIELDS`、`validateCard`、`stringifyCard/parseCard` |
| `codec.js` | 785 | 角色卡格式编解码 | PNG tEXt/iTXt、CHARX zip、CCv2/v3/V1、`exportCardPng` |
| `prompts.js` | 497 | 提示词与题库 | `RELATION_TYPES`（14 类，带 `bank`）、`RELATION_EXTRAS`、`QUESTION_BANK`、`questionsFor`、`buildAnalyzePrompt` |
| `jobs.js` | 607 | 求职纯逻辑（零网络、零 fs） | 两遍读法提示词、五档重要性/三档证据、`checkJdPass`/`checkMatchPass`/`checkDealbreakers`/`renderReport`/`findNetwork` |
| `jobs-store.js` | 467 | 求职落盘 | `saveEvaluation`、`readTracker`/`addApplication`/`updateApplication`、`readStories`/`addStory`、`readJobProfile`、`saveInterview` |
| `jobs-interview.js` | 434 | 模拟面试纯逻辑（零 import） | 禁问表 `FORBIDDEN_TOPICS`、`checkQuestion`、`reviewAnswer`、`pickTarget`、`buildTurnPrompt`、`renderTranscript` |
| `memory.js` | 454 | 从本机记忆/项目档案里认人（只读 `~/.mnemon`） | `readMemory`、`findPeople(text, strict)`、`findPeopleIn`、`renderMemoryMaterial` |
| `score.js` | 329 | 离线体检打分（0–100），只 import `core.js` | `scoreCard`、`scoreAll`、`estimateTokens`、`findPlaceholderIssues` |

`plugin/skills/lifecard-interview/SKILL.md` 是随包安装的访谈 skill（**只有这一份**；仓库根目录曾经有过一份重复的，已删掉，别再加回来）。

数据落盘布局见 `SPEC.md §1`（`people/ relations/ worlds/ materials/ proposals/ story/ assets/ jobs/ .lifecard/`）。

路由共 **49 条**，前缀 `/api/dsh-lifecard`，方法名形如 `card.get`；清单见 `HANDOFF.md` 的路由表，或 `grep -oE "'[a-z]+\.[a-zA-Z]+':" plugin/lib/index.js | sort -u`。

---

## 4. 五条铁律（违反任何一条都算退步）

1. **界面不许出现技术黑话**：`JSON / chunk / schema / proposal / workspace / YAML / materials/ / doctor / frontmatter / snapshot / lens / consent / basis / recorded_at …`。
   门禁在 `plugin/test/render-all.mjs` 的 `const forbidden = [...]`，**不许删、不许绕过**。`plugin/test/wording-test.mjs` 另扫后台源码里回给界面的字符串。
2. **核心闸门不能动**：`core.js` 的 `verifyQuote`/`verifyProposal` —— 每条 AI 断言必须能在材料里找到逐字原文，找不到就丢弃。任何「让它松一点」的改法都要先问用户。
3. **注册 skill 不能用 `export const inject`**：用 `ctx.reflect?.get?.('skills', false)` 探测 + `ctx.effect(() => skills.register(...))`。加进 inject 会让精简 profile 起不来。第三方服务同理（`betterSidebar` 已从 inject 里拿掉，只剩 `['slots']`）。
4. **`plugin/package.json` 的 `files` 必须含 `skills/**/SKILL.md`**，新增 `lib/*.js` 也要加进去（否则装机后丢文件）。`npm pack --dry-run ./plugin` 自查。
5. **借功能可以，借代码要看许可证**：MIT/Apache 可复用；无 LICENSE ≠ 免费；GPL/AGPL 不能并入。当前只在思路上借了三个 MIT 项目（见 `plugin/README.md` 末节），没用任何别人的代码。

另外两条用户级硬要求：
- **界面不加空库引导**（用户：「我不需要导引」），但**成品文档要有引导文案**。
- **不许含真实隐私**：示例一律「张三/李四/王先生/某公司/1970 年」。历史上做过一次全库 + git 历史脱敏，**别再写回真实姓名、单位、家庭细节**。

---

## 5. 这一轮（2026-10-23~24）做了什么

用户报的原话：「比如你用完一条建议后，那条建议就应该消失掉……我又点了一下，发现关系史就复制了两段进去。别的方面的话，我感觉 bug 还是很多，你要不再多修改一下，确保这个交互逻辑是符合直觉的。」

已修并提交（从旧到新）：

| commit | 修了什么 |
|---|---|
| `0ae8afa` | 「都不要」真把那份建议从待办撤掉（新增 `.dismissed.json` 旁车 + `proposal.dismiss` 路由）；采纳过的条目不再留在列表；搜索也筛材料 |
| `b4d1b0b` | 访谈答一句失败就停、不假装继续；投递表被程序重写时不抹掉用户手写的备注；草稿失败当面说；采纳提示报真实条数 |
| `1afb03d` | 「不要了」的提示不再误报「本来就有」；建议超过 6 份时说明还有几份；卡没建成 / 草稿没存上都会说 |
| `76d54c0` | **模型不回话时最多等 150 秒就认输**（`withTimeout`），界面不再无限转圈 |
| `713f5ef` | 「下一步」页读不到内容时不再显示成「空」 |
| `0caba98` | **「下一步」改公司名当场报错**（`dropReport` 定义在 `AnalyzeView` 里、却被 `JobsView` 用）；没建卡时首页不再吞掉材料和待办；勾材料点一下是「去掉这份」；改文件夹路径就重查；练过的记录读不到不再说「还没练过」 |

另外新增了一条**很值钱的测试**：`plugin/test/render-all.mjs` 末尾的 `pokeHandlers()` —— 把每个页面里所有 `onClick/onChange/onSubmit/onFocus/onBlur` 都真的调一次，断言不抛错。上面那个 `dropReport` 崩溃就是它抓出来的（把它改回去，它会红）。

### 2026-10-24 上午这一段（`a2c8f5a`，1494 → 1570 项）

用户的指令只有一句：「接手上一个 AI 的任务，继续工作，修改 bug 等。建议开两个没有上下文的子代理进行审核。」

**先跑的基线**：`node test/all.mjs` 1494 项全过、`live.mjs` 15 passed、`state.get` 200 —— 也就是说上一轮交的是绿的，问题都在下面那些边界上。

**A. 交接文档第 6 节遗留的 5 条，全修完**

| 条目 | 一句话修法 |
|---|---|
| P0-1 访谈「今天到这」吃掉刚写的话 | 「结束这次访谈」挪到 `talk` 页顶部一行（带「这一题不记」小字），底部那排只剩记下/跳过/不想说；输入框有字时先 `window.confirm` 问一句；结束页按 `dropped` 照实说「刚才那一题没存进去」，不再一律说「都记下来了」 |
| P0-2 编辑表单最后 1.5 秒的字会丢 | 抽出 `flush`，`flushRef` 存它；新增只挂一次的卸载 effect，卸载时把还没落盘的那次草稿补发一次（`draft-flush-test.mjs` 自带会跑 effect 的迷你 hooks 运行时，变异验证过：把清理函数改空会红 3 条） |
| P0-3 导入页 → 分析页「这是关于谁」是空的 | `TextImport` 存完把 `{name, path}` 一起传给 `onAnalyze`；父层去 `listing.cards` 里找同名的卡（有就带 id，没有就带名字）；`AnalyzeView` 既认 id 也认名字，并给「还没有这张卡」一行灰字说明；顺手修了 `materialFor` 一旦设过就永远留着（换页不清） |
| P1-1 plan 失败留下空卡 | plan 失败时，如果这张卡是这一次刚建的，先 `card.delete` 撤掉（本来就有的卡不动），文案里说清楚撤了 |
| P1-2 重名默默复用旧卡并改关系 | 不是从那张卡「接着聊」进来的（`preset.id` 为空）就先问一句「点好=接着补，点取消=换个名字」；并且**只给还没写过关系的卡补关系**，已经写着的（「父亲」）不再被这次点的（「朋友」）盖掉 |

**B. 第二个审查子代理（无上下文，只读冻结副本）报回来 8 条，也全修完**

审的是 `git archive` 出来的 `/tmp/lifecard-review2-20261024-100145/`（md5 记在那儿的 `md5.txt`）。它自己核对过 49 条路由与前端 40 个 `call()` 方法，无缺失、无原型链穿透。

| 严重度 | 问题 | 修法 |
|---|---|---|
| P1 | `jobs-store.js` 的 `readInside` 把「读失败」和「没这个文件」都返回 null，于是 `addApplication` 的整表重写会用一行顶掉用户全部投递记录 | 新增 `readInsideState`（只有 `ENOENT` 才算「没有」，别的错返回 `ok:false`）；`readTracker` 读失败直说；`addApplication` / `updateApplication` 在 `current.ok !== true` 时拒绝写 |
| P1 | `job.evaluate` 存盘失败静默，返回 ok:true 且无 path，用户以为归档了 | 失败时给 `result.saveFail`，界面在报告最上面用红框说「现在它只在屏幕上，先复制走」 |
| P1 | `callModel` 里 `handle = await withTimeout(llm.stream(...))`，超时是在赋值前抛的，`handle` 恒为 null，那句 `abort` 永远打不中 | 先留住 `pending` 并挂 `then` 接住 handle；catch 里手里没有就等它交出来再 abort（`job.resume.build` 的存盘失败也补了 warning） |
| P2 | 访谈「跳过」和「不想说」实际等价：台账里只要有一行就按「问过了」砍掉，`sealed` 判断和 `deferred` 重排都是死代码 | `answeredIds` 只收 `status === 'answered'`，`sealed` 单列；跳过的排到队尾，下次还会再问**一次**，跳过两次才不再问（否则同一题会一直转回来） |
| P2 | `listEvaluations` / `listDrafts` 读失败返回 `ok:true + []`，前端「读失败」分支永远不触发 | catch 里区分 `ENOENT`（真空表）与其它错（`ok:false`），三处 `readdir` 一起改（含 `listInterviews`） |
| P2 | 投递表单元格不转义：公司名里一个 `\|` 或换行就把整张表写坏 | 写端 `cell()` 转义 `\|`、换行压成空格；读端按未转义的 `\|` 切分并还原 |
| P2 | 存评估/草稿找空位用的是「读不出来」，读不出来的文件被当空位直接覆盖 | 空位探测改用 `readInsideState` 的 `exists`；读不出来就报错不写 |
| P2 | 路径闸只做字面包含判断，工作区里一个软链就能读写出去 | `insideWorkspace` 与 `store.resolveIn` 都改用 `realpathLoose`（求最深已存在祖先的实体路径再拼回来）按实体路径再判一次；17 处 `insideWorkspace` 调用、6 处 `resolveIn` 调用改成 `await` |

顺带：`interview.record` 的日期从 `toISOString()`（UTC）改成 `store.localDate()`，跟 `materials/` 里的命名一致（东八区早八点前不再差一天）。

**新增的回归断言**（都验过「改回去会红」）：
- `test/render-all.mjs`：导入→分析带人（5 条）、plan 失败撤空卡 / 重名先问 / 重名不覆盖关系 / 说不换了就一个请求都不发（8 条）。测试里要临时换掉 `globalThis.fetch` 和 `fakeWindow.confirm`，**结尾必须换回去**。
- `test/jobs-test.mjs`：表读不出来时拒绝记、原来的表一个字节不动、目录被换成文件时列表直说、同名位置读不出来不覆盖、带竖线/换行的公司名能原样读回（16 条）。
- `test/hardening-routes.mjs`：跳过还在队列里且排到最后、不想说不再问、答过不再问、`askedAlready` 口径（7 条）；软链往外读写被拒、工作区外没有落文件、指回内部的软链不误判（5 条）。
- 新文件 `test/draft-flush-test.mjs`（8 条，自带会跑 `useEffect` 的迷你 hooks 运行时）。

---

### 2026-10-24 下午这一段（`e0cc4ee` → `1cbf4c6` → `a7ac9b1`，1570 → 1754 项）

用户的指令：「进侧边栏先分：你要用哪个功能，酒馆（角色扮演）还是写小说还是真实人物的记录？选哪个我就开哪扇门出来给你编辑。找工作这个功能只出现在真实人物那扇门后面」；接着「你说你的建议是先做酒馆的对话（角色卡和世界书已经能管了，差一个能开口的地方），再做小说的章节。那就听你的」。

| commit | 做了什么 |
|---|---|
| `e0cc4ee` | 换文件夹不再预填 `~/LifeCard`（P0：会把库切走）；选过的文件夹写进 `~/.dsh/plugin-data/dsh-lifecard.json`，重启还记得；分析页读不出建议不再冒充「没有新东西」；模拟面试按钮不再卡死；导入页切栏不丢稿；删材料/体检/存偏好这几处失败会说话 |
| `1cbf4c6` | 三扇门（真实人物记录 / 写小说 / 酒馆），找工作只出现在真实人物那扇门里 |
| `a7ac9b1` | **酒馆能开口了**：卡 + 世界书 → 你一句我一句；会话是 `chats/<id>.md`；TA 不回话时我说的那句照样存盘；酒馆那屏列「说过的场次」，点一下接着聊。另外兜底 catch 把 stack 落到 `<tmpdir>/dsh-lifecard-errors.log` |

酒馆这块的接口与约定（改之前先看 `plugin/lib/tavern.js` 顶部注释）：

- 路由：`tavern.list` / `tavern.start` / `tavern.get` / `tavern.say` / `tavern.delete`（都在 `lib/index.js` 路由对象末尾）。
- 会话文件：YAML frontmatter（`kind: chat`、`id`、`card`、`card_name`、`world`、`turns`…）+ `## 对话` 段；每轮 `### 说话人` + 空行 + 正文。**用 `###` 而不是「名字：」前缀**，因为用户自己会打冒号。
- 人设：`自述/性格/口癖/外貌/关系史` 进人设，`开场白` 当第一句，`不会说的话/不会做的事` 当约束，`创作者备注` 不进（那是作者的笔记，不该念出来）。
- 世界书：`constant: true` 或没有 keys 的每轮都带；其余按最近六句命中关键词才带；总量 ≤ `MAX_WORLD_CHARS`。
- 「TA 没回话」是常态（网/模型）：`tavern.say` 失败时**先把我说的话写盘**再返回 `ok:false`，前端把 `r.turns` 照画，避免用户重打一遍最后出现两份。

### 2026-10-24 傍晚这一段（`12a3bf4` → `da30537` → `aa5b92d`，1754 → 1829 项）

用户在使用中报了六条，原话是「用户使用时困惑越少越好，容易出 bug、起冲突的地方越少越好。集成到一块儿更好。用户要操作的事情也越少越好。」：

| commit | 做了什么 |
|---|---|
| `12a3bf4` | ①「接着聊」不再问一遍关系（`InterviewView` 新增 `prep` 相位）②酒馆门里现实人物的卡默认折叠 ③新增 `card.fork`——拿去演的是**独立副本**，改副本动不到原卡 ④「聊着建」按门分题库与配色（现实问关系、紫；虚构问性格口癖、蓝/橙）⑤三扇门改成大卡片 |
| `da30537` | **`analyze.run` 一直是 500 的真因**：宿主 `llm.stream()` 有时直接返回建好的 handle，不是 Promise，我上一轮为修 abort 写的 `pending.then(...)` 必抛。现在两种形状都认 |
| `aa5b92d` | 改完「想突出的/不想要的」直接点「开始读」会带上新写的（以前发的是上一次存的那份）；换页时清掉上一次待建卡的人名 |

这一段的关键约定：

- `InterviewView` 的相位是 `prep | pick | talk | done`。`prep` 只在「从一张已有的卡点『接着聊』进来」（`preset.id` 非空）时出现，自动调 `interview.plan`，失败退回 `pick`。
- `interview.plan` 现在收 `kind`（`real` / `fictional`）；虚构题库在 `prompts.CHARACTER_QUESTIONS`，`fills` 的字段名必须存在于 `core.coverage` 那张表里，否则完成页会报「还空着」却填不上。
- `card.fork`：复制 `data`，`id` 加 `-role`（重名就 `-2`…`-40`），`kind: 'fictional'`、`forked_from` 记原卡路径、**`delete data.cc`**（不带走酒馆/ST 的嵌入数据）。原卡一个字节都不动。
- 三扇门不是另存的状态，是「当前在哪一屏」：`mode` 由 `view` 推出来（`novel` / `tavern` / 其它都算 `real`）。

### 2026-10-24 晚上这一段（`14309f3`，1829 → 1869 项）：两个无上下文审查员的结论

用户要求「多让智能体审核，不要用主控主观判断」。按老办法冻结快照（`/tmp/lifecard-review3-20261024-184156/`）后**串行**开了两个只读审查员：A 审前端与本次改动、B 审后台与数据安全。两人都只报能指出行号的，合计 17 条，全部逐条核实为真，全部已修：

| 严重度 | 问题 | 修法 |
|---|---|---|
| P0 | 酒馆「收个尾」收到的备忘，下一句话时被静默摘掉（`writeChat` 没带 `notes`） | 两处写回带 `notes`；frontmatter 不再把数组往里塞 |
| P0 | 回话里一行 `## xxx` 就会把后面半场对话当成「备忘」吞掉（`### xxx` 还会把说话人串改） | 写盘前给行首 `#` 加反斜杠、读回时削掉；文件仍是人能直接读的纯文本 |
| P0 | 每条路由的「工作区」都听请求体的（`root(body)` 直接 `path.resolve`），任何网页都能把库指到别处再删素材 | 只认当前这个库；换库只有 `workspace.init` 一个入口。另加两道闸：只收 `application/json`（跨站带不上，带了要预检）、带了 Origin 就必须同源 |
| P1 | `card.fork` 第 40 份会盖掉已有的那份；`stat` 与写之间没原子性 | 改成 `fs.open(..., 'wx')` 占位再写，占不到就换号，40 份用完说人话；写失败会撤掉占位文件 |
| P1 | `callModel` 其实不接受「直接给 handle」，真宿主上是它 500 | `Promise.resolve(llm.stream(...))` 包一层，两种形状都认（`da30537` 的再收口） |
| P1 | 全插件没有原子写，会话每轮整文件覆盖且无快照 | `writeChat` 改「临时文件 + rename」 |
| P1 | `tavern.say` 读-改-写无锁，双击发送会吞掉一轮 | 按会话 id 串行（`oneAtATime`） |
| P1 | 到 400 句上限时拒绝，但刚打的那句不落盘、界面照显 | 拒存前先写盘 |
| P1 | 同名两张卡（`card.fork` 正好造出这种同名对）时「接着聊」会把整场访谈记到副本上 | 先按 id 精确匹配，再按名字兜底 |
| P1 | prep 屏的「再试一次」是死按钮（`setPhase('prep')` 同值 bail out），虚构那两扇门里没有退路 | 直接重跑 `start()`；退路按钮无条件给出（虚构门是「重新填一下名字」） |
| P2 | `card.fork` 把 `data.cc` 整个删掉，卡里自带的世界书条目一起没了 | 只清来路标记（`source_file`/`png`/`imported_at`/`spec`），`cc.fields.character_book` 留下 |
| P2 | 虚构角色的完成度把「关系/出生年/同意状态」算进分母，永远顶不满 | `core.coverage(data, sections, { kind })` 对 `fictional` 跳过这三项 |
| P2 | `card.save` 漏传 `sections` 会整篇清空还报成功 | 缺省时按磁盘上那一份的正文补上 |
| P2 | 同名世界书原地覆盖，`.lifecard/raw/` 原件一起没 | 导入时挑没被占的号（`-2`、`-3`…） |
| P2 | `forked_from` 会记绝对路径（带用户名） | 一律记相对路径 |

- 新增回归测试 40 项（`tavern-test.mjs` 8→92、`hardening-routes.mjs` →159、`render-all.mjs` →457），其中「小标题吃对话」「备忘被抹」「400 句丢字」「并发吞一轮」「同名卡记错人」「死按钮」六条都验过会红。
- 审查员 A 还提醒了一个**测试盲区**：`render-all.mjs` 的假 React 里 `useEffect` 只占槽位、从不执行，所以「自动开始」「卸载补存」这类逻辑它测不到——那部分只能靠 `draft-flush-test.mjs`（会跑 effect）或人工验。下一轮如果要钉 prep 的自动开始，得把 `InterviewView` 加进那个文件的 `EFFECTED` 白名单。
- 审查员 B 提的「快照里跑测试只有 1484 项、5 个文件失败」不是仓库的问题：`git archive` 出来的 `plugin/` 没有 `node_modules`，`@deepseek-ai/schemastery` 找不到。真仓库里 1869 项全过。

### 2026-10-24 深夜这一段（`a12f9b7`，1869 → 1891 项）

用户在使用中报：「开酒馆还是写小说，点聊着建，它都说『你在记录一个现实中的人』」。

**真因**：`mode`（我在哪扇门）是从「当前在哪一屏」推出来的：

```js
const mode = view === VIEWS.novel ? 'novel' : (view === VIEWS.tavern || view === VIEWS.tavernChat) ? 'tavern' : 'real'
```

一进「聊着建」，`view` 就变成 `interview`，于是不管从哪扇门进来都退回 `real`。**子页面不是门，门要跟着人走。**

修法：门改成独立状态 `const [door, setDoor] = useState('real')`，`pickDoor` 里 `setDoor(next)`；`mode` 只在门自己的两屏用 `view` 判断，其余屏一律用 `door`。

同批还改了：

- 三扇门改成**竖排大卡、撑满整屏**（`minHeight:'100%'` + 每块 `flex:'1 1 0'` + `minHeight:104`），每块带图标、标题、一句说明和三条「里面有什么」。
- 三扇门的「聊着建」都给出来了（以前空库时，小说/酒馆门第一块是「先立一个人」的空白表）：标题按门变（陪我聊聊 / 聊着立一个小说角色 / 聊着立一个能演的角色），配色也跟着门走（紫/蓝/黄）。

**新增 `plugin/test/doors-test.mjs`（20 项，必须单独一个文件）**：它从根组件点下去——点门 → 点「聊着建」→ 看那一屏说的是哪扇门的话。为什么不能塞进 `render-all.mjs`：那边是「给组件直接塞 mode」的写法，测不出「点门之后 mode 有没有跟上」。**这条 bug 在 1869 项全绿的情况下存在，就是活证据。**

变异验证过：把 `mode` 改回旧的 `: 'real'`，这个文件立刻红 5 条，失败文案正是用户看到的那句。

注意根组件的 hook 槽位（实测 25 个）：0 view / 1 state / 2 listing / 3 busy / 4 error / 5 toast / 6 activeCard / 7 proposal / 8 doctor / 9 interviewFor / 10 showMore / 11 activeWorld / 12 pendingAbout / 13 introSeen / 14 materialFor / 15 ref / 16 chat / 17 chats / **23 door** / 18-22 是后续 effect 占的。`render-all.mjs` 的 `base()` 只预设到 10，其余靠默认。

## 6. 还没修的问题（本节已清空：上一轮的 5 条全修完，见第 5 节）

上一轮遗留的 P0-1 / P0-2 / P0-3 / P1-1 / P1-2 五条已在 `a2c8f5a` 全部修完并补了断言，行号也随之变了，别再照旧行号找。**要接着改，先按第 1 节跑一遍验证，再 `grep -n` 重新定位。**

### `analyze.run` 那个 500（**已定位、已修，重启后要复验**）

真因是 `callModel` 里的 `pending.then is not a function`：宿主 `llm.stream()` 有时直接返回一个建好的 handle，不是 Promise（stack 见 `<tmpdir>/dsh-lifecard-errors.log`，`da30537` 已修）。本地假 llm 全都写成 `async () => (async function*(){…})()`，永远 thenable，所以这条路只在真宿主上走过——`test/hardening-routes.mjs` 现在两种形状都测。

复验过：`node test/live.mjs http://127.0.0.1:50084` → **22 passed, 0 failed**（含酒馆开一场、让 TA 回话、复制一份来演）。假如以后又出现瞬时 500，日志文件还在那儿，`tail -40` 就能拿到 stack。

### 酒馆还差的（按价值排序）

1. **「收个尾（记忆总结）」**：说久了前面会记不住（现在只带最近 24 轮、总量有上限）。做法：把更早的对话让模型压成三五句「到这儿为止发生过什么」，写进会话文件的 `## 到目前为止` 段，之后每轮都带上。
2. **剧情三选项**：ST 的老习惯——TA 回完给三个「你可以这么接」的按钮，降低不会接话的门槛。要注意别让它变成替用户做决定。
3. **从酒馆反过来回到卡**：演着演着发现人设不对，现在只能退出到首页再改卡。
4. **流式输出**：现在是「说完才出现」。不是必需，但 150 秒上限下，长回复会让人以为卡住了。

### 然后才是小说章节编辑器（用户已同意这个顺序）

用户原话：「小说的章节编辑器」。现在「写小说」那扇门点进去只是首页换了分组，还没有章节、没有大纲、没有前后文衔接。建议的最小形态：世界书 → 角色卡 → 章节列表（`chapters/001.md`…）→ 每章带「上一章结尾」和「本章要点」→ 生成/续写 → 定稿。**动手前先跟用户确认要点清单**，别自己定。

### 这一轮**没做**、值得下一轮看的（都不是会导致丢数据的级别）

1. **两个审查子代理只活下来一个。** 第一轮并行开的两个（一个审前端交互、一个审宿主侧）里，审前端那个上下文耗尽、无任何产出（这台机器上并行开多个子代理很容易这样，见第 8 节）。第二轮改成**串行**：冻结 `git archive` 快照 → 先让宿主侧那个跑完 → 再开前端那个。下次照这个做法。
2. **`callModel` 的 abort 修复没有自动化测试。** `MODEL_TIMEOUT_MS = 150000`，测超时要把这个常量做成可注入的才行，暂时只做了代码审查 + 人工推理。要补的话：给 `callModel` 加个内部参数或让 `withTimeout` 的毫秒数走 config。
3. **`AnalyzeView` 的「你想让 TA 是什么样的人」补了个卸载补存**（`conceptDraftRef` + 空依赖 effect），这条也没有自动化测试覆盖——`render-all.mjs` 的假 React 不跑 effect，`draft-flush-test.mjs` 只白名单了 `CardForm`。要测就把那个文件的 `EFFECTED` 加上 `AnalyzeView`。
4. **`job.evaluate` 的 `saveFail` 没有端到端测试。** 它要真的让模型跑一次并让写盘失败，成本高；现在靠 `jobs-test.mjs` 里同型函数（`saveEvaluation`）的返回值测试兜着。
5. **`package.json` 的 `author` 和 `plugin/LICENSE`**（MIT，版权写 Yuzhou）是上一轮结束时加到工作区的，本次提交一起带上了。发 GitHub 前确认署名和版权年份要不要改。
6. **`research/` 之外还有没有不该发布的文件**：`git ls-files | grep -v '^plugin/'` 看一下根目录那几个 docx / 策划书，用户明确说不发 `research/`，其余没表态。

### 要不要修，可以问用户（P2，别自己拍板）
- `策划书.md` / `策划书-第二部分.md` 要不要随包发布（`research/` 用户已明确不发布，已在 `.gitignore` 里）。
- 用户自己发 GitHub 时用哪个仓库名、写什么简介。
- v0.2 的独立命令行（`npx lifecard …`）要不要做——现在文档里已统一标注「v0.2 计划，未实现」。

## 7. 「分析」卡住不动的根因（已修，重启后生效）

**症状**：点「分析」，界面一直转；约 5 分钟后报 `fetch failed`（宿主 HTTP 层先断连）。`test/live.mjs` 里表现成「分析跑通」失败，并连带跳过 4 条 → 只跑 11 项、10 passed 1 failed。

**根因（2026-10-24 01:2x 查明）**：
这台机器的 desktop profile（`~/.dsh/profiles/desktop/cordis.patch.yml:185`）里，主 agent 用的是
`provider: raccoon / model: sn-deepseek-v4-1-flash-1017`。
而 `plugin/lib/index.js` 的 `resolveRoute()` 里「首选 provider 序列」原本是
`['deepseek-official','deepseek-account','deepseek','buddy']` —— **没有 raccoon**。
于是插件去挑了列表里另一个 provider：那个 transport 接受请求却不回话，就一直挂着。

**已修**：
1. `resolveRoute` 的首选序列改成 `['raccoon','deepseek-official','deepseek-account','deepseek','buddy']`（注释写清了为什么 raccoon 必须第一：插件用的模型应当就是用户正在用的那个）。
2. `callModel` 里对 `llm.stream` 和 `collectStream` 都套了 `withTimeout(..., MODEL_TIMEOUT_MS = 150000)`，超时当一次失败、去试下一个候选，并把坏的 handle `abort()` 掉。
3. 回归测试：`plugin/test/hardening-routes.mjs` 末尾「模型路由」组 3 项 —— 用假 llm（buddy 在前、raccoon 在后）调 `analyze.run`，断言首选是 `raccoon/...`、不是 `buddy/...`、且分析能跑通。

**重启后请复验**：`node test/live.mjs http://127.0.0.1:<端口>` 应当变成 15 passed；如果「分析」仍慢，先看 `resolveRoute` 选中的 provider 是不是 `raccoon`。

**另一个假故障**：`live.mjs` 会把实例工作区临时指到 `/tmp/lifecard-live-*`，**如果它中途崩过，实例可能留在那个临时目录（用户那一屏会是空的）**——恢复逻辑在 `finally` 里，但仍要教用户「更多工具 → 换个文件夹」指回原路径。

---

## 8. 干活方式的建议

- 改代码前先 `node test/all.mjs` 拿基线；只跑单个文件可以 `node test/store-test.mjs`（快）。
- 改 `client.js` 后先用这个快速验语法（比等全量测试快）：
  ```bash
  node --check plugin/lib/client.js
  ```
- 改界面一定顺手补 `plugin/test/render-all.mjs` 的断言；改后台一定补 `test/routes-test.mjs` 需要的路由（它会自动扫 `client.js` 里所有 `call('xxx')`，**新路由忘在宿主实现，它就报红**）。
- 用户不在电脑前时不要问问题，直接按上面的顺序做；做完要用「先说人话结论、再说细节」的方式汇报，并**提醒他重启 App**。
- 子代理（subagent）在这台机器上**并行开多个常常全部失败**（`NO_ADAPTER` 或上下文耗尽），**一次只开一个**；给审查员写任务书时要求「只报能在代码里核实的，宁可少而准」。
- 提交信息用中文，格式照 `git log` 里的既有风格（`修: … （1494 项）`）。

---

## 9. 文档与打包（别漏这几件）

仓库根有六份文档，各有分工，改功能时要一起看：

| 文件 | 给谁看 | 说什么 |
|---|---|---|
| `README.md` | 想装的人（先看这个） | 30 秒简介、装法、能做什么不能做什么、隐私与许可 |
| `plugin/README.md` | 开发者 / 想搞清楚细节的人 | 目录排法、五个入口、格式支持表、用到的三个 MIT 项目 |
| `使用指南.md` | 普通用户 | 一步步点哪里（不含命令行；CLI 是 v0.2 计划） |
| `SPEC.md` | 数据契约（**唯一权威**） | 目录结构、frontmatter 字段、正文小节名、提案格式、墓碑、五条铁律 |
| `HANDOFF.md` | 下一个开发者 | 九轮工作的来龙去脉、验证命令、踩过的 13 个坑 |
| `交接-给下一个AI.md` | 下一个 AI | 本文件：现状、命令、未修清单、约束 |

打包与分发：
- 自查随包文件：`npm pack --dry-run ./plugin`（应含 15 个 `files` 条目 + package.json/README）。
- 给朋友用的试用包：`dist/LifeCard-试用版.zip`，内容是 `plugin/` + `先看这里.md` + `install.command`。
  `install.command` 做的事：探 JDK 不需要，只探 `~/.dsh/profiles/desktop/node_modules` 存不存在 → 把 plugin 复制/软链进去 → 打印「完全退出 App 再打开」。
  Windows 用户不能执行 `.command`，`先看这里.md` 里写了手工三步。
- **`.gitignore` 里排除了 `research/` 和 `dist/`**（用户明确：调研报告和试用包不进仓库）。

---

## 10. 一句话交接

代码侧是可交付状态：**1570 项**自动测试全过（17 个文件），端到端 15 项在一台跑着**当前代码**的实例上也全过。
这一轮把「会让用户真的吃亏」的那批都清了：丢数据的三条路（投递表被一行顶掉、报告/简历没存进去还说存好了、重名默默改旧卡）、访谈里「跳过 = 永别」、以及软链能把读写带出工作区。
隐私已清零（示例一律张三/李四/王先生/某公司/1970 年，git 历史也重写过），许可证 MIT。
**改完 `plugin/lib/` 记得提醒用户完全退出 DSH App 再打开**（软链装法下热重载不生效），然后照第 1 节三条验证跑一遍；第 6 节列的是「值得下一轮看」的几件小事，没有会丢数据的了。
