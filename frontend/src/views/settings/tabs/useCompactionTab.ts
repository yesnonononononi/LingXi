import { computed, onMounted, ref, watch } from 'vue';
import { useUserConfigStore } from '../../../stores/userConfigStore';
import { ModelAPI } from '../../../services/model';
import { CompactionSettingsAPI } from '../../../services/compaction';
import { isOk } from '../../../utils/api';
import { t } from '../../../i18n';
import type { CompactionParamsVO, ProviderModelGroupVO } from '../../../types/chat';

/**
 * 压缩模型配置页的状态与动作。
 *
 * <p>开关与下拉是**同一件事**：持久化的 compactModelId 非空即「已启用」。
 * 不再单独存一个 enabled 布尔 —— 两份状态必然有一天不同步，
 * 而用户看到的开关就会与真实生效的压缩行为背道而驰。</p>
 */
export function useCompactionTab() {
  const store = useUserConfigStore();
  const groups = ref<ProviderModelGroupVO[]>([]);
  const params = ref<CompactionParamsVO | null>(null);
  const loading = ref(true);
  const loadError = ref('');
  /** 只影响「高级设置」一块：参数读取失败不该把模型选择一起藏起来。 */
  const paramsError = ref('');
  const saveError = ref('');

  const models = computed(() => groups.value.flatMap(group => (group.models ?? []).map(model => ({
    model,
    providerName: (group.providerName ?? model.providerName ?? '').trim(),
  }))));

  /** 只有凭据齐备的模型能当压缩模型：选一个没有密钥的行，压缩必然在对话中途炸。 */
  const readyModels = computed(() => models.value.filter(entry => entry.model.credentialConfigured));

  const options = computed(() => readyModels.value.map(entry => ({
    value: String(entry.model.id),
    label: buildModelLabel(entry.providerName, entry.model.modelName),
    desc: entry.model.baseUrl ?? undefined,
  })));

  const selectedId = computed(() => (store.compactModelId == null ? '' : String(store.compactModelId)));
  const enabled = computed(() => selectedId.value !== '');
  const selectedEntry = computed(() => models.value.find(entry => String(entry.model.id) === selectedId.value) ?? null);
  const saving = computed(() => store.savingKeys.has('compactModelId'));
  const disabled = computed(() => !store.loaded || loading.value || saving.value);

  /** 选中的模型已经不在列表里（被删/归属变化）：必须明说，别让开关显示「已启用」却什么都没做。 */
  const dangling = computed(() => enabled.value && selectedEntry.value === null);
  const missingCredential = computed(() => enabled.value && selectedEntry.value !== null && !selectedEntry.value.model.credentialConfigured);

  async function load() {
    loading.value = true;
    loadError.value = '';
    paramsError.value = '';
    try {
      const [config, catalog, compaction] = await Promise.allSettled([
        store.load(true),
        ModelAPI.catalog(),
        CompactionSettingsAPI.params(),
      ]);
      if (config.status === 'rejected' || !config.value
        || catalog.status === 'rejected' || !isOk(catalog.value.code)) {
        throw new Error(t('config.loadFailed'));
      }
      groups.value = catalog.value.data ?? [];
      // 参数接口独立处理传输与业务错误，避免只读参数故障阻断模型选择。
      if (compaction.status === 'fulfilled' && isOk(compaction.value.code) && compaction.value.data) {
        params.value = compaction.value.data;
      } else {
        params.value = null;
        paramsError.value = t('settings.compaction.loadFailed');
      }
    } catch (error) {
      console.error('载入压缩模型配置失败:', error);
      loadError.value = t('settings.compaction.loadFailed');
    } finally {
      loading.value = false;
    }
  }

  /** 落库唯一出口：写 null 即「取消专用压缩模型」，写 id 即「启用并选中」。 */
  async function persist(id: string | null) {
    if (disabled.value) return;
    saveError.value = '';
    const ok = await store.patch('compactModelId', id, { compactModelId: id });
    if (!ok) saveError.value = t('settings.compaction.saveFailed');
  }

  /** 开关：开 = 选中一个可用模型（默认第一个可用的），关 = 清空选择。 */
  async function toggle(next: boolean) {
    if (disabled.value) return;
    if (!next) {
      await persist(null);
      return;
    }
    const first = readyModels.value[0];
    if (!first) return;
    await persist(String(first.model.id));
  }

  async function choose(value: string) {
    if (!value || disabled.value) return;
    await persist(value);
  }

  watch(() => store.compactModelId, () => { saveError.value = ''; });
  onMounted(load);

  return {
    store,
    params,
    loading,
    loadError,
    paramsError,
    saveError,
    options,
    readyModels,
    selectedId,
    enabled,
    saving,
    disabled,
    dangling,
    missingCredential,
    load,
    toggle,
    choose,
  };
}

/** 下拉展示名：有提供商时用「提供商/模型」，与模型页的分组口径一致。 */
function buildModelLabel(providerName: string, modelName?: string | null): string {
  const name = (modelName ?? '').trim();
  return providerName ? providerName + '/' + name : name;
}
