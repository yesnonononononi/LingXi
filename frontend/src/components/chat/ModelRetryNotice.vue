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
import { computed } from 'vue';
import type { ModelRetryLike } from '../../views/chat/modelRetryStatus';
import { resolveModelRetryText } from '../../views/chat/modelRetryStatus';

const props = defineProps<{
  retry: ModelRetryLike | null | undefined;
}>();

const text = computed(() => resolveModelRetryText(props.retry));
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

      <div class="flex items-center gap-1.5 text-xs text-lx-muted font-normal shrink-0">
        <svg class="w-3.5 h-3.5 opacity-80 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 7v5h-5M4 17v-5h5" />
          <path d="M6.1 7a7 7 0 0 1 11.55-2L20 8M4 16l2.35 3A7 7 0 0 0 17.9 17" />
        </svg>
        <span class="retry-notice-shimmer">{{ text }}</span>
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
</style>
