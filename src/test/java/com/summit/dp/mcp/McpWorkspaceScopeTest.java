package com.summit.dp.mcp;

import com.summit.adapter.langchain4j.mcp.McpClientFactory;
import com.summit.core.conf.McpConfig;
import com.summit.core.mcp.McpToolScope;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.dp.mcp.application.service.McpConfigAssembler;
import com.summit.dp.mcp.domain.model.Mcp;
import com.summit.dp.mcp.domain.repository.McpRepository;
import com.summit.dp.mcp.infrastructure.McpManager;
import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.mcp.client.McpClient;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class McpWorkspaceScopeTest {
    private final McpRepository repository = mock(McpRepository.class);
    private final McpClientFactory factory = mock(McpClientFactory.class);
    private final McpConfigAssembler assembler = new McpConfigAssembler();
    private final McpManager manager = new McpManager(repository, assembler, factory);
    private final Workspace workspace = mock(Workspace.class);

    @AfterEach void close() { manager.close(); manager.disconnect(); }

    @Test void isolatedWorkspaceReusesStdioAndHttpConnectionsWithoutOpeningSandboxSessions() throws Exception {
        when(workspace.runtimeEnvironment()).thenReturn(RuntimeEnvironment.builder().isolated(true).build());
        Mcp stdio = model(1, "stdio"), http = httpModel();
        McpClient hostStdio = register(stdio), hostHttp = register(http);
        for (int i = 0; i < 2; i++) {
            try (McpToolScope scope = manager.openScope(config(stdio, http), workspace)) {
                assertNotNull(scope.getTool("mcp_stdio_inspect"));
                assertNotNull(scope.getTool("mcp_http_inspect"));
                assertEquals(List.of("http", "stdio"), scope.serverNames());
            }
        }
        verify(factory, never()).create(anyString(), any(), any());
        verify(factory, times(2)).create(anyString(), any());
        verify(hostStdio, never()).close();
        verify(hostHttp, never()).close();
        verify(workspace, never()).bridge();
    }

    @Test void providerDoesNotRequireAnyWorkspaceCapability() {
        Mcp stdio = model(1, "stdio");
        register(stdio);
        try (McpToolScope scope = manager.openScope(config(stdio), workspace)) {
            assertNotNull(scope.getTool("mcp_stdio_inspect"));
        }
        verifyNoInteractions(workspace);
    }

    @Test void disabledServiceClosesSharedClientAndOldSnapshotCannotReopenIt() throws Exception {
        Mcp model = model(1, "stdio");
        McpClient shared = register(model);
        McpConfig old = config(model);
        model.changeEnabled(false);
        manager.register(model.getId());
        assertTrue(manager.openScope(old, workspace).isEmpty());
        verify(shared).close();
        verify(factory, times(1)).create(anyString(), any());
        verify(factory, never()).create(anyString(), any(), any());
    }

    @Test void workspaceStillReceivesOnlyRequestedServices() {
        Mcp first = model(1, "first"), second = model(2, "second");
        register(first); register(second);
        try (McpToolScope scope = manager.openScope(config(second), workspace)) {
            assertNull(scope.getTool("mcp_first_inspect"));
            assertNotNull(scope.getTool("mcp_second_inspect"));
        }
    }

    @Test void missingPooledConnectionDoesNotStartAnotherProcess() {
        assertTrue(manager.openScope(config(model(1, "stdio")), workspace).isEmpty());
        verifyNoInteractions(factory);
    }

    @Test void nullWorkspaceUsesTheSamePool() {
        Mcp model = model(1, "stdio");
        register(model);
        try (McpToolScope scope = manager.openScope(config(model), null)) {
            assertNotNull(scope.getTool("mcp_stdio_inspect"));
        }
    }

    private McpClient register(Mcp model) {
        McpClient client = mock(McpClient.class);
        when(repository.findById(model.getId())).thenReturn(Optional.of(model));
        when(factory.create(model.getName(), assembler.toServer(model))).thenReturn(client);
        when(client.listTools()).thenReturn(List.of(ToolSpecification.builder().name("inspect").build()));
        manager.register(model.getId());
        return client;
    }
    private Mcp model(long id, String name) {
        return Mcp.builder().id(id).name(name).transport(Mcp.Transport.STDIO).command(List.of("node", "server.mjs"))
                .env(Map.of()).initializationTimeout(Duration.ofSeconds(1)).executionTimeout(Duration.ofSeconds(1))
                .maxOutput(1000).status(Mcp.STATUS_ENABLED).build();
    }
    private Mcp httpModel() {
        return Mcp.builder().id(2L).name("http").transport(Mcp.Transport.STREAMABLE_HTTP).url("https://example.test/mcp")
                .headers(Map.of()).initializationTimeout(Duration.ofSeconds(1)).executionTimeout(Duration.ofSeconds(1))
                .maxOutput(1000).status(Mcp.STATUS_ENABLED).build();
    }
    private McpConfig config(Mcp... models) {
        McpConfig config = new McpConfig(); config.setMcp(List.of(models).stream().map(assembler::toServer).toList()); return config;
    }
}
