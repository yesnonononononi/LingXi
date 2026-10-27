<script setup lang="ts">
/**
 * 操作区（底部工具条）默认实现：把 `ChatMessageItem.vue` 原 553–596 的 5 个元素**逐字搬出来**，
 * 只搬容器内部内容 —— 外层 `<div>`、它的 class 与出现时机（`isMessageCompleted && isGroupTail !== false`）
 * 仍然归 `ChatMessageItem` 所有。这样消费者能替换工具条内容，却改不掉「什么时候出现」，
 * 也就不会出现「同一轮次双工具条」的回归。
 *
 * props 直接复用插槽契约类型，保证 slot props 与默认实现类型同源（不存在两份字段定义漂移）。
 * 本组件是多根（fragment，5 个兄弟元素）：若允许继承 attrs，Vue 会报警并可能把 class 落到错误的根上，
 * 因此显式 `inheritAttrs: false`，由上层容器统一控制排版类。
 */
import TokenUsagePopover from './TokenUsagePopover.vue';
import { t } from '../../i18n';
import type { ChatMessageActionsSlotProps } from '../../types/chatMessageSlots';

defineOptions({ inheritAttrs: false });

const props = defineProps<ChatMessageActionsSlotProps>();
</script>

<template>
  <!-- 复制图标 -->
  <button
    data-testid="message-copy"
    @click="props.copyContent"
    class="hover:text-zinc-600 dark:hover:text-zinc-200 transition p-0.5"
    :title="props.copied ? t('common.copied') : t('chat.message.copyAnswer')"
  >
    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
    </svg>
  </button>


  <!-- 执行状态（仅回答组有摘要时展示；进行中/失败/终态不同配色，失败附带原因全文 title） -->
  <!-- min-w-0 + 原因单独限宽：whitespace-nowrap 的 flex 子项默认按内容撑开，
       长异常串会把用量/耗时挤到下一行。压不下来就永远「底部状态栏被吃掉」。 -->
  <div v-if="props.execStatusMeta" class="flex min-w-0 flex-1 items-center gap-1 whitespace-nowrap" :title="props.execStatusMeta.errorReason">
    <span
      :class="[
        'w-1.5 h-1.5 rounded-full shrink-0',
        props.execStatusMeta.failed ? 'bg-red-500' : props.execStatusMeta.running ? 'bg-amber-400 lx-live-dot' : 'bg-zinc-500'
      ]"
    ></span>
    <span class="shrink-0" :class="props.execStatusMeta.failed ? (props.isDark ? 'text-red-400' : 'text-red-600') : ''">{{ props.execStatusMeta.text }}</span>
    <span
      v-if="props.execStatusMeta.errorReason"
      class="min-w-0 max-w-[16rem] truncate cursor-help text-red-500/90"
      :title="props.execStatusMeta.errorReason"
    >{{ t('common.colon') }}{{ props.execStatusMeta.errorReason }}</span>
  </div>

  <TokenUsagePopover v-if="props.showExecutionMeta" class="shrink-0" :usage="props.tokenUsage" :model-name="props.turn?.modelName"
    :model-provider="props.turn?.modelProvider" :is-dark="props.isDark" />

  <!-- 耗时统计（组尾展示一次；标注「总历时包含等待时间」） -->
  <div v-if="props.showExecutionMeta" class="flex shrink-0 whitespace-nowrap items-center gap-1">
    <svg class="w-3.5 h-3.5 opacity-80" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
    <span>{{ t('chat.message.usageDuration', { duration: props.displayDuration }) }}</span>
  </div>

  <!-- 时间戳 -->
  <span class="shrink-0">{{ props.displayTime }}</span>
</template>
