<script setup lang="ts">
/**
 * 输入框发送与取消按钮默认实现：
 * - 发送状态：统一为蓝色背景，白色箭头 (->) 向右。
 * - 取消状态：统一为红色边框，向内阴影，白色小方块居中。
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
        ? 'border border-red-500 bg-transparent shadow-[inset_0_1px_4px_rgba(239,68,68,0.4)] hover:bg-red-500/10 active:scale-95'
        : props.armed
          ? 'bg-blue-600 hover:bg-blue-500 active:bg-blue-700 active:scale-95 text-white shadow-xs'
          : 'bg-blue-600/40 text-white/50 cursor-not-allowed'
    ]"
    @click="props.onSend"
  >
    <!-- 取消状态：白色小方块居中 -->
    <span
      v-if="props.isSending"
      class="w-2.5 h-2.5 bg-white rounded-[2px]"
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
