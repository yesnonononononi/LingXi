import { ref, computed, type ComputedRef } from 'vue';
import { chatApi } from '../../services/chat';
import type { ChatMessage, ChatSession, SubSessionVO } from '../../types/chat';
import { resolveRootSessionId } from '../../utils/session';
import { absorbSubSessionHistory } from './subSessionHistory';
import { toSubItemStatus } from '../../utils/subSessionStatus';
import type { SubSessionItem } from '../../components/chat/SubAgentSidePanel.vue';
import { t } from '../../i18n';

export interface ChatSubSessionOptions {
  currentActiveSession: ComputedRef<ChatSession | null | undefined>;
}

/**
 * 子会话面板：右侧子代理轨迹列表、详情切换与分页加载。
 *
 * <p>数据来源是会话实体声明的 {@code subSessions}（由会话树接口写入）。</p>
 */
export function useChatSubSession(options: ChatSubSessionOptions) {
  const { currentActiveSession } = options;

  const isSubPanelOpen = ref(false);
  const isSubSessionsOverviewOpen = ref(false);
  /**
   * 详情抽屉的目标 id。
   *
   * <p>只存 id 不存 VO 对象：对账会整体替换 {@code subSessions}（见
   * {@code mergeSubSessionTree}），抓住旧对象等于抓住一份不会再更新的快照 ——
   * 抽屉里的消息与运行状态会停在打开那一刻。</p>
   */
  const selectedSubSessionDetailId = ref<string | null>(null);

  /** 详情抽屉的目标子会话：每次按 id 从当前会话树解析，永远指向最新 VO。 */
  const selectedSubSessionForDetail = computed<SubSessionVO | null>(() => {
    const id = selectedSubSessionDetailId.value;
    if (id === null) return null;
    const found = currentActiveSession.value?.subSessions?.find(sub => sub?.id != null && String(sub.id) === id);
    return found ?? null;
  });
  const isSubSessionDetailOpen = ref(false);
  const activeViewingSubSessionId = ref<string | number | null>(null);

  const isLoadingSubMessages = ref(false);
  const subMessagesError = ref('');
  const subSessionPaginationMap = ref<Record<string, {
    hasMore: boolean;
    nextCursor: string | null;
    messages: ChatMessage[];
    historyRevision: string | undefined;
  }>>({});
  const isLoadingMoreSubMessages = ref(false);
  const subHistoryLoadError = ref('');
  let messagesRequestVersion = 0;
  let moreRequestVersion = 0;

  /** 聚合提取当前会话中的所有子代理项（右侧子代理轨迹与标签面板）。 */
  const availableSubSessionItems = computed<SubSessionItem[]>(() => {
    const session = currentActiveSession.value;
    const rootId = resolveRootSessionId(session);
    if (!rootId) return [];

    const map = new Map<string, SubSessionItem>();
    for (const vo of session?.subSessions ?? []) {
      if (vo?.id == null) continue;
      const id = String(vo.id);
      if (id === rootId) continue;
      map.set(id, {
        id: vo.id,
        agentId: vo.agentId,
        agentName: vo.name || (vo.agentId ? `Agent #${vo.agentId}` : t('chat.subSessions.fallbackName')),
        task: vo.name || '',
        status: toSubItemStatus(vo.runStatus, vo.lastOutcome),
        subSession: vo,
        tc: undefined,
      });
    }
    return Array.from(map.values());
  });

  /** 当前正在查看的子代理详情 */
  const activeViewingSubSession = computed(() => {
    if (activeViewingSubSessionId.value === null) return null;
    return availableSubSessionItems.value.find(it => String(it.id) === String(activeViewingSubSessionId.value)) || null;
  });

  const hasMoreSubMessages = computed(() => {
    if (activeViewingSubSessionId.value === null) return false;
    return !!subSessionPaginationMap.value[String(activeViewingSubSessionId.value)]?.hasMore;
  });

  /** 子会话消息列表（右侧子会话面板）。 */
  const activeSubSessionMessages = computed<ChatMessage[]>(() => {
    if (activeViewingSubSessionId.value === null) return [];
    const sub = availableSubSessionItems.value.find(it => String(it.id) === String(activeViewingSubSessionId.value));
    return sub?.subSession?.messages ?? [];
  });

  /** 当前选中的子会话完整 VO 对象 */
  const activeViewingSubSessionVO = computed<SubSessionVO | null>(() => {
    if (activeViewingSubSessionId.value === null) return null;
    const key = String(activeViewingSubSessionId.value);
    const found = availableSubSessionItems.value.find(it => String(it.id) === key);
    if (found?.subSession) return found.subSession;
    if (currentActiveSession.value?.subSessions) {
      const fromTree = currentActiveSession.value.subSessions.find(s => String(s.id) === key);
      if (fromTree) return fromTree;
    }
    return null;
  });

  const handleOpenSubSessionDetailFromOverview = (sub: SubSessionVO) => {
    if (sub?.id == null) return;
    selectedSubSessionDetailId.value = String(sub.id);
    isSubSessionDetailOpen.value = true;
  };

  /** 选中子会话时补齐历史，实时消息本身不代表历史已经加载。 */
  const handleSelectSubSessionOption = async (subId: string | number | null, refresh = false) => {
    const requestVersion = ++messagesRequestVersion;
    moreRequestVersion += 1;
    isLoadingSubMessages.value = false;
    isLoadingMoreSubMessages.value = false;
    subMessagesError.value = '';
    subHistoryLoadError.value = '';
    activeViewingSubSessionId.value = subId;
    if (subId === null) return;
    // 选中即展开侧边面板：从主会话协同条点击时面板默认是收起的，不展开就等于「点了没反应」。
    isSubPanelOpen.value = true;
    const key = String(subId);

    const ownerId = currentActiveSession.value?.id;
    const historyRevision = currentActiveSession.value?.historyRevision;
    const loaded = subSessionPaginationMap.value[key];
    const current = availableSubSessionItems.value.find(it => String(it.id) === key);
    const hasMessages = (current?.subSession?.messages?.length ?? 0) > 0;
    // 缓存必须属于当前消息数组与历史版本，几条新到的实时消息不能复活旧加载标记。
    if (!refresh && loaded && hasMessages && loaded.messages === current?.subSession?.messages
      && loaded.historyRevision === historyRevision) return;

    const isCurrentRequest = () => requestVersion === messagesRequestVersion
      && currentActiveSession.value?.id === ownerId
      && currentActiveSession.value?.historyRevision === historyRevision;

    // 后台补齐时继续展示已有轨迹，避免每次终态回查都闪回整屏加载态。
    isLoadingSubMessages.value = !refresh || !hasMessages;
    try {
      const res = await chatApi.fetchSessionMessages(subId, null, 50);
      if (!isCurrentRequest()) return;
      if (!res.ok) {
        delete subSessionPaginationMap.value[key];
        subMessagesError.value = res.error;
        return;
      }
      const sub = availableSubSessionItems.value.find(it => String(it.id) === key);
      // 与详情抽屉共用同一吸入逻辑：写进 VO 上的实时数组，实时事件与历史不会各存一份。
      const messages = absorbSubSessionHistory(sub?.subSession, res.data);
      if (messages) {
        subSessionPaginationMap.value[key] = {
          hasMore: res.data.hasMore, nextCursor: res.data.nextCursor, messages, historyRevision,
        };
      }
    } catch (err) {
      if (!isCurrentRequest()) return;
      delete subSessionPaginationMap.value[key];
      console.error('加载子会话消息失败:', err);
      subMessagesError.value = t('chat.view.subMessagesLoadFailed');
    } finally {
      if (requestVersion === messagesRequestVersion) isLoadingSubMessages.value = false;
    }
  };

  const handleLoadMoreSubSessionHistory = async () => {
    const subId = activeViewingSubSessionId.value;
    if (subId === null || isLoadingMoreSubMessages.value) return;
    const key = String(subId);
    const page = subSessionPaginationMap.value[key];
    if (!page?.hasMore || !page.nextCursor) return;
    const ownerId = currentActiveSession.value?.id;
    const historyRevision = currentActiveSession.value?.historyRevision;
    if (page.messages !== activeViewingSubSessionVO.value?.messages || page.historyRevision !== historyRevision) {
      await handleSelectSubSessionOption(subId, true);
      return;
    }
    const requestVersion = ++moreRequestVersion;
    const isCurrentRequest = () => requestVersion === moreRequestVersion
      && currentActiveSession.value?.id === ownerId
      && currentActiveSession.value?.historyRevision === historyRevision;

    isLoadingMoreSubMessages.value = true;
    subHistoryLoadError.value = '';
    try {
      const res = await chatApi.fetchSessionMessages(subId, page.nextCursor, 50);
      if (!isCurrentRequest()) return;
      if (!res.ok) {
        subHistoryLoadError.value = res.error;
        return;
      }
      const sub = availableSubSessionItems.value.find(it => String(it.id) === key);
      // 同一吸入逻辑：更早页的摘要可能正好包含某个失败轮，顺序由该函数内部保证。
      const messages = absorbSubSessionHistory(sub?.subSession, res.data);
      if (messages) {
        subSessionPaginationMap.value[key] = {
          hasMore: res.data.hasMore, nextCursor: res.data.nextCursor, messages, historyRevision,
        };
      }
    } catch (err) {
      if (!isCurrentRequest()) return;
      console.error('加载更多子会话消息失败:', err);
      subHistoryLoadError.value = t('chat.view.historyLoadFailed');
    } finally {
      if (requestVersion === moreRequestVersion) isLoadingMoreSubMessages.value = false;
    }
  };

  const handleRetrySubSessionMessages = () => {
    const subId = activeViewingSubSessionId.value;
    if (subId === null) return;
    subMessagesError.value = '';
    void handleSelectSubSessionOption(subId, true);
  };

  /** 重连和终态回查必须绕过点击缓存，否则断线期间的历史缺口会一直留着。 */
  const refreshViewedSubSessionHistory = async (ownerSessionId: string) => {
    if (String(currentActiveSession.value?.id) !== ownerSessionId) return;
    const subId = activeViewingSubSessionId.value;
    if (subId !== null) await handleSelectSubSessionOption(subId, true);
  };

  /** 切走会话时重置子会话查看态。 */
  const resetSubSessionView = () => {
    messagesRequestVersion += 1;
    moreRequestVersion += 1;
    subSessionPaginationMap.value = {};
    isLoadingSubMessages.value = false;
    isLoadingMoreSubMessages.value = false;
    subMessagesError.value = '';
    subHistoryLoadError.value = '';
    activeViewingSubSessionId.value = null;
    selectedSubSessionDetailId.value = null;
    isSubSessionDetailOpen.value = false;
  };

  return {
    isSubPanelOpen,
    isSubSessionsOverviewOpen,
    selectedSubSessionForDetail,
    isSubSessionDetailOpen,
    activeViewingSubSessionId,
    isLoadingSubMessages,
    subMessagesError,
    isLoadingMoreSubMessages,
    subHistoryLoadError,
    hasMoreSubMessages,
    availableSubSessionItems,
    activeViewingSubSession,
    activeSubSessionMessages,
    activeViewingSubSessionVO,
    resolveRootSessionId,
    handleOpenSubSessionDetailFromOverview,
    handleSelectSubSessionOption,
    handleLoadMoreSubSessionHistory,
    handleRetrySubSessionMessages,
    refreshViewedSubSessionHistory,
    resetSubSessionView,
  };
}
