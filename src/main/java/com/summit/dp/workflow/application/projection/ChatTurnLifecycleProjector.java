package com.summit.dp.workflow.application.projection;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/** 只投影已提交的生命周期事实，挂起与终态不能互相覆盖。 */
@Component
@RequiredArgsConstructor
public class ChatTurnLifecycleProjector {
    private final ChatTurnService chatTurnService;

    public void markExecutionWaiting(Execution execution) {
        Long rootSessionId = ExecutionEventMetadata.parseRootSessionId(execution.eventMetaData());
        chatTurnService.markWaiting(execution.getId(), rootSessionId);
    }

    public void finishExecution(Execution execution) {
        ExecutionState state = execution == null ? null : execution.getExecutionState();
        if (state == null) return;
        ChatTurnStatus terminalStatus = switch (state) {
            case COMPLETED -> ChatTurnStatus.COMPLETED;
            case FAILED -> ChatTurnStatus.FAILED;
            case CANCELLED -> ChatTurnStatus.CANCELLED;
            default -> null;
        };
        if (terminalStatus == null) return;
        Long rootSessionId = ExecutionEventMetadata.parseRootSessionId(execution.eventMetaData());
        chatTurnService.markTerminal(execution.getId(), terminalStatus, null, null, null,
                execution.getCompletedAt(), rootSessionId);
    }
}
