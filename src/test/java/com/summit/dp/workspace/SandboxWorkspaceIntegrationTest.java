package com.summit.dp.workspace;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolDefinition;
import com.summit.dp.shared.model.WorkspaceType;
import com.summit.dp.shared.vo.WorkspaceVO;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.workflow.infrastructure.config.ConfiguredSandboxWorkspaceProvider;
import com.summit.dp.workflow.infrastructure.config.SandboxProperties;
import com.summit.dp.workflow.infrastructure.tools.terminal.CommandToolDefinitionExecutor;
import com.summit.dp.workflow.infrastructure.tools.arguments.ExecuteCommandRequest;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.policy.SandboxPolicyFactory;
import org.junit.jupiter.api.Test;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;
import static org.mockito.Mockito.mock;

class SandboxWorkspaceIntegrationTest {
    @Test void realBusinessConverterProviderTerminalAndAccessModesUseTheSameSandbox() throws Exception {
        String node = System.getProperty("mxc.node");
        String sdk = System.getProperty("mxc.sdk");
        String base = System.getProperty("mxc.business.root");
        assumeTrue(node != null && sdk != null && base != null, "需要显式 MXC 运行资源");
        Path directory = Path.of(base, UUID.randomUUID().toString());
        Path project = Files.createDirectories(directory.resolve("project"));
        Path outside = Files.createDirectories(directory.resolve("outside"));
        Path secret = Files.writeString(directory.resolve("secret"), "protected");
        Path input = Files.writeString(project.resolve("input"), "original");
        SandboxProperties properties = new SandboxProperties(directory.resolve("runtime"),
                node, sdk, Duration.ofSeconds(30), Duration.ofSeconds(30), List.of(), List.of(outside.toString()), Map.of());
        ConfiguredSandboxWorkspaceProvider provider = new ConfiguredSandboxWorkspaceProvider(properties);
        WorkspaceConverter converter = new WorkspaceConverter(mock(SettingsProvider.class),
                new SandboxPolicyFactory(properties.readonlyPaths(), properties.readwritePaths(), properties.environment()));
        WorkspaceVO business = WorkspaceVO.builder().id(1L).name("project").hostDir(project.toString()).build();
        Workspace writable = provider.resolve(converter.toSpec(business, WorkspaceType.SAND_BOX, AgentAccessMode.IN_WORKSPACE));
        assertTrue(writable.runtimeEnvironment().isolated());
        writable.bridge().writeString(writable.resolve("from-file"), "业务文件工具", StandardCharsets.UTF_8);
        assertThrows(IOException.class, () -> writable.bridge().readString(secret, StandardCharsets.UTF_8));
        assertThrows(IOException.class, () -> writable.bridge().writeString(outside.resolve("blocked"), "bad", StandardCharsets.UTF_8));
        CommandToolDefinitionExecutor terminal = new CommandToolDefinitionExecutor(new ObjectMapper());
        ToolDefinition<?> definition = ToolDefinition.builder().id("sandbox-test").name("sandbox-test").executor(terminal).timeout(10L).maxOutput(4096).build();
        boolean windows = System.getProperty("os.name").toLowerCase().contains("windows");
        String command = windows ? "node --version && echo business-terminal-ok>from-terminal && type from-terminal"
                : "node --version && git --version && printf business-terminal-ok > from-terminal && cat from-terminal";
        assertTrue(terminal.process(ExecuteCommandRequest.builder().command(command).build(), writable, definition).isSuccess());
        assertEquals("business-terminal-ok", Files.readString(project.resolve("from-terminal")).strip());
        Workspace readonly = provider.resolve(converter.toSpec(business, WorkspaceType.SAND_BOX, AgentAccessMode.READ_ONLY_IN_WORKSPACE));
        assertThrows(IOException.class, () -> readonly.bridge().writeString(readonly.resolve("input"), "bad", StandardCharsets.UTF_8));
        assertFalse(terminal.process(ExecuteCommandRequest.builder().command(windows ? "echo bad > input" : "printf bad > input").build(), readonly, definition).isSuccess());
        assertEquals("original", Files.readString(input));
        Workspace extra = provider.resolve(converter.toSpec(business, WorkspaceType.SAND_BOX, AgentAccessMode.OUT_OF_WORKSPACE));
        extra.bridge().writeString(outside.resolve("allowed"), "explicit-grant", StandardCharsets.UTF_8);
        assertEquals("explicit-grant", Files.readString(outside.resolve("allowed")));
        assertTrue(provider.check().ready());
    }
}
