package com.summit.dp.session.application.service;

import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.session.application.command.SessionCommand;
import com.summit.dp.shared.vo.SessionVO;

public interface SessionService {
    Result<Long> add(SessionCommand command);

    Result<Void> update(SessionCommand command);

    Result<Void> del(Long id);

    Result<Page<SessionVO>> list(Integer page, Integer pageSize);

    Result<SessionVO> findById(Long id);

    /**
     * 绑定/解绑会话的工作空间。
     *
     * @param workspaceId 非空 = 绑定该工作空间（须存在且可装配）；空 = 解绑
     */
    Result<Void> bindWorkspace(Long sessionId, Long workspaceId);
}
