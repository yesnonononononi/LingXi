package com.summit.dp.workspace.domain.repository;

import com.baomidou.mybatisplus.core.metadata.IPage;
import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.workspace.domain.model.Workspace;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

/** 工作空间领域仓储，在 {@link RepositoryTemplate} 基础能力之外补充批量查询与全量查询。 */
public interface WorkspaceRepository extends RepositoryTemplate<Workspace, Long> {

    /** 新增工作空间并返回数据库自增 id。 */
    Long saveAndReturnId(Workspace entity);

    /** 批量按 id 查询（用于会话装配，保持顺序无要求）。 */
    List<Workspace> findByIds(Collection<Long> ids);

    /** 按宿主目录回查（本地单实例下目录即唯一键）。 */
    Workspace findByHostDir(String hostDir);

    /** 全量查询，供应用启动后把已登记的工作空间交托给运行时框架。 */
    List<Workspace> findAll();
}
