package com.summit.dp.workflow.infrastructure.tools.file;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.workflow.infrastructure.tools.config.FileToolConfiguration;
import com.summit.dp.workflow.infrastructure.tools.file.edit.EditDiffer;
import com.summit.dp.workflow.infrastructure.tools.file.edit.EditFileToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.file.read.ReadFileToolExecutor;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileHasher;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordStore;
import com.summit.dp.workflow.infrastructure.tools.file.record.DiffResult;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordRestorer;
import com.summit.runtime.workspace.LocalWorkspace;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;

/** 错误参数和不唯一的定位不能变成成功写入。 */
class FileToolContractRegressionTest {
    @TempDir Path root;
    private final ObjectMapper mapper = new ObjectMapper();
    private final DefaultFileHasher hasher = new DefaultFileHasher();
    private final DefaultFileRecordManager records = new DefaultFileRecordManager(
            new DefaultFileRecordStore(), new FileRecordRestorer(hasher), hasher);
    private final EditFileToolExecutor editor = new EditFileToolExecutor(mapper, new EditDiffer(), records);

    @Test
    void missingReplacementTextCannotDeleteContent() throws Exception {
        assertRejectedEdit("alpha beta", Map.of("type", "REPLACE", "oldText", "beta"));
    }

    @Test
    void explicitlyEmptyReplacementStillDeletesRequestedText() throws Exception {
        Files.writeString(root.resolve("demo.txt"), "alpha beta");
        ToolExecuteResult result = edit(Map.of("type", "REPLACE", "oldText", " beta", "newText", ""));
        assertTrue(result.isSuccess(), result.getToolOutput());
        assertEquals("alpha", Files.readString(root.resolve("demo.txt")));
    }

    @ParameterizedTest
    @ValueSource(strings = {"REPLACE", "DELETE", "INSERT_BEFORE", "INSERT_AFTER"})
    void semanticDifferencesCannotBecomeMatches(String type) throws Exception {
        assertRejectedEdit("return \"a b\";", Map.of("type", type, "oldText", "return \"ab\";",
                "anchor", "return \"ab\";", "newText", "changed"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"REPLACE", "DELETE", "INSERT_BEFORE", "INSERT_AFTER"})
    void overlappingMatchesAreRejected(String type) throws Exception {
        assertRejectedEdit("aaa", Map.of("type", type, "oldText", "aa", "anchor", "aa", "newText", "X"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"REPLACE", "DELETE", "INSERT_BEFORE", "INSERT_AFTER"})
    void nonOverlappingMatchesRemainRejected(String type) throws Exception {
        assertRejectedEdit("aa aa", Map.of("type", type, "oldText", "aa", "anchor", "aa", "newText", "X"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"REPLACE", "INSERT_BEFORE", "INSERT_AFTER"})
    void missingNewTextCannotReportSuccessfulEdit(String type) throws Exception {
        assertRejectedEdit("alpha beta", Map.of("type", type, "oldText", "beta", "anchor", "beta"));
    }

    @Test
    void invalidTypeReturnsToolErrorWithoutWriting() throws Exception {
        assertRejectedEdit("alpha beta", Map.of("type", "UNKNOWN", "oldText", "beta", "newText", "BETA"));
    }

    @ParameterizedTest
    @CsvSource({"-1,1", "0,-1", "2,1"})
    void invalidLineRangeReturnsBusinessError(int start, int end) throws Exception {
        Files.writeString(root.resolve("demo.txt"), "first\nsecond\nthird\n");
        ToolExecuteResult result = new ReadFileToolExecutor(mapper).execute(execution(
                Map.of("path", "demo.txt", "startLine", start, "endLine", end)));
        assertFalse(result.isSuccess());
        assertTrue(result.getToolOutput().contains("行"), result.getToolOutput());
    }

    @Test
    void lineRangeRemainsZeroBasedAndInclusive() throws Exception {
        Files.writeString(root.resolve("demo.txt"), "first\nsecond\nthird\n");
        ToolExecuteResult result = new ReadFileToolExecutor(mapper).execute(execution(
                Map.of("path", "demo.txt", "startLine", 1, "endLine", 2)));
        assertTrue(result.isSuccess(), result.getToolOutput());
        assertEquals("second\nthird", result.getToolOutput());
    }

    @Test
    void appliedEditSummaryCountsOnlyChangedContent() throws Exception {
        Files.writeString(root.resolve("demo.txt"), "alpha\nbeta\n");
        ToolExecuteResult result = edit(Map.of("type", "REPLACE", "oldText", "beta", "newText", "BETA"));
        assertTrue(result.isSuccess(), result.getToolOutput());
        JsonNode summary = mapper.readTree(result.getToolOutput());
        assertEquals(1, summary.path("plusLines").intValue());
        assertEquals(1, summary.path("minusLines").intValue());
        Map<?, ?> metadata = (Map<?, ?>) result.getToolMetaData().get("fileEdit");
        assertEquals(1, metadata.get("plusLines"));
        assertEquals(1, metadata.get("minusLines"));
        assertNotNull(metadata.get("recordId"));
        assertEquals("alpha\nBETA\n", Files.readString(root.resolve("demo.txt")));
    }

    @Test
    void blankDiffLinesAndContentPrefixesAreStillCounted() {
        DiffResult diff = DiffResult.success(List.of("--- demo.txt", "+++ demo.txt", "@@ -1,2 +1,2 @@",
                "-", "---literal", "+", "+++literal"));
        assertEquals(2, diff.plusLines());
        assertEquals(2, diff.minusLines());
        assertEquals(1, DiffResult.countDiffLines(List.of("@@ -0,0 +1 @@", "+"), '+'));
        assertEquals(1, DiffResult.countDiffLines(List.of("@@ -1 +0,0 @@", "-"), '-'));
    }

    @Test
    void toolSchemasDeclareRequiredFieldsAndLineBounds() throws Exception {
        FileToolConfiguration configuration = new FileToolConfiguration();
        JsonNode read = mapper.readTree(configuration.readFileToolDefinition(mapper).parametersJsonSchema());
        JsonNode edit = mapper.readTree(configuration.editFileToolDefinition(mapper, records, new EditDiffer())
                .parametersJsonSchema());
        assertEquals(List.of("path"), mapper.convertValue(read.path("required"), List.class));
        assertEquals(List.of("type", "path"), mapper.convertValue(edit.path("required"), List.class));
        assertEquals(0, read.path("properties").path("startLine").path("minimum").asInt(-1));
        assertEquals(0, read.path("properties").path("endLine").path("minimum").asInt(-1));
    }

    private void assertRejectedEdit(String original, Map<String, Object> args) throws Exception {
        Files.writeString(root.resolve("demo.txt"), original);
        ToolExecuteResult result = edit(args);
        assertFalse(result.isSuccess(), result.getToolOutput());
        assertEquals(original, Files.readString(root.resolve("demo.txt")));
        assertTrue(records.listPendingRecords("test-execution").isEmpty());
    }

    private ToolExecuteResult edit(Map<String, Object> args) throws Exception {
        Map<String, Object> complete = new LinkedHashMap<>(args);
        complete.put("path", "demo.txt");
        return editor.execute(execution(complete));
    }

    private ToolExecution execution(Map<String, Object> args) throws Exception {
        Workspace workspace = new LocalWorkspace("test", root.toString());
        return ToolExecution.builder().workspace(workspace).executionId("test-execution").turnId("test-turn")
                .args(mapper.writeValueAsString(args)).build();
    }
}
