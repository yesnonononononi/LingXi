package com.summit.dp.execution.domain.model;

import com.summit.dp.execution.ExecutionStatusCodes;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 执行领域模型。
 *
 * <p>请求参数与执行元状态由 snapshot 承载；本地模式下 worker 归属、租约与控制指令
 * 由框架进程内注册表承担，不落库。</p>
 *
 * <p>摘要字段（startedAt / completedAt）是查询用的冗余列：
 * 只由 {@code findSummariesByIds} 这类**不含 snapshot 的投影查询**填充。
 * 模型与 token 不再是本表的列 —— 它们是业务事实，权威在 {@code chat_turn}。</p>
 */
@Data
public class Execution {
    private Long id;
    private Long version = 1L;

    private Long sessionId;
    /** 执行首次开始时间；暂停恢复不重置。 */
    private LocalDateTime startedAt;
    /** 进入终态的时间；未结束为 null。 */
    private LocalDateTime completedAt;
    private Integer status;
    /**
     * 恢复代际；执行实际转入 SUSPENDED 时递增。恢复任务按它判过期。
     *
     * <p>只由摘要查询填充，{@code snapshotFile} 路径不携带 —— 它是业务持久化列而非框架字段。</p>
     */
    private Long resumeGeneration;
    /**
     * 检查点正文的文件标识（不是正文）。
     *
     * <p>正文在 {@code <数据目录>/checkpoints/<executionId>/<snapshotFile>.json}，
     * 本字段是数据库里的权威引用；读取一律先取它再打开文件，没有应用级正文缓存。</p>
     */
    private String snapshotFile;
    private LocalDateTime createdAt;
    private LocalDateTime updatedAt;

    /**
     * 是否还有「状态已提交、业务收口未做完」的待办事实：1 待收口，0 已收口。
     *
     * <p>与 {@code status} 由同一条 UPDATE 写入 —— 写成终态即置 1，收口脚本成功后再清 0。
     * 启动巡检按这一列找活，不看任何检查点属性标记（那份内存状态在崩溃窗口里根本来不及落库）。</p>
     */
    private Integer closurePending;

    /** 会话归属只能从数据库恢复，检查点请求不能覆盖它。 */
    public static Execution restoreCheckpointSummary(Long id, Long version, Integer status, Long generation,
                                                     Long sessionId, String snapshotFile) {
        Execution execution = new Execution();
        execution.id = id;
        execution.sessionId = sessionId;
        execution.version = version == null ? 1L : version;
        execution.status = status;
        execution.resumeGeneration = generation;
        execution.snapshotFile = snapshotFile;
        return execution;
    }

    /** 同 {@link #restoreCheckpointSummary}，额外带上「是否待收口」。 */
    public static Execution restoreCheckpointSummary(Long id, Long version, Integer status, Long generation,
                                                     Long sessionId, String snapshotFile, Integer closurePending) {
        Execution execution = restoreCheckpointSummary(id, version, status, generation, sessionId, snapshotFile);
        execution.closurePending = closurePending;
        return execution;
    }

    public static Execution createCheckpoint(long id, long sessionId, int status, String snapshotFile,
                                             LocalDateTime createdAt, LocalDateTime startedAt,
                                             LocalDateTime completedAt) {
        Execution execution = new Execution();
        execution.id = id;
        execution.sessionId = sessionId;
        execution.status = status;
        execution.snapshotFile = snapshotFile;
        execution.createdAt = createdAt;
        execution.startedAt = startedAt;
        execution.completedAt = completedAt;
        execution.closurePending = ExecutionStatusCodes.isTerminal(status) ? 1 : 0;
        return execution;
    }

    /** 同态挂起保存不产生新代际，已终结的执行不能被旧检查点重新开放。 */
    public void changeCheckpoint(int nextStatus, String snapshotFile, LocalDateTime startedAt,
                                 LocalDateTime completedAt) {
        if (ExecutionStatusCodes.isTerminal(status) && status != nextStatus) {
            throw new IllegalStateException("执行已结束，不能覆盖为运行状态: executionId=" + id);
        }
        long generation = resumeGeneration == null ? 0L : resumeGeneration;
        if (nextStatus == ExecutionStatusCodes.SUSPENDED && !ExecutionStatusCodes.isSuspended(status)) {
            generation++;
        }
        Integer previousStatus = status;
        this.resumeGeneration = generation;
        this.status = nextStatus;
        this.snapshotFile = snapshotFile;
        if (startedAt != null) this.startedAt = startedAt;
        if (completedAt != null) this.completedAt = completedAt;
        applyClosurePending(previousStatus, nextStatus);
    }

    /**
     * 「写成终态 ⇔ 有待收口的活」必须由同一条 UPDATE 写入，否则会出现「已终结但没人知道要收口」的行。
     *
     * <p>已经终态的行再次写终态（框架重复落库）时保留原有待办事实：已收口的行不能被重新标成待收口，
     * 未收口的行也不能因为一次重复保存就丢掉重试机会。</p>
     */
    private void applyClosurePending(Integer previousStatus, int nextStatus) {
        if (!ExecutionStatusCodes.isTerminal(nextStatus)) {
            this.closurePending = 0;
        } else if (!ExecutionStatusCodes.isTerminal(previousStatus)) {
            this.closurePending = 1;
        } else if (closurePending == null) {
            // 摘要没带这一列时的安全默认：宁可多补一次（脚本幂等），不可漏一次。
            this.closurePending = 1;
        }
    }

    public void acceptPersistedVersion(long persistedVersion) { this.version = persistedVersion; }
}
