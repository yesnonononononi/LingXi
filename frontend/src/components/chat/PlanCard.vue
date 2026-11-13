<script setup lang="ts">
import {computed, inject, ref} from 'vue';
import type {PromptCardData} from '../../types/chat';
import {PLAN_PREVIEW_KEY} from '../../types/previewPanel';
import {DECIDE_TOOL_CALL_KEY} from '../../types/toolDecision';
import {
  CARD_ERROR_TEXT_CLASS,
  CARD_SHELL_CLASS,
  type CardTone,
  cardToneClass
} from '../../utils/cardUi';
import {canDecideCard} from '../../utils/toolCallCard';
import {useI18n} from '../../i18n';

const props = defineProps<{
  /** 统一卡片数据（PLAN 计划审批） */
  promptCard: PromptCardData;
  /** 卡片所属会话；审批接口据此定位生效计划书（缺省时回落到 promptCard.conversationId） */
  sessionId?: string | number;
  isDark?: boolean;
}>();

const { t } = useI18n();

const decideToolCall = inject(DECIDE_TOOL_CALL_KEY, null);
const openPlanPreview = inject(PLAN_PREVIEW_KEY, null);

const isSubmitting = ref(false);
const errorMsg = ref('');

const isPending = computed(() => canDecideCard(props.promptCard, 'APPROVE'));
const planTitle = computed(() => props.promptCard.title || t('chat.plan.defaultTitle'));
const planExcerpt = computed(() => {
  const raw = props.promptCard.content || '';
  if (!raw.trim()) return '';
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*`|_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
});
const outcome = computed(() => String(props.promptCard.outcome ?? '').trim().toUpperCase());

const statusTone = computed<CardTone>(() => {
  if (outcome.value === 'APPROVED') return 'approved';
  if (outcome.value === 'REJECTED') return 'rejected';
  if (isPending.value) return 'pending';
  return 'unknown';
});

const statusLabel = computed(() => {
  if (outcome.value === 'APPROVED') return t('chat.plan.statusApproved');
  if (outcome.value === 'REJECTED') return t('chat.plan.statusRejected');
  if (isPending.value) return t('chat.plan.statusPendingReview');
  if (props.promptCard.status === 'preparing') return t('chat.plan.statusPreparing');
  if (props.promptCard.status === 'in_progress') return t('chat.plan.statusInProgress');
  if (props.promptCard.status === 'pending') return props.promptCard.unavailableReason || t('chat.plan.statusSyncing');
  return t('chat.plan.statusUnknown');
});

const planTabId = computed(() => {
  return String(props.promptCard.toolCallId || planTitle.value);
});

const handleOpenPlan = () => {
  openPlanPreview?.({
    id: planTabId.value,
    title: planTitle.value,
    promptCard: props.promptCard,
    sessionId: props.sessionId
  });
};

/** 提交审批决定；后端负责恢复 loop */
const decide = async (approved: boolean) => {
  if (isSubmitting.value || !isPending.value) return;

  const conversationId = props.promptCard.conversationId
    ?? (props.sessionId != null && props.sessionId !== '' ? String(props.sessionId) : '');
  if (!conversationId) {
    errorMsg.value = t('chat.plan.missingConversation');
    return;
  }

  const toolCallId = props.promptCard.toolCallId;
  if (!toolCallId) {
    errorMsg.value = t('chat.plan.missingToolCallId');
    return;
  }
  if (!decideToolCall) {
    errorMsg.value = t('chat.plan.noEventStream');
    return;
  }

  isSubmitting.value = true;
  errorMsg.value = '';
  try {
    await decideToolCall({
      conversationId: String(conversationId),
      toolCallId: String(toolCallId),
      action: approved ? 'APPROVE' : 'REJECT',
      text: '',
      expectedVersion: props.promptCard.version ?? null
    });
  } catch (err: unknown) {
    errorMsg.value = (err instanceof Error ? err.message : '') || (approved ? t('chat.plan.approveFailed') : t('chat.plan.rejectFailed'));
  } finally {
    isSubmitting.value = false;
  }
};
</script>

<template>
  <div
    data-testid="plan-card"
    :class="[
      CARD_SHELL_CLASS,
      'w-full cursor-pointer transition-colors',
      isDark ? 'bg-[#161b26] border-zinc-800 hover:border-zinc-700' : 'bg-white border-zinc-200/90 hover:border-zinc-300'
    ]"
    @click="handleOpenPlan"
  >
    <div class="flex flex-col gap-2.5 p-4">
      <div class="flex flex-col gap-1 min-w-0">
        <span class="text-sm font-semibold truncate" :class="isDark ? 'text-zinc-100' : 'text-zinc-900'">
          {{ planTitle }}
        </span>
        <p
          v-if="planExcerpt"
          class="m-0 text-xs truncate"
          :class="isDark ? 'text-zinc-400' : 'text-zinc-500'"
        >
          {{ planExcerpt }}
        </p>
      </div>

      <div v-if="errorMsg" :class="['text-xs', CARD_ERROR_TEXT_CLASS]">
        {{ errorMsg }}
      </div>

      <button
        v-if="isPending"
        type="button"
        data-testid="plan-execute-button"
        :disabled="isSubmitting"
        class="self-start px-5 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-medium transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
        @click.stop="decide(true)"
      >
        {{ t('chat.plan.executeAction') }}
      </button>

      <div
        v-else
        :class="['self-start text-xs px-3 py-1.5 rounded-lg font-medium', cardToneClass(statusTone, isDark)]"
      >
        {{ statusLabel }}
      </div>
    </div>
  </div>
</template>
