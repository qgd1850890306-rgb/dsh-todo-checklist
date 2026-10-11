/**
 * 待办持久化领域（ctx.storageDomain）：待办列表 + 插件配置，跨重启保留。
 *
 * 0.2.0-rc.x 的 defineDomain 校验：tables 必须存在（可为空对象）、
 * global.schema 不得接受 null（null 是介质的「从未写入」哨兵）。
 * 句柄访问：domain.global.get() / domain.global.set()。
 */
import { z } from 'zod'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'

/** 列表上限：超出时按「先丢已完结、再丢最旧」裁剪，避免写入失败。 */
export const MAX_ITEMS = 500

const itemSchema = z.object({
  id: z.string().min(1),
  /** 标题（一句话；AI 总结产出或手动填写）。 */
  title: z.string().min(1).max(200),
  /** 内容详情（划词原文默认进 content）。 */
  content: z.string().max(2000).optional(),
  status: z.enum(['pending', 'completed', 'abandoned']),
  createdAt: z.number(),
  /** 最近一次编辑时间（毫秒），可缺席（早期数据无）。 */
  updatedAt: z.number().optional(),
  doneAt: z.number().optional(),
  source: z.enum(['selection', 'chat', 'model', 'manual', 'ai']).optional(),
  /**
   * 单条通知渠道（v1.0 多选，可应用内 + 机器人同时；未显式设置则跟随全局）。
   * notifyPopup=应用内弹窗；notifyIm=机器人/DSH-IM 推送。
   */
  notifyPopup: z.boolean().optional(),
  notifyIm: z.boolean().optional(),
  /** v1.1 单条机器人指定（留空=跟随全局/全部机器人）。 */
  imBotId: z.string().max(128).optional(),
  imTargetId: z.string().max(128).optional(),
  /** 机器人推送是否已发送（防重复，内部维护）。 */
  imSent: z.boolean().optional(),
  /** 旧版单值通知方式（仅兼容读取；编辑后迁移到 notifyPopup/notifyIm）。 */
  notifyMode: z.enum(['global', 'popup', 'im', 'none']).optional(),
  /** 用户口述的提醒时间原文（如「2026-09-30 14:00」），可缺席。 */
  dueAt: z.string().max(64).optional(),
  /** 提醒时间的 epoch 毫秒（可解析时写入），可缺席。 */
  dueAtMs: z.number().optional(),
  /** 内置提醒引擎是否已触发过。 */
  reminded: z.boolean().optional(),
  /**
   * 周期提醒（v1.0，参照 dsh-tasks cron 交互）：缺席=单次提醒。
   * daily=每天（hour/minute）；weekly=每周（hour/minute + weekdays 0-6）。
   */
  recurrence: z.object({
    type: z.enum(['daily', 'weekly']),
    hour: z.number().min(0).max(23),
    minute: z.number().min(0).max(59),
    weekdays: z.array(z.number().min(0).max(6)).optional(),
  }).optional(),
  /** AI 记录的待办尚未在面板上看过（绿点提示），看过后清除。 */
  aiUnseen: z.boolean().optional(),
  /** AI 摘要原文（AI 记录时保存，便于追溯）。 */
  aiSummary: z.string().max(2000).optional(),
  /** 划词锚点：来源会话（处理待办跳转用）。 */
  sessionId: z.string().optional(),
  /** 划词锚点：来源消息（定位滚动用，可缺席）。 */
  messageId: z.string().optional(),
  /** 划词锚点：选中文字归一化片段（文本匹配兜底，可缺席）。 */
  anchorText: z.string().max(120).optional(),
  /** 放弃原因/背景（可选）。 */
  abandonReason: z.string().max(500).optional(),
  /** 已转交 dsh-tasks 定时任务提醒。 */
  handedToTasks: z.boolean().optional(),
})

const configSchema = z.object({
  /** AI 记录待办使用的模型偏好；缺席 = 跟随当前会话默认模型。 */
  aiModel: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
  }).optional(),
  /** 全局默认通知渠道（v1.0）：未显式配置的代办跟随这里。 */
  notify: z.object({
    popup: z.boolean().optional(),
    im: z.boolean().optional(),
    imBotId: z.string().max(100).optional(),
    imTargetId: z.string().max(100).optional(),
  }).optional(),
  /**
   * v1.1.2 修复①：host/index.js saveNotifyConfig 会写入 aiDefaultReminder，
   * 但本 schema 漏声明 → .strict() 拒收 → 域 open 失败 → 所有读写全炸。
   * （disk 已存 "aiDefaultReminder":""，打开域时报
   *   domain 'dsh_todo_sidecar_items': stored global does not match its schema）
   */
  aiDefaultReminder: z.string().max(20).optional(),
  /**
   * v1.2.2 反馈⑤：左侧边栏显示开关；缺席/true = 显示，false = 不注册 sidebar 槽。
   * 一次性注册，变更后需重启 DSH 生效。
   */
  sidebarEnabled: z.boolean().optional(),
})

/**
 * v1.3.0 发布加固：容错解析（抢救）——单条坏数据只丢那一条，不再让整个待办域打不开。
 *
 * 背景：storage-domain 的 global **没有** tables 的 'backup-and-skip' 豁免，
 * schema 解析失败会抛 invalid-record，域打不开 → 读写全炸（v1.1.2 事故）。
 * 这里把「严格校验」换成「尽力抢救」：先 safeParse 原样；失败则补齐必填字段再试一次；
 * 仍失败才丢弃这一条，并把数量写进 tolerantStats 供宿主诊断。
 */
export const tolerantStats = { droppedItems: 0, repairedItems: 0, repairedConfig: false }

const STATUSES = ['pending', 'completed', 'abandoned']

const salvageItem = (raw) => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    tolerantStats.droppedItems += 1
    return undefined
  }
  const direct = itemSchema.safeParse(raw)
  if (direct.success) return direct.data
  const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : undefined
  if (id === undefined) {
    tolerantStats.droppedItems += 1
    return undefined
  }
  const patched = {
    ...raw,
    id,
    title: typeof raw.title === 'string' && raw.title.length > 0 ? raw.title : '（标题丢失的待办）',
    status: STATUSES.includes(raw.status) ? raw.status : 'pending',
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
  }
  const retry = itemSchema.safeParse(patched)
  if (retry.success) {
    tolerantStats.repairedItems += 1
    return retry.data
  }
  tolerantStats.droppedItems += 1
  return undefined
}

/** items 可能是数组 / id→item 的对象 / JSON 字符串 / null，一律尽力抢救成数组。 */
export const salvageItems = (raw) => {
  let list = raw
  if (typeof list === 'string') {
    try { list = JSON.parse(list) } catch { list = [] }
  }
  if (list !== null && typeof list === 'object' && !Array.isArray(list)) list = Object.values(list)
  if (!Array.isArray(list)) return []
  return list.map(salvageItem).filter((value) => value !== undefined)
}

/** config 逐字段抢救：坏字段丢弃、好字段保留（不再因一个坏键清空用户偏好）。 */
export const salvageConfig = (raw) => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const direct = configSchema.safeParse(raw)
  if (direct.success) return direct.data
  const out = {}
  const model = raw.aiModel
  if (model !== null && typeof model === 'object' && typeof model.provider === 'string' && model.provider.length > 0
    && typeof model.model === 'string' && model.model.length > 0) {
    out.aiModel = { provider: model.provider, model: model.model }
  }
  const notify = raw.notify
  if (notify !== null && typeof notify === 'object' && !Array.isArray(notify)) {
    const next = {}
    if (typeof notify.popup === 'boolean') next.popup = notify.popup
    if (typeof notify.im === 'boolean') next.im = notify.im
    if (typeof notify.imBotId === 'string') next.imBotId = notify.imBotId.slice(0, 100)
    if (typeof notify.imTargetId === 'string') next.imTargetId = notify.imTargetId.slice(0, 100)
    if (Object.keys(next).length > 0) out.notify = next
  }
  if (typeof raw.aiDefaultReminder === 'string') out.aiDefaultReminder = raw.aiDefaultReminder.slice(0, 20)
  if (typeof raw.sidebarEnabled === 'boolean') out.sidebarEnabled = raw.sidebarEnabled
  if (Object.keys(out).length !== Object.keys(raw).length) tolerantStats.repairedConfig = true
  return out
}

export const todoDomainSpec = defineDomain({
  // v0.5.0：改名避开与内置 todo-sidecar 的领域撞名（stored v1 vs expected 2 事故）。
  // 旧域 dsh_todo_items（v1，仅 1 条测试数据）经用户确认弃用，不做迁移。
  name: 'dsh_todo_sidecar_items',
  version: 1,
  global: {
    schema: z.object({
      // 不用 z.array(itemSchema)（一条坏数据即整域打不开），改走抢救通道；
      // 上限在写入侧由 pruneItems 保证，读取侧放宽以免历史超限数据被判非法。
      items: z.unknown().transform(salvageItems),
      config: z.unknown().transform(salvageConfig),
    }),
    initial: { items: [], config: {} },
  },
  tables: {},
})

/** 归一化一条待办内容：压缩空白、去首尾、限长。 */
export function normalizeText(raw, max = 500) {
  return String(raw ?? '').replace(/\s+/gu, ' ').trim().slice(0, max)
}

/**
 * v1.1.3 修复④排版：归一化多行文本——行内空白压成单空格，但保留换行
 * （连续空行压为一个空行）。normalizeText 会把换行压成空格，AI 总结的分段全毁；
 * 本函数让 AI 按【xx】分段的换行原样落库，配合 host 的 formatSections 保证可读。
 */
export function normalizeMultiline(raw, max = 2000) {
  return String(raw ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
    .slice(0, max)
}

/**
 * v1.1 标题留空时从内容自动总结一个标题：取首个非空行，截断到 24 字；
 * v1.2.3 反馈③收紧 30→24（反馈：自动生成的标题太长），截断点尽量落在标点/空白处。
 * 内容也为空时回退到「未命名待办」。
 */
export function deriveTitle(content) {
  const text = String(content ?? '').trim()
  if (text.length === 0) return '未命名待办'
  const firstLine = text.split(/\r?\n/u).map((s) => s.trim()).find(Boolean) ?? ''
  const base = firstLine.length > 0 ? firstLine : text
  if (base.length <= 24) return base
  const head = base.slice(0, 24)
  // 在截断窗内找最后一个标点/空白，标题停在词边界而不是劈开词组
  const m = head.match(/^(.*?)([，。、；：！？,.;:!?\s）)」』"'])/u)
  const cut = m && m[1].length >= 8 ? m[1] : head
  return `${cut.trimEnd()}…`
}

/** 解析提醒时间（ISO 日期或可 Date.parse 的写法）；失败返回 undefined。 */
export function parseDueAt(raw) {
  const text = String(raw ?? '').trim()
  if (text.length === 0 || text.length > 64) return undefined
  const ms = Date.parse(text)
  if (Number.isFinite(ms)) return { dueAt: text, dueAtMs: ms }
  return { dueAt: text }
}

export function createItem({ title, content, source = 'manual', due = undefined, sessionId = undefined, messageId = undefined, anchorText = undefined, ai = false, aiSummary = undefined, notifyPopup = undefined, notifyIm = undefined, notifyMode = undefined, imBotId = undefined, imTargetId = undefined }, now = Date.now()) {
  // v1.1 标题留空：从内容自动总结
  const trimmedTitle = typeof title === 'string' ? title.trim() : ''
  const resolvedTitle = trimmedTitle.length > 0 ? trimmedTitle.slice(0, 200) : deriveTitle(content)
  return {
    id: crypto.randomUUID(),
    title: resolvedTitle,
    ...(content === undefined || content.length === 0 ? {} : { content }),
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    source,
    ...due === undefined ? {} : due,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(messageId === undefined ? {} : { messageId }),
    ...(anchorText === undefined ? {} : { anchorText }),
    ...(ai ? { aiUnseen: true } : {}),
    ...(aiSummary === undefined ? {} : { aiSummary }),
    ...(notifyPopup === undefined ? {} : { notifyPopup }),
    ...(notifyIm === undefined ? {} : { notifyIm }),
    ...(imBotId === undefined ? {} : { imBotId }),
    ...(imTargetId === undefined ? {} : { imTargetId }),
    ...(notifyMode === undefined ? {} : { notifyMode }),
  }
}

/** 按「先丢已完结、再丢最旧」裁剪到 MAX_ITEMS 以内。 */
export function pruneItems(items) {
  if (items.length <= MAX_ITEMS) return items
  const overflow = items.length - MAX_ITEMS
  const next = [...items]
  for (let i = 0; i < next.length && overflow > 0; i += 1) {
    if (next[i].status !== 'pending') {
      next.splice(i, 1)
      i -= 1
    }
  }
  return overflow > 0 ? next.slice(overflow) : next
}

export function summarize(items) {
  let pendingCount = 0
  let completedCount = 0
  let abandonedCount = 0
  let aiUnseen = false
  let overdue = 0
  const now = Date.now()
  for (const item of items) {
    if (item.status === 'completed') completedCount += 1
    else if (item.status === 'abandoned') abandonedCount += 1
    else {
      pendingCount += 1
      if (item.aiUnseen === true) aiUnseen = true
      if (item.dueAtMs !== undefined && item.dueAtMs < now) overdue += 1
    }
  }
  return { pendingCount, completedCount, abandonedCount, aiUnseen, overdue }
}

/** 到期的待办（提醒引擎扫描用）：待处理 + 已设提醒 + 到点 + 未触发。 */
export function dueItems(items, now = Date.now()) {
  return items.filter((item) =>
    item.status === 'pending'
    && item.reminded !== true
    && item.dueAtMs !== undefined
    && item.dueAtMs <= now)
}

/** 本地时间 → "YYYY-MM-DD HH:mm" 文案（dueAt 存储/显示用）。 */
function formatDueAt(date) {
  const pad = (v) => String(v).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 解析某条代办最终生效的通知渠道（v1.0）。
 * 优先级：单条显式布尔 > 旧 notifyMode 兼容 > 全局配置 > 默认（应用内弹窗开、机器人关）。
 */
export function resolveNotify(item, globalNotify = {}) {
  let popup = item.notifyPopup
  let im = item.notifyIm
  if (popup === undefined && im === undefined && item.notifyMode !== undefined) {
    if (item.notifyMode === 'popup') { popup = true; im = false }
    else if (item.notifyMode === 'im') { popup = false; im = true }
    else if (item.notifyMode === 'none') { popup = false; im = false }
    // 'global'：不设，继续走全局/默认
  }
  return {
    popup: popup ?? globalNotify.popup ?? true,
    im: im ?? globalNotify.im ?? false,
  }
}

/**
 * 计算周期提醒的下一次到期时间（严格晚于 now）。
 * daily=每天 hour/minute；weekly=每周指定 weekdays 的 hour/minute。
 * 返回 { dueAt, dueAtMs }；无 recurrence 或无下一次返回 undefined。
 */
export function nextDueAt(recurrence, now = Date.now()) {
  if (!recurrence) return undefined
  const { type, hour, minute } = recurrence
  const candidate = new Date(now)
  candidate.setHours(hour, minute, 0, 0)
  if (type === 'daily') {
    if (candidate.getTime() <= now) candidate.setDate(candidate.getDate() + 1)
    return { dueAt: formatDueAt(candidate), dueAtMs: candidate.getTime() }
  }
  if (type === 'weekly') {
    const days = recurrence.weekdays && recurrence.weekdays.length > 0 ? recurrence.weekdays : [1]
    for (let i = 0; i < 8; i += 1) {
      if (days.includes(candidate.getDay()) && candidate.getTime() > now) {
        return { dueAt: formatDueAt(candidate), dueAtMs: candidate.getTime() }
      }
      candidate.setDate(candidate.getDate() + 1)
    }
  }
  return undefined
}
