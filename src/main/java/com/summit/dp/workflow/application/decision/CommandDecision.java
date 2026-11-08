package com.summit.dp.workflow.application.decision;

import com.summit.dp.toolcall.domain.model.ToolCallAction;

import java.util.List;
import java.util.Map;

/**
 * 命令决议：有外部副作用，走两阶段（T1 提交先于执行、T2 落结果）。
 *
 * <p>与 {@link ImmediateDecision} 分开成型，是因为它的事务边界不同 ——
 * 引擎不替它开事务，顺序由 {@code CommandApprovalExecutor} 持有。</p>
 *
 * @param conversationId 会话 id，可为空
 * @param toolCallId     目标卡片
 * @param commandId      决策命令身份；v1 传 {@code null}
 * @param expectedVersion 客户端看到的版本；{@code null} 表示不校验
 * @param action         只接受 APPROVE / REJECT
 * @param digest         请求摘要；v1 传 {@code null}
 * @param resumeIntent   恢复由谁登记
 */
public record CommandDecision(
        Long conversationId,
        String toolCallId,
        String commandId,
        Long expectedVersion,
        ToolCallAction action,
        String digest,
        ResumeIntent resumeIntent
) implements SlotDecisionCommand {

    @Override
    public List<String> cardIds() {
        return List.of(this.toolCallId);
    }

    @Override
    public Map<String, Long> expectedVersions() {
        return this.expectedVersion == null ? Map.of() : Map.of(this.toolCallId, this.expectedVersion);
    }
}
