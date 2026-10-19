<script setup lang="ts">
import { useGeneralTab } from './useGeneralTab';
import { useTheme } from '../../../composables/useTheme';
import { useI18n } from '../../../i18n';
import SpecularButton from '../../../components/common/SpecularButton.vue';

defineProps<{
  isDark?: boolean;
}>();

const { t, preference } = useI18n();
const { isDark } = useTheme();

const {
  themeMode,
  isLanguageOpen,
  languageOptions,
  currentLanguageLabel,
  handleSelectLanguage,
  apiBaseUrl,
  isApiUrlSaved,
  handleSaveApiUrl,
  handleResetApiUrl,
  toggleLanguageDropdown,
  closeGeneralDropdowns,
  handleSelectTheme,
  soundPref,
  soundOptions,
  currentSoundLabel,
  isSoundOpen,
  toggleSoundDropdown,
  handleSelectSound,
} = useGeneralTab();
</script>

<template>
  <div class="space-y-5" @click="closeGeneralDropdowns">
    <!-- 主题选项 -->
    <div>
      <div class="text-xs font-semibold text-gray-800 dark:text-zinc-100 dark:text-glow-subtle mb-2.5 tracking-wide">{{ t('settings.general.theme') }}</div>
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
          <span class="text-xs">{{ t('settings.general.themeLight') }}</span>
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
          <span class="text-xs">{{ t('settings.general.themeDark') }}</span>
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
          <span class="text-xs">{{ t('settings.general.themeSystem') }}</span>
        </button>
      </div>
    </div>

    <!-- 语言 -->
    <div class="flex items-center justify-between py-3 border-b border-gray-100 dark:border-white/10">
            <span class="text-xs font-medium text-gray-800 dark:text-zinc-100 dark:text-glow-subtle">{{ t('settings.general.language') }}</span>
      <div class="relative general-dropdown-container" @click.stop>
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
          <span class="text-xs font-normal">{{ currentLanguageLabel }}</span>
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
              :key="opt.value"
              @click="handleSelectLanguage(opt.value)"
              :class="[
                'px-3 py-1.5 cursor-pointer flex items-center justify-between transition-colors',
                preference === opt.value
                  ? (isDark ? 'text-sky-400 text-glow-cyan font-medium bg-white/10' : 'text-blue-500 font-medium bg-blue-50')
                  : (isDark ? 'text-zinc-200 hover:bg-white/10 hover:text-white' : 'text-gray-700 hover:bg-gray-100')
              ]"
            >
              <span>{{ opt.label }}</span>
              <svg v-if="preference === opt.value" class="w-3.5 h-3.5 text-blue-500 dark:text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
                    <span class="text-xs font-medium text-gray-800 dark:text-zinc-100 dark:text-glow-subtle">{{ t('settings.general.apiBaseUrl') }}</span>
          <span class="text-[11px] text-gray-400 dark:text-zinc-400 mt-0.5">{{ t('settings.general.apiBaseUrlDesc') }}</span>
        </div>
        <button
          type="button"
          @click="handleResetApiUrl"
          class="text-[11px] text-gray-500 hover:text-blue-500 dark:text-zinc-400 dark:hover:text-cyan-300 dark:hover:text-glow-cyan cursor-pointer transition"
        >
          {{ t('settings.general.resetApiUrl') }}
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
          <span class="text-xs font-medium tracking-wide">{{ isApiUrlSaved ? t('settings.general.apiUrlSaved') : t('settings.general.apiUrlSave') }}</span>
        </SpecularButton>
      </div>
    </div>

    <!-- 通知提示音：只影响自绘通知卡片，Web 端没有桌面通知所以选了也不会响 -->
    <div class="pt-3 border-t border-gray-100 dark:border-white/10">
      <div class="flex items-center justify-between">
        <div class="flex flex-col">
          <span class="text-xs font-medium text-gray-800 dark:text-zinc-100 dark:text-glow-subtle">{{ t('settings.general.notifySound') }}</span>
          <span class="text-[11px] text-gray-400 dark:text-zinc-400 mt-0.5">{{ t('settings.general.notifySoundDesc') }}</span>
        </div>
        <div class="relative general-dropdown-container" @click.stop>
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
            @click="toggleSoundDropdown"
          >
            <span class="text-xs font-normal">{{ currentSoundLabel }}</span>
            <svg
              class="w-3 h-3 text-gray-400 dark:text-zinc-300 transition-transform duration-200"
              :class="{ 'rotate-180': isSoundOpen }"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </SpecularButton>
          <transition name="dropdown-up">
            <div
              v-if="isSoundOpen"
              :class="[
                'absolute right-0 bottom-full mb-1.5 w-36 rounded-xl border shadow-2xl py-1 z-30 text-xs origin-bottom backdrop-blur-xl',
                isDark ? 'bg-black/95 border-white/20 text-zinc-100 shadow-[0_8px_32px_rgba(0,0,0,0.9)]' : 'bg-white border-gray-200 text-gray-800'
              ]"
            >
              <div
                v-for="option in soundOptions"
                :key="option.id"
                @click="handleSelectSound(option.id)"
                :class="[
                  'px-3 py-1.5 cursor-pointer flex items-center justify-between transition-colors',
                  soundPref === option.id
                    ? (isDark ? 'text-sky-400 text-glow-cyan font-medium bg-white/10' : 'text-blue-500 font-medium bg-blue-50')
                    : (isDark ? 'text-zinc-200 hover:bg-white/10 hover:text-white' : 'text-gray-700 hover:bg-gray-100')
                ]"
              >
                <span>{{ t(option.labelKey) }}</span>
                <svg v-if="soundPref === option.id" class="w-3.5 h-3.5 text-blue-500 dark:text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                </svg>
              </div>
            </div>
          </transition>
        </div>
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

/* 向上展开（底部靠近滚动区边缘的控件用，否则面板会被内容区裁掉） */
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
