package com.summit.dp.agent;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.agent.application.service.impl.ChatServiceImpl;
import com.summit.dp.agent.application.service.impl.PreparedChatExecutor;
import com.summit.dp.agent.application.service.impl.ResendTargetResolver;
import com.summit.dp.agent.application.service.impl.RuntimeContext;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.agent.infrastructure.workflow.AgentWorkflowOrchestrator;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.session.application.service.ConversationRollbackService;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.config.workflow.AgentAccessMode;
import com.summit.dp.shared.config.workflow.CommandApprovalPolicy;
import com.summit.dp.shared.context.ExecutionContext;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.utils.RequestPreparer;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 聊天入口的顺序与失败收口契约。
 *
 * <p><b>为什么必须有这个测试</b>：三件事都是结构性的，单靠读代码很容易被后续改动破坏 ——</p>
 * <ol>
 *   <li>单飞校验必须在用户消息落库<b>之前</b>（否则并发被拒时留下「有提问、无执行、无错误」的孤行）；</li>
 *   <li>受理事务内顺序固定：轮次与用户消息落库 → 带 turnId → 框架创建执行（turnId 要进事件元数据）；</li>
 *   <li>启动失败交框架收口（{@code ExecutionControl.fail}），但<b>已终态与挂起一律不碰</b>。</li>
 * </ol>
 */
class ChatAdmissionOrderTest {

    private static final long ROOT_SESSION_ID = 500L;
    private static final long TURN_ID = 9001L;
    private static final String EXECUTION_ID = "2105000000000000001";

    private final SseEventPublisher sseEventPublisher = mock(SseEventPublisher.class);
    private final RequestPreparer requestPreparer = mock(RequestPreparer.class);
    private final AgentWorkflowOrchestrator orchestrator = mock(AgentWorkflowOrchestrator.class);
    private final SessionExecutionRegistry registry = mock(SessionExecutionRegistry.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final ExecutionControl executionControl = mock(ExecutionControl.class);
    /** 收口链上「发布终态事件」的任务：必须被真的 run 过，否则前端收不到失败。 */
    private final AtomicInteger publishedFailures = new AtomicInteger();

    /** 必须先于 chatService 声明：Java 字段初始化按声明顺序执行，否则传进去的是 null。 */
    private final com.summit.dp.turn.application.service.ChatTurnService chatTurnService =
            mock(com.summit.dp.turn.application.service.ChatTurnService.class);

    private final ChatServiceImpl chatService = new ChatServiceImpl(
            sseEventPublisher, requestPreparer,
            executionControl, mock(ExecutionRepository.class),
            mock(SessionRepository.class), registry, modelContextService,
            mock(ExecutionIdentity.class), mock(ToolCallRepository.class),
            mock(SessionAttributeRestorer.class),
            new PreparedChatExecutor(orchestrator, requestPreparer, modelContextService, registry, executionControl),
            chatTurnService,
            mock(com.summit.dp.execution.application.service.ExecutionQueryService.class),
            // 本测试只盯「单飞校验先于用户消息落库」这一段顺序，重发链路用不到。
            mock(ResendTargetResolver.class), mock(ConversationRollbackService.class)
    );

    @BeforeEach
    void stubAdmissionHappyPath() {
        when(requestPreparer.commitUserMessage(any())).thenReturn(TURN_ID);
        when(orchestrator.createExecution(any(RuntimeContext.class))).thenReturn(execution(ExecutionState.CREATED));
        when(orchestrator.execute(any(RuntimeContext.class), any(Execution.class)))
                .thenReturn(execution(ExecutionState.CREATED));
        // fail 的返回值是「发布终态事件」任务，业务侧会 run 它；mock 默认返回 null 会 NPE。
        when(executionControl.fail(any(Execution.class), any()))
                .thenAnswer(invocation -> (Runnable) publishedFailures::incrementAndGet);
    }

    private static ChatCommand command() {
        return new ChatCommand("你好", ROOT_SESSION_ID, 7L, null, null, null, false, null, null);
    }

    /** 受理前的上下文：用户消息已解析但未落库，执行对象还没有。 */
    private static RuntimeContext context() {
        ExecutionContext executionContext = ExecutionContext.root(ROOT_SESSION_ID, EXECUTION_ID,
                null, 7L, AgentAccessMode.IN_WORKSPACE, CommandApprovalPolicy.FULL_ACCESS);
        return new RuntimeContext(executionContext, null, null,
                SessionVO.builder().id(ROOT_SESSION_ID).build(), List.of(), null, null,
                AgentAccessMode.IN_WORKSPACE, CommandApprovalPolicy.FULL_ACCESS, false,
                UserMessageEntity.from("你好"));
    }

    private static Execution execution(ExecutionState state) {
        AgentRequest request = AgentRequest.builder()
                .executionId(EXECUTION_ID)
                .messages(List.of(UserMessageEntity.from("你好")))
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID)))
                        .build())
                .build();
        Execution execution = Execution.builder().id(EXECUTION_ID).agentRequest(request)
                .executionState(state).build();
        execution.setMessages(List.of());
        return execution;
    }

    @Test
    @DisplayName("被单飞校验拒绝时不写用户消息、不登记执行、不占用运行资格")
    void rejectedRequestLeavesNoUserMessage() {
        RuntimeContext context = context();
        when(requestPreparer.prepare(any(ChatCommand.class))).thenReturn(context);
        doThrow(new ClientException("会话正在执行中")).when(registry).beginRoot(anyLong());

        assertThrows(ClientException.class, () -> chatService.chat(command()));

        // 关键：拒绝发生在受理**之前**，历史里不会多出一条没有回复的提问，也不会留下创建中的执行行。
        verify(requestPreparer, never()).commitUserMessage(any());
        verify(orchestrator, never()).createExecution(any());
        verify(registry, never()).finishRoot(anyLong());
    }

    @Test
    @DisplayName("受理顺序固定：取资格 → 轮次与消息落库 → 创建执行 → 运行 → 释放资格")
    void acceptedRequestCommitsThenCreatesExecutionBeforeRunning() {
        RuntimeContext context = context();
        when(requestPreparer.prepare(any(ChatCommand.class))).thenReturn(context);

        chatService.chat(command());

        InOrder order = inOrder(registry, requestPreparer, orchestrator);
        order.verify(registry).beginRoot(ROOT_SESSION_ID);
        order.verify(requestPreparer).commitUserMessage(context);
        order.verify(orchestrator).createExecution(any(RuntimeContext.class));
        order.verify(orchestrator).execute(any(RuntimeContext.class), any(Execution.class));
        verify(registry).finishRoot(ROOT_SESSION_ID);
    }

    @Test
    @DisplayName("受理产出的 turnId 与执行对象都随上下文下行：创建执行时已带轮次，运行时已带执行")
    void admissionArtifactsTravelWithContext() {
        RuntimeContext context = context();
        when(requestPreparer.prepare(any(ChatCommand.class))).thenReturn(context);
        Execution created = execution(ExecutionState.CREATED);
        when(orchestrator.createExecution(any(RuntimeContext.class))).thenReturn(created);

        chatService.chat(command());

        ArgumentCaptor<RuntimeContext> toCreate = ArgumentCaptor.forClass(RuntimeContext.class);
        verify(orchestrator).createExecution(toCreate.capture());
        // 轮次 ID 必须先进上下文：它会写进执行请求的事件元数据（ExecutionEventMetadata）。
        assertEquals(TURN_ID, toCreate.getValue().turnId());
        assertEquals(context.executionContext(), toCreate.getValue().executionContext());
        assertNull(toCreate.getValue().execution(), "创建之前还没有执行对象");

        ArgumentCaptor<RuntimeContext> toExecute = ArgumentCaptor.forClass(RuntimeContext.class);
        verify(orchestrator).execute(toExecute.capture(), any(Execution.class));
        assertEquals(TURN_ID, toExecute.getValue().turnId());
        assertEquals(created, toExecute.getValue().execution(), "运行时必须拿到受理登记的那个执行对象");
    }

    @Test
    @DisplayName("受理失败同样释放运行资格，不把会话永久锁死")
    void failureWhileAdmittingReleasesRunToken() {
        RuntimeContext context = context();
        when(requestPreparer.prepare(any(ChatCommand.class))).thenReturn(context);
        doThrow(new IllegalStateException("db down")).when(requestPreparer).commitUserMessage(any());

        assertThrows(IllegalStateException.class, () -> chatService.chat(command()));

        verify(registry).finishRoot(ROOT_SESSION_ID);
        verify(orchestrator, never()).execute(any(), any());
    }

    @Test
    @DisplayName("执行启动失败也释放运行资格（finally 收尾，不依赖成功路径）")
    void failureWhileRunningReleasesRunToken() {
        RuntimeContext context = context();
        when(requestPreparer.prepare(any(ChatCommand.class))).thenReturn(context);
        when(orchestrator.execute(any(RuntimeContext.class), any(Execution.class)))
                .thenThrow(new IllegalStateException("model missing"));

        assertThrows(IllegalStateException.class, () -> chatService.chat(command()));

        verify(requestPreparer).commitUserMessage(context);
        verify(registry).finishRoot(ROOT_SESSION_ID);
    }

    @Test
    @DisplayName("启动失败交框架收口：调 ExecutionControl.fail 并真的发布终态事件")
    void startupFailureIsClosedThroughFrameworkFail() {
        RuntimeContext context = context();
        when(requestPreparer.prepare(any(ChatCommand.class))).thenReturn(context);
        Execution created = execution(ExecutionState.CREATED);
        when(orchestrator.createExecution(any(RuntimeContext.class))).thenReturn(created);
        when(orchestrator.execute(any(RuntimeContext.class), any(Execution.class)))
                .thenThrow(new IllegalStateException("model missing"));

        assertThrows(IllegalStateException.class, () -> chatService.chat(command()));

        // 归属用上下文里那个执行对象（显式传递），不从「会话最新执行」反查。
        ArgumentCaptor<RuntimeException> cause = ArgumentCaptor.forClass(RuntimeException.class);
        verify(executionControl).fail(eq(created), cause.capture());
        assertEquals("model missing", cause.getValue().getMessage());
        // 事件发布任务必须被执行：轮次收口由仓储在 save 提交后补，事件由这一步发出去。
        assertEquals(1, publishedFailures.get());
    }

    @Test
    @DisplayName("收口本身失败只告警，绝不掩盖原始异常")
    void failFailureDoesNotMaskOriginalError() {
        RuntimeContext context = context();
        when(requestPreparer.prepare(any(ChatCommand.class))).thenReturn(context);
        when(orchestrator.execute(any(RuntimeContext.class), any(Execution.class)))
                .thenThrow(new IllegalStateException("model missing"));
        when(executionControl.fail(any(Execution.class), any()))
                .thenThrow(new IllegalStateException("db down"));

        IllegalStateException thrown = assertThrows(IllegalStateException.class,
                () -> chatService.chat(command()));

        assertEquals("model missing", thrown.getMessage(), "对外抛出的必须仍是原始失败原因");
        verify(registry).finishRoot(ROOT_SESSION_ID);
    }

    @Test
    @DisplayName("已终态的执行不重复收口：框架已自行 fail 过，再 fail 会抛非法状态转换")
    void terminalExecutionIsNotFailedAgain() {
        RuntimeContext context = context();
        when(requestPreparer.prepare(any(ChatCommand.class))).thenReturn(context);
        Execution failed = execution(ExecutionState.FAILED);
        when(orchestrator.createExecution(any(RuntimeContext.class))).thenReturn(failed);
        when(orchestrator.execute(any(RuntimeContext.class), any(Execution.class)))
                .thenThrow(new IllegalStateException("loop 已自行收口"));

        assertThrows(IllegalStateException.class, () -> chatService.chat(command()));

        verify(executionControl, never()).fail(any(Execution.class), any());
        verify(registry).finishRoot(ROOT_SESSION_ID);
    }

    @Test
    @DisplayName("挂起中的执行绝不被标失败：挂起可恢复，误标会让「待恢复」入口消失")
    void suspendedExecutionIsNotFailed() {
        RuntimeContext context = context();
        when(requestPreparer.prepare(any(ChatCommand.class))).thenReturn(context);
        Execution suspended = execution(ExecutionState.SUSPENDED);
        when(orchestrator.createExecution(any(RuntimeContext.class))).thenReturn(suspended);
        when(orchestrator.execute(any(RuntimeContext.class), any(Execution.class)))
                .thenThrow(new IllegalStateException("不该走到这里"));

        assertThrows(IllegalStateException.class, () -> chatService.chat(command()));

        verify(executionControl, never()).fail(any(Execution.class), any());
    }
}
