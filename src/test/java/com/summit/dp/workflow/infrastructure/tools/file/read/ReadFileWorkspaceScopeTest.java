package com.summit.dp.workflow.infrastructure.tools.file.read;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.runtime.workspace.LocalWorkspace;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 读取边界由访问档位裁决：只有完全访问档能读工作区外的路径。
 *
 * <p>读与写必须同一口径——越界读本身就是信息泄露，它不需要落盘就已经把内容带进了上下文。</p>
 */
class ReadFileWorkspaceScopeTest {

    @TempDir
    Path container;

    private final ObjectMapper mapper = new ObjectMapper();
    private final ReadFileToolExecutor reader = new ReadFileToolExecutor(mapper);

    @ParameterizedTest
    @EnumSource(AgentAccessMode.class)
    void readsInsideWorkspaceAreAllowedInEveryMode(AgentAccessMode mode) throws Exception {
        Path root = workspaceRoot();
        Files.writeString(root.resolve("demo.txt"), "alpha\nbeta\n");

        ToolExecuteResult result = reader.execute(execution(mode, Map.of("path", "demo.txt")));

        assertTrue(result.isSuccess(), result.getToolOutput());
        assertEquals("1: alpha\n2: beta", result.getToolOutput());
    }

    @ParameterizedTest
    @EnumSource(value = AgentAccessMode.class, names = {"READ_ONLY_IN_WORKSPACE", "IN_WORKSPACE"})
    void absolutePathOutsideWorkspaceIsRejected(AgentAccessMode mode) throws Exception {
        workspaceRoot();
        Path outside = container.resolve("outside.txt");
        Files.writeString(outside, "机密\n");

        ToolExecuteResult result = reader.execute(execution(mode, Map.of("path", outside.toString())));

        assertFalse(result.isSuccess(), result.getToolOutput());
        assertTrue(result.getToolOutput().contains("工作区"), result.getToolOutput());
        assertFalse(result.getToolOutput().contains("机密"), "拒绝时不得把越界内容带出来");
    }

    @Test
    void relativeTraversalCannotEscapeTheWorkspace() throws Exception {
        workspaceRoot();
        Files.writeString(container.resolve("escaped.txt"), "机密\n");

        ToolExecuteResult result = reader.execute(execution(AgentAccessMode.IN_WORKSPACE,
                Map.of("path", "../escaped.txt")));

        assertFalse(result.isSuccess(), result.getToolOutput());
        assertTrue(result.getToolOutput().contains("工作区"), result.getToolOutput());
        assertFalse(result.getToolOutput().contains("机密"), "拒绝时不得把越界内容带出来");
    }

    @Test
    void fullAccessModeReadsOutsideTheWorkspace() throws Exception {
        workspaceRoot();
        Path outside = container.resolve("outside.txt");
        Files.writeString(outside, "跨项目内容\n");

        ToolExecuteResult result = reader.execute(execution(AgentAccessMode.OUT_OF_WORKSPACE,
                Map.of("path", outside.toString())));

        assertTrue(result.isSuccess(), result.getToolOutput());
        assertEquals("1: 跨项目内容", result.getToolOutput());
    }

    @Test
    void directoryLinkCannotBeUsedToEscapeTheWorkspace() throws Exception {
        Path root = workspaceRoot();
        Path outsideDir = container.resolve("outside-dir");
        Files.createDirectories(outsideDir);
        Files.writeString(outsideDir.resolve("secret.txt"), "机密\n");
        Path link = root.resolve("linkdir");
        Assumptions.assumeTrue(createDirectoryLink(link, outsideDir), "当前环境无法创建目录链接");

        ToolExecuteResult result = reader.execute(execution(AgentAccessMode.IN_WORKSPACE,
                Map.of("path", "linkdir/secret.txt")));

        assertFalse(result.isSuccess(), result.getToolOutput());
        assertFalse(result.getToolOutput().contains("机密"), "链接逃逸同样不得把内容带出来");
    }

    /** 符号链接跨平台，Windows 未提权时退到目录 junction：两者都能骗过几何包含。 */
    private boolean createDirectoryLink(Path link, Path target) {
        try {
            Files.createSymbolicLink(link, target);
            return true;
        } catch (IOException | UnsupportedOperationException notPermitted) {
            return createJunction(link, target);
        }
    }

    private boolean createJunction(Path link, Path target) {
        try {
            Process process = new ProcessBuilder("cmd", "/c", "mklink", "/J",
                    link.toString(), target.toString()).redirectErrorStream(true).start();
            return process.waitFor() == 0 && Files.exists(link);
        } catch (IOException e) {
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private Path workspaceRoot() throws Exception {
        Path root = container.resolve("ws");
        Files.createDirectories(root);
        return root;
    }

    private ToolExecution execution(AgentAccessMode mode, Map<String, Object> args) throws Exception {
        return ToolExecution.builder()
                .workspace(new LocalWorkspace("read-scope-test", workspaceRoot().toString()))
                .executionId("read-scope-test")
                .turnId("turn")
                .attributes(AgentAccessMode.toAttributes(mode))
                .args(mapper.writeValueAsString(args))
                .build();
    }
}
