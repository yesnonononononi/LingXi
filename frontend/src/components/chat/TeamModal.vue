<script setup lang="ts">
import { ref, watch, computed, onMounted, onBeforeUnmount } from 'vue';
import type { AgentVO, ModelConfig, ToolVO } from '../../types/chat';
import { TeamAPI } from '../../services/team';
import { AgentAPI } from '../../services/agent';
import { ToolAPI } from '../../services/tool';
import { isOk } from '../../utils/api';
import { toUserFacingError } from '../../utils/error';
import { useTheme } from '../../composables/useTheme';

const props = defineProps<{
  isOpen: boolean;
  isDark?: boolean;
  models?: ModelConfig[];
}>();

const { isDark: themeIsDark } = useTheme();
const isDark = computed(() => props.isDark ?? themeIsDark.value);

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'created', newTeamId?: number | string): void;
}>();

// 表单字段
const teamName = ref('');
const teamDescription = ref('');
const selectedAgentIds = ref<(number | string)[]>([]);
const commanderAgentId = ref<number | string>('');

// 数据加载与状态
const availableAgents = ref<AgentVO[]>([]);
const isLoadingAgents = ref(false);
const availableTools = ref<ToolVO[]>([]);
const isLoadingTools = ref(false);
/** 工具列表加载失败提示（区别于「确实没有工具」） */
const toolsError = ref('');
const isSubmitting = ref(false);
const errorMsg = ref('');

// 管理者自定义下拉面板状态
const isCommanderDropdownOpen = ref(false);
const commanderSelectRef = ref<HTMLElement | null>(null);

// Agent 表单状态（新建或修改）
const showAgentForm = ref(false);
const editingAgentId = ref<number | string | null>(null); // null 为新建，有 id 为编辑
const isSavingAgent = ref(false);
/** 编辑时详情拉取失败标记：此时禁用保存，避免用空 prompt 覆盖原有设定 */
const agentDetailError = ref('');
const agentFormName = ref('');
const agentFormDesc = ref('');
const agentFormPrompt = ref('');
const agentFormModelId = ref<number | string>('');
const agentFormToolList = ref<string[]>([]);

const loadAgents = async () => {
  isLoadingAgents.value = true;
  errorMsg.value = '';
  try {
    const res = await AgentAPI.list(1, 100);
    if (isOk(res.code) && res.data) {
      availableAgents.value = res.data.records || [];
    }
  } catch (err: any) {
    console.error('加载 Agent 列表失败:', err);
    errorMsg.value = '加载 Agent 列表失败，请检查网络或后端服务';
  } finally {
    isLoadingAgents.value = false;
  }
};

const loadTools = async () => {
  isLoadingTools.value = true;
  toolsError.value = '';
  try {
    const res = await ToolAPI.list();
    if (isOk(res.code) && res.data) {
      availableTools.value = res.data || [];
    } else {
      toolsError.value = '工具列表加载失败';
    }
  } catch (err: any) {
    console.error('加载工具列表失败:', err);
    toolsError.value = '工具列表加载失败，请检查网络或后端服务';
  } finally {
    isLoadingTools.value = false;
  }
};

const handleClickOutside = (e: MouseEvent) => {
  if (commanderSelectRef.value && !commanderSelectRef.value.contains(e.target as Node)) {
    isCommanderDropdownOpen.value = false;
  }
};

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleClickOutside);
});

watch(
  () => props.isOpen,
  (open) => {
    if (!open) return;
    teamName.value = '';
    teamDescription.value = '';
    selectedAgentIds.value = [];
    commanderAgentId.value = '';
    errorMsg.value = '';
    isCommanderDropdownOpen.value = false;
    closeAgentForm();
    loadAgents();
    loadTools();
  },
  { immediate: true }
);

// 切换选择成员
const toggleAgentSelection = (agentId: number | string) => {
  const index = selectedAgentIds.value.indexOf(agentId);
  if (index >= 0) {
    selectedAgentIds.value.splice(index, 1);
    if (commanderAgentId.value === agentId) {
      commanderAgentId.value = selectedAgentIds.value[0] || '';
    }
  } else {
    selectedAgentIds.value.push(agentId);
    if (!commanderAgentId.value) {
      commanderAgentId.value = agentId;
    }
  }
};

// 当前已选中的 Agent 列表
const selectedAgents = computed(() => {
  return availableAgents.value.filter(a => selectedAgentIds.value.includes(a.id));
});

// 当前管理者 Agent 对象
const currentCommander = computed(() => {
  return availableAgents.value.find(a => a.id === commanderAgentId.value) || null;
});

// 监听选中成员变化，确保管理者合法
watch(selectedAgentIds, (newIds) => {
  if (newIds.length === 0) {
    commanderAgentId.value = '';
  } else if (!newIds.includes(commanderAgentId.value)) {
    commanderAgentId.value = newIds[0];
  }
}, { deep: true });

// 打开/切换新建 Agent 表单
const openCreateAgent = () => {
  if (showAgentForm.value && editingAgentId.value === null) {
    closeAgentForm();
    return;
  }
  editingAgentId.value = null;
  agentFormName.value = '';
  agentFormDesc.value = '';
  agentFormPrompt.value = '';
  agentFormToolList.value = [];
  agentFormModelId.value = props.models?.[0]?.id ?? '';
  showAgentForm.value = true;
};

// 打开修改 Agent 表单
const openEditAgent = async (agent: AgentVO) => {
  if (showAgentForm.value && editingAgentId.value === agent.id) {
    closeAgentForm();
    return;
  }
  editingAgentId.value = agent.id;
  agentFormName.value = agent.name || '';
  agentFormDesc.value = agent.description || '';
  agentFormPrompt.value = agent.prompt || '';
  agentFormModelId.value = agent.modelId || props.models?.[0]?.id || '';
  agentFormToolList.value = agent.toolList ? [...agent.toolList] : [];
  agentDetailError.value = '';
  showAgentForm.value = true;

  // 若 prompt 尚未加载，则拉取详情获取完整 prompt 与 modelId
  if (!agent.prompt) {
    try {
      const res = await AgentAPI.findById(agent.id);
      if (isOk(res.code) && res.data) {
        if (editingAgentId.value === agent.id) {
          if (res.data.prompt && !agentFormPrompt.value) {
            agentFormPrompt.value = res.data.prompt;
          }
          if (res.data.modelId && !agentFormModelId.value) {
            agentFormModelId.value = res.data.modelId;
          }
        }
      } else if (editingAgentId.value === agent.id) {
        // 详情未取到：禁用保存，避免用户看到空 prompt 保存后覆盖原有设定
        agentDetailError.value = 'Agent 详情加载失败，已禁用保存以避免覆盖原有提示词';
      }
    } catch (e) {
      console.error('获取 Agent 详情失败:', e);
      if (editingAgentId.value === agent.id) {
        agentDetailError.value = 'Agent 详情加载失败，已禁用保存以避免覆盖原有提示词';
      }
    }
  }
};

const closeAgentForm = () => {
  showAgentForm.value = false;
  editingAgentId.value = null;
  agentFormName.value = '';
  agentFormDesc.value = '';
  agentFormPrompt.value = '';
  agentFormToolList.value = [];
  agentFormModelId.value = props.models?.[0]?.id ?? '';
  agentDetailError.value = '';
};

// 工具选择辅助逻辑
const toggleTool = (toolName: string) => {
  const index = agentFormToolList.value.indexOf(toolName);
  if (index >= 0) {
    agentFormToolList.value.splice(index, 1);
  } else {
    agentFormToolList.value.push(toolName);
  }
};

const selectAllTools = () => {
  agentFormToolList.value = availableTools.value.map(t => t.name);
};

const clearTools = () => {
  agentFormToolList.value = [];
};

// 保存 Agent（新建或修改）
const handleSaveAgent = async () => {
  errorMsg.value = '';
  if (agentDetailError.value) {
    errorMsg.value = agentDetailError.value;
    return;
  }
  if (!agentFormName.value.trim()) {
    errorMsg.value = '请填写 Agent 名称';
    return;
  }
  if (!agentFormPrompt.value.trim()) {
    errorMsg.value = '请填写 Agent 提示词/工作设定';
    return;
  }
  if (!agentFormModelId.value) {
    errorMsg.value = '请选择绑定的基座模型';
    return;
  }

  isSavingAgent.value = true;
  try {
    if (editingAgentId.value) {
      // 修改 Agent
      const res = await AgentAPI.update({
        id: editingAgentId.value,
        name: agentFormName.value.trim(),
        description: agentFormDesc.value.trim() || undefined,
        prompt: agentFormPrompt.value.trim(),
        modelId: agentFormModelId.value,
        toolList: agentFormToolList.value.length > 0 ? [...agentFormToolList.value] : [],
      });

      if (isOk(res.code)) {
        await loadAgents();
        closeAgentForm();
      } else {
        errorMsg.value = toUserFacingError(res.errMsg, '更新 Agent 失败，请稍后重试');
      }
    } else {
      // 新建 Agent
      const res = await AgentAPI.add({
        name: agentFormName.value.trim(),
        description: agentFormDesc.value.trim() || undefined,
        prompt: agentFormPrompt.value.trim(),
        modelId: agentFormModelId.value,
        toolList: agentFormToolList.value.length > 0 ? [...agentFormToolList.value] : undefined,
      });

      if (isOk(res.code)) {
        await loadAgents();
        const created = availableAgents.value.find(a => a.name === agentFormName.value.trim());
        if (created) {
          if (!selectedAgentIds.value.includes(created.id)) {
            selectedAgentIds.value.push(created.id);
            if (!commanderAgentId.value) {
              commanderAgentId.value = created.id;
            }
          }
        }
        closeAgentForm();
      } else {
        errorMsg.value = toUserFacingError(res.errMsg, '创建 Agent 失败，请稍后重试');
      }
    }
  } catch (err: any) {
    errorMsg.value = err?.message || '保存 Agent 发生异常';
  } finally {
    isSavingAgent.value = false;
  }
};

// 选择管理者
const selectCommander = (agentId: number | string) => {
  commanderAgentId.value = agentId;
  isCommanderDropdownOpen.value = false;
};

// 提交创建团队
const handleSaveTeam = async () => {
  errorMsg.value = '';
  const trimmedName = teamName.value.trim();
  if (!trimmedName) {
    errorMsg.value = '请填写团队名称';
    return;
  }
  if (selectedAgentIds.value.length === 0) {
    errorMsg.value = '请至少选择一个团队成员 Agent';
    return;
  }
  if (!commanderAgentId.value) {
    errorMsg.value = '请指定团队管理者 Agent';
    return;
  }

  isSubmitting.value = true;
  try {
    const res = await TeamAPI.add({
      name: trimmedName,
      description: teamDescription.value.trim() || undefined,
      commanderAgentId: commanderAgentId.value,
      agentIds: selectedAgentIds.value
    });

    if (isOk(res.code)) {
      emit('created');
      emit('close');
    } else {
      errorMsg.value = toUserFacingError(res.errMsg, '创建团队失败，请稍后重试');
    }
  } catch (err: any) {
    errorMsg.value = err?.message || '创建团队异常';
  } finally {
    isSubmitting.value = false;
  }
};
</script>

<template>
  <div
    v-if="isOpen"
    class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-in fade-in duration-150"
    @click.self="emit('close')"
  >
    <div
      :class="[
        'w-full max-w-lg max-h-[85vh] flex flex-col rounded-2xl border shadow-2xl transition-all overflow-hidden',
        isDark ? 'bg-black/95 border-white/20 text-zinc-100 shadow-[0_12px_40px_rgba(0,0,0,0.95)] backdrop-blur-2xl' : 'bg-white border-gray-200 text-gray-800'
      ]"
    >
      <!-- Header -->
      <div class="px-6 py-4 flex items-center justify-between border-b shrink-0" :class="isDark ? 'border-white/10' : 'border-gray-200/50'">
        <h3 class="text-base font-semibold flex items-center gap-2">
          <svg class="w-5 h-5 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
          </svg>
          <span class="dark:text-white dark:text-glow-white">创建团队 (Create Team)</span>
        </h3>
        <button
          @click="emit('close')"
          class="p-1 rounded-lg text-gray-400 hover:text-zinc-200 hover:bg-white/5 transition-colors cursor-pointer"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <!-- Body Scrollable -->
      <div class="px-6 py-4 space-y-4 overflow-y-auto text-sm">
        <div v-if="errorMsg" class="p-2.5 rounded-xl bg-red-500/10 border border-red-500/30 text-red-500 text-xs">
          {{ errorMsg }}
        </div>

        <!-- 团队名称 -->
        <div>
          <label class="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            团队名称 <span class="text-red-500">*</span>
          </label>
          <input
            v-model="teamName"
            autoFocus
            placeholder="例如: 全栈开发组 / 算法重构协同团队"
            :class="[
              'w-full px-3 py-2 rounded-xl border text-sm outline-none transition',
              isDark
                ? 'bg-black/90 border-white/15 focus:border-cyan-400/80 text-white placeholder-zinc-500'
                : 'bg-gray-50 border-gray-300 focus:border-blue-500 text-gray-900 placeholder-gray-400'
            ]"
          />
        </div>

        <!-- 团队描述 -->
        <div>
          <label class="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
            团队描述
          </label>
          <textarea
            v-model="teamDescription"
            rows="2"
            placeholder="例如: 负责全栈架构开发、代码重构与业务交付协同"
            :class="[
              'w-full px-3 py-2 rounded-xl border text-sm outline-none resize-none transition',
              isDark
                ? 'bg-black/90 border-white/15 focus:border-cyan-400/80 text-white placeholder-zinc-500'
                : 'bg-gray-50 border-gray-300 focus:border-blue-500 text-gray-900 placeholder-gray-400'
            ]"
          ></textarea>
        </div>

        <!-- 团队成员 Agent 列表 -->
        <div>
          <div class="flex items-center justify-between mb-1.5">
            <label class="block text-xs font-medium text-gray-700 dark:text-gray-300">
              团队成员 Agent <span class="text-red-500">*</span>
              <span class="text-[11px] font-normal text-gray-500 ml-1">
                (已选 {{ selectedAgentIds.length }} 个)
              </span>
            </label>
            <button
              type="button"
              @click="openCreateAgent"
              class="text-xs text-blue-500 hover:text-blue-400 cursor-pointer flex items-center gap-1"
            >
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
              </svg>
              <span>{{ showAgentForm && editingAgentId === null ? '收起新建' : '新建 Agent' }}</span>
            </button>
          </div>

          <!-- 新建 / 编辑 Agent 卡片表单 -->
          <div
            v-if="showAgentForm"
            class="mb-3 p-3.5 rounded-xl border border-blue-500/30 bg-blue-500/5 space-y-2.5 text-xs animate-in fade-in duration-150"
          >
            <div class="flex items-center justify-between">
              <div class="font-medium text-blue-500 flex items-center gap-1.5">
                <svg v-if="editingAgentId" class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                <span>{{ editingAgentId ? `修改 Agent「${agentFormName || '未命名'}」` : '新建 Agent 成员' }}</span>
              </div>
              <button
                type="button"
                @click="closeAgentForm"
                class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer"
              >
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <!-- 详情拉取失败提示：禁用保存，避免覆盖原有 prompt -->
            <div
              v-if="agentDetailError"
              class="p-2 rounded-lg text-[11px] border"
              :class="isDark ? 'bg-red-500/10 border-red-500/30 text-red-400' : 'bg-red-50 border-red-200 text-red-600'"
            >
              {{ agentDetailError }}
            </div>

            <div class="grid grid-cols-2 gap-2">
              <div>
                <label class="block text-gray-600 dark:text-gray-400 mb-0.5">Agent 名称 *</label>
                <input
                  v-model="agentFormName"
                  placeholder="例如: MathSpecialist"
                  :class="[
                    'w-full px-2.5 py-1.5 rounded-lg border outline-none',
                    isDark ? 'bg-black/90 border-white/15 text-white focus:border-cyan-400/80' : 'bg-white border-gray-300 text-gray-900'
                  ]"
                />
              </div>
              <div>
                <label class="block text-gray-600 dark:text-gray-400 mb-0.5">基座模型 *</label>
                <select
                  v-model="agentFormModelId"
                  :class="[
                    'w-full px-2.5 py-1.5 rounded-lg border outline-none cursor-pointer [color-scheme:dark]',
                    isDark ? 'bg-black border-white/15 text-white focus:border-cyan-400/80' : 'bg-white border-gray-300 text-gray-900'
                  ]"
                >
                  <option v-for="m in (models || [])" :key="m.id" :value="m.id" class="bg-black text-white">
                    {{ m.name || m.modelName || `模型 #${m.id}` }}
                  </option>
                </select>
              </div>
            </div>

            <div>
              <label class="block text-gray-600 dark:text-gray-400 mb-0.5">描述信息</label>
              <input
                v-model="agentFormDesc"
                placeholder="例如: 负责高精度数学运算与推导"
                :class="[
                  'w-full px-2.5 py-1.5 rounded-lg border outline-none',
                  isDark ? 'bg-black/90 border-white/15 text-white focus:border-cyan-400/80' : 'bg-white border-gray-300 text-gray-900'
                ]"
              />
            </div>

            <div>
              <label class="block text-gray-600 dark:text-gray-400 mb-0.5">提示词设定 *</label>
              <textarea
                v-model="agentFormPrompt"
                rows="2"
                placeholder="设定该 Agent 的角色定位与职责规范..."
                :class="[
                  'w-full px-2.5 py-1.5 rounded-lg border outline-none resize-none',
                  isDark ? 'bg-black/90 border-white/15 text-white focus:border-cyan-400/80' : 'bg-white border-gray-300 text-gray-900'
                ]"
              ></textarea>
            </div>

            <!-- 工具分配 -->
            <div>
              <div class="flex items-center justify-between mb-1">
                <label class="block text-gray-600 dark:text-gray-400 font-medium">
                  分配工具
                  <span class="text-[11px] font-normal text-gray-500 ml-1">
                    (已选 {{ agentFormToolList.length }} / {{ availableTools.length }})
                  </span>
                </label>
                <div class="flex items-center gap-2 text-[11px]">
                  <button
                    type="button"
                    @click="selectAllTools"
                    class="text-blue-500 hover:text-blue-400 cursor-pointer"
                  >
                    全选
                  </button>
                  <span class="text-gray-400">|</span>
                  <button
                    type="button"
                    @click="clearTools"
                    class="text-gray-500 hover:text-gray-400 cursor-pointer"
                  >
                    清空
                  </button>
                </div>
              </div>

              <!-- 工具列表卡片容器 -->
              <div
                v-if="isLoadingTools"
                class="p-2 text-center text-gray-400 text-xs rounded-lg border border-dashed"
                :class="isDark ? 'border-gray-700 bg-gray-900/30' : 'border-gray-300 bg-gray-50/50'"
              >
                加载工具列表中...
              </div>
              <div
                v-else-if="toolsError"
                class="p-2 text-center text-xs rounded-lg border border-dashed flex items-center justify-center gap-2"
                :class="isDark ? 'border-red-500/40 bg-red-500/10 text-red-400' : 'border-red-300 bg-red-50 text-red-600'"
              >
                <span>{{ toolsError }}</span>
                <button
                  type="button"
                  @click="loadTools"
                  class="underline hover:no-underline cursor-pointer"
                >
                  重试
                </button>
              </div>
              <div
                v-else-if="availableTools.length === 0"
                class="p-2 text-center text-gray-400 text-xs rounded-lg border border-dashed"
                :class="isDark ? 'border-white/10 bg-black/60' : 'border-gray-300 bg-gray-50/50'"
              >
                暂无可分配工具
              </div>
              <div
                v-else
                class="max-h-36 overflow-y-auto rounded-lg border p-1.5 grid grid-cols-1 sm:grid-cols-2 gap-1.5"
                :class="isDark ? 'border-white/15 bg-black/80' : 'border-gray-200 bg-white'"
              >
                <div
                  v-for="tool in availableTools"
                  :key="tool.name"
                  @click="toggleTool(tool.name)"
                  :class="[
                    'p-1.5 rounded-md border transition-all cursor-pointer flex flex-col justify-between text-left',
                    agentFormToolList.includes(tool.name)
                      ? (isDark ? 'bg-cyan-600/20 border-cyan-500/50 text-white' : 'bg-blue-50 border-blue-300 text-blue-900')
                      : (isDark ? 'bg-white/[0.04] border-white/10 text-zinc-300 hover:border-white/25' : 'bg-gray-50/80 border-gray-200 text-gray-700 hover:border-gray-300')
                  ]"
                >
                  <div class="flex items-center justify-between gap-1">
                    <div class="flex items-center gap-1.5 min-w-0">
                      <input
                        type="checkbox"
                        :checked="agentFormToolList.includes(tool.name)"
                        class="rounded text-blue-600 focus:ring-blue-500 h-3 w-3 pointer-events-none accent-cyan-500"
                      />
                      <span class="font-medium truncate font-mono text-[11px]">{{ tool.name }}</span>
                    </div>
                    <span
                      class="text-[9px] px-1 py-0.2 rounded font-normal shrink-0 border"
                      :class="tool.readOnly ? (isDark ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-300' : 'bg-emerald-100 border-emerald-200 text-emerald-700') : (isDark ? 'bg-amber-500/20 border-amber-500/30 text-amber-300' : 'bg-amber-100 border-amber-200 text-amber-700')"
                    >
                      {{ tool.readOnly ? '只读' : '读写' }}
                    </span>
                  </div>
                  <div v-if="tool.description" class="text-[10px] text-gray-400 dark:text-gray-500 truncate mt-0.5" :title="tool.description">
                    {{ tool.description }}
                  </div>
                </div>
              </div>
            </div>

            <div class="flex justify-end items-center gap-2 pt-1">
              <button
                type="button"
                @click="closeAgentForm"
                class="px-2.5 py-1 text-gray-500 hover:text-gray-700 dark:hover:text-zinc-200 rounded-lg cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                :disabled="isSavingAgent || !!agentDetailError"
                @click="handleSaveAgent"
                class="px-3 py-1 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white rounded-lg cursor-pointer shadow-sm transition"
              >
                {{ isSavingAgent ? '保存中...' : (editingAgentId ? '保存修改' : '保存并加入') }}
              </button>
            </div>
          </div>

          <!-- Agent 列表容器 -->
          <div
            class="rounded-xl border divide-y overflow-y-auto max-h-48"
            :class="[
              isDark ? 'border-white/15 divide-white/10 bg-black/90' : 'border-gray-200 divide-gray-100 bg-gray-50'
            ]"
          >
            <div v-if="isLoadingAgents" class="p-4 text-center text-xs text-gray-500">
              加载 Agent 列表中...
            </div>
            <div v-else-if="availableAgents.length === 0" class="p-4 text-center text-xs text-gray-500">
              暂无可用 Agent，请点击上方“新建 Agent”添加。
            </div>
            <div
              v-else
              v-for="agent in availableAgents"
              :key="agent.id"
              @click="toggleAgentSelection(agent.id)"
              :class="[
                'group p-2.5 flex items-center justify-between cursor-pointer transition-colors',
                selectedAgentIds.includes(agent.id)
                  ? (isDark ? 'bg-cyan-500/15' : 'bg-blue-50')
                  : (isDark ? 'hover:bg-white/5' : 'hover:bg-gray-100/80'),
                editingAgentId === agent.id ? 'ring-1 ring-blue-500/50' : ''
              ]"
            >
              <div class="flex items-center gap-2.5 min-w-0 flex-1 mr-2">
                <input
                  type="checkbox"
                  :checked="selectedAgentIds.includes(agent.id)"
                  class="rounded text-blue-600 focus:ring-blue-500 h-4 w-4 pointer-events-none"
                />
                <div class="truncate">
                  <div class="flex items-center gap-1.5">
                    <span class="text-xs font-medium text-gray-800 dark:text-gray-200 truncate">
                      {{ agent.name }}
                    </span>
                    <span
                      v-if="agent.toolList && agent.toolList.length > 0"
                      class="px-1.5 py-0.5 text-[10px] rounded bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/20"
                      :title="agent.toolList.join(', ')"
                    >
                      {{ agent.toolList.length }} 个工具
                    </span>
                    <span
                      v-else
                      class="px-1.5 py-0.5 text-[10px] rounded bg-gray-500/10 text-gray-400 dark:text-gray-500"
                    >
                      无工具
                    </span>
                  </div>
                  <div class="text-[11px] text-gray-500 dark:text-gray-400 truncate">
                    {{ agent.description || '暂无描述' }}
                  </div>
                </div>
              </div>

              <!-- 右侧动作区：修改 Agent & 管理者状态 -->
              <div class="flex items-center gap-1.5 shrink-0">
                <!-- 修改 Agent 按钮 -->
                <button
                  type="button"
                  @click.stop="openEditAgent(agent)"
                  class="p-1 rounded-md text-gray-400 hover:text-blue-500 hover:bg-blue-500/10 transition-colors cursor-pointer"
                  title="修改此 Agent"
                >
                  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>

                <!-- 管理者标识或快捷设为管理者 -->
                <span
                  v-if="commanderAgentId === agent.id"
                  class="shrink-0 px-2 py-0.5 text-[10px] rounded-full bg-blue-500/20 text-blue-500 border border-blue-500/30 font-medium"
                >
                  管理者
                </span>
                <button
                  v-else-if="selectedAgentIds.includes(agent.id)"
                  type="button"
                  @click.stop="commanderAgentId = agent.id"
                  class="opacity-0 group-hover:opacity-100 px-1.5 py-0.5 text-[10px] rounded text-gray-400 hover:text-blue-500 hover:bg-blue-500/10 transition-all cursor-pointer"
                  title="设为团队管理者"
                >
                  设为管理者
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 团队管理者选择 (Custom Dropdown) -->
        <div v-if="selectedAgents.length > 0" ref="commanderSelectRef" class="relative">
          <label class="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5">
            团队管理者 (Manager) <span class="text-red-500">*</span>
            <span class="text-[11px] font-normal text-gray-500 ml-1">
              (必须是团队成员之一，负责协调与分派子任务)
            </span>
          </label>

          <!-- 自定义下拉触发卡片 -->
          <button
            type="button"
            @click="isCommanderDropdownOpen = !isCommanderDropdownOpen"
            :class="[
              'w-full px-3.5 py-2.5 rounded-xl border text-left flex items-center justify-between transition-all outline-none cursor-pointer',
              isDark
                ? 'bg-black/90 border-white/15 hover:border-cyan-400/60 focus:border-cyan-400 text-white'
                : 'bg-white border-gray-300 hover:border-blue-400 focus:border-blue-500 text-gray-900 shadow-sm'
            ]"
          >
            <div v-if="currentCommander" class="flex items-center gap-2.5 min-w-0">
              <div class="w-7 h-7 rounded-lg bg-cyan-500/15 text-cyan-400 flex items-center justify-center shrink-0">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
              </div>
              <div class="truncate">
                <div class="flex items-center gap-1.5">
                  <span class="text-xs font-semibold text-gray-900 dark:text-zinc-100 truncate">{{ currentCommander.name }}</span>
                  <span class="px-1.5 py-0.2 text-[9px] rounded-full bg-cyan-500/20 text-cyan-300 font-medium">管理者</span>
                </div>
                <div class="text-[11px] text-gray-500 dark:text-zinc-400 truncate max-w-[320px]">
                  {{ currentCommander.description || '负责协调团队成员分工与分派子任务' }}
                </div>
              </div>
            </div>
            <div v-else class="text-xs text-gray-400">
              请点击选择团队管理者
            </div>

            <svg
              class="w-4 h-4 text-gray-400 shrink-0 transition-transform duration-200 ml-2"
              :class="{ 'rotate-180': isCommanderDropdownOpen }"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          <!-- 自定义下拉选项菜单面板 -->
          <div
            v-if="isCommanderDropdownOpen"
            class="absolute z-20 w-full mt-1.5 py-1.5 rounded-xl border shadow-2xl transition-all max-h-52 overflow-y-auto animate-in fade-in duration-100 backdrop-blur-2xl"
            :class="[
              isDark
                ? 'bg-black/95 border-white/20 shadow-[0_12px_40px_rgba(0,0,0,0.95)] text-zinc-100'
                : 'bg-white border-gray-200 shadow-gray-200/80 text-gray-800'
            ]"
          >
            <div
              v-for="agent in selectedAgents"
              :key="agent.id"
              @click="selectCommander(agent.id)"
              :class="[
                'px-3 py-2 flex items-center justify-between cursor-pointer transition-colors text-xs',
                commanderAgentId === agent.id
                  ? (isDark ? 'bg-cyan-500/15 text-cyan-300 font-medium border border-cyan-500/30' : 'bg-blue-50 text-blue-700 font-medium')
                  : (isDark ? 'hover:bg-white/10 text-zinc-300' : 'hover:bg-gray-100/80 text-gray-700')
              ]"
            >
              <div class="flex items-center gap-2.5 min-w-0">
                <!-- 勾选指示点 -->
                <div
                  class="w-4 h-4 rounded-full flex items-center justify-center shrink-0 border transition"
                  :class="commanderAgentId === agent.id
                    ? 'bg-cyan-500 border-cyan-400 text-black font-bold'
                    : (isDark ? 'border-zinc-700 bg-transparent' : 'border-gray-300 bg-transparent')"
                >
                  <svg v-if="commanderAgentId === agent.id" class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7" />
                  </svg>
                </div>

                <div class="truncate">
                  <div class="flex items-center gap-1.5">
                    <span class="truncate font-medium">{{ agent.name }}</span>
                    <span v-if="agent.toolList?.length" class="text-[10px] text-zinc-400">
                      ({{ agent.toolList.length }}个工具)
                    </span>
                  </div>
                  <div v-if="agent.description" class="text-[10px] text-zinc-400 truncate max-w-[280px]">
                    {{ agent.description }}
                  </div>
                </div>
              </div>

              <span
                v-if="commanderAgentId === agent.id"
                class="text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/15 text-cyan-300 border border-cyan-500/30 font-medium shrink-0 ml-2"
              >
                当前管理者
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div class="px-6 py-3 flex items-center justify-end border-t shrink-0" :class="isDark ? 'border-white/10' : 'border-gray-200/50'">
        <div class="flex items-center gap-2">
          <button
            type="button"
            @click="emit('close')"
            :class="[
              'px-4 py-1.5 text-xs rounded-xl border transition cursor-pointer',
              isDark ? 'border-white/15 text-zinc-300 hover:bg-white/5' : 'border-gray-300 text-gray-600 hover:bg-gray-100'
            ]"
          >
            取消
          </button>
          <button
            type="button"
            :disabled="isSubmitting"
            @click="handleSaveTeam"
            class="px-4 py-1.5 text-xs rounded-xl text-white font-medium shadow-md transition cursor-pointer"
            :class="isDark ? 'bg-cyan-600 hover:bg-cyan-500 shadow-[0_0_15px_rgba(8,145,178,0.4)]' : 'bg-blue-600 hover:bg-blue-500 disabled:opacity-50'"
          >
            {{ isSubmitting ? '创建中...' : '创建团队' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
