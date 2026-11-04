# LifeCard

[![npm](https://img.shields.io/npm/v/dsh-lifecard)](https://www.npmjs.com/package/dsh-lifecard)
[![月下载](https://img.shields.io/npm/dm/dsh-lifecard)](https://www.npmjs.com/package/dsh-lifecard)
[![DSH](https://img.shields.io/badge/DSH-0.2.x-blue)](https://github.com/hulibuld/dsh-lifecard)
[![License](https://img.shields.io/npm/l/dsh-lifecard)](LICENSE)

`dsh plugin --profile desktop add dsh-lifecard` · [遇到问题开 issue](https://github.com/hulibuld/dsh-lifecard/issues/new/choose)

把一个人写成能读、能查、能带走的文件。

家里的人、老朋友、你自己，一件一件问清楚：做过什么，怎么说话，你们之间发生过什么，写成一张卡。存在你自己的文件夹里，纯文本，记事本就能打开，换台电脑也能带走。不联网，不上传。它也不替你编，每条都要能在你写过的原话里找到出处，找不到就丢掉。

顺带还能求职：拿这些材料判断一份招聘值不值得投、改简历、练面试。它只重组你写过的东西，不替你造一个数字。

## 装

桌面版在插件管理里装，或者：

```
dsh plugin --profile desktop add dsh-lifecard
```

从源码装，把包名换成你 clone 下来的目录，末尾要带上 `plugin`——这个仓库的 `package.json` 在 `plugin/` 里，指到仓库根目录装不上：

```
dsh plugin --profile desktop add /绝对路径/LifeCard/plugin
```

装完重启 DSH。桌面版被应用独占，没有热重载。重启后左边那排图标里多一个 Life Cards，一个打开的小本子。

不需要注册账号，不需要联网，没有后端。你自己开了 AI 分析才会用到模型。

## 五分钟上手

全部在侧边栏里点，不用敲命令。

1. 选一个文件夹当档案库。第一次打开会让你选，选完里面出现 `people/`、`materials/` 这些子目录。
2. 建第一张卡。三条路：首页点导入，把 SillyTavern 的 PNG / JSON / CHARX 搬进来；或者跟宿主说一句「帮我建一张我妈的卡」，它在对话里问，给选项也留「都不像，我自己说」；或者首页点新建，自己一条条填。
3. 有材料之后，首页右边会出现「整理 N 份材料」，点它。出来的是一张勾选清单，每条带一句原文引文。找不到原文的条目直接丢掉，不会出现在清单里。
4. 默认一条都不勾。勾完点「就用这 N 条」，才写进卡。AI 只能提案，不能写卡。
5. 右上角点「检查一下」，给 0 到 100 分，还列出还能补的卡。低于 75 通常是内容没填够，不是写错了。

之后用 Obsidian、VS Code 或者任何文本编辑器打开那个文件夹就行。卡都是 `.md`，YAML 头加正文。

## 三个预设

装好插件、完全退出 DSH 再打开之后，新对话右上角选预设的地方会多三个：

| 预设 | 干什么 |
| --- | --- |
| LC 酒馆 | 拿卡和它的世界书演一段，你一句它一句，认这个人的口气和不会说的话 |
| LC 小说 | 一章一章往下写，人物和世界从卡里取，一次只写一章，写完说清这一章推进了什么 |
| LC 现实 | 按你写过的经历出简历、排下一步要走的路、说清还差什么 |

用之前在侧边栏对应那扇门里选好现在演谁、现在写谁，预设按你选的那张卡取设定，不用每次报名字。

这三个预设读卡走五个只读工具，不改你的文件。写进卡里的内容仍然只有你在侧边栏里勾过才算。

## 还有几样

日记。一天一篇，AI 带着写，写完真的落到磁盘上，不会悄悄盖掉你自己写的东西。顺手把「我」和日记助手那两张卡养准，改之前会把要改的地方列给你看。

人物关系网。以你为中心，谁直接认识、谁只是通过别人认识的，能连两个人。

改剧本。写小说那扇门里，一章打开后正文下面有一节「改成剧本」。点一下，这一章切成一场场：叙述变成以 `△` 开头的动作行，人物的话变成台词，拍不出来的东西丢掉。第一份是草稿，可以删半场、改台词、整段重写，再存好。存在书目录的 `scripts/` 下，和章节同号。改第二章时会带上一章剧本的最后一场，接住谁站在哪、手上有什么。改完顺手数一遍：几场、几句台词、几行动作，有没有哪一场没写白天夜里，有没有哪一行还停在小说里没转成动作。数出来的是事实，不是意见。

## 文件长什么样

```
my-cards/
├── lifecard.config.json
├── self/
│   ├── self.card.md            # 关于我的事实（可导出）
│   └── self.lens.md            # 我的偏好（永不可导出）
├── people/
│   └── 妈妈.card.md
├── relations/
│   └── mama--self.relation.md
├── worlds/
│   └── eldoria/
│       ├── world.md
│       └── lorebook/
├── systems/
├── materials/                  # 原始材料，只追加不改
├── proposals/                  # AI 提案，等你勾选
└── assets/
```

一张卡大概是这样：

```markdown
---
lifecard: "0.1"
id: mama
kind: real
world: reality
name: 妈妈
relation: parent
competency:
  - key: cooking
    label: 家常菜
    level: 精通
    evidence:
      - {kind: 自述, what: 二十多年没有重复过菜单}
---

## 自述

1958 年生，c 市人，做了三十年会计……

## 性格

说话直，不喜欢绕弯。对钱谨慎，对吃大方。
```

最后一个括号里的写法不用建字段，直接写在句子后面就行，这是这个项目最常用的写法。

## 跟 SillyTavern 的关系

能读对方的卡，也能导出成对方能吃的格式：

| 格式 | 读 | 写 |
| --- | --- | --- |
| V2 PNG（`chara` chunk） | 能 | 能 |
| V3 PNG（`ccv3` chunk） | 能 | 能 |
| CCv2 / CCv3 JSON | 能 | 能 |
| CHARX（`.charx` zip） | 能 | v0.2 |
| 独立世界书文件 | 能，导进来后首页「世界书」里逐条读 | v0.2 |

卡里不认识的 `extensions`、`decorator`、CBS 宏一律原样保存，导出时原样写回。它不解释这些东西是什么意思，只保证不丢。

导出时 V3 那份是 V2 那份的严格超集，不允许出现只在一边有的字段，否则只认一个 chunk 的前端会读到两张不同的卡。

它不执行传播语义，不算 `{{random}}`、不解析 lorebook 的递归扫描、不按 `@@depth` 调整注入位置。要一个能跑起来的扮演环境，用 SillyTavern 本身；这个工具只管编辑。

## 隐私

数据只在你指定的文件夹里，没有云同步，没有遥测。

AI 分析只用宿主已有的模型，插件不额外配 key、不自己写 HTTP 客户端。宿主没配模型，分析按钮就用不了，其它功能照常。

没有账号系统，也没有找回密码，文件丢了就是丢了，自己备份。

导出成可传播的格式（PNG、CHARX、zip）时会问一句这张卡的对象是否知情同意，本地保存、编辑、搜索不问。

## 现状

`plugin/` 是一个可安装的 DSH 侧边栏插件。导入、访谈、分析、采纳、导出、体检、版本历史跑通了，日记、关系网、简历、小说与剧本、酒馆也都在里面。测试 4006 项，对真实 DSH 实例的端到端验收 22 项。

## 许可

MIT，见 [LICENSE](LICENSE)。
