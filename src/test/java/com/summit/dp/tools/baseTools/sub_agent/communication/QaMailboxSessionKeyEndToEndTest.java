package com.summit.dp.tools.baseTools.sub_agent.communication;

import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.Message;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopMessages;
import com.summit.core.tool.ToolExecution;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.email.application.service.impl.EmailServiceImpl;
import com.summit.dp.email.application.vo.EmailMessageVO;
import com.summit.dp.email.domain.model.Email;
import com.summit.dp.email.domain.model.EmailMessage;
import com.summit.dp.email.domain.repository.EmailMessageRepository;
import com.summit.dp.email.domain.repository.EmailRepository;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMapper;
import com.summit.dp.email.infrastructure.persistence.mapper.EmailMessageMapper;
import com.summit.dp.email.infrastructure.repository.EmailMessageRepositoryImpl;
import com.summit.dp.email.infrastructure.repository.EmailRepositoryImpl;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import com.summit.dp.tools.baseTools.sub_agent.delegation.SubAgentWaitInterceptor;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

/**
 * 独立验证（QA）：邮箱业务键由「协作根执行 id」提升为「协作根会话 id」的<b>端到端</b>证据。
 *
 * <p>与既有单元测试的分工：既有单元测试用 mock 校验「传了哪个键」。本测试把
 * <b>真实</b> {@link EmailServiceImpl}（H2 镜像 email / email_message 两表）与
 * <b>真实</b> {@link SendMailToAgentTool}（投递侧）、<b>真实</b> {@link AgenticLoopInterceptor}
 * （消费侧）、<b>真实</b> {@link SubAgentWaitInterceptor}（收尾判定侧的只读判据）接在一起，
 * 证明三处的键在真实落库 / 回查语义下确实指向同一把邮箱，而不是各说各话。</p>
 *
 * <p>核心风险点（停止后迟到邮件）：子执行发信与「下一轮全新根执行」取信，执行 id 不同，
 * 但根会话 id 相同 —— 只要键用的是根会话 id，邮件就一定被下一轮消费；若回退成执行 id，
 * 本测试立刻变红。</p>
 */
class QaMailboxSessionKeyEndToEndTest {

    private static final long ROOT_SESSION_ID = 7001L;
    private static final long CHILD_SESSION_ID = 7002L;
    private static final long ROOT_EXECUTION_ID = 8800L;
    private static final long ROOT_AGENT_ID = 100L;
    private static final long CHILD_AGENT_ID = 8L;

    private EmbeddedDatabase database;
    private EmailMapper emailMapper;
    private EmailMessageMapper messageMapper;
    private EmailRepository emailRepository;
    private EmailMessageRepository messageRepository;
    private EmailServiceImpl service;

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final ExecutionResumeCoordinator resumeCoordinator = mock(ExecutionResumeCoordinator.class);

    @BeforeEach
    void setup() throws Exception {
        database = new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2)
                .addScript("email-schema.sql").build();
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(true);
        configuration.addMapper(EmailMapper.class);
        configuration.addMapper(EmailMessageMapper.class);
        MybatisPlusInterceptor interceptor = new MybatisPlusInterceptor();
        interceptor.addInnerInterceptor(new PaginationInnerInterceptor(DbType.H2));
        configuration.addInterceptor(interceptor);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionFactory sessionFactory = factory.getObject();
        SqlSessionTemplate session = new SqlSessionTemplate(sessionFactory);
        emailMapper = session.getMapper(EmailMapper.class);
        messageMapper = session.getMapper(EmailMessageMapper.class);
        emailRepository = new EmailRepositoryImpl(emailMapper);
        messageRepository = new EmailMessageRepositoryImpl(messageMapper);
        service = new EmailServiceImpl(emailRepository, messageRepository);
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("投递侧同键：根执行取自身会话、子执行取 ROOT_SESSION_ID —— 都落到协作根会话这一把邮箱键")
    void rootAndChildProducersShareRootSessionMailboxKey() {
        SendMailToAgentTool tool = new SendMailToAgentTool(objectMapper, service, resumeCoordinator);

        // 根执行发信：只有 SESSION_ID（= 根会话），没有 ROOT_SESSION_ID。
        assertTrue(tool.execute(execution("900", Map.of(
                ExecutionAttributes.AGENT_ID, String.valueOf(ROOT_AGENT_ID),
                ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID)),
                "{\"toAgentId\":7,\"mailContent\":\"根发给子\"}")).isSuccess());

        // 子执行发信：SESSION_ID 是子会话，ROOT_SESSION_ID 才是协作根会话。
        assertTrue(tool.execute(execution("1234", Map.of(
                ExecutionAttributes.AGENT_ID, String.valueOf(CHILD_AGENT_ID),
                ExecutionAttributes.SESSION_ID, String.valueOf(CHILD_SESSION_ID),
                ExecutionAttributes.ROOT_SESSION_ID, String.valueOf(ROOT_SESSION_ID),
                ExecutionAttributes.ROOT_EXECUTION_ID, String.valueOf(ROOT_EXECUTION_ID)),
                "{\"toAgentId\":100,\"mailContent\":\"子发回根\"}")).isSuccess());

        // 两个邮箱都挂在「协作根会话 7001」下：一个收件 7，一个收件 100。
        assertEquals(2L, emailMapper.selectCount(null).longValue(), "两封信落在根会话下的两个角色邮箱（收件 7 / 收件 100）");
        assertTrue(emailRepository.findByBusinessKey(ROOT_SESSION_ID, 7L).isPresent(),
                "根发信键 = 自身会话 id（即协作根会话 id）");
        assertTrue(emailRepository.findByBusinessKey(ROOT_SESSION_ID, ROOT_AGENT_ID).isPresent(),
                "子发信键 = ROOT_SESSION_ID（协作根会话 id），而非子会话 id");

        // 反证：绝不存在以「执行 id」或「子会话 id」为键的邮箱。
        assertTrue(emailRepository.findByBusinessKey(ROOT_EXECUTION_ID, 7L).isEmpty(),
                "邮箱键不得退化为执行 id");
        assertTrue(emailRepository.findByBusinessKey(ROOT_EXECUTION_ID, ROOT_AGENT_ID).isEmpty());
        assertTrue(emailRepository.findByBusinessKey(CHILD_SESSION_ID, ROOT_AGENT_ID).isEmpty(),
                "邮箱键不得是子会话 id");
    }

    @Test
    @DisplayName("【核心风险】停止后迟到邮件：根会话键落箱，下一轮全新根执行（新执行 id）仍被消费；三处同键")
    void lateMailAfterRootStopIsConsumedByNextRoundUnderRootSessionKey() {
        SendMailToAgentTool tool = new SendMailToAgentTool(objectMapper, service, resumeCoordinator);

        // 1) 根执行 E1 已停止（不再消费）。子执行此刻发来迟到邮件 —— 键 = 根会话；唤醒目标 = 根执行 E1。
        assertTrue(tool.execute(execution("1234", Map.of(
                ExecutionAttributes.AGENT_ID, String.valueOf(CHILD_AGENT_ID),
                ExecutionAttributes.SESSION_ID, String.valueOf(CHILD_SESSION_ID),
                ExecutionAttributes.ROOT_SESSION_ID, String.valueOf(ROOT_SESSION_ID),
                ExecutionAttributes.ROOT_EXECUTION_ID, String.valueOf(ROOT_EXECUTION_ID)),
                "{\"toAgentId\":100,\"mailContent\":\"交付通知\"}")).isSuccess());
        verify(resumeCoordinator).accept(ROOT_EXECUTION_ID);

        // 2) 收尾判定侧（只读）与投递侧同键：hasPending(根会话, 根角色) 必须为真。
        assertTrue(service.hasPending(ROOT_SESSION_ID, ROOT_AGENT_ID), "收尾判定侧必须用根会话键看到这封信");
        // 只读：连判两次，消息仍是 PENDING，绝不被判定掉。
        assertTrue(service.hasPending(ROOT_SESSION_ID, ROOT_AGENT_ID));
        Long messageId = emailRepository.findByBusinessKey(ROOT_SESSION_ID, ROOT_AGENT_ID)
                .flatMap(mail -> messageRepository.findPendingByEmailIds(List.of(mail.getId())).stream().findFirst())
                .map(EmailMessage::getId).orElseThrow();
        assertEquals(EmailMessage.EMStatus.PENDING,
                messageRepository.findById(messageId).orElseThrow().getStatus(),
                "hasPending 是只读判据，不得把消息消费掉");

        // 3) 收尾驻留判定用同一把键：真实 SubAgentWaitInterceptor 在无子执行时因「有未处理输入」驻留。
        SessionExecutionRegistry emptyRegistry = new SessionExecutionRegistry();
        SubAgentWaitInterceptor wait = new SubAgentWaitInterceptor(emptyRegistry, service, resumeCoordinator);
        assertFalse(wait.onBeforeComplete(rootContext("E1", ROOT_SESSION_ID, ROOT_AGENT_ID)).shouldContinue(),
                "收尾判定与投递同键：有未处理输入时必须驻留，不得提前 COMPLETED");

        // 4) 下一轮全新根执行 E2：执行 id 与 E1 不同，会话 id 相同 —— 消费侧必须仍命中同一把邮箱。
        List<Message> appended = new ArrayList<>();
        AgenticLoopInterceptor consumer = new AgenticLoopInterceptor(service);
        consumer.onBeforeModelInvoke(rootContext("E2", ROOT_SESSION_ID, ROOT_AGENT_ID));

        // 5) 消费之后无 PENDING。
        assertFalse(service.hasPending(ROOT_SESSION_ID, ROOT_AGENT_ID), "迟到邮件已被下一轮消费");
    }

    @Test
    @DisplayName("消费侧真正取回正文：下一轮模型上下文被追加该邮件的用户消息")
    void nextRoundActuallyReceivesTheMailContent() {
        SendMailToAgentTool tool = new SendMailToAgentTool(objectMapper, service, resumeCoordinator);
        assertTrue(tool.execute(execution("1234", Map.of(
                ExecutionAttributes.AGENT_ID, String.valueOf(CHILD_AGENT_ID),
                ExecutionAttributes.SESSION_ID, String.valueOf(CHILD_SESSION_ID),
                ExecutionAttributes.ROOT_SESSION_ID, String.valueOf(ROOT_SESSION_ID),
                ExecutionAttributes.ROOT_EXECUTION_ID, String.valueOf(ROOT_EXECUTION_ID)),
                "{\"toAgentId\":100,\"mailContent\":\"构建产物已就绪\"}")).isSuccess());

        List<Message> appended = new ArrayList<>();
        AgenticLoopInterceptor consumer = new AgenticLoopInterceptor(service);
        consumer.onBeforeModelInvoke(loopContext("E2", ROOT_SESSION_ID, ROOT_AGENT_ID, appended));

        assertEquals(1, appended.size(), "取信钩子应把待处理邮件作为一条用户消息注入");
        assertTrue(appended.getFirst().text().contains("构建产物已就绪"),
                "实际注入的上下文应包含邮件正文，实际=" + appended.getFirst().text());
        assertFalse(service.hasPending(ROOT_SESSION_ID, ROOT_AGENT_ID));
    }

    private static ToolExecution execution(String executionId, Map<String, Object> attributes, String args) {
        return ToolExecution.builder()
                .executionId(executionId)
                .attributes(attributes)
                .args(args)
                .build();
    }

    private static LoopContext rootContext(String executionId, long sessionId, long agentId) {
        return loopContext(executionId, sessionId, agentId, new ArrayList<>());
    }

    private static LoopContext loopContext(String executionId, long sessionId, long agentId, List<Message> appended) {
        Execution execution = Execution.builder()
                .id(executionId)
                .agentRequest(AgentRequest.builder()
                        .workspaceSpec(TEST_WORKSPACE)
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(Map.of(
                                ExecutionAttributes.SESSION_ID, String.valueOf(sessionId),
                                ExecutionAttributes.AGENT_ID, String.valueOf(agentId))).build())
                        .build())
                .build();
        LoopMessages loopMessages = LoopMessages.builder().execution(execution).build();
        return new LoopContext(loopMessages, new ExecutionControlSignal(executionId), 0, appended::addAll);
    }

    private static final WorkspaceSpec TEST_WORKSPACE = new WorkspaceSpec() {
        @Override
        public String provider() {
            return "test";
        }

        @Override
        public String workDir() {
            return "D:/tmp";
        }
    };
}
