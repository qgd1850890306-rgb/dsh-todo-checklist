/**
 * dsh-todo 导出模块 · 浏览器侧入口。
 *
 * 纯格式化逻辑放在 `../shared/export-core.js`，宿主半边（lib/host.js）也 import 同一份，
 * 保证「界面上导出的文件」与「AI 通过 todo_export 工具拿到的内容」逐字节一致。
 * 这里只多做一件宿主环境做不了的事：触发浏览器下载。
 */
export {
  EXPORT_FORMATS,
  EXPORT_SCOPES,
  XLSX_MIME,
  buildExportFile,
  buildMarkdown,
  buildHtml,
  buildCsv,
  buildJson,
  buildXlsx,
  filterByScope,
  summarizeExport,
  isOverdueItem,
  dueTextOf,
  formatDateTime,
  formatDate,
  statusLabelOf,
  sourceLabelOf,
  isTextExport,
} from '../shared/export-core.js'

/**
 * 触发浏览器下载。
 * 做法与官方 dsh-session-log-export 一致：`<a download>` + object URL，
 * 不经 Electron IPC、不写宿主磁盘。
 */
export function downloadExportFile(result) {
  if (!result) throw new Error('导出内容为空')
  const payload = result.bytes instanceof Uint8Array ? result.bytes : String(result.text ?? '')
  const blob = new Blob([payload], { type: result.mime ?? 'application/octet-stream' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = result.filename
  anchor.rel = 'noopener'
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return result.filename
}
