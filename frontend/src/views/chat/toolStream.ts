import type { ToolCallStartEvent, ToolCallEndEvent } from '../../types/Event';
import type { ChatMessage, ToolCallTrace } from '../../types/chat';
import { toObject } from '../../utils/json';
import { resolveToolCategory, resolveToolExecutionStatus } from '../../utils/toolMeta';
import { parseToolDiff } from '../../utils/toolDiff';
import { getTurnState, renderTurnState, writeResponseText, writeToolTrace } from './turnRenderState';

/** 调用身份来自框架事件，开始和收尾更新同一份轮次状态。 */
export function consumeToolEvent(bubble: ChatMessage, event: ToolCallStartEvent | ToolCallEndEvent): boolean {
  if (!event.requestId) return false;
  const previous = getTurnState(bubble).tools[event.requestId];
  const toolName = event.toolName ?? previous?.toolName;
  if (!toolName) return false;
  const trace: ToolCallTrace = { id: event.requestId, toolName,
    category: resolveToolCategory(toolName), status: event.type === 'TOOL_CALL' ? 'calling' : resolveToolExecutionStatus(event.resultStatus),
    order: event.order };
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
  if (event.responseId) {
    // 工具事件可能先于文本，先记住用途，后到的文本仍归同一响应。
    const text = writeResponseText(bubble, `text:${event.responseId}`, 'TEXT', 0, '');
    if (text) text.placement = 'PROCESS';
  }
  renderTurnState(bubble);
  return true;
}
