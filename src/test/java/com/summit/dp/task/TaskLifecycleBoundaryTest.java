package com.summit.dp.task;

import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.task.application.command.TaskCommand;
import com.summit.dp.task.application.service.TaskDeletionPolicy;
import com.summit.dp.task.application.service.TaskRuntimeService;
import com.summit.dp.task.application.service.impl.TaskServiceImpl;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackendProcessManager;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskBroadcaster;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskCompletion;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class TaskLifecycleBoundaryTest {
    private final TaskRepository repository = mock(TaskRepository.class);
    private final TaskRuntimeService runtime = mock(TaskRuntimeService.class);
    private final TaskServiceImpl service = new TaskServiceImpl(repository, runtime);

    @Test void manualCreationAndStateUpdatesCannotForgeProcessFacts() {
        TaskCommand command = new TaskCommand();
        command.setId(1L); command.setSessionId(10L); command.setTurnId(20L);
        command.setCommand("echo test"); command.setStatus("RUNNING");
        when(repository.findById(1L)).thenReturn(Optional.of(task()));
        assertEquals(0, service.add(command).getCode());
        assertEquals(0, service.update(command).getCode());
        verifyNoInteractions(repository, runtime);
    }

    @Test void genericDeletionUsesTheSameRuntimeGuardsAsTheTaskPanel() {
        Task task = task();
        when(repository.findById(1L)).thenReturn(Optional.of(task));
        service.delById(1L);
        verify(runtime).deleteTask(10L, 1L);
        verify(repository, never()).delete(task);
    }

    @Test void pendingNotificationPreventsDeletionUntilTheOwningExecutionEnds() {
        ExecutionRepository executions = mock(ExecutionRepository.class);
        TaskDeletionPolicy policy = new TaskDeletionPolicy(executions);
        for (int status : List.of(ExecutionStatusCodes.CREATED, ExecutionStatusCodes.RUNNING, ExecutionStatusCodes.SUSPENDED)) {
            Execution execution = new Execution(); execution.setId(100L); execution.setStatus(status);
            when(executions.findSummariesByIds(List.of(100L))).thenReturn(List.of(execution));
            assertThrows(ClientException.class, () -> policy.validate(task()));
        }
        when(executions.findSummariesByIds(List.of(100L))).thenReturn(List.of());
        assertThrows(ClientException.class, () -> policy.validate(task()));
        for (int status : List.of(ExecutionStatusCodes.COMPLETED, ExecutionStatusCodes.FAILED, ExecutionStatusCodes.CANCELLED)) {
            Execution execution = new Execution(); execution.setId(100L); execution.setStatus(status);
            when(executions.findSummariesByIds(List.of(100L))).thenReturn(List.of(execution));
            assertDoesNotThrow(() -> policy.validate(task()));
        }
    }

    @Test void runtimeDeletionChecksNotificationOwnershipBeforeRemovingTheTask() {
        Task task = task();
        when(repository.findById(1L)).thenReturn(Optional.of(task));
        TaskDeletionPolicy policy = mock(TaskDeletionPolicy.class);
        doThrow(new ClientException("所属执行仍在等待结果")).when(policy).validate(task);
        BackendProcessManager manager = new BackendProcessManager(repository, mock(BackgroundTaskBroadcaster.class),
                mock(BackgroundTaskCompletion.class), policy);
        assertThrows(ClientException.class, () -> manager.deleteTask(10L, 1L));
        verify(repository, never()).delete(task);
    }

    @Test void historicalTasksDoNotInventExecutionOwnership() {
        ExecutionRepository executions = mock(ExecutionRepository.class);
        TaskDeletionPolicy policy = new TaskDeletionPolicy(executions);
        assertDoesNotThrow(() -> policy.validate(Task.builder().id(1L).sessionId(10L).build()));
        verifyNoInteractions(executions);
    }

    private static Task task() {
        Task task = Task.builder().id(1L).sessionId(10L).turnId(20L).executionId(100L).command("done").build();
        task.finish(Task.TaskStatus.SUCCESS, "done", 0, false);
        return task;
    }
}
