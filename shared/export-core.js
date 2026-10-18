/**
 * dsh-todo 导出模块（纯函数 · 无第三方依赖 · 由 esbuild 内联进 lib/client.js）。
 *
 * 需求（v1.5.0）：「把所有记录导出成不同格式，给人看的和给 AI 看的，可自选」。
 *
 * 格式分工：
 *   给人看 → HTML（单文件、可离线双击打开、可打印成 PDF）
 *            Markdown（任何笔记软件都能读）
 *            Excel .xlsx（可直接筛选排序，非程序员最熟）
 *   给 AI 看 → Markdown、CSV、JSON（完整字段，可直接贴进对话当上下文）
 *
 * 为什么手写 .xlsx 而不引第三方库：
 *   .xlsx 本质就是一个 ZIP 包着几个 XML。这里用 store（不压缩）方式自建 ZIP，
 *   零运行时依赖。插件 client 侧只允许 react / react-dom 两个裸导入，其余一律要
 *   内联进 lib/client.js —— 引一个 Excel 库会把产物撑大十几倍。
 */

//#region 常量
const STATUS_LABEL = { pending: '未完成', completed: '已完成', abandoned: '已放弃' }
const SOURCE_LABEL = { selection: '划词', chat: '对话', model: '对话', manual: '手动', ai: 'AI' }
const WEEKDAY_LABEL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

/** 可选导出格式（顺序即 UI 展示顺序） */
export const EXPORT_FORMATS = [
  {
    id: 'html',
    label: 'HTML 网页',
    ext: 'html',
    hint: '单个网页文件，双击就能在浏览器打开，也能直接打印成 PDF',
  },
  {
    id: 'md',
    label: 'Markdown',
    ext: 'md',
    hint: '纯文本带标题和勾选框，可粘进笔记软件，也可整段贴给 AI',
  },
  {
    id: 'xlsx',
    label: 'Excel 表格',
    ext: 'xlsx',
    hint: '真正的 .xlsx，可用 Excel / WPS 打开，能筛选和排序',
  },
  {
    id: 'csv',
    label: 'CSV 表格',
    ext: 'csv',
    hint: '通用的表格纯文本，任何工具都能读，适合喂给 AI',
  },
  {
    id: 'json',
    label: 'JSON 数据',
    ext: 'json',
    hint: '完整字段的结构化数据，字段最全，适合程序或 AI 精确解析',
  },
]

/**
 * 可选导出范围。可多选，多条之间取并集；一条都不选 = 全部记录。
 * 「未完成」已经包含逾期的条目，「逾期」是它的子集，两个都选不会重复。
 */
export const EXPORT_SCOPES = [
  { id: 'pending', label: '未完成', hint: '还没做完的（含逾期）' },
  { id: 'overdue', label: '逾期', hint: '未完成且已过提醒时间' },
  { id: 'done', label: '已完成', hint: '已勾选完成的' },
  { id: 'abandoned', label: '已放弃', hint: '主动放弃的条目' },
]

const SCOPE_IDS = EXPORT_SCOPES.map((scope) => scope.id)
//#endregion

//#region 时间与文本工具
const pad2 = (value) => String(value).padStart(2, '0')

/** 毫秒 → `YYYY-MM-DD HH:mm`（本地时区；无效值返回空串） */
export function formatDateTime(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return ''
  const d = new Date(n)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 毫秒 → `YYYY-MM-DD` */
export function formatDate(ms) {
  const text = formatDateTime(ms)
  return text === '' ? '' : text.slice(0, 10)
}

/** 提醒时间：优先毫秒，回落用户原始文本 */
export function dueTextOf(item) {
  const ms = Number(item?.dueAtMs)
  if (Number.isFinite(ms) && ms > 0) return formatDateTime(ms)
  const raw = item?.dueAt
  return typeof raw === 'string' ? raw.trim() : ''
}

/** 未完成且提醒时间早于 now */
export function isOverdueItem(item, now = Date.now()) {
  if (!item || item.status !== 'pending') return false
  const ms = Number(item?.dueAtMs)
  return Number.isFinite(ms) && ms > 0 && ms < now
}

export function statusLabelOf(item) {
  return STATUS_LABEL[item?.status] ?? String(item?.status ?? '')
}

export function sourceLabelOf(item) {
  return SOURCE_LABEL[item?.source] ?? ''
}

/** 文件名安全时间戳 `20261019-0120` */
function stampForName(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}`
}

/** 去掉 XML/HTML 1.0 不允许的控制字符（Excel 会因此报「需要修复」，浏览器会显示方块） */
function stripControlChars(text) {
  return String(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/gu, '')
}

/** 去掉 XML 1.0 不允许的控制字符（Excel 会因此报「需要修复」） */
function xmlSafe(text) {
  return stripControlChars(text)
}

function xmlEscape(text) {
  return xmlSafe(text)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;')
}

function htmlEscape(text) {
  return stripControlChars(text)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
}

/** CSV 单元格：一律加引号，内部引号翻倍 */
function csvCell(value) {
  return `"${String(value ?? '').replace(/"/gu, '""')}"`
}

/** 标记为行内样式高亮用：把裸 URL 变可点（只处理 http/https） */
function linkify(text) {
  return String(text ?? '').replace(
    /\bhttps?:\/\/[^\s<>"）)】]+/gu,
    (url) => `<a href="${htmlEscape(url)}" rel="noreferrer" target="_blank">${htmlEscape(url)}</a>`,
  )
}
//#endregion

//#region 筛选与统计
/**
 * 把一个范围值归一成 id 数组。
 * 兼容三种输入：`undefined`/`'all'`（= 全部）、单个 id 字符串（旧调用方）、id 数组。
 * @returns {string[]} 空数组表示「全部」
 */
export function normalizeScopes(scopes) {
  if (scopes === undefined || scopes === null || scopes === 'all') return []
  const raw = Array.isArray(scopes) ? scopes : [scopes]
  const seen = new Set()
  for (const value of raw) {
    if (value === 'all') return []
    if (typeof value === 'string' && SCOPE_IDS.includes(value)) seen.add(value)
  }
  // 固定按 EXPORT_SCOPES 的顺序输出，保证文件名与文案稳定
  return SCOPE_IDS.filter((id) => seen.has(id))
}

/** 范围标签：没选 = 全部记录，选了多个用「+」连起来 */
export function scopeLabelOf(scopes) {
  const ids = normalizeScopes(scopes)
  if (ids.length === 0) return '全部记录'
  return ids.map((id) => EXPORT_SCOPES.find((s) => s.id === id)?.label ?? id).join(' + ')
}

/** 文件名里的范围段：`all` 或 `pending-overdue` */
export function scopeSlugOf(scopes) {
  const ids = normalizeScopes(scopes)
  return ids.length === 0 ? 'all' : ids.join('-')
}

/**
 * 按范围筛条目（不改变原数组）。多个范围取并集。
 * @param {Array} items
 * @param {string|string[]} scopes 单个 id / id 数组 / 'all' / 省略
 */
export function filterByScope(items, scopes = 'all', now = Date.now()) {
  const list = Array.isArray(items) ? items : []
  const ids = normalizeScopes(scopes)
  if (ids.length === 0) return list.slice()
  const picked = new Set(ids)
  return list.filter((item) => {
    if (!item) return false
    if (picked.has('overdue') && isOverdueItem(item, now)) return true
    if (picked.has('pending') && item.status === 'pending') return true
    if (picked.has('done') && item.status === 'completed') return true
    if (picked.has('abandoned') && item.status === 'abandoned') return true
    return false
  })
}

/** 导出用统计 */
export function summarizeExport(items, now = Date.now()) {
  const list = Array.isArray(items) ? items : []
  const stats = {
    total: list.length,
    pending: 0,
    completed: 0,
    abandoned: 0,
    overdue: 0,
    withDue: 0,
    withAi: 0,
    sources: {},
  }
  for (const item of list) {
    if (!item) continue
    if (item.status === 'completed') stats.completed += 1
    else if (item.status === 'abandoned') stats.abandoned += 1
    else stats.pending += 1
    if (isOverdueItem(item, now)) stats.overdue += 1
    if (dueTextOf(item) !== '') stats.withDue += 1
    if (typeof item.aiSummary === 'string' && item.aiSummary.trim() !== '') stats.withAi += 1
    const source = sourceLabelOf(item)
    if (source !== '') stats.sources[source] = (stats.sources[source] ?? 0) + 1
  }
  return stats
}

/** 排序：未完成在前（逾期最前），同组内按提醒时间/创建时间升序 */
function sortForExport(items, now = Date.now()) {
  const rank = (item) => {
    if (item?.status === 'completed') return 2
    if (item?.status === 'abandoned') return 3
    return isOverdueItem(item, now) ? 0 : 1
  }
  return items.slice().sort((a, b) => {
    const delta = rank(a) - rank(b)
    if (delta !== 0) return delta
    const aDue = Number(a?.dueAtMs)
    const bDue = Number(b?.dueAtMs)
    const aHas = Number.isFinite(aDue) && aDue > 0
    const bHas = Number.isFinite(bDue) && bDue > 0
    if (aHas && bHas && aDue !== bDue) return aDue - bDue
    if (aHas !== bHas) return aHas ? -1 : 1
    return Number(a?.createdAt ?? 0) - Number(b?.createdAt ?? 0)
  })
}
//#endregion

//#region Markdown
export function buildMarkdown(items, meta = {}) {
  const now = Number.isFinite(meta.now) ? meta.now : Date.now()
  const stats = summarizeExport(items, now)
  const sorted = sortForExport(items, now)
  const lines = []

  lines.push('# 待办清单导出')
  lines.push('')
  lines.push(`> 导出时间：${formatDateTime(now)}　·　记录数：${stats.total}　·　未完成 ${stats.pending} / 已完成 ${stats.completed} / 已放弃 ${stats.abandoned}　·　逾期 ${stats.overdue}`)
  if (typeof meta.scopeLabel === 'string' && meta.scopeLabel !== '') lines.push(`> 导出范围：${meta.scopeLabel}`)
  lines.push('')
  lines.push('## 统计')
  lines.push('')
  lines.push('| 指标 | 数量 |')
  lines.push('| --- | ---: |')
  lines.push(`| 记录总数 | ${stats.total} |`)
  lines.push(`| 未完成 | ${stats.pending} |`)
  lines.push(`| 已完成 | ${stats.completed} |`)
  lines.push(`| 已放弃 | ${stats.abandoned} |`)
  lines.push(`| 逾期 | ${stats.overdue} |`)
  lines.push(`| 设了提醒 | ${stats.withDue} |`)
  lines.push(`| 有 AI 总结 | ${stats.withAi} |`)
  lines.push('')

  const groups = [
    { key: 'pending', title: `未完成（${stats.pending}）`, mark: ' ' },
    { key: 'completed', title: `已完成（${stats.completed}）`, mark: 'x' },
    { key: 'abandoned', title: `已放弃（${stats.abandoned}）`, mark: '-' },
  ]

  for (const group of groups) {
    const rows = sorted.filter((item) => {
      if (group.key === 'pending') return item?.status !== 'completed' && item?.status !== 'abandoned'
      return item?.status === group.key
    })
    if (rows.length === 0) continue
    lines.push(`## ${group.title}`)
    lines.push('')
    for (const item of rows) {
      const title = String(item?.title ?? '(无标题)').replace(/\s+/gu, ' ').trim()
      const overdue = isOverdueItem(item, now) ? ' ⚠️ 逾期' : ''
      lines.push(`- [${group.mark}] ${title}${overdue}`)
      const due = dueTextOf(item)
      if (due !== '') lines.push(`  - 提醒：${due}`)
      const source = sourceLabelOf(item)
      if (source !== '') lines.push(`  - 来源：${source}`)
      const created = formatDateTime(item?.createdAt)
      if (created !== '') lines.push(`  - 创建：${created}`)
      const done = formatDateTime(item?.doneAt)
      if (done !== '') lines.push(`  - 完成：${done}`)
      if (item?.recurrence && item.recurrence.type) {
        const rec = item.recurrence
        const when = rec.type === 'weekly' && Array.isArray(rec.weekdays) && rec.weekdays.length > 0
          ? `每${rec.weekdays.map((d) => WEEKDAY_LABEL[d] ?? `周${d}`).join('、')}`
          : '每天'
        lines.push(`  - 重复：${when} ${pad2(rec.hour ?? 0)}:${pad2(rec.minute ?? 0)}`)
      }
      const content = typeof item?.content === 'string' ? item.content.trim() : ''
      if (content !== '' && content !== title) {
        lines.push('  - 内容：')
        for (const row of content.split(/\r?\n/u)) lines.push(`    ${row}`)
      }
      const ai = typeof item?.aiSummary === 'string' ? item.aiSummary.trim() : ''
      if (ai !== '') lines.push(`  - AI 总结：${ai.replace(/\r?\n/gu, ' ')}`)
      const reason = typeof item?.abandonReason === 'string' ? item.abandonReason.trim() : ''
      if (reason !== '') lines.push(`  - 放弃原因：${reason}`)
      if (typeof item?.sessionId === 'string' && item.sessionId !== '') lines.push(`  - 会话：${item.sessionId}`)
      if (typeof item?.id === 'string' && item.id !== '') lines.push(`  - ID：${item.id}`)
    }
    lines.push('')
  }

  if (stats.total === 0) {
    lines.push('_（本次导出范围内没有记录）_')
    lines.push('')
  }
  lines.push('---')
  lines.push('')
  lines.push(`由 DSH 待办清单插件导出${typeof meta.appVersion === 'string' && meta.appVersion !== '' ? ` v${meta.appVersion}` : ''}。`)
  lines.push('')
  return lines.join('\n')
}
//#endregion

//#region HTML
const HTML_STYLE = `
:root{--fg:#1f2328;--muted:#656d76;--line:#d8dee4;--bg:#ffffff;--soft:#f6f8fa;--brand:#f59e0b;--danger:#cf222e;--ok:#1a7f37}
@media (prefers-color-scheme: dark){
  :root{--fg:#e6edf3;--muted:#9198a1;--line:#30363d;--bg:#0d1117;--soft:#161b22;--brand:#f0b429;--danger:#ff7b72;--ok:#3fb950}
}
*{box-sizing:border-box}
body{margin:0;padding:32px 20px 64px;background:var(--bg);color:var(--fg);
  font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei","PingFang SC",sans-serif}
main{max-width:1080px;margin:0 auto}
h1{font-size:24px;margin:0 0 4px}
.sub{color:var(--muted);font-size:13px;margin:0 0 22px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(126px,1fr));gap:10px;margin-bottom:26px}
.card{border:1px solid var(--line);border-radius:10px;padding:11px 14px;background:var(--soft)}
.card .n{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.2}
.card .k{font-size:12px;color:var(--muted);margin-top:2px}
.card.alert .n{color:var(--danger)}
h2{font-size:16px;margin:26px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{text-align:left;vertical-align:top;padding:8px 10px;border-bottom:1px solid var(--line)}
th{font-size:12px;color:var(--muted);font-weight:600;background:var(--soft);white-space:nowrap}
td.num{white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--muted)}
tr:last-child td{border-bottom:none}
.title{font-weight:600}
.title.done{font-weight:400;color:var(--muted);text-decoration:line-through}
.title.drop{font-weight:400;color:var(--muted)}
.note{color:var(--muted);font-size:12px;margin-top:3px;white-space:pre-wrap}
.tag{display:inline-block;font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--muted);margin-left:6px;vertical-align:1px}
.tag.warn{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 45%,transparent)}
.tag.ai{color:var(--brand);border-color:color-mix(in srgb,var(--brand) 45%,transparent)}
.empty{color:var(--muted);padding:18px 0}
footer{margin-top:36px;padding-top:12px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
a{color:inherit}
@media print{
  body{padding:0;background:#fff;color:#000}
  .cards{grid-template-columns:repeat(4,1fr)}
  h2{page-break-after:avoid}
  tr{page-break-inside:avoid}
}
`

function htmlRow(item, index, now) {
  const status = item?.status
  const titleClass = status === 'completed' ? 'title done' : status === 'abandoned' ? 'title drop' : 'title'
  const marks = []
  if (isOverdueItem(item, now)) marks.push('<span class="tag warn">逾期</span>')
  if (typeof item?.aiSummary === 'string' && item.aiSummary.trim() !== '') marks.push('<span class="tag ai">AI 总结</span>')
  if (item?.recurrence?.type) marks.push('<span class="tag">重复</span>')

  const parts = []
  const content = typeof item?.content === 'string' ? item.content.trim() : ''
  const title = String(item?.title ?? '(无标题)')
  if (content !== '' && content !== title.trim()) parts.push(`<div class="note">${linkify(htmlEscape(content))}</div>`)
  const ai = typeof item?.aiSummary === 'string' ? item.aiSummary.trim() : ''
  if (ai !== '') parts.push(`<div class="note ai">AI：${linkify(htmlEscape(ai))}</div>`)
  const reason = typeof item?.abandonReason === 'string' ? item.abandonReason.trim() : ''
  if (reason !== '') parts.push(`<div class="note">放弃原因：${htmlEscape(reason)}</div>`)

  const due = dueTextOf(item)
  const created = formatDateTime(item?.createdAt)
  const source = sourceLabelOf(item)
  const metaText = [due !== '' ? `提醒 ${due}` : '', created !== '' ? `创建 ${created}` : '', source]
    .filter((part) => part !== '').join('　·　')

  return `<tr>
  <td class="num">${index + 1}</td>
  <td><div class="${titleClass}">${htmlEscape(title)}${marks.join('')}</div>${parts.join('')}</td>
  <td class="num">${htmlEscape(metaText)}</td>
</tr>`
}

/** 一组表格。空组默认不渲染——多选范围下「已完成（0）」会被误读成全局 0 条。 */
function htmlSection(title, rows, now, { showEmpty = false } = {}) {
  if (rows.length === 0 && !showEmpty) return ''
  if (rows.length === 0) return `<h2>${htmlEscape(title)}（0）</h2>\n<p class="empty">这一组没有记录。</p>`
  const body = rows.map((item, index) => htmlRow(item, index, now)).join('\n')
  return `<h2>${htmlEscape(title)}（${rows.length}）</h2>
<table>
  <thead><tr><th style="width:44px">#</th><th>标题与内容</th><th style="width:230px">提醒 / 来源</th></tr></thead>
  <tbody>
${body}
  </tbody>
</table>`
}

export function buildHtml(items, meta = {}) {
  const now = Number.isFinite(meta.now) ? meta.now : Date.now()
  const stats = summarizeExport(items, now)
  const sorted = sortForExport(items, now)
  const pending = sorted.filter((item) => item?.status !== 'completed' && item?.status !== 'abandoned')
  const completed = sorted.filter((item) => item?.status === 'completed')
  const abandoned = sorted.filter((item) => item?.status === 'abandoned')

  const scopeLabel = typeof meta.scopeLabel === 'string' && meta.scopeLabel !== '' ? meta.scopeLabel : '全部记录'
  const version = typeof meta.appVersion === 'string' && meta.appVersion !== '' ? ` v${meta.appVersion}` : ''
  const cards = [
    { k: '记录总数', n: stats.total, alert: false },
    { k: '未完成', n: stats.pending, alert: false },
    { k: '已完成', n: stats.completed, alert: false },
    { k: '已放弃', n: stats.abandoned, alert: false },
    { k: '逾期', n: stats.overdue, alert: stats.overdue > 0 },
  ].map((card) => `<div class="card${card.alert ? ' alert' : ''}"><div class="n">${card.n}</div><div class="k">${htmlEscape(card.k)}</div></div>`).join('')

  // 一份记录都没有时，三组都空；这时要让读者知道是「范围内无记录」，不是渲染坏了。
  const emptyNote = stats.total === 0 ? '<p class="empty">本次导出范围内没有记录。</p>' : ''

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="generator" content="dsh-todo-checklist${htmlEscape(version)}">
<meta name="description" content="DSH 待办清单导出：${htmlEscape(scopeLabel)}，共 ${stats.total} 条记录（未完成 ${stats.pending}、已完成 ${stats.completed}、已放弃 ${stats.abandoned}、逾期 ${stats.overdue}）。">
<title>待办清单 ${htmlEscape(formatDate(now))}</title>
<style>${HTML_STYLE}</style>
</head>
<body>
<main>
  <h1>待办清单</h1>
  <p class="sub">导出于 ${htmlEscape(formatDateTime(now))}　·　范围：${htmlEscape(scopeLabel)}</p>
  <div class="cards">${cards}</div>
  ${emptyNote}
  ${htmlSection('未完成', pending, now)}
  ${htmlSection('已完成', completed, now)}
  ${htmlSection('已放弃', abandoned, now)}
  <footer>由 DSH 待办清单插件导出${htmlEscape(version)}　·　本文件为静态快照，不随待办变化自动更新。</footer>
</main>
</body>
</html>
`
}
//#endregion

//#region CSV / JSON
const CSV_COLUMNS = [
  ['序号', (item, index) => index + 1],
  ['标题', (item) => item?.title ?? ''],
  ['内容', (item) => item?.content ?? ''],
  ['状态', (item) => statusLabelOf(item)],
  ['是否逾期', (item, index, now) => (isOverdueItem(item, now) ? '是' : '否')],
  ['提醒时间', (item) => dueTextOf(item)],
  ['来源', (item) => sourceLabelOf(item)],
  ['创建时间', (item) => formatDateTime(item?.createdAt)],
  ['完成时间', (item) => formatDateTime(item?.doneAt)],
  ['AI 总结', (item) => item?.aiSummary ?? ''],
  ['放弃原因', (item) => item?.abandonReason ?? ''],
  ['重复规则', (item) => (item?.recurrence?.type ? `${item.recurrence.type} ${pad2(item.recurrence.hour ?? 0)}:${pad2(item.recurrence.minute ?? 0)}` : '')],
  ['会话 ID', (item) => item?.sessionId ?? ''],
  ['记录 ID', (item) => item?.id ?? ''],
]

export function buildCsv(items, meta = {}) {
  const now = Number.isFinite(meta.now) ? meta.now : Date.now()
  const sorted = sortForExport(items, now)
  const lines = [CSV_COLUMNS.map(([name]) => csvCell(name)).join(',')]
  sorted.forEach((item, index) => {
    lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(item, index, now))).join(','))
  })
  // UTF-8 BOM：Excel 双击打开中文不乱码
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

export function buildJson(items, meta = {}) {
  const now = Number.isFinite(meta.now) ? meta.now : Date.now()
  const sorted = sortForExport(items, now)
  const payload = {
    schema: 'dsh-todo-export/1',
    exportedAt: new Date(now).toISOString(),
    exportedAtLocal: formatDateTime(now),
    appVersion: typeof meta.appVersion === 'string' ? meta.appVersion : '',
    scopes: Array.isArray(meta.scopes) ? meta.scopes : normalizeScopes(meta.scope),
    scopeLabel: typeof meta.scopeLabel === 'string' ? meta.scopeLabel : '全部记录',
    stats: summarizeExport(sorted, now),
    items: sorted.map((item) => ({
      id: item?.id ?? '',
      title: item?.title ?? '',
      content: item?.content ?? '',
      status: item?.status ?? '',
      statusLabel: statusLabelOf(item),
      overdue: isOverdueItem(item, now),
      dueAt: item?.dueAt ?? '',
      dueAtMs: Number.isFinite(Number(item?.dueAtMs)) ? Number(item.dueAtMs) : null,
      dueText: dueTextOf(item),
      source: item?.source ?? '',
      sourceLabel: sourceLabelOf(item),
      createdAt: formatDateTime(item?.createdAt),
      updatedAt: formatDateTime(item?.updatedAt),
      doneAt: formatDateTime(item?.doneAt),
      aiSummary: item?.aiSummary ?? '',
      abandonReason: item?.abandonReason ?? '',
      recurrence: item?.recurrence ?? null,
      sessionId: item?.sessionId ?? '',
      messageId: item?.messageId ?? '',
      anchorText: item?.anchorText ?? '',
      handedToTasks: item?.handedToTasks === true,
    })),
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}
//#endregion

//#region XLSX（手写 ZIP store + 5 个 XML）
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    table[i] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/** 极简 ZIP（store 方式，不压缩）。entries: [{name, data: string|Uint8Array}] */
function zipStore(entries, when) {
  const encoder = new TextEncoder()
  const chunks = []
  const central = []
  let offset = 0
  const date = when instanceof Date && !Number.isNaN(when.getTime()) ? when : new Date()
  const dosTime = ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xFFFF
  const dosDate = (((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xFFFF

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const data = entry.data instanceof Uint8Array ? entry.data : encoder.encode(String(entry.data))
    const crc = crc32(data)
    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034B50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true) // UTF-8 文件名
    lv.setUint16(8, 0, true) // store
    lv.setUint16(10, dosTime, true)
    lv.setUint16(12, dosDate, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)
    local.set(nameBytes, 30)
    chunks.push(local, data)
    central.push({ nameBytes, crc, size: data.length, offset })
    offset += local.length + data.length
  }

  const centralStart = offset
  for (const rec of central) {
    const head = new Uint8Array(46 + rec.nameBytes.length)
    const hv = new DataView(head.buffer)
    hv.setUint32(0, 0x02014B50, true)
    hv.setUint16(4, 20, true)
    hv.setUint16(6, 20, true)
    hv.setUint16(8, 0x0800, true)
    hv.setUint16(10, 0, true)
    hv.setUint16(12, dosTime, true)
    hv.setUint16(14, dosDate, true)
    hv.setUint32(16, rec.crc, true)
    hv.setUint32(20, rec.size, true)
    hv.setUint32(24, rec.size, true)
    hv.setUint16(28, rec.nameBytes.length, true)
    hv.setUint32(42, rec.offset, true)
    head.set(rec.nameBytes, 46)
    chunks.push(head)
    offset += head.length
  }

  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054B50, true)
  ev.setUint16(8, central.length, true)
  ev.setUint16(10, central.length, true)
  ev.setUint32(12, offset - centralStart, true)
  ev.setUint32(16, centralStart, true)
  chunks.push(end)

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let cursor = 0
  for (const chunk of chunks) {
    out.set(chunk, cursor)
    cursor += chunk.length
  }
  return out
}

function columnLetter(index) {
  let n = index
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

const XLSX_COLUMNS = [
  { title: '#', width: 6, get: (item, index) => index + 1, numeric: true },
  { title: '标题', width: 44, get: (item) => item?.title ?? '' },
  { title: '内容', width: 52, get: (item) => item?.content ?? '' },
  { title: '状态', width: 10, get: (item) => statusLabelOf(item) },
  { title: '逾期', width: 8, get: (item, index, now) => (isOverdueItem(item, now) ? '是' : '否') },
  { title: '提醒时间', width: 18, get: (item) => dueTextOf(item) },
  { title: '来源', width: 10, get: (item) => sourceLabelOf(item) },
  { title: '创建时间', width: 18, get: (item) => formatDateTime(item?.createdAt) },
  { title: '完成时间', width: 18, get: (item) => formatDateTime(item?.doneAt) },
  { title: 'AI 总结', width: 46, get: (item) => item?.aiSummary ?? '' },
  { title: '放弃原因', width: 24, get: (item) => item?.abandonReason ?? '' },
  {
    title: '重复规则',
    width: 14,
    get: (item) => (item?.recurrence?.type
      ? `${item.recurrence.type} ${pad2(item.recurrence.hour ?? 0)}:${pad2(item.recurrence.minute ?? 0)}`
      : ''),
  },
  { title: '会话 ID', width: 40, get: (item) => item?.sessionId ?? '' },
  { title: '记录 ID', width: 40, get: (item) => item?.id ?? '' },
]

function sheetCell(ref, value, numeric) {
  if (numeric) {
    const n = Number(value)
    if (Number.isFinite(n)) return `<c r="${ref}"><v>${n}</v></c>`
  }
  const text = String(value ?? '')
  if (text === '') return ''
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`
}

function buildSheetXml(items, now) {
  const cols = XLSX_COLUMNS.map((col, index) => `<col min="${index + 1}" max="${index + 1}" width="${col.width}" customWidth="1"/>`).join('')
  const header = `<row r="1">${XLSX_COLUMNS.map((col, index) => sheetCell(`${columnLetter(index + 1)}1`, col.title, false)).join('')}</row>`
  const rows = items.map((item, rowIndex) => {
    const r = rowIndex + 2
    const cells = XLSX_COLUMNS.map((col, index) => sheetCell(`${columnLetter(index + 1)}${r}`, col.get(item, rowIndex, now), col.numeric)).join('')
    return `<row r="${r}">${cells}</row>`
  }).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><outlinePr summaryBelow="1" summaryRight="1"/></sheetPr><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols>${cols}</cols><sheetData>${header}${rows}</sheetData></worksheet>`
}

export function buildXlsx(items, meta = {}) {
  const now = Number.isFinite(meta.now) ? meta.now : Date.now()
  const sorted = sortForExport(items, now)
  const files = [
    {
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="待办清单" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    },
    { name: 'xl/worksheets/sheet1.xml', data: buildSheetXml(sorted, now) },
  ]
  return zipStore(files, new Date(now))
}
//#endregion

//#region 统一入口 + 下载
/**
 * 生成导出文件。
 * @param {Array} items 全部待办条目
 * @param {{format?: string, scopes?: string|string[], scope?: string|string[], now?: number, appVersion?: string}} options
 *   `scopes` 可传数组（多选）；`scope` 是旧字段名，仍兼容单值。
 * @returns {{filename: string, mime: string, text?: string, bytes?: Uint8Array, count: number, format: string, scopes: string[], scopeLabel: string}}
 */
export function buildExportFile(items, options = {}) {
  const format = EXPORT_FORMATS.some((f) => f.id === options.format) ? options.format : 'html'
  const scopes = normalizeScopes(options.scopes ?? options.scope)
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const picked = filterByScope(items, scopes, now)
  const scopeLabel = scopeLabelOf(scopes)
  const meta = { now, scopes, scopeLabel, appVersion: options.appVersion }
  const base = `dsh-todo-${stampForName(new Date(now))}-${scopeSlugOf(scopes)}`
  const common = { count: picked.length, format, scopes, scopeLabel }

  switch (format) {
    case 'md':
      return { filename: `${base}.md`, mime: 'text/markdown;charset=utf-8', text: buildMarkdown(picked, meta), ...common }
    case 'csv':
      return { filename: `${base}.csv`, mime: 'text/csv;charset=utf-8', text: buildCsv(picked, meta), ...common }
    case 'json':
      return { filename: `${base}.json`, mime: 'application/json;charset=utf-8', text: buildJson(picked, meta), ...common }
    case 'xlsx':
      return { filename: `${base}.xlsx`, mime: XLSX_MIME, bytes: buildXlsx(picked, meta), ...common }
    case 'html':
    default:
      return { filename: `${base}.html`, mime: 'text/html;charset=utf-8', text: buildHtml(picked, meta), ...common }
  }
}

/** 导出结果是否为纯文本（宿主侧可直接回给模型，无需落盘）。 */
export function isTextExport(result) {
  return typeof result?.text === 'string' && !(result?.bytes instanceof Uint8Array)
}
//#endregion
