import { computed, ref } from 'vue';
import { UserConfigAPI } from '../services/userConfig';
import { isOk } from '../utils/api';
import type { ReasoningEffort } from '../types/chat';

export const reasoningEffortOptions = [
  { label: 'None', value: 'none' },
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Extra', value: 'xhigh' },
  { label: 'Max', value: 'max' },
] as const;

export function useReasoningEffort() {
  const reasoningEffort = ref<ReasoningEffort>('low');
  const ready = ref(false);
  const saving = ref(false);
  const reasoningEffortError = ref('');
  const reasoningEffortPending = computed(() => !ready.value || saving.value);
  let savedEffort: ReasoningEffort = 'low';

  const syncReasoningEffort = (value: unknown) => {
    if (saving.value) return;
    const option = reasoningEffortOptions.find(option => option.value === value);
    savedEffort = option?.value ?? 'low';
    reasoningEffort.value = savedEffort;
    ready.value = true;
    reasoningEffortError.value = '';
  };

  const handleUpdateReasoningEffort = async (value: ReasoningEffort) => {
    if (!ready.value) return;
    reasoningEffort.value = value;
    reasoningEffortError.value = '';
    if (saving.value) return;
    saving.value = true;
    try {
      // 拖动期间串行保存并合并中间档位，避免旧请求最后到达覆盖新选择。
      while (reasoningEffort.value !== savedEffort) {
        const target = reasoningEffort.value;
        const result = await UserConfigAPI.updateCurrent({ reasoningEffort: target });
        if (!isOk(result.code)) throw new Error('思考强度保存失败');
        savedEffort = target;
      }
    } catch (error) {
      reasoningEffort.value = savedEffort;
      reasoningEffortError.value = '思考强度保存失败，已恢复原值，请重新选择';
      console.error('保存思考强度失败:', error);
    } finally {
      saving.value = false;
    }
  };

  return {
    reasoningEffort,
    reasoningEffortPending,
    reasoningEffortError,
    syncReasoningEffort,
    handleUpdateReasoningEffort,
  };
}
