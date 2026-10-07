/**
 * 后端运行时事件的 TypeScript 映射（唯一手写契约层）。
 *
 * <p><b>真源：</b>框架 {@code com.summit.core.conversation.event} 包。每个接口与后端一个事件类
 * 一一对应，接口名刻意与类名保持一致，便于双向检索；注释里给出该类 {@code type()} 的取值。</p>
 *
 * <p><b>与后端保持同步是人工责任</b>：后端没有代码生成器。新增/改名词表时，两侧必须同时改，
 * 否则事件被消费侧静默丢弃（按字面量匹配未命中即不处理，不报错）。</p>
 *
 * <p><b>线上形态：</b>SSE 事件名 = {@code event.type()}（见 {@code SseEventPublisher#send}），
 * 事件体 = 事件对象的 JSON。序列化规则（{@code JsonConfig} + {@code ExecutionJson}）：
 * Long → 十进制字符串，Instant → ISO-8601 字符串（未开时间戳数字）。故本文件里 id 与时间
 * 一律是 {@code string}。</p>
 */

/* ------------------------------------------------------------------ */
/* 通用载荷                                                             */
/* ------------------------------------------------------------------ */

/**
 * 事件随行元数据（{@code AgentEvent#eventMetaData()}）。
 *
 * <p>键的真源是后端 {@code ExecutionEventMetadata}；值统一是十进制字符串（雪花 ID 超 JS 安全
 * 整数范围，必须走字符串）。框架每次执行构造一份不可变快照，事件里的就是当时的值。</p>
 */
export interface EventMetaData {
  /** 事件权威归属根会话 id（子执行归父任务） */
  rootSessionId?: string;
  /** 本次执行所属会话 id（子执行取其子会话） */
  sessionId?: string;
  /** 业务轮次 id；受理落库后才已知，缺失表示该执行尚无对应轮次 */
  turnId?: string;
  /** 发起本次子委派的主轮次 id；普通用户提问为 null */
  parentTurnId?: string;
  /** 构建时根会话的历史代际快照 */
  historyRevision?: string;
  /** 响应身份键 */
  streamKey?: string;
  [key: string]: unknown;
}

/** 终结事件（completed / failed / cancelled）携带的用量。null = 未采集（≠ 0）。 */
export interface TokenInfo {
  inputTokenCount?: number | null;
  outputTokenCount?: number | null;
  totalTokenCount?: number | null;
}

/** 模型结束原因（对应 {@code ChatResponseEntity.FinishReason}）。 */
export type FinishReason = 'STOP' | 'LENGTH' | 'TOOL_EXECUTION' | 'CONTENT_FILTER' | 'OTHER';

/** 模型响应元信息（对应 {@code ChatResponseEntity.Meta}）。 */
export interface ResponseMeta {
  id?: string;
  modelName?: string;
  finishReason?: FinishReason;
}

/** 工具调用结果状态（对应 {@code com.summit.core.tool.ToolCallStatus}）。 */
export type ToolCallStatus =
  | 'STARTED'
  | 'COMPLETED'
  | 'PROMISED'
  | 'REJECTED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'CANCELLED';

/** 上下文压缩阶段（对应 {@code ContextUpdateEvent.Phase}）。 */
export type ContextUpdatePhase = 'UPDATE' | 'SQUEEZE_STARTED' | 'SQUEEZE_COMPLETED';

/** 上下文用量指标（对应 {@code ContextUsageMetric}）；maxTokens 为 0 表示未配置上限。 */
export interface ContextUsageMetric {
  tokenCount: number;
  maxTokens: number;
  /** 用量比，通常 [0,1]；超上限可 > 1 */
  ratio: number;
}

/* ------------------------------------------------------------------ */
/* 基类                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 所有运行时事件的公共字段（对应框架 {@code AgentEvent}）。
 *
 * <p>{@code type} 保持 {@code string} 而非字面量联合：后端可以新增事件类型，消费侧必须能安全地
 * 「收到但不处理」，而不是编译期就拒绝。具体接口各自把它收窄成自己的字面量。</p>
 */
export interface EventInterface {
  /** 事件判别式；SSE 事件名与事件体顶层同值（对应 {@code TypedEvent#type()}） */
  type: string;
  /** 框架执行 id */
  executionId: string;
  /** 事件产生时刻（ISO-8601 字符串） */
  timestamp: string;
  /** 业务归属元数据；老检查点可能缺失 */
  metaData?: EventMetaData;
}

/* ------------------------------------------------------------------ */
/* 生命周期事件                                                         */
/* ------------------------------------------------------------------ */

/** EXECUTION_STARTED —— 一轮执行开始（对应 {@code ExecutionStartEvent}）。 */
export interface ExecutionStartEvent extends EventInterface {
  type: 'EXECUTION_STARTED';
}

/** EXECUTION_COMPLETED —— 执行正常结束，可能带用量（对应 {@code ExecutionCompleteEvent}）。 */
export interface ExecutionCompleteEvent extends EventInterface {
  type: 'EXECUTION_COMPLETED';
  tokenInfo?: TokenInfo | null;
}

/** EXECUTION_FAILED —— 执行抛异常终止（对应 {@code ExecutionErrorEvent}）。 */
export interface ExecutionErrorEvent extends EventInterface {
  type: 'EXECUTION_FAILED';
  /** 给用户看的失败原因 */
  errMsg?: string;
  /** 补充说明 */
  extraDes?: string;
  tokenInfo?: TokenInfo | null;
}

/** EXECUTION_CANCELLED —— 用户/外部中断（对应 {@code ExecutionCancelledEvent}）。 */
export interface ExecutionCancelledEvent extends EventInterface {
  type: 'EXECUTION_CANCELLED';
  tokenInfo?: TokenInfo | null;
}

/** EXECUTION_SUSPENDED —— 协作式挂起，非终态（对应 {@code ExecutionSuspendedEvent}）。 */
export interface ExecutionSuspendedEvent extends EventInterface {
  type: 'EXECUTION_SUSPENDED';
}

/** EXECUTION_RESUME —— 挂起的执行被恢复，开始新一轮（对应 {@code ExecutionResumedEvent}）。 */
export interface ExecutionResumedEvent extends EventInterface {
  type: 'EXECUTION_RESUME';
}

/* ------------------------------------------------------------------ */
/* 文本 / 思考事件                                                      */
/* ------------------------------------------------------------------ */

/** PARTIAL_TEXT —— 模型正文增量，高频（对应 {@code AgentPartialTextEvent}）。 */
export interface AgentPartialTextEvent extends EventInterface {
  type: 'PARTIAL_TEXT';
  agentId?: string;
  /** 本次增量文本 */
  content: string;
}

/** COMPLETE_TEXT —— 一轮模型的完整文本（对应 {@code AgentCompleteTextEvent}）。 */
export interface AgentCompleteTextEvent extends EventInterface {
  type: 'COMPLETE_TEXT';
  agentId?: string;
  /** 本轮完整正文 */
  content: string;
  meta?: ResponseMeta | null;
}

/** PARTIAL_THINKING —— 思考/推理增量，高频（对应 {@code AgentPartialThinkingEvent}）。 */
export interface AgentPartialThinkingEvent extends EventInterface {
  type: 'PARTIAL_THINKING';
  agentId?: string;
  /** 本次增量思考内容 */
  content: string;
}

/** AI_MESSAGE —— 一轮模型的最终助手消息（对应 {@code AgentMessageEvent}）。 */
export interface AgentMessageEvent extends EventInterface {
  type: 'AI_MESSAGE';
  /** 正文 */
  text?: string;
  /** 结构化思考内容 */
  thinking?: string;
}

/* ------------------------------------------------------------------ */
/* 工具调用事件                                                         */
/* ------------------------------------------------------------------ */

/** TOOL_CALL —— 工具即将被调用（对应 {@code ToolCallStartEvent}）。 */
export interface ToolCallStartEvent extends EventInterface {
  type: 'TOOL_CALL';
  /** 调用 id，与同一 tool_call 行的其他事件关联。框架侧取自 tool_call.id，恒非空 */
  requestId: string;
  /** 工具名。TOOL_CALL 仅在工具已注册且通过审批后发布，恒非空 */
  toolName: string;
  /** 调用参数（JSON 字符串，非对象） */
  args?: string;
  /** 恒为 STARTED */
  resultStatus?: 'STARTED';
}

/** TOOL_COMPLETED —— 工具执行结束（对应 {@code ToolCallEndEvent}）。 */
export interface ToolCallEndEvent extends EventInterface {
  type: 'TOOL_COMPLETED';
  requestId?: string;
  toolName?: string;
  /** 调用参数（JSON 字符串，非对象） */
  args?: string;
  /** 工具输出（JSON 字符串，非对象） */
  output?: string;
  resultStatus?: ToolCallStatus;
}

/* ------------------------------------------------------------------ */
/* 上下文事件                                                           */
/* ------------------------------------------------------------------ */

/** CONTEXT_UPDATE —— 上下文用量变化 / 压缩进度（对应 {@code ContextUpdateEvent}）。 */
export interface ContextUpdateEvent extends EventInterface {
  type: 'CONTEXT_UPDATE';
  phase?: ContextUpdatePhase;
  /** 用量指标；未配置上下文上限时为 null */
  usage?: ContextUsageMetric | null;
  /** 面向 UI 的进度文案（可选） */
  message?: string;
}

/* ------------------------------------------------------------------ */
/* 判别式联合与事件表                                                   */
/* ------------------------------------------------------------------ */

/**
 * 事件类型 → 接口 的映射表。
 *
 * <p>消费侧用 {@code AgentEventMap[T]} 拿到确定类型；{@link RuntimeEventType} 由它派生，
 * 新增事件只需在这里加一行，不再维护第二份手写字面量联合。</p>
 */
export interface AgentEventMap {
  EXECUTION_STARTED: ExecutionStartEvent;
  EXECUTION_COMPLETED: ExecutionCompleteEvent;
  EXECUTION_FAILED: ExecutionErrorEvent;
  EXECUTION_CANCELLED: ExecutionCancelledEvent;
  EXECUTION_SUSPENDED: ExecutionSuspendedEvent;
  EXECUTION_RESUME: ExecutionResumedEvent;
  PARTIAL_TEXT: AgentPartialTextEvent;
  COMPLETE_TEXT: AgentCompleteTextEvent;
  PARTIAL_THINKING: AgentPartialThinkingEvent;
  AI_MESSAGE: AgentMessageEvent;
  TOOL_CALL: ToolCallStartEvent;
  TOOL_COMPLETED: ToolCallEndEvent;
  CONTEXT_UPDATE: ContextUpdateEvent;
}

/** 全部运行时事件类型的字面量联合（派生自 {@link AgentEventMap}，勿手写）。 */
export type RuntimeEventType = keyof AgentEventMap;

/** 任一运行时事件（判别式联合）。 */
export type AgentEvent = AgentEventMap[RuntimeEventType];

/* ------------------------------------------------------------------ */
/* 传输信封                                                             */
/* ------------------------------------------------------------------ */

/**
 * 一条已解析的 SSE 事件。
 *
 * <p>{@code event} 是 SSE 的 event 名（= 事件体 {@code type}），{@code data} 是反序列化后的事件体；
 * 解析失败为 null，原文见 {@code raw}。二者理论上恒等，但解析失败时 {@code data} 为 null，
 * 消费侧必须先判空再按 {@code event} 收窄。</p>
 */
export interface SseEvent<T extends EventInterface = EventInterface> {
  /** SSE event 名，取值同事件体的 {@code type} */
  event: T['type'];
  /** 反序列化后的事件体；解析失败为 null */
  data: T | null;
  /** data 行原文，解析失败时用于排查 */
  raw: string;
}

/** 收窄后的 SSE 事件：把事件名与事件体绑定到同一类型。 */
export type TypedSseEvent<K extends RuntimeEventType> = SseEvent<AgentEventMap[K]>;

/**
 * 事件名是否为已知的运行时事件类型。
 *
 * <p>用于在传输边界把 {@code string} 收窄成 {@link RuntimeEventType}；未知事件应被安全忽略。</p>
 */
export function isAgentEventType(type: string): type is RuntimeEventType {
  return Object.prototype.hasOwnProperty.call(AGENT_EVENT_TYPES, type);
}

/** 已知事件类型集合（运行时校验用，与 {@link AgentEventMap} 同源）。 */
const AGENT_EVENT_TYPES: Record<RuntimeEventType, true> = {
  EXECUTION_STARTED: true,
  EXECUTION_COMPLETED: true,
  EXECUTION_FAILED: true,
  EXECUTION_CANCELLED: true,
  EXECUTION_SUSPENDED: true,
  EXECUTION_RESUME: true,
  PARTIAL_TEXT: true,
  COMPLETE_TEXT: true,
  PARTIAL_THINKING: true,
  AI_MESSAGE: true,
  TOOL_CALL: true,
  TOOL_COMPLETED: true,
  CONTEXT_UPDATE: true,
};
