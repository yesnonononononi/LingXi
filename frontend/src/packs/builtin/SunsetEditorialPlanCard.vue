<script setup lang="ts">
import type {PromptCardData} from '../../types/chat';
import {useChatInputFocus} from '../../composables/useChatInputFocus';
import {CARD_ERROR_TEXT_CLASS} from '../../utils/cardUi';
import MarkdownRenderer from '../../components/chat/MarkdownRenderer.vue';
import {usePlanCardModel} from './useInteractionCardActions';

const props = defineProps<{
  promptCard: PromptCardData;
  sessionId?: string | number;
  isDark?: boolean;
}>();

const focusChatInput = useChatInputFocus();
const {
  t,
  isSubmitting,
  errorMsg,
  isPending,
  planTitle,
  planContent,
  statusLabel,
  openPreview,
  approve,
} = usePlanCardModel(props);
</script>

<template>
  <div
    data-testid="plan-card"
    class="relative w-full overflow-hidden rounded-2xl border my-2.5 cursor-pointer transition-all"
    :class="isDark
      ? 'border-rose-500/35 bg-gradient-to-br from-rose-950/60 via-zinc-950 to-amber-950/45 text-rose-50 hover:border-rose-400/60 shadow-[0_10px_28px_-8px_rgba(244,63,94,0.24)]'
      : 'border-rose-200/90 bg-gradient-to-br from-rose-50 via-amber-50/75 to-orange-50/70 text-stone-900 hover:border-rose-300 shadow-[0_8px_24px_-6px_rgba(244,63,94,0.14)]'"
    @click="openPreview"
  >
    <!-- 左侧暖珊瑚书签饰条 -->
    <span
      class="absolute left-0 top-0 bottom-0 w-1.5 bg-gradient-to-b from-rose-500 via-orange-400 to-amber-400"
      aria-hidden="true"
    />

    <div class="pl-5 pr-4 py-3 flex items-center justify-between gap-3 border-b" :class="isDark ? 'border-rose-500/20' : 'border-rose-200/60'">
      <span class="truncate text-sm font-semibold tracking-tight">{{ planTitle }}</span>
      <span
        class="shrink-0 rounded-full px-2.5 py-0.5 text-lx-fs-sm font-medium"
        :class="isDark ? 'bg-rose-500/20 text-rose-200 border border-rose-400/30' : 'bg-white/90 text-rose-700 border border-rose-200'"
      >
        {{ statusLabel }}
      </span>
    </div>

    <div
      v-if="planContent"
      class="scrollbar-thin max-h-60 overflow-y-auto pl-5 pr-4 py-3 text-xs leading-relaxed [&_.markdown-body>*:first-child]:mt-0 [&_.markdown-body>*:last-child]:mb-0"
      @click.stop
    >
      <MarkdownRenderer :content="planContent" :is-dark="isDark" :streaming="false" />
    </div>

    <div v-if="errorMsg" :class="['pl-5 pr-4 pb-2 text-xs font-medium', CARD_ERROR_TEXT_CLASS]">{{ errorMsg }}</div>

    <div
      v-if="isPending"
      class="flex items-center justify-between gap-2 border-t pl-5 pr-4 py-2.5"
      :class="isDark ? 'border-rose-500/20 bg-black/20' : 'border-rose-200/60 bg-white/50'"
      @click.stop
    >
      <button
        type="button"
        class="text-xs font-medium underline-offset-4 hover:underline cursor-pointer"
        :class="isDark ? 'text-rose-300 hover:text-rose-200' : 'text-rose-700 hover:text-rose-900'"
        @click="openPreview"
      >
        {{ t('chat.plan.previewAction') }}
      </button>
      <div class="flex items-center gap-2">
        <button
          v-if="focusChatInput"
          type="button"
          :disabled="isSubmitting"
          class="rounded-xl border px-3.5 py-1.5 text-xs font-medium transition cursor-pointer disabled:opacity-50"
          :class="isDark ? 'border-rose-500/35 bg-rose-950/40 text-rose-200 hover:bg-rose-900/50' : 'border-rose-200 bg-white text-rose-700 hover:bg-rose-50'"
          @click="focusChatInput"
        >
          {{ t('chat.plan.goToChat') }}
        </button>
        <button
          type="button"
          :disabled="isSubmitting"
          class="rounded-xl px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition cursor-pointer disabled:opacity-50 bg-gradient-to-r from-rose-500 to-amber-500 hover:from-rose-400 hover:to-amber-400"
          @click="approve"
        >
          {{ isSubmitting ? '...' : t('chat.plan.approveAction') }}
        </button>
      </div>
    </div>
  </div>
</template>
