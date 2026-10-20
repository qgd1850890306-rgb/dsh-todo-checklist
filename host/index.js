/**
 * dsh-todo 宿主半边（0.2.0-rc.x 实证写法，参照本机正常运行的 dsh-cost-meter /
 * @weibaohui/dsh-tasks）：
 *
 * 1. todos 服务 —— 普通服务对象 + 手写 `typertRemote` 绑定 + ctx.provide。
 * 2. AI 记录待办 —— aiCapture() 用 ctx.agents.create() 开临时 agent 会话执行
 *    总结提示词；session/event 的 turn/end 捕获最终回复，解析 JSON 入列。
 * 3. 内置提醒引擎 —— 30s 扫描到期待办，标记 reminded 并经软依赖 dsh-im 推送。
 * 4. 模型工具 todo_add / todo_list + 系统提示词片段。
 * 5. 持久化 —— storageDomain 领域 dsh_todo_sidecar_items（v0.5：items + config；改名避开
 *    与内置 todo-sidecar 的领域撞名，旧 dsh_todo_items v1 弃用）。
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  createItem, deriveTitle, dueItems, nextDueAt, normalizeMultiline, normalizeText, parseDueAt, pruneItems, resolveNotify, summarize, tolerantStats, todoDomainSpec,
} from './store.js'
import { buildExportFile, isTextExport, summarizeExport } from '../shared/export-core.js'

export { todoDomainSpec } from './store.js'

export const name = 'todo-sidecar'
/**
 * v1.3.0 发布加固：只保留真正必需的硬依赖。
 * - tools / systemPrompt / storageDomain：注册工具、提示词片段、持久化，缺一不可。
 * - agents / agentDefaultModel：只有「AI 记录待办」用到，代码里本就走 ctx.get() 软取 →
 *   降级为软依赖：精简 profile 缺这两个服务时插件仍能激活（列表/增删改照常，
 *   AI 记账返回友好报错），而不是被宿主整个拒绝激活。
 */
export const inject = ['tools', 'systemPrompt', 'storageDomain']

const SOURCE_LABEL = {
  selection: '划词',
  chat: '对话',
  model: '对话',
  manual: '手动',
  ai: 'AI',
}

/** IM 投递服务的软依赖候选（照搬 dsh-tasks：永不走 inject 硬依赖）。 */
const NOTIFY_SERVICE_CANDIDATES = ['dshIm']

/**
 * v1.4.0 通用化：合并「静态候选 + 运行时已保存配置引用的服务名」。
 * 照 dsh-tasks listProviders——单条/全局配置里记了具体 service 时优先用它，其余候选兜底。
 * @param {string|undefined} preferred 优先服务名（单条 item.imService 或全局 notify.service）
 */
const notifyCandidates = (preferred) => {
  const ordered = []
  if (typeof preferred === 'string' && preferred.length > 0) ordered.push(preferred)
  for (const candidate of NOTIFY_SERVICE_CANDIDATES) {
    if (!ordered.includes(candidate)) ordered.push(candidate)
  }
  return ordered
}

/**
 * v1.3.0 发布加固：诊断日志不再写死开发机绝对路径，也不再无条件写盘。
 * - 默认零副作用：只有设置 DSH_TODO_DEBUG=1 才记录（线上排障时让用户临时开启复现）。
 * - 落点 <DSH_HOME>/dsh-todo/diag.jsonl（DSH_HOME 由宿主注入，缺省 ~/.dsh；
 *   可用 DSH_TODO_STATE_DIR 覆盖），超过 256KB 自动重置。
 */
const STATE_DIR = process.env.DSH_TODO_STATE_DIR
  || path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'dsh-todo')
const DIAG_ON = process.env.DSH_TODO_DEBUG === '1' || process.env.DSH_TODO_DEBUG === 'true'
const DIAG_MAX_BYTES = 256 * 1024

function appendDiag(part) {
  if (!DIAG_ON) return
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    const file = path.join(STATE_DIR, 'diag.jsonl')
    try { if (fs.statSync(file).size > DIAG_MAX_BYTES) fs.rmSync(file, { force: true }) } catch { }
    fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...part })}\n`)
  } catch { }
}

function messageOf(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 300 ? `${message.slice(0, 297)}...` : message
}

/** 校验并归一化周期提醒（daily/weekly）；非法返回 undefined。 */
function validRecurrence(raw) {
  if (!raw || typeof raw !== 'object') return undefined
  const type = raw.type
  if (type !== 'daily' && type !== 'weekly') return undefined
  const hour = Number(raw.hour)
  const minute = Number(raw.minute)
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return undefined
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return undefined
  const result = { type, hour, minute }
  if (type === 'weekly') {
    const weekdays = Array.isArray(raw.weekdays)
      ? [...new Set(raw.weekdays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
      : []
    if (weekdays.length === 0) return undefined
    result.weekdays = weekdays
  }
  return result
}

/** 防御性读取活跃会话的事件日志（照搬 dsh-tasks 的 sanctioned 写法）。 */
function sessionEventsOf(session) {
  if (!session) return undefined
  try {
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events
    if (Array.isArray(events)) return events
  } catch { }
  return undefined
}

function messageText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (part && part.type === 'text' && typeof part.text === 'string' ? part.text : '')).join('')
  }
  return ''
}

function lastAssistantText(events) {
  if (!Array.isArray(events)) return ''
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const entry = events[i]
    if (entry && entry.type === 'assistant/message') {
      const message = entry.data && entry.data.message
      const text = messageText(message && message.content)
      if (text) return text
    }
  }
  return ''
}

/** 从 AI 回复中容错提取 JSON 对象（容忍 ```json 围栏与前后杂文本）。 */
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/u)
  const candidate = fenced !== null ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return undefined
  const slice = candidate.slice(start, end + 1)
  try {
    return JSON.parse(slice)
  } catch { }
  // v1.1.3 修复④容错：模型常把裸换行/制表符直接写进字符串值（非法 JSON）导致
  // JSON.parse 失败 → 整条 AI 总结回落为原始 JSON 文本。全部折叠为空格后重试
  // （字段之间的换行本是 JSON 合法空白，不受影响；content 内的分段由 formatSections 恢复）。
  try {
    return JSON.parse(slice.replace(/\r?\n/gu, ' ').replace(/\t/gu, ' '))
  } catch { }
  return undefined
}

function turnEndKind(reason) {
  if (typeof reason === 'string') return reason
  if (reason && typeof reason === 'object' && typeof reason.kind === 'string') return reason.kind
  return undefined
}

const AI_PROMPT_TEMPLATE = [
  '你是资深待办整理助手。把下面的材料整理成一条可执行、可验收的待办事项。',
  '严格输出 JSON（不要输出任何其他文字、不要用代码块包裹）：',
  '{',
  '  "title": "一句话标题（祈使句，动词开头，不超过16个字，不加书名号引号）",',
  '  "content": "结构化内容，排版必须美观：每个小节标题（如【需求】）都要独占一行、放在行首，标题后紧跟该小节文字；不同小节之间空一行；严禁把两个小节挤在同一行。小节（无内容可省略，顺序如下）：【需求】要解决什么；【目的】为什么做、预期价值；【计划】关键步骤与产出；【逻辑】实现思路/依赖关系；【边界】不做什么、限制条件；【验收方案】如何验证；【验收标准】达到什么标准算完成；【复盘总结】风险与注意事项。合计≤500字",',
  '  "reminder": "建议的评估/提醒时间；仅当材料有明确时间或可合理推断时输出，格式 YYYY-MM-DD HH:mm；否则 null",',
  '  "notify": "通知方式：popup=仅应用内弹窗，im=机器人推送，both=两者都要，none=不提醒；无法判断时输出 popup"',
  '}',
  '',
  '材料：',
  '<<<',
  '$TEXT',
  '>>>',
].join('\n')

/**
 * v1.1.2 规范化 AI 总结排版：确保每个【xx】小节标题独占行首、小节之间空一行。
 * 即使模型没完全遵守 prompt，也能保证美观可读。
 */
function formatSections(text) {
  if (!text) return text
  // ① 在每个【前补换行；② 按行切分、去空白；③ 小节之间空一行
  const lines = String(text)
    .replace(/[ \t]*【/g, '\n【')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
  const out = []
  for (const line of lines) {
    if (/^【/.test(line) && out.length > 0 && out[out.length - 1] !== '') out.push('')
    out.push(line)
  }
  return out.join('\n')
}

/**
 * v1.1.2 AI 记录默认提醒时间：把设置页枚举 key 解析成 ISO 字符串（基准 now）。
 * AI 无法从材料判断时间时兜底。''/none/未知 → undefined（不提醒）。
 */
/**
 * v1.5.11 统一的模型选择解析。
 *
 * 三处建会话的地方（aiCapture / aiSummarize / createFollowup）原来各写一遍
 * 「config.aiModel 优先 → agentDefaultModel.currentSelection() 兜底」，而且都只取
 * provider/model，把 reasoningEffort 丢了。思考强度是用户显式选的，丢了就等于
 * 设置页那个下拉不起作用；同时跟随默认时也应沿用默认选择的 effort。
 *
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined}
 */
function resolveModelSelection(ctx, configAiModel) {
  const fromConfig = configAiModel
  if (fromConfig && typeof fromConfig.provider === 'string' && typeof fromConfig.model === 'string'
    && fromConfig.provider.length > 0 && fromConfig.model.length > 0) {
    return {
      provider: fromConfig.provider,
      model: fromConfig.model,
      ...(typeof fromConfig.reasoningEffort === 'string' && fromConfig.reasoningEffort.length > 0
        ? { reasoningEffort: fromConfig.reasoningEffort }
        : {}),
    }
  }
  try {
    const resolved = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (resolved && typeof resolved.provider === 'string' && typeof resolved.model === 'string'
      && resolved.provider.length > 0 && resolved.model.length > 0) {
      return {
        provider: resolved.provider,
        model: resolved.model,
        ...(typeof resolved.reasoningEffort === 'string' && resolved.reasoningEffort.length > 0
          ? { reasoningEffort: resolved.reasoningEffort }
          : {}),
      }
    }
  } catch { }
  return undefined
}

/** 把 resolveModelSelection 的结果转成 agents.create 的 agentOptions。 */
function modelAgentOptions(selection) {
  if (selection === undefined) return {}
  return {
    agentOptions: {
      provider: selection.provider,
      model: selection.model,
      ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
    },
  }
}

function resolveAiDefaultReminder(key, now = new Date()) {
  const at = new Date(now)
  switch (key) {
    case '1h': at.setHours(at.getHours() + 1); return at.toISOString()
    case '3h': at.setHours(at.getHours() + 3); return at.toISOString()
    case 'today18':
      at.setMinutes(0, 0, 0); at.setHours(18)
      if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1)
      return at.toISOString()
    case 'tomorrow9':
      at.setDate(at.getDate() + 1); at.setHours(9, 0, 0, 0); return at.toISOString()
    case '3d':
      at.setDate(at.getDate() + 3); at.setHours(9, 0, 0, 0); return at.toISOString()
    default: return undefined
  }
}

/**
 * 创建 todos 服务对象。领域句柄惰性打开（apply 保持同步；
 * storageDomain 设施会在插件卸载时关闭仍打开的领域）。
 */
function createService(ctx) {
  let domainPromise
  let domain
  /** 进行中的 AI 捕获：captureSessionId → {text, sessionId, messageId}。 */
  const pendingCaptures = new Map()
  /**
   * v1.1.7 ↗ 新建会话后待自动完成的待办：followupSessionId → {todoId, startedAt}。
   * 新会话首条用户消息发出（turn/start）即消费，把待办标记 completed；
   * 30 分钟未发生则由 scanReminders 清理（用户最终没在新会话发消息）。
   */
  const pendingAutoComplete = new Map()

  /**
   * v1.3.0 发布加固：agents 从 inject 硬依赖降级为软依赖后，必须显式判空——
   * 缺服务时给一句中文提示，而不是让 `ctx.agents.create` 抛 TypeError。
   */
  const agentsOrThrow = () => {
    const agents = ctx.get('agents')
    if (!agents || typeof agents.create !== 'function') {
      throw new Error('宿主未提供 agents 服务：AI 记录待办不可用（列表/增删改等其余功能正常）')
    }
    return agents
  }

  /**
   * v1.3.0 发布加固：跨宿主去重令牌（机器人推送专用）。
   * 同一个 ~/.dsh 可能被桌面端与 Web 端两个宿主同时打开（共享同一份 storages），
   * 两边都会跑 30s 提醒扫描 → 同一条待办可能被推送两次；企微群消息发出即不可撤回，必须防重。
   * 做法：推送前用 file:'wx' 原子创建 <STATE_DIR>/claims/<id>@<这一轮的到期时刻>；
   * 创建失败（EEXIST）说明另一个宿主已经推过 → 本轮只标记不推。周期提醒下一轮到期时刻不同，不受影响。
   */
  const claimImPush = (item) => {
    try {
      const dir = path.join(STATE_DIR, 'claims')
      fs.mkdirSync(dir, { recursive: true })
      const stamp = item.dueAtMs ?? item.dueAt ?? 'na'
      const file = path.join(dir, `${encodeURIComponent(String(item.id))}@${encodeURIComponent(String(stamp))}`)
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' })
      return true
    } catch (error) {
      // 目录不可写等非抢占类错误：放行推送，避免因抢占机制本身漏提醒
      return error?.code !== 'EEXIST'
    }
  }

  /** 清理 14 天前的抢占令牌（scanReminders 每小时最多跑一次）。 */
  let lastClaimPruneAt = 0
  const pruneClaims = () => {
    try {
      const dir = path.join(STATE_DIR, 'claims')
      const now = Date.now()
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name)
        try { if (now - fs.statSync(full).mtimeMs > 14 * 24 * 3600 * 1000) fs.rmSync(full, { force: true }) } catch { }
      }
    } catch { }
  }

  let domainError
  /** 该句柄是否由本实例 open 出来（决定卸载时要不要 close；沿用他人句柄不关，避免误伤并发实例）。 */
  let ownsDomain = false

  /**
   * v1.5.1 修复（0.2.x 新框架报错）：DomainFacility 按 name 记名（reserved 集合），
   * 只有 Domain.close() 才释放。插件 fiber 被销毁后重新 apply（宿主热重载 / 配置变更 /
   * 窗口重开触发重新激活）时，上一实例的域仍占着该 name → 新实例 open() 抛
   * `already-open`，此后**所有读写永久失败**（用户看到「存储不可用」）。
   * 官方契约是「谁 open 谁 close」，这里在 apply 内同步注册 disposer 释放句柄。
   */
  const closeDomain = () => {
    const handle = domain
    const owned = ownsDomain
    domain = undefined
    domainPromise = undefined
    ownsDomain = false
    if (handle === undefined || !owned) return Promise.resolve()
    // 必须 await：disposer 返回 promise 时宿主会等它完成，句柄才真从设施上摘掉。
    // Domain.close() 本身幂等（facility 卸载时的 closeAll 再关一次也无害）。
    try { return Promise.resolve(handle.close?.()) } catch (error) { return Promise.resolve(error) }
  }

  /** 复用设施上「同名且仍打开」的域（上一实例遗留的句柄）；没有则返回 undefined。 */
  const adoptDomain = () => {
    let existing
    try { existing = ctx.storageDomain?.get?.(todoDomainSpec.name) } catch { }
    if (existing === undefined || existing.closed === true) return undefined
    return existing
  }

  const adopt = (handle, diag) => {
    domain = handle
    ownsDomain = false
    domainError = undefined
    appendDiag(diag)
    return handle
  }

  /** 真正拿句柄：先复用设施上的同名域，再 open；already-open 时短暂轮询等待并发 open 落地。 */
  const openDomain = async () => {
    const reused = adoptDomain()
    if (reused !== undefined) return adopt(reused, { domainReused: true })
    try {
      const handle = await ctx.storageDomain.open(todoDomainSpec)
      domain = handle
      ownsDomain = true
      domainError = undefined
      // v1.3.0：容错解析有抢救动作时留痕（哪几类坏数据被丢/被补，便于用户反馈时定位）
      if (tolerantStats.droppedItems > 0 || tolerantStats.repairedItems > 0 || tolerantStats.repairedConfig) {
        appendDiag({ tolerantParse: { ...tolerantStats } })
        try {
          console.warn(`[dsh-todo] 存储容错解析：丢弃 ${tolerantStats.droppedItems} 条、修复 ${tolerantStats.repairedItems} 条待办；配置修复=${tolerantStats.repairedConfig}`)
        } catch { }
      }
      return handle
    } catch (error) {
      if (error?.code === 'already-open') {
        // 并发 open 的瞬间：另一实例的 reserved 已占位、domains 还没写入，等它落地后沿用。
        for (let i = 0; i < 8; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 150))
          const late = adoptDomain()
          if (late !== undefined) return adopt(late, { domainReused: true, waitedMs: (i + 1) * 150 })
        }
      }
      domainError = error
      appendDiag({ domainOpenError: messageOf(error) })
      try { ctx.logger?.warn?.(`[dsh-todo] 打开存储域失败：${messageOf(error)}`) } catch { }
      return undefined
    }
  }

  /**
   * v1.3.0 发布加固：存储域打不开（文件损坏 / 旧版数据与 schema 不符 / 介质不可用）时
   * **绝不把异常抛进激活路径**——0.2.x 起宿主 fail-closed：任一插件激活失败会拒绝整个 web boot。
   * 这里捕获失败、记下原因并返回 undefined，读写入口转成中文友好错误；
   * 插件其余部分（工具注册、UI 槽位）照常加载，用户看到「存储不可用」而不是整个 DSH 起不来。
   */
  const ensureDomain = async () => {
    if (domain !== undefined) {
      // 句柄被外部关掉（facility 卸载 / 另一实例 closeAll）→ 重新打开，自愈而不是永久失败。
      if (domain.closed === true) {
        domain = undefined
        domainPromise = undefined
        ownsDomain = false
      } else {
        return domain
      }
    }
    if (domainPromise === undefined) {
      domainPromise = openDomain().then((handle) => {
        // 失败不缓存：允许后续调用重试（例如用户手工修好存储文件后）
        if (handle === undefined) domainPromise = undefined
        return handle
      })
    }
    return domainPromise
  }

  /** 取域句柄；不可用时抛出可读错误（各调用方均有 try/catch → 转成 { ok:false, error }）。 */
  const domainOrThrow = async () => {
    const handle = await ensureDomain()
    if (handle === undefined) {
      throw new Error(`存储不可用（待办数据无法读写）：${messageOf(domainError ?? '未知原因')}`)
    }
    return handle
  }

  const readState = async () => {
    const handle = await domainOrThrow()
    return handle.global.get()
  }

  const writeItems = async (items) => {
    const handle = await domainOrThrow()
    const state = handle.global.get()
    await handle.global.set({ ...state, items: pruneItems(items) })
  }

  const writeConfig = async (config) => {
    const handle = await domainOrThrow()
    const state = handle.global.get()
    await handle.global.set({ ...state, config })
  }

  /** v1.0 机器人推送：优先按全局配置的 bot/target，否则遍历全部 bot 第一个 target。 */
  const sendIm = async (item, globalNotify) => {
    const text = `⏰ 待办提醒：${item.title}${item.dueAt !== undefined ? `（计划：${item.dueAt}）` : ''}`
    // v1.1 优先级：单条 item 指定机器人 > 全局配置 > 遍历全部 bot
    const chosenBotId = item.imBotId || globalNotify.imBotId
    const chosenTargetId = item.imTargetId || globalNotify.imTargetId
    // v1.4.0 通用化：单条 item.imService > 全局 notify.service > 静态候选兜底
    const preferredService = item.imService || globalNotify.service
    for (const candidate of notifyCandidates(preferredService)) {
      const im = ctx.get(candidate)
      if (!im || typeof im.send !== 'function') continue
      if (chosenBotId && chosenTargetId) {
        try { await im.send(chosenBotId, chosenTargetId, text); return } catch { }
      }
      let bots = []
      try { bots = typeof im.listBots === 'function' ? await im.listBots() : [] } catch { }
      for (const bot of bots) {
        const botId = typeof bot === 'string' ? bot : (bot?.botId ?? bot?.id)
        if (botId === undefined) continue
        let targets = []
        try { targets = typeof im.listTargets === 'function' ? await im.listTargets(botId) : [] } catch { }
        const target = Array.isArray(targets) ? targets[0] : undefined
        const targetId = typeof target === 'string' ? target : (target?.targetId ?? target?.id)
        if (targetId === undefined) continue
        try { await im.send(botId, targetId, text); return } catch { }
      }
    }
  }

  /** v1.1 收集真实机器人（供客户端下拉）：单次尝试，遍历 IM 服务，返回 [{botId, channel, service, targets:[{targetId,name}]}]。 */
  const collectImBotsOnce = async () => {
    const result = []
    for (const candidate of notifyCandidates(undefined)) {
      const im = ctx.get(candidate)
      if (!im || typeof im.listBots !== 'function') continue
      let bots = []
      try { bots = await im.listBots() } catch { }
      for (const bot of bots) {
        const botId = typeof bot === 'string' ? bot : (bot?.botId ?? bot?.id)
        if (botId === undefined) continue
        const channel = typeof bot === 'object' && bot.channel ? String(bot.channel) : ''
        let targets = []
        try {
          const r = typeof im.listTargets === 'function' ? await im.listTargets(botId) : []
          targets = Array.isArray(r) ? r : (r?.targets ?? [])
        } catch { }
        const targetList = targets.map((t) => {
          const targetId = typeof t === 'string' ? t : (t?.targetId ?? t?.id)
          if (targetId === undefined) return null
          const name = typeof t === 'object' ? (t?.name ?? t?.title ?? t?.displayName ?? t?.targetName ?? '') : ''
          return { targetId, name }
        }).filter(Boolean)
        // v1.4.0 通用化：每个机器人打上来源服务名，客户端下拉据此在保存时回写 imService
        result.push({ botId, channel, service: candidate, targets: targetList })
      }
    }
    return result
  }

  /**
   * v1.1.2 修复③：就绪判定不能只看服务对象是否存在——
   * diag（im-bots-diag.json）实证：dshIm 服务对象 ~2s 就绪，但机器人清单 ~5s 才填充；
   * 旧逻辑在 2~5s 窗口内 isReady()=true → 提前返回空 → 设置页下拉只剩"全部机器人（默认）"。
   * 新逻辑：必须拉到非空清单才算就绪；拉不到就重试，等满总窗口（8×500ms=4s）再认空，
   * 兼容"确实没配机器人"的情况（设置页最多等 4s，不会卡死）。
   */
  const collectImBots = async () => {
    for (let i = 0; i < 8; i++) {
      const bots = await collectImBotsOnce()
      if (bots.length > 0) return bots
      if (i < 7) await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return []
  }

  const service = {
    async list(_request) {
      try {
        const state = await readState()
        return {
          ok: true,
          value: {
            items: state.items,
            ...(state.config.aiModel === undefined ? {} : { aiModel: state.config.aiModel }),
            ...(state.config.notify === undefined ? {} : { notify: state.config.notify }),
            ...(state.config.aiDefaultReminder ? { aiDefaultReminder: state.config.aiDefaultReminder } : {}),
            // v1.2.2 反馈⑤：左侧边栏显示开关；false 才下发（缺席 = 默认显示）
            ...(state.config.sidebarEnabled === false ? { sidebarEnabled: false } : {}),
          },
        }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    /** v1.1 列出真实机器人（企业微信/QQ/微信等）供下拉选择。 */
    async listImBots(_request) {
      // v1.1 诊断落盘：定位"机器人无清单"的真实原因（服务未就绪 / listBots 异常 / 返回空）
      const diag = { candidates: [], at: new Date().toISOString() }
      try {
        for (const candidate of NOTIFY_SERVICE_CANDIDATES) {
          let im
          try { im = ctx.get(candidate) } catch (e) { diag.candidates.push({ candidate, getError: messageOf(e) }); continue }
          const entry = {
            candidate,
            exists: !!im,
            methods: im ? Object.keys(im) : [],
            listBotsType: im ? typeof im.listBots : 'none',
          }
          if (im && typeof im.listBots === 'function') {
            try {
              const bots = await im.listBots()
              entry.botsRaw = Array.isArray(bots) ? bots : bots
              entry.botsCount = Array.isArray(bots) ? bots.length : -1
            } catch (e) { entry.listBotsError = messageOf(e) }
          }
          diag.candidates.push(entry)
        }
        const bots = await collectImBots()
        diag.collectedCount = bots.length
        appendDiag({ settingsCall: diag })
        return { ok: true, value: { bots } }
      } catch (error) {
        diag.fatal = messageOf(error)
        appendDiag({ settingsCall: diag })
        return { ok: false, error: messageOf(error) }
      }
    },

    /** 手动添加（弹窗表单）；支持单次/周期提醒与通知渠道。 */
    async add(request) {
      try {
        const content = normalizeText(request?.content, 2000)
        // v1.2.3 反馈③：划词路径标题同样收紧（划词原文直用会很长）
        let title = normalizeText(request?.title, 24)
        // v1.1 标题留空：从内容自动总结；标题和内容都为空才报错
        if (title.length === 0) {
          if (content.length === 0) return { ok: false, error: '请填写标题或内容' }
          title = deriveTitle(content)
        }
        const recurrence = validRecurrence(request?.recurrence)
        const due = recurrence !== undefined ? nextDueAt(recurrence) : parseDueAt(request?.dueAt)
        const items = (await readState()).items
        const duplicate = items.find((item) => item.status === 'pending' && item.title === title)
        if (duplicate !== undefined) {
          return { ok: true, value: { id: duplicate.id, pendingCount: summarize(items).pendingCount } }
        }
        const item = createItem({
          title,
          ...(content.length > 0 ? { content } : {}),
          source: request?.sessionId !== undefined ? 'selection' : 'manual',
          // due 含 dueAt/dueAtMs；周期时再带 recurrence
          due: due === undefined ? undefined : { ...due, ...(recurrence === undefined ? {} : { recurrence }) },
          ...(request?.sessionId === undefined ? {} : { sessionId: request.sessionId }),
          ...(request?.messageId === undefined ? {} : { messageId: request.messageId }),
          ...(request?.anchorText ? { anchorText: String(request.anchorText).slice(0, 120) } : {}),
          // 通知渠道（显式布尔）
          ...(request?.notifyPopup === undefined ? {} : { notifyPopup: request.notifyPopup === true }),
          ...(request?.notifyIm === undefined ? {} : { notifyIm: request.notifyIm === true }),
          // v1.1 单条机器人（留空跟随全局）
          ...(request?.imBotId ? { imBotId: normalizeText(request.imBotId, 128) } : {}),
          ...(request?.imTargetId ? { imTargetId: normalizeText(request.imTargetId, 128) } : {}),
          // v1.4.0 通用化：单条机器人来源服务名（缺省跟随全局/遍历候选）
          ...(request?.imService ? { imService: normalizeText(request.imService, 64) } : {}),
        })
        await writeItems([...items, item])
        return { ok: true, value: { id: item.id, pendingCount: summarize([...items, item]).pendingCount } }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    /** AI 记录待办：开临时 agent 会话总结，turn/end 后自动入列。 */
    async aiCapture(request) {
      try {
        const text = normalizeText(request?.text, 4000)
        if (text.length === 0) return { ok: false, error: '划词内容为空' }
        if (pendingCaptures.size >= 3) return { ok: false, error: '已有多个 AI 总结在进行中，请稍候' }

        const state = await readState()
        // 模型解析：用户偏好优先，否则跟随当前会话默认模型（v1.5.11 统一到
        // resolveModelSelection，顺带带上思考强度）
        const selection = resolveModelSelection(ctx, state.config.aiModel)

        // v1.1 修复：必须显式生成并传入 sessionId，否则内部 agent id 为 undefined，
        // followup 报 "agent id undefined does not match session id ..."（参照 dsh-tasks）。
        const sessionId = `session-${randomUUID()}`
        const handle = await agentsOrThrow().create({
          sessionId,
          meta: { cwd: process.cwd() },
          ...modelAgentOptions(selection),
          setup: async (agentCtx) => {
            try {
              const presets = ctx.get('agentPresets')
              const resolved = await presets?.resolve?.(undefined)
              if (resolved && resolved.id) await presets.mount(agentCtx, resolved.id)
            } catch { }
          },
        })
        try {
          handle.agent.session.append('session/title', {
            title: `待办 AI 记录 · ${new Date().toISOString().slice(5, 16).replace('T', ' ')}`,
            messageSeqs: [],
            source: { kind: 'user' },
          })
        } catch { }
        const prompt = AI_PROMPT_TEMPLATE.replace('$TEXT', text)
        handle.agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'dsh-todo' },
        })
        pendingCaptures.set(sessionId, {
          text,
          ...(request?.sessionId === undefined ? {} : { sessionId: request.sessionId }),
          ...(request?.messageId === undefined ? {} : { messageId: request.messageId }),
          ...(request?.anchorText ? { anchorText: String(request.anchorText).slice(0, 120) } : {}),
          startedAt: Date.now(),
        })
        return { ok: true, value: { started: true } }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    /**
     * v1.1.6 反馈⑤：行内「转 AI 总结」——以已有待办的内容为材料，走与 aiCapture
     * 相同的临时 agent 会话流程；turn/end 入列新条目后删除旧条目（replaceId）。
     */
    async aiSummarizeItem(request) {
      try {
        const id = normalizeText(request?.id, 100)
        if (id.length === 0) return { ok: false, error: '缺少待办 id' }
        const state = await readState()
        const target = state.items.find((it) => it.id === id)
        if (target === undefined) return { ok: false, error: '待办不存在' }
        const material = normalizeText(target.content ?? target.title, 4000)
        if (material.length === 0) return { ok: false, error: '待办内容为空' }
        if (pendingCaptures.size >= 3) return { ok: false, error: '已有多个 AI 总结在进行中，请稍候' }

        // 模型解析与 aiCapture 相同：偏好优先 → 会话默认兜底（v1.5.11 统一）
        const selection = resolveModelSelection(ctx, state.config.aiModel)
        const sessionId = `session-${randomUUID()}`
        const handle = await agentsOrThrow().create({
          sessionId,
          meta: { cwd: process.cwd() },
          ...modelAgentOptions(selection),
          setup: async (agentCtx) => {
            try {
              const presets = ctx.get('agentPresets')
              const resolved = await presets?.resolve?.(undefined)
              if (resolved && resolved.id) await presets.mount(agentCtx, resolved.id)
            } catch { }
          },
        })
        try {
          handle.agent.session.append('session/title', {
            title: `待办 AI 重新总结 · ${new Date().toISOString().slice(5, 16).replace('T', ' ')}`,
            messageSeqs: [],
            source: { kind: 'user' },
          })
        } catch { }
        const prompt = AI_PROMPT_TEMPLATE.replace('$TEXT', material)
        handle.agent.followup({
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'dsh-todo' },
        })
        pendingCaptures.set(sessionId, {
          text: material,
          replaceId: id,
          startedAt: Date.now(),
        })
        return { ok: true, value: { started: true } }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    /**
     * v1.1.1 以待办为蓝本，在同一工作区新建会话并固定标题。
     * 内容预填由客户端写 localStorage 草稿（per-session 持久化），本方法只负责
     * 建会话（工作区跟随、挂默认工具）+ 标题，避免 client 端 sessions.rename 不存在。
     * v1.1.7 增强：①模型优先用代办设置的 AI 模型偏好（config.aiModel），无则跟随会话默认；
     * ②传 todoId 时登记 pendingAutoComplete——新会话首条用户消息发出（turn/start）
     *   即把该待办标记 completed（"点击发送/运行后代办自动完成"）。
     */
    async createFollowup(request) {
      try {
        const workspaceId = normalizeText(request?.workspaceId, 200)
        const title = normalizeText(request?.title, 120)
        const todoId = normalizeText(request?.todoId, 100)
        if (title.length === 0) return { ok: false, error: '标题为空' }

        // ① 解析工作区与 cwd（client 传来的 workspaceId = registry 的 workspace id）
        const sourceSessionId = normalizeText(request?.sourceSessionId, 200)
        let cwd = process.cwd()
        let workspace
        if (workspaceId) {
          try {
            const registry = ctx.get('workspaceRegistry')
            workspace = registry?.get?.(workspaceId)
            if (workspace?.path) {
              // v1.2.3 反馈①：realpath 归一——attachSession 校验 realpathNormalize(header.cwd) === record.path，
              // meta.cwd 必须与工作区 path 同源（Windows 盘符大小写 / 短路径差异会让校验必败）
              try { cwd = realpathSync(workspace.path); workspace.path = cwd } catch { cwd = workspace.path }
            } else {
              // v1.2.3 反馈①：registry 有条目但无 path / get 返回空 → 落 diag（此前静默用 process.cwd()，
              // 后续 attachSession 必然 cwd 校验失败）
              appendDiag({ followupWorkspaceMissing: true, workspaceId, hasRegistry: !!registry, at: new Date().toISOString() })
            }
          } catch (e) {
            appendDiag({ followupWorkspaceError: messageOf(e) })
          }
        } else if (sourceSessionId) {
          // v1.2.3 反馈①兜底：客户端 renderer 快照查不到源会话归属（workspaceOfSession 返回空）时，
          // 用宿主 workspaceRegistry.list() 反查（entity.sessionIds 按 header-cwd 索引过滤，是宿主真相）
          try {
            const registry = ctx.get('workspaceRegistry')
            const hit = registry?.list?.().find((w) => Array.isArray(w?.sessionIds) && w.sessionIds.includes(sourceSessionId))
            if (hit) {
              workspace = hit
              if (hit.path) { try { cwd = realpathSync(hit.path); hit.path = cwd } catch { cwd = hit.path } }
            } else {
              // v1.2.6 反馈①：源会话确实不属于任何工作区（AI 临时会话/归属失效）时不再留空——
              // fallback 到第一个工作区，保证新会话总有归属（用户语义：自动选工作区，同划词时）。
              // 完全无工作区（list 空）才保持现状。diag 记 followupSourceFallback 便于追踪。
              const all = registry?.list?.() ?? []
              const fallback = all[0]
              if (fallback?.path) {
                workspace = fallback
                try { cwd = realpathSync(fallback.path); fallback.path = cwd } catch { cwd = fallback.path }
                appendDiag({ followupSourceFallback: true, sourceSessionId, workspaceId: fallback.id, at: new Date().toISOString() })
              } else {
                appendDiag({ followupSourceUnknown: true, sourceSessionId, at: new Date().toISOString() })
              }
            }
          } catch (e) {
            appendDiag({ followupSourceLookupError: messageOf(e) })
          }
        }

        // ② 模型选择（v1.2.7 反馈③）：新会话模型 = 划词时源会话的模型。
        // 三级：①源会话活 agent 的 session.requestHeader()?.config（provider/model，宿主真相无 IPC 滞后）
        // → ②代办 AI 记录偏好 config.aiModel → ③全局 agentDefaultModel.currentSelection()。
        // diag 记 followupModelSource（'session'/'config'/'default'/'none'）便于验收追踪。
        let selection
        let modelSource = 'none'
        if (sourceSessionId) {
          try {
            // v1.5.11：`ctx.agents` 同样是硬注入属性，不在 inject 里访问会抛错，
            // `?.` 拦不住。改用 ctx.get('agents') 这条官方可选访问路径。
            const agent = ctx.get?.('agents')?.get?.(sourceSessionId)
            const cfg = agent?.session?.requestHeader?.()?.config
            if (typeof cfg?.provider === 'string' && cfg.provider && typeof cfg?.model === 'string' && cfg.model) {
              // v1.5.11：源会话的思考强度也一起继承，否则新会话会悄悄退回模型默认档
              selection = {
                provider: cfg.provider,
                model: cfg.model,
                ...(typeof cfg.reasoningEffort === 'string' && cfg.reasoningEffort.length > 0
                  ? { reasoningEffort: cfg.reasoningEffort }
                  : {}),
              }
              modelSource = 'session'
            }
          } catch { }
        }
        if (!selection) {
          selection = (await readState()).config.aiModel
          if (selection) modelSource = 'config'
        }
        if (!selection) {
          try {
            // v1.5.11：`ctx.agentDefaultModel` 是硬注入属性，不在 inject 里访问会抛
            // 「cannot get property "agentDefaultModel" without inject」，`?.` 拦不住。
            // 官方给的可选访问方式是 ctx.get(name)。
            const resolved = ctx.get?.('agentDefaultModel')?.currentSelection?.()
            if (resolved?.provider && resolved?.model) { selection = resolved; modelSource = 'default' }
          } catch { }
        }
        appendDiag({ followupModelSource: modelSource, sourceSessionId: sourceSessionId ?? '', at: new Date().toISOString() })

        // ③ 建会话（挂默认工具 preset，否则新会话无工具）
        const sessionId = `session-${randomUUID()}`
        const handle = await agentsOrThrow().create({
          sessionId,
          meta: { cwd },
          ...(selection ? modelAgentOptions(selection) : {}),
          setup: async (agentCtx) => {
            try {
              const presets = ctx.get('agentPresets')
              const resolved = await presets?.resolve?.(undefined)
              if (resolved?.id) await presets.mount(agentCtx, resolved.id)
            } catch { }
          },
        })
        // ③½ v1.2.3 反馈①：归属挂接——attachSession（校验 header.cwd 后把会话写进工作区清单）。
        // 官方 session-controller 同款调用（create → agents.create(meta.cwd) → attachSession），
        // attach 失败落 diag（此前 catch{} 完全静默，cwd 校验失败看不到）。
        if (workspace) {
          try {
            await workspace.attachSession(sessionId)
          } catch (e) {
            appendDiag({ followupAttachError: messageOf(e), workspaceId, cwd, at: new Date().toISOString() })
          }
        } else if (workspaceId) {
          appendDiag({ followupNoWorkspace: true, workspaceId, at: new Date().toISOString() })
        }

        // ④ 固定标题（source user，阻止自动标题覆盖）
        try {
          handle.agent.session.append('session/title', {
            title,
            messageSeqs: [],
            source: { kind: 'user' },
          })
        } catch (e) { appendDiag({ followupTitleError: messageOf(e) }) }

        // ⑤ v1.1.7 发送后自动完成：登记待完成映射，handleSessionEvent 的 turn/start 分支消费
        if (todoId.length > 0) {
          pendingAutoComplete.set(sessionId, { todoId, startedAt: Date.now() })
        }

        return { ok: true, value: { sessionId } }
      } catch (error) {
        // v1.1.8 排障：宿主侧失败落 diag，客户端 toast 只有一句 message 不够定位
        try { appendDiag({ followupError: messageOf(error), at: new Date().toISOString() }) } catch { }
        return { ok: false, error: messageOf(error) }
      }
    },

    /**
     * v1.4.0 转官方定时任务（自装 dsh-tasks 优先、官方 dsh-schedule 兜底）。
     * 客户端 fetch /dsh-tasks/api 失败或未装时，回退到这里直调 ctx.get('schedule').create。
     * request 与官方 schedule.create 的 request 同构（snake_case 六选一 selector）。
     */
    async convertToSchedule(request) {
      try {
        const schedule = ctx.get('schedule')
        if (!schedule || typeof schedule.create !== 'function') {
          return { ok: false, error: '未检测到官方定时任务服务（dsh-schedule），且自装定时任务插件（dsh-tasks）不可用。' }
        }
        const title = normalizeText(request?.title, 120)
        const prompt = normalizeText(request?.prompt, 4000)
        if (title.length === 0) return { ok: false, error: '定时任务标题不能为空' }
        if (prompt.length === 0) return { ok: false, error: '定时任务内容不能为空' }
        const sessionId = request?.sessionId
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          return { ok: false, error: '缺少来源会话 ID，无法绑定定时任务' }
        }
        // 六选一 selector 原样透传（官方 create 会校验「恰好一个」）
        const selector = {}
        if (request?.at !== undefined) selector.at = request.at
        if (request?.after_seconds !== undefined) selector.after_seconds = request.after_seconds
        if (request?.every_seconds !== undefined) selector.every_seconds = request.every_seconds
        if (request?.daily !== undefined) selector.daily = request.daily
        if (request?.weekly !== undefined) selector.weekly = request.weekly
        if (request?.cron !== undefined) selector.cron = request.cron
        const record = await schedule.create(sessionId, { title, prompt, ...selector })
        return { ok: true, value: { scheduleId: record?.id ?? '' } }
      } catch (error) {
        appendDiag({ convertToScheduleError: messageOf(error) })
        return { ok: false, error: messageOf(error) }
      }
    },

    /**
     * 记住 AI 总结的模型偏好。
     * v1.5.11：加思考强度（reasoningEffort）。空串表示不指定，回落模型自身默认。
     */
    async setAiModel(request) {
      try {
        const provider = normalizeText(request?.provider, 100)
        const model = normalizeText(request?.model, 100)
        const effort = normalizeText(request?.reasoningEffort, 60)
        const state = await readState()
        // v1.1 两者都为空 = 清除偏好，跟随当前会话默认模型
        if (provider.length === 0 && model.length === 0) {
          const nextConfig = { ...state.config }
          delete nextConfig.aiModel
          await writeConfig(nextConfig)
          return { ok: true }
        }
        if (provider.length === 0 || model.length === 0) return { ok: false, error: '参数无效' }
        const aiModel = { provider, model, ...(effort.length === 0 ? {} : { reasoningEffort: effort }) }
        await writeConfig({ ...state.config, aiModel })
        return { ok: true }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    /**
     * v1.5.11 反馈②：获取 DSH 已配置的模型列表（按 provider 分组）。
     *
     * 旧实现只走 `ctx.get('llm').listProviders()`，在桌面端实测拿回空数组 ——
     * 该服务在插件里是软依赖，适配器注册时机与插件激活顺序无关，插件先激活时
     * listProviders() 还没注册任何 provider，下拉就只剩「跟随当前会话默认模型」一项。
     *
     * 现在补第二条路径：`ctx.get('sessionController')` 的 `modelCatalog()`，那是官方
     * 模型选择器（dsh-client-ui-model-selection）用的同一个数据源，由宿主按当前
     * Host generation 汇总出「真正可路由」的 provider / 模型 / 思考强度，
     * 还带 routableProviders 与 failures。llm 路径保留作降级。
     */
    async listModels(_request) {
      try {
        // v1.5.11 修复：这里原来写 `ctx.agentDefaultModel?.currentSelection?.()`，
        // 而 agentDefaultModel 是硬注入属性 —— 没进 inject 时访问立刻抛
        // 「cannot get property "agentDefaultModel" without inject」（`?.` 拦不住），
        // 异常被外层 catch 吃掉后 listModels 永远返回失败，模型下拉只剩「跟随」一项。
        // 官方给的可选访问方式是 ctx.get(name)。
        let defaultSelection = { provider: '', model: '' }
        try {
          const resolved = ctx.get?.('agentDefaultModel')?.currentSelection?.()
          if (resolved && typeof resolved === 'object') {
            defaultSelection = { provider: resolved.provider ?? '', model: resolved.model ?? '' }
          }
        } catch { /* 没有该服务就用空默认值 */ }
        const fallbackDefault = { provider: defaultSelection.provider, model: defaultSelection.model }

        // ① 首选：sessionController.modelCatalog()，与官方选择器同源
        const controller = ctx.get('sessionController')
        if (controller && typeof controller.modelCatalog === 'function') {
          try {
            const catalog = await controller.modelCatalog()
            const groups = Array.isArray(catalog?.groups)
              ? catalog.groups
                  .filter((group) => Array.isArray(group?.models) && group.models.length > 0)
                  .map((group) => ({
                    id: String(group.id ?? ''),
                    name: String(group.name ?? group.id ?? ''),
                    models: group.models.map((model) => ({
                      id: String(model.id ?? ''),
                      name: String(model.name ?? model.id ?? ''),
                      ...(typeof model.description === 'string' ? { description: model.description } : {}),
                      ...(model.reasoning === undefined ? {} : {
                        reasoning: {
                          efforts: (model.reasoning?.efforts ?? []).map((effort) => ({
                            id: String(effort.id ?? ''),
                            name: String(effort.name ?? effort.id ?? ''),
                            ...(typeof effort.description === 'string' ? { description: effort.description } : {}),
                          })),
                          ...(typeof model.reasoning?.defaultEffort === 'string' ? { defaultEffort: model.reasoning.defaultEffort } : {}),
                        },
                      }),
                    })),
                  }))
              : []
            if (groups.length > 0) {
              return {
                ok: true,
                value: {
                  default: {
                    provider: String(catalog?.default?.provider ?? fallbackDefault.provider),
                    model: String(catalog?.default?.model ?? fallbackDefault.model),
                    ...(typeof catalog?.default?.reasoningEffort === 'string' ? { reasoningEffort: catalog.default.reasoningEffort } : {}),
                  },
                  groups,
                  routableProviders: Array.isArray(catalog?.routableProviders) ? catalog.routableProviders : [],
                  failures: Array.isArray(catalog?.failures) ? catalog.failures : [],
                  source: 'modelCatalog',
                },
              }
            }
          } catch (error) {
            appendDiag({ listModelsCatalogError: messageOf(error) })
          }
        }

        // ② 降级：llm.listProviders()
        const llm = ctx.get('llm')
        let groups = []
        if (llm && typeof llm.listProviders === 'function') {
          const providers = llm.listProviders()
          groups = (await Promise.all(providers.map(async (provider) => {
            try {
              const models = await llm.listModels(provider.id)
              if (!Array.isArray(models) || models.length === 0) return undefined
              return {
                id: provider.id,
                name: provider.name ?? provider.id,
                models: models.map((model) => ({ id: model.id, name: model.name ?? model.id })),
              }
            } catch {
              return undefined
            }
          }))).filter((group) => group !== undefined)
        }
        return {
          ok: true,
          value: {
            default: fallbackDefault,
            groups,
            source: 'llm',
          },
        }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    async setStatus(request) {
      try {
        const { id, status } = request ?? {}
        if (id === undefined || (status !== 'pending' && status !== 'completed')) {
          return { ok: false, error: '参数无效：需要 id 与 status' }
        }
        const items = (await readState()).items
        const target = items.find((item) => item.id === id)
        if (target === undefined) return { ok: false, error: `未找到待办 ${id}` }
        if (target.status !== status) {
          const next = items.map((item) => item.id === id
            ? { ...item, status, doneAt: status === 'completed' ? Date.now() : undefined }
            : item)
          await writeItems(next)
        }
        return { ok: true, value: { pendingCount: summarize((await readState()).items).pendingCount } }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    /** 放弃待办：可选填原因/背景。 */
    async abandon(request) {
      try {
        const { id, reason } = request ?? {}
        if (id === undefined) return { ok: false, error: '参数无效：需要 id' }
        const items = (await readState()).items
        const target = items.find((item) => item.id === id)
        if (target === undefined) return { ok: false, error: `未找到待办 ${id}` }
        if (target.status === 'pending') {
          const cleanReason = normalizeText(reason, 500)
          const next = items.map((item) => item.id === id
            ? {
              ...item,
              status: 'abandoned',
              doneAt: Date.now(),
              ...(cleanReason.length > 0 ? { abandonReason: cleanReason } : {}),
            }
            : item)
          await writeItems(next)
        }
        return { ok: true, value: { pendingCount: summarize((await readState()).items).pendingCount } }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    /** 延期待办：更新提醒时间并重置提醒触发标记。 */
    async defer(request) {
      try {
        const { id, dueAt } = request ?? {}
        if (id === undefined || dueAt === undefined) return { ok: false, error: '参数无效：需要 id 与 dueAt' }
        const due = parseDueAt(dueAt)
        if (due === undefined) return { ok: false, error: `无法解析提醒时间：${dueAt}` }
        const items = (await readState()).items
        const target = items.find((item) => item.id === id)
        if (target === undefined) return { ok: false, error: `未找到待办 ${id}` }
        const next = items.map((item) => item.id === id ? { ...item, ...due, reminded: false } : item)
        await writeItems(next)
        return { ok: true, value: { pendingCount: summarize(next).pendingCount } }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    /**
     * v0.9.9 编辑代办（增量更新）：标题/内容/提醒时间/通知方式/转定时任务标记。
     * 字段给空串表示清除（content、dueAt）；notifyMode 给 global 表示清除覆盖。
     */
    async update(request) {
      try {
        const { id } = request ?? {}
        if (id === undefined) return { ok: false, error: '参数无效：需要 id' }
        const items = (await readState()).items
        const target = items.find((item) => item.id === id)
        if (target === undefined) return { ok: false, error: `未找到待办 ${id}` }
        const next = items.map((item) => {
          if (item.id !== id) return item
          const merged = { ...item, updatedAt: Date.now() }
          // 内容（允许清空）——先处理，供标题自动总结使用
          if (request.content !== undefined) {
            const nextContent = normalizeText(request.content, 2000)
            if (nextContent.length > 0) merged.content = nextContent
            else delete merged.content
          }
          // 标题：非空用传入；明确清空则从内容自动总结（v1.1）
          const nextTitle = normalizeText(request.title, 200)
          if (nextTitle.length > 0) merged.title = nextTitle
          else if (typeof request.title === 'string' && request.title.trim().length === 0) {
            merged.title = deriveTitle(merged.content ?? '')
          }
          // 周期提醒（v1.0）
          if (request.recurrence !== undefined) {
            const recurrence = validRecurrence(request.recurrence)
            if (recurrence !== undefined) {
              merged.recurrence = recurrence
              const due = nextDueAt(recurrence)
              if (due !== undefined) { Object.assign(merged, due); merged.reminded = false; merged.imSent = false }
            } else {
              delete merged.recurrence
              if (request.dueAt === undefined) { delete merged.dueAt; delete merged.dueAtMs; merged.reminded = false }
            }
          }
          // 单次提醒（非周期时生效；传 '' 清除）
          if (request.dueAt !== undefined && merged.recurrence === undefined) {
            if (request.dueAt === '') {
              delete merged.dueAt; delete merged.dueAtMs; merged.reminded = false; merged.imSent = false
            } else {
              const due = parseDueAt(request.dueAt)
              if (due !== undefined) { Object.assign(merged, due); merged.reminded = false; merged.imSent = false }
            }
          }
          // 通知渠道多选（v1.0）
          if (request.notifyPopup !== undefined) merged.notifyPopup = request.notifyPopup === true
          if (request.notifyIm !== undefined) {
            merged.notifyIm = request.notifyIm === true
            if (merged.notifyIm === false) merged.imSent = false
          }
          // 用新表单编辑后，清除旧的单值字段
          if (request.notifyPopup !== undefined || request.notifyIm !== undefined) delete merged.notifyMode
          // v1.1 单条机器人指定（空串=跟随全局，删除字段）
          if (request.imBotId !== undefined) {
            const botId = normalizeText(request.imBotId, 128)
            if (botId.length > 0) merged.imBotId = botId
            else delete merged.imBotId
          }
          if (request.imTargetId !== undefined) {
            const targetId = normalizeText(request.imTargetId, 128)
            if (targetId.length > 0) merged.imTargetId = targetId
            else delete merged.imTargetId
          }
          // v1.4.0 通用化：单条机器人来源服务名（空串=跟随全局，删除字段）
          if (request.imService !== undefined) {
            const svc = normalizeText(request.imService, 64)
            if (svc.length > 0) merged.imService = svc
            else delete merged.imService
          }
          // 转定时任务
          if (request.handedToTasks !== undefined) merged.handedToTasks = request.handedToTasks === true
          // 应用内弹窗已触发标记（客户端弹窗关闭回写）
          if (request.reminded !== undefined) merged.reminded = request.reminded === true
          return merged
        })
        await writeItems(next)
        return { ok: true, value: { pendingCount: summarize(next).pendingCount } }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    async deleteTodo(request) {
      try {
        const { id } = request ?? {}
        if (id === undefined) return { ok: false, error: '参数无效：需要 id' }
        const items = (await readState()).items
        const next = items.filter((item) => item.id !== id)
        if (next.length === items.length) return { ok: false, error: `未找到待办 ${id}` }
        await writeItems(next)
        return { ok: true, value: { pendingCount: summarize(next).pendingCount } }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    async clearCompleted(_request) {
      try {
        const next = (await readState()).items.filter((item) => item.status === 'pending')
        await writeItems(next)
        return { ok: true, value: { pendingCount: summarize(next).pendingCount } }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    /** 面板展开时清除 AI 绿点。 */
    async markSeen(_request) {
      try {
        const items = (await readState()).items
        if (items.some((item) => item.aiUnseen === true)) {
          await writeItems(items.map((item) => item.aiUnseen === true ? { ...item, aiUnseen: false } : item))
        }
        return { ok: true }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    /**
     * 内置提醒引擎扫描（30s 一次）：到期待办标记 reminded 并推送。
     * 推送走软依赖 dsh-im（全部 bot × 每个 bot 第一个目标）；不可用则仅标记。
     */
    /** v1.0 扫描到期代办：按多选渠道（应用内/机器人可同时）通知，周期滚动、单次标记。 */
    async scanReminders() {
      try {
        // v1.1.7 清理过期 pendingAutoComplete（30 分钟未发首条消息的 ↗ 会话）
        const nowMs = Date.now()
        for (const [sid, entry] of pendingAutoComplete) {
          if (nowMs - entry.startedAt > 30 * 60 * 1000) pendingAutoComplete.delete(sid)
        }
        const state = await readState()
        const globalNotify = state.config.notify ?? {}
        const due = dueItems(state.items)
        // v1.3.0：抢占令牌每小时清理一次（桌面端与 Web 端共用一份 storages）
        if (nowMs - lastClaimPruneAt > 3600_000) { lastClaimPruneAt = nowMs; pruneClaims() }
        if (due.length === 0) return
        const imSentIds = new Set()
        const handledIds = new Set() // 不需要应用内弹窗的，本轮直接完成/滚动
        for (const item of due) {
          const channels = resolveNotify(item, globalNotify)
          // 机器人推送（imSent 进程内防重 + claimImPush 跨宿主防重）
          if (channels.im && item.imSent !== true) {
            if (claimImPush(item)) {
              await sendIm(item, globalNotify)
            }
            // 无论本轮是否由本宿主推送，都记为已推：另一个宿主已经发过群消息，不能再发第二次
            imSentIds.add(item.id)
          }
          // 应用内弹窗：交给客户端 GlobalReminderPopup，不在此处理
          if (!channels.popup) handledIds.add(item.id)
        }
        let items = (await readState()).items
        if (imSentIds.size > 0) {
          items = items.map((i) => imSentIds.has(i.id) ? { ...i, imSent: true } : i)
        }
        if (handledIds.size > 0) {
          items = items.map((i) => {
            if (!handledIds.has(i.id)) return i
            // 周期：滚动下一次；单次/无周期：标记结束
            if (i.recurrence) {
              const next = nextDueAt(i.recurrence)
              return next ? { ...i, ...next, reminded: false, imSent: false } : { ...i, reminded: true }
            }
            return { ...i, reminded: true }
          })
        }
        if (imSentIds.size > 0 || handledIds.size > 0) await writeItems(items)
      } catch (error) {
        // v1.3.0：不再静默吞错（原先 catch { }），至少留下可诊断线索
        appendDiag({ scanRemindersError: messageOf(error) })
      }
    },

    /**
     * v1.0 应用内弹窗处理完毕（客户端弹窗关闭后调用）：
     * 周期 → 滚动下一次；单次 → 标记 reminded。
     */
    async reminderHandled(request) {
      try {
        const { id } = request ?? {}
        if (id === undefined) return { ok: false, error: '参数无效：需要 id' }
        const items = (await readState()).items
        const next = items.map((i) => {
          if (i.id !== id) return i
          if (i.recurrence) {
            const due = nextDueAt(i.recurrence)
            return due ? { ...i, ...due, reminded: false, imSent: false } : { ...i, reminded: true }
          }
          return { ...i, reminded: true }
        })
        await writeItems(next)
        return { ok: true, value: { pendingCount: summarize(next).pendingCount } }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    /** v1.0 保存全局通知渠道（popup/im/bot/target）。 */
    async saveNotifyConfig(request) {
      try {
        const state = await readState()
        const prev = state.config.notify ?? {}
        const notify = { ...prev }
        if (request?.popup !== undefined) notify.popup = request.popup === true
        if (request?.im !== undefined) notify.im = request.im === true
        if (request?.imBotId !== undefined) notify.imBotId = normalizeText(request.imBotId, 100)
        if (request?.imTargetId !== undefined) notify.imTargetId = normalizeText(request.imTargetId, 100)
        // v1.4.0 通用化：全局默认机器人来源服务名（空串=清除）
        if (request?.service !== undefined) {
          const svc = normalizeText(request.service, 64)
          if (svc.length > 0) notify.service = svc
          else delete notify.service
        }
        // v1.1.2 AI 记录默认提醒时间
        const nextConfig = { ...state.config, notify }
        if (request?.aiDefaultReminder !== undefined) {
          nextConfig.aiDefaultReminder = normalizeText(request.aiDefaultReminder, 20)
        }
        // v1.2.2 反馈⑤：左侧边栏显示开关持久化
        if (request?.sidebarEnabled !== undefined) {
          nextConfig.sidebarEnabled = request.sidebarEnabled === true
        }
        await writeConfig(nextConfig)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: messageOf(error) }
      }
    },

    /** session/event 监听入口：AI 捕获会话的 turn/end → 解析入列。 */
    async handleSessionEvent(session, event) {
      // v1.1.7 ↗ 新建会话自动完成：followup 会话首条用户消息发出（turn/start）→ 待办标记 completed
      if (event && event.type === 'turn/start') {
        const followupSessionId = session && session.id
        const pendingAuto = pendingAutoComplete.get(followupSessionId)
        if (pendingAuto !== undefined) {
          pendingAutoComplete.delete(followupSessionId)
          try {
            const items = (await readState()).items
            const target = items.find((item) => item.id === pendingAuto.todoId)
            if (target !== undefined && target.status === 'pending') {
              const next = items.map((item) => item.id === pendingAuto.todoId
                ? { ...item, status: 'completed', doneAt: Date.now() }
                : item)
              await writeItems(next)
            }
          } catch (e) { appendDiag({ autoCompleteError: messageOf(e) }) }
        }
        return
      }
      if (!event || event.type !== 'turn/end') return
      const sessionId = session && session.id
      const capture = pendingCaptures.get(sessionId)
      if (capture === undefined) return
      pendingCaptures.delete(sessionId)
      try {
        const kind = turnEndKind(event.data?.reason ?? event.reason)
        const reply = lastAssistantText(sessionEventsOf(session))
        if (kind !== 'completed' && kind !== 'max-tokens') return
        const parsed = extractJson(reply)
        // v1.1.3 修复④：改用保留换行的归一化（旧行为 normalizeText 把换行压成空格，AI 分段全毁）
        const rawContent = normalizeMultiline(parsed?.content ?? capture.text, 2000)
        // v1.1.2 排版：【xx】小节独占行首、小节间空行；无小节标记时仅做行清理，无害
        const content = formatSections(rawContent)
        // v1.1 AI 没给出标题：从内容自动总结（先剥掉【xx】小节标记，避免标题变成「【需求】…」）
        // v1.2.3 反馈③：标题收紧——AI 已按要求 ≤16 字，这里截到 24 字兜底
        let title = normalizeText(parsed?.title, 24)
        if (title.length === 0) {
          const stripped = content.replace(/【[^】]*】/gu, ' ').replace(/\s+/gu, ' ').trim()
          title = deriveTitle(stripped.length > 0 ? stripped : content)
        }
        let due = parsed?.reminder !== undefined && parsed.reminder !== null ? parseDueAt(parsed.reminder) : undefined
        // v1.1.2 AI 没判断出时间：用设置页“默认提醒时间”兜底
        if (due === undefined) {
          try {
            const cfg = (await readState()).config
            const fallbackIso = resolveAiDefaultReminder(cfg.aiDefaultReminder)
            if (fallbackIso) due = parseDueAt(fallbackIso)
          } catch { }
        }
        // v1.1 AI 建议的通知方式：popup/im/both/none
        const notifyMap = {
          popup: { notifyPopup: true, notifyIm: false },
          im: { notifyPopup: false, notifyIm: true },
          both: { notifyPopup: true, notifyIm: true },
          none: { notifyPopup: false, notifyIm: false },
        }
        const notify = notifyMap[String(parsed?.notify ?? '').toLowerCase()]
        let items = (await readState()).items
        // v1.1.6 反馈⑤：行内转 AI 总结——入列新条目后删除被替换的旧条目
        const replaceId = normalizeText(capture.replaceId, 100)
        if (replaceId.length > 0) items = items.filter((it) => it.id !== replaceId)
        const item = createItem({
          title,
          content,
          source: 'ai',
          due,
          sessionId: capture.sessionId,
          messageId: capture.messageId,
          ...(capture.anchorText ? { anchorText: capture.anchorText } : {}),
          ...(notify === undefined ? {} : notify),
          ai: true,
          aiSummary: reply.slice(0, 2000),
        })
        await writeItems([...items, item])
      } catch { }
    },
  }

  // 手写 Typert 网关绑定：validateBinding 读取该 face（cost-meter 同款）。
  Object.defineProperty(service, 'typertRemote', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: { service, serviceKey: 'todos', namespace: 'todos' },
  })
  // 存储域释放钩子：apply 里同步注册的 disposer 要能拿到它（cross-scope，故挂在服务上）。
  // 不加枚举，Typert 网关按 members 清单走，不会把它暴露成远程方法。
  Object.defineProperty(service, 'disposeDomain', {
    configurable: true,
    enumerable: false,
    writable: false,
    value: closeDomain,
  })
  return service
}

const PROMPT_SECTION = [
  '## 用户待办（todo-sidecar 插件）',
  '你具备维护用户待办列表的工具：',
  '- 当用户提出需要后续跟进的事项、任务、提醒或承诺（例如「记一下」「提醒我」「周五前要」「列入待办」），调用 todo_add 写入；title 用一句简洁标题，content 放详情，source 传 "model"。',
  '- 用户提到截止期限（如「周五前」「9月30日」）时，把可解析的日期写进 dueAt 参数（ISO 格式优先，如 2026-09-30）。',
  '- 用户询问当前有哪些待办时，调用 todo_list 并按简短列表转述；有期限的条目优先说明。',
  '- 用户要求「导出/备份/汇总全部待办」时，调用 todo_export（默认 Markdown）；可传 scope 多选范围（如 ["pending","overdue"]）取并集；需要表格给 Excel 用时让用户在「待办清单」设置页点「导出」选 Excel。',
  '- 纯问答、闲聊、以及当前回合内即可完成的小请求不要写入待办；同一事项不要重复写入。',
].join('\n')

// [ ] 未完成 / [x] 已完成 / [-] 已放弃：三种状态必须各用各的记号，否则已放弃的条目
// 会被读成「未完成」，头部计数与正文勾选数对不上，模型转述时就会自相矛盾。
const TODO_MARK = { completed: 'x', abandoned: '-', pending: ' ' }

function formatTodoList(items) {
  if (items.length === 0) return '待办列表为空。'
  const { pendingCount, completedCount, abandonedCount } = summarize(items)
  const lines = items.map((item, index) => {
    const mark = TODO_MARK[item.status] ?? ' '
    const reason = item.status === 'abandoned' && item.abandonReason !== undefined
      ? `（放弃原因：${item.abandonReason}）`
      : ''
    const source = item.source === undefined ? '' : `（来源：${SOURCE_LABEL[item.source] ?? item.source}）`
    const due = item.dueAt === undefined ? '' : `（提醒：${item.dueAt}）`
    return `${index + 1}. [${mark}] ${item.title}${reason}${due}${source}`
  })
  const head = abandonedCount === 0
    ? `待办列表（未完成 ${pendingCount} / 已完结 ${completedCount}）：`
    : `待办列表（未完成 ${pendingCount} / 已完结 ${completedCount} / 已放弃 ${abandonedCount}）：`
  return [head, ...lines].join('\n')
}

/** 注册宿主插件：todos 服务、模型工具、提示词片段、提醒引擎与 AI 捕获监听。 */
export function apply(ctx) {
  // 注意：所有 ctx.effect 必须在 apply 内同步注册（await 之后注册会抛
  // "cannot create effect on inactive context" 并拖垮宿主启动——dsh-tasks 同款教训）。
  const service = createService(ctx)
  ctx.provide('todos', service)

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'todo_add',
    description: 'Add one item to the user\'s todo list. 把一项待办写入用户的待办列表（划词/界面添加的待办不经此工具）。',
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: 'One short imperative line. 一句简洁标题，保留关键信息。',
      },
      content: {
        type: 'string',
        description: 'Optional detail. 可选详情（背景、对象、数字）。',
      },
      dueAt: {
        type: 'string',
        description: 'Optional deadline from the user, ISO date preferred (e.g. 2026-09-30). 用户提到的截止期限。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const store = ctx.get?.('todos')
      if (store === undefined) return '待办服务尚未就绪，请稍后重试。'
      const result = await store.add({
        title: args?.title,
        content: args?.content,
        dueAt: args?.dueAt,
        sessionId: exec?.agent?.session?.id ?? exec?.agent?.session?.header?.id,
      })
      if (!result.ok) return `写入待办失败：${result.error ?? '未知错误'}`
      return `已加入待办（当前未完成 ${result.value.pendingCount} 项）：${normalizeText(args?.title, 200)}`
    },
  })), 'todo-sidecar: tool todo_add')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'todo_list',
    description: 'Read the user\'s current todo list. 读取用户当前的待办列表。',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute() {
      const store = ctx.get?.('todos')
      if (store === undefined) return '待办服务尚未就绪，请稍后重试。'
      const state = await store.list({})
      if (!state.ok) return `读取待办失败：${state.error ?? '未知错误'}`
      return formatTodoList(state.value.items)
    },
  })), 'todo-sidecar: tool todo_list')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'todo_export',
    description: 'Export the user\'s todo records as text. 导出用户全部待办记录（默认 Markdown，可直接阅读或贴进上下文）。format 可选 md / csv / json / html；scope 可传多个范围取并集；xlsx 为二进制、请让用户在界面上导出。',
    parameters: {
      format: {
        type: 'string',
        enum: ['md', 'csv', 'json', 'html'],
        description: 'Text format. 文本格式：md（默认，最省 token）/ csv / json / html。',
      },
      scope: {
        // 工具参数 DSL 不接受 type 数组，字符串与字符串数组只能写成 oneOf 两个分支。
        oneOf: [
          { type: 'string', enum: ['all', 'pending', 'overdue', 'done', 'abandoned'] },
          { type: 'array', items: { type: 'string', enum: ['pending', 'overdue', 'done', 'abandoned'] } },
        ],
        description: 'Which records. 导出范围：省略或 all = 全部记录；也可传数组多选（如 ["pending","overdue"]），取并集。pending 已含逾期，两者同选不会重复。',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const store = ctx.get?.('todos')
      if (store === undefined) return '待办服务尚未就绪，请稍后重试。'
      const state = await store.list({})
      if (!state.ok) return `读取待办失败：${state.error ?? '未知错误'}`
      const items = state.value.items
      const format = typeof args?.format === 'string' && args.format !== '' ? args.format : 'md'
      if (format === 'xlsx') {
        return 'Excel 是二进制格式，无法作为文本返回；请让用户在「待办清单」设置页点击「导出」并选择 Excel。'
      }
      const scope = args?.scope === undefined || args.scope === '' ? 'all' : args.scope
      const result = buildExportFile(items, { format, scopes: scope })
      if (!isTextExport(result)) {
        return '该格式为二进制，无法直接返回；请改用 md / csv / json，或让用户在界面上导出。'
      }
      const stats = summarizeExport(items)
      return [
        `已导出 ${result.count} 条记录（范围：${result.scopeLabel}；全部 ${stats.total} 条：未完成 ${stats.pending} / 已完成 ${stats.completed} / 已放弃 ${stats.abandoned}），文件名 ${result.filename}。`,
        '',
        result.text,
      ].join('\n')
    },
  })), 'todo-sidecar: tool todo_export')

  // 存储域生命周期：0.2.x 契约「谁 open 谁 close」。不在这里释放，fiber 重建后同名 open
  // 会一直抛 already-open（v1.5.1 修复的真实故障）。必须同步注册，不能放在 await 之后。
  ctx.effect(() => () => service.disposeDomain?.(), 'todo-sidecar: storage domain')

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'plugin:todo-sidecar',
    order: 6000,
    text: PROMPT_SECTION,
    interpolate: false,
  }), 'todo-sidecar: prompt section')

  // 内置提醒引擎：30s 扫描到期待办并推送。
  ctx.effect(() => {
    const timer = setInterval(() => { void service.scanReminders() }, 30_000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'todo-sidecar: reminder engine')

  // AI 捕获完成监听：turn/end 结算总结会话并入列。
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    void service.handleSessionEvent(session, event)
  }), 'todo-sidecar: ai capture listener')

}
