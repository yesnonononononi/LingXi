import {computed, inject, ref} from 'vue';
import type {PromptCardData} from '../../types/chat';
import {PLAN_PREVIEW_KEY} from '../../types/previewPanel';
import {DECIDE_TOOL_CALL_KEY} from '../../types/toolDecision';
import {APPROVE_ACTION, normalizeOutcome, resolveApprovalState} from '../../utils/approvalOutcome';
import {canDecideCard} from '../../utils/toolCallCard';
import {type CardTone} from '../../utils/cardUi';
import {useI18n} from '../../i18n';

export interface InteractionCardBaseProps {
  promptCard: PromptCardData;
  sessionId?: string | number;
  isDark?: boolean;
  docked?: boolean;
}

/** 审批卡片共享状态与提交通道（供内置审批扩展包复用，避免重复实现决策逻辑）。 */
export function useApprovalCardModel(props: InteractionCardBaseProps) {
  const { t } = useI18n();
  const decideToolCall = inject(DECIDE_TOOL_CALL_KEY, null);
  const isSubmitting = ref(false);
  const submittingAction = ref<'approve' | 'reject' | null>(null);
  const errorMsg = ref('');

  const isFileWrite = computed(() => props.promptCard.kind === 'FILE_WRITE');
  const primaryText = computed(() => props.promptCard.command || props.promptCard.path || props.promptCard.content || '');
  const targetWorkDir = computed(() => props.promptCard.workDir || '');
  const targetIntention = computed(() => props.promptCard.intention || '');
  const typeLabel = computed(() => isFileWrite.value ? t('chat.approval.fileTypeLabel') : t('chat.approval.typeLabel'));
  const approvedLabel = computed(() => isFileWrite.value ? t('chat.approval.fileApproved') : t('chat.approval.approved'));
  const rejectedLabel = computed(() => isFileWrite.value ? t('chat.approval.fileRejected') : t('chat.approval.rejected'));

  const isPending = computed(() => canDecideCard(props.promptCard, APPROVE_ACTION));
  const isUnavailable = computed(() => props.promptCard.unavailable === true);
  const outcome = computed(() => normalizeOutcome(props.promptCard.outcome));
  const isResolved = computed(() => isUnavailable.value || !isPending.value);
  const resolvedStatus = computed(() => isUnavailable.value ? null : resolveApprovalState(outcome.value, isPending.value));

  const headerTone = computed<CardTone>(() => {
    if (!isResolved.value) return 'pending';
    if (resolvedStatus.value === 'approved') return 'approved';
    if (resolvedStatus.value === 'rejected') return 'rejected';
    return 'unknown';
  });

  const resolvedLabel = computed(() => {
    if (isUnavailable.value) return t('chat.approval.resolvedUnavailable');
    if (resolvedStatus.value === 'approved') return approvedLabel.value;
    if (resolvedStatus.value === 'rejected') return rejectedLabel.value;
    if (props.promptCard.status === 'preparing') return t('chat.approval.preparing');
    return props.promptCard.unavailableReason || t('chat.approval.statusUnknown');
  });

  const submit = async (approved: boolean) => {
    if (isSubmitting.value || isResolved.value) return;
    const conversationId = props.promptCard.conversationId
      ?? (props.sessionId != null && props.sessionId !== '' ? String(props.sessionId) : '');
    const toolCallId = props.promptCard.toolCallId;
    if (!conversationId || !toolCallId || !decideToolCall) {
      errorMsg.value = t('chat.approval.infoIncomplete');
      return;
    }
    isSubmitting.value = true;
    submittingAction.value = approved ? 'approve' : 'reject';
    errorMsg.value = '';
    try {
      await decideToolCall({
        conversationId: String(conversationId),
        toolCallId: String(toolCallId),
        action: approved ? 'APPROVE' : 'REJECT',
        expectedVersion: props.promptCard.version ?? null,
      });
    } catch (err: unknown) {
      errorMsg.value = (err instanceof Error ? err.message : '') || t('chat.approval.submitFailed');
    } finally {
      isSubmitting.value = false;
      submittingAction.value = null;
    }
  };

  return {
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
    headerTone,
    approve: () => submit(true),
    reject: () => submit(false),
  };
}

/** 计划卡片共享状态与提交通道（供内置计划扩展包复用）。 */
export function usePlanCardModel(props: InteractionCardBaseProps) {
  const { t } = useI18n();
  const decideToolCall = inject(DECIDE_TOOL_CALL_KEY, null);
  const openPlanPreview = inject(PLAN_PREVIEW_KEY, null);
  const isSubmitting = ref(false);
  const errorMsg = ref('');

  const isPending = computed(() => canDecideCard(props.promptCard, 'APPROVE'));
  const planTitle = computed(() => props.promptCard.title || t('chat.plan.defaultTitle'));
  const planContent = computed(() => props.promptCard.content || '');
  const planExcerpt = computed(() => {
    const raw = planContent.value;
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

  const openPreview = () => {
    openPlanPreview?.({
      id: String(props.promptCard.toolCallId || planTitle.value),
      title: planTitle.value,
      promptCard: props.promptCard,
      sessionId: props.sessionId,
    });
  };

  const decide = async (approved: boolean) => {
    if (isSubmitting.value || !isPending.value) return;
    const conversationId = props.promptCard.conversationId
      ?? (props.sessionId != null && props.sessionId !== '' ? String(props.sessionId) : '');
    if (!conversationId) { errorMsg.value = t('chat.plan.missingConversation'); return; }
    const toolCallId = props.promptCard.toolCallId;
    if (!toolCallId) { errorMsg.value = t('chat.plan.missingToolCallId'); return; }
    if (!decideToolCall) { errorMsg.value = t('chat.plan.noEventStream'); return; }

    isSubmitting.value = true;
    errorMsg.value = '';
    try {
      await decideToolCall({
        conversationId: String(conversationId),
        toolCallId: String(toolCallId),
        action: approved ? 'APPROVE' : 'REJECT',
        text: '',
        expectedVersion: props.promptCard.version ?? null,
      });
    } catch (err: unknown) {
      errorMsg.value = (err instanceof Error ? err.message : '') || (approved ? t('chat.plan.approveFailed') : t('chat.plan.rejectFailed'));
    } finally {
      isSubmitting.value = false;
    }
  };

  return {
    t,
    isSubmitting,
    errorMsg,
    isPending,
    planTitle,
    planContent,
    planExcerpt,
    statusTone,
    statusLabel,
    openPreview,
    approve: () => decide(true),
    reject: () => decide(false),
  };
}
