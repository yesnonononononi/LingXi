package com.summit.dp.task.domain.model;

import com.summit.dp.shared.exception.ClientException;
import lombok.Builder;
import lombok.Getter;
import java.time.Instant;

/** 任务终态只落一次，避免停止与自然退出相互覆盖。 */
@Getter
@Builder
public class Task {
    public static final int MAX_OUTPUT = 50_000;
    public static final int MAX_INTENTION = 500;
    public enum TaskStatus {
        PENDING, RUNNING, FAILED, SUCCESS, TIMEOUT, CANCELLED, LOST;
        public boolean isTerminal() { return this != PENDING && this != RUNNING; }
    }
    private final Long id;
    private final Long sessionId;
    private final Long turnId;
    private final Long executionId;
    private final String command;
    private final String intention;
    @Builder.Default private String output = "";
    @Builder.Default private TaskStatus status = TaskStatus.PENDING;
    private Integer exitCode;
    private boolean truncated;
    @Builder.Default private final Instant createAt = Instant.now();
    private Instant completeAt;

    public void transferTo(TaskStatus next) {
        if (next == null) throw new ClientException("任务状态不能为空");
        if (status.isTerminal()) {
            if (status != next) throw new ClientException("已结束的任务不能再次变更状态");
            return;
        }
        if (next == TaskStatus.PENDING) throw new ClientException("任务不能退回待执行状态");
        status = next;
        if (next.isTerminal()) completeAt = Instant.now();
    }
    public void changeOutput(String text) {
        if (text == null || text.length() > MAX_OUTPUT) throw new ClientException("任务输出不能为空且不能超过 " + MAX_OUTPUT + " 字符");
        output = text;
    }
    public void finish(TaskStatus next, String text, Integer code, boolean clipped) {
        if (status.isTerminal()) return;
        if (next == null || !next.isTerminal()) throw new ClientException("任务收尾必须使用结束状态");
        changeOutput(text);
        exitCode = code;
        truncated = clipped;
        transferTo(next);
    }
}
