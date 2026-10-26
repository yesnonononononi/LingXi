import type { AiMessageItem, ChatMessage, ResponseTextBuffer, ThoughtStep, ToolCallTrace, TurnRenderState } from '../../types/chat';
import type { ResponsePosition } from '../../utils/responseOrder';
import { compareResponsePosition } from '../../utils/responseOrder';
import { t } from '../../i18n';

export function getTurnState(bubble: ChatMessage): TurnRenderState {
  return bubble.turnState ??= { texts: {}, tools: {} };
}

/** 旧运行快照不能重开终态或解除挂起，恢复必须由恢复事件驱动。 */
export function applyTurnStatus(bubble: ChatMessage, status: string): void {
  if (bubble.isComplete && (status === 'RUNNING' || status === 'WAITING')) return;
  if (bubble.isSuspended && status === 'RUNNING') return;
  if (status === 'COMPLETED' || status === 'FAILED' || status === 'CANCELLED') {
    bubble.modelRetry = undefined;
    bubble.isComplete = true;
    bubble.isThinking = false;
    bubble.isExploring = false;
    bubble.isSuspended = false;
  } else if (status === 'WAITING') {
    bubble.modelRetry = undefined;
    bubble.isSuspended = true;
    bubble.isThinking = false;
    bubble.isExploring = false;
  } else if (status === 'RUNNING') {
    bubble.isThinking = true;
    bubble.isSuspended = false;
    bubble.isComplete = false;
  }
}

/** 正文归属只接受后端字段；只允许 false → true 升级，一旦定正文就不接受降级（迟到的旧帧不得把它拉回过程区）。 */
export function applyTextPlacement(bubble: ChatMessage, id: string, isBody?: boolean): void {
  const buffer = getTurnState(bubble).texts[id];
  if (!buffer || isBody === undefined) return;
  if (buffer.isBody === true) return;
  buffer.isBody = isBody;
}

/** offset 使用 UTF-16 长度；全文和历史都从零写入，缺口补齐后再连续打印。 */
export function writeResponseText(
  bubble: ChatMessage, id: string, kind: 'TEXT' | 'THINKING', offset: number, text: string
): ResponseTextBuffer | null {
  if (!Number.isSafeInteger(offset) || offset < 0 || typeof text !== 'string') return null;
  const texts = getTurnState(bubble).texts;
  const buffer = texts[id] ??= { kind, text: '', pending: {}, complete: false };
  if (offset === buffer.text.length && Object.keys(buffer.pending).length === 0) {
    buffer.text += text;
    return buffer;
  }
  const segments = [{ offset: 0, text: buffer.text }, ...Object.entries(buffer.pending)
    .map(([start, value]) => ({ offset: Number(start), text: value }))];
  for (const segment of segments) {
    const start = Math.max(offset, segment.offset);
    const end = Math.min(offset + text.length, segment.offset + segment.text.length);
    if (start < end && text.slice(start - offset, end - offset) !== segment.text.slice(start - segment.offset, end - segment.offset)) {
      console.warn(`响应文本冲突: turnId=${bubble.turnId}, response=${id}, offset=${offset}`);
      return null;
    }
  }
  buffer.pending[offset] = text.length >= (buffer.pending[offset]?.length ?? 0) ? text : buffer.pending[offset]!;
  for (const start of Object.keys(buffer.pending).map(Number).sort((a, b) => a - b)) {
    if (start > buffer.text.length) break;
    const segment = buffer.pending[start]!;
    if (start + segment.length > buffer.text.length) buffer.text += segment.slice(buffer.text.length - start);
    delete buffer.pending[start];
  }
  return buffer;
}

/** 实时与历史都按真实调用 ID 更新；缺失字段和较早的运行态不能抹掉收尾结果。 */
export function writeToolTrace(bubble: ChatMessage, incoming: ToolCallTrace): void {
  const tools = getTurnState(bubble).tools;
  const previous = tools[incoming.id];
  if (!previous) {
    tools[incoming.id] = incoming;
    return;
  }
  // 一旦拿到持久化工具块，后续结果只接受同源的新版本，不再靠状态猜新旧。
  if (previous.version !== undefined &&
      (incoming.version === undefined || incoming.version <= previous.version)) return;
  const terminal = previous.status === 'success' || previous.status === 'failed';
  const retainResult = (terminal && incoming.status !== 'success' && incoming.status !== 'failed') ||
    (previous.status === 'pending' && incoming.status === 'calling');
  Object.assign(previous, { ...incoming,
    version: incoming.version ?? previous.version,
    order: incoming.order ?? previous.order,
    responseId: incoming.responseId ?? previous.responseId,
    query: incoming.query ?? previous.query,
    args: incoming.query === undefined ? previous.args : incoming.args,
    result: retainResult ? previous.result : incoming.result ?? previous.result,
    status: retainResult ? previous.status : incoming.status,
    plusLines: incoming.plusLines ?? previous.plusLines,
    minusLines: incoming.minusLines ?? previous.minusLines });
}

/** 保留条目身份，只有成员或位置变化才替换数组，已排序的列表不重复排序。 */
function reconcileRenderItems<T extends ResponsePosition & { id?: string }>(previous: T[] | undefined, incoming: T[]): T[] {
  const current = previous ?? [];
  const remaining = new Map(incoming.map(item => [item.id, item]));
  const next: T[] = [];
  for (const item of current) {
    const update = remaining.get(item.id);
    if (!update) continue;
    if (item !== update) Object.assign(item, update);
    next.push(item);
    remaining.delete(item.id);
  }
  next.push(...remaining.values());
  if (next.some((item, index) => index > 0 && compareResponsePosition(next[index - 1]!, item) > 0)) {
    next.sort(compareResponsePosition);
  }
  return current.length === next.length && current.every((item, index) => item === next[index]) ? current : next;
}

/** 内容变化只更新原条目，避免每个文本分片使工具区与完整过程列表失效。 */
export function renderTurnState(bubble: ChatMessage): void {
  const state = getTurnState(bubble);
  const thoughts: ThoughtStep[] = [];
  const messages: AiMessageItem[] = [];
  let body: ResponseTextBuffer | undefined;
  for (const [id, buffer] of Object.entries(state.texts)) {
    if (!buffer.text) continue;
    if (buffer.kind === 'THINKING') {
      const step = { id, title: t('tool.category.think'), content: buffer.text,
        status: buffer.complete ? 'success' as const : 'running' as const, order: buffer.order, responseId: buffer.responseId };
      thoughts.push(step);
    } else if (buffer.isBody !== true) {
      const message = { id, text: buffer.text, order: buffer.order, responseId: buffer.responseId };
      messages.push(message);
    } else if (!body || compareResponsePosition(body, buffer) <= 0) {
      body = buffer;
    }
  }
  bubble.thoughtSteps = reconcileRenderItems(bubble.thoughtSteps, thoughts);
  bubble.aiMessages = reconcileRenderItems(bubble.aiMessages, messages);
  bubble.toolCalls = reconcileRenderItems(bubble.toolCalls, Object.values(state.tools));
  // 正文只由后端 isBody === true 决定，前端不猜工具调用是否出现。
  bubble.content = body?.text ?? '';
  if (bubble.sendError && !bubble.content.endsWith(bubble.sendError)) {
    bubble.content = bubble.content ? `${bubble.content}\n\n${bubble.sendError}` : bubble.sendError;
  }
}
