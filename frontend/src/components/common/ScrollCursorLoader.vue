<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';

const props = withDefaults(defineProps<{
  /** 是否还有更多历史数据可以加载 */
  hasMore?: boolean;
  /** 是否正在加载中 */
  loading?: boolean;
  /** 触发滚动的方向：top 表示滚动到顶部加载（聊天历史常用），bottom 表示滚动到底部加载 */
  direction?: 'top' | 'bottom';
  /** 触发加载的距离阈值（单位 px），默认 60 */
  threshold?: number;
  /** 滚动到顶部加载时是否自动保持滚动位置，避免视口跳动 */
  preserveScroll?: boolean;
  /** 加载提示文案 */
  loadingText?: string;
  /** 没有更多数据时的提示文案（默认不显示） */
  finishedText?: string;
  /** 是否展示已加载全部的完成提示 */
  showFinished?: boolean;
  /** 是否禁用监听 */
  disabled?: boolean;
}>(), {
  hasMore: false,
  loading: false,
  direction: 'top',
  threshold: 60,
  preserveScroll: true,
  loadingText: '正在加载历史消息...',
  finishedText: '已加载全部消息',
  showFinished: false,
  disabled: false
});

const emit = defineEmits<{
  (e: 'load'): void;
  (e: 'scroll', event: Event): void;
}>();

const containerRef = ref<HTMLDivElement | null>(null);
const contentRef = ref<HTMLDivElement | null>(null);

// 滚动位置补偿状态记录
const prevScrollHeight = ref(0);
const prevScrollTop = ref(0);
const isAwaitingPrepend = ref(false);

const handleScroll = (event: Event) => {
  emit('scroll', event);
  if (props.disabled || props.loading || !props.hasMore) return;

  const el = containerRef.value;
  if (!el) return;

  if (props.direction === 'top') {
    if (el.scrollTop <= props.threshold) {
      triggerLoad();
    }
  } else {
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceToBottom <= props.threshold) {
      triggerLoad();
    }
  }
};

const triggerLoad = () => {
  if (props.loading || !props.hasMore || props.disabled) return;

  const el = containerRef.value;
  if (el && props.preserveScroll && props.direction === 'top') {
    prevScrollHeight.value = el.scrollHeight;
    prevScrollTop.value = el.scrollTop;
    isAwaitingPrepend.value = true;
  }

  emit('load');
};

/**
 * 前置插入历史记录前调用：记录当前的 scrollHeight 与 scrollTop
 */
const beforePrepend = () => {
  const el = containerRef.value;
  if (!el) return;
  prevScrollHeight.value = el.scrollHeight;
  prevScrollTop.value = el.scrollTop;
  isAwaitingPrepend.value = true;
};

/**
 * 前置插入历史记录后（在 nextTick 中）立即调用：补偿高度差，消除闪屏
 */
const afterPrepend = () => {
  const el = containerRef.value;
  if (!el) return;
  const newScrollHeight = el.scrollHeight;
  const heightDiff = newScrollHeight - prevScrollHeight.value;
  if (heightDiff > 0) {
    el.scrollTop = prevScrollTop.value + heightDiff;
  }
  isAwaitingPrepend.value = false;
};

// 监听加载完成，利用高度差补偿 scrollTop，防止视口发生跳动
const restoreScrollPosition = () => {
  afterPrepend();
};

watch(() => props.loading, (newLoading, oldLoading) => {
  if (oldLoading === true && newLoading === false && isAwaitingPrepend.value) {
    nextTick(() => {
      restoreScrollPosition();
    });
  }
});

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  if (typeof ResizeObserver !== 'undefined' && contentRef.value) {
    resizeObserver = new ResizeObserver(() => {
      if (isAwaitingPrepend.value) {
        restoreScrollPosition();
      }
    });
    resizeObserver.observe(contentRef.value);
  }
});

onBeforeUnmount(() => {
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
});

const scrollToBottom = (behavior: ScrollBehavior = 'auto') => {
  const el = containerRef.value;
  if (el) {
    el.scrollTo({
      top: el.scrollHeight,
      behavior
    });
  }
};

const scrollToTop = (behavior: ScrollBehavior = 'auto') => {
  const el = containerRef.value;
  if (el) {
    el.scrollTo({
      top: 0,
      behavior
    });
  }
};

defineExpose({
  scrollToBottom,
  scrollToTop,
  beforePrepend,
  afterPrepend,
  restoreScrollPosition,
  getContainer: () => containerRef.value,
  containerRef
});
</script>

<template>
  <div
    ref="containerRef"
    class="relative w-full h-full overflow-y-auto"
    style="overflow-anchor: auto;"
    @scroll="handleScroll"
  >
    <!-- 顶部历史加载动画条：平滑过渡展开/收起，带微光圈与平滑指示动画 -->
    <transition
      enter-active-class="transition-all duration-300 ease-out"
      enter-from-class="opacity-0 -translate-y-2 max-h-0"
      enter-to-class="opacity-100 translate-y-0 max-h-16"
      leave-active-class="transition-all duration-250 ease-in"
      leave-from-class="opacity-100 translate-y-0 max-h-16"
      leave-to-class="opacity-0 -translate-y-2 max-h-0"
    >
      <div
        v-if="direction === 'top' && loading"
        class="w-full flex items-center justify-center py-2.5 overflow-hidden shrink-0 select-none"
        style="overflow-anchor: none;"
      >
        <slot name="loading">
          <div class="flex items-center gap-2.5 px-4 py-1.5 rounded-full bg-blue-50/95 dark:bg-[#162032]/95 border border-blue-200/80 dark:border-blue-700/60 text-blue-600 dark:text-blue-400 shadow-xs backdrop-blur">
            <!-- 灵动微波光/微跳动点 -->
            <span class="relative flex h-2.5 w-2.5">
              <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
              <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-blue-500"></span>
            </span>
            <!-- 旋转加载环 -->
            <svg class="animate-spin h-3.5 w-3.5 text-blue-500" viewBox="0 0 24 24" fill="none">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
            </svg>
            <span class="text-xs font-medium tracking-wide">{{ loadingText }}</span>
          </div>
        </slot>
      </div>
    </transition>

    <!-- 顶部加载完毕提示 -->
    <div
      v-if="direction === 'top' && !loading && !hasMore && showFinished"
      class="w-full flex items-center justify-center py-2 text-[11px] text-gray-400 dark:text-gray-500 select-none shrink-0"
    >
      <slot name="finished">
        <span>{{ finishedText }}</span>
      </slot>
    </div>

    <!-- 内容插槽 -->
    <div ref="contentRef" class="w-full min-h-full">
      <slot />
    </div>

    <!-- 底部加载指示器（方向为 bottom 时） -->
    <div
      v-if="direction === 'bottom' && loading"
      class="w-full flex items-center justify-center py-2.5 text-xs text-blue-500 gap-2 select-none shrink-0"
    >
      <slot name="loading">
        <svg class="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
        </svg>
        <span class="text-xs font-medium">{{ loadingText }}</span>
      </slot>
    </div>

    <!-- 底部加载完毕提示 -->
    <div
      v-else-if="direction === 'bottom' && !hasMore && showFinished"
      class="w-full flex items-center justify-center py-2 text-[11px] text-gray-400 dark:text-gray-500 select-none shrink-0"
    >
      <slot name="finished">
        <span>{{ finishedText }}</span>
      </slot>
    </div>
  </div>
</template>
