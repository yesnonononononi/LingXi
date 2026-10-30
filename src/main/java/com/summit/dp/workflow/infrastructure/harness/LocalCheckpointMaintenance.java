package com.summit.dp.workflow.infrastructure.harness;

import com.summit.dp.execution.application.port.ExecutionCheckpointMaintenance;
import com.summit.dp.execution.application.port.ExecutionCheckpointStore;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.Map;

/**
 * 检查点正文文件回收的本机实现。
 *
 * <p><b>三条不可让步的规矩</b>：</p>
 * <ol>
 *   <li><b>只删无引用文件</b>：库内 {@code snapshot_file} 指向的那份正文永不删；</li>
 *   <li><b>在途不删</b>：存储侧的在途登记还在（写入→发布→事务定论之间）就跳过；</li>
 *   <li><b>与读取互斥</b>：删除与 {@link LocalExecutionRepository#findById(String)} 共用
 *       {@link ExecutionCoordination#monitor(String)}，保护「已查到引用、尚未打开文件」的窗口。</li>
 * </ol>
 *
 * <p>枚举范围被钉死在 {@code <数据目录>/checkpoints} 之下：只扫一级执行目录，
 * 不读正文，也不碰数据目录里的 images / skill / 配置等其它内容。</p>
 */
@Component
@RequiredArgsConstructor
@Slf4j
public class LocalCheckpointMaintenance implements ExecutionCheckpointMaintenance {

    /** 单次枚举的执行目录批量上限；清理入口自己还会再限一次总扫描量。 */
    private static final int MAX_DIRECTORY_BATCH = 200;

    private final ExecutionCheckpointStore checkpointStore;
    private final ExecutionRepository executions;

    @Override
    public boolean deleteFile(String executionId, String fileId) {
        if (executionId == null || executionId.isBlank() || fileId == null) {
            return false;
        }
        synchronized (ExecutionCoordination.monitor(executionId)) {
            return checkpointStore.delete(executionId, fileId);
        }
    }

    @Override
    public FileReclaimResult reclaimUnreferenced(int maxExecutionDirectories, int maxFilesPerExecution) {
        int maxDirectories = Math.clamp(maxExecutionDirectories, 1, 5000);
        int maxFiles = Math.clamp(maxFilesPerExecution, 1, 500);
        int deleted = 0;
        int skipped = 0;
        int scanned = 0;
        String after = null;
        while (scanned < maxDirectories) {
            int batch = Math.min(MAX_DIRECTORY_BATCH, maxDirectories - scanned);
            List<String> executionIds = checkpointStore.listExecutionIds(after, batch);
            if (executionIds.isEmpty()) {
                break;
            }
            scanned += executionIds.size();
            after = executionIds.getLast();
            for (String executionId : executionIds) {
                int[] outcome = reclaimOne(executionId, maxFiles);
                deleted += outcome[0];
                skipped += outcome[1];
            }
            if (executionIds.size() < batch) {
                break;
            }
        }
        if (deleted > 0 || skipped > 0) {
            log.info("回收检查点文件: deletedFiles={}, skippedInFlight={}, scannedDirectories={}",
                    deleted, skipped, scanned);
        }
        return new FileReclaimResult(deleted, skipped);
    }

    /**
     * 回收单个执行目录里的无引用文件。
     *
     * <p>引用在锁内重读：目录枚举在锁外做过一次粗筛，真正决定「删不删」的引用必须是
     * 加锁后的最新值 —— 否则保存刚提交、引用已换文件时，会把新文件当成旧文件删掉。</p>
     *
     * @return {@code [删除数, 因在途跳过数]}
     */
    private int[] reclaimOne(String executionId, int maxFiles) {
        long numericId;
        try {
            numericId = Long.parseLong(executionId);
        } catch (NumberFormatException unsupported) {
            // 目录名不是数字执行标识：不是本实现的产物，一律不碰。
            return new int[]{0, 0};
        }
        synchronized (ExecutionCoordination.monitor(executionId)) {
            List<ExecutionCheckpointStore.CheckpointFile> files = checkpointStore.listFiles(executionId, maxFiles);
            if (files.isEmpty()) {
                return new int[]{0, 0};
            }
            String referenced = referencedFileOf(numericId);
            int deleted = 0;
            int skipped = 0;
            for (ExecutionCheckpointStore.CheckpointFile file : files) {
                if (!file.temporary() && file.fileId().equals(referenced)) {
                    // 库内权威引用：正在被读取/恢复的那一份，绝不删。
                    continue;
                }
                if (checkpointStore.isInFlight(executionId, file.fileId())) {
                    skipped++;
                    continue;
                }
                if (checkpointStore.deleteFile(file)) {
                    deleted++;
                }
            }
            return new int[]{deleted, skipped};
        }
    }

    /** 锁内读库内权威引用；行不存在或没有文件标识都返回 {@code null}。 */
    private String referencedFileOf(long executionId) {
        Map<Long, String> referenced = executions.findSnapshotFileIds(List.of(executionId));
        return referenced.get(executionId);
    }
}
