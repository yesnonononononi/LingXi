package com.summit.dp.toolcall;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.execution.SuspendedExecutionResumer;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.event.ToolCallEventPublisher;
import com.summit.dp.shared.utils.CommandDigest;
import com.summit.dp.shared.vo.ToolCallVO;
import com.summit.dp.toolcall.api.dto.ToolCallDecisionCommand;
import com.summit.dp.toolcall.api.dto.ToolCallDecisionReceipt;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.impl.VersionedToolCallDecisionService;
import com.summit.dp.toolcall.application.vo.DecisionConflictException;
import com.summit.dp.toolcall.application.vo.DecisionErrorCode;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallAction;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.transaction.TransactionStatus;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Callable;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * v2 决策入口（{@link VersionedToolCallDecisionService}）回归。
 *
 * <p>覆盖三类互相独立、各有唯一正确解的语义：</p>
 * <ol>
 *   <li><b>同 commandId + 同摘要</b> → 返回首次实际结论，且不重新执行；</li>
 *   <li><b>同 commandId + 不同摘要</b> → {@code COMMAND_CONFLICT}，不静默丢弃后一次意图；</li>
 *   <li><b>另一 commandId 争抢已决互动</b> → {@code DECISION_ALREADY_APPLIED} + 实际最新视图。</li>
 * </ol>
 *
 * <p>并发用例用 {@link CyclicBarrier} 让两个决策同时进入同 execution 的门闩，
 * <b>不靠固定 sleep 赌竞态</b>：闸点两侧的线程都到齐才继续，时序是构造出来的而不是等出来的。</p>
 */
class VersionedToolCallDecisionTest {

    private static final long CONVERSATION_ID = 2L;
    private static final long EXECUTION_ID = 3L;
    private static final String EXECUTION_ID_TEXT = "3";

    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);
    private final ExecutionRepository executionRepository = mock(ExecutionRepository.class);
    private final ExecutionControl executionControl = mock(ExecutionControl.class);
    private final ModelContextService modelContextService = mock(ModelContextService.class);
    private final ExecutionIdentity executionIdentity = mock(ExecutionIdentity.class);
    private final SseEventPublisher sseEventPublisher = mock(SseEventPublisher.class);
    private final ToolCallEventPublisher events = mock(ToolCallEventPublisher.class);
    private final ExecutionResumeCoordinator resumeCoordinator = mock(ExecutionResumeCoordinator.class);
    private final ObjectMapper mapper = new ObjectMapper();

    private VersionedToolCallDecisionService service;
    private SuspendedExecutionResumer resumer;

    @BeforeEach
    void setup() {
        TransactionTemplate transactions = mock(TransactionTemplate.class);
        doAnswer(invocation -> {
            Consumer<TransactionStatus> action = invocation.getArgument(0);
            action.accept(mock(TransactionStatus.class));
            return null;
        }).when(transactions).executeWithoutResult(any());

        when(executionIdentity.resolveRootSessionId(CONVERSATION_ID)).thenReturn(CONVERSATION_ID);
        // 默认无未决槽位：单卡决策应当直接派发恢复。
        when(toolCallRepository.listUnresolvedByExecutionId(EXECUTION_ID)).thenReturn(List.of());
        when(resumeCoordinator.accept(EXECUTION_ID)).thenReturn(ResumeDisposition.QUEUED);

        resumer = new SuspendedExecutionResumer(toolCallRepository,
                new SessionAttributeRestorer(mock(SessionRepository.class)), modelContextService,
                provider(executionControl));
        service = new VersionedToolCallDecisionService(toolCallRepository,
                new ToolCallConverter(mapper), executionIdentity, modelContextService,
                sseEventPublisher, events, transactions, provider(executionRepository),
                resumer, resumeCoordinator);
    }

    // ------------------------------------------------------------------
    // 态一：同命令重试
    // ------------------------------------------------------------------

    @Test
    @DisplayName("同 commandId 同摘要重试：返回首次实际结论，不重新落库也不重新派发恢复")
    void retryWithSameDigestReturnsFirstOutcomeWithoutReexecution() {
        ToolCall decided = planCall("call-plan");
        decided.attachDecision("cmd-1", digestOf(command("cmd-1", ToolCallAction.APPROVE, "可以")));
        decided.complete("{\"outcome\":\"APPROVED\",\"answer\":\"可以\"}");
        when(toolCallRepository.findById("call-plan")).thenReturn(Optional.of(decided));
        when(executionRepository.findById(EXECUTION_ID_TEXT))
                .thenReturn(Optional.of(execution(ExecutionState.SUSPENDED)));

        ToolCallDecisionReceipt receipt = service.decide(command("cmd-1", ToolCallAction.APPROVE, "可以"));

        assertTrue(receipt.decisionApplied(), "重试视同已受理");
        assertEquals("APPROVED", receipt.decision(), "回的是首次实际结论，不是本次重新推导的结论");
        assertEquals("completed", receipt.toolCall().getStatus());
        // 重试不得重新写库，也不得重复登记恢复意图（会重复唤醒 worker）
        verify(toolCallRepository, never()).updateById(any());
        verify(resumeCoordinator, never()).accept(anyLong());
    }

    @Test
    @DisplayName("同 commandId 重试：回执的恢复处置按当前事实回答，已进入运行态即 RUNNING")
    void retryReportsCurrentDispositionInsteadOfRequeuing() {
        ToolCall decided = planCall("call-plan");
        decided.attachDecision("cmd-1", digestOf(command("cmd-1", ToolCallAction.APPROVE, "可以")));
        decided.complete("{\"outcome\":\"APPROVED\"}");
        when(toolCallRepository.findById("call-plan")).thenReturn(Optional.of(decided));
        // 首次决策后 loop 已经跑起来：处置不能说成 QUEUED 让用户以为还要等
        when(executionRepository.findById(EXECUTION_ID_TEXT))
                .thenReturn(Optional.of(execution(ExecutionState.RUNNING)));

        ToolCallDecisionReceipt receipt = service.decide(command("cmd-1", ToolCallAction.APPROVE, "可以"));

        assertEquals(ResumeDisposition.RUNNING, receipt.resumeDisposition());
    }

    // ------------------------------------------------------------------
    // 态一之反例：同 commandId 不同内容
    // ------------------------------------------------------------------

    @Test
    @DisplayName("同 commandId 不同内容：拒绝（COMMAND_CONFLICT），不得把后一次意图当作成功覆盖")
    void sameCommandIdWithDifferentContentIsRejected() {
        ToolCall decided = planCall("call-plan");
        decided.attachDecision("cmd-1", digestOf(command("cmd-1", ToolCallAction.APPROVE, "可以")));
        decided.complete("{\"outcome\":\"APPROVED\",\"answer\":\"可以\"}");
        when(toolCallRepository.findById("call-plan")).thenReturn(Optional.of(decided));

        DecisionConflictException failure = assertThrows(DecisionConflictException.class,
                () -> service.decide(command("cmd-1", ToolCallAction.REJECT, null)));

        assertEquals(DecisionErrorCode.COMMAND_CONFLICT, failure.errorCode());
        assertEquals(DecisionErrorCode.COMMAND_CONFLICT.code(), failure.errorCode().code());
        // 结论仍是首次的：用户的第二次修改意图没有被静默吞掉，也没有被伪装成成功
        assertTrue(decided.getRawOutput().contains("APPROVED"));
        verify(resumeCoordinator, never()).accept(anyLong());
    }

    // ------------------------------------------------------------------
    // 态三：另一 commandId 争抢已决互动
    // ------------------------------------------------------------------

    @Test
    @DisplayName("另一 commandId 争抢已决互动：DECISION_ALREADY_APPLIED + 实际最新视图，不谎报成功")
    void otherCommandIdContestingDecidedInteractionGetsActualView() {
        ToolCall decided = planCall("call-plan");
        decided.attachDecision("cmd-1", digestOf(command("cmd-1", ToolCallAction.APPROVE, "可以")));
        decided.complete("{\"outcome\":\"APPROVED\",\"answer\":\"可以\"}");
        when(toolCallRepository.findById("call-plan")).thenReturn(Optional.of(decided));

        DecisionConflictException failure = assertThrows(DecisionConflictException.class,
                () -> service.decide(command("cmd-2", ToolCallAction.REJECT, null)));

        assertEquals(DecisionErrorCode.DECISION_ALREADY_APPLIED, failure.errorCode());
        // 实际最新视图随异常一起回去，前端据此把卡片刷成已决而不是继续显示可点
        assertNotNull(failure.latestView(), "必须带回实际最新视图");
        assertEquals("completed", ((ToolCallVO) failure.latestView()).getStatus());
        assertTrue(decided.getRawOutput().contains("APPROVED"), "首次结论不被后一次意图覆盖");
        verify(resumeCoordinator, never()).accept(anyLong());
    }

    // ------------------------------------------------------------------
    // 机器错误码：文案必须能区分「尚未暂停」与「已经结束」
    // ------------------------------------------------------------------

    @Test
    @DisplayName("执行已结束：EXECUTION_ENDED，文案不得让用户以为重试有用")
    void endedExecutionReportsEndedCode() {
        ToolCall card = planCall("call-plan");
        when(toolCallRepository.findById("call-plan")).thenReturn(Optional.of(card));
        when(executionRepository.findById(EXECUTION_ID_TEXT))
                .thenReturn(Optional.of(execution(ExecutionState.CANCELLED)));

        DecisionConflictException failure = assertThrows(DecisionConflictException.class,
                () -> service.decide(command("cmd-1", ToolCallAction.APPROVE, "可以")));

        assertEquals(DecisionErrorCode.EXECUTION_ENDED, failure.errorCode());
        assertTrue(failure.getMessage().contains("已结束"), "实际文案=" + failure.getMessage());
        assertTrue(failure.getMessage().contains("不会再生效"),
                "已结束场景必须明确告知重试无效，否则用户会无限重试");
    }

    @Test
    @DisplayName("执行尚未暂停：INTERACTION_NOT_READY，文案与「已结束」不同")
    void notSuspendedExecutionReportsNotReadyCode() {
        ToolCall card = planCall("call-plan");
        when(toolCallRepository.findById("call-plan")).thenReturn(Optional.of(card));
        when(executionRepository.findById(EXECUTION_ID_TEXT))
                .thenReturn(Optional.of(execution(ExecutionState.RUNNING)));

        DecisionConflictException failure = assertThrows(DecisionConflictException.class,
                () -> service.decide(command("cmd-1", ToolCallAction.APPROVE, "可以")));

        assertEquals(DecisionErrorCode.INTERACTION_NOT_READY, failure.errorCode());
        // 尚未暂停 = 等一会儿再提交；已结束 = 永远不生效。两者用户动作相反，文案不能混。
        assertTrue(failure.getMessage().contains("尚未暂停"), "实际文案=" + failure.getMessage());
        assertTrue(failure.getMessage().contains("等待"), "必须告知「等一下再提交」而不是让用户干等");
    }

    @Test
    @DisplayName("准备中的卡片：INTERACTION_NOT_READY，不落库")
    void preparingCardIsRejectedWithoutWrite() {
        ToolCall card = planCall("call-preparing").toBuilder().status(ToolCallStatus.PREPARING).build();
        when(toolCallRepository.findById("call-preparing")).thenReturn(Optional.of(card));

        DecisionConflictException failure = assertThrows(DecisionConflictException.class,
                () -> service.decide(new ToolCallDecisionCommand(CONVERSATION_ID, "call-preparing",
                        "cmd-1", 1L, ToolCallAction.APPROVE, "可以")));

        assertEquals(DecisionErrorCode.INTERACTION_NOT_READY, failure.errorCode());
        verify(toolCallRepository, never()).updateById(any());
    }

    @Test
    @DisplayName("版本过期：STATE_CONFLICT，客户端必须刷新而不是硬覆盖")
    void staleExpectedVersionReportsStateConflict() {
        ToolCall card = planCall("call-plan");
        when(toolCallRepository.findById("call-plan")).thenReturn(Optional.of(card));

        DecisionConflictException failure = assertThrows(DecisionConflictException.class,
                () -> service.decide(new ToolCallDecisionCommand(CONVERSATION_ID, "call-plan",
                        "cmd-1", 99L, ToolCallAction.APPROVE, "可以")));

        assertEquals(DecisionErrorCode.STATE_CONFLICT, failure.errorCode());
        verify(toolCallRepository, never()).updateById(any());
    }

    @Test
    @DisplayName("归属校验：拿 A 会话的卡片 id 去 B 会话提交必须被挡住")
    void conversationMismatchIsRejected() {
        ToolCall card = planCall("call-plan");
        when(toolCallRepository.findById("call-plan")).thenReturn(Optional.of(card));

        DecisionConflictException failure = assertThrows(DecisionConflictException.class,
                () -> service.decide(new ToolCallDecisionCommand(999L, "call-plan",
                        "cmd-1", 1L, ToolCallAction.APPROVE, "可以")));

        assertEquals(DecisionErrorCode.STATE_CONFLICT, failure.errorCode());
    }

    // ------------------------------------------------------------------
    // 动作判别：CHOICE 的回答不得隐含成 APPROVED
    // ------------------------------------------------------------------

    @Test
    @DisplayName("CHOICE 的 ANSWER 落 ANSWERED 而非 APPROVED：语义显式化，回放与审计才有依据")
    void choiceAnswerIsRecordedAsAnsweredNotApproved() {
        ToolCall card = choiceCall("call-choice");
        when(toolCallRepository.findById("call-choice")).thenReturn(Optional.of(card));
        when(executionRepository.findById(EXECUTION_ID_TEXT)).thenReturn(Optional.of(execution(
                ExecutionState.SUSPENDED,
                ToolMessageEntity.builder().id("call-choice").name("require_choice").text("pending").build())));

        ToolCallDecisionReceipt receipt = service.decide(
                new ToolCallDecisionCommand(CONVERSATION_ID, "call-choice", "cmd-1", 1L,
                        ToolCallAction.ANSWER, "方案 B"));

        assertEquals("ANSWERED", receipt.decision());
        assertTrue(card.getRawOutput().contains("ANSWERED"));
    }

    @Test
    @DisplayName("ANSWER 动作必须带答复内容：空答复无法落回槽位")
    void answerActionWithoutTextIsRejected() {
        ToolCall card = choiceCall("call-choice");
        when(toolCallRepository.findById("call-choice")).thenReturn(Optional.of(card));

        assertThrows(com.summit.dp.shared.exception.ClientException.class,
                () -> service.decide(new ToolCallDecisionCommand(CONVERSATION_ID, "call-choice",
                        "cmd-1", 1L, ToolCallAction.ANSWER, "   ")));
    }

    // ------------------------------------------------------------------
    // 并发决策不丢槽位
    // ------------------------------------------------------------------

    @Test
    @DisplayName("并发决策不丢槽位：两张卡片同时提交，各自槽位都被写回，无一被覆盖")
    void concurrentDecisionsOnSameExecutionKeepBothSlots() throws Exception {
        // 两张卡片挂在同一个执行的检查点上，基于同一旧状态并发决策
        ToolCall first = planCall("call-a");
        ToolCall second = planCall("call-b");
        ToolMessageEntity slotA = ToolMessageEntity.builder().id("call-a").name("create_plan").text("pending").build();
        ToolMessageEntity slotB = ToolMessageEntity.builder().id("call-b").name("create_plan").text("pending").build();
        Execution shared = execution(ExecutionState.SUSPENDED, slotA, slotB);
        when(toolCallRepository.findById("call-a")).thenReturn(Optional.of(first));
        when(toolCallRepository.findById("call-b")).thenReturn(Optional.of(second));
        when(executionRepository.findById(EXECUTION_ID_TEXT)).thenReturn(Optional.of(shared));

        CyclicBarrier gate = new CyclicBarrier(2);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<ToolCallDecisionReceipt> left = pool.submit(decisionTask(first, gate, "可以"));
            Future<ToolCallDecisionReceipt> right = pool.submit(decisionTask(second, gate, "同意"));
            assertNotNull(left.get(10, TimeUnit.SECONDS));
            assertNotNull(right.get(10, TimeUnit.SECONDS));
        } finally {
            pool.shutdownNow();
        }

        assertEquals("可以", slotA.getText(), "第一张卡片的槽位不能被并发决策覆盖丢失");
        assertEquals("同意", slotB.getText(), "第二张卡片的槽位不能被并发决策覆盖丢失");
        assertEquals(ToolCallStatus.COMPLETED, first.getStatus());
        assertEquals(ToolCallStatus.COMPLETED, second.getStatus());
        // 两张卡片都落库：后到的一方不能因为「同 execution 串行」而吃掉先到的一方的结论
        verify(toolCallRepository, times(2)).updateById(any());
    }

    private Callable<ToolCallDecisionReceipt> decisionTask(ToolCall card, CyclicBarrier gate, String text) {
        return () -> {
            // 闸点：两个决策都到达后才继续，制造真正的临界区重叠
            gate.await(10, TimeUnit.SECONDS);
            return service.decide(new ToolCallDecisionCommand(CONVERSATION_ID, card.getId(),
                    "cmd-" + card.getId(), 1L, ToolCallAction.APPROVE, text));
        };
    }

    // ------------------------------------------------------------------
    // 构桩
    // ------------------------------------------------------------------

    private ToolCallDecisionCommand command(String commandId, ToolCallAction action, String text) {
        return new ToolCallDecisionCommand(CONVERSATION_ID, "call-plan", commandId, 1L, action, text);
    }

    /**
     * 决策摘要：与生产侧 {@code VersionedToolCallDecisionService#buildDigest} 调同一个
     * {@link CommandDigest}，测试不重写一份算法（重写就会在算法演进时静默假绿）。
     */
    private String digestOf(ToolCallDecisionCommand command) {
        return CommandDigest.build(command.toolCallId(), command.conversationId(), command.expectedVersion(),
                command.action().wireValue(), command.text());
    }

    private ToolCall planCall(String id) {
        return ToolCall.builder().id(id).conversationId(CONVERSATION_ID).executionId(EXECUTION_ID)
                .toolName("create_plan").type(ToolCallType.PROMISE).status(ToolCallStatus.PENDING)
                .content("{\"kind\":\"PLAN\",\"title\":\"T\",\"text\":\"body\"}").rawInput("{\"args\":{}}")
                .createdAt(Instant.now()).updatedAt(Instant.now()).build();
    }

    private ToolCall choiceCall(String id) {
        return ToolCall.builder().id(id).conversationId(CONVERSATION_ID).executionId(EXECUTION_ID)
                .toolName("require_choice").type(ToolCallType.PROMISE).status(ToolCallStatus.PENDING)
                .content("{\"kind\":\"CHOICE\",\"question\":\"Q\",\"options\":[\"A\",\"B\"]}").rawInput("{\"args\":{}}")
                .createdAt(Instant.now()).updatedAt(Instant.now()).build();
    }

    private Execution execution(ExecutionState state, ToolMessageEntity... messages) {
        return Execution.builder().id(EXECUTION_ID_TEXT).executionState(state)
                .agentRequest(AgentRequest.builder()
                        .runtimeParameters(AgentRuntimeParameters.builder()
                                .attributes(Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(CONVERSATION_ID)))
                                .build())
                        .build())
                .messages(new ArrayList<>(List.of(messages))).build();
    }

    @SuppressWarnings("unchecked")
    private static <T> ObjectProvider<T> provider(T value) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(value);
        return provider;
    }
}
