package com.summit.dp.workflow.application.input;

import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.workflow.infrastructure.lifecycle.startup.InputStartupRecheck;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.mockito.Mockito.*;

class InputStartupRecheckTest {
    @Test void startupRechecksOnlyTheLatestExecutionInEveryRootAndChildSession() {
        SessionRepository sessions = mock(SessionRepository.class);
        ExecutionRepository executions = mock(ExecutionRepository.class);
        InputWakeupService wakeups = mock(InputWakeupService.class);
        Session root = Session.builder().id(10L).build();
        Session child = Session.builder().id(20L).build();
        when(sessions.findRootSessions()).thenReturn(List.of(root));
        when(sessions.findSessionTree(10L)).thenReturn(List.of(root, child));
        when(executions.findLatestBySessionAndStatus(List.of(10L, 20L)))
                .thenReturn(List.of(summary(100L, 10L), summary(200L, 10L), summary(300L, 20L)));
        new InputStartupRecheck(sessions, executions, wakeups).recheck();
        verify(wakeups).resumeIfInputPending(200L);
        verify(wakeups).resumeIfInputPending(300L);
        verifyNoMoreInteractions(wakeups);
    }

    private static Execution summary(long id, long sessionId) {
        Execution execution = new Execution();
        execution.setId(id);
        execution.setSessionId(sessionId);
        return execution;
    }
}
