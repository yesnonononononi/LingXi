package com.summit.dp.agent.application.service.impl;

import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.workflow.application.chat.impl.ChatServiceImpl;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;

import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class ChatServiceStopTest {
    @Mock private ExecutionControl control;
    @Mock private ExecutionLocator locator;
    @Mock private SessionRepository sessions;
    @Mock private SessionExecutionRegistry registry;
    @InjectMocks private ChatServiceImpl service;

    @Test
    void stopSignalsTheWholeTreeWithoutInterruptingCheckpointPersistence() {
        when(registry.cancelRoot(800L)).thenReturn(List.of(555L));
        when(locator.activeExecutionIds(800L)).thenReturn(List.of("101"));
        when(locator.activeExecutionIds(555L)).thenReturn(List.of("102"));

        service.stop(800L);

        verify(registry).cancelRoot(800L);
        verify(control).cancel("101");
        verify(control).cancel("102");
    }
}
