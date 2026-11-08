package com.summit.dp.workflow.application.decision;

import com.summit.dp.toolcall.domain.model.ToolCallAction;

import java.util.List;
import java.util.Map;

/**
 * 单卡普通决议：同意 / 拒绝 / 作答（计划确认、选择问答、命令审批共用一条入口）。
 *
 * @param conversationId 会话 id，可为空
 * @param toolCallId     目标卡片
 * @param commandId      决策命令身份；v1 传 {@code null}
 * @param expectedVersion 客户端看到的版本；{@code null} 表示不校验（v1）
 * @param action         动作判别
 * @param text           用户答复原文，可空
 * @param digest         请求摘要；v1 传 {@code null}
 * @param resumeIntent   恢复由谁登记
 */
public record ImmediateDecision(
        Long conversationId,
        String toolCallId,
        String commandId,
        Long expectedVersion,
        ToolCallAction action,
        String text,
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
