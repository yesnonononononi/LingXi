<script setup lang="ts">
import type {PromptCardData} from '../../types/chat';
import {CARD_ERROR_TEXT_CLASS, cardDotClass} from '../../utils/cardUi';
import CardActionButton from '../../components/chat/CardActionButton.vue';
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
  typeLabel,
  isResolved,
  resolvedLabel,
  headerTone,
  approve,
  reject,
} = useApprovalCardModel(props);
</script>

<template>
  <div
    class="w-full font-mono text-xs transition-colors"
    :class="docked
      ? 'py-1'
      : ['rounded-xl border px-3 py-2.5 my-2', isDark ? 'bg-zinc-950 border-white/10 text-zinc-200' : 'bg-zinc-50/90 border-zinc-200 text-zinc-800']"
  >
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="cardDotClass(headerTone)" />
        <span class="shrink-0 uppercase tracking-wider text-lx-fs-sm opacity-60">{{ typeLabel }}</span>
        <span v-if="targetWorkDir" class="truncate text-lx-fs-sm opacity-50">@ {{ targetWorkDir }}</span>
      </div>
      <span v-if="isResolved" class="shrink-0 text-lx-fs-sm font-sans opacity-75">{{ resolvedLabel }}</span>
    </div>

    <div
      v-if="primaryText"
      class="mt-1.5 flex items-start gap-2 rounded-lg px-2.5 py-2 select-text break-all"
      :class="isDark ? 'bg-black/60 text-zinc-100' : 'bg-white border border-zinc-200/70 text-zinc-900'"
    >
      <span class="select-none opacity-45">{{ isFileWrite ? '>' : '$' }}</span>
      <span class="min-w-0 flex-1 leading-relaxed">{{ primaryText }}</span>
    </div>

    <div v-if="errorMsg" :class="['mt-1.5 font-sans text-xs', CARD_ERROR_TEXT_CLASS]">{{ errorMsg }}</div>

    <div v-if="!isResolved" class="mt-2 flex items-center justify-end gap-2 font-sans">
      <CardActionButton tone="danger" variant="outline" :loading="submittingAction === 'reject'" :disabled="isSubmitting" :is-dark="isDark" @click="reject">
        {{ t('chat.approval.rejectAction') }}
      </CardActionButton>
      <CardActionButton tone="neutral" :loading="submittingAction === 'approve'" :disabled="isSubmitting" :is-dark="isDark" @click="approve">
        {{ t('chat.approval.approveAction') }}
      </CardActionButton>
    </div>
  </div>
</template>
