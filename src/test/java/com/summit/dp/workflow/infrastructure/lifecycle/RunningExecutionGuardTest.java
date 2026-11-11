package com.summit.dp.workflow.infrastructure.lifecycle;

import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.shared.exception.ClientException;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 删会话前的执行闸门：只拦「真的还有线程在写」的状态。
 *
 * <p>拦错方向的两个代价都很实在：拦太松，运行线程会在会话行消失后写出永久孤儿；
 * 拦太死，一条挂起执行就让用户再也删不掉这个会话。</p>
 */
class RunningExecutionGuardTest {

    private final ExecutionRepository executions = mock(ExecutionRepository.class);
    private final RunningExecutionGuard guard = new RunningExecutionGuard(executions);

    @Test
    void rejectsWhenAnExecutionIsStillRunning() {
        when(executions.findUnfinishedBySessions(List.of(1L))).thenReturn(List.of(execution(9L, ExecutionStatusCodes.RUNNING)));

        assertThrows(ClientException.class, () -> guard.requireNoRunningExecution(List.of(1L)));
    }

    @Test
    void rejectsWhenAnExecutionWasAcceptedButNotStarted() {
        when(executions.findUnfinishedBySessions(List.of(1L))).thenReturn(List.of(execution(9L, ExecutionStatusCodes.CREATED)));

        assertThrows(ClientException.class, () -> guard.requireNoRunningExecution(List.of(1L)));
    }

    /** 挂起没有线程在写，删会话正等于放弃这次挂起，不该被拦。 */
    @Test
    void allowsDeletionWhenTheOnlyExecutionIsSuspended() {
        when(executions.findUnfinishedBySessions(List.of(1L))).thenReturn(List.of(execution(9L, ExecutionStatusCodes.SUSPENDED)));

        assertDoesNotThrow(() -> guard.requireNoRunningExecution(List.of(1L)));
    }

    @Test
    void allowsDeletionWhenNothingIsUnfinished() {
        when(executions.findUnfinishedBySessions(List.of(1L))).thenReturn(List.of());

        assertDoesNotThrow(() -> guard.requireNoRunningExecution(List.of(1L)));
    }

    private static Execution execution(long id, int status) {
        return Execution.restoreCheckpointSummary(id, 1L, status, 0L, 1L, null);
    }
}
