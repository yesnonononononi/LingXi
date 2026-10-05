package com.summit.dp.agent.application.vo;

import java.util.Set;

/**
 * v2 重发受理回执：在命令受理回执之外，额外给出被作废的历史范围。
 *
 * <p><b>为什么必须回被作废范围</b>：重发会物理删除目标轮次及其之后的消息、卡片、轮次。
 * 前端若不知道删了哪些，就会留下一批指向已删除实体的气泡与卡片，点进去全是空。
 * 范围随回执下发，前端按 id 精确移除，不需要「重新拉全量历史」这种重手段兜底。</p>
 *
 * <p>{@code historyRevision} 是作废后的新值：前端投影层按它丢弃更早的历史事件
 * （见 {@code StreamProjectionReducer} 的 revision 判定），避免作废前到达的迟到事件
 * 把已经消失的历史又画回来。</p>
 *
 * @param sessionId        会话 id
 * @param turnId           新轮次 id
 * @param executionId      新框架执行 id
 * @param commandId        命令受理身份
 * @param acceptance       受理状态
 * @param historyRevision  作废后的历史版本
 * @param invalidatedTurnIds     被作废的轮次 id
 * @param invalidatedExecutionIds 被作废轮次对应的执行 id
 */
public record ResendCommandAcceptanceVO(
        Long sessionId,
        Long turnId,
        String executionId,
        String commandId,
        CommandAcceptance acceptance,
        Long historyRevision,
        Set<String> invalidatedTurnIds,
        Set<String> invalidatedExecutionIds
) {

    public ResendCommandAcceptanceVO {
        invalidatedTurnIds = invalidatedTurnIds == null ? Set.of() : Set.copyOf(invalidatedTurnIds);
        invalidatedExecutionIds = invalidatedExecutionIds == null ? Set.of() : Set.copyOf(invalidatedExecutionIds);
    }
}
