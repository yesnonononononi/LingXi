package com.summit.dp.workflow.infrastructure.tools.file.search;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.workspace.LocalWorkspaceBridge;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceBridge;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 跳过计数必须回传：含 NUL 与超 1MB 的文件被静默跳过时，「未找到」会同时代表
 * 「真的没有」和「压根没扫」，模型据此下的结论无法自证。
 */
class SearchFilesToolExecutorSkipCountTest {

    @TempDir
    Path workspaceRoot;

    @Test
    void reportsSkippedFilesAlongsideHits() throws Exception {
        Files.writeString(workspaceRoot.resolve("a.txt"), "hello canary\n");
        Files.write(workspaceRoot.resolve("b.bin"), new byte[]{'n', 'u', 'l', 0, 'A'});
        Files.write(workspaceRoot.resolve("big.txt"), new byte[1024 * 1024 + 1]);

        ToolExecuteResult result = search("canary");

        assertTrue(result.isSuccess(), result.getToolOutput());
        String output = result.getToolOutput();
        assertTrue(output.contains("a.txt:1: hello canary"), output);
        assertTrue(output.contains("另跳过 1 个含 NUL 的文件"), output);
        // 超限文件内容全是 0 字节，若判定顺序反了会被误报成含 NUL。
        assertTrue(output.contains("1 个超 1MB 的文件"), output);
        assertFalse(output.contains("2 个含 NUL 的文件"), output);
    }

    @Test
    void explainsSkippedFilesWhenNothingMatched() throws Exception {
        Files.writeString(workspaceRoot.resolve("a.txt"), "hello\n");
        Files.write(workspaceRoot.resolve("b.bin"), new byte[]{'n', 'u', 'l', 0, 'A'});

        ToolExecuteResult result = search("canary");

        assertTrue(result.isSuccess(), result.getToolOutput());
        String output = result.getToolOutput();
        assertTrue(output.contains("未找到匹配内容"), output);
        assertTrue(output.contains("另跳过 1 个含 NUL 的文件"), output);
    }

    @Test
    void omitsSkipNoteWhenEveryFileWasScanned() throws Exception {
        Files.writeString(workspaceRoot.resolve("a.txt"), "hello canary\n");

        ToolExecuteResult result = search("canary");

        assertTrue(result.isSuccess(), result.getToolOutput());
        assertFalse(result.getToolOutput().contains("另跳过"), result.getToolOutput());
    }

    @Test
    void prunesCommonBuildAndDependencyDirectories() throws Exception {
        Files.createDirectories(workspaceRoot.resolve("node_modules/pkg"));
        Files.writeString(workspaceRoot.resolve("node_modules/pkg/index.js"), "canary\n");
        Files.createDirectories(workspaceRoot.resolve("__pycache__"));
        Files.writeString(workspaceRoot.resolve("__pycache__/mod.pyc"), "canary\n");
        Files.createDirectories(workspaceRoot.resolve("bin"));
        Files.writeString(workspaceRoot.resolve("bin/app.dll"), "canary\n");
        Files.createDirectories(workspaceRoot.resolve("demo.egg-info"));
        Files.writeString(workspaceRoot.resolve("demo.egg-info/PKG-INFO"), "canary\n");
        // packages 是 monorepo 源码目录，误剪就是自伤。
        Files.createDirectories(workspaceRoot.resolve("packages/core"));
        Files.writeString(workspaceRoot.resolve("packages/core/index.ts"), "canary\n");

        ToolExecuteResult result = search("canary");

        assertTrue(result.isSuccess(), result.getToolOutput());
        String output = result.getToolOutput();
        assertTrue(output.contains("packages/core/index.ts:1: canary"), output);
        assertFalse(output.contains("node_modules"), output);
        assertFalse(output.contains("__pycache__"), output);
        assertFalse(output.contains("bin/app.dll"), output);
        assertFalse(output.contains("demo.egg-info"), output);
    }

    private ToolExecuteResult search(String pattern) throws Exception {
        SearchFilesToolExecutor executor = new SearchFilesToolExecutor(new ObjectMapper());
        return executor.execute(execution(executor, "{\"pattern\":\"" + pattern + "\"}"));
    }

    private ToolExecution execution(SearchFilesToolExecutor executor, String args) {
        ToolDefinition<?> definition = ToolDefinition.builder()
                .id("search_files").name("search_files")
                .maxOutput(4000).timeout(60L).executor(executor).build();
        Workspace workspace = new Workspace() {
            @Override
            public String id() {
                return "w";
            }

            @Override
            public RuntimeEnvironment runtimeEnvironment() {
                return RuntimeEnvironment.builder()
                        .shellType(ShellType.BASH)
                        .charset(StandardCharsets.UTF_8)
                        .build();
            }

            @Override
            public String workDir() {
                return workspaceRoot.toString();
            }

            @Override
            public Path resolve(String path) {
                return workspaceRoot.resolve(path);
            }

            @Override
            public WorkspaceBridge bridge() {
                return new LocalWorkspaceBridge(ShellType.BASH);
            }
        };
        return ToolExecution.builder()
                .id("call-1")
                .toolDefinition(definition)
                .executionId("1")
                .turnId("1")
                .workspace(workspace)
                .args(args)
                .eventMetaData(Map.of())
                .build();
    }
}
