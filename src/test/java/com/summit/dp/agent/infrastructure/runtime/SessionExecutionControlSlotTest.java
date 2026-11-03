package com.summit.dp.agent.infrastructure.runtime;

import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import org.junit.jupiter.api.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

/** 运行占用可更换，取消意图和执行身份不能随之丢失。 */
class SessionExecutionControlSlotTest {
    private final SessionExecutionRegistry registry = new SessionExecutionRegistry();

    @Test
    void cancellationSurvivesSuspensionAndDelayedAcquisition() {
        registry.restoreExecution(800L, 555L, "101");
        ExecutionControlSignal first = registry.acquire("101");
        assertTrue(registry.release(first));
        assertFalse(registry.isActive("101"));

        registry.cancelRoot(800L);
        ExecutionControlSignal resumed = registry.acquire("101");

        assertNotSame(first, resumed);
        assertTrue(resumed.isCancelRequired());
        assertThrows(RuntimeException.class, resumed::checkInterruption);
    }

    @Test
    void suspensionAppliesOnlyToItsOwnRun() {
        registry.restoreExecution(800L, 555L, "101");
        ExecutionControlSignal first = registry.acquire("101");
        registry.requireSuspend("101");
        assertTrue(first.isSuspendRequired());
        registry.release(first);

        ExecutionControlSignal resumed = registry.acquire("101");
        assertFalse(resumed.isSuspendRequired());
        assertFalse(resumed.isCancelRequired());
    }

    @Test
    void staleReleaseCannotRemoveTheNextRun() {
        registry.restoreExecution(800L, 555L, "101");
        ExecutionControlSignal first = registry.acquire("101");
        registry.release(first);
        ExecutionControlSignal resumed = registry.acquire("101");

        assertFalse(registry.release(first));
        assertTrue(registry.isActive("101"));
        assertThrows(IllegalStateException.class, () -> registry.acquire("101"));
        assertTrue(registry.release(resumed));
    }

    @Test
    void newRootDoesNotReviveAnOldQueuedChild() {
        registry.beginRoot(800L, "100");
        registry.registerPendingChild(800L, 555L, "101", "100");
        registry.cancelRoot(800L);
        registry.finishRoot(800L, "100");
        registry.beginRoot(800L, "200");

        assertFalse(registry.isCancelled(800L));
        assertFalse(registry.tryStartChild("101"));
        assertTrue(registry.acquire("101").isCancelRequired());
        assertFalse(registry.acquire("200").isCancelRequired());
        assertFalse(registry.registerPendingChild(800L, 556L, "102", "101"));
    }

    @Test
    void stopDoesNotReleaseTheOldAdmissionBeforeItsOwnerFinishes() {
        registry.beginRoot(800L, "100");
        registry.cancelRoot(800L);
        assertThrows(ClientException.class, () -> registry.beginRoot(800L, "200"));
        registry.finishRoot(800L, "100");
        registry.beginRoot(800L, "200");

        registry.finishRoot(800L, "100");
        assertTrue(registry.isRootRunning(800L));
        assertThrows(ClientException.class, () -> registry.beginRoot(800L, "300"));
    }

    @Test
    void oldChildCompletionCannotRemoveANewerDelegationInTheSameSession() {
        registry.registerPendingChild(800L, 555L, "101", null);
        registry.recordExecution(800L, 555L, "101", true);
        registry.registerPendingChild(800L, 555L, "102", null);

        assertFalse(registry.unregisterChild(800L, 555L, "101"));
        assertTrue(registry.hasUnfinishedChildren(800L));
        assertTrue(registry.tryStartChild("102"));
        assertTrue(registry.unregisterChild(800L, 555L, "102"));
    }

    @Test
    void aQueuedChildPreventsASecondDelegationIntoTheSameSession() {
        registry.registerPendingChild(800L, 555L, "101", null);
        assertThrows(ClientException.class, () -> registry.registerPendingChild(800L, 555L, "102", null));
        assertTrue(registry.tryStartChild("101"));
        assertFalse(registry.tryStartChild("102"));
    }

    @Test
    void aSuspendedRootStillOwnsItsLogicalExecution() {
        registry.beginRoot(800L, "100");
        registry.recordExecution(800L, 800L, "100", false);
        registry.finishRoot(800L, "100");

        assertFalse(registry.isRootRunning(800L));
        assertThrows(ClientException.class, () -> registry.beginRoot(800L, "200"));
        assertFalse(registry.tryBeginAutomaticRoot(800L, "200"));
        registry.recordExecution(800L, 800L, "100", true);
        assertDoesNotThrow(() -> registry.beginRoot(800L, "200"));
    }

    @Test
    void releasingAnUncommittedRunDoesNotInventACommittedCheckpoint() {
        registry.beginRoot(800L, "100");
        ExecutionControlSignal running = registry.acquire("100");

        registry.release(running);
        registry.finishRoot(800L, "100");

        assertDoesNotThrow(() -> registry.beginRoot(800L, "200"));
    }

    @Test
    void registrationRacingWithStopIsEitherRejectedOrCancelled() throws Exception {
        for (int attempt = 0; attempt < 100; attempt++) {
            SessionExecutionRegistry concurrent = new SessionExecutionRegistry();
            CountDownLatch start = new CountDownLatch(1);
            try (ExecutorService workers = Executors.newVirtualThreadPerTaskExecutor()) {
                Future<Boolean> accepted = workers.submit(() -> {
                    assertTrue(start.await(5, TimeUnit.SECONDS));
                    return concurrent.registerPendingChild(800L, 555L, "101", null);
                });
                Future<?> stopped = workers.submit(() -> {
                    assertTrue(start.await(5, TimeUnit.SECONDS));
                    concurrent.cancelRoot(800L);
                    return null;
                });
                start.countDown();
                boolean registered = accepted.get(5, TimeUnit.SECONDS);
                stopped.get(5, TimeUnit.SECONDS);
                assertFalse(concurrent.tryStartChild("101"));
                if (registered) assertTrue(concurrent.acquire("101").isCancelRequired());
            }
        }
    }
}
