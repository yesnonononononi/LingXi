package com.summit.dp.mcp;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.summit.core.conf.McpConfig;
import com.summit.core.mcp.McpSession;
import com.summit.core.mcp.McpSessionType;
import com.summit.core.mcp.McpToolScope;
import com.summit.core.tool.ToolDefinition;
import com.summit.dp.mcp.application.service.McpConfigAssembler;
import com.summit.dp.mcp.application.vo.McpConnectionStateVO;
import com.summit.dp.mcp.domain.model.Mcp;
import com.summit.dp.mcp.domain.repository.McpRepository;
import com.summit.dp.mcp.infrastructure.McpManager;
import com.summit.dp.shared.exception.ClientException;
import mcp.McpSessionFactory;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class McpManagerTest {

    @Test
    void startupReadsConfigurationOnlyAfterApplicationReady() {
        try (AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext()) {
            context.registerBean(McpRepository.class, () -> repository);
            context.registerBean(McpSessionFactory.class, () -> factory);
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
    private final McpSessionFactory factory = mock(McpSessionFactory.class);
    private final McpConfigAssembler assembler = new McpConfigAssembler();
    private final McpManager manager = new McpManager(repository, assembler, factory);

    private Mcp model(long id, String name) {
        return Mcp.builder().id(id).name(name).transport(Mcp.Transport.STREAMABLE_HTTP)
                .url("https://example.test/" + name).headers(Map.of()).description(name)
                .initializationTimeout(Duration.ofSeconds(1)).executionTimeout(Duration.ofSeconds(1))
                .maxOutput(1000).status(Mcp.STATUS_ENABLED).build();
    }

    /**
     * 编排「这个 id 已入库，连接池会拿到一个带 {@code mcp_<server>_<tool>} 工具会话」的现场。
     *
     * <p>工具的本地前缀由框架统一生成，期望名就在这里显式拼出来，别让测试依赖被测代码的拼接逻辑。</p>
     */
    private McpSession session(Mcp model, String... remoteTools) {
        McpSession session = McpSessionFactoryFixture.mockSession(model.getName(), remoteTools);
        when(repository.findById(model.getId())).thenReturn(Optional.of(model));
        when(factory.openSession(eq(assembler.toServer(model)), isNull(), eq(McpSessionType.REUSE), anyString()))
                .thenReturn(session);
        return session;
    }

    private McpConfig config(Mcp... models) {
        McpConfig config = new McpConfig();
        config.setMcp(List.of(models).stream().map(assembler::toServer).toList());
        return config;
    }

    @Test
    void registerPublishesToolsWithoutRequestTimeIoAndScopeDoesNotCloseSharedSession() {
        Mcp model = model(1L, "first");
        McpSession session = session(model, "inspect");
        manager.register(1L);
        manager.register(1L);

        try (McpToolScope scope = manager.openScope(config(model))) {
            assertNotNull(scope.getTool("mcp_first_inspect"));
            assertEquals(List.of("first"), scope.serverNames());
        }
        try (McpToolScope scope = manager.openScope(config(model))) {
            assertNotNull(scope.getTool("mcp_first_inspect"));
        }
        // 工具定义随连接发布：请求阶段不再访问远端，也不重复建立共享连接。
        verify(session, times(1)).tools();
        verify(factory, times(1)).openSession(eq(assembler.toServer(model)), isNull(),
                eq(McpSessionType.REUSE), anyString());
        verify(session, never()).close();
        manager.close();
        manager.close();
        verify(session, times(1)).close();
    }

    /** 共享会话报给「运维视角」的必须是服务端原名，不能是带前缀的模型可见名。 */
    @Test
    void pooledSessionReportsServerToolNamesWhilePublishingPrefixedTools() throws Exception {
        Mcp model = model(1L, "first");
        McpSession session = session(model, "inspect", "search");
        manager.register(1L);

        McpSession pooled = pooledSessionOf(1L);
        assertEquals(List.of("inspect", "search"), pooled.serverToolNames());
        assertEquals(List.of("mcp_first_inspect", "mcp_first_search"),
                pooled.tools().stream().map(ToolDefinition::name).toList());
        // 委托给真正的会话，而不是自己从前缀工具名反推。
        verify(session, times(1)).serverToolNames();
        manager.close();
    }

    /**
     * 连接池内部类型是私有 record，只能反射取出来验证；这是唯一能观测「池化会话报什么名字」的缝。
     */
    @SuppressWarnings("unchecked")
    private McpSession pooledSessionOf(Long id) throws Exception {
        java.lang.reflect.Field field = McpManager.class.getDeclaredField("sessions");
        field.setAccessible(true);
        return ((java.util.Map<Long, McpSession>) field.get(manager)).get(id);
    }

    @Test
    void removeClosesSessionAndNextScopeDoesNotContainItsTools() {
        Mcp model = model(1L, "first");
        McpSession session = session(model, "inspect");
        manager.register(1L);
        manager.remove(1L);
        manager.remove(1L);

        assertTrue(manager.openScope(config(model)).isEmpty());
        verify(session, times(1)).close();
    }

    @Test
    void updateReplacesRenamedConnectionAndRejectsOldRequestConfig() {
        Mcp original = model(1L, "first");
        McpSession oldSession = session(original, "old_tool");
        manager.register(1L);
        Mcp changed = model(1L, "renamed");
        McpSession newSession = session(changed, "new_tool");
        manager.register(1L);

        assertTrue(manager.openScope(config(original)).isEmpty());
        try (McpToolScope scope = manager.openScope(config(changed))) {
            assertNull(scope.getTool("mcp_first_old_tool"));
            assertNotNull(scope.getTool("mcp_renamed_new_tool"));
            assertEquals(List.of("renamed"), scope.serverNames());
        }
        verify(oldSession).close();
        verify(newSession, never()).close();
        manager.close();
    }

    @Test
    void disableRemovesExistingConnectionWithoutConnectingAgain() {
        Mcp model = model(1L, "first");
        McpSession session = session(model, "inspect");
        manager.register(1L);
        model.changeEnabled(false);
        manager.register(1L);

        assertTrue(manager.openScope(config(model)).isEmpty());
        verify(factory, times(1)).openSession(any(), any(), any(), anyString());
        verify(session).close();
    }

    @Test
    void discoveryFailureClosesCandidateAndRemovesStaleConnection() {
        Mcp original = model(1L, "first");
        McpSession oldSession = session(original, "old_tool");
        manager.register(1L);
        Mcp changed = model(1L, "changed");
        McpSession broken = session(changed, "new_tool");
        when(broken.tools()).thenThrow(new IllegalStateException("secret=do-not-expose"));

        ClientException failure = assertThrows(ClientException.class, () -> manager.register(1L));
        assertTrue(failure.getMessage().contains("配置已保存"));
        assertFalse(failure.getMessage().contains("do-not-expose"));
        assertTrue(manager.openScope(config(original, changed)).isEmpty());
        verify(oldSession).close();
        verify(broken).close();
    }

    /** 内部异常链保留原始原因，面向用户的文案不暴露内部细节。 */
    @Test
    void discoveryFailureKeepsOriginalCauseForDiagnosis() {
        Mcp model = model(1L, "first");
        McpSession broken = session(model, "inspect");
        when(broken.tools()).thenThrow(new IllegalStateException("secret=do-not-expose"));

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
    void connectionFailuresAreLoggedWithTheirThrowable() throws Exception {
        Logger logger = (Logger) LoggerFactory.getLogger(McpManager.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            Mcp broken = model(1L, "broken");
            when(repository.findById(1L)).thenReturn(Optional.of(broken));
            when(factory.openSession(eq(assembler.toServer(broken))))
                    .thenThrow(new IllegalStateException("connection unavailable"));
            when(factory.openSession(eq(assembler.toServer(broken)), isNull(), any(), anyString()))
                    .thenThrow(new IllegalStateException("connection unavailable"));

            assertThrows(ClientException.class, () -> manager.connect(assembler.toServer(broken)));
            assertThrows(ClientException.class, () -> manager.register(1L));
            when(repository.findEnabled()).thenReturn(List.of(broken));
            manager.connect();
            manager.disconnect();

            Mcp closing = model(2L, "closing");
            McpSession session = session(closing, "inspect");
            doThrow(new IllegalStateException("close unavailable")).when(session).close();
            manager.register(2L);
            manager.remove(2L);

            List<ILoggingEvent> warnings = appender.list.stream()
                    .filter(event -> event.getLevel() == Level.WARN).toList();
            // 首次 + 两次启动重试：测试连接 1、注册 3、初始化 1、关闭 1。
            assertEquals(7, warnings.size());
            for (ILoggingEvent event : warnings) {
                // 必须把 throwable 交给 logback：MCP 专用 appender 靠它渲染「<- 类名: 消息」，
                // 只拼 getMessage() 会让 SDK 的通用句吞掉 SSL/超时这些真因。
                assertNotNull(event.getThrowableProxy(), event.getFormattedMessage());
                assertFalse(event.getFormattedMessage().contains("connection unavailable"), event.getFormattedMessage());
            }
            assertEquals("测试 MCP 连接失败: name=broken", warnings.getFirst().getFormattedMessage());
            assertEquals("注册 MCP 连接失败: id=1, name=broken", warnings.get(1).getFormattedMessage());
            assertTrue(warnings.get(5).getFormattedMessage().startsWith("初始化 MCP 连接失败: id=1, name=broken"));
            assertEquals("关闭 MCP 连接失败: name=closing",
                    warnings.getLast().getFormattedMessage());
        } finally {
            logger.detachAppender(appender);
            appender.stop();
            manager.disconnect();
            manager.close();
        }
    }

    /** SSE 已无可用的客户端传输：必须在装配阶段就拒绝，且不建立任何连接。 */
    @Test
    void sseTransportIsRejectedDuringAssemblyWithoutOpeningSession() {
        Mcp sse = Mcp.builder().id(3L).name("legacy-sse").transport(Mcp.Transport.SSE)
                .url("https://legacy.test/sse").headers(Map.of()).status(Mcp.STATUS_ENABLED).build();
        when(repository.findById(3L)).thenReturn(Optional.of(sse));

        ClientException failure = assertThrows(ClientException.class, () -> manager.register(3L));

        assertEquals("SSE 传输不受支持，请改用 streamable-http", failure.getMessage());
        assertInstanceOf(IllegalArgumentException.class, failure.getCause());
        verifyNoInteractions(factory);
        manager.close();
    }

    @Test
    void startupHandlesEmptyConfigurationAndSkipsUnreachableServer() {
        when(repository.findEnabled()).thenReturn(List.of());
        assertDoesNotThrow(() -> { manager.connect(); });

        Mcp broken = model(1L, "broken");
        Mcp healthy = model(2L, "healthy");
        when(repository.findById(1L)).thenReturn(Optional.of(broken));
        when(factory.openSession(eq(assembler.toServer(broken)), isNull(), any(), anyString()))
                .thenThrow(new IllegalStateException("unreachable"));
        session(healthy, "inspect");
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
        McpSession session = mock(McpSession.class);
        when(repository.findById(1L)).thenReturn(Optional.of(model));
        when(session.name()).thenReturn("flaky");
        when(session.tools()).thenReturn(McpSessionFactoryFixture.prefixedTools("flaky", "inspect"));
        when(factory.openSession(eq(assembler.toServer(model)), isNull(), any(), anyString()))
                .thenThrow(new IllegalStateException("first attempt fails"))
                .thenReturn(session);
        when(repository.findEnabled()).thenReturn(List.of(model));

        manager.connect();
        manager.disconnect();

        try (McpToolScope scope = manager.openScope(config(model))) {
            assertNotNull(scope.getTool("mcp_flaky_inspect"));
        }
        verify(factory, times(2)).openSession(eq(assembler.toServer(model)), isNull(), any(), anyString());
        manager.close();
    }

    @Test
    void startupGivesUpAfterTwoRetries() {
        Mcp model = model(1L, "dead");
        when(repository.findById(1L)).thenReturn(Optional.of(model));
        when(factory.openSession(eq(assembler.toServer(model)), isNull(), any(), anyString()))
                .thenThrow(new IllegalStateException("always fails"));
        when(repository.findEnabled()).thenReturn(List.of(model));

        manager.connect();
        manager.disconnect();

        assertTrue(manager.openScope(config(model)).isEmpty());
        // 首次 + 两次重试：握手中断这类瞬态失败重试即成功，再多退化成把启动拖成几分钟。
        verify(factory, times(3)).openSession(eq(assembler.toServer(model)), isNull(), any(), anyString());
        manager.close();
    }

    @Test
    void requestConfigurationFiltersProcessPool() {
        Mcp first = model(1L, "first");
        Mcp second = model(2L, "second");
        session(first, "first_tool");
        session(second, "second_tool");
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
        McpSession slowSession = mock(McpSession.class);
        when(repository.findById(1L)).thenReturn(Optional.of(slow));
        when(slowSession.name()).thenReturn("slow");
        when(slowSession.tools()).thenReturn(McpSessionFactoryFixture.prefixedTools("slow", "slow_tool"));
        when(repository.findById(2L)).thenReturn(Optional.of(fast));
        session(fast, "fast_tool");
        CountDownLatch slowEntered = new CountDownLatch(1);
        CountDownLatch releaseSlow = new CountDownLatch(1);
        when(factory.openSession(eq(assembler.toServer(slow)), isNull(), any(), anyString())).thenAnswer(invocation -> {
            slowEntered.countDown();
            assertTrue(releaseSlow.await(10, TimeUnit.SECONDS));
            return slowSession;
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
        session(ready, "ready_tool");
        manager.register(1L);
        Mcp slow = model(2L, "slow");
        McpSession slowSession = mock(McpSession.class);
        when(repository.findById(2L)).thenReturn(Optional.of(slow));
        when(slowSession.name()).thenReturn("slow");
        when(slowSession.tools()).thenReturn(McpSessionFactoryFixture.prefixedTools("slow", "slow_tool"));
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        when(factory.openSession(eq(assembler.toServer(slow)), isNull(), any(), anyString())).thenAnswer(invocation -> {
            entered.countDown();
            assertTrue(release.await(5, TimeUnit.SECONDS));
            return slowSession;
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

    /** 配置未变时 register 会直接返回，重连必须真正关闭旧会话并重新握手。 */
    @Test
    void reconnectRebuildsSessionEvenWhenConfigurationIsUnchanged() {
        Mcp model = model(1L, "first");
        McpSession session = session(model, "inspect");
        manager.register(1L);

        manager.reconnect(1L);

        verify(session, times(1)).close();
        verify(factory, times(2)).openSession(eq(assembler.toServer(model)), isNull(),
                eq(McpSessionType.REUSE), anyString());
        McpConnectionStateVO state = manager.resolveState(1L);
        assertEquals(McpConnectionStateVO.CONNECTED, state.state());
        assertEquals(1, state.toolCount());
        manager.close();
    }

    /** 失败要留在状态里供设置页展示，但只报根因类型，不能带出根因消息里的凭据。 */
    @Test
    void failedRegistrationIsReportedUntilReconnectSucceeds() {
        Mcp model = model(1L, "first");
        McpSession broken = session(model, "inspect");
        when(broken.tools()).thenThrow(new IllegalStateException("secret=do-not-expose"))
                .thenReturn(McpSessionFactoryFixture.prefixedTools("first", "inspect"));
        assertEquals(McpConnectionStateVO.DISCONNECTED, manager.resolveState(1L).state());

        assertThrows(ClientException.class, () -> manager.register(1L));
        McpConnectionStateVO failed = manager.resolveState(1L);
        assertEquals(McpConnectionStateVO.FAILED, failed.state());
        assertEquals("IllegalStateException", failed.error());

        manager.reconnect(1L);
        assertEquals(McpConnectionStateVO.CONNECTED, manager.resolveState(1L).state());
        assertNull(manager.resolveState(1L).error());

        manager.remove(1L);
        assertEquals(McpConnectionStateVO.DISCONNECTED, manager.resolveState(1L).state());
    }
}