import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { ModelAPI } from '../../../services/api';
import type { ModelConfigVO, OpenAIModelItem } from '../../../types/chat';
import { isOk } from '../../../utils/api';
import { extractOpenAIError, parseOpenAIModelList } from '../../../utils/openaiModels';
import { useConfirm } from '../../../composables/useConfirm';

export function useModelsTab(emit: (e: 'modelUpdated') => void) {
  const modelsList = ref<ModelConfigVO[]>([]);
  const isModelLoading = ref(false);
  const modelErrorMsg = ref('');
  const isEditingOrAdding = ref(false);
  const addType = ref<'preset' | 'custom'>('preset');
  const editingModelId = ref<number | string | null>(null);
  const modelForm = ref({
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
        modelErrorMsg.value = res.errMsg || '加载模型列表失败，请稍后重试';
      }
    } catch {
      modelErrorMsg.value = '加载模型配置失败，请稍后重试';
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
        modelName: '',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: '',
      };
    } else {
      selectedProvider.value = '';
      modelForm.value = {
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
      modelFormError.value = '请先填写 API Base URL';
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
        fetchRemoteModelError.value = '未获取到任何可用模型';
      }
    } catch (err: any) {
      console.error('获取模型列表失败:', err);
      fetchRemoteModelError.value = err.message || '获取模型列表失败，请检查 Base URL 与 API Key 或网络跨域';
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
    modelForm.value = { modelName: '', baseUrl: '', apiKey: '' };
    modelFormError.value = '';
    isRemoteModelDropdownOpen.value = false;
    isProviderDropdownOpen.value = false;
    remoteModelList.value = [];
    fetchRemoteModelError.value = '';
  };

  const validateModelForm = () => {
    if (!modelForm.value.modelName.trim()) {
      modelFormError.value = '请输入模型名称';
      return false;
    }
    if (!modelForm.value.baseUrl.trim()) {
      modelFormError.value = '请输入 API Base URL';
      return false;
    }
    if (editingModelId.value === null && !modelForm.value.apiKey.trim()) {
      modelFormError.value = '请输入 API Key';
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
        modelName: modelForm.value.modelName.trim(),
        baseUrl: modelForm.value.baseUrl.trim(),
        apiKey: modelForm.value.apiKey.trim() || undefined,
      };
      if (editingModelId.value !== null) {
        const res = await ModelAPI.update({ id: editingModelId.value, ...payload });
        if (isOk(res.code)) {
          showModelToast('模型更新成功');
          cancelModelForm();
          await loadModels();
          emit('modelUpdated');
        } else {
          modelFormError.value = '保存失败，请稍后重试';
        }
      } else {
        const res = await ModelAPI.add(payload);
        if (isOk(res.code)) {
          showModelToast('模型添加成功');
          cancelModelForm();
          await loadModels();
          emit('modelUpdated');
        } else {
          modelFormError.value = '添加失败，请稍后重试';
        }
      }
    } catch {
      modelFormError.value = '网络请求异常，请稍后重试';
    } finally {
      isSubmittingModel.value = false;
    }
  };

  const { confirm } = useConfirm();

  const handleDeleteModel = async (item: ModelConfigVO) => {
    if (!item.id) return;
    const ok = await confirm({
      title: '删除模型',
      content: `确定要删除模型「${item.modelName || '未命名模型'}」吗？删除后不可恢复。`,
      type: 'danger',
      confirmText: '删除'
    });
    if (!ok) {
      return;
    }
    try {
      const res = await ModelAPI.deleteById(item.id);
      if (isOk(res.code)) {
        showModelToast('模型已删除');
        await loadModels();
        emit('modelUpdated');
      } else {
        window.alert('删除失败，请稍后重试');
      }
    } catch {
      window.alert('删除失败，请重试');
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
