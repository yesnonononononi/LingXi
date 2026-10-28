import { onScopeDispose, ref, watch, type Ref } from 'vue';
import { ChecklistAPI } from '../../services/checklist';
import { isChecklistSnapshot, type ChecklistSnapshot } from '../../types/checklist';
import type { AgentEvent } from '../../types/Event';
import { AgentToolName } from '../../utils/toolNames';
import { isOk } from '../../utils/api';
import { t } from '../../i18n';

const checklistTools = new Set<string>([AgentToolName.CreateChecklist, AgentToolName.UpdateChecklistStep,
  AgentToolName.ModifyChecklist, AgentToolName.DeleteChecklist]);

/** 事件只触发回查，迟到的旧会话响应不得污染当前清单。 */
export function useChecklist(sessionId: Readonly<Ref<string | null>>, api = ChecklistAPI) {
  const snapshot = ref<ChecklistSnapshot | null>(null);
  const error = ref('');
  const loading = ref(false);
  let epoch = 0;
  let disposed = false;
  let dirty = false;
  let flight: Promise<void> | null = null;
  let controller: AbortController | undefined;
  let elapsed = 0;

  function refresh(): Promise<void> {
    if (disposed || !sessionId.value) return Promise.resolve();
    dirty = true;
    elapsed = 0;
    if (flight) return flight;
    const owner = sessionId.value;
    const revision = epoch;
    controller = new AbortController();
    const signal = controller.signal;
    loading.value = true;
    flight = Promise.resolve().then(async () => {
      try {
        do {
          dirty = false;
          const response = await api.current(owner, signal);
          if (disposed || revision !== epoch) return;
          if (!isOk(response.code) || (response.data !== null
              && (!isChecklistSnapshot(response.data) || response.data.sessionId !== owner))) {
            throw new Error(response.errMsg || t('chat.checklist.invalidData'));
          }
          if (dirty) continue;
          snapshot.value = response.data!;
          error.value = '';
        } while (dirty && revision === epoch && !disposed);
      } catch (cause) {
        if (revision === epoch && !disposed && !signal.aborted) {
          error.value = cause instanceof Error ? cause.message : t('chat.checklist.loadFailed');
        }
      } finally {
        if (revision === epoch) { loading.value = false; flight = null; }
      }
    });
    return flight;
  }

  function onEvent(event: AgentEvent) {
    const owner = 'sessionId' in event ? event.sessionId : event.metaData?.sessionId;
    if (!owner || owner !== sessionId.value) return;
    if ((event.type === 'TOOL_COMPLETED' && event.toolName && checklistTools.has(event.toolName))
        || ['EXECUTION_COMPLETED', 'EXECUTION_CANCELLED', 'EXECUTION_FAILED', 'EXECUTION_SUSPENDED'].includes(event.type)) {
      void refresh();
    }
  }

  watch(sessionId, () => {
    epoch += 1; controller?.abort(); flight = null; dirty = false;
    snapshot.value = null; error.value = ''; loading.value = false;
    void refresh();
  }, { immediate: true, flush: 'sync' });
  const timer = setInterval(() => {
    elapsed += 1;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (elapsed >= (snapshot.value?.status === 'ACTIVE' ? 5 : 15) && !flight) void refresh();
  }, 1000);
  onScopeDispose(() => { disposed = true; epoch += 1; controller?.abort(); clearInterval(timer); });
  return { sessionId, snapshot, error, loading, refresh, onEvent };
}
export type ChecklistState = ReturnType<typeof useChecklist>;
