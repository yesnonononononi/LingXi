package com.summit.dp.workflow.api.controller;

import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.application.filerecord.TurnFileEditSummaryService;
import com.summit.dp.workflow.infrastructure.tools.file.edit.EditDiffer;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordStore;
import com.summit.dp.workflow.infrastructure.tools.file.record.DiffResult;
import com.summit.dp.workflow.infrastructure.tools.file.record.Differ;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecord;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordManager;
import org.junit.jupiter.api.Test;

import java.io.Serializable;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

/**
 * 记录读侧：差异按需返回、超限截断要显式标记、记录不存在明确报错。
 *
 * <p>本类没有写接口（撤销整体暂缓），所以这里也不该有任何「还原文件」的断言 ——
 * 一个读不脏文件的面，不需要在这里模拟文件。</p>
 */
class FileEditRecordControllerTest {

    private static final String BASELINE = "alpha\n";
    private static final String UPDATED = "BETA\n";

    @Test
    void diffReturnsAccumulatedUnifiedDiff() {
        FileRecordManager records = newRecordManager();
        Serializable id = records.record("e1", "t1", draft(BASELINE, UPDATED));

        FileEditRecordController.FileEditDiff diff =
                controller(records).diff("e1", String.valueOf(id)).getData();

        assertEquals("demo.txt", diff.filePath());
        // 累计差异 = 基线 → 该条记录末态，重算出来的 hunk 必须真的表达这次改动。
        assertTrue(diff.unifiedDiff().contains("-alpha"), diff.unifiedDiff());
        assertTrue(diff.unifiedDiff().contains("+BETA"), diff.unifiedDiff());
        assertFalse(diff.truncated());
    }

    @Test
    void oversizedDiffIsTruncatedAndFlagged() {
        FileRecordManager records = newRecordManager();
        Serializable id = records.record("e1", "t1", draft(BASELINE, "x".repeat(300 * 1024) + "\n"));

        FileEditRecordController.FileEditDiff diff =
                controller(records).diff("e1", String.valueOf(id)).getData();

        assertEquals(256 * 1024, diff.unifiedDiff().length());
        assertTrue(diff.truncated());
    }

    @Test
    void unknownRecordIsRejected() {
        assertThrows(ClientException.class, () -> controller(newRecordManager()).diff("e1", "missing"));
    }

    private final Differ differ = new EditDiffer();

    private FileEditRecordController controller(FileRecordManager records) {
        TurnFileEditSummaryService turnEdits =
                new TurnFileEditSummaryService(records, mock(ChatTurnRepository.class), differ);
        return new FileEditRecordController(records, turnEdits);
    }

    /** 差异由真实 differ 生成，避免手搓的 hunk 头与实际内容行数对不上。 */
    private FileRecord draft(String baseline, String newContent) {
        DiffResult diff = differ.diff("demo.txt", baseline, newContent);
        return FileRecord.builder().filePath("demo.txt").baseline(baseline)
                .diff(diff.unifiedDiff()).plusLines(diff.plusLines()).minusLines(diff.minusLines()).build();
    }

    private FileRecordManager newRecordManager() {
        return new DefaultFileRecordManager(new DefaultFileRecordStore());
    }
}

