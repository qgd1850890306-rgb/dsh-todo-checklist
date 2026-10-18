/**
 * v1.2.9 发布加固：宿主侧端到端验证（42 项）。
 * 覆盖：
 *  A. 正常启动：apply 同步完成、服务/工具/提示词/监听器注册齐全，CRUD 全链往返；
 *  B. 精简环境：缺 agents / llm / dshIm 时 AI 记录与提醒不崩、返回中文友好错误；
 *  C. 存储域打不开（fail-soft）：apply 不抛（0.2.x fail-closed 不能拖垮 boot），工具仍注册，读写返回可读错误；
 *  D. 跨宿主去重：桌面端与 Web 端共享一份 storages 时，同一条提醒只推一次机器人；
 *  E. 诊断落盘默认关闭（DSH_TODO_DEBUG 未开时不写文件），开启后写 JSONL。
 *
 * 用法（在本目录下执行）：node host-e2e.mjs
 * 换目标包：DSH_TODO_PLUGIN_DIR=<包目录> node host-e2e.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = process.env.DSH_TODO_PLUGIN_DIR || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dsh-todo')
const ROOT_DIR = PLUGIN
const ROOT_TMP = path.join(os.tmpdir(), 'dsh-todo-e2e-bundle')
const BUNDLE_DIR = path.join(ROOT_TMP, 'bundle')
const HOST_TMP = path.join(BUNDLE_DIR, 'host.js')
const TYPERT_TMP = path.join(BUNDLE_DIR, 'typert.js')
const STATE_DIR = path.join(os.tmpdir(), `dsh-todo-e2e-${Date.now()}`)
const SHARED = path.join(STATE_DIR, 'shared-storage.json')
fs.mkdirSync(STATE_DIR, { recursive: true })

// 直接用「打包后的真实产物」：把 lib/host.js、lib/typert.js 复制进带桩 node_modules 的目录，
// 让产物里 external 的 @deepseek-ai/* 裸导入解析到桩（zod 已内联，无需桩）。
fs.rmSync(ROOT_TMP, { recursive: true, force: true })
fs.mkdirSync(BUNDLE_DIR, { recursive: true })
for (const [dir, body] of [
  ['dsh-tools', 'export const defineTool = (spec) => spec\n'],
  ['dsh-storage-domain', 'export const defineDomain = (spec) => spec\n'],
]) {
  const d = path.join(ROOT_TMP, 'node_modules', '@deepseek-ai', dir)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: '@deepseek-ai/' + dir, version: '0.0.0', type: 'module', main: 'index.js', exports: { '.': './index.js' } }, null, 2), 'utf8')
  fs.writeFileSync(path.join(d, 'index.js'), body, 'utf8')
}
if (!fs.existsSync(path.join(PLUGIN, 'lib', 'host.js'))) throw new Error('缺少打包产物 lib/host.js，请先跑 node scripts/build-host.mjs')
fs.copyFileSync(path.join(PLUGIN, 'lib', 'host.js'), HOST_TMP)
fs.copyFileSync(path.join(PLUGIN, 'lib', 'typert.js'), TYPERT_TMP)

process.env.DSH_TODO_STATE_DIR = STATE_DIR
delete process.env.DSH_TODO_DEBUG

const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const writeShared = (globalValue) => fs.writeFileSync(SHARED, JSON.stringify({ unit: { name: 'dsh_todo_sidecar_items', version: 1 }, global: globalValue, tables: {} }, null, 2))
const readShared = () => JSON.parse(fs.readFileSync(SHARED, 'utf8')).global

const makeCtx = ({ brokenDomain = false, file = null, services = {} } = {}) => {
  const provided = new Map()
  const tools = []
  const sections = []
  const listeners = []
  const sent = []
  let memory = file ? readShared() : { items: [], config: {} }
  const handle = {
    name: 'dsh_todo_sidecar_items',
    global: {
      get: () => (file ? readShared() : memory),
      set: async (next) => { memory = next; if (file) writeShared(next) },
    },
    table: () => { throw new Error('该域没有表') },
    close: async () => { },
  }
  const ctx = {
    get: (n) => provided.get(n) ?? services[n],
    provide: (n, v) => { provided.set(n, v) },
    effect: (fn) => { const d = fn(); return d },
    tools: { register: (t) => { tools.push(t); return () => { } } },
    systemPrompt: { section: (s) => { sections.push(s); return () => { } } },
    on: (ev, fn) => { listeners.push({ ev, fn }); return () => { } },
    storageDomain: { open: async () => { if (brokenDomain) throw new Error('模拟存储损坏：stored global does not match its schema'); return handle } },
    logger: { warn: () => { }, info: () => { } },
  }
  return { ctx, provided, tools, sections, listeners, sent }
}

const mod = await import(pathToFileURL(HOST_TMP).href)

// ---------- A. 正常启动 ----------
const a = makeCtx()
let applyThrew = null
try { mod.apply(a.ctx) } catch (error) { applyThrew = error }
check('A1 apply 同步完成不抛错', applyThrew === null, applyThrew ? String(applyThrew.message) : '')
const svc = a.provided.get('todos')
check('A2 注册了 todos 服务', svc !== undefined && typeof svc.add === 'function')
check('A3 注册 3 个模型工具', a.tools.length === 3 && a.tools.map((t) => t.name).join(',') === 'todo_add,todo_list,todo_export', a.tools.map((t) => t.name).join(','))
check('A4 注册提示词片段（order 6000）', a.sections.length === 1 && a.sections[0].order === 6000 && a.sections[0].interpolate === false)
check('A5 订阅 session/event', a.listeners.some((l) => l.ev === 'session/event'))
check('A6 只声明必需硬依赖', JSON.stringify(mod.inject) === JSON.stringify(['tools', 'systemPrompt', 'storageDomain']), JSON.stringify(mod.inject))
check('A7 插件名 todo-sidecar', mod.name === 'todo-sidecar')

const add = await svc.add({ title: 'E2E 待办', content: '内容', dueAt: '2026-10-12 09:00', source: 'manual' })
check('A8 add 成功（服务层信封 ok/value）', add.ok === true && typeof add.value?.id === 'string', add.ok ? '' : String(add.error))
const id = add.value?.id
const readItem = async () => ((await svc.list({})).value?.items ?? []).find((i) => i.id === id) ?? {}
const list = await svc.list({})
check('A9 list 往返（result.value.items）', list.ok === true && list.value.items.length === 1 && list.value.items[0].id === id)
check('A10 list 返回扁平字段（items/notify/…，无 config 容器）', list.ok === true && Array.isArray(list.value.items) && list.value.config === undefined)
const st = await svc.setStatus({ id, status: 'completed' })
check('A11 setStatus 落库为已完成', st.ok === true && (await readItem()).status === 'completed')
const def = await svc.defer({ id, dueAt: '2026-10-20 09:00' })
check('A12 defer 改期并重置 reminded（不碰 status）', def.ok === true && (await readItem()).dueAt === '2026-10-20 09:00' && (await readItem()).reminded !== true)
await svc.setStatus({ id, status: 'pending' })
const ab = await svc.abandon({ id, reason: '不做了' })
check('A13 abandon 记录原因（仅 pending 可放弃）', ab.ok === true && (await readItem()).status === 'abandoned' && (await readItem()).abandonReason === '不做了')
const upd = await svc.update({ id, title: '改名', content: '新内容' })
check('A14 update 编辑标题与内容', upd.ok === true && (await readItem()).title === '改名' && (await readItem()).content === '新内容')
const saveCfg = await svc.saveNotifyConfig({ popup: true, im: false, aiDefaultReminder: '1h', sidebarEnabled: true })
check('A15 saveNotifyConfig 成功', saveCfg.ok === true)
const listed = await svc.list({})
check('A16 config 回读（notify.popup / aiDefaultReminder / sidebarEnabled 缺席即显示）', listed.value.notify?.popup === true && listed.value.aiDefaultReminder === '1h' && listed.value.sidebarEnabled === undefined)
const cfgOff = await svc.saveNotifyConfig({ sidebarEnabled: false })
const listedOff = await svc.list({})
check('A16b sidebarEnabled=false 才下发（客户端注册开关依赖）', cfgOff.ok === true && listedOff.value.sidebarEnabled === false)
const cfgOn = await svc.saveNotifyConfig({ sidebarEnabled: true })
check('A16c 开关可改回 true（部分字段合并写）', cfgOn.ok === true && (await svc.list({})).value.sidebarEnabled === undefined && (await svc.list({})).value.notify?.popup === true)
const seen = await svc.markSeen({})
check('A17 markSeen 不抛（无 value 信封）', seen.ok === true)
const del = await svc.deleteTodo({ id })
check('A18 deleteTodo 删除该条', del.ok === true && (await svc.list({})).value.items.length === 0)
const addA = await svc.add({ title: '留下的未完成', source: 'manual' })
const addB = await svc.add({ title: '待清空的已完成', source: 'manual' })
await svc.setStatus({ id: addB.value.id, status: 'completed' })
const cleared = await svc.clearCompleted({})
const afterClear = (await svc.list({})).value.items
check('A19 clearCompleted 只清已完结', cleared.ok === true && afterClear.length === 1 && afterClear[0].title === '留下的未完成')
await svc.deleteTodo({ id: addA.value.id })

// 三种状态各用各的记号：已放弃若显示成 [ ]，模型转述时会把「不做了」当成「还没做」，
// 头部计数与正文勾选数也会对不上（v1.5.1 真机实测踩到）。
const mkPending = await svc.add({ title: '还在做', source: 'manual' })
const mkAbandon = await svc.add({ title: '决定不做了', source: 'manual' })
await svc.abandon({ id: mkAbandon.value.id, reason: '需求取消' })
const listText = await a.tools[1].execute({}, {})
check('A20 todo_list 用 [-] 标记已放弃、[ ] 留给未完成',
  listText.includes('[-] 决定不做了') && listText.includes('[ ] 还在做'),
  listText.split('\n').slice(0, 3).join(' | '))
check('A20b 头部计数含已放弃，与正文勾选数一致',
  listText.includes('未完成 1') && listText.includes('已放弃 1') && listText.includes('放弃原因：需求取消'),
  listText.split('\n')[0])
await svc.deleteTodo({ id: mkPending.value.id })
await svc.deleteTodo({ id: mkAbandon.value.id })

// ---------- B. 精简环境（无 agents / llm / dshIm） ----------
const cap = await svc.aiCapture({ text: '明天给供应商发 DFMEA 模板' })
check('B1 无 agents 时 aiCapture 返回友好错误', cap.ok === false && /agents/.test(String(cap.error)), String(cap.error))
const fu = await svc.createFollowup({ title: '测试', workspaceId: 'w1' })
check('B2 无 agents 时 createFollowup 返回友好错误', fu.ok === false && /agents/.test(String(fu.error)), String(fu.error))
const models = await svc.listModels({})
check('B3 无 llm 时 listModels 不崩', models.ok === true, models.ok ? '' : String(models.error))
const t0 = Date.now()
const bots = await svc.listImBots({})
check('B4 无 dshIm 时 listImBots 返回空清单不崩', bots.ok === true && Array.isArray(bots.value?.bots) && bots.value.bots.length === 0, `耗时 ${Date.now() - t0}ms`)
const toolAdd = await a.tools[0].execute({ title: '工具写入' }, {})
check('B5 工具 execute 可用（ctx.get 取服务）', typeof toolAdd === 'string' && toolAdd.includes('已加入待办'), toolAdd)
const toolList = await a.tools[1].execute({}, {})
check('B6 工具 todo_list 可读', typeof toolList === 'string' && toolList.includes('未完成'))

// ---------- C. 存储域打不开（fail-soft） ----------
const c = makeCtx({ brokenDomain: true })
let applyThrewC = null
try { mod.apply(c.ctx) } catch (error) { applyThrewC = error }
check('C1 存储坏了 apply 仍不抛（不拖垮 boot）', applyThrewC === null, applyThrewC ? String(applyThrewC.message) : '')
const svcC = c.provided.get('todos')
check('C2 工具仍注册（插件其余功能可用）', c.tools.length === 3, c.tools.map((t) => t.name).join(','))
const listC = await svcC.list({})
check('C3 读返回可读错误', listC.ok === false && String(listC.error).includes('存储不可用'), String(listC.error))
const addC = await svcC.add({ title: '写入应失败' })
check('C4 写返回可读错误', addC.ok === false && String(addC.error).includes('存储不可用'), String(addC.error))
const capC = await svcC.aiCapture({ text: 'x' })
check('C5 存储坏时 AI 记录也被兜住', capC.ok === false && capC.error !== undefined, String(capC.error))

// ---------- D. 跨宿主去重（claimImPush） ----------
const dueItem = {
  id: 'item-cross-host', title: '跨宿主提醒', status: 'pending', createdAt: Date.now() - 60_000,
  dueAtMs: Date.now() - 1_000, dueAt: '2026-10-11 22:00', notifyIm: true, imSent: false, source: 'manual',
}
writeShared({ items: [dueItem], config: { notify: { popup: false, im: true, imBotId: 'wx-test', imTargetId: 'target-1' } } })
let pushes = 0
const imMock = {
  listBots: async () => [{ botId: 'wx-test', channel: 'weixin' }],
  listTargets: async () => [{ targetId: 'target-1', name: '测试群' }],
  send: async () => { pushes += 1 },
}
const d1 = makeCtx({ file: SHARED, services: { dshIm: imMock } })     // 宿主 1：文件后备（真源）
const d2 = makeCtx({ file: null, services: { dshIm: imMock } })      // 宿主 2：陈旧快照（模拟另一个宿主）
mod.apply(d1.ctx)
mod.apply(d2.ctx)
d2.ctx.storageDomain.open = async () => ({                              // 让宿主 2 拿到与宿主 1 相同的陈旧数据
  name: 'dsh_todo_sidecar_items',
  global: { get: () => ({ items: [{ ...dueItem }], config: { notify: { popup: false, im: true, imBotId: 'wx-test', imTargetId: 'target-1' } } }), set: async () => { } },
  table: () => { throw new Error('no tables') }, close: async () => { },
})
const svc1 = d1.provided.get('todos')
const svc2 = d2.provided.get('todos')
await svc1.scanReminders()
await svc2.scanReminders()
check('D1 两个宿主同时扫描只推一次机器人', pushes === 1, `实际推送 ${pushes} 次`)
check('D2 推送后标 imSent（共享状态一致）', readShared().items[0].imSent === true || readShared().items[0].reminded === true)
pushes = 0
await svc1.scanReminders()
check('D3 已推送的不再重复推', pushes === 0, `实际推送 ${pushes} 次`)

// ---------- E. 诊断落盘默认关闭 ----------
check('E1 默认不写诊断文件（DIAG 关）', !fs.existsSync(path.join(STATE_DIR, 'diag.jsonl')))
process.env.DSH_TODO_DEBUG = '1'
const dbg = await import(`${pathToFileURL(HOST_TMP).href}?dbg=1`)
const e = makeCtx({ brokenDomain: true })
dbg.apply(e.ctx)
await e.provided.get('todos').list({})
await sleep(50)
check('E2 DSH_TODO_DEBUG=1 时写诊断 JSONL', fs.existsSync(path.join(STATE_DIR, 'diag.jsonl')))

// ---------- F. 打包产物自检 ----------
const pkgName = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8')).name
const typertMod = await import(pathToFileURL(TYPERT_TMP).href)
check('F1 typert 产物导出 TYPERT 对象', typeof typertMod.TYPERT === 'object' && typertMod.TYPERT !== null)
check('F2 manifest.package 等于包名（loader 强校验）', typertMod.TYPERT.package === pkgName, `${typertMod.TYPERT.package} vs ${pkgName}`)
check('F3 face=host 且 invocations 为数组', typertMod.TYPERT.face === 'host' && Array.isArray(typertMod.TYPERT.invocations), `${typertMod.TYPERT.invocations.length} 个`)
check('F4 打包产物不含裸 zod 导入', !/\bfrom\s*["']zod["']/.test(fs.readFileSync(path.join(PLUGIN, 'lib', 'host.js'), 'utf8')))
check('F5 打包产物无运行时依赖（package.json dependencies 为空）', !JSON.parse(fs.readFileSync(path.join(PLUGIN, 'package.json'), 'utf8')).dependencies)

const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`)
if (failed.length > 0) console.log('失败项：', failed.map((f) => f.name).join(' | '))

fs.rmSync(ROOT_TMP, { recursive: true, force: true })
fs.rmSync(STATE_DIR, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
