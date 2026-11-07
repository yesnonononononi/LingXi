package com.summit.dp.workflow.application.lifecycle;

/**
 * 一次恢复请求：恢复谁、归哪个会话、谁触发的。
 *
 * <p>会话标识单独带着，是因为恢复要在「会话门闩」下进行 —— 上下文回写属于旧轮收尾，
 * 迟到的输入必须等它提交后才能受理新轮。</p>
 */
public final class ResumeRequest {

    private final String executionId;
    private final long sessionId;
    private final ResumeTriggerType triggerType;

    private ResumeRequest(String executionId, long sessionId, ResumeTriggerType triggerType) {
        if (executionId == null || executionId.isBlank()) {
            throw new IllegalArgumentException("恢复请求必须带执行标识");
        }
        if (triggerType == null) {
            throw new IllegalArgumentException("恢复请求必须带触发来源");
        }
        this.executionId = executionId;
        this.sessionId = sessionId;
        this.triggerType = triggerType;
    }

    /** 构造一次恢复请求。 */
    public static ResumeRequest create(String executionId, long sessionId, ResumeTriggerType triggerType) {
        return new ResumeRequest(executionId, sessionId, triggerType);
    }

    public String executionId() {
        return executionId;
    }

    /** 执行归属会话（可能是子会话）。 */
    public long sessionId() {
        return sessionId;
    }

    public ResumeTriggerType triggerType() {
        return triggerType;
    }
}
