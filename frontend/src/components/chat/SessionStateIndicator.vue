<script setup lang="ts">
import { computed } from 'vue';
import type { ChatSession } from '../../types/chat';
import { resolveSessionIndicator } from '../../utils/sessionIndicator';

const props = defineProps<{ session: ChatSession; active?: boolean }>();
const state = computed(() => resolveSessionIndicator(props.session, props.active));
const labels = { WAITING: '待确认', COMPLETED: '完成', FAILED: '失败', RUNNING: '正在运行' };
</script>

<template>
  <span v-if="state" class="session-state-indicator" :data-state="state" :title="labels[state]" role="img" :aria-label="labels[state]">
    <span v-if="state === 'RUNNING'" class="session-running-bars" aria-hidden="true"><i /><i /><i /></span>
    <span v-else class="session-state-dot" aria-hidden="true" />
  </span>
</template>

<style scoped>
.session-state-indicator { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; flex-shrink: 0; margin-left: auto; }
.session-state-dot { width: 7px; height: 7px; border-radius: 50%; background: #a1a1aa; }
[data-state="COMPLETED"] .session-state-dot { background: #22a351; }
[data-state="FAILED"] .session-state-dot { background: #ef3340; }
.session-running-bars { display: flex; gap: 2px; align-items: center; height: 14px; color: #4169ff; }
.session-running-bars i { width: 3px; height: 9px; border-radius: 2px; background: currentColor; animation: session-running 1s ease-in-out infinite; }
.session-running-bars i:nth-child(2) { height: 13px; opacity: .65; animation-delay: -.65s; }
.session-running-bars i:nth-child(3) { height: 7px; opacity: .35; animation-delay: -.3s; }
@keyframes session-running { 0%, 100% { transform: scaleY(.5); } 50% { transform: scaleY(1); } }
@media (prefers-reduced-motion: reduce) { .session-running-bars i { animation: none; } }
</style>
