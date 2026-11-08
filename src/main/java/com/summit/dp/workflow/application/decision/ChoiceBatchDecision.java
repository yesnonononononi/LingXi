package com.summit.dp.workflow.application.decision;

import com.summit.dp.toolcall.api.dto.ChoiceAnswersCommand;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 多选批量决议：一次提交同一模型响应的全部待答问题，全成全败。
 *
 * @param conversationId 会话 id
 * @param responseId     原问题组标识
 * @param commandId      决策命令身份
 * @param answers        整组答案（按卡片标识排序后使用）
 * @param digest         整批摘要（含成员与版本）
 */
public record ChoiceBatchDecision(
        Long conversationId,
        String responseId,
        String commandId,
        List<ChoiceAnswersCommand.Answer> answers,
        String digest
) implements SlotDecisionCommand {

    @Override
    public List<String> cardIds() {
        return this.answers.stream().map(ChoiceAnswersCommand.Answer::toolCallId).toList();
    }

    @Override
    public Map<String, Long> expectedVersions() {
        Map<String, Long> versions = new LinkedHashMap<>();
        for (ChoiceAnswersCommand.Answer answer : this.answers) {
            versions.put(answer.toolCallId(), answer.expectedVersion());
        }
        return versions;
    }

    @Override
    public ResumeIntent resumeIntent() {
        // 整批答案与恢复意图同事务提交：不存在「答案已存但恢复没登记」的窗口。
        return ResumeIntent.COORDINATOR;
    }
}
