<script setup lang="ts">
import type {ChecklistState} from '../../views/chat/useChecklist';
import {useChecklistPanelModel} from './useTaskProgressPackModels';

const props = defineProps<{ feed: ChecklistState; expanded: boolean; executing: boolean; isDark?: boolean }>();
const emit = defineEmits<{ 'update:expanded': [value: boolean] }>();

const { t, panelId, snapshot, error, loading, steps, settled, percent, toggle, refresh, stepStatusLabel } =
  useChecklistPanelModel(props, value => emit('update:expanded', value));
</script>

<template>
  <div v-if="snapshot || error" class="relative inline-flex flex-col">
    <button
      type="button"
      data-testid="checklist-toggle"
      :aria-expanded="expanded"
      :aria-controls="panelId"
      class="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition cursor-pointer backdrop-blur-md"
      :class="isDark
        ? 'border-fuchsia-400/40 bg-slate-950/85 text-fuchsia-200 hover:border-fuchsia-300 shadow-[0_0_16px_-4px_rgba(217,70,239,0.35)]'
        : 'border-violet-300 bg-gradient-to-r from-indigo-50 to-fuchsia-50 text-violet-950 hover:border-violet-400 shadow-xs'"
      @click="toggle"
    >
      <span class="font-semibold">{{ t('chat.checklist.title') }}</span>
      <span v-if="snapshot" class="rounded-full px-1.5 py-0.5 text-lx-fs-sm tabular-nums" :class="isDark ? 'bg-fuchsia-500/20 text-fuchsia-200' : 'bg-violet-200/70 text-violet-900'">
        {{ settled }}/{{ steps.length }}
      </span>
      <span v-if="error" class="font-bold text-rose-500">!</span>
    </button>

    <section
      v-if="expanded"
      :id="panelId"
      data-testid="checklist-panel"
      class="absolute bottom-full left-0 z-30 mb-2 w-[min(30rem,calc(100vw-2rem))] rounded-2xl border p-3.5 text-xs backdrop-blur-xl shadow-xl"
      :class="isDark
        ? 'border-fuchsia-400/35 bg-slate-950/95 text-slate-100 shadow-[0_12px_36px_-8px_rgba(217,70,239,0.28)]'
        : 'border-violet-200 bg-white/95 text-slate-800 shadow-[0_12px_32px_-8px_rgba(124,58,237,0.18)]'"
    >
      <header class="mb-2 flex items-center gap-2">
        <span class="flex-1 truncate font-semibold">{{ snapshot?.title || t('chat.checklist.title') }}</span>
        <span v-if="snapshot" class="tabular-nums opacity-75">{{ percent }}%</span>
        <button type="button" class="cursor-pointer opacity-75 hover:opacity-100" :disabled="loading" :aria-label="t('common.refresh')" @click="refresh">↻</button>
        <button type="button" class="cursor-pointer opacity-75 hover:opacity-100" :aria-label="t('common.collapse')" @click="emit('update:expanded', false)">✕</button>
      </header>

      <div v-if="snapshot" class="mb-3 h-1.5 w-full overflow-hidden rounded-full" :class="isDark ? 'bg-white/10' : 'bg-violet-100'">
        <div class="h-full rounded-full bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 transition-all duration-300" :style="{ width: `${percent}%` }" />
      </div>

      <p v-if="error" role="alert" class="mb-2 text-rose-500">{{ error }}</p>

      <ul class="max-h-56 space-y-1.5 overflow-y-auto scrollbar-thin">
        <li v-for="step in steps" :key="step.stepId" :data-status="step.status" class="flex items-start gap-2 rounded-xl px-2.5 py-1.5"
          :class="step.status === 'IN_PROGRESS' ? (isDark ? 'bg-fuchsia-500/15 text-fuchsia-100' : 'bg-violet-50 text-violet-950') : 'opacity-80'">
          <span class="mt-0.5 shrink-0 font-bold">{{ step.status === 'COMPLETED' ? '✓' : step.status === 'FAILED' ? '✕' : step.status === 'IN_PROGRESS' ? '◉' : '○' }}</span>
          <span class="min-w-0 flex-1 whitespace-pre-wrap break-words">{{ step.content }}</span>
          <span class="shrink-0 text-lx-fs-sm opacity-70">{{ stepStatusLabel(step.status) }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
