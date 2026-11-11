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
import java.util.concurrent.atomic.AtomicReference;

/**
 * 检查点正文文件回收的本机实现。
 *
 * <p><b>四条不可让步的规矩</b>：</p>
 * <ol>
 *   <li><b>只删无引用文件</b>：库内 {@code snapshot_file} 指向的那份正文永不删；</li>
 *   <li><b>在途不删</b>：存储侧的在途登记还在（写入→发布→事务定论之间）就跳过；</li>
 *   <li><b>与读取互斥</b>：删除与 {@link LocalExecutionRepository#findById(String)} 共用
 *       {@link ExecutionCoordination#monitor(String)}，保护「已查到引用、尚未打开文件」的窗口；</li>
 *   <li><b>清空后连目录一起回收</b>：文件名删光后执行目录就是空壳，不回收会随执行轮次无上限堆积；
 *       但只有目录真的空了才删（非空直接失败返回），绝不把「删空目录」写成「删有正文的目录」。</li>
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
    /**
     * 跨调用游标：下一轮从哪个执行目录之后开始枚举。
     *
     * <p><b>为什么需要它</b>：目录总数超过单轮预算时，若每轮都从最小 id 重扫，最大 id 那头的
     * 孤儿文件与 {@code .part} 残留永远轮不到（预算被同一批目录吃光）。游标让每轮接着上次的位置
     * 往后扫；扫到列表末尾就回到开头（置 {@code null}），形成轮转。</p>
     *
     * <p>只是优化到「最终一定覆盖」的加速器：进程重启后从 {@code null} 重新开始，
     * 仍然靠多轮调用收敛，不依赖任何持久化状态。</p>
     */
    private final AtomicReference<String> resumeAfter = new AtomicReference<>();

    @Override
    public boolean deleteFile(String executionId, String fileId) {
        if (executionId == null || executionId.isBlank() || fileId == null) {
            return false;
        }
        synchronized (ExecutionCoordination.monitor(executionId)) {
            boolean deleted = checkpointStore.delete(executionId, fileId);
            // 最后一份正文删掉后，执行目录就成了空壳：立即回收，否则每轮执行都会留下一个空目录。
            checkpointStore.deleteExecutionDirectoryIfEmpty(executionId);
            return deleted;
        }
    }

    @Override
    public boolean deleteExecutionDirectory(String executionId) {
        if (executionId == null || executionId.isBlank()) {
            return false;
        }
        // 与读取/写入共用同一把门闩：删目录时不能有线程正往里发布新文件。
        synchronized (ExecutionCoordination.monitor(executionId)) {
            return checkpointStore.deleteExecutionDirectory(executionId);
        }
    }

    @Override
    public boolean hasUnscannedFiles() {
        return checkpointStore.hasUnscannedFiles();
    }

    @Override
    public FileReclaimResult reclaimUnreferenced(int maxExecutionDirectories, int maxFilesPerExecution) {
        int maxDirectories = Math.clamp(maxExecutionDirectories, 1, 5000);
        int maxFiles = Math.clamp(maxFilesPerExecution, 1, 500);
        int deletedFiles = 0;
        int skipped = 0;
        int deletedDirectories = 0;
        int scanned = 0;
        // 从上一轮停下的地方接着扫，而不是每轮都从最小 id 重来。
        String after = resumeAfter.get();
        boolean reachedEnd = false;
        while (scanned < maxDirectories) {
            int batch = Math.min(MAX_DIRECTORY_BATCH, maxDirectories - scanned);
            List<String> executionIds = checkpointStore.listExecutionIds(after, batch);
            if (executionIds.isEmpty()) {
                // 当前位置之后没有目录了：这一轮就是末尾，下一轮回到开头。
                reachedEnd = true;
                break;
            }
            scanned += executionIds.size();
            after = executionIds.getLast();
            for (String executionId : executionIds) {
                Outcome outcome = reclaimOne(executionId, maxFiles);
                deletedFiles += outcome.deletedFiles();
                skipped += outcome.skippedFiles();
                deletedDirectories += outcome.directoryRemoved() ? 1 : 0;
            }
            if (executionIds.size() < batch) {
                reachedEnd = true;
                break;
            }
        }
        // 本轮扫到列表末尾就把游标回到开头；否则记下位置，下一轮接着往后扫。
        resumeAfter.set(reachedEnd ? null : after);
        if (deletedFiles > 0 || skipped > 0 || deletedDirectories > 0) {
            log.info("回收检查点文件: deletedFiles={}, skippedInFlight={}, deletedDirectories={},"
                            + " scannedDirectories={}, nextAfter={}",
                    deletedFiles, skipped, deletedDirectories, scanned, resumeAfter.get());
        }
        return new FileReclaimResult(deletedFiles, skipped, deletedDirectories);
    }

    /** 单个执行目录的回收结果：删了几个文件、跳过几个在途、是否顺带删掉了空目录。 */
    private record Outcome(int deletedFiles, int skippedFiles, boolean directoryRemoved) { }

    /**
     * 回收单个执行目录里的无引用文件，并在目录清空后把它一起删掉。
     *
     * <p>引用在锁内重读：目录枚举在锁外做过一次粗筛，真正决定「删不删」的引用必须是
     * 加锁后的最新值 —— 否则保存刚提交、引用已换文件时，会把新文件当成旧文件删掉。</p>
     */
    private Outcome reclaimOne(String executionId, int maxFiles) {
        long numericId;
        try {
            numericId = Long.parseLong(executionId);
        } catch (NumberFormatException unsupported) {
            // 目录名不是数字执行标识：不是本实现的产物，一律不碰。
            return new Outcome(0, 0, false);
        }
        synchronized (ExecutionCoordination.monitor(executionId)) {
            List<ExecutionCheckpointStore.CheckpointFile> files = checkpointStore.listFiles(executionId, maxFiles);
            int deleted = 0;
            int skipped = 0;
            if (!files.isEmpty()) {
                String referenced = referencedFileOf(numericId);
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
            }
            // 目录已经空了（本次删完的，或历史上遗留的空目录）就回收；非空时返回 false，不会误删。
            boolean directoryRemoved = checkpointStore.deleteExecutionDirectoryIfEmpty(executionId);
            return new Outcome(deleted, skipped, directoryRemoved);
        }
    }

    /** 锁内读库内权威引用；行不存在或没有文件标识都返回 {@code null}。 */
    private String referencedFileOf(long executionId) {
        Map<Long, String> referenced = executions.findSnapshotFileIds(List.of(executionId));
        return referenced.get(executionId);
    }
}
