package com.summit.dp.execution;

import com.summit.dp.execution.application.port.ExecutionCheckpointMaintenance;
import com.summit.dp.execution.application.port.FileRecordMaintenance;
import com.summit.dp.execution.application.service.ExecutionCleanupService;
import com.summit.dp.execution.application.service.ExecutionReclaimService;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.execution.support.NoAssetOrphans;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
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
        ExecutionCleanupService service = new ExecutionCleanupService(repository, reclaimer, checkpoints,
                new RecordingFileRecords(cutoffSeen, 4), new NoAssetOrphans());

        Instant before = Instant.now();
        service.cleanup();

        Instant cutoff = cutoffSeen.get();
        assertNotNull(cutoff, "清理必须顺手回收过期文件编辑记录，不能挂在别的前置条件上");
        Instant expected = before.minus(RETENTION);
        assertTrue(Math.abs(Duration.between(expected, cutoff).toSeconds()) < 60,
                "保留期必须是 15 天，实际 cutoff=" + cutoff);
        assertEquals(0L, service.preview().executionCount());
    }

    /**
     * 预览与清理必须用同一个水位，且预览要如实报出「本次会删多少条过期记录」。
     *
     * <p>这条守的是「预览说没啥可清、点一下却删了东西」那个缺口：过期记录与执行行无关，
     * 不报出来，界面上看到的数字就是假的。</p>
     */
    @Test
    void previewReportsExpiredFileRecordsWithTheSameCutoff() {
        when(repository.countReclaimable()).thenReturn(0L);
        when(checkpoints.hasUnscannedFiles()).thenReturn(false);
        AtomicReference<Instant> previewCutoff = new AtomicReference<>();
        ExecutionCleanupService service = new ExecutionCleanupService(repository, reclaimer, checkpoints,
                new RecordingFileRecords(previewCutoff, 0), new NoAssetOrphans());

        Instant before = Instant.now();
        ExecutionCleanupService.Preview preview = service.preview();

        assertEquals(0L, preview.executionCount());
        assertFalse(preview.filesNeedScan());
        assertEquals(7L, preview.expiredFileRecordCount(), "过期记录条数必须进预览，不能只在清理时才知道");
        Instant expected = before.minus(RETENTION);
        assertTrue(Math.abs(Duration.between(expected, previewCutoff.get()).toSeconds()) < 60,
                "预览必须与清理同口径（15 天），实际 cutoff=" + previewCutoff.get());
    }

    /** 记录侧端口的最小替身：只为观察 cutoff 与固定条数，不碰真实存储。 */
    private record RecordingFileRecords(AtomicReference<Instant> cutoffSeen, long expired) implements FileRecordMaintenance {

        @Override
        public long countBefore(Instant cutoff) {
            this.cutoffSeen.set(cutoff);
            return 7L;
        }

        @Override
        public int purgeBefore(Instant cutoff) {
            this.cutoffSeen.set(cutoff);
            return (int) this.expired;
        }

        @Override
        public int deleteByExecutionIds(Collection<String> executionIds) {
            return 0;
        }
    }
}
