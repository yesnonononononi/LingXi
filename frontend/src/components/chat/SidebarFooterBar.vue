<script setup lang="ts">
/**
 * Sidebar 底部入口区的**默认实现**（原 `Sidebar.vue` 643–659 逐字迁移）。
 *
 * <p>它只吃对外契约 `SidebarFooterSlotProps`（3 项）—— 因为底部栏本来就没有内部状态耦合，
 * 不需要像工作区树那样另立内部接口。模板里 `emit('openSettings')` 用一层垫片转调到
 * `props.onOpenSettings`，理由同树组件：保留原写法，避免为了"看起来更类型安全"而改动模板。</p>
 */

import { computed } from 'vue';
import { t } from '../../i18n';
import type { SidebarFooterSlotProps } from '../../types/sidebarSlots';

defineOptions({ inheritAttrs: false });

const props = defineProps<SidebarFooterSlotProps>();

// 包成 computed：props 变化时必须跟着变（底部栏配色随 isDark / 布局随 isCollapsed）。
const isCollapsed = computed(() => props.isCollapsed);
const isDark = computed(() => props.isDark);

/** 原模板里的 `emit('openSettings')` 转调；未知名抛错以免迁移漏事件被静默吞掉。 */
const emit = (event: string): void => {
  if (event === 'openSettings') {
    props.onOpenSettings();
    return;
  }
  throw new Error(`SidebarFooterBar: 未支持的 emit 事件「${event}」（模板与本组件契约不一致）`);
};
</script>

<template>
      <div :class="['flex items-center', isCollapsed ? 'justify-center' : 'justify-between']" data-slot="sidebar-footer">
        <!-- Settings Button (⚙ 设置) -->
        <button
          @click="emit('openSettings')"
          :class="[
            'flex items-center gap-2 text-xs font-medium transition-colors cursor-pointer py-1.5 px-2 rounded-lg',
            isDark ? 'text-zinc-400 hover:text-zinc-100 hover:bg-white/[0.05]' : 'text-gray-600 hover:text-gray-900 hover:bg-zinc-200/60'
          ]"
          :title="t('chat.sidebar.systemSettings')"
        >
          <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          <span v-if="!isCollapsed">{{ t('chat.sidebar.settings') }}</span>
        </button>
      </div>
</template>
