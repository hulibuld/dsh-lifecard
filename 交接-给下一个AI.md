# 交接：给下一个接手 Life Cards 的 AI

> 写于 2026-10-24 01:20。上一轮上下文快满了，把「现在是什么状态、怎么验证、还剩什么没修、哪些线绝对不能碰」写在这里。
> 读完这份 + `HANDOFF.md`（工程细节、踩过的坑、历史决策）就能直接开工，不用翻聊天记录。
> 用户是电脑小白（他自称「IT 小白」），验收方式是「打开点一遍看能不能用」，不看代码。

---

## 0. 三十秒定位

- 项目：`/Users/joyfon620/Documents/deepseek-harness/default-workspace/LifeCard/`
- 是什么：DSH（DeepSeek Harness）的侧边栏插件，本地优先的人物档案库——把身边的人写成 Markdown+YAML 的「卡」，带关系网、题料、AI 抽取（**每条断言必须有原文引文**）、求职与模拟面试。
- 代码在哪：全部在 `plugin/`。`plugin/lib/` 11 个模块共 12834 行，`plugin/test/` 19 个文件。
- 当前状态：`main` 分支，工作区干净，HEAD = `0caba98`，共 90 次提交。
- 测试：全量 **1494 项**通过（16 个测试文件）；对一个真实运行的实例做端到端验收 **15 项**（`test/live.mjs`，含一次真模型调用）。
- 发布：**没有发到 GitHub，也不许由你发**（用户明确「不发，我自己发」）。`research/` 已被 `.gitignore` 排除（用户说「调研报告不要发」）。
- 给朋友用的试用包：`dist/LifeCard-试用版.zip`（已拷到 `~/Desktop/`），里面有 `先看这里.md` 和 `install.command`。

---

## 1. 开工前必须跑的三条验证（全绿再动手）

```bash
cd /Users/joyfon620/Documents/deepseek-harness/default-workspace/LifeCard/plugin

# ① 全量单元/渲染测试。期望「合计 1494 项，全部通过。」
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
`live.mjs` **必须在 `plugin/` 目录下跑**（它按相对路径找样本文件）。

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

---

## 6. 还没修的问题（P0 三条 + P1 两条）

来源：上一轮开了一个**无上下文**的审查子代理审 `plugin/lib/client.js`，它交了 10 条。
**已修 5 条**（1/2/3/7/8）——首页建议与材料互相吞掉、`dropReport` 定义域错导致「下一步」一改公司名就崩、勾材料点一下会把已选的再加一次、「下一步」读不到内容时显示成空、练过的记录读不到却说「还没练过」。
**剩下这 5 条没修**，按下面的顺序做。行号是 2026-10-24 01:11 实测值，改完请重新定位（`grep -n` 更快）。

### P0-1 访谈页「今天到这」会吃掉刚写的内容（中）
- 位置：`plugin/lib/client.js:2992` 是那个按钮 —— `h(Btn, { size: 'sm', tone: 'ghost', onClick: () => setPhase('done') }, '今天到这')`，和「跳过」「不想说」挤在同一排。
  正常结束路径在 `:2856`（也是 `setPhase('done')`，但那条是答完/问完之后的收尾，不用动）。
- 问题：三个按钮意思接近，手一滑就结束整场；输入框里已经写好的字直接丢；结束页还会说「你说的都记下来了」。
- 修法（挑一种）：
  - 在 `onClick` 里判 `answer.trim() !== ''`，非空就 `window.confirm('这一题还没记下，确定不记了？')`；
  - 或把「今天到这」挪到页面顶部（`phase === 'talk'` 的头部区），并把文案改成「结束这次访谈（这一题不记）」。
- 补断言：`plugin/test/render-all.mjs` 里已有 `InterviewView` 的多种状态渲染，加一条「输入框里有内容时点『今天到这』会先问一句」。

### P0-2 编辑表单最后 1.5 秒的字会丢（中）
- 位置：`plugin/lib/client.js:1990-2001` 的草稿自动保存 `useEffect`：
  `const timer = setTimeout(async () => { ... call('draft.save', ...) ... }, 1500)`（`:1998`），
  清理函数只写了 `return () => clearTimeout(timer)`（`:2000`）。
  「先不改」的离开路径在 `:2246`。
- 问题：用户已经被教会「会自动存」，但组件一卸载就把定时器清掉、不发最后一次请求。停手不到 1.5 秒就点走，最后几个字不在草稿里。
- 修法：把清理函数改成「若还有未落盘的改动就立刻发一次」——
  先抽出 `const flush = async () => { if (print === savedPrint) return; await call('draft.save', ...); setSavedPrint(print) }`，
  定时器里调 `flush()`，清理函数里也调一次 `flush()`（不要 await），并在页面卸载前（`onCancel` / 切走）显式 `await flush()` 更稳。
- 补断言：`plugin/test/client-smoke.mjs` 里可以测「卸载时会调用 draft.save」；或源码级断言清理函数里出现了 `flush`。

### P0-3 「导入 → 一段文字」存完点「让 AI 读一读」，到分析页「这是关于谁」是空的（中）
- 位置链路：
  - `plugin/lib/client.js:3096` — `h(Btn, { onClick: () => onAnalyze?.() }, '让 AI 读一读')`（`TextImport` 组件里）；
  - `ImportView` 收 `onAnalyze` 在 `:3001`，`TextImport` 定义在 `:3052`；
  - 父层调用点 `:970` — `onAnalyze: () => setView(VIEWS.analyze)`（**没带人**）；
  - 分析页 `AnalyzeView` 在 `:3257`，`const [about, setAbout] = useState(presetAbout?.id ?? '')`（`:3260`）拿的就是空的 preset。
  - **正确范例在 `:975`**（「从记忆里认人」那条路径）：`onAnalyze: (about) => { setInterviewFor(about ?? null); setView(VIEWS.analyze) }`。
- 修法：`TextImport` 保存成功后改成 `onAnalyze?.({ id: safeId(about), name: about })`，`ImportView` 原样透传，父层 `:970` 照 `:975` 的写法接。注意 `analysisFor` 那个 state 的命名在父层可能是 `interviewFor`，按现有代码对齐，别新造。
- 补断言：`render-all.mjs` 加一条「导入页点『让 AI 读一读』时会把刚写的人名一起带过去」（可以直接断言源码或用一个记录实参的假回调）。

### P1-1 访谈 plan 失败会留下空卡
- 位置：`plugin/lib/client.js:2806` 调 `call('interview.plan', ...)`，失败处理在 `:2807-2810` 只 `setErr(...)` 就 `return`。
  而这张卡在 `:2800` 左右已经 `card.save` 建好了（新卡路径）。
- 后果：盘上多一张只有 id/kind/name 的空卡；用户以为是失败，换个名字重试 → 越试越多。
- 修法：失败时明说「『老王』这张卡已经建好了，只是问题没准备好，再点一次接着练」，并把已建好的卡记进 `aboutId` / `existing`，下次点「开始聊」直接复用，别再 `card.save`。

### P1-2 重名会直接复用旧卡并改它的关系
- 位置：`plugin/lib/client.js:2775` 起 —— `const existing = listing.cards.find((c) => c.id === id)`，命中后走 `:2795-2802`，会 `card.get` 再 `card.save` 把 `data.relation` 改掉。
- 后果：用户想建「老王（同事）」，库里已有「老王（父亲）」，一按就开始把父亲那张卡的关系改成同事。
- 修法：命中时先停在选择上（「库里已经有『老王』了：接着聊这张，还是换个名字新建？」），未确认前**不要**改写任何字段。

---

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

代码侧是可交付状态：1494 项自动测试全过；端到端 15 项在**重启 App 之后**应当全过（当前那次 10/11 是宿主还在跑修之前的代码）。
隐私已清零（示例一律张三/李四/王先生/某公司/1970 年，git 历史也重写过），许可证 MIT。
剩下的是**体验打磨**——第 6 节那五条都不难，十几行的改动，做完记得补断言、跑全量、提醒用户重启 App 再点一遍。
