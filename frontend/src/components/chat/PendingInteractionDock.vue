<script setup lang="ts">
import {computed, ref, useId, watch} from 'vue';
import type {ToolCallTrace} from '../../types/chat';
import {groupInteractionCards, type PromptCardEntry} from '../../utils/promptCardGroups';
import {t} from '../../i18n';
import InteractionCardGroup from './InteractionCardGroup.vue';

const props = defineProps<{
  entries: PromptCardEntry[];
  toolCalls?: ToolCallTrace[];
  sessionId?: string | number;
  isDark?: boolean;
}>();

const expanded = ref(true);
const contentId = useId();
const categories = computed(() => groupInteractionCards(props.entries));

// 新待决卡片到达时自动展开，避免用户手动收起旧批次后错过新审批/提问。
watch(() => props.entries.map(entry => entry.id), (ids, previous) => {
  const previousIds: string[] = previous ?? [];
  if (ids.some(id => !previousIds.includes(id))) {
    expanded.value = true;
  }
}, { immediate: true });
</script>

<template>
  <Transition name="pending-interaction-dock">
    <div
      v-if="entries.length"
      class="pending-interaction-dock w-full max-w-lx-chat mx-auto px-4 mb-2"
      data-testid="pending-interaction-dock"
    >
      <section
        class="w-full rounded-2xl border px-3.5 py-2 text-sm backdrop-blur-md transition-colors duration-200"
        :class="isDark
          ? 'border-white/[0.09] bg-zinc-950/90 text-zinc-100 shadow-[0_10px_28px_-8px_rgba(0,0,0,0.65)]'
          : 'border-zinc-200/85 bg-white/95 text-zinc-800 shadow-[0_6px_22px_-6px_rgba(24,24,27,0.07),0_1px_2px_rgba(24,24,27,0.04)]'"
        :aria-label="t('chat.cards.title')"
      >
        <button
          type="button"
          :aria-expanded="expanded"
          :aria-controls="contentId"
          class="flex w-full min-w-0 items-center gap-2 py-1 text-left text-xs transition cursor-pointer"
          :class="isDark ? 'text-zinc-200 hover:text-white' : 'text-zinc-700 hover:text-zinc-950'"
          data-testid="pending-interaction-dock-toggle"
          @click="expanded = !expanded"
        >
          <svg
            class="h-3.5 w-3.5 shrink-0 transition-transform duration-200"
            :class="expanded ? 'rotate-180' : ''"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m18 15-6-6-6 6" />
          </svg>
          <span class="font-medium">{{ t('chat.cards.title') }}</span>
          <span
            class="ml-auto shrink-0 rounded-md px-2 py-0.5 text-xs font-medium"
            :class="isDark ? 'bg-amber-950/40 text-amber-300' : 'bg-amber-50 text-amber-700'"
            role="status"
            data-testid="pending-interaction-dock-count"
          >
            {{ t('chat.cards.pending', { count: entries.length }) }}
          </span>
        </button>

        <!-- 折叠仅隐藏内容，不销毁作答中的草稿与提交态。 -->
        <div
          v-show="expanded"
          :id="contentId"
          class="mt-1.5 max-h-[min(52vh,34rem)] space-y-2 overflow-y-auto overscroll-contain pr-0.5 scrollbar-thin"
          data-testid="pending-interaction-dock-content"
        >
          <InteractionCardGroup
            v-for="category in categories"
            :key="category.kind"
            :kind="category.kind"
            :entries="category.entries"
            :tool-calls="toolCalls"
            :session-id="sessionId"
            :is-dark="isDark"
          />
        </div>
      </section>
    </div>
  </Transition>
</template>

<style scoped>
.pending-interaction-dock-enter-active,
.pending-interaction-dock-leave-active {
  transition: opacity 200ms ease, transform 220ms cubic-bezier(0.16, 1, 0.3, 1);
}
.pending-interaction-dock-enter-from,
.pending-interaction-dock-leave-to {
  opacity: 0;
  transform: translateY(10px);
}
@media (prefers-reduced-motion: reduce) {
  .pending-interaction-dock-enter-active,
  .pending-interaction-dock-leave-active {
    transition: none;
  }
}
</style>
