import { ref, onMounted, onBeforeUnmount } from 'vue';
import { AgentAPI, ToolAPI, ModelAPI } from '../../../services/api';
import type { AgentVO, ToolVO, ModelConfigVO } from '../../../types/chat';
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
      const res = await ModelAPI.list(1, 100);
      if (isOk(res.code)) {
        modelsList.value = res.data?.records ?? [];
      }
    } catch (e) {
      console.error('加载模型列表失败:', e);
    }
  };

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
    isEditingOrAddingAgent,
    editingAgentId,
    agentForm,
    agentFormError,
    isSubmittingAgent,
    agentToast,
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
