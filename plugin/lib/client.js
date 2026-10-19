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
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`操作没成功（网络返回 ${res.status}）${text.slice(0, 200)}`)
  }
  return await res.json()
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
    default: return h('svg', common, h('circle', { cx: 12, cy: 12, r: 8 }))
  }
}

// ── 样式 ──────────────────────────────────────────────────────────

const STYLE_ID = 'lifecard-styles'
const CSS = `
.lc-root {
  --lc-bg: #fbfaf7;
  --lc-panel: #ffffff;
  --lc-ink: #1f2328;
  --lc-muted: #6b7280;
  --lc-line: #e6e2da;
  --lc-line-strong: #d6d0c4;
  --lc-accent: #3b5bdb;
  --lc-accent-ink: #ffffff;
  --lc-accent-soft: #eef1fd;
  --lc-import: #0b7285;
  --lc-import-soft: #e6f5f7;
  --lc-interview: #6741d9;
  --lc-interview-soft: #f1edfd;
  --lc-analyze: #b8860b;
  --lc-analyze-soft: #fdf4e0;
  --lc-doctor: #2f9e44;
  --lc-doctor-soft: #e9f7ec;
  --lc-danger: #c92a2a;
  --lc-danger-soft: #fdecec;
  --lc-radius: 10px;
  --lc-shadow: 0 1px 2px rgba(20, 20, 30, .06), 0 6px 20px rgba(20, 20, 30, .05);
  --lc-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;

  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--lc-bg);
  color: var(--lc-ink);
  font-size: 13px;
  line-height: 1.55;
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
  padding: 10px 12px; border-bottom: 1px solid var(--lc-line);
  background: var(--lc-panel); flex-shrink: 0;
}
.lc-title { font-weight: 650; font-size: 13.5px; letter-spacing: .01em; }
.lc-sub { color: var(--lc-muted); font-size: 11.5px; }
.lc-grow { flex: 1 1 auto; min-width: 0; }
.lc-ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.lc-body { flex: 1 1 auto; overflow-y: auto; overscroll-behavior: contain; }
.lc-pad { padding: 12px; }
.lc-stack { display: flex; flex-direction: column; gap: 8px; }
.lc-row { display: flex; align-items: center; gap: 8px; }
.lc-wrap { display: flex; flex-wrap: wrap; gap: 6px; }

/* 按钮：颜色即语义 */
.lc-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 5px;
  padding: 6px 10px; border-radius: 8px; border: 1px solid var(--lc-line-strong);
  background: var(--lc-panel); color: var(--lc-ink);
  font-size: 12.5px; font-weight: 550; cursor: pointer;
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
.lc-btn.sm { padding: 4px 8px; font-size: 12px; }
.lc-btn.block { width: 100%; }
.lc-btn.big { padding: 10px 14px; font-size: 13.5px; border-radius: 10px; }

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
.lc-action .t { font-weight: 650; font-size: 13.5px; }
.lc-action .d { color: var(--lc-muted); font-size: 11.5px; margin-top: 2px; }
.lc-action.interview { border-color: #d9d0f7; }
.lc-action.interview .ico { background: var(--lc-interview-soft); color: var(--lc-interview); }
.lc-action.import { border-color: #c3e6ea; }
.lc-action.import .ico { background: var(--lc-import-soft); color: var(--lc-import); }
.lc-action.analyze .ico { background: var(--lc-analyze-soft); color: var(--lc-analyze); }

/* 输入 */
.lc-input, .lc-textarea, .lc-select {
  width: 100%; box-sizing: border-box; font-family: inherit; font-size: 12.5px;
  padding: 7px 9px; border-radius: 8px;
  border: 1px solid var(--lc-line-strong); background: var(--lc-panel); color: var(--lc-ink);
}
.lc-textarea { resize: vertical; min-height: 72px; line-height: 1.6; }
.lc-input:focus, .lc-textarea:focus, .lc-select:focus {
  outline: none; border-color: var(--lc-accent); box-shadow: 0 0 0 3px var(--lc-accent-soft);
}

/* 表单：一组「问题 + 控件 + 一句解释」 */
.lc-fset { display: flex; flex-direction: column; gap: 14px; }
.lc-fitem { display: flex; flex-direction: column; gap: 4px; }
.lc-flabel { font-size: 12.5px; font-weight: 600; color: var(--lc-ink); }
.lc-fhint { font-size: 11.5px; color: var(--lc-muted); }
.lc-fgroup {
  display: flex; align-items: center; gap: 7px; margin: 16px 0 2px;
  font-size: 12px; font-weight: 650; color: var(--lc-muted); letter-spacing: .03em;
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
  font-weight: 650; font-size: 13px;
  background: var(--lc-accent-soft); color: var(--lc-accent);
}
.lc-avatar.big { width: 46px; height: 46px; border-radius: 12px; font-size: 19px; }
.lc-avatar.real { background: var(--lc-doctor-soft); color: var(--lc-doctor); }
.lc-avatar.fictional { background: var(--lc-interview-soft); color: var(--lc-interview); }
.lc-avatar.world { background: var(--lc-analyze-soft); color: var(--lc-analyze); }

.lc-meta { color: var(--lc-muted); font-size: 11.5px; }
.lc-tag {
  display: inline-flex; align-items: center; gap: 3px;
  padding: 1px 6px; border-radius: 999px; font-size: 11px;
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
.lc-empty h3 { margin: 0 0 4px; font-size: 13.5px; color: var(--lc-ink); font-weight: 650; }

/* 分组标题 */
.lc-group { display: flex; align-items: center; gap: 6px; margin: 14px 0 6px; color: var(--lc-muted); font-size: 11.5px; font-weight: 600; letter-spacing: .04em; }
.lc-group:first-child { margin-top: 0; }
.lc-group i { width: 3px; height: 12px; border-radius: 2px; background: var(--lc-accent); display: block; }
.lc-group.import i { background: var(--lc-import); }
.lc-group.interview i { background: var(--lc-interview); }
.lc-group.analyze i { background: var(--lc-analyze); }
.lc-group.doctor i { background: var(--lc-doctor); }

/* 提示条 */
.lc-note {
  display: flex; gap: 8px; padding: 9px 10px; border-radius: var(--lc-radius);
  background: var(--lc-accent-soft); color: var(--lc-ink); font-size: 12px;
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
  font-size: 11px; color: var(--lc-muted);
  background: var(--lc-bg); border-left: 2px solid var(--lc-line-strong);
  padding: 3px 7px; border-radius: 0 4px 4px 0; margin-top: 3px;
  overflow-wrap: anywhere;
}

/* 访谈对话 */
.lc-bubble { padding: 9px 11px; border-radius: 12px; font-size: 12.5px; max-width: 100%; }
.lc-bubble.bot { background: var(--lc-interview-soft); border: 1px solid var(--lc-interview); color: var(--lc-ink); border-top-left-radius: 4px; }
.lc-bubble.me { background: var(--lc-panel); border: 1px solid var(--lc-line); color: var(--lc-ink); border-top-right-radius: 4px; margin-left: 22px; }
.lc-opt {
  display: flex; gap: 8px; align-items: flex-start; width: 100%; text-align: left;
  padding: 7px 9px; border-radius: 8px; border: 1px solid var(--lc-line-strong);
  background: var(--lc-panel); cursor: pointer; font-family: inherit; font-size: 12.5px; color: inherit;
  transition: border-color .1s, background .1s;
}
.lc-opt:hover { border-color: var(--lc-interview); background: var(--lc-interview-soft); }
.lc-opt-num {
  width: 17px; height: 17px; border-radius: 50%; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 10.5px; font-weight: 650;
  background: var(--lc-interview-soft); color: var(--lc-interview); border: 1px solid var(--lc-interview);
}

/* 正文小节（阅读态） */
.lc-sec { padding: 9px 11px; border-radius: 9px; background: var(--lc-panel); border: 1px solid var(--lc-line); }
.lc-sec .st { font-size: 11.5px; font-weight: 650; color: var(--lc-muted); letter-spacing: .03em; margin-bottom: 3px; }
.lc-sec .sb { white-space: pre-wrap; }

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

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID) !== null) return
  const style = doc.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  doc.head.appendChild(style)
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

function Avatar({ name, kind, big }) {
  const initial = String(name ?? '?').trim().slice(0, 1) || '?'
  const cls = ['lc-avatar', big ? 'big' : '', kind === 'real' ? 'real' : kind === 'fictional' || kind === 'hybrid' ? 'fictional' : kind === 'world' ? 'world' : ''].filter(Boolean).join(' ')
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

const VIEWS = { home: 'home', card: 'card', interview: 'interview', import: 'import', analyze: 'analyze', doctor: 'doctor', setup: 'setup', newCard: 'newCard' }

/**
 * tab 组件。接收宿主给的 props（ctx / store / scope / tab / visible）。
 * 只用到 `visible`，其余一律不碰——插件不该依赖宿主内部状态。
 */
function LifeCardTab(props) {
  const [view, setView] = useState(VIEWS.home)
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
  const mounted = useRef(true)

  useEffect(() => () => { mounted.current = false }, [])

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
        if (mounted.current) setListing(list)
      }
    } catch (e) {
      if (mounted.current) setError(String(e?.message ?? e))
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

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
      const ok = result.imported ?? 0
      const bad = result.failed ?? 0
      flash(`导入完成：${ok} 张成功${bad > 0 ? `，${bad} 张没读进去` : ''}`, bad > 0 ? 'warn' : 'ok')
      if (bad > 0) {
        setError(result.results.filter((r) => !r.ok).map((r) => `${r.name}：${r.error}`).join('\n'))
      }
      setView(VIEWS.home)
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy('')
    }
  }, [flash, refresh])

  const openCard = useCallback(async (card) => {
    setBusy('card')
    try {
      const detail = await call('card.get', { path: card.path })
      setActiveCard(detail)
      setView(VIEWS.card)
    } catch (e) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy('')
    }
  }, [])

  const header = () => {
    const titles = {
      [VIEWS.home]: 'Life Cards',
      [VIEWS.card]: activeCard?.data?.name ?? '这张卡',
      [VIEWS.interview]: '陪他聊聊',
      [VIEWS.import]: '添加',
      [VIEWS.analyze]: '让 AI 读材料',
      [VIEWS.doctor]: '检查一下',
      [VIEWS.setup]: '选个文件夹',
      [VIEWS.newCard]: '新建一张卡',
    }
    const canBack = view !== VIEWS.home && view !== VIEWS.setup
    return h('div', { className: 'lc-head' },
      canBack ? h('button', { className: 'lc-btn ghost sm', onClick: () => { setView(VIEWS.home); setError(null); setProposal(null) }, title: '回到列表', type: 'button' }, h(Icon, { name: 'back', size: 14 })) : null,
      h('div', { className: 'lc-grow lc-ellipsis' },
        h('div', { className: 'lc-title lc-ellipsis' }, titles[view] ?? 'Life Cards'),
        view === VIEWS.home
          ? h('div', { className: 'lc-sub lc-ellipsis' }, '你的人物档案')
          : null,
      ),
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
      return h(SetupView, { state, onDone: async (ws) => { await call('workspace.init', { workspace: ws }); await refresh(ws); setView(VIEWS.home); flash('好了，可以开始了') } })
    }
    switch (view) {
      case VIEWS.import:
        return h(ImportView, { busy, onImport: doImport, onAnalyze: () => setView(VIEWS.analyze), listing })
      case VIEWS.interview:
        return h(InterviewView, {
          state, listing, preset: interviewFor, onRecorded: refresh, flash,
          onDone: () => { setInterviewFor(null); setView(VIEWS.home); refresh() },
          onAnalyze: (about) => { setInterviewFor(about ?? null); setView(VIEWS.analyze) },
        })
      case VIEWS.analyze:
        return h(AnalyzeView, {
          listing, state, flash, presetAbout: interviewFor,
          onProposal: (p) => { setProposal(p); setView(VIEWS.card) },
          onBack: () => { setInterviewFor(null); setView(VIEWS.home) },
          onNeedMaterial: () => setView(VIEWS.import),
        })
      case VIEWS.card:
        return activeCard === null
          ? h(HomeView, { state, listing, onOpen: openCard, onNavigate: setView, onMore: () => setShowMore(!showMore), showMore, onProposal: async (json) => { const p = await call('proposal.get', { json }); setProposal(p); setView(VIEWS.card) }, busy, onDoDoctor: async () => { const r = await call('doctor.run', {}); setDoctor(r); setView(VIEWS.doctor) } })
          : h(CardView, {
              card: activeCard,
              proposal,
              setProposal,
              flash,
              onRefresh: async () => { const detail = await call('card.get', { path: activeCard.path }); setActiveCard(detail) },
              onDeleted: async () => { setActiveCard(null); setView(VIEWS.home); await refresh() },
              onInterview: (preset) => { setInterviewFor(preset); setView(VIEWS.interview) },
              onAnalyze: () => { setInterviewFor({ id: activeCard.data?.id, name: activeCard.data?.name }); setView(VIEWS.analyze) },
            })
      case VIEWS.newCard:
        return h(NewCardView, {
          state,
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
      case VIEWS.doctor:
        return h(DoctorView, { report: doctor, onRun: async () => { const r = await call('doctor.run', {}); setDoctor(r); await refresh() } })
      default:
        return h(HomeView, { state, listing, onOpen: openCard, onNavigate: setView, onMore: () => setShowMore(!showMore), showMore, onProposal: async (json) => { const p = await call('proposal.get', { json }); setProposal(p); setView(VIEWS.card) }, busy, onDoDoctor: async () => { const r = await call('doctor.run', {}); setDoctor(r); setView(VIEWS.doctor) } })
    }
  }

  return h('div', { className: 'lc-root' },
    header(),
    h('div', { className: 'lc-body' },
      toast === null ? null : h('div', { style: { padding: '10px 12px 0' } },
        h(Note, { tone: toast.tone, icon: toast.tone === 'warn' ? 'warning' : 'check' }, toast.message)),
      error !== null && state !== null
        ? h('div', { style: { padding: '10px 12px 0' } },
            h(Note, { tone: 'err', icon: 'warning' }, h('div', { style: { whiteSpace: 'pre-wrap' } }, error),
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

  const check = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await call('workspace.inspect', { path: target })
      setInspect(r)
    } catch (e) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
  }

  const create = async () => {
    setBusy(true); setErr(null)
    try { await onDone(target) } catch (e) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
  }

  return h('div', { className: 'lc-pad lc-stack' },
    h('div', { className: 'lc-empty', style: { paddingBottom: 12 } },
      h('div', { className: 'lc-empty-icon' }, h(Icon, { name: 'folder', size: 22 })),
      h('h3', null, '先挑一个文件夹放你的档案'),
      h('div', { className: 'lc-meta' }, '每个人会变成这里的一个文本文件。', h('br'), '你随时能在访达（Finder）里找到它们，也能用别的软件打开。'),
    ),
    h(Field, { label: '放在哪里', hint: '下面这个位置就行，直接点最下面的按钮。' },
      h('input', { className: 'lc-input', value: target, onChange: (e) => setTarget(e.target.value), placeholder: '/Users/你/Documents/Life Cards', spellCheck: false }),
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
    err === null ? null : h(Note, { tone: 'err', icon: 'warning' }, err),
    h('div', { style: { marginTop: 4 } },
      h(Btn, { tone: 'primary', big: true, block: true, onClick: create, disabled: busy || target.trim() === '', icon: 'check' },
        busy ? '正在准备…' : inspect?.isLifeCard === true ? '就用这个文件夹' : '开始吧'),
    ),
  )
}

// ── 首页 ──────────────────────────────────────────────────────────

function HomeView({ state, listing, onOpen, onNavigate, onProposal, busy, onDoDoctor, showMore, onMore }) {
  const [q, setQ] = useState('')
  const cards = listing?.cards ?? []
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (needle === '') return cards
    return cards.filter((c) => `${c.name} ${c.id} ${(c.tags ?? []).join(' ')} ${c.relation ?? ''}`.toLowerCase().includes(needle))
  }, [cards, q])
  const proposals = listing?.proposals ?? []
  const materials = listing?.materials ?? []
  const byKind = useMemo(() => {
    const real = filtered.filter((c) => c.kind === 'real' || c.kind === 'self' || c.kind === 'hybrid')
    const fic = filtered.filter((c) => c.kind === 'fictional')
    const other = filtered.filter((c) => !['real', 'self', 'hybrid', 'fictional'].includes(c.kind))
    return { real, fic, other }
  }, [filtered])

  if (cards.length === 0) {
    return h('div', { className: 'lc-pad lc-stack' },
      h('div', { className: 'lc-empty', style: { padding: '18px 8px 10px' } },
        h('div', { className: 'lc-empty-icon' }, h(Icon, { name: 'book', size: 22 })),
        h('h3', null, '还没有档案'),
        h('div', { className: 'lc-meta' }, '选一个开始的方式，随时可以换别的：'),
      ),
      h(Action, {
        tone: 'interview', icon: 'chat',
        title: '陪我聊聊，边聊边建',
        desc: '它会问几个具体的问题。答不上来就跳过，一句也不想说也行。',
        onClick: () => onNavigate(VIEWS.interview),
      }),
      h(Action, {
        tone: 'import', icon: 'import',
        title: '把已有的角色卡拖进来',
        desc: '别人给你的角色卡文件（.png 或 .json），放进来就能看。',
        onClick: () => onNavigate(VIEWS.import),
      }),
      h(Action, {
        icon: 'pencil',
        title: '我自己填',
        desc: '一张空表，一个字段一个字段地写。',
        onClick: () => onNavigate(VIEWS.newCard),
      }),
    )
  }

  return h('div', { className: 'lc-pad lc-stack' },
    h('div', { className: 'lc-row' },
      h('input', { className: 'lc-input', value: q, onChange: (e) => setQ(e.target.value), placeholder: '找找看…', spellCheck: false }),
      h(Btn, { tone: 'primary', size: 'sm', icon: 'plus', onClick: () => onNavigate(VIEWS.newCard), title: '新建一张卡' }, '新建'),
    ),

    h('div', { className: 'lc-row', style: { marginTop: 2 } },
      h(Btn, { tone: 'interview', size: 'sm', icon: 'chat', onClick: () => onNavigate(VIEWS.interview) }, '聊着建'),
      h(Btn, { tone: 'import', size: 'sm', icon: 'import', onClick: () => onNavigate(VIEWS.import) }, '导入'),
      h('div', { className: 'lc-grow' }),
      materials.length === 0 ? null : h(Btn, { tone: 'analyze', size: 'sm', icon: 'spark', onClick: () => onNavigate(VIEWS.analyze) }, `整理 ${materials.length} 份材料`),
    ),

    byKind.real.length > 0
      ? h('div', null,
          h(GroupTitle, { icon: 'people' }, `认识的人 · ${byKind.real.length}`),
          h('div', { className: 'lc-stack' }, byKind.real.map((c) => h(CardRow, { key: c.path, card: c, onOpen }))),
        )
      : null,

    byKind.fic.length > 0
      ? h('div', null,
          h(GroupTitle, { tone: 'interview', icon: 'book' }, `虚构角色 · ${byKind.fic.length}`),
          h('div', { className: 'lc-stack' }, byKind.fic.map((c) => h(CardRow, { key: c.path, card: c, onOpen }))),
        )
      : null,

    byKind.other.length > 0
      ? h('div', null,
          h(GroupTitle, { tone: 'analyze', icon: 'list' }, `其他 · ${byKind.other.length}`),
          h('div', { className: 'lc-stack' }, byKind.other.map((c) => h(CardRow, { key: c.path, card: c, onOpen }))),
        )
      : null,

    q.trim() !== '' && filtered.length === 0
      ? h('div', { className: 'lc-meta', style: { textAlign: 'center', padding: 12 } }, '没找到。换个词试试？')
      : null,

    proposals.length > 0
      ? h('div', null,
          h(GroupTitle, { tone: 'analyze', icon: 'spark' }, `还等着你看的建议 · ${proposals.length}`),
          h('div', { className: 'lc-stack' }, proposals.slice(0, 6).map((p) => h('button', {
            key: p.json, className: 'lc-card-item', type: 'button',
            onClick: () => onProposal(p.json),
          },
            h('div', { className: 'lc-avatar', style: { background: 'var(--lc-analyze-soft)', color: 'var(--lc-analyze)' } }, h(Icon, { name: 'spark', size: 14 })),
            h('div', { className: 'lc-grow' },
              h('div', { style: { fontWeight: 600 } }, `关于「${p.about}」`),
              h('div', { className: 'lc-meta' }, `${p.accepted} 条可以采用`, p.rejected > 0 ? ` · ${p.rejected} 条没能核实，已丢掉` : '', ' · ', shortDate(p.generated_at)),
            ),
          ))),
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
      }, h(Icon, { name: showMore ? 'chevron' : 'chevron', size: 12 }), showMore ? '收起' : '更多工具'),
    ),
    showMore === true
      ? h('div', { className: 'lc-stack' },
          h('div', { className: 'lc-meta' }, materials.length === 0
            ? '你还没有放材料。想用材料建卡，先去「添加」里贴一段文字。'
            : `已经放了 ${materials.length} 份材料（访谈记录、聊天记录、你写的文字都算）。`),
          h('div', { className: 'lc-row' },
            h(Btn, { size: 'sm', icon: 'spark', onClick: () => onNavigate(VIEWS.analyze), disabled: materials.length === 0 }, '让 AI 读出建议'),
            h(Btn, { size: 'sm', icon: 'doctor', onClick: onDoDoctor }, '检查档案有没有问题'),
          ),
        )
      : null,
  )
}

function CardRow({ card, onOpen }) {
  return h('button', { className: 'lc-card-item', onClick: () => onOpen(card), type: 'button' },
    h(Avatar, { name: card.name, kind: card.kind }),
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
        h('span', { className: 'lc-meta', style: { flexShrink: 0 } }, `${card.coverage}%`),
      ),
      (card.tags ?? []).length > 0
        ? h('div', { className: 'lc-wrap', style: { marginTop: 5 } }, card.tags.slice(0, 4).map((t) => h(Tag, { key: t }, t)))
        : null,
    ),
  )
}

// ── 单张卡 ────────────────────────────────────────────────────────

function CardView({ card, onRefresh, proposal, setProposal, flash, onDeleted, onInterview, onAnalyze }) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState(null)
  const [showExport, setShowExport] = useState(false)

  const data = card?.data ?? {}
  const sections = card?.sections ?? []
  const cov = card?.coverage
  const issues = card?.validation?.issues ?? []

  useEffect(() => { setEditing(false) }, [card?.path])

  const exportPng = async () => {
    setBusy('png'); setErr(null)
    try {
      const r = await call('export.card', { path: card.path })
      if (r.ok !== true) { setErr(r.error ?? '导出没成功'); return }
      downloadBase64(r.base64, r.filename, 'image/png')
      flash(r.consistent === false ? '导出好了，但内容对不上，请把这个问题告诉我' : '导出好了，可以拿去用了', r.consistent === false ? 'warn' : 'ok')
    } catch (e) { setErr(String(e?.message ?? e)) } finally { setBusy('') }
  }

  const exportJson = async () => {
    setBusy('json'); setErr(null)
    try {
      const r = await call('export.json', { path: card.path })
      if (r.ok !== true) { setErr(r.error ?? '导出没成功'); return }
      downloadText(JSON.stringify(r.json, null, 2), r.filename)
      flash('导出好了')
    } catch (e) { setErr(String(e?.message ?? e)) } finally { setBusy('') }
  }

  const remove = async () => {
    const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm(`确定删掉「${data.name}」吗？\n\n删掉之后，导出和 AI 都不会再看到它。`)
      : true
    if (!ok) return
    setBusy('del'); setErr(null)
    try {
      const r = await call('card.delete', { path: card.path, reason: '用户删除' })
      if (r.ok !== true) { setErr(r.error ?? '没删掉'); return }
      flash('删掉了')
      onDeleted()
    } catch (e) { setErr(String(e?.message ?? e)) } finally { setBusy('') }
  }

  if (editing) {
    return h(CardForm, {
      card,
      onCancel: () => setEditing(false),
      onSaved: async () => { setEditing(false); await onRefresh(); flash('存好了') },
    })
  }

  const relationTypeId = (card?.relationIdHint ?? null)
  const shownSections = sections.filter((s) => String(s.body ?? '').trim() !== '')

  return h('div', { className: 'lc-pad lc-stack' },
    err === null ? null : h(Note, { tone: 'err', icon: 'warning' }, err),

    proposal !== null
      ? h(ProposalPanel, { proposal, onClose: () => setProposal(null), onApplied: async () => { setProposal(null); await onRefresh(); flash('存进卡里了') } })
      : null,

    h('div', { className: 'lc-row' },
      h(Avatar, { name: data.name, kind: data.kind, big: true }),
      h('div', { className: 'lc-grow' },
        h('div', { style: { fontWeight: 650, fontSize: 15 } }, data.name ?? '(还没起名字)'),
        h('div', { className: 'lc-meta' }, [KIND_LABEL[data.kind] ?? data.kind, data.relation, data.address].filter(Boolean).join(' · ')),
      ),
    ),

    cov === undefined ? null : h('div', null,
      h('div', { className: 'lc-row' },
        h('span', { className: 'lc-label', style: { fontSize: 11.5, color: 'var(--lc-muted)', fontWeight: 600 } }, '写完了多少'),
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
      h(Btn, { tone: 'analyze', size: 'sm', icon: 'spark', onClick: onAnalyze }, '读材料'),
    ),

    cov !== undefined && cov.empty.length > 0
      ? h('div', { className: 'lc-meta' }, '「接着聊」会专门问还空着的那几样。')
      : null,

    issues.length > 0
      ? h('div', { className: 'lc-stack' }, issues.map((i, n) => h(Note, { key: n, tone: i.level === 'error' ? 'err' : 'warn', icon: 'warning' },
          i.message)))
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
      h('div', { className: 'lc-grow' }),
      h(Btn, { size: 'sm', tone: 'danger', icon: 'trash', onClick: remove, disabled: busy !== '' }, '删掉'),
    ),
    showExport === true
      ? h('div', { className: 'lc-stack' },
          h(Btn, { size: 'sm', onClick: exportJson, disabled: busy !== '' }, '存成数据文件（.json）'),
          h('div', { className: 'lc-meta' }, '一般来说用不上。别人要原始数据的时候才需要。'),
        )
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
  if (rows.length === 0) return null
  return h('div', null, h('div', { className: 'lc-sep' }), h('div', { className: 'lc-stack' }, rows))
}

// ── 编辑表单 ──────────────────────────────────────────────────────

/**
 * 真正能填的表单。
 * 旧版这里是一个 JSON 文本框——对不懂技术的人来说等于「没做」。
 * 现在每一个字段都有自己的输入控件，标签用中文，解释一句话讲清该写什么。
 */
function CardForm({ card, onCancel, onSaved }) {
  const original = card?.data ?? {}
  const [data, setData] = useState(() => cloneData(original))
  const [sections, setSections] = useState(() => (card?.sections ?? []).map((s) => ({ ...s })))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [more, setMore] = useState(false)

  const set = (key, value) => setData((prev) => ({ ...prev, [key]: value }))
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
      await onSaved()
    } catch (e) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
  }

  const kind = String(data.kind ?? 'real')
  const isPerson = kind === 'real' || kind === 'hybrid' || kind === 'self' || kind === 'fictional'

  return h('div', { className: 'lc-pad lc-stack' },
    err === null ? null : h(Note, { tone: 'err', icon: 'warning' }, err),
    h('div', { className: 'lc-meta' }, '写多少算多少。空着的地方不会影响别的东西，以后想起来再补。'),

    h('div', { className: 'lc-fset' },
      h('div', { className: 'lc-fgroup' }, '这个人'),
      h(Field, { label: '叫什么' },
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
        ? h(Field, { label: '跟你的关系', hint: '写「母亲」「大学室友」都行，随便写。' },
            h('input', { className: 'lc-input', value: String(data.relation ?? ''), onChange: (e) => set('relation', e.target.value), placeholder: '母亲', spellCheck: false }),
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
              onChange: (e) => set('consent', { basis: e.target.value }),
            }, Object.keys(CONSENT_LABEL).map((k) => h('option', { key: k, value: k }, CONSENT_LABEL[k]))),
          )
        : null,
    ),

    h('div', { style: { marginTop: 12 } },
      h('button', { className: 'lc-btn ghost sm', type: 'button', onClick: () => setMore(!more), style: { width: '100%', justifyContent: 'flex-start' } },
        h(Icon, { name: 'chevron', size: 12 }), more ? '收起不常用的' : '还有几个不常用的'),
    ),
    more === true
      ? h('div', { className: 'lc-fset' },
          h(Field, { label: '属于哪个世界', hint: '写小说、建宇宙的时候才用。现实中的人就留空。' },
            h('input', { className: 'lc-input', value: String(data.world ?? ''), onChange: (e) => set('world', e.target.value), placeholder: 'reality', spellCheck: false }),
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

/** 一行一条的列表编辑器（禁忌、标签这类）。 */
function ListEditor({ items, onChange, placeholder }) {
  const rows = asArray(items).map((t) => (typeof t === 'string' ? t : t?.label ?? t?.key ?? '')).filter((t) => typeof t === 'string')
  const list = rows.length === 0 ? [''] : rows
  const update = (i, v) => {
    const next = list.slice()
    next[i] = v
    onChange(next.filter((s) => s.trim() !== '').map((label) => ({ label })))
  }
  return h('div', { className: 'lc-stack' },
    list.map((v, i) => h('div', { key: i, className: 'lc-listrow' },
      h('input', { className: 'lc-input', value: v, onChange: (e) => update(i, e.target.value), placeholder, spellCheck: false }),
      list.length === 1 && (v ?? '') === ''
        ? null
        : h('button', { className: 'lc-iconbtn', type: 'button', title: '删掉这条', onClick: () => { const next = list.slice(); next.splice(i, 1); onChange(next.filter((s) => s.trim() !== '').map((label) => ({ label }))) } }, h(Icon, { name: 'trash', size: 12 })),
    )),
    h('div', null, h(Btn, { size: 'sm', icon: 'plus', onClick: () => onChange([...list.filter((s) => s.trim() !== '').map((label) => ({ label })), { label: '' }]) }, '再加一条')),
  )
}

/** 「会什么」：一件能力 + 一个程度。 */
function CompetencyEditor({ items, onChange }) {
  const rows = asArray(items).filter((c) => c !== null && typeof c === 'object').map((c) => ({ key: String(c.key ?? c.label ?? ''), level: String(c.level ?? '熟手') }))
  const list = rows.length === 0 ? [{ key: '', level: '熟手' }] : rows
  const emit = (next) => onChange(next.filter((r) => r.key.trim() !== ''))
  const update = (i, patch) => { const next = list.map((r, n) => (n === i ? { ...r, ...patch } : r)); emit(next) }
  return h('div', { className: 'lc-stack' },
    list.map((r, i) => h('div', { key: i, className: 'lc-listrow' },
      h('input', { className: 'lc-input', value: r.key, onChange: (e) => update(i, { key: e.target.value }), placeholder: '做红烧肉', spellCheck: false }),
      h('select', { className: 'lc-select', value: r.level, onChange: (e) => update(i, { level: e.target.value }) },
        LEVEL_LABEL.map((l) => h('option', { key: l, value: l }, l))),
      h('button', {
        className: 'lc-iconbtn', type: 'button', title: '删掉这条',
        onClick: () => emit(list.filter((_, n) => n !== i)),
      }, h(Icon, { name: 'trash', size: 12 })),
    )),
    h('div', null, h(Btn, { size: 'sm', icon: 'plus', onClick: () => emit([...list.filter((r) => r.key.trim() !== ''), { key: '', level: '熟手' }]) }, '再加一件')),
  )
}

// ── 建议面板 ──────────────────────────────────────────────────────

function ProposalPanel({ proposal, onClose, onApplied }) {
  const [items, setItems] = useState(() => (proposal?.items ?? []).map((i) => ({ ...i })))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const checked = items.filter((i) => i.checked).length

  const toggle = (index) => {
    setItems((prev) => prev.map((item, n) => (n === index ? { ...item, checked: !item.checked } : item)))
  }

  const apply = async () => {
    setBusy(true); setErr(null)
    try {
      const r = await call('proposal.apply', { json: proposal.json })
      if (r.ok !== true) { setErr(r.error ?? '没存上'); return }
      await onApplied(r)
    } catch (e) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
  }

  return h('div', { className: 'lc-stack', style: { border: '1px solid var(--lc-doctor)', borderRadius: 'var(--lc-radius)', padding: 10, background: 'var(--lc-panel)' } },
    h('div', { className: 'lc-row' },
      h(Icon, { name: 'spark', size: 15 }),
      h('span', { style: { fontWeight: 650 } }, 'AI 从材料里读出来的东西'),
      h('span', { className: 'lc-grow' }),
      h('span', { className: 'lc-meta' }, `选了 ${checked} 条`),
    ),
    h('div', { className: 'lc-meta' }, '每一条下面都引用了材料里的原话。它编不出来的——材料里找不到原文的，已经被丢掉了。'),
    err === null ? null : h(Note, { tone: 'err', icon: 'warning' }, err),
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
    h('div', { className: 'lc-row' },
      h(Btn, { tone: 'primary', onClick: apply, disabled: busy || checked === 0, icon: 'check' }, checked === 0 ? '先勾选要的' : `就用这 ${checked} 条`),
      h(Btn, { onClick: onClose, icon: 'x' }, '都不要'),
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

function describeValue(item) {
  const v = item?.value
  if (v === null || v === undefined) return String(item?.field ?? '（空）')
  if (typeof v === 'string') return v
  if (typeof v !== 'object') return String(v)
  const label = v.label ?? v.key ?? v.name
  if (label !== undefined && v.level !== undefined) return `${label} / ${v.level}`
  if (label !== undefined) return String(label)
  return Object.keys(v).map((k) => `${k}: ${typeof v[k] === 'object' ? JSON.stringify(v[k]) : v[k]}`).join('；')
}

// ── 新建空卡 ──────────────────────────────────────────────────────

function NewCardView({ state, onCreate }) {
  const [name, setName] = useState('')
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
    } catch (e) { setErr(String(e?.message ?? e)) } finally { setBusy(false) }
  }

  return h('div', { className: 'lc-pad lc-stack' },
    h('div', { className: 'lc-meta' }, '只要一个名字就能开始。其他的建好之后再慢慢填。'),
    h('div', { className: 'lc-fset' },
      h(Field, { label: '叫什么' },
        h('input', { className: 'lc-input', value: name, onChange: (e) => setName(e.target.value), placeholder: '妈妈 / 老张 / 塞拉菲娜', spellCheck: false }),
      ),
      h(Field, { label: '他是' },
        h('select', { className: 'lc-select', value: kind, onChange: (e) => setKind(e.target.value) },
          KIND_CHOICES.map((k) => h('option', { key: k, value: k }, KIND_LABEL[k]))),
      ),
      kind === 'real' || kind === 'hybrid' || kind === 'self'
        ? h(Field, { label: '跟你的关系', hint: '可以不填。' },
            h('input', { className: 'lc-input', value: relation, onChange: (e) => setRelation(e.target.value), placeholder: '母亲', spellCheck: false }),
          )
        : null,
    ),
    err === null ? null : h(Note, { tone: 'err', icon: 'warning' }, err),
    h(Btn, { tone: 'primary', big: true, block: true, onClick: create, disabled: busy, icon: 'check' }, busy ? '正在建…' : '建这张卡'),
  )
}

// ── 访谈 ──────────────────────────────────────────────────────────

function InterviewView({ state, listing, preset, onRecorded, flash, onDone, onAnalyze }) {
  const [phase, setPhase] = useState('pick')   // pick | talk | done
  const [name, setName] = useState(preset?.name ?? '')
  const [relation, setRelation] = useState(() => {
    const relations = state?.relations ?? []
    const hit = relations.find((r) => r.label === preset?.relationLabel)
    return hit?.id ?? 'parent'
  })
  const [plan, setPlan] = useState(null)
  const [queue, setQueue] = useState([])
  const [current, setCurrent] = useState(null)
  const [answer, setAnswer] = useState('')
  const [log, setLog] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [aboutId, setAboutId] = useState(preset?.id ?? '')
  const scrollRef = useRef(null)

  const relations = state?.relations ?? []

  useEffect(() => {
    if (scrollRef.current !== null) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [log, current])

  const start = async () => {
    const targetName = (preset?.name ?? name).trim()
    if (targetName === '') { setErr('先告诉我这是谁'); return }
    setBusy(true); setErr(null)
    try {
      const id = preset?.id ?? safeId(targetName)
      const existing = (listing?.cards ?? []).find((c) => c.id === id || c.name === targetName)
      if (existing === undefined) {
        await call('card.save', {
          data: { lifecard: '0.1', id, kind: 'real', world: 'reality', name: targetName, relation: relations.find((r) => r.id === relation)?.label ?? '' },
          sections: [],
        })
      }
      setAboutId(existing?.id ?? id)
      const p = await call('interview.plan', { about: existing?.id ?? id, relation, limit: 3 })
      setPlan(p)
      setQueue(p.next ?? [])
      setCurrent((p.next ?? [])[0] ?? null)
      setPhase('talk')
      setLog([{ role: 'bot', text: `好，我们开始。\n一次问一件小事，想不起来就跳过。` }])
    } catch (e) {
      setErr(String(e?.message ?? e))
    } finally { setBusy(false) }
  }

  const advance = async (status, reason) => {
    if (current === null) return
    const q = current
    setBusy(true); setErr(null)
    try {
      await call('interview.record', {
        about: aboutId,
        q: q.id,
        ask: q.ask,
        answer: status === 'answered' ? answer : '',
        status,
        reason,
        fills: q.fills,
      })
      if (status === 'answered') {
        setLog((prev) => [...prev, { role: 'bot', text: q.ask, options: q.options }, { role: 'me', text: answer.trim() }])
      } else {
        setLog((prev) => [...prev, { role: 'bot', text: q.ask, options: q.options }, { role: 'me', text: status === 'skipped' ? (reason === 'sealed' ? '（这个不想说）' : '（跳过）') : '（以后再说）' }])
      }
      setAnswer('')
      // 队列推进
      const rest = queue.slice(1)
      if (rest.length === 0) {
        const p = await call('interview.plan', { about: aboutId, relation, limit: 3 })
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
      setErr(String(e?.message ?? e))
    } finally { setBusy(false) }
  }

  if (phase === 'pick') {
    const lockedName = (preset?.name ?? '').trim() !== ''
    return h('div', { className: 'lc-pad lc-stack' },
      h('div', { className: 'lc-empty', style: { paddingBottom: 8 } },
        h('div', { className: 'lc-empty-icon', style: { background: 'var(--lc-interview-soft)', color: 'var(--lc-interview)' } }, h(Icon, { name: 'chat', size: 22 })),
        h('h3', null, lockedName ? `接着聊 ${preset.name}` : '边聊边建一张卡'),
        h('div', { className: 'lc-meta' }, '它一次只问一件具体的小事。', h('br'), '答不上来就跳过；说了「不想说」的，以后不会再问。'),
      ),
      lockedName
        ? h(Note, { tone: undefined, icon: 'person' }, `正在给「${preset.name}」补内容。`)
        : h(Field, { label: '这是谁' },
            h('input', { className: 'lc-input', value: name, onChange: (e) => setName(e.target.value), placeholder: '妈妈 / 爷爷 / 老张', spellCheck: false }),
          ),
      h(Field, { label: '你们是什么关系', hint: '关系不同，问的问题不一样。' },
        h('select', { className: 'lc-select', value: relation, onChange: (e) => setRelation(e.target.value) },
          relations.map((r) => h('option', { key: r.id, value: r.id }, r.label))),
      ),
      h('div', { className: 'lc-meta' }, relations.find((r) => r.id === relation)?.hint ?? ''),
      err === null ? null : h(Note, { tone: 'err', icon: 'warning' }, err),
      h(Btn, { tone: 'interview', big: true, block: true, onClick: start, disabled: busy, icon: 'send' }, busy ? '准备中…' : '开始聊'),
    )
  }

  if (phase === 'done') {
    return h('div', { className: 'lc-pad lc-stack' },
      h('div', { className: 'lc-empty' },
        h('div', { className: 'lc-empty-icon', style: { background: 'var(--lc-doctor-soft)', color: 'var(--lc-doctor)' } }, h(Icon, { name: 'check', size: 22 })),
        h('h3', null, '这一轮问完了'),
        h('div', { className: 'lc-meta' }, plan === null ? '' : `现在写满了 ${plan.coverage}%`),
      ),
      plan === null ? null : h(Note, { tone: 'ok', icon: 'check' }, `你说的都记下来了。还空着：${(plan.empty ?? []).slice(0, 8).join('、')}`),
      h(Btn, { tone: 'primary', big: true, block: true, onClick: () => onAnalyze({ id: aboutId, name: preset?.name ?? name }) }, '把刚才说的整理进卡里'),
      h(Btn, { block: true, onClick: () => { onDone() } }, '先这样，回头再说'),
      h('div', { className: 'lc-meta', style: { textAlign: 'center' } }, '你说的每句话都存成了材料。整理时会标出原文出处，编不出来的。'),
    )
  }

  return h('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } },
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
      err === null ? null : h('div', { style: { marginBottom: 6 } }, h(Note, { tone: 'err', icon: 'warning' }, err)),
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
        h(Btn, { size: 'sm', tone: 'ghost', onClick: () => setPhase('done') }, '今天到这'),
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

  const handleFiles = (fileList) => {
    const files = Array.from(fileList ?? []).filter((f) => /\.(png|json|charx|zip)$/i.test(f.name))
    if (files.length === 0) return
    onImport(files)
  }

  return h('div', { className: 'lc-pad lc-stack' },
    h('div', { className: 'lc-row' },
      h(Btn, { tone: tab === 'card' ? 'primary' : undefined, size: 'sm', icon: 'card', onClick: () => setTab('card') }, '角色卡文件'),
      h(Btn, { tone: tab === 'text' ? 'primary' : undefined, size: 'sm', icon: 'book', onClick: () => setTab('text') }, '一段文字'),
    ),

    tab === 'card'
      ? h('div', { className: 'lc-stack' },
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
            h('div', { className: 'lc-meta' }, '别人给你的角色卡（.png 图片或 .json 文件）都能读。', h('br'), '可以一次选好几个。'),
            h('input', {
              ref: inputRef, type: 'file', multiple: true, accept: '.png,.json,.charx,.zip',
              style: { display: 'none' }, onChange: (e) => handleFiles(e.target.files),
            }),
          ),
          busy === 'import' ? h('div', { className: 'lc-row' }, h(Spinner), h('span', { className: 'lc-meta' }, '正在读…')) : null,
          h(Note, { tone: undefined, icon: 'check' }, '导入进来的卡会原样保留所有内容，包括这个软件不认识的字段。你在这里改过的部分才会变，导出时一起带走。'),
        )
      : h('div', { className: 'lc-stack' },
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

  const save = async () => {
    setBusy(true); setMsg(null)
    try {
      const r = await call('import.text', { about, content: text, name: about })
      if (r.ok !== true) { setMsg({ tone: 'err', text: r.error ?? '没存上' }); return }
      setMsg({ tone: 'ok', text: `存好了（${r.chars} 字）。` })
      setText('')
    } catch (e) { setMsg({ tone: 'err', text: String(e?.message ?? e) }) } finally { setBusy(false) }
  }

  const pickFile = async (file) => {
    if (file === undefined) return
    setBusy(true); setMsg(null)
    try {
      const content = await file.text()
      setText(content)
      if (about === '') setAbout(file.name.replace(/\.[^.]+$/, ''))
      setMsg({ tone: undefined, text: `读进来了（${content.length} 字）。确认「这是关于谁」之后点保存。` })
    } catch (e) { setMsg({ tone: 'err', text: String(e?.message ?? e) }) } finally { setBusy(false) }
  }

  return h('div', { className: 'lc-fset' },
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
      ? h('div', null, h(Btn, { tone: 'analyze', size: 'sm', icon: 'spark', onClick: () => onAnalyze?.() }, '让 AI 读一读'))
      : null,
  )
}

// ── 让 AI 读材料 ──────────────────────────────────────────────────

function AnalyzeView({ listing, state, flash, onProposal, presetAbout, onBack, onNeedMaterial }) {
  const materials = listing?.materials ?? []
  const cards = listing?.cards ?? []
  const [about, setAbout] = useState(presetAbout?.id ?? '')
  const [chosen, setChosen] = useState([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [result, setResult] = useState(null)

  useEffect(() => {
    if (about === '' && cards.length > 0) setAbout(cards[0].id)
  }, [cards, about])

  const toggleMaterial = (path) => {
    setChosen((prev) => prev.includes(path) ? prev.filter((p) => p !== path) : [...prev, path])
  }

  const run = async () => {
    setBusy(true); setErr(null); setResult(null)
    try {
      const r = await call('analyze.run', { about, name: cards.find((c) => c.id === about)?.name ?? about, materials: chosen.length > 0 ? chosen : undefined })
      if (r.ok !== true) { setErr(r.error ?? '没跑成'); return }
      setResult(r)
      flash(`读出了 ${r.accepted} 条${r.rejected > 0 ? `，${r.rejected} 条没能核实已丢掉` : ''}`)
    } catch (e) {
      setErr(String(e?.message ?? e))
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

    h(Field, { label: '整理谁' },
      cards.length === 0
        ? h('div', { className: 'lc-meta' }, '还没有卡。先建一张。')
        : h('select', { className: 'lc-select', value: about, onChange: (e) => setAbout(e.target.value) },
            cards.map((c) => h('option', { key: c.id, value: c.id }, c.name))),
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

    err === null ? null : h(Note, { tone: 'err', icon: 'warning' }, err),

    h('div', { className: 'lc-row' },
      h(Btn, { tone: 'analyze', big: true, onClick: run, disabled: busy || about === '' || materials.length === 0, icon: 'spark' }, busy ? '正在读…' : '开始读'),
      busy ? h(Spinner) : null,
    ),

    result === null ? null : h('div', null,
      h(Note, { tone: 'ok', icon: 'check' },
        h('div', null, `读出了 ${result.accepted} 条。`),
        result.rejected > 0 ? h('div', { className: 'lc-meta', style: { marginTop: 3 } }, `另有 ${result.rejected} 条在材料里找不到原句，已经丢掉——AI 编的东西进不来。`) : null,
      ),
      h('div', { style: { marginTop: 8 } },
        h(Btn, { tone: 'primary', big: true, block: true, icon: 'check', onClick: async () => {
          try {
            const p = await call('proposal.get', { json: result.json })
            onProposal(p)
          } catch (e) { setErr(String(e?.message ?? e)) }
        } }, '看看读出了什么'),
      ),
    ),
  )
}

// ── 检查 ──────────────────────────────────────────────────────────

function DoctorView({ report, onRun }) {
  const [busy, setBusy] = useState(false)
  const run = async () => { setBusy(true); try { await onRun() } finally { setBusy(false) } }

  return h('div', { className: 'lc-pad lc-stack' },
    h(Btn, { tone: 'doctor', big: true, block: true, onClick: run, disabled: busy, icon: 'doctor' }, busy ? '正在检查…' : report === null ? '开始检查' : '再检查一次'),
    h('div', { className: 'lc-meta' }, '检查你的档案里有没有写坏的地方。不会改任何东西。'),

    report === null ? null : h('div', { className: 'lc-stack' },
      report.ok === false ? h(Note, { tone: 'warn', icon: 'warning' }, '有几个地方写法不对。不影响你继续用，但会让导出和 AI 读不准。') : null,

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
              h('div', null, i.message)))),
          ),
    ),
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

function apply(ctx) {
  ensureStyle(document)
  const sidebar = ctx.get('betterSidebar')
  if (sidebar === undefined || sidebar === null || typeof sidebar.registerTab !== 'function') {
    // 没有 better-sidebar 就装不上；这不是错误，只是本机没装那个底座。
    console.warn('[lifecard] 需要 dsh-better-sidebar 才能显示；未找到 ctx.betterSidebar。')
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

const inject = ['betterSidebar']



		exports.apply = apply;
		exports.inject = inject;
		exports.LifeCardTab = LifeCardTab;
		return module.exports;
	}
});
