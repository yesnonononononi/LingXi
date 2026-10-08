import { ref, nextTick } from 'vue';
import type { Ref, ComputedRef } from 'vue';
import type { ChatSession, ChatTurn } from '../../types/chat';
import type { TurnViewVO } from '../../types/block';
import { chatApi } from '../../services/chat';
import { mergeTurns, mergeTurnViews, mergeSubSessionTree, synthesizeFailedTurnBubbles } from '../../utils/session';
import { upsertTurnViewIntoMessages } from './blockProjection';
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
 * <p><b>写入规则</b>：唯一链路是「后端轮次视图 → {@link upsertTurnViewIntoMessages}」。
 * 按 {@code sessionId + turnId} 定位、按 {@code viewVersion} 接受更新：
 * 已在的轮次就地更新（保留实时已写入的内容，旧帧被版本拦截），
 * 缺失的轮次按雪花键插入到正确位置。既不按消息 id 追加，也不整体替换数组。</p>
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
   * 保证会话持有「每轮已接受版本」表。
   *
   * <p>版本表跨页/跨对账累计：同一轮在两页都出现时，按版本取新（低版本整轮丢弃）。
   * 它与会话同寿，切换会话时随会话对象自然重建。</p>
   */
  const ensureTurnViewVersions = (session: ChatSession): void => {
    if (!session.turnViewVersions) session.turnViewVersions = new Map<string, number>();
  };

  /**
   * 回读会话权威状态并按轮次视图写回（tree + 消息，尽力而为）。
   *
   * <p>三个对齐入口都走这里：<b>进入会话</b>、<b>重连成功后</b>、<b>本轮终结或挂起后</b>。
   * 用户切走时执行仍在跑、跑完时没人收终态事件 —— 「进入会话回查」是这类场景唯一的对齐入口，
   * 因此这里必须无条件执行，不能只在「检测到掉线」时才做。</p>
   *
   * <p><b>更新规则与实时一致</b>：按 {@code turnId} 定位、按 {@code viewVersion} 接受 ——
   * 走的正是 {@link upsertTurnViewIntoMessages}（与 {@code TURN_SNAPSHOT} 同一个入口）。
   * 本地活跃轮（尚未落库、不在任何历史视图里）因此被自然保留，无需整体重建数组。</p>
   *
   * @param ownerSessionId 回查的会话（根会话 id）
   */
  const reconcileSessionAfterStream = async (ownerSessionId: string) => {
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
      // 逐页累积轮次视图：同一 turnId 横跨两页时按版本取新（mergeTurnViews 取高版本）。
      let collectedTurns: Record<string, ChatTurn> = {};
      let collectedTurnViews: Record<string, TurnViewVO> = {};

      for (let pageIdx = 0; pageIdx < RECONCILE_MAX_PAGES; pageIdx++) {
        const msgRes = await chatApi.fetchSessionMessages(ownerSessionId, cursor, 100);
        if (version !== reconcileVersion) return;
        if (!msgRes.ok) {
          console.warn('主流结束消息对账失败:', msgRes.error);
          break;
        }
        collectedTurns = mergeTurns(collectedTurns, msgRes.data.turns);
        collectedTurnViews = mergeTurnViews(collectedTurnViews, msgRes.data.turnViews);

        hasMore = msgRes.data.hasMore;
        if (!msgRes.data.hasMore || !msgRes.data.nextCursor) break;
        cursor = msgRes.data.nextCursor;
      }

      const cur = localSessions.value.find(s => s.id === ownerSessionId);
      if (cur) {
        cur.turns = mergeTurns(cur.turns, collectedTurns);
        // 逐轮 upsert 进现有数组：活跃轮不在视图里 → 原样保留；已在的轮按版本更新。
        ensureTurnViewVersions(cur);
        for (const view of Object.values(collectedTurnViews)) {
          if (view) upsertTurnViewIntoMessages(cur.messages, view, cur.turnViewVersions!);
        }
        cur.messages = synthesizeFailedTurnBubbles(cur.messages, cur.turns);
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
      // 往前翻页 = 拿到更早轮次的完整视图。**只并入本轮返回的轮次**，不重建整个数组 ——
      // 重建会把当前正在跑的实时气泡一起冲掉（它是本轮本地产生的，不在任何历史页里）。
      session.turns = mergeTurns(session.turns, pageResultRes.data.turns);
      session.turnViews = mergeTurnViews(session.turnViews, pageResultRes.data.turnViews);
      // 逐轮 upsert：已存在的轮按版本更新（不新建气泡），新的轮按雪花键插到正确位置。
      ensureTurnViewVersions(session);
      for (const view of Object.values(pageResultRes.data.turnViews ?? {})) {
        if (view) upsertTurnViewIntoMessages(session.messages, view, session.turnViewVersions!);
      }
      // 失败轮：后端在 session_message 里没有 assistant 行，但 turns 里有 FAILED 状态 —— 补合成气泡。
      session.messages = synthesizeFailedTurnBubbles(session.messages, session.turns);
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