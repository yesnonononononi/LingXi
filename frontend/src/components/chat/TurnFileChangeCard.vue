<template>
  <div
    v-if="visible"
    data-testid="turn-file-changes"
    :class="['w-full rounded-2xl border px-3 py-2.5 my-1.5 transition-colors',
             isDark ? 'border-[#273043] bg-[#12161f]' : 'border-zinc-200/90 bg-white']"
  >
    <div class="flex items-center justify-between gap-3">
      <div class="flex items-center gap-2 min-w-0">
        <span :class="['text-lx-fs-md font-medium', isDark ? 'text-zinc-200' : 'text-zinc-700']">
          {{ t('turnFileChanges.title') }}
        </span>
        <span v-if="rows.length" :class="['text-lx-fs-xs', isDark ? 'text-zinc-400' : 'text-zinc-500']">
          {{ t('turnFileChanges.fileCount', {count: String(rows.length)}) }}
        </span>
        <span v-if="rows.length" class="inline-flex items-center gap-1 font-mono text-lx-fs-md font-medium leading-none select-none">
          <span class="text-[#088f50] dark:text-emerald-400">+{{ totals.plusLines }}</span>
          <span class="text-[#b42c3f] dark:text-rose-400">-{{ totals.minusLines }}</span>
        </span>
      </div>
      <button
        v-if="rows.length"
        type="button"
        data-testid="turn-file-changes-undo"
        :class="actionClass('danger')"
        :disabled="undoing"
        @click="undoTurn"
      >
        {{ t('turnFileChanges.undoAll') }}
      </button>
    </div>

    <div v-if="rows.length" class="mt-2 flex flex-col gap-0.5 max-h-[16rem] overflow-y-auto">
      <component
        :is="row.edit ? 'button' : 'div'"
        v-for="row in rows"
        :key="row.filePath"
        :type="row.edit ? 'button' : undefined"
        :class="['flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left',
                 row.edit ? (isDark ? 'cursor-pointer hover:bg-white/5' : 'cursor-pointer hover:bg-black/5') : '']"
        data-testid="turn-file-changes-row"
        @click="openDiff(row)"
      >
        <span :class="['truncate text-lx-fs-sm', isDark ? 'text-zinc-200' : 'text-zinc-700']">
          {{ row.name }}
        </span>
        <span v-if="row.dir" :class="['truncate text-lx-fs-xs', isDark ? 'text-zinc-500' : 'text-zinc-400']">
          {{ row.dir }}
        </span>
        <span v-if="row.created" :class="chipClass('ok')">{{ t('turnFileChanges.created') }}</span>
        <span v-if="row.edits > 1" :class="chipClass('muted')">
          {{ t('turnFileChanges.edits', {count: String(row.edits)}) }}
        </span>
        <span class="ml-auto inline-flex shrink-0 items-center gap-1 font-mono text-lx-fs-sm leading-none select-none">
          <span class="text-[#088f50] dark:text-emerald-400">+{{ row.plusLines }}</span>
          <span class="text-[#b42c3f] dark:text-rose-400">-{{ row.minusLines }}</span>
        </span>
      </component>
    </div>

    <div v-if="notice" :class="['mt-1.5 text-lx-fs-xs', isDark ? 'text-zinc-400' : 'text-zinc-500']">
      {{ notice }}
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 轮次末尾的「本轮改动」清单：同一文件合并成一行显示净改动，可点开差异、可整轮撤销。
 *
 * <p>数字来自后端重算：每次编辑的 +N/-M 是独立统计，同一行改两次会记两次；
 * 只有后端拿「首条旧内容 vs 末条新内容」重算才是净改动。前端因此不做任何累加。</p>
 */
import {computed, inject, onMounted, ref, watch} from 'vue';
import {t} from '../../i18n';
import {FILE_PREVIEW_KEY} from '../../types/filePreview';
import {resolveApiUrl} from '../../utils/apiConfig';
import {isOk} from '../../utils/api';
import {actionClass, chipClass} from '../../utils/listCardTone';
import {
  buildTurnFileChangeRows,
  turnFileChangeTotals,
  type TurnFileChangeItem,
  type TurnFileChangeRow
} from '../../utils/turnFileChanges';

const props = defineProps<{
  turnId?: string | null;
  sessionId?: string | number;
  isDark?: boolean;
}>();

const openFilePreview = inject(FILE_PREVIEW_KEY, null);

const rows = ref<TurnFileChangeRow[]>([]);
const loading = ref(false);
const undoing = ref(false);
const notice = ref('');

const totals = computed(() => turnFileChangeTotals(rows.value));
/** 加载中、有内容或有提示时都保留卡片，避免「点完撤销整块消失」丢掉反馈。 */
const visible = computed(() => loading.value || rows.value.length > 0 || !!notice.value);

const endpoint = (suffix = ''): string =>
  resolveApiUrl(`/a/file-edits/turns/${encodeURIComponent(String(props.turnId))}${suffix}`);

const loadSummary = async (): Promise<void> => {
  if (!props.turnId) return;
  loading.value = true;
  try {
    const response = await fetch(endpoint('/summary'));
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json();
    rows.value = buildTurnFileChangeRows(body?.data as TurnFileChangeItem[]);
  } catch {
    // 读不到就整体不显示：空清单比一张报错卡片更不容易被误解成「本轮没有改动」。
    rows.value = [];
    notice.value = '';
  } finally {
    loading.value = false;
  }
};

const openDiff = (row: TurnFileChangeRow): void => {
  if (!row.edit) return;
  openFilePreview?.(props.sessionId, row.filePath, row.edit);
};

/**
 * 整轮撤销：逐条撤销会踩「同文件必须逆序还原」的顺序约束，所以一次交给后端按版本逆序处理。
 *
 * <p>失败原因原样透传：后端会在「文件在编辑后又被改过」时拒绝某些还原，
 * 把这层信息统一吞成「撤销失败」等于让用户不知道哪个文件没撤。</p>
 *
 * <p>不带 sessionId：还原目标工作空间由后端按轮次归属判定，客户端无权指定。</p>
 */
const undoTurn = async (): Promise<void> => {
  if (!props.turnId || undoing.value || rows.value.length === 0) return;
  if (!window.confirm(t('turnFileChanges.undoConfirm'))) return;
  undoing.value = true;
  notice.value = '';
  const count = rows.value.length;
  try {
    const response = await fetch(endpoint('/reject'), {method: 'POST'});
    const body = await response.json().catch(() => null);
    if (!response.ok || !isOk(body?.code)) throw new Error(body?.message ?? String(response.status));
    rows.value = [];
    notice.value = t('turnFileChanges.undoDone', {count: String(count)});
  } catch (error) {
    notice.value = t('turnFileChanges.undoFailed', {reason: (error as Error).message});
  } finally {
    undoing.value = false;
  }
};

onMounted(loadSummary);
watch(() => props.turnId, () => {
  rows.value = [];
  notice.value = '';
  void loadSummary();
});
</script>
