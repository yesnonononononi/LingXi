import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.ExecutionCompleteEvent;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.application.service.ExecutionCheckpointService;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.execution.infrastructure.checkpoint.LocalFileCheckpointStore;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.execution.MailReceiptFlusherStub;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.infrastructure.persistence.mapper.ChatTurnMapper;
import com.summit.dp.turn.infrastructure.persistence.po.ChatTurnPO;
import com.summit.dp.turn.infrastructure.persistence.repository.ChatTurnRepositoryImpl;
import com.summit.dp.turn.application.service.impl.ChatTurnServiceImpl;
import com.summit.dp.workflow.application.approval.ToolCallReadinessService;
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
import org.mockito.ArgumentMatchers;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.transaction.PlatformTransactionManager;

import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 必须步骤失败时，框架的成功终态不许漏出去。
 *
 * <p><b>为什么只能靠通知层判据</b>：框架的 {@code RuntimeProcessorTemplate} 在 {@code finally} 里用
 * {@code RuntimeUtil.runAll(...)} 跑 {@code save → unregister → publish → 成功终态}，而
 * {@code runAll} 是<b>逐任务 catch</b> 的：让收口异常向上抛只会被吞掉，第 6 步照样执行；
 * 把投影塞进状态提交事务则会让执行停在非终态、更糟。所以判据落在业务侧自己的终态发布入口
 * （{@link com.summit.dp.workflow.infrastructure.listener.agent.AgentEventListener}）。</p>
 *
 * <p>本用例走真实链路：真 H2 + 真仓储的 {@code save / unregister} → 真
 * {@link ExecutionLifecycleProjection}（轮次收口注入失败）→ 真
 * {@link RuntimeEventPublisher} + 真监听器 → 断言「框架那条成功终态没有发出」。</p>
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
        checkpointDir = com.summit.dp.execution.ExecutionRepositoryTestFactory.tempDataDir();

        turnFailureActive = new AtomicBoolean(true);
        realTurns = new ChatTurnServiceImpl(new ChatTurnRepositoryImpl(chatTurnMapper));
        // 轮次收口注入失败：模拟「必须步骤失败」，其余轮次动作仍走真实实现。
        ChatTurnService failingTurns = new DelegatingFailingTurnService(realTurns, turnFailureActive);

        ssePublisher = mock(SseEventPublisher.class);
        agentEvents = new AgentEventListener(new JsonConfig().objectMapper(), ssePublisher,
                mock(com.summit.dp.execution.application.service.ExecutionLocator.class), executions);
        events = new RuntimeEventPublisher(List.of(agentEvents));
        agentEvents.init();

        runtime = new LocalExecutionRepository(
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
    @DisplayName("收口失败：框架的成功终态不得发出，待收口位留 1；解除故障后补偿补发一次")
    void successPublishSuppressedWhileClosurePending() {
        seedRunningTurn();
        ExecutionControlSignal signal = runtime.register(EXECUTION_ID_TEXT);
        saveTerminal();

        // 框架的顺序：save → unregister → publish。收口在 unregister 的 afterCommit 里失败。
        runtime.unregister(signal);
        assertEquals(Integer.valueOf(1), closurePending(),
                "轮次收口失败必须留下可重试的待收口事实");

        // 框架随后发布成功终态（这一步框架自己的 runAll 一定会做）。
        events.onExecutionComplete(new ExecutionCompleteEvent(EXECUTION_ID_TEXT, null));

        verify(ssePublisher, never()).publish(anyLong(), any(ExecutionCompleteEvent.class));
        verify(ssePublisher, never()).publishBusiness(anyLong(), anyString(), any());
        assertEquals("RUNNING", turnStatus(), "轮次没收口：界面若收到「完成」就会显示完成而轮次还在转");

        // 故障解除：补偿收口一次，成功终态可以正常发出（且只一次）。
        turnFailureActive.set(false);
        projection(realTurns).completeClosure(execution(ExecutionState.COMPLETED), false, true);
        assertEquals(Integer.valueOf(0), closurePending(), "补偿成功后待收口位必须清零");
        assertEquals("COMPLETED", turnStatus(), "补偿成功后轮次必须收口");
        verify(ssePublisher).publish(anyLong(), any(ExecutionCompleteEvent.class));
    }

    @Test
    @DisplayName("待收口位已为 0 时成功终态照常发出：门禁只拦「收口没做完」")
    void successPublishPassesWhenClosureDone() {
        seedRunningTurn();
        ExecutionControlSignal signal = runtime.register(EXECUTION_ID_TEXT);
        saveTerminal();
        runtime.unregister(signal);
        projection(realTurns).completeClosure(execution(ExecutionState.COMPLETED), false, false);
        assertEquals(Integer.valueOf(0), closurePending());

        events.onExecutionComplete(new ExecutionCompleteEvent(EXECUTION_ID_TEXT, null));

        verify(ssePublisher).publish(anyLong(), any(ExecutionCompleteEvent.class));
    }

    @Test
    @DisplayName("门禁读库失败按「未知即暂缓」处理：不发布成功终态，并留下带 executionId 的中文警告")
    void closurePendingReadFailureDefersSuccess() {
        ExecutionRepositoryImpl unreadableGate = spy(executions);
        doThrow(new IllegalStateException("模拟待收口位读取失败"))
                .when(unreadableGate).isClosurePending(anyLong());
        AgentEventListener deferringListener = listenerWith(unreadableGate);

        Logger logger = (Logger) LoggerFactory.getLogger(AgentEventListener.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            new RuntimeEventPublisher(List.of(deferringListener))
                    .onExecutionComplete(new ExecutionCompleteEvent(EXECUTION_ID_TEXT, null));

            verify(ssePublisher, never()).publish(anyLong(), any(ExecutionCompleteEvent.class));
            verify(ssePublisher, never()).publishBusiness(anyLong(), anyString(), any());

            List<String> messages = appender.list.stream().map(ILoggingEvent::getFormattedMessage).toList();
            assertTrue(messages.stream().anyMatch(message -> message.contains(EXECUTION_ID_TEXT)
                            && message.contains("暂缓发布成功终态")
                            && message.contains("等待权威快照收敛")
                            && message.contains("模拟待收口位读取失败")),
                    "读库失败必须留下带 executionId 与原因的可定位日志: " + messages);
        } finally {
            logger.detachAppender(appender);
        }
    }

    @Test
    @DisplayName("读库恢复且待收口位为 0 后，成功终态正常发出且只发一次")
    void successPublishesOnceAfterGateReadRecovers() {
        seedRunningTurn();
        ExecutionControlSignal signal = runtime.register(EXECUTION_ID_TEXT);
        saveTerminal();
        runtime.unregister(signal);
        assertEquals(Integer.valueOf(1), closurePending(), "夹具前提：收口失败必须留下待收口事实");

        // 第一次读库失败、之后恢复真实读取。
        ExecutionRepositoryImpl recoveringGate = spy(executions);
        doThrow(new IllegalStateException("模拟待收口位读取失败"))
                .doCallRealMethod()
                .when(recoveringGate).isClosurePending(anyLong());
        RuntimeEventPublisher publisher = new RuntimeEventPublisher(List.of(listenerWith(recoveringGate)));

        // ① 读库失败：暂缓，且不得改动待收口事实。
        publisher.onExecutionComplete(new ExecutionCompleteEvent(EXECUTION_ID_TEXT, null));
        verify(ssePublisher, never()).publish(anyLong(), any(ExecutionCompleteEvent.class));
        assertEquals(Integer.valueOf(1), closurePending(), "门禁只读，读失败也不得改动待收口事实");

        // ② 收口仍未完成：恢复可读也不放行。
        publisher.onExecutionComplete(new ExecutionCompleteEvent(EXECUTION_ID_TEXT, null));
        verify(ssePublisher, never()).publish(anyLong(), any(ExecutionCompleteEvent.class));

        // ③ 恢复可读且待收口位已清零：成功终态正常发出一次。
        turnFailureActive.set(false);
        projection(realTurns).completeClosure(execution(ExecutionState.COMPLETED), false, false);
        assertEquals(Integer.valueOf(0), closurePending(), "补偿成功后待收口位必须清零");
        assertEquals("COMPLETED", turnStatus(), "补偿成功后轮次必须收口");

        publisher.onExecutionComplete(new ExecutionCompleteEvent(EXECUTION_ID_TEXT, null));
        verify(ssePublisher, times(1)).publish(anyLong(), any(ExecutionCompleteEvent.class));
    }

    @Test
    @DisplayName("暂缓的那一帧不影响业务事实：补偿入口收敛后由它补发一次，且与轮次终态一致")
    void deferredSuccessFrameConvergesWithBusinessSnapshotAfterCompensation() {
        seedRunningTurn();
        ExecutionControlSignal signal = runtime.register(EXECUTION_ID_TEXT);
        saveTerminal();
        runtime.unregister(signal);

        // 这一路读库始终失败：本次执行的成功终态一直被暂缓。
        ExecutionRepositoryImpl unreadableGate = spy(executions);
        doThrow(new IllegalStateException("模拟待收口位读取失败"))
                .when(unreadableGate).isClosurePending(anyLong());
        RuntimeEventPublisher deferringPublisher = new RuntimeEventPublisher(List.of(listenerWith(unreadableGate)));
        deferringPublisher.onExecutionComplete(new ExecutionCompleteEvent(EXECUTION_ID_TEXT, null));
        verify(ssePublisher, never()).publish(anyLong(), any(ExecutionCompleteEvent.class));

        // 补偿路径（启动收口扫 closure_pending=1 的那条）照旧收敛：收口脚本 + 清位 + 补发被拦下的那一帧。
        turnFailureActive.set(false);
        projection(realTurns).completeClosure(execution(ExecutionState.COMPLETED), false, true);
        assertEquals("COMPLETED", turnStatus(), "缺帧不得影响业务事实落库");
        assertEquals(Integer.valueOf(0), closurePending(), "缺帧不得影响待收口位清零");
        verify(ssePublisher, times(1)).publish(anyLong(), any(ExecutionCompleteEvent.class));
    }

    // ------------------------------------------------------------------
    // 夹具
    // ------------------------------------------------------------------

    /** 一条在跑的业务轮次：收口成功时它应变成 COMPLETED。 */
    private void seedRunningTurn() {
        chatTurnMapper.insert(ChatTurnPO.builder().id(TURN_ID).version(1L).sessionId(SESSION_ID)
                .executionId(EXECUTION_ID).status("RUNNING").createdAt(Instant.now()).build());
    }

    /** 先建行再落成终态，与框架的两步保存一致。 */
    private void saveTerminal() {
        runtime.save(execution(ExecutionState.CREATED));
        runtime.save(execution(ExecutionState.COMPLETED));
    }

    private Execution execution(ExecutionState state) {
        Map<String, Object> attributes = Map.of(
                com.summit.dp.execution.ExecutionAttributes.SESSION_ID, String.valueOf(SESSION_ID),
                com.summit.dp.execution.ExecutionAttributes.ROOT_SESSION_ID, String.valueOf(ROOT_SESSION_ID));
        return Execution.builder().id(EXECUTION_ID_TEXT).agentId("chatAgent")
                .executionState(state)
                .agentRequest(AgentRequest.builder().executionId(EXECUTION_ID_TEXT)
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes).build())
                        .build())
                .build();
    }

    /** 换一个门禁读口构造监听器，用于模拟读库失败 / 恢复。 */
    private AgentEventListener listenerWith(ExecutionRepository gate) {
        AgentEventListener listener = new AgentEventListener(new JsonConfig().objectMapper(),
                ssePublisher, mock(com.summit.dp.execution.application.service.ExecutionLocator.class), gate);
        listener.init();
        return listener;
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
     *
     * <p>注入点选在轮次收口，是因为它正是本项要守的那一步：失败后若成功终态照发，
     * 用户就会看到「完成」而轮次还在 RUNNING。</p>
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
                               com.summit.dp.turn.domain.model.TurnModelSnapshot model) {
            return delegate.acceptTurn(sessionId, rootSessionId, parentTurnId, executionId, model);
        }

        @Override
        public long acceptTurn(long sessionId, Long rootSessionId, Long parentTurnId, Long executionId,
                               com.summit.dp.turn.domain.model.TurnModelSnapshot model, String commandId,
                               String commandDigest) {
            return delegate.acceptTurn(sessionId, rootSessionId, parentTurnId, executionId, model,
                    commandId, commandDigest);
        }

        @Override
        public java.util.Optional<com.summit.dp.turn.domain.model.ChatTurn> findByCommandId(String commandId) {
            return delegate.findByCommandId(commandId);
        }

        @Override
        public void markRunning(String executionId, Instant startedAt, Long rootSessionId) {
            delegate.markRunning(executionId, startedAt, rootSessionId);
        }

        @Override
        public java.util.Optional<com.summit.dp.turn.domain.model.ChatTurn> findByExecutionId(Long executionId) {
            return delegate.findByExecutionId(executionId);
        }

        @Override
        public Map<Long, com.summit.dp.turn.domain.model.ChatTurn> findByIds(java.util.Collection<Long> turnIds) {
            return delegate.findByIds(turnIds);
        }

        @Override
        public void markWaiting(String executionId, Long rootSessionId) {
            delegate.markWaiting(executionId, rootSessionId);
        }

        @Override
        public void markTerminal(String executionId,
                                 com.summit.dp.turn.domain.model.ChatTurnStatus terminalStatus,
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
        public Map<Long, com.summit.dp.turn.domain.model.ChatTurn> findByExecutionIds(
                java.util.Collection<Long> executionIds) {
            return delegate.findByExecutionIds(executionIds);
        }

        @Override
        public List<com.summit.dp.turn.domain.model.ChatTurn> findActiveBySessionIds(
                java.util.Collection<Long> sessionIds) {
            return delegate.findActiveBySessionIds(sessionIds);
        }

        @Override
        public List<com.summit.dp.turn.domain.model.ChatTurn> rollbackFrom(long sessionId, long fromTurnId) {
            return delegate.rollbackFrom(sessionId, fromTurnId);
        }
    }
}
