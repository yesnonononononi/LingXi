package com.summit.dp.workflow.pending;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.shared.persistence.MyBatisTypeHandlers;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import com.summit.dp.workflow.application.chat.ExecutionContext;
import com.summit.dp.workflow.application.chat.PreparedChatExecutor;
import com.summit.dp.workflow.application.chat.RuntimeContext;
import com.summit.dp.workflow.application.pending.PendingTaskAdmission;
import com.summit.dp.workflow.domain.pending.model.PendingAttachment;
import com.summit.dp.workflow.domain.pending.model.PendingTask;
import com.summit.dp.workflow.domain.pending.model.PendingTaskStatus;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import com.summit.dp.workflow.infrastructure.persistence.mapper.PendingTaskMapper;
import com.summit.dp.workflow.infrastructure.persistence.repository.PendingTaskRepositoryImpl;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/**
 * pending_task 的真实库往返，以及**删行必须和新轮次落库同一事务**这条赌注。
 *
 * <p>用真实 H2 文件库而不是内存替身：本任务要验的恰好是 CLOB 落盘形态、雪花 id 的排序、
 * 以及事务边界 —— 内存替身在这三点上都只会给自己发合格证。</p>
 */
class PendingTaskRepositoryTest {

    private static final long SESSION = 700L;
    private static final String EXECUTION_ID = "2107000000000000001";

    private H2TestDatabase database;
    private PendingTaskRepositoryImpl repository;
    private TransactionTemplate transaction;
    private long nextTaskId;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("PendingTaskRepositoryTest");
        MybatisConfiguration configuration = new MybatisConfiguration();
        MyBatisTypeHandlers.registerAll(configuration);
        configuration.setMapUnderscoreToCamelCase(false);
        configuration.addMapper(PendingTaskMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionFactory sessionFactory = factory.getObject();
        PendingTaskMapper mapper = H2TestDatabase.sqlSession(sessionFactory).getMapper(PendingTaskMapper.class);
        repository = new PendingTaskRepositoryImpl(mapper, new ObjectMapper());
        transaction = new TransactionTemplate(new DataSourceTransactionManager(database));
        nextTaskId = 2107000000000000100L;
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    private long saveTask(String input, List<PendingAttachment> attachments) {
        long taskId = nextTaskId++;
        repository.save(PendingTask.enqueue(taskId, SESSION, input, attachments,
                7L, 9L, 3L, true, Instant.now()));
        return taskId;
    }

    private long savePending() {
        return saveTask("排队里的一句话", List.of());
    }

    private static RuntimeContext context() {
        ExecutionContext executionContext = ExecutionContext.root(SESSION, EXECUTION_ID,
                null, 7L, AgentPermissionMode.FULL_ACCESS);
        return new RuntimeContext(executionContext, null, null,
                SessionVO.builder().id(SESSION).build(), List.of(), null, null,
                AgentPermissionMode.FULL_ACCESS, false, null);
    }

    @Test
    void roundTripKeepsLongInputAndAttachments() {
        String longInput = "长".repeat(5000);
        List<PendingAttachment> attachments = List.of(
                new PendingAttachment("a1b2c3d4e5f60718", "x.png", "image/png", 3,
                        SESSION + "/1/a1b2c3d4e5f60718.png"));
        long taskId = saveTask(longInput, attachments);

        PendingTask loaded = repository.findById(taskId).orElseThrow();

        assertEquals(longInput, loaded.getInput(), "输入列必须是 CLOB，不能被 4000 字符截断");
        assertEquals(1, loaded.getAttachments().size());
        assertEquals("a1b2c3d4e5f60718", loaded.getAttachments().getFirst().id());
        assertEquals("image/png", loaded.getAttachments().getFirst().mime());
        assertEquals(7L, loaded.getModelId(), "恢复时配置不能丢，否则重启后接力会换模型");
        assertEquals(9L, loaded.getAgentId());
        assertEquals(3L, loaded.getWorkspaceId());
        assertTrue(loaded.isRequirePlan());
        assertEquals(PendingTaskStatus.PENDING, loaded.getStatus());
    }

    @Test
    void earliestDispatchableSkipsTasksWaitingForTheUser() {
        long first = savePending();
        long second = savePending();
        Optional<PendingTask> head = repository.findEarliestDispatchable(SESSION);
        assertTrue(head.isPresent());
        assertEquals(first, head.orElseThrow().getId(), "派发按 id 升序，不能靠时间戳分先后");

        PendingTask waiting = repository.findById(first).orElseThrow();
        waiting.markAwaitingConfirm(Instant.now());
        repository.updateById(waiting);

        Optional<PendingTask> next = repository.findEarliestDispatchable(SESSION);
        assertTrue(next.isPresent());
        assertEquals(second, next.orElseThrow().getId(), "待确认的那条不能被自动派发");
    }

    @Test
    void markLegacyAwaitingConfirmOnlyTouchesPendingRows() {
        long pending = savePending();
        long paused = saveTask("失败过的一条", List.of());
        PendingTask pausedTask = repository.findById(paused).orElseThrow();
        pausedTask.fail("模型调用失败", Instant.now());
        repository.updateById(pausedTask);

        int changed = repository.markLegacyAwaitingConfirm();

        assertEquals(1, changed, "只刷 PENDING：已经停在别处的行不该被再改一次");
        assertEquals(PendingTaskStatus.AWAITING_CONFIRM, repository.findById(pending).orElseThrow().getStatus());
        assertEquals(PendingTaskStatus.PAUSED, repository.findById(paused).orElseThrow().getStatus());
    }

    /**
     * 删行必须在受理事务里。
     *
     * <p>判据不是「删得快」，而是**外层事务回滚时行必须回来**：撤成两个事务后只有两种结局，
     * 用户输入凭空消失，或者同一句话跑两轮 —— 两种都不能接受。</p>
     */
    @Test
    void deletesTheRowInsideTheAdmissionTransaction() {
        long taskId = savePending();
        PreparedChatExecutor chatExecutor = mock(PreparedChatExecutor.class);
        RuntimeContext context = context();
        when(chatExecutor.admit(context)).thenReturn(context.withTurnId(11L));
        PendingTaskAdmission admission = new PendingTaskAdmission(chatExecutor, repository,
                new SessionExecutionRegistry());

        transaction.execute(status -> {
            admission.admit(context, taskId);
            assertTrue(repository.findById(taskId).isEmpty(), "受理事务内删行必须当场生效");
            status.setRollbackOnly();
            return null;
        });

        assertTrue(repository.findById(taskId).isPresent(),
                "回滚后行必须回来：删行若跑到受理事务之外，这里就永久补不回来了");
    }
}
