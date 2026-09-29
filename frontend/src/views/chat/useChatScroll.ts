import { ref, nextTick, onBeforeUnmount } from 'vue';
import type { Ref } from 'vue';

const AUTO_SCROLL_THRESHOLD = 96; // px，距底部小于此值视为在底部

export interface ChatScrollOptions {
  messagesContainerRef: Ref<any>;
}

export function useChatScroll(options: ChatScrollOptions) {
  const { messagesContainerRef } = options;

  const shouldAutoScroll = ref(true); // 是否处于自动跟随滚动模式
  const isNearBottom = ref(true); // 视口是否接近底部
  let isProgrammaticScrolling = false; // 是否为程序触发的滚动，避免误识别为用户主动上滑
  let programmaticScrollTimer: number | null = null;
  let scrollRafId: number | null = null;

  const getScrollElement = (): HTMLElement | null => {
    if (!messagesContainerRef.value) return null;
    if ('getContainer' in messagesContainerRef.value && typeof messagesContainerRef.value.getContainer === 'function') {
      return messagesContainerRef.value.getContainer();
    }
    return (messagesContainerRef.value as any)?.containerRef
      || (messagesContainerRef.value as any)?.$el
      || null;
  };

  const updateScrollMetrics = () => {
    const el = getScrollElement();
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottom.value = distanceToBottom <= AUTO_SCROLL_THRESHOLD;
  };

  const handleMessagesScroll = (event: Event) => {
    const el = (event.target as HTMLElement) || getScrollElement();
    if (!el) return;

    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isNearBottom.value = distanceToBottom <= AUTO_SCROLL_THRESHOLD;

    // 如果处于代码触发的平滑滚动期间，不修改用户意图标记
    if (isProgrammaticScrolling) return;

    // 用户主动向上滑动，超过阈值则暂停自动吸底
    if (distanceToBottom > AUTO_SCROLL_THRESHOLD) {
      shouldAutoScroll.value = false;
    } else if (distanceToBottom <= 48) {
      // 用户手动滑回最底部附近，恢复自动吸底
      shouldAutoScroll.value = true;
    }
  };

  // 监听滚轮：向上滚动立刻切断自动吸底；向下滚动到接近底部时恢复吸底
  const handleMessagesWheel = (event: WheelEvent) => {
    if (event.deltaY < 0) {
      shouldAutoScroll.value = false;
      isProgrammaticScrolling = false;
      isNearBottom.value = false;
    } else if (event.deltaY > 0) {
      const el = getScrollElement();
      if (el) {
        const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceToBottom <= AUTO_SCROLL_THRESHOLD) {
          shouldAutoScroll.value = true;
          isNearBottom.value = true;
        }
      }
    }
  };

  // 监听触屏拖动：向下滑动（视口内容向上滚）立即切断自动吸底；向上滑动（视口向底部滚）且接近底部时恢复吸底
  let touchStartY = 0;
  const handleTouchStart = (event: TouchEvent) => {
    touchStartY = event.touches[0]?.clientY ?? 0;
  };
  const handleTouchMove = (event: TouchEvent) => {
    const currentY = event.touches[0]?.clientY ?? 0;
    if (currentY > touchStartY + 10) {
      // 手指下滑，查看上方历史，立刻切断吸底
      shouldAutoScroll.value = false;
      isProgrammaticScrolling = false;
      isNearBottom.value = false;
    } else if (currentY < touchStartY - 10) {
      // 手指上滑，向底部靠拢
      const el = getScrollElement();
      if (el) {
        const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceToBottom <= AUTO_SCROLL_THRESHOLD) {
          shouldAutoScroll.value = true;
          isNearBottom.value = true;
        }
      }
    }
  };

  const performScrollToBottom = (behavior: ScrollBehavior = 'auto') => {
    const el = getScrollElement();
    if (!el) return;

    isProgrammaticScrolling = true;
    if (programmaticScrollTimer !== null) {
      window.clearTimeout(programmaticScrollTimer);
      programmaticScrollTimer = null;
    }

    if (messagesContainerRef.value && 'scrollToBottom' in messagesContainerRef.value) {
      messagesContainerRef.value.scrollToBottom(behavior);
    } else {
      el.scrollTo({ top: el.scrollHeight, behavior });
    }

    isNearBottom.value = true;

    const duration = behavior === 'smooth' ? 350 : 50;
    programmaticScrollTimer = window.setTimeout(() => {
      isProgrammaticScrolling = false;
      programmaticScrollTimer = null;
      updateScrollMetrics();
    }, duration);
  };

  /** 强制滚动到底部：用户主动发消息、点击“回到底部”或切换会话时使用 */
  const scrollToBottomForce = (behavior: ScrollBehavior = 'auto') => {
    shouldAutoScroll.value = true;
    nextTick(() => {
      performScrollToBottom(behavior);
      if (scrollRafId !== null) cancelAnimationFrame(scrollRafId);
      scrollRafId = requestAnimationFrame(() => {
        scrollRafId = null;
        performScrollToBottom(behavior);
      });
    });
  };

  /** 条件吸底：仅在处于“自动跟随”模式时才滚动，绝不打扰用户正在查看的内容 */
  const scrollToBottomIfAuto = () => {
    if (!shouldAutoScroll.value) {
      updateScrollMetrics();
      return;
    }
    nextTick(() => {
      if (!shouldAutoScroll.value) return;
      performScrollToBottom('auto');
      if (scrollRafId !== null) cancelAnimationFrame(scrollRafId);
      scrollRafId = requestAnimationFrame(() => {
        scrollRafId = null;
        if (shouldAutoScroll.value) {
          performScrollToBottom('auto');
        }
      });
    });
  };

  // 保持 scrollToBottom 向后兼容别名，默认走条件吸底
  const scrollToBottom = (force = false) => {
    if (force) {
      scrollToBottomForce();
    } else {
      scrollToBottomIfAuto();
    }
  };

  const handleScrollToBottomClick = () => {
    scrollToBottomForce('smooth');
  };

  const cleanupScroll = () => {
    if (programmaticScrollTimer !== null) {
      window.clearTimeout(programmaticScrollTimer);
      programmaticScrollTimer = null;
    }
    if (scrollRafId !== null) {
      cancelAnimationFrame(scrollRafId);
      scrollRafId = null;
    }
  };

  onBeforeUnmount(() => {
    cleanupScroll();
  });

  return {
    shouldAutoScroll,
    isNearBottom,
    getScrollElement,
    updateScrollMetrics,
    handleMessagesScroll,
    handleMessagesWheel,
    handleTouchStart,
    handleTouchMove,
    performScrollToBottom,
    scrollToBottomForce,
    scrollToBottomIfAuto,
    scrollToBottom,
    handleScrollToBottomClick,
    cleanupScroll,
  };
}
