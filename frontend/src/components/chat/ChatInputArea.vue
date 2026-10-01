<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onBeforeUnmount } from 'vue';
import DropUpSelect from '../common/DropUpSelect.vue';
import ProjectDropdown from './ProjectDropdown.vue';
import type { SelectOption } from '../../types/ui';
import type { ChatMode, ModelConfig, WorkspaceVO, AgentAccessMode, TeamVO, AgentVO } from '../../types/chat';
import { TeamAPI } from '../../services/team';
import { AgentAPI } from '../../services/agent';
import { isOk } from '../../utils/api';

const props = defineProps<{
  isSending?: boolean;
  isDark?: boolean;
  models?: ModelConfig[];
  selectedModelId?: string | number;
  hasActiveSession?: boolean;
  canChangeWorkspace?: boolean;
  workspaces?: WorkspaceVO[];
  selectedWorkspaceId?: string | number | null;
  accessMode?: AgentAccessMode | string;
  teams?: TeamVO[];
  selectedTeamId?: string | number | null;
  agents?: AgentVO[];
  selectedAgentId?: string | number | null;
  /**
   * 上下文用量指示器数据（模型选择器左侧展示）：
   * usedTokens 来自运行时 CONTEXT_UPDATE 事件；maxTokens 优先事件自带、回落 common_config.max_tokens。
   * null / usedTokens 缺失 = 会话尚无上下文数据，指示器隐藏（绝不显示伪造的 0）。
   */
  contextUsage?: {
    usedTokens: number;
    maxTokens?: number | null;
    ratio?: number | null;
    phase?: string;
    message?: string;
  } | null;
}>();

const emit = defineEmits<{
  (e: 'openModelEditor'): void;
  (e: 'openTeamModal'): void;
  (e: 'sendMessage', text: string, isDeepThink: boolean, isHybridSearch: boolean, requirePlan: boolean, teamId?: string | number | null, agentId?: string | number | null, imageFile?: File | null): void;
  (e: 'stopGeneration'): void;
  (e: 'updateMode', mode: ChatMode): void;
  (e: 'updateModel', modelId: string | number): void;
  (e: 'updateAccessMode', mode: AgentAccessMode): void;
  (e: 'updateTeam', teamId: string | number | null): void;
  (e: 'updateAgent', agentId: string | number | null): void;
  (e: 'selectWorkspace', workspace: WorkspaceVO | null): void;
  (e: 'newProject'): void;
  (e: 'quickStart'): void;
  (e: 'clearCurrentSession'): void;
  (e: 'exportSession'): void;
  (e: 'openSettings'): void;
  /** 直达设置弹窗的指定 tab（如 'mcp'），由宿主透传给 SettingsModal 的 initialTab */
  (e: 'openSettingsTab', tab: string): void;
}>();


const inputText = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);

// 状态：深度思考、混合搜索、计划模式
const isDeepThink = ref(false);
const isHybridSearch = ref(false);
const isPlanMode = ref(false);

// 原始 File 用于上传，Object URL 仅用于本地预览。
const attachedImage = ref<File | null>(null);
const attachedImagePreview = ref<string | null>(null);
const fileInputRef = ref<HTMLInputElement | null>(null);

const processImageFile = (file: File) => {
  if (!file || !file.type.startsWith('image/')) return;
  if (attachedImagePreview.value) URL.revokeObjectURL(attachedImagePreview.value);
  attachedImage.value = file;
  attachedImagePreview.value = URL.createObjectURL(file);
  nextTick(() => textareaRef.value?.focus());
};

const handlePaste = (e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items || items.length === 0) return;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if (file) {
        processImageFile(file);
      }
      break;
    }
  }
};

const handleFileChange = (e: Event) => {
  const target = e.target as HTMLInputElement;
  const file = target.files?.[0];
  if (file) {
    processImageFile(file);
  }
  target.value = '';
};

const triggerUpload = () => {
  fileInputRef.value?.click();
};

const removeAttachedImage = () => {
  if (attachedImagePreview.value) URL.revokeObjectURL(attachedImagePreview.value);
  attachedImage.value = null;
  attachedImagePreview.value = null;
};

// 模式同步
watch(() => props.hasActiveSession, () => {
  // 会话切换时的处理逻辑（如需）
});

// 仅在没有任何消息记录的新会话中允许切换项目目录
const allowWorkspaceChange = computed(() => {
  if (props.canChangeWorkspace !== undefined) {
    return props.canChangeWorkspace;
  }
  return !props.hasActiveSession;
});

watch(isPlanMode, (val) => {
  emit('updateMode', val ? 'plan' : 'auto');
});

// ====== Team 团队选择与后端分页获取 ======
const teamSelectRef = ref<{ open: () => void; close: () => void } | null>(null);
const localTeams = ref<TeamVO[]>([]);
const isLoadingTeams = ref(false);
const teamPage = ref(1);
const teamPageSize = ref(20);
const teamTotal = ref(0);

const fetchTeams = async (page = 1) => {
  isLoadingTeams.value = true;
  try {
    const res = await TeamAPI.list(page, teamPageSize.value);
    if (isOk(res.code) && res.data) {
      teamPage.value = res.data.current || page;
      teamTotal.value = res.data.total || 0;
      localTeams.value = res.data.records || [];
    }
  } catch (err) {
    console.error('获取 Team 团队列表失败:', err);
  } finally {
    isLoadingTeams.value = false;
  }
};

onMounted(() => {
  fetchTeams(1);
  fetchAgents(1);
});

const localSelectedTeamId = ref<string | number>('');
watch(
  () => props.selectedTeamId,
  (val) => {
    localSelectedTeamId.value = val ?? '';
  },
  { immediate: true }
);

const ADD_TEAM_OPTION = '__add_team__';

const selectedTeam = computed<string | number>({
  get: () => localSelectedTeamId.value,
  set: (val) => {
    if (val === ADD_TEAM_OPTION) {
      emit('openTeamModal');
      return;
    }
    localSelectedTeamId.value = val;
    // 团队与单 Agent 互斥：选了团队就退回"未指定 Agent"
    if (val) {
      localSelectedAgentId.value = '';
      emit('updateAgent', null);
    }
    emit('updateTeam', val ? val : null);
  }
});

// ====== 单 Agent 直聊选择与后端分页获取 ======
const localAgents = ref<AgentVO[]>([]);
const isLoadingAgents = ref(false);
const agentPage = ref(1);
const agentPageSize = ref(50);
const agentTotal = ref(0);

const fetchAgents = async (page = 1) => {
  isLoadingAgents.value = true;
  try {
    const res = await AgentAPI.list(page, agentPageSize.value);
    if (isOk(res.code) && res.data) {
      agentPage.value = res.data.current || page;
      agentTotal.value = res.data.total || 0;
      localAgents.value = res.data.records || [];
    }
  } catch (err) {
    console.error('获取 Agent 列表失败:', err);
  } finally {
    isLoadingAgents.value = false;
  }
};

const localSelectedAgentId = ref<string | number>('');
watch(
  () => props.selectedAgentId,
  (val) => {
    localSelectedAgentId.value = val ?? '';
  },
  { immediate: true }
);

const selectedAgent = computed<string | number>({
  get: () => localSelectedAgentId.value,
  set: (val) => {
    localSelectedAgentId.value = val;
    // 单 Agent 与团队互斥：选了具体 Agent 就退出团队模式
    if (val) {
      localSelectedTeamId.value = '';
      emit('updateTeam', null);
    }
    emit('updateAgent', val ? val : null);
  }
});

const currentAgentName = computed(() => {
  if (!localSelectedAgentId.value) return '';
  const list = props.agents && props.agents.length > 0 ? props.agents : localAgents.value;
  const found = list.find(a => String(a.id) === String(localSelectedAgentId.value));
  return found?.name || `Agent #${localSelectedAgentId.value}`;
});

const clearSelectedAgent = () => {
  selectedAgent.value = '';
};

// ====== /agent 触发的上拉浮层菜单 (对齐 media_1789911005357.png) ======
const isAgentMenuOpen = ref(false);
const agentMenuRef = ref<HTMLElement | null>(null);
const agentSearchInputRef = ref<HTMLInputElement | null>(null);
const agentSearchQuery = ref('');
const activeAgentIndex = ref(0);

interface AgentItem {
  id: string | number;
  name: string;
  description: string;
  modelId?: string | number;
}

const allAgentsList = computed<AgentItem[]>(() => {
  const list = props.agents && props.agents.length > 0 ? props.agents : localAgents.value;
  return [
    { id: '', name: '默认agent', description: '使用全局系统提示词' },
    ...list.map(a => ({
      id: a.id,
      name: a.name || `Agent #${a.id}`,
      description: a.description || (a.modelId ? `模型 #${a.modelId}` : ''),
      modelId: a.modelId
    }))
  ];
});

const filteredAgentList = computed<AgentItem[]>(() => {
  const q = agentSearchQuery.value.trim().toLowerCase();
  if (!q) return allAgentsList.value;
  return allAgentsList.value.filter(a =>
    a.name.toLowerCase().includes(q) ||
    a.description.toLowerCase().includes(q)
  );
});

watch(agentSearchQuery, () => {
  activeAgentIndex.value = 0;
});

const openAgentMenu = () => {
  isAgentMenuOpen.value = true;
  isCommandMenuOpen.value = false;
  isCommandMenuClickedOpen.value = false;
  agentSearchQuery.value = '';
  const currentIdx = filteredAgentList.value.findIndex(a => String(a.id) === String(selectedAgent.value));
  activeAgentIndex.value = currentIdx >= 0 ? currentIdx : 0;
  nextTick(() => {
    agentSearchInputRef.value?.focus();
  });
};

const closeAgentMenu = () => {
  if (!isAgentMenuOpen.value) return;
  isAgentMenuOpen.value = false;
  agentSearchQuery.value = '';
  nextTick(() => {
    textareaRef.value?.focus();
  });
};

const navigateAgent = (direction: number) => {
  const total = filteredAgentList.value.length;
  if (total === 0) return;
  activeAgentIndex.value = (activeAgentIndex.value + direction + total) % total;
};

const handleAgentEnter = () => {
  if (filteredAgentList.value.length > 0) {
    const selected = filteredAgentList.value[activeAgentIndex.value];
    if (selected) {
      selectAgentItem(selected);
    }
  }
};

const selectAgentItem = (agent: AgentItem) => {
  selectedAgent.value = agent.id;
  closeAgentMenu();
};

const teamOptions = computed<SelectOption<string | number>[]>(() => {
  const list = props.teams && props.teams.length > 0 ? props.teams : localTeams.value;
  return [
    { label: '未指定', value: '' },
    ...list.map(t => ({
      label: t.name || `团队 #${t.id}`,
      value: t.id,
    })),
    { label: '+ 添加团队', value: ADD_TEAM_OPTION }
  ];
});


// 基座模型
const ADD_CUSTOM_MODEL = '__add_custom_model__';
const modelOptions = computed<SelectOption<string | number>[]>(() => [
  ...(props.models ?? []).map(m => ({
    label: m.name || m.modelName || `模型 #${m.id}`,
    value: m.id,
  })),
  { label: '添加自定义模型', value: ADD_CUSTOM_MODEL }
]);
const selectedModel = computed<string | number>({
  get: () => props.selectedModelId ?? '',
  set: (value) => { if (value === ADD_CUSTOM_MODEL) { emit('openModelEditor'); return; } emit('updateModel', value); }
});

/** ≥1000 显示 `216.7K`（与产品稿一致，1000000 → `1000.0K`），否则原值 */
const formatContextTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`);

/**
 * 上下文用量文案：`21.7% · 216.7K / 1000.0K 上下文已使用`。
 * ratio 优先事件自带；缺失时用 used/max 现算；max 也缺失时退化为仅用量。
 * 正在压缩（SQUEEZE_STARTED）时把提示语换为压缩中文案，数值仍展示（压缩前口径）。
 */
const contextUsageText = computed<string>(() => {
  const usage = props.contextUsage;
  const used = usage?.usedTokens;
  if (used == null || used <= 0) return '';
  const max = usage?.maxTokens ?? null;
  const ratio = usage?.ratio ?? (max && max > 0 ? used / max : null);
  const pct = ratio != null && ratio >= 0 ? `${(ratio * 100).toFixed(1)}%` : null;
  const amount = `${formatContextTokens(used)}${max && max > 0 ? ` / ${formatContextTokens(max)}` : ''}`;
  const label = usage?.phase === 'SQUEEZE_STARTED' ? '上下文压缩中' : '上下文已使用';
  return pct ? `${pct} · ${amount} ${label}` : `${amount} ${label}`;
});

/** 进度环几何：周长 = 2πr（r=6，viewBox 16）；弧长按 ratio 截断到 [0, 周长] */
const CONTEXT_RING_RADIUS = 6;
const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_RING_RADIUS;
const contextRingDash = computed<string>(() => {
  const usage = props.contextUsage;
  const ratio = usage?.ratio ?? (usage?.maxTokens && usage.maxTokens > 0 ? usage.usedTokens / usage.maxTokens : null);
  const clamped = ratio != null ? Math.min(Math.max(ratio, 0), 1) : 0;
  const arc = clamped * CONTEXT_RING_CIRCUMFERENCE;
  return `${arc} ${CONTEXT_RING_CIRCUMFERENCE - arc}`;
});

const adjustHeight = () => {
  if (!textareaRef.value) return;
  textareaRef.value.style.height = 'auto';
  textareaRef.value.style.height = `${Math.min(textareaRef.value.scrollHeight, 180)}px`;
};

// 快捷指令 (/ 或 + 触发)
interface CommandItem {
  id: string;
  name: string;
  desc: string;
  action: () => void;
}

const isCommandMenuOpen = ref(false);
const isCommandMenuClickedOpen = ref(false);
const activeCommandIndex = ref(0);
const commandContainerRef = ref<HTMLElement | null>(null);

const allCommands = computed<CommandItem[]>(() => [
  {
    id: 'plan',
    name: 'plan',
    desc: '进入计划模式 (生成分步执行规划)',
    action: () => {
      isPlanMode.value = true;
      inputText.value = '';
      nextTick(() => {
        textareaRef.value?.focus();
      });
    }
  },
  {
    id: 'model',
    name: 'model',
    desc: '选择或配置本会话使用的模型',
    action: () => {
      emit('openModelEditor');
    }
  },
  {
    id: 'workspace',
    name: 'workspace',
    desc: '切换或新建工作空间 (Workspace)',
    action: () => {
      emit('newProject');
    }
  },
  {
    id: 'clear',
    name: 'clear',
    desc: '清空当前会话的历史消息',
    action: () => {
      emit('clearCurrentSession');
    }
  },
  {
    id: 'export',
    name: 'export',
    desc: '将当前会话内容导出为 Markdown 文件',
    action: () => {
      emit('exportSession');
    }
  },
  {
    id: 'team',
    name: 'team',
    desc: '指定 Team 团队 (协同多 Agent 执行)',
    action: () => {
      teamSelectRef.value?.open();
    }
  },
  {
    id: 'add-team',
    name: 'add-team',
    desc: '创建并配置新的多 Agent 协同团队',
    action: () => {
      emit('openTeamModal');
    }
  },
  {
    id: 'agent',
    name: 'agent',
    desc: '指定单个 Agent 直聊 (使用其人设与工具清单)',
    action: () => {
      openAgentMenu();
    }
  },

  {
    id: 'permission',
    name: 'permission',
    desc: '打开权限预设设置 (工作区内修改 / 只读 / 完全访问)',
    action: () => {
      emit('openSettings');
    }
  },
  {
    id: 'mcp',
    name: 'mcp',
    desc: '管理 MCP 服务 (接入外部工具，执行时注入模型)',
    action: () => {
      emit('openSettingsTab', 'mcp');
    }
  },
  {
    id: 'settings',
    name: 'settings',
    desc: '打开系统全局设置与偏好配置',
    action: () => {
      emit('openSettings');
    }
  }
]);

const commandQuery = computed(() => {
  if (inputText.value.startsWith('/')) {
    return inputText.value.slice(1).trim().toLowerCase();
  }
  return '';
});

const filteredCommands = computed(() => {
  const q = commandQuery.value;
  if (!q) return allCommands.value;
  return allCommands.value.filter(c => c.name.toLowerCase().includes(q) || c.desc.toLowerCase().includes(q));
});

watch(inputText, (val) => {
  nextTick(adjustHeight);
  // 用户输入 /plan 触发 Plan 模式
  if (val.startsWith('/plan ') || val === '/plan') {
    isPlanMode.value = true;
    inputText.value = val.replace(/^\/plan\s*/, '');
    isCommandMenuOpen.value = false;
    isCommandMenuClickedOpen.value = false;
    return;
  }
  // 用户输入 /permission 引导打开设置弹窗
  if (val.startsWith('/permission ') || val === '/permission') {
    inputText.value = '';
    isCommandMenuOpen.value = false;
    isCommandMenuClickedOpen.value = false;
    emit('openSettings');
    return;
  }
  // 用户输入 /agent 自动展开 Agent 选择浮层 (对齐 media_1789911005357.png)
  if (val === '/agent' || val.startsWith('/agent ') || val === '/agent\n') {
    inputText.value = val.replace(/^\/agent\s*/, '');
    isCommandMenuOpen.value = false;
    isCommandMenuClickedOpen.value = false;
    openAgentMenu();
    return;
  }
  // 用户输入 /mcp 直达设置弹窗的 MCP 服务页
  if (val.startsWith('/mcp ') || val === '/mcp') {
    inputText.value = '';
    isCommandMenuOpen.value = false;
    isCommandMenuClickedOpen.value = false;
    emit('openSettingsTab', 'mcp');
    return;
  }
  if (val.startsWith('/')) {
    if (!isAgentMenuOpen.value) {
      isCommandMenuOpen.value = true;
      activeCommandIndex.value = 0;
    }
  } else if (!isCommandMenuClickedOpen.value) {
    isCommandMenuOpen.value = false;
  }
});

const handlePlusClick = () => {
  isCommandMenuOpen.value = !isCommandMenuOpen.value;
  if (isCommandMenuOpen.value) {
    isCommandMenuClickedOpen.value = true;
    activeCommandIndex.value = 0;
  } else {
    isCommandMenuClickedOpen.value = false;
  }
};

const selectCommand = (cmd: CommandItem) => {
  if (inputText.value.startsWith('/')) {
    inputText.value = '';
    if (textareaRef.value) {
      textareaRef.value.style.height = 'auto';
    }
  }
  isCommandMenuOpen.value = false;
  isCommandMenuClickedOpen.value = false;
  cmd.action();
  nextTick(() => {
    if (!isAgentMenuOpen.value) {
      textareaRef.value?.focus();
    }
  });
};

const handleClickOutside = (event: MouseEvent) => {
  const target = event.target as Node;
  if (commandContainerRef.value && !commandContainerRef.value.contains(target)) {
    isCommandMenuOpen.value = false;
    isCommandMenuClickedOpen.value = false;
    isAgentMenuOpen.value = false;
  } else if (agentMenuRef.value && !agentMenuRef.value.contains(target) && textareaRef.value?.contains(target)) {
    isAgentMenuOpen.value = false;
  }
};

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside);
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleClickOutside);
  if (attachedImagePreview.value) URL.revokeObjectURL(attachedImagePreview.value);
});

const handleKeyDown = (e: KeyboardEvent) => {
  if (isAgentMenuOpen.value) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeAgentMenu();
      return;
    }
  }

  if (isCommandMenuOpen.value && filteredCommands.value.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeCommandIndex.value = (activeCommandIndex.value + 1) % filteredCommands.value.length;
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeCommandIndex.value = (activeCommandIndex.value - 1 + filteredCommands.value.length) % filteredCommands.value.length;
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const selected = filteredCommands.value[activeCommandIndex.value];
      if (selected) {
        selectCommand(selected);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      isCommandMenuOpen.value = false;
      isCommandMenuClickedOpen.value = false;
      return;
    }
  }

  // 当处于 Plan 模式且输入为空时，按 Backspace 键退出 Plan 模式
  if (e.key === 'Backspace' && isPlanMode.value && !inputText.value) {
    e.preventDefault();
    isPlanMode.value = false;
    return;
  }

  // 当处于单 Agent 模式且输入为空时，按 Backspace 键退出 Agent 直聊模式
  if (e.key === 'Backspace' && localSelectedAgentId.value && !inputText.value) {
    e.preventDefault();
    clearSelectedAgent();
    return;
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
};

const handleSend = () => {
  const text = inputText.value.trim();
  const image = attachedImage.value;
  if ((!text && !image) || props.isSending) return;

  // 若用户只上传了图片没输入文字，自动填入默认提示词避免后端校验失败
  const effectiveText = text || '请分析并描述该图片';

  emit(
    'sendMessage',
    effectiveText,
    isDeepThink.value,
    isHybridSearch.value,
    isPlanMode.value,
    localSelectedTeamId.value ? localSelectedTeamId.value : null,
    localSelectedAgentId.value ? localSelectedAgentId.value : null,
    image
  );

  inputText.value = '';
  // 请求链已持有 File，此时可释放本地预览 URL。
  if (attachedImagePreview.value) URL.revokeObjectURL(attachedImagePreview.value);
  attachedImage.value = null;
  attachedImagePreview.value = null;
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto';
  }
};

// 暴露常用方法以支持外部调用
defineExpose({
  focus: () => textareaRef.value?.focus(),
  /** 聚焦输入框（供 useChatInputFocus 注入的聚焦能力调用；基于本组件已有的 textareaRef，不用全局 querySelector） */
  focusInput: () => textareaRef.value?.focus(),
  setInputText: (text: string) => {
    inputText.value = text;
    nextTick(adjustHeight);
  },
  setAttachedImage: (file: File | null) => {
    if (file) processImageFile(file);
    else removeAttachedImage();
  },
  fetchTeams,
  selectTeam: (id: string | number | null) => {
    localSelectedTeamId.value = id ?? '';
    emit('updateTeam', id ?? null);
  },
  fetchAgents,
  selectAgent: (id: string | number | null) => {
    localSelectedAgentId.value = id ?? '';
    emit('updateAgent', id ?? null);
  },
  openAgentMenu
});

</script>

<template>
  <div class="w-full max-w-3xl mx-auto px-4 select-none">
    <!-- Top Pills Row: Workspace Selector (仅在没有任何消息记录的新会话中展示) -->
    <div v-if="allowWorkspaceChange" class="mb-2 flex items-center justify-start gap-2 whitespace-nowrap overflow-hidden">
      <!-- 1. Workspace Pill Dropdown -->
      <ProjectDropdown
        :workspaces="workspaces || []"
        :selectedWorkspaceId="selectedWorkspaceId"
        :isDark="isDark"
        @selectWorkspace="(ws) => emit('selectWorkspace', ws)"
        @newProject="emit('newProject')"
        @quickStart="emit('quickStart')"
      />
    </div>

    <!-- Big Rounded Input Card Container -->
    <div
      ref="commandContainerRef"
      @paste="handlePaste"
      :class="[
        'relative rounded-[20px] border shadow-xs transition-all p-3.5 pb-2.5 flex flex-col gap-2 outline-none ring-0 focus-within:outline-none focus-within:ring-0',
        isDark 
          ? 'bg-[#151b28] border-gray-800' 
          : 'bg-white border-gray-200/90'
      ]"
    >
      <!-- Floating Command Menu (/ or + triggered, exactly matching media_1789698282919.png) -->
      <div
        v-if="isCommandMenuOpen && filteredCommands.length > 0"
        :class="[
          'absolute bottom-full left-0 mb-2.5 w-full rounded-2xl border shadow-2xl p-2 z-40 transition-all animate-in fade-in zoom-in-95 duration-100',
          isDark
            ? 'bg-[#182030] border-[#2b374f] text-gray-200'
            : 'bg-white border-gray-200 text-gray-800'
        ]"
      >
        <!-- Header -->
        <div class="px-2.5 pt-1 pb-1.5 text-xs text-gray-400 dark:text-gray-500 font-medium select-none">
          指令
        </div>

        <!-- Command List -->
        <div class="max-h-60 overflow-y-auto scrollbar-thin space-y-0.5">
          <div
            v-for="(cmd, idx) in filteredCommands"
            :key="cmd.id"
            @click="selectCommand(cmd)"
            @mouseenter="activeCommandIndex = idx"
            :class="[
              'flex items-center gap-3 px-3 py-2 rounded-xl cursor-pointer transition-colors text-xs select-none',
              activeCommandIndex === idx
                ? (isDark ? 'bg-white/10 text-white' : 'bg-gray-100 text-gray-900 font-medium')
                : (isDark ? 'text-gray-300 hover:bg-white/5' : 'text-gray-700 hover:bg-gray-50')
            ]"
          >
            <span class="font-medium text-gray-900 dark:text-white shrink-0 min-w-18">
              {{ cmd.name }}
            </span>
            <span class="text-gray-500 dark:text-gray-400 truncate">
              {{ cmd.desc }}
            </span>
          </div>
        </div>
      </div>

      <!-- Floating Agent Selection Menu (/agent triggered, exactly matching media_1789911005357.png) -->
      <div
        v-if="isAgentMenuOpen"
        ref="agentMenuRef"
        :class="[
          'absolute bottom-full left-0 mb-2.5 w-full rounded-2xl border shadow-2xl p-2 z-50 transition-all animate-in fade-in zoom-in-95 duration-100 backdrop-blur-md',
          isDark
            ? 'bg-[#182030]/95 border-[#2b374f] text-gray-200 shadow-[0_12px_30px_rgba(0,0,0,0.5)]'
            : 'bg-white/95 border-gray-200 text-gray-800 shadow-[0_12px_30px_rgba(0,0,0,0.12)]'
        ]"
      >
        <!-- Top Search Box (搜索...) -->
        <div class="px-2.5 pt-1 pb-1.5 shrink-0">
          <input
            ref="agentSearchInputRef"
            v-model="agentSearchQuery"
            type="text"
            placeholder="搜索..."
            class="w-full px-1 py-0.5 text-xs bg-transparent border-none outline-none focus:outline-none focus:ring-0 select-text"
            :class="isDark ? 'text-gray-100 placeholder-gray-500' : 'text-gray-800 placeholder-gray-400'"
            @keydown.down.prevent="navigateAgent(1)"
            @keydown.up.prevent="navigateAgent(-1)"
            @keydown.enter.prevent="handleAgentEnter"
            @keydown.esc.prevent="closeAgentMenu"
          />
        </div>

        <!-- Agent List -->
        <div class="max-h-60 overflow-y-auto scrollbar-thin space-y-0.5 pt-0.5">
          <div
            v-if="filteredAgentList.length === 0"
            class="px-3 py-3 text-xs text-gray-400 dark:text-gray-500 text-center"
          >
            无匹配的 Agent
          </div>

          <div
            v-for="(agent, idx) in filteredAgentList"
            :key="agent.id"
            @click="selectAgentItem(agent)"
            @mouseenter="activeAgentIndex = idx"
            :class="[
              'px-3 py-2 rounded-xl text-xs flex items-center justify-between gap-3 cursor-pointer transition-colors select-none',
              activeAgentIndex === idx
                ? (isDark ? 'bg-white/10 text-white' : 'bg-gray-100 text-gray-900 font-medium')
                : (isDark ? 'text-gray-300 hover:bg-white/5' : 'text-gray-700 hover:bg-gray-50')
            ]"
          >
            <!-- Left: Agent Name -->
            <span class="font-normal truncate shrink-0 max-w-[45%]">
              {{ agent.name }}
            </span>

            <!-- Right: Description / Model tag & Checkmark -->
            <div class="flex items-center gap-2 overflow-hidden justify-end flex-1 min-w-0">
              <span class="text-xs text-gray-400 dark:text-gray-500 truncate text-right">
                {{ agent.description }}
              </span>

              <!-- Selected Checkmark (✓) -->
              <svg
                v-if="String(agent.id) === String(selectedAgent)"
                class="w-4 h-4 shrink-0"
                :class="isDark ? 'text-gray-200' : 'text-gray-900'"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </div>
          </div>
        </div>
      </div>

      <!-- Image Thumbnail Preview (匹配用户参考图 media_1789908967614.png) -->
      <div v-if="attachedImage" class="pt-0.5 pb-1 flex items-center">
        <div class="relative inline-block group/preview">
          <!-- 缩略图本体：黑色/深色底圆角卡片，内部预览图 -->
          <div class="w-13 h-13 sm:w-14 sm:h-14 rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700/80 bg-black/90 shadow-sm flex items-center justify-center">
            <img
              :src="attachedImagePreview || ''"
              alt="待发送图片"
              class="w-full h-full object-cover"
            />
          </div>
          <!-- 右上角小圆关闭按钮 (对齐参考图中右上角带 x 的浅色圆形按钮) -->
          <button
            type="button"
            @click="removeAttachedImage"
            class="absolute -top-1.5 -right-1.5 w-4.5 h-4.5 rounded-full bg-white dark:bg-[#1e2638] text-gray-500 hover:text-gray-800 dark:text-gray-300 dark:hover:text-white shadow-sm border border-gray-200/90 dark:border-gray-600 flex items-center justify-center cursor-pointer transition-transform hover:scale-110 select-none z-10"
            title="移除图片"
          >
            <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>

      <!-- Textarea Input Area with optional /plan prefix and /agent token -->
      <div class="flex items-start gap-1.5 w-full min-w-0">
        <!-- Amber /plan token matching media_1789698947784.png -->
        <span
          v-if="isPlanMode"
          @click="isPlanMode = false"
          class="text-amber-500 font-medium text-sm leading-relaxed shrink-0 select-none cursor-pointer hover:opacity-80 px-0.5 whitespace-nowrap"
          title="点击退出 Plan 模式"
        >
          /plan
        </span>

        <!-- Agent Token Pill when a specific agent is selected -->
        <span
          v-if="currentAgentName"
          @click="openAgentMenu"
          class="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 my-0.5 rounded-lg bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-400 select-none cursor-pointer hover:opacity-90 shrink-0 transition whitespace-nowrap"
          title="点击切换 Agent，或点击 × 清除"
        >
          <span>🤖 {{ currentAgentName }}</span>
          <span
            class="hover:text-red-500 hover:bg-black/5 dark:hover:bg-white/10 rounded-full w-3.5 h-3.5 flex items-center justify-center text-xs leading-none transition"
            @click.stop="clearSelectedAgent"
            title="退出 Agent 直聊"
          >×</span>
        </span>

        <textarea
          ref="textareaRef"
          v-model="inputText"
          @keydown="handleKeyDown"
          @paste="handlePaste"
          rows="2"
          :placeholder="isPlanMode ? '描述你的任务以生成计划' : '描述你想要构建的内容，/ 调用指令，@ 文件或对话'"
          :class="[
            'flex-1 min-w-0 bg-transparent outline-none border-none resize-none text-sm leading-relaxed px-0.5 max-h-44 scrollbar-thin focus:ring-0 focus:outline-none placeholder:truncate placeholder:whitespace-nowrap',
            isDark ? 'text-gray-100 placeholder-gray-500' : 'text-gray-800 placeholder-gray-400'
          ]"
        ></textarea>
      </div>

      <!-- Bottom Toolbar Row -->
      <div class="flex items-center justify-between pt-1 flex-nowrap gap-2 min-w-0">
        <!-- Left Toolbar Items: +, @, 🛡️ Scope -->
        <div class="flex items-center gap-1.5 flex-nowrap shrink min-w-0">
          <!-- + Add Button (Trigger Command Menu) -->
          <button
            type="button"
            @click="handlePlusClick"
            :class="[
              'p-1.5 rounded-lg transition-colors cursor-pointer shrink-0',
              isCommandMenuOpen
                ? (isDark ? 'bg-white/10 text-white' : 'bg-gray-100 text-gray-900')
                : (isDark ? 'text-gray-500 hover:text-gray-200 hover:bg-gray-800' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100')
            ]"
            title="快捷指令 (/)"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
            </svg>
          </button>

          <!-- 图片上传按钮与隐藏文件选择器 -->
          <input
            ref="fileInputRef"
            type="file"
            accept="image/*"
            class="hidden"
            @change="handleFileChange"
          />
          <button
            type="button"
            @click="triggerUpload"
            :class="[
              'p-1.5 rounded-lg transition-colors cursor-pointer shrink-0',
              attachedImage
                ? 'text-blue-500 bg-blue-50 dark:bg-blue-500/15'
                : (isDark ? 'text-gray-500 hover:text-gray-200 hover:bg-gray-800' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100')
            ]"
            title="上传图片 (可直接粘贴图片到输入框)"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </button>

          <!-- Team Dropdown (👥 指定 Team 团队) -->
          <div class="flex items-center gap-1 text-xs text-gray-600 dark:text-gray-400 shrink min-w-0">
        
            <DropUpSelect
              ref="teamSelectRef"
              v-model="selectedTeam"
              :options="teamOptions"
              :isDark="isDark"
              size="sm"
              placeholder="指定团队"
              trigger-class="border-none bg-transparent hover:bg-black/[0.05] dark:hover:bg-white/[0.08] text-gray-600 dark:text-gray-400 text-xs px-2 h-8 flex items-center rounded-md whitespace-nowrap shrink-0"
            />
          </div>
        </div>

        <!-- Right Toolbar Items: Context Usage Indicator & Model Selector & Send Button -->
        <div class="flex items-center gap-2 shrink-0">
          <!-- 上下文用量指示器：常态只显示圆环，悬停时上方浮出文案气泡（会话尚无事件数据时隐藏） -->
          <div
            v-if="contextUsageText"
            class="group relative flex items-center text-[11px] text-gray-400 dark:text-gray-500 select-none cursor-help"
          >
            <!-- 圆环进度：轨道灰环 + 按 ratio 的弧长，-90° 从顶部起弧 -->
            <svg class="w-3.5 h-3.5 shrink-0 -rotate-90" viewBox="0 0 16 16" aria-hidden="true">
              <circle
                cx="8" cy="8" r="6" fill="none" stroke-width="2.5"
                class="stroke-gray-200 dark:stroke-gray-700"
              />
              <circle
                cx="8" cy="8" r="6" fill="none" stroke-width="2.5" stroke-linecap="round"
                class="stroke-gray-400 dark:stroke-gray-500 transition-[stroke-dasharray] duration-500"
                :stroke-dasharray="contextRingDash"
              />
            </svg>
            <!-- 文案气泡：悬停时在圆环上方浮出（水平居中于环，淡入 + 轻微上移过渡） -->
            <div
              class="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 whitespace-nowrap rounded-lg border px-2.5 py-1.5 shadow-md opacity-0 translate-y-1 transition-all duration-150 ease-out group-hover:opacity-100 group-hover:translate-y-0"
              :class="isDark
                ? 'bg-[#161d2b] border-gray-700/80 text-gray-300 shadow-black/40'
                : 'bg-white border-gray-200 text-gray-500 shadow-gray-400/10'"
            >
              {{ contextUsageText }}
            </div>
          </div>

          <!-- Model Selector Pill -->
          <DropUpSelect
            v-model="selectedModel"
            :options="modelOptions"
            :isDark="isDark"
            size="sm"
            placeholder="选择模型"
            trigger-class="border-none bg-transparent hover:bg-black/[0.05] dark:hover:bg-white/[0.08] text-gray-600 dark:text-gray-300 text-xs px-2.5 h-8 flex items-center rounded-lg whitespace-nowrap"
          />

          <!-- Send / Stop Button -->
          <button
            v-if="isSending"
            @click="emit('stopGeneration')"
            class="w-8 h-8 rounded-full bg-red-500 hover:bg-red-600 text-white transition flex items-center justify-center shadow-xs cursor-pointer shrink-0"
            title="停止生成"
          >
            <div class="w-3 h-3 bg-white rounded-xs"></div>
          </button>

          <button
            v-else
            @click="handleSend"
            :disabled="!inputText.trim() && !attachedImage"
            :class="[
              'w-8 h-8 rounded-full transition-colors flex items-center justify-center shadow-xs shrink-0',
              (inputText.trim() || attachedImage)
                ? 'bg-blue-600 hover:bg-blue-500 text-white cursor-pointer' 
                : (isDark ? 'bg-gray-800 text-gray-600 cursor-not-allowed' : 'bg-gray-200 text-gray-400 cursor-not-allowed')
            ]"
            title="发送消息"
          >
            <!-- Upward Arrow SVG -->
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M12 19V5m0 0l-5 5m5-5l5 5" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
