package com.summit.dp.mcp;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.joran.JoranConfigurator;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.LoggingEvent;
import ch.qos.logback.classic.util.LogbackMDCAdapter;
import ch.qos.logback.core.OutputStreamAppender;
import ch.qos.logback.core.read.ListAppender;
import com.summit.dp.shared.logging.ExceptionMessageAppender;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.slf4j.MarkerFactory;
import org.slf4j.event.KeyValuePair;
import org.springframework.boot.logging.LoggingInitializationContext;
import org.springframework.mock.env.MockEnvironment;

import java.io.ByteArrayOutputStream;
import java.lang.reflect.Constructor;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

class McpLoggingTest {

    @TempDir
    Path logDirectory;

    private LoggerContext context;
    private final ByteArrayOutputStream consoleOutput = new ByteArrayOutputStream();

    @AfterEach
    void stopLogging() {
        if (context != null) context.stop();
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "dev.langchain4j.mcp.client.DefaultMcpClient",
            "dev.langchain4j.mcp.client.transport.http.StreamableHttpMcpTransport",
            "com.summit.adapter.langchain4j.mcp.Langchain4jMcpSession",
            "com.summit.dp.mcp.infrastructure.McpManager"
    })
    void consoleAndFileRenderOnlyMcpExceptionMessage(String loggerName) throws Exception {
        IllegalStateException failure = new IllegalStateException("connection unavailable",
                new IllegalArgumentException("nested cause detail"));
        failure.addSuppressed(new IllegalStateException("suppressed detail"));
        context.getLogger(loggerName).warn("MCP health check failed", failure);

        for (String output : readOutputs()) {
            assertTrue(output.endsWith("MCP health check failed, error=connection unavailable" + System.lineSeparator()), output);
            assertEquals(1, output.lines().count(), output);
            assertFalse(output.contains("IllegalStateException"), output);
            assertFalse(output.contains("nested cause detail"), output);
            assertFalse(output.contains("suppressed detail"), output);
            assertFalse(output.contains("\tat "), output);
        }
    }

    @Test
    void otherFailuresKeepTheirFullStackInBothOutputs() throws Exception {
        context.getLogger("com.summit.dp.workflow.ChatService").error("Chat failed",
                new IllegalStateException("chat unavailable", new IllegalArgumentException("nested cause detail")));

        for (String output : readOutputs()) {
            assertTrue(output.contains("IllegalStateException: chat unavailable"), output);
            assertTrue(output.contains("Caused by: java.lang.IllegalArgumentException: nested cause detail"), output);
            assertTrue(output.contains("\tat "), output);
        }
    }

    @Test
    void mcpLogWithoutExceptionDoesNotAppendAnError() throws Exception {
        context.getLogger("dev.langchain4j.mcp.client.DefaultMcpClient").warn("Protocol detection timed out");

        for (String output : readOutputs()) {
            assertTrue(output.endsWith("Protocol detection timed out" + System.lineSeparator()), output);
            assertEquals(1, output.lines().count(), output);
        }
    }

    @Test
    void mcpInfoGoesOnlyToConsoleAndRoutingKeepsOriginalFailure() throws Exception {
        Logger logger = context.getLogger("dev.langchain4j.mcp.client.DefaultMcpClient");
        ListAppender<ILoggingEvent> originalEvents = new ListAppender<>();
        originalEvents.start();
        logger.addAppender(originalEvents);
        logger.info("MCP connected");
        assertTrue(consoleOutput.toString(StandardCharsets.UTF_8).contains("MCP connected"));
        assertEquals("", Files.readString(logDirectory.resolve("warn-error.log")));

        logger.warn("MCP health check failed", new IllegalStateException("connection unavailable"));
        assertNotNull(originalEvents.list.getLast().getThrowableProxy());
        assertEquals("MCP health check failed", originalEvents.list.getLast().getFormattedMessage());
        for (String output : readOutputs()) {
            assertEquals(1, output.lines().filter(line -> line.contains("MCP health check failed")).count(), output);
            assertFalse(output.contains("\tat "), output);
        }
    }

    @Test
    void messageAppenderWorksForAnyLoggerAndPreservesEventMetadata() {
        ExceptionMessageAppender appender = new ExceptionMessageAppender();
        ListAppender<ILoggingEvent> output = new ListAppender<>();
        appender.setContext(context);
        output.start();
        appender.addAppender(output);
        appender.start();
        try {
            LoggingEvent source = new LoggingEvent(getClass().getName(), context.getLogger("unrelated.component"),
                    Level.WARN, "Request {} failed", new IllegalStateException("unavailable"), new Object[]{"ping"});
            source.setThreadName("health-check");
            source.setInstant(Instant.parse("2026-10-27T00:00:00.123456789Z"));
            source.setSequenceNumber(7);
            source.setMDCPropertyMap(Map.of("connection", "first"));
            source.addMarker(MarkerFactory.getMarker("connection"));
            source.addKeyValuePair(new KeyValuePair("server", "first"));
            source.setCallerData(new StackTraceElement[]{new StackTraceElement("HealthCheck", "run", "HealthCheck.java", 12)});

            appender.doAppend(source);

            assertEquals(1, output.list.size());
            ILoggingEvent rendered = output.list.getFirst();
            assertNull(rendered.getThrowableProxy());
            assertEquals("Request ping failed, error=unavailable", rendered.getFormattedMessage());
            assertEquals(source.getLoggerName(), rendered.getLoggerName());
            assertEquals(source.getLevel(), rendered.getLevel());
            assertEquals(source.getInstant(), rendered.getInstant());
            assertEquals(source.getSequenceNumber(), rendered.getSequenceNumber());
            assertEquals(source.getThreadName(), rendered.getThreadName());
            assertEquals(source.getLoggerContextVO(), rendered.getLoggerContextVO());
            assertEquals(source.getMDCPropertyMap(), rendered.getMDCPropertyMap());
            assertEquals(source.getMarkerList(), rendered.getMarkerList());
            assertEquals(source.getKeyValuePairs(), rendered.getKeyValuePairs());
            assertArrayEquals(source.getCallerData(), rendered.getCallerData());
            assertNotNull(source.getThrowableProxy());
            assertEquals("Request ping failed", source.getFormattedMessage());
        } finally {
            appender.stop();
            output.stop();
        }
    }

    @BeforeEach
    void configureLogging() throws Exception {
        context = new LoggerContext();
        context.setMDCAdapter(new LogbackMDCAdapter());
        MockEnvironment environment = new MockEnvironment()
                .withProperty("lingxi.log.dir", logDirectory.toString());
        // 通过真实 logger 路由验证，避免只测编码器而漏掉重复传播或文件过滤。
        Class<?> configuratorType = Class.forName("org.springframework.boot.logging.logback.SpringBootJoranConfigurator");
        Constructor<?> constructor = configuratorType.getDeclaredConstructor(LoggingInitializationContext.class);
        constructor.setAccessible(true);
        JoranConfigurator configurator = (JoranConfigurator) constructor.newInstance(
                new LoggingInitializationContext(environment));
        configurator.setContext(context);
        configurator.doConfigure(getClass().getResource("/logback-spring.xml"));
        OutputStreamAppender<ILoggingEvent> console = (OutputStreamAppender<ILoggingEvent>)
                context.getLogger(Logger.ROOT_LOGGER_NAME).getAppender("CONSOLE");
        assertNotNull(console);
        assertTrue(console.isStarted());
        console.setOutputStream(consoleOutput);
    }

    private List<String> readOutputs() throws Exception {
        return List.of(consoleOutput.toString(StandardCharsets.UTF_8),
                Files.readString(logDirectory.resolve("warn-error.log")));
    }
}
