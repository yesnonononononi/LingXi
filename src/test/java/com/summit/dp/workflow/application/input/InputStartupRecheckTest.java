package com.summit.dp.workflow.application.input;

import com.summit.dp.email.domain.repository.EmailRepository;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.workflow.infrastructure.lifecycle.startup.InputStartupRecheck;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

/**
 * 启动自检只从「候选会话」出发：三个事实源取并集去重，候选里每个会话只复查最新执行。
 *
 * <p>这里守的是<b>候选口径</b>：漏掉任一来源会丢唤醒，把非候选也拉进来就会让启动随历史会话数增长。
 * 真实库上的语句条数由 {@code InputStartupRecheckCandidateScopeTest} 守。</p>
 */
class InputStartupRecheckTest {

    private final ExecutionRepository executions = mock(ExecutionRepository.class);
    private final EmailRepository emails = mock(EmailRepository.class);
    private final TaskRepository tasks = mock(TaskRepository.class);
    private final InputWakeupService wakeups = mock(InputWakeupService.class);
    private final InputStartupRecheck recheck =
            new InputStartupRecheck(executions, emails, tasks, wakeups);

    @Test
    @DisplayName("三个候选来源取并集去重，每个会话只复查最新执行")
    void startupRechecksOnlyTheLatestExecutionInCandidateSessions() {
        when(executions.findUnfinishedSessionIds()).thenReturn(List.of(10L));
        when(emails.findPendingMailboxSessionIds()).thenReturn(List.of(20L));
        when(tasks.findSessionIdsWithUnconsumedTerminalTasks()).thenReturn(List.of(20L, 30L));
        when(executions.findLatestBySessionAndStatus(List.of(10L, 20L, 30L)))
                .thenReturn(List.of(summary(100L, 10L), summary(200L, 10L), summary(300L, 20L), summary(400L, 30L)));

        recheck.recheck();

        verify(wakeups).resumeIfInputPending(200L);
        verify(wakeups).resumeIfInputPending(300L);
        verify(wakeups).resumeIfInputPending(400L);
        verifyNoMoreInteractions(wakeups);
    }

    @Test
    @DisplayName("没有候选会话：一次最新执行查询都不发，也不触发任何唤醒")
    void noCandidateMeansNoResume() {
        when(executions.findUnfinishedSessionIds()).thenReturn(List.of());
        when(emails.findPendingMailboxSessionIds()).thenReturn(List.of());
        when(tasks.findSessionIdsWithUnconsumedTerminalTasks()).thenReturn(List.of());

        recheck.recheck();

        verify(executions, never()).findLatestBySessionAndStatus(anyList());
        verifyNoInteractions(wakeups);
    }

    private static Execution summary(long id, long sessionId) {
        Execution execution = new Execution();
        execution.setId(id);
        execution.setSessionId(sessionId);
        return execution;
    }
}
