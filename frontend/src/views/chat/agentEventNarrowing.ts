import { isAgentEventType, type AgentEvent, type SseEvent } from '../../types/Event';
import type { RawSseEvent } from '../../services/sse';

/**
 * 把传输层原始事件收窄成业务事件（发送流与会话级流共用同一收窄口径）。
 *
 * <p>传输层（{@link RawSseEvent}）不认业务类型，收窄只在编排边界做一次：事件名不在已知词表内
 * 返回 null，由调用方按「未知事件安全忽略」处理；事件体解析失败时 data 为 null、raw 仍留原文。</p>
 */
export function toAgentEvent(raw: RawSseEvent): SseEvent<AgentEvent> | null {
  if (!isAgentEventType(raw.event)) return null;
  const data = raw.data !== null && typeof raw.data === 'object' ? (raw.data as AgentEvent) : null;
  return { event: raw.event, data, raw: raw.raw };
}
