import {computed, onBeforeUnmount, onMounted, ref} from 'vue';
import {ExecutionCleanupAPI} from '../../../services/executionCleanup';
import {extractErrorMessage} from '../../../utils/error';
import {isOk} from '../../../utils/api';
import {useExecutionCleanupCopy} from './executionCleanupCopy';

function isCount(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}

function isFlag(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

export function useExecutionCleanup() {
  const copy = useExecutionCleanupCopy();
  const count = ref<string | null>(null);
  const filesNeedScan = ref(false);
  const expiredRecordCount = ref<string | null>(null);
  const deletedCount = ref<string | null>(null);
  const busy = ref(false);
  const error = ref('');
  let disposed = false;
  // 可回收行数为 0 不代表没有东西可删：孤儿正文、.part 残留只能靠再扫一次回收，
  // 过期的文件编辑记录更是与执行行无关的另一类删除。三者任一非空，按钮就必须可用。
  const canClean = computed(() => !busy.value
    && ((count.value !== null && count.value !== '0')
      || filesNeedScan.value
      || (expiredRecordCount.value !== null && expiredRecordCount.value !== '0')));

  /** 拉一次预览；不做 busy/清理状态管理，供 load 与清理后刷新共用。 */
  async function refreshPreview() {
    const result = await ExecutionCleanupAPI.preview();
    if (!isOk(result.code)) throw new Error(result.errMsg || copy.value.loadError);
    if (!isCount(result.data?.executionCount) || !isFlag(result.data?.filesNeedScan)
      || !isCount(result.data?.expiredFileRecordCount)) {
      throw new Error(copy.value.contractError);
    }
    count.value = result.data.executionCount;
    filesNeedScan.value = result.data.filesNeedScan;
    expiredRecordCount.value = result.data.expiredFileRecordCount;
  }

  async function load() {
    if (busy.value || disposed) return;
    busy.value = true;
    error.value = '';
    count.value = null;
    filesNeedScan.value = false;
    expiredRecordCount.value = null;
    deletedCount.value = null;
    try {
      await refreshPreview();
    } catch (cause) {
      if (!disposed) error.value = extractErrorMessage(cause);
    } finally {
      if (!disposed) busy.value = false;
    }
  }

  async function cleanup() {
    if (!canClean.value || disposed) return;
    busy.value = true;
    error.value = '';
    deletedCount.value = null;
    try {
      const result = await ExecutionCleanupAPI.cleanup();
      if (disposed) return;
      if (!isOk(result.code)) throw new Error(result.errMsg || copy.value.cleanupError);
      if (!isCount(result.data?.deletedCount) || !isCount(result.data?.remainingCount)) {
        throw new Error(copy.value.contractError);
      }
      deletedCount.value = result.data.deletedCount;
      // 清理后再拉一次预览：本轮目录预算之后可能还有孤儿文件，按钮必须跟着最新事实走，
      // 否则「remainingCount=0」会把第二轮扫描挡在门外。
      await refreshPreview();
    } catch (cause) {
      if (!disposed) {
        count.value = null;
        filesNeedScan.value = false;
        expiredRecordCount.value = null;
        error.value = extractErrorMessage(cause);
      }
    } finally {
      if (!disposed) busy.value = false;
    }
  }

  onMounted(load);
  onBeforeUnmount(() => { disposed = true; });
  return { copy, count, filesNeedScan, expiredRecordCount, deletedCount, busy, error, canClean, load, cleanup };
}
