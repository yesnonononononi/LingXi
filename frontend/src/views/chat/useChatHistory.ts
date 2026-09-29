import { ref, nextTick } from 'vue';
import type { Ref, ComputedRef } from 'vue';
import type { ChatSession, ChatMessage } from '../../types/chat';
import { chatApi } from '../../services/chat';

/** 加载更多历史时保证加载动画可见的最短展示时长（毫秒） */
const HISTORY_PREPEND_SETTLE_MS = 350;
/** 加载更多历史结束后收起 loading 的延时（毫秒） */
const HISTORY_LOADING_SETTLE_MS = 200;

export interface ChatHistoryOptions {
  currentActiveSession: ComputedRef<ChatSession | null | undefined>;
  localSessions: Ref<ChatSession[]>;
  messagesContainerRef: Ref<any>;
  lastKnownFirstMsgId: Ref<string | null>;
  scheduleTimeout: (handler: () => void, delayMs: number) => number;
}

/**
 * 主流结束后的消息级权威对账合并：
 * 以服务端落库行为权威基底重建本地列表（后端行 id 与本地流式聚合气泡 id 不同源，
 * 按 id 收编后本地已完成的聚合气泡/用户行随之被权威行替换，避免同一轮内容重复展示）。
 * 仅保留两类本地行（原相对序，追加末尾）：
 * - 未完成 running 气泡（assistant 且 isComplete=false，等待下一轮刷新收编）；
 * - 对账发起之后新写入的在途行（对账请求期间用户又开启新流的 live 行），按发起时刻时间戳判定。
 * 绝不因对账失败或服务端返回为空清空本地状态。
 */
export function mergeAuthoritativeMessages(
  existing: ChatMessage[],
  serverMsgs: ChatMessage[],
  reconcileStartedAt: number
): ChatMessage[] {
  if (serverMsgs.length === 0) return existing;
  const serverIds = new Set(serverMsgs.map(m => String(m.id)));
  const kept = existing.filter(m => {
    if (serverIds.has(String(m.id))) return false;
    if (m.role === 'assistant' && m.isComplete === false) return true;
    return m.timestamp > reconcileStartedAt;
  });
  return [...serverMsgs, ...kept];
}

export function useChatHistory(options: ChatHistoryOptions) {
  const {
    currentActiveSession,
    localSessions,
    messagesContainerRef,
    lastKnownFirstMsgId,
    scheduleTimeout,
  } = options;

  const isLoadingMoreHistory = ref(false);
  const historyLoadError = ref('');

  /**
   * 流结束后的统一串行对账（tree + 权威消息，尽力而为）：
   * chat 主流 onFinish 与 decide 决策恢复流结束点共用。
   */
  const reconcileSessionAfterStream = async (ownerSessionId: string) => {
    // 树对账：刷新归属会话的子会话列表与 token 统计
    try {
      const treeRes = await chatApi.fetchSessionTree(ownerSessionId);
      if (!treeRes.ok) {
        console.warn('刷新子会话列表失败:', treeRes.error);
      } else {
        const tree = treeRes.data;
        const cur = localSessions.value.find(s => s.id === ownerSessionId);
        if (cur) {
          if (tree.subSessions.length > 0) cur.subSessions = tree.subSessions;
          if (tree.root) {
            if (tree.root.totalTokens) cur.totalTokens = tree.root.totalTokens;
            if (tree.root.inputTokens) cur.inputTokens = tree.root.inputTokens;
            if (tree.root.outputTokens) cur.outputTokens = tree.root.outputTokens;
          }
        }
      }
    } catch (e) {
      console.warn('刷新子会话列表失败:', e);
    }
    // 消息级权威对账：分页回溯拉取全量落库行（上限 10 页防失控），按 id 收编
    try {
      const reconcileStartedAt = Date.now();
      const serverMsgs: ChatMessage[] = [];
      let cursor: string | null = null;
      let reconcileOk = true;
      for (let pageIdx = 0; pageIdx < 10; pageIdx++) {
        const msgRes = await chatApi.fetchSessionMessages(ownerSessionId, cursor, 100);
        if (!msgRes.ok) {
          reconcileOk = false;
          console.warn('主流结束消息对账失败:', msgRes.error);
          break;
        }
        // 游标从最新页向更早回溯：前插拼接保持「旧 → 新」顺序
        serverMsgs.unshift(...msgRes.data.messages);
        if (!msgRes.data.hasMore || !msgRes.data.nextCursor) break;
        cursor = msgRes.data.nextCursor;
      }
      if (reconcileOk) {
        const cur = localSessions.value.find(s => s.id === ownerSessionId);
        if (cur) {
          // 合并为同步动作，existing 取执行时刻现值：对账在途期间新写入的 live 行按时间戳/running 规则保留
          cur.messages = mergeAuthoritativeMessages(cur.messages || [], serverMsgs, reconcileStartedAt);
        }
      }
    } catch (e) {
      console.warn('主流结束消息对账失败:', e);
    }
  };

  const handleLoadMoreHistory = async () => {
    if (!currentActiveSession.value || isLoadingMoreHistory.value) return;
    const session = currentActiveSession.value;
    if (!session.hasMoreMessages || !session.nextMessageCursor) return;

    isLoadingMoreHistory.value = true;
    historyLoadError.value = '';
    const startTime = Date.now();
    try {
      const pageResultRes = await chatApi.fetchSessionMessages(session.id, session.nextMessageCursor, 50);

      // 保证加载动画平滑展示，消除接口瞬间返回造成的闪屏
      const elapsed = Date.now() - startTime;
      if (elapsed < HISTORY_PREPEND_SETTLE_MS) {
        await new Promise<void>(resolve => scheduleTimeout(resolve, HISTORY_PREPEND_SETTLE_MS - elapsed));
      }

      if (!pageResultRes.ok) {
        historyLoadError.value = pageResultRes.error;
        return;
      }
      const pageResult = pageResultRes.data;

      if (pageResult.messages.length > 0) {
        const existingIds = new Set(session.messages.map(m => m.id));
        const freshMessages = pageResult.messages.filter(m => !existingIds.has(m.id));
        if (freshMessages.length > 0) {
          lastKnownFirstMsgId.value = freshMessages[0]?.id || lastKnownFirstMsgId.value;

          // 1. 前置插入前精准记录高度与当前滚动偏移
          messagesContainerRef.value?.beforePrepend();

          // 2. 将历史记录前置插入列表顶部
          session.messages.unshift(...freshMessages);

          // 3. 在 DOM 渲染前的首个 microtask 立即同步补偿 scrollTop，彻底消除位置突变与闪屏
          await nextTick();
          messagesContainerRef.value?.afterPrepend();
        }
      }
      session.hasMoreMessages = pageResult.hasMore;
      session.nextMessageCursor = pageResult.nextCursor;
    } catch (err) {
      // 失败不再静默：转圈消失会让用户误以为「已到底」，这里保留可见失败态并可重试
      console.error('加载更多历史消息失败:', err);
      historyLoadError.value = '加载历史消息失败，请重试';
    } finally {
      await nextTick();
      scheduleTimeout(() => {
        isLoadingMoreHistory.value = false;
      }, HISTORY_LOADING_SETTLE_MS);
    }
  };

  const handleRetryLoadMoreHistory = () => {
    historyLoadError.value = '';
    void handleLoadMoreHistory();
  };

  return {
    isLoadingMoreHistory,
    historyLoadError,
    handleLoadMoreHistory,
    handleRetryLoadMoreHistory,
    reconcileSessionAfterStream,
    mergeAuthoritativeMessages,
  };
}
