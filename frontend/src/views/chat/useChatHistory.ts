import { ref, nextTick } from 'vue';
import type { Ref, ComputedRef } from 'vue';
import type { ChatSession, ChatTurn, SessionMessageVO } from '../../types/chat';
import type { TurnViewVO } from '../../types/block';
import { chatApi } from '../../services/chat';
import { aggregateRecordsByIdentity, mergeRawRecords, mergeTurns, mergeTurnViews, mergeSubSessionTree, mergeMessagesByTurn, synthesizeFailedTurnBubbles } from '../../utils/session';
import { useChatSessionStore } from '../../stores/chatSessionStore';

/** 加载更多历史时保证加载动画可见的最短展示时长（毫秒） */
const HISTORY_PREPEND_SETTLE_MS = 350;
/** 加载更多历史结束后收起 loading 的延时（毫秒） */
const HISTORY_LOADING_SETTLE_MS = 200;
/** 回查时最多回溯的页数（每页 100 条），防失控。 */
const RECONCILE_MAX_PAGES = 10;

export interface ChatHistoryOptions {
  currentActiveSession: ComputedRef<ChatSession | null | undefined>;
  localSessions: Ref<ChatSession[]>;
  messagesContainerRef: Ref<any>;
  scheduleTimeout: (handler: () => void, delayMs: number) => number;
}

/**
 * 会话历史：拉取分页并写回会话实体的消息数组。
 *
 * <p><b>写入规则（本期最易做错的一处）</b>：不能用「按消息 id 追加」也不能「整体替换」——
 * 实时助手气泡 id 形如 {@code bubble-<sessionId>-<turnId>}，历史消息 id 形如
 * {@code msg-<sessionId>-turn-<turnId>}，同一轮的两个 id 不同。统一走
 * {@link mergeMessagesByTurn} 按权威 turnId 分轮处理。</p>
 *
 * <p><b>查询响应版本控制</b>：每次发起回查自增一个版本号，响应回来时版本已变即整份丢弃。
 * 这是少量请求级版本控制（不是投影缓冲）：切走会话 / 重连 / 执行状态变化都会作废在途响应，
 * 避免「旧会话的迟到响应覆盖新会话」。</p>
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

  /** 回查请求版本号：只有发起时版本仍然最新的响应才允许写回。 */
  let reconcileVersion = 0;

  /**
   * 作废所有在途回查响应。
   *
   * <p>在「切换会话 / 重连 / 执行状态变化」时调用：这些事件之后的一切回查结果都来自旧的世界，
   * 写回去就是把上一个会话的数据糊到当前界面上。</p>
   */
  const invalidateReconcile = (): void => { reconcileVersion += 1; };

  /** 把 tree 下发的上下文用量快照种进用量表（root + 全部子会话）。 */
  const seedContextUsageFromTree = (rootId: string | number, tree: {
    root?: { contextTokenCount?: number | null; contextMaxTokens?: number | null; contextRatio?: number | null } | null;
    subSessions?: Array<{ id: string | number; contextTokenCount?: number | null; contextMaxTokens?: number | null; contextRatio?: number | null }>;
  } | null) => {
    if (!tree) return;
    if (tree.root) sessionStore.seedContextUsage(rootId, tree.root);
    (tree.subSessions || []).forEach(sub => sessionStore.seedContextUsage(sub.id, sub));
  };

  /**
   * 回读会话权威状态并按分轮规则写回（tree + 消息，尽力而为）。
   *
   * <p>三个对齐入口都走这里：<b>进入会话</b>、<b>重连成功后</b>、<b>本轮终结或挂起后</b>。
   * 用户切走时执行仍在跑、跑完时没人收终态事件 —— 「进入会话回查」是这类场景唯一的对齐入口，
   * 因此这里必须无条件执行，不能只在「检测到掉线」时才做。</p>
   *
   * @param ownerSessionId 回查的会话（根会话 id）
   * @param terminalTurnIds 已确认终结的轮次；这些轮用权威历史整体替换。
   *                        未列出的轮次一律保留本地正文，只用历史补齐过程数据。
   */
  const reconcileSessionAfterStream = async (
    ownerSessionId: string,
    terminalTurnIds?: string[] | null,
  ) => {
    const version = ++reconcileVersion;

    try {
      const treeRes = await chatApi.fetchSessionTree(ownerSessionId);
      if (version !== reconcileVersion) return;
      if (!treeRes.ok) {
        console.warn('刷新子会话列表失败:', treeRes.error);
      } else {
        const tree = treeRes.data;
        let cur = localSessions.value.find(s => s.id === ownerSessionId);
        if (!cur && tree.root) {
          cur = {
            id: String(tree.root.id),
            title: tree.root.name || '新会话',
            messages: [],
            subSessions: tree.subSessions || [],
            runStatus: tree.root.runStatus || 'IDLE',
            lastOutcome: tree.root.lastOutcome || 'COMPLETED',
            workspaceId: tree.root.workspaceId,
            createdAt: tree.root.createTime ? new Date(tree.root.createTime).getTime() : Date.now(),
            updatedAt: tree.root.updateTime ? new Date(tree.root.updateTime).getTime() : Date.now(),
            modelId: '',
            activeTools: [],
          };
          localSessions.value.unshift(cur);
        } else if (cur) {
          // 按 id 保留各子会话已加载的消息（树不带正文）：整体替换会丢掉子会话历史，
          // 见 mergeSubSessionTree 的说明。
          if (tree.subSessions.length > 0) {
            cur.subSessions = mergeSubSessionTree(cur.subSessions, tree.subSessions);
          }
          if (tree.root) {
            cur.runStatus = tree.root.runStatus;
            cur.lastOutcome = tree.root.lastOutcome;
          }
        }
        seedContextUsageFromTree(tree.rootSessionId ?? ownerSessionId, tree);
      }
    } catch (e) {
      console.warn('刷新子会话列表失败:', e);
    }

    try {
      let cursor: string | null = null;
      let hasMore = false;
      // 逐页累积「原始记录」而非聚合后的消息：后端按原始行分页，同一 turnId 可横跨两页，
      // 逐页聚合会为同一轮各建一个助手气泡（id 相同、过程各半）。必须合页去重后再聚合一次。
      const collectedRecords: SessionMessageVO[] = [];
      let collectedTurns: Record<string, ChatTurn> = {};
      // 块视图与 records 同寿：逐页累计，最后与记录一起进唯一聚合点（见 ChatSession.turnViews）。
      let collectedTurnViews: Record<string, TurnViewVO> = {};

      for (let pageIdx = 0; pageIdx < RECONCILE_MAX_PAGES; pageIdx++) {
        const msgRes = await chatApi.fetchSessionMessages(ownerSessionId, cursor, 100);
        if (version !== reconcileVersion) return;
        if (!msgRes.ok) {
          console.warn('主流结束消息对账失败:', msgRes.error);
          break;
        }
        // 本次请求的页更早，故插到已累积记录之前（mergeRawRecords 以先出现者为准）
        collectedRecords.unshift(...(msgRes.data.records ?? []));
        collectedTurns = mergeTurns(collectedTurns, msgRes.data.turns);
        collectedTurnViews = mergeTurnViews(collectedTurnViews, msgRes.data.turnViews);

        hasMore = msgRes.data.hasMore;
        if (!msgRes.data.hasMore || !msgRes.data.nextCursor) break;
        cursor = msgRes.data.nextCursor;
      }

      const collected = aggregateRecordsByIdentity(undefined, collectedRecords, ownerSessionId, collectedTurnViews);

      const cur = localSessions.value.find(s => s.id === ownerSessionId);
      if (cur) {
        // 轮次摘要先 union：合成失败气泡要按 turns 判 FAILED，且本轮可能是「已终结但缺 assistant 行」
        cur.turns = mergeTurns(cur.turns, collectedTurns);
        // 按轮次合并：未确认终结的轮保留本地实时正文、历史只补过程数据；
        // 已终结轮用权威历史整体替换。
        // ⚠️ 合成在 mergeMessagesByTurn **之后**：合并只处理「历史里已经存在的行」，
        //    而失败轮（如模型接口 400）在 session_message 里根本没有 assistant 行，
        //    必须等合并定型后按 turns 补 —— 否则刷新后失败提示会消失。
        const merged = mergeMessagesByTurn({
          local: cur.messages,
          history: collected,
          terminalTurnIds: terminalTurnIds ?? null,
        });
        cur.messages = synthesizeFailedTurnBubbles(merged, cur.turns);
        if (!hasMore) {
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

      // 滚动补偿：写入前记录高度与偏移，渲染完成后恢复。
      messagesContainerRef.value?.beforePrepend();
      // 往前翻页 = 拿到更早的原始记录，必须与已加载记录「合页去重后再整体聚合」：
      // 直接往 messages 前面拼本页聚合结果，会把横跨两页的那一轮拆成两个同 id 气泡，
      // 且旧页的正文会被本页（更新）的聚合结果顶掉。
      session.rawMessageRecords = mergeRawRecords(pageResultRes.data.records, session.rawMessageRecords);
      // 更早页的轮次摘要 union 进会话表：翻页后组尾工具条仍能拿到权威 token/耗时
      session.turns = mergeTurns(session.turns, pageResultRes.data.turns);
      // 块视图与原始记录同寿：不累计它，重新聚合时那一轮的块顺序会退回前端自造口径
      session.turnViews = mergeTurnViews(session.turnViews, pageResultRes.data.turnViews);
      // 合成失败气泡必须用**最新的** turns：更早页里可能正好有某个 FAILED 轮
      session.messages = synthesizeFailedTurnBubbles(
        aggregateRecordsByIdentity(undefined, session.rawMessageRecords, session.id, session.turnViews),
        session.turns
      );
      await nextTick();
      messagesContainerRef.value?.afterPrepend();

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
    invalidateReconcile,
    seedContextUsageFromTree,
  };
}