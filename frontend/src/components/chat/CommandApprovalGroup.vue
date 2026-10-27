<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import type { PromptCardEntry } from '../../utils/promptCardGroups';
import { cardDotClass, cardKindIconPath, resolveCardTone } from '../../utils/cardUi';
import { resolveCardStatusLabel } from '../../utils/toolCallCard';
import { t } from '../../i18n';
import PromptCard from './PromptCard.vue';

const props = defineProps<{ entries: PromptCardEntry[]; sessionId?: string | number; isDark?: boolean }>();
const listId = useId();
const list = ref<HTMLElement | null>(null);
const expanded = ref(false);
const expandedEntries = ref<Record<string, boolean>>({});
const pendingEntries = computed(() => props.entries.filter(entry => entry.card.pending));
const orderedEntries = computed(() => [
  ...pendingEntries.value,
  ...props.entries.filter(entry => !entry.card.pending)
]);

// 新的待审批必须露出入口；只滚动组内列表，不改变用户在聊天页的位置。
watch(() => pendingEntries.value.map(entry => entry.id), async (ids, previous = []) => {
  if (!ids.some(id => !previous.includes(id))) return;
  expanded.value = true;
  await nextTick();
  if (list.value) list.value.scrollTop = 0;
}, { immediate: true });
</script>

<template>
  <section class="w-full min-w-0" data-testid="command-approval-group">
    <button
      type="button"
      class="flex w-full min-w-0 items-center gap-2 rounded-lg px-1 py-2 text-left text-xs transition cursor-pointer"
      :class="isDark ? 'text-zinc-300 hover:bg-white/5' : 'text-gray-600 hover:bg-zinc-50'"
      :aria-expanded="expanded"
      :aria-controls="listId"
      data-testid="command-approval-toggle"
      @click="expanded = !expanded"
    >
      <svg class="h-3 w-3 shrink-0 transition-transform" :class="expanded ? 'rotate-90' : ''" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m9 5 7 7-7 7" /></svg>
      <svg class="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" :d="cardKindIconPath('COMMAND')" /></svg>
      <span class="font-medium">{{ t('chat.approval.groupTitle') }}</span>
      <span class="shrink-0 tabular-nums">{{ t('chat.approval.groupCount', { count: entries.length }) }}</span>
      <span v-if="pendingEntries.length" class="ml-auto shrink-0 rounded-md px-2 py-0.5" :class="isDark ? 'bg-amber-950/40 text-amber-300' : 'bg-amber-50 text-amber-700'" role="status">
        {{ t('chat.approval.groupPending', { count: pendingEntries.length }) }}
      </span>
    </button>
    <div
      v-show="expanded"
      :id="listId"
      ref="list"
      role="region"
      :aria-label="t('chat.approval.groupTitle')"
      tabindex="0"
      class="max-h-80 overflow-y-auto overscroll-contain rounded-xl border px-3 py-1"
      :class="isDark ? 'border-white/10 bg-zinc-950/20' : 'border-gray-200/80 bg-zinc-50/40'"
      data-testid="command-approval-list"
    >
      <div v-for="entry in orderedEntries" :key="entry.id" class="min-w-0" :data-approval-id="entry.card.toolCallId">
        <button
          type="button"
          class="flex w-full min-w-0 items-center gap-2 py-2 text-left text-xs text-lx-tertiary disabled:cursor-default cursor-pointer"
          :disabled="entry.card.pending"
          :aria-expanded="entry.card.pending || !!expandedEntries[entry.id]"
          :title="entry.card.command"
          data-testid="command-approval-entry-toggle"
          @click="expandedEntries[entry.id] = !expandedEntries[entry.id]"
        >
          <svg class="h-3 w-3 shrink-0 transition-transform" :class="entry.card.pending || expandedEntries[entry.id] ? 'rotate-90' : ''" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m9 5 7 7-7 7" /></svg>
          <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="cardDotClass(resolveCardTone(entry.card))"></span>
          <span class="min-w-0 flex-1 truncate">{{ entry.card.intention || entry.card.command || entry.card.title || t('chat.approval.typeLabel') }}</span>
          <span class="shrink-0 text-[11px]">{{ resolveCardStatusLabel(entry.card) }}</span>
        </button>
        <PromptCard
          v-if="entry.card.pending || expandedEntries[entry.id]"
          :prompt-card="entry.card"
          :session-id="sessionId"
          :is-dark="isDark"
        />
      </div>
    </div>
  </section>
</template>
