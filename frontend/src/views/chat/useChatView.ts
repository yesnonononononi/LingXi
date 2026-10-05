import { ref, type Ref, watch, computed, onMounted, onBeforeUnmount, provide } from 'vue';
import { chatApi, UserConfigAPI, SessionAPI } from '../../services/api';
import { isOk, toPositiveInt } from '../../utils/api';
import { buildSessionDisplayMessages, resolveSessionSending } from '../../utils/sessionRunState';
import type { ChatSession, ModelConfig, ChatMessage, WorkspaceVO, WorkspaceRequest, AgentAccessMode, SubSessionVO, ChatTurn, ToolCallVO, ResendCommandAcceptanceVO } from '../../types/chat';
import { useChatScroll } from './useChatScroll';
import { useChatHistory } from './useChatHistory';
import { attachStreamV3, detachStreamV3, type StreamV3Session } from '../../services/streamV3Sync';
import { projectSessionMessages } from './messageProjection';
import { useStreamV3Store } from '../../stores/streamV3Store';
import { resolveExecutionTerminal } from '../../utils/streamV3';
import { buildSessionMarkdown, groupMessagesByTurn } from '../../utils/session';
// SSE 会话级事件流中心（pinia）：连接归属收进 store，断线自愈 + 重挂提示。
// 它补的是请求级流的结构性缺口：终态之后事件无订阅者、子会话事件依赖「恰好开着的请求级流」。
import { useSseRouterStore } from '../../stores/sseRouter';
import { useChatSessionStore } from '../../stores/chatSessionStore';

import { useTheme } from '../../composables/useTheme';
import { useReasoningEffort } from '../../composables/useReasoningEffort';
import { CHAT_INPUT_FOCUS_KEY } from '../../composables/useChatInputFocus';
import { isPersistedSessionId, isTempSessionId, createLocalId } from '../../utils/ids';
import { normalizeAccessMode, normalizeSettingsTab, type SettingsTabKey } from '../../utils/enum';
import { sendDesktopNotification, isAppInactive, isElectron, openDirectoryPicker } from '../../utils/platform';
import { extractDirName } from '../../utils/path';
// 会话树水合：由后端 runStatus + lastOutcome 派生展示态（唯一来源，前端不再猜测）
import { toSubItemStatus } from '../../utils/subSessionStatus';

// 主题：接入全局共享主题状态（与登录页/模型页共用偏好）
import type ChatInputArea from '../../components/chat/ChatInputArea.vue';
import type ScrollCursorLoader from '../../components/common/ScrollCursorLoader.vue';
import type ChatMessageList from '../../components/chat/ChatMessageList.vue';
import type { SubSessionItem } from '../../components/chat/SubAgentSidePanel.vue';

export interface ChatViewProps {
  sessions?: ChatSession[];
  activeSessionId?: string | null;
  models?: ModelConfig[];
  selectedModelId?: string | number;
  enabledTools?: string[];
  activeSession?: ChatSession | null;
  workspaces?: WorkspaceVO[];
  activeWorkspaceId?: string | number | null;
  accessMode?: AgentAccessMode | string;
}

export type ChatViewEmits = {
  (e: 'selectSession', id: string): void;
  (e: 'newSession', workspaceId?: string | number | null): void;
  (e: 'deleteSession', id: string): void;
  (e: 'renameSession', id: string, name: string): void;
  (e: 'updateModel', modelId: string | number): void;
  (e: 'updateAccessMode', mode: AgentAccessMode): void;
  (e: 'updateTools', tools: string[]): void;
  (e: 'sendMessage', text: string, isDeepThink: boolean, isHybridSearch: boolean, requirePlan: boolean, teamId?: string | number | null, agentId?: string | number | null, imageFile?: File | null): void;
  (e: 'updateTeam', teamId: string | number | null): void;
  (e: 'switchBranch', messageId: string, index: number): void;
  (e: 'toggleTool', toolId: string): void;
  (e: 'toggleTheme'): void;
  (e: 'openSettings'): void;
  (e: 'clearSessions'): void;
  (e: 'selectWorkspace', workspace: WorkspaceVO | null): void;
  (e: 'newWorkspace'): void;
  (e: 'deleteWorkspace', id: string | number): void;
};

export interface ChatViewTemplateRefs {
  inputAreaRef?: Ref<InstanceType<typeof ChatInputArea> | null>;
  messagesContainerRef?: Ref<InstanceType<typeof ScrollCursorLoader> | InstanceType<typeof ChatMessageList> | any>;
}

export function useChatView(props: ChatViewProps, emit: ChatViewEmits, templateRefs?: ChatViewTemplateRefs) {
const { isDark: sharedIsDark, toggleTheme: toggleSharedTheme } = useTheme();





/**
 * 统一登记组件内所有 `setTimeout`，卸载时一并清理：
 * 避免路由切走后回调仍触发（改动已销毁组件的状态），也避免流式期间定时器堆积。
 * 新增定时器请一律通过 scheduleTimeout 登记，不要再直接调用裸 setTimeout。
 */
const pendingTimers = new Set<number>();
const scheduleTimeout = (handler: () => void, delayMs: number): number => {
  const id = window.setTimeout(() => {
    pendingTimers.delete(id);
    handler();
  }, delayMs);
  pendingTimers.add(id);
  return id;
};


// 内置 fallback 独立响应式状态 (当无父组件透传时生效)
const localSessions = ref<ChatSession[]>([]);
const localActiveId = ref<string | null>(null);
const localModels = ref<ModelConfig[]>([]);
const localWorkspaces = ref<WorkspaceVO[]>([]);
const localActiveWorkspaceId = ref<string | number | null>(null);
const localSelectedModel = ref<string | number>('');
const localAccessMode = ref<AgentAccessMode>('IN_WORKSPACE');
const {
  reasoningEffort,
  reasoningEffortPending,
  reasoningEffortError,
  syncReasoningEffort,
  handleUpdateReasoningEffort,
} = useReasoningEffort();
// 上下文上限（common_config.max_tokens，经 /config/current 下发）：CONTEXT_UPDATE 事件未带
// maxTokens 时的兜底上限；tokenCount 只来自运行时事件，绝不本地伪造
const contextMaxTokensFromConfig = ref<number | null>(null);
const chatSessionStore = useChatSessionStore();
/**
 * 发送失败的独立界面状态。
 *
 * <p><b>为什么不是一条消息</b>：受理失败意味着命令没有进入执行 —— 没有轮次、没有落库行，
 * 无从归属到任何回答组。塞进消息表会让「消息」承载两种互斥语义（落库事实 vs 界面提示），
 * 还得靠 id 伪装成气泡。这里作为独立状态渲染成横幅，可手动关闭；下次发送成功即清除。</p>
 */
const sendFailureNotice = ref<{ sessionId: string; message: string } | null>(null);
const dismissSendFailure = (): void => { sendFailureNotice.value = null; };
const localSelectedTeamId = ref<string | number | null>(null);
const localSelectedAgentId = ref<string | number | null>(null);

const isWorkspaceModalOpen = ref(false);
const isTeamModalOpen = ref(false);
const isSubSessionsOverviewOpen = ref(false);
const selectedSubSessionForDetail = ref<SubSessionVO | null>(null);
const isSubSessionDetailOpen = ref(false);

// 右侧子代理侧边栏面板及选项切换状态
const isSubPanelOpen = ref(false);
const activeViewingSubSessionId = ref<string | number | null>(null);
/**
 * 子会话执行摘要表：键 = 子会话 id，值 = 该子会话已加载的 executionId → 摘要。
 * 与主会话的 session.executions 同构，供子会话历史渲染按 executionId 绑定执行元信息。
 */
const isLoadingSubMessages = ref(false);
/** 子会话消息加载失败态：用于区分「加载失败」与「确实为空」 */
const subMessagesError = ref('');
/** 子会话游标分页映射表：记录各子会话的 hasMore 与 nextCursor */
const subSessionPaginationMap = ref<Record<string, { hasMore: boolean; nextCursor: string | null }>>({});
const isLoadingMoreSubMessages = ref(false);
const subHistoryLoadError = ref('');

const hasMoreSubMessages = computed(() => {
  if (activeViewingSubSessionId.value === null) return false;
  const key = String(activeViewingSubSessionId.value);
  return !!subSessionPaginationMap.value[key]?.hasMore;
});
/** 初始化数据（会话/模型/工作空间）加载失败态：区分「加载失败」与「确实为空」 */
const initLoadError = ref('');
/** 会话详情加载失败态：区分「加载失败」与「确实为空」 */
const sessionLoadError = ref('');

const handleOpenSubSessionDetailFromOverview = (sub: SubSessionVO) => {
  selectedSubSessionForDetail.value = sub;
  isSubSessionDetailOpen.value = true;
};

const handleOpenTeamModal = () => {
  isTeamModalOpen.value = true;
};

/**
 * 团队下拉框选中变化的唯一同步入口。
 *
 * <p>团队是<b>会话绑定</b>（{@code session.team_id}），不再是请求级参数：聊天请求已不带 teamId，
 * 后端一律按会话记录解析本轮编排身份。因此这里必须把选中值同步落库，否则选完立刻发消息，
 * 后端仍按旧绑定（或非团队）编排，表现为「选了团队却不委派」。</p>
 *
 * <p>落库时机：仅当存在已入库的会话时；空会话（未创建/临时会话）先只更新本地状态，
 * 等创建会话时随 {@code /session/create} 一并绑定 —— 对一个还不存在的会话换绑无从谈起。</p>
 */
const handleUpdateTeam = async (teamId: string | number | null) => {
  localSelectedTeamId.value = teamId;
  // 团队与单 Agent 直聊互斥（与输入区内的一致性保持一致）
  if (teamId) localSelectedAgentId.value = null;

  const activeId = displayActiveId.value;
  if (!activeId || isTempSessionId(activeId)) return;

  try {
    const res = await SessionAPI.bindTeam(activeId, teamId);
    if (!isOk(res.code)) {
      // 同步失败不许静默：输入区会显示成已选团队，而实际绑定没落库，属于「界面骗人」。
      console.error('同步会话团队绑定失败:', res.errMsg);
      return;
    }
    // 回写本地会话条目：会话树/侧栏等读取 teamId 的地方随之更新。
    // 受控分支（props.sessions）由父组件持有数据，只 emit 通知，不越权改写。
    if (!props.sessions) {
      const idx = localSessions.value.findIndex(s => String(s.id) === String(activeId));
      if (idx !== -1) {
        localSessions.value[idx] = {
          ...localSessions.value[idx],
          teamId: teamId === null || teamId === '' ? null : String(teamId),
        };
      }
    } else {
      emit('updateTeam', teamId);
    }
  } catch (err) {
    console.error('同步会话团队绑定异常:', err);
  }
};

const handleTeamCreated = async (newTeamId?: number | string) => {
  if (inputAreaRef.value?.fetchTeams) {
    await inputAreaRef.value.fetchTeams();
  }
  if (newTeamId) {
    // 与下拉框选择走同一条同步链路：本地状态 + 后端会话绑定一起落位
    await handleUpdateTeam(newTeamId);
  }
};

const displaySessions = computed(() => props.sessions ?? localSessions.value);
const displayActiveId = computed(() => props.activeSessionId ?? localActiveId.value);
const displayModels = computed(() => props.models ?? localModels.value);
const displayWorkspaces = computed(() => props.workspaces ?? localWorkspaces.value);
const displayActiveWorkspaceId = computed(() => props.activeWorkspaceId ?? localActiveWorkspaceId.value);
const displayAccessMode = computed(() => props.accessMode ?? localAccessMode.value);
const displaySelectedModel = computed(() => props.selectedModelId ?? localSelectedModel.value);
const displayIsDark = computed(() => sharedIsDark.value);

const currentActiveSession = computed(() => {
  if (props.activeSession !== undefined) return props.activeSession;
  return localSessions.value.find(s => s.id === localActiveId.value) || null;
});

const messagesContainerRef = templateRefs?.messagesContainerRef ?? ref<InstanceType<typeof ScrollCursorLoader> | null>(null);
const lastKnownFirstMsgId = ref<string | null>(null);
const lastKnownLastMsgId = ref<string | null>(null);

const {
  isNearBottom,
  handleMessagesScroll,
  handleMessagesWheel,
  handleTouchStart,
  handleTouchMove,
  scrollToBottomForce,
  scrollToBottomIfAuto,
  scrollToBottom,
  handleScrollToBottomClick,
} = useChatScroll({ messagesContainerRef });

const {
  isLoadingMoreHistory,
  historyLoadError,
  handleLoadMoreHistory,
  handleRetryLoadMoreHistory,
  reconcileSessionAfterStream,
  seedContextUsageFromTree,
} = useChatHistory({
  currentActiveSession,
  localSessions,
  messagesContainerRef,
  scheduleTimeout,
});

/**
 * 聚合提取当前会话中的所有子代理项（用于右侧子代理轨迹与标签面板）。
 *
 * <p><b>批次 A 起来源是 v3 状态源</b>，不再读 `session.subSessions` / `session.messages`：</p>
 * <ol>
 *   <li><b>会话实体</b>：子会话行落库时后端就发 `SESSION_UPDATED`（带 rootSessionId），
 *       到达即入 `sessions` 槽 —— 所以「子会话信息还没到」不会阻塞任何响应入库，
 *       事件本来就带会话身份，先按身份存，名字晚到只是这一栏稍后补上；</li>
 *   <li><b>委派卡片</b>：`DELEGATION` 卡（同样是 v3 的 `TOOL_CALL_UPDATED`）带
 *       `content.subSessionId`，即 toolCallId → 子会话的关联，用来补子代理名与任务描述。</li>
 * </ol>
 * 两条都不需要通知后逐卡回查，也不需要事件驱动的会话树回查。
 */
const availableSubSessionItems = computed<SubSessionItem[]>(() => {
  const session = currentActiveSession.value;
  const rootId = resolveRootSessionId(session);
  if (!rootId) return [];

  const map = new Map<string, SubSessionItem>();

  // 1. 会话实体：本根会话下的全部子会话。
  for (const vo of streamV3.sessions.values()) {
    if (vo?.id == null) continue;
    const id = String(vo.id);
    if (id === rootId) continue;
    const declaredRoot = vo.rootSessionId != null ? String(vo.rootSessionId) : null;
    if (declaredRoot !== rootId) continue;
    map.set(id, {
      id: vo.id,
      agentId: vo.agentId,
      agentName: vo.name || (vo.agentId ? `Agent #${vo.agentId}` : '子代理'),
      task: vo.name || '',
      status: toSubItemStatus(vo.runStatus, vo.lastOutcome),
      subSession: vo as SubSessionVO,
      tc: undefined
    });
  }

  // 2. 委派卡片：补关联（toolCallId ↔ subSessionId）、子代理名与任务描述。
  for (const tool of streamV3.tools.values()) {
    const content = resolveObject(tool.content);
    const kind = content ? String(content.kind ?? '').trim().toUpperCase() : '';
    if (kind !== 'DELEGATION') continue;
    const subSessionId = content?.subSessionId != null ? String(content.subSessionId) : '';
    if (!subSessionId) continue;
    const existing = map.get(subSessionId);
    const agentName = tool.title || existing?.agentName || '子代理';
    const task = content?.text != null && String(content.text) ? String(content.text) : (existing?.task || '');
    map.set(subSessionId, {
      id: existing?.id ?? subSessionId,
      agentId: existing?.agentId,
      agentName,
      task,
      result: resolveToolResultText(tool) ?? existing?.result,
      status: existing?.status ?? 'running',
      subSession: existing?.subSession,
      tc: undefined
    });
  }

  return Array.from(map.values());
});

/** 取 JSON 对象形态的载荷；非对象（字符串/null/数组）返回 null。 */
function resolveObject(value: unknown): Record<string, any> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, any>;
}

/** 工具实体的结果文本（委派卡展示用）；无输出返回 null。 */
function resolveToolResultText(tool: ToolCallVO): string | undefined {
  const output = resolveObject(tool.rawOutput);
  if (!output) return undefined;
  const value = output.output !== undefined ? output.output : output.stdout;
  if (value == null) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** 当前正在查看的子代理详情 */
const activeViewingSubSession = computed(() => {
  if (activeViewingSubSessionId.value === null) return null;
  return availableSubSessionItems.value.find(it => String(it.id) === String(activeViewingSubSessionId.value)) || null;
});

/**
 * 左侧当前展示的消息列表（恒定锁定根会话展示，不被子会话替换）。
 *
 * <p><b>批次 A 起，消息内容唯一来源是 v3 状态源</b>：{@link projectSessionMessages} 从
 * `streamV3Store`（持久化历史行 + 未提交活响应 + 工具实体 + 轮次摘要）派生出 `ChatMessage[]`。
 * `chatSessionStore` 不再持有消息正文，避免双源竞争。依赖追踪落在 v3 各槽的浅引用上 ——
 * 单帧 delta 只替换对应响应槽，触发一次轻量重算，不深拷贝全部实体。</p>
 *
 * <p>运行态占位气泡（sending 且最后一条不是 user 时补一个 assistant 骨架）仍复用
 * {@link buildSessionDisplayMessages} 的判定，但骨架挂在**派生的消息数组**上，不读 `session.messages`。</p>
 */
/** 解析会话的根会话 id：root_session_id == 0/null 表示自身即根（与后端同一口径）。 */
const resolveRootSessionId = (session: ChatSession | null | undefined): string | null => {
  if (!session) return null;
  const id = String(session.id);
  if (isTempSessionId(id)) return null;
  const declared = session.rootSessionId != null ? String(session.rootSessionId) : null;
  return declared && declared !== '0' ? declared : id;
};

const displayedMessages = computed<ChatMessage[]>(() => {
  const session = currentActiveSession.value;
  const rootId = resolveRootSessionId(session);
  if (!rootId) return buildSessionDisplayMessages(session);

  const derived = projectSessionMessages(rootId);
  // RUNNING 且最后一条不是 user：补一个进行中骨架，避免「已发送但首个事件未到」时的空窗。
  if (session?.runStatus === 'RUNNING' && derived.length > 0) {
    const last = derived[derived.length - 1];
    if (last.role === 'user') {
      return [...derived, {
        id: `running-${rootId}-${last.id ?? 'pending'}`,
        role: 'assistant',
        content: '',
        timestamp: last.timestamp ?? Date.now(),
        turnId: last.turnId,
        isThinking: true,
        isExploring: true,
        isComplete: false,
      }];
    }
  }
  return derived;
});

/**
 * 上下文用量指示器数据（输入框模型选择器左侧展示）。
 *
 * <p>数据来源（充分利用既有通道，不伪造）：</p>
 * <ul>
 *   <li>usedTokens / ratio：运行时 `CONTEXT_UPDATE` 事件（UPDATE / SQUEEZE_STARTED / SQUEEZE_COMPLETED
 *       三相都携带 usage），由 messageRouter 落入 chatSessionStore 的按会话用量表；</li>
 *   <li>maxTokens：优先事件自带 usage.maxTokens，缺失时回落 common_config.max_tokens
 *       （/config/current 下发，loadInitialData 时快照）；</li>
 *   <li>会话尚未收到任何上下文事件（如新会话）→ null，指示器隐藏 —— 绝不显示伪造的 0。</li>
 * </ul>
 */
const contextUsageIndicator = computed<{
  usedTokens: number;
  maxTokens: number | null;
  ratio: number | null;
  phase: string;
  message: string;
} | null>(() => {
  const sid = currentActiveSession.value?.id;
  if (!sid) return null;
  const usage = chatSessionStore.getContextUsage(sid);
  const used = usage?.tokenCount;
  if (used == null || used <= 0) return null;
  return {
    usedTokens: used,
    maxTokens: usage?.maxTokens ?? contextMaxTokensFromConfig.value,
    ratio: usage?.ratio ?? null,
    phase: usage?.phase ?? '',
    message: usage?.message ?? ''
  };
});

/**
 * 当前选中的子会话消息列表（供右侧卡片式子会话面板渲染）。
 *
 * <p>与主聊天**共用同一个适配层**，只是传入的视图会话不同：子面板读子会话正文，
 * 主聊天读根会话正文。子会话不再维护自己的一份消息表 —— 事件本来就都从同一条根会话
 * v3 连接进来，按事件自身 sessionId 入同一个 store，谁渲染就取谁的切片。</p>
 */
const activeSubSessionMessages = computed<ChatMessage[]>(() => {
  if (activeViewingSubSessionId.value === null) return [];
  const rootId = resolveRootSessionId(currentActiveSession.value);
  if (!rootId) return [];
  return projectSessionMessages(rootId, activeViewingSubSessionId.value);
});

/** 当前选中的子会话完整 VO 对象 */
const activeViewingSubSessionVO = computed<SubSessionVO | null>(() => {
  if (activeViewingSubSessionId.value === null) return null;
  const key = String(activeViewingSubSessionId.value);
  const found = availableSubSessionItems.value.find(it => String(it.id) === key);
  if (found?.subSession) return found.subSession;
  // 兜底直接读 v3 会话槽（子会话实体随 SESSION_UPDATED 到达）。
  const fromV3 = streamV3.getSession(key);
  if (fromV3) return fromV3 as SubSessionVO;
  if (currentActiveSession.value?.subSessions) {
    const fromTree = currentActiveSession.value.subSessions.find(s => String(s.id) === key);
    if (fromTree) return fromTree;
  }
  return null;
});

const lastAssistantIndex = computed(() => {
  const msgs = displayedMessages.value;
  if (!msgs || msgs.length === 0) return -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') return i;
  }
  return -1;
});

/**
 * 消息 → 所属回答组的执行摘要 / 是否组尾 映射（主会话渲染用）。
 *
 * <p>组以 executionId 为唯一键（{@link groupMessagesByTurn}，主会话与子会话共用同一规则）；
 * 执行摘要来自会话的 executions 表。仅**组尾**展示一次执行元信息，避免「同一执行跨页」
 * 时两个部分组各挂一次。旧数据（executionId 为 null 或摘要缺失）execution 为 null，
 * 渲染层据此隐藏统计，绝不伪造为 0。</p>
 */
const messageTurnMap = computed(() => {
  const map = new Map<string, { turn: ChatTurn | null; isGroupTail: boolean }>();
  for (const group of groupMessagesByTurn(displayedMessages.value)) {
    const turn = group.turnId ? streamV3.getTurn(group.turnId) ?? null : null;
    const lastIdx = group.messages.length - 1;
    group.messages.forEach((m, i) => {
      map.set(m.id, { turn, isGroupTail: i === lastIdx });
    });
  }
  return map;
});

/**
 * 子会话消息 → 所属回答组执行摘要 / 是否组尾 映射（右侧子会话面板渲染用）。
 * 与主会话同一分组规则；轮次摘要直接读 v3 `turns` 槽（与主聊天同一份权威）。
 */
const activeSubSessionTurnMap = computed(() => {
  const map = new Map<string, { turn: ChatTurn | null; isGroupTail: boolean }>();
  if (activeViewingSubSessionId.value === null) return map;
  for (const group of groupMessagesByTurn(activeSubSessionMessages.value)) {
    const turn = group.turnId ? streamV3.getTurn(group.turnId) ?? null : null;
    const lastIdx = group.messages.length - 1;
    group.messages.forEach((m, i) => {
      map.set(m.id, { turn, isGroupTail: i === lastIdx });
    });
  }
  return map;
});

const hasMessages = computed(() => !!displayedMessages.value?.length || isLoadingCurrentSession.value);

watch(displayedMessages, (newMsgs) => {
  if (isLoadingMoreHistory.value) return;
  if (!newMsgs || newMsgs.length === 0) return;

  const firstId = newMsgs[0]?.id;
  const lastId = newMsgs[newMsgs.length - 1]?.id;

  // 如果最后一条消息没有改变，但第一条消息改变了，说明是触顶拉取历史消息前置插入，绝对不滚到底部
  if (lastKnownLastMsgId.value && lastId === lastKnownLastMsgId.value && firstId !== lastKnownFirstMsgId.value) {
    lastKnownFirstMsgId.value = firstId;
    return;
  }

  const isNewMessageAdded = lastKnownLastMsgId.value !== lastId;
  lastKnownFirstMsgId.value = firstId;
  lastKnownLastMsgId.value = lastId;

  // 新增了一条消息（如用户刚发出的新消息），强制滚动
  if (isNewMessageAdded && newMsgs[newMsgs.length - 1]?.role === 'user') {
    scrollToBottomForce();
  } else {
    // 渲染输出过程中的流式更新：尊重用户当前的滚动意图，仅在未向上滚动时自动吸底
    scrollToBottomIfAuto();
  }
});


/**
 * 切换项目目录按钮只能存在于没有任何消息记录的新会话
 */
const canChangeWorkspace = computed(() => {
  // 处于子代理详情查看模式下，不允许切换项目目录
  if (activeViewingSubSessionId.value !== null) return false;
  // 处于会话历史加载中时，不展示按钮以消除闪烁
  if (isLoadingCurrentSession.value || isLoadingSubMessages.value) return false;
  // 存在任何消息记录时，不允许切换项目目录（v3 派生视图是真源）
  if (displayedMessages.value.length > 0) return false;
  return true;
});

const isLoadingCurrentSession = ref(false);

/**
 * 切换子代理 Option 选项：将左侧会话历史切换为子 Agent 的。
 *
 * <p>子会话正文不进本地消息表：拉到的历史页写进 v3 store 的对应会话槽，视图由适配层派生。
 * 打开面板只拉**一次**首屏分页；实时增量本来就在同一条根会话 v3 连接上，不需要额外订阅。</p>
 */
const handleSelectSubSessionOption = async (subId: string | number | null) => {
  if (subId === null) {
    activeViewingSubSessionId.value = null;
    scrollToBottomForce();
    return;
  }

  activeViewingSubSessionId.value = subId;
  const key = String(subId);

  // 已装载过首屏就短路（v3 槽即权威）；未装载则拉一次分页补齐。
  if (streamV3.isHistoryLoaded(key)) {
    scrollToBottomForce();
    return;
  }

  isLoadingSubMessages.value = true;
  subMessagesError.value = '';
  // 发起时快照代际：重发会推进代际，返回的旧页不得灌回 v3 历史槽。
  const expectedRevision = streamV3.currentHistoryRevision(key);
  try {
    // 契约 §6：子会话已由后端持久化（CallSubAgentTool 落 user 消息 + SessionAggregateService 支持按 id 分页），
    // 因此按 subSessionId 拉取真实消息渲染，**不再**用工具调用记录合成假对话/伪造时间戳。
    const isRealSessionId = isPersistedSessionId(subId);
    if (isRealSessionId) {
      const pageResult = await chatApi.fetchSessionMessages(subId, null, 30);
      if (!pageResult.ok) {
        subMessagesError.value = pageResult.error;
        return;
      }
      // 首屏 = 该子会话的同代际合并（快照缺行不等于行被删除），过期代际整体丢弃。
      const subApplied = streamV3.ingestHistoryPage(key, pageResult.data, expectedRevision);
      if (subApplied) {
        subSessionPaginationMap.value[key] = {
          hasMore: pageResult.data.hasMore,
          nextCursor: pageResult.data.nextCursor
        };
      }
    } else {
      // 面板项带着本地 id（如 tool-xxx）时无法查询后端历史，如实展示为空（模板显示「暂无消息」）
      subSessionPaginationMap.value[key] = { hasMore: false, nextCursor: null };
    }
  } catch (err) {
    // 失败不再静默（否则用户看到空白会误以为「该子会话没有消息」）：保留可见失败态并可重试
    console.error('加载子会话消息历史失败:', err);
    subMessagesError.value = '子会话消息加载失败，请重试';
  } finally {
    isLoadingSubMessages.value = false;
    scrollToBottomForce();
  }
};

/** 触顶游标加载更多子会话历史消息（追加进 v3 槽，与主会话分页同一入口语义）。 */
const handleLoadMoreSubSessionHistory = async () => {
  const subId = activeViewingSubSessionId.value;
  if (subId === null || isLoadingMoreSubMessages.value) return;
  const key = String(subId);
  const pagination = subSessionPaginationMap.value[key];
  if (!pagination || !pagination.hasMore || !pagination.nextCursor) return;

  isLoadingMoreSubMessages.value = true;
  subHistoryLoadError.value = '';
  // 发起时快照代际：请求在途时若代际被推进（如重发），返回的旧页必须整体丢弃 —— 含游标更新。
  const expectedRevision = streamV3.currentHistoryRevision(key);
  try {
    const pageResultRes = await chatApi.fetchSessionMessages(subId, pagination.nextCursor, 30);
    if (!pageResultRes.ok) {
      subHistoryLoadError.value = pageResultRes.error;
      return;
    }
    const pageResult = pageResultRes.data;
    // 更早的一页：追加合并（同键覆盖天然幂等），turns 由 store 按 version 并入。
    const applied = streamV3.ingestHistoryPage(key, pageResult, expectedRevision);
    if (!applied) {
      console.warn('[chat] 过期代际的子会话历史页，已丢弃:', key);
      return;
    }
    subSessionPaginationMap.value[key] = {
      hasMore: pageResult.hasMore,
      nextCursor: pageResult.nextCursor
    };
  } catch (err) {
    console.error('加载更多子会话历史消息失败:', err);
    subHistoryLoadError.value = '加载历史消息失败，请重试';
  } finally {
    isLoadingMoreSubMessages.value = false;
  }
};

/** 重试加载当前查看的子会话消息 */
const handleRetrySubSessionMessages = () => {
  const subId = activeViewingSubSessionId.value;
  if (subId === null) return;
  subMessagesError.value = '';
  void handleSelectSubSessionOption(subId);
};

/**
 * 初始化数据加载（页面挂载与失败重试共用）：
 * 每个 fetch* 返回判别结构，失败时置可见失败态，**不再静默显示为空**（与「确实为空」区分）。
 */
const loadInitialData = async () => {
  initLoadError.value = '';
  try {
    // 1. 每次加载页面都请求后端的 list 会话列表接口
    const sessionsRes = await chatApi.fetchSessions();
    if (sessionsRes.ok) localSessions.value = sessionsRes.data;
    // 2. 请求工作空间列表
    const workspacesRes = await chatApi.fetchWorkspaces();
    if (workspacesRes.ok) localWorkspaces.value = workspacesRes.data;
    // 3. 请求 model_config 的 list 列表接口
    const modelsRes = await chatApi.fetchModels();
    if (modelsRes.ok) localModels.value = modelsRes.data;
    // 4. 请求后端的 user_configs 的 list 接口
    const configsRes = await chatApi.fetchUserConfigs();
    const userConfigs = configsRes.ok ? configsRes.data : [];

    if (!sessionsRes.ok || !modelsRes.ok || !configsRes.ok) {
      initLoadError.value = '会话数据加载失败，请检查后端服务后重试';
    }

    // 5. 假设返回的 vo 中包含 modelId 字段，根据 config 的 modelId 和 list 返回的 id 推断当前用户选中的模型名字展示在模型上拉框
    const targetConfig = userConfigs.find(c => c.modelId != null && String(c.modelId).trim() !== '') ?? userConfigs[0];
    if (configsRes.ok) syncReasoningEffort(targetConfig?.reasoningEffort);
    const targetModelId = targetConfig?.modelId;

    let matchedModel: ModelConfig | undefined = undefined;
    if (targetModelId != null && String(targetModelId).trim() !== '') {
      matchedModel = localModels.value.find(m => String(m.id) === String(targetModelId));
    }

    if (matchedModel) {
      localSelectedModel.value = matchedModel.id;
    } else if (localModels.value.length > 0 && !localSelectedModel.value) {
      localSelectedModel.value = localModels.value[0].id;
    }

    const mode = normalizeAccessMode(targetConfig?.accessMode);
    if (mode) {
      localAccessMode.value = mode;
    }
    // common_config.max_tokens：上下文用量指示器的兜底上限（事件未带 maxTokens 时使用）
    contextMaxTokensFromConfig.value = targetConfig?.maxTokens ?? null;

    if (localWorkspaces.value.length > 0 && !localActiveWorkspaceId.value) {
      localActiveWorkspaceId.value = localWorkspaces.value[0].id ?? null;
    }
    localActiveId.value = null;
  } catch (err) {
    console.error('初始化会话与推断默认选中模型失败:', err);
    initLoadError.value = '初始化数据加载失败，请稍后重试';
  }
};

const handleRetryInit = () => {
  void loadInitialData();
};

onMounted(() => {
  void loadInitialData();
});

const isSidebarCollapsed = ref(false);
const isSettingsOpen = ref(false);
// 与 SettingsModal 共用同一份 tab 白名单来源，避免两处字面量联合类型各自漂移
const settingsInitialTab = ref<SettingsTabKey>('general');
const inputAreaRef = templateRefs?.inputAreaRef ?? ref<InstanceType<typeof ChatInputArea> | null>(null);
// 向卡片类组件（如 PlanCard「去聊天里说」）注入「聚焦输入框」能力，替代脆弱的 document.querySelector('textarea')
provide(CHAT_INPUT_FOCUS_KEY, () => inputAreaRef.value?.focusInput());
/** 流计数保留本地受理状态；重载和切回会话时由后端运行状态补齐。 */
const activeStreamCount = ref(0);
/**
 * v3 权威实体槽。必须在 `isSending` 之前创建：业务运行态的唯一权威是它，
 * 不从 props/本地会话条目里读（那份对象不随 v3 帧更新）。
 */
const streamV3 = useStreamV3Store();

/**
 * 当前会话树根 id（v3 实体按根归档，业务运行态记在根上）。
 *
 * <p>子会话不单独持有运行态：它跑起来时根的 `runStatus` 就是 RUNNING，界面据此显示运行中。</p>
 */
const currentRootSessionId = computed(() => {
  const sid = currentActiveSession.value?.id;
  return sid == null ? '' : resolveRootSessionId(currentActiveSession.value);
});

/**
 * 当前根的 v3 权威会话实体；尚未同步到（新建会话）时为 null。
 */
const authoritativeSession = computed(() =>
  currentRootSessionId.value ? streamV3.sessions.get(String(currentRootSessionId.value)) ?? null : null
);

const isSending = computed(() =>
  resolveSessionSending(authoritativeSession.value, activeStreamCount.value, currentActiveSession.value)
);
const currentAbortController = ref<AbortController | null>(null);
/**
 * 当前在途命令的归属会话 id 快照：受理回执返回后固定为该会话 id，
 * 切换会话或本轮收尾时清空。用于收尾对账与失败回填的精确定位 ——
 * 绝不写进「响应到达时的当下会话」。
 */
let activeStreamOwnerSessionId: string | null = null;

/**
 * 会话级 v3 事件流：**只要进了这个会话就挂着一条连接**，与「正在发消息 / 正在审批恢复」无关。
 *
 * <p>批次 A 起它是**唯一**的实时通道：发送 / 重发 / 审批都只发 JSON 命令拿回执，不再建立请求级 SSE。
 * 它补上请求级流的三个结构性缺口：</p>
 * <ol>
 *   <li>子会话/映射事件不再依赖「哪条请求级流恰好开着」；</li>
 *   <li>根执行终态后事件仍有订阅者（请求级流在终态就关，之后子代理的后续事件原本一个都收不到）；</li>
 *   <li>断线自愈 —— 重挂成功即回调 `onReattached`，由 attachStreamV3 重走一遍同步时序补齐缺口。</li>
 * </ol>
 */
const sseStreamStore = useSseRouterStore();
/**
 * 当前挂载的 v3 会话流句柄（替代原 v2 订阅的 `sessionStreamUnsubscribe`）。
 *
 * <p>用句柄而非布尔：切换会话时必须**先 detach 旧流**（退订 + 关连接），否则旧入口会继续把帧写进
 * 已切换的视图 —— 这正是「切换后的会话停止旧实时入口写入」的落点。</p>
 */
let attachedV3Session: StreamV3Session | null = null;
let attachedStreamRootId: string | null = null;
/**
 * 根会话终态对账：会话树 + 用量快照 + 消息级权威对账。
 *
 * <p>批次 A 起终态由 **v3 执行状态**驱动（不再是 v2 终态事件）：v3 store 的 `executions` 槽里
 * 某执行进入终态时触发一次幂等对账（见下方 watch）。实时性本身由 v3 状态源驱动视图，这里只是
 * 补断线/漏事件造成的缺口。</p>
 */

/**
 * 挂/摘当前会话的 v3 会话级流：切会话与进/出视图都走这一个入口。
 *
 * <p><b>批次 A 的通道规则</b>：同一前端实例对同一根会话**只消费 v3**，不与 v2 混用。会话级流是
 * 常驻渲染通道，其帧（含 bootstrap 时序）全部进 {@link useStreamV3Store}，视图由
 * {@link displayedMessages} 从该唯一状态源派生。</p>
 */
const attachSessionStream = (rootId: string | null) => {
  const key = rootId != null ? String(rootId) : null;
  if (attachedStreamRootId === key) return;

  // 摘旧：退订 + 关连接 + 丢弃该会话的 v3 状态，杜绝旧入口继续写入。
  // 顺序不可颠倒 —— 必须先 detach 再切 key，否则 detach 内部的关流会命中新 key。
  if (attachedV3Session) {
    detachStreamV3(attachedV3Session);
    attachedV3Session = null;
  }
  if (attachedStreamRootId && attachedStreamRootId !== key) {
    // 离开旧会话：清空它的 v3 实时状态（切回来会重新走 bootstrap 首屏）。
    streamV3.resetSession(attachedStreamRootId);
  }
  attachedStreamRootId = key;
  if (!key) return;

  // 建立 v3 会话流：内部完成 §8 时序（beginSync → READY → bootstrap → 合并 + 回放暂存帧）。
  attachedV3Session = attachStreamV3(key);
};

// 切会话/进视图统一走 attachSessionStream：受控模式（props.sessions）与本地模式共用同一路径，
// 不在 handleSelectSession / handleSelectSubSessionOption 里散落调用，避免漏挂。
watch(
  () => currentActiveSession.value?.id,
  () => attachSessionStream(resolveRootSessionId(currentActiveSession.value)),
  { immediate: true }
);

/**
 * 终态对账：v3 `executions` 槽里出现**新的**终态执行时，做一次幂等权威对账（会话树 + 用量 + 消息分页）。
 *
 * <p>为什么挂在执行槽而不是终态事件上：批次 A 取消了请求级流，没有「流结束」这个回调点了。
 * 执行进入终态本身就是「本轮不再有新事件」的权威信号。对账只是补缺口（断线/漏事件），
 * 实时渲染完全由 v3 状态源驱动。</p>
 *
 * <p><b>为什么 watch 返回值必须是「终态执行集合」而不是布尔</b>：回调只在返回值**变化**时触发。
 * 早先返回「是否存在任意终态执行」（布尔 / 恒定根 id），第一个执行结束后该值长期为真，
 * 第二个执行 RUNNING→COMPLETED 时返回值不变 —— 第二次收尾永不触发。
 * 返回**按根会话筛选的终态执行 id 集合**：每次新执行终结，集合内容变化，回调即触发一次。</p>
 *
 * <p><b>只认真正终结（COMPLETED / FAILED / CANCELLED），不含 SUSPENDED</b>：这里判的是
 * 「本轮收尾了没有、要不要补一次权威对账」。挂起只是暂停等审批、之后还会恢复跑完，
 * 此时对账纯属浪费一次会话树 + 历史分页查询（design §1 明确要压读路径）。</p>
 *
 * <p>⚠️ 别和 {@code resolveResponseClosed} 混用：那个含 SUSPENDED，管的是「响应停收增量」，
 * 服务于 {@code finalizeByExecution}，与本处的「执行收尾」是两件事。</p>
 */
watch(
  () => {
    const rootId = resolveRootSessionId(currentActiveSession.value);
    if (!rootId) return '';
    const terminalIds = [...streamV3.executions.values()]
      .filter(execution => resolveExecutionTerminal(execution.status))
      // 只认**归属当前根会话树**的执行：别的根会话的终态不得触发本会话对账。
      .filter(execution => execution.sessionId == null
        || String(execution.sessionId) === String(rootId)
        || isSameRoot(String(execution.sessionId), String(rootId)))
      .map(execution => String(execution.executionId))
      .sort();
    // ★ 没有终态执行时返回空串：与「切走/无会话」同态，避免进入会话那一下（空集合）被当成一次收尾。
    //   身份 = 根 + 终态集合；每次新执行终结，集合内容变化，回调即触发一次。
    return terminalIds.length > 0 ? `${rootId}:${terminalIds.join(',')}` : '';
  },
  (identity) => {
    if (!identity) return;
    const rootId = identity.slice(0, identity.indexOf(':'));
    if (rootId) void reconcileSessionAfterStream(rootId);
  }
);

/**
 * 判定两个会话 id 是否同属一棵根会话树。
 *
 * <p>执行实体只带自身 `sessionId`（子会话即子会话 id）。根归属通过 v3 `sessions` 槽声明的
 * `rootSessionId` 解析；实体未到达时保守按「不同根」处理 —— 宁可漏一次对账（下次事件会补），
 * 也不能让别的根会话的终态误触发本会话对账。</p>
 */
function isSameRoot(sessionId: string, rootId: string): boolean {
  if (sessionId === rootId) return true;
  const session = streamV3.sessions.get(sessionId);
  const declared = session?.rootSessionId != null ? String(session.rootSessionId) : null;
  return declared === rootId;
}

/**
 * 工具调用决策的提交（注入给 PromptCard 下的计划/澄清/命令卡片）。
 *
 * <p><b>批次 A 起不再建请求级 SSE</b>：审批走 JSON 决策接口拿回执，恢复执行产生的文本、思考、
 * 工具与执行状态**全部**由这个会话早已挂着的 v3 会话级流下发（唯一实时通道）。原先「decide 流 +
 * 会话级流」同播同一批事件的双写问题随之消失。</p>
 *
 * <p>回执只用于两件事：① 以权威 `toolCall` 刷新卡片（业务状态只认它和后续 v3 事件，请求失败
 * 不得擅自改动）；② 据 `resumeDisposition` 决定按钮文案（等其他卡片 / 已排队 / 已结束），
 * 避免恢复根本没发生时用户一直干等。</p>
 */
provide('decideToolCall', async (payload: {
  conversationId: string;
  toolCallId: string;
  approved: boolean;
  text?: string;
  /** 卡片当前版本（冲突可判定，避免过期界面覆盖先到的结论）。 */
  expectedVersion?: string | number | null;
  /** 决策动作；缺省按批准布尔映射（兼容旧调用方）。 */
  action?: 'APPROVE' | 'REJECT' | 'ANSWER';
}) => {
  const action = payload.action ?? (payload.approved ? 'APPROVE' : 'REJECT');
  // 命令身份：一次提交一个 id，网络重试复用同一 id 由后端查回首轮结论。
  const commandId = createLocalId('cmd-decision');
  const receipt = await chatApi.decideToolCall(
    payload.conversationId,
    payload.toolCallId,
    action,
    payload.text || '',
    payload.expectedVersion ?? null,
    commandId
  );

  // 回执携带的卡片是唯一工具实体：进 v3 状态源，视图适配层按 toolCallId 引用它。
  // 不再就地改写 session.messages —— v3 视图从状态源派生，兼容消息表已不再是渲染真源。
  sendFailureNotice.value = null;

  const tool = receipt.toolCall;
  if (tool) {
    streamV3.ingestToolCall(tool);
  }
  return receipt;
});

const handleStopGeneration = () => {
  const sessionId = currentActiveSession.value?.id;
  if (sessionId && !isTempSessionId(sessionId)) {
    void chatApi.stopGeneration(sessionId).catch(err => {
      console.error('停止会话执行失败:', err);
    });
  }
  if (currentAbortController.value) {
    currentAbortController.value.abort();
    currentAbortController.value = null;
  }
  activeStreamCount.value = 0;
};

const handleSelectSession = async (id: string) => {
  activeViewingSubSessionId.value = null;
  if (props.sessions) {
    emit('selectSession', id);
    return;
  }

  // 关键保护：若点击的正是当前正在运行生成中的会话，绝不重新拉取未完成的后端历史以防冲掉正在流式更新的消息
  if (localActiveId.value === id && activeStreamCount.value > 0) {
    scrollToBottomForce();
    return;
  }

  // 切换到不同会话：立即中止在途流（与 handleStopGeneration 同款），旧流事件随 abort 终止，
  // 不再写进任何会话；下次进入原会话走既有全量拉取兜底。
  if (localActiveId.value !== id && currentAbortController.value) {
    currentAbortController.value.abort();
    currentAbortController.value = null;
    // 不再把原会话气泡就地标成「已完成」：abort 只关掉前端这条连接，后端执行仍在跑。
    // 切回去时 v3 会重连并 bootstrap，正文与进行态按服务端权威恢复。
  }
  // abort 后 onFinish 不做消息对账：流归属已失效，重置发送态与归属快照
  activeStreamCount.value = 0;
  activeStreamOwnerSessionId = null;

  // 切换清理补全：子会话详情抽屉 / 消息缓存 / 待处理事件缓冲全部复位，避免上个会话的残留串进新会话
  selectedSubSessionForDetail.value = null;
  isSubSessionDetailOpen.value = false;

  lastKnownFirstMsgId.value = null;
  lastKnownLastMsgId.value = null;

  localActiveId.value = id;

  // 临时未入库会话直接呈现
  if (isTempSessionId(id)) {
    scrollToBottomForce();
    return;
  }

  // 点击单个会话，并发发起两个请求：一个 findById 获取 token 等元数据，另一个保持现状加载历史记录
  isLoadingCurrentSession.value = true;
  sessionLoadError.value = '';
  // 发起时快照代际：详情是网络往返，期间若发生重发（代际推进），返回的旧快照必须整体丢弃。
  const expectedRevision = streamV3.currentHistoryRevision(String(id));
  try {
    const detailRes = await chatApi.fetchSessionDetail(id);
    if (!detailRes.ok) {
      // 失败态可见（区别于「空会话」）：不再静默显示为空
      sessionLoadError.value = detailRes.error;
      return;
    }
    const detail = detailRes.data;
    {
      const idx = localSessions.value.findIndex(s => s.id === id);
      if (idx !== -1) {
        // 首页详情：**同代际内合并事实**（快照缺行不等于行被删除，替换会把实时写入的新行抹掉）；
        // 过期代际整体丢弃 —— 包括分页游标更新。
        const applied = streamV3.ingestHistoryPage(String(id), {
          records: detail.rawRecords || [],
          turns: detail.turns ?? {},
          nextCursor: detail.nextMessageCursor ?? null,
          hasMore: !!detail.hasMoreMessages,
        }, expectedRevision);

        localSessions.value[idx] = {
          ...localSessions.value[idx],
          title: detail.title || localSessions.value[idx].title,
          workspaceId: detail.workspaceId ?? localSessions.value[idx].workspaceId,
          workDir: detail.workDir ?? localSessions.value[idx].workDir,
          teamId: detail.teamId ?? localSessions.value[idx].teamId ?? null,
          agentId: detail.agentId ?? localSessions.value[idx].agentId,
          rootSessionId: detail.rootSessionId ?? localSessions.value[idx].rootSessionId,
          runStatus: detail.runStatus,
          lastOutcome: detail.lastOutcome,
          subSessions: detail.subSessions ?? localSessions.value[idx].subSessions,
          contextTokenCount: detail.contextTokenCount ?? localSessions.value[idx].contextTokenCount ?? null,
          contextMaxTokens: detail.contextMaxTokens ?? localSessions.value[idx].contextMaxTokens ?? null,
          contextRatio: detail.contextRatio ?? localSessions.value[idx].contextRatio ?? null
        };
        if (applied) {
          localSessions.value[idx].hasMoreMessages = !!detail.hasMoreMessages;
          localSessions.value[idx].nextMessageCursor = detail.nextMessageCursor ?? null;
        }
      } else {
        // 新进入的会话同样走**同代际合并 + 守卫**：过期代际不接受旧快照的分页状态
        // （否则游标被旧值推进）。`detail` 里带着旧游标，必须按 `applied` 决定收不收。
        const newApplied = streamV3.ingestHistoryPage(String(id), {
          records: detail.rawRecords || [],
          turns: detail.turns ?? {},
          nextCursor: detail.nextMessageCursor ?? null,
          hasMore: !!detail.hasMoreMessages,
        }, expectedRevision);
        localSessions.value.unshift({
          ...detail,
          hasMoreMessages: newApplied ? !!detail.hasMoreMessages : undefined,
          nextMessageCursor: newApplied ? detail.nextMessageCursor : undefined,
        });
      }

      // 上下文用量快照种入（root + 子会话）：历史加载时无 CONTEXT_UPDATE 事件，
      // 指示器靠 tree/detail 下发的会话表快照渲染；仅无数据时写入，不覆盖 live 值。
      seedContextUsageFromTree(detail.id, {
        root: detail,
        subSessions: detail.subSessions
      });

      // 会话级 teamId 恢复：输入区团队选择跟随会话绑定 ——
      // 切到团队会话恢复该团队；切到普通会话清空（null），防止把上个团队的 teamId 带进无关会话的请求里。
      // 后端未就位时 detail.teamId 为 undefined → 归一为 null，行为与旧版（内存态丢失）等价。
      localSelectedTeamId.value = detail.teamId ?? null;

      // 如果会话绑有对应工作空间，联动切换激活
      const currentWsId = detail.workspaceId || localSessions.value[idx]?.workspaceId;
      if (currentWsId) {
        localActiveWorkspaceId.value = currentWsId;
      }
    }
  } catch (err) {
    console.error('获取会话详情及消息列表失败:', err);
    sessionLoadError.value = '会话加载失败，请稍后重试';
  } finally {
    isLoadingCurrentSession.value = false;
    scrollToBottomForce();
  }
};

/** 重试加载当前会话详情（失败态可见后的重试入口） */
const handleRetrySessionLoad = () => {
  const id = localActiveId.value;
  if (!id || isTempSessionId(id)) return;
  sessionLoadError.value = '';
  void handleSelectSession(id);
};

const handleNewSession = async (workspaceId?: string | number | null) => {
  activeViewingSubSessionId.value = null;
  if (workspaceId !== undefined) {
    if (props.workspaces) emit('selectWorkspace', props.workspaces.find(w => String(w.id) === String(workspaceId)) || null);
    else localActiveWorkspaceId.value = workspaceId;
  }
  if (props.sessions) {
    emit('newSession', workspaceId);
  } else {
    localActiveId.value = null;
  }
};

const handleSelectWorkspace = (ws: WorkspaceVO | null) => {
  if (props.workspaces) emit('selectWorkspace', ws);
  else localActiveWorkspaceId.value = ws ? ws.id ?? null : null;
};

const handleOpenNewWorkspace = async () => {
  // 桌面端 (Electron) 原生体验：直接调起系统文件选择框，选择即创建，无需手动输入路径
  if (isElectron()) {
    try {
      const selectedPath = await openDirectoryPicker();
      if (selectedPath) {
        const folderName = extractDirName(selectedPath) || '工作空间';
        await handleSaveWorkspace({
          name: folderName,
          hostDir: selectedPath
        });
      }
      return;
    } catch (err) {
      console.error('[handleOpenNewWorkspace] 调起原生目录选择器失败，回退到弹窗:', err);
    }
  }

  // 网页端或回退情况打开弹窗
  isWorkspaceModalOpen.value = true;
};

// 工作空间创建后不可变更（宿主机目录 + 镜像即容器身份），因此这里只有新增分支
const handleSaveWorkspace = async (data: WorkspaceRequest) => {
  try {
    const created = await chatApi.createWorkspace(data);
    if (created) {
      localWorkspaces.value.push(created);
      localActiveWorkspaceId.value = created.id ?? null;
      isWorkspaceModalOpen.value = false;
    }
  } catch (err: any) {
    window.alert(err?.message || '创建项目失败，请检查工作目录及后端连接');
  }
};

const handleDeleteWorkspace = async (id: string | number) => {
  await chatApi.deleteWorkspace(id);
  localWorkspaces.value = localWorkspaces.value.filter(w => String(w.id) !== String(id));
  if (String(localActiveWorkspaceId.value) === String(id)) {
    localActiveWorkspaceId.value = localWorkspaces.value.length > 0 ? localWorkspaces.value[0].id ?? null : null;
  }
};

const handleQuickStart = async () => {
  if (localWorkspaces.value.length > 0) {
    localActiveWorkspaceId.value = localWorkspaces.value[0].id ?? null;
    return;
  }
  // 没有项目时引导创建：桌面端优先唤起原生选择器，否则唤起新建弹窗
  await handleOpenNewWorkspace();
};

const handleDeleteSession = async (id: string) => {
  if (props.sessions) {
    // 受控模式：本地状态归父级所有，交由父级处理删除与回滚
    emit('deleteSession', id);
    return;
  }
  const idx = localSessions.value.findIndex(s => s.id === id);
  if (idx === -1) return;
  const removed = localSessions.value[idx];
  const prevActiveId = localActiveId.value;
  // 乐观移除
  localSessions.value.splice(idx, 1);
  if (localActiveId.value === id) {
    localActiveId.value = null;
  }
  const ok = await chatApi.deleteSession(id);
  if (!ok) {
    // 删除失败：回滚本地变更并给出可见提示，否则刷新后条目会「又回来」
    localSessions.value.splice(idx, 0, removed);
    localActiveId.value = prevActiveId;
    window.alert('删除对话失败，请重试');
  }
};

const handleRenameSession = async (id: string, name: string) => {
  if (props.sessions) {
    // 受控模式：本地状态归父级所有，交由父级处理重命名与回滚
    emit('renameSession', id, name);
    return;
  }
  const session = localSessions.value.find(s => s.id === id);
  if (!session) return;
  const prevTitle = session.title;
  // 乐观更新
  session.title = name;
  const ok = await chatApi.renameSession(id, name);
  if (!ok) {
    // 重命名失败：回滚标题并给出可见提示
    session.title = prevTitle;
    window.alert('重命名对话失败，请重试');
  }
};

// 主题切换：修改全局共享主题（自动持久化），并上抛事件供受控父级同步
const handleToggleTheme = () => {
  toggleSharedTheme();
  emit('toggleTheme');
  void UserConfigAPI.updateCurrent({ renderTheme: sharedIsDark.value ? 'DARK' : 'LIGHT' });
};

// 打开设置悬浮框：展示内置面板，同时上抛事件
const handleOpenSettings = () => {
  settingsInitialTab.value = 'general';
  isSettingsOpen.value = true;
  emit('openSettings');
};

const handleOpenModels = () => {
  settingsInitialTab.value = 'models';
  isSettingsOpen.value = true;
};

// 直达指定 tab（如输入框「+」菜单或 /mcp 指令）：非法值经 normalize 回落到 general
const handleOpenSettingsTab = (tab: string) => {
  settingsInitialTab.value = normalizeSettingsTab(tab);
  isSettingsOpen.value = true;
};

const handleCloseSettings = () => {
  isSettingsOpen.value = false;
};

// 清空历史对话：汇总删除结果，仅移除删除成功的条目并如实提示（禁止无条件报成功）
const handleClearSessions = async () => {
  if (props.sessions) {
    // 受控模式：本地状态归父级所有，交由父级处理清空与结果汇总
    emit('clearSessions');
    return;
  }
  const ids = localSessions.value.map(s => s.id);
  if (ids.length === 0) return;
  const results = await Promise.all(
    ids.map(async id => ({ id, ok: await chatApi.deleteSession(id) }))
  );
  const failedIds = new Set(results.filter(r => !r.ok).map(r => r.id));
  const okCount = ids.length - failedIds.size;
  // 回滚本地列表：只保留删除失败的条目，避免「以为删了、刷新又回来」
  localSessions.value = localSessions.value.filter(s => failedIds.has(s.id));
  if (localActiveId.value && !failedIds.has(localActiveId.value)) {
    localActiveId.value = null;
  }
  if (failedIds.size === 0) {
    window.alert(`已清空全部对话（${okCount} 条）`);
  } else {
    window.alert(`已清空 ${okCount} 条，${failedIds.size} 条失败，请重试`);
  }
};


/** 把当前选中的模型持久化到通用配置（失败静默，不影响本次会话）。 */
const persistSelectedModel = async (modelId: string | number) => {
  try {
    // 解析不出合法 id 就跳过，避免把 NaN 提交给后端
    const id = toPositiveInt(modelId, 0);
    if (!id) return;
    await UserConfigAPI.updateCurrent({ modelId: id });
  } catch (err) {
    console.warn('[persistSelectedModel] 持久化选中模型失败:', err);
  }
};

const handleUpdateModel = (modelId: string | number) => {
  if (props.models) emit('updateModel', modelId);
  else localSelectedModel.value = modelId;
  void persistSelectedModel(modelId);
};

/** 把当前选中的权限范围持久化到通用配置（失败静默，不影响本次会话）。 */
const persistAccessMode = async (accessMode: AgentAccessMode) => {
  try {
    await UserConfigAPI.updateCurrent({ accessMode });
  } catch (err) {
    console.error('持久化会话访问档位失败:', err);
  }
};

const handleUpdateAccessMode = (accessMode: AgentAccessMode) => {
  localAccessMode.value = accessMode;
  if (props.accessMode) emit('updateAccessMode', accessMode);
  void persistAccessMode(accessMode);
};

// 输入框模型下拉『添加自定义模型』触发：打开设置弹窗并切换到模型管理 Tab
const handleOpenModelEditor = () => {
  settingsInitialTab.value = 'models';
  isSettingsOpen.value = true;
};

// 模型管理中更新/增删模型后，刷新本地模型列表与下拉框
const handleModelUpdated = async () => {
  const modelsRes = await chatApi.fetchModels();
  if (modelsRes.ok) localModels.value = modelsRes.data;
  const configsRes = await chatApi.fetchUserConfigs();
  const userConfigs = configsRes.ok ? configsRes.data : [];
  const targetConfig = userConfigs.find(c => c.modelId != null && String(c.modelId).trim() !== '') ?? userConfigs[0];
  if (configsRes.ok) syncReasoningEffort(targetConfig?.reasoningEffort);
  const targetModelId = targetConfig?.modelId;
  const matched = targetModelId ? localModels.value.find(m => String(m.id) === String(targetModelId)) : undefined;

  if (targetConfig?.accessMode) {
    const mode = targetConfig.accessMode.trim().toUpperCase() as AgentAccessMode;
    if (['IN_WORKSPACE', 'READ_ONLY_IN_WORKSPACE', 'OUT_OF_WORKSPACE'].includes(mode)) {
      localAccessMode.value = mode;
    }
  }

  if (matched) {
    localSelectedModel.value = matched.id;
  } else if (localModels.value.length > 0 && !localModels.value.some(m => String(m.id) === String(localSelectedModel.value))) {
    localSelectedModel.value = localModels.value[0].id;
  }
};

// 快捷指令「清空当前会话」——**已禁用**。
//
// 语义未定，两条路都不是「顺手改一行」：
// ① 本地隐藏：v3 展示从派生层来，得引入「本会话隐藏集合」这类独立界面状态，
//    且刷新 / 切回即失效，与用户对「清空」的预期不符；
// ② 后端清空：那是破坏性删除，必须走明确的确认链路 + 后端接口（HISTORY_INVALIDATED 同源），
//    不能由一个快捷指令静默触发。
// 在语义确定前保持禁用，避免按钮点了没反应（更糟的是制造「已清空」的假象）。
const handleClearCurrentSession = () => {
  console.warn('[chat] 「清空当前会话」暂未开放：本地隐藏与后端清空的语义尚未确定。');
};

// 快捷指令导出当前会话为 Markdown
const handleExportSession = () => {
  const session = currentActiveSession.value;
  const exported = displayedMessages.value;
  if (!session || exported.length === 0) {
    window.alert('当前会话暂无消息内容可导出');
    return;
  }
  const blob = new Blob([buildSessionMarkdown(session.title, exported)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${session.title || 'chat-export'}-${Date.now()}.md`;
  a.click();
  URL.revokeObjectURL(url);
};

/**
 * 发送消息。
 *
 * @param teamId 不作为请求参数下发（团队是会话绑定，聊天请求不带 teamId）：
 *               仅在「本次要新建会话」时作为首绑参数随 /session/create 落库。
 *               已有会话的选中变化已由 {@link handleUpdateTeam}（下拉框 updateTeam 事件）提前同步，
 *               这里不重复调用，避免连点两次绑定请求。
 */
const handleSendMessage = async (text: string, isDeepThink: boolean, isHybridSearch: boolean, requirePlan = false, teamId?: string | number | null, agentId?: string | number | null, imageFile?: File | null, resendMessageId?: string | null) => {
  // 重入守卫：流进行中拒绝再次发送（与 handleResendMessage 同款），防止并发流叠加污染计数与归属快照
  if (isSending.value || reasoningEffortPending.value) return;
  // 重发必须落在已入库的会话上：目标是它的某条历史提问，临时会话里还没有可重发的轮次
  if (resendMessageId && (!localActiveId.value || isTempSessionId(localActiveId.value))) return;
  if (teamId !== undefined) {
    localSelectedTeamId.value = teamId;
  }
  if (agentId !== undefined) {
    localSelectedAgentId.value = agentId;
  }
  // 受控模式（父组件接管发送）不支持重发：目标提问的轮次要被作废，这一步必须和后端的回滚同源，
  // 只能走本组件的流式链路，因此重发一律走 else 分支。
  if (props.sessions && !resendMessageId) {
    emit('sendMessage', text, isDeepThink, isHybridSearch, requirePlan, teamId, agentId, imageFile);
  } else {
    // 活跃流计数仅在本路径登记（catch/finally 统一回收）；受控分支（props.sessions）的发送态
    // 由父组件管理且无回收路径，若在此前计数将泄漏为 isSending 永久 true
    activeStreamCount.value++;
    const currentWs = displayWorkspaces.value.find(w => String(w.id) === String(displayActiveWorkspaceId.value)) || null;
    const selectedModelObj = displayModels.value.find(m => String(m.id) === String(displaySelectedModel.value));
    const modelIdToSend = selectedModelObj ? selectedModelObj.id : (displaySelectedModel.value || null);
    const modelNameToSend = selectedModelObj?.name || selectedModelObj?.modelName || 'AI';

    const isNewLocalSession = !localActiveId.value || isTempSessionId(localActiveId.value);
    const sessionIdToSend: string | number | null = isNewLocalSession ? null : localActiveId.value;

    // 命令身份：一次用户操作一个 commandId，网络重试复用同一 id（后端据它查回首轮受理，不重复执行）。
    const commandId = createLocalId('cmd-send');

    // 操作归属（发起这一刻的会话）：回执可能迟到，用户早已切到别的会话。
    // 连接选择只由**当前查看会话**决定 —— 无条件补挂会让迟到的 A 回执把正在查看的 B 的流关掉，
    // 而 B 的活跃 id 没变化、watch 不会再触发补挂，形成「看 B、听 A」。
    const ownerSessionIdAtRequest = resolveRootSessionId(currentActiveSession.value);

    try {
      // ── 命令受理（JSON 回执，无请求级 SSE）────────────────────────────────
      // 回执只绑定身份：拿到 sessionId / turnId / executionId 后订阅 v3、再补首屏历史。
      // 正文一律走 v3 会话流，因此这里不预建任何 assistant 气泡。
      const receipt = await chatApi.sendCommand(
        commandId,
        sessionIdToSend,
        text,
        currentWs?.id,
        currentWs?.workDir,
        modelIdToSend,
        modelNameToSend,
        requirePlan,
        teamId ?? localSelectedTeamId.value,
        agentId ?? localSelectedAgentId.value,
        imageFile,
        resendMessageId ?? null
      );

      // 归属快照：受理后拿到权威会话 id，切走判定与后续对账都按它定位。
      const owningSessionId = String(receipt.sessionId);
      activeStreamOwnerSessionId = owningSessionId;

      // 本地条目落位：新会话在 createSession 阶段已建条目，此处只补标题 / 会话 id 对齐。
      const existingEntry = localSessions.value.find(s => String(s.id) === owningSessionId);
      if (existingEntry) {
        if (!isNewLocalSession) existingEntry.title = existingEntry.title || (text.slice(0, 30) || '新对话');
      } else {
        const createdEntry: ChatSession = {
          id: owningSessionId,
          title: text.slice(0, 30) || '新对话',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          modelId: modelIdToSend || '',
          activeTools: [],
          workspaceId: currentWs?.id ? String(currentWs.id) : undefined,
          workDir: currentWs?.workDir,
          messages: []
        };
        localSessions.value.unshift(createdEntry);
      }
      if (localActiveId.value !== owningSessionId && (localActiveId.value == null || isTempSessionId(localActiveId.value))) {
        localActiveId.value = owningSessionId;
      }

      // 提交即订阅：命令已被受理，此后的事件必须有人听（服务端不回放，晚订阅就永久缺口）。
      // attachSessionStream 内部走 §8 时序（beginSync → READY → bootstrap 合并 + 回放暂存帧）。
      // 收敛回当前会话的 watch 只在「活跃会话 id 变化」时触发；已有会话发消息时 id 不变，
      // 若此前因故未挂流（如刚 mount 时挂的是另一条），这里必须补挂，否则本轮事件无人接收。
      //
      // ★ 补挂前提是「回执到达时查看的仍是本会话」：否则迟到的回执会先 detach 掉当前会话的流
      //   （attachSessionStream 的摘旧一步），而当前会话的活跃 id 未变、watch 不再补挂，
      //   结果是「看 B、听 A」。实体事实照常更新，只有连接选择被这条约束挡住。
      const viewingRootId = resolveRootSessionId(currentActiveSession.value);
      if (viewingRootId !== owningSessionId) {
        console.warn('[chat] 命令回执迟到于会话切换，只更新实体事实、不切换连接:',
          `发起=${ownerSessionIdAtRequest ?? '(临时会话)'}`, `回执=${owningSessionId}`, `当前=${viewingRootId ?? '(无)'}`);
      } else if (attachedStreamRootId !== owningSessionId) {
        attachSessionStream(owningSessionId);
      }

      // 重发：后端已物理作废目标轮次及其之后的历史。作废范围随回执下发，据此清本地对应状态：
      // 被作废轮次的执行摘要必须逐条移除（只清 v3 实时槽不够 —— turns 里的旧摘要会让
      // 已删除的轮次继续以「失败」/「已完成」的样子渲染出来）。
      //
      // ★ 用范围化作废而不是 resetSession：SSE 事件流与本回执无顺序保证，失效事件与新代际的
      //   提交可能先到。整会话清空会把**已到达的新代际正文**一起抹掉。
      const resendReceipt = receipt as ResendCommandAcceptanceVO;
      const invalidatedTurnIds = resendReceipt.invalidatedTurnIds;
      if (Array.isArray(invalidatedTurnIds) && invalidatedTurnIds.length > 0) {
        // 响应墓碑 / 历史行 / 轮次 / 卡片一次做完（幂等）：卡片没有 turnId，靠回执给的 executionId 清。
        streamV3.discardByInvalidation(owningSessionId, invalidatedTurnIds, resendReceipt.invalidatedExecutionIds ?? []);
        const ownerEntry = localSessions.value.find(s => String(s.id) === owningSessionId);
        if (ownerEntry?.turns) {
          const kept = { ...ownerEntry.turns };
          for (const turnId of invalidatedTurnIds) delete kept[String(turnId)];
          ownerEntry.turns = kept;
        }
      }

      // 不再乐观插入用户提问：回执确认本轮身份后，后端会提交用户行并经 v3 推送
      // （MESSAGE_COMMITTED / 下一轮 bootstrap），视图由派生层呈现，不存本地副本。
    } catch (err: any) {
      // 受理失败：命令未进入执行，不做任何执行态推断，只把原因可见化。
      const errMsg = err?.message || '未知错误';
      console.error('发送命令失败:', err);
      if (isAppInactive()) {
        void sendDesktopNotification('LX 发送失败', errMsg);
      }
      // 失败归属：按本流条目回填；归属未知（建会话/受理都没成功）则挂在当前活跃会话。
      const ownerEntry = activeStreamOwnerSessionId
        ? localSessions.value.find(s => String(s.id) === activeStreamOwnerSessionId)
        : null;
      sendFailureNotice.value = {
        sessionId: String((ownerEntry ?? currentActiveSession.value)?.id ?? localActiveId.value ?? ''),
        message: `发送失败：${errMsg}`,
      };
    } finally {
      activeStreamCount.value = Math.max(0, activeStreamCount.value - 1);
      currentAbortController.value = null;
      scrollToBottom();
    }
  }
};

/**
 * 重发某条历史提问（气泡上的「重新生成」）。
 *
 * <p><b>定位一律走 v3 派生视图</b>，不读兼容消息表：重发要的是「哪条提问」，
 * 而它现在就由展示身份给出（气泡 id 即落库行 id）。</p>
 *
 * <p><b>不在本地删旧气泡</b>：作废范围由重发回执的 `invalidatedTurnIds` 驱动 v3 状态源，
 * 在这里改派生数组既无效（每帧重算）也会与回执这个真源分叉。改为把该提问的 id 作为
 * `resendMessageId` 交给后端，让作废与重建同源。</p>
 */
const handleResendMessage = async (message: ChatMessage) => {
  if (isSending.value) return;
  if (!currentActiveSession.value) return;

  const messages = displayedMessages.value;
  const targetIdx = messages.findIndex(m => m.id === message.id);
  if (targetIdx === -1) return;

  let userMsgToResend: ChatMessage | null = null;
  if (message.role === 'user') {
    userMsgToResend = message;
  } else if (message.role === 'assistant') {
    // 点击 assistant 气泡：回退到同一回答组里的那条用户提问。
    for (let i = targetIdx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userMsgToResend = messages[i];
        break;
      }
    }
  }
  if (!userMsgToResend) return;

  const text = userMsgToResend.content;
  const imageFile = userMsgToResend.imageFile || null;
  const resendMessageId = userMsgToResend.id ?? null;

  // 使用当前选中的模型与团队配置重发；带上 resendMessageId 让后端作废该轮及其之后的历史。
  await handleSendMessage(text, false, false, false, undefined, undefined, imageFile, resendMessageId);
};

/**
 * 编辑历史提问后重发（对应后端 POST /a/completion/resend）。
 *
 * <p>语义是「这条提问我不认了，改一下重新问」：后端会把该轮及其之后的历史全部作废，
 * 再用改写后的文本重跑一轮。编辑只改文本，原提问带的图片原样带上。</p>
 */
const handleEditMessage = async (messageId: string, newText: string) => {
  const text = newText.trim();
  if (!text || isSending.value) return;

  // 定位走 v3 派生视图：气泡 id 即落库行 id（展示身份）。派生视图不携带本地图片对象
  // （用户行只持久化文本），因此原提问的图片不随编辑重发带上。
  const origin = displayedMessages.value.find(m => m.id === messageId);
  await handleSendMessage(text, false, false, false, undefined, undefined,
    origin?.imageFile ?? null, messageId);
};

const handleHumanResponse = (message: string) => {
  if (!message || isSending.value) return;
  const teamId = props.sessions ? undefined : localSelectedTeamId.value;
  const agentId = props.sessions ? undefined : localSelectedAgentId.value;
  void handleSendMessage(message, false, false, false,
    teamId, agentId, null);
};

const handleSelectPrompt = (promptText: string) => {
  if (inputAreaRef.value) {
    inputAreaRef.value.setInputText(promptText);
  }
};

/**
 * 组件销毁（路由切走/页面卸载）时统一清理副作用：
 * 1. 中止在途的流式请求，避免 SSE 在后台继续消费并回调已销毁组件的状态；
 * 2. 清理全部登记过的定时器（scrollToBottom 已改用 rAF，不再产生定时器）；
 * 3. 取消待执行的滚动帧；
 * 4. 释放子会话待处理事件缓冲与在途的会话树刷新 promise 引用。
 */
onBeforeUnmount(() => {
  if (currentAbortController.value) {
    currentAbortController.value.abort();
    currentAbortController.value = null;
  }
  pendingTimers.forEach(id => window.clearTimeout(id));
  pendingTimers.clear();
  // 会话级 v3 流：退订 + 关流（closeAll 内部会撤销重连意图，不会留下「断线自愈」定时器）
  if (attachedV3Session) {
    detachStreamV3(attachedV3Session);
    attachedV3Session = null;
  }
  attachedStreamRootId = null;
  sseStreamStore.closeAll();
});

  return {
    isSidebarCollapsed,
    isSettingsOpen,
    settingsInitialTab,
    inputAreaRef,
    messagesContainerRef,
    activeStreamCount,
    isSending,
    currentAbortController,
    localSessions,
    localActiveId,
    localModels,
    localWorkspaces,
    localActiveWorkspaceId,
    localSelectedModel,
    localAccessMode,
    localSelectedTeamId,
    localSelectedAgentId,
    isWorkspaceModalOpen,
    isTeamModalOpen,
    isSubSessionsOverviewOpen,
    selectedSubSessionForDetail,
    activeViewingSubSessionId,
    isSubPanelOpen,
    isSubSessionDetailOpen,
    activeViewingSubSession,
    availableSubSessionItems,
    isLoadingSubMessages,
    subMessagesError,
    hasMoreSubMessages,
    isLoadingMoreSubMessages,
    subHistoryLoadError,
    handleLoadMoreSubSessionHistory,
    displaySessions,
    displayActiveId,
    displayModels,
    displayWorkspaces,
    displayActiveWorkspaceId,
    displaySelectedModel,
    displayAccessMode,
    reasoningEffort,
    reasoningEffortPending,
    reasoningEffortError,
    displayIsDark,
    currentActiveSession,
    displayedMessages,
    contextUsageIndicator,
    hasMessages,
    sendFailureNotice,
    dismissSendFailure,
    lastAssistantIndex,
    isNearBottom,
    isLoadingMoreHistory,
    historyLoadError,
    isLoadingCurrentSession,
    sessionLoadError,
    initLoadError,
    messageTurnMap,
    activeSubSessionTurnMap,
    activeSubSessionMessages,
    activeViewingSubSessionVO,
    canChangeWorkspace,
    handleSelectSession,
    handleNewSession,
    handleDeleteSession,
    handleRenameSession,
    handleExportSession,
    handleClearCurrentSession,
    handleClearSessions,
    handleSelectWorkspace,
    handleOpenNewWorkspace,
    handleSaveWorkspace,
    handleDeleteWorkspace,
    handleOpenTeamModal,
    handleTeamCreated,
    handleUpdateTeam,
    handleOpenModels,
    handleOpenModelEditor,
    handleUpdateModel,
    handleUpdateAccessMode,
    handleUpdateReasoningEffort,
    handleOpenSettings,
    handleOpenSettingsTab,
    handleCloseSettings,
    handleModelUpdated,
    handleToggleTheme,
    handleSendMessage,
    handleStopGeneration,
    handleResendMessage,
    handleEditMessage,
    handleHumanResponse,
    handleSelectPrompt,
    handleQuickStart,
    handleLoadMoreHistory,
    handleRetryLoadMoreHistory,
    handleRetrySessionLoad,
    handleRetryInit,
    handleRetrySubSessionMessages,
    handleSelectSubSessionOption,
    handleOpenSubSessionDetailFromOverview,
    handleScrollToBottomClick,
    handleMessagesScroll,
    handleMessagesWheel,
    handleTouchStart,
    handleTouchMove,
  };
}
