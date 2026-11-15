package com.summit.dp.workflow.application.filerecord;

import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.infrastructure.tools.file.record.BaselineFileStore;
import com.summit.dp.workflow.infrastructure.tools.file.record.FileRecordManager;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * 按基线回填：本模块唯一的写文件路径。
 *
 * <p><b>顺序不能动</b>：先算完整计划（只读，全部门禁跑完），再逐文件备份 + 回填。边算边写会让
 * 「一半文件已回填、另一半被拒」变成一个谁也解释不了的中间态。</p>
 *
 * <p><b>只认计划里的路径</b>：调用方传来的确认清单只能从计划里挑，不能自带路径 —— 否则这个接口
 * 就成了「按任意绝对路径写盘」。</p>
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class FileRollbackService {

    private final FileRollbackPlanner planner;
    private final RollbackFileAccess files;
    private final BaselineFileStore backups;
    private final FileRecordManager records;

    /** 只读预览：回滚前必须先让用户看清「会改哪些、跳过哪些、为什么」。 */
    public FileRollbackPlan preview(long executionId) {
        return this.planner.plan(executionId);
    }

    /**
     * 执行回滚。
     *
     * @param executionId    执行标识
     * @param confirmedPaths 用户在预览里确认过的绝对路径（必须来自 {@link #preview}）
     * @return 逐文件结果；单个失败不影响其它文件
     */
    public FileRollbackResult rollback(long executionId, List<String> confirmedPaths) {
        FileRollbackPlan plan = this.planner.plan(executionId);
        Set<String> confirmed = confirmedPaths == null ? Set.of() : new LinkedHashSet<>(confirmedPaths);
        this.throwIf(confirmed.isEmpty(), "请先确认要回滚的文件");
        this.throwIf(!plan.hasAction(), this.noActionResult(plan));

        List<FileRollbackOutcome> outcomes = new ArrayList<>();
        for (FileRollbackItem item : plan.actionable()) {
            if (confirmed.contains(item.filePath())) {
                outcomes.add(this.apply(plan.executionId(), item));
            }
        }
        this.throwIf(outcomes.isEmpty(), "确认的文件都不在可回滚范围内，请重新预览");
        this.markRolledBack(plan.executionId(), outcomes);
        log.info("按基线回滚文件: executionId={}, requested={}, applied={}, failed={}",
                executionId, confirmed.size(), outcomes.size(), outcomes.stream()
                        .filter(outcome -> !outcome.success()).count());
        return new FileRollbackResult(plan.executionId(), outcomes);
    }

    /**
     * 只给真正写成功的文件打标记。
     *
     * <p>失败的文件没被改动，标上就等于把「还有机会重试」永久关掉；标记失败也不回退已写入的内容
     * —— 文件已经回到基线了，那是用户要的结果，标记只是让下次预览别再重复列出来。</p>
     */
    private void markRolledBack(String executionId, List<FileRollbackOutcome> outcomes) {
        List<String> done = outcomes.stream()
                .filter(FileRollbackOutcome::success)
                .map(FileRollbackOutcome::filePath)
                .toList();
        if (done.isEmpty()) {
            return;
        }
        try {
            this.records.markRolledBack(executionId, done, Instant.now());
        } catch (RuntimeException failure) {
            log.warn("标记文件已回滚失败: executionId={}, files={}, reason={}",
                    executionId, done.size(), failure.getMessage());
        }
    }

    /**
     * 单个文件：先备份当前内容，再覆盖或删除。
     *
     * <p>备份在写之前，且失败就整条放弃 —— 没有备份的回填等于把用户唯一的那份内容也弄丢。
     * 单个文件失败不中断其余文件，结果逐条交回。</p>
     */
    private FileRollbackOutcome apply(String executionId, FileRollbackItem item) {
        String backupPath = null;
        try {
            Optional<String> current = this.files.read(item.filePath());
            if (current.isEmpty()) {
                return FileRollbackOutcome.failed(item.filePath(), item.action(), "文件读不出来，未做任何改动", null);
            }
            backupPath = this.backups.writeBackup(executionId, item.recordId(), current.get());
            if (item.action() == FileRollbackAction.RESTORE) {
                this.files.write(item.filePath(), item.baseline());
            } else {
                this.files.delete(item.filePath());
            }
            return FileRollbackOutcome.done(item.filePath(), item.action(), backupPath);
        } catch (RuntimeException failure) {
            log.warn("回滚单个文件失败: filePath={}, action={}, reason={}",
                    item.filePath(), item.action(), failure.getMessage());
            return FileRollbackOutcome.failed(item.filePath(), item.action(), failure.getMessage(), backupPath);
        }
    }

    /** 没有可动手的文件时，把跳过原因摊开给用户：一句「没有可回滚的」等于什么都没说。 */
    private String noActionResult(FileRollbackPlan plan) {
        long skipped = plan.items().stream().filter(item -> !item.actionable()).count();
        return "这次执行没有可回滚的文件（共 " + plan.items().size() + " 个文件，跳过 " + skipped + " 个）";
    }

    private void throwIf(boolean condition, String err) {
        if (condition) throw new ClientException(err);
    }
}
