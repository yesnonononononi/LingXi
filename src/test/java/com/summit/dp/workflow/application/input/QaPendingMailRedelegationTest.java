package com.summit.dp.workflow.application.input;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.compact.ContextAttachmentProvider;
import com.summit.core.conf.ModelConfig;
import com.summit.core.conversation.api.ChatResponseEntity;
import com.summit.core.conversation.event.RuntimeEventPublisher;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.SystemMessageEntity;
import com.summit.core.conversation.message.TokenUsageEntity;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.ContextUsageReporter;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.core.tool.ConcurrentPolicy;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteCommand;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutionManager;
import com.summit.core.tool.ToolExecutor;
import com.summit.core.tool.ToolRegistry;
import com.summit.dp.agent.application.vo.AgentVO;
import com.summit.dp.email.application.command.MailSendContext;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.email.application.service.impl.EmailServiceImpl;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMapper;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMessageMapper;
import com.summit.dp.email.infrastructure.repository.EmailMessageRepositoryImpl;
import com.summit.dp.email.infrastructure.repository.EmailRepositoryImpl;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.RuntimeConfigurationTestSupport;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.model.application.service.ModelService;
import com.summit.dp.model.application.vo.RuntimeModel;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.support.SqliteTestDatabase;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.team.application.vo.TeamVO;
import com.summit.dp.tools.ToolListProcessorTestSupport;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.user_configs.application.service.SettingsProvider;
import com.summit.dp.workflow.application.chat.BusinessSystemPromptBuilder;
import com.summit.dp.workflow.application.delegation.CommanderMailWakeService;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import com.summit.dp.workflow.infrastructure.lifecycle.SubAgentCompleteNotifier;
import com.summit.dp.workflow.infrastructure.policy.SkillRootResolver;
import com.summit.dp.workflow.infrastructure.tools.arguments.CallSubAgentToolArgument;
import com.summit.dp.workflow.infrastructure.tools.config.AnnotatedToolTestDefinitions;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.communication.EmailLoopInterceptor;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.communication.MailInputSource;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.communication.MailWakeMisuseDetector;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.communication.SendMailToAgentTool;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation.SubAgentRequestFactory;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation.SubAgentWaitInterceptor;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation.SubExecutionInputSource;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.session.SubSessionResolver;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.session.SubSessionTarget;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskInputSource;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskNotifications;
import com.summit.dp.workspace.application.convert.WorkspaceConverter;
import com.summit.dp.workspace.application.service.WorkspaceService;
import com.summit.runtime.agent.AgentConfig;
import com.summit.runtime.context.RuntimeContext;
import com.summit.runtime.conversation.DefaultConversationManager;
import com.summit.runtime.conversation.DefaultTokenizer;
import com.summit.runtime.loop.BoundaryChecker;
import com.summit.runtime.loop.DefaultExecutionController;
import com.summit.runtime.loop.DefaultLoopInterceptor;
import com.summit.runtime.loop.DefaultLoopInterceptorProcessor;
import com.summit.runtime.loop.DefaultRuntimeLifeStyleManager;
import com.summit.runtime.loop.RuntimeProcessorTemplate;
import com.summit.runtime.loop.control.InMemoryActiveExecutionRegistry;
import com.summit.runtime.model.DefaultChatModelInvoker;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;

import javax.sql.DataSource;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/** 记录截图中的提前结束路径；这些反例通过不代表任务履约缺口已经修复。 */
class QaPendingMailRedelegationTest {
    private static final String ARTIFACT_TOOL = "test_write_delegation_artifact";
    private static final String CURRENT_TASK = "立即实现桌宠第三轮迭代，在 behavior/third-round.txt 写入 third-iteration-completed；不要只回复历史纠错邮件。";
    private static final String LEGACY_MAIL = "上一轮纠错：隔离工作树验证必须显式指定 ELECTRON_URL，端口被占先确认占用者归属。";
    private static final String RECEIPT = "教训已记下：隔离工作树验证显式指定 ELECTRON_URL，端口被占先确认占用者归属。";
    private static final String ARTIFACT = "third-iteration-completed";

    @TempDir Path directory;

    @ParameterizedTest @ValueSource(booleans = {false, true})
    void pendingHistoricalMailCanStillFinishANewDelegationWithoutItsArtifact(boolean h2) throws Exception {
        try (Fixture fixture = new Fixture(h2, directory)) {
            fixture.sendLegacyMail();
            Observation observed = fixture.run(false, false);
            assertReceiptOnlyCompletion(fixture, observed, 2);
        }
    }

    @ParameterizedTest @ValueSource(booleans = {false, true})
    void mailDuringTheOpeningReplyContinuesTheLoopButStillAllowsReceiptOnlyCompletion(boolean h2) throws Exception {
        try (Fixture fixture = new Fixture(h2, directory)) {
            Observation observed = fixture.run(false, true);
            assertReceiptOnlyCompletion(fixture, observed, 3);
            assertEquals(CURRENT_TASK, lastUser(observed.requests().getFirst()).text());
            assertTrue(lastUser(observed.requests().get(1)).text().contains(LEGACY_MAIL));
        }
    }

    @ParameterizedTest @ValueSource(booleans = {false, true})
    void theSameLatestInputModelWritesTheArtifactWhenOldMailWasAlreadyConsumed(boolean h2) throws Exception {
        try (Fixture fixture = new Fixture(h2, directory)) {
            fixture.sendLegacyMail();
            fixture.emails.consumePending(10L, 6L);
            Observation observed = fixture.run(false, false);
            assertEquals(ExecutionState.COMPLETED, observed.execution().getExecutionState());
            assertEquals(2, observed.requests().size());
            assertEquals(1, fixture.artifactCalls.get());
            assertEquals(0, fixture.mailCalls.get());
            assertEquals(ARTIFACT, Files.readString(fixture.artifact));
            assertEquals(CURRENT_TASK, lastUser(observed.requests().getFirst()).text());
        }
    }

    @ParameterizedTest @ValueSource(booleans = {false, true})
    void aModelThatHonorsTheDelegationCanFinishItEvenWhenHistoricalMailIsLast(boolean h2) throws Exception {
        try (Fixture fixture = new Fixture(h2, directory)) {
            fixture.sendLegacyMail();
            Observation observed = fixture.run(true, false);
            assertEquals(ExecutionState.COMPLETED, observed.execution().getExecutionState());
            assertEquals(2, observed.requests().size());
            assertEquals(1, fixture.artifactCalls.get());
            assertEquals(ARTIFACT, Files.readString(fixture.artifact));
            assertTrue(lastUser(observed.requests().getFirst()).text().contains(LEGACY_MAIL));
        }
    }

    private static void assertReceiptOnlyCompletion(Fixture fixture, Observation observed, int modelCalls) throws Exception {
        Execution completed = observed.execution();
        assertEquals(ExecutionState.COMPLETED, completed.getExecutionState());
        assertEquals(modelCalls, observed.requests().size());
        assertEquals(RECEIPT, completed.getAiMessage().getText());
        assertEquals(0, fixture.artifactCalls.get());
        assertEquals(1, fixture.mailCalls.get());
        assertFalse(Files.exists(fixture.artifact));
        assertFalse(Files.exists(fixture.artifact.getParent()));
        assertTrue(fixture.emails.pendingItems(10L, 6L).isEmpty());
        assertTrue(observed.requests().stream().allMatch(messages -> messages.stream()
                .anyMatch(message -> message instanceof SystemMessageEntity && message.text().contains(CURRENT_TASK))));
        assertTrue(observed.requests().stream().allMatch(messages -> messages.stream()
                .anyMatch(message -> message instanceof UserMessageEntity && message.text().equals(CURRENT_TASK))));

        // 完成提醒只认执行终态；它本身不证明任务要求的文件存在。
        ExecutionRepository snapshots = mock(ExecutionRepository.class);
        when(snapshots.findById("900")).thenReturn(Optional.of(Execution.builder().id("900")
                .agentRequest(AgentRequest.builder().runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, "10", ExecutionAttributes.AGENT_ID, "7")).build()).build()).build()));
        new SubAgentCompleteNotifier(provider(ExecutionRepository.class, snapshots), fixture.emails).notifyCommander(completed);
        List<EmailMessageVO> commanderMail = fixture.emails.pendingItems(10L, 7L);
        assertTrue(commanderMail.stream().anyMatch(mail -> mail.getContent().equals(RECEIPT)));
        assertTrue(commanderMail.stream().anyMatch(mail -> mail.getContent().contains("子任务已完成")));

        // 取信后已经没有待处理输入，新复查机制不会替任务履约自动补跑。
        when(snapshots.findById(completed.getId())).thenReturn(Optional.of(completed));
        ExecutionResumeCoordinator resumes = mock(ExecutionResumeCoordinator.class);
        InputTurnContinuation continuations = mock(InputTurnContinuation.class);
        InputNoticeReporter notices = mock(InputNoticeReporter.class);
        InputWakeupService wakeups = new InputWakeupService(provider(ExecutionRepository.class, snapshots),
                provider(ExecutionActivity.class, mock(ExecutionActivity.class)), fixture.inputs,
                new InputAutomationPolicy(new SessionExecutionRegistry()), notices,
                provider(ExecutionResumeCoordinator.class, resumes), provider(InputTurnContinuation.class, continuations));
        try {
            wakeups.resumeIfInputPending(Long.parseLong(completed.getId())).get(5, TimeUnit.SECONDS);
            verifyNoInteractions(resumes, continuations, notices);
        } finally {
            wakeups.close();
        }
    }

    private static UserMessageEntity lastUser(List<Message> messages) {
        return messages.stream().filter(UserMessageEntity.class::isInstance).map(UserMessageEntity.class::cast)
                .reduce((left, right) -> right).orElseThrow();
    }

    private static <T> ObjectProvider<T> provider(Class<T> type, T value) {
        return new StaticListableBeanFactory(Map.of("value", value)).getBeanProvider(type);
    }

    private record Observation(Execution execution, List<List<Message>> requests) { }

    private static final class Fixture implements AutoCloseable {
        private final AutoCloseable database;
        private final EmailService emails;
        private final MailInputSource mail;
        private final InputResolver inputs;
        private final Path artifact;
        private final AtomicInteger artifactCalls = new AtomicInteger();
        private final AtomicInteger mailCalls = new AtomicInteger();
        private final ObjectMapper json = new JsonConfig().objectMapper();

        private Fixture(boolean h2, Path directory) {
            artifact = directory.resolve("behavior/third-round.txt");
            DataSource source;
            SqlSessionFactory factory;
            if (h2) {
                H2TestDatabase db = H2TestDatabase.create("pending-mail-redelegation");
                database = db; source = db;
                factory = db.sessionFactory(EmailMapper.class, EmailMessageMapper.class);
            } else {
                SqliteTestDatabase db = SqliteTestDatabase.create("pending-mail-redelegation");
                database = db; source = db;
                factory = db.sessionFactory(EmailMapper.class, EmailMessageMapper.class);
            }
            SqlSessionTemplate session = h2 ? H2TestDatabase.sqlSession(factory) : SqliteTestDatabase.sqlSession(factory);
            ProxyFactory proxy = new ProxyFactory(new EmailServiceImpl(new EmailRepositoryImpl(session.getMapper(EmailMapper.class)),
                    new EmailMessageRepositoryImpl(session.getMapper(EmailMessageMapper.class))));
            proxy.addAdvice(new TransactionInterceptor(new DataSourceTransactionManager(source), new AnnotationTransactionAttributeSource()));
            emails = (EmailService) proxy.getProxy();
            mail = new MailInputSource(emails);
            inputs = new InputResolver(List.of(mail,
                    new BackgroundTaskInputSource(mock(TaskRepository.class), new BackgroundTaskNotifications()),
                    new SubExecutionInputSource(new SessionExecutionRegistry(), mock(SessionRepository.class),
                            mock(ExecutionRepositoryImpl.class))), json);
        }

        private void sendLegacyMail() {
            emails.sendMail(6L, LEGACY_MAIL, new MailSendContext(10L, 7L, 3L));
        }

        private Observation run(boolean honorDelegation, boolean mailDuringOpening) {
            AgentRequest request = buildReusedRequest();
            List<List<Message>> requests = new ArrayList<>();
            Execution execution = Execution.create(request, "");
            execution.setMaxSteps(5);
            DefaultConversationManager conversations = new DefaultConversationManager(ContextAttachmentProvider.NONE);
            DefaultTokenizer tokenizer = new DefaultTokenizer();
            RuntimeEventPublisher events = new RuntimeEventPublisher(List.of());
            InMemoryActiveExecutionRegistry checkpoints = new InMemoryActiveExecutionRegistry(json);
            DefaultRuntimeLifeStyleManager lifecycle = new DefaultRuntimeLifeStyleManager(events);
            RuntimeProcessorTemplate runtime = new RuntimeProcessorTemplate(RuntimeContext.builder()
                    .executionRepository(checkpoints).conversationManager(conversations)
                    .executionControl(new DefaultExecutionController(() -> null, checkpoints, events, lifecycle))
                    .runtimeLifeStyleManager(lifecycle).runtimeEventPublisher(events).toolExecutionManager(tools())
                    .loopInterceptorProcessor(new DefaultLoopInterceptorProcessor(List.of(new DefaultLoopInterceptor(),
                            new EmailLoopInterceptor(emails, mail), new SubAgentWaitInterceptor(inputs))))
                    .runtimeBoundaryChecker(new BoundaryChecker(AgentConfig.builder().maxIterations(5).build(), tokenizer,
                            conversations, null, null)).usage(new ContextUsageReporter(tokenizer, 64000, events, 1))
                    .invoker(new DefaultChatModelInvoker(command -> {
                        requests.add(List.copyOf(command.getMessages()));
                        if (mailDuringOpening && requests.size() == 1) {
                            sendLegacyMail();
                            return response("开始第三轮迭代，先看现状。", List.of());
                        }
                        // 固定模型选择消除随机性；正对照使用同一个模型，只有待处理邮件不同。
                        if (!honorDelegation && lastUser(command.getMessages()).text().contains(LEGACY_MAIL)) {
                            return mailCalls.get() == 0
                                    ? response("回复上一轮纠错邮件", List.of(new ToolCallRequest("mail", ToolCatalog.SEND_MAIL_TO_AGENT, 0,
                                            "{\"toAgentId\":7,\"mailContent\":\"" + RECEIPT + "\"}")))
                                    : response(RECEIPT, List.of());
                        }
                        return artifactCalls.get() == 0
                                ? response("实现本次新委派", List.of(new ToolCallRequest("artifact", ARTIFACT_TOOL, 0, "{}")))
                                : response("第三轮产物已生成", List.of());
                    })).build());
            Execution completed = runtime.execute(execution);
            assertEquals(List.of(CURRENT_TASK), request.getTask());
            return new Observation(completed, List.copyOf(requests));
        }

        private AgentRequest buildReusedRequest() {
            AgentVO member = new AgentVO();
            member.setId(6L); member.setName("工程师"); member.setPrompt("执行主理人的开发委派");
            member.setModelId(4L); member.setToolList(List.of(ARTIFACT_TOOL));
            List<Message> history = List.of(UserMessageEntity.from("上一轮桌宠检查"),
                    AiMessageEntity.builder().text("上一轮已结束").toolCalls(List.of()).build());
            SessionRepository sessions = mock(SessionRepository.class);
            ModelContextService contexts = mock(ModelContextService.class);
            when(sessions.findByRootAndAgent(10L, 6L)).thenReturn(Optional.of(Session.builder().id(20L).build()));
            when(contexts.find(20L)).thenReturn(Optional.of(history));
            SubSessionTarget target = new SubSessionResolver(sessions, contexts).resolve(10L, member);
            assertTrue(target.reused());
            assertEquals("20", target.subSessionId());
            ModelService models = mock(ModelService.class);
            SettingsProvider settings = mock(SettingsProvider.class);
            when(settings.current()).thenReturn(Optional.empty());
            when(models.resolveRuntimeConfig(anyLong(), any())).thenReturn(new RuntimeModel(ModelConfig.builder()
                    .baseUrl("https://example.invalid").apiKey("test-only").modelName("deterministic-probe").build(), false));
            CallSubAgentToolArgument argument = new CallSubAgentToolArgument();
            argument.setAgentId(6L); argument.setTask(CURRENT_TASK);
            AgentRequest request = new SubAgentRequestFactory(mock(WorkspaceService.class), models, settings,
                    mock(WorkspaceConverter.class), new SkillRootResolver(""), new BusinessSystemPromptBuilder(""),
                    ToolListProcessorTestSupport.create(), RuntimeConfigurationTestSupport.create())
                    .build(argument, member, TeamVO.builder().id(3L).commanderAgentId(7L).agents(List.of(member)).build(),
                            ToolExecution.builder().executionId("900").attributes(Map.of(
                                    ExecutionAttributes.SESSION_ID, "10", ExecutionAttributes.AGENT_ID, "7", ExecutionAttributes.TEAM_ID, "3")).build(),
                            null, target.subSessionId(), null, target.priorMessages());
            assertEquals(2, history.size());
            assertEquals(CURRENT_TASK, request.getMessages().getLast().text());
            return request;
        }

        private ToolExecutionManager tools() {
            ToolExecutor artifactWriter = execution -> {
                try {
                    Files.createDirectories(artifact.getParent());
                    Files.writeString(artifact, ARTIFACT);
                    artifactCalls.incrementAndGet();
                    return ToolExecuteResult.success("已写入测试产物");
                } catch (IOException failure) {
                    throw new UncheckedIOException("测试产物写入失败", failure);
                }
            };
            ToolDefinition<ToolExecutor> artifactDefinition = ToolDefinition.<ToolExecutor>builder()
                    .id(ARTIFACT_TOOL).name(ARTIFACT_TOOL).executor(artifactWriter).maxOutput(1024).timeout(10L)
                    .description("仅用于验证委派确实产生文件").parametersJsonSchema("{\"type\":\"object\",\"properties\":{}}")
                    .concurrentPolicy(ConcurrentPolicy.SERIAL_MUTATION).build();
            SendMailToAgentTool sender = new SendMailToAgentTool(json, emails,
                    mock(CommanderMailWakeService.class), mock(MailWakeMisuseDetector.class));
            ToolDefinition<SendMailToAgentTool> mailDefinition = AnnotatedToolTestDefinitions.create(SendMailToAgentTool.class, sender);
            ToolRegistry registry = new ToolRegistry(List.of(artifactDefinition, mailDefinition));
            return new ToolExecutionManager() {
                @Override public ToolRegistry toolRegistry() { return registry; }
                @Override public List<ToolExecuteResult> execute(ToolExecuteCommand command) {
                    List<ToolExecuteResult> results = new ArrayList<>();
                    for (ToolCallRequest call : command.requests()) {
                        ToolDefinition<?> definition = registry.getTool(call.name());
                        assertNotNull(definition);
                        if (call.name().equals(ToolCatalog.SEND_MAIL_TO_AGENT)) mailCalls.incrementAndGet();
                        ToolExecuteResult result = definition.executor().execute(ToolExecution.builder().id(call.id())
                                .executionId(command.executionId()).args(call.arguments()).attributes(command.attributes()).build());
                        assertTrue(result.isSuccess(), result.getToolOutput());
                        result.setId(call.id()); result.setRequestIndex(call.requestIndex()); result.setToolSpecification(definition);
                        results.add(result);
                    }
                    return results;
                }
            };
        }

        @Override public void close() throws Exception { database.close(); }
    }

    private static ChatResponseEntity response(String text, List<ToolCallRequest> calls) {
        return ChatResponseEntity.builder().aiMessageEntity(AiMessageEntity.builder().text(text).toolCalls(calls).build())
                .tokenUsage(TokenUsageEntity.empty()).build();
    }
}
