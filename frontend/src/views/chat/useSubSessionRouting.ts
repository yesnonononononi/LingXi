import { ref, watch, onBeforeUnmount } from 'vue';
import type { Ref, ComputedRef } from 'vue';
import type {
  SubSessionVO,
  AgentStreamEvent,
  ChatMessage,
  SubAgentSessionCreatedData,
  SubItemStatus,
  ChatSession
} from '../../types/chat';
import { chatApi } from '../../services/chat';
import { routeToSession } from './messageRouter';
import { useChatSessionStore } from '../../stores/chatSessionStore';

/** 单个子会话待处理事件缓冲的容量上限，超限淘汰最旧事件，避免内存持续增长 */
const MAX_PENDING_SUB_SESSION_EVENTS = 500;

export interface SubSessionRoutingOptions {
  currentActiveSession: ComputedRef<ChatSession | null | undefined>;
  subSessionMessagesMap: Ref<Record<string, ChatMessage[]>>;
  activeViewingSubSessionId: Ref<string | number | null>;
  scrollToBottomIfAuto: () => void;
  getActiveStreamOwnerSessionId: () => string | null;
}

export function useSubSessionRouting(options: SubSessionRoutingOptions) {
  const {
    currentActiveSession,
    subSessionMessagesMap,
    activeViewingSubSessionId,
    scrollToBottomIfAuto,
    getActiveStreamOwnerSessionId,
  } = options;

  const subSessionRouteMap = ref<Record<string, SubSessionVO>>({});
  const pendingSubSessionEvents = new Map<string, AgentStreamEvent[]>();
  /** 会话树刷新节流按根会话隔离（Map<rootSessionId, timestamp>）：避免跨根互相压制刷新 */
  const sessionTreeRefreshAtMap = new Map<string, number>();
  let sessionTreeRefreshPromise: Promise<void> | null = null;

  const rebuildSubSessionRouteMap = () => {
    const routes: Record<string, SubSessionVO> = {};
    (currentActiveSession.value?.subSessions || []).forEach(sub => {
      routes[String(sub.id)] = sub;
    });
    subSessionRouteMap.value = routes;
  };

  watch(
    () => [currentActiveSession.value?.id, currentActiveSession.value?.subSessions],
    rebuildSubSessionRouteMap,
    { deep: true, immediate: true }
  );

  const updateSubSession = (sub: SubSessionVO) => {
    const root = currentActiveSession.value;
    if (!root) return;
    if (!root.subSessions) root.subSessions = [];
    const index = root.subSessions.findIndex(item => String(item.id) === String(sub.id));
    if (index >= 0) root.subSessions[index] = { ...root.subSessions[index], ...sub };
    else root.subSessions.push(sub);
    subSessionRouteMap.value[String(sub.id)] = root.subSessions[index >= 0 ? index : root.subSessions.length - 1];
  };

  /**
   * 把「工具执行态」收敛到子代理面板可渲染的展示集合（流式事件链专用）。
   * `ToolCallTrace.status` 含四态（success/failed/pending/unknown）+ 本地 'calling'，
   * 而展示态 `SubItemStatus` 更宽：'pending'（挂起待决策）归入 'running'，
   * 其余未知值归入 'unknown'，绝不冒充成功。
   */
  const toolStatusToSubItemStatus = (raw?: string | null): SubItemStatus => {
    if (raw === 'success') return 'completed';
    if (raw === 'failed') return 'failed';
    if (raw === 'calling') return 'running';
    if (raw === 'pending') return 'running';
    return 'unknown';
  };

  /** Consume a child runtime event by delegating to messageRouter's unified routeToSession. */
  const consumeSubSessionEvent = (sub: SubSessionVO, event: AgentStreamEvent) => {
    const subSessionId = String(sub.id);
    const sessionStore = useChatSessionStore();
    sessionStore.bindSessionRoot(sub.id, sub.rootSessionId || currentActiveSession.value?.id);

    // 确保子会话任务名称等首条用户消息存在
    let messages = subSessionMessagesMap.value[subSessionId];
    if (!messages || messages.length === 0) {
      messages = [];
      if (sub.task || sub.name) {
        messages.push({
          id: `sub-user-${subSessionId}`,
          role: 'user',
          content: sub.task || sub.name || '',
          timestamp: Date.now()
        });
      }
      sessionStore.syncHistoryMessages(subSessionId, messages);
      subSessionMessagesMap.value[subSessionId] = messages;
    }

    // 统一通过 messageRouter 执行事件流转
    routeToSession(event, sub, {
      onMessageUpdated: (updatedMsg) => {
        const curList = subSessionMessagesMap.value[subSessionId] || [];
        const idx = curList.findIndex(m => m.id === updatedMsg.id);
        if (idx >= 0) curList[idx] = updatedMsg;
        else curList.push(updatedMsg);
        subSessionMessagesMap.value[subSessionId] = [...curList];

        // 同步子会话状态
        if (event.type === 'EXECUTION_STARTED') {
          sub.runStatus = 'RUNNING';
        } else if (event.type === 'EXECUTION_COMPLETED') {
          sub.runStatus = 'IDLE';
          sub.lastOutcome = 'COMPLETED';
          if (event.tokenInfo?.totalTokenCount != null) sub.totalTokens = event.tokenInfo.totalTokenCount;
          if (event.tokenInfo?.inputTokenCount != null) sub.inputTokens = event.tokenInfo.inputTokenCount;
          if (event.tokenInfo?.outputTokenCount != null) sub.outputTokens = event.tokenInfo.outputTokenCount;
        } else if (event.type === 'EXECUTION_FAILED') {
          sub.runStatus = 'IDLE';
          sub.lastOutcome = 'FAILED';
        } else if (event.type === 'EXECUTION_CANCELLED') {
          sub.runStatus = 'IDLE';
          sub.lastOutcome = 'CANCELLED';
        }

        updateSubSession(sub);
        if (String(activeViewingSubSessionId.value) === subSessionId) scrollToBottomIfAuto();
      }
    });
  };

  const flushPendingSubSessionEvents = (subSessionId: string) => {
    const sub = subSessionRouteMap.value[subSessionId];
    const pending = pendingSubSessionEvents.get(subSessionId);
    if (!sub || !pending) return;
    pendingSubSessionEvents.delete(subSessionId);
    pending.forEach(event => consumeSubSessionEvent(sub, event));
  };

  /**
   * 应用「子会话已建立」映射：建路由条目 + 把 subSessionId 绑回发起委派的工具调用。
   *
   * <p>{@code ownerRootSessionId} 是事件归属的根会话。主聊天流不传（沿用当前活跃会话）；
   * 审批恢复流必须显式传 —— 它前置的 abort 已把归属快照置空，不能依赖那份快照。</p>
   */
  const applySubSessionCreated = (data: SubAgentSessionCreatedData, ownerRootSessionId?: string) => {
    const rootId = ownerRootSessionId ?? currentActiveSession.value?.id;
    if (!rootId || String(data.rootSessionId) !== String(rootId)) return;
    const key = String(data.subSessionId);
    const existingRoute = subSessionRouteMap.value[key];
    const resolvedAgentName = data.agentName || existingRoute?.agentName || (data.agentId ? `Agent #${data.agentId}` : '子代理');
    const sub: SubSessionVO = {
      ...(existingRoute || {}),
      id: data.subSessionId,
      rootSessionId: data.rootSessionId,
      agentId: data.agentId,
      agentName: resolvedAgentName,
      task: data.task,
      name: data.task,
      runStatus: 'RUNNING'
    };
    updateSubSession(sub);

    if (data.toolCallId) {
      currentActiveSession.value?.messages.forEach(message => {
        const tool = message.toolCalls?.find(item => item.id === data.toolCallId);
        if (tool) {
          tool.subSessionId = data.subSessionId;
          tool.subAgentId = data.agentId;
          if (resolvedAgentName) {
            tool.subAgentName = resolvedAgentName;
          }
          tool.subTask = data.task;
          tool.category = '子代理';
        }
      });
    }
    flushPendingSubSessionEvents(key);
  };

  const refreshSessionRoutes = (rootSessionId: string) => {
    const now = Date.now();
    // 节流 key 为 rootSessionId：不同根会话的刷新互不压制
    const lastRefreshAt = sessionTreeRefreshAtMap.get(rootSessionId) || 0;
    if (sessionTreeRefreshPromise || now - lastRefreshAt < 1500) return;
    sessionTreeRefreshAtMap.set(rootSessionId, now);
    sessionTreeRefreshPromise = (async () => {
      try {
        const treeRes = await chatApi.fetchSessionTree(rootSessionId);
        if (!treeRes.ok) {
          console.warn('[refreshSessionRoutes] 拉取会话树失败:', treeRes.error);
          return;
        }
        const tree = treeRes.data;
        if (String(tree.rootSessionId) !== rootSessionId) return;
        tree.subSessions.forEach(updateSubSession);
        tree.subSessions.forEach(sub => flushPendingSubSessionEvents(String(sub.id)));
      } finally {
        sessionTreeRefreshPromise = null;
      }
    })();
  };

  /**
   * Returns true when the event belongs to the mapping channel or to a child session.
   *
   * <p>{@code ownerRootSessionId} 是本条流的归属根会话。缺省回落到活跃流快照（主聊天流走这条）；
   * 审批恢复流与无归属的会话级订阅由调用方**显式传入**，不依赖共享可变快照。</p>
   */
  const routeSessionEvent = (event: AgentStreamEvent, ownerRootSessionId?: string): boolean => {
    if (event.type === 'SUB_AGENT_SESSION_CREATED') {
      if (event.data) applySubSessionCreated(event.data as SubAgentSessionCreatedData, ownerRootSessionId);
      return true;
    }

    // 流归属：显式传入优先；否则读「本流归属会话」快照。绝不落进「响应到达时的当下会话」。
    const owningRootId = ownerRootSessionId ?? getActiveStreamOwnerSessionId();
    if (!owningRootId) {
      // 流已被切换终止（abort）或归属尚未建立：丢弃，防止跨会话串写
      console.warn('[routeSessionEvent] 事件缺少归属流，已丢弃:', event.type);
      return true;
    }

    const eventSessionId = event.sessionId == null ? null : String(event.sessionId);

    // CARD_PENDING 归属增强：后端在事件顶层下发权威 rootSessionId（JSON 顶层字符串）。
    // 权威归属非本流 → 直接丢弃（比既有缓冲路径更早止损，不进缓冲、不触发会话树刷新）；
    // 归属本流或字段缺失 → 继续走下方既有映射/缓冲/丢弃逻辑（子会话映射未补齐时维持丢弃 + 回源兜底）。
    if (event.type === 'CARD_PENDING' && event.rootSessionId != null) {
      if (String(event.rootSessionId) !== String(owningRootId)) {
        return true;
      }
    }

    // 无 sessionId 事件（sse.ts 对字符串/无 type JSON 的降级产物）默认归属本流根会话 → 进主流正文管线
    if (eventSessionId === null) return false;

    if (eventSessionId === String(owningRootId)) return false;

    const owner = subSessionRouteMap.value[eventSessionId];
    if (owner && String(owner.rootSessionId) === String(owningRootId)) {
      consumeSubSessionEvent(owner, event);
      // 子 Agent 的审批卡片必须同时显示在根会话，否则用户不打开子会话就无法恢复执行。
      return event.type !== 'CARD_PENDING';
    }

    const pending = pendingSubSessionEvents.get(eventSessionId) || [];
    pending.push(event);
    // 容量上限：会话映射迟迟不补齐时事件会一直堆积，超限即淘汰最旧事件，避免内存无界增长
    if (pending.length > MAX_PENDING_SUB_SESSION_EVENTS) {
      const dropped = pending.splice(0, pending.length - MAX_PENDING_SUB_SESSION_EVENTS);
      console.warn(`[routeSessionEvent] 子会话 ${eventSessionId} 待处理事件超过上限，已淘汰最旧 ${dropped.length} 条`);
    }
    pendingSubSessionEvents.set(eventSessionId, pending);
    refreshSessionRoutes(String(owningRootId));
    return true;
  };

  const clearPendingSubSessionEvents = () => {
    pendingSubSessionEvents.clear();
    sessionTreeRefreshPromise = null;
  };

  onBeforeUnmount(() => {
    clearPendingSubSessionEvents();
  });

  return {
    subSessionRouteMap,
    toolStatusToSubItemStatus,
    routeSessionEvent,
    refreshSessionRoutes,
    clearPendingSubSessionEvents,
  };
}
