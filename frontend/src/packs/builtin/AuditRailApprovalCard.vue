<script setup lang="ts">
import type {PromptCardData} from '../../types/chat';
import {CARD_ERROR_TEXT_CLASS, cardDotClass, cardToneClass} from '../../utils/cardUi';
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
  targetIntention,
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
    class="relative w-full overflow-hidden transition-colors"
    :class="docked
      ? 'pl-3.5 py-1'
      : ['rounded-2xl border my-2.5 pl-4 pr-4 py-3.5', isDark ? 'bg-zinc-950 border-white/10 text-zinc-100' : 'bg-white border-zinc-200/90 text-zinc-900']"
  >
    <span
      class="absolute left-0 top-2 bottom-2 w-1 rounded-full"
      :class="headerTone === 'approved' ? 'bg-emerald-500' : headerTone === 'rejected' ? 'bg-red-500' : (isDark ? 'bg-white/75' : 'bg-zinc-900')"
      aria-hidden="true"
    />

    <div class="flex items-center justify-between gap-2 text-xs">
      <div class="flex items-center gap-2 min-w-0">
        <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="cardDotClass(headerTone)" />
        <span class="font-semibold tracking-tight">{{ typeLabel }}</span>
      </div>
      <span v-if="targetWorkDir" class="truncate text-lx-fs-sm opacity-60">{{ targetWorkDir }}</span>
    </div>

    <p v-if="targetIntention" class="mt-2 text-xs leading-relaxed" :class="isDark ? 'text-zinc-300' : 'text-zinc-600'">
      {{ targetIntention }}
    </p>

    <div
      v-if="primaryText"
      class="mt-2 rounded-xl border px-3 py-2 font-mono text-lx-fs-md break-all select-text"
      :class="isDark ? 'bg-zinc-900/70 border-white/10 text-zinc-200' : 'bg-zinc-50 border-zinc-200/80 text-zinc-800'"
    >
      <span class="mr-2 select-none opacity-45">{{ isFileWrite ? 'FILE' : '$' }}</span>{{ primaryText }}
    </div>

    <div v-if="isResolved" :class="['mt-2.5 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium', cardToneClass(headerTone, isDark)]">
      {{ resolvedLabel }}
    </div>

    <div v-if="errorMsg" :class="['mt-2 text-xs', CARD_ERROR_TEXT_CLASS]">{{ errorMsg }}</div>

    <div v-if="!isResolved" class="mt-3 flex items-center justify-end gap-2">
      <CardActionButton tone="danger" variant="outline" :loading="submittingAction === 'reject'" :disabled="isSubmitting" :is-dark="isDark" @click="reject">
        {{ t('chat.approval.rejectAction') }}
      </CardActionButton>
      <CardActionButton tone="neutral" :loading="submittingAction === 'approve'" :disabled="isSubmitting" :is-dark="isDark" @click="approve">
        {{ t('chat.approval.approveAction') }}
      </CardActionButton>
    </div>
  </div>
</template>
