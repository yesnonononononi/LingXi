package com.summit.dp.agent;

import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.application.command.ChatCommand;
import com.summit.dp.agent.application.service.impl.ChatServiceImpl;
import com.summit.dp.agent.application.service.impl.PreparedChatExecutor;
import com.summit.dp.agent.application.service.impl.ResendTargetResolver;
import com.summit.dp.agent.application.service.impl.RuntimeContext;
import com.summit.dp.agent.application.vo.ChatAcceptanceVO;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.session.application.service.ConversationRollbackService;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.config.workflow.AgentAccessMode;
import com.summit.dp.shared.config.workflow.CommandApprovalPolicy;
import com.summit.dp.shared.context.ExecutionContext;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.utils.RequestPreparer;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.application.service.ChatTurnService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.InOrder;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 受理端点的契约（会话级单流改造 v1）。
 *
 * <p>受理与建流是两件事：受理只保证请求线程内同事务落库并立刻返回
 * {@code {sessionId, turnId}}，模型调用随后异步进行，实时事件改由会话级订阅承载。
 * 这里钉住三件事：<b>顺序</b>（先取资格、再落库、最后异步执行）、<b>不建流</b>、
 * 以及<b>提交失败必须释放运行资格</b>（否则会话被锁死，用户再也发不出下一条）。</p>
 *
 * <p>运行资格用真实的 {@link SessionExecutionRegistry}：只有真的释放了，失败的下一轮才能
 * 重新 {@code beginRoot}；用 mock 则「释放没做」也会通过，抓不住回归。</p>
 */
class ChatAcceptanceEndpointTest {

    private static final long ROOT_SESSION_ID = 500L;

    private final SseEventPublisher sseEventPublisher = mock(SseEventPublisher.class);
    private final RequestPreparer requestPreparer = mock(RequestPreparer.class);
    private final PreparedChatExecutor chatExecutor = mock(PreparedChatExecutor.class);
    private final SessionExecutionRegistry registry = new SessionExecutionRegistry();
    private final ExecutionQueryService executionQueryService = mock(ExecutionQueryService.class);

    private final ChatServiceImpl chatService = new ChatServiceImpl(
            sseEventPublisher, requestPreparer,
            mock(ExecutionControl.class), mock(ExecutionRepository.class),
            mock(SessionRepository.class), registry, mock(ModelContextService.class),
            mock(ExecutionIdentity.class), mock(ToolCallRepository.class),
            mock(SessionAttributeRestorer.class), chatExecutor,
            mock(ChatTurnService.class), executionQueryService,
            mock(ResendTargetResolver.class), mock(ConversationRollbackService.class));

    @BeforeEach
    void sessionIsIdle() {
        // ensureSessionTreeIsIdle 读的是「会话下有无未终结执行」；返回空表即视为空闲。
        when(executionQueryService.latestStatesBySession(any())).thenReturn(Map.of());
    }

    private static ChatCommand command() {
        return new ChatCommand("你好", ROOT_SESSION_ID, 7L, null, null, null, false, null, null);
    }

    private static RuntimeContext context(String executionId) {
        ExecutionContext executionContext = ExecutionContext.root(ROOT_SESSION_ID, executionId,
                null, 7L, AgentAccessMode.IN_WORKSPACE, CommandApprovalPolicy.FULL_ACCESS);
        return new RuntimeContext(executionContext, null, null,
                SessionVO.builder().id(ROOT_SESSION_ID).build(), List.of(), null, null,
                AgentAccessMode.IN_WORKSPACE, CommandApprovalPolicy.FULL_ACCESS, false, null);
    }

    @Test
    @DisplayName("受理成功：返回持久化身份，顺序为 取资格 → 受理（轮次+消息+执行行）→ 异步执行，且不建任何流")
    void acceptReturnsIdentityAndNeverBuildsStream() {
        RuntimeContext context = context("2105000000000000001");
        when(requestPreparer.prepare(any(ChatCommand.class))).thenReturn(context);
        when(chatExecutor.admit(context)).thenReturn(context.withTurnId(9001L));

        Result<ChatAcceptanceVO> result = chatService.acceptCommand(command());

        assertEquals(1, result.getCode());
        ChatAcceptanceVO data = result.getData();
        assertNotNull(data);
        assertEquals(ROOT_SESSION_ID, data.getSessionId(), "返回的必须是持久化的会话雪花 ID");
        assertEquals(9001L, data.getTurnId(), "返回的 turnId 必须与落库轮次一致");

        // 受理发生在请求线程：交给执行的上下文已经带上落库返回的 turnId，无需异步等待。
        ArgumentCaptor<RuntimeContext> accepted = ArgumentCaptor.forClass(RuntimeContext.class);
        verify(chatExecutor).submitAsync(accepted.capture());
        assertEquals(9001L, accepted.getValue().turnId(), "交给异步执行的上下文必须带上已落库的 turnId");

        // 顺序不可反：单飞校验先于受理（否则并发被拒时留下孤行），受理先于异步执行。
        InOrder order = inOrder(chatExecutor);
        order.verify(chatExecutor).admit(context);
        order.verify(chatExecutor).submitAsync(any(RuntimeContext.class));

        // 受理入口不建 emitter、不订阅：实时事件已由会话级订阅承载。
        verify(sseEventPublisher, never()).connect(anyLong());
    }

    @Test
    @DisplayName("受理失败：返回错误且运行资格已释放 —— 紧接着的第二次受理能成功")
    void commitFailureReleasesRunTokenSoNextAcceptanceSucceeds() {
        // 两次上下文用不同的 executionId：RuntimeContext 是值对象，相同会撞上同一套桩。
        RuntimeContext first = context("2105000000000000001");
        when(requestPreparer.prepare(any(ChatCommand.class))).thenReturn(first);
        doThrow(new IllegalStateException("db down")).when(chatExecutor).admit(first);

        assertThrows(IllegalStateException.class, () -> chatService.acceptCommand(command()));
        verify(chatExecutor, never()).submitAsync(any());

        // 若受理失败时没释放运行资格，这一次 beginRoot 会抛「该会话正在执行中」。
        RuntimeContext second = context("2105000000000000002");
        when(requestPreparer.prepare(any(ChatCommand.class))).thenReturn(second);
        when(chatExecutor.admit(second)).thenReturn(second.withTurnId(9002L));

        Result<ChatAcceptanceVO> result = assertDoesNotThrow(() -> chatService.acceptCommand(command()));
        assertEquals(9002L, result.getData().getTurnId(), "释放资格后才能受理的第二次必须拿到新轮次 ID");
    }
}
