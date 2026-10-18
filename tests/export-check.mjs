/**
 * 导出模块验收（不依赖浏览器）：直接跑 export.js 的构建函数，检查各格式产物是否合法。
 *
 * 重点验 .xlsx：手写 ZIP 一旦 CRC/偏移/中央目录算错，Excel 会弹「需要修复」。
 * 这里用 Node 自带能力（在 python / Expand-Archive 之外再加一道）解析回来看结构。
 *
 * 用法：node tests/export-check.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const outDir = join(here, 'out')
// Windows 绝对路径不能直接喂给 import()，必须转 file:// URL
const mod = await import(pathToFileURL(join(root, 'client-src', 'export.js')).href)

let pass = 0
let fail = 0
const check = (name, fn) => {
  try {
    fn()
    pass += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    fail += 1
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

// ── 样本：覆盖三种状态、逾期、重复、AI 总结、放弃原因、HTML 注入字符、控制字符 ──
const now = Date.parse('2026-10-19T01:30:00+08:00')
const HOUR = 3600_000
const items = [
  {
    id: 'a1', title: '把 DFMEA 模板发给供应商', content: '附上 2026 版模板 + 填写说明',
    status: 'pending', createdAt: now - 72 * HOUR, source: 'selection',
    dueAtMs: now + 2 * HOUR, dueAt: '2026-10-19T11:30:00+08:00', sessionId: 'sess-1', messageId: 'm1',
    anchorText: '发给供应商',
  },
  {
    id: 'a2', title: '整理镜片公差评审要点', content: '',
    status: 'pending', createdAt: now - 48 * HOUR, source: 'ai',
    dueAtMs: now - 5 * HOUR, dueAt: '2026-10-18T20:30:00+08:00',
    aiSummary: '汇总 3 份评审记录的共性公差项，输出一页纸要点。',
  },
  {
    id: 'a3', title: '回复客户 8D 报告', content: 'D4 根因已确认\nD5 措施待客户确认 <b>粗体</b> & "引号"',
    status: 'completed', createdAt: now - 120 * HOUR, updatedAt: now - 24 * HOUR, doneAt: now - 24 * HOUR,
    source: 'manual', dueAtMs: now - 30 * HOUR, dueAt: '2026-10-17T19:30:00+08:00',
  },
  {
    id: 'a4', title: '旧方案：换供应商', content: '成本不划算',
    status: 'abandoned', createdAt: now - 200 * HOUR, updatedAt: now - 100 * HOUR,
    source: 'chat', abandonReason: '单价上涨 12%，改走内部工艺优化',
  },
  {
    id: 'a5', title: '每周五提交质量周报', content: '',
    status: 'pending', createdAt: now - 10 * HOUR, source: 'model',
    recurrence: { type: 'weekly', hour: 17, minute: 30, weekdays: [5] },
    dueAtMs: now + 26 * HOUR, dueAt: '2026-10-20T17:30:00+08:00',
  },
  {
    id: 'a6', title: '控制字符测试\u0001\u0007与代理对 🚀 与长文本',
    content: 'x'.repeat(1200), status: 'pending', createdAt: now - HOUR, source: 'manual',
  },
]

mkdirSync(outDir, { recursive: true })

// ── 纯函数 ──
check('filterByScope 全部/未完成/已完成/已放弃/逾期', () => {
  assert.equal(mod.filterByScope(items, 'all', now).length, 6)
  assert.equal(mod.filterByScope(items, undefined, now).length, 6)
  assert.equal(mod.filterByScope(items, [], now).length, 6)
  assert.equal(mod.filterByScope(items, 'pending', now).length, 4)
  assert.equal(mod.filterByScope(items, 'done', now).length, 1)
  assert.equal(mod.filterByScope(items, 'abandoned', now).length, 1)
  assert.equal(mod.filterByScope(items, 'overdue', now).length, 1)
  assert.deepEqual(mod.filterByScope(items, 'overdue', now).map((i) => i.id), ['a2'])
})

check('filterByScope 多选取并集（逾期是未完成的子集，不重复计数）', () => {
  // 未完成 4 条里含逾期 1 条；两个都选仍是 4 条
  const pendingPlusOverdue = mod.filterByScope(items, ['pending', 'overdue'], now)
  assert.equal(pendingPlusOverdue.length, 4)
  assert.equal(new Set(pendingPlusOverdue.map((i) => i.id)).size, 4)
  // 未完成 + 已完成 = 5 条
  assert.equal(mod.filterByScope(items, ['pending', 'done'], now).length, 5)
  // 全部四个范围 = 全部条目
  assert.equal(mod.filterByScope(items, ['pending', 'overdue', 'done', 'abandoned'], now).length, 6)
  // 未知 id 被忽略，不会误伤
  assert.equal(mod.filterByScope(items, ['nope'], now).length, 6)
})

check('normalizeScopes / scopeLabelOf / scopeSlugOf', () => {
  assert.deepEqual(mod.normalizeScopes(undefined), [])
  assert.deepEqual(mod.normalizeScopes('all'), [])
  assert.deepEqual(mod.normalizeScopes('pending'), ['pending'])
  // 顺序固定为 EXPORT_SCOPES 的顺序（pending → overdue → done → abandoned）
  assert.deepEqual(mod.normalizeScopes(['done', 'pending']), ['pending', 'done'])
  assert.deepEqual(mod.normalizeScopes(['done', 'nope', 'pending']), ['pending', 'done'])
  assert.equal(mod.scopeLabelOf([]), '全部记录')
  assert.equal(mod.scopeLabelOf(['pending', 'overdue']), '未完成 + 逾期')
  assert.equal(mod.scopeSlugOf([]), 'all')
  assert.equal(mod.scopeSlugOf(['pending', 'overdue']), 'pending-overdue')
})

check('summarizeExport 统计口径', () => {
  const s = mod.summarizeExport(items, now)
  assert.equal(s.total, 6)
  assert.equal(s.pending, 4)
  assert.equal(s.completed, 1)
  assert.equal(s.abandoned, 1)
  assert.equal(s.overdue, 1)
  assert.equal(s.withDue, 4)
  assert.equal(s.withAi, 1)
  assert.equal(s.sources['划词'], 1)
  assert.equal(s.sources['AI'], 1)
})

check('formatDateTime / dueTextOf 本地时区格式化', () => {
  assert.equal(mod.formatDateTime(now), '2026-10-19 01:30')
  assert.equal(mod.formatDate(now), '2026-10-19')
  assert.equal(mod.formatDateTime(0), '')
  assert.equal(mod.formatDateTime(NaN), '')
  assert.equal(mod.dueTextOf(items[1]), '2026-10-18 20:30')
  assert.equal(mod.dueTextOf({ dueAt: '下周一' }), '下周一')
  assert.equal(mod.dueTextOf({}), '')
})

// ── Markdown ──
check('Markdown 结构：标题/统计表/三组/勾选框/字段', () => {
  const md = mod.buildMarkdown(items, { now, scopeLabel: '全部记录', appVersion: '1.5.0' })
  assert.ok(md.startsWith('# 待办清单导出\n'))
  assert.ok(md.includes('## 统计'))
  assert.ok(md.includes('| 记录总数 | 6 |'))
  assert.ok(md.includes('## 未完成（4）'), '未完成分组缺失')
  assert.ok(md.includes('## 已完成（1）'))
  assert.ok(md.includes('## 已放弃（1）'))
  assert.ok(md.includes('- [ ] 把 DFMEA 模板发给供应商'))
  assert.ok(md.includes('- [x] 回复客户 8D 报告'))
  assert.ok(md.includes('- [-] 旧方案：换供应商'))
  assert.ok(md.includes('⚠️ 逾期'), '逾期标记缺失')
  assert.ok(md.includes('  - 重复：每周五 17:30'), '重复规则渲染不对')
  assert.ok(md.includes('  - 放弃原因：单价上涨 12%'))
  assert.ok(md.includes('  - AI 总结：汇总 3 份评审记录的共性公差项'))
  assert.ok(md.includes('v1.5.0'))
  assert.ok(!md.includes('undefined'))
  assert.ok(!md.includes('null'))
})

check('Markdown 空列表也有说明', () => {
  const md = mod.buildMarkdown([], { now })
  assert.ok(md.includes('本次导出范围内没有记录'))
})

// ── HTML ──
check('HTML 是完整文档且转义正确', () => {
  const html = mod.buildHtml(items, { now, scopeLabel: '全部记录', appVersion: '1.5.0' })
  assert.ok(html.startsWith('<!DOCTYPE html>'))
  assert.ok(html.includes('<meta charset="utf-8">'))
  assert.ok(html.includes('<html lang="zh-CN">'))
  assert.ok(html.includes('待办清单'))
  assert.ok(html.includes('class="card alert"'), '逾期卡片未高亮')
  // 注入防护：内容里的 <b> 必须被转义，不能变成真标签
  assert.ok(html.includes('&lt;b&gt;粗体&lt;/b&gt;'), 'HTML 未转义，存在注入风险')
  assert.ok(!html.includes('<b>粗体</b>'))
  assert.ok(html.includes('&quot;引号&quot;'))
  // 控制字符必须被清掉（否则浏览器/编辑器显示异常）
  assert.ok(!/[\u0001\u0007]/u.test(html), 'HTML 里残留控制字符')
  assert.ok(html.includes('🚀'), '代理对字符被误删')
  assert.ok(html.includes('打印') === false)
  assert.ok(html.trimEnd().endsWith('</html>'))
})

check('HTML 内联样式无外部依赖（可离线打开）', () => {
  const html = mod.buildHtml(items, { now })
  assert.ok(!/<link\b/iu.test(html), '不应有外部 <link>')
  assert.ok(!/<script\b/iu.test(html), '不应有 <script>')
  assert.ok(html.includes('<style>'))
})

// ── CSV ──
check('CSV 带 BOM、行数正确、引号翻倍、含换行字段被包裹', () => {
  const csv = mod.buildCsv(items, { now })
  assert.ok(csv.startsWith('\uFEFF'), '缺 UTF-8 BOM，Excel 会乱码')
  const body = csv.slice(1)
  const lines = body.split('\r\n').filter((l) => l !== '')
  assert.equal(lines.length, 1 + 6, '应为表头 + 6 行')
  assert.ok(lines[0].startsWith('"序号","标题"'))
  assert.ok(body.includes('"D4 根因已确认\nD5 措施待客户确认'), '多行内容未被引号包裹')
  assert.ok(body.includes('""引号""'), '内部引号未翻倍')
})

// ── JSON ──
check('JSON 可解析且字段齐全', () => {
  const json = mod.buildJson(items, { now, scope: 'all', scopeLabel: '全部记录', appVersion: '1.5.0' })
  const data = JSON.parse(json)
  assert.equal(data.schema, 'dsh-todo-export/1')
  assert.equal(data.items.length, 6)
  assert.equal(data.stats.total, 6)
  assert.equal(data.exportedAtLocal, '2026-10-19 01:30')
  const a2 = data.items.find((i) => i.id === 'a2')
  assert.equal(a2.overdue, true)
  assert.equal(a2.statusLabel, '未完成')
  assert.equal(a2.dueText, '2026-10-18 20:30')
  assert.equal(data.items.find((i) => i.id === 'a3').statusLabel, '已完成')
})

// ── XLSX：核心，逐层拆包验证 ──
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries = new Map()
  // 从尾部找 EOCD
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054B50) { eocd = i; break }
  }
  assert.notEqual(eocd, -1, '找不到 ZIP 中央目录结尾（EOCD）')
  const count = view.getUint16(eocd + 10, true)
  const cdSize = view.getUint32(eocd + 12, true)
  const cdOffset = view.getUint32(eocd + 16, true)
  assert.equal(cdOffset + cdSize, eocd, 'EOCD 记录的中央目录位置与实际不符')

  let cursor = cdOffset
  for (let i = 0; i < count; i += 1) {
    assert.equal(view.getUint32(cursor, true), 0x02014B50, `第 ${i} 条中央目录签名错误`)
    const method = view.getUint16(cursor + 10, true)
    const crc = view.getUint32(cursor + 16, true)
    const compSize = view.getUint32(cursor + 20, true)
    const rawSize = view.getUint32(cursor + 24, true)
    const nameLen = view.getUint16(cursor + 28, true)
    const extraLen = view.getUint16(cursor + 30, true)
    const commentLen = view.getUint16(cursor + 32, true)
    const localOffset = view.getUint32(cursor + 42, true)
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLen))

    // 校验本地头
    assert.equal(view.getUint32(localOffset, true), 0x04034B50, `${name} 本地头签名错误`)
    const lNameLen = view.getUint16(localOffset + 26, true)
    const lExtraLen = view.getUint16(localOffset + 28, true)
    const dataStart = localOffset + 30 + lNameLen + lExtraLen
    const raw = bytes.subarray(dataStart, dataStart + compSize)
    const data = method === 0 ? raw : inflateRawSync(raw)
    assert.equal(data.length, rawSize, `${name} 解压后长度与中央目录不符`)

    // 校验 CRC
    let c = 0xFFFFFFFF
    for (let k = 0; k < data.length; k += 1) {
      c ^= data[k]
      for (let b = 0; b < 8; b += 1) c = (c & 1) !== 0 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    }
    c = (c ^ 0xFFFFFFFF) >>> 0
    assert.equal(c, crc, `${name} CRC32 校验失败（Excel 会报需要修复）`)

    entries.set(name, new TextDecoder().decode(data))
    cursor += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

let xlsxBytes
check('XLSX 是合法 ZIP，5 个部件齐全且 CRC 正确', () => {
  xlsxBytes = mod.buildXlsx(items, { now })
  assert.ok(xlsxBytes instanceof Uint8Array)
  assert.equal(xlsxBytes[0], 0x50)
  assert.equal(xlsxBytes[1], 0x4B)
  const zip = readZip(xlsxBytes)
  assert.deepEqual([...zip.keys()].sort(), [
    '[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels',
    'xl/workbook.xml', 'xl/worksheets/sheet1.xml',
  ])
  assert.ok(zip.get('xl/workbook.xml').includes('name="待办清单"'))
  assert.ok(zip.get('[Content_Types].xml').includes('spreadsheetml.sheet.main+xml'))
})

check('XLSX 表格内容：表头 + 6 行数据 + 冻结首行', () => {
  const sheet = readZip(xlsxBytes).get('xl/worksheets/sheet1.xml')
  assert.ok(sheet.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'))
  assert.ok(sheet.includes('state="frozen"'), '首行未冻结')
  assert.ok(sheet.includes('<is><t xml:space="preserve">标题</t></is>'), '表头单元格缺失')
  assert.ok(sheet.includes('<row r="7">'), '应到第 7 行（表头 + 6 条）')
  assert.ok(!sheet.includes('<row r="8">'), '多出了不存在的行')
  assert.ok(sheet.includes('把 DFMEA 模板发给供应商'))
  assert.equal((sheet.match(/<row r="/gu) ?? []).length, 7)
  // 纯数字列走数值单元格，不加 inlineStr
  assert.ok(/<c r="A2"><v>1<\/v><\/c>/u.test(sheet), '序号列不是数值单元格')
  // 列字母映射：14 列 → N
  assert.ok(sheet.includes('r="N1"'), '第 14 列字母应为 N')
  assert.ok(!sheet.includes('r="O1"'))
})

check('XLSX 特殊字符：控制字符被剔除、XML 元字符被转义、代理对保留', () => {
  const sheet = readZip(xlsxBytes).get('xl/worksheets/sheet1.xml')
  assert.ok(!/[\u0001\u0007]/u.test(sheet), '控制字符残留（Excel 会要求修复）')
  assert.ok(sheet.includes('🚀'), '代理对字符丢失')
  assert.ok(sheet.includes('&lt;b&gt;粗体&lt;/b&gt;'), 'XML 未转义')
  assert.ok(sheet.includes('&amp;'), '& 未转义为 &amp;')
})

check('XLSX 用 xmllint 级别的一致性：标签闭合数匹配', () => {
  const sheet = readZip(xlsxBytes).get('xl/worksheets/sheet1.xml')
  for (const tag of ['row', 'c', 'is', 't']) {
    // `<c` 不能误吃 `<col`：标签名后必须紧跟空格或 > 才算开标签
    const open = (sheet.match(new RegExp(`<${tag}(?=[ >])`, 'gu')) ?? []).length
    const selfClose = (sheet.match(new RegExp(`<${tag}(?=[ >])[^>]*/>`, 'gu')) ?? []).length
    const close = (sheet.match(new RegExp(`</${tag}>`, 'gu')) ?? []).length
    assert.equal(open - selfClose, close, `<${tag}> 开合标签数不匹配`)
  }
})

// ── 统一入口 ──
check('buildExportFile 各格式文件名/类型正确', () => {
  const cases = [
    ['html', 'html', 'text/html;charset=utf-8'],
    ['md', 'md', 'text/markdown;charset=utf-8'],
    ['csv', 'csv', 'text/csv;charset=utf-8'],
    ['json', 'json', 'application/json;charset=utf-8'],
    ['xlsx', 'xlsx', mod.XLSX_MIME],
  ]
  for (const [format, ext, mime] of cases) {
    const result = mod.buildExportFile(items, { format, now })
    assert.equal(result.format, format)
    assert.equal(result.mime, mime)
    assert.ok(result.filename.endsWith(`.${ext}`), `${format} 扩展名不对：${result.filename}`)
    assert.equal(result.count, 6)
    assert.ok(/^dsh-todo-\d{8}-\d{4}-all\./u.test(result.filename), `文件名格式不对：${result.filename}`)
    if (format === 'xlsx') assert.ok(result.bytes instanceof Uint8Array)
    else assert.equal(typeof result.text, 'string')
  }
})

check('buildExportFile 范围生效 + 未知值回落默认', () => {
  const pending = mod.buildExportFile(items, { format: 'md', scope: 'pending', now })
  assert.equal(pending.count, 4)
  assert.ok(pending.filename.includes('-pending.'))
  assert.ok(pending.text.includes('## 未完成（4）'))
  assert.ok(!pending.text.includes('## 已完成（1）'))

  // 多选：文件名用短横线拼，范围文案用「+」拼
  const multi = mod.buildExportFile(items, { format: 'md', scopes: ['pending', 'overdue'], now })
  assert.equal(multi.count, 4)
  assert.ok(multi.filename.includes('-pending-overdue.'), `多选文件名不对：${multi.filename}`)
  assert.equal(multi.scopeLabel, '未完成 + 逾期')
  assert.deepEqual(multi.scopes, ['pending', 'overdue'])

  const bogus = mod.buildExportFile(items, { format: 'nope', scope: 'nope', now })
  assert.equal(bogus.format, 'html')
  assert.equal(bogus.count, 6)
  assert.ok(bogus.filename.endsWith('-all.html'))
})

check('HTML 只渲染范围内的分组，不出现「已完成（0）」这类空节', () => {
  // 走真实入口：先按范围过滤，再渲染。直接喂 buildHtml 全量记录测不到这个缺陷。
  const scoped = mod.buildExportFile(items, { format: 'html', scopes: ['pending'], now })
  const headings = [...scoped.text.matchAll(/<h2[^>]*>([^<]*)<\/h2>/gu)].map((m) => m[1])
  assert.deepEqual(headings, ['未完成（4）'], `空分组没跳过：${JSON.stringify(headings)}`)
  assert.ok(!scoped.text.includes('这一组没有记录'), '不该出现空组占位')
  assert.ok(!scoped.text.includes('已完成（0）') && !scoped.text.includes('已放弃（0）'))

  // 一份记录都没有时才给全局提示
  const empty = mod.buildHtml([], { now, scopeLabel: '已完成' })
  assert.ok(empty.includes('本次导出范围内没有记录'), '空导出缺提示')
  assert.equal([...empty.matchAll(/<h2/gu)].length, 0, '空导出不该有分组标题')
})

check('空数据导出不会崩', () => {
  for (const format of ['html', 'md', 'csv', 'json', 'xlsx']) {
    const result = mod.buildExportFile([], { format, now })
    assert.equal(result.count, 0)
    if (result.text !== undefined) assert.ok(result.text.length > 0)
    else assert.ok(result.bytes.length > 0)
  }
})

// ── 落盘，交给外部工具复核 ──
const written = []
for (const format of ['html', 'md', 'csv', 'json', 'xlsx']) {
  const result = mod.buildExportFile(items, { format, now, appVersion: '1.5.0' })
  const path = join(outDir, result.filename)
  writeFileSync(path, result.bytes instanceof Uint8Array ? result.bytes : result.text)
  const size = Buffer.byteLength(result.bytes instanceof Uint8Array ? result.bytes : result.text)
  written.push(`${result.filename} (${size} B)`)
}

console.log('\n--- 产物已写入 tests/out/ ---')
for (const line of written) console.log(`  ${line}`)
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
