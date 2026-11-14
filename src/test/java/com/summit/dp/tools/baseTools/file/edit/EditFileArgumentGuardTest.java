package com.summit.dp.tools.baseTools.file.edit;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.workflow.infrastructure.tools.file.FileEditRecorder;
import com.summit.dp.workflow.infrastructure.tools.file.edit.EditDiffer;
import com.summit.dp.workflow.infrastructure.tools.file.edit.EditFileToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.InMemoryFileRecordStore;
import com.summit.runtime.workspace.LocalWorkspace;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.stream.Stream;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 参数闸门与建目录：这两处失效都不报错，只会让脏输入静默走到落盘。 */
class EditFileArgumentGuardTest {

    @TempDir
    Path root;

    private final ObjectMapper mapper = new ObjectMapper();
    private final EditFileToolExecutor editor = new EditFileToolExecutor(mapper,
            new FileEditRecorder(new EditDiffer(), new DefaultFileRecordManager(new InMemoryFileRecordStore())));

    @ParameterizedTest
    @MethodSource("rejectedArguments")
    void malformedArgumentsAreRejectedBeforeTouchingTheFile(String args, String hint) {
        ToolExecuteResult result = editor.execute(execution(args));

        assertFalse(result.isSuccess(), result.getToolOutput());
        assertTrue(result.getToolOutput().contains(hint), result.getToolOutput());
        assertFalse(Files.exists(root.resolve("demo.txt")));
    }

    @Test
    void deleteIsAllowedWithoutNewText() throws Exception {
        Path file = root.resolve("demo.txt");
        Files.writeString(file, "alpha\nbeta\n");

        ToolExecuteResult result = editor.execute(execution(
                "{\"type\":\"DELETE\",\"path\":\"demo.txt\",\"oldText\":\"alpha\"}"));

        assertTrue(result.isSuccess(), result.getToolOutput());
        assertFalse(Files.readString(file).contains("alpha"));
    }

    @Test
    void missingFileIsRejectedInsteadOfBeingCreated() throws Exception {
        // 新建归 write_file：edit_file 不能再把「路径打错」变成「悄悄建一个文件」。
        ToolExecuteResult result = editor.execute(execution(
                "{\"type\":\"INSERT_AFTER\",\"path\":\"nested/deep/demo.txt\",\"anchor\":\"\",\"newText\":\"新建\"}"));

        assertFalse(result.isSuccess(), result.getToolOutput());
        assertTrue(result.getToolOutput().contains("write_file"), result.getToolOutput());
        assertFalse(Files.exists(root.resolve("nested/deep/demo.txt")));
    }

    static Stream<Arguments> rejectedArguments() {
        return Stream.of(
                Arguments.of("null", "参数不能为空"),
                Arguments.of("{\"type\":\"REPLACE\"}", "路径不能为空"),
                Arguments.of("{\"path\":\"demo.txt\",\"type\":\" \"}", "文件编辑类型不能为空"),
                Arguments.of("{\"path\":\"demo.txt\",\"type\":\"REPLACE\",\"oldText\":\"a\"}", "必须提供 newText"));
    }

    private ToolExecution execution(String args) {
        return ToolExecution.builder()
                .workspace(new LocalWorkspace("argument-guard", root.toString()))
                .executionId("argument-guard")
                .turnId("turn")
                .args(args)
                .build();
    }
}
