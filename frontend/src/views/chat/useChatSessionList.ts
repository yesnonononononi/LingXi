import { ref, type Ref, type ComputedRef } from 'vue';
import { chatApi } from '../../services/chat';
import type { ChatSession, ChatMessage } from '../../types/chat';
import { buildSessionMarkdown, mergeTurns, mergeTurnViews, synthesizeFailedTurnBubbles } from '../../utils/session';
import { upsertTurnViewIntoMessages } from './blockProjection';
import { attachPromptCards } from '../../utils/toolCallCard';
import { isTempSessionId } from '../../utils/ids';

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
        const versions = previous.turnViewVersions ?? new Map<string, number>();
        const mergedMessages = previous.messages.slice();
        for (const view of Object.values(mergedViews)) {
          if (view) upsertTurnViewIntoMessages(mergedMessages, view, versions);
        }
        attachPromptCards(mergedMessages, detail.messages.flatMap(message => message.promptCards ?? []));
        localSessions.value[idx] = {
          ...previous,
          ...detail,
          // ⚠️ 合成失败气泡必须在合并**之后**、用**合并后**的 turns：
          //    失败轮（模型接口 400 这类）在库里只有 USER 行，没有 assistant 行可合并，
          //    只能按 turns 判 FAILED 后补气泡，否则用户点进失败会话什么都看不到。
          messages: synthesizeFailedTurnBubbles(mergedMessages, mergedTurns),
          turns: mergedTurns,
          // 块视图与版本表跨页累计：不合并就会把「已翻开的更早页」学到的块视图丢掉。
          turnViews: mergedViews,
          turnViewVersions: versions,
          hasMoreMessages: !!detail.hasMoreMessages,
          nextMessageCursor: detail.nextMessageCursor ?? null,
        };
      } else {
        // 首屏走这里（会话列表里第一次点开）：turns 来自 detail（可能缺省，合成器按空表处理）。
        // 版本表必须此刻建好：后续实时快照与翻页都往同一张表里累计，缺表会让旧帧重新被接受。
        localSessions.value.unshift({
          ...detail,
          messages: synthesizeFailedTurnBubbles(detail.messages, detail.turns ?? {}),
          turnViewVersions: new Map<string, number>(),
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
      sessionLoadError.value = '会话加载失败，请稍后重试';
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
    if (isTempSessionId(id)) {
      localSessions.value = localSessions.value.filter(s => s.id !== id);
      if (localActiveId.value === id) localActiveId.value = null;
      return;
    }
    const ok = await chatApi.deleteSession(id);
    if (ok) {
      localSessions.value = localSessions.value.filter(s => s.id !== id);
      if (localActiveId.value === id) localActiveId.value = null;
    } else {
      window.alert('删除会话失败，请重试');
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

  // 清空历史对话：汇总删除结果，仅移除删除成功的条目并如实提示（禁止无条件报成功）
  const handleClearSessions = async () => {
    const ids = localSessions.value.map(s => s.id);
    if (ids.length === 0) return;
    const results = await Promise.all(
      ids.map(async id => ({ id, ok: await chatApi.deleteSession(id) })),
    );
    const failedIds = new Set(results.filter(r => !r.ok).map(r => r.id));
    const okCount = ids.length - failedIds.size;
    localSessions.value = localSessions.value.filter(s => failedIds.has(s.id));
    if (localActiveId.value && !failedIds.has(localActiveId.value)) {
      localActiveId.value = null;
    }
    if (failedIds.size === 0) {
      window.alert(`已清空全部对话（${okCount} 条）`);
    } else {
      window.alert(`已清空 ${okCount} 条，${failedIds.size} 条失败，请重试`);
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
      window.alert('当前会话暂无消息内容可导出');
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
    handleClearSessions,
    handleClearCurrentSession,
    handleExportSession,
  };
}
