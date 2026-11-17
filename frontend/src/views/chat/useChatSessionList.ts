import {type ComputedRef, type Ref, ref} from 'vue';
import {useApplicationSessionStore} from '../../stores/applicationSessionStore';
import {chatApi} from '../../services/chat';
import type {ChatMessage, ChatSession} from '../../types/chat';
import {
    buildSessionMarkdown,
    isSessionActive,
    mergeSubSessionTree,
    mergeTurns,
    mergeTurnViews,
    synthesizeFailedTurnBubbles
} from '../../utils/session';
import {upsertTurnViewIntoMessages} from './blockProjection';
import {attachPromptCards} from '../../utils/toolCallCard';
import {isTempSessionId} from '../../utils/ids';
import {mergeSessionListSnapshot} from '../../utils/sessionListMerge';
import {useConfirm} from '../../composables/useConfirm';
import {t} from '../../i18n';

export interface ChatSessionListOptions {
  localSessions: Ref<ChatSession[]>;
  localActiveId: Ref<string | null>;
  currentActiveSession: ComputedRef<ChatSession | null | undefined>;
  displayedMessages: ComputedRef<ChatMessage[]>;
  localActiveWorkspaceId: Ref<string | number | null>;
  localSelectedTeamId: Ref<string | number | null>;
  /** 切走会话前的清理钩子（断开在途请求等）。 */
  beforeSwitchSession: () => void;
  /** 「当前会话是否正在生成」判据：命中相同的会话时只滚到底，不重拉历史冲掉流。 */
  isGenerating: () => boolean;
  scrollToBottomForce: () => void;
  /** 把会话树的上下文用量快照种进用量表。 */
  seedContextUsageFromTree: (rootId: string | number, tree: any) => void;
  /** 清空「上一条/最后一条消息 id」的滚动锚点。 */
  resetScrollAnchors: () => void;
  /** 新建会话时清空子会话查看态。 */
  onNewSession: () => void;
}

/**
 * 会话列表：选中、新建、删除、重命名、清空、导出。
 *
 * <p>会话数据由本模块自己持有并直接落库，变更即刻写回本地 ref。</p>
 */
export function useChatSessionList(options: ChatSessionListOptions) {
  const applicationSessions = useApplicationSessionStore();
  const {
    localSessions,
    localActiveId,
    currentActiveSession,
    displayedMessages,
    localActiveWorkspaceId,
    localSelectedTeamId,
    beforeSwitchSession,
    isGenerating,
    scrollToBottomForce,
    seedContextUsageFromTree,
    resetScrollAnchors,
    onNewSession,
  } = options;

  const { confirm } = useConfirm();
  const isLoadingCurrentSession = ref(false);
  const sessionLoadError = ref('');

  const handleSelectSession = async (id: string) => {
    // 关键保护：若点击的正是当前正在生成中的会话，绝不重新拉取后端历史以防冲掉正在流式更新的消息
    if (localActiveId.value === id && isGenerating()) {
      scrollToBottomForce();
      return;
    }

    // 切走旧会话：断开它的在途请求（新会话的在途轮次另有自己的 controller）。
    if (localActiveId.value !== id) {
      beforeSwitchSession();
    }

    resetScrollAnchors();
    localActiveId.value = id;

    // 临时未入库会话直接呈现
    if (isTempSessionId(id)) {
      scrollToBottomForce();
      return;
    }

    isLoadingCurrentSession.value = true;
    sessionLoadError.value = '';
    try {
      const detailRes = await chatApi.fetchSessionDetail(id);
      if (!detailRes.ok) {
        sessionLoadError.value = detailRes.error;
        return;
      }
      const detail = detailRes.data;
      const idx = localSessions.value.findIndex(s => s.id === id);
      if (idx !== -1) {
        const previous = localSessions.value[idx];
        // 详情请求在途期间，实时流可能已经往这个会话写进了正文（用户点进一个正在跑的会话时必然如此）。
        // 直接用 `...detail` 展开会把 messages 整体换成「请求发起那一刻的快照」，
        // 在途到达的正文随之消失（用户看到内容闪一下又没了）。
        // 因此以「上一份 messages」为底、把详情的每个轮次视图逐轮 upsert 进去：
        // 实时已写入的轮次不会被回退，详情只补齐缺失的轮次与过程数据。
        const mergedTurns = mergeTurns(previous.turns, detail.turns);
        const mergedViews = mergeTurnViews(previous.turnViews, detail.turnViews);
        const mergedMessages = previous.messages.slice();
        for (const view of Object.values(mergedViews)) {
          if (view) upsertTurnViewIntoMessages(mergedMessages, view);
        }
        attachPromptCards(mergedMessages, detail.messages.flatMap(message => message.promptCards ?? []));
        localSessions.value[idx] = {
          ...previous,
          ...detail,
          // 详情只带子会话元数据，不能冲掉在途期间加载的历史和实时内容。
          subSessions: mergeSubSessionTree(previous.subSessions, detail.subSessions ?? []),
          // ⚠️ 合成失败气泡必须在合并**之后**、用**合并后**的 turns：
          //    失败轮（模型接口 400 这类）在库里只有 USER 行，没有 assistant 行可合并，
          //    只能按 turns 判 FAILED 后补气泡，否则用户点进失败会话什么都看不到。
          messages: synthesizeFailedTurnBubbles(mergedMessages, mergedTurns),
          turns: mergedTurns,
          // 块视图跨页累计，避免丢掉已翻开页的内容。
          turnViews: mergedViews,
          hasMoreMessages: !!detail.hasMoreMessages,
          nextMessageCursor: detail.nextMessageCursor ?? null,
        };
      } else {
        // 首屏走这里（会话列表里第一次点开）：turns 来自 detail（可能缺省，合成器按空表处理）。
        localSessions.value.unshift({
          ...detail,
          messages: synthesizeFailedTurnBubbles(detail.messages, detail.turns ?? {}),
        });
      }

      seedContextUsageFromTree(detail.id, {
        root: detail,
        subSessions: detail.subSessions,
      });

      localSelectedTeamId.value = detail.teamId ?? null;

      const currentWsId = detail.workspaceId || localSessions.value[idx]?.workspaceId;
      if (currentWsId) {
        localActiveWorkspaceId.value = currentWsId;
      }
    } catch (err) {
      console.error('获取会话详情及消息列表失败:', err);
      sessionLoadError.value = t('chat.view.sessionLoadFailed');
    } finally {
      isLoadingCurrentSession.value = false;
      scrollToBottomForce();
    }
  };

  /** 重试加载当前会话详情（失败态可见后的重试入口） */
  const handleRetrySessionLoad = () => {
    const id = localActiveId.value;
    if (!id || isTempSessionId(id)) return;
    sessionLoadError.value = '';
    void handleSelectSession(id);
  };

  const handleNewSession = async (workspaceId?: string | number | null) => {
    onNewSession();
    if (workspaceId !== undefined) {
      localActiveWorkspaceId.value = workspaceId;
    }
    localActiveId.value = null;
  };

  const handleDeleteSession = async (id: string) => {
    const session = localSessions.value.find(s => s.id === id);
    // 硬性门槛：会话处于活跃状态时禁止删除
    if (isSessionActive(session, {
      isGenerating: isGenerating(),
      activeSessionId: localActiveId.value,
      applicationStates: applicationSessions.states
    })) {
      window.alert(t('chat.sidebar.deleteSessionActiveBlocked'));
      return;
    }

    const ok = await confirm({
      title: t('chat.sidebar.deleteSession'),
      content: t('chat.sidebar.deleteSessionConfirm', {
        name: session?.title || t('session.newConversation')
      }),
      type: 'danger',
      confirmText: t('common.remove')
    });
    if (!ok) return;

    if (isTempSessionId(id)) {
      localSessions.value = localSessions.value.filter(s => s.id !== id);
      if (localActiveId.value === id) localActiveId.value = null;
      return;
    }
    const deleteOk = await chatApi.deleteSession(id);
    if (deleteOk) {
      applicationSessions.forget(id);
      localSessions.value = localSessions.value.filter(s => s.id !== id);
      if (localActiveId.value === id) localActiveId.value = null;
    } else {
      window.alert(t('chat.view.deleteSessionFailed'));
    }
  };

  const handleRenameSession = async (id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const ok = await chatApi.renameSession(id, trimmed);
    if (ok) {
      const idx = localSessions.value.findIndex(s => s.id === id);
      if (idx !== -1) localSessions.value[idx] = { ...localSessions.value[idx], title: trimmed };
    }
  };

  /**
   * 置顶 / 取消置顶。
   *
   * <p>接口成功后**只认后端状态**：先落下 `isPinned`，再拉一次列表按后端顺序重排。
   * 本地不写比较器 —— 排序规则只有后端 `ORDER BY` 一处。</p>
   */
  const handleTogglePin = async (id: string) => {
    const session = localSessions.value.find(item => item.id === id);
    if (!session || isTempSessionId(id)) return;
    const target = !session.isPinned;

    if (!await chatApi.toggleSessionPin(id, target)) {
      window.alert(t('chat.sidebar.pinFailed'));
      return;
    }
    session.isPinned = target;

    const snapshot = await chatApi.fetchSessions();
    if (snapshot.ok) {
      localSessions.value = mergeSessionListSnapshot(localSessions.value, snapshot.data);
    }
  };

  // 清空历史对话：调用后端整库清空接口，避免仅删当前页 100 条或并发删除抢锁失败
  const handleClearSessions = async () => {
    const ids = localSessions.value.map(s => s.id);
    const result = await chatApi.clearSessions();
    if (result.ok) {
      ids.forEach(id => applicationSessions.forget(id));
      localSessions.value = [];
      localActiveId.value = null;
      window.alert(t('chat.view.clearedAll', { count: result.count > 0 ? result.count : ids.length }));
    } else {
      window.alert(t('chat.view.deleteSessionFailed'));
    }
  };

  // 快捷指令「清空当前会话」——**已禁用**（语义未定，见历史设计说明）。
  const handleClearCurrentSession = () => {
    console.warn('[chat] 「清空当前会话」暂未开放。');
  };

  // 快捷指令导出当前会话为 Markdown
  const handleExportSession = () => {
    const session = currentActiveSession.value;
    const exported = displayedMessages.value;
    if (!session || exported.length === 0) {
      window.alert(t('chat.view.nothingToExport'));
      return;
    }
    const blob = new Blob([buildSessionMarkdown(session.title, exported)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${session.title || 'chat-export'}-${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return {
    isLoadingCurrentSession,
    sessionLoadError,
    handleSelectSession,
    handleRetrySessionLoad,
    handleNewSession,
    handleDeleteSession,
    handleRenameSession,
    handleTogglePin,
    handleClearSessions,
    handleClearCurrentSession,
    handleExportSession,
  };
}
