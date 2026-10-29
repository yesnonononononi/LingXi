<script setup lang="ts">
import { useGeneralTab } from './useGeneralTab';
import { useTheme } from '../../../composables/useTheme';
import { useI18n } from '../../../i18n';
import SpecularButton from '../../../components/common/SpecularButton.vue';
import SettingsSelect from '../../../components/common/SettingsSelect.vue';

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
  backgroundPreference,
  backgroundImageUrl,
  hasBackground,
  isBackgroundPicking,
  isBackgroundOpen,
  backgroundCurrentLabel,
  toggleBackgroundDropdown,
  handleSelectDefaultBackground,
  backgroundFitOptions,
  backgroundScrimPercent,
  handlePickBackground,
  handleClearBackground,
  handleSelectBackgroundFit,
  handleBackgroundScrimInput,
} = useGeneralTab();
</script>

<template>
  <div class="space-y-3" @click="closeGeneralDropdowns">
    <!-- 主题选项 -->
    <div>
      <div class="text-xs font-semibold text-lx-primary-soft dark:text-glow-subtle mb-2.5 tracking-wide">{{ t('settings.general.theme') }}</div>
      <div class="grid grid-cols-3 gap-3">
        <!-- 浅色 -->
        <button
          type="button"
          @click="handleSelectTheme('light')"
          :class="[
            'px-4 py-3.5 rounded-2xl border flex flex-col items-center justify-center gap-2 transition cursor-pointer',
            themeMode === 'light'
              ? (isDark ? 'bg-zinc-900/90 border-white/40 shadow-[0_0_15px_rgba(255,255,255,0.1)] text-white font-semibold dark:text-glow-white' : 'bg-zinc-100 border-zinc-300 text-zinc-900 font-semibold shadow-sm')
              : (isDark ? 'border-white/10 text-zinc-400 bg-black/40 hover:border-white/20 hover:bg-white/[0.04]' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50')
          ]"
        >
          <svg class="w-5 h-5 text-lx-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
              ? (isDark ? 'bg-zinc-900/90 border-white/40 shadow-[0_0_20px_rgba(255,255,255,0.12)] text-white font-semibold dark:text-glow-white' : 'bg-zinc-100 border-zinc-300 text-zinc-900 font-semibold shadow-sm')
              : (isDark ? 'border-white/10 text-zinc-400 bg-black/40 hover:border-white/20 hover:bg-white/[0.04]' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50')
          ]"
        >
          <svg class="w-5 h-5 text-lx-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
              ? (isDark ? 'bg-zinc-900/90 border-white/40 shadow-[0_0_20px_rgba(255,255,255,0.12)] text-white font-semibold dark:text-glow-white' : 'bg-zinc-100 border-zinc-300 text-zinc-900 font-semibold shadow-sm')
              : (isDark ? 'border-white/10 text-zinc-400 bg-black/40 hover:border-white/20 hover:bg-white/[0.04]' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50')
          ]"
        >
          <svg class="w-5 h-5 text-lx-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <span class="text-xs">{{ t('settings.general.themeSystem') }}</span>
        </button>
      </div>
    </div>

    <!-- 主页背景：外观偏好，只在本机（不进后端配置），与主题 / 语言 / 提示音同类 -->
    <!-- 文件名必须可收缩，不能挤掉自定义与清除按钮。 -->
    <!-- 全部使用 lx 令牌类，不写颜色字面量：既不增加门禁残余，也自动跟随亮/暗主题，无需 isDark 分支 -->
    <div class="background-settings" data-testid="background-settings">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-col min-w-0 w-full">
          <span class="text-xs font-medium text-lx-primary-soft">{{ t('settings.general.background') }}</span>
          <span class="text-[11px] text-lx-muted mt-0.5 leading-relaxed">{{ t('settings.general.backgroundDesc') }}</span>
        </div>
        <div class="flex items-center gap-2 w-full min-w-0">
          <!-- 选择器：缩略图 + 当前值 + chevron，点开是「默认背景 / 自定义图片」两项 -->
          <div class="relative general-dropdown-container flex-1 min-w-0" @click.stop>
            <button
              type="button"
              data-testid="background-picker"
              @click="toggleBackgroundDropdown"
              class="flex items-center gap-2 pl-2 pr-2.5 py-1.5 rounded-xl border border-lx-border-subtle bg-lx-surface-sunken hover:bg-lx-surface-hover transition cursor-pointer w-full min-w-0"
            >
              <!-- 缩略图：有背景显示真实图，无背景显示令牌色块占位，避免选择器看起来是空的 -->
              <span class="w-10 h-7 rounded-lg overflow-hidden shrink-0 border border-lx-border-faint bg-lx-surface-active">
                <img v-if="backgroundImageUrl" :src="backgroundImageUrl" class="w-full h-full object-cover" alt="" />
              </span>
              <span class="text-xs text-lx-primary truncate flex-1 text-left">{{ backgroundCurrentLabel }}</span>
              <svg
                class="w-3 h-3 shrink-0 text-lx-muted transition-transform duration-200"
                :class="{ 'rotate-180': isBackgroundOpen }"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            <transition name="dropdown-down">
              <div
                v-if="isBackgroundOpen"
                class="absolute right-0 mt-1.5 w-52 rounded-xl border border-lx-border bg-lx-surface-elevated shadow-2xl py-1 z-30 text-xs origin-top"
              >
                <div
                  @click="handleSelectDefaultBackground"
                  class="px-3 py-1.5 cursor-pointer flex items-center justify-between transition-colors hover:bg-lx-surface-hover"
                  :class="!hasBackground ? 'text-lx-accent font-medium bg-lx-accent-soft' : 'text-lx-secondary'"
                >
                  <span>{{ t('settings.general.backgroundDefault') }}</span>
                  <svg v-if="!hasBackground" class="w-3.5 h-3.5 text-lx-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div
                  @click="handlePickBackground"
                  class="px-3 py-1.5 cursor-pointer flex items-center justify-between transition-colors hover:bg-lx-surface-hover"
                  :class="hasBackground ? 'text-lx-accent font-medium bg-lx-accent-soft' : 'text-lx-secondary'"
                >
                  <span>{{ t('settings.general.backgroundPick') }}</span>
                  <svg v-if="hasBackground" class="w-3.5 h-3.5 text-lx-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
              </div>
            </transition>
          </div>
          <!-- 自定义：与选择器同义但更直白（保留一键直达，省一次展开） -->
          <button
            type="button"
            :disabled="isBackgroundPicking"
            @click="handlePickBackground"
            data-testid="background-custom"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-lx-border-subtle text-xs text-lx-primary hover:bg-lx-surface-hover transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            <svg class="w-3.5 h-3.5 text-lx-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14M4 6h16a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V7a1 1 0 011-1z" />
            </svg>
            {{ t('settings.general.backgroundCustom') }}
          </button>
          <!-- 清除：图标按钮，无背景时禁用 -->
          <button
            type="button"
            :disabled="!hasBackground"
            :title="t('settings.general.backgroundClear')"
            :aria-label="t('settings.general.backgroundClear')"
            @click="handleClearBackground"
            data-testid="background-clear"
            class="p-2 rounded-xl border border-lx-border-subtle text-lx-muted hover:text-lx-danger hover:bg-lx-surface-hover transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          >
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
            </svg>
          </button>
        </div>
      </div>
      <!-- 第二行：填充方式 + 遮罩强度（无背景时两者禁用但保留原位，避免布局跳动） -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
        <div class="min-w-0 space-y-1.5">
          <label for="background-fit" class="text-[11px] text-lx-muted">{{ t('settings.general.backgroundFit') }}</label>
          <SettingsSelect
            id="background-fit"
            :label="t('settings.general.backgroundFit')"
            :model-value="backgroundPreference?.fit ?? 'cover'"
            :options="backgroundFitOptions.map(option => ({ value: option.value, label: t(option.labelKey) }))"
            :disabled="!hasBackground"
            @update:model-value="handleSelectBackgroundFit($event === 'contain' ? 'contain' : 'cover')"
          />
        </div>
        <div class="min-w-0 space-y-1.5">
          <label for="background-scrim" class="text-[11px] text-lx-muted">{{ t('settings.general.backgroundScrim') }}</label>
          <div class="background-scrim-control" :class="{ 'is-disabled': !hasBackground }"
            :style="{ '--scrim-progress': `${backgroundScrimPercent}%` }">
            <input id="background-scrim" type="range" min="0" max="100" step="5"
              class="lx-background-scrim-range" :aria-label="t('settings.general.backgroundScrim')"
              :aria-valuetext="`${backgroundScrimPercent}%`" :value="backgroundScrimPercent"
              :disabled="!hasBackground" @input="handleBackgroundScrimInput" />
            <output for="background-scrim" class="background-scrim-value">{{ backgroundScrimPercent }}%</output>
          </div>
        </div>
      </div>
    </div>

    <!-- 语言 -->
    <div class="flex items-center justify-between">
      <span class="text-xs font-medium text-lx-primary-soft dark:text-glow-subtle">{{ t('settings.general.language') }}</span>
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
            class="w-3 h-3 text-zinc-400 dark:text-zinc-300 transition-transform duration-200"
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
              isDark ? 'bg-black/95 border-white/20 text-zinc-100 shadow-[0_8px_32px_rgba(0,0,0,0.9)]' : 'bg-white border-zinc-200 text-zinc-800'
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
                  : (isDark ? 'text-zinc-200 hover:bg-white/10 hover:text-white' : 'text-zinc-700 hover:bg-zinc-100')
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

    <!-- 通知提示音：只影响自绘通知卡片，Web 端没有桌面通知所以选了也不会响 -->
    <div class="pt-3">
      <div class="flex items-center justify-between">
        <div class="flex flex-col">
          <span class="text-xs font-medium text-lx-primary-soft dark:text-glow-subtle">{{ t('settings.general.notifySound') }}</span>
          <span class="text-[11px] text-zinc-400 dark:text-zinc-400 mt-0.5">{{ t('settings.general.notifySoundDesc') }}</span>
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
              class="w-3 h-3 text-zinc-400 dark:text-zinc-300 transition-transform duration-200"
              :class="{ 'rotate-180': isSoundOpen }"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </SpecularButton>
          <transition name="dropdown-down">
            <div
              v-if="isSoundOpen"
              :class="[
                'absolute right-0 mt-1.5 w-36 rounded-xl border shadow-2xl py-1 z-30 text-xs origin-top backdrop-blur-xl',
                isDark ? 'bg-black/95 border-white/20 text-zinc-100 shadow-[0_8px_32px_rgba(0,0,0,0.9)]' : 'bg-white border-zinc-200 text-zinc-800'
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
                    : (isDark ? 'text-zinc-200 hover:bg-white/10 hover:text-white' : 'text-zinc-700 hover:bg-zinc-100')
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

    <!-- 后端服务地址配置 (桌面客户端 / 局域网服务)：入口地址属于「最后才折腾」的那类设置，放最下方 -->
    <div>
      <div class="flex items-center justify-between mb-2">
        <div class="flex flex-col">
          <span class="text-xs font-medium text-lx-primary-soft dark:text-glow-subtle">{{ t('settings.general.apiBaseUrl') }}</span>
          <span class="text-[11px] text-zinc-400 dark:text-zinc-400 mt-0.5">{{ t('settings.general.apiBaseUrlDesc') }}</span>
        </div>
        <button
          type="button"
          @click="handleResetApiUrl"
          class="text-[11px] text-lx-muted hover:text-blue-500 dark:hover:text-cyan-300 dark:hover:text-glow-cyan cursor-pointer transition"
        >
          {{ t('settings.general.resetApiUrl') }}
        </button>
      </div>
      <div class="flex items-center gap-2">
        <input
          v-model="apiBaseUrl"
          type="text"
          placeholder="http://localhost:8088"
          class="flex-1 min-w-0 px-3 py-2 text-xs rounded-xl border border-zinc-200 dark:border-white/15 bg-white dark:bg-black/60 text-zinc-900 dark:text-zinc-100 focus:outline-none focus:border-blue-500 dark:focus:border-cyan-400 focus:ring-1 focus:ring-blue-500 dark:focus:ring-cyan-400 transition"
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
  </div>
</template>

<style scoped>
.background-settings {
  padding: 12px;
  border: 1px solid var(--lx-border-subtle);
  border-radius: var(--lx-radius-md);
  background: var(--lx-surface-hover);
}
.background-scrim-control {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 36px;
  padding: 0 12px;
  border: 1px solid var(--lx-border-default);
  border-radius: var(--lx-radius-md);
  background: var(--lx-surface-sunken);
  transition: border-color 160ms ease, box-shadow 160ms ease;
}
.background-scrim-control:focus-within {
  border-color: var(--lx-border-strong);
  box-shadow: 0 0 0 2px var(--lx-surface-active);
}
.background-scrim-control.is-disabled { opacity: 0.4; }
.background-scrim-value {
  min-width: 32px;
  color: var(--lx-text-primary-soft);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
/* 只改变控件外观，进度来自同一份偏好，不另存滑杆状态。 */
.lx-background-scrim-range {
  appearance: none;
  flex: 1;
  min-width: 0;
  height: 4px;
  border-radius: var(--lx-radius-full);
  background: linear-gradient(to right, var(--lx-text-primary) var(--scrim-progress), var(--lx-border-strong) var(--scrim-progress));
  outline: none;
  cursor: pointer;
}
.lx-background-scrim-range::-webkit-slider-thumb {
  appearance: none;
  width: 13px;
  height: 13px;
  border: 2px solid var(--lx-surface-sunken);
  border-radius: var(--lx-radius-full);
  background: var(--lx-text-primary);
  box-shadow: 0 0 0 1px var(--lx-border-strong), 0 0 10px color-mix(in srgb, var(--lx-text-primary) 20%, transparent);
}
.lx-background-scrim-range::-moz-range-thumb {
  width: 9px;
  height: 9px;
  border: 2px solid var(--lx-surface-sunken);
  border-radius: var(--lx-radius-full);
  background: var(--lx-text-primary);
  box-shadow: 0 0 0 1px var(--lx-border-strong);
}
.lx-background-scrim-range:disabled { cursor: not-allowed; }
@media (prefers-reduced-motion: reduce) {
  .background-scrim-control { transition: none; }
}

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
</style>
