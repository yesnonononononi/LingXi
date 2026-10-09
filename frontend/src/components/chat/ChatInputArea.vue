<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onBeforeUnmount, type CSSProperties } from 'vue';
import {
  Attachment01Icon,
  Cancel01Icon,
  HelpCircleIcon,
  Mic01Icon,
  PlusSignIcon,
  SparklesIcon,
  Tick02Icon
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon, type IconArray } from '@hugeicons/vue';
import { useEditor, EditorContent } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { Markdown } from 'tiptap-markdown';
import DropUpSelect from '../common/DropUpSelect.vue';
import BorderGlow from '../common/BorderGlow.vue';
import SparkTrail from '../common/SparkTrail.vue';
import MorphingSendIcon from '../common/MorphingSendIcon.vue';
import ProjectDropdown from './ProjectDropdown.vue';
import type { SelectOption } from '../../types/ui';
import type { ChatMode, ModelConfig, WorkspaceVO, AgentAccessMode, TeamVO, AgentVO, ReasoningEffort } from '../../types/chat';
import { reasoningEffortOptions } from '../../composables/useReasoningEffort';
import { TeamAPI } from '../../services/team';
import { AgentAPI } from '../../services/agent';
import { isOk } from '../../utils/api';
import { useChatImageAttachments } from '../../composables/useChatImageAttachments';

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
  (e: 'sendMessage', text: string, requirePlan: boolean, teamId?: string | number | null, agentId?: string | number | null, imageFiles?: File[]): void;
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

// PromptBar 样式常量
/** 拖拽缩放手柄的命中区边距（px）。 */
const EDGE = 11;
const MUTED = '[color:color-mix(in_srgb,var(--pb-ink)_55%,transparent)]';

const resolveEditorMarkdown = (ed: unknown): string => {
  const target = ed as { storage?: { markdown?: { getMarkdown?: () => string } }; getText?: () => string } | null | undefined;
  return target?.storage?.markdown?.getMarkdown?.() ?? target?.getText?.() ?? '';
};
const TOOL_BTN =
  'inline-flex h-7 flex-none cursor-pointer touch-manipulation items-center gap-1 rounded-lg border-0 bg-transparent px-2 text-[12px] font-medium outline-none select-none [color:color-mix(in_srgb,var(--pb-ink)_70%,transparent)] [font:inherit] [-webkit-tap-highlight-color:transparent] [transition:background-color_150ms_ease,color_150ms_ease] data-[on]:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] data-[on]:[color:var(--pb-ink)] [@media(hover:hover)_and_(pointer:fine)]:hover:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] [@media(hover:hover)_and_(pointer:fine)]:hover:[color:var(--pb-ink)] data-[max]:[color:var(--pb-spark)]!';
const ICON_BTN =
  'inline-grid h-7 w-7 flex-none cursor-pointer touch-manipulation place-items-center rounded-lg border-0 bg-transparent p-0 outline-none select-none [color:color-mix(in_srgb,var(--pb-ink)_60%,transparent)] [font:inherit] [-webkit-tap-highlight-color:transparent] [transition:background-color_150ms_ease,color_150ms_ease,transform_160ms_cubic-bezier(0.23,1,0.32,1)] active:[transform:scale(0.94)] data-[on]:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] data-[on]:[color:var(--pb-ink)] motion-reduce:active:[transform:none] [@media(hover:hover)_and_(pointer:fine)]:hover:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] [@media(hover:hover)_and_(pointer:fine)]:hover:[color:var(--pb-ink)]';

const commandContainerRef = ref<HTMLDivElement | null>(null);
const editorContainerRef = ref<HTMLDivElement | null>(null);
const sparkRef = ref<InstanceType<typeof SparkTrail> | null>(null);

const inputText = ref('');
const isPlanMode = ref(false);
let inputDisposed = false;

const focusEditor = () => {
  // 附件选择后的聚焦会排队，卸载后不能再触碰已销毁的编辑器。
  nextTick(() => { if (!inputDisposed) editor.value?.commands.focus('end'); });
};

// ====== 语音听写 (Mic) 基础状态 ======
let dictation = 0;
const listening = ref(false);

// 附件管理
const { attachments, maxImages, limitsLoading, limitsError, attachmentError, canAttach,
  loadLimits, addImages, removeImage, clearImages } = useChatImageAttachments();
const fileInputRef = ref<HTMLInputElement | null>(null);

const processImageFiles = (files: File[]) => {
  addImages(files);
  focusEditor();
};

const editor = useEditor({
  extensions: [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      codeBlock: false
    }),
    Placeholder.configure({
      placeholder: () => {
        if (listening.value) return '正在倾听…';
        if (isPlanMode.value) return '描述你的任务以生成计划';
        return '描述你想要构建的内容，/ 调用指令，@ 文件或对话';
      }
    }),
    Markdown.configure({
      html: false,
      tightLists: true,
      bulletListMarker: '-',
      linkify: false,
      breaks: true,
      transformPastedText: true,
      transformCopiedText: true
    })
  ],
  onUpdate: ({ editor: ed }) => {
    sparkRef.value?.ping();
    const rawText = ed.getText();
    const mdText = resolveEditorMarkdown(ed);
    inputText.value = mdText;

    if (rawText.startsWith('/plan ') || rawText === '/plan') {
      isPlanMode.value = true;
      ed.commands.setContent(rawText.replace(/^\/plan\s*/, ''));
      isCommandMenuOpen.value = false;
      isCommandMenuClickedOpen.value = false;
      return;
    }
    if (rawText.startsWith('/permission ') || rawText === '/permission') {
      ed.commands.clearContent();
      isCommandMenuOpen.value = false;
      isCommandMenuClickedOpen.value = false;
      emit('openSettings');
      return;
    }
    if (rawText === '/agent' || rawText.startsWith('/agent ') || rawText === '/agent\n') {
      ed.commands.setContent(rawText.replace(/^\/agent\s*/, ''));
      isCommandMenuOpen.value = false;
      isCommandMenuClickedOpen.value = false;
      openAgentMenu();
      return;
    }
    if (rawText.startsWith('/mcp ') || rawText === '/mcp') {
      ed.commands.clearContent();
      isCommandMenuOpen.value = false;
      isCommandMenuClickedOpen.value = false;
      emit('openSettingsTab', 'mcp');
      return;
    }
    if (rawText.startsWith('/')) {
      if (!isAgentMenuOpen.value) {
        isCommandMenuOpen.value = true;
        activeCommandIndex.value = 0;
      }
    } else if (!isCommandMenuClickedOpen.value) {
      isCommandMenuOpen.value = false;
    }
  }
});

const handlePaste = (e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (!items || items.length === 0) return;
  const files = Array.from(items).filter(item => item.type.startsWith('image/'))
    .map(item => item.getAsFile()).filter((file): file is File => file !== null);
  if (files.length > 0) {
    e.preventDefault();
    processImageFiles(files);
  }
};

const handleFileChange = (e: Event) => {
  const target = e.target as HTMLInputElement;
  processImageFiles(Array.from(target.files ?? []));
  target.value = '';
};

const triggerUpload = () => {
  if (canAttach.value) fileInputRef.value?.click();
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
    focusEditor();
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
  focusEditor();
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
      editor.value?.commands.clearContent();
      inputText.value = '';
      focusEditor();
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
  const text = editor.value ? editor.value.getText() : '';
  if (text.startsWith('/')) {
    editor.value?.commands.clearContent();
    inputText.value = '';
  }
  isCommandMenuOpen.value = false;
  isCommandMenuClickedOpen.value = false;
  cmd.action();
  nextTick(() => {
    if (!isAgentMenuOpen.value) {
      focusEditor();
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
  } else if (agentMenuRef.value && !agentMenuRef.value.contains(target) && editorContainerRef.value?.contains(target)) {
    isAgentMenuOpen.value = false;
  }
};

// ====== 语音听写 (Mic) 支撑 ======
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
        editor.value?.commands.insertContent(text);
      }
      listening.value = false;
      focusEditor();
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

// ====== Send 按钮 ======
const canSend = computed(() => {
  if (props.reasoningEffortPending) return false;
  if (attachments.value.length > 0) return true;
  const text = editor.value ? editor.value.getText().trim() : inputText.value.trim();
  return text.length > 0;
});
const armed = computed(() => !!props.isSending || canSend.value);
const pressed = ref(false);

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

onMounted(() => {
  void loadLimits();
  document.addEventListener('mousedown', handleClickOutside);
  fetchTeams(1);
  fetchAgents(1);
});

onBeforeUnmount(() => {
  inputDisposed = true;
  document.removeEventListener('mousedown', handleClickOutside);
  dictation += 1;
  clearImages();
  editor.value?.destroy();
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

  const isEmpty = editor.value ? editor.value.isEmpty : !inputText.value;

  if (e.key === 'Backspace' && isPlanMode.value && isEmpty) {
    e.preventDefault();
    isPlanMode.value = false;
    return;
  }

  if (e.key === 'Backspace' && localSelectedAgentId.value && isEmpty) {
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
  const mdText = resolveEditorMarkdown(editor.value).trim();
  const rawText = editor.value ? editor.value.getText().trim() : '';
  const text = mdText || rawText;
  const images = attachments.value.map(attachment => attachment.file);
  if ((!text && images.length === 0) || props.isSending || props.reasoningEffortPending) return;

  const effectiveText = text || '请分析并描述这些图片';

  emit(
    'sendMessage',
    effectiveText,
    isPlanMode.value,
    localSelectedTeamId.value ? localSelectedTeamId.value : null,
    localSelectedAgentId.value ? localSelectedAgentId.value : null,
    images
  );

  editor.value?.commands.clearContent();
  inputText.value = '';
  clearImages();
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
  focus: focusEditor,
  focusInput: focusEditor,
  setInputText: (text: string) => {
    editor.value?.commands.setContent(text);
    inputText.value = text;
  },
  setAttachedImage: (file: File | null) => {
    if (file) processImageFiles([file]);
    else clearImages();
  },
  setAttachedImages: processImageFiles,
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
      <!-- 背景飘浮微光粒子（思考强度拉满时点亮；打字时由 onInput 提亮） -->
      <SparkTrail
        ref="sparkRef"
        :active="maxed"
        :ink="isDark === false ? '#10b981' : '#ffffff'"
        class="-z-10 absolute inset-0 rounded-[inherit]"
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
      <div v-if="attachments.length" class="flex flex-wrap gap-1.5 pb-0.5" data-testid="image-attachments">
        <span
          v-for="(attachment, index) in attachments"
          :key="attachment.preview"
          class="inline-flex items-center gap-1.5 pr-1.5 [background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] pl-2 rounded-lg h-[28px] text-[12px] motion-reduce:[animation:none] [animation:prompt-bar-pop_200ms_cubic-bezier(0.23,1,0.32,1)_both] border border-white/5"
        >
          <img
            :src="attachment.preview"
            :alt="attachment.file.name"
            class="w-4 h-4 rounded object-cover flex-none"
          />
          <span class="max-w-[150px] truncate text-xs">{{ attachment.file.name || '图片附件' }}</span>
          <button
            type="button"
            class="inline-grid place-items-center bg-transparent opacity-60 hover:opacity-100 p-0 hover:[background:color-mix(in_srgb,var(--pb-ink)_10%,transparent)] border-0 rounded-[5px] outline-none w-[18px] h-[18px] text-inherit cursor-pointer [transition:opacity_120ms_ease,background-color_120ms_ease]"
            title="移除附件"
            :aria-label="`移除 ${attachment.file.name}`"
            @click.stop="removeImage(index)"
          >
            <HugeiconsIcon :icon="Cancel01Icon as IconArray" :size="10" :stroke-width="2.5" />
          </button>
        </span>
      </div>
      <div class="text-xs text-gray-500 dark:text-zinc-400" aria-live="polite">
        <span v-if="limitsLoading">正在读取图片数量限制…</span>
        <span v-else-if="limitsError" class="text-red-500">{{ limitsError }}
          <button type="button" class="ml-2 underline" @click="loadLimits">重试</button>
        </span>
        <span v-else-if="attachments.length">已选择 {{ attachments.length }} / {{ maxImages }} 张图片</span>
        <p v-if="attachmentError" class="text-red-500" role="alert">{{ attachmentError }}</p>
      </div>

      <!-- 文本输入区 (支持 /plan 与 Agent Token Pill 以及 TipTap 所见即所得 Markdown 渲染) -->
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

        <!-- TipTap 所见即所得 Markdown 富文本输入框 -->
        <div ref="editorContainerRef" class="relative w-full min-w-0 flex-1">
          <EditorContent
            :editor="editor"
            class="tiptap-chat-input w-full text-[14px] leading-[22px] [color:var(--pb-ink)] [caret-color:var(--pb-ink)] cursor-text select-text"
            @focus="effortOpen = false"
            @keydown="handleKeyDown"
          />
        </div>
      </div>

      <!-- 底部工具栏行 -->
      <div class="flex items-center justify-between pt-1 flex-nowrap gap-2 min-w-0">
        <!-- 左侧工具组：+ 按钮、图片附件、团队下拉、Effort 强度、预览按钮 -->
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
            multiple
            class="hidden"
            @change="handleFileChange"
          />
          <button
            type="button"
            :class="ICON_BTN"
            :data-on="attachments.length ? '' : undefined"
            :disabled="!canAttach"
            :title="maxImages ? `上传图片（每条消息最多 ${maxImages} 张，支持多选和粘贴）` : '正在读取图片数量限制'"
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
            <MorphingSendIcon :is-sending="!!isSending" class="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
    </BorderGlow>
  </div>
</template>

<style>
/* TipTap 所见即所得 Markdown 样式渲染 */
.tiptap-chat-input .tiptap.ProseMirror {
  outline: none;
  min-height: 22px;
  max-height: 120px;
  overflow-y: auto;
  word-break: break-word;
  white-space: pre-wrap;
  font-family: inherit;
  font-size: 14px;
  line-height: 22px;
}
.tiptap-chat-input .tiptap.ProseMirror p {
  margin: 0;
  line-height: 22px;
}
.tiptap-chat-input .tiptap.ProseMirror code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size: 0.85em;
  padding: 0.15rem 0.35rem;
  margin: 0 0.15rem;
  border-radius: 0.35rem;
  background-color: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: #f4f4f5;
}
html.light .tiptap-chat-input .tiptap.ProseMirror code {
  background-color: #f1f5f9;
  border-color: #e2e8f0;
  color: #1e293b;
}
.tiptap-chat-input .tiptap.ProseMirror strong {
  font-weight: 600;
}
.tiptap-chat-input .tiptap.ProseMirror em {
  font-style: italic;
}
.tiptap-chat-input .tiptap.ProseMirror s {
  text-decoration: line-through;
}
.tiptap-chat-input .tiptap.ProseMirror h1,
.tiptap-chat-input .tiptap.ProseMirror h2,
.tiptap-chat-input .tiptap.ProseMirror h3 {
  margin: 0.2rem 0;
  font-weight: 600;
  line-height: 1.35;
}
.tiptap-chat-input .tiptap.ProseMirror h1 { font-size: 1.25rem; }
.tiptap-chat-input .tiptap.ProseMirror h2 { font-size: 1.1rem; }
.tiptap-chat-input .tiptap.ProseMirror h3 { font-size: 1.0rem; }
.tiptap-chat-input .tiptap.ProseMirror blockquote {
  margin: 0.25rem 0;
  padding-left: 0.5rem;
  border-left: 2px solid rgba(255, 255, 255, 0.3);
  opacity: 0.85;
}
html.light .tiptap-chat-input .tiptap.ProseMirror blockquote {
  border-left-color: rgba(0, 0, 0, 0.3);
}

/* TipTap 占位符提示 */
.tiptap-chat-input .tiptap.ProseMirror p.is-editor-empty:first-child::before {
  color: color-mix(in srgb, var(--pb-ink) 45%, transparent);
  content: attr(data-placeholder);
  float: left;
  height: 0;
  pointer-events: none;
}

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
