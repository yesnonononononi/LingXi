package com.summit.dp.mcp.domain.repository;

import com.summit.ddd.domain.repository.RepositoryTemplate;
import com.summit.dp.mcp.domain.model.Mcp;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

/**
 * Mcp 领域仓储。
 */
public interface McpRepository extends RepositoryTemplate<Mcp, Long> {

    /**
     * 按标识集合批量查询
     */
    Collection<Mcp> findList(Collection<Long> ids);

    /**
     * 按服务名精确查询，用于新增/改名时的重名校验。
     */
    Optional<Mcp> findByName(String name);

    /**
     * 仅启用的服务参与请求装配，按 ID 保持稳定顺序。
     */
    List<Mcp> findEnabled();
}
