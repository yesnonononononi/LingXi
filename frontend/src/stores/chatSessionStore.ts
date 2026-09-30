import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ChatMessage, ContextUsageData } from '../types/chat';
import { createLocalId } from '../utils/ids';

export interface ExecutionTimer {
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
 * Map<sessionId, Map<executionId, messageList: ChatMessage[]>> & Map<sessionId, rootSessionId>
 */
export const useChatSessionStore = defineStore('chatSession', () => {
  // Map<sessionId: string, rootSessionId: string>
  const sessionRootMap = ref<Map<string, string>>(new Map());

  // Map<sessionId: string, Map<executionId: string, messageList: ChatMessage[]>>
  const executionMessages = ref<Map<string, Map<string, ChatMessage[]>>>(new Map());

  // 当前每个会话活跃的 executionId: Map<sessionId, executionId>
  const activeExecutionMap = ref<Map<string, string>>(new Map());

  // 执行计时器: Map<executionId, ExecutionTimer>
  const executionTimers = ref<Map<string, ExecutionTimer>>(new Map());

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

  /** 获取指定会话、指定 executionId 的消息列表引用 */
  const getExecutionMessages = (sessionId: string | number, executionId: string): ChatMessage[] => {
    const sid = String(sessionId);
    let sessionMap = executionMessages.value.get(sid);
    if (!sessionMap) {
      sessionMap = new Map();
      executionMessages.value.set(sid, sessionMap);
    }
    let list = sessionMap.get(executionId);
    if (!list) {
      list = [];
      sessionMap.set(executionId, list);
    }
    return list;
  };

  /** 获取会话的全部消息（按 execution 顺序聚合平铺） */
  const getAllMessages = (sessionId: string | number): ChatMessage[] => {
    const sid = String(sessionId);
    const sessionMap = executionMessages.value.get(sid);
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
    let sessionMap = executionMessages.value.get(sid);
    if (!sessionMap) {
      sessionMap = new Map();
      executionMessages.value.set(sid, sessionMap);
    }
    // 保留正在执行的 active execution 消息，替换 history
    const activeEid = activeExecutionMap.value.get(sid);
    const activeList = activeEid ? sessionMap.get(activeEid) || [] : [];
    sessionMap.clear();
    sessionMap.set('history', [...history]);
    if (activeEid && activeList.length > 0) {
      sessionMap.set(activeEid, activeList);
    }
  };

  /** 获取当前活跃的 executionId */
  const getActiveExecutionId = (sessionId: string | number): string => {
    const sid = String(sessionId);
    return activeExecutionMap.value.get(sid) || 'default';
  };

  /** 获取当前会话最新的 assistant 消息体 */
  const getLatestAssistantMessage = (sessionId: string | number, executionId?: string): ChatMessage | undefined => {
    const sid = String(sessionId);
    const eid = executionId || getActiveExecutionId(sid);
    const list = getExecutionMessages(sid, eid);
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === 'assistant') {
        return list[i];
      }
    }
    return undefined;
  };

  /** 初始化一轮新的执行：新增 AI 消息体并启动计时器 */
  const initExecution = (sessionId: string | number, executionId: string): ChatMessage => {
    const sid = String(sessionId);
    const eid = executionId || createLocalId('exec');
    activeExecutionMap.value.set(sid, eid);

    const list = getExecutionMessages(sid, eid);
    const newAiMessage: ChatMessage = {
      id: createLocalId('bot'),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      // 绑定本轮执行的 executionId：回答组以它为唯一键，重连/审批恢复沿用同一个 id，
      // 因此恢复流的实时气泡会并入原回答组，而不是新起一组。'default'/空表示归属未知。
      executionId: executionId && executionId !== 'default' ? executionId : null,
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
    startTimer(sid, eid);

    // 更新会话运行态
    setSessionRunStatus(sid, 'RUNNING');
    setSessionSending(sid, true);

    return newAiMessage;
  };

  /** 初始化计时器，记录时间 */
  const startTimer = (sessionId: string | number, executionId: string): void => {
    const key = executionId || String(sessionId);
    const existing = executionTimers.value.get(key);
    if (existing?.timerId) {
      clearInterval(existing.timerId);
    }

    const timer: ExecutionTimer = {
      startTime: Date.now(),
      elapsedSeconds: 0
    };

    timer.timerId = window.setInterval(() => {
      timer.elapsedSeconds = Math.max(0, Math.floor((Date.now() - timer.startTime) / 1000));
    }, 1000);

    executionTimers.value.set(key, timer);
  };

  /** 关闭计时器，返回总用时毫秒数 */
  const stopTimer = (sessionId: string | number, executionId: string): number => {
    const key = executionId || String(sessionId);
    const timer = executionTimers.value.get(key);
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
  const getTimerDuration = (sessionId: string | number, executionId?: string): number => {
    const sid = String(sessionId);
    const key = executionId || activeExecutionMap.value.get(sid) || sid;
    const timer = executionTimers.value.get(key);
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

  /** 获取会话上下文指标 */
  const getContextUsage = (sessionId: string | number): ContextUsageData | undefined => {
    const sid = String(sessionId);
    return contextUsageMap.value.get(sid);
  };

  return {
    sessionRootMap,
    executionMessages,
    activeExecutionMap,
    executionTimers,
    sessionStatusMap,
    contextUsageMap,
    bindSessionRoot,
    isSubSession,
    getRootSessionId,
    getExecutionMessages,
    getAllMessages,
    syncHistoryMessages,
    getActiveExecutionId,
    getLatestAssistantMessage,
    initExecution,
    startTimer,
    stopTimer,
    getTimerDuration,
    setSessionSending,
    setSessionRunStatus,
    getSessionState,
    setContextUsage,
    getContextUsage
  };
});
