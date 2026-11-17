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
      class="inline-flex items-center gap-2 rounded-xl border px-3 py-1 text-xs font-medium transition cursor-pointer"
      :class="isDark
        ? 'border-amber-500/40 bg-amber-950/50 text-amber-200 hover:border-amber-400'
        : 'border-amber-300 bg-amber-50 text-amber-900 hover:border-amber-400 shadow-2xs'"
      @click="toggle"
    >
      <span class="rounded bg-amber-500/20 px-1.5 py-0.5 text-lx-fs-sm font-semibold" :class="isDark ? 'text-amber-300' : 'text-amber-800'">
        {{ runningCount > 0 ? 'RUN' : 'BG' }}
      </span>
      <span>{{ summary }}</span>
      <span v-if="error" class="font-bold text-red-500">!</span>
    </button>

    <section
      v-if="expanded"
      :id="panelId"
      data-testid="background-task-panel"
      class="absolute bottom-full left-0 z-30 mb-2 w-[min(30rem,calc(100vw-2rem))] rounded-2xl border p-3.5 text-xs shadow-xl"
      :class="isDark
        ? 'border-amber-500/35 bg-stone-950 text-amber-50'
        : 'border-amber-300/90 bg-gradient-to-b from-amber-50 to-white text-stone-900'"
    >
      <header class="mb-2.5 flex items-center gap-2 border-b pb-2" :class="isDark ? 'border-amber-500/20' : 'border-amber-200/80'">
        <span class="flex-1 font-semibold">{{ summary }}</span>
        <button v-if="finishedCount" type="button" class="rounded-lg border px-2 py-0.5 text-lx-fs-sm cursor-pointer disabled:opacity-50"
          :class="isDark ? 'border-amber-500/35 text-amber-200 hover:bg-amber-950/60' : 'border-amber-300 text-amber-800 hover:bg-amber-100'"
          :disabled="!!deletingId || deletingFinished" @click="removeFinished()">
          {{ deletingFinished ? t('chat.backgroundTasks.deleting') : t('chat.backgroundTasks.deleteFinished') }}
        </button>
        <button type="button" class="px-1.5 py-0.5 cursor-pointer opacity-75 hover:opacity-100" :disabled="loading" :aria-label="t('common.refresh')" @click="refresh()">↻</button>
        <button type="button" class="px-1.5 py-0.5 cursor-pointer opacity-75 hover:opacity-100" :aria-label="t('common.collapse')" @click="collapse">✕</button>
      </header>

      <p v-if="error" role="alert" class="mb-2 text-red-500">{{ error }}</p>
      <p v-if="stopError" role="alert" class="mb-2 text-red-500">{{ stopError }}</p>
      <p v-if="deleteError" role="alert" class="mb-2 text-red-500">{{ deleteError }}</p>

      <ul class="max-h-52 space-y-1 overflow-y-auto scrollbar-thin">
        <li v-for="task in ordered" :key="task.id" class="flex items-center gap-2 rounded-xl border px-2.5 py-1.5"
          :class="isDark ? 'border-amber-500/15 bg-white/[0.02]' : 'border-amber-200/60 bg-white'">
          <button type="button" class="flex min-w-0 flex-1 items-center gap-2 text-left cursor-pointer" @click="read(task.id)">
            <span class="min-w-0 flex-1 truncate font-medium">{{ title(task) }}</span>
            <span class="shrink-0 text-lx-fs-sm opacity-65">{{ task.status === 'RUNNING' ? elapsed(task) : t(`chat.backgroundTasks.status.${task.status}`) }}</span>
          </button>
          <button v-if="task.status === 'RUNNING'" type="button" class="rounded-lg border px-2 py-0.5 text-lx-fs-sm cursor-pointer disabled:opacity-50"
            :class="isDark ? 'border-red-500/40 text-red-300' : 'border-red-200 text-red-600'"
            :disabled="!!stoppingId" @click="stop(task.id)">
            {{ stoppingId === task.id ? t('chat.backgroundTasks.stopping') : t('chat.backgroundTasks.stop') }}
          </button>
          <button v-if="!isTaskActive(task)" type="button" class="px-1 text-lx-fs-sm opacity-60 hover:opacity-100 cursor-pointer" :disabled="!!deletingId" @click="removeTask(task.id)">✕</button>
        </li>
      </ul>

      <div v-if="selectedId" class="mt-2.5 border-t pt-2" :class="isDark ? 'border-amber-500/20' : 'border-amber-200/80'">
        <div class="mb-1 flex items-center gap-2 opacity-75">
          <span class="flex-1 font-medium">{{ t('chat.backgroundTasks.output') }}</span>
          <span v-if="detail?.exitCode != null">{{ t('chat.backgroundTasks.exitCode', { code: detail.exitCode }) }}</span>
          <button type="button" class="cursor-pointer" :disabled="reading" @click="read(selectedId)">↻</button>
          <button type="button" class="cursor-pointer" @click="closeOutput()">✕</button>
        </div>
        <p v-if="detailError" role="alert" class="text-red-500">{{ detailError }}</p>
        <p v-else-if="!detail && reading" class="opacity-65">{{ t('common.loading') }}</p>
        <pre v-else-if="detail" class="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg p-2 font-mono text-lx-fs-md" :class="isDark ? 'bg-black/60 text-amber-200' : 'bg-stone-900 text-amber-200'">{{ detail.output || t('chat.backgroundTasks.noOutput') }}</pre>
      </div>
    </section>
  </div>
</template>
