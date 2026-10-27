package com.summit.dp.mcp.infrastructure;

import com.summit.adapter.langchain4j.mcp.Langchain4jMcpSession;
import com.summit.adapter.langchain4j.mcp.MCPToolConverter;
import com.summit.adapter.langchain4j.mcp.McpClientFactory;
import com.summit.core.conf.McpConfig;
import com.summit.core.mcp.McpSession;
import com.summit.core.mcp.McpSessionType;
import com.summit.core.mcp.McpToolScope;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecutor;
import com.summit.ddd.utils.RetryUtil;
import com.summit.dp.mcp.application.service.McpConfigAssembler;
import com.summit.dp.mcp.application.service.McpConnectionRegistry;
import com.summit.dp.mcp.application.service.McpSessionRegistry;
import com.summit.dp.mcp.application.vo.McpConnectionVO;
import com.summit.dp.mcp.domain.model.Mcp;
import com.summit.dp.mcp.domain.repository.McpRepository;
import com.summit.dp.shared.exception.ClientException;
import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.mcp.client.McpClient;
import jakarta.annotation.PreDestroy;
import lombok.NonNull;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;

import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.locks.ReadWriteLock;
import java.util.concurrent.locks.ReentrantReadWriteLock;

/**
 * MCP 暂不进入工作区沙箱，请求统一复用进程级连接。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class McpManager implements McpConnectionRegistry, McpSessionRegistry {

    private static final long RUNTIME_TIMEOUT_GRACE_SECONDS = 5L;
    /** 启动期重试次数（不含首次）；仍失败就等下一次「保存配置」或重启。 */
    private static final int STARTUP_RETRY_TIMES = 1;
    /** 退避基数，RetryUtil 会在此基础上取 0~基数 的随机抖动，避免多个 server 同时重试。 */
    private static final long STARTUP_RETRY_BASIC_DELAY_MILLIS = 2_000L;
    private static final int STARTUP_RETRY_MULTIPLE = 2;
    private final McpRepository repository;
    private final McpConfigAssembler assembler;
    private final McpClientFactory clientFactory;
    private final Map<Long, PooledSession> sessions = new ConcurrentSkipListMap<>();
    // 每个 id 一把锁：注册是 I/O 密集的，共用一把锁会让卡住的 server 把整批排队拖死。
    private final Map<Long, Object> registrationLocks = new ConcurrentHashMap<>();
    // 读锁=注册/移除并行，写锁=关闭整体排除，避免连接在关闭过程中被发布出去。
    private final ReadWriteLock lifecycle = new ReentrantReadWriteLock();
    private final ExecutorService executorService = Executors.newVirtualThreadPerTaskExecutor();

    // JSON 配置首次读取会迁移数据库记录，必须等建表与迁移完成。
    @EventListener(ApplicationReadyEvent.class)
    public void connect() {
        // 并发提交，失败只记日志：启动不能被远端 MCP 拖住。
        repository.findEnabled().forEach(model -> CompletableFuture.runAsync(() -> {
            try {
                // 启动期一次抖动不该让 server 在整个进程生命周期缺席（注册只有启动和保存配置两个入口）。
                // 只补一次：连接失败本身可能已经耗掉整个初始化预算，重试太多会把启动拖成几分钟。
                RetryUtil.retry(STARTUP_RETRY_BASIC_DELAY_MILLIS, STARTUP_RETRY_TIMES, STARTUP_RETRY_MULTIPLE,
                        TimeUnit.MILLISECONDS, () -> {
                            register(model.getId());
                            return null;
                        });
            } catch (Exception failure) {
                log.warn("初始化 MCP 连接失败: id={}, name={}, error={}", model.getId(), model.getName(), failure.getMessage());
            }
        }, executorService));
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
            log.warn("测试 MCP 连接失败: name={}, error={}", server.name(), failure.getMessage());
            throw new ClientException("MCP 连接测试失败，请检查服务地址、启动命令、凭据和超时设置", failure);
        }
    }

    @Override
    public void register(Long id) {
        throwIf(id == null, "MCP 配置标识不能为空");
        lifecycle.readLock().lock();
        try {
            synchronized (resolveRegistrationLock(id)) {
                registerLocked(id);
            }
        } finally {
            lifecycle.readLock().unlock();
        }
    }

    private void registerLocked(Long id) {
        // 同 id 串行时重新读取已保存配置，避免并发保存把旧配置重新发布。
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
                    new MCPToolConverter(server.maxOutput(), runtimeTimeout, McpToolNaming.buildPrefix(server.name())), McpSessionType.REUSE);
            PooledSession ready = new PooledSession(server, candidate, List.copyOf(candidate.tools()));
            PooledSession previous = sessions.put(id, ready);
            closeQuietly(previous);
            log.info("注册 MCP 连接: id={}, name={}", id, server.name());
        } catch (RuntimeException failure) {
            closeQuietly(candidate);
            remove(id);
            log.warn("注册 MCP 连接失败: id={}, name={}, error={}", id, server.name(), failure.getMessage());
            throw new ClientException("MCP 配置已保存，但连接或工具发现失败，请检查地址、启动命令、凭据和超时设置", failure);
        }
    }

    @Override
    public void remove(Long id) {
        throwIf(id == null, "MCP 配置标识不能为空");
        lifecycle.readLock().lock();
        try {
            // 与 register 同锁：否则在途注册会把刚摘掉的连接又发布回来，留下没人管的子进程。
            synchronized (resolveRegistrationLock(id)) {
                closeQuietly(sessions.remove(id));
            }
        } finally {
            lifecycle.readLock().unlock();
        }
    }

    /** 同一 id 的注册与移除共用一把锁，不同 id 之间互不阻塞。 */
    private Object resolveRegistrationLock(Long id) {
        return registrationLocks.computeIfAbsent(id, ignored -> new Object());
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
    public void close() {
        // 写锁排除在途注册：否则刚建好的连接会逃过这次关闭，子进程变成孤儿。
        lifecycle.writeLock().lock();
        try {
            sessions.values().forEach(this::closeQuietly);
            sessions.clear();
        } finally {
            lifecycle.writeLock().unlock();
        }
    }

    private void closeQuietly(McpSession session) {
        if (session == null) return;
        try {
            session.close();
        } catch (RuntimeException failure) {
            log.warn("关闭 MCP 连接失败: name={}, error={}", session.name(), failure.getMessage());
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
