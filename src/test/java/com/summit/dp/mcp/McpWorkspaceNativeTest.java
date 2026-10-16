package com.summit.dp.mcp;

import com.summit.adapter.langchain4j.mcp.McpClientFactory;
import com.summit.core.conf.McpConfig;
import com.summit.core.mcp.McpToolScope;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.dp.mcp.application.service.McpConfigAssembler;
import com.summit.dp.mcp.domain.model.Mcp;
import com.summit.dp.mcp.domain.repository.McpRepository;
import com.summit.dp.mcp.infrastructure.McpManager;
import com.summit.sandbox.mxc.MxcRuntime;
import com.summit.sandbox.mxc.MxcWorkspaceProvider;
import com.summit.sandbox.mxc.MxcWorkspaceSpec;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Stream;
import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.Mockito.*;

/** 原生资源显式提供，测试不安装运行时或扩大目录授权。 */
class McpWorkspaceNativeTest {
    @Test @Timeout(60)
    void businessProviderUsesNativeSandboxAndClosesItsOwnedProcess() throws Exception {
        String node = System.getProperty("mxc.node"), sdk = System.getProperty("mxc.sdk"), base = System.getProperty("mxc.test.root");
        assumeTrue(node != null && sdk != null && base != null, "需显式配置原生 MXC 测试资源");
        Path directory = Files.createDirectories(Path.of(base, "business-" + UUID.randomUUID()));
        Path root = Files.createDirectory(directory.resolve("work space 中文"));
        Path outside = Files.writeString(directory.resolve("outside"), "host-secret");
        Files.writeString(root.resolve("allowed"), "workspace-data");
        Path script = root.resolve("server.mjs");
        try (InputStream input = getClass().getResourceAsStream("/mcp/workspace_server.mjs")) { Files.copy(input, script); }
        MxcRuntime runtime = MxcRuntime.nativeHost(Path.of(node), Path.of(sdk), Path.of(base, "helpers"));
        Workspace workspace = new MxcWorkspaceProvider(runtime).resolve(new MxcWorkspaceSpec(root.toString()));
        Mcp model = Mcp.builder().id(1L).name("business").transport(Mcp.Transport.STDIO)
                .command(List.of(node, "--preserve-symlinks-main", "--preserve-symlinks", script.toString())).env(Map.of())
                .initializationTimeout(Duration.ofSeconds(10)).executionTimeout(Duration.ofSeconds(10))
                .maxOutput(1000).status(Mcp.STATUS_ENABLED).build();
        McpRepository repository = mock(McpRepository.class);
        when(repository.findEnabled()).thenReturn(List.of(model));
        McpConfigAssembler assembler = new McpConfigAssembler();
        McpManager manager = new McpManager(repository, assembler, new McpClientFactory());
        McpConfig config = new McpConfig(); config.setMcp(List.of(assembler.toServer(model)));
        try (McpToolScope scope = manager.openScope(config, workspace)) {
            ToolDefinition<?> tool = scope.getTool("mcp_business_inspect");
            assertNotNull(tool);
            assertEquals("中文参数", call(tool, workspace, "{\"value\":\"中文参数\"}"));
            assertEquals("workspace-data", call(tool, workspace, "{\"path\":\"allowed\"}"));
            String path = outside.toString().replace("\\", "\\\\");
            assertEquals("DENIED", call(tool, workspace, "{\"path\":\"" + path + "\"}"));
        } finally { manager.close(); manager.disconnect(); }
        assertEquals("host-secret", Files.readString(outside));
        if (runtime.windows()) {
            long pid = Long.parseLong(Files.readString(root.resolve("server.pid")));
            assertFalse(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false));
        }
        try (Stream<Path> files = Files.list(runtime.helperDirectory().resolve("requests"))) {
            assertEquals(0, files.count());
        }
    }
    private String call(ToolDefinition<?> tool, Workspace workspace, String args) {
        ToolExecuteResult result = tool.executor().execute(ToolExecution.builder().id(UUID.randomUUID().toString())
                .toolDefinition(tool).workspace(workspace).args(args).build());
        assertEquals(1, result.getCode(), result.getToolOutput());
        return result.getToolOutput();
    }
}
