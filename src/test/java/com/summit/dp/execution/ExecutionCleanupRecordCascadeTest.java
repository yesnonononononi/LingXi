package com.summit.dp.execution;

import com.summit.dp.execution.application.port.AssetOrphanMaintenance;
import com.summit.dp.execution.application.port.ExecutionCheckpointMaintenance;
import com.summit.dp.execution.application.port.FileRecordMaintenance;
import com.summit.dp.execution.application.service.ExecutionCleanupService;
import com.summit.dp.execution.application.service.ExecutionReclaimService;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.execution.support.NoAssetOrphans;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 执行行被回收时，它名下的文件编辑记录与基线目录必须同时走。
 *
 * <p>只靠 15 天 TTL 兜的话，「会话还在、执行被单独回收」这条路径上的基线会白占磁盘半个月；
 * 而记录本身已经不挂在任何执行上（{@code file_record} 只按 {@code execution_id} 归属），
 * 既展示不出来也没法重放。</p>
 */
class ExecutionCleanupRecordCascadeTest {

    private final ExecutionRepository repository = mock(ExecutionRepository.class);
    private final ExecutionReclaimService reclaimer = mock(ExecutionReclaimService.class);
    private final ExecutionCheckpointMaintenance checkpoints = mock(ExecutionCheckpointMaintenance.class);
    private final FileRecordMaintenance fileRecords = mock(FileRecordMaintenance.class);

    @Test
    void reclaimedExecutionTakesItsFileRecordsWithIt() {
        Execution candidate = execution(101L);
        when(repository.findReclaimable(anyLong(), anyInt())).thenReturn(List.of(candidate));
        when(reclaimer.reclaim(candidate)).thenReturn(true);
        when(repository.countReclaimable()).thenReturn(0L);
        stubFileScan();

        cleanupService().cleanup();

        verify(fileRecords).deleteByExecutionIds(List.of("101"));
    }

    /** 没删掉的执行行不能顺手带走记录：它还要重放，基线是重放的起点。 */
    @Test
    void keptExecutionKeepsItsFileRecords() {
        Execution candidate = execution(101L);
        when(repository.findReclaimable(anyLong(), anyInt())).thenReturn(List.of(candidate));
        when(reclaimer.reclaim(candidate)).thenReturn(false);
        when(repository.countReclaimable()).thenReturn(0L);
        stubFileScan();

        cleanupService().cleanup();

        verify(fileRecords, never()).deleteByExecutionIds(any());
    }

    private void stubFileScan() {
        when(checkpoints.reclaimUnreferenced(anyInt(), anyInt()))
                .thenReturn(new ExecutionCheckpointMaintenance.FileReclaimResult(0, 0, 0));
    }

    private ExecutionCleanupService cleanupService() {
        AssetOrphanMaintenance orphans = new NoAssetOrphans();
        return new ExecutionCleanupService(repository, reclaimer, checkpoints, fileRecords, orphans);
    }

    private static Execution execution(Long id) {
        Execution execution = new Execution();
        execution.setId(id);
        execution.setStatus(ExecutionStatusCodes.COMPLETED);
        return execution;
    }
}
