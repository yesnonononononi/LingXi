<script setup lang="ts">
import { useGeneralTab } from './useGeneralTab';

defineProps<{
  isDark?: boolean;
}>();

const emit = defineEmits<{
  (e: 'modelUpdated'): void;
}>();

const {
  themeMode,
  language,
  isLanguageOpen,
  languageOptions,
  executionEnv,
  isExecutionEnvOpen,
  executionEnvOptions,
  accessMode,
  isAccessModeOpen,
  accessModeOptions,
  currentAccessModeLabel,
  commandApprovalPolicy,
  isCommandApprovalPolicyOpen,
  commandApprovalPolicyOptions,
  currentCommandApprovalPolicyLabel,
  toggleLanguageDropdown,
  toggleExecutionEnvDropdown,
  toggleAccessModeDropdown,
  toggleCommandApprovalPolicyDropdown,
  handleSelectExecutionEnv,
  handleSelectAccessMode,
  handleSelectCommandApprovalPolicy,
  closeGeneralDropdowns,
  handleSelectTheme,
} = useGeneralTab(() => emit('modelUpdated'));
</script>

<template>
  <div class="space-y-5" @click="closeGeneralDropdowns">
    <!-- 主题选项 -->
    <div>
      <div class="text-xs font-medium text-gray-800 dark:text-gray-200 mb-2.5">主题</div>
      <div class="grid grid-cols-3 gap-3">
        <!-- 浅色 -->
        <button
          type="button"
          @click="handleSelectTheme('light')"
          :class="[
            'px-4 py-3.5 rounded-2xl border flex flex-col items-center justify-center gap-2 transition cursor-pointer',
            themeMode === 'light'
              ? (isDark ? 'bg-[#252f44] border-blue-500 text-white' : 'bg-gray-100 border-gray-300 text-gray-900 font-semibold shadow-sm')
              : (isDark ? 'border-[#2b374f] text-gray-400 hover:bg-white/5' : 'border-gray-200 text-gray-600 hover:bg-gray-50')
          ]"
        >
          <svg class="w-5 h-5 text-gray-600 dark:text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
          </svg>
          <span class="text-xs">浅色</span>
        </button>

        <!-- 深色 -->
        <button
          type="button"
          @click="handleSelectTheme('dark')"
          :class="[
            'px-4 py-3.5 rounded-2xl border flex flex-col items-center justify-center gap-2 transition cursor-pointer',
            themeMode === 'dark'
              ? (isDark ? 'bg-[#252f44] border-blue-500 text-white font-semibold shadow-sm' : 'bg-gray-100 border-gray-300 text-gray-900 font-semibold')
              : (isDark ? 'border-[#2b374f] text-gray-400 hover:bg-white/5' : 'border-gray-200 text-gray-600 hover:bg-gray-50')
          ]"
        >
          <svg class="w-5 h-5 text-gray-600 dark:text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
          </svg>
          <span class="text-xs">深色</span>
        </button>

        <!-- 跟随系统 -->
        <button
          type="button"
          @click="handleSelectTheme('system')"
          :class="[
            'px-4 py-3.5 rounded-2xl border flex flex-col items-center justify-center gap-2 transition cursor-pointer',
            themeMode === 'system'
              ? (isDark ? 'bg-[#252f44] border-blue-500 text-white font-semibold shadow-sm' : 'bg-gray-100 border-gray-300 text-gray-900 font-semibold shadow-sm')
              : (isDark ? 'border-[#2b374f] text-gray-400 hover:bg-white/5' : 'border-gray-200 text-gray-600 hover:bg-gray-50')
          ]"
        >
          <svg class="w-5 h-5 text-gray-600 dark:text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <span class="text-xs">跟随系统</span>
        </button>
      </div>
    </div>

    <!-- 语言 -->
    <div class="flex items-center justify-between py-3 border-b border-gray-100 dark:border-gray-800/80">
      <span class="text-xs text-gray-800 dark:text-gray-200">语言</span>
      <div class="relative language-dropdown-container" @click.stop>
        <button
          type="button"
          @click="toggleLanguageDropdown"
          class="px-4 py-1.5 rounded-full bg-[#f0f2f5] dark:bg-[#252f44] hover:bg-gray-200/70 dark:hover:bg-[#2d3a54] text-xs text-gray-700 dark:text-gray-200 flex items-center gap-1.5 transition cursor-pointer"
        >
          <span>{{ language }}</span>
          <svg
            class="w-3 h-3 text-gray-400 transition-transform duration-200"
            :class="{ 'rotate-180': isLanguageOpen }"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        <transition name="dropdown-down">
          <div
            v-if="isLanguageOpen"
            class="absolute right-0 mt-1.5 w-32 rounded-xl bg-white dark:bg-[#1f293d] border border-gray-200 dark:border-gray-700 shadow-xl py-1 z-30 text-xs origin-top"
          >
            <div
              v-for="opt in languageOptions"
              :key="opt"
              @click="language = opt; isLanguageOpen = false"
              :class="[
                'px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-white/10 cursor-pointer flex items-center justify-between transition-colors',
                language === opt ? 'text-blue-500 font-medium' : ''
              ]"
            >
              <span>{{ opt }}</span>
              <svg v-if="language === opt" class="w-3.5 h-3.5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </div>
          </div>
        </transition>
      </div>
    </div>

    <!-- 执行环境 -->
    <div class="flex items-center justify-between py-3 border-b border-gray-100 dark:border-gray-800/80">
      <span class="text-xs text-gray-800 dark:text-gray-200">执行环境</span>
      <div class="relative execution-env-dropdown-container" @click.stop>
        <button
          type="button"
          @click="toggleExecutionEnvDropdown"
          class="px-4 py-1.5 rounded-full bg-[#f0f2f5] dark:bg-[#252f44] hover:bg-gray-200/70 dark:hover:bg-[#2d3a54] text-xs text-gray-700 dark:text-gray-200 flex items-center gap-1.5 transition cursor-pointer"
        >
          <span>{{ executionEnv }}</span>
          <svg
            class="w-3 h-3 text-gray-400 transition-transform duration-200"
            :class="{ 'rotate-180': isExecutionEnvOpen }"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        <transition name="dropdown-down">
          <div
            v-if="isExecutionEnvOpen"
            class="absolute right-0 mt-1.5 w-32 rounded-xl bg-white dark:bg-[#1f293d] border border-gray-200 dark:border-gray-700 shadow-xl py-1 z-30 text-xs origin-top"
          >
            <div
              v-for="opt in executionEnvOptions"
              :key="opt"
              @click="handleSelectExecutionEnv(opt)"
              :class="[
                'px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-white/10 cursor-pointer flex items-center justify-between transition-colors',
                executionEnv === opt ? 'text-blue-500 font-medium' : ''
              ]"
            >
              <span>{{ opt }}</span>
              <svg v-if="executionEnv === opt" class="w-3.5 h-3.5 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </div>
          </div>
        </transition>
      </div>
    </div>

    <!-- 工作空间权限 -->
    <div class="flex items-center justify-between py-3 border-b border-gray-100 dark:border-gray-800/80">
      <div class="flex flex-col">
        <span class="text-xs text-gray-800 dark:text-gray-200">工作空间权限</span>
        <span class="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">控制 Agent 访问与读写文件的边界</span>
      </div>
      <div class="relative access-mode-dropdown-container" @click.stop>
        <button
          type="button"
          @click="toggleAccessModeDropdown"
          class="px-4 py-1.5 rounded-full bg-[#f0f2f5] dark:bg-[#252f44] hover:bg-gray-200/70 dark:hover:bg-[#2d3a54] text-xs text-gray-700 dark:text-gray-200 flex items-center gap-1.5 transition cursor-pointer"
        >
          <span>{{ currentAccessModeLabel }}</span>
          <svg
            class="w-3 h-3 text-gray-400 transition-transform duration-200"
            :class="{ 'rotate-180': isAccessModeOpen }"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        <transition name="dropdown-down">
          <div
            v-if="isAccessModeOpen"
            class="absolute right-0 mt-1.5 w-72 rounded-2xl bg-white dark:bg-[#1f293d] border border-gray-200 dark:border-gray-700 shadow-xl py-1.5 z-30 text-xs origin-top"
          >
            <div
              v-for="opt in accessModeOptions"
              :key="opt.value"
              @click="handleSelectAccessMode(opt.value)"
              :class="[
                'px-3.5 py-2 hover:bg-gray-100 dark:hover:bg-white/10 cursor-pointer flex items-center justify-between gap-3 transition-colors',
                accessMode === opt.value ? 'bg-blue-50/60 dark:bg-blue-500/10' : ''
              ]"
            >
              <div class="flex flex-col flex-1 min-w-0">
                <span class="font-medium" :class="accessMode === opt.value ? 'text-blue-500 font-semibold' : 'text-gray-800 dark:text-gray-200'">{{ opt.label }}</span>
                <span class="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5 leading-snug">{{ opt.desc }}</span>
              </div>
              <svg v-if="accessMode === opt.value" class="w-4 h-4 text-blue-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </div>
          </div>
        </transition>
      </div>
    </div>

    <!-- 工具权限 -->
    <div class="flex items-center justify-between py-3">
      <div class="flex flex-col">
        <span class="text-xs text-gray-800 dark:text-gray-200">工具权限</span>
        <span class="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">控制执行工具与终端命令的确认策略</span>
      </div>
      <div class="relative command-policy-dropdown-container" @click.stop>
        <button
          type="button"
          @click="toggleCommandApprovalPolicyDropdown"
          class="px-4 py-1.5 rounded-full bg-[#f0f2f5] dark:bg-[#252f44] hover:bg-gray-200/70 dark:hover:bg-[#2d3a54] text-xs text-gray-700 dark:text-gray-200 flex items-center gap-1.5 transition cursor-pointer"
        >
          <span>{{ currentCommandApprovalPolicyLabel }}</span>
          <svg
            class="w-3 h-3 text-gray-400 transition-transform duration-200"
            :class="{ 'rotate-180': isCommandApprovalPolicyOpen }"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        <transition name="dropdown-up">
          <div
            v-if="isCommandApprovalPolicyOpen"
            class="absolute right-0 bottom-full mb-1.5 w-72 rounded-2xl bg-white dark:bg-[#1f293d] border border-gray-200 dark:border-gray-700 shadow-xl py-1.5 z-30 text-xs origin-bottom-right"
          >
            <div
              v-for="opt in commandApprovalPolicyOptions"
              :key="opt.value"
              @click="handleSelectCommandApprovalPolicy(opt.value)"
              :class="[
                'px-3.5 py-2 hover:bg-gray-100 dark:hover:bg-white/10 cursor-pointer flex items-center justify-between gap-3 transition-colors',
                commandApprovalPolicy === opt.value ? 'bg-blue-50/60 dark:bg-blue-500/10' : ''
              ]"
            >
              <div class="flex flex-col flex-1 min-w-0">
                <span class="font-medium" :class="commandApprovalPolicy === opt.value ? 'text-blue-500 font-semibold' : 'text-gray-800 dark:text-gray-200'">{{ opt.label }}</span>
                <span class="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5 leading-snug">{{ opt.desc }}</span>
              </div>
              <svg v-if="commandApprovalPolicy === opt.value" class="w-4 h-4 text-blue-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </div>
          </div>
        </transition>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 下拉菜单向下展开动画 (右上角对齐触发器) */
.dropdown-down-enter-active {
  transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1), transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  transform-origin: top right;
}

.dropdown-down-leave-active {
  transition: opacity 0.15s ease-in, transform 0.15s ease-in;
  transform-origin: top right;
}

.dropdown-down-enter-from {
  opacity: 0;
  transform: translateY(-8px) scaleY(0.85);
}

.dropdown-down-enter-to {
  opacity: 1;
  transform: translateY(0) scaleY(1);
}

.dropdown-down-leave-from {
  opacity: 1;
  transform: translateY(0) scaleY(1);
}

.dropdown-down-leave-to {
  opacity: 0;
  transform: translateY(-6px) scaleY(0.9);
}

/* 下拉菜单向上展开动画 (右下角对齐触发器) */
.dropdown-up-enter-active {
  transition: opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1), transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  transform-origin: bottom right;
}

.dropdown-up-leave-active {
  transition: opacity 0.15s ease-in, transform 0.15s ease-in;
  transform-origin: bottom right;
}

.dropdown-up-enter-from {
  opacity: 0;
  transform: translateY(8px) scaleY(0.85);
}

.dropdown-up-enter-to {
  opacity: 1;
  transform: translateY(0) scaleY(1);
}

.dropdown-up-leave-from {
  opacity: 1;
  transform: translateY(0) scaleY(1);
}

.dropdown-up-leave-to {
  opacity: 0;
  transform: translateY(6px) scaleY(0.9);
}
</style>
