# LifeCard SPEC v0.1

> **这是唯一契约。** 与 `README.md` / `策划书*.md` / `使用指南.md` 冲突时，以本文件为准。
> 那四份是背景材料：它记录「为什么这么设计」和「被否掉的方案」，不记录「字段长什么样」。
>
> 本文件只写**必须二选一的事实**，不写动机。动机看策划书。

---

## 0. 实现状态

**v0.1 已实现并通过实测**，代码在 [`plugin/`](./plugin/)（DSH 侧边栏插件）。

| 能力 | 状态 |
|---|---|
| 工作区（首次选文件夹）、卡片读写、快照、墓碑 | ✅ |
| 导入 PNG / JSON / CHARX / world info，保真 + 双 chunk 同源导出 | ✅ |
| 对话访谈（问题库 + 覆盖度排题 + 账本） | ✅ |
| 文本导入 → 分析 → 引文校验门 → 提案 → 勾选采纳 | ✅ |
| doctor（数据段 + 宿主段） | ✅ |
| 测试 | 1494 项，全部通过（`node plugin/test/all.mjs`） |

测过的真实环境：DSH 0.2.0-rc.2 + better-sidebar，模型路由实测可用。

本 SPEC 与实现的差异只有一处：`interviews/` 账本由插件写、由 `interview.plan` 读，
没有单独的 CLI 入口——因为访谈本身就是插件界面。

---

## 0. 一句话

一条数据链路，五个入口：

```
入口 A｜完整角色卡   PNG/JSON/CHARX → codec → 卡文件                  （确定性，无 AI）

入口 B｜已有文本     任意文本 → materials/ ─┐
入口 C｜对话访谈     skill 在聊天里问 → materials/ ─┤
                                              ↓
                        analyze → 引文校验门 → proposals/ → 人勾选 → apply → 卡文件
                                                          （非确定性，有人工闸门）
```

**五个入口，两条链路。** A 是格式搬运，不调模型、直接出卡；B、C、记忆认人三种都只是往 `materials/` 里放材料的不同方式，之后走**完全相同**的 `analyze → proposals → apply`；新建是手写空卡，不经过这条链。

C 不是新链路，这是它能成立的原因：一套闸门，三个进料口。

**分析只能提提案，不能直接写卡。**

---

## 1. 目录布局（唯一排法）

```
<workspace>/
├── lifecard.config.json
├── self/
│   ├── self.card.md
│   └── self.lens.md
├── people/
│   ├── 妈妈.card.md
│   └── 塞拉菲娜.card.md
├── relations/
│   └── mama--self.relation.md        # 文件名用 id，见 §4
├── worlds/
│   ├── reality/world.md
│   └── eldoria/
│       ├── world.md
│       ├── cards/妈妈.card.md
│       └── lorebook/
├── systems/
│   ├── reality-interview.system.md
│   └── ccv2-prompt.system.md
├── materials/                        # 原始材料，只追加、不编辑；可整份删除
│   └── 2026-10-18-爷爷的访谈.md
├── interviews/                       # 访谈账本（问答过程，不是结果）
│   └── 2026-10-18-爷爷.jsonl
├── proposals/                        # AI 提案，人在这里勾选
│   └── yeye-2026-10-18.md
├── story/
│   ├── chapters/
│   ├── state/ledger.jsonl
│   ├── state/snapshots/
│   └── threads.jsonl
├── redactions.jsonl                  # 删除墓碑，只追加
├── assets/
└── .lifecard/
    ├── index.json                    # 派生索引，可删可重建，不进 git
    ├── raw/                          # 导入时的原始二进制/JSON，保真用
    └── snapshots/                    # 每个文件存全文，不是 diff（§8.2）
```

**没有 `cards/`，没有 `reality/people/`，没有 `works/`。** 主世界实体一律在根级 `people/`；分支世界实体一律在 `worlds/<slug>/cards/`。

---

## 2. `kind` 与必需字段（定死，不留迁移）

```yaml
kind: real | fictional | hybrid | self | lens | world | system | relation
```

八个值，一个枚举。**必需字段按 kind 分层**：

| kind | 必需 | 可选但常用 |
|---|---|---|
| `real` `fictional` `hybrid` | `lifecard` `id` `kind` `name` `world` | `consent` `status` `competency` `affect` … |
| `self` | `lifecard` `id` `kind` `name` | `world` 缺省 `reality` |
| `lens` | `lifecard` `id` `kind` | `name` 缺省「我的偏好」；**不可导出** |
| `world` | `lifecard` `id` `kind` `name` | `genre` |
| `system` | `lifecard` `id` `kind` `name` | |
| `relation` | `lifecard` `id` `kind` `from` `to` | `structure` `affect` `knowledge` `power` `taboos` |

- `lifecard` 一律为字符串 `"0.1"`。
- `id` 是全局唯一的短标识；**跨实体引用一律写 `id`，禁止写路径**。
- `world` 只对实体 kind（`real`/`fictional`/`hybrid`）必需；`reality` 是保留 slug。
- 除上述必需字段外，**任何字段都可以永远为空，不报错、不降级功能**。

---

## 3. 卡文件的两种写法

### 3.1 结构化字段（YAML frontmatter）

用于会被查询、渲染、或被他卡引用的东西。

```yaml
competency:
  - key: craft
    label: 手艺
    level: 熟手                 # 封闭枚举：入门 | 熟手 | 精通 | 专家
    evidence:
      - {kind: 自述, what: 十六岁进作坊}
```

`level` 是**封闭枚举**，只允许上面四个中文值。英文（`expert`/`novice`）一律视为非法。

### 3.2 散文（正文小节）

用于需要被读、被引用、被改写的叙述。

固定小节名（与 CC 字段对齐，写在 core 里）：

| 小节 | CC 字段 |
|---|---|
| `## 自述` | `description` |
| `## 性格` | `personality` |
| `## 场景` | `scenario` |
| `## 开场白` | `first_mes` |
| `## 备选开场` | `alternate_greetings`（`---` 分节） |
| `## 对话示例` | `mes_example` |
| `## 关系史` | 无对应，本地扩展 |
| `## 不会说的话` | 无对应，负样本 |
| `## 创作者备注` | `creator_notes`（**永不进 prompt**） |

### 3.3 句后括号

括号里写**另一个视角的同一件事**，不是评价。

```
2026-09 我到外地（她想让我读本地学校）
```

括号内容会被分析器与状态包读取；评价写进 `affect[].note`，不混进事实句。

### 3.4 行尾来源标记

```
1968 进作坊〔自述〕
1985 年在镇上开了一间铺子〔他述·邻居说的〕
铺子只收过一个学徒〔推测〕
```

四级：`自述` / `他述` / `文档` / `推测`。无标记默认 `自述`。
`推测` 级进入任何渲染或扮演上下文时**必须带 `推测：` 前缀**。

---

## 4. 关系文件

```yaml
---
lifecard: "0.1"
id: mama--self
kind: relation
from: mama
to: self
structure: {type: parent, since: 2000-01-01}
affect:
  - {at: 2026-10-17, affinity: 4, trust: 0.9, note: 关心我的方式是先否定再帮忙}
knowledge: {knows: [kaoyan-plan], does_not_know: [writing-novel]}
power: {authority: 0.8, dependency: 0.2}
---
```

- **文件名 = `<from>--<to>.relation.md`，两端都是 `id`。** 文件名只是方便人看；读取时以 frontmatter 的 `from`/`to` 为准。
- 边**有向**。`mama→self` 与 `self→mama` 是两个文件、两个值。
- `affect` 挂在边上，**不在卡上**。卡里不允许出现 `affect`。

---

## 5. `system` 不在卡上

卡文件**没有** `system` 字段。系统在消费时选择：

```
lifecard render 妈妈 --system reality-interview
lifecard export 妈妈 --format json --system ccv2-prompt
```

`lifecard.config.json` 只存 `default_system`，供省略 `--system` 时兜底。这样「同一张卡绑不同 system」才成立。

---

## 6. `consent`（唯一定义）

```yaml
consent:
  basis: self | family-agreed | public-figure | fictional
  recorded_at: 2026-10-17
  note: 已当面说明用途并同意
```

| kind | 本地保存 | 导出成可传播格式 | 送进扮演类系统 |
|---|---|---|---|
| `self` | 不需要 | 不需要 | 不需要 |
| `real` | **不需要** | 必填，`basis` 不可为 `fictional` | 必填，`basis` 不可为 `fictional` |
| `fictional` `hybrid` | 不需要 | 不需要，`basis: fictional` 占位 | 不需要 |
| `lens` | 不适用 | **永不可导出** | 不适用 |

`basis: family-agreed` 时 `recorded_at` 必填，否则导出器拒绝。

**未成年人**：`kind: real` 且 `birth_year` 存在且 < 18 → 强制 `visibility: private`，禁止导出 PNG。
**已故/失能**：`status` 纯描述，**不进任何拦截逻辑**；只做一次性说明页与 `doctor` 统计。

---

## 7. 五个入口（三条进料，一个搬运，一个手写）

### 7.1 Lane A：完整角色卡导入（确定性）

```
lifecard import ~/Downloads/塞拉菲娜.png
lifecard import ~/Downloads/card.json
lifecard import ~/Downloads/妈妈.charx
lifecard import ~/Downloads/角色卡/          # 目录批量
```

识别顺序：PNG tEXt（`ccv3` 优先于 `chara`）→ 顶层 `spec: chara_card_v2/v3` → zip 内含 `card.json` → 顶层有 `entries`（world info）。

**保真规则（不可协商）**：任何 LifeCard 不理解的键，原样存进 `cc.preserved`，导出时原样写回。原始文件同时复制到 `.lifecard/raw/`。

**Lane A 不调用任何模型。** 它只做格式搬运。

### 7.1b Lane C：对话访谈（skill，产材料）

**形态是 skill，不是命令、不是插件内 UI。** 用户在任意支持 skill 的宿主里说「帮我建一张我妈的卡」，skill 加载后在**当前对话里**问。

```
lifecard-interview
```

| 它做 | 它不做 |
|---|---|
| 按关系类型选问题库（父母/祖辈/同学/老师/情侣/同事/自己…） | 任何 UI 代码 |
| 按覆盖度跳题 | 任何模型调用（用宿主自己的模型） |
| 选项 + 自由补充的混合提问；每题必带第 ④ 项「都不像，我自己说」 | 直接写 `.card.md` |
| 每答一条写进 `materials/<date>-<name>访谈.md` | **抽取字段**（抽取归 analyze，那里才有引文校验门） |
| 写 `interviews/<date>-<name>.jsonl` 账本；记 `answered_by` 去重 | 总结成「她是一个温柔而坚韧的母亲」这类判断句 |
| 报告覆盖度与跳题原因 | |

**为什么访谈不抽字段**：如果访谈也做抽取，就等于绕过 §8 的引文校验门——同一套抽取逻辑出现两个入口，一个有校验一个没有，最后没人分得清哪条是验过的。**访谈只负责把话记下来。**

**`status: sealed` 是「不想说」**：记下来，永不再问，不进任何导出。

**账本字段**：

```json
{"q":"parent.q03","asked_at":"…","asked_in":"lifecard-interview","status":"answered",
 "fills":["memory.earliest","affect.turning_point"],
 "material_anchor":"2026-10-18-妈妈访谈.md#L12-L18"}
{"q":"parent.q04","asked_at":"…","status":"skipped","reason":"sealed"}
```

---

### 7.2 Lane B：文本导入 + AI 分析（非确定性，有人工闸门）

```
lifecard import text 爷爷访谈.md --about 爷爷
```

```
materials/2026-10-18-爷爷访谈.md      # 原文，只追加、不编辑；可整份删除
```

然后（下例是 v0.2 规划中的命令行形态；v0.1 在侧栏里点「整理材料」）：

```
lifecard analyze 爷爷 --material 爷爷访谈
```

产出三样，全部落在文件系统里，**不直接改卡**：

```
proposals/yeye-2026-10-18.md          # 人看的提案（Markdown 勾选清单）
proposals/yeye-2026-10-18.json        # 机器读的结构化提案
.lifecard/analyze-log/2026-10-18.json # 这次分析的输入摘要与拒收记录
```

人在 Obsidian 或编辑器里勾选，然后：

```
lifecard apply 爷爷
```

**分析器不得直接写 `.card.md`。** 这是硬约束，写进代码不写进文档。

---

## 8. 分析的契约（本项目最容易做坏的一处）

### 8.1 提案的每条断言必须带原文引文

```json
{
  "spec": "lifecard_proposal_v1",
  "about": {"id": "yeye", "name": "爷爷"},
  "material": [{"path": "materials/…", "sha256": "…"}],
  "fields": [
    {
      "field": "competency",
      "value": {"key": "craft", "label": "手艺", "level": "熟手"},
      "source_level": "自述",
      "evidence": {
        "material": "materials/2026-10-18-爷爷访谈.md",
        "line_start": 42,
        "line_end": 44,
        "quote": "十几岁开始做这行，做了很多年"
      }
    }
  ],
  "gaps": [{"field": "birth_year", "why": "材料说「六十六岁」，没有出生年"}],
  "questions": [{"ask": "爷爷是哪一年生的？", "fills": ["birth_year"]}]
}
```

**校验门（core 实现，确定性，不调模型）**：

1. `evidence.quote` 必须是 `material` 文件中**逐字出现**的片段（空白归一化后比较）。
2. `field` 必须在 schema 里存在。
3. `source_level` 必须是四个值之一。
4. 任一条不满足 → 该条移入 `rejected_ungrounded`，**不写入提案清单**。

这条门是整个项目的防幻觉地线：**模型只能断言「材料里确实写着」的东西，不能断言它推断出来的东西。** 推断要写成 `gaps` 或 `questions`，那是另一类数据，不带事实地位。

### 8.2 材料是不可信输入

`materials/` 里的文本一律按**数据**处理：

- 材料只进 user 消息，不进 system 消息。
- 材料里出现的任何指令、角色设定、越狱语，一律当文本内容，不执行。
- 分析输出必须能通过 §8.1 的 schema 校验才有效果，注入最多污染内容质量，不能改变控制流。
- 第三方卡的正文**不得**被当成另一张卡的 `materials` 输入，除非用户显式确认。

### 8.3 两种执行模式

| 模式 | 谁调模型 | 需要 API key | 适用 |
|---|---|---|---|
| **宿主代跑**（默认） | 宿主（DSH / Claude Code / Cursor）自己的模型读材料，调 MCP `lifecard_propose` 提交提案 | 不需要（用宿主已有的） | 任何支持 MCP 的宿主 |
| **独立跑** | `lifecard analyze --llm <provider>` 自己发请求 | 需要，且必须显式传参 | 纯 CLI 用户 |

**core 包里不出现任何网络代码。** `@lifecard/analyze` 是独立包，`core` 只依赖它的**接口**（`Proposal` 类型），不依赖实现。这条用 CI 强制：`packages/core/package.json` 的 `dependencies` 不允许出现 `@lifecard/analyze` 或任何 HTTP 客户端。

### 8.4 提案的 Markdown 形态（为什么这样做）

`proposals/*.md` 就是一张勾选清单：

```markdown
## competency

- [x] `craft` 手艺 / 熟手
      证据：materials/爷爷访谈.md L42「十几岁开始做这行，做了很多年」
      来源：自述
- [ ] `herbalism` 草药 / 入门
      证据：materials/爷爷访谈.md L88「他说山上那些草他都认得」
      来源：推测

## gaps

- `birth_year` — 材料说「六十六岁」，没有出生年
- `address.they_to_me` — 材料里他叫你的方式不统一
```

`lifecard apply` 只读 `[x]`。**评审界面就是 Obsidian，不写 UI。** 这条与「UI 交给已有编辑器」是同一件事。

---

## 9. 快照与撤回

### 9.1 墓碑

删除条目时追加一行 `redactions.jsonl`：

```json
{"at":"2026-10-18T09:12:33+08:00","path":"people/妈妈.card.md","anchor":"## 关系史#2024-06","sha256":"…","reason":"她要求删除"}
```

规则：

- 墓碑**只追加，不删除**。
- **所有读取路径**先过墓碑过滤：卡文件、快照、导出、渲染、分析输入。命中 `sha256` 的内容不出现。
- 回滚或合并时命中墓碑的内容**拒绝写回**，`doctor` 报「检测到 N 条已撤回内容试图复活」。

### 9.2 快照

`.lifecard/snapshots/<id>/<timestamp>.md`，**每个文件存全文**，不存 diff。

理由：Markdown 卡通常几 KB，存全文的存储代价可以忽略，而 diff 快照要额外实现「套用 + 冲突处理」，并且**没法审计**（审计要求看到当时原文）。diff 只在展示时计算。

### 9.3 `raw/` 的诚实边界

`.lifecard/raw/` 里是导入时的原始文件（PNG / JSON / zip）。它是**导入溯源**，不是记录本体。

- `raw/` 内容**永远不进入任何导出、渲染、分析输入**。
- **但墓碑过滤不了它**：如果一张卡是从 raw 里的 PNG 导入的，而卡里某条已被撤回，raw 那份 PNG 里仍带着那段文字。
- 所以 `disclose` 必须单列一项：**「以下原始导入文件仍包含已撤回内容：…」**，并给出手动清理命令。假装能撤回是更坏的选择。

---

## 10. `doctor` 分两段

`ctx.*` 只在宿主进程里存在，独立 CLI 拿不到。所以：

| 段 | 在哪跑 | 产出 |
|---|---|---|
| **数据段** | `lifecard doctor`（任意环境） | schema 校验、悬空引用、未标记来源比例、墓碑复活检测、往返测试 |
| **宿主段** | 一个极小的自检（DSH 插件 / MCP 握手），把结果写 `.lifecard/diagnostics.json` | 服务探测：`storageDomain` / `slots` / `webServer` / Electron 路径降级 |

`lifecard doctor` 读到 `diagnostics.json` 就把它并进输出，读不到就明写「宿主段未运行」。**绝不假装探测过。**

---

## 11. 存储职责（防第二个真源）

| 数据 | 存哪 | 谁写 |
|---|---|---|
| 卡、关系、世界、系统、材料、提案 | **文件系统**（唯一真源） | core |
| 导入原件 | `.lifecard/raw/` | core |
| 快照、墓碑 | `.lifecard/snapshots/`、`redactions.jsonl` | core |
| UI 状态（当前打开的卡、面板宽度、上次滚动位置） | **`ctx.storageDomain`** | 适配器 |
| 索引（可重建） | `.lifecard/index.json` | core |

**`ctx.storageDomain` 里不允许出现任何卡片字段。** 它只存 UI 状态与派生缓存。这条是硬约束：一旦卡片进 KV，用户手改 Markdown 就会被覆盖，而那是本项目最不能接受的事。

---

## 12. 依赖纪律

- `packages/core` 运行时依赖 ≤ 5 个，且不含任何 HTTP 客户端、不含任何 `@deepseek-ai/*`、不含 `@lifecard/analyze`。
- 适配器（MCP / CLI / DSH 插件）**不允许有业务逻辑**：只做「读文件、写文件、挂 UI、喂模型」。
- 所有输出格式带 `schema_version`；`lifecard: "0.1"` 是数据版本，与包版本独立。

---

## 13. v0.1 验收（可机械判定）

| # | 判据 | 判定方式 |
|---|---|---|
| 1 | 40 张真实 ST 卡全部导入成功，0 张 schema 报错 | `lifecard doctor` 退出码 0 |
| 2 | 其中任意 5 张导出后重导入，`preserved` 零丢失 | 往返测试，逐字段比对 |
| 3 | 导入一张卡 → 导出 PNG → ST 能打开且认识 | 人工一次 |
| 4 | 一份 3000 字访谈文本能产出提案，其中每条断言都能定位到原文行 | 逐条核对 `evidence.quote` |
| 4b | 从零开始跑一遍访谈 skill，答 5 个问题，产出 materials + 账本，`analyze` 能基于它出提案 | 端到端手工走一遍 |
| 5 | 故意在材料里塞一句越狱指令，分析不执行它 | 回归用例 |
| 6 | 勾选提案后 `apply` 能写出合法卡，未勾选的不写 | 用一个含 3 条勾选、2 条不勾的提案测 |

**v0.1 的验收不含手机端、不含导出 CHARX、不含 MCP。** 那三项都在 v0.2 之后。

---

## 14. 被本 SPEC 否掉的旧设计（防止复活）

| 旧设计 | 为什么否掉 |
|---|---|
| 手机端随手记（PWA + File System Access API） | 手机浏览器没有这个能力：iOS Safari 全版本不支持，Chrome for Android 不支持。技术上不存在，不是工程量问题 |
| Web / PWA 载体 | 同上，且 Obsidian 已提供更好的界面。少一个 build target |
| 卡上有 `system` 字段 | 让「一张卡绑多个 system」退化成 1:1 |
| `relations/妈妈--我.relation.md` | 用名字做文件名，改名即断链，与「只写 id」冲突 |
| `cards/` 平铺 / `reality/people/` | 同一实体三个地址 |
| `inherit: [affect*]` | `affect` 在关系边上，不在卡里 |
| `kind` 五值 | 缺 `world` / `system`，world.md 与 system.md 当场解析失败 |
| `snapshots/` 只存 diff | 无法审计，且与撤回过滤的实现冲突 |
| 分析器直接写卡 | 幻觉无法拦截；必须经提案 + 人工勾选 |
| `works/` 目录 | 全文无定义，死字段 |
| `level: expert` | 与中文枚举混用，lint 无基准 |
