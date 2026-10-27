import { computed, ref, watch, type ComputedRef } from 'vue';
import type { AgentEvent } from '../../types/Event';
import type { ChatSession } from '../../types/chat';
import type { NotifyOutcome } from '../../composables/useDesktopNotification';
import { canDecideCard, toPromptCardData } from '../../utils/toolCallCard';
import { resolveRootSessionId } from '../../utils/session';

interface Options {
  session: ComputedRef<ChatSession | null | undefined>;
  notify: (sessionId: string | number | null, kind: NotifyOutcome, title?: string | null, detail?: string) => Promise<boolean>;
}

/** 挂起也可能是在等子代理，只有真实可操作卡片才需要用户确认。 */
export function useChatOutcomeNotifications(options: Options) {
  const pendingConfirmation = ref<{ sessionId: string; turnId: string | null } | null>(null);
  const hasConfirmation = computed(() => {
    const target = pendingConfirmation.value;
    const session = options.session.value;
    if (!target || session?.id !== target.sessionId || session.runStatus !== 'SUSPENDED') return false;
    return session.messages.some(message => {
      if (target.turnId && message.turnId !== target.turnId) return false;
      return message.promptCards?.some(card => {
        const data = toPromptCardData(card);
        if (data.unavailable) return false;
        return data.kind === 'CHOICE' ? canDecideCard(data, 'ANSWER')
          : canDecideCard(data, 'APPROVE') || canDecideCard(data, 'REJECT');
      });
    });
  });

  // 卡片回查可能晚于挂起事件，跟随权威就绪位，不在事件到达时凭空推断确认需求。
  watch(hasConfirmation, ready => {
    if (!ready) return;
    const session = options.session.value!;
    pendingConfirmation.value = null;
    void options.notify(session.id, 'suspended', session.title);
  });

  watch(() => [options.session.value?.id, options.session.value?.runStatus], ([id, status]) => {
    if (id !== pendingConfirmation.value?.sessionId || status !== 'SUSPENDED') pendingConfirmation.value = null;
  });

  const onEvent = (event: AgentEvent) => {
    const session = options.session.value;
    if (!session) return;
    const ownerId = event.metaData?.sessionId;
    const rootId = String(resolveRootSessionId(session) ?? session.id);
    if (ownerId && String(ownerId) !== rootId) return;
    if (event.type === 'EXECUTION_SUSPENDED') {
      pendingConfirmation.value = {
        sessionId: session.id, turnId: event.metaData?.turnId ? String(event.metaData.turnId) : null,
      };
      return;
    }
    if (event.type === 'EXECUTION_STARTED' || event.type === 'EXECUTION_RESUME') {
      pendingConfirmation.value = null;
      return;
    }
    const kind = event.type === 'EXECUTION_COMPLETED' ? 'completed'
      : event.type === 'EXECUTION_FAILED' ? 'failed'
        : event.type === 'EXECUTION_CANCELLED' ? 'cancelled' : null;
    if (!kind) return;
    pendingConfirmation.value = null;
    void options.notify(session.id, kind, session.title, event.type === 'EXECUTION_FAILED' ? event.errMsg : undefined);
  };

  return { onEvent };
}
