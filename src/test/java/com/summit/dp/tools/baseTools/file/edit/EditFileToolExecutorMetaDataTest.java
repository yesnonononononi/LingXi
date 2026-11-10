package com.summit.dp.tools.baseTools.file.edit;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.workspace.LocalWorkspaceBridge;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceBridge;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.workflow.infrastructure.tools.file.edit.EditDiffer;
import com.summit.dp.workflow.infrastructure.tools.file.edit.EditFileToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.file.record.*;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

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
        Files.writeString(target, "alpha\nbeta\n");

        ObjectMapper mapper = new ObjectMapper();
        FileRecordManager records = fileRecordManager();
        EditFileToolExecutor executor = new EditFileToolExecutor(
                mapper, differ(), records);
        ToolExecution toolExecution = execution(executor, tempDir, """
                {"type":"REPLACE","path":"demo.txt","oldText":"beta","newText":"BETA"}""");
        ToolExecuteResult result = executor.execute(toolExecution);

        assertTrue(result.isSuccess(), result.getToolOutput());
        Map<String, Object> fileEdit = (Map<String, Object>) result.getToolMetaData().get("fileEdit");
        assertNotNull(fileEdit);
        String expectedPath = target.toAbsolutePath().normalize().toString();
        assertEquals(expectedPath, fileEdit.get("filePath"));
        assertEquals(expectedPath, mapper.readTree(result.getToolOutput()).path("path").asText());
        assertNotNull(fileEdit.get("plusLines"));
        assertNotNull(fileEdit.get("minusLines"));
        assertTrue((Integer) fileEdit.get("plusLines") > 0);
        assertTrue((Integer) fileEdit.get("minusLines") > 0);
        assertNotNull(fileEdit.get("recordId"));
        // 行号区间随事件下发：前端靠它按行渲染 diff，无需再取全文。
        assertEquals(2, fileEdit.get("oldStartLine"));
        assertEquals(2, fileEdit.get("oldEndLine"));
        assertEquals(2, fileEdit.get("newStartLine"));
        assertEquals(2, fileEdit.get("newEndLine"));
        // 全文不入事件：元数据里不允许出现内容字段
        assertFalse(fileEdit.containsKey("oldContent"));
        assertFalse(fileEdit.containsKey("newContent"));

        FileRecord record = records.listPendingRecords("1").getFirst();
        assertEquals(expectedPath, record.filePath());
        assertTrue(records.reject("1", record.id(), toolExecution.getWorkspace()));
        assertEquals("alpha\nbeta\n", Files.readString(target));
    }

    @Test
    void siblingFilesKeepIndependentPathsAndVersions() throws Exception {
        Path directory = tempDir.resolve("nested");
        Files.createDirectories(directory);
        Path first = directory.resolve("first.txt");
        Path second = directory.resolve("second.txt");
        Files.writeString(first, "before");
        Files.writeString(second, "before");
        FileRecordManager records = fileRecordManager();
        EditFileToolExecutor executor = new EditFileToolExecutor(new ObjectMapper(), differ(), records);
        ToolExecution firstExecution = execution(executor, tempDir, """
                {"type":"REPLACE","path":"nested/./first.txt","oldText":"before","newText":"after"}""");
        ToolExecution secondExecution = execution(executor, tempDir, """
                {"type":"REPLACE","path":"nested/second.txt","oldText":"before","newText":"after"}""");

        ToolExecuteResult firstResult = executor.execute(firstExecution);
        ToolExecuteResult secondResult = executor.execute(secondExecution);
        assertTrue(firstResult.isSuccess(), firstResult.getToolOutput());
        assertTrue(secondResult.isSuccess(), secondResult.getToolOutput());
        List<FileRecord> pending = records.listPendingRecords("1");
        assertEquals(2, pending.size());
        assertEquals(first.toAbsolutePath().normalize().toString(), pending.getFirst().filePath());
        assertEquals(second.toAbsolutePath().normalize().toString(), pending.getLast().filePath());
        assertEquals(1, pending.getFirst().version());
        assertEquals(1, pending.getLast().version());
        assertTrue(records.reject("1", pending.getFirst().id(), firstExecution.getWorkspace()));
        assertTrue(records.reject("1", pending.getLast().id(), secondExecution.getWorkspace()));
        assertEquals("before", Files.readString(first));
        assertEquals("before", Files.readString(second));
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
                .build();
    }

}
