package com.summit.dp.task;

import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskBroadcaster;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class BackgroundTaskBroadcasterTest {
    @Test void taskChangesAreRoutedToTheirActualRootWithoutInventingAnExecution() {
        ExecutionLocator locator = mock(ExecutionLocator.class);
        SseEventPublisher publisher = mock(SseEventPublisher.class);
        when(locator.resolveRootSessionIdOrNull(11L)).thenReturn(100L);
        when(locator.resolveRootSessionIdOrNull(22L)).thenReturn(200L);
        BackgroundTaskBroadcaster broadcaster = new BackgroundTaskBroadcaster(locator, publisher);
        broadcaster.publishChanged(Task.builder().id(1L).sessionId(11L).build());
        broadcaster.publishChanged(Task.builder().id(2L).sessionId(22L).build());
        verify(publisher).publishBusiness(eq(100L), eq(BackgroundTaskBroadcaster.EVENT_NAME),
                eq(new BackgroundTaskBroadcaster.TaskChanged(100L, 11L, 1L, "PENDING")));
        verify(publisher).publishBusiness(eq(200L), eq(BackgroundTaskBroadcaster.EVENT_NAME),
                eq(new BackgroundTaskBroadcaster.TaskChanged(200L, 22L, 2L, "PENDING")));
        verifyNoMoreInteractions(publisher);
    }

    @Test void missingRoutingAndDeliveryFailureDoNotTurnACommandIntoAFailure() {
        ExecutionLocator locator = mock(ExecutionLocator.class);
        SseEventPublisher publisher = mock(SseEventPublisher.class);
        BackgroundTaskBroadcaster broadcaster = new BackgroundTaskBroadcaster(locator, publisher);
        when(locator.resolveRootSessionIdOrNull(11L)).thenReturn(null);
        broadcaster.publishChanged(Task.builder().id(1L).sessionId(11L).build());
        verifyNoInteractions(publisher);
        when(locator.resolveRootSessionIdOrNull(11L)).thenReturn(100L);
        doThrow(new IllegalStateException("disconnected")).when(publisher).publishBusiness(anyLong(), anyString(), any());
        assertDoesNotThrow(() -> broadcaster.publishChanged(Task.builder().id(1L).sessionId(11L).build()));
    }
}
