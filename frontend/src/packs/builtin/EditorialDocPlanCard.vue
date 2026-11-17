<script setup lang="ts">
import type {PromptCardData} from '../../types/chat';
import {injectChatInputFocus} from '../../types/chatInputFocus';
import {CARD_ERROR_TEXT_CLASS, cardToneClass} from '../../utils/cardUi';
import CardActionButton from '../../components/chat/CardActionButton.vue';
import MarkdownRenderer from '../../components/chat/MarkdownRenderer.vue';
import {usePlanCardModel} from './useInteractionCardActions';

const props = defineProps<{
  promptCard: PromptCardData;
  sessionId?: string | number;
  isDark?: boolean;
}>();

const focusChatInput = injectChatInputFocus();
const {
  t,
  isSubmitting,
  errorMsg,
  isPending,
  planTitle,
  planContent,
  statusTone,
  statusLabel,
  openPreview,
  approve,
} = usePlanCardModel(props);
</script>

<template>
  <div
    data-testid="plan-card"
    class="w-full rounded-2xl border my-2.5 overflow-hidden transition-colors cursor-pointer"
    :class="isDark ? 'bg-zinc-950 border-white/12 hover:border-white/25 text-zinc-100' : 'bg-white border-zinc-200/90 hover:border-zinc-400 text-zinc-900'"
    @click="openPreview"
  >
    <div class="border-b px-4 py-3 flex items-center justify-between gap-3" :class="isDark ? 'border-white/10' : 'border-zinc-100'">
      <div class="min-w-0 flex items-center gap-2.5">
        <span class="h-4 w-0.5 shrink-0 rounded-full" :class="isDark ? 'bg-white/80' : 'bg-zinc-900'" aria-hidden="true" />
        <span class="truncate text-sm font-semibold tracking-tight">{{ planTitle }}</span>
      </div>
      <span :class="['shrink-0 rounded-full px-2.5 py-0.5 text-lx-fs-sm font-medium', cardToneClass(statusTone, isDark)]">
        {{ statusLabel }}
      </span>
    </div>

    <div
      v-if="planContent"
      class="scrollbar-thin max-h-60 overflow-y-auto px-4 py-3 text-xs leading-relaxed [&_.markdown-body>*:first-child]:mt-0 [&_.markdown-body>*:last-child]:mb-0"
      @click.stop
    >
      <MarkdownRenderer :content="planContent" :is-dark="isDark" :streaming="false" />
    </div>

    <div v-if="errorMsg" :class="['px-4 pb-2 text-xs', CARD_ERROR_TEXT_CLASS]">{{ errorMsg }}</div>

    <div
      v-if="isPending"
      class="flex items-center justify-between gap-2 border-t px-4 py-2.5"
      :class="isDark ? 'border-white/10 bg-white/[0.02]' : 'border-zinc-100 bg-zinc-50/60'"
      @click.stop
    >
      <button
        type="button"
        class="text-xs underline-offset-4 hover:underline cursor-pointer"
        :class="isDark ? 'text-zinc-400 hover:text-zinc-200' : 'text-zinc-500 hover:text-zinc-800'"
        @click="openPreview"
      >
        {{ t('chat.plan.openDetail') }}
      </button>
      <div class="flex items-center gap-2">
        <CardActionButton v-if="focusChatInput" tone="neutral" variant="outline" :disabled="isSubmitting" :is-dark="isDark" @click="focusChatInput">
          {{ t('chat.plan.discussInChat') }}
        </CardActionButton>
        <CardActionButton tone="neutral" :loading="isSubmitting" :disabled="isSubmitting" :is-dark="isDark" @click="approve">
          {{ t('chat.plan.approveAction') }}
        </CardActionButton>
      </div>
    </div>
  </div>
</template>
