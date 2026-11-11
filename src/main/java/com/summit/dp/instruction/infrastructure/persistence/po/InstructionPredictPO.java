package com.summit.dp.instruction.infrastructure.persistence.po;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.AllArgsConstructor;
import lombok.Builder;
import lombok.Data;
import lombok.NoArgsConstructor;

import java.time.Instant;

/** 指令预测结果（instruction_predict）。 */
@Data
@Builder
@NoArgsConstructor
@AllArgsConstructor
@TableName("instruction_predict")
public class InstructionPredictPO {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long sessionId;
    private Long turnId;
    /** 生成本条预测的模型；仅用于排查，不参与业务判断。 */
    private Long modelId;
    private String nextInstruction;
    private Instant createTime;
    private Instant updateTime;
}
