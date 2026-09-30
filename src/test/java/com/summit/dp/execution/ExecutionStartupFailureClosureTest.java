package com.summit.dp.execution;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;

import java.time.LocalDateTime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

/**
 * 启动失败收口的状态安全边界（2026-09-30 改造）。
 *
 * <p>收口本身是一次**状态覆写**，所以真正要验证的不是「能写进去」，而是「不该写的绝不写」：
 * 已 COMPLETED 的执行不能被改写；SUSPENDED 更不能 —— 挂起是可恢复状态，误标失败会让
 * 「待恢复」入口直接消失，用户再也恢复不了那次执行。</p>
 */
class ExecutionStartupFailureClosureTest {

    private static final int CREATED = 0;
    private static final int RUNNING = 1;
    private static final int SUSPENDED = 2;
    private static final int COMPLETED = 3;
    private static final int FAILED = 4;

    private EmbeddedDatabase database;
    private ExecutionMapper mapper;
    private ExecutionRepositoryImpl repository;

    @BeforeEach
    void setup() throws Exception {
        database = new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2)
                .addScript("execution-status-schema.sql").build();
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(false);
        configuration.addMapper(ExecutionMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionFactory sessionFactory = factory.getObject();
        mapper = new SqlSessionTemplate(sessionFactory).getMapper(ExecutionMapper.class);
        repository = new ExecutionRepositoryImpl(mapper);
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    private void insert(long id, int status) {
        ExecutionPO row = new ExecutionPO();
        row.setId(id);
        row.setSessionId(11L);
        row.setStatus(status);
        mapper.insert(row);
    }

    @Test
    @DisplayName("只收口未终结的执行：CREATED / RUNNING 被标失败并写结束时间，其余一律不动")
    void closesOnlyUnfinishedExecutions() {
        insert(901L, CREATED);
        insert(902L, RUNNING);
        insert(903L, COMPLETED);
        insert(904L, SUSPENDED);
        insert(905L, FAILED);

        LocalDateTime completedAt = LocalDateTime.now();
        assertEquals(1, repository.markFailedIfUnfinished(901L, completedAt));
        assertEquals(1, repository.markFailedIfUnfinished(902L, completedAt));
        assertEquals(0, repository.markFailedIfUnfinished(903L, completedAt), "已完成的执行不得被改写");
        assertEquals(0, repository.markFailedIfUnfinished(904L, completedAt),
                "挂起可恢复：误标失败会让「待恢复」入口消失");
        assertEquals(0, repository.markFailedIfUnfinished(999L, completedAt), "行不存在时无操作");

        ExecutionPO closed = mapper.selectById(901L);
        assertEquals(FAILED, closed.getStatus());
        assertNotNull(closed.getCompletedAt(), "失败终态必须写结束时间（不用 updated_at 代替）");

        assertEquals(COMPLETED, mapper.selectById(903L).getStatus(), "已完成执行保持不变");
        assertNull(mapper.selectById(903L).getCompletedAt(), "完成时间不得被收口覆盖");

        assertEquals(SUSPENDED, mapper.selectById(904L).getStatus(), "挂起状态保持不变");
        assertNull(mapper.selectById(904L).getCompletedAt(), "挂起不是终态，不得写结束时间");
    }

    @Test
    @DisplayName("重复收口幂等：第二次命中 0 行，不会把结束时间往后推")
    void repeatedClosureIsIdempotent() {
        insert(911L, CREATED);

        assertEquals(1, repository.markFailedIfUnfinished(911L, LocalDateTime.now()));
        LocalDateTime firstCompletedAt = mapper.selectById(911L).getCompletedAt();
        assertEquals(0, repository.markFailedIfUnfinished(911L, LocalDateTime.now().plusSeconds(60)));

        assertEquals(firstCompletedAt, mapper.selectById(911L).getCompletedAt(),
                "重复收口不得改写已写入的结束时间");
    }
}
