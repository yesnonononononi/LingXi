<script setup lang="ts">
import { computed, useId } from 'vue';
import { useI18n } from '../../../i18n';
import { useCompactionTab } from './useCompactionTab';
import SettingsSelect from '../../../components/common/SettingsSelect.vue';

/**
 * 压缩模型配置页。
 *
 * <p>配色一律走 {@code lx-*} 令牌，不写 zinc/white 字面量：这个仓有「残余灰阶不得上涨」的门禁，
 * 新增页面上手就写 zinc 等于给基线偷偷加债务（本页初版曾 +51 项）。</p>
 */
defineProps<{
  isDark?: boolean;
}>();

const emit = defineEmits<{
  (e: 'back'): void;
  (e: 'openModels'): void;
}>();

const { t } = useI18n();
const id = useId();
const {
  params,
  loading,
  loadError,
  paramsError,
  saveError,
  options,
  readyModels,
  selectedId,
  enabled,
  disabled,
  dangling,
  missingCredential,
  load,
  toggle,
  choose,
} = useCompactionTab();

const cardClass = 'rounded-2xl border p-4 space-y-3 transition-colors bg-lx-surface-sunken border-lx-border-subtle';
const titleClass = 'text-sm font-bold tracking-tight text-lx-primary';
const hintClass = 'text-[11px] leading-relaxed text-lx-muted';
const badgeClass = computed(() => [
  'text-[10px] px-1.5 py-0.5 rounded-full border tracking-tight shrink-0',
  enabled.value ? 'border-lx-success text-lx-success bg-lx-success-soft' : 'border-lx-border text-lx-muted',
]);
const switchClass = computed(() => [
  'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition cursor-pointer disabled:cursor-not-allowed disabled:opacity-50',
  enabled.value ? 'bg-lx-accent' : 'bg-lx-surface-active',
]);
const ghostBtnClass =
  'px-3 py-1 rounded-lg border text-xs font-medium transition cursor-pointer border-lx-border text-lx-secondary hover:bg-lx-surface-hover';
const trackClass = 'h-1.5 w-full rounded-full overflow-hidden bg-lx-surface-active';
const fillClass = 'h-full rounded-full bg-lx-accent';

/** 参数展示值：缺失时显示 —，不要伪造一个看起来正常的数字。 */
const ratioText = computed(() => (params.value?.modelThreshold == null ? '—' : params.value.modelThreshold.toFixed(2)));
const attemptsText = computed(() => (params.value == null ? '—' : String(params.value.maxSummaryAttempts ?? 1)));
const maxTokensText = computed(() => (params.value?.compactMaxTokens == null ? '—' : String(params.value.compactMaxTokens)));

/** 阈值滑块填充比：0.5~1.0 映射到 0~100%，越界夹住。 */
const ratioFill = computed(() => {
  const value = params.value?.modelThreshold;
  if (value == null) return 0;
  return Math.max(0, Math.min(1, (value - 0.5) / 0.5)) * 100;
});
const attemptsFill = computed(() => {
  const value = params.value?.maxSummaryAttempts ?? 1;
  return Math.max(0, Math.min(1, (value - 1) / 4)) * 100;
});
const maxTokensFill = computed(() => {
  const value = params.value?.compactMaxTokens;
  if (value == null) return 0;
  return Math.max(0, Math.min(1, value / 65536)) * 100;
});
</script>

<template>
  <div class="space-y-4" data-testid="compaction-settings">
    <div class="flex items-center gap-2 min-w-0">
      <button
        type="button"
        data-testid="compaction-back"
        :title="t('settings.compaction.back')"
        class="p-1 rounded-lg transition cursor-pointer text-lx-muted hover:text-lx-primary hover:bg-lx-surface-hover"
        @click="emit('back')"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <div class="min-w-0">
        <h4 :class="titleClass">{{ t('settings.compaction.title') }}</h4>
        <p :class="hintClass">{{ t('settings.compaction.subtitle') }}</p>
      </div>
    </div>

    <div v-if="loadError" class="py-4 text-center text-xs border border-dashed rounded-2xl border-lx-border-subtle">
      <div class="text-lx-danger">{{ loadError }}</div>
      <button type="button" class="mt-2 underline cursor-pointer text-lx-muted" @click="load">
        {{ t('settings.compaction.retry') }}
      </button>
    </div>

    <template v-else>
      <!-- 压缩模型：开关与「选了哪个模型」是同一件事 -->
      <section :class="cardClass" data-testid="compaction-model-card">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <h5 :class="titleClass">{{ t('settings.compaction.sectionModel') }}</h5>
            <p :class="hintClass">{{ t('settings.compaction.sectionModelDesc') }}</p>
          </div>
          <div class="flex items-center gap-2 shrink-0">
            <span :class="badgeClass">{{ enabled ? t('settings.compaction.enabled') : t('settings.compaction.disabled') }}</span>
            <button
              type="button"
              role="switch"
              data-testid="compaction-switch"
              :aria-checked="enabled"
              :aria-label="t('settings.compaction.toggleLabel')"
              :disabled="disabled || !readyModels.length"
              :class="switchClass"
              @click="toggle(!enabled)"
            >
              <span :class="['absolute h-4 w-4 rounded-full bg-lx-on-accent shadow transition', enabled ? 'translate-x-4' : 'translate-x-1']" />
            </button>
          </div>
        </div>

        <div v-if="loading" class="text-[11px] text-lx-faint">{{ t('settings.compaction.loading') }}</div>

        <div v-else-if="options.length">
          <SettingsSelect
            :id="`${id}-compact-model`"
            :label="t('settings.compaction.choose')"
            :model-value="selectedId"
            :options="options"
            :disabled="disabled"
            data-testid="compaction-model-select"
            @update:model-value="choose"
          />
        </div>

        <!-- 一个可用模型都没有：直接给去模型页的入口，而不是让人对着空下拉干瞪眼 -->
        <div v-else class="py-3 text-center text-xs">
          <div class="text-lx-secondary">{{ t('settings.compaction.empty') }}</div>
          <p :class="hintClass">{{ t('settings.compaction.emptyHelp') }}</p>
          <button type="button" :class="ghostBtnClass + ' mt-2'" @click="emit('openModels')">
            {{ t('settings.compaction.addModel') }}
          </button>
        </div>

        <p v-if="dangling" class="text-[11px] text-lx-warning">{{ t('settings.compaction.unavailable') }}</p>
        <p v-if="missingCredential" class="text-[11px] text-lx-warning">{{ t('settings.compaction.missingKey') }}</p>
        <p v-if="saveError" class="text-[11px] text-lx-danger" role="alert">{{ saveError }}</p>
      </section>

      <!-- 高级设置：真值只读，滑块只是把数字可视化 -->
      <section :class="cardClass" data-testid="compaction-advanced-card">
        <div class="min-w-0">
          <h5 :class="titleClass">{{ t('settings.compaction.sectionAdvanced') }}</h5>
          <p :class="hintClass">{{ t('settings.compaction.sectionAdvancedDesc') }}</p>
        </div>

        <div class="space-y-3">
          <div v-if="paramsError" class="text-xs text-lx-danger" role="alert">
            {{ paramsError }}
            <button type="button" class="ml-1 underline cursor-pointer text-lx-muted" @click="load">
              {{ t('settings.compaction.retry') }}
            </button>
          </div>
          <template v-else>
          <div class="space-y-1.5">
            <div class="flex items-baseline justify-between gap-2">
              <span class="text-xs font-medium text-lx-secondary">{{ t('settings.compaction.threshold') }}</span>
              <span class="text-xs font-mono text-lx-primary">{{ ratioText }}</span>
            </div>
            <div :class="trackClass" role="img" :aria-label="`${t('settings.compaction.threshold')} ${ratioText}`">
              <div :class="fillClass" :style="{ width: `${ratioFill}%` }" />
            </div>
            <p :class="hintClass">{{ t('settings.compaction.thresholdHelp') }}</p>
          </div>

          <div class="space-y-1.5">
            <div class="flex items-baseline justify-between gap-2">
              <span class="text-xs font-medium text-lx-secondary">{{ t('settings.compaction.attempts') }}</span>
              <span class="text-xs font-mono text-lx-primary">{{ attemptsText }} {{ t('settings.compaction.unitTimes') }}</span>
            </div>
            <div :class="trackClass" role="img" :aria-label="`${t('settings.compaction.attempts')} ${attemptsText}`">
              <div :class="fillClass" :style="{ width: `${attemptsFill}%` }" />
            </div>
            <p :class="hintClass">{{ t('settings.compaction.attemptsHelp') }}</p>
          </div>

          <div class="space-y-1.5">
            <div class="flex items-baseline justify-between gap-2">
              <span class="text-xs font-medium text-lx-secondary">{{ t('settings.compaction.maxTokens') }}</span>
              <span class="text-xs font-mono text-lx-primary">{{ maxTokensText }} {{ t('settings.compaction.unitTokens') }}</span>
            </div>
            <div :class="trackClass" role="img" :aria-label="`${t('settings.compaction.maxTokens')} ${maxTokensText}`">
              <div :class="fillClass" :style="{ width: `${maxTokensFill}%` }" />
            </div>
            <p :class="hintClass">{{ t('settings.compaction.maxTokensHelp') }}</p>
          </div>
          </template>
        </div>
      </section>
    </template>
  </div>
</template>
