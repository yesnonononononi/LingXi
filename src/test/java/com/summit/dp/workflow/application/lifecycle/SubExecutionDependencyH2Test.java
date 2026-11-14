package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.*;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionPO;
import com.summit.dp.session.infrastructure.persistence.repository.SessionRepositoryImpl;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.support.SqlCaptureInterceptor;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 「还有没有未完成的子执行」的两级证据判定：真 H2 + 真仓储。
 *
 * <p>这个问题仍然只该有一个答案：收尾时要靠它决定「继续等」还是「可以收尾」，通道体系也要靠它
 * 回答「有没有未完结的异步依赖」。恢复准入不再问这个问题 —— 子代理终态本身就是唤醒理由，
 * 用「兄弟子会话还在跑」去拦唤醒，只会把已到位的交付压到最后一个子会话结束。</p>
 */
class SubExecutionDependencyH2Test {

    private static final long ROOT_SESSION_ID = 700L;
    private static final long CHILD_SESSION_ID = 701L;
    private static final long ROOT_EXECUTION_ID = 900L;
    private static final long CHILD_EXECUTION_ID = 901L;

    private H2TestDatabase database;
    private SqlCaptureInterceptor capture;
    private SessionMapper sessionMapper;
    private ExecutionMapper executionMapper;
    private SessionExecutionRegistry registry;
    private SubExecutionDependency dependency;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("SubExecutionDependencyH2Test");
        capture = new SqlCaptureInterceptor();
        SqlSessionFactory factory = database.sessionFactory(SessionMapper.class, ExecutionMapper.class);
        factory.getConfiguration().addInterceptor(capture);
        sessionMapper = H2TestDatabase.sqlSession(factory).getMapper(SessionMapper.class);
        executionMapper = H2TestDatabase.sqlSession(factory).getMapper(ExecutionMapper.class);

        SessionRepositoryImpl sessions = new SessionRepositoryImpl(sessionMapper);
        ExecutionRepository executions = new ExecutionRepositoryImpl(executionMapper);
        registry = new SessionExecutionRegistry();
        dependency = new SubExecutionDependency(registry, sessions, executions);

        insertSession(ROOT_SESSION_ID, Session.ROOT_SESSION_ID);
        insertSession(CHILD_SESSION_ID, ROOT_SESSION_ID);
        capture.clear();
    }

    @AfterEach
    void shutdown() {
        if (database != null) {
            database.shutdown();
        }
    }

    @Test
    @DisplayName("子执行未终结：判定还有依赖，收尾必须继续等")
    void unfinishedChildIsStillADependency() {
        insertExecution(CHILD_EXECUTION_ID, CHILD_SESSION_ID, ExecutionStatusCodes.RUNNING);

        assertTrue(dependency.hasUnfinishedSubExecution(execution(null)),
                "子代理还在跑时，根执行收尾必须继续等待");
    }

    @Test
    @DisplayName("子执行已终结：不再算依赖，根执行可以收尾")
    void finishedChildIsNoLongerADependency() {
        insertExecution(CHILD_EXECUTION_ID, CHILD_SESSION_ID, ExecutionStatusCodes.COMPLETED);

        assertFalse(dependency.hasUnfinishedSubExecution(execution(null)),
                "子代理交付完成后根执行必须能收尾");
    }

    @Test
    @DisplayName("进程内登记表命中即判定，不再查库（失序会让每次收尾都多两次查询）")
    void registryHitShortCircuitsDatabase() {
        // 排队登记（尚无父槽位）：注册表命中后不得再查库。
        registry.registerPendingChild(ROOT_SESSION_ID, CHILD_SESSION_ID, String.valueOf(CHILD_EXECUTION_ID), null);
        capture.clear();

        assertTrue(dependency.hasUnfinishedSubExecution(execution(null)));
        assertTrue(capture.queries().isEmpty(), "登记表已给出答案，不该再查会话树: " + capture.queries());
    }

    @Test
    @DisplayName("登记表为空（重启后）走持久化兜底：查会话树 + 未终结执行")
    void emptyRegistryFallsBackToPersistedState() {
        insertExecution(CHILD_EXECUTION_ID, CHILD_SESSION_ID, ExecutionStatusCodes.CREATED);
        capture.clear();

        assertTrue(dependency.hasUnfinishedSubExecution(execution(null)));
        String sql = String.join(" | ", capture.queries().stream().map(SqlCaptureInterceptor::normalize).toList());
        assertTrue(sql.contains("session"), "必须先取会话树: " + sql);
        assertTrue(sql.contains("execution"), "再按未终结执行判定: " + sql);
    }

    @Test
    @DisplayName("执行自身就是子执行：不把它自己的父当成待等待对象")
    void childExecutionHasNoDependency() {
        insertExecution(CHILD_EXECUTION_ID, CHILD_SESSION_ID, ExecutionStatusCodes.RUNNING);

        Map<String, Object> attributes = new HashMap<>();
        attributes.put(ExecutionAttributes.ROOT_EXECUTION_ID, ROOT_EXECUTION_ID);
        Execution child = execution(attributes);

        assertFalse(dependency.hasUnfinishedSubExecution(child),
                "子执行等的是自己的父，不是别人，否则永远收不了尾");
    }

    private void insertSession(long id, long rootSessionId) {
        Instant now = Instant.parse("2026-10-01T00:00:00Z");
        sessionMapper.insert(SessionPO.builder().id(id).name("生命周期门禁用例")
                .rootSessionId(rootSessionId).createTime(now).updateTime(now).build());
    }

    private void insertExecution(long id, long sessionId, int status) {
        ExecutionPO row = new ExecutionPO();
        row.setId(id);
        row.setSessionId(sessionId);
        row.setStatus(status);
        executionMapper.insert(row);
    }

    private static Execution execution(Map<String, Object> extraAttributes) {
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID));
        if (extraAttributes != null) {
            attributes.putAll(extraAttributes);
        }
        String executionId = String.valueOf(ROOT_EXECUTION_ID);
        return Execution.builder().id(executionId).agentId("chatAgent")
                .agentRequest(AgentRequest.builder().executionId(executionId)
                        .contextSpec(ContextSpec.builder().context(List.of(UserMessageEntity.from("hi"))).build())
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes).build())
                        .build())
                .executionState(ExecutionState.SUSPENDED).build();
    }
}
