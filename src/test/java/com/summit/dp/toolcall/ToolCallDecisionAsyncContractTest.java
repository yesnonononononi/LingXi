package com.summit.dp.toolcall;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.shared.concurrent.ManagedAsyncExecutor;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallKind;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.workflow.application.approval.ToolCallDecisionService;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.workflow.application.approval.ChoiceAnswersValidator;
import com.summit.dp.workflow.application.approval.CommandApprovalExecutor;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.workflow.application.decision.InteractionDecisionEngine;
import com.summit.dp.workflow.application.decision.ImmediateSlotResolutionStrategy;
import com.summit.dp.workflow.application.decision.ReactiveDecisionContract;
import com.summit.dp.workflow.application.decision.TwoPhaseCommandResolutionStrategy;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.infrastructure.harness.HarnessExecutionGate;
import com.summit.dp.workflow.application.lifecycle.UnresolvedToolSuspensionGate;
import com.summit.dp.workflow.application.resume.SuspendedExecutionResumer;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.transaction.TransactionStatus;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CopyOnWriteArrayList;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * v1 SSE 契约与线程归属：<b>连接先开、恢复跑完、连接才关</b>。
 *
 * <p><b>为什么必须按调用序列断言</b>：前端依赖「连接还开着」表示仍在恢复。若把
 * {@code finish} 提到恢复之前，接口照旧返回、恢复照旧发生，任何「结果对不对」的断言都看不出来 ——
 * 只有顺序能暴露它。</p>
 *
 * <p><b>为什么还要断言线程名</b>：本批改动只是把公共 {@code ForkJoinPool} 换成受管执行器，
 * 行为上一模一样。不锚定线程身份，把实现改回 {@code CompletableFuture.runAsync(task)} 依然全绿。</p>
 */
class ToolCallDecisionAsyncContractTest {

    private static final long CONVERSATION_ID = 2L;
    private static final long EXECUTION_ID = 3L;
    private static final String TOOL_CALL_ID = "call-plan";

    private final List<String> events = Collections.synchronizedList(new ArrayList<>());
    private final List<String> workerThreads = new CopyOnWriteArrayList<>();

    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);
    private final ExecutionRepository executionRepository = mock(ExecutionRepository.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final SseEventPublisher sseEventPublisher = mock(SseEventPublisher.class);
    private final ExecutionLocator executionLocator = mock(ExecutionLocator.class);
    private final UnresolvedToolSuspensionGate unresolvedGate = mock(UnresolvedToolSuspensionGate.class);
    private final SuspendedExecutionResumer resumer = mock(SuspendedExecutionResumer.class);
    private final SseEmitter emitter = mock(SseEmitter.class);

    private ManagedAsyncExecutor asyncExecutor;
    private Logger logger;
    private ListAppender<ILoggingEvent> logs;

    @BeforeEach
    void setup() {
        asyncExecutor = new ManagedAsyncExecutor();
        logger = (Logger) LoggerFactory.getLogger(ToolCallDecisionService.class);
        logs = new ListAppender<>();
        logs.start();
        logger.addAppender(logs);

        when(sseEventPublisher.connect(anyLong())).thenAnswer(invocation -> {
            events.add("connect");
            return emitter;
        });
        doAnswer(invocation -> {
            // 收尾跑在推送线程上；记下是谁关的流。
            workerThreads.add(Thread.currentThread().getName());
            events.add("finish");
            return null;
        }).when(sseEventPublisher).finish(emitter);
        when(executionLocator.resolveRootSessionId(CONVERSATION_ID)).thenReturn(CONVERSATION_ID);
        when(unresolvedGate.hasUnresolvedSlot(EXECUTION_ID)).thenReturn(false);
    }

    @AfterEach
    void shutdown() {
        logger.detachAppender(logs);
        logs.stop();
        asyncExecutor.shutdown();
    }

    @Test
    @DisplayName("恢复跑完之后才关流：connect → resume → finish，且两者都跑在受管线程上")
    void resumeRunsBeforeEmitterIsFinished() throws Exception {
        ToolCall plan = planCall();
        ToolCallDecisionService service = service(plan);

        service.decide(plan, true, "可以");

        awaitEvent("finish");
        assertEquals(List.of("connect", "resume", "finish"), events,
                "v1 契约要求「先连上 → 恢复跑完 → 再关流」，实际: " + events);
        assertEquals(2, workerThreads.size(), "resume 与 finish 各记一次线程: " + workerThreads);
        for (String worker : workerThreads) {
            assertTrue(worker.startsWith(ManagedAsyncExecutor.THREAD_NAME_PREFIX),
                    "恢复与关流都必须跑在受管执行器的线程上，实际: " + worker);
            assertFalse(worker.startsWith("ForkJoinPool.commonPool"),
                    "不得回落到公共 ForkJoinPool，实际: " + worker);
        }
    }

    @Test
    @DisplayName("执行器已关闭：不抛给调用方、仍开流并立即关流，且留下 warn")
    void closedExecutorStillClosesTheStream() {
        asyncExecutor.shutdown();
        ToolCall plan = planCall();
        ToolCallDecisionService service = service(plan);

        service.decide(plan, true, "可以");

        assertEquals(List.of("connect", "finish"), events,
                "后台段起不来时也必须关流，绝不留一条永不结束的连接，实际: " + events);
        assertTrue(events.indexOf("finish") == events.size() - 1, "关流必须是最后一个动作");
        assertTrue(logs.list.stream().anyMatch(event -> event.getLevel() == Level.WARN
                        && event.getFormattedMessage().contains("恢复任务未被受理")),
                "拒绝必须留一条可检索的 warn，实际日志: " + logs.list.stream()
                        .map(ILoggingEvent::getFormattedMessage).toList());
        verify(resumer, never()).resume(any(), anyLong());
    }

    private void awaitEvent(String name) {
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(5);
        while (System.nanoTime() < deadline) {
            if (events.contains(name)) {
                return;
            }
            try {
                Thread.sleep(5L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        throw new AssertionError("等待事件超时: " + name + "，已有: " + events);
    }

    private ToolCallDecisionService service(ToolCall plan) {
        when(toolCallRepository.findById(TOOL_CALL_ID)).thenReturn(Optional.of(plan));
        TransactionTemplate transactions = mock(TransactionTemplate.class);
        doAnswer(invocation -> {
            ((java.util.function.Consumer<TransactionStatus>) invocation.getArgument(0))
                    .accept(mock(TransactionStatus.class));
            return null;
        }).when(transactions).executeWithoutResult(any());
        Execution execution = suspendedExecution();
        when(executionRepository.findById(String.valueOf(EXECUTION_ID))).thenReturn(Optional.of(execution));
        doAnswer(invocation -> {
            workerThreads.add(Thread.currentThread().getName());
            events.add("resume");
            return null;
        }).when(resumer).resume(any(Execution.class), anyLong());
        ToolCallConverter converter = new ToolCallConverter(new ObjectMapper());
        ReactiveDecisionContract contract = new ReactiveDecisionContract(
                new CardAvailabilityPolicy(new HarnessExecutionGate(provider(executionRepository),
                        provider(mock(ExecutionActivity.class)))));
        InteractionDecisionEngine engine = new InteractionDecisionEngine(toolCallRepository, converter,
                provider(executionRepository), modelContextService, transactions, mock(ExecutionResumeCoordinator.class),
                unresolvedGate,
                new ImmediateSlotResolutionStrategy(converter,
                        new ChoiceAnswersValidator(new ObjectMapper(), mock(MessageRepository.class)), toolCallRepository),
                new TwoPhaseCommandResolutionStrategy(mock(CommandApprovalExecutor.class), toolCallRepository, converter));
        return new ToolCallDecisionService(executionLocator, sseEventPublisher, provider(executionRepository),
                unresolvedGate, resumer, asyncExecutor, engine, contract);
    }

    private ToolCall planCall() {
        return ToolCall.builder().id(TOOL_CALL_ID).conversationId(CONVERSATION_ID).executionId(EXECUTION_ID)
                .toolName("create_plan").type(ToolCallType.PROMISE).status(ToolCallStatus.PENDING)
                .content("{\"kind\":\"PLAN\",\"text\":\"计划\"}").rawInput("{\"args\":{}}")
                .createdAt(Instant.now()).updatedAt(Instant.now()).build();
    }

    /** 挂起执行里必须有一个对应的工具槽位，否则 {@code ExecutionToolSlot.write} 会拒绝写入。 */
    private Execution suspendedExecution() {
        ToolMessageEntity slot = ToolMessageEntity.builder().id(TOOL_CALL_ID).name("create_plan")
                .toolOutput("pending").build();
        List<Message> context = new ArrayList<>(List.of(slot));
        List<ToolCallRequest> requests = new ArrayList<>(List.of(ToolCallRequest.builder()
                .id(TOOL_CALL_ID).name("create_plan").requestIndex(0).arguments("{}").build()));
        return Execution.builder().id(String.valueOf(EXECUTION_ID)).agentId("chatAgent")
                .agentRequest(AgentRequest.builder().executionId(String.valueOf(EXECUTION_ID))
                        .messages(context)
                        .runtimeParameters(AgentRuntimeParameters.builder()
                                .attributes(Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(CONVERSATION_ID)))
                                .build())
                        .build())
                .executionState(ExecutionState.SUSPENDED).messages(context).build();
    }

    @SuppressWarnings("unchecked")
    private static <T> ObjectProvider<T> provider(T service) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(service);
        return provider;
    }
}
