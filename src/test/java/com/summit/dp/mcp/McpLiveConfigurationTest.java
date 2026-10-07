package com.summit.dp.mcp;

import com.summit.adapter.langchain4j.mcp.McpClientFactory;
import com.summit.core.conf.McpConfig;
import com.summit.core.mcp.McpToolScope;
import com.summit.dp.mcp.application.command.McpCommand;
import com.summit.dp.mcp.application.service.McpConfigAssembler;
import com.summit.dp.mcp.application.service.impl.McpServiceImpl;
import com.summit.dp.mcp.application.service.impl.McpValidator;
import com.summit.dp.mcp.domain.model.Mcp;
import com.summit.dp.mcp.domain.repository.McpRepository;
import com.summit.dp.mcp.infrastructure.McpManager;
import com.summit.dp.shared.exception.ClientException;
import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.mcp.client.McpClient;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class McpLiveConfigurationTest {

    private final Map<Long, Mcp> records = new HashMap<>();
    private final McpRepository repository = mock(McpRepository.class);
    private final McpClientFactory factory = mock(McpClientFactory.class);
    private final McpConfigAssembler assembler = new McpConfigAssembler();
    private final McpManager manager = new McpManager(repository, assembler, factory);
    private final McpServiceImpl service = new McpServiceImpl(repository, new McpValidator(repository),
            assembler, manager);

    @BeforeEach
    void prepareRepository() {
        doAnswer(invocation -> {
            Mcp model = invocation.getArgument(0);
            records.put(model.getId(), model);
            return null;
        }).when(repository).save(any(Mcp.class));
        doAnswer(invocation -> {
            Mcp model = invocation.getArgument(0);
            records.put(model.getId(), model);
            return null;
        }).when(repository).updateById(any(Mcp.class));
        doAnswer(invocation -> {
            Mcp model = invocation.getArgument(0);
            records.remove(model.getId());
            return null;
        }).when(repository).delete(any(Mcp.class));
        when(repository.findById(anyLong())).thenAnswer(invocation ->
                Optional.ofNullable(records.get(invocation.<Long>getArgument(0))));
        when(repository.findByName(anyString())).thenAnswer(invocation -> records.values().stream()
                .filter(model -> model.getName().equals(invocation.<String>getArgument(0))).findFirst());
        when(repository.findEnabled()).thenAnswer(invocation -> records.values().stream()
                .filter(Mcp::enabled).toList());
    }

    private McpCommand command() {
        McpCommand command = new McpCommand();
        command.setName("test-server");
        command.setTransport("streamable-http");
        command.setUrl("https://example.test/mcp");
        return command;
    }

    private McpClient client(String name) {
        McpClient client = mock(McpClient.class);
        when(client.listTools()).thenReturn(List.of(ToolSpecification.builder().name(name).build()));
        doAnswer(invocation -> {
            assertFalse(records.isEmpty(), "连接之前配置必须已经保存");
            return client;
        }).when(factory).create(anyString(), any());
        return client;
    }

    @Test
    void addImmediatelyMakesToolAvailableForNextRequestWithoutRestart() throws Exception {
        McpClient client = client("inspect");
        manager.connect();
        service.add(command());

        Mcp saved = records.values().iterator().next();
        assertNotNull(saved.getId());
        try (McpToolScope scope = manager.openScope(service.currentConfig())) {
            assertNotNull(scope.getTool("mcp_inspect"));
        }
        verify(repository).save(saved);
        verify(client).listTools();
        manager.close();
    }

    @Test
    void updateDisableEnableAndDeleteSynchronizePool() throws Exception {
        McpClient original = client("original");
        service.add(command());
        Long id = records.keySet().iterator().next();

        McpClient replacement = client("replacement");
        McpCommand update = new McpCommand();
        update.setId(id);
        update.setName("renamed");
        update.setUrl("https://changed.test/mcp");
        service.update(update);
        verify(original).close();
        try (McpToolScope scope = manager.openScope(service.currentConfig())) {
            assertNull(scope.getTool("mcp_original"));
            assertNotNull(scope.getTool("mcp_replacement"));
            assertEquals(List.of("renamed"), scope.serverNames());
        }

        McpCommand disable = new McpCommand();
        disable.setId(id);
        disable.setStatus(Mcp.STATUS_DISABLED);
        service.update(disable);
        assertNull(service.currentConfig());
        verify(replacement).close();

        McpClient enabled = client("enabled");
        McpCommand enable = new McpCommand();
        enable.setId(id);
        enable.setStatus(Mcp.STATUS_ENABLED);
        service.update(enable);
        try (McpToolScope scope = manager.openScope(service.currentConfig())) {
            assertNotNull(scope.getTool("mcp_enabled"));
        }
        McpConfig beforeDeletion = service.currentConfig();
        service.delById(id);
        assertTrue(records.isEmpty());
        assertTrue(manager.openScope(beforeDeletion).isEmpty());
        verify(enabled).close();
    }

    @Test
    void connectionFailureReportsPersistedConfigurationAndCanBeRetriedBySaving() {
        when(factory.create(anyString(), any())).thenThrow(new IllegalStateException("unreachable"));
        ClientException failure = assertThrows(ClientException.class, () -> service.add(command()));
        assertTrue(failure.getMessage().contains("配置已保存"));
        assertEquals(1, records.size());
        assertTrue(manager.openScope(service.currentConfig()).isEmpty());

        client("recovered");
        McpCommand retry = new McpCommand();
        retry.setId(records.keySet().iterator().next());
        service.update(retry);
        try (McpToolScope scope = manager.openScope(service.currentConfig())) {
            assertNotNull(scope.getTool("mcp_recovered"));
        }
        manager.close();
    }

    @Test
    void persistenceFailureDoesNotAttemptConnection() {
        doThrow(new IllegalStateException("save failed")).when(repository).save(any(Mcp.class));
        assertThrows(IllegalStateException.class, () -> service.add(command()));
        verifyNoInteractions(factory);
        assertTrue(records.isEmpty());
    }
}
