package com.summit.dp.execution;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.ExecutionCancelledEvent;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.message.TokenUsageEntity;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.turn.application.service.impl.ChatTurnServiceImpl;
import com.summit.dp.turn.infrastructure.persistence.mapper.ChatTurnMapper;
import com.summit.dp.turn.infrastructure.persistence.po.ChatTurnPO;
import com.summit.dp.turn.infrastructure.persistence.repository.ChatTurnRepositoryImpl;
import com.summit.dp.workflow.application.decision.ToolCallReadinessService;
import com.summit.dp.workflow.application.input.InputWakeupService;
import com.summit.dp.workflow.application.lifecycle.ExecutionLifecycleProjection;
import com.summit.dp.workflow.application.projection.ChatTurnLifecycleProjector;
import com.summit.dp.workflow.application.projection.SessionContextUsageProjector;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 会话用量是业务状态：写失败必须保留待办并重试，写入按权威快照覆盖（不累加），
 * 而通知失败不得回退任何业务事实。
 *
 * <p>三条断言分别守住三件独立的事：</p>
 * <ol>
 *   <li><b>失败不吞</b>：用量写失败 → 待收口位仍为 1、不广播、轮次不被收口，等补偿重做；</li>
 *   <li><b>覆盖不累加</b>：同一条收口跑两遍，轮次用量只等于执行快照的值；</li>
 *   <li><b>通知与事实分离</b>：广播抛异常不影响已落库的业务事实，也不把待收口位重新置 1。</li>
 * </ol>
 *
 * <p>全部走真实 H2 + 真实仓储（执行表、轮次表），断言回库读的事实：这一组失败模式恰恰是
 * 「内存里以为写了、库里没有」，mock 掉库就什么也证明不了。</p>
 */
class ExecutionClosureUsageTest {

    private static final long EXECUTION_ID = 830_001L;
    private static final String EXECUTION_ID_TEXT = String.valueOf(EXECUTION_ID);
    private static final long TURN_ID = 830_002L;
    private static final long SESSION_ID = 830_003L;

    private static final int TOTAL_TOKENS = 150;
    private static final int INPUT_TOKENS = 120;
    private static final int OUTPUT_TOKENS = 30;

    private H2TestDatabase database;
    private ExecutionMapper executionMapper;
    private ChatTurnMapper chatTurnMapper;
    private ExecutionRepositoryImpl executions;
    private ChatTurnServiceImpl turns;
    private RuntimeEventPublisher runtimeEvents;

    @BeforeEach
    void setup() {
        database = H2TestDatabase.create("ExecutionClosureUsageTest");
        executionMapper = H2TestDatabase.sqlSession(database.sessionFactory(ExecutionMapper.class))
                .getMapper(ExecutionMapper.class);
        chatTurnMapper = H2TestDatabase.sqlSession(database.sessionFactory(ChatTurnMapper.class))
                .getMapper(ChatTurnMapper.class);
        executions = new ExecutionRepositoryImpl(executionMapper);
        turns = new ChatTurnServiceImpl(new ChatTurnRepositoryImpl(chatTurnMapper));
        runtimeEvents = mock(RuntimeEventPublisher.class);
        seedTerminalExecutionWithRunningTurn();
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("用量写失败：待收口位保留、不广播、轮次不收口；故障解除后重试成功且用量与快照一致")
    void usageFailureKeepsPendingAndRetries() {
        AtomicBoolean faultActive = new AtomicBoolean(true);
        SessionContextUsageProjector failingUsage = mock(SessionContextUsageProjector.class);
        doAnswer(invocation -> {
            if (faultActive.get()) {
                throw new IllegalStateException("注入的用量写失败");
            }
            return null;
        }).when(failingUsage).saveExecutionContextUsage(any());
        ExecutionLifecycleProjection projection = projection(failingUsage);
        Execution execution = execution(ExecutionState.COMPLETED);

        projection.completeClosure(execution, false);

        assertEquals(Integer.valueOf(1), closurePending(), "用量没写成就是没收口：待收口位必须留着");
        assertEquals("RUNNING", turnStatus(), "必须步骤失败时不得把轮次收口成成功");
        verify(runtimeEvents, never()).onExecutionComplete(any());

        faultActive.set(false);
        projection.completeClosure(execution, false);

        assertEquals(Integer.valueOf(0), closurePending(), "重试成功后待收口位必须清零");
        assertEquals("COMPLETED", turnStatus(), "重试成功后轮次必须收口");
        ChatTurnPO turn = chatTurnMapper.selectById(TURN_ID);
        assertNotNull(turn);
        assertEquals(Long.valueOf(TOTAL_TOKENS), turn.getTotalTokenCount(),
                "轮次用量必须等于执行快照的总量");
        assertEquals(Long.valueOf(INPUT_TOKENS), turn.getInputTokenCount());
        assertEquals(Long.valueOf(OUTPUT_TOKENS), turn.getOutputTokenCount());
    }

    @Test
    @DisplayName("同一收口连跑两次：用量只等于一次的值，绝不累加")
    void repeatedClosureDoesNotDoubleCountUsage() {
        ExecutionLifecycleProjection projection = projection(mock(SessionContextUsageProjector.class));
        Execution execution = execution(ExecutionState.COMPLETED);

        projection.completeClosure(execution, false);
        projection.completeClosure(execution, false);

        ChatTurnPO turn = chatTurnMapper.selectById(TURN_ID);
        assertNotNull(turn);
        assertEquals(Long.valueOf(TOTAL_TOKENS), turn.getTotalTokenCount(),
                "覆盖写：重复收口不能把同一执行算两遍");
        assertEquals(Long.valueOf(INPUT_TOKENS), turn.getInputTokenCount());
        assertEquals(Long.valueOf(OUTPUT_TOKENS), turn.getOutputTokenCount());
        assertEquals(Integer.valueOf(0), closurePending());
    }

    @Test
    @DisplayName("广播抛异常：业务事实照旧落库、待收口位已清零，日志带 executionId 与步骤名")
    void broadcastFailureDoesNotUndoBusinessFacts() {
        Logger logger = (Logger) org.slf4j.LoggerFactory.getLogger(ExecutionLifecycleProjection.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            doAnswer(invocation -> {
                throw new IllegalStateException("注入的广播失败");
            }).when(runtimeEvents).onExecutionCancelled(any(ExecutionCancelledEvent.class));

            projection(mock(SessionContextUsageProjector.class))
                    .completeClosure(execution(ExecutionState.CANCELLED), true);

            assertEquals("CANCELLED", turnStatus(), "广播失败不得回滚已落库的业务事实");
            assertEquals(Integer.valueOf(0), closurePending(),
                    "广播在清位之后发生：失败也不能把待收口位重新置 1");
            List<String> messages = appender.list.stream().map(ILoggingEvent::getFormattedMessage).toList();
            assertTrue(messages.stream().anyMatch(message -> message.contains(EXECUTION_ID_TEXT)
                            && message.contains(ExecutionLifecycleProjection.STEP_PUBLISH_CANCELLED)),
                    "广播失败必须留下带 executionId 与步骤名的可定位日志: " + messages);
        } finally {
            logger.detachAppender(appender);
        }
    }

    // ------------------------------------------------------------------
    // 夹具
    // ------------------------------------------------------------------

    /** 终态执行行（待收口位 1）+ 一条仍在运行的业务轮次。 */
    private void seedTerminalExecutionWithRunningTurn() {
        ExecutionPO execution = new ExecutionPO();
        execution.setId(EXECUTION_ID);
        execution.setSessionId(SESSION_ID);
        execution.setStatus(ExecutionStatusCodes.COMPLETED);
        execution.setResumeGeneration(0L);
        execution.setClosurePending(1);
        executionMapper.insert(execution);

        chatTurnMapper.insert(ChatTurnPO.builder().id(TURN_ID).version(1L).sessionId(SESSION_ID)
                .executionId(EXECUTION_ID).status("RUNNING").createdAt(Instant.now()).build());
    }

    private Execution execution(ExecutionState state) {
        Map<String, Object> attributes = Map.of(
                com.summit.dp.execution.ExecutionAttributes.SESSION_ID, String.valueOf(SESSION_ID));
        return Execution.builder().id(EXECUTION_ID_TEXT).agentId("chatAgent")
                .executionState(state)
                .tokenUsage(TokenUsageEntity.of(TOTAL_TOKENS, INPUT_TOKENS, OUTPUT_TOKENS))
                .agentRequest(AgentRequest.builder().executionId(EXECUTION_ID_TEXT)
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes).build())
                        .build())
                .build();
    }

    private ExecutionLifecycleProjection projection(SessionContextUsageProjector usage) {
        return new ExecutionLifecycleProjection(
                provider(mock(ToolCallReadinessService.class)),
                provider(mock(ToolCallService.class)),
                provider(mock(SubExecutionLifecycle.class)),
                provider(usage),
                provider(new ChatTurnLifecycleProjector(turns)),
                provider(runtimeEvents),
                provider(mock(InputWakeupService.class)),
                provider(executions));
    }

    private Integer closurePending() {
        ExecutionPO row = executionMapper.selectById(EXECUTION_ID);
        assertNotNull(row, "执行行必须存在");
        return row.getClosurePending();
    }

    private String turnStatus() {
        LambdaQueryWrapper<ChatTurnPO> wrapper = new LambdaQueryWrapper<ChatTurnPO>()
                .eq(ChatTurnPO::getId, TURN_ID);
        ChatTurnPO row = chatTurnMapper.selectOne(wrapper);
        assertNotNull(row, "轮次行必须存在");
        return row.getStatus();
    }

    private static <T> ObjectProvider<T> provider(T service) {
        ObjectProvider<T> provider = mock(
                ObjectProvider.class);
        when(provider.getObject()).thenReturn(service);
        return provider;
    }
}
