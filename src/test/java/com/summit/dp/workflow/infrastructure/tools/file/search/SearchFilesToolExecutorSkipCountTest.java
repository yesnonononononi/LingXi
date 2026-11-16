package com.summit.dp.workflow.infrastructure.tools.file.search;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.workspace.LocalWorkspaceBridge;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceBridge;
import com.summit.core.runtime.workspace.WorkspaceCommands;
import com.summit.core.runtime.workspace.WorkspaceFiles;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 跳过计数必须回传：含 NUL、超 1MB 以及读取抛异常的文件被静默跳过时，「未找到」会同时代表
 * 「真的没有」和「压根没扫」，模型据此下的结论无法自证。
 */
class SearchFilesToolExecutorSkipCountTest {

    /** 读取会失败的文件名：造用例和装饰器共用，改名只改这一处。 */
    private static final String BOOM_FILE = "boom.txt";

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
    void keepsScanningWhenOneFileCannotBeRead() throws Exception {
        Files.writeString(workspaceRoot.resolve("a.txt"), "hello canary\n");
        Files.writeString(workspaceRoot.resolve(BOOM_FILE), "canary again\n");
        Files.writeString(workspaceRoot.resolve("c.txt"), "canary once more\n");

        ToolExecuteResult result = search(new FailingFileBridge(), "canary");

        assertTrue(result.isSuccess(), result.getToolOutput());
        String output = result.getToolOutput();
        // 一个坏文件不该报销整次检索：其余文件照常出命中。
        assertTrue(output.contains("a.txt:1: hello canary"), output);
        assertTrue(output.contains("c.txt:1: canary once more"), output);
        assertTrue(output.contains("另跳过 1 个读取异常的文件"), output);
        // 坏文件确实没被读：它的内容一字也没进结果。
        assertFalse(output.contains(BOOM_FILE), output);
    }

    @Test
    void reportsUnreadableFilesEvenWhenNothingMatched() throws Exception {
        Files.writeString(workspaceRoot.resolve("a.txt"), "hello\n");
        Files.writeString(workspaceRoot.resolve(BOOM_FILE), "canary again\n");

        ToolExecuteResult result = search(new FailingFileBridge(), "canary");

        assertTrue(result.isSuccess(), result.getToolOutput());
        String output = result.getToolOutput();
        // 异常文件是盲区，没命中时更要说：否则「未找到」会被当成扫遍了全范围。
        assertTrue(output.contains("未找到匹配内容"), output);
        assertTrue(output.contains("另跳过 1 个读取异常的文件"), output);
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
        return search(new LocalWorkspaceBridge(ShellType.BASH), pattern);
    }

    private ToolExecuteResult search(WorkspaceBridge bridge, String pattern) throws Exception {
        SearchFilesToolExecutor executor = new SearchFilesToolExecutor(new ObjectMapper());
        return executor.execute(execution(executor, bridge, "{\"pattern\":\"" + pattern + "\"}"));
    }

    private ToolExecution execution(SearchFilesToolExecutor executor, WorkspaceBridge bridge, String args) {
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
                return bridge;
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

    /** 只让 boom.txt 读取失败的桥：模拟被占用、坏链接这类单文件 IO 失败。 */
    private static final class FailingFileBridge implements WorkspaceBridge {
        private final LocalWorkspaceBridge delegate = new LocalWorkspaceBridge(ShellType.BASH);
        private final WorkspaceFiles files = new FailingFiles(delegate.files());

        @Override
        public WorkspaceFiles files() {
            return files;
        }

        @Override
        public WorkspaceCommands commands() {
            return delegate.commands();
        }
    }

    /** 只拦 readBytes 的装饰器：遍历照常走委托，坏文件之外的文件不受影响。 */
    private static final class FailingFiles implements WorkspaceFiles {
        private final WorkspaceFiles delegate;

        private FailingFiles(WorkspaceFiles delegate) {
            this.delegate = delegate;
        }

        @Override
        public boolean exists(Path path) {
            return delegate.exists(path);
        }

        @Override
        public boolean isDirectory(Path path) throws IOException {
            return delegate.isDirectory(path);
        }

        @Override
        public void createDirectories(Path path) throws IOException {
            delegate.createDirectories(path);
        }

        @Override
        public void deleteFile(Path path) throws IOException {
            delegate.deleteFile(path);
        }

        @Override
        public String readString(Path path, Charset charset) throws IOException {
            return delegate.readString(path, charset);
        }

        @Override
        public List<Entry> list(Path directory) throws IOException {
            // 遍历由委托兜住：拦截只针对单文件读取，不该让整次检索失去目录清单。
            return delegate.list(directory);
        }

        @Override
        public byte[] readBytes(Path path) throws IOException {
            if (BOOM_FILE.equals(path.getFileName().toString())) {
                throw new IOException("模拟读取失败");
            }
            return delegate.readBytes(path);
        }

        @Override
        public void writeString(Path path, String content, Charset charset) throws IOException {
            delegate.writeString(path, content, charset);
        }
    }
}
