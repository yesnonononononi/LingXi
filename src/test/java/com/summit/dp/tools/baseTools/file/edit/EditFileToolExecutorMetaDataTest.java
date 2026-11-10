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

        FileRecord record = records.listRecords("1").getFirst();
        assertEquals(expectedPath, record.filePath());
        // 记录里只有基线与差异：基线是编辑前的原文，全文不再进记录。
        assertEquals("alpha\nbeta\n", record.baseline());
        assertNotNull(record.diff());
        assertFalse(record.diff().isBlank());
        assertEquals(fileEdit.get("recordId"), record.id());
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
        List<FileRecord> recorded = records.listRecords("1");
        assertEquals(2, recorded.size());
        assertEquals(first.toAbsolutePath().normalize().toString(), recorded.getFirst().filePath());
        assertEquals(second.toAbsolutePath().normalize().toString(), recorded.getLast().filePath());
        // 两个不同文件各自都是本轮首条，所以都带基线，版本都从 1 起。
        assertEquals(1, recorded.getFirst().version());
        assertEquals(1, recorded.getLast().version());
        assertEquals("before", recorded.getFirst().baseline());
        assertEquals("before", recorded.getLast().baseline());
        assertEquals("after", Files.readString(first));
        assertEquals("after", Files.readString(second));
    }

    /**
     * 记录的轮次必须取自事件元数据里的业务轮次，<b>不是</b> {@code ToolExecution.turnId}。
     *
     * <p>回归守卫：框架 {@code DefaultToolExecutionManager} 把 {@code turnId} 赋成
     * {@code command.executionId()}，两者数值恰好可能不同。这里刻意让执行标识与轮次不同，
     * 一旦有人改回 {@code toolExecution.getTurnId()}，这条断言立刻失败。</p>
     */
    @Test
    void recordTurnIdComesFromEventMetadataNotToolExecution() throws Exception {
        Path target = tempDir.resolve("turn.txt");
        Files.writeString(target, "one\n");
        FileRecordManager records = fileRecordManager();
        EditFileToolExecutor executor = new EditFileToolExecutor(new ObjectMapper(), differ(), records);
        ToolExecution toolExecution = execution(executor, tempDir, """
                {"type":"REPLACE","path":"turn.txt","oldText":"one","newText":"two"}""",
                Map.of("turnId", "9527"));

        assertTrue(executor.execute(toolExecution).isSuccess());

        FileRecord record = records.listRecords("1").getFirst();
        assertEquals("9527", record.turnId(), "轮次必须来自事件元数据的业务轮次");
        assertNotEquals(toolExecution.getTurnId(), record.turnId());
    }

    private Differ differ() {
        return new EditDiffer();
    }

    private FileRecordManager fileRecordManager() {
        return new DefaultFileRecordManager(new InMemoryFileRecordStore());
    }

    private ToolExecution execution(EditFileToolExecutor executor, Path workspaceRoot, String args) {
        // 真实链路里业务轮次来自事件元数据（RequestPreparer 写入），不是 ToolExecution.turnId。
        return execution(executor, workspaceRoot, args, Map.of("turnId", "1"));
    }

    private ToolExecution execution(EditFileToolExecutor executor, Path workspaceRoot, String args,
                                    Map<String, Object> eventMetaData) {
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
                .eventMetaData(eventMetaData)
                .build();
    }

}
