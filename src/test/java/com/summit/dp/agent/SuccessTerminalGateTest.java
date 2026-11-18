package com.summit.dp.agent;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.ExecutionCompleteEvent;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.transaction.RuntimeTransactionalSupport;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionRepositoryTestFactory;
import com.summit.dp.execution.MailReceiptFlusherStub;
import com.summit.dp.execution.application.service.ExecutionCheckpointService;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.session.application.service.SessionTokenAuditCollector;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.application.service.impl.ChatTurnServiceImpl;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import com.summit.dp.turn.domain.model.TurnModelSnapshot;
import com.summit.dp.turn.infrastructure.persistence.mapper.ChatTurnMapper;
import com.summit.dp.turn.infrastructure.persistence.po.ChatTurnPO;
import com.summit.dp.turn.infrastructure.persistence.repository.ChatTurnRepositoryImpl;
import com.summit.dp.workflow.application.decision.ToolCallReadinessService;
import com.summit.dp.workflow.application.input.InputWakeupService;
import com.summit.dp.workflow.application.lifecycle.ExecutionLifecycleProjection;
import com.summit.dp.workflow.application.projection.ChatTurnLifecycleProjector;
import com.summit.dp.workflow.application.projection.SessionContextUsageProjector;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
import com.summit.dp.workflow.infrastructure.listener.agent.AgentEventListener;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.file.Path;
import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Callable;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/**
 * 必须步骤失败时，框架的成功终态在事务收尾源头即被阻断，无需通知层再查库拦一道。
 *
 * <p><b>为什么不再需要通知层查库门禁</b>：框架的 {@code RuntimeProcessorTemplate} 在 {@code finally} 里
 * 把 {@code finalizeWithTransaction(execution, control)} 与 {@code notifyTerminal(pe)} 串联在同一任务内。
 * {@code finalizeWithTransaction} 提交检查点事务（终态与 {@code closure_pending = 1} 落库）后触发
 * {@code unregister} 的 {@code afterCommit} 回调；一旦必须步骤抛出
 * {@link ExecutionLifecycleProjection.ExecutionClosureFailure}，异常从 {@code finalizeWithTransaction}
 * 向上抛出（不会回滚已提交的检查点），直接跳过随后的 {@code notifyTerminal(pe)}。</p>
 *
 * <p>本用例走真实链路：真 H2 + 真事务模板（{@link RuntimeTransactionalSupport}）+ 真仓储的
 * {@code save / unregister} → 真 {@link ExecutionLifecycleProjection}（轮次收口注入失败）→
 * 真 {@link RuntimeEventPublisher} + 真 {@link AgentEventListener} → 断言「框架终态在源头被阻断，
 * 补偿收口后补发且只发一次」。</p>
 */
class SuccessTerminalGateTest {

    private static final long EXECUTION_ID = 960_001L;
    private static final String EXECUTION_ID_TEXT = String.valueOf(EXECUTION_ID);
    private static final long TURN_ID = 960_002L;
    private static final long SESSION_ID = 960_003L;
    private static final long ROOT_SESSION_ID = 960_004L;

    private H2TestDatabase database;
    private ExecutionMapper executionMapper;
    private ChatTurnMapper chatTurnMapper;
    private ExecutionRepositoryImpl executions;
    private LocalExecutionRepository runtime;
    private RuntimeTransactionalSupport transactionalSupport;
    private SseEventPublisher ssePublisher;
    private AgentEventListener agentEvents;
    private RuntimeEventPublisher events;
    private ChatTurnService realTurns;
    private AtomicBoolean turnFailureActive;
    private Path checkpointDir;

    @BeforeEach
    void setup() {
        database = H2TestDatabase.create("SuccessTerminalGateTest");
        executionMapper = H2TestDatabase.sqlSession(database.sessionFactory(ExecutionMapper.class))
                .getMapper(ExecutionMapper.class);
        chatTurnMapper = H2TestDatabase.sqlSession(database.sessionFactory(ChatTurnMapper.class))
                .getMapper(ChatTurnMapper.class);
        executions = new ExecutionRepositoryImpl(executionMapper);
        checkpointDir = ExecutionRepositoryTestFactory.tempDataDir();

        TransactionTemplate transactionTemplate = new TransactionTemplate(new DataSourceTransactionManager(database));
        transactionalSupport = new RuntimeTransactionalSupport() {
            @Override
            public <T> T execute(Callable<T> callback) {
                return transactionTemplate.execute(status -> {
                    try {
                        return callback.call();
                    } catch (RuntimeException e) {
                        throw e;
                    } catch (Exception e) {
                        throw new IllegalStateException(e);
                    }
                });
            }
        };

        turnFailureActive = new AtomicBoolean(true);
        realTurns = new ChatTurnServiceImpl(new ChatTurnRepositoryImpl(chatTurnMapper));
        // 轮次收口注入失败：模拟「必须步骤失败」，其余轮次动作仍走真实实现。
        ChatTurnService failingTurns = new DelegatingFailingTurnService(realTurns, turnFailureActive);

        ssePublisher = mock(SseEventPublisher.class);
        ExecutionLocator locator = mock(ExecutionLocator.class);
        when(locator.sessionId(EXECUTION_ID_TEXT)).thenReturn(SESSION_ID);
        when(locator.resolveRootSessionId(SESSION_ID)).thenReturn(ROOT_SESSION_ID);
        agentEvents = new AgentEventListener(new JsonConfig().objectMapper(), ssePublisher,
                locator, mock(SessionTokenAuditCollector.class));
        events = new RuntimeEventPublisher(List.of(agentEvents));

        runtime = ExecutionRepositoryTestFactory.create(
                new ExecutionCheckpointService(executions, mock(ApplicationEventPublisher.class)),
                new JsonConfig().objectMapper(),
                new LocalFileCheckpointStore(checkpointDir.toString(), new JsonConfig().objectMapper()),
                provider(projection(failingTurns)), new MailReceiptFlusherStub());
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("收口失败：事务已提交终态与待收口位 1，源头阻断成功终态；解除故障后补偿补发一次且仅一次")
    void successPublishAbortedAtFinalizeSourceAndCompensatedOnce() {
        seedRunningTurn();
        runtime.save(execution(ExecutionState.CREATED));
        ExecutionControlSignal signal = runtime.register(EXECUTION_ID_TEXT);

        // 对齐 RuntimeProcessorTemplate#finally：finalizeWithTransaction 与 notifyTerminal 顺序串联。
        assertThrows(ExecutionLifecycleProjection.ExecutionClosureFailure.class,
                () -> finalizeAndNotifyTerminal(signal));

        assertEquals(Integer.valueOf(1), closurePending(),
                "检查点事务已提交，轮次收口失败必须留下可重试的待收口事实");
        verify(ssePublisher, never()).publish(anyLong(), any(ExecutionCompleteEvent.class));
        verify(ssePublisher, never()).publishBusiness(anyLong(), anyString(), any());
        assertEquals("RUNNING", turnStatus(), "轮次没收口：源头阻断终态后前端不会看到假完成");

        // 故障解除：补偿收口一次，成功终态正常补发（且只发一次）。
        turnFailureActive.set(false);
        projection(realTurns).completeClosure(execution(ExecutionState.COMPLETED), false, true);
        assertEquals(Integer.valueOf(0), closurePending(), "补偿成功后待收口位必须清零");
        assertEquals("COMPLETED", turnStatus(), "补偿成功后轮次必须收口");
        verify(ssePublisher, times(1)).publish(eq(ROOT_SESSION_ID), any(ExecutionCompleteEvent.class));

        // 再次跑补偿：clearClosurePending 返回 false（已是 0），绝不重复补发。
        projection(realTurns).completeClosure(execution(ExecutionState.COMPLETED), false, true);
        verify(ssePublisher, times(1)).publish(eq(ROOT_SESSION_ID), any(ExecutionCompleteEvent.class));
    }

    @Test
    @DisplayName("收口成功：待收口位清为 0，框架终态正常发出")
    void successPublishPassesWhenClosureSucceeds() {
        turnFailureActive.set(false);
        seedRunningTurn();
        runtime.save(execution(ExecutionState.CREATED));
        ExecutionControlSignal signal = runtime.register(EXECUTION_ID_TEXT);

        assertDoesNotThrow(() -> finalizeAndNotifyTerminal(signal));

        assertEquals(Integer.valueOf(0), closurePending());
        assertEquals("COMPLETED", turnStatus());
        verify(ssePublisher, times(1)).publish(eq(ROOT_SESSION_ID), any(ExecutionCompleteEvent.class));
    }

    // ------------------------------------------------------------------
    // 夹具
    // ------------------------------------------------------------------

    /** 对齐 RuntimeProcessorTemplate：finalizeWithTransaction 抛错即跳过 notifyTerminal。 */
    private void finalizeAndNotifyTerminal(ExecutionControlSignal signal) {
        transactionalSupport.execute(() -> {
            runtime.save(execution(ExecutionState.COMPLETED));
            runtime.unregister(signal);
            return null;
        });
        runtime.afterCommit(() -> events.onExecutionComplete(new ExecutionCompleteEvent(EXECUTION_ID_TEXT, null)));
    }

    /** 一条在跑的业务轮次：收口成功时它应变成 COMPLETED。 */
    private void seedRunningTurn() {
        chatTurnMapper.insert(ChatTurnPO.builder().id(TURN_ID).version(1L).sessionId(SESSION_ID)
                .executionId(EXECUTION_ID).status("RUNNING").createdAt(Instant.now()).build());
    }

    private Execution execution(ExecutionState state) {
        Map<String, Object> attributes = Map.of(
                ExecutionAttributes.SESSION_ID, String.valueOf(SESSION_ID),
                ExecutionAttributes.ROOT_SESSION_ID, String.valueOf(ROOT_SESSION_ID));
        return Execution.builder().id(EXECUTION_ID_TEXT).agentId("chatAgent")
                .executionState(state)
                .agentRequest(AgentRequest.builder().executionId(EXECUTION_ID_TEXT)
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes).build())
                        .build())
                .build();
    }

    private ExecutionLifecycleProjection projection(ChatTurnService turns) {
        return new ExecutionLifecycleProjection(
                provider(mock(ToolCallReadinessService.class)),
                provider(mock(ToolCallService.class)),
                provider(mock(SubExecutionLifecycle.class)),
                provider(mock(SessionContextUsageProjector.class)),
                provider(new ChatTurnLifecycleProjector(turns)),
                provider(events),
                provider(mock(InputWakeupService.class)),
                provider(executions));
    }

    private Integer closurePending() {
        ExecutionPO row = executionMapper.selectById(EXECUTION_ID);
        assertNotNull(row, "执行行必须存在");
        return row.getClosurePending();
    }

    private String turnStatus() {
        ChatTurnPO row = chatTurnMapper.selectById(TURN_ID);
        assertNotNull(row, "轮次行必须存在");
        return row.getStatus();
    }

    private static <T> ObjectProvider<T> provider(T service) {
        return new StaticListableBeanFactory(Map.of("value", service)).getBeanProvider((Class<T>) Object.class);
    }

    /**
     * 只让「收口业务轮次」失败的委托：其余动作照常转发到真实服务。
     */
    private static final class DelegatingFailingTurnService implements ChatTurnService {
        private final ChatTurnService delegate;
        private final AtomicBoolean failing;

        private DelegatingFailingTurnService(ChatTurnService delegate, AtomicBoolean failing) {
            this.delegate = delegate;
            this.failing = failing;
        }

        @Override
        public long acceptTurn(long sessionId, Long rootSessionId, Long parentTurnId, Long executionId,
                               TurnModelSnapshot model) {
            return delegate.acceptTurn(sessionId, rootSessionId, parentTurnId, executionId, model);
        }

        @Override
        public long acceptTurn(long sessionId, Long rootSessionId, Long parentTurnId, Long executionId,
                               TurnModelSnapshot model, String commandId,
                               String commandDigest) {
            return delegate.acceptTurn(sessionId, rootSessionId, parentTurnId, executionId, model,
                    commandId, commandDigest);
        }

        @Override
        public Optional<ChatTurn> findByCommandId(String commandId) {
            return delegate.findByCommandId(commandId);
        }

        @Override
        public void markRunning(String executionId, Instant startedAt, Long rootSessionId) {
            delegate.markRunning(executionId, startedAt, rootSessionId);
        }

        @Override
        public Optional<ChatTurn> findByExecutionId(Long executionId) {
            return delegate.findByExecutionId(executionId);
        }

        @Override
        public Map<Long, ChatTurn> findByIds(Collection<Long> turnIds) {
            return delegate.findByIds(turnIds);
        }

        @Override
        public void markWaiting(String executionId, Long rootSessionId) {
            delegate.markWaiting(executionId, rootSessionId);
        }

        @Override
        public void markTerminal(String executionId,
                                 ChatTurnStatus terminalStatus,
                                 Long inputTokens, Long outputTokens, Long totalTokens,
                                 Instant completedAt, Long rootSessionId) {
            if (failing.get()) {
                throw new IllegalStateException("注入的轮次收口失败");
            }
            delegate.markTerminal(executionId, terminalStatus, inputTokens, outputTokens, totalTokens,
                    completedAt, rootSessionId);
        }

        @Override
        public void refreshUsage(String executionId, Long inputTokens, Long outputTokens, Long totalTokens,
                                 Long cacheTokens, Long reasoningTokens, Long rootSessionId) {
            delegate.refreshUsage(executionId, inputTokens, outputTokens, totalTokens, cacheTokens,
                    reasoningTokens, rootSessionId);
        }

        @Override
        public void recordFailureReason(String executionId, String reason, Long rootSessionId) {
            delegate.recordFailureReason(executionId, reason, rootSessionId);
        }

        @Override
        public int reapOrphans() {
            return delegate.reapOrphans();
        }

        @Override
        public Map<Long, ChatTurn> findByExecutionIds(Collection<Long> executionIds) {
            return delegate.findByExecutionIds(executionIds);
        }

        @Override
        public List<ChatTurn> findActiveBySessionIds(Collection<Long> sessionIds) {
            return delegate.findActiveBySessionIds(sessionIds);
        }

        @Override
        public List<ChatTurn> rollbackFrom(long sessionId, long fromTurnId) {
            return delegate.rollbackFrom(sessionId, fromTurnId);
        }
    }
}
