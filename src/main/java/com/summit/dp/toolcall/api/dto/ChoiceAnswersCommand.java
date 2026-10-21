package com.summit.dp.toolcall.api.dto;

import java.util.List;

/** 同一次模型响应的全部待答问题作为一个决策提交。 */
public record ChoiceAnswersCommand(Long conversationId, String responseId, String commandId,
                                   List<Answer> answers) {
    public record Answer(String toolCallId, Long expectedVersion, String text) {
    }
}
