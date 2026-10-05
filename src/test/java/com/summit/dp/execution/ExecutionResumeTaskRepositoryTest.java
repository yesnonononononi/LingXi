package com.summit.dp.execution;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.execution.domain.model.ExecutionResumeTask;
import com.summit.dp.execution.domain.model.ResumeTaskState;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionResumeTaskMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionResumeTaskPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionResumeTaskRepositoryImpl;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 恢复意图表（{@code execution_resume_task}）的持久化回归。
 *
 * <p>这些断言守护的是两条硬约束，都无法用 mock 验证 —— 必须真打一次 H2：</p>
 * <ol>
 *   <li><b>同执行同代际最多一条任务</b>：唯一约束让「重复落定同一张卡片」和「审批重试」
 *       不会各插一条互相作废的任务；</li>
 *   <li><b>状态写入按 version 条件</b>：迟到的恢复状态不能覆盖别人已经改过的行 ——
 *       这正是「stop 已落库 CANCELLED 却被恢复改回去」的事故点。</li>
 * </ol>
 */
class ExecutionResumeTaskRepositoryTest {

    private static final long EXECUTION_ID = 1000L;

    private EmbeddedDatabase database;
    private ExecutionResumeTaskRepository repository;
    private ExecutionResumeTaskMapper taskMapper;

    @BeforeEach
    void setup() throws Exception {
        database = new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2)
                .addScript("execution-resume-task-schema.sql").build();
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(true);
        configuration.addMapper(ExecutionResumeTaskMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionFactory sessionFactory = factory.getObject();
        SqlSessionTemplate session = new SqlSessionTemplate(sessionFactory);
        taskMapper = session.getMapper(ExecutionResumeTaskMapper.class);
        repository = new ExecutionResumeTaskRepositoryImpl(taskMapper);
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("受理：同执行同代际只落一条，重复受理返回既有任务而不新建")
    void enqueueIsIdempotentPerExecutionAndGeneration() {
        ExecutionResumeTask first = repository.enqueue(EXECUTION_ID, 3L, Instant.now());
        assertNotNull(first.getId());

        ExecutionResumeTask again = repository.enqueue(EXECUTION_ID, 3L, Instant.now());

        assertEquals(first.getId(), again.getId(), "重复受理必须复用同一行");
        assertEquals(1, repository.findByExecutionId(EXECUTION_ID).size());
    }

    @Test
    @DisplayName("受理：换一次挂起边界（代际 +1）就是新任务，两条互不覆盖")
    void newGenerationCreatesSeparateTask() {
        repository.enqueue(EXECUTION_ID, 3L, Instant.now());
        ExecutionResumeTask next = repository.enqueue(EXECUTION_ID, 4L, Instant.now());

        assertEquals(4L, next.getGeneration());
        assertEquals(2, repository.findByExecutionId(EXECUTION_ID).size(),
                "两个挂起边界各有各的恢复意图");
    }

    @Test
    @DisplayName("领取：条件更新把 READY 置为 CLAIMED 并累加尝试次数")
    void claimMovesReadyToClaimedAndCountsAttempt() {
        ExecutionResumeTask task = repository.enqueue(EXECUTION_ID, 3L, Instant.now());

        assertTrue(repository.claim(task, Instant.now()));

        ExecutionResumeTask stored = repository.findById(task.getId()).orElseThrow();
        assertEquals(ResumeTaskState.CLAIMED, stored.getState());
        assertEquals(1, stored.getAttempts());
    }

    @Test
    @DisplayName("领取：同一条任务只能被领取一次（第二个 worker 必须让位）")
    void secondClaimOnSameTaskYields() {
        ExecutionResumeTask task = repository.enqueue(EXECUTION_ID, 3L, Instant.now());
        assertTrue(repository.claim(task, Instant.now()));

        // 另一个 worker 拿着自己读到的旧快照来领：version 已变，条件更新命中 0 行
        ExecutionResumeTask stale = repository.findById(task.getId()).orElseThrow();
        stale.acceptPersistedVersion(task.getVersion() - 1);

        assertFalse(repository.claim(stale, Instant.now()), "已被领走时不得让两条 worker 同时跑 loop");
    }

    @Test
    @DisplayName("状态写入：version 过期时命中 0 行并返回 false（迟到的恢复不得覆盖）")
    void updateStateFailsWhenVersionIsStale() {
        ExecutionResumeTask task = repository.enqueue(EXECUTION_ID, 3L, Instant.now());
        task.fail("第一次失败", null);
        assertTrue(repository.updateState(task), "首次写入应成功");

        // 另一个 worker 仍持旧版本
        ExecutionResumeTask stale = repository.findById(task.getId()).orElseThrow();
        stale.acceptPersistedVersion(1L);
        stale.succeed();

        assertFalse(repository.updateState(stale), "version 过期必须让位而不是覆盖");
        assertEquals(ResumeTaskState.FAILED, repository.findById(task.getId()).orElseThrow().getState(),
                "行状态必须仍是先到者写下的");
    }

    @Test
    @DisplayName("可派发筛选：READY 与已到点的 FAILED 进，退避未到点的 FAILED 不进")
    void listDispatchableRespectsBackoff() {
        Instant now = Instant.now();
        ExecutionResumeTask ready = repository.enqueue(EXECUTION_ID, 1L, now);
        ExecutionResumeTask waiting = repository.enqueue(EXECUTION_ID, 2L, now);
        waiting.fail("恢复失败", now.plusSeconds(600));
        repository.updateState(waiting);
        ExecutionResumeTask due = repository.enqueue(EXECUTION_ID, 3L, now);
        due.fail("恢复失败", now.minusSeconds(1));
        repository.updateState(due);

        List<ExecutionResumeTask> dispatchable = repository.listDispatchable(now, 50);

        List<Long> ids = dispatchable.stream().map(ExecutionResumeTask::getId).toList();
        assertTrue(ids.contains(ready.getId()), "READY 必须可派发");
        assertTrue(ids.contains(due.getId()), "退避已到点的 FAILED 必须可派发");
        assertFalse(ids.contains(waiting.getId()), "退避未到点不能派发，否则退避形同虚设");
    }

    @Test
    @DisplayName("可派发筛选：CLAIMED 与 EXHAUSTED / NEEDS_MANUAL 一律不进可派发集合（真库 SQL 层不变量）")
    void listDispatchableExcludesClaimedAndTerminalStates() {
        Instant now = Instant.now();
        ExecutionResumeTask ready = repository.enqueue(EXECUTION_ID, 1L, now);
        // CLAIMED 是真实可能存在的状态（worker 领取后崩溃）：它绝不能被 listDispatchable 选出来。
        Long claimedId = insertTask(2L, ResumeTaskState.CLAIMED, now);
        Long exhaustedId = insertTask(3L, ResumeTaskState.EXHAUSTED, now);
        Long needsManualId = insertTask(4L, ResumeTaskState.NEEDS_MANUAL, now);

        List<Long> ids = repository.listDispatchable(now, 50).stream()
                .map(ExecutionResumeTask::getId).toList();

        assertTrue(ids.contains(ready.getId()), "READY 必须可派发");
        assertFalse(ids.contains(claimedId), "CLAIMED 必须查不出来，否则崩溃后会被重复派发");
        assertFalse(ids.contains(exhaustedId), "EXHAUSTED 已达上限，绝不能被反复选中");
        assertFalse(ids.contains(needsManualId), "NEEDS_MANUAL 禁止自动重跑");
    }

    @Test
    @DisplayName("遗留 CLAIMED 查询：按状态等值取回，供启动分流使用")
    void listClaimedReturnsOnlyClaimedRows() {
        Instant now = Instant.now();
        Long claimedId = insertTask(1L, ResumeTaskState.CLAIMED, now);
        insertTask(2L, ResumeTaskState.READY, now);
        insertTask(3L, ResumeTaskState.SUPERSEDED, now);

        List<ExecutionResumeTask> claimed = repository.listClaimed(50);

        assertEquals(1, claimed.size(), "只回 CLAIMED 行");
        assertEquals(claimedId, claimed.getFirst().getId());
        assertEquals(ResumeTaskState.CLAIMED, claimed.getFirst().getState());
    }

    @Test
    @DisplayName("回收：EXHAUSTED / NEEDS_MANUAL 不属于「已明确结束」，不得被 TTL 清掉")
    void purgeKeepsExhaustedAndManualTasks() {
        Instant now = Instant.now();
        Long exhaustedId = insertTask(1L, ResumeTaskState.EXHAUSTED, now.minusSeconds(7200));
        Long needsManualId = insertTask(2L, ResumeTaskState.NEEDS_MANUAL, now.minusSeconds(7200));

        repository.purgeFinishedBefore(now.minusSeconds(3600));

        assertTrue(repository.findById(exhaustedId).isPresent(), "耗尽的恢复意图要留给用户手工触发");
        assertTrue(repository.findById(needsManualId).isPresent(), "待人工的恢复意图不能被回收");
    }

    @Test
    @DisplayName("未决任务筛选：只回未结束的任务，已成功/已作废的不再参与")
    void listLiveExcludesFinishedTasks() {
        ExecutionResumeTask done = repository.enqueue(EXECUTION_ID, 1L, Instant.now());
        done.succeed();
        repository.updateState(done);
        ExecutionResumeTask voided = repository.enqueue(EXECUTION_ID, 2L, Instant.now());
        voided.supersede();
        repository.updateState(voided);
        repository.enqueue(EXECUTION_ID, 3L, Instant.now());

        List<ExecutionResumeTask> live = repository.listLiveByExecution(EXECUTION_ID);

        assertEquals(1, live.size(), "只有 READY 那条算未结束");
        assertEquals(3L, live.getFirst().getGeneration());
    }

    @Test
    @DisplayName("状态写入刷新 updated_at：回收窗口按「最后一次状态变化」算，不是按创建时刻")
    void stateWriteRefreshesUpdatedAt() {
        Instant created = Instant.now().minusSeconds(7200);
        ExecutionResumeTask task = repository.enqueue(EXECUTION_ID, 1L, created);
        task.succeed();
        repository.updateState(task);

        ExecutionResumeTask stored = repository.findById(task.getId()).orElseThrow();
        assertTrue(stored.getUpdatedAt().isAfter(created.plusSeconds(3600)),
                "刚结束的任务必须被刷新到当下，否则重试多轮的任务一结束就被回收窗口扫掉");
    }

    @Test
    @DisplayName("回收：只删窗口之前已结束的任务，未结束的绝不能被清掉")
    void purgeOnlyRemovesOldFinishedTasks() {
        Instant now = Instant.now();
        // 铺历史终态行而不是走领域方法：领域方法一律把 updated_at 打到当下，
        // 造不出「两小时前就结束」的行，而回收窗口要测的正是这个时间差。
        Long expired = insertTask(1L, ResumeTaskState.SUCCEEDED, now.minusSeconds(7200));
        insertTask(2L, ResumeTaskState.SUPERSEDED, now.minusSeconds(7200));
        Long inWindow = insertTask(3L, ResumeTaskState.SUCCEEDED, now.minusSeconds(600));
        Long unfinished = insertTask(4L, ResumeTaskState.FAILED, now.minusSeconds(7200));

        assertEquals(2, repository.purgeFinishedBefore(now.minusSeconds(3600)));

        assertTrue(repository.findById(expired).isEmpty(), "窗口前的已结束任务应被回收");
        assertTrue(repository.findById(inWindow).isPresent(), "窗口内的不能删");
        assertTrue(repository.findById(unfinished).isPresent(), "未结束的任务再老也不能删，否则恢复意图凭空消失");
    }

    @Test
    @DisplayName("查不到行时返回空而不是抛错：恢复是旁路动作，不能拖垮主链路")
    void missingRowReturnsEmpty() {
        Optional<ExecutionResumeTask> missing = repository.findById(999999L);

        assertTrue(missing.isEmpty());
        assertTrue(repository.findByExecutionAndGeneration(EXECUTION_ID, 99L).isEmpty());
        assertNull(repository.findById(null).orElse(null));
    }

    /** 直插一行指定状态与更新时刻的任务，返回其 ID。 */
    private Long insertTask(long generation, ResumeTaskState state, Instant updatedAt) {
        LocalDateTime time = LocalDateTime.ofInstant(updatedAt, ZoneId.systemDefault());
        ExecutionResumeTaskPO row = ExecutionResumeTaskPO.builder()
                .executionId(EXECUTION_ID)
                .generation(generation)
                .state(state.dbValue())
                .attempts(0)
                .version(1L)
                .createdAt(time)
                .updatedAt(time)
                .build();
        assertEquals(1, taskMapper.insert(row));
        return row.getId();
    }
}
