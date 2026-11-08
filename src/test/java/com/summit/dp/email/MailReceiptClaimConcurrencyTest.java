package com.summit.dp.email;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.dp.email.application.command.MailSendContext;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.email.application.service.impl.EmailServiceImpl;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.email.domain.model.EmailMessageReceipt;
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
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 同一邮箱、同一 Agent 的两个并发执行：一封邮件只能有一个持久化交付归属。
 *
 * <p>真实路由下这是可达的：每次委派都由 {@code SubAgentRequestFactory} 生成新 executionId，
 * 并把同一个 ROOT_SESSION_ID / AGENT_ID 下行；{@code AsyncDelegationSubmitter} 用虚拟线程池并发执行，
 * {@code SessionExecutionRegistry#tryStartChild} 只校验单个 executionId，不按邮箱键串行化。</p>
 */
class MailReceiptClaimConcurrencyTest {

    private static final long SESSION_ID = 730L;
    private static final long AGENT_ID = 7L;
    private static final String EXECUTION_A = "7001";
    private static final String EXECUTION_B = "7002";

    private H2TestDatabase database;
    private EmailService emails;
    private EmailMessageReceiptRepository receipts;
    private EmailMessageReceiptMapper receiptMapper;
    private MailInputChannel mail;
    private MailReceiptFlusher flusher;
    private final MailClaimLivenessFake liveness = new MailClaimLivenessFake();
    private PlatformTransactionManager transactions;

    @BeforeEach
    void setup() {
        database = H2TestDatabase.create("MailReceiptClaimConcurrencyTest");
        SqlSessionFactory factory = database.sessionFactory(EmailMapper.class, EmailMessageMapper.class,
                EmailMessageReceiptMapper.class);
        SqlSessionTemplate session = H2TestDatabase.sqlSession(factory);

        EmailMessageRepositoryImpl messages = new EmailMessageRepositoryImpl(
                session.getMapper(EmailMessageMapper.class));
        receiptMapper = session.getMapper(EmailMessageReceiptMapper.class);
        receipts = new EmailMessageReceiptRepositoryImpl(receiptMapper, liveness);
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
    @DisplayName("两个独立执行、两个独立事务同邮箱同 Agent：一封邮件只被一个执行交付")
    void twoConcurrentExecutionsDeliverOnce() {
        EmailMessageVO sent = sendMail("并发归属的邮件");
        Execution first = execution(EXECUTION_A);
        Execution second = execution(EXECUTION_B);

        List<EmailMessageVO> firstBatch = inOwnTransaction(() -> mail.pollPendingItems(first));
        List<EmailMessageVO> secondBatch = inOwnTransaction(() -> mail.pollPendingItems(second));

        assertEquals(1, firstBatch.size() + secondBatch.size(),
                "同一封邮件只允许被一个执行认领（认领失败方不得注入）");
        Execution holder = firstBatch.isEmpty() ? second : first;
        List<EmailMessageVO> batch = firstBatch.isEmpty() ? secondBatch : firstBatch;
        assertEquals(List.of(sent.getId()), batch.stream().map(EmailMessageVO::getId).toList());

        mail.markConsumed(holder, batch);
        inOwnTransaction(() -> {
            flusher.flush(holder);
            return null;
        });
        assertEquals(List.of(sent.getId()),
                List.copyOf(receipts.findMessageIdsWithReceipt(List.of(sent.getId()))),
                "回执必须落在持有者名下");
        assertEquals(SESSION_ID, receipts.findByMessageIds(List.of(sent.getId())).getFirst()
                        .getConsumerSessionId(),
                "交付会话必须与持有者同会话");

        assertTrue(inOwnTransaction(() -> mail.pollPendingItems(execution("7003"))).isEmpty(),
                "已交付的邮件不得再进任何新执行的上下文");
    }

    @Test
    @DisplayName("持有者崩溃（认领未交付）：租约过期后另一执行重新投递，输入不丢")
    void crashedHolderClaimIsRecoveredAfterLease() {
        EmailMessageVO sent = sendMail("持有者会崩溃的邮件");
        assertEquals(1, inOwnTransaction(() -> mail.pollPendingItems(execution(EXECUTION_A))).size(),
                "崩溃前先拿到投递权");

        // 崩溃：检查点没提交、回执没落库。租约还有效时别人不许抢。
        Execution survivor = execution(EXECUTION_B);
        assertTrue(inOwnTransaction(() -> mail.pollPendingItems(survivor)).isEmpty(),
                "有效租约内别人不得抢，否则两份上下文会各投一次");

        MailLeaseTestSupport.expireClaims(receiptMapper);
        List<EmailMessageVO> recovered = inOwnTransaction(() -> mail.pollPendingItems(survivor));
        assertEquals(List.of(sent.getId()), recovered.stream().map(EmailMessageVO::getId).toList(),
                "租约过期后必须能被重新认领（永久丢输入才是不可接受的）");

        mail.markConsumed(survivor, recovered);
        inOwnTransaction(() -> {
            flusher.flush(survivor);
            return null;
        });
        assertEquals(List.of(sent.getId()),
                List.copyOf(receipts.findMessageIdsWithReceipt(List.of(sent.getId()))),
                "重新认领后必须真的交付");
        assertTrue(inOwnTransaction(() -> mail.pollPendingItems(execution("7003"))).isEmpty(),
                "交付后不再重复投递");
    }

    @Test
    @DisplayName("同一执行重复 poll：不重复注入")
    void sameExecutionDoesNotDuplicate() {
        sendMail("同一执行只注入一次");
        Execution execution = execution(EXECUTION_A);
        List<EmailMessageVO> first = inOwnTransaction(() -> mail.pollPendingItems(execution));
        assertEquals(1, first.size());
        mail.markConsumed(execution, first);

        assertTrue(inOwnTransaction(() -> mail.pollPendingItems(execution)).isEmpty(),
                "同一执行同一轮不得重复注入");
        assertTrue(inOwnTransaction(() -> mail.pollPendingItems(execution)).isEmpty(),
                "重复 poll 仍然为空");
    }

    @Test
    @DisplayName("归属冲突不被吞掉：抢到租约的一方才能交付，原持有者的确认失败且不清自己的清单")
    void ownershipConflictIsNotSwallowed() {
        EmailMessageVO sent = sendMail("归属会易手的邮件");
        Execution original = execution(EXECUTION_A);
        List<EmailMessageVO> originalBatch = inOwnTransaction(() -> mail.pollPendingItems(original));
        assertEquals(1, originalBatch.size());
        mail.markConsumed(original, originalBatch);

        // 崩溃超过租约：另一个执行接管。
        MailLeaseTestSupport.expireClaims(receiptMapper);
        assertEquals(1, inOwnTransaction(() -> mail.pollPendingItems(execution(EXECUTION_B))).size(),
                "过期租约可被接管");

        // 原持有者晚到的检查点提交：不得把别人的认领算成自己已交付。
        inOwnTransaction(() -> {
            flusher.flush(original);
            return null;
        });
        assertTrue(receipts.findMessageIdsWithReceipt(List.of(sent.getId())).isEmpty(),
                "原持有者不得凭自己的检查点就把邮件算作已交付");
        assertEquals(List.of(sent.getId()), ExecutionAttributes.readLongs(attributesOf(original),
                        ExecutionAttributes.DELIVERED_MAIL_IDS),
                "冲突的 id 不得从原持有者的已投递清单里被清掉（否则等于把冲突当成了已交付）");
    }

    @Test
    @DisplayName("已交付回执属于本执行：清掉 delivered ids，冷恢复不再重复查询")
    void existingOwnReceiptPrunesDeliveredIds() {
        EmailMessageVO sent = sendMail("已交付再保存一次");
        Execution execution = execution(EXECUTION_A);
        List<EmailMessageVO> batch = inOwnTransaction(() -> mail.pollPendingItems(execution));
        mail.markConsumed(execution, batch);
        inOwnTransaction(() -> {
            flusher.flush(execution);
            return null;
        });
        assertEquals(List.of(sent.getId()),
                List.copyOf(receipts.findMessageIdsWithReceipt(List.of(sent.getId()))));

        // 冷恢复会带着上一份检查点里的清单再来一次：必须被清掉，不能每次都重查。
        Execution restored = execution(EXECUTION_A);
        attributesOf(restored).put(ExecutionAttributes.DELIVERED_MAIL_IDS, List.of(sent.getId()));
        inOwnTransaction(() -> {
            flusher.flush(restored);
            return null;
        });
        assertTrue(ExecutionAttributes.readLongs(attributesOf(restored),
                        ExecutionAttributes.DELIVERED_MAIL_IDS).isEmpty(),
                "已属于本执行的回执对应的 id 必须被清掉");
    }

    /** 冲突用例的辅助：确认过期的租约确实归了别人，而回执仍未交付。 */
    private EmailMessageReceipt receiptOf(Long messageId) {
        return receipts.findByMessageIds(List.of(messageId)).getFirst();
    }

    private EmailMessageVO sendMail(String content) {
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

    private Map<String, Object> attributesOf(Execution execution) {
        return execution.getAgentRequest().runtimeParametersOrDefault().getAttributes();
    }

    /** 每个动作各自一个事务：模拟两次独立提交。 */
    private <T> T inOwnTransaction(Supplier<T> action) {
        return new TransactionTemplate(transactions).execute(status -> action.get());
    }

    private EmailService proxy(EmailServiceImpl target) {
        ProxyFactory factory = new ProxyFactory(target);
        factory.addAdvice(new TransactionInterceptor(transactions, new AnnotationTransactionAttributeSource()));
        return (EmailService) factory.getProxy();
    }
}
