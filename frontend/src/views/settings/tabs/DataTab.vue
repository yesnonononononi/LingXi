<script setup lang="ts">
import { computed, ref } from 'vue';
import { useConfirm } from '../../../composables/useConfirm';
import { useI18n } from '../../../i18n';
import { useUserConfigStore } from '../../../stores/userConfigStore';
import { openDirectoryPicker, relaunchApp } from '../../../utils/platform';
import { useExecutionCleanup } from './useExecutionCleanup';

const props = defineProps<{
  isDark?: boolean;
}>();

const { t } = useI18n();

const emit = defineEmits<{
  (e: 'clearSessions'): void;
}>();

const { confirm } = useConfirm();
const userConfig = useUserConfigStore();
const cleanup = useExecutionCleanup();

const isDark = computed(() => props.isDark === true);

/** 正在搬迁的字段：搬迁要搬几十上百 MB，必须有反馈并挡住重复点击。 */
const busyField = ref<'' | 'dataDir' | 'skillDir'>('');
const errorMsg = ref('');
const isRestarting = ref(false);

/**
 * 选目录并落库。
 *
 * <p>只走 store 的 patch（组件禁直调 UserConfigAPI）：搬迁、路径归一、待重启标记
 * 都由后端负责，前端只管把用户选的路径交上去。</p>
 */
const changeDirectory = async (field: 'dataDir' | 'skillDir'): Promise<void> => {
  if (busyField.value || cleanup.busy.value) return;
  errorMsg.value = '';
  const picked = await openDirectoryPicker();
  // 取消选择，或运行在浏览器里（没有原生选择器）：什么都不做，也不伪造路径。
  if (!picked) return;
  busyField.value = field;
  const ok = await userConfig.patch(field, picked, { [field]: picked });
  if (!ok) {
    errorMsg.value = field === 'dataDir'
      ? t('settings.data.errDataDirSave')
      : t('settings.data.errSkillDirSave');
  }
  busyField.value = '';
};

const restartNow = async (): Promise<void> => {
  if (isRestarting.value) return;
  errorMsg.value = '';
  isRestarting.value = true;
  const ok = await relaunchApp();
  if (!ok) {
    errorMsg.value = t('settings.data.restartUnsupported');
    isRestarting.value = false;
  }
};

const handleClearSessions = async () => {
  const ok = await confirm({
    title: t('settings.data.confirmTitle'),
    content: t('settings.data.confirmContent'),
    confirmText: t('settings.data.confirmText'),
    cancelText: t('common.cancel'),
    type: 'danger',
  });
  if (!ok) return;
  emit('clearSessions');
};
</script>

<template>
  <div class="space-y-4 text-xs">
    <!-- 存储目录：真能力（改了会搬迁现有内容），因此放在最前面 -->
    <div class="space-y-3">
      <div>
        <div class="text-xs font-semibold text-lx-primary-soft dark:text-glow-subtle tracking-wide">
          {{ t('settings.data.storageTitle') }}
        </div>
        <p class="text-[11px] text-zinc-400 mt-0.5">
          {{ t('settings.data.storageDesc') }}
        </p>
      </div>

      <!-- 数据目录 -->
      <div class="flex items-center justify-between gap-3 py-2">
        <div class="flex flex-col min-w-0">
          <span class="text-xs font-medium text-lx-primary-soft dark:text-glow-subtle">
            {{ t('settings.data.dataDirLabel') }}
          </span>
          <span class="text-[11px] text-zinc-400 dark:text-zinc-400 mt-0.5">
            {{ t('settings.data.dataDirDesc') }}
          </span>
          <span
            class="text-[11px] mt-0.5 truncate font-mono text-lx-tertiary"
            :title="userConfig.dataDir"
          >{{ userConfig.dataDir || '—' }}</span>
        </div>
        <button
          type="button"
          :disabled="busyField !== '' || cleanup.busy.value"
          @click="changeDirectory('dataDir')"
          class="shrink-0 px-3 py-1 rounded-full border text-xs transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          :class="isDark
            ? 'border-lx-border-strong text-lx-secondary hover:bg-white/5'
            : 'border-lx-border-strong text-lx-secondary hover:bg-zinc-50'"
        >
          {{ busyField === 'dataDir' ? t('settings.data.migrating') : t('settings.data.change') }}
        </button>
      </div>

      <!-- 技能目录 -->
      <div class="flex items-center justify-between gap-3 py-2 border-t border-lx-border-faint">
        <div class="flex flex-col min-w-0">
          <span class="text-xs font-medium text-lx-primary-soft dark:text-glow-subtle">
            {{ t('settings.data.skillDirLabel') }}
          </span>
          <span class="text-[11px] text-zinc-400 dark:text-zinc-400 mt-0.5">
            {{ t('settings.data.skillDirDesc') }}
          </span>
          <span
            class="text-[11px] mt-0.5 truncate font-mono text-lx-tertiary"
            :title="userConfig.skillDir"
          >{{ userConfig.skillDir || t('settings.data.skillDisabled') }}</span>
        </div>
        <button
          type="button"
          :disabled="busyField !== '' || cleanup.busy.value"
          @click="changeDirectory('skillDir')"
          class="shrink-0 px-3 py-1 rounded-full border text-xs transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          :class="isDark
            ? 'border-lx-border-strong text-lx-secondary hover:bg-white/5'
            : 'border-lx-border-strong text-lx-secondary hover:bg-zinc-50'"
        >
          {{ busyField === 'skillDir' ? t('settings.data.migrating') : t('settings.data.change') }}
        </button>
      </div>

      <!-- 待重启：进程还握着旧目录，此时继续对话写进去的数据不在新目录的副本里 -->
      <div
        v-if="userConfig.dataDirRestartRequired"
        class="p-3 rounded-xl border space-y-2"
        :class="isDark ? 'bg-lx-warning-soft border-amber-500/30' : 'bg-lx-warning-soft border-amber-200'"
      >
        <div class="text-xs font-semibold text-amber-600 dark:text-amber-400">
          {{ t('settings.data.restartTitle') }}
        </div>
        <p class="text-[11px] text-amber-600/90 dark:text-amber-400/90 leading-snug">
          {{ t('settings.data.restartDesc') }}
        </p>
        <button
          type="button"
          :disabled="isRestarting"
          @click="restartNow"
          class="px-3 py-1 rounded-full text-xs font-medium text-white bg-amber-600 hover:bg-amber-500 transition cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {{ isRestarting ? t('settings.data.restarting') : t('settings.data.restartNow') }}
        </button>
      </div>

      <div v-if="errorMsg" class="p-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-500 text-xs">
        {{ errorMsg }}
      </div>
    </div>

    <div class="h-px bg-zinc-100 dark:bg-white/10"></div>
    <section class="space-y-2" data-testid="execution-cleanup">
      <div class="flex items-center justify-between gap-3">
        <span class="text-zinc-800 dark:text-zinc-200">{{ cleanup.copy.value.title }}</span>
        <div class="flex shrink-0 gap-2">
          <button type="button" :disabled="cleanup.busy.value || busyField !== ''"
            @click="cleanup.load" data-testid="execution-cleanup-refresh"
            class="px-3 py-1 rounded-full border border-lx-border-strong text-lx-secondary text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
            {{ cleanup.copy.value.refresh }}
          </button>
          <button type="button" :disabled="!cleanup.canClean.value || busyField !== '' || userConfig.dataDirRestartRequired"
            @click="cleanup.cleanup" data-testid="execution-cleanup-run"
            class="px-3 py-1 rounded-full border border-lx-border-strong text-lx-secondary hover:bg-lx-surface-hover text-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
            {{ cleanup.busy.value && cleanup.count.value !== null ? cleanup.copy.value.cleaning : cleanup.copy.value.action }}
          </button>
        </div>
      </div>
      <p class="text-[11px] text-lx-tertiary">{{ cleanup.copy.value.description }}</p>
      <p v-if="cleanup.count.value !== null" class="text-[11px] text-lx-secondary" aria-live="polite">
        {{ cleanup.copy.value.count(cleanup.count.value) }}
      </p>
      <p v-else-if="cleanup.busy.value" class="text-[11px] text-lx-secondary">{{ cleanup.copy.value.loading }}</p>
      <p v-if="cleanup.deletedCount.value !== null" class="text-[11px] text-lx-secondary" role="status">
        {{ cleanup.copy.value.success(cleanup.deletedCount.value) }}
      </p>
      <p v-if="cleanup.error.value" class="text-[11px] text-red-500" role="alert">{{ cleanup.error.value }}</p>
    </section>

    <!-- 删除所有对话：真实能力（清空全部会话），保留并带二次确认 -->
    <div class="h-px bg-zinc-100 dark:bg-white/10"></div>
    <div class="flex items-center justify-between py-1.5">
      <span class="text-zinc-800 dark:text-zinc-200 dark:text-glow-subtle">{{ t('settings.data.clearAll') }}</span>
      <button
        type="button"
        @click="handleClearSessions"
        class="px-4 py-1 rounded-full border border-red-500/40 text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/15 text-xs transition cursor-pointer"
      >
        {{ t('settings.data.action') }}
      </button>
    </div>
  </div>
</template>
