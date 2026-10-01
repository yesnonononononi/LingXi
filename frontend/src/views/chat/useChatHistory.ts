import { ref, nextTick } from 'vue';
import type { Ref, ComputedRef } from 'vue';
import type { ChatSession, ChatMessage, ChatTurn, SessionMessageVO } from '../../types/chat';
import { chatApi } from '../../services/chat';
import { useChatSessionStore } from '../../stores/chatSessionStore';
import { mergeRawRecords, aggregateSessionMessages, normalizeTurnId } from '../../utils/session';

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
 * 轮次摘要字典的 union 合并：键为 turnId，**后到的覆盖先到的**（更新的快照更准确）。
 * 缺省空对象；绝不因某一页没有 turns 而丢弃已加载的摘要。
 */
export function mergeTurns(
  base: Record<string, ChatTurn> | undefined,
  incoming: Record<string, ChatTurn> | undefined
): Record<string, ChatTurn> {
  const merged: Record<string, ChatTurn> = { ...(base || {}) };
  if (incoming) {
    for (const [turnId, summary] of Object.entries(incoming)) {
      if (summary) merged[turnId] = summary;
    }
  }
  return merged;
}

/**
 * 主流结束后的消息级权威对账合并：
 * 以服务端落库行为权威基底重建本地列表（后端行 id 与本地流式聚合气泡 id 不同源，
 * 按 id 收编后本地已完成的聚合气泡/用户行随之被权威行替换，避免同一轮内容重复展示）。
 * 仅保留两类本地行（原相对序，追加末尾）：
 * - 未完成 running 气泡（assistant 且 isComplete=false，等待下一轮刷新收编）；
 * - 对账发起之后新写入的在途行（对账请求期间用户又开启新流的 live 行），按发起时刻时间戳判定。
 * 绝不因对账失败或服务端返回为空清空本地状态。
 *
 * <p>同时合并 turns 摘要字典（union）。注意：同一 turnId 的消息可能跨页
 * （页首 TOOL 行、其 AI 行在下一页），此处**只按 messageId 去重**，绝不把「同 turnId
 * 但来自另一页」的消息整块丢弃 —— 那会凭空丢消息。摘要是幂等的旁路数据，与消息合并互不影响。</p>
 */
export function mergeAuthoritativeMessages(
  existing: ChatMessage[],
  serverMsgs: ChatMessage[],
  reconcileStartedAt: number,
  existingTurns?: Record<string, ChatTurn>,
  serverTurns?: Record<string, ChatTurn>
): { messages: ChatMessage[]; turns: Record<string, ChatTurn> } {
  const turns = mergeTurns(existingTurns, serverTurns);
  if (serverMsgs.length === 0) return { messages: existing, turns };
  const serverIds = new Set(serverMsgs.map(m => String(m.id)));
  const serverTurnIds = new Set(
    serverMsgs.map(m => normalizeTurnId(m.turnId)).filter((tid): tid is string => tid !== null)
  );

  const kept = existing.filter(m => {
    if (serverIds.has(String(m.id))) return false;
    const mTurnId = normalizeTurnId(m.turnId);
    // 已经由服务端落库的轮次，不再保留本地已完成的旧气泡（避免同一轮次出现本地与服务端两个气泡）
    if (mTurnId && serverTurnIds.has(mTurnId)) {
      if (m.role === 'assistant' && m.isComplete) return false;
    }
    if (m.role === 'assistant' && m.isComplete === false) return true;
    return m.timestamp > reconcileStartedAt;
  });
  return { messages: [...serverMsgs, ...kept], turns };
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
  const sessionStore = useChatSessionStore();

  /** 把 tree 下发的上下文用量快照种进用量表（root + 全部子会话；仅在会话尚无数据时写入）。 */
  const seedContextUsageFromTree = (rootId: string | number, tree: {
    root?: { contextTokenCount?: number | null; contextMaxTokens?: number | null; contextRatio?: number | null } | null;
    subSessions?: Array<{ id: string | number; contextTokenCount?: number | null; contextMaxTokens?: number | null; contextRatio?: number | null }>;
  } | null) => {
    if (!tree) return;
    if (tree.root) sessionStore.seedContextUsage(rootId, tree.root);
    (tree.subSessions || []).forEach(sub => sessionStore.seedContextUsage(sub.id, sub));
  };

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
        }
        // 终态后 session 表的上下文用量快照刚被回写：随树种入用量表（无数据不覆盖 live 值）。
        seedContextUsageFromTree(tree.rootSessionId ?? ownerSessionId, tree);
      }
    } catch (e) {
      console.warn('刷新子会话列表失败:', e);
    }
    // 消息级权威对账：分页回溯拉取全量落库行（上限 10 页防失控），按 id 收编
    try {
      const reconcileStartedAt = Date.now();
      const pageRecordsList: SessionMessageVO[][] = [];
      // 逐页收集轮次字典（fetch 顺序为「最新 → 更早」），循环结束后按「旧 → 新」折叠，
      // 使更新（更靠新页）的快照在 union 中覆盖更早的，符合「更新的快照更准确」。
      const pageTurnsList: Array<Record<string, ChatTurn>> = [];
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
        pageRecordsList.unshift(msgRes.data.records);
        pageTurnsList.push(msgRes.data.turns);
        if (!msgRes.data.hasMore || !msgRes.data.nextCursor) break;
        cursor = msgRes.data.nextCursor;
      }
      if (reconcileOk) {
        const cur = localSessions.value.find(s => s.id === ownerSessionId);
        if (cur) {
          // 页面按「最新 → 更早」收集，倒序折叠让「更靠新页」的快照最后写入而胜出
          let serverTurns: Record<string, ChatTurn> = {};
          for (let k = pageTurnsList.length - 1; k >= 0; k--) {
            serverTurns = mergeTurns(serverTurns, pageTurnsList[k]);
          }
          let fetchedRecords: SessionMessageVO[] = [];
          for (const recs of pageRecordsList) {
            fetchedRecords = mergeRawRecords(fetchedRecords, recs);
          }
          cur.rawRecords = mergeRawRecords(fetchedRecords, cur.rawRecords || []);
          const serverMsgs = aggregateSessionMessages(cur.rawRecords, cur.id);

          // 合并为同步动作，existing 取执行时刻现值：对账在途期间新写入的 live 行按时间戳/running 规则保留
          const merged = mergeAuthoritativeMessages(
            cur.messages || [],
            serverMsgs,
            reconcileStartedAt,
            cur.turns,
            serverTurns
          );
          cur.messages = merged.messages;
          cur.turns = merged.turns;
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

      // 1. 本页涉及的轮次并入会话轮次表（union）
      session.turns = mergeTurns(session.turns, pageResult.turns);

      // 2. 原始记录合并与重聚合（核心修复：消除跨页同一轮次割裂成两个气泡）
      const combinedRecords = mergeRawRecords(pageResult.records, session.rawRecords || []);
      session.rawRecords = combinedRecords;

      // 3. 从合并后的完整原始记录统一按 turnId 聚合展示消息
      const aggregated = aggregateSessionMessages(combinedRecords, session.id);

      // 4. 前置插入前精准记录高度与当前滚动偏移
      messagesContainerRef.value?.beforePrepend();

      // 5. 替换为聚合后的完整消息列表
      session.messages = aggregated;
      if (aggregated.length > 0) {
        lastKnownFirstMsgId.value = aggregated[0]?.id || lastKnownFirstMsgId.value;
      }

      // 6. 在 DOM 渲染前的首个 microtask 立即同步补偿 scrollTop，彻底消除位置突变与闪屏
      await nextTick();
      messagesContainerRef.value?.afterPrepend();

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
    seedContextUsageFromTree,
    mergeAuthoritativeMessages,
  };
}
