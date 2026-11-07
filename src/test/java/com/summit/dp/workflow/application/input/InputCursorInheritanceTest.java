package com.summit.dp.workflow.application.input;

import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.email.application.command.MailSendContext;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.email.application.service.impl.EmailServiceImpl;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMapper;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMessageMapper;
import com.summit.dp.email.infrastructure.repository.EmailMessageRepositoryImpl;
import com.summit.dp.email.infrastructure.repository.EmailRepositoryImpl;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.infrastructure.persistence.mapper.TaskMapper;
import com.summit.dp.task.infrastructure.repository.TaskRepositoryImpl;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.application.chat.PreparedChatExecutor;
import com.summit.dp.workflow.application.chat.RuntimeContext;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskNotifications;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 注入游标跨轮次延续：完成态新轮次不得把上一轮已注入的邮件再来一遍。
 *
 * <p>为什么必须由「继承」来挡：改造后「已注入」的唯一判据是随检查点持久化的游标，
 * 而游标挂在具体执行上。新轮次执行是新对象，属性由 {@code RequestPreparer} 重新生成，
 * 天然不带上一轮的游标；不搬运的话每轮新执行都从 0 取起，会把信箱历史整体重投一遍。</p>
 */
class InputCursorInheritanceTest {

    private static final long SESSION_ID = 710L;
    private static final long AGENT_ID = 7L;
    private static final String PREVIOUS_EXECUTION_ID = "900";
    private static final String NEXT_EXECUTION_ID = "901";

    private H2TestDatabase database;
    private EmailService emails;
    private TaskRepositoryImpl tasks;
    private MailInputChannel mail;
    private BackgroundTaskChannel background;
    private InputTurnAdmission admission;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("InputCursorInheritanceTest");
        MybatisConfiguration configuration = database.configuration(
                EmailMapper.class, EmailMessageMapper.class, TaskMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        MybatisPlusInterceptor plugins = new MybatisPlusInterceptor();
        plugins.addInnerInterceptor(new PaginationInnerInterceptor(DbType.H2));
        factory.setPlugins(plugins);
        SqlSessionFactory sessionFactory = factory.getObject();
        SqlSessionTemplate template = H2TestDatabase.sqlSession(sessionFactory);

        ProxyFactory proxy = new ProxyFactory(new EmailServiceImpl(
                new EmailRepositoryImpl(template.getMapper(EmailMapper.class)),
                new EmailMessageRepositoryImpl(template.getMapper(EmailMessageMapper.class))));
        proxy.addAdvice(new TransactionInterceptor(new DataSourceTransactionManager(database),
                new AnnotationTransactionAttributeSource()));
        emails = (EmailService) proxy.getProxy();
        tasks = new TaskRepositoryImpl(template.getMapper(TaskMapper.class));
        mail = new MailInputChannel(emails);
        background = new BackgroundTaskChannel(tasks, new BackgroundTaskNotifications());

        ExecutionRepository executions = mock(ExecutionRepository.class);
        ChatTurnRepository turns = mock(ChatTurnRepository.class);
        when(turns.findByCommandId(anyString())).thenReturn(Optional.empty());
        PreparedChatExecutor executor = mock(PreparedChatExecutor.class);
        when(executor.admit(any(RuntimeContext.class), anyString()))
                .thenAnswer(call -> call.getArgument(0));
        admission = new InputTurnAdmission(executor, emails, turns,
                new StaticListableBeanFactory(Map.of("executions", executions))
                        .getBeanProvider(ExecutionRepository.class), mail, background);
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("跨轮次不重复注入：新执行继承游标，只看到新到达的邮件")
    void newTurnInheritsCursorAndSeesOnlyNewMail() {
        emails.sendMail(AGENT_ID, "第一轮的邮件 A", new MailSendContext(SESSION_ID, 8L, null));
        Execution previous = execution(PREVIOUS_EXECUTION_ID);
        List<EmailMessageVO> batchA = mail.pollPendingItems(previous);
        assertEquals(1, batchA.size());

        Execution next = execution(NEXT_EXECUTION_ID);
        RuntimeContext context = contextOf(next);
        // 真实受理入口：游标推进 + 全局消费都在 admit 的事务里完成，测试不自己先消费一次。
        assertEquals(context, admission.admit(context, previous, "auto-input:1", batchA, List.of()));

        assertEquals(batchA.getFirst().getId(),
                ExecutionAttributes.readLong(InputAutomationPolicy.attributes(next),
                        ExecutionAttributes.LAST_MAIL_ID),
                "新执行必须继承上一轮已注入的游标，否则整段历史会被重投");
        assertTrue(mail.pollPendingItems(next).isEmpty(), "上一轮注入过的邮件不得在新轮次重复注入");

        emails.sendMail(AGENT_ID, "第二轮新到的邮件 B", new MailSendContext(SESSION_ID, 8L, null));
        List<EmailMessageVO> batchB = mail.pollPendingItems(next);
        assertEquals(List.of("第二轮新到的邮件 B"),
                batchB.stream().map(EmailMessageVO::getContent).toList(),
                "新到达的邮件必须仍能被看到");
    }

    @Test
    @DisplayName("崩溃窗口仍不丢：游标未落库（重建实例）时上一轮的邮件会重新注入")
    void unrecordedCursorStillRedeliversAfterRestart() {
        emails.sendMail(AGENT_ID, "第一轮的邮件 A", new MailSendContext(SESSION_ID, 8L, null));
        Execution previous = execution(PREVIOUS_EXECUTION_ID);
        List<EmailMessageVO> batchA = mail.pollPendingItems(previous);
        mail.markConsumed(previous, batchA);
        mail.cleanupAfterConsume(previous, batchA);

        // 检查点没落库：新实例内存全丢，游标回到空 —— 必须重新取到 A，而不是因为库里已消费就丢掉。
        Execution restarted = execution(PREVIOUS_EXECUTION_ID);
        assertEquals(batchA.stream().map(EmailMessageVO::getId).toList(),
                mail.pollPendingItems(restarted).stream().map(EmailMessageVO::getId).toList(),
                "全局消费已生效但游标未落库时，重启必须重新注入（宁可重复一次，不可丢）");
    }

    @Test
    @DisplayName("任务结果按执行 id 归属，新轮次不会重投上一轮的任务结果")
    void taskReceiptsDoNotLeakIntoNextTurn() {
        Task finished = Task.builder().id(30L).sessionId(SESSION_ID).turnId(700L)
                .executionId(Long.parseLong(PREVIOUS_EXECUTION_ID)).command("test").build();
        finished.finish(Task.TaskStatus.SUCCESS, "上一轮输出", 0, false);
        tasks.save(finished);

        Execution previous = execution(PREVIOUS_EXECUTION_ID);
        assertEquals(1, background.pollPendingItems(previous).size());
        List<Task> batch = background.pollPendingItems(previous);
        background.markConsumed(previous, batch);

        Execution next = execution(NEXT_EXECUTION_ID);
        assertTrue(background.pollPendingItems(next).isEmpty(),
                "任务结果按执行 id 归属，新执行取不到上一轮的任务行");
        assertTrue(new BackgroundTaskNotifications().readReceipts(next).isEmpty(),
                "新执行没有回执，但这不影响正确性：它本来也查不到上一轮的任务行");
    }

    private RuntimeContext contextOf(Execution execution) {
        RuntimeContext context = mock(RuntimeContext.class);
        when(context.execution()).thenReturn(execution);
        return context;
    }

    private Execution execution(String executionId) {
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(ExecutionAttributes.SESSION_ID, String.valueOf(SESSION_ID));
        attributes.put(ExecutionAttributes.AGENT_ID, String.valueOf(AGENT_ID));
        return Execution.builder().id(executionId).messages(new ArrayList<>())
                .agentRequest(AgentRequest.builder().runtimeParameters(
                        AgentRuntimeParameters.builder().attributes(attributes).build()).build()).build();
    }
}
