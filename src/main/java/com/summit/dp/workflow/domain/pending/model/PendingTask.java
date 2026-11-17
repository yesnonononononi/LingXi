package com.summit.dp.workflow.domain.pending.model;

import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.shared.exception.ClientException;

import java.time.Instant;
import java.util.List;

/**
 * 待发送任务：排队消息的唯一权威事实。
 *
 * <p>状态迁移只在这里发生；调用方（应用层）负责锁与事务，领域对象只保证「迁到非法状态会报错」。</p>
 */
public class PendingTask {
    /** 失败原因会展示给用户，长度与列宽一致，超长截断在写库前完成。 */
    public static final int MAX_FAILURE_LENGTH = 500;

    private final Long id;
    private final long sessionId;
    private String input;
    private List<PendingAttachment> attachments;
    private final Long modelId;
    private final Long agentId;
    private final Long workspaceId;
    private final boolean requirePlan;
    private PendingTaskStatus status;
    private String failure;
    private final Instant createdAt;
    private Instant updatedAt;

    private PendingTask(Long id, long sessionId, String input, List<PendingAttachment> attachments,
                        Long modelId, Long agentId, Long workspaceId, boolean requirePlan,
                        PendingTaskStatus status, String failure, Instant createdAt, Instant updatedAt) {
        this.id = id;
        this.sessionId = sessionId;
        this.input = input;
        this.attachments = List.copyOf(attachments == null ? List.of() : attachments);
        this.modelId = modelId;
        this.agentId = agentId;
        this.workspaceId = workspaceId;
        this.requirePlan = requirePlan;
        this.status = status;
        this.failure = failure;
        this.createdAt = createdAt;
        this.updatedAt = updatedAt;
    }

    /** 入队：本进程受理的新任务，立即可派发。 */
    public static PendingTask enqueue(long id, long sessionId, String input, List<PendingAttachment> attachments,
                                      Long modelId, Long agentId, Long workspaceId, boolean requirePlan,
                                      Instant now) {
        requireEditableInput(input);
        return new PendingTask(id, sessionId, input, attachments, modelId, agentId, workspaceId,
                requirePlan, PendingTaskStatus.PENDING, null, now, now);
    }

    /** 仓储装配：库里的行原样还原，不做二次校验（历史行可能来自更早的规则）。 */
    public static PendingTask restore(Long id, long sessionId, String input, List<PendingAttachment> attachments,
                                      Long modelId, Long agentId, Long workspaceId, boolean requirePlan,
                                      PendingTaskStatus status, String failure, Instant createdAt, Instant updatedAt) {
        return new PendingTask(id, sessionId, input, attachments, modelId, agentId, workspaceId,
                requirePlan, status, failure, createdAt, updatedAt);
    }

    /** 原地修改文本；附件替换由 {@link #changeAttachments} 负责，两步各自可独立调用。 */
    public void changeInput(String input, Instant now) {
        requireEditableInput(input);
        this.input = input;
        this.updatedAt = now;
    }

    /** 整笔替换附件集合；交并（保留哪些、删哪些文件）由应用层算完再传进来。 */
    public void changeAttachments(List<PendingAttachment> attachments, Instant now) {
        this.attachments = List.copyOf(attachments == null ? List.of() : attachments);
        this.updatedAt = now;
    }

    /** 派发失败：停在原地等用户处理，原因要能跨重启展示。 */
    public void fail(String reason, Instant now) {
        this.status = PendingTaskStatus.PAUSED;
        String text = reason == null || reason.isBlank() ? "发送失败" : reason;
        this.failure = text.length() > MAX_FAILURE_LENGTH ? text.substring(0, MAX_FAILURE_LENGTH) : text;
        this.updatedAt = now;
    }

    /** 用户确认继续：回到 PENDING，派发流程会重新捡起它。 */
    public void resume(Instant now) {
        throwIf(status == PendingTaskStatus.PENDING, "该消息已在等待发送");
        this.status = PendingTaskStatus.PENDING;
        this.failure = null;
        this.updatedAt = now;
    }

    /** 启动时把上次进程遗留的任务标成待确认：它们不得被自动派发。 */
    public void markAwaitingConfirm(Instant now) {
        this.status = PendingTaskStatus.AWAITING_CONFIRM;
        this.updatedAt = now;
    }

    /** 会话被停止：队头任务暂停，整队随之停摆（派发严格按 id 升序）。 */
    public void pause(String reason, Instant now) {
        if (status != PendingTaskStatus.PENDING) {
            return;
        }
        fail(reason, now);
    }

    public boolean dispatchable() {
        return status == PendingTaskStatus.PENDING;
    }

    private static void requireEditableInput(String input) {
        throwIf(input == null || input.isBlank(), "待发送内容不能为空");
        throwIf(input.length() > SessionMessage.MAX_INPUT_LENGTH,
                "待发送内容最多支持 " + SessionMessage.MAX_INPUT_LENGTH + " 个字符");
    }

    private static void throwIf(boolean condition, String err) {
        if (condition) {
            throw new ClientException(err);
        }
    }

    public Long getId() {
        return id;
    }

    public long getSessionId() {
        return sessionId;
    }

    public String getInput() {
        return input;
    }

    public List<PendingAttachment> getAttachments() {
        return attachments;
    }

    public Long getModelId() {
        return modelId;
    }

    public Long getAgentId() {
        return agentId;
    }

    public Long getWorkspaceId() {
        return workspaceId;
    }

    public boolean isRequirePlan() {
        return requirePlan;
    }

    public PendingTaskStatus getStatus() {
        return status;
    }

    public String getFailure() {
        return failure;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }
}
