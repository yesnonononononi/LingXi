import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ContextUsageData } from '../types/chat';

/**
 * ChatSessionStore：第 4A 组之后只承载**上下文用量**。
 *
 * <p><b>消息/轮次已迁出</b>：持久化历史行、未提交活响应、工具实体与轮次摘要由
 * {@code streamV3Store} 作为唯一状态源统一承载，视图从 v3 派生（见
 * {@code views/chat/messageProjection.ts}）。原来的 {@code turnMessages} /
 * {@code activeTurnMap} / {@code turnTimers} 与 {@code getTurnMessages} /
 * {@code getAllMessages} / {@code syncHistoryMessages} / {@code initTurn} /
 * {@code getLatestAssistantMessage} 已随第 3 组删除。</p>
 *
 * <p><b>根会话映射与运行态已删除</b>（第 4A 组）：{@code sessionRootMap} 与
 * {@code sessionStatusMap} 在批次 A 完成迁移后已无任何外部读取方（0 引用）——
 * 会话的根归属由 v3 的 {@code sessions} 槽（{@code rootSessionId}）表达，
 * 运行态由会话实体自身（{@code SessionVO.runStatus}）与执行状态表达。</p>
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
