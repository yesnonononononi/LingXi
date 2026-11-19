<script setup lang="ts">
import {computed, ref} from 'vue';
import type {ChecklistState} from '../../views/chat/useChecklist';
import {useChecklistPanelModel} from './useTaskProgressPackModels';

const props = defineProps<{ feed: ChecklistState; expanded: boolean; executing: boolean; isDark?: boolean }>();
const emit = defineEmits<{ 'update:expanded': [value: boolean] }>();

const { t, panelId, snapshot, error, loading, steps, settled, percent, toggle, refresh, stepStatusLabel } =
  useChecklistPanelModel(props, value => emit('update:expanded', value));

type StepFilter = 'all' | 'active' | 'done';
const stepFilter = ref<StepFilter>('all');

const ringRadius = 14;
const ringCircumference = 2 * Math.PI * ringRadius;
const ringOffset = computed(() => ringCircumference * (1 - percent.value / 100));

const statusBreakdown = computed(() => {
  const total = Math.max(steps.value.length, 1);
  const completed = steps.value.filter(s => s.status === 'COMPLETED').length;
  const inProgress = steps.value.filter(s => s.status === 'IN_PROGRESS').length;
  const failed = steps.value.filter(s => s.status === 'FAILED').length;
  return {
    completedPct: (completed / total) * 100,
    inProgressPct: (inProgress / total) * 100,
    failedPct: (failed / total) * 100,
  };
});

const filteredSteps = computed(() => {
  if (stepFilter.value === 'active') return steps.value.filter(s => s.status === 'IN_PROGRESS' || s.status === 'PENDING');
  if (stepFilter.value === 'done') return steps.value.filter(s => ['COMPLETED', 'FAILED', 'SKIPPED'].includes(s.status));
  return steps.value;
});
</script>

<template>
  <div v-if="snapshot || error" class="relative inline-flex flex-col">
    <button
      type="button"
      data-testid="checklist-toggle"
      :aria-expanded="expanded"
      :aria-controls="panelId"
      class="inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs font-medium transition cursor-pointer backdrop-blur-md"
      :class="isDark
        ? 'border-cyan-400/45 bg-slate-950/90 text-cyan-200 hover:border-cyan-300 shadow-[0_0_18px_-4px_rgba(34,211,238,0.35)]'
        : 'border-sky-300 bg-gradient-to-r from-sky-50 via-white to-indigo-50 text-sky-950 hover:border-sky-400 shadow-xs'"
      @click="toggle"
    >
      <svg class="h-4 w-4 -rotate-90" viewBox="0 0 36 36" aria-hidden="true">
        <circle cx="18" cy="18" :r="ringRadius" fill="none" stroke="currentColor" stroke-width="3" class="opacity-20" />
        <circle
          cx="18" cy="18" :r="ringRadius" fill="none" stroke="currentColor" stroke-width="3"
          stroke-linecap="round"
          :stroke-dasharray="ringCircumference"
          :stroke-dashoffset="ringOffset"
          class="transition-all duration-300"
        />
      </svg>
      <span class="font-semibold">{{ t('chat.checklist.title') }}</span>
      <span v-if="snapshot" class="font-mono text-lx-fs-2xs tabular-nums opacity-80">{{ settled }}/{{ steps.length }}</span>
      <span v-if="error" class="font-bold text-rose-500">!</span>
    </button>

    <section
      v-if="expanded"
      :id="panelId"
      data-testid="checklist-panel"
      class="absolute bottom-full left-0 z-30 mb-2 w-[min(32rem,calc(100vw-2rem))] rounded-2xl border p-3.5 text-xs backdrop-blur-xl shadow-2xl"
      :class="isDark
        ? 'border-cyan-400/35 bg-slate-950/95 text-slate-100 shadow-[0_18px_48px_-10px_rgba(34,211,238,0.28)]'
        : 'border-sky-200 bg-white/95 text-slate-800 shadow-[0_16px_40px_-10px_rgba(14,165,233,0.18)]'"
    >
      <header class="mb-2.5 flex items-center gap-2.5">
        <div class="relative flex h-9 w-9 shrink-0 items-center justify-center">
          <svg class="h-9 w-9 -rotate-90" viewBox="0 0 36 36" aria-hidden="true">
            <circle cx="18" cy="18" :r="ringRadius" fill="none" stroke="currentColor" stroke-width="2.5" class="opacity-15" />
            <circle
              cx="18" cy="18" :r="ringRadius" fill="none"
              :stroke="isDark ? '#22d3ee' : '#0284c7'" stroke-width="2.5" stroke-linecap="round"
              :stroke-dasharray="ringCircumference" :stroke-dashoffset="ringOffset"
              class="transition-all duration-300"
            />
          </svg>
          <span class="absolute font-mono text-lx-fs-2xs font-bold tabular-nums">{{ percent }}%</span>
        </div>

        <div class="min-w-0 flex-1">
          <div class="truncate font-semibold">{{ snapshot?.title || t('chat.checklist.title') }}</div>
          <div v-if="snapshot" class="mt-1 flex h-1.5 w-full overflow-hidden rounded-full" :class="isDark ? 'bg-white/10' : 'bg-slate-200'">
            <div class="h-full bg-emerald-500 transition-all duration-300" :style="{ width: `${statusBreakdown.completedPct}%` }" />
            <div class="h-full bg-cyan-400 lx-live-dot transition-all duration-300" :style="{ width: `${statusBreakdown.inProgressPct}%` }" />
            <div class="h-full bg-rose-500 transition-all duration-300" :style="{ width: `${statusBreakdown.failedPct}%` }" />
          </div>
        </div>

        <button type="button" class="cursor-pointer opacity-75 hover:opacity-100" :disabled="loading" :aria-label="t('common.refresh')" @click="refresh">↻</button>
        <button type="button" class="cursor-pointer opacity-75 hover:opacity-100" :aria-label="t('common.collapse')" @click="emit('update:expanded', false)">✕</button>
      </header>

      <div class="mb-2.5 flex items-center justify-between gap-2">
        <div class="inline-flex rounded-lg border p-0.5" :class="isDark ? 'border-white/10 bg-white/[0.03]' : 'border-sky-100 bg-sky-50/60'">
          <button
            v-for="tab in ([{ key: 'all', label: '全部步骤' }, { key: 'active', label: '待处理/进行中' }, { key: 'done', label: '已落定' }] as const)"
            :key="tab.key"
            type="button"
            class="rounded-md px-2 py-0.5 text-lx-fs-2xs font-medium transition cursor-pointer"
            :class="stepFilter === tab.key
              ? (isDark ? 'bg-cyan-500/20 text-cyan-200' : 'bg-white text-sky-700 shadow-2xs')
              : 'opacity-65 hover:opacity-100'"
            @click="stepFilter = tab.key"
          >{{ tab.label }}</button>
        </div>
        <span v-if="snapshot" class="font-mono text-lx-fs-2xs tabular-nums opacity-65">{{ settled }}/{{ steps.length }}</span>
      </div>

      <p v-if="error" role="alert" class="mb-2 text-rose-500">{{ error }}</p>

      <!-- 垂直里程碑轨道 -->
      <ol class="relative max-h-56 space-y-2 overflow-y-auto pl-5 pr-1 scrollbar-thin">
        <span
          class="pointer-events-none absolute top-2 bottom-2 left-2 w-px"
          :class="isDark ? 'bg-cyan-400/25' : 'bg-sky-200'"
          aria-hidden="true"
        />
        <li
          v-for="step in filteredSteps"
          :key="step.stepId"
          :data-status="step.status"
          class="relative rounded-xl border px-2.5 py-2 transition"
          :class="step.status === 'IN_PROGRESS'
            ? (isDark ? 'border-cyan-400/50 bg-cyan-500/15 text-cyan-50' : 'border-sky-300 bg-sky-50/90 text-slate-900')
            : (isDark ? 'border-white/10 bg-white/[0.02]' : 'border-slate-200/80 bg-slate-50/50')"
        >
          <span
            class="absolute -left-[15px] top-3 h-2.5 w-2.5 rounded-full border-2"
            :class="step.status === 'COMPLETED'
              ? 'border-emerald-400 bg-emerald-400'
              : step.status === 'IN_PROGRESS'
                ? 'border-cyan-400 bg-cyan-400 lx-live-dot'
                : step.status === 'FAILED'
                  ? 'border-rose-500 bg-rose-500'
                  : (isDark ? 'border-slate-600 bg-slate-900' : 'border-slate-300 bg-white')"
            aria-hidden="true"
          />
          <div class="flex items-start justify-between gap-2">
            <span class="min-w-0 flex-1 whitespace-pre-wrap break-words leading-relaxed"
              :class="step.status === 'COMPLETED' ? 'opacity-70' : 'font-medium'">
              {{ step.content }}
            </span>
            <span class="shrink-0 rounded-md px-1.5 py-0.5 text-lx-fs-2xs font-medium"
              :class="step.status === 'COMPLETED'
                ? (isDark ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-100 text-emerald-700')
                : step.status === 'IN_PROGRESS'
                  ? (isDark ? 'bg-cyan-500/20 text-cyan-200' : 'bg-sky-100 text-sky-700')
                  : step.status === 'FAILED'
                    ? (isDark ? 'bg-rose-500/20 text-rose-300' : 'bg-rose-100 text-rose-700')
                    : 'opacity-65'">
              {{ stepStatusLabel(step.status) }}
            </span>
          </div>
        </li>
      </ol>
    </section>
  </div>
</template>
