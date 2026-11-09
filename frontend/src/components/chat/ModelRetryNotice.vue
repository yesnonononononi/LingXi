<script setup lang="ts">
/**
 * 「模型失败、等待重试」提示行 —— 唯一实现，根会话气泡与子会话详情共用。
 *
 * <p>为什么要抽成组件：这条提示原来只长在 `ChatMessageItem` 里，子会话详情抽屉
 * 因为是自带模板的历史视图，重试期间什么也不显示。抽出来后两个渲染点共享同一份
 * 结构与文案，避免再出现「一处有、一处没有」。</p>
 *
 * <p>它只是实时提示，不参与任何终态判定（见 `ModelRetryState` 注释）；
 * 文案与单位换算全部委托给 `views/chat/modelRetryStatus.ts`。</p>
 */
import {computed, ref, watch} from 'vue';
import type {ModelRetryState} from '../../types/chat';
import {resolveModelRetryText} from '../../views/chat/modelRetryStatus';

const props = defineProps<{
  retry: ModelRetryState | null | undefined;
}>();

const remainingSeconds = ref(0);
const text = computed(() => resolveModelRetryText(props.retry, remainingSeconds.value * 1000));
const countdownStyle = computed(() => {
  const retry = props.retry;
  if (!retry) return;
  // 后打开的详情从已过去的进度接着播。
  const elapsedMs = Math.max(0, performance.now() - (retry.retryAt - retry.retryDelay));
  return {animationDuration: `${retry.retryDelay}ms`, animationDelay: `${-elapsedMs}ms`};
});

watch(() => props.retry, (retry, _, onCleanup) => {
  remainingSeconds.value = 0;
  if (!retry || !Number.isFinite(retry.retryAt) || retry.retryDelay <= 0) return;

  let timerId: number | undefined;
  const update = () => {
    const remainingMs = Math.max(0, retry.retryAt - performance.now());
    remainingSeconds.value = Math.ceil(remainingMs / 1000);
    if (remainingSeconds.value > 0) {
      timerId = window.setTimeout(update, remainingMs - (remainingSeconds.value - 1) * 1000);
    }
  };
  update();
  onCleanup(() => window.clearTimeout(timerId));
}, {immediate: true});
</script>

<template>
  <transition name="retry-notice-fade" appear>
    <div
      v-if="text"
      role="status"
      aria-live="polite"
      :title="text"
      class="retry-notice w-full my-3 py-1 flex items-center gap-3 select-none"
    >
      <!-- 两侧等分剩余空间，保证提示始终居中。 -->
      <div class="flex-1 min-w-0 h-[1px] bg-zinc-200 dark:bg-zinc-700/60"></div>

      <div class="relative flex items-center gap-1.5 min-w-0 text-xs text-lx-muted font-normal">
        <svg class="w-3.5 h-3.5 opacity-80 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 7v5h-5M4 17v-5h5" />
          <path d="M6.1 7a7 7 0 0 1 11.55-2L20 8M4 16l2.35 3A7 7 0 0 0 17.9 17" />
        </svg>
        <span class="retry-notice-shimmer tabular-nums">{{ text }}</span>
        <span v-if="retry && remainingSeconds > 0" :key="retry.responseId" aria-hidden="true"
          class="retry-notice-countdown absolute inset-x-0 top-full mt-0.5 h-px bg-current" :style="countdownStyle"></span>
      </div>

      <div class="flex-1 min-w-0 h-[1px] bg-zinc-200 dark:bg-zinc-700/60"></div>
    </div>
  </transition>
</template>

<style scoped>
.retry-notice-fade-enter-active,
.retry-notice-fade-leave-active {
  transition: opacity 0.35s ease, transform 0.35s ease;
}
.retry-notice-fade-enter-from,
.retry-notice-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

/* 高亮在循环两端都位于文字外，复位时不会闪回或滞留在右侧。 */
.retry-notice-shimmer {
  background: linear-gradient(
    90deg,
    var(--lx-text-muted) 40%,
    var(--lx-text-primary) 50%,
    var(--lx-text-muted) 60%
  );
  background-size: 300% 100%;
  background-clip: text;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: retry-notice-shimmer 2.2s linear infinite;
}

@keyframes retry-notice-shimmer {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: 0% 0;
  }
}

.retry-notice-countdown {
  transform-origin: left;
  animation-name: retry-notice-countdown;
  animation-timing-function: linear;
  animation-fill-mode: both;
}

@keyframes retry-notice-countdown {
  from { transform: scaleX(1); }
  to { transform: scaleX(0); }
}

@media (prefers-reduced-motion: reduce) {
  .retry-notice-countdown { display: none; }
  .retry-notice-fade-enter-active,
  .retry-notice-fade-leave-active { transition: none; }
  .retry-notice-shimmer {
    animation: none;
    background: none;
    -webkit-text-fill-color: currentColor;
  }
}
</style>
