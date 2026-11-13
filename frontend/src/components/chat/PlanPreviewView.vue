<script setup lang="ts">
import {computed, inject, ref} from 'vue';
import type {PlanPreviewTab} from '../../types/previewPanel';
import {DECIDE_TOOL_CALL_KEY} from '../../types/toolDecision';
import {type CardTone, cardToneClass, CARD_ERROR_TEXT_CLASS} from '../../utils/cardUi';
import {canDecideCard} from '../../utils/toolCallCard';
import MarkdownRenderer from './MarkdownRenderer.vue';
import {useI18n} from '../../i18n';

const props = defineProps<{
  tab: PlanPreviewTab;
  isDark?: boolean;
}>();

const emit = defineEmits<{
  (e: 'insertTip', text: string): void;
}>();

const { t } = useI18n();
const decideToolCall = inject(DECIDE_TOOL_CALL_KEY, null);

const tipText = ref('');
const isSubmitting = ref(false);
const errorMsg = ref('');

const isPending = computed(() => canDecideCard(props.tab.promptCard, 'APPROVE'));
const planBody = computed(() => props.tab.promptCard.content || '');
const planTitle = computed(() => props.tab.promptCard.title || props.tab.title || t('chat.plan.defaultTitle'));
const outcome = computed(() => String(props.tab.promptCard.outcome ?? '').trim().toUpperCase());

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
  if (props.tab.promptCard.status === 'preparing') return t('chat.plan.statusPreparing');
  if (props.tab.promptCard.status === 'in_progress') return t('chat.plan.statusInProgress');
  if (props.tab.promptCard.status === 'pending') return props.tab.promptCard.unavailableReason || t('chat.plan.statusSyncing');
  return t('chat.plan.statusUnknown');
});

const handleInsertTip = () => {
  const trimmed = tipText.value.trim();
  if (!trimmed) return;
  emit('insertTip', trimmed);
};

const decide = async (approved: boolean) => {
  if (isSubmitting.value || !isPending.value) return;

  const conversationId = props.tab.promptCard.conversationId
    ?? (props.tab.sessionId != null && props.tab.sessionId !== '' ? String(props.tab.sessionId) : '');
  if (!conversationId) {
    errorMsg.value = t('chat.plan.missingConversation');
    return;
  }

  const toolCallId = props.tab.promptCard.toolCallId;
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
      text: tipText.value.trim(),
      expectedVersion: props.tab.promptCard.version ?? null
    });
  } catch (err: unknown) {
    errorMsg.value = (err instanceof Error ? err.message : '') || (approved ? t('chat.plan.approveFailed') : t('chat.plan.rejectFailed'));
  } finally {
    isSubmitting.value = false;
  }
};
</script>

<template>
  <div class="plan-preview-view" :class="{ 'is-dark': isDark }">
    <header class="plan-preview-header">
      <div class="plan-preview-title-wrap">
        <span class="plan-preview-kicker">{{ t('chat.plan.implementPlanTab') }}</span>
        <h2 class="plan-preview-title">{{ planTitle }}</h2>
      </div>
      <span :class="['plan-status-pill', cardToneClass(statusTone, isDark)]">{{ statusLabel }}</span>
    </header>

    <div class="plan-preview-body" data-testid="plan-preview-content">
      <MarkdownRenderer v-if="planBody" :content="planBody" :is-dark="isDark" />
      <div v-else class="plan-empty">{{ t('filePreview.noContent') }}</div>
    </div>

    <footer class="plan-preview-footer">
      <div class="plan-tip-header">
        <span>{{ t('chat.plan.tipHeader') }}</span>
      </div>
      <div class="plan-tip-row">
        <textarea
          v-model="tipText"
          rows="2"
          :placeholder="t('chat.plan.tipPlaceholder')"
          class="plan-tip-input"
        ></textarea>
        <div class="plan-tip-actions">
          <button
            type="button"
            data-testid="plan-insert-tip"
            class="plan-btn-secondary"
            :disabled="!tipText.trim()"
            @click="handleInsertTip"
          >
            {{ t('chat.plan.insertTip') }}
          </button>
          <template v-if="isPending">
            <button
              type="button"
              class="plan-btn-danger"
              :disabled="isSubmitting"
              @click="decide(false)"
            >
              {{ t('chat.plan.rejectAction') }}
            </button>
            <button
              type="button"
              data-testid="plan-tab-execute"
              class="plan-btn-primary"
              :disabled="isSubmitting"
              @click="decide(true)"
            >
              {{ t('chat.plan.executeAction') }}
            </button>
          </template>
        </div>
      </div>
      <div v-if="errorMsg" :class="['text-xs mt-1.5', CARD_ERROR_TEXT_CLASS]">
        {{ errorMsg }}
      </div>
    </footer>
  </div>
</template>

<style scoped>
.plan-preview-view {
  display: flex;
  flex-direction: column;
  flex: 1 1 0%;
  min-height: 0;
  min-width: 0;
  background: var(--file-bg, #fff);
  color: inherit;
}
.plan-preview-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--file-line, #e4e4e7);
  flex-shrink: 0;
}
.plan-preview-title-wrap {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1;
}
.plan-preview-kicker {
  font-size: var(--lx-font-size-xs, 11px);
  color: var(--file-muted, #71717a);
  font-weight: 500;
}
.plan-preview-title {
  margin: 0;
  font-size: var(--lx-font-size-xl, 15px);
  font-weight: 600;
  line-height: 1.4;
  word-break: break-word;
}
.plan-status-pill {
  flex-shrink: 0;
  font-size: var(--lx-font-size-xs, 11px);
  font-weight: 500;
  padding: 3px 9px;
  border-radius: 9999px;
}
.plan-preview-body {
  flex: 1 1 0%;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px;
  font-size: var(--lx-font-size-md, 13px);
  line-height: 1.65;
}
.plan-empty {
  height: 100%;
  display: grid;
  place-items: center;
  color: var(--file-muted, #71717a);
  font-size: var(--lx-font-size-md, 13px);
}
.plan-preview-footer {
  flex-shrink: 0;
  padding: 12px 16px;
  border-top: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-bg, #fff);
}
.plan-tip-header {
  font-size: var(--lx-font-size-sm, 12px);
  font-weight: 500;
  color: var(--file-muted, #71717a);
  margin-bottom: 6px;
}
.plan-tip-row {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.plan-tip-input {
  width: 100%;
  resize: none;
  border-radius: 10px;
  border: 1px solid var(--file-line, #e4e4e7);
  background: var(--file-tab, #f4f4f5);
  color: inherit;
  padding: 8px 12px;
  font-size: var(--lx-font-size-md, 13px);
  outline: none;
  box-sizing: border-box;
}
.plan-tip-input:focus {
  border-color: #2563eb;
}
.plan-tip-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
.plan-btn-secondary,
.plan-btn-danger,
.plan-btn-primary {
  padding: 6px 14px;
  border-radius: 8px;
  font-size: var(--lx-font-size-md, 13px);
  font-weight: 500;
  cursor: pointer;
  transition: background-color 150ms ease, opacity 150ms ease;
}
.plan-btn-secondary {
  border: 1px solid var(--file-line, #e4e4e7);
  background: transparent;
  color: inherit;
}
.plan-btn-secondary:hover:not(:disabled) {
  background: var(--file-tab, #f4f4f5);
}
.plan-btn-danger {
  border: 1px solid rgba(220, 38, 38, 0.35);
  background: transparent;
  color: #dc2626;
}
.plan-btn-danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.08);
}
.plan-btn-primary {
  border: 0;
  background: #2563eb;
  color: #ffffff;
}
.plan-btn-primary:hover:not(:disabled) {
  background: #1d4ed8;
}
button:disabled {
  opacity: 0.45;
  cursor: default;
}
</style>
