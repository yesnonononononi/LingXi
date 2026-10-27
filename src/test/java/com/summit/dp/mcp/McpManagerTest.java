package com.summit.dp.mcp;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.summit.adapter.langchain4j.mcp.McpClientFactory;
import com.summit.core.conf.McpConfig;
import com.summit.core.mcp.McpToolScope;
import com.summit.dp.mcp.application.service.McpConfigAssembler;
import com.summit.dp.mcp.domain.model.Mcp;
import com.summit.dp.mcp.domain.repository.McpRepository;
import com.summit.dp.mcp.infrastructure.McpManager;
import com.summit.dp.shared.exception.ClientException;
import dev.langchain4j.agent.tool.ToolSpecification;
import dev.langchain4j.mcp.client.McpClient;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.slf4j.LoggerFactory;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class McpManagerTest {

    @Test
    void startupReadsConfigurationOnlyAfterApplicationReady() {
        try (AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext()) {
            context.registerBean(McpRepository.class, () -> repository);
            context.registerBean(McpClientFactory.class, () -> factory);
            context.registerBean(McpConfigAssembler.class, () -> assembler);
            context.register(McpManager.class);
            context.refresh();
            verify(repository, never()).findEnabled();

            when(repository.findEnabled()).thenReturn(List.of());
            context.publishEvent(new ApplicationReadyEvent(new SpringApplication(McpManager.class),
                    new String[0], context, Duration.ZERO));
            verify(repository, times(1)).findEnabled();
        }
    }

    private final McpRepository repository = mock(McpRepository.class);
    private final McpClientFactory factory = mock(McpClientFactory.class);
    private final McpConfigAssembler assembler = new McpConfigAssembler();
    private final McpManager manager = new McpManager(repository, assembler, factory);

    private Mcp model(long id, String name) {
        return Mcp.builder().id(id).name(name).transport(Mcp.Transport.STREAMABLE_HTTP)
                .url("https://example.test/" + name).headers(Map.of()).description(name)
                .initializationTimeout(Duration.ofSeconds(1)).executionTimeout(Duration.ofSeconds(1))
                .maxOutput(1000).status(Mcp.STATUS_ENABLED).build();
    }

    private McpClient client(Mcp model, String toolName) {
        McpClient client = mock(McpClient.class);
        when(repository.findById(model.getId())).thenReturn(Optional.of(model));
        when(factory.create(model.getName(), assembler.toServer(model))).thenReturn(client);
        when(client.listTools()).thenReturn(List.of(ToolSpecification.builder().name(toolName)
                .description(toolName).build()));
        return client;
    }

    private McpConfig config(Mcp... models) {
        McpConfig config = new McpConfig();
        config.setMcp(List.of(models).stream().map(assembler::toServer).toList());
        return config;
    }

    @Test
    void registerPublishesToolsWithoutRequestTimeIoAndScopeDoesNotCloseSharedClient() throws Exception {
        Mcp model = model(1L, "first");
        McpClient client = client(model, "inspect");
        manager.register(1L);
        manager.register(1L);

        try (McpToolScope scope = manager.openScope(config(model))) {
            assertNotNull(scope.getTool("mcp_first_inspect"));
            assertEquals(List.of("first"), scope.serverNames());
        }
        try (McpToolScope scope = manager.openScope(config(model))) {
            assertNotNull(scope.getTool("mcp_first_inspect"));
        }
        verify(client, times(1)).listTools();
        verify(factory, times(1)).create(anyString(), any());
        verify(client, never()).close();
        manager.close();
        manager.close();
        verify(client, times(1)).close();
    }

    @Test
    void removeClosesClientAndNextScopeDoesNotContainItsTools() throws Exception {
        Mcp model = model(1L, "first");
        McpClient client = client(model, "inspect");
        manager.register(1L);
        manager.remove(1L);
        manager.remove(1L);

        assertTrue(manager.openScope(config(model)).isEmpty());
        verify(client, times(1)).close();
    }

    @Test
    void updateReplacesRenamedConnectionAndRejectsOldRequestConfig() throws Exception {
        Mcp original = model(1L, "first");
        McpClient oldClient = client(original, "old_tool");
        manager.register(1L);
        Mcp changed = model(1L, "renamed");
        McpClient newClient = client(changed, "new_tool");
        manager.register(1L);

        assertTrue(manager.openScope(config(original)).isEmpty());
        try (McpToolScope scope = manager.openScope(config(changed))) {
            assertNull(scope.getTool("mcp_first_old_tool"));
            assertNotNull(scope.getTool("mcp_renamed_new_tool"));
            assertEquals(List.of("renamed"), scope.serverNames());
        }
        verify(oldClient).close();
        verify(newClient, never()).close();
        manager.close();
    }

    @Test
    void disableRemovesExistingConnectionWithoutConnectingAgain() throws Exception {
        Mcp model = model(1L, "first");
        McpClient client = client(model, "inspect");
        manager.register(1L);
        model.changeEnabled(false);
        manager.register(1L);

        assertTrue(manager.openScope(config(model)).isEmpty());
        verify(factory, times(1)).create(anyString(), any());
        verify(client).close();
    }

    @Test
    void discoveryFailureClosesCandidateAndRemovesStaleConnection() throws Exception {
        Mcp original = model(1L, "first");
        McpClient oldClient = client(original, "old_tool");
        manager.register(1L);
        Mcp changed = model(1L, "changed");
        McpClient brokenClient = client(changed, "new_tool");
        when(brokenClient.listTools()).thenThrow(new IllegalStateException("secret=do-not-expose"));

        ClientException failure = assertThrows(ClientException.class, () -> manager.register(1L));
        assertTrue(failure.getMessage().contains("配置已保存"));
        assertFalse(failure.getMessage().contains("do-not-expose"));
        assertTrue(manager.openScope(config(original, changed)).isEmpty());
        verify(oldClient).close();
        verify(brokenClient).close();
    }

    /** 内部异常链保留原始原因，面向用户的文案不暴露内部细节。 */
    @Test
    void discoveryFailureKeepsOriginalCauseForDiagnosis() {
        Mcp model = model(1L, "first");
        McpClient brokenClient = client(model, "inspect");
        when(brokenClient.listTools()).thenThrow(new IllegalStateException("secret=do-not-expose"));

        ClientException failure = assertThrows(ClientException.class, () -> manager.register(1L));

        assertNotNull(failure.getCause());
        assertEquals("secret=do-not-expose", rootCause(failure).getMessage());
        assertFalse(failure.getMessage().contains("do-not-expose"));
    }

    private Throwable rootCause(Throwable failure) {
        Throwable current = failure;
        while (current.getCause() != null && current.getCause() != current) {
            current = current.getCause();
        }
        return current;
    }

    @Test
    void connectionFailuresLogOnlyTheirMessages() throws Exception {
        Logger logger = (Logger) LoggerFactory.getLogger(McpManager.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            Mcp broken = model(1L, "broken");
            when(repository.findById(1L)).thenReturn(Optional.of(broken));
            when(factory.create(eq("broken"), any())).thenThrow(new IllegalStateException("connection unavailable"));

            assertThrows(ClientException.class, () -> manager.connect(assembler.toServer(broken)));
            assertThrows(ClientException.class, () -> manager.register(1L));
            when(repository.findEnabled()).thenReturn(List.of(broken));
            manager.connect();
            manager.disconnect();

            Mcp closing = model(2L, "closing");
            McpClient client = client(closing, "inspect");
            doThrow(new IllegalStateException("close unavailable")).when(client).close();
            manager.register(2L);
            manager.remove(2L);

            List<ILoggingEvent> warnings = appender.list.stream()
                    .filter(event -> event.getLevel() == Level.WARN).toList();
            assertEquals(6, warnings.size());
            for (ILoggingEvent event : warnings) {
                assertNull(event.getThrowableProxy(), event.getFormattedMessage());
            }
            assertEquals("测试 MCP 连接失败: name=broken, error=connection unavailable", warnings.getFirst().getFormattedMessage());
            assertEquals("注册 MCP 连接失败: id=1, name=broken, error=connection unavailable", warnings.get(1).getFormattedMessage());
            assertTrue(warnings.get(4).getFormattedMessage().startsWith("初始化 MCP 连接失败: id=1, name=broken, error="));
            assertEquals("关闭 MCP 连接失败: name=closing, error=Failed to close MCP client of server 'closing'",
                    warnings.getLast().getFormattedMessage());
        } finally {
            logger.detachAppender(appender);
            appender.stop();
            manager.disconnect();
            manager.close();
        }
    }

    @Test
    void startupHandlesEmptyConfigurationAndSkipsUnreachableServer() {
        when(repository.findEnabled()).thenReturn(List.of());
        assertDoesNotThrow(() -> { manager.connect(); });

        Mcp broken = model(1L, "broken");
        Mcp healthy = model(2L, "healthy");
        when(repository.findById(1L)).thenReturn(Optional.of(broken));
        when(factory.create(eq("broken"), any())).thenThrow(new IllegalStateException("unreachable"));
        client(healthy, "inspect");
        when(repository.findEnabled()).thenReturn(List.of(broken, healthy));
        assertDoesNotThrow(() -> { manager.connect(); });
        // 启动连接在后台执行，先等待任务落定再检查连接池。
        manager.disconnect();
        try (McpToolScope scope = manager.openScope(config(broken, healthy))) {
            assertEquals(List.of("healthy"), scope.serverNames());
        }
        manager.close();
    }

    @Test
    void startupRetriesTransientFailureAndPublishesTools() {
        Mcp model = model(1L, "flaky");
        McpClient client = mock(McpClient.class);
        when(repository.findById(1L)).thenReturn(Optional.of(model));
        when(client.listTools()).thenReturn(List.of(ToolSpecification.builder()
                .name("inspect").description("inspect").build()));
        when(factory.create(eq("flaky"), any()))
                .thenThrow(new IllegalStateException("first attempt fails"))
                .thenReturn(client);
        when(repository.findEnabled()).thenReturn(List.of(model));

        manager.connect();
        manager.disconnect();

        try (McpToolScope scope = manager.openScope(config(model))) {
            assertNotNull(scope.getTool("mcp_flaky_inspect"));
        }
        verify(factory, times(2)).create(eq("flaky"), any());
        manager.close();
    }

    @Test
    void startupGivesUpAfterSingleRetry() {
        Mcp model = model(1L, "dead");
        when(repository.findById(1L)).thenReturn(Optional.of(model));
        when(factory.create(eq("dead"), any())).thenThrow(new IllegalStateException("always fails"));
        when(repository.findEnabled()).thenReturn(List.of(model));

        manager.connect();
        manager.disconnect();

        assertTrue(manager.openScope(config(model)).isEmpty());
        // 只补一次：退化成无限重试会把启动拖成几分钟。
        verify(factory, times(2)).create(eq("dead"), any());
        manager.close();
    }

    @Test
    void requestConfigurationFiltersProcessPool() {
        Mcp first = model(1L, "first");
        Mcp second = model(2L, "second");
        client(first, "first_tool");
        client(second, "second_tool");
        manager.register(1L);
        manager.register(2L);

        try (McpToolScope scope = manager.openScope(config(second))) {
            assertNull(scope.getTool("mcp_first_first_tool"));
            assertNotNull(scope.getTool("mcp_second_second_tool"));
        }
        assertTrue(manager.openScope(config()).isEmpty());
        manager.close();
    }

    @Test
    void slowRegistrationOfOneServerDoesNotBlockAnother() throws Exception {
        Mcp slow = model(1L, "slow");
        Mcp fast = model(2L, "fast");
        McpClient slowClient = client(slow, "slow_tool");
        client(fast, "fast_tool");
        CountDownLatch slowEntered = new CountDownLatch(1);
        CountDownLatch releaseSlow = new CountDownLatch(1);
        when(factory.create(eq("slow"), any())).thenAnswer(invocation -> {
            slowEntered.countDown();
            assertTrue(releaseSlow.await(10, TimeUnit.SECONDS));
            return slowClient;
        });

        try (ExecutorService executor = Executors.newFixedThreadPool(2)) {
            Future<?> slowRegistration = executor.submit(() -> manager.register(1L));
            assertTrue(slowEntered.await(2, TimeUnit.SECONDS));
            Future<?> fastRegistration = executor.submit(() -> manager.register(2L));
            try {
                // 一个 server 卡在连接上时，另一个必须能自己连完，不能被同一把锁挡在后面。
                fastRegistration.get(2, TimeUnit.SECONDS);
            } finally {
                releaseSlow.countDown();
            }
            slowRegistration.get(5, TimeUnit.SECONDS);
        }
        try (McpToolScope scope = manager.openScope(config(slow, fast))) {
            assertTrue(scope.serverNames().containsAll(List.of("slow", "fast")));
        }
        manager.close();
    }

    @Test
    void slowRegistrationDoesNotBlockRequestScope() throws Exception {
        Mcp ready = model(1L, "ready");
        client(ready, "ready_tool");
        manager.register(1L);
        Mcp slow = model(2L, "slow");
        McpClient slowClient = client(slow, "slow_tool");
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        when(factory.create("slow", assembler.toServer(slow))).thenAnswer(invocation -> {
            entered.countDown();
            assertTrue(release.await(5, TimeUnit.SECONDS));
            return slowClient;
        });

        try (ExecutorService executor = Executors.newFixedThreadPool(2)) {
            Future<?> registration = executor.submit(() -> manager.register(2L));
            try {
                assertTrue(entered.await(2, TimeUnit.SECONDS));
                Future<McpToolScope> request = executor.submit(() -> manager.openScope(config(ready, slow)));
                try (McpToolScope scope = request.get(1, TimeUnit.SECONDS)) {
                    assertNotNull(scope.getTool("mcp_ready_ready_tool"));
                    assertNull(scope.getTool("mcp_slow_slow_tool"));
                }
            } finally {
                release.countDown();
            }
            registration.get(2, TimeUnit.SECONDS);
        }
        try (McpToolScope scope = manager.openScope(config(ready, slow))) {
            assertNotNull(scope.getTool("mcp_slow_slow_tool"));
        }
        manager.close();
    }
}
