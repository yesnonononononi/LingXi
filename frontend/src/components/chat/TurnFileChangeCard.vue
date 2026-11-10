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
 * 轮次末尾的「本轮改动」清单：同一文件合并成一行显示净改动。
 *
 * <p>数字来自后端重算（差异依次重放回基线再整体做差异）：每次编辑的 +N/-M 是独立统计，
 * 同一行改两次会记两次；前端因此不做任何累加。</p>
 *
 * <p><b>只有最新轮次能点开差异</b>：契约规定历史轮次只保留增删行数。撤销功能整体暂缓，
 * 这里不再提供任何写操作入口。</p>
 */
import {computed, inject, onMounted, ref, watch} from 'vue';
import {t} from '../../i18n';
import {FILE_PREVIEW_KEY} from '../../types/filePreview';
import {resolveApiUrl} from '../../utils/apiConfig';
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
const notice = ref('');

const totals = computed(() => turnFileChangeTotals(rows.value));
/** 行内小标签配色：只区分「新建」和「多次修改」两种语义，不承载交互。 */
const chipClass = (tone: 'ok' | 'muted'): string => {
  const base = 'shrink-0 rounded px-1 py-0.5 text-lx-fs-xs leading-none';
  if (tone === 'ok') {
    return `${base} ${props.isDark ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-500/10 text-[#088f50]'}`;
  }
  return `${base} ${props.isDark ? 'bg-white/10 text-zinc-300' : 'bg-black/5 text-zinc-500'}`;
};
/** 加载中或有内容时保留卡片；空清单不占位。 */
const visible = computed(() => rows.value.length > 0);

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

/** 点行打开差异；历史轮次没有差异正文，行本身不可点。 */
const openDiff = (row: TurnFileChangeRow): void => {
  if (!row.edit) return;
  openFilePreview?.(props.sessionId, row.filePath, row.edit);
};

onMounted(loadSummary);
watch(() => props.turnId, () => {
  rows.value = [];
  notice.value = '';
  void loadSummary();
});
</script>
