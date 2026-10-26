package com.summit.dp.workflow.infrastructure.tools.file.edit;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.workflow.infrastructure.tools.file.read.ReadFileToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileHasher;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordStore;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecord;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordRestorer;
import com.summit.runtime.workspace.LocalWorkspace;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;

import static org.junit.jupiter.api.Assertions.*;

/** 按字节核对落盘和回滚，避免只验证内存字符串却漏掉换行损坏。 */
class EditFileLineEndingRegressionTest {
    @TempDir Path root;
    private final ObjectMapper mapper = new ObjectMapper();
    private final DefaultFileHasher hasher = new DefaultFileHasher();
    private final DefaultFileRecordManager records = new DefaultFileRecordManager(
            new DefaultFileRecordStore(), new FileRecordRestorer(hasher), hasher);
    private final EditFileToolExecutor editor = new EditFileToolExecutor(mapper, new EditDiffer(), records);

    @ParameterizedTest
    @MethodSource("editVariants")
    void multilineEditsKeepFileBytesAndCanBeRolledBack(String type, String fileEnding, String argumentEnding) throws Exception {
        String prefix = "\uFEFF前言🙂" + fileEnding;
        String originalMatch = "  first" + fileEnding + "    second";
        String original = prefix + originalMatch + fileEnding + "尾部";
        String replacement = "  改动🙂\n    next\n";
        String converted = replacement.replace("\n", fileEnding);
        String expected = prefix + switch (type) {
            case "REPLACE" -> converted;
            case "DELETE" -> "";
            case "INSERT_BEFORE" -> converted + originalMatch;
            case "INSERT_AFTER" -> originalMatch + converted;
            default -> throw new AssertionError(type);
        } + fileEnding + "尾部";
        writeOriginal(original);

        ToolExecuteResult result = edit(type, "  first" + argumentEnding + "    second", replacement);

        assertTrue(result.isSuccess(), result.getToolOutput());
        assertBytes(expected);
        List<FileRecord> pending = records.listPendingRecords("line-ending-test");
        assertEquals(1, pending.size());
        FileRecord record = pending.getFirst();
        assertEquals(original, record.oldContent());
        assertEquals(expected, record.newContent());
        assertTrue(records.reject("line-ending-test", record.id(), workspace()));
        assertBytes(original);
    }

    @ParameterizedTest
    @ValueSource(strings = {"REPLACE", "DELETE", "INSERT_BEFORE", "INSERT_AFTER"})
    void duplicatesAcrossLineEndingStylesAreRejected(String type) throws Exception {
        String original = "first\r\nsecond\n---\nfirst\nsecond";
        writeOriginal(original);
        ToolExecuteResult result = edit(type, "first\nsecond", "changed\n");
        assertFalse(result.isSuccess(), result.getToolOutput());
        assertTrue(result.getToolOutput().contains("命中多处"), result.getToolOutput());
        assertBytes(original);
        assertTrue(records.listPendingRecords("line-ending-test").isEmpty());
    }

    @ParameterizedTest
    @ValueSource(strings = {"REPLACE", "DELETE", "INSERT_BEFORE", "INSERT_AFTER"})
    void overlappingMultilineMatchesAreRejected(String type) throws Exception {
        String original = "a\r\na\r\na";
        writeOriginal(original);
        ToolExecuteResult result = edit(type, "a\na", "changed");
        assertFalse(result.isSuccess(), result.getToolOutput());
        assertTrue(result.getToolOutput().contains("命中多处"), result.getToolOutput());
        assertBytes(original);
        assertTrue(records.listPendingRecords("line-ending-test").isEmpty());
    }

    @Test
    void lineRangeReadCanBeUsedDirectlyAsMultilineOldText() throws Exception {
        writeOriginal("header\r\nfirst\r\nsecond\r\ntail");
        ToolExecuteResult read = new ReadFileToolExecutor(mapper).execute(ToolExecution.builder().workspace(workspace())
                .args(mapper.writeValueAsString(Map.of("path", "demo.txt", "startLine", 1, "endLine", 2))).build());
        assertTrue(read.isSuccess(), read.getToolOutput());
        assertEquals("first\nsecond", read.getToolOutput());

        ToolExecuteResult result = edit("REPLACE", read.getToolOutput(), "new\ntext");
        assertTrue(result.isSuccess(), result.getToolOutput());
        assertBytes("header\r\nnew\r\ntext\r\ntail");
    }

    @Test
    void mixedFileKeepsUneditedBytesAndUsesTheMatchedLineEnding() throws Exception {
        String original = "\uFEFF保留\r\n头🙂\nfirst\nsecond\r\ntail\nlast\r\n";
        writeOriginal(original);
        ToolExecuteResult result = edit("REPLACE", "first\r\nsecond", "new\r\ntext");
        assertTrue(result.isSuccess(), result.getToolOutput());
        assertBytes("\uFEFF保留\r\n头🙂\nnew\ntext\r\ntail\nlast\r\n");
    }

    @ParameterizedTest
    @ValueSource(strings = {"\n", "\r\n"})
    void singleLineMatchStillConvertsNewMultilineTextToCrlf(String argumentEnding) throws Exception {
        writeOriginal("first\r\nanchor\r\nlast");
        ToolExecuteResult result = edit("INSERT_AFTER", "anchor", argumentEnding + "new" + argumentEnding + "lines");
        assertTrue(result.isSuccess(), result.getToolOutput());
        assertBytes("first\r\nanchor\r\nnew\r\nlines\r\nlast");
    }

    @Test
    void finalLineWithoutTerminatorUsesThePreviousLineEnding() throws Exception {
        writeOriginal("first\r\nanchor");
        ToolExecuteResult result = edit("REPLACE", "anchor", "new\nlines");
        assertTrue(result.isSuccess(), result.getToolOutput());
        assertBytes("first\r\nnew\r\nlines");
    }

    @ParameterizedTest
    @ValueSource(strings = {"", "prefix"})
    void noExistingLineEndingKeepsIncomingText(String original) throws Exception {
        writeOriginal(original);
        ToolExecuteResult result = edit("INSERT_AFTER", original, "新建\r\n文件🙂");
        assertTrue(result.isSuccess(), result.getToolOutput());
        assertBytes(original + "新建\r\n文件🙂");
    }

    @ParameterizedTest
    @ValueSource(strings = {"value = \"ab\";\nnext", "value = 'a b';\nnext", "value — \"a b\";\nnext", "value = \"a b\";\rnext"})
    void nonLineEndingDifferencesRemainRejected(String match) throws Exception {
        String original = "value = \"a b\";\r\nnext";
        writeOriginal(original);
        ToolExecuteResult result = edit("REPLACE", match, "changed");
        assertFalse(result.isSuccess(), result.getToolOutput());
        assertBytes(original);
        assertTrue(records.listPendingRecords("line-ending-test").isEmpty());
    }

    private void writeOriginal(String content) throws Exception {
        Files.write(root.resolve("demo.txt"), content.getBytes(StandardCharsets.UTF_8));
    }

    private void assertBytes(String expected) throws Exception {
        assertArrayEquals(expected.getBytes(StandardCharsets.UTF_8), Files.readAllBytes(root.resolve("demo.txt")));
    }

    private ToolExecuteResult edit(String type, String match, String replacement) throws Exception {
        return editor.execute(ToolExecution.builder().workspace(workspace()).executionId("line-ending-test").turnId("turn")
                .args(mapper.writeValueAsString(Map.of("type", type, "path", "demo.txt", "oldText", match,
                        "anchor", match, "newText", replacement))).build());
    }

    private Workspace workspace() {
        return new LocalWorkspace("line-ending-test", root.toString());
    }

    static Stream<Arguments> editVariants() {
        return Stream.of("REPLACE", "DELETE", "INSERT_BEFORE", "INSERT_AFTER").flatMap(type -> Stream.of(
                Arguments.of(type, "\r\n", "\n"), Arguments.of(type, "\n", "\r\n"),
                Arguments.of(type, "\r\n", "\r\n"), Arguments.of(type, "\n", "\n")));
    }
}
