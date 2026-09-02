package com.summit.dp.workspace.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.workspace.domain.model.Workspace;

import java.util.Collection;
import java.util.List;

/**
 * 工作空间领域仓储。
 * <p>基础能力由 {@link RepositoryTemplate} 提供（save/findById/delete/updateById/分页等），
 * 批量按 id 查询用于会话持久化时一次性装配 workspace，避免 N+1。</p>
 */
public interface WorkspaceRepository extends RepositoryTemplate<Workspace, Long> {

    /**
     * 新增工作空间并返回数据库自增 id。
     */
    Long saveAndReturnId(Workspace entity);

    /**
     * 批量按 id 查询（用于会话装配，保持顺序无要求）。
     */
    List<Workspace> findByIds(Collection<Long> ids);
}
