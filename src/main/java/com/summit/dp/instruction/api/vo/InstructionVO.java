package com.summit.dp.instruction.api.vo;

import lombok.Builder;
import lombok.Data;

/** 指令预测结果；前端只用 nextInstruction，其余字段便于定位。 */
@Data
@Builder
public class InstructionVO {
    private Long sessionId;
    private Long turnId;
    private String nextInstruction;
}
