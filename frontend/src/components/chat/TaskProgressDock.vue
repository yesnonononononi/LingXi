<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue';
import type { BackgroundTasksState } from '../../views/chat/useBackgroundTasks';
import type { ChecklistState } from '../../views/chat/useChecklist';
import BackgroundTaskPanel from './BackgroundTaskPanel.vue';
import ChecklistPanel from './ChecklistPanel.vue';
import './taskProgress.css';

const props = defineProps<{ background: BackgroundTasksState; checklist: ChecklistState; isDark?: boolean; executing: boolean }>();
type Panel = 'background' | 'checklist';
const activePanel = ref<Panel | null>(null);
const dock = ref<HTMLElement>();
const order = ref<Panel[]>([]);
const backgroundVisible = computed(() => props.background.tasks.value.length > 0 || !!props.background.error.value);
const checklistVisible = computed(() => !!props.checklist.snapshot.value || !!props.checklist.error.value);
function close() { activePanel.value = null; }
function setExpanded(panel: Panel, expanded: boolean) { activePanel.value = expanded ? panel : null; }
watch([backgroundVisible, checklistVisible], ([background, checklist]) => {
  const visible = (panel: Panel) => panel === 'background' ? background : checklist;
  // 新出现的胶囊追加在右侧，已有入口不因异步回查而跳位。
  order.value = order.value.filter(visible);
  for (const panel of ['background', 'checklist'] as const) {
    if (visible(panel) && !order.value.includes(panel)) order.value.push(panel);
  }
  if (activePanel.value && !visible(activePanel.value)) close();
}, { immediate: true, flush: 'sync' });
watch(props.background.sessionId, () => { close(); order.value = []; }, { flush: 'sync' });
watch(() => props.checklist.snapshot.value?.checklistId, close);
watch(() => props.checklist.snapshot.value?.status, (status, previous) => {
  if (previous === 'ACTIVE' && status !== 'ACTIVE' && activePanel.value === 'checklist') close();
});
function onPointer(event: PointerEvent) { if (event.target instanceof Node && !dock.value?.contains(event.target)) close(); }
function onKey(event: KeyboardEvent) {
  if (event.key !== 'Escape' || !activePanel.value) return;
  const trigger = dock.value?.querySelector<HTMLButtonElement>(`[data-testid="${activePanel.value === 'background' ? 'background-task' : 'checklist'}-toggle"]`);
  close(); trigger?.focus();
}
onMounted(() => { document.addEventListener('pointerdown', onPointer); document.addEventListener('keydown', onKey); });
onScopeDispose(() => { document.removeEventListener('pointerdown', onPointer); document.removeEventListener('keydown', onKey); });
</script>

<template>
  <Transition name="task-dock" appear>
  <div v-if="backgroundVisible || checklistVisible" ref="dock" class="task-progress-dock task-progress-surface w-full max-w-lx-chat mx-auto px-4"
    :data-theme="isDark ? 'dark' : 'light'" data-testid="task-progress-dock">
    <TransitionGroup name="task-capsule" tag="div" class="task-progress-row" appear>
      <template v-for="panel in order" :key="panel">
        <BackgroundTaskPanel v-if="panel === 'background'" :feed="background" :is-dark="isDark" embedded
          :expanded="activePanel === 'background'" @update:expanded="setExpanded('background', $event)" />
        <ChecklistPanel v-else :feed="checklist" :executing="executing" :expanded="activePanel === 'checklist'"
          @update:expanded="setExpanded('checklist', $event)" />
      </template>
    </TransitionGroup>
  </div>
  </Transition>
</template>
