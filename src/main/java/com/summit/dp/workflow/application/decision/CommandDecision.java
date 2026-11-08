package com.summit.dp.workflow.application.decision;

import com.summit.dp.toolcall.domain.model.ToolCallAction;

import java.util.List;
import java.util.Map;

/**
 * 命令决议：有外部副作用，走两阶段（T1 提交先于执行、T2 落结果）。
 *
 * <p>与 {@link ImmediateDecision} 分开成型，是因为它的事务边界不同 —— 命令有两段事务：
 * T1 由引擎的 commit 打开，T2 由收尾段打开，外部副作用夹在两者之间。</p>
 *
 * @param conversationId 会话 id，可为空
 * @param toolCallId     目标卡片
 * @param commandId      决策命令身份；v1 传 {@code null}
 * @param expectedVersion 客户端看到的版本；{@code null} 表示不校验
 * @param action         只接受 APPROVE / REJECT
 * @param digest         请求摘要；v1 传 {@code null}
 * @param resumeIntent   恢复由谁登记
 * @param settledCallback 落定回调；记录组件自带访问器，直接满足 {@link SlotDecisionCommand}
 */
public record CommandDecision(
        Long conversationId,
        String toolCallId,
        String commandId,
        Long expectedVersion,
        ToolCallAction action,
        String digest,
        ResumeIntent resumeIntent,
        Runnable settledCallback
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
