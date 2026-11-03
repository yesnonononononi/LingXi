package com.summit.dp.agent.application.service.impl;

import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.workflow.application.chat.impl.ChatServiceImpl;
import com.summit.dp.workflow.application.chat.SessionExecutionStopper;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.Optional;

import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class ChatServiceStopTest {
    @Mock private ExecutionControl control;
    @Mock private ExecutionLocator locator;
    @Mock private SessionRepository sessions;
    @Mock private SessionExecutionRegistry registry;
    @Mock private SessionExecutionStopper stopper;
    @InjectMocks private ChatServiceImpl service;

    @Test
    void rootStopDelegatesToTheTreeControlEntry() {
        service.stop(800L);

        verify(stopper).stop(800L);
        verifyNoInteractions(control, locator);
    }

    @Test
    void childStopResolvesItsAuthoritativeRoot() {
        when(sessions.findById(555L)).thenReturn(Optional.of(
                Session.builder().id(555L).rootSessionId(800L).build()));

        service.stop(555L);

        verify(stopper).stop(800L);
        verifyNoInteractions(control, locator);
    }
}
