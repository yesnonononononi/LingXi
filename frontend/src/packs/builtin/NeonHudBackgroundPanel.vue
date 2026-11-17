<script setup lang="ts">
import {computed, ref} from 'vue';
import type {BackgroundTasksState} from '../../views/chat/useBackgroundTasks';
import {useBackgroundPanelModel} from './useTaskProgressPackModels';

const props = withDefaults(defineProps<{ feed: BackgroundTasksState; isDark?: boolean; embedded?: boolean; expanded?: boolean }>(), { expanded: false });
const emit = defineEmits<{ 'update:expanded': [value: boolean] }>();

const {
  t, panelId, error, loading, runningCount, selectedId, detail, detailError,
  reading, stoppingId, stopError, deletingId, deletingFinished, finishedCount, deleteError,
  visible, summary, ordered, title, elapsed, toggle, collapse, refresh, read, stop, removeTask, removeFinished, closeOutput, isTaskActive,
} = useBackgroundPanelModel(props, value => emit('update:expanded', value));

type FilterMode = 'all' | 'active' | 'done';
const filterMode = ref<FilterMode>('all');
const copiedOutput = ref(false);

const activeCount = computed(() => ordered.value.filter(task => isTaskActive(task)).length);
const filteredTasks = computed(() => {
  if (filterMode.value === 'active') return ordered.value.filter(task => isTaskActive(task));
  if (filterMode.value === 'done') return ordered.value.filter(task => !isTaskActive(task));
  return ordered.value;
});
const primaryElapsed = computed(() => {
  const firstRunning = ordered.value.find(task => task.status === 'RUNNING');
  return firstRunning ? elapsed(firstRunning) : null;
});

async function copyDetailOutput() {
  const text = detail.value?.output ?? '';
  if (!text || typeof navigator === 'undefined' || !navigator.clipboard) return;
  try {
    await navigator.clipboard.writeText(text);
    copiedOutput.value = true;
    setTimeout(() => { copiedOutput.value = false; }, 1600);
  } catch {
    // 剪贴板权限受限时静默忽略
  }
}
</script>

<template>
  <div v-if="visible" class="relative inline-flex flex-col">
    <button
      type="button"
      data-testid="background-task-toggle"
      :aria-expanded="expanded"
      :aria-controls="panelId"
      class="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition cursor-pointer backdrop-blur-md"
      :class="isDark
        ? 'border-cyan-400/45 bg-slate-950/90 text-cyan-200 hover:border-cyan-300 shadow-[0_0_20px_-4px_rgba(34,211,238,0.4)]'
        : 'border-indigo-300 bg-gradient-to-r from-cyan-50 via-white to-indigo-50 text-indigo-950 hover:border-indigo-400 shadow-xs'"
      @click="toggle"
    >
      <span class="inline-flex items-end gap-0.5 h-3" aria-hidden="true">
        <span class="w-0.5 rounded-full bg-cyan-400 transition-all" :class="runningCount > 0 ? 'h-3 animate-pulse' : 'h-1.5 opacity-60'" />
        <span class="w-0.5 rounded-full bg-indigo-400 transition-all" :class="runningCount > 0 ? 'h-2 animate-pulse' : 'h-2.5 opacity-60'" />
        <span class="w-0.5 rounded-full bg-cyan-300 transition-all" :class="runningCount > 0 ? 'h-2.5 animate-pulse' : 'h-1 opacity-60'" />
      </span>
      <span class="font-semibold">{{ summary }}</span>
      <span
        v-if="primaryElapsed"
        class="rounded-full px-1.5 py-0.2 text-lx-fs-2xs font-mono tabular-nums"
        :class="isDark ? 'bg-cyan-400/15 text-cyan-300' : 'bg-indigo-100 text-indigo-700'"
      >{{ primaryElapsed }}</span>
      <span v-if="error" class="font-bold text-rose-500">!</span>
    </button>

    <section
      v-if="expanded"
      :id="panelId"
      data-testid="background-task-panel"
      class="absolute bottom-full left-0 z-30 mb-2 w-[min(34rem,calc(100vw-2rem))] rounded-2xl border p-3.5 text-xs backdrop-blur-xl shadow-2xl"
      :class="isDark
        ? 'border-cyan-400/35 bg-slate-950/95 text-slate-100 shadow-[0_18px_48px_-10px_rgba(34,211,238,0.3)]'
        : 'border-indigo-200 bg-white/95 text-slate-800 shadow-[0_16px_40px_-10px_rgba(79,70,229,0.2)]'"
    >
      <header class="mb-2.5 flex items-center gap-2 border-b pb-2" :class="isDark ? 'border-white/10' : 'border-indigo-100'">
        <span class="h-2 w-2 rounded-full bg-cyan-400 lx-live-dot" aria-hidden="true" />
        <span class="flex-1 font-semibold tracking-tight">{{ summary }}</span>
        <button v-if="finishedCount" type="button" data-testid="background-task-delete-finished"
          class="rounded-lg border px-2 py-0.5 text-lx-fs-sm cursor-pointer disabled:opacity-50"
          :class="isDark ? 'border-white/15 text-slate-300 hover:bg-white/10' : 'border-indigo-200 text-indigo-700 hover:bg-indigo-50'"
          :disabled="!!deletingId || deletingFinished" @click="removeFinished()">
          {{ deletingFinished ? t('chat.backgroundTasks.deleting') : t('chat.backgroundTasks.deleteFinished') }}
        </button>
        <button type="button" class="rounded-md px-1.5 py-0.5 cursor-pointer opacity-75 hover:opacity-100" :disabled="loading" :aria-label="t('common.refresh')" @click="refresh()">↻</button>
        <button type="button" data-testid="background-task-collapse" class="rounded-md px-1.5 py-0.5 cursor-pointer opacity-75 hover:opacity-100" :aria-label="t('common.collapse')" @click="collapse">✕</button>
      </header>

      <!-- 遥测指标 + 筛选条 -->
      <div class="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div class="grid grid-cols-3 gap-1.5 text-center">
          <div class="rounded-lg px-2 py-1" :class="isDark ? 'bg-cyan-500/10 text-cyan-300' : 'bg-cyan-50 text-cyan-800'">
            <div class="text-lx-fs-2xs opacity-75">运行中</div>
            <div class="font-mono font-bold tabular-nums">{{ runningCount }}</div>
          </div>
          <div class="rounded-lg px-2 py-1" :class="isDark ? 'bg-indigo-500/10 text-indigo-300' : 'bg-indigo-50 text-indigo-800'">
            <div class="text-lx-fs-2xs opacity-75">活跃</div>
            <div class="font-mono font-bold tabular-nums">{{ activeCount }}</div>
          </div>
          <div class="rounded-lg px-2 py-1" :class="isDark ? 'bg-emerald-500/10 text-emerald-300' : 'bg-emerald-50 text-emerald-800'">
            <div class="text-lx-fs-2xs opacity-75">已结束</div>
            <div class="font-mono font-bold tabular-nums">{{ finishedCount }}</div>
          </div>
        </div>

        <div class="inline-flex rounded-lg border p-0.5" :class="isDark ? 'border-white/10 bg-white/[0.03]' : 'border-indigo-100 bg-indigo-50/50'">
          <button
            v-for="mode in ([{ key: 'all', label: '全部' }, { key: 'active', label: '活跃' }, { key: 'done', label: '已结束' }] as const)"
            :key="mode.key"
            type="button"
            class="rounded-md px-2 py-0.5 text-lx-fs-2xs font-medium transition cursor-pointer"
            :class="filterMode === mode.key
              ? (isDark ? 'bg-cyan-500/20 text-cyan-200' : 'bg-white text-indigo-700 shadow-2xs')
              : 'opacity-65 hover:opacity-100'"
            @click="filterMode = mode.key"
          >{{ mode.label }}</button>
        </div>
      </div>

      <p v-if="error" role="alert" class="mb-2 text-rose-500">{{ error }}</p>
      <p v-if="stopError" role="alert" class="mb-2 text-rose-500" data-testid="background-stop-error">{{ stopError }}</p>
      <p v-if="deleteError" role="alert" class="mb-2 text-rose-500" data-testid="background-delete-error">{{ deleteError }}</p>

      <ul class="max-h-48 space-y-1.5 overflow-y-auto scrollbar-thin">
        <li
          v-for="task in filteredTasks"
          :key="task.id"
          class="rounded-xl border px-2.5 py-2 transition"
          :data-status="task.status"
          :data-task-id="task.id"
          :class="selectedId === task.id
            ? (isDark ? 'border-cyan-400/50 bg-cyan-500/10' : 'border-indigo-300 bg-indigo-50/70')
            : (isDark ? 'border-white/10 bg-white/[0.03] hover:bg-white/[0.06]' : 'border-slate-200/80 bg-slate-50/60 hover:bg-indigo-50/40')"
        >
          <div class="flex items-center gap-2">
            <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left cursor-pointer" @click="read(task.id)">
              <span class="h-2 w-2 shrink-0 rounded-full" :class="task.status === 'RUNNING' ? 'bg-cyan-400 lx-live-dot' : task.status === 'FAILED' ? 'bg-rose-500' : 'bg-emerald-500'" />
              <div class="min-w-0 flex-1">
                <div class="truncate font-semibold">{{ title(task) }}</div>
                <div v-if="task.command && task.intention?.trim()" class="truncate font-mono text-lx-fs-2xs opacity-60">{{ task.command }}</div>
              </div>
              <span class="shrink-0 rounded-md px-1.5 py-0.5 font-mono text-lx-fs-2xs tabular-nums"
                :class="task.status === 'RUNNING'
                  ? (isDark ? 'bg-cyan-400/15 text-cyan-300' : 'bg-cyan-100 text-cyan-800')
                  : (isDark ? 'bg-white/10 text-slate-300' : 'bg-slate-200/80 text-slate-700')">
                {{ task.status === 'RUNNING' ? elapsed(task) : t(`chat.backgroundTasks.status.${task.status}`) }}
              </span>
            </button>
            <button v-if="task.status === 'RUNNING'" type="button" data-testid="background-task-stop"
              class="rounded-lg border px-2 py-0.5 text-lx-fs-sm cursor-pointer disabled:opacity-50"
              :class="isDark ? 'border-rose-500/40 text-rose-300 hover:bg-rose-950/40' : 'border-rose-200 text-rose-600 hover:bg-rose-50'"
              :disabled="!!stoppingId" @click="stop(task.id)">
              {{ stoppingId === task.id ? t('chat.backgroundTasks.stopping') : t('chat.backgroundTasks.stop') }}
            </button>
            <button v-if="!isTaskActive(task)" type="button" data-testid="background-task-delete"
              class="px-1 text-lx-fs-sm opacity-60 hover:opacity-100 cursor-pointer" :disabled="!!deletingId" @click="removeTask(task.id)">✕</button>
          </div>
          <div v-if="task.status === 'RUNNING'" class="mt-1.5 h-1 w-full overflow-hidden rounded-full" :class="isDark ? 'bg-white/10' : 'bg-indigo-100'">
            <div class="h-full w-2/3 animate-pulse rounded-full bg-gradient-to-r from-cyan-400 to-indigo-500" />
          </div>
        </li>
      </ul>

      <div v-if="selectedId" class="mt-2.5 rounded-xl border p-2.5" data-testid="background-task-output"
        :class="isDark ? 'border-cyan-400/25 bg-black/50' : 'border-slate-200 bg-slate-900 text-slate-100'">
        <div class="mb-1.5 flex items-center gap-2 text-lx-fs-2xs text-cyan-300">
          <span class="flex-1 font-mono font-semibold">{{ t('chat.backgroundTasks.output') }}</span>
          <span v-if="detail?.exitCode != null" class="rounded bg-white/10 px-1.5 py-0.5 font-mono">{{ t('chat.backgroundTasks.exitCode', { code: detail.exitCode }) }}</span>
          <button v-if="detail?.output" type="button" class="rounded bg-white/10 px-1.5 py-0.5 hover:bg-white/20 cursor-pointer" @click="copyDetailOutput">
            {{ copiedOutput ? '已复制 ✓' : '复制' }}
          </button>
          <button type="button" class="cursor-pointer opacity-80 hover:opacity-100" :disabled="reading" @click="read(selectedId)">↻</button>
          <button type="button" class="cursor-pointer opacity-80 hover:opacity-100" @click="closeOutput()">✕</button>
        </div>
        <p v-if="detailError" role="alert" class="text-rose-400">{{ detailError }}</p>
        <p v-else-if="!detail && reading" class="opacity-70">{{ t('common.loading') }}</p>
        <pre v-else-if="detail" class="max-h-36 overflow-auto whitespace-pre-wrap break-all font-mono text-lx-fs-2xs leading-relaxed text-slate-200 select-text">{{ detail.output || t('chat.backgroundTasks.noOutput') }}</pre>
        <p v-if="detail?.truncated" class="mt-1 text-lx-fs-2xs text-amber-300">{{ t('chat.backgroundTasks.truncated') }}</p>
      </div>
    </section>
  </div>
</template>
