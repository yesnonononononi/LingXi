package com.summit.dp.workflow.infrastructure.tools.file.write;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import com.summit.dp.workflow.infrastructure.tools.file.FileEditRecorder;
import com.summit.dp.workflow.infrastructure.tools.file.edit.EditDiffer;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.InMemoryFileRecordStore;
import com.summit.runtime.workspace.LocalWorkspace;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * write_file 的契约：四种写入方式都不需要锚点，存在性由写入语义本身决定。
 *
 * <p>这些判断一旦松掉就是数据事故：CREATE 顶掉别人的文件、OVERRIDE 静默新建、
 * 追加时偷偷补换行，都不会报错，只会把内容改错。</p>
 */
class WriteFileToolExecutorTest {

    private static final String EXECUTION_ID = "write-test";

    @TempDir
    Path container;

    private final ObjectMapper mapper = new ObjectMapper();
    private final DefaultFileRecordManager records = new DefaultFileRecordManager(new InMemoryFileRecordStore());
    private final WriteFileToolExecutor writer = new WriteFileToolExecutor(mapper,
            new FileEditRecorder(new EditDiffer(), records));

    @Test
    void createWritesTheFileAndItsMissingParentDirectories() throws Exception {
        Path root = workspaceRoot();

        ToolExecuteResult result = writer.execute(execution(AgentPermissionMode.APPROVAL_REQUIRED,
                Map.of("type", "CREATE", "path", "nested/deep/demo.txt", "content", "新建")));

        assertTrue(result.isSuccess(), result.getToolOutput());
        assertEquals("新建", Files.readString(root.resolve("nested/deep/demo.txt")));
        JsonNode summary = mapper.readTree(result.getToolOutput());
        // 摘要里的路径与 fileEdit 元数据同源：都是落盘后的绝对路径，前端按它定位。
        assertEquals(root.resolve("nested/deep/demo.txt").toAbsolutePath().normalize().toString(),
                summary.path("path").asText());
        assertTrue(summary.path("created").asBoolean(), "CREATE 必须如实报告这是新建");
    }

    @Test
    void createRefusesToOverwriteAnExistingFile() throws Exception {
        Path root = workspaceRoot();
        Files.writeString(root.resolve("demo.txt"), "原本");

        ToolExecuteResult result = writer.execute(execution(AgentPermissionMode.APPROVAL_REQUIRED,
                Map.of("type", "CREATE", "path", "demo.txt", "content", "覆盖")));

        assertFalse(result.isSuccess(), result.getToolOutput());
        assertTrue(result.getToolOutput().contains("OVERRIDE"), result.getToolOutput());
        assertTrue(result.getToolOutput().contains("edit_file"), result.getToolOutput());
        assertEquals("原本", Files.readString(root.resolve("demo.txt")), "拒绝必须在落盘之前");
        assertTrue(records.listRecords(EXECUTION_ID).isEmpty(), "失败的写入不得留下可回滚记录");
    }

    @Test
    void overrideReplacesTheWholeFile() throws Exception {
        Path root = workspaceRoot();
        Files.writeString(root.resolve("demo.txt"), "旧的全都要没\n");

        ToolExecuteResult result = writer.execute(execution(AgentPermissionMode.APPROVAL_REQUIRED,
                Map.of("type", "OVERRIDE", "path", "demo.txt", "content", "全新的")));

        assertTrue(result.isSuccess(), result.getToolOutput());
        assertEquals("全新的", Files.readString(root.resolve("demo.txt")));
        assertFalse(mapper.readTree(result.getToolOutput()).path("created").asBoolean(), "已存在的文件不算新建");
    }

    @Test
    void overrideRefusesToCreateAMissingFile() throws Exception {
        Path root = workspaceRoot();

        ToolExecuteResult result = writer.execute(execution(AgentPermissionMode.APPROVAL_REQUIRED,
                Map.of("type", "OVERRIDE", "path", "absent.txt", "content", "内容")));

        assertFalse(result.isSuccess(), result.getToolOutput());
        assertTrue(result.getToolOutput().contains("CREATE"), result.getToolOutput());
        assertFalse(Files.exists(root.resolve("absent.txt")));
    }

    @ParameterizedTest
    @ValueSource(strings = {"PREPEND", "APPEND"})
    void prependAndAppendConcatenateVerbatimWithoutAddingNewlines(String type) throws Exception {
        Path root = workspaceRoot();
        Files.writeString(root.resolve("demo.txt"), "原有");

        ToolExecuteResult result = writer.execute(execution(AgentPermissionMode.APPROVAL_REQUIRED,
                Map.of("type", type, "path", "demo.txt", "content", "追加")));

        assertTrue(result.isSuccess(), result.getToolOutput());
        String expected = "PREPEND".equals(type) ? "追加原有" : "原有追加";
        // 换行由调用方自己写进 content：工具替人补一个反而会把「追加一行」接到上一行尾巴上。
        assertEquals(expected, Files.readString(root.resolve("demo.txt")));
    }

    @ParameterizedTest
    @ValueSource(strings = {"PREPEND", "APPEND"})
    void emptyIncomingContentIsRejectedInsteadOfBeingANoOp(String type) throws Exception {
        Path root = workspaceRoot();
        Files.writeString(root.resolve("demo.txt"), "原有");

        ToolExecuteResult result = writer.execute(execution(AgentPermissionMode.APPROVAL_REQUIRED,
                Map.of("type", type, "path", "demo.txt", "content", "")));

        assertFalse(result.isSuccess(), result.getToolOutput());
        assertTrue(result.getToolOutput().contains("OVERRIDE"), result.getToolOutput());
        assertEquals("原有", Files.readString(root.resolve("demo.txt")));
    }

    @Test
    void truncatingThroughOverrideIsStillExplicitlyAllowed() throws Exception {
        Path root = workspaceRoot();
        Files.writeString(root.resolve("demo.txt"), "清掉");

        ToolExecuteResult result = writer.execute(execution(AgentPermissionMode.APPROVAL_REQUIRED,
                Map.of("type", "OVERRIDE", "path", "demo.txt", "content", "")));

        assertTrue(result.isSuccess(), result.getToolOutput());
        assertEquals("", Files.readString(root.resolve("demo.txt")));
    }

    @Test
    void missingContentIsRejectedSoThatNoFileIsSilentlyEmptied() throws Exception {
        Path root = workspaceRoot();
        Files.writeString(root.resolve("demo.txt"), "别动我");

        ToolExecuteResult result = writer.execute(execution(AgentPermissionMode.APPROVAL_REQUIRED,
                Map.of("type", "OVERRIDE", "path", "demo.txt")));

        assertFalse(result.isSuccess(), result.getToolOutput());
        assertTrue(result.getToolOutput().contains("content"), result.getToolOutput());
        assertEquals("别动我", Files.readString(root.resolve("demo.txt")));
    }

    @Test
    void unknownWriteTypeIsRejectedBeforeTouchingTheFile() throws Exception {
        Path root = workspaceRoot();

        ToolExecuteResult result = writer.execute(execution(AgentPermissionMode.APPROVAL_REQUIRED,
                Map.of("type", "UPSERT", "path", "demo.txt", "content", "内容")));

        assertFalse(result.isSuccess(), result.getToolOutput());
        assertTrue(result.getToolOutput().contains("UPSERT"), result.getToolOutput());
        assertFalse(Files.exists(root.resolve("demo.txt")));
    }

    @Test
    void metadataCarriesTheRecordPointerWithoutAnyContent() throws Exception {
        Path root = workspaceRoot();
        Files.writeString(root.resolve("demo.txt"), "alpha\nbeta\n");

        ToolExecuteResult result = writer.execute(execution(AgentPermissionMode.APPROVAL_REQUIRED,
                Map.of("type", "OVERRIDE", "path", "demo.txt", "content", "alpha\nBETA\n")));

        assertTrue(result.isSuccess(), result.getToolOutput());
        Map<?, ?> fileEdit = (Map<?, ?>) result.getToolMetaData().get("fileEdit");
        assertNotNull(fileEdit, "写入必须广播 fileEdit 元数据，前端靠它取差异");
        assertNotNull(fileEdit.get("recordId"), "没有 recordId，前端就取不到差异全文");
        assertEquals(1, fileEdit.get("plusLines"));
        assertEquals(1, fileEdit.get("minusLines"));
        assertEquals(root.resolve("demo.txt").toAbsolutePath().normalize().toString(), fileEdit.get("filePath"));
        // 正文绝不进元数据：SSE 单帧预算会被整份文件击穿。
        assertFalse(fileEdit.containsValue("alpha\nBETA\n"));
        assertEquals(1, records.listRecords(EXECUTION_ID).size());
    }

    @ParameterizedTest
    @EnumSource(value = AgentPermissionMode.class, names = {"READ_ONLY_REVIEW", "APPROVAL_REQUIRED", "DELEGATED_APPROVAL"})
    void outsidePathIsRejectedWithoutWritingAnything(AgentPermissionMode mode) throws Exception {
        workspaceRoot();
        Path outside = container.resolve("outside.txt");

        ToolExecuteResult result = writer.execute(execution(mode,
                Map.of("type", "CREATE", "path", outside.toString(), "content", "越界")));

        assertFalse(result.isSuccess(), result.getToolOutput());
        assertTrue(result.getToolOutput().contains("工作区"), result.getToolOutput());
        assertFalse(Files.exists(outside));
        assertTrue(records.listRecords(EXECUTION_ID).isEmpty());
    }

    @Test
    void relativeTraversalCannotEscapeTheWorkspace() throws Exception {
        workspaceRoot();

        ToolExecuteResult result = writer.execute(execution(AgentPermissionMode.APPROVAL_REQUIRED,
                Map.of("type", "CREATE", "path", "../escaped.txt", "content", "越界")));

        assertFalse(result.isSuccess(), result.getToolOutput());
        assertFalse(Files.exists(container.resolve("escaped.txt")));
    }

    @Test
    void fullAccessModeWritesOutsideTheWorkspace() throws Exception {
        workspaceRoot();
        Path outside = container.resolve("outside.txt");

        ToolExecuteResult result = writer.execute(execution(AgentPermissionMode.FULL_ACCESS,
                Map.of("type", "CREATE", "path", outside.toString(), "content", "越界写入")));

        assertTrue(result.isSuccess(), result.getToolOutput());
        assertEquals("越界写入", Files.readString(outside));
    }

    @Test
    void writtenBytesStayUtf8RegardlessOfTheProcessCharset() throws Exception {
        Path root = workspaceRoot();

        ToolExecuteResult result = writer.execute(execution(AgentPermissionMode.APPROVAL_REQUIRED,
                Map.of("type", "CREATE", "path", "utf8.txt", "content", "中文🙂")));

        assertTrue(result.isSuccess(), result.getToolOutput());
        assertArrayEquals("中文🙂".getBytes(StandardCharsets.UTF_8), Files.readAllBytes(root.resolve("utf8.txt")));
    }

    private Path workspaceRoot() throws Exception {
        Path root = container.resolve("ws");
        Files.createDirectories(root);
        return root;
    }

    private ToolExecution execution(AgentPermissionMode mode, Map<String, Object> args) throws Exception {
        return ToolExecution.builder()
                .workspace(new LocalWorkspace(EXECUTION_ID, workspaceRoot().toString()))
                .executionId(EXECUTION_ID)
                .turnId("turn")
                .attributes(AgentPermissionMode.toAttributes(mode))
                .args(mapper.writeValueAsString(args))
                .build();
    }
}
