package com.summit.dp.tools.baseTools.file.edit;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceBridge;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.dp.tools.baseTools.file.record.DefaultFileRecordManager;
import com.summit.dp.tools.baseTools.file.record.DefaultFileRecordStore;
import com.summit.dp.tools.baseTools.file.record.DefaultFileHasher;
import com.summit.dp.tools.baseTools.file.record.Differ;
import com.summit.dp.tools.baseTools.file.record.FileRecordManager;
import com.summit.dp.tools.baseTools.file.record.FileRecordRestorer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.Charset;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * edit_file 的编辑摘要必须随返回值 toolMetaData 广播（key = fileEdit），替代旧 FileEditEvent：
 * filePath/recordId/plusLines/minusLines 进 ToolCallEndEvent.metaData，全文不入事件。
 */
class EditFileToolExecutorMetaDataTest {

    @TempDir
    Path tempDir;

    @Test
    void appliedEditCarriesFileEditSummary() throws Exception {
        Path target = tempDir.resolve("demo.txt");
        java.nio.file.Files.writeString(target, "alpha\nbeta\n");

        EditFileToolExecutor executor = new EditFileToolExecutor(
                new ObjectMapper(), differ(), fileRecordManager());
        ToolExecuteResult result = executor.execute(execution(executor, tempDir, """
                {"type":"REPLACE","path":"demo.txt","oldText":"beta","newText":"BETA"}"""));

        assertTrue(result.isSuccess(), result.getToolOutput());
        Map<String, Object> fileEdit = (Map<String, Object>) result.getToolMetaData().get("fileEdit");
        assertNotNull(fileEdit);
        assertEquals("demo.txt", fileEdit.get("filePath"));
        assertNotNull(fileEdit.get("plusLines"));
        assertNotNull(fileEdit.get("minusLines"));
        assertTrue((Integer) fileEdit.get("plusLines") > 0);
        assertTrue((Integer) fileEdit.get("minusLines") > 0);
        assertNotNull(fileEdit.get("recordId"));
        // 全文不入事件：元数据里不允许出现内容字段
        assertFalse(fileEdit.containsKey("oldContent"));
        assertFalse(fileEdit.containsKey("newContent"));
    }

    private Differ differ() {
        return new EditDiffer();
    }

    private FileRecordManager fileRecordManager() {
        return new DefaultFileRecordManager(new DefaultFileRecordStore(),
                new FileRecordRestorer(new DefaultFileHasher()), new DefaultFileHasher());
    }

    private ToolExecution execution(EditFileToolExecutor executor, Path workspaceRoot, String args) {
        ToolDefinition<?> definition = ToolDefinition.builder().id("edit_file").name("edit_file")
                .maxOutput(200).timeout(5L).executor(executor).build();
        Workspace workspace = new Workspace() {
            @Override
            public String id() {
                return "w";
            }

            @Override
            public RuntimeEnvironment runtimeEnvironment() {
                return RuntimeEnvironment.builder()
                        .shellType(ShellType.BASH)
                        .charset(java.nio.charset.StandardCharsets.UTF_8)
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
                return new LocalBridge();
            }
        };
        return ToolExecution.builder()
                .id("call-1")
                .toolDefinition(definition)
                .executionId("1")
                .turnId("1")
                .workspace(workspace)
                .args(args)
                .build();
    }

    /** 直通本地文件系统（@TempDir）的最小桥：入参路径已经过 Workspace.resolve，直接使用。 */
    private static final class LocalBridge implements WorkspaceBridge {
        @Override
        public boolean exists(Path path) {
            return java.nio.file.Files.exists(path);
        }

        @Override
        public void createDirectories(Path path) throws IOException {
            java.nio.file.Files.createDirectories(path);
        }

        @Override
        public void createFile(Path path) throws IOException {
            java.nio.file.Files.createFile(path);
        }

        @Override
        public void deleteFile(Path path) throws IOException {
            java.nio.file.Files.deleteIfExists(path);
        }

        @Override
        public String readString(Path path, Charset charset) throws IOException {
            return java.nio.file.Files.readString(path, charset);
        }

        @Override
        public java.util.List<String> readLines(Path path, Charset charset) throws IOException {
            return java.nio.file.Files.readAllLines(path, charset);
        }

        @Override
        public void writeString(Path path, String content, Charset charset) throws IOException {
            java.nio.file.Files.writeString(path, content, charset);
        }

        @Override
        public CommandResult execute(java.util.List<String> command, String workDir, Charset charset,
                                     long timeoutSeconds, long maxOutputChars) {
            throw new UnsupportedOperationException("not needed in this test");
        }
    }
}
