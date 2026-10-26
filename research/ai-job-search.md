# AI-job-search 类项目调研 → LifeCard 求职插件移植评估

> 调研方式：全部走 `github_*` host 侧工具（`github_api` / `github_file`），**未 clone、未改任何代码**。
> 每个结论后面括号里是来源（仓库 + 文件路径）。没查到的地方写「没查到」，不猜。
> 调研时间：2026-10-20。

---

## 一、找到的项目

搜索结果来自 `GET /search/repositories?q="AI job search"&sort=stars` 与 `?q="ai-job-search in:name"`。挑出 3 个真正有参考价值的（其余命中是招聘平台 SDK、爬虫库、空壳仓库，已排除）。

### 候选 1（最匹配）：career-ops

| 项 | 值 |
|---|---|
| URL | https://github.com/career-ops-hq/career-ops |
| Star / Fork | 75,707 / 14,089 |
| 语言 | JavaScript（Node.js，`engines: ^22.13.0 \|\| >=23.4.0`）+ Go（TUI dashboard） |
| 许可证 | **MIT**（`LICENSE`，Copyright (c) 2026 Santiago Fernández de Valderrama） |
| 版本 | `package.json` version 1.37.0 |
| 一句话定位 | 跑在本地 AI coding CLI（Claude Code / Codex / OpenCode / Qwen / Grok / Pi…）里的求职框架：贴一个 JD → A–H 结构化评估报告 + 定制 CV PDF + 求职信 + 投递追踪，**永不自动投递**。 |

**为什么它最匹配**：它是**唯一一个把「候选人档案」拆成 7 个独立文件、并且用固定 schema 约束的文件型系统**（`cv.md` / `article-digest.md` / `config/profile.yml` / `modes/_profile.md` / `voice-dna.md` / `interview-prep/story-bank.md` / `modes/_custom.md`，见 `modes/_shared.md` §Sources of Truth）。这跟 LifeCard 的「卡片 + frontmatter + 关系网」是同一类底座，几乎可以逐字段映射。而且它是 Node.js，和 LifeCard 插件（`plugin/package.json` 也是 `"type": "module"`）同语言，MIT 可抄代码。

### 候选 2：ai-job-search（MadsLorentzen）

| 项 | 值 |
|---|---|
| URL | https://github.com/MadsLorentzen/ai-job-search |
| Star / Fork | 58,006 / 18,366 |
| 语言 | Python（工具层）+ Bun/TypeScript（portal CLI）+ LaTeX（简历排版） |
| 许可证 | **MIT**（`LICENSE`，Copyright (c) 2026 Mads Lorentzen） |
| 默认分支 | `master` |
| 一句话定位 | 基于 Claude Code 的求职申请工作流：`/setup` 建画像 → `/scrape` 搜岗 → `/apply` 评估+定制简历+求职信+reviewer agent 复核 → `/interview` 面试准备。 |

**为什么值得看**：它的**提示词分层最干净**——`.claude/skills/job-application-assistant/` 下 `01`–`07` 七个文件各管一件事（画像 / 行为画像 / 写作风格 / 评估 / CV 模板 / 求职信模板 / 面试准备），这是提示词工程层面最值得照搬的结构。此外它有**双 agent drafter-reviewer 复核**（`README.md` §How `/apply` works）、**PDF 编译后回读校验**（lualatex 2 页 / xelatex 1 页 / ATS 文本层抽取），这两块思路很硬。

### 候选 3：ai-job-search-cn

| 项 | 值 |
|---|---|
| URL | https://github.com/sunyet-01/ai-job-search-cn |
| Star / Fork | 137 / 7 |
| 语言 | Python（零依赖，纯标准库） |
| 许可证 | **MIT**（`LICENSE`，同时署名 `AI Job Search CN contributors` 与 `Mads Lorentzen (upstream ai-job-search)`——**它是候选 2 的中文 fork**） |
| 一句话定位 | 候选 2 的中文化改造：中国求职者 7 维 JD 评估 + 一页中文简历 PDF + 投递行动清单。 |

**为什么值得看**：star 少，但它是**唯一一个把评估框架中国化**的（`knowledge/evaluation_framework_cn.md`）：加上了「薪资结构 / 工作强度（大小周、996 信号）/ 稳定性与合规 / 通勤与城市」四个中国特色维度。LifeCard 的目标用户是中文用户，这套维度直接可用。注意它是候选 2 的 fork，所以 MIT 链条清楚，但它自身「前端网页版正在开发中」，代码量很小（core 只有 3 个 py 文件）。

**被排除的**：`pedrohlucena/hunter`（无 LICENSE → 保留一切权利）、`Traverser25/NopeRi`（无 LICENSE）、`XiaomingX/jobleap-cn-ai-job-search`（Apache-2.0 但只是个 awesome 列表，没有实现）、`Paramchoudhary/ResumeSkills`（MIT 但纯 skill 文本集合，无数据模型）。

---

## 二、功能拆成几块

以候选 1（career-ops）为主轴，因为它的模块划分最完整、最容易照着拆。候选 2 / 3 的差异单独标注。

### 块 1｜画像（Profile）—— 一次建好，长期复用

- **做什么**：把「我是谁」变成机器可读的结构化档案：身份、教育、经历、技能、目标岗位原型（archetype）、叙事（exit story / superpowers / proof points）、薪资底线、地点与工作许可、语言能力。
- **输入**：聊天式访谈（`/career-ops interview`）、粘贴 CV、`config/profile.yml`。
- **输出**：`config/profile.yml`（单文件 YAML，20974 bytes 的 example 就是完整 schema）+ `cv.md` + `article-digest.md`（proof points）+ `modes/_profile.md`（用户自定的 archetype 表）。
- **提示词策略**：**分文件分层**，`_shared.md` 是系统规则（会随版本更新），`_profile.md` 是用户覆盖（永不自动更新），`_custom.md` 是用户的长期偏好（"always/never" 类家规）。规则文件被显式标注 "THIS FILE IS AUTO-UPDATABLE. Don't put personal data here."（`modes/_shared.md` 顶部注释）——**数据与规则物理分离**，这是它最值得抄的一条工程纪律。

### 块 2｜评估（Evaluation）—— A–H 九段报告

- **做什么**：贴一个 JD，产出固定 9 段的结构化报告 + 一个 1–5 全局分 + Apply/Skip 决策。
- **输入**：JD 文本或 URL + `cv.md` + `article-digest.md` + `profile.yml` + `_profile.md`。
- **输出**：`reports/{###}-{company-slug}-{YYYY-MM-DD}.md`，含 `## Machine Summary` YAML 段供下游脚本解析。
- **提示词策略**（直接从 `modes/oferta.md` 读到的机制，这是全文最值钱的部分）：
  1. **九道闸门前置**：liveness gate（URL 必须先确认帖子还活着，死链 `---DEAD_POSTING---` 直接停）、blacklist gate、dealbreaker gate、agency confirmation gate、geo-mismatch check、work-authorization check、PcD-quota check。**任一硬门命中 → 在 Block A 之前停，不写报告、不写 trackers、不生成 PDF。** 这个「先否决再评估」的顺序是刻意的：省掉一整轮昂贵评估。
  2. **两遍读法（two-pass rule）**：Block B 必须**先只读 JD 填 Requirement / JD signal / Importance**，**之后**才读 `cv.md` 填 Match 和 Evidence。理由是「刚写完 ✅ Strong 的模型会锚定着把这个需求评为 important」——**用生成顺序对抗打分偏置**。这是全文最精妙的一条，任何做匹配打分的系统都该抄。
  3. **重要性五档 + 证据三档**：`critical` / `high` / `meaningful` /（低两档）配 `(stated)` / `(structural)` / `(inferred)`。**evidence 是 `inferred` 时，importance 永远不能是 critical 或 high**——用 schema 把「猜的不能当硬要求」写死。
  4. **行数预算**：Block B 最多 12 行；但「保留所有 critical/high 行」优先于预算，超了就超。排序规则：重要性降序，同档内**未满足的排在满足的前面**。
  5. **有界研究预算**：Block D + G 合计**最多 5 次 WebSearch**，禁止调 deep-research、禁止派子 agent。防止评估膨胀成一次无底洞调研。
  6. **不打百分制**：全局分是 1–5 的整数/半分，不是 0–100。`_shared.md` 里明确写「A 0-100 integer advertises 101 distinguishable levels the evidence cannot support ('87' vs '84' will not reproduce across two runs on the same JD)」。

### 块 3｜简历定制与 PDF 生成

- **做什么**：按 JD 重排简历要点，生成 ATS 可读 PDF。
- **输入**：`cv.md` + Block E 的定制方案 + `templates/cv-template.html`。
- **输出**：`output/` 下的 PDF + `data/pdf-index.tsv` 清单。
- **提示词策略**：
  - **事实校验硬闸**：`generate-pdf.mjs` 会拦下「数字或事实在 `cv.md` / `article-digest.md` 里都找不到」的 CV，除非显式 `--skip-fact-check`（`README.md` §What career-ops will not do）。
  - **永远 reformulate，never fabricate**：写在 prompt 里，也写进代码闸门。
  - 候选 2 走得更远：`/apply` 会**编译后回读 PDF 页面**，检查「恰好 2 页、没有孤行的公司名、封面信恰好 1 页、签名可见」（`README.md` §What makes this workflow different）；再用 `pdftotext` 抽文本层模拟 ATS 解析（检查联系方式是字面文本、无乱码 glyph、阅读顺序正确）。

### 块 4｜求职信（Cover Letter）

- **做什么**：生成一页求职信，带「为什么是这家公司」的调研。
- **输入**：评估报告 + `cv.md` + 公司调研 + 用户回答四个角度问题（why / problems / approach / tone）。
- **输出**：HTML → A4 PDF，和 CV 同一套渲染管线。
- **提示词策略**：`modes/_writing.md` 的硬规则——**禁止 em dash、禁陈词滥调、禁无支撑的 buzzword、禁过度谦虚、禁未核实的公司声明**。候选 2 的 `03-writing-style.md` 给了更可执行的「**面试回溯测试**」：如果这条 bullet 在面试里你没法自然解释、得说「其实我的意思是……」，那就是过分了。

### 块 5｜岗位发现（Scan / Discover）

- **做什么**：批量扫招聘板，去重，产出 `data/pipeline.md`。
- **输入**：`portals.yml`（100+ 公司预配置）+ `site:` 搜索查询模板。
- **输出**：带评分候选的 pipeline 列表。
- **提示词策略**：**按职能而非职称组织查询**（`search-queries.md`："Organize by function, not job title. The same underlying work carries different titles across companies"）。另外有**两段式分诊**：先跑便宜的 `modes/triage.md` 用精简 brief 打分，3.5 分以下直接丢，只有过线的才跑完整 A–H 评估（`config/profile.example.yml` 的 `pipeline.triage_threshold`）——**省一半 token**。

### 块 6｜追踪与复盘（Tracker / Patterns）

- **做什么**：记录每个申请的状态，事后分析拒绝模式。
- **输入**：评估报告 + 用户回填的结果。
- **输出**：`data/applications.md`（Markdown 表格）。
- **提示词策略 / 工程策略**：
  - **状态机是封闭枚举**：`templates/states.yml` 定义 10 个状态（evaluated / applied / responded / assessment / interview / offer / rejected / discarded / skip / hired），带 `terminal: true` 标记和每状态的多语言别名。**写表格时不许加粗、不许带日期、不许加额外文字**。
  - **并发写保护**：绝不手改 `applications.md`，而是写一个 TSV 到 `batch/tracker-additions/` 再 `node merge-tracker.mjs` 合并——「手写一行就绕过了其他写入方共享的 tracker 锁」。

### 块 7｜面试准备

- **做什么**：为具体岗位生成 STAR 故事表 + 模拟面试。
- **输入**：`interview-prep/story-bank.md`（用户自己的故事银行）。
- **输出**：`interview-prep/{company}-{role}.md`。
- **提示词策略**：
  - **STAR + R**（多一个 Reflection 列）：`modes/oferta.md` Block F 明说「Reflection 列编码的是资历——初级讲发生了什么，高级提取教训」。
  - **故事溯源（provenance）**：`templates/story-bank.template.md` 规定故事里的数字必须能被 `story-provenance-check.mjs` 对 `cv.md` 分类成 `existing` / `supportedByResume` / `derived-unverified`；**评估本身无权给自己的数字背书**，只有用户能加 `**Provenance:** source: cv.md` 标记。
  - 候选 2 的 `07-interview-prep.md` 更朴素但更可抄：4–6 个 STAR 模板 + 「常见的难问题」+ 「你该问面试官的问题」+ 「roleplay 规则（从暖场到技术到行为到刁钻，每答完给反馈）」。

### 块 8｜外联（Contacto / Email）

- **做什么**：找到招聘经理/recruiter，起草一条 ≤300 字符的 LinkedIn 消息或一封正式求职邮件。
- **输出**：**只有草稿**。`README.md` 明确写 "There is no mail transport anywhere in this codebase."
- **提示词策略**：**人类在环是硬架构**，不是提示词里的软要求——`prepare-application.mjs` 这个脚本本身就不 POST。这条被写进了 README 的 "hitl: absolute guarantee. Do not add 'automatically' … or any other hedge when translating this row."

---

## 三、数据模型

### 3.1 career-ops 的实体

| 实体 | 载体 | 关键字段 | 关系 |
|---|---|---|---|
| **Candidate** | `config/profile.yml` | `candidate{full_name,email,phone,location,linkedin,github,photo}`、`target_roles{primary[],archetypes[{name,level,fit}]}`、`narrative{headline,exit_story,superpowers[],proof_points[{name,url,hero_metric}]}`、`compensation{target_range,currency,minimum}`、`location{country,city,visa_status,authorized_in[],needs_sponsorship}`、`language{output,modes_dir}` | 1:1 于工作区 |
| **CV** | `cv.md` | 自由 Markdown，是**唯一事实源** | 被 Evaluation / PDF 引用 |
| **Proof Point** | `article-digest.md` | 项目/文章/案例，带可量化 metric | 优先级**高于** `cv.md`（`_shared.md`: "For article/project metrics, article-digest.md takes precedence over cv.md"） |
| **Archetype** | `modes/_profile.md` | `{Archetype, Thematic axes, What they buy}` 表格 | 多对一于 Candidate |
| **Job Posting** | `reports/*.md` 里的 `## Job Description (archived verbatim)` | 原文逐字存档 + `Posted:` 日期 | 1:1 于 Report |
| **Evaluation Report** | `reports/{###}-{slug}-{date}.md` | header（Score / Decision / Legitimacy / Work Auth / PDF）+ `## Machine Summary` YAML（`score`、`final_decision`、`advertised_comp`、`risk_summary{}`、`requirement_importance[]`、`score_evidence{}`、`confidence_gaps[]`）+ Block A–H | N:1 于 Posting |
| **Application** | `data/applications.md` | `# / Date / Company / Via / Role / Score / Status / PDF / Report / Notes` | 1:1 于 Report（同一公司+岗位重复评估会 match 到已有行，不新增） |
| **STAR Story** | `interview-prep/story-bank.md` | `### [Theme] Title` + `Source / S / T / A / R / Reflection / Best for questions about` + 可选 `Provenance` | N:N 于 Requirement |
| **Status** | `templates/states.yml` | `{id, label, aliases[], description, dashboard_group, terminal?}` | 封闭枚举，被 Application 引用 |
| **Portal** | `portals.yml` | 公司 → ATS 板/搜索查询 | N:N |

### 3.2 能不能映射到「人物卡 + 关系网 + 材料」

**能，而且映射得相当干净。** LifeCard 的卡文件结构（`SPEC.md` §2/§3）是：frontmatter（`kind` / `id` / `name` / `world` / `competency[]` / `knowledge` / `taboos` / `life` / `consent` …）+ 固定名的正文小节（`## 自述` / `## 性格` / `## 关系史` / `## 不会说的话` …）+ 行尾来源标记（`自述`/`他述`/`文档`/`推测`），另有 `relations/*.relation.md` 有向边（`structure` / `affect` / `knowledge` / `power`）。

| career-ops 实体 | LifeCard 落点 | 映射难度 |
|---|---|---|
| Candidate（`profile.yml`） | `self/self.card.md` 的 frontmatter | 容易，字段基本一一对应 |
| CV（`cv.md`） | `self` 卡的正文小节（新增 `## 履历` `## 技能`） | 容易 |
| Proof Point（`article-digest.md`） | `self` 卡的 `competency[].evidence[]` | **很好**——LifeCard 的 competency 已经有 `{key,label,level,evidence[{kind,what}]}`，`level` 是封闭枚举「入门/熟手/精通/专家」，`evidence.kind` 是「自述/他述/文档/推测」。这正是 career-ops 缺的东西 |
| Archetype（`_profile.md`） | `self/self.lens.md` | 容易 |
| Job Posting | `materials/`（只追加、不可编辑） | 容易 |
| Evaluation Report | `proposals/`（AI 提案 + 人勾选） | **结构同构**——LifeCard 已有「分析只能提提案，不能直接写卡」的闸门 |
| Application（tracker） | 新实体，`applications/` 目录 | 要新建 |
| STAR Story | 新实体，`interview-prep/` 或作为 `self` 卡的能力证据 | 要新建 |
| Status 枚举 | 新常量 | 要新建 |
| **关系网** | career-ops **完全没有** | **这是 LifeCard 的独占优势** |

### 3.3 LifeCard 比 career-ops 强的地方（值得反过来利用）

1. **关系网**：`relations/mama--self.relation.md` 有向边带 `structure{type,since}` / `affect[{at,affinity,trust,note}]` / `knowledge{knows,does_not_know}` / `power{authority,dependency}`。career-ops 只有平铺的 `network_contacts_note` 一个字符串字段。→ **内推路径挖掘**（"谁在这家公司/这个行业"）是 career-ops 做不到、而 LifeCard 一句话就能查的。
2. **来源分级**：LifeCard 的四级来源标记（`自述/他述/文档/推测`）+ 「`推测` 级进入任何渲染必须带 `推测：` 前缀」比 career-ops 的 provenance 更细。→ 简历里哪些数字是「你自己说的」、哪些是「别人转述的」、哪些是「推断的」，可以直接继承。
3. **consent**：LifeCard 有 `consent{basis, recorded_at, note}`，按 `kind`（real/fictional/hybrid/self）分层要求。career-ops 完全没有这个概念。→ 如果求职插件要读别人的卡（推荐人、前同事）来写材料，**必须有这一层**。

---

## 四、能搬过来的

图例：**可搬**＝逻辑/结构直接拿来用；**要改**＝思路对但要适配 LifeCard；**不能搬**＝不做。

### 4.1 可搬（直接抄或逐行翻译）

| # | 功能 | 来源文件 | 为什么可搬 |
|---|---|---|---|
| 1 | **两遍读法（先 JD 后 CV，Importance 不回改）** | `modes/oferta.md` §Block B → Two-pass rule | 纯生成顺序约束，零依赖，任何语言都能照抄。这是防打分偏置最便宜的一招 |
| 2 | **Importance 五档 + evidence 三档 + `inferred` 不得为 critical/high** | `modes/oferta.md` §Importance bands / §Evidence tiers | schema 级约束，写成校验函数即可 |
| 3 | **闸门先行（blacklist / dealbreaker / 死链 / 语言 / 工作许可）** | `modes/oferta.md` 各 gate | 每条都是「读 JD → 匹配用户自己的硬规则 → 命中就停」。LifeCard 有 `taboos` 字段，天然就是 dealbreaker 源 |
| 4 | **有界研究预算（≤5 次检索，禁嵌套 agent）** | `modes/oferta.md` §Bounded Research Budget、`modes/_shared.md` §Subagent delegation | 防 token 爆炸，规则本身就是提示词 |
| 5 | **1–5 分而非 0–100** | `modes/_shared.md` §Scoring System | 有明确论证（重复性），直接沿用 |
| 6 | **封闭状态枚举 + 多语言别名** | `templates/states.yml` | 10 个状态值 + `terminal` 标记，纯数据文件 |
| 7 | **写 TSV 再 merge，绝不手改追踪表** | `modes/oferta.md` §2 Record in tracker | 并发写保护的现成模式 |
| 8 | **STAR + Reflection；Reflection 编码资历** | `modes/oferta.md` §Block F | 提示词一句话，效果明确 |
| 9 | **故事银行按 `### ` 块 + 固定字段行，机器可读** | `templates/story-bank.template.md` | 格式约定清晰，可直接照抄 |
| 10 | **中国化 7 维评估框架** | `ai-job-search-cn/knowledge/evaluation_framework_cn.md` | 7 维 + 权重 + deal-breaker 强制降分 + 四条诚实原则。**MIT，可原文引用** |
| 11 | **投递行动清单生成器** | `ai-job-search-cn/core/channel_list.py` | 纯字符串拼装，无外部依赖。逻辑可逐行翻成 JS |
| 12 | **写作硬规则（禁 em dash / 禁陈词 / 禁无支撑 buzzword）** | `ai-job-search` 的 `03-writing-style.md` | 纯规则文本 |
| 13 | **「面试回溯测试」判定 bullet 是否过度包装** | `03-writing-style.md` §rule 6 | 可执行的边界判定，比「不要夸大」有用得多 |
| 14 | **事实校验闸门（数字必须在源文件里出现）** | `README.md` §What career-ops will not do + `generate-pdf.mjs` | 逻辑简单：抽数字 → grep 源文件 → 不在就拒绝 |
| 15 | **数据与规则物理分离（`_shared` 可更新 / `_profile` 永不动）** | `modes/_shared.md` 顶部注释 | 工程纪律，直接学 |

### 4.2 要改（思路对，但要适配）

| # | 功能 | 原实现 | 要改什么 |
|---|---|---|---|
| 1 | **A–H 九段报告** | `modes/oferta.md`，83495 bytes，含 9 大段 + 20+ 子信号 | 太长。LifeCard 是侧边栏插件，报告要能塞进侧栏。建议压成 **4 段**：Verdict / 匹配表（沿用两遍读法）/ 定制方案 / 风险摘要 |
| 2 | **画像文件 7 件套** | `cv.md` + `article-digest.md` + `profile.yml` + `_profile.md` + `voice-dna.md` + `story-bank.md` + `_custom.md` | 太散。LifeCard 已经是「一张卡一个文件」，应压成 **`self` 卡 + 3 个新实体**（简历版本 / 故事银行 / 申请记录） |
| 3 | **PDF 生成** | Node + Playwright + HTML 模板（`templates/cv-template.html`） | LifeCard 侧边栏里塞 Playwright 不合适。改成**生成 Markdown/HTML 供用户自己打印**，或调本机已有浏览器。**不要引 playwright 依赖** |
| 4 | **100+ 公司 portals 扫描** | `portals.yml` + 55 个 provider 模块 + `scan.mjs` | 太重，且国内招聘站反爬严格。建议**只做「贴 JD」路径**，扫描留作 v2 |
| 5 | **Drafter-reviewer 双 agent** | `/apply` spawn 第二个 Claude agent 复核 | LifeCard 在 DSH 里有 `ctx.llm.stream`（`plugin/lib/index.js:192` 注释明确写了真实 API 是 `ctx.llm.stream({provider,model,messages,system})`），**可以真做两遍**，但是串行两次调用、不是 agent 编排 |
| 6 | **ATS 文本层校验** | `pdftotext` 抽文本 + 关键词覆盖率 | 依赖 poppler。改成**对生成的 Markdown 直接做关键词覆盖统计**，跳过 PDF 环节 |
| 7 | **7 维评分权重** | 技能30/经验25/行为15/薪资10/强度10/稳定5/通勤5 | 权重是西方/中国通用岗写的。LifeCard 的用户可能是任意行业，权重应做成**可由用户卡里的 `lens` 覆盖** |

### 4.3 不能搬

| # | 功能 | 原因 |
|---|---|---|
| 1 | **自动投递 / 自动发邮件** | 候选 1/2/3 **全部**明确拒绝（career-ops: "The script never POSTs"; ai-job-search: 无 mail transport；ai-job-search-cn: "绝不代替你投递、发邮件"）。这不是技术限制是**设计底线**，LifeCard 也应守住。另外自动投递违反各招聘站 ToS |
| 2 | **Playwright 驱动 ATS 表单填** | 同上 + 本机无此依赖 + 侧边栏插件不该控制浏览器（虽然本机有 bsk_* 浏览器工具，但那是用户主动授权的场景，不该做成自动流） |
| 3 | **Posting 合法性检测里的「公司负面新闻检索」** | career-ops 的 Block G 有 20+ 个信号（裁员新闻、AI 披露合规、固定期限合同、无薪实习、收费陷阱…）。其中法律合规部分**地域强绑定**（安大略省、巴西 Lei 8.213/91、新加坡），照搬会给出错误结论。只保留**结构性信号**（帖子年龄、apply 按钮状态、JD 具体度、要求合理性、重发次数） |
| 4 | **LinkedIn 抓取** | `linkedin-search` 走的公开 `jobs-guest` 端点，README 自己写明「automated access is against LinkedIn's Terms of Service」，仅限个人低量使用。不并入插件 |
| 5 | **LaTeX 简历管线** | 候选 2 的 moderncv + 自定义 `cover.cls` + lualatex/xelatex 双引擎，本机装 TeX Live 是几 GB 的事，且 PDF 回读迭代在侧边栏插件里不可行 |
| 6 | **Go TUI dashboard** | 技术栈完全不同，且 LifeCard 已有 Web 侧边栏 UI |

---

## 五、许可证结论

**逐个候选，明确写能不能复用代码。**

### 候选 1：career-ops — ✅ **可以复用代码**

- 文件：仓库根 `LICENSE`
- SPDX：**MIT**
- 原文首行：`MIT License` / `Copyright (c) 2026 Santiago Fernández de Valderrama`
- `package.json` 也声明 `"license": "MIT"`
- README 末节 `## License & Trademark` 明确：「The code is licensed under MIT. The "career-ops" name and brand are governed by the Trademark Policy」
- **结论**：MIT 允许使用、复制、修改、合并、发布、再授权、销售，**唯一义务是保留版权声明与许可声明**。可以抄代码、可以并入 LifeCard 并改成自己的许可，但要在文件头或 NOTICE 里保留原作者版权行。
- **⚠️ 一个限制**：`TRADEMARK.md` 单独约束 **"career-ops" 这个名字和品牌**。代码能抄，**名字不能用**（商业产品命名和背书被保留）。所以新插件**不能叫 career-ops 或 careerops**。

### 候选 2：ai-job-search（MadsLorentzen） — ✅ **可以复用代码**

- 文件：仓库根 `LICENSE`
- SPDX：**MIT**
- 原文首行：`MIT License` / `Copyright (c) 2026 Mads Lorentzen`
- README 末节 `## License`：`MIT`
- 无 TRADEMARK 文件（已查目录列表，未见于 README 文件树）
- **结论**：同上，可抄代码，保留版权声明即可。
- **注意**：它是 Python + Bun + LaTeX 栈，LifeCard 是 Node.js ESM。**代码不能直接 require/import，但逻辑可以逐行翻译**。具体地：
  - `.claude/skills/job-application-assistant/*.md`（01–07）是**纯 Markdown 提示词**，语言无关，**可以整段拿来改**（改字段名、改成 LifeCard 的卡结构）。
  - `tools/*.py`（`posting_guard.py` 完整性闸、`verify_pdf.py`、`verify_layout.py`、`robots_check.py`）是 Python，**逻辑可翻译**（都只有几十到几百行，纯标准库）。
  - `.agents/skills/*/cli/` 是 Bun/TypeScript，**与 LifeCard 同生态**，理论上可搬，但它们全是丹麦招聘站，无实用价值。

### 候选 3：ai-job-search-cn — ✅ **可以复用代码**

- 文件：仓库根 `LICENSE`
- SPDX：**MIT**
- 原文首行：`MIT License`，**双署名**：`Copyright (c) 2026 AI Job Search CN contributors` + `Copyright (c) 2025-2026 Mads Lorentzen (upstream ai-job-search)`
- README 末节 `## License`：`MIT License(见 LICENSE)`
- **结论**：MIT，可抄。因为它是候选 2 的 fork，**复用时需要保留两行版权**（上游 + 本 fork），这是 MIT 的传播要求。
- **特别注意**：它是 MIT 而不是 GPL/AGPL，所以**没有传染性**，可以并入任何许可的项目。这条是明确的：`LICENSE` 全文是标准 MIT，没有任何 copyleft 条款。
- 它的代码量：`core/` 只有 3 个 py（`jobs_search.py` 4104B / `resume_render.py` 5189B / `channel_list.py` 4962B），`knowledge/` 是 7 个 md。全量搬也不到 100KB。

### 交叉结论：Node.js ↔ Python 的边界

| 候选 | 语言 | 与 LifeCard（Node.js ESM）的关系 | 结论 |
|---|---|---|---|
| career-ops | **JavaScript/Node.js** | 同语言同生态（都是 ESM，都跑 Node 22+） | **代码可搬**（改 import 路径即可）；`modes/*.md` 提示词可整段搬 |
| ai-job-search | Python + Bun + LaTeX | 工具层不同语言，提示词层语言无关 | **提示词整段可搬；Python 逻辑只能逐行翻译，不能 import** |
| ai-job-search-cn | Python（零依赖） | 同上 | 同上，但代码量小，翻译成本低 |

**一句话**：MIT 全绿，三个都能抄。唯一要动手的是「Python → JS 的翻译」和「不搬 playwright/latex」。

---

## 六、给 LifeCard 底座的新插件建议

### 6.1 命名

避开 `career-ops` 商标。建议 **`dsh-lifecard-jobs`** 或 **`jobfit`**。

### 6.2 与现有 LifeCard 后端路由的衔接

现状：`plugin/lib/index.js:1403` 起注册单一 prefix `POST /api/dsh-lifecard`，`buildApi()`（`plugin/lib/index.js:502`）返回一个方法表，路由层用 `Object.hasOwn(api, method)` 分派，**共 34 个 handler**：`state.get` / `workspace.init` / `workspace.inspect` / `workspace.list` / `card.get` / `world.get` / `card.save` / `card.history` / `card.version` / `card.restore` / `card.delete` / `import.cards` / `import.text` / `import.textFile` / `avatar.set` / `avatar.remove` / `avatar.list` / `export.card` / `export.json` / `material.add` / `material.list` / `concept.get` / `concept.set` / `analyze.run` / `proposal.list` / `proposal.get` / `proposal.apply` / `proposal.check` / `doctor.run` / `interview.questions` / `interview.plan` / `interview.record` / `interview.history`（共 33 个具名 + `root` 辅助闭包）。

> 注：任务描述里说「32 条后端路由」，实际数到 **33 个具名方法**（`buildApi` 返回对象里除 `root` 闭包外的键数）。这个差异建议在实现前跟用户确认一下，可能是把 `root` 也算进去了或漏了一个。

有两种接法：

**方案 A（推荐）：同 prefix，加方法名**

新方法名统一带 `job.` 前缀，直接塞进同一个 `api` 对象：

```
job.jd.add            ← 贴 JD 入 materials/（复用 material.add 的落盘逻辑）
job.evaluate          ← 跑两遍读法评估，产出 proposal（不直接写卡）
job.report.get        ← 读某次评估报告
job.resume.build      ← 按评估生成简历 Markdown（不生成 PDF）
job.cover.build       ← 按评估 + 用户回答生成求职信
job.story.list        ← 读故事银行
job.story.add         ← 写故事银行（★ 必须走 proposal 闸门）
job.application.add   ← 记录一次投递
job.application.update ← 改状态（走封闭枚举）
job.application.list  ← 列表
job.network.who       ← ★ 查关系网：谁在这个公司/行业（LifeCard 独占能力）
job.doctor            ← 求职数据的完整性检查
```

优点：复用现有 `webServer.register({kind:'prefix'})`、`readBody`、`writeJson`、错误码体系（`method-error` / `not-found` / `internal`），零新增基础设施。缺点：`buildApi` 会继续变长，建议**拆成 `lib/jobs.js` 导出 `buildJobsApi(ctx, workspace, config)`，在 `buildApi` 里 `...buildJobsApi(...)` 展开**。

**方案 B：独立 prefix `/api/dsh-lifecard-jobs`**

再注册一个 `ctx.webServer.register({kind:'prefix', path:'/api/dsh-lifecard-jobs'})`。隔离更彻底，但要复制一遍分派逻辑，且前端 `client.js:26` 那个常量 `'/api/dsh-lifecard'` 要改成可传参。

**选 A。** 因为 LifeCard 的核心闸门（proposal 人工勾选）必须复用——求职评估天然就是「AI 提案、人采纳」，跟现有 `analyze.run → proposal.list → proposal.apply` 链路是同一个形状。

### 6.3 复用 LifeCard 已有的四条纪律（这是最大红利）

1. **分析只提提案，不直接写卡**（`SPEC.md` §0）→ 评估结果、故事银行条目、简历改写建议**全部走 `proposals/`**，用户在侧栏勾选才 `apply`。
2. **每条断言必须带原文引文**（`SPEC.md` §8.1）→ 评估里每一条「匹配/不匹配」都必须引用 JD 原文 + `cv.md` 原文，无引文即丢弃。这正好就是 career-ops 的 `JD signal` 列。
3. **材料是不可信输入**（`SPEC.md` §8.2）→ JD 文本、招聘帖、公司网页一律当数据不当指令。career-ops 的 `posting_guard.py` 做的是同一件事（剥隐藏文字、揪指令形状的行）。
4. **行尾来源标记**（`SPEC.md` §3.4：`自述`/`他述`/`文档`/`推测`）→ 简历里每个数字必须带来源级别；`推测` 级的**不能进简历**。这比 career-ops 的 provenance 更严，直接继承。

### 6.4 数据模型（需要新增什么）

复用现有目录布局（`SPEC.md` §1），只新增三个目录 + 在 `self` 卡上新增字段：

```
<workspace>/
├── self/
│   └── self.card.md              ← 新增 frontmatter 字段（见下）
├── people/ relations/ worlds/    ← 不动
├── materials/                    ← JD 原文存这里（复用 material.add，只追加不可编辑）
├── proposals/                    ← 评估报告、简历改写、故事条目都先落这里
├── jobs/                         ← ★ 新增
│   ├── evaluations/
│   │   └── 2026-10-20-acme-后端工程师.md
│   ├── applications.md            ← 追踪表（封闭状态枚举）
│   └── story-bank.md             ← STAR+R 故事银行
└── .lifecard/
    └── jobs/                      ← ★ 新增，派生索引，可删可重建
        └── index.json
```

**`self.card.md` 新增 frontmatter 字段**（全部可选，缺省不报错——遵循 `SPEC.md` §2「任何字段都可以永远为空」）：

```yaml
job:
  target_roles:
    - {archetype: 后端工程师, level: 高级, fit: primary}
  compensation: {target_range: "40-60万", currency: CNY, minimum: "35万"}
  location: {city: b 市, remote_ok: true, authorized_in: [CN]}
  dealbreakers: ["996", "外包岗"]          # 建议与 taboos 打通
  languages: [{lang: 中文, level: native}, {lang: 英文, level: B2}]
```

**`jobs/applications.md` 列**（抄 career-ops 的 `data/applications.md` 减掉 PDF 列）：

```markdown
| # | Date | Company | Via | Role | Score | Status | Report | Notes |
```

**Status 封闭枚举**（抄 `templates/states.yml`，砍到 8 个）：`evaluated / applied / responded / interview / offer / rejected / discarded / skip`。

**`jobs/story-bank.md`**：完全照抄 `templates/story-bank.template.md` 的 `### ` 块格式（`Source / S / T / A / R / Reflection / Best for questions about`），加一列 LifeCard 特有的 `**Source card:** [[card:id]]` 指向该故事出自哪张卡。

### 6.5 模块划分建议

```
plugin/lib/
├── index.js          ← 只加 3 行：import buildJobsApi；...buildJobsApi(...)；job 版 doctor 挂钩
├── jobs/
│   ├── api.js        ← buildJobsApi：上面 12 个 handler
│   ├── evaluate.js   ← 两遍读法 + 五档重要性 + 闸门（可搬 career-ops modes/oferta.md 的逻辑）
│   ├── gates.js      ← dealbreaker / language / location / 死链（每条一个纯函数）
│   ├── resume.js     ← 简历定制：只产出 Markdown，不碰 PDF
│   ├── cover.js      ← 求职信：走 _writing.md 的硬规则
│   ├── story.js      ← STAR+R 故事银行读写
│   ├── tracker.js    ← applications.md 的读写 + 状态枚举校验
│   ├── network.js    ← ★ 关系网查询：给定公司/行业，查 relations/ 与 people/ 命中
│   └── prompts.js    ← 提示词模板（从这里注入用户卡数据）
└── ...
```

**`network.js` 是唯一 career-ops 给不了的东西**，也是最应该做的差异化：用户卡库里有 `people/`（前同事、同学、亲戚）+ `relations/`（affect / power / knowledge），求职插件能做的是「这家公司里我认识谁」「这个岗位的 hirer 可能跟我哪条关系链有关」。career-ops 只有 `modes/contacto.md` 靠 WebSearch 猜人，LifeCard 是**查自己的库**。

### 6.6 实现顺序建议

| 阶段 | 内容 | 可验证的产出 |
|---|---|---|
| v0.1 | `job.jd.add` + `job.evaluate` + `job.report.get`，只做「贴 JD → 4 段报告」 | 一份报告落 `jobs/evaluations/`，含两遍读法生成的匹配表 |
| v0.2 | 加 `jobs/gates.js`（dealbreaker / 语言 / 地点）+ 封闭状态枚举 | 命中 dealbreaker 时在报告前停，不写追踪行 |
| v0.3 | `job.resume.build` + `job.cover.build`（Markdown 输出，无 PDF） | 一份可复制的简历草稿 |
| v0.4 | `job.story.*` + `job.application.*` | 故事银行 + 追踪表可读写 |
| v0.5 | `job.network.who` | 「这家公司我认识谁」能查出结果 |
| v1.0 | 前端侧栏 UI | 全链路可视化 |

### 6.7 三条硬约束（写进代码，不要只写进提示词）

1. **永不自动投递、永不自动发信。** 三个候选项目全都守住了这条，且都写进了代码而不是 prompt。LifeCard 也应如此：不提供任何 `job.apply` 之类的对外动作接口。
2. **事实闸门。** 简历/求职信里的每个数字，必须能在 `cv.md` 或 `competency[].evidence[]` 里找到同值；找不到就拒绝生成（抄 `generate-pdf.mjs` 的逻辑）。`推测` 级来源的数字直接拒绝。
3. **JD 是非可信输入。** 在 `jobs/evaluate.js` 读 JD 前先过一遍 `posting_guard` 式清洗（剥零宽字符、隐藏文本、指令形状的行），并把它作为报告里的 Block「异常信号」呈现，而不是照着做。

---

## 附：本报告未查到的部分

- career-ops 的 `generate-pdf.mjs` 具体事实校验实现细节——只读了 README 的描述，**没有读源码**（`README.md` 的「What career-ops will not do」与「FAQ」两处交叉描述了行为，但代码没看过）。
- ai-job-search 的 `.claude/commands/apply.md` ——**工具连续两次读取失败**（`raw: direct: TIMEOUT after 8000ms`，`git: git not available`）。该文件的内容是从 `README.md` 的「How `/apply` works」8 步描述得到的，**不是原文**。
- ai-job-search 的 `.claude/skills/job-application-assistant/05-cv-templates.md`（21940B）与 `06-cover-letter-templates.md` ——未读，因为 LaTeX 管线已决定不搬。
- career-ops 的 `modes/scan.md`（39302B）、`modes/apply.md`（51010B）、`modes/pdf.md`（50485B）三个大文件——只读了 README 的摘要，未读全文。
- 各仓库的 issue / PR 讨论——未查（与「能不能抄」的判断无关）。
