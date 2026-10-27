#!/usr/bin/env python3
"""检查中文成稿的硬禁令与常见模型化形状。只报警，不自动改文。

标点口径：冒号、破折号、引号都不再按“出现即失败”处理，改为按密度判定。
引号本身不限量，只提醒同一篇里混用两套以上引号。冒号每千汉字允许两处，
长破折号（`——`）每千汉字允许六处，不足一千字的短稿各保底两处；超出限额才判失败。
单处破折号（`—`、`–`）只表停顿，不计入、也不判失败。
提示性抬价冒号（“一句话总结：”“核心是：”这类）仍然是硬失败。

体裁口径：默认 `--genre prose`，按说明文/观点文判。`--genre fiction` 走小说口径，
跳过商业黑话、硬停词、模型路标、名词化、连词密度，以及句长变异系数、短段连排、
单句段占比、借喻聚类这四类散文化节律警告——它们的参照系是长文散文，用在通篇短句
对白的小说上只会全中。小说的硬禁令（翻案句、抬价冒号、破折号密度、三连同构排比、
抽象名词配具体动词）一条不减。
"""

from __future__ import annotations

import argparse
import collections
import re
import sys
from dataclasses import dataclass
from pathlib import Path


HARD_STOPS = (
    "说白了",
    "说穿了",
    "先说结论",
)

HARD_JARGON = (
    "赋能",
    "抓手",
    "商业闭环",
    "价值闭环",
    "能力沉淀",
    "拉通",
    "底层逻辑",
    "顶层设计",
    "认知跃迁",
    "价值释放",
    "能力建设",
    "降本增效",
    "内容矩阵",
    "全链路",
    "组合拳",
    "打开想象空间",
    "结构性机会",
    "关键命题",
    "深层逻辑",
    "技术底座",
    "公共底座",
    "技术主权",
    "认知增量",
    "迭代闭环",
)

CONTEXT_JARGON = (
    "沉淀",
    "颗粒度",
    "对齐",
    "协同",
    "链路",
    "生态位",
    "心智",
    "范式",
    "方法论",
    "核心变量",
    "打法",
    "想象空间",
    "闭环",
    "不丢",
    "单点风险",
    "主脊柱",
    "材料锚点",
)

LYRIC_WORDS = (
    "安放",
    "抵达",
    "微光",
    "褶皱",
    "丰盈",
    "滚烫",
    "轻盈",
    "赤裸",
    "剥开",
)

ROAD_SIGNS = (
    "更微妙的是",
    "还有一层",
    "只说对了一半",
    "值得注意的是",
    "需要指出的是",
    "从某种意义上说",
)

ROAD_STRIP_CHARS = "。！？!? \n"

QUOTE_OPENERS = ("「", "『", "“", "‘", '"', "'")

QUOTE_PAIR_STYLES = (
    ("「」", re.compile(r"「[^」\n]{0,40}」")),
    ("『』", re.compile(r"『[^』\n]{0,40}』")),
    ("“”", re.compile(r"“[^”\n]{0,40}”")),
    ('""', re.compile(r'"[^"\n]{0,40}"')),
)

HOLLOW_COLON_LABELS = (
    "一句话总结",
    "一句话说",
    "一句话概括",
    "总结一下",
    "核心是",
    "关键是",
    "重点是",
    "先说结论",
    "答案很",
    "道理很",
    "问题在于",
    "本质是",
)

# 冒号每千汉字允许两处，长破折号每千汉字允许六处，短稿都保底两处。
COLON_ALLOWANCE_PER_1000 = 2
DASH_RUN_ALLOWANCE = 6
ALLOWANCE_FLOOR = 2
DASH_AFTER_COMMA = re.compile(r"，\s*[—–]{2,}")


def punctuation_allowance(total_han: int, per_1000: int) -> int:
    return max(ALLOWANCE_FLOOR, total_han * per_1000 // 1000)


def count_flagged_lines(text: str, lines, limit: int = 8) -> str:
    return "、".join(str(value) for value in lines[:limit])


def dash_marks(text: str):
    """返回两处以上的破折号串。两处以内是正常停顿，不计。"""

    return [
        (match.start(), match.group())
        for match in re.finditer(r"[—–]{2,}", text)
    ]


PIVOT_PATTERNS = (
    re.compile(r"(?:并)?不是[^。！？\n]{0,90}而是"),
    re.compile(r"并非[^。！？\n]{0,90}而是"),
    re.compile(r"不在于[^。！？\n]{0,90}而在于"),
    re.compile(r"与其说[^。！？\n]{0,90}(?:不如|毋宁|倒不如)"),
    re.compile(r"[。！？!?]\s*而是"),
    re.compile(r"表面(?:上)?[^。！？\n]{0,90}(?:其实|实际|实则)"),
    re.compile(r"看似[^。！？\n]{0,90}(?:其实|实际|实则)"),
)

SEMANTIC_PIVOT_PATTERNS = (
    re.compile(r"(?:总|一直|曾|都)?以为[^！？\n]{2,60}?(?:其实|才发现|才明白|才知道|后来才)"),
    re.compile(r"(?:总|都|一直)以为[^！？\n]{2,60}?[。，](?:可|但|其实)"),
    re.compile(r"回头(?:看|一看)?才(?:发现|明白|知道)"),
    re.compile(r"(?:并)?不是[^。！？\n]{1,40}，(?:更|才)?是[^，。！？\n]"),
    re.compile(r"从来(?:都)?(?:不是|与[^。！？，\n]{1,12}无关)"),
    re.compile(r"答案(?:是否定的|恰恰相反)|恰恰相反"),
    re.compile(r"表面(?:上)?[^！？\n]{0,60}。[^！？\n]{0,12}(?:其实|实际|实则)"),
    re.compile(r"看似[^！？\n]{0,60}。[^！？\n]{0,12}(?:其实|实际|实则)"),
    re.compile(r"[^，。！？\n]{1,12}不重要，(?:重要|要紧)的是"),
    re.compile(r"真正[^，。！？\n]{0,16}的(?:，)?是"),
)

NOMINALIZATION_PATTERNS = (
    re.compile(r"进行(?:了|一次|一场|着)?[^。，！？\n]{0,10}(?:调整|优化|升级|分析|讨论|沟通|梳理|复盘|迭代|探索|尝试|思考|规划|布局)"),
    re.compile(r"实现了?[^。，！？\n]{0,14}的?[^。，！？\n]{0,6}(?:提升|增长|突破|转变|跃升|落地)"),
    re.compile(r"完成了?对[^。，！？\n]{0,16}的"),
    re.compile(r"起到了?[^。，！？\n]{0,12}的?作用"),
    re.compile(r"具有[^。，！？\n]{0,10}(?:意义|价值)"),
)

CONJUNCTIONS = (
    "因为",
    "所以",
    "但是",
    "然而",
    "同时",
    "此外",
    "而且",
    "并且",
    "因此",
    "不仅",
)

ROAD_SIGN_PATTERNS = (
    re.compile(
        rf"(?:^|[。！？!?]\s*){re.escape(ROAD_SIGNS[0])}[^。！？!?\n]{{0,24}}",
        re.MULTILINE,
    ),
    re.compile(
        rf"(?:^|[。！？!?]\s*){re.escape(ROAD_SIGNS[1])}(?=(?:更|原因|问题|意思|考虑|变化|逻辑|价值|作用|风险|影响|值得|很少|不容易|常被|往往))[^。！？!?\n]{{0,24}}",
        re.MULTILINE,
    ),
    *(
        re.compile(
            rf"(?:^|[。！？!?]\s*){re.escape(phrase)}[^。！？!?\n]{{0,24}}",
            re.MULTILINE,
        )
        for phrase in ROAD_SIGNS[2:]
    ),
)

SOFT_MARKERS = (
    "真正",
    "本质上",
    "更深层次",
    "归根结底",
    "换句话说",
    "不可否认",
    "核心是",
    "关键在于",
    "这意味着",
)

REPEATED_OPENERS = (
    "其实",
    "不过",
    "当然",
    "所以",
    "但是",
    "后来",
    "当时",
    "很多人",
    "问题是",
    "更重要的是",
    "说到这里",
)

LEFT_BRANCH_PATTERNS = (
    re.compile(r"(?:^|[。！？]\s*)在[^，。！？\n]{12,70}(?:以后|之后|之前|以前|过程中|情况下|背景下)，"),
    re.compile(r"(?:^|[。！？]\s*)那些[^，。！？\n]{10,60}的[^，。！？\n]{2,30}[，。]"),
    re.compile(r"(?:^|[。！？]\s*)(?:真正|最终|最后)让[^，。！？\n]{8,70}的，是"),
)

METAPHOR_FIELDS = {
    "温度": ("降温", "升温", "冷却", "余温", "温度最高"),
    "生死战争": ("杀死", "死因", "枪响", "开火", "战场", "引爆", "弹药"),
    "建筑灾害": ("坍塌", "崩塌", "地基", "砖头", "支柱", "废墟"),
    "仓储租赁": ("仓库", "库房", "租金", "取货", "入库", "库存"),
    "道路竞赛": ("赛道", "跑道", "岔路", "十字路口", "终点线", "门票"),
    "机器器官": ("齿轮", "引擎", "发动机", "血管", "骨架", "肌肉"),
    "海洋航行": ("蓝海", "浪潮", "潮水", "航船", "灯塔", "彼岸"),
}


@dataclass
class Paragraph:
    position: int
    text: str
    han: int
    sentences: int


def han_count(text: str) -> int:
    return len(re.findall(r"[\u4e00-\u9fff]", text))


def line_number(text: str, position: int) -> int:
    return text.count("\n", 0, position) + 1


def excerpt(value: str, width: int = 72) -> str:
    value = re.sub(r"\s+", " ", value).strip()
    return value if len(value) <= width else value[: width - 1] + "…"


def mask_non_prose(text: str) -> str:
    """屏蔽代码、网址和机器元数据，同时保留字符位置与换行。"""

    def mask(match: re.Match[str]) -> str:
        return "".join("\n" if char == "\n" else " " for char in match.group())

    patterns = (
        re.compile(r"\A---\s*\n.*?\n---\s*(?:\n|\Z)", re.DOTALL),
        re.compile(r"```.*?```", re.DOTALL),
        re.compile(r"`[^`\n]*`"),
        re.compile(r"\]\([^\n)]*\)"),
        re.compile(r"https?://[^\s)>]+"),
        re.compile(r"<[^>\n]+>"),
    )
    masked = text
    for pattern in patterns:
        masked = pattern.sub(mask, masked)
    return masked


def non_overlapping_terms(text: str, terms: tuple[str, ...]):
    matches = []
    occupied = []
    for term in sorted(terms, key=len, reverse=True):
        for match in re.finditer(re.escape(term), text):
            start, end = match.span()
            if any(start < old_end and end > old_start for old_start, old_end in occupied):
                continue
            matches.append((start, term))
            occupied.append((start, end))
    return sorted(matches)


def all_matches(text: str, patterns: tuple[re.Pattern[str], ...]):
    matches = []
    for pattern in patterns:
        matches.extend(pattern.finditer(text))
    return sorted(matches, key=lambda match: match.start())


def heavy_de_sentences(text: str):
    """找出主干可能被多个“的”压到后面的长句。"""

    matches = []
    pattern = re.compile(r"[^。！？!?\n]+(?:[。！？!?]|$)")
    for match in pattern.finditer(text):
        value = match.group()
        if han_count(value) >= 38 and value.count("的") >= 4:
            matches.append(match)
    return matches


def anaphora_runs(text: str, minimum: int = 3):
    """找出同一句里三个以上小句用同一个开头的排比。"""

    matches = []
    for sentence in re.finditer(r"[^。！？!?\n]+(?:[。！？!?]|$)", text):
        clauses = [
            clause.strip()
            for clause in re.split(r"[，、；,;]", sentence.group())
            if han_count(clause) >= 3
        ]
        if len(clauses) < minimum:
            continue
        run = 1
        for previous, current in zip(clauses, clauses[1:]):
            if previous[:2] == current[:2] and re.match(r"[一-鿿]{2}", current):
                run += 1
                if run >= minimum:
                    matches.append(sentence)
                    break
            else:
                run = 1
    return matches


def sentence_length_cv(text: str):
    """句长变异系数。人写的长短句差距大，模型的句长彼此接近。"""

    lengths = [
        han_count(match.group())
        for match in re.finditer(r"[^。！？!?\n]+[。！？!?]", text)
        if han_count(match.group()) >= 4
    ]
    if len(lengths) < 12:
        return None
    mean = sum(lengths) / len(lengths)
    if mean == 0:
        return None
    variance = sum((value - mean) ** 2 for value in lengths) / len(lengths)
    return (variance ** 0.5) / mean, len(lengths)


def bracket_highlights(text: str):
    """「」括起来的短语。太密说明在批量造金句。"""

    return list(re.finditer(r"[「『][^」』\n]{1,6}[」』]", text))


def prose_paragraphs(text: str) -> list[Paragraph]:
    paragraphs = []
    cursor = 0
    for block in re.split(r"\n\s*\n", text):
        position = text.find(block, cursor)
        cursor = max(position + len(block), cursor)
        clean = re.sub(r"[>*_`]", "", block).strip()
        if not clean or clean.startswith(("#", "http", "![", "```")):
            continue
        if re.match(r"^(?:[-+*]|\d+[.、])\s", clean):
            continue
        count = han_count(clean)
        if count < 4:
            continue
        sentences = max(1, len(re.findall(r"[。！？!?]", clean)))
        paragraphs.append(Paragraph(position, clean, count, sentences))
    return paragraphs


def metaphor_cluster(text: str, distance: int = 800):
    hits = []
    for field, words in METAPHOR_FIELDS.items():
        for word in words:
            for match in re.finditer(re.escape(word), text):
                hits.append((match.start(), field, word))
    hits.sort()
    for index, (start, _, _) in enumerate(hits):
        window = [hit for hit in hits[index:] if hit[0] - start <= distance]
        fields = {hit[1] for hit in window}
        if len(fields) >= 3:
            return window, fields
    return None


def short_streak(paragraphs: list[Paragraph], limit: int = 4):
    streak = []
    for paragraph in paragraphs:
        if paragraph.han <= 24 and paragraph.sentences <= 1:
            streak.append(paragraph)
            if len(streak) >= limit:
                return streak
        else:
            streak = []
    return None


def opener_counts(paragraphs: list[Paragraph]):
    counts = collections.Counter()
    examples = {}
    for paragraph in paragraphs:
        value = paragraph.text.lstrip("“‘\"（(")
        for opener in REPEATED_OPENERS:
            if value.startswith(opener):
                counts[opener] += 1
                examples.setdefault(opener, paragraph.position)
                break
    return counts, examples


def read_text(path: str) -> str:
    if path == "-":
        return sys.stdin.read()
    return Path(path).read_text(encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description="检查中文成稿的硬禁令与模型化形状")
    parser.add_argument("path", help="Markdown 或文本文件路径。使用 - 从标准输入读取")
    parser.add_argument(
        "--genre",
        choices=("prose", "fiction"),
        default="prose",
        help="prose（默认）按说明文/观点文判；fiction 走小说口径，跳过说明文专属项",
    )
    args = parser.parse_args()

    try:
        text = read_text(args.path)
    except (OSError, UnicodeError) as error:
        print(f"无法读取稿件。{error}", file=sys.stderr)
        return 2

    prose = mask_non_prose(text)
    total_han = han_count(prose)
    if total_han == 0:
        print("没有检测到汉字。", file=sys.stderr)
        return 2

    failures = []
    warnings = []

    fiction = args.genre == "fiction"
    if fiction:
        hard_stops: tuple[str, ...] = ()
        hard_jargon: tuple[str, ...] = ()
        context_jargon: tuple[str, ...] = ()
        soft_markers: tuple[str, ...] = ()
        conjunctions: tuple[str, ...] = ()
        road_sign_patterns: tuple[re.Pattern[str], ...] = ()
        nominalization_patterns: tuple[re.Pattern[str], ...] = ()
    else:
        hard_stops = HARD_STOPS
        hard_jargon = HARD_JARGON
        context_jargon = CONTEXT_JARGON
        soft_markers = SOFT_MARKERS
        conjunctions = CONJUNCTIONS
        road_sign_patterns = ROAD_SIGN_PATTERNS
        nominalization_patterns = NOMINALIZATION_PATTERNS

    colon_hits = []
    for symbol in ("：", ":"):
        for match in re.finditer(re.escape(symbol), prose):
            before = prose[match.start() - 1 : match.start()]
            after = prose[match.end() : match.end() + 1]
            if before.isdigit() and after.isdigit():
                continue
            colon_hits.append(match.start())
    colon_hits.sort()

    hollow_colons = []
    quote_colons = []
    for position in colon_hits:
        head = prose[max(0, position - 14) : position]
        tail = prose[position + 1 : position + 3].lstrip()
        if any(hollow in head for hollow in HOLLOW_COLON_LABELS):
            hollow_colons.append(position)
        elif tail[:1] in QUOTE_OPENERS:
            quote_colons.append(position)

    if hollow_colons:
        lines = count_flagged_lines(
            text, [line_number(text, position) for position in hollow_colons]
        )
        failures.append(
            f"提示性抬价冒号共 {len(hollow_colons)} 处，第 {lines} 行。"
            "这种冒号只是把下文抬成结论，改成正面陈述或句号。"
        )

    colon_allowance = punctuation_allowance(total_han, COLON_ALLOWANCE_PER_1000)
    if len(colon_hits) > colon_allowance:
        lines = count_flagged_lines(
            text, [line_number(text, position) for position in colon_hits]
        )
        failures.append(
            f"冒号共 {len(colon_hits)} 处，超过这份稿子 {total_han} 字允许的 "
            f"{colon_allowance} 处（每千字 {COLON_ALLOWANCE_PER_1000} 处），第 {lines} 行起。"
            "引出原话、列条目、标时间和比例都可以留，超出的改成逗号、句号或直接说。"
        )
    elif colon_hits:
        lines = count_flagged_lines(
            text, [line_number(text, position) for position in colon_hits]
        )
        warnings.append(
            f"冒号 {len(colon_hits)} 处，限额 {colon_allowance} 处，第 {lines} 行"
            f"（其中直接引出原话 {len(quote_colons)} 处）。"
            "确认每一处都在引出原话、列条目或交代时间比例，不是替读者下结论。"
        )

    dash_runs = dash_marks(prose)
    dash_allowance = punctuation_allowance(total_han, DASH_RUN_ALLOWANCE)
    if len(dash_runs) > dash_allowance:
        lines = count_flagged_lines(
            text, [line_number(text, position) for position, _ in dash_runs]
        )
        failures.append(
            f"长破折号 {len(dash_runs)} 处，超过 {total_han} 字允许的 "
            f"{dash_allowance} 处，第 {lines} 行起。"
            "留两三处真有停顿作用的，其余换成逗号、句号或括号。"
        )
    elif dash_runs:
        lines = count_flagged_lines(
            text, [line_number(text, position) for position, _ in dash_runs]
        )
        warnings.append(
            f"长破折号 {len(dash_runs)} 处，限额 {dash_allowance} 处，第 {lines} 行。"
            "确认每处都是补语、插说或真的停顿，不是拿它替翻案腔断句。"
        )

    if DASH_AFTER_COMMA.search(prose):
        warnings.append(
            "逗号后面紧跟长破折号。这里多半是在替下文抬价，改成直接说。"
        )

    quote_styles = [
        name for name, pattern in QUOTE_PAIR_STYLES if pattern.search(prose)
    ]
    if len(quote_styles) > 1:
        warnings.append(
            f"同一篇出现 {'、'.join(quote_styles)} 两套以上引号制度。"
            "引号不限数量，但全文只留一套；转述不必加引号。"
        )

    stop_matches = non_overlapping_terms(prose, hard_stops)
    for position, phrase in stop_matches:
        failures.append(f"硬停词，第 {line_number(text, position)} 行，{phrase}")

    jargon_matches = non_overlapping_terms(prose, hard_jargon)
    for position, phrase in jargon_matches:
        failures.append(f"黑话，第 {line_number(text, position)} 行，{phrase}")

    context_jargon_matches = non_overlapping_terms(prose, context_jargon)
    hard_spans = [
        (position, position + len(phrase)) for position, phrase in jargon_matches
    ]
    context_jargon_matches = [
        (position, phrase)
        for position, phrase in context_jargon_matches
        if not any(
            position < end and position + len(phrase) > start
            for start, end in hard_spans
        )
    ]
    if context_jargon_matches:
        samples = "、".join(
            dict.fromkeys(phrase for _, phrase in context_jargon_matches)
        )
        lines = "、".join(
            dict.fromkeys(
                str(line_number(text, position))
                for position, _ in context_jargon_matches[:8]
            )
        )
        warnings.append(
            f"有 {len(context_jargon_matches)} 处词语需要结合语境判断。"
            f"第 {lines} 行出现 {samples}。本义准确时保留，用来抬价时改写。"
        )

    road_signs = all_matches(prose, road_sign_patterns)
    for match in road_signs:
        failures.append(
            f"模型路标，第 {line_number(text, match.start())} 行，"
            f"“{excerpt(match.group().lstrip(ROAD_STRIP_CHARS))}”"
        )

    pivots = all_matches(prose, PIVOT_PATTERNS)
    for match in pivots:
        failures.append(
            f"禁用翻案句，第 {line_number(text, match.start())} 行，"
            f"“{excerpt(match.group())}”"
        )

    occupied_spans = [match.span() for match in pivots]
    semantic_pivots = []
    for match in all_matches(prose, SEMANTIC_PIVOT_PATTERNS):
        if any(
            match.start() < end and match.end() > start
            for start, end in occupied_spans
        ):
            continue
        semantic_pivots.append(match)
        occupied_spans.append(match.span())
    for match in semantic_pivots:
        warnings.append(
            f"疑似翻案腔变形，第 {line_number(text, match.start())} 行，"
            f"“{excerpt(match.group(), 44)}”。先立误解再推翻就改成正面陈述，正常用法保留。"
        )

    anaphoras = anaphora_runs(prose)
    for match in anaphoras[:4]:
        warnings.append(
            f"三连以上同构排比，第 {line_number(text, match.start())} 行，"
            f"“{excerpt(match.group(), 44)}”。留两项，第三项换说法或删掉。"
        )

    lyric_matches = non_overlapping_terms(prose, LYRIC_WORDS)
    if len(lyric_matches) >= 2:
        samples = "、".join(dict.fromkeys(term for _, term in lyric_matches))
        warnings.append(
            f"模型偏爱的抒情词 {len(lyric_matches)} 处。{samples}。"
            "写具体事物时保留，给抽象概念穿衣服时删掉。"
        )

    nominalizations = all_matches(prose, nominalization_patterns)
    for match in nominalizations[:4]:
        warnings.append(
            f"名词化句式，第 {line_number(text, match.start())} 行，"
            f"“{excerpt(match.group(), 36)}”。还原成直接的动词。"
        )

    conjunction_hits = non_overlapping_terms(prose, conjunctions)
    if total_han >= 600 and len(conjunction_hits) * 1000 / total_han > 7:
        samples = "、".join(
            f"{term} {count} 次"
            for term, count in collections.Counter(
                term for _, term in conjunction_hits
            ).most_common(4)
        )
        warnings.append(
            f"连词密度偏高，每千字 {len(conjunction_hits) * 1000 // total_han} 个。{samples}。"
            "中文小句靠语序和事理相接，删掉一半试试。"
        )

    highlights = bracket_highlights(prose)
    highlight_limit = max(3, total_han // 700)
    if len(highlights) > highlight_limit:
        samples = "、".join(dict.fromkeys(match.group() for match in highlights[:6]))
        warnings.append(
            f"「」括起的短语共 {len(highlights)} 处。{samples}。太密说明在批量造金句。"
        )

    cv_result = None if fiction else sentence_length_cv(prose)
    if cv_result and cv_result[0] < 0.42:
        warnings.append(
            f"全文 {cv_result[1]} 个句子长度过于接近（变异系数 {cv_result[0]:.2f}）。"
            "人写的段落里十个字的句子会挨着四十个字的句子，放开几句，压短几句。"
        )

    marker_matches = non_overlapping_terms(prose, soft_markers)
    marker_limit = max(2, total_han // 900)
    if len(marker_matches) > marker_limit:
        samples = "、".join(dict.fromkeys(term for _, term in marker_matches))
        warnings.append(
            f"洞察路标共 {len(marker_matches)} 处，当前提醒线为 {marker_limit} 处。"
            f"重点检查 {samples}。"
        )

    left_branches = all_matches(prose, LEFT_BRANCH_PATTERNS)
    left_limit = max(2, total_han // 1200)
    if len(left_branches) > left_limit:
        samples = "；".join(
            f"第 {line_number(text, match.start())} 行“{excerpt(match.group(), 44)}”"
            for match in left_branches[:4]
        )
        warnings.append(
            f"长前置成分共 {len(left_branches)} 处，可能让主干来得太晚。{samples}"
        )

    dense_de = heavy_de_sentences(prose)
    dense_de_limit = max(1, total_han // 1500)
    if len(dense_de) > dense_de_limit:
        samples = "；".join(
            f"第 {line_number(text, match.start())} 行“{excerpt(match.group(), 44)}”"
            for match in dense_de[:4]
        )
        warnings.append(
            f"有 {len(dense_de)} 个长句包含四个以上的“的”，可能要先交代人和动作。{samples}"
        )

    paragraphs = prose_paragraphs(prose)
    if len(paragraphs) >= 10 and not fiction:
        one_sentence = sum(paragraph.sentences <= 1 for paragraph in paragraphs)
        ratio = one_sentence / len(paragraphs)
        if ratio >= 0.75:
            warnings.append(
                f"可识别段落中有 {ratio:.0%} 只有一句话，可能形成统一的短段鼓点。"
            )

    streak = None if fiction else short_streak(paragraphs)
    if streak:
        first = streak[0]
        warnings.append(
            f"从第 {line_number(text, first.position)} 行起连续出现 {len(streak)} 个短促单句段，"
            "检查是否在排队喊结论。"
        )

    counts, opener_examples = opener_counts(paragraphs)
    repeated = [(opener, count) for opener, count in counts.items() if count >= 4]
    if repeated:
        details = "、".join(f"{opener} {count} 次" for opener, count in repeated)
        first_position = min(opener_examples[opener] for opener, _ in repeated)
        warnings.append(
            f"段落开场重复，从第 {line_number(text, first_position)} 行附近开始。{details}。"
        )

    metaphors = None if fiction else metaphor_cluster(prose)
    if metaphors:
        window, fields = metaphors
        samples = "、".join(dict.fromkeys(hit[2] for hit in window))
        warnings.append(
            f"八百字内出现 {len(fields)} 套借喻。{'、'.join(sorted(fields))}。"
            f"例词有 {samples}。"
        )

    print(f"汉字数 {total_han}")
    if fiction:
        print(
            "体裁 fiction：已跳过商业黑话、硬停词、模型路标、名词化、连词密度，"
            "以及句长变异系数、短段连排、单句段占比、借喻聚类这四类散文化节律警告。"
        )
    print(
        f"翻案句 {len(pivots)}，翻案腔变形 {len(semantic_pivots)}，"
        f"同构排比 {len(anaphoras)}，名词化 {len(nominalizations)}，"
        f"黑话 {len(jargon_matches)}，硬停词 {len(stop_matches)}，"
        f"模型路标 {len(road_signs)}，需辨语境词 {len(context_jargon_matches)}，"
        f"抒情词 {len(lyric_matches)}，洞察路标 {len(marker_matches)}，"
        f"长前置成分 {len(left_branches)}，重定语句 {len(dense_de)}"
    )

    if failures:
        print("\n需要修改")
        for item in failures:
            print(f"- {item}")

    if warnings:
        print("\n需要人工判断")
        for item in warnings:
            print(f"- {item}")

    if not failures and not warnings:
        print("\n未发现这份检查器覆盖的问题。")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
