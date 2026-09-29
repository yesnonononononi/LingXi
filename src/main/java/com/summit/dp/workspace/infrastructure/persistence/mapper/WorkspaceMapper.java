package com.summit.dp.workspace.infrastructure.persistence.mapper;

import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import com.summit.dp.workspace.infrastructure.persistence.po.WorkspacePO;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface WorkspaceMapper extends BaseMapper<WorkspacePO> {
}
