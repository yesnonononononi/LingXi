import type { ChatMessage, ProcessTimelineItem, SubSessionVO, ToolCallTrace } from '../types/chat';
import { compareResponsePosition } from './responseOrder';
import { extractSubAgentParams, isSubAgentTool } from './toolMeta';
import { t } from '../i18n';

/** 同一会话的多次委派只展示一个成员，名称与序号沿用会话树。 */
export function resolveSubAgentToolCalls(toolCalls: ToolCallTrace[] = [], subSessions: SubSessionVO[] = []): ToolCallTrace[] {
  const tcs = toolCalls?.filter(tc => isSubAgentTool(tc.toolName, tc.category)) || [];
  if (tcs.length === 0) return [];

  const map = new Map<string, ToolCallTrace>();

  tcs.forEach((tc, idx) => {
    const params = extractSubAgentParams(tc);
    const agentId = params.agentId ?? tc.subAgentId;
    const subSessionId = tc.subSessionId ?? params.subSessionId;

    const matchedSub = (subSessionId
      ? subSessions?.find(s => String(s.id) === String(subSessionId))
      : undefined)
      || (agentId ? subSessions?.find(s => String(s.agentId) === String(agentId)) : undefined);

    let displayIndex = idx + 1;
    if (subSessions?.length) {
      const subIdx = subSessions.findIndex(s =>
        (subSessionId && String(s.id) === String(subSessionId)) ||
        (agentId && String(s.agentId) === String(agentId))
      );
      if (subIdx !== -1) {
        displayIndex = subIdx + 1;
      }
    }

    const agentName = matchedSub?.agentName
      || matchedSub?.name
      || params.agentName
      || tc.subAgentName
      || (agentId ? `Agent #${agentId}` : t('chat.message.subAgentIndex', { index: displayIndex }));

    const resolvedSubSessionId = subSessionId || matchedSub?.id || tc.subSessionId;
    const resolvedAgentId = agentId || matchedSub?.agentId;

    const key = String(resolvedSubSessionId || resolvedAgentId || tc.id || `tc-${idx}`);

    const existing = map.get(key);
    if (existing) {
      existing.status = tc.status || existing.status;
      if (tc.order !== undefined) existing.order = tc.order;
      if (resolvedSubSessionId && !existing.subSessionId) existing.subSessionId = resolvedSubSessionId;
      if (agentName && !existing.subAgentName) existing.subAgentName = agentName;
    } else {
      map.set(key, {
        ...tc,
        subSessionId: resolvedSubSessionId,
        subAgentId: resolvedAgentId,
        subAgentName: agentName,
        displayIndex,
        order: tc.order ?? idx
      });
    }
  });

  return Array.from(map.values()).sort((a, b) => (a.displayIndex ?? 0) - (b.displayIndex ?? 0));
}

/** 文本身份与正文归属已由状态投影确定，相同文案也可以是不同的分段边界。 */
export function selectIntermediateMessages(message: ChatMessage) {
  return message.aiMessages?.filter(item => !!item.text?.trim()) ?? [];
}

const CARD_ORDER_BASE = 1_000_000;

/** 组件与回归测试共用同一投影，卡片始终位于过程折叠区之外。 */
export function buildProcessTimeline(message: ChatMessage): ProcessTimelineItem[] {
  const intermediateMessages = selectIntermediateMessages(message);
  const tools = message.toolCalls ?? [];
  const items: ProcessTimelineItem[] = [];

  if (message.thoughtSteps?.length) {
    message.thoughtSteps.forEach((step, idx) => {
      items.push({
        id: step.id || `step-${idx}`,
        type: 'thought',
        order: step.order ?? Infinity,
        responseId: step.responseId,
        step
      });
    });
  }

  if (intermediateMessages.length) {
    intermediateMessages.forEach((im, idx) => {
      items.push({
        id: im.id || `im-${idx}`,
        type: 'intermediate_ai',
        order: im.order ?? Infinity,
        responseId: im.responseId,
        message: im
      });
    });
  }

  if (tools.length > 0) {
    tools.forEach((tc, idx) => {
      items.push({
        id: tc.id || `tool-${idx}`,
        type: 'tool',
        order: tc.order ?? Infinity,
        responseId: tc.responseId,
        tool: tc
      });
    });
  }

  if (message.promptCards?.length) {
    message.promptCards.forEach((card, idx) => {
      const trace = message.toolCalls?.find(tc => String(tc.id) === String(card.id));
      items.push({
        id: `card-${card.id ?? idx}`,
        type: 'prompt_card',
        order: trace?.order ?? (CARD_ORDER_BASE + idx),
        responseId: trace?.responseId,
        card
      });
    });
  }

  return items.sort((a, b) => {
    if (a.type === 'prompt_card' || b.type === 'prompt_card') {
      return a.type === b.type ? a.order - b.order : a.type === 'prompt_card' ? 1 : -1;
    }
    return compareResponsePosition(a, b);
  });
}
