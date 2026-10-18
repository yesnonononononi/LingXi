package com.summit.dp.tools.baseTools.terminal;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceBridge;
import com.summit.core.runtime.workspace.WorkspaceCommands;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.infrastructure.tools.config.CommonToolConfiguration;
import com.summit.dp.workflow.infrastructure.tools.config.properties.CommandToolProperties;
import com.summit.dp.workflow.infrastructure.tools.terminal.CommandToolDefinitionExecutor;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackendProcesser;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class CommandBackgroundTimeoutTest {
    private final ApplicationContextRunner context = new ApplicationContextRunner()
            .withUserConfiguration(BindingConfiguration.class);

    @Test
    void defaultsToThirtyMinutes() {
        context.run(application -> {
            assertNull(application.getStartupFailure());
            assertEquals(Duration.ofMinutes(30), application.getBean(CommandToolProperties.class).getBackgroundTimeout());
        });
    }

    @Test
    void configuredDurationReachesOnlyBackgroundSubmission() {
        context.withPropertyValues("lingxi.tools.command.background-timeout=45m").run(application -> {
            assertNull(application.getStartupFailure());
            CommandToolProperties properties = application.getBean(CommandToolProperties.class);
            assertEquals(Duration.ofMinutes(45), properties.getBackgroundTimeout());
            verifyTimeoutRouting(properties, 2700L);
        });
    }

    @Test
    void defaultDurationReachesBackgroundSubmission() throws Exception {
        verifyTimeoutRouting(new CommandToolProperties(), 1800L);
    }

    @ParameterizedTest
    @ValueSource(strings = {"0s", "-1s", "500ms"})
    void rejectsDurationsThatCannotProvideAPositiveSecondDeadline(String duration) {
        context.withPropertyValues("lingxi.tools.command.background-timeout=" + duration).run(application -> {
            assertNotNull(application.getStartupFailure());
            Throwable cause = application.getStartupFailure();
            while (cause.getCause() != null) cause = cause.getCause();
            assertInstanceOf(ClientException.class, cause);
            assertEquals("后台任务超时时长不能小于 1 秒", cause.getMessage());
        });
    }

    @Test
    void acceptsOneSecondAndRejectsNull() {
        CommandToolProperties properties = new CommandToolProperties();
        properties.setBackgroundTimeout(Duration.ofSeconds(1));
        assertEquals(Duration.ofSeconds(1), properties.getBackgroundTimeout());
        assertThrows(ClientException.class, () -> properties.setBackgroundTimeout(null));
    }

    private void verifyTimeoutRouting(CommandToolProperties properties, long expectedSeconds) throws Exception {
        BackendProcesser background = mock(BackendProcesser.class);
        Workspace workspace = mock(Workspace.class);
        WorkspaceBridge bridge = mock(WorkspaceBridge.class);
        WorkspaceCommands commands = mock(WorkspaceCommands.class);
        when(workspace.runtimeEnvironment()).thenReturn(RuntimeEnvironment.builder().charset(StandardCharsets.UTF_8).build());
        when(workspace.workDir()).thenReturn(".");
        when(workspace.bridge()).thenReturn(bridge);
        when(bridge.commands()).thenReturn(commands);
        when(background.submit("echo test", "验证时限", 10L, 20L, workspace, expectedSeconds, 5000L)).thenReturn(123L);
        when(commands.execute("echo test", ".", StandardCharsets.UTF_8, 240L, TimeUnit.SECONDS, 5000L))
                .thenReturn(new WorkspaceCommands.CommandResult(0, "test", false, false));
        CommonToolConfiguration configuration = new CommonToolConfiguration();
        ToolDefinition<CommandToolDefinitionExecutor> definition = configuration.executeCommandToolDefinition(
                new ObjectMapper(), null, background, properties);
        assertEquals(240L, definition.timeout());
        assertEquals(30L, configuration.manageCommandToolDefinition(new ObjectMapper(), null).timeout());

        ToolExecution call = ToolExecution.builder().id("call").executionId("execution").turnId("execution")
                .toolDefinition(definition).workspace(workspace)
                .attributes(Map.of(ExecutionAttributes.SESSION_ID, 10L))
                .eventMetaData(Map.of(ExecutionEventMetadata.TURN_ID, "20"))
                .args("{\"command\":\"echo test\",\"intention\":\"验证时限\",\"background\":true}").build();
        ToolExecuteResult result = definition.executor().execute(call);
        assertTrue(result.isSuccess(), result.getToolOutput());
        verify(background).submit("echo test", "验证时限", 10L, 20L, workspace, expectedSeconds, 5000L);
        verifyNoInteractions(commands);

        call.setArgs("{\"command\":\"echo test\",\"intention\":\"验证时限\",\"background\":false}");
        assertTrue(definition.executor().execute(call).isSuccess());
        verify(commands).execute("echo test", ".", StandardCharsets.UTF_8, 240L, TimeUnit.SECONDS, 5000L);
        verifyNoMoreInteractions(background);
    }

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties(CommandToolProperties.class)
    static class BindingConfiguration { }
}
