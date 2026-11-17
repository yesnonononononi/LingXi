import type {ChatMessage, PromptCardData, ToolCallTrace, ToolCallVO} from '../types/chat';
import {buildProcessTimeline} from './processTimeline';
import {toPromptCardData} from './toolCallCard';

export interface PromptCardEntry {
  id: string;
  card: PromptCardData;
  responseId?: string;
}

export type GroupedPromptCardEntry = PromptCardEntry & { choices?: PromptCardEntry[] };

export interface InteractionCardCategory {
  kind: PromptCardData['kind'];
  entries: PromptCardEntry[];
}

export interface DockedPendingInteractions {
  entries: PromptCardEntry[];
  toolCalls: ToolCallTrace[];
}

/** 准备中仍需露出入口，放行执行后已无需用户处理。 */
export function isPendingCardEntry(entry: PromptCardEntry): boolean {
  return entry.card.status === 'preparing' || entry.card.status === 'pending';
}

/**
 * 停靠到底部输入区上方的未决卡片判据：
 * 仅非 PLAN 的未决卡片（命令审批、文件改动审批、选择卡片）上浮到底部 Dock；
 * 计划审批与所有已决卡片仍留在消息流渲染区。
 */
export function isDockedPendingCardEntry(entry: PromptCardEntry): boolean {
  return entry.card.kind !== 'PLAN' && isPendingCardEntry(entry);
}

/** 从单条消息的过程时间线提取规范化的互动卡片条目（与消息区保持同一真源）。 */
export function extractMessageCardEntries(message: ChatMessage): PromptCardEntry[] {
  return buildProcessTimeline(message)
    .filter((item): item is typeof item & { card: ToolCallVO } => item.type === 'prompt_card' && !!item.card)
    .map(item => ({
      id: item.id,
      responseId: item.responseId ?? undefined,
      card: toPromptCardData(item.card),
    }));
}

/** 从会话消息列表汇总所有需在输入框上方展示的未决卡片及其关联 toolCalls。 */
export function collectDockedPendingInteractions(messages: readonly ChatMessage[]): DockedPendingInteractions {
  const entries: PromptCardEntry[] = [];
  const toolCalls: ToolCallTrace[] = [];
  for (const message of messages) {
    const docked = extractMessageCardEntries(message).filter(isDockedPendingCardEntry);
    if (!docked.length) continue;
    entries.push(...docked);
    if (message.toolCalls?.length) {
      toolCalls.push(...message.toolCalls);
    }
  }
  return { entries, toolCalls };
}

/** 只合并当前消息的同类卡片，提交身份仍由每张卡片与模型响应决定。 */
export function groupInteractionCards(entries: PromptCardEntry[]): InteractionCardCategory[] {
  const grouped: InteractionCardCategory[] = [];
  const groups = new Map<PromptCardData['kind'], InteractionCardCategory>();
  for (const entry of entries) {
    const kind = entry.card.kind;
    const existing = groups.get(kind);
    if (existing) existing.entries.push(entry);
    else {
      const group = { kind, entries: [entry] };
      groups.set(kind, group);
      grouped.push(group);
    }
  }
  return grouped.sort((first, second) => Number(second.entries.some(isPendingCardEntry))
    - Number(first.entries.some(isPendingCardEntry)));
}

/** 同一轮可能多次提问，选择组必须沿用后端模型响应身份。 */
export function groupChoiceQuestions(entries: GroupedPromptCardEntry[]): GroupedPromptCardEntry[] {
  const groups = new Map<string, GroupedPromptCardEntry>();
  const result: GroupedPromptCardEntry[] = [];
  for (const entry of entries) {
    if (entry.card.kind !== 'CHOICE' || !entry.responseId) {
      result.push(entry);
      continue;
    }
    const key = `choices:${entry.card.conversationId}:${entry.responseId}`;
    const existing = groups.get(key);
    if (existing) existing.choices!.push(entry);
    else {
      const group = { ...entry, id: key, choices: [entry] };
      groups.set(key, group);
      result.push(group);
    }
  }
  return result;
}
