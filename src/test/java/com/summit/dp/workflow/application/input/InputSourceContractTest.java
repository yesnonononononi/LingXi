package com.summit.dp.workflow.application.input;

import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import java.time.Instant;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import com.summit.dp.workflow.application.chat.RuntimeContext;
import com.summit.dp.workflow.application.chat.PreparedChatExecutor;
import com.summit.dp.turn.infrastructure.persistence.po.ChatTurnPO;
import com.summit.dp.turn.infrastructure.persistence.mapper.ChatTurnMapper;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.conversation.message.Message;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopMessages;
import com.summit.core.runtime.loop.LoopResult;
import com.summit.dp.email.application.command.MailSendContext;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.email.application.service.impl.EmailServiceImpl;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMapper;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMessageMapper;
import com.summit.dp.email.infrastructure.repository.EmailRepositoryImpl;
import com.summit.dp.email.infrastructure.repository.EmailMessageRepositoryImpl;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.domain.model.Task.TaskStatus;
import com.summit.dp.task.infrastructure.persistence.mapper.TaskMapper;
import com.summit.dp.task.infrastructure.repository.TaskRepositoryImpl;
import com.summit.dp.workflow.application.lifecycle.SubExecutionDependency;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.communication.EmailLoopInterceptor;
import com.summit.dp.workflow.application.input.MailInputChannel;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation.SubAgentWaitInterceptor;
import com.summit.dp.workflow.application.input.SubExecutionResultChannel;
import com.summit.dp.workflow.application.input.BackgroundTaskChannel;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskNotifications;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskLoopInterceptor;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.Test;
import static org.mockito.ArgumentMatchers.anyList;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;

import javax.sql.DataSource;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class InputSourceContractTest {
    @Test
    void consumedBatchDoesNotSwallowLaterArrivals() throws Exception {
        try (Fixture fixture = new Fixture()) {
            EmailMessageVO first = fixture.emails.sendMail(7L, "第一份", new MailSendContext(10L, 8L, null)).getData();
            List<EmailMessageVO> selected = fixture.mail.pollPendingItems(fixture.execution);
            EmailMessageVO late = fixture.emails.sendMail(7L, "检查后到达", new MailSendContext(10L, 8L, null)).getData();
            // 游标只推进到选中批次的最后一条：迟到的那条在游标之后，不算已注入。
            fixture.mail.markConsumed(fixture.execution, selected);
            fixture.mail.cleanupAfterConsume(fixture.execution, selected);
            assertEquals(List.of(late.getId()), fixture.mail.pollPendingItems(fixture.execution).stream().map(EmailMessageVO::getId).toList());
            new EmailLoopInterceptor(fixture.mail).onBeforeModelInvoke(context(fixture.execution));
            assertFalse(fixture.resolver.hasPendingItems(fixture.execution));
            assertEquals(1, fixture.execution.getMessages().size());
            assertTrue(fixture.execution.getMessages().getFirst().text().contains("检查后到达"));
            assertNotEquals(first.getId(), late.getId());
        }
    }

    @Test
    void taskCompletionPublishesBeforeDependencyDisappearsAndReceiptsPreventRedelivery() throws Exception {
        try (Fixture fixture = new Fixture()) {
            Task task = Task.builder().id(20L).sessionId(10L).turnId(30L).executionId(100L).command("test").build();
            fixture.tasks.save(task);
            assertTrue(fixture.background.hasOpenAsyncDependency(fixture.execution));
            assertTrue(fixture.background.pollPendingItems(fixture.execution).isEmpty());
            task.finish(TaskStatus.SUCCESS, "真实输出", 0, false);
            fixture.tasks.updateById(task);
            assertFalse(fixture.background.hasOpenAsyncDependency(fixture.execution));
            assertEquals(1, fixture.background.pollPendingItems(fixture.execution).size());
            new BackgroundTaskLoopInterceptor(fixture.background).onBeforeModelInvoke(context(fixture.execution));
            // 回执与消息同批写下：同一批不会被第二次交付。
            assertTrue(fixture.background.pollPendingItems(fixture.execution).isEmpty());
            assertEquals(1, fixture.execution.getMessages().size());
        }
    }

    @Test
    void finalChildPublicationAtDependencyReadIsSeenBeforeCompletion() throws Exception {
        try (Fixture fixture = new Fixture()) {
            // 依赖读取发生的那一刻，最后一份交付刚好落库：随后的待处理读取必须看得到它。
            // 依赖读取发生的那一刻，最后一份交付刚好落库：随后的待处理读取必须看得到它。
            SessionExecutionRegistry registry = mock(SessionExecutionRegistry.class);
            when(registry.hasUnfinishedChildren(10L)).thenAnswer(call -> {
                fixture.emails.sendMailOnce(7L, "最后一份交付", new MailSendContext(10L, 8L, null), "last-child");
                return true;
            });
            InputResolver resolver = new InputResolver(fixture.mail,
                    new SubExecutionResultChannel(new SubExecutionDependency(registry,
                            mock(SessionRepository.class), mock(ExecutionRepositoryImpl.class))),
                    fixture.background, new ObjectMapper().findAndRegisterModules());
            SubAgentWaitInterceptor wait = new SubAgentWaitInterceptor(resolver);
            InterceptorResult result = wait.onBeforeComplete(context(fixture.execution));
            assertEquals(LoopResult.Status.CONTINUE, result.loopResult().status());
            assertFalse(result.next(), "必须显式继续原循环，不能误把 NONE 的默认状态当成继续");
        }
    }

    @Test
    void automaticAdmissionCommitsTheSelectedMailAndRollsBackItsNewTurnOnFailure() throws Exception {
        try (Fixture fixture = new Fixture()) {
            fixture.emails.sendMail(7L, "自动新轮的真实输入", new MailSendContext(10L, 8L, null));
            PreparedChatExecutor executor = mock(PreparedChatExecutor.class);
            ChatTurnRepository turns = mock(ChatTurnRepository.class);
            ExecutionRepository snapshots = mock(ExecutionRepository.class);
            RuntimeContext context = mock(RuntimeContext.class);
            Execution next = Execution.builder().id("200").agentRequest(AgentRequest.builder().runtimeParameters(AgentRuntimeParameters.builder()
                    .attributes(Map.of(ExecutionAttributes.SESSION_ID, "10", ExecutionAttributes.AGENT_ID, "7")).build()).build()).build();
            when(context.execution()).thenReturn(next);
            when(executor.admit(context, "batch-command")).thenAnswer(call -> {
                fixture.turnRows.insert(ChatTurnPO.builder().id(300L).sessionId(10L).executionId(200L)
                        .status("ACCEPTED").version(0L).createdAt(Instant.now()).build());
                return context;
            });
            Task task = Task.builder().id(20L).sessionId(10L).turnId(30L).executionId(100L).command("test").build();
            task.finish(TaskStatus.SUCCESS, "任务交付", 0, false);
            InputTurnAdmission target = new InputTurnAdmission(executor, fixture.emails, turns,
                    new StaticListableBeanFactory(Map.of("snapshots", snapshots))
                            .getBeanProvider(ExecutionRepository.class), fixture.mail, fixture.background);
            ProxyFactory proxy = new ProxyFactory(target);
            proxy.addAdvice(new TransactionInterceptor(new DataSourceTransactionManager(fixture.dataSource),
                    new AnnotationTransactionAttributeSource()));
            InputTurnAdmission admission = (InputTurnAdmission) proxy.getProxy();
            doThrow(new IllegalStateException("检查点持久化失败")).when(snapshots).save(fixture.execution);
            List<EmailMessageVO> selected = fixture.mail.pollPendingItems(fixture.execution);
            assertThrows(IllegalStateException.class, () -> admission.admit(context, fixture.execution,
                    "batch-command", selected, List.of(task)));
            assertNull(fixture.turnRows.selectById(300L));
            assertEquals(selected, fixture.mail.pollPendingItems(fixture.execution));
            doNothing().when(snapshots).save(fixture.execution);
            admission.admit(context, fixture.execution, "batch-command", selected, List.of(task));
            assertNotNull(fixture.turnRows.selectById(300L));
            assertTrue(fixture.mail.pollPendingItems(fixture.execution).isEmpty());
            assertEquals(1, InputAutomationPolicy.autoRounds(next));
        }
    }

    @Test
    void persistedSuspendedChildSurvivesAnEmptyProcessRegistry() throws Exception {
        try (Fixture fixture = new Fixture()) {
            SessionRepository sessions = mock(SessionRepository.class);
            when(sessions.findSessionTree(10L)).thenReturn(List.of(Session.builder().id(20L).build()));
            ExecutionPO child = new ExecutionPO();
            child.setId(200L);
            child.setSessionId(20L);
            child.setStatus(ExecutionStatusCodes.SUSPENDED);
            child.setVersion(0L);
            child.setResumeGeneration(1L);
            fixture.executionRows.insert(child);
            SubExecutionResultChannel source = new SubExecutionResultChannel(
                    new SubExecutionDependency(new SessionExecutionRegistry(), sessions,
                            new ExecutionRepositoryImpl(fixture.executionRows)));
            assertTrue(source.hasOpenAsyncDependency(fixture.execution));
            child.setStatus(ExecutionStatusCodes.COMPLETED);
            fixture.executionRows.updateById(child);
            assertFalse(source.hasOpenAsyncDependency(fixture.execution));
        }
    }

    private static LoopContext context(Execution execution) {
        return LoopContext.withCompactionCounter(LoopMessages.builder().execution(execution).build(),
                new ExecutionControlSignal(execution.getId()), () -> 0, execution.getMessages()::addAll);
    }

    private static final class Fixture implements AutoCloseable {
        private final AutoCloseable database;
        private final DataSource dataSource;
        private final ChatTurnMapper turnRows;
        private final ExecutionMapper executionRows;
        private final EmailService emails;
        private final MailInputChannel mail;
        private final TaskRepositoryImpl tasks;
        private final BackgroundTaskNotifications notifications = new BackgroundTaskNotifications();
        private final BackgroundTaskChannel background;
        private final InputResolver resolver;
        private final Execution execution = Execution.builder().id("100").executionState(ExecutionState.RUNNING)
                .messages(new ArrayList<Message>()).agentRequest(AgentRequest.builder()
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(Map.of(
                                ExecutionAttributes.SESSION_ID, "10", ExecutionAttributes.AGENT_ID, "7")).build()).build()).build();

        private Fixture() {
            DataSource source;
            SqlSessionFactory factory;
            H2TestDatabase db = H2TestDatabase.create("input-contract");
            database = db; source = db;
            factory = db.sessionFactory(EmailMapper.class, EmailMessageMapper.class, TaskMapper.class, ChatTurnMapper.class, ExecutionMapper.class);
            SqlSessionTemplate session = H2TestDatabase.sqlSession(factory);
            dataSource = source;
            turnRows = session.getMapper(ChatTurnMapper.class);
            executionRows = session.getMapper(ExecutionMapper.class);
            EmailServiceImpl target = new EmailServiceImpl(new EmailRepositoryImpl(session.getMapper(EmailMapper.class)),
                    new EmailMessageRepositoryImpl(session.getMapper(EmailMessageMapper.class)));
            ProxyFactory proxy = new ProxyFactory(target);
            proxy.addAdvice(new TransactionInterceptor(new DataSourceTransactionManager(source), new AnnotationTransactionAttributeSource()));
            emails = (EmailService) proxy.getProxy();
            mail = new MailInputChannel(emails);
            tasks = new TaskRepositoryImpl(session.getMapper(TaskMapper.class));
            background = new BackgroundTaskChannel(tasks, notifications);
            resolver = new InputResolver(mail, new SubExecutionResultChannel(
                    new SubExecutionDependency(new SessionExecutionRegistry(), mock(SessionRepository.class),
                            new ExecutionRepositoryImpl(executionRows))),
                    background, new ObjectMapper().findAndRegisterModules());
        }

        @Override public void close() throws Exception { database.close(); }
    }
}
