package com.summit.dp.mcp;

import com.summit.dp.workflow.infrastructure.mcp.HostMcpScopeProvider;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.adapter.langchain4j.mcp.McpClientFactory;
import com.summit.core.conf.McpConfig;
import com.summit.core.mcp.McpToolScope;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.dp.mcp.application.service.McpConfigAssembler;
import com.summit.dp.mcp.domain.model.Mcp;
import com.summit.dp.mcp.domain.repository.McpRepository;
import com.summit.dp.mcp.infrastructure.McpManager;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.junit.jupiter.api.io.TempDir;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** 用真实 stdio 与 HTTP 通道守住暂时停用 MCP 沙箱的行为。 */
class McpWorkspaceNativeTest {
    @TempDir Path directory;
    private final McpRepository repository = mock(McpRepository.class);
    private final McpConfigAssembler assembler = new McpConfigAssembler();
    private final ObjectMapper json = new ObjectMapper();

    @Test @Timeout(30)
    void isolatedRequestUsesHostStdioAndDisableTerminatesTheSharedProcess() throws Exception {
        Path root = Files.createDirectory(directory.resolve("work space 中文"));
        Path outside = Files.writeString(directory.resolve("outside"), "host-canary");
        Path pidFile = root.resolve("server.pid");
        Path script = root.resolve("server.mjs");
        try (InputStream input = getClass().getResourceAsStream("/mcp/workspace_server.mjs")) { Files.copy(input, script); }
        String node = System.getProperty("mcp.test.node", "node");
        Mcp model = Mcp.builder().id(1L).name("business").transport(Mcp.Transport.STDIO)
                .command(List.of(node, script.toString())).env(Map.of("MCP_TEST_PID_FILE", pidFile.toString()))
                .initializationTimeout(Duration.ofSeconds(5)).executionTimeout(Duration.ofSeconds(5))
                .maxOutput(1000).status(Mcp.STATUS_ENABLED).build();
        when(repository.findById(1L)).thenReturn(Optional.of(model));
        McpManager manager = new McpManager(repository, assembler, new McpClientFactory());
        Workspace workspace = workspace(root);
        try {
            manager.register(1L);
            try (McpToolScope scope = new HostMcpScopeProvider(manager).openScope(config(model), workspace)) {
                ToolDefinition<?> tool = scope.getTool("mcp_business_inspect");
                assertNotNull(tool);
                assertEquals("中文参数", call(tool, workspace, Map.of("value", "中文参数")));
                assertEquals("host-canary", call(tool, workspace, Map.of("path", outside.toString())));
            }
            long pid = Long.parseLong(Files.readString(pidFile));
            assertTrue(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false));
            model.changeEnabled(false);
            manager.register(1L);
            assertTrue(new HostMcpScopeProvider(manager).openScope(config(model), workspace).isEmpty());
            for (int i = 0; i < 100 && ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false); i++) Thread.sleep(20);
            assertFalse(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false));
        } finally { manager.close(); manager.disconnect(); }
        assertEquals("host-canary", Files.readString(outside));
        verify(workspace, never()).bridge();
    }

    @Test @Timeout(30)
    void isolatedRequestCanUseTheRegisteredHttpServer() throws Exception {
        try (McpHttpFixture fixture = new McpHttpFixture("Bearer fixture-token")) {
            Mcp model = Mcp.builder().id(2L).name("remote").transport(Mcp.Transport.STREAMABLE_HTTP)
                    .url(fixture.url()).headers(Map.of("Authorization", "Bearer fixture-token"))
                    .initializationTimeout(Duration.ofSeconds(5)).executionTimeout(Duration.ofSeconds(5))
                    .maxOutput(1000).status(Mcp.STATUS_ENABLED).build();
            when(repository.findById(2L)).thenReturn(Optional.of(model));
            McpManager manager = new McpManager(repository, assembler, new McpClientFactory());
            Workspace workspace = workspace(directory);
            try {
                manager.register(2L);
                try (McpToolScope scope = new HostMcpScopeProvider(manager).openScope(config(model), workspace)) {
                    assertNotNull(scope.getTool("mcp_remote_http_echo"));
                }
                manager.remove(2L);
                assertTrue(new HostMcpScopeProvider(manager).openScope(config(model), workspace).isEmpty());
            } finally { manager.close(); manager.disconnect(); }
            verify(workspace, never()).bridge();
        }
    }

    private Workspace workspace(Path root) {
        Workspace workspace = mock(Workspace.class);
        when(workspace.runtimeEnvironment()).thenReturn(RuntimeEnvironment.builder().isolated(true).build());
        when(workspace.workDir()).thenReturn(root.toString());
        return workspace;
    }
    private McpConfig config(Mcp model) {
        McpConfig config = new McpConfig(); config.setMcp(List.of(assembler.toServer(model))); return config;
    }
    private String call(ToolDefinition<?> tool, Workspace workspace, Map<String, String> args) throws Exception {
        ToolExecuteResult result = tool.executor().execute(ToolExecution.builder().id(UUID.randomUUID().toString())
                .toolDefinition(tool).workspace(workspace).args(json.writeValueAsString(args)).build());
        assertEquals(1, result.getCode(), result.getToolOutput());
        return result.getToolOutput();
    }
}
