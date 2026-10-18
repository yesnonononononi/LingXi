import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { BackgroundTaskAPI } from '../../services/backgroundTask';
import { isBackgroundTask, isTaskActive, type BackgroundTask, type BackgroundTaskChanged } from '../../types/backgroundTask';
import { isOk } from '../../utils/api';
import { t } from '../../i18n';

type TaskAPI = typeof BackgroundTaskAPI;

/** 有活跃任务时的兜底回查间隔：主路径是 SSE 的 backgroundTaskChanged。 */
const ACTIVE_POLL_SECONDS = 5;
/** 空闲时的兜底间隔：一条任务都没有就不值得 5 秒一次，留个慢速兜底防漏事件。 */
const IDLE_POLL_SECONDS = 15;

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
  const deletingId = ref<string | null>(null);
  const deleteError = ref('');
  let epoch = 0;
  let disposed = false;
  let flight: Promise<void> | null = null;
  let dirty = false;
  let listController: AbortController | undefined;
  let detailController: AbortController | undefined;
  let stopController: AbortController | undefined;
  let deleteController: AbortController | undefined;
  let detailRevision = 0;
  let sincePoll = 0;
  const message = (cause: unknown) => cause instanceof Error ? cause.message : t('chat.backgroundTasks.loadFailed');

  function refresh(): Promise<void> {
    if (disposed || !sessionId.value) return Promise.resolve();
    // 任何一次真实回查（轮询兜底 / 事件 / 切会话 / 停止后）都重新起算间隔，
    // 避免事件刚拉过一轮、下一个 tick 又按旧计数补一枪。
    sincePoll = 0;
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

  /** 删掉一条已结束的记录；行从界面消失以服务端回执为准，失败就保留原行。 */
  async function removeTask(taskId: string) {
    if (disposed || !sessionId.value || deletingId.value) return;
    const currentEpoch = epoch;
    const owner = sessionId.value;
    deleteController = new AbortController();
    const signal = deleteController.signal;
    deletingId.value = taskId;
    deleteError.value = '';
    try {
      const response = await api.remove(owner, taskId, signal);
      if (disposed || currentEpoch !== epoch) return;
      if (!isOk(response.code)) throw new Error(response.errMsg || t('chat.backgroundTasks.deleteFailed'));
      tasks.value = tasks.value.filter(task => task.id !== taskId);
      if (selectedId.value === taskId) closeOutput();
    } catch (cause) {
      if (!disposed && currentEpoch === epoch && !signal.aborted) {
        deleteError.value = cause instanceof Error ? cause.message : t('chat.backgroundTasks.deleteFailed');
      }
    } finally { if (currentEpoch === epoch) deletingId.value = null; }
  }

  function onTaskChanged(event: BackgroundTaskChanged) {
    if (event.sessionId !== sessionId.value) return;
    void refresh();
    if (selectedId.value === event.taskId) void read(event.taskId);
  }

  watch(sessionId, () => {
    epoch += 1;
    listController?.abort(); stopController?.abort(); deleteController?.abort(); closeOutput();
    flight = null; dirty = false; tasks.value = [];
    error.value = ''; stopError.value = ''; stoppingId.value = null; loading.value = false;
    deleteError.value = ''; deletingId.value = null;
    void refresh();
  }, { immediate: true, flush: 'sync' });

  const timer = setInterval(() => {
    now.value = Date.now();
    sincePoll += 1;
    // 隐藏页不发请求，但计数照走：切回前台时立刻补一次，而不是再等一整个间隔。
    if (typeof document !== 'undefined' && document.hidden) return;
    const interval = tasks.value.some(task => isTaskActive(task)) ? ACTIVE_POLL_SECONDS : IDLE_POLL_SECONDS;
    if (sincePoll < interval) return;
    if (!flight) void refresh();
    if (selectedId.value && tasks.value.some(task => task.id === selectedId.value && isTaskActive(task))) {
      void read(selectedId.value);
    }
  }, 1000);
  onScopeDispose(() => {
    disposed = true; epoch += 1;
    clearInterval(timer);
    listController?.abort(); detailController?.abort(); stopController?.abort(); deleteController?.abort();
  });

  return { sessionId, tasks, error, loading, now, selectedId, detail, detailError, reading, stoppingId, stopError,
    deletingId, deleteError,
    runningCount: computed(() => tasks.value.filter(task => task.status === 'RUNNING').length),
    pendingCount: computed(() => tasks.value.filter(task => task.status === 'PENDING').length),
    refresh, read, closeOutput, stop, removeTask, onTaskChanged };
}
export type BackgroundTasksState = ReturnType<typeof useBackgroundTasks>;
