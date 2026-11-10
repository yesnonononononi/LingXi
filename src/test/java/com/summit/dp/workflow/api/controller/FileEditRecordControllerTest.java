package com.summit.dp.workflow.api.controller;

import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileHasher;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordStore;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecord;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordRestorer;
import org.junit.jupiter.api.Test;

import java.io.Serializable;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 记录读侧：差异按需返回、超限截断要显式标记、记录不存在明确报错；撤销依赖真实工作空间，
 * 其还原语义由 {@code EditFileToolExecutorMetaDataTest} 覆盖，这里只钉住「取不到记录」的边界。
 */
class FileEditRecordControllerTest {

    @Test
    void diffReturnsRecordedUnifiedDiff() {
        FileRecordManager records = newRecordManager();
        Serializable id = records.record("e1", "t1", draft("@@ -1 +1 @@\n-alpha\n+BETA"));

        FileEditRecordController.FileEditDiff diff =
                controller(records).diff("e1", String.valueOf(id)).getData();

        assertEquals("demo.txt", diff.filePath());
        assertEquals("@@ -1 +1 @@\n-alpha\n+BETA", diff.unifiedDiff());
        assertFalse(diff.truncated());
    }

    @Test
    void oversizedDiffIsTruncatedAndFlagged() {
        FileRecordManager records = newRecordManager();
        Serializable id = records.record("e1", "t1", draft("x".repeat(300 * 1024)));

        FileEditRecordController.FileEditDiff diff =
                controller(records).diff("e1", String.valueOf(id)).getData();

        assertEquals(256 * 1024, diff.unifiedDiff().length());
        assertTrue(diff.truncated());
    }

    @Test
    void unknownRecordIsRejected() {
        FileRecordManager records = newRecordManager();
        FileEditRecordController controller = controller(records);

        assertThrows(ClientException.class, () -> controller.diff("e1", "missing"));
    }

    /**
     * 整轮撤销的会话归属取自轮次本身，因此轮次不存在时必须直接拒绝，
     * 而不是拿客户端传来的 sessionId 去猜工作空间。
     */
    @Test
    void rejectTurnWithoutTurnIsRejected() {
        ChatTurnRepository turns = mock(ChatTurnRepository.class);
        when(turns.findById(404L)).thenReturn(Optional.empty());
        FileEditRecordController controller = new FileEditRecordController(
                newRecordManager(), null, null, null, null, null, turns);

        assertThrows(ClientException.class, () -> controller.rejectTurn(404L));
    }

    private FileEditRecordController controller(FileRecordManager records) {
        // 读差异不触碰会话与工作空间；撤销路径需要真实工作空间，改由集成测试覆盖。
        return new FileEditRecordController(records, null, null, null, null, null, null);
    }

    private FileRecord draft(String diff) {
        return FileRecord.builder().filePath("demo.txt")
                .oldContent("alpha\n").newContent("BETA\n").diff(diff).build();
    }

    private FileRecordManager newRecordManager() {
        DefaultFileHasher hasher = new DefaultFileHasher();
        return new DefaultFileRecordManager(new DefaultFileRecordStore(),
                new FileRecordRestorer(hasher), hasher);
    }
}
