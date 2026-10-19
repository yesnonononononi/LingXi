import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { ModelAPI } from '../../../services/api';
import type { ModelConfigVO, OpenAIModelItem } from '../../../types/chat';
import { isOk } from '../../../utils/api';
import { extractOpenAIError, parseOpenAIModelList } from '../../../utils/openaiModels';
import { useConfirm } from '../../../composables/useConfirm';
import { useI18n } from '../../../i18n';

export function useModelsTab(emit: (e: 'modelUpdated') => void) {
  const { t } = useI18n();
  const modelsList = ref<ModelConfigVO[]>([]);
  const isModelLoading = ref(false);
  const modelErrorMsg = ref('');
  const isEditingOrAdding = ref(false);
  const addType = ref<'preset' | 'custom'>('preset');
  const editingModelId = ref<number | string | null>(null);
  const modelForm = ref({
    vision: false,
    modelName: '',
    baseUrl: '',
    apiKey: '',
  });
  const modelFormError = ref('');
  const isSubmittingModel = ref(false);
  const showApiKey = ref(false);
  const modelToast = ref('');
  let modelToastTimer: number | undefined;

  const showModelToast = (msg: string) => {
    modelToast.value = msg;
    if (modelToastTimer) window.clearTimeout(modelToastTimer);
    modelToastTimer = window.setTimeout(() => {
      modelToast.value = '';
    }, 2500);
  };

  const loadModels = async () => {
    isModelLoading.value = true;
    modelErrorMsg.value = '';
    try {
      const res = await ModelAPI.list(1, 100);
      if (isOk(res.code)) {
        modelsList.value = res.data?.records ?? [];
      } else {
                modelErrorMsg.value = res.errMsg || t('settings.models.errLoadList');
      }
    } catch {
      modelErrorMsg.value = t('settings.models.errLoadConfig');
    } finally {
      isModelLoading.value = false;
    }
  };

  const providerPresets = [
    { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
    { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
    { name: 'qwen', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1' },
    { name: 'Ollama', baseUrl: 'http://localhost:11434/v1' },
  ];

  const selectedProvider = ref('DeepSeek');
  const isProviderDropdownOpen = ref(false);

  const handleApplyPreset = (preset: typeof providerPresets[0]) => {
    selectedProvider.value = preset.name;
    modelForm.value.baseUrl = preset.baseUrl;
    modelFormError.value = '';
    isProviderDropdownOpen.value = false;
  };

  const startAddModel = (type: 'preset' | 'custom' = 'preset') => {
    editingModelId.value = null;
    addType.value = type;
    isProviderDropdownOpen.value = false;
    if (type === 'preset') {
      selectedProvider.value = 'DeepSeek';
      modelForm.value = {
        vision: false,
        modelName: '',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: '',
      };
    } else {
      selectedProvider.value = '';
      modelForm.value = {
        vision: false,
        modelName: '',
        baseUrl: '',
        apiKey: '',
      };
    }
    modelFormError.value = '';
    showApiKey.value = false;
    isEditingOrAdding.value = true;
  };

  const startEditModel = (item: ModelConfigVO) => {
    editingModelId.value = item.id ?? null;
    isProviderDropdownOpen.value = false;
    const matched = providerPresets.find(p => p.baseUrl === item.baseUrl);
    selectedProvider.value = matched ? matched.name : '';
    modelForm.value = {
      vision: item.vision,
      modelName: item.modelName ?? '',
      baseUrl: item.baseUrl ?? '',
      apiKey: '', // 展示掩码不回填；编辑留空保留数据库中的原值。
    };
    modelFormError.value = '';
    showApiKey.value = false;
    isEditingOrAdding.value = true;
  };

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

    const base = modelForm.value.baseUrl.trim();
    const url = base.replace(/\/+$/, '') + '/models';

    isFetchingRemoteModels.value = true;
    fetchRemoteModelError.value = '';
    isRemoteModelDropdownOpen.value = true;
    remoteModelSearch.value = '';

    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json'
      };
      const key = modelForm.value.apiKey?.trim();
      if (key) {
        headers['Authorization'] = `Bearer ${key}`;
        headers['apikey'] = key;
        headers['api-key'] = key;
      }

      const res = await fetch(url, {
        method: 'GET',
        headers
      });

      if (!res.ok) {
        let errJson: unknown = null;
        try {
          errJson = await res.json();
        } catch (err) {
          console.warn('[fetchRemoteModels] 错误响应体不是合法 JSON:', err);
        }
        throw new Error(extractOpenAIError(errJson, `HTTP ${res.status}: ${res.statusText}`));
      }

      const json = await res.json();
      // 各厂商 /v1/models 响应结构不一致（外部契约），解析收敛到 utils/openaiModels
      const validItems: OpenAIModelItem[] = parseOpenAIModelList(json);

      remoteModelList.value = validItems;
            if (validItems.length === 0) {
        fetchRemoteModelError.value = t('settings.models.errNoRemote');
      }
    } catch (err: any) {
      console.error('获取模型列表失败:', err);
      fetchRemoteModelError.value = err.message || t('settings.models.errFetchRemote');
    } finally {
      isFetchingRemoteModels.value = false;
    }
  };

  const handleSelectRemoteModel = (name: string) => {
    modelForm.value.modelName = name;
    isRemoteModelDropdownOpen.value = false;
    modelFormError.value = '';
  };

  const cancelModelForm = () => {
    isEditingOrAdding.value = false;
    editingModelId.value = null;
    modelForm.value = { modelName: '', baseUrl: '', apiKey: '', vision: false };
    modelFormError.value = '';
    isRemoteModelDropdownOpen.value = false;
    isProviderDropdownOpen.value = false;
    remoteModelList.value = [];
    fetchRemoteModelError.value = '';
  };

  const validateModelForm = () => {
        if (!modelForm.value.modelName.trim()) {
      modelFormError.value = t('settings.models.errNameRequired');
      return false;
    }
    if (!modelForm.value.baseUrl.trim()) {
      modelFormError.value = t('settings.models.errBaseUrlInput');
      return false;
    }
    if (editingModelId.value === null && !modelForm.value.apiKey.trim()) {
      modelFormError.value = t('settings.models.errApiKeyRequired');
      return false;
    }
    return true;
  };

  const saveModelForm = async () => {
    modelFormError.value = '';
    if (!validateModelForm()) return;
    isSubmittingModel.value = true;
    try {
      const payload = {
        vision: modelForm.value.vision,
        modelName: modelForm.value.modelName.trim(),
        baseUrl: modelForm.value.baseUrl.trim(),
        apiKey: modelForm.value.apiKey.trim() || undefined,
      };
      if (editingModelId.value !== null) {
        const res = await ModelAPI.update({ id: editingModelId.value, ...payload });
                if (isOk(res.code)) {
          showModelToast(t('settings.models.toastUpdated'));
          cancelModelForm();
          await loadModels();
          emit('modelUpdated');
        } else {
          modelFormError.value = t('settings.models.errSave');
        }
      } else {
        const res = await ModelAPI.add(payload);
        if (isOk(res.code)) {
          showModelToast(t('settings.models.toastAdded'));
          cancelModelForm();
          await loadModels();
          emit('modelUpdated');
        } else {
          modelFormError.value = t('settings.models.errAdd');
        }
      }
    } catch {
      modelFormError.value = t('settings.models.errNetwork');
    } finally {
      isSubmittingModel.value = false;
    }
  };

  const { confirm } = useConfirm();

  const handleDeleteModel = async (item: ModelConfigVO) => {
    if (!item.id) return;
        const ok = await confirm({
      title: t('settings.models.confirmDeleteTitle'),
      content: t('settings.models.confirmDeleteContent', { name: item.modelName || t('settings.models.unnamed') }),
      type: 'danger',
      confirmText: t('common.remove')
    });
    if (!ok) {
      return;
    }
    try {
      const res = await ModelAPI.deleteById(item.id);
      if (isOk(res.code)) {
        showModelToast(t('settings.models.toastDeleted'));
        await loadModels();
        emit('modelUpdated');
      } else {
        window.alert(t('settings.models.errDelete'));
      }
    } catch {
      window.alert(t('settings.models.errDeleteRetry'));
    }
  };

  const handleDocumentClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (!target?.closest('.model-dropdown-container')) {
      isRemoteModelDropdownOpen.value = false;
    }
    if (!target?.closest('.provider-dropdown-container')) {
      isProviderDropdownOpen.value = false;
    }
  };

  onMounted(() => {
    loadModels();
    window.addEventListener('click', handleDocumentClick);
  });

  onBeforeUnmount(() => {
    window.removeEventListener('click', handleDocumentClick);
    if (modelToastTimer) window.clearTimeout(modelToastTimer);
  });

  return {
    modelsList,
    isModelLoading,
    modelErrorMsg,
    isEditingOrAdding,
    addType,
    editingModelId,
    modelForm,
    modelFormError,
    isSubmittingModel,
    showApiKey,
    modelToast,
    providerPresets,
    selectedProvider,
    isProviderDropdownOpen,
    isFetchingRemoteModels,
    remoteModelList,
    isRemoteModelDropdownOpen,
    remoteModelSearch,
    fetchRemoteModelError,
    filteredRemoteModels,
    loadModels,
    handleApplyPreset,
    startAddModel,
    startEditModel,
    cancelModelForm,
    saveModelForm,
    handleDeleteModel,
    handleFetchRemoteModels,
    handleSelectRemoteModel,
  };
}
