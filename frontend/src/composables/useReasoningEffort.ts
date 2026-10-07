import { computed, ref } from 'vue';
import { useUserConfigStore } from '../stores/userConfigStore';
import type { ReasoningEffort } from '../types/chat';

export const reasoningEffortOptions = [
  { label: 'None', value: 'none' },
  { label: 'Low', value: 'low' },
  { label: 'Medium', value: 'medium' },
  { label: 'High', value: 'high' },
  { label: 'Extra', value: 'xhigh' },
  { label: 'Max', value: 'max' },
] as const;

/**
 * 思考强度的组件侧出口。
 *
 * <p>真值在 {@link useUserConfigStore}（后端 {@code user_configs.reasoning_effort}），
 * 本函数只做两件事：把 store 的 ref 透给视图、翻译保存失败的提示文案。
 * 连续调整的串行合并由 store 的 {@link useUserConfigStore.setReasoningEffort} 负责。</p>
 */
export function useReasoningEffort() {
  const userConfig = useUserConfigStore();
  /** 保存失败时的可见提示；由视图展示在下拉附近。 */
  const reasoningEffortError = ref('');

  const reasoningEffort = computed(() => userConfig.reasoningEffort);
  const reasoningEffortPending = computed(() => userConfig.reasoningEffortPending);

  const handleUpdateReasoningEffort = async (value: ReasoningEffort): Promise<void> => {
    reasoningEffortError.value = '';
    const ok = await userConfig.setReasoningEffort(value);
    if (!ok) reasoningEffortError.value = '思考强度保存失败，已恢复原值，请重新选择';
  };

  return {
    reasoningEffort,
    reasoningEffortPending,
    reasoningEffortError,
    handleUpdateReasoningEffort,
  };
}
