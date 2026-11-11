package com.summit.dp.instruction.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.instruction.domain.model.Instruction;

import java.util.Optional;

/** 指令预测结果仓储；按「会话 + 轮次」定位，一轮只维护一条。 */
public interface InstructionRepository extends RepositoryTemplate<Instruction, Long> {

    /** 取该轮已有预测；同一轮重复预测时只保留最新一条。 */
    Optional<Instruction> findBySessionAndTurn(Long sessionId, Long turnId);
}
