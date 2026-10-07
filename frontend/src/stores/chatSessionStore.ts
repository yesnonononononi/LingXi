import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ContextUsageData } from '../types/chat';

/**
 * ChatSessionStore：只承载**上下文用量**。
 *
 * <p>消息与轮次由会话实体自身（{@code ChatSession.messages}）承载，视图直接读它；
 * 运行态由会话实体自身（{@code SessionVO.runStatus}）表达。原先的
 * {@code turnMessages} / {@code activeTurnMap} / {@code turnTimers} /
 * {@code sessionRootMap} / {@code sessionStatusMap} 均无读取方，已删除。</p>
 */
export const useChatSessionStore = defineStore('chatSession', () => {
  // 上下文用量: Map<sessionId, ContextUsageData>
  const contextUsageMap = ref<Map<string, ContextUsageData>>(new Map());

  /** 设置会话上下文压缩/用量指标 */
  const setContextUsage = (sessionId: string | number, usage: ContextUsageData): void => {
    const sid = String(sessionId);
    contextUsageMap.value.set(sid, usage);
  };

  /**
   * 种入「上下文用量快照」（tree 接口下发的 session 表快照）。
   *
   * <p>定位：加载历史会话（刷新页面 / 切换会话）时等不到实时事件，本方法把 tree 下发的
   * 会话表快照种进用量表，作为空窗期的数据源。</p>
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
    contextUsageMap,
    setContextUsage,
    seedContextUsage,
    getContextUsage
  };
});
