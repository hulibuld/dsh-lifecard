window.__ModuleLoader__.load({
	id: "dsh-lifecard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

/**
 * dsh-lifecard —— 浏览器侧。
 *
 * 这一侧只做两件事：
 *   1. 通过 `POST /api/dsh-lifecard/<method>` 调宿主（浏览器不能碰文件系统）
 *   2. 把界面画出来
 *
 * 界面原则（写给未来的自己）：
 *   · 屏幕上不出现 JSON、不出现文件夹路径、不出现 chunk / spec / schema 这些词。
 *   · 每一个按钮都要说清楚「按了会发生什么」，用动词，不用名词。
 *   · 用户可能完全不懂技术。看不懂的东西要么翻译成人话，要么收进「更多」。
 */

const React = require('react')
const { useState, useEffect, useMemo, useRef, useCallback } = React
const h = React.createElement

// ── 通信 ──────────────────────────────────────────────────────────

const API = '/api/dsh-lifecard'

async function call(method, body) {
  let res
  try {
    res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
  } catch {
    // 网络层抛出来的东西（TypeError / Failed to fetch / ECONNREFUSED）对用户没有意义
    throw new Error('连不上后台。可能是软件刚启动还没准备好，等几秒再试一次。')
  }
  if (!res.ok) {
    // 状态码和响应体留给控制台排错，不摆到界面上：里面常带内部字段名与英文
    if (typeof console !== 'undefined') console.warn(`[lifecard] ${method} HTTP ${res.status}`)
    throw new Error(res.status === 401 || res.status === 403
      ? '这一步没有权限，没做成。'
      : '后台没能完成这一步。等一会儿再试一次；还不行就重启一下软件。')
  }
  let json
  try {
    json = await res.json()
  } catch {
    throw new Error('后台回的话没看懂，这一步可能没做成。再试一次看看。')
  }
  // 有些路由把 error 写成了 {code, message}（导出门禁那几条就是这样）。
  // 界面拿到的是这个东西本身，塞进红字里就是 [object Object]，
  // 严重时 React 直接抛、用户看到白屏。在这里统一压成一句话，
  // 比让每个调用点各自记得判形状可靠——漏一个就是一个白屏。
  if (json !== null && typeof json === 'object' && json.error !== null && typeof json.error === 'object') {
    json.error = String(json.error.message ?? json.error.error ?? '这一步没做成。')
  }
  return json
}

/**
 * 把程序抛出来的错误翻译成人话。
 *
 * 界面原则：屏幕上不出现 TypeError / fetch failed / EACCES / JSON 片段这类东西。
 * 已经是中文白话的错误原样放过；带技术标识的统一换成「怎么办」。
 * 幂等：对已经翻译过的文案再调用一次不会变形（渲染层会再兜一层）。
 */
function humanizeError(input) {
  const raw0 = String(input?.message ?? input ?? '').trim()
  if (raw0 === '' || raw0 === '[object Object]') return '这一步没做成，再试一次看看。'
  // 先剥掉 `Error:` / `TypeError:` / `Exception:` 这类壳
  const raw = raw0.replace(/^[A-Za-z]*Error:\s*/i, '').replace(/^Exception:\s*/i, '').trim()
  if (/fetch failed|failed to fetch|networkerror|econnrefused|enotfound|load failed|network request failed/i.test(raw)) {
    return '连不上后台。可能是软件刚启动还没准备好，等几秒再试一次。'
  }
  if (/chara|ccv3|ccv2|chunk|charx|tEXt/i.test(raw)) {
    return '这个文件里读不出角色信息。它可能不是角色卡，或者文件已经坏了。'
  }
  if (/enoent|no such file|不是文件夹|文件夹不存在/i.test(raw)) return '找不到那个位置了。它可能刚被移走或改名了，重新选一次。'
  if (/eacces|eperm|permission|没有权限/i.test(raw)) return '没有权限动这个位置。换一个文件夹再试。'
  if (/enospc|no space|磁盘满/i.test(raw)) return '磁盘满了，存不进去。清一点空间再试。'
  // 残留异常类名、代码记号、英文标识 → 不摆给用户看
  if (/error|exception|undefined|null|nan|\[object/i.test(raw)) return '这一步没做成。等一会儿再试一次；还不行就重启一下软件。'
  if (/[{}\[\]<>]/.test(raw)) return '这一步没做成。等一会儿再试一次；还不行就重启一下软件。'
  return raw
}

/**
 * 把卡的检查结果翻译成人话。
 *
 * core 的校验消息是写给开发者看的（`competency[红烧肉].level "expert" 不在 入门 / 熟手 …`），
 * 直接摆到界面上等于没翻译。这里按字段翻成「哪里不对」，翻不出来就退一句不带技术词的总说。
 */
/**
 * 粗估「这张卡读进去会占多少字」。
 *
 * 为什么要给用户看这个：很多人写卡时不知道自己在写什么量级，写到三千字
 * 才发现 AI 一次读不完。给个粗估比讲「token」有用得多。
 * 只算中文按字、英文按 4 字符 1 个单位——跟 lib/score.js 的算法保持一致。
 */
function roughSize(text) {
  const s = String(text ?? '')
  let cjk = 0, other = 0
  for (const ch of s) {
    const code = ch.codePointAt(0)
    if (code >= 0x2e80 && code <= 0x9fff) cjk++
    else if (code >= 0xf900 && code <= 0xfaff) cjk++
    else if (code >= 0xff00 && code <= 0xffef) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

function humanizeIssue(issue) {
  const field = String(issue?.field ?? '')
  const msg = String(issue?.message ?? '')
  const quoted = []
  const re = /"([^"]*)"/g
  let m = re.exec(msg)
  while (m !== null) { quoted.push(m[1]); m = re.exec(msg) }

  if (/缺少 kind/.test(msg) || /kind 的值/.test(msg)) return '这张卡还没说清是哪一种，去「改这张卡」里选一下。'
  if (/缺少必需的?字段/.test(msg)) return `缺了必填的「${fieldLabel(field)}」。`
  if (/lifecard 版本/.test(msg) || /缺少 lifecard/.test(msg)) return '这张卡是别的版本做的，会按现在的规则读，不影响你用。'
  if (/^lens 卡/.test(msg)) return '「我的偏好」这种卡按设计不会导出给别人。'
  if (/^level /.test(msg)) return '能力程度只能选：入门、熟手、精通、专家。'
  if (/\.level "/.test(msg)) return `「${quoted[0] ?? '有一项能力'}」的程度不对，只能选：入门、熟手、精通、专家。`
  if (/evidence 应是数组/.test(msg)) return `「${quoted[0] ?? '有一项能力'}」的依据写法不对，要一条一条分开写。`
  if (/evidence\.kind/.test(msg)) return '能力依据的来源只能选：自述、他述、文档、推测。'
  if (/family-agreed/.test(msg) && /recorded_at/.test(msg)) return '选了「对方（或家人）知道并同意」，还要补上同意的日期。'
  if (/consent\.basis/.test(msg)) return '「对方知不知道」这一项的选项不对，重新选一下。'
  if (/^status /.test(msg)) return '「他现在」这一项的选项不对，重新选一下。'
  if (/from 与 to 不能是同一个人/.test(msg)) return '一段关系的两头不能是同一个人。'
  if (/关系边的 from/.test(msg)) return `这段关系的起点（${quoted[0] ?? '某个人'}）找不到对应的卡。`
  if (/关系边的 to/.test(msg)) return `这段关系的终点（${quoted[0] ?? '某个人'}）找不到对应的卡。`
  if (/world .* 不存在/.test(msg)) return `这张卡写的「属于哪个世界」（${quoted[0] ?? ''}）还没建出来，留空就行。`
  if (/卡上不应有 system|系统在调用时/.test(msg)) return '「一套设定」不算卡的属性，去掉不影响使用。'
  if (/affect 属于关系边/.test(msg)) return '「你们之间的亲疏」写在关系里，不写在个人卡上。'
  if (/未满 18 岁/.test(msg)) return '这个人还没满 18 岁，按规则这张卡不能对外导出。'
  // 已经全是中文、没有代码记号 → 原样用
  if (!/[a-z_]+\.[a-z_]+|\[|\]|_|§|--/.test(msg)) return msg
  return `「${fieldLabel(field)}」这一项写法不太对，点「改这张卡」能就地改。`
}

/** `people/妈妈.card.md` → `妈妈`。界面上不摆文件路径。 */
function cardNameFromPath(rel) {
  const base = String(rel ?? '').split('/').pop() ?? ''
  const stripped = base.replace(/\.(card|world|system|relation)\.md$/i, '').replace(/\.md$/i, '')
  return stripped === '' ? '一张卡' : stripped
}

// ── 图标（内联 SVG，颜色由 currentColor 决定）─────────────────────

function Icon({ name, size = 16 }) {
  const common = {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': 'true',
  }
  switch (name) {
    case 'card': return h('svg', common, h('rect', { x: 3, y: 5, width: 18, height: 14, rx: 2.5 }), h('path', { d: 'M7 10h6M7 14h4' }))
    case 'person': return h('svg', common, h('circle', { cx: 12, cy: 8, r: 3.4 }), h('path', { d: 'M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6' }))
    case 'people': return h('svg', common, h('circle', { cx: 9, cy: 8, r: 3 }), h('path', { d: 'M3 19c0-3.3 2.7-5.5 6-5.5s6 2.2 6 5.5' }), h('path', { d: 'M16 6.2a3 3 0 0 1 0 5.6M18 19c0-2.2-.8-3.9-2-5' }))
    case 'relation': return h('svg', common, h('circle', { cx: 6, cy: 12, r: 2.5 }), h('circle', { cx: 18, cy: 12, r: 2.5 }), h('path', { d: 'M8.5 12h7' }), h('path', { d: 'M13 9.5 15.5 12 13 14.5' }))
    case 'plus': return h('svg', common, h('path', { d: 'M12 5v14M5 12h14' }))
    case 'import': return h('svg', common, h('path', { d: 'M12 3v10M8 9l4 4 4-4' }), h('path', { d: 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2' }))
    case 'chat': return h('svg', common, h('path', { d: 'M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H9l-4 4v-4A2.5 2.5 0 0 1 4 13.5z' }))
    case 'spark': return h('svg', common, h('path', { d: 'M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18l-1.8-5.4L4.7 10.8 10.2 9z' }))
    case 'check': return h('svg', common, h('path', { d: 'M4.5 12.5 9 17l10.5-10.5' }))
    case 'x': return h('svg', common, h('path', { d: 'M6 6l12 12M18 6L6 18' }))
    case 'doctor': return h('svg', common, h('path', { d: 'M12 3.5 4.5 7v5c0 4.3 3.1 7.6 7.5 8.5 4.4-.9 7.5-4.2 7.5-8.5V7z' }), h('path', { d: 'M9 12h2v2M13 11h2v4' }))
    case 'folder': return h('svg', common, h('path', { d: 'M3 7.5A1.5 1.5 0 0 1 4.5 6h5l2 2h8A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z' }))
    case 'back': return h('svg', common, h('path', { d: 'M15 5l-7 7 7 7' }))
    case 'edit': return h('svg', common, h('path', { d: 'M4 20h4l10-10-4-4L4 16z' }), h('path', { d: 'M13.5 6.5 17.5 10.5' }))
    case 'pencil': return h('svg', common, h('path', { d: 'M4 20h4l10-10-4-4L4 16z' }), h('path', { d: 'M13.5 6.5 17.5 10.5' }))
    case 'download': return h('svg', common, h('path', { d: 'M12 4v10M8 10l4 4 4-4' }), h('path', { d: 'M5 19h14' }))
    case 'send': return h('svg', common, h('path', { d: 'M4.5 12 20 4.5 15 20l-3.5-6z' }))
    case 'skip': return h('svg', common, h('path', { d: 'M5 6l7 6-7 6zM13 6l7 6-7 6z' }))
    case 'stop': return h('svg', common, h('rect', { x: 6.5, y: 6.5, width: 11, height: 11, rx: 2 }))
    case 'book': return h('svg', common, h('path', { d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z' }), h('path', { d: 'M13 4h5.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H13z' }))
    case 'warning': return h('svg', common, h('path', { d: 'M12 4 21 19H3z' }), h('path', { d: 'M12 10v4M12 17h.01' }))
    case 'chevron': return h('svg', common, h('path', { d: 'M9 6l6 6-6 6' }))
    case 'trash': return h('svg', common, h('path', { d: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13' }))
    case 'list': return h('svg', common, h('path', { d: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01' }))
    case 'history': return h('svg', common, h('path', { d: 'M4 12a8 8 0 1 0 2.5-5.8' }), h('path', { d: 'M4 4.5V10h5.5' }), h('path', { d: 'M12 8v4.5l3 2' }))
    case 'briefcase': return h('svg', common, h('rect', { x: 3, y: 7.5, width: 18, height: 12, rx: 2 }), h('path', { d: 'M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5' }), h('path', { d: 'M3 12.5h18' }))
    case 'mic': return h('svg', common, h('rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }), h('path', { d: 'M5.5 11.5a6.5 6.5 0 0 0 13 0' }), h('path', { d: 'M12 18v3' }), h('path', { d: 'M8.5 21h7' }))
    default: return h('svg', common, h('circle', { cx: 12, cy: 12, r: 8 }))
  }
}

// ── 样式 ──────────────────────────────────────────────────────────

const STYLE_ID = 'lifecard-styles'
const CSS = `
.lc-root {
  --lc-bg: var(--dsw-alias-bg-base, #fbfaf7);
  --lc-panel: var(--dsw-alias-bg-layer-1, #ffffff);
  --lc-ink: var(--dsw-alias-label-primary, #1f2328);
  --lc-muted: var(--dsw-alias-label-tertiary, #6b7280);
  --lc-line: var(--dsw-alias-border-l1, #e6e2da);
  --lc-line-strong: var(--dsw-alias-border-l2, #d6d0c4);
  --lc-accent: var(--dsw-alias-brand-primary, #3b5bdb);
  --lc-accent-ink: #ffffff;
  --lc-accent-soft: #eef1fd;
  --lc-import: #0b7285;
  --lc-import-soft: #e6f5f7;
  --lc-interview: #6741d9;
  --lc-interview-soft: #f1edfd;
  --lc-analyze: #b8860b;
  --lc-analyze-soft: #fdf4e0;
  --lc-doctor: var(--dsw-alias-state-success-primary, #2f9e44);
  --lc-doctor-soft: #e9f7ec;
  --lc-danger: var(--dsw-alias-state-error-primary, #c92a2a);
  --lc-danger-soft: #fdecec;
  --lc-radius: 10px;
  --lc-shadow: 0 1px 2px rgba(20, 20, 30, .06), 0 6px 20px rgba(20, 20, 30, .05);
  --lc-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

/*
 * 上面这几行是「跟宿主走」：var(--dsw-alias-xxx, 兜底色) 的意思是——
 * 软件本身（宿主）定义了主题色就用它的，没定义就用我们这套兜底的暖白纸感配色。
 * 好处是用户切深色主题、换品牌色时，这一页跟着变，不会像贴上去的一块白纸；
 * 坏处是每个变量都必须留兜底值，否则宿主没给这个变量时颜色会变成透明。
 * 下面的 soft（浅底）系列没有对应的宿主变量可借，仍然是自己的颜色：
 * 它们是「强调色的 10% 底」，只能跟强调色一起看，单独换没有意义。
 */


  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--lc-bg);
  color: var(--lc-ink);
  font-size: 15px;
  line-height: 1.7;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  overflow: hidden;
}
@media (prefers-color-scheme: dark) {
  .lc-root {
    --lc-bg: #16171a;
    --lc-panel: #1e2024;
    --lc-ink: #e8e6e1;
    --lc-muted: #9aa0a6;
    --lc-line: #2c2f34;
    --lc-line-strong: #3a3e45;
    --lc-accent: #748ffc;
    --lc-accent-ink: #12141a;
    --lc-accent-soft: #1e2437;
    --lc-import: #3bc9db;
    --lc-import-soft: #10333a;
    --lc-interview: #9c7bf5;
    --lc-interview-soft: #241d3d;
    --lc-analyze: #e8b93b;
    --lc-analyze-soft: #342a10;
    --lc-doctor: #51cf66;
    --lc-doctor-soft: #14301c;
    --lc-danger: #ff6b6b;
    --lc-danger-soft: #3a1a1a;
    --lc-shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 8px 24px rgba(0, 0, 0, .3);
  }
}

.lc-head {
  display: flex; align-items: center; gap: 8px;
  padding: 13px 14px; border-bottom: 1px solid var(--lc-line);
  background: var(--lc-panel); flex-shrink: 0;
}
.lc-title { font-weight: 700; font-size: 16.5px; letter-spacing: .01em; }
.lc-sub { color: var(--lc-muted); font-size: 13.5px; }
.lc-grow { flex: 1 1 auto; min-width: 0; }
.lc-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.lc-body { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; }
.lc-pad { padding: 14px; }
.lc-stack { display: flex; flex-direction: column; gap: 11px; }
.lc-row { display: flex; align-items: center; gap: 9px; }
.lc-wrap { display: flex; flex-wrap: wrap; gap: 6px; }

/* 按钮：颜色即语义 */
.lc-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  padding: 9px 14px; border-radius: 10px; border: 1px solid var(--lc-line-strong);
  background: var(--lc-panel); color: var(--lc-ink);
  font-size: 14.5px; font-weight: 550; cursor: pointer; min-height: 36px;
  transition: background .12s, border-color .12s, transform .06s, box-shadow .12s;
  white-space: nowrap; font-family: inherit;
}
.lc-btn:hover { border-color: var(--lc-accent); }
.lc-btn:active { transform: translateY(.5px); }
.lc-btn:disabled { opacity: .45; cursor: not-allowed; }
.lc-btn:focus-visible { outline: 2px solid var(--lc-accent); outline-offset: 1px; }
.lc-btn.primary { background: var(--lc-accent); border-color: var(--lc-accent); color: var(--lc-accent-ink); }
.lc-btn.primary:hover { filter: brightness(1.06); }
.lc-btn.import { background: var(--lc-import-soft); border-color: var(--lc-import); color: var(--lc-import); }
.lc-btn.interview { background: var(--lc-interview-soft); border-color: var(--lc-interview); color: var(--lc-interview); }
.lc-btn.analyze { background: var(--lc-analyze-soft); border-color: var(--lc-analyze); color: var(--lc-analyze); }
.lc-btn.doctor { background: var(--lc-doctor-soft); border-color: var(--lc-doctor); color: var(--lc-doctor); }
.lc-btn.danger { background: var(--lc-danger-soft); border-color: var(--lc-danger); color: var(--lc-danger); }
.lc-btn.ghost { background: transparent; border-color: transparent; color: var(--lc-muted); }
.lc-btn.ghost:hover { background: var(--lc-accent-soft); color: var(--lc-accent); }
.lc-btn.sm { padding: 6px 11px; font-size: 14px; min-height: 30px; }
.lc-btn.block { width: 100%; }
.lc-btn.big { padding: 13px 18px; font-size: 15.5px; border-radius: 12px; min-height: 46px; }

/* 大动作卡：首页与空状态用它，一个按钮占一行，说清「按了会怎样」 */
.lc-action {
  display: flex; align-items: flex-start; gap: 11px; width: 100%; text-align: left;
  padding: 13px 14px; border-radius: 12px; cursor: pointer; font-family: inherit;
  border: 1px solid var(--lc-line-strong); background: var(--lc-panel); color: inherit;
  transition: border-color .12s, box-shadow .12s, transform .06s;
}
.lc-action:hover { box-shadow: var(--lc-shadow); transform: translateY(-1px); }
.lc-action:active { transform: none; }
.lc-action .ico {
  width: 34px; height: 34px; border-radius: 10px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--lc-accent-soft); color: var(--lc-accent);
}
.lc-action .t { font-weight: 650; font-size: 15.5px; }
.lc-action .d { color: var(--lc-muted); font-size: 13.5px; margin-top: 2px; }
.lc-action.interview { border-color: #d9d0f7; }
.lc-action.interview .ico { background: var(--lc-interview-soft); color: var(--lc-interview); }
.lc-action.import { border-color: #c3e6ea; }
.lc-action.import .ico { background: var(--lc-import-soft); color: var(--lc-import); }
.lc-action.analyze .ico { background: var(--lc-analyze-soft); color: var(--lc-analyze); }

/* 输入 */
.lc-input, .lc-textarea, .lc-select {
  width: 100%; box-sizing: border-box; font-family: inherit; font-size: 14.5px;
  padding: 10px 12px; border-radius: 10px;
  border: 1px solid var(--lc-line-strong); background: var(--lc-panel); color: var(--lc-ink);
  line-height: 1.6; min-height: 40px;
}
.lc-textarea { resize: vertical; min-height: 96px; line-height: 1.7; }
.lc-input:focus, .lc-textarea:focus, .lc-select:focus {
  outline: none; border-color: var(--lc-accent); box-shadow: 0 0 0 3px var(--lc-accent-soft);
}

/* 表单：一组「问题 + 控件 + 一句解释」 */
.lc-fset { display: flex; flex-direction: column; gap: 14px; }
.lc-fitem { display: flex; flex-direction: column; gap: 4px; }
.lc-flabel { font-size: 14.5px; font-weight: 600; color: var(--lc-ink); }
.lc-fhint { font-size: 13.5px; color: var(--lc-muted); }
.lc-fgroup {
  display: flex; align-items: center; gap: 7px; margin: 16px 0 2px;
  font-size: 14px; font-weight: 650; color: var(--lc-muted); letter-spacing: .03em;
}
.lc-fgroup:first-child { margin-top: 0; }
.lc-fgroup::after { content: ''; flex: 1 1 auto; height: 1px; background: var(--lc-line); }

/* 可增删的一行 */
.lc-listrow { display: flex; gap: 6px; align-items: center; }
.lc-listrow .lc-input { flex: 1 1 auto; }
.lc-listrow .lc-select { width: 96px; flex: 0 0 96px; }
.lc-iconbtn {
  width: 26px; height: 26px; flex: 0 0 26px; border-radius: 7px; cursor: pointer;
  border: 1px solid var(--lc-line-strong); background: var(--lc-panel); color: var(--lc-muted);
  display: flex; align-items: center; justify-content: center; font-family: inherit;
}
.lc-iconbtn:hover { border-color: var(--lc-danger); color: var(--lc-danger); }

/* 卡片列表 */
.lc-card-item {
  display: flex; gap: 9px; align-items: flex-start;
  padding: 9px 10px; border-radius: var(--lc-radius);
  border: 1px solid var(--lc-line); background: var(--lc-panel);
  cursor: pointer; transition: border-color .12s, box-shadow .12s, transform .06s;
  text-align: left; width: 100%; font-family: inherit; color: inherit;
}
.lc-card-item:hover { border-color: var(--lc-accent); box-shadow: var(--lc-shadow); }
.lc-card-item:active { transform: translateY(.5px); }
.lc-avatar {
  width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-weight: 650; font-size: 15px;
  background: var(--lc-accent-soft); color: var(--lc-accent);
}
.lc-avatar.big { width: 46px; height: 46px; border-radius: 12px; font-size: 22px; }
.lc-avatar.has-photo { padding: 0; overflow: hidden; background: var(--lc-line); }
.lc-avatar.has-photo img { width: 100%; height: 100%; object-fit: cover; display: block; }

/* 2:3 裁剪 */
.lc-crop-wrap { position: relative; width: 180px; margin: 0 auto; }
.lc-crop-frame {
  position: relative; width: 180px; height: 270px; overflow: hidden;
  border-radius: 10px; background: #222; cursor: grab; touch-action: none;
  border: 1px solid var(--lc-line-strong);
}
.lc-crop-frame:active { cursor: grabbing; }
.lc-crop-frame img { position: absolute; user-select: none; pointer-events: none; }
.lc-crop-frame .grid { position: absolute; inset: 0; pointer-events: none;
  background:
    linear-gradient(to right, transparent 33.2%, rgba(255,255,255,.28) 33.3%, rgba(255,255,255,.28) 33.6%, transparent 33.7%),
    linear-gradient(to right, transparent 66.2%, rgba(255,255,255,.28) 66.3%, rgba(255,255,255,.28) 66.6%, transparent 66.7%),
    linear-gradient(to bottom, transparent 33.2%, rgba(255,255,255,.28) 33.3%, rgba(255,255,255,.28) 33.6%, transparent 33.7%),
    linear-gradient(to bottom, transparent 66.2%, rgba(255,255,255,.28) 66.3%, rgba(255,255,255,.28) 66.6%, transparent 66.7%);
}
.lc-crop-hint { text-align: center; color: var(--lc-muted); font-size: 13.5px; margin-top: 6px; }
.lc-avatar.real { background: var(--lc-doctor-soft); color: var(--lc-doctor); }
.lc-avatar.fictional { background: var(--lc-interview-soft); color: var(--lc-interview); }
.lc-avatar.world { background: var(--lc-analyze-soft); color: var(--lc-analyze); }

.lc-meta { color: var(--lc-muted); font-size: 13.5px; }
.lc-tag {
  display: inline-flex; align-items: center; gap: 3px;
  padding: 1px 6px; border-radius: 999px; font-size: 12.5px;
  background: var(--lc-accent-soft); color: var(--lc-accent);
}
.lc-tag.warn { background: var(--lc-analyze-soft); color: var(--lc-analyze); }
.lc-tag.err { background: var(--lc-danger-soft); color: var(--lc-danger); }
.lc-tag.ok { background: var(--lc-doctor-soft); color: var(--lc-doctor); }

/* 进度条（完整度） */
.lc-bar { height: 4px; border-radius: 2px; background: var(--lc-line); overflow: hidden; flex: 1 1 auto; }
.lc-bar > i { display: block; height: 100%; background: var(--lc-accent); border-radius: 2px; transition: width .25s; }

/* 空状态 */
.lc-empty { text-align: center; padding: 28px 16px; color: var(--lc-muted); }
.lc-empty-icon {
  width: 42px; height: 42px; margin: 0 auto 10px; border-radius: 12px;
  display: flex; align-items: center; justify-content: center;
  background: var(--lc-accent-soft); color: var(--lc-accent);
}
.lc-empty h3 { margin: 0 0 4px; font-size: 15.5px; color: var(--lc-ink); font-weight: 650; }

/* 分组标题 */
.lc-group { display: flex; align-items: center; gap: 6px; margin: 14px 0 6px; color: var(--lc-muted); font-size: 13.5px; font-weight: 600; letter-spacing: .04em; }
.lc-group:first-child { margin-top: 0; }
.lc-group i { width: 3px; height: 12px; border-radius: 2px; background: var(--lc-accent); display: block; }
.lc-group.import i { background: var(--lc-import); }
.lc-group.interview i { background: var(--lc-interview); }
.lc-group.analyze i { background: var(--lc-analyze); }
.lc-group.doctor i { background: var(--lc-doctor); }

/* 提示条 */
.lc-note {
  display: flex; gap: 8px; padding: 9px 10px; border-radius: var(--lc-radius);
  background: var(--lc-accent-soft); color: var(--lc-ink); font-size: 14px;
  border-left: 3px solid var(--lc-accent);
}
.lc-note.warn { background: var(--lc-analyze-soft); border-left-color: var(--lc-analyze); }
.lc-note.err { background: var(--lc-danger-soft); border-left-color: var(--lc-danger); }
.lc-note.ok { background: var(--lc-doctor-soft); border-left-color: var(--lc-doctor); }

/* 提案勾选 */
.lc-proposal-item {
  display: flex; gap: 8px; padding: 8px 9px; border-radius: 8px;
  border: 1px solid var(--lc-line); background: var(--lc-panel); align-items: flex-start;
}
.lc-proposal-item.on { border-color: var(--lc-doctor); background: var(--lc-doctor-soft); }
.lc-check {
  width: 16px; height: 16px; border-radius: 4px; flex-shrink: 0; margin-top: 1px;
  border: 1.5px solid var(--lc-line-strong); background: var(--lc-panel);
  display: flex; align-items: center; justify-content: center; cursor: pointer; color: transparent;
  transition: background .1s, border-color .1s, color .1s;
}
.lc-check.on { background: var(--lc-doctor); border-color: var(--lc-doctor); color: #fff; }
.lc-quote {
  font-size: 12.5px; color: var(--lc-muted);
  background: var(--lc-bg); border-left: 2px solid var(--lc-line-strong);
  padding: 3px 7px; border-radius: 0 4px 4px 0; margin-top: 3px;
  overflow-wrap: anywhere;
}

/* 访谈对话 */
.lc-bubble { padding: 9px 11px; border-radius: 12px; font-size: 14.5px; max-width: 100%; }
.lc-bubble.bot { background: var(--lc-interview-soft); border: 1px solid var(--lc-interview); color: var(--lc-ink); border-top-left-radius: 4px; }
.lc-bubble.me { background: var(--lc-panel); border: 1px solid var(--lc-line); color: var(--lc-ink); border-top-right-radius: 4px; margin-left: 22px; }
.lc-opt {
  display: flex; gap: 8px; align-items: flex-start; width: 100%; text-align: left;
  padding: 7px 9px; border-radius: 8px; border: 1px solid var(--lc-line-strong);
  background: var(--lc-panel); cursor: pointer; font-family: inherit; font-size: 14.5px; color: inherit;
  transition: border-color .1s, background .1s;
}
.lc-opt:hover { border-color: var(--lc-interview); background: var(--lc-interview-soft); }
.lc-opt-num {
  width: 17px; height: 17px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 650;
  background: var(--lc-interview-soft); color: var(--lc-interview); border: 1px solid var(--lc-interview);
}

/* 关系选项：一片一片能点的词，比下拉框好点——一屏就能看见父亲母亲爷爷都在 */
.lc-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.lc-chip {
  padding: 5px 11px; border-radius: 999px; border: 1px solid var(--lc-line-strong);
  background: var(--lc-panel); color: inherit; font-family: inherit; font-size: 14.5px;
  cursor: pointer; transition: border-color .1s, background .1s, color .1s;
}
.lc-chip:hover { border-color: var(--lc-interview); background: var(--lc-interview-soft); }
.lc-chip.on {
  border-color: var(--lc-interview); background: var(--lc-interview-soft);
  color: var(--lc-interview); font-weight: 650;
}
/* 「补充」那一片是虚线框：勾上之后会多出一排小词，样式比主关系淡一档，
   免得看成一主多从的并列关系 */
.lc-chip.add { border-style: dashed; }
.lc-chip.add.on { border-style: solid; font-weight: 400; }
.lc-chip.sm { padding: 3px 9px; font-size: 13.5px; }

/* 「或者直接写」那一段被打字栏接管时的样子。
   强调色从上面那排词挪到这里——一次只能有一个地方是「正在生效的」，
   两个地方同时亮着，人就会以为要同时填两处。 */
.lc-input.picked { border-color: var(--lc-interview); background: var(--lc-interview-soft); }
/* 「还有什么」收起时只是一行灰字——它不是一栏，是一个可以点开的小口子 */
.lc-more { margin-top: 2px; }
.lc-more-open {
  border: 0; background: none; padding: 2px 0; color: var(--lc-muted);
  font-family: inherit; font-size: 14.5px; cursor: pointer;
}
.lc-more-open:hover { color: var(--lc-interview); text-decoration: underline; }
/* 收起来的那一行「还有什么」：灰色小字、没有边框，看着不像按钮——
   它是个入口，不是要人去点的动作。 */
.lc-linkweak {
  background: none; border: 0; padding: 0; margin: 0;
  color: var(--lc-muted); font-family: inherit; font-size: 13.5px;
  cursor: pointer; text-align: left;
}
.lc-linkweak:hover { color: inherit; text-decoration: underline; }
/* 只有一条下划线的输入框：填「他是我的什么人」用。
   给个完整方框会把这一栏显得比上面几栏都重，可它只是一句话。 */
.lc-line-input {
  width: 100%; padding: 6px 0; border: 0;
  border-bottom: 1px solid var(--lc-line-strong); border-radius: 0;
  background: transparent; color: inherit; font-family: inherit; font-size: 15px;
  outline: none;
}
.lc-line-input:focus { border-bottom-color: var(--lc-interview); }
.lc-line-input::placeholder { color: var(--lc-muted); }

/* 正文小节（阅读态） */
.lc-sec { padding: 9px 11px; border-radius: 9px; background: var(--lc-panel); border: 1px solid var(--lc-line); }
.lc-sec .st { font-size: 13.5px; font-weight: 650; color: var(--lc-muted); letter-spacing: .03em; margin-bottom: 3px; }
.lc-sec .sb { white-space: pre-wrap; }
/* 世界书条目：条数可能上百，正文给个上限，别让人滚到看不见底。 */
.lc-sec .sb.lc-clamp { max-height: 220px; overflow-y: auto; }

/* 分隔 */
.lc-sep { height: 1px; background: var(--lc-line); margin: 10px 0; }

/* 加载 */
.lc-spin {
  width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0;
  border: 1.6px solid var(--lc-line-strong); border-top-color: var(--lc-accent);
  animation: lc-rotate .7s linear infinite;
}
@keyframes lc-rotate { to { transform: rotate(360deg); } }
`

/**
 * 把样式挂进 <head>，并返回一个「拿掉它」的函数。
 *
 * 一定要在 ctx.effect 里调：插件被卸载/重开时，效果要跟着回收。
 * 以前是 apply 里直接插、没人负责删——重开一次就多一个 <style>，
 * 虽然靠 id 挡住了重复，但卸载时那块样式会一直留在页面上。
 */
function ensureStyle(doc) {
  const existing = doc.getElementById(STYLE_ID)
  if (existing !== null && existing !== undefined) {
    return () => {
      if (typeof existing.remove === 'function') existing.remove()
      else if (existing.parentNode?.removeChild !== undefined) existing.parentNode.removeChild(existing)
    }
  }
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  doc.head.appendChild(style)
  return () => {
    if (typeof style.remove === 'function') style.remove()
    else if (style.parentNode?.removeChild !== undefined) style.parentNode.removeChild(style)
  }
}

// ── 小组件 ────────────────────────────────────────────────────────

function Btn({ tone, size, icon, children, onClick, disabled, title, block, big }) {
  const cls = ['lc-btn', tone ?? '', size === 'sm' ? 'sm' : '', block ? 'block' : '', big ? 'big' : ''].filter(Boolean).join(' ')
  return h('button', { className: cls, onClick, disabled, title, type: 'button' },
    icon === undefined ? null : h(Icon, { name: icon, size: size === 'sm' ? 13 : 14 }),
    children === undefined ? null : h('span', null, children),
  )
}

function Note({ tone, icon, children }) {
  return h('div', { className: `lc-note ${tone ?? ''}` },
    icon === undefined ? null : h(Icon, { name: icon, size: 14 }),
    h('div', { className: 'lc-grow' }, children),
  )
}

/** 一条错误提示。所有地方都走它，保证屏幕上不会出现异常原文。 */
function Err({ text }) {
  const clean = humanizeError(text)
  if (clean === '') return null
  return h(Note, { tone: 'err', icon: 'warning' }, h('div', { style: { whiteSpace: 'pre-wrap' } }, clean))
}

function Tag({ tone, children }) {
  return h('span', { className: `lc-tag ${tone ?? ''}` }, children)
}

function GroupTitle({ tone, icon, children }) {
  return h('div', { className: `lc-group ${tone ?? ''}` }, h('i'), icon === undefined ? null : h(Icon, { name: icon, size: 12 }), children)
}

function Bar({ value }) {
  return h('div', { className: 'lc-bar' }, h('i', { style: { width: `${Math.max(0, Math.min(100, value))}%` } }))
}

function Spinner() {
  return h('span', { className: 'lc-spin', 'aria-label': '处理中' })
}

function Avatar({ name, kind, big, photo }) {
  const initial = String(name ?? '?').trim().slice(0, 1) || '?'
  const tone = kind === 'real' ? 'real' : kind === 'fictional' || kind === 'hybrid' ? 'fictional' : kind === 'world' ? 'world' : ''
  // 有照片就显示照片。没照片时回落到首字方块——空着比一个灰色小人更像坏了。
  const cls = ['lc-avatar', big ? 'big' : '', tone, typeof photo === 'string' && photo !== '' ? 'has-photo' : ''].filter(Boolean).join(' ')
  if (typeof photo === 'string' && photo !== '') {
    return h('div', { className: cls }, h('img', { src: `data:image/png;base64,${photo}`, alt: String(name ?? '') }))
  }
  return h('div', { className: cls }, initial)
}

/** 一行「问题 + 控件 + 解释」。表单里所有字段都走它，保证样子一致。 */
function Field({ label, hint, children }) {
  return h('div', { className: 'lc-fitem' },
    h('label', { className: 'lc-flabel' }, label),
    children,
    hint === undefined ? null : h('div', { className: 'lc-fhint' }, hint),
  )
}

/** 首页的大动作按钮。 */
function Action({ tone, icon, title, desc, onClick }) {
  return h('button', { className: `lc-action ${tone ?? ''}`, onClick, type: 'button' },
    h('div', { className: 'ico' }, h(Icon, { name: icon, size: 18 })),
    h('div', { className: 'lc-grow' },
      h('div', { className: 't' }, title),
      desc === undefined ? null : h('div', { className: 'd' }, desc),
    ),
    h(Icon, { name: 'chevron', size: 14 }),
  )
}

// ── 人话对照表 ────────────────────────────────────────────────────

const KIND_LABEL = {
  real: '现实里的人', fictional: '虚构角色', hybrid: '以真人为原型',
  self: '我自己', world: '一个世界', system: '一套设定',
  lens: '我的偏好', relation: '一段关系',
}
const KIND_CHOICES = ['real', 'fictional', 'hybrid', 'self']

const CONSENT_LABEL = {
  self: '就是我自己',
  'family-agreed': '对方（或家人）知道并同意',
  'public-figure': '公开人物',
  fictional: '虚构的，不涉及真人',
}

const STATUS_LABEL = {
  active: '还在', deceased: '已经不在', incapacitated: '联系不上了', historical: '历史上的人',
}

const LEVEL_LABEL = ['入门', '熟手', '精通', '专家']

// 关系选项平时由宿主给（state.relations），这份只在拿不到时兜底。
// 为什么要有：宿主还是旧版、或者插件刚装好还没重启时，state.relations 是空的，
// 这一页就只剩一个「自己填」和一片空白，用户以为软件坏了。
// 兜底列表跟 prompts.js 里那份保持一致，改的时候两边一起改。
const RELATION_FALLBACK = [
  { id: 'father', label: '父亲', hint: '他为你做过的具体事、期待与你的落差' },
  { id: 'mother', label: '母亲', hint: '她为你做过的具体事、期待与你的落差' },
  { id: 'grandpa', label: '爷爷', hint: '手艺与职业细节、说过的老话' },
  { id: 'grandma', label: '奶奶', hint: '手艺与职业细节、说过的老话' },
  { id: 'partner', label: '伴侣', hint: '初见场景、吵架的模式、对方的雷区' },
  { id: 'friend', label: '朋友', hint: '怎么认识的、一起干过最蠢的事' },
  { id: 'sibling', label: '兄弟姐妹', hint: '一起长大的具体场景、争过什么' },
  { id: 'classmate', label: '同学', hint: '共同经历的具体场景、一次冲突或和解' },
  { id: 'teacher', label: '老师', hint: '他教的具体内容、一个标志性动作' },
  { id: 'colleague', label: '同事', hint: '他负责什么、一天怎么过' },
  { id: 'relative', label: '亲戚', hint: '一年见几次、见面的固定仪式' },
  { id: 'self', label: '我自己', hint: '时间线、能力和证据、反复出现的困境' },
  { id: 'fictional', label: '虚构角色', hint: '来历、动机、说话方式、绝不做什么' },
]

// 一个人常常不止一种身份：朋友也是伴侣、家人也是伴侣。
// 这几个词跟宿主侧的 prompts.js 里那份是同一套，浏览器侧拿不到那边的东西，
// 所以在这里再写一遍。改的时候两边一起改（render-all 有一条断言盯着）。
const RELATION_EXTRAS = [
  '也是伴侣',
  '也是家人',
  '也是好友',
  '也是同事',
  '也是老师',
  '也是对手',
]

// 访谈第一屏只摆四个最常用的词。
// 以前把十几种关系全铺成按钮，一屏全是框，看着像在填表；剩下的
// （爷爷、老师、同事、隔壁王叔）在下面那条横线里自己写，一句话就说清了。
// 四个词用「朋友」不是「好友」：这是人嘴里说的话，不是分类名。
const RELATION_QUICK = [
  { id: 'father', label: '父亲' },
  { id: 'mother', label: '母亲' },
  { id: 'friend', label: '朋友' },
  { id: 'partner', label: '伴侣' },
]

const SECTIONS_MAIN = [
  { title: '自述', hint: '他是什么样的人。像跟朋友介绍他那样写。' },
  { title: '性格', hint: '遇到事情会怎么反应。举一个具体的例子最好。' },
  { title: '外貌', hint: '长相、穿着、说话时的样子。' },
  { title: '口癖', hint: '他常说的那句话、那个词。' },
]
const SECTIONS_REL = [
  { title: '关系史', hint: '你们之间发生过什么。按时间写几件事。' },
  { title: '不会说的话', hint: '他绝对不会说出口的话。' },
  { title: '不会做的事', hint: '他绝对不会做的事。' },
]

// ── 主界面 ────────────────────────────────────────────────────────

const VIEWS = { doors: 'doors', novel: 'novel', book: 'book', game: 'game', career: 'career', tavern: 'tavern', tavernChat: 'tavernChat', home: 'home', card: 'card', interview: 'interview', import: 'import', analyze: 'analyze', doctor: 'doctor', setup: 'setup', newCard: 'newCard', world: 'world', memory: 'memory', jobs: 'jobs' }

/**
 * tab 组件。接收宿主给的 props（ctx / store / scope / tab / visible）。
 * 只用到 `visible`，其余一律不碰——插件不该依赖宿主内部状态。
 */
function LifeCardTab(props) {
  // 一进来先问「你要用哪个」，三扇门选一扇再进去。以前直接落到首页，
  // 想写小说的人和想记录真人的人看到的是同一屏，谁也找不到自己的入口。
  const [view, setView] = useState(VIEWS.doors)
  const [state, setState] = useState(null)
  const [listing, setListing] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState(null)
  const [toast, setToast] = useState(null)
  const [activeCard, setActiveCard] = useState(null)
  const [proposal, setProposal] = useState(null)
  const [doctor, setDoctor] = useState(null)
  const [interviewFor, setInterviewFor] = useState(null)
  const [showMore, setShowMore] = useState(false)
  // 看一本世界书。世界书不是卡（不进卡列表，也不参与覆盖度），所以自己占一个状态。
  const [activeWorld, setActiveWorld] = useState(null)
  // 从一份「这个人还没有卡」的建议跳去新建时，把名字带过去。
  const [pendingAbout, setPendingAbout] = useState('')
  // 第一次打开时那段简短介绍看过了没有。null = 还不知道（还没问过宿主）
  const [introSeen, setIntroSeen] = useState(null)
  // 从首页点某一份材料进来时，把那一份预先勾上。没有它，用户点「材料」
  // 只是到了一个空白的分析页，还得自己在列表里再找一遍刚才那份。
  const [materialFor, setMaterialFor] = useState(null)
  const mounted = useRef(true)

  // 挂载时就置回 true：宿主一旦按 StrictMode 那样「先卸再挂」跑一遍 effect，
  // 只写卸载那一半会让这个 ref 永远是 false，之后每个 if (!mounted.current)
  // 都提前 return，界面卡在「正在打开…」出不来。
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const flash = useCallback((message, tone) => {
    setToast({ message, tone: tone ?? 'ok' })
    const timer = setTimeout(() => { if (mounted.current) setToast(null) }, 4200)
    return () => clearTimeout(timer)
  }, [])

  const refresh = useCallback(async (workspace) => {
    setError(null)
    try {
      const st = await call('state.get', workspace === undefined ? {} : { workspace })
      if (!mounted.current) return
      setState(st)
      if (st.exists) {
        const list = await call('workspace.list', {})
        // 头像存在 assets/ 里，不在卡文件里，所以列表本身不带。
        // 一次全取回来（一张卡一次请求的话列表会很慢）；取不到不影响列表。
        try {
          const av = await call('avatar.list', {})
          if (av?.ok === true && av.avatars !== null && typeof av.avatars === 'object') list.avatars = av.avatars
        } catch { /* 没头像或取不到，就都显示首字方块 */ }
        if (mounted.current) setListing(list)
      }
    } catch (e) {
      if (mounted.current) setError(humanizeError(e))
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // 每次回到首页都重新拿一遍：别处存完材料、改完卡、删完东西再回来，
  // 如果首页还挂着进这一屏之前的旧列表，用户会以为刚才那一步没生效。
  useEffect(() => {
    if (view === VIEWS.home) refresh()
  }, [view, refresh])

  // 第一次进来时那段简短介绍，看过没有。
  // 只有真的打开了库才问（还没选文件夹时问也问不出什么），问到一次就不再问。
  useEffect(() => {
    if (state === null || state.exists !== true || introSeen !== null) return
    call('ui.intro', {}).then((r) => {
      if (!mounted.current) return
      setIntroSeen(r?.ok === true && r.seen === true)
    }).catch(() => { if (mounted.current) setIntroSeen(true) })
  }, [state, introSeen])

  const dismissIntro = useCallback(async () => {
    setIntroSeen(true)
    try { await call('ui.intro', { seen: true }) } catch { /* 记不住就算了，下次再介绍一遍不碍事 */ }
  }, [])

  // 首次没有工作区 → 进 setup
  useEffect(() => {
    if (state !== null && state.exists === false && view === VIEWS.home) setView(VIEWS.setup)
  }, [state, view])

  const doImport = useCallback(async (files) => {
    setBusy('import')
    setError(null)
    try {
      const payload = []
      for (const file of files) {
        const base64 = await readFileAsBase64(file)
        payload.push({ name: file.name, base64 })
      }
      const result = await call('import.cards', { files: payload })
      await refresh()
      const results = Array.isArray(result.results) ? result.results : []
      const bad = result.failed ?? 0
      // 世界书和角色卡在磁盘上是两种东西，也去两个不同的地方。混成一句
      // 「N 张成功」会让人去卡列表里找一本世界书，然后以为导入失败了。
      const books = results.filter((r) => r.ok === true && r.kind === 'worldinfo').length
      const people = (result.imported ?? 0) - books
      const parts = []
      if (people > 0) parts.push(`${people} 张卡`)
      if (books > 0) parts.push(`${books} 本世界书`)
      if (bad > 0) parts.push(`${bad} 个没读进去`)
      flash(`导入完成：${parts.length === 0 ? '没有新东西' : parts.join('、')}`, bad > 0 ? 'warn' : 'ok')
      if (bad > 0) {
        setError(result.results.filter((r) => !r.ok).map((r) => `${r.name}：${humanizeError(r.error)}`).join('\n'))
      }
      setView(VIEWS.home)
    } catch (e) {
      setError(humanizeError(e))
    } finally {
      setBusy('')
    }
  }, [flash, refresh])

  const openWorld = useCallback(async (world) => {
    setBusy('world')
    setError(null)
    try {
      const detail = await call('world.get', { path: world.path })
      if (detail.ok !== true) { setError(detail.error ?? '这本世界书读不出来'); return }
      setActiveWorld(detail)
      setView(VIEWS.world)
    } catch (e) {
      setError(humanizeError(e))
    } finally {
      setBusy('')
    }
  }, [])

  // 摊开一份建议。能定位到人就先把那张卡打开，再把清单放在下面——
  // 只弹一份不知道会改到哪张卡的清单，比不给看还让人不安。
  //
  // 从「让 AI 读材料」页过来时手上只有建议本身（那份页面上已经选了人），
  // 但从首页那条建议过来时只有文件路径，得先取回来。两种都走这里。
  const showProposal = useCallback(async (p) => {
    if (p === null || p === undefined) return
    const target = (listing?.cards ?? []).find((c) => String(c.id) === String(p.about))
    setProposal(p)
    if (target === undefined) {
      // 这个人还没有卡。清单照样能看能勾，只是没地方放，界面上会说清楚。
      setActiveCard(null)
      setView(VIEWS.card)
      return
    }
    try {
      const detail = await call('card.get', { path: target.path })
      // card.get 找不到文件时是「成功回话 + ok:false」，不是抛错。不判这一下
      // 就会把一份错误说明当成卡塞进去，下一页直接炸在 data 上。
      if (detail?.ok !== true) throw new Error(detail?.error ?? '这张卡读不出来')
      setActiveCard(detail)
    } catch (e) {
      // 取不到就先清空：留着上一张卡的话，下面摊开的清单会挂在别人的名字底下。
      setActiveCard(null)
      setError(humanizeError(e))
    }
    setView(VIEWS.card)
  }, [listing])

  const openProposal = useCallback(async (json) => {
    setError(null)
    try {
      const p = await call('proposal.get', { json })
      if (p.ok !== true) { setError(p.error ?? '这份建议读不出来'); return }
      await showProposal(p)
    } catch (e) {
      setError(humanizeError(e))
    }
  }, [showProposal])

  // 首页那几个按钮是「从头开始」的意思：上一次打开的是谁，到这一页就作废。
  // 不这样清，刚看完某人的卡再回首页点「整理 N 份材料」，那一页会默默
  // 还选着刚才那个人。
  const go = useCallback((next) => {
    // 离开那一屏就把带过去的东西清掉：不留着上一次的「整理谁」「读哪一份材料」，
    // 也不留着「这张建议卡属于谁」。以前 pendingAbout 只写不清——点过一次
    // 「给这个人建张卡」又退出来，之后从首页点「我自己填一张」，名字栏里还
    // 预填着上一个人的名字，用户一眼就懵了。
    if (next === VIEWS.analyze || next === VIEWS.interview || next === VIEWS.home) { setInterviewFor(null); setMaterialFor(null) }
    if (next !== VIEWS.newCard) setPendingAbout('')
    if (next !== VIEWS.tavernChat) setChat(null)
    setView(next)
  }, [])

  const openCard = useCallback(async (card, edit) => {
    setBusy('card')
    try {
      const detail = await call('card.get', { path: card.path })
      if (detail?.ok !== true) throw new Error(detail?.error ?? '这张卡读不出来')
      setActiveCard(detail)
      // 先摆好「打开就进修改」，再切屏——反过来的话 CardView 会先以
      // editing=false 挂载一次，之后再传初始值也不生效了。
      setCardEdit(edit === true)
      setView(VIEWS.card)
    } catch (e) {
      setActiveCard(null)
      setError(humanizeError(e))
    } finally {
      setBusy('')
    }
  }, [])

  // 后台一断（宿主重启、插件没起来），这些点击以前就是「点了没反应」：
  // 未捕获的 Promise 拒绝不会自己变成界面上的字。统一包一层，出错时说话。
  // 故意写成普通函数而不是 useCallback——hook 槽位一动，
  // render-all 里那些按号码摆状态的地方就全错位了。
  // 这三处（首页两种形态 + 世界那一页）原本各抄了一份一模一样的处理，
  // 而且都不接异常：后台一断，点「删掉」「检查一下」就是毫无反应。

  // 正在聊的那一场。null = 还没开。
  // 这个 useState 故意放在所有别的 hook 之后：前面那些槽位被 render-all
  // 按号码摆状态用着，中间插一个会让那一整排全部错位。
  const [chat, setChat] = useState(null)
  const [chats, setChats] = useState([])
  // 回到「写小说」那扇门就重新拿一遍书架：刚写完一章、刚新建一本再回来，
  // 还挂着进这一屏之前的旧列表，用户会以为刚才那一步没生效。
  useEffect(() => {
    if (view !== VIEWS.novel) return
    let gone = false
    call('novel.books', {})
      .then((r) => { if (!gone && r?.ok === true && Array.isArray(r.books)) setBooks(r.books) })
      .catch(() => { /* 取不到就空着，不影响新建 */ })
    return () => { gone = true }
  }, [view])

  // 「我现在在哪扇门里」必须自己记住，不能靠「当前在哪一屏」去猜。
  // 以前 mode 是从 view 推的：一进「聊着建」，当前屏就变成 interview，
  // 于是不管从哪扇门进来，都退回 real——三扇门点进去全都说
  // 「你在记录一个现实里的人」。子页面不是门，门要跟着人走。
  const [door, setDoor] = useState('real')
  // 写到第几本书（book 视图用）。null = 还没打开任何一本。
  const [activeBook, setActiveBook] = useState(null)
  // 书架上的书（写小说那扇门要列出来）
  const [books, setBooks] = useState([])
  // 哪些功能装了。null = 还没问到（先都按「装了」显示，别闪一下少一扇门）。
  //
  // 这个插件的每一块都能整个删掉：删了酒馆的文件，酒馆就没了，别的照常。
  // 所以界面不能写死「一定有三扇门」，得先问一句「现在有哪些」。
  const [features, setFeatures] = useState(null)
  // 从列表点铅笔进来的：卡页一打开就是修改状态。放在最后一个 hook，
  // 免得把前面那些按槽位摆状态的测试全挤错位。
  const [cardEdit, setCardEdit] = useState(false)
  // 三扇门各自「现在用哪张卡」：写进这个文件夹的 config.json，重启还在。
  const [pins, setPins] = useState({ real: '', tavern: '', novel: '' })
  const loadPins = useCallback(async () => {
    try {
      const r = await call('card.defaults.get', {})
      if (r?.ok === true && r.cards !== undefined) setPins(r.cards)
    } catch { /* 读不到就按「还没选」显示，不挡人用 */ }
  }, [])

  const pinCard = useCallback(async (mode, id) => {
    const before = pins
    setPins({ ...pins, [mode]: id })
    try {
      const r = await call('card.defaults.set', { mode, id })
      if (r?.ok !== true) {
        setPins(before)
        setError(r?.error ?? '这个没存上，再点一次。')
      }
    } catch (e) {
      setPins(before)
      setError(humanizeError(e))
    }
  }, [pins])


  useEffect(() => {
    let gone = false
    call('features.list', {})
      .then((r) => { if (!gone && r?.ok === true && r.features !== undefined) setFeatures(r.features) })
      .catch(() => { /* 问不到就按「都装了」显示，不影响用 */ })
    return () => { gone = true }
  }, [])
  // 三扇门各自「现在用哪张卡」：进哪扇门就读一次，免得改完别处又盖回去。
  useEffect(() => {
    if (view !== VIEWS.doors && view !== VIEWS.home && view !== VIEWS.tavern && view !== VIEWS.novel) return
    loadPins()
  }, [view, loadPins])

  // 门自己的那两屏直接说了算；其余屏（聊着建、卡片、分析…）沿用上次选的门。
  const mode = (view === VIEWS.novel || view === VIEWS.book || view === VIEWS.game) ? 'novel' : (view === VIEWS.tavern || view === VIEWS.tavernChat) ? 'tavern' : door
  // 回到酒馆那两屏就重新拿一遍说过的场次：刚说完、刚删完再回来，
  // 还挂着进这一屏之前的旧列表，用户会以为刚才那一步没生效。
  useEffect(() => {
    if (view !== VIEWS.tavern && view !== VIEWS.tavernChat) return
    let gone = false
    call('tavern.list', {})
      .then((r) => { if (!gone && r?.ok === true && Array.isArray(r.items)) setChats(r.items) })
      .catch(() => { /* 取不到就空着，不影响开新的一场 */ })
    return () => { gone = true }
  }, [view])

  /** 打开一本书，进到那一屏。 */
  const openBook = (book) => {
    setActiveBook({ id: book?.id ?? '', title: book?.title ?? '' })
    setView(VIEWS.book)
  }

  /** 新开一本：问一个书名就够，别的都能后面补。 */
  const createBook = async () => {
    const ask = typeof window !== 'undefined' && typeof window.prompt === 'function' ? window.prompt : null
    const title = ask === null ? '新书' : String(ask('这本书叫什么？') ?? '').trim()
    if (title === '') return
    try {
      const r = await call('novel.create', { title })
      if (r?.ok !== true) { setError(r?.error ?? '这本书没能建起来'); return }
      setActiveBook({ id: r.id, title: r.title })
      setView(VIEWS.book)
    } catch (e) { setError(humanizeError(e)) }
  }

  const pickDoor = (next) => {
    setDoor(next)
    setError(null)
    setProposal(null)
    setActiveCard(null)
    setActiveWorld(null)
    setInterviewFor(null)
    setMaterialFor(null)
    setView(next === 'novel' ? VIEWS.novel : next === 'tavern' ? VIEWS.tavern : VIEWS.home)
  }

  /**
   * 删一张卡。
   *
   * 先问一句：删卡是不可逆的（后台只写墓碑，界面上收不回来）。
   * 问的时候要说清「哪些东西会跟着没」——关系史、口癖这些都在卡里，
   * 而材料是另一份文件，不会跟着删。
   */
  const deleteCard = async (card) => {
    const name = String(card?.name ?? '').trim() === '' ? '这张卡' : `「${card.name}」`
    const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm(`确定删掉${name}吗？\n\n卡里写的东西（关系史、口癖、能力…）一起删掉，界面上收不回来。\n材料是另一份文件，不受影响。`)
      : true
    if (ok !== true) return
    try {
      const r = await call('card.delete', { path: card?.path, reason: '用户在列表里删掉' })
      if (r?.ok !== true) { setError(r?.error ?? '没删掉'); return }
      flash(`删掉了${name}`, 'ok')
      await refresh()
    } catch (e) { setError(humanizeError(e)) }
  }

  const deleteMaterial = async (m) => {
    const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm(`确定删掉「${m.name}」吗？\n\n删了就真没了，AI 以后也读不到这一份。`)
      : true
    if (ok !== true) return
    try {
      const r = await call('material.delete', { path: m.path })
      if (r?.ok === true) { flash(`删掉了「${m.name}」`); await refresh(state?.workspace) }
      else setError(r?.error ?? '没删掉')
    } catch (e) { setError(humanizeError(e)) }
  }

  // stayOnPage：在「检查一下」这一页点重新检查时原地刷，不要把人踢回别处。
  const runDoctor = async (stayOnPage) => {
    try {
      const r = await call('doctor.run', {})
      if (r?.ok !== true) { setError(r?.error ?? '检查没跑成'); return }
      setDoctor(r)
      if (stayOnPage === true) await refresh()
      else setView(VIEWS.doctor)
    } catch (e) { setError(humanizeError(e)) }
  }

  /**
   * 从列表里挑一个角色，开一场。
   *
   * 酒馆那扇门里点一张卡 = 「我要和 TA 说话」，不是「我要编辑这张卡」。
   * 想改卡还有卡页里的入口，这里不要多一步。
   */
  // 接着上次那一场说。列表里点进来走的是这条路。
  const openChat = async (row) => {
    setBusy('card')
    setError(null)
    try {
      const r = await call('tavern.get', { id: row?.id })
      if (r?.ok !== true) throw new Error(r?.error ?? '这一场打不开')
      setChat({ id: r.id, card_name: r.card_name, world_name: r.world_name, turns: r.turns ?? [], notes: r.notes ?? [], err: null, busy: false })
      setView(VIEWS.tavernChat)
    } catch (e) {
      setError(humanizeError(e))
    } finally {
      setBusy('')
    }
  }

  const startTavern = async (card) => {
    setBusy('card')
    setError(null)
    try {
      const r = await call('tavern.start', { card: card?.path ?? String(card?.id ?? '') })
      if (r?.ok !== true) throw new Error(r?.error ?? '这一场没开起来')
      setChat({ id: r.id, card_name: r.card_name, world_name: r.world_name, turns: r.turns ?? [], notes: r.notes ?? [], err: null, busy: false })
      setView(VIEWS.tavernChat)
    } catch (e) {
      setError(humanizeError(e))
    } finally {
      setBusy('')
    }
  }

  // 首页那张卡片点下去之后去哪儿，由门决定：酒馆里是「聊一场」，
  // 别的两扇门里还是「打开这张卡」。
  // 以前在酒馆门里点一张卡就直接开演了，想先看看卡上写了什么都做不到。
  // 现在点卡统一是「打开这张卡」，要不要演由卡页上的「和 TA 演一段」决定。
  const openFromList = (card) => openCard(card)
  // 现实里的卡拿去演：先复制成一份独立的角色卡，再开聊。
  // 不复制直接用原来那张的话，演上十分钟，现实记录里的性格就被改写了。
  const forkForTavern = async (card) => {
    try {
      const r = await call('card.fork', { path: card?.path ?? String(card?.id ?? '') })
      if (r?.ok !== true) { setError(r?.error ?? '没能复制出一张可以演的角色卡'); return }
      await refresh()
      flash(`复制了一张「${r.name}」的角色卡，原来那张没动`, 'ok')
      await startTavern({ path: r.path, id: r.id, name: r.name })
    } catch (e) { setError(humanizeError(e)) }
  }

  const header = () => {
    const titles = {
      [VIEWS.doors]: '你要用哪个？',
      [VIEWS.home]: '真实人物记录',
      [VIEWS.novel]: '写小说',
      [VIEWS.game]: '玩一段',
      [VIEWS.career]: '简历与规划',
      [VIEWS.book]: activeBook?.title === undefined || String(activeBook.title).trim() === '' ? '这本书' : String(activeBook.title),
      [VIEWS.tavern]: '酒馆',
      [VIEWS.tavernChat]: chat === null ? '聊一场' : (String(chat.card_name ?? '').trim() === '' ? '聊一场' : String(chat.card_name)),
      [VIEWS.card]: activeCard?.data?.name ?? '这张卡',
      [VIEWS.interview]: '陪他聊聊',
      [VIEWS.import]: '添加',
      [VIEWS.analyze]: '让 AI 读材料',
      [VIEWS.doctor]: '检查一下',
      [VIEWS.setup]: '选个文件夹',
      [VIEWS.newCard]: '新建一张卡',
      [VIEWS.world]: activeWorld?.data?.name ?? '这本世界书',
      [VIEWS.jobs]: '下一步',
    }
    // 「选个文件夹」页一般不该有返回按钮（还没地方可回），
    // 但已经选过文件夹、是从首页主动进来换的时候要能退回去。
    const atDoor = view === VIEWS.home || view === VIEWS.novel || view === VIEWS.tavern
    const canBack = view !== VIEWS.doors && !atDoor && (view !== VIEWS.setup || state?.exists === true)
    return h('div', { className: 'lc-head' },
      // 顶部返回一律当成「回首页」：上次打开的是谁、刚才点的是哪份材料、
      // 看的是哪本世界书，到这里都作废。不这样清，从 A 的卡退回来再点别人的
      // 材料，分析页会默默还认着 A，读出来的东西全记到 A 名下。
      canBack ? h('button', { className: 'lc-btn ghost sm', onClick: () => { go(VIEWS.home); setError(null); setProposal(null); setActiveWorld(null) }, title: '回到列表', type: 'button' }, h(Icon, { name: 'back', size: 14 })) : null,
      h('div', { className: 'lc-grow lc-ellipsis' },
        h('div', { className: 'lc-title lc-ellipsis' }, titles[view] ?? 'Life Cards'),
        mode === 'real' && view !== VIEWS.doors
          ? h('div', { className: 'lc-sub lc-ellipsis' }, '你的人物档案')
          : mode === 'novel'
            ? h('div', { className: 'lc-sub lc-ellipsis' }, '虚构的人物和世界')
            : mode === 'tavern'
              ? h('div', { className: 'lc-sub lc-ellipsis' }, '拿一张卡，开始演')
              : null,
      ),
      view === VIEWS.doors
        ? null
        : h('button', {
            className: 'lc-btn ghost sm',
            onClick: () => { setView(VIEWS.doors); setError(null); setProposal(null); setActiveWorld(null); setActiveCard(null) },
            title: '换成另一扇门',
            type: 'button',
          }, '换门'),
      busy === '' ? null : h(Spinner),
    )
  }

  const body = () => {
    if (error !== null && state === null) {
      return h('div', { className: 'lc-pad' },
        h(Note, { tone: 'err', icon: 'warning' }, '连不上后台。可能是插件没启动。'),
        h('div', { className: 'lc-meta', style: { margin: '6px 0 10px', whiteSpace: 'pre-wrap' } }, error),
        h(Btn, { onClick: () => refresh(), icon: 'doctor' }, '再试一次'),
      )
    }
    if (state === null) {
      return h('div', { className: 'lc-empty' }, h(Spinner), h('div', { className: 'lc-meta', style: { marginTop: 8 } }, '正在打开…'))
    }
    if (view === VIEWS.setup || state.exists === false) {
      return h(SetupView, {
        state,
        onDone: async (ws) => {
          // workspace.init 建不出来时是「成功回话 + ok:false」，不抛错。
          // 不看返回值的话，用户会看到绿色「好了，可以开始了」，
          // 下一秒又回到同一个「先挑一个文件夹」，再点几次还是这样。
          const r = await call('workspace.init', { workspace: ws })
          if (r?.ok !== true) throw new Error(r?.error ?? '这个文件夹没能用起来')
          await refresh(ws)
          // 刚建好库的人还不知道这里有三种用法，先让他选门。
          setView(VIEWS.doors)
          flash(r?.remembered === false ? '好了，可以开始了。不过这次选的文件夹没记住，下次还得再选一遍' : '好了，可以开始了')
        },
      })
    }
    // 门还没选：先问「你要用哪个」。选完才进首页，首页再按门决定露出什么。
    if (view === VIEWS.doors) return h(DoorsView, { state, features, onPick: pickDoor })
    if (view === VIEWS.tavernChat) {
      return h(TavernView, {
        chat,
        onChat: setChat,
        onBack: () => { setChat(null); setView(VIEWS.tavern) },
      })
    }
    switch (view) {
      case VIEWS.import:
        return h(ImportView, {
          busy, onImport: doImport, listing,
          // 刚存完材料的人是谁，分析页要接着用。以前这里直接 setView，
          // 「这是关于谁」到那边就空了——用户得自己再挑一遍，或者以为丢了。
          onAnalyze: (info) => {
            const name = String(info?.name ?? '').trim()
            const id = String(info?.id ?? '').trim()
            const cards = listing?.cards ?? []
            const hit = id !== ''
              ? cards.find((c) => c.id === id)
              : cards.find((c) => String(c.name ?? '').trim() === name)
            setMaterialFor(typeof info?.path === 'string' && info.path !== '' ? info.path : null)
            // 把「要建成真人还是虚构角色」一起带过去：分析页要靠它决定
            // 读出来的东西往哪种卡里放（虚构的别建成一张真人卡）。
            const wantKind = info?.kind === 'fictional' ? 'fictional' : 'real'
            setInterviewFor(hit !== undefined ? { id: hit.id, name: hit.name, kind: hit.kind ?? wantKind } : (name === '' ? null : { name, kind: wantKind }))
            setView(VIEWS.analyze)
          },
        })
      case VIEWS.interview:
        return h(InterviewView, {
          state, listing, preset: interviewFor, onRecorded: refresh, flash, mode,
          onDone: () => { setInterviewFor(null); setMaterialFor(null); setView(VIEWS.home); refresh() },
          onAnalyze: (about) => {
            const list = Array.isArray(about?.materials) ? about.materials.filter((x) => typeof x === 'string' && x !== '') : []
            setMaterialFor(list.length > 0 ? list : null)
            setInterviewFor(about ?? null)
            setView(VIEWS.analyze)
          },
        })
      case VIEWS.memory:
        // 提取完直接跳到「让 AI 读」，省掉用户自己再想「我刚存的材料去哪了」。
        // about 是个字符串，这个人还没建卡也能分析——分析结果会进提案，
        // 采纳时才建卡。
        return h(MemoryView, {
          onBack: () => { setInterviewFor(null); setMaterialFor(null); setView(VIEWS.home) },
          onDone: (about) => {
            // 只认那份刚写出来的材料。不带 path 的话分析页不勾任何材料，
            // 而「一个都不勾」等于全读，别人的人也会被读进来。
            setMaterialFor(typeof about?.path === 'string' && about.path !== '' ? about.path : null)
            setInterviewFor(about ?? null)
            setView(VIEWS.analyze)
          },
        })
      case VIEWS.analyze:
        return h(AnalyzeView, {
          listing, state, flash, presetAbout: interviewFor, presetMaterials: materialFor,
          onProposal: showProposal,
          onBack: () => { setInterviewFor(null); setMaterialFor(null); setView(VIEWS.home) },
          onNeedMaterial: () => setView(VIEWS.import),
          // 一键建成卡之后直接把人带到那张卡上：建完就站在门口看着，
          // 不知道它在哪儿、还得自己回列表找，等于没建。
          onAppliedCard: async (path) => {
            const hit = (listing?.cards ?? []).find((c) => c.path === path)
            await refresh(state?.workspace)
            if (hit !== undefined) await openCard(hit)
            else setView(VIEWS.home)
          },
        })
      case VIEWS.card:
        // 首页那条「还等着你看的建议」点进来时，如果这个人还没有卡（很正常：
        // AI 是从材料里读出来的，卡可能还没建），activeCard 就是 null。以前这里
        // 直接退回首页，用户点了没反应，还以为坏了。现在把清单单独摊开。
        return activeCard === null
          ? proposal === null
            ? h(HomeView, { state, listing, mode, onOpen: openFromList, chats, onOpenChat: openChat, onOpenWorld: openWorld, onNavigate: go, onMore: () => setShowMore(!showMore), showMore, onProposal: openProposal, busy, intro: introSeen === false, onIntroDone: dismissIntro, onMaterial: (m) => { setMaterialFor(m.path); setView(VIEWS.analyze) }, onDeleteMaterial: deleteMaterial, onDoDoctor: () => runDoctor(), onForkCard: forkForTavern, onDeleteCard: deleteCard, onEditCard: (c) => openCard(c, true), pinId: (mode === 'real' ? pins.real : mode === 'tavern' ? pins.tavern : pins.novel), onPickPin: (id) => pinCard(mode, id), books, onOpenBook: openBook, onCreateBook: createBook })
            : h('div', { className: 'lc-pad lc-stack' },
                proposal.about === undefined || String(proposal.about).trim() === ''
                  ? null
                  : h('div', { className: 'lc-meta' }, `这些是 AI 从材料里读到的、关于「${String(proposal.about)}」的东西。`),
                h(ProposalPanel, {
                  proposal,
                  applyBlocked: true,
                  onBuildCard: () => { setPendingAbout(String(proposal.about ?? '')); setProposal(null); setView(VIEWS.newCard) },
                  onClose: () => { setProposal(null); setView(VIEWS.home) },
                  onApplied: async (r) => {
                    setProposal(null)
                    await refresh()
                    setView(VIEWS.home)
                    // 报数要跟真的写进去的一致：一条都没新写时还说「存进卡里了」，
                    // 下次打开发现卡没变，就会以为软件在骗人。
                    if (r?.dismissed === true) { flash('这份不要了，已经不在待办里', 'ok'); return }
                    const n = r?.applied ?? 0
                    flash(n === 0 ? '这些卡里本来就有，没有重复写' : `写进卡里 ${n} 条`, n === 0 ? 'warn' : 'ok')
                  },
                }),
                h(Btn, { block: true, onClick: () => { setProposal(null); setView(VIEWS.home) } }, '回列表'),
              )
          : h(CardView, {
              card: activeCard,
              initialEditing: cardEdit,
              worlds: listing?.worlds ?? [],
              onOpenWorld: openWorld,
              proposal,
              setProposal,
              flash,
              onRefresh: async () => {
                try {
                  const detail = await call('card.get', { path: activeCard.path })
                  // 卡文件被外面删掉/挪走时，以前会拿 {ok:false} 当卡画出来：
                  // 一张「(还没起名字)」的空卡，还照样能点「存好」。
                  if (detail?.ok !== true) { setError(detail?.error ?? '这张卡读不出来'); return }
                  setActiveCard(detail)
                } catch (e) { setError(humanizeError(e)) }
              },
              onDeleted: async () => { setActiveCard(null); setView(VIEWS.home); await refresh() },
              onInterview: (preset) => { setInterviewFor(preset); setView(VIEWS.interview) },
              onAnalyze: () => { setInterviewFor({ id: activeCard.data?.id, name: activeCard.data?.name }); setView(VIEWS.analyze) },
              onTavern: mode === 'tavern' ? (preset) => startTavern(preset) : undefined,
            })
      case VIEWS.newCard:
        return h(NewCardView, {
          state,
          presetName: pendingAbout,
          onCreate: async (data) => {
            const r = await call('card.save', { data, sections: [] })
            if (r.ok !== true) throw new Error(r.error ?? '没存上')
            await refresh()
            const detail = await call('card.get', { path: r.path })
            setActiveCard(detail)
            setView(VIEWS.card)
            flash('建好了，接着往下填')
          },
        })
      case VIEWS.world:
        return activeWorld === null
          ? h(HomeView, { state, listing, mode, onOpen: openFromList, chats, onOpenChat: openChat, onOpenWorld: openWorld, onNavigate: go, onMore: () => setShowMore(!showMore), showMore, onProposal: openProposal, busy, intro: introSeen === false, onIntroDone: dismissIntro, onMaterial: (m) => { setMaterialFor(m.path); setView(VIEWS.analyze) }, onDeleteMaterial: deleteMaterial, onDoDoctor: () => runDoctor(), onForkCard: forkForTavern, onDeleteCard: deleteCard, onEditCard: (c) => openCard(c, true), pinId: (mode === 'real' ? pins.real : mode === 'tavern' ? pins.tavern : pins.novel), onPickPin: (id) => pinCard(mode, id), books, onOpenBook: openBook, onCreateBook: createBook })
          : h(WorldView, {
              world: activeWorld,
              listing,
              onOpenCard: openCard,
            })
      case VIEWS.game:
        return h(GameView, {
          bookId: String(activeBook?.id ?? ''),
          flash,
          onBack: () => { setActiveBook(null); setView(VIEWS.novel) },
        })
      case VIEWS.book:
        return h(BookView, {
          bookId: String(activeBook?.id ?? ''),
          flash,
          onBack: () => { setActiveBook(null); setView(VIEWS.novel) },
        })
      case VIEWS.doctor:
        return h(DoctorView, { report: doctor, onOpenCard: openCard, onRun: () => runDoctor(true) })
      case VIEWS.career:
        return h(CareerView, { flash, onBack: () => setView(VIEWS.home) })
      case VIEWS.jobs:
        return h(JobsView, { onBack: () => setView(VIEWS.home), flash })
      default:
        return h(HomeView, { state, listing, mode, onOpen: openFromList, chats, onOpenChat: openChat, onOpenWorld: openWorld, onNavigate: go, onMore: () => setShowMore(!showMore), showMore, onProposal: openProposal, busy, intro: introSeen === false, onIntroDone: dismissIntro, onMaterial: (m) => { setMaterialFor(m.path); setView(VIEWS.analyze) }, onDeleteMaterial: deleteMaterial, onDoDoctor: () => runDoctor(), onForkCard: forkForTavern, onDeleteCard: deleteCard, onEditCard: (c) => openCard(c, true), pinId: (mode === 'real' ? pins.real : mode === 'tavern' ? pins.tavern : pins.novel), onPickPin: (id) => pinCard(mode, id), books, onOpenBook: openBook, onCreateBook: createBook })
    }
  }

  return h('div', { className: 'lc-root' },
    header(),
    h('div', { className: 'lc-body' },
      toast === null ? null : h('div', { style: { padding: '10px 12px 0' } },
        h(Note, { tone: toast.tone, icon: toast.tone === 'warn' ? 'warning' : 'check' }, toast.message)),
      error !== null && state !== null
        ? h('div', { style: { padding: '10px 12px 0' } },
            h(Note, { tone: 'err', icon: 'warning' },
              h('div', { style: { whiteSpace: 'pre-wrap' } }, humanizeError(error)),
              h('div', { style: { marginTop: 6 } }, h(Btn, { size: 'sm', onClick: () => setError(null) }, '知道了'))))
        : null,
      body(),
    ),
  )
}

// ── 首次设置：选文件夹 ────────────────────────────────────────────

function SetupView({ state, onDone }) {
  const [target, setTarget] = useState(state?.defaults?.workspace ?? '')
  const [busy, setBusy] = useState(false)
  const [inspect, setInspect] = useState(null)
  const [err, setErr] = useState(null)
  // 已经有一个库、是从首页「换个文件夹」进来的。这时输入框里预填的是
  // 现在用的那个文件夹（不是用户目录下的默认位置），换走之前必须先说清楚
  // 原来那些卡不会跟过来——不说，用户切过去看到空库会以为档案丢了。
  const current = String(state?.workspace ?? '')
  const switching = state?.exists === true && current !== ''

  const check = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await call('workspace.inspect', { path: target })
      setInspect(r)
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy(false) }
  }

  const create = async () => {
    setBusy(true); setErr(null)
    try {
      if (switching && target.trim() !== current) {
        const ask = typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm : () => true
        const yes = ask(`现在用的是：\n${current}\n\n换成：\n${target.trim()}\n\n换过去之后，原来那些卡不会跟过来——它们还在原来的文件夹里，想换回去随时能再选一次。`)
        if (!yes) return
      }
      await onDone(target)
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy(false) }
  }

  return h('div', { className: 'lc-pad lc-stack' },
    h('div', { className: 'lc-empty', style: { paddingBottom: 12 } },
      h('div', { className: 'lc-empty-icon' }, h(Icon, { name: 'folder', size: 22 })),
      h('h3', null, switching ? '换一个文件夹放档案' : '先挑一个文件夹放你的档案'),
      h('div', { className: 'lc-meta' }, '每个人会变成这里的一个文本文件。', h('br'), '你随时能在访达（Finder）里找到它们，也能用别的软件打开。'),
    ),
    switching
      ? h(Note, { icon: 'folder' }, '现在用的是下面这个位置。换成别的文件夹之后，这里的卡不会跟过来——它们还在原处，想换回来再选一次就行。')
      : null,
    h(Field, { label: '放在哪里', hint: '下面这个位置就行，直接点最下面的按钮。' },
      // 改了路径就把上一次「看看这个位置」的结论扔掉：不然下面还写着
      // 「这里已经有你的东西了：5 张卡」，用户会以为新路径接得上旧档案。
      h('input', { className: 'lc-input', value: target, onChange: (e) => { setTarget(e.target.value); setInspect(null) }, placeholder: '/Users/你/Documents/Life Cards', spellCheck: false }),
    ),
    h('div', { className: 'lc-row' },
      h(Btn, { onClick: check, disabled: busy || target.trim() === '', icon: 'folder' }, '看看这个位置'),
      busy ? h(Spinner) : null,
    ),
    inspect === null ? null : inspect.exists === false
      ? h(Note, { tone: 'warn', icon: 'warning' }, '这个文件夹还没有，点下面的按钮会帮你建出来。')
      : inspect.isLifeCard
        ? h(Note, { tone: 'ok', icon: 'check' }, `这里已经有你的东西了：${inspect.counts?.cards ?? 0} 张卡、${inspect.counts?.materials ?? 0} 份材料。`)
        : h(Note, { tone: 'warn', icon: 'warning' }, '这个文件夹里已经有别的东西。点下面的按钮只会在里面加几个新文件夹，不会动你原来的文件。'),
    err === null ? null : h(Err, { text: err }),
    h('div', { style: { marginTop: 4 } },
      h(Btn, { tone: 'primary', big: true, block: true, onClick: create, disabled: busy || target.trim() === '', icon: 'check' },
        busy ? '正在准备…' : inspect?.isLifeCard === true ? '就用这个文件夹' : '开始吧'),
    ),
  )
}

// ── 首页 ──────────────────────────────────────────────────────────

// ── 三扇门：先问「你要用哪个」 ──────────────────────────────────
//
// 这个插件的三件事其实不一样：写身边真人的、写虚构人物的、拿角色卡跟 AI
// 角色扮演的。它们共用同一套卡和世界书，但首页该露出的动作完全不同——
// 「贴一份招聘说明，看看该不该投」只属于真实人物那扇门，写小说的人看到
// 只会觉得莫名其妙。所以一进来先分门，选完再进去。
const DOORS = [
  {
    id: 'real', icon: 'people', tone: 'interview',
    title: '真实人物记录',
    desc: '身边的人：他做过什么、怎么说话、你们之间发生过什么。',
    bullets: ['聊着建，把他说的话记下来', '贴材料，让 AI 读出能核实的内容', '找工作：贴招聘说明、练面试'],
  },
  {
    id: 'novel', icon: 'book', tone: 'import',
    title: '写小说',
    desc: '虚构的角色和世界：先把人立起来，再一章一章往下写。',
    bullets: ['立角色：性格、口癖、绝不会做的事', '写世界：地方、规矩、里面还有谁'],
  },
  {
    id: 'tavern', icon: 'chat', tone: 'analyze',
    title: '酒馆',
    desc: '拿一张角色卡，和 TA 你一句一句地演。',
    bullets: ['挑一张角色卡就开演', '拿现实里的人来演也行（复制一份，原卡不动）'],
  },
]

/**
 * 进门那一屏：三扇**立着的门**。
 *
 * 为什么做成门的样子而不是三张卡片：卡片是「选一个设置」，门是「走进去」。
 * 这一屏是这个插件唯一的分岔口，用户在这儿做的决定（记真人 / 写小说 / 演）
 * 会决定后面所有屏长什么样，值得给一个够重的画面。
 *
 * 门该有的东西：门框、门楣、门牌、把手、门槛。这里都做了——
 * 顶上一条门楣色块、中间竖着写门名、底部一道门槛写着「推门进去」。
 * 三扇并排、各占三分之一宽、高度撑满；窄窗口自动换行。
 */
function DoorsView({ onPick, state, features }) {
  const workspace = String(state?.workspace ?? '')
  // 没装的门不摆出来。`features === null` 时全摆（还没问到，别闪一下少一扇）。
  const doors = (features === null || features === undefined)
    ? DOORS
    : DOORS.filter((d) => (d.id === 'real' ? true : d.id === 'novel' ? features.novel !== false : features.tavern !== false))
  const tint = {
    real: {
      fg: 'var(--lc-interview)', bg: 'var(--lc-interview-soft)', icon: 'people',
      // 门里那点光：不一样的暖冷，一眼能分出来
      glow: 'rgba(156, 123, 245, .18)',
    },
    novel: {
      fg: 'var(--lc-import)', bg: 'var(--lc-import-soft)', icon: 'book',
      glow: 'rgba(59, 201, 219, .18)',
    },
    tavern: {
      fg: 'var(--lc-analyze)', bg: 'var(--lc-analyze-soft)', icon: 'chat',
      glow: 'rgba(232, 185, 59, .18)',
    },
  }
  return h('div', {
    style: {
      display: 'flex', flexDirection: 'column', gap: 0,
      minHeight: '100%', boxSizing: 'border-box', padding: 12,
    },
  },
    h('div', { style: { flex: '0 0 auto', paddingBottom: 12 } },
      h('h2', { style: { margin: '2px 0 0', fontSize: 22, letterSpacing: '-.01em' } }, '你要用哪个？'),
      h('div', { className: 'lc-meta', style: { marginTop: 5 } }, '推一扇门进去。随时能换——卡和世界书都在同一个文件夹里。'),
    ),
    // 三扇门横向并排；窄窗口自动换行（flexWrap），免得挤成三条缝
    h('div', {
      style: {
        flex: '1 1 auto', display: 'flex', gap: 10,
        alignItems: 'stretch', flexWrap: 'wrap', minHeight: 280,
      },
    },
      doors.map((door) => {
        const t = tint[door.id] ?? tint.real
        return h('button', {
          key: door.id,
          type: 'button',
          className: 'lc-door',
          onClick: () => onPick(door.id),
          style: {
            // 每扇门平分宽度、各自撑满整高（门是竖的，高度要顶天立地）
            flex: '1 1 30%', minWidth: 156, minHeight: 260,
            display: 'flex', flexDirection: 'column', alignItems: 'stretch',
            gap: 0, padding: 0, textAlign: 'center', cursor: 'pointer',
            border: '1px solid var(--lc-line)', borderRadius: 16,
            // 门里透出来的光：上深下浅，像门后头有灯
            background: `linear-gradient(180deg, ${t.glow} 0%, var(--lc-panel) 55%, var(--lc-panel) 100%)`,
            boxShadow: 'var(--lc-shadow)', font: 'inherit', color: 'inherit',
            overflow: 'hidden', position: 'relative',
          },
        },
          // ── 门楣：顶上那条色带 ──
          h('div', {
            style: {
              flex: '0 0 auto', height: 6, width: '100%',
              background: t.fg, opacity: .85,
            },
          }),
          // ── 门牌：图标 + 门名 ──
          h('div', {
            style: {
              flex: '0 0 auto', display: 'flex', flexDirection: 'column',
              alignItems: 'center', gap: 8, padding: '16px 12px 10px',
            },
          },
            h('div', {
              style: {
                width: 50, height: 50, borderRadius: 14,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: t.bg, color: t.fg,
                border: `1px solid ${t.fg}`, boxSizing: 'border-box',
              },
            }, h(Icon, { name: t.icon, size: 25 })),
            h('div', { style: { fontSize: 16.5, fontWeight: 700, lineHeight: 1.3 } }, door.title),
            h('div', { className: 'lc-meta', style: { lineHeight: 1.6, padding: '0 2px' } }, door.desc),
          ),
          // ── 门里有什么 ──
          h('div', {
            style: {
              flex: '1 1 auto', display: 'flex', flexDirection: 'column',
              gap: 4, padding: '0 12px 10px', textAlign: 'left', justifyContent: 'center',
            },
          },
            (door.bullets ?? []).map((line, i) => h('div', {
              key: i,
              className: 'lc-meta',
              style: { display: 'flex', gap: 6, lineHeight: 1.55, alignItems: 'flex-start' },
            },
              h('span', { style: { color: t.fg, flex: '0 0 auto', fontWeight: 700 } }, '·'),
              h('span', null, line),
            )),
          ),
          // ── 门槛：底部那条，写着推门 ──
          h('div', {
            style: {
              flex: '0 0 auto', marginTop: 'auto',
              borderTop: '1px solid var(--lc-line)',
              padding: '10px 8px', width: '100%', boxSizing: 'border-box',
              color: t.fg, fontWeight: 700, fontSize: 13.5,
              background: t.bg,
            },
          }, '推门进去 →'),
          // ── 把手：右下角一个小圆点，门的那个意思 ──
          h('div', {
            'aria-hidden': 'true',
            style: {
              position: 'absolute', right: 10, bottom: 52,
              width: 7, height: 7, borderRadius: 999,
              background: t.fg, opacity: .55,
            },
          }),
        )
      }),
    ),
    workspace === '' ? null : h('div', { className: 'lc-meta', style: { flex: '0 0 auto', paddingTop: 10 } }, '档案就在你选的那个文件夹里'),
  )
}

function HomeView({ state, listing, mode, onOpen, onOpenWorld, onNavigate, onProposal, busy, onDoDoctor, showMore, onMore, intro, onIntroDone, onMaterial, onDeleteMaterial, chats, onOpenChat, onForkCard, onDeleteCard, onEditCard, books, onOpenBook, onCreateBook, pinId, onPickPin }) {
  // 这扇门是不是「真实人物记录」。写小说、酒馆那两扇门里不该出现
  // 「贴一份招聘说明」「从记忆里认人」这类动作——那是记录真人才用得上的。
  const isReal = mode !== 'novel' && mode !== 'tavern'
  // 「聊着建」那个入口的配色跟着门走：现实紫、小说蓝、酒馆黄。
  // 光靠标题那句字还不够，颜色一眼就分得开。
  const fictionActionTone = mode === 'tavern' ? 'analyze' : 'import'
  const [q, setQ] = useState('')
  const cards = listing?.cards ?? []
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (needle === '') return cards
    return cards.filter((c) => `${c.name} ${c.id} ${(c.tags ?? []).join(' ')} ${c.relation ?? ''}`.toLowerCase().includes(needle))
  }, [cards, q])
  // 已经全部采纳完的建议不再算「还等着你看」——留着会让待办永远清不空，
  // 用户每次回首页都以为自己还有事没做。
  const allProposals = listing?.proposals ?? []
  const proposals = allProposals.filter((p) => (p.adopted ?? 0) < (p.accepted ?? 0))
  // 「还等着你看的建议」只在**它属于的那扇门**里出现。
  //
  // 以前这是个跨屏提醒：在酒馆里写着小说，头顶一直挂着「关于『妈妈』的建议」；
  // 记录真人的时候又挂着小说角色的建议。建议本身没错，错在它不属于这一屏。
  // 判据是这条建议说的是谁——那个人有卡就按卡的 kind，没卡（还没建卡）算现实。
  const pendingProposals = proposals.filter((p) => {
    const name = String(p.about ?? '').trim()
    const hit = name === '' ? undefined : cards.find((c) => String(c.id ?? '') === name || String(c.name ?? '').trim() === name)
    const isFiction = hit !== undefined && hit.kind === 'fictional'
    return isFiction === (mode !== 'real')
  })
  const materials = listing?.materials ?? []
  // 搜索也要筛材料：搜一个人的名字，上面卡筛掉了、下面材料还整整齐齐列着，
  // 看着像「搜到了这一份」，其实根本没筛。
  const shownMaterials = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (needle === '') return materials
    return materials.filter((m) => String(m.name ?? m.path ?? '').toLowerCase().includes(needle))
  }, [materials, q])
  const avatars = listing?.avatars ?? {}
  // 酒馆门里要能看到「说过的那几场」，否则退出去就再也回不来那一场了。
  const chatRows = mode === 'tavern' && Array.isArray(chats) ? chats : []
  // 世界书不是卡：它没有覆盖度、不参与体检打分，放在卡列表里会让人以为
  // 「这张卡才写了 20%」。单独一段，点进去能读条目。
  const allWorlds = listing?.worlds ?? []
  // 搜索时世界书也得跟着筛。以前没筛，搜一个卡里没有的词，下面还是
  // 整整齐齐列着所有世界书，看着像「搜到了」。
  const worlds = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (needle === '') return allWorlds
    return allWorlds.filter((w) => `${w.name ?? ''} ${w.id ?? ''} ${w.genre ?? ''}`.toLowerCase().includes(needle))
  }, [allWorlds, q])
  const byKind = useMemo(() => {
    const real = filtered.filter((c) => c.kind === 'real' || c.kind === 'self' || c.kind === 'hybrid')
    const fic = filtered.filter((c) => c.kind === 'fictional')
    const other = filtered.filter((c) => !['real', 'self', 'hybrid', 'fictional'].includes(c.kind))
    return { real, fic, other }
  }, [filtered])
  // 酒馆那扇门里，现实里的人默认收起来：一进去先看见父母、同学、同事的一排卡，
  // 会让人不太舒服，也分不清哪些是拿来演的。想看的时候再展开。
  const [showRealForRole, setShowRealForRole] = useState(false)
  // 正在问「要不要复制一份来演」的那张卡
  const [forkAsk, setForkAsk] = useState(null)

  // 第一次进来时那段介绍。只出现一次，点过「知道了」就不再出现。
  // 刻意只有四五行：介绍写长了没人读，读的人也只想知道「这玩意儿干吗的、从哪儿下手」。
  const introBlock = intro !== true
    ? null
    : h('div', { className: 'lc-note', style: { marginBottom: 2 } },
        h('div', { style: { fontWeight: 650, marginBottom: 4 } }, '这是做什么的'),
        h('div', { style: { lineHeight: 1.7 } },
          '把身边的人写成一张卡：他做过什么、怎么说话、你们之间发生过什么。写得越具体，AI 越像他。',
        ),
        h('div', { style: { lineHeight: 1.7, marginTop: 4 } },
          '两种进来：让 AI 问你几个问题边聊边建，或者把别人给的卡拖进来。也可以自己一张空表慢慢填。',
        ),
        h('div', { style: { lineHeight: 1.7, marginTop: 4 } },
          '卡都存在你自己选的文件夹里，是纯文本，用记事本就能打开看。',
        ),
        h('div', { className: 'lc-row', style: { marginTop: 6 } },
          h(Btn, { size: 'sm', tone: 'primary', onClick: onIntroDone }, '知道了'),
        ),
      )

  // 「还没有档案」这句只在真的什么都没有时说。以前只看卡和世界书，
  // 于是刚把一段文字存成材料、还没建卡的人回首页会看到一片空白，
  // 以为刚才没存上，又贴一遍——材料就多出一份重复的。
  if (cards.length === 0 && allWorlds.length === 0 && materials.length === 0 && proposals.length === 0) {
    // 同一个空库，三扇门该给三条不同的路：写小说的人不需要「访谈」，
    // 记录真人的人也不需要「先写一章」。
    return h('div', { className: 'lc-pad lc-stack' },
      introBlock,
      h('div', { className: 'lc-empty', style: { padding: '18px 8px 10px' } },
        h('div', { className: 'lc-empty-icon' }, h(Icon, { name: isReal ? 'book' : mode === 'tavern' ? 'chat' : 'pencil', size: 22 })),
        h('h3', null, isReal ? '还没有档案' : '还什么都没有'),
        h('div', { className: 'lc-meta' }, '选一个开始的方式，随时可以换别的：'),
      ),
      // 三扇门第一块都给「聊着建」：那是这个插件最好上手的入口。
      // 差别只在说什么话——建真人问的是「他是我的什么人」，
      // 建角色问的是「TA 一张嘴什么感觉」。
      h(Action, {
        tone: fictionActionTone,
        icon: 'chat',
        title: isReal ? '陪我聊聊，边聊边建' : (mode === 'tavern' ? '聊着立一个能演的角色' : '聊着立一个小说角色'),
        desc: isReal
          ? '它会问几个具体的问题。答不上来就跳过，一句也不想说也行。'
          : '先问 TA 怎么说话、什么情况下会变脸，比填空白表快。',
        onClick: () => onNavigate(VIEWS.interview),
      }),
      h(Action, {
        tone: 'import', icon: 'import',
        title: '把已有的角色卡拖进来',
        desc: '别人给你的角色卡，图片或导出的文件都行，放进来就能看。',
        onClick: () => onNavigate(VIEWS.import),
      }),
      h(Action, {
        icon: 'pencil',
        title: '我自己填',
        desc: '一张空表，一个字段一个字段地写。',
        onClick: () => onNavigate(VIEWS.newCard),
      }),
      // 写小说最常用的其实不是填表：手里已经有一篇小说、一段人物小传，
      // 想让它读成人设。这条路以前只在「真实人物」那扇门里有。
      h(Action, {
        tone: 'analyze', icon: 'spark',
        title: isReal ? '贴一段材料，让 AI 读出信息' : '贴一段文章，让 AI 读成这个角色',
        desc: isReal
          ? '访谈稿、聊天记录、日记都行。它只会说材料里写过的东西，每条都标出原句。'
          : '小说片段、人物小传、你写的设定都行。读出来的东西先给你看，你点了才写进卡。',
        onClick: () => onNavigate(VIEWS.import),
      }),
    )
  }

  return h('div', { className: 'lc-pad lc-stack' },
    introBlock,
    h('div', { className: 'lc-row' },
      h('input', { className: 'lc-input', value: q, onChange: (e) => setQ(e.target.value), placeholder: '找找看…', spellCheck: false }),
      h(Btn, { tone: 'primary', size: 'sm', icon: 'plus', onClick: () => onNavigate(VIEWS.newCard), title: '新建一张卡' }, '新建'),
    ),

    h('div', { className: 'lc-row', style: { marginTop: 2 } },
      h(Btn, { tone: isReal ? 'interview' : fictionActionTone, size: 'sm', icon: 'chat', onClick: () => onNavigate(VIEWS.interview) }, isReal ? '聊着建' : '聊着立一个人'),
      h(Btn, { tone: 'import', size: 'sm', icon: 'import', onClick: () => onNavigate(VIEWS.import) }, '导入'),
      isReal
        ? h(Btn, { tone: 'analyze', size: 'sm', icon: 'person', onClick: () => onNavigate(VIEWS.memory), title: '从你写过的记忆里认出身边的人' }, '从记忆里认人')
        : null,
      isReal
        ? h(Btn, { tone: 'primary', size: 'sm', icon: 'briefcase', onClick: () => onNavigate(VIEWS.jobs), title: '贴一份招聘说明，看看该不该投；或者练一轮面试' }, '下一步')
        : null,
      isReal
        ? h(Btn, { size: 'sm', icon: 'book', onClick: () => onNavigate(VIEWS.career), title: '把自己的情况写清楚，让 AI 帮你看简历、算差距、规划怎么走' }, '简历与规划')
        : null,
      h('div', { className: 'lc-grow' }),
      // 「贴一段文章让 AI 读」不是只有记录真人才用得上：写小说、酒馆里
      // 手里有一段人物设定/小说片段，一样想让它读成人设。所以三扇门都给。
      materials.length > 0
        ? h(Btn, { tone: 'analyze', size: 'sm', icon: 'spark', onClick: () => onNavigate(VIEWS.analyze) }, isReal ? `整理 ${materials.length} 份材料` : `读那 ${materials.length} 段材料`)
        : null,
    ),

    // 一眼看到「这里有多少东西」：以前首页只有标题和一排按钮，一大片空。
    // 数字本身就是内容，也让人知道还有多少没用起来。
    h('div', { className: 'lc-sec', style: { paddingTop: 2 } },
      h('div', { className: 'lc-row', style: { flexWrap: 'wrap', gap: 14 } },
        h('div', { className: 'lc-stack', style: { gap: 1, minWidth: 62 } },
          h('div', { style: { fontSize: 22, fontWeight: 700, lineHeight: 1.2 } }, String(cards.length)),
          h('div', { className: 'lc-meta' }, isReal ? '认识的人' : '角色'),
        ),
        h('div', { className: 'lc-stack', style: { gap: 1, minWidth: 62 } },
          h('div', { style: { fontSize: 22, fontWeight: 700, lineHeight: 1.2 } }, String(materials.length)),
          h('div', { className: 'lc-meta' }, '材料'),
        ),
        h('div', { className: 'lc-stack', style: { gap: 1, minWidth: 62 } },
          h('div', { style: { fontSize: 22, fontWeight: 700, lineHeight: 1.2 } }, String(pendingProposals.length)),
          h('div', { className: 'lc-meta' }, '待你看'),
        ),
        mode === 'novel'
          ? h('div', { className: 'lc-stack', style: { gap: 1, minWidth: 62 } },
              h('div', { style: { fontSize: 22, fontWeight: 700, lineHeight: 1.2 } }, String((books ?? []).length)),
              h('div', { className: 'lc-meta' }, '书'),
            )
          : null,
        mode === 'tavern'
          ? h('div', { className: 'lc-stack', style: { gap: 1, minWidth: 62 } },
              h('div', { style: { fontSize: 22, fontWeight: 700, lineHeight: 1.2 } }, String((chats ?? []).length)),
              h('div', { className: 'lc-meta' }, '聊过的场'),
            )
          : null,
      ),
    ),

    // 写小说那扇门：先列书架。没有它，用户建了一本书再回来就找不到了。
    mode === 'novel'
      ? h('div', null,
          h(GroupTitle, { tone: 'import', icon: 'book' }, `我的书 · ${(books ?? []).length}`),
          (books ?? []).length === 0
            ? h('div', { className: 'lc-meta', style: { lineHeight: 1.7 } },
                '还没有书。新建一本，让 AI 先想大纲，再一章一章写。')
            : h('div', { className: 'lc-stack' }, (books ?? []).map((b) => h('button', {
                key: b.id,
                className: 'lc-card-item',
                type: 'button',
                onClick: () => onOpenBook?.(b),
                style: { textAlign: 'left', font: 'inherit', color: 'inherit', width: '100%' },
              },
                h('div', { className: 'lc-avatar', style: { background: 'var(--lc-import-soft)', color: 'var(--lc-import)' } }, h(Icon, { name: 'book', size: 14 })),
                h('div', { className: 'lc-grow', style: { minWidth: 0 } },
                  h('div', { className: 'lc-ellipsis', style: { fontWeight: 650 } }, String(b.title ?? b.id)),
                  h('div', { className: 'lc-meta' },
                    [`${b.chapters ?? 0} 章`, `${Math.max(1, Math.round((b.words ?? 0) / 1000))} 千字`]
                      .concat(String(b.genre ?? '').trim() === '' ? [] : [String(b.genre)])
                      .join(' · ')),
                  String(b.idea ?? '').trim() === '' ? null : h('div', { className: 'lc-meta lc-ellipsis' }, String(b.idea)),
                ),
              ))),
          h('div', { className: 'lc-row', style: { marginTop: 8 } },
            h(Btn, { size: 'sm', tone: 'import', icon: 'plus', onClick: () => onCreateBook?.() }, '新建一本书'),
          ),
        )
      : null,

    // 酒馆门里先列「说过的场次」：这是回来的路。没有它，用户退出一场
    // 就再也找不回来——只能重新开一场，前面那些话看着像丢了。
    chatRows.length > 0
      ? h('div', null,
          h(GroupTitle, { tone: 'analyze', icon: 'chat' }, `说过的场次 · ${chatRows.length}`),
          h('div', { className: 'lc-stack' }, chatRows.map((c) => h('button', {
            key: c.id,
            className: 'lc-btn block',
            style: { justifyContent: 'flex-start', textAlign: 'left', padding: '7px 9px' },
            type: 'button',
            onClick: () => onOpenChat?.(c),
          },
            h('div', { className: 'lc-row', style: { gap: 6 } },
              h('div', { className: 'lc-grow lc-ellipsis', style: { fontWeight: 650, fontSize: 14.5 } }, `和「${String(c.card_name ?? '').trim() === '' ? 'TA' : c.card_name}」`),
              h('span', { className: 'lc-meta' }, `${c.turns ?? 0} 句`),
            ),
            String(c.last ?? '').trim() === ''
              ? null
              : h('div', { className: 'lc-meta lc-ellipsis', style: { marginTop: 2 } }, String(c.last).slice(0, 42)),
          ))),
        )
      : null,

    byKind.real.length > 0
      ? (isReal
          ? h('div', null,
              h(GroupTitle, { icon: 'people' }, `认识的人 · ${byKind.real.length}`),
              h('div', { className: 'lc-stack' }, byKind.real.map((c) => h(CardRow, { key: c.path, card: c, onOpen, photo: avatars[c.id], onDelete: onDeleteCard, onEdit: onEditCard }))),
            )
          // 同一个文件夹里可能两样都有。这扇门不直接铺开真人，但也不能装作没有——
          // 用户会以为卡丢了。收起来一行，想看再展开，展开后是「复制一份来演」。
          : h('div', null,
              h(GroupTitle, { icon: 'people' }, `现实里认识的人 · ${byKind.real.length}`),
              h('div', { className: 'lc-meta', style: { marginBottom: 6 } },
                '这些是记录真人用的，默认不铺开；想看完整的那张，去「真实人物记录」那扇门。拿去演会复制一份独立的角色卡——之后怎么改都动不到原来那张。'),
              h(Btn, { size: 'sm', icon: showRealForRole ? 'chevron' : 'people', onClick: () => { setShowRealForRole(!showRealForRole); setForkAsk(null) } },
                showRealForRole ? '先收起' : '展开看看'),
              showRealForRole
                ? h('div', { className: 'lc-stack', style: { marginTop: 8 } },
                    forkAsk === null
                      ? null
                      : h('div', { className: 'lc-note' },
                          h('div', { style: { lineHeight: 1.7 } },
                            `「${String(forkAsk.name ?? '').trim() === '' ? '这个人' : forkAsk.name}」的卡是现实里的记录。`,
                            h('br'),
                            '拿去演会复制成一张新的角色卡：性格、说话方式随便改，原来那张一个字都不会动。'),
                          h('div', { className: 'lc-row', style: { marginTop: 8, gap: 6 } },
                            h(Btn, { size: 'sm', tone: 'analyze', icon: 'chat', onClick: () => { const c = forkAsk; setForkAsk(null); onForkCard?.(c) } }, '复制一份来演'),
                            h(Btn, { size: 'sm', onClick: () => setForkAsk(null) }, '先不'),
                          ),
                        ),
                    byKind.real.map((c) => h(CardRow, {
                      key: c.path, card: c, onOpen: (row) => setForkAsk(row), photo: avatars[c.id],
                    })),
                  )
                : null,
            ))
      : null,

    // 「现在用哪张」：写小说、酒馆那两扇门里演谁 / 写谁不用每次现挑；
    // 真实人物那扇门用它决定首页先给谁。存在这个文件夹的 config.json 里。
    (() => {
      const pool = isReal ? byKind.real : byKind.fic
      if (pool.length === 0) return null
      const label = isReal ? '这扇门先看谁' : (mode === 'tavern' ? '现在演谁' : '现在写谁')
      const chosen = String(pinId ?? '')
      const hit = chosen === '' ? undefined : pool.find((c) => String(c.id ?? '') === chosen)
      // 空着也是一档：不挑卡。用户按一下下拉里的第一项就能取消选择，
      // 之后写小说 / 演都从零开始，不读卡上的设定。
      return h('div', null,
        h('div', { className: 'lc-row', style: { marginTop: 10, marginBottom: 2, gap: 8 } },
          h('span', { className: 'lc-meta', style: { flexShrink: 0 } }, label),
          h('select', {
            className: 'lc-select',
            value: chosen,
            onChange: (e) => onPickPin?.(String(e?.target?.value ?? '')),
          },
            h('option', { value: '' }, '不挑卡（从零开始）'),
            pool.map((c) => h('option', { key: c.path, value: String(c.id ?? '') }, String(c.name ?? '(还没起名字)'))),
          ),
          hit === undefined ? null : h('span', { className: 'lc-meta' }, '说「演他」「写他」就默认用这张'),
        ),
        chosen !== '' ? null : h('div', { className: 'lc-meta', style: { marginTop: 2 } },
          isReal
            ? '没挑卡：这扇门不需要它，看谁点谁就行。'
            : (mode === 'tavern'
                ? '没挑卡：这一场不读卡上的设定，TA 会先问你两三句把人立起来。'
                : '没挑卡：这一本不读卡上和世界书里的设定，AI 只按写作方法来写。')),
      )
    })(),

    byKind.fic.length > 0
      ? h('div', null,
          h(GroupTitle, { tone: 'interview', icon: 'book' }, `${isReal ? '虚构角色' : (mode === 'tavern' ? '可以拿来演的角色' : '角色')} · ${byKind.fic.length}`),
          h('div', { className: 'lc-stack' }, byKind.fic.map((c) => h(CardRow, { key: c.path, card: c, onOpen, photo: avatars[c.id], onDelete: onDeleteCard, onEdit: onEditCard }))),
        )
      : null,

    byKind.other.length > 0
      ? h('div', null,
          h(GroupTitle, { tone: 'analyze', icon: 'list' }, `其他 · ${byKind.other.length}`),
          h('div', { className: 'lc-stack' }, byKind.other.map((c) => h(CardRow, { key: c.path, card: c, onOpen, photo: avatars[c.id], onDelete: onDeleteCard, onEdit: onEditCard }))),
        )
      : null,

    // 材料单独一栏。以前材料只在「更多工具」里报个数字，用户从记忆里提出来
    // 一堆东西之后回首页找不到——不知道存哪了，也没法看、没法删。
    !isReal || shownMaterials.length === 0
      ? null
      : h('div', null,
          h(GroupTitle, { tone: 'analyze', icon: 'list' }, `材料 · ${shownMaterials.length}`),
          h('div', { className: 'lc-stack' }, shownMaterials.map((m) => h('div', { key: m.path, className: 'lc-card-item', style: { cursor: 'default' } },
            h('div', { className: 'lc-avatar', style: { background: 'var(--lc-analyze-soft)', color: 'var(--lc-analyze)' } }, h(Icon, { name: 'list', size: 14 })),
            h('div', { className: 'lc-grow', style: { minWidth: 0 } },
              h('div', { className: 'lc-ellipsis', style: { fontWeight: 600 } }, m.name),
              h('div', { className: 'lc-meta' }, [
                m.chars > 0 ? `${m.chars} 字` : (m.size > 0 ? `${m.size} 字节` : '空文件'),
                m.mtime === undefined ? '' : shortDate(m.mtime),
              ].filter((x) => x !== '').join(' · ')),
            ),
            onMaterial === undefined ? null : h(Btn, { size: 'sm', ghost: true, onClick: () => onMaterial(m) }, '看'),
            onDeleteMaterial === undefined ? null : h(Btn, { size: 'sm', ghost: true, icon: 'trash', onClick: () => onDeleteMaterial(m), title: '删掉这一份' }, '删'),
          ))),
        ),

    q.trim() !== '' && filtered.length === 0 && worlds.length === 0 && shownMaterials.length === 0
      ? h('div', { className: 'lc-meta', style: { textAlign: 'center', padding: 12 } }, '没找到。换个词试试？')
      : null,

    worlds.length === 0
      ? null
      : h('div', null,
          h(GroupTitle, { tone: 'analyze', icon: 'book' }, `世界书 · ${worlds.length}`),
          h('div', { className: 'lc-stack' }, worlds.map((w) => h(WorldRow, { key: w.path, world: w, onOpen: onOpenWorld, photo: avatars[w.id] }))),
        ),

    // 「还等着你看的建议」只在**它属于的那扇门**里出现。
    //
    // 以前这是个跨屏提醒：在酒馆里写着小说，头顶一直挂着「关于『妈妈』的建议」；
    // 记录真人的时候又挂着小说角色的建议。建议本身没错，错在它不属于这一屏。
    // 判据是：这条建议说的是谁——那个人有卡就按卡的 kind（虚构/现实），
    // 没卡就按「还没建卡」算现实（绝大多数情况是给人建卡时读出来的）。
    pendingProposals.length > 0
      ? h('div', null,
          h(GroupTitle, { tone: 'analyze', icon: 'spark' }, `还等着你看的建议 · ${pendingProposals.length}`),
          h('div', { className: 'lc-stack' }, pendingProposals.slice(0, 6).map((p) => h('button', {
            key: p.json, className: 'lc-card-item', type: 'button',
            onClick: () => onProposal(p.json),
          },
            h('div', { className: 'lc-avatar', style: { background: 'var(--lc-analyze-soft)', color: 'var(--lc-analyze)' } }, h(Icon, { name: 'spark', size: 14 })),
            h('div', { className: 'lc-grow' },
              h('div', { style: { fontWeight: 600 } }, `关于「${p.about}」`),
              h('div', { className: 'lc-meta' },
                `${p.accepted} 条可以采用`,
                (p.adopted ?? 0) > 0 ? ` · 已经写进去 ${p.adopted} 条` : '',
                p.rejected > 0 ? ` · ${p.rejected} 条没能核实，已丢掉` : '',
                ' · ', shortDate(p.generated_at)),
            ),
          ))),
          // 一次只摆 6 份。不说明的话，第 7 份起就永远看不见——
          // 用户会以为那些建议丢了。
          pendingProposals.length > 6
            ? h('div', { className: 'lc-meta' }, `还有 ${pendingProposals.length - 6} 份没列出来。处理掉上面任意一份，它就会顶上来。`)
            : null,
        )
      : null,

    (listing?.errors ?? []).length > 0
      ? h(Note, { tone: 'warn', icon: 'warning' }, `有 ${listing.errors.length} 个文件读不了，没影响别的。`)
      : null,

    // ── 收起来的「更多」──
    h('div', { style: { marginTop: 14 } },
      h('button', {
        className: 'lc-btn ghost sm', type: 'button', onClick: onMore,
        style: { width: '100%', justifyContent: 'flex-start' },
      }, h('span', { style: { display: 'inline-flex', transform: showMore ? 'rotate(90deg)' : 'none', transition: 'transform .12s' } }, h(Icon, { name: 'chevron', size: 12 })), showMore ? '收起' : '更多工具'),
    ),
    showMore === true
      ? h('div', { className: 'lc-stack' },
          h('div', { className: 'lc-meta' }, materials.length === 0
            ? '你还没有放材料。想用材料建卡，先去「添加」里贴一段文字。'
            : '材料都在上面那一栏里。点「看」能挑一份让 AI 读。'),
          h('div', { className: 'lc-row' },
            h(Btn, { size: 'sm', icon: 'spark', onClick: () => onNavigate(VIEWS.analyze), disabled: materials.length === 0 }, '让 AI 读出建议'),
            h(Btn, { size: 'sm', icon: 'doctor', onClick: onDoDoctor }, '检查档案有没有问题'),
          ),
          // 选错了文件夹在这里就没路可退——档案都在那个文件夹里，
          // 重装软件也改不回来。给一条明路。
          h('div', { className: 'lc-row', style: { marginTop: 6 } },
            h(Btn, { size: 'sm', ghost: true, icon: 'folder', onClick: () => onNavigate(VIEWS.setup) }, '换个文件夹'),
            // 路径照实写出来：这是唯一一处「档案到底在哪儿」的线索。
            // 藏起来，选错文件夹的人就永远找不回去了。
            h('span', { className: 'lc-meta lc-ellipsis' }, state?.workspace === undefined || state?.workspace === '' ? '' : '档案就在你选的那个文件夹里'),
          ),
        )
      : null,
  )
}

function CardRow({ card, onOpen, photo, onDelete, onEdit }) {
  // 整行是一个 button（点哪儿都能打开）。要再塞一个「删」进去，就不能
  // 在 button 里放 button——浏览器会把它们当兄弟节点拆开，React 也会警告。
  // 所以行改成 div，左边一块可点区域负责打开，右边单独一个真 button 负责删。
  return h('div', { className: 'lc-card-item', style: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'default' } },
    h('button', {
      type: 'button',
      className: 'lc-row',
      onClick: () => onOpen(card),
      style: {
        flex: '1 1 auto', minWidth: 0, background: 'transparent', border: 0,
        padding: 0, textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit',
        display: 'flex', alignItems: 'center', gap: 8,
      },
    },
    h(Avatar, { name: card.name, kind: card.kind, photo }),
    h('div', { className: 'lc-grow' },
      h('div', { className: 'lc-row' },
        h('span', { style: { fontWeight: 600, flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' } }, card.name),
        card.relation === undefined || card.relation === '' ? null : h('span', { className: 'lc-meta' }, card.relation),
        h('span', { className: 'lc-grow' }),
        card.issues?.some((i) => i.level === 'error')
          ? h(Tag, { tone: 'err' }, '有问题')
          : null,
      ),
      h('div', { className: 'lc-row', style: { marginTop: 3 } },
        h(Bar, { value: card.coverage }),
        // 「10%」以前只有一个数字，没人知道是什么。它是这张卡写全了多少：
        // 关系、性格、说话习惯、做过的事……这些栏里填了几样。
        h('span', { className: 'lc-meta', style: { flexShrink: 0 }, title: '这张卡写全了多少：性格、说话习惯、做过的事这些填了几样' }, `写全 ${card.coverage}%`),
      ),
      (card.tags ?? []).length > 0
        ? h('div', { className: 'lc-wrap', style: { marginTop: 5 } }, card.tags.slice(0, 4).map((t) => h(Tag, { key: t }, t)))
        : null,
    ),
    ),
    // 列表里直接能删：以前必须先点开卡、滚到最底下才找得到「删掉这张卡」，
    // 建错一张（比如「复制一份来演」试了几次）就得来回点好几屏。
    // 「写全 10%」后面以前没有任何「去补它」的入口：要改这张卡，得先点开、
    // 再在卡页上找「改这张卡」。一行一个铅笔，直接进修改。
    onEdit === undefined ? null : h('button', {
      type: 'button',
      className: 'lc-btn ghost sm',
      title: `改「${card.name ?? '这张卡'}」`,
      onClick: (e) => { e?.stopPropagation?.(); onEdit(card) },
      style: { flex: '0 0 auto' },
    }, h(Icon, { name: 'pencil', size: 13 })),
    onDelete === undefined ? null : h('button', {
      type: 'button',
      className: 'lc-btn ghost sm',
      title: `删掉「${card.name ?? '这张卡'}」`,
      onClick: (e) => { e?.stopPropagation?.(); onDelete(card) },
      style: { flex: '0 0 auto' },
    }, h(Icon, { name: 'trash', size: 13 })),
  )
}

/** 世界书在列表里的一行。和卡不同：没有百分数，只报「几条」。 */
function WorldRow({ world, onOpen, photo }) {
  const count = Number(world.entry_count ?? 0)
  return h('button', { className: 'lc-card-item', onClick: () => onOpen(world), type: 'button' },
    h(Avatar, { name: world.name, kind: 'world', photo }),
    h('div', { className: 'lc-grow' },
      h('div', { className: 'lc-row' },
        h('span', { style: { fontWeight: 600, flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' } }, world.name),
        h('span', { className: 'lc-grow' }),
        h(Tag, null, '世界书'),
      ),
      h('div', { className: 'lc-meta', style: { marginTop: 3 } },
        count === 0 ? '还没有条目' : `${count} 条设定`,
        world.genre === undefined || world.genre === '' ? '' : ` · ${world.genre}`,
      ),
    ),
  )
}

// ── 一本世界书 ────────────────────────────────────────────────────

// 现实世界的保留名字。`world` 是 real/fictional/hybrid 的必填字段，
// 所以「不属于哪本书」不能写成空串——那会让这张卡变成缺字段的坏卡。
const REALITY = 'reality'

/**
 * 触发词在导入时永远写成数组，但人手工改文本文件时可能写成
 * `keys: 北洋` 这种单个字符串。读的时候一律当数组看，不然搜索漏掉它、
 * 界面上还会说「没有触发词」——两处都不报错，人只会觉得这本书坏了。
 */
function keysOf(entry) {
  const raw = entry?.keys ?? entry?.key
  if (Array.isArray(raw)) return raw.filter((k) => String(k ?? '').trim() !== '').map((k) => String(k))
  if (typeof raw === 'string' && raw.trim() !== '') return [raw.trim()]
  return []
}

function keysText(raw) {
  if (Array.isArray(raw)) return raw.join(' ')
  return typeof raw === 'string' ? raw : ''
}

/**
 * 一本世界书的详情。
 *
 * 条目本身是别人写好的设定集（酒馆世界书导进来的），这里只做「能读到、
 * 能搜、能看见哪些条目是关着的」，不做编辑——编辑世界书是另一件事，
 * 而且条目上有几十个 v0.1 不解释的字段，瞎改会把原设定弄坏。
 */
function WorldView({ world, listing, onOpenCard }) {
  const [q, setQ] = useState('')
  const entries = world?.entries ?? []
  const data = world?.data ?? {}
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (needle === '') return entries
    return entries.filter((e) => `${keysText(e.keys)} ${String(e.content ?? '')} ${String(e.comment ?? '')}`.toLowerCase().includes(needle))
  }, [entries, q])
  // 这本世界书底下的卡（worlds/<id>/cards/ 里的，或者 world 字段指向它的）
  const here = (listing?.cards ?? []).filter((c) => String(c.world ?? '') === String(data.id ?? ''))
  const off = entries.filter((e) => e.enabled === false).length

  return h('div', { className: 'lc-pad lc-stack' },
    h('div', { className: 'lc-row' },
      h(Avatar, { name: data.name, kind: 'world', big: true, photo: (listing?.avatars ?? {})[data.id] ?? null }),
      h('div', { className: 'lc-grow' },
        h('div', { className: 'lc-title' }, data.name ?? '这本世界书'),
        h('div', { className: 'lc-meta' }, '一本设定集：写一个地方、一段时间里的规矩和人物'),
      ),
    ),

    h('div', { className: 'lc-row', style: { marginTop: 2 } },
      h(Tag, null, `${entries.length} 条设定`),
      off === 0 ? null : h(Tag, { tone: 'warn' }, `${off} 条关着`),
      h('div', { className: 'lc-grow' }),
      // 这里原来有个「整理材料」按钮，点了却跳去「让 AI 读你写的材料」——
      // 那一页只认人物（要选一个 about），跟这一本世界书没有关系。
      // 按钮只能做它字面上说的事，做不到就先拿掉。
    ),

    entries.length === 0
      ? h(Note, { tone: 'warn', icon: 'warning' }, '这本世界书里没有条目。可能是原文件本身是空的。')
      : h('input', { className: 'lc-input', value: q, onChange: (e) => setQ(e.target.value), placeholder: '找找看…（触发词、内容都能搜）', spellCheck: false }),

    filtered.length === 0 && entries.length > 0
      ? h('div', { className: 'lc-meta', style: { textAlign: 'center', padding: 12 } }, '没找到。换个词试试？')
      : null,

    filtered.map((e, i) => h('div', { key: String(e.uid ?? `e-${i}`), className: 'lc-sec' },
      h('div', { className: 'lc-row' },
        h('div', { className: 'st lc-grow' }, e.comment === undefined || e.comment === '' ? '（没写名字）' : String(e.comment)),
        keysOf(e).length > 0
          ? h('span', { className: 'lc-meta' }, keysOf(e).map((k) => `「${k}」`).join(' '))
          : h('span', { className: 'lc-meta' }, '没有触发词'),
        e.enabled === false ? h(Tag, { tone: 'warn' }, '关着') : null,
      ),
      h('div', { className: 'sb lc-clamp' }, String(e.content ?? '').trim() === '' ? '（这条是空的）' : String(e.content)),
    )),

    here.length === 0
      ? null
      : h('div', null,
          h(GroupTitle, { icon: 'people' }, `用这本世界书的卡 · ${here.length}`),
          h('div', { className: 'lc-stack' }, here.map((c) => h(CardRow, { key: c.path, card: c, onOpen: onOpenCard }))),
        ),

    h('div', { className: 'lc-meta', style: { marginTop: 6 } },
      '这些设定是别人写好一起带过来的。要改的话，直接改那个文本文件，改完回来刷新一下就好。'),
  )
}

// ── 单张卡 ────────────────────────────────────────────────────────

/**
 * 酒馆：和一张卡你一句我一句地说下去。
 *
 * 三件事刻意做得笨一点：
 *   1. 没有「流式打字」——一句话说完才出现。省得半句半句往外蹦、用户读一半
 *      就以为断线了；
 *   2. 我说的话先存再等 TA 回。TA 没回话是常事（网、模型），但我说的话
 *      不能因为这个丢掉；
 *   3. 退出就是退出，不弹「确定放弃吗」——每一轮都已经在文件里了。
 */
/**
 * 一本书：大纲 → 一章一章写 → 审。
 *
 * 这一屏是「写小说」那扇门真正干活的地方。三段对应三件事：
 *   1. **先想清楚**：让 AI 把整本书的骨架搭出来，落成一份大纲；人能直接改。
 *   2. **写这一章**：拿大纲里这一章那一句 + 上一章结尾 + 设定，让它写正文。
 *   3. **挑毛病**：写完让它只挑问题、不夸，人照着改。
 *
 * 刻意不做的事：
 *   - 不自动一章接一章往下写。写完一章就停下来等人看——一次生成十章的书
 *     没人会读，也没人改得动。
 *   - 不问「要不要继续」。按钮在那儿，要不要点是人自己的事。
 */
/**
 * 预设选择条：三种玩法共用。
 *
 * 为什么做成一行小按钮而不是下拉框：这些名字（慢热 / 直球 / 冷峻白描 /
 * 查一件事）本身就说明了效果，扫一眼就能选。下拉框要点两下才看见有什么。
 */
function PresetBar({ mode, value, onChange, onManage }) {
  const [groups, setGroups] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => {
    let gone = false
    call('preset.list', {})
      .then((r) => { if (!gone && r?.ok === true) setGroups(Array.isArray(r.groups) ? r.groups : []) })
      .catch((e) => { if (!gone) setErr(humanizeError(e)) })
    return () => { gone = true }
  }, [])
  if (groups === null) return null
  const mine = groups.find((g) => String(g.mode) === mode)
  const items = mine === undefined ? [] : (mine.items ?? [])
  if (items.length === 0) return null
  return h('div', { className: 'lc-stack', style: { gap: 6 } },
    h('div', { className: 'lc-row' },
      h('div', { className: 'lc-grow lc-meta' }, '演法 / 写法（选一个，能不选）'),
      onManage === undefined ? null : h(Btn, { size: 'sm', ghost: true, icon: 'edit', onClick: onManage }, '管理'),
    ),
    h('div', { className: 'lc-row', style: { flexWrap: 'wrap', gap: 6 } },
      items.map((p) => h(Btn, {
        key: p.id,
        size: 'sm',
        tone: value === p.id ? 'primary' : undefined,
        onClick: () => onChange(value === p.id ? '' : p.id),
        title: String(p.desc ?? ''),
      }, String(p.name ?? p.id))),
    ),
    err === null ? null : h(Note, { tone: 'err', icon: 'warning' }, err),
  )
}

/**
 * 文字小说游戏：进到一本书的某一段情节里，你来选，它来推。
 *
 * 和「写小说」摆在一起但不是一个东西：那边是你在写，这边是你在里面。
 * 所以这一屏的重点是**局面清楚**——现在在哪、手上有什么、这一步要付什么代价。
 */
function GameView({ bookId, onBack, flash }) {
  const [play, setPlay] = useState(null)
  const [move, setMove] = useState('')
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState(null)
  const [preset, setPreset] = useState('')
  const [chapter, setChapter] = useState(0)
  const [chapterList, setChapterList] = useState([])
  // 「把这一局写成小说的一章」。这几个 state 放在所有 hook 之后：
  // 上面那几个槽位有测试按号码摆状态，插在中间会全体错位。
  const [toOpen, setToOpen] = useState(false)
  const [toNote, setToNote] = useState('')
  const [toBusy, setToBusy] = useState(false)
  // 以前这一局退出就找不回来了，而界面还写着「退出再进来还能接着走」。
  // 存档后台一直都有（game.list），缺的就是这半截入口。
  const [plays, setPlays] = useState([])

  const loadPlays = async () => {
    try {
      const r = await call('game.list', { book: bookId })
      if (r?.ok === true) setPlays(Array.isArray(r.items) ? r.items : [])
    } catch { /* 列不出来不影响新开一局 */ }
  }

  const toChapter = async () => {
    if (play === null) return
    setToBusy(true); setErr(null)
    try {
      const r = await call('game.toChapter', { book: bookId, id: play.id, note: toNote })
      if (r?.ok !== true) { setErr(r?.error ?? '没写成'); return }
      setToOpen(false); setToNote('')
      if (typeof flash === 'function') flash(`写成了第 ${r.chapter ?? '?'} 章`)
    } catch (e) { setErr(humanizeError(e)) } finally { setToBusy(false) }
  }

  const open = async (row) => {
    setErr(null)
    try {
      const r = await call('game.get', { book: bookId, id: row.id })
      if (r?.ok !== true) { setErr(r?.error ?? '这一局打不开'); return }
      setPlay({ id: row.id, turns: r.turns ?? [], choices: r.choices ?? [], scene: r.scene ?? '', holding: r.holding ?? [], chapter: r.chapter })
    } catch (e) { setErr(humanizeError(e)) }
  }

  useEffect(() => {
    let gone = false
    loadPlays()
    call('novel.get', { id: bookId })
      .then((r) => { if (!gone && r?.ok === true) setChapterList(Array.isArray(r.chapters) ? r.chapters : []) })
      .catch(() => {})
    return () => { gone = true }
  }, [bookId])

  const start = async () => {
    setBusy('start'); setErr(null)
    try {
      const r = await call('game.start', { book: bookId, chapter, preset })
      if (r?.ok !== true) { setErr(r?.error ?? '这一局开不起来'); return }
      setPlay({ id: r.id, turns: r.turns ?? [], choices: r.choices ?? [], scene: '', holding: [], chapter: r.chapter })
      flash?.('开局了')
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy('') }
  }

  const step = async (text) => {
    const said = String(text ?? '').trim()
    if (said === '' || play === null) return
    setBusy('step'); setErr(null)
    try {
      const r = await call('game.say', { book: bookId, id: play.id, move: said })
      if (Array.isArray(r?.turns)) setPlay({ ...play, turns: r.turns, choices: r.choices ?? [] })
      if (r?.ok !== true) { setErr(r?.error ?? '这一步没成'); return }
      setMove('')
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy('') }
  }

  if (play === null) {
    return h('div', { className: 'lc-pad lc-stack' },
      h(Btn, { size: 'sm', icon: 'back', onClick: onBack }, '回书架'),
      h('h3', { style: { margin: '4px 0 0' } }, '挑一个地方进去'),
      h('div', { className: 'lc-meta' }, '从哪一章接着演都行。没有正文也行，它会自己起头。'),
      h('div', { className: 'lc-row', style: { flexWrap: 'wrap', gap: 6 } },
        h(Btn, { size: 'sm', tone: chapter === 0 ? 'primary' : undefined, onClick: () => setChapter(0) }, '从头开始'),
        chapterList.map((c) => h(Btn, {
          key: c.index, size: 'sm', tone: chapter === c.index ? 'primary' : undefined,
          onClick: () => setChapter(c.index),
        }, `第 ${c.index} 章`)),
      ),
      h(PresetBar, { mode: 'game', value: preset, onChange: setPreset }),
      h(Btn, { tone: 'primary', block: true, icon: 'spark', disabled: busy !== '', onClick: start },
        busy === 'start' ? '正在开局…' : '进这一段'),
      plays.length === 0
        ? null
        : h('div', { className: 'lc-stack', style: { gap: 6, marginTop: 10 } },
            h('div', { className: 'lc-fhint' }, `之前玩到一半的 · ${plays.length}`),
            plays.map((row) => h(Btn, {
              key: row.id, block: true, size: 'sm', icon: 'history',
              onClick: () => open(row),
            }, `${String(row.scene ?? '').trim() === '' ? '那一局' : String(row.scene)} · 走了 ${Number(row.turns ?? 0)} 步`)),
          ),
      err === null ? null : h(Note, { tone: 'err', icon: 'warning' }, err),
    )
  }

  const narrations = (play.turns ?? []).filter((t) => t.kind === 'narrate' || t.kind === 'choose')
  return h('div', { className: 'lc-pad lc-stack', style: { gap: 10 } },
    h('div', { className: 'lc-row' },
      h(Btn, { size: 'sm', icon: 'back', onClick: onBack }, '这一局先放着'),
      h('div', { className: 'lc-grow lc-meta' },
        [play.chapter > 0 ? `从第 ${play.chapter} 章进来的` : '从头开的',
         `已经走了 ${(play.turns ?? []).filter((t) => t.kind === 'choose').length} 步`].join(' · ')),
      h(Btn, {
        size: 'sm', icon: 'book',
        disabled: busy !== '' || (play.turns ?? []).length === 0,
        onClick: () => setToOpen(true),
      }, '写成小说的一章'),
    ),
    toOpen === true
      ? h('div', { className: 'lc-sec lc-stack' },
          h('div', { className: 'lc-fhint' }, '这一局会改写成《' + bookId + '》的下一章'),
          h('input', {
            className: 'lc-input', value: toNote, spellCheck: false,
            placeholder: '这一章要往哪走（可以不写）',
            onChange: (e) => setToNote(e.target.value),
          }),
          h('div', { className: 'lc-row' },
            h(Btn, { tone: 'primary', disabled: toBusy, onClick: toChapter }, toBusy ? '写着…' : '写成这一章'),
            h(Btn, { ghost: true, disabled: toBusy, onClick: () => setToOpen(false) }, '先不变'),
          ),
        )
      : null,
    String(play.scene ?? '').trim() === '' ? null : h(Note, { icon: 'book' }, play.scene),
    Array.isArray(play.holding) && play.holding.length > 0
      ? h('div', { className: 'lc-meta' }, `手上的：${play.holding.join('、')}`)
      : null,
    h('div', { className: 'lc-stack', style: { gap: 10 } },
      narrations.map((t, i) => h('div', {
        key: i,
        style: {
          whiteSpace: 'pre-wrap', lineHeight: 1.85, fontSize: 14.5,
          padding: '10px 12px', borderRadius: 10,
          background: t.kind === 'choose' ? 'var(--lc-accent-soft)' : 'var(--lc-panel)',
          border: `1px solid ${t.kind === 'choose' ? 'var(--lc-accent)' : 'var(--lc-line)'}`,
          color: t.kind === 'choose' ? 'var(--lc-accent)' : undefined,
        },
      }, t.kind === 'choose' ? `我：${t.text}${String(t.result ?? '') === '' ? '' : `\n\n${t.result}`}` : String(t.text ?? ''))),
    ),
    (play.choices ?? []).length > 0
      ? h('div', { className: 'lc-stack', style: { gap: 6 } },
          h('div', { className: 'lc-meta' }, '这一步可以走：'),
          (play.choices ?? []).map((c, i) => h(Btn, {
            key: i, block: true, disabled: busy !== '', onClick: () => step(c.text),
          }, `${c.label}. ${c.text}`)),
        )
      : null,
    h('div', { className: 'lc-row' },
      h('input', {
        className: 'lc-input', value: move, spellCheck: false,
        placeholder: '或者自己写一句这一步怎么做',
        onChange: (e) => setMove(e.target.value),
        onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); step(move) } },
      }),
      h(Btn, { tone: 'primary', disabled: busy !== '' || move.trim() === '', onClick: () => step(move) },
        busy === 'step' ? '等一下…' : '走这一步'),
    ),
    err === null ? null : h(Note, { tone: 'err', icon: 'warning' }, err),
    h('div', { className: 'lc-meta' }, '每一步都会存下来，退出再进来还能接着走。'),
  )
}

/**
 * 简历与规划。放在「真实人物记录」那扇门里（写小说和酒馆用不上）。
 *
 * 为什么分成「先把自己写清楚」和「再让 AI 帮忙」两步：
 * 简历这东西最怕 AI 编。先把真实情况填进去，AI 只做整理和措辞，
 * 不编经历——不然投出去被问一句就露了。
 */
function CareerView({ onBack, flash }) {
  const [profile, setProfile] = useState(null)
  const [target, setTarget] = useState('')
  const [goal, setGoal] = useState('')
  const [horizon, setHorizon] = useState('1年')
  const [out, setOut] = useState(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState(null)
  const [dirty, setDirty] = useState(false)

  useEffect(() => {
    let gone = false
    call('career.get', {})
      .then((r) => {
        if (gone) return
        if (r?.ok !== true) { setErr(r?.error ?? '你的简历这一份读不出来'); return }
        setProfile(buildCareerForm(r.profileSections ?? {}))
        setGoal(String(r.plan?.goal ?? ''))
        setHorizon(String(r.plan?.horizon ?? '1年'))
      })
      .catch((e) => { if (!gone) setErr(humanizeError(e)) })
    return () => { gone = true }
  }, [])

  const setField = (key, value) => { setProfile({ ...(profile ?? {}), [key]: value }); setDirty(true) }

  const save = async () => {
    setBusy('save'); setErr(null)
    try {
      const r = await call('career.profile.save', { profile: profile ?? {} })
      if (r?.ok !== true) { setErr(r?.error ?? '没存下来'); return }
      setDirty(false); flash?.('存好了')
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy('') }
  }

  const run = async (kind) => {
    if (dirty) { setErr('简历改过了，先点「存好」再让它做。'); return }
    setBusy(kind); setErr(null); setOut(null)
    try {
      const r = kind === 'resume'
        ? await call('career.resume', { target })
        : kind === 'gap'
          ? await call('career.gap', { target })
          : await call('career.path', { goal, horizon })
      if (r?.ok !== true) { setErr(r?.error ?? '没做成'); return }
      setOut({ kind, text: String(r.text ?? ''), steps: r.steps ?? [] })
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy('') }
  }

  // 先看有没有出错：出错的渲染在下面（要 profile 读出来才轮得到），
  // 所以这里必须自己先把错说出来，否则用户看到的是一辈子转圈。
  if (profile === null) {
    return h('div', { className: 'lc-pad lc-stack' },
      h(Btn, { size: 'sm', icon: 'back', onClick: onBack }, '回首页'),
      err === null
        ? h(Spinner)
        : h('div', { className: 'lc-stack' },
            h(Note, { tone: 'err', icon: 'warning' }, err),
            h(Btn, { block: true, onClick: () => { setErr(null); call('career.get', {}) } }, '再试一次'),
          ),
    )
  }

  const field = (key, label, rows, placeholder) => h('div', { className: 'lc-stack', style: { gap: 6 } },
    h('div', { className: 'lc-fhint' }, label),
    h('textarea', {
      className: 'lc-textarea', rows, value: String(profile[key] ?? ''), placeholder, spellCheck: false,
      onChange: (e) => setField(key, e.target.value),
    }),
  )

  return h('div', { className: 'lc-pad lc-stack', style: { gap: 12 } },
    h('div', { className: 'lc-row' },
      h(Btn, { size: 'sm', icon: 'back', onClick: onBack }, '回首页'),
      h('div', { className: 'lc-grow' }),
      h(Btn, { size: 'sm', tone: dirty ? 'primary' : undefined, icon: 'check', disabled: busy !== '', onClick: save },
        busy === 'save' ? '存着…' : (dirty ? '存好' : '存好了')),
    ),
    h('div', { className: 'lc-meta' }, '先把真事写在这儿。AI 只帮你整理，不会替你编经历。'),

    h('div', { className: 'lc-sec lc-stack' },
      field('基本情况', '基本情况', 3, '哪个学校、什么专业、几年级、现在在哪'),
      field('学过什么', '学过什么（一行一门）', 4, '现代汉语｜能讲清音韵那套\n写作｜能改到能发'),
      field('做过什么', '做过什么（一行一件）', 4, '校刊编辑｜2025 秋｜出了两期\n家教｜2025 夏｜带过一个高三'),
      field('会用哪些工具', '会用哪些工具（一行一个）', 2, 'Word\n剪映'),
      field('想去哪', '想去哪', 3, '公司加岗位，或者学校加专业。写具体一点。'),
      field('还差什么', '你自己觉得还差什么（一行一条）', 3, '六级还没过\n没写过正式的报告'),
    ),

    h('div', { className: 'lc-sec lc-stack' },
      h('div', { className: 'lc-fhint' }, '让 AI 帮忙'),
      h('input', {
        className: 'lc-input', value: target, spellCheck: false,
        placeholder: '要投哪儿：公司加岗位，或者学校加专业',
        onChange: (e) => setTarget(e.target.value),
      }),
      h('div', { className: 'lc-row', style: { flexWrap: 'wrap' } },
        h(Btn, { disabled: busy !== '' || target.trim() === '', onClick: () => run('resume') }, busy === 'resume' ? '写着…' : '照这个写简历'),
        h(Btn, { disabled: busy !== '' || target.trim() === '', onClick: () => run('gap') }, busy === 'gap' ? '算着…' : '看差在哪'),
      ),
      h('div', { className: 'lc-row' },
        h('input', {
          className: 'lc-input', value: goal, spellCheck: false,
          placeholder: '想到哪儿去（一句具体的）',
          onChange: (e) => setGoal(e.target.value),
        }),
        h('select', { className: 'lc-select', value: horizon, onChange: (e) => setHorizon(e.target.value), style: { maxWidth: 110 } },
          ['3个月', '1年', '4年'].map((x) => h('option', { key: x, value: x }, x))),
      ),
      h(Btn, { block: true, disabled: busy !== '' || goal.trim() === '', onClick: () => run('path') },
        busy === 'path' ? '规划着…' : '规划怎么走'),
    ),

    err === null ? null : h(Note, { tone: 'err', icon: 'warning' }, err),
    out === null ? null : h('div', { className: 'lc-sec lc-stack' },
      h('div', { className: 'lc-row' },
        h('div', { className: 'lc-grow lc-fhint' },
          out.kind === 'resume' ? '写好的简历' : out.kind === 'gap' ? '差在哪' : '怎么走'),
        h(Btn, { size: 'sm', icon: 'download', onClick: () => copyText(out.text) }, '复制'),
      ),
      h('div', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.8, fontSize: 14.5 } }, out.text),
      out.steps.length === 0 ? null : h('div', { className: 'lc-meta' }, `认出 ${out.steps.length} 步`),
    ),
  )
}

/** 把后端读出来的小节拍平成表单能直接用的字段。 */
function buildCareerForm(sections) {
  const pick = (key) => {
    const v = sections?.[key]
    if (Array.isArray(v)) return v.join('\n')
    return String(v ?? '')
  }
  return {
    基本情况: pick('基本情况'),
    学过什么: pick('学过什么'),
    做过什么: pick('做过什么'),
    会用哪些工具: pick('会用哪些工具'),
    想去哪: pick('想去哪'),
    还差什么: pick('还差什么'),
  }
}

/** 复制到剪贴板；不支持就退回「选中让用户自己复制」。 */
function copyText(text) {
  const value = String(text ?? '')
  if (typeof navigator !== 'undefined' && navigator?.clipboard?.writeText !== undefined) {
    navigator.clipboard.writeText(value).catch(() => {})
    return
  }
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const box = document.createElement('textarea')
    box.value = value
    document.body.appendChild(box)
    box.select()
    try { document.execCommand('copy') } catch { /* 复制不了就算了 */ }
    document.body.removeChild(box)
  }
}

function BookView({ bookId, onBack, flash }) {
  const [book, setBook] = useState(null)
  const [outline, setOutline] = useState(null)
  const [chapterIndex, setChapterIndex] = useState(0)
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(null)
  const [review, setReview] = useState(null)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState(null)
  const [ask, setAsk] = useState('')
  const [editingOutline, setEditingOutline] = useState(false)
  const [outlineText, setOutlineText] = useState('')
  // 这一章的正文有没有还没存下的改动。切章之前必须先处理，否则写的东西会没。
  const [bodyDirty, setBodyDirty] = useState(false)

  const load = async (want) => {
    setErr(null)
    try {
      const r = await call('novel.get', { id: bookId })
      if (r?.ok !== true) { setErr(r?.error ?? '这本书打不开'); return }
      setBook(r)
      const o = await call('novel.outline.get', { id: bookId })
      if (o?.ok === true) { setOutline(o); setOutlineText(String(o.text ?? '')) }
      // 默认打开：有章节就打开最后一章，没有就从第一章开始
      const target = Number(want) > 0 ? Number(want) : (r.chapters.length === 0 ? 1 : r.chapters[r.chapters.length - 1].index)
      setChapterIndex(target)
      await openChapter(target)
    } catch (e) { setErr(humanizeError(e)) }
  }

  const openChapter = async (index) => {
    setErr(null); setReview(null); setDraft(null)
    try {
      const r = await call('novel.chapter.get', { id: bookId, index })
      setBody(r?.ok === true ? String(r.body ?? '') : '')
    } catch (e) { setErr(humanizeError(e)) }
  }

  // 切章之前先把没存的正文收好。存不上就留在这一章，别让人以为写进去了。
  const keepBody = async () => {
    if (bodyDirty !== true) return true
    if (body.trim() === '') { setBodyDirty(false); return true }
    try {
      const r = await call('novel.chapter.save', { id: bookId, index: chapterIndex, body })
      if (r?.ok !== true) { setErr(r?.error ?? '这一章没存上，先别走'); return false }
      setBodyDirty(false)
      return true
    } catch (e) { setErr(humanizeError(e)); return false }
  }

  const goChapter = async (index) => {
    if ((await keepBody()) !== true) return
    setChapterIndex(index)
    await openChapter(index)
  }

  useEffect(() => { load(0) }, [bookId])

  const doPlan = async () => {
    setBusy('plan'); setErr(null)
    try {
      const r = await call('novel.outline.draft', { id: bookId, chapters: 12 })
      if (r?.ok !== true) { setErr(r?.error ?? '这次没想出大纲'); return }
      setOutline(r); setOutlineText(String(r.text ?? ''))
      flash?.('大纲想好了，你可以直接改')
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy('') }
  }

  const saveOutline = async () => {
    setBusy('outline'); setErr(null)
    try {
      const r = await call('novel.outline.save', { id: bookId, text: outlineText })
      if (r?.ok !== true) { setErr(r?.error ?? '大纲没存上'); return }
      // 只取存盘结果里跟大纲正文有关的那几样。服务端回的 chapters 是「几条」这个数字，
      // 整包铺出去会把本地那份逐章列表盖掉，下一屏渲染就会拿数字去 find。
      setOutline({
        ok: true,
        path: r.path,
        text: outlineText,
        theme: r.theme,
        ending: r.ending,
        chapters: Array.isArray(outline?.chapters) ? outline.chapters : [],
      })
      setEditingOutline(false)
      flash?.('大纲存好了')
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy('') }
  }

  const doWrite = async () => {
    setBusy('write'); setErr(null); setReview(null)
    try {
      const r = await call('novel.chapter.draft', { id: bookId, index: chapterIndex, ask })
      if (r?.ok !== true) { setErr(r?.error ?? '这次没写出来'); return }
      setDraft(String(r.draft ?? ''))
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy('') }
  }

  const acceptDraft = async () => {
    if (draft === null) return
    setBusy('save'); setErr(null)
    try {
      const merged = body.trim() === '' ? draft : `${body.trim()}\n\n${draft}`
      const r = await call('novel.chapter.save', { id: bookId, index: chapterIndex, body: merged })
      if (r?.ok !== true) { setErr(r?.error ?? '没存上'); return }
      setBody(merged); setDraft(null); setBodyDirty(false)
      flash?.(`第 ${chapterIndex} 章存好了`)
      await load(chapterIndex)
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy('') }
  }

  const saveBody = async () => {
    setBusy('save'); setErr(null)
    try {
      const r = await call('novel.chapter.save', { id: bookId, index: chapterIndex, body })
      if (r?.ok !== true) { setErr(r?.error ?? '没存上'); return }
      setBodyDirty(false)
      flash?.(`第 ${chapterIndex} 章存好了`)
      await load(chapterIndex)
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy('') }
  }

  const doReview = async () => {
    // 挑毛病看的是存下来的那一版，所以正文有没存的改动就先存一次，
    // 否则你会以为它评的是刚写的那段。
    if ((await keepBody()) !== true) return
    setBusy('review'); setErr(null)
    try {
      const r = await call('novel.chapter.review', { id: bookId, index: chapterIndex })
      if (r?.ok !== true) { setErr(r?.error ?? '这次没审成'); return }
      setReview(String(r.review ?? ''))
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy('') }
  }

  if (book === null) {
    return h('div', { className: 'lc-pad lc-stack' },
      h(Btn, { size: 'sm', icon: 'back', onClick: onBack }, '回书架'),
      err === null ? h(Spinner) : h(Note, { tone: 'err', icon: 'warning' }, err),
    )
  }

  const chapters = Array.isArray(book.chapters) ? book.chapters : []
  const plan = outline?.ok === true && Array.isArray(outline.chapters) ? outline.chapters : []
  const planItem = plan.find((c) => c.index === chapterIndex)
  const title = String(book.data?.title ?? bookId)

  return h('div', { className: 'lc-pad lc-stack', style: { gap: 12 } },
    h('div', { className: 'lc-row' },
      h(Btn, { size: 'sm', icon: 'back', onClick: async () => { if ((await keepBody()) === true) onBack() } }, '回书架'),
      h('div', { className: 'lc-grow lc-ellipsis', style: { fontWeight: 700, fontSize: 16.5 } }, `《${title}》`),
      h('span', { className: 'lc-meta' }, `${chapters.length} 章`),
    ),
    String(book.idea ?? '').trim() === '' ? null : h('div', { className: 'lc-meta', style: { lineHeight: 1.7 } }, String(book.idea).trim()),

    // ── 第一段：规划 ──
    h('div', { className: 'lc-sec' },
      h('div', { className: 'lc-row' },
        h('div', { className: 'lc-grow' }, h('span', { style: { fontWeight: 650 } }, '① 先想清楚这本书怎么走')),
        h(Btn, { size: 'sm', tone: 'import', icon: 'spark', disabled: busy !== '', onClick: doPlan },
          busy === 'plan' ? '正在想…' : (plan.length === 0 ? '让 AI 想大纲' : '重新想一版')),
        plan.length === 0 ? null : h(Btn, { size: 'sm', ghost: true, icon: 'edit', onClick: () => setEditingOutline(!editingOutline) },
          editingOutline ? '收起' : '自己改'),
      ),
      plan.length === 0
        ? h('div', { className: 'lc-meta', style: { marginTop: 6, lineHeight: 1.7 } },
            '先让它把整本书的骨架搭出来：主线、每章要发生什么、结局。',
            h('br'),
            '搭完你能直接改——改一行，后面写出来的东西就跟着变。')
        : h('div', { className: 'lc-stack', style: { marginTop: 6 } },
            outline.theme === '' ? null : h('div', { className: 'lc-meta' }, `主线：${outline.theme}`),
            h('div', { className: 'lc-stack', style: { gap: 2 } }, plan.map((c) => h('div', {
              key: c.index,
              className: 'lc-meta',
              style: {
                padding: '3px 6px', borderRadius: 6, cursor: 'pointer', lineHeight: 1.6,
                background: c.index === chapterIndex ? 'var(--lc-accent-soft)' : 'transparent',
                color: c.index === chapterIndex ? 'var(--lc-accent)' : undefined,
              },
              onClick: () => { goChapter(c.index) },
            }, `第 ${c.index} 章 · ${c.plan}`))),
            outline.ending === '' ? null : h('div', { className: 'lc-meta' }, `结局：${outline.ending}`),
          ),
      editingOutline
        ? h('div', { className: 'lc-stack', style: { marginTop: 6 } },
            h('textarea', {
              className: 'lc-textarea', value: outlineText, style: { minHeight: 180 },
              onChange: (e) => setOutlineText(e.target.value), spellCheck: false,
            }),
            h('div', { className: 'lc-row' },
              h(Btn, { size: 'sm', tone: 'primary', icon: 'check', disabled: busy !== '', onClick: saveOutline }, busy === 'outline' ? '正在存…' : '存好'),
              h('div', { className: 'lc-meta' }, '每行一章，写清这一章要发生什么。'),
            ),
          )
        : null,
    ),

    // ── 第二段：写这一章 ──
    h('div', { className: 'lc-sec' },
      h('div', { className: 'lc-row' },
        h('div', { className: 'lc-grow' }, h('span', { style: { fontWeight: 650 } }, `② 写第 ${chapterIndex} 章`)),
        h(Btn, { size: 'sm', tone: 'analyze', icon: 'spark', disabled: busy !== '', onClick: doWrite },
          busy === 'write' ? '正在写…' : '让 AI 写这一章'),
      ),
      planItem === undefined
        ? h('div', { className: 'lc-meta', style: { marginTop: 4 } }, '大纲里还没有这一章。先让 AI 想一版大纲，或者直接写也行。')
        : h('div', { className: 'lc-meta', style: { marginTop: 4, lineHeight: 1.6 } }, `这一章要写：${planItem.plan}`),
      h('div', { className: 'lc-row', style: { marginTop: 6 } },
        h('input', {
          className: 'lc-input', value: ask, spellCheck: false,
          placeholder: '（可选）这一章你想强调什么？比如「写他们吵架那场」',
          onChange: (e) => setAsk(e.target.value),
        }),
      ),
      draft === null
        ? null
        : h('div', { className: 'lc-stack', style: { marginTop: 8 } },
            h(Note, { tone: 'ok', icon: 'spark' }, '写好了。看一眼，满意就收下，不满意可以不收。'),
            h('div', {
              style: {
                whiteSpace: 'pre-wrap', lineHeight: 1.85, fontSize: 14.5,
                padding: '10px 12px', borderRadius: 10,
                background: 'var(--lc-analyze-soft)', border: '1px solid var(--lc-analyze)',
              },
            }, draft),
            h('div', { className: 'lc-row' },
              h(Btn, { size: 'sm', tone: 'primary', icon: 'check', disabled: busy !== '', onClick: acceptDraft },
                busy === 'save' ? '正在存…' : '收下，写进这一章'),
              h(Btn, { size: 'sm', ghost: true, icon: 'trash', disabled: busy !== '', onClick: () => setDraft(null) }, '不要这段'),
            ),
          ),
    ),

    // ── 正文 ──
    h('div', { className: 'lc-sec' },
      h('div', { className: 'lc-row' },
        h('div', { className: 'lc-grow' }, h('span', { style: { fontWeight: 650 } }, '正文')),
        h('span', { className: 'lc-meta' }, `${body.length} 字`),
      ),
      h('textarea', {
        className: 'lc-textarea',
        value: body,
        spellCheck: false,
        placeholder: '这一章还空着。让 AI 写一段，或者自己动手。',
        style: { minHeight: 260, marginTop: 6, lineHeight: 1.85 },
        onChange: (e) => { setBody(e.target.value); setBodyDirty(true) },
      }),
      h('div', { className: 'lc-row' },
        h(Btn, { size: 'sm', tone: 'primary', icon: 'check', disabled: busy !== '', onClick: saveBody }, busy === 'save' ? '正在存…' : '存好这一章'),
        h(Btn, { size: 'sm', icon: 'doctor', disabled: busy !== '' || body.trim() === '', onClick: doReview },
          busy === 'review' ? '正在挑毛病…' : '挑挑毛病'),
        h('div', { className: 'lc-grow' }),
        h(Btn, { size: 'sm', ghost: true, icon: 'plus', onClick: async () => {
          const next = chapterIndex + 1
          await goChapter(next)
        } }, `写第 ${chapterIndex + 1} 章`),
      ),
      review === null
        ? null
        : h('div', { className: 'lc-stack', style: { marginTop: 8 } },
            h(Note, { tone: 'warn', icon: 'warning' }, '它挑出来的问题（不是夸奖，也不用全听）'),
            h('div', { style: { whiteSpace: 'pre-wrap', lineHeight: 1.8, fontSize: 14 } }, review),
          ),
    ),

    err === null ? null : h(Note, { tone: 'err', icon: 'warning' }, err),
  )
}

function TavernView({ chat, onChat, onBack, flash }) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // 「到这儿为止」那段备忘。它存在会话文件里，跟着 chat 一起下发。
  const [notes, setNotes] = useState(Array.isArray(chat?.notes) ? chat.notes : [])
  const scrollRef = useRef(null)
  // 「把这一场变成小说的一章」。这几个 state 特意放在所有 hook 之后：
  // 上面那几个槽位有测试按号码摆状态，插在中间会让它们全体错位。
  const [toOpen, setToOpen] = useState(false)
  const [toBooks, setToBooks] = useState([])
  const [toBook, setToBook] = useState('')
  const [toBusy, setToBusy] = useState(false)
  const [toNote, setToNote] = useState('')
  // 「挑几句写进卡里」。同样排在最后。
  const [exBusy, setExBusy] = useState(false)
  const [exNote, setExNote] = useState('')
  const turns = Array.isArray(chat?.turns) ? chat.turns : []
  const rawName = String(chat?.card_name ?? '').trim()
  const name = rawName === '' ? 'TA' : rawName
  const me = '我'
  const memoryNote = notes.find((n) => String(n?.title ?? '').trim() === '到这儿为止')
  const memoryText = memoryNote === undefined ? '' : String(memoryNote.body ?? '').trim()

  const say = async (text) => {
    if (busy || chat?.id === undefined) return
    setBusy(true)
    setErr(null)
    try {
      const r = await call('tavern.say', { id: chat.id, text })
      // 后台说 ok:false 时，它可能已经把「我」那句存下来了——turns 里有就照着画，
      // 不然用户会以为自己那句话没发出去、再打一遍，最后文件里出现两份。
      if (Array.isArray(r?.turns)) onChat({ ...chat, turns: r.turns })
      if (r?.ok !== true) { setErr(r?.error ?? 'TA 没接上话，过一会儿再试一次'); return }
      setDraft('')
    } catch (e) {
      setErr(humanizeError(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 把前面那些收一收。
   *
   * 说得久了只能带最近二十来轮给模型，再往前它就记不住了。让 TA 用几句
   * 话把「到这儿为止」记下来存进会话文件，之后每轮都带上——这不是什么
   * 高深功能，就是让它在第一千句的时候还记得第三句发生过什么。
   */
  const summarize = async () => {
    if (busy || chat?.id === undefined) return
    setBusy(true)
    setErr(null)
    try {
      const r = await call('tavern.summarize', { id: chat.id })
      if (r?.ok !== true) { setErr(r?.error ?? '这次没收成，过一会儿再试一次'); return }
      const next = Array.isArray(r.notes) ? r.notes : []
      setNotes(next)
      onChat({ ...chat, turns: Array.isArray(r.turns) ? r.turns : chat.turns, notes: next })
    } catch (e) {
      setErr(humanizeError(e))
    } finally {
      setBusy(false)
    }
  }

  // 打开「变成小说的一章」时先问一次有哪些书。以前没有这条路，
  // 酒馆里演得好的一场只能靠人手动复制粘贴进小说。
  /**
   * 把这一场里最能代表 TA 的几句话写回那张卡的「对话示例」。
   *
   * 「性格：沉默寡言」这种话模型只能猜；「他说话只答半句，句尾带个『呗』」
   * 是能直接照做的。演着演着发现 TA 说话的样子比卡上写的准，就该固化下来。
   */
  const toExample = async () => {
    if (exBusy || chat?.id === undefined) return
    setExBusy(true); setExNote('')
    try {
      const r = await call('tavern.toExample', { id: chat.id })
      if (r?.ok !== true) { setExNote(r?.error ?? '这次没挑出来'); return }
      const picked = Array.isArray(r.picked) ? r.picked : []
      setExNote(`写进卡里了，这次挑的是：${picked.map((x) => `「${x}」`).join('、')}`)
      flash?.('卡上的「对话示例」又厚了一点')
    } catch (e) {
      setExNote(humanizeError(e))
    } finally {
      setExBusy(false)
    }
  }

  const openToChapter = async () => {
    setToOpen(true); setToBusy(true); setErr(null)
    try {
      const r = await call('novel.books', {})
      if (r?.ok !== true) { setErr(r?.error ?? '看不到书架'); return }
      const list = Array.isArray(r.books) ? r.books : []
      setToBooks(list)
      setToBook(toBook !== '' ? toBook : String(list[0]?.id ?? ''))
    } catch (e) { setErr(humanizeError(e)) } finally { setToBusy(false) }
  }

  const toChapter = async () => {
    if (toBook === '') { setErr('还没有书。先回「写小说」那扇门建一本。'); return }
    setToBusy(true); setErr(null)
    try {
      const r = await call('tavern.toChapter', { id: chat?.id, book: toBook, note: toNote })
      if (r?.ok !== true) { setErr(r?.error ?? '没改成'); return }
      setToOpen(false); setToNote('')
      if (typeof flash === 'function') flash(`写成了第 ${r.chapter ?? '?'} 章`)
    } catch (e) { setErr(humanizeError(e)) } finally { setToBusy(false) }
  }

  const remove = async () => {
    if (chat?.id === undefined) return
    setBusy(true)
    setErr(null)
    try {
      const r = await call('tavern.delete', { id: chat.id })
      if (r?.ok !== true) { setErr(r?.error ?? '这一场没能删掉'); return }
      onBack()
    } catch (e) {
      setErr(humanizeError(e))
    } finally {
      setBusy(false)
    }
  }

  const bubble = (turn, index) => {
    const mine = turn.who === me
    return h('div', {
      key: `${index}-${turn.who}`,
      style: {
        display: 'flex',
        justifyContent: mine ? 'flex-end' : 'flex-start',
        gap: 6,
      },
    },
      h('div', {
        style: {
          maxWidth: '82%',
          background: mine ? 'var(--lc-accent-soft)' : 'var(--lc-interview-soft)',
          border: '1px solid var(--lc-line)',
          borderRadius: 10,
          padding: '7px 10px',
          whiteSpace: 'pre-wrap',
          lineHeight: 1.65,
          fontSize: 15,
        },
      },
        h('div', { className: 'lc-meta', style: { marginBottom: 2, fontSize: 12 } }, turn.who),
        turn.text,
      ),
    )
  }

  return h('div', { className: 'lc-pad lc-stack', style: { gap: 10 } },
    h('div', { className: 'lc-row' },
      h(Btn, { size: 'sm', icon: 'back', onClick: onBack, disabled: busy }, '回去'),
      h('div', { className: 'lc-grow lc-ellipsis', style: { fontWeight: 650 } }, `和「${name}」在演`),
      h('span', { className: 'lc-meta' }, `${turns.length} 句`),
    ),
    turns.length === 0
      ? h(Note, { icon: 'chat' }, `这张卡没写开场白。点「让 ${name} 先说」，或者你先开口都行。`)
      : null,
    h('div', {
      ref: scrollRef,
      className: 'lc-stack',
      style: { gap: 7, maxHeight: '52vh', overflowY: 'auto', padding: '2px 1px' },
    }, turns.map(bubble)),
    memoryText === '' ? null : h(Note, { icon: 'book' },
      h('div', { style: { fontWeight: 650, marginBottom: 3 } }, '前面这些已经收好了'),
      h('div', { style: { whiteSpace: 'pre-wrap' } }, memoryText),
    ),
    err === null ? null : h(Note, { tone: 'err', icon: 'warning' }, err),
    h('textarea', {
      className: 'lc-textarea',
      rows: 3,
      value: draft,
      placeholder: `你要和「${name}」说什么…`,
      spellCheck: false,
      onChange: (e) => setDraft(e.target.value),
      onKeyDown: (e) => {
        // 回车就发，Shift+回车换行——这是所有聊天窗口的习惯，
        // 不这样用户会一直按回车，然后发现换行了一堆。
        if (e.key === 'Enter' && e.shiftKey !== true) {
          e.preventDefault?.()
          say(draft.trim())
        }
      },
    }),
    h('div', { className: 'lc-row' },
      h(Btn, {
        tone: 'primary', size: 'sm', icon: 'send',
        disabled: busy || draft.trim() === '',
        onClick: () => say(draft.trim()),
      }, busy ? '等一下…' : '说这句'),
      h(Btn, {
        size: 'sm', tone: 'interview', icon: 'chat',
        disabled: busy,
        onClick: () => say(''),
        title: `让「${name}」自己往下说`,
      }, `让 ${name} 先说`),
      h('div', { className: 'lc-grow' }),
      h(Btn, {
        size: 'sm', tone: 'analyze', icon: 'history',
        disabled: busy,
        onClick: summarize,
        title: '把前面发生过的事记成几句，之后每轮都带上',
      }, '收个尾'),
      h(Btn, { size: 'sm', icon: 'book', disabled: busy || turns.length === 0, onClick: openToChapter, title: '把这一场改写成某本小说的一章' }, '变成小说的一章'),
      h(Btn, { size: 'sm', icon: 'chat', disabled: busy || exBusy || turns.length === 0, onClick: toExample, title: '挑几句 TA 说过的话，写进那张卡的「对话示例」' }, exBusy ? '正在挑…' : '挑几句进卡里'),
      h(Btn, { size: 'sm', ghost: true, icon: 'trash', disabled: busy, onClick: () => setConfirmDelete(true) }, '这一场不要了'),
    ),
    toOpen === true
      ? h('div', { className: 'lc-sec lc-stack' },
          h('div', { className: 'lc-fhint' }, '挑一本书，这一场会改写成它的下一章'),
          toBusy && toBooks.length === 0
            ? h(Spinner)
            : toBooks.length === 0
              ? h('div', { className: 'lc-meta' }, '还没有书。先去「写小说」那扇门建一本，再回来。')
              : h('div', { className: 'lc-stack' },
                  h('div', { className: 'lc-chips' }, toBooks.map((b) => h(Btn, {
                    key: b.id,
                    size: 'sm',
                    tone: toBook === b.id ? 'primary' : undefined,
                    onClick: () => setToBook(b.id),
                  }, String(b.title ?? b.id)))),
                  h('input', {
                    className: 'lc-input', value: toNote, spellCheck: false,
                    placeholder: '这一章要往哪走（可以不写）',
                    onChange: (e) => setToNote(e.target.value),
                  }),
                  h('div', { className: 'lc-row' },
                    h(Btn, { tone: 'primary', disabled: toBusy || toBook === '', onClick: toChapter }, toBusy ? '写着…' : '写成这一章'),
                    h(Btn, { ghost: true, disabled: toBusy, onClick: () => setToOpen(false) }, '先不变'),
                  ),
                ),
        )
      : null,
    confirmDelete === true
      ? h('div', { className: 'lc-row' },
          h('span', { className: 'lc-meta', className: 'lc-meta' }, '这一场的记录会删掉，删了就找不回来了。'),
          h(Btn, { size: 'sm', tone: 'danger', onClick: remove, disabled: busy }, '确定删'),
          h(Btn, { size: 'sm', ghost: true, onClick: () => setConfirmDelete(false), disabled: busy }, '先不删'),
        )
      : null,
    exNote === '' ? null : h(Note, { tone: 'ok', icon: 'check' }, exNote),
    h('div', { className: 'lc-meta' }, '每说一句都会存进「chats」里，退出再进来还能接着说。'),
  )
}

function CardView({ card, onRefresh, proposal, setProposal, flash, onDeleted, onInterview, onAnalyze, worlds, onOpenWorld, onTavern, initialEditing }) {
  const [editing, setEditing] = useState(initialEditing === true)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState(null)
  const [showExport, setShowExport] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  // 这张卡是不是「从记忆里认出来的、还缺东西」。缺东西的时候，
  // 名字旁边挂一个红色感叹号——不点开也知道这张还没写完。
  const [memFlag, setMemFlag] = useState(null)

  const data = card?.data ?? {}
  const sections = card?.sections ?? []
  const cov = card?.coverage
  const issues = card?.validation?.issues ?? []

  useEffect(() => { setEditing(false) }, [card?.path])

  useEffect(() => {
    let alive = true
    // 先清掉上一张卡的标：换到别人的卡上，新请求回来之前还挂着「！还缺 3 样」，
    // 看着像是在说这张卡缺东西。
    setMemFlag(null)
    if (card?.path === undefined || card?.path === '') { return () => { alive = false } }
    call('card.memoryStatus', { path: card.path }).then((r) => {
      if (alive === true && r.ok === true && r.flag === true) setMemFlag(r)
      else if (alive === true) setMemFlag(null)
    }).catch(() => { if (alive === true) setMemFlag(null) })
    return () => { alive = false }
  }, [card?.path])

  const exportPng = async () => {
    setBusy('png'); setErr(null)
    try {
      const r = await call('export.card', { path: card.path })
      if (r.ok !== true) { setErr(r.error ?? '导出没成功'); return }
      downloadBase64(r.base64, r.filename, 'image/png')
      flash(r.consistent === false ? '导出好了，但内容对不上，请把这个问题告诉我' : '导出好了，可以拿去用了', r.consistent === false ? 'warn' : 'ok')
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy('') }
  }

  const exportJson = async () => {
    setBusy('json'); setErr(null)
    try {
      const r = await call('export.json', { path: card.path })
      if (r.ok !== true) { setErr(r.error ?? '导出没成功'); return }
      downloadText(JSON.stringify(r.json, null, 2), r.filename)
      flash('导出好了')
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy('') }
  }

  const remove = async () => {
    const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm(`确定删掉「${data.name}」吗？\n\n删掉之后，导出和 AI 都不会再看到它，界面上也收不回来。`)
      : true
    if (!ok) return
    setBusy('del'); setErr(null)
    try {
      const r = await call('card.delete', { path: card.path, reason: '用户删除' })
      if (r.ok !== true) { setErr(r.error ?? '没删掉'); return }
      flash('删掉了')
      onDeleted()
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy('') }
  }

  if (editing) {
    return h(CardForm, {
      card: { ...card, avatar: card?.avatar ?? null },
      worlds: worlds ?? [],
      onCancel: () => setEditing(false),
      onSaved: async () => { setEditing(false); await onRefresh(); flash('存好了') },
    })
  }

  const relationTypeId = (card?.relationIdHint ?? null)
  const shownSections = sections.filter((s) => String(s.body ?? '').trim() !== '')

  return h('div', { className: 'lc-pad lc-stack' },
    err === null ? null : h(Err, { text: err }),

    proposal !== null
      ? h(ProposalPanel, { proposal, onClose: () => setProposal(null), onApplied: async (r) => {
          setProposal(null)
          await onRefresh()
          if (r?.dismissed === true) { flash('这份不要了，已经不在待办里', 'ok'); return }
          const n = r?.applied ?? 0
          flash(n === 0 ? '这些卡里本来就有，没有重复写' : `写进卡里 ${n} 条`, n === 0 ? 'warn' : 'ok')
        } })
      : null,

    h('div', { className: 'lc-row' },
      h(Avatar, { name: data.name, kind: data.kind, big: true, photo: card?.avatar ?? null }),
      h('div', { className: 'lc-grow' },
        h('div', { style: { fontWeight: 650, fontSize: 16.5, display: 'flex', alignItems: 'center', gap: 6 } },
          h('span', null, data.name ?? '(还没起名字)'),
          // 红点：这条是从记忆里认出来的，记忆里只写了半句。
          // 文案只说「还缺什么」，不解释「记忆」是什么——那是别的软件的事。
          memFlag === null
            ? null
            : h('span', {
                className: 'lc-tag err',
                title: `这条还不全，还缺：${memFlag.missing.join('、')}`,
                style: { cursor: 'help' },
              }, `！还缺 ${memFlag.missing.length} 样`),
        ),
        h('div', { className: 'lc-meta' }, [KIND_LABEL[data.kind] ?? data.kind, data.relation, data.address].filter(Boolean).join(' · ')),
        // 属于某本世界书时给一条能点回去的路。只显示名字，不显示磁盘上的
        // 那串 id——人不需要知道文件夹叫什么。
        bookOf(data, worlds) === null
          ? null
          : h('button', {
              className: 'lc-btn ghost sm', type: 'button',
              style: { padding: '2px 0', height: 'auto' },
              onClick: () => onOpenWorld?.(bookOf(data, worlds)),
            }, h(Icon, { name: 'book', size: 12 }), ` ${bookOf(data, worlds).name ?? bookOf(data, worlds).id}`),
      ),
    ),

    memFlag === null
      ? null
      : h('div', { className: 'lc-meta' }, `这条是从你写过的记忆里认出来的，当时只记了半句。还差：${memFlag.missing.join('、')}。点「接着聊」就会专门问这几样。`),

    cov === undefined ? null : h('div', null,
      h('div', { className: 'lc-row' },
        h('span', { className: 'lc-label', style: { fontSize: 13.5, color: 'var(--lc-muted)', fontWeight: 600 } }, '写完了多少'),
        h('span', { className: 'lc-grow' }),
        h('span', { className: 'lc-meta' }, `${cov.percent}%`),
      ),
      h('div', { style: { marginTop: 3 } }, h(Bar, { value: cov.percent })),
      cov.empty.length > 0
        ? h('div', { className: 'lc-meta', style: { marginTop: 4 } }, '还空着：', cov.empty.map((e) => e.label).join('、'))
        : null,
    ),

    // 主操作：三个指向明确的按钮
    h('div', { className: 'lc-row', style: { marginTop: 2 } },
      h(Btn, { tone: 'primary', icon: 'pencil', onClick: () => setEditing(true) }, '改这张卡'),
      h(Btn, { tone: 'interview', icon: 'chat', onClick: () => onInterview(buildPreset(data)) }, '接着聊'),
      onTavern === undefined ? null : h(Btn, { tone: 'analyze', icon: 'mic', onClick: () => onTavern(buildPreset(data)) }, '和 TA 演一段'),
      h(Btn, { tone: 'analyze', size: 'sm', icon: 'spark', onClick: onAnalyze }, '读材料'),
    ),

    cov !== undefined && cov.empty.length > 0
      ? h('div', { className: 'lc-meta' }, '「接着聊」会专门问还空着的那几样。')
      : null,

    issues.length > 0
      ? h('div', { className: 'lc-stack' }, issues.map((i, n) => h(Note, { key: n, tone: i.level === 'error' ? 'err' : 'warn', icon: 'warning' },
          humanizeIssue(i))))
      : null,

    h('div', { className: 'lc-sep' }),

    shownSections.length === 0
      ? h('div', { className: 'lc-meta' }, '还什么都没写。点上面的「改这张卡」，从「他是什么样的人」开始写起。')
      : h('div', { className: 'lc-stack' }, shownSections.map((s) => h('div', { key: s.title, className: 'lc-sec' },
          h('div', { className: 'st' }, s.title),
          h('div', { className: 'sb' }, s.body),
        ))),

    // 结构化的小字段，用人话展示
    renderFacts(data),

    // 导出
    h('div', { className: 'lc-sep' }),
    h('div', { className: 'lc-row' },
      h(Btn, { size: 'sm', icon: 'download', onClick: exportPng, disabled: busy !== '', title: '存成一个图片文件，可以直接放进酒馆' }, '导出角色卡'),
      h(Btn, { size: 'sm', tone: 'ghost', icon: 'list', onClick: () => setShowExport(!showExport) }, '其他格式'),
      h(Btn, { size: 'sm', tone: 'ghost', icon: 'history', onClick: () => setShowHistory(!showHistory) }, '以前的样子'),
      h('div', { className: 'lc-grow' }),
      h(Btn, { size: 'sm', tone: 'danger', icon: 'trash', onClick: remove, disabled: busy !== '' }, '删掉'),
    ),
    showExport === true
      ? h('div', { className: 'lc-stack' },
          h(Btn, { size: 'sm', onClick: exportJson, disabled: busy !== '' }, '存成数据文件'),
          h('div', { className: 'lc-meta' }, '一般来说用不上。别人要原始数据的时候才需要。'),
        )
      : null,
    showHistory === true
      ? h(HistoryPanel, {
          card,
          onClose: () => setShowHistory(false),
          onRestored: async () => { setShowHistory(false); await onRefresh(); flash('退回上一版了') },
        })
      : null,
  )
}

/** 从卡上现有的东西，猜出访谈该按哪类关系问。 */
function buildPreset(data) {
  return {
    id: data?.id,
    name: data?.name,
    relationLabel: data?.relation,
  }
}

/**
 * 从卡上找出自带的小设定（世界书条目）。
 *
 * 位置要从导入流程的写法来：CC 卡的 character_book 被 codec 原样放进
 * data.cc.fields.character_book。早先只看 data.lorebook 的话永远读不到。
 */
function findBook(data) {
  const entries = data?.cc?.fields?.character_book?.entries
  if (Array.isArray(entries)) return entries
  const direct = data?.lorebook?.entries
  if (Array.isArray(direct)) return direct
  return []
}

/** 这张卡归哪本世界书。找不到就返回 null——不要假装它是 reality。 */
function bookOf(data, worlds) {
  const id = String(data?.world ?? '').trim()
  if (id === '' || id === REALITY) return null
  return (Array.isArray(worlds) ? worlds : []).find((w) => String(w.id) === id) ?? null
}

/** 把小字段（能力、禁忌、知道什么）用人话列出来。 */
function renderFacts(data) {
  const rows = []
  const competencies = asArray(data?.competency).filter((c) => c !== null && typeof c === 'object' && (c.key ?? c.label) !== undefined)
  if (competencies.length > 0) {
    rows.push(h('div', { key: 'c', className: 'lc-sec' },
      h('div', { className: 'st' }, '会什么'),
      h('div', { className: 'lc-stack' }, competencies.map((c, n) => h('div', { key: n, className: 'lc-row' },
        h('span', { className: 'lc-grow' }, String(c.key ?? c.label)),
        c.level === undefined ? null : h(Tag, null, String(c.level)),
      ))),
    ))
  }
  const taboos = asArray(data?.taboos).map((t) => (typeof t === 'string' ? t : t?.label ?? t?.key)).filter((t) => typeof t === 'string' && t !== '')
  if (taboos.length > 0) {
    rows.push(h('div', { key: 't', className: 'lc-sec' },
      h('div', { className: 'st' }, '不要跟他提'),
      h('div', { className: 'lc-wrap' }, taboos.map((t, n) => h('span', { key: n, className: 'lc-tag warn' }, t))),
    ))
  }
  const knowledge = asArray(data?.knowledge).map((k) => (typeof k === 'string' ? k : k?.label ?? k?.key)).filter((k) => typeof k === 'string' && k !== '')
  if (knowledge.length > 0) {
    rows.push(h('div', { key: 'k', className: 'lc-sec' },
      h('div', { className: 'st' }, '他知道的事'),
      h('div', { className: 'lc-wrap' }, knowledge.map((t, n) => h('span', { key: n, className: 'lc-tag' }, t))),
    ))
  }
  if (data?.consent !== undefined && data?.consent !== null) {
    const basis = typeof data.consent === 'object' ? data.consent.basis : data.consent
    rows.push(h('div', { key: 'cons', className: 'lc-sec' },
      h('div', { className: 'st' }, '对方知道吗'),
      h('div', null, CONSENT_LABEL[basis] ?? String(basis ?? '')),
    ))
  }
  const book = findBook(data)
  if (book.length > 0) {
    rows.push(h('div', { key: 'lore', className: 'lc-sec' },
      h('div', { className: 'st' }, '这张卡自带的小设定'),
      h('div', { className: 'lc-meta', style: { marginBottom: 4 } }, '聊到这些词的时候，AI 会想起后面那段话。'),
      h('div', { className: 'lc-stack' }, book.map((e, n) => h('div', { key: n },
        h('div', { className: 'lc-wrap' }, asArray(e?.keys).map((k, m) => h('span', { key: m, className: 'lc-tag' }, String(k)))),
        String(e?.content ?? '').trim() === '' ? null : h('div', { className: 'sb', style: { marginTop: 2 } }, String(e.content)),
      ))),
    ))
  }
  if (rows.length === 0) return null
  return h('div', null, h('div', { className: 'lc-sep' }), h('div', { className: 'lc-stack' }, rows))
}

// ── 编辑表单 ──────────────────────────────────────────────────────

/**
 * 真正能填的表单。
 * 旧版这里是一个 JSON 文本框——对不懂技术的人来说等于「没做」。
 * 现在每一个字段都有自己的输入控件，标签用中文，解释一句话讲清该写什么。
 */
// ── 头像：选图 + 拖拽居中 + 裁成竖图 ──────────────────────────────

/** 读文件成 data URL（可以直接塞进 <img src>，也能拿去画布）。 */
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(reader.error ?? new Error('读文件失败'))
    reader.readAsDataURL(file)
  })
}

/** 等图片解码完。浏览器不会给出同步的宽高，只能等。 */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('这张图片打不开，可能不是图片文件'))
    img.src = src
  })
}

const CROP_W = 180
const CROP_H = 270
const OUT_W = 300
const OUT_H = 450

/**
 * 头像选择器。
 *
 * 分两步，是因为窗口里的图必须裁成 2:3 才好看；不裁的话头像框里
 * 要么被拉扁要么只露出一只眼睛。
 *   ① 选图 → 在框里拖动、缩放，框里看到什么就是最后要什么
 *   ② 按「用这张」→ 按框里的取景画成 300×450 的图，交给上层
 *
 * 没选图时显示当前头像和一个「换一张」，不显示空画布。
 */
function AvatarPicker({ photo, name, onChange }) {
  const [src, setSrc] = useState(null)
  const [natural, setNatural] = useState({ w: 0, h: 0 })
  const [zoom, setZoom] = useState(1)
  const [off, setOff] = useState({ x: 0, y: 0 })
  const [err, setErr] = useState(null)
  const dragRef = useRef(null)
  const fileRef = useRef(null)

  const pick = async (file) => {
    if (file === undefined || file === null) return
    setErr(null)
    try {
      const dataUrl = await readFileAsDataUrl(file)
      const img = await loadImage(dataUrl)
      setSrc(dataUrl)
      setNatural({ w: img.naturalWidth || img.width, h: img.naturalHeight || img.height })
      setZoom(1)
      setOff({ x: 0, y: 0 })
    } catch (e) { setErr(humanizeError(e)) }
  }

  // 显示用的几何：先把图放大到刚好盖住框，再乘用户给的倍数
  const cover = natural.w > 0 && natural.h > 0
    ? Math.max(CROP_W / natural.w, CROP_H / natural.h)
    : 1
  const scale = cover * zoom
  const dw = natural.w * scale
  const dh = natural.h * scale
  const limitX = Math.max(0, dw / 2 - CROP_W / 2)
  const limitY = Math.max(0, dh / 2 - CROP_H / 2)
  const ox = Math.max(-limitX, Math.min(limitX, off.x))
  const oy = Math.max(-limitY, Math.min(limitY, off.y))
  const left = CROP_W / 2 - dw / 2 + ox
  const top = CROP_H / 2 - dh / 2 + oy

  const onDown = (e) => {
    if (src === null) return
    dragRef.current = { x: e.clientX, y: e.clientY, ox, oy }
  }
  const onMove = (e) => {
    const d = dragRef.current
    if (d === null || d === undefined) return
    setOff({
      x: Math.max(-limitX, Math.min(limitX, d.ox + (e.clientX - d.x))),
      y: Math.max(-limitY, Math.min(limitY, d.oy + (e.clientY - d.y))),
    })
  }
  const onUp = () => { dragRef.current = null }

  const commit = async () => {
    if (src === null) return
    setErr(null)
    try {
      const img = await loadImage(src)
      const canvas = document.createElement('canvas')
      canvas.width = OUT_W
      canvas.height = OUT_H
      const ctx = canvas.getContext('2d')
      if (ctx === null) { setErr('这个浏览器不支持裁剪，请换一个浏览器试试'); return }
      // 框里的取景换算回原图的像素坐标，避免先缩再放导致糊
      const sx = -left / scale
      const sy = -top / scale
      const sw = CROP_W / scale
      const sh = CROP_H / scale
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, OUT_W, OUT_H)
      const png = canvas.toDataURL('image/png')
      const comma = png.indexOf(',')
      onChange(comma < 0 ? png : png.slice(comma + 1))
      setSrc(null)
    } catch (e) { setErr(humanizeError(e)) }
  }

  return h('div', { className: 'lc-stack' },
    err === null ? null : h(Note, { tone: 'err', icon: 'warning' }, err),

    src === null
      ? h('div', { className: 'lc-row' },
          h(Avatar, { name, kind: undefined, big: true, photo }),
          h('div', { className: 'lc-grow' },
            h('div', { className: 'lc-meta' }, photo === null || photo === undefined
              ? '还没有头像。设一张，列表里一眼就能认出来。'
              : '已经有头像了。换一张或者去掉都行。'),
            h('div', { className: 'lc-row', style: { marginTop: 6 } },
              h(Btn, { size: 'sm', icon: 'pencil', onClick: () => { if (fileRef.current !== null && fileRef.current !== undefined) fileRef.current.click() } }, photo === null || photo === undefined ? '选一张图' : '换一张'),
              photo === null || photo === undefined ? null : h(Btn, { size: 'sm', icon: 'warning', onClick: () => onChange(null) }, '去掉'),
            ),
          ),
        )
      : h('div', null,
          h('div', { className: 'lc-crop-wrap' },
            h('div', {
              className: 'lc-crop-frame',
              onPointerDown: onDown,
              onPointerMove: onMove,
              onPointerUp: onUp,
              onPointerLeave: onUp,
            },
              h('img', {
                src,
                style: { left: `${left}px`, top: `${top}px`, width: `${dw}px`, height: `${dh}px` },
                draggable: false,
              }),
              h('div', { className: 'grid' }),
            ),
            h('div', { className: 'lc-crop-hint' }, '拖动图片调整位置，下面滑块缩放'),
          ),
          h('input', {
            type: 'range', min: 1, max: 3, step: 0.02, value: zoom,
            className: 'lc-input', style: { padding: 0 },
            onChange: (e) => setZoom(Number(e.target.value)),
          }),
          h('div', { className: 'lc-row' },
            h(Btn, { tone: 'primary', icon: 'check', onClick: commit }, '用这张'),
            h(Btn, { size: 'sm', onClick: () => { setSrc(null); setErr(null) } }, '取消'),
          ),
        ),

    h('input', {
      ref: fileRef, type: 'file', accept: 'image/*', style: { display: 'none' },
      onChange: (e) => { pick(e.target.files?.[0]); e.target.value = '' },
    }),
  )
}

function CardForm({ card, onCancel, onSaved, worlds }) {
  const original = card?.data ?? {}
  const [data, setData] = useState(() => cloneData(original))
  // 头像跟卡分开存（assets/），但编辑时要一起看，所以这里挂一份临时副本。
  // 用 undefined 表示「没动过」，null 表示「用户要去掉」。
  const [avatar, setAvatar] = useState(card?.avatar ?? null)
  const [avatarTouched, setAvatarTouched] = useState(false)
  const [sections, setSections] = useState(() => (card?.sections ?? []).map((s) => ({ ...s })))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [more, setMore] = useState(false)

  // ── 草稿 ──
  // 这张卡的 id：已存在的卡用它的，新建的卡用名字算一个。
  // 必须是稳定的同一个值，否则每次改名都存出一份新草稿。
  const cardId = String(card?.data?.id ?? '')
  // 打开时读一次草稿。null = 读过了没有；undefined = 还在读。
  const [draft, setDraft] = useState(undefined)
  // 用户已经决定「不要草稿了」或「已经接着写了」，就不再问
  const [draftAsked, setDraftAsked] = useState(false)
  // 上一次落盘的内容指纹，用来避免每敲一个字就发一次请求
  const [savedPrint, setSavedPrint] = useState('')
  // 自动存草稿失败时要说一声。以前 `.then(() => setSavedPrint(print))` 不看结果，
  // 盘写不进去也当成存上了：用户以为有草稿，退出再进来什么都没有。
  const [draftErr, setDraftErr] = useState(null)
  // 当前这一版「还没落盘就立刻存一次」的动作。卸载时那个只挂一次的
  // effect 会读它，把最后那笔改动补发出去（见下面自动保存那段）。
  const flushRef = useRef(null)

  useEffect(() => {
    let alive = true
    if (cardId === '') { setDraft(null); return () => {} }
    call('draft.get', { cardId })
      .then((r) => {
        if (!alive) return
        const got = r?.ok === true ? (r.draft ?? null) : null
        setDraft(got)
        // 没有旧草稿就没什么可问的，直接开始自动保存；
        // 有旧草稿则等用户选过（接着写 / 不要了）再开始，
        // 否则会在他还没看见那两条按钮之前，就用新内容把旧草稿盖掉。
        if (got === null) setDraftAsked(true)
      })
      .catch(() => { if (alive) { setDraft(null); setDraftAsked(true) } })
    return () => { alive = false }
  }, [cardId])

  // 自动存草稿：改动停下来 1.5 秒就存一次。
  // 为什么不在每次 onChange 都存：每敲一个字符发一次网络请求，
  // 打字会卡，而且盘上全是中间态。停手 1.5 秒意味着「他想了想，可能要去接杯水」。
  //
  // 光有定时器不够：用户被教会了「会自动存」，就会写完最后一句话直接点「先不改」
  // 走人。那时最后那几个字还压在那 1.5 秒里，定时器被清掉、请求没发出去，字就没了。
  // 所以把「现在存一次」抽成 flush，定时器到点调它，离开这一页时也补调一次。
  useEffect(() => {
    // 每次重新算，先把上一次那个「立刻存一次」作废。不这么做的话，定时器已经
    // 存成功、这一次因为「内容没变」提前返回，flushRef 里还留着上一版的 flush，
    // 卸载时会把同一份草稿再发一遍——不多一块肉，但没必要。
    flushRef.current = null
    if (draftAsked !== true) return () => {}
    if (cardId === '') return () => {}
    const print = JSON.stringify({ data, sections: sections.filter((x) => String(x.body ?? '').trim() !== '') })
    // 一个字都没写就没什么可存的；否则用户点一下「改这张卡」又立刻退出，
    // 都会在盘上留一份空草稿，下次进来还问「上次写到一半」——那是假话。
    const empty = Object.keys(data).length === 0 && sections.every((x) => String(x.body ?? '').trim() === '')
    if (empty) return () => {}
    if (print === savedPrint) return () => {}
    const flush = () => {
      call('draft.save', { cardId, draft: { data, sections, avatarTouched, avatar } })
        .then((r) => {
          if (r?.ok === true) { setSavedPrint(print); return }
          setDraftErr(r?.error ?? '草稿没存上')
        })
        .catch(() => setDraftErr('草稿没存上'))
    }
    // 离开时才用得上的那一份（下面那个只挂一次的 effect 会读它）。
    flushRef.current = flush
    const timer = setTimeout(flush, 1500)
    return () => clearTimeout(timer)
  }, [cardId, data, sections, avatar, avatarTouched, draftAsked, savedPrint])

  // 只挂一次：这一页被卸载（「先不改」、切到别的卡、跳去别的页、关掉侧栏）时，
  // 把还压在定时器里的那笔改动补发出去。不 await：页面已经在走了，
  // 请求发出去就会到盘上。
  useEffect(() => () => {
    const pending = flushRef.current
    flushRef.current = null
    if (typeof pending === 'function') pending()
  }, [])

  const set = (key, value) => setData((prev) => ({ ...prev, [key]: value }))

  // 篇幅提示：不是限制，只是让人知道自己写到哪个量级了
  const sizeTag = () => {
    const n = roughSize(sections.map((x) => x.body).join(''))
    if (n === 0) return { tone: 'ok', label: '还没写' }
    if (n < 200) return { tone: 'ok', label: '简短' }
    if (n < 800) return { tone: 'ok', label: '合适' }
    if (n < 2000) return { tone: 'warn', label: '偏长' }
    return { tone: 'warn', label: '很长' }
  }
  const sec = (title) => sections.find((s) => s.title === title)?.body ?? ''
  const setSec = (title, body) => setSections((prev) => {
    const i = prev.findIndex((s) => s.title === title)
    if (i < 0) return [...prev, { title, body }]
    const next = prev.slice()
    next[i] = { ...next[i], body }
    return next
  })

  const save = async () => {
    if (String(data.name ?? '').trim() === '') { setErr('先给它起个名字'); return }
    setBusy(true); setErr(null)
    try {
      const clean = sections.filter((s) => String(s.body ?? '').trim() !== '')
      const payload = { ...data }
      // 空字段不要写进文件，否则到处是空行
      for (const key of Object.keys(payload)) {
        const v = payload[key]
        if (v === undefined || v === null) continue
        if (typeof v === 'string' && v.trim() === '') delete payload[key]
        if (Array.isArray(v) && v.length === 0) delete payload[key]
      }
      const r = await call('card.save', { path: card.path, data: payload, sections: clean })
      if (r.ok !== true) { setErr(r.error ?? '没存上'); return }
      // 头像要在卡存好之后再写：新卡这时才拿到稳定 id
      if (avatarTouched === true) {
        const a = avatar === null || avatar === undefined
          ? await call('avatar.remove', { path: card.path })
          : await call('avatar.set', { path: card.path, base64: avatar })
        if (a.ok !== true) { setErr(a.error ?? '卡存好了，但头像没存上'); return }
      }
      // 卡已经存进文件了，草稿的使命结束。不删的话，下次打开这张卡
      // 会拿旧草稿盖掉刚存的内容——那是数据回退，比丢草稿严重得多。
      // 卸载时补发的那一次（见下面只挂一次的 effect）也得先作废：
      // 不然「最后一次改动距点『存好』不到 1.5 秒」时，那份草稿会在 drop
      // 之后又被写回来，下次打开看到「上次写到一半，还留着。」——一句假话。
      flushRef.current = null
      if (cardId !== '') await call('draft.drop', { cardId }).catch(() => {})
      await onSaved()
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy(false) }
  }

  const worldChoices = Array.isArray(worlds) ? worlds : []
  const kind = String(data.kind ?? 'real')
  const isPerson = kind === 'real' || kind === 'hybrid' || kind === 'self' || kind === 'fictional'

  // 有草稿就问一句。不自动恢复：用户上次可能是故意放弃那个版本的，
  // 悄悄盖上去会让他看到一堆自己没打算留下的字，还以为软件出错了。
  const draftBanner = draft !== null && draft !== undefined && draftAsked !== true
    ? h('div', { className: 'lc-note' },
        h('div', { style: { fontWeight: 650, marginBottom: 4 } }, '上次写到一半，还留着。'),
        h('div', { className: 'lc-meta' },
          `存于 ${humanWhen(draft.saved_at)}，写了 ${draft.sections.filter((x) => String(x?.body ?? '').trim() !== '').length} 段。`),
        h('div', { className: 'lc-row', style: { marginTop: 8 } },
          h(Btn, {
            size: 'sm', tone: 'primary', icon: 'check',
            onClick: () => {
              setData({ ...(draft.data ?? {}) })
              setSections((draft.sections ?? []).map((x) => ({ ...x })))
              if (draft.avatar_touched === true) { setAvatar(draft.avatar ?? null); setAvatarTouched(true) }
              setDraftAsked(true)
              setSavedPrint(JSON.stringify({ data: draft.data ?? {}, sections: (draft.sections ?? []).filter((x) => String(x?.body ?? '').trim() !== '') }))
            },
          }, '接着上次写'),
          h(Btn, {
            size: 'sm', tone: 'ghost',
            onClick: () => { setDraftAsked(true); call('draft.drop', { cardId }).catch(() => {}) },
          }, '不要了，从头写'),
        ),
      )
    : null

  return h('div', { className: 'lc-pad lc-stack' },
    err === null ? null : h(Err, { text: err }),
    draftErr === null ? null : h(Note, { tone: 'warn', icon: 'warning' }, `写到一半的那份没存上：${draftErr}。先别关，接着写也行——但这一份退出就没了。`),
    draftBanner,
    h('div', { className: 'lc-row' },
      h('div', { className: 'lc-meta lc-grow' }, '写多少算多少。空着的地方不会影响别的东西，以后想起来再补。'),
      h(Tag, { tone: sizeTag().tone }, sizeTag().label),
    ),
    h('div', { className: 'lc-meta' }, '正文现在大约 ' + roughSize(sections.map((x) => x.body).join('')) + ' 字。写得越多，AI 越像他；超过两千字之后，多出来的部分不一定读得进去。'),

    h('div', { className: 'lc-fset' },
      h('div', { className: 'lc-fgroup' }, '这个人'),
      h('div', { className: 'lc-fgroup' }, '头像'),
      h(AvatarPicker, {
        photo: avatar,
        name: data.name,
        onChange: (v) => { setAvatar(v); setAvatarTouched(true) },
      }),

      h(Field, { label: '他叫什么' },
        h('input', { className: 'lc-input', value: String(data.name ?? ''), onChange: (e) => set('name', e.target.value), placeholder: '妈妈 / 老张 / 塞拉菲娜', spellCheck: false }),
      ),
      h(Field, { label: '你平时怎么称呼他', hint: '可以不填。写「妈」「张哥」这种。' },
        h('input', { className: 'lc-input', value: String(data.address ?? ''), onChange: (e) => set('address', e.target.value), placeholder: '妈', spellCheck: false }),
      ),
      h(Field, { label: '他是' },
        h('select', { className: 'lc-select', value: kind, onChange: (e) => set('kind', e.target.value) },
          KIND_CHOICES.map((k) => h('option', { key: k, value: k }, KIND_LABEL[k])),
          KIND_CHOICES.includes(kind) ? null : h('option', { value: kind }, KIND_LABEL[kind] ?? kind)),
      ),
      kind === 'real' || kind === 'hybrid' || kind === 'self'
        ? h(Field, { label: '他是我的什么人', hint: '写「母亲」「隔壁王叔」都行。' },
            h('input', { className: 'lc-input', value: String(data.relation ?? ''), onChange: (e) => set('relation', e.target.value), placeholder: '母亲', spellCheck: false }),
          )
        : null,
      // 一个人常常不止一种身份。这一栏是可选的：空白不代表「没有别的身份」，
      // 只代表这次没想起来——所以不给它必填标记。
      kind === 'real' || kind === 'hybrid' || kind === 'self'
        ? h(Field, { label: '还有别的吗', hint: '一个人常常不止一种身份，不填也没关系。' },
            h('div', { className: 'lc-chips' },
              (() => {
                const cur = Array.isArray(data.relation_extra) ? data.relation_extra : []
                return RELATION_EXTRAS.map((x) => h('button', {
                  key: x, type: 'button',
                  className: `lc-chip add sm ${cur.includes(x) ? 'on' : ''}`,
                  onClick: () => set('relation_extra', cur.includes(x) ? cur.filter((t) => t !== x) : [...cur, x]),
                }, cur.includes(x) ? `✓ ${x}` : `＋ ${x}`))
              })(),
            ),
          )
        : null,
      kind === 'real' || kind === 'hybrid' || kind === 'self'
        ? h(Field, { label: '他现在', hint: '只作记录，不影响任何功能。' },
            h('select', { className: 'lc-select', value: String(data.status ?? 'active'), onChange: (e) => set('status', e.target.value) },
              Object.keys(STATUS_LABEL).map((s) => h('option', { key: s, value: s }, STATUS_LABEL[s]))),
          )
        : null,
      h(Field, { label: '出生年', hint: '只写数字，比如 1968。不确定就空着。' },
        h('input', {
          className: 'lc-input', inputMode: 'numeric',
          value: data.birth_year === undefined || data.birth_year === null ? '' : String(data.birth_year),
          onChange: (e) => {
            const raw = e.target.value.replace(/[^0-9]/g, '')
            set('birth_year', raw === '' ? undefined : Number(raw))
          },
          placeholder: '1968', spellCheck: false,
        }),
      ),

      h('div', { className: 'lc-fgroup' }, '他是什么样的人'),
      SECTIONS_MAIN.map((s) => h(Field, { key: s.title, label: s.title, hint: s.hint },
        h('textarea', { className: 'lc-textarea', value: sec(s.title), onChange: (e) => setSec(s.title, e.target.value), spellCheck: false }),
      )),

      h('div', { className: 'lc-fgroup' }, '你们之间'),
      SECTIONS_REL.map((s) => h(Field, { key: s.title, label: s.title, hint: s.hint },
        h('textarea', { className: 'lc-textarea', value: sec(s.title), onChange: (e) => setSec(s.title, e.target.value), spellCheck: false }),
      )),

      h('div', { className: 'lc-fgroup' }, '这张卡自带的小设定'),
      h('div', { className: 'lc-meta' }, '可选。写小说、跑团，或者有只有你们俩懂的称呼时才用。'),
      h(BookEditor, {
        entries: findBook(data),
        onChange: (v) => set('cc', { ...(data.cc ?? {}), fields: { ...(data.cc?.fields ?? {}), character_book: { entries: v } } }),
      }),

      h('div', { className: 'lc-fgroup' }, '顺带记一下'),
      h(Field, { label: '他会什么', hint: '一行一件事。程度选不准就选「熟手」。' },
        h(CompetencyEditor, { items: data.competency, onChange: (v) => set('competency', v) }),
      ),
      h(Field, { label: '不要跟他提这些', hint: '一行一件。写到这儿，以后用这张卡时会避开。' },
        h(ListEditor, { items: data.taboos, onChange: (v) => set('taboos', v), placeholder: '他妻子去世这件事' }),
      ),
      kind === 'real' || kind === 'hybrid' || kind === 'self'
        ? h(Field, { label: '他知道你把他写下来了吗', hint: '这一项是为了尊重对方。不影响功能。' },
            h('select', {
              className: 'lc-select',
              value: String(typeof data.consent === 'object' && data.consent !== null ? data.consent.basis : data.consent ?? 'self'),
              onChange: (e) => {
                // 只换 basis，其余（recorded_at / note）要保住。
                // 以前这里写死 {basis: value}，用户改一次选项就把
                // 「什么时候问的、怎么问的」冲掉了——而那两项恰恰是
                // 证明「我真的问过」的东西，改选项不该把它们清空。
                const prev = data?.consent !== null && typeof data?.consent === 'object' ? data.consent : {}
                const next = { ...prev, basis: e.target.value }
                // 选到「家里人都同意」时顺手补今天的日期，方便导出时过闸。
                // 用户想改还是能改（下面有输入框）。
                if (e.target.value === 'family-agreed' && String(prev.recorded_at ?? '').trim() === '') {
                  next.recorded_at = new Date().toISOString().slice(0, 10)
                }
                set('consent', next)
              },
            }, Object.keys(CONSENT_LABEL).map((k) => h('option', { key: k, value: k }, CONSENT_LABEL[k]))),
          )
        : null,
      // 选到「家里人都同意」后，把日期露出来。不然导出时会被拦，
      // 而用户看不出该去哪填。
      kind === 'real' || kind === 'hybrid' || kind === 'self'
        ? (typeof data.consent === 'object' && data.consent !== null && String(data.consent.basis) === 'family-agreed'
            ? h(Field, { label: '哪天说的', hint: '写 2026-03-15 这样。导出的时候要它。' },
                h('input', {
                  className: 'lc-input',
                  value: String(data.consent?.recorded_at ?? ''),
                  onChange: (e) => set('consent', { ...data.consent, recorded_at: e.target.value }),
                  placeholder: '2026-03-15', spellCheck: false,
                }),
              )
            : null)
        : null,
    ),

    h('div', { style: { marginTop: 12 } },
      h('button', { className: 'lc-btn ghost sm', type: 'button', onClick: () => setMore(!more), style: { width: '100%', justifyContent: 'flex-start' } },
        h(Icon, { name: 'chevron', size: 12 }), more ? '收起不常用的' : '还有几个不常用的'),
    ),
    more === true
      ? h('div', { className: 'lc-fset' },
          h(Field, { label: '属于哪个世界', hint: worldChoices.length === 0 ? '写小说、建宇宙的时候才用。现实中的人就留空。' : '从你导入过的世界书里选一本。' },
            worldChoices.length === 0
              ? h('input', { className: 'lc-input', value: String(data.world ?? ''), onChange: (e) => set('world', e.target.value), placeholder: 'reality', spellCheck: false })
              : h('select', { className: 'lc-select', value: String(data.world ?? REALITY) || REALITY, onChange: (e) => set('world', e.target.value) },
                  h('option', { value: REALITY }, '现实世界（不属于哪本书）'),
                  worldChoices.map((w) => h('option', { key: String(w.id), value: String(w.id) }, String(w.name ?? w.id))),
                  worldChoices.some((w) => String(w.id) === String(data.world ?? '')) || String(data.world ?? '') === '' || String(data.world) === REALITY
                    ? null
                    : h('option', { value: String(data.world) }, String(data.world)),
                ),
          ),
          h(Field, { label: '标签', hint: '用逗号分开。方便以后搜索。' },
            h('input', {
              className: 'lc-input',
              value: Array.isArray(data.tags) ? data.tags.join('、') : '',
              onChange: (e) => set('tags', e.target.value.split(/[、,，]/).map((s) => s.trim()).filter((s) => s !== '')),
              placeholder: '家人、爱做饭', spellCheck: false,
            }),
          ),
          h(Field, { label: '备注', hint: '随便写。' },
            h('textarea', { className: 'lc-textarea', value: sec('备注'), onChange: (e) => setSec('备注', e.target.value), spellCheck: false }),
          ),
        )
      : null,

    h('div', { className: 'lc-sep' }),
    h('div', { className: 'lc-row' },
      h(Btn, { tone: 'primary', big: true, icon: 'check', onClick: save, disabled: busy }, busy ? '正在存…' : '存好'),
      h(Btn, { big: true, onClick: onCancel, disabled: busy }, '先不改'),
      busy ? h(Spinner) : null,
    ),
  )
}

/**
 * 一行一条的列表编辑器（禁忌、标签这类）。
 *
 * 「空行」必须由这个组件自己记着（`extras`），不能靠「值里带一个空串」来占位。
 * 以前就是靠后者：点「再加一条」时把 `[{label:''}]` 交给上面，而上面那层
 * 每次保存都会把空串过滤掉，于是下一次渲染又只剩一行——点几次都只有一行，
 * 用户看到的就是「点了没反应」。
 */
function ListEditor({ items, onChange, placeholder }) {
  const rows = asArray(items).map((t) => (typeof t === 'string' ? t : t?.label ?? t?.key ?? '')).filter((t) => typeof t === 'string')
  // 末尾留几个空行让用户填（至少一个，不然连入口都没有）
  const [extras, setExtras] = useState(1)
  const list = [...rows, ...Array.from({ length: Math.max(1, extras) }, () => '')]
  const emit = (next) => onChange(next.filter((s) => String(s).trim() !== '').map((label) => ({ label })))
  const update = (i, v) => {
    const next = list.slice()
    next[i] = v
    emit(next)
  }
  return h('div', { className: 'lc-stack' },
    list.map((v, i) => h('div', { key: i, className: 'lc-listrow' },
      h('input', {
        className: 'lc-input', value: v, placeholder, spellCheck: false,
        onChange: (e) => update(i, e.target.value),
      }),
      // 空行也能删，只是删到只剩一个就不给了
      list.length === 1 && (v ?? '') === ''
        ? null
        : h('button', {
          className: 'lc-iconbtn', type: 'button', title: '删掉这条',
          onClick: () => {
            const next = list.slice()
            next.splice(i, 1)
            // 少一行空位；已经填了字的走正常保存
            setExtras(Math.max(1, list.length - 1 - next.filter((x) => String(x).trim() !== '').length))
            emit(next)
          },
        }, h(Icon, { name: 'trash', size: 12 })),
    )),
    h('div', null, h(Btn, {
      size: 'sm', icon: 'plus',
      onClick: () => setExtras(Math.max(1, extras) + 1),
    }, '再加一条')),
  )
}

/** 「会什么」：一件能力 + 一个程度。 */
function CompetencyEditor({ items, onChange }) {
  const rows = asArray(items).filter((c) => c !== null && typeof c === 'object').map((c) => ({ key: String(c.key ?? c.label ?? ''), level: String(c.level ?? '熟手') }))
  // 同 ListEditor：空行由组件自己记着，不能靠「值里带一个空 key」占位，
  // 否则上面那层一过滤，点「再加一件」就永远只有一行。
  const [extras, setExtras] = useState(1)
  const list = [...rows, ...Array.from({ length: Math.max(1, extras) }, () => ({ key: '', level: '熟手' }))]
  const emit = (next) => onChange(next.filter((r) => String(r.key ?? '').trim() !== ''))
  const update = (i, patch) => { const next = list.map((r, n) => (n === i ? { ...r, ...patch } : r)); emit(next) }
  return h('div', { className: 'lc-stack' },
    list.map((r, i) => h('div', { key: i, className: 'lc-listrow' },
      h('input', { className: 'lc-input', value: r.key, onChange: (e) => update(i, { key: e.target.value }), placeholder: '做红烧肉', spellCheck: false }),
      h('select', { className: 'lc-select', value: r.level, onChange: (e) => update(i, { level: e.target.value }) },
        LEVEL_LABEL.map((l) => h('option', { key: l, value: l }, l))),
      h('button', {
        className: 'lc-iconbtn', type: 'button', title: '删掉这条',
        onClick: () => {
          const next = list.filter((_, n) => n !== i)
          setExtras(Math.max(1, next.filter((x) => String(x.key ?? '').trim() === '').length))
          emit(next)
        },
      }, h(Icon, { name: 'trash', size: 12 })),
    )),
    h('div', null, h(Btn, {
      size: 'sm', icon: 'plus',
      onClick: () => setExtras(Math.max(1, extras) + 1),
    }, '再加一件')),
  )
}

// ── 建议面板 ──────────────────────────────────────────────────────

/**
 * 世界书条目编辑器。
 *
 * 原来这一块只能「整段 JSON 改」——对不懂技术的人来说等于没做。
 * 现在一条一张小卡：触发词一行一个，内容一大段。加一条、删一条都在这。
 */
function BookEditor({ entries, onChange }) {
  const list = Array.isArray(entries) ? entries : []
  const patch = (index, key, value) => {
    const next = list.map((e, n) => (n === index ? { ...e, [key]: value } : e))
    onChange(next)
  }
  const keysToText = (keys) => asArray(keys).map((k) => String(k)).join('、')
  const textToKeys = (text) => String(text).split(/[、,，\n]/).map((k) => k.trim()).filter((k) => k !== '')
  return h('div', { className: 'lc-stack' },
    list.length === 0
      ? h('div', { className: 'lc-meta' }, '还没有。大多数现实里的卡一条都不需要；写小说或跑团才用得上。')
      : null,
    list.map((e, n) => h('div', { key: n, className: 'lc-sec', style: { position: 'relative' } },
      h('div', { className: 'lc-row', style: { marginBottom: 4 } },
        h('span', { className: 'lc-meta lc-grow', style: { fontWeight: 600 } }, `第 ${n + 1} 条`),
        h(Btn, {
          size: 'sm', tone: 'ghost',
          onClick: () => onChange(list.filter((_, m) => m !== n)),
        }, '删掉'),
      ),
      h(Field, { label: '聊到这些词就想起它', hint: '一行一个，或者用顿号隔开。' },
        h('input', {
          className: 'lc-input',
          value: keysToText(e?.keys),
          onChange: (ev) => patch(n, 'keys', textToKeys(ev.target.value)),
          placeholder: '王城、阿斯特兰',
          spellCheck: false,
        }),
      ),
      h(Field, { label: '想起什么' },
        h('textarea', {
          className: 'lc-textarea',
          value: String(e?.content ?? ''),
          onChange: (ev) => patch(n, 'content', ev.target.value),
          placeholder: '阿斯特兰是河谷北岸的老城，城墙是灰色的石头砌的。',
          spellCheck: false,
        }),
      ),
    )),
    h(Btn, {
      size: 'sm', icon: 'plus',
      onClick: () => onChange([...list, { keys: [], content: '' }]),
    }, '加一条'),
  )
}

/** 把时间戳说成「刚才 / 3 分钟前 / 10 月 19 日 23:40」这种人话。 */
function humanWhen(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '时间不详'
  const diff = Date.now() - d.getTime()
  if (diff < 0) return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return Math.floor(diff / 60_000) + ' 分钟前'
  if (diff < 86_400_000) return Math.floor(diff / 3600_000) + ' 小时前'
  if (diff < 7 * 86_400_000) return Math.floor(diff / 86_400_000) + ' 天前'
  return d.toLocaleString('zh-CN', { year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/**
 * 以前的样子。
 *
 * 每次保存都会在后台悄悄留一份全文，这里只是把它露出来。
 * 设计上只做两件有用的事：「看一眼当时写了什么」和「退回那一版」。
 * 不做 diff、不做分支——这个插件的用户不是程序员。
 */
function HistoryPanel({ card, onClose, onRestored }) {
  const [versions, setVersions] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState('')
  const [preview, setPreview] = useState(null)
  const [confirmStamp, setConfirmStamp] = useState('')

  useEffect(() => {
    let alive = true
    call('card.history', { path: card.path })
      .then((r) => { if (alive) { if (r.ok === true) setVersions(r.versions ?? []); else setErr(r.error ?? '读不到历史') } })
      .catch((e) => { if (alive) setErr(humanizeError(e)) })
    return () => { alive = false }
  }, [card.path])

  const look = async (v) => {
    setBusy(v.stamp); setErr(null)
    try {
      const r = await call('card.version', { path: card.path, stamp: v.stamp })
      if (r.ok !== true) { setErr(r.error ?? '这一版读不出来'); return }
      setPreview({ stamp: v.stamp, data: r.data, sections: r.sections })
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy('') }
  }

  const restore = async (v) => {
    if (confirmStamp !== v.stamp) { setConfirmStamp(v.stamp); return }
    setBusy(v.stamp); setErr(null)
    try {
      const r = await call('card.restore', { path: card.path, stamp: v.stamp })
      if (r.ok !== true) { setErr(r.error ?? '没退回去'); return }
      await onRestored()
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy('') }
  }

  const shown = preview === null
    ? []
    : (preview.sections ?? []).filter((x) => String(x.body ?? '').trim() !== '')

  return h('div', { className: 'lc-stack', style: { border: '1px solid var(--lc-line-strong)', borderRadius: 'var(--lc-radius)', padding: 10, background: 'var(--lc-panel)' } },
    h('div', { className: 'lc-row' },
      h(Icon, { name: 'history', size: 15 }),
      h('span', { style: { fontWeight: 650 } }, '以前的样子'),
      h('span', { className: 'lc-grow' }),
      h('span', { className: 'lc-meta' }, versions === null ? '正在找…' : `${versions.length} 个旧版本`),
      h(Btn, { size: 'sm', tone: 'ghost', onClick: onClose }, '收起'),
    ),
    err === null ? null : h(Err, { text: err }),
    h('div', { className: 'lc-meta' }, '每次保存都会自动留一份。这里的东西只是让你看看，不会自己变回卡里。'),

    versions !== null && versions.length === 0
      ? h('div', { className: 'lc-meta' }, '还没有旧版本。改过一次并保存之后，上一次的内容就会出现在这里。')
      : null,

    versions === null
      ? null
      : h('div', { className: 'lc-stack' }, versions.map((v) => h('div', { key: v.stamp, className: 'lc-row', style: { padding: '4px 0', borderTop: '1px solid var(--lc-line)' } },
          h('span', { className: 'lc-grow' }, humanWhen(v.when)),
          h(Btn, { size: 'sm', tone: 'ghost', disabled: busy !== '', onClick: () => look(v) }, '看看'),
          h(Btn, {
            size: 'sm',
            tone: confirmStamp === v.stamp ? 'danger' : 'ghost',
            disabled: busy !== '',
            onClick: () => restore(v),
          }, confirmStamp === v.stamp ? '确定退回？' : '退回这一版'),
        ))),

    preview === null ? null : h('div', { className: 'lc-sec', style: { marginTop: 6 } },
      h('div', { className: 'st' }, '那一版写的是：' + (preview.data?.name ?? '(还没名字)')),
      shown.length === 0
        ? h('div', { className: 'lc-meta' }, '那一版还没有写正文。')
        : h('div', { className: 'lc-stack' }, shown.map((x, n) => h('div', { key: n },
            h('div', { className: 'lc-meta', style: { fontWeight: 600 } }, x.title),
            h('div', { className: 'sb' }, x.body),
          ))),
    ),
  )
}

function ProposalPanel({ proposal, onClose, onApplied, applyBlocked, onBuildCard }) {
  // 已经写进卡的条目不再列出来。以前它们会一直挂着，用户看着以为没生效，
  // 再点一次就又把同一段话写进卡里——重复段落就是这么来的。
  const all = proposal?.items ?? []
  const [items, setItems] = useState(() => all.filter((i) => i.adopted !== true).map((i) => ({ ...i })))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [note, setNote] = useState(null)
  // 「都不要」要按两次。第一次只是把按钮变成「确定都不要？」——
  // 这一下会把整份建议从首页待办里撤掉，误触的代价是用户以为 AI 白读了一遍。
  const [confirmDrop, setConfirmDrop] = useState(false)
  const adoptedBefore = all.filter((i) => i.adopted === true).length
  const checked = items.filter((i) => i.checked).length

  // 剩下的一条都不要了：整份从待办里撤掉，文件还留着。
  const dropAll = async () => {
    if (confirmDrop !== true) { setConfirmDrop(true); return }
    setBusy(true); setErr(null)
    try {
      const r = await call('proposal.dismiss', { json: proposal.json })
      if (r.ok !== true) { setErr(r.error ?? '没能记下来'); return }
      // 先让首页把这份摘掉，再关面板——反过来的话用户会看见它又回到列表里。
      // 带上 dismissed 标记：父层靠它决定提示说什么，否则会照着「采纳」那条
      // 报「这些卡里本来就有」，用户会以为自己点错了。
      await onApplied({ ...r, dismissed: true })
      onClose()
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy(false) }
  }

  // 勾选立刻写到后台。界面上的「选了 N 条」和真正会写进卡的东西必须是同一份，
  // 否则用户点了「就用这 N 条」却被告知一条都没勾。
  const toggle = (index) => {
    const next = items.map((item, n) => (n === index ? { ...item, checked: !item.checked } : item))
    setItems(next)
    // 用条目自己的下标，不能用它在界面列表里的位置：已采纳的条目被摘掉之后，
    // 列表位置和提案里的位置就对不上了，勾 A 会写成 B。
    const picked = next.filter((item) => item.checked).map((item) => item.index)
    call('proposal.check', { json: proposal.json, checked: picked }).catch(() => {
      // 记不下来也不拦着用户继续点；真正采纳时会以界面上这份为准再传一次
    })
  }

  const apply = async () => {
    setBusy(true); setErr(null)
    try {
      const picked = items.filter((item) => item.checked).map((item) => item.index)
      const r = await call('proposal.apply', { json: proposal.json, checked: picked })
      if (r.ok !== true) { setErr(r.error ?? '没存上'); return }
      // 写进去的（和卡里本来就有的）立刻从列表上摘掉。留着它们，
      // 用户会以为没生效，再点一次就重复了。
      const gone = new Set(Array.isArray(r.handledIndexes) ? r.handledIndexes : [])
      const left = items.filter((item) => gone.has(item.index) !== true)
      setItems(left)
      const bits = []
      if ((r.applied ?? 0) > 0) bits.push(`写进卡里 ${r.applied} 条`)
      if ((r.duplicate ?? 0) > 0) bits.push(`${r.duplicate} 条卡里本来就有，没再写`)
      if (left.length === 0) bits.push('这一份都处理完了')
      if (bits.length > 0) setNote(bits.join('，') + '。')
      // 有落不进卡里的条目要说清楚，不能只说「存进卡里了」。
      // 会走到这里的只有一类：提案里带了只有人能填的项（比如「对方知不知道」），
      // 那是模型的推断，不该由它替你声明。
      if ((r.skipped ?? 0) > 0) {
        setErr(`有 ${r.skipped} 条写不进去——它们想改的是只有你自己能填的地方（比如这张卡属于真人还是虚构、对方知不知道）。这些请在卡片里自己改。`)
      }
      // 还有一种写不进去：勾了，但当初引用的那段原文已经不在材料里了
      // （材料删得掉，删完旧提案就失去依据）。这类单独说，否则用户会以为
      // 自己勾的东西被无故吞了。
      if ((r.dropped ?? 0) > 0) {
        setErr(`有 ${r.dropped} 条没写——勾选的那几条引用的原文已经不在材料里了（可能是那份材料被删掉了）。有原文的已经写进去了；这几条要重新整理材料才能再来一遍。`)
      }
      await onApplied(r)
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy(false) }
  }

  return h('div', { className: 'lc-stack', style: { border: '1px solid var(--lc-doctor)', borderRadius: 'var(--lc-radius)', padding: 10, background: 'var(--lc-panel)' } },
    h('div', { className: 'lc-row' },
      h(Icon, { name: 'spark', size: 15 }),
      h('span', { style: { fontWeight: 650 } }, 'AI 从材料里读出来的东西'),
      h('span', { className: 'lc-grow' }),
      h('span', { className: 'lc-meta' }, `选了 ${checked} 条`),
    ),
    h('div', { className: 'lc-meta' }, '每一条下面都引用了材料里的原话。它编不出来的——材料里找不到原文的，已经被丢掉了。'),
    adoptedBefore > 0
      ? h('div', { className: 'lc-meta' }, `其中 ${adoptedBefore} 条之前已经写进卡了，不再列在这里。`)
      : null,
    err === null ? null : h(Err, { text: err }),
    note === null ? null : h(Note, { tone: 'ok', icon: 'check' }, note),
    h('div', { className: 'lc-stack' }, items.map((item, n) => h('div', {
      key: n, className: `lc-proposal-item ${item.checked ? 'on' : ''}`,
      onClick: () => toggle(n), role: 'button', tabIndex: 0,
      onKeyDown: (e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(n) } },
    },
      h('div', { className: `lc-check ${item.checked ? 'on' : ''}` }, item.checked ? h(Icon, { name: 'check', size: 11 }) : null),
      h('div', { className: 'lc-grow' },
        h('div', { style: { fontWeight: 600 } }, describeValue(item)),
        h('div', { className: 'lc-meta' }, String(fieldLabel(item.field))),
        item.evidence === undefined ? null : h('div', { className: 'lc-quote' }, `材料里说：「${String(item.evidence.quote ?? '').slice(0, 160)}」`),
      ),
    ))),
    (proposal.rejected ?? []).length > 0
      ? h(Note, { tone: 'warn', icon: 'warning' }, `有 ${proposal.rejected.length} 条在材料里找不到原话，已经丢掉了。`)
      : null,
    // 名下还没有卡时不给采纳按钮。硬给的话点下去只会得到「找不到这张卡」，
    // 而用户刚刚才看完一整页建议——说清楚比给个坏按钮好。
    applyBlocked === true
      ? h('div', { className: 'lc-stack' },
          h(Note, { tone: 'warn', icon: 'warning' }, `「${String(proposal.about ?? '这个人')}」还没有卡，这些建议暂时没地方放。先建一张，再回来勾。`),
          h('div', { className: 'lc-row' },
            h(Btn, { tone: 'primary', onClick: onBuildCard, icon: 'plus' }, '去建这张卡'),
            h(Btn, { onClick: onClose, icon: 'x' }, '先放着'),
          ),
        )
      : items.length === 0
        ? h('div', { className: 'lc-row' },
            h(Note, { tone: 'ok', icon: 'check' }, '这一份里没有还没写进去的了。'),
            h('span', { className: 'lc-grow' }),
            h(Btn, { onClick: onClose, icon: 'x' }, '知道了'),
          )
        : h('div', { className: 'lc-row' },
            h(Btn, { tone: 'primary', onClick: apply, disabled: busy || checked === 0, icon: 'check' }, checked === 0 ? '先勾选要的' : `就用这 ${checked} 条`),
            h(Btn, { onClick: onClose, icon: 'x' }, '先留着'),
            h(Btn, { tone: confirmDrop === true ? 'danger' : 'ghost', onClick: dropAll, disabled: busy, icon: 'check' }, confirmDrop === true ? '确定都不要？' : '都不要'),
            busy ? h(Spinner) : null,
          ),
  )
}

/** 把字段名翻译成人话。 */
function fieldLabel(field) {
  const table = {
    name: '名字', address: '称呼', relation: '关系', birth_year: '出生年',
    competency: '会什么', knowledge: '知道的事', taboos: '不要提的事',
    life: '生活', consent: '对方是否知情', status: '现在',
    self: '自述', personality: '性格', appearance: '外貌', catchphrase: '口癖',
  }
  return table[field] ?? (String(field ?? '').startsWith('自述') || String(field ?? '') === '' ? '一段描述' : '一条补充')
}

/** 英文（旧版或模型偶尔会写）→ core 的四个中文等级。core 只认这四个。 */
const LEVEL_ALIAS = {
  novice: '入门', beginner: '入门', basic: '入门',
  intermediate: '熟手', medium: '熟手',
  expert: '精通', advanced: '精通',
  master: '专家', native: '专家',
}

function levelLabel(level) {
  const s = String(level ?? '').trim()
  if (LEVEL_LABEL.includes(s)) return s
  return LEVEL_ALIAS[s.toLowerCase()] ?? '程度没填'
}

/** 挑出能直接给人看的词；对象里的结构不摆到界面上。 */
function wordList(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  const out = []
  for (const one of list) {
    const word = typeof one === 'string' ? one : String(one?.label ?? one?.key ?? one?.name ?? '').trim()
    if (word !== '') out.push(word)
  }
  return out
}

function describeCompetency(value) {
  const one = value !== null && typeof value === 'object' ? value : {}
  const name = String(one.key ?? one.label ?? one.name ?? '').trim()
  if (name === '') return ''
  return `${name}：${levelLabel(one.level)}`
}

/**
 * 把一条建议的值说成人话。
 *
 * 这里禁止 JSON.stringify：界面上曾经出现过
 * `knows: ["榫卯"]；does_not_know: []` 和英文程度 `expert`。
 * 认识的形状按字段翻；不认识的一律说「一条补充」，不把结构抖出来。
 */
function describeValue(item) {
  const v = item?.value
  const field = String(item?.field ?? '')
  if (v === null || v === undefined) return '一条补充'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) {
    if (field === 'competency') {
      const rows = v.map(describeCompetency).filter((s) => s !== '')
      return rows.length > 0 ? rows.join('；') : '一条补充'
    }
    const words = wordList(v)
    return words.length > 0 ? words.join('、') : '一条补充'
  }
  if (typeof v !== 'object') return String(v)

  if (field === 'knowledge') {
    const knows = wordList(v.knows)
    const notKnows = wordList(v.does_not_know)
    const rows = []
    if (knows.length > 0) rows.push(`知道：${knows.join('、')}`)
    if (notKnows.length > 0) rows.push(`不知道：${notKnows.join('、')}`)
    return rows.length > 0 ? rows.join('；') : '一条补充'
  }
  if (field === 'address') {
    const them = wordList(v.them_to_me)
    const me = wordList(v.me_to_them)
    const rows = []
    if (them.length > 0) rows.push(`他叫你：${them.join('、')}`)
    if (me.length > 0) rows.push(`你叫他：${me.join('、')}`)
    return rows.length > 0 ? rows.join('；') : '一条补充'
  }
  if (field === 'life') {
    const rows = []
    for (const [key, label] of [['dietary', '吃'], ['physical', '身体'], ['sensory', '感觉'], ['logistics', '日常']]) {
      const words = wordList(v[key])
      if (words.length > 0) rows.push(`${label}：${words.join('、')}`)
    }
    return rows.length > 0 ? rows.join('；') : '一条补充'
  }
  if (field === 'competency' || (v.level !== undefined && (v.key !== undefined || v.label !== undefined))) {
    const row = describeCompetency(v)
    return row === '' ? '一条补充' : row
  }
  return '一条补充'
}

// ── 新建空卡 ──────────────────────────────────────────────────────

function NewCardView({ state, onCreate, presetName }) {
  // 从「这份建议的人还没有卡」过来时，名字已经知道了，别让人再打一遍。
  const [name, setName] = useState(String(presetName ?? ''))
  const [kind, setKind] = useState('real')
  const [relation, setRelation] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const create = async () => {
    if (name.trim() === '') { setErr('先给它起个名字'); return }
    setBusy(true); setErr(null)
    try {
      await onCreate({
        lifecard: '0.1',
        id: safeId(name.trim()),
        kind,
        world: 'reality',
        name: name.trim(),
        ...(relation.trim() === '' ? {} : { relation: relation.trim() }),
      })
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy(false) }
  }

  return h('div', { className: 'lc-pad lc-stack' },
    h('div', { className: 'lc-meta' }, '只要一个名字就能开始。其他的建好之后再慢慢填。'),
    h('div', { className: 'lc-fset' },
      h(Field, { label: '他叫什么' },
        h('input', { className: 'lc-input', value: name, onChange: (e) => setName(e.target.value), placeholder: '妈妈 / 老张 / 塞拉菲娜', spellCheck: false }),
      ),
      h(Field, { label: '他是' },
        h('select', { className: 'lc-select', value: kind, onChange: (e) => setKind(e.target.value) },
          KIND_CHOICES.map((k) => h('option', { key: k, value: k }, KIND_LABEL[k]))),
      ),
      kind === 'real' || kind === 'hybrid' || kind === 'self'
        ? h(Field, { label: '他是我的什么人', hint: '可以不填。' },
            h('input', { className: 'lc-input', value: relation, onChange: (e) => setRelation(e.target.value), placeholder: '母亲', spellCheck: false }),
          )
        : null,
    ),
    err === null ? null : h(Err, { text: err }),
    h(Btn, { tone: 'primary', big: true, block: true, onClick: create, disabled: busy, icon: 'check' }, busy ? '正在建…' : '建这张卡'),
  )
}

// ── 访谈 ──────────────────────────────────────────────────────────

function InterviewView({ state, listing, preset, onRecorded, flash, onDone, onAnalyze, mode }) {
  // 这扇门建的是现实里的人，还是虚构的角色。两者的第一问本来就不该一样：
  // 现实先问「他是我的什么人」，虚构问「TA 一张嘴什么感觉」。
  // 顺带把颜色分开——不然建着建着分不清手里这张是真人还是角色。
  const fiction = mode === 'novel' || mode === 'tavern'
  const fictionTone = mode === 'tavern' ? 'analyze' : 'import'
  const accent = fiction ? `var(--lc-${fictionTone})` : 'var(--lc-interview)'
  const accentSoft = fiction ? `var(--lc-${fictionTone}-soft)` : 'var(--lc-interview-soft)'
  // prep = 从一张已有的卡点「接着聊」进来，直接去准备问题，不再让人挑一遍关系。
  const [phase, setPhase] = useState(String(preset?.id ?? '').trim() === '' ? 'pick' : 'prep')   // prep | pick | talk | done
  const [name, setName] = useState(preset?.name ?? '')
  const [relation, setRelation] = useState(() => {
    const relations = (state?.relations?.length ?? 0) > 0 ? state.relations : RELATION_FALLBACK
    const hit = relations.find((r) => r.label === preset?.relationLabel)
    // 旧数据里存的可能是「父母」这种分类名，或者一个已经不存在的 id。
    // 对不上就落在「父亲」——它是父亲/母亲这一支里最靠前的那个，
    // 题一样问，用户点一下就能改。
    return hit?.id ?? 'father'
  })
  // 「他是我的什么人」下面那条横线里自己写的那句话。
  // 空着表示没自己填，这时看上面四个词点了哪个。
  const [customRelation, setCustomRelation] = useState('')
  // 「还有什么」默认收起：一行灰字，点开才出输入框
  const [showExtras, setShowExtras] = useState(false)
  const [extrasText, setExtrasText] = useState('')
  // 光标在下面那条打字栏里，或者打字栏里已经有字：
  // 这时候「正在生效的关系」是那句话，不上面那排词。
  const [customFocus, setCustomFocus] = useState(false)
  const [plan, setPlan] = useState(null)
  const [queue, setQueue] = useState([])
  const [current, setCurrent] = useState(null)
  const [answer, setAnswer] = useState('')
  const [log, setLog] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [aboutId, setAboutId] = useState(preset?.id ?? '')
  // 结束整场时，输入框里那句还没点「记下」的话被丢掉了没有。
  // 结束页以前一律说「你说的都记下来了」；可要是手一滑点了结束，
  // 正在写的那句其实没存进去——那句话就得改口。
  const [dropped, setDropped] = useState(false)
  // 这一场访谈写出去的材料（interview.record 每次回传一份）。结束页要带上它们，
  // 不然分析页一条都不勾，而「一条都不勾」= 全读——别人的材料会被读进这张卡。
  const [materialPaths, setMaterialPaths] = useState([])
  const scrollRef = useRef(null)

  // 宿主给什么就用什么；一个都没有（还没重启、旧版宿主）就用本地这份。
  const relations = (state?.relations?.length ?? 0) > 0 ? state.relations : RELATION_FALLBACK

  // 「自己写」生效中：光标在那条打字栏里，或者里面已经有字。
  // 只在这时候，强调色才从上面那四个词挪到打字栏。
  const typing = customFocus || customRelation.trim() !== ''

  useEffect(() => {
    if (scrollRef.current !== null) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [log, current])

  // 从卡页走进来的这一条路：卡已经存在，名字关系都在卡上，之前答过的题也在台账里。
  // 再让他在第一屏把「他是我的什么人」点一遍，等于把已经知道的事问第二遍——
  // 用户会以为刚才那一步没生效。所以这一屏直接跳过，去准备问题。
  useEffect(() => {
    if (phase !== 'prep') return
    start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  const start = async () => {
    const targetName = (preset?.name ?? name).trim()
    if (targetName === '') { setErr('先写一下他叫什么'); return }
    // 卡上记的是人能读的那句话（「母亲」「隔壁王叔」），不是 father/custom 这种内部标识。
    // 横线里自己写了就用他写的；没写就用点中的那个词；两样都没有就空着——
    // 空着比随便塞一个「父母」诚实。
    const typed = customRelation.trim()
    const relationText = typed !== ''
      ? typed
      : (relations.find((r) => r.id === relation)?.label ?? '')
    // 「还有什么」里写的东西按顿号/逗号/空格拆成几条，空的不算
    const extras = extrasText
      .split(/[、,，;；\s]+/)
      .map((s) => s.trim())
      .filter((s) => s !== '')
    setBusy(true); setErr(null)
    try {
      const id = preset?.id ?? safeId(targetName)
      // 先按 id 精确匹配，再按名字兜底。顺序不能反：酒馆里「复制一份来演」
      // 会造出一张同名的副本（id 是 xxx-role），而 readdir 下 `-role` 排在
      // 原卡前面——先比名字的话，从原卡点「接着聊」会把整场访谈写到副本上。
      const cards = listing?.cards ?? []
      const byId = cards.find((c) => c.id === id)
      const found = byId !== undefined ? byId : cards.find((c) => String(c.name ?? '').trim() === targetName)
      // 同名不等于同一个人。用户在这里打「王叔」，列表里正好有一张「王叔」的卡，
      // 以前会默默当成同一个、接着往那张卡上写，还会把这次点的关系盖上去。
      // 用户以为自己新建了一个人，其实改的是旧的。所以从列表点「接着聊」进来的
      // （带了 preset.id）不問；自己打名字撞上了，先问一句。
      if (found !== undefined && (preset?.id ?? '') === '') {
        const reuse = typeof window !== 'undefined' && typeof window.confirm === 'function'
          ? window.confirm(`已经有一张「${targetName}」的卡了。\n\n点「好」= 接着给这张补，这次聊到的都并进那张卡。\n点「取消」= 先停下，换个名字再建一张别的。`)
          : true
        if (reuse !== true) {
          setErr(`已经有一张「${targetName}」的卡了。要么回列表点它的「接着聊」，要么把名字改得能区分开再建。`)
          return
        }
      }
      const existing = found
      // 这一次是不是「刚新建的卡」，后面准备问题失败时要靠它决定撤不撤
      let made = null
      if (existing === undefined) {
        made = await call('card.save', {
          data: {
            lifecard: '0.1', id, kind: fiction ? 'fictional' : 'real', world: 'reality', name: targetName,
            // 虚构的角色没有「他是我的什么人」，不写这个字段——
            // 写着「母亲」的虚构角色，以后在酒馆里看会莫名其妙。
            ...(fiction || relationText === '' ? {} : { relation: relationText }),
            // 只有真有补充身份时才写这个字段，不然每张卡都多一行空数组
            ...(!fiction && extras.length > 0 ? { relation_extra: extras } : {}),
          },
          sections: [],
        })
        // 卡没建成就不该开始聊：聊完的每一句都要落到这张卡上，卡不在，
        // 用户会答上十几题，回头什么也没有。
        if (made?.ok !== true) {
          setErr(made?.error ?? '这张卡没能建起来。换个名字再试。')
          return
        }
      } else if (!fiction && (extras.length > 0 || relationText !== '')) {
        // 已经有卡的话，把这次点的关系补进去（别把原来写的覆盖成空）
        const got = await call('card.get', { path: existing.path })
        if (got?.ok) {
          const data = { ...got.data }
          // 只在还没写过关系的时候补一句。已经写着的不动——重名撞上的那张卡
          // 原本写「父亲」，这次手滑点了「朋友」，也不该把旧的改掉。
          if (relationText !== '' && String(data.relation ?? '').trim() === '') data.relation = relationText
          if (extras.length > 0) {
            const before = Array.isArray(data.relation_extra) ? data.relation_extra : []
            data.relation_extra = [...new Set([...before, ...extras])]
          }
          await call('card.save', { path: existing.path, data, sections: got.sections ?? [] })
        }
      }
      setAboutId(existing?.id ?? id)
      const p = await call('interview.plan', { about: existing?.id ?? id, relation, limit: 3, kind: fiction ? 'fictional' : 'real' })
      if (p?.ok !== true) {
        // 问题没准备出来（多半是 AI 那边没响应）。这时候刚建的那张空卡要收回去：
        // 留着它就是列表里一张名字对、点开什么都没有的卡，用户下次还会再建一张。
        // 本来就有的卡不动——那张卡上有他自己写的东西。
        if (existing === undefined && typeof made?.path === 'string' && made.path !== '') {
          try { await call('card.delete', { path: made.path, reason: '访谈没能开始，撤掉这次建的空卡' }) } catch (e) { /* 撤不掉也不该挡住这句话 */ }
        }
        setErr(`${p?.error ?? '没法准备问题'}。${existing === undefined ? '刚才建的那张空卡已经撤掉了，' : ''}过一会儿再点一次「开始」。`)
        setPhase('pick')
        return
      }
      setPlan(p)
      setQueue(p.next ?? [])
      setCurrent((p.next ?? [])[0] ?? null)
      // 一句都没得问（这张卡已经写满了）：结束页比一个空白的提问框诚实。
      setPhase((p.next ?? []).length === 0 ? 'done' : 'talk')
      setLog([{ role: 'bot', text: `好，我们开始。\n一次问一件小事，想不起来就跳过。` }])
    } catch (e) {
      setErr(humanizeError(e))
    } finally { setBusy(false) }
  }

  const advance = async (status, reason) => {
    if (current === null) return
    const q = current
    setBusy(true); setErr(null)
    try {
      const rec = await call('interview.record', {
        about: aboutId,
        q: q.id,
        ask: q.ask,
        answer: status === 'answered' ? answer : '',
        status,
        reason,
        fills: q.fills,
      })
      // 记不下来就别往下走。以前这里不看结果：盘写不进去（文件夹被挪走、
      // 变成只读）时界面照样把这一问答进对话、照样跳下一题，用户答了半小时，
      // 回头一看一条都没有。宁可停在这里说清楚。
      if (rec?.ok !== true) {
        setErr(rec?.error ?? '这一句没记上。检查一下文件夹还在不在，再点一次。')
        return
      }
      // interview.record 会把你这一场的问答另存成一份材料。攒着它的路径，
      // 结束页「整理进卡里」必须带上——分析页一条不勾等于「全读」，
      // 别人说的那些也会被读进这张卡。
      if (typeof rec.material === 'string' && rec.material !== '') {
        setMaterialPaths((prev) => (prev.includes(rec.material) ? prev : [...prev, rec.material]))
      }
      if (status === 'answered') {
        setLog((prev) => [...prev, { role: 'bot', text: q.ask, options: q.options }, { role: 'me', text: answer.trim() }])
      } else {
        setLog((prev) => [...prev, { role: 'bot', text: q.ask, options: q.options }, { role: 'me', text: status === 'skipped' ? (reason === 'sealed' ? '（这个不想说）' : '（跳过）') : '（以后再说）' }])
      }
      setAnswer('')
      // 队列推进
      const rest = queue.slice(1)
      if (rest.length === 0) {
        const p = await call('interview.plan', { about: aboutId, relation, limit: 3, kind: fiction ? 'fictional' : 'real' })
        // 没问着问题不等于问完了。以前这里不看结果：AI 没连上、模型抽风、
        // 文件夹读不出来，界面都会直接跳到结束页，还写「现在写满了 undefined%」。
        if (p?.ok !== true) {
          setErr(`${p?.error ?? '想不出下一题'}。刚才那一句已经记下了，这里是没接上——过一会儿点「再问一题」接着来。`)
          return
        }
        setPlan(p)
        setQueue(p.next ?? [])
        setCurrent((p.next ?? [])[0] ?? null)
        if ((p.next ?? []).length === 0) {
          setPhase('done')
          await onRecorded()
        } else {
          setLog((prev) => [...prev, { role: 'bot', text: `这一组答完了。${p.remaining > 0 ? `还能再问 ${p.remaining} 件。` : ''}` }])
        }
      } else {
        setQueue(rest)
        setCurrent(rest[0])
      }
      await onRecorded()
    } catch (e) {
      setErr(humanizeError(e))
    } finally { setBusy(false) }
  }

  // 「结束这次访谈」是整场收工，不是「跳过」的另一个说法：输入框里已经写好的
  // 那句不会存进去。以前这个按钮挤在「跳过 / 不想说」旁边，手一滑整场就没了、
  // 写了一半的话跟着丢，结束页还说「你说的都记下来了」。现在它挪到顶上单独一格，
  // 稿子非空时再问一句才走。
  const endSession = () => {
    const pending = answer.trim()
    if (pending !== '') {
      const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
        ? window.confirm('这一题还没点「记下」，现在结束就不会存它了。\n\n确定结束？')
        : true
      if (!ok) return
      setDropped(true)
      setAnswer('')
    }
    setPhase('done')
  }

  // 从卡页点「接着聊」进来：正在按这张卡已有的内容准备问题。
  // 这一屏一般只闪一下；出错时把话说清楚，并能退回去自己挑关系重来。
  if (phase === 'prep') {
    const target = String(preset?.name ?? name).trim()
    return h('div', { className: 'lc-pad lc-stack' },
      h('div', { className: 'lc-empty' },
        h('div', { className: 'lc-empty-icon', style: { background: accentSoft, color: accent } }, h(Icon, { name: 'chat', size: 22 })),
        h('h3', null, target === '' ? '正在准备问题…' : `接着聊 ${target}`),
        h('div', { className: 'lc-meta' }, '这张卡已经写过的，就不再问了。'),
      ),
      err === null ? null : h(Note, { tone: 'err', icon: 'warning' }, err),
      err === null
        ? h(Spinner)
        : h('div', { className: 'lc-stack' },
            // 直接再跑一次准备，不能写成 setPhase('prep')：这一屏的相位本来就
            // 是 prep，同值 setState 会被 React 忽略，按钮按了没反应。
            h(Btn, { tone: 'primary', block: true, onClick: () => { setErr(null); start() }, disabled: busy }, busy ? '正在准备…' : '再试一次'),
            // 退路必须一直有：虚构那两扇门里没有关系可挑，但至少能回去改名字。
            h(Btn, { block: true, onClick: () => setPhase('pick') }, fiction ? '重新填一下名字' : '我自己挑一下关系'),
          ),
    )
  }

  if (phase === 'pick') {
    const lockedName = (preset?.name ?? '').trim() !== ''
    return h('div', { className: 'lc-pad lc-stack' },
      h('div', { className: 'lc-empty', style: { paddingBottom: 8 } },
        h('div', { className: 'lc-empty-icon', style: { background: accentSoft, color: accent } }, h(Icon, { name: fiction ? 'book' : 'chat', size: 22 })),
        h('h3', null, lockedName ? `接着聊 ${preset.name}` : (fiction ? '边聊边立一个人' : '边聊边建一张卡')),
        h('div', { className: 'lc-meta' }, '它一次只问一件具体的小事。', h('br'), '答不上来就跳过；说了「不想说」的，以后不会再问。'),
      ),
      // 一句话说清「现在建的是哪一种人」，靠颜色和那一行字区分，
      // 免得在酒馆里建着建着，以为自己在补现实里那个人。
      h(Note, { tone: undefined, icon: fiction ? 'book' : 'person' },
        fiction
          ? (mode === 'tavern' ? '你在立一个可以演的虚构角色。它不是现实里的谁，写多离谱都行。' : '你在立一个小说角色。它不是现实里的谁，写多离谱都行。')
          : '你在记录一个现实里的人。卡上写什么，最好都是他真有过的事。'),
      lockedName
        ? h(Note, { tone: undefined, icon: 'person' }, `正在给「${preset.name}」补内容。`)
        : h(Field, { label: fiction ? 'TA 叫什么' : '他叫什么' },
            h('input', {
              className: 'lc-input', value: name, onChange: (e) => setName(e.target.value),
              placeholder: fiction ? '林小雨 / 老刀 / 阿澜' : '妈 / 爷爷 / 老张', spellCheck: false,
            }),
          ),
      // 四个最常用的词并排放，一行就完事。
      // 剩下那些（爷爷、老师、同事、隔壁王叔）不铺成按钮，直接在下面一行里写——
      // 十四个人排成一片按钮，看着像在填表，不像在说一个人。
      fiction ? null : h(Field, { label: '他是我的什么人' },
        h('div', { className: 'lc-chips' },
          RELATION_QUICK.map((r) => h('button', {
            key: r.id,
            type: 'button',
            className: `lc-chip ${!typing && relation === r.id ? 'on' : ''}`,
            onClick: () => { setRelation(r.id); setCustomRelation(''); setCustomFocus(false) },
          }, r.label)),
        ),
        h('input', {
          className: `lc-input ${typing ? 'picked' : ''}`,
          style: { marginTop: 8 },
          value: customRelation,
          onFocus: () => setCustomFocus(true),
          onBlur: () => setCustomFocus(false),
          onChange: (e) => {
            const v = e.target.value
            setCustomRelation(v)
            // 手写了就用手写的：上面那四个词随之取消选中。
            setRelation(v.trim() === '' ? relation : 'custom')
          },
          placeholder: '或者直接写：爷爷 / 高中班主任 / 隔壁王叔',
          spellCheck: false,
        }),
      ),
      // 「还有什么」平时只露一行灰字，点开才有输入框。
      // 大多数卡只有一个身份，这条一直摊开着会显得每张卡都缺东西。
      fiction ? null : h('div', { className: 'lc-more' },
        showExtras
          ? h('div', null,
              h('input', {
                className: 'lc-input',
                value: extrasText,
                onChange: (e) => setExtrasText(e.target.value),
                placeholder: '也是伴侣、也是家人、也是同事…',
                spellCheck: false,
              }),
              h('div', { className: 'lc-meta', style: { marginTop: 4 } },
                '好友也可以是伴侣，家人也可以是伴侣。有就写，没有就不写。'),
            )
          : h('button', {
              type: 'button',
              className: 'lc-more-open',
              onClick: () => setShowExtras(true),
            }, '还有什么'),
      ),
      fiction
        ? h('div', { className: 'lc-meta' }, '第一问从「TA 怎么说话」开始——那是演和写最先要用上的。')
        : h('div', { className: 'lc-meta' },
            relations.find((r) => r.id === relation)?.hint ?? '随便点一个最贴的。这一句只决定先问什么，不决定他的身份。'),
      err === null ? null : h(Err, { text: err }),
      h(Btn, { tone: fiction ? fictionTone : 'interview', big: true, block: true, onClick: start, disabled: busy, icon: 'send' }, busy ? '准备中…' : '开始聊'),
    )
  }

  if (phase === 'done') {
    return h('div', { className: 'lc-pad lc-stack' },
      h('div', { className: 'lc-empty' },
        h('div', { className: 'lc-empty-icon', style: { background: fiction ? accentSoft : 'var(--lc-doctor-soft)', color: fiction ? accent : 'var(--lc-doctor)' } }, h(Icon, { name: 'check', size: 22 })),
        h('h3', null, '这一轮问完了'),
        h('div', { className: 'lc-meta' }, plan === null ? '' : `现在写满了 ${plan.coverage}%`),
      ),
      plan === null
        ? (dropped === true
            ? h(Note, { tone: undefined, icon: 'warning' }, '刚才那一题没点「记下」，没有存进去。')
            : null)
        : h(Note, { tone: dropped === true ? undefined : 'ok', icon: dropped === true ? 'warning' : 'check' },
            dropped === true
              ? '刚才那一题没点「记下」，没有存进去。点过「记下」「跳过」的那些都在。'
              : '你说的都记下来了。'),
      plan === null || (plan.empty ?? []).length === 0
        ? null
        : h('div', { className: 'lc-meta' }, `还空着：${(plan.empty ?? []).slice(0, 8).join('、')}`),
      h(Btn, { tone: 'primary', big: true, block: true, onClick: () => onAnalyze({ id: aboutId, name: preset?.name ?? name, materials: materialPaths }) }, '把刚才说的整理进卡里'),
      h(Btn, { block: true, onClick: () => { onDone() } }, '先这样，回头再说'),
      h('div', { className: 'lc-meta', style: { textAlign: 'center' } }, '你说的每句话都存成了材料。整理时会标出原文出处，编不出来的。'),
    )
  }

  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
    // 整场收工的按钮放在最上面那一行，不和「记下 / 跳过 / 不想说」挤在一起：
    // 那三个是「这一题怎么处理」，这个是「整场结束」，本来就不同类。
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--lc-line)', background: 'var(--lc-panel)' } },
      h('div', { className: 'lc-meta', style: { flex: '1 1 auto', color: fiction ? accent : undefined } }, `正在聊「${preset?.name ?? name}」${fiction ? '（虚构的角色）' : ''}`),
      h(Btn, { size: 'sm', tone: 'ghost', icon: 'stop', onClick: endSession, disabled: busy }, '结束这次访谈'),
      h('div', { className: 'lc-meta' }, '（这一题不记）'),
    ),
    h('div', { ref: scrollRef, className: 'lc-body lc-pad lc-stack', style: { flex: '1 1 auto' } },
      log.map((entry, n) => entry.role === 'bot'
        ? h('div', { key: n, className: 'lc-stack' },
            h('div', { className: 'lc-bubble bot' }, h('div', { style: { whiteSpace: 'pre-wrap' } }, entry.text)),
            (entry.options ?? []).length > 0
              ? h('div', { className: 'lc-stack', style: { marginTop: 4 } },
                  entry.options.map((opt, k) => h('button', {
                    key: k, className: 'lc-opt', type: 'button',
                    onClick: () => setAnswer(opt),
                  }, h('span', { className: 'lc-opt-num' }, String(k + 1)), h('span', null, opt))))
              : null,
          )
        : h('div', { key: n, className: 'lc-bubble me' }, h('div', { style: { whiteSpace: 'pre-wrap' } }, entry.text))),

      current === null ? null : h('div', { className: 'lc-stack', style: { marginTop: 10 } },
        (current.options ?? []).length > 0
          ? h('div', { className: 'lc-meta' }, '选一个，或者直接在下面写自己的：')
          : null,
        (current.options ?? []).map((opt, k) => h('button', {
          key: k, className: 'lc-opt', type: 'button', onClick: () => setAnswer(opt),
        }, h('span', { className: 'lc-opt-num' }, String(k + 1)), h('span', null, opt))),
        current.why === undefined ? null : h('div', { className: 'lc-meta' }, `（问这个是因为：${current.why}）`),
      ),
    ),
    h('div', { style: { padding: 10, borderTop: '1px solid var(--lc-line)', background: 'var(--lc-panel)' } },
      err === null ? null : h('div', { style: { marginBottom: 6 } }, h(Err, { text: err })),
      h('textarea', {
        className: 'lc-textarea', style: { minHeight: 62, marginBottom: 6 },
        value: answer, onChange: (e) => setAnswer(e.target.value),
        placeholder: current === null ? '' : '想到什么写什么，越具体越好…（按 ⌘ + Enter 直接提交）',
        onKeyDown: (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && answer.trim() !== '') advance('answered') },
      }),
      h('div', { className: 'lc-row' },
        h(Btn, { tone: 'primary', size: 'sm', icon: 'send', disabled: busy || answer.trim() === '', onClick: () => advance('answered') }, '记下'),
        h(Btn, { size: 'sm', icon: 'skip', disabled: busy, onClick: () => advance('skipped') }, '跳过'),
        h(Btn, { size: 'sm', icon: 'stop', disabled: busy, onClick: () => advance('skipped', 'sealed') }, '不想说'),
        h('div', { className: 'lc-grow' }),
        busy ? h(Spinner) : null,
      ),
    ),
  )
}

// ── 添加（导入 + 贴文字）──────────────────────────────────────────

function ImportView({ busy, onImport, onAnalyze, listing }) {
  const [drag, setDrag] = useState(false)
  const [tab, setTab] = useState('card')
  const inputRef = useRef(null)
  const [skipNote, setSkipNote] = useState('')

  const handleFiles = (fileList) => {
    const all = Array.from(fileList ?? [])
    const files = all.filter((f) => /\.(png|json|charx|zip)$/i.test(f.name))
    // 以前过滤完直接就 return：拖进来的是一张 jpg 头像或一份 md 设定，
    // 界面上什么都不发生，用户只会以为这块坏了。
    setSkipNote(files.length > 0 || all.length === 0
      ? ''
      : `这些认不出来：${all.map((f) => f.name).join('、')}。只认角色卡文件（.png / .json / .charx / .zip）。想贴一段文字，就切到上面「一段文字」。`)
    if (files.length === 0) return
    onImport(files)
  }

  return h('div', { className: 'lc-pad lc-stack' },
    h('div', { className: 'lc-row' },
      h(Btn, { tone: tab === 'card' ? 'primary' : undefined, size: 'sm', icon: 'card', onClick: () => setTab('card') }, '角色卡文件'),
      h(Btn, { tone: tab === 'text' ? 'primary' : undefined, size: 'sm', icon: 'book', onClick: () => setTab('text') }, '一段文字'),
    ),

    // 两边都常驻，只把不在前面的那一边藏起来。
    // 以前是按 tab 条件挂载：粘了一长篇访谈稿，手滑点一下「角色卡文件」
    // 再点回来，TextImport 整个被卸载，输入全丢了——既没提示，也没有草稿。
    h('div', { className: 'lc-stack', style: tab === 'card' ? undefined : { display: 'none' } },
      h('div', {
        className: 'lc-empty',
        style: {
          border: `2px dashed ${drag ? 'var(--lc-import)' : 'var(--lc-line-strong)'}`,
          borderRadius: 'var(--lc-radius)',
          background: drag ? 'var(--lc-import-soft)' : 'transparent',
          transition: 'all .15s', cursor: 'pointer',
        },
        onClick: () => inputRef.current?.click(),
        onDragOver: (e) => { e.preventDefault(); setDrag(true) },
        onDragLeave: () => setDrag(false),
        onDrop: (e) => { e.preventDefault(); setDrag(false); handleFiles(e.dataTransfer?.files) },
      },
        h('div', { className: 'lc-empty-icon', style: { background: 'var(--lc-import-soft)', color: 'var(--lc-import)' } }, h(Icon, { name: 'import', size: 22 })),
        h('h3', null, drag ? '松手就行' : '把文件拖到这里，或者点一下去选'),
        h('div', { className: 'lc-meta' }, '别人给你的角色卡都能读——图片也行，导出的文件也行。', h('br'), '可以一次选好几个。'),
        h('input', {
          ref: inputRef, type: 'file', multiple: true, accept: '.png,.json,.charx,.zip',
          style: { display: 'none' }, onChange: (e) => handleFiles(e.target.files),
        }),
      ),
      skipNote === '' ? null : h(Note, { tone: 'warn', icon: 'warning' }, skipNote),
      busy === 'import' ? h('div', { className: 'lc-row' }, h(Spinner), h('span', { className: 'lc-meta' }, '正在读…')) : null,
      h(Note, { tone: undefined, icon: 'check' }, '导入进来的卡会原样保留所有内容，包括这个软件不认识的字段。你在这里改过的部分才会变，导出时一起带走。'),
    ),
    h('div', { className: 'lc-stack', style: tab === 'text' ? undefined : { display: 'none' } },
      h('div', { className: 'lc-meta' }, '访谈稿、聊天记录、日记、你写的散文——什么都可以。存进来之后，可以让 AI 读出里面的信息。'),
      h(TextImport, { onAnalyze }),
    ),
  )
}

/** 贴文本 / 选文件 → 存成材料。 */
function TextImport({ onAnalyze }) {
  const [about, setAbout] = useState('')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const fileRef = useRef(null)
  // 这张卡是真人还是虚构角色：决定读出来的东西往哪种卡里放。
  const [kind, setKind] = useState('real')

  const save = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await call('import.text', { about, content: text, name: about })
      if (r.ok !== true) { setMsg({ tone: 'err', text: r.error ?? '没存上' }); return }
      // 把刚存的那一份的位置记住：下一步「让 AI 读一读」要直接勾上它，
      // 否则用户到了那边还得在一堆材料里猜哪份才是刚才的。
      setMsg({ tone: 'ok', text: `存好了（${r.chars} 字）。`, path: r.path })
      setText('')
    } catch (e) { setMsg({ tone: 'err', text: humanizeError(e) }) } finally { setBusy(false) }
  }

  const pickFile = async (file) => {
    if (file === undefined) return
    setBusy(true); setMsg(null)
    try {
      const content = await file.text()
      setText(content)
      if (about === '') setAbout(file.name.replace(/\.[^.]+$/, ''))
      setMsg({ tone: undefined, text: `读进来了（${content.length} 字）。确认「这是关于谁」之后点保存。` })
    } catch (e) { setMsg({ tone: 'err', text: humanizeError(e) }) } finally { setBusy(false) }
  }

  return h('div', { className: 'lc-fset' },
    h('div', { className: 'lc-meta', style: { lineHeight: 1.7 } },
      '把一大段话贴进来——小说片段、人物小传、你随口讲的关于某个人的事都行。',
      h('br'),
      '存完点「让 AI 读一读」，它会把里面的信息整理成一张卡。只认原文里写过的，编的会被丢掉。'),
    h(Field, { label: '这是要建成什么人' },
      h('div', { className: 'lc-row' },
        h(Btn, { size: 'sm', tone: kind === 'real' ? 'interview' : undefined, onClick: () => setKind('real') }, '现实里的人'),
        h(Btn, { size: 'sm', tone: kind === 'fictional' ? 'import' : undefined, onClick: () => setKind('fictional') }, '小说 / 角色'),
      ),
      h('div', { className: 'lc-meta', style: { marginTop: 4 } },
        kind === 'real' ? '建成现实里的人：卡上写什么，最好都是他真有过的事。' : '建成虚构角色：可以拿去写小说，也可以拿去酒馆里演。'),
    ),
    h(Field, { label: '这是关于谁的' },
      h('div', { className: 'lc-row' },
        h('input', { className: 'lc-input', value: about, onChange: (e) => setAbout(e.target.value), placeholder: '爷爷', spellCheck: false }),
        h(Btn, { size: 'sm', icon: 'folder', onClick: () => fileRef.current?.click() }, '选文件'),
        h('input', { ref: fileRef, type: 'file', accept: '.txt,.md,.json,.csv', style: { display: 'none' }, onChange: (e) => pickFile(e.target.files?.[0]) }),
      ),
    ),
    h(Field, { label: '内容', hint: '直接粘进来就行。' },
      h('textarea', { className: 'lc-textarea', value: text, onChange: (e) => setText(e.target.value), placeholder: '把文字贴在这里…', spellCheck: false, style: { minHeight: 120 } }),
    ),
    h('div', { className: 'lc-row' },
      h(Btn, { tone: 'primary', icon: 'check', onClick: save, disabled: busy || text.trim() === '' || about.trim() === '' }, busy ? '正在存…' : '存起来'),
      msg === null ? null : h('span', { className: 'lc-meta', style: { color: msg.tone === 'err' ? 'var(--lc-danger)' : msg.tone === 'ok' ? 'var(--lc-doctor)' : 'var(--lc-muted)' } }, msg.text),
    ),
    msg?.tone === 'ok'
      ? h('div', null, h(Btn, {
          tone: 'analyze', size: 'sm', icon: 'spark',
          onClick: () => onAnalyze?.({ name: about.trim(), path: msg?.path, kind }),
        }, '让 AI 读一读'))
      : null,
  )
}

// ── 从记忆里认人 ──────────────────────────────────────────────────

/**
 * 记忆页。做三件事：认人 → 给人看一眼 → 把勾上的人落成材料。
 *
 * 为什么中间非要停一下给用户看：
 * 记忆里关于一个人的话往往只有一两句，而且常混在别的事情里。
 * 直接建卡会造出一排空卡，看着像成功、其实什么也不能用。
 * 摆出来、标清楚每人缺什么，用户自己决定哪些值得现在做。
 */
function MemoryView({ onDone, onBack }) {
  const [scan, setScan] = useState(null)
  const [picked, setPicked] = useState(null) // null = 还没选过，等于全选
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [msg, setMsg] = useState(null)
  // 提取完每人一份材料之后，这里列出「谁已经准备好了」，每人后面挂一个
  // 「让 AI 读这个人的」。没有这一栏，用户点完「存成材料」就断了线，
  // 得自己回首页想「刚存的东西在哪」。
  const [made, setMade] = useState(null)

  useEffect(() => {
    let alive = true
    call('memory.scan', {}).then((r) => {
      if (alive !== true) return
      if (r.ok !== true) { setErr(r.error ?? '没读出来'); return }
      setScan(r)
      // 默认全选：认出的人本来就不多，一个个点反而累
      setPicked((r.people ?? []).map(peopleKey))
    }).catch((e) => { if (alive === true) setErr(humanizeError(e)) })
    return () => { alive = false }
  }, [])

  const people = scan?.people ?? []
  const chosen = picked === null ? people.map(peopleKey) : picked

  // 说清是在哪儿翻的。这两个数字来自两份不同的东西：
  // 记忆文件是软件自己记的，项目档案是你自己写过的文章。
  // 混成一句话，用户会以为软件翻了他别的文件夹。
  const where = []
  if ((scan?.memory_files ?? 0) > 0) where.push(`${scan.memory_files} 个记忆文件`)
  if ((scan?.archive_files ?? 0) > 0) where.push(`${scan.archive_files} 篇项目档案`)
  const whereText = where.length === 0 ? '' : `在${where.join('和')}里，`

  // 一个人一份材料。分开存，之后让 AI 读某一个人时它手上只有关于这个人的
  // 句子，不会把别人的事混进来。
  const extractChosen = async () => {
    setBusy(true); setErr(null); setMsg(null); setMade(null)
    try {
      const r = await call('memory.extract', { people: chosen })
      if (r.ok !== true) { setErr(r.error ?? '没存上'); return }
      setMade(r.files ?? [])
      setMsg({ tone: 'ok', text: `存好了，一人一份，共 ${r.count} 份。${r.incomplete > 0 ? `其中 ${r.incomplete} 个人的材料还不全。` : ''}` })
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy(false) }
  }

  if (err !== null && scan === null) {
    return h('div', { className: 'lc-pad lc-stack' }, h(Err, { text: err }), h(Btn, { onClick: onBack }, '回去'))
  }
  if (scan === null) {
    return h('div', { className: 'lc-empty' }, h(Spinner), h('div', { className: 'lc-meta', style: { marginTop: 8 } }, '正在看你写过的记忆…'))
  }
  if (scan.found !== true) {
    return h('div', { className: 'lc-pad lc-stack' },
      h(Note, { tone: undefined, icon: 'warning' }, '这台电脑上没有找到记忆文件。'),
      h('div', { className: 'lc-meta' }, '装了记忆功能、并且记过东西之后，这里会自动认出你身边的人。'),
      h(Btn, { onClick: onBack }, '回去'),
    )
  }

  return h('div', { className: 'lc-pad lc-stack' },
    h('div', { className: 'lc-meta' },
      `${whereText}认出了 ${people.length} 个人。`),

    people.length === 0
      ? h(Note, { tone: undefined, icon: 'person' }, '记忆里没有提到具体的人。可以先「陪我聊聊」，聊过的内容会变成材料。')
      : h('div', { className: 'lc-stack' },
          people.map((p) => {
            const key = peopleKey(p)
            const on = chosen.includes(key)
            return h('button', {
              key,
              type: 'button',
              className: `lc-chip ${on ? 'on' : ''}`,
              style: { display: 'block', width: '100%', textAlign: 'left', borderRadius: 10, padding: '9px 11px' },
              onClick: () => setPicked(on ? chosen.filter((k) => k !== key) : [...chosen, key]),
            },
              h('div', { className: 'lc-row' },
                h('span', { className: 'lc-grow', style: { fontWeight: 600 } }, p.name === '' ? p.kin : `${p.kin} · ${p.name}`),
                // 红点只挂在「缺东西」的人身上。不缺点也标红，等于没标。
                p.missing.length > 0
                  ? h('span', {
                      className: 'lc-tag err',
                      title: `还缺：${p.missing.join('、')}`,
                      'aria-label': `这条还不全，还缺${p.missing.join('、')}`,
                    }, `！还缺 ${p.missing.length} 样`)
                  : h(Tag, { tone: 'ok' }, '够写一张卡'),
              ),
              p.clues.length === 0 ? null : h('div', { className: 'lc-meta', style: { marginTop: 4 } },
                p.clues[0].length > 60 ? `${p.clues[0].slice(0, 60)}…` : p.clues[0]),
              // 提一句「这是在哪儿看到的」。用户会想知道「你凭什么说他是我爸」，
              // 能追回原标题，这件事才可信。
              (p.sources ?? []).length === 0 ? null : h('div', { className: 'lc-meta', style: { marginTop: 2, opacity: 0.75 } },
                `来自：${(p.sources ?? []).slice(0, 2).join('、')}${(p.sources ?? []).length > 2 ? ` 等 ${p.sources.length} 处` : ''}`),
            )
          }),
        ),

    people.length === 0 ? null : h('div', { className: 'lc-meta' },
      '勾上的人会先变成一份材料，不会直接生成卡。你可以先看看 AI 从里面读出了什么，再决定采纳哪几条。'),

    err === null ? null : h(Err, { text: err }),
    msg === null ? null : h(Note, { tone: msg.tone, icon: 'check' }, msg.text),

    // 存完之后一人一行，各自能直接开始分析。
    // 这一步是整个流程的关节：认出人 → 一人一份材料 → 挑一个人让 AI 读。
    made === null || made.length === 0
      ? null
      : h('div', { className: 'lc-stack' },
          h('div', { className: 'lc-meta' }, '接下来挑一个人，让 AI 只读他那份。'),
          made.map((f) => h('div', { key: f.key, className: 'lc-row', style: { alignItems: 'center' } },
            h('span', { className: 'lc-grow' },
              f.label,
              (f.missing ?? []).length === 0
                ? null
                : h('span', { className: 'lc-meta' }, ` · 还缺 ${f.missing.length} 样`)),
            // 连材料路径一起带过去：只带人名的话，分析页那份「读哪些材料」
            // 会一个都不勾，而「一个都不勾」的意思是全读——妈妈、同事、别人
            // 日记的材料会一起读进来，结果全挂到这个人名下。
            h(Btn, { size: 'sm', tone: 'analyze', icon: 'spark', onClick: () => onDone?.({ id: f.id, name: f.label, path: f.path }) }, '让 AI 读 TA'),
            // 正好在这里也能删：刚生成、扫一眼就知道不对的那一份，不必再回首页找。
            h(Btn, {
              size: 'sm', ghost: true, icon: 'trash', title: '删掉这一份',
              onClick: async () => {
                try {
                  const r = await call('material.delete', { path: f.path })
                  if (r?.ok === true) setMade(made.filter((x) => x.key !== f.key))
                  else setErr(r?.error ?? '没删掉')
                } catch (e) { setErr(humanizeError(e)) }
              },
            }, '删'),
          )),
        ),

    h('div', { className: 'lc-row' },
      people.length === 0
        ? null
        : h(Btn, { tone: 'primary', icon: 'check', onClick: extractChosen, disabled: busy || chosen.length === 0 }, busy ? '正在存…' : `存成材料（${chosen.length} 份）`),
      h('div', { className: 'lc-grow' }),
      h(Btn, { onClick: onBack }, '回去'),
    ),
  )
}

/** 一个人的唯一标识。同名不同关系要分开，所以关系词也算进去。 */
function peopleKey(p) {
  return p.name === '' || p.name === undefined ? String(p.kin) : `${p.kin}:${p.name}`
}

// ── 让 AI 读材料 ──────────────────────────────────────────────────

function AnalyzeView({ listing, state, flash, onProposal, presetAbout, presetMaterials, onBack, onNeedMaterial, onAppliedCard }) {
  const materials = listing?.materials ?? []
  const cards = listing?.cards ?? []
  // 从别的页带过来的人，可能只有一个名字：材料刚存下、卡还没建。
  // 这种也该直接开始读——读出来的东西先进「建议」，采纳时才建卡。
  // 以前只认 id，名字到了这边就断掉，用户看到的是一张空的选择框。
  const presetId = String(presetAbout?.id ?? '').trim()
  const presetName = String(presetAbout?.name ?? '').trim()
  const [about, setAbout] = useState(presetId !== '' ? presetId : presetName)
  // 带过来的材料可能是一份，也可能是好几份（访谈一路上记下来的）。
  // 不认数组的话会变成「[一份, 另一份]」被当成一个路径，一条都勾不上，
  // 而一条都不勾等于全读。
  const [chosen, setChosen] = useState(() => {
    if (Array.isArray(presetMaterials)) return presetMaterials.filter((x) => typeof x === 'string' && x !== '')
    return presetMaterials === undefined || presetMaterials === null ? [] : [presetMaterials]
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [result, setResult] = useState(null)
  // 「想要什么样的人」。默认收起：它只影响取舍和提问，不是必填项，
  // 一进来就摊在面前会让人以为不填就不准分析。
  const [concept, setConcept] = useState(null)
  const [showConcept, setShowConcept] = useState(false)
  const [savingConcept, setSavingConcept] = useState(false)

  // 只有一张卡的时候不用问，直接就是它。有好几张的时候故意不选：
  // 自动挑第一张，用户没注意就点了「开始读」，材料就整理到别人卡上了。
  useEffect(() => {
    if (about === '' && cards.length === 1) setAbout(cards[0].id)
  }, [cards, about])

  useEffect(() => {
    let alive = true
    call('concept.get', {}).then((r) => {
      if (alive === true && r.ok === true && r.concept !== null && r.concept !== undefined) setConcept(r.concept)
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  // 草稿只在本地改，收起面板（或点「存一下」）时才落盘。
  // 每敲一个字都发一次网络请求，在弱的机器上会让输入明显卡顿。
  const [conceptDraft, setConceptDraft] = useState(null)
  const shownConcept = conceptDraft !== null ? conceptDraft : concept

  // 打字打到一半、没点「存一下」就离开这一页（点返回、切到别人的卡）：
  // 输入框的 onBlur 一般能赶上，但按钮点下去和卸载谁先谁后不保证。
  // 卸载时补存一次，别让刚想出来的那句话白写。
  const conceptDraftRef = useRef(null)
  conceptDraftRef.current = conceptDraft
  // 下面这两个特意放在所有 hook 之后：上面那些槽位是有测试按号码摆状态的，
  // 中间插一个新 state 会让它们全体错位（conceptDraft 就是被这么挪过一次）。
  const [oneClick, setOneClick] = useState('')
  // 这一趟读的是虚构角色还是真人：虚构的才给「直接建成卡」，
  // 真人的卡要人自己填关系那些，不能一键生成。
  const isFiction = String(presetAbout?.kind ?? '').trim() === 'fictional'
  useEffect(() => () => {
    const pending = conceptDraftRef.current
    if (pending === null || pending === undefined) return
    call('concept.set', { concept: pending }).catch(() => {})
  }, [])

  // 这一趟到底等了多久，明明白白数给人看。
  // 只说「正在读…」的话，超过半分钟人就开始怀疑卡死，去点第二次；
  // 两个请求叠在一起，后台更慢，看起来就更像卡死。
  const [waited, setWaited] = useState(0)
  useEffect(() => {
    if (busy !== true) { setWaited(0); return undefined }
    const timer = setInterval(() => setWaited((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [busy])

  const flushConcept = async (value) => {
    const next = value ?? conceptDraft ?? concept
    setConceptDraft(null)
    setConcept(next)
    setSavingConcept(true)
    try {
      const r = await call('concept.set', { concept: next })
      if (r.ok !== true) setErr(r.error ?? '没存上')
    } catch (e) { setErr(humanizeError(e)) } finally { setSavingConcept(false) }
  }

  // 选择框里的候选人：有卡的用卡，没卡但带了名字的，就把名字当成一项。
  const people = cards.map((c) => ({ value: c.id, label: c.name }))
  if (about !== '' && !people.some((p) => p.value === about) && !cards.some((c) => String(c.name ?? '').trim() === about)) {
    people.unshift({ value: about, label: about })
  }

  const toggleConcept = () => {
    if (showConcept === true && conceptDraft !== null) flushConcept(conceptDraft)
    setShowConcept(!showConcept)
  }

  // ListEditor 给的是 [{label}]，concept 里存的是纯字符串。两个方向都要转。
  const asLabels = (list) => (Array.isArray(list) ? list : []).map((x) => (typeof x === 'string' ? { label: x } : x))
  const asStrings = (list) => (Array.isArray(list) ? list : []).map((x) => (typeof x === 'string' ? x : x?.label ?? '')).filter((x) => String(x).trim() !== '')

  // 勾选框默认全是勾上的（「全读」）。此时点某一份的意思是「这一份不要」，
  // 不是「只要这一份」——以前就是后者，用户点一下想取消一份，结果只读了
  // 那一份，还以为读的是全部。
  const toggleMaterial = (path) => {
    setChosen((prev) => {
      if (prev.length === 0) return materials.map((m) => m.path).filter((p) => p !== path)
      if (prev.includes(path)) return prev.filter((p) => p !== path)
      const next = [...prev, path]
      // 全勾回来时收回「一个都没选」的表示，界面才会如实显示「全读」
      return next.length === materials.length ? [] : next
    })
  }

  // 选了哪几份就按哪几份算字数：「一条都不勾 = 全读」。
  const readChars = (chosen.length > 0 ? materials.filter((m) => chosen.includes(m.path)) : materials)
    .reduce((sum, m) => sum + (Number(m.chars) || Number(m.size) || 0), 0)
  const longRead = readChars > 20000

  const run = async () => {
    // 「这一趟等了多久」从这里算。以前写成 startedAt 却没有声明，后台一连不上
    // 就在 catch 里抛 ReferenceError，setErr 永远走不到——用户只看到按钮弹回来，
    // 一句解释都没有。
    const startedAt = Date.now()
    // 「想突出的 / 不想要的」那一栏是边打边存的草稿，只有点「存一下」或失焦
    // 才落盘。改了字直接点「开始读」，以前用的还是上一次存的那份——读出来
    // 的东西跟屏幕上写的不一样，用户会以为 AI 没看懂。
    const conceptForRun = conceptDraft !== null ? conceptDraft : concept
    if (conceptDraft !== null) flushConcept(conceptDraft)
    setBusy(true); setErr(null); setResult(null)
    try {
      const r = await call('analyze.run', {
        about,
        // about 可能是卡 id，也可能只是个名字（还没建卡）。两种都照实传。
        name: cards.find((c) => c.id === about)?.name ?? about,
        materials: chosen.length > 0 ? chosen : undefined,
        concept: conceptForRun === null ? undefined : conceptForRun,
        // 这个人是真人还是虚构角色：采纳时如果卡还不存在，就按这个身份现建。
        kind: String(presetAbout?.kind ?? '').trim() === 'fictional' ? 'fictional' : 'real',
      })
      if (r.ok !== true) { setErr(r.error ?? '没跑成'); return }
      setResult(r)
      flash(`读出了 ${r.accepted} 条${r.rejected > 0 ? `，${r.rejected} 条没能核实已丢掉` : ''}`)
    } catch (e) {
      // 「连不上后台」在等了几分钟之后出现，真实原因通常不是没启动，
      // 而是 AI 那边卡住了、连接被断开。说实话比说套话有用。
      const raw = String(e?.message ?? e ?? '')
      const slow = /fetch failed|failed to fetch|networkerror|load failed/i.test(raw) && Date.now() - startedAt > 60000
      setErr(slow
        ? '这一趟等太久了，连接被断开了——多半是这台机器上的 AI 卡住了，不是你的材料有问题。过一会儿再点一次；一直这样的话，直接手写卡也一样能建。'
        : humanizeError(e))
    } finally { setBusy(false) }
  }

  if (materials.length === 0) {
    return h('div', { className: 'lc-pad lc-stack' },
      h('div', { className: 'lc-empty' },
        h('div', { className: 'lc-empty-icon', style: { background: 'var(--lc-analyze-soft)', color: 'var(--lc-analyze)' } }, h(Icon, { name: 'spark', size: 22 })),
        h('h3', null, '还没有材料可以读'),
        h('div', { className: 'lc-meta' }, '先聊一次，或者贴一段文字进来。'),
      ),
      h(Btn, { tone: 'interview', big: true, block: true, icon: 'chat', onClick: () => onNeedMaterial() }, '去添加材料'),
      h(Btn, { block: true, onClick: onBack }, '回列表'),
    )
  }

  return h('div', { className: 'lc-pad lc-stack' },
    h('div', { className: 'lc-empty', style: { paddingBottom: 8 } },
      h('div', { className: 'lc-empty-icon', style: { background: 'var(--lc-analyze-soft)', color: 'var(--lc-analyze)' } }, h(Icon, { name: 'spark', size: 22 })),
      h('h3', null, '让 AI 读你写的材料'),
      h('div', { className: 'lc-meta' }, '它只会说材料里写过的东西，每一条都会标出原句。', h('br'), '读完先给你看，你点了才写进卡。'),
    ),

    state?.hasLlm === false
      ? h(Note, { tone: 'warn', icon: 'warning' }, '这台机器上暂时没有可用的 AI。你可以直接手动填卡，效果一样。')
      : null,

    h(Field, {
      label: '整理谁',
      hint: cards.length > 1 && about === '' ? '先选一个人。免得材料整理到别人卡上。' : undefined,
    },
      people.length === 0
        ? h('div', { className: 'lc-meta' }, '还没有卡。先建一张。')
        : h('select', { className: 'lc-select', value: about, onChange: (e) => setAbout(e.target.value) },
            people.length > 1 ? h('option', { key: '__none', value: '' }, '先选一个人') : null,
            people.map((p) => h('option', { key: p.value, value: p.value }, p.label))),
      about !== '' && cards.every((c) => c.id !== about)
        ? h('div', { className: 'lc-meta', style: { marginTop: 4 } }, `还没有「${about}」的卡。这次读出来的东西先放进「建议」，你看了觉得对，再建卡。`)
        : null,
    ),

    h('div', { className: 'lc-sec' },
      h('div', {
        className: 'lc-row',
        role: 'button', tabIndex: 0,
        style: { cursor: 'pointer', alignItems: 'center' },
        onClick: toggleConcept,
      },
        h(Icon, { name: 'chevron', size: 12, style: { transform: showConcept ? 'rotate(90deg)' : 'none', transition: 'transform .12s' } }),
        h('span', { className: 'lc-grow', style: { fontWeight: 600 } }, '你想让 TA 是什么样的人'),
        shownConcept === null
          ? h('span', { className: 'lc-tag' }, '没写')
          : h('span', { className: 'lc-tag' }, '已写'),
        savingConcept === true ? h(Spinner, { size: 12 }) : null,
      ),
      h('div', { className: 'lc-meta', style: { marginTop: 4 } }, '可选。它不会变成卡里的内容——只影响这次读材料时突出什么、还该补问什么。'),
      showConcept === false ? null : h('div', { className: 'lc-stack', style: { marginTop: 8 } },
        h(Field, { label: '一句话', hint: '比如「一个嘴上凶、心里软的老太太」。' },
          h('input', {
            className: 'lc-input',
            value: shownConcept?.idea ?? '',
            onChange: (e) => setConceptDraft({ ...(shownConcept ?? {}), idea: e.target.value }),
            onBlur: () => { if (conceptDraft !== null) flushConcept(conceptDraft) },
            placeholder: '一个不爱说话但手艺很好的人',
            spellCheck: false,
          }),
        ),
        h(Field, { label: '想突出的', hint: '一行一个。读材料时会优先找这些。' },
          h(ListEditor, {
            items: asLabels(shownConcept?.want),
            onChange: (v) => setConceptDraft({ ...(shownConcept ?? {}), want: asStrings(v) }),
            placeholder: '手很巧',
          }),
        ),
        h(Field, { label: '不想要的', hint: '一行一个。太俗套、太像宣传稿的写法写在这儿。' },
          h(ListEditor, {
            items: asLabels(shownConcept?.avoid),
            onChange: (v) => setConceptDraft({ ...(shownConcept ?? {}), avoid: asStrings(v) }),
            placeholder: '苦情戏',
          }),
        ),
        h('div', { className: 'lc-row' },
          h(Btn, { size: 'sm', icon: 'check', disabled: conceptDraft === null || savingConcept === true, onClick: () => flushConcept(conceptDraft) }, savingConcept === true ? '存着…' : '存一下'),
          shownConcept === null ? null : h(Btn, { size: 'sm', ghost: true, icon: 'trash', onClick: () => flushConcept(null) }, '清空'),
        ),
      ),
    ),

    h(Field, { label: '读哪些材料', hint: chosen.length === 0 ? '一个都不选就是全读。' : `已选 ${chosen.length} 份。` },
      h('div', { className: 'lc-stack' }, materials.map((m) => {
        const on = chosen.includes(m.path) || chosen.length === 0
        return h('div', {
          key: m.path, className: 'lc-proposal-item' + (on ? ' on' : ''),
          onClick: () => toggleMaterial(m.path), role: 'button', tabIndex: 0,
        },
          h('div', { className: `lc-check ${on ? 'on' : ''}` }, on ? h(Icon, { name: 'check', size: 11 }) : null),
          h('div', { className: 'lc-grow' },
            h('div', { style: { fontWeight: 600 } }, m.name),
            h('div', { className: 'lc-meta' }, `${Math.max(1, Math.round((m.size ?? 0) / 1024))} KB`),
          ),
        )
      })),
    ),

    err === null ? null : h(Err, { text: err }),

    h('div', { className: 'lc-row' },
      h(Btn, { tone: 'analyze', big: true, onClick: run, disabled: busy || about === '' || materials.length === 0, icon: 'spark' }, busy ? '正在读…' : '开始读'),
      busy ? h(Spinner) : null,
    ),
    // 这一趟是真等：模型先在心里想一遍再写（实测小材料也要四十秒上下，
    // 长材料一分多钟）。不给时间预期的话，转圈超过半分钟人就会以为卡死了、
    // 去点第二次，两个请求叠在一起更慢。
    busy
      ? h('div', { className: 'lc-meta' }, longRead
          ? `材料有点长（约 ${Math.round(readChars / 1000)} 千字），这一趟可能一两分钟。已经等了 ${waited} 秒，别关这一页，等它说完。`
          : `它在先想一遍再写，一般要半分钟到一分钟。已经等了 ${waited} 秒，别关这一页，等它说完。`)
      : null,

    result === null ? null : h('div', null,
      h(Note, { tone: 'ok', icon: 'check' },
        h('div', null, `读出了 ${result.accepted} 条。`),
        result.rejected > 0 ? h('div', { className: 'lc-meta', style: { marginTop: 3 } }, `另有 ${result.rejected} 条在材料里找不到原句，已经丢掉——AI 编的东西进不来。`) : null,
      ),
      // 写小说和酒馆里，用户要的是「读完就有一张能用的角色卡」，
      // 不是再去访谈一遍——虚构角色本来就没有「他是我的什么人」这种问题，
      // 那些细节它自己会从材料里编。所以这里直接给一个一键建卡的入口。
      isFiction && result.json !== undefined
        ? h('div', { style: { marginTop: 8 } },
            h(Btn, { tone: 'primary', big: true, block: true, icon: 'check', disabled: oneClick !== '', onClick: async () => {
              setOneClick('on')
              try {
                // 提案里默认一条都不勾（勾选是人的动作），所以这里要先把
                // 所有条目都勾上再采纳，否则只会得到「还没有勾选任何一条」。
                const got = await call('proposal.get', { json: result.json })
                if (got?.ok !== true) { setErr(got?.error ?? '这份建议读不出来'); return }
                const every = (got.items ?? []).map((item) => item.index).filter((n) => typeof n === 'number')
                if (every.length === 0) { setErr('这一份里没有能写进卡里的条目。'); return }
                const r = await call('proposal.apply', { json: result.json, checked: every })
                if (r?.ok !== true) { setErr(r?.error ?? '没能建成卡'); return }
                flash(`建好了，写进去 ${r.applied ?? every.length} 条`)
                if (typeof onAppliedCard === 'function' && r.path !== undefined) onAppliedCard(r.path)
              } catch (e) { setErr(humanizeError(e)) } finally { setOneClick('') }
            } }, oneClick === 'on' ? '正在建…' : '直接建成角色卡'),
            h('div', { className: 'lc-meta', style: { marginTop: 4 } }, '不用再访谈一遍。材料里读到什么就写什么，建完还能在卡上改。'),
          )
        : null,
      h('div', { style: { marginTop: 8 } },
        h(Btn, { tone: isFiction ? undefined : 'primary', big: true, block: true, icon: 'check', onClick: async () => {
          try {
            const p = await call('proposal.get', { json: result.json })
            // 读不出来当「没有新东西」会让界面绿字说「这一份里没有还没写进去的了」，
            // 用户以为 AI 什么也没读出来——照着 openProposal 的写法先判一次。
            if (p?.ok !== true) { setErr(p?.error ?? '这份建议读不出来'); return }
            onProposal(p)
          } catch (e) { setErr(humanizeError(e)) }
        } }, '看看读出了什么'),
      ),
    ),
  )
}

// ── 检查 ──────────────────────────────────────────────────────────

function DoctorView({ report, onRun, onOpenCard }) {
  const [busy, setBusy] = useState(false)
  const run = async () => { setBusy(true); try { await onRun() } finally { setBusy(false) } }

  return h('div', { className: 'lc-pad lc-stack' },
    h(Btn, { tone: 'doctor', big: true, block: true, onClick: run, disabled: busy, icon: 'doctor' }, busy ? '正在检查…' : report === null ? '开始检查' : '再检查一次'),
    h('div', { className: 'lc-meta' }, '检查你的档案里有没有写坏的地方。不会改任何东西。'),

    report === null ? null : h('div', { className: 'lc-stack' },
      report.ok === false ? h(Note, { tone: 'warn', icon: 'warning' }, '有几个地方写法不对。不影响你继续用，但会让导出和 AI 读不准。') : null,

      scoreSection(report, onOpenCard),

      h('div', { className: 'lc-sec' },
        h('div', { className: 'st' }, '这里有多少东西'),
        h('div', { className: 'lc-stack' },
          h('div', { className: 'lc-row' }, h('span', { className: 'lc-grow' }, '人物卡'), h('span', null, String(report.counts?.cards ?? 0))),
          h('div', { className: 'lc-row' }, h('span', { className: 'lc-grow' }, '世界'), h('span', null, String(report.counts?.worlds ?? 0))),
          h('div', { className: 'lc-row' }, h('span', { className: 'lc-grow' }, '人物之间的关系'), h('span', null, String(report.counts?.relations ?? 0))),
          h('div', { className: 'lc-row' }, h('span', { className: 'lc-grow' }, '材料'), h('span', null, String(report.counts?.materials ?? 0))),
        ),
      ),

      h('div', { className: 'lc-sec' },
        h('div', { className: 'st' }, 'AI 能不能用'),
        h('div', { className: 'lc-row' },
          h('span', { className: 'lc-grow' }, report.host?.services?.llm === true ? '可以用' : '用不了'),
          h(Tag, { tone: report.host?.services?.llm === true ? 'ok' : 'warn' }, report.host?.services?.llm === true ? '正常' : '缺'),
        ),
        report.host?.services?.llm === true ? null : h('div', { className: 'lc-meta' }, '「让 AI 读材料」这一步要用它。用不了也能手动填卡。'),
      ),

      (report.issues ?? []).length === 0
        ? h(Note, { tone: 'ok', icon: 'check' }, '没发现问题。')
        : h('div', null,
            h(GroupTitle, { tone: 'doctor', icon: 'warning' }, `发现 ${report.issues.length} 处`),
            h('div', { className: 'lc-stack' }, report.issues.slice(0, 40).map((i, n) => h(Note, { key: n, tone: i.level === 'error' ? 'err' : 'warn', icon: 'warning' },
              h('div', null,
                i.path === undefined ? null : h('div', { style: { fontWeight: 600 } }, `「${cardNameFromPath(i.path)}」`),
                humanizeIssue(i))))),
          ),
    ),
  )
}

/**
 * 一份档案的整体分数。
 *
 * 用的是「分数 + 几句话」的形式，不是仪表盘：这个数字唯一的作用是
 * 让人知道「现在大概几成」，真正有用的是下面那几条「去改这里」。
 */
function scoreSection(report, onOpenCard) {
  const cards = Array.isArray(report.score?.cards) ? report.score.cards : []
  if (cards.length === 0) return null
  const avg = Math.round(cards.reduce((acc, c) => acc + c.score.score, 0) / cards.length)
  const worse = cards.filter((c) => c.score.score < 90).sort((a, b) => a.score.score - b.score.score).slice(0, 5)
  const gradeWord = avg >= 90 ? '很好' : avg >= 75 ? '能用' : avg >= 55 ? '还差一点' : '需要补'
  return h('div', { className: 'lc-sec' },
    h('div', { className: 'st' }, '这份档案写得怎么样'),
    h('div', { className: 'lc-row', style: { alignItems: 'baseline' } },
      h('span', { style: { fontSize: '26px', fontWeight: 700 } }, String(avg)),
      h('span', { className: 'lc-meta', style: { marginLeft: 4 } }, '分 · ' + gradeWord),
      h('div', { className: 'lc-grow' }),
      h(Tag, { tone: avg >= 75 ? 'ok' : 'warn' }, `${cards.length} 张卡`),
    ),
    h('div', { className: 'lc-meta', style: { marginTop: 2 } }, '满分 100。低于 75 一般是内容还没填够，不是写错了。'),
    worse.length === 0
      ? h('div', { className: 'lc-meta', style: { marginTop: 6 } }, '每张卡都在 90 分以上。')
      : h('div', { className: 'lc-stack', style: { marginTop: 8 } },
          h(GroupTitle, { tone: 'doctor', icon: 'doctor' }, '还能补的卡'),
          worse.map((c) => (typeof onOpenCard === 'function'
            ? h('button', {
                key: c.path, type: 'button', className: 'lc-row', onClick: () => onOpenCard({ path: c.path, id: c.id, name: c.name }),
                style: { width: '100%', background: 'none', border: 0, padding: '4px 0', textAlign: 'left', font: 'inherit', color: 'inherit', cursor: 'pointer' },
              },
                h('span', { className: 'lc-grow lc-ellipsis' }, c.name),
                h('div', { className: 'lc-bar', style: { maxWidth: 70 } }, h('i', { style: { width: `${c.score.score}%` } })),
                h('span', { className: 'lc-meta', style: { minWidth: 30, textAlign: 'right' } }, `${c.score.score}`),
              )
            : h('div', { key: c.path, className: 'lc-row' },
                h('span', { className: 'lc-grow lc-ellipsis' }, c.name),
                h('div', { className: 'lc-bar', style: { maxWidth: 70 } }, h('i', { style: { width: `${c.score.score}%` } })),
                h('span', { className: 'lc-meta', style: { minWidth: 30, textAlign: 'right' } }, `${c.score.score}`),
              ))),
          h('div', { className: 'lc-meta', style: { marginTop: 4 } }, '点一下就能去补。补一条也算。'),
        ),
  )
}

// ── 下一步（求职 / 面试 / 简历） ────────────────────────────────────────────────────────

/** 投递状态的中文说法。和宿主侧 jobs-store.js 那份是同一套，改的时候两边一起改。 */
const TRACK_LABEL = {
  evaluated: '看过了',
  applied: '投了',
  responded: '有回音',
  interview: '面试中',
  offer: '拿到 offer',
  rejected: '被拒了',
  discarded: '自己不去了',
  skip: '不投',
}

/**
 * 「下一步」这一页。
 *
 * 为什么叫这个名字：它管的不只是「找工作」——改简历、练面试、
 * 想清楚接下来半年怎么走，都是同一件事的不同阶段。叫「看工作」
 * 会让人以为只有投简历那天才用得上。
 *
 * 只有一件事：把一份招聘说明贴进来，换回一张「哪里会卡住你」的清单。
 * 刻意没有的东西：批量投递、自动发信、岗位推荐流。这三样都会让人
 * 投得更多、想得更少，而这个页面存在的理由是相反的。
 */
function JobsView({ onBack, flash }) {
  const [jd, setJd] = useState('')
  const [company, setCompany] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [report, setReport] = useState(null)
  const [profile, setProfile] = useState(null)
  const [profileFound, setProfileFound] = useState(true)
  const [showProfile, setShowProfile] = useState(false)
  const [draftRoles, setDraftRoles] = useState(null)
  const [draftPay, setDraftPay] = useState(null)
  const [draftNo, setDraftNo] = useState(null)
  const [history, setHistory] = useState(null)
  const [net, setNet] = useState(null)
  const [netBusy, setNetBusy] = useState(false)
  const [logged, setLogged] = useState(false)
  const [showTracker, setShowTracker] = useState(false)
  const [tracker, setTracker] = useState(null)
  const [showStories, setShowStories] = useState(false)
  const [stories, setStories] = useState(null)
  const [newStoryTitle, setNewStoryTitle] = useState('')
  // 新加的 hook 一律排在最后：前面那些槽位被 render-all 用数字引着，
  // 插在中间会把所有既有断言推错一格。
  const [written, setWritten] = useState(null) // {kind:'resume'|'cover', markdown, path, warning}
  const [writing, setWriting] = useState(null) // 'resume' | 'cover' | null
  const [newStoryBody, setNewStoryBody] = useState('')
  const [showMock, setShowMock] = useState(false)
  // 这一页开头要读好几样东西（求职设置、以前读过的、投递表、故事）。
  // 读失败时以前是静默吞掉——界面上就是「一片空」，跟「你还没填」长得一样。
  const [loadFail, setLoadFail] = useState(false)
  const [savingStory, setSavingStory] = useState(false)

  useEffect(() => {
    let alive = true
    call('job.profile.get', {}).then((r) => {
      if (alive !== true) return
      if (r.ok === true) {
        setProfile(r.profile ?? null)
        // 「我自己」那张卡还没建时，写求职设置会失败。提前说清楚，
        // 而不是等用户填完三栏点「存一下」才告诉他没地方存。
        setProfileFound(r.found !== false)
      }
    }).catch(() => { if (alive === true) setLoadFail(true) })
    call('job.evaluations', {}).then((r) => {
      if (alive !== true) return
      if (r.ok === true) setHistory(r.items ?? [])
      else setLoadFail(true)
    }).catch(() => { if (alive === true) setLoadFail(true) })
    call('job.tracker.list', {}).then((r) => {
      if (alive !== true) return
      if (r.ok === true) setTracker(r.rows ?? [])
      else setLoadFail(true)
    }).catch(() => { if (alive === true) setLoadFail(true) })
    call('job.stories', {}).then((r) => {
      if (alive !== true) return
      if (r.ok === true) setStories(r.stories ?? [])
      else setLoadFail(true)
    }).catch(() => { if (alive === true) setLoadFail(true) })
    return () => { alive = false }
  }, [])

  const saveProfile = async () => {
    const patch = {}
    if (draftRoles !== null) patch.target_roles = draftRoles
    if (draftPay !== null) patch.compensation = draftPay
    if (draftNo !== null) patch.dealbreakers = draftNo.split(/[、,，\n]/).map((s) => s.trim()).filter((s) => s !== '')
    try {
      const r = await call('job.profile.set', { profile: patch })
      if (r.ok !== true) { setErr(r.error ?? '没存上'); return }
      setProfile(r.profile ?? null)
      setDraftRoles(null); setDraftPay(null); setDraftNo(null)
      flash('存好了')
    } catch (e) { setErr(humanizeError(e)) }
  }

  // 记一笔之后立刻把「我的投递」也刷新：以前只把按钮置灰，那一栏还是旧的，
  // 用户点开发现自己刚记的那条不在里面，会以为没记上又点一次。
  const record = async (status) => {
    const row = { company: report?.company ?? company, role: report?.role ?? '', status, note: '' }
    try {
      const r = await call('job.tracker.add', { row })
      if (r.ok !== true) { setErr(r.error ?? '没记上'); return }
      setLogged(true)
      flash('记上了')
      const again = await call('job.tracker.list', {})
      if (again.ok === true) setTracker(again.rows ?? [])
      else setErr(again.error ?? '记上了，但这一栏没刷新出来——切出去再进来一次')
    } catch (e) { setErr(humanizeError(e)) }
  }

  const run = async () => {
    setBusy(true); setErr(null); setReport(null)
    // 重新看一遍就是从头来过：上一份的投递记录、改好的简历、认识谁，
    // 都是照着上一份结论做的，不能留在新结论旁边。
    setLogged(false); setWritten(null); setNet(null)
    try {
      const r = await call('job.evaluate', { jd, company })
      if (r.ok !== true) { setErr(r.error ?? '没读出来'); return }
      setReport(r)
      call('job.evaluations', {}).then((h2) => { if (h2.ok === true) setHistory(h2.items ?? []) }).catch(() => {})
    } catch (e) {
      setErr(humanizeError(e))
    } finally {
      setBusy(false)
    }
  }

  // 写简历/求职信。两条路由都不许编数字和经历，所以结果里可能带一条
  // 「这些数字在你材料里找不到」的警告——那条必须显示出来，不显示就等于默许。
  const buildDoc = async (kind) => {
    setWriting(kind); setErr(null)
    try {
      const r = await call(kind === 'resume' ? 'job.resume.build' : 'job.cover.build', {
        jd, company: report?.company ?? company, role: report?.role ?? '',
      })
      if (r.ok !== true) { setErr(r.error ?? '没写出来'); return }
      setWritten({ kind, markdown: String(r.markdown ?? ''), path: r.path ?? null, warning: r.warning ?? null })
    } catch (e) { setErr(humanizeError(e)) } finally { setWriting(null) }
  }

  const whoThere = async () => {
    const name = (report?.company ?? company).trim()
    if (name === '') { setNet({ ok: false, error: '先写上公司名，或者先看一份写着公司的招聘说明。' }); return }
    setNetBusy(true)
    try {
      const r = await call('job.network', { company: name })
      setNet(r)
    } catch (e) {
      setNet({ ok: false, error: humanizeError(e) })
    } finally {
      setNetBusy(false)
    }
  }

  // 模拟面试单独占一屏：面试是对话，把它塞在招聘说明下面那一长条里，
  // 用户会一边滚一边答，注意力全散了。
  if (showMock === true) {
    const reqs = (report?.rows ?? []).filter((r) => r.verdict === 'gap' || r.verdict === 'unclear')
    return h(MockView, {
      company: report?.company ?? company,
      role: report?.role ?? '',
      requirements: reqs,
      onBack: () => setShowMock(false),
      flash,
    })
  }

  // 换了一份招聘说明，上一份的结论、记过的投递、改好的简历都不再对应当前这一份。
  // 不收拾的话，新公司那一栏下面还挂着上一家的分数和「我投了」——那是别人家的记录。
  const dropReport = () => { setReport(null); setLogged(false); setWritten(null); setNet(null) }

  const shownRoles = draftRoles !== null ? draftRoles : (profile?.target_roles ?? '')
  const shownPay = draftPay !== null ? draftPay : (profile?.compensation ?? '')
  const shownNo = draftNo !== null ? draftNo : (Array.isArray(profile?.dealbreakers) ? profile.dealbreakers.join('、') : '')

  return h('div', { className: 'lc-pad lc-stack' },
    loadFail === true
      ? h(Note, { tone: 'warn', icon: 'warning' }, '有几项内容这次没读出来。上面还是能用的，只是下面那几栏可能是空的——不是你没有，是没读到。过一会儿重开这一页就会再读一次。')
      : null,
    h('div', { className: 'lc-meta' },
      '把一份招聘说明整段贴进来。它会告诉你：哪些要求你真的对得上，哪些是门就关着的，哪些只是你还没写进材料。'),

    // 求职设置默认收起：第一次来的人应该先看到输入框，不是先填三个表
    h('div', null,
      h('button', {
        className: 'lc-btn ghost sm', type: 'button', onClick: () => setShowProfile(!showProfile),
        style: { width: '100%', justifyContent: 'flex-start' },
      },
        h('span', { style: { display: 'inline-flex', transform: showProfile ? 'rotate(90deg)' : 'none', transition: 'transform .12s' } }, h(Icon, { name: 'chevron', size: 12 })),
        '你想找什么样的工作',
        h('span', { className: 'lc-grow' }),
        h(Tag, null, profile === null ? '没写' : '已写'),
      ),
      showProfile !== true ? null : h('div', { className: 'lc-stack', style: { marginTop: 8 } },
        profileFound === false
          ? h(Note, { tone: 'warn', icon: 'warning' }, '还没有「我自己」那张卡，这里填的东西没地方存。先去建一张，或者先跳过——不留这些也能往下走。')
          : null,
        h(Field, { label: '想做什么', hint: '写方向就行：「后端」「新媒体运营」。' },
          h('input', { className: 'lc-input', value: shownRoles, onChange: (e) => setDraftRoles(e.target.value), placeholder: '后端开发', spellCheck: false }),
        ),
        h(Field, { label: '期望薪资', hint: '可以不填。填了它会帮你对照招聘说明里的数字。' },
          h('input', { className: 'lc-input', value: shownPay, onChange: (e) => setDraftPay(e.target.value), placeholder: '40-60K', spellCheck: false }),
        ),
        h(Field, { label: '不能接受什么', hint: '用「、」隔开。写了这条就是硬规矩——招聘说明里出现了，别的都不用看了。' },
          h('input', { className: 'lc-input', value: shownNo, onChange: (e) => setDraftNo(e.target.value), placeholder: '长期加班、频繁出差', spellCheck: false }),
        ),
        h('div', { className: 'lc-row' },
          h(Btn, { size: 'sm', tone: 'primary', onClick: saveProfile, disabled: profileFound === false || (draftRoles === null && draftPay === null && draftNo === null) }, '存一下'),
          h('div', { className: 'lc-grow' }),
          profile === null ? h('span', { className: 'lc-meta' }, '还没写') : h('span', { className: 'lc-meta' }, '会存到「我自己」那张卡上'),
        ),
      ),
    ),

    h(Field, { label: '公司（可以不填）' },
      h('input', { className: 'lc-input', value: company, onChange: (e) => { setCompany(e.target.value); dropReport() }, placeholder: '某公司', spellCheck: false }),
    ),

    h(Field, { label: '招聘说明', hint: '整段复制过来，包括职责和要求。越完整越准。' },
      h('textarea', {
        className: 'lc-textarea',
        value: jd,
        // 换了招聘说明就把上一份的结论收掉：不然左边是新的岗位，右边还是
        // 上一个岗位的结论，人一急就会照着它点「记一笔」。
        onChange: (e) => { setJd(e.target.value); dropReport() },
        placeholder: '把招聘要求整段贴在这里…',
        spellCheck: false,
        style: { minHeight: 150 },
      }),
    ),

    err === null ? null : h(Err, { text: err }),

    h(Btn, { tone: 'primary', big: true, block: true, icon: 'briefcase', onClick: run, disabled: busy }, busy ? '正在读…' : '看看这份工作'),

    report === null ? null : h(JobReport, { report }),

    // 看完这一份，顺手记一笔：投了还是没投。这一栏是给自己看的，
    // 过一个月回来看「投了 20 家几家有回音」，答案从这里出。
    report === null ? null : (logged
      // 记过之后把那两个按钮换掉，而不是留一个禁用的、字还是空的按钮：
      // 空按钮看起来像界面坏了。
      ? h('div', { className: 'lc-meta', style: { marginTop: 8 } }, '已经记在「我的投递」里了。要改状态就去那一栏点。')
      : h('div', { className: 'lc-row', style: { marginTop: 8 } },
        h(Btn, { size: 'sm', tone: 'primary', icon: 'check', onClick: () => record('applied') }, '记一笔：我投了'),
        h(Btn, { size: 'sm', ghost: true, icon: 'skip', onClick: () => record('skip') }, '不投，记一下'),
      )),

    // 简历和求职信只在「看过一份工作」之后才给按钮：不知道照谁改，改了也没用。
    report === null ? null : h('div', { style: { marginTop: 12 } },
      h('div', { className: 'lc-meta', style: { marginBottom: 4 } },
        '要不要照这一份，把已有的经历重排一遍？只用你写过的材料，不编新的。'),
      h('div', { className: 'lc-row' },
        h(Btn, { size: 'sm', icon: 'edit', disabled: writing !== null, onClick: () => buildDoc('resume') },
          writing === 'resume' ? '正在写…' : '照这份改简历'),
        h(Btn, { size: 'sm', icon: 'send', disabled: writing !== null, onClick: () => buildDoc('cover') },
          writing === 'cover' ? '正在写…' : '写封求职信'),
      ),
    ),

    written === null ? null : h('div', { className: 'lc-sec' },
      h('div', { className: 'lc-row' },
        h(GroupTitle, { icon: 'edit' }, written.kind === 'resume' ? '改好的简历' : '写好的求职信'),
        h('div', { className: 'lc-grow' }),
        h(Btn, { size: 'sm', ghost: true, icon: 'download', onClick: () => {
          downloadText(written.markdown, `${written.kind === 'resume' ? '简历' : '求职信'}-${report?.company ?? company}.md`)
        } }, '存成文件'),
        h(Btn, { size: 'sm', ghost: true, icon: 'x', onClick: () => setWritten(null) }, '收起'),
      ),
      // 数字对不上是这里最要紧的提示：简历上编一个百分比，面试第一个问题就会问到它。
      written.warning === null ? null : h(Note, { tone: 'warn', icon: 'warning' }, h('div', { style: { whiteSpace: 'pre-wrap' } }, written.warning)),
      h('div', { style: { whiteSpace: 'pre-wrap', fontSize: 14.5, lineHeight: 1.65, marginTop: 6 } }, written.markdown),
      written.path === null ? null : h('div', { className: 'lc-meta', style: { marginTop: 6 } }, '也存了一份在工作文件夹里，回头能找到。'),
    ),

    // 这一块是本插件跟通用求职工具唯一不一样的地方：求职工具不认识人。
    report === null ? null : h('div', { className: 'lc-stack', style: { marginTop: 10 } },
      h(Btn, { size: 'sm', icon: 'people', onClick: whoThere, disabled: netBusy }, netBusy ? '正在找…' : '我认识这家公司的人吗'),
      net === null ? null : net.ok !== true
        ? h(Err, { text: net.error ?? '没查成' })
        : h('div', { className: 'lc-stack' },
            net.hits.length === 0
              ? h('div', { className: 'lc-meta' }, '你写下的这些人里，没有人提到过这家公司。这不代表你没门路，只代表还没写下来。')
              : h('div', null,
                  h('div', { className: 'lc-meta' }, `有 ${net.hits.length} 个人提到过这家公司：`),
                  h('div', { className: 'lc-stack', style: { marginTop: 6 } }, net.hits.map((hit) => h('div', { key: hit.path, className: 'lc-sec' },
                    h('div', { className: 'st' }, `${hit.name}${hit.relation === '' ? '' : `（${hit.relation}）`}`),
                    h('div', { className: 'sb' }, `${hit.field}：${hit.line}`),
                  ))),
                ),
            h('div', { className: 'lc-meta' }, '这是你档案里写着的原话。要不要去问，你自己定。'),
          ),
    ),

    // ── 模拟面试 ──
    // 放在报告之后、并且只在看过一份工作之后才给：它问的正是那份评估里
    // 没对上的地方，手上没有评估就不知道要问什么。
    report === null ? null : h('div', { className: 'lc-stack', style: { marginTop: 10 } },
      h(Btn, { size: 'sm', icon: 'mic', onClick: () => setShowMock(true) }, '练一轮面试'),
      h('div', { className: 'lc-meta' }, '它会针对刚才那些没对上的地方问你，然后咬住你的回答往下追。'),
    ),

    // ── 我的投递 ──
    h('div', { style: { marginTop: 18 } },
      h('button', {
        className: 'lc-btn ghost sm', type: 'button', onClick: () => setShowTracker(!showTracker),
        style: { width: '100%', justifyContent: 'flex-start' },
      },
        h('span', { style: { display: 'inline-flex', transform: showTracker ? 'rotate(90deg)' : 'none', transition: 'transform .12s' } }, h(Icon, { name: 'chevron', size: 12 })),
        '我的投递',
        h('span', { className: 'lc-grow' }),
        h(Tag, null, (tracker ?? []).length === 0 ? '还没记' : `${tracker.length} 条`),
      ),
      showTracker !== true ? null : h('div', { className: 'lc-stack', style: { marginTop: 8 } },
        (tracker ?? []).length === 0
          ? h('div', { className: 'lc-meta' }, '还没有记过。看完一份工作，点「记一笔：我投了」，这里就会有。')
          : (tracker ?? []).map((row) => h('div', { key: `${row.company}-${row.role}-${row.date}`, className: 'lc-sec' },
              h('div', { className: 'lc-row' },
                h('span', { className: 'st lc-grow' }, `${row.company}${row.role === '' ? '' : ' · ' + row.role}`),
                h(Tag, null, TRACK_LABEL[row.status] ?? row.status),
              ),
              h('div', { className: 'lc-meta' }, `${row.date}${row.note === '' ? '' : ' · ' + row.note}`),
            )),
        h('div', { className: 'lc-meta' }, '这张记录你能自己在文件夹里打开改，就在「我的投递」那张表里。'),
      ),
    ),

    // ── 面试故事 ──
    h('div', { style: { marginTop: 10 } },
      h('button', {
        className: 'lc-btn ghost sm', type: 'button', onClick: () => setShowStories(!showStories),
        style: { width: '100%', justifyContent: 'flex-start' },
      },
        h('span', { style: { display: 'inline-flex', transform: showStories ? 'rotate(90deg)' : 'none', transition: 'transform .12s' } }, h(Icon, { name: 'chevron', size: 12 })),
        '面试故事',
        h('span', { className: 'lc-grow' }),
        h(Tag, null, (stories ?? []).length === 0 ? '还没写' : `${stories.length} 段`),
      ),
      showStories !== true ? null : h('div', { className: 'lc-stack', style: { marginTop: 8 } },
        h('div', { className: 'lc-meta' }, '面试官问「讲一次你解决难题的经历」，临时想是来不及的。平时把真事写下来，面试前翻一遍就够。'),
        (stories ?? []).map((st) => h('div', { key: st.title, className: 'lc-sec' },
          h('div', { className: 'st' }, st.title),
          h('div', { className: 'sb', style: { whiteSpace: 'pre-wrap' } }, st.body),
        )),
        h(Field, { label: '再写一段', hint: '什么情况、你做了什么、结果怎样。三句话就够。' },
          h('input', { className: 'lc-input', value: newStoryTitle, onChange: (e) => setNewStoryTitle(e.target.value), placeholder: '一次线上事故', spellCheck: false }),
        ),
        h('textarea', { className: 'lc-textarea', value: newStoryBody, onChange: (e) => setNewStoryBody(e.target.value), placeholder: '凌晨两点被告警叫起来…', spellCheck: false }),
        h(Btn, {
          size: 'sm', icon: 'plus',
          disabled: savingStory || newStoryTitle.trim() === '' || newStoryBody.trim() === '',
          onClick: async () => {
            // 以前这里没有 try/catch：后台断了点它一声不响，用户只会以为按钮坏了；
            // 也没有忙等，网络慢连点两下会存出两条同名的记录。
            if (savingStory) return
            setSavingStory(true); setErr(null)
            try {
              const r = await call('job.story.add', { story: { title: newStoryTitle.trim(), body: newStoryBody.trim() } })
              if (r?.ok !== true) { setErr(r?.error ?? '没存上'); return }
              setNewStoryTitle(''); setNewStoryBody('')
              const again = await call('job.stories', {})
              if (again?.ok === true) setStories(again.stories ?? [])
              flash('记下来了')
            } catch (e) {
              setErr(humanizeError(e))
            } finally {
              setSavingStory(false)
            }
          },
        }, savingStory ? '正在存…' : '存下这段'),
      ),
    ),

    (history ?? []).length === 0 ? null : h('div', null,
      h(GroupTitle, { icon: 'history' }, `以前看过的 · ${history.length}`),
      h('div', { className: 'lc-stack' }, history.slice(0, 8).map((it) => h('div', { key: it.path, className: 'lc-card-item', style: { cursor: 'default' } },
        h('div', { className: 'lc-avatar', style: { background: 'var(--lc-primary-soft)', color: 'var(--lc-primary)' } }, h(Icon, { name: 'briefcase', size: 14 })),
        h('div', { className: 'lc-grow' },
          h('div', { style: { fontWeight: 600 } }, `${it.company === '' ? '没写公司' : it.company}${it.role === '' ? '' : ' · ' + it.role}`),
          h('div', { className: 'lc-meta' }, it.date),
        ),
      ))),
    ),

    h('div', { style: { marginTop: 10 } }, h(Btn, { ghost: true, size: 'sm', icon: 'back', onClick: onBack }, '回去')),
  )
}

/** 一份评估报告。分段顺序与后台 renderReport 一致：先说不好的。 */
function JobReport({ report }) {
  const blocked = report.blocked ?? []
  const matched = report.matched ?? []
  const unclear = report.unclear ?? []
  const gaps = report.gaps ?? []
  const deal = report.dealbreakers ?? []
  const soft = gaps.filter((g) => g.importance !== 'critical' && g.importance !== 'high')

  // 报告没能存进文件夹：现在它只在这一屏上，翻篇就没了。这句话要放在
  // 最前面——不然用户以为已经归档，回头在「以前看过的」里找不到。
  const saveFail = typeof report.saveFail === 'string' && report.saveFail !== ''
    ? h(Note, { tone: 'err', icon: 'warning' }, h('div', { style: { whiteSpace: 'pre-wrap' } }, report.saveFail))
    : null

  return h('div', { className: 'lc-stack', style: { marginTop: 14 } },
    saveFail,
    h('div', { className: 'lc-row' },
      h('h3', { style: { margin: 0, flex: '1 1 auto' } }, [report.company, report.role].filter((s) => String(s ?? '').trim() !== '').join(' · ') || '这份工作'),
      h(Tag, null, `${matched.length} 条对得上`),
    ),

    deal.length === 0 ? null : h(Note, { tone: 'err', icon: 'warning' },
      h('div', null, '你写过不能接受这个：'),
      h('div', { style: { marginTop: 4, fontWeight: 600 } }, deal.map((d) => d.word).join('、')),
      h('div', { className: 'lc-meta', style: { marginTop: 4 } }, '招聘说明里就这么写着。别的都合适也不用往下看了。'),
    ),

    blocked.length === 0 ? null : h('div', null,
      h(GroupTitle, { tone: 'err', icon: 'warning' }, `硬要求没对上 · ${blocked.length}`),
      h('div', { className: 'lc-stack' }, blocked.map((r) => h('div', { key: r.index, className: 'lc-sec' },
        h('div', { className: 'st' }, r.requirement),
        h('div', { className: 'sb' }, `招聘说明：「${r.jd_quote}」`),
        h('div', { className: 'lc-meta', style: { marginTop: 4 } }, r.proof === '' ? '你的材料里没有对应的事。' : `你的材料里：${r.proof}`),
      ))),
      h('div', { className: 'lc-meta' }, '这几条不是「差一点」，是门就关着。'),
    ),

    matched.length === 0 ? null : h('div', null,
      h(GroupTitle, { tone: 'ok', icon: 'check' }, `拿得出来的 · ${matched.length}`),
      h('div', { className: 'lc-stack' }, matched.map((r) => h('div', { key: r.index, className: 'lc-sec' },
        h('div', { className: 'st' }, r.requirement),
        h('div', { className: 'sb' }, `你的材料：「${r.proof}」`),
      ))),
    ),

    soft.length === 0 ? null : h('div', null,
      h(GroupTitle, { icon: 'list' }, `够不上但不致命 · ${soft.length}`),
      h('div', { className: 'lc-wrap' }, soft.map((r) => h(Tag, { key: r.index }, r.requirement))),
    ),

    unclear.length === 0 ? null : h('div', null,
      h(GroupTitle, { tone: 'analyze', icon: 'person' }, `材料里看不出来 · ${unclear.length}`),
      h('div', { className: 'lc-meta' }, '这些不是没有，是你没写过。可以在面试里问，也可以先补进材料。'),
      h('div', { className: 'lc-wrap', style: { marginTop: 6 } }, unclear.map((r) => h(Tag, { key: r.index }, r.requirement))),
    ),

    (report.questions ?? []).length === 0 ? null : h('div', null,
      h(GroupTitle, { icon: 'chat' }, '面试前该问清楚'),
      h('div', { className: 'lc-stack' }, report.questions.map((q, i) => h('div', { key: i, className: 'lc-meta' }, `· ${q}`))),
    ),

    (report.warnings ?? []).length === 0 ? null : h(Note, { tone: 'warn', icon: 'warning' },
      h('div', null, '这份招聘说明有几个地方不对劲，不是说不能投，是让你知道它是这么写的。'),
      h('div', { className: 'lc-stack', style: { marginTop: 6 } }, report.warnings.map((w, i) => h('div', { key: i, className: 'lc-meta' }, `· ${w}`))),
    ),

    (report.dropped ?? []).length === 0 ? null : h('div', null,
      h(GroupTitle, { icon: 'trash' }, `丢掉的 · ${report.dropped.length}`),
      h('div', { className: 'lc-meta' }, '这些是 AI 说了但找不到原文的，已经扔了。它们可能是对的，但没法证明。'),
      h('div', { className: 'lc-stack', style: { marginTop: 6 } }, report.dropped.slice(0, 12).map((d, i) => h('div', { key: i, className: 'lc-meta' }, `· ${d}`))),
    ),

    report.path === undefined ? null : h('div', { className: 'lc-meta' }, '已经存下来了，下次进来能在「以前看过的」里找到。'),
  )
}

// ── 模拟面试 ──────────────────────────────────────────────────────

/** 面试官提问的说法。和宿主侧 jobs-interview.js 的 KIND_LABEL 同一套。 */
const ASK_LABEL = {
  gap: '材料里没写的',
  behavior: '讲一件具体的事',
  explain: '往回追一句',
  pressure: '给点压力',
  motivation: '你图什么',
}

/**
 * 一场模拟面试。
 *
 * 这一页跟别处不一样的地方：**它是那个问的人**。别处都是用户填、AI 读，
 * 这里反过来——它针对你刚说的话往下追，追到你必须给出具体的人、时间、做法。
 *
 * 界面刻意不做成「AI 打分 + 总分」那种：分数会让人以为「80 分就稳了」，
 * 而面试里真正会挂人的是「我做过」和「我参与过」之间的区别。
 * 所以这里只列事实：这一题你有没有讲清楚你本人做了什么。
 */
function MockView({ company, role, requirements, onBack, flash }) {
  const [session, setSession] = useState(null)
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [tips, setTips] = useState([])
  const [summary, setSummary] = useState(null)
  const [done, setDone] = useState(null)
  // 新 hook 一律排最后（render-all 用数字引前面的槽位）
  const [past, setPast] = useState(null)

  const turns = session?.turns ?? []
  const last = turns.length === 0 ? null : turns[turns.length - 1]
  const answered = last !== null && (String(last.answer ?? '').trim() !== '' || last.skipped === true)

  const ask = async (sess) => {
    const base = sess ?? session
    if (base === null) return
    setBusy(true); setErr(null); setTips([])
    try {
      const r = await call('job.interview.turn', { id: base.id })
      if (r.ok !== true) { setErr(r.error ?? '没问出来'); return }
      setSession(r.session)
      if (r.done === true) { setDone(r.reason ?? '这一场到这儿就够了。'); return }
      setAnswer('')
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy(false) }
  }

  const start = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await call('job.interview.start', { company, role, requirements: requirements ?? [] })
      if (r.ok !== true) { setErr(r.error ?? '开不了'); return }
      setSession(r.session)
      await ask(r.session)
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy(false) }
  }

  const submit = async (skipped) => {
    if (session === null) return
    setBusy(true); setErr(null)
    try {
      const r = await call('job.interview.answer', { id: session.id, answer, skipped })
      if (r.ok !== true) { setErr(r.error ?? '没记上'); return }
      setSession(r.session)
      setTips(r.tips ?? [])
      await ask(r.session)
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy(false) }
  }

  const finish = async () => {
    if (session === null) return
    setBusy(true)
    try {
      const r = await call('job.interview.end', { id: session.id })
      if (r.ok !== true) { setErr(r.error ?? '没存上'); return }
      setSession(r.session)
      setSummary(r.summary ?? [])
      setDone('这一场结束了。')
      flash('存下来了')
    } catch (e) { setErr(humanizeError(e)) } finally { setBusy(false) }
  }

  const loadPast = async () => {
    if (past !== null) { setPast(null); return }
    try {
      const r = await call('job.interview.list', {})
      // 读失败和「真的没练过」长得一样，但意思完全不同：面试前一晚
      // 看到「还没练过」，会以为记录丢了。
      if (r.ok !== true) { setErr(r.error ?? '练过的记录读不出来。'); return }
      setPast(r.items ?? [])
    } catch (e) { setErr(humanizeError(e)) }
  }

  return h('div', { className: 'lc-pad lc-stack' },
    h('div', { className: 'lc-meta' },
      '它会挑你材料里没写的地方问，然后咬住你刚才那句话往下追。练的就是这个：被追问的时候还能不能说出具体的事。'),
    h('div', { className: 'lc-meta' },
      '它不问你结没结婚、多大、哪里人——这些本来就不该问。也不做背景调查。'),

    session === null
      ? h('div', { className: 'lc-stack' },
          company === '' && role === '' ? null : h('div', { className: 'lc-meta' }, `这一场：${[company, role].filter((x) => String(x ?? '').trim() !== '').join(' · ')}`),
          h(Btn, { tone: 'primary', big: true, block: true, icon: 'mic', onClick: start, disabled: busy }, busy ? '正在开始…' : '开始练'),
          (requirements ?? []).length === 0
            ? h('div', { className: 'lc-meta' }, '没有先看过一份招聘说明，那就从通用的问题开始练。')
            : h('div', { className: 'lc-meta' }, `会优先问刚才那 ${(requirements ?? []).length} 条里你没对上的。`),
        )
      : null,

    err === null ? null : h(Err, { text: err }),

    // 对话：只显示最近几条，翻回去看没意义，看的是「他刚才追我什么」
    turns.length === 0 ? null : h('div', { className: 'lc-stack' },
      turns.slice(-6).map((t, i) => h('div', { key: `${t.asked_at}-${i}`, className: 'lc-sec' },
        h('div', { className: 'lc-row' },
          h('span', { className: 'lc-tag' }, ASK_LABEL[t.kind] ?? '提问'),
          h('div', { className: 'lc-grow' }),
          t.by === 'local' ? h('span', { className: 'lc-meta' }, '本地出的题') : null,
        ),
        h('div', { className: 'st', style: { marginTop: 4 } }, t.question),
        t.quoted === undefined || t.quoted === '' ? null : h('div', { className: 'lc-meta' }, `追的是你那句「${t.quoted}」`),
        String(t.answer ?? '').trim() === '' ? null : h('div', { className: 'sb', style: { marginTop: 6, whiteSpace: 'pre-wrap' } }, t.answer),
        t.skipped === true ? h('div', { className: 'lc-meta', style: { marginTop: 4 } }, '这题跳过了。') : null,
      )),
    ),

    // 上一题哪里可以更好。不叫「你的问题」，因为这不是评语，是下一步该补什么。
    tips.length === 0 ? null : h('div', { className: 'lc-sec' },
      h('div', { className: 'lc-meta' }, '这一题可以再具体一点：'),
      h('div', { className: 'lc-stack', style: { marginTop: 4 } }, tips.map((x, i) => h('div', { key: i, className: 'lc-meta' }, `· ${x}`))),
    ),

    done !== null ? null : (last === null || answered
      ? h(Btn, { tone: 'primary', big: true, block: true, icon: 'mic', onClick: () => ask(null), disabled: busy },
          busy ? '正在想下一个问题…' : '问下一个')
      : h('div', { className: 'lc-stack' },
          h('textarea', {
            className: 'lc-textarea',
            value: answer,
            onChange: (e) => setAnswer(e.target.value),
            placeholder: '就当对面坐着人，把话说出来。有具体的事就说具体的事。',
            spellCheck: false,
            style: { minHeight: 110 },
          }),
          h('div', { className: 'lc-row' },
            h(Btn, { tone: 'primary', icon: 'send', onClick: () => submit(false), disabled: busy }, busy ? '…' : '答完了'),
            h(Btn, { size: 'sm', ghost: true, icon: 'skip', onClick: () => submit(true), disabled: busy }, '这题跳过'),
            h('div', { className: 'lc-grow' }),
            h(Btn, { size: 'sm', ghost: true, icon: 'stop', onClick: finish, disabled: busy }, '今天到这'),
          ),
        )),

    done === null ? null : h('div', { className: 'lc-stack' },
      h(Note, { tone: 'ok', icon: 'check' }, done),
      summary === null ? null : h('div', { className: 'lc-sec' },
        h('div', { className: 'st' }, '这一场下来'),
        h('div', { className: 'lc-stack', style: { marginTop: 4 } }, summary.map((x, i) => h('div', { key: i, className: 'lc-meta' }, `· ${x}`))),
      ),
      h('div', { className: 'lc-row' },
        h(Btn, { size: 'sm', icon: 'mic', onClick: () => { setSession(null); setDone(null); setSummary(null); setTips([]) } }, '再练一场'),
        h('div', { className: 'lc-grow' }),
        h(Btn, { size: 'sm', ghost: true, icon: 'download', onClick: () => {
          downloadText(String(session?.markdown ?? ''), `模拟面试-${company === '' ? '练习' : company}.md`)
        }, disabled: String(session?.markdown ?? '') === '' }, '存成文件'),
      ),
      h('div', { className: 'lc-meta' }, '这一场也留在「以前练过的」里，面试前一天翻出来看一遍。'),
    ),

    // 以前练过的：面试前一晚最有用的东西是自己上次怎么答的
    h('div', { style: { marginTop: 14 } },
      h('button', { className: 'lc-btn ghost sm', type: 'button', onClick: loadPast, style: { width: '100%', justifyContent: 'flex-start' } },
        h('span', { style: { display: 'inline-flex', transform: past !== null ? 'rotate(90deg)' : 'none', transition: 'transform .12s' } }, h(Icon, { name: 'chevron', size: 12 })),
        '以前练过的',
      ),
      past === null ? null : h('div', { className: 'lc-stack', style: { marginTop: 8 } },
        past.length === 0
          ? h('div', { className: 'lc-meta' }, '还没练过。练一场就会有记录。')
          : past.slice(0, 8).map((it) => h('div', { key: it.id, className: 'lc-sec' },
              h('div', { className: 'st' }, `${it.company === '' ? '没写公司' : it.company}${it.role === '' ? '' : ' · ' + it.role}`),
              h('div', { className: 'lc-meta' }, `${shortDate(it.started_at)} · 问了 ${it.turns} 个，答了 ${it.answered} 个${it.done === true ? ' · 练完了' : ''}`),
            )),
      ),
    ),

    h('div', { style: { marginTop: 10 } }, h(Btn, { ghost: true, size: 'sm', icon: 'back', onClick: onBack }, '回去')),
  )
}

// ── 工具 ──────────────────────────────────────────────────────────

function asArray(v) {
  if (v === undefined || v === null) return []
  return Array.isArray(v) ? v : [v]
}

/** 深拷贝一份卡数据，改表单时不碰原对象。 */
function cloneData(data) {
  try {
    return JSON.parse(JSON.stringify(data ?? {}))
  } catch {
    return { ...(data ?? {}) }
  }
}

function shortDate(iso) {
  if (typeof iso !== 'string') return ''
  return iso.slice(0, 10)
}

function safeId(raw) {
  return String(raw ?? '').trim().replace(/[\\/:*?"<>|#%\s]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 80) || 'unnamed'
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result ?? '')
      const comma = result.indexOf(',')
      resolve(comma < 0 ? result : result.slice(comma + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('读文件失败'))
    reader.readAsDataURL(file)
  })
}

function downloadBase64(base64, filename, mime) {
  const bytes = atob(base64)
  const out = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i += 1) out[i] = bytes.charCodeAt(i)
  const blob = new Blob([out], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

// ── 注册 ──────────────────────────────────────────────────────────

/** 侧边栏 tab 的图标：一本打开的小册子。用主题色，跟其他 tab 区分开。 */
function TabIcon() {
  return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
    h('path', { d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H10v15H5.5A1.5 1.5 0 0 1 4 17.5z' }),
    h('path', { d: 'M12 4h6.5A1.5 1.5 0 0 1 20 5.5v12a1.5 1.5 0 0 1-1.5 1.5H12z' }),
    h('path', { d: 'M7 8h1M15 8h2M15 12h2' }),
  )
}

/**
 * 左侧栏那排图标里的一个。外壳负责按钮、文字提示、高亮，
 * 这里只画那个小图标；size 由外壳给（它会随折叠状态变）。
 */
function PanelIcon({ size }) {
  const edge = typeof size === 'number' && size > 0 ? size : 18
  return h('svg', {
    'data-dsh-panel-entry': PANEL_ID,
    width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': 'true',
  },
    h('path', { d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H10v15H5.5A1.5 1.5 0 0 1 4 17.5z' }),
    h('path', { d: 'M12 4h6.5A1.5 1.5 0 0 1 20 5.5v12a1.5 1.5 0 0 1-1.5 1.5H12z' }),
    h('path', { d: 'M7 8h1M15 8h2M15 12h2' }),
  )
}

/** 点开左侧栏那个图标以后，中间主区域显示的就是它。 */
function PanelPage(props) {
  // 外壳给的主区域不保证有确定高度，这里自己撑满，否则里面那层滚不动。
  return h('div', { style: { height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 } },
    h(LifeCardTab, props))
}

/** 左侧栏那一行与中间那块页面靠同一个 id 配对，所以两边都用这个常量。 */
const PANEL_ID = 'lifecard'
const PANEL_ORDER = 35

function apply(ctx) {
  // 样式也算副作用：跟着插件一起上手、一起回收。
  ctx.effect(() => ensureStyle(document), 'lifecard: 样式')

  // 一、挂到左侧栏那排图标里 —— 平时点开东西都是从那儿点的，比右侧栏的「+」好找。
  // 用 slots.inject：座位什么时候出现由外壳决定；没有这个座位就什么都不做，不影响启动。
  const slots = ctx.slots
  if (slots !== undefined && slots !== null && typeof slots.inject === 'function') {
    ctx.effect(() => {
      const disposers = []
      disposers.push(slots.inject('main', () => slots.register({
        name: 'main',
        key: PANEL_ID,
        inject: () => ({}),
      }, PanelPage)))
      disposers.push(slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: PANEL_ORDER,
        label: () => 'Life Cards',
      }, PanelIcon)))
      return () => {
        for (const d of disposers.splice(0)) {
          // 卸载时某一边出错，不该把另一边也漏在那儿
          try { d() } catch (e) { /* 忽略 */ }
        }
      }
    }, 'lifecard: 左侧栏入口')
  }

  // 二、顺手也挂到右侧栏的标签页里 —— 有人习惯把它开在右边长期看着。
  const sidebar = ctx.get('betterSidebar')
  if (sidebar === undefined || sidebar === null || typeof sidebar.registerTab !== 'function') {
    // 没有这个底座就只是少一个入口，左边那个照常可用，不算失败。
    console.warn('[lifecard] 没找到 dsh-better-sidebar，右侧栏标签页不提供；左侧栏入口不受影响。')
    return
  }
  ctx.effect(() => sidebar.registerTab({
    id: 'lifecard',
    title: 'Life Cards',
    description: '把你认识的人和虚构角色写成档案：聊着建、导入角色卡、或从材料里读出来',
    icon: () => h(TabIcon),
    order: 40,
    single: true,
    component: (props) => h(LifeCardTab, props),
  }), 'lifecard: better-sidebar tab')
}

// 只声明随宿主一起来的东西。
//
// `betterSidebar` 是另装的第三方插件，不在随附运行时里。把它写进 inject 的
// 后果不是「少一个入口」，而是 Cordis 认为这个 fiber 的前置没就绪、整个 apply
// 都不执行——干净 profile 上连自带的左侧栏图标和主面板一起消失，用户看到的是
// 「插件没装上」。所以它只走下面 ctx.get 的可选分支：有就多一个右侧标签页，
// 没有就只是少一个入口。
const inject = ['slots']



		exports.apply = apply;
		exports.inject = inject;
		exports.LifeCardTab = LifeCardTab;
		return module.exports;
	}
});
