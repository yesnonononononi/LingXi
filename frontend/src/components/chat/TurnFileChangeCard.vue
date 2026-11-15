<template>
  <div
    v-if="rows.length"
    data-testid="turn-file-changes"
    :class="['w-full rounded-2xl border px-3 py-2.5 my-1.5 transition-colors',
             isDark ? 'border-[#273043] bg-[#12161f]' : 'border-zinc-200/90 bg-white']"
  >
    <div class="flex items-center justify-between gap-3">
      <div class="flex items-center gap-2 min-w-0">
        <span :class="['text-lx-fs-md font-medium', isDark ? 'text-zinc-200' : 'text-zinc-700']">
          {{ t('turnFileChanges.title') }}
        </span>
        <span :class="['text-lx-fs-xs', isDark ? 'text-zinc-400' : 'text-zinc-500']">
          {{ t('turnFileChanges.fileCount', {count: String(rows.length)}) }}
        </span>
        <span class="inline-flex items-center gap-1 font-mono text-lx-fs-md font-medium leading-none select-none">
          <span class="text-[#088f50] dark:text-emerald-400">+{{ totals.plusLines }}</span>
          <span class="text-[#b42c3f] dark:text-rose-400">-{{ totals.minusLines }}</span>
        </span>
      </div>
      <button
        v-if="rollbackExecutionId"
        type="button"
        data-testid="turn-file-changes-rollback"
        :class="['shrink-0 rounded-lg px-2 py-1 text-lx-fs-xs',
                 isDark ? 'text-zinc-300 hover:bg-white/10' : 'text-zinc-600 hover:bg-black/5']"
        @click="rollbackOpen = true"
      >{{ t('turnFileChanges.rollbackAction') }}</button>
    </div>

    <div class="mt-2 flex flex-col gap-0.5 max-h-[16rem] overflow-y-auto">
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
        <span v-if="row.rolledBack" data-testid="turn-file-changes-rolled-back" :class="chipClass('muted')">
          {{ t('turnFileChanges.rolledBack') }}
        </span>
        <span v-if="row.edits > 1" :class="chipClass('muted')">
          {{ t('turnFileChanges.edits', {count: String(row.edits)}) }}
        </span>
        <span class="ml-auto inline-flex shrink-0 items-center gap-1 font-mono text-lx-fs-sm leading-none select-none">
          <span class="text-[#088f50] dark:text-emerald-400">+{{ row.plusLines }}</span>
          <span class="text-[#b42c3f] dark:text-rose-400">-{{ row.minusLines }}</span>
        </span>
      </component>
    </div>

    <FileRollbackDialog
      v-if="rollbackExecutionId"
      :open="rollbackOpen"
      :executionId="rollbackExecutionId"
      :isDark="isDark"
      @close="rollbackOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
/**
 * 轮次末尾的「本轮改动」清单：同一文件合并成一行显示净改动。
 *
 * <p>数字来自后端重算（差异依次重放回基线再整体做差异）：每次编辑的 +N/-M 是独立统计，
 * 同一行改两次会记两次；前端因此不做任何累加。</p>
 *
 * <p><b>纯展示，不发请求</b>：清单随轮次视图（{@code TurnViewVO.fileChanges}）同帧到达。
 * 曾经这里在挂载后自己请求 {@code /a/file-edits/turns/{turnId}/summary}，于是加载会话时
 * 先按「无卡片」排版、滚到底，卡片数据回来后再长出一块高度，视图被强行顶走一段。
 * 数据与消息同帧进来，就没有这次高度突变 —— 也不要为了「复用」再把这层请求加回来。</p>
 *
 * <p><b>每一行都能点开差异</b>：记录还在、重放得出来就给入口（历史轮次一样）。
 * 面板里再分三档 —— 本次改动 / 最新改动 / 当前源码，让「这一轮改了什么」和
 * 「文件现在长什么样」各有归属。</p>
 *
 * <p><b>回滚入口只在执行标识唯一时出现</b>：清单按轮次渲染、回滚按执行生效，两个执行混在一张卡上
 * 就说明数据异常，此时宁可不给按钮，也不能回滚到别人的执行上。回滚成功后清单靠后端重推的
 * 轮次视图刷新，卡片自己不发请求、也不伪造「已回滚」状态。</p>
 */
import {computed, inject, ref} from 'vue';
import {t} from '../../i18n';
import {FILE_PREVIEW_KEY} from '../../types/filePreview';
import type {TurnFileChangeVO} from '../../types/block';
import FileRollbackDialog from './FileRollbackDialog.vue';
import {
  buildTurnFileChangeRows,
  turnFileChangeTotals,
  type TurnFileChangeRow
} from '../../utils/turnFileChanges';
import {resolveRollbackExecutionId} from '../../utils/fileRollbackPlan';

const props = defineProps<{
  /** 本轮改动清单（来自轮次视图）；空数组即整卡不渲染。 */
  items?: TurnFileChangeVO[] | null;
  sessionId?: string | number;
  isDark?: boolean;
}>();

const openFilePreview = inject(FILE_PREVIEW_KEY, null);

const rows = computed<TurnFileChangeRow[]>(() => buildTurnFileChangeRows(props.items));
const totals = computed(() => turnFileChangeTotals(rows.value));
/** 回滚按执行生效：只有整张卡的所有行同属一个执行时才给入口（多于一个说明数据异常）。 */
const rollbackExecutionId = computed(() =>
  resolveRollbackExecutionId((props.items ?? []).map(item => item.executionId)));
const rollbackOpen = ref(false);
/** 行内小标签配色：只区分「新建」和「多次修改」两种语义，不承载交互。 */
const chipClass = (tone: 'ok' | 'muted'): string => {
  const base = 'shrink-0 rounded px-1 py-0.5 text-lx-fs-xs leading-none';
  if (tone === 'ok') {
    return `${base} ${props.isDark ? 'bg-emerald-500/15 text-emerald-300' : 'bg-emerald-500/10 text-[#088f50]'}`;
  }
  return `${base} ${props.isDark ? 'bg-white/10 text-zinc-300' : 'bg-black/5 text-zinc-500'}`;
};

/** 点行打开差异；历史轮次没有差异正文，行本身不可点。 */
const openDiff = (row: TurnFileChangeRow): void => {
  if (!row.edit) return;
  openFilePreview?.({ sessionId: props.sessionId, path: row.filePath, edit: row.edit });
};
</script>
