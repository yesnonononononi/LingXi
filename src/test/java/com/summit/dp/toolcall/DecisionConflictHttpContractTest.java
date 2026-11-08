package com.summit.dp.toolcall;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionRepositoryTestFactory;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionContextMapper;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.repository.SessionContextRepositoryImpl;
import com.summit.dp.shared.config.GlobalExceptionHandler;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.workflow.infrastructure.harness.SessionAttributeRestorer;
import com.summit.dp.toolcall.api.dto.ToolCallDecisionCommand;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.toolcall.application.vo.DecisionConflictException;
import com.summit.dp.toolcall.application.vo.DecisionErrorCode;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallAction;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.infrastructure.persistence.mapper.ToolCallMapper;
import com.summit.dp.toolcall.infrastructure.persistence.repository.ToolCallRepositoryImpl;
import com.summit.dp.workflow.api.controller.ToolCallController;


import com.summit.dp.workflow.application.decision.ChoiceAnswersService;
import com.summit.dp.workflow.application.decision.ChoiceAnswersValidator;
import com.summit.dp.workflow.application.decision.CommandApprovalExecutor;
import com.summit.dp.workflow.application.decision.ImmediateSlotResolutionStrategy;
import com.summit.dp.workflow.application.decision.InteractionDecisionEngine;
import com.summit.dp.workflow.application.decision.ToolCallWorkflowService;
import com.summit.dp.workflow.application.decision.TwoPhaseCommandResolutionStrategy;
import com.summit.dp.workflow.application.decision.VersionedDecisionContract;
import com.summit.dp.workflow.application.decision.VersionedToolCallDecisionService;
import com.summit.dp.workflow.application.lifecycle.CoordinatorResumeAcceptance;
import com.summit.dp.workflow.application.lifecycle.ExecutionResumeCoordinator;
import com.summit.dp.workflow.application.lifecycle.UnresolvedToolSuspensionGate;
import com.summit.dp.workflow.infrastructure.harness.LocalExecutionRepository;
import org.mybatis.spring.SqlSessionTemplate;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.http.MediaType;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/**
 * 决策冲突的 HTTP 口径守卫：<b>HTTP 200 + body.code = 4090~4095</b>，不是 HTTP 409。
 *
 * <p><b>为什么必须逐码断言并写死文案</b>：前端按 {@code isOk(res.code)} 判定并以 {@code errMsg}
 * 抛错（{@code frontend/src/services/toolCall.ts}）。一旦有人给处理器加上 {@code setStatus(409)}，
 * 前端拿不到 200 分支；一旦有人把码改成 0，前端无法区分「刷新后重试」「已决采纳」「停止轮询」。
 * 两者都是静默的行为破坏，只能靠字面量断言挡住。</p>
 *
 * <p>前五条逐码用例用真实 {@link ToolCallController} + 真实 {@link GlobalExceptionHandler}，
 * 只把决策服务替换成抛码桩；最后一条走<b>真实引擎 + 真实 H2</b>，用过期版本触发真正的
 * {@code STATE_CONFLICT}，证明这不是「处理器单测能过、真实链路却不同」。</p>
 */
class DecisionConflictHttpContractTest {

    private static final long CONVERSATION_ID = 9201L;
    private static final long EXECUTION_ID = 9202L;
    private static final String TOOL_CALL_ID = "call-conflict";

    private H2TestDatabase database;
    private SqlSessionTemplate session;
    private ObjectMapper mapper;
    private TransactionTemplate transactions;
    private ToolCallRepositoryImpl tools;
    private LocalExecutionRepository executions;
    private ModelContextService contexts;

    @BeforeEach
    void setup() {
        database = H2TestDatabase.create("DecisionConflictHttpContractTest");
        mapper = new ObjectMapper().findAndRegisterModules();
        session = H2TestDatabase.sqlSession(database.sessionFactory(ExecutionMapper.class, ToolCallMapper.class,
                SessionContextMapper.class, SessionMapper.class));
        transactions = new TransactionTemplate(new DataSourceTransactionManager(database));
        tools = new ToolCallRepositoryImpl(session.getMapper(ToolCallMapper.class), mapper,
                mock(CardAvailabilityPolicy.class));
        executions = ExecutionRepositoryTestFactory.create(session.getMapper(ExecutionMapper.class), mapper);
        contexts = new ModelContextService(mapper,
                new SessionContextRepositoryImpl(session.getMapper(SessionContextMapper.class)));
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("STATE_CONFLICT：HTTP 200 + code 4090 + data 空 + 既有文案")
    void stateConflictIsHttp200WithCode4090() throws Exception {
        assertConflict(DecisionErrorCode.STATE_CONFLICT, "卡片已被其他操作更新，请刷新后重试");
    }

    @Test
    @DisplayName("DECISION_ALREADY_APPLIED：HTTP 200 + code 4091 + 既有文案")
    void alreadyAppliedIsHttp200WithCode4091() throws Exception {
        assertConflict(DecisionErrorCode.DECISION_ALREADY_APPLIED, "该互动已有结论，请查看最新状态");
    }

    @Test
    @DisplayName("INTERACTION_NOT_READY：HTTP 200 + code 4092 + 既有文案")
    void notReadyIsHttp200WithCode4092() throws Exception {
        assertConflict(DecisionErrorCode.INTERACTION_NOT_READY, "互动尚未就绪，请等待执行暂停后再提交");
    }

    @Test
    @DisplayName("EXECUTION_ENDED：HTTP 200 + code 4093 + 既有文案")
    void executionEndedIsHttp200WithCode4093() throws Exception {
        assertConflict(DecisionErrorCode.EXECUTION_ENDED, "执行已结束，该决策不会再生效");
    }

    @Test
    @DisplayName("COMMAND_CONFLICT：HTTP 200 + code 4095 + 既有文案")
    void commandConflictIsHttp200WithCode4095() throws Exception {
        assertConflict(DecisionErrorCode.COMMAND_CONFLICT, "同一命令标识对应了不同的请求内容，请刷新后重新提交");
    }

    @Test
    @DisplayName("端到端：过期 expectedVersion 经真实引擎与真实控制器仍是 HTTP 200 + 4090")
    void staleVersionReachesClientAsHttp200With4090() throws Exception {
        stagePlanCard();
        MockMvc mvc = MockMvcBuilders
                .standaloneSetup(new ToolCallController(mock(ToolCallService.class),
                        mock(ToolCallWorkflowService.class), realVersionedService(), mock(ChoiceAnswersService.class)))
                .setControllerAdvice(new GlobalExceptionHandler())
                .build();

        // 库里卡片版本是 1，客户端声称看到 99：真实引擎在这里抛 STATE_CONFLICT。
        mvc.perform(post("/tool-call/decisions").contentType(MediaType.APPLICATION_JSON)
                        .content(body(TOOL_CALL_ID, "cmd-stale", 99L)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(4090))
                .andExpect(jsonPath("$.data").doesNotExist())
                .andExpect(jsonPath("$.errMsg").value("卡片已被其他操作更新，请刷新后重试"));
    }

    /** 逐码断言：状态、业务码、data 为空、文案四件套。 */
    private void assertConflict(DecisionErrorCode code, String expectedMessage) throws Exception {
        VersionedToolCallDecisionService service = mock(VersionedToolCallDecisionService.class);
        when(service.decide(any())).thenThrow(new DecisionConflictException(code, code.message()));
        MockMvc mvc = MockMvcBuilders
                .standaloneSetup(new ToolCallController(mock(ToolCallService.class),
                        mock(ToolCallWorkflowService.class), service, mock(ChoiceAnswersService.class)))
                .setControllerAdvice(new GlobalExceptionHandler())
                .build();

        mvc.perform(post("/tool-call/decisions").contentType(MediaType.APPLICATION_JSON)
                        .content(body(TOOL_CALL_ID, "cmd-" + code.name(), 1L)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value(code.code()))
                .andExpect(jsonPath("$.data").doesNotExist())
                .andExpect(jsonPath("$.errMsg").value(expectedMessage));
    }

    /** 真实引擎装配：版本校验与冲突抛错都走生产实现，只有协调器用桩（冲突发生在受理之前）。 */
    private VersionedToolCallDecisionService realVersionedService() {
        ToolCallConverter converter = new ToolCallConverter(mapper);
        ImmediateSlotResolutionStrategy immediate = new ImmediateSlotResolutionStrategy(converter,
                mock(ChoiceAnswersValidator.class), tools);
        InteractionDecisionEngine engine = new InteractionDecisionEngine(tools, converter, provider(executions),
                contexts, transactions,
                new CoordinatorResumeAcceptance(mock(ExecutionResumeCoordinator.class)),
                new UnresolvedToolSuspensionGate(tools), immediate,
                new TwoPhaseCommandResolutionStrategy(mock(CommandApprovalExecutor.class), tools, converter));
        return new VersionedToolCallDecisionService(tools, converter, engine, new VersionedDecisionContract(converter));
    }

    /** 挂起执行 + 一张待决计划卡：版本 1，供过期版本用例撞冲突。 */
    private void stagePlanCard() {
        ToolMessageEntity slot = ToolMessageEntity.builder().id(TOOL_CALL_ID).name("create_plan")
                .toolOutput("pending").build();
        List<Message> messages = new ArrayList<>(List.of(slot));
        AgentRequest request = AgentRequest.builder()
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(CONVERSATION_ID))).build())
                .build();
        Execution execution = Execution.builder().id(String.valueOf(EXECUTION_ID)).agentId("chatAgent")
                .agentRequest(request).executionState(ExecutionState.CREATED).messages(messages).build();
        transactions.executeWithoutResult(status -> {
            executions.save(execution);
            execution.startChecked();
            execution.suspendChecked();
            executions.save(execution);
        });
        contexts.replace(CONVERSATION_ID, execution.getMessages());
        tools.save(ToolCall.builder().id(TOOL_CALL_ID).conversationId(CONVERSATION_ID).executionId(EXECUTION_ID)
                .toolName("create_plan").type(ToolCallType.PROMISE).status(ToolCallStatus.PENDING)
                .title("计划").content("{\"kind\":\"PLAN\",\"title\":\"T\",\"text\":\"body\"}")
                .rawInput("{\"args\":{}}").build());
    }

    /** 请求体按 DTO 字段名写出：字段改名会直接让这里编译或断言失败。 */
    private static String body(String toolCallId, String commandId, long expectedVersion) {
        return "{\"conversationId\":" + CONVERSATION_ID + ",\"toolCallId\":\"" + toolCallId
                + "\",\"commandId\":\"" + commandId + "\",\"expectedVersion\":" + expectedVersion
                + ",\"action\":\"APPROVE\",\"text\":\"\"}";
    }

    private static <T> ObjectProvider<T> provider(T value) {
        return new ObjectProvider<>() {
            @Override
            public T getObject() {
                return value;
            }
        };
    }
}
