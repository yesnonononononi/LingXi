package com.summit.dp.workflow.infrastructure.tools.terminal.backend;

import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/** 事件只通知界面回查，推送失败不能改变命令执行结果。 */
@Component
@RequiredArgsConstructor
@Slf4j
public class BackgroundTaskBroadcaster {
    public static final String EVENT_NAME = "BACKGROUND_TASK_CHANGED";
    private final ExecutionLocator locator;
    private final SseEventPublisher publisher;

    public void publishChanged(Task task) {
        try {
            Long rootId = locator.resolveRootSessionIdOrNull(task.getSessionId());
            if (rootId == null || rootId <= 0) return;
            publisher.publishBusiness(rootId, EVENT_NAME,
                    new TaskChanged(rootId, task.getSessionId(), task.getId(), task.getStatus().name()));
        } catch (RuntimeException failure) {
            log.warn("推送后台任务变化失败: taskId={}, reason={}", task.getId(), failure.toString());
        }
    }

    public record TaskChanged(long rootSessionId, long sessionId, long taskId, String status) { }
}
