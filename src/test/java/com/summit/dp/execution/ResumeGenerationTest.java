package com.summit.dp.execution;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.execution.infrastructure.repository.LocalExecutionRepository;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;

/**
 * 恢复代际（{@code execution.resume_generation}）的递增规则回归 —— 架构 §8.3 的易错点。
 *
 * <p><b>规则</b>：只在「行前态不是 SUSPENDED 且本次落为 SUSPENDED」时 +1。
 * 同态重复 save、重复暂停通知、同一命令重试都<b>不</b>递增。</p>
 *
 * <p><b>为什么这条规则错了会静默坏事</b>：代际是恢复任务判过期的锚点。误递增会让
 * 「已受理的恢复任务」被判成 superseded 而永远不派发（用户点了批准，执行再也不动）；
 * 漏递增会让上一次挂起边界的旧意图作用在新边界上（loop 拿到没写回结论的槽位）。</p>
 *
 * <p>用真实 H2 驱动而不是 mock：代际计算依赖「同一次带 version 条件的事务读」，
 * mock 掉 mapper 就等于把被测的规则本身也 mock 掉了。</p>
 */
class ResumeGenerationTest {

    private static final long SESSION_ID = 800L;
    private static final long EXECUTION_ID = 1000L;

    private EmbeddedDatabase database;
    private ExecutionMapper mapper;
    private LocalExecutionRepository repository;

    @BeforeEach
    void setup() throws Exception {
        database = new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2)
                .addScript("execution-status-schema.sql").build();
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(true);
        configuration.addMapper(ExecutionMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionFactory sessionFactory = factory.getObject();
        SqlSessionTemplate session = new SqlSessionTemplate(sessionFactory);
        mapper = session.getMapper(ExecutionMapper.class);
        repository = ExecutionRepositoryTestFactory.create(mapper, new ObjectMapper());
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    /**
     * 建行：{@code LocalExecutionRepository} 只在「状态 CREATED 且行不存在」时插入，
     * 后续保存一律走带 version 条件的更新。先建行，后续用例才能像真实执行那样演进状态。
     */
    private void createRow() {
        repository.save(execution(ExecutionState.CREATED));
    }

    @Test
    @DisplayName("首次转入 SUSPENDED：代际 0 → 1")
    void firstSuspensionIncrementsGeneration() {
        createRow();
        repository.save(execution(ExecutionState.RUNNING));
        assertEquals(0L, currentGeneration(), "运行中还没有恢复边界");

        repository.save(execution(ExecutionState.SUSPENDED));

        assertEquals(1L, currentGeneration());
    }

    @Test
    @DisplayName("同态重复 save（SUSPENDED → SUSPENDED）：代际不得递增")
    void repeatedSuspendedSaveDoesNotIncrement() {
        createRow();
        repository.save(execution(ExecutionState.RUNNING));
        repository.save(execution(ExecutionState.SUSPENDED));
        assertEquals(1L, currentGeneration());

        // 暂停检查点会被审批 / 取消路径反复重写；每次都是 SUSPENDED → SUSPENDED
        repository.save(execution(ExecutionState.SUSPENDED));
        repository.save(execution(ExecutionState.SUSPENDED));

        assertEquals(1L, currentGeneration(), "同态重复 save 不是新的恢复边界");
    }

    @Test
    @DisplayName("恢复后再次挂起（SUSPENDED → RUNNING → SUSPENDED）：代际 1 → 2")
    void secondSuspensionAfterResumeOpensNewBoundary() {
        createRow();
        repository.save(execution(ExecutionState.RUNNING));
        repository.save(execution(ExecutionState.SUSPENDED));
        repository.save(execution(ExecutionState.RUNNING));
        assertEquals(1L, currentGeneration(), "恢复运行本身不是新的恢复边界");

        repository.save(execution(ExecutionState.SUSPENDED));

        assertEquals(2L, currentGeneration(), "第二次挂起是新边界，旧的恢复任务据此作废");
    }

    @Test
    @DisplayName("COMMAND 的 RUNNING → SUSPENDED：算一次新的恢复边界")
    void commandRunningToSuspendedOpensNewBoundary() {
        // 命令审批 T1 先把执行落回 RUNNING 执行命令，T2 之后重新挂起等下一轮。
        // 若把 RUNNING 排除在边界外，这次挂起就不会递增，上一挂起点的旧任务会复活。
        createRow();
        repository.save(execution(ExecutionState.RUNNING));
        repository.save(execution(ExecutionState.SUSPENDED));
        repository.save(execution(ExecutionState.RUNNING));
        repository.save(execution(ExecutionState.RUNNING));
        repository.save(execution(ExecutionState.SUSPENDED));

        assertEquals(2L, currentGeneration());
    }

    @Test
    @DisplayName("非挂起状态的重复 save：代际恒为 0")
    void nonSuspendedSavesNeverTouchGeneration() {
        createRow();
        repository.save(execution(ExecutionState.RUNNING));
        repository.save(execution(ExecutionState.RUNNING));

        assertEquals(0L, currentGeneration(), "没有挂起就没有恢复边界");
    }

    @Test
    @DisplayName("代际只随挂起边界走，findResumeGeneration 与行内列一致")
    void findResumeGenerationMatchesStoredColumn() {
        ExecutionRepositoryImpl reader = new ExecutionRepositoryImpl(mapper);
        createRow();
        assertEquals(0L, reader.findResumeGeneration(EXECUTION_ID));

        repository.save(execution(ExecutionState.RUNNING));
        repository.save(execution(ExecutionState.SUSPENDED));
        assertEquals(1L, reader.findResumeGeneration(EXECUTION_ID));

        // 行不存在返回 0：没有这条执行对恢复而言等价于「没有任何未完成的恢复边界」
        assertEquals(0L, reader.findResumeGeneration(999999L));
    }

    private long currentGeneration() {
        return new ExecutionRepositoryImpl(mapper).findResumeGeneration(EXECUTION_ID);
    }

    private Execution execution(ExecutionState state) {
        return Execution.builder().id(String.valueOf(EXECUTION_ID)).executionState(state)
                .agentRequest(AgentRequest.builder()
                        .runtimeParameters(AgentRuntimeParameters.builder()
                                .attributes(Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(SESSION_ID)))
                                .build())
                        .build())
                .build();
    }
}
