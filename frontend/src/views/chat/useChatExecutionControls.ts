import { computed, onScopeDispose, ref, watch, type ComputedRef } from 'vue';
import { AgentAPI } from '../../services/agent';
import type { ChatAcceptance, ChatMessage, ChatSession } from '../../types/chat';
import type { ChatCommand } from '../../services/dto/chat_command';
import { isOk } from '../../utils/api';
import { t } from '../../i18n';
import { applyResendAcceptance } from './chatExecutionState';

interface Options {
  session: ComputedRef<ChatSession | null | undefined>;
  isSubmitting: ComputedRef<boolean>;
  ensureSubscribed: (sessionId: string) => Promise<boolean>;
  reconcile: (sessionId: string) => Promise<void>;
  buildCommand: (text: string) => ChatCommand;
  onResendAccepted: (session: ChatSession, receipt: ChatAcceptance) => void;
}

export function useChatExecutionControls(options: Options) {
  const error = ref('');
  const resumingSessionId = ref<string | null>(null);
  const resending = ref(false);
  const editTarget = ref<ChatMessage | null>(null);
  const editSessionId = ref<string | null>(null);
  const draft = ref('');
  let disposed = false;
  let controller: AbortController | undefined;
  const isResuming = computed(() => resumingSessionId.value === options.session.value?.id);
  const hasUnresolved = computed(() => options.session.value?.messages.some(message =>
    message.promptCards?.some(card => card.type === 'PROMISE' && card.status !== 'completed')) ?? false);
  const canResume = computed(() => options.session.value?.runStatus === 'SUSPENDED'
    && !hasUnresolved.value && !isResuming.value);
  const canResend = computed(() => options.session.value?.runStatus === 'IDLE'
    && !options.isSubmitting.value && !resending.value);

  watch(() => options.session.value?.id, () => {
    editTarget.value = null;
    editSessionId.value = null;
    error.value = '';
  });
  const report = (sessionId: string, problem: unknown) => {
    if (!disposed && options.session.value?.id === sessionId) {
      error.value = problem instanceof Error ? problem.message : t('chat.controls.failed');
    }
  };

  const resume = async () => {
    const session = options.session.value;
    if (!session || !canResume.value) return;
    resumingSessionId.value = session.id;
    error.value = '';
    try {
      if (!await options.ensureSubscribed(session.id)) throw new Error(t('chat.view.channelNotReady'));
      const result = await AgentAPI.resume(session.id);
      if (!isOk(result.code)) throw new Error(result.errMsg || t('chat.controls.resumeFailed'));
    } catch (problem) { report(session.id, problem); }
    finally {
      resumingSessionId.value = null;
      if (!disposed) await options.reconcile(session.id);
    }
  };

  const edit = (message: ChatMessage) => {
    if (!canResend.value || message.role !== 'user' || message.unsent || !message.serverMessageId || !message.turnId) return;
    editTarget.value = message;
    editSessionId.value = options.session.value!.id;
    draft.value = message.content;
    error.value = '';
  };
  const cancelEdit = () => { if (!resending.value) editTarget.value = null; };

  const resend = async () => {
    const session = options.session.value;
    const target = editTarget.value;
    if (!session || !target?.serverMessageId || editSessionId.value !== session.id || !canResend.value) return;
    if (!draft.value.trim()) { error.value = t('chat.controls.empty'); return; }
    const command = options.buildCommand(draft.value);
    command.sessionId = session.id;
    command.messageId = target.serverMessageId;
    command.imageUrl = target.imageUrls ? [...target.imageUrls] : target.imageUrl ? [target.imageUrl] : [];
    resending.value = true;
    error.value = '';
    controller = new AbortController();
    try {
      if (!await options.ensureSubscribed(session.id)) throw new Error(t('chat.view.channelNotReady'));
      if (disposed || options.session.value?.id !== session.id) return;
      const result = await AgentAPI.resendCommand(command, controller.signal);
      if (disposed) return;
      if (!isOk(result.code) || !result.data?.turnId) throw new Error(result.errMsg || t('chat.controls.resendFailed'));
      applyResendAcceptance(session, result.data);
      options.onResendAccepted(session, result.data);
      if (!disposed && options.session.value?.id === session.id) editTarget.value = null;
      await options.reconcile(session.id);
    } catch (problem) { report(session.id, problem); }
    finally { resending.value = false; controller = undefined; }
  };

  onScopeDispose(() => { disposed = true; controller?.abort(); });
  return { error, isResuming, resending, canResume, canResend, hasUnresolved,
    editTarget, draft, resume, edit, cancelEdit, resend };
}
