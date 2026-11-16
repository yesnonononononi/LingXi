<script setup lang="ts">
import {computed} from 'vue';
import {t} from '../../i18n';
import type {SidebarFooterSlotProps} from '../../types/sidebarSlots';

defineOptions({ inheritAttrs: false });

const props = defineProps<SidebarFooterSlotProps>();
const isCollapsed = computed(() => props.isCollapsed);
</script>

<template>
  <div
    :class="['flex items-center', isCollapsed ? 'justify-center' : 'justify-between']"
    data-slot="sidebar-footer"
  >
    <button
      type="button"
      @click="props.onOpenSettings"
      :title="t('chat.sidebar.systemSettings')"
      :class="[
        'group flex items-center gap-2.5 text-xs font-medium transition-all duration-200 cursor-pointer border border-lx-border-subtle bg-lx-surface hover:bg-lx-surface-hover hover:border-lx-border shadow-xs',
        isCollapsed ? 'w-9 h-9 justify-center rounded-xl p-0' : 'w-full justify-between px-3 py-2 rounded-xl'
      ]"
    >
      <span class="flex items-center gap-2 min-w-0">
        <span class="w-2 h-2 rounded-full bg-lx-accent shrink-0 group-hover:scale-110 transition-transform" aria-hidden="true" />
        <svg class="w-4 h-4 shrink-0 text-lx-secondary group-hover:text-lx-primary transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        <span v-if="!isCollapsed" class="text-lx-primary truncate">{{ t('chat.sidebar.settings') }}</span>
      </span>
      <svg
        v-if="!isCollapsed"
        class="w-3.5 h-3.5 shrink-0 text-lx-muted group-hover:translate-x-0.5 transition-transform"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
      </svg>
    </button>
  </div>
</template>
