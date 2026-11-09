package com.summit.dp.agent;

import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.execution.domain.model.ExecutionStatus;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.user_configs.application.policy.CommandApprovalPolicy;
import com.summit.dp.workflow.application.input.InputWakeupService;
import com.summit.dp.workflow.application.chat.*;
import com.summit.dp.workflow.application.chat.impl.ChatServiceImpl;
import com.summit.dp.workflow.application.chat.SessionExecutionStopper;
import com.summit.dp.workflow.infrastructure.harness.SessionAttributeRestorer;
import com.summit.dp.workflow.application.lifecycle.ExecutionLifecycleOrchestrator;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.InOrder;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;

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
    private final PendingChatQueue pendingChats = new PendingChatQueue();
    private final SessionRepository sessions = mock(SessionRepository.class);

    private final ChatServiceImpl chatService = new ChatServiceImpl(
            sseEventPublisher, requestPreparer,
            mock(ExecutionLifecycleOrchestrator.class),
            sessions, registry,
            mock(ExecutionLocator.class), chatExecutor,
            mock(InputWakeupService.class), executionQueryService,
            mock(ResendTargetResolver.class), mock(ConversationRollbackService.class), mock(SessionExecutionStopper.class), pendingChats);

    @BeforeEach
    void sessionIsIdle() {
        // ensureSessionTreeIsIdle 读的是「会话下有无未终结执行」；返回空表即视为空闲。
        when(executionQueryService.latestStatesBySession(any())).thenReturn(Map.of());
        when(sessions.findById(ROOT_SESSION_ID)).thenReturn(Optional.of(
                Session.builder().id(ROOT_SESSION_ID).rootSessionId(0L).build()));
    }

    private static ChatCommand command() {
        return command("你好");
    }

    private static ChatCommand command(String input) {
        return new ChatCommand(input, ROOT_SESSION_ID, 7L, null, null, null, false, List.of(), List.of());
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
    void newSessionUsesThePreparedIdentityWhenTheRequestUsesTheZeroSentinel() {
        ChatCommand command = new ChatCommand("新会话", 0L, 7L, null, null, null, false, List.of(), List.of());
        RuntimeContext context = context("101");
        when(requestPreparer.prepare(command)).thenReturn(context);
        when(chatExecutor.admit(context)).thenReturn(context.withTurnId(901L));

        assertEquals(ROOT_SESSION_ID, chatService.acceptCommand(command).getData().getSessionId());
        assertTrue(registry.isRootRunning(ROOT_SESSION_ID));
        assertFalse(registry.isRootRunning(0L));
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

    @Test
    void queuesInServerOrderAndClaimsOnlyOneAfterTheRootSettles() {
        ChatCommand first = command("第一条");
        ChatCommand second = command("第二条");
        ChatCommand third = command("第三条");
        registry.beginRoot(ROOT_SESSION_ID, "old");
        ChatAcceptanceVO firstReceipt = chatService.acceptCommand(first).getData();
        ChatAcceptanceVO secondReceipt = chatService.acceptCommand(second).getData();
        assertNull(firstReceipt.getTurnId());
        assertNotEquals(firstReceipt.getPendingId(), secondReceipt.getPendingId());
        chatService.dispatchPending(ROOT_SESSION_ID);
        verifyNoInteractions(requestPreparer, chatExecutor);

        registry.finishRoot(ROOT_SESSION_ID, "old");
        when(executionQueryService.latestStatesBySession(any()))
                .thenReturn(Map.of(ROOT_SESSION_ID, List.of(ExecutionStatus.SUSPENDED)));
        chatService.dispatchPending(ROOT_SESSION_ID);
        verifyNoInteractions(requestPreparer, chatExecutor);

        when(executionQueryService.latestStatesBySession(any()))
                .thenReturn(Map.of(ROOT_SESSION_ID, List.of(ExecutionStatus.COMPLETED)));
        ChatAcceptanceVO thirdReceipt = chatService.acceptCommand(third).getData();
        assertNull(thirdReceipt.getTurnId());
        RuntimeContext firstContext = context("101");
        RuntimeContext secondContext = context("102");
        when(requestPreparer.prepare(first)).thenReturn(firstContext);
        when(requestPreparer.prepare(second)).thenReturn(secondContext);
        when(chatExecutor.admit(firstContext)).thenReturn(firstContext.withTurnId(901L));
        when(chatExecutor.admit(secondContext)).thenReturn(secondContext.withTurnId(902L));
        chatService.dispatchPending(ROOT_SESSION_ID);
        chatService.dispatchPending(ROOT_SESSION_ID);
        verify(requestPreparer, never()).prepare(second);
        registry.finishRoot(ROOT_SESSION_ID, "101");
        chatService.dispatchPending(ROOT_SESSION_ID);

        InOrder order = inOrder(chatExecutor);
        order.verify(chatExecutor).submitAsync(firstContext.withTurnId(901L));
        order.verify(chatExecutor).submitAsync(secondContext.withTurnId(902L));
        assertEquals(List.of(thirdReceipt.getPendingId()), pendingChats.snapshot(ROOT_SESSION_ID).entries()
                .stream().map(PendingChatQueue.Entry::id).toList());
    }

    @Test
    void terminalDuringResumeStillQueuesUntilContextWriteEnds() throws InterruptedException {
        CountDownLatch writingContext = new CountDownLatch(1);
        CountDownLatch allowWriteToFinish = new CountDownLatch(1);
        Thread resume = Thread.startVirtualThread(() -> ExecutionCoordination.resumeSession(ROOT_SESSION_ID, () -> {
            writingContext.countDown();
            try {
                allowWriteToFinish.await();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }));
        try {
            assertTrue(writingContext.await(5, TimeUnit.SECONDS));
            when(executionQueryService.latestStatesBySession(any()))
                    .thenReturn(Map.of(ROOT_SESSION_ID, List.of(ExecutionStatus.COMPLETED)));
            assertNotNull(chatService.acceptCommand(command()).getData().getPendingId());
            verifyNoInteractions(requestPreparer, chatExecutor);
        } finally {
            allowWriteToFinish.countDown();
            resume.join();
        }
        RuntimeContext context = context("101");
        when(requestPreparer.prepare(command())).thenReturn(context);
        when(chatExecutor.admit(context)).thenReturn(context.withTurnId(901L));
        chatService.dispatchPending(ROOT_SESSION_ID);
        verify(chatExecutor).submitAsync(context.withTurnId(901L));
    }

    @Test
    void failedAdmissionPreservesTheHeadAndExplicitResumeAllowsRetry() {
        registry.beginRoot(ROOT_SESSION_ID, "old");
        String pendingId = chatService.acceptCommand(command()).getData().getPendingId();
        registry.finishRoot(ROOT_SESSION_ID, "old");
        RuntimeContext context = context("101");
        when(requestPreparer.prepare(command())).thenReturn(context);
        when(chatExecutor.admit(context)).thenThrow(new IllegalStateException("db down"))
                .thenReturn(context.withTurnId(901L));

        chatService.dispatchPending(ROOT_SESSION_ID);
        chatService.dispatchPending(ROOT_SESSION_ID);
        assertTrue(chatService.pendingCommands(ROOT_SESSION_ID).paused());
        assertEquals(pendingId, chatService.pendingCommands(ROOT_SESSION_ID).entries().getFirst().id());
        verify(chatExecutor, never()).submitAsync(any());

        chatService.resumePendingCommands(ROOT_SESSION_ID);
        chatService.dispatchPending(ROOT_SESSION_ID);
        verify(chatExecutor).submitAsync(context.withTurnId(901L));
        assertTrue(chatService.pendingCommands(ROOT_SESSION_ID).entries().isEmpty());
    }
}
