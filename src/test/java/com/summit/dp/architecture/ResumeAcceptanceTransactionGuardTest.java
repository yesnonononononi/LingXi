package com.summit.dp.architecture;

import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.execution.application.port.ExecutionActivity;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.execution.domain.model.ResumeSource;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionResumeTaskMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionResumeTaskPO;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.workflow.infrastructure.harness.SessionAttributeRestorer;
import com.summit.dp.workflow.application.lifecycle.CoordinatorResumeAcceptance;
import com.summit.dp.workflow.application.lifecycle.ExecutionResumeCoordinator;
import com.summit.dp.workflow.application.lifecycle.ResumeAcceptancePort;
import com.summit.dp.workflow.application.lifecycle.ResumeTriggerType;
import com.summit.dp.workflow.application.lifecycle.StartupFailureCloser;
import com.summit.dp.workflow.application.lifecycle.SubAgentWaitSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.SubExecutionDependency;
import com.summit.dp.workflow.application.lifecycle.SuspendedExecutionResumer;
import com.summit.dp.workflow.application.lifecycle.SuspensionGateChain;
import com.summit.dp.workflow.application.lifecycle.UnresolvedToolSuspensionGate;
import com.summit.dp.workflow.application.lifecycle.UserPauseSuspensionGate;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import org.mybatis.spring.SqlSessionTemplate;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 恢复受理的事务契约：受理必须与调用方的事务同批提交。
 *
 * <p>用真实 H2 与真实 {@code execution_resume_task} 表，断言的是行数而不是「有没有调用某个方法」：
 * 回滚时必须一行都不留，提交时行数与来源都必须正确。调用方若把受理挪到事务之外，
 * 这里的回滚用例会立刻变红 —— 那正是「决策回滚了、恢复请求却排了队」的窗口。</p>
 */
class ResumeAcceptanceTransactionGuardTest {

    private static final long EXECUTION_ID = 4100L;
    private static final long GENERATION = 5L;
    private static final long SESSION_ID = 820L;

    private H2TestDatabase database;
    private SqlSessionTemplate session;
    private TransactionTemplate transactions;
    private ResumeAcceptancePort port;
    private ExecutionResumeCoordinator coordinator;

    @BeforeEach
    void setup() {
        database = H2TestDatabase.create("ResumeAcceptanceTransactionGuardTest");
        session = H2TestDatabase.sqlSession(database.sessionFactory(ExecutionMapper.class,
                ExecutionResumeTaskMapper.class));
        ExecutionResumeTaskRepository tasks =
                new com.summit.dp.execution.infrastructure.repository.ExecutionResumeTaskRepositoryImpl(
                        session.getMapper(ExecutionResumeTaskMapper.class));
        com.summit.dp.execution.domain.repository.ExecutionRepository executions =
                new ExecutionRepositoryImpl(session.getMapper(ExecutionMapper.class));
        // 挂起态 + 代际 > 0 是「可以真正排队恢复」的前提：没有这两点，门禁会直接给出 ENDED。
        ExecutionPO row = new ExecutionPO();
        row.setId(EXECUTION_ID);
        row.setSessionId(SESSION_ID);
        row.setVersion(1L);
        row.setStatus(ExecutionStatusCodes.SUSPENDED);
        row.setResumeGeneration(GENERATION);
        session.getMapper(ExecutionMapper.class).insert(row);
        ToolCallRepository toolCalls = mock(ToolCallRepository.class);
        when(toolCalls.listUnresolvedByExecutionId(EXECUTION_ID)).thenReturn(List.of());

        ExecutionRepository framework = mock(ExecutionRepository.class);
        ExecutionControl control = mock(ExecutionControl.class);
        ExecutionActivity activity = mock(ExecutionActivity.class);
        when(activity.isActive(any())).thenReturn(false);
        when(control.fail(any(), any())).thenReturn(() -> { });
        SuspensionGateChain gates = new SuspensionGateChain(List.of(new UserPauseSuspensionGate(),
                new UnresolvedToolSuspensionGate(toolCalls)));
        coordinator = new ExecutionResumeCoordinator(tasks, executions,
                new SuspendedExecutionResumer(mock(SessionAttributeRestorer.class),
                        mock(ModelContextService.class), provider(control)),
                control, gates, new UnresolvedToolSuspensionGate(toolCalls), provider(framework),
                provider(activity), new StartupFailureCloser(control));
        port = new CoordinatorResumeAcceptance(coordinator);
        transactions = new TransactionTemplate(new DataSourceTransactionManager(database));
    }

    @AfterEach
    void shutdown() {
        coordinator.close();
        database.shutdown();
    }

    @Test
    @DisplayName("受理事务回滚：恢复请求一行都不留（入队确实在同一事务）")
    void rolledBackAcceptanceLeavesNoResumeTask() {
        transactions.execute(status -> {
            // 事务内受理；回滚后请求行必须不存在，否则会出现「决策没落库、恢复已排队」。
            assertEquals(ResumeDisposition.QUEUED, port.accept(EXECUTION_ID, ResumeTriggerType.APPROVAL_DECISION),
                    "门禁全通过时应当场给出排在队列里的结论");
            status.setRollbackOnly();
            return null;
        });

        assertEquals(0, resumeTaskCount(), "受理回滚后不得留下任何恢复请求行");
    }

    @Test
    @DisplayName("受理正常提交：请求行 1 条且来源是 APPROVAL_DECISION")
    void committedAcceptanceWritesExactlyOneTaskWithSource() {
        ResumeDisposition disposition = transactions.execute(status ->
                port.accept(EXECUTION_ID, ResumeTriggerType.APPROVAL_DECISION));

        assertEquals(ResumeDisposition.QUEUED, disposition, "门禁全通过时应给出排在队列里的结论");
        List<ExecutionResumeTaskPO> rows = taskRows();
        assertEquals(1, rows.size(), "受理提交后必须恰好一条恢复请求行");
        assertEquals(ResumeSource.APPROVAL_DECISION.name(), rows.get(0).getTriggerType(),
                "来源必须随请求一起落库，否则重启后被按自动唤醒判掉");
    }

    /** 直接查表：不走被测仓储，避免用被考核代码自证。 */
    private List<ExecutionResumeTaskPO> taskRows() {
        return session.getMapper(ExecutionResumeTaskMapper.class)
                .selectList(new LambdaQueryWrapper<ExecutionResumeTaskPO>()
                        .eq(ExecutionResumeTaskPO::getExecutionId, EXECUTION_ID));
    }

    private long resumeTaskCount() {
        return taskRows().size();
    }

    private static <T> org.springframework.beans.factory.ObjectProvider<T> provider(T instance) {
        return new org.springframework.beans.factory.ObjectProvider<>() {
            @Override
            public T getObject() {
                return instance;
            }
        };
    }
}
