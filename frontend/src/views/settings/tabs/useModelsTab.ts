import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { ModelAPI, ProviderAPI } from '../../../services/api';
import type {
  ModelConfigVO,
  ProviderConfigVO,
  ProviderModelGroupVO,
  OpenAIModelItem,
} from '../../../types/chat';
import { isOk } from '../../../utils/api';
import { useModelImportCopy } from './useModelImportCopy';
import { useConfirm } from '../../../composables/useConfirm';
import { useI18n } from '../../../i18n';

export type ModelsTabMode = 'list' | 'provider-form' | 'model-form' | 'batch-form';

interface ProviderForm {
  id: string | number | null;
  name: string;
  icon: string;
  apiKey: string;
  baseUrl: string;
}

interface ModelForm {
  id: string | number | null;
  providerConfigId: string | number | null;
  modelName: string;
  baseUrl: string;
  apiKey: string;
  vision: boolean;
  /** 开启后实时读取提供方密钥，模型不保存副本。 */
  useProvider: boolean;
}

export function useModelsTab(emit: (e: 'modelUpdated') => void) {
  const { t } = useI18n();
  const importCopy = useModelImportCopy();
  const { confirm } = useConfirm();

  const catalogGroups = ref<ProviderModelGroupVO[]>([]);
  const providers = ref<ProviderConfigVO[]>([]);
  const isModelLoading = ref(false);
  const modelErrorMsg = ref('');
  const mode = ref<ModelsTabMode>('list');
  const isSubmitting = ref(false);
  const showApiKey = ref(false);
  const modelToast = ref('');
  let modelToastTimer: number | undefined;

  const providerForm = ref<ProviderForm>(emptyProviderForm());
  const providerFormError = ref('');
  const modelForm = ref<ModelForm>(emptyModelForm());
  const modelFormError = ref('');
  const batchProviderId = ref<string | number | null>(null);
  const batchProvider = computed(() => providers.value.find(provider => String(provider.id) === String(batchProviderId.value)));
  const batchExistingNames = computed(() => catalogGroups.value
    .find(group => String(group.providerConfigId) === String(batchProviderId.value))?.models.map(model => model.modelName ?? '') ?? []);

  const startBatchModels = (id: string | number) => {
    batchProviderId.value = id;
    mode.value = 'batch-form';
  };

  function emptyProviderForm(): ProviderForm {
    return { id: null, name: '', icon: '', apiKey: '', baseUrl: '' };
  }

  function emptyModelForm(): ModelForm {
    return {
      id: null,
      providerConfigId: null,
      modelName: '',
      baseUrl: '',
      apiKey: '',
      vision: false,
      useProvider: true,
    };
  }

  const showModelToast = (msg: string) => {
    modelToast.value = msg;
    if (modelToastTimer) window.clearTimeout(modelToastTimer);
    modelToastTimer = window.setTimeout(() => {
      modelToast.value = '';
    }, 2500);
  };

  const loadAll = async () => {
    isModelLoading.value = true;
    modelErrorMsg.value = '';
    try {
      const [catalogRes, providerRes] = await Promise.all([
        ModelAPI.catalog(),
        ProviderAPI.list(),
      ]);
      if (isOk(catalogRes.code)) {
        catalogGroups.value = catalogRes.data ?? [];
      } else {
        modelErrorMsg.value = catalogRes.errMsg || t('settings.models.errLoadList');
      }
      if (isOk(providerRes.code)) {
        providers.value = providerRes.data ?? [];
      } else if (!modelErrorMsg.value) {
        modelErrorMsg.value = providerRes.errMsg || t('settings.models.errLoadList');
      }
    } catch {
      modelErrorMsg.value = t('settings.models.errLoadConfig');
    } finally {
      isModelLoading.value = false;
    }
  };

  const refreshAfterChange = async () => {
    await loadAll();
    emit('modelUpdated');
  };

  // ---------------------------------------------------------------- 提供商

  const startAddProvider = () => {
    providerForm.value = emptyProviderForm();
    providerFormError.value = '';
    showApiKey.value = false;
    mode.value = 'provider-form';
  };

  const startEditProvider = (provider: ProviderConfigVO) => {
    providerForm.value = {
      id: provider.id,
      name: provider.name ?? '',
      icon: provider.icon ?? '',
      apiKey: '',
      baseUrl: provider.baseUrl ?? '',
    };
    providerFormError.value = '';
    showApiKey.value = false;
    mode.value = 'provider-form';
  };

  const saveProviderForm = async () => {
    providerFormError.value = '';
    const form = providerForm.value;
    if (!form.name.trim()) {
      providerFormError.value = t('settings.models.errProviderNameRequired');
      return;
    }
    if (form.id === null && !form.baseUrl.trim()) {
      providerFormError.value = t('settings.models.errBaseUrlRequired');
      return;
    }
    if (form.id === null && !form.apiKey.trim()) {
      providerFormError.value = t('settings.models.errApiKeyRequired');
      return;
    }
    isSubmitting.value = true;
    try {
      const payload = {
        name: form.name.trim(),
        baseUrl: form.baseUrl.trim(),
        // 始终回传：空串表示清除图标（后端把 blank 归一成 null），传 null 会被判为「不修改」。
        icon: form.icon.trim(),
        apiKey: form.apiKey.trim() || undefined,
      };
      const res = form.id === null
        ? await ProviderAPI.add(payload)
        : await ProviderAPI.update({ id: form.id, ...payload });
      if (isOk(res.code)) {
        showModelToast(form.id === null
          ? t('settings.models.toastProviderAdded')
          : t('settings.models.toastProviderUpdated'));
        if (form.id === null && typeof res.data !== 'string') {
          providerFormError.value = t('settings.models.errSave');
          return;
        }
        const createdId = form.id === null ? res.data : null;
        await refreshAfterChange();
        if (typeof createdId === 'string') startBatchModels(createdId);
        else mode.value = 'list';
      } else {
        providerFormError.value = res.errMsg || t('settings.models.errSave');
      }
    } catch {
      providerFormError.value = t('settings.models.errNetwork');
    } finally {
      isSubmitting.value = false;
    }
  };

  const deleteProvider = async (provider: { id: string | number; name: string }) => {
    const ok = await confirm({
      title: t('settings.models.confirmDeleteProviderTitle'),
      content: t('settings.models.confirmDeleteProviderContent', { name: provider.name }),
      type: 'danger',
      confirmText: t('common.remove'),
    });
    if (!ok) return;
    try {
      const res = await ProviderAPI.deleteById(provider.id);
      if (isOk(res.code)) {
        showModelToast(t('settings.models.toastProviderDeleted'));
        await refreshAfterChange();
      } else {
        window.alert(res.errMsg || t('settings.models.errDelete'));
      }
    } catch {
      window.alert(t('settings.models.errDeleteRetry'));
    }
  };

  // ---------------------------------------------------------------- 模型

  const startAddModel = (providerConfigId?: string | number | null) => {
    modelForm.value = {
      ...emptyModelForm(),
      providerConfigId: providerConfigId ?? null,
      baseUrl: providerBaseUrl(providerConfigId),
    };
    modelFormError.value = '';
    showApiKey.value = false;
    isRemoteModelDropdownOpen.value = false;
    remoteModelList.value = [];
    mode.value = 'model-form';
  };

  const startEditModel = (item: ModelConfigVO) => {
    modelForm.value = {
      id: item.id ?? null,
      providerConfigId: item.providerConfigId ?? null,
      modelName: item.modelName ?? '',
      baseUrl: item.baseUrl ?? '',
      apiKey: '', // 展示掩码不回填；编辑留空保留数据库中的原值。
      vision: item.vision,
      useProvider: item.useProvider,
    };
    modelFormError.value = '';
    showApiKey.value = false;
    isRemoteModelDropdownOpen.value = false;
    remoteModelList.value = [];
    mode.value = 'model-form';
  };

  const providerBaseUrl = (providerConfigId?: string | number | null): string => {
    if (providerConfigId === null || providerConfigId === undefined) return '';
    const provider = providers.value.find(p => String(p.id) === String(providerConfigId));
    return provider?.baseUrl ?? '';
  };

  /** 切换提供方时，Base URL 还是空或仍是旧提供方的值就跟着换，用户手改过的不动。 */
  const handleProviderChange = (value: string | number | null) => {
    const previousBaseUrl = providerBaseUrl(modelForm.value.providerConfigId);
    modelForm.value.providerConfigId = value;
    const nextBaseUrl = providerBaseUrl(value);
    const current = modelForm.value.baseUrl.trim();
    if (!current || current === previousBaseUrl) {
      modelForm.value.baseUrl = nextBaseUrl;
    }
  };

  const cancelForm = () => {
    mode.value = 'list';
    providerForm.value = emptyProviderForm();
    providerFormError.value = '';
    modelForm.value = emptyModelForm();
    modelFormError.value = '';
    isRemoteModelDropdownOpen.value = false;
    remoteModelList.value = [];
    fetchRemoteModelError.value = '';
  };

  const saveModelForm = async () => {
    modelFormError.value = '';
    const form = modelForm.value;
    if (!form.modelName.trim()) {
      modelFormError.value = t('settings.models.errNameRequired');
      return;
    }
    if (!form.baseUrl.trim()) {
      modelFormError.value = t('settings.models.errBaseUrlInput');
      return;
    }
    if (form.useProvider && (!form.providerConfigId || Number(form.providerConfigId) <= 0)) {
      modelFormError.value = t('settings.models.errProviderRequired');
      return;
    }
    const reusesProviderKey = form.useProvider;
    if (form.id === null && !form.apiKey.trim() && !reusesProviderKey) {
      modelFormError.value = t('settings.models.errApiKeyRequired');
      return;
    }
    isSubmitting.value = true;
    try {
      // 归属「未分组」时显式传 0：后端按键「是否出现」判定，null 会被当成「不修改」。
      const providerConfigId = form.providerConfigId === null
        ? 0
        : Number(form.providerConfigId) > 0 ? form.providerConfigId : 0;
      const payload = {
        vision: form.vision,
        modelName: form.modelName.trim(),
        baseUrl: form.baseUrl.trim(),
        // 提供方密钥只由后端实时读取，不回传模型密钥。
        apiKey: reusesProviderKey ? undefined : (form.apiKey.trim() || undefined),
        providerConfigId,
        useProvider: form.useProvider,
      };
      const res = form.id === null
        ? await ModelAPI.add(payload)
        : await ModelAPI.update({ id: form.id, ...payload });
      if (isOk(res.code)) {
        showModelToast(form.id === null
          ? t('settings.models.toastAdded')
          : t('settings.models.toastUpdated'));
        mode.value = 'list';
        await refreshAfterChange();
      } else {
        modelFormError.value = res.errMsg || (form.id === null
          ? t('settings.models.errAdd')
          : t('settings.models.errSave'));
      }
    } catch {
      modelFormError.value = t('settings.models.errNetwork');
    } finally {
      isSubmitting.value = false;
    }
  };

  const handleDeleteModel = async (item: ModelConfigVO) => {
    if (!item.id) return;
    const ok = await confirm({
      title: t('settings.models.confirmDeleteTitle'),
      content: t('settings.models.confirmDeleteContent', { name: item.modelName || t('settings.models.unnamed') }),
      type: 'danger',
      confirmText: t('common.remove'),
    });
    if (!ok) return;
    try {
      const res = await ModelAPI.deleteById(item.id);
      if (isOk(res.code)) {
        showModelToast(t('settings.models.toastDeleted'));
        await refreshAfterChange();
      } else {
        window.alert(res.errMsg || t('settings.models.errDelete'));
      }
    } catch {
      window.alert(t('settings.models.errDeleteRetry'));
    }
  };

  // ---------------------------------------------------------- 远程 /models

  const isFetchingRemoteModels = ref(false);
  const remoteModelList = ref<OpenAIModelItem[]>([]);
  const isRemoteModelDropdownOpen = ref(false);
  const remoteModelSearch = ref('');
  const fetchRemoteModelError = ref('');

  const filteredRemoteModels = computed(() => {
    const q = remoteModelSearch.value.trim().toLowerCase();
    if (!q) return remoteModelList.value;
    return remoteModelList.value.filter(m =>
      m.id.toLowerCase().includes(q) || (m.owned_by && m.owned_by.toLowerCase().includes(q))
    );
  });

  const handleFetchRemoteModels = async (e?: Event) => {
    e?.stopPropagation();
    if (!modelForm.value.baseUrl?.trim()) {
      modelFormError.value = t('settings.models.errBaseUrlRequired');
      return;
    }

    isFetchingRemoteModels.value = true;
    fetchRemoteModelError.value = '';
    isRemoteModelDropdownOpen.value = true;
    remoteModelSearch.value = '';

    try {
      const res = await ProviderAPI.discoverModels({
        providerConfigId: modelForm.value.useProvider ? modelForm.value.providerConfigId ?? undefined : undefined,
        baseUrl: modelForm.value.baseUrl.trim(),
        apiKey: modelForm.value.useProvider ? undefined : modelForm.value.apiKey.trim() || undefined,
      });
      if (!isOk(res.code) || !res.data) throw new Error('模型发现失败');
      const validItems: OpenAIModelItem[] = res.data;

      remoteModelList.value = validItems;
      if (validItems.length === 0) {
        fetchRemoteModelError.value = t('settings.models.errNoRemote');
      }
    } catch {
      fetchRemoteModelError.value = importCopy.value.failureHint;
    } finally {
      isFetchingRemoteModels.value = false;
    }
  };

  const handleSelectRemoteModel = (name: string) => {
    modelForm.value.modelName = name;
    isRemoteModelDropdownOpen.value = false;
    modelFormError.value = '';
  };

  const handleDocumentClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target?.closest('.model-dropdown-container')) {
      isRemoteModelDropdownOpen.value = false;
    }
  };

  onMounted(() => {
    loadAll();
    window.addEventListener('click', handleDocumentClick);
  });

  onBeforeUnmount(() => {
    window.removeEventListener('click', handleDocumentClick);
    if (modelToastTimer) window.clearTimeout(modelToastTimer);
  });

  return {
    catalogGroups,
    providers,
    isModelLoading,
    modelErrorMsg,
    mode,
    isSubmitting,
    showApiKey,
    modelToast,
    providerForm,
    providerFormError,
    batchProvider,
    batchExistingNames,
    startBatchModels,
    refreshAfterChange,
    modelForm,
    modelFormError,
    isFetchingRemoteModels,
    remoteModelList,
    isRemoteModelDropdownOpen,
    remoteModelSearch,
    fetchRemoteModelError,
    filteredRemoteModels,
    loadAll,
    loadModels: loadAll,
    startAddProvider,
    startEditProvider,
    saveProviderForm,
    deleteProvider,
    startAddModel,
    startEditModel,
    handleProviderChange,
    cancelForm,
    cancelModelForm: cancelForm,
    saveModelForm,
    handleDeleteModel,
    handleFetchRemoteModels,
    handleSelectRemoteModel,
  };
}
