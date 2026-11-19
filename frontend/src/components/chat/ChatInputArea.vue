<script setup lang="ts">
import {computed, type CSSProperties, inject, nextTick, onBeforeUnmount, onMounted, ref, watch} from 'vue';
import {
  Cancel01Icon,
  HelpCircleIcon,
  Mic01Icon,
  PlusSignIcon,
  SparklesIcon,
  Tick02Icon
} from '@hugeicons/core-free-icons';
import {HugeiconsIcon, type IconArray} from '@hugeicons/vue';
import BorderGlow from '../common/BorderGlow.vue';
import ImageLightbox from '../common/ImageLightbox.vue';
import SparkTrail from '../common/SparkTrail.vue';
import ProjectDropdown from './ProjectDropdown.vue';
import ChatInputPlusMenu from './ChatInputPlusMenu.vue';
import ChatInputAccessMenu from './ChatInputAccessMenu.vue';
import type {
  AgentPermissionMode,
  AgentVO,
  ChatMode,
  McpConnectionStateVO,
  McpVO,
  ModelConfig,
  ReasoningEffort,
  TeamVO,
  WorkspaceEnvType,
  WorkspaceVO
} from '../../types/chat';
import {reasoningEffortOptions} from '../../composables/useReasoningEffort';
import {TeamAPI} from '../../services/team';
import {McpAPI} from '../../services/mcp';
import {AgentAPI} from '../../services/agent';
import {isOk} from '../../utils/api';
import {nextMcpStatus} from '../../utils/mcpStatus';
import {useChatImageAttachments} from '../../composables/useChatImageAttachments';
import {useSkillList} from '../../composables/useSkillList';
import {isPromptOptimizationCommand, usePromptOptimization} from '../../composables/usePromptOptimization';
import {useConfirm} from '../../composables/useConfirm';
import {isImageAvatar} from '../../utils/avatar';
import PastedDocumentCard from './PastedDocumentCard.vue';
import PastedDocumentPreviewModal from './PastedDocumentPreviewModal.vue';
import {
  composeMessageWithDocuments,
  createPastedDocument,
  isLargePastedText,
  type PastedDocument
} from '../../utils/pastedDocument';
import {t} from '../../i18n';
import {useShortcuts} from '../../composables/useShortcuts';
import {
  isAccessModeMismatch,
  resolveAccessBadgeKey,
  resolveAccessTipKey,
  resolveSandboxState,
} from '../../utils/accessModePresentation';
import type {
  ChatInputContextUsageSlotProps,
  ChatInputModelSelectorSlotProps,
  ChatInputSendButtonSlotProps,
} from '../../types/chatInputSlots';
import {CHAT_INPUT_SLOTS_KEY} from '../../types/chatInputSlots';
import ChatInputContextUsage from './ChatInputContextUsage.vue';
import {resolveContextRingDash, resolveContextUsageText, resolveContextUsageTip} from '../../views/chat/contextUsagePresentation';
import ChatInputModelSelector from './ChatInputModelSelector.vue';
import ChatInputSendButton from './ChatInputSendButton.vue';
import {ICON_BTN, MUTED, TOOL_BTN} from '../../utils/promptBarStyles';
import {
  hasUnexpectedCommandBody,
  resolveChatSendDraft,
  resolveTextAfterCommandSelect,
  toChatMode
} from '../../utils/chatCommand';

const props = defineProps<{
  isSending?: boolean;
  /**
   * 手工压缩（`/compact`）在途。
   *
   * <p>压缩是一次几十秒级的模型调用，界面必须给出「正在压」的反馈，否则用户只会重复点，
   * 而后端第二次必然以「在执行中 / 用量不足 20%」拒绝，看着像坏了。同时在途期间禁止发送：
   * 后端要写回会话上下文正文，此时再起一轮就是在和压缩抢同一份上下文。</p>
   */
  isCompacting?: boolean;
  queueMessage?: (text: string, requirePlan: boolean, agentId: string | number | null | undefined, images: File[]) => Promise<boolean>;
  /**
   * 编辑态下的提交：把输入框内容原位写回队列里的**那一条**（`PUT`），而不是发新消息。
   *
   * <p>和 `queueMessage` 分开是因为语义不同：入队是新增，这里是更新，混成一个回调
   * 只能靠调用方猜「当前是不是编辑态」，猜错就是两条消息。</p>
   */
  updateQueuedMessage?: (text: string, requirePlan: boolean, agentId: string | number | null | undefined, images: File[]) => Promise<boolean>;
  /** 当前输入框里回填的是队列中某一条待发送消息（提交即更新那一条）。 */
  editingQueued?: boolean;
  isDark?: boolean;
  models?: ModelConfig[];
  selectedModelId?: string | number;
  hasActiveSession?: boolean;
  canChangeWorkspace?: boolean;
  workspaces?: WorkspaceVO[];
  selectedWorkspaceId?: string | number | null;
  accessMode?: AgentPermissionMode | string;
  /** 执行环境：档位语义随它变化，徽标必须一起读，不能只看档位。 */
  envType?: WorkspaceEnvType | string;
  reasoningEffort?: ReasoningEffort;
  reasoningEffortPending?: boolean;
  reasoningEffortError?: string;
  teams?: TeamVO[];
  selectedTeamId?: string | number | null;
  agents?: AgentVO[];
  selectedAgentId?: string | number | null;
  /**
   * 「下一条指令」建议（后端按终态轮次预测）。
   *
   * <p>渲染方式是**占位文本**而不是独立气泡：建议本来就该待在用户要写字的那个位置，
   * 按 Tab 直接补全。输入框一有内容占位文本自然消失，不需要额外判空。</p>
   */
  prediction?: string;
  /**
   * plan 模式（受控）：宿主是唯一事实源，本组件只镜像并回传变更。
   *
   * <p>历史实现把它做成组件私有 ref，宿主既观察不到也控制不了，`updateMode` 事件发出去
   * 没有任何监听者。现在由宿主持有状态、通过 props + `updateMode` 事件双向绑定；
   * `mode` 缺省时才退回组件本地状态（无宿主直接挂载本组件的场景）。</p>
   */
  mode?: ChatMode;
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

/** 发送键来自个性化配置（默认 Enter），与设置页共用同一份运行时绑定。 */
const shortcutRuntime = useShortcuts();

const emit = defineEmits<{
  (e: 'openModelEditor'): void;
  (e: 'openTeamModal'): void;
  (e: 'sendMessage', text: string, requirePlan: boolean, teamId?: string | number | null, agentId?: string | number | null, imageFiles?: File[]): void;
  (e: 'stopGeneration'): void;
  (e: 'updateMode', mode: ChatMode): void;
  (e: 'updateModel', modelId: string | number): void;
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
  /** 采纳「下一条指令」建议（宿主据此清空建议） */
  (e: 'applyPrediction', text: string): void;
  /** 输入框是否已空：宿主据此决定要不要开始预测计时（有草稿就别预测） */
  (e: 'updateDraftEmpty', empty: boolean): void;
  /** 工作区权限档位变更（去向必须是 userConfig，与安全中心同一处真源） */
  (e: 'updateAccessMode', mode: AgentPermissionMode): void;
  /** 手工压缩当前会话上下文（/compact）：宿主负责调接口并回填用量与审计 */
  (e: 'compactContext'): void;
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
const inputRef = ref<HTMLTextAreaElement | null>(null);
/** 有预测且没在听写/plan 模式时，占位文本就是那条建议 + 补全提示。 */
const predictionHint = computed(() => {
  const text = (props.prediction ?? '').trim();
  return text ? `${text} ${t('chat.input.predictionHint')}` : '';
});
const inputPlaceholder = computed(() => {
  if (listening.value) return t('chat.input.placeholderListening');
  if (isPlanMode.value) return t('chat.input.placeholderPlan');
  return predictionHint.value || t('chat.input.placeholderDefault');
});
/**
 * plan 模式的可写视图：读受控 prop，写回 `updateMode` 事件。
 *
 * <p>为什么用 getter/setter 而不是双向 watch 同步：watch 同步会在「宿主没监听事件」时
 * 把界面卡在旧状态；这里本地留一份镜像，宿主接了就完全由宿主决定，没接也能自己动。</p>
 */
const localPlanMode = ref(false);
const isPlanMode = computed<boolean>({
  get: () => (props.mode === undefined ? localPlanMode.value : props.mode === 'plan'),
  set: (next: boolean) => {
    localPlanMode.value = next;
    emit('updateMode', toChatMode(next));
  }
});
let inputDisposed = false;

const focusInput = () => {
  // 附件选择后的聚焦会排队，卸载后不能再访问输入框。
  nextTick(() => {
    if (inputDisposed || !inputRef.value) return;
    inputRef.value.focus();
    inputRef.value.setSelectionRange(inputText.value.length, inputText.value.length);
  });
};

/**
 * 采纳「下一条指令」建议：整段替换输入框内容并聚焦。
 *
 * <p>不解析命令、不切模式：预测出来的只是一句自然语言，按命令解析等于替用户改主意。</p>
 */
const applyPrediction = () => {
  const text = (props.prediction ?? '').trim();
  if (!text) return;
  emit('applyPrediction', text);
  writeInputText(text);
  focusInput();
};

/**
 * 空态上抛：宿主用它当预测闸门之一（输入框有草稿就不该计时）。
 *
 * <p>只上报「空/非空」这一个事实，不把整段草稿传出去 —— 草稿是输入框的私有状态。</p>
 */
watch(inputText, () => {
  emit('updateDraftEmpty', inputText.value.trim() === '');
}, {immediate: true});

const promptOptimization = usePromptOptimization(inputText, () => props.selectedModelId, focusInput, text => {
  // 草稿回填只是文本替换：不解析命令、不切模式、不改写内容，只收起可能挡视线的浮层。
  closeCommandLayer();
  writeInputText(text);
});
const { state: confirmationState, notice } = useConfirm();

// ====== 语音听写 (Mic) 基础状态 ======
let dictation = 0;
const listening = ref(false);

// 附件管理
const { attachments, maxImages, limitsLoading, limitsError, attachmentError, canAttach,
  loadLimits, addImages, removeImage, clearImages } = useChatImageAttachments();
const fileInputRef = ref<HTMLInputElement | null>(null);

// ====== 附件大图预览 ======
/** 正在预览的附件快照；关闭后**保留** src，让 dialog 元素不重建（原生焦点回收依赖它）。 */
const previewingAttachment = ref<{src: string; name: string} | null>(null);
const isImagePreviewOpen = ref(false);

/** chip 缩略图 → 大图：只消费真实的 `attachment.preview`，不构造任何临时实体。 */
const openImagePreview = (attachment: {file: File; preview: string}) => {
  previewingAttachment.value = {
    src: attachment.preview,
    name: attachment.file.name || t('chat.input.imageAttachment')
  };
  isImagePreviewOpen.value = true;
};

const closeImagePreview = () => {
  isImagePreviewOpen.value = false;
};

/**
 * 删除附件：预览开着就先关预览、再让 composable revoke。
 *
 * <p>顺序不能反 —— `revokeObjectURL` 之后 `<img>` 立刻失去图源，用户会看到裂图；
 * 而「关闭预览」不释放任何资源，先做没有代价。</p>
 */
const removeImageAttachment = (index: number) => {
  const target = attachments.value[index];
  if (target && previewingAttachment.value?.src === target.preview) {
    closeImagePreview();
  }
  removeImage(index);
};

/** 清空附件同理：先关预览再统一 revoke，避免裂图与内存泄漏。 */
const clearImageAttachments = () => {
  closeImagePreview();
  clearImages();
};

const processImageFiles = (files: File[]) => {
  addImages(files);
  focusInput();
};

/**
 * 程序写入输入框的**唯一**通道。
 *
 * <p>为什么需要这个标记：命令副作用只允许发生在「用户显式选中菜单项」与「submit 解析」两个
 * 时机，所以必须区分「用户真的在打字」与「程序写文本」（宿主 setInputText 回填历史消息、
 * prompt 优化草稿回填、语音听写、清空）。给它命名成函数而不是散落的赋值，是为了让全局的
 * 文本监听只做形态映射，永远不可能被一次回填带去执行命令。</p>
 */
let programmaticWrite = false;
const writeInputText = (text: string) => {
  // 判等早返回：ref 写入同值不会触发 watch，此时若先置标记，标记就会残留到用户的
  // 下一次真实输入，把对方当成程序写入（快捷指令菜单于是不弹）。所以先判等、再置标记。
  if (inputText.value === text) {
    return;
  }
  programmaticWrite = true;
  inputText.value = text;
};

/**
 * 粘贴 / 拖入标记：`beforeinput` 早于 v-model 写入，用它把这两种用户操作排除在
 * 「弹出快捷指令菜单」之外（需求要求粘贴不得引发命令副作用）。
 */
let pasteEditPending = false;
const handleBeforeInput = (event: Event) => {
  const inputType = (event as InputEvent).inputType ?? '';
  pasteEditPending = inputType === 'insertFromPaste' || inputType === 'insertFromDrop';
};

/** 收起斜杠指令 / Agent / Skill 三层浮层（只动浮层，绝不触碰输入文本）。 */
const closeCommandLayer = () => {
  isCommandMenuOpen.value = false;
  isAgentMenuOpen.value = false;
};

watch(inputText, () => {
  sparkRef.value?.ping();
  const typedByUser = !programmaticWrite && !pasteEditPending;
  programmaticWrite = false;
  pasteEditPending = false;

  // 快捷指令菜单只是「文本形态 → 菜单可见性」的映射：不改写文本、不执行任何命令。
  // 只有用户真在打字时才弹菜单，程序回填的 "/plan xxx" 不会凭空顶出一层浮层。
  if (typedByUser && inputText.value.startsWith('/') && !isAgentMenuOpen.value) {
    isCommandMenuOpen.value = true;
    activeCommandIndex.value = 0;
    return;
  }
  if (!inputText.value.startsWith('/') && !isAgentMenuOpen.value) {
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

// ====== 粘贴大文本转文档小卡片管理 ======
const pastedDocuments = ref<PastedDocument[]>([]);
const previewingDocument = ref<PastedDocument | null>(null);
const isDocumentPreviewOpen = ref(false);

const addPastedDocument = (text: string, options?: { title?: string }) => {
  const doc = createPastedDocument(text, options);
  pastedDocuments.value.push(doc);
  focusInput();
};

const removePastedDocument = (index: number) => {
  pastedDocuments.value.splice(index, 1);
};

const clearPastedDocuments = () => {
  pastedDocuments.value = [];
  previewingDocument.value = null;
  isDocumentPreviewOpen.value = false;
};

const openDocumentPreview = (doc: PastedDocument) => {
  previewingDocument.value = doc;
  isDocumentPreviewOpen.value = true;
};

const closeDocumentPreview = () => {
  isDocumentPreviewOpen.value = false;
  previewingDocument.value = null;
};

const expandDocumentToInput = (doc: PastedDocument) => {
  const index = pastedDocuments.value.findIndex(d => d.id === doc.id);
  if (index >= 0) pastedDocuments.value.splice(index, 1);
  closeDocumentPreview();
  const existing = inputText.value.trim();
  writeInputText(existing ? `${existing}\n\n${doc.content}` : doc.content);
  focusInput();
};

const handlePaste = (e: ClipboardEvent) => {
  const items = e.clipboardData?.items;
  if (items && items.length > 0) {
    const files = Array.from(items).filter(item => item.type.startsWith('image/'))
      .map(item => item.getAsFile()).filter((file): file is File => file !== null);
    if (files.length > 0) {
      e.preventDefault();
      processImageFiles(files);
      return;
    }
  }
  const text = e.clipboardData?.getData('text/plain') || e.clipboardData?.getData('text') || '';
  if (text && isLargePastedText(text)) {
    e.preventDefault();
    addPastedDocument(text);
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

// plan 模式变更的对外通知已经收进 `isPlanMode` 的 setter：一处写入、一处派发，
// 不再靠 watch 二次转发（watch 转发会在「宿主未监听」时与受控 props 打架）。

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
  isAgentMenuOpen.value = false;
  effortOpen.value = !effortOpen.value;
};

// ====== Team 团队列表（数据源在 + 菜单的「协作」分组里消费） ======
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

const selectedTeam = computed<string | number>({
  get: () => localSelectedTeamId.value,
  set: (val) => {
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

/**
 * 协作模式（选中团队）在输入行里的徽标文案。
 *
 * <p>找名字只用两份数据源：宿主注入的 `teams`（权威）和挂载时自己拉的那页 `localTeams`。
 * 都还没到就显示 `团队 #id` —— 徽标必须让用户看见「现在是协作模式」，不能因为列表没回来就凭空消失。</p>
 */
const currentTeamName = computed(() => {
  if (!localSelectedTeamId.value) return '';
  const list = props.teams && props.teams.length > 0 ? props.teams : localTeams.value;
  const found = list.find(item => String(item.id) === String(localSelectedTeamId.value));
  return found?.name || t('chat.input.teamFallback', { id: localSelectedTeamId.value });
});

/** 徽标上的 × 与 Plan 徽标对称：只清协作，不动模式与草稿。 */
const clearSelectedTeam = () => {
  selectedTeam.value = '';
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

// ====== Skill 清单：`/skill` 与「+」菜单的技能分组共用这一份数据，只有一处渲染 ======
const skillList = useSkillList();

/**
 * 点击清单项：把「使用{skill}完成工作」填进输入框。
 *
 * <p>输入框已有内容时**追加**而非覆盖——用户可能正打到一半，替写掉就是毁数据；
 * 空白输入才整句填入。填完收起浮层并把焦点还回输入框，让用户直接改后半句或发送。</p>
 */
const selectSkill = (skill: { name: string }) => {
  const sentence = t('chat.input.skillFillTemplate', { name: skill.name });
  const existing = inputText.value.trim();
  writeInputText(existing ? `${existing} ${sentence}` : sentence);
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

const contextUsageText = computed(() => resolveContextUsageText(props.contextUsage));
const contextRingDash = computed(() => resolveContextRingDash(props.contextUsage));
// 环常驻，「有没有数据」只影响画法：未采集时只有空底轨 + 占位浮层文案。
const hasContextUsage = computed(() => contextUsageText.value !== '');
const contextUsageTip = computed(() => resolveContextUsageTip(props.contextUsage));

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
const activeCommandIndex = ref(0);
const commandRowRefs: (HTMLButtonElement | null)[] = [];
const commandGlowRef = ref<HTMLSpanElement | null>(null);

const allCommands = computed<CommandItem[]>(() => [
  {
    id: 'plan',
    name: 'plan',
    desc: t('chat.command.plan'),
    action: () => {
      // 只切模式：正文归文本状态所有，清空逻辑统一收敛在 selectCommand 的
      // resolveTextAfterCommandSelect 判据里，菜单项不得各自清空用户已写内容。
      isPlanMode.value = true;
      focusInput();
    }
  },
  {
    id: 'compact',
    name: 'compact',
    desc: t('chat.command.compact'),
    action: () => {
      // 压缩是一次会话级动作，不需要正文；宿主负责调接口并把用量与审计回填到界面。
      emit('compactContext');
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
    id: 'agent',
    name: 'agent',
    desc: t('chat.command.agent'),
    action: () => {
      openAgentMenu();
    }
  },
  {
    id: 'optimize-prompt',
    name: 'optimize-prompt',
    desc: t('chat.command.optimizePrompt'),
    action: () => { void promptOptimization.optimize(); }
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

// ====== 「+」分组菜单：一级分组 + 右侧二级浮层（/ 指令清单不再由 + 触发） ======
const isPlusMenuOpen = ref(false);
/** 打开时要直接展开的分组；`/team` 这类命令直达协作面板，不再绕一层点击。 */
const plusMenuInitialGroup = ref<string | null>(null);

const plusMenuTeams = computed<TeamVO[]>(() =>
  (props.teams && props.teams.length > 0 ? props.teams : localTeams.value));

const mcpServers = ref<McpVO[]>([]);
const mcpStates = ref<McpConnectionStateVO[]>([]);
const mcpLoading = ref(false);
const mcpError = ref('');
/** 行内动作进行中标记（按 `String(server.id)`）：按钮置灰挡连点，面板本身不切回加载占位。 */
const mcpBusy = ref<Record<string, boolean>>({});

const markMcpBusy = (key: string, busy: boolean): void => {
  mcpBusy.value = {...mcpBusy.value, [key]: busy};
};

/**
 * 按需拉取 MCP 服务与共享连接状态。
 *
 * <p>只在菜单打开时请求：MCP 是全局配置，输入区每次挂载都拉一遍等于白烧一次往返。
 * 连接状态拿不到时保持空数组，由菜单自己说「未连接」，绝不编造工具数。</p>
 */
const loadMcpServers = async () => {
  mcpLoading.value = true;
  mcpError.value = '';
  try {
    const res = await McpAPI.list(1, 50);
    if (!isOk(res.code) || !res.data) {
      mcpServers.value = [];
      mcpStates.value = [];
      mcpError.value = res.errMsg || t('chat.input.plusMcpFailed');
      return;
    }
    mcpServers.value = res.data.records ?? [];
    if (!mcpServers.value.length) {
      mcpStates.value = [];
      return;
    }
    const states = await McpAPI.listStates(mcpServers.value.map(item => item.id));
    mcpStates.value = isOk(states.code) && states.data ? states.data : [];
  } catch (err) {
    mcpServers.value = [];
    mcpStates.value = [];
    mcpError.value = err instanceof Error ? err.message : t('chat.input.plusMcpFailed');
  } finally {
    mcpLoading.value = false;
  }
};

const closePlusMenu = () => {
  isPlusMenuOpen.value = false;
  plusMenuInitialGroup.value = null;
};

const openPlusMenu = (group?: string) => {
  isCommandMenuOpen.value = false;
  isAgentMenuOpen.value = false;
  isAccessMenuOpen.value = false;
  effortOpen.value = false;
  plusMenuInitialGroup.value = group ?? null;
  isPlusMenuOpen.value = true;
  if (group) void loadPlusGroup(group);
};

/**
 * 分组展开时才去取数据。
 *
 * <p>菜单里的分组是点开才渲染面板，数据不在菜单挂载时全量预取；也不在 `openPlusMenu`
 * 里按参数猜 —— 用户从「+」进去再点分组，走的是这条同一个入口，否则 MCP 面板永远是空的。</p>
 */
const loadPlusGroup = async (group: string) => {
  if (group === 'skills') await skillList.load();
  if (group === 'mcp' && !mcpLoading.value) await loadMcpServers();
  if (group === 'teams' && !plusMenuTeams.value.length) await fetchTeams();
};

const handlePlusClick = () => {
  effortOpen.value = false;
  isAgentMenuOpen.value = false;
  if (isPlusMenuOpen.value) {
    closePlusMenu();
    return;
  }
  openPlusMenu();
};

/** 协作面板选团队：复用 `selectedTeam` 的 setter（与单 Agent 互斥、回传宿主都只有一份实现）。 */
const handlePlusSelectTeam = (teamId: string | number | null) => {
  selectedTeam.value = teamId ?? '';
  closePlusMenu();
  focusInput();
};

const handlePlusCreateTeam = () => {
  closePlusMenu();
  emit('openTeamModal');
};

const handlePlusUpdatePlanMode = (planMode: boolean) => {
  isPlanMode.value = planMode;
  closePlusMenu();
  focusInput();
};

const handlePlusSelectSkill = (skill: { name: string; description: string }) => {
  closePlusMenu();
  selectSkill(skill);
};

const handleOpenMcpSettings = () => {
  closePlusMenu();
  emit('openSettingsTab', 'mcp');
};

/**
 * 只刷新单个服务的共享连接状态。
 *
 * <p>行内动作后不能走 `loadMcpServers`：整块置 loading 会把面板切回「正在加载 MCP 服务…」，
 * 用户眼前闪一下、服务行也消失片刻。</p>
 */
const applyMcpState = (key: string, state: McpConnectionStateVO): void => {
  mcpStates.value = [...mcpStates.value.filter(item => String(item.id) !== key), state];
};

const refreshMcpState = async (server: McpVO): Promise<void> => {
  const key = String(server.id);
  try {
    const res = await McpAPI.listStates([server.id]);
    if (!isOk(res.code) || !res.data) return;
    const latest = res.data.find(item => String(item.id) === key);
    if (latest) applyMcpState(key, latest);
  } catch {
    // 状态刷新失败不动已有状态：动作本身已经成功，不能因为刷新把徽标清空。
  }
};

/**
 * 行内启用 / 停用。
 *
 * <p>只提交 `{id, status}`：后端按缺省字段保持原值，把 url / command 一起回传等于另一种
 * 传输方式的连接参数被写空（与设置页 `handleToggleMcp` 同一语义）。</p>
 */
const handlePlusToggleMcp = async (server: McpVO) => {
  const key = String(server.id);
  if (mcpBusy.value[key]) return;
  markMcpBusy(key, true);
  mcpError.value = '';
  const nextStatus = nextMcpStatus(server.status);
  try {
    const res = await McpAPI.update({id: server.id, status: nextStatus});
    if (!isOk(res.code)) {
      mcpError.value = res.errMsg || t('chat.input.plusMcpActionFailed');
      return;
    }
    mcpServers.value = mcpServers.value.map(item =>
      String(item.id) === key ? {...item, status: nextStatus} : item);
    // 启用后后端会立刻建连，状态表才有新值；不刷新会一直显示「未连接」。
    await refreshMcpState(server);
  } catch (err) {
    mcpError.value = err instanceof Error ? err.message : t('chat.input.plusMcpActionFailed');
  } finally {
    markMcpBusy(key, false);
  }
};

/** 行内重新连接：返回的 `McpConnectionStateVO` 就是最新状态，失败原因由后端记进状态表。 */
const handlePlusReconnectMcp = async (server: McpVO) => {
  const key = String(server.id);
  if (mcpBusy.value[key]) return;
  markMcpBusy(key, true);
  mcpError.value = '';
  let applied = false;
  try {
    const res = await McpAPI.reconnect(server);
    if (isOk(res.code) && res.data) {
      applyMcpState(key, res.data);
      applied = true;
    } else {
      mcpError.value = res.errMsg || t('chat.input.plusMcpActionFailed');
    }
  } catch (err) {
    mcpError.value = err instanceof Error ? err.message : t('chat.input.plusMcpActionFailed');
  } finally {
    // 失败时后端把原因写进了状态表，拉一次才看得见；成功时已有权威返回值，不必再问一次。
    if (!applied) await refreshMcpState(server);
    markMcpBusy(key, false);
  }
};

// ====== 工作区权限上拉框（常驻触发器，菜单里切档） ======
const isAccessMenuOpen = ref(false);

const toggleAccessMenu = () => {
  const willOpen = !isAccessMenuOpen.value;
  closePlusMenu();
  isCommandMenuOpen.value = false;
  isAgentMenuOpen.value = false;
  effortOpen.value = false;
  isAccessMenuOpen.value = willOpen;
};

const handleSelectAccessMode = (mode: AgentPermissionMode) => {
  isAccessMenuOpen.value = false;
  emit('updateAccessMode', mode);
  focusInput();
};

const handleOpenSecurity = () => {
  isAccessMenuOpen.value = false;
  emit('openSettingsTab', 'security');
};


/**
 * 选中菜单项。
 *
 * <p>清空规则**只有一条**：整段输入就是一个命令 token（如用户只打了 "/plan"）时清空，
 * 其余情况一个字都不动 —— 用户可能正打到一半，替写掉就是毁数据。历史实现里
 * 「只要文本以 / 开头就整段清空」正是缺陷本体（"/帮我修这个bug" 会被整段吞掉）。</p>
 */
const selectCommand = (cmd: CommandItem) => {
  writeInputText(resolveTextAfterCommandSelect(inputText.value));
  isCommandMenuOpen.value = false;
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
    isAgentMenuOpen.value = false;
    effortOpen.value = false;
      closePlusMenu();
    isAccessMenuOpen.value = false;
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
        writeInputText(inputText.value.slice(0, start) + text + inputText.value.slice(end));
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
  // 压缩在途时不给发送态：上下文正要被改写，此时发出的一轮读到的可能是压缩前的旧正文。
  if (props.isCompacting) return false;
  if (attachments.value.length > 0) return true;
  if (pastedDocuments.value.length > 0) return true;
  const text = inputText.value.trim();
  return text.length > 0;
});
const queueSubmitting = ref(false);
// 编辑态同样算「可提交」：它提交到队列里的那一条（PUT），不是发新消息。
const hasQueueableInput = computed(() => (!!props.queueMessage || !!props.updateQueuedMessage)
  && !props.reasoningEffortPending
  && (attachments.value.length > 0 || inputText.value.trim().length > 0 || pastedDocuments.value.length > 0));
const canQueue = computed(() => hasQueueableInput.value && !queueSubmitting.value);
// 运行中但输入框已有可入队文本时，按钮切换为「可发送」态，点击即存入待发送队列。
const showStop = computed(() => !!props.isSending && !hasQueueableInput.value);
const isReadyToSend = computed(() => (props.isSending || props.queueMessage ? canQueue.value : canSend.value));
const armed = computed(() => showStop.value || isReadyToSend.value);

const slingColors = computed(() => {
  const isDark = props.isDark !== false;
  if (showStop.value) {
    // 停止态：透明底 + 红色描边（描边色同时是图标色与呼吸光环色），与「发送」的实心黑/白键形成对比。
    return {
      padColor: 'transparent',
      borderColor: '#e11d48',
      iconColor: '#e11d48',
      accentColor: '#fb7185',
      wellColor: isDark ? '#4c0519' : '#ffe4e6',
      bandColor: '#f43f5e',
    };
  }
  if (!isReadyToSend.value) {
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
  if (showStop.value) emit('stopGeneration');
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
  contextUsageTip: contextUsageTip.value,
  hasUsage: hasContextUsage.value,
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

/**
 * 当前访问档位徽标。
 *
 * <p>档位语义随执行环境变化（本地环境没有沙箱，只读档只剩「文件工具被禁用」），
 * 所以徽标必须同时读两者，取值走 {@code accessModePresentation} 的同一份真源。</p>
 */
const accessSandboxState = computed(() => resolveSandboxState(props.envType));
const accessBadge = computed(() => ({
  label: t(resolveAccessBadgeKey(props.accessMode)),
  tip: `${t(resolveAccessTipKey(props.accessMode, accessSandboxState.value))}\n${t('chat.input.accessModeTipAction')}`,
  warn: isAccessModeMismatch(props.accessMode, accessSandboxState.value),
}));

const sendButtonSlotProps = computed<ChatInputSendButtonSlotProps>(() => ({
  isSending: showStop.value,
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
  clearImageAttachments();
  clearPastedDocuments();
});

const handleKeyDown = (e: KeyboardEvent) => {
  if (confirmationState.value.isOpen) {
    if (e.key === 'Enter') e.preventDefault();
    return;
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
      return;
    }
  }

  const isEmpty = !inputText.value;

  // Tab 补全预测指令：占位文本里写的就是这条提示，只在该「空输入框 + 有建议」时生效，
  // 不抢命令菜单的 Tab（菜单那种情况上面已 return）。
  if (e.key === 'Tab' && !e.shiftKey && !e.isComposing && isEmpty && predictionHint.value) {
    e.preventDefault();
    applyPrediction();
    return;
  }

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

  // 发送键来自个性化配置（默认 Enter）：只拦「正好等于发送组合」的那一次按键。
  // 换行不用拦 —— 只要不是发送组合，textarea 天然换行；反手拦一下才会把换行吃掉。
  if (!e.isComposing && shortcutRuntime.matches('sendMessage', e)) {
    e.preventDefault();
    handleSend();
  }
};

/**
 * 执行一次「菜单项那一档」的命令（submit 解析到命令名时用同一个入口）。
 *
 * <p>复用 `allCommands` 的 action，而不是另写一套分支：命令只有一份实现，
 * 菜单选中与 submit 解析走的是同一条路径，不会出现行为漂移。</p>
 *
 * @param commandId 命令 id（= 命令名）
 * @returns 是否命中已知命令
 */
const runUiCommand = (commandId: string): boolean => {
  const command = allCommands.value.find(item => item.id === commandId);
  if (!command) {
    return false;
  }
  command.action();
  return true;
};

/**
 * 一次「写进队列」的提交：入队（新增）与编辑（更新那一条）共用同一套收尾。
 *
 * <p>比文本很关键：请求期间用户可能已经接着打字，跟请求前的原文不一样就不能清空 ——
 * 清了等于吞掉他刚敲的内容。</p>
 */
const submitQueued = (
  submit: (text: string, requirePlan: boolean, agentId: string | number | null | undefined, images: File[]) => Promise<boolean>,
  combinedText: string,
  requirePlan: boolean,
  images: File[]
): void => {
  const original = inputText.value;
  queueSubmitting.value = true;
  void submit(combinedText, requirePlan, localSelectedAgentId.value, images).then(accepted => {
    if (!accepted || inputText.value !== original) return;
    writeInputText('');
    // 图片与文档都随这次提交交出去了：留着会让下一条消息莫名其妙带上上一张图。
    clearImageAttachments();
    clearPastedDocuments();
  }).finally(() => { queueSubmitting.value = false; });
};

const handleSend = () => {
  if (confirmationState.value.isOpen) return;
  if (isPromptOptimizationCommand(inputText.value)) {
    isCommandMenuOpen.value = false;
    void promptOptimization.optimize();
    return;
  }

  // submit 是除「显式选中菜单项」之外**唯一**允许执行命令的时机。
  // 解析放在这一层，输入过程中的任何文本写入都不会再产生副作用。
  const draft = resolveChatSendDraft(inputText.value, isPlanMode.value);

  // `/plan` 后面没有正文：只切模式并把纯命令 token 清掉（统一判据），不发空消息。
  if (draft.command === 'plan' && draft.text.trim() === '') {
    isPlanMode.value = true;
    writeInputText(resolveTextAfterCommandSelect(inputText.value));
    focusInput();
    return;
  }

  // 非 plan 的命令不是消息：执行它，把命令之后的正文原样还给用户继续编辑。
  if (draft.command !== null && draft.command !== 'plan') {
    closeCommandLayer();
    // 「不接受正文」的命令被塞了正文：拒绝执行并保留原文。吞掉正文发一次压缩，
    // 用户看到的会是「我写的要求没了，上下文却莫名其妙被压了」。
    if (hasUnexpectedCommandBody({ name: draft.command, body: draft.text })) {
      void notice(t('chat.command.compactRejectsBody'));
      focusInput();
      return;
    }
    // 菜单里找不到这个命令（白名单与菜单漂移）时，绝不能清掉用户正文 ——
    // 「解析出命令名 → 执行落空 → token 被吞」正是静默丢字的那条路径。
    if (!runUiCommand(draft.command)) {
      focusInput();
      return;
    }
    writeInputText(draft.text);
    focusInput();
    return;
  }

  // `/plan` 自身：模式切到 plan（受控 + 事件），正文照常作为本轮输入发出。
  if (draft.command === 'plan') {
    isPlanMode.value = true;
  }

  const text = draft.text.trim();
  const images = attachments.value.map(attachment => attachment.file);
  const docs = pastedDocuments.value;
  if ((!text && images.length === 0 && docs.length === 0) || props.reasoningEffortPending || queueSubmitting.value || props.isCompacting) return;

  const combinedText = composeMessageWithDocuments(text, docs);

  // 编辑态排在最前：这条本来就在队列里，提交只能是原位更新；走成「发一条新的」就是两条消息。
  if (props.editingQueued && props.updateQueuedMessage) {
    submitQueued(props.updateQueuedMessage, combinedText, draft.requirePlan, images);
    return;
  }

  if (props.isSending || props.queueMessage) {
    if (!canQueue.value || !props.queueMessage) return;
    submitQueued(props.queueMessage, combinedText, draft.requirePlan, images);
    return;
  }

  const effectiveText = combinedText || (images.length > 0 ? t('chat.input.analyzeImagesPrompt') : '');

  emit(
    'sendMessage',
    effectiveText,
    draft.requirePlan,
    localSelectedTeamId.value ? localSelectedTeamId.value : null,
    localSelectedAgentId.value ? localSelectedAgentId.value : null,
    images
  );

  writeInputText('');
  clearImageAttachments();
  clearPastedDocuments();
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
    // 宿主回填（编辑重发 / 提示词回填）只是文本替换：标成程序写入，绝不触发命令副作用。
    writeInputText(text);
  },
  setAttachedImage: (file: File | null) => {
    if (file) processImageFiles([file]);
    else clearImageAttachments();
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
  addPastedDocument,
  clearPastedDocuments
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
        data-slot="chat-input-card"
        class="group relative z-10 text-lx-fs-xl leading-[22px] [color:var(--pb-ink)] [border-radius:var(--pb-radius)] transition-all isolate before:-z-10 before:absolute before:inset-0 before:rounded-[inherit] before:content-[''] before:pointer-events-none before:[transition:opacity_500ms_ease] data-[max]:before:opacity-100 before:opacity-0 before:[background:radial-gradient(140%_120%_at_0%_100%,color-mix(in_srgb,var(--pb-spark)_26%,transparent),transparent_62%)] p-3 flex flex-col gap-2 bg-transparent border-0"
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


      <!-- 快捷指令菜单（只由输入框打 / 触发）：底边紧贴输入卡片上沿，去掉阴影 -->
      <div
        v-if="isCommandMenuOpen && filteredCommands.length > 0"
        data-testid="chat-command-menu"
        class="bottom-full z-40 absolute inset-x-0 p-1.5 [background:var(--pb-menu)] rounded-xl border border-white/[0.08] backdrop-blur-md [animation:prompt-bar-pop_180ms_cubic-bezier(0.23,1,0.32,1)_both]"
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
            :disabled="cmd.id === 'compact' && isCompacting"
            class="z-[1] relative flex items-center gap-3 px-3 py-2 rounded-lg cursor-pointer transition-colors text-xs select-none w-full text-left bg-transparent border-0 outline-none disabled:cursor-not-allowed disabled:opacity-60"
            @mouseenter="activeCommandIndex = idx"
            @click="selectCommand(cmd)"
          >
            <span class="font-medium shrink-0 min-w-18 [color:var(--pb-ink)]">
              {{ cmd.name }}
            </span>
            <span class="truncate" :class="MUTED">
              {{ cmd.id === 'compact' && isCompacting ? t('chat.compact.loading') : cmd.desc }}
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
                class="w-4 h-4 rounded-full flex items-center justify-center text-lx-fs-xs leading-none shrink-0 select-none [background:color-mix(in_srgb,var(--pb-ink)_10%,transparent)]"
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

      <p v-if="reasoningEffortError" role="alert" class="text-xs text-red-500">
        {{ reasoningEffortError }}
      </p>
      <p v-if="promptOptimization.isOptimizing.value" role="status" class="text-xs text-lx-muted">
        {{ t('chat.optimizePrompt.loading') }}
      </p>
      <!-- 压缩在途：没有这行用户就只剩一个「点了没反应」的输入区，然后反复点 -->
      <p
        v-if="isCompacting"
        role="status"
        data-testid="chat-compact-loading"
        class="flex items-center gap-1.5 text-xs text-lx-muted"
      >
        <span class="h-1.5 w-1.5 shrink-0 lx-live-dot rounded-full bg-current" aria-hidden="true" />
        {{ t('chat.compact.loading') }}
      </p>
      <p v-if="promptOptimization.error.value" role="alert" class="text-xs text-red-500">
        {{ promptOptimization.error.value }}
      </p>

      <!-- 图片与附件 Chips 栏 -->
      <div v-if="attachments.length" class="flex flex-wrap gap-1.5 pb-0.5" data-testid="image-attachments">
        <span
          v-for="(attachment, index) in attachments"
          :key="attachment.preview"
          class="inline-flex items-center gap-1.5 pr-1.5 [background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] pl-2 rounded-lg h-[28px] text-lx-fs-md motion-reduce:[animation:none] [animation:prompt-bar-pop_200ms_cubic-bezier(0.23,1,0.32,1)_both] border border-white/5"
        >
          <!-- 缩略图本身就是预览入口：@click.stop 保证不连带触发 chip 上的其它动作。
               焦点环交给 .chat-input-chip-preview（键盘用户必须看得见当前焦点在哪）。 -->
          <button
            type="button"
            class="chat-input-chip-preview inline-grid place-items-center flex-none p-0 bg-transparent border-0 rounded cursor-zoom-in text-inherit"
            :aria-label="t('chat.input.previewAttachmentNamed', { name: attachment.file.name || t('chat.input.imageAttachment') })"
            :title="t('chat.input.previewAttachmentNamed', { name: attachment.file.name || t('chat.input.imageAttachment') })"
            data-testid="image-attachment-preview"
            @click.stop="openImagePreview(attachment)"
          >
            <img
              :src="attachment.preview"
              :alt="attachment.file.name"
              class="w-4 h-4 rounded object-cover flex-none"
            />
          </button>
                    <span class="max-w-[150px] truncate text-xs">{{ attachment.file.name || t('chat.input.imageAttachment') }}</span>
          <button
            type="button"
            class="inline-grid place-items-center bg-transparent opacity-60 hover:opacity-100 p-0 hover:[background:color-mix(in_srgb,var(--pb-ink)_10%,transparent)] border-0 rounded-[5px] outline-none w-[18px] h-[18px] text-inherit cursor-pointer [transition:opacity_120ms_ease,background-color_120ms_ease]"
            :title="t('chat.input.removeAttachment')"
                        :aria-label="t('chat.input.removeAttachmentNamed', { name: attachment.file.name })"
                        @click.stop="removeImageAttachment(index)"
          >

            <HugeiconsIcon :icon="Cancel01Icon as IconArray" :size="10" :stroke-width="2.5" />
          </button>
        </span>
      </div>

      <!-- 大图预览：唯一样式与交互实现是 common/ImageLightbox（原生 dialog 自带焦点陷阱与 Esc 关闭） -->
      <ImageLightbox
        v-if="previewingAttachment"
        :open="isImagePreviewOpen"
        :src="previewingAttachment.src"
        :name="previewingAttachment.name"
        test-id="image-attachment-lightbox"
        @close="closeImagePreview"
      />
      <div class="text-xs text-lx-muted" aria-live="polite">
                <span v-if="limitsLoading">{{ t('chat.input.readingImageLimit') }}</span>
        <span v-else-if="limitsError" class="text-red-500">{{ limitsError }}
          <button type="button" class="ml-2 underline" @click="loadLimits">{{ t('common.retry') }}</button>
        </span>
        <span v-else-if="attachments.length">{{ t('chat.input.selectedImages', { count: attachments.length, max: maxImages ?? 0 }) }}</span>
        <p v-if="attachmentError" class="text-red-500" role="alert">{{ attachmentError }}</p>
      </div>

      <!-- 粘贴文档小卡片栏 -->
      <div v-if="pastedDocuments.length" class="flex flex-wrap gap-1.5 pb-0.5" data-testid="pasted-documents">
        <PastedDocumentCard
          v-for="(doc, index) in pastedDocuments"
          :key="doc.id"
          :document="doc"
          :is-dark="isDark"
          @preview="openDocumentPreview(doc)"
          @remove="removePastedDocument(index)"
          @expand="expandDocumentToInput(doc)"
        />
      </div>

      <!-- 文本输入区 -->
      <div class="flex items-start gap-1.5 w-full min-w-0">
        <!-- 模式徽标与协作徽标同一套蓝色底色：两者都是「这一轮带什么意图」的标记，
             用两种颜色反而要用户去记哪块是模式、哪块是团队 -->
        <span
          v-if="isPlanMode"
          data-testid="chat-input-plan-badge"
          class="text-blue-400 font-medium text-xs leading-[22px] shrink-0 select-none cursor-pointer hover:opacity-80 px-1.5 rounded bg-blue-500/15 whitespace-nowrap"
          :title="t('chat.input.exitPlanTip')"
          @click.stop="isPlanMode = false"
        >
          /plan
        </span>

        <span
          v-if="currentTeamName"
          data-testid="chat-input-team-badge"
          class="inline-flex items-center gap-1 px-1.5 rounded bg-blue-500/15 text-blue-400 font-medium text-xs leading-[22px] shrink-0 select-none cursor-pointer hover:opacity-80 whitespace-nowrap"
          :title="t('chat.input.switchTeamTip')"
          @click.stop="openPlusMenu('teams')"
        >
          <span class="max-w-[10rem] truncate">👥 {{ currentTeamName }}</span>
          <span
            class="hover:text-red-400 hover:bg-black/10 dark:hover:bg-white/10 rounded-full w-3.5 h-3.5 flex items-center justify-center text-xs leading-none transition"
            :title="t('chat.input.exitTeamTip')"
            @click.stop="clearSelectedTeam"
          >×</span>
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
            class="chat-text-input w-full text-lx-fs-xl leading-[22px] [color:var(--pb-ink)] [caret-color:var(--pb-ink)] cursor-text select-text"
            @focus="effortOpen = false"
            @beforeinput="handleBeforeInput"
            @keydown="handleKeyDown"
          />
        </div>
      </div>

      <!-- 底部工具栏行：允许换行。右侧面板夹紧后对话列最窄 400px（见 utils/chatColumnLayout），
           工具组合计约 450px 放不进一行 —— nowrap 会把整张卡片撑破、按钮被列裁掉 -->
      <div class="flex items-center justify-between pt-1 flex-wrap gap-x-2 gap-y-1.5 min-w-0">
        <!-- 左侧工具组：+ 分组菜单（添加文件 / 模式 / 协作 / 技能 / MCP）、图片附件、Effort 强度 -->
        <div class="flex items-center gap-1 flex-nowrap shrink min-w-0">
          <!-- + 按钮 -->
          <!-- 菜单锚在这个容器上：底边与「+」按钮上沿齐平，而不是贴输入卡片的上沿 -->
          <div class="relative inline-flex shrink-0">
            <button
              type="button"
              :class="ICON_BTN"
              :aria-label="t('chat.input.quickCommandsTip')"
              :aria-expanded="isPlusMenuOpen"
              :data-on="isPlusMenuOpen ? '' : undefined"
              :title="t('chat.input.quickCommandsTip')"
              @mousedown.prevent
              @click="handlePlusClick"
            >
              <HugeiconsIcon :icon="PlusSignIcon as IconArray" :size="16" :stroke-width="2" />
            </button>

            <!-- 「+」分组菜单：添加文件 / 模式 / 协作 / 技能 / MCP；二级浮层由子组件贴合各自分组行 -->
            <ChatInputPlusMenu
              v-if="isPlusMenuOpen"
              :is-dark="isDark"
              :is-plan-mode="isPlanMode"
              :teams="plusMenuTeams"
              :selected-team-id="localSelectedTeamId"
              :skills="skillList.skills.value"
              :skills-loading="skillList.isLoading.value"
              :skills-error="skillList.loadError.value"
              :mcp-servers="mcpServers"
              :mcp-states="mcpStates"
              :mcp-loading="mcpLoading"
              :mcp-error="mcpError"
              :mcp-busy="mcpBusy"
              :initial-group="plusMenuInitialGroup"
              @upload-image="triggerUpload"
              @update-plan-mode="handlePlusUpdatePlanMode"
              @select-team="handlePlusSelectTeam"
              @create-team="handlePlusCreateTeam"
              @select-skill="handlePlusSelectSkill"
              @open-mcp-settings="handleOpenMcpSettings"
              @toggle-mcp="handlePlusToggleMcp"
              @reconnect-mcp="handlePlusReconnectMcp"
              @open-group="loadPlusGroup"
            />
          </div>

          <!-- 隐藏的文件输入：入口只剩「+」菜单的「添加文件」，工具栏不再挂第二个上传按钮 -->
          <input
            ref="fileInputRef"
            type="file"
            accept="image/*"
            multiple
            class="hidden"
            @change="handleFileChange"
          />

          <!-- 团队选择已收进 + 菜单的「协作」分组：输入区不再常驻一个下拉，给写作留出宽度 -->

          <!-- Effort 思考强度：弹层锚在这个 wrapper 上（bottom-full 紧贴按钮上沿），
               配色/圆角与「+」分组菜单同一套，不再挂在卡片容器上偏移 8px -->
          <span class="relative inline-flex shrink-0">
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

            <div
              v-if="effortOpen"
              class="bottom-full z-50 absolute left-0 w-[236px] p-3 origin-bottom-left rounded-[14px] border backdrop-blur-md [background:color-mix(in_srgb,var(--pb-menu)_95%,transparent)] [animation:prompt-bar-pop_180ms_cubic-bezier(0.23,1,0.32,1)_both] motion-reduce:[animation:none]"
              :class="isDark !== false ? 'border-white/[0.08] text-zinc-200' : 'border-zinc-200 text-zinc-800'"
              role="dialog"
              aria-label="Effort"
            >
              <div class="flex items-center gap-2 text-lx-fs-lg leading-[18px]">
                <span :class="MUTED">{{ t('chat.input.reasoningEffort') }}</span>
                <span class="font-medium">{{ level }}</span>
                <span v-if="reasoningEffortPending" role="status" class="text-xs" :class="MUTED">{{ t('chat.input.syncing') }}</span>
                <span class="inline-flex ml-auto cursor-help" :class="MUTED" :title="t('chat.input.effortTip')">
                  <HugeiconsIcon :icon="HelpCircleIcon as IconArray" :size="14" :stroke-width="1.8" />
                </span>
              </div>
              <div class="flex justify-between mt-3 text-lx-fs-md leading-4" :class="MUTED">
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
          </span>

          <!-- 当前访问档位：边界必须常驻可见，不能只藏在安全中心里；
               本地+只读是唯一会让人误以为「已被保护」的组合，单独染色警示。
               点击展开三档上拉框，选中即落到 userConfig（与安全中心同一处真源）。 -->
          <span class="relative inline-flex">
            <button
              type="button"
              class="inline-flex h-7 flex-none cursor-pointer touch-manipulation items-center gap-1 rounded-lg border-0 bg-transparent px-2 text-lx-fs-md font-medium outline-none select-none whitespace-nowrap [font:inherit] [-webkit-tap-highlight-color:transparent] [transition:background-color_150ms_ease,color_150ms_ease]"
              :class="[
                accessBadge.warn
                  ? 'text-amber-500 bg-amber-500/10'
                  : 'text-lx-muted [@media(hover:hover)_and_(pointer:fine)]:hover:[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)]',
                isAccessMenuOpen ? '[background:color-mix(in_srgb,var(--pb-ink)_8%,transparent)] [color:var(--pb-ink)]' : ''
              ]"
              data-testid="chat-access-mode"
              :data-mode="props.accessMode ?? ''"
              :data-warn="accessBadge.warn ? '' : undefined"
              :aria-label="accessBadge.label"
              :aria-expanded="isAccessMenuOpen"
              :title="accessBadge.tip"
              @mousedown.prevent
              @click="toggleAccessMenu"
            >
              <span>{{ accessBadge.label }}</span>
              <svg
                class="w-3 h-3 shrink-0 opacity-70 transition-transform duration-200"
                :class="isAccessMenuOpen ? 'rotate-180' : ''"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2.2"
                aria-hidden="true"
              >
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 15l6-6 6 6" />
              </svg>
            </button>

            <ChatInputAccessMenu
              v-if="isAccessMenuOpen"
              :is-dark="isDark"
              :access-mode="accessMode"
              :env-type="envType"
              @select="handleSelectAccessMode"
              @open-security="handleOpenSecurity"
            />
          </span>
        </div>

        <!-- 右侧工具组：上下文用量环、模型选择、语音听写、Morphing 发送按钮 -->
        <div class="flex items-center gap-1.5 shrink-0">
          <!-- 上下文用量指示器：常驻（未采集时不卸载，只画空环）；仅悬浮于圆环图标时触发浮层 -->
          <div
            class="relative inline-flex h-7 items-center justify-center select-none cursor-help mr-0.5"
            :class="MUTED"
            :data-has-usage="hasContextUsage ? '' : undefined"
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

    <!-- 文档小卡片全文预览弹窗 -->
    <PastedDocumentPreviewModal
      :open="isDocumentPreviewOpen"
      :document="previewingDocument"
      :is-dark="isDark"
      @close="closeDocumentPreview"
      @expand="previewingDocument && expandDocumentToInput(previewingDocument)"
    />
  </div>
</template>

<style>
/* 附件 chip 的缩略图预览入口：键盘聚焦时必须能看见焦点。 */
.chat-input-chip-preview:focus-visible {
  outline: 2px solid var(--pb-ink);
  outline-offset: 2px;
}

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
  font-size: var(--lx-font-size-xl);
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
