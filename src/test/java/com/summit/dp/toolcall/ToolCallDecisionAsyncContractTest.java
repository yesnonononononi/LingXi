package com.summit.dp.toolcall;

import com.summit.dp.workflow.application.lifecycle.CoordinatorResumeAcceptance;

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
import com.summit.dp.workflow.application.decision.ToolCallDecisionService;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.workflow.application.decision.ChoiceAnswersValidator;
import com.summit.dp.workflow.application.decision.CommandApprovalExecutor;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.workflow.application.decision.InteractionDecisionEngine;
import com.summit.dp.workflow.application.decision.ImmediateSlotResolutionStrategy;
import com.summit.dp.workflow.application.decision.ReactiveDecisionContract;
import com.summit.dp.workflow.application.decision.TwoPhaseCommandResolutionStrategy;
import com.summit.dp.workflow.application.lifecycle.ExecutionResumeCoordinator;
import com.summit.dp.workflow.infrastructure.harness.HarnessExecutionGate;
import com.summit.dp.workflow.application.lifecycle.UnresolvedToolSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.SuspendedExecutionResumer;
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
import static org.junit.jupiter.api.Assertions.assertThrows;
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
    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);
    private final ExecutionRepository executionRepository = mock(ExecutionRepository.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final SseEventPublisher sseEventPublisher = mock(SseEventPublisher.class);
    private final ExecutionLocator executionLocator = mock(ExecutionLocator.class);
    private final UnresolvedToolSuspensionGate unresolvedGate = mock(UnresolvedToolSuspensionGate.class);
    private final ExecutionResumeCoordinator coordinator = mock(ExecutionResumeCoordinator.class);
    private final SseEmitter emitter = mock(SseEmitter.class);

    @BeforeEach
    void setup() {
        when(sseEventPublisher.connect(anyLong())).thenAnswer(invocation -> {
            events.add("connect");
            return emitter;
        });
        doAnswer(invocation -> {
            events.add("finish");
            return null;
        }).when(sseEventPublisher).finish(emitter);
        when(executionLocator.resolveRootSessionId(CONVERSATION_ID)).thenReturn(CONVERSATION_ID);
        when(unresolvedGate.hasUnresolvedSlot(EXECUTION_ID)).thenReturn(false);
        // 协调器受理即记录，回调留待用例手动触发：落定时机由队列决定，不由入口决定。
        when(coordinator.accept(anyLong(), any(), any())).thenAnswer(invocation -> {
            events.add("accept");
            return com.summit.dp.execution.application.service.ResumeDisposition.QUEUED;
        });
    }

    @Test
    @DisplayName("先连接再提交，落定回调之后才关流：connect → accept → finish")
    void connectThenAcceptThenFinishOnSettled() {
        ToolCall plan = planCall();
        ToolCallDecisionService service = service(plan);

        service.decide(plan, true, "可以");

        assertEquals(List.of("connect", "accept"), events,
                "恢复请求在连接之后提交，且落定前不得关流，实际: " + events);
        Runnable settled = settledCallback();
        settled.run();
        assertEquals(List.of("connect", "accept", "finish"), events,
                "关流必须由恢复落定驱动，实际: " + events);
    }

    @Test
    @DisplayName("决策失败：流以错误收尾并原样抛出，且不登记恢复")
    void decisionFailureClosesStreamWithErrorAndRethrows() {
        ToolCall plan = planCall();
        ToolCallDecisionService service = service(plan);
        when(executionRepository.findById(String.valueOf(EXECUTION_ID))).thenReturn(Optional.empty());

        assertThrows(com.summit.dp.shared.exception.ClientException.class,
                () -> service.decide(plan, true, "可以"));

        verify(emitter).completeWithError(any());
        assertEquals(List.of("connect"), events, "决策失败不得登记恢复，也不得走落定关流");
        verify(coordinator, never()).accept(anyLong(), any(), any());
    }

    @Test
    @DisplayName("幂等 no-op（卡片已有结论）：不登记恢复，连接立即关闭")
    void alreadyDecidedClosesStreamWithoutResume() {
        ToolCall finished = planCall();
        finished.complete("{\"outcome\":\"APPROVED\"}");
        ToolCallDecisionService service = service(finished);

        service.decide(finished, true, "可以");

        assertEquals(List.of("connect", "finish"), events,
                "没有恢复就没有落定回调，入口必须当场关流，实际: " + events);
        verify(coordinator, never()).accept(anyLong(), any(), any());
    }

    private Runnable settledCallback() {
        org.mockito.ArgumentCaptor<Runnable> captor = org.mockito.ArgumentCaptor.forClass(Runnable.class);
        verify(coordinator).accept(anyLong(), any(), captor.capture());
        return captor.getValue();
    }

    private ToolCallDecisionService service(ToolCall plan) {
        TransactionTemplate transactions = mock(TransactionTemplate.class);
        doAnswer(invocation -> {
            ((java.util.function.Consumer<TransactionStatus>) invocation.getArgument(0))
                    .accept(mock(TransactionStatus.class));
            return null;
        }).when(transactions).executeWithoutResult(any());
        when(toolCallRepository.findById(TOOL_CALL_ID)).thenReturn(Optional.of(plan));
        when(toolCallRepository.listByIds(any())).thenReturn(List.of(plan));
        when(executionRepository.findById(String.valueOf(EXECUTION_ID)))
                .thenReturn(Optional.of(suspendedExecution()));
        ToolCallConverter converter = new ToolCallConverter(new ObjectMapper());
        ReactiveDecisionContract contract = new ReactiveDecisionContract(
                new CardAvailabilityPolicy(new HarnessExecutionGate(provider(executionRepository),
                        provider(mock(ExecutionActivity.class)))));
        InteractionDecisionEngine engine = new InteractionDecisionEngine(toolCallRepository, converter,
                provider(executionRepository), modelContextService, transactions, new CoordinatorResumeAcceptance(coordinator),
                unresolvedGate,
                new ImmediateSlotResolutionStrategy(converter,
                        new ChoiceAnswersValidator(new ObjectMapper(), mock(MessageRepository.class)), toolCallRepository),
                new TwoPhaseCommandResolutionStrategy(mock(CommandApprovalExecutor.class), toolCallRepository, converter));
        return new ToolCallDecisionService(executionLocator, sseEventPublisher, engine, contract);
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