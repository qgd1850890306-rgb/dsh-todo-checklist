/**
 * dsh-todo 客户端源码（esbuild 打包为 lib/client.js 单文件工厂包）。
 *
 * 裸导入仅 react / react-dom（平台静态模块表种子模块），以及构建时内联的 typert.js。
 * Typert 描述符 = 宿主清单全字段展开（网关 validateContribution 必查
 * namespace/invocation/parameters——极简形态会崩，见 v0.3.0 教训）。
 *
 * UI 挂载：sidebar.footer.action（左侧栏常驻面板，cost-meter「花费」同槽位）
 * 与 settings.section（设置详情页）；划词「＋待办」气泡为 document 级监听。
 * v1.2.9 起移除了从未启用的 conversation.input.dock（TodoDock）死代码。
 */
import { Component, createElement as h, Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { TYPERT } from '../typert.js'
import { SegmentDueInput } from './segment-due-input.js'
import {
  EXPORT_FORMATS,
  EXPORT_SCOPES,
  buildExportFile,
  downloadExportFile,
  summarizeExport,
} from './export.js'

//#region Typert 客户端描述符：宿主清单纯展开（全字段�
export const TYPERT_REMOTE = {
  package: 'dsh-todo',
  descriptors: TYPERT.invocations.map((invocation) => ({ ...invocation })),
}
//#endregion

//#region 常量与工具
const REFRESH_ACTIVE_MS = 8_000
const REFRESH_IDLE_MS = 30_000
const REFRESH_AI_MS = 2_500
const AI_POLL_WINDOW_MS = 120_000

const SOURCE_LABEL = {
  selection: '划词',
  chat: '对话',
  model: '对话',
  manual: '手动',
  ai: 'AI',
}

class TodoErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { message: null }
  }

  static getDerivedStateFromError(error) {
    return { message: error instanceof Error ? error.message : String(error) }
  }

  componentDidCatch(error) {
    console.error('[dsh-todo] 全局 UI 出错（已隔离，插件其余功能不受影响）：', error)
  }

  render() {
    if (this.state.message !== null) {
      return h('div', { style: { display: 'none' } }, `dsh-todo global ui error: ${this.state.message}`)
    }
    return this.props.children
  }
}

/**
 * 发布加固：异步调用的统一兜底。
 * 以前散落的 `void xxx()` 一旦 rejection 就静默丢失（用户看到「点了没反应」且控制台无痕），
 * 而 `xxx().catch()` 在宿主未就绪、同步返回 undefined 时反而抛 TypeError 炸掉整棵 UI 树。
 * 本函数同时兜住「同步抛错」与「Promise rejection」，并留下可检索的控制台痕迹。
 */
function quietly(run, label) {
  try {
    const value = typeof run === 'function' ? run() : run
    Promise.resolve(value).catch((error) => {
      console.warn(`[dsh-todo] ${label} 失败：`, error)
    })
  } catch (error) {
    console.warn(`[dsh-todo] ${label} 抛错：`, error)
  }
}

function readFlag(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? fallback : raw === '1'
  } catch {
    return fallback
  }
}

/** 面板排序：待办在前（逾期置顶、有期限次之），已完结沉底 */
function splitItems(items) {
  const pending = []
  const finished = []
  for (const item of items) (item.status === 'pending' ? pending : finished).push(item)
  const dueRank = (item) => {
    if (item.dueAtMs === undefined) return 2
    return item.dueAtMs < Date.now() ? 0 : 1
  }
  pending.sort((a, b) => dueRank(a) - dueRank(b))
  return { pending, finished }
}

// ── v1.2.1 反馈④：SVG 矢量图标（方�?A · Feather 圆角线性，stroke 1.7，currentColor 跟随主题�?──
const ICON_STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }
/** 编辑（铅笔）�?*/
function IconEdit({ size = 15, color }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', style: { color }, ...ICON_STROKE },
    h('path', { d: 'M17 3a2.4 2.4 0 0 1 3.4 3.4L8 18.8 3 21l2.2-5L17 3z' }))
}
/** AI 总结（四角星+小星）�?*/
function IconAi({ size = 15, color }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', style: { color }, ...ICON_STROKE },
    h('path', { d: 'M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9L12 3z' }),
    h('path', { d: 'M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14z' }))
}
/** 删除（X 形）�?*/
function IconX({ size = 15, color }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', style: { color }, ...ICON_STROKE },
    h('path', { d: 'M6 6l12 12M18 6L6 18' }))
}
/** 垃圾桶删除（菜单用）�?*/
function IconTrash({ size = 15, color }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', style: { color }, ...ICON_STROKE },
    h('path', { d: 'M3 6h18' }),
    h('path', { d: 'M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2' }),
    h('path', { d: 'M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6' }),
    h('path', { d: 'M10 11v6M14 11v6' }))
}
/** 新建会话（右上箭头）�?*/
function IconFollowup({ size = 15, color }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', style: { color }, ...ICON_STROKE },
    h('path', { d: 'M7 17L17 7' }),
    h('path', { d: 'M8 7h9v9' }))
}
/** 更多（横排三点）�?*/
function IconMore({ size = 15, color }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', style: { color } },
    h('circle', { cx: 5, cy: 12, r: 1.7, fill: 'currentColor' }),
    h('circle', { cx: 12, cy: 12, r: 1.7, fill: 'currentColor' }),
    h('circle', { cx: 19, cy: 12, r: 1.7, fill: 'currentColor' }))
}
/** v1.2.1 反馈④：待办清单（圆角方�?对勾，语�?清单），侧栏头部用�?*/
function IconList({ size = 15, color }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', style: { color }, ...ICON_STROKE },
    h('rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 4 }),
    h('path', { d: 'M8.5 12.2l2.4 2.4 4.6-5' }))
}
/** v1.2.1 反馈④：展开/收起箭头（右�?chevron，展开时旋�?90°），侧栏头部用�?*/
function IconChevron({ size = 14, color }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', style: { color }, ...ICON_STROKE },
    h('path', { d: 'M9 5l7 7-7 7' }))
}
/** v1.5.0 导出：托盘 + 向下箭头，导出按钮用 */
function IconExport({ size = 15, color }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', style: { color }, ...ICON_STROKE },
    h('path', { d: 'M12 3v12' }),
    h('path', { d: 'M7.5 10.5L12 15l4.5-4.5' }),
    h('path', { d: 'M4 18.5h16' }))
}

/** 快速添加里内联日期（如「发模板 2026-09-30」）�?拆出 dueAt�?*/
function splitInlineDate(text) {
  const match = text.match(/\b(\d{4}-\d{1,2}-\d{1,2})\b/u)
  if (match === null) return { content: text }
  const content = text.replace(match[0], '').replace(/\s{2,}/gu, ' ').trim()
  return content.length === 0 ? { content: text } : { content, dueAt: match[1] }
}

/** 选区是否应忽略（位于输入控件或本插件自身 UI 内）�?*/
function selectionExcluded(selection) {
  const node = selection.anchorNode
  const element = node === null || node === undefined
    ? undefined
    : (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)
  if (element === undefined || element === null) return true
  if (typeof element.closest !== 'function') return true
  if (element.closest('[data-dsh-todo]') !== null) return true
  if (element.closest('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]') !== null) return true
  return false
}

/** 由当前选区计算「＋待办」气泡位置�?*/
function bubbleAnchorFor(range) {
  const rect = range.getBoundingClientRect()
  const left = Math.min(Math.max(8, rect.right - 64), window.innerWidth - 110)
  let top = rect.top - 40
  if (top < 52) top = Math.min(rect.bottom + 10, window.innerHeight - 60)
  return { left, top }
}

// ── v0.9.7 消息级定位：划词时记�?messageId + 文本锚点，跳转后滚动高亮 ──
/** 归一化文本用于匹配：去所有空白差异，压缩为连续字符串�?*/
function normalizeForMatch(text) {
  return String(text ?? '').replace(/\s+/g, '').trim()
}
/** 从选区上溯 DOM，提取所在消息的标识（messageId）与文本锚点�?*/
function captureSelectionLocator(selection) {
  let messageId
  const anchorNode = selection?.anchorNode
  if (anchorNode) {
    let el = anchorNode.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode.parentElement
    let depth = 0
    while (el && depth < 12) {
      // 消息容器常见标识：role=article，或属性名�?message/msg �?data-*
      if (!messageId) {
        for (const attr of Array.from(el.attributes ?? [])) {
          const n = attr.name.toLowerCase()
          if ((n === 'data-message-id' || n === 'data-msg-id' || n === 'data-message-key'
            || (n.startsWith('data-') && n.includes('message'))) && attr.value) {
            messageId = attr.value
          }
        }
      }
      el = el.parentElement
      depth++
    }
  }
  const raw = selection?.toString() ?? ''
  const anchorText = normalizeForMatch(raw).slice(0, 60)
  return { ...(messageId ? { messageId } : {}), anchorText }
}
/** 注入一次性高亮样式（只加一次）�?*/
function ensureHighlightStyle() {
  if (document.getElementById('dsh-todo-highlight-style')) return
  const style = document.createElement('style')
  style.id = 'dsh-todo-highlight-style'
  // v1.1.3 修复①：原动�?100% 落到透明 + 4.2s 后整类移除，深色/消息行自带背景下几乎看不见�
  // 改为"持久双层"——动画结束停在半透明琥珀底，外加左侧橙竖�?+ 常驻描边�
  // 高亮保持到下一次跳转（revealLocator 里移除上一个目标），不再定时消失
  style.textContent = `
  @keyframes dshTodoHighlightPulse { 0%{background-color:rgba(255,170,0,.55)} 55%{background-color:rgba(255,214,0,.28)} 100%{background-color:rgba(255,170,0,.18)} }
  @keyframes dshTodoAiPulse { 0%,100%{opacity:1} 50%{opacity:.45} }
  .dsh-todo-highlight { animation: dshTodoHighlightPulse 1.6s ease-out forwards !important; background-color: rgba(255,170,0,.18) !important; box-shadow: inset 4px 0 0 0 #ff8c00 !important; outline: 2px solid rgba(255,140,0,.85) !important; outline-offset: 2px; border-radius: 4px; }`
  document.head.appendChild(style)
}
let lastHighlightEl = null
/** 在当前会�?DOM 中按 locator 定位、滚动、高亮。返回是否命中�?*/
function revealLocator(locator) {
  if (!locator) return false
  ensureHighlightStyle()
  let target
  // �?�?messageId 属性找
  if (locator.messageId) {
    target = document.querySelector(
      `[data-message-id="${locator.messageId}"],[data-msg-id="${locator.messageId}"],[data-message-key="${locator.messageId}"]`
    )
  }
  // ② 按文本锚点遍历文本节点
  if (!target && locator.anchorText) {
    // v1.2.9 发布加固：优先限定在会话主区域（原先整页 body 遍历；长会话下每 400ms 全文档扫描）。
    const scope = document.querySelector('[data-conversation-scroll], [data-session-messages], main[role="main"], main') ?? document.body
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const p = node.parentElement
        if (!p) return NodeFilter.FILTER_REJECT
        if (p.closest('[data-dsh-todo],script,style')) return NodeFilter.FILTER_REJECT
        return normalizeForMatch(node.textContent).includes(locator.anchorText)
          ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
      },
    })
    const found = walker.nextNode()
    if (found) {
      // 上溯到最近的块级消息元素
      let el = found.parentElement
      for (let i = 0; i < 6 && el; i++) {
        const display = window.getComputedStyle(el).display
        if (display.startsWith('block') || display === 'flex' || el.getAttribute('role') === 'article') { target = el; break }
        el = el.parentElement
      }
      // v1.1.3 修复①：兜底直接高亮文本节点父元素（以前命中也不明显）
      target = target ?? found.parentElement
    }
  }
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'center' })
    // v1.1.3 修复①：清掉上一次的高亮，保�?全场只有当前跳转目标"高亮
    if (lastHighlightEl && lastHighlightEl !== target) lastHighlightEl.classList.remove('dsh-todo-highlight')
    lastHighlightEl = target
    target.classList.remove('dsh-todo-highlight')
    void target.offsetWidth // 重启动画
    target.classList.add('dsh-todo-highlight')
    return true
  }
  return false
}
/** 会话切换后内容是异步渲染的，轮询等待并尝试定位，直到超时。
 *  v1.2.9 发布加固：可取消——同一时刻只保留最近一次跳转的轮询（旧轮询下一次循环即退出），
 *  标签页隐藏期间不空转（看不到高亮，且全文档扫描无意义）。 */
let revealToken = 0
async function waitAndReveal(locator, { timeoutMs = 12_000, intervalMs = 400 } = {}) {
  const token = ++revealToken
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (token !== revealToken) return false
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
      if (revealLocator(locator)) return true
    }
    await new Promise((r) => window.setTimeout(r, intervalMs))
  }
  return false
}

function isOverdue(item) {
  return item.status === 'pending' && item.dueAtMs !== undefined && item.dueAtMs < Date.now()
}

/** v1.1 今天应处理：到期时间在今天结束前（含逾期与今天到期）�?*/
function isDueToday(item) {
  if (item.status !== 'pending' || item.dueAtMs === undefined) return false
  const now = new Date()
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime()
  return item.dueAtMs <= endOfToday
}

/** v0.9.0 格式化提醒时间：今天=H:MM�?4小时制），非今天=M/D�?*/
function formatDueTime(iso) {
  if (iso === undefined || iso === null) return null
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  const d = new Date(ms)
  const now = new Date()
  const isToday = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  if (isToday) {
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** datetime-local �?�?ISO；空串返�?undefined�?*/
function localInputToIso(value) {
  const text = String(value ?? '').trim()
  if (text.length === 0) return undefined
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}
//#endregion

//#region 样式（官方主题语�?token，随明暗主题自适应�
const style = {
  chipRow: {
    display: 'flex',
    justifyContent: 'flex-start',
    padding: '0 12px',
    pointerEvents: 'none',
  },
  chip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 11px',
    fontSize: 12,
    lineHeight: 1,
    borderRadius: 999,
    cursor: 'pointer',
    pointerEvents: 'auto',
    background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-secondary)',
    border: '1px solid var(--dsw-alias-border-l2)',
  },
  greenDot: {
    width: 7,
    height: 7,
    borderRadius: 999,
    background: 'var(--dsw-alias-state-success-primary)',
  },
  // v1.1.3 修复③：AI 总结在途徽标（dock chip 与侧栏头部共用）�
  // 脉动动画 dshTodoAiPulse �?@keyframes �?ensureHighlightStyle 统一注入 <head>�
  aiPendingBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 11,
    whiteSpace: 'nowrap',
    padding: '2px 8px',
    borderRadius: 999,
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 14%, transparent)',
    color: 'var(--dsw-alias-state-success-primary, #22c55e)',
    animation: 'dshTodoAiPulse 1.4s ease-in-out infinite',
  },
  // v1.5.0：侧栏头部 AI 整理中指示灯（替代文字徽标，避免 254px 侧栏挤掉标题）
  aiPendingDot: {
    flexShrink: 0,
    width: 7,
    height: 7,
    borderRadius: 999,
    background: 'var(--dsw-alias-state-success-primary, #22c55e)',
    animation: 'dshTodoAiPulse 1.4s ease-in-out infinite',
  },
  chipBadge: {
    minWidth: 14,
    padding: '2px 5px',
    borderRadius: 999,
    fontSize: 11,
    textAlign: 'center',
    background: 'var(--dsw-alias-brand-primary)',
    color: 'var(--dsw-alias-label-primary-inverted)',
  },
  chipOverdue: {
    fontSize: 11,
    color: 'var(--dsw-alias-state-error-primary)',
  },
  panel: {
    pointerEvents: 'auto',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 12,
    boxShadow: '0 8px 28px rgba(0, 0, 0, 0.18)',
    margin: '0 12px 6px',
    padding: 10,
    maxHeight: '42vh',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 8,
    padding: '2px 4px 8px',
  },
  headerTitle: {
    fontSize: 13,
    fontWeight: 600,
  },
  headerCaption: {
    flex: 1,
    fontSize: 11,
    color: 'var(--dsw-alias-label-tertiary)',
  },
  iconButton: {
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: 14,
    lineHeight: 1,
    padding: '2px 6px',
    borderRadius: 6,
    cursor: 'pointer',
  },
  list: {
    flex: 1,
    minHeight: 40,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    padding: '2px 0',
  },
  item: {
    display: 'flex',
    alignItems: 'flex-start',
    flexWrap: 'wrap',
    gap: 8,
    padding: '6px 8px',
    borderRadius: 8,
    background: 'var(--dsw-alias-bg-layer-2)',
  },
  itemOverdue: {
    display: 'flex',
    alignItems: 'flex-start',
    flexWrap: 'wrap',
    gap: 8,
    padding: '6px 8px',
    borderRadius: 8,
    background: 'var(--dsw-alias-bg-layer-2)',
    border: '1px solid var(--dsw-alias-state-error-primary)',
  },
  checkbox: {
    margin: 0,
    marginTop: 2,
    cursor: 'pointer',
    accentColor: 'var(--dsw-alias-brand-primary)',
    width: 16,
    height: 16,
    colorScheme: 'light dark',
  },
  contentWrap: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontSize: 13,
    lineHeight: 1.4,
    wordBreak: 'break-word',
  },
  titleDone: {
    fontSize: 13,
    lineHeight: 1.4,
    wordBreak: 'break-word',
    textDecoration: 'line-through',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  metaRow: {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
    marginTop: 2,
    flexWrap: 'wrap',
  },
  tag: {
    fontSize: 10,
    lineHeight: '14px',
    color: 'var(--dsw-alias-label-tertiary)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 999,
    padding: '1px 6px',
  },
  tagDue: {
    fontSize: 10,
    lineHeight: '14px',
    color: 'var(--dsw-alias-label-secondary)',
    border: '1px solid var(--dsw-alias-border-l3)',
    borderRadius: 999,
    padding: '1px 6px',
  },
  tagOverdue: {
    fontSize: 10,
    lineHeight: '14px',
    color: 'var(--dsw-alias-state-error-primary)',
    border: '1px solid var(--dsw-alias-state-error-primary)',
    borderRadius: 999,
    padding: '1px 6px',
  },
  menuWrap: {
    position: 'relative',
    flexShrink: 0,
  },
  menuPop: {
    minWidth: 170,
    maxHeight: 260,
    overflowY: 'auto',
    background: 'var(--dsw-alias-bg-layer-1)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 10,
    boxShadow: '0 8px 24px rgba(0, 0, 0, 0.22)',
    padding: 4,
    display: 'flex',
    flexDirection: 'column',
  },
  menuItem: {
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-primary)',
    fontSize: 12,
    textAlign: 'left',
    padding: '7px 10px',
    borderRadius: 6,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  inlineForm: {
    display: 'flex',
    gap: 6,
    padding: '6px 4px',
    alignItems: 'center',
    flexWrap: 'wrap',
    flexBasis: '100%',
    width: '100%',
  },
  inlineInput: {
    flex: 1,
    minWidth: 120,
    background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 8,
    padding: '5px 8px',
    fontSize: 12,
    outline: 'none',
  },
  miniButton: {
    border: 'none',
    borderRadius: 8,
    padding: '5px 10px',
    fontSize: 11,
    cursor: 'pointer',
    background: 'var(--dsw-alias-button-primary-fill)',
    color: 'var(--dsw-alias-label-primary-inverted)',
  },
  doneToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: 11,
    cursor: 'pointer',
    padding: '6px 4px 2px',
    textAlign: 'left',
  },
  footer: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 4px 0',
    borderTop: '1px solid var(--dsw-alias-border-l2)',
    marginTop: 6,
  },
  hint: {
    flex: 1,
    fontSize: 10.5,
    color: 'var(--dsw-alias-label-tertiary)',
    lineHeight: 1.4,
  },
  linkButton: {
    border: 'none',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: 11,
    cursor: 'pointer',
    padding: 0,
    textDecoration: 'underline',
    textUnderlineOffset: 2,
  },
  notice: {
    fontSize: 11.5,
    color: 'var(--dsw-alias-state-error-primary)',
    padding: '4px 4px 8px',
  },
  empty: {
    fontSize: 12,
    color: 'var(--dsw-alias-label-tertiary)',
    textAlign: 'center',
    padding: '14px 0',
  },
  bubble: {
    position: 'fixed',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    padding: '5px 11px',
    fontSize: 12,
    lineHeight: 1,
    borderRadius: 8,
    cursor: 'pointer',
    border: 'none',
    background: 'var(--dsw-alias-brand-primary)',
    color: 'var(--dsw-alias-label-primary-inverted)',
    boxShadow: '0 6px 18px rgba(0, 0, 0, 0.22)',
  },
  toast: {
    position: 'fixed',
    left: '50%',
    bottom: 28,
    transform: 'translateX(-50%)',
    padding: '8px 14px',
    fontSize: 12,
    borderRadius: 999,
    background: 'var(--dsw-alias-bg-layer-3)',
    color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l2)',
    boxShadow: '0 6px 18px rgba(0, 0, 0, 0.18)',
    zIndex: 120,
  },
  popupMask: {
    position: 'fixed',
    inset: 0,
    zIndex: 110,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'var(--dsw-alias-bg-mask-1)',
    pointerEvents: 'auto',
  },
  popup: {
    width: 420,
    maxWidth: '92vw',
    maxHeight: '70vh',
    overflowY: 'auto',
    background: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 12,
    boxShadow: '0 12px 36px rgba(0, 0, 0, 0.28)',
    padding: 14,
  },
  aiButton: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    border: 'none',
    borderRadius: 10,
    padding: '10px 12px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    background: 'var(--dsw-alias-brand-primary)',
    color: 'var(--dsw-alias-label-primary-inverted)',
  },
  divider: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    margin: '12px 0 10px',
    fontSize: 10.5,
    color: 'var(--dsw-alias-label-tertiary)',
  },
  dividerLine: {
    flex: 1,
    height: 1,
    background: 'var(--dsw-alias-border-l2)',
  },
  fieldLabel: {
    fontSize: 11,
    color: 'var(--dsw-alias-label-secondary)',
    margin: '8px 0 4px',
  },
  textarea: {
    width: '100%',
    boxSizing: 'border-box',
    minHeight: 84,
    resize: 'vertical',
    background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 8,
    padding: '7px 9px',
    fontSize: 13,
    outline: 'none',
    fontFamily: 'inherit',
  },
  input: {
    width: '100%',
    boxSizing: 'border-box',
    background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-primary)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 8,
    padding: '7px 9px',
    fontSize: 13,
    outline: 'none',
  },
  quickRow: {
    display: 'flex',
    gap: 6,
    marginTop: 6,
    flexWrap: 'wrap',
  },
  quickChip: {
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-2)',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: 11,
    borderRadius: 999,
    padding: '3px 9px',
    cursor: 'pointer',
  },
  popupButtons: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 14,
  },
  ghostButton: {
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'transparent',
    color: 'var(--dsw-alias-label-secondary)',
    fontSize: 12,
    borderRadius: 8,
    padding: '7px 14px',
    cursor: 'pointer',
  },
  // v0.6 左侧侧栏常驻面板（参�?cost-meter 样式：左侧三角箭�?+ 展开动效�
sidebarWrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    width: '100%',
    // v1.2.1 反馈②：向左对齐官方侧栏行（移动访问/定时任务 的 regionArea，官方规范 margin-left:-4px）
    marginLeft: -4,
    fontFamily: 'inherit',
    color: 'var(--dsw-alias-label-primary)',
  },
  sidebarCard: {
    background: 'var(--dsw-alias-bg-layer-2)',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 8,
    overflow: 'hidden',
  },
  // v1.2.1 反馈④：侧栏头部图标（与官方 panelRow �?panelGlyph 对齐�?6px 线性图标，主题色）
  sidebarHeadIcon: {
    flexShrink: 0,
    width: 16,
    display: 'inline-flex',
    justifyContent: 'center',
    alignItems: 'center',
    color: 'var(--dsw-alias-brand-primary, #f59e0b)',
  },
  sidebarHead: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    cursor: 'pointer',
    userSelect: 'none',
    padding: '6px 8px',
    overflow: 'hidden',
  },
  // v1.2.1 反馈④：头部展开箭头�?4px SVG，替�?26px 文字箭头，行高更紧凑对齐官方 panelRow�
sidebarChevron: {
    flexShrink: 0,
    display: 'inline-flex',
    justifyContent: 'center',
    alignItems: 'center',
    color: 'var(--dsw-alias-label-secondary)',
    transition: 'transform 0.2s ease',
  },
  // v1.2.1 反馈④：旧文字箭头样式已废弃（改�?sidebarChevron + IconChevron SVG�
sidebarArrow: {
    fontSize: 26,
    color: 'var(--dsw-alias-brand-primary, #f59e0b)',
    flexShrink: 0,
    width: 28,
    textAlign: 'center',
    transition: 'transform 0.2s ease',
    fontWeight: 700,
    lineHeight: 1,
  },
  // v1.5.0 修复：头部一行放不下时标题会被挤成竖排（中文逐字换行）。
  // whiteSpace:nowrap 保证永不断行，空间不足时退化为省略号；徽标一律不收缩。
  sidebarTitle: {
    fontSize: 12,
    fontWeight: 600,
    flex: '1 1 auto',
    minWidth: 0,
    textAlign: 'left',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  sidebarBadge: {
    fontSize: 10.5,
    color: 'var(--dsw-alias-label-secondary)',
    fontVariantNumeric: 'tabular-nums',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  sidebarContent: {
    overflow: 'hidden',
    transition: 'max-height 0.25s ease, opacity 0.2s ease',
    padding: '0 8px 8px 8px',
  },
  sidebarList: { display: 'flex', flexDirection: 'column', gap: 4 },
  sidebarRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 6,
    fontSize: 12,
    lineHeight: 1.35,
  },
  sidebarTitleText: { flex: 1, minWidth: 0, overflowWrap: 'anywhere' },
  sidebarDoneRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 11,
    color: 'var(--dsw-alias-label-secondary)',
    cursor: 'pointer',
    userSelect: 'none',
    borderTop: '1px dashed var(--dsw-alias-border-l2)',
    paddingTop: 6,
    marginTop: 2,
  },
  sidebarEmpty: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', padding: '4px 0' },
}
//#endregion

//#region v1.1 统一品牌复选框（未选中边框=主题色，选中填充=主题色）
function BrandCheckbox({ checked, onChange, title, disabled }) {
  return h('span', {
    title,
    onClick: (e) => { e.stopPropagation(); if (!disabled) onChange?.() },
    style: {
      width: 16, height: 16, borderRadius: 4, flexShrink: 0,
      border: '1px solid var(--dsw-alias-brand-primary, #f59e0b)',
      background: checked ? 'var(--dsw-alias-brand-primary, #f59e0b)' : 'var(--dsw-alias-bg-layer-1, #fff)',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      color: '#fff', fontSize: 11, cursor: disabled ? 'default' : 'pointer',
      lineHeight: 1, marginTop: 2, boxSizing: 'border-box',
    },
  }, checked ? '\u2713' : '')
}
//#endregion

//#region 待办行（勾选完�?+ �?菜单：处�?延期/放弃/删除�
function TodoRow({ item, onAction, onFollowup, onEdit, showToast }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })
  const overdue = isOverdue(item)
  const menuRef = useRef(null)
  const buttonRef = useRef(null)

  // v0.9.2：点击⋯按钮时计算位置，菜单�?position:fixed 避免�?overflow 裁剪
  const toggleMenu = useCallback(() => {
    setMenuOpen((prev) => {
      if (!prev && buttonRef.current !== null) {
        const rect = buttonRef.current.getBoundingClientRect()
        setMenuPos({ top: rect.bottom + 4, left: rect.right })
      }
      return !prev
    })
  }, [])

  // v0.9.1：点击菜单外部自动关�
  // v1.2.1 修复②：①mousedown 先排�?�?按钮本体（否则按�?mousedown 先关菜单�
  //   click �?toggle 又打开——表现为"点按钮收不起�?）；②菜�?div 不再重复�
  //   menuRef（React 后挂载者覆盖，menuRef.current 变成菜单 div 导致按钮被判外部）�
  //   菜单 DOM 上是外层 menuWrap 的子节点，外�?contains 天然覆盖菜单与按钮�
  useEffect(() => {
    if (!menuOpen) return
    const handler = (event) => {
      if (buttonRef.current !== null && buttonRef.current.contains(event.target)) return
      if (menuRef.current !== null && !menuRef.current.contains(event.target)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const act = (action) => {
    setMenuOpen(false)
    onAction(action)
  }

  return h('div', { style: overdue ? style.itemOverdue : style.item },
    h(BrandCheckbox, {
      checked: false,
      title: '完成待办',
      onChange: () => act({ kind: 'complete', id: item.id }),
    }),
    h('div', { style: style.contentWrap },
      h('div', {
        style: { ...style.title, cursor: item.sessionId ? 'pointer' : 'default' },
        title: item.sessionId ? '单击跳转到来源会话 / 双击新建会话' : (item.content ?? item.title),
        onClick: () => {
          if (item.sessionId) {
            act({
              kind: 'process', id: item.id, sessionId: item.sessionId,
              ...(item.messageId ? { messageId: item.messageId } : {}),
              ...(item.anchorText ? { anchorText: item.anchorText } : {}),
            })
          }
        },
        // v1.2.1 反馈②：双击标题=直接新建会话（同 �?图标；单击跳转保持不变，
        // 双击前先触发的一两次单击跳转幂等无害，最终停在新会话�
        onDoubleClick: () => {
          if (typeof onFollowup === 'function') onFollowup(item)
        },
      }, item.title),
    ),
    item.dueAt === undefined ? null : h('span', {
      style: {
        fontSize: 11,
        color: overdue ? 'var(--dsw-alias-danger, #e74c3c)' : 'var(--dsw-alias-label-secondary)',
        fontVariantNumeric: 'tabular-nums',
        marginRight: 4,
        whiteSpace: 'nowrap',
      },
      title: item.dueAt,
    }, overdue ? `逾期 ${formatDueTime(item.dueAt)}` : formatDueTime(item.dueAt)),
    // v1.1.7 反馈：左侧简化——只保留 �?菜单（编辑代�?删除），其余图标全部收进菜单
    h('div', { style: style.menuWrap, ref: menuRef },
      h('button', {
        type: 'button',
        style: style.iconButton,
        title: '更多操作',
        ref: buttonRef,
        onClick: toggleMenu,
      }, h(IconMore, { size: 15 })),
      menuOpen ? h('div', {
        style: {
          ...style.menuPop,
          position: 'fixed',
          top: menuPos.top,
          left: menuPos.left - 170,
          zIndex: 2147483000,
        },
      },
        onEdit ? h('button', {
          type: 'button',
          style: style.menuItem,
          onClick: () => { setMenuOpen(false); onEdit(item) },
        }, h(IconEdit, { size: 13 }), ' 编辑待办') : null,
        onFollowup ? h('button', {
          type: 'button',
          style: style.menuItem,
          onClick: () => { setMenuOpen(false); onFollowup(item) },
        }, h(IconFollowup, { size: 13 }), ' 新建会话') : null,
        h('button', {
          type: 'button',
          style: style.menuItem,
          onClick: () => act({ kind: 'delete', id: item.id }),
        }, h(IconTrash, { size: 13, color: 'var(--dsw-alias-danger, #e74c3c)' }), ' 删除'),
      ) : null,
    ),
  )
}
//#endregion

//#region 划词弹窗（AI 记录待办 + 手动表单�
function TodoPopup({ text, sessionId, locator, todosApi, onClose, onAdded, showToast }) {
  const [aiBusy, setAiBusy] = useState(false)
  const [title, setTitle] = useState('')
  const [content, setContent] = useState(text)
  const [dueLocal, setDueLocal] = useState('')
  const [recurMode, setRecurMode] = useState('once') // once | daily | weekly
  const [recurWeekdays, setRecurWeekdays] = useState([1, 2, 3, 4, 5]) // 0=日, 1=一, ... 6=六
  const [recurHour, setRecurHour] = useState(9)
  const [recurMinute, setRecurMinute] = useState(0)
  // v1.1.6 反馈⑦：通知方式（默认同设置详情=全局配置；未�?跟随全局�
  const [popupNotify, setPopupNotify] = useState(null) // null=未选择（跟随全局）
  const [imNotify, setImNotify] = useState(null) // null=未选择（跟随全局）
  // v1.2.1 反馈③：勾机器人后可选具体机器人/目标（同编辑弹窗形态）
  const [imBots, setImBots] = useState([])
  const [imBotId, setImBotId] = useState('')
  const [imTargetId, setImTargetId] = useState('')
  useEffect(() => {
    void (async () => {
      try {
        const r = await todosApi.list({})
        const notify = r.ok ? r.value?.notify : undefined
        if (notify?.popup !== undefined) setPopupNotify(notify.popup === true)
        if (notify?.im !== undefined) {
          setImNotify(notify.im === true)
          // 全局已选过具体机器人时回显
          if (typeof notify.imBotId === 'string' && notify.imBotId.length > 0) setImBotId(notify.imBotId)
          if (typeof notify.imTargetId === 'string' && notify.imTargetId.length > 0) setImTargetId(notify.imTargetId)
        }
      } catch { }
      // 拉机器人清单（勾选机器人后展示下拉）
      try {
        const rb = await todosApi.listImBots({})
        if (rb.ok) setImBots(Array.isArray(rb.value?.bots) ? rb.value.bots : [])
      } catch { }
    })()
  }, [todosApi])  // v1.3.0 反馈①：分段式提醒时间输入接管 ± 步进（dueField/stepDue/inferDueFieldByDiff 退役，逻辑移入 SegmentDueInput）
  const dueLocalRef = useRef(dueLocal)
  // 任何路径改了 dueLocal（快捷胶囊、分段输入等）都同步基准 ref
  useEffect(() => { dueLocalRef.current = dueLocal }, [dueLocal])

  const quickDue = useCallback((offsetHours) => {
    const d = new Date(Date.now() + offsetHours * 3_600_000)
    const pad = (v) => String(v).padStart(2, '0')
    setDueLocal(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`)
  }, [])

  const quickDueTomorrow = useCallback((hour, minute) => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    d.setHours(hour, minute, 0, 0)
    const pad = (v) => String(v).padStart(2, '0')
    setDueLocal(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`)
  }, [])

  const aiCapture = useCallback(() => {
    if (aiBusy) return
    setAiBusy(true)
    void (async () => {
      const result = await todosApi.aiCapture({
        text: text.slice(0, 4000),
        ...(sessionId === undefined || sessionId === null ? {} : { sessionId }),
        ...(locator?.messageId ? { messageId: locator.messageId } : {}),
        ...(locator?.anchorText ? { anchorText: locator.anchorText } : {}),
      })
      if (result.ok) {
        // v1.2.1 反馈①：AI 记录发起成功后自动关闭弹窗（面板绿点/「AI 整理中」徽标接管后续反馈）
        showToast('AI 总结中…完成后自动入列（面板提示）')
        onAdded({ aiStarted: true })
        onClose()
      } else {
        showToast(`AI 记录失败：${result.error ?? '未知错误'}`)
        setAiBusy(false)
      }
    })()
  }, [aiBusy, sessionId, locator, text, todosApi, showToast, onAdded, onClose])

  const save = useCallback(() => {
    const cleanTitle = title.trim()
    const cleanContent = content.trim()
    // v1.1 标题留空：由内容自动总结；标题和内容都空才拦�
    if (cleanTitle.length === 0 && cleanContent.length === 0) { showToast('请填写标题或内容'); return }
    // v1.0 计算提醒：单�?dueAt / 每天·每周 recurrence
    let schedule = {}
    if (recurMode === 'daily') {
      schedule = { recurrence: { type: 'daily', hour: recurHour, minute: recurMinute } }
    } else if (recurMode === 'weekly') {
      if (recurWeekdays.length === 0) { showToast('请选择星期'); return }
      schedule = { recurrence: { type: 'weekly', hour: recurHour, minute: recurMinute, weekdays: [...recurWeekdays].sort((a, b) => a - b) } }
    } else {
      const iso = localInputToIso(dueLocal)
      if (iso !== undefined) schedule = { dueAt: iso }
    }
    void (async () => {
      const result = await todosApi.add({
        ...(cleanTitle.length > 0 ? { title: cleanTitle } : {}),
        ...(cleanContent.length > 0 ? { content: cleanContent } : {}),
        ...schedule,
        // v1.1.6 反馈⑦：未选（null）则不传，跟随设置详情（全局默认）
        ...(popupNotify === null ? {} : { notifyPopup: popupNotify }),
        ...(imNotify === null ? {} : { notifyIm: imNotify }),
        // v1.2.1 反馈③：弹窗内选定的机器人/目标（空�?跟随全局，不传）
        ...(imNotify === true && imBotId.length > 0 ? { imBotId } : {}),
        ...(imNotify === true && imTargetId.length > 0 ? { imTargetId } : {}),
        ...(imNotify === true && imBotId.length > 0 && (imBots.find((bot) => bot.botId === imBotId)?.service) ? { imService: imBots.find((bot) => bot.botId === imBotId).service } : {}),
        ...(sessionId === undefined || sessionId === null ? {} : { sessionId }),
        ...(locator?.messageId ? { messageId: locator.messageId } : {}),
        ...(locator?.anchorText ? { anchorText: locator.anchorText } : {}),
      })
      if (result.ok) {
        showToast('已加入待办')

        onAdded({ aiStarted: false })
        onClose()
      } else {
        showToast(`保存失败: ${result.error ?? '未知错误'}`)
      }
    })()
  }, [title, content, dueLocal, recurMode, recurWeekdays, recurHour, recurMinute, popupNotify, imNotify, imBotId, imTargetId, sessionId, locator, todosApi, showToast, onAdded, onClose])

  return h('div', {
    style: style.popupMask,
    onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
  },
  h('div', { style: style.popup },
    h('button', {
      type: 'button',
      style: { ...style.aiButton, opacity: aiBusy ? 0.7 : 1 },
      disabled: aiBusy,
      onClick: aiCapture,
    },
    h(IconAi, { size: 15 }),
    h('span', null, aiBusy ? 'AI 总结中…' : 'AI 记录待办')),
    h('div', { style: style.divider }, h('div', { style: style.dividerLine }), '或手动填写', h('div', { style: style.dividerLine })),
    h('div', { style: style.fieldLabel }, '标题'),
    h('input', {
      style: style.input,
      value: title,
      placeholder: '标题（留空则从内容自动总结）',
      onChange: (event) => setTitle(event.target.value),
      onKeyDown: (event) => { if (event.key === 'Enter') save() },
    }),
    h('div', { style: style.fieldLabel }, '内容'),
    h('textarea', {
      style: style.textarea,
      value: content,
      placeholder: '待办内容详情（默认预填划词原文）',
      onChange: (event) => setContent(event.target.value),
    }),
    h('div', { style: style.fieldLabel }, '提醒时间'),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 } },
      [
      { label: '1小时后', action: () => quickDue(1) },
        { label: '明天9:00', action: () => quickDueTomorrow(9, 0) },
        { label: '明天17:00', action: () => quickDueTomorrow(17, 0) },
      { label: '工作日 9:00', action: () => { setRecurMode('weekly'); setRecurWeekdays([1,2,3,4,5]); setRecurHour(9); setRecurMinute(0) } },
        { label: '下周一9:00', action: () => { setRecurMode('weekly'); setRecurWeekdays([1]); setRecurHour(9); setRecurMinute(0) } },
      ].map((preset, i) => h('button', {
        type: 'button', key: i, onClick: preset.action,
        style: {
          padding: '4px 10px', fontSize: 12, borderRadius: 999, cursor: 'pointer',
          border: '1px solid var(--dsw-alias-border-l2)',
          background: 'var(--dsw-alias-bg-layer-1)',
          color: 'var(--dsw-alias-label-secondary)',
        },
      }, preset.label)),
    ),
    h('div', { style: { display: 'inline-flex', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, overflow: 'hidden', marginBottom: 10 } },
      [
        { key: 'once', label: '单次' },
        { key: 'daily', label: '每天' },
        { key: 'weekly', label: '每周' },
      ].map((tab) => h('button', {
        type: 'button', key: tab.key, onClick: () => setRecurMode(tab.key),
        style: {
          padding: '6px 14px', fontSize: 12, fontWeight: recurMode === tab.key ? 600 : 400,
          border: 'none', cursor: 'pointer',
          background: recurMode === tab.key ? 'var(--dsw-alias-label-primary)' : 'transparent',
          color: recurMode === tab.key ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-secondary)',
        },
      }, tab.label)),
    ),
    // 单次模式：分段式日期时间选择（v1.3.0 反馈①：点哪段 + 就加哪段；原生 datetime-local 的
    // closed shadow root 无法感知聚焦分段，故换自绘分段组件，行为规格见 segment-due-input.js）
    recurMode === 'once' ? h('div', { style: { marginBottom: 10 } },
      h(SegmentDueInput, {
        value: dueLocal,
        onChange: (next) => { dueLocalRef.current = next; setDueLocal(next) },
        inputStyle: { fontSize: 13, padding: '8px 10px' },
      }),
    ) : null,
    (recurMode === 'daily' || recurMode === 'weekly') ? h('div', { style: { display: 'flex', gap: 6, alignItems: 'center', marginBottom: 10 } },
      h('select', {
        value: recurHour, onChange: (e) => setRecurHour(Number(e.target.value)),
        style: { padding: '6px 8px', fontSize: 13, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
      }, Array.from({ length: 24 }, (_, i) => h('option', { key: i, value: i }, String(i).padStart(2, '0')))),
      h('span', { style: { fontSize: 14, color: 'var(--dsw-alias-label-secondary)' } }, ':'),
      h('select', {
        value: recurMinute, onChange: (e) => setRecurMinute(Number(e.target.value)),
        style: { padding: '6px 8px', fontSize: 13, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)' },
      }, Array.from({ length: 60 }, (_, i) => h('option', { key: i, value: i }, String(i).padStart(2, '0')))),
    ) : null,
    recurMode === 'weekly' ? h('div', { style: { display: 'flex', gap: 4, marginBottom: 10 } },
      ['一', '二', '三', '四', '五', '六', '日'].map((label, idx) => {
        const day = idx === 6 ? 0 : idx + 1 // 一=1,...六=6,日=0
        const selected = recurWeekdays.includes(day)
        return h('button', {
          type: 'button', key: day,
          onClick: () => setRecurWeekdays((prev) => selected ? prev.filter((d) => d !== day) : [...prev, day]),
          style: {
            minWidth: 30, height: 28, padding: '0 6px', fontSize: 12, fontWeight: selected ? 600 : 400,
            borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', cursor: 'pointer',
            background: selected ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-bg-layer-1)',
            color: selected ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-secondary)',
          },
        }, label)
      }),
    ) : null,
    // v1.1.6 反馈⑦：通知方式（用户图7红框位置——按钮行左侧）；默认同设置详情，未选则跟随全局
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 } },
      h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, '通知方式'),
      h('label', {
        style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', color: 'var(--dsw-alias-label-primary)' },
        onClick: (e) => { e.preventDefault(); setPopupNotify((v) => v === null ? false : !v) },
      },
        h('span', {
          style: {
            width: 13, height: 13, borderRadius: 3, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 9, color: '#fff',
            border: '1px solid var(--dsw-alias-brand-primary, #f59e0b)',
            background: (popupNotify ?? true) ? 'var(--dsw-alias-brand-primary, #f59e0b)' : 'transparent',
          },
        }, (popupNotify ?? true) ? '\u2713' : ''),
        '弹窗',
      ),
      h('label', {
        style: { display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', color: 'var(--dsw-alias-label-primary)' },
        onClick: (e) => { e.preventDefault(); setImNotify((v) => v === null ? false : !v) },
      },
        h('span', {
          style: {
            width: 13, height: 13, borderRadius: 3, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 9, color: '#fff',
            border: '1px solid var(--dsw-alias-brand-primary, #f59e0b)',
            background: (imNotify ?? false) ? 'var(--dsw-alias-brand-primary, #f59e0b)' : 'transparent',
          },
        }, (imNotify ?? false) ? '\u2713' : ''),
        '机器人推送',
      ),
      popupNotify === null && imNotify === null ? h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' } }, '（默认同设置详情）') : null,
    ),
    imNotify === true ? h('div', { style: { display: 'flex', gap: 6, marginBottom: 10 } },
      h('select', {
        value: imBotId,
        onChange: (e) => { setImBotId(e.target.value); setImTargetId('') },
        style: { flex: 1, minWidth: 0, padding: '6px 8px', fontSize: 12, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', boxSizing: 'border-box' },
      },
      h('option', { value: '' }, '全部机器人（跟随全局）'),
        imBots.map((bot) => h('option', { key: bot.botId, value: bot.botId }, imBotLabel(bot))),
      ),
      h('select', {
        value: imTargetId,
        onChange: (e) => setImTargetId(e.target.value),
        style: { flex: 1, minWidth: 0, padding: '6px 8px', fontSize: 12, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', boxSizing: 'border-box' },
      },
        h('option', { value: '' }, '默认目标（第一个）'),
        (imBots.find((bot) => bot.botId === imBotId)?.targets ?? []).map((t) => h('option', { key: t.targetId, value: t.targetId }, t.name ? `${t.name} · ${t.targetId}` : t.targetId)),
      ),
    ) : null,
    h('div', { style: style.popupButtons },
      h('button', { type: 'button', style: style.ghostButton, onClick: onClose }, '取消'),
      h('button', { type: 'button', style: style.miniButton, onClick: save }, '保存待办'),
    ),
  ),
  )
}
//#endregion


//#region v0.7.0 全局划词气泡组件（独立于槽位，插件入口直接挂载到 body�
function GlobalSelectionBubble({ todosApi, getCurrentSessionId }) {
  const [bubble, setBubble] = useState(null)
  const [popup, setPopup] = useState(null)
  const [toast, setToast] = useState(null)
  const aliveRef = useRef(true)
  const toastTimerRef = useRef(undefined)

  // v1.2.8 修复①：提示一律只渲染纯文本。此前「双击 / ↗ 新建会话」传的是 { text, ms } 对象，
  // 直接 setToast(对象) 会让 React 渲染对象子节点并抛错，该槽位条目随之被移除
  // ——用户看到的现象就是「双击之后左侧待办清单面板整个消失」。
  // 这里统一归一化：对象取 .text、时长取 .ms（默认 2200ms）；字符串原样、维持 2200ms。
  const showToast = useCallback((message) => {
    const isObject = message !== null && typeof message === 'object'
    const text = isObject ? String(message.text ?? '') : String(message ?? '')
    const ms = isObject && Number.isFinite(message.ms) ? message.ms : 2_200
    setToast(text)
    if (toastTimerRef.current !== undefined) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => {
      if (aliveRef.current) setToast(null)
    }, ms)
  }, [])

  useEffect(() => {
    aliveRef.current = true
    console.log('[dsh-todo] GlobalSelectionBubble mounted, registering selection listeners')
    const evaluate = () => {
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
        setBubble(null)
        return
      }
      const text = selection.toString().replace(/\s+/u, ' ').trim()
      console.log('[dsh-todo] selection text:', text.length, 'chars, excluded:', selectionExcluded(selection))
      if (text.length < 2 || text.length > 4000 || selectionExcluded(selection)) {
        setBubble(null)
        return
      }
      try {
        const anchor = bubbleAnchorFor(selection.getRangeAt(0))
        const locator = captureSelectionLocator(selection)
        console.log('[dsh-todo] bubble anchor:', anchor, 'locator:', locator)
        setBubble({ ...anchor, text, locator })
      } catch (e) {
        console.error('[dsh-todo] bubble anchor error:', e)
        setBubble(null)
      }
    }
    const dismiss = () => {
      const selection = window.getSelection()
      if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
        setBubble(null)
      }
    }
    document.addEventListener('pointerup', evaluate)
    document.addEventListener('selectionchange', dismiss)
    document.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      aliveRef.current = false
      document.removeEventListener('pointerup', evaluate)
      document.removeEventListener('selectionchange', dismiss)
      document.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      if (toastTimerRef.current !== undefined) window.clearTimeout(toastTimerRef.current)
      console.log('[dsh-todo] GlobalSelectionBubble unmounted')
    }
  }, [])

  const openPopupFromBubble = useCallback(() => {
    const text = bubble?.text
    if (text === undefined || text === null) return
    // v0.9.7 捕获当前会话 ID，作为待办来源（标题跳转的前提）
    const sessionId = (typeof getCurrentSessionId === 'function' ? getCurrentSessionId() : undefined)
    const locator = bubble?.locator
    console.log('[dsh-todo] opening popup with sessionId:', sessionId, 'locator:', locator)
    setPopup({ text, sessionId, locator })
    setBubble(null)
    const selection = window.getSelection()
    if (selection !== null) selection.removeAllRanges()
  }, [bubble, getCurrentSessionId])

  // v1.1.3 修复③：全局划词气泡路径同样点亮"AI 整理�?（dock chip / 侧栏头部监听该事件）
  const onPopupAdded = useCallback(({ aiStarted } = {}) => {
    if (aiStarted === true) {
      try { window.dispatchEvent(new Event('dsh-todo:ai-started')) } catch { }
    }
          showToast(aiStarted === true ? 'AI 总结中…完成后自动入列（面板提示）' : '已加入待办')

    // v0.9.7 通知侧边栏立即刷新（不必手点�
    try { window.dispatchEvent(new Event('dsh-todo:changed')) } catch { }
  }, [showToast])

  return h('div', { style: { position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 2147483000 } },
    bubble !== null ? h('button', {
      type: 'button',
      style: { ...style.bubble, left: bubble.left, top: bubble.top, pointerEvents: 'auto' },
      onMouseDown: (event) => {
        event.preventDefault()
        openPopupFromBubble()
      },
    }, '＋待办') : null,
    popup !== null ? h(TodoPopup, {
      text: popup.text,
      sessionId: popup.sessionId,
      locator: popup.locator,
      todosApi,
      onClose: () => setPopup(null),
      onAdded: onPopupAdded,
      showToast,
    }) : null,
    toast !== null ? h('div', { style: { ...style.toast, bottom: 12, pointerEvents: 'auto' } }, toast) : null,
  )
}
//#endregion

//#region v0.9.9 全局应用内到期提醒弹窗（notifyMode='popup'�
/**
 * popup 渠道待办到点时右下角弹窗；与宿主�?IM 推送互补�? * 关闭/查看后回�?reminded，完成则直接标记完成�? */
function GlobalReminderPopup({ todosApi, openSession }) {
  const [queue, setQueue] = useState([])
  const shownRef = useRef(new Set())

  const check = useCallback(() => {
    void (async () => {
      try {
        const result = await todosApi.list({})
        // v1.2.2 修复④：todosApi �?unwrap 包装，返回服务层信封 {ok,value:{items,...}}�
        // 旧写�?result.items �?undefined �?弹窗队列恒空 �?到点提醒永不弹�
        const items = result.value?.items ?? []
        const now = Date.now()
        // v1.0：按多选渠道判断是否需要应用内弹窗（显�?notifyPopup > �?notifyMode 兼容 > 默认开�
        const wantsPopup = (i) => {
          if (i.notifyPopup !== undefined) return i.notifyPopup === true
          if (i.notifyMode !== undefined) return i.notifyMode === 'popup' || i.notifyMode === 'global'
          return true
        }
        const fresh = items.filter((i) =>
          i.status === 'pending' &&
          wantsPopup(i) &&
          typeof i.dueAtMs === 'number' &&
          i.dueAtMs <= now &&
          i.reminded !== true &&
          !shownRef.current.has(i.id))
        if (fresh.length > 0) {
          fresh.forEach((i) => shownRef.current.add(i.id))
          // v1.2.9 发布加固：shownRef 加上界（长跑会话里不断累积已提示 id 会长期占内存）。
          if (shownRef.current.size > 500) {
            const keep = new Set(items.slice(-200).map((i) => i.id))
            for (const id of [...shownRef.current]) if (!keep.has(id)) shownRef.current.delete(id)
          }
          setQueue((q) => [...q, ...fresh])
        }
      } catch (error) {
        console.warn('[dsh-todo] 提醒轮询失败（下次会重试）：', error)
      }
    })()
  }, [todosApi])

  useEffect(() => {
    check()
    const timer = window.setInterval(check, 20000)
    const handler = () => check()
    window.addEventListener('dsh-todo:changed', handler)
    return () => { window.clearInterval(timer); window.removeEventListener('dsh-todo:changed', handler) }
  }, [check])

  // v1.0：弹窗关闭后统一调 reminderHandled（周期滚动/单次标记）
  const dismiss = useCallback((item) => {
    setQueue((q) => q.filter((i) => i.id !== item.id))
    quietly(() => todosApi.reminderHandled({ id: item.id }), 'reminderHandled')
  }, [todosApi])

  const complete = useCallback((item) => {
    setQueue((q) => q.filter((i) => i.id !== item.id))
    quietly(() => todosApi.setStatus({ id: item.id, status: 'completed' }), 'setStatus(完成)')
  }, [todosApi])

  const view = useCallback((item) => {
    setQueue((q) => q.filter((i) => i.id !== item.id))
    quietly(() => todosApi.reminderHandled({ id: item.id }), 'reminderHandled')
    if (typeof openSession === 'function') {
      // 发布加固：openSession 可能同步返回 undefined（宿主未就绪），
      // 旧写法 `xxx().catch()` 会抛 TypeError 并炸掉整棵全局树（提醒弹窗与划词气泡永久消失）。
      quietly(() => openSession(item.sessionId, {
        ...(item.messageId ? { messageId: item.messageId } : {}),
        ...(item.anchorText ? { anchorText: item.anchorText } : {}),
      }), 'openSession(查看)')
    }
  }, [todosApi, openSession])

  const item = queue[0]
  if (item === undefined) return null
  return h('div', {
    style: {
      position: 'fixed', right: 20, bottom: 20, zIndex: 2147483646,
      width: 320, boxSizing: 'border-box',
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 12,
      boxShadow: '0 12px 40px rgba(0,0,0,0.22)', padding: 14,
      animation: 'dshTodoPop 0.2s ease',
    },
  },
    h('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 } },
      h(IconAi, { size: 14, color: 'var(--dsw-alias-brand-primary, #f59e0b)' }), item.title),
    item.content
      ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 10, whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' } }, item.content)
      : h('div', { style: { marginBottom: 10 } }),
    h('div', { style: { display: 'flex', gap: 6, justifyContent: 'flex-end' } },
      h('button', { type: 'button', style: { ...style.ghostButton, fontSize: 12, padding: '4px 10px' }, onClick: () => dismiss(item) }, '\u77e5\u9053\u4e86'),

      item.sessionId ? h('button', { type: 'button', style: { ...style.ghostButton, fontSize: 12, padding: '4px 10px' }, onClick: () => view(item) }, '查看') : null,
      h('button', { type: 'button', style: { ...style.miniButton, fontSize: 12, padding: '4px 12px' }, onClick: () => complete(item) }, '完成'),
    ),
  )
}
//#endregion

//#region 左侧侧栏常驻面板（v0.6：参�?cost-meter 样式 + 全局划词气泡，不依赖 dock 渲染�
//#region v1.5.0 导出对话框（全部记录 → HTML / Markdown / Excel / CSV / JSON）
/**
 * 导出全部记录的对话框 / 内联面板。
 *
 * 设计取舍：
 * - 范围只影响「导出哪些条目」，格式只影响「导出成什么文件」，两者独立；
 * - 格式卡片直接写出「给谁看」，因为用户的原始需求就是「给人看和给 AI 看」；
 * - 默认 HTML + 全部记录（最常见的「我想留一份完整档案」）；
 * - v1.5.3：新增 inline 模式——设置页的折叠区直接复用这份表单，不弹遮罩。
 *   侧栏头部的导出按钮已移除（用户要求「这个页面要简洁」）。
 */
function ExportDialog({ items, onClose, showToast, inline = false }) {
  const [format, setFormat] = useState('html')
  const [scope, setScope] = useState('all')
  const [busy, setBusy] = useState(false)

  const all = Array.isArray(items) ? items : []
  const stats = summarizeExport(all)
  const scopeItem = EXPORT_SCOPES.find((s) => s.id === scope) ?? EXPORT_SCOPES[0]
  const formatItem = EXPORT_FORMATS.find((f) => f.id === format) ?? EXPORT_FORMATS[0]

  // 预估将导出的条数（与真正导出用同一套筛选规则，避免「说 7 条实际 5 条」）
  const previewCount = all.filter((item) => {
    if (scope === 'pending') return item?.status === 'pending'
    if (scope === 'done') return item?.status === 'completed'
    if (scope === 'abandoned') return item?.status === 'abandoned'
    if (scope === 'overdue') return isOverdue(item)
    return true
  }).length

  const run = useCallback(() => {
    if (busy) return
    if (previewCount === 0) {
      showToast('这个范围里没有记录可导出')
      return
    }
    setBusy(true)
    try {
      const result = buildExportFile(all, {
        format,
        scope,
        appVersion: '1.5.3',
      })
      const filename = downloadExportFile(result)
      showToast(`已导出 ${result.count} 条记录：${filename}`)
      if (typeof onClose === 'function') onClose()
    } catch (error) {
      console.warn('[dsh-todo] export failed:', error)
      showToast(`导出失败：${error?.message ?? error}`)
    } finally {
      setBusy(false)
    }
  }, [busy, previewCount, all, format, scope, showToast, onClose])

  const cardStyle = (active) => ({
    display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start',
    padding: '10px 12px', borderRadius: 8, cursor: 'pointer', textAlign: 'left',
    border: `1px solid ${active ? 'var(--dsw-alias-brand-primary, #f59e0b)' : 'var(--dsw-alias-border-l2, #ddd)'}`,
    background: active
      ? 'color-mix(in srgb, var(--dsw-alias-brand-primary, #f59e0b) 10%, transparent)'
      : 'var(--dsw-alias-bg-layer-2, #f8f8f8)',
    color: 'var(--dsw-alias-label-primary)',
    minWidth: 150, flex: '1 1 150px',
  })

  // 表单主体（弹窗与内联共用，避免两处逻辑漂移）
  const body = [
    inline ? null : h('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 4 } },
      h('h3', { style: { fontSize: 16, fontWeight: 600, margin: 0 } }, '导出待办记录'),
      h('button', {
        type: 'button', onClick: onClose,
        style: {
          marginLeft: 'auto', border: 'none', background: 'transparent', cursor: 'pointer',
          color: 'var(--dsw-alias-label-secondary)', padding: 4, lineHeight: 0,
        },
        title: '关闭',
      }, h(IconX, { size: 16 })),
    ),
    h('p', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: inline ? '0 0 14px' : '0 0 16px' } },
      `共 ${stats.total} 条记录（未完成 ${stats.pending} / 已完成 ${stats.completed} / 已放弃 ${stats.abandoned}）。导出内容只包含这份清单，不含对话原文。`),

    h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } }, '导出成什么'),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 } },
      EXPORT_FORMATS.map((option) => h('label', {
        key: option.id, style: cardStyle(format === option.id),
      },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
          h('input', {
            type: 'radio', name: 'dsh-todo-export-format', value: option.id,
            checked: format === option.id,
            onChange: () => setFormat(option.id),
            style: { margin: 0, accentColor: 'var(--dsw-alias-brand-primary, #f59e0b)' },
          }),
          h('span', { style: { fontSize: 13, fontWeight: 600 } }, option.label),
        ),
        h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', paddingLeft: 20 } }, option.audience),
        h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', paddingLeft: 20, lineHeight: 1.45 } }, option.hint),
      )),
    ),

    h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 6 } }, '导出哪些'),
    h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
      EXPORT_SCOPES.map((option) => h('button', {
        key: option.id, type: 'button', onClick: () => setScope(option.id),
        title: option.hint,
        style: {
          padding: '5px 12px', fontSize: 12, cursor: 'pointer', borderRadius: 999,
          border: `1px solid ${scope === option.id ? 'var(--dsw-alias-brand-primary, #f59e0b)' : 'var(--dsw-alias-border-l2, #ddd)'}`,
          background: scope === option.id
            ? 'color-mix(in srgb, var(--dsw-alias-brand-primary, #f59e0b) 12%, transparent)'
            : 'transparent',
          color: scope === option.id
            ? 'var(--dsw-alias-brand-primary, #f59e0b)'
            : 'var(--dsw-alias-label-secondary)',
        },
      }, option.label)),
    ),

    h('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: 10, marginTop: 18,
        paddingTop: 14, borderTop: '1px solid var(--dsw-alias-border-l2, #eee)',
      },
    },
      h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
        `将导出 ${previewCount} 条 → ${formatItem.label}`),
      inline ? null : h('button', {
        type: 'button', onClick: onClose,
        style: {
          marginLeft: 'auto', padding: '7px 16px', fontSize: 13, cursor: 'pointer',
          borderRadius: 6, border: '1px solid var(--dsw-alias-border-l2, #ddd)',
          background: 'transparent', color: 'var(--dsw-alias-label-primary)',
        },
      }, '取消'),
      h('button', {
        type: 'button', onClick: run, disabled: busy || previewCount === 0,
        style: {
          marginLeft: inline ? 'auto' : 0,
          padding: '7px 18px', fontSize: 13, fontWeight: 500, borderRadius: 6, border: 'none',
          cursor: busy || previewCount === 0 ? 'not-allowed' : 'pointer',
          background: 'var(--dsw-alias-brand-primary, #f59e0b)', color: '#fff',
          opacity: busy || previewCount === 0 ? 0.55 : 1,
        },
      }, busy ? '导出中…' : '导出文件'),
    ),
    h('p', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', margin: '10px 0 0', lineHeight: 1.5 } },
      '文件会下载到浏览器的默认下载目录。HTML 可直接双击打开、也能打印成 PDF；Excel 可用 Excel / WPS 打开；Markdown / CSV / JSON 适合贴给 AI 或导入其它工具。'),
  ]

  // 内联模式：不弹遮罩、不占最大高度，交给设置页的折叠容器
  if (inline) return h(Fragment, null, body)

  return h('div', {
    style: {
      position: 'fixed', inset: 0, zIndex: 2147483647,
      background: 'rgba(0, 0, 0, .38)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 20,
    },
    onClick: (e) => { if (e.target === e.currentTarget) onClose() },
  },
    h('div', {
      style: {
        width: 'min(560px, 100%)', maxHeight: '86vh', overflowY: 'auto',
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l2, #ddd)',
        borderRadius: 12, padding: '18px 20px 20px',
        boxShadow: '0 16px 48px rgba(0, 0, 0, .22)',
      },
    }, body),
  )
}
//#endregion

function TodoSidebar({ todosApi, sessionOpen, createFollowupSession }) {
  const [items, setItems] = useState([])
  const [open, setOpen] = useState(readFlag('dsh-todo:sidebar-open', false))
  const [toast, setToast] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // v1.1.6 反馈⑥：侧栏行内 �?�?�?编辑待办弹窗
  const [editingItem, setEditingItem] = useState(null)
  // v1.1.3 修复③：AI 总结在途标识（�?dock chip 同款徽标�
  const [aiPending, setAiPending] = useState(false)
  const aliveRef = useRef(true)
  const toastTimerRef = useRef(undefined)
  const panelRef = useRef(null)

  // v1.2.8 修复①：提示一律只渲染纯文本。此前「双击 / ↗ 新建会话」传的是 { text, ms } 对象，
  // 直接 setToast(对象) 会让 React 渲染对象子节点并抛错，该槽位条目随之被移除
  // ——用户看到的现象就是「双击之后左侧待办清单面板整个消失」。
  // 这里统一归一化：对象取 .text、时长取 .ms（默认 2200ms）；字符串原样、维持 2200ms。
  const showToast = useCallback((message) => {
    const isObject = message !== null && typeof message === 'object'
    const text = isObject ? String(message.text ?? '') : String(message ?? '')
    const ms = isObject && Number.isFinite(message.ms) ? message.ms : 2_200
    setToast(text)
    if (toastTimerRef.current !== undefined) window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => {
      if (aliveRef.current) setToast(null)
    }, ms)
  }, [])

  const refresh = useCallback(async () => {
    if (todosApi === undefined) return
    try {
      const result = await todosApi.list({})
      if (aliveRef.current && result.ok) {
        const list = Array.isArray(result.value?.items) ? result.value.items : []
        setItems(list)
        // v1.1.3 修复③：AI 条目已入列（aiUnseen 出现）→ 撤下"AI 整理
        if (list.some((item) => item.aiUnseen === true)) setAiPending(false)
      }
    } catch (error) {
      if (aliveRef.current) console.warn('[dsh-todo] 侧栏刷新失败（下次轮询会重试）：', error)
    }
  }, [todosApi])

  useEffect(() => {
    aliveRef.current = true
    void refresh()
    // v1.2.9 发布加固：可见时 5s 轮询；后台标签页退避到 30s 且不拉数据
    // （原先无条件每 5s 调一次 todos.list，与提醒轮询重复）。
    let timer
    const tick = () => {
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
      timer = window.setTimeout(async () => {
        if (!hidden) await refresh()
        tick()
      }, hidden ? 30_000 : 5_000)
    }
    tick()
    const onChanged = () => { void refresh() }
    window.addEventListener('dsh-todo:changed', onChanged)
    // v1.1.3 修复③：AI 总结启动事件 �?点亮头部"AI 整理�?徽标�? 分钟兜底自动熄灭�
    const onAiStarted = () => setAiPending(true)
    window.addEventListener('dsh-todo:ai-started', onAiStarted)
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    window.addEventListener('focus', onVisible)
    return () => {
      aliveRef.current = false
      window.clearTimeout(timer)
      window.removeEventListener('dsh-todo:changed', onChanged)
      window.removeEventListener('dsh-todo:ai-started', onAiStarted)
      window.removeEventListener('focus', onVisible)
      if (toastTimerRef.current !== undefined) window.clearTimeout(toastTimerRef.current)
    }
  }, [refresh])

  // v1.1.3 修复③：aiPending 超过 AI_POLL_WINDOW_MS 自动熄灭（防止宿�?AI 失败时永久悬挂）
  useEffect(() => {
    if (!aiPending) return
    const t = window.setTimeout(() => setAiPending(false), AI_POLL_WINDOW_MS)
    return () => window.clearTimeout(t)
  }, [aiPending])

  // v0.9.7 反馈⑥：无论当前状态，点击面板外部自动收纳为简洁�
  useEffect(() => {
    const onPointerDown = (event) => {
      const node = panelRef.current
      if (node && !node.contains(event.target) && aliveRef.current) {
        setOpen(false)
        try { window.localStorage.setItem('dsh-todo:sidebar-open', '0') } catch { }
      }
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [])

  // v0.7.0：划词气泡已移至 GlobalSelectionBubble 全局组件，此处不再注
  const toggle = useCallback(() => {
    setOpen((previous) => {
      const next = !previous
      try { window.localStorage.setItem('dsh-todo:sidebar-open', next ? '1' : '0') } catch { }
      return next
    })
    void refresh()
    quietly(() => todosApi.markSeen({}), 'markSeen')
  }, [refresh, todosApi])

  const handleAction = useCallback((action) => {
    const run = async () => {
      try {
        if (action.kind === 'complete') {
          await todosApi.setStatus({ id: action.id, status: 'completed' })
          showToast('已完成')
        } else if (action.kind === 'defer') {
          await todosApi.defer({ id: action.id, dueAt: action.dueAt })
          showToast('已延期')
        } else if (action.kind === 'abandon') {
          await todosApi.abandon({ id: action.id, ...(action.reason === undefined ? {} : { reason: action.reason }) })
          showToast('已放弃')
        } else if (action.kind === 'delete') {
          await todosApi.deleteTodo({ id: action.id })
          showToast('已删除')
        } else if (action.kind === 'clearCompleted') {
          await todosApi.clearCompleted({})
          showToast('已清除已完结')
        } else if (action.kind === 'process') {
          if (typeof sessionOpen !== 'function') { showToast('会话导航服务不可用'); return }
          const locator = {
            ...(action.messageId ? { messageId: action.messageId } : {}),
            ...(action.anchorText ? { anchorText: action.anchorText } : {}),
          }
          try { await sessionOpen(action.sessionId, locator); showToast('已跳转到划词位置') }
          catch { showToast('会话不存在或已归档，请在会话列表手动恢复后打开') }
          return
        }
        await refresh()
      } catch (error) {
        // 发布加固：以前这里没有 catch，失败只会变成一条静默的 unhandled rejection（用户看到「点了没反应」）。
        console.warn('[dsh-todo] 侧栏操作失败：', error)
        showToast(`操作失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    void run()
  }, [todosApi, refresh, sessionOpen, showToast])

  // v0.9.9：一键以此待办新建会话（同工作区，内容自动带入、标题沿用）
  // v1.1.7：传 todoId——新会话发出首条消息后待办自动标�?completed
  const followup = useCallback((item) => {
    if (typeof createFollowupSession !== 'function') { showToast('新建会话服务不可用'); return }

    void (async () => {
      try {
        // v1.2.6：等待提示延长到 6s（此�?2s 闪没，用户以为点击无效）
        showToast({ text: '正在新建会话…发送后待办自动完成', ms: 6000 })
        await createFollowupSession({
          sourceSessionId: item.sessionId,
          title: item.title,
          content: item.content ?? item.title,
          todoId: item.id,
        })
      } catch (e) {
        showToast(`新建会话失败：${e?.message ?? e}`)
      }
    })()
  }, [createFollowupSession, showToast])

  let pendingCount = 0
  let completedCount = 0
  let abandonedCount = 0
  let expectedCount = 0 // v1.1 今天应处理（逾期+今天到期）
  let aiUnseen = false
  for (const item of items) {
    if (item.status === 'pending') {
      pendingCount += 1
      if (isDueToday(item)) expectedCount += 1
      if (item.aiUnseen === true) aiUnseen = true
    } else {
      if (item.status === 'completed') completedCount += 1
      else abandonedCount += 1
    }
  }
  const total = items.length
  const finishedCount = completedCount + abandonedCount
  const { pending, finished } = splitItems(items)

  return h('div', { ref: panelRef, 'data-dsh-todo': '1', style: style.sidebarWrap },
    h('div', { style: style.sidebarCard },
      h('div', { style: style.sidebarHead, onClick: toggle, title: open ? '收起待办面板' : '展开待办面板' },
        h('span', { style: { ...style.sidebarChevron, transform: open ? 'rotate(90deg)' : 'rotate(0deg)' } },
          h(IconChevron, { size: 14 })),
        // v1.2.2 反馈②：删除头部 IconList 图标（用户反馈：图标�?待办清单"挤得换行，删掉节省空间）
        aiUnseen ? h('span', { style: style.greenDot }) : null,
        h('span', { style: style.sidebarTitle }, '待办清单'),
        // v1.1.3 修复③：AI 总结在途徽标（脉动，条目入列或 2 分钟超时后消失）
        // v1.5.0：改为脉动圆点（原先「⏳ AI 整理中…」文字徽标在 254px 侧栏里挤掉标题）
        aiPending ? h('span', { style: style.aiPendingDot, title: 'AI 整理中…' }) : null,

        // 预期：橙色胶囊，与待完成拉开间距；整组往右留 marginRight，视觉上往左移
        expectedCount > 0 ? h('span', {
          style: {
            fontSize: 10.5, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', flexShrink: 0,
            padding: '1px 6px', borderRadius: 999,
            background: 'color-mix(in srgb, var(--dsw-alias-brand-primary, #f59e0b) 14%, transparent)',
            color: 'var(--dsw-alias-brand-primary, #f59e0b)',
            marginRight: 2,
          },
        }, `预期 ${expectedCount} 项`) : null,
        // v1.5.3：导出入口已从侧栏头部移除（用户要求「这个页面要简洁」）；
        // 导出改到「设置 → 待办清单 → 导出」的折叠区，见 TodoSettingsPage。
        h('span', {
          style: {
            ...style.sidebarBadge,
            padding: '2px 6px', borderRadius: 999,
            background: 'var(--dsw-alias-bg-layer-2, #f0f0f0)',
          },
          }, pending.length > 0 ? `待完成 ${pending.length}` : '全部完成'),
      ),
      h('div', { style: { ...style.sidebarContent, maxHeight: open ? 600 : 0, opacity: open ? 1 : 0 } },
        h('div', { style: style.sidebarList },
          pending.length === 0 ? h('div', { style: style.sidebarEmpty }, '暂无待办') : pending.map((item) =>
            h(TodoRow, { key: item.id, item, onAction: handleAction, onFollowup: followup, onEdit: (it) => setEditingItem(it), showToast }),
          ),
        ),
      ),
    ),
      editingItem ? h(TodoEditDialog, {
      item: editingItem,
      todosApi,
      onClose: () => setEditingItem(null),
      onSaved: () => { void refresh() },
      showToast,
    }) : null,
    // v0.7.0：划词气泡和弹窗已移�?GlobalSelectionBubble 全局组件
    toast !== null ? h('div', { style: { ...style.toast, bottom: 12 } }, toast) : null,
    settingsOpen ? h(SettingsPopup, {
      todosApi,
      onClose: () => setSettingsOpen(false),
      showToast,
    }) : null,
  )
}
//#endregion

//#region v0.9.0 设置弹窗（模型设�?+ 提醒渠道 + DSH-IM自选机器人�
function SettingsPopup({ todosApi, onClose, showToast }) {
  const [aiModel, setAiModel] = useState('')
  const [notifyPopup, setNotifyPopup] = useState(true)
  const [notifyIm, setNotifyIm] = useState(false)
  const [imBotId, setImBotId] = useState('')
  const [imTargetId, setImTargetId] = useState('')
  const [imAvailable, setImAvailable] = useState(false)

  useEffect(() => {
    // 检�?dsh-im 是否可用
    try {
      const im = window.__DSH_IM__ ?? null
      setImAvailable(im !== null)
    } catch { setImAvailable(false) }
  }, [])

  const save = useCallback(async () => {
    try {
      if (aiModel.length > 0) {
        const [provider, ...modelParts] = aiModel.split('/')
        const model = modelParts.join('/')
        if (provider && model) {
          await todosApi.setAiModel({ provider, model })
        }
      }
      // v1.0 通知配置存入 config
      await todosApi.saveNotifyConfig({
        popup: notifyPopup,
        im: notifyIm,
        imBotId,
        imTargetId,
      })
          showToast('设置已保存')

      onClose()
    } catch {
      showToast('保存失败')
    }
  }, [aiModel, notifyPopup, notifyIm, imBotId, imTargetId, todosApi, showToast, onClose])

  const sectionTitle = { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-tertiary)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, marginTop: 4 }
  const inputStyle = {
    width: '100%', padding: '7px 10px', fontSize: 13,
    border: '1px solid var(--dsw-alias-border-l2, #ddd)', borderRadius: 6,
    background: 'var(--dsw-alias-bg-layer-2, #f5f5f5)', boxSizing: 'border-box',
  }
  const checkboxLabel = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, marginBottom: 8, cursor: 'pointer' }

  return h('div', {
    style: {
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2147483001,
    },
    onClick: onClose,
  },
    h('div', {
      style: {
        background: 'var(--dsw-alias-bg-layer-1, #fff)',
        borderRadius: 12, width: 420, maxWidth: '92vw', maxHeight: '85vh', overflow: 'hidden',
        boxShadow: '0 12px 40px rgba(0,0,0,0.25)',
        display: 'flex', flexDirection: 'column',
      },
      onClick: (e) => e.stopPropagation(),
    },
      // 头部（参�?DSH 设置页面�?
h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--dsw-alias-border-l2, #eee)' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          h('span', { style: { fontSize: 16 } }, '📋'),
          h('span', { style: { fontSize: 15, fontWeight: 600 } }, '待办清单设置'),
          h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', background: 'var(--dsw-alias-bg-layer-2, #f0f0f0)', padding: '2px 6px', borderRadius: 4 } }, 'v1.5.3'),
        ),
        h('button', { type: 'button', onClick: onClose, style: { background: 'none', border: 'none', fontSize: 18, cursor: 'pointer', color: 'var(--dsh-alias-label-secondary)', padding: '4px 8px' } }, '×'),
      ),
      // 内容区（可滚动）
      h('div', { style: { padding: '16px 18px', overflowY: 'auto', flex: 1 } },
        // AI 模型设置
        h('div', { style: { marginBottom: 18 } },
          h('div', { style: sectionTitle }, 'AI 记录模型'),
          h('input', {
            type: 'text', placeholder: '留空 = 跟随当前会话默认模型',
            value: aiModel, onChange: (e) => setAiModel(e.target.value), style: inputStyle,
          }),
          h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginTop: 5 } }, '格式：provider/model，如 deepseek/deepseek-chat'),
        ),
        // 提醒渠道
        h('div', { style: { marginBottom: 18 } },
          h('div', { style: sectionTitle }, '提醒渠道'),
          h('div', { style: checkboxLabel },
            h(BrandCheckbox, { checked: notifyPopup, onChange: () => setNotifyPopup(!notifyPopup) }),
            h('span', null, '应用内弹窗提醒'),
            h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, '（到期待办弹出通知窗口）'),
          ),

          h('div', { style: checkboxLabel },
            h(BrandCheckbox, { checked: notifyIm, onChange: () => { if (imAvailable) setNotifyIm(!notifyIm) }, disabled: !imAvailable }),
            h('span', null, 'DSH-IM 推送'),
),
            h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, '（通过 DSH-IM 微信机器人推送）'),
),

          // DSH-IM 自选机器人
          notifyIm ? h('div', { style: { marginLeft: 24, marginTop: 8, padding: '10px 12px', background: 'var(--dsw-alias-bg-layer-2, #f8f8f8)', borderRadius: 8 } },
            h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 6 } }, '自选机器人（留空 = 全部机器人）'),
            h('div', { style: { display: 'flex', gap: 8, marginBottom: 6 } },
            h('input', { type: 'text', placeholder: '机器人 ID', value: imBotId, onChange: (e) => setImBotId(e.target.value), style: { flex: 1, padding: '6px 8px', fontSize: 12, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)' } }),
              h('input', { type: 'text', placeholder: '目标 ID', value: imTargetId, onChange: (e) => setImTargetId(e.target.value), style: { ...inputStyle, flex: 1 } }),
            ),
            h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, '支持微信/飞书/钉钉/企微/QQ/Slack/Telegram 等，在 dsh-im 中查看机器人 ID'),
          ) : null,

        // 关于
        h('div', { style: { marginTop: 8, padding: '10px 12px', background: 'var(--dsw-alias-bg-layer-2, #f8f8f8)', borderRadius: 8 } },
          h('div', { style: { fontSize: 12, color: 'var(--dsh-alias-label-secondary)', lineHeight: 1.6 } },
            h('div', null, '\ud83d\udccc 划词加待办：选中文字 \u2192 点「＋ 待办」\u2192 AI 总结或手动填写'),
            h('div', null, '\ud83d\udd14 提醒引擎：30 秒轮询到期待办，支持应用内弹窗和 DSH-IM 推送'),
            h('div', null, '\ud83e\udd16 AI 记录：临时 agent 会话总结，完成后自动入列（绿点提示）'),
          ),
        ),
      // 底部按钮
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px', borderTop: '1px solid var(--dsw-alias-border-l2, #eee)' } },
        h('button', {
          type: 'button', onClick: onClose,
          style: { padding: '7px 18px', fontSize: 13, border: '1px solid var(--dsw-alias-border-l2, #ddd)', borderRadius: 6, background: 'transparent', cursor: 'pointer' },
        }, '取消'),
        h('button', {
          type: 'button', onClick: save,
          style: { padding: '7px 18px', fontSize: 13, border: 'none', borderRadius: 6, background: 'var(--dsw-alias-brand-primary, #f59e0b)', color: '#fff', cursor: 'pointer', fontWeight: 500 },
        }, '保存设置'),
      ),
    ),
  )
  )
}
//#endregion

//#region v1.1 IM 渠道中文名映射（真实机器人）
const IM_CHANNEL_NAME = {
  weixin: '微信', wechat: '微信',
  feishu: '飞书', lark: '飞书',
  dingtalk: '钉钉',
  wecom: '企业微信', wecomApp: '企业微信',
  qq: 'QQ',
  slack: 'Slack',
  telegram: 'Telegram',
  discord: 'Discord',
  whatsapp: 'WhatsApp',
  imessage: 'iMessage',
  matrix: 'Matrix',
  office: '办公机器人',
}
/** 机器人下拉标签：平台中文名 · botId */
function imBotLabel(bot) {
  const platform = IM_CHANNEL_NAME[bot.channel] ?? bot.channel ?? '机器人'
  return `${platform} · ${bot.botId}`
}
//#endregion

//#region v0.9.4 设置页面（复�?dsh-archive-manager 风格：头�?tab+筛�?列表�
function TodoSettingsPage({ todosApi, sessionOpen, listWorkspaceInfo, workspaceOfSession, createFollowupSession, closeSettings }) {
  const [tab, setTab] = useState('pending') // pending | overdue | completed | abandoned
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [filterDue, setFilterDue] = useState('all') // all | today | overdue | none
  const [aiModel, setAiModel] = useState('')
  const [notifyPopup, setNotifyPopup] = useState(true)
  const [notifyIm, setNotifyIm] = useState(false)
  const [imBotId, setImBotId] = useState('')
  const [imTargetId, setImTargetId] = useState('')
  const [imBots, setImBots] = useState([]) // v1.1 真实机器人（企业微信/QQ/微信等）
  const [saved, setSaved] = useState(false)
  const [modelGroups, setModelGroups] = useState([])
  const [defaultModel, setDefaultModel] = useState({ provider: '', model: '' })
  // v1.1.7：行内⋯菜单已删除（图标取代），rowMenuId state 移除
  const [workspaceList, setWorkspaceList] = useState([]) // v0.9.8 工作区列表
  const [editingItem, setEditingItem] = useState(null) // v0.9.9 正在编辑的待办
  const [convertItem, setConvertItem] = useState(null) // v0.9.9 正在转定时任务的待办
  const [collapsedGroups, setCollapsedGroups] = useState({}) // 折叠的分组 key→true
  const [aiDefaultReminder, setAiDefaultReminder] = useState('') // v1.1.2 AI 记录默认提醒时间
  const [sidebarEnabled, setSidebarEnabled] = useState(true) // v1.2.2 反馈⑤：左侧边栏显示开关
  const [exportExpanded, setExportExpanded] = useState(false) // v1.5.3 导出折叠区（弹窗改为设置页内联）
  const [toast, setToastState] = useState(null)
  // 发布加固：toast/已保存 的定时器统一挂 ref，组件卸载时清掉（以前裸 setTimeout 卸载后仍会 setState）。
  const uiTimerRef = useRef({ toast: undefined, saved: undefined })
  useEffect(() => () => {
    if (uiTimerRef.current.toast !== undefined) window.clearTimeout(uiTimerRef.current.toast)
    if (uiTimerRef.current.saved !== undefined) window.clearTimeout(uiTimerRef.current.saved)
  }, [])
  const showToast = useCallback((msg) => {
    // v1.2.6：支持 { text, ms } 形态（'正在新建会话…' 等待类提示用 6s），纯字符串维持 2s
    const ms = typeof msg === 'object' && msg !== null ? (msg.ms ?? 2000) : 2000
    const text = typeof msg === 'object' && msg !== null ? msg.text : msg
    setToastState(text)
    if (uiTimerRef.current.toast !== undefined) window.clearTimeout(uiTimerRef.current.toast)
    uiTimerRef.current.toast = window.setTimeout(() => setToastState(null), ms)
  }, [])
  // v1.1.2 AI 记录默认提醒时间选项
  const AI_REMINDER_OPTIONS = [
    { value: '', label: '不默认（按 AI 判断，无时间则不提醒）' },

    { value: '1h', label: '1 小时后' },

    { value: '3h', label: '3 小时后' },

    { value: 'today18', label: '今天下班 18:00' },
    { value: 'tomorrow9', label: '明天上午 9:00' },
    { value: '3d', label: '3 天后上午 9:00' },
  ]

  // v0.9.6 加载 DSH 真实模型列表（按 provider 分组，参�?dsh-tasks�
  useEffect(() => {
    void (async () => {
      try {
        const result = await todosApi.listModels({})
        console.log('[dsh-todo] listModels result:', result)
        if (result.ok && result.value) {
          setModelGroups(result.value.groups ?? [])
          setDefaultModel(result.value.default ?? { provider: '', model: '' })
        }
      } catch (error) {
        console.warn('[dsh-todo] listModels failed:', error)
      }
    })()
  }, [todosApi])

  // v1.1 加载真实机器人（企业微信/QQ/微信等）供下�
  useEffect(() => {
    void (async () => {
      try {
        const r = await todosApi.listImBots({})
        if (r.ok && r.value) setImBots(r.value.bots ?? [])
      } catch (e) { console.warn('[dsh-todo] listImBots failed:', e) }
    })()
  }, [todosApi])

  // v0.9.8 反馈③：加载工作区列表（用于按工作区分组�
  useEffect(() => {
    try {
      const ws = typeof listWorkspaceInfo === 'function' ? listWorkspaceInfo() : []
      setWorkspaceList(ws)
    } catch (e) { console.warn('[dsh-todo] load workspaces failed:', e) }
  }, [listWorkspaceInfo, items])

  // v1.1 机器人下拉：真实机器人（企业微信/QQ/微信等）+ 全部机器人（默认）
  const BOT_OPTIONS = [
    { value: '', label: '全部机器人（默认）' },

    ...imBots.map((b) => ({ value: b.botId, label: imBotLabel(b) })),
  ]
  // 选中机器人的目标列表
  const selectedBot = imBots.find((b) => b.botId === imBotId)
  const TARGET_OPTIONS = [
    { value: '', label: '默认目标（第一个）' },
    ...((selectedBot?.targets ?? []).map((t) => ({ value: t.targetId, label: t.name ? `${t.name} · ${t.targetId}` : t.targetId }))),
  ]

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const result = await todosApi.list({})
      console.log('[dsh-todo] settings list result:', result)
      if (result.ok) {
        const value = result.value
        setItems(Array.isArray(value?.items) ? value.items : [])
        // v1.1.2 回显已保存的 AI 记录模型（否则每次打开都显示跟随默认）
        if (value?.aiModel?.provider && value?.aiModel?.model) {
          setAiModel(`${value.aiModel.provider}/${value.aiModel.model}`)
        } else {
          setAiModel('')
        }
        setAiDefaultReminder(value?.aiDefaultReminder ?? '')
        // v1.2.2 反馈⑤：回显左侧边栏开关（false 才下发，缺席 = 默认显示）
        setSidebarEnabled(value?.sidebarEnabled !== false)
        // v1.0 初始化全局通知配置（仅在尚未通过 list 拿到过时设置一次）
        if (value?.notify) {
          if (value.notify.popup !== undefined) setNotifyPopup(value.notify.popup)
          if (value.notify.im !== undefined) setNotifyIm(value.notify.im)
          if (value.notify.imBotId !== undefined) setImBotId(value.notify.imBotId)
          if (value.notify.imTargetId !== undefined) setImTargetId(value.notify.imTargetId)
        }
      }
    } catch (error) {
      console.warn('[dsh-todo] settings list error:', error)
    }
    setLoading(false)
  }, [todosApi])

  useEffect(() => { void refresh() }, [refresh])

  const save = useCallback(async () => {
    try {
      if (aiModel.length > 0) {
        const [provider, ...modelParts] = aiModel.split('/')
        const model = modelParts.join('/')
        if (provider && model) await todosApi.setAiModel({ provider, model })
      }
      // v1.0 全局通知配置存入 config（走宿主 saveNotifyConfig�
      await todosApi.saveNotifyConfig({
        popup: notifyPopup,
        im: notifyIm,
        imBotId,
        imTargetId,
        service: imBots.find((b) => b.botId === imBotId)?.service,
        aiDefaultReminder,
        sidebarEnabled, // v1.2.2 反馈⑤
      })
      setSaved(true)
      if (uiTimerRef.current.saved !== undefined) window.clearTimeout(uiTimerRef.current.saved)
      uiTimerRef.current.saved = window.setTimeout(() => setSaved(false), 2000)
      showToast('通知方式已保存')

    } catch (error) {
      console.warn('[dsh-todo] save settings failed:', error)
      showToast('保存失败，请重试')
    }
  }, [aiModel, notifyPopup, notifyIm, imBotId, imTargetId, aiDefaultReminder, sidebarEnabled, todosApi, showToast])

  // v1.1 模型下拉即时生效：选择即保存，避免未点保存导致 AI 记录用错模型
  const applyModelChange = useCallback(async (val) => {
    setAiModel(val)
    try {
      if (val.length === 0) {
        await todosApi.setAiModel({ provider: '', model: '' })
        showToast('已切回跟随当前会话默认模型')
      } else {
        const [provider, ...modelParts] = val.split('/')
        const model = modelParts.join('/')
        if (provider && model) {
          await todosApi.setAiModel({ provider, model })
          showToast(`AI 记录模型已切换：${provider}/${model}`)
        }
      }
    } catch (e) { console.warn('[dsh-todo] apply model failed:', e) }
  }, [todosApi, showToast])

  // v1.1.5 修复④：AI 记录默认提醒时间选择即保存（�?save 依赖数组�?aiDefaultReminder，闭包里永远是旧�?''，点了保存也存不上）
  const applyAiReminderChange = useCallback(async (val) => {
    setAiDefaultReminder(val)
    try {
      await todosApi.saveNotifyConfig({ aiDefaultReminder: val })
      showToast(val.length > 0 ? 'AI 默认提醒时间已保存' : '已取消 AI 默认提醒时间')
    } catch (e) { console.warn('[dsh-todo] save aiDefaultReminder failed:', e) }
  }, [todosApi, showToast])

  // 筛�
  const filtered = items.filter((item) => {
    // v1.1.2 未完成包含逾期（逾期本质也是未完成）；逾期 tab 为快捷子�
    if (tab === 'pending' && item.status !== 'pending') return false
    if (tab === 'overdue' && !isOverdue(item)) return false
    if (tab === 'completed' && item.status !== 'completed') return false
    if (tab === 'abandoned' && item.status !== 'abandoned') return false
    if (search && !String(item.title ?? '').includes(search) && !String(item.content ?? '').includes(search)) return false
    if (filterDue === 'today' && !item.dueAt) return false
    if (filterDue === 'overdue' && !isOverdue(item)) return false
    if (filterDue === 'none' && item.dueAt) return false
    return true
  })

  // v1.1.2 未完成计数包含逾期
  const pendingCount = items.filter((i) => i.status === 'pending').length
  const overdueCount = items.filter((i) => isOverdue(i)).length
  const completedCount = items.filter((i) => i.status === 'completed').length
  const abandonedCount = items.filter((i) => i.status === 'abandoned').length

  // 反馈③：把当前筛选结果按工作区分组（未归属工作区的归�?未分�?�
  const groupedItems = (() => {
    const buckets = new Map()
    for (const item of filtered) {
      const owner = item.sessionId
        ? workspaceOfSession(item.sessionId, workspaceList)
        : undefined
      const key = owner ? owner.id : 'ungrouped'
      if (!buckets.has(key)) buckets.set(key, { key, workspace: owner, items: [] })
      buckets.get(key).items.push(item)
    }
    return Array.from(buckets.values()).sort((a, b) => {
      if (a.key === 'ungrouped') return 1
      if (b.key === 'ungrouped') return -1
      return String(a.workspace?.title ?? '').localeCompare(String(b.workspace?.title ?? ''))
    })
  })()
  const toggleGroup = useCallback((key) => {
    setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  // 反馈①：点击标题跳回划词位置（含归档恢复+高亮�
  const goSource = useCallback(async (item) => {
    if (!item.sessionId || typeof sessionOpen !== 'function') { showToast('该待办无来源会话'); return }
    try {
      showToast('正在跳转到划词位置…')
      await sessionOpen(item.sessionId, {
        ...(item.messageId ? { messageId: item.messageId } : {}),
        ...(item.anchorText ? { anchorText: item.anchorText } : {}),
      })
      // v0.9.9 需求①：跳转成功后自动关闭设置�
      if (typeof closeSettings === 'function') closeSettings()
    } catch { showToast('会话不存在或已归档，暂无法自动恢复') }
  }, [sessionOpen, showToast, closeSettings])

  // 反馈⑤：一键以该待办为蓝本新建会话
  // v1.1.7：传 todoId——新会话发出首条消息后待办自动标�?completed
  const followup = useCallback(async (item) => {
    try {
      // v1.2.6：等待提示延长到 6s（此�?2s 闪没，用户以为点击无效）
      showToast({ text: '正在新建会话…发送后待办自动完成', ms: 6000 })
      await createFollowupSession({
        sourceSessionId: item.sessionId,
        title: item.title,
        content: item.content ?? item.title,
        todoId: item.id,
      })
      // v0.9.9 需求②：新建会话后已跳转，关闭设置�
      if (typeof closeSettings === 'function') closeSettings()
    } catch (e) {
      showToast(`新建会话失败：${e?.message ?? e}`)
    }
  }, [createFollowupSession, showToast, closeSettings])

  const selectStyle = {
    padding: '6px 10px', fontSize: 13, borderRadius: 6,
    border: '1px solid var(--dsw-alias-border-l2, #ddd)',
    background: 'var(--dsw-alias-bg-layer-2, #f5f5f5)',
    color: 'var(--dsw-alias-label-primary)', boxSizing: 'border-box',
  }

  return h('div', { style: { padding: '0 24px 24px', color: 'var(--dsw-alias-label-primary)' } },
    // 头部（参考 dsh-archive-manager）
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, padding: '16px 0', borderBottom: '1px solid var(--dsw-alias-border-l2, #eee)' } },
      h('h2', { style: { fontSize: 20, fontWeight: 600, margin: 0 } }, '待办清单'),
      h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', background: 'var(--dsw-alias-bg-layer-2, #f0f0f0)', padding: '2px 8px', borderRadius: 4 } }, 'v1.5.3'),
      h('a', { href: 'https://github.com/qgd1850890306-rgb/dsh-todo-checklist', target: '_blank', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', textDecoration: 'none', marginLeft: 'auto' } }, 'GitHub'),
      h('a', { href: 'https://github.com/qgd1850890306-rgb/dsh-todo-checklist/issues', target: '_blank', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', textDecoration: 'none' } }, '问题反馈'),
      h('a', { href: 'https://github.com/qgd1850890306-rgb/dsh-todo-checklist/releases', target: '_blank', style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', textDecoration: 'none', marginLeft: 8 } }, '检查更新'),
    ),
    h('p', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', margin: '8px 0 16px' } }, '划词加待办清单 · AI 总结 · 定时提醒'),
    // 设置区（折叠式）
    h('div', { style: { marginBottom: 16, padding: '12px 16px', background: 'var(--dsw-alias-bg-layer-2, #f8f8f8)', borderRadius: 10 } },
      h('div', { style: { display: 'flex', gap: 16, flexWrap: 'wrap' } },
        // AI 模型
        h('div', { style: { flex: 1, minWidth: 200 } },
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 } }, 'AI 记录模型'),
          h('select', { value: aiModel, onChange: (e) => { void applyModelChange(e.target.value) }, style: { ...selectStyle, width: '100%' } },
            h('option', { value: '' }, `跟随当前会话默认模型（${defaultModel.provider ? defaultModel.provider + '/' + defaultModel.model : '未设置'}）`),
            modelGroups.map((group) => h('optgroup', { key: group.id, label: group.name },
              (group.models ?? []).map((model) => h('option', { key: `${group.id}/${model.id}`, value: `${group.id}/${model.id}` }, model.name))
            )),
          ),
        ),
        // 提醒渠道
        h('div', { style: { flex: 1, minWidth: 200 } },
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 } }, '提醒渠道'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 4 } },
            h(BrandCheckbox, { checked: notifyPopup, onChange: () => setNotifyPopup(!notifyPopup) }),
            '应用内弹窗',
          ),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 } },
            h(BrandCheckbox, { checked: notifyIm, onChange: () => setNotifyIm(!notifyIm) }),
            'DSH-IM 推送',
          ),
        ),
        // v1.1 自选机器人（真实机器人 + 目标下拉）
        notifyIm ? h('div', { style: { flex: 1, minWidth: 200 } },
          h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 } }, '自选机器人'),
          h('select', {
            value: imBotId,
            onChange: (e) => { setImBotId(e.target.value); setImTargetId('') },
            style: { ...selectStyle, width: '100%', marginBottom: 4 },
          },
            BOT_OPTIONS.map((opt) => h('option', { key: opt.value, value: opt.value }, opt.label)),
          ),
          h('select', {
            value: imTargetId,
            onChange: (e) => setImTargetId(e.target.value),
            style: { ...selectStyle, width: '100%' },
          },
            TARGET_OPTIONS.map((opt) => h('option', { key: opt.value, value: opt.value }, opt.label)),
          ),
        ) : null,
        // 保存按钮
        h('div', { style: { display: 'flex', alignItems: 'flex-end' } },
          h('button', {
            type: 'button', onClick: save,
            style: { padding: '6px 16px', fontSize: 13, border: 'none', borderRadius: 6, background: 'var(--dsw-alias-brand-primary, #f59e0b)', color: '#fff', cursor: 'pointer', fontWeight: 500 },
          }, saved ? '已保存 ✓' : '保存'),
        ),
      ),
      // v1.2.2 反馈⑤：左侧边栏显示开关（变更后需重启 DSH 生效——侧栏槽为一次性注册）
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginTop: 10 } },
        h(BrandCheckbox, { checked: sidebarEnabled, onChange: () => setSidebarEnabled(!sidebarEnabled) }),
        '在左侧边栏显示待办清单（变更后重启 DSH 生效）',
      ),
    ),
    // v1.1.2 AI 记录默认提醒时间（AI 判断不出时间时兜底）
    h('div', { style: { marginBottom: 14 } },
      h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 } }, 'AI 记录默认提醒时间'),
      h('select', {
        value: aiDefaultReminder,
        onChange: (e) => applyAiReminderChange(e.target.value),
        style: { ...selectStyle, width: '100%' },
      },
        AI_REMINDER_OPTIONS.map((opt) => h('option', { key: opt.value, value: opt.value }, opt.label)),
      ),
    ),
    // v1.5.3：导出折叠区（用户要求：侧栏保持简洁，导出放在设置详情页里可展开）
    h('div', { style: { marginBottom: 14, border: '1px solid var(--dsw-alias-border-l2, #eee)', borderRadius: 10, overflow: 'hidden' } },
      h('button', {
        type: 'button',
        onClick: () => setExportExpanded(!exportExpanded),
        'aria-expanded': exportExpanded,
        title: exportExpanded ? '收起导出' : '展开导出',
        style: {
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          padding: '10px 14px', fontSize: 13, fontWeight: 500, cursor: 'pointer',
          border: 'none', textAlign: 'left',
          background: 'var(--dsw-alias-bg-layer-2, #f8f8f8)',
          color: 'var(--dsw-alias-label-primary)',
        },
      },
        h('span', { style: { ...style.sidebarChevron, transform: exportExpanded ? 'rotate(90deg)' : 'rotate(0deg)' } },
          h(IconChevron, { size: 13 })),
        h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
          h(IconExport, { size: 14 }), '导出全部记录'),
        h('span', { style: { marginLeft: 'auto', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', fontWeight: 400 } },
          `共 ${items.length} 条 · HTML / Markdown / Excel / CSV / JSON`),
      ),
      exportExpanded ? h('div', {
        style: {
          padding: '14px 14px 16px',
          borderTop: '1px solid var(--dsw-alias-border-l2, #eee)',
          background: 'var(--dsw-alias-bg-layer-1, #fff)',
        },
      }, h(ExportDialog, { items, onClose: undefined, showToast, inline: true })) : null,
    ),
    // tab 切换（参考 dsh-archive-manager）
    h('div', { style: { display: 'flex', borderBottom: '2px solid var(--dsw-alias-border-l2, #eee)', marginBottom: 12 } },
      h('button', {
        type: 'button', onClick: () => setTab('pending'),
        style: {
          padding: '8px 20px', fontSize: 13, fontWeight: tab === 'pending' ? 600 : 400,
          border: 'none', background: 'transparent', cursor: 'pointer',
          color: tab === 'pending' ? 'var(--dsw-alias-brand-primary, #f59e0b)' : 'var(--dsw-alias-label-secondary)',
          borderBottom: tab === 'pending' ? '2px solid var(--dsw-alias-brand-primary, #f59e0b)' : '2px solid transparent',
          marginBottom: -2,
        },
      }, `未完成 (${pendingCount})`),
      h('button', {
        type: 'button', onClick: () => setTab('completed'),
        style: {
          padding: '8px 20px', fontSize: 13, fontWeight: tab === 'completed' ? 600 : 400,
          border: 'none', background: 'transparent', cursor: 'pointer',
          color: tab === 'completed' ? 'var(--dsw-alias-brand-primary, #f59e0b)' : 'var(--dsw-alias-label-secondary)',
          borderBottom: tab === 'completed' ? '2px solid var(--dsw-alias-brand-primary, #f59e0b)' : '2px solid transparent',
          marginBottom: -2,
        },
      }, `已完成 (${completedCount})`),
      h('button', {
        type: 'button', onClick: () => setTab('abandoned'),
        style: {
          padding: '8px 20px', fontSize: 13, fontWeight: tab === 'abandoned' ? 600 : 400,
          border: 'none', background: 'transparent', cursor: 'pointer',
          color: tab === 'abandoned' ? 'var(--dsw-alias-brand-primary, #f59e0b)' : 'var(--dsw-alias-label-secondary)',
          borderBottom: tab === 'abandoned' ? '2px solid var(--dsw-alias-brand-primary, #f59e0b)' : '2px solid transparent',
          marginBottom: -2,
        },
      }, `已放弃 (${abandonedCount})`),
      // v1.1 逾期 tab（红色高亮，与列表逾期标签一致）
      h('button', {
        type: 'button', onClick: () => setTab('overdue'),
        style: {
          padding: '8px 20px', fontSize: 13, fontWeight: tab === 'overdue' ? 600 : 400,
          border: 'none', background: 'transparent', cursor: 'pointer',
          color: tab === 'overdue' ? 'var(--dsw-alias-danger, #c00)' : 'var(--dsw-alias-label-secondary)',
          borderBottom: tab === 'overdue' ? '2px solid var(--dsw-alias-danger, #c00)' : '2px solid transparent',
          marginBottom: -2,
        },
      }, `逾期 (${overdueCount})`),
    ),
    // 筛选栏（参考 dsh-archive-manager）
    h('div', { style: { display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap', alignItems: 'center' } },
      h('select', { value: filterDue, onChange: (e) => setFilterDue(e.target.value), style: selectStyle },
        h('option', { value: 'all' }, '全部提醒'),
        h('option', { value: 'today' }, '今天提醒'),
        h('option', { value: 'overdue' }, '已逾期'),
        h('option', { value: 'none' }, '无提醒'),
      ),
      h('input', {
        type: 'text', placeholder: '搜索待办...', value: search, onChange: (e) => setSearch(e.target.value),
        style: { ...selectStyle, flex: 1, minWidth: 150 },
      }),
    ),
    // 待办清单列表（参考 dsh-archive-manager 列表风格）
    h('div', { style: { border: '1px solid var(--dsw-alias-border-l2, #eee)', borderRadius: 10, overflow: 'hidden' } },
      loading ? h('div', { style: { padding: 20, textAlign: 'center', color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } }, '加载中…') :
      filtered.length === 0 ? h('div', { style: { padding: 30, textAlign: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 } }, '暂无待办') :
      groupedItems.map((group) => h('div', {
        key: group.key,
      },
        // 反馈⑥：工作区分组头（三角旋转动画 + 工作区名 + 数量徽标）
        h('div', {
          type: 'button',
          onClick: () => toggleGroup(group.key),
          style: {
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '9px 14px', cursor: 'pointer', userSelect: 'none',
            background: 'var(--dsw-alias-bg-layer-2, #f5f5f5)',
            borderBottom: '1px solid var(--dsw-alias-border-l2, #eee)',
            fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)',
          },
        },
          h('span', {
            style: {
              display: 'inline-block', fontSize: 10, lineHeight: 1,
              color: 'var(--dsw-alias-brand-primary, #f59e0b)',
              transform: collapsedGroups[group.key] ? 'rotate(0deg)' : 'rotate(90deg)',
              transition: 'transform .2s ease',
            },
          }, '▾'),
          h('span', { style: { flex: 1, textAlign: 'left' } }, group.workspace?.title ?? '未分组'),
          h('span', {
            style: { fontSize: 11, fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' },
          }, `${group.items.length} 项`),
        ),
        !collapsedGroups[group.key] ? group.items.map((item, idx) => h('div', {
        key: item.id,
        style: {
          display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px',
          borderBottom: idx < group.items.length - 1 ? '1px solid var(--dsw-alias-border-l2, #f0f0f0)' : 'none',
          background: idx % 2 === 0 ? 'var(--dsw-alias-bg-layer-1)' : 'var(--dsw-alias-bg-layer-2, #fafafa)',
        },
      },
        h(BrandCheckbox, {
          checked: item.status === 'completed',
          onChange: async () => {
            quietly(async () => {
              await todosApi.setStatus({ id: item.id, status: item.status === 'completed' ? 'pending' : 'completed' })
              await refresh()
            }, 'setStatus(勾选)')
          },
        }),
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', {
            onClick: () => { void goSource(item) },
            // v1.2.1 反馈②：双击=新建会话（同 �?图标），单击跳转保持不变
            onDoubleClick: (e) => { e.stopPropagation(); void followup(item) },
            title: item.sessionId ? '单击回到划词位置 / 双击新建会话' : item.content ?? item.title,
            style: {
              fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              cursor: item.sessionId ? 'pointer' : 'default',
            },
          }, item.title),
          h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginTop: 2 } },
            item.dueAt ? `提醒 ${formatDueTime(item.dueAt)}` : '无提醒',
            item.createdAt ? ` · ${new Date(item.createdAt).toLocaleDateString('zh-CN')}` : '',
          ),
        ),
        item.dueAt ? h('span', {
          style: {
            fontSize: 11, padding: '2px 8px', borderRadius: 4,
            background: isOverdue(item) ? 'var(--dsw-alias-danger, #fee)' : 'var(--dsw-alias-bg-layer-2, #f0f0f0)',
            color: isOverdue(item) ? 'var(--dsw-alias-danger-text, #c00)' : 'var(--dsw-alias-label-secondary)',
          },
        }, isOverdue(item) ? '逾期' : formatDueTime(item.dueAt)) : null,
        // v1.1.6 反馈⑤：行内图标精简为横排——SVG 图标（v1.2.1 反馈④：emoji 换矢量）
        h('button', {
          type: 'button',
          title: '编辑待办',
          onClick: (e) => { e.stopPropagation(); setEditingItem(item) },
          style: { color: 'var(--dsw-alias-label-secondary)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', lineHeight: 1 },
        }, h(IconEdit, { size: 15 })),
        h('button', {
          type: 'button',
          title: '🤖 AI 总结（生成结构化待办并替换本条）',
          onClick: (e) => {
            e.stopPropagation()
            void (async () => {
              try {
                const r = await todosApi.aiSummarizeItem({ id: item.id })
                if (r.ok) { showToast('AI 总结中…完成后自动替换本条') } else { showToast(`AI 总结失败：${r.error ?? '未知错误'}`) }
              } catch (err) { console.warn('[dsh-todo] aiSummarizeItem failed:', err); showToast('AI 总结失败，请重试') }
            })()
          },
          style: { color: 'var(--dsw-alias-brand-primary, #f59e0b)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', lineHeight: 1 },
        }, h(IconAi, { size: 15 })),
        h('button', {
          type: 'button',
          title: '删除',
          onClick: (e) => {
            e.stopPropagation()
            // 发布加固：删除失败以前是静默 unhandled rejection，现在给可见提示。
            quietly(async () => {
              const r = await todosApi.deleteTodo({ id: item.id })
              if (r && r.ok === false) { showToast(`删除失败：${r.error ?? '未知错误'}`); return }
              await refresh()
              showToast('已删除')
            }, 'deleteTodo')
          },
          style: { color: 'var(--dsw-alias-danger, #c00)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', lineHeight: 1 },
        }, h(IconX, { size: 15 })),
        // v1.1.7 反馈：详情页 ⋯菜单已被图标取代——删除⋯菜单，恢复 ↗ 新建会话图标
        // （跳转新会话：自动建标题、输入框预填待办内容；完成后待办自动标记完成）
        h('button', {
          type: 'button',
          title: '以此待办新建会话（发送后待办自动完成）',
          onClick: (e) => { e.stopPropagation(); void followup(item) },
          style: { fontSize: 14, color: 'var(--dsw-alias-brand-primary, #f59e0b)', background: 'none', border: 'none', cursor: 'pointer', padding: '4px 6px', lineHeight: 1 },
        }, h(IconFollowup, { size: 15 })),
        )) : null,
      )),
      // v0.9.9 编辑待办弹窗
      editingItem ? h(TodoEditDialog, {
        item: editingItem,
        todosApi,
        onClose: () => setEditingItem(null),
        onSaved: () => { void refresh() },
        onConvert: (it) => { setEditingItem(null); setConvertItem(it) },
        showToast,
      }) : null,
      // v0.9.9 转定时任务弹窗
      convertItem ? h(ConvertToTaskDialog, {
        item: convertItem,
        todosApi,
        defaultWorkspaceId: convertItem.sessionId ? (workspaceOfSession(convertItem.sessionId, workspaceList)?.id ?? '') : '',
        onClose: () => setConvertItem(null),
        onConverted: () => { void refresh() },
        showToast,
      }) : null,
      // v1.5.3：导出改为设置页内联折叠区（v1.5.0 的弹窗出口已移除）
      // v1.2.5 修复"设置页↗点击没反应"：showToast 只 setToast 但渲染树无出口——
      // 补上 toast 渲染（fixed 定位浮层，与侧栏同款样式）
      toast !== null ? h('div', { style: { ...style.toast, position: 'fixed', right: 20, bottom: 12, zIndex: 2147483646, pointerEvents: 'none' } }, toast) : null,
    ),
  )
}
//#endregion

//#region v0.9.9 编辑待办 + 转定时任�
/** ISO 时间 �?datetime-local 本地格式（编辑回显）�?*/
function isoToLocal(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (v) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 编辑待办弹窗（v1.0 扁平化）：提醒时间（单次/每天/每周，参�?dsh-tasks cron�? 多选通知渠道�?*/
function TodoEditDialog({ item, todosApi, onClose, onSaved, onConvert, showToast }) {
  const [title, setTitle] = useState(item.title ?? '')
  const [content, setContent] = useState(item.content ?? '')
  // 提醒模式：单�?/ 每天 / 每周
  const [mode, setMode] = useState(item.recurrence ? item.recurrence.type : 'once')
  const [onceLocal, setOnceLocal] = useState(isoToLocal(item.dueAt))
  const [hour, setHour] = useState(item.recurrence?.hour ?? (item.dueAt ? new Date(item.dueAt).getHours() : 9))
  const [minute, setMinute] = useState(item.recurrence?.minute ?? (item.dueAt ? new Date(item.dueAt).getMinutes() : 0))
  const [weekdays, setWeekdays] = useState(item.recurrence?.weekdays ?? (item.dueAt ? [new Date(item.dueAt).getDay()] : [1]))
  // 通知渠道初始值（兼容�?notifyMode；默认应用内弹窗开�
  const initNotify = (() => {
    if (item.notifyPopup !== undefined || item.notifyIm !== undefined) {
      return { popup: item.notifyPopup ?? false, im: item.notifyIm ?? false }
    }
    if (item.notifyMode !== undefined) {
      if (item.notifyMode === 'popup') return { popup: true, im: false }
      if (item.notifyMode === 'im') return { popup: false, im: true }
      if (item.notifyMode === 'none') return { popup: false, im: false }
      return { popup: true, im: false }
    }
    return { popup: true, im: false }
  })()
  const [popup, setPopup] = useState(initNotify.popup)
  const [im, setIm] = useState(initNotify.im)
  // v1.1 机器人选择（真实机器人�
  const [imBots, setImBots] = useState([])
  const [botId, setBotId] = useState(item.imBotId ?? '')
  const [targetId, setTargetId] = useState(item.imTargetId ?? '')
  const [saving, setSaving] = useState(false)
  // v1.1.2 内容框自适应高度（最�?140，随内容增长，避免内容多看不全）
  const contentRef = useRef(null)
  // v1.3.0 反馈①：分段式提醒时间输入接管 ± 步进（dueField/stepOnceLocal/inferOnceFieldByDiff 退役）
  const onceLocalRef = useRef(onceLocal)
  useEffect(() => { onceLocalRef.current = onceLocal }, [onceLocal])
  const autoGrow = useCallback((el) => {
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.max(140, el.scrollHeight + 6)}px`
  }, [])
  useEffect(() => { autoGrow(contentRef.current) }, [content, autoGrow])

  useEffect(() => {
    void (async () => {
      try {
        const r = await todosApi.listImBots({})
        if (r.ok && r.value) setImBots(r.value.bots ?? [])
      } catch (e) { console.warn('[dsh-todo] listImBots failed:', e) }
    })()
  }, [todosApi])

  const localStr = (d) => {
    const pad = (v) => String(v).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  // 快捷胶囊：切到单次并设置时间
  const quickOnce = (ms) => { setMode('once'); setOnceLocal(localStr(new Date(ms))) }

  const save = useCallback(() => {
    const cleanTitle = title.trim()
    const cleanContent = content.trim()
    // v1.1 标题清空：由内容自动重新总结；标题和内容都空才拦�
    if (cleanTitle.length === 0 && cleanContent.length === 0) { showToast('请填写标题或内容'); return }
    const payload = { id: item.id, title: cleanTitle, content, notifyPopup: popup, notifyIm: im, imBotId: botId, imTargetId: targetId }
    if (im && botId) {
      const svc = imBots.find((b) => b.botId === botId)?.service
      if (svc) payload.imService = svc
    }
    if (mode === 'once') {
      payload.dueAt = onceLocal
      payload.recurrence = null
    } else if (mode === 'daily') {
      payload.recurrence = { type: 'daily', hour, minute }
    } else {
      if (weekdays.length === 0) { showToast('请选择星期'); return }
      payload.recurrence = { type: 'weekly', hour, minute, weekdays: [...weekdays].sort((a, b) => a - b) }
    }
    void (async () => {
      setSaving(true)
      try {
        const result = await todosApi.update(payload)
        if (result.ok) {
          showToast('已保存')
          try { window.dispatchEvent(new Event('dsh-todo:changed')) } catch { }
          onSaved?.()
          onClose()
        } else {
          showToast(`保存失败：${String(result.error ?? '未知错误')}`)
        }
      } catch (error) {
        // v1.2.9 发布加固：以前只有 finally，RPC 抛错时用户点「保存」毫无反馈。
        showToast(`保存失败：${error instanceof Error ? error.message : String(error)}`)
      } finally { setSaving(false) }
    })()
  }, [title, content, mode, onceLocal, hour, minute, weekdays, popup, im, botId, targetId, item.id, todosApi, showToast, onSaved, onClose])

  // 通用胶囊样式
  const cap = (active) => ({
    padding: '5px 12px', fontSize: 12, borderRadius: 999, cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-bg-layer-1)',
    color: active ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-secondary)',
  })
  const selectMini = {
    padding: '6px 8px', fontSize: 13, borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
  }
  const labelStyle = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 12, marginBottom: 6 }
  // 复选框（应用内/机器人）
  const checkBox = (checked, onClick, label) => h('label', {
    style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13, color: 'var(--dsw-alias-label-primary)' },
    onClick: (e) => { e.preventDefault(); onClick() },
  },
    h('span', {
      style: {
        width: 16, height: 16, borderRadius: 4,
        border: '1px solid var(--dsw-alias-brand-primary, #f59e0b)',
        background: checked ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-1)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 11,
      },
    }, checked ? '\u2713' : ''),
    label)

  return h('div', {
    style: style.popupMask,
    onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() },
  },
  h('div', { style: { ...style.popup, maxWidth: 460 } },
    h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 12 } }, '编辑待办'),
    h('div', { style: style.fieldLabel }, '标题'),
    h('input', { style: style.input, value: title, onChange: (e) => setTitle(e.target.value) }),
    h('div', { style: labelStyle }, '内容'),
    h('textarea', {
      ref: contentRef,
      style: { ...style.textarea, minHeight: 140 },
      value: content,
      onChange: (e) => { setContent(e.target.value); autoGrow(e.target) },
    }),

    // 提醒时间
    h('div', { style: labelStyle }, '提醒时间'),
    // 快捷胶囊
    h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 } },
      h('button', { type: 'button', style: style.quickChip, onClick: () => quickOnce(Date.now() + 3600_000) }, '1小时后'),
      h('button', { type: 'button', style: style.quickChip, onClick: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); quickOnce(d.getTime()) } }, '明天9:00'),
      h('button', { type: 'button', style: style.quickChip, onClick: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(17, 0, 0, 0); quickOnce(d.getTime()) } }, '明天17:00'),
    ),
    // 模式切换
    h('div', { style: { display: 'flex', gap: 6, marginBottom: 8 } },
      [['once', '单次'], ['daily', '每天'], ['weekly', '每周']].map(([k, l]) =>
        h('button', { type: 'button', key: k, onClick: () => setMode(k), style: cap(mode === k) }, l)),
    ),
    // 单次：分段式日期 + ±步进按钮（v1.3.0 反馈①：点哪段 + 就加哪段，组件内置 ±，逻辑同 TodoPopup）
    mode === 'once'
      ? h('div', null,
        h(SegmentDueInput, {
          value: onceLocal,
          onChange: (next) => { onceLocalRef.current = next; setOnceLocal(next) },
          inputStyle: { fontSize: 13, padding: '8px 10px' },
        }),
        onceLocal.length === 0 ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginTop: 6 } }, '未设置提醒时间——点快捷胶囊或 ± 按钮开始设置') : null,
      )
      : null,
    // 每天/每周：时间
    mode !== 'once' ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
      h('select', { value: hour, onChange: (e) => setHour(Number(e.target.value)), style: selectMini },
        Array.from({ length: 24 }, (_, i) => h('option', { key: i, value: i }, String(i).padStart(2, '0')))),
      h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, ':'),
      h('select', { value: minute, onChange: (e) => setMinute(Number(e.target.value)), style: selectMini },
        Array.from({ length: 60 }, (_, i) => h('option', { key: i, value: i }, String(i).padStart(2, '0')))),
    ) : null,
    // 每周：星期
    mode === 'weekly' ? h('div', { style: { display: 'flex', gap: 4, marginTop: 8 } },
      [['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['日', 0]].map(([l, val]) => {
        const sel = weekdays.includes(val)
        return h('button', {
          type: 'button', key: val,
          onClick: () => setWeekdays((p) => sel ? p.filter((d) => d !== val) : [...p, val]),
          style: {
            minWidth: 30, height: 28, fontSize: 12, borderRadius: 8, cursor: 'pointer',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: sel ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-bg-layer-1)',
            color: sel ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-secondary)',
          },
        }, l)
      })) : null,

    // 通知方式（扁平多选）
    h('div', { style: labelStyle }, '通知方式'),
    h('div', { style: { display: 'flex', gap: 18 } },
      checkBox(popup, () => setPopup((v) => !v), '应用内弹窗'),
      checkBox(im, () => setIm((v) => !v), '机器人推送'),
    ),
    // v1.1 勾选机器人时：选择具体机器人（企业微信/QQ/微信等）与目标
    im ? h('div', { style: { display: 'flex', gap: 6, marginTop: 8 } },
      h('select', {
        value: botId,
        onChange: (e) => { setBotId(e.target.value); setTargetId('') },
        style: { ...selectMini, flex: 1 },
      },
        h('option', { value: '' }, '全部机器人（跟随全局）'),
        imBots.map((b) => h('option', { key: b.botId, value: b.botId }, imBotLabel(b))),
      ),
      h('select', {
        value: targetId,
        onChange: (e) => setTargetId(e.target.value),
        style: { ...selectMini, flex: 1 },
      },
        h('option', { value: '' }, '默认目标（第一个）'),
        (imBots.find((b) => b.botId === botId)?.targets ?? []).map((t) =>
          h('option', { key: t.targetId, value: t.targetId }, t.name ? `${t.name} · ${t.targetId}` : t.targetId)),
      ),
    ) : null,
    h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginTop: 6 } },
      popup && im ? '到点将同时应用内弹窗 + 机器人推送' : (!popup && !im ? '到点不提醒（仅在列表中显示）' : '')),

    item.handedToTasks ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginTop: 6 } }, '该待办已转为定时任务，由 dsh-tasks 周期执行') : null,
    // 底部按钮
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 } },
      h('button', {
        type: 'button',
        style: { ...style.ghostButton, color: 'var(--dsw-alias-brand-primary)', borderColor: 'var(--dsw-alias-brand-primary)' },
        onClick: () => onConvert?.(item),
      }, '⟳ 转定时任务'),
      h('div', { style: { display: 'flex', gap: 8 } },
        h('button', { type: 'button', style: style.ghostButton, onClick: onClose }, '取消'),
        h('button', { type: 'button', style: style.miniButton, onClick: save, disabled: saving }, saving ? '保存中…' : '保存'),
      ),
    ),
  ))
}

/** 转定时任务弹窗（v1.0 对齐 dsh-tasks cron 编辑）：快捷模板 + 每小�?每天/每周/自定�?+ 工作�?+ 下次执行预览�?*/
function ConvertToTaskDialog({ item, todosApi, defaultWorkspaceId, onClose, onConverted, showToast }) {
  const init = (() => {
    if (item.dueAt) {
      const d = new Date(item.dueAt)
      if (!Number.isNaN(d.getTime())) return { hour: d.getHours(), minute: d.getMinutes(), day: d.getDay() }
    }
    return { hour: 9, minute: 0, day: 1 }
  })()
  const [recurType, setRecurType] = useState('daily') // hourly | daily | weekly | custom
  const [hourlyMode, setHourlyMode] = useState('ontime') // ontime（整点）| interval（每 N 分钟）
  const [intervalN, setIntervalN] = useState(30)
  const [topMinute, setTopMinute] = useState(0)
  const [hour, setHour] = useState(init.hour)
  const [minute, setMinute] = useState(init.minute)
  const [weekdays, setWeekdays] = useState([init.day])
  const [customCron, setCustomCron] = useState('')
  const [workspaceId, setWorkspaceId] = useState('')
  const [workspaces, setWorkspaces] = useState([])
  const [fires, setFires] = useState([])
  const [busy, setBusy] = useState(false)
  // v1.2.9 发布加固：dsh-tasks 是可选依赖（HTTP 端点）。探测不到时给可读提示，
  // 而不是让用户面对「转换失败：未知错误」。
  const [tasksApiReady, setTasksApiReady] = useState(null) // null=探测中 true=可用 false=未安装

  useEffect(() => {
    let cancelled = false
    fetch('/dsh-tasks/api/workspaces')
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return await r.json()
      })
      .then((p) => {
        if (cancelled) return
        setTasksApiReady(true)
        const ws = p.workspaces ?? []
        setWorkspaces(ws)
        if (defaultWorkspaceId && ws.some((w) => w.id === defaultWorkspaceId)) setWorkspaceId(defaultWorkspaceId)
      })
      .catch((error) => {
        if (cancelled) return
        setTasksApiReady(false)
        console.warn('[dsh-todo] 未检测到「定时任务」插件（dsh-tasks）HTTP 端点：', error)
      })
    return () => { cancelled = true }
  }, [defaultWorkspaceId])

  const buildCron = () => {
    if (recurType === 'custom') return customCron.trim()
    if (recurType === 'hourly') {
      if (hourlyMode === 'interval') return `*/${intervalN} * * * *`
      return `${String(topMinute).padStart(2, '0')} * * * *`
    }
    const m = String(minute).padStart(2, '0')
    const h = String(hour).padStart(2, '0')
    if (recurType === 'daily') return `${m} ${h} * * *`
    if (recurType === 'weekly') {
      const days = weekdays.length > 0 ? [...weekdays].sort((a, b) => a - b).join(',') : '1'
      return `${m} ${h} * * ${days}`
    }
    return ''
  }

  // 下次执行预览（宿�?croner 计算�
  useEffect(() => {
    const cron = buildCron()
    if (!cron) { setFires([]); return undefined }
    let cancelled = false
    const timer = setTimeout(() => {
      fetch(`/dsh-tasks/api/next?cron=${encodeURIComponent(cron)}`)
        .then((r) => (r.ok ? r.json() : { fires: [] }))
        .then((p) => { if (!cancelled) setFires(p.fires ?? []) })
        .catch(() => { })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recurType, hourlyMode, intervalN, topMinute, hour, minute, weekdays, customCron])

  // 快捷模板
  const presets = [
    { label: '每小时整点', apply: () => { setRecurType('hourly'); setHourlyMode('ontime'); setTopMinute(0) } },
    { label: '每30分钟', apply: () => { setRecurType('hourly'); setHourlyMode('interval'); setIntervalN(30) } },
    { label: '每天9:00', apply: () => { setRecurType('daily'); setHour(9); setMinute(0) } },
    { label: '工作日8:30', apply: () => { setRecurType('weekly'); setWeekdays([1, 2, 3, 4, 5]); setHour(8); setMinute(30) } },
    { label: '每周一10:00', apply: () => { setRecurType('weekly'); setWeekdays([1]); setHour(10); setMinute(0) } },
  ]

  // 人类可读描述
  const describe = () => {
    if (recurType === 'custom') return `自定义：${customCron || '（填写 cron 表达式）'}`
    if (recurType === 'hourly') return hourlyMode === 'interval' ? `每 ${intervalN} 分钟执行一次` : '每小时整点执行'
    const t = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    if (recurType === 'daily') return `每天 ${t} 执行`
    const dayLabels = ['日', '一', '二', '三', '四', '五', '六']
    const isWorkday = weekdays.length === 5 && [1, 2, 3, 4, 5].every((d) => weekdays.includes(d))
    if (isWorkday) return `工作日 ${t} 执行`
    const ws = [...weekdays].sort((a, b) => a - b).map((d) => dayLabels[d]).join('、')
    return `每周${ws} ${t} 执行`
  }

  const confirm = useCallback(() => {
    const cron = buildCron()
    if (!cron) { showToast('请完成定时设置'); return }
    // v1.4.0 通用化：自装 dsh-tasks（HTTP）优先，官方 dsh-schedule 兜底
    const fallbackToSchedule = async () => {
      try {
        const res = await todosApi.convertToSchedule({
          sessionId: item.sessionId ?? '',
          title: item.title,
          prompt: item.content ?? item.title,
          cron: { expression: cron, time_zone: 'Asia/Shanghai' },
        })
        if (res && res.ok) {
          await todosApi.update({ id: item.id, handedToTasks: true })
          try { window.dispatchEvent(new Event('dsh-todo:changed')) } catch { }
          showToast('已转为定时任务（官方「自动化任务」）')
          onConverted?.()
          onClose()
        } else {
          showToast(`转换失败：${res?.error ?? '官方定时服务不可用'}`)
        }
      } catch (e) {
        showToast(`转换失败：${e?.message ?? e}`)
      }
    }
    void (async () => {
      setBusy(true)
      try {
        // 主路径：自装 dsh-tasks
        if (tasksApiReady === true) {
          const resp = await fetch('/dsh-tasks/api', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              title: item.title,
              prompt: item.content ?? item.title,
              cron,
              enabled: true,
              ...(workspaceId ? { workspaceId } : {}),
            }),
          })
          if (resp.ok) {
            await todosApi.update({ id: item.id, handedToTasks: true })
            try { window.dispatchEvent(new Event('dsh-todo:changed')) } catch { }
            showToast('已转为定时任务')
            onConverted?.()
            onClose()
            return
          }
          // dsh-tasks 失败（404/5xx）→ 回退官方 schedule
          setTasksApiReady(false)
          await fallbackToSchedule()
          return
        }
        // 未装 dsh-tasks → 直接官方 schedule 兜底
        await fallbackToSchedule()
      } catch (e) {
        showToast(`转换失败：${e?.message ?? e}`)
      } finally { setBusy(false) }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recurType, hourlyMode, intervalN, topMinute, hour, minute, weekdays, customCron, workspaceId, item, todosApi, showToast, onConverted, onClose, tasksApiReady])

  const selectMini = {
    padding: '6px 8px', fontSize: 13, borderRadius: 8,
    border: '1px solid var(--dsw-alias-border-l2)',
    background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
  }
  const cap = (active) => ({
    padding: '5px 12px', fontSize: 12, borderRadius: 999, cursor: 'pointer',
    border: '1px solid var(--dsw-alias-border-l2)',
    background: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-bg-layer-1)',
    color: active ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-secondary)',
  })
  return h('div', {
    style: style.popupMask,
    onMouseDown: (e) => { if (e.target === e.currentTarget) onClose() },
  },
  h('div', { style: { ...style.popup, maxWidth: 470 } },
    h('div', { style: { fontSize: 15, fontWeight: 600, marginBottom: 4 } }, '转为定时任务'),
    h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 12 } }, '到点将自动新建 agent 会话执行该待办'),
    // 快捷模板
    h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 } },
      presets.map((p, i) => h('button', { type: 'button', key: i, style: style.quickChip, onClick: p.apply }, p.label))),
    // 模式切换
    h('div', { style: { display: 'flex', gap: 6, marginBottom: 10 } },
      [['hourly', '每小时'], ['daily', '每天'], ['weekly', '每周'], ['custom', '自定义']].map(([k, label]) =>
        h('button', { type: 'button', key: k, onClick: () => setRecurType(k), style: cap(recurType === k) }, label))),
    // 每小时
    recurType === 'hourly' ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' } },
      h('button', { type: 'button', style: cap(hourlyMode === 'ontime'), onClick: () => setHourlyMode('ontime') }, '每小时整点'),
      h('button', { type: 'button', style: cap(hourlyMode === 'interval'), onClick: () => setHourlyMode('interval') }, '每隔'),
      hourlyMode === 'interval'
        ? h('select', { value: intervalN, onChange: (e) => setIntervalN(Number(e.target.value)), style: selectMini },
          [5, 10, 15, 20, 30].map((n) => h('option', { key: n, value: n }, `${n} 分钟`)))
        : h('select', { value: topMinute, onChange: (e) => setTopMinute(Number(e.target.value)), style: selectMini },
          Array.from({ length: 60 }, (_, i) => h('option', { key: i, value: i }, `${i} 分`))),
    ) : null,
    // 每天/每周：时间
    recurType === 'daily' || recurType === 'weekly' ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 } },
      h('select', { value: hour, onChange: (e) => setHour(Number(e.target.value)), style: selectMini },
        Array.from({ length: 24 }, (_, i) => h('option', { key: i, value: i }, String(i).padStart(2, '0')))),
      h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, ':'),
      h('select', { value: minute, onChange: (e) => setMinute(Number(e.target.value)), style: selectMini },
        Array.from({ length: 60 }, (_, i) => h('option', { key: i, value: i }, String(i).padStart(2, '0')))),
    ) : null,
    // 每周：星期
    recurType === 'weekly' ? h('div', { style: { display: 'flex', gap: 4, marginBottom: 8 } },
      [['一', 1], ['二', 2], ['三', 3], ['四', 4], ['五', 5], ['六', 6], ['日', 0]].map(([label, val]) => {
        const sel = weekdays.includes(val)
        return h('button', {
          type: 'button', key: val, onClick: () => setWeekdays((p) => sel ? p.filter((d) => d !== val) : [...p, val]),
          style: {
            minWidth: 30, height: 28, fontSize: 12, borderRadius: 8, cursor: 'pointer',
            border: '1px solid var(--dsw-alias-border-l2)',
            background: sel ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-bg-layer-1)',
            color: sel ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-secondary)',
          },
        }, label)
      })) : null,
    // 自定义
    recurType === 'custom' ? h('input', {
      style: { width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 13, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', marginBottom: 10 },
      placeholder: '0 9 * * *（每天 9:00）',
      value: customCron, onChange: (e) => setCustomCron(e.target.value),
    }) : null,
    // 描述
    h('div', { style: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', marginBottom: 4 } }, describe()),
    // 下次执行预览
    fires.length > 0 ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginBottom: 4 } },
      '最近执行：' + fires.slice(0, 5).map((f) => String(f).slice(5, 16).replace('T', ' ')).join('  ')) : null,
    // 工作区
    h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 8 } }, '执行工作区'),
    h('select', {
      value: workspaceId, onChange: (e) => setWorkspaceId(e.target.value),
      style: { width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 13, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', margin: '4px 0 12px' },
    },
      h('option', { value: '' }, '不绑定工作区（默认目录）'),
      workspaces.map((w) => h('option', { key: w.id, value: w.id }, w.title)),
    ),
    // v1.2.9 发布加固：未装「定时任务」插件时给出明确指引（原先只会看到「转换失败：未知错误」）
    tasksApiReady === false ? h('div', {
      style: { fontSize: 11, lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)', background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '8px 10px', marginBottom: 10 },
    }, '未检测到「定时任务」插件（dsh-tasks）：本功能需要它来周期执行。请先在插件市场安装并启用，再回到这里转换。') : null,
    h('div', { style: style.popupButtons },
      h('button', { type: 'button', style: style.ghostButton, onClick: onClose }, '取消'),
      h('button', { type: 'button', style: style.miniButton, onClick: confirm, disabled: busy || tasksApiReady === false }, busy ? '提交中…' : '确认转换'),
    ),
  ))
}
//#endregion

const sessionOpenRef = { current: null }
// v1.2.9：modelListRef 随盲猜服务探测块一并删除（无消费方）。

function registerTodoUi(ctx, slots, todos, sidebarEnabled = true) {
  // 真实 RPC 为双 envelope：传输层 {ok, value} + 服务�?{ok, value/items}�
  // unwrap 归一化为服务层结果，组件只处理一层�
  const unwrap = async (call) => {
    const wire = await call
    if (wire.ok && wire.value !== undefined) return wire.value
    return { ok: false, error: wire.error ?? 'RPC 调用失败' }
  }
  const todosApi = {
    list: (request) => unwrap(todos.list(request)),
    add: (request) => unwrap(todos.add(request)),
    aiCapture: (request) => unwrap(todos.aiCapture(request)),
    createFollowup: (request) => unwrap(todos.createFollowup(request)),
    setAiModel: (request) => unwrap(todos.setAiModel(request)),
    setStatus: (request) => unwrap(todos.setStatus(request)),
    abandon: (request) => unwrap(todos.abandon(request)),
    defer: (request) => unwrap(todos.defer(request)),
    update: (request) => unwrap(todos.update(request)),
    reminderHandled: (request) => unwrap(todos.reminderHandled(request)),
    saveNotifyConfig: (request) => unwrap(todos.saveNotifyConfig(request)),
    deleteTodo: (request) => unwrap(todos.deleteTodo(request)),
    clearCompleted: (request) => unwrap(todos.clearCompleted(request)),
    markSeen: (request) => unwrap(todos.markSeen(request)),
    listModels: (request) => unwrap(todos.listModels(request)),
    // v1.1.4 修复：settings 页机器人下拉数据源（此前漏定�?�?TypeError �?catch �?�?永远只有「全部机器人」）
    listImBots: (request) => unwrap(todos.listImBots(request)),
    // v1.1.6 反馈⑤：行内「�?�?AI 总结」——对已有待办重新�?AI 结构化并替换本条
    aiSummarizeItem: (request) => unwrap(todos.aiSummarizeItem(request)),
    convertToSchedule: (request) => unwrap(todos.convertToSchedule(request)),
  }
  // v0.9.8 工作区与新建会话（反馈③⑤）
  /** 读取工作区列表：[{id,title,sessionIds}]�?*/
  const listWorkspaceInfo = () => {
    try {
      const ui = ctx.get('uiWorkspace')
      const items = ui?.workspaces?.list?.getSnapshot?.()?.items ?? []
      return items.map((w) => ({
        id: w.workspaceId,
        title: w.title ?? w.path ?? '工作区',
        sessionIds: Array.isArray(w.sessionIds) ? w.sessionIds : [],
      }))
    } catch (e) { console.warn('[dsh-todo] listWorkspaceInfo failed:', e); return [] }
  }
  /** 根据会话 ID 反查所属工作区�?*/
  const workspaceOfSession = (sessionId, workspaces = listWorkspaceInfo()) => {
    if (!sessionId) return undefined
    return workspaces.find((w) => w.sessionIds.includes(sessionId))
  }
  /**
   * 反馈⑤：以某待办为蓝本，在同一工作区新建会话�?   * 输入框预填待办内容，会话名设为待办标题。返回新会话 ID�?   */
  const createFollowupSession = async ({ sourceSessionId, title, content, todoId }) => {
    const ui = ctx.get('uiWorkspace')
    if (typeof todosApi.createFollowup !== 'function') throw new Error('新建会话服务不可用')
    // v1.2.1 排障：链路打点，F12 �?__DSH_TODO_FOLLOWUP_TRACE__
    const trace = { at: new Date().toISOString(), hasUi: !!ui, hasOpenSession: typeof ui?.openSession === 'function' }
    try { window.__DSH_TODO_FOLLOWUP_TRACE__ = trace } catch { }
    // �?工作区跟随（划词时所在工作区）：以源会话反查工作�
    const owner = workspaceOfSession(sourceSessionId)
    trace.ownerFound = !!owner?.id
    // 标题兜底：item.title 一般已非空（宿主标题可选已派生），缺失时取内容首行
    const finalTitle = (title && title.trim()) || (content && content.trim().split('\n')[0].slice(0, 30)) || '未命名待办'
    // �?宿主建会话（工作区跟随、挂默认工具、模�?待办设置偏好�? 固定标题；经 unwrap 归一�
    // v1.1.7：传 todoId——新会话发出首条消息后宿主自动把该待办标�?completed
    // v1.2.1：网�?boundary validation 报错=宿主注册的旧 schema 不认识新字段（插件更新后未重启），给人话提示
    let res
    try {
      res = await todosApi.createFollowup({
        ...(owner?.id ? { workspaceId: owner.id } : {}),
        ...(sourceSessionId ? { sourceSessionId } : {}),
        title: finalTitle,
        ...(todoId ? { todoId } : {}),
      })
    } catch (e) {
      const msg = String(e?.message ?? e)
      if (msg.includes('boundary validation') || msg.includes('typert gateway')) {
        trace.rpcError = msg + ' | hint=宿主与页面版本不一致（插件更新后未重启）'
        try { window.__DSH_TODO_FOLLOWUP_TRACE__ = trace } catch { }
        throw new Error('插件刚更新过：请重启 DSH 桌面端后重试')
      }
      throw e
    }
    trace.rpcOk = res?.ok === true
    if (!res?.ok) trace.rpcError = res?.error ?? 'empty response'
    if (!res || res.ok !== true || !res.value?.sessionId) throw new Error(res?.error || '创建会话失败')
    const newId = res.value.sessionId
    trace.newSessionId = newId
    // �?打开前预填草稿：�?per-session 持久化，会话组件挂载时读取（输入框预填）
    try {
      window.localStorage.setItem(
        `dsh.conversation.${newId}`,
        JSON.stringify({ draft: content ?? '', view: null, viewRequest: null })
      )
    } catch (e) { console.warn('[dsh-todo] prefill draft failed:', e) }
    // ③�?v1.2.5 修复"点击没反�?：不等归属同步——先写草稿、立即打开会话（跳转即时可见）�
    // 归属同步是响应式快照，宿�?attach 完成�?hero 自动�?选择工作�?变为工作区名�
    // 此前 6 秒阻塞轮询让用户以为点击无效（设置页�?侧栏双击同感）�
    // �?打开新会话（retain 可能�?renderer 会话列表未同步抛错—�?catch 后重试一次）
    if (ui && typeof ui.openSession === 'function') {
      try {
        ui.openSession(newId)
        trace.openSessionCalled = true
      } catch (e) {
        trace.openSessionError = String(e?.message ?? e)
        console.warn('[dsh-todo] openSession first attempt failed, retry after 600ms:', e)
        await new Promise((r) => setTimeout(r, 600))
        try { ui.openSession(newId); trace.openSessionRetryOk = true } catch (e2) { trace.openSessionRetryError = String(e2?.message ?? e2) }
      }
    } else {
      trace.openSessionSkipped = true
    }
    try { window.__DSH_TODO_FOLLOWUP_TRACE__ = trace } catch { }
    return newId
  }
  try {
    slots.onEntryError?.((key, entry, cause) => {
      window.__DSH_TODO_ENTRY_ERROR__ = ('slot=' + String(key) + ' cause=' + String(cause?.stack ?? cause)).slice(0, 4000)
    })
  } catch { }
  // v1.2.9 发布加固：删除了 v0.6.0 起就未启用的 dock 槽位注册及其组件（TodoDock）。
  // 保留原因仅是「将来可能再启用」，代价是 330 行死代码 + 每次渲染的全树校验；需要时可按
  // cost-meter 的 conversation.input.dock 写法重新实现。
  // v0.5：左侧侧栏常驻面板（cost-meter「花费」同槽位），会话外也可见
  // v1.2.2 反馈⑤：设置页可关闭左侧栏显示（sidebarEnabled=false 时不注册本槽；一次性注册，变更后需重启生效）�
  if (sidebarEnabled !== false) {
    slots.inject('sidebar.footer.action', () => slots.register({
      name: 'sidebar.footer.action',
      id: 'dsh-todo-sidebar',
      order: 0,
    }, (props) => h(TodoSidebar, { ...props, todosApi, sessionOpen: sessionOpenRef.current, createFollowupSession })))
  } else {
    console.warn('[dsh-todo] sidebar.footer.action skipped: sidebarEnabled=false（设置页已关闭左侧栏显示）')
  }
  // v0.9.3：DSH 全局设置页面（settings.section），参考 dsh-tasks
  try {
    slots.inject('settings.section', () => slots.register({
      name: 'settings.section',
      id: 'dsh-todo-settings',
      order: 50,
      label: () => '待办清单',
    }, (slotProps) => h(TodoSettingsPage, {
      todosApi,
      closeSettings: slotProps?.close,
      sessionOpen: sessionOpenRef.current,
      listWorkspaceInfo,
      workspaceOfSession,
      createFollowupSession,
    })))
  } catch (error) {
    console.warn('[dsh-todo] settings.section registration failed:', error)
  }
}

export const inject = ['remote']

export async function apply(ctx) {
  try {
    await applyInner(ctx)
  } catch (error) {
    // 崩溃日志�?web-boot 记录只含「entry failed」不含原因；
    // 在此把真实错误打�?renderer console �?window 全局以便排障�
    window.__DSH_TODO_BOOT_ERROR__ = String(error?.stack ?? error)
    console.error('[dsh-todo] client apply failed:', error)
    throw error
  }
}

async function applyInner(ctx) {
  // 守卫出口全部带打点（v0.4.0 静默 return 导致 UI 消失无法排障——教训）�
  const remoteHost = ctx.remote
  if (remoteHost === undefined || typeof remoteHost.$mount !== 'function') {
      console.warn('[dsh-todo] UI skipped: ctx.remote 不存在或无 $mount（remote 服务未就绪）'); try { window.localStorage.setItem('dsh-todo:last-guard', 'ctx.remote 不存在或无 $mount（remote 服务未就绪）') } catch { }; return
  }
  // 发布加固：$mount 失败不再冒泡（以前会变成「entry failed」且整块 UI 不加载、日志无原因）。
  // 降级策略：记录真实原因 + 留下 localStorage 打点，宿主侧工具与数据能力继续可用。
  let disposeRemote
  try {
    disposeRemote = await remoteHost.$mount(TYPERT_REMOTE)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error('[dsh-todo] remote.$mount 失败，UI 未挂载（宿主侧待办能力仍可用）：', error)
    try { window.localStorage.setItem('dsh-todo:last-guard', `remote.$mount 失败：${reason}`) } catch { }
    return
  }
  ctx.effect(() => () => {
    if (typeof disposeRemote === 'function') {
      try { disposeRemote() } catch { }
    }
  }, 'dsh-todo: remote contribution')

  const todos = ctx.get('remote.todos')
  if (todos === undefined) {
    console.warn('[dsh-todo] UI skipped: remote.todos 未挂载（$mount 后命名空间缺失）'); try { window.localStorage.setItem('dsh-todo:last-guard', 'remote.todos 未挂载（$mount 后命名空间缺失）') } catch {} ; return
  }
  const slots = ctx.get('slots')
  if (slots === undefined) {
    console.warn('[dsh-todo] UI skipped: slots 服务未就绪（检查 dsh.client.inject 声明）'); try { window.localStorage.setItem('dsh-todo:last-guard', 'slots 服务未就绪（检查 dsh.client.inject 声明）') } catch { } ; return
  }
  // v0.9.7 会话导航（复�?dsh-archive-manager）：uiWorkspace.openSession，归档则先恢�
  try {
    const uiWorkspace = ctx.get('uiWorkspace')
    const sessions = ctx.get('sessions')
    if (uiWorkspace) {
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(uiWorkspace)).filter((m) => typeof uiWorkspace[m] === 'function')
      console.log('[dsh-todo] uiWorkspace methods:', methods)
    } else {
      console.log('[dsh-todo] uiWorkspace service not found')
    }
    /** 打开来源会话；若已归档，先经 remote.workspaceRegistry 恢复再打开�?*/
    sessionOpenRef.current = async (sessionId, locator) => {
      if (!sessionId) throw new Error('缺少会话 ID')
      const ui = ctx.get('uiWorkspace')
      const ss = ctx.get('sessions')
      const directOpen = async () => {
        if (ui && typeof ui.openSession === 'function') { await ui.openSession(sessionId); return true }
        if (ss && typeof ss.open === 'function') { await ss.open(sessionId); return true }
        return false
      }
      let opened = false
      // �?直接打开
      try {
        if (await directOpen()) { console.log('[dsh-todo] session opened directly'); opened = true }
      } catch (error) {
        console.warn('[dsh-todo] direct open failed, session may be archived:', error)
      }
      // �?归档恢复：remote.workspaceRegistry.restoreSession
      if (!opened) {
        const registry = ctx.get('remote.workspaceRegistry')
        if (registry && typeof registry.restoreSession === 'function') {
          console.log('[dsh-todo] restoring archived session:', sessionId)
          const res = await registry.restoreSession({ sessionId })
          if (res && res.ok !== false) {
            if (await directOpen()) { console.log('[dsh-todo] session restored and opened'); opened = true }
          }
        }
      }
      if (!opened) throw new Error('会话不存在、已归档且无法自动恢复，请在归档会话页手动恢复')
      // �?v0.9.7 消息级定位：等待会话异步渲染，滚动到划词段落并高�
      if (locator && (locator.messageId || locator.anchorText)) {
        console.log('[dsh-todo] revealing locator:', locator)
        const hit = await waitAndReveal(locator)
        console.log('[dsh-todo] locator reveal result:', hit)
      }
    }
    console.log('[dsh-todo] session navigation ready (uiWorkspace)')
  } catch (error) {
    console.warn('[dsh-todo] sessionOpen capture failed:', error)
  }
  // v1.2.9 发布加固：删除了 v0.9.5 的「盲猜宿主模型服务」探测块（models/modelCatalog/… ×
  // list/getModels/… 逐个 ctx.get + await）。结果只写进无人消费的 modelListRef，却在启动路径上
  // 调用未知服务的方法，属于不必要的风险面；模型列表现在由宿主 listModels RPC 提供。
  // v1.2.2 反馈⑤：读取左侧栏开关（false 才下发 = 用户关闭；失败按默认显示处理，不阻断 UI）
  let sidebarEnabled = true
  try {
    const listResult = await todos.list({})
    if (listResult?.ok === true && listResult.value?.sidebarEnabled === false) sidebarEnabled = false
  } catch (e) { console.warn('[dsh-todo] read sidebarEnabled failed:', e) }
  registerTodoUi(ctx, slots, todos, sidebarEnabled)

  // v0.7.0：全局划词气泡组件，独立于槽位渲染，直接挂载到 body
  const unwrapGlobal = async (call) => {
    const wire = await call
    if (wire.ok && wire.value !== undefined) return wire.value
    return { ok: false, error: wire.error ?? 'RPC 调用失败' }
  }
  const globalTodosApi = {
    list: (request) => unwrapGlobal(todos.list(request)),
    add: (request) => unwrapGlobal(todos.add(request)),
    aiCapture: (request) => unwrapGlobal(todos.aiCapture(request)),
    setAiModel: (request) => unwrapGlobal(todos.setAiModel(request)),
    setStatus: (request) => unwrapGlobal(todos.setStatus(request)),
    abandon: (request) => unwrapGlobal(todos.abandon(request)),
    defer: (request) => unwrapGlobal(todos.defer(request)),
    update: (request) => unwrapGlobal(todos.update(request)),
    reminderHandled: (request) => unwrapGlobal(todos.reminderHandled(request)),
    saveNotifyConfig: (request) => unwrapGlobal(todos.saveNotifyConfig(request)),
    deleteTodo: (request) => unwrapGlobal(todos.deleteTodo(request)),
    clearCompleted: (request) => unwrapGlobal(todos.clearCompleted(request)),
    markSeen: (request) => unwrapGlobal(todos.markSeen(request)),
    // v1.1.4 修复：同 todosApi，补�?listImBots（划词气泡弹窗路径的机器人下拉）
    listImBots: (request) => unwrapGlobal(todos.listImBots(request)),
    // v1.1.6 反馈⑤：�?todosApi，补�?aiSummarizeItem
    aiSummarizeItem: (request) => unwrapGlobal(todos.aiSummarizeItem(request)),
    convertToSchedule: (request) => unwrapGlobal(todos.convertToSchedule(request)),
  }
  // 发布加固：全局根幂等——重复 apply（插件重启/热重载）时先摘掉旧根，避免叠加第二个根与双份轮询。
  const GLOBAL_ROOT_ID = 'dsh-todo-global-root'
  const staleRoot = document.getElementById(GLOBAL_ROOT_ID)
  if (staleRoot !== null) {
    try { staleRoot.remove() } catch { }
  }
  const globalContainer = document.createElement('div')
  globalContainer.id = GLOBAL_ROOT_ID
  document.body.appendChild(globalContainer)
  // v0.9.7 获取当前主视图会�?ID（复�?archive-manager mainViewSessionId）：
  // �?sessions.list snapshot �?byId 中找 retainedBy.mainView>0 的会话�
  const getCurrentSessionId = () => {
    try {
      const ss = ctx.get('sessions')
      const snap = ss?.list?.getSnapshot?.()
      if (snap?.byId) {
        for (const summary of Object.values(snap.byId)) {
          if (summary && (summary.retainedBy?.mainView ?? 0) > 0) return summary.id
        }
      }
      return undefined
    } catch { return undefined }
  }
  // v0.9.9：全局应用内提醒「查看」需要会话跳转
  // v1.2.8 修复②：此前直接 ui.openSession(id, opts)——官方 openSession 不认 locator，
  // 所以提醒弹窗点「查看」只切会话、不做定位高亮（用户反馈：能跳转但没高亮）。
  // 改为复用 sessionOpenRef（同一实现：归档自动恢复 + waitAndReveal 轮询定位 + 琥珀高亮）。
  const globalOpenSession = (id, opts) => {
    const locator = (opts && (opts.messageId || opts.anchorText))
      ? {
        ...(opts.messageId ? { messageId: opts.messageId } : {}),
        ...(opts.anchorText ? { anchorText: opts.anchorText } : {}),
      }
      : undefined
    if (typeof sessionOpenRef.current === 'function') return sessionOpenRef.current(id, locator)
    const ui = ctx.get('uiWorkspace')
    return ui?.openSession(id)
  }
  const globalRoot = createRoot(globalContainer)
  globalRoot.render(h(TodoErrorBoundary, null,
    h(GlobalSelectionBubble, { todosApi: globalTodosApi, getCurrentSessionId }),
    h(GlobalReminderPopup, { todosApi: globalTodosApi, openSession: globalOpenSession }),
  ))
  ctx.effect(() => () => {
    try { globalRoot.unmount() } catch { }
    try { globalContainer.remove() } catch { }
    console.log('[dsh-todo] GlobalSelectionBubble unmounted via ctx.effect')
  }, 'dsh-todo: global-selection-bubble')

  try { window.localStorage.setItem('dsh-todo:last-guard', 'registered') } catch {}
  console.log('[dsh-todo] UI registered (sidebar + global selection bubble v0.7.0)')
}
//#endregion
