<script setup lang="ts">
import {computed, useId} from 'vue';
import {useI18n} from '../../../i18n';
import {useCompactionTab} from './useCompactionTab';
import SettingsSelect from '../../../components/common/SettingsSelect.vue';

/**
 * 其它模型配置页：统一以分组卡片承载多用途专用模型指定（生图 / 指令预测 / 上下文压缩，
 * 以及后续可扩展的命令审批等用途），配色与间距对齐 GeneralTab 的 lx-* 令牌规范。
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
  purposeItems,
  params,
  loading,
  loadError,
  paramsError,
  imageDisabled,
  imageLimitDraft,
  load,
  saveImageLimit,
} = useCompactionTab();

const cardClass = 'rounded-2xl border border-lx-border-subtle';
const titleClass = 'text-xs font-semibold text-lx-primary-soft dark:text-glow-subtle';
const hintClass = 'text-lx-fs-sm leading-relaxed text-lx-muted';
const ghostBtnClass =
  'h-8 px-3 rounded-xl border text-xs font-medium transition cursor-pointer border-lx-border text-lx-secondary hover:bg-lx-surface-hover';
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
    <div class="flex items-center gap-2.5 min-w-0 pb-1">
      <button
        type="button"
        data-testid="compaction-back"
        :title="t('settings.compaction.back')"
        class="p-1.5 rounded-xl transition cursor-pointer text-lx-muted hover:text-lx-primary hover:bg-lx-surface-hover shrink-0"
        @click="emit('back')"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
      </button>
      <div class="min-w-0">
        <h4 class="text-sm font-bold tracking-tight text-lx-primary">{{ t('settings.compaction.title') }}</h4>
        <p :class="hintClass">{{ t('settings.compaction.subtitle') }}</p>
      </div>
    </div>

    <div v-if="loadError" class="py-6 text-center text-xs border border-dashed rounded-2xl border-lx-border-subtle">
      <div class="text-lx-danger">{{ loadError }}</div>
      <button type="button" class="mt-2 underline cursor-pointer text-lx-muted" @click="load">
        {{ t('settings.compaction.retry') }}
      </button>
    </div>

    <template v-else>
      <!-- 专用模型指定：统一分组卡片 + 细分割线，新增用途（如命令审批模型）只需追加 purposeItems -->
      <section :class="cardClass" data-testid="model-purposes-card">
        <div
          v-for="(item, index) in purposeItems"
          :key="item.key"
          :data-testid="item.testIdCard"
          :class="['px-4 py-3.5 space-y-2.5', index > 0 ? 'border-t border-lx-border-faint' : '']"
        >
          <!-- 主行：左标题/状态/说明，右统一控件（开关 + 定宽下拉） -->
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 min-w-0">
                <h5 class="text-xs font-medium text-lx-primary-soft truncate">{{ item.title }}</h5>
                <span
                  v-if="item.toggle"
                  class="text-lx-fs-xs px-1.5 py-0.5 rounded-full border tracking-tight shrink-0"
                  :class="item.toggle.enabled ? 'border-lx-success text-lx-success bg-lx-success-soft' : 'border-lx-border text-lx-muted'"
                >
                  {{ item.toggle.badgeText }}
                </span>
              </div>
              <p :class="[hintClass, 'mt-0.5']">{{ item.description }}</p>
            </div>

            <div class="flex items-center gap-2.5 shrink-0">
              <button
                v-if="item.toggle"
                type="button"
                role="switch"
                :data-testid="item.toggle.testId"
                :aria-checked="item.toggle.enabled"
                :aria-label="item.toggle.ariaLabel"
                :disabled="item.toggle.disabled"
                :class="[
                  'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition cursor-pointer disabled:cursor-not-allowed disabled:opacity-50',
                  item.toggle.enabled ? 'bg-lx-accent' : 'bg-lx-surface-active',
                ]"
                @click="item.toggle.onToggle(!item.toggle.enabled)"
              >
                <span :class="['absolute h-4 w-4 rounded-full bg-lx-on-accent shadow transition', item.toggle.enabled ? 'translate-x-4' : 'translate-x-1']" />
              </button>

              <div v-if="item.key === 'compaction' && loading" class="text-lx-fs-sm text-lx-faint">
                {{ t('settings.compaction.loading') }}
              </div>
              <div v-else-if="item.options.length" class="w-full sm:w-52 shrink-0">
                <SettingsSelect
                  :id="`${id}-${item.key}-model`"
                  :label="item.chooseLabel"
                  :model-value="item.selectedId"
                  :options="item.options"
                  :disabled="item.disabled"
                  :data-testid="item.testIdSelect"
                  @update:model-value="item.onSelect"
                />
              </div>
            </div>
          </div>

          <!-- 专属附属配置扩展槽：生图每日/单轮调用上限 -->
          <div
            v-if="item.key === 'image'"
            class="flex items-center justify-between gap-4 pt-2 border-t border-lx-border-faint"
          >
            <div class="min-w-0">
              <label :for="`${id}-image-limit`" class="block text-xs font-medium text-lx-secondary">{{ t('settings.compaction.imageLimit') }}</label>
              <p :class="[hintClass, 'mt-0.5']">{{ t('settings.compaction.imageLimitHelp') }}</p>
            </div>
            <input
              :id="`${id}-image-limit`"
              v-model="imageLimitDraft"
              type="number"
              min="0"
              max="20"
              step="1"
              :disabled="imageDisabled"
              data-testid="image-generation-limit"
              class="h-9 w-24 shrink-0 rounded-xl border border-lx-border bg-lx-surface-sunken px-3 text-xs text-lx-primary text-right tabular-nums focus:outline-none focus:border-lx-border-strong focus:ring-2 focus:ring-lx-surface-active disabled:opacity-50 transition"
              @change="saveImageLimit"
            />
          </div>

          <!-- 无可用模型时的引导与行内警告/错误 -->
          <div v-if="item.emptyText && item.showAddModelGuide" class="text-xs space-y-1">
            <div class="text-lx-secondary">{{ item.emptyText }}</div>
            <p v-if="item.emptyHelp" :class="hintClass">{{ item.emptyHelp }}</p>
          </div>
          <p v-for="warning in item.warnings" :key="warning" class="text-lx-fs-sm text-lx-warning">{{ warning }}</p>
          <p v-if="item.error" class="text-lx-fs-sm text-lx-danger" role="alert">{{ item.error }}</p>
          <div v-if="item.showAddModelGuide">
            <button type="button" :class="ghostBtnClass" @click="emit('openModels')">{{ t('settings.compaction.addModel') }}</button>
          </div>
        </div>
      </section>

      <!-- 高级设置：真值只读，滑块只是把数字可视化 -->
      <section :class="[cardClass, 'p-4 space-y-3']" data-testid="compaction-advanced-card">
        <div class="min-w-0">
          <h5 :class="titleClass">{{ t('settings.compaction.sectionAdvanced') }}</h5>
          <p :class="[hintClass, 'mt-0.5']">{{ t('settings.compaction.sectionAdvancedDesc') }}</p>
        </div>

        <div class="space-y-3 pt-1 border-t border-lx-border-faint">
          <div v-if="paramsError" class="text-xs text-lx-danger pt-2" role="alert">
            {{ paramsError }}
            <button type="button" class="ml-1 underline cursor-pointer text-lx-muted" @click="load">
              {{ t('settings.compaction.retry') }}
            </button>
          </div>
          <template v-else>
            <div class="space-y-1.5 pt-2">
              <div class="flex items-baseline justify-between gap-2">
                <span class="text-xs font-medium text-lx-secondary">{{ t('settings.compaction.threshold') }}</span>
                <span class="text-xs font-mono text-lx-primary tabular-nums">{{ ratioText }}</span>
              </div>
              <div :class="trackClass" role="img" :aria-label="`${t('settings.compaction.threshold')} ${ratioText}`">
                <div :class="fillClass" :style="{ width: `${ratioFill}%` }" />
              </div>
              <p :class="hintClass">{{ t('settings.compaction.thresholdHelp') }}</p>
            </div>

            <div class="space-y-1.5">
              <div class="flex items-baseline justify-between gap-2">
                <span class="text-xs font-medium text-lx-secondary">{{ t('settings.compaction.attempts') }}</span>
                <span class="text-xs font-mono text-lx-primary tabular-nums">{{ attemptsText }} {{ t('settings.compaction.unitTimes') }}</span>
              </div>
              <div :class="trackClass" role="img" :aria-label="`${t('settings.compaction.attempts')} ${attemptsText}`">
                <div :class="fillClass" :style="{ width: `${attemptsFill}%` }" />
              </div>
              <p :class="hintClass">{{ t('settings.compaction.attemptsHelp') }}</p>
            </div>

            <div class="space-y-1.5">
              <div class="flex items-baseline justify-between gap-2">
                <span class="text-xs font-medium text-lx-secondary">{{ t('settings.compaction.maxTokens') }}</span>
                <span class="text-xs font-mono text-lx-primary tabular-nums">{{ maxTokensText }} {{ t('settings.compaction.unitTokens') }}</span>
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
