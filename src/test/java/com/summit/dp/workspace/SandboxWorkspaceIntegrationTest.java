package com.summit.dp.workspace;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.sandbox_security.domain.model.SecurityAction;
import com.summit.dp.sandbox_security.domain.model.SecurityRule;
import java.util.List;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.sandbox.mxc.MxcWorkspaceSpec;
import com.summit.dp.shared.model.WorkspaceType;
import com.summit.dp.shared.vo.WorkspaceVO;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.workflow.infrastructure.config.ConfiguredSandboxWorkspaceProvider;
import com.summit.dp.workflow.infrastructure.config.SandboxProperties;
import com.summit.dp.workflow.infrastructure.tools.terminal.CommandToolDefinitionExecutor;
import com.summit.dp.workflow.infrastructure.tools.arguments.ExecuteCommandRequest;
import com.summit.dp.workflow.infrastructure.tools.arguments.ReadFileRequest;
import com.summit.dp.workflow.infrastructure.tools.file.read.ReadFileToolExecutor;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.policy.SandboxPolicyFactory;
import org.junit.jupiter.api.Test;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
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
        Path project = Files.createDirectories(directory.resolve("project workspace"));
        Path outside = Files.createDirectories(directory.resolve("outside"));
        Path secret = Files.writeString(outside.resolve("secret"), "outside-ascii-canary-47391", StandardCharsets.US_ASCII);
        Path input = Files.writeString(project.resolve("input"), "original");
        SandboxProperties properties = new SandboxProperties(directory.resolve("runtime"),
                node, sdk, Duration.ofSeconds(30), Duration.ofSeconds(30), Map.of());
        ConfiguredSandboxWorkspaceProvider provider = new ConfiguredSandboxWorkspaceProvider(properties);
        WorkspaceConverter converter = new WorkspaceConverter(mock(SettingsProvider.class),
                new SandboxPolicyFactory(properties.environment(),
                        () -> List.of(new SecurityRule(outside.toString(), "PATH", SecurityAction.DENY,
                                SecurityAction.DENY, SecurityAction.DENY, null, true, null)),
                        directory.resolve("config"), properties.applicationDirectory()));
        WorkspaceVO business = WorkspaceVO.builder().id(1L).name("project").hostDir(project.toString()).build();
        Workspace writable = provider.resolve(converter.toSpec(business, WorkspaceType.SAND_BOX, AgentAccessMode.IN_WORKSPACE));
        assertTrue(writable.runtimeEnvironment().isolated());
        writable.bridge().writeString(writable.resolve("from-file"), "业务文件工具", StandardCharsets.UTF_8);
        assertEquals("业务文件工具", writable.bridge().readString(writable.resolve("from-file"), StandardCharsets.UTF_8));
        writable.bridge().createDirectories(writable.resolve("nested"));
        writable.bridge().writeString(writable.resolve("nested/deleted"), "temporary", StandardCharsets.US_ASCII);
        writable.bridge().deleteFile(writable.resolve("nested/deleted"));
        assertTrue(Files.isDirectory(project.resolve("nested")));
        assertFalse(Files.exists(project.resolve("nested/deleted")));
        assertThrows(IOException.class, () -> writable.bridge().readString(secret, StandardCharsets.UTF_8));
        assertThrows(IOException.class, () -> writable.bridge().writeString(outside.resolve("blocked"), "bad", StandardCharsets.UTF_8));
        CommandToolDefinitionExecutor terminal = new CommandToolDefinitionExecutor(new ObjectMapper());
        ToolDefinition<?> definition = ToolDefinition.builder().id("sandbox-test").name("sandbox-test").executor(terminal).timeout(10L).maxOutput(4096).build();
        boolean windows = System.getProperty("os.name").toLowerCase().contains("windows");
        String command = windows ? "node --version && echo business-terminal-ok>from-terminal && type from-terminal"
                : "node --version && git --version && printf business-terminal-ok > from-terminal && cat from-terminal";
        assertTrue(terminal.process(ExecuteCommandRequest.builder().command(command).build(), writable, definition).isSuccess());
        assertEquals("business-terminal-ok", Files.readString(project.resolve("from-terminal")).strip());
        ToolExecuteResult projectRead = readUsingTool(writable, input);
        assertTrue(projectRead.isSuccess(), projectRead.getToolOutput());
        assertEquals("original", projectRead.getToolOutput());
        ToolExecuteResult deniedFile = readUsingTool(writable, secret);
        assertFalse(deniedFile.isSuccess(), deniedFile.getToolOutput());
        assertFalse(deniedFile.getToolOutput().contains("outside-ascii-canary-47391"));
        assertFalse(deniedFile.getToolOutput().contains("MalformedInputException"), "ASCII 越界读取不能用解码异常冒充拒绝访问");
        ToolExecuteResult deniedTerminal = executeUsingTool(writable, (windows ? "type \"" : "cat \"") + secret + "\"");
        assertFalse(deniedTerminal.isSuccess(), deniedTerminal.getToolOutput());
        assertTrue(deniedTerminal.getToolOutput().matches("(?s).*Exiting code :[1-9][0-9]*$"), deniedTerminal.getToolOutput());
        assertFalse(deniedTerminal.getToolOutput().contains("outside-ascii-canary-47391"));
        assertFalse(deniedTerminal.getToolOutput().contains("MalformedInputException"));
        Path blocked = outside.resolve("blocked-terminal");
        ToolExecuteResult deniedWrite = executeUsingTool(writable, "echo forbidden > \"" + blocked + "\"");
        assertFalse(deniedWrite.isSuccess(), deniedWrite.getToolOutput());
        assertTrue(deniedWrite.getToolOutput().matches("(?s).*Exiting code :[1-9][0-9]*$"), deniedWrite.getToolOutput());
        assertFalse(Files.exists(blocked));
        Workspace readonly = provider.resolve(converter.toSpec(business, WorkspaceType.SAND_BOX, AgentAccessMode.READ_ONLY_IN_WORKSPACE));
        assertThrows(IOException.class, () -> readonly.bridge().writeString(readonly.resolve("input"), "bad", StandardCharsets.UTF_8));
        assertThrows(IOException.class, () -> readonly.bridge().deleteFile(readonly.resolve("input")));
        assertThrows(IOException.class, () -> readonly.bridge().createDirectories(readonly.resolve("blocked-directory")));
        assertFalse(terminal.process(ExecuteCommandRequest.builder().command(windows ? "echo bad > input" : "printf bad > input").build(), readonly, definition).isSuccess());
        assertEquals("original", Files.readString(input));
        assertFalse(Files.exists(project.resolve("blocked-directory")));
        assertFalse(((MxcWorkspaceSpec) converter.toSpec(business, WorkspaceType.SAND_BOX, AgentAccessMode.OUT_OF_WORKSPACE)).securityPolicy().deniedPaths().isEmpty());
        Path neighbor = Files.createDirectories(directory.resolve("project workspace-neighbor"));
        WorkspaceVO other = WorkspaceVO.builder().id(2L).name("neighbor").hostDir(neighbor.toString()).build();
        Workspace otherWorkspace = provider.resolve(converter.toSpec(other, WorkspaceType.SAND_BOX, null));
        if (windows) {
            assertEquals("original", otherWorkspace.bridge().readString(input, StandardCharsets.US_ASCII));
            otherWorkspace.bridge().writeString(input, "cross-project", StandardCharsets.US_ASCII);
            assertEquals("cross-project", Files.readString(input));
        } else {
            assertThrows(IOException.class, () -> otherWorkspace.bridge().readString(input, StandardCharsets.US_ASCII));
        }
        otherWorkspace.bridge().writeString(otherWorkspace.resolve("own-file"), "own-project", StandardCharsets.US_ASCII);
        assertEquals("own-project", Files.readString(neighbor.resolve("own-file")));
        assertTrue(provider.check().ready());
    }

    @Test void explicitlyAllowedWindowsSystemAsciiFileCanBeReadWithoutAnEncodingFailure() throws Exception {
        assumeTrue(System.getProperty("os.name").toLowerCase().contains("windows"), "仅验证 Windows 显式系统只读授权");
        String node = System.getProperty("mxc.node");
        String sdk = System.getProperty("mxc.sdk");
        String base = System.getProperty("mxc.business.root");
        assumeTrue(node != null && sdk != null && base != null, "需要显式 MXC 运行资源");
        Path directory = Path.of(base, UUID.randomUUID().toString());
        Path project = Files.createDirectories(directory.resolve("project"));
        Path systemFile = Path.of(System.getenv("SystemRoot"), "System32/drivers/etc/networks");
        byte[] bytes = Files.readAllBytes(systemFile);
        assertTrue(bytes.length > 0);
        for (byte value : bytes) assertTrue(value >= 0, "系统读取正对照必须使用纯 ASCII 文件");
        String expected = new String(bytes, StandardCharsets.US_ASCII);
        SandboxProperties properties = new SandboxProperties(directory.resolve("runtime"), node, sdk,
                Duration.ofSeconds(30), Duration.ofSeconds(30), Map.of());
        ConfiguredSandboxWorkspaceProvider provider = new ConfiguredSandboxWorkspaceProvider(properties);
        Workspace workspace = provider.resolve(new SandboxPolicyFactory(properties.environment())
                .build(project.toString(), AgentAccessMode.READ_ONLY_IN_WORKSPACE));
        assertFalse(workspace.encloses(systemFile));
        ToolExecuteResult fileRead = readUsingTool(workspace, systemFile);
        assertTrue(fileRead.isSuccess(), fileRead.getToolOutput());
        assertEquals(expected, fileRead.getToolOutput());
        ToolExecuteResult terminalRead = executeUsingTool(workspace, "type \"" + systemFile + "\"");
        assertTrue(terminalRead.isSuccess(), terminalRead.getToolOutput());
        assertTrue(terminalRead.getToolOutput().contains(expected.strip()), terminalRead.getToolOutput());
    }

    private ToolExecuteResult readUsingTool(Workspace workspace, Path path) throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        return new ReadFileToolExecutor(mapper).execute(ToolExecution.builder().workspace(workspace)
                .args(mapper.writeValueAsString(ReadFileRequest.builder().path(path.toString()).build())).build());
    }

    private ToolExecuteResult executeUsingTool(Workspace workspace, String command) throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        CommandToolDefinitionExecutor terminal = new CommandToolDefinitionExecutor(mapper);
        ToolDefinition<?> definition = ToolDefinition.builder().id("sandbox-boundary-test").name("sandbox-boundary-test")
                .executor(terminal).timeout(10L).maxOutput(8192).build();
        return terminal.execute(ToolExecution.builder().workspace(workspace).toolDefinition(definition)
                .args(mapper.writeValueAsString(ExecuteCommandRequest.builder().command(command).build())).build());
    }
}
