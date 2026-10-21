package com.summit.dp.toolcall.api.dto;

import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.shared.vo.ToolCallVO;

import java.util.List;

/** 只承诺整组答案已保存，执行恢复仍以服务端处置为准。 */
public record ChoiceAnswersReceipt(String commandId, boolean decisionApplied, List<ToolCallVO> toolCalls,
                                   ResumeDisposition resumeDisposition) {
}
