package com.summit.dp.toolcall;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.core.runtime.workspace.ShellType;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolRegistry;
import com.summit.core.workspace.WorkspaceManager;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.SessionAttributeRestorer;
import com.summit.dp.execution.SuspendedExecutionResumer;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.event.SseEventPublisher;
import com.summit.dp.shared.utils.CommandDigest;
import com.summit.dp.shared.vo.ToolCallVO;
import com.summit.dp.toolcall.api.dto.ToolCallDecisionCommand;
import com.summit.dp.toolcall.api.dto.ToolCallDecisionReceipt;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.impl.ApprovalFinalizer;
import com.summit.dp.toolcall.application.service.impl.ApprovedCommandRestorer;
import com.summit.dp.toolcall.application.service.impl.CommandApprovalExecutor;
import com.summit.dp.toolcall.application.service.impl.CommandOutcomeResolver;
import com.summit.dp.toolcall.application.service.impl.VersionedToolCallDecisionService;
import com.summit.dp.toolcall.application.vo.DecisionConflictException;
import com.summit.dp.toolcall.application.vo.DecisionErrorCode;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallAction;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.tools.baseTools.terminal.CommandToolDefinitionExecutor;
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
import java.util.concurrent.CountDownLatch;
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
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
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
 * <p>命令审批（COMMAND）走独立命令链：批准必须真的执行命令（恰好一次），拒绝必须一次都不执行，
 * 执行中重试必须返回在途回执而不是重新执行或丢掉结论。</p>
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
    private final ExecutionResumeCoordinator resumeCoordinator = mock(ExecutionResumeCoordinator.class);
    private final RuntimeEventPublisher runtimeEvents = mock(RuntimeEventPublisher.class);
    private final ToolRegistry toolRegistry = mock(ToolRegistry.class);
    private final WorkspaceManager workspaces = mock(WorkspaceManager.class);
    private final CommandToolDefinitionExecutor commandExecutor = mock(CommandToolDefinitionExecutor.class);
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
        // 模拟框架 beginApproval：SUSPENDED → RUNNING。执行中重试的恢复处置据此回答 RUNNING。
        doAnswer(invocation -> {
            ((Execution) invocation.getArgument(0)).resumeChecked();
            return null;
        }).when(executionControl).beginApproval(any(Execution.class));

        resumer = new SuspendedExecutionResumer(toolCallRepository,
                new SessionAttributeRestorer(mock(SessionRepository.class)), modelContextService,
                provider(executionControl));
        ToolCallConverter converter = new ToolCallConverter(mapper);
        CommandApprovalExecutor commandApprovalExecutor = new CommandApprovalExecutor(toolCallRepository,
                converter, transactions,
                provider(executionControl), provider(executionRepository),
                new CommandOutcomeResolver(converter, runtimeEvents),
                new ApprovalFinalizer(toolCallRepository, converter, modelContextService,
                        runtimeEvents, transactions, provider(executionControl), resumer, resumeCoordinator),
                resumer,
                new ApprovedCommandRestorer(mapper, workspaces, provider(toolRegistry)),
                modelContextService,
                resumeCoordinator);
        service = new VersionedToolCallDecisionService(toolCallRepository,
                converter, modelContextService,
                sseEventPublisher, transactions, provider(executionRepository),
                resumer, resumeCoordinator, commandApprovalExecutor);
    }

    // ------------------------------------------------------------------
    // 态一：同命令重试
    // ------------------------------------------------------------------

    @Test
    @DisplayName("同 commandId 同摘要重试：返回首次实际结论，不重新落库也不重新派发恢复")
    void retryWithSameDigestReturnsFirstOutcomeWithoutReexecution() {
        ToolCall decided = planCall("call-plan");
        decided.attachDecision("cmd-1", buildDigest(command("cmd-1", ToolCallAction.APPROVE, "可以")));
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
        decided.attachDecision("cmd-1", buildDigest(command("cmd-1", ToolCallAction.APPROVE, "可以")));
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
        decided.attachDecision("cmd-1", buildDigest(command("cmd-1", ToolCallAction.APPROVE, "可以")));
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
        decided.attachDecision("cmd-1", buildDigest(command("cmd-1", ToolCallAction.APPROVE, "可以")));
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
    // COMMAND：批准 / 拒绝 / 执行中重试 / 版本冲突
    // ------------------------------------------------------------------

    @Test
    @DisplayName("命令批准：命令恰好执行一次，回执确认决策已应用")
    void commandApproveExecutesExactlyOnce() throws Exception {
        ToolCall card = commandCall("call-cmd");
        ToolMessageEntity slot = ToolMessageEntity.builder().id("call-cmd").name("command").text("pending").build();
        Execution execution = execution(ExecutionState.SUSPENDED, slot);
        ExecutionControlSignal signal = new ExecutionControlSignal(EXECUTION_ID_TEXT);
        CountDownLatch completed = new CountDownLatch(1);

        stubCommand(card, execution, signal, ToolExecuteResult.success("done"));
        doAnswer(invocation -> {
            if (((ToolCall) invocation.getArgument(0)).isCompleted()) {
                completed.countDown();
            }
            return null;
        }).when(toolCallRepository).updateById(any());

        ToolCallDecisionReceipt receipt = service.decide(new ToolCallDecisionCommand(CONVERSATION_ID, "call-cmd",
                "cmd-cmd", 1L, ToolCallAction.APPROVE, null));

        assertTrue(receipt.decisionApplied(), "回执必须确认决策已应用");
        assertEquals("APPROVED", receipt.decision());
        assertTrue(completed.await(5, TimeUnit.SECONDS), "命令应被异步执行并收尾");
        verify(commandExecutor, times(1)).execute(any());
        assertEquals(ToolCallStatus.COMPLETED, card.getStatus());
        assertTrue(slot.getText().contains("done"), "工具结果应写回真实命令输出");
    }

    @Test
    @DisplayName("命令拒绝：命令一次都不执行，工具结果为「用户拒绝，命令未执行」")
    void commandRejectNeverExecutesAndWritesRejectText() {
        ToolCall card = commandCall("call-rej");
        ToolMessageEntity slot = ToolMessageEntity.builder().id("call-rej").name("command").text("pending").build();
        Execution execution = execution(ExecutionState.SUSPENDED, slot);

        when(toolCallRepository.findById("call-rej")).thenReturn(Optional.of(card));
        when(executionRepository.findById(EXECUTION_ID_TEXT)).thenReturn(Optional.of(execution));

        ToolCallDecisionReceipt receipt = service.decide(new ToolCallDecisionCommand(CONVERSATION_ID, "call-rej",
                "cmd-rej", 1L, ToolCallAction.REJECT, null));

        assertEquals("REJECTED", receipt.decision());
        assertTrue(receipt.decisionApplied());
        verify(commandExecutor, never()).execute(any());
        // 拒绝不得依赖命令环境可重建：restore 需要的工作空间 / 注册表一次都不能碰
        verifyNoInteractions(workspaces, toolRegistry);
        assertEquals("用户拒绝，命令未执行", slot.getText());
        assertEquals(ToolCallStatus.COMPLETED, card.getStatus());
        assertTrue(card.getRawOutput().contains("REJECTED"));
    }

    @Test
    @DisplayName("命令执行中重试同 commandId+摘要：返回已受理的在途回执，不二次执行，结论仍是 APPROVED")
    void inflightDuplicateReturnsAcceptedReceiptWithoutReexecution() throws Exception {
        ToolCall card = commandCall("call-cmd");
        ToolMessageEntity slot = ToolMessageEntity.builder().id("call-cmd").name("command").text("pending").build();
        Execution execution = execution(ExecutionState.SUSPENDED, slot);
        ExecutionControlSignal signal = new ExecutionControlSignal(EXECUTION_ID_TEXT);

        when(toolCallRepository.findById("call-cmd")).thenReturn(Optional.of(card));
        when(executionRepository.findById(EXECUTION_ID_TEXT)).thenReturn(Optional.of(execution));
        when(executionRepository.register(EXECUTION_ID_TEXT)).thenReturn(signal);
        doReturn(commandTool()).when(toolRegistry).getTool("command");
        Workspace approvedWorkspace = workspace();
        when(workspaces.acquire(any(WorkspaceSpec.class))).thenReturn(approvedWorkspace);

        // 命令卡在执行中：第一次点击已受理，第二次点击在输出落库前到达。
        CountDownLatch running = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        CountDownLatch completed = new CountDownLatch(1);
        when(commandExecutor.execute(any())).thenAnswer(invocation -> {
            running.countDown();
            release.await(10, TimeUnit.SECONDS);
            return ToolExecuteResult.success("done");
        });
        doAnswer(invocation -> {
            if (((ToolCall) invocation.getArgument(0)).isCompleted()) {
                completed.countDown();
            }
            return null;
        }).when(toolCallRepository).updateById(any());

        ToolCallDecisionCommand command = new ToolCallDecisionCommand(CONVERSATION_ID, "call-cmd",
                "cmd-cmd", 1L, ToolCallAction.APPROVE, null);
        ToolCallDecisionReceipt first = service.decide(command);
        assertEquals("APPROVED", first.decision());
        assertTrue(running.await(10, TimeUnit.SECONDS), "命令应已开始执行");

        ToolCallDecisionReceipt duplicate = service.decide(command);

        assertTrue(duplicate.decisionApplied(), "在途重试视同已受理");
        assertEquals("APPROVED", duplicate.decision(), "输出未落库也不能把批准结论丢成 null");
        assertEquals(ResumeDisposition.RUNNING, duplicate.resumeDisposition(), "执行中应回答 RUNNING");
        // 在途期间命令只跑过一次：重试没有触发第二次执行
        verify(commandExecutor, times(1)).execute(any());

        release.countDown();
        assertTrue(completed.await(10, TimeUnit.SECONDS), "命令收尾应完成");
    }

    @Test
    @DisplayName("命令卡版本过期：STATE_CONFLICT，命令不执行也不落库")
    void commandStaleVersionDoesNotExecute() {
        ToolCall card = commandCall("call-cmd");
        when(toolCallRepository.findById("call-cmd")).thenReturn(Optional.of(card));

        DecisionConflictException failure = assertThrows(DecisionConflictException.class,
                () -> service.decide(new ToolCallDecisionCommand(CONVERSATION_ID, "call-cmd",
                        "cmd-cmd", 99L, ToolCallAction.APPROVE, null)));

        assertEquals(DecisionErrorCode.STATE_CONFLICT, failure.errorCode());
        verify(commandExecutor, never()).execute(any());
        verify(toolCallRepository, never()).updateById(any());
    }

    @Test
    @DisplayName("命令卡不接受 ANSWER：作答对命令无意义，不得静默当成拒绝")
    void commandAnswerIsRejected() {
        ToolCall card = commandCall("call-cmd");
        when(toolCallRepository.findById("call-cmd")).thenReturn(Optional.of(card));
        when(executionRepository.findById(EXECUTION_ID_TEXT)).thenReturn(Optional.of(execution(ExecutionState.SUSPENDED)));

        assertThrows(com.summit.dp.shared.exception.ClientException.class,
                () -> service.decide(new ToolCallDecisionCommand(CONVERSATION_ID, "call-cmd",
                        "cmd-cmd", 1L, ToolCallAction.ANSWER, "随便")));

        verify(commandExecutor, never()).execute(any());
        verify(toolCallRepository, never()).updateById(any());
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

    /** 命令批准链所需的最小桩：命令工具、匹配的工作空间、可执行的命令。 */
    private void stubCommand(ToolCall card, Execution execution, ExecutionControlSignal signal,
                             ToolExecuteResult result) {
        when(toolCallRepository.findById(card.getId())).thenReturn(Optional.of(card));
        when(executionRepository.findById(EXECUTION_ID_TEXT)).thenReturn(Optional.of(execution));
        when(executionRepository.register(EXECUTION_ID_TEXT)).thenReturn(signal);
        doReturn(commandTool()).when(toolRegistry).getTool("command");
        Workspace approvedWorkspace = workspace();
        when(workspaces.acquire(any(WorkspaceSpec.class))).thenReturn(approvedWorkspace);
        when(commandExecutor.execute(any())).thenReturn(result);
    }

    private ToolCallDecisionCommand command(String commandId, ToolCallAction action, String text) {
        return new ToolCallDecisionCommand(CONVERSATION_ID, "call-plan", commandId, 1L, action, text);
    }

    /**
     * 决策摘要：与生产侧 {@code VersionedToolCallDecisionService#buildDigest} 调同一个
     * {@link CommandDigest}，测试不重写一份算法（重写就会在算法演进时静默假绿）。
     */
    private String buildDigest(ToolCallDecisionCommand command) {
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

    private ToolCall commandCall(String id) {
        String content = "{\"kind\":\"COMMAND\",\"command\":\"echo hi\",\"workDir\":\"/project\","
                + "\"shell\":\"BASH\",\"workspaceId\":\"workspace\",\"args\":\"{\\\"command\\\":\\\"echo hi\\\"}\"}";
        return ToolCall.builder().id(id).conversationId(CONVERSATION_ID).executionId(EXECUTION_ID).toolName("command")
                .type(ToolCallType.PROMISE).status(ToolCallStatus.PENDING)
                .title("命令审批").content(content).rawInput("{\"args\":{\"command\":\"echo hi\"}}")
                .createdAt(Instant.now()).updatedAt(Instant.now()).build();
    }

    private Workspace workspace() {
        Workspace workspace = mock(Workspace.class);
        RuntimeEnvironment environment = mock(RuntimeEnvironment.class);
        when(workspace.id()).thenReturn("workspace");
        when(workspace.workDir()).thenReturn("/project");
        when(workspace.runtimeEnvironment()).thenReturn(environment);
        when(environment.shellType()).thenReturn(ShellType.BASH);
        return workspace;
    }

    private ToolDefinition<CommandToolDefinitionExecutor> commandTool() {
        return ToolDefinition.<CommandToolDefinitionExecutor>builder()
                .id("command").name("command").maxOutput(1000).timeout(30L)
                .executor(commandExecutor).build();
    }

    private Execution execution(ExecutionState state, ToolMessageEntity... messages) {
        List<Message> context = new ArrayList<>(List.of(messages));
        List<ToolCallRequest> requests = new ArrayList<>();
        for (ToolMessageEntity tool : messages) {
            requests.add(ToolCallRequest.builder().id(String.valueOf(tool.getId())).name(tool.getName())
                    .requestIndex(requests.size()).arguments("{}").build());
        }
        if (!requests.isEmpty()) context.addFirst(AiMessageEntity.builder().toolCalls(requests).build());
        return Execution.builder().id(EXECUTION_ID_TEXT).lastResponseId("9007199254740993").executionState(state)
                .agentRequest(AgentRequest.builder()
                        .workspaceSpec(mock(WorkspaceSpec.class))
                        .runtimeParameters(AgentRuntimeParameters.builder()
                                .attributes(Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(CONVERSATION_ID)))
                                .build())
                        .build())
                .messages(context).build();
    }

    @SuppressWarnings("unchecked")
    private static <T> ObjectProvider<T> provider(T value) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(value);
        return provider;
    }
}
