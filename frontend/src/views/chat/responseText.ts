import type { ChatMessage } from '../../types/chat';
import type { AgentEvent } from '../../types/Event';
import { applyTextPlacement, getTurnState, renderTurnState, writeResponseText } from './turnRenderState';

/** 全文也从零偏移写入，重复的完成通知不会再次追加。 */
export function consumeResponseText(bubble: ChatMessage, event: AgentEvent): boolean {
  if (!('responseId' in event) || !event.responseId) return false;
  const responseId = event.responseId;
  if (event.type === 'PARTIAL_TEXT' || event.type === 'PARTIAL_THINKING') {
    if (event.offset === undefined) return false;
    const kind = event.type === 'PARTIAL_TEXT' ? 'TEXT' : 'THINKING';
    const id = `${kind === 'TEXT' ? 'text' : 'thinking'}:${responseId}`;
    if (getTurnState(bubble).texts[id]?.complete) return false;
    const buffer = writeResponseText(bubble, id, kind, event.offset, event.content);
    if (!buffer) return false;
    buffer.responseId = responseId;
    if (event.order !== undefined) buffer.order = event.order;
  } else if (event.type === 'COMPLETE_TEXT') {
    if (typeof event.content !== 'string') return false;
    const buffer = writeResponseText(bubble, `text:${responseId}`, 'TEXT', 0, event.content);
    if (!buffer) return false;
    buffer.responseId = responseId;
    if (event.order !== undefined) buffer.order = event.order;
    buffer.complete ||= event.content.length >= buffer.text.length;
  } else if (event.type === 'AI_MESSAGE') {
    for (const [kind, text] of [['TEXT', event.text], ['THINKING', event.thinking]] as const) {
      if (typeof text !== 'string') continue;
      const buffer = writeResponseText(bubble, `${kind === 'TEXT' ? 'text' : 'thinking'}:${responseId}`, kind, 0, text);
      if (buffer) {
        const order = kind === 'THINKING' ? event.thinkingOrder : event.order;
        buffer.responseId = responseId;
        if (order !== undefined) buffer.order = order;
        buffer.complete ||= text.length >= buffer.text.length;
      }
    }
  } else return false;
  applyTextPlacement(bubble, `text:${responseId}`, event.isBody);
  renderTurnState(bubble);
  return true;
}
