<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onBeforeUnmount, type CSSProperties } from 'vue';
import {
  Attachment01Icon,
  Cancel01Icon,
  File02Icon,
  HelpCircleIcon,
  Mic01Icon,
  PlusSignIcon,
  SparklesIcon,
  Tick02Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconArray } from '@hugeicons/vue';
import { animate, motionValue, useReducedMotion, type AnimationPlaybackControls } from 'motion-v';
import DropUpSelect from '../common/DropUpSelect.vue';
import BorderGlow from '../common/BorderGlow.vue';
import ProjectDropdown from './ProjectDropdown.vue';
import type { SelectOption } from '../../types/ui';
import type { ChatMode, ModelConfig, WorkspaceVO, AgentAccessMode, TeamVO, AgentVO, ReasoningEffort } from '../../types/chat';
import { reasoningEffortOptions } from '../../composables/useReasoningEffort';
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
  reasoningEffort?: ReasoningEffort;
  reasoningEffortPending?: boolean;
  reasoningEffortError?: string;
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
  (e: 'updateReasoningEffort', effort: ReasoningEffort): void;
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

// PromptBar 样式与动效常量
const ARROW_UP = [12, 4.5, 18.5, 11, 14.25, 11, 14.25, 19.5, 9.75, 19.5, 9.75, 11, 5.5, 11];
const SQUARE = [12, 6, 18, 6, 18, 12, 18, 18, 6, 18, 6, 12, 6, 6];
const EASE_IN_OUT: [number, number, number, number] = [0.77, 0, 0.175, 1];
const LINE = 22;
const EDGE = 11;

const MUTED = '[color:color-mix(in_srgb,var(--pb-ink)_55%,transparent)]';
const TOOL_BTN =
  'inline-flex h-7 flex-none cursor-pointer touch-manipulation items-center gap-1 rounded-lg border-0 bg-transparent px-2 text-[12px] font-medium outline-none select-none [color:color-mix(in_srgb,var(--pb-ink)_70%,transparent)] [font:inherit] [-webkit-tap-highlight-color:transparent] [transition:background-color_150ms_ease,color_150ms_ease] data-[on]:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] data-[on]:[color:var(--pb-ink)] [@media(hover:hover)_and_(pointer:fine)]:hover:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] [@media(hover:hover)_and_(pointer:fine)]:hover:[color:var(--pb-ink)] data-[max]:[color:var(--pb-spark)]!';
const ICON_BTN =
  'inline-grid h-7 w-7 flex-none cursor-pointer touch-manipulation place-items-center rounded-lg border-0 bg-transparent p-0 outline-none select-none [color:color-mix(in_srgb,var(--pb-ink)_60%,transparent)] [font:inherit] [-webkit-tap-highlight-color:transparent] [transition:background-color_150ms_ease,color_150ms_ease,transform_160ms_cubic-bezier(0.23,1,0.32,1)] active:[transform:scale(0.94)] data-[on]:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] data-[on]:[color:var(--pb-ink)] motion-reduce:active:[transform:none] [@media(hover:hover)_and_(pointer:fine)]:hover:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] [@media(hover:hover)_and_(pointer:fine)]:hover:[color:var(--pb-ink)]';

const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const pathAt = (a: number[], b: number[], t: number) => {
  let d = '';
  for (let i = 0; i < a.length; i += 2) {
    d += `${i ? 'L' : 'M'}${mix(a[i], b[i], t).toFixed(2)} ${mix(a[i + 1], b[i + 1], t).toFixed(2)}`;
  }
  return `${d}Z`;
};

type Spark = {
  x: number;
  y: number;
  r: number;
  vy: number;
  sway: number;
  phase: number;
  life: number;
  span: number;
};

const reduce = useReducedMotion();
const commandContainerRef = ref<HTMLDivElement | null>(null);
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const sparkRef = ref<HTMLCanvasElement | null>(null);
const sendSvg = ref<SVGSVGElement | null>(null);
const sendPath = ref<SVGPathElement | null>(null);
const typing = { energy: 0, strokes: 0 };

const inputText = ref('');
const isDeepThink = computed(() => ['high', 'xhigh', 'max'].includes(props.reasoningEffort ?? 'low'));
const isHybridSearch = ref(false);
const isPlanMode = ref(false);

// 附件管理
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

// 仅在没有任何消息记录的新会话中允许切换项目目录
const allowWorkspaceChange = computed(() => {
  if (props.canChangeWorkspace !== undefined) {
    return props.canChangeWorkspace;
  }
  return !props.hasActiveSession;
});
const isProjectDropdownOpen = ref(false);

watch(isPlanMode, (val) => {
  emit('updateMode', val ? 'plan' : 'auto');
});

const effortList = reasoningEffortOptions.map(option => option.label);
const effortIndex = ref(1);
const effortOpen = ref(false);
const level = computed(() => effortList[effortIndex.value] ?? 'Low');
const maxed = computed(() => effortIndex.value === effortList.length - 1);

watch(() => [props.reasoningEffort, props.reasoningEffortPending] as const, ([value]) => {
  const index = reasoningEffortOptions.findIndex(option => option.value === value);
  effortIndex.value = index < 0 ? 1 : index;
}, { immediate: true });

const setEffort = (i: number) => {
  const next = Math.max(0, Math.min(effortList.length - 1, i));
  if (next === effortIndex.value) return;
  effortIndex.value = next;
  emit('updateReasoningEffort', reasoningEffortOptions[next]!.value);
};
const effortFromPointer = (e: PointerEvent) => {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const k = (e.clientX - rect.left - EDGE) / Math.max(1, rect.width - 2 * EDGE);
  setEffort(Math.round(k * (effortList.length - 1)));
};
const onEffortDown = (e: PointerEvent) => {
  if (e.button !== 0) return;
  const el = e.currentTarget as HTMLElement;
  try {
    el.setPointerCapture(e.pointerId);
  } catch {
    // ignore
  }
  el.focus({ preventScroll: true });
  effortFromPointer(e);
};
const onEffortMove = (e: PointerEvent) => {
  if (e.buttons & 1) effortFromPointer(e);
};
const onEffortKey = (e: KeyboardEvent) => {
  const step =
    e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
  if (step) {
    e.preventDefault();
    setEffort(effortIndex.value + step);
  } else if (e.key === 'Home') {
    e.preventDefault();
    setEffort(0);
  } else if (e.key === 'End') {
    e.preventDefault();
    setEffort(effortList.length - 1);
  } else if (e.key === 'Escape') {
    effortOpen.value = false;
    textareaRef.value?.focus();
  }
};
const stepAt = (i: number) =>
  `calc(${EDGE}px + (100% - ${EDGE * 2}px) * ${i / Math.max(1, effortList.length - 1)})`;
const fillAt = (i: number) => (i === effortList.length - 1 ? '100%' : `calc(${stepAt(i)} + 7px)`);
const effortStyle = computed(
  () =>
    ({
      '--pb-effort-x': stepAt(effortIndex.value),
      '--pb-effort-fill': fillAt(effortIndex.value)
    }) as CSSProperties
);

const toggleEffort = () => {
  isCommandMenuOpen.value = false;
  isCommandMenuClickedOpen.value = false;
  isAgentMenuOpen.value = false;
  effortOpen.value = !effortOpen.value;
};

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

// ====== /agent 触发的上拉浮层菜单 ======
const isAgentMenuOpen = ref(false);
const agentMenuRef = ref<HTMLElement | null>(null);
const agentSearchInputRef = ref<HTMLInputElement | null>(null);
const agentSearchQuery = ref('');
const activeAgentIndex = ref(0);
const agentRowRefs: (HTMLButtonElement | null)[] = [];
const agentGlowRef = ref<HTMLSpanElement | null>(null);

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
  effortOpen.value = false;
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

watch(
  [isAgentMenuOpen, activeAgentIndex, filteredAgentList],
  () => {
    const glow = agentGlowRef.value;
    if (!glow || !isAgentMenuOpen.value) return;
    const row = agentRowRefs[activeAgentIndex.value];
    if (!row) {
      glow.style.opacity = '0';
      return;
    }
    glow.style.top = `${row.offsetTop}px`;
    glow.style.height = `${row.offsetHeight}px`;
    glow.style.opacity = '1';
  },
  { flush: 'post' }
);

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

/** ≥1000 显示 `216.7K` */
const formatContextTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : `${n}`);

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

const CONTEXT_RING_RADIUS = 6;
const CONTEXT_RING_CIRCUMFERENCE = 2 * Math.PI * CONTEXT_RING_RADIUS;
const contextRingDash = computed<string>(() => {
  const usage = props.contextUsage;
  const ratio = usage?.ratio ?? (usage?.maxTokens && usage.maxTokens > 0 ? usage.usedTokens / usage.maxTokens : null);
  const clamped = ratio != null ? Math.min(Math.max(ratio, 0), 1) : 0;
  const arc = clamped * CONTEXT_RING_CIRCUMFERENCE;
  return `${arc} ${CONTEXT_RING_CIRCUMFERENCE - arc}`;
});

/** 仅在鼠标悬停在用量圆环图标上时显示上下文浮层提示 */
const isContextTooltipVisible = ref(false);

const adjustHeight = () => {
  if (!textareaRef.value) return;
  textareaRef.value.style.height = '0px';
  const max = LINE * 5;
  textareaRef.value.style.height = `${Math.min(textareaRef.value.scrollHeight, max)}px`;
  textareaRef.value.style.overflowY = textareaRef.value.scrollHeight > max ? 'auto' : 'hidden';
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
const commandRowRefs: (HTMLButtonElement | null)[] = [];
const commandGlowRef = ref<HTMLSpanElement | null>(null);

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

watch(
  [isCommandMenuOpen, activeCommandIndex, filteredCommands],
  () => {
    const glow = commandGlowRef.value;
    if (!glow || !isCommandMenuOpen.value) return;
    const row = commandRowRefs[activeCommandIndex.value];
    if (!row) {
      glow.style.opacity = '0';
      return;
    }
    glow.style.top = `${row.offsetTop}px`;
    glow.style.height = `${row.offsetHeight}px`;
    glow.style.opacity = '1';
  },
  { flush: 'post' }
);

watch(inputText, (val) => {
  nextTick(adjustHeight);
  if (val.startsWith('/plan ') || val === '/plan') {
    isPlanMode.value = true;
    inputText.value = val.replace(/^\/plan\s*/, '');
    isCommandMenuOpen.value = false;
    isCommandMenuClickedOpen.value = false;
    return;
  }
  if (val.startsWith('/permission ') || val === '/permission') {
    inputText.value = '';
    isCommandMenuOpen.value = false;
    isCommandMenuClickedOpen.value = false;
    emit('openSettings');
    return;
  }
  if (val === '/agent' || val.startsWith('/agent ') || val === '/agent\n') {
    inputText.value = val.replace(/^\/agent\s*/, '');
    isCommandMenuOpen.value = false;
    isCommandMenuClickedOpen.value = false;
    openAgentMenu();
    return;
  }
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
  effortOpen.value = false;
  isAgentMenuOpen.value = false;
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
    nextTick(adjustHeight);
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
    effortOpen.value = false;
  } else if (agentMenuRef.value && !agentMenuRef.value.contains(target) && textareaRef.value?.contains(target)) {
    isAgentMenuOpen.value = false;
  }
};

// ====== 语音听写 (Mic) 支撑 ======
let dictation = 0;
const listening = ref(false);
const hasDictate = computed(() => {
  if (typeof window === 'undefined') return false;
  const win = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return !!(win.SpeechRecognition || win.webkitSpeechRecognition);
});

const toggleListen = () => {
  const win = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
  };
  const SpeechRecognitionCtor = win.SpeechRecognition || win.webkitSpeechRecognition;
  if (!SpeechRecognitionCtor) return;

  if (listening.value) {
    dictation += 1;
    listening.value = false;
    return;
  }

  const seq = ++dictation;
  listening.value = true;
  try {
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = 'zh-CN';
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (e: SpeechRecognitionEventInstance) => {
      if (seq !== dictation) return;
      const text = e.results?.[0]?.[0]?.transcript;
      if (text) {
        inputText.value = inputText.value.trim() ? `${inputText.value.trimEnd()} ${text}` : text;
        nextTick(adjustHeight);
      }
      listening.value = false;
      textareaRef.value?.focus();
    };
    recognition.onerror = () => {
      if (seq === dictation) listening.value = false;
    };
    recognition.onend = () => {
      if (seq === dictation) listening.value = false;
    };
    recognition.start();
  } catch {
    listening.value = false;
  }
};

type SpeechRecognitionEventInstance = {
  results: { [index: number]: { [index: number]: { transcript: string } } };
};
type SpeechRecognitionInstance = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventInstance) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
};

// ====== Send 按钮 SVG 图标 Morphing 动画 (motion-v) ======
const canSend = computed(() => !props.reasoningEffortPending && (inputText.value.trim().length > 0 || !!attachedImage.value));
const armed = computed(() => !!props.isSending || canSend.value);
const pressed = ref(false);

const sendT = motionValue(props.isSending ? 1 : 0);
let sendDir = props.isSending ? 1 : -1;
let sendControls: AnimationPlaybackControls | null = null;
const sendStart = pathAt(ARROW_UP, SQUARE, sendT.get());
let offSend: (() => void) | undefined;

const syncSend = () => {
  const target = props.isSending ? 1 : 0;
  sendDir = props.isSending ? 1 : -1;
  if (sendT.get() === target) return;
  sendControls?.stop();
  sendControls = animate(
    sendT,
    target,
    reduce.value ? { duration: 0 } : { duration: 0.24, ease: EASE_IN_OUT }
  );
};
watch(() => props.isSending, syncSend);

const down = (e: PointerEvent) => {
  if (e.button !== 0 || !armed.value) return;
  pressed.value = true;
};
const up = () => {
  pressed.value = false;
};

const onSendClick = () => {
  if (props.isSending) emit('stopGeneration');
  else handleSend();
};

// ====== 粒子画布特效 (Sparks Canvas) ======
let stopSpark: (() => void) | null = null;
const startSpark = () => {
  const canvas = sparkRef.value;
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  typing.strokes = 0;
  let raf = 0;
  let last = performance.now();
  let w = 0;
  let h = 0;
  let due = 0;
  let speed = 1;
  let pulse = 0;
  const parts: Spark[] = [];
  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    w = rect.width;
    h = rect.height;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  const spawn = (burst: boolean) => {
    parts.push({
      x: Math.random() * w,
      y: burst ? h * (0.2 + Math.random() * 0.8) : h + 3,
      r: 0.9 + Math.random() * 1.1,
      vy: -(7 + Math.random() * 9),
      sway: (Math.random() - 0.5) * 10,
      phase: Math.random() * Math.PI * 2,
      life: burst ? Math.random() * 1.2 : 0,
      span: 2.4 + Math.random() * 2.4
    });
  };
  const tick = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const gain = 1;
    typing.energy *= Math.exp(-dt / 0.8);
    pulse *= Math.exp(-dt / 0.16);
    if (typing.strokes > 0) {
      typing.strokes = 0;
      if (gain > 0) pulse = 1;
    }
    const energy = typing.energy * gain;
    speed += (1 + energy * 6 - speed) * (1 - Math.exp(-dt / 0.15));
    due += dt;
    while (due > 0.14) {
      due -= 0.14;
      if (parts.length < 30) spawn(false);
    }
    ctx.clearRect(0, 0, w, h);
    const color = props.isDark !== false ? '#ffffff' : '#10b981';
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6 + energy * 10 + pulse * 6;
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      const p = parts[i];
      p.life += dt;
      if (p.life > p.span) {
        parts.splice(i, 1);
        continue;
      }
      const k = p.life / p.span;
      const twinkle = 0.7 + 0.3 * Math.sin((now / 160) * (1 + energy) + p.phase);
      p.y += p.vy * dt * speed;
      if (p.y < -4) {
        p.y = h + 3;
        p.x = Math.random() * w;
      }
      const edge = Math.min(1, Math.max(0, p.y / 14), Math.max(0, (h - p.y) / 14));
      ctx.globalAlpha = Math.min(1, Math.sin(k * Math.PI) * (0.9 + energy * 0.25) * twinkle) * edge;
      ctx.beginPath();
      ctx.arc(
        p.x + Math.sin((now / 900) * (1 + energy * 0.8) + p.phase) * p.sway,
        p.y,
        p.r * twinkle * (1 + energy * 0.35),
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
    raf = requestAnimationFrame(tick);
  };
  resize();
  for (let i = 0; i < 26; i += 1) spawn(true);
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  raf = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    ctx.clearRect(0, 0, w, h);
  };
};

const syncSpark = () => {
  stopSpark?.();
  stopSpark = null;
  if (!maxed.value || reduce.value) return;
  stopSpark = startSpark();
};
watch([maxed, reduce], syncSpark, { flush: 'post' });

onMounted(() => {
  document.addEventListener('mousedown', handleClickOutside);
  fetchTeams(1);
  fetchAgents(1);

  offSend = sendT.on('change', v => {
    sendPath.value?.setAttribute('d', pathAt(ARROW_UP, SQUARE, v));
    const goo = reduce.value ? 0 : Math.sin(v * Math.PI);
    const sx = 1 - 0.12 * goo;
    if (sendSvg.value) {
      sendSvg.value.style.transform = goo ? `rotate(${sendDir * 8 * goo}deg) scale(${sx}, ${1 / sx})` : '';
    }
  });

  adjustHeight();
  syncSpark();
});

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleClickOutside);
  dictation += 1;
  stopSpark?.();
  offSend?.();
  sendControls?.stop();
  if (attachedImagePreview.value) URL.revokeObjectURL(attachedImagePreview.value);
});

const onInput = (e: Event) => {
  inputText.value = (e.target as HTMLTextAreaElement).value;
  typing.energy = Math.min(1.6, typing.energy + 0.22);
  typing.strokes = Math.min(4, typing.strokes + 1);
};

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

  if (e.key === 'Backspace' && isPlanMode.value && !inputText.value) {
    e.preventDefault();
    isPlanMode.value = false;
    return;
  }

  if (e.key === 'Backspace' && localSelectedAgentId.value && !inputText.value) {
    e.preventDefault();
    clearSelectedAgent();
    return;
  }

  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    handleSend();
  }
};

const handleSend = () => {
  const text = inputText.value.trim();
  const image = attachedImage.value;
  if ((!text && !image) || props.isSending || props.reasoningEffortPending) return;

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
  if (attachedImagePreview.value) URL.revokeObjectURL(attachedImagePreview.value);
  attachedImage.value = null;
  attachedImagePreview.value = null;
  nextTick(adjustHeight);
};

const rootStyle = computed(
  () =>
    ({
      '--pb-bg': props.isDark !== false ? '#000000' : '#ffffff',
      '--pb-ink': props.isDark !== false ? '#f4f4f5' : '#18181b',
      '--pb-menu': props.isDark !== false ? '#0a0a0c' : '#ffffff',
      '--pb-radius': '18px',
      '--pb-spark': props.isDark !== false ? '#ffffff' : '#10b981',
      '--pb-press': 0.96
    }) as CSSProperties
);

defineExpose({
  focus: () => textareaRef.value?.focus(),
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
    <!-- Top Pills Row: Workspace Selector -->
    <div
      v-if="allowWorkspaceChange"
      class="mb-3 flex items-center justify-start gap-2 whitespace-nowrap transition-all"
      :class="isProjectDropdownOpen ? 'relative z-50' : 'relative z-0'"
    >
      <ProjectDropdown
        :workspaces="workspaces || []"
        :selectedWorkspaceId="selectedWorkspaceId"
        :isDark="isDark"
        @selectWorkspace="(ws) => emit('selectWorkspace', ws)"
        @newProject="emit('newProject')"
        @quickStart="emit('quickStart')"
        @openChange="(open) => isProjectDropdownOpen = open"
      />
    </div>

    <!-- 主输入框卡片（Dark 模式下集成 Vue Bits <BorderGlow /> 亮白流光边框） -->
    <BorderGlow
      :enabled="isDark !== false"
      :edge-sensitivity="28"
      glow-color="0 0 100"
      :background-color="isDark !== false ? '#000000' : '#ffffff'"
      :border-radius="18"
      :glow-radius="36"
      :glow-intensity="1.1"
      :cone-spread="28"
      :animated="false"
      :colors="['#ffffff', '#f8fafc', '#cbd5e1']"
      :fill-opacity="0.08"
      class-name="w-full transition-all"
      content-class="overflow-visible"
    >
      <div
        ref="commandContainerRef"
        class="group relative z-10 text-[14px] leading-[22px] [color:var(--pb-ink)] [border-radius:var(--pb-radius)] transition-all isolate before:-z-10 before:absolute before:inset-0 before:rounded-[inherit] before:content-[''] before:pointer-events-none before:[transition:opacity_500ms_ease] data-[max]:before:opacity-100 before:opacity-0 before:[background:radial-gradient(140%_120%_at_0%_100%,color-mix(in_srgb,var(--pb-spark)_26%,transparent),transparent_62%)] p-3 flex flex-col gap-2 bg-transparent border-0"
        :data-busy="isSending ? '' : undefined"
        :data-max="maxed ? '' : undefined"
        :style="rootStyle"
        @paste="handlePaste"
      >
      <!-- 背景飘浮微光粒子 Canvas -->
      <canvas
        ref="sparkRef"
        class="-z-10 absolute inset-0 rounded-[inherit] w-full h-full pointer-events-none"
        aria-hidden="true"
      />

      <!-- 快捷指令菜单 (/ 或 + 触发) -->
      <div
        v-if="isCommandMenuOpen && filteredCommands.length > 0"
        class="bottom-[calc(100%+8px)] z-40 absolute inset-x-0 shadow-[0_12px_40px_-10px_rgba(0,0,0,0.7),0_1px_2px_rgba(0,0,0,0.08)] p-1.5 [background:var(--pb-menu)] rounded-xl border border-white/[0.08] backdrop-blur-md [animation:prompt-bar-pop_180ms_cubic-bezier(0.23,1,0.32,1)_both]"
      >
        <div class="px-2.5 pt-1 pb-1.5 text-xs font-medium select-none" :class="MUTED">
          快捷指令
        </div>
        <div class="relative max-h-60 overflow-y-auto scrollbar-thin space-y-0.5">
          <span
            ref="commandGlowRef"
            class="absolute inset-x-0 opacity-0 [background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] rounded-lg pointer-events-none motion-reduce:[transition:opacity_150ms_ease] [transition:top_220ms_cubic-bezier(0.23,1,0.32,1),height_220ms_cubic-bezier(0.23,1,0.32,1),opacity_150ms_ease]"
            aria-hidden="true"
          />
          <button
            v-for="(cmd, idx) in filteredCommands"
            :key="cmd.id"
            :ref="el => (commandRowRefs[idx] = el as HTMLButtonElement | null)"
            type="button"
            class="z-[1] relative flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors text-xs select-none w-full text-left bg-transparent border-0 outline-none"
            @mouseenter="activeCommandIndex = idx"
            @click="selectCommand(cmd)"
          >
            <span class="font-medium shrink-0 min-w-18 [color:var(--pb-ink)]">
              {{ cmd.name }}
            </span>
            <span class="truncate" :class="MUTED">
              {{ cmd.desc }}
            </span>
          </button>
        </div>
      </div>

      <!-- Agent 选择菜单 (/agent 触发) -->
      <div
        v-if="isAgentMenuOpen"
        ref="agentMenuRef"
        class="bottom-[calc(100%+8px)] z-50 absolute inset-x-0 shadow-[0_16px_40px_rgba(0,0,0,0.7)] p-1.5 rounded-xl border backdrop-blur-md [background:color-mix(in_srgb,var(--pb-menu)_95%,transparent)] [animation:prompt-bar-pop_180ms_cubic-bezier(0.23,1,0.32,1)_both]"
        :class="isDark !== false ? 'border-white/[0.08] text-zinc-200' : 'border-zinc-200 text-gray-800'"
      >
        <div class="px-2.5 pt-1.5 pb-1.5 shrink-0 border-b border-black/5 dark:border-white/5">
          <input
            ref="agentSearchInputRef"
            v-model="agentSearchQuery"
            type="text"
            placeholder="搜索 Agent..."
            class="w-full px-1 py-0.5 text-xs bg-transparent border-none outline-none focus:outline-none focus:ring-0 select-text [color:var(--pb-ink)] placeholder:[color:color-mix(in_srgb,var(--pb-ink)_45%,transparent)]"
            @keydown.down.prevent="navigateAgent(1)"
            @keydown.up.prevent="navigateAgent(-1)"
            @keydown.enter.prevent="handleAgentEnter"
            @keydown.esc.prevent="closeAgentMenu"
          />
        </div>

        <div class="relative max-h-60 overflow-y-auto scrollbar-thin space-y-0.5 pt-1">
          <div
            v-if="filteredAgentList.length === 0"
            class="px-3 py-3 text-xs text-center"
            :class="MUTED"
          >
            无匹配的 Agent
          </div>

          <span
            ref="agentGlowRef"
            class="absolute inset-x-0 opacity-0 [background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] rounded-lg pointer-events-none motion-reduce:[transition:opacity_150ms_ease] [transition:top_220ms_cubic-bezier(0.23,1,0.32,1),height_220ms_cubic-bezier(0.23,1,0.32,1),opacity_150ms_ease]"
            aria-hidden="true"
          />

          <button
            v-for="(agent, idx) in filteredAgentList"
            :key="agent.id"
            :ref="el => (agentRowRefs[idx] = el as HTMLButtonElement | null)"
            type="button"
            class="z-[1] relative flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-xs cursor-pointer select-none w-full text-left bg-transparent border-0 outline-none"
            @mouseenter="activeAgentIndex = idx"
            @click="selectAgentItem(agent)"
          >
            <span class="font-medium truncate shrink-0 max-w-[45%] [color:var(--pb-ink)]">
              {{ agent.name }}
            </span>
            <div class="flex items-center gap-2 overflow-hidden justify-end flex-1 min-w-0">
              <span class="text-xs truncate text-right" :class="MUTED">
                {{ agent.description }}
              </span>
              <HugeiconsIcon
                v-if="String(agent.id) === String(selectedAgent)"
                :icon="Tick02Icon as IconArray"
                :size="14"
                :stroke-width="2.5"
                class="shrink-0 [color:var(--pb-ink)]"
              />
            </div>
          </button>
        </div>
      </div>

      <!-- Effort 思考强度调节弹层 -->
      <div
        v-if="effortOpen"
        class="bottom-[calc(100%+8px)] z-40 absolute left-2 sm:left-6 shadow-[0_12px_40px_-10px_rgba(0,0,0,0.7),0_1px_2px_rgba(0,0,0,0.08)] p-1 px-3.5 pt-3 pb-3.5 [background:var(--pb-menu)] rounded-xl w-[248px] origin-bottom-left border border-white/[0.08] backdrop-blur-md [animation:prompt-bar-pop_180ms_cubic-bezier(0.23,1,0.32,1)_both] motion-reduce:[animation:none]"
        role="dialog"
        aria-label="Effort"
      >
        <div class="flex items-center gap-2 text-[13px] leading-[18px]">
          <span :class="MUTED">思考强度</span>
          <span class="font-medium">{{ level }}</span>
          <span v-if="reasoningEffortPending" role="status" class="text-xs" :class="MUTED">同步中…</span>
          <span class="inline-flex ml-auto cursor-help" :class="MUTED" title="更高思考强度会在作答前深度思考更长时间">
            <HugeiconsIcon :icon="HelpCircleIcon as IconArray" :size="14" :stroke-width="1.8" />
          </span>
        </div>
        <div class="flex justify-between mt-3 text-[12px] leading-4" :class="MUTED">
          <span>Faster</span>
          <span>Smarter</span>
        </div>
        <div
          class="relative mt-2 [background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] rounded-[11px] outline-none h-[22px] touch-none cursor-pointer select-none"
          role="slider"
          tabindex="0"
          aria-label="Effort"
          :aria-valuemin="0"
          :aria-valuemax="effortList.length - 1"
          :aria-valuenow="effortIndex"
          :aria-valuetext="level"
          :style="effortStyle"
          @pointerdown="onEffortDown"
          @pointermove="onEffortMove"
          @keydown="onEffortKey"
        >
          <span
            class="left-0 absolute inset-y-0 [background:color-mix(in_srgb,var(--pb-ink)_18%,transparent)] [width:var(--pb-effort-fill)] group-data-[max]:[background:color-mix(in_srgb,var(--pb-spark)_35%,transparent)] rounded-[11px] motion-reduce:[transition:background-color_300ms_ease] [transition:width_220ms_cubic-bezier(0.23,1,0.32,1),background-color_300ms_ease]"
          />
          <i
            v-for="(name, i) in effortList"
            :key="name"
            class="top-1/2 absolute -mt-0.5 -ml-0.5 [background:color-mix(in_srgb,var(--pb-ink)_30%,transparent)] rounded-full w-1 h-1"
            :style="{ left: stepAt(i) }"
          />
          <span
            class="-top-[3px] absolute shadow-[0_2px_6px_rgba(0,0,0,0.25)] -ml-[7px] [background:var(--pb-ink)] [left:var(--pb-effort-x)] group-data-[max]:[background:var(--pb-spark)] rounded-[7px] w-3.5 h-7 motion-reduce:[transition:background-color_300ms_ease] [transition:left_220ms_cubic-bezier(0.23,1,0.32,1),background-color_300ms_ease]"
          />
        </div>
      </div>

      <p v-if="reasoningEffortError" role="alert" class="text-xs text-red-500">
        {{ reasoningEffortError }}
      </p>

      <!-- 图片与附件 Chips 栏 -->
      <div v-if="attachedImage" class="flex flex-wrap gap-1.5 pb-0.5">
        <span
          class="inline-flex items-center gap-1.5 pr-1.5 [background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] pl-2 rounded-lg h-[28px] text-[12px] motion-reduce:[animation:none] [animation:prompt-bar-pop_200ms_cubic-bezier(0.23,1,0.32,1)_both] border border-white/5"
        >
          <img
            v-if="attachedImagePreview"
            :src="attachedImagePreview"
            alt="Preview"
            class="w-4 h-4 rounded object-cover flex-none"
          />
          <HugeiconsIcon v-else :icon="File02Icon as IconArray" :size="12" :stroke-width="2" />
          <span class="max-w-[150px] truncate text-xs">{{ attachedImage.name || '图片附件' }}</span>
          <button
            type="button"
            class="inline-grid place-items-center bg-transparent opacity-60 hover:opacity-100 p-0 hover:[background:color-mix(in_srgb,var(--pb-ink)_10%,transparent)] border-0 rounded-[5px] outline-none w-[18px] h-[18px] text-inherit cursor-pointer [transition:opacity_120ms_ease,background-color_120ms_ease]"
            title="移除附件"
            @click.stop="removeAttachedImage"
          >
            <HugeiconsIcon :icon="Cancel01Icon as IconArray" :size="10" :stroke-width="2.5" />
          </button>
        </span>
      </div>

      <!-- 文本输入行 (支持 /plan 与 Agent Token Pill) -->
      <div class="flex items-start gap-1.5 w-full min-w-0">
        <span
          v-if="isPlanMode"
          class="text-amber-500 font-medium text-xs leading-[22px] shrink-0 select-none cursor-pointer hover:opacity-80 px-1.5 rounded bg-amber-500/10 whitespace-nowrap"
          title="点击退出 Plan 模式"
          @click.stop="isPlanMode = false"
        >
          /plan
        </span>

        <span
          v-if="currentAgentName"
          class="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-lg bg-blue-500/15 text-blue-400 select-none cursor-pointer hover:opacity-90 shrink-0 transition whitespace-nowrap leading-tight"
          title="点击切换 Agent，或点击 × 清除"
          @click.stop="openAgentMenu"
        >
          <span>🤖 {{ currentAgentName }}</span>
          <span
            class="hover:text-red-400 hover:bg-black/10 dark:hover:bg-white/10 rounded-full w-3.5 h-3.5 flex items-center justify-center text-xs leading-none transition"
            title="退出 Agent 直聊"
            @click.stop="clearSelectedAgent"
          >×</span>
        </span>

        <textarea
          ref="textareaRef"
          rows="1"
          :value="inputText"
          :placeholder="listening ? '正在倾听…' : (isPlanMode ? '描述你的任务以生成计划' : '描述你想要构建的内容，/ 调用指令，@ 文件或对话')"
          class="block bg-transparent p-0 placeholder:[color:color-mix(in_srgb,var(--pb-ink)_45%,transparent)] border-0 outline-none w-full text-[14px] text-inherit [@media(pointer:coarse)]:text-[16px] leading-[22px] resize-none [font:inherit] [overflow-wrap:anywhere]"
          aria-label="Prompt"
          @input="onInput"
          @focus="effortOpen = false"
          @keydown="handleKeyDown"
        />
      </div>

      <!-- 底部工具栏行 -->
      <div class="flex items-center justify-between pt-1 flex-nowrap gap-2 min-w-0">
        <!-- 左侧工具组：+ 按钮、图片附件、团队下拉、Effort 强度 -->
        <div class="flex items-center gap-1 flex-nowrap shrink min-w-0">
          <!-- + 按钮 -->
          <button
            type="button"
            :class="ICON_BTN"
            aria-label="快捷指令 (/)"
            :aria-expanded="isCommandMenuOpen"
            :data-on="isCommandMenuOpen ? '' : undefined"
            title="快捷指令 (/)"
            @mousedown.prevent
            @click="handlePlusClick"
          >
            <HugeiconsIcon :icon="PlusSignIcon as IconArray" :size="16" :stroke-width="2" />
          </button>

          <!-- 图片附件上传按钮与隐藏文件输入 -->
          <input
            ref="fileInputRef"
            type="file"
            accept="image/*"
            class="hidden"
            @change="handleFileChange"
          />
          <button
            type="button"
            :class="ICON_BTN"
            :data-on="attachedImage ? '' : undefined"
            title="上传图片 (可直接粘贴图片到输入框)"
            @mousedown.prevent
            @click="triggerUpload"
          >
            <HugeiconsIcon :icon="Attachment01Icon as IconArray" :size="15" :stroke-width="2" />
          </button>

          <!-- 团队选择下拉 -->
          <DropUpSelect
            ref="teamSelectRef"
            v-model="selectedTeam"
            :options="teamOptions"
            :isDark="isDark"
            size="sm"
            placeholder="指定团队"
            trigger-class="inline-flex h-7 flex-none cursor-pointer touch-manipulation items-center gap-1 rounded-lg border-0 bg-transparent px-2 text-[12px] font-medium outline-none select-none [color:color-mix(in_srgb,var(--pb-ink)_70%,transparent)] [font:inherit] [-webkit-tap-highlight-color:transparent] [transition:background-color_150ms_ease,color_150ms_ease] hover:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] hover:[color:var(--pb-ink)] whitespace-nowrap"
          />

          <!-- Effort 思考强度按钮 -->
          <button
            type="button"
            :class="TOOL_BTN"
            aria-label="选择思考强度"
            :aria-expanded="effortOpen"
            :data-on="effortOpen ? '' : undefined"
            :data-max="maxed ? '' : undefined"
            title="选择思考强度 (Effort)"
            @mousedown.prevent
            @click="toggleEffort"
          >
            <HugeiconsIcon :icon="SparklesIcon as IconArray" :size="13" :stroke-width="2" />
            <span>{{ level }}</span>
          </button>
        </div>

        <!-- 右侧工具组：上下文用量环、模型选择、语音听写、Morphing 发送按钮 -->
        <div class="flex items-center gap-1.5 shrink-0">
          <!-- 上下文用量指示器：仅悬浮于圆环图标时触发浮层 -->
          <div
            v-if="contextUsageText"
            class="relative inline-flex h-7 items-center justify-center select-none cursor-help mr-0.5"
            :class="MUTED"
            @mouseenter="isContextTooltipVisible = true"
            @mouseleave="isContextTooltipVisible = false"
          >
            <svg class="w-[18px] h-[18px] shrink-0 -rotate-90 -translate-y-[0.5px]" viewBox="0 0 16 16" aria-hidden="true">
              <!-- 未占用底轨：浅色模式为浅白灰，深色模式为深灰 -->
              <circle
                cx="8" cy="8" r="6" fill="none" stroke-width="2.3"
                class="stroke-zinc-200 dark:stroke-zinc-700/60"
              />
              <!-- 已占用进度：浅色模式为黑色，深色模式为白色 -->
              <circle
                cx="8" cy="8" r="6" fill="none" stroke-width="2.3" stroke-linecap="round"
                class="stroke-zinc-900 dark:stroke-zinc-100 transition-[stroke-dasharray] duration-500"
                :stroke-dasharray="contextRingDash"
              />
            </svg>
            <Transition
              enter-active-class="transition duration-150 ease-out"
              enter-from-class="opacity-0 translate-y-1"
              enter-to-class="opacity-100 translate-y-0"
              leave-active-class="transition duration-100 ease-in"
              leave-from-class="opacity-100 translate-y-0"
              leave-to-class="opacity-0 translate-y-1"
            >
              <div
                v-if="isContextTooltipVisible"
                class="pointer-events-none absolute bottom-full left-1/2 -translate-x-1/2 mb-2 whitespace-nowrap rounded-lg border px-2.5 py-1.5 shadow-xl z-50 [background:var(--pb-menu)] border-white/[0.08] backdrop-blur-md [color:var(--pb-ink)] text-xs"
              >
                {{ contextUsageText }}
              </div>
            </Transition>
          </div>

          <!-- 模型选择下拉 -->
          <DropUpSelect
            v-model="selectedModel"
            :options="modelOptions"
            :isDark="isDark"
            size="sm"
            placeholder="选择模型"
            trigger-class="inline-flex h-7 flex-none cursor-pointer touch-manipulation items-center gap-1 rounded-lg border-0 bg-transparent px-2 text-[12px] font-medium outline-none select-none [color:color-mix(in_srgb,var(--pb-ink)_70%,transparent)] [font:inherit] [-webkit-tap-highlight-color:transparent] [transition:background-color_150ms_ease,color_150ms_ease] hover:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] hover:[color:var(--pb-ink)] whitespace-nowrap"
          />

          <!-- 语音录入 (Mic) 按钮 -->
          <button
            v-if="hasDictate"
            type="button"
            :class="ICON_BTN"
            :aria-label="listening ? '停止录音' : '语音输入'"
            :aria-pressed="listening"
            :data-on="listening ? '' : undefined"
            title="语音输入"
            @mousedown.prevent
            @click="toggleListen"
          >
            <span
              v-if="listening"
              class="[&>i]:block flex items-center gap-[2.5px] [&>i]:bg-current [&>i]:rounded-full [&>i]:w-[2.5px] h-3.5 [&>i]:h-full [&>i]:origin-center [&>i]:[animation:prompt-bar-eq_900ms_ease-in-out_infinite] [&>i:nth-child(2)]:[animation-delay:150ms] [&>i:nth-child(3)]:[animation-delay:300ms]"
              aria-hidden="true"
            >
              <i />
              <i />
              <i />
            </span>
            <HugeiconsIcon v-else :icon="Mic01Icon as IconArray" :size="15" :stroke-width="2" />
          </button>

          <!-- PromptBar 经典 Morphing 发送 / 停止按钮 -->
          <button
            type="button"
            class="inline-grid relative flex-none place-items-center p-0 [background:color-mix(in_srgb,var(--pb-ink)_12%,var(--pb-bg))] [color:color-mix(in_srgb,var(--pb-ink)_55%,var(--pb-bg))] data-[armed]:[background:var(--pb-ink)] data-[armed]:[color:var(--pb-bg)] data-[pressed]:[transform:scale(var(--pb-press))] border-0 rounded-lg outline-none w-7 h-7 touch-manipulation cursor-pointer disabled:cursor-default select-none motion-reduce:data-[pressed]:[transform:none] [font:inherit] [-webkit-tap-highlight-color:transparent] [transition:background-color_200ms_ease,color_200ms_ease,transform_160ms_cubic-bezier(0.23,1,0.32,1)]"
            :disabled="!armed"
            :aria-label="isSending ? '停止' : '发送'"
            :data-armed="armed ? '' : undefined"
            :data-pressed="pressed ? '' : undefined"
            title="发送消息 (Enter)"
            @mousedown.prevent
            @pointerdown="down"
            @pointerup="up"
            @pointercancel="up"
            @pointerleave="up"
            @click="onSendClick"
          >
            <svg
              ref="sendSvg"
              class="block w-4 h-4 origin-center"
              viewBox="0 0 24 24"
              aria-hidden="true"
              fill="currentColor"
              stroke="currentColor"
              stroke-width="2"
              stroke-linejoin="round"
            >
              <path ref="sendPath" :d="sendStart" />
            </svg>
          </button>
        </div>
      </div>
    </div>
    </BorderGlow>
  </div>
</template>

<style>
@keyframes prompt-bar-pop {
  from {
    opacity: 0;
    transform: translateY(4px) scale(0.98);
  }
}
@keyframes prompt-bar-eq {
  0%,
  100% {
    transform: scaleY(0.35);
  }
  50% {
    transform: scaleY(1);
  }
}
</style>
