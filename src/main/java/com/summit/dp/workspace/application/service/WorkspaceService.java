package com.summit.dp.workspace.application.service;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.workspace.application.command.WorkspaceCommand;
import com.summit.dp.shared.vo.WorkspaceVO;

public interface WorkspaceService {

    Result<Long> add(WorkspaceCommand command);

    Result<Void> update(WorkspaceCommand command);

    Result<Void> del(Long id);

    Result<Page<WorkspaceVO>> list(Integer page, Integer pageSize);

    Result<WorkspaceVO> findById(Long id);
}
