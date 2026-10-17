package com.summit.dp.workspace;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.sandbox_security.domain.model.SecurityAction;
import com.summit.dp.sandbox_security.domain.model.SecurityRule;
import java.util.List;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.workflow.infrastructure.config.ConfiguredSandboxWorkspaceProvider;
import com.summit.dp.workflow.infrastructure.config.SandboxProperties;
import com.summit.dp.workflow.infrastructure.tools.arguments.ExecuteCommandRequest;
import com.summit.dp.workflow.infrastructure.tools.arguments.ReadFileRequest;
import com.summit.dp.workflow.infrastructure.tools.file.read.ReadFileToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.terminal.CommandToolDefinitionExecutor;
import com.summit.dp.workspace.application.policy.SandboxPolicyFactory;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/** 宿主通用 ACL 可以开放普通路径，但不能覆盖原生隐私拒绝。 */
class SandboxAmbientReadBoundaryTest {
    @TempDir Path temporary;

    @Test void privateAsciiFileRemainsUnreadableEvenWhenHostAclAllowsApplicationPackages() throws Exception {
        assumeTrue(System.getProperty("os.name").toLowerCase().contains("windows"), "仅验证 Windows 宿主 ACL");
        String application = System.getProperty("mxc.application.directory");
        assumeTrue(application != null, "需要应用根目录及随包 MXC 运行资源");
        Path project = Files.createDirectories(temporary.resolve("project"));
        Path outside = Files.createDirectories(temporary.resolve("outside"));
        Path sharedDirectory = Files.createDirectories(temporary.resolve("application-packages-public"));
        Path ordinary = Files.writeString(outside.resolve("ordinary.txt"), "ordinary-canary", StandardCharsets.US_ASCII);
        Path shared = Files.writeString(sharedDirectory.resolve("application-packages.txt"), "ambient-read-canary", StandardCharsets.US_ASCII);
        Path inside = Files.writeString(project.resolve("inside.txt"), "project-canary", StandardCharsets.US_ASCII);
        // 只修改本测试新建目录的 ACL，不修改任何真实用户目录或系统资源。
        Process acl = new ProcessBuilder(Path.of(System.getenv("SystemRoot"), "System32/icacls.exe").toString(),
                sharedDirectory.toString(), "/grant", "*S-1-15-2-1:(OI)(CI)(RX)").redirectErrorStream(true).start();
        byte[] diagnostics = acl.getInputStream().readAllBytes();
        assertEquals(0, acl.waitFor(), () -> new String(diagnostics, StandardCharsets.UTF_8));
        SandboxProperties properties = new SandboxProperties(Path.of(application), temporary.resolve("state"),
                Duration.ofSeconds(30), Duration.ofSeconds(30), Map.of());
        Workspace workspace = new ConfiguredSandboxWorkspaceProvider(properties).resolve(
                new SandboxPolicyFactory(properties.environment(),
                        () -> List.of(new SecurityRule(sharedDirectory.toString(), "PATH", SecurityAction.DENY,
                                SecurityAction.DENY, SecurityAction.DENY, null, true, null)),
                        temporary.resolve("config"), properties.runtimeDirectory(), properties.stateDirectory()).build(project.toString(), AgentAccessMode.IN_WORKSPACE));
        ObjectMapper mapper = new ObjectMapper();
        ReadFileToolExecutor reader = new ReadFileToolExecutor(mapper);
        ToolExecuteResult insideRead = read(reader, mapper, workspace, inside);
        assertTrue(insideRead.isSuccess(), insideRead.getToolOutput());
        assertEquals("project-canary", insideRead.getToolOutput());
        ToolExecuteResult ordinaryRead = read(reader, mapper, workspace, ordinary);
        assertTrue(ordinaryRead.isSuccess(), ordinaryRead.getToolOutput());
        assertFalse(ordinaryRead.getToolOutput().contains("MalformedInputException"));
        ToolExecuteResult sharedRead = read(reader, mapper, workspace, shared);
        CommandToolDefinitionExecutor terminal = new CommandToolDefinitionExecutor(mapper);
        ToolDefinition<?> definition = ToolDefinition.builder().id("ambient-read-audit").name("ambient-read-audit")
                .executor(terminal).timeout(10L).maxOutput(4096).build();
        ToolExecuteResult terminalRead = terminal.execute(ToolExecution.builder().workspace(workspace).toolDefinition(definition)
                .args(mapper.writeValueAsString(ExecuteCommandRequest.builder().command("type \"" + shared + "\"").build())).build());
        assertAll("宿主通用应用包 ACL 不应扩大沙箱读取范围",
                () -> assertFalse(sharedRead.isSuccess(), "文件工具越界读取成功: " + sharedRead.getToolOutput()),
                () -> assertFalse(terminalRead.isSuccess(), "终端越界读取成功: " + terminalRead.getToolOutput()));
    }

    private ToolExecuteResult read(ReadFileToolExecutor reader, ObjectMapper mapper, Workspace workspace, Path file) throws Exception {
        return reader.execute(ToolExecution.builder().workspace(workspace)
                .args(mapper.writeValueAsString(ReadFileRequest.builder().path(file.toString()).build())).build());
    }
}
