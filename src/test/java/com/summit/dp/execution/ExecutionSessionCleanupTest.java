package com.summit.dp.execution;

import com.summit.dp.execution.application.port.ExecutionCheckpointMaintenance;
import com.summit.dp.execution.application.port.FileRecordMaintenance;
import com.summit.dp.execution.application.service.ExecutionSessionCleanupService;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.execution.domain.repository.ExecutionResumeTaskRepository;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;

import java.util.List;

import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 会话删除的执行侧级联：行与记录在事务内、文件在提交后。
 *
 * <p>重点是「记录了哪几类数据」——漏一类不会报错，只会在磁盘或表里慢慢变多。</p>
 */
class ExecutionSessionCleanupTest {

    private static final List<Long> SESSIONS = List.of(11L, 12L);

    private final ExecutionRepository executions = mock(ExecutionRepository.class);
    private final ExecutionResumeTaskRepository resumeTasks = mock(ExecutionResumeTaskRepository.class);
    private final ExecutionCheckpointMaintenance checkpoints = mock(ExecutionCheckpointMaintenance.class);
    private final FileRecordMaintenance fileRecords = mock(FileRecordMaintenance.class);
    private final ExecutionSessionCleanupService service = new ExecutionSessionCleanupService(
            executions, resumeTasks, checkpoints, fileRecords);

    /** 文件编辑记录按执行归属，会话没了必须一起走，否则基线文件永远留在磁盘上。 */
    @Test
    void cleansFileRecordsOfEveryExecution() {
        when(executions.findIdsBySessions(SESSIONS)).thenReturn(List.of(101L, 102L));

        service.deleteBySessions(SESSIONS);

        verify(fileRecords).deleteByExecutionIds(List.of("101", "102"));
    }

    /** 顺序是契约：恢复请求 → 执行行 → 记录行，最后才是文件。 */
    @Test
    void rowsGoFirstAndFilesFollowTheCommit() {
        when(executions.findIdsBySessions(List.of(11L))).thenReturn(List.of(101L));

        service.deleteBySessions(List.of(11L));

        InOrder order = inOrder(resumeTasks, executions, fileRecords, checkpoints);
        order.verify(resumeTasks).deleteByExecutionIds(List.of(101L));
        order.verify(executions).deleteBySessionIds(List.of(11L));
        order.verify(fileRecords).deleteByExecutionIds(List.of("101"));
        order.verify(checkpoints).deleteExecutionDirectory("101");
    }

    @Test
    void emptySessionSetTouchesNothing() {
        service.deleteBySessions(List.of());

        verifyNoInteractions(executions, resumeTasks, checkpoints, fileRecords);
    }
}
