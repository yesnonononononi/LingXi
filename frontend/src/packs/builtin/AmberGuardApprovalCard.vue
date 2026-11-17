<script setup lang="ts">
import type {PromptCardData} from '../../types/chat';
import {CARD_ERROR_TEXT_CLASS} from '../../utils/cardUi';
import {useApprovalCardModel} from './useInteractionCardActions';

const props = defineProps<{
  promptCard: PromptCardData;
  sessionId?: string | number;
  isDark?: boolean;
  docked?: boolean;
}>();

const {
  t,
  isSubmitting,
  submittingAction,
  errorMsg,
  isFileWrite,
  primaryText,
  targetWorkDir,
  targetIntention,
  typeLabel,
  isResolved,
  resolvedStatus,
  resolvedLabel,
  approve,
  reject,
} = useApprovalCardModel(props);
</script>

<template>
  <div
    class="relative w-full overflow-hidden rounded-2xl border transition-all"
    :class="[
      docked ? 'my-0.5' : 'my-2.5',
      isDark
        ? 'border-amber-500/40 bg-gradient-to-br from-amber-950/65 via-stone-950 to-zinc-950 text-amber-50 shadow-[0_8px_28px_-8px_rgba(245,158,11,0.28)]'
        : 'border-amber-300/90 bg-gradient-to-br from-amber-50 via-orange-50/75 to-white text-stone-900 shadow-[0_8px_24px_-6px_rgba(217,119,6,0.16)]'
    ]"
  >
    <!-- 顶部警戒斜纹条 -->
    <div
      class="h-1.5 w-full"
      style="background: repeating-linear-gradient(-45deg, #f59e0b, #f59e0b 8px, #d97706 8px, #d97706 16px);"
      aria-hidden="true"
    />

    <div class="p-3.5 space-y-2.5">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <span
            class="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-lx-fs-sm font-semibold tracking-wide"
            :class="isDark ? 'bg-amber-500/20 text-amber-300 border border-amber-400/30' : 'bg-amber-100 text-amber-800 border border-amber-300/80'"
          >
            <span class="h-1.5 w-1.5 rounded-full bg-amber-500 lx-live-dot" aria-hidden="true" />
            {{ typeLabel }}
          </span>
          <span v-if="targetWorkDir" class="truncate text-lx-fs-sm opacity-70 font-mono">{{ targetWorkDir }}</span>
        </div>
        <span
          v-if="isResolved"
          class="shrink-0 rounded-full px-2.5 py-0.5 text-lx-fs-sm font-medium"
          :class="resolvedStatus === 'approved'
            ? (isDark ? 'bg-emerald-500/20 text-emerald-300' : 'bg-emerald-100 text-emerald-800')
            : (isDark ? 'bg-red-500/20 text-red-300' : 'bg-red-100 text-red-800')"
        >
          {{ resolvedLabel }}
        </span>
      </div>

      <p v-if="targetIntention" class="text-xs leading-relaxed" :class="isDark ? 'text-amber-100/85' : 'text-stone-700'">
        {{ targetIntention }}
      </p>

      <div
        v-if="primaryText"
        class="rounded-xl border px-3 py-2.5 font-mono text-lx-fs-md break-all select-text flex items-start gap-2"
        :class="isDark ? 'bg-black/65 border-amber-500/30 text-amber-200' : 'bg-stone-900 border-stone-800 text-amber-300'"
      >
        <span class="select-none font-bold text-amber-500">{{ isFileWrite ? '✎' : '$' }}</span>
        <span class="min-w-0 flex-1 leading-relaxed">{{ primaryText }}</span>
      </div>

      <div v-if="errorMsg" :class="['text-xs font-medium', CARD_ERROR_TEXT_CLASS]">{{ errorMsg }}</div>

      <div v-if="!isResolved" class="pt-1 flex items-center justify-end gap-2">
        <button
          type="button"
          :disabled="isSubmitting"
          class="rounded-xl border px-3.5 py-1.5 text-xs font-medium transition cursor-pointer disabled:opacity-50"
          :class="isDark ? 'border-red-500/40 bg-red-950/30 text-red-300 hover:bg-red-900/50' : 'border-red-200 bg-white text-red-600 hover:bg-red-50'"
          @click="reject"
        >
          {{ submittingAction === 'reject' ? '...' : t('chat.approval.rejectAction') }}
        </button>
        <button
          type="button"
          :disabled="isSubmitting"
          class="rounded-xl px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition cursor-pointer disabled:opacity-50 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400"
          @click="approve"
        >
          {{ submittingAction === 'approve' ? '...' : t('chat.approval.approveAction') }}
        </button>
      </div>
    </div>
  </div>
</template>
