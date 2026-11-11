package com.summit.dp.instruction.application.service;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.instruction.api.vo.InstructionVO;

public interface InstructionService {

    /** 预测该轮之后的下一句用户指令；已有结果直接复用，不重复调用模型。 */
    Result<InstructionVO> next(Long sessionId, Long turnId);

    Result<InstructionVO> queryById(Long instructionId);
}
