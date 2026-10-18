/**
 * v1.5.1 回归测试：存储域生命周期（插件重载不再永久 already-open）。
 *
 * 真实故障：用户环境里 todo_list 开始一直报
 *   「读取待办失败：存储不可用（待办数据无法读写）：domain 'dsh_todo_sidecar_items' is already open」
 * 根因（dsh-storage-domain 源码实证）：DomainFacility 用 reserved 集合按 name 记名，
 * 只有 Domain.close() 才释放；本插件 lazy open 却从不关闭句柄，于是插件 fiber 销毁后重新
 * apply（宿主热重载 / 配置变更 / 窗口重开）时，新实例 open() 直接抛 already-open，
 * 且 domainPromise 被重置后每次调用都重试失败 → 待办数据整体不可读。
 *
 * 本测试用忠实实现 reserved 语义的假设施复现四条路径：
 *   F1–F3  正常 apply → dispose → 再 apply（修复前必失败）
 *   F4     上一实例遗留未关闭的域 → 新实例沿用（不抢不关）
 *   F5     并发 open 进行中（reserved 已占、domains 未写入）→ 轮询后沿用
 *   F6     句柄被设施关掉（closeAll）→ 自动重开自愈
 *
 * 用法（在本目录下执行）：node domain-reload.mjs
 * 换目标包：DSH_TODO_PLUGIN_DIR=<包目录> node domain-reload.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = process.env.DSH_TODO_PLUGIN_DIR || path.resolve(HERE, '..')
const STORE_TMP = path.join(PLUGIN, '_r_store.mjs')
const HOST_TMP = path.join(PLUGIN, '_r_host.mjs')
const STATE_DIR = path.join(os.tmpdir(), `dsh-todo-reload-${Date.now()}`)
fs.mkdirSync(STATE_DIR, { recursive: true })

// shim：把两个 peer 包换成恒等/直读实现，方便直接 import 源码
let storeSrc = fs.readFileSync(path.join(PLUGIN, 'host', 'store.js'), 'utf8')
storeSrc = storeSrc.replace("import { defineDomain } from '@deepseek-ai/dsh-storage-domain'", 'const defineDomain = (spec) => spec')
fs.writeFileSync(STORE_TMP, storeSrc, 'utf8')
let hostSrc = fs.readFileSync(path.join(PLUGIN, 'host', 'index.js'), 'utf8')
hostSrc = hostSrc.replaceAll("'./store.js'", "'./_r_store.mjs'")
hostSrc = hostSrc.replaceAll("'../shared/export-core.js'", "'./shared/export-core.js'")
hostSrc = hostSrc.replace("import { defineTool } from '@deepseek-ai/dsh-tools'", 'const defineTool = (spec) => spec')
fs.writeFileSync(HOST_TMP, hostSrc, 'utf8')

process.env.DSH_TODO_STATE_DIR = STATE_DIR
process.env.DSH_TODO_DEBUG = '1' // 让 domainReused/domainOpenError 落盘，便于断言诊断留痕

const DOMAIN = 'dsh_todo_sidecar_items'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, extra = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`)
}

/** 忠实复刻 DomainFacility 的 reserved 语义（见 dsh-storage-domain lib/index.js open()）。 */
const makeFacility = ({ openDelayMs = 0 } = {}) => {
  let state = { items: [], config: {} }
  const domains = new Map()
  const reserved = new Set()
  const open = async (spec) => {
    if (reserved.has(spec.name)) {
      const error = new Error(`domain '${spec.name}' is already open`)
      error.code = 'already-open'
      throw error
    }
    reserved.add(spec.name)
    if (openDelayMs > 0) await sleep(openDelayMs)
    const handle = {
      name: spec.name,
      closed: false,
      global: {
        get: () => state,
        set: async (next) => { state = next },
      },
      table: () => { throw new Error('该域没有表') },
      close: async () => {
        if (handle.closed) return
        handle.closed = true
        domains.delete(spec.name)
        reserved.delete(spec.name)
      },
    }
    domains.set(spec.name, handle)
    return handle
  }
  const get = (name) => domains.get(name)
  const closeAll = async () => { for (const d of [...domains.values()]) await d.close() }
  const seed = (next) => { state = next }
  return { domains, reserved, open, get, closeAll, seed }
}

const makeCtx = (facility) => {
  const provided = new Map()
  const tools = []
  const disposers = []
  const ctx = {
    get: (name) => provided.get(name),
    provide: (name, value) => { provided.set(name, value) },
    effect: (fn) => {
      const disposer = fn()
      if (typeof disposer === 'function') disposers.push(disposer)
      return () => { }
    },
    tools: { register: (tool) => { tools.push(tool); return () => { } } },
    systemPrompt: { section: () => () => { } },
    on: () => () => { },
    storageDomain: facility,
    logger: { warn: () => { }, info: () => { } },
  }
  const dispose = async () => {
    for (const disposer of disposers.splice(0).reverse()) {
      try { await disposer() } catch { }
    }
  }
  return { ctx, provided, tools, dispose }
}

const mod = await import(pathToFileURL(HOST_TMP).href)

// ---------- F1–F3 正常 apply → dispose → 再 apply ----------
const facilityA = makeFacility()
facilityA.seed({ items: [{ id: 'seed-1', title: '遗留待办', status: 'pending', createdAt: Date.now(), source: 'manual' }], config: {} })
const a1 = makeCtx(facilityA)
mod.apply(a1.ctx)
const listA1 = await a1.provided.get('todos').list({})
check('F1 首次 apply 可读（开域成功）', listA1.ok === true && listA1.value.items.length === 1, listA1.ok ? '' : String(listA1.error))
check('F2 句柄被设施记为已占名（reserved）', facilityA.reserved.has(DOMAIN) === true)

await a1.dispose()
check('F3 dispose 后释放域（reserved 清空）', facilityA.reserved.has(DOMAIN) === false && facilityA.domains.size === 0)

const a2 = makeCtx(facilityA)
mod.apply(a2.ctx)
const listA2 = await a2.provided.get('todos').list({})
check('F4 重新 apply 仍可读（修复前此处 already-open 永久失败）', listA2.ok === true && listA2.value.items.length === 1, listA2.ok ? '' : String(listA2.error))
await a2.dispose()

// ---------- F5 上一实例遗留未关闭的域 → 沿用 ----------
const facilityB = makeFacility()
facilityB.seed({ items: [{ id: 'orphan-1', title: '旧实例遗留', status: 'pending', createdAt: Date.now(), source: 'manual' }], config: {} })
const orphan = await facilityB.open({ name: DOMAIN })          // 模拟「上个实例 open 了但从未 close」
const b = makeCtx(facilityB)
mod.apply(b.ctx)
const listB = await b.provided.get('todos').list({})
check('F5 遗留域存在时沿用而非报错', listB.ok === true && listB.value.items[0]?.id === 'orphan-1', listB.ok ? '' : String(listB.error))
await b.dispose()
check('F6 沿用的句柄不被本实例关闭（避免误伤并发实例）', orphan.closed === false)

// ---------- F7 并发 open 进行中（reserved 已占、domains 未写入）→ 轮询后沿用 ----------
const facilityC = makeFacility({ openDelayMs: 500 })
facilityC.seed({ items: [{ id: 'late-1', title: '并发打开', status: 'pending', createdAt: Date.now(), source: 'manual' }], config: {} })
const inflight = facilityC.open({ name: DOMAIN })               // 不 await：reserved 已占位，domains 还没写
const c = makeCtx(facilityC)
mod.apply(c.ctx)
const listC = await c.provided.get('todos').list({})
await inflight.catch(() => { })
check('F7 并发 open 未落地时轮询等待后沿用', listC.ok === true && listC.value.items[0]?.id === 'late-1', listC.ok ? '' : String(listC.error))
await c.dispose()

// ---------- F8 句柄被设施关掉（closeAll）→ 自动重开自愈 ----------
const facilityD = makeFacility()
const d = makeCtx(facilityD)
mod.apply(d.ctx)
const firstD = await d.provided.get('todos').list({})
await facilityD.closeAll()                                     // 设施整体 teardown（storage-domain 插件重挂载）
facilityD.seed({ items: [{ id: 'after-close', title: '重开后可见', status: 'pending', createdAt: Date.now(), source: 'manual' }], config: {} })
const secondD = await d.provided.get('todos').list({})
check('F8 句柄被外部关闭后自动重开（不再永久报错）', firstD.ok === true && secondD.ok === true && secondD.value.items[0]?.id === 'after-close', secondD.ok ? '' : String(secondD.error))
await d.dispose()

// ---------- F9 诊断留痕 ----------
const diagFile = path.join(STATE_DIR, 'diag.jsonl')
const diagText = fs.existsSync(diagFile) ? fs.readFileSync(diagFile, 'utf8') : ''
check('F9 沿用路径写入 domainReused 诊断', diagText.includes('domainReused') === true)
check('F10 真失败才写 domainOpenError', diagText.includes('domainOpenError') === false, '本组用例不应出现打开失败')

// ---------- F11 卸载顺序：自己 open 的域必须释放，沿用的他人句柄不动 ----------
check('F11 自己开的域 dispose 后无残留、沿用的他人句柄保留',
  facilityA.domains.size === 0 && facilityB.domains.size === 1 && facilityD.domains.size === 0,
  `A=${facilityA.domains.size}(应 0) B=${facilityB.domains.size}(应 1，沿用不关) D=${facilityD.domains.size}(应 0)`)

const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`)
if (failed.length > 0) console.log('失败项：', failed.map((f) => f.name).join(' | '))

fs.rmSync(STORE_TMP, { force: true })
fs.rmSync(HOST_TMP, { force: true })
fs.rmSync(STATE_DIR, { recursive: true, force: true })
process.exit(failed.length === 0 ? 0 : 1)
