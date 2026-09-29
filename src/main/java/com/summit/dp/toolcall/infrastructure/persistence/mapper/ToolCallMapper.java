package com.summit.dp.toolcall.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.toolcall.infrastructure.persistence.po.ToolCallPO;
import org.apache.ibatis.annotations.Mapper;

/** {@code tool_call} 表 Mapper。 */
@Mapper
public interface ToolCallMapper extends BaseMapper<ToolCallPO> {
}
