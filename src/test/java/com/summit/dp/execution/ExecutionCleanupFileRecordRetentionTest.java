package com.summit.dp.execution;

import com.summit.dp.execution.application.port.ExecutionCheckpointMaintenance;
import com.summit.dp.execution.application.service.ExecutionCleanupService;
import com.summit.dp.execution.application.service.ExecutionReclaimService;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 文件编辑记录的淘汰口径：<b>15 天</b>，且与「有没有可回收的执行行」无关。
 *
 * <p>这两点都必须钉住。保留期写错（比如写成 15 小时或 15 个月）不会有任何报错，只会让基线
 * 要么太早消失、要么无限占盘；而把回收挂在执行行回收之后，会出现「没有可回收执行时基线永不清理」
 * —— 那正是「表只增不减」的形态。</p>
 */
class ExecutionCleanupFileRecordRetentionTest {

    private static final Duration RETENTION = Duration.ofDays(15);

    private final ExecutionRepository repository = mock(ExecutionRepository.class);
    private final ExecutionReclaimService reclaimer = mock(ExecutionReclaimService.class);
    private final ExecutionCheckpointMaintenance checkpoints = mock(ExecutionCheckpointMaintenance.class);
    private final AtomicReference<Instant> cutoffSeen = new AtomicReference<>();

    @Test
    void purgesFileRecordsOlderThanFifteenDaysEvenWhenNothingElseIsReclaimable() {
        when(repository.findReclaimable(anyLong(), anyInt())).thenReturn(List.of());
        when(repository.countReclaimable()).thenReturn(0L);
        when(checkpoints.reclaimUnreferenced(anyInt(), anyInt()))
                .thenReturn(new ExecutionCheckpointMaintenance.FileReclaimResult(0, 0, 0));
        ExecutionCleanupService service = new ExecutionCleanupService(repository, reclaimer, checkpoints, cutoff -> {
            cutoffSeen.set(cutoff);
            return 4;
        });

        Instant before = Instant.now();
        service.cleanup();

        Instant cutoff = cutoffSeen.get();
        assertNotNull(cutoff, "清理必须顺手回收过期文件编辑记录，不能挂在别的前置条件上");
        Instant expected = before.minus(RETENTION);
        assertTrue(Math.abs(Duration.between(expected, cutoff).toSeconds()) < 60,
                "保留期必须是 15 天，实际 cutoff=" + cutoff);
        assertEquals(0L, service.preview().executionCount());
    }
}
