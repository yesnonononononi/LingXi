<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch, type CSSProperties } from 'vue';
import type { SessionVO } from '../../types/chat';
import { useChatSessionStore } from '../../stores/chatSessionStore';
import { resolveContextUsageText, resolveContextRingDash } from '../../views/chat/contextUsagePresentation';
import ChatInputContextUsage from './ChatInputContextUsage.vue';

const props = defineProps<{ session?: SessionVO | null; isDark?: boolean }>();
const store = useChatSessionStore();
const triggerRef = ref<HTMLButtonElement | null>(null);
const tooltipVisible = ref(false);
const tooltipStyle = ref<CSSProperties>({ left: '0px', top: '0px', zIndex: 60 });
const tooltipId = useId();
const usage = computed(() => {
  const session = props.session;
  const live = session ? store.getContextUsage(session.id) : undefined;
  if (live?.tokenCount != null) return {
    usedTokens: live.tokenCount, maxTokens: live.maxTokens, ratio: live.ratio, phase: live.phase, band: live.band,
  };
  return {
    usedTokens: session?.contextTokenCount, maxTokens: session?.contextMaxTokens, ratio: session?.contextRatio,
  };
});
const text = computed(() => resolveContextUsageText(usage.value));
const ringDash = computed(() => resolveContextRingDash(usage.value));

const positionTooltip = async () => {
  const bounds = triggerRef.value?.getBoundingClientRect();
  const tooltip = document.getElementById(tooltipId);
  if (!bounds || !tooltip) return;
  // 用量变化后重新量自然宽度，不能沿用上一条文案的固定宽度。
  const previousStyle = { width: tooltip.style.width, maxWidth: tooltip.style.maxWidth, whiteSpace: tooltip.style.whiteSpace };
  Object.assign(tooltip.style, { width: 'max-content', maxWidth: 'none', whiteSpace: 'nowrap' });
  const naturalWidth = Math.ceil(tooltip.getBoundingClientRect().width) + 1;
  Object.assign(tooltip.style, previousStyle);
  const width = Math.min(naturalWidth, window.innerWidth - 16);
  const left = Math.min(Math.max(bounds.left + bounds.width / 2, width / 2 + 8), window.innerWidth - width / 2 - 8);
  tooltipStyle.value = { left: `${left}px`, top: `${bounds.bottom + 8}px`, width: `${width}px`,
    zIndex: 60, maxWidth: 'calc(100vw - 16px)', whiteSpace: naturalWidth > width ? 'normal' : 'nowrap' };
  await nextTick();
  if (!tooltipVisible.value || !triggerRef.value) return;
  const height = tooltip.offsetHeight;
  const top = bounds.bottom + height + 8 <= window.innerHeight ? bounds.bottom + 8 : Math.max(8, bounds.top - height - 8);
  tooltipStyle.value = { ...tooltipStyle.value, top: `${top}px` };
};

const closeTooltip = () => {
  tooltipVisible.value = false;
  window.removeEventListener('resize', closeTooltip);
  window.removeEventListener('scroll', handleViewportScroll, true);
};

const handleViewportScroll = (event: Event) => {
  if (event.target instanceof Element && !event.target.contains(triggerRef.value)) return;
  closeTooltip();
};

const openTooltip = async () => {
  if (!text.value) return;
  tooltipVisible.value = true;
  await nextTick();
  if (!tooltipVisible.value || !triggerRef.value) return;
  await positionTooltip();
  if (!tooltipVisible.value || !triggerRef.value) return;
  // 标题在裁剪容器内，浮层挂到页面后必须跟随视口变化收起。
  window.addEventListener('resize', closeTooltip);
  window.addEventListener('scroll', handleViewportScroll, true);
};

watch(() => props.session?.id, closeTooltip);
watch(text, async () => {
  if (!text.value) closeTooltip();
  else if (tooltipVisible.value) { await nextTick(); await positionTooltip(); }
});
onBeforeUnmount(closeTooltip);
</script>

<template>
  <button v-if="text" ref="triggerRef" type="button" data-testid="session-context-usage"
    class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded cursor-help text-lx-muted focus-visible:outline focus-visible:outline-1"
    :aria-label="text" :aria-describedby="tooltipVisible ? tooltipId : undefined"
    @mouseenter="openTooltip" @mouseleave="closeTooltip" @focus="openTooltip" @blur="closeTooltip" @keydown.esc="closeTooltip">
    <ChatInputContextUsage :isDark="!!isDark" :contextUsageText="text" :contextRingDash="ringDash"
      :tooltipVisible="tooltipVisible" :tooltipId="tooltipId" :tooltipStyle="tooltipStyle" />
  </button>
</template>
