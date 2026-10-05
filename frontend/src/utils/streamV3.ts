/**
 * v3 流协议的唯一解析落点。
 *
 * <h3>为什么要单独一个文件</h3>
 * 第 4 步把前端事件消费收敛到「唯一 ingress + 单一状态」：v3 帧与 v1 运行时事件是两套
 * **不可合并**的命名空间（v1 见 {@link ../types/chat.RuntimeEventType}，由框架
 * `RuntimeEventType` 下发；v3 是后端 `StreamV3EventType` 的 11 个 wire 值）。把 v3 的类型
 * 字面量、帧结构、终止谓词全部收在这里，消费方（sseRouter + 状态机）只依赖本模块，
 * 不各自硬编码字符串、不各自解释「执行是否结束」。
 *
 * <h3>与 v1 的关键区别（踩坑点）</h3>
 * - **分派依据是 `data` JSON 内的 `type`，不是 SSE 的 `event:` 名。** `utils/sse.ts#parseSseLine`
 *   把 `event:` 行归入 `ignored`，只解析 `data:` 行；`SseEmitter.event().name(...)` 下发的事件名
 *   前端根本读不到（见 design §8.3）。
 * - **载荷在 `data` 字段里，不展平。** 顶层不是 `delta`/`text`，而是 `{ ..., data: {...} }`。
 *   `TEXT_DELTA.data.delta`、`RESPONSE_FINALIZED.data.text`、`TOOL_CALL_UPDATED.data` 是完整
 *   `ToolCallVO`（不是 `{toolCall: {...}}`）。
 * - **Long 字段已是字符串。** 信封里 `rootSessionId`/`sessionId`/`turnId`/`executionId`/
 *   `historyRevision` 后端已序列化为十进制字符串，前端**不再做 `String()` 归一**。
 */

/** v3 协议版本号；`STREAM_READY.data.schemaVersion` 必须等于它，否则放弃并要求刷新。 */
export const STREAM_V3_SCHEMA_VERSION = 3;

/**
 * v3 事件类型的 wire 值集合。
 *
 * <p><b>与 v1 `RuntimeEventType` 是两套命名空间，不可互相代入。</b>本枚举手写，真源是后端
 * `com.summit.dp.stream.application.protocol.StreamV3EventType`；两侧改名必须人工同步，
 * 否则帧会被静默忽略（不是报错）。</p>
 *
 * <p>用 `as const` + 联合类型而非 TS `enum`：工程开启 `erasableSyntaxOnly`，`enum` 会编译报错。</p>
 */
export const STREAM_V3_EVENT_TYPES = [
  'STREAM_READY',
  'RESPONSE_STARTED',
  'TEXT_DELTA',
  'THINKING_DELTA',
  'RESPONSE_FINALIZED',
  'MESSAGE_COMMITTED',
  'TOOL_CALL_UPDATED',
  'EXECUTION_UPDATED',
  'TURN_UPDATED',
  'SESSION_UPDATED',
  'HISTORY_INVALIDATED',
] as const;

/** v3 事件类型（wire 值联合）。 */
export type StreamV3EventType = (typeof STREAM_V3_EVENT_TYPES)[number];

const STREAM_V3_TYPE_SET: ReadonlySet<string> = new Set(STREAM_V3_EVENT_TYPES);

/** 判定一个字符串是否为已知的 v3 wire 类型（用于「未命中记 warn 后忽略」）。 */
export function isStreamV3EventType(raw: unknown): raw is StreamV3EventType {
  return typeof raw === 'string' && STREAM_V3_TYPE_SET.has(raw);
}

/* ------------------------------------------------------------------ */
/* 载荷类型（与后端 `StreamV3Payloads` 的各 record 一一对应）             */
/* ------------------------------------------------------------------ */

/** STREAM_READY 载荷：连接登记完成，携带本连接标识与协议版本。 */
export interface StreamV3ReadyPayload {
  connectionId: string;
  schemaVersion: number;
}

/** RESPONSE_STARTED 载荷：声明本次响应身份。 */
export interface StreamV3ResponseStartedPayload {
  streamKey: string;
  purpose?: string | null;
}

/** TEXT_DELTA / THINKING_DELTA 载荷：只追加的片段。 */
export interface StreamV3DeltaPayload {
  streamKey: string;
  delta: string;
}

/** RESPONSE_FINALIZED 载荷：该响应的权威完整正文、思考与用途。 */
export interface StreamV3ResponseFinalizedPayload {
  streamKey: string;
  text: string | null;
  thinking: string | null;
  purpose?: string | null;
}

/**
 * MESSAGE_COMMITTED 载荷：同一 streamKey 已落库消息的身份与本体。
 *
 * <p>`thinking` / `toolCalls` 是 AI 行的本体字段，实时通道没有别的来源（不发 TOOL_CALL_UPDATED），
 * 缺少它们会让回答一完成就丢掉思考过程与全部工具痕迹。USER 行两者为 null。</p>
 */
export interface StreamV3MessageCommittedPayload {
  streamKey: string;
  messageId: string;
  sessionId: string | null;
  turnId: string | null;
  text: string | null;
  thinking?: string | null;
  toolCalls?: ModelToolCall[] | null;
  type: string | null;
}

/** 模型请求视图里的一次工具调用（与后端 ModelToolCallVO 同形状）。 */
export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** EXECUTION_UPDATED 载荷：执行生命周期状态语义（框架 `ExecutionState` 名）。 */
export interface StreamV3ExecutionStatePayload {
  state: string;
}

/**
 * HISTORY_INVALIDATED 载荷：新代际与作废范围。
 *
 * <p>`turnIds` / `executionIds` 是本次作废**点名删除**的范围（重发：目标轮次及其后）。
 * 缺少它们时前端只能按「整树清空」处理，那会把目标之前仍然有效的历史一起抹掉 ——
 * 而范围化回执只负责删、不负责还原。范围随提交事实直投（不再回查）。</p>
 */
export interface StreamV3HistoryInvalidatedPayload {
  rootSessionId: string | null;
  historyRevision: string;
  turnIds?: string[] | null;
  executionIds?: string[] | null;
}

/**
 * v3 直投信封（对应后端 `StreamV3Event`）。
 *
 * <p>`type` 是 wire 值字符串；`data` 按类型各自解析的对象（见上面各 payload 接口）。
 * STREAM_READY 是控制帧：身份字段（`rootSessionId`/`sessionId`/`turnId`/`executionId`/
 * `historyRevision`/`streamKey`）**全部为 null**，不携带业务状态。</p>
 */
export interface StreamV3Event {
  schemaVersion: number;
  eventId: string;
  rootSessionId: string | null;
  sessionId: string | null;
  turnId: string | null;
  executionId: string | null;
  historyRevision: string | null;
  streamKey: string | null;
  type: StreamV3EventType;
  timestamp: string | null;
  data: unknown;
}

/* ------------------------------------------------------------------ */
/* 帧解析                                                               */
/* ------------------------------------------------------------------ */

/**
 * 从 `data:` 行的已 JSON.parse 结果解析为 v3 信封。
 *
 * <p>入参是 {@link ../utils/sse.readSseResponse} 里 `JSON.parse` 后的对象。本函数只做形状校验与
 * 类型收窄，**不做任何语义路由**（那是消费方状态机的职责）。无法识别（缺 `type`、`type` 不在
 * v3 词表、`schemaVersion` 不符）时返回 `null` 并记一条 warn —— 消费方据此忽略该帧，
 * **禁止** fallback 成正文。</p>
 *
 * @param parsed 已解析的 JSON 对象（未做形状校验）
 * @returns 合法 v3 帧；否则 `null`
 */
export function parseStreamV3Event(parsed: unknown): StreamV3Event | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;

  const rawType = record.type;
  if (!isStreamV3EventType(rawType)) {
    // v1 事件也会走到这里（例如旧协议或调试流量）：记 warn 后忽略，绝不猜语义。
    console.warn('[streamV3] 未知事件类型，已忽略:', rawType);
    return null;
  }

  const schemaVersion = typeof record.schemaVersion === 'number' ? record.schemaVersion : NaN;
  if (schemaVersion !== STREAM_V3_SCHEMA_VERSION) {
    // 版本不符：可能是旧协议帧混入。STREAM_READY 会另外校验，这里只拦明显不符的。
    console.warn('[streamV3] schemaVersion 非 3，已忽略:', schemaVersion, 'type=', rawType);
    return null;
  }

  return {
    schemaVersion,
    eventId: asString(record.eventId),
    rootSessionId: asNullableString(record.rootSessionId),
    sessionId: asNullableString(record.sessionId),
    turnId: asNullableString(record.turnId),
    executionId: asNullableString(record.executionId),
    historyRevision: asNullableString(record.historyRevision),
    streamKey: asNullableString(record.streamKey),
    type: rawType,
    timestamp: asNullableString(record.timestamp),
    data: record.data ?? null,
  };
}

/** 读取字符串字段；缺失/非字符串返回空串。仅用于 `eventId` 这类必填身份。 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** 读取字符串字段；缺失/非字符串返回 `null`。用于可空身份字段。 */
function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/* ------------------------------------------------------------------ */
/* 执行状态的两个判据：终态（执行收尾） vs 定格（响应停收）              */
/* ------------------------------------------------------------------ */

/**
 * 「执行真正终结」的状态集合：COMPLETED / FAILED / CANCELLED。
 *
 * <p><b>只用于「本轮是否已收尾」</b>——终态对账（额外查一次会话树与权威历史）、
 * 「这个执行不会再产出任何东西」这类判断。判据与后端 `ExecutionStatusCodes.isTerminal`
 * 对齐：`TERMINAL_THRESHOLD = COMPLETED(3)`，只有 `>= COMPLETED` 才算终态。</p>
 *
 * <p>⚠️ <b>不要用它判「响应是否该停收增量」</b>：那是 {@link resolveResponseClosed} 的职责。
 * 两者混用是这个文件上一版出过的事故 —— 挂起被当终态，审批挂起时就触发了终态对账。</p>
 */
const EXECUTION_TERMINAL_STATES: ReadonlySet<string> = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

/**
 * 「当前响应停止接收增量」的状态集合：三个终态 **加上 SUSPENDED**。
 *
 * <p>依据 design §8.1 路径 2 与四条退出路径：<b>execution 的终态或 SUSPENDED，无论来自实时
 * 事件还是 bootstrap，都通过同一状态转换结束相关响应的进行态</b>，定格为「未接收完整、
 * 清除进行态、保留已收片段」。</p>
 *
 * <p><b>为什么挂起也要定格</b>：执行生命周期与单个 streamKey 的响应生命周期不是一回事。
 * 挂起意味着当前这段流式输出**已经停下**（等人工决策），断开期间也不会再有这个 key 的增量；
 * 若不定格，这段会永远停在「进行中」而等不来任何结尾。</p>
 *
 * <p><b>定格不等于放弃这一轮</b>：路径 1（同 key 的 `RESPONSE_FINALIZED` / `MESSAGE_COMMITTED`）
 * 优先级最高，后续完整响应照常修复全文；恢复执行产生**新 streamKey** 追加到同一回答组，
 * 旧片段保持定格不重新开放（路径 4 要求定格后的迟到 STARTED/DELTA 不得复活响应）。</p>
 */
const RESPONSE_CLOSING_STATES: ReadonlySet<string> = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'SUSPENDED',
]);

/**
 * 判断一个执行状态是否**真正终结**（COMPLETED / FAILED / CANCELLED）。
 *
 * <p><b>实时事件与 bootstrap 共用这一份谓词</b>（design §8.1 路径 2 要求二者等价）。
 * 不得在 bootstrap 路径另写一套「是否结束」判断，否则两条路径会对同一状态给出不同结论。</p>
 *
 * <p>消费者的语义必须是「执行收尾了、可以去对账了」。判「响应停收」请用
 * {@link resolveResponseClosed} —— 挂起不在本谓词里。</p>
 *
 * @param state 框架 `ExecutionState` 名（大小写敏感，与后端一字不差）
 */
export function resolveExecutionTerminal(state: string | null | undefined): boolean {
  return typeof state === 'string' && EXECUTION_TERMINAL_STATES.has(state);
}

/**
 * 判断一个执行状态是否**结束当前响应的进行态**（三终态 + SUSPENDED）。
 *
 * <p><b>这是 §8.1 路径 2 的判据本体</b>，实时事件与 bootstrap 共用；不得在两条路径上各写一套。
 * 与 {@link resolveExecutionTerminal} 的区别只在于是否包含 SUSPENDED，但语义是两件事：
 * 那个回答「这轮结束没有」，这个回答「这段还能不能收增量」。</p>
 *
 * @param state 框架 `ExecutionState` 名（大小写敏感，与后端一字不差）
 */
export function resolveResponseClosed(state: string | null | undefined): boolean {
  return typeof state === 'string' && RESPONSE_CLOSING_STATES.has(state);
}
