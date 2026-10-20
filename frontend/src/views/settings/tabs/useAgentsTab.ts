import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { AgentAPI, ToolAPI, ModelAPI } from '../../../services/api';
import type { AgentVO, ToolVO, ModelConfigVO } from '../../../types/chat';
import type { SelectOption } from '../../../types/ui';
import { isOk } from '../../../utils/api';
import { useConfirm } from '../../../composables/useConfirm';
import { useI18n } from '../../../i18n';

/** 头像长度上限，与后端 `Agent.AVATAR_MAX_LENGTH` 一致 */
const AGENT_AVATAR_MAX_LENGTH = 255;

export function useAgentsTab() {
  const { t } = useI18n();
  const agentsList = ref<AgentVO[]>([]);
  const isAgentsLoading = ref(false);
  const agentsErrorMsg = ref('');
  const availableTools = ref<ToolVO[]>([]);
  const isToolsLoading = ref(false);
  const toolsErrorMsg = ref('');
  const modelsList = ref<ModelConfigVO[]>([]);

  const isEditingOrAddingAgent = ref(false);
  const editingAgentId = ref<number | string | null>(null);
  const agentForm = ref({
    name: '',
    modelId: '' as number | string,
    description: '',
    avatar: '',
    prompt: '',
    toolList: [] as string[],
  });
  const agentFormError = ref('');
  const isSubmittingAgent = ref(false);
  const agentToast = ref('');
  let agentToastTimer: number | undefined;

  /** 批量操作：勾选的智能体标识，按字符串比较（后端 id 可能是字符串） */
  const selectedAgentIds = ref<Array<number | string>>([]);
  /** 批量操作：待统一绑定的模型，空串表示还没选 */
  const batchModelId = ref<number | string>('');
  const isApplyingBatchModel = ref(false);

  /** 同一性判定统一按字符串，避免 `5` 与 `"5"` 判不等。 */
  const isSameId = (left: number | string, right: number | string): boolean => String(left) === String(right);

  const isAgentSelected = (id: number | string): boolean =>
    selectedAgentIds.value.some(selected => isSameId(selected, id));

  const isAllAgentsSelected = computed(
    () => agentsList.value.length > 0 && agentsList.value.every(agent => isAgentSelected(agent.id))
  );

  const toggleAgentSelection = (id: number | string) => {
    if (isAgentSelected(id)) {
      selectedAgentIds.value = selectedAgentIds.value.filter(selected => !isSameId(selected, id));
    } else {
      selectedAgentIds.value = [...selectedAgentIds.value, id];
    }
  };

  /** 全选 / 取消全选：以当前列表为准，不残留已下架项的标识。 */
  const toggleAllAgents = () => {
    selectedAgentIds.value = isAllAgentsSelected.value ? [] : agentsList.value.map(agent => agent.id);
  };

  /** 退出批量操作：清空勾选与待应用模型，避免下次进来带着上次的状态。 */
  const clearBatchSelection = () => {
    selectedAgentIds.value = [];
    batchModelId.value = '';
  };

  const showAgentToast = (msg: string) => {
    agentToast.value = msg;
    if (agentToastTimer) window.clearTimeout(agentToastTimer);
    agentToastTimer = window.setTimeout(() => {
      agentToast.value = '';
    }, 2500);
  };

  const loadAgents = async () => {
    isAgentsLoading.value = true;
    agentsErrorMsg.value = '';
    try {
      const res = await AgentAPI.list(1, 100);
      if (isOk(res.code)) {
        agentsList.value = res.data?.records ?? [];
        // 列表刷新后剔除已不存在的勾选项，否则「已选择 N 个」会越来越虚。
        selectedAgentIds.value = selectedAgentIds.value.filter(selected =>
          agentsList.value.some(agent => isSameId(agent.id, selected))
        );
      } else {
                agentsErrorMsg.value = t('settings.agents.errLoadList');
      }
    } catch {
      agentsErrorMsg.value = t('settings.agents.errLoad');
    } finally {
      isAgentsLoading.value = false;
    }
  };

  const loadTools = async () => {
    isToolsLoading.value = true;
    toolsErrorMsg.value = '';
    try {
      const res = await ToolAPI.list();
      if (isOk(res.code) && res.data) {
        availableTools.value = res.data;
            } else {
        toolsErrorMsg.value = t('settings.agents.errLoadTools');
      }
    } catch (e) {
      console.error('加载工具失败:', e);
      toolsErrorMsg.value = t('settings.agents.errLoadTools');
    } finally {
      isToolsLoading.value = false;
    }
  };

  const loadModels = async () => {
    try {
      // 聚合接口一次带出「提供商 → 模型」：同名模型来自不同提供商时，下拉里能分清来源。
      const res = await ModelAPI.catalog();
      if (isOk(res.code)) {
        modelsList.value = (res.data ?? []).flatMap(group => group.models ?? []);
      }
    } catch (e) {
      console.error('加载模型列表失败:', e);
    }
  };

  /** 基座模型下拉：按提供商分组，选中值仍是 model id。 */
  const modelOptions = computed<SelectOption<string | number>[]>(() => {
    const ungrouped = t('settings.models.ungrouped');
    return modelsList.value
      .filter(model => model.id !== undefined && model.id !== null)
      .map(model => ({
        label: model.modelName || t('settings.agents.modelFallback', { id: model.id ?? '' }),
        value: model.id as string | number,
        group: model.providerName || ungrouped,
        groupIcon: model.providerIcon ?? undefined,
      }));
  });

  /** DropUpSelect 的 v-model 只收 string | number，未选时为空串。 */
  const selectedModelValue = computed<string | number>({
    get: () => agentForm.value.modelId,
    set: (value) => {
      agentForm.value.modelId = value;
    },
  });

  /** 批量栏的模型下拉，与表单里的下拉共用同一批选项。 */
  const batchModelValue = computed<string | number>({
    get: () => batchModelId.value,
    set: (value) => {
      batchModelId.value = value;
    },
  });

    const getModelName = (modelId?: number | string) => {
    if (!modelId) return t('settings.agents.unboundModel');
    const found = modelsList.value.find(m => String(m.id) === String(modelId));
    return found?.modelName || t('settings.agents.modelFallback', { id: modelId });
  };

  const startAddAgent = () => {
    editingAgentId.value = null;
    agentForm.value = {
      name: '',
      modelId: modelsList.value[0]?.id ?? '',
      description: '',
      avatar: '',
      prompt: '',
      toolList: [],
    };
    agentFormError.value = '';
    isEditingOrAddingAgent.value = true;
  };

  const startEditAgent = (agent: AgentVO) => {
    editingAgentId.value = agent.id;
    agentForm.value = {
      name: agent.name || '',
      modelId: agent.modelId ?? modelsList.value[0]?.id ?? '',
      description: agent.description || '',
      avatar: agent.avatar || '',
      prompt: agent.prompt || '',
      toolList: agent.toolList ? [...agent.toolList] : [],
    };
    agentFormError.value = '';
    isEditingOrAddingAgent.value = true;
  };

  const cancelAgentForm = () => {
    isEditingOrAddingAgent.value = false;
    editingAgentId.value = null;
    agentFormError.value = '';
  };

  const toggleAgentTool = (toolName: string) => {
    const index = agentForm.value.toolList.indexOf(toolName);
    if (index >= 0) {
      agentForm.value.toolList.splice(index, 1);
    } else {
      agentForm.value.toolList.push(toolName);
    }
  };

  const selectAllAgentTools = () => {
    agentForm.value.toolList = availableTools.value.map(t => t.name);
  };

  const clearAgentTools = () => {
    agentForm.value.toolList = [];
  };

  const handleSaveAgent = async () => {
    agentFormError.value = '';
        if (!agentForm.value.name.trim()) {
      agentFormError.value = t('settings.agents.errNameRequired');
      return;
    }
    if (!agentForm.value.modelId) {
      agentFormError.value = t('settings.agents.errModelRequired');
      return;
    }
    if (!agentForm.value.prompt.trim()) {
      agentFormError.value = t('settings.agents.errPromptRequired');
      return;
    }
    // 与后端 Agent.AVATAR_MAX_LENGTH 一致（init.sql 列宽同为 255）
    if (agentForm.value.avatar.trim().length > AGENT_AVATAR_MAX_LENGTH) {
      agentFormError.value = t('settings.agents.errAvatarTooLong', { max: AGENT_AVATAR_MAX_LENGTH });
      return;
    }

    isSubmittingAgent.value = true;
    try {
      if (editingAgentId.value) {
        const res = await AgentAPI.update({
          id: editingAgentId.value,
          name: agentForm.value.name.trim(),
          modelId: agentForm.value.modelId,
          description: agentForm.value.description.trim() || undefined,
          // 更新时始终传字符串：空串 = 清除头像；不传 = 不修改
          avatar: agentForm.value.avatar.trim(),
          prompt: agentForm.value.prompt.trim(),
          toolList: [...agentForm.value.toolList],
        });
                if (isOk(res.code)) {
          showAgentToast(t('settings.agents.toastUpdated'));
          isEditingOrAddingAgent.value = false;
          await loadAgents();
        } else {
          agentFormError.value = t('settings.agents.errUpdate');
        }
      } else {
        const res = await AgentAPI.add({
          name: agentForm.value.name.trim(),
          modelId: agentForm.value.modelId,
          description: agentForm.value.description.trim() || undefined,
          avatar: agentForm.value.avatar.trim() || undefined,
          prompt: agentForm.value.prompt.trim(),
          toolList: agentForm.value.toolList.length > 0 ? [...agentForm.value.toolList] : undefined,
        });
                if (isOk(res.code)) {
          showAgentToast(t('settings.agents.toastCreated'));
          isEditingOrAddingAgent.value = false;
          await loadAgents();
        } else {
          agentFormError.value = t('settings.agents.errCreate');
        }
      }
    } catch {
      agentFormError.value = t('settings.agents.errSave');
    } finally {
      isSubmittingAgent.value = false;
    }
  };

  const { confirm } = useConfirm();

  const handleDeleteAgent = async (agent: AgentVO) => {
        const confirmed = await confirm({
      title: t('settings.agents.confirmDeleteTitle'),
      message: t('settings.agents.confirmDeleteContent', { name: agent.name }),
      confirmText: t('common.confirmDelete'),
      cancelText: t('common.cancel'),
      type: 'danger',
    });
    if (!confirmed) return;

    try {
      const res = await AgentAPI.delById(agent.id);
      if (isOk(res.code)) {
        showAgentToast(t('settings.agents.toastDeleted'));
        await loadAgents();
      } else {
        showAgentToast(t('settings.agents.errDelete'));
      }
    } catch {
      showAgentToast(t('settings.agents.errDeleteException'));
    }
  };

  /** 把勾选的智能体统一绑定到批量栏选中的模型。 */
  const handleApplyBatchModel = async () => {
    if (selectedAgentIds.value.length === 0) {
      showAgentToast(t('settings.agents.errBatchNoSelection'));
      return;
    }
    if (!batchModelId.value) {
      showAgentToast(t('settings.agents.errBatchNoModel'));
      return;
    }

    isApplyingBatchModel.value = true;
    try {
      const res = await AgentAPI.changeModelBatch({
        ids: [...selectedAgentIds.value],
        modelId: batchModelId.value,
      });
      if (isOk(res.code)) {
        showAgentToast(
          t('settings.agents.toastBatchModelApplied', { count: res.data ?? selectedAgentIds.value.length })
        );
        clearBatchSelection();
        await loadAgents();
      } else {
        // 业务错误是 HTTP 200 + code 非成功：必须把后端文案上屏，否则用户只知道「失败了」。
        showAgentToast(res.errMsg || t('settings.agents.errBatchModel'));
      }
    } catch {
      showAgentToast(t('settings.agents.errBatchModelException'));
    } finally {
      isApplyingBatchModel.value = false;
    }
  };

  onMounted(async () => {
    await Promise.all([loadAgents(), loadTools(), loadModels()]);
  });

  onBeforeUnmount(() => {
    if (agentToastTimer) window.clearTimeout(agentToastTimer);
  });

  return {
    agentsList,
    isAgentsLoading,
    agentsErrorMsg,
    availableTools,
    isToolsLoading,
    toolsErrorMsg,
    modelsList,
    modelOptions,
    selectedModelValue,
    isEditingOrAddingAgent,
    editingAgentId,
    agentForm,
    agentFormError,
    isSubmittingAgent,
    agentToast,
    selectedAgentIds,
    batchModelId,
    batchModelValue,
    isApplyingBatchModel,
    isAllAgentsSelected,
    isAgentSelected,
    toggleAgentSelection,
    toggleAllAgents,
    clearBatchSelection,
    handleApplyBatchModel,
    loadAgents,
    loadTools,
    getModelName,
    startAddAgent,
    startEditAgent,
    cancelAgentForm,
    toggleAgentTool,
    selectAllAgentTools,
    clearAgentTools,
    handleSaveAgent,
    handleDeleteAgent,
  };
}
