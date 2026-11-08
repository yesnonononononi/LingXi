package com.summit.dp.workflow.application.input;

import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import com.summit.dp.workflow.infrastructure.harness.SessionAttributeRestorer;
import com.summit.dp.workflow.application.resume.SuspendedExecutionResumer;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.core.runtime.loop.ExecutionControl;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.CompletableFuture;
import com.summit.dp.shared.support.InputTestSupport;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.application.chat.ChatCommand;
import com.summit.dp.workflow.application.chat.PreparedChatExecutor;
import com.summit.dp.workflow.application.chat.RequestPreparer;
import com.summit.dp.workflow.application.chat.RuntimeContext;
import com.summit.dp.workflow.application.chat.ExecutionContext;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import com.summit.dp.workflow.application.input.MailInputChannel;
import com.summit.dp.workflow.application.input.BackgroundTaskChannel;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskNotifications;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.task.domain.repository.TaskRepository;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.StaticListableBeanFactory;

import java.util.ArrayList;
import java.util.Map;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class InputTurnContinuationTest {
    private final EmailService emails = mock(EmailService.class);
    private final TaskRepository taskRepository = mock(TaskRepository.class);
    private final ExecutionRepository executions = mock(ExecutionRepository.class);
    private final ChatTurnRepository turns = mock(ChatTurnRepository.class);
    private final SessionExecutionRegistry registry = new SessionExecutionRegistry();
    private final MailInputChannel mail = new MailInputChannel(emails);
    private final BackgroundTaskChannel tasks = new BackgroundTaskChannel(taskRepository, new BackgroundTaskNotifications());
    private final RequestPreparer preparer = mock(RequestPreparer.class);
    private final PreparedChatExecutor executor = mock(PreparedChatExecutor.class);
    private final InputTurnAdmission admission = mock(InputTurnAdmission.class);
    private final InputWakeupService wakeups = mock(InputWakeupService.class);
    private final InputTurnContinuation service = new InputTurnContinuation(executions, turns, registry, mail, tasks,
            admission, preparer, executor,
            new StaticListableBeanFactory(Map.of("wakeups", wakeups)).getBeanProvider(InputWakeupService.class));

    private RuntimeContext preparedContext() {
        RuntimeContext context = mock(RuntimeContext.class);
        when(context.executionContext()).thenReturn(ExecutionContext.root(10L, "101", null, null, null, null));
        when(context.pendingUserMessage()).thenReturn(UserMessageEntity.from("自动续跑输入"));
        return context;
    }

    private Execution previous() {
        Execution execution = Execution.builder().id("100").executionState(ExecutionState.COMPLETED)
                .messages(new ArrayList<>()).agentRequest(AgentRequest.builder().runtimeParameters(
                        AgentRuntimeParameters.builder().attributes(Map.of(ExecutionAttributes.SESSION_ID, "10",
                                ExecutionAttributes.AGENT_ID, "7")).build()).build()).build();
        when(emails.pendingItemsUndelivered(10L, 7L)).thenReturn(List.of(EmailMessageVO.builder().id(1L)
                .emailId(2L).senderId(8L).content("迟到的真实输入").build()));
        // 认领是注入前置：真实实现逐条认领，拿不到投递权就不注入。
        when(emails.claimDelivery(anyLong(), any())).thenReturn(true);
        return execution;
    }

    @Test void normalCompletionAdmitsOneRealNewTurnAndKeepsTheInputBasedCommandId() {
        Execution previous = previous();
        RuntimeContext context = preparedContext();
        when(preparer.prepare(any())).thenReturn(context);
        when(admission.admit(eq(context), eq(previous), anyString(), anyList(), anyList())).thenReturn(context);
        AtomicBoolean admitted = new AtomicBoolean();
        when(turns.findByCommandId(anyString())).thenAnswer(call -> admitted.get()
                ? Optional.of(ChatTurn.builder().id(20L).build()) : Optional.empty());
        doAnswer(call -> { admitted.set(true); return null; }).when(executor).submitAsync(context);
        service.continueTurn(previous);
        registry.finishRoot(10L, "101");
        service.continueTurn(previous);
        verify(executor).submitAsync(context);
        verify(preparer).prepare(argThat(command -> command.sessionId().equals(10L)
                && command.input().contains("迟到的真实输入") && command.agentId().equals(7L)));
        assertEquals(Map.of(UserMessageEntity.COMPACT, false), context.pendingUserMessage().getAttrs());
        assertEquals(ExecutionState.COMPLETED, previous.getExecutionState());
    }

    @Test void contextWriteCompletesBeforeLateInputCanPrepareANewTurn() throws Exception {
        Execution previous = previous();
        ExecutionControl control = mock(ExecutionControl.class);
        ModelContextService contexts = mock(ModelContextService.class);
        previous.setExecutionState(ExecutionState.SUSPENDED);
        when(control.resume(previous)).thenAnswer(call -> {
            previous.setExecutionState(ExecutionState.COMPLETED);
            return previous;
        });
        SuspendedExecutionResumer resumer = new SuspendedExecutionResumer(mock(SessionAttributeRestorer.class), contexts,
                new StaticListableBeanFactory(Map.of("control", control)).getBeanProvider(ExecutionControl.class));
        RuntimeContext context = preparedContext();
        when(preparer.prepare(any(ChatCommand.class))).thenReturn(context);
        AtomicBoolean gateHeld = new AtomicBoolean();
        AtomicBoolean contextCommitted = new AtomicBoolean();
        AtomicBoolean admittedEarly = new AtomicBoolean();
        CountDownLatch writing = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch checking = new CountDownLatch(1);
        doAnswer(call -> {
            gateHeld.set(Thread.holdsLock(ExecutionCoordination.monitor("session:10")));
            writing.countDown();
            if (!release.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("等待测试放行超时");
            contextCommitted.set(true);
            return null;
        }).when(contexts).replace(10L, previous.getMessages());
        when(admission.admit(eq(context), eq(previous), anyString(), anyList(), anyList())).thenAnswer(call -> {
            admittedEarly.set(!contextCommitted.get());
            return context;
        });
        CompletableFuture<Void> old = CompletableFuture.runAsync(() -> resumer.resume(previous, 10L));
        assertTrue(writing.await(5, TimeUnit.SECONDS));
        CompletableFuture<Void> fresh;
        try {
            fresh = CompletableFuture.runAsync(() -> { checking.countDown(); service.continueTurn(previous); });
            assertTrue(checking.await(5, TimeUnit.SECONDS));
        } finally {
            release.countDown();
        }
        CompletableFuture.allOf(old, fresh).get(5, TimeUnit.SECONDS);
        assertTrue(gateHeld.get(), "旧轮上下文回写必须持有同一把会话门闩");
        assertFalse(admittedEarly.get());
        verify(executor).submitAsync(context);
    }

    @Test void twoConcurrentChecksCreateExactlyOneAuthoritativeTurn() throws Exception {
        Execution previous = previous();
        RuntimeContext context = preparedContext();
        when(preparer.prepare(any(ChatCommand.class))).thenReturn(context);
        when(admission.admit(eq(context), eq(previous), anyString(), anyList(), anyList())).thenReturn(context);
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch release = new CountDownLatch(1);
        Runnable check = () -> {
            ready.countDown();
            try {
                assertTrue(release.await(5, TimeUnit.SECONDS));
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(interrupted);
            }
            service.continueTurn(previous);
        };
        CompletableFuture<Void> first = CompletableFuture.runAsync(check);
        CompletableFuture<Void> second = CompletableFuture.runAsync(check);
        assertTrue(ready.await(5, TimeUnit.SECONDS));
        release.countDown();
        CompletableFuture.allOf(first, second).get(5, TimeUnit.SECONDS);
        verify(admission).admit(eq(context), eq(previous), anyString(), anyList(), anyList());
        verify(executor).submitAsync(context);
    }

    @Test void cancellationRequestedWhilePreparingCannotBeClearedByAutomaticAdmission() {
        Execution previous = previous();
        when(preparer.prepare(any(ChatCommand.class))).thenAnswer(call -> {
            registry.cancelRoot(10L);
            return preparedContext();
        });
        service.continueTurn(previous);
        verifyNoInteractions(admission, executor);
        assertTrue(registry.isCancelled(10L));
    }

    @Test void oldNotificationIsRecheckedAgainstTheAuthoritativeLatestExecution() {
        Execution previous = previous();
        when(executions.findLatestBySessionAndStatus(List.of(10L))).thenReturn(InputTestSupport.latestStoredExecution(200L));
        service.continueTurn(previous);
        verify(wakeups).resumeIfInputPending(200L);
        verifyNoInteractions(admission, executor);
    }
}
