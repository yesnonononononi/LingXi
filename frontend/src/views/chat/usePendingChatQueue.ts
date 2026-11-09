import {ref, shallowRef, watch, type Ref} from 'vue';
import {t} from '../../i18n';
import {AgentAPI} from '../../services/agent';
import type {PendingChatQueue} from '../../types/chat';
import type {Result} from '../../services/types';
import {isOk} from '../../utils/api';

export function usePendingChatQueue(sessionId: Readonly<Ref<string | null>>, isActive: () => boolean) {
  const snapshot = shallowRef<PendingChatQueue | null>(null);
  const error = ref('');
  const changing = ref(false);
  let revision = 0;

  async function refresh(owner = sessionId.value) {
    if (!owner || owner !== sessionId.value) return;
    const request = ++revision;
    try {
      const result = await AgentAPI.pendingCommands(owner);
      if (request !== revision || owner !== sessionId.value) return;
      if (isOk(result.code) && Array.isArray(result.data?.entries)) snapshot.value = result.data;
    } catch (cause) {
      if (request === revision && owner === sessionId.value) console.warn('读取待发送队列失败:', cause);
    }
  }

  watch(sessionId, (owner, _previous, onCleanup) => {
    snapshot.value = null;
    error.value = '';
    if (!owner) return;
    void refresh(owner);
    const timer = setInterval(() => {
      if ((snapshot.value?.entries.length || isActive()) && !changing.value) void refresh(owner);
    }, 1000);
    onCleanup(() => {
      revision++;
      clearInterval(timer);
    });
  }, {immediate: true});

  async function change(action: (owner: string) => Promise<Result<void>>) {
    const owner = sessionId.value;
    if (!owner || changing.value) return;
    changing.value = true;
    error.value = '';
    try {
      const result = await action(owner);
      if (!isOk(result.code)) throw new Error(result.errMsg || t('chat.pending.operationFailed'));
    } catch (cause) {
      if (owner === sessionId.value) {
        error.value = cause instanceof Error ? cause.message : t('chat.pending.operationFailed');
      }
    } finally {
      await refresh(owner);
      changing.value = false;
    }
  }

  return {
    snapshot, error, changing, refresh,
    cancel: (id: string) => change(owner => AgentAPI.cancelPendingCommand(owner, id)),
    resume: () => change(owner => AgentAPI.resumePendingCommands(owner)),
  };
}
