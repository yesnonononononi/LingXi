<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { BackgroundTasksState } from '../../views/chat/useBackgroundTasks';
import { isTaskActive, type BackgroundTask } from '../../types/backgroundTask';
import { t } from '../../i18n';
const props = defineProps<{ feed: BackgroundTasksState; isDark?: boolean }>();
const { tasks, error, loading, now, runningCount, pendingCount, sessionId, selectedId, detail, detailError,
  reading, stoppingId, stopError, deletingId, deleteError, refresh, read, stop, removeTask, closeOutput } = props.feed;
const expanded = ref(false);
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
watch(sessionId, () => { expanded.value = false; });
</script>

<template>
  <div v-if="visible" class="background-tasks w-full max-w-lx-chat mx-auto px-4" :data-theme="isDark ? 'dark' : 'light'">
    <button v-if="!expanded" type="button" class="task-pill" data-testid="background-task-toggle"
      :aria-label="t('chat.backgroundTasks.expand')" :aria-expanded="false" @click="expanded = true; refresh()">
      <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.2"/><path d="M10 5.5V10l3 2"/></svg>
      <span aria-live="polite">{{ summary }}</span>
      <span v-if="error" class="task-error-indicator" :title="error">!</span>
    </button>
    <section v-else class="task-panel" data-testid="background-task-panel" :aria-label="t('chat.backgroundTasks.title')">
      <header class="task-panel-header">
        <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.2"/><path d="M10 5.5V10l3 2"/></svg>
        <span aria-live="polite">{{ summary }}</span>
        <button type="button" class="task-icon-button" :title="t('common.refresh')" :disabled="loading"
          :aria-label="t('common.refresh')" @click="refresh()">↻</button>
        <button type="button" class="task-icon-button" data-testid="background-task-collapse" :title="t('common.collapse')"
          :aria-label="t('common.collapse')" @click="expanded = false; closeOutput()"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 6 8 8M6 14l8-8"/></svg></button>
      </header>
      <p v-if="error" role="alert" class="task-error">{{ error }}</p>
      <p v-if="stopError" role="alert" class="task-error" data-testid="background-stop-error">{{ stopError }}</p>
      <p v-if="deleteError" role="alert" class="task-error" data-testid="background-delete-error">{{ deleteError }}</p>
      <ul class="task-list">
        <li v-for="task in ordered" :key="task.id" class="task-row" :data-status="task.status" :data-task-id="task.id">
          <button type="button" class="task-open" :title="task.command" @click="read(task.id)">
            <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="3" width="15" height="14" rx="4"/><path d="m6 7 3 3-3 3m5 0h3"/></svg>
            <span class="task-name">{{ title(task) }}</span>
            <span class="task-state">{{ task.status === 'RUNNING' ? elapsed(task) : t(`chat.backgroundTasks.status.${task.status}`) }}</span>
          </button>
          <button v-if="task.status === 'RUNNING'" type="button" class="task-stop" data-testid="background-task-stop"
            :disabled="!!stoppingId" :aria-label="t('chat.backgroundTasks.stopNamed', { name: title(task) })" @click="stop(task.id)">
            {{ stoppingId === task.id ? t('chat.backgroundTasks.stopping') : t('chat.backgroundTasks.stop') }}
          </button>
          <button v-if="!isTaskActive(task)" type="button" class="task-delete" data-testid="background-task-delete"
            :disabled="!!deletingId" :title="t('chat.backgroundTasks.delete')"
            :aria-label="t('chat.backgroundTasks.deleteNamed', { name: title(task) })" @click="removeTask(task.id)">
            <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 6.2h12"/><path d="M8.2 6.2V4.7c0-.66.54-1.2 1.2-1.2h1.2c.66 0 1.2.54 1.2 1.2v1.5"/><path d="m5.8 6.2.7 9.4c.06.9.81 1.6 1.71 1.6h3.58c.9 0 1.65-.7 1.71-1.6l.7-9.4"/><path d="M9 9.4v4.4m2-4.4v4.4"/></svg>
          </button>
        </li>
      </ul>
      <div v-if="selectedId" class="task-output" data-testid="background-task-output">
        <div class="task-output-header">
          <span>{{ t('chat.backgroundTasks.output') }}</span>
          <span v-if="detail?.exitCode != null">{{ t('chat.backgroundTasks.exitCode', { code: detail.exitCode }) }}</span>
          <button type="button" class="task-icon-button" :disabled="reading" :aria-label="t('common.refresh')" @click="read(selectedId)">↻</button>
          <button type="button" class="task-icon-button" :aria-label="t('common.close')" @click="closeOutput()">×</button>
        </div>
        <p v-if="detailError" role="alert" class="task-error">{{ detailError }}</p>
        <p v-else-if="!detail && reading" class="task-output-note">{{ t('common.loading') }}</p>
        <pre v-else-if="detail">{{ detail.output || t('chat.backgroundTasks.noOutput') }}</pre>
        <p v-if="detail?.truncated" class="task-output-note">{{ t('chat.backgroundTasks.truncated') }}</p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.background-tasks { --task-bg: #fff; --task-border: #c9dfcc; --task-ink: #3d5146; --task-muted: #819087; --task-hover: #f4f7f3; --task-delete: #b6c0ba; --task-delete-hover: #e2321d; margin-bottom: 12px; color: var(--task-ink); font-size: 13px; line-height: 20px; }
.background-tasks[data-theme='dark'] { --task-bg: #111713; --task-border: #344c3c; --task-ink: #d2e0d5; --task-muted: #91a398; --task-hover: #1b271f; --task-delete: #6d7d73; --task-delete-hover: #ff6153; }
button { cursor: pointer; font: inherit; }
button:focus-visible { outline: 2px solid var(--task-muted); outline-offset: 3px; }
button:disabled { cursor: wait; opacity: .5; }
svg { flex: none; width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.task-pill { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--task-border); border-radius: 24px; padding: 7px 15px; background: var(--task-bg); color: var(--task-muted); box-shadow: 0 3px 14px #2946350c; }
.task-panel { border: 1px solid var(--task-border); border-radius: 18px; padding: 11px 15px 12px; background: var(--task-bg); box-shadow: 0 8px 22px #29463504; }
.task-panel-header { display: flex; gap: 8px; align-items: center; margin-bottom: 13px; color: var(--task-muted); }
.task-panel-header > span { flex: 1; }
.task-icon-button { display: inline-grid; place-items: center; flex: none; width: 22px; height: 22px; border: 0; background: transparent; border-radius: 6px; color: var(--task-muted); }
.task-icon-button:hover { background: var(--task-hover); color: var(--task-ink); }
.task-list { display: flex; flex-direction: column; gap: 2px; max-height: 210px; overflow-y: auto; margin: 0; padding: 0; list-style: none; }
.task-row { display: flex; gap: 8px; align-items: center; min-width: 0; min-height: 30px; border-radius: 8px; padding: 2px 5px; }
.task-row:hover, .task-row[data-status='SUCCESS'] { background: var(--task-hover); }
.task-open { display: flex; gap: 8px; align-items: center; flex: 1; min-width: 0; border: 0; background: transparent; padding: 0; color: inherit; text-align: left; }
.task-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-state { flex: none; font-size: 12px; color: var(--task-muted); }
.task-stop { flex: none; padding: 1px 7px; border: 1px solid var(--task-border); border-radius: 6px; background: transparent; color: var(--task-muted); font-size: 11px; }
.task-stop:hover { color: var(--task-ink); background: var(--task-bg); }
.task-delete { display: inline-grid; place-items: center; flex: none; width: 22px; height: 22px; border: 0; border-radius: 6px; background: transparent; color: var(--task-delete); transition: color .15s ease; }
.task-delete:hover:not(:disabled) { color: var(--task-delete-hover); }
.task-row[data-status='FAILED'] .task-state, .task-row[data-status='TIMEOUT'] .task-state, .task-error, .task-error-indicator { color: #bd5e50; }
.task-error { margin: 5px 0 9px; font-size: 12px; overflow-wrap: anywhere; }
.task-output { border-top: 1px solid var(--task-border); margin-top: 10px; padding-top: 9px; }
.task-output-header { display: flex; align-items: center; gap: 10px; color: var(--task-muted); font-size: 12px; }
.task-output-header > span:first-child { flex: 1; }
.task-output pre { max-height: 180px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0 0; font-size: 12px; line-height: 1.6; user-select: text; }
.task-output-note { margin: 7px 0 0; color: var(--task-muted); font-size: 12px; }
@media (max-width: 480px) { .task-panel { padding: 10px; } .task-open { flex-wrap: wrap; column-gap: 6px; row-gap: 0; } .task-name { max-width: calc(100% - 22px); } .task-state { margin-left: 21px; } }
</style>
