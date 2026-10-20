/**
 * 思考强度（reasoningEffort）链路静态验收 —— 5 项正测 + 3 项反向验收。
 *
 * 为什么需要这个测试：设置页加了下拉、宿主 schema 也收了字段，但真正决定
 * 「用户选的强度有没有生效」的是**建会话时有没有把它放进 agentOptions**。
 * 这条链有三段，任一段断了表面上都看不出来（下拉照样能选、照样保存成功）：
 *   ① resolveModelSelection   从用户配置 / 会话默认里解析出 reasoningEffort
 *   ② modelAgentOptions       把它放进 agents.create 的 agentOptions
 *   ③ 三处建会话（aiCapture / aiSummarize / createFollowup）都走 ②，
 *      followup 还要从源会话继承强度
 *
 * 用静态读源码而不是跑通真实 AI 调用：宿主测试环境里没有 LLM，
 * 真跑只能测到「不崩」。静态判据还必须精确到对象展开表达式内部，
 * 否则三元里的条件名（如 `typeof cfg.reasoningEffort === 'string'`）
 * 会让判据假绿 —— 见下方「坏样本1」。
 *
 * 用法：node effort-passthrough.mjs
 * 环境变量 DSH_TODO_PLUGIN_DIR 可指向其它插件目录（默认取本仓库上一级）。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = process.env.DSH_TODO_PLUGIN_DIR || path.resolve(HERE, '..')
const HOST = path.join(PLUGIN, 'host', 'index.js')

if (!fs.existsSync(HOST)) {
  console.error(`找不到 host/index.js：${HOST}`)
  console.error('把 DSH_TODO_PLUGIN_DIR 指向插件包目录（含 host/index.js）。')
  process.exit(2) // J-27：查不到 ≠ 干净，必须非零退出
}

const src = fs.readFileSync(HOST, 'utf8')
let pass = 0
let fail = 0
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra === '' ? '' : '  ' + extra}`)
  if (ok) pass += 1
  else fail += 1
}

/** ② 的判据：强度必须出现在 agentOptions 的对象字面量内部 */
const helperEffortWired = (text) => {
  const m = /function modelAgentOptions\(selection\)[\s\S]{0,800}?\n}/.exec(text)
  if (m === null) return false
  return /\{[^{}]*reasoningEffort:\s*selection\.reasoningEffort[^{}]*\}/.test(m[0])
}

console.log('--- 正向：三段链路都在 ---')
check('① modelAgentOptions 把强度写进 agentOptions', helperEffortWired(src))

const creates = [...src.matchAll(/agentsOrThrow\(\)\.create\(\{[\s\S]{0,600}?\}\)/g)].map((x) => x[0])
check(
  '③ 三处建会话都走统一 helper',
  creates.length === 3 && creates.every((c) => c.includes('modelAgentOptions')),
  `${creates.filter((c) => c.includes('modelAgentOptions')).length}/${creates.length}`,
)

const resolveBody = /function resolveModelSelection\(ctx, configAiModel\)[\s\S]{0,1400}?\n}/.exec(src)?.[0] ?? ''
check('① 用户配置那一路解析强度', /fromConfig\.reasoningEffort/.test(resolveBody))
check('① 会话默认那一路解析强度', /resolved\.reasoningEffort/.test(resolveBody))
// requestHeader 是可选的：agent?.session?.requestHeader?.()
check(
  '③ followup 继承源会话的强度',
  /requestHeader\?\.\(\)\?\.config[\s\S]{0,700}?cfg\.reasoningEffort/.test(src),
)

console.log('--- 反向：破掉任一段都必须被抓 ---')
check(
  '坏样本1：helper 不写强度 → 被抓住',
  !helperEffortWired(src.replace(/\{[^{}]*reasoningEffort:\s*selection\.reasoningEffort[^{}]*\}/, '{}')),
)

const createsBroken = (() => {
  const t = src.replaceAll('...modelAgentOptions(selection)', '...{}')
  return [...t.matchAll(/agentsOrThrow\(\)\.create\(\{[\s\S]{0,600}?\}\)/g)].map((x) => x[0])
})()
check('坏样本2：create 绕过 helper → 被抓住', !createsBroken.every((c) => c.includes('modelAgentOptions')))

check(
  '坏样本3：用户配置那路丢强度 → 被抓住',
  !/fromConfig\.reasoningEffort/.test(src.replace(/fromConfig\.reasoningEffort/gu, 'undefined')),
)

console.log(`=== ${pass}/${pass + fail} PASS ===`)
process.exit(fail === 0 ? 0 : 1)
