package com.summit.dp.workflow.application.filerecord;

import com.summit.core.runtime.workspace.Workspace;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.application.filerecord.TurnFileEditSummaryService.TurnFileEdit;
import com.summit.dp.workflow.infrastructure.tools.file.edit.EditDiffer;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileHasher;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordStore;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileModificationException;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecord;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordRestorer;
import com.summit.runtime.workspace.LocalWorkspace;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 轮次汇总：同一文件多次编辑必须合并成一条，且数字是<b>净改动</b>而不是逐次累加。
 *
 * <p>净改动与累加最容易混淆的场景是「改过去又改回来」：逐次累加会得到 +2/−2，
 * 净改动必须是 0/0。这一条是本节的核心断言，其余用例守顺序、过滤与新建语义。</p>
 */
class TurnFileEditSummaryServiceTest {

    private static final long TURN_ID = 7L;
    private static final long EXECUTION_ID = 100L;
    private static final String EXECUTION_KEY = "100";
    /** 记录侧的轮次标识是框架给的字符串，与业务轮次的数值主键不同形。 */
    private static final String TURN_KEY = "7";

    @TempDir
    Path root;

    private FileRecordManager records;
    private ChatTurnRepository turns;
    private TurnFileEditSummaryService service;

    @BeforeEach
    void setUp() {
        DefaultFileHasher hasher = new DefaultFileHasher();
        records = new DefaultFileRecordManager(new DefaultFileRecordStore(),
                new FileRecordRestorer(hasher), hasher);
        turns = mock(ChatTurnRepository.class);
        service = new TurnFileEditSummaryService(records, turns, new EditDiffer());
    }

    @Test
    void mergesRepeatedEditsOfSameFileIntoNetChange() {
        givenTurn(TURN_ID, EXECUTION_ID);
        // 改过去又改回来：逐次累加会记成 +2/−2，净改动必须是 0/0。
        records.record(EXECUTION_KEY, TURN_KEY, draft("demo.txt", "x\n", "y\n"));
        records.record(EXECUTION_KEY, TURN_KEY, draft("demo.txt", "y\n", "x\n"));

        List<TurnFileEdit> summary = service.summarize(TURN_ID);

        assertEquals(1, summary.size(), "同一文件的两次编辑必须合并成一条");
        TurnFileEdit edit = summary.getFirst();
        assertEquals("demo.txt", edit.filePath());
        assertEquals(2, edit.edits());
        assertEquals(0, edit.plusLines(), "净改动必须是重算结果，不是逐次累加");
        assertEquals(0, edit.minusLines());
        assertFalse(edit.created());
    }

    @Test
    void keepsFileOrderByFirstAppearance() {
        givenTurn(TURN_ID, EXECUTION_ID);
        records.record(EXECUTION_KEY, TURN_KEY, draft("a.txt", "a\n", "a\nb\n"));
        records.record(EXECUTION_KEY, TURN_KEY, draft("b.txt", "b\n", "b\nc\n"));
        records.record(EXECUTION_KEY, TURN_KEY, draft("a.txt", "a\nb\n", "a\nb\nd\n"));

        List<TurnFileEdit> summary = service.summarize(TURN_ID);

        assertEquals(List.of("a.txt", "b.txt"), summary.stream().map(TurnFileEdit::filePath).toList());
        // a.txt 两次编辑合并后的净改动：a → a,b,d 共 +2。
        assertEquals(2, summary.getFirst().plusLines());
        assertEquals(0, summary.getFirst().minusLines());
        assertEquals(2, summary.getFirst().edits());
    }

    @Test
    void ignoresRecordsOfOtherTurns() {
        givenTurn(TURN_ID, EXECUTION_ID);
        records.record(EXECUTION_KEY, TURN_KEY, draft("mine.txt", "m\n", "m\nn\n"));
        // 同一执行下的另一轮：数值主键不同，字符串形态也不同。
        records.record(EXECUTION_KEY, "8", draft("other.txt", "o\n", "o\np\n"));

        List<TurnFileEdit> summary = service.summarize(TURN_ID);

        assertEquals(List.of("mine.txt"), summary.stream().map(TurnFileEdit::filePath).toList());
    }

    @Test
    void createdFileCountsWholeContentAsAdded() {
        givenTurn(TURN_ID, EXECUTION_ID);
        records.record(EXECUTION_KEY, TURN_KEY, draft("new.txt", null, "one\ntwo\n"));

        TurnFileEdit edit = service.summarize(TURN_ID).getFirst();

        assertTrue(edit.created());
        assertEquals(2, edit.plusLines());
        assertEquals(0, edit.minusLines());
    }

    @Test
    void emptyWhenTurnIsUnknown() {
        when(turns.findById(TURN_ID)).thenReturn(Optional.empty());

        assertEquals(List.of(), service.summarize(TURN_ID));
    }

    @Test
    void emptyWhenTurnHasNoExecutionYet() {
        // 受理后、执行创建前的窗口：没有执行 ID 就无从定位记录。
        when(turns.findById(TURN_ID)).thenReturn(Optional.of(ChatTurn.builder().id(TURN_ID).build()));

        assertEquals(List.of(), service.summarize(TURN_ID));
    }

    @Test
    void rejectingTurnRestoresEveryFileOfThatTurn() throws IOException, FileModificationException {
        givenTurn(TURN_ID, EXECUTION_ID);
        Path a = writeFile("a.txt", "one\n");
        Path b = writeFile("b.txt", "keep\n");
        records.record(EXECUTION_KEY, TURN_KEY, draft("a.txt", "one\n", "two\n"));
        Files.writeString(a, "two\n", StandardCharsets.UTF_8);
        records.record(EXECUTION_KEY, TURN_KEY, draft("b.txt", "keep\n", "changed\n"));
        Files.writeString(b, "changed\n", StandardCharsets.UTF_8);

        int restored = records.rejectTurn(EXECUTION_KEY, TURN_KEY, workspace());

        assertEquals(2, restored);
        assertEquals("one\n", Files.readString(a, StandardCharsets.UTF_8));
        assertEquals("keep\n", Files.readString(b, StandardCharsets.UTF_8));
    }

    @Test
    void rejectingTurnOfSameFileTwiceRestoresTheOriginalContent() throws IOException, FileModificationException {
        givenTurn(TURN_ID, EXECUTION_ID);
        Path a = writeFile("a.txt", "v1\n");
        records.record(EXECUTION_KEY, TURN_KEY, draft("a.txt", "v1\n", "v2\n"));
        Files.writeString(a, "v2\n", StandardCharsets.UTF_8);
        records.record(EXECUTION_KEY, TURN_KEY, draft("a.txt", "v2\n", "v3\n"));
        Files.writeString(a, "v3\n", StandardCharsets.UTF_8);

        assertEquals(2, records.rejectTurn(EXECUTION_KEY, TURN_KEY, workspace()));

        // 逆序还原是硬约束：正序会把中间版本写回，最终停在 v2。
        assertEquals("v1\n", Files.readString(a, StandardCharsets.UTF_8));
    }

    @Test
    void rejectingTurnRefusesToOverwriteLaterUserEdits() throws IOException {
        givenTurn(TURN_ID, EXECUTION_ID);
        Path a = writeFile("a.txt", "v1\n");
        records.record(EXECUTION_KEY, TURN_KEY, draft("a.txt", "v1\n", "v2\n"));
        // 用户在编辑之后又手工改过：回滚必须拒绝，否则会吞掉用户的新内容。
        Files.writeString(a, "hand-edited\n", StandardCharsets.UTF_8);

        assertThrows(FileModificationException.class,
                () -> records.rejectTurn(EXECUTION_KEY, TURN_KEY, workspace()));
        assertEquals("hand-edited\n", Files.readString(a, StandardCharsets.UTF_8));
    }

    @Test
    void rejectedEditsDisappearFromTheSummary() throws IOException, FileModificationException {
        givenTurn(TURN_ID, EXECUTION_ID);
        Path a = writeFile("a.txt", "v1\n");
        records.record(EXECUTION_KEY, TURN_KEY, draft("a.txt", "v1\n", "v2\n"));
        Files.writeString(a, "v2\n", StandardCharsets.UTF_8);

        assertEquals(1, service.summarize(TURN_ID).size());
        records.rejectTurn(EXECUTION_KEY, TURN_KEY, workspace());

        // 文件已经还原，「本轮改动」就不该再列它 —— 否则清单在说谎。
        assertEquals(List.of(), service.summarize(TURN_ID));
    }

    private void givenTurn(long turnId, long executionId) {
        when(turns.findById(turnId)).thenReturn(
                Optional.of(ChatTurn.builder().id(turnId).executionId(executionId).build()));
    }

    private Workspace workspace() {
        return new LocalWorkspace("test", root.toString());
    }

    private Path writeFile(String name, String content) throws IOException {
        Path path = root.resolve(name);
        Files.writeString(path, content, StandardCharsets.UTF_8);
        return path;
    }

    private FileRecord draft(String path, String oldContent, String newContent) {
        return FileRecord.builder().filePath(path).oldContent(oldContent).newContent(newContent).build();
    }
}
