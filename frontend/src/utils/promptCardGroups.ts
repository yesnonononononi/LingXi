import type { PromptCardData } from '../types/chat';

export interface PromptCardEntry {
  id: string;
  card: PromptCardData;
  responseId?: string;
}

export type GroupedPromptCardEntry = PromptCardEntry & { commands?: PromptCardEntry[]; choices?: PromptCardEntry[] };

/** 只合并当前消息的命令审批，其他卡片保留独立位置和权威身份。 */
export function groupCommandApprovals(entries: PromptCardEntry[]): GroupedPromptCardEntry[] {
  const grouped: GroupedPromptCardEntry[] = [];
  let commandGroup: GroupedPromptCardEntry | undefined;
  for (const entry of entries) {
    if (entry.card.kind !== 'COMMAND') {
      grouped.push(entry);
    } else if (commandGroup) {
      commandGroup.commands!.push(entry);
    } else {
      commandGroup = { ...entry, commands: [entry] };
      grouped.push(commandGroup);
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
