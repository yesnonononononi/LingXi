<template>
  <LxModal
    :open="open"
    :aria-label="t('turnFileChanges.rollbackTitle')"
    overlay-class="z-[80] bg-black/45 backdrop-blur-sm"
    :panel-class="panelClass"
    transition-name="lx-modal"
    @close="emit('close')"
  >
    <div :class="['flex items-center justify-between gap-3', isDark ? 'text-zinc-200' : 'text-zinc-800']">
      <span class="text-lx-fs-md font-medium">{{ t('turnFileChanges.rollbackTitle') }}</span>
      <button
        type="button"
        data-testid="file-rollback-close"
        :class="['rounded px-1.5 py-0.5 text-lx-fs-sm', isDark ? 'hover:bg-white/10' : 'hover:bg-black/5']"
        @click="emit('close')"
      >✕</button>
    </div>

    <p :class="['mt-1 text-lx-fs-xs leading-relaxed', isDark ? 'text-zinc-400' : 'text-zinc-500']">
      {{ t('turnFileChanges.rollbackHint') }}
    </p>

    <div v-if="loading" :class="['mt-4 text-lx-fs-sm', isDark ? 'text-zinc-400' : 'text-zinc-500']">
      {{ t('turnFileChanges.rollbackRunning') }}
    </div>

    <div v-else-if="plan" class="mt-3 flex max-h-[22rem] flex-col gap-2 overflow-y-auto">
      <div v-if="!groups.restore.length && !groups.remove.length"
           data-testid="file-rollback-nothing"
           :class="['rounded-lg px-2 py-2 text-lx-fs-sm', isDark ? 'bg-white/5 text-zinc-300' : 'bg-black/5 text-zinc-600']">
        {{ t('turnFileChanges.rollbackNothing') }}
      </div>

      <section v-if="groups.restore.length" data-testid="file-rollback-restore">
        <div :class="['mb-1 text-lx-fs-xs font-medium', isDark ? 'text-zinc-400' : 'text-zinc-500']">
          {{ t('turnFileChanges.rollbackRestore', {count: String(groups.restore.length)}) }}
        </div>
        <label v-for="item in groups.restore" :key="item.filePath"
               :class="['flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-lx-fs-sm',
                        isDark ? 'text-zinc-200 hover:bg-white/5' : 'text-zinc-700 hover:bg-black/5']">
          <input type="checkbox" :value="item.filePath" v-model="selected" data-testid="file-rollback-check" />
          <span class="truncate">{{ item.filePath }}</span>
        </label>
      </section>

      <section v-if="groups.remove.length" data-testid="file-rollback-delete">
        <div :class="['mb-1 text-lx-fs-xs font-medium', isDark ? 'text-zinc-400' : 'text-zinc-500']">
          {{ t('turnFileChanges.rollbackDelete', {count: String(groups.remove.length)}) }}
        </div>
        <label v-for="item in groups.remove" :key="item.filePath"
               :class="['flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-lx-fs-sm',
                        isDark ? 'text-zinc-200 hover:bg-white/5' : 'text-zinc-700 hover:bg-black/5']">
          <input type="checkbox" :value="item.filePath" v-model="selected" data-testid="file-rollback-check" />
          <span class="truncate">{{ item.filePath }}</span>
        </label>
      </section>

      <section v-if="groups.skipped.length" data-testid="file-rollback-skipped">
        <div :class="['mb-1 text-lx-fs-xs font-medium', isDark ? 'text-zinc-400' : 'text-zinc-500']">
          {{ t('turnFileChanges.rollbackSkip', {count: String(groups.skipped.length)}) }}
        </div>
        <div v-for="item in groups.skipped" :key="item.filePath"
             class="flex items-start gap-2 px-1 py-0.5 text-lx-fs-xs"
             :class="isDark ? 'text-zinc-500' : 'text-zinc-400'">
          <span class="truncate">{{ item.filePath }}</span>
          <span class="shrink-0">{{ item.reason }}</span>
        </div>
      </section>
    </div>

    <div v-if="result" data-testid="file-rollback-result"
         :class="['mt-3 rounded-lg px-2 py-2 text-lx-fs-sm', isDark ? 'bg-white/5 text-zinc-200' : 'bg-black/5 text-zinc-700']">
      <div>{{ t('turnFileChanges.rollbackDone', {count: String(successCount)}) }}</div>
      <div v-if="failureCount" class="mt-1 text-[#b42c3f] dark:text-rose-400">
        {{ t('turnFileChanges.rollbackFailed', {count: String(failureCount)}) }}
      </div>
      <div :class="['mt-1 text-lx-fs-xs', isDark ? 'text-zinc-400' : 'text-zinc-500']">
        {{ t('turnFileChanges.rollbackBackupHint') }}
      </div>
    </div>

    <div class="mt-4 flex justify-end gap-2">
      <button type="button" data-testid="file-rollback-cancel"
              :class="['rounded-lg px-3 py-1.5 text-lx-fs-sm',
                       isDark ? 'text-zinc-300 hover:bg-white/10' : 'text-zinc-600 hover:bg-black/5']"
              @click="emit('close')">{{ t('turnFileChanges.rollbackCancel') }}</button>
      <button
        type="button"
        data-testid="file-rollback-confirm"
        :disabled="!canConfirm"
        :class="['rounded-lg px-3 py-1.5 text-lx-fs-sm font-medium',
                 canConfirm ? (isDark ? 'bg-rose-500/20 text-rose-200 hover:bg-rose-500/30'
                                      : 'bg-[#b42c3f]/10 text-[#b42c3f] hover:bg-[#b42c3f]/20')
                            : (isDark ? 'bg-white/5 text-zinc-500' : 'bg-black/5 text-zinc-400')]"
        @click="rollback"
      >{{ running ? t('turnFileChanges.rollbackRunning') : t('turnFileChanges.rollbackConfirm') }}</button>
    </div>
  </LxModal>
</template>

<script setup lang="ts">
/**
 * 按基线回滚的确认弹窗：先预览、再确认、最后逐条报结果。
 *
 * <p><b>跳过项必须前置展示</b>：等执行完再说「这几个没回滚」等于让用户以为都回去了。
 * 所以预览一进来就分三组列全，跳过的��因直接写在行尾。</p>
 *
 * <p><b>结果不做乐观渲染</b>：成功与失败都只认后端逐文件返回的 outcomes，
 * 不在这里假设「点了就是成功」。</p>
 */
import {computed, ref, watch} from 'vue';
import LxModal from '../common/LxModal.vue';
import {t} from '../../i18n';
import {FileRollbackAPI, type FileRollbackPlan, type FileRollbackResult} from '../../services/fileRollback';
import {groupRollbackPlan} from '../../utils/fileRollbackPlan';

const props = defineProps<{
  open: boolean;
  /** 执行标识：雪花 ID 按字符串传，避免精度丢失。 */
  executionId: string;
  isDark?: boolean;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'done'): void;
}>();

const loading = ref(false);
const running = ref(false);
const plan = ref<FileRollbackPlan | null>(null);
const selected = ref<string[]>([]);
const result = ref<FileRollbackResult | null>(null);

const groups = computed(() => groupRollbackPlan(plan.value));
/** 面板配色：LxModal 的 panelClass 只收字符串，拼好再传（传数组会命中类型校验告警）。 */
const panelClass = computed(() => 'w-full max-w-xl rounded-2xl border p-4 shadow-xl '
  + (props.isDark ? 'border-[#273043] bg-[#12161f]' : 'border-zinc-200 bg-white'));
const canConfirm = computed(() => !loading.value && !running.value && !result.value && selected.value.length > 0);
const successCount = computed(() => result.value?.outcomes.filter(item => item.success).length ?? 0);
const failureCount = computed(() => (result.value?.outcomes.length ?? 0) - successCount.value);

const load = async (): Promise<void> => {
  loading.value = true;
  result.value = null;
  plan.value = null;
  selected.value = [];
  try {
    const response = await FileRollbackAPI.preview(props.executionId);
    plan.value = response.data ?? null;
    selected.value = groupRollbackPlan(plan.value).defaultSelection;
  } finally {
    loading.value = false;
  }
};

const rollback = async (): Promise<void> => {
  if (!canConfirm.value) return;
  running.value = true;
  try {
    const response = await FileRollbackAPI.rollback(props.executionId, selected.value);
    result.value = response.data ?? null;
    emit('done');
  } finally {
    running.value = false;
  }
};

// 每次打开都重新拉预览：预览到确认之间文件可能又被改过，旧计划不能用。
watch(() => props.open, open => {
  if (open) void load();
});
</script>
