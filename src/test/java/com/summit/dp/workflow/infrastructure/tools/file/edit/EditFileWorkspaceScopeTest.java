package com.summit.dp.workflow.infrastructure.tools.file.edit;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import com.summit.dp.workflow.infrastructure.tools.file.FileEditRecorder;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.InMemoryFileRecordStore;
import com.summit.runtime.workspace.LocalWorkspace;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 写入边界由访问档位裁决：只有完全访问档能碰工作区外的路径。
 *
 * <p>裸执行器也要守——工具注册层剔除写工具只覆盖只读档，档位与路径是两件事。</p>
 */
class EditFileWorkspaceScopeTest {

    @TempDir
    Path container;

    private final ObjectMapper mapper = new ObjectMapper();
    private final DefaultFileRecordManager records = new DefaultFileRecordManager(new InMemoryFileRecordStore());
    private final EditFileToolExecutor editor = new EditFileToolExecutor(mapper, new FileEditRecorder(new EditDiffer(), records));

    @ParameterizedTest
    @EnumSource(AgentPermissionMode.class)
    void editsInsideWorkspaceAreAllowedInEveryMode(AgentPermissionMode mode) throws Exception {
        Path root = workspaceRoot();
        Files.writeString(root.resolve("demo.txt"), "alpha\n");

        ToolExecuteResult result = editor.execute(execution(mode,
                Map.of("type", "REPLACE", "path", "demo.txt", "oldText", "alpha", "newText", "beta")));

        assertTrue(result.isSuccess(), result.getToolOutput());
        assertEquals("beta\n", Files.readString(root.resolve("demo.txt")));
    }

    @ParameterizedTest
    @EnumSource(value = AgentPermissionMode.class, names = {"READ_ONLY_REVIEW", "APPROVAL_REQUIRED", "DELEGATED_APPROVAL"})
    void outsidePathIsRejectedWithoutWritingAnything(AgentPermissionMode mode) throws Exception {
        workspaceRoot();
        Path outside = container.resolve("outside.txt");

        ToolExecuteResult result = editor.execute(execution(mode, Map.of("type", "INSERT_BEFORE",
                "path", outside.toString(), "anchor", "", "newText", "越界")));

        assertFalse(result.isSuccess(), result.getToolOutput());
        assertTrue(result.getToolOutput().contains("工作区"), result.getToolOutput());
        // 拒绝必须发生在落盘之前：留下半个文件比直接失败更难收拾。
        assertFalse(Files.exists(outside));
        assertTrue(records.listRecords("scope-test").isEmpty());
    }

    @Test
    void relativeTraversalCannotEscapeTheWorkspace() throws Exception {
        workspaceRoot();

        ToolExecuteResult result = editor.execute(execution(AgentPermissionMode.APPROVAL_REQUIRED, Map.of("type",
                "INSERT_BEFORE", "path", "../escaped.txt", "anchor", "", "newText", "越界")));

        assertFalse(result.isSuccess(), result.getToolOutput());
        assertFalse(Files.exists(container.resolve("escaped.txt")));
    }

    @Test
    void fullAccessModeWritesOutsideTheWorkspace() throws Exception {
        workspaceRoot();
        Path outside = container.resolve("outside.txt");
        // edit_file 只改已有文件：越界写的能力用「已存在的文件」来验。
        Files.writeString(outside, "原本");

        ToolExecuteResult result = editor.execute(execution(AgentPermissionMode.FULL_ACCESS,
                Map.of("type", "INSERT_BEFORE", "path", outside.toString(), "anchor", "原本", "newText", "越界")));

        assertTrue(result.isSuccess(), result.getToolOutput());
        assertEquals("越界原本", Files.readString(outside));
    }

    private Path workspaceRoot() throws Exception {
        Path root = container.resolve("ws");
        Files.createDirectories(root);
        return root;
    }

    private ToolExecution execution(AgentPermissionMode mode, Map<String, Object> args) throws Exception {
        return ToolExecution.builder()
                .workspace(new LocalWorkspace("scope-test", workspaceRoot().toString()))
                .executionId("scope-test")
                .turnId("turn")
                .attributes(AgentPermissionMode.toAttributes(mode))
                .args(mapper.writeValueAsString(args))
                .build();
    }
}
