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
import { resolveToolExecutionStatus } from '../../utils/toolMeta';
import { buildPromptCard } from '../../utils/session';

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

  const subEventFailed = (event: AgentStreamEvent) => resolveToolExecutionStatus(event.resultStatus) === 'failed';

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

  /** Consume a child runtime event without letting it mutate the root assistant bubble. */
  const consumeSubSessionEvent = (sub: SubSessionVO, event: AgentStreamEvent) => {
    const key = String(sub.id);
    let messages = subSessionMessagesMap.value[key];
    if (!messages || messages.length === 0) {
      messages = [];
      if (sub.task || sub.name) {
        messages.push({
          id: `sub-user-${key}`,
          role: 'user',
          content: sub.task || sub.name || '',
          timestamp: Date.now()
        });
      }
      messages.push({
        id: `sub-assistant-${key}`,
        role: 'assistant',
        content: '',
        timestamp: Date.now(),
        isThinking: true,
        isExploring: true,
        isComplete: false,
        thoughtSteps: [],
        toolCalls: [],
        fileEdits: []
      });
    }

    let assistant = [...messages].reverse().find(message => message.role === 'assistant');
    if (!assistant) {
      assistant = { id: `sub-assistant-${key}`, role: 'assistant', content: '', timestamp: Date.now() };
      messages.push(assistant);
    }

    // 遇到下一个非 PARTIAL_THINKING 事件即视为当前 thinking 结束，下一次监听到 PARTIAL_THINKING 另起新步骤
    if (event.type !== 'PARTIAL_THINKING') {
      assistant.isThinking = false;
      const runningStep = assistant.thoughtSteps?.find(item => item.status === 'running');
      if (runningStep) {
        runningStep.status = 'success';
      }
    }

    switch (event.type) {
      case 'EXECUTION_STARTED':
        sub.runStatus = 'RUNNING';
        assistant.isThinking = true;
        assistant.isExploring = true;
        break;
      case 'PARTIAL_THINKING': {
        assistant.isThinking = true;
        if (!assistant.thoughtSteps) assistant.thoughtSteps = [];
        let step = assistant.thoughtSteps.find(item => item.status === 'running');
        if (!step) {
          step = { id: `sub-think-${key}-${assistant.thoughtSteps.length}`, title: 'Thought for', content: '', status: 'running' };
          assistant.thoughtSteps.push(step);
        }
        step.content += event.content || event.thinking || '';
        break;
      }
      case 'PARTIAL_TEXT':
        assistant.isThinking = false;
        assistant.isExploring = false;
        assistant.content += event.content || event.text || '';
        break;
      case 'AI_MESSAGE':
        assistant.isThinking = false;
        assistant.isExploring = false;
        if (event.text ?? event.content) assistant.content = String(event.text ?? event.content);
        break;
      case 'TOOL_CALL': {
        assistant.isExploring = false;
        if (!assistant.toolCalls) assistant.toolCalls = [];
        const args = typeof event.args === 'string' ? event.args : JSON.stringify(event.args || {});
        if (!assistant.toolCalls.some(tool => tool.id === event.requestId)) {
          assistant.toolCalls.push({
            id: event.requestId || `sub-tool-${Date.now()}`,
            toolName: event.toolName || 'tool',
            query: args,
            description: args,
            status: 'calling'
          });
        }
        break;
      }
      case 'TOOL_COMPLETED': {
        if (!assistant.toolCalls) assistant.toolCalls = [];
        const output = event.output ?? event.result;
        const tool = assistant.toolCalls.find(item => item.id === event.requestId)
          || [...assistant.toolCalls].reverse().find(item => item.status === 'calling');
        if (tool) {
          tool.result = typeof output === 'string' ? output : JSON.stringify(output ?? '');
          tool.status = subEventFailed(event) ? 'failed' : 'success';
        }
        break;
      }
      case 'FILE_EDIT':
        if (!assistant.fileEdits) assistant.fileEdits = [];
        assistant.fileEdits.push({
          turnId: event.turnId,
          recordId: event.recordId,
          filePath: event.filePath || '',
          oldContent: event.oldContent,
          newContent: event.newContent,
          plusLines: event.plusLines,
          minusLines: event.minusLines
        });
        break;
      case 'CARD_PENDING': {
        // 单值事件只做通知：拉取 tool_call 权威数据 → 构建统一 promptCard（与历史同形状）
        const toolCallId = event.toolCallId != null ? String(event.toolCallId) : '';
        if (toolCallId) {
          void (async () => {
            try {
              const vo = await chatApi.fetchToolCall(toolCallId);
              const card = buildPromptCard(vo);
              if (card) {
                assistant.promptCard = card;
                subSessionMessagesMap.value[key] = [...messages];
                updateSubSession(sub);
                if (String(activeViewingSubSessionId.value) === key) scrollToBottomIfAuto();
              }
            } catch (err) {
              console.warn('[consumeSubSessionEvent] 拉取工具调用卡片失败:', err);
            }
          })();
        }
        break;
      }
      case 'CONTEXT_UPDATE': {
        if (event.phase === 'SQUEEZE_STARTED') {
          assistant.isCompressingContext = true;
        } else if (event.phase === 'SQUEEZE_COMPLETED') {
          assistant.isCompressingContext = false;
        }
        break;
      }
      case 'EXECUTION_COMPLETED': {
        sub.runStatus = 'IDLE';
        sub.lastOutcome = 'COMPLETED';
        assistant.isComplete = true;
        assistant.isThinking = false;
        assistant.isExploring = false;
        assistant.isCompressingContext = false;
        // 契约 §2.2：ExecutionCompleteEvent 只有 tokenInfo，无顶层 token 字段
        assistant.tokenInfo = event.tokenInfo;
        const total = event.tokenInfo?.totalTokenCount;
        const input = event.tokenInfo?.inputTokenCount;
        const output = event.tokenInfo?.outputTokenCount;
        if (total !== undefined && total !== null) sub.totalTokens = total;
        if (input !== undefined && input !== null) sub.inputTokens = input;
        if (output !== undefined && output !== null) sub.outputTokens = output;
        break;
      }
      case 'EXECUTION_FAILED':
      case 'EXECUTION_CANCELLED':
        sub.runStatus = 'IDLE';
        sub.lastOutcome = event.type === 'EXECUTION_CANCELLED' ? 'CANCELLED' : 'FAILED';
        assistant.isComplete = true;
        assistant.isThinking = false;
        assistant.isExploring = false;
        assistant.isCompressingContext = false;
        // 契约 §2.2：ExecutionErrorEvent 主文案恒在 errMsg
        assistant.executionError = event.errMsg?.trim() || '子代理执行失败';
        break;
    }

    subSessionMessagesMap.value[key] = [...messages];
    updateSubSession(sub);
    if (String(activeViewingSubSessionId.value) === key) scrollToBottomIfAuto();
  };

  const flushPendingSubSessionEvents = (subSessionId: string) => {
    const sub = subSessionRouteMap.value[subSessionId];
    const pending = pendingSubSessionEvents.get(subSessionId);
    if (!sub || !pending) return;
    pendingSubSessionEvents.delete(subSessionId);
    pending.forEach(event => consumeSubSessionEvent(sub, event));
  };

  const applySubSessionCreated = (data: SubAgentSessionCreatedData) => {
    const rootId = currentActiveSession.value?.id;
    if (!rootId || String(data.rootSessionId) !== String(rootId)) return;
    const key = String(data.subSessionId);
    const sub: SubSessionVO = {
      ...(subSessionRouteMap.value[key] || {}),
      id: data.subSessionId,
      rootSessionId: data.rootSessionId,
      agentId: data.agentId,
      agentName: data.agentId ? `Agent #${data.agentId}` : '子代理',
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

  /** Returns true when the event belongs to the mapping channel or to a child session. */
  const routeSessionEvent = (event: AgentStreamEvent): boolean => {
    if (event.type === 'SUB_AGENT_SESSION_CREATED') {
      if (event.data) applySubSessionCreated(event.data as SubAgentSessionCreatedData);
      return true;
    }

    // 流归属快照：所有事件一律按「本流归属会话」路由，绝不落进「响应到达时的当下会话」。
    const owningRootId = getActiveStreamOwnerSessionId();
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
