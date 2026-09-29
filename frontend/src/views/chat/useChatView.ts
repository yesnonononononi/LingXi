import { ref, type Ref, watch, computed, onMounted, onBeforeUnmount, provide } from 'vue';
import { chatApi, UserConfigAPI, SessionAPI } from '../../services/api';
import type { ChatSession, ModelConfig, ChatMessage, WorkspaceVO, WorkspaceRequest, AgentAccessMode, SubSessionVO } from '../../types/chat';
import { useSubSessionRouting } from './useSubSessionRouting';
import { useChatScroll } from './useChatScroll';
import { useChatHistory } from './useChatHistory';

import { useTheme } from '../../composables/useTheme';
import { CHAT_INPUT_FOCUS_KEY } from '../../composables/useChatInputFocus';
import { isPersistedSessionId, isTempSessionId, createLocalId } from '../../utils/ids';
import { extractSubAgentParams, isSubAgentTool } from '../../utils/toolMeta';
import { normalizeAccessMode, normalizeSettingsTab, type SettingsTabKey } from '../../utils/enum';
import { toPositiveInt, isOk } from '../../utils/api';
import { extractErrorMessage } from '../../utils/error';
// 会话树水合：由后端 runStatus + lastOutcome 派生展示态（唯一来源，前端不再猜测）
import { toSubItemStatus } from '../../utils/subSessionStatus';

// 主题：接入全局共享主题状态（与登录页/模型页共用偏好）
import type ChatInputArea from '../../components/chat/ChatInputArea.vue';
import type ScrollCursorLoader from '../../components/common/ScrollCursorLoader.vue';
import type { SubSessionItem } from '../../components/chat/SubAgentSidePanel.vue';

export interface ChatViewProps {
  sessions?: ChatSession[];
  activeSessionId?: string | null;
  models?: ModelConfig[];
  selectedModelId?: string | number;
  enabledTools?: string[];
  activeSession?: ChatSession | null;
  isDark?: boolean;
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
  (e: 'editMessage', messageId: string, newText: string): void;
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
  messagesContainerRef?: Ref<InstanceType<typeof ScrollCursorLoader> | null>;
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
const localSelectedTeamId = ref<string | number | null>(null);
const localSelectedAgentId = ref<string | number | null>(null);

const isWorkspaceModalOpen = ref(false);
const isTeamModalOpen = ref(false);
const isSubSessionsOverviewOpen = ref(false);
const selectedSubSessionForDetail = ref<SubSessionVO | null>(null);
const isSubSessionDetailOpen = ref(false);

// 右侧子代理侧边栏面板及选项切换状态
const isSubPanelOpen = ref(true);
const activeViewingSubSessionId = ref<string | number | null>(null);
const subSessionMessagesMap = ref<Record<string, ChatMessage[]>>({});
const isLoadingSubMessages = ref(false);
/** 子会话消息加载失败态：用于区分「加载失败」与「确实为空」 */
const subMessagesError = ref('');
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
const displayIsDark = computed(() => props.isDark ?? sharedIsDark.value);

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
} = useChatHistory({
  currentActiveSession,
  localSessions,
  messagesContainerRef,
  lastKnownFirstMsgId,
  scheduleTimeout,
});

watch(() => currentActiveSession.value?.messages, (newMsgs) => {
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
}, { deep: true });

const {
  subSessionRouteMap,
  toolStatusToSubItemStatus,
  routeSessionEvent,
  refreshSessionRoutes,
  clearPendingSubSessionEvents,
} = useSubSessionRouting({
  currentActiveSession,
  subSessionMessagesMap,
  activeViewingSubSessionId,
  scrollToBottomIfAuto: () => scrollToBottomIfAuto(),
  getActiveStreamOwnerSessionId: () => activeStreamOwnerSessionId,
});

/** 聚合提取当前会话中的所有子代理项 (用于右侧子代理轨迹与标签面板) */
const availableSubSessionItems = computed<SubSessionItem[]>(() => {
  const session = currentActiveSession.value;
  if (!session) return [];

  const map = new Map<string, SubSessionItem>();

  // 1. 从当前会话绑定的 subSessions 提取
  if (session.subSessions && session.subSessions.length > 0) {
    session.subSessions.forEach((sub, idx) => {
      const id = String(sub.id);
      map.set(id, {
        id: sub.id,
        agentId: sub.agentId,
        agentName: sub.agentName || (sub.agentId ? `Agent #${sub.agentId}` : `子代理 #${idx + 1}`),
        task: sub.task || sub.name || '',
        status: toSubItemStatus(sub.runStatus, sub.lastOutcome),
        totalTokens: sub.totalTokens || 0,
        inputTokens: sub.inputTokens || 0,
        outputTokens: sub.outputTokens || 0,
        subSession: sub,
        tc: undefined
      });
    });
  }

  // 2. 从消息中提取 call_sub_agent 工具调用，补充或更新
  (session.messages || []).forEach(msg => {
    if (msg.toolCalls && msg.toolCalls.length > 0) {
      msg.toolCalls.forEach((tc, idx) => {
        if (!isSubAgentTool(tc.toolName, tc.category)) return;

        // 子代理参数统一由 toolMeta 提取（结构化字段 → args → query）
        const params = extractSubAgentParams(tc);
        const agentId = params.agentId ?? tc.subAgentId;
        const task = params.task || tc.subTask || tc.description || '';
        const prompt = params.prompt ?? tc.subPrompt;
        if (params.subSessionId !== undefined && !tc.subSessionId) {
          tc.subSessionId = params.subSessionId as string;
        }

        {
          const matchedSub = tc.subSessionId
            ? session.subSessions?.find(s => String(s.id) === String(tc.subSessionId))
            : undefined;

          // 会话树存在时，只展示有精确 sessionId 映射的委派，避免同 Agent 多次委派串成同一条。
          if (!tc.subSessionId && session.subSessions?.length) return;

          const key = String(tc.subSessionId || matchedSub?.id || tc.id || `tc-${idx}`);
          const existing = map.get(key);

          const itemData: SubSessionItem = {
            id: tc.subSessionId || matchedSub?.id || tc.id || `sub-${idx}`,
            agentId: agentId || matchedSub?.agentId,
            agentName: tc.subAgentName || matchedSub?.agentName || (agentId ? `Agent #${agentId}` : `子代理 #${map.size + 1}`),
            task: task || matchedSub?.task || '',
            prompt: prompt,
            result: tc.result,
            // 工具执行态优先（流式链）；无工具态时回落后端组合态（水合链）。
            status: tc.status
              ? toolStatusToSubItemStatus(tc.status)
              : toSubItemStatus(matchedSub?.runStatus, matchedSub?.lastOutcome),
            totalTokens: matchedSub?.totalTokens || 0,
            inputTokens: matchedSub?.inputTokens || 0,
            outputTokens: matchedSub?.outputTokens || 0,
            subSession: matchedSub,
            tc: tc
          };

          if (existing) {
            map.set(key, { ...existing, ...itemData });
          } else {
            map.set(key, itemData);
          }
        }
      });
    }
  });

  return Array.from(map.values());
});

/** 当前正在查看的子代理详情 */
const activeViewingSubSession = computed(() => {
  if (activeViewingSubSessionId.value === null) return null;
  return availableSubSessionItems.value.find(it => String(it.id) === String(activeViewingSubSessionId.value)) || null;
});

/** 左侧当前展示的消息列表 (若处于子代理查看模式，则展示子代理对话历史) */
const displayedMessages = computed<ChatMessage[]>(() => {
  if (activeViewingSubSessionId.value !== null) {
    const key = String(activeViewingSubSessionId.value);
    return subSessionMessagesMap.value[key] || [];
  }
  return currentActiveSession.value?.messages || [];
});

const lastAssistantIndex = computed(() => {
  const msgs = displayedMessages.value;
  if (!msgs || msgs.length === 0) return -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') return i;
  }
  return -1;
});

/** 当前展示会话的 Token 信息（在主会话与子代理会话之间动态切换） */
const currentDisplayTokenInfo = computed(() => {
  if (activeViewingSubSessionId.value !== null) {
    const key = String(activeViewingSubSessionId.value);
    const subItem = availableSubSessionItems.value.find(it => String(it.id) === key);
    const subFromRoute = subSessionRouteMap.value[key];
    const subVO = subItem?.subSession || subFromRoute;

    // 检查子会话消息历史里是否有携带 token 的 assistant 消息
    const subMsgs = subSessionMessagesMap.value[key] || [];
    const lastAssistant = [...subMsgs].reverse().find(m => m.role === 'assistant');

    // Token 一律只读 tokenInfo（契约 §2.2：无顶层 token 字段）；
    // 消息未携带时回落子会话元数据，最后回落 0。
    const totalTokens = (lastAssistant?.tokenInfo?.totalTokenCount && lastAssistant.tokenInfo.totalTokenCount > 0)
      ? lastAssistant.tokenInfo.totalTokenCount
      : (subItem?.totalTokens ?? subVO?.totalTokens ?? 0);

    const inputTokens = (lastAssistant?.tokenInfo?.inputTokenCount !== undefined && lastAssistant.tokenInfo.inputTokenCount > 0)
      ? lastAssistant.tokenInfo.inputTokenCount
      : (subItem?.inputTokens ?? subVO?.inputTokens ?? 0);

    const outputTokens = (lastAssistant?.tokenInfo?.outputTokenCount !== undefined && lastAssistant.tokenInfo.outputTokenCount > 0)
      ? lastAssistant.tokenInfo.outputTokenCount
      : (subItem?.outputTokens ?? subVO?.outputTokens ?? 0);

    return {
      totalTokens,
      inputTokens,
      outputTokens
    };
  }

  if (!currentActiveSession.value) return undefined;
  return {
    totalTokens: currentActiveSession.value.totalTokens ?? 0,
    inputTokens: currentActiveSession.value.inputTokens ?? 0,
    outputTokens: currentActiveSession.value.outputTokens ?? 0
  };
});

// 查看子会话时即使暂无消息也要展开消息区，以如实展示「暂无消息」（而非塌陷成空白）
const hasMessages = computed(() => !!displayedMessages.value?.length || isLoadingCurrentSession.value || isLoadingSubMessages.value || activeViewingSubSessionId.value !== null);

/**
 * 切换项目目录按钮只能存在于没有任何消息记录的新会话
 */
const canChangeWorkspace = computed(() => {
  // 处于子代理详情查看模式下，不允许切换项目目录
  if (activeViewingSubSessionId.value !== null) return false;
  // 处于会话历史加载中时，不展示按钮以消除闪烁
  if (isLoadingCurrentSession.value || isLoadingSubMessages.value) return false;
  // 存在任何消息记录时，不允许切换项目目录
  const activeMsgs = currentActiveSession.value?.messages;
  if (activeMsgs && activeMsgs.length > 0) return false;
  if (displayedMessages.value.length > 0) return false;
  return true;
});

const isLoadingCurrentSession = ref(false);

/**
 * 子会话消息合并（历史 × live 双向竞态安全）：
 * 以后端历史为权威基底；live 流式行按 id 去重后追加到末尾（子会话消息按时间序，live 行必新于历史快照）。
 * - fetch 窗口内新到的 live 行：保留（绝不因整体替换丢失）；
 * - live 先到、历史后到：历史正常并入，live 拼接内容不被覆盖；
 * - 本地合成的 user 行若已被历史收编（历史末尾出现同内容 user 行），跳过避免双份。
 */
const mergeSubSessionMessages = (history: ChatMessage[], live: ChatMessage[]): ChatMessage[] => {
  if (live.length === 0) return history;
  const merged = [...history];
  const historyIds = new Set(history.map(m => String(m.id)));
  for (const msg of live) {
    // 同 id：后端权威历史优先，跳过 live 的流式中间态
    if (historyIds.has(String(msg.id))) continue;
    if (msg.role === 'user' && String(msg.id).startsWith('sub-user-')) {
      const lastUser = [...merged].reverse().find(m => m.role === 'user');
      if (lastUser && lastUser.content === msg.content) continue;
    }
    historyIds.add(String(msg.id));
    merged.push({ ...msg });
  }
  return merged;
};

/**
 * 切换子代理 Option 选项：将左侧会话历史切换为子 Agent 的
 */
const handleSelectSubSessionOption = async (subId: string | number | null) => {
  if (subId === null) {
    activeViewingSubSessionId.value = null;
    scrollToBottomForce();
    return;
  }

  activeViewingSubSessionId.value = subId;
  const key = String(subId);

  // 缓存里已有后端历史行（非 live 流式合成行 sub-*）才短路；只有 live 行时仍需拉取历史合并，
  // 否则「live 先到」的子会话将永远看不到更早历史
  const cached = subSessionMessagesMap.value[key];
  const hasHistoryRows = !!cached && cached.some(m => !String(m.id).startsWith('sub-'));
  if (hasHistoryRows) {
    scrollToBottomForce();
    return;
  }

  isLoadingSubMessages.value = true;
  subMessagesError.value = '';
  try {
    // 契约 §6：子会话已由后端持久化（CallSubAgentTool 落 user 消息 + SessionAggregateService 支持按 id 分页），
    // 因此按 subSessionId 拉取真实消息渲染，**不再**用工具调用记录合成假对话/伪造时间戳。
    const isRealSessionId = isPersistedSessionId(subId);
    if (isRealSessionId && currentActiveSession.value?.id) {
      refreshSessionRoutes(String(currentActiveSession.value.id));
    }
    if (isRealSessionId) {
      const pageResult = await chatApi.fetchSessionMessages(subId, null, 100);
      if (!pageResult.ok) {
        subMessagesError.value = pageResult.error;
        return;
      }
      // 拉取异步窗口内 live 可能已写入缓存：按 id 合并（历史为基底），绝不整体替换刷掉 live 行
      const liveRows = subSessionMessagesMap.value[key] || [];
      subSessionMessagesMap.value[key] = mergeSubSessionMessages(pageResult.data.messages, liveRows);
    } else {
      // 面板项带着本地 id（如 tool-xxx）时无法查询后端历史，如实展示为空（模板显示「暂无消息」）
      subSessionMessagesMap.value[key] = [];
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

    if (!sessionsRes.ok || !modelsRes.ok) {
      initLoadError.value = '会话数据加载失败，请检查后端服务后重试';
    }

    // 5. 假设返回的 vo 中包含 modelId 字段，根据 config 的 modelId 和 list 返回的 id 推断当前用户选中的模型名字展示在模型上拉框
    const targetConfig = userConfigs.find(c => c.modelId != null && String(c.modelId).trim() !== '') ?? userConfigs[0];
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
/** 活跃流计数：chat 主流与 decide 决策恢复流可能短暂交错，isSending 派生为「任一流在跑」（单值布尔在双流下会提前归零） */
const activeStreamCount = ref(0);
const isSending = computed(() => activeStreamCount.value > 0);
const currentAbortController = ref<AbortController | null>(null);
/**
 * 当前在途「chat 主流」的归属会话 id 快照：
 * 发起发送时固定为发起时的会话 id（新建会话在 createSession 返回后固定），
 * 切换会话（断流）或流终结时清空。
 * routeSessionEvent 与流式写入一律按该归属路由，绝不写进「响应到达时的当下会话」。
 */
let activeStreamOwnerSessionId: string | null = null;

/**
 * 解析「本流归属会话」的目标条目：
 * 本地管线（非受控）按归属 id 从会话列表精确定位；受控模式（props.sessions）保持写当前活跃会话。
 * 找不到归属条目时返回 null（调用方丢弃本次更新，防止跨会话串写）。
 */
const resolveStreamTargetSession = (ownerSessionId: string | null): ChatSession | null => {
  if (props.sessions) return currentActiveSession.value;
  if (!ownerSessionId) return null;
  return localSessions.value.find(s => String(s.id) === String(ownerSessionId)) || null;
};

/**
 * 流式更新的消息落地：按「本流归属会话」定位目标条目后按 ID 精确替换；
 * 未命中 ID 一律作为新气泡追加进归属会话，绝不复用/改写既有气泡 id（避免跨会话内容顶替）。
 * 供 sendMessageStream 与工具调用决策恢复流（decideToolCall）共用的渲染管线。
 */
const applyStreamMessage = (updatedMsg: ChatMessage, ownerSessionId: string | null) => {
  const target = resolveStreamTargetSession(ownerSessionId);
  if (!target) {
    console.warn('[applyStreamMessage] 未找到流归属会话条目，丢弃本次流式更新:', ownerSessionId, updatedMsg.id);
    return;
  }
  const messages = target.messages;
  const msgIdx = messages.findIndex(m => m.id === updatedMsg.id);

  if (msgIdx !== -1) {
    messages[msgIdx] = { ...updatedMsg };
  } else {
    messages.push({ ...updatedMsg });
  }

  // 若本次流消息发生报错，同步回填给本轮对应的用户消息以展示错误重发标识
  if (updatedMsg.executionError) {
    const curIdx = msgIdx !== -1 ? msgIdx : messages.length - 1;
    for (let i = curIdx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        messages[i].sendError = updatedMsg.executionError;
        break;
      }
    }
  }
};

/** 为一条流生成绑定了归属会话的流式写入回调（发起流时快照归属 id，闭包内不再漂移） */
const makeStreamUpsert = (ownerSessionId: string | null) => (updatedMsg: ChatMessage) => applyStreamMessage(updatedMsg, ownerSessionId);

/**
 * 工具调用决策的流式恢复（注入给 PromptCard 下的计划/澄清/命令卡片）：批准/否决/作答后，
 * 后端恢复执行期间的运行时事件以一个新的 assistant 气泡实时渲染进归属会话（= 后端校验的 conversationId）。
 * 返回 true 表示决策已落库、事件流已建立（调用方可立即更新卡片状态）。
 */
provide('decideToolCall', async (payload: {
  conversationId: string;
  toolCallId: string;
  approved: boolean;
  text?: string;
}) => {
  // 双流收敛：决策恢复流建立时主动中止原 chat 流的本地 SSE 连接。
  // 后端同播语义（publish 遍历同根全部活跃连接）下，恢复期同一批事件会同时到达两条连接，
  // 两条流各自渲染进不同 id 的 botMessage → 同批内容双气泡重复；中止原流后事件仅经 decide 流渲染。
  // 后端恢复执行由 decide 请求触发（独立于 SSE 连接），断开原连接不影响执行与 decide 流收事件。
  const previousController = currentAbortController.value;
  if (previousController) {
    previousController.abort();
    // 归属快照同步失效：主流 onFinish 以「activeStreamOwnerSessionId !== 本流归属」为守卫，
    // 快照置空后原流 onFinish 判定不匹配即跳过对账（渲染职责已移交 decide 流）
    activeStreamOwnerSessionId = null;
  }
  const abortController = new AbortController();
  currentAbortController.value = abortController;
  activeStreamCount.value++;
  // 归属写入：决策恢复流的渲染目标显式固定为其归属会话（sessionIdFilter 同源），不走当下活跃会话
  const upsert = makeStreamUpsert(String(payload.conversationId));
  try {
    return await chatApi.decideToolCall(
      payload.conversationId,
      payload.toolCallId,
      payload.approved,
      payload.text || '',
      upsert,
      abortController.signal,
      async () => {
        // 恢复执行流终态后的消息级权威对账（与主流 onFinish 同款尽力而为语义）。
        // abort 场景 chat.ts 不回调，此处再兜一层守卫：signal 已 aborted 或归属会话为临时会话则跳过。
        if (abortController.signal.aborted) return;
        const ownerSessionId = String(payload.conversationId);
        if (!ownerSessionId || isTempSessionId(ownerSessionId)) return;
        await reconcileSessionAfterStream(ownerSessionId);
      }
    );
  } finally {
    activeStreamCount.value = Math.max(0, activeStreamCount.value - 1);
    // 仅当引用仍指向本流时才清空，避免覆盖掉后续新流的 controller
    if (currentAbortController.value === abortController) {
      currentAbortController.value = null;
    }
  }
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
  if (currentActiveSession.value?.messages?.length) {
    const lastMsg = currentActiveSession.value.messages[currentActiveSession.value.messages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant') {
      lastMsg.isComplete = true;
      lastMsg.isThinking = false;
      lastMsg.isExploring = false;
    }
  }
};

const handleSelectSession = async (id: string) => {
  activeViewingSubSessionId.value = null;
  if (props.sessions) {
    emit('selectSession', id);
    return;
  }

  // 关键保护：若点击的正是当前正在运行生成中的会话，绝不重新拉取未完成的后端历史以防冲掉正在流式更新的消息
  if (localActiveId.value === id && isSending.value) {
    scrollToBottomForce();
    return;
  }

  // 切换到不同会话：立即中止在途流（与 handleStopGeneration 同款），旧流事件随 abort 终止，
  // 不再写进任何会话；下次进入原会话走既有全量拉取兜底。
  if (localActiveId.value !== id && currentAbortController.value) {
    currentAbortController.value.abort();
    currentAbortController.value = null;
    // 切换气泡标记：流被断后不再有终态事件驱动原会话气泡，就地落终态（与 handleStopGeneration 同款），
    // 避免用户切回该会话时气泡仍处于转圈/生成中假象
    const leavingSession = localSessions.value.find(s => s.id === localActiveId.value);
    const leavingMsgs = leavingSession?.messages;
    const lastLeavingMsg = leavingMsgs?.[leavingMsgs.length - 1];
    if (lastLeavingMsg && lastLeavingMsg.role === 'assistant') {
      lastLeavingMsg.isComplete = true;
      lastLeavingMsg.isThinking = false;
      lastLeavingMsg.isExploring = false;
    }
  }
  // abort 后 onFinish 不做消息对账：流归属已失效，重置发送态与归属快照
  activeStreamCount.value = 0;
  activeStreamOwnerSessionId = null;

  // 切换清理补全：子会话详情抽屉 / 消息缓存 / 待处理事件缓冲全部复位，避免上个会话的残留串进新会话
  selectedSubSessionForDetail.value = null;
  isSubSessionDetailOpen.value = false;
  subSessionMessagesMap.value = {};
  clearPendingSubSessionEvents();

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
        // 合并策略：若当前会话在本地有未完成的流式活跃消息，保留在末尾，避免被覆盖后 SSE 匹配失败
        const existingMessages = localSessions.value[idx].messages || [];
        const runningMsg = existingMessages.find(m => m.role === 'assistant' && !m.isComplete);
        let resolvedMessages = detail.messages || [];
        if (runningMsg && !resolvedMessages.some(m => m.id === runningMsg.id)) {
          resolvedMessages = [...resolvedMessages, runningMsg];
        }

        localSessions.value[idx] = {
          ...localSessions.value[idx],
          title: detail.title || localSessions.value[idx].title,
          workspaceId: detail.workspaceId ?? localSessions.value[idx].workspaceId,
          workDir: detail.workDir ?? localSessions.value[idx].workDir,
          teamId: detail.teamId ?? localSessions.value[idx].teamId ?? null,
          totalTokens: detail.totalTokens ?? localSessions.value[idx].totalTokens,
          inputTokens: detail.inputTokens ?? localSessions.value[idx].inputTokens,
          outputTokens: detail.outputTokens ?? localSessions.value[idx].outputTokens,
          agentId: detail.agentId ?? localSessions.value[idx].agentId,
          rootSessionId: detail.rootSessionId ?? localSessions.value[idx].rootSessionId,
          subSessions: detail.subSessions ?? localSessions.value[idx].subSessions,
          messages: resolvedMessages,
          hasMoreMessages: detail.hasMoreMessages,
          nextMessageCursor: detail.nextMessageCursor
        };
      } else {
        localSessions.value.unshift(detail);
      }

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

const handleOpenNewWorkspace = () => {
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
  // 没有项目时引导创建：沙箱环境需要宿主机项目目录，无法凭默认值静默建
  isWorkspaceModalOpen.value = true;
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

// 快捷指令清空当前会话消息
const handleClearCurrentSession = () => {
  if (currentActiveSession.value) {
    currentActiveSession.value.messages = [];
  }
};

// 快捷指令导出当前会话为 Markdown
const handleExportSession = () => {
  const session = currentActiveSession.value;
  if (!session || !session.messages?.length) {
    window.alert('当前会话暂无消息内容可导出');
    return;
  }
  const lines = [
    `# ${session.title || '灵犀会话记录'}`,
    `> 导出时间: ${new Date().toLocaleString()}`,
    '',
    ...session.messages.map(m => {
      const sender = m.role === 'user' ? '👤 用户' : '🤖 灵犀';
      return `### ${sender}\n\n${m.content}\n`;
    })
  ];
  const blob = new Blob([lines.join('\n\n')], { type: 'text/markdown;charset=utf-8' });
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
const handleSendMessage = async (text: string, isDeepThink: boolean, isHybridSearch: boolean, requirePlan = false, teamId?: string | number | null, agentId?: string | number | null, imageFile?: File | null) => {
  // 重入守卫：流进行中拒绝再次发送（与 handleResendMessage 同款），防止并发流叠加污染计数与归属快照
  if (isSending.value) return;
  if (teamId !== undefined) {
    localSelectedTeamId.value = teamId;
  }
  if (agentId !== undefined) {
    localSelectedAgentId.value = agentId;
  }
  if (props.sessions) {
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
    let sessionIdToSend: string | number | null = isNewLocalSession ? null : localActiveId.value;

    if (isNewLocalSession) {
      // 迟到响应守卫：createSession 网络在途期间用户可能已切换会话，发起时的会话 id 必须快照，
      // 响应返回后的条目定位一律以快照为准，绝不读写「响应到达时的当下会话」
      const sentFromLocalId = localActiveId.value;
      try {
        // 新会话连同当前选中的团队一并绑定：聊天请求已不带 teamId，
        // 创建是唯一能同步团队绑定的时机（已有会话走 handleUpdateTeam → bindTeam）。
        const createdSessionId = await chatApi.createSession(
          text,
          currentWs?.id,
          localSelectedTeamId.value
        );
        sessionIdToSend = createdSessionId;

        // 视图跟随仅在用户仍停留在发起会话时生效；已切走则不抢占视图，仅数据层落位
        if (localActiveId.value === sentFromLocalId) {
          localActiveId.value = createdSessionId;
        }

        const oldId = sentFromLocalId;
        const targetSession = oldId ? localSessions.value.find(s => s.id === oldId) : null;
        if (targetSession) {
          targetSession.id = createdSessionId;
          targetSession.title = text.slice(0, 30) || '新对话';
        } else {
          const newSession: ChatSession = {
            id: createdSessionId,
            title: text.slice(0, 30) || '新对话',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            modelId: modelIdToSend || '',
            activeTools: [],
            workspaceId: currentWs?.id ? String(currentWs.id) : undefined,
            workDir: currentWs?.workDir,
            messages: []
          };
          localSessions.value.unshift(newSession);
        }

        // 同步刷新远端会话列表
        void chatApi.fetchSessions().then(sessionsRes => {
          if (!sessionsRes.ok || sessionsRes.data.length === 0) return;
          const freshSessions = sessionsRes.data;
          // 按 createdSessionId 精确定位归属条目取消息，不读「响应到达时的 currentActiveSession」
          const ownerEntry = localSessions.value.find(s => s.id === createdSessionId);
          const currentMsgs = ownerEntry?.messages || [];
          localSessions.value = freshSessions.map(s => {
            if (s.id === createdSessionId) {
              return { ...s, messages: currentMsgs };
            }
            return s;
          });
        });
      } catch (err: any) {
        console.error('新建会话失败:', err);
        // 新建会话失败直接返回（不进入流式阶段）：回退本路径登记的活跃流计数
        activeStreamCount.value = Math.max(0, activeStreamCount.value - 1);
        const errMsg = extractErrorMessage(err?.message || err) || '新建会话失败，请检查后端服务连接';
        const userMsg: ChatMessage = {
          id: createLocalId('msg-user'),
          role: 'user',
          content: text,
          imageUrl: imageFile ? URL.createObjectURL(imageFile) : undefined,
          imageFile: imageFile || undefined,
          timestamp: Date.now(),
          sendError: errMsg
        };
        // createSession 失败时 temp 条目尚未被改写，按发起快照回写错误消息，不写「当下活跃会话」
        const originEntry = sentFromLocalId ? localSessions.value.find(s => s.id === sentFromLocalId) : null;
        (originEntry ?? currentActiveSession.value)?.messages?.push(userMsg);
        return;
      }
    }

    const userMsg: ChatMessage = {
      id: createLocalId('msg-user'),
      role: 'user',
      content: text,
      imageUrl: imageFile ? URL.createObjectURL(imageFile) : undefined,
      imageFile: imageFile || undefined,
      timestamp: Date.now()
    };
    // userMsg 按本流归属会话条目定位写入（新建会话在途期间用户切走时，消息仍归属发起的新会话），
    // 不读「当下活跃会话」；命中失败（如发起时无任何会话条目）才回退 currentActiveSession
    const userMsgTarget = sessionIdToSend != null
      ? localSessions.value.find(s => s.id === String(sessionIdToSend))
      : null;
    (userMsgTarget ?? currentActiveSession.value)?.messages?.push(userMsg);
    if (userMsgTarget && String(localActiveId.value) === String(userMsgTarget.id)) {
      scrollToBottomForce();
    }

    const abortController = new AbortController();
    currentAbortController.value = abortController;

    // 本流归属快照：发起时即固定（新建会话已在上方 createSession 后拿到 createdSessionId），
    // 流式写入与事件路由全程按该归属定位目标会话，绝不漂移到「响应到达时的当下会话」。
    const owningSessionId = sessionIdToSend != null ? String(sessionIdToSend) : null;
    activeStreamOwnerSessionId = owningSessionId;
    const upsert = makeStreamUpsert(owningSessionId);

    try {
      await chatApi.sendMessageStream(
        sessionIdToSend,
        text,
        upsert,
        currentWs?.id,
        currentWs?.workDir,
        modelIdToSend,
        modelNameToSend,
        async (newSessionId: string) => {
          // 归属守卫：流已被切换终止（断流）或归属已固定到其他会话时，
          // 忽略迟到的会话确认，避免把当前视图绑回旧流
          if (activeStreamOwnerSessionId && activeStreamOwnerSessionId !== String(newSessionId)) {
            return;
          }
          // 后端 SSE 流若确认了 sessionId，保持活动会话绑定。
          // 仅在当前会话尚未真正入库（无 ID 或临时 ID）时采纳；
          // 已有持久化 ID 时说明绑定早已完成，覆盖只会被失真/异常值污染。
          const currentId = localActiveId.value;
          // 本回调幂等：同一 newSessionId 重复投递（后端重连重放 / 同播重复通知）时，
          // 二次进入此持久化分支仅做同值快照覆盖，不产生任何视图切换或条目改写副作用
          if (currentId && !isTempSessionId(currentId)) {
            activeStreamOwnerSessionId = String(newSessionId);
            return;
          }
          if (localActiveId.value !== newSessionId) {
            const oldId = localActiveId.value;
            localActiveId.value = newSessionId;
            const targetSession = localSessions.value.find(s => s.id === oldId);
            if (targetSession) {
              targetSession.id = newSessionId;
            }
          }
          activeStreamOwnerSessionId = String(newSessionId);
          try {
            const sessionsRes = await chatApi.fetchSessions();
            if (sessionsRes.ok && sessionsRes.data.length > 0) {
              const freshSessions = sessionsRes.data;
              // 按 newSessionId 精确定位归属条目取消息，消除「响应到达时 currentActiveSession 已漂移」的竞态
              const ownerEntry = localSessions.value.find(s => s.id === newSessionId);
              const currentMsgs = ownerEntry?.messages || [];
              localSessions.value = freshSessions.map(s => {
                if (s.id === newSessionId) {
                  return { ...s, messages: currentMsgs };
                }
                return s;
              });
            }
          } catch (e) {
            console.warn('同步会话列表失败:', e);
          }
        },
        requirePlan,
        abortController.signal,
        async () => {
          // 发送态复位统一由 handleSendMessage 的 finally 收口（活跃流计数 -1），此处不做以免双流交错时提前归零
          // abort/切换后不做消息对账：流归属已失效（归属快照不等于本流归属）时直接结束，
          // 下次进入原会话走既有全量拉取兜底
          if (!owningSessionId || activeStreamOwnerSessionId !== owningSessionId) return;
          if (localActiveId.value && !isTempSessionId(localActiveId.value)) {
            // 串行对账（同一归属会话，一次流结束只发一轮请求）：先树后消息，与 decide 恢复流共用统一对账块
            await reconcileSessionAfterStream(owningSessionId);
          }
        },
        teamId ?? localSelectedTeamId.value,
        routeSessionEvent,
        agentId ?? localSelectedAgentId.value,
        imageFile
      );
    } catch (err: any) {
      // 中止（AbortController.abort()）不应被当作错误上报：用 signal 状态 + DOMException 判定，替代字符串嗅探
      const isAborted = abortController.signal.aborted || (err instanceof DOMException && err.name === 'AbortError');
      if (!isAborted) {
        console.error('发送消息流异常:', err);
        const errMsg = extractErrorMessage(err?.message || err) || '发送失败，请检查网络或后端服务连接';
        userMsg.sendError = errMsg;
        // 按本流归属会话定位末条 assistant 气泡回填错误，不读「响应到达时的 currentActiveSession」
        const ownerEntry = owningSessionId ? localSessions.value.find(s => s.id === owningSessionId) : null;
        const msgs = ownerEntry?.messages || [];
        const lastMsg = msgs[msgs.length - 1];
        if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.content && !lastMsg.toolCalls?.length) {
          lastMsg.executionError = errMsg;
        }
      }
    } finally {
      activeStreamCount.value = Math.max(0, activeStreamCount.value - 1);
      currentAbortController.value = null;
      // 本流已终结：清空归属快照（此后迟到的 routeSessionEvent 回调将按「无归属」丢弃）
      if (activeStreamOwnerSessionId === owningSessionId) {
        activeStreamOwnerSessionId = null;
      }
      scrollToBottom();
    }
  }
};

const handleResendMessage = async (message: ChatMessage) => {
  if (isSending.value) return;
  if (!currentActiveSession.value) return;

  const messages = currentActiveSession.value.messages;
  const targetIdx = messages.findIndex(m => m.id === message.id);
  if (targetIdx === -1) return;

  let userMsgToResend: ChatMessage | null = null;

  if (message.role === 'user') {
    userMsgToResend = message;
    // 检查其后紧跟的 assistant 消息是否为失败或空消息，若是则一同清理
    if (targetIdx + 1 < messages.length && messages[targetIdx + 1].role === 'assistant') {
      const nextMsg = messages[targetIdx + 1];
      if (nextMsg.executionError || (!nextMsg.content && !nextMsg.toolCalls?.length)) {
        messages.splice(targetIdx + 1, 1);
      }
    }
    // 移除该条失败的用户消息（稍后重新发送会重新压入）
    messages.splice(targetIdx, 1);
  } else if (message.role === 'assistant') {
    // 若点击的是 assistant 消息的重发，找到它对应的上一条 user 消息
    let prevUserIdx = -1;
    for (let i = targetIdx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        prevUserIdx = i;
        break;
      }
    }
    if (prevUserIdx !== -1) {
      userMsgToResend = messages[prevUserIdx];
      // 移除该 assistant 消息和其对应的 user 消息
      messages.splice(targetIdx, 1);
      messages.splice(prevUserIdx, 1);
    }
  }

  if (!userMsgToResend) return;

  const text = userMsgToResend.content;
  const imageFile = userMsgToResend.imageFile || null;

  // 重新发送该消息：不必按原来的模型/团队配置的快照，直接使用当前选中的模型与团队配置
  await handleSendMessage(text, false, false, false, undefined, undefined, imageFile);
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
  clearPendingSubSessionEvents();
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
    displaySessions,
    displayActiveId,
    displayModels,
    displayWorkspaces,
    displayActiveWorkspaceId,
    displaySelectedModel,
    displayAccessMode,
    displayIsDark,
    currentActiveSession,
    displayedMessages,
    hasMessages,
    lastAssistantIndex,
    isNearBottom,
    isLoadingMoreHistory,
    historyLoadError,
    isLoadingCurrentSession,
    sessionLoadError,
    initLoadError,
    currentDisplayTokenInfo,
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
    handleOpenSettings,
    handleOpenSettingsTab,
    handleCloseSettings,
    handleModelUpdated,
    handleToggleTheme,
    handleSendMessage,
    handleStopGeneration,
    handleResendMessage,
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
