<script setup lang="ts">
import { t } from '../../i18n';
defineProps<{ status?: string; canPause: boolean; canResume: boolean; pausing: boolean; resuming: boolean;
  hasUnresolved: boolean; error: string }>();
const emit = defineEmits<{ (event: 'pause'): void; (event: 'resume'): void }>();
</script>

<template>
  <div v-if="status === 'RUNNING' || status === 'SUSPENDED' || error" class="w-full max-w-3xl px-4 mb-2 text-xs">
    <div v-if="status === 'RUNNING' || status === 'SUSPENDED'" class="flex items-center justify-between gap-3 rounded-xl border border-zinc-400/20 px-3 py-2">
      <span role="status" class="text-gray-500 dark:text-zinc-400">
        {{ status === 'SUSPENDED' ? (hasUnresolved ? t('chat.controls.waitingApproval') : t('chat.controls.paused')) : t('chat.controls.running') }}
      </span>
      <button v-if="status === 'RUNNING'" type="button" :disabled="!canPause" data-testid="pause-generation"
        class="rounded-lg border border-zinc-400/30 px-3 py-1 cursor-pointer disabled:opacity-50 disabled:cursor-wait"
        @click="emit('pause')">{{ pausing ? t('chat.controls.pausing') : t('chat.controls.pause') }}</button>
      <button v-if="status === 'SUSPENDED'" type="button" :disabled="!canResume" data-testid="resume-generation"
        class="rounded-lg bg-blue-600 text-white px-3 py-1 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        @click="emit('resume')">{{ resuming ? t('chat.controls.resuming') : t('chat.controls.resume') }}</button>
    </div>
    <p v-if="error" role="alert" class="mt-1 text-red-500">{{ error }}</p>
  </div>
</template>
