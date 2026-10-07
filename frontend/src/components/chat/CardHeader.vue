<script setup lang="ts">
import { cardDotClass, type CardTone } from '../../utils/cardUi';

/**
 * 四类互动卡片统一的 header：状态点 + 类型标签(12px semibold) + 标题（可截断）+ 右侧操作插槽。
 *
 * <p>此前四种表达（点+徽标 / 点+已决横幅 / 只有横幅 / 只有点）与三种标题尺度并存，
 * 同一时间线上看不出是同一控件家族。统一后：状态一律由左侧状态点表达，
 * 类型标签固定 12px semibold，标题为二级信息，已决横幅降为正文区的二级提示。</p>
 */
withDefaults(defineProps<{
  tone: CardTone;
  /** 类型标签，如「计划」「提问」「命令审批」「子代理委派」 */
  typeLabel: string;
  /** 标题（可空）；过长截断并挂 title 提示 */
  title?: string;
  isDark?: boolean;
}>(), {
  title: '',
  isDark: false
});
</script>

<template>
  <div class="flex items-center justify-between gap-2 select-none">
    <div class="flex items-center gap-2 min-w-0">
      <span :class="['w-2 h-2 rounded-full flex-shrink-0', cardDotClass(tone)]"></span>
      <span :class="['text-xs font-semibold flex-shrink-0', isDark ? 'text-gray-300' : 'text-gray-600']">
        {{ typeLabel }}
      </span>
      <span
        v-if="title"
        :title="title"
        :class="['text-sm font-medium truncate', isDark ? 'text-gray-100' : 'text-gray-800']"
      >
        {{ title }}
      </span>
    </div>
    <div class="flex items-center gap-1 flex-shrink-0">
      <slot name="actions" />
    </div>
  </div>
</template>
