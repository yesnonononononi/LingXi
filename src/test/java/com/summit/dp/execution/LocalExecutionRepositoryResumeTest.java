package com.summit.dp.execution;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.*;
import com.summit.core.conversation.message.*;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.dp.execution.domain.lifecycle.ExecutionLifecycleListener;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.LocalExecutionRepository;
import com.summit.dp.shared.config.JsonConfig;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.List;
import java.util.Map;
import java.util.concurrent.*;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class LocalExecutionRepositoryResumeTest {
    private final ObjectMapper mapper = new JsonConfig().objectMapper();
    private final ExecutionMapper persistence = mock(ExecutionMapper.class);
    private final RecordingLifecycleListener lifecycle = new RecordingLifecycleListener();
    @org.junit.jupiter.api.BeforeEach
    void allowCheckpointUpdates() { when(persistence.updateById(any(ExecutionPO.class))).thenReturn(1); }
    private final LocalExecutionRepository repository =
            new LocalExecutionRepository(persistence, mapper, List.of(lifecycle));

    private static Execution execution() {
        List<Message> history = List.of(UserMessageEntity.from("hi"),
                SystemMessageEntity.builder().text("suspended").build());
        AgentRequest request = AgentRequest.builder().executionId("305").messages(history)
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, "405")).build()).build();
        return Execution.builder().id("305").agentId("chatAgent").agentRequest(request)
                .executionState(ExecutionState.SUSPENDED).messages(history).build();
    }

    @Test
    void memoryCheckpointRestoresFreshMutableHistories() {
        Execution source = execution();
        repository.save(source);
        source.setMessages(List.of(UserMessageEntity.from("uncommitted")));
        Execution restored = repository.findById("305").orElseThrow();
        assertEquals(ExecutionState.SUSPENDED, restored.getExecutionState());
        assertEquals(2, restored.getMessages().size());
        restored.getMessages().add(UserMessageEntity.from("appended"));
        restored.getAgentRequest().getMessages().add(UserMessageEntity.from("request appended"));
        assertEquals(3, restored.getMessages().size());
        assertEquals(3, restored.getAgentRequest().getMessages().size());
        assertEquals(2, repository.findById("305").orElseThrow().getMessages().size());
        verify(persistence).updateById(any(ExecutionPO.class));
    }

    @Test
    void coldRepositoryRestoresPersistedJson() throws Exception {
        ExecutionPO row = new ExecutionPO();
        row.setSnapshot(mapper.writeValueAsString(execution()));
        when(persistence.selectById(305L)).thenReturn(row);
        Execution restored = repository.findById("305").orElseThrow();
        assertInstanceOf(UserMessageEntity.class, restored.getMessages().getFirst());
        assertEquals(405L, ExecutionIdentity.sessionId(restored));
        assertDoesNotThrow(() -> restored.getMessages().add(UserMessageEntity.from("next")));
    }

    @Test
    void createsAndUpdatesUsingExistingMapper() throws Exception {
        when(persistence.insert(any(ExecutionPO.class))).thenReturn(1);
        when(persistence.updateById(any(ExecutionPO.class))).thenReturn(1);
        Execution source = execution();
        source = Execution.create(source.getAgentRequest(), "chatAgent");
        repository.register("305");
        repository.save(source);
        ArgumentCaptor<ExecutionPO> inserted = ArgumentCaptor.forClass(ExecutionPO.class);
        verify(persistence).insert(inserted.capture());
        assertEquals(305L, inserted.getValue().getId());
        assertEquals(405L, inserted.getValue().getSessionId());
        assertEquals(0, inserted.getValue().getStatus());
        assertNotNull(inserted.getValue().getCreatedAt());
        assertEquals(ExecutionState.CREATED,
                mapper.readValue(inserted.getValue().getSnapshot(), Execution.class).getExecutionState());

        source.suspended();
        repository.save(source);
        ArgumentCaptor<ExecutionPO> updated = ArgumentCaptor.forClass(ExecutionPO.class);
        verify(persistence).updateById(updated.capture());
        assertEquals(2, updated.getValue().getStatus());
        assertEquals(305L, updated.getValue().getId());
        assertNull(updated.getValue().getSessionId());
    }

    @Test
    void cacheChangesOnlyAfterTransactionCommit() {
        repository.save(execution());
        repository.register("305");
        when(persistence.updateById(any(ExecutionPO.class))).thenReturn(1);
        Execution changed = execution();
        changed.setMessages(List.of(UserMessageEntity.from("committed")));
        TransactionSynchronizationManager.initSynchronization();
        try {
            repository.save(changed);
            assertEquals(2, repository.findById("305").orElseThrow().getMessages().size());
            for (TransactionSynchronization synchronization : TransactionSynchronizationManager.getSynchronizations()) {
                synchronization.afterCommit();
            }
            assertEquals("committed", repository.findById("305").orElseThrow().getMessages().getFirst().text());
        } finally {
            TransactionSynchronizationManager.clearSynchronization();
        }
    }

    @Test
    void rolledBackTerminalSaveKeepsPreviousCheckpoint() {
        repository.save(execution());
        repository.register("305");
        when(persistence.updateById(any(ExecutionPO.class))).thenReturn(1);
        Execution finished = execution();
        finished.complete();
        TransactionSynchronizationManager.initSynchronization();
        try {
            repository.save(finished);
            for (TransactionSynchronization synchronization : TransactionSynchronizationManager.getSynchronizations()) {
                synchronization.afterCompletion(TransactionSynchronization.STATUS_ROLLED_BACK);
            }
        } finally {
            TransactionSynchronizationManager.clearSynchronization();
        }
        assertEquals(ExecutionState.SUSPENDED, repository.findById("305").orElseThrow().getExecutionState());
    }

    @Test
    void committedTerminalSaveEvictsMemoryCheckpoint() {
        repository.save(execution());
        repository.register("305");
        when(persistence.updateById(any(ExecutionPO.class))).thenReturn(1);
        Execution finished = execution();
        finished.complete();
        TransactionSynchronizationManager.initSynchronization();
        try {
            repository.save(finished);
            assertTrue(repository.findById("305").isPresent());
            for (TransactionSynchronization synchronization : TransactionSynchronizationManager.getSynchronizations()) {
                synchronization.afterCommit();
            }
        } finally {
            TransactionSynchronizationManager.clearSynchronization();
        }
        assertTrue(repository.findById("305").isEmpty());
        verify(persistence).selectById(305L);
    }

    @Test
    void missingRowDoesNotPublishNewCheckpoint() {
        repository.save(execution());
        repository.register("305");
        Execution changed = execution();
        changed.start();
        when(persistence.updateById(any(ExecutionPO.class))).thenReturn(0);
        assertThrows(IllegalStateException.class, () -> repository.save(changed));
        assertEquals(ExecutionState.SUSPENDED, repository.findById("305").orElseThrow().getExecutionState());
    }

    @Test
    void stoppingSuspendedExecutionPersistsCancellation() {
        repository.save(execution());
        repository.requireCancel("305");
        ArgumentCaptor<ExecutionPO> saved = ArgumentCaptor.forClass(ExecutionPO.class);
        verify(persistence, times(2)).updateById(saved.capture());
        assertEquals(5, saved.getValue().getStatus());
        when(persistence.selectById(305L)).thenReturn(saved.getValue());
        assertThrows(IllegalStateException.class, () -> repository.register("305"));
        // loop 边界终结信号经生命周期端口广播（评审 P1-⑥）
        assertEquals(List.of("305"), lifecycle.finished);
    }

    @Test
    void concurrentRegistrationHasExactlyOneOwner() throws Exception {
        CountDownLatch start = new CountDownLatch(1);
        try (ExecutorService workers = Executors.newVirtualThreadPerTaskExecutor()) {
            Callable<Boolean> attempt = () -> {
                start.await();
                try {
                    repository.register("305");
                    return true;
                } catch (IllegalStateException expected) {
                    return false;
                }
            };
            Future<Boolean> first = workers.submit(attempt);
            Future<Boolean> second = workers.submit(attempt);
            start.countDown();
            assertNotEquals(first.get(5, TimeUnit.SECONDS), second.get(5, TimeUnit.SECONDS));
        }
        assertDoesNotThrow(() -> repository.requireSuspend("305"));
        assertThrows(IllegalArgumentException.class,
                () -> repository.unregister(new ExecutionControlSignal("305")));
    }

    /** 记录 loop 边界信号的订阅者（评审 P1-⑥ 生命周期端口）。 */
    private static final class RecordingLifecycleListener implements ExecutionLifecycleListener {
        private final List<String> suspended = new java.util.ArrayList<>();
        private final List<String> finished = new java.util.ArrayList<>();

        @Override
        public void onExecutionSuspended(String executionId) {
            suspended.add(executionId);
        }

        @Override
        public void onExecutionFinished(String executionId) {
            finished.add(executionId);
        }
    }
}
