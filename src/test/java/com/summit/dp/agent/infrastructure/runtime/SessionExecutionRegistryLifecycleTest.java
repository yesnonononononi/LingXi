package com.summit.dp.agent.infrastructure.runtime;

import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/** 子任务从提交前到真正结束只保留一份登记。 */
class SessionExecutionRegistryLifecycleTest {
    private static final long ROOT_SESSION = 100L;
    private static final long CHILD_SESSION = 200L;

    @Test
    void cancellationIncludesAcceptedChildrenBeforeTheyStart() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        assertTrue(registry.registerPendingChild(ROOT_SESSION, CHILD_SESSION));
        assertEquals(List.of(CHILD_SESSION), registry.cancelRoot(ROOT_SESSION));
        assertFalse(registry.tryStartChild(ROOT_SESSION, CHILD_SESSION));
        assertFalse(registry.registerPendingChild(ROOT_SESSION, CHILD_SESSION + 1));
    }

    @Test
    void startingAnAcceptedChildDoesNotDuplicateItsRegistration() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        registry.registerPendingChild(ROOT_SESSION, CHILD_SESSION);
        assertTrue(registry.tryStartChild(ROOT_SESSION, CHILD_SESSION));
        assertEquals(List.of(CHILD_SESSION), registry.cancelRoot(ROOT_SESSION));
        assertTrue(registry.unregisterChild(ROOT_SESSION, CHILD_SESSION));
        assertFalse(registry.hasUnfinishedChildren(ROOT_SESSION));
    }

    @Test
    void rootReleaseKeepsChildRegistrationUntilItsTerminalOutcome() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        registry.beginRoot(ROOT_SESSION);
        registry.registerPendingChild(ROOT_SESSION, CHILD_SESSION);
        registry.finishRoot(ROOT_SESSION);
        assertTrue(registry.hasUnfinishedChildren(ROOT_SESSION));
        registry.unregisterChild(ROOT_SESSION, CHILD_SESSION);
        assertFalse(registry.hasUnfinishedChildren(ROOT_SESSION));
    }

    @Test
    void removingOneChildPreservesOtherAcceptedWork() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        registry.registerPendingChild(ROOT_SESSION, CHILD_SESSION);
        registry.registerPendingChild(ROOT_SESSION, CHILD_SESSION + 1);
        assertFalse(registry.unregisterChild(ROOT_SESSION, CHILD_SESSION));
        assertTrue(registry.hasUnfinishedChildren(ROOT_SESSION));
        assertTrue(registry.unregisterChild(ROOT_SESSION, CHILD_SESSION + 1));
        assertFalse(registry.hasUnfinishedChildren(ROOT_SESSION));
    }

    @Test
    void submissionFailureRevokesOnlyItsOwnChild() {
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        registry.registerPendingChild(ROOT_SESSION, CHILD_SESSION);
        registry.registerPendingChild(ROOT_SESSION, CHILD_SESSION + 1);
        registry.revokeChild(ROOT_SESSION, CHILD_SESSION);
        registry.revokeChild(ROOT_SESSION, 999L);
        assertEquals(List.of(CHILD_SESSION + 1), registry.cancelRoot(ROOT_SESSION));
    }
}
