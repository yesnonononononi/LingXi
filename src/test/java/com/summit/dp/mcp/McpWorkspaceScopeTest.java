package com.summit.dp.mcp;

import com.summit.adapter.langchain4j.mcp.McpClientFactory;
import com.summit.core.conf.McpConfig;
import com.summit.core.mcp.McpToolScope;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceBridge;
import com.summit.core.runtime.workspace.WorkspaceStdioLauncher;
import com.summit.dp.mcp.application.service.McpConfigAssembler;
import com.summit.dp.mcp.domain.model.Mcp;
import com.summit.dp.mcp.domain.repository.McpRepository;
import com.summit.dp.mcp.infrastructure.McpManager;
import com.summit.dp.shared.exception.ClientException;
import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.mcp.client.McpClient;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.HashMap;
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

    private final Map<Long, Mcp> configured = new HashMap<>();
    @BeforeEach void configuration() {
        when(repository.findEnabled()).thenAnswer(invocation -> configured.values().stream().filter(Mcp::enabled).toList());
    }

    @AfterEach void close() { manager.close(); manager.disconnect(); }

    @Test void localWorkspaceUsesTheSharedPool() throws Exception {
        Mcp model = model(1, "first");
        McpClient shared = register(model);
        when(workspace.runtimeEnvironment()).thenReturn(RuntimeEnvironment.builder().isolated(false).build());
        try (McpToolScope scope = manager.openScope(config(model), workspace)) {
            assertNotNull(scope.getTool("mcp_first_inspect"));
        }
        verify(factory, never()).create(anyString(), any(), any());
        verify(shared, never()).close();
    }

    @Test void sandboxUsesRequestOwnedClientsAndPreservesNamesAcrossServers() throws Exception {
        isolated();
        Mcp first = model(1, "first"), second = model(2, "second");
        McpClient hostFirst = register(first), hostSecond = register(second);
        McpClient requestFirst = client(), requestSecond = client(), nextFirst = client();
        when(factory.create("first", assembler.toServer(first), workspace)).thenReturn(requestFirst, nextFirst);
        when(factory.create("second", assembler.toServer(second), workspace)).thenReturn(requestSecond);
        McpToolScope scope = manager.openScope(config(first, second), workspace);
        assertNotNull(scope.getTool("mcp_first_inspect"));
        assertNotNull(scope.getTool("mcp_second_inspect"));
        scope.close(); scope.close();
        verify(requestFirst, times(1)).close();
        verify(requestSecond, times(1)).close();
        verify(hostFirst, never()).close();
        verify(hostSecond, never()).close();
        try (McpToolScope next = manager.openScope(config(first), workspace)) {
            assertNotNull(next.getTool("mcp_first_inspect"));
        }
        verify(nextFirst).close();
        verify(factory, times(2)).create(eq("first"), eq(assembler.toServer(first)), same(workspace));
    }

    @Test void sandboxCanStartWithoutAReadyHostConnection() throws Exception {
        isolated();
        Mcp model = model(1, "first");
        configured.put(model.getId(), model);
        McpClient isolated = client();
        when(factory.create("first", assembler.toServer(model), workspace)).thenReturn(isolated);
        try (McpToolScope scope = manager.openScope(config(model), workspace)) {
            assertNotNull(scope.getTool("mcp_first_inspect"));
        }
        verify(factory, never()).create(anyString(), any());
        verify(isolated).close();
    }

    @Test void sandboxRejectsHttpBeforeStartingAnyServer() {
        isolated();
        Mcp stdio = model(1, "stdio");
        ClientException failure = assertThrows(ClientException.class, () -> manager.openScope(config(stdio, httpModel()), workspace));
        assertTrue(failure.getMessage().contains("仅支持 stdio"));
        verifyNoInteractions(factory);
    }

    @Test void unsupportedSandboxDoesNotFallBackToHost() {
        isolated();
        when(workspace.bridge()).thenReturn(mock(WorkspaceBridge.class));
        assertThrows(ClientException.class, () -> manager.openScope(config(model(1, "stdio")), workspace));
        verifyNoInteractions(factory);
    }

    @Test void disabledServerCannotBeReopenedFromOldSnapshot() throws Exception {
        isolated();
        Mcp model = model(1, "first");
        McpClient shared = register(model);
        McpConfig old = config(model);
        model.changeEnabled(false);
        manager.register(model.getId());
        assertTrue(manager.openScope(old, workspace).isEmpty());
        verify(shared).close();
        verify(factory, never()).create(anyString(), any(), any());
    }

    @Test void discoveryFailureClosesIsolatedClientAndKeepsHostPool() throws Exception {
        isolated();
        Mcp model = model(1, "first");
        McpClient shared = register(model), isolated = client();
        when(isolated.listTools()).thenThrow(new IllegalStateException("discovery failed"));
        when(factory.create("first", assembler.toServer(model), workspace)).thenReturn(isolated);
        assertTrue(manager.openScope(config(model), workspace).isEmpty());
        verify(isolated).close();
        verify(shared, never()).close();
    }

    @Test void isolatedStartupFailureNeverUsesSharedTools() {
        isolated();
        Mcp model = model(1, "first");
        register(model);
        when(factory.create("first", assembler.toServer(model), workspace)).thenThrow(new IllegalStateException("startup failed"));
        assertTrue(manager.openScope(config(model), workspace).isEmpty());
        verify(factory, times(1)).create("first", assembler.toServer(model));
    }

    private void isolated() {
        when(workspace.runtimeEnvironment()).thenReturn(RuntimeEnvironment.builder().isolated(true).build());
        when(workspace.bridge()).thenReturn(mock(WorkspaceBridge.class, withSettings().extraInterfaces(WorkspaceStdioLauncher.class)));
    }
    private McpClient register(Mcp model) {
        configured.put(model.getId(), model);
        McpClient client = client();
        when(repository.findById(model.getId())).thenReturn(Optional.of(model));
        when(factory.create(model.getName(), assembler.toServer(model))).thenReturn(client);
        manager.register(model.getId());
        return client;
    }
    private McpClient client() {
        McpClient client = mock(McpClient.class);
        when(client.listTools()).thenReturn(List.of(ToolSpecification.builder().name("inspect").build()));
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
