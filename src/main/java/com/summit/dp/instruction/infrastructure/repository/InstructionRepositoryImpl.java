package com.summit.dp.instruction.infrastructure.repository;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.ddd.infrastructure.repository.AbstractRepository;
import com.summit.dp.instruction.domain.model.Instruction;
import com.summit.dp.instruction.domain.repository.InstructionRepository;
import com.summit.dp.instruction.infrastructure.persistence.mapper.InstructionMapper;
import com.summit.dp.instruction.infrastructure.persistence.po.InstructionPredictPO;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Repository;

import java.util.Optional;

@Repository
@RequiredArgsConstructor
public class InstructionRepositoryImpl extends AbstractRepository<Instruction, InstructionPredictPO, Long>
        implements InstructionRepository {

    private final InstructionMapper instructionMapper;

    @Override
    protected BaseMapper<InstructionPredictPO> mapper() {
        return instructionMapper;
    }

    @Override
    public Optional<Instruction> findBySessionAndTurn(Long sessionId, Long turnId) {
        if (sessionId == null || turnId == null) {
            return Optional.empty();
        }
        // 唯一索引保证一轮只有一行；orderBy 只是为了容忍历史遗留的重复行。
        return findBy(new LambdaQueryWrapper<InstructionPredictPO>()
                .eq(InstructionPredictPO::getSessionId, sessionId)
                .eq(InstructionPredictPO::getTurnId, turnId)
                .orderByDesc(InstructionPredictPO::getId)
                .last("LIMIT 1"));
    }

    @Override
    protected InstructionPredictPO toPO(Instruction entity) {
        return InstructionPredictPO.builder()
                .id(entity.getId())
                .sessionId(entity.getSessionId())
                .turnId(entity.getTurnId())
                .modelId(entity.getModelId())
                .nextInstruction(entity.getNextInstruction())
                .createTime(entity.getCreateAt())
                .updateTime(entity.getUpdateAt())
                .build();
    }

    @Override
    protected Instruction toModel(InstructionPredictPO po) {
        return Instruction.builder()
                .id(po.getId())
                .sessionId(po.getSessionId())
                .turnId(po.getTurnId())
                .modelId(po.getModelId())
                .nextInstruction(po.getNextInstruction())
                .createAt(po.getCreateTime())
                .updateAt(po.getUpdateTime())
                .build();
    }
}
