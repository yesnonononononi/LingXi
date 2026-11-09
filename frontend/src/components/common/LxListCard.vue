<script setup lang="ts">
import {computed} from 'vue';
import {useTheme} from '../../composables/useTheme';

/**
 * 设置页列表卡片外壳：外框 + 头部插槽 + 内容插槽 + 操作条插槽。
 *
 * 存在的理由：McpTab / AgentsTab / TeamsTab 各自抄了一遍
 * `rounded-2xl border px-4 py-3.5 transition-all` + 一大坨 `isDark ? A : B` 的外框样式，
 * 想统一一下卡片底色或 hover 边框得改三处，还容易漏。
 *
 * 分区契约（也是「条目别乱飞」的根因修复）：
 * - `#header`：标题行，只放名称与状态，`flex-wrap` 换行只发生在同类元素之间；
 * - 默认插槽：描述 / 端点 / 元信息，按调用方自己的节奏排；
 * - `#actions`：操作条，**独立成行右对齐**（带分隔线）。操作数 ≥3 的卡片必须用它，
 *   别把按钮塞回标题行 —— 那正是窄容器里徽标与按钮互相挤压变形的来源。
 *
 * 不猜业务样式：外框配色只有「普通 / 高亮（选中）」两档，其余由调用方给内容。
 */
const props = withDefaults(
  defineProps<{
    /** 是否跟随父级传下来的暗色标记（缺省时读全局主题） */
    isDark?: boolean;
    /** 高亮态：用于多选列表里的「已勾选」卡片 */
    highlight?: boolean;
  }>(),
  {highlight: false}
);

const {isDark: themeIsDark} = useTheme();
const isDark = computed(() => props.isDark ?? themeIsDark.value);

const surfaceClass = computed(() =>
  props.highlight
    ? isDark.value
      ? 'bg-sky-500/[0.08] border-sky-500/50 shadow-[0_0_20px_rgba(56,189,248,0.18)]'
      : 'bg-blue-50/60 border-blue-400 shadow-sm'
    : isDark.value
      ? 'bg-black/90 border-white/15 hover:border-white/30 shadow-[0_0_20px_rgba(0,0,0,0.8)]'
      : 'bg-zinc-50/70 border-zinc-200 hover:border-zinc-300'
);
</script>

<template>
  <div class="rounded-2xl border px-4 py-3.5 transition-colors" :class="surfaceClass">
    <slot name="header" />
    <slot />
    <div
      v-if="$slots.actions"
      data-lx-card-actions
      class="mt-3 flex flex-wrap items-center justify-end gap-1 border-t pt-2.5"
      :class="isDark ? 'border-white/10' : 'border-zinc-200'"
    >
      <slot name="actions" />
    </div>
  </div>
</template>
