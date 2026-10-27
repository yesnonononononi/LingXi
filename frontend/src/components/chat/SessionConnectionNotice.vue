<script setup lang="ts">
import type { StreamHealthState } from '../../views/chat/sessionEventStream';
import { t } from '../../i18n';

defineProps<{ state?: StreamHealthState }>();
const emit = defineEmits<{ (event: 'reconnect'): void }>();
</script>

<template>
  <div v-if="state === 'RECONNECTING' || state === 'UNHEALTHY' || state === 'FAILED'"
    data-testid="session-connection-notice" role="status" aria-live="polite"
    class="w-full shrink-0 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-600 dark:text-amber-400 flex items-center gap-3">
    <span class="flex-1">{{ t(state === 'FAILED' ? 'chat.view.disconnected' : 'chat.view.reconnecting') }}</span>
    <button v-if="state === 'FAILED'" type="button"
      class="shrink-0 rounded-md border border-current px-2 py-1 text-xs opacity-80 hover:opacity-100 transition-opacity"
      @click="emit('reconnect')">{{ t('chat.view.reconnect') }}</button>
  </div>
</template>
