<script setup lang="ts">
import { ref, watch, nextTick, computed, onMounted, onBeforeUnmount, inject, type CSSProperties } from 'vue';
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
import DropUpSelect from '../common/DropUpSelect.vue';
import BorderGlow from '../common/BorderGlow.vue';
import SparkTrail from '../common/SparkTrail.vue';
import ProjectDropdown from './ProjectDropdown.vue';
import type { SelectOption } from '../../types/ui';
import type { ChatMode, ModelConfig, WorkspaceVO, AgentAccessMode, TeamVO, AgentVO, ReasoningEffort } from '../../types/chat';
import { reasoningEffortOptions } from '../../composables/useReasoningEffort';
import { TeamAPI } from '../../services/team';
import { AgentAPI } from '../../services/agent';
import { isOk } from '../../utils/api';
import { useChatImageAttachments } from '../../composables/useChatImageAttachments';
import { useSkillMenu } from '../../composables/useSkillMenu';
import { isPromptOptimizationCommand, usePromptOptimization } from '../../composables/usePromptOptimization';
import { useConfirm } from '../../composables/useConfirm';
import { isImageAvatar } from '../../utils/avatar';
import { t } from '../../i18n';
import { CHAT_INPUT_SLOTS_KEY } from '../../types/chatInputSlots';
import type {
  ChatInputContextUsageSlotProps,
  ChatInputModelSelectorSlotProps,
  ChatInputSendButtonSlotProps,
} from '../../types/chatInputSlots';
import ChatInputContextUsage from './ChatInputContextUsage.vue';
import ChatInputModelSelector from './ChatInputModelSelector.vue';
import ChatInputSendButton from './ChatInputSendButton.vue';
import { MUTED, TOOL_BTN, ICON_BTN } from '../../utils/promptBarStyles';

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
    /** 产生该事件的压缩档位：MANUAL=本地截断（毫秒级），SUMMARY=模型深度压缩 */
    band?: string;
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

defineSlots<{
  /** 上下文用量指示器。出现时机（有无数据）由组件裁决，本插槽只替换环+浮层本身。 */
  contextUsage(props: ChatInputContextUsageSlotProps): unknown;
  /** 模型选择器（含「驱动徽标」与「权威下拉」两个状态，二选一由组件决定）。 */
  modelSelector(props: ChatInputModelSelectorSlotProps): unknown;
  /** 发送/停止按钮（二态共用 onSend 一个入口）。 */
  sendButton(props: ChatInputSendButtonSlotProps): unknown;
}>();

// PromptBar 样式常量已抽到 utils/promptBarStyles.ts（供留在本组件的按钮与默认实现组件共用）
/** 拖拽缩放手柄的命中区边距（px）。 */
const EDGE = 11;

const commandContainerRef = ref<HTMLDivElement | null>(null);
const inputContainerRef = ref<HTMLDivElement | null>(null);
const sparkRef = ref<InstanceType<typeof SparkTrail> | null>(null);

const inputText = ref('');
let optimizedDraft: string | null = null;
const inputRef = ref<HTMLTextAreaElement | null>(null);
const inputPlaceholder = computed(() => {
  if (listening.value) return t('chat.input.placeholderListening');
  if (isPlanMode.value) return t('chat.input.placeholderPlan');
  return t('chat.input.placeholderDefault');
});
const isPlanMode = ref(false);
let inputDisposed = false;

const focusInput = () => {
  // 附件选择后的聚焦会排队，卸载后不能再访问输入框。
  nextTick(() => {
    if (inputDisposed || !inputRef.value) return;
    inputRef.value.focus();
    inputRef.value.setSelectionRange(inputText.value.length, inputText.value.length);
  });
};

const promptOptimization = usePromptOptimization(inputText, () => props.selectedModelId, focusInput, text => {
  optimizedDraft = text;
  inputText.value = text;
});
const { state: confirmationState } = useConfirm();

// ====== 语音听写 (Mic) 基础状态 ======
let dictation = 0;
const listening = ref(false);

// 附件管理
const { attachments, maxImages, limitsLoading, limitsError, attachmentError, canAttach,
  loadLimits, addImages, removeImage, clearImages } = useChatImageAttachments();
const fileInputRef = ref<HTMLInputElement | null>(null);

const processImageFiles = (files: File[]) => {
  addImages(files);
  focusInput();
};

watch(inputText, (rawText) => {
  sparkRef.value?.ping();

  // 模型返回的草稿按原文回填，不能触发其中看起来像斜杠命令的文本。
  const isOptimizedDraft = rawText === optimizedDraft;
  optimizedDraft = null;
  if (isOptimizedDraft) {
    isCommandMenuOpen.value = false;
    isCommandMenuClickedOpen.value = false;
    return;
  }

  if (rawText.startsWith('/plan ') || rawText === '/plan') {
    isPlanMode.value = true;
    inputText.value = rawText.replace(/^\/plan\s*/, '');
    isCommandMenuOpen.value = false;
    isCommandMenuClickedOpen.value = false;
    return;
  }
  if (rawText.startsWith('/permission ') || rawText === '/permission') {
    inputText.value = '';
    isCommandMenuOpen.value = false;
    isCommandMenuClickedOpen.value = false;
    emit('openSettings');
    return;
  }
  if (rawText === '/agent' || rawText.startsWith('/agent ') || rawText === '/agent\n') {
    inputText.value = rawText.replace(/^\/agent\s*/, '');
    isCommandMenuOpen.value = false;
    isCommandMenuClickedOpen.value = false;
    openAgentMenu();
    return;
  }
  if (rawText.startsWith('/mcp ') || rawText === '/mcp') {
    inputText.value = '';
    isCommandMenuOpen.value = false;
    isCommandMenuClickedOpen.value = false;
    emit('openSettingsTab', 'mcp');
    return;
  }
  if (rawText === '/skill' || rawText.startsWith('/skill ') || rawText === '/skill\n') {
    inputText.value = '';
    isCommandMenuOpen.value = false;
    isCommandMenuClickedOpen.value = false;
    openSkillMenu();
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
});

watch(inputText, () => {
  const input = inputRef.value;
  if (!input) return;
  // 清空和回填也要重算高度，避免沿用上一条长消息的尺寸。
  input.style.height = '22px';
  input.style.height = `${Math.min(120, Math.max(22, input.scrollHeight))}px`;
}, { flush: 'post' });

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
    focusInput();
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
  skillMenu.close();
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
  avatar?: string;
}

const allAgentsList = computed<AgentItem[]>(() => {
  const list = props.agents && props.agents.length > 0 ? props.agents : localAgents.value;
  return [
        { id: '', name: t('chat.input.defaultAgentName'), description: t('chat.input.defaultAgentDesc') },
    ...list.map(a => ({
      id: a.id,
      name: a.name || `Agent #${a.id}`,
      description: a.description || (a.modelId ? t('session.modelFallback', { id: a.modelId }) : ''),
      modelId: a.modelId,
      avatar: a.avatar
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
  skillMenu.close();
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
  focusInput();
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

// ====== /skill 触发的本地 Skill 清单浮层（点击清单项把「使用{skill}完成工作」填进输入框） ======
const skillMenu = useSkillMenu();
const isSkillMenuOpen = skillMenu.isOpen;
const skillSearchInputRef = ref<HTMLInputElement | null>(null);

const openSkillMenu = () => {
  isCommandMenuOpen.value = false;
  isCommandMenuClickedOpen.value = false;
  isAgentMenuOpen.value = false;
  effortOpen.value = false;
  skillMenu.open();
  nextTick(() => {
    skillSearchInputRef.value?.focus();
  });
};

const closeSkillMenu = () => {
  if (!isSkillMenuOpen.value) return;
  skillMenu.close();
  focusInput();
};

/**
 * 点击清单项：把「使用{skill}完成工作」填进输入框。
 *
 * <p>输入框已有内容时**追加**而非覆盖——用户可能正打到一半，替写掉就是毁数据；
 * 空白输入才整句填入。填完收起浮层并把焦点还回输入框，让用户直接改后半句或发送。</p>
 */
const selectSkill = (skill: { name: string }) => {
  const sentence = t('chat.input.skillFillTemplate', { name: skill.name });
  const existing = inputText.value.trim();
  inputText.value = existing ? `${existing} ${sentence}` : sentence;
  skillMenu.close();
  focusInput();
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
    { label: t('chat.input.teamUnspecified'), value: '' },
    ...list.map(team => ({
      label: team.name || t('chat.input.teamFallback', { id: team.id }),
      value: team.id,
      avatar: team.avatar,
    })),
    { label: t('chat.input.addTeam'), value: ADD_TEAM_OPTION }
  ];
});

// 基座模型的下拉选项与选中值已随模型选择器搬进 `ChatInputModelSelector.vue`
// （连同 `+ 添加自定义模型` 的哨兵值路由：哨兵 → onOpenModelEditor，其余 → onUpdateModel）。

/**
 * 本轮实际生效的模型（Agent/团队预设驱动时）。
 *
 * <p>输入栏的模型选择器只映 {@code user_configs.model_id}，与 Agent/指挥者预设无关；而
 * Agent 选中或会话绑团队时，本轮模型由预设决定、显式 modelId 不参与（后端
 * {@code RequestPreparer#effectiveCommand}）。这个错位在界面上原本完全看不出来 ——
 * 「选了 deepseek-flash 却用 claude」只能靠事后翻轮次记录才能发现，所以这里把实际生效模型
 * 与来源显式呈现；点击可直接跳到「智能体」设置改预设。</p>
 *
 * <p>返回 null 表示没有 Agent/团队在驱动，此时选择器就是权威，照常显示下拉框。</p>
 */
const drivenModel = computed<{ text: string; tip: string; missing: boolean } | null>(() => {
  const modelNameOf = (modelId: string | number | null | undefined): string => {
    if (modelId == null || modelId === '') return '';
    const found = (props.models ?? []).find(m => String(m.id) === String(modelId));
    return found?.name || found?.modelName || t('session.modelFallback', { id: modelId });
  };
  const describe = (agentName: string, presetModelId: string | number | null | undefined, source: string) => {
    const unbound = presetModelId == null || presetModelId === '';
    return {
      text: unbound ? t('chat.input.modelDrivenUnbound', { name: agentName }) : `${modelNameOf(presetModelId)} · ${source}`,
      tip: t('chat.input.modelDrivenTip', { name: agentName, source }),
      missing: unbound,
    };
  };

  // 1) 会话绑定的团队：后端强制指挥者预设（成员子执行各用各的预设，不在此展示）
  const teamList = props.teams && props.teams.length > 0 ? props.teams : localTeams.value;
  const team = teamList.find(item => String(item.id) === String(props.selectedTeamId ?? ''));
  if (team && String(props.selectedTeamId ?? '') !== '') {
    const commander = (team.agents ?? []).find(a => String(a.id) === String(team.commanderAgentId));
    const commanderName = commander?.name || t('chat.input.commanderFallback');
    return describe(commanderName, commander?.modelId, t('chat.input.modelSourceCommander'));
  }

  // 2) 显式选中的单 Agent：用它自己的预设
  const agentId = props.selectedAgentId;
  if (agentId != null && agentId !== '') {
    const agentList = props.agents && props.agents.length > 0 ? props.agents : localAgents.value;
    const agent = agentList.find(a => String(a.id) === String(agentId));
    const agentName = agent?.name || t('chat.input.modelAgentFallback');
    return describe(agentName, agent?.modelId, t('chat.input.modelSourceAgent'));
  }
  return null;
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
  // 「压缩中」只由 SUMMARY（模型深度压缩）档位点亮；PRUNE 是毫秒级本地剪枝（无模型调用），每个
  // checkpoint 都会跑一对 SQUEEZE 事件，照旧渲染会让指示器反复跳变。旧数据不带档位时保持原行为。
  const compressing = usage?.phase === 'SQUEEZE_STARTED' && usage?.band !== 'PRUNE';
  const label = compressing ? t('chat.input.contextCompressing') : t('chat.input.contextUsed');
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

// 上下文浮层的悬停状态**没有**随浮层搬进 `ChatInputContextUsage.vue`：触发区是外层容器
// （28px 高）的交互属性，容器归组件所有；渲染器只按 `tooltipVisible` 决定画不画。
// 曾经把它挪进 svg，结果触发区缩到 18×18 —— 已由契约测试用例 7 锁死，别再搬。



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
    desc: t('chat.command.plan'),
    action: () => {
      isPlanMode.value = true;
      inputText.value = '';
      focusInput();
    }
  },
  {
    id: 'model',
    name: 'model',
    desc: t('chat.command.model'),
    action: () => {
      emit('openModelEditor');
    }
  },
  {
    id: 'workspace',
    name: 'workspace',
    desc: t('chat.command.workspace'),
    action: () => {
      emit('newProject');
    }
  },
  {
    id: 'export',
    name: 'export',
    desc: t('chat.command.export'),
    action: () => {
      emit('exportSession');
    }
  },
  {
    id: 'team',
    name: 'team',
    desc: t('chat.command.team'),
    action: () => {
      teamSelectRef.value?.open();
    }
  },
  {
    id: 'add-team',
    name: 'add-team',
    desc: t('chat.command.addTeam'),
    action: () => {
      emit('openTeamModal');
    }
  },
  {
    id: 'agent',
    name: 'agent',
    desc: t('chat.command.agent'),
    action: () => {
      openAgentMenu();
    }
  },
  {
    id: 'permission',
    name: 'permission',
    desc: t('chat.command.permission'),
    action: () => {
      emit('openSettings');
    }
  },
  {
    id: 'mcp',
    name: 'mcp',
    desc: t('chat.command.mcp'),
    action: () => {
      emit('openSettingsTab', 'mcp');
    }
  },
  {
    id: 'skill',
    name: 'skill',
    desc: t('chat.command.skill'),
    action: () => {
      openSkillMenu();
    }
  },
  {
    id: 'optimize-prompt',
    name: 'optimize-prompt',
    desc: t('chat.command.optimizePrompt'),
    action: () => { void promptOptimization.optimize(); }
  },
  {
    id: 'settings',
    name: 'settings',
    desc: t('chat.command.settings'),
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
  skillMenu.close();
  isCommandMenuOpen.value = !isCommandMenuOpen.value;
  if (isCommandMenuOpen.value) {
    isCommandMenuClickedOpen.value = true;
    activeCommandIndex.value = 0;
  } else {
    isCommandMenuClickedOpen.value = false;
  }
};

const selectCommand = (cmd: CommandItem) => {
  const text = inputText.value;
  if (text.startsWith('/') && (cmd.id !== 'optimize-prompt' || !isPromptOptimizationCommand(text))) {
    inputText.value = '';
  }
  isCommandMenuOpen.value = false;
  isCommandMenuClickedOpen.value = false;
  cmd.action();
  nextTick(() => {
    if (!isAgentMenuOpen.value) {
      focusInput();
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
    skillMenu.close();
  } else if (agentMenuRef.value && !agentMenuRef.value.contains(target) && inputContainerRef.value?.contains(target)) {
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
        const input = inputRef.value;
        const start = input?.selectionStart ?? inputText.value.length;
        const end = input?.selectionEnd ?? start;
        inputText.value = inputText.value.slice(0, start) + text + inputText.value.slice(end);
      }
      listening.value = false;
      focusInput();
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

// ====== Send 按钮与 Vue Bits SlingButton 状态映射 ======
const canSend = computed(() => {
  if (props.reasoningEffortPending) return false;
  if (attachments.value.length > 0) return true;
  const text = inputText.value.trim();
  return text.length > 0;
});
const armed = computed(() => !!props.isSending || canSend.value);

const slingColors = computed(() => {
  const isDark = props.isDark !== false;
  if (props.isSending) {
    return {
      padColor: '#e11d48',
      iconColor: '#ffffff',
      accentColor: '#fb7185',
      wellColor: isDark ? '#4c0519' : '#ffe4e6',
      bandColor: '#f43f5e',
    };
  }
  if (!canSend.value) {
    return {
      padColor: isDark ? '#27272a' : '#e4e4e7',
      iconColor: isDark ? '#71717a' : '#a1a1aa',
      accentColor: isDark ? '#3f3f46' : '#d4d4d8',
      wellColor: isDark ? '#18181b' : '#f4f4f5',
      bandColor: isDark ? '#3f3f46' : '#d4d4d8',
    };
  }
  if (isDark) {
    return {
      padColor: '#f5f5f5',
      iconColor: '#18181b',
      accentColor: '#e4e4e7',
      wellColor: '#27272a',
      bandColor: '#52525b',
    };
  }
  return {
    padColor: '#18181b',
    iconColor: '#ffffff',
    accentColor: '#94a3b8',
    wellColor: '#f1f5f9',
    bandColor: '#cbd5e1',
  };
});

const onSendClick = () => {
  if (props.isSending) emit('stopGeneration');
  else handleSend();
};

/**
 * 三个插槽的 props 投影。
 *
 * <p>共同原则：只暴露「消费者渲染所需」的只读派生值 + **唯一**行为入口；输入区的行为状态
 * （inputText / 附件 / 语音听写 / 斜杠菜单 / 拖拽缩放 / 弹弓力学）一概不暴露，
 * 这样替换实现最多改变"长什么样"，改不掉"怎么工作"，也不会出现第二条触发路径。</p>
 */
const contextUsageSlotProps = computed<ChatInputContextUsageSlotProps>(() => ({
  isDark: props.isDark !== false,
  contextUsageText: contextUsageText.value,
  contextRingDash: contextRingDash.value,
  tooltipVisible: isContextTooltipVisible.value
}));

const modelSelectorSlotProps = computed<ChatInputModelSelectorSlotProps>(() => ({
  isDark: props.isDark !== false,
  models: props.models ?? [],
  selectedModelId: props.selectedModelId,
  drivenModel: drivenModel.value,
  onUpdateModel: (modelId: string | number) => emit('updateModel', modelId),
  onOpenSettingsTab: (tab: string) => emit('openSettingsTab', tab),
  onOpenModelEditor: () => emit('openModelEditor')
}));

const sendButtonSlotProps = computed<ChatInputSendButtonSlotProps>(() => ({
  isSending: !!props.isSending,
  armed: armed.value,
  isDark: props.isDark !== false,
  colors: slingColors.value,
  onSend: onSendClick
}));

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
});

const handleKeyDown = (e: KeyboardEvent) => {
  if (confirmationState.value.isOpen) {
    if (e.key === 'Enter') e.preventDefault();
    return;
  }
  if (isSkillMenuOpen.value) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSkillMenu();
      return;
    }
  }
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

  const isEmpty = !inputText.value;

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
  if (confirmationState.value.isOpen) return;
  if (isPromptOptimizationCommand(inputText.value)) {
    isCommandMenuOpen.value = false;
    isCommandMenuClickedOpen.value = false;
    void promptOptimization.optimize();
    return;
  }
  const text = inputText.value.trim();
  const images = attachments.value.map(attachment => attachment.file);
  if ((!text && images.length === 0) || props.isSending || props.reasoningEffortPending) return;

  const effectiveText = text || t('chat.input.analyzeImagesPrompt');

  emit(
    'sendMessage',
    effectiveText,
    isPlanMode.value,
    localSelectedTeamId.value ? localSelectedTeamId.value : null,
    localSelectedAgentId.value ? localSelectedAgentId.value : null,
    images
  );

  inputText.value = '';
  clearImages();
};

/**
 * 宿主注册的输入区渲染器（三层解析的中间层：父级 `$slots` > 宿主注入 > 内置默认）。
 *
 * <p>必须**按字段判空**，不能按对象真值判：宿主 `provide(CHAT_INPUT_SLOTS_KEY, {})` 时对象为真
 * 但三个字段都缺省，按对象真值判会把它们都当成「已注册」，结果整块区域渲染成空白。
 * 理由与写法照抄 `ChatMessageItem.vue` 的同名逻辑，保持两个组件的解析规则一致。</p>
 */
const slotOverrides = inject(CHAT_INPUT_SLOTS_KEY, undefined);const injectedContextUsage = computed(() => slotOverrides?.contextUsage);
const injectedModelSelector = computed(() => slotOverrides?.modelSelector);
const injectedSendButton = computed(() => slotOverrides?.sendButton);

/**
 * 上下文用量浮层的显示状态。
 *
 * <p>留在组件侧是有意的：触发区是**外层容器**（`relative inline-flex h-7 …`，28px 高）的交互属性，
 * 而容器归组件所有。若随浮层一起搬进渲染器，触发区会缩成 18×18 图标，悬停行为即漂移。</p>
 */
const isContextTooltipVisible = ref(false);

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
  focus: focusInput,
  focusInput: focusInput,
  setInputText: (text: string) => {
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
  openAgentMenu,
  openSkillMenu
});
</script>

<template>
  <div class="w-full max-w-lx-chat mx-auto px-4 select-none">
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
                    {{ t('chat.input.quickCommands') }}
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
        :class="isDark !== false ? 'border-white/[0.08] text-zinc-200' : 'border-zinc-200 text-zinc-800'"
      >
        <div class="px-2.5 pt-1.5 pb-1.5 shrink-0 border-b border-black/5 dark:border-white/5">
          <input
            ref="agentSearchInputRef"
            v-model="agentSearchQuery"
            type="text"
            :placeholder="t('chat.input.searchAgent')"
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
                        {{ t('chat.input.noMatchedAgent') }}
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
            <span class="flex items-center gap-2 min-w-0 shrink-0 max-w-[45%]">
              <!-- 头像：URL 走 <img>，其余按 Emoji 文本渲染 -->
              <img
                v-if="agent.avatar && isImageAvatar(agent.avatar)"
                :src="agent.avatar"
                :alt="agent.name"
                class="w-4 h-4 rounded-full object-cover shrink-0"
              />
              <span
                v-else-if="agent.avatar"
                class="w-4 h-4 rounded-full flex items-center justify-center text-[10px] leading-none shrink-0 select-none [background:color-mix(in_srgb,var(--pb-ink)_10%,transparent)]"
              >{{ agent.avatar }}</span>
              <span class="font-medium truncate [color:var(--pb-ink)]">
                {{ agent.name }}
              </span>
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

      <!-- Skill 清单菜单 (/skill 触发，点击清单项自动填充指令句) -->
      <div
        v-if="isSkillMenuOpen"
        class="bottom-[calc(100%+8px)] z-50 absolute inset-x-0 shadow-[0_16px_40px_rgba(0,0,0,0.7)] p-1.5 rounded-xl border backdrop-blur-md [background:color-mix(in_srgb,var(--pb-menu)_95%,transparent)] [animation:prompt-bar-pop_180ms_cubic-bezier(0.23,1,0.32,1)_both]"
        :class="isDark !== false ? 'border-white/[0.08] text-zinc-200' : 'border-zinc-200 text-zinc-800'"
      >
        <div class="px-2.5 pt-1.5 pb-1.5 shrink-0 border-b border-black/5 dark:border-white/5">
          <input
            ref="skillSearchInputRef"
            v-model="skillMenu.searchQuery.value"
            type="text"
            :placeholder="t('chat.input.searchSkill')"
            class="w-full px-1 py-0.5 text-xs bg-transparent border-none outline-none focus:outline-none focus:ring-0 select-text [color:var(--pb-ink)] placeholder:[color:color-mix(in_srgb,var(--pb-ink)_45%,transparent)]"
            @keydown.esc.prevent="closeSkillMenu"
          />
        </div>

        <div class="relative max-h-60 overflow-y-auto scrollbar-thin space-y-0.5 pt-1">
          <div
            v-if="skillMenu.isLoading.value"
            class="px-3 py-3 text-xs text-center"
            :class="MUTED"
          >
            {{ t('chat.input.skillLoading') }}
          </div>
          <div
            v-else-if="skillMenu.loadError.value"
            class="px-3 py-3 text-xs text-center"
            :class="MUTED"
          >
            <span class="text-red-500">{{ t('chat.input.skillLoadFailed') }}</span>
            <button type="button" class="ml-2 underline" @click="skillMenu.open()">{{ t('common.retry') }}</button>
          </div>
          <div
            v-else-if="skillMenu.filteredSkills.value.length === 0"
            class="px-3 py-3 text-xs text-center"
            :class="MUTED"
          >
            {{ skillMenu.skills.value.length === 0 ? t('chat.input.skillEmpty') : t('chat.input.noMatchedSkill') }}
          </div>

          <button
            v-for="skill in skillMenu.filteredSkills.value"
            :key="skill.name"
            type="button"
            class="flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-xs select-none w-full text-left bg-transparent border-0 outline-none cursor-pointer transition-colors hover:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)]"
            :title="t('chat.input.skillFillTemplate', { name: skill.name })"
            @click="selectSkill(skill)"
          >
            <span class="font-medium truncate shrink-0 max-w-[45%] [color:var(--pb-ink)]">
              {{ skill.name }}
            </span>
            <span class="text-xs truncate text-right flex-1 min-w-0" :class="MUTED">
              {{ skill.description }}
            </span>
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
                    <span :class="MUTED">{{ t('chat.input.reasoningEffort') }}</span>
          <span class="font-medium">{{ level }}</span>
          <span v-if="reasoningEffortPending" role="status" class="text-xs" :class="MUTED">{{ t('chat.input.syncing') }}</span>
          <span class="inline-flex ml-auto cursor-help" :class="MUTED" :title="t('chat.input.effortTip')">
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
      <p v-if="promptOptimization.isOptimizing.value" role="status" class="text-xs text-lx-muted">
        {{ t('chat.optimizePrompt.loading') }}
      </p>
      <p v-if="promptOptimization.error.value" role="alert" class="text-xs text-red-500">
        {{ promptOptimization.error.value }}
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
                    <span class="max-w-[150px] truncate text-xs">{{ attachment.file.name || t('chat.input.imageAttachment') }}</span>
          <button
            type="button"
            class="inline-grid place-items-center bg-transparent opacity-60 hover:opacity-100 p-0 hover:[background:color-mix(in_srgb,var(--pb-ink)_10%,transparent)] border-0 rounded-[5px] outline-none w-[18px] h-[18px] text-inherit cursor-pointer [transition:opacity_120ms_ease,background-color_120ms_ease]"
            :title="t('chat.input.removeAttachment')"
                        :aria-label="t('chat.input.removeAttachmentNamed', { name: attachment.file.name })"
                        @click.stop="removeImage(index)"
          >

            <HugeiconsIcon :icon="Cancel01Icon as IconArray" :size="10" :stroke-width="2.5" />
          </button>
        </span>
      </div>
      <div class="text-xs text-lx-muted" aria-live="polite">
                <span v-if="limitsLoading">{{ t('chat.input.readingImageLimit') }}</span>
        <span v-else-if="limitsError" class="text-red-500">{{ limitsError }}
          <button type="button" class="ml-2 underline" @click="loadLimits">{{ t('common.retry') }}</button>
        </span>
        <span v-else-if="attachments.length">{{ t('chat.input.selectedImages', { count: attachments.length, max: maxImages ?? 0 }) }}</span>
        <p v-if="attachmentError" class="text-red-500" role="alert">{{ attachmentError }}</p>
      </div>

      <!-- 文本输入区 -->
      <div class="flex items-start gap-1.5 w-full min-w-0">
        <span
          v-if="isPlanMode"
          class="text-amber-500 font-medium text-xs leading-[22px] shrink-0 select-none cursor-pointer hover:opacity-80 px-1.5 rounded bg-amber-500/10 whitespace-nowrap"
          :title="t('chat.input.exitPlanTip')"
          @click.stop="isPlanMode = false"
        >
          /plan
        </span>

        <span
          v-if="currentAgentName"
          class="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-lg bg-blue-500/15 text-blue-400 select-none cursor-pointer hover:opacity-90 shrink-0 transition whitespace-nowrap leading-tight"
          :title="t('chat.input.switchAgentTip')"
          @click.stop="openAgentMenu"
        >
          <span>🤖 {{ currentAgentName }}</span>
          <span
            class="hover:text-red-400 hover:bg-black/10 dark:hover:bg-white/10 rounded-full w-3.5 h-3.5 flex items-center justify-center text-xs leading-none transition"
            :title="t('chat.input.exitAgentTip')"
            @click.stop="clearSelectedAgent"
          >×</span>
        </span>

        <div ref="inputContainerRef" class="relative w-full min-w-0 flex-1">
          <textarea
            ref="inputRef"
            v-model="inputText"
            :placeholder="inputPlaceholder"
            :aria-label="inputPlaceholder"
            rows="1"
            class="chat-text-input w-full text-[14px] leading-[22px] [color:var(--pb-ink)] [caret-color:var(--pb-ink)] cursor-text select-text"
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
                        :aria-label="t('chat.input.quickCommandsTip')"
            :aria-expanded="isCommandMenuOpen"
            :data-on="isCommandMenuOpen ? '' : undefined"
            :title="t('chat.input.quickCommandsTip')"
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
            :title="maxImages ? t('chat.input.uploadImageTip', { max: maxImages }) : t('chat.input.readingImageLimitShort')"
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
            :placeholder="t('chat.input.selectTeam')"
            trigger-class="inline-flex h-7 flex-none cursor-pointer touch-manipulation items-center gap-1 rounded-lg border-0 bg-transparent px-2 text-[12px] font-medium outline-none select-none [color:color-mix(in_srgb,var(--pb-ink)_70%,transparent)] [font:inherit] [-webkit-tap-highlight-color:transparent] [transition:background-color_150ms_ease,color_150ms_ease] hover:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] hover:[color:var(--pb-ink)] whitespace-nowrap"
          />

          <!-- Effort 思考强度按钮 -->
          <button
            type="button"
            :class="TOOL_BTN"
            :aria-label="t('chat.input.selectEffort')"
            :aria-expanded="effortOpen"
            :data-on="effortOpen ? '' : undefined"
            :data-max="maxed ? '' : undefined"
            :title="t('chat.input.selectEffortTip')"
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
            <slot name="contextUsage" v-bind="contextUsageSlotProps">
              <component :is="injectedContextUsage" v-if="injectedContextUsage" v-bind="contextUsageSlotProps" />
              <ChatInputContextUsage v-else v-bind="contextUsageSlotProps" />
            </slot>
          </div>

          <!-- 模型：Agent/团队预设驱动时选择器不参与本轮，改显实际生效模型与来源（点击去改预设） -->
          <slot name="modelSelector" v-bind="modelSelectorSlotProps">
            <component :is="injectedModelSelector" v-if="injectedModelSelector" v-bind="modelSelectorSlotProps" />
            <ChatInputModelSelector v-else v-bind="modelSelectorSlotProps" />
          </slot>

          <!-- 语音录入 (Mic) 按钮 -->
          <button
            v-if="hasDictate"
            type="button"
            :class="ICON_BTN"
                        :aria-label="listening ? t('chat.input.stopRecording') : t('chat.input.voiceInput')"
            :aria-pressed="listening"
            :data-on="listening ? '' : undefined"
            :title="t('chat.input.voiceInput')"
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

          <!-- Vue Bits 弹弓发送 / 停止按钮：支持拖拽弹射与点击发送，带发射粒子与弹力回弹 -->
          <slot name="sendButton" v-bind="sendButtonSlotProps">
            <component :is="injectedSendButton" v-if="injectedSendButton" v-bind="sendButtonSlotProps" />
            <ChatInputSendButton v-else v-bind="sendButtonSlotProps" />
          </slot>
        </div>
      </div>
    </div>
    </BorderGlow>
  </div>
</template>

<style>
.chat-text-input {
  display: block;
  padding: 0;
  border: 0;
  background: transparent;
  resize: none;
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
.chat-text-input::placeholder {
  color: color-mix(in srgb, var(--pb-ink) 45%, transparent);
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
