package com.summit.dp.mcp;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.LoggerContext;
import ch.qos.logback.classic.joran.JoranConfigurator;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.classic.spi.LoggingEvent;
import ch.qos.logback.core.OutputStreamAppender;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.logging.LoggingInitializationContext;
import org.springframework.mock.env.MockEnvironment;

import java.lang.reflect.Constructor;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

class McpLoggingTest {

    @TempDir
    Path logDirectory;

    private LoggerContext context;

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
        LoggingEvent event = new LoggingEvent(getClass().getName(), context.getLogger(loggerName),
                Level.WARN, "MCP health check failed", failure, null);

        for (String appenderName : new String[]{"CONSOLE", "WARN_ERROR_FILE"}) {
            String output = render(context, appenderName, event);
            assertTrue(output.contains("MCP health check failed"), output);
            assertTrue(output.endsWith("error=connection unavailable" + System.lineSeparator()), output);
            assertFalse(output.contains("IllegalStateException"), output);
            assertFalse(output.contains("nested cause detail"), output);
            assertFalse(output.contains("suppressed detail"), output);
            assertFalse(output.contains("\tat "), output);
        }
    }

    @Test
    void otherFailuresKeepTheirFullStackInBothOutputs() throws Exception {
        LoggingEvent event = new LoggingEvent(getClass().getName(),
                context.getLogger("com.summit.dp.workflow.ChatService"), Level.ERROR,
                "Chat failed", new IllegalStateException("chat unavailable",
                new IllegalArgumentException("nested cause detail")), null);

        for (String appenderName : new String[]{"CONSOLE", "WARN_ERROR_FILE"}) {
            String output = render(context, appenderName, event);
            assertTrue(output.contains("IllegalStateException: chat unavailable"), output);
            assertTrue(output.contains("Caused by: java.lang.IllegalArgumentException: nested cause detail"), output);
            assertTrue(output.contains("\tat "), output);
        }
    }

    @Test
    void mcpLogWithoutExceptionDoesNotAppendAnError() throws Exception {
        LoggingEvent event = new LoggingEvent(getClass().getName(),
                context.getLogger("dev.langchain4j.mcp.client.DefaultMcpClient"),
                Level.WARN, "Protocol detection timed out", null, null);

        for (String appenderName : new String[]{"CONSOLE", "WARN_ERROR_FILE"}) {
            String output = render(context, appenderName, event);
            assertTrue(output.endsWith("Protocol detection timed out" + System.lineSeparator()), output);
        }
    }

    @BeforeEach
    void configureLogging() throws Exception {
        context = new LoggerContext();
        MockEnvironment environment = new MockEnvironment()
                .withProperty("lingxi.log.dir", logDirectory.toString());
        // 使用真实 Spring 日志配置，确保控制台与文件都接入同一异常转换器。
        Class<?> configuratorType = Class.forName("org.springframework.boot.logging.logback.SpringBootJoranConfigurator");
        Constructor<?> constructor = configuratorType.getDeclaredConstructor(LoggingInitializationContext.class);
        constructor.setAccessible(true);
        JoranConfigurator configurator = (JoranConfigurator) constructor.newInstance(
                new LoggingInitializationContext(environment));
        configurator.setContext(context);
        configurator.doConfigure(getClass().getResource("/logback-spring.xml"));
    }

    private String render(LoggerContext context, String appenderName, ILoggingEvent event) {
        OutputStreamAppender<ILoggingEvent> appender = (OutputStreamAppender<ILoggingEvent>)
                context.getLogger(Logger.ROOT_LOGGER_NAME).getAppender(appenderName);
        assertNotNull(appender, appenderName);
        assertTrue(appender.isStarted(), appenderName);
        return new String(appender.getEncoder().encode(event), StandardCharsets.UTF_8);
    }
}
