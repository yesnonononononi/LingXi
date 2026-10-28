package com.summit.dp.workflow.infrastructure.tools.checklist;

import com.summit.core.agent.Execution;
import com.summit.core.compact.ContextAttachmentProvider;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.checklist.application.ChecklistReminderText;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.io.Serializable;
import java.util.Optional;

/** 清单读最新业务快照，提醒只保护已提交检查点中的真实投递。 */
@Component
@RequiredArgsConstructor
public class ChecklistContextAttachmentProvider implements ContextAttachmentProvider {
    private final ChecklistService service;
    private final ExecutionRepository executions;

    @Override
    public int order() { return -700; }

    @Override
    public Optional<String> attachment(Serializable executionId) {
        if (executionId == null) return Optional.empty();
        Execution execution = executions.findById(executionId.toString())
                .orElseThrow(() -> new IllegalStateException("读取清单附件失败，执行不存在: executionId=" + executionId));
        return service.findActive(ExecutionIdentity.sessionId(execution)).map(snapshot ->
                ChecklistReminderText.renderContext(snapshot) + ChecklistReminderState.protectedText(execution, snapshot)
                        .map(text -> "\n\n" + text).orElse(""));
    }
}
