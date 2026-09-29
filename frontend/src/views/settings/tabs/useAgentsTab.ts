import { ref, onMounted, onBeforeUnmount } from 'vue';
import { AgentAPI, ToolAPI, ModelAPI } from '../../../services/api';
import type { AgentVO, ToolVO, ModelConfigVO } from '../../../types/chat';
import { isOk } from '../../../utils/api';
import { useConfirm } from '../../../composables/useConfirm';

export function useAgentsTab() {
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
        agentsErrorMsg.value = '加载智能体列表失败，请稍后重试';
      }
    } catch {
      agentsErrorMsg.value = '加载智能体失败，请稍后重试';
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
        toolsErrorMsg.value = '加载工具列表失败，请稍后重试';
      }
    } catch (e) {
      console.error('加载工具失败:', e);
      toolsErrorMsg.value = '加载工具列表失败，请稍后重试';
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
    if (!modelId) return '未绑定模型';
    const found = modelsList.value.find(m => String(m.id) === String(modelId));
    return found?.modelName || `模型 #${modelId}`;
  };

  const startAddAgent = () => {
    editingAgentId.value = null;
    agentForm.value = {
      name: '',
      modelId: modelsList.value[0]?.id ?? '',
      description: '',
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
      agentFormError.value = '请填写智能体名称';
      return;
    }
    if (!agentForm.value.modelId) {
      agentFormError.value = '请选择绑定的模型';
      return;
    }
    if (!agentForm.value.prompt.trim()) {
      agentFormError.value = '请填写提示词设定';
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
          prompt: agentForm.value.prompt.trim(),
          toolList: [...agentForm.value.toolList],
        });
        if (isOk(res.code)) {
          showAgentToast('智能体已成功更新');
          isEditingOrAddingAgent.value = false;
          await loadAgents();
        } else {
          agentFormError.value = '更新失败，请稍后重试';
        }
      } else {
        const res = await AgentAPI.add({
          name: agentForm.value.name.trim(),
          modelId: agentForm.value.modelId,
          description: agentForm.value.description.trim() || undefined,
          prompt: agentForm.value.prompt.trim(),
          toolList: agentForm.value.toolList.length > 0 ? [...agentForm.value.toolList] : undefined,
        });
        if (isOk(res.code)) {
          showAgentToast('智能体已成功创建');
          isEditingOrAddingAgent.value = false;
          await loadAgents();
        } else {
          agentFormError.value = '创建失败，请稍后重试';
        }
      }
    } catch {
      agentFormError.value = '保存智能体失败，请稍后重试';
    } finally {
      isSubmittingAgent.value = false;
    }
  };

  const { confirm } = useConfirm();

  const handleDeleteAgent = async (agent: AgentVO) => {
    const confirmed = await confirm({
      title: '删除智能体',
      message: `确定要删除智能体「${agent.name}」吗？此操作无法撤销。`,
      confirmText: '确认删除',
      cancelText: '取消',
      type: 'danger',
    });
    if (!confirmed) return;

    try {
      const res = await AgentAPI.delById(agent.id);
      if (isOk(res.code)) {
        showAgentToast('智能体已删除');
        await loadAgents();
      } else {
        showAgentToast('删除失败，请稍后重试');
      }
    } catch {
      showAgentToast('删除智能体异常');
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
