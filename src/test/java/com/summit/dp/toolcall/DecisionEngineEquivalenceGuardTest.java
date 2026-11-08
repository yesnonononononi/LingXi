package com.summit.dp.toolcall;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import com.summit.dp.execution.infrastructure.repository.ExecutionResumeTaskRepositoryImpl;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionResumeTaskMapper;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionContextMapper;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMessageMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionMessagePO;
import com.summit.dp.session.infrastructure.persistence.repository.SessionContextRepositoryImpl;
import com.summit.dp.session.infrastructure.persistence.repository.SessionMessageRepositoryImpl;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.utils.CommandDigest;
import com.summit.dp.toolcall.api.dto.ChoiceAnswersCommand;
import com.summit.dp.toolcall.api.dto.ChoiceAnswersReceipt;
import com.summit.dp.toolcall.api.dto.ToolCallDecisionCommand;
import com.summit.dp.toolcall.api.dto.ToolCallDecisionReceipt;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.application.vo.DecisionConflictException;
import com.summit.dp.toolcall.application.vo.DecisionErrorCode;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallAction;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.infrastructure.persistence.mapper.ToolCallMapper;
import com.summit.dp.toolcall.infrastructure.persistence.repository.ToolCallRepositoryImpl;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.application.decision.ChoiceAnswersService;
import com.summit.dp.workflow.application.decision.ChoiceAnswersValidator;
import com.summit.dp.workflow.application.decision.CommandApprovalExecutor;
import com.summit.dp.workflow.application.decision.ToolCallDecisionService;
import com.summit.dp.workflow.application.decision.ToolCallWorkflowService;
import com.summit.dp.workflow.application.decision.VersionedToolCallDecisionService;
import com.summit.dp.workflow.application.decision.ImmediateSlotResolutionStrategy;
import com.summit.dp.workflow.application.decision.InteractionDecisionEngine;
import com.summit.dp.workflow.application.decision.ReactiveDecisionContract;
import com.summit.dp.workflow.application.decision.TwoPhaseCommandResolutionStrategy;
import com.summit.dp.workflow.application.decision.VersionedDecisionContract;
import com.summit.dp.workflow.application.input.InputAutomationPolicy;
import com.summit.dp.workflow.application.lifecycle.GateCheckResult;
import com.summit.dp.workflow.application.lifecycle.ResumeTriggerType;
import com.summit.dp.workflow.application.lifecycle.StartupFailureCloser;
import com.summit.dp.workflow.application.lifecycle.SubAgentWaitSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.SubExecutionDependency;
import com.summit.dp.workflow.application.lifecycle.SuspensionGateChain;
import com.summit.dp.workflow.application.lifecycle.UnresolvedToolSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.UserPauseSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.ExecutionResumeCoordinator;
import com.summit.dp.workflow.application.lifecycle.SuspendedExecutionResumer;
import com.summit.dp.workflow.infrastructure.harness.SessionAttributeRestorer;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

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

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;

/**
 * 统一决策引擎的等价守卫：<b>真实 H2 + 真实 Mapper + 真实专用入口</b>。
 *
 * <p>这里的断言全部落在库里的字面量上（状态、结论、摘要、槽位文本、恢复请求行），
 * 不拿被测常量自证：任何一条在缺陷时都会变红。</p>
 */
class DecisionEngineEquivalenceGuardTest {

    private static final long CONVERSATION_V1 = 9001L;
    private static final long CONVERSATION_V2 = 9002L;
    private static final long EXECUTION_V1 = 9101L;
    private static final long EXECUTION_V2 = 9102L;

    private H2TestDatabase database;
    private SqlSessionTemplate session;
    private ObjectMapper mapper;
    private ToolCallRepositoryImpl tools;
    private LocalExecutionRepository executions;
    private ModelContextService contexts;
    private TransactionTemplate transactions;
    private ToolCallConverter converter;
    private InteractionDecisionEngine engine;
    private ToolCallWorkflowService workflowService;
    private VersionedToolCallDecisionService versionedService;
    private ChoiceAnswersService choiceService;
    private SessionMessageMapper messageMapper;
    private final List<ExecutionResumeCoordinator> coordinators = new ArrayList<>();
    private ExecutionControl executionControl;
    private SuspendedExecutionResumer resumer;
    private RecordingSseEventPublisher sseEventPublisher;
    private ExecutionResumeCoordinator coordinator;
    private ExecutionActivity activity;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("DecisionEngineEquivalenceGuardTest");
        mapper = new ObjectMapper().findAndRegisterModules();
        session = H2TestDatabase.sqlSession(database.sessionFactory(ExecutionMapper.class, ToolCallMapper.class,
                SessionContextMapper.class, SessionMessageMapper.class, SessionMapper.class,
                ExecutionResumeTaskMapper.class));
        messageMapper = session.getMapper(SessionMessageMapper.class);
        transactions = new TransactionTemplate(new DataSourceTransactionManager(database));

        tools = new ToolCallRepositoryImpl(session.getMapper(ToolCallMapper.class), mapper,
                mock(CardAvailabilityPolicy.class));
        executions = com.summit.dp.execution.ExecutionRepositoryTestFactory
                .create(session.getMapper(ExecutionMapper.class), mapper);
        contexts = new ModelContextService(mapper,
                new SessionContextRepositoryImpl(session.getMapper(SessionContextMapper.class)));
        activity = mock(ExecutionActivity.class);
        resumer = new SuspendedExecutionResumer(new SessionAttributeRestorer(mock(SessionRepository.class)),
                contexts, provider(executionControl));
        sseEventPublisher = new RecordingSseEventPublisher();
        executionControl = mock(ExecutionControl.class);
        doAnswer(invocation -> {
            ((Execution) invocation.getArgument(0)).resumeChecked();
            return null;
        }).when(executionControl).beginApproval(any(Execution.class));
        when(executionControl.resume(any(Execution.class))).thenAnswer(invocation -> invocation.getArgument(0));

        coordinator = coordinator();
        converter = new ToolCallConverter(mapper);
        ImmediateSlotResolutionStrategy immediate = new ImmediateSlotResolutionStrategy(converter,
                new ChoiceAnswersValidator(mapper, new SessionMessageRepositoryImpl(
                        messageMapper, session.getMapper(SessionMapper.class))), tools);
        TwoPhaseCommandResolutionStrategy commandStrategy = new TwoPhaseCommandResolutionStrategy(
                mock(CommandApprovalExecutor.class), tools, converter);
        engine = new InteractionDecisionEngine(tools, converter, provider(executions), contexts, transactions,
                coordinator, new UnresolvedToolSuspensionGate(tools), immediate, commandStrategy);
        ReactiveDecisionContract reactive = new ReactiveDecisionContract(
                new CardAvailabilityPolicy(new com.summit.dp.workflow.infrastructure.harness.HarnessExecutionGate(
                        provider(executions), provider(activity))));
        workflowService = new ToolCallWorkflowService(tools, converter, engine,
                new ToolCallDecisionService(locator(), sseEventPublisher, engine, reactive),
                reactive, sseEventPublisher, locator());
        versionedService = new VersionedToolCallDecisionService(tools, converter, engine,
                new VersionedDecisionContract(converter));
        choiceService = new ChoiceAnswersService(
                new ChoiceAnswersValidator(mapper, new SessionMessageRepositoryImpl(
                        messageMapper, session.getMapper(SessionMapper.class))),
                engine, new VersionedDecisionContract(converter));
        stagePlanCard(CONVERSATION_V1, EXECUTION_V1, "call-v1");
        stagePlanCard(CONVERSATION_V2, EXECUTION_V2, "call-v2");
    }

    @AfterEach
    void close() {
        coordinators.forEach(ExecutionResumeCoordinator::close);
        if (sseEventPublisher != null) {
            sseEventPublisher.close();
        }
        coordinators.clear();
        database.shutdown();
    }

    // ------------------------------------------------------------------
    // a) v1 与 v2 对同一张卡的等价性
    // ------------------------------------------------------------------

    @Test
    @DisplayName("a) 同一决策经 v1 与 v2 落库：状态/结论/摘要/槽位/恢复处置逐字段一致")
    void v1AndV2PersistTheSameDecision() {
        workflowService.decide(CONVERSATION_V1, "call-v1", true, "可以");
        versionedService.decide(new ToolCallDecisionCommand(CONVERSATION_V2, "call-v2", "cmd-v2", 1L,
                ToolCallAction.APPROVE, "可以"));

        ToolCall fromV1 = tools.findById("call-v1").orElseThrow();
        ToolCall fromV2 = tools.findById("call-v2").orElseThrow();

        // 状态与结论：写死字面量，两条入口必须一致。
        assertEquals(ToolCallStatus.COMPLETED, fromV1.getStatus());
        assertEquals(ToolCallStatus.COMPLETED, fromV2.getStatus());
        assertTrue(fromV1.getRawOutput().contains("\"APPROVED\""), fromV1.getRawOutput());
        assertTrue(fromV2.getRawOutput().contains("\"APPROVED\""), fromV2.getRawOutput());
        assertEquals(CommandDigest.build("call-v1", CONVERSATION_V1, 1L, "APPROVE", "可以"),
                fromV1.getDecisionDigest(), "v1 摘要必须含观察到的版本");
        assertEquals(CommandDigest.build("call-v2", CONVERSATION_V2, 1L, "APPROVE", "可以"),
                fromV2.getDecisionDigest(), "v2 摘要必须含客户端期望版本");
        assertEquals(fromV1.getDecisionDigest().length(), fromV2.getDecisionDigest().length(),
                "两条入口的摘要算法必须同源（同长度）");

        // 槽位输出：恢复后模型看到同一句话。
        assertEquals("可以", slotOf(EXECUTION_V1, "call-v1").getToolOutput());
        assertEquals("可以", slotOf(EXECUTION_V2, "call-v2").getToolOutput());

        // 上下文：两边都写入了同一条工具消息文本。
        assertEquals("可以", contextSlot(CONVERSATION_V1, "call-v1").getToolOutput());
        assertEquals("可以", contextSlot(CONVERSATION_V2, "call-v2").getToolOutput());

        // 恢复路径：两条入口都走 Phase3 持久化队列，来源一致。
        assertEquals(1L, resumeRows(EXECUTION_V1, "APPROVAL_DECISION"),
                "v1 的恢复意图必须带 APPROVAL_DECISION 来源落库");
        assertEquals(1L, resumeRows(EXECUTION_V2, "APPROVAL_DECISION"),
                "v2 的恢复意图必须带 APPROVAL_DECISION 来源落库");
        awaitStreamsClosed();
    }

    // ------------------------------------------------------------------
    // b) 普通同意 / 拒绝 / 计划确认 / 多选问答四条路径的真实落库
    // ------------------------------------------------------------------

    @Test
    @DisplayName("b) 普通同意：槽位=用户文本、状态 COMPLETED、结论 APPROVED、恢复来源 APPROVAL_DECISION")
    void plainApprovePersists() {
        workflowService.decide(CONVERSATION_V1, "call-v1", true, "同意执行");

        ToolCall card = tools.findById("call-v1").orElseThrow();
        assertEquals(ToolCallStatus.COMPLETED, card.getStatus());
        assertTrue(card.getRawOutput().contains("\"APPROVED\""));
        assertEquals("同意执行", slotOf(EXECUTION_V1, "call-v1").getToolOutput());
        assertEquals("同意执行", contextSlot(CONVERSATION_V1, "call-v1").getToolOutput());
        assertEquals(1L, resumeRows(EXECUTION_V1, "APPROVAL_DECISION"));
        awaitStreamsClosed();
        assertEquals(1, sseEventPublisher.finishedCount(), "恢复落定后流必须恰好关一次");
    }

    @Test
    @DisplayName("b) 普通拒绝：槽位=拒绝文案、结论 REJECTED、执行仍断裂但恢复意图登记")
    void plainRejectPersists() {
        workflowService.decide(CONVERSATION_V1, "call-v1", false, null);

        ToolCall card = tools.findById("call-v1").orElseThrow();
        assertEquals(ToolCallStatus.COMPLETED, card.getStatus());
        assertTrue(card.getRawOutput().contains("\"REJECTED\""));
        assertEquals("用户已拒绝该互动", slotOf(EXECUTION_V1, "call-v1").getToolOutput());
        assertEquals(1L, resumeRows(EXECUTION_V1, "APPROVAL_DECISION"));
        awaitStreamsClosed();
        assertEquals(1, sseEventPublisher.finishedCount(), "恢复落定后流必须恰好关一次");
    }

    @Test
    @DisplayName("b) 计划确认：v2 ANSWER 之外的 APPROVE 落 APPROVED，且卡片版本推进到 2")
    void planConfirmPersists() {
        versionedService.decide(new ToolCallDecisionCommand(CONVERSATION_V2, "call-v2", "cmd-plan", 1L,
                ToolCallAction.APPROVE, "按计划做"));

        ToolCall card = tools.findById("call-v2").orElseThrow();
        assertEquals(ToolCallStatus.COMPLETED, card.getStatus());
        assertTrue(card.getRawOutput().contains("\"APPROVED\""));
        assertEquals(2L, card.getVersion(), "乐观锁推进一次即 2");
        assertEquals("按计划做", slotOf(EXECUTION_V2, "call-v2").getToolOutput());
    }

    @Test
    @DisplayName("b) 多选问答：三张 CHOICE 一次提交，全部 COMPLETED 且各自槽位为原文")
    void choiceBatchPersists() throws Exception {
        List<ToolCallRequest> requests = List.of(
                new ToolCallRequest("choice-0", ToolCatalog.REQUIRE_CHOICE, 0, "{}"),
                new ToolCallRequest("choice-1", ToolCatalog.REQUIRE_CHOICE, 1, "{}"),
                new ToolCallRequest("choice-2", ToolCatalog.REQUIRE_CHOICE, 2, "{}"));
        AiMessageEntity ai = AiMessageEntity.builder().toolCalls(requests).text("").build();
        stageChoiceGroup(9201L, 9301L, "resp-1", "batch-1", ai, requests);

        ChoiceAnswersReceipt receipt = choiceService.submit(new ChoiceAnswersCommand(9201L, "resp-1", "batch-1",
                List.of(new ChoiceAnswersCommand.Answer("choice-0", 1L, "答案甲"),
                        new ChoiceAnswersCommand.Answer("choice-1", 1L, "答案乙"),
                        new ChoiceAnswersCommand.Answer("choice-2", 1L, "答案丙"))));

        assertEquals(3, receipt.toolCalls().size());
        for (int index = 0; index < 3; index++) {
            assertEquals(ToolCallStatus.COMPLETED, tools.findById("choice-" + index).orElseThrow().getStatus());
        }
        assertEquals("答案甲", slotOf(9301L, "choice-0").getToolOutput());
        assertEquals("答案乙", slotOf(9301L, "choice-1").getToolOutput());
        assertEquals("答案丙", slotOf(9301L, "choice-2").getToolOutput());
        assertEquals(1L, resumeRows(9301L, "APPROVAL_DECISION"));
    }

    // ------------------------------------------------------------------
    // c) 幂等三态
    // ------------------------------------------------------------------

    @Test
    @DisplayName("c) 同 commandId 同内容重试：回放首次结论，不重复写库也不重复登记恢复")
    void sameCommandSameContentReplays() {
        ToolCallDecisionCommand command = new ToolCallDecisionCommand(CONVERSATION_V2, "call-v2", "cmd-retry",
                1L, ToolCallAction.APPROVE, "可以");
        ToolCallDecisionReceipt first = versionedService.decide(command);
        ToolCallDecisionReceipt second = versionedService.decide(command);

        assertTrue(first.decisionApplied());
        assertTrue(second.decisionApplied());
        assertEquals("APPROVED", second.decision(), "重试必须回放首次结论");
        assertEquals(2L, tools.findById("call-v2").orElseThrow().getVersion(), "重试不得再写一次");
        assertEquals(1L, resumeRows(EXECUTION_V2, "APPROVAL_DECISION"), "重试不得重复登记恢复");
    }

    @Test
    @DisplayName("c) 同 commandId 不同内容：COMMAND_CONFLICT，库中结论不被改写")
    void sameCommandDifferentContentConflicts() {
        versionedService.decide(new ToolCallDecisionCommand(CONVERSATION_V2, "call-v2", "cmd-x", 1L,
                ToolCallAction.APPROVE, "可以"));

        DecisionConflictException failure = assertThrows(DecisionConflictException.class,
                () -> versionedService.decide(new ToolCallDecisionCommand(CONVERSATION_V2, "call-v2", "cmd-x",
                        1L, ToolCallAction.REJECT, "改主意了")));

        assertEquals(DecisionErrorCode.COMMAND_CONFLICT, failure.errorCode());
        assertTrue(tools.findById("call-v2").orElseThrow().getRawOutput().contains("\"APPROVED\""));
        assertEquals("可以", slotOf(EXECUTION_V2, "call-v2").getToolOutput());
    }

    @Test
    @DisplayName("c) 他人 commandId 争抢已决互动：DECISION_ALREADY_APPLIED 且不覆盖权威结论")
    void otherCommandCannotOverwrite() {
        versionedService.decide(new ToolCallDecisionCommand(CONVERSATION_V2, "call-v2", "cmd-first", 1L,
                ToolCallAction.APPROVE, "可以"));

        DecisionConflictException failure = assertThrows(DecisionConflictException.class,
                () -> versionedService.decide(new ToolCallDecisionCommand(CONVERSATION_V2, "call-v2", "cmd-second",
                        2L, ToolCallAction.REJECT, "另一路")));

        assertEquals(DecisionErrorCode.DECISION_ALREADY_APPLIED, failure.errorCode());
        ToolCall authoritative = tools.findById("call-v2").orElseThrow();
        assertEquals("cmd-first", authoritative.getDecisionCommandId());
        assertTrue(authoritative.getRawOutput().contains("\"APPROVED\""));
        assertEquals(2L, authoritative.getVersion());
        assertEquals(1L, resumeRows(EXECUTION_V2, "APPROVAL_DECISION"));
    }

    // ------------------------------------------------------------------
    // d) 真乐观锁
    // ------------------------------------------------------------------

    @Test
    @DisplayName("d) 两个独立读到同一版本的调用方并发写：只有一个落库，失效版本绝不覆盖权威结果")
    void staleVersionCannotOverwrite() throws Exception {
        ToolCall first = tools.findById("call-v1").orElseThrow();
        ToolCall second = tools.findById("call-v1").orElseThrow();
        assertEquals(1L, first.getVersion());
        assertEquals(1L, second.getVersion());

        CyclicBarrier gate = new CyclicBarrier(2);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            Callable<Boolean> winA = () -> {
                gate.await(10, TimeUnit.SECONDS);
                return writeConclusion(first, "{\"outcome\":\"APPROVED\"}");
            };
            Callable<Boolean> winB = () -> {
                gate.await(10, TimeUnit.SECONDS);
                return writeConclusion(second, "{\"outcome\":\"REJECTED\"}");
            };
            Future<Boolean> a = workers.submit(winA);
            Future<Boolean> b = workers.submit(winB);
            int succeeded = (a.get(15, TimeUnit.SECONDS) ? 1 : 0) + (b.get(15, TimeUnit.SECONDS) ? 1 : 0);
            assertEquals(1, succeeded, "同一版本的两次更新只能有一方成功");
        } finally {
            workers.shutdownNow();
        }

        ToolCall stored = tools.findById("call-v1").orElseThrow();
        assertEquals(2L, stored.getVersion(), "库里只能推进一次");
        assertEquals(ToolCallStatus.COMPLETED, stored.getStatus());
        boolean approved = stored.getRawOutput().contains("\"APPROVED\"");
        boolean rejected = stored.getRawOutput().contains("\"REJECTED\"");
        assertTrue(approved ^ rejected, "结论必须唯一：" + stored.getRawOutput());
    }

    @Test
    @DisplayName("d) 同一张卡两个 commandId 并发决策：一方成功，另一方被拒，库里结论唯一")
    void concurrentDecisionsKeepSingleConclusion() throws Exception {
        CyclicBarrier gate = new CyclicBarrier(2);
        ExecutorService workers = Executors.newFixedThreadPool(2);
        int succeeded = 0;
        try {
            Callable<Boolean> approve = () -> {
                gate.await(10, TimeUnit.SECONDS);
                return decideQuietly(new ToolCallDecisionCommand(CONVERSATION_V2, "call-v2", "cmd-a", 1L,
                        ToolCallAction.APPROVE, "可以"));
            };
            Callable<Boolean> reject = () -> {
                gate.await(10, TimeUnit.SECONDS);
                return decideQuietly(new ToolCallDecisionCommand(CONVERSATION_V2, "call-v2", "cmd-b", 1L,
                        ToolCallAction.REJECT, null));
            };
            Future<Boolean> first = workers.submit(approve);
            Future<Boolean> second = workers.submit(reject);
            succeeded = (first.get(15, TimeUnit.SECONDS) ? 1 : 0) + (second.get(15, TimeUnit.SECONDS) ? 1 : 0);
        } finally {
            workers.shutdownNow();
        }
        assertEquals(1, succeeded, "并发决策只能有一方实质成功");

        ToolCall stored = tools.findById("call-v2").orElseThrow();
        assertEquals(2L, stored.getVersion(), "权威版本只能推进一次");
        assertEquals(ToolCallStatus.COMPLETED, stored.getStatus());
        // 胜者不定，但槽位必须与库里的权威结论一致（否则恢复后模型读到的是败者的意图）。
        String expectedSlot = stored.getRawOutput().contains("\"APPROVED\"") ? "可以" : "用户已拒绝该互动";
        assertEquals(expectedSlot, slotOf(EXECUTION_V2, "call-v2").getToolOutput(),
                "槽位必须是胜者的结论，实际库里结论: " + stored.getRawOutput());
        assertEquals(1L, resumeRows(EXECUTION_V2, "APPROVAL_DECISION"), "恢复只能登记一次");
    }

    // ------------------------------------------------------------------
    // e) 多选批量全成全败
    // ------------------------------------------------------------------

    @Test
    @DisplayName("e) 少交一条：整体失败，库里没有任何半成品（卡片仍 PENDING、无恢复请求）")
    void incompleteBatchLeavesNothing() throws Exception {
        List<ToolCallRequest> requests = List.of(
                new ToolCallRequest("choice-0", ToolCatalog.REQUIRE_CHOICE, 0, "{}"),
                new ToolCallRequest("choice-1", ToolCatalog.REQUIRE_CHOICE, 1, "{}"),
                new ToolCallRequest("choice-2", ToolCatalog.REQUIRE_CHOICE, 2, "{}"));
        AiMessageEntity ai = AiMessageEntity.builder().toolCalls(requests).text("").build();
        stageChoiceGroup(9202L, 9302L, "resp-2", "batch-2", ai, requests);

        assertThrows(com.summit.dp.shared.exception.ClientException.class,
                () -> choiceService.submit(new ChoiceAnswersCommand(9202L, "resp-2", "batch-2",
                        List.of(new ChoiceAnswersCommand.Answer("choice-0", 1L, "甲"),
                                new ChoiceAnswersCommand.Answer("choice-1", 1L, "乙")))));

        for (int index = 0; index < 3; index++) {
            ToolCall card = tools.findById("choice-" + index).orElseThrow();
            assertEquals(ToolCallStatus.PENDING, card.getStatus(), "缺题必须整体回滚: choice-" + index);
            assertEquals(1L, card.getVersion());
        }
        assertEquals(0L, resumeRows(9302L, "APPROVAL_DECISION"));
    }

    @Test
    @DisplayName("e) 分组不符（不属于同一响应组）：明确拒绝，库里无任何写入")
    void foreignCardInBatchIsRejected() throws Exception {
        List<ToolCallRequest> requests = List.of(
                new ToolCallRequest("choice-0", ToolCatalog.REQUIRE_CHOICE, 0, "{}"),
                new ToolCallRequest("choice-1", ToolCatalog.REQUIRE_CHOICE, 1, "{}"));
        AiMessageEntity ai = AiMessageEntity.builder().toolCalls(requests).text("").build();
        stageChoiceGroup(9203L, 9303L, "resp-3", "batch-3", ai, requests);

        assertThrows(RuntimeException.class, () -> choiceService.submit(new ChoiceAnswersCommand(9203L,
                "resp-3", "batch-3",
                List.of(new ChoiceAnswersCommand.Answer("choice-0", 1L, "甲"),
                        new ChoiceAnswersCommand.Answer("call-v1", 1L, "乙")))));

        assertEquals(ToolCallStatus.PENDING, tools.findById("choice-0").orElseThrow().getStatus());
        assertEquals(0L, resumeRows(9303L, "APPROVAL_DECISION"));
    }

    // ------------------------------------------------------------------
    // f) 用户暂停语义：人工决策不被自动轮次上限拦截
    // ------------------------------------------------------------------

    @Test
    @DisplayName("f) AUTO_ROUNDS 达上限时：自动唤醒被拦，人工决策(APPROVAL_DECISION)放行且暂停意图不被清")
    void humanDecisionBypassesAutoRoundLimit() {
        Execution execution = executions.findById(String.valueOf(EXECUTION_V1)).orElseThrow();
        transactions.executeWithoutResult(status -> {
            InputAutomationPolicy.putAttribute(execution, InputAutomationPolicy.AUTO_ROUNDS,
                    InputAutomationPolicy.MAX_AUTO_ROUNDS);
            InputAutomationPolicy.putAttribute(execution, InputAutomationPolicy.USER_PAUSED, Boolean.TRUE);
            executions.save(execution);
        });

        UserPauseSuspensionGate gate = new UserPauseSuspensionGate();
        Execution paused = executions.findById(String.valueOf(EXECUTION_V1)).orElseThrow();
        GateCheckResult autoWakeup = gate.checkResumeReadiness(paused, ResumeTriggerType.AUTO_INPUT_WAKEUP);
        assertFalse(autoWakeup.allowed(), "用户的暂停必须拦住自动唤醒");

        // 人工决策不清理用户的暂停意图，也不清零轮次计数。
        gate.clearSuspensionState(paused, ResumeTriggerType.APPROVAL_DECISION);
        assertEquals(Boolean.TRUE, InputAutomationPolicy.attributes(paused).get(InputAutomationPolicy.USER_PAUSED),
                "机器唤醒不能替人取消暂停");
        assertEquals(InputAutomationPolicy.MAX_AUTO_ROUNDS,
                InputAutomationPolicy.attributes(paused).get(InputAutomationPolicy.AUTO_ROUNDS));

        // 单独一份只带轮次上限的副本：证明上限只拦自动唤醒，不拦人工决策。
        Execution roundsOnly = executions.findById(String.valueOf(EXECUTION_V1)).orElseThrow();
        InputAutomationPolicy.putAttribute(roundsOnly, InputAutomationPolicy.USER_PAUSED, null);
        assertTrue(gate.checkResumeReadiness(roundsOnly, ResumeTriggerType.APPROVAL_DECISION).allowed(),
                "自动轮次上限不得拦住人工决策");
        assertFalse(gate.checkResumeReadiness(roundsOnly, ResumeTriggerType.AUTO_INPUT_WAKEUP).allowed(),
                "连续自动接续达上限后必须拦住自动唤醒");
    }

    // ------------------------------------------------------------------
    // g) v1 恢复失败/被拒/暂缓：流都必须关闭，控制槽位不泄漏
    // ------------------------------------------------------------------

    @Test
    @DisplayName("g) v1 恢复启动失败：执行按失败链收口为 FAILED，流关闭，请求行留 FAILED")
    void v1StartupFailureClosesStream() {
        when(executionControl.resume(any(Execution.class)))
                .thenThrow(new IllegalStateException("模拟恢复启动失败"));

        workflowService.decide(CONVERSATION_V1, "call-v1", true, "可以");

        awaitStreamsClosed();
        assertEquals(1, sseEventPublisher.finishedCount(), "启动失败也必须关流，不能悬挂");
        assertEquals(1L, resumeRows(EXECUTION_V1, "APPROVAL_DECISION"), "来源仍必须持久化");
        assertEquals("FAILED", resumeState(EXECUTION_V1), "启动失败必须收口为 FAILED");
        // 控制槽位没泄漏：同一卡片再提交不会抛「执行仍在运行」，只会按已决处理。
        SseEmitter second = workflowService.decide(CONVERSATION_V1, "call-v1", true, "可以");
        assertNotNull(second);
    }

    @Test
    @DisplayName("g) v1 派发被拒（执行器已关闭）：流关闭，请求行仍留痕")
    void v1DispatchRejectedClosesStream() {
        coordinator.close();

        workflowService.decide(CONVERSATION_V1, "call-v1", true, "可以");

        awaitStreamsClosed();
        assertEquals(1, sseEventPublisher.finishedCount(), "派发被拒也必须关流");
        assertEquals(1L, resumeRows(EXECUTION_V1, "APPROVAL_DECISION"));
    }

    @Test
    @DisplayName("g) v1 门禁暂缓（用户暂停）：流关闭，请求行留 DEFERRED；解除暂停后可重新排回 READY")
    void v1DeferredKeepsRequestAndRequiresAgain() {
        Execution paused = executions.findById(String.valueOf(EXECUTION_V1)).orElseThrow();
        transactions.executeWithoutResult(status -> {
            InputAutomationPolicy.putAttribute(paused, InputAutomationPolicy.USER_PAUSED, Boolean.TRUE);
            executions.save(paused);
        });

        workflowService.decide(CONVERSATION_V1, "call-v1", true, "可以");

        awaitStreamsClosed();
        assertEquals(1, sseEventPublisher.finishedCount(), "门禁暂缓也必须关流，否则前端挂到天荒地老");
        assertEquals("DEFERRED", resumeState(EXECUTION_V1), "暂缓不是失败、也不是作废");

        // 解除暂停后再次受理：同代际的请求必须重新排回 READY（不是新建第二条）。
        Execution resumed = executions.findById(String.valueOf(EXECUTION_V1)).orElseThrow();
        transactions.executeWithoutResult(status -> {
            InputAutomationPolicy.putAttribute(resumed, InputAutomationPolicy.USER_PAUSED, null);
            executions.save(resumed);
        });
        coordinator.accept(EXECUTION_V1, ResumeTriggerType.APPROVAL_DECISION);
        awaitResumeState(EXECUTION_V1, "READY");
        assertEquals(1L, resumeRows(EXECUTION_V1, "APPROVAL_DECISION"), "同代际只允许一条请求");
    }

    @Test
    @DisplayName("g) 落定回调恰好一次：连续两次落定只关一次流")
    void settledCallbackRunsExactlyOnce() {
        java.util.concurrent.atomic.AtomicInteger settled = new java.util.concurrent.atomic.AtomicInteger();
        coordinator.close();
        coordinator.accept(EXECUTION_V1, ResumeTriggerType.APPROVAL_DECISION, settled::incrementAndGet);
        assertEquals(1, settled.get(), "派发被拒也必须落定");

        // 再次触发派发（执行器已关闭）：落定已消费过，不得重复回调。
        coordinator.dispatch(EXECUTION_V1);
        assertEquals(1, settled.get(), "同一 execution 的落定回调只能执行一次");
    }

    // ------------------------------------------------------------------
    // 装配与断言辅助
    // ------------------------------------------------------------------

    /** 建一个真的恢复协调器：恢复请求行必须真的落进 execution_resume_task。 */
    private ExecutionResumeCoordinator coordinator() {
        ExecutionRepositoryImpl resumeExecutions =
                new ExecutionRepositoryImpl(session.getMapper(ExecutionMapper.class));
        SuspendedExecutionResumer resumer = new SuspendedExecutionResumer(
                new SessionAttributeRestorer(mock(SessionRepository.class)), contexts, provider(executionControl));
        ExecutionResumeCoordinator coordinator = new ExecutionResumeCoordinator(
                new ExecutionResumeTaskRepositoryImpl(session.getMapper(ExecutionResumeTaskMapper.class)),
                resumeExecutions, resumer, executionControl,
                new SuspensionGateChain(List.of(new UserPauseSuspensionGate(),
                        new UnresolvedToolSuspensionGate(tools),
                        new SubAgentWaitSuspensionGate(new SubExecutionDependency(new SessionExecutionRegistry(),
                                mock(SessionRepository.class), resumeExecutions)))),
                new UnresolvedToolSuspensionGate(tools), provider(executions), provider(activity),
                new StartupFailureCloser(executionControl));
        coordinators.add(coordinator);
        return coordinator;
    }

    /** 挂起执行 + 一张待决计划卡：v1 与 v2 用同一份形状，才谈得上等价。 */
    private void stagePlanCard(long conversationId, long executionId, String toolCallId) {
        ToolMessageEntity slot = ToolMessageEntity.builder().id(toolCallId).name("create_plan")
                .toolOutput("pending").build();
        suspendExecution(conversationId, executionId, slot);
        tools.save(ToolCall.builder().id(toolCallId).conversationId(conversationId).executionId(executionId)
                .toolName("create_plan").type(ToolCallType.PROMISE).status(ToolCallStatus.PENDING)
                .title("计划").content("{\"kind\":\"PLAN\",\"title\":\"T\",\"text\":\"body\"}")
                .rawInput("{\"args\":{}}").build());
    }

    /** 挂起执行 + 一整组待答选择卡，并把原模型响应写进 session_message。 */
    private void stageChoiceGroup(long conversationId, long executionId, String responseId, String commandId,
                                  AiMessageEntity ai, List<ToolCallRequest> requests) throws Exception {
        List<Message> messages = new ArrayList<>();
        messages.add(ai);
        for (ToolCallRequest request : requests) {
            messages.add(ToolMessageEntity.builder().id(request.id()).name(ToolCatalog.REQUIRE_CHOICE)
                    .toolOutput("Waiting for the user.").build());
        }
        suspendExecution(conversationId, executionId, messages.toArray(new Message[0]));
        SessionMessagePO row = new SessionMessagePO();
        row.setId(conversationId * 10L + 1L);
        row.setSessionId(conversationId);
        row.setResponseId(responseId);
        row.setType("AI");
        row.setContent(mapper.writeValueAsString(ai));
        messageMapper.insert(row);
        for (ToolCallRequest request : requests) {
            tools.save(ToolCall.builder().id(request.id()).conversationId(conversationId).executionId(executionId)
                    .toolName(ToolCatalog.REQUIRE_CHOICE).type(ToolCallType.PROMISE).status(ToolCallStatus.PENDING)
                    .title("问题 " + request.requestIndex())
                    .content("{\"kind\":\"CHOICE\",\"question\":\"问题\",\"options\":[\"A\",\"B\"]}").build());
        }
    }

    /** 建一个真实挂起态执行（生成恢复代际），检查点与上下文都落库。 */
    private void suspendExecution(long conversationId, long executionId, Message... extra) {
        List<Message> messages = new ArrayList<>(List.of(extra));
        AgentRequest request = AgentRequest.builder()
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(conversationId))).build())
                .build();
        Execution execution = Execution.builder().id(String.valueOf(executionId)).agentId("chatAgent")
                .agentRequest(request).executionState(ExecutionState.CREATED).messages(messages).build();
        transactions.executeWithoutResult(status -> {
            executions.save(execution);
            execution.startChecked();
            execution.suspendChecked();
            executions.save(execution);
        });
        contexts.replace(conversationId, execution.getMessages());
    }

    /** 从库里读执行的槽位文本。 */
    private ToolMessageEntity slotOf(long executionId, String toolCallId) {
        Execution execution = executions.findById(String.valueOf(executionId)).orElseThrow();
        return execution.getMessages().stream()
                .filter(message -> message instanceof ToolMessageEntity)
                .map(message -> (ToolMessageEntity) message)
                .filter(message -> toolCallId.equals(String.valueOf(message.getId())))
                .findFirst().orElseThrow();
    }

    /** 从模型上下文里读槽位文本：上下文也是契约的一部分。 */
    private ToolMessageEntity contextSlot(long conversationId, String toolCallId) {
        return contexts.find(conversationId).orElseThrow().stream()
                .filter(message -> message instanceof ToolMessageEntity)
                .map(message -> (ToolMessageEntity) message)
                .filter(message -> toolCallId.equals(String.valueOf(message.getId())))
                .findFirst().orElseThrow();
    }

    /**
     * 等「恢复落定 → 关流」真的发生。
     *
     * <p>断言用真实发布器上的收尾次数：它不是被测类的成员标记，而是「生产环境那次关流真的被调用」的
     * 可观测事实。非 MVC 环境里 emitter 没有 handler，{@code connectedCount()} 不会因 complete 下降，
     * 因此用收尾计数作为等价的可观测断言。</p>
     */
    private void awaitStreamsClosed() {
        awaitFinishCount(1);
    }

    /** 等收尾调用达到期望次数。 */
    private void awaitFinishCount(int expected) {
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(15);
        while (System.nanoTime() < deadline) {
            if (sseEventPublisher.finishedCount() >= expected) {
                return;
            }
            try {
                Thread.sleep(20L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        fail("恢复落定后必须关流，实际关流次数: " + sseEventPublisher.finishedCount());
    }

    /** 真实发布器 + 可观测收尾计数：连接、推送仍走生产实现。 */
    static class RecordingSseEventPublisher extends com.summit.dp.workflow.infrastructure.stream.SseEventPublisher {

        private final java.util.concurrent.atomic.AtomicInteger finished = new java.util.concurrent.atomic.AtomicInteger();

        @Override
        public void finish(org.springframework.web.servlet.mvc.method.annotation.SseEmitter emitter) {
            finished.incrementAndGet();
            super.finish(emitter);
        }

        int finishedCount() {
            return finished.get();
        }
    }

    /** 恢复请求行的状态：用真实 SQL 读。 */
    private String resumeState(long executionId) {
        return database.queryString("select state from execution_resume_task where execution_id = "
                + executionId + " order by id desc limit 1");
    }

    /** 等恢复请求行到达期望状态（派发是异步的）。 */
    private void awaitResumeState(long executionId, String expected) {
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(15);
        while (System.nanoTime() < deadline) {
            if (expected.equals(resumeState(executionId))) {
                return;
            }
            try {
                Thread.sleep(20L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        fail("恢复请求行未到达期望状态 " + expected + "，实际: " + resumeState(executionId));
    }

    /** 恢复请求行计数：用真实 SQL 数，不信内存标记。 */
    private long resumeRows(long executionId, String triggerType) {
        return Long.parseLong(database.queryString(
                "select count(*) from execution_resume_task where execution_id = " + executionId
                        + " and trigger_type = '" + triggerType + "'"));
    }

    /** 单线程写一次结论：返回是否抢到版本。 */
    private boolean writeConclusion(ToolCall card, String rawOutput) {
        try {
            ToolCall fresh = tools.findById(card.getId()).orElseThrow();
            fresh.acceptPersistedVersion(card.getVersion());
            fresh.complete(rawOutput);
            tools.updateById(fresh);
            return true;
        } catch (RuntimeException conflict) {
            return false;
        }
    }

    /** 决策一次，冲突视为「没抢到」。 */
    private boolean decideQuietly(ToolCallDecisionCommand command) {
        try {
            versionedService.decide(command);
            return true;
        } catch (DecisionConflictException conflict) {
            return false;
        }
    }

    /** 会话定位：本用例的根会话就是会话本身，不引入无关仓储与真实会话行。 */
    private static com.summit.dp.execution.application.service.ExecutionLocator locator() {
        com.summit.dp.execution.application.service.ExecutionLocator locator =
                mock(com.summit.dp.execution.application.service.ExecutionLocator.class);
        when(locator.resolveRootSessionId(anyLong())).thenAnswer(invocation -> invocation.getArgument(0));
        return locator;
    }

    private static <T> ObjectProvider<T> provider(T value) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(value);
        return provider;
    }

    /** 只为满足 ObjectProvider 语义的空实现，避免用例自己造 provider 泛型。 */
    static <T> Optional<T> none() {
        return Optional.empty();
    }
}
