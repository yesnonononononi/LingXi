import type { ToolCallStartEvent, ToolCallEndEvent } from '../../types/Event';
import type { ChatMessage, ToolCallTrace } from '../../types/chat';
import { toObject } from '../../utils/json';
import { resolveToolCategory, resolveToolExecutionStatus } from '../../utils/toolMeta';
import { parseToolDiff } from '../../utils/toolDiff';
import { applyTextPlacement, getTurnState, renderTurnState, writeResponseText, writeToolTrace } from './turnRenderState';

/** 调用身份来自框架事件，开始和收尾更新同一份轮次状态。 */
export function consumeToolEvent(bubble: ChatMessage, event: ToolCallStartEvent | ToolCallEndEvent): boolean {
  if (!event.requestId) return false;
  const previous = getTurnState(bubble).tools[event.requestId];
  const toolName = event.toolName ?? previous?.toolName;
  if (!toolName) return false;
  const trace: ToolCallTrace = { id: event.requestId, toolName,
    category: resolveToolCategory(toolName), status: event.type === 'TOOL_CALL' ? 'calling' : resolveToolExecutionStatus(event.resultStatus),
    order: event.order, responseId: event.responseId };
  if (event.args !== undefined) {
    trace.query = event.args;
    trace.args = toObject(event.args, {});
  }
  if (event.type === 'TOOL_COMPLETED') {
    trace.result = event.output;
    const fileEdit = event.metaData?.fileEdit;
    const diff = parseToolDiff({ toolName, result: event.output,
      plusLines: fileEdit?.plusLines, minusLines: fileEdit?.minusLines });
    trace.plusLines = diff?.plusLines ?? undefined;
    trace.minusLines = diff?.minusLines ?? undefined;
  }
  writeToolTrace(bubble, trace);
  if (event.responseId && event.isBody !== undefined) {
    writeResponseText(bubble, `text:${event.responseId}`, 'TEXT', 0, '');
    applyTextPlacement(bubble, `text:${event.responseId}`, event.isBody);
  }
  renderTurnState(bubble);
  return true;
}
