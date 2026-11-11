package com.summit.dp.instruction.domain.model;

import lombok.Builder;
import lombok.Getter;

import java.time.Instant;

/** 某一轮对话之后的「下一句指令」预测；同一轮只保留最新一份。 */
@Getter
@Builder
public class Instruction {
    private final Long id;
    private final Long sessionId;
    private final Long turnId;
    /** 生成这条预测的模型；换模型重测时同步更新，便于排查旧结果。 */
    private Long modelId;
    private String nextInstruction;
    private final Instant createAt;
    private Instant updateAt;

    /** 同一轮重新预测：覆盖文本与模型，主键与创建时间保持不变。 */
    public void changeNextInstruction(Long modelId, String nextInstruction) {
        this.modelId = modelId;
        this.nextInstruction = nextInstruction;
        this.updateAt = Instant.now();
    }
}
