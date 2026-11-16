<script setup lang="ts">
import {computed} from 'vue';
import type {ChatInputContextUsageSlotProps} from '../../types/chatInputSlots';

/**
 * 胶囊上下文用量徽标（输入框扩展包演示）：
 * 严格遵循 ChatInputContextUsageSlotProps 契约，仅消费 --lx-* 语义变量（无 isDark 分支）。
 */
const props = defineProps<ChatInputContextUsageSlotProps>();

const shortLabel = computed(() => {
  if (!props.hasUsage || !props.contextUsageText) return 'CTX';
  const match = props.contextUsageText.match(/^(\d+(?:\.\d+)?%)/);
  return match ? match[1] : 'CTX';
});
</script>

<template>
  <div class="relative inline-flex items-center">
    <span
      :class="[
        'inline-flex items-center gap-1.5 h-6 px-2 rounded-full border text-lx-fs-2xs font-medium transition-colors',
        props.hasUsage
          ? 'border-lx-border bg-lx-surface text-lx-primary'
          : 'border-lx-border-faint bg-lx-surface-sunken text-lx-faint'
      ]"
    >
      <svg class="w-3.5 h-3.5 -rotate-90 shrink-0" viewBox="0 0 16 16" aria-hidden="true">
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          class="text-lx-border-subtle"
          stroke-width="1.8"
        />
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="currentColor"
          class="text-lx-accent transition-all duration-300"
          stroke-width="1.8"
          stroke-linecap="round"
          :stroke-dasharray="props.contextRingDash"
        />
      </svg>
      <span>{{ shortLabel }}</span>
    </span>

    <div
      v-if="props.tooltipVisible"
      role="tooltip"
      class="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2.5 py-1.5 rounded-lg border border-lx-border bg-lx-surface-elevated text-lx-fs-xs text-lx-primary whitespace-nowrap shadow-md z-50"
    >
      {{ props.contextUsageTip }}
    </div>
  </div>
</template>
