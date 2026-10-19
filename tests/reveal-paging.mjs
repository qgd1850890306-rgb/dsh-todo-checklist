#!/usr/bin/env node
/**
 * 待办「点击跳转后不高亮」的回归测试（v1.5.9）。
 *
 * 用户报告（2026-10-20）：「点击，虽然可以跳转会话，但是没有高亮显示」。
 * 排查出三个独立缺陷，本测试覆盖其中最隐蔽的第 2 条。
 *
 * ## 被测试的缺陷
 * DSH 的会话是窗口化分页渲染的（只加载尾部一页），早期消息根本不在 DOM 里，
 * 所以纯轮询永远等不到目标节点。v1.5.7 加了「向前翻页」逻辑，但写成：
 *
 *     const token = ++revealToken                       // 外层拿 N+1
 *     if (await waitAndReveal(locator, ...)) return true // 内层又 ++revealToken → N+2
 *     if (token !== revealToken) return false            // N+1 !== N+2 恒真 → 必退
 *
 * 翻页循环因此从未执行过 —— 死代码。本测试直接在源码层复刻这段控制流，
 * 断言「翻页确实被执行」，并反向验证修复前的写法会被抓到。
 *
 * ## 为什么不在浏览器里测
 * 真实翻页需要一条上万事件的会话，且依赖宿主 sessions.binding() 的运行时状态；
 * 在 CI 里既慢又脆。这里测的是控制流缺陷，用最小复刻足够，且能稳定抓住回归。
 *
 * 跑法：node reveal-paging.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = process.env.DSH_TODO_PLUGIN_DIR || path.resolve(HERE, '..')
const CLIENT_SRC = path.join(PLUGIN, 'client-src', 'index.js')

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok: ok === true })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`)
  if (!ok && extra) console.log(`      ${extra}`)
}

// ---------- A 静态检查：源码里不能出现「外层发号 + 内层再发号」的写法 ----------
const clientExists = fs.existsSync(CLIENT_SRC)
check('A1 client-src/index.js 存在', clientExists, CLIENT_SRC)
const src = clientExists ? fs.readFileSync(CLIENT_SRC, 'utf8') : ''

// 修复后：waitAndReveal 委托给 pollReveal，pollReveal 只接收 generation，不自己 ++
check('A2 存在 pollReveal（由调用方持号的内层轮询）', src.includes('async function pollReveal('))
check('A3 pollReveal 不自己发号（内部无 ++revealToken）', (() => {
  const i = src.indexOf('async function pollReveal(')
  if (i < 0) return false
  // 取函数体：到下一个顶层 async function 或 60 行
  const body = src.slice(i, i + 1200)
  return body.includes('if (generation !== revealToken) return false') && !/timeoutMs[\s\S]{0,400}\+\+revealToken/.test(body.slice(0, 400))
})(), '内层只读 generation')
check('A4 waitAndRevealWithPaging 只发一次号', (() => {
  const i = src.indexOf('async function waitAndRevealWithPaging(')
  if (i < 0) return false
  const body = src.slice(i, i + 3000)
  // 只数代码行，注释里提到 `++revealToken` 是在解释缺陷，不算实现
  const code = body.split(/\r?\n/).filter((line) => !line.trim().startsWith('//')).join('\n')
  const n = (code.match(/\+\+revealToken/g) || []).length
  return n === 1
})(), '应恰好 1 次（注释里的提及不计）')
check('A5 翻页循环内用 generation 判重，不残留 token', (() => {
  const i = src.indexOf('while (page < maxPages)')
  if (i < 0) return false
  const body = src.slice(i, i + 400)
  return body.includes('generation !== revealToken') && !/\btoken !== revealToken/.test(body)
})(), '旧变量名 token 会让循环抛 ReferenceError')

// A6 是抓住「死代码回归」的关键：只数 ++revealToken 次数不够，因为
// 把 pollReveal 换回 waitAndReveal 时外层那一次仍然在，次数不变但缺陷复活。
check('A6 首轮等待调 pollReveal（不能调会自己发号的 waitAndReveal）', (() => {
  const i = src.indexOf('async function waitAndRevealWithPaging(')
  if (i < 0) return false
  const body = src.slice(i, i + 3000)
  const code = body.split(/\r?\n/).filter((line) => !line.trim().startsWith('//')).join('\n')
  const callsPoll = /await\s+pollReveal\(/.test(code)
  const callsWait = /await\s+waitAndReveal\(/.test(code)
  return callsPoll && !callsWait
})(), '调 waitAndReveal 会让外层 generation 立刻作废，翻页再成死代码')

// ---------- B 运行时复刻：翻页循环必须真的被执行 ----------
/** 修复后的控制流最小复刻（与 client-src/index.js 同构） */
function makeFixed() {
  let revealToken = 0
  const stats = { revealCalls: 0, pagerCalls: 0 }
  const reveal = () => { stats.revealCalls += 1; return false } // 永远找不到 = 目标在窗口外
  const pollReveal = async (locator, { timeoutMs, intervalMs = 50, generation }) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (generation !== revealToken) return false
      if (reveal()) return true
      await new Promise((r) => setTimeout(r, intervalMs))
    }
    return false
  }
  const paged = async (locator, { maxPages = 5 } = {}) => {
    const generation = ++revealToken
    if (await pollReveal(locator, { timeoutMs: 200, generation })) return true
    if (generation !== revealToken) return false
    const pager = { hasMore: true, loadOlder: async () => { stats.pagerCalls += 1 } }
    let page = 0
    while (page < maxPages) {
      if (generation !== revealToken) return false
      page += 1
      if (pager.hasMore === false) break
      await pager.loadOlder()
      if (reveal()) return true
      await new Promise((r) => setTimeout(r, 5))
    }
    return false
  }
  return { paged, stats }
}

/** 修复前的错误写法（用来反向验收） */
function makeBroken() {
  let revealToken = 0
  const stats = { revealCalls: 0, pagerCalls: 0 }
  const reveal = () => { stats.revealCalls += 1; return false }
  const waitAndReveal = async (locator, { timeoutMs, intervalMs = 50 } = {}) => {
    const token = ++revealToken // ← 内层又发号
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (token !== revealToken) return false
      reveal()
      await new Promise((r) => setTimeout(r, intervalMs))
    }
    return false
  }
  const paged = async (locator, { maxPages = 5 } = {}) => {
    const token = ++revealToken // ← 外层发号，随即被内层作废
    if (await waitAndReveal(locator, { timeoutMs: 200 })) return true
    if (token !== revealToken) return false // ← 恒真，永远在这里退
    const pager = { hasMore: true, loadOlder: async () => { stats.pagerCalls += 1 } }
    let page = 0
    while (page < maxPages) { page += 1; await pager.loadOlder(); if (reveal()) return true }
    return false
  }
  return { paged, stats }
}

const fixed = makeFixed()
await fixed.paged({ anchorText: 'x' }, { maxPages: 5 })
check('B1 修复后：翻页循环真的执行（loadOlder > 0）', fixed.stats.pagerCalls === 5, `pagerCalls=${fixed.stats.pagerCalls}`)
check('B2 修复后：翻页轮数等于 maxPages', fixed.stats.pagerCalls === 5, `pagerCalls=${fixed.stats.pagerCalls}`)

const broken = makeBroken()
await broken.paged({ anchorText: 'x' }, { maxPages: 5 })
check('B3 反向验收：修复前写法 loadOlder 恒为 0（抓得住该缺陷）', broken.stats.pagerCalls === 0, `pagerCalls=${broken.stats.pagerCalls}`)

// ---------- C 文本锚点按容器整块匹配（跨内联元素也能命中） ----------
const cSrc = src
check('C1 revealLocator 先按消息容器整块比对', (() => {
  const i = cSrc.indexOf('function revealLocator(')
  if (i < 0) return false
  const body = cSrc.slice(i, i + 4000)
  return body.includes("querySelectorAll('[data-chat-node-key], [data-chat-anchor-key]')")
})(), '跨 <strong>/<code> 的锚点才能命中')
check('C2 保留了无容器属性时的文本节点兜底', (() => {
  const i = cSrc.indexOf('function revealLocator(')
  if (i < 0) return false
  const body = cSrc.slice(i, i + 4000)
  return body.includes('createTreeWalker')
})())

// ---------- D 捕获侧读 DSH 真实属性 ----------
check('D1 捕获侧优先读 data-chat-node-key', src.includes('ds.chatNodeKey'))
check('D2 捕获侧保留旧属性兜底', src.includes("'data-message-id'") || src.includes('data-message-id'))

// ---------- 收尾 ----------
const failed = results.filter((r) => !r.ok)
console.log(`\n=== ${results.length - failed.length}/${results.length} PASS ===`)
if (failed.length > 0) console.log('失败项：', failed.map((f) => f.name).join(' | '))
process.exit(failed.length === 0 ? 0 : 1)
