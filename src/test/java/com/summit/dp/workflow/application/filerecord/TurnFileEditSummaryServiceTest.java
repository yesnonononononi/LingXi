package com.summit.dp.workflow.application.filerecord;

import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.application.filerecord.TurnFileEditSummaryService.TurnFileEdit;
import com.summit.dp.workflow.infrastructure.tools.file.edit.EditDiffer;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordStore;
import com.summit.dp.workflow.infrastructure.tools.file.record.DiffResult;
import com.summit.dp.workflow.infrastructure.tools.file.record.Differ;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileModificationException;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecord;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordManager;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.Serializable;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 轮次汇总：同一文件多次编辑必须合并成一条，且数字是<b>净改动</b>而不是逐次累加。
 *
 * <p>净改动与累加最容易混淆的场景是「改过去又改回来」：逐次累加会得到 +2/−2，
 * 净改动必须是 0/0。这一条是本节的核心断言，其余用例守顺序、过滤、新建语义，
 * 以及「只有最新轮次带差异正文」这条展示契约。</p>
 */
class TurnFileEditSummaryServiceTest {

    private static final long TURN_ID = 7L;
    private static final long EXECUTION_ID = 100L;
    private static final long SESSION_ID = 1L;
    private static final String EXECUTION_KEY = "100";
    /** 记录侧的轮次标识是框架给的字符串，与业务轮次的数值主键不同形。 */
    private static final String TURN_KEY = "7";

    private final Differ differ = new EditDiffer();

    private FileRecordManager records;
    private ChatTurnRepository turns;
    private TurnFileEditSummaryService service;

    @BeforeEach
    void setUp() {
        records = new DefaultFileRecordManager(new DefaultFileRecordStore());
        turns = mock(ChatTurnRepository.class);
        service = new TurnFileEditSummaryService(records, turns, differ);
    }

    @Test
    void mergesRepeatedEditsOfSameFileIntoNetChange() throws FileModificationException {
        givenTurn(TURN_ID, EXECUTION_ID);
        // 改过去又改回来：逐次累加会记成 +2/−2，净改动必须是 0/0。
        records.record(EXECUTION_KEY, TURN_KEY, draft("demo.txt", "x\n", "x\n", "y\n"));
        records.record(EXECUTION_KEY, TURN_KEY, draft("demo.txt", null, "y\n", "x\n"));

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
    void keepsFileOrderByFirstAppearance() throws FileModificationException {
        givenTurn(TURN_ID, EXECUTION_ID);
        records.record(EXECUTION_KEY, TURN_KEY, draft("a.txt", "a\n", "a\n", "a\nb\n"));
        records.record(EXECUTION_KEY, TURN_KEY, draft("b.txt", "b\n", "b\n", "b\nc\n"));
        records.record(EXECUTION_KEY, TURN_KEY, draft("a.txt", null, "a\nb\n", "a\nb\nd\n"));

        List<TurnFileEdit> summary = service.summarize(TURN_ID);

        assertEquals(List.of("a.txt", "b.txt"), summary.stream().map(TurnFileEdit::filePath).toList());
        // a.txt 两次编辑合并后的净改动：a → a,b,d 共 +2。
        assertEquals(2, summary.getFirst().plusLines());
        assertEquals(0, summary.getFirst().minusLines());
        assertEquals(2, summary.getFirst().edits());
    }

    @Test
    void ignoresRecordsOfOtherTurns() throws FileModificationException {
        givenTurn(TURN_ID, EXECUTION_ID);
        records.record(EXECUTION_KEY, TURN_KEY, draft("mine.txt", "m\n", "m\n", "m\nn\n"));
        // 同一执行下的另一轮：数值主键不同，字符串形态也不同。
        records.record(EXECUTION_KEY, "8", draft("other.txt", "o\n", "o\n", "o\np\n"));

        List<TurnFileEdit> summary = service.summarize(TURN_ID);

        assertEquals(List.of("mine.txt"), summary.stream().map(TurnFileEdit::filePath).toList());
    }

    @Test
    void createdFileCountsWholeContentAsAdded() throws FileModificationException {
        givenTurn(TURN_ID, EXECUTION_ID);
        records.record(EXECUTION_KEY, TURN_KEY, draft("new.txt", null, "", "one\ntwo\n"));

        TurnFileEdit edit = service.summarize(TURN_ID).getFirst();

        assertTrue(edit.created());
        assertEquals(2, edit.plusLines());
        assertEquals(0, edit.minusLines());
    }

    @Test
    void deletedLinesAreCountedInTheNetChange() throws FileModificationException {
        givenTurn(TURN_ID, EXECUTION_ID);
        records.record(EXECUTION_KEY, TURN_KEY, draft("demo.txt", "a\nb\nc\n", "a\nb\nc\n", "a\nc\n"));

        TurnFileEdit edit = service.summarize(TURN_ID).getFirst();

        assertEquals(0, edit.plusLines());
        assertEquals(1, edit.minusLines(), "删掉一行必须记在新侧之外的那一栏");
    }

    @Test
    void onlyLatestTurnCarriesDiffBody() throws FileModificationException {
        givenTurn(TURN_ID, EXECUTION_ID);
        records.record(EXECUTION_KEY, TURN_KEY, draft("demo.txt", "a\n", "a\n", "a\nb\n"));

        // 历史轮次：只给行数，差异正文为 null。
        assertNull(service.summarize(TURN_ID).getFirst().diff(), "历史轮次不该带差异正文");

        // 成为最新轮次后才给正文。
        givenLatestTurn(TURN_ID);
        String diff = service.summarize(TURN_ID).getFirst().diff();
        assertTrue(diff != null && diff.contains("+b"), "最新轮次必须带差异正文");
    }

    @Test
    void accumulatedDiffStopsAtTheTargetRecord() throws FileModificationException {
        givenTurn(TURN_ID, EXECUTION_ID);
        Serializable first = records.record(EXECUTION_KEY, TURN_KEY, draft("demo.txt", "a\n", "a\n", "a\nb\n"));
        records.record(EXECUTION_KEY, TURN_KEY, draft("demo.txt", null, "a\nb\n", "a\nb\nc\n"));

        String upToFirst = service.accumulatedDiff(EXECUTION_KEY, String.valueOf(first)).orElseThrow();

        // 只重放到第一条为止：后面那次编辑的内容不能提前出现。
        assertTrue(upToFirst.contains("+b"), upToFirst);
        assertFalse(upToFirst.contains("+c"), "不该包含目标记录之后的改动: " + upToFirst);
    }

    @Test
    void accumulatedDiffIsEmptyForUnknownRecord() {
        givenTurn(TURN_ID, EXECUTION_ID);

        assertTrue(service.accumulatedDiff(EXECUTION_KEY, "missing").isEmpty());
    }

    @Test
    void turnWithoutSessionIsNeverTreatedAsLatest() throws FileModificationException {
        // 会话尚未绑定（或旧数据没有 sessionId）时无从判断「最新」，按历史轮次处理：只给行数。
        when(turns.findById(TURN_ID)).thenReturn(
                Optional.of(ChatTurn.builder().id(TURN_ID).executionId(EXECUTION_ID).build()));
        records.record(EXECUTION_KEY, TURN_KEY, draft("demo.txt", "a\n", "a\n", "a\nb\n"));

        TurnFileEdit edit = service.summarize(TURN_ID).getFirst();

        assertNull(edit.diff(), "没有会话就断定不了最新，不能凭猜测把差异正文带出来");
        assertEquals(1, edit.plusLines());
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

    private void givenTurn(long turnId, long executionId) {
        when(turns.findById(turnId)).thenReturn(
                Optional.of(ChatTurn.builder().id(turnId).sessionId(SESSION_ID).executionId(executionId).build()));
    }

    private void givenLatestTurn(long turnId) {
        when(turns.findLatest(any(), isNull(), anyInt())).thenReturn(List.of(
                ChatTurn.builder().id(turnId).sessionId(SESSION_ID).executionId(EXECUTION_ID).build()));
    }

    /**
     * 造一条记录：{@code oldContent} 是这次修改前的全文，差异与行数由真实 differ 生成，
     * 免得测试自己手搓一份可能生成侧口径不一致的差异。
     */
    private FileRecord draft(String path, String baseline, String oldContent, String newContent) {
        DiffResult diff = differ.diff(path, oldContent, newContent);
        return FileRecord.builder().filePath(path).baseline(baseline)
                .diff(diff.unifiedDiff()).plusLines(diff.plusLines()).minusLines(diff.minusLines()).build();
    }
}

