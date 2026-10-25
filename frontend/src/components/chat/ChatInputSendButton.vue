<script setup lang="ts">
/**
 * 发送/停止按钮默认实现（原 `ChatInputArea.vue` 1657–1683 的 `SlingButton`，逐字搬家）。
 *
 * <p>外观参数（size / stroke / 力学 / 粒子 / axis / tap-sends）是**设计常量**，仍写在本组件的
 * 字面量里；只有 5 个状态色与 `armed` 从插槽 props 取 —— 它们随「发送中 / 可发 / 不可发」变化，
 * 由原组件统一裁决，替换实现不该自己再算一遍配色。</p>
 *
 * <p>只有一个 `onSend` 入口：发送与停止的分流发生在原组件（`onSendClick`），
 * 因此这里不存在"发送接一次、停止再接一次"的双触发可能。</p>
 */
import SlingButton from '../common/SlingButton.vue';
import MorphingSendIcon from '../common/MorphingSendIcon.vue';
import { t } from '../../i18n';
import type { ChatInputSendButtonSlotProps } from '../../types/chatInputSlots';

defineOptions({ inheritAttrs: false });

const props = defineProps<ChatInputSendButtonSlotProps>();
</script>

<template>
  <!-- Vue Bits 弹弓发送 / 停止按钮：支持拖拽弹射与点击发送，带发射粒子与弹力回弹 -->
  <SlingButton
    data-slot="send-button"
    :pad-color="props.colors.padColor"
    :icon-color="props.colors.iconColor"
    :accent-color="props.colors.accentColor"
    :well-color="props.colors.wellColor"
    :band-color="props.colors.bandColor"
    :size="32"
    :stroke-width="2"
    :arm-at="32"
    :max-pull="90"
    :launch-speed="2400"
    :recoil="0.2"
    :flight="80"
    :particles="12"
    :spread="60"
    axis="any"
    tap-sends
    :disabled="!props.armed"
    :aria-label="props.isSending ? t('chat.input.stop') : t('chat.input.send')"
    :title="props.isSending ? t('chat.input.stop') : t('chat.input.sendTip')"
    @send="props.onSend"
  >
    <MorphingSendIcon :is-sending="!!props.isSending" class="w-3.5 h-3.5" />
  </SlingButton>
</template>
