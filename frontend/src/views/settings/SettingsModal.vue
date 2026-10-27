<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { normalizeSettingsTab } from '../../utils/enum';
import type { SettingsTabKey } from '../../utils/enum';
import GeneralTab from './tabs/GeneralTab.vue';
import PersonalizationTab from './tabs/PersonalizationTab.vue';
import { usePersonalizationCopy } from './tabs/personalizationCopy';
import ModelsTab from './tabs/ModelsTab.vue';
import AgentsTab from './tabs/AgentsTab.vue';
import TeamsTab from './tabs/TeamsTab.vue';
import McpTab from './tabs/McpTab.vue';
import DataTab from './tabs/DataTab.vue';
import SecurityTab from './tabs/SecurityTab.vue';
import { useSecurityCopy } from './tabs/securityCopy';
import TermsTab from './tabs/TermsTab.vue';
import AboutTab from './tabs/AboutTab.vue';
import { useTheme } from '../../composables/useTheme';
import { useI18n } from '../../i18n';

const props = defineProps<{
  isDark?: boolean;
  initialTab?: string;
}>();

const { t } = useI18n();
const personalizationCopy = usePersonalizationCopy();
const securityCopy = useSecurityCopy();

const { isDark: themeIsDark } = useTheme();
const isDark = computed(() => themeIsDark.value);

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'toggleTheme'): void;
  (e: 'clearSessions'): void;
  (e: 'modelUpdated'): void;
}>();

type TabKey = SettingsTabKey;
const activeTab = ref<TabKey>(normalizeSettingsTab(props.initialTab, 'general'));

watch(() => props.initialTab, (newTab) => {
  if (newTab) {
    activeTab.value = normalizeSettingsTab(newTab, 'general');
  }
});

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') emit('close');
};

onMounted(() => {
  window.addEventListener('keydown', handleKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKeydown);
});
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-md animate-fade-in"
    @click.self="emit('close')"
  >
    <div
      :class="[
        'w-[768px] max-w-[calc(100vw-2rem)] h-[580px] max-h-[calc(100vh-2rem)] rounded-3xl p-6 shadow-2xl border flex flex-col',
        isDark
          ? 'bg-black border-white/15 text-zinc-100 shadow-[0_0_60px_rgba(0,0,0,0.9)] backdrop-blur-2xl'
          : 'bg-white border-zinc-100 text-gray-800'
      ]"
    >
      <!-- Header -->
      <div :class="['flex items-center justify-between pb-4 border-b shrink-0', 'border-lx-border-faint']">
        <h3 class="text-base font-bold tracking-tight text-lx-primary dark:text-glow-white">{{ t('settings.title') }}</h3>
        <button
          type="button"
          @click="emit('close')"
          class="p-1 rounded-full text-zinc-400 hover:text-gray-600 dark:hover:text-zinc-200 hover:bg-black/5 dark:hover:bg-white/5 transition cursor-pointer"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Main Layout: Left Sidebar + Right Content -->
      <div class="flex flex-col sm:flex-row gap-4 sm:gap-6 pt-4 flex-1 min-h-0">
        <!-- Left Sidebar Navigation -->
        <div class="flex sm:block w-full sm:w-36 shrink-0 gap-1 sm:space-y-1 overflow-x-auto sm:overflow-visible">
          <!-- 1. 通用设置 -->
          <button
            @click="activeTab = 'general'"
            :class="[
              'shrink-0 w-auto sm:w-full whitespace-nowrap flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition cursor-pointer text-left',
              activeTab === 'general'
                ? (isDark ? 'bg-white/10 text-white font-medium dark:text-glow-subtle border border-white/10 shadow-sm' : 'bg-zinc-100 text-gray-900 font-semibold')
                : (isDark ? 'text-zinc-400 hover:text-zinc-200 hover:bg-lx-surface-hover' : 'text-gray-600 hover:text-gray-900 hover:bg-lx-surface-hover')
            ]"
          >
            <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <span>{{ t('settings.nav.general') }}</span>
          </button>

          <button
            @click="activeTab = 'personalization'"
            :class="[
              'shrink-0 w-auto sm:w-full whitespace-nowrap flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition cursor-pointer text-left',
              activeTab === 'personalization'
                ? (isDark ? 'bg-white/10 text-white border border-white/10 shadow-sm' : 'bg-zinc-100 text-gray-900 font-semibold')
                : (isDark ? 'text-zinc-400 hover:text-zinc-200 hover:bg-lx-surface-hover' : 'text-gray-600 hover:text-gray-900 hover:bg-lx-surface-hover')
            ]"
          >
            <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 8a3 3 0 110-6 3 3 0 010 6zM5 20v-2a7 7 0 0114 0v2M18 7l1 1 3-3" />
            </svg>
            <span>{{ personalizationCopy.page }}</span>
          </button>

          <!-- 2. 模型 -->
          <button
            @click="activeTab = 'models'"
            :class="[
              'shrink-0 w-auto sm:w-full whitespace-nowrap flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition cursor-pointer text-left',
              activeTab === 'models'
                ? (isDark ? 'bg-white/10 text-white font-medium dark:text-glow-subtle border border-white/10 shadow-sm' : 'bg-zinc-100 text-gray-900 font-semibold')
                : (isDark ? 'text-zinc-400 hover:text-zinc-200 hover:bg-lx-surface-hover' : 'text-gray-600 hover:text-gray-900 hover:bg-lx-surface-hover')
            ]"
          >
            <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <ellipse cx="12" cy="7" rx="8" ry="3" stroke-width="1.8" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4 7v10c0 1.657 3.582 3 8 3s8-1.343 8-3V7" />
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4 12c0 1.657 3.582 3 8 3s8-1.343 8-3" />
            </svg>
            <span>{{ t('settings.nav.models') }}</span>
          </button>

          <!-- 3. 智能体 -->
          <button
            @click="activeTab = 'agents'"
            :class="[
              'shrink-0 w-auto sm:w-full whitespace-nowrap flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition cursor-pointer text-left',
              activeTab === 'agents'
                ? (isDark ? 'bg-white/10 text-white font-medium dark:text-glow-subtle border border-white/10 shadow-sm' : 'bg-zinc-100 text-gray-900 font-semibold')
                : (isDark ? 'text-zinc-400 hover:text-zinc-200 hover:bg-lx-surface-hover' : 'text-gray-600 hover:text-gray-900 hover:bg-lx-surface-hover')
            ]"
          >
            <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
            </svg>
            <span>{{ t('settings.nav.agents') }}</span>
          </button>

          <!-- 4. 团队协同 -->
          <button
            @click="activeTab = 'teams'"
            :class="[
              'shrink-0 w-auto sm:w-full whitespace-nowrap flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition cursor-pointer text-left',
              activeTab === 'teams'
                ? (isDark ? 'bg-white/10 text-white font-medium dark:text-glow-subtle border border-white/10 shadow-sm' : 'bg-zinc-100 text-gray-900 font-semibold')
                : (isDark ? 'text-zinc-400 hover:text-zinc-200 hover:bg-lx-surface-hover' : 'text-gray-600 hover:text-gray-900 hover:bg-lx-surface-hover')
            ]"
          >
            <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
            </svg>
            <span>{{ t('settings.nav.teams') }}</span>
          </button>

          <!-- 5. MCP 服务 -->
          <button
            @click="activeTab = 'mcp'"
            :class="[
              'shrink-0 w-auto sm:w-full whitespace-nowrap flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition cursor-pointer text-left',
              activeTab === 'mcp'
                ? (isDark ? 'bg-white/10 text-white font-medium dark:text-glow-subtle border border-white/10 shadow-sm' : 'bg-zinc-100 text-gray-900 font-semibold')
                : (isDark ? 'text-zinc-400 hover:text-zinc-200 hover:bg-lx-surface-hover' : 'text-gray-600 hover:text-gray-900 hover:bg-lx-surface-hover')
            ]"
          >
            <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M5 12h14M5 12a7 7 0 0114 0M5 12a7 7 0 0014 0M12 5V3m0 18v-2m7-7h2M3 12h2" />
            </svg>
            <span>{{ t('settings.nav.mcp') }}</span>
                    </button>

          <button @click="activeTab = 'security'" type="button"
            :class="['shrink-0 w-auto sm:w-full whitespace-nowrap flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition cursor-pointer text-left',
              activeTab === 'security' ? (isDark ? 'bg-white/10 text-white border border-white/10 shadow-sm' : 'bg-zinc-100 text-gray-900 font-semibold')
              : (isDark ? 'text-zinc-400 hover:text-zinc-200 hover:bg-lx-surface-hover' : 'text-gray-600 hover:text-gray-900 hover:bg-lx-surface-hover') ]">
            <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 3l8 4v5c0 5-8 9-8 9s-8-4-8-9V7l8-4zM8 12l3 3 5-6" /></svg>
            <span>{{ securityCopy.page }}</span>
          </button>

          <!-- 6. 数据管理 -->
          <button
            @click="activeTab = 'data'"
            :class="[
              'shrink-0 w-auto sm:w-full whitespace-nowrap flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition cursor-pointer text-left',
              activeTab === 'data'
                ? (isDark ? 'bg-white/10 text-white font-medium dark:text-glow-subtle border border-white/10 shadow-sm' : 'bg-zinc-100 text-gray-900 font-semibold')
                : (isDark ? 'text-zinc-400 hover:text-zinc-200 hover:bg-lx-surface-hover' : 'text-gray-600 hover:text-gray-900 hover:bg-lx-surface-hover')
            ]"
          >
            <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
            </svg>
            <span>{{ t('settings.nav.data') }}</span>
          </button>

          <!-- 7. 服务协议 -->
          <button
            @click="activeTab = 'terms'"
            :class="[
              'shrink-0 w-auto sm:w-full whitespace-nowrap flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition cursor-pointer text-left',
              activeTab === 'terms'
                ? (isDark ? 'bg-white/10 text-white font-medium dark:text-glow-subtle border border-white/10 shadow-sm' : 'bg-zinc-100 text-gray-900 font-semibold')
                : (isDark ? 'text-zinc-400 hover:text-zinc-200 hover:bg-lx-surface-hover' : 'text-gray-600 hover:text-gray-900 hover:bg-lx-surface-hover')
            ]"
          >
            <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span>{{ t('settings.nav.terms') }}</span>
          </button>

          <!-- 8. 关于与更新 -->
          <button
            @click="activeTab = 'about'"
            :class="[
              'shrink-0 w-auto sm:w-full whitespace-nowrap flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition cursor-pointer text-left',
              activeTab === 'about'
                ? (isDark ? 'bg-white/10 text-white font-medium dark:text-glow-subtle border border-white/10 shadow-sm' : 'bg-zinc-100 text-gray-900 font-semibold')
                : (isDark ? 'text-zinc-400 hover:text-zinc-200 hover:bg-lx-surface-hover' : 'text-gray-600 hover:text-gray-900 hover:bg-lx-surface-hover')
            ]"
          >
            <svg class="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <span>{{ t('settings.nav.about') }}</span>
          </button>
        </div>

        <!-- Right Content Area -->
        <!-- scrollbar-gutter: 恒定预留滚动条槽位，使各 tab 的盒子宽度一致（不因是否出现滚动条而变窄） -->
        <div
          class="flex-1 min-w-0 pr-1 text-sm h-full overflow-y-auto [scrollbar-gutter:stable]"
        >
          <GeneralTab v-if="activeTab === 'general'" :is-dark="isDark" />
          <PersonalizationTab v-else-if="activeTab === 'personalization'" />
          <ModelsTab v-else-if="activeTab === 'models'" :is-dark="isDark" @model-updated="emit('modelUpdated')" />
          <AgentsTab v-else-if="activeTab === 'agents'" :is-dark="isDark" />
          <TeamsTab v-else-if="activeTab === 'teams'" :is-dark="isDark" @model-updated="emit('modelUpdated')" />
                    <McpTab v-else-if="activeTab === 'mcp'" :is-dark="isDark" />
          <DataTab v-else-if="activeTab === 'data'" :is-dark="isDark" @clear-sessions="emit('clearSessions')" />
          <SecurityTab v-else-if="activeTab === 'security'" @model-updated="emit('modelUpdated')" />
          <TermsTab v-else-if="activeTab === 'terms'" :is-dark="isDark" />
          <AboutTab v-else-if="activeTab === 'about'" :is-dark="isDark" />
        </div>
      </div>
    </div>
  </div>
</template>
