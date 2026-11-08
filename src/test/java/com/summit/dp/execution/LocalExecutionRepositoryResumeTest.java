package com.summit.dp.execution;

import org.springframework.test.util.ReflectionTestUtils;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import com.summit.dp.workflow.application.input.InputAutomationPolicy;
import com.summit.dp.workflow.application.input.InputWakeupService;
import com.summit.dp.workflow.application.lifecycle.ExecutionLifecycleProjection;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.ExecutionCancelledEvent;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.event.TokenInfo;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.conversation.message.TokenUsageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.dp.execution.application.service.ExecutionCheckpointService;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.workflow.application.approval.ToolCallReadinessService;
import com.summit.dp.workflow.application.projection.ChatTurnLifecycleProjector;
import com.summit.dp.workflow.application.projection.SessionContextUsageProjector;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
import com.summit.dp.workflow.infrastructure.listener.turn.ChatTurnRuntimeListener;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;
import org.mockito.InOrder;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

import static com.summit.dp.execution.ExecutionRepositoryTestFactory.provider;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;
import com.summit.core.agent.ContextSpec;

class LocalExecutionRepositoryResumeTest {
    private final ObjectMapper mapper = new JsonConfig().objectMapper();
    private final ExecutionMapper persistence = mock(ExecutionMapper.class);
    private final ToolCallReadinessService readiness = mock(ToolCallReadinessService.class);
    private final ToolCallService tools = mock(ToolCallService.class);
    private final SubExecutionLifecycle subExecutionLifecycle = mock(SubExecutionLifecycle.class);
    private final SessionContextUsageProjector sessions = mock(SessionContextUsageProjector.class);
    private final ChatTurnLifecycleProjector turns = mock(ChatTurnLifecycleProjector.class);
    private final RuntimeEventPublisher runtimeEvents = mock(RuntimeEventPublisher.class);
    private final InputWakeupService wakeups = mock(InputWakeupService.class);
    private final List<String> suspended = new ArrayList<>();
    private final List<String> finished = new ArrayList<>();
    @org.junit.jupiter.api.BeforeEach
    void allowCheckpointUpdates() {
        TableInfoHelper.initTableInfo(new MapperBuilderAssistant(new MybatisConfiguration(), "test"), ExecutionPO.class);
        // 假行存储必须跟着事务走：事务内写入只在提交后才可见，回滚则行保持原值。
        // 否则「提交前还读旧文件、回滚后仍指向旧文件」这类断言全是恒真的。
        when(persistence.update(any(ExecutionPO.class), any())).thenAnswer(invocation -> {
            applyRow(invocation.getArgument(0));
            return 1;
        });
        when(persistence.insert(any(ExecutionPO.class))).thenAnswer(invocation -> {
            applyRow(invocation.getArgument(0));
            return 1;
        });
        when(persistence.selectOne(any())).thenAnswer(invocation -> currentRow.get());
        when(persistence.selectById(anyLong())).thenAnswer(invocation -> currentRow.get());
        doAnswer(invocation -> { suspended.add(invocation.<Execution>getArgument(0).getId()); return null; })
                .when(turns).markExecutionWaiting(any());
        doAnswer(invocation -> { finished.add(invocation.<Execution>getArgument(0).getId()); return null; })
                .when(turns).finishExecution(any());
    }

    /** 行写入按当前事务处理：无事务立即生效，有事务则挂到提交后。 */
    private void applyRow(ExecutionPO row) {
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            currentRow.set(row);
            return;
        }
        TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
            @Override public void afterCommit() { currentRow.set(row); }
        });
    }
    /**
     * 假行存储：模拟 execution 表里那一行（含检查点文件标识）。
     *
     * <p>写入答案把最新的 PO 存进来，读答案回同一个 PO —— 这样「保存后按库内引用读文件」
     * 与真实库语义一致，而用例不必启一个真的 SQLite 文件库。</p>
     */
    private final java.util.concurrent.atomic.AtomicReference<ExecutionPO> currentRow =
            new java.util.concurrent.atomic.AtomicReference<>(statusRow(ExecutionStatusCodes.RUNNING, 1L));
    private final java.nio.file.Path dataDir = ExecutionRepositoryTestFactory.tempDataDir();
    private final LocalFileCheckpointStore checkpointStore =
            new LocalFileCheckpointStore(dataDir.toString(), mapper);
    private final LocalExecutionRepository repository =
            new LocalExecutionRepository(new ExecutionCheckpointService(new ExecutionRepositoryImpl(persistence), mock(ApplicationEventPublisher.class)), mapper,
                    checkpointStore,
                    provider(new ExecutionLifecycleProjection(
                            provider(readiness), provider(tools), provider(subExecutionLifecycle),
                            provider(sessions), provider(turns), provider(runtimeEvents), provider(wakeups),
                            provider(mock(com.summit.dp.execution.domain.repository.ExecutionRepository.class)))), new MailReceiptFlusherStub());

    private static Execution execution() {
        List<Message> history = List.of(UserMessageEntity.from("hi"),
                SystemMessageEntity.builder().text("suspended").build());
        AgentRequest request = AgentRequest.builder().executionId("305").contextSpec(ContextSpec.builder().context(history).build())
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, "405")).build()).build();
        return Execution.builder().id("305").agentId("chatAgent").agentRequest(request)
                .executionState(ExecutionState.SUSPENDED).messages(history).build();
    }

    @Test
    void releaseRechecksAfterWaitingProjectionAndOutsideTheGate() {
        // 自动唤醒由投影触发：唤醒服务在装配时就固定在投影里，用例直接观察它。
        repository.save(execution());
        ExecutionControlSignal signal = repository.register("305");
        doAnswer(call -> {
            assertFalse(Thread.holdsLock(ExecutionCoordination.monitor("305")));
            assertFalse(repository.isActive("305"));
            verify(readiness).markReady("305");
            verify(turns).markExecutionWaiting(any());
            return null;
        }).when(wakeups).resumeIfInputPending(305L);
        repository.unregister(signal);
        verify(wakeups).resumeIfInputPending(305L);
    }

    @Test
    void failureBeforeControlRegistrationAlsoRechecksAfterClosure() {
        // 自动唤醒由投影触发：唤醒服务在装配时就固定在投影里，用例直接观察它。
        repository.save(execution());
        Execution failed = execution();
        failed.fail("执行初始化失败");
        repository.save(failed);
        verify(turns).finishExecution(any());
        verify(wakeups).resumeIfInputPending(305L);
    }

    @Test
    void terminalReleaseRechecksAfterTurnClosure() {
        // 自动唤醒由投影触发：唤醒服务在装配时就固定在投影里，用例直接观察它。
        repository.save(execution());
        ExecutionControlSignal signal = repository.register("305");
        Execution completed = execution();
        completed.setExecutionState(ExecutionState.COMPLETED);
        repository.save(completed);
        doAnswer(call -> {
            assertFalse(repository.isActive("305"));
            verify(turns).finishExecution(any());
            return null;
        }).when(wakeups).resumeIfInputPending(305L);
        repository.unregister(signal);
        verify(wakeups).resumeIfInputPending(305L);
    }

    @Test
    void cancelIntentBeforeRegistrationStopsTheNewControlSignal() {
        repository.save(execution());
        SessionExecutionRegistry registry = new SessionExecutionRegistry();
        registry.cancelRoot(405L);
        ReflectionTestUtils.setField(repository, "executionRegistry", registry);
        assertTrue(repository.register("305").isCancelRequired());
    }

    @Test
    void cancellationBeforeFirstRunClosesTheCreatedExecutionWithoutWaitingForAWakeup() {
        Execution created = execution();
        created.setExecutionState(ExecutionState.CREATED);
        repository.save(created);

        repository.requireCancel("305");

        assertEquals(ExecutionState.CANCELLED, repository.findById("305").orElseThrow().getExecutionState());
        assertFalse(repository.isActive("305"));
        assertThrows(IllegalStateException.class, () -> repository.register("305"));
        verify(tools).cancelPendingToolCalls("305");
        verify(turns).finishExecution(any());
        verify(runtimeEvents).onExecutionCancelled(any());
    }

    @ParameterizedTest
    @ValueSource(longs = {405L, 406L})
    void terminalCancellationDropsSlotsRestoredFromStaleSummaries(long sessionId) {
        Execution completed = execution();
        completed.setExecutionState(ExecutionState.COMPLETED);
        InputAutomationPolicy.putAttribute(completed, ExecutionAttributes.SESSION_ID, sessionId);
        InputAutomationPolicy.putAttribute(completed, ExecutionAttributes.ROOT_SESSION_ID, 405L);
        repository.save(completed);
        SessionExecutionRegistry registry = (SessionExecutionRegistry) ReflectionTestUtils.getField(repository, "executionRegistry");
        registry.restoreExecution(405L, sessionId, "305");

        repository.requireCancel("305");

        assertFalse(registry.hasUnfinishedChildren(405L));
        assertDoesNotThrow(() -> registry.beginRoot(405L, "306"));
        verifyNoInteractions(runtimeEvents, tools, turns);
    }

    @Test
    void pauseAfterEnqueuePreventsControlRegistrationAndPreservesPendingSnapshot() {
        repository.save(execution());
        repository.requireSuspend("305");
        assertThrows(IllegalStateException.class, () -> repository.register("305"));
        assertFalse(repository.isActive("305"));
        assertEquals(ExecutionState.SUSPENDED, repository.findById("305").orElseThrow().getExecutionState());
    }

    @Test
    void userPauseIsPersistedBeforeReleaseRecheck() {
        repository.save(execution());
        ExecutionControlSignal signal = repository.register("305");
        signal.requireSuspend();
        repository.save(execution());
        Execution restored = repository.findById("305").orElseThrow();
        assertEquals(true, InputAutomationPolicy.attributes(restored).get(InputAutomationPolicy.USER_PAUSED));
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
        restored.getAgentRequest().getContextSpec().getContext().add(UserMessageEntity.from("request appended"));
        assertEquals(3, restored.getMessages().size());
        assertEquals(3, restored.getAgentRequest().getContextSpec().getContext().size());
        assertEquals(2, repository.findById("305").orElseThrow().getMessages().size());
        verify(persistence).update(any(ExecutionPO.class), any());
    }

    @Test
    void coldRepositoryRestoresPersistedCheckpointFile() {
        ExecutionPO row = new ExecutionPO();
        row.setId(305L);
        row.setStatus(ExecutionStatusCodes.SUSPENDED);
        row.setVersion(1L);
        row.setSessionId(405L);
        row.setSnapshotFile(publishCheckpoint(execution()));
        when(persistence.selectById(305L)).thenReturn(row);
        Execution restored = repository.findById("305").orElseThrow();
        assertInstanceOf(UserMessageEntity.class, restored.getMessages().getFirst());
        assertEquals(405L, ExecutionIdentity.sessionId(restored));
        assertDoesNotThrow(() -> restored.getMessages().add(UserMessageEntity.from("next")));
    }

    @Test
    void startupTerminalSummaryPreventsRestoringOldRunningSnapshot() {
        Execution interrupted = execution();
        interrupted.start();
        ExecutionPO row = new ExecutionPO();
        row.setId(305L);
        row.setStatus(4);
        row.setVersion(2L);
        row.setSnapshotFile(publishCheckpoint(interrupted));
        when(persistence.selectById(305L)).thenReturn(row);

        assertEquals(ExecutionState.FAILED, repository.findById("305").orElseThrow().getExecutionState());
        assertThrows(IllegalStateException.class, () -> repository.register("305"));
        assertFalse(repository.isActive("305"));
    }

    /** 直接往存储端口写一份已发布的检查点文件，返回它的文件标识。 */
    private String publishCheckpoint(Execution execution) {
        com.summit.dp.execution.application.port.ExecutionCheckpointStore.CheckpointWriter writer =
                checkpointStore.begin(execution.getId());
        try {
            mapper.writeValue(writer.stream(), execution);
            writer.publish();
        } catch (java.io.IOException e) {
            throw new IllegalStateException("写测试检查点失败", e);
        }
        String fileId = writer.fileId();
        writer.complete();
        return fileId;
    }

    @Test
    void createsAndUpdatesUsingExistingMapper() throws Exception {
        // 首次创建：表里还没有这一行。
        currentRow.set(null);
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
        // 落库的是文件标识，不是正文：正文必须在文件里且能按该标识读回。
        String insertedFile = inserted.getValue().getSnapshotFile();
        assertNotNull(insertedFile, "创建检查点必须提交文件标识");
        assertEquals(ExecutionState.CREATED,
                checkpointStore.read("305", insertedFile, Execution.class).getExecutionState());

        source.suspend();
        repository.save(source);
        ArgumentCaptor<ExecutionPO> updated = ArgumentCaptor.forClass(ExecutionPO.class);
        verify(persistence).update(updated.capture(), any());
        assertEquals(2, updated.getValue().getStatus());
        assertEquals(305L, updated.getValue().getId());
        assertNull(updated.getValue().getSessionId());
        assertNotEquals(insertedFile, updated.getValue().getSnapshotFile(), "每次保存都是新的独立文件");
    }

    @Test
    void committedSaveBecomesVisibleOnlyAfterCommit() {
        repository.save(execution());
        repository.register("305");
        Execution changed = execution();
        changed.setMessages(List.of(UserMessageEntity.from("committed")));
        TransactionSynchronizationManager.initSynchronization();
        try {
            repository.save(changed);
            // 提交前：库内仍指向旧文件，读到的还是旧内容（没有应用级正文缓存兜着）。
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
    void rolledBackTerminalSaveKeepsPreviousCheckpointAndDeletesNewFile() {
        repository.save(execution());
        repository.register("305");
        Execution finished = execution();
        finished.complete();
        String previousFile = currentRow.get().getSnapshotFile();
        clearInvocations(persistence);
        String newFile;
        TransactionSynchronizationManager.initSynchronization();
        try {
            repository.save(finished);
            ArgumentCaptor<ExecutionPO> saved = ArgumentCaptor.forClass(ExecutionPO.class);
            verify(persistence).update(saved.capture(), any());
            newFile = saved.getValue().getSnapshotFile();
            // 事务未提交：库内引用还是旧文件。
            assertEquals(previousFile, currentRow.get().getSnapshotFile());
            for (TransactionSynchronization synchronization : TransactionSynchronizationManager.getSynchronizations()) {
                synchronization.afterCompletion(TransactionSynchronization.STATUS_ROLLED_BACK);
            }
        } finally {
            TransactionSynchronizationManager.clearSynchronization();
        }
        // 回滚：库内仍指向旧文件且旧检查点可读，本次新文件必须被删掉。
        assertEquals(previousFile, currentRow.get().getSnapshotFile());
        assertEquals(ExecutionState.SUSPENDED, repository.findById("305").orElseThrow().getExecutionState());
        assertNotEquals(previousFile, newFile);
        assertThrows(IllegalStateException.class, () -> checkpointStore.read("305", newFile, Execution.class));
        assertNotNull(checkpointStore.read("305", previousFile, Execution.class));
    }

    @Test
    void committedTerminalSaveIsReadBackFromCommittedFile() {
        repository.save(execution());
        repository.register("305");
        Execution finished = execution();
        finished.complete();
        ExecutionPO previous = currentRow.get();
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
        // 终态保存提交后：正文仍在文件里（历史与收尸都要读得到），旧文件按提交结果回收。
        assertEquals(ExecutionState.COMPLETED, repository.findById("305").orElseThrow().getExecutionState());
        assertThrows(IllegalStateException.class,
                () -> checkpointStore.read("305", previous.getSnapshotFile(), Execution.class));
        verify(persistence, atLeastOnce()).selectById(305L);
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
    void stoppingOrphanedRunningExecutionClosesTheTurnAndPublishesCancellationOnce() {
        Execution source = execution();
        source.resumeChecked();
        repository.save(source);

        repository.requireCancel("305");
        repository.requireCancel("305");

        assertEquals(ExecutionState.CANCELLED, repository.findById("305").orElseThrow().getExecutionState());
        assertEquals(List.of("305"), finished);
        verify(subExecutionLifecycle).onFinished(any());
        verify(runtimeEvents).onExecutionCancelled(any());
        assertThrows(IllegalStateException.class, () -> repository.register("305"));
    }

    @Test
    void suspendedCancellationPublishesAccumulatedUsageOnceAfterClosure() {
        Execution source = execution();
        source.getAgentRequest().runtimeParametersOrDefault().setEventMetaData(
                Map.of("rootSessionId", "405", "sessionId", "405", "turnId", "7001"));
        source.setTokenUsage(new TokenUsageEntity(150, new TokenUsageEntity.InputTokens(100, 70),
                new TokenUsageEntity.OutputTokens(50, 20)));
        repository.save(source);
        doAnswer(invocation -> {
            ExecutionPO row = invocation.getArgument(0);
            when(persistence.selectById(305L)).thenReturn(row);
            return 1;
        }).when(persistence).update(any(ExecutionPO.class), any());
        ChatTurnService usageService = mock(ChatTurnService.class);
        ChatTurnRuntimeListener listener = new ChatTurnRuntimeListener(usageService);
        doAnswer(invocation -> {
            listener.onExecutionCancelled(invocation.getArgument(0));
            return null;
        }).when(runtimeEvents).onExecutionCancelled(any());

        repository.requireCancel("305");
        repository.requireCancel("305");

        ArgumentCaptor<ExecutionCancelledEvent> event = ArgumentCaptor.forClass(ExecutionCancelledEvent.class);
        InOrder order = inOrder(turns, runtimeEvents);
        order.verify(turns).finishExecution(any());
        order.verify(runtimeEvents).onExecutionCancelled(event.capture());
        assertEquals("305", event.getValue().executionId());
        assertEquals(new TokenInfo(100, 50, 150, 20, 70), event.getValue().getTokenInfo());
        assertEquals(source.eventMetaData(), event.getValue().eventMetaData());
        verify(usageService).refreshUsage("305", 100L, 50L, 150L, 70L, 20L, 405L);
        verify(runtimeEvents, times(1)).onExecutionCancelled(any());
    }

    @Test
    void suspendedCancellationPublishesOnlyAfterCommitAndNotAfterRollback() {
        for (boolean commit : new boolean[]{false, true}) {
            // 表里先有一份已提交的检查点：回滚时库内引用不变，仍然读得到这份旧文件。
            ExecutionPO seeded = statusRow(ExecutionStatusCodes.SUSPENDED, 1L);
            seeded.setSnapshotFile(publishCheckpoint(execution()));
            currentRow.set(seeded);
            clearInvocations(runtimeEvents, turns);
            TransactionSynchronizationManager.initSynchronization();
            try {
                repository.requireCancel("305");
                verifyNoInteractions(runtimeEvents, turns);
                for (TransactionSynchronization synchronization : TransactionSynchronizationManager.getSynchronizations()) {
                    if (commit) synchronization.afterCommit();
                    else synchronization.afterCompletion(TransactionSynchronization.STATUS_ROLLED_BACK);
                }
                if (commit) {
                    verify(turns).finishExecution(any());
                    ArgumentCaptor<ExecutionCancelledEvent> event = ArgumentCaptor.forClass(ExecutionCancelledEvent.class);
                    verify(runtimeEvents).onExecutionCancelled(event.capture());
                    assertNull(event.getValue().getTokenInfo(), "未采集用量不能补零");
                } else {
                    verifyNoInteractions(runtimeEvents, turns);
                    assertEquals(ExecutionState.SUSPENDED, repository.findById("305").orElseThrow().getExecutionState());
                }
            } finally {
                TransactionSynchronizationManager.clearSynchronization();
            }
        }
    }

    @Test
    void cancellationAtSuspendedSlotReleasePublishesUsageAfterCommit() {
        Execution source = execution();
        source.setTokenUsage(TokenUsageEntity.of(150, 100, 50));
        repository.save(source);
        ExecutionControlSignal signal = repository.register("305");
        repository.requireCancel("305");
        verifyNoInteractions(runtimeEvents);

        TransactionSynchronizationManager.initSynchronization();
        try {
            repository.unregister(signal);
            verifyNoInteractions(runtimeEvents, turns);
            for (TransactionSynchronization synchronization : TransactionSynchronizationManager.getSynchronizations()) {
                synchronization.afterCommit();
            }
            ArgumentCaptor<Execution> closed = ArgumentCaptor.forClass(Execution.class);
            verify(turns).finishExecution(closed.capture());
            assertEquals(ExecutionState.CANCELLED, closed.getValue().getExecutionState());
            ArgumentCaptor<ExecutionCancelledEvent> event = ArgumentCaptor.forClass(ExecutionCancelledEvent.class);
            verify(runtimeEvents).onExecutionCancelled(event.capture());
            assertEquals(new TokenInfo(100, 50, 150, 0, 0), event.getValue().getTokenInfo());
            assertEquals(List.of(), suspended);
        } finally {
            TransactionSynchronizationManager.clearSynchronization();
        }
    }

    @Test
    void activeLoopCancellationKeepsEventOwnershipInFramework() {
        repository.save(execution());
        ExecutionControlSignal signal = repository.register("305");
        repository.requireCancel("305");
        assertTrue(signal.isCancelRequired());
        verifyNoInteractions(runtimeEvents);

        Execution cancelled = execution();
        cancelled.cancelChecked();
        repository.save(cancelled);
        ArgumentCaptor<ExecutionPO> saved = ArgumentCaptor.forClass(ExecutionPO.class);
        verify(persistence, times(2)).update(saved.capture(), any());
        when(persistence.selectById(305L)).thenReturn(saved.getValue());
        repository.unregister(signal);

        verify(turns).finishExecution(any());
        verifyNoInteractions(runtimeEvents);
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
        LocalExecutionRepository isolated = new LocalExecutionRepository(new ExecutionCheckpointService(new ExecutionRepositoryImpl(persistence), mock(ApplicationEventPublisher.class)), mapper,
                checkpointStore,
                provider(new ExecutionLifecycleProjection(provider(failing), provider(tools),
                        provider(subExecutionLifecycle), provider(sessions), provider(turns), provider(runtimeEvents),
                        provider(mock(InputWakeupService.class)),
                        provider(mock(com.summit.dp.execution.domain.repository.ExecutionRepository.class)))), new MailReceiptFlusherStub());
        doAnswer(invocation -> {
            assertTrue(Thread.holdsLock(ExecutionCoordination.monitor("305")));
            assertFalse(isolated.isActive("305"));
            throw new IllegalStateException("卡片开放失败");
        }).when(failing).markReady("305");
        isolated.save(execution());
        ExecutionControlSignal signal = isolated.register("305");
        assertTrue(isolated.isActive("305"));
        assertDoesNotThrow(() -> isolated.unregister(signal));
        assertFalse(isolated.isActive("305"));
        assertEquals(List.of("305"), suspended);

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
            assertTrue(repository.isActive("305"));
            verifyNoInteractions(readiness, subExecutionLifecycle, turns, tools, sessions);
            for (TransactionSynchronization synchronization : TransactionSynchronizationManager.getSynchronizations()) {
                synchronization.afterCompletion(TransactionSynchronization.STATUS_ROLLED_BACK);
            }
            verifyNoInteractions(readiness, subExecutionLifecycle, turns, tools, sessions);
        } finally {
            TransactionSynchronizationManager.clearSynchronization();
        }

        signal = repository.register("305");
        TransactionSynchronizationManager.initSynchronization();
        try {
            repository.unregister(signal);
            verifyNoInteractions(readiness, subExecutionLifecycle, turns, tools, sessions);
            for (TransactionSynchronization synchronization : TransactionSynchronizationManager.getSynchronizations()) {
                synchronization.afterCommit();
            }
            verify(readiness).markReady("305");

            assertEquals(List.of("305"), suspended);
        } finally {
            TransactionSynchronizationManager.clearSynchronization();
        }
    }

    @Test
    void terminalServiceFailuresAbortSuccessPublicationInsteadOfLosingClosure() {
        repository.save(execution());
        doThrow(new IllegalStateException("工具收口失败")).when(tools).cancelPendingToolCalls("305");
        doThrow(new IllegalStateException("委派回填失败")).when(subExecutionLifecycle).onFinished(any());
        doThrow(new IllegalStateException("会话用量保存失败")).when(sessions).saveExecutionContextUsage(any());

        assertDoesNotThrow(() -> repository.requireCancel("305"));

        // 第一步（收口工具卡片）就是必须步骤：失败后整条链中断，不得再把轮次标成正常结束。
        verify(tools).cancelPendingToolCalls("305");
        verify(subExecutionLifecycle, never()).onFinished(any());
        verify(sessions, never()).saveExecutionContextUsage(any());
        verify(turns, never()).finishExecution(any());
        assertTrue(finished.isEmpty(), "收口不完整时不得把轮次标成终态 —— 那正是用户可见的成功假象");
    }

    @Test
    void initializationFailureServicesWaitForCheckpointCommit() {
        when(persistence.selectOne(any())).thenReturn(statusRow(ExecutionStatusCodes.CREATED, 1L));
        Execution failed = execution();
        failed.fail("初始化失败");
        TransactionSynchronizationManager.initSynchronization();
        try {
            repository.save(failed);
            verifyNoInteractions(readiness, subExecutionLifecycle, turns, tools, sessions);
            for (TransactionSynchronization synchronization : TransactionSynchronizationManager.getSynchronizations()) {
                synchronization.afterCommit();
            }
            verify(tools).cancelPendingToolCalls("305");
            verify(subExecutionLifecycle).onFinished(same(failed));
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
