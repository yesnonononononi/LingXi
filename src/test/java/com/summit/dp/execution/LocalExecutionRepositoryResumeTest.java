package com.summit.dp.execution;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.*;
import com.summit.core.conversation.message.*;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.agent.Execution;
import com.summit.dp.execution.domain.lifecycle.ExecutionCoordination;
import com.summit.dp.session.application.service.SessionAggregateService;
import com.summit.dp.toolcall.application.service.ToolCallReadinessService;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.toolcall.infrastructure.listener.DelegationSettleService;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.LocalExecutionRepository;
import com.summit.dp.shared.config.JsonConfig;
import org.junit.jupiter.api.Test;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.mockito.ArgumentCaptor;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static com.summit.dp.execution.ExecutionRepositoryTestFactory.provider;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class LocalExecutionRepositoryResumeTest {
    private final ObjectMapper mapper = new JsonConfig().objectMapper();
    private final ExecutionMapper persistence = mock(ExecutionMapper.class);
    private final ToolCallReadinessService readiness = mock(ToolCallReadinessService.class);
    private final ToolCallService tools = mock(ToolCallService.class);
    private final DelegationSettleService delegation = mock(DelegationSettleService.class);
    private final SessionAggregateService sessions = mock(SessionAggregateService.class);
    private final ChatTurnService turns = mock(ChatTurnService.class);
    private final List<String> suspended = new ArrayList<>();
    private final List<String> finished = new ArrayList<>();
    @org.junit.jupiter.api.BeforeEach
    void allowCheckpointUpdates() {
        TableInfoHelper.initTableInfo(new MapperBuilderAssistant(new MybatisConfiguration(), "test"), ExecutionPO.class);
        when(persistence.update(any(ExecutionPO.class), any())).thenReturn(1);
        doAnswer(invocation -> { suspended.add(invocation.<Execution>getArgument(0).getId()); return null; })
                .when(turns).markExecutionWaiting(any());
        doAnswer(invocation -> { finished.add(invocation.<Execution>getArgument(0).getId()); return null; })
                .when(turns).finishExecution(any());
    }
    private final LocalExecutionRepository repository =
            new LocalExecutionRepository(persistence, mapper, provider(readiness), provider(tools),
                    provider(delegation), provider(sessions), provider(turns));

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
        verify(persistence).update(any(ExecutionPO.class), any());
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
    void startupTerminalSummaryPreventsRestoringOldRunningSnapshot() throws Exception {
        Execution interrupted = execution();
        interrupted.start();
        ExecutionPO row = new ExecutionPO();
        row.setStatus(4);
        row.setSnapshot(mapper.writeValueAsString(interrupted));
        when(persistence.selectById(305L)).thenReturn(row);

        assertEquals(ExecutionState.FAILED, repository.findById("305").orElseThrow().getExecutionState());
        assertThrows(IllegalStateException.class, () -> repository.register("305"));
        assertFalse(repository.isActive("305"));
    }

    @Test
    void createsAndUpdatesUsingExistingMapper() throws Exception {
        when(persistence.insert(any(ExecutionPO.class))).thenReturn(1);
        when(persistence.update(any(ExecutionPO.class), any())).thenReturn(1);
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

        source.suspend();
        repository.save(source);
        ArgumentCaptor<ExecutionPO> updated = ArgumentCaptor.forClass(ExecutionPO.class);
        verify(persistence).update(updated.capture(), any());
        assertEquals(2, updated.getValue().getStatus());
        assertEquals(305L, updated.getValue().getId());
        assertNull(updated.getValue().getSessionId());
    }

    @Test
    void cacheChangesOnlyAfterTransactionCommit() {
        repository.save(execution());
        repository.register("305");
        when(persistence.update(any(ExecutionPO.class), any())).thenReturn(1);
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
    void approvalNotificationRunsAfterCommitButNotRollback() {
        AtomicInteger notifications = new AtomicInteger();
        TransactionSynchronizationManager.initSynchronization();
        try {
            repository.afterCommit(notifications::incrementAndGet);
            assertEquals(0, notifications.get());
            for (TransactionSynchronization synchronization : TransactionSynchronizationManager.getSynchronizations()) {
                synchronization.afterCompletion(TransactionSynchronization.STATUS_ROLLED_BACK);
            }
        } finally {
            TransactionSynchronizationManager.clearSynchronization();
        }
        assertEquals(0, notifications.get());

        TransactionSynchronizationManager.initSynchronization();
        try {
            repository.afterCommit(notifications::incrementAndGet);
            assertEquals(0, notifications.get());
            for (TransactionSynchronization synchronization : TransactionSynchronizationManager.getSynchronizations()) {
                synchronization.afterCommit();
            }
        } finally {
            TransactionSynchronizationManager.clearSynchronization();
        }
        assertEquals(1, notifications.get());
    }

    @Test
    void rolledBackTerminalSaveKeepsPreviousCheckpoint() {
        repository.save(execution());
        repository.register("305");
        when(persistence.update(any(ExecutionPO.class), any())).thenReturn(1);
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
        when(persistence.update(any(ExecutionPO.class), any())).thenReturn(1);
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
        when(persistence.update(any(ExecutionPO.class), any())).thenReturn(0);
        assertThrows(IllegalStateException.class, () -> repository.save(changed));
        assertEquals(ExecutionState.SUSPENDED, repository.findById("305").orElseThrow().getExecutionState());
    }

    @Test
    void stoppingSuspendedExecutionPersistsCancellation() {
        repository.save(execution());
        repository.requireCancel("305");
        ArgumentCaptor<ExecutionPO> saved = ArgumentCaptor.forClass(ExecutionPO.class);
        verify(persistence, times(2)).update(saved.capture(), any());
        assertEquals(5, saved.getValue().getStatus());
        when(persistence.selectById(305L)).thenReturn(saved.getValue());
        assertThrows(IllegalStateException.class, () -> repository.register("305"));
        // 取消挂起执行也必须推进业务终结处理。
        assertEquals(List.of("305"), finished);
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

    @Test
    void releasedSignalIsVisibleAndServiceFailureDoesNotBlockFollowingService() {
        ToolCallReadinessService failing = mock(ToolCallReadinessService.class);
        LocalExecutionRepository isolated = new LocalExecutionRepository(persistence, mapper,
                provider(failing), provider(tools), provider(delegation), provider(sessions), provider(turns));
        doAnswer(invocation -> {
            assertFalse(Thread.holdsLock(ExecutionCoordination.monitor("305")));
            assertFalse(isolated.isActive("305"));
            throw new IllegalStateException("卡片开放失败");
        }).when(failing).markReady("305");
        isolated.save(execution());
        ExecutionControlSignal signal = isolated.register("305");
        assertTrue(isolated.isActive("305"));
        assertDoesNotThrow(() -> isolated.unregister(signal));
        assertFalse(isolated.isActive("305"));
        assertEquals(List.of("305"), suspended);
        verify(delegation).reconcileSuspendedExecution("305");
        verify(tools, never()).cancelPendingToolCalls(any());
        verify(sessions, never()).saveExecutionContextUsage(any());
    }

    @Test
    void suspensionServicesRunAfterCommitAndNeverAfterRollback() {
        repository.save(execution());
        ExecutionControlSignal signal = repository.register("305");
        TransactionSynchronizationManager.initSynchronization();
        try {
            repository.unregister(signal);
            assertFalse(repository.isActive("305"));
            verifyNoInteractions(readiness, delegation, turns, tools, sessions);
            for (TransactionSynchronization synchronization : TransactionSynchronizationManager.getSynchronizations()) {
                synchronization.afterCompletion(TransactionSynchronization.STATUS_ROLLED_BACK);
            }
            verifyNoInteractions(readiness, delegation, turns, tools, sessions);
        } finally {
            TransactionSynchronizationManager.clearSynchronization();
        }

        signal = repository.register("305");
        TransactionSynchronizationManager.initSynchronization();
        try {
            repository.unregister(signal);
            verifyNoInteractions(readiness, delegation, turns, tools, sessions);
            for (TransactionSynchronization synchronization : TransactionSynchronizationManager.getSynchronizations()) {
                synchronization.afterCommit();
            }
            verify(readiness).markReady("305");
            verify(delegation).reconcileSuspendedExecution("305");
            assertEquals(List.of("305"), suspended);
        } finally {
            TransactionSynchronizationManager.clearSynchronization();
        }
    }

    @Test
    void terminalServiceFailuresDoNotBlockMetricsAndTurnClosure() {
        repository.save(execution());
        doThrow(new IllegalStateException("工具收口失败")).when(tools).cancelPendingToolCalls("305");
        doThrow(new IllegalStateException("委派回填失败")).when(delegation).backfillFinishedExecution(any());
        doThrow(new IllegalStateException("会话用量保存失败")).when(sessions).saveExecutionContextUsage(any());

        assertDoesNotThrow(() -> repository.requireCancel("305"));

        ArgumentCaptor<Execution> checkpoint = ArgumentCaptor.forClass(Execution.class);
        verify(delegation).backfillFinishedExecution(checkpoint.capture());
        assertEquals(ExecutionState.CANCELLED, checkpoint.getValue().getExecutionState());
        verify(sessions).saveExecutionContextUsage(same(checkpoint.getValue()));
        verify(turns).finishExecution(same(checkpoint.getValue()));
        assertEquals(List.of("305"), finished);
        verifyNoInteractions(readiness);
    }

    @Test
    void initializationFailureServicesWaitForCheckpointCommit() {
        when(persistence.selectOne(any())).thenReturn(statusRow(ExecutionStatusCodes.CREATED, 1L));
        Execution failed = execution();
        failed.fail("初始化失败");
        TransactionSynchronizationManager.initSynchronization();
        try {
            repository.save(failed);
            verifyNoInteractions(readiness, delegation, turns, tools, sessions);
            for (TransactionSynchronization synchronization : TransactionSynchronizationManager.getSynchronizations()) {
                synchronization.afterCommit();
            }
            verify(tools).cancelPendingToolCalls("305");
            verify(delegation).backfillFinishedExecution(same(failed));
            verify(sessions).saveExecutionContextUsage(same(failed));
            verify(turns).finishExecution(same(failed));
            assertEquals(List.of("305"), finished);
        } finally {
            TransactionSynchronizationManager.clearSynchronization();
        }
    }

    /**
     * 初始化失败路径的终结广播：首次落 FAILED 且本进程没有控制槽位。
     *
     * <p>框架的顺序是「save(FAILED) → 返回发布任务 → 调用方 run 它」，业务侧没有排序权；
     * 轮次收口只能由这里在保存提交后补，才能保证它早于框架发布终态事件。</p>
     */
    @Test
    void firstFailureWithoutControlSlotNotifiesFinish() {
        when(persistence.selectOne(any())).thenReturn(statusRow(ExecutionStatusCodes.CREATED, 1L));

        Execution failed = execution();
        failed.fail("模型不可用");
        repository.save(failed);

        assertEquals(List.of("305"), finished, "初始化失败必须补一次终结广播，否则轮次永远停在已受理");
        assertEquals(List.of(), suspended);
    }

    /** 活跃循环的失败不在这里广播：控制槽位仍在，由 unregister 负责（两条路径互斥，不会双发）。 */
    @Test
    void failureWithActiveControlSlotDefersToUnregister() {
        when(persistence.selectOne(any())).thenReturn(statusRow(ExecutionStatusCodes.RUNNING, 2L));
        ExecutionControlSignal signal = repository.register("305");

        Execution failed = execution();
        failed.fail("loop 内失败");
        repository.save(failed);
        assertEquals(List.of(), finished);

        ArgumentCaptor<ExecutionPO> saved = ArgumentCaptor.forClass(ExecutionPO.class);
        verify(persistence).update(saved.capture(), any());
        when(persistence.selectById(305L)).thenReturn(saved.getValue());

        // 必须用 register 返回的那个信号：unregister 按实例身份摘槽位。
        repository.unregister(signal);
        assertEquals(List.of("305"), finished, "释放控制信号时才广播");
    }

    /** 只有 FAILED 需要补：完成 / 挂起都有各自的收口路径，重复落 FAILED 也不算首次。 */
    @Test
    void onlyFirstFailureNotifiesFinish() {
        when(persistence.selectOne(any())).thenReturn(statusRow(ExecutionStatusCodes.CREATED, 1L));

        Execution completed = execution();
        completed.complete();
        repository.save(completed);
        assertEquals(List.of(), finished, "完成不是失败");

        repository.save(execution());
        assertEquals(List.of(), finished, "挂起不是终态");

        when(persistence.selectOne(any())).thenReturn(statusRow(ExecutionStatusCodes.FAILED, 3L));
        Execution again = execution();
        again.fail("重复落库");
        repository.save(again);
        assertEquals(List.of(), finished, "行前态已是 FAILED ⇒ 不是首次，不重复广播");
    }

    private static ExecutionPO statusRow(int status, long version) {
        ExecutionPO row = new ExecutionPO();
        row.setId(305L);
        row.setStatus(status);
        row.setVersion(version);
        row.setSessionId(405L);
        return row;
    }

}
