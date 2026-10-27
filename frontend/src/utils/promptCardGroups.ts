import type { PromptCardData } from '../types/chat';

export interface PromptCardEntry {
  id: string;
  card: PromptCardData;
  responseId?: string;
}

export type GroupedPromptCardEntry = PromptCardEntry & { approvals?: PromptCardEntry[]; choices?: PromptCardEntry[] };

/** 当前消息内按审批类型归组，保留每张卡片的权威身份。 */
export function groupApprovalCards(entries: PromptCardEntry[]): GroupedPromptCardEntry[] {
  const grouped: GroupedPromptCardEntry[] = [];
  const groups = new Map<string, GroupedPromptCardEntry>();
  for (const entry of entries) {
    const kind = entry.card.kind;
    if (kind !== 'COMMAND' && kind !== 'PLAN') {
      grouped.push(entry);
    } else {
      const existing = groups.get(kind);
      if (existing) existing.approvals!.push(entry);
      else {
        const group = { ...entry, approvals: [entry] };
        groups.set(kind, group);
        grouped.push(group);
      }
    }
  }
  return grouped;
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
