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
import com.summit.dp.email.MailLeaseTestSupport;
import com.summit.dp.email.domain.model.Email;
import com.summit.dp.email.domain.model.EmailMessage;
import com.summit.dp.email.domain.repository.EmailMessageReceiptRepository;
import com.summit.dp.email.domain.repository.EmailRepository;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMapper;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMessageMapper;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMessageReceiptMapper;
import com.summit.dp.email.infrastructure.repository.EmailMessageReceiptRepositoryImpl;
import com.summit.dp.email.infrastructure.repository.EmailMessageRepositoryImpl;
import com.summit.dp.email.infrastructure.repository.EmailRepositoryImpl;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.support.SqlCaptureInterceptor;
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
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 邮件投递回执的守卫：跨轮/重发/冷恢复都不得重放已消费邮件，且不靠 id 高水位。
 *
 * <p>全部用例跑真实 H2 与真实 Mapper（{@link SqlCaptureInterceptor} 记录真实下发的 SQL），
 * 期望值都是写死的字面量，避免用被测常量自证。</p>
 */
class MailReceiptDeliveryGuardTest {

    private static final long SESSION_ID = 710L;
    private static final long AGENT_ID = 7L;
    private static final String PREVIOUS_EXECUTION_ID = "900";
    private static final String NEXT_EXECUTION_ID = "901";
    /** 反序提交用的一对 id：大 id 先提交，小 id 后提交。 */
    private static final long BIG_MESSAGE_ID = 9_000_000_000_000_009L;
    private static final long SMALL_MESSAGE_ID = 9_000_000_000_000_001L;

    private H2TestDatabase database;
    private SqlCaptureInterceptor capture;
    private EmailService emails;
    private EmailRepository mailboxes;
    private EmailMessageRepositoryImpl messages;
    private EmailMessageReceiptRepository receiptRepository;
    private EmailMessageReceiptMapper receiptMapper;
    private MailInputChannel mail;
    private BackgroundTaskChannel background;
    private TaskRepositoryImpl tasks;
    private MailReceiptFlusher flusher;
    private InputTurnAdmission admission;
    private PlatformTransactionManager transactions;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("MailReceiptDeliveryGuardTest");
        capture = new SqlCaptureInterceptor();
        MybatisConfiguration configuration = database.configuration(
                EmailMapper.class, EmailMessageMapper.class, EmailMessageReceiptMapper.class, TaskMapper.class);
        configuration.addInterceptor(capture);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        MybatisPlusInterceptor plugins = new MybatisPlusInterceptor();
        plugins.addInnerInterceptor(new PaginationInnerInterceptor(DbType.H2));
        factory.setPlugins(plugins);
        SqlSessionFactory sessionFactory = factory.getObject();
        SqlSessionTemplate template = H2TestDatabase.sqlSession(sessionFactory);

        mailboxes = new EmailRepositoryImpl(template.getMapper(EmailMapper.class));
        messages = new EmailMessageRepositoryImpl(template.getMapper(EmailMessageMapper.class));
        receiptMapper = template.getMapper(EmailMessageReceiptMapper.class);
        receiptRepository = new EmailMessageReceiptRepositoryImpl(receiptMapper);
        transactions = new DataSourceTransactionManager(database);
        emails = (EmailService) transactionalProxy(new EmailServiceImpl(mailboxes, messages, receiptRepository));
        mail = new MailInputChannel(emails);
        tasks = new TaskRepositoryImpl(template.getMapper(TaskMapper.class));
        background = new BackgroundTaskChannel(tasks, new BackgroundTaskNotifications());
        flusher = new MailReceiptFlusher(receiptRepository, messages);
        admission = admissionOverFlusher();
        capture.clear();
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    // ---------- ① 普通真实入口链：不重放 ----------

    @Test
    @DisplayName("普通 chat 消费 → 普通下一轮 → 冷恢复：已消费邮件全程不重放，新邮件照常注入")
    void ordinaryTurnsNeverReplayConsumedMail() {
        emails.sendMail(AGENT_ID, "第一轮的邮件 A", new MailSendContext(SESSION_ID, 8L, null));
        Execution previous = execution(PREVIOUS_EXECUTION_ID);
        List<EmailMessageVO> batchA = mail.pollPendingItems(previous);
        assertEquals(1, batchA.size(), "第一轮应看到这一封");

        // 循环内注入后登记已投递，检查点提交那次事务写回执（生产里由 LocalExecutionRepository 挂载）。
        mail.markConsumed(previous, batchA);
        flusher.flush(previous);

        // 普通下一轮：新执行、属性全新，绝不能重放。
        Execution next = execution(NEXT_EXECUTION_ID);
        assertTrue(mail.pollPendingItems(next).isEmpty(), "普通下一轮不重放已消费邮件");

        // 冷恢复：重建仓储与通道实例（等价于进程重启后首次查询）。
        MailInputChannel restarted = new MailInputChannel((EmailService) transactionalProxy(
                new EmailServiceImpl(mailboxes, messages, receiptRepository)));
        assertTrue(restarted.pollPendingItems(execution("902")).isEmpty(), "重启后首查同样不重放");

        emails.sendMail(AGENT_ID, "第二轮的邮件 B", new MailSendContext(SESSION_ID, 8L, null));
        assertEquals(List.of("第二轮的邮件 B"),
                restarted.pollPendingItems(execution("903")).stream().map(EmailMessageVO::getContent).toList(),
                "新到达的邮件必须仍能被看到");
    }

    @Test
    @DisplayName("旧检查点不带任何回执登记：闸门是回执表，旧属性缺失也不重放")
    void oldCheckpointWithoutDeliveredAttributeDoesNotReplay() {
        EmailMessageVO sent = emails.sendMail(AGENT_ID, "早已投递的邮件", new MailSendContext(SESSION_ID, 8L, null))
                .getData();
        flusher.flush(executionWithDelivered("904", List.of(sent.getId())));
        assertEquals(1, receiptRepository.findMessageIdsWithReceipt(List.of(sent.getId())).size());

        // 旧检查点：属性里既没有游标也没有回执登记。
        assertTrue(mail.pollPendingItems(execution("905")).isEmpty(),
                "判定只看回执表，不依赖执行私有属性");
    }

    @Test
    @DisplayName("status 已是 CONSUMED 但没有回执：仍必须投递一次（清理不等于已投递）")
    void consumedStatusWithoutReceiptStillDeliveredOnce() {
        EmailMessageVO sent = emails.sendMail(AGENT_ID, "状态被清理但没留回执",
                new MailSendContext(SESSION_ID, 8L, null)).getData();
        // 模拟历史清理：行还在，但 status 已是 CONSUMED，且没有任何回执。
        messages.consumeByIds(List.of(sent.getId()));

        assertEquals(List.of(sent.getId()),
                mail.pollPendingItems(execution("911")).stream().map(EmailMessageVO::getId).toList(),
                "判据是回执表而不是 status：已被清理但未记录回执的邮件必须仍投递一次");

        flusher.flush(executionWithDelivered("912", List.of(sent.getId())));
        assertTrue(mail.pollPendingItems(execution("913")).isEmpty(),
                "回执落库之后才不再投递");
    }

    @Test
    @DisplayName("注入后、检查点落库前崩溃：重启重新注入；回执落库后重启不重复")
    void crashBeforeCheckpointReinjectsAfterRestart() {
        EmailMessageVO sent = emails.sendMail(AGENT_ID, "崩溃窗口邮件",
                new MailSendContext(SESSION_ID, 8L, null)).getData();
        Execution previous = execution("914");
        List<EmailMessageVO> batch = mail.pollPendingItems(previous);
        assertEquals(List.of(sent.getId()), batch.stream().map(EmailMessageVO::getId).toList());
        // 已注入模型上下文、已登记内存属性，但检查点没落库、回执没写 —— 此刻进程崩溃。
        mail.markConsumed(previous, batch);

        MailInputChannel restarted = new MailInputChannel((EmailService) transactionalProxy(
                new EmailServiceImpl(mailboxes, messages, receiptRepository)));
        // 崩溃后超过租约期：新执行（或重启后的同一执行）才有资格重新认领。
        MailLeaseTestSupport.expireClaims(receiptMapper);
        assertEquals(1, restarted.pollPendingItems(execution("915")).size(),
                "未提交的回执不得吞掉输入：租约过期后必须重新注入（重复而非丢失）");

        // 检查点提交那次事务里写回执。
        flusher.flush(previous);
        assertTrue(restarted.pollPendingItems(execution("916")).isEmpty(),
                "回执与检查点一起落库后，重启不再重复注入");
    }

    // ---------- ② 反序提交：证明没有 id 高水位 ----------

    @Test
    @DisplayName("两个独立事务反序提交（先大 id、后小 id）：两条都必须被取到")
    void reverseOrderCommitsAreBothDelivered() {
        Email mailbox = Email.builder().id(5001L).workflowExecutionId(SESSION_ID).recipientAgentId(AGENT_ID)
                .status(Email.STATUS_ACTIVE).build();
        mailboxes.save(mailbox);
        // 大 id 先提交。
        inOwnTransaction(() -> messages.save(message(BIG_MESSAGE_ID, mailbox.getId(), "大 id 先提交",
                Instant.now().plusSeconds(1))));
        // 小 id 后提交（雪花 id 完全可能这样落地）。
        inOwnTransaction(() -> messages.save(message(SMALL_MESSAGE_ID, mailbox.getId(), "小 id 后提交",
                Instant.now())));

        List<EmailMessageVO> polled = mail.pollPendingItems(execution("906"));
        assertEquals(2, polled.size(), "较小 id 晚提交也必须被取到，不得被高水位挡住");
        assertEquals(List.of(SMALL_MESSAGE_ID, BIG_MESSAGE_ID),
                polled.stream().map(EmailMessageVO::getId).toList(),
                "注入顺序按 create_at、id 稳定排列，不是水位过滤");

        // 只认领「大 id」这一条：高水位实现会把小 id 一起挡掉，回执实现只跳过已交付的那条。
        flusher.flush(executionWithDelivered("906", List.of(BIG_MESSAGE_ID)));
        // 小 id 仍被 906 的租约占着：租约内别人不得抢；崩溃/过期后才可重新认领。
        MailLeaseTestSupport.expireClaims(receiptMapper);
        assertEquals(List.of(SMALL_MESSAGE_ID),
                mail.pollPendingItems(execution("908")).stream().map(EmailMessageVO::getId).toList(),
                "已交付的只是大 id，小 id 在租约过期后仍必须被投递");
    }

    // ---------- ③ 受理事务回滚与重试 ----------

    @Test
    @DisplayName("受理事务回滚：回执不存在、输入仍可取；重试只成功一次，不建第二轮")
    void admissionRollbackKeepsInputAndRetrySucceedsOnce() {
        EmailMessageVO sent = emails.sendMail(AGENT_ID, "受理前必须先落库的邮件",
                new MailSendContext(SESSION_ID, 8L, null)).getData();
        Execution previous = execution(PREVIOUS_EXECUTION_ID);
        List<EmailMessageVO> batch = mail.pollPendingItems(previous);
        assertEquals(1, batch.size());
        RuntimeContext context = contextOf(execution(NEXT_EXECUTION_ID));

        // 第一次受理：事务回滚（模拟提交前崩溃）。
        TransactionTemplate template = new TransactionTemplate(transactions);
        template.execute(status -> {
            admission.admit(context, previous, "auto-input:rollback", batch, List.of());
            status.setRollbackOnly();
            return null;
        });
        assertTrue(receiptRepository.findMessageIdsWithReceipt(List.of(sent.getId())).isEmpty(),
                "事务回滚后回执不得存在");
        // 租约过期后，同一执行冷重读：内存里的去重清单已随回滚丢弃，输入必须仍能取到。
        MailLeaseTestSupport.expireClaims(receiptMapper);
        assertEquals(1, mail.pollPendingItems(execution(PREVIOUS_EXECUTION_ID)).size(),
                "回滚后输入仍必须可取");

        // 重试：这次提交成功，回执落库。
        RuntimeContext admitted = template.execute(status ->
                admission.admit(context, previous, "auto-input:retry", batch, List.of()));
        assertNotNull(admitted);
        assertEquals(List.of(sent.getId()),
                receiptRepository.findMessageIdsWithReceipt(List.of(sent.getId())).stream().toList(),
                "提交后回执必须存在");
        assertTrue(mail.pollPendingItems(execution("908")).isEmpty(), "重试成功后同一封邮件不再投递");

        // 同一批输入的再次调用（轮次已建）：返回 null，不建第二轮。
        assertNull(admission.admit(context, previous, "auto-input:retry", batch, List.of()),
                "重复调用必须幂等返回 null");
    }

    // ---------- ④ G1 顺序守卫：属性就绪必须早于任何一次保存 ----------

    @Test
    @DisplayName("受理顺序：保存新执行时它的自动接续计数已经就绪，且旧执行已登记本批已投递")
    void admissionPreparesAttributesBeforeAnySave() {
        EmailMessageVO sent = emails.sendMail(AGENT_ID, "顺序守卫输入", new MailSendContext(SESSION_ID, 8L, null))
                .getData();
        Execution previous = execution(PREVIOUS_EXECUTION_ID);
        List<EmailMessageVO> batch = mail.pollPendingItems(previous);
        assertEquals(List.of(sent.getId()), batch.stream().map(EmailMessageVO::getId).toList());

        // 记录「第一次保存发生时」两份执行各自的属性取值：顺序错的话这里都会读到空。
        Map<String, Object> admittedAtSave = new HashMap<>();
        Map<String, Object> previousAtSave = new HashMap<>();
        ChatTurnRepository turns = mock(ChatTurnRepository.class);
        when(turns.findByCommandId(anyString())).thenReturn(Optional.empty());
        PreparedChatExecutor executor = mock(PreparedChatExecutor.class);
        Execution nextExecution = execution(NEXT_EXECUTION_ID);
        RuntimeContext context = contextOf(nextExecution);
        when(executor.admit(any(RuntimeContext.class), anyString())).thenReturn(context);
        ExecutionRepository executions = mock(ExecutionRepository.class);
        AtomicInteger saves = new AtomicInteger();
        doAnswer(invocation -> {
            Execution saved = invocation.getArgument(0);
            if (saves.incrementAndGet() == 1) {
                admittedAtSave.putAll(InputAutomationPolicy.attributes(saved));
                previousAtSave.putAll(InputAutomationPolicy.attributes(previous));
            }
            return null;
        }).when(executions).save(any(Execution.class));

        InputTurnAdmission target = new InputTurnAdmission(executor, turns,
                new StaticListableBeanFactory(Map.of("executions", executions))
                        .getBeanProvider(ExecutionRepository.class), mail, background);
        ProxyFactory proxy = new ProxyFactory(target);
        proxy.addAdvice(new TransactionInterceptor(transactions, new AnnotationTransactionAttributeSource()));
        ((InputTurnAdmission) proxy.getProxy()).admit(context, previous, "auto-input:order", batch, List.of());

        assertEquals(0, InputAutomationPolicy.autoRounds(previous),
                "旧执行的自动接续计数不该被改写");
        assertEquals(1, admittedAtSave.get(InputAutomationPolicy.AUTO_ROUNDS),
                "第一次保存新执行时，自动接续计数必须已经写好，实际=" + admittedAtSave);
        assertEquals(List.of(sent.getId()), previousAtSave.get(ExecutionAttributes.DELIVERED_MAIL_IDS),
                "第一次保存时旧执行必须已登记本批已投递（否则回执会在错误的时机落库），实际=" + previousAtSave);
    }

    // ---------- ⑤ 零额外 SQL / SQL 条数 ----------
    @Test
    @DisplayName("没有待写回执的执行：flush 一次库都不查（普通连续轮次零额外 SQL）")
    void flushWithoutDeliveredIdsRunsNoSql() {
        capture.clear();
        flusher.flush(execution("909"));
        assertTrue(capture.queries().isEmpty(), "无待写回执时不得产生查询，实际=" + capture.queries());
        assertTrue(capture.updates().isEmpty(), "无待写回执时不得产生写入，实际=" + capture.updates());
    }

    @Test
    @DisplayName("回执落库的 SQL 形态：先查已有回执，再按窄查询取邮箱，最后插入与状态清理")
    void receiptFlushSqlShape() {
        EmailMessageVO sent = emails.sendMail(AGENT_ID, "回执 SQL 形态", new MailSendContext(SESSION_ID, 8L, null))
                .getData();
        Execution execution = executionWithDelivered("910", List.of(sent.getId()));
        capture.clear();
        flusher.flush(execution);

        List<String> queries = capture.queries();
        List<String> updates = capture.updates();
        assertEquals(1L, queries.stream()
                        .filter(sql -> SqlCaptureInterceptor.normalize(sql).contains("from email_message_receipt"))
                        .count(),
                "既有回执查询只发一条，实际=" + queries);
        assertEquals(1L, queries.stream()
                        .filter(sql -> SqlCaptureInterceptor.normalize(sql)
                                .contains("select id,email_id from email_message where"))
                        .count(),
                "取邮箱归属必须只选两列的窄查询，实际=" + queries);
        assertTrue(queries.stream().noneMatch(sql -> SqlCaptureInterceptor.normalize(sql).contains("content")),
                "回执落库不得把正文 CLOB 读回来，实际=" + queries);
        assertEquals(1L, updates.stream()
                        .filter(sql -> SqlCaptureInterceptor.normalize(sql)
                                .contains("insert into email_message_receipt"))
                        .count(),
                "必须真的插入一条回执，实际=" + updates);
        assertEquals(1L, updates.stream()
                        .filter(sql -> SqlCaptureInterceptor.normalize(sql)
                                .contains("update email_message set status"))
                        .count(),
                "展示态清理只发一条批量 UPDATE，实际=" + updates);
    }

    // ---------- ⑤ 任务回执跨轮不泄漏 ----------

    @Test
    @DisplayName("任务结果按执行 id 归属，新轮次不会重投上一轮的任务结果")
    void taskReceiptsDoNotLeakIntoNextTurn() {
        Task finished = Task.builder().id(30L).sessionId(SESSION_ID).turnId(700L)
                .executionId(Long.parseLong(PREVIOUS_EXECUTION_ID)).command("test").build();
        finished.finish(Task.TaskStatus.SUCCESS, "上一轮输出", 0, false);
        tasks.save(finished);

        Execution previous = execution(PREVIOUS_EXECUTION_ID);
        List<Task> batch = background.pollPendingItems(previous);
        assertEquals(1, batch.size());
        background.markConsumed(previous, batch);

        Execution next = execution(NEXT_EXECUTION_ID);
        assertTrue(background.pollPendingItems(next).isEmpty(),
                "任务结果按执行 id 归属，新执行取不到上一轮的任务行");
        assertTrue(new BackgroundTaskNotifications().readReceipts(next).isEmpty(),
                "新执行没有回执，也不影响正确性：它本来也查不到上一轮的任务行");
    }

    private EmailMessage message(long id, long emailId, String content, Instant createAt) {
        return EmailMessage.builder().id(id).emailId(emailId).senderId(8L)
                .content(content).status(EmailMessage.EMStatus.PENDING).createAt(createAt).build();
    }

    /** 独立事务提交：模拟「两次提交各自成事务」，顺序与 id 大小无关。 */
    private void inOwnTransaction(Runnable action) {
        new TransactionTemplate(transactions).execute(status -> {
            action.run();
            return null;
        });
    }

    private Object transactionalProxy(Object target) {
        ProxyFactory proxy = new ProxyFactory(target);
        proxy.addAdvice(new TransactionInterceptor(transactions, new AnnotationTransactionAttributeSource()));
        return proxy.getProxy();
    }

    /**
     * 受理服务：执行仓储用「保存时补写回执」的替身，复刻生产里 {@code LocalExecutionRepository}
     * 的挂点，从而让回执真的落在 admit 那个事务里（回滚就必须一起消失）。
     */
    private InputTurnAdmission admissionOverFlusher() {
        ExecutionRepository executions = mock(ExecutionRepository.class);
        doAnswer(invocation -> {
            flusher.flush(invocation.getArgument(0));
            return null;
        }).when(executions).save(any(Execution.class));

        ChatTurnRepository turns = mock(ChatTurnRepository.class);
        // 第一次查询无轮次（可以建），建完之后同 commandId 必须查得到（幂等判重）。
        Map<String, Object> created = new HashMap<>();
        when(turns.findByCommandId(anyString())).thenAnswer(invocation ->
                created.containsKey(invocation.getArgument(0))
                        ? Optional.of(mock(com.summit.dp.turn.domain.model.ChatTurn.class)) : Optional.empty());

        PreparedChatExecutor executor = mock(PreparedChatExecutor.class);
        when(executor.admit(any(RuntimeContext.class), anyString())).thenAnswer(invocation -> {
            created.put(invocation.getArgument(1), Boolean.TRUE);
            return invocation.getArgument(0);
        });

        InputTurnAdmission target = new InputTurnAdmission(executor, turns,
                new StaticListableBeanFactory(Map.of("executions", executions))
                        .getBeanProvider(ExecutionRepository.class), mail, background);
        ProxyFactory proxy = new ProxyFactory(target);
        proxy.addAdvice(new TransactionInterceptor(transactions, new AnnotationTransactionAttributeSource()));
        return (InputTurnAdmission) proxy.getProxy();
    }

    private RuntimeContext contextOf(Execution execution) {
        RuntimeContext context = mock(RuntimeContext.class);
        when(context.execution()).thenReturn(execution);
        return context;
    }

    private Execution executionWithDelivered(String executionId, List<Long> delivered) {
        Execution execution = execution(executionId);
        InputAutomationPolicy.putAttribute(execution, ExecutionAttributes.DELIVERED_MAIL_IDS, delivered);
        return execution;
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
