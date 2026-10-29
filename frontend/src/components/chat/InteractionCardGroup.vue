<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue';
import type { GroupedPromptCardEntry, PromptCardEntry } from '../../utils/promptCardGroups';
import { groupChoiceQuestions, isPendingCardEntry } from '../../utils/promptCardGroups';
import type { PromptCardData, ToolCallTrace } from '../../types/chat';
import { cardDotClass, cardKindIconPath, resolveCardTone } from '../../utils/cardUi';
import { resolveCardStatusLabel } from '../../utils/toolCallCard';
import { t } from '../../i18n';
import PromptCard from './PromptCard.vue';
import ChoiceQuestionGroup from './ChoiceQuestionGroup.vue';
import { AgentToolName } from '../../utils/toolNames';

const props = defineProps<{ kind: PromptCardData['kind']; entries: PromptCardEntry[]; toolCalls?: ToolCallTrace[]; sessionId?: string | number; isDark?: boolean }>();
const GROUP_LABELS = {
  PLAN: { prefix: 'plan-approval', title: 'chat.plan.groupTitle' },
  COMMAND: { prefix: 'command-approval', title: 'chat.approval.groupTitle' },
  CHOICE: { prefix: 'choice-card', title: 'chat.choice.categoryTitle' },
  UNAVAILABLE: { prefix: 'unavailable-card', title: 'chat.cards.otherTitle' },
} as const;
const testPrefix = computed(() => GROUP_LABELS[props.kind].prefix);
const groupTitle = computed(() => t(GROUP_LABELS[props.kind].title));
const listId = useId();
const expanded = ref(false);
const expandedEntries = ref<Record<string, boolean>>({});
const pendingEntries = computed(() => props.entries.filter(isPendingCardEntry));
watch(() => pendingEntries.value.map(entry => entry.id), (ids, previous) => {
  if (ids.some(id => !previous?.includes(id))) expanded.value = true;
  else if (!ids.length) expanded.value = false;
}, { immediate: true });
// 先保留响应内题序再置顶待处理批次，否则已答题会被挪到末尾，题号与提交批次失去对应。
function isPendingEntry(entry: GroupedPromptCardEntry): boolean {
  return entry.choices?.some(isPendingCardEntry) ?? isPendingCardEntry(entry);
}
const orderedEntries = computed(() => groupChoiceQuestions(props.entries)
  .sort((first, second) => Number(isPendingEntry(second)) - Number(isPendingEntry(first))));
const expectedChoiceCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const call of props.toolCalls ?? []) {
    // 失败调用不会生成待答卡片，不能让同批正常问题永远等待它。
    if (call.toolName !== AgentToolName.RequireChoice || !call.responseId || call.status === 'failed') continue;
    counts.set(call.responseId, (counts.get(call.responseId) ?? 0) + 1);
  }
  return counts;
});
</script>

<template>
  <section class="w-full min-w-0" :data-testid="`${testPrefix}-group`">
    <button
      type="button"
      class="flex w-full min-w-0 items-center gap-2 rounded-lg px-1 py-2 text-left text-xs transition cursor-pointer"
      :class="isDark ? 'text-zinc-300 hover:bg-white/5' : 'text-zinc-600 hover:bg-zinc-50'"
      :aria-expanded="expanded"
      :aria-controls="listId"
      :data-testid="`${testPrefix}-toggle`"
      @click="expanded = !expanded"
    >
      <svg class="h-3 w-3 shrink-0 transition-transform" :class="expanded ? 'rotate-90' : ''" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m9 5 7 7-7 7" /></svg>
      <svg class="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" :d="cardKindIconPath(kind)" /></svg>
      <span class="font-medium">{{ groupTitle }}</span>
      <span class="shrink-0 tabular-nums">{{ t('chat.cards.count', { count: entries.length }) }}</span>
      <span v-if="pendingEntries.length" class="ml-auto shrink-0 rounded-md px-2 py-0.5" :class="isDark ? 'bg-amber-950/40 text-amber-300' : 'bg-amber-50 text-amber-700'" role="status">
        {{ t('chat.cards.pending', { count: pendingEntries.length }) }}
      </span>
    </button>
    <div
      v-show="expanded"
      :id="listId"
      role="region"
      :aria-label="groupTitle"
      tabindex="0"
      class="overflow-y-auto overscroll-contain rounded-xl border px-3 py-1"
      :class="[kind === 'CHOICE' ? 'max-h-[min(36rem,75vh)]' : 'max-h-80', isDark ? 'border-white/10 bg-zinc-950/20' : 'border-zinc-200/80 bg-zinc-50/40']"
      :data-testid="`${testPrefix}-list`"
    >
      <template v-for="entry in orderedEntries" :key="entry.id">
        <ChoiceQuestionGroup v-if="entry.choices" :entries="entry.choices" :response-id="entry.responseId!"
          :expected-count="expectedChoiceCounts.get(entry.responseId!) ?? 0" :is-dark="isDark" />
        <div v-else class="min-w-0" :data-approval-id="entry.card.toolCallId">
          <button
            type="button"
            class="flex w-full min-w-0 items-center gap-2 py-2 text-left text-xs text-lx-tertiary disabled:cursor-default cursor-pointer"
            :disabled="entry.card.pending"
            :aria-expanded="entry.card.pending || !!expandedEntries[entry.id]"
            :title="entry.card.title || entry.card.command"
            :data-testid="`${testPrefix}-entry-toggle`"
            @click="expandedEntries[entry.id] = !expandedEntries[entry.id]"
          >
            <svg class="h-3 w-3 shrink-0 transition-transform" :class="entry.card.pending || expandedEntries[entry.id] ? 'rotate-90' : ''" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m9 5 7 7-7 7" /></svg>
            <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="cardDotClass(resolveCardTone(entry.card))"></span>
            <span class="min-w-0 flex-1 truncate">{{ kind === 'COMMAND' ? (entry.card.intention || entry.card.command || entry.card.title || groupTitle) : (entry.card.title || entry.card.content || groupTitle) }}</span>
            <span class="shrink-0 text-[11px]">{{ resolveCardStatusLabel(entry.card) }}</span>
          </button>
          <PromptCard
            v-if="entry.card.pending || expandedEntries[entry.id]"
            :prompt-card="entry.card"
            :session-id="sessionId"
            :is-dark="isDark"
          />
        </div>
      </template>
    </div>
  </section>
</template>
