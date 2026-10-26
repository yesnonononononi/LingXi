package com.summit.dp.task;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.runtime.CommandHandler;
import com.summit.core.runtime.workspace.WorkspaceCommands.CommandResult;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.task.api.controller.BackgroundTaskController;
import com.summit.dp.task.application.service.TaskDeletionPolicy;
import com.summit.dp.task.application.service.TaskRuntimeService;
import com.summit.dp.task.application.vo.TaskVO;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.infrastructure.tools.config.AnnotatedToolTestDefinitions;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackendProcess;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackendProcessManager;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskBroadcaster;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskCompletion;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.ManageCommandToolExecutor;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class BackgroundCommandReadTest {
    private final TaskRepository repository = mock(TaskRepository.class);
    private final BackendProcessManager manager = new BackendProcessManager(repository, mock(BackgroundTaskBroadcaster.class), new BackgroundTaskCompletion(repository, mock(ExecutionResumeCoordinator.class)), mock(TaskDeletionPolicy.class));
    private final ObjectMapper json = new ObjectMapper().findAndRegisterModules();

    @AfterEach void close() { manager.close(); }

    @Test void waitingReadDoesNotPreventStoppingOrTakingSnapshots() throws Exception {
        CommandResult stopped = new CommandResult(137, "stopped", false, false);
        CompletableFuture<CommandResult> completion = new CompletableFuture<>();
        CountDownLatch workerEntered = new CountDownLatch(1);
        CountDownLatch readerEntered = new CountDownLatch(1);
        AtomicInteger calls = new AtomicInteger();
        CommandHandler handle = mock(CommandHandler.class);
        when(handle.await()).thenAnswer(invocation -> {
            if (calls.incrementAndGet() == 1) workerEntered.countDown();
            else readerEntered.countDown();
            return completion.get(20, TimeUnit.SECONDS);
        });
        when(handle.outputSnapshot()).thenReturn("partial");
        when(handle.stop()).thenAnswer(invocation -> {
            completion.complete(stopped);
            return new CommandHandler.StopResult(true, stopped);
        });
        register(handle, 201L);
        assertTrue(workerEntered.await(3, TimeUnit.SECONDS));
        CompletableFuture<TaskVO> reader = CompletableFuture.supplyAsync(() -> manager.read(10L, 201L, true));
        try {
            assertTrue(readerEntered.await(3, TimeUnit.SECONDS));
            CompletableFuture<TaskVO> snapshot = CompletableFuture.supplyAsync(() -> manager.read(10L, 201L, false));
            assertEquals("partial", snapshot.get(3, TimeUnit.SECONDS).getOutput());
            assertFalse(reader.isDone());
            CompletableFuture<TaskVO> stop = CompletableFuture.supplyAsync(() -> manager.stop(10L, 201L));
            assertEquals("CANCELLED", stop.get(3, TimeUnit.SECONDS).getStatus());
            assertEquals("CANCELLED", reader.get(3, TimeUnit.SECONDS).getStatus());
        } finally { completion.complete(stopped); }
    }

    @Test void waitingReadReturnsAndPersistsTheWholeResultBeforeTheCompletionWorkerRuns() throws Exception {
        CountDownLatch workerEntered = new CountDownLatch(1);
        CountDownLatch releaseWorker = new CountDownLatch(1);
        AtomicInteger calls = new AtomicInteger();
        CommandResult result = new CommandResult(7, "failed output", true, false);
        CommandHandler handle = mock(CommandHandler.class);
        when(handle.await()).thenAnswer(invocation -> {
            if (calls.incrementAndGet() == 1) {
                workerEntered.countDown();
                assertTrue(releaseWorker.await(20, TimeUnit.SECONDS));
            }
            return result;
        });
        when(handle.stop()).thenReturn(new CommandHandler.StopResult(false, result));
        Task task = register(handle, 202L);
        try {
            assertTrue(workerEntered.await(3, TimeUnit.SECONDS));
            TaskVO view = manager.read(10L, 202L, true);
            assertEquals("FAILED", view.getStatus());
            assertEquals(7, view.getExitCode());
            assertTrue(view.isTruncated());
            assertEquals("failed output", view.getOutput());
            assertNotNull(view.getCompleteAt());
            assertEquals(Task.TaskStatus.FAILED, task.getStatus());
            verify(repository, times(2)).updateById(task);
        } finally { releaseWorker.countDown(); }
    }

    @Test void interruptedReadRestoresTheFlagWithoutStoppingTheTask() throws Exception {
        CompletableFuture<CommandResult> completion = new CompletableFuture<>();
        CountDownLatch workerEntered = new CountDownLatch(1);
        AtomicReference<Thread> readerThread = new AtomicReference<>();
        AtomicReference<Throwable> unexpected = new AtomicReference<>();
        AtomicBoolean interrupted = new AtomicBoolean();
        CommandHandler handle = mock(CommandHandler.class);
        when(handle.await()).thenAnswer(invocation -> {
            if (Thread.currentThread() == readerThread.get()) throw new InterruptedException("read cancelled");
            workerEntered.countDown();
            return completion.get(20, TimeUnit.SECONDS);
        });
        CommandResult stopped = new CommandResult(137, "stopped", false, false);
        when(handle.stop()).thenAnswer(invocation -> {
            completion.complete(stopped);
            return new CommandHandler.StopResult(true, stopped);
        });
        Task task = register(handle, 203L);
        assertTrue(workerEntered.await(3, TimeUnit.SECONDS));
        Thread reader = Thread.ofVirtual().start(() -> {
            readerThread.set(Thread.currentThread());
            try {
                ClientException failure = assertThrows(ClientException.class, () -> manager.read(10L, 203L, true));
                assertTrue(failure.getMessage().contains("被中断"));
                interrupted.set(Thread.currentThread().isInterrupted());
            } catch (Throwable failure) { unexpected.set(failure); }
        });
        reader.join(3000);
        assertFalse(reader.isAlive());
        assertNull(unexpected.get());
        assertTrue(interrupted.get());
        assertEquals(Task.TaskStatus.RUNNING, task.getStatus());
        verify(handle, never()).stop();
    }

    @Test void toolActionsRouteToWaitingReadOrImmediateSnapshotAndKeepLongIds() throws Exception {
        BackendProcessManager controlled = mock(BackendProcessManager.class);
        long taskId = 9_007_199_254_740_993L;
        when(controlled.read(10L, taskId, false)).thenReturn(TaskVO.builder().id(taskId).status("RUNNING").output("partial").build());
        when(controlled.read(10L, taskId, true)).thenReturn(TaskVO.builder().id(taskId).status("SUCCESS").output("done").exitCode(0).build());
        ManageCommandToolExecutor tool = new ManageCommandToolExecutor(json, controlled);
        for (String action : new String[]{"snapshot", "read"}) {
            ToolExecuteResult result = tool.execute(ToolExecution.builder()
                    .attributes(Map.of(ExecutionAttributes.SESSION_ID, 10L))
                    .args(json.writeValueAsString(Map.of("action", action, "taskId", Long.toString(taskId)))).build());
            assertTrue(result.isSuccess(), result.getToolOutput());
            assertEquals(action.equals("snapshot") ? "RUNNING" : "SUCCESS", json.readTree(result.getToolOutput()).path("status").asText());
        }
        verify(controlled).read(10L, taskId, false);
        verify(controlled).read(10L, taskId, true);
        JsonNode schema = json.readTree(AnnotatedToolTestDefinitions.create(ManageCommandToolExecutor.class, new ManageCommandToolExecutor(json, controlled)).parametersJsonSchema());
        assertTrue(schema.path("properties").path("action").path("enum").toString().contains("snapshot"));
        assertTrue(schema.path("properties").path("taskId").path("description").asText().contains("snapshot"));
    }

    @Test void httpPollingAlwaysUsesANonblockingSnapshot() {
        TaskRuntimeService runtime = mock(TaskRuntimeService.class);
        when(runtime.read(10L, 204L, false)).thenReturn(TaskVO.builder().id(204L).status("RUNNING").build());
        new BackgroundTaskController(runtime).read(10L, 204L);
        verify(runtime).read(10L, 204L, false);
        verify(runtime, never()).read(10L, 204L, true);
    }

    private Task register(CommandHandler handle, long id) {
        Task task = Task.builder().id(id).sessionId(10L).turnId(20L).command("controlled").build();
        when(repository.findById(id)).thenReturn(Optional.of(task));
        manager.registerBackendProcess(new BackendProcess(task, handle));
        return task;
    }
}
