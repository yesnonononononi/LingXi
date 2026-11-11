package com.summit.dp.workflow.infrastructure.tools.file.record;

import org.junit.jupiter.api.Test;

import java.io.Serializable;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 记录登记做两件事：<b>基线只在分段起点保留</b>，以及<b>链断了要认得出来</b>。
 *
 * <p>一轮里把同一个文件改十次，如果每次都存全文，长会话就是把整份文件复制十份 ——
 * 这是此前 OOM 隐患的主因。但只留一份基线的前提是「改动都经过 {@code edit_file}」；
 * 用 shell / python 直写会把链打断，那时必须另起一段重新留基线，否则整份差异再也重建不出来。
 * 这组用例把两个方向都钉住：链连着不许重复存基线，链断了必须重新存。</p>
 */
class DefaultFileRecordManagerTest {

    private final FileRecordManager records = new DefaultFileRecordManager(new InMemoryFileRecordStore());

    @Test
    void onlyTheFirstRecordOfTurnFileKeepsBaseline() throws FileModificationException {
        Serializable first = records.record("e1", "t1", draft("demo.txt", "v1\n", "v2\n"));
        records.record("e1", "t1", draft("demo.txt", "v2\n", "v3\n"));

        List<FileRecord> recorded = records.listRecords("e1");

        assertEquals(2, recorded.size());
        assertEquals("v1\n", recorded.getFirst().baseline(), "首条必须保留本轮开始前的全文");
        assertNull(recorded.getLast().baseline(), "链还连着就不重复存全文");
        assertEquals(1, recorded.getFirst().version());
        assertEquals(2, recorded.getLast().version(), "同文件版本按写入顺序递增");
        assertTrue(recorded.getFirst().segmentStart(), "首条一定是分段起点");
        assertFalse(recorded.getLast().segmentStart());
        assertEquals(ContentDigest.compute("v2\n"),
                records.getRecord("e1", first).orElseThrow().contentDigest(), "摘要要如实落库");
    }

    @Test
    void differentFilesAndTurnsEachKeepTheirOwnBaseline() throws FileModificationException {
        records.record("e1", "t1", draft("a.txt", "a\n", "a\nb\n"));
        records.record("e1", "t1", draft("b.txt", "b\n", "b\nc\n"));
        records.record("e1", "t2", draft("a.txt", "a\nb\n", "a\nb\nd\n"));

        List<FileRecord> recorded = records.listRecords("e1");

        assertEquals(3, recorded.size());
        assertNotNull(recorded.get(0).baseline());
        assertNotNull(recorded.get(1).baseline(), "另一个文件是它自己的首条");
        assertNotNull(recorded.get(2).baseline(), "新一轮重新取基线，否则跨轮次的差异无从重放");
    }

    @Test
    void newFileKeepsNullBaselineSoReaderKnowsItIsCreated() throws FileModificationException {
        records.record("e1", "t1", draft("new.txt", null, "one\n"));

        FileRecord record = records.listRecords("e1").getFirst();

        assertNull(record.baseline());
        assertTrue(record.segmentStart(), "从空文件开始也是一段的起点");
    }

    /**
     * 工具外的修改让上一条记录的末态和这次改之前的内容对不上：必须另起一段、重新保留基线。
     *
     * <p>反过来说，只留一份基线而不认断链，后面那条 diff 就永远重放不出来 —— 界面上表现为
     * 「行数 0、差异不可用」，而日志里只有一句对不上的 reason。</p>
     */
    @Test
    void brokenChainStartsNewSegmentAndKeepsItsOwnBaseline() throws FileModificationException {
        records.record("e1", "t1", draft("demo.txt", "v1\n", "v2\n"));
        // 中间有人用 shell 把文件改成了别的样子，本次编辑看到的「改之前」是 "手改\n"。
        records.record("e1", "t1", draft("demo.txt", "手改\n", "手改\nv3\n"));

        List<FileRecord> recorded = records.listRecords("e1");

        assertEquals("手改\n", recorded.getLast().baseline(), "断点必须自带基线，否则这一段没法重放");
        assertTrue(recorded.getLast().segmentStart());
    }

    /** 老记录（V16 之前）没有摘要，链不可验证：宁可多留一份基线，也不能猜「还连着」。 */
    @Test
    void recordWithoutDigestForcesANewSegment() throws FileModificationException {
        InMemoryFileRecordStore store = new InMemoryFileRecordStore();
        FileRecordManager manager = new DefaultFileRecordManager(store);
        store.put(FileRecord.builder().executionId((Serializable) "e1").turnId("t1").filePath("demo.txt")
                .baseline("v1\n").diff("+v2").plusLines(1).minusLines(0).build());

        manager.record("e1", "t1", draft("demo.txt", "v2\n", "v2\nv3\n"));

        assertNotNull(manager.listRecords("e1").getLast().baseline(), "没有摘要就当作已断");
    }

    @Test
    void recordWithoutPathOrDiffIsRejected() {
        assertThrows(FileModificationException.class, () -> records.record("e1", "t1", draft(null, "v1\n", "v2\n")));
        assertThrows(FileModificationException.class, () -> records.record("e1", "t1",
                FileRecord.builder().filePath("demo.txt").baseline("v1\n").build()));
        assertTrue(records.listRecords("e1").isEmpty(), "拒绝的记录不得落库");
    }

    @Test
    void recordsAreLookedUpByExecutionAndRecordId() throws FileModificationException {
        Serializable id = records.record("e1", "t1", draft("demo.txt", "v1\n", "v2\n"));

        assertTrue(records.getRecord("e1", id).isPresent());
        // 执行分区是硬边界：拿别的执行标识查不到，避免跨会话串记录。
        assertTrue(records.getRecord("e2", id).isEmpty());
    }

    /** 造一条草稿：{@code before} 是这次改之前的全文（{@code null} = 文件不存在），{@code after} 是改完的全文。 */
    private FileRecord draft(String path, String before, String after) {
        return FileRecord.builder().filePath(path).baseline(before).diff("+" + after)
                .plusLines(1).minusLines(0).contentDigest(ContentDigest.compute(after)).build();
    }
}
