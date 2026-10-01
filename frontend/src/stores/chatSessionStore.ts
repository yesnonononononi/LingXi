import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ChatMessage, ContextUsageData } from '../types/chat';
import { createLocalId } from '../utils/ids';

export interface TurnTimer {
  startTime: number;
  elapsedSeconds: number;
  durationMs?: number;
  timerId?: any;
}

export interface SessionRunState {
  runStatus: 'IDLE' | 'RUNNING' | 'SUSPENDED';
  lastOutcome?: 'COMPLETED' | 'FAILED' | 'CANCELLED' | null;
  isSending: boolean;
}

/**
 * ChatSessionStore:
 * 承载 pinia 状态管理：
 * Map<sessionId, Map<turnId, messageList: ChatMessage[]>> & Map<sessionId, rootSessionId>
 */
export const useChatSessionStore = defineStore('chatSession', () => {
  // Map<sessionId: string, rootSessionId: string>
  const sessionRootMap = ref<Map<string, string>>(new Map());

  // Map<sessionId: string, Map<turnId: string, messageList: ChatMessage[]>>
  const turnMessages = ref<Map<string, Map<string, ChatMessage[]>>>(new Map());

  // 当前每个会话活跃的 turnId: Map<sessionId, turnId>
  const activeTurnMap = ref<Map<string, string>>(new Map());

  // 轮次计时器: Map<turnId, TurnTimer>
  const turnTimers = ref<Map<string, TurnTimer>>(new Map());

  // 各会话执行状态: Map<sessionId, SessionRunState>
  const sessionStatusMap = ref<Map<string, SessionRunState>>(new Map());

  // 上下文用量: Map<sessionId, ContextUsageData>
  const contextUsageMap = ref<Map<string, ContextUsageData>>(new Map());

  /** 绑定会话与其根会话映射 */
  const bindSessionRoot = (sessionId: string | number, rootSessionId: string | number | null | undefined): void => {
    const sid = String(sessionId);
    const rsid = rootSessionId != null ? String(rootSessionId) : sid;
    sessionRootMap.value.set(sid, rsid);
  };

  /** 判断是否为子会话 */
  const isSubSession = (sessionId: string | number): boolean => {
    const sid = String(sessionId);
    const rsid = sessionRootMap.value.get(sid);
    return Boolean(rsid && rsid !== '' && rsid !== sid && rsid !== '0');
  };

  /** 获取归属根会话 ID */
  const getRootSessionId = (sessionId: string | number): string => {
    const sid = String(sessionId);
    return sessionRootMap.value.get(sid) || sid;
  };

  /** 获取指定会话、指定 turnId 的消息列表引用 */
  const getTurnMessages = (sessionId: string | number, turnId: string): ChatMessage[] => {
    const sid = String(sessionId);
    let sessionMap = turnMessages.value.get(sid);
    if (!sessionMap) {
      sessionMap = new Map();
      turnMessages.value.set(sid, sessionMap);
    }
    let list = sessionMap.get(turnId);
    if (!list) {
      list = [];
      sessionMap.set(turnId, list);
    }
    return list;
  };

  /** 获取会话的全部消息（按轮次顺序聚合平铺） */
  const getAllMessages = (sessionId: string | number): ChatMessage[] => {
    const sid = String(sessionId);
    const sessionMap = turnMessages.value.get(sid);
    if (!sessionMap) return [];
    const all: ChatMessage[] = [];
    for (const msgList of sessionMap.values()) {
      all.push(...msgList);
    }
    return all;
  };

  /** 同步历史消息（从后端全量或分页拉取时写入默认 history 分桶） */
  const syncHistoryMessages = (sessionId: string | number, history: ChatMessage[]): void => {
    const sid = String(sessionId);
    let sessionMap = turnMessages.value.get(sid);
    if (!sessionMap) {
      sessionMap = new Map();
      turnMessages.value.set(sid, sessionMap);
    }
    // 保留正在执行的 active turn 消息，替换 history
    const activeTid = activeTurnMap.value.get(sid);
    const activeList = activeTid ? sessionMap.get(activeTid) || [] : [];
    sessionMap.clear();
    sessionMap.set('history', [...history]);
    if (activeTid && activeList.length > 0) {
      sessionMap.set(activeTid, activeList);
    }
  };

  /** 获取当前活跃的 turnId */
  const getActiveTurnId = (sessionId: string | number): string => {
    const sid = String(sessionId);
    return activeTurnMap.value.get(sid) || 'default';
  };

  /** 获取当前会话最新的 assistant 消息体 */
  const getLatestAssistantMessage = (sessionId: string | number, turnId?: string): ChatMessage | undefined => {
    const sid = String(sessionId);
    const tid = turnId || getActiveTurnId(sid);
    const list = getTurnMessages(sid, tid);
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === 'assistant') {
        return list[i];
      }
    }
    return undefined;
  };

  /** 初始化一轮新的轮次：新增或复用 AI 消息体并启动计时器 */
  const initTurn = (sessionId: string | number, turnId: string): ChatMessage => {
    const sid = String(sessionId);
    const tid = turnId || createLocalId('turn');
    activeTurnMap.value.set(sid, tid);

    const list = getTurnMessages(sid, tid);

    // 检查当前轮次列表中是否已有 assistant 消息体（审批恢复、暂停恢复、重新订阅等场景）
    const existingAi = list.find(m => m.role === 'assistant');
    if (existingAi) {
      existingAi.isComplete = false;
      existingAi.isThinking = true;
      existingAi.isExploring = false;
      if (!existingAi.turnId && turnId && turnId !== 'default') {
        existingAi.turnId = turnId;
        existingAi.id = `msg-${sid}-turn-${turnId}`;
      }
      startTimer(sid, tid);
      setSessionRunStatus(sid, 'RUNNING');
      setSessionSending(sid, true);
      return existingAi;
    }

    const stableTurnId = turnId && turnId !== 'default' ? turnId : null;
    const msgId = stableTurnId ? `msg-${sid}-turn-${stableTurnId}` : createLocalId('bot');

    const newAiMessage: ChatMessage = {
      id: msgId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      // 绑定本轮的业务轮次 id：回答组以它为唯一键，重连/审批恢复沿用同一个 id，
      // 因此恢复流的实时气泡会并入原回答组，而不是新起一组。'default'/空表示归属未知。
      turnId: stableTurnId,
      isThinking: true,
      isExploring: true,
      isComplete: false,
      thoughtSteps: [],
      toolCalls: [],
      aiMessages: [],
      fileEdits: []
    };
    list.push(newAiMessage);

    // 启动计时器
    startTimer(sid, tid);

    // 更新会话运行态
    setSessionRunStatus(sid, 'RUNNING');
    setSessionSending(sid, true);

    return newAiMessage;
  };

  /** 初始化计时器，记录时间 */
  const startTimer = (sessionId: string | number, turnId: string): void => {
    const key = turnId || String(sessionId);
    const existing = turnTimers.value.get(key);
    if (existing?.timerId) {
      clearInterval(existing.timerId);
    }

    const timer: TurnTimer = {
      startTime: Date.now(),
      elapsedSeconds: 0
    };

    timer.timerId = window.setInterval(() => {
      timer.elapsedSeconds = Math.max(0, Math.floor((Date.now() - timer.startTime) / 1000));
    }, 1000);

    turnTimers.value.set(key, timer);
  };

  /** 关闭计时器，返回总用时毫秒数 */
  const stopTimer = (sessionId: string | number, turnId: string): number => {
    const key = turnId || String(sessionId);
    const timer = turnTimers.value.get(key);
    if (!timer) return 0;
    if (timer.timerId) {
      clearInterval(timer.timerId);
      timer.timerId = undefined;
    }
    const duration = Date.now() - timer.startTime;
    timer.durationMs = duration;
    return duration;
  };

  /** 获取当前计时器时长 */
  const getTimerDuration = (sessionId: string | number, turnId?: string): number => {
    const sid = String(sessionId);
    const key = turnId || activeTurnMap.value.get(sid) || sid;
    const timer = turnTimers.value.get(key);
    if (!timer) return 0;
    return timer.durationMs ?? (Date.now() - timer.startTime);
  };

  /** 设置会话发送态（控制输入框暂停/发送按钮切换） */
  const setSessionSending = (sessionId: string | number, isSending: boolean): void => {
    const sid = String(sessionId);
    const current = sessionStatusMap.value.get(sid) || { runStatus: 'IDLE', isSending: false };
    sessionStatusMap.value.set(sid, { ...current, isSending });
  };

  /** 设置会话运行态 */
  const setSessionRunStatus = (
    sessionId: string | number,
    runStatus: 'IDLE' | 'RUNNING' | 'SUSPENDED',
    lastOutcome?: 'COMPLETED' | 'FAILED' | 'CANCELLED' | null
  ): void => {
    const sid = String(sessionId);
    const current = sessionStatusMap.value.get(sid) || { runStatus: 'IDLE', isSending: false };
    sessionStatusMap.value.set(sid, {
      ...current,
      runStatus,
      lastOutcome: lastOutcome !== undefined ? lastOutcome : current.lastOutcome,
      isSending: runStatus === 'RUNNING'
    });
  };

  /** 获取会话运行态 */
  const getSessionState = (sessionId: string | number): SessionRunState => {
    const sid = String(sessionId);
    return sessionStatusMap.value.get(sid) || { runStatus: 'IDLE', isSending: false, lastOutcome: null };
  };

  /** 设置会话上下文压缩/用量指标 */
  const setContextUsage = (sessionId: string | number, usage: ContextUsageData): void => {
    const sid = String(sessionId);
    contextUsageMap.value.set(sid, usage);
  };

  /**
   * 种入「上下文用量快照」（tree 接口下发的 session 表快照）。
   *
   * <p>定位：指示器的实时口径来自 {@code CONTEXT_UPDATE} 事件，但事件只在 loop 运行期间发布——
   * 加载历史会话（刷新页面 / 切换会话）时永远等不到事件。本方法把 tree 下发的会话表快照
   * 种进用量表，作为无事件空窗的权威数据源。</p>
   *
   * <p><b>只在会话尚无用量数据时写入</b>：运行中事件驱动的值更新鲜，绝不能被
   * reconcile 拉回的较旧快照覆盖。快照缺 tokenCount（尚未采集）时同样跳过，不伪造 0。</p>
   */
  const seedContextUsage = (
    sessionId: string | number,
    snapshot: { contextTokenCount?: number | null; contextMaxTokens?: number | null; contextRatio?: number | null }
  ): void => {
    if (snapshot.contextTokenCount == null || snapshot.contextTokenCount <= 0) return;
    const sid = String(sessionId);
    const existing = contextUsageMap.value.get(sid);
    if (existing && existing.tokenCount != null && existing.tokenCount > 0) return;
    contextUsageMap.value.set(sid, {
      phase: 'SNAPSHOT',
      tokenCount: snapshot.contextTokenCount,
      maxTokens: snapshot.contextMaxTokens ?? undefined,
      ratio: snapshot.contextRatio ?? undefined
    });
  };

  /** 获取会话上下文指标 */
  const getContextUsage = (sessionId: string | number): ContextUsageData | undefined => {
    const sid = String(sessionId);
    return contextUsageMap.value.get(sid);
  };

  return {
    sessionRootMap,
    turnMessages,
    activeTurnMap,
    turnTimers,
    sessionStatusMap,
    contextUsageMap,
    bindSessionRoot,
    isSubSession,
    getRootSessionId,
    getTurnMessages,
    getAllMessages,
    syncHistoryMessages,
    getActiveTurnId,
    getLatestAssistantMessage,
    initTurn,
    startTimer,
    stopTimer,
    getTimerDuration,
    setSessionSending,
    setSessionRunStatus,
    getSessionState,
    setContextUsage,
    seedContextUsage,
    getContextUsage
  };
});
