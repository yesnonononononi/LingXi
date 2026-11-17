<script setup lang="ts">
import {computed} from 'vue';

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
  const ring = 'focus-visible:ring-zinc-400/50';

  if (props.variant === 'outline') {
    const outline = {
      emerald: props.isDark
        ? 'border border-white/15 text-zinc-200 hover:bg-white/10 hover:border-white/30'
        : 'border border-zinc-200 text-zinc-700 hover:bg-zinc-50 hover:border-zinc-300',
      blue: props.isDark
        ? 'border border-white/15 text-zinc-200 hover:bg-white/10 hover:border-white/30'
        : 'border border-zinc-200 text-zinc-700 hover:bg-zinc-50 hover:border-zinc-300',
      danger: props.isDark
        ? 'border border-white/12 text-zinc-300 hover:border-red-900/60 hover:bg-red-950/30 hover:text-red-400'
        : 'border border-zinc-200 text-zinc-600 hover:border-red-200 hover:bg-red-50/70 hover:text-red-600',
      neutral: props.isDark
        ? 'border border-white/15 text-zinc-300 hover:bg-white/[0.08] hover:border-white/25'
        : 'border border-zinc-200 text-zinc-700 hover:bg-zinc-50 hover:border-zinc-300'
    }[props.tone];
    return [base, outline, ring];
  }

  const monochromeSolid = props.isDark
    ? 'bg-white hover:bg-zinc-200 text-zinc-950 shadow-xs'
    : 'bg-zinc-900 hover:bg-zinc-800 text-white shadow-xs';
  const solid = {
    emerald: monochromeSolid,
    blue: monochromeSolid,
    danger: 'bg-red-600 hover:bg-red-500 text-white shadow-xs',
    neutral: monochromeSolid
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
