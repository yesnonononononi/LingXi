package com.summit.dp.instruction.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.instruction.infrastructure.persistence.po.InstructionPredictPO;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface InstructionMapper extends BaseMapper<InstructionPredictPO> {
}
