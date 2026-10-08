import { isAgentEventType, type AgentEvent, type SseEvent } from '../../types/Event';
import type { RawSseEvent } from '../../services/sse';

/**
 * 把传输层原始事件收窄成业务事件（发送流与会话级流共用同一收窄口径）。
 *
 * <p>传输层（{@link RawSseEvent}）不认业务类型，收窄只在编排边界做一次：事件名不在已知词表内
 * 返回 null，由调用方按「未知事件安全忽略」处理；事件体解析失败时 data 为 null、raw 仍留原文。</p>
 *
 * <p><b>为什么必须把 {@code event} 名写回事件体</b>：SSE 的判别式在 {@code event:} 行，
 * 而框架事件体自带 {@code type} 字段、业务块事件体（{@code BlockEventPayload}）**没有**。
 * 下游 reducer 统一按 {@code switch(event.type)} 分派，若只往下传事件体，块视图事件
 * 拿到的 {@code type} 恒为 {@code undefined}，落 {@code default} 分支被静默跳过。
 * 这里把事件名补成事件体的 {@code type}，让两种事件在消费者那里形状一致 ——
 * 业务事件的存在性因此不再依赖"调用方记得同时传信封"。</p>
 */
export function toAgentEvent(raw: RawSseEvent): SseEvent<AgentEvent> | null {
  if (!isAgentEventType(raw.event)) return null;
  if (raw.data === null || typeof raw.data !== 'object') {
    return { event: raw.event, data: null, raw: raw.raw };
  }
  // 事件体自述类型：SSE 事件名是唯一真源，覆盖任何事件体里的同名字段
  // （框架事件体本就同值，覆盖无副作用；业务事件体本无此字段，此处补齐）。
  const data = { ...(raw.data as Record<string, unknown>), type: raw.event } as AgentEvent;
  return { event: raw.event, data, raw: raw.raw };
}
