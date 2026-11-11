<script setup lang="ts">
/**
 * 输入框发送与取消按钮默认实现：
 * - 发送状态：统一为蓝色背景，白色箭头 (->) 向右。
 * - 取消状态：统一为红色边框，向内阴影，居中小方块（亮色模式为红色，暗色模式为白色以保证清晰辨识）。
 * - 去除弹弓手势拖拽、发射粒子、回弹及图标变形动画，采用利落的即时响应按钮。
 */
import {t} from '../../i18n';
import type {ChatInputSendButtonSlotProps} from '../../types/chatInputSlots';

defineOptions({ inheritAttrs: false });

const props = defineProps<ChatInputSendButtonSlotProps>();
</script>

<template>
  <button
    type="button"
    data-slot="send-button"
    :disabled="!props.armed"
    :aria-label="props.isSending ? t('chat.input.stop') : t('chat.input.send')"
    :title="props.isSending ? t('chat.input.stop') : t('chat.input.sendTip')"
    class="relative inline-flex items-center justify-center w-8 h-8 rounded-full outline-none select-none transition-colors duration-150 shrink-0 cursor-pointer disabled:cursor-not-allowed"
    :class="[
      props.isSending
        ? 'border border-red-500 bg-red-50/60 dark:bg-transparent shadow-[inset_0_1px_4px_rgba(239,68,68,0.4)] hover:bg-red-100 dark:hover:bg-red-500/10 active:scale-95'
        : props.armed
          ? 'bg-blue-600 hover:bg-blue-500 active:bg-blue-700 active:scale-95 text-white shadow-xs'
          : 'bg-blue-600/40 text-white/50 cursor-not-allowed'
    ]"
    @click="props.onSend"
  >
    <!-- 取消状态：小方块居中（亮色为红、暗色为白，确保在亮色浅白背景上清晰可见） -->
    <span
      v-if="props.isSending"
      class="w-2.5 h-2.5 rounded-[2px]"
      :class="props.isDark ? 'bg-white' : 'bg-red-500'"
      aria-hidden="true"
    />

    <!-- 发送状态：白色箭头(->)向右 -->
    <svg
      v-else
      viewBox="0 0 24 24"
      class="w-4 h-4 text-white"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  </button>
</template>
