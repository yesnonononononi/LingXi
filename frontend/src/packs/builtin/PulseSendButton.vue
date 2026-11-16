<script setup lang="ts">
import type {ChatInputSendButtonSlotProps} from '../../types/chatInputSlots';

/**
 * 脉冲胶囊发送/停止按钮（组件增强包演示）：
 * 严格遵循 ChatInputSendButtonSlotProps 契约，仅消费 --lx-* 语义变量（无 isDark 分支）。
 */
const props = defineProps<ChatInputSendButtonSlotProps>();
</script>

<template>
  <button
    type="button"
    :disabled="!props.armed"
    :aria-label="props.isSending ? 'Stop' : 'Send'"
    @click="props.onSend"
    :class="[
      'lx-pack-pulse-btn relative flex items-center justify-center w-8 h-8 rounded-full transition-all duration-200 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed',
      props.isSending
        ? 'border border-lx-danger text-lx-danger bg-lx-danger-soft'
        : 'bg-lx-accent text-lx-on-accent hover:bg-lx-accent-hover shadow-sm'
    ]"
  >
    <span v-if="props.isSending" class="w-2.5 h-2.5 rounded-[2px] bg-current" />
    <svg v-else class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14M12 5l7 7-7 7" />
    </svg>
  </button>
</template>

<style scoped>
.lx-pack-pulse-btn:not(:disabled):hover {
  transform: translateY(-1px);
}
</style>
