import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ExecutionCleanupAPI } from '../../../services/executionCleanup';
import { extractErrorMessage } from '../../../utils/error';
import { isOk } from '../../../utils/api';
import { useExecutionCleanupCopy } from './executionCleanupCopy';

function isCount(value: unknown): value is string {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value);
}

export function useExecutionCleanup() {
  const copy = useExecutionCleanupCopy();
  const count = ref<string | null>(null);
  const deletedCount = ref<string | null>(null);
  const busy = ref(false);
  const error = ref('');
  let disposed = false;
  const canClean = computed(() => !busy.value && count.value !== null && count.value !== '0');

  async function load() {
    if (busy.value || disposed) return;
    busy.value = true;
    error.value = '';
    count.value = null;
    deletedCount.value = null;
    try {
      const result = await ExecutionCleanupAPI.preview();
      if (disposed) return;
      if (!isOk(result.code)) throw new Error(result.errMsg || copy.value.loadError);
      if (!isCount(result.data?.executionCount)) throw new Error(copy.value.contractError);
      count.value = result.data.executionCount;
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
      count.value = result.data.remainingCount;
      deletedCount.value = result.data.deletedCount;
    } catch (cause) {
      if (!disposed) {
        count.value = null;
        error.value = extractErrorMessage(cause);
      }
    } finally {
      if (!disposed) busy.value = false;
    }
  }

  onMounted(load);
  onBeforeUnmount(() => { disposed = true; });
  return { copy, count, deletedCount, busy, error, canClean, load, cleanup };
}
