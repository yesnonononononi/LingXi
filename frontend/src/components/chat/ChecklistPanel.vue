<script setup lang="ts">
import { computed } from 'vue';
import type { ChecklistState } from '../../views/chat/useChecklist';
import { t } from '../../i18n';
import './taskProgress.css';

const props = defineProps<{ feed: ChecklistState; expanded: boolean; executing: boolean }>();
const emit = defineEmits<{ 'update:expanded': [value: boolean] }>();
const { snapshot, error, loading, refresh } = props.feed;
const steps = computed(() => [...(snapshot.value?.steps ?? [])].sort((left, right) => left.seq - right.seq));
// 失败和跳过保留原状态，只统计已处理数量，避免把终态收口误报为全部成功。
const settled = computed(() => steps.value.filter(step => ['COMPLETED', 'FAILED', 'SKIPPED'].includes(step.status)).length);
function toggle() { emit('update:expanded', !props.expanded); if (!props.expanded) void refresh(); }
</script>

<template>
  <div v-if="snapshot || error" class="checklist-tasks">
    <button type="button" class="task-pill" data-testid="checklist-toggle" :aria-expanded="expanded"
      aria-controls="current-checklist-panel" :title="snapshot ? t('chat.checklist.progress', { settled, total: steps.length }) : error" @click="toggle">
      <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="2.5" width="15" height="15" rx="3"/><path d="m5.5 7 1 1 2-2m2.5 1H15m-9.5 6 1 1 2-2m2.5 1H15"/></svg>
      <span>{{ t('chat.checklist.title') }}</span>
      <span v-if="snapshot" aria-live="polite">{{ settled }}/{{ steps.length }}</span>
      <span v-if="error" :title="error">!</span>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path :d="expanded ? 'm5 7 5 5 5-5' : 'm5 12 5-5 5 5'"/></svg>
    </button>
    <section v-if="expanded" id="current-checklist-panel" class="task-panel" data-testid="checklist-panel"
      :aria-label="t('chat.checklist.title')">
      <header class="checklist-header">
        <span>{{ snapshot?.title || t('chat.checklist.title') }}</span>
        <span v-if="snapshot">{{ settled }}/{{ steps.length }}</span>
        <button type="button" :disabled="loading" :aria-label="t('common.refresh')" @click="refresh">↻</button>
        <button type="button" :aria-label="t('common.collapse')" @click="emit('update:expanded', false)">×</button>
      </header>
      <p v-if="error" role="alert" class="checklist-note">{{ error }}</p>
      <p v-if="snapshot?.status === 'UNFINISHED'" class="checklist-note">{{ t('chat.checklist.unfinished') }}</p>
      <ul class="checklist-steps">
        <li v-for="step in steps" :key="step.stepId" :data-status="step.status" class="checklist-step">
          <svg v-if="step.status === 'IN_PROGRESS' && snapshot?.status === 'ACTIVE' && executing" class="checklist-loading" viewBox="0 0 20 20"
            role="img" :aria-label="t('chat.checklist.status.IN_PROGRESS')" data-testid="checklist-loading">
            <path v-for="index in 8" :key="index" d="M10 2v3" :transform="`rotate(${index * 45} 10 10)`" :opacity="index / 8" />
          </svg>
          <svg v-else viewBox="0 0 20 20" aria-hidden="true">
            <path v-if="step.status === 'COMPLETED'" d="m4 10 4 4 8-8" />
            <path v-else-if="step.status === 'FAILED'" d="m5 5 10 10M5 15 15 5" />
            <path v-else-if="step.status === 'SKIPPED'" d="M4 10h12" />
            <circle v-else cx="10" cy="10" r="6.5" />
          </svg>
          <span class="checklist-content">{{ step.content }}</span>
          <span class="checklist-status">{{ snapshot?.status === 'UNFINISHED' && step.status === 'IN_PROGRESS'
            ? t('chat.checklist.unfinished') : step.status === 'IN_PROGRESS' && !executing
              ? t('chat.checklist.paused') : t(`chat.checklist.status.${step.status}`) }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
button { cursor: pointer; font: inherit; color: inherit; text-shadow: inherit; }
button:disabled { opacity: .5; cursor: wait; }
.checklist-header { display: flex; align-items: center; gap: 10px; color: var(--task-muted); margin-bottom: 12px; }
.checklist-header > span:first-child { flex: 1; min-width: 0; overflow-wrap: anywhere; color: var(--task-ink); }
.checklist-header button { border: 0; border-radius: 6px; background: transparent; width: 24px; height: 24px; }
.checklist-header button:hover { background: var(--task-hover); }
.checklist-steps { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.checklist-step { display: flex; gap: 10px; align-items: flex-start; min-height: 34px; padding: 6px 2px; color: var(--task-muted); }
.checklist-step[data-status='IN_PROGRESS'] { color: var(--task-ink); }
.checklist-step svg { flex: none; width: 18px; height: 18px; margin-top: 1px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; }
.checklist-content { flex: 1; min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; }
.checklist-status { flex: none; font-size: 12px; color: var(--task-muted); }
.checklist-note { margin: 6px 0 10px; overflow-wrap: anywhere; color: var(--task-muted); }
.checklist-loading { animation: checklist-spin .9s steps(8) infinite; }
@keyframes checklist-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .checklist-loading { animation: none; } }
</style>
