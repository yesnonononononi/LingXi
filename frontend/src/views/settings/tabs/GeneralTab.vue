<script setup lang="ts">
import { useGeneralTab } from './useGeneralTab';
import { useTheme } from '../../../composables/useTheme';
import SpecularButton from '../../../components/common/SpecularButton.vue';

defineProps<{
  isDark?: boolean;
}>();

const { isDark } = useTheme();

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
  apiBaseUrl,
  isApiUrlSaved,
  handleSaveApiUrl,
  handleResetApiUrl,
} = useGeneralTab(() => emit('modelUpdated'));
</script>

<template>
  <div class="space-y-5" @click="closeGeneralDropdowns">
    <!-- 主题选项 -->
    <div>
      <div class="text-xs font-semibold text-gray-800 dark:text-zinc-100 dark:text-glow-subtle mb-2.5 tracking-wide">主题</div>
      <div class="grid grid-cols-3 gap-3">
        <!-- 浅色 -->
        <button
          type="button"
          @click="handleSelectTheme('light')"
          :class="[
            'px-4 py-3.5 rounded-2xl border flex flex-col items-center justify-center gap-2 transition cursor-pointer',
            themeMode === 'light'
              ? (isDark ? 'bg-zinc-900/90 border-white/40 shadow-[0_0_15px_rgba(255,255,255,0.1)] text-white font-semibold dark:text-glow-white' : 'bg-gray-100 border-gray-300 text-gray-900 font-semibold shadow-sm')
              : (isDark ? 'border-white/10 text-zinc-400 bg-black/40 hover:border-white/20 hover:bg-white/[0.04]' : 'border-gray-200 text-gray-600 hover:bg-gray-50')
          ]"
        >
          <svg class="w-5 h-5 text-gray-600 dark:text-zinc-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
              ? (isDark ? 'bg-zinc-900/90 border-white/40 shadow-[0_0_20px_rgba(255,255,255,0.12)] text-white font-semibold dark:text-glow-white' : 'bg-gray-100 border-gray-300 text-gray-900 font-semibold shadow-sm')
              : (isDark ? 'border-white/10 text-zinc-400 bg-black/40 hover:border-white/20 hover:bg-white/[0.04]' : 'border-gray-200 text-gray-600 hover:bg-gray-50')
          ]"
        >
          <svg class="w-5 h-5 text-gray-600 dark:text-zinc-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
              ? (isDark ? 'bg-zinc-900/90 border-white/40 shadow-[0_0_20px_rgba(255,255,255,0.12)] text-white font-semibold dark:text-glow-white' : 'bg-gray-100 border-gray-300 text-gray-900 font-semibold shadow-sm')
              : (isDark ? 'border-white/10 text-zinc-400 bg-black/40 hover:border-white/20 hover:bg-white/[0.04]' : 'border-gray-200 text-gray-600 hover:bg-gray-50')
          ]"
        >
          <svg class="w-5 h-5 text-gray-600 dark:text-zinc-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <span class="text-xs">跟随系统</span>
        </button>
      </div>
    </div>

    <!-- 语言 -->
    <div class="flex items-center justify-between py-3 border-b border-gray-100 dark:border-white/10">
      <span class="text-xs font-medium text-gray-800 dark:text-zinc-100 dark:text-glow-subtle">语言</span>
      <div class="relative language-dropdown-container" @click.stop>
        <SpecularButton
          size="sm"
          :radius="14"
          :tint="isDark ? '#ffffff' : '#f0f2f5'"
          :tint-opacity="isDark ? 0.04 : 1"
          :text-color="isDark ? '#f4f4f5' : '#374151'"
          line-color="#ffffff"
          base-color="#525252"
          :intensity="1"
          :thickness="1"
          @click="toggleLanguageDropdown"
        >
          <span class="text-xs font-normal">{{ language }}</span>
          <svg
            class="w-3 h-3 text-gray-400 dark:text-zinc-300 transition-transform duration-200"
            :class="{ 'rotate-180': isLanguageOpen }"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </SpecularButton>
        <transition name="dropdown-down">
          <div
            v-if="isLanguageOpen"
            :class="[
              'absolute right-0 mt-1.5 w-32 rounded-xl border shadow-2xl py-1 z-30 text-xs origin-top backdrop-blur-xl',
              isDark ? 'bg-black/95 border-white/20 text-zinc-100 shadow-[0_8px_32px_rgba(0,0,0,0.9)]' : 'bg-white border-gray-200 text-gray-800'
            ]"
          >
            <div
              v-for="opt in languageOptions"
              :key="opt"
              @click="language = opt; isLanguageOpen = false"
              :class="[
                'px-3 py-1.5 cursor-pointer flex items-center justify-between transition-colors',
                language === opt
                  ? (isDark ? 'text-sky-400 text-glow-cyan font-medium bg-white/10' : 'text-blue-500 font-medium bg-blue-50')
                  : (isDark ? 'text-zinc-200 hover:bg-white/10 hover:text-white' : 'text-gray-700 hover:bg-gray-100')
              ]"
            >
              <span>{{ opt }}</span>
              <svg v-if="language === opt" class="w-3.5 h-3.5 text-blue-500 dark:text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </div>
          </div>
        </transition>
      </div>
    </div>

    <!-- 执行环境 -->
    <div class="flex items-center justify-between py-3 border-b border-gray-100 dark:border-white/10">
      <span class="text-xs font-medium text-gray-800 dark:text-zinc-100 dark:text-glow-subtle">执行环境</span>
      <div class="relative execution-env-dropdown-container" @click.stop>
        <SpecularButton
          size="sm"
          :radius="14"
          :tint="isDark ? '#ffffff' : '#f0f2f5'"
          :tint-opacity="isDark ? 0.04 : 1"
          :text-color="isDark ? '#f4f4f5' : '#374151'"
          line-color="#ffffff"
          base-color="#525252"
          :intensity="1"
          :thickness="1"
          @click="toggleExecutionEnvDropdown"
        >
          <span class="text-xs font-normal">{{ executionEnv }}</span>
          <svg
            class="w-3 h-3 text-gray-400 dark:text-zinc-300 transition-transform duration-200"
            :class="{ 'rotate-180': isExecutionEnvOpen }"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </SpecularButton>
        <transition name="dropdown-down">
          <div
            v-if="isExecutionEnvOpen"
            :class="[
              'absolute right-0 mt-1.5 w-32 rounded-xl border shadow-2xl py-1 z-30 text-xs origin-top backdrop-blur-xl',
              isDark ? 'bg-black/95 border-white/20 text-zinc-100 shadow-[0_8px_32px_rgba(0,0,0,0.9)]' : 'bg-white border-gray-200 text-gray-800'
            ]"
          >
            <div
              v-for="opt in executionEnvOptions"
              :key="opt"
              @click="handleSelectExecutionEnv(opt)"
              :class="[
                'px-3 py-1.5 cursor-pointer flex items-center justify-between transition-colors',
                executionEnv === opt
                  ? (isDark ? 'text-sky-400 text-glow-cyan font-medium bg-white/10' : 'text-blue-500 font-medium bg-blue-50')
                  : (isDark ? 'text-zinc-200 hover:bg-white/10 hover:text-white' : 'text-gray-700 hover:bg-gray-100')
              ]"
            >
              <span>{{ opt }}</span>
              <svg v-if="executionEnv === opt" class="w-3.5 h-3.5 text-blue-500 dark:text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </div>
          </div>
        </transition>
      </div>
    </div>

    <!-- 工作空间权限 -->
    <div class="flex items-center justify-between py-3 border-b border-gray-100 dark:border-white/10">
      <div class="flex flex-col">
        <span class="text-xs font-medium text-gray-800 dark:text-zinc-100 dark:text-glow-subtle">工作空间权限</span>
        <span class="text-[11px] text-gray-400 dark:text-zinc-400 mt-0.5">控制 Agent 访问与读写文件的边界</span>
      </div>
      <div class="relative access-mode-dropdown-container" @click.stop>
        <SpecularButton
          size="sm"
          :radius="14"
          :tint="isDark ? '#ffffff' : '#f0f2f5'"
          :tint-opacity="isDark ? 0.04 : 1"
          :text-color="isDark ? '#f4f4f5' : '#374151'"
          line-color="#ffffff"
          base-color="#525252"
          :intensity="1"
          :thickness="1"
          @click="toggleAccessModeDropdown"
        >
          <span class="text-xs font-normal">{{ currentAccessModeLabel }}</span>
          <svg
            class="w-3 h-3 text-gray-400 dark:text-zinc-300 transition-transform duration-200"
            :class="{ 'rotate-180': isAccessModeOpen }"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </SpecularButton>
        <transition name="dropdown-down">
          <div
            v-if="isAccessModeOpen"
            :class="[
              'absolute right-0 mt-1.5 w-72 rounded-2xl border shadow-2xl py-1.5 z-30 text-xs origin-top backdrop-blur-xl',
              isDark ? 'bg-black/95 border-white/20 text-zinc-100 shadow-[0_8px_32px_rgba(0,0,0,0.9)]' : 'bg-white border-gray-200 text-gray-800'
            ]"
          >
            <div
              v-for="opt in accessModeOptions"
              :key="opt.value"
              @click="handleSelectAccessMode(opt.value)"
              :class="[
                'px-3.5 py-2 cursor-pointer flex items-center justify-between gap-3 transition-colors',
                accessMode === opt.value
                  ? (isDark ? 'bg-white/10' : 'bg-blue-50/60')
                  : (isDark ? 'hover:bg-white/5' : 'hover:bg-gray-100')
              ]"
            >
              <div class="flex flex-col flex-1 min-w-0">
                <span
                  class="font-medium"
                  :class="accessMode === opt.value
                    ? (isDark ? 'text-sky-400 text-glow-cyan font-semibold' : 'text-blue-500 font-semibold')
                    : (isDark ? 'text-zinc-200' : 'text-gray-800')"
                >{{ opt.label }}</span>
                <span class="text-[11px] mt-0.5 leading-snug" :class="isDark ? 'text-zinc-400' : 'text-gray-400'">{{ opt.desc }}</span>
              </div>
              <svg v-if="accessMode === opt.value" class="w-4 h-4 text-blue-500 dark:text-sky-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
        <span class="text-xs font-medium text-gray-800 dark:text-zinc-100 dark:text-glow-subtle">工具权限</span>
        <span class="text-[11px] text-gray-400 dark:text-zinc-400 mt-0.5">控制执行工具与终端命令的确认策略</span>
      </div>
      <div class="relative command-policy-dropdown-container" @click.stop>
        <SpecularButton
          size="sm"
          :radius="14"
          :tint="isDark ? '#ffffff' : '#f0f2f5'"
          :tint-opacity="isDark ? 0.04 : 1"
          :text-color="isDark ? '#f4f4f5' : '#374151'"
          line-color="#ffffff"
          base-color="#525252"
          :intensity="1"
          :thickness="1"
          @click="toggleCommandApprovalPolicyDropdown"
        >
          <span class="text-xs font-normal">{{ currentCommandApprovalPolicyLabel }}</span>
          <svg
            class="w-3 h-3 text-gray-400 dark:text-zinc-300 transition-transform duration-200"
            :class="{ 'rotate-180': isCommandApprovalPolicyOpen }"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </SpecularButton>
        <transition name="dropdown-up">
          <div
            v-if="isCommandApprovalPolicyOpen"
            :class="[
              'absolute right-0 bottom-full mb-1.5 w-72 rounded-2xl border shadow-2xl py-1.5 z-30 text-xs origin-bottom-right backdrop-blur-xl',
              isDark ? 'bg-black/95 border-white/20 text-zinc-100 shadow-[0_8px_32px_rgba(0,0,0,0.9)]' : 'bg-white border-gray-200 text-gray-800'
            ]"
          >
            <div
              v-for="opt in commandApprovalPolicyOptions"
              :key="opt.value"
              @click="handleSelectCommandApprovalPolicy(opt.value)"
              :class="[
                'px-3.5 py-2 cursor-pointer flex items-center justify-between gap-3 transition-colors',
                commandApprovalPolicy === opt.value
                  ? (isDark ? 'bg-white/10' : 'bg-blue-50/60')
                  : (isDark ? 'hover:bg-white/5' : 'hover:bg-gray-100')
              ]"
            >
              <div class="flex flex-col flex-1 min-w-0">
                <span
                  class="font-medium"
                  :class="commandApprovalPolicy === opt.value
                    ? (isDark ? 'text-sky-400 text-glow-cyan font-semibold' : 'text-blue-500 font-semibold')
                    : (isDark ? 'text-zinc-200' : 'text-gray-800')"
                >{{ opt.label }}</span>
                <span class="text-[11px] mt-0.5 leading-snug" :class="isDark ? 'text-zinc-400' : 'text-gray-400'">{{ opt.desc }}</span>
              </div>
              <svg v-if="commandApprovalPolicy === opt.value" class="w-4 h-4 text-blue-500 dark:text-sky-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </div>
          </div>
        </transition>
      </div>
    </div>

    <!-- 后端服务地址配置 (桌面客户端 / 局域网服务) -->
    <div class="pt-3 border-t border-gray-100 dark:border-white/10">
      <div class="flex items-center justify-between mb-2">
        <div class="flex flex-col">
          <span class="text-xs font-medium text-gray-800 dark:text-zinc-100 dark:text-glow-subtle">后端服务地址</span>
          <span class="text-[11px] text-gray-400 dark:text-zinc-400 mt-0.5">桌面客户端或远程直连的 API 根地址 (默认: http://localhost:8088)</span>
        </div>
        <button
          type="button"
          @click="handleResetApiUrl"
          class="text-[11px] text-gray-500 hover:text-blue-500 dark:text-zinc-400 dark:hover:text-cyan-300 dark:hover:text-glow-cyan cursor-pointer transition"
        >
          恢复默认
        </button>
      </div>
      <div class="flex items-center gap-2">
        <input
          v-model="apiBaseUrl"
          type="text"
          placeholder="http://localhost:8088"
          class="flex-1 px-3 py-2 text-xs rounded-xl border border-gray-200 dark:border-white/15 bg-white dark:bg-black/60 text-gray-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500 dark:focus:border-cyan-400 focus:ring-1 focus:ring-blue-500 dark:focus:ring-cyan-400 transition"
        />
        <SpecularButton
          size="sm"
          :radius="12"
          :tint="isDark ? '#0284c7' : '#2563eb'"
          :tint-opacity="isDark ? 0.35 : 0.9"
          :line-color="isDark ? '#38bdf8' : '#ffffff'"
          :base-color="isDark ? '#0284c7' : '#2563eb'"
          text-color="#ffffff"
          :intensity="1.2"
          @click="handleSaveApiUrl"
        >
          <svg v-if="isApiUrlSaved" class="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
          <span class="text-xs font-medium tracking-wide">{{ isApiUrlSaved ? '已保存' : '保存地址' }}</span>
        </SpecularButton>
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
