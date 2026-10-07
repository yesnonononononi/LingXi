package com.summit.dp.mcp.application.service;

import com.summit.ddd.application.vo.PageResult;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.mcp.application.command.McpCommand;
import com.summit.dp.mcp.application.vo.McpVO;
import com.summit.dp.mcp.application.vo.McpConnectionVO;
import com.summit.core.conf.McpConfig;

import java.util.Collection;
import java.util.List;

/**
 * Mcp 应用层服务接口。
 *
 * <p>除标准 CRUD 外，额外提供 {@link #currentConfig()}：把库中<b>启用</b>的 MCP 服务
 * 组装成框架侧 {@link McpConfig}，供 {@code RequestPreparer} 随 {@code AgentRequest} 下行。
 * 这是本模块与框架侧 {@code McpScope} 的唯一契约面。</p>
 */
public interface McpService {
    Result<McpVO> findById(Long id);

    Result<PageResult<McpVO>> findPage(Integer page, Integer pageSize);

    Result<Void> add(McpCommand command);

    Result<McpConnectionVO> connect(McpCommand command);

    Result<Void> update(McpCommand command);

    Result<Void> delById(Long id);

    Result<List<McpVO>> queryIn(Collection<Long> ids);

    /**
     * 组装当前生效的 MCP 配置快照。
     *
     * @return 无启用服务时返回 {@code null}——框架侧按「无 MCP」处理，
     *         与返回空 {@code McpConfig} 语义一致，但少一次对象分配判断
     */
    McpConfig currentConfig();
}
