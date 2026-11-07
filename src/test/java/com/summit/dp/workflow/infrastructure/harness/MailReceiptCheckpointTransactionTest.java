package com.summit.dp.workflow.infrastructure.harness;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.Message;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.email.domain.model.Email;
import com.summit.dp.email.domain.model.EmailMessage;
import com.summit.dp.email.domain.repository.EmailMessageReceiptRepository;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMapper;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMessageMapper;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMessageReceiptMapper;
import com.summit.dp.email.infrastructure.repository.EmailMessageReceiptRepositoryImpl;
import com.summit.dp.email.infrastructure.repository.EmailMessageRepositoryImpl;
import com.summit.dp.email.infrastructure.repository.EmailRepositoryImpl;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionRepositoryTestFactory;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.workflow.application.input.MailReceiptFlusher;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 邮件回执必须与检查点同批提交：崩在检查点之前重新投递，提交之后不再重复。
 *
 * <p>用真实 H2、真实检查点存储和真实 {@link LocalExecutionRepository}：
 * 回执挂点走的是生产那条 {@code commitCheckpoint} 路径，测试不自己调 flusher。</p>
 */
class MailReceiptCheckpointTransactionTest {

    private static final long SESSION_ID = 760L;
    private static final long AGENT_ID = 7L;
    private static final long EXECUTION_ID = 950L;
    private static final long MAILBOX_ID = 5001L;
    private static final long MESSAGE_ID = 9_000_000_000_000_101L;
    private static final long ROLLBACK_MESSAGE_ID = 9_000_000_000_000_102L;

    private final ObjectMapper objectMapper = new ObjectMapper().findAndRegisterModules();

    private H2TestDatabase database;
    private LocalExecutionRepository repository;
    private EmailMessageReceiptRepository receipts;
    private EmailMessageRepositoryImpl messages;
    private TransactionTemplate transactions;

    @BeforeEach
    void setup() {
        database = H2TestDatabase.create("MailReceiptCheckpointTransactionTest");
        SqlSessionFactory factory = database.sessionFactory(ExecutionMapper.class, EmailMapper.class,
                EmailMessageMapper.class, EmailMessageReceiptMapper.class);
        SqlSessionTemplate session = H2TestDatabase.sqlSession(factory);

        messages = new EmailMessageRepositoryImpl(session.getMapper(EmailMessageMapper.class));
        receipts = new EmailMessageReceiptRepositoryImpl(session.getMapper(EmailMessageReceiptMapper.class));
        MailReceiptFlusher flusher = new MailReceiptFlusher(receipts, messages);
        repository = ExecutionRepositoryTestFactory.create(session.getMapper(ExecutionMapper.class), objectMapper);
        // 回执挂点是包内可见字段：生产由 Spring 字段注入，这里用真实 bean 工厂 provider 注入。
        repository.mailReceipts = new StaticListableBeanFactory(Map.of("flusher", flusher))
                .getBeanProvider(MailReceiptFlusher.class);
        transactions = new TransactionTemplate(new DataSourceTransactionManager(database));

        new EmailRepositoryImpl(session.getMapper(EmailMapper.class)).save(Email.builder()
                .id(MAILBOX_ID).workflowExecutionId(SESSION_ID).recipientAgentId(AGENT_ID)
                .status(Email.STATUS_ACTIVE).build());
        messages.save(message(MESSAGE_ID, "检查点提交前的输入"));
        messages.save(message(ROLLBACK_MESSAGE_ID, "回滚用例的输入"));
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("检查点提交成功：回执同时落库，消息状态转为 CONSUMED")
    void committedCheckpointWritesReceipt() {
        transactions.execute(status -> {
            repository.save(execution(List.of(MESSAGE_ID)));
            return null;
        });

        assertEquals(List.of(MESSAGE_ID),
                List.copyOf(receipts.findMessageIdsWithReceipt(List.of(MESSAGE_ID))),
                "检查点提交后回执必须存在");
        assertEquals(EmailMessage.EMStatus.CONSUMED,
                messages.findById(MESSAGE_ID).orElseThrow().getStatus(),
                "展示态应被尽力清理为 CONSUMED");
    }

    @Test
    @DisplayName("检查点事务回滚：回执不存在、邮件仍是未投递（输入不丢）")
    void rolledBackCheckpointLeavesNoReceipt() {
        transactions.execute(status -> {
            repository.save(execution(List.of(ROLLBACK_MESSAGE_ID)));
            status.setRollbackOnly();
            return null;
        });

        assertTrue(receipts.findMessageIdsWithReceipt(List.of(ROLLBACK_MESSAGE_ID)).isEmpty(),
                "回滚后回执不得留下（否则这条输入永久丢失）");
        assertEquals(1L, messages.findUndeliveredByEmailIds(List.of(MAILBOX_ID)).stream()
                        .filter(message -> ROLLBACK_MESSAGE_ID == message.getId()).count(),
                "回滚后这条邮件必须仍是未投递，重启后能重新注入");
    }

    private EmailMessage message(long id, String content) {
        return EmailMessage.builder().id(id).emailId(MAILBOX_ID).senderId(8L).content(content)
                .status(EmailMessage.EMStatus.PENDING).createAt(Instant.now()).build();
    }

    /** 已投递登记用逗号文本：顺带验证属性解析容忍快照往返后的文本形态。 */
    private Execution execution(List<Long> delivered) {
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(ExecutionAttributes.SESSION_ID, String.valueOf(SESSION_ID));
        attributes.put(ExecutionAttributes.AGENT_ID, String.valueOf(AGENT_ID));
        attributes.put(ExecutionAttributes.DELIVERED_MAIL_IDS, String.join(",",
                delivered.stream().map(String::valueOf).toList()));
        List<Message> messages = List.of(UserMessageEntity.from("回执用例"));
        return Execution.builder()
                .id(String.valueOf(EXECUTION_ID))
                .executionState(ExecutionState.CREATED)
                .messages(new ArrayList<>(messages))
                .agentRequest(AgentRequest.builder().executionId(String.valueOf(EXECUTION_ID))
                        .messages(new ArrayList<>(messages))
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes).build())
                        .build())
                .build();
    }
}