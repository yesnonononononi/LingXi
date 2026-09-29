/**
 * SSE 流解析的唯一实现。
 *
 * 收敛原因：原先 `data:` 前缀用硬编码 `slice(5)` 截断、`[DONE]` 用全等比较、
 * 事件类型还额外猜一个 `eventType` 字段（后端从不发送，契约见 docs/frontend-backend-contract.md §2）、
 * 载荷字段别名散落在解析循环里，并且"解析失败就把原始行当正文显示"会把协议噪声直接呈现给用户。
 */

import type { AgentStreamEvent } from '../types/chat';

/** OpenAI 风格流结束标记 */
export const SSE_DONE_SIGNAL = '[DONE]';

/**
 * SSE 空闲超时缺省值（毫秒）。
 *
 * 定位：这是「防止流悬挂导致 UI 永久思考中」的**兜底安全网**，不是保活机制——正常任务不应触发。
 * 说明：当前所有调用方（views/chat/agent.ts、services/toolCall.ts）均未传 `idleTimeoutMs`，
 *       故全部 SSE 流都使用本默认值；若某条流已知会有更长的静默期（长工具执行、模型长时间无输出），
 *       应在该调用处显式传入更大的值，而不要调小本默认值。
 */
export const DEFAULT_SSE_IDLE_TIMEOUT_MS = 300000;

export type SseLine =
  | { kind: 'empty' }
  | { kind: 'comment' }
  | { kind: 'ignored' }
  | { kind: 'done' }
  | { kind: 'data'; payload: string };

/** `data:` 后允许零个或多个空白，兼容 `data: {...}` 与 `data:{...}` 两种写法 */
const DATA_LINE_PATTERN = /^data:\s*(.*)$/;

/** 解析单行 SSE 文本。协议之外的行（如 event:/id:）统一归入 ignored。 */
export function parseSseLine(line: string): SseLine {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'empty' };
  if (trimmed.startsWith(':')) return { kind: 'comment' };

  const matched = DATA_LINE_PATTERN.exec(trimmed);
  if (!matched) return { kind: 'ignored' };

  const payload = matched[1].trim();
  if (!payload) return { kind: 'empty' };
  if (payload === SSE_DONE_SIGNAL) return { kind: 'done' };
  return { kind: 'data', payload };
}

/** 事件类型统一大写比较，避免大小写差异导致漏判 */
export function normalizeEventType(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim().toUpperCase() : '';
}

/**
 * 终止事件集合。
 *
 * 契约来源：docs/frontend-backend-contract.md §2 —— 框架 `RuntimeEventType` 的终态**仅有**
 * `EXECUTION_COMPLETED` / `EXECUTION_FAILED` / `EXECUTION_CANCELLED` 三个值。
 * `EXECUTION_ERROR` / `ERROR` / `EXECUTION_COMPLETE` / `EXECUTION_START` 在框架枚举中**不存在**，已移除。
 */
const TERMINAL_EVENT_TYPES: readonly string[] = [
  'EXECUTION_COMPLETED',
  'EXECUTION_FAILED',
  'EXECUTION_CANCELLED',
];

export function isTerminalEvent(type?: string | null): boolean {
  return TERMINAL_EVENT_TYPES.includes(normalizeEventType(type));
}

/**
 * SSE 载荷字段归一化。
 *
 * 契约来源：AgentEventListener 直接把 com.summit.core.conversation.event 的运行时事件
 * 序列化后广播，字段名即各事件 record / 类的字段名，不需要别名映射：
 *   - 通用：type、executionId、sessionId（后端已转字符串）、timestamp
 *   - AgentPartialText/Thinking：content
 *   - AgentMessageEvent：text、thinking
 *   - ToolCallStart/End：requestId、toolName、args、output（仅 End）、resultStatus
 *   - ExecutionComplete：tokenInfo.{input,output,total}TokenCount
 *   - ExecutionError：errMsg、extraDes
 * 此处仅做恒等透传（保留 type 与 sessionId 便于统一读取）。
 */
export function normalizeStreamPayload(parsed: Record<string, any>): AgentStreamEvent {
  return {
    ...parsed,
    type: parsed.type,
    sessionId: parsed.sessionId,
  };
}

/** 无事件类型的 JSON 载荷中提取正文；取不到返回 undefined（由调用方决定如何降级） */
export function extractTextContent(parsed: Record<string, any>): string | undefined {
  const value = parsed.content ?? parsed.text;
  return value === undefined || value === null ? undefined : String(value);
}

/**
 * 在 `reader.read()` 上做空闲超时竞速：超过 `idleTimeoutMs` 仍无任何数据即抛出明确错误，
 * 避免服务端不关流时调用方永久挂起。无论成败都会清除定时器，不泄漏。
 */
async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!(idleTimeoutMs > 0)) {
    return reader.read();
  }
  let timer: number | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = window.setTimeout(() => {
          reject(new Error(`SSE 流空闲超时（${idleTimeoutMs}ms 内未收到数据）`));
        }, idleTimeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

/**
 * 逐行读取一个已建立的 SSE 响应体，把解析后的运行时事件逐个回调。
 *
 * 供对话流（/a/completion/stream）与审批恢复流（/interaction/decide）共用：
 * 两者的事件载荷同构，根会话的终态事件即读取终点（服务端也会在执行结束后关闭流）。
 */
export async function readSseResponse(
  response: Response,
  options: {
    onEvent: (event: import('../types/chat').AgentStreamEvent) => void;
    /** 根会话 ID；缺失时以首个 EXECUTION_STARTED 事件携带的会话为准 */
    rootSessionId?: string | null;
    /** 空闲超时（毫秒）；<=0 表示不启用。缺省 DEFAULT_SSE_IDLE_TIMEOUT_MS */
    idleTimeoutMs?: number;
    /**
     * 是否在「根会话终态事件」处结束读取。缺省 `true`（请求级流：这条流本来就只服务一次执行）。
     *
     * 会话级订阅必须传 `false`：一次执行结束不代表这个会话不会再有事发生
     * （恢复、子代理、下一轮消息都会继续往同一条流里推）。传 `true` 会让订阅在第一次
     * 执行结束时静默失效，表现就是「切回来又收不到更新了」。
     */
    stopOnTerminal?: boolean;
  }
): Promise<void> {
  const {
    onEvent,
    rootSessionId: initialRootSessionId,
    idleTimeoutMs = DEFAULT_SSE_IDLE_TIMEOUT_MS,
    stopOnTerminal = true,
  } = options;

  if (!response.body) {
    throw new Error('SSE 响应不含可读流');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  let rootSessionId = initialRootSessionId ?? null;

  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout(reader, idleTimeoutMs);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      let shouldTerminate = false;
      for (const line of lines) {
        const sseLine = parseSseLine(line);

        if (sseLine.kind === 'done') {
          shouldTerminate = true;
          break;
        }
        if (sseLine.kind !== 'data') continue;

        const rawData = sseLine.payload;

        let json: unknown;
        try {
          json = JSON.parse(rawData);
        } catch (err) {
          // 协议噪声：不再把原始行当作正文推送给用户；日志只截断打印，避免泄露完整载荷
          console.warn('[readSseResponse] SSE 数据行不是合法 JSON，已忽略:', rawData.slice(0, 80), err);
          continue;
        }

        if (typeof json === 'string') {
          onEvent({ type: 'PARTIAL_TEXT', content: json });
          continue;
        }

        if (!json || typeof json !== 'object') {
          console.warn('[readSseResponse] SSE 载荷既非字符串也非对象，已忽略:', rawData.slice(0, 80));
          continue;
        }

        const parsed = json as Record<string, any>;
        // 契约来源：所有事件都由后端写入 type（RuntimeEventType.type() / 各事件类的 getType()）。
        const eventType = parsed.type;

        if (eventType) {
          const normalizedEvent = normalizeStreamPayload(parsed);
          onEvent(normalizedEvent);

          const typeUpper = normalizeEventType(eventType);
          const eventSessionId = normalizedEvent.sessionId == null
            ? null
            : String(normalizedEvent.sessionId);
          if (!rootSessionId && typeUpper === 'EXECUTION_STARTED') {
            rootSessionId = eventSessionId;
          }
          // 子 Agent 也会发完成事件；只有根会话结束才能关闭本次读取。
          // 会话级订阅（stopOnTerminal=false）跳过这段：一次执行结束不是这个会话的终点。
          if (
            stopOnTerminal
            && isTerminalEvent(typeUpper)
            && rootSessionId !== null
            && eventSessionId === rootSessionId
          ) {
            shouldTerminate = true;
            break;
          }
          continue;
        }

        // 无事件类型的 JSON 载荷：仅在其确实携带文本字段时才作为正文推送，
        // 否则记录告警并忽略 —— 不再把整个 JSON 序列化后展示给用户
        const textContent = extractTextContent(parsed);
        if (textContent !== undefined) {
          onEvent({ type: 'PARTIAL_TEXT', content: textContent, sessionId: parsed.sessionId });
        } else {
          console.warn('[readSseResponse] SSE 载荷缺少事件类型与文本字段，已忽略:', Object.keys(parsed));
        }
      }

      if (shouldTerminate) {
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/**
 * 从错误载荷中提取人可读的错误文本。
 * 契约来源：ExecutionErrorEvent —— 主文案 errMsg，补充说明 extraDes。
 */
export function extractEventError(payload: Record<string, any>): string {
  const raw = payload.errMsg ?? payload.extraDes;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : '';
}
