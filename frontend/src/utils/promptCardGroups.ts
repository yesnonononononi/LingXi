import type { PromptCardData } from '../types/chat';

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

/** 准备中仍需露出入口，放行执行后已无需用户处理。 */
export function isPendingCardEntry(entry: PromptCardEntry): boolean {
  return entry.card.status === 'preparing' || entry.card.status === 'pending';
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
