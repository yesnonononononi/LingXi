<script setup lang="ts">
import type {PromptCardData} from '../../types/chat';
import {useChatInputFocus} from '../../composables/useChatInputFocus';
import {CARD_ERROR_TEXT_CLASS, cardDotClass, cardToneClass} from '../../utils/cardUi';
import CardActionButton from '../../components/chat/CardActionButton.vue';
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
  statusTone,
  statusLabel,
  openPreview,
  approve,
} = usePlanCardModel(props);
</script>

<template>
  <div
    data-testid="plan-card"
    class="w-full rounded-xl border px-3.5 py-2.5 my-2 cursor-pointer transition-colors"
    :class="isDark ? 'bg-zinc-950 border-white/10 hover:border-white/25 text-zinc-100' : 'bg-white border-zinc-200/90 hover:border-zinc-400 text-zinc-900'"
    @click="openPreview"
  >
    <div class="flex items-center justify-between gap-2">
      <div class="flex min-w-0 items-center gap-2">
        <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="cardDotClass(statusTone)" />
        <span class="truncate text-xs font-semibold">{{ planTitle }}</span>
      </div>
      <span :class="['shrink-0 rounded-md px-2 py-0.5 text-lx-fs-sm font-medium', cardToneClass(statusTone, isDark)]">
        {{ statusLabel }}
      </span>
    </div>

    <p v-if="planExcerpt" class="mt-1.5 line-clamp-2 text-xs leading-relaxed" :class="isDark ? 'text-zinc-400' : 'text-zinc-500'">
      {{ planExcerpt }}
    </p>

    <div v-if="errorMsg" :class="['mt-1.5 text-xs', CARD_ERROR_TEXT_CLASS]">{{ errorMsg }}</div>

    <div v-if="isPending" class="mt-2.5 flex items-center justify-end gap-2" @click.stop>
      <CardActionButton v-if="focusChatInput" tone="neutral" variant="outline" :disabled="isSubmitting" :is-dark="isDark" @click="focusChatInput">
        {{ t('chat.plan.discussInChat') }}
      </CardActionButton>
      <CardActionButton tone="neutral" :loading="isSubmitting" :disabled="isSubmitting" :is-dark="isDark" @click="approve">
        {{ t('chat.plan.approveAction') }}
      </CardActionButton>
    </div>
  </div>
</template>
