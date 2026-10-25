package com.summit.dp.execution.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.execution.infrastructure.persistence.po.RuntimeConfigRevisionPO;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface RuntimeConfigRevisionMapper extends BaseMapper<RuntimeConfigRevisionPO> {
}
