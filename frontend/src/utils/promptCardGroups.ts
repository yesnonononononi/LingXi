import type { PromptCardData } from '../types/chat';

export interface PromptCardEntry {
  id: string;
  card: PromptCardData;
}

export type GroupedPromptCardEntry = PromptCardEntry & { commands?: PromptCardEntry[] };

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
