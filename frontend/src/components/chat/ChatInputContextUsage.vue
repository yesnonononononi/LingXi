<script setup lang="ts">
/**
 * 上下文用量指示器默认实现（原 `ChatInputArea.vue` 1548–1572 的 `<svg>` + `<Transition>` 浮层，逐字搬家）。
 *
 * <p>外层容器（`relative inline-flex h-7 …`、`v-if="contextUsageText"`、`MUTED` 配色）仍归
 * `ChatInputArea` 所有 —— 插槽只替换容器内部，消费者改不掉「什么时候出现」。
 * 浮层用 `absolute bottom-full` 定位，其包含块是外层那个带 `relative` 的容器，因此这里
 * **不能**再加 `relative` 包装，否则浮层会改成相对本组件定位。</p>
 *
 * <p>悬停状态（原 1542–1543 的两个行内处理器）随浮层一起搬入：浮层只由本组件拥有，
 * 状态留在外面会形成"两个 owner 管一个节点"。</p>
 */
import type { ChatInputContextUsageSlotProps } from '../../types/chatInputSlots';

defineOptions({ inheritAttrs: false });

const props = defineProps<ChatInputContextUsageSlotProps>();

/**
 * 悬浮浮层的显示状态**不在本组件**：触发区是外层容器（28px 高）的、归 `ChatInputArea` 所有，
 * 这里只按 `tooltipVisible` 渲染。把 mouseenter/mouseleave 搬进来会让触发区缩到 18×18 图标上，
 * 是行为漂移（见类型注释）。
 */
</script>

<template>
  <svg
    data-slot="context-usage"
    class="w-[18px] h-[18px] shrink-0 -rotate-90 -translate-y-[0.5px]"
    viewBox="0 0 16 16"
    aria-hidden="true"
  >
    <!-- 未占用底轨：浅色模式为浅白灰，深色模式为深灰 -->
    <circle
      cx="8" cy="8" r="6" fill="none" stroke-width="2.3"
      class="stroke-zinc-200 dark:stroke-zinc-700/60"
    />
    <!-- 已占用进度：浅色模式为黑色，深色模式为白色 -->
    <circle
      cx="8" cy="8" r="6" fill="none" stroke-width="2.3" stroke-linecap="round"
      class="stroke-zinc-900 dark:stroke-zinc-100 transition-[stroke-dasharray] duration-500"
      :stroke-dasharray="props.contextRingDash"
    />
  </svg>
  <Transition
    enter-active-class="transition duration-150 ease-out"
    enter-from-class="opacity-0 translate-y-1"
    enter-to-class="opacity-100 translate-y-0"
    leave-active-class="transition duration-100 ease-in"
    leave-from-class="opacity-100 translate-y-0"
    leave-to-class="opacity-0 translate-y-1"
  >
    <div
      v-if="props.tooltipVisible"
      class="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 whitespace-nowrap rounded-lg border px-2.5 py-1.5 shadow-xl z-50 [background:var(--pb-menu)] border-white/[0.08] backdrop-blur-md [color:var(--pb-ink)] text-xs"
    >
      {{ props.contextUsageText }}
    </div>
  </Transition>
</template>
