/** 历史与块事件只转换输入，展示统一由轮次状态生成。 */

import type { BlockStatus, ToolBlock, TurnViewVO } from '../../types/block';
import { parseVersion } from '../../types/block';
import type { ChatMessage, ToolCallTrace } from '../../types/chat';
import { resolveToolCategory } from '../../utils/toolMeta';
import { toObject } from '../../utils/json';
import { parseToolDiff } from '../../utils/toolDiff';
import { applyTextPlacement, applyTurnStatus, renderTurnState, writeResponseText, writeToolTrace } from './turnRenderState';


/** 思考 / 文本块的状态取值（后端 {@code BlockStatus} 的响应生命周期两态）。 */
const RESPONSE_STREAMING = 'STREAMING';
const RESPONSE_COMPLETE = 'COMPLETE';

/** 工具块状态 → {@link ToolCallTrace['status']}（与 {@code utils/toolMeta.ts#resolveToolExecutionStatus} 的四态对齐）。 */
function toolStatus(status: BlockStatus): ToolCallTrace['status'] {
  switch (status) {
    // 已收尾（成功 / 被批准 / 已回答）—— 后端在落库时统一给 COMPLETED
    case 'COMPLETED':
      return 'success';
    case 'FAILED':
    case 'REJECTED':
    case 'TIMED_OUT':
    case 'CANCELLED':
      return 'failed';
    case 'PROMISED':
      return 'pending';
    case 'STARTED':
    case RESPONSE_STREAMING:
    default:
      // 未收尾：本地「已请求、等待结果」态。绝不显示成成功或失败。
      return 'calling';
  }
}

/** 工具块 → 工具调用轨迹。 */
function toToolTrace(block: ToolBlock): ToolCallTrace {
  const argsObj = toObject(block.arguments ?? '{}', {});
  const diff = parseToolDiff({ toolName: block.toolName, result: block.output ?? undefined });
  return {
    id: block.toolCallId,
    toolName: block.toolName,
    args: argsObj,
    query: block.arguments ?? undefined,
    result: block.output ?? undefined,
    status: toolStatus(block.status),
    category: resolveToolCategory(block.toolName),
    plusLines: block.plusLines ?? diff?.plusLines ?? undefined,
    minusLines: block.minusLines ?? diff?.minusLines ?? undefined,
    order: block.order,
    responseId: block.responseId,
  };
}

/** 历史与实时快照只补齐同一份状态，不再覆盖展示数组。 */
export function projectTurnView(bubble: ChatMessage, view: TurnViewVO): void {
  upsertBlockIntoBubble(bubble, view);
  applyTurnStatus(bubble, view.status);
}

/**
 * 由后端轮次视图**直接构造**助手气泡（历史与实时共用的唯一落点）。
 *
 * <p><b>为什么需要它</b>：这是「只保留一条展示链路」的入口 —— 后端 {@link TurnViewVO}
 * 已完整给出该轮的用户提问、块列表（含 order / placement / status），前端无需再从原始
 * 消息行聚合。历史分页与实时快照走同一函数，产出的气泡必然同形状。</p>
 *
 * <p><b>身份</b>：气泡 id 取自 {@code sessionId + turnId}（与实时
 * {@code obtainActiveBubble} 的命名一致），使「同一轮无论从历史还是实时来」都是同一条。</p>
 */
export function buildBubbleFromTurnView(view: TurnViewVO, fallbackTimestamp = Date.now()): ChatMessage {
  const bubble: ChatMessage = {
    id: `bubble-${view.sessionId}-${view.turnId}`,
    role: 'assistant',
    content: '',
    timestamp: fallbackTimestamp,
    turnId: view.turnId,
    isComplete: false,
    isThinking: false,
    isExploring: false,
    isSuspended: false,
    thoughtSteps: [],
    toolCalls: [],
    aiMessages: [],
    processTimeline: [],
  };
  projectTurnView(bubble, view);
  return bubble;
}

/**
 * 视图的用户提问 → 用户气泡（历史侧唯一来源）。
 *
 * <p>没有提问文本时返回 {@code null}：不造空用户气泡（后端旧数据可能缺该字段）。</p>
 */
export function buildUserMessageFromTurnView(
  view: TurnViewVO,
  fallbackTimestamp = Date.now()
): ChatMessage | null {
  const text = view.userMessage;
  if (!text && !view.userImageUrls?.length) return null;
  return {
    id: `user-${view.sessionId}-turn-${view.turnId}`,
    role: 'user',
    content: text ?? '',
    imageUrls: view.userImageUrls ? [...view.userImageUrls] : [],
    timestamp: fallbackTimestamp,
    turnId: view.turnId,
  };
}

/** 按权威轮次与版本补齐状态；空失败轮保留给错误气泡合成。 */
export function upsertTurnViewIntoMessages(
  messages: ChatMessage[],
  view: TurnViewVO,
  versions: Map<string, number>,
  fallbackTimestamp = Date.now()
): void {
  const turnKey = String(view.turnId);
  const incoming = parseVersion(view.viewVersion);
  const current = versions.get(turnKey);
  if (current !== undefined && incoming < current) return;
  versions.set(turnKey, incoming);

  const existingUser = messages.find(message => message.role === 'user' && message.turnId === view.turnId);
  if (existingUser && view.userImageUrls !== undefined) existingUser.imageUrls = [...view.userImageUrls];

  // 原气泡只补齐状态，避免替换对象导致 DOM 重建。
  const existing = messages.find(m => m.role === 'assistant' && m.turnId === view.turnId);
  if (existing) {
    projectTurnView(existing, view);
    // 用户气泡文本若在历史里出现（首屏从未给过），补上；已存在则不动。
    if ((view.userMessage || view.userImageUrls?.length) && !messages.some(m => m.role === 'user' && m.turnId === view.turnId)) {
      const userMessage = buildUserMessageFromTurnView(view, fallbackTimestamp);
      if (userMessage) messages.splice(messages.indexOf(existing), 0, userMessage);
    }
    return;
  }

  // 空块 + 失败态：不建空气泡，交给 synthesizeFailedTurnBubbles 用 turns.errorReason 合成。
  // 但用户提问仍要落（否则该轮在界面上完全没有痕迹）。
  if (view.blocks.length === 0 && isFailedStatus(view.status)) {
    if ((view.userMessage || view.userImageUrls?.length) && !messages.some(m => m.role === 'user' && m.turnId === view.turnId)) {
      const userMessage = buildUserMessageFromTurnView(view, fallbackTimestamp);
      if (userMessage) {
        messages.splice(resolveTurnInsertIndex(messages, view.turnId), 0, userMessage);
      }
    }
    return;
  }

  // 新轮次：按雪花键插到正确位置（不能一律追加，否则翻旧页会把旧轮次塞到末尾）
  const insertAt = resolveTurnInsertIndex(messages, view.turnId);
  const bubble = buildBubbleFromTurnView(view, fallbackTimestamp);
  const userMessage = buildUserMessageFromTurnView(view, fallbackTimestamp);
  const pair = userMessage && !existingUser ? [userMessage, bubble] : [bubble];
  messages.splice(insertAt, 0, ...pair);
}

/** 该轮是否为「失败但可能无内容」的终态（无块时不该建空气泡）。 */
function isFailedStatus(status: string | null | undefined): boolean {
  return status === 'FAILED' || status === 'CANCELLED';
}

/**
 * 新轮次相对消息数组的插入位置：按 turnId 雪花键升序。
 *
 * <p>解析不出雪花键（异常数据）时追加到末尾 —— 与既有历史排序口径保持一致。</p>
 */
function resolveTurnInsertIndex(messages: ChatMessage[], turnId: string): number {
  const key = parseSnowflakeKey(turnId);
  if (key === null) return messages.length;
  for (let i = 0; i < messages.length; i++) {
    const currentKey = parseSnowflakeKey(messages[i].turnId);
    if (currentKey !== null && key < currentKey) return i;
  }
  return messages.length;
}

/** turnId → BigInt（雪花超 JS 安全整数，必须用 BigInt 比较）；非纯数字返回 null。 */
function parseSnowflakeKey(raw: unknown): bigint | null {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  return /^\d+$/.test(text) ? BigInt(text) : null;
}

/** 快照和单块更新使用同一条写入路径，缺少的块不能删除已收到的内容。 */
export function upsertBlockIntoBubble(bubble: ChatMessage, view: TurnViewVO): void {
  for (const block of view.blocks) {
    if (block.type === 'TOOL') {
      writeToolTrace(bubble, toToolTrace(block));
      continue;
    }
    const buffer = writeResponseText(bubble, block.blockId, block.type, 0, block.text);
    if (!buffer) continue;
    buffer.order = block.order;
    buffer.responseId = block.responseId ?? buffer.responseId;
    buffer.complete ||= block.status === RESPONSE_COMPLETE && block.text.length >= buffer.text.length;
    if (block.type === 'TEXT') {
      applyTextPlacement(bubble, block.blockId, block.placement);
    }
  }
  renderTurnState(bubble);
}
