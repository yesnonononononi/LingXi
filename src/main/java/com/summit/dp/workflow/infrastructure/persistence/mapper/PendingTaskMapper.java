package com.summit.dp.workflow.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.workflow.infrastructure.persistence.po.PendingTaskPO;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface PendingTaskMapper extends BaseMapper<PendingTaskPO> {
}
