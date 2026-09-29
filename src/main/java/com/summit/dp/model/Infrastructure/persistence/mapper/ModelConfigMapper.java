package com.summit.dp.model.Infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.model.Infrastructure.persistence.po.ModelConfigPO;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface ModelConfigMapper extends BaseMapper<ModelConfigPO> {
}
