import { ref, computed, watch, onBeforeUnmount, type Ref } from 'vue';
import { SessionAPI } from '../../services/session';
import { chatApi } from '../../services/chat';
import type { ChatSession, ModelConfig, ChatMessage, WorkspaceVO, ToolCallDecisionReceipt } from '../../types/chat';
import type { AgentEvent } from '../../types/Event';
import type { ToolDecisionHandler } from '../../types/toolDecision';
import { buildMessageTurnMap, isSessionRunning, resolveRootSessionId } from '../../utils/session';
import { useChatScroll } from './useChatScroll';
import { useChatHistory } from './useChatHistory';
import { useChatSending } from './useChatSending';
import { useChatSessionList } from './useChatSessionList';
import { useChatWorkspace } from './useChatWorkspace';
import { useChatSubSession } from './useChatSubSession';
import { StreamSessionRouter } from './streamSessionRouter';
import { SessionEventStream, type StreamHealthState } from './sessionEventStream';
import type { ChatCommand } from '../../services/dto/chat_command';
import { readImagePreviews } from '../../composables/useChatImageAttachments';

import { useChatSessionStore } from '../../stores/chatSessionStore';
import { useUserConfigStore } from '../../stores/userConfigStore';
import { useTheme } from '../../composables/useTheme';
import { useReasoningEffort } from '../../composables/useReasoningEffort';
import { isPersistedSessionId, toServerSessionId } from '../../utils/ids';
import { toPositiveInt, isOk } from '../../utils/api';

import type ChatInputArea from '../../components/chat/ChatInputArea.vue';
import type ScrollCursorLoader from '../../components/common/ScrollCursorLoader.vue';
import type ChatMessageList from '../../components/chat/ChatMessageList.vue';

/** 发送前等待 READY 的上限（毫秒）：超时就重挂一次，仍不就绪则显式报失败。 */
const SUBSCRIBE_READY_TIMEOUT_MS = 5000;

export interface ChatViewTemplateRefs {
  inputAreaRef?: Ref<InstanceType<typeof ChatInputArea> | null>;
  messagesContainerRef?: Ref<InstanceType<typeof ScrollCursorLoader> | InstanceType<typeof ChatMessageList> | any>;
}

/**
 * 会话视图组合式入口（编排层）。
 *
 * <p>本函数只做「装配 + 跨模块胶水」，不含业务实现。职责按模块拆分：</p>
 * <ul>
 *   <li>{@link useChatWorkspace} —— 工作空间、模型/权限配置、初始化加载</li>
 *   <li>{@link useChatSessionList} —— 会话增删改查与切换</li>
 *   <li>{@link useChatSubSession} —— 子会话面板</li>
 *   <li>{@link useChatHistory} —— 历史分页</li>
 *   <li>{@link useChatScroll} —— 滚动</li>
 *   <li>{@link useChatSending} —— 发送与中止</li>
 * </ul>
 *
 * <p>协议渲染层（v2/v3 投影、SSE 事件流、卡片状态机）已整体移除，消息正文的唯一来源是
 * 会话实体的 {@code messages}，由历史接口写入。实时事件接入留待新的渲染系统实现。</p>
 *
 * <p>用户配置（模型 / 访问档位 / 思考强度 / 主题 / 权限策略）的真值统一在
 * {@link useUserConfigStore}，本函数不再持有配置 ref。</p>
 *
 * <p>本组件是路由首页（{@code '/'}），没有父层消费方，因此不再有 props 与 emits。</p>
 */
export function useChatView(templateRefs?: ChatViewTemplateRefs) {
  // ---------- 主题与思考强度（真值在 userConfigStore） ----------
  const { isDark: sharedIsDark, setTheme: setSharedTheme } = useTheme();
  const {
    reasoningEffort,
    reasoningEffortPending,
    reasoningEffortError,
    handleUpdateReasoningEffort,
  } = useReasoningEffort();
  const chatSessionStore = useChatSessionStore();
  const userConfig = useUserConfigStore();

  /**
   * 统一登记组件内所有 `setTimeout`，卸载时一并清理：
   * 避免路由切走后回调仍触发（改动已销毁组件的状态）。
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
  /** 取消 {@link scheduleTimeout} 登记的定时器（避免其回调在卸载后触发）。 */
  const cancelScheduledTimeout = (timerId: number): void => {
    window.clearTimeout(timerId);
    pendingTimers.delete(timerId);
  };

  // ---------- 本地响应式状态（视图自有，不来自全局配置） ----------
  const localSessions = ref<ChatSession[]>([]);
  const localActiveId = ref<string | null>(null);
  const localModels = ref<ModelConfig[]>([]);
  const localWorkspaces = ref<WorkspaceVO[]>([]);
  const localActiveWorkspaceId = ref<string | number | null>(null);
  const localSelectedTeamId = ref<string | number | null>(null);

  const displayIsDark = computed(() => sharedIsDark.value);

  const currentActiveSession = computed(
    () => localSessions.value.find(s => s.id === localActiveId.value) || null,
  );

  // ---------- 滚动 ----------
  const messagesContainerRef = templateRefs?.messagesContainerRef ?? ref<any>(null);
  const lastKnownFirstMsgId = ref<string | null>(null);
  const lastKnownLastMsgId = ref<string | null>(null);
  const resetScrollAnchors = () => {
    lastKnownFirstMsgId.value = null;
    lastKnownLastMsgId.value = null;
  };

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

  // ---------- 历史分页 ----------
  const {
    isLoadingMoreHistory,
    historyLoadError,
    handleLoadMoreHistory,
    handleRetryLoadMoreHistory,
    reconcileSessionAfterStream,
    invalidateReconcile,
    seedContextUsageFromTree,
  } = useChatHistory({
    currentActiveSession,
    localSessions,
    messagesContainerRef,
    scheduleTimeout,
  });

  // ---------- 消息展示派生（供发送/会话模块引用，故先于它们定义） ----------
  /**
   * 左侧当前展示的消息列表（恒定锁定根会话展示，不被子会话替换）。
   *
   * <p>正文唯一来源是会话实体的 {@code messages}（由历史接口写入）。RUNNING 且最后一条不是 user 时
   * 补一个进行中骨架，避免「已发送但首个响应未到」时的空窗。</p>
   */
  const displayedMessages = computed<ChatMessage[]>(() => {
    const session = currentActiveSession.value;
    const derived = session?.messages ?? [];
    if (session?.runStatus === 'RUNNING' && derived.length > 0) {
      const last = derived[derived.length - 1];
      if (last.role === 'user') {
        return [...derived, {
          id: `running-${session.id}-${last.id ?? 'pending'}`,
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

  // ---------- 子会话面板 ----------
  const subSession = useChatSubSession({ currentActiveSession });

  // ---------- 工作空间 / 模型 / 权限 / 设置 ----------
  const workspace = useChatWorkspace({
    localSessions,
    localModels,
    localWorkspaces,
    localActiveWorkspaceId,
    // 初始化后回到「未选中会话」态：会话列表归会话模块管，故以钩子回填。
    onInitialized: () => { localActiveId.value = null; },
  });

  // ---------- 流式事件路由与渲染总线 ----------
  const streamRouter = new StreamSessionRouter({
    onScrollFollow: () => {
      scrollToBottomIfAuto();
    },
    onContextUsageUpdate: (sid, usage) => {
      chatSessionStore.setContextUsage(sid, usage);
    },
    onSubSessionDiscovered: (subVO) => {
      console.info('动态发现并挂载子代理会话:', subVO.id, subVO.name);
    },
    // 实时卡片建卡：收到 PROMISE 类工具调用 / 挂起事件时按 toolCallId 拉权威 ToolCallVO
    onResolveCard: (toolCallId) => chatApi.fetchToolCall(toolCallId),
    // 卡片就绪前的有界重试（安全网）：框架已保证 PREPARING→PENDING 先于挂起事件，
    // 重试只兜「事件与落库之间偶发的可见性延迟 / 乱序」
    scheduleCardRetry: (handler, delayMs) => scheduleTimeout(handler, delayMs),
    cancelCardRetry: (timerId) => cancelScheduledTimeout(timerId),
  });

  watch(currentActiveSession, (session) => {
    streamRouter.bindRootSession(session ?? null);
  }, { immediate: true });

  // ---------- 会话级实时事件流（唯一的实时通道） ----------
  /** 会话级流健康状态（供界面呈现「连接失败」并提供重挂入口）。 */
  const streamHealthState = ref<StreamHealthState>('IDLE');

  /** 终态事件：执行结束，此后该轮不再有增量。 */
  const isTerminalEvent = (type: string): boolean =>
    type === 'EXECUTION_COMPLETED' || type === 'EXECUTION_FAILED' || type === 'EXECUTION_CANCELLED';

  /** 只改执行状态、不改正文的生命周期事件（含挂起）。 */
  const isRunStatusEvent = (type: string): boolean =>
    type === 'EXECUTION_STARTED' || type === 'EXECUTION_RESUME' || type === 'EXECUTION_SUSPENDED';

  /**
   * 把执行生命周期事件写回会话的 runStatus。
   *
   * <p>「生成中」由 runStatus 驱动（受理 POST 立刻返回，等 POST 会让界面闪回可发送态）。
   * 事件按 metaData 归属根 / 子会话：只有根会话的事件改根会话状态。</p>
   */
  const applyRunStatusFromEvent = (event: AgentEvent): void => {
    const session = currentActiveSession.value;
    if (!session) return;
    const eventSessionId = event.metaData?.sessionId ? String(event.metaData.sessionId) : null;
    if (eventSessionId && eventSessionId !== String(session.id)) return;
    if (event.type === 'EXECUTION_STARTED' || event.type === 'EXECUTION_RESUME') {
      session.runStatus = 'RUNNING';
      return;
    }
    if (event.type === 'EXECUTION_SUSPENDED') {
      session.runStatus = 'SUSPENDED';
      return;
    }
    if (isTerminalEvent(event.type)) {
      session.runStatus = 'IDLE';
    }
  };

  /**
   * 会话级流：发送只做同步受理、不带流，正文与工具轨迹全部由这条流下发。
   *
   * <p>连接按<b>根会话</b>共享并计数：主视图与子会话抽屉可能同时看同一会话，
   * 对同一根开两条连接会让同一事件双投、正文增量双写。</p>
   */
  const sessionEventStream = new SessionEventStream({
    onEvent: (event) => {
      streamRouter.dispatch(event);
      if (isRunStatusEvent(event.type)) {
        applyRunStatusFromEvent(event);
      }
      // 终态 / 挂起是本轮不再追加的权威信号：立刻回查一次。
      // 新口径下回查把所有轮次视图逐轮 upsert（版本拦截旧帧），无需「终结才替换」的开关，
      // 因此挂起与终态走同一条路径。
      if (isTerminalEvent(event.type) || event.type === 'EXECUTION_SUSPENDED') {
        const owner = currentActiveSession.value?.id ?? null;
        if (owner) {
          void reconcileSessionAfterStream(String(owner));
        }
      }
    },
    onConnectionClosed: (sessionId) => {
      // 掉线也可能意味着「终态事件没收到」：回读权威状态并对齐历史。
      void reconcileSessionAfterStream(sessionId);
    },
    onResubscribed: (rootSessionId) => {
      // 断线期间服务端不补发：重连成功是唯一能对齐缺口的时机。
      console.info('[chat] 会话级流重连成功，回查历史对齐:', rootSessionId);
      void reconcileSessionAfterStream(rootSessionId);
    },
    onHealthChange: (_rootSessionId, state) => { streamHealthState.value = state; },
    scheduleRetry: (handler, delayMs) => scheduleTimeout(handler, delayMs),
    cancelRetry: (timerId) => cancelScheduledTimeout(timerId),
  });

  /** 确保该根会话已订阅且就绪（收到 READY）：发送前的硬前置。 */
  const ensureSubscribed = async (sessionId: string): Promise<boolean> => {
    if (!isPersistedSessionId(sessionId)) return false;
    // 连接键必须是根会话 id：看子会话时若按子会话 id 另开一条，同一事件会被双投。
    // rootSessionId 为 0/null 表示自身即根（后端契约），必须解析成会话自身 id，不能把 '0' 当连接键。
    const session = currentActiveSession.value;
    const rootId = session && String(session.id) === String(sessionId)
      ? resolveRootSessionId(session) ?? String(sessionId)
      : String(sessionId);
    // 「发送前确保连接在」是使用前提、不是新增使用者：走 ensure（不计数）。
    // 这里若用 acquire，引用计数会随发送次数单调增长，切走会话时归不了零 → 连接永远释放不掉。
    sessionEventStream.ensure(rootId);
    // 就绪等待必须带上根会话 id：多会话并存时没有「当前连接」，按最近插入的那条解析会等错连接。
    return sessionEventStream.waitUntilReady(rootId, SUBSCRIBE_READY_TIMEOUT_MS);
  };

  /** 连接失败时的重挂入口（界面显式按钮）。 */
  const handleReconnectStream = (): void => {
    sessionEventStream.reconnect();
  };

  // ---------- 发送（同步受理，不读 SSE） ----------
  const sending = useChatSending({
    currentActiveSession,
    ensureSubscribed,
    reconnectStream: handleReconnectStream,
    reconcileSessionAfterStream: (sessionId) =>
      reconcileSessionAfterStream(sessionId),
    scrollToBottom,
    // 受理被拒时必须回读权威 runStatus：受理失败后本地无从得知真实状态，
    // 不回读就会让界面停留在错误的执行态（卡在「生成中」或误显示空闲）。
    onSendFailure: (sessionId) => {
      if (isPersistedSessionId(sessionId)) {
        void reconcileSessionAfterStream(sessionId);
      }
    },
  });

  /**
   * 订阅生命周期：进入会话就挂上流。
   *
   * <p>新模型下流跟页面走，完成 / 失败 / 停止都<b>不</b>关流（只改执行状态），
   * 所以这里不再有「挂起才订阅」的条件。切走时释放引用，计数归零才 abort。</p>
   */
  watch(
    () => {
      const session = currentActiveSession.value;
      if (!session || !isPersistedSessionId(session.id)) return null;
      // 根会话 id：看子会话抽屉时也订阅到同一个根，避免同一事件双投。
      // rootSessionId 为 0/null 表示自身即根，解析结果即会话自身 id。
      return resolveRootSessionId(session);
    },
    (rootId, previousRootId) => {
      if (previousRootId && previousRootId !== rootId) {
        sessionEventStream.release(previousRootId);
      }
      if (!rootId) return;
      sessionEventStream.acquire(rootId);
      // 「进入会话」回查：无条件执行。用户切走时执行仍在跑、跑完时没人收终态事件，
      // 这里是对齐这类场景的唯一入口，不能只在「检测到掉线」时才做。
      invalidateReconcile();
      void reconcileSessionAfterStream(rootId);
    },
    { immediate: true },
  );

  /**
   * 执行状态变化：作废在途回查响应（它们属于旧状态的世界），并在转终态时对齐一次。
   */
  watch(
    () => currentActiveSession.value?.runStatus,
    (status, previous) => {
      if (status === previous) return;
      invalidateReconcile();
      if (!isSessionRunning(String(status))) {
        const owner = currentActiveSession.value?.id ?? null;
        if (owner) {
          void reconcileSessionAfterStream(String(owner));
        }
      }
    },
  );

  /**
   * 把输入区的界面事件翻译成请求命令。
   *
   * <p>界面层不知道 sessionId/workspaceId 这些上下文，由这里补齐；团队身份走会话绑定，
   * 不作为请求参数下发。</p>
   */
  const buildCommand = (
    input: string,
    requirePlan: boolean,
    imageFiles: File[],
  ): ChatCommand => {
    return {
      input,
      sessionId: toServerSessionId(localActiveId.value),
      workDir: '',
      modelId: Number(workspace.selectedModelId.value ?? 0),
      workspaceId: Number(localActiveWorkspaceId.value ?? 0),
      agentId: Number(userConfig.agentId ?? 0),
      requirePlan: requirePlan === true,
      image: imageFiles,
    };
  };

  /** 切换选中的 Agent：写全局配置（user_configs.agent_id 是「本实例选中的 Agent」）。 */
  const handleUpdateAgent = (agentId: string | number | null) => {
    const id = toPositiveInt(agentId, 0);
    if (!id) {
      void userConfig.patch('agentId', null, {});
      return;
    }
    void userConfig.patch('agentId', id, { agentId: id });
  };

  /**
   * 确保当前根会话已绑定后端持久化实体；若未绑定则调用后端新建接口先建会话。
   *
   * <p><b>这里不再乐观写 runStatus=RUNNING</b>：受理是同步的，POST 窗口由
   * {@code isSubmitting} 覆盖，而 RUNNING 必须来自受理回执与执行事件 ——
   * 提前乐观写会让 {@code isSending} 在发送前就为真，把本次发送自己挡在门外。</p>
   */
  const ensureBoundSession = async (titleSeed: string): Promise<ChatSession> => {
    const session = currentActiveSession.value;
    if (session && isPersistedSessionId(session.id)) {
      return session;
    }

    // 会话未绑定：直接调用后端新建接口创建真实实体，彻底杜绝本地临时实体
    const sessionName = titleSeed.slice(0, 20).trim() || '新对话';
    const createRes = await SessionAPI.create({
      name: sessionName,
      workspaceId: localActiveWorkspaceId.value ? Number(localActiveWorkspaceId.value) : null,
      teamId: localSelectedTeamId.value ? Number(localSelectedTeamId.value) : null,
    });

    if (!isOk(createRes.code) || !createRes.data) {
      throw new Error(createRes.errMsg || '新建会话失败');
    }

    const serverSessionId = String(createRes.data);
    const newSession: ChatSession = {
      id: serverSessionId,
      title: sessionName,
      messages: session?.messages ? [...session.messages] : [],
      subSessions: [],
      workspaceId: localActiveWorkspaceId.value ?? undefined,
      teamId: localSelectedTeamId.value ? String(localSelectedTeamId.value) : null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      modelId: workspace.selectedModelId.value ?? '',
      activeTools: [],
    };

    localSessions.value.unshift(newSession);
    localActiveId.value = serverSessionId;

    // 必须返回响应式实例：newSession 是裸对象，直接返回会让 StreamSessionRouter 把
    // 流式渲染写到未被 Vue 代理的 messages 上，触发不了重渲染（表现为「发消息后页面空白，
    // 直到对账替换数组引用才出现」）。currentActiveSession 读到的是 localSessions 里的代理。
    return currentActiveSession.value ?? newSession;
  };

  const handleSendMessage = async (
    text: string,
    requirePlan: boolean,
    _teamId?: string | number | null,
    agentId?: string | number | null,
    imageFiles: File[] | null = [],
  ): Promise<void> => {
    if (agentId != null) handleUpdateAgent(agentId);
    try {
      const files = imageFiles ?? [];
      const imageUrls = await readImagePreviews(files);
      // 1. 若当前会话未绑定，调用后端新建会话接口先建立会话（拿权威雪花 id）
      const session = await ensureBoundSession(text);
      streamRouter.bindRootSession(session);
      streamRouter.pushUserMessage(text, imageUrls);

      // 2. 同步受理：先等该根会话订阅就绪（READY），再 POST /a/completion/commands。
      //    受理返回的 sessionId / turnId 是权威值，后续事件与历史都按 turnId 对齐。
      const command = buildCommand(text, requirePlan, files);
      command.sessionId = session.id;
      const acceptance = await sending.handleSendMessage(command);
      if (!acceptance) return;
      // 乐观用户气泡补上权威 turnId：否则它与历史里的同一条消息分组键不同，
      // 合并时会变成两个气泡。
      streamRouter.bindUserMessageTurn(acceptance.turnId);
    } catch (err) {
      console.error('发送消息失败:', err);
      window.alert(err instanceof Error ? err.message : '创建会话失败，请稍后重试');
    }
  };

  /** 协作式暂停会话执行 */
  const handleSuspendGeneration = async (sessionId?: string | number): Promise<void> => {
    const sid = sessionId ?? currentActiveSession.value?.id;
    if (!sid) return;
    try {
      await chatApi.suspendGeneration(sid);
    } catch (err) {
      console.error('暂停会话执行失败:', err);
    }
  };

  /**
   * 用决策回执携带的权威 VO 就地更新卡片（根会话 + 子会话）。
   *
   * <p>请求失败时**不得**走到这里：卡片状态一律以回执与后续 v3 事件为准，绝不擅自改写业务状态。</p>
   */
  const applyCardReceipt = (receipt: ToolCallDecisionReceipt): void => {
    const updated = receipt?.toolCall;
    if (!updated || updated.id == null) return;
    const updatedId = String(updated.id);
    for (const session of localSessions.value) {
      for (const target of [session, ...(session.subSessions || [])]) {
        for (const message of target.messages || []) {
          if (!message.promptCards?.length) continue;
          const idx = message.promptCards.findIndex(card => String(card.id) === updatedId);
          if (idx >= 0) message.promptCards[idx] = updated;
        }
      }
    }
  };

  /**
   * 卡片决策提交（人工在环唯一入口）。
   *
   * <p>统一走 {@link chatApi.decideToolCall} → {@code ToolCallAPI.decide}（幂等 commandId +
   * expectedVersion 冲突判定）；成功后用回执携带的权威 VO 更新卡片，失败则把异常抛回卡片组件
   * 展示错误（不在此吞掉，也不改卡片业务状态）。由 ChatView 通过 {@link DECIDE_TOOL_CALL_KEY} 注入。</p>
   */
  const decideToolCall: ToolDecisionHandler = async (payload) => {
    const receipt = await chatApi.decideToolCall(
      payload.conversationId,
      payload.toolCallId,
      payload.action,
      payload.text ?? '',
      payload.expectedVersion ?? null
    );
    applyCardReceipt(receipt);
    return receipt;
  };

  // ---------- 会话列表 ----------
  const sessionList = useChatSessionList({
    localSessions,
    localActiveId,
    currentActiveSession,
    displayedMessages,
    localActiveWorkspaceId,
    localSelectedTeamId,
    beforeSwitchSession: () => {
      sending.abortInFlight();
      subSession.resetSubSessionView();
      // 切走即作废在途回查响应：它们属于上一个会话的世界，写回来就是串会话。
      invalidateReconcile();
    },
    // 「当前会话是否正在生成」用 isSending（受理在途 或 会话运行中）。
    isGenerating: () => sending.isSending.value,
    scrollToBottomForce,
    seedContextUsageFromTree,
    resetScrollAnchors,
    onNewSession: () => { subSession.activeViewingSubSessionId.value = null; },
  });

  // ---------- 展示层派生（续） ----------
  /** 上下文用量指示器数据（输入框模型选择器左侧展示）。 */
  const contextUsageIndicator = computed<{
    usedTokens: number;
    maxTokens: number | null;
    ratio: number | null;
  }>(() => {
    const session = currentActiveSession.value;
    const usage = session ? chatSessionStore.getContextUsage(session.id) : null;
    // 缺一律走「暂无统计」而非 0：存储层刻意保留 null 表示未采集，视图层抹平会让「未采集」显示成「0」。
    const usedTokens = usage?.tokenCount ?? session?.contextTokenCount ?? 0;
    // 分母只认上下文窗口，第三级 userConfig.maxTokens 是「输出上限」，语义不同（详见报告 BE-7）。
    const maxTokens = usage?.maxTokens ?? session?.contextMaxTokens ?? null;
    const ratio = usage?.ratio ?? (maxTokens && maxTokens > 0 ? usedTokens / maxTokens : (session?.contextRatio ?? null));
    return { usedTokens, maxTokens, ratio };
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
   * 消息 → 所属回答组的映射（主会话渲染用）。
   *
   * <p>每条消息按 turnId 从会话轮次表（{@link ChatSession.turns}）解析权威摘要，供气泡工具条
   * 展示 token / 模型 / 耗时 / 状态；同时标出「这条消息是不是它所在组的最后一条」。</p>
   */
  const messageTurnMap = computed(() =>
    buildMessageTurnMap(displayedMessages.value, currentActiveSession.value?.turns),
  );

  /** 子会话消息 → 所属回答组的映射（右侧子会话面板渲染用）。 */
  const activeSubSessionTurnMap = computed(() =>
    buildMessageTurnMap(subSession.activeSubSessionMessages.value, subSession.activeViewingSubSessionVO.value?.turns),
  );

  const hasMessages = computed(() => !!displayedMessages.value?.length || sessionList.isLoadingCurrentSession.value);

  /** 切换项目目录按钮只能存在于没有任何消息记录的新会话。 */
  const canChangeWorkspace = computed(() => {
    if (subSession.activeViewingSubSessionId.value !== null) return false;
    if (sessionList.isLoadingCurrentSession.value || subSession.isLoadingSubMessages.value) return false;
    if (displayedMessages.value.length > 0) return false;
    return true;
  });

  // 消息数组变化时的滚动跟随（触顶前置插入不滚到底）。
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
      scrollToBottomIfAuto();
    }
  });

  // ---------- 输入区与团队 ----------
  const inputAreaRef = templateRefs?.inputAreaRef ?? ref<InstanceType<typeof ChatInputArea> | null>(null);
  const isTeamModalOpen = ref(false);

  const handleOpenTeamModal = () => { isTeamModalOpen.value = true; };

  const handleUpdateTeam = async (teamId: string | number | null) => {
    localSelectedTeamId.value = teamId;
    const sessionId = currentActiveSession.value?.id;
    if (sessionId && isPersistedSessionId(sessionId)) {
      try {
        await SessionAPI.bindTeam(sessionId, teamId);
      } catch (err) {
        console.error('更新会话团队失败:', err);
      }
    }
  };

  const handleTeamCreated = async (newTeamId?: number | string) => {
    if (newTeamId != null) {
      localSelectedTeamId.value = newTeamId;
    }
    isTeamModalOpen.value = false;
  };

  const handleSelectPrompt = (promptText: string) => {
    inputAreaRef.value?.setInputText(promptText);
  };

  /**
   * 切换明暗主题：内存态交给 {@link useTheme}，持久化交给全局配置。
   *
   * <p>两边都写是必要的：{@code useTheme} 管的是文档根节点类名（首屏就要生效，不能等网络往返），
   * store 管的是「下次打开还记着」。</p>
   */
  const handleToggleTheme = () => {
    const next = sharedIsDark.value ? 'LIGHT' : 'DARK';
    setSharedTheme(next === 'DARK' ? 'dark' : 'light');
    void userConfig.patch('renderTheme', next, { renderTheme: next });
  };

  // ---------- 组件销毁清理 ----------
  onBeforeUnmount(() => {
    // 先作废在途回查，再断流：否则卸载后到达的响应仍会写回已销毁的状态。
    invalidateReconcile();
    sessionEventStream.close();
    streamRouter.flushAll();
    streamRouter.dispose();
    sending.abortInFlight();
    pendingTimers.forEach(id => window.clearTimeout(id));
    pendingTimers.clear();
  });

  return {
    // 布局与设置
    isSidebarCollapsed: workspace.isSidebarCollapsed,
    isSettingsOpen: workspace.isSettingsOpen,
    settingsInitialTab: workspace.settingsInitialTab,
    inputAreaRef,
    messagesContainerRef,
    // 发送
    /** 受理 POST 是否在途：用于「POST 未返回期间禁止重复点击」。 */
    isSubmitting: sending.isSubmitting,
    /** 生成中（受理在途 或 会话运行中），界面唯一判据。 */
    isSending: sending.isSending,
    currentAbortController: sending.currentAbortController,
    sendFailureNotice: sending.sendFailureNotice,
    dismissSendFailure: sending.dismissSendFailure,
    // 会话级流健康
    streamHealthState,
    /** 重试耗尽后的显式重挂入口（界面必须呈现「连接失败」并提供它）。 */
    handleReconnectStream,
    // 本地真源
    localSessions,
    localActiveId,
    localModels,
    localWorkspaces,
    localActiveWorkspaceId,
    localSelectedTeamId,
    // 弹窗与面板
    isWorkspaceModalOpen: workspace.isWorkspaceModalOpen,
    isTeamModalOpen,
    isSubSessionsOverviewOpen: subSession.isSubSessionsOverviewOpen,
    selectedSubSessionForDetail: subSession.selectedSubSessionForDetail,
    activeViewingSubSessionId: subSession.activeViewingSubSessionId,
    isSubPanelOpen: subSession.isSubPanelOpen,
    isSubSessionDetailOpen: subSession.isSubSessionDetailOpen,
    // 子会话
    activeViewingSubSession: subSession.activeViewingSubSession,
    availableSubSessionItems: subSession.availableSubSessionItems,
    isLoadingSubMessages: subSession.isLoadingSubMessages,
    subMessagesError: subSession.subMessagesError,
    hasMoreSubMessages: subSession.hasMoreSubMessages,
    isLoadingMoreSubMessages: subSession.isLoadingMoreSubMessages,
    subHistoryLoadError: subSession.subHistoryLoadError,
    handleLoadMoreSubSessionHistory: subSession.handleLoadMoreSubSessionHistory,
    // 配置类展示字段：真值在 userConfigStore / workspace 模块，模板直接消费
    selectedModelId: workspace.selectedModelId,
    accessMode: userConfig.accessMode,
    selectedAgentId: userConfig.agentId,
    reasoningEffort,
    reasoningEffortPending,
    reasoningEffortError,
    displayIsDark,
    currentActiveSession,
    displayedMessages,
    contextUsageIndicator,
    hasMessages,
    lastAssistantIndex,
    // 滚动与历史
    isNearBottom,
    isLoadingMoreHistory,
    historyLoadError,
    isLoadingCurrentSession: sessionList.isLoadingCurrentSession,
    sessionLoadError: sessionList.sessionLoadError,
    initLoadError: workspace.initLoadError,
    messageTurnMap,
    activeSubSessionTurnMap,
    activeSubSessionMessages: subSession.activeSubSessionMessages,
    activeViewingSubSessionVO: subSession.activeViewingSubSessionVO,
    canChangeWorkspace,
    // 会话操作
    handleSelectSession: sessionList.handleSelectSession,
    handleNewSession: sessionList.handleNewSession,
    handleDeleteSession: sessionList.handleDeleteSession,
    handleRenameSession: sessionList.handleRenameSession,
    handleExportSession: sessionList.handleExportSession,
    handleClearCurrentSession: sessionList.handleClearCurrentSession,
    handleClearSessions: sessionList.handleClearSessions,
    // 工作空间操作
    handleSelectWorkspace: workspace.handleSelectWorkspace,
    handleOpenNewWorkspace: workspace.handleOpenNewWorkspace,
    handleSaveWorkspace: workspace.handleSaveWorkspace,
    handleDeleteWorkspace: workspace.handleDeleteWorkspace,
    handleQuickStart: workspace.handleQuickStart,
    // 团队与配置
    handleOpenTeamModal,
    handleTeamCreated,
    handleUpdateTeam,
    handleOpenModels: workspace.handleOpenModels,
    handleOpenModelEditor: workspace.handleOpenModels,
    handleUpdateModel: workspace.handleUpdateModel,
    handleUpdateAccessMode: workspace.handleUpdateAccessMode,
    handleUpdateAgent,
    handleUpdateReasoningEffort,
    handleOpenSettings: workspace.handleOpenSettings,
    handleOpenSettingsTab: workspace.handleOpenSettingsTab,
    handleCloseSettings: workspace.handleCloseSettings,
    handleModelUpdated: workspace.handleModelUpdated,
    handleToggleTheme,
    // 发送与生命周期控制
    handleSendMessage,
    handleStopGeneration: sending.handleStopGeneration,
    handleSuspendGeneration,
    decideToolCall,
    handleSelectPrompt,
    // 历史
    handleLoadMoreHistory,
    handleRetryLoadMoreHistory,
    handleRetrySessionLoad: sessionList.handleRetrySessionLoad,
    handleRetrySubSessionMessages: subSession.handleRetrySubSessionMessages,
    handleSelectSubSessionOption: subSession.handleSelectSubSessionOption,
    handleOpenSubSessionDetailFromOverview: subSession.handleOpenSubSessionDetailFromOverview,
    // 滚动事件
    handleScrollToBottomClick,
    handleMessagesScroll,
    handleMessagesWheel,
    handleTouchStart,
    handleTouchMove,
  };
}
