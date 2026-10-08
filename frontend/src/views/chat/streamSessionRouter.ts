import type { AgentEvent } from '../../types/Event';
import type { ChatMessage, ChatSession, ContextUsageData, SubSessionVO, ToolCallVO } from '../../types/chat';
import { TurnStreamReducer } from './turnStreamReducer';
import { AgentToolName } from '../../utils/toolNames';

export interface StreamSessionRouterOptions {
  onScrollFollow?: () => void;
  onContextUsageUpdate?: (sessionId: string, usage: ContextUsageData) => void;
  onSubSessionDiscovered?: (subSession: SubSessionVO) => void;
  /** 按 toolCallId 拉取权威 ToolCallVO（PROMISE 卡片实时建卡用）；语义见 TurnStreamReducerOptions。 */
  onResolveCard?: (toolCallId: string) => Promise<ToolCallVO | null>;
  /** 卡片就绪有界重试调度器（宿主注入，便于统一取消）；语义见 TurnStreamReducerOptions。 */
  scheduleCardRetry?: (handler: () => void, delayMs: number) => number;
  /** 取消卡片就绪重试定时器。 */
  cancelCardRetry?: (timerId: number) => void;
}

/**
 * 根会话与多子会话（1:N 无嵌套）事件路由总线。
 *
 * <p>按事件的 metaData.sessionId 精准分流至根会话或目标子会话独立的 Reducer。
 * 动态登记新子代理，并负责主子会话协同状态的双向同步（委派条状态变迁与轨迹对齐）。</p>
 */
export class StreamSessionRouter {
  private currentRootSession: ChatSession | null = null;
  private rootReducer: TurnStreamReducer | null = null;
  private subReducers = new Map<string, TurnStreamReducer>();
  private options: StreamSessionRouterOptions;

  constructor(options: StreamSessionRouterOptions = {}) {
    this.options = options;
  }

  /** 绑定当前活跃的根会话 */
  public bindRootSession(session: ChatSession | null): void {
    const sameSession = this.currentRootSession?.id === session?.id;
    this.currentRootSession = session;

    // 同一会话复用已有 reducer：其消息访问器始终读取「当前」session.messages，
    // 对账替换数组引用后仍能写入新数组，无需重建（重建会丢失在途气泡状态）。
    if (sameSession && session) return;

    // 换会话：释放旧 reducer 的待重试定时器，避免其回调写到已脱离渲染的气泡上
    this.rootReducer?.dispose();
    this.rootReducer = null;
    this.subReducers.forEach(reducer => reducer.dispose());
    this.subReducers.clear();

    if (session) {
      this.rootReducer = new TurnStreamReducer(
        () => this.currentRootSession?.messages ?? [],
        {
          sessionId: String(session.id),
          onScrollFollow: this.options.onScrollFollow,
          onContextUsageUpdate: this.options.onContextUsageUpdate,
          onResolveCard: this.options.onResolveCard,
          scheduleCardRetry: this.options.scheduleCardRetry,
          cancelCardRetry: this.options.cancelCardRetry
        }
      );

      // 为已存在的子会话预初始化 Reducer
      (session.subSessions || []).forEach(sub => {
        if (!sub?.id) return;
        const subId = String(sub.id);
        this.subReducers.set(
          subId,
          new TurnStreamReducer(
            () => this.resolveSubMessages(subId),
            {
              sessionId: subId,
              onScrollFollow: this.options.onScrollFollow,
              onContextUsageUpdate: this.options.onContextUsageUpdate,
              onResolveCard: this.options.onResolveCard,
              scheduleCardRetry: this.options.scheduleCardRetry,
              cancelCardRetry: this.options.cancelCardRetry
            }
          )
        );
      });
    } else {
      this.rootReducer = null;
    }
  }

  /**
   * 读取指定子会话「当前」的消息数组。
   *
   * <p>reconcile 会把 {@code root.subSessions} 整体替换为会话树下发的新对象，子 reducer 不能
   * 在构造时捕获旧数组；这里每次按 id 现查，始终指向最新子会话 VO 的 messages。</p>
   */
  private resolveSubMessages(subId: string): ChatMessage[] {
    const sub = (this.currentRootSession?.subSessions || []).find(s => String(s.id) === subId);
    if (!sub) return [];
    if (!sub.messages) sub.messages = [];
    return sub.messages;
  }

  /** 注入用户乐观提问消息至根会话 */
  public pushUserMessage(text: string, imageUrl?: string): void {
    if (!this.rootReducer) return;
    this.rootReducer.pushUserMessage(text, imageUrl);
  }

  /**
   * 把最后一条用户乐观气泡绑定到权威 turnId（受理回执返回后调用）。
   *
   * <p>没有它，乐观气泡的 {@code turnId} 恒为 null，与历史里同一条消息（带 turnId）
   * 分组键不同 —— 按轮合并时会变成两个用户气泡。</p>
   */
  public bindUserMessageTurn(turnId: string): void {
    if (!this.rootReducer || !turnId) return;
    this.rootReducer.bindUserMessageTurn(turnId);
  }

  /** 派发业务事件至目标会话 */
  public dispatch(event: AgentEvent): void {
    if (!this.currentRootSession || !this.rootReducer) return;

    const effectiveRootId = String(this.currentRootSession.id);

    // 会话归属的两种来源，按事件类别二选一（见 resolveEventOwnership）：
    // 框架事件带 metaData（rootSessionId 供路由、sessionId 供归属）；
    // 块视图事件不带 metaData，归属在载荷顶层的 sessionId。
    const ownership = this.resolveEventOwnership(event);
    const serverRootId = ownership.serverRootId;
    const eventSessionId = ownership.ownerSessionId;

    // 判别是否属于根会话的事件
    const isRoot = this.resolveIsRootEvent(effectiveRootId, serverRootId, eventSessionId);

    if (isRoot) {
      this.rootReducer.consume(event);
      return;
    }

    // 归属于子会话的事件（1:N 拓扑）
    const targetSessionId = eventSessionId || effectiveRootId;
    let subReducer = this.subReducers.get(targetSessionId);
    if (!subReducer) {
      subReducer = this.registerSubSession(targetSessionId, event.metaData);
    }

    if (subReducer) {
      subReducer.consume(event);
      this.syncSubSessionLifecycle(targetSessionId, event);
    }
  }

  /**
   * 解析事件的双重会话身份：{@code ownerSessionId} 是块内容的**真实归属**，
   * {@code serverRootId} 是**传输路由**用的根会话。
   *
   * <p><b>为什么分两路</b>：框架事件经 {@code metaData} 携带二者（子执行归父任务，
   * 故 rootSessionId 是根、sessionId 是子）；而块视图事件（{@code TURN_SNAPSHOT} /
   * {@code BLOCK_UPSERT}）的载荷里**没有 metaData**，它的归属是载荷顶层的
   * {@code sessionId}。只读 {@code metaData} 会让子会话的块视图被误判成根会话，
   * 污染根 reducer。</p>
   *
   * <p><b>块视图不返回 serverRootId</b>：它由订阅**根会话**的那条流承载（后端按
   * {@code executionIdentity.resolveRootSessionId} 投递），路由根就是当前根会话 ——
   * 传 {@code undefined} 让 {@link resolveIsRootEvent} 只按归属判根/子，
   * 否则「块的 sessionId 是子会话」会被错当成「路由根也等于它」。</p>
   */
  private resolveEventOwnership(event: AgentEvent): {
    ownerSessionId?: string;
    serverRootId?: string;
  } {
    const meta = event.metaData;
    if (meta?.sessionId || meta?.rootSessionId) {
      return {
        ownerSessionId: meta?.sessionId ? String(meta.sessionId) : undefined,
        serverRootId: meta?.rootSessionId ? String(meta.rootSessionId) : undefined,
      };
    }
    // 块视图事件：归属在顶层 sessionId；serverRootId 保持 undefined（由当前根会话兜底）。
    const topLevelSessionId = (event as { sessionId?: unknown }).sessionId;
    if (topLevelSessionId != null && String(topLevelSessionId) !== '') {
      return { ownerSessionId: String(topLevelSessionId) };
    }
    return {};
  }

  /** 判断事件是否归属于根会话 */
  private resolveIsRootEvent(
    effectiveRootId: string,
    serverRootId?: string,
    eventSessionId?: string
  ): boolean {
    if (!eventSessionId && !serverRootId) return true;
    if (serverRootId && eventSessionId && serverRootId === eventSessionId) return true;
    if (eventSessionId === effectiveRootId) return true;
    if (serverRootId === effectiveRootId && (!eventSessionId || eventSessionId === effectiveRootId)) return true;
    return false;
  }

  /** 动态发现并注册新的子代理会话容器 */
  private registerSubSession(subSessionId: string, meta?: any): TurnStreamReducer {
    const root = this.currentRootSession;
    if (!root) throw new Error('根会话未绑定');

    if (!root.subSessions) {
      root.subSessions = [];
    }

    let subVO = root.subSessions.find(s => String(s.id) === subSessionId);
    if (!subVO) {
      subVO = {
        id: subSessionId,
        rootSessionId: root.id,
        name: meta?.agentName || `子代理 #${root.subSessions.length + 1}`,
        agentId: meta?.agentId,
        agentName: meta?.agentName,
        runStatus: 'RUNNING',
        messages: []
      };
      root.subSessions.push(subVO);
      this.options.onSubSessionDiscovered?.(subVO);
    }

    if (!subVO.messages) {
      subVO.messages = [];
    }

    const reducer = new TurnStreamReducer(
      () => this.resolveSubMessages(subSessionId),
      {
        sessionId: subSessionId,
        onScrollFollow: this.options.onScrollFollow,
        onContextUsageUpdate: this.options.onContextUsageUpdate,
        onResolveCard: this.options.onResolveCard,
        scheduleCardRetry: this.options.scheduleCardRetry,
        cancelCardRetry: this.options.cancelCardRetry
      }
    );

    this.subReducers.set(subSessionId, reducer);
    return reducer;
  }

  /** 将子会话生命周期事件反向同步至主会话协同卡片与子会话 VO */
  private syncSubSessionLifecycle(subSessionId: string, event: AgentEvent): void {
    const root = this.currentRootSession;
    if (!root) return;

    const subVO = (root.subSessions || []).find(s => String(s.id) === subSessionId);

    if (event.type === 'EXECUTION_STARTED') {
      if (subVO) subVO.runStatus = 'RUNNING';
      this.updateRootSubAgentToolStatus(subSessionId, 'calling');
    } else if (event.type === 'EXECUTION_COMPLETED') {
      if (subVO) {
        subVO.runStatus = 'IDLE';
        subVO.lastOutcome = 'COMPLETED';
      }
      this.updateRootSubAgentToolStatus(subSessionId, 'success');
    } else if (event.type === 'EXECUTION_FAILED') {
      if (subVO) {
        subVO.runStatus = 'IDLE';
        subVO.lastOutcome = 'FAILED';
      }
      this.updateRootSubAgentToolStatus(subSessionId, 'failed');
    } else if (event.type === 'EXECUTION_SUSPENDED') {
      if (subVO) subVO.runStatus = 'SUSPENDED';
      this.updateRootSubAgentToolStatus(subSessionId, 'pending');
    } else if (event.type === 'EXECUTION_RESUME') {
      if (subVO) subVO.runStatus = 'RUNNING';
      this.updateRootSubAgentToolStatus(subSessionId, 'calling');
    }
  }

  /** 同步主会话中 call_sub_agent 工具调用的指示状态 */
  private updateRootSubAgentToolStatus(subSessionId: string, status: 'calling' | 'success' | 'failed' | 'pending'): void {
    if (!this.currentRootSession) return;
    for (const msg of this.currentRootSession.messages) {
      if (!msg.toolCalls) continue;
      for (const tc of msg.toolCalls) {
        if (
          tc.toolName === AgentToolName.CallSubAgent &&
          (String(tc.subSessionId) === subSessionId || String(tc.subAgentId) === subSessionId)
        ) {
          tc.status = status;
        }
      }
    }
  }

  /** 强制同步所有会话未提交的缓冲区 */
  public flushAll(): void {
    this.rootReducer?.flush();
    this.subReducers.forEach(r => r.flush());
  }

  /**
   * 释放全部 reducer：取消其待重试的建卡定时器。
   *
   * <p>组件卸载时调用。释放后本路由不再可用（需要时重建），避免回调写到已销毁的对象上。</p>
   */
  public dispose(): void {
    this.rootReducer?.dispose();
    this.rootReducer = null;
    this.subReducers.forEach(reducer => reducer.dispose());
    this.subReducers.clear();
  }
}
