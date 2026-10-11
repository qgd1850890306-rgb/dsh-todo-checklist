/**
 * v1.2.9 发布加固验证：用**磁盘真实数据**验证容错 schema。
 * 做法：把 host/store.js 复制成临时 .mjs（把 defineDomain 换成恒等函数，zod 从插件 node_modules 解析），
 * 然后对真实 storage 文件 + 人工注入的各种坏数据跑 global.schema.parse；跑完自动删临时件。
 *
 * 用法（在本目录下执行）：node schema-tolerance.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = process.env.DSH_TODO_PLUGIN_DIR
  ? path.resolve(process.env.DSH_TODO_PLUGIN_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dsh-todo')
const STORE = path.join(ROOT, 'host', 'store.js')
const DATA = path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || '.', '.dsh'), 'storages', 'dsh_todo_sidecar_items.json')
// 必须写在插件目录内，才能解析到插件自己的 node_modules/zod
const TEMP = path.join(ROOT, '_tmp_store_probe.mjs')

let src = fs.readFileSync(STORE, 'utf8')
src = src.replace("import { defineDomain } from '@deepseek-ai/dsh-storage-domain'", 'const defineDomain = (spec) => spec')
fs.writeFileSync(TEMP, src, 'utf8')

const mod = await import(pathToFileURL(TEMP).href)
const schema = mod.todoDomainSpec.global.schema
const stats = mod.tolerantStats

const disk = JSON.parse(fs.readFileSync(DATA, 'utf8'))
// 介质文件结构：{ unit, global: { items, config }, tables }
const realItems = disk.global.items
const realConfig = disk.global.config ?? {}

const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok, extra }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`) }
const clone = (v) => JSON.parse(JSON.stringify(v))

check('磁盘真实数据可解析', (() => { const r = schema.safeParse({ items: realItems, config: realConfig }); return r.success && r.data.items.length === realItems.length })(), `items=${realItems.length}`)
check('真实 config 字段保留', (() => {
  const r = schema.safeParse({ items: [], config: realConfig })
  if (!r.success) return false
  const c = r.data.config
  return JSON.stringify(c) === JSON.stringify(realConfig)
})(), JSON.stringify(Object.keys(realConfig)))

// 1) 顶层未知键（旧版本残留）
check('顶层未知键不再炸（被丢弃）', (() => {
  const r = schema.safeParse({ items: realItems, config: realConfig, legacyFlag: true, schemaVersion: 99 })
  return r.success && r.data.legacyFlag === undefined
})())

// 2) 单条未知键 → 保留该条，丢弃未知键
check('单条未知键保留该条', (() => {
  const items = clone(realItems); items[0] = { ...items[0], futureField: 'x', anotherOne: 1 }
  const r = schema.safeParse({ items, config: realConfig })
  return r.success && r.data.items.length === realItems.length && r.data.items[0].futureField === undefined && r.data.items[0].id === realItems[0].id
})())

// 3) 旧版遗毒：config 多键（正是 v1.1.2 事故）
check('config 多键不再炸', (() => {
  const r = schema.safeParse({ items: [], config: { ...realConfig, unknownConfigKey: 'poison' } })
  return r.success && r.data.config.unknownConfigKey === undefined
})())

// 4) 单条缺必填（title）→ 抢救（补默认标题），不丢
check('缺标题的条目被抢救而非丢弃', (() => {
  const items = clone(realItems); const { title, ...rest } = items[0]; items[0] = rest
  const before = stats.repairedItems
  const r = schema.safeParse({ items, config: realConfig })
  return r.success && r.data.items.length === realItems.length && r.data.items[0].title === '（标题丢失的待办）' && stats.repairedItems > before
})())

// 5) 单条彻底损坏（字符串 / null）→ 只丢那一条
check('单条彻底损坏只丢一条', (() => {
  const items = clone(realItems); items.push('garbage-string', null)
  const before = stats.droppedItems
  const r = schema.safeParse({ items, config: realConfig })
  return r.success && r.data.items.length === realItems.length && stats.droppedItems === before + 2
})(), `期望丢 2 条`)

// 6) config 坏字段 → 好字段保留，坏字段丢弃
check('config 坏字段只丢该字段', (() => {
  const r = schema.safeParse({ items: [], config: { ...realConfig, notify: 'not-an-object', sidebarEnabled: 'yes' } })
  return r.success && r.data.config.notify === undefined && r.data.config.sidebarEnabled === undefined && r.data.config.aiModel !== undefined
})())

// 7) items 为 null / 对象 / JSON 字符串
check('items=null → 空数组不炸', (() => { const r = schema.safeParse({ items: null, config: realConfig }); return r.success && r.data.items.length === 0 })())
check('items=JSON 字符串 → 解析', (() => { const r = schema.safeParse({ items: JSON.stringify(realItems), config: realConfig }); return r.success && r.data.items.length === realItems.length })())
check('items=id→item 对象 → 取值', (() => {
  const map = {}; for (const it of realItems) map[it.id] = it
  const r = schema.safeParse({ items: map, config: realConfig })
  return r.success && r.data.items.length === realItems.length
})())

// 8) 介质哨兵：global schema 必须拒绝 null（defineDomain 硬性要求）
check('global schema 拒绝 null（defineDomain 契约）', schema.safeParse(null).success === false)
check('initial 值自身可解析', schema.safeParse(mod.todoDomainSpec.global.initial).success === true)

// 9) 提醒引擎依赖的字段仍在（dueItems 需要 status/dueAtMs/reminded/recurrence）
check('抢救后关键字段仍在（status/dueAtMs/reminded）', (() => {
  const r = schema.safeParse({ items: realItems, config: realConfig })
  if (!r.success) return false
  const some = r.data.items.find((i) => i.dueAtMs !== undefined) ?? r.data.items[0]
  return typeof some.status === 'string' && (some.dueAtMs === undefined || typeof some.dueAtMs === 'number') && (some.reminded === undefined || typeof some.reminded === 'boolean')
})())

const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`)
console.log('容错统计:', JSON.stringify(stats))
fs.rmSync(TEMP, { force: true })
process.exit(failed.length === 0 ? 0 : 1)
