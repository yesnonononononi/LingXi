package com.summit.dp.agent.application.service.impl;

import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.workflow.application.chat.ChatCommand;
import com.summit.dp.workflow.application.chat.PendingChatQueue;
import com.summit.dp.workflow.application.chat.SessionExecutionStopper;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** 停止同时覆盖内存待启动任务和重启后只存在于数据库的挂起执行。 */
class SessionExecutionStopperTest {
    private final SessionRepository sessions = mock(SessionRepository.class);
    private final ExecutionRepository executions = mock(ExecutionRepository.class);
    private final ExecutionControl control = mock(ExecutionControl.class);
    private final SessionExecutionRegistry registry = new SessionExecutionRegistry();
    private final PendingChatQueue pending = new PendingChatQueue();
    private final SessionExecutionStopper stopper = new SessionExecutionStopper(sessions, executions, registry, control, pending);

    @Test
    void oneBatchReadCompletesTheRegisteredTreeBeforeCancellingOutsideTheRootLock() {
        String pendingId = pending.enqueue(800L, new ChatCommand("待发送", 800L, null, null, null, null, false, List.of(), List.of()));
        registry.beginRoot(800L, "100");
        registry.registerPendingChild(800L, 555L, "101", "100");
        when(sessions.findSessionTree(800L)).thenReturn(List.of(
                Session.builder().id(800L).rootSessionId(0L).build(),
                Session.builder().id(556L).rootSessionId(800L).build()));
        when(executions.findUnfinishedBySessions(Set.of(800L, 556L))).thenReturn(List.of(
                Execution.restoreCheckpointSummary(102L, 1L, ExecutionStatusCodes.SUSPENDED, 1L, 556L, null)));
        doAnswer(call -> {
            assertFalse(Thread.holdsLock(ExecutionCoordination.monitor("control:800")));
            return null;
        }).when(control).cancel(anyString());

        stopper.stop(800L);

        verify(executions, times(1)).findUnfinishedBySessions(Set.of(800L, 556L));
        verify(control).cancel("100");
        verify(control).cancel("101");
        verify(control).cancel("102");
        assertFalse(registry.tryStartChild("101"));
        assertTrue(registry.acquire("102").isCancelRequired());
        assertTrue(pending.snapshot(800L).paused());
        assertEquals(pendingId, pending.snapshot(800L).entries().getFirst().id());
        assertNull(pending.claim(800L));
    }

    @Test
    void lookupFailureStillCancelsRunningSignalsAndClosesNewRegistrations() {
        registry.beginRoot(800L, "100");
        ExecutionControlSignal signal = registry.acquire("100");
        when(sessions.findSessionTree(800L)).thenThrow(new IllegalStateException("模拟查询失败"));

        assertThrows(IllegalStateException.class, () -> stopper.stop(800L));

        assertTrue(signal.isCancelRequired());
        assertFalse(registry.registerPendingChild(800L, 555L, "101", "100"));
    }

    @Test
    void alreadyFinishedExecutionDoesNotPreventOtherChildrenFromBeingCancelled() {
        registry.registerPendingChild(800L, 555L, "101", null);
        registry.registerPendingChild(800L, 556L, "102", null);
        doThrow(new IllegalStateException("执行已经结束")).when(control).cancel("101");

        stopper.stop(800L);

        verify(control).cancel("102");
        assertTrue(registry.isExecutionCancelled("102"));
    }
}
