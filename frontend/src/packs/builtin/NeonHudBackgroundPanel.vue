<script setup lang="ts">
import type {BackgroundTasksState} from '../../views/chat/useBackgroundTasks';
import {useBackgroundPanelModel} from './useTaskProgressPackModels';

const props = withDefaults(defineProps<{ feed: BackgroundTasksState; isDark?: boolean; embedded?: boolean; expanded?: boolean }>(), { expanded: false });
const emit = defineEmits<{ 'update:expanded': [value: boolean] }>();

const {
  t, panelId, error, loading, runningCount, selectedId, detail, detailError,
  reading, stoppingId, stopError, deletingId, deletingFinished, finishedCount, deleteError,
  visible, summary, ordered, title, elapsed, toggle, collapse, refresh, read, stop, removeTask, removeFinished, closeOutput, isTaskActive,
} = useBackgroundPanelModel(props, value => emit('update:expanded', value));
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
        ? 'border-cyan-400/40 bg-slate-950/85 text-cyan-200 hover:border-cyan-300 shadow-[0_0_16px_-4px_rgba(34,211,238,0.35)]'
        : 'border-indigo-300 bg-gradient-to-r from-cyan-50 to-indigo-50 text-indigo-900 hover:border-indigo-400 shadow-xs'"
      @click="toggle"
    >
      <span class="h-2 w-2 rounded-full" :class="runningCount > 0 ? 'bg-cyan-400 lx-live-dot' : 'bg-indigo-400'" aria-hidden="true" />
      <span>{{ summary }}</span>
      <span v-if="error" class="font-bold text-rose-500">!</span>
    </button>

    <section
      v-if="expanded"
      :id="panelId"
      data-testid="background-task-panel"
      class="absolute bottom-full left-0 z-30 mb-2 w-[min(30rem,calc(100vw-2rem))] rounded-2xl border p-3.5 text-xs backdrop-blur-xl shadow-xl"
      :class="isDark
        ? 'border-cyan-400/35 bg-slate-950/95 text-slate-100 shadow-[0_12px_36px_-8px_rgba(34,211,238,0.28)]'
        : 'border-indigo-200 bg-white/95 text-slate-800 shadow-[0_12px_32px_-8px_rgba(79,70,229,0.18)]'"
    >
      <header class="mb-2.5 flex items-center gap-2 border-b pb-2" :class="isDark ? 'border-white/10' : 'border-indigo-100'">
        <span class="h-2 w-2 rounded-full bg-cyan-400" aria-hidden="true" />
        <span class="flex-1 font-semibold">{{ summary }}</span>
        <button v-if="finishedCount" type="button" class="rounded-lg border px-2 py-0.5 text-lx-fs-sm cursor-pointer disabled:opacity-50"
          :class="isDark ? 'border-white/15 text-slate-300 hover:bg-white/10' : 'border-indigo-200 text-indigo-700 hover:bg-indigo-50'"
          :disabled="!!deletingId || deletingFinished" @click="removeFinished()">
          {{ deletingFinished ? t('chat.backgroundTasks.deleting') : t('chat.backgroundTasks.deleteFinished') }}
        </button>
        <button type="button" class="rounded-md px-1.5 py-0.5 cursor-pointer opacity-75 hover:opacity-100" :disabled="loading" :aria-label="t('common.refresh')" @click="refresh()">↻</button>
        <button type="button" class="rounded-md px-1.5 py-0.5 cursor-pointer opacity-75 hover:opacity-100" :aria-label="t('common.collapse')" @click="collapse">✕</button>
      </header>

      <p v-if="error" role="alert" class="mb-2 text-rose-500">{{ error }}</p>
      <p v-if="stopError" role="alert" class="mb-2 text-rose-500">{{ stopError }}</p>
      <p v-if="deleteError" role="alert" class="mb-2 text-rose-500">{{ deleteError }}</p>

      <ul class="max-h-52 space-y-1 overflow-y-auto scrollbar-thin">
        <li v-for="task in ordered" :key="task.id" class="flex items-center gap-2 rounded-xl px-2.5 py-1.5"
          :class="isDark ? 'bg-white/[0.03] hover:bg-white/[0.07]' : 'bg-indigo-50/40 hover:bg-indigo-50'">
          <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left cursor-pointer" @click="read(task.id)">
            <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="task.status === 'RUNNING' ? 'bg-cyan-400 lx-live-dot' : task.status === 'FAILED' ? 'bg-rose-500' : 'bg-emerald-500'" />
            <span class="min-w-0 flex-1 truncate font-medium">{{ title(task) }}</span>
            <span class="shrink-0 text-lx-fs-sm opacity-65">{{ task.status === 'RUNNING' ? elapsed(task) : t(`chat.backgroundTasks.status.${task.status}`) }}</span>
          </button>
          <button v-if="task.status === 'RUNNING'" type="button" class="rounded-lg border px-2 py-0.5 text-lx-fs-sm cursor-pointer disabled:opacity-50"
            :class="isDark ? 'border-rose-500/40 text-rose-300 hover:bg-rose-950/40' : 'border-rose-200 text-rose-600 hover:bg-rose-50'"
            :disabled="!!stoppingId" @click="stop(task.id)">
            {{ stoppingId === task.id ? t('chat.backgroundTasks.stopping') : t('chat.backgroundTasks.stop') }}
          </button>
          <button v-if="!isTaskActive(task)" type="button" class="px-1 text-lx-fs-sm opacity-60 hover:opacity-100 cursor-pointer" :disabled="!!deletingId" @click="removeTask(task.id)">✕</button>
        </li>
      </ul>

      <div v-if="selectedId" class="mt-2.5 border-t pt-2" :class="isDark ? 'border-white/10' : 'border-indigo-100'">
        <div class="mb-1 flex items-center gap-2 opacity-75">
          <span class="flex-1 font-medium">{{ t('chat.backgroundTasks.output') }}</span>
          <span v-if="detail?.exitCode != null">{{ t('chat.backgroundTasks.exitCode', { code: detail.exitCode }) }}</span>
          <button type="button" class="cursor-pointer" :disabled="reading" @click="read(selectedId)">↻</button>
          <button type="button" class="cursor-pointer" @click="closeOutput()">✕</button>
        </div>
        <p v-if="detailError" role="alert" class="text-rose-500">{{ detailError }}</p>
        <p v-else-if="!detail && reading" class="opacity-65">{{ t('common.loading') }}</p>
        <pre v-else-if="detail" class="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg p-2 font-mono text-lx-fs-md" :class="isDark ? 'bg-black/50 text-cyan-100' : 'bg-slate-900 text-cyan-200'">{{ detail.output || t('chat.backgroundTasks.noOutput') }}</pre>
      </div>
    </section>
  </div>
</template>
