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
    class="relative w-full overflow-hidden rounded-2xl border backdrop-blur-md transition-all"
    :class="[
      docked ? 'my-0.5' : 'my-2.5',
      isDark
        ? 'border-cyan-400/40 bg-gradient-to-br from-indigo-950/75 via-slate-950/90 to-cyan-950/60 text-cyan-50 shadow-[0_0_26px_-6px_rgba(34,211,238,0.28)]'
        : 'border-indigo-300/80 bg-gradient-to-br from-indigo-50/95 via-cyan-50/80 to-violet-50/90 text-slate-900 shadow-[0_10px_28px_-8px_rgba(79,70,229,0.2)]'
    ]"
  >
    <!-- 极光霓虹顶栏光束 -->
    <div
      class="h-1 w-full bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500"
      aria-hidden="true"
    />

    <div class="p-3.5 space-y-2.5">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <span
            class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-lx-fs-sm font-semibold"
            :class="isDark ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-400/30' : 'bg-indigo-100/90 text-indigo-700 border border-indigo-200'"
          >
            <span class="h-1.5 w-1.5 rounded-full bg-cyan-400 lx-live-dot" aria-hidden="true" />
            {{ typeLabel }}
          </span>
          <span v-if="targetWorkDir" class="truncate text-lx-fs-sm font-mono opacity-65">{{ targetWorkDir }}</span>
        </div>
        <span
          v-if="isResolved"
          class="shrink-0 rounded-full px-2.5 py-0.5 text-lx-fs-sm font-medium"
          :class="resolvedStatus === 'approved'
            ? (isDark ? 'bg-cyan-500/20 text-cyan-300' : 'bg-emerald-100 text-emerald-700')
            : (isDark ? 'bg-fuchsia-500/20 text-fuchsia-300' : 'bg-rose-100 text-rose-700')"
        >
          {{ resolvedLabel }}
        </span>
      </div>

      <p v-if="targetIntention" class="text-xs leading-relaxed" :class="isDark ? 'text-slate-200' : 'text-slate-700'">
        {{ targetIntention }}
      </p>

      <div
        v-if="primaryText"
        class="rounded-xl border px-3 py-2.5 font-mono text-lx-fs-md break-all select-text flex items-start gap-2"
        :class="isDark ? 'bg-slate-950/80 border-cyan-500/25 text-cyan-200' : 'bg-white/85 border-indigo-200/80 text-indigo-950'"
      >
        <span class="select-none font-bold text-indigo-500 dark:text-cyan-400">{{ isFileWrite ? '::' : '❯' }}</span>
        <span class="min-w-0 flex-1 leading-relaxed">{{ primaryText }}</span>
      </div>

      <div v-if="errorMsg" :class="['text-xs font-medium', CARD_ERROR_TEXT_CLASS]">{{ errorMsg }}</div>

      <div v-if="!isResolved" class="pt-1 flex items-center justify-end gap-2">
        <button
          type="button"
          :disabled="isSubmitting"
          class="rounded-xl border px-3.5 py-1.5 text-xs font-medium transition cursor-pointer disabled:opacity-50"
          :class="isDark ? 'border-fuchsia-500/40 bg-fuchsia-950/25 text-fuchsia-300 hover:bg-fuchsia-900/40' : 'border-rose-200 bg-white/90 text-rose-600 hover:bg-rose-50'"
          @click="reject"
        >
          {{ submittingAction === 'reject' ? '...' : t('chat.approval.rejectAction') }}
        </button>
        <button
          type="button"
          :disabled="isSubmitting"
          class="rounded-xl px-4 py-1.5 text-xs font-semibold text-white shadow-sm transition cursor-pointer disabled:opacity-50 bg-gradient-to-r from-cyan-500 via-indigo-500 to-violet-500 hover:brightness-110"
          @click="approve"
        >
          {{ submittingAction === 'approve' ? '...' : t('chat.approval.approveAction') }}
        </button>
      </div>
    </div>
  </div>
</template>
