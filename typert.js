/**
 * dsh-todo 的 Host 面 Typert 清单（由 typert-loader 经 exports["./typert"] 自动发现）。
 *
 * 按 0.2.0-rc.x 运行时的 typert-loader 校验规则手写（本机 app.asar 提取代码实测）：
 * strict codec（zod schema + create()）、manifest 必含 model（services/events/objects）、
 * 每个 invocation 必须带 result codec。
 * 方法名不得与 RemoteNamespaceService 内置成员冲突（ctx、empty、invokeRemote、
 * methods、name、namespace、assertMethodAvailable、has、installDirect、
 * installScoped、install、remove）——remove 已因此翻过车。
 */
import { z } from 'zod'

//#region zod schema
const itemSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
  content: z.string().max(2000).optional(),
  status: z.enum(['pending', 'completed', 'abandoned']),
  createdAt: z.number(),
  updatedAt: z.number().optional(),
  doneAt: z.number().optional(),
  source: z.enum(['selection', 'chat', 'model', 'manual', 'ai']).optional(),
  dueAt: z.string().max(64).optional(),
  dueAtMs: z.number().optional(),
  reminded: z.boolean().optional(),
  // v1.0 多选通知渠道
  notifyPopup: z.boolean().optional(),
  notifyIm: z.boolean().optional(),
  imSent: z.boolean().optional(),
  notifyMode: z.enum(['global', 'popup', 'im', 'none']).optional(),
  // v1.0 周期提醒
  recurrence: z.object({
    type: z.enum(['daily', 'weekly']),
    hour: z.number().min(0).max(23),
    minute: z.number().min(0).max(59),
    weekdays: z.array(z.number().min(0).max(6)).optional(),
  }).strict().optional(),
  aiUnseen: z.boolean().optional(),
  aiSummary: z.string().max(2000).optional(),
  sessionId: z.string().optional(),
  messageId: z.string().optional(),
  anchorText: z.string().max(120).optional(),
  abandonReason: z.string().max(500).optional(),
  handedToTasks: z.boolean().optional(),
}).strict()

const listResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  value: z.object({
    items: z.array(itemSchema),
    aiModel: z.object({ provider: z.string(), model: z.string() }).strict().optional(),
    notify: z.object({
      popup: z.boolean().optional(),
      im: z.boolean().optional(),
      imBotId: z.string().max(100).optional(),
      imTargetId: z.string().max(100).optional(),
    }).strict().optional(),
    aiDefaultReminder: z.string().max(20).optional(),
  }).strict().optional(),
}).strict()

const recurrenceRequestSchema = z.object({
  type: z.enum(['daily', 'weekly']),
  hour: z.number().min(0).max(23),
  minute: z.number().min(0).max(59),
  weekdays: z.array(z.number().min(0).max(6)).optional(),
}).strict()

const addRequestSchema = z.object({
  // v1.1.2 标题可选：留空时由 host 从内容自动总结（deriveTitle）
  title: z.string().max(200).optional(),
  content: z.string().max(2000).optional(),
  dueAt: z.string().max(64).optional(),
  recurrence: recurrenceRequestSchema.optional(),
  notifyPopup: z.boolean().optional(),
  notifyIm: z.boolean().optional(),
  imBotId: z.string().max(128).optional(),
  imTargetId: z.string().max(128).optional(),
  sessionId: z.string().optional(),
  messageId: z.string().optional(),
  anchorText: z.string().max(120).optional(),
}).strict()

const addResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  value: z.object({ id: z.string(), pendingCount: z.number() }).strict().optional(),
}).strict()

const countResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  value: z.object({ pendingCount: z.number() }).strict().optional(),
}).strict()

const idRequestSchema = z.object({ id: z.string().min(1) }).strict()

const setStatusRequestSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['pending', 'completed']),
}).strict()

const abandonRequestSchema = z.object({
  id: z.string().min(1),
  reason: z.string().max(500).optional(),
}).strict()

const deferRequestSchema = z.object({
  id: z.string().min(1),
  dueAt: z.string().min(1).max(64),
}).strict()

// v1.0 update：编辑代办（增量字段；content/dueAt 传 '' 表示清除）
const updateRequestSchema = z.object({
  id: z.string().min(1),
  title: z.string().max(200).optional(),
  content: z.string().max(2000).optional(),
  dueAt: z.string().max(64).optional(),
  recurrence: recurrenceRequestSchema.optional().nullable(),
  notifyPopup: z.boolean().optional(),
  notifyIm: z.boolean().optional(),
  imBotId: z.string().max(128).optional(),
  imTargetId: z.string().max(128).optional(),
  handedToTasks: z.boolean().optional(),
  reminded: z.boolean().optional(),
}).strict()

// v1.0 全局通知配置
const saveNotifyConfigRequestSchema = z.object({
  popup: z.boolean().optional(),
  im: z.boolean().optional(),
  imBotId: z.string().max(100).optional(),
  imTargetId: z.string().max(100).optional(),
  // v1.1.2 AI 记录默认提醒时间枚举
  aiDefaultReminder: z.string().max(20).optional(),
  // v1.2.2 反馈⑤：左侧边栏显示开关
  sidebarEnabled: z.boolean().optional(),
}).strict()

const emptyRequestSchema = z.object({}).strict()

const aiCaptureRequestSchema = z.object({
  text: z.string().min(1).max(4000),
  sessionId: z.string().optional(),
  messageId: z.string().optional(),
  anchorText: z.string().max(120).optional(),
}).strict()

const aiCaptureResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  value: z.object({ started: z.boolean() }).strict().optional(),
}).strict()

const setAiModelRequestSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
}).strict()

// v1.1.1 createFollowup：在同一工作区新建会话并固定标题，返回新会话 ID
// v1.1.7：加 todoId——新会话首条消息发出后自动完成对应待办
// v1.2.3：加 sourceSessionId——客户端反查不到工作区时，宿主用 registry 按源会话兜底归属
const createFollowupRequestSchema = z.object({
  workspaceId: z.string().optional(),
  sourceSessionId: z.string().optional(),
  title: z.string().min(1),
  todoId: z.string().optional(),
}).strict()
const createFollowupResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  value: z.object({ sessionId: z.string().min(1) }).strict().optional(),
}).strict()

// v0.9.7 listModels：返回 DSH 已配置模型（按 provider 分组）+ 当前默认
const modelInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
}).strict()
const modelGroupSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  models: z.array(modelInfoSchema),
}).strict()
const listModelsResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  value: z.object({
    default: z.object({ provider: z.string(), model: z.string() }).strict(),
    groups: z.array(modelGroupSchema),
  }).strict().optional(),
}).strict()

// v1.1 listImBots：返回真实机器人（企业微信/QQ/微信等）及其目标
const imTargetSchema = z.object({
  targetId: z.string().min(1),
  name: z.string().optional(),
}).strict()
const imBotSchema = z.object({
  botId: z.string().min(1),
  channel: z.string().optional(),
  targets: z.array(imTargetSchema),
}).strict()
const listImBotsResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  value: z.object({
    bots: z.array(imBotSchema),
  }).strict().optional(),
}).strict()

const okResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
}).strict()
//#endregion

/** 0.2.0 loader 只认 strict codec；schema 与 create() 同时提供（cost-meter 同款）。 */
const strictCodec = (name, schema) => ({ mode: 'strict', typeSymbol: 'dsh-todo#' + name, schema, create: () => schema })

const listRequestCodec = strictCodec('TodoListRequest', emptyRequestSchema)
const listResultCodec = strictCodec('TodoListResult', listResultSchema)
const addRequestCodec = strictCodec('TodoAddRequest', addRequestSchema)
const addResultCodec = strictCodec('TodoAddResult', addResultSchema)
const countResultCodec = strictCodec('TodoCountResult', countResultSchema)
const idRequestCodec = strictCodec('TodoIdRequest', idRequestSchema)
const setStatusRequestCodec = strictCodec('TodoSetStatusRequest', setStatusRequestSchema)
const abandonRequestCodec = strictCodec('TodoAbandonRequest', abandonRequestSchema)
const deferRequestCodec = strictCodec('TodoDeferRequest', deferRequestSchema)
const updateRequestCodec = strictCodec('TodoUpdateRequest', updateRequestSchema)
const saveNotifyConfigRequestCodec = strictCodec('TodoSaveNotifyConfigRequest', saveNotifyConfigRequestSchema)
const aiCaptureRequestCodec = strictCodec('TodoAiCaptureRequest', aiCaptureRequestSchema)
const aiCaptureResultCodec = strictCodec('TodoAiCaptureResult', aiCaptureResultSchema)
const setAiModelRequestCodec = strictCodec('TodoSetAiModelRequest', setAiModelRequestSchema)
const createFollowupRequestCodec = strictCodec('TodoCreateFollowupRequest', createFollowupRequestSchema)
const createFollowupResultCodec = strictCodec('TodoCreateFollowupResult', createFollowupResultSchema)
const listModelsResultCodec = strictCodec('TodoListModelsResult', listModelsResultSchema)
const listImBotsResultCodec = strictCodec('TodoListImBotsResult', listImBotsResultSchema)
const okResultCodec = strictCodec('TodoOkResult', okResultSchema)

function invocation(method, parameterCodec, resultCodec) {
  return {
    id: `dsh-todo#todos/${method}`,
    service: 'todos',
    namespace: 'todos',
    method,
    invocation: { kind: 'direct' },
    parameters: parameterCodec === undefined ? [] : [
      { name: 'request', wire: 'request', source: 'json', codec: parameterCodec },
    ],
    result: resultCodec,
  }
}

export const TYPERT = {
  package: 'dsh-todo-checklist',
  face: 'host',
  schemas: [],
  model: {
    services: [
      {
        tags: [],
        key: 'todos',
        exportName: 'todos',
        description: 'Todo sidecar service: persist and serve the user todo list to the Web client.',
        summary: '用户待办列表服务：持久化待办并供 Web 客户端读写。',
        members: [
          { kind: 'method', name: 'list', signature: 'list(request: {}): Promise<TodoListResult>' },
          { kind: 'method', name: 'add', signature: 'add(request: TodoAddRequest): Promise<TodoAddResult>' },
          { kind: 'method', name: 'aiCapture', signature: 'aiCapture(request: TodoAiCaptureRequest): Promise<TodoAiCaptureResult>' },
          { kind: 'method', name: 'aiSummarizeItem', signature: 'aiSummarizeItem(request: TodoIdRequest): Promise<TodoAiCaptureResult>' },
          { kind: 'method', name: 'setAiModel', signature: 'setAiModel(request: TodoSetAiModelRequest): Promise<TodoOkResult>' },
          { kind: 'method', name: 'createFollowup', signature: 'createFollowup(request: TodoCreateFollowupRequest): Promise<TodoCreateFollowupResult>' },
          { kind: 'method', name: 'setStatus', signature: 'setStatus(request: TodoSetStatusRequest): Promise<TodoCountResult>' },
          { kind: 'method', name: 'abandon', signature: 'abandon(request: TodoAbandonRequest): Promise<TodoCountResult>' },
          { kind: 'method', name: 'defer', signature: 'defer(request: TodoDeferRequest): Promise<TodoCountResult>' },
          { kind: 'method', name: 'update', signature: 'update(request: TodoUpdateRequest): Promise<TodoCountResult>' },
          { kind: 'method', name: 'reminderHandled', signature: 'reminderHandled(request: TodoIdRequest): Promise<TodoCountResult>' },
          { kind: 'method', name: 'saveNotifyConfig', signature: 'saveNotifyConfig(request: TodoSaveNotifyConfigRequest): Promise<TodoOkResult>' },
          { kind: 'method', name: 'deleteTodo', signature: 'deleteTodo(request: TodoIdRequest): Promise<TodoCountResult>' },
          { kind: 'method', name: 'clearCompleted', signature: 'clearCompleted(request: {}): Promise<TodoCountResult>' },
          { kind: 'method', name: 'markSeen', signature: 'markSeen(request: {}): Promise<TodoOkResult>' },
          { kind: 'method', name: 'listModels', signature: 'listModels(request: {}): Promise<TodoListModelsResult>' },
          { kind: 'method', name: 'listImBots', signature: 'listImBots(request: {}): Promise<TodoListImBotsResult>' },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
  invocations: [
    invocation('list', listRequestCodec, listResultCodec),
    invocation('add', addRequestCodec, addResultCodec),
    invocation('aiCapture', aiCaptureRequestCodec, aiCaptureResultCodec),
    invocation('aiSummarizeItem', idRequestCodec, aiCaptureResultCodec),
    invocation('setAiModel', setAiModelRequestCodec, okResultCodec),
    invocation('createFollowup', createFollowupRequestCodec, createFollowupResultCodec),
    invocation('setStatus', setStatusRequestCodec, countResultCodec),
    invocation('abandon', abandonRequestCodec, countResultCodec),
    invocation('defer', deferRequestCodec, countResultCodec),
    invocation('update', updateRequestCodec, countResultCodec),
    invocation('reminderHandled', idRequestCodec, countResultCodec),
    invocation('saveNotifyConfig', saveNotifyConfigRequestCodec, okResultCodec),
    invocation('deleteTodo', idRequestCodec, countResultCodec),
    invocation('clearCompleted', listRequestCodec, countResultCodec),
    invocation('markSeen', listRequestCodec, okResultCodec),
    invocation('listModels', listRequestCodec, listModelsResultCodec),
    invocation('listImBots', listRequestCodec, listImBotsResultCodec),
  ],
}

export default TYPERT
