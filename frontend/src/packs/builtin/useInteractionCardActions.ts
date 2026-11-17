import {computed, inject, nextTick, reactive, ref, watch} from 'vue';
import type {PromptCardData} from '../../types/chat';
import {PLAN_PREVIEW_KEY} from '../../types/previewPanel';
import {ANSWER_CHOICES_KEY, type ChoiceAnswersPayload, DECIDE_TOOL_CALL_KEY} from '../../types/toolDecision';
import {APPROVE_ACTION, normalizeOutcome, resolveApprovalState} from '../../utils/approvalOutcome';
import {nextUnansweredIndex, resolveActiveChoiceId} from '../../utils/choiceNavigation';
import {createLocalId} from '../../utils/ids';
import type {PromptCardEntry} from '../../utils/promptCardGroups';
import {buildCardSummary, canDecideCard} from '../../utils/toolCallCard';
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

export interface ChoiceGroupBaseProps {
  entries: PromptCardEntry[];
  responseId: string;
  expectedCount: number;
  isDark?: boolean;
  docked?: boolean;
}

/** 选择卡片组共享状态与批量提交通道（供内置选择扩展包复用，与默认 ChoiceQuestionGroup 保持同一套状态机）。 */
export function useChoiceGroupModel(props: ChoiceGroupBaseProps) {
  const { t } = useI18n();
  const answerChoices = inject(ANSWER_CHOICES_KEY, null);
  interface Draft { version?: string; selected: number | null; custom: string; useCustom: boolean }
  const drafts = reactive<Record<string, Draft>>({});
  const activeId = ref('');
  const userNavigated = ref(false);
  let lastSignature = '';
  const submitting = ref(false);
  const error = ref('');
  const retry = ref<{ signature: string; payload: ChoiceAnswersPayload } | null>(null);
  const expanded = ref(false);
  const customInput = ref<HTMLTextAreaElement | null>(null);

  function answer(entry: PromptCardEntry): string {
    const value = drafts[entry.card.toolCallId];
    if (!value) return '';
    return value.useCustom ? value.custom : value.selected === null ? '' : entry.card.options?.[value.selected] ?? '';
  }

  function isAnswered(entry: PromptCardEntry): boolean {
    return entry.card.status === 'completed' || answer(entry).trim().length > 0;
  }

  watch(() => props.entries, entries => {
    for (const { card } of entries) {
      if (!drafts[card.toolCallId] || drafts[card.toolCallId]!.version !== card.version) {
        drafts[card.toolCallId] = { version: card.version, selected: null, custom: '', useCustom: false };
      }
    }
    const signature = entries.map(entry => `${entry.card.toolCallId}:${entry.card.status === 'completed'}`).join(',');
    if (signature !== lastSignature) {
      lastSignature = signature;
      userNavigated.value = false;
    }
    activeId.value = resolveActiveChoiceId(
      entries.map(entry => ({
        id: entry.card.toolCallId,
        answered: isAnswered(entry),
        completed: entry.card.status === 'completed',
        editingCustom: Boolean(drafts[entry.card.toolCallId]?.useCustom),
      })),
      activeId.value,
      userNavigated.value,
    );
  }, { immediate: true, deep: true });

  const active = computed(() => props.entries.find(entry => entry.card.toolCallId === activeId.value)?.card);
  const draft = computed(() => drafts[activeId.value]);
  const activeIndex = computed(() => props.entries.findIndex(entry => entry.card.toolCallId === activeId.value));
  const pending = computed(() => props.entries.filter(entry => entry.card.status !== 'completed'));
  const total = computed(() => Math.max(props.expectedCount, props.entries.length));
  const ready = computed(() => props.entries.length === total.value && pending.value.every(entry =>
    canDecideCard(entry.card, 'ANSWER') && !!entry.card.version));
  const answered = computed(() => props.entries.filter(isAnswered).length);
  const answeredStates = computed(() => props.entries.map(isAnswered));
  const canSubmit = computed(() => ready.value && pending.value.length > 0 && answered.value === total.value && !submitting.value);
  const editable = computed(() => !!active.value && canDecideCard(active.value, 'ANSWER') && !submitting.value);
  const questionText = computed(() => active.value?.content || active.value?.title || t('chat.choice.groupTitle'));
  const normalizedQuestionText = computed(() =>
    !questionText.value.includes('\n') && questionText.value.includes('\\n')
      ? questionText.value.replace(/\\n/g, '\n')
      : questionText.value,
  );
  const closable = computed(() => props.entries.length === total.value && pending.value.length === 0);
  const summary = computed(() => props.entries.length === 1
    ? buildCardSummary(props.entries[0]!.card)
    : t('chat.choice.completedSummary', { count: props.entries.length }));

  watch(closable, () => { expanded.value = false; });

  function selectQuestion(index: number) {
    const next = props.entries[index];
    if (next) {
      userNavigated.value = true;
      activeId.value = next.card.toolCallId;
    }
  }

  function navigate(offset: number) {
    selectQuestion(activeIndex.value + offset);
  }

  function selectOption(index: number) {
    if (!draft.value || !editable.value) return;
    draft.value.selected = index;
    draft.value.useCustom = false;
    const target = nextUnansweredIndex(answeredStates.value, activeIndex.value);
    if (target > -1) activeId.value = props.entries[target]!.card.toolCallId;
  }

  function activateCustom() {
    if (!draft.value || !editable.value) return;
    draft.value.useCustom = true;
    draft.value.selected = null;
    void nextTick(() => customInput.value?.focus());
  }

  async function submit() {
    if (!canSubmit.value) return;
    if (!answerChoices) { error.value = t('chat.choice.noDecisionChannel'); return; }
    const conversationId = props.entries[0]?.card.conversationId;
    if (!conversationId) { error.value = t('chat.choice.missingConversation'); return; }
    const content = {
      conversationId,
      responseId: props.responseId,
      answers: pending.value.map(entry => ({
        toolCallId: entry.card.toolCallId,
        expectedVersion: entry.card.version!,
        text: answer(entry),
      })),
    };
    const signature = JSON.stringify(content);
    if (retry.value?.signature !== signature) {
      retry.value = { signature, payload: { ...content, commandId: createLocalId('choice') } };
    }
    submitting.value = true;
    error.value = '';
    try { await answerChoices(retry.value!.payload); }
    catch (failure) { error.value = failure instanceof Error ? failure.message : t('chat.choice.submitFailed'); }
    finally { submitting.value = false; }
  }

  return {
    t,
    activeId,
    active,
    draft,
    activeIndex,
    pending,
    total,
    ready,
    answered,
    answeredStates,
    canSubmit,
    editable,
    normalizedQuestionText,
    closable,
    summary,
    expanded,
    submitting,
    error,
    customInput,
    isAnswered,
    selectQuestion,
    navigate,
    selectOption,
    activateCustom,
    submit,
  };
}
