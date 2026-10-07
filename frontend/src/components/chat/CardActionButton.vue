<script setup lang="ts">
import { computed } from 'vue';

/**
 * 卡片主 / 次操作按钮的统一实现。
 *
 * <p>为什么统一：此前三类卡片的主操作是三套实现（WebGL 流光 / 实心绿 / 实心蓝），
 * 尺寸、圆角、focus-visible、disabled 各不相同，同一时间线上的主操作看起来不像同一控件家族。
 * 这里收成同一 size / 圆角 / focus-visible / disabled 规范，语义色由 `tone` 决定
 * （批准/执行=emerald，作答提交=blue，拒绝=danger，中性=neutral）。</p>
 */
const props = withDefaults(defineProps<{
  /** 语义色 */
  tone?: 'emerald' | 'blue' | 'danger' | 'neutral';
  /** 实心（主操作）/ 描边（次操作） */
  variant?: 'solid' | 'outline';
  disabled?: boolean;
  loading?: boolean;
  isDark?: boolean;
  /** 原生 button type */
  nativeType?: 'button' | 'submit';
}>(), {
  tone: 'emerald',
  variant: 'solid',
  disabled: false,
  loading: false,
  isDark: false,
  nativeType: 'button'
});

const classes = computed(() => {
  const base = 'inline-flex items-center justify-center gap-1.5 rounded-xl text-xs font-medium px-4 py-1.5 transition cursor-pointer select-none'
    + ' focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1'
    + ' disabled:opacity-50 disabled:cursor-not-allowed';
  const ring = {
    emerald: 'focus-visible:ring-emerald-500/50',
    blue: 'focus-visible:ring-blue-500/50',
    danger: 'focus-visible:ring-red-500/50',
    neutral: 'focus-visible:ring-gray-400/50'
  }[props.tone];

  if (props.variant === 'outline') {
    const outline = {
      emerald: props.isDark
        ? 'border border-emerald-900/60 text-emerald-400 hover:bg-emerald-950/40 hover:border-emerald-800'
        : 'border border-emerald-200 text-emerald-700 hover:bg-emerald-50 hover:border-emerald-300',
      blue: props.isDark
        ? 'border border-blue-900/60 text-blue-400 hover:bg-blue-950/40 hover:border-blue-800'
        : 'border border-blue-200 text-blue-700 hover:bg-blue-50 hover:border-blue-300',
      danger: props.isDark
        ? 'border border-red-900/60 text-red-400 hover:bg-red-950/40 hover:border-red-800'
        : 'border border-red-200 text-red-600 hover:bg-red-50 hover:border-red-300',
      neutral: props.isDark
        ? 'border border-gray-700 text-gray-300 hover:bg-gray-800'
        : 'border border-gray-200 text-gray-700 hover:bg-gray-50'
    }[props.tone];
    return [base, outline, ring];
  }

  const solid = {
    emerald: 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-xs',
    blue: 'bg-blue-600 hover:bg-blue-500 text-white shadow-xs',
    danger: 'bg-red-600 hover:bg-red-500 text-white shadow-xs',
    neutral: props.isDark ? 'bg-gray-700 hover:bg-gray-600 text-white shadow-xs' : 'bg-gray-800 hover:bg-gray-700 text-white shadow-xs'
  }[props.tone];
  return [base, solid, ring];
});
</script>

<template>
  <button :type="nativeType" :disabled="disabled || loading" :class="classes">
    <svg v-if="loading" class="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
    </svg>
    <slot v-else name="icon" />
    <span><slot /></span>
  </button>
</template>
