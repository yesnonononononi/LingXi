<script setup lang="ts">
import type {SubSessionVO} from '../../types/chat';
import {t} from '../../i18n';
import SessionStateIndicator from './SessionStateIndicator.vue';

defineProps<{ sessions?: SubSessionVO[]; activeId?: string | null }>();
const emit = defineEmits<{ select: [id: string] }>();
</script>

<template>
  <div v-if="sessions?.length" class="ml-5" data-testid="sidebar-sub-sessions">
    <div v-for="sub in sessions" :key="sub.id" class="sub-session-branch relative pl-5">
      <button type="button" :data-active="String(sub.id) === activeId ? '' : undefined"
        :aria-current="String(sub.id) === activeId ? 'true' : undefined"
        class="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-xs text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 data-[active]:bg-blue-50 data-[active]:text-blue-600"
        @click="emit('select', String(sub.id))">
        <svg class="h-3.5 w-3.5 shrink-0 opacity-60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
        </svg>
        <span class="min-w-0 flex-1 truncate" :title="sub.name || t('chat.subSessions.fallbackName')">{{ sub.name || (sub.agentId ? `Agent #${sub.agentId}` : t('chat.subSessions.fallbackName')) }}</span>
        <SessionStateIndicator :session="sub" :active="String(sub.id) === activeId" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.sub-session-branch::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; border-left: 1.2px solid #e4e4e7; }
.sub-session-branch:last-child::before { bottom: 16px; }
.sub-session-branch::after { content: ''; position: absolute; left: 0; top: 0; width: 16px; height: 16px; border-left: 1.2px solid #e4e4e7; border-bottom: 1.2px solid #e4e4e7; border-bottom-left-radius: 8px; }
</style>
