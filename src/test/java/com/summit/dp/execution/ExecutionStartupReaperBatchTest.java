package com.summit.dp.execution;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.dp.execution.application.port.ExecutionCheckpointStore;
import com.summit.dp.execution.application.service.ExecutionCheckpointService;
import com.summit.dp.execution.domain.model.ResumeTaskState;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.concurrent.ManagedAsyncExecutor;
import com.summit.dp.workflow.application.lifecycle.ExecutionLifecycleProjection;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.infrastructure.lifecycle.startup.ExecutionStartupReaper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.boot.context.event.ApplicationReadyEvent;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;
import static org.junit.jupiter.api.Assertions.fail;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 待收口项的消费方式：有界批次 + 游标 + 公平重试，且必须在同一进程内收敛。
 *
 * <p><b>为什么不能用「单次启动扫一轮」</b>：进程不重启时，超过一批的待办与一直失败的项就再也
 * 没有机会 —— 用户看到的是「执行已终结、轮次永远进行中」。这里的用例全部在真实 H2 + 真实仓储上跑，
 * 断言的是<b>库里</b>的待收口位最终清零，而不是某个方法被调用过。</p>
 *
 * <p><b>三件事必须同时成立</b>：①超过批大小的量能收敛；②前面的项持续失败不饿死后面的项，
 * 且故障解除后那些项能在同一进程内被收口；③启动段只触发、不处理（启动耗时与待办量无关）。</p>
 */
class ExecutionStartupReaperBatchTest {

    /** 造出的待办量：故意多于几批（批大小 100），才测得出「游标翻页」与「同一进程内收敛」。 */
    private static final int TOTAL_PENDING = 260;
    /** 用例等待收敛的上限；只做「有限时间内能收敛」的断言，不卡具体耗时。 */
    private static final Duration CONVERGENCE_TIMEOUT = Duration.ofSeconds(60);

    private H2TestDatabase database;
    private ExecutionMapper mapper;
    private ExecutionRepositoryImpl executions;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("ExecutionStartupReaperBatchTest");
        mapper = H2TestDatabase.sqlSession(database.sessionFactory(ExecutionMapper.class))
                .getMapper(ExecutionMapper.class);
        executions = new ExecutionRepositoryImpl(mapper);
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("待办多于一批：同一进程内全部收敛，不依赖重启")
    void closesBatchLargerThanLimitInOneProcess() {
        List<Long> ids = seedPending(TOTAL_PENDING);
        ExecutionLifecycleProjection closing = alwaysClosingProjection();

        reaper(closing).onApplicationEvent(mock(ApplicationReadyEvent.class));

        awaitPendingCount(0, "超过批大小的待办必须在一个进程内被消费完（不依赖重启）");
        assertEquals(0, pendingCount(), "全部待收口项必须清零");
        assertEquals(TOTAL_PENDING, ids.size(), "夹具必须造出完整的待办量");
    }

    @Test
    @DisplayName("前几项持续失败：后面的项不被饿死，故障解除后剩余项在同一进程内收口")
    void frontItemsFailingDoNotStarveLaterItems() {
        List<Long> ids = seedPending(30);
        // 前 3 条一直失败，其余正常 —— 失败条件由开关控制，用来模拟「故障解除」。
        Set<Long> failing = Set.of(ids.get(0), ids.get(1), ids.get(2));
        AtomicBoolean faultActive = new AtomicBoolean(true);
        ExecutionLifecycleProjection flaky = projection((execution) -> {
            if (faultActive.get() && failing.contains(Long.parseLong(execution.getId()))) {
                throw new IllegalStateException("注入的收口失败");
            }
            executions.clearClosurePending(Long.parseLong(execution.getId()));
        });

        reaper(flaky).onApplicationEvent(mock(ApplicationReadyEvent.class));

        // 第一轮必须跳过失败项继续处理后面的项：只剩那 3 条仍待办，就证明没有饿死。
        awaitPendingCount(failing.size(), "前面的项持续失败时，后面的项必须照样被收口");
        for (Long id : ids) {
            if (!failing.contains(id)) {
                assertEquals(Integer.valueOf(0), pendingFlag(id), "非失败项必须被收口: " + id);
            }
        }
        for (Long id : failing) {
            assertEquals(Integer.valueOf(1), pendingFlag(id), "失败项必须保留待办: " + id);
        }

        // 故障解除：同一进程内必须自己把这 3 条收掉（不许靠重启）。
        faultActive.set(false);
        awaitPendingCount(0, "故障解除后剩余项必须在同一进程内被收口");
    }

    @Test
    @DisplayName("启动段只提交不处理：待办再多，onApplicationEvent 也立刻返回")
    void startupTriggerIsNonBlocking() {
        seedPending(TOTAL_PENDING);
        CountDownLatch neverReleased = new CountDownLatch(1);
        ExecutionLifecycleProjection blocking = mock(ExecutionLifecycleProjection.class);
        doAnswer(invocation -> {
            // 阻塞住「处理一条待办」这个动作：同步处理会让启动段卡死在这里。
            neverReleased.await();
            return null;
        }).when(blocking).completeClosure(any(), anyBoolean());

        ExecutionStartupReaper reaper = reaper(blocking);
        try {
            assertTimeoutPreemptively(Duration.ofMillis(1500),
                    () -> reaper.onApplicationEvent(mock(ApplicationReadyEvent.class)),
                    "启动段必须只提交任务，不能在启动线程里自己处理待办");
        } finally {
            neverReleased.countDown();
        }
        assertEquals(TOTAL_PENDING, pendingCount(),
                "启动段返回时一条都还没处理：处理是异步任务的活");
    }

    @Test
    @DisplayName("启动段只把任务交给受管执行器：桩执行器记录到提交，库里一条都没动")
    void startupTriggerOnlySubmitsTaskToManagedExecutor() {
        seedPending(12);
        AtomicInteger submitted = new AtomicInteger();
        // 只记录、不执行：这就是「启动段只提交」最直接的证据 —— 若 reaper 自己处理，库里会开始清位。
        ManagedAsyncExecutor recording = new ManagedAsyncExecutor() {
            @Override
            public boolean tryExecute(String taskName, Runnable task) {
                submitted.incrementAndGet();
                return true;
            }
        };

        reaper(alwaysClosingProjection(), recording).onApplicationEvent(mock(ApplicationReadyEvent.class));

        assertEquals(1, submitted.get(), "启动段必须把消费任务提交给受管执行器，有且只有一次");
        assertEquals(12, pendingCount(), "桩执行器没跑任务，库里的待收口位必须原封不动");
    }

    @Test
    @DisplayName("升级前的历史行（没写过待收口位）不会被误扫，巡检也不碰它")
    void legacyRowWithoutClosurePendingColumnIsNotScanned() {
        // 老式行：PO 上待收口位为 null，MyBatis-Plus 不会写这一列，落库取列的默认值 0。
        ExecutionPO legacy = new ExecutionPO();
        legacy.setSessionId(7_001L);
        legacy.setStatus(ExecutionStatusCodes.COMPLETED);
        legacy.setResumeGeneration(0L);
        mapper.insert(legacy);
        assertEquals(Integer.valueOf(0), mapper.selectById(legacy.getId()).getClosurePending(),
                "列的默认值必须是 0：否则升级后所有历史行都会被当成本次待办");

        assertEquals(List.of(), executions.findClosurePendingIds(10),
                "待收口位为 0 的历史行不得进入补偿查询");

        ExecutionLifecycleProjection closing = alwaysClosingProjection();
        reaper(closing).onApplicationEvent(mock(ApplicationReadyEvent.class));

        verify(closing, never()).completeClosure(any(), anyBoolean());
        assertEquals(Integer.valueOf(0), mapper.selectById(legacy.getId()).getClosurePending(),
                "巡检不得改动历史行");
    }

    // ------------------------------------------------------------------
    // 夹具
    // ------------------------------------------------------------------

    /** 抄一批待收口行：状态已是终态、待收口位为 1（正是崩溃窗口留下的形态）。 */
    private List<Long> seedPending(int count) {
        List<Long> ids = new java.util.ArrayList<>(count);
        for (int index = 0; index < count; index++) {
            ExecutionPO row = new ExecutionPO();
            row.setSessionId(9_000L + index);
            row.setStatus(ExecutionStatusCodes.COMPLETED);
            row.setResumeGeneration(0L);
            row.setClosurePending(1);
            mapper.insert(row);
            ids.add(row.getId());
        }
        return ids;
    }

    /** 收口成功即清待收口位的投影（真仓储负责落库，投影只表达「这一步成功」）。 */
    private ExecutionLifecycleProjection alwaysClosingProjection() {
        return projection(execution -> executions.clearClosurePending(Long.parseLong(execution.getId())));
    }

    private ExecutionLifecycleProjection projection(java.util.function.Consumer<Execution> closure) {
        ExecutionLifecycleProjection projection = mock(ExecutionLifecycleProjection.class);
        doAnswer(invocation -> {
            closure.accept(invocation.getArgument(0));
            return null;
        }).when(projection).completeClosure(any(), anyBoolean());
        return projection;
    }

    private ExecutionStartupReaper reaper(ExecutionLifecycleProjection projection) {
        return reaper(projection, new ManagedAsyncExecutor());
    }

    /** 可注入执行器：既用于「真实异步」，也用于「只记录不执行」的桩断言。 */
    private ExecutionStartupReaper reaper(ExecutionLifecycleProjection projection, ManagedAsyncExecutor executor) {
        ExecutionResumeTaskRepository resumeTasks = mock(ExecutionResumeTaskRepository.class);
        when(resumeTasks.listUnfinished(anyInt())).thenReturn(List.of());
        com.summit.core.runtime.loop.ExecutionRepository checkpoints =
                mock(com.summit.core.runtime.loop.ExecutionRepository.class);
        when(checkpoints.findById(any())).thenAnswer(invocation -> Optional.of(
                terminalExecution(invocation.getArgument(0))));
        return new ExecutionStartupReaper(executions, resumeTasks,
                mock(ExecutionResumeCoordinator.class), checkpoints, projection, executor);
    }

    private static Execution terminalExecution(String executionId) {
        return Execution.builder().id(executionId).agentId("chatAgent")
                .executionState(ExecutionState.COMPLETED)
                .agentRequest(AgentRequest.builder().executionId(executionId)
                        .runtimeParameters(AgentRuntimeParameters.builder()
                                .attributes(Map.of(com.summit.dp.execution.ExecutionAttributes.SESSION_ID,
                                        "9000")).build())
                        .build())
                .build();
    }

    private int pendingCount() {
        Long count = mapper.selectCount(new com.baomidou.mybatisplus.core.conditions.query
                .LambdaQueryWrapper<ExecutionPO>()
                .eq(ExecutionPO::getClosurePending, 1));
        return count == null ? 0 : count.intValue();
    }

    private Integer pendingFlag(long executionId) {
        ExecutionPO row = mapper.selectById(executionId);
        return row == null ? null : row.getClosurePending();
    }

    /** 轮询库里的事实直到达到期望值：收敛是异步的，这里只给它一个有界的等待窗口。 */
    private void awaitPendingCount(int expected, String message) {
        long deadline = System.nanoTime() + CONVERGENCE_TIMEOUT.toNanos();
        while (System.nanoTime() < deadline) {
            if (pendingCount() == expected) {
                return;
            }
            try {
                TimeUnit.MILLISECONDS.sleep(250L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                fail("等待收口收敛被中断");
                return;
            }
        }
        assertEquals(expected, pendingCount(), message);
    }
}
