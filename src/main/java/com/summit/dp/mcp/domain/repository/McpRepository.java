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
     * 查询全部<b>启用</b>的 MCP 服务，供请求级装配使用。
     * <p>过滤下推到 SQL（status = 1），不在应用层捞全表再筛。</p>
     */
    List<Mcp> findEnabled();
}
