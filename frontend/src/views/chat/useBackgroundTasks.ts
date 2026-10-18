import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { BackgroundTaskAPI } from '../../services/backgroundTask';
import { isBackgroundTask, isTaskActive, type BackgroundTask, type BackgroundTaskChanged } from '../../types/backgroundTask';
import { isOk } from '../../utils/api';
import { t } from '../../i18n';

type TaskAPI = typeof BackgroundTaskAPI;

/** 事件只触发回查；切换会话、请求乱序和断线都不能在界面制造执行状态。 */
export function useBackgroundTasks(sessionId: Readonly<Ref<string | null>>, api: TaskAPI = BackgroundTaskAPI) {
  const tasks = ref<BackgroundTask[]>([]);
  const error = ref('');
  const loading = ref(false);
  const now = ref(Date.now());
  const selectedId = ref<string | null>(null);
  const detail = ref<BackgroundTask | null>(null);
  const detailError = ref('');
  const reading = ref(false);
  const stoppingId = ref<string | null>(null);
  const stopError = ref('');
  let epoch = 0;
  let disposed = false;
  let flight: Promise<void> | null = null;
  let dirty = false;
  let listController: AbortController | undefined;
  let detailController: AbortController | undefined;
  let stopController: AbortController | undefined;
  let detailRevision = 0;
  let ticks = 0;
  const message = (cause: unknown) => cause instanceof Error ? cause.message : t('chat.backgroundTasks.loadFailed');

  function refresh(): Promise<void> {
    if (disposed || !sessionId.value) return Promise.resolve();
    dirty = true;
    if (flight) return flight;
    const currentEpoch = epoch;
    const owner = sessionId.value;
    listController = new AbortController();
    const signal = listController.signal;
    loading.value = true;
    flight = Promise.resolve().then(async () => {
      try {
        do {
          dirty = false;
          const response = await api.list(owner, signal);
          if (disposed || currentEpoch !== epoch) return;
          if (!isOk(response.code) || !Array.isArray(response.data)
              || !response.data.every(task => isBackgroundTask(task) && task.sessionId === owner)) {
            throw new Error(response.errMsg || t('chat.backgroundTasks.invalidData'));
          }
          if (dirty) continue;
          tasks.value = response.data;
          error.value = '';
        } while (dirty && !disposed && currentEpoch === epoch);
      } catch (cause) {
        if (!disposed && currentEpoch === epoch && !signal.aborted) error.value = message(cause);
      } finally {
        if (currentEpoch === epoch) { loading.value = false; flight = null; }
      }
    });
    return flight;
  }

  function closeOutput() {
    detailRevision += 1;
    detailController?.abort();
    selectedId.value = null;
    detail.value = null;
    detailError.value = '';
    reading.value = false;
  }

  async function read(taskId: string) {
    if (disposed || !sessionId.value) return;
    detailController?.abort();
    detailController = new AbortController();
    const signal = detailController.signal;
    const revision = ++detailRevision;
    const currentEpoch = epoch;
    const owner = sessionId.value;
    selectedId.value = taskId;
    if (detail.value?.id !== taskId) detail.value = null;
    reading.value = true;
    detailError.value = '';
    try {
      const response = await api.read(owner, taskId, signal);
      if (disposed || currentEpoch !== epoch || revision !== detailRevision) return;
      if (!isOk(response.code) || !isBackgroundTask(response.data)
          || response.data.sessionId !== owner || response.data.id !== taskId) {
        throw new Error(response.errMsg || t('chat.backgroundTasks.invalidData'));
      }
      detail.value = response.data;
    } catch (cause) {
      if (!disposed && currentEpoch === epoch && revision === detailRevision && !signal.aborted) detailError.value = message(cause);
    } finally {
      if (currentEpoch === epoch && revision === detailRevision) reading.value = false;
    }
  }

  async function stop(taskId: string) {
    if (disposed || !sessionId.value || stoppingId.value) return;
    const currentEpoch = epoch;
    const owner = sessionId.value;
    stopController = new AbortController();
    const signal = stopController.signal;
    stoppingId.value = taskId;
    stopError.value = '';
    try {
      const response = await api.stop(owner, taskId, signal);
      if (disposed || currentEpoch !== epoch) return;
      if (!isOk(response.code) || !isBackgroundTask(response.data)
          || response.data.id !== taskId || response.data.sessionId !== owner) {
        throw new Error(response.errMsg || t('chat.backgroundTasks.invalidData'));
      }
      // 停止按钮的回执也是服务端事实，不能在请求发出时先标成已停止。
      tasks.value = tasks.value.map(task => task.id === taskId ? response.data! : task);
      if (selectedId.value === taskId) detail.value = response.data;
      await refresh();
    } catch (cause) {
      if (!disposed && currentEpoch === epoch && !signal.aborted) stopError.value = message(cause);
    } finally { if (currentEpoch === epoch) stoppingId.value = null; }
  }

  function onTaskChanged(event: BackgroundTaskChanged) {
    if (event.sessionId !== sessionId.value) return;
    void refresh();
    if (selectedId.value === event.taskId) void read(event.taskId);
  }

  watch(sessionId, () => {
    epoch += 1;
    listController?.abort(); stopController?.abort(); closeOutput();
    flight = null; dirty = false; tasks.value = [];
    error.value = ''; stopError.value = ''; stoppingId.value = null; loading.value = false;
    void refresh();
  }, { immediate: true, flush: 'sync' });

  const timer = setInterval(() => {
    now.value = Date.now();
    if (++ticks % 5 !== 0 || (typeof document !== 'undefined' && document.hidden)) return;
    if (!flight) void refresh();
    if (selectedId.value && tasks.value.some(task => task.id === selectedId.value && isTaskActive(task))) {
      void read(selectedId.value);
    }
  }, 1000);
  onScopeDispose(() => {
    disposed = true; epoch += 1;
    clearInterval(timer);
    listController?.abort(); detailController?.abort(); stopController?.abort();
  });

  return { sessionId, tasks, error, loading, now, selectedId, detail, detailError, reading, stoppingId, stopError,
    runningCount: computed(() => tasks.value.filter(task => task.status === 'RUNNING').length),
    pendingCount: computed(() => tasks.value.filter(task => task.status === 'PENDING').length),
    refresh, read, closeOutput, stop, onTaskChanged };
}
export type BackgroundTasksState = ReturnType<typeof useBackgroundTasks>;
