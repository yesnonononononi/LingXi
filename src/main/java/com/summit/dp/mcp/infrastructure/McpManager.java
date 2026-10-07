package com.summit.dp.mcp.infrastructure;

import com.summit.adapter.langchain4j.mcp.Langchain4jMcpSession;
import com.summit.adapter.langchain4j.mcp.MCPToolConverter;
import com.summit.adapter.langchain4j.mcp.McpClientFactory;
import com.summit.core.conf.McpConfig;
import com.summit.core.mcp.McpSession;
import com.summit.core.mcp.McpSessionType;
import com.summit.core.mcp.McpToolScope;
import com.summit.core.mcp.ScopeMcpProvider;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.mcp.application.service.McpConfigAssembler;
import com.summit.dp.mcp.application.service.McpConnectionRegistry;
import com.summit.dp.mcp.application.vo.McpConnectionVO;
import com.summit.dp.mcp.domain.model.Mcp;
import com.summit.dp.mcp.domain.repository.McpRepository;
import com.summit.dp.shared.exception.ClientException;
import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.mcp.client.McpClient;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.apache.tomcat.util.threads.VirtualThreadExecutor;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;
import java.util.concurrent.*;

/**
 * 连接和工具发现提前完成，请求只装配已就绪的进程级连接。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class McpManager implements ScopeMcpProvider, McpConnectionRegistry {

    private static final long RUNTIME_TIMEOUT_GRACE_SECONDS = 5L;
    private final McpRepository repository;
    private final McpConfigAssembler assembler;
    private final McpClientFactory clientFactory;
    private final Map<Long, PooledSession> sessions = new ConcurrentSkipListMap<>();
    private final ExecutorService executorService = Executors.newVirtualThreadPerTaskExecutor();

    @PostConstruct
    public void connect() {

        List<CompletableFuture<Void>> futures = repository.findEnabled().stream()
                .map(model -> CompletableFuture.runAsync(() -> {
                    try {
                        register(model.getId());
                    } catch (ClientException failure) {
                        log.warn("初始化 MCP 连接失败: id={}, name={}",
                                model.getId(), model.getName(), failure);
                    }
                }, executorService))
                .toList();

    }


    @PreDestroy
    public void disconnect() {
         this.executorService.close();
    }


    @Override
    public McpConnectionVO connect(McpConfig.MCP server) {
        throwIf(server == null, "MCP 连接配置不能为空");
        long started = System.nanoTime();
        // 测试连接独立关闭，不能改变已有执行使用的共享连接。
        try (McpClient client = clientFactory.create(server.name(), server)) {
            List<String> names = client.listTools().stream().map(ToolSpecification::name).sorted().toList();
            return new McpConnectionVO(names.size(), names, (System.nanoTime() - started) / 1_000_000L);
        } catch (Exception failure) {
            log.warn("测试 MCP 连接失败: name={}, error={}", server.name(), failure.getClass().getSimpleName());
            throw new ClientException("MCP 连接测试失败，请检查服务地址、启动命令、凭据和超时设置");
        }
    }

    @Override
    public synchronized void register(Long id) {
        throwIf(id == null, "MCP 配置标识不能为空");
        // 串行同步时重新读取已保存配置，避免并发保存把旧配置重新发布。
        Mcp model = repository.findById(id).orElse(null);
        if (model == null || !model.enabled()) {
            remove(id);
            return;
        }
        McpConfig.MCP server = assembler.toServer(model);
        PooledSession current = sessions.get(id);
        if (current != null && current.server().equals(server)) return;

        McpSession candidate = null;
        try {
            long runtimeTimeout = (long) Math.ceil(server.executionTimeout().toMillis() / 1000.0)
                    + RUNTIME_TIMEOUT_GRACE_SECONDS;
            candidate = Langchain4jMcpSession.connect(server.name(), server.description(),
                    clientFactory.create(server.name(), server),
                    new MCPToolConverter(server.maxOutput(), runtimeTimeout, "mcp_"), McpSessionType.REUSE);
            PooledSession ready = new PooledSession(server, candidate, List.copyOf(candidate.tools()));
            PooledSession previous = sessions.put(id, ready);
            closeQuietly(previous);
            log.info("注册 MCP 连接: id={}, name={}", id, server.name());
        } catch (RuntimeException failure) {
            closeQuietly(candidate);
            remove(id);
            log.warn("注册 MCP 连接失败: id={}, name={}, error={}", id, server.name(),
                    failure.getMessage());
            throw new ClientException("MCP 配置已保存，但连接或工具发现失败，请检查地址、启动命令、凭据和超时设置");
        }
    }

    @Override
    public synchronized void remove(Long id) {
        throwIf(id == null, "MCP 配置标识不能为空");
        closeQuietly(sessions.remove(id));
    }

    @Override
    public McpToolScope openScope(@NonNull McpConfig mcpConfig) {
        if (mcpConfig.getMcp() == null || mcpConfig.getMcp().isEmpty()) return McpToolScope.EMPTY;
        List<McpSession> available = sessions.values().stream()
                .filter(session -> mcpConfig.getMcp().contains(session.server()))
                .map(session -> (McpSession) session)
                .toList();
        return McpToolScope.of(available);
    }

    @PreDestroy
    public synchronized void close() {
        sessions.values().forEach(this::closeQuietly);
        sessions.clear();
    }

    private void closeQuietly(McpSession session) {
        if (session == null) return;
        try {
            session.close();
        } catch (RuntimeException failure) {
            log.warn("关闭 MCP 连接失败: name={}, error={}", session.name(), failure.getClass().getSimpleName());
        }
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }

    /**
     * 工具定义随连接发布，避免请求阶段再次访问远端。
     */
    private record PooledSession(McpConfig.MCP server, McpSession delegate,
                                 List<ToolDefinition<? extends ToolExecutor>> tools) implements McpSession {

        @Override
        public String name() {
            return server.name();
        }

        @Override
        public String description() {
            return server.description() == null ? "" : server.description();
        }

        @Override
        public McpSessionType type() {
            return McpSessionType.REUSE;
        }

        @Override
        public void checkHealth() {
            delegate.checkHealth();
        }

        @Override
        public void close() {
            delegate.close();
        }
    }
}
