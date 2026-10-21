package com.summit.dp.toolcall;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionRepositoryTestFactory;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.api.dto.ChoiceAnswersCommand;
import com.summit.dp.toolcall.api.dto.ChoiceAnswersReceipt;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.toolcall.application.vo.DecisionConflictException;
import com.summit.dp.toolcall.application.vo.DecisionErrorCode;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.infrastructure.persistence.mapper.ToolCallMapper;
import com.summit.dp.toolcall.infrastructure.persistence.repository.ToolCallRepositoryImpl;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.workflow.application.approval.ChoiceAnswersService;
import com.summit.dp.workflow.application.approval.ChoiceAnswersValidator;
import com.summit.dp.workflow.application.approval.ToolCallWorkflowService;
import com.summit.dp.workflow.application.approval.VersionedToolCallDecisionService;
import com.summit.dp.workflow.api.controller.ToolCallController;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.application.resume.SuspendedExecutionResumer;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.Callable;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.stream.IntStream;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

/** 真实卡片表和执行检查点共同验证整批提交与回滚。 */
class ChoiceAnswersServiceTest {
    private static final long CONVERSATION = 500L;
    private static final long EXECUTION = 2105000000000000001L;
    private static final String RESPONSE = "2105000000000000011";
    private EmbeddedDatabase database;
    private ExecutionRepository executions;
    private ToolCallRepositoryImpl tools;
    private ModelContextService contexts;
    private ExecutionResumeCoordinator coordinator;
    private ChoiceAnswersService service;
    private TransactionTemplate transactions;
    private MessageRepository messages;
    private ObjectMapper mapper;

    @BeforeEach
    void setup() throws Exception {
        database = new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2)
                .addScript("execution-status-schema.sql").addScript("tool-call-schema.sql").build();
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.addMapper(ExecutionMapper.class);
        configuration.addMapper(ToolCallMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionFactory sessionFactory = factory.getObject();
        SqlSessionTemplate session = new SqlSessionTemplate(sessionFactory);
        mapper = new ObjectMapper().findAndRegisterModules();
        messages = mock(MessageRepository.class);
        executions = ExecutionRepositoryTestFactory.create(session.getMapper(ExecutionMapper.class), mapper);
        tools = spy(new ToolCallRepositoryImpl(session.getMapper(ToolCallMapper.class), mapper, mock(CardAvailabilityPolicy.class)));
        contexts = mock(ModelContextService.class);
        coordinator = mock(ExecutionResumeCoordinator.class);
        when(coordinator.accept(EXECUTION)).thenAnswer(invocation -> {
            assertTrue(TransactionSynchronizationManager.isActualTransactionActive());
            assertTrue(tools.listByExecutionId(EXECUTION).stream().allMatch(ToolCall::isCompleted));
            return ResumeDisposition.QUEUED;
        });
        transactions = new TransactionTemplate(new DataSourceTransactionManager(database));
        ObjectProvider<ExecutionRepository> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(executions);
        SuspendedExecutionResumer resumer = mock(SuspendedExecutionResumer.class);
        service = new ChoiceAnswersService(tools, new ToolCallConverter(mapper), new ChoiceAnswersValidator(mapper, messages),
                provider, contexts, coordinator, resumer, transactions);
        seed();
    }

    @AfterEach
    void close() {
        database.shutdown();
    }

    private void seed() throws Exception {
        List<ToolCallRequest> requests = IntStream.range(0, 4)
                .mapToObj(index -> new ToolCallRequest("choice-" + index, ToolCatalog.REQUIRE_CHOICE, index, "{}"))
                .toList();
        List<Message> messages = new ArrayList<>();
        AiMessageEntity ai = AiMessageEntity.builder().toolCalls(requests).text("").build();
        messages.add(ai);
        when(this.messages.findByResponseId(CONVERSATION, RESPONSE)).thenReturn(Optional.of(SessionMessage.builder()
                .sessionId(CONVERSATION).responseId(RESPONSE).type(SessionMessageType.AI).text(mapper.writeValueAsString(ai)).build()));
        requests.forEach(request -> messages.add(ToolMessageEntity.builder().id(request.id())
                .name(ToolCatalog.REQUIRE_CHOICE).toolOutput("Waiting for the user.").build()));
        AgentRequest request = AgentRequest.builder().runtimeParameters(AgentRuntimeParameters.builder()
                .attributes(Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(CONVERSATION))).build()).build();
        Execution execution = Execution.builder().id(String.valueOf(EXECUTION)).agentRequest(request)
                .executionState(ExecutionState.CREATED).messages(messages).build();
        transactions.executeWithoutResult(status -> {
            executions.save(execution);
            execution.startChecked();
            execution.suspendChecked();
            executions.save(execution);
            requests.forEach(call -> tools.save(ToolCall.builder().id(call.id()).conversationId(CONVERSATION)
                    .executionId(EXECUTION).toolName(ToolCatalog.REQUIRE_CHOICE).type(ToolCallType.PROMISE)
                    .status(ToolCallStatus.PENDING).title("问题 " + call.requestIndex())
                    .content("{\"kind\":\"CHOICE\",\"question\":\"问题\",\"options\":[\"A\",\"B\"]}").build()));
        });
    }

    private ChoiceAnswersCommand command(String id) {
        return new ChoiceAnswersCommand(CONVERSATION, RESPONSE, id, IntStream.range(0, 4)
                .mapToObj(index -> new ChoiceAnswersCommand.Answer("choice-" + index, 1L, " answer " + index + "\n"))
                .toList());
    }

    @Test
    void fourAnswersCommitTogetherAndRequestOneResume() {
        ChoiceAnswersReceipt receipt = service.submit(command("batch-1"));

        assertEquals(4, receipt.toolCalls().size());
        assertEquals(ResumeDisposition.QUEUED, receipt.resumeDisposition());
        Execution saved = executions.findById(String.valueOf(EXECUTION)).orElseThrow();
        for (int index = 0; index < 4; index++) {
            ToolCall card = tools.findById("choice-" + index).orElseThrow();
            assertEquals(ToolCallStatus.COMPLETED, card.getStatus());
            assertEquals("batch-1", card.getDecisionCommandId());
            assertEquals(" answer " + index + "\n", ((ToolMessageEntity) saved.getMessages().get(index + 1)).getToolOutput());
        }
        verify(contexts).replace(eq(CONVERSATION), any());
        verify(coordinator).accept(EXECUTION);
    }

    @Test
    void endpointAcceptsOneRequestAndReturnsAllAuthoritativeCards() throws Exception {
        ToolCallController controller = new ToolCallController(mock(ToolCallService.class),
                mock(ToolCallWorkflowService.class), mock(VersionedToolCallDecisionService.class), service);
        MockMvcBuilders.standaloneSetup(controller).build()
                .perform(post("/tool-call/choice-answers").contentType(MediaType.APPLICATION_JSON)
                        .content(mapper.writeValueAsString(command("http-batch"))))
                .andExpect(status().isOk()).andExpect(jsonPath("$.data.toolCalls.length()").value(4))
                .andExpect(jsonPath("$.data.commandId").value("http-batch"));
        verify(coordinator).accept(EXECUTION);
    }

    @Test
    void staleLastCardRejectsAllAnswers() {
        List<ChoiceAnswersCommand.Answer> answers = new ArrayList<>(command("stale").answers());
        answers.set(3, new ChoiceAnswersCommand.Answer("choice-3", 0L, "changed"));
        DecisionConflictException error = assertThrows(DecisionConflictException.class,
                () -> service.submit(new ChoiceAnswersCommand(CONVERSATION, RESPONSE, "stale", answers)));
        assertEquals(DecisionErrorCode.STATE_CONFLICT, error.errorCode());
        assertUnchanged();
    }

    @Test
    void secondPersistenceFailureRollsBackFirstCard() {
        AtomicInteger updates = new AtomicInteger();
        doAnswer(invocation -> {
            if (updates.incrementAndGet() == 2) throw new IllegalStateException("模拟第二张卡片保存失败");
            return invocation.callRealMethod();
        }).when(tools).updateById(any(ToolCall.class));

        assertThrows(IllegalStateException.class, () -> service.submit(command("rollback")));
        assertEquals(2, updates.get());
        assertUnchanged();
    }

    @Test
    void contextFailureAlsoRollsBackTheAlreadySavedExecutionCheckpoint() {
        doThrow(new IllegalStateException("模拟上下文保存失败")).when(contexts).replace(eq(CONVERSATION), any());
        assertThrows(IllegalStateException.class, () -> service.submit(command("late-rollback")));
        assertDatabaseUnchanged();
        verifyNoInteractions(coordinator);
    }

    @Test
    void anotherPendingToolKeepsTheExecutionWaiting() {
        tools.save(ToolCall.builder().id("plan").conversationId(CONVERSATION).executionId(EXECUTION)
                .toolName(ToolCatalog.CREATE_PLAN).type(ToolCallType.PROMISE).status(ToolCallStatus.PENDING)
                .content("{\"kind\":\"PLAN\"}").build());
        doReturn(ResumeDisposition.WAITING_OTHER_TOOLS).when(coordinator).accept(EXECUTION);

        assertEquals(ResumeDisposition.WAITING_OTHER_TOOLS, service.submit(command("with-plan")).resumeDisposition());
        assertEquals(ToolCallStatus.PENDING, tools.findById("plan").orElseThrow().getStatus());
        verify(coordinator).accept(EXECUTION);
    }

    @Test
    void simultaneousRetriesCommitOneBatchAndRequestOneResume() throws Exception {
        CyclicBarrier gate = new CyclicBarrier(2);
        Callable<ChoiceAnswersReceipt> task = () -> { gate.await(10, TimeUnit.SECONDS); return service.submit(command("concurrent")); };
        ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            Future<ChoiceAnswersReceipt> first = workers.submit(task);
            Future<ChoiceAnswersReceipt> second = workers.submit(task);
            assertEquals(4, first.get(15, TimeUnit.SECONDS).toolCalls().size());
            assertEquals(4, second.get(15, TimeUnit.SECONDS).toolCalls().size());
        } finally {
            workers.shutdownNow();
        }
        verify(coordinator).accept(EXECUTION);
        verify(contexts).replace(eq(CONVERSATION), any());
    }

    @Test
    void sameBatchRetryIsIdempotentAfterResume() {
        service.submit(command("retry"));
        Execution execution = executions.findById(String.valueOf(EXECUTION)).orElseThrow();
        execution.resumeChecked();
        transactions.executeWithoutResult(status -> executions.save(execution));

        assertEquals(ResumeDisposition.RUNNING, service.submit(command("retry")).resumeDisposition());
        verify(coordinator, times(1)).accept(EXECUTION);
        verify(contexts, times(1)).replace(eq(CONVERSATION), any());
    }

    @Test
    void retryCannotChangeAnswerOrRemoveMembers() {
        service.submit(command("retry"));
        ChoiceAnswersCommand subset = new ChoiceAnswersCommand(CONVERSATION, RESPONSE, "retry",
                command("retry").answers().subList(0, 3));
        assertEquals(DecisionErrorCode.COMMAND_CONFLICT,
                assertThrows(DecisionConflictException.class, () -> service.submit(subset)).errorCode());
        List<ChoiceAnswersCommand.Answer> changed = new ArrayList<>(command("retry").answers());
        changed.set(0, new ChoiceAnswersCommand.Answer("choice-0", 1L, "other"));
        assertThrows(DecisionConflictException.class, () -> service.submit(
                new ChoiceAnswersCommand(CONVERSATION, RESPONSE, "retry", changed)));
        verify(coordinator, times(1)).accept(EXECUTION);
    }

    @Test
    void incompleteGroupAndWrongResponseCannotBeSubmitted() {
        assertThrows(ClientException.class, () -> service.submit(new ChoiceAnswersCommand(CONVERSATION, RESPONSE,
                "partial", command("partial").answers().subList(0, 3))));
        assertThrows(ClientException.class, () -> service.submit(new ChoiceAnswersCommand(CONVERSATION, "other-response",
                "wrong", command("wrong").answers())));
        assertUnchanged();
    }

    @Test
    void missingExactSlotCannotOverwriteAnotherQuestionWithTheSameToolName() {
        Execution execution = executions.findById(String.valueOf(EXECUTION)).orElseThrow();
        execution.getMessages().remove(4);
        transactions.executeWithoutResult(status -> executions.save(execution));

        assertThrows(ClientException.class, () -> service.submit(command("missing-slot")));
        assertTrue(tools.listByExecutionId(EXECUTION).stream().noneMatch(ToolCall::isCompleted));
        verifyNoInteractions(contexts, coordinator);
    }

    @Test
    void duplicateOrBlankAnswersAndWrongConversationAreRejected() {
        ChoiceAnswersCommand.Answer first = command("duplicate").answers().getFirst();
        assertThrows(ClientException.class, () -> service.submit(new ChoiceAnswersCommand(CONVERSATION, RESPONSE,
                "duplicate", List.of(first, first))));
        assertThrows(ClientException.class, () -> service.submit(new ChoiceAnswersCommand(CONVERSATION, RESPONSE,
                "blank", List.of(new ChoiceAnswersCommand.Answer("choice-0", 1L, " ")))));
        assertThrows(ClientException.class, () -> service.submit(new ChoiceAnswersCommand(999L, RESPONSE,
                "wrong", command("wrong").answers())));
        assertUnchanged();
    }

    private void assertUnchanged() {
        assertDatabaseUnchanged();
        verifyNoInteractions(contexts, coordinator);
    }

    private void assertDatabaseUnchanged() {
        assertTrue(tools.listByExecutionId(EXECUTION).stream().allMatch(card ->
                card.getStatus() == ToolCallStatus.PENDING && card.getDecisionCommandId() == null));
        Execution saved = executions.findById(String.valueOf(EXECUTION)).orElseThrow();
        assertTrue(saved.getMessages().stream().filter(message -> message instanceof ToolMessageEntity)
                .map(message -> (ToolMessageEntity) message).allMatch(message -> "Waiting for the user.".equals(message.getToolOutput())));
    }
}
