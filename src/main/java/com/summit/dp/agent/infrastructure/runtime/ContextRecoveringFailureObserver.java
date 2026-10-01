package com.summit.dp.agent.infrastructure.runtime;

import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.runtime.loop.ExecutionFailureObserver;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.session.application.service.ModelContextService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;

/** Keeps accepted work in the next model context after a failed execution. */
@Slf4j
@Component
@RequiredArgsConstructor
public class ContextRecoveringFailureObserver implements ExecutionFailureObserver {

    private static final String INTERRUPTION_NOTE = """
            The previous execution was interrupted before completion by a transient failure; \
            all progress and tool work above are preserved.""";

    private final ModelContextService modelContextService;

    @Override
    public void onFailure(Execution execution, Exception cause) {
        try {
            long sessionId = ExecutionIdentity.sessionId(execution);
            List<Message> messages = execution.getMessages();
            if (messages == null || messages.isEmpty()) {
                log.warn("【chat】execution failed before any message was produced, nothing to recover, "
                        + "sessionId={}, executionId={}", sessionId, execution.getId());
                return;
            }
            List<Message> recovered = new ArrayList<>(messages);
            recovered.add(SystemMessageEntity.builder().text(INTERRUPTION_NOTE).build());
            modelContextService.replace(sessionId, recovered);
            log.warn("【chat】execution failed, recovered {} message(s) into model context, "
                            + "sessionId={}, executionId={}, cause={}",
                    recovered.size(), sessionId, execution.getId(), cause.toString());
        } catch (Exception recoveryError) {
            log.warn("【chat】failed to recover model context after execution failure, executionId={}, cause={}",
                    execution.getId(), recoveryError.toString());
        }
    }
}
