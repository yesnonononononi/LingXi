package com.summit.dp.workflow.api.controller;

import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.application.filerecord.FileEditDiff;
import com.summit.dp.workflow.application.filerecord.FileEditSceneScope;
import com.summit.dp.workflow.application.filerecord.TurnFileEditSummaryService;
import com.summit.dp.workflow.infrastructure.tools.file.edit.EditDiffer;
import com.summit.dp.workflow.infrastructure.tools.file.record.ContentDigest;
import com.summit.dp.workflow.infrastructure.tools.file.record.DefaultFileRecordManager;
import com.summit.dp.workflow.infrastructure.tools.file.record.InMemoryFileRecordStore;
import com.summit.dp.workflow.infrastructure.tools.file.record.DiffResult;
import com.summit.dp.workflow.infrastructure.tools.file.record.Differ;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecord;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordManager;
import org.junit.jupiter.api.Test;

import java.io.Serializable;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 记录读侧接口：只做转发，差异内容与截断口径由应用层决定。
 *
 * <p>本类没有写接口（撤销整体暂缓），所以这里也不该有任何「还原文件」的断言 ——
 * 一个读不脏文件的面，不需要在这里模拟文件。</p>
 */
class FileEditRecordControllerTest {

    private static final String BASELINE = "alpha\n";
    private static final String UPDATED = "BETA\n";

    @Test
    void diffForwardsTheAccumulatedUnifiedDiff() {
        FileRecordManager records = newRecordManager();
        Serializable id = records.record("e1", "t1", draft(BASELINE, UPDATED));

        FileEditDiff diff = controller(records).diff("e1", String.valueOf(id)).getData();

        assertEquals("demo.txt", diff.filePath());
        // 累计差异 = 基线 → 该条记录末态，重算出来的 hunk 必须真的表达这次改动。
        assertTrue(diff.unifiedDiff().contains("-alpha"), diff.unifiedDiff());
        assertTrue(diff.unifiedDiff().contains("+BETA"), diff.unifiedDiff());
        assertFalse(diff.truncated());
    }

    @Test
    void unknownRecordIsRejected() {
        assertThrows(ClientException.class, () -> controller(newRecordManager()).diff("e1", "missing"));
    }

    /** 按文件名取最新：定位由作用域解析，控制器只转发路径与业务结果。 */
    @Test
    void latestForwardsTheNewestDiffOfThatFile() {
        FileRecordManager records = newRecordManager();
        records.record("e1", "t1", draft(BASELINE, UPDATED));
        FileEditSceneScope scenes = mock(FileEditSceneScope.class);
        when(scenes.resolveSceneTurnIds(5L)).thenReturn(List.of("t1"));

        FileEditDiff diff = controller(records, scenes).latest(5L, "demo.txt").getData();

        assertEquals("demo.txt", diff.filePath());
        assertTrue(diff.unifiedDiff().contains("+BETA"), diff.unifiedDiff());
        assertEquals("e1", diff.executionId(), "定位回给前端，用来判断「最新是否就是当前这条」");
    }

    @Test
    void latestWithoutAnyRecordIsRejected() {
        FileEditSceneScope scenes = mock(FileEditSceneScope.class);
        when(scenes.resolveSceneTurnIds(5L)).thenReturn(List.of("t1"));

        assertThrows(ClientException.class,
                () -> controller(newRecordManager(), scenes).latest(5L, "never-touched.txt"));
    }

    private final Differ differ = new EditDiffer();

    private FileEditRecordController controller(FileRecordManager records) {
        return controller(records, mock(FileEditSceneScope.class));
    }

    private FileEditRecordController controller(FileRecordManager records, FileEditSceneScope scenes) {
        TurnFileEditSummaryService turnEdits =
                new TurnFileEditSummaryService(records, mock(ChatTurnRepository.class), scenes, differ);
        return new FileEditRecordController(turnEdits);
    }

    /** 差异由真实 differ 生成，避免手搓的 hunk 头与实际内容行数对不上；摘要按改完的全文算。 */
    private FileRecord draft(String baseline, String newContent) {
        DiffResult diff = differ.diff("demo.txt", baseline, newContent);
        return FileRecord.builder().filePath("demo.txt").baseline(baseline)
                .diff(diff.unifiedDiff()).plusLines(diff.plusLines()).minusLines(diff.minusLines())
                .contentDigest(ContentDigest.compute(newContent)).build();
    }

    private FileRecordManager newRecordManager() {
        return new DefaultFileRecordManager(new InMemoryFileRecordStore());
    }
}

