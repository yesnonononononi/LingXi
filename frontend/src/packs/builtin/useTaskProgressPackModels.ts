import {computed, useId, watch} from 'vue';
import type {BackgroundTasksState} from '../../views/chat/useBackgroundTasks';
import type {ChecklistState} from '../../views/chat/useChecklist';
import {type BackgroundTask, isTaskActive} from '../../types/backgroundTask';
import {useI18n} from '../../i18n';

export interface BackgroundPackProps {
  feed: BackgroundTasksState;
  isDark?: boolean;
  embedded?: boolean;
  expanded?: boolean;
}

export interface ChecklistPackProps {
  feed: ChecklistState;
  expanded: boolean;
  executing: boolean;
  isDark?: boolean;
}

/** 后台任务胶囊扩展包共享模型：统一派生计数、排序、时长与交互动作。 */
export function useBackgroundPanelModel(props: BackgroundPackProps, emitExpanded: (value: boolean) => void) {
  const { t } = useI18n();
  const panelId = useId();
  const {
    tasks, error, loading, now, runningCount, pendingCount, sessionId, selectedId, detail, detailError,
    reading, stoppingId, stopError, deletingId, deletingFinished, finishedCount, deleteError,
    refresh, read, stop, removeTask, removeFinished, closeOutput,
  } = props.feed;

  const visible = computed(() => tasks.value.length > 0 || !!error.value);
  const summary = computed(() => runningCount.value > 0
    ? t('chat.backgroundTasks.running', { count: runningCount.value })
    : pendingCount.value > 0 ? t('chat.backgroundTasks.pending', { count: pendingCount.value })
    : tasks.value.length ? t('chat.backgroundTasks.finished', { count: tasks.value.length }) : t('chat.backgroundTasks.title'));
  const ordered = computed(() => [...tasks.value].sort((left, right) => Number(isTaskActive(right)) - Number(isTaskActive(left))));
  const title = (task: BackgroundTask) => task.intention?.trim() || task.command;

  function elapsed(task: BackgroundTask): string {
    const started = Date.parse(task.createAt);
    return Number.isFinite(started)
      ? t('chat.backgroundTasks.elapsed', { seconds: Math.max(0, Math.floor((now.value - started) / 1000)) })
      : t('chat.backgroundTasks.status.RUNNING');
  }

  function toggle() {
    const next = !props.expanded;
    emitExpanded(next);
    if (next) void refresh();
  }

  function collapse() {
    emitExpanded(false);
    closeOutput();
  }

  watch(sessionId, () => { emitExpanded(false); });
  watch(() => props.expanded, value => { if (!value) closeOutput(); });

  return {
    t,
    panelId,
    tasks,
    error,
    loading,
    runningCount,
    selectedId,
    detail,
    detailError,
    reading,
    stoppingId,
    stopError,
    deletingId,
    deletingFinished,
    finishedCount,
    deleteError,
    visible,
    summary,
    ordered,
    title,
    elapsed,
    toggle,
    collapse,
    refresh,
    read,
    stop,
    removeTask,
    removeFinished,
    closeOutput,
    isTaskActive,
  };
}

/** 任务清单胶囊扩展包共享模型：统一派生步骤、完成度百分比与状态文案。 */
export function useChecklistPanelModel(props: ChecklistPackProps, emitExpanded: (value: boolean) => void) {
  const { t } = useI18n();
  const panelId = useId();
  const { snapshot, error, loading, refresh } = props.feed;

  const steps = computed(() => [...(snapshot.value?.steps ?? [])].sort((left, right) => left.seq - right.seq));
  const settled = computed(() => steps.value.filter(step => ['COMPLETED', 'FAILED', 'SKIPPED'].includes(step.status)).length);
  const percent = computed(() => steps.value.length ? Math.round((settled.value / steps.value.length) * 100) : 0);

  function toggle() {
    emitExpanded(!props.expanded);
    if (!props.expanded) void refresh();
  }

  function stepStatusLabel(status: string): string {
    if (snapshot.value?.status === 'DELETED') return t(`chat.checklist.status.${status}`);
    if (snapshot.value?.status === 'UNFINISHED' && status === 'IN_PROGRESS') return t('chat.checklist.unfinished');
    if (status === 'IN_PROGRESS' && !props.executing) return t('chat.checklist.paused');
    return t(`chat.checklist.status.${status}`);
  }

  return {
    t,
    panelId,
    snapshot,
    error,
    loading,
    steps,
    settled,
    percent,
    toggle,
    refresh,
    stepStatusLabel,
  };
}
