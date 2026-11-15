<script setup lang="ts">
import {useGeneralTab} from './useGeneralTab';
import {useI18n} from '../../../i18n';
import SettingsSelect from '../../../components/common/SettingsSelect.vue';
import type {LocalePreference} from '../../../i18n';
import type {FontScalePreset} from '../../../utils/enum';
import type {SoundId} from '../../../notification/sound';

defineProps<{
  isDark?: boolean;
}>();

const { t, preference } = useI18n();

const {
  themeMode,
  languageOptions,
  handleSelectLanguage,
  fontScaleOptions,
  fontScaleValue,
  fontScaleDisabled,
  handleSelectFontScale,
  apiBaseUrl,
  isApiUrlSaved,
  handleSaveApiUrl,
  handleResetApiUrl,
  closeGeneralDropdowns,
  handleSelectTheme,
  soundPref,
  soundOptions,
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
  <div class="space-y-4" @click="closeGeneralDropdowns">
    <!-- 主题选项 -->
    <section>
      <div class="text-xs font-semibold text-lx-primary-soft dark:text-glow-subtle mb-2.5 tracking-wide">{{ t('settings.general.theme') }}</div>
      <div class="grid grid-cols-3 gap-2.5">
        <!-- 浅色 -->
        <button
          type="button"
          @click="handleSelectTheme('light')"
          :class="[
            'px-3 py-3 rounded-2xl border flex flex-col items-center justify-center gap-1.5 transition cursor-pointer',
            themeMode === 'light'
              ? 'border-lx-border-strong bg-lx-surface-active text-lx-primary font-semibold shadow-sm'
              : 'border-lx-border-subtle text-lx-secondary hover:border-lx-border hover:bg-lx-surface-hover'
          ]"
        >
          <svg class="w-5 h-5" :class="themeMode === 'light' ? 'text-lx-primary' : 'text-lx-tertiary'" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
          </svg>
          <span class="text-xs">{{ t('settings.general.themeLight') }}</span>
        </button>

        <!-- 深色 -->
        <button
          type="button"
          @click="handleSelectTheme('dark')"
          :class="[
            'px-3 py-3 rounded-2xl border flex flex-col items-center justify-center gap-1.5 transition cursor-pointer',
            themeMode === 'dark'
              ? 'border-lx-border-strong bg-lx-surface-active text-lx-primary font-semibold shadow-sm'
              : 'border-lx-border-subtle text-lx-secondary hover:border-lx-border hover:bg-lx-surface-hover'
          ]"
        >
          <svg class="w-5 h-5" :class="themeMode === 'dark' ? 'text-lx-primary' : 'text-lx-tertiary'" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
          </svg>
          <span class="text-xs">{{ t('settings.general.themeDark') }}</span>
        </button>

        <!-- 跟随系统 -->
        <button
          type="button"
          @click="handleSelectTheme('system')"
          :class="[
            'px-3 py-3 rounded-2xl border flex flex-col items-center justify-center gap-1.5 transition cursor-pointer',
            themeMode === 'system'
              ? 'border-lx-border-strong bg-lx-surface-active text-lx-primary font-semibold shadow-sm'
              : 'border-lx-border-subtle text-lx-secondary hover:border-lx-border hover:bg-lx-surface-hover'
          ]"
        >
          <svg class="w-5 h-5" :class="themeMode === 'system' ? 'text-lx-primary' : 'text-lx-tertiary'" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <span class="text-xs">{{ t('settings.general.themeSystem') }}</span>
        </button>
      </div>
    </section>

    <!-- 主页背景：外观偏好，只在本机（不进后端配置），与主题 / 语言 / 提示音同类 -->
    <!-- 文件名必须可收缩，不能挤掉自定义与清除按钮。 -->
    <!-- 全部使用 lx 令牌类，不写颜色字面量：既不增加门禁残余，也自动跟随亮/暗主题，无需 isDark 分支 -->
    <section class="background-settings" data-testid="background-settings">
      <div class="flex flex-col min-w-0">
        <span class="text-xs font-medium text-lx-primary-soft">{{ t('settings.general.background') }}</span>
        <span class="text-lx-fs-sm text-lx-muted mt-0.5 leading-relaxed">{{ t('settings.general.backgroundDesc') }}</span>
      </div>
      <div class="flex items-center gap-2 mt-3 min-w-0">
        <!-- 选择器：缩略图 + 当前值 + chevron，点开是「默认背景 / 自定义图片」两项 -->
        <div class="relative general-dropdown-container flex-1 min-w-0" @click.stop>
          <button
            type="button"
            data-testid="background-picker"
            @click="toggleBackgroundDropdown"
            class="flex items-center gap-2.5 h-9 pl-1.5 pr-2.5 rounded-xl border border-lx-border-subtle bg-lx-surface-sunken hover:bg-lx-surface-hover transition cursor-pointer w-full min-w-0"
          >
            <!-- 缩略图：有背景显示真实图，无背景显示令牌色块占位，避免选择器看起来是空的 -->
            <span class="w-9 h-6 rounded-lg overflow-hidden shrink-0 border border-lx-border-faint bg-lx-surface-active">
              <img v-if="backgroundImageUrl" :src="backgroundImageUrl" class="w-full h-full object-cover" alt="" />
            </span>
            <span class="text-xs text-lx-primary truncate flex-1 text-left">{{ backgroundCurrentLabel }}</span>
            <svg
              class="w-3.5 h-3.5 shrink-0 text-lx-muted transition-transform duration-200"
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
          class="flex items-center gap-1.5 h-9 px-3 rounded-xl border border-lx-border-subtle text-xs text-lx-primary hover:bg-lx-surface-hover transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
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
          class="flex items-center justify-center w-9 h-9 rounded-xl border border-lx-border-subtle text-lx-muted hover:text-lx-danger hover:bg-lx-surface-hover transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
          </svg>
        </button>
      </div>
      <!-- 第二行：填充方式 + 遮罩强度（无背景时两者禁用但保留原位，避免布局跳动） -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
        <div class="min-w-0 space-y-1.5">
          <label for="background-fit" class="block text-lx-fs-sm text-lx-muted">{{ t('settings.general.backgroundFit') }}</label>
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
          <label for="background-scrim" class="block text-lx-fs-sm text-lx-muted">{{ t('settings.general.backgroundScrim') }}</label>
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
    </section>

    <!-- 界面与偏好：字号 / 语言 / 通知提示音统一收进分组卡片，与「填充方式」共用 SettingsSelect 控件 -->
    <section class="rounded-2xl border border-lx-border-subtle">
      <!-- 字体大小 -->
      <div class="flex items-center justify-between gap-4 px-4 py-3.5">
        <div class="flex flex-col min-w-0">
          <label for="general-font-scale" class="text-xs font-medium text-lx-primary-soft dark:text-glow-subtle">{{ t('settings.general.fontScale') }}</label>
          <span class="text-lx-fs-sm text-lx-muted mt-0.5">{{ t('settings.general.fontScaleDesc') }}</span>
        </div>
        <div class="w-36 shrink-0">
          <SettingsSelect
            id="general-font-scale"
            :label="t('settings.general.fontScale')"
            :model-value="fontScaleValue"
            :options="fontScaleOptions"
            :disabled="fontScaleDisabled"
            @update:model-value="handleSelectFontScale($event as FontScalePreset)"
          />
        </div>
      </div>

      <!-- 语言 -->
      <div class="flex items-center justify-between gap-4 px-4 py-3.5 border-t border-lx-border-faint">
        <label for="general-language" class="text-xs font-medium text-lx-primary-soft dark:text-glow-subtle">{{ t('settings.general.language') }}</label>
        <div class="w-36 shrink-0">
          <SettingsSelect
            id="general-language"
            :label="t('settings.general.language')"
            :model-value="preference"
            :options="languageOptions"
            @update:model-value="handleSelectLanguage($event as LocalePreference)"
          />
        </div>
      </div>

      <!-- 通知提示音：只影响自绘通知卡片，Web 端没有桌面通知所以选了也不会响 -->
      <div class="flex items-center justify-between gap-4 px-4 py-3.5 border-t border-lx-border-faint">
        <div class="flex flex-col min-w-0">
          <label for="general-notify-sound" class="text-xs font-medium text-lx-primary-soft dark:text-glow-subtle">{{ t('settings.general.notifySound') }}</label>
          <span class="text-lx-fs-sm text-lx-muted mt-0.5">{{ t('settings.general.notifySoundDesc') }}</span>
        </div>
        <div class="w-36 shrink-0">
          <SettingsSelect
            id="general-notify-sound"
            :label="t('settings.general.notifySound')"
            :model-value="soundPref"
            :options="soundOptions.map(option => ({ value: option.id, label: t(option.labelKey) }))"
            @update:model-value="handleSelectSound($event as SoundId)"
          />
        </div>
      </div>
    </section>

    <!-- 后端服务地址配置 (桌面客户端 / 局域网服务)：入口地址属于「最后才折腾」的那类设置，放最下方 -->
    <section class="rounded-2xl border border-lx-border-subtle p-4">
      <div class="flex items-start justify-between gap-4 mb-3">
        <div class="flex flex-col min-w-0">
          <label for="general-api-base-url" class="text-xs font-medium text-lx-primary-soft dark:text-glow-subtle">{{ t('settings.general.apiBaseUrl') }}</label>
          <span class="text-lx-fs-sm text-lx-muted mt-0.5">{{ t('settings.general.apiBaseUrlDesc') }}</span>
        </div>
        <button
          type="button"
          @click="handleResetApiUrl"
          class="text-lx-fs-sm text-lx-muted hover:text-lx-accent cursor-pointer transition shrink-0"
        >
          {{ t('settings.general.resetApiUrl') }}
        </button>
      </div>
      <div class="flex items-center gap-2">
        <input
          id="general-api-base-url"
          v-model="apiBaseUrl"
          type="text"
          placeholder="http://localhost:8088"
          class="flex-1 min-w-0 h-9 px-3 text-xs rounded-xl border border-lx-border bg-lx-surface-sunken text-lx-primary focus:outline-none focus:border-lx-border-strong focus:ring-2 focus:ring-lx-surface-active transition"
        />
        <button
          type="button"
          @click="handleSaveApiUrl"
          class="inline-flex items-center justify-center gap-1.5 h-9 px-4 rounded-xl text-xs font-medium text-lx-on-accent transition cursor-pointer shrink-0 active:scale-[0.98]"
          :class="isApiUrlSaved
            ? 'bg-lx-success'
            : 'bg-lx-accent hover:bg-lx-accent-hover'"
        >
          <svg v-if="isApiUrlSaved" class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
          </svg>
          <span>{{ isApiUrlSaved ? t('settings.general.apiUrlSaved') : t('settings.general.apiUrlSave') }}</span>
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.background-settings {
  padding: 16px;
  border: 1px solid var(--lx-border-subtle);
  border-radius: var(--lx-radius-lg, 16px);
  /* 分组容器不画填充：--lx-surface-hover 是交互反馈令牌，拿来当静态卡片底色，
     亮色下把弹窗白色面板压成灰块、暗色下又和 sunken 控件几乎同色，两头都丢层次。
     只留描边表达分组，底色交给父级，弹窗换主题/换背景时自然一致。 */
  background: transparent;
}
.background-scrim-control {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 36px;
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
  font-size: var(--lx-font-size-sm);
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
