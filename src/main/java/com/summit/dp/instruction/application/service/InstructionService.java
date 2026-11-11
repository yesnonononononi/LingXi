package com.summit.dp.instruction.application.service;

import com.summit.ddd.application.vo.Result;
import com.summit.dp.instruction.api.vo.InstructionVO;

public interface InstructionService {

    /**
     * 取该轮的下一句指令预测：有旧的就返回旧的，没有且条件满足时生成一条。
     *
     * <p>功能未开启、轮次未终态、队列里还有接力消息时返回 null（data 为空），
     * 这些是「此刻不该预测」而不是错误。</p>
     */
    Result<InstructionVO> next(Long sessionId, Long turnId);
}
