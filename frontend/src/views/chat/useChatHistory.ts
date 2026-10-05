import { ref, nextTick } from 'vue';
import type { Ref, ComputedRef } from 'vue';
import type { ChatSession } from '../../types/chat';
import { chatApi } from '../../services/chat';
import { useChatSessionStore } from '../../stores/chatSessionStore';
import { useStreamV3Store } from '../../stores/streamV3Store';

/** 加载更多历史时保证加载动画可见的最短展示时长（毫秒） */
const HISTORY_PREPEND_SETTLE_MS = 350;
/** 加载更多历史结束后收起 loading 的延时（毫秒） */
const HISTORY_LOADING_SETTLE_MS = 200;

export interface ChatHistoryOptions {
  currentActiveSession: ComputedRef<ChatSession | null | undefined>;
  localSessions: Ref<ChatSession[]>;
  messagesContainerRef: Ref<any>;
  scheduleTimeout: (handler: () => void, delayMs: number) => number;
}

/**
 * 会话历史：持久化行的唯一去处是 **v3 状态源**。
 *
 * <p>视图（{@code messageProjection}）从 v3 的历史槽 + 未提交活响应派生消息数组；
 * 本模块只负责「拉取 → 写入 v3」与**分页请求状态**（hasMore / cursor / loading / 失败态）。
 * 不再维护本地的消息表、原始行表或轮次摘要表 —— 第 3／4 组删除后，那三张兼容表已不存在。</p>
 *
 * <p><b>滚动补偿</b>：前置插入会让派生视图变长。在写入 v3 **之前**记录高度与偏移，
 * 渲染完成后恢复 —— 派生数组的变更由 useChatView 的 watch 感知并据此判断「这是前置插入」，
 * 不再需要本模块替它算首尾 id。</p>
 */
export function useChatHistory(options: ChatHistoryOptions) {
  const {
    currentActiveSession,
    localSessions,
    messagesContainerRef,
    scheduleTimeout,
  } = options;

  const isLoadingMoreHistory = ref(false);
  const historyLoadError = ref('');
  const sessionStore = useChatSessionStore();
  const streamV3 = useStreamV3Store();

  /**
   * 把会话 id 归到根会话 id（与后端「事件按根会话路由」同一口径），供 v3 历史槽定位。
   *
   * <p>历史页是按**会话自身**请求的（子会话有自己的历史），但 v3 历史槽按根会话的树组织时
   * 需要子会话各自的槽 —— 因此这里返回**请求所用会话 id**，不做根化：写入时按该会话 id 入槽，
   * 视图适配层再按根会话树把子会话槽一并聚合。</p>
   */
  const v3HistoryKey = (sessionId: string | number): string => String(sessionId);

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
   *
   * <p>消息侧只做「分页回溯 → 写入 v3」（上限 10 页防失控）：首页是代际基准（整页替换，
   * 清掉可能过期的旧行），其后更早的页追加合并。**不做本地消息合并** —— 那是旧消息表时代
   * 的收编逻辑，v3 的版本合并（{@code shouldApply}）天然幂等，重复写不会产生重复气泡。</p>
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
            cur.runStatus = tree.root.runStatus;
            cur.lastOutcome = tree.root.lastOutcome;
          }
        }
        // 终态后 session 表的上下文用量快照刚被回写：随树种入用量表（无数据不覆盖 live 值）。
        seedContextUsageFromTree(tree.rootSessionId ?? ownerSessionId, tree);
      }
    } catch (e) {
      console.warn('刷新子会话列表失败:', e);
    }
    // 消息级权威对账：写入 v3
    try {
      // 发起时快照代际：对账是多次网络往返，期间若代际被推进（如重发触发 HISTORY_INVALIDATED），
      // 返回的旧快照必须**整体丢弃** —— 快照缺行不等于行被删除，替换会把实时写入的新行抹掉。
      const expectedRevision = streamV3.currentHistoryRevision(v3HistoryKey(ownerSessionId));
      let cursor: string | null = null;
      let hasMore = false;
      for (let pageIdx = 0; pageIdx < 10; pageIdx++) {
        const msgRes = await chatApi.fetchSessionMessages(ownerSessionId, cursor, 100);
        if (!msgRes.ok) {
          console.warn('主流结束消息对账失败:', msgRes.error);
          return;
        }
        // 全部走**同代际合并**：首页不再是「整体替换」—— 首页基准由受同步屏障保护的 bootstrap
        // 建立；对账只在与当前代际一致时合并事实，绝不因快照缺行就清掉实时写入的行。
        if (!streamV3.ingestHistoryPage(v3HistoryKey(ownerSessionId), msgRes.data, expectedRevision)) {
          console.warn('[history] 过期代际的对账快照，已整体丢弃:', ownerSessionId);
          return;
        }
        hasMore = msgRes.data.hasMore;
        if (!msgRes.data.hasMore || !msgRes.data.nextCursor) break;
        cursor = msgRes.data.nextCursor;
      }
      if (!hasMore) {
        const cur = localSessions.value.find(s => s.id === ownerSessionId);
        if (cur) {
          cur.hasMoreMessages = false;
          cur.nextMessageCursor = null;
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
    // 发起时快照代际：分页是网络往返，期间若发生重发（代际推进），返回的旧页必须丢弃。
    const expectedRevision = streamV3.currentHistoryRevision(String(session.id));
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

      // 写入 v3（同代际才应用；过期代际整体丢弃 —— 不写、不补偿、不推进游标）
      const applied = streamV3.ingestHistoryPage(v3HistoryKey(session.id), pageResultRes.data, expectedRevision);
      if (!applied) return;

      // 滚动补偿：写入已触发响应式更新，但 DOM 尚未重渲染 —— 此刻记录高度与偏移，
      // 渲染完成后恢复。前置插入的判定由 useChatView 的派生视图 watch 完成。
      messagesContainerRef.value?.beforePrepend();
      await nextTick();
      messagesContainerRef.value?.afterPrepend();

      // 分页请求状态属于会话实体的**界面状态**（hasMore / cursor），不是消息数据。
      session.hasMoreMessages = pageResultRes.data.hasMore;
      session.nextMessageCursor = pageResultRes.data.nextCursor;
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
  };
}
