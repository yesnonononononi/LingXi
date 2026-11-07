package com.summit.dp.execution;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.execution.domain.model.ExecutionResumeTask;
import com.summit.dp.execution.domain.model.ResumeSource;
import com.summit.dp.execution.domain.model.ResumeTaskState;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionResumeTaskMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionResumeTaskPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.execution.infrastructure.repository.ExecutionResumeTaskRepositoryImpl;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.persistence.MyBatisTypeHandlers;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.utils.TestTimeouts;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.workflow.application.input.InputAutomationPolicy;
import com.summit.dp.workflow.application.lifecycle.StartupFailureCloser;
import com.summit.dp.workflow.application.lifecycle.SubAgentWaitSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.SubExecutionDependency;
import com.summit.dp.workflow.application.lifecycle.SuspensionGateChain;
import com.summit.dp.workflow.application.lifecycle.UnresolvedToolSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.UserPauseSuspensionGate;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.application.resume.SuspendedExecutionResumer;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;
import org.mybatis.spring.SqlSessionTemplate;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 恢复请求的<b>触发来源必须随请求落库</b>：审批已受理、进程随后崩溃，
 * 重启重投不能把人工决策退化成自动唤醒。
 *
 * <p><b>为什么必须真打 H2</b>：缺陷就在「内存参数 vs 库内字段」的差别上。用桩对象验证
 * 「来源传进去了」只能证明方法收到了参数，证明不了重启之后还读得回来 —— 因此这里的每个用例
 * 都<b>丢弃 coordinator 实例、重建一个新的</b>（内存里的来源全丢），再看门禁怎么判。</p>
 *
 * <p>三条准入结论构成这个修复的验收面：人工决策不被自动轮次上限拦（用例 1）、
 * 自动唤醒仍被它拦（用例 2）、人工决策也不越过用户暂停（用例 3）。</p>
 */
class ExecutionResumeSourcePersistenceTest {

    private static final long EXECUTION_ID = 900L;
    private static final long SESSION_ID = 500L;
    private static final long GENERATION = 1L;

    private H2TestDatabase database;
    private ExecutionResumeTaskRepository tasks;
    private ExecutionResumeTaskMapper taskMapper;
    private ExecutionResumeCoordinator coordinator;

    private final SuspendedExecutionResumer resumer = mock(SuspendedExecutionResumer.class);
    private final ExecutionControl executionControl = mock(ExecutionControl.class);
    private final ExecutionRepository frameworkExecutions = mock(ExecutionRepository.class);
    private final ExecutionActivity activity = mock(ExecutionActivity.class);
    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);
    private final UnresolvedToolSuspensionGate unresolvedToolGate = mock(UnresolvedToolSuspensionGate.class);

    private ListAppender<ILoggingEvent> logs;
    private Logger coordinatorLogger;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("ExecutionResumeSourcePersistenceTest");
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(true);
        MyBatisTypeHandlers.registerAll(configuration);
        configuration.addMapper(ExecutionMapper.class);
        configuration.addMapper(ExecutionResumeTaskMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionFactory sessionFactory = factory.getObject();
        SqlSessionTemplate template = H2TestDatabase.sqlSession(sessionFactory);

        ExecutionMapper executionMapper = template.getMapper(ExecutionMapper.class);
        taskMapper = template.getMapper(ExecutionResumeTaskMapper.class);
        tasks = new ExecutionResumeTaskRepositoryImpl(taskMapper);
        com.summit.dp.execution.domain.repository.ExecutionRepository executions =
                new ExecutionRepositoryImpl(executionMapper);

        ExecutionPO row = new ExecutionPO();
        row.setId(EXECUTION_ID);
        row.setSessionId(SESSION_ID);
        row.setVersion(1L);
        row.setStatus(ExecutionStatusCodes.SUSPENDED);
        row.setResumeGeneration(GENERATION);
        executionMapper.insert(row);

        when(activity.isActive(any())).thenReturn(false);
        when(unresolvedToolGate.hasUnresolvedSlot(EXECUTION_ID)).thenReturn(false);
        when(toolCallRepository.listUnresolvedByExecutionId(EXECUTION_ID)).thenReturn(List.of());
        // afterCommit 刻意不执行：模拟「请求已提交、派发还没跑完就崩了」。
        // 这正是缺陷窗口 —— 来源必须已经在库上。
        SuspensionGateChain gates = new SuspensionGateChain(List.of(
                new UserPauseSuspensionGate(),
                new UnresolvedToolSuspensionGate(toolCallRepository),
                new SubAgentWaitSuspensionGate(new SubExecutionDependency(new SessionExecutionRegistry(),
                        mock(SessionRepository.class), executions))));
        coordinator = newCoordinator(tasks, executions, gates);

        coordinatorLogger = (Logger) LoggerFactory.getLogger(ExecutionResumeCoordinator.class);
        logs = new ListAppender<>();
        logs.start();
        coordinatorLogger.addAppender(logs);
    }

    @AfterEach
    void shutdown() {
        if (coordinatorLogger != null && logs != null) {
            coordinatorLogger.detachAppender(logs);
            logs.stop();
        }
        if (coordinator != null) {
            coordinator.close();
        }
        database.shutdown();
    }

    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    @DisplayName("审批已落库后进程崩溃：重建协调器重投，人工来源仍可恢复（不被自动轮次上限拦）")
    void acceptedApprovalSurvivesRestartAndStillResumes() throws Exception {
        // 自动接续已达上限：来源若退化成自动唤醒，这次恢复会被轮次上限判掉。
        resumeCheckpoint(autoRoundsAtCap(null));
        assertEquals(ResumeDisposition.QUEUED,
                coordinator.accept(EXECUTION_ID, com.summit.dp.workflow.application.lifecycle.ResumeTriggerType.APPROVAL_DECISION));
        restart();

        coordinator.dispatch(EXECUTION_ID);

        assertEquals(ResumeTaskState.SUCCEEDED, awaitSettled().getState(), "人工来源的恢复必须真的跑起来");
        verify(resumer, times(1)).resume(any(Execution.class), anyLong());
    }

    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    @DisplayName("自动唤醒在同样条件下仍被自动轮次上限拦住，且请求不被烧成作废")
    void automaticWakeupAfterRestartStillBlockedByAutoRoundsCap() throws Exception {
        resumeCheckpoint(autoRoundsAtCap(null));
        coordinator.accept(EXECUTION_ID, com.summit.dp.workflow.application.lifecycle.ResumeTriggerType.AUTO_INPUT_WAKEUP);
        restart();

        coordinator.dispatch(EXECUTION_ID);

        ExecutionResumeTask settled = awaitSettled();
        verify(resumer, never()).resume(any(Execution.class), anyLong());
        assertEquals(ResumeTaskState.DEFERRED, settled.getState(),
                "门禁不通过只能进 DEFERRED，不能烧成作废 —— 否则用户彻底失去这次恢复");
        assertTrue(settled.getErrorReason().contains("自动接续已达到"),
                "原因必须写清是轮次上限: " + settled.getErrorReason());
    }

    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    @DisplayName("用户暂停：人工来源也不得越过暂停，请求保留可重试")
    void restartedPausedExecutionStillBlocked() throws Exception {
        resumeCheckpoint(autoRoundsAtCap(Boolean.TRUE));
        coordinator.accept(EXECUTION_ID, com.summit.dp.workflow.application.lifecycle.ResumeTriggerType.APPROVAL_DECISION);
        restart();

        coordinator.dispatch(EXECUTION_ID);

        ExecutionResumeTask settled = awaitSettled();
        verify(resumer, never()).resume(any(Execution.class), anyLong());
        assertEquals(ResumeTaskState.DEFERRED, settled.getState());
        assertTrue(settled.getErrorReason().contains("用户暂停"), "原因必须写清是用户暂停: " + settled.getErrorReason());
    }

    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    @DisplayName("遗留行（来源 NULL）按自动唤醒口径处理，日志里能看出「按旧数据口径」")
    void legacyNullSourceTaskResumesPerChosenPolicy() throws Exception {
        resumeCheckpoint(autoRoundsAtCap(null));
        // 升级前的遗留行：来源列为 NULL，状态 READY（当时已受理、没派发完）。
        ExecutionResumeTaskPO legacy = new ExecutionResumeTaskPO();
        legacy.setExecutionId(EXECUTION_ID);
        legacy.setGeneration(GENERATION);
        legacy.setState(ResumeTaskState.READY.dbValue());
        legacy.setVersion(1L);
        legacy.setCreatedAt(java.time.LocalDateTime.now());
        legacy.setUpdatedAt(java.time.LocalDateTime.now());
        taskMapper.insert(legacy);
        assertEquals(null, taskMapper.selectById(legacy.getId()).getTriggerType(), "遗留行的来源必须为空");

        // 自动轮次上限已到：NULL 按自动口径会被拦住 —— 这正是「保守」的可观测后果。
        coordinator.dispatch(EXECUTION_ID);

        assertEquals(ResumeTaskState.DEFERRED, awaitSettled().getState());
        assertTrue(logs.list.stream().anyMatch(event -> event.getLevel() == Level.INFO
                        && event.getFormattedMessage().contains("按旧数据口径")
                        && event.getFormattedMessage().contains("自动唤醒")),
                "遗留行走保守口径必须在日志里可追，实际日志: " + messages());

        // 人手动点一次恢复：同一代际的新受理把请求重新排回 READY 并升成人工来源。
        resetAutoRounds();
        coordinator.accept(EXECUTION_ID, com.summit.dp.workflow.application.lifecycle.ResumeTriggerType.MANUAL_USER_RESUME);
        coordinator.dispatch(EXECUTION_ID);

        assertEquals(ResumeTaskState.SUCCEEDED, awaitSettled().getState(), "人工受理后应能恢复");
        assertEquals(ResumeSource.MANUAL_USER_RESUME, stored().getTriggerType());
        verify(resumer, times(1)).resume(any(Execution.class), anyLong());
    }

    @Test
    @Timeout(TestTimeouts.HANG_GUARD)
    @DisplayName("同代际先自动后人工：只有一行，且来源升级为人工")
    void duplicateAcceptUpgradesSourceInsteadOfInserting() throws Exception {
        resumeCheckpoint(autoRoundsAtCap(null));

        coordinator.accept(EXECUTION_ID, com.summit.dp.workflow.application.lifecycle.ResumeTriggerType.AUTO_INPUT_WAKEUP);
        coordinator.accept(EXECUTION_ID, com.summit.dp.workflow.application.lifecycle.ResumeTriggerType.APPROVAL_DECISION);

        List<ExecutionResumeTask> rows = tasks.findByExecutionId(EXECUTION_ID);
        assertEquals(1, rows.size(), "同执行同代际只能有一行，实际: " + rows.size());
        assertEquals(ResumeSource.APPROVAL_DECISION, rows.getFirst().getTriggerType(),
                "人工来源必须覆盖先到的自动来源");
    }

    // ------------------------------------------------------------------

    /** 重建协调器 = 模拟进程重启：内存里的来源、门闩、派发线程全部丢失。 */
    private void restart() {
        coordinator.close();
        coordinator = newCoordinator(tasks,
                new ExecutionRepositoryImpl(H2TestDatabase
                        .sqlSession(database.sessionFactory(ExecutionMapper.class))
                        .getMapper(ExecutionMapper.class)),
                new SuspensionGateChain(List.of(
                        new UserPauseSuspensionGate(),
                        new UnresolvedToolSuspensionGate(toolCallRepository),
                        new SubAgentWaitSuspensionGate(new SubExecutionDependency(new SessionExecutionRegistry(),
                                mock(SessionRepository.class),
                                new ExecutionRepositoryImpl(H2TestDatabase
                                        .sqlSession(database.sessionFactory(ExecutionMapper.class))
                                        .getMapper(ExecutionMapper.class)))))));
    }

    private ExecutionResumeCoordinator newCoordinator(
            ExecutionResumeTaskRepository repository,
            com.summit.dp.execution.domain.repository.ExecutionRepository executions,
            SuspensionGateChain gates) {
        return new ExecutionResumeCoordinator(repository, executions, resumer, executionControl, gates,
                unresolvedToolGate, provider(frameworkExecutions), provider(activity),
                new StartupFailureCloser(executionControl));
    }

    private ExecutionResumeTask stored() {
        return tasks.findByExecutionId(EXECUTION_ID).stream()
                .filter(task -> task.getGeneration() == GENERATION)
                .findFirst()
                .orElseThrow(() -> new AssertionError("库内没有该代际的恢复请求"));
    }

    /**
     * 等 worker 把状态写定：派发在虚拟线程里跑，断言必须等它落库。
     *
     * <p>READY（还没领取）与 CLAIMED（正在跑）都不是结论，继续等；超时即失败，
     * 不靠固定 sleep 赌时序。</p>
     */
    private ExecutionResumeTask awaitSettled() {
        long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            ExecutionResumeTask task = stored();
            if (task.getState() != ResumeTaskState.READY && task.getState() != ResumeTaskState.CLAIMED) {
                return task;
            }
            try {
                Thread.sleep(5L);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        throw new AssertionError("等待恢复请求落定时超时，当前状态: " + stored().getState());
    }

    /** 挂起检查点：控制槽位释放、状态 SUSPENDED，并按需写入暂停/轮次上限属性。 */
    private void resumeCheckpoint(Execution execution) {
        when(frameworkExecutions.findById(String.valueOf(EXECUTION_ID))).thenReturn(Optional.of(execution));
    }

    /** 自动接续已达上限；{@code paused} 非空时同时写用户暂停标记。 */
    private Execution autoRoundsAtCap(Boolean paused) {
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(ExecutionAttributes.SESSION_ID, String.valueOf(SESSION_ID));
        attributes.put(InputAutomationPolicy.AUTO_ROUNDS, InputAutomationPolicy.MAX_AUTO_ROUNDS);
        if (Boolean.TRUE.equals(paused)) {
            attributes.put(InputAutomationPolicy.USER_PAUSED, true);
        }
        List<com.summit.core.conversation.message.Message> history = new ArrayList<>();
        history.add(UserMessageEntity.from("请继续"));
        return Execution.builder().id(String.valueOf(EXECUTION_ID)).agentId("chatAgent")
                .agentRequest(AgentRequest.builder().executionId(String.valueOf(EXECUTION_ID))
                        .messages(history)
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes).build())
                        .build())
                .executionState(ExecutionState.SUSPENDED).messages(history).build();
    }

    /** 人手动恢复会清掉轮次上限标记；这里直接换一份「没有上限」的检查点。 */
    private void resetAutoRounds() {
        resumeCheckpoint(autoRoundsWithoutCap());
    }

    private Execution autoRoundsWithoutCap() {
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(ExecutionAttributes.SESSION_ID, String.valueOf(SESSION_ID));
        List<com.summit.core.conversation.message.Message> history = new ArrayList<>();
        history.add(UserMessageEntity.from("请继续"));
        return Execution.builder().id(String.valueOf(EXECUTION_ID)).agentId("chatAgent")
                .agentRequest(AgentRequest.builder().executionId(String.valueOf(EXECUTION_ID))
                        .messages(history)
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes).build())
                        .build())
                .executionState(ExecutionState.SUSPENDED).messages(history).build();
    }

    private List<String> messages() {
        return logs.list.stream().map(ILoggingEvent::getFormattedMessage).toList();
    }

    @SuppressWarnings("unchecked")
    private static <T> ObjectProvider<T> provider(T service) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(service);
        return provider;
    }
}
