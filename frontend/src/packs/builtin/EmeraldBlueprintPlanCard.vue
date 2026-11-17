<script setup lang="ts">
import type {PromptCardData} from '../../types/chat';
import {useChatInputFocus} from '../../composables/useChatInputFocus';
import {CARD_ERROR_TEXT_CLASS} from '../../utils/cardUi';
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
  planExcerpt,
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
      ? 'border-emerald-500/40 bg-emerald-950/55 text-emerald-50 hover:border-emerald-400/70 shadow-[0_10px_28px_-8px_rgba(16,185,129,0.25)]'
      : 'border-emerald-300/90 bg-emerald-50/85 text-emerald-950 hover:border-emerald-400 shadow-[0_8px_22px_-6px_rgba(16,185,129,0.16)]'"
    :style="{
      backgroundImage: isDark
        ? 'linear-gradient(to right, rgba(16,185,129,0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(16,185,129,0.08) 1px, transparent 1px)'
        : 'linear-gradient(to right, rgba(16,185,129,0.10) 1px, transparent 1px), linear-gradient(to bottom, rgba(16,185,129,0.10) 1px, transparent 1px)',
      backgroundSize: '18px 18px',
    }"
    @click="openPreview"
  >
    <div class="p-4 space-y-2.5">
      <div class="flex items-center justify-between gap-2">
        <div class="flex min-w-0 items-center gap-2">
          <span
            class="rounded-md px-2 py-0.5 font-mono text-lx-fs-sm font-bold tracking-wider"
            :class="isDark ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-400/30' : 'bg-emerald-600 text-white'"
          >
            BLUEPRINT
          </span>
          <span class="truncate text-sm font-semibold">{{ planTitle }}</span>
        </div>
        <span
          class="shrink-0 rounded-full px-2.5 py-0.5 text-lx-fs-sm font-medium"
          :class="isDark ? 'bg-emerald-900/60 text-emerald-200 border border-emerald-500/30' : 'bg-white/90 text-emerald-800 border border-emerald-200'"
        >
          {{ statusLabel }}
        </span>
      </div>

      <p v-if="planExcerpt" class="line-clamp-2 text-xs leading-relaxed" :class="isDark ? 'text-emerald-100/80' : 'text-emerald-900/75'">
        {{ planExcerpt }}
      </p>

      <div v-if="errorMsg" :class="['text-xs font-medium', CARD_ERROR_TEXT_CLASS]">{{ errorMsg }}</div>

      <div v-if="isPending" class="pt-1 flex items-center justify-end gap-2" @click.stop>
        <button
          v-if="focusChatInput"
          type="button"
          :disabled="isSubmitting"
          class="rounded-xl border px-3.5 py-1.5 text-xs font-medium transition cursor-pointer disabled:opacity-50"
          :class="isDark ? 'border-emerald-500/40 bg-emerald-950/60 text-emerald-200 hover:bg-emerald-900/60' : 'border-emerald-300 bg-white/90 text-emerald-800 hover:bg-emerald-100/60'"
          @click="focusChatInput"
        >
          {{ t('chat.plan.discussInChat') }}
        </button>
        <button
          type="button"
          :disabled="isSubmitting"
          class="rounded-xl px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition cursor-pointer disabled:opacity-50 bg-emerald-600 hover:bg-emerald-500"
          @click="approve"
        >
          {{ isSubmitting ? '...' : t('chat.plan.approveAction') }}
        </button>
      </div>
    </div>
  </div>
</template>
