import { onScopeDispose, ref, watch, type Ref } from 'vue';
import { PromptOptimizationAPI } from '../services/promptOptimization';
import { useConfirm } from './useConfirm';
import { isOk } from '../utils/api';
import { t } from '../i18n';

export const OPTIMIZE_PROMPT_COMMAND = '/optimize-prompt';

export function isPromptOptimizationCommand(text: string): boolean {
  return /^\/optimize-prompt(?:\s|$)/.test(text);
}

export function usePromptOptimization(input: Ref<string>, getModelId: () => string | number | undefined,
  focusInput: () => void, replaceInput: (text: string) => void = text => { input.value = text; }) {
  const isOptimizing = ref(false);
  const error = ref('');
  const { confirm, state, handleCancel } = useConfirm();
  let revision = 0;
  let disposed = false;
  let controller: AbortController | undefined;
  let ownedConfirmation: typeof state.value.resolve = null;
  watch(input, () => { revision += 1; error.value = ''; }, { flush: 'sync' });

  const optimize = async () => {
    if (isOptimizing.value || disposed) return;
    if (isPromptOptimizationCommand(input.value)) {
      input.value = input.value.slice(OPTIMIZE_PROMPT_COMMAND.length).replace(/^\s+/, '');
    }
    const original = input.value;
    if (!original.trim()) {
      error.value = t('chat.optimizePrompt.empty');
      focusInput();
      return;
    }
    if (original.length > 20_000) {
      error.value = t('chat.optimizePrompt.tooLong');
      return;
    }
    const originalRevision = revision;
    const modelId = getModelId();
    isOptimizing.value = true;
    error.value = '';
    controller = new AbortController();
    try {
      const result = await PromptOptimizationAPI.optimize(original, modelId, controller.signal);
      if (disposed) return;
      if (revision !== originalRevision) {
        error.value = t('chat.optimizePrompt.changed');
        return;
      }
      if (!isOk(result.code) || typeof result.data !== 'string' || !result.data.trim()) {
        error.value = t('chat.optimizePrompt.failed');
        return;
      }
      // 其他确认框仍在等待时不抢占，避免它的调用方永久悬挂。
      if (state.value.isOpen) {
        error.value = t('chat.optimizePrompt.confirmBusy');
        return;
      }
      const confirmation = confirm({
        title: t('chat.optimizePrompt.title'),
        content: t('chat.optimizePrompt.description'),
        preview: result.data,
        confirmText: t('chat.optimizePrompt.replace'),
        cancelText: t('chat.optimizePrompt.keep'),
      });
      ownedConfirmation = state.value.resolve;
      const accepted = await confirmation;
      if (disposed) return;
      if (revision !== originalRevision) {
        error.value = t('chat.optimizePrompt.changed');
        return;
      }
      if (accepted) replaceInput(result.data);
    } catch {
      if (!disposed) error.value = t('chat.optimizePrompt.failed');
    } finally {
      isOptimizing.value = false;
      ownedConfirmation = null;
      controller = undefined;
      if (!disposed) focusInput();
    }
  };

  onScopeDispose(() => {
    disposed = true;
    controller?.abort();
    if (ownedConfirmation) {
      if (state.value.resolve === ownedConfirmation) handleCancel();
      else ownedConfirmation(false);
    }
  });
  return { optimize, isOptimizing, error };
}
