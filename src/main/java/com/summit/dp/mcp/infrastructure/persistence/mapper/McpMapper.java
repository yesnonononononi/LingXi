package com.summit.dp.mcp.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.mcp.infrastructure.persistence.po.McpPO;
import org.apache.ibatis.annotations.Mapper;

/**
 * Mcp MyBatis Mapper。
 * <p>查询需求全部可由 {@link BaseMapper} 的通用方法覆盖（按 id、按状态、全量列表），
 * 故不额外声明 XML；确有复杂条件时再补方法并配套 XML。</p>
 */
@Mapper
public interface McpMapper extends BaseMapper<McpPO> {
}
