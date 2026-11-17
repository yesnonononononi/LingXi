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
        class="w-full rounded-2xl border text-sm backdrop-blur-md transition-colors duration-200"
        :class="isDark
          ? 'border-white/12 bg-zinc-950/95 text-zinc-100 shadow-[0_14px_40px_-12px_rgba(0,0,0,0.75)]'
          : 'border-zinc-200/90 bg-white/95 text-zinc-900 shadow-[0_8px_30px_-10px_rgba(0,0,0,0.08),0_1px_2px_rgba(0,0,0,0.04)]'"
        :aria-label="t('chat.cards.title')"
      >
        <div
          class="flex items-center justify-between gap-2 px-4 py-2"
          :class="expanded ? (isDark ? 'border-b border-white/10' : 'border-b border-zinc-100') : ''"
        >
          <button
            type="button"
            :aria-expanded="expanded"
            :aria-controls="contentId"
            class="flex min-w-0 flex-1 items-center gap-2 text-left text-xs transition cursor-pointer"
            :class="isDark ? 'text-zinc-300 hover:text-white' : 'text-zinc-600 hover:text-zinc-950'"
            data-testid="pending-interaction-dock-toggle"
            @click="expanded = !expanded"
          >
            <span class="h-1.5 w-1.5 shrink-0 rounded-full lx-live-dot" :class="isDark ? 'bg-white' : 'bg-zinc-900'" aria-hidden="true" />
            <span class="font-medium" :class="isDark ? 'text-zinc-100' : 'text-zinc-900'">{{ t('chat.cards.title') }}</span>
            <span
              class="rounded-full px-2 py-0.5 text-lx-fs-sm font-medium tabular-nums"
              :class="isDark ? 'bg-white/10 text-zinc-200' : 'bg-zinc-100 text-zinc-700'"
              role="status"
              data-testid="pending-interaction-dock-count"
            >
              {{ t('chat.cards.pending', { count: entries.length }) }}
            </span>
            <svg
              class="ml-auto h-3.5 w-3.5 shrink-0 transition-transform duration-200 opacity-60"
              :class="expanded ? 'rotate-180' : ''"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m18 15-6-6-6 6" />
            </svg>
          </button>
        </div>

        <!-- 折叠仅隐藏内容，不销毁作答中的草稿与提交态。 -->
        <div
          v-show="expanded"
          :id="contentId"
          class="max-h-[min(68vh,40rem)] divide-y overflow-y-auto overscroll-contain px-4 py-2.5 scrollbar-thin"
          :class="isDark ? 'divide-white/10' : 'divide-zinc-100'"
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
            docked
            class="py-1 first:pt-0 last:pb-0"
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
