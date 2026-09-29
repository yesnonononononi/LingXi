<script setup lang="ts">
import { ref, computed } from 'vue';
import type { PlanTaskItem } from '../../types/chat';
import { isTaskBlocked, isTaskDoing, isTaskDone, isTaskTodo } from '../../utils/enum';

const props = withDefaults(
  defineProps<{
    tasks: PlanTaskItem[];
    isDark?: boolean;
    collapsible?: boolean;
    defaultExpanded?: boolean;
  }>(),
  {
    collapsible: true,
    defaultExpanded: true
  }
);

const isExpanded = ref(props.defaultExpanded);

const toggleExpand = () => {
  if (props.collapsible) {
    isExpanded.value = !isExpanded.value;
  }
};

// 任务状态判定收敛到 utils/enum 的唯一映射表（后端状态取值不统一，属后端依赖）
const isDone = (task: PlanTaskItem): boolean => isTaskDone(task);
const isDoing = (task: PlanTaskItem): boolean => isTaskDoing(task);
const isBlocked = (task: PlanTaskItem): boolean => isTaskBlocked(task);
const isTodo = (task: PlanTaskItem): boolean => isTaskTodo(task);

// 统计各项数量
const doingCount = computed(() => props.tasks.filter(isDoing).length);
const todoCount = computed(() => props.tasks.filter(isTodo).length);
const doneCount = computed(() => props.tasks.filter(isDone).length);
const blockedCount = computed(() => props.tasks.filter(isBlocked).length);

// 统计信息文本，例如：'1 进行中 · 4 待处理' / '4 已完成 · 1 进行中' / '全部已完成'
const statusSummary = computed(() => {
  const parts: string[] = [];
  if (doingCount.value > 0) {
    parts.push(`${doingCount.value} 进行中`);
  }
  if (todoCount.value > 0) {
    parts.push(`${todoCount.value} 待处理`);
  }
  if (blockedCount.value > 0) {
    parts.push(`${blockedCount.value} 受阻`);
  }
  if (doneCount.value > 0) {
    if (doingCount.value === 0 && todoCount.value === 0) {
      parts.push(`${doneCount.value} 已完成`);
    } else if (doingCount.value > 0 && todoCount.value === 0) {
      parts.push(`${doneCount.value} 已完成`);
    }
  }
  return parts.join(' · ') || `${props.tasks.length} 项`;
});
</script>

<template>
  <div
    class="w-full rounded-xl border transition-all text-xs my-2 select-none"
    :class="[
      props.isDark
        ? 'border-gray-800 bg-[#161b22] text-gray-300'
        : 'border-gray-200/90 bg-[#fbfbfc] text-gray-700'
    ]"
  >
    <!-- 标头栏 (包含图标、任务标签、统计信息与收发展开按钮) -->
    <div
      @click="toggleExpand"
      class="px-3.5 py-2.5 flex items-center justify-between select-none cursor-pointer group"
    >
      <div class="flex items-center gap-2">
        <!-- 列表两点两线图标 ⁝≡ (对齐 media_1789746717386.png) -->
        <svg
          class="w-4 h-4 text-gray-500 dark:text-gray-400 flex-shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
        >
          <circle cx="5" cy="7" r="1.8" fill="currentColor" />
          <line x1="10" y1="7" x2="20" y2="7" />
          <circle cx="5" cy="17" r="1.8" fill="currentColor" />
          <line x1="10" y1="17" x2="20" y2="17" />
        </svg>

        <!-- 任务分类标识 -->
        <span class="font-medium text-[13px] text-gray-800 dark:text-gray-200">
          任务
        </span>

        <!-- 动态数量统计，例如 '1 进行中 · 4 待处理' -->
        <span class="text-[12.5px] text-gray-500 dark:text-gray-400 font-normal">
          {{ statusSummary }}
        </span>
      </div>

      <!-- 右侧收发展开箭头 ⌄ -->
      <button
        v-if="props.collapsible"
        type="button"
        class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 p-0.5 transition-transform duration-200"
        :class="{ '-rotate-180': !isExpanded }"
        aria-label="展开或收起任务列表"
      >
        <svg
          class="w-4 h-4"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <polyline points="6 9 12 15 18 9"></polyline>
        </svg>
      </button>
    </div>

    <!-- 任务清单详情列表 (展开展示) -->
    <div
      v-show="isExpanded"
      class="px-3.5 pb-3 pt-0.5 space-y-2.5 select-text border-t border-gray-100 dark:border-gray-800/60"
    >
      <div
        v-for="(task, idx) in props.tasks"
        :key="task.id || idx"
        class="flex items-center gap-2.5 text-[13px] leading-normal pt-1.5 group"
      >
        <!-- 状态图标 (对齐 media_1789746717386.png 与 media_1789746744040.png) -->
        <div class="flex-shrink-0 flex items-center justify-center w-4 h-4">
          <!-- 1. 已完成 (绿色圆圈内含对勾) -->
          <svg
            v-if="isDone(task)"
            class="w-4 h-4 text-[#10b981] dark:text-[#34d399]"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="9" />
            <polyline points="8 12 11 15 16 9" />
          </svg>

          <!-- 2. 进行中 (蓝色单弧线旋转动画) -->
          <svg
            v-else-if="isDoing(task)"
            class="w-4 h-4 text-[#3b82f6] animate-spin"
            viewBox="0 0 24 24"
            fill="none"
          >
            <circle class="opacity-15" cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5"></circle>
            <path class="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v3a5 5 0 00-5 5H4z"></path>
          </svg>

          <!-- 3. 受阻 (琥珀色叹号) -->
          <svg
            v-else-if="isBlocked(task)"
            class="w-4 h-4 text-amber-500"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.9"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <circle cx="12" cy="12" r="9" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>

          <!-- 4. 待处理 (浅灰虚线圆圈) -->
          <svg
            v-else
            class="w-4 h-4 text-gray-300 dark:text-gray-600"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-dasharray="2.5 2.5"
          >
            <circle cx="12" cy="12" r="9" />
          </svg>
        </div>

        <!-- 任务描述文本 -->
        <div class="flex-1 min-w-0 text-gray-700 dark:text-gray-300 text-[13px] font-normal leading-relaxed">
          <span>{{ task.title }}</span>
          <span v-if="task.description" class="text-gray-400 dark:text-gray-500 text-[11px] block mt-0.5">
            {{ task.description }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
