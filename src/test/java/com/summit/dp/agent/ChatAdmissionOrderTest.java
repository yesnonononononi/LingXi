package com.summit.dp.agent;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.agent.application.service.impl.ChatServiceImpl;
import com.summit.dp.agent.application.service.impl.ResendTargetResolver;
import com.summit.dp.agent.application.service.impl.RuntimeContext;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.agent.infrastructure.workflow.AgentWorkflowOrchestrator;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.execution.application.service.ExecutionRegistrationService;
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
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 聊天入口的顺序契约（2026-09-30 改造）。
 *
 * <p><b>为什么必须有这个测试：</b>改造前是「先写用户消息、再做运行资格校验」，
 * 于是并发发送被拒绝时会留下一条「有提问、无执行、无错误」的孤行 ——
 * 用户看到自己发出去的话永远没有回复。修法是把校验前移，但顺序是**结构性**的，
 * 单靠读代码很容易被后续改动破坏，所以用 InOrder 把顺序钉住。</p>
 */
class ChatAdmissionOrderTest {

    private static final long ROOT_SESSION_ID = 500L;

    private final SseEventPublisher sseEventPublisher = mock(SseEventPublisher.class);
    private final RequestPreparer requestPreparer = mock(RequestPreparer.class);
    private final AgentWorkflowOrchestrator orchestrator = mock(AgentWorkflowOrchestrator.class);
    private final SessionExecutionRegistry registry = mock(SessionExecutionRegistry.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final ExecutionRegistrationService registrationService = mock(ExecutionRegistrationService.class);

    /** 必须先于 sessionService 声明：Java 字段初始化按声明顺序执行，否则传进去的是 null。 */
    private final com.summit.dp.turn.application.service.ChatTurnService chatTurnService =
            mock(com.summit.dp.turn.application.service.ChatTurnService.class);

    private final ChatServiceImpl chatService = new ChatServiceImpl(
            sseEventPublisher, requestPreparer,
            mock(ExecutionControl.class), mock(ExecutionRepository.class),
            mock(SessionRepository.class), registry, modelContextService,
            mock(ExecutionIdentity.class), mock(ToolCallRepository.class),
            mock(SessionAttributeRestorer.class),
            new com.summit.dp.agent.application.service.impl.PreparedChatExecutor(
                    orchestrator, modelContextService, registry, registrationService, chatTurnService),
            chatTurnService,
            mock(com.summit.dp.execution.application.service.ExecutionQueryService.class),
            // 本测试只盯「单飞校验先于用户消息落库」这一段顺序，重发链路用不到。
            mock(ResendTargetResolver.class), mock(ConversationRollbackService.class)
    );

    @BeforeEach
    void noAcceptedTurnUnlessSpecified() {
        when(requestPreparer.commitUserMessage(any())).thenReturn(null);
    }

    private static ChatCommand command() {
        return new ChatCommand("你好", ROOT_SESSION_ID, 7L, null, null, null, false, null, null);
    }

    private static RuntimeContext context() {
        ExecutionContext executionContext = ExecutionContext.root(ROOT_SESSION_ID, "2105000000000000001",
                null, 7L, AgentAccessMode.IN_WORKSPACE, CommandApprovalPolicy.FULL_ACCESS);
        return new RuntimeContext(executionContext, null, null,
                SessionVO.builder().id(ROOT_SESSION_ID).build(), List.of(), null, null,
                AgentAccessMode.IN_WORKSPACE, CommandApprovalPolicy.FULL_ACCESS, false, null);
    }

    private static Execution execution() {
        AgentRequest request = AgentRequest.builder()
                .executionId("2105000000000000001")
                .messages(List.of(UserMessageEntity.from("你好")))
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID)))
                        .build())
                .build();
        Execution execution = Execution.builder().id("2105000000000000001").agentRequest(request).build();
        execution.setMessages(List.of());
        return execution;
    }

    @Test
    @DisplayName("被单飞校验拒绝时不写用户消息、不占用运行资格")
    void rejectedRequestLeavesNoUserMessage() {
        RuntimeContext context = context();
        when(requestPreparer.prepare(any(ChatCommand.class))).thenReturn(context);
        doThrow(new ClientException("会话正在执行中")).when(registry).beginRoot(anyLong());

        assertThrows(ClientException.class, () -> chatService.chat(command()));

        // 关键：拒绝发生在用户消息落库**之前**，因此历史里不会多出一条没有回复的提问。
        verify(requestPreparer, never()).commitUserMessage(any());
        verify(registry, never()).finishRoot(anyLong());
    }

    @Test
    @DisplayName("接受请求时顺序固定：取运行资格 → 落库用户消息 → 启动执行 → 释放资格")
    void acceptedRequestCommitsUserMessageBeforeStarting() {
        RuntimeContext context = context();
        when(requestPreparer.prepare(any(ChatCommand.class))).thenReturn(context);
        when(orchestrator.executeDefaultAgent(context)).thenReturn(execution());

        chatService.chat(command());

        InOrder order = inOrder(registry, requestPreparer, orchestrator);
        order.verify(registry).beginRoot(ROOT_SESSION_ID);
        order.verify(requestPreparer).commitUserMessage(context);
        order.verify(orchestrator).executeDefaultAgent(context);
        verify(registry).finishRoot(ROOT_SESSION_ID);
    }

    @Test
    void acceptedTurnIdTravelsToOrchestratorWithoutReverseLookup() {
        RuntimeContext context = context();
        when(requestPreparer.prepare(any(ChatCommand.class))).thenReturn(context);
        when(requestPreparer.commitUserMessage(context)).thenReturn(9001L);
        when(orchestrator.executeDefaultAgent(any(RuntimeContext.class))).thenReturn(execution());

        chatService.chat(command());

        ArgumentCaptor<RuntimeContext> accepted = ArgumentCaptor.forClass(RuntimeContext.class);
        verify(orchestrator).executeDefaultAgent(accepted.capture());
        assertEquals(9001L, accepted.getValue().turnId());
        assertEquals(context.executionContext(), accepted.getValue().executionContext());
    }

    @Test
    @DisplayName("落库用户消息失败同样释放运行资格，不把会话永久锁死")
    void failureWhileCommittingReleasesRunToken() {
        RuntimeContext context = context();
        when(requestPreparer.prepare(any(ChatCommand.class))).thenReturn(context);
        doThrow(new IllegalStateException("db down")).when(requestPreparer).commitUserMessage(any());

        assertThrows(IllegalStateException.class, () -> chatService.chat(command()));

        verify(registry).finishRoot(ROOT_SESSION_ID);
        verify(orchestrator, never()).executeDefaultAgent(any());
    }

    @Test
    @DisplayName("执行启动失败也释放运行资格（finally 收尾，不依赖成功路径）")
    void failureWhileStartingExecutionReleasesRunToken() {
        RuntimeContext context = context();
        when(requestPreparer.prepare(any(ChatCommand.class))).thenReturn(context);
        when(orchestrator.executeDefaultAgent(context)).thenThrow(new IllegalStateException("model missing"));

        assertThrows(IllegalStateException.class, () -> chatService.chat(command()));

        verify(requestPreparer).commitUserMessage(context);
        verify(registry).finishRoot(ROOT_SESSION_ID);
    }

    @Test
    @DisplayName("启动失败时收口执行终态：不留「永远创建中」的记录")
    void startupFailureClosesExecutionAsTerminal() {
        RuntimeContext context = context();
        when(requestPreparer.prepare(any(ChatCommand.class))).thenReturn(context);
        when(orchestrator.executeDefaultAgent(context)).thenThrow(new IllegalStateException("model missing"));

        assertThrows(IllegalStateException.class, () -> chatService.chat(command()));

        // 归属用 context 里已固化的 executionId（显式传递），不从「会话最新执行」反查。
        verify(registrationService).markStartupFailed(Long.parseLong(
                context.executionContext().executionId()));
    }

    @Test
    @DisplayName("收口本身失败只告警，绝不掩盖原始异常")
    void markFailureDoesNotMaskOriginalError() {
        RuntimeContext context = context();
        when(requestPreparer.prepare(any(ChatCommand.class))).thenReturn(context);
        when(orchestrator.executeDefaultAgent(context)).thenThrow(new IllegalStateException("model missing"));
        doThrow(new IllegalStateException("db down")).when(registrationService).markStartupFailed(anyLong());

        IllegalStateException thrown = assertThrows(IllegalStateException.class,
                () -> chatService.chat(command()));

        assertEquals("model missing", thrown.getMessage(), "对外抛出的必须仍是原始失败原因");
        verify(registry).finishRoot(ROOT_SESSION_ID);
    }

    @Test
    @DisplayName("流式聊天与同步聊天共用同一套顺序（同一个 executePrepared）")
    void streamingPathUsesTheSameOrder() {
        RuntimeContext context = context();
        when(requestPreparer.prepare(any(ChatCommand.class))).thenReturn(context);
        when(orchestrator.executeDefaultAgent(context)).thenReturn(execution());
        when(sseEventPublisher.connect(ROOT_SESSION_ID)).thenReturn(mock(SseEmitter.class));

        chatService.chatStream(command());

        // beginRoot 在请求线程内同步执行，「校验先于落库」在流式路径上同样是结构性成立的；
        // 执行体是异步的，因此用 timeout 等待，而不是断言同步返回。
        verify(registry).beginRoot(ROOT_SESSION_ID);
        verify(requestPreparer, timeout(5_000)).commitUserMessage(context);
        verify(orchestrator, timeout(5_000)).executeDefaultAgent(context);
        verify(registry, timeout(5_000)).finishRoot(ROOT_SESSION_ID);
    }
}
