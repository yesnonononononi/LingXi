package com.summit.dp.workflow.api.controller;

import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.api.request.RollbackFilesRequest;
import com.summit.dp.workflow.application.filerecord.FileEditDiff;
import com.summit.dp.workflow.application.filerecord.FileEditSceneScope;
import com.summit.dp.workflow.application.filerecord.FileRollbackItem;
import com.summit.dp.workflow.application.filerecord.FileRollbackPlan;
import com.summit.dp.workflow.application.filerecord.FileRollbackResult;
import com.summit.dp.workflow.application.filerecord.FileRollbackService;
import com.summit.dp.workflow.application.filerecord.TurnFileEditSummaryService;
import com.summit.dp.workflow.application.projection.TurnViewBroadcaster;
import com.summit.dp.workflow.infrastructure.tools.file.edit.EditDiffer;
import com.summit.dp.workflow.infrastructure.tools.file.record.*;
import org.junit.jupiter.api.Test;

import java.io.Serializable;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 记录读侧接口：只做转发，差异内容与截断口径由应用层决定。
 *
 * <p>回滚是写文件的，但它同样是「转发」：计划与逐文件结果都由 {@code FileRollbackService} 决定，
 * 所以这里也不模拟文件系统。</p>
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

    @Test
    void rollbackEndpointsForwardToTheService() {
        FileRollbackService rollbacks = mock(FileRollbackService.class);
        FileRollbackPlan plan = new FileRollbackPlan("e1", List.of(FileRollbackItem.skip("/x.txt", "原因", "r1")));
        FileRollbackResult result = new FileRollbackResult("e1", List.of());
        when(rollbacks.preview(9L)).thenReturn(plan);
        when(rollbacks.rollback(9L, List.of("/x.txt"))).thenReturn(result);
        when(rollbacks.rollback(9L, null)).thenReturn(result);
        FileEditRecordController controller = this.controller(newRecordManager(),
                mock(FileEditSceneScope.class), rollbacks);

        assertEquals(plan, controller.previewRollback(9L).getData());
        assertEquals(result, controller.rollback(9L, new RollbackFilesRequest(List.of("/x.txt"))).getData());
        // 空 body 不该炸在控制器里：把 null 原样交给应用层，由它给出业务文案。
        assertEquals(result, controller.rollback(9L, null).getData());
    }

    /** 回滚成功后重推一帧轮次视图，清单上的「已回滚」标记才不用前端自己发请求补。 */
    @Test
    void rollbackRebroadcastsTheTurnView() {
        FileRollbackService rollbacks = mock(FileRollbackService.class);
        when(rollbacks.rollback(9L, List.of("/x.txt"))).thenReturn(new FileRollbackResult("e1", List.of()));
        TurnViewBroadcaster turnViews = mock(TurnViewBroadcaster.class);
        FileEditRecordController controller = this.controller(newRecordManager(),
                mock(FileEditSceneScope.class), rollbacks, turnViews);

        controller.rollback(9L, new RollbackFilesRequest(List.of("/x.txt")));

        verify(turnViews).broadcastSnapshotForExecution("9");
    }

    private final Differ differ = new EditDiffer();

    private FileEditRecordController controller(FileRecordManager records) {
        return controller(records, mock(FileEditSceneScope.class));
    }

    private FileEditRecordController controller(FileRecordManager records, FileEditSceneScope scenes) {
        return this.controller(records, scenes, mock(FileRollbackService.class));
    }

    private FileEditRecordController controller(FileRecordManager records, FileEditSceneScope scenes,
                                                FileRollbackService rollbacks) {
        return this.controller(records, scenes, rollbacks, mock(TurnViewBroadcaster.class));
    }

    private FileEditRecordController controller(FileRecordManager records, FileEditSceneScope scenes,
                                                FileRollbackService rollbacks, TurnViewBroadcaster turnViews) {
        TurnFileEditSummaryService turnEdits =
                new TurnFileEditSummaryService(records, mock(ChatTurnRepository.class), scenes, differ);
        return new FileEditRecordController(turnEdits, rollbacks, turnViews);
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

