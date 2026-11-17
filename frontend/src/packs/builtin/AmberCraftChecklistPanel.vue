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
      class="inline-flex items-center gap-2 rounded-xl border px-3 py-1 text-xs font-medium transition cursor-pointer"
      :class="isDark
        ? 'border-orange-500/40 bg-orange-950/45 text-orange-200 hover:border-orange-400'
        : 'border-orange-300 bg-orange-50 text-orange-900 hover:border-orange-400 shadow-2xs'"
      @click="toggle"
    >
      <span class="font-semibold">{{ t('chat.checklist.title') }}</span>
      <span v-if="snapshot" class="rounded bg-amber-500/20 px-1.5 py-0.5 text-lx-fs-sm tabular-nums" :class="isDark ? 'text-amber-300' : 'text-amber-800'">
        {{ settled }}/{{ steps.length }}
      </span>
      <span v-if="error" class="font-bold text-red-500">!</span>
    </button>

    <section
      v-if="expanded"
      :id="panelId"
      data-testid="checklist-panel"
      class="absolute bottom-full left-0 z-30 mb-2 w-[min(30rem,calc(100vw-2rem))] rounded-2xl border p-3.5 text-xs shadow-xl"
      :class="isDark
        ? 'border-amber-500/35 bg-stone-950 text-amber-50'
        : 'border-amber-300/90 bg-gradient-to-b from-amber-50 to-white text-stone-900'"
    >
      <header class="mb-2 flex items-center gap-2">
        <span class="flex-1 truncate font-semibold">{{ snapshot?.title || t('chat.checklist.title') }}</span>
        <span v-if="snapshot" class="tabular-nums opacity-75">{{ percent }}%</span>
        <button type="button" class="cursor-pointer opacity-75 hover:opacity-100" :disabled="loading" :aria-label="t('common.refresh')" @click="refresh">↻</button>
        <button type="button" class="cursor-pointer opacity-75 hover:opacity-100" :aria-label="t('common.collapse')" @click="emit('update:expanded', false)">✕</button>
      </header>

      <div v-if="snapshot" class="mb-3 h-1.5 w-full overflow-hidden rounded-full" :class="isDark ? 'bg-white/10' : 'bg-amber-200/70'">
        <div class="h-full rounded-full bg-gradient-to-r from-amber-500 to-orange-500 transition-all duration-300" :style="{ width: `${percent}%` }" />
      </div>

      <p v-if="error" role="alert" class="mb-2 text-red-500">{{ error }}</p>

      <ul class="max-h-56 space-y-1.5 overflow-y-auto scrollbar-thin">
        <li v-for="step in steps" :key="step.stepId" :data-status="step.status" class="flex items-start gap-2 rounded-xl border px-2.5 py-1.5"
          :class="step.status === 'IN_PROGRESS'
            ? (isDark ? 'border-amber-400/50 bg-amber-500/15 text-amber-100' : 'border-amber-300 bg-amber-100/70 text-stone-950')
            : (isDark ? 'border-white/5 opacity-75' : 'border-amber-200/50 bg-white/80 opacity-80')">
          <span class="mt-0.5 shrink-0 font-bold text-amber-600 dark:text-amber-400">{{ step.status === 'COMPLETED' ? '✓' : step.status === 'FAILED' ? '✕' : step.status === 'IN_PROGRESS' ? '▶' : '·' }}</span>
          <span class="min-w-0 flex-1 whitespace-pre-wrap break-words">{{ step.content }}</span>
          <span class="shrink-0 text-lx-fs-sm opacity-70">{{ stepStatusLabel(step.status) }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
