package com.summit.dp.agent.application.service.impl;

import com.summit.dp.session.domain.repo.MessageRepository;

import com.summit.dp.execution.ExecutionRepositoryTestFactory;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.AgentEvent;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.dp.agent.infrastructure.listener.AgentEventListener;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.agent.infrastructure.workflow.AgentWorkflowOrchestrator;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.LocalExecutionRepository;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.shared.config.JsonConfig;
import com.summit.dp.shared.config.workflow.AgentAccessMode;
import com.summit.dp.shared.config.workflow.CommandApprovalPolicy;
import com.summit.dp.shared.context.ExecutionContext;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.utils.RequestPreparer;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import com.summit.dp.turn.infrastructure.listener.ChatTurnRuntimeListener;
import com.summit.runtime.loop.DefaultExecutionController;
import com.summit.runtime.loop.DefaultRuntimeLifeStyleManager;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.InOrder;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.RejectedExecutionException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 受理后执行失败的收尾契约（会话级单流改造 v1）。
 *
 * <p><b>本测试的价值在「真实链路」</b>：执行仓储、执行控制器、事件通道与两个监听器都用真实实现，
 * 证明下面这条时序不变量真的成立 ——</p>
 *
 * <p>框架的顺序是「save(FAILED) → 返回发布任务 → 调用方 run 它」，业务侧没有排序权。
 * 所以轮次收口只能由仓储在保存提交后补广播：<b>轮次终态必须早于终态事件</b>，
 * 否则前端按「流结束」回查历史时读到的轮次还没失败。</p>
 */
class PreparedChatExecutorTest {

    private static final long ROOT_SESSION_ID = 500L;
    private static final long TURN_ID = 9001L;
    private static final String EXECUTION_ID = "2105000000000000001";

    private final AgentWorkflowOrchestrator orchestrator = mock(AgentWorkflowOrchestrator.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final SessionExecutionRegistry registry = mock(SessionExecutionRegistry.class);
    /** 本测试只用 run / failSubmit，两者都不经受理事务，故受理器为 mock。 */
    private final RequestPreparer requestPreparer = mock(RequestPreparer.class);
    private final ChatTurnService chatTurnService = mock(ChatTurnService.class);
    private final SseEventPublisher sseEventPublisher = mock(SseEventPublisher.class);
    private final ExecutionIdentity executionIdentity = mock(ExecutionIdentity.class);
    private final ExecutionMapper executionMapper = mock(ExecutionMapper.class);
    /** 守卫用例专用：只关心「有没有调 fail」，不需要真实收口链。 */
    private final ExecutionControl frameworkFail = mock(ExecutionControl.class);

    private final PreparedChatExecutor guardedExecutor =
            new PreparedChatExecutor(orchestrator, requestPreparer, modelContextService, registry, frameworkFail);
    private final PreparedChatExecutor realChainExecutor;

    {
        AgentEventListener agentEvents = new AgentEventListener(new JsonConfig().objectMapper(),
                sseEventPublisher, executionIdentity);
        agentEvents.init();
        // 与生产同序：轮次侧监听器（HIGHEST_PRECEDENCE）在前，SSE 广播在后。
        RuntimeEventPublisher publisher = new RuntimeEventPublisher(List.of(
                new ChatTurnRuntimeListener(chatTurnService), agentEvents));
        LocalExecutionRepository repository = ExecutionRepositoryTestFactory.create(
                executionMapper, new JsonConfig().objectMapper(), chatTurnService);
        DefaultRuntimeLifeStyleManager lifeStyle = new DefaultRuntimeLifeStyleManager(publisher);
        realChainExecutor = new PreparedChatExecutor(orchestrator, requestPreparer, modelContextService, registry,
                new DefaultExecutionController(() -> null, repository, publisher, lifeStyle));
    }

    @BeforeEach
    void stubFrameworkAndEvents() {
        TableInfoHelper.initTableInfo(new MapperBuilderAssistant(new MybatisConfiguration(), "test"),
                ExecutionPO.class);
        when(executionMapper.update(any(ExecutionPO.class), any())).thenReturn(1);
        when(executionIdentity.sessionId(EXECUTION_ID)).thenReturn(ROOT_SESSION_ID);
        when(executionIdentity.resolveRootSessionId(ROOT_SESSION_ID)).thenReturn(ROOT_SESSION_ID);
        when(frameworkFail.fail(any(Execution.class), any())).thenReturn(() -> { });
    }

    private static Execution execution(ExecutionState state) {
        AgentRequest request = AgentRequest.builder()
                .executionId(EXECUTION_ID)
                .messages(List.of(UserMessageEntity.from("你好")))
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID)))
                        .eventMetaData(ExecutionEventMetadata.of(ROOT_SESSION_ID, ROOT_SESSION_ID, TURN_ID, null, 3L))
                        .build())
                .build();
        return Execution.builder().id(EXECUTION_ID).agentRequest(request)
                .executionState(state).messages(List.of()).build();
    }

    private static RuntimeContext context(Execution execution) {
        ExecutionContext executionContext = ExecutionContext.root(ROOT_SESSION_ID, EXECUTION_ID, null, 7L,
                AgentAccessMode.IN_WORKSPACE, CommandApprovalPolicy.FULL_ACCESS);
        RuntimeContext context = new RuntimeContext(executionContext, null, null,
                SessionVO.builder().id(ROOT_SESSION_ID).historyRevision(3L).build(),
                List.of(), null, null, AgentAccessMode.IN_WORKSPACE,
                CommandApprovalPolicy.FULL_ACCESS, false, UserMessageEntity.from("你好")).withTurnId(TURN_ID);
        return execution == null ? context : context.withExecution(execution);
    }

    @Test
    @DisplayName("启动失败：轮次先收成 FAILED 并写原因，之后才发布 EXECUTION_FAILED（只发一次）")
    void failedRunClosesTurnBeforePublishingTerminalEvent() {
        Execution execution = execution(ExecutionState.CREATED);
        when(orchestrator.execute(any(RuntimeContext.class), any(Execution.class)))
                .thenThrow(new IllegalStateException("模型不可用"));

        assertThrows(IllegalStateException.class, () -> realChainExecutor.run(context(execution)));

        // 顺序即不变量：轮次终态 → 失败原因 → 事件广播。
        InOrder order = inOrder(chatTurnService, sseEventPublisher);
        ArgumentCaptor<Execution> failedCheckpoint = ArgumentCaptor.forClass(Execution.class);
        order.verify(chatTurnService).finishExecution(failedCheckpoint.capture());
        assertEquals(EXECUTION_ID, failedCheckpoint.getValue().getId());
        assertEquals(ExecutionState.FAILED, failedCheckpoint.getValue().getExecutionState());
        assertNotNull(failedCheckpoint.getValue().getCompletedAt());
        order.verify(chatTurnService).recordFailureReason(EXECUTION_ID, "模型不可用", ROOT_SESSION_ID);
        order.verify(sseEventPublisher).publish(eq(ROOT_SESSION_ID), any(AgentEvent.class));

        // 事件只发一次（行前态判据 + version 条件共同保证）。
        ArgumentCaptor<AgentEvent> event = ArgumentCaptor.forClass(AgentEvent.class);
        verify(sseEventPublisher, times(1)).publish(eq(ROOT_SESSION_ID), event.capture());
        assertEquals("EXECUTION_FAILED", event.getValue().type(), "必须是前端可据以收口的失败终态");
        assertEquals(EXECUTION_ID, event.getValue().executionId(), "归属用已固化的 executionId");

        // 运行资格必须释放，否则会话被锁死，用户再也发不出下一条。
        verify(registry).finishRoot(ROOT_SESSION_ID);
    }

    /**
     * 启动失败时<b>会话流仍然连着</b>——断言的是结果（连接数没变），不是「某个方法没被调用」。
     *
     * <p>用真实 {@link SseEventPublisher} + mock emitter 挂一条流，走完整收口链后比连接数。
     * 早先这里是 {@code verify(never()).disconnectRoot(...)}：方法删了断言就失去意义，
     * 方法改名还会假绿；连接数才是「流还连着」这件事本身。</p>
     */
    @Test
    @DisplayName("启动失败：会话流仍然连着（断言连接数不变，不靠断言某个方法没被调）")
    void startupFailureKeepsSessionStreamConnected() {
        SseEventPublisher live = new SseEventPublisher() {
            @Override
            protected SseEmitter newEmitter() {
                return mock(SseEmitter.class);
            }
        };
        try {
            live.connect(ROOT_SESSION_ID);
            int connected = live.connectedCount();
            AgentEventListener agentEvents = new AgentEventListener(new JsonConfig().objectMapper(),
                    live, executionIdentity);
            agentEvents.init();
            RuntimeEventPublisher events = new RuntimeEventPublisher(List.of(
                    new ChatTurnRuntimeListener(chatTurnService), agentEvents));
            LocalExecutionRepository repository = ExecutionRepositoryTestFactory.create(
                    executionMapper, new JsonConfig().objectMapper(), chatTurnService);
            PreparedChatExecutor executor = new PreparedChatExecutor(orchestrator, requestPreparer,
                    modelContextService, registry, new DefaultExecutionController(() -> null, repository,
                    events, new DefaultRuntimeLifeStyleManager(events)));

            Execution execution = execution(ExecutionState.CREATED);
            when(orchestrator.execute(any(RuntimeContext.class), any(Execution.class)))
                    .thenThrow(new IllegalStateException("模型不可用"));

            assertThrows(IllegalStateException.class, () -> executor.run(context(execution)));

            assertEquals(connected, live.connectedCount(),
                    "执行终结不得摘掉会话流：连接还在，前端下一次发送前无需重挂");
        } finally {
            live.close();
        }
    }

    @Test
    @DisplayName("提交被拒（线程池拒绝）：与启动失败同口径收口，并释放运行资格")
    void submitRejectionClosesOutAndReleasesToken() {
        Execution execution = execution(ExecutionState.CREATED);

        guardedExecutor.failSubmit(context(execution), new RejectedExecutionException("线程池已满"));

        ArgumentCaptor<RuntimeException> cause = ArgumentCaptor.forClass(RuntimeException.class);
        verify(frameworkFail).fail(eq(execution), cause.capture());
        assertEquals("线程池已满", cause.getValue().getMessage());
        verify(registry).finishRoot(ROOT_SESSION_ID);
    }

    @Test
    @DisplayName("已终态的执行不重复收口：框架已自行 fail 过，再 fail 会抛非法状态转换")
    void terminalExecutionIsNotFailedAgain() {
        Execution execution = execution(ExecutionState.FAILED);
        when(orchestrator.execute(any(RuntimeContext.class), any(Execution.class)))
                .thenThrow(new IllegalStateException("loop 已自行收口"));

        assertThrows(IllegalStateException.class, () -> guardedExecutor.run(context(execution)));

        verify(frameworkFail, never()).fail(any(Execution.class), any());
        verify(registry).finishRoot(ROOT_SESSION_ID);
    }

    @Test
    @DisplayName("挂起中的执行绝不被标失败：挂起可恢复，误标会让「待恢复」入口消失")
    void suspendedExecutionIsNotFailed() {
        Execution execution = execution(ExecutionState.SUSPENDED);
        when(orchestrator.execute(any(RuntimeContext.class), any(Execution.class)))
                .thenThrow(new IllegalStateException("不该走到这里"));

        assertThrows(IllegalStateException.class, () -> guardedExecutor.run(context(execution)));

        verify(frameworkFail, never()).fail(any(Execution.class), any());
        verify(chatTurnService, never()).finishExecution(any());
    }

    @Test
    @DisplayName("执行对象缺失也要释放运行资格：校验在 try 内，不依赖成功路径")
    void missingExecutionStillReleasesRunToken() {
        assertThrows(IllegalStateException.class, () -> guardedExecutor.run(context(null)));

        verify(registry).finishRoot(ROOT_SESSION_ID);
        verify(frameworkFail, never()).fail(any(Execution.class), any());
    }
}
