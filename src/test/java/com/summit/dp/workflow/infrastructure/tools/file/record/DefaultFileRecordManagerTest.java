package com.summit.dp.workflow.infrastructure.tools.file.record;

import org.junit.jupiter.api.Test;

import java.io.Serializable;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 记录登记只做一件事：<b>基线只留一份</b>。
 *
 * <p>一轮里把同一个文件改十次，如果每次都存全文，长会话就是把整份文件复制十份 ——
 * 这是此前 OOM 隐患的主因。这里钉住「首条带基线、后续置空」，以及「不同文件、不同轮次
 * 各自拥有自己的基线」，避免有人为了省事改回逐条存全文。</p>
 */
class DefaultFileRecordManagerTest {

    private final FileRecordManager records = new DefaultFileRecordManager(new DefaultFileRecordStore());

    @Test
    void onlyTheFirstRecordOfTurnFileKeepsBaseline() throws FileModificationException {
        records.record("e1", "t1", draft("demo.txt", "v1\n", "+v2"));
        records.record("e1", "t1", draft("demo.txt", "v2\n", "+v3"));

        List<FileRecord> recorded = records.listRecords("e1");

        assertEquals(2, recorded.size());
        assertEquals("v1\n", recorded.getFirst().baseline(), "首条必须保留本轮开始前的全文");
        assertNull(recorded.getLast().baseline(), "后续记录不再重复存全文");
        assertEquals(1, recorded.getFirst().version());
        assertEquals(2, recorded.getLast().version(), "同文件版本按写入顺序递增");
    }

    @Test
    void differentFilesAndTurnsEachKeepTheirOwnBaseline() throws FileModificationException {
        records.record("e1", "t1", draft("a.txt", "a\n", "+b"));
        records.record("e1", "t1", draft("b.txt", "b\n", "+c"));
        records.record("e1", "t2", draft("a.txt", "a\nb\n", "+d"));

        List<FileRecord> recorded = records.listRecords("e1");

        assertEquals(3, recorded.size());
        assertNotNull(recorded.get(0).baseline());
        assertNotNull(recorded.get(1).baseline(), "另一个文件是它自己的首条");
        assertNotNull(recorded.get(2).baseline(), "新一轮重新取基线，否则跨轮次的差异无从重放");
    }

    @Test
    void newFileKeepsNullBaselineSoReaderKnowsItIsCreated() throws FileModificationException {
        records.record("e1", "t1", draft("new.txt", null, "+one"));

        assertNull(records.listRecords("e1").getFirst().baseline());
    }

    @Test
    void recordWithoutPathOrDiffIsRejected() {
        assertThrows(FileModificationException.class, () -> records.record("e1", "t1", draft(null, "v1\n", "+v2")));
        assertThrows(FileModificationException.class, () -> records.record("e1", "t1", draft("demo.txt", "v1\n", null)));
        assertTrue(records.listRecords("e1").isEmpty(), "拒绝的记录不得落库");
    }

    @Test
    void recordsAreLookedUpByExecutionAndRecordId() throws FileModificationException {
        Serializable id = records.record("e1", "t1", draft("demo.txt", "v1\n", "+v2"));

        assertTrue(records.getRecord("e1", id).isPresent());
        // 执行分区是硬边界：拿别的执行标识查不到，避免跨会话串记录。
        assertTrue(records.getRecord("e2", id).isEmpty());
    }

    private FileRecord draft(String path, String baseline, String diff) {
        return FileRecord.builder().filePath(path).baseline(baseline).diff(diff).plusLines(1).minusLines(0).build();
    }
}
