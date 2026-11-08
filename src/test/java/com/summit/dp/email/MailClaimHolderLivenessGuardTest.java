package com.summit.dp.email;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.dp.email.application.command.MailSendContext;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.email.application.service.impl.EmailServiceImpl;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.email.domain.model.EmailMessageReceipt;
import com.summit.dp.email.domain.model.MailDeliveryLease;
import com.summit.dp.email.domain.repository.EmailMessageReceiptRepository;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMapper;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMessageMapper;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMessageReceiptMapper;
import com.summit.dp.email.infrastructure.repository.EmailMessageReceiptRepositoryImpl;
import com.summit.dp.email.infrastructure.repository.EmailMessageRepositoryImpl;
import com.summit.dp.email.infrastructure.repository.EmailRepositoryImpl;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.workflow.application.input.MailInputChannel;
import com.summit.dp.workflow.application.input.MailReceiptFlusher;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionMailClaimLiveness;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 投递归属守卫：<b>真实适配器</b>（{@link SessionMailClaimLiveness} → {@link SessionExecutionRegistry}）
 * 接到 {@link MailInputChannel#pollPendingItems} 上，以及仓储层 {@code markDelivered} 的归属条件。
 *
 * <h2>为什么不能用替身</h2>
 *
 * <p>此前「持有者挂起时不许接管」只由 {@code MailClaimLivenessFake#suspended} 表演过：
 * 替身自己说「挂起算活」，真实判别链（适配器 + 登记表）却没有任何用例跑过。
 * 把 {@code SessionExecutionRegistry#isHolderAlive} 改成只看 {@code isRunning} 时全量仍全绿，
 * 而生产中这意味着挂起期间被他人接管 → 同一封邮件被两个执行各注入一次。</p>
 *
 * <p>本类的挂起态由 registry 的公开 API 拼出（{@code registerPendingChild → acquire → release}），
 * 不反射改私有字段；结束态用 {@code recordExecution(..., finished=true)} 表达「数据库已确认终态、
 * 槽位尚未清理」，因此接管发生时<b>租约并没有过期</b> —— 断言的是「靠存活判定接管」，不是靠墙钟。</p>
 */
class MailClaimHolderLivenessGuardTest {

    private static final long SESSION_ID = 740L;
    private static final long AGENT_ID = 7L;
    private static final long A_SESSION_ID = 741L;
    private static final long CONSUMER_SESSION_ID = 742L;
    private static final String EXECUTION_A = "8101";
    private static final String EXECUTION_B = "8102";
    private static final String EXECUTION_C = "8103";

    private H2TestDatabase database;
    private EmailService emails;
    private EmailMessageReceiptRepository receipts;
    private MailInputChannel mail;
    private MailReceiptFlusher flusher;
    private SessionExecutionRegistry registry;
    private PlatformTransactionManager transactions;

    @BeforeEach
    void setup() {
        database = H2TestDatabase.create("MailClaimHolderLivenessGuardTest");
        SqlSessionFactory factory = database.sessionFactory(EmailMapper.class, EmailMessageMapper.class,
                EmailMessageReceiptMapper.class);
        SqlSessionTemplate session = H2TestDatabase.sqlSession(factory);

        // 真实判别链：仓储 → 适配器 → 登记表。整条链上没有任何替身。
        registry = new SessionExecutionRegistry();
        receipts = new EmailMessageReceiptRepositoryImpl(
                session.getMapper(EmailMessageReceiptMapper.class), new SessionMailClaimLiveness(registry));
        EmailMessageRepositoryImpl messages = new EmailMessageRepositoryImpl(
                session.getMapper(EmailMessageMapper.class));
        transactions = new DataSourceTransactionManager(database);
        emails = proxy(new EmailServiceImpl(new EmailRepositoryImpl(session.getMapper(EmailMapper.class)),
                messages, receipts));
        mail = new MailInputChannel(emails);
        flusher = new MailReceiptFlusher(receipts, messages);
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("真实适配器：A 持有认领且挂起 → B 拿不到；A 结束后 B 立刻拿到（租约未过期，不经墙钟）")
    void suspendedHolderBlocksTakeoverUntilItFinishes() {
        EmailMessageVO sent = newMail("挂起期间不许抢的邮件");

        // A 作为子执行登记并开跑，随后认领这封邮件。
        registry.registerPendingChild(SESSION_ID, A_SESSION_ID, EXECUTION_A, null);
        ExecutionControlSignal running = registry.acquire(EXECUTION_A);
        assertEquals(List.of(sent.getId()), ids(mail.pollPendingItems(execution(EXECUTION_A))),
                "A 首次轮询必须取得投递权并看到这封邮件");
        assertEquals(EXECUTION_A, receiptOf(sent.getId()).getClaimExecutionId(), "认领行必须归 A");

        // 挂起：释放运行占用，但槽位仍在、未结束、未取消。
        assertTrue(registry.release(running));
        assertFalse(registry.isActive(EXECUTION_A), "挂起后不再是 running");
        assertTrue(registry.isHolderAlive(EXECUTION_A), "挂起必须仍算持有者（生产实现口径）");

        assertTrue(mail.pollPendingItems(execution(EXECUTION_B)).isEmpty(),
                "持有者挂起期间 B 不得接管该邮件");
        assertEquals(EXECUTION_A, receiptOf(sent.getId()).getClaimExecutionId(), "被拒绝的 B 不得改掉认领归属");

        // A 结束：数据库确认终态，槽位等 forgetFinishedExecution 清理。
        registry.recordExecution(SESSION_ID, A_SESSION_ID, EXECUTION_A, true);
        assertTrue(registry.isRegistered(EXECUTION_A), "已结束但未清理时登记仍在");
        assertFalse(registry.isHolderAlive(EXECUTION_A), "已结束不再算持有者");

        Instant claimedAt = receiptOf(sent.getId()).getClaimedAt();
        assertTrue(claimedAt.plus(MailDeliveryLease.DURATION).isAfter(Instant.now()),
                "接管必须发生在租约期内，否则本用例无法证明靠的是存活判定而不是墙钟兜底");

        assertEquals(List.of(sent.getId()), ids(mail.pollPendingItems(execution(EXECUTION_B))),
                "A 结束后 B 必须立刻拿到（不必等租约过期）");
        assertEquals(EXECUTION_B, receiptOf(sent.getId()).getClaimExecutionId(), "投递权必须已转到 B");

        // B 交付后回执落库：后续执行不再取到同一封。
        List<EmailMessageVO> batch = mail.pollPendingItems(execution(EXECUTION_B));
        mail.markConsumed(execution(EXECUTION_B), batch);
        flusher.flush(execution(EXECUTION_B));
        assertTrue(mail.pollPendingItems(execution(EXECUTION_C)).isEmpty(),
                "B 交付并落回执之后，后续执行不得再取到");
    }

    @Test
    @DisplayName("markDelivered 归属守卫：非持有者确认交付无效，行仍归原持有者且未交付")
    void nonHolderCannotConfirmDelivery() {
        EmailMessageVO sent = newMail("归属校验用的邮件");
        Instant now = Instant.now().truncatedTo(ChronoUnit.MILLIS);
        assertTrue(receipts.tryClaim(sent.getId(), sent.getEmailId(), EXECUTION_A, now,
                MailDeliveryLease.DURATION), "首次认领必须成功");

        Set<Long> hijacked = receipts.markDelivered(List.of(sent.getId()), EXECUTION_B,
                CONSUMER_SESSION_ID, now);
        assertTrue(hijacked.isEmpty(), "非持有者确认交付必须返回空集合，实际=" + hijacked);

        EmailMessageReceipt afterHijack = receiptOf(sent.getId());
        assertEquals(EXECUTION_A, afterHijack.getClaimExecutionId(),
                "非持有者不得改写认领归属");
        assertNull(afterHijack.getDeliveredAt(), "非持有者不得把这条邮件标成交付");
        assertFalse(afterHijack.isDelivered());
        assertTrue(receipts.findMessageIdsWithReceipt(List.of(sent.getId())).isEmpty(),
                "非持有者确认后，这条邮件仍必须是未投递（否则输入永久丢失）");

        assertEquals(Set.of(sent.getId()),
                receipts.markDelivered(List.of(sent.getId()), EXECUTION_A, CONSUMER_SESSION_ID, now),
                "持有者自己确认交付必须生效");
        EmailMessageReceipt delivered = receiptOf(sent.getId());
        assertEquals(now, delivered.getDeliveredAt(), "交付时刻必须落库");
        assertEquals(CONSUMER_SESSION_ID, delivered.getConsumerSessionId(), "消费会话必须落库");
        assertFalse(receipts.markDelivered(List.of(sent.getId()), EXECUTION_B, CONSUMER_SESSION_ID, now)
                        .contains(sent.getId()),
                "已交付之后，任何执行都不得再把它算成自己交付的");
    }

    // ---------- 夹具 ----------

    private EmailMessageReceipt receiptOf(Long messageId) {
        return receipts.findByMessageIds(List.of(messageId)).getFirst();
    }

    private List<Long> ids(List<EmailMessageVO> items) {
        return items.stream().map(EmailMessageVO::getId).toList();
    }

    private EmailMessageVO newMail(String content) {
        return emails.sendMail(AGENT_ID, content, new MailSendContext(SESSION_ID, 8L, null)).getData();
    }

    private Execution execution(String executionId) {
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(ExecutionAttributes.SESSION_ID, String.valueOf(SESSION_ID));
        attributes.put(ExecutionAttributes.AGENT_ID, String.valueOf(AGENT_ID));
        return Execution.builder().id(executionId).messages(new ArrayList<>())
                .agentRequest(AgentRequest.builder().executionId(executionId).runtimeParameters(
                        AgentRuntimeParameters.builder().attributes(attributes).build()).build()).build();
    }

    private EmailService proxy(EmailServiceImpl target) {
        ProxyFactory factory = new ProxyFactory(target);
        factory.addAdvice(new TransactionInterceptor(transactions, new AnnotationTransactionAttributeSource()));
        return (EmailService) factory.getProxy();
    }
}
