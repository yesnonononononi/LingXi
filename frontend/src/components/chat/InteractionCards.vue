<script setup lang="ts">
import { computed, ref, useId } from 'vue';
import type { ToolCallTrace } from '../../types/chat';
import { groupInteractionCards, type PromptCardEntry } from '../../utils/promptCardGroups';
import { t } from '../../i18n';
import InteractionCardGroup from './InteractionCardGroup.vue';

const props = defineProps<{ entries: PromptCardEntry[]; toolCalls?: ToolCallTrace[]; sessionId?: string | number; isDark?: boolean }>();
const expanded = ref(false);
const contentId = useId();
const categories = computed(() => groupInteractionCards(props.entries));
const pendingCount = computed(() => props.entries.filter(entry => entry.card.pending).length);
</script>

<template>
  <section v-if="entries.length" class="w-full min-w-0" data-testid="interaction-cards">
    <button type="button" :aria-expanded="expanded" :aria-controls="contentId"
      class="flex w-full min-w-0 items-center gap-2 py-1 text-left text-xs transition cursor-pointer"
      :class="isDark ? 'text-zinc-300 hover:text-zinc-100' : 'text-zinc-600 hover:text-zinc-900'"
      data-testid="interaction-cards-toggle" @click="expanded = !expanded">
      <svg class="h-3 w-3 shrink-0 transition-transform" :class="expanded ? 'rotate-90' : ''" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m9 5 7 7-7 7" /></svg>
      <span class="font-medium">{{ t('chat.cards.title') }}</span>
      <span class="shrink-0 tabular-nums">{{ t('chat.cards.count', { count: entries.length }) }}</span>
      <span v-if="pendingCount" class="ml-auto shrink-0 text-amber-600 dark:text-amber-400" role="status"
        data-testid="interaction-cards-pending">{{ t('chat.cards.pending', { count: pendingCount }) }}</span>
    </button>
    <!-- 折叠只隐藏内容，不能销毁正在作答的草稿或提交中的卡片。 -->
    <div v-show="expanded" :id="contentId" class="mt-1 space-y-2 border-l border-zinc-200 pl-3 dark:border-white/10"
      data-testid="interaction-cards-content">
      <InteractionCardGroup v-for="category in categories" :key="category.kind" :kind="category.kind"
        :entries="category.entries" :tool-calls="toolCalls" :session-id="sessionId" :is-dark="isDark" />
    </div>
  </section>
</template>
