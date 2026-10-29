package com.summit.dp.task;

import com.summit.core.runtime.CommandHandler;
import com.summit.core.runtime.workspace.WorkspaceCommands.CommandResult;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.task.application.service.TaskDeletionPolicy;
import com.summit.dp.task.application.vo.TaskVO;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.domain.model.TaskPage;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackendProcess;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackendProcessManager;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskBroadcaster;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskCompletion;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/** 单个任务的停止和落库等待不能拖住整张列表，终态仍只允许确认一次。 */
class BackgroundTaskConcurrencyTest {
    private final TaskRepository repository = mock(TaskRepository.class);
    private final BackgroundTaskCompletion completion = mock(BackgroundTaskCompletion.class);
    private final BackgroundTaskBroadcaster broadcaster = mock(BackgroundTaskBroadcaster.class);
    private final BackendProcessManager manager = new BackendProcessManager(repository, broadcaster, completion,
            mock(TaskDeletionPolicy.class));
    private final List<Task> records = new CopyOnWriteArrayList<>();

    @AfterEach void close() { manager.close(); }

    @Test void slowStopKeepsListsAndSnapshotsAvailableForExistingAndLaterTasks() throws Exception {
        CountDownLatch stopEntered = new CountDownLatch(1);
        CountDownLatch releaseStop = new CountDownLatch(1);
        CompletableFuture<CommandResult> firstResult = new CompletableFuture<>();
        CompletableFuture<CommandResult> laterResult = new CompletableFuture<>();
        CommandResult cancelled = new CommandResult(137, "stopped", false, false);
        CommandHandler first = handle(firstResult);
        doAnswer(invocation -> {
            stopEntered.countDown();
            assertTrue(releaseStop.await(10, TimeUnit.SECONDS));
            firstResult.complete(cancelled);
            return new CommandHandler.StopResult(true, cancelled);
        }).when(first).stop();
        register(201L, first);
        CompletableFuture<TaskVO> stopping = CompletableFuture.supplyAsync(() -> manager.stop(10L, 201L));
        try {
            assertTrue(stopEntered.await(3, TimeUnit.SECONDS));
            register(202L, handle(laterResult));
            CompletableFuture<List<TaskVO>> listing = CompletableFuture.supplyAsync(() -> manager.listTasks(10L));
            assertEquals(List.of(201L, 202L), listing.get(1, TimeUnit.SECONDS).stream().map(TaskVO::getId).toList());
            assertEquals("RUNNING", CompletableFuture.supplyAsync(() -> manager.read(10L, 201L, false))
                    .get(1, TimeUnit.SECONDS).getStatus());
            assertEquals("partial", manager.read(10L, 202L, false).getOutput());
            assertThrows(ClientException.class, () -> manager.deleteTask(10L, 201L));
            assertThrows(ClientException.class, () -> manager.stop(99L, 201L));
            assertFalse(stopping.isDone());
        } finally {
            releaseStop.countDown();
            firstResult.complete(cancelled);
            laterResult.complete(new CommandResult(0, "done", false, false));
            assertEquals("CANCELLED", stopping.get(3, TimeUnit.SECONDS).getStatus());
        }
    }

    @Test void slowTerminalPersistenceDoesNotBlockListOrTerminalSnapshot() throws Exception {
        CountDownLatch saveEntered = new CountDownLatch(1);
        CountDownLatch releaseSave = new CountDownLatch(1);
        CountDownLatch published = new CountDownLatch(1);
        doAnswer(invocation -> {
            saveEntered.countDown();
            assertTrue(releaseSave.await(10, TimeUnit.SECONDS));
            return null;
        }).when(completion).save(any(Task.class));
        doAnswer(invocation -> {
            Task task = invocation.getArgument(0);
            if (task.getStatus().isTerminal()) published.countDown();
            return null;
        }).when(broadcaster).publishChanged(any(Task.class));
        register(203L, handle(CompletableFuture.completedFuture(new CommandResult(7, "failed", false, false))));
        CompletableFuture<Void> deleting = null;
        try {
            assertTrue(saveEntered.await(3, TimeUnit.SECONDS));
            assertEquals("FAILED", CompletableFuture.supplyAsync(() -> manager.listTasks(10L))
                    .get(1, TimeUnit.SECONDS).getFirst().getStatus());
            assertEquals("failed", CompletableFuture.supplyAsync(() -> manager.read(10L, 203L, false))
                    .get(1, TimeUnit.SECONDS).getOutput());
            assertEquals(1, published.getCount(), "落库完成前不能发布结束事件");
            CompletableFuture<Void> pendingDelete = CompletableFuture.runAsync(() -> manager.deleteTask(10L, 203L));
            deleting = pendingDelete;
            assertThrows(TimeoutException.class, () -> pendingDelete.get(200, TimeUnit.MILLISECONDS));
            verify(repository, never()).delete(any(Task.class));
        } finally {
            releaseSave.countDown();
            assertTrue(published.await(3, TimeUnit.SECONDS));
            if (deleting != null) deleting.get(3, TimeUnit.SECONDS);
        }
        verify(repository, times(1)).delete(any(Task.class));
    }

    @Test void completionAndWaitingReadCannotMisclassifyAnInFlightStopAsFailure() throws Exception {
        CompletableFuture<CommandResult> result = new CompletableFuture<>();
        CountDownLatch workerEntered = new CountDownLatch(1);
        CountDownLatch resultReturned = new CountDownLatch(1);
        CountDownLatch stopEntered = new CountDownLatch(1);
        CountDownLatch releaseStop = new CountDownLatch(1);
        CountDownLatch terminalSaved = new CountDownLatch(1);
        CommandResult cancelled = new CommandResult(137, "stopped", false, false);
        CommandHandler handle = handle(result);
        doAnswer(invocation -> {
            workerEntered.countDown();
            CommandResult value = result.get(10, TimeUnit.SECONDS);
            resultReturned.countDown();
            return value;
        }).when(handle).await();
        doAnswer(invocation -> {
            stopEntered.countDown();
            result.complete(cancelled);
            assertTrue(releaseStop.await(10, TimeUnit.SECONDS));
            return new CommandHandler.StopResult(true, cancelled);
        }).when(handle).stop();
        doAnswer(invocation -> { terminalSaved.countDown(); return null; }).when(completion).save(any(Task.class));
        register(204L, handle);
        assertTrue(workerEntered.await(3, TimeUnit.SECONDS));
        CompletableFuture<TaskVO> stopping = CompletableFuture.supplyAsync(() -> manager.stop(10L, 204L));
        CompletableFuture<TaskVO> reading = null;
        try {
            assertTrue(stopEntered.await(3, TimeUnit.SECONDS));
            assertTrue(resultReturned.await(3, TimeUnit.SECONDS));
            reading = CompletableFuture.supplyAsync(() -> manager.read(10L, 204L, true));
            assertFalse(terminalSaved.await(200, TimeUnit.MILLISECONDS), "停止回执未确认，完成线程不能抢先保存 FAILED");
            releaseStop.countDown();
            assertEquals("CANCELLED", stopping.get(3, TimeUnit.SECONDS).getStatus());
            assertEquals("CANCELLED", reading.get(3, TimeUnit.SECONDS).getStatus());
            verify(completion, times(1)).save(any(Task.class));
        } finally {
            releaseStop.countDown();
            result.complete(cancelled);
            stopping.get(3, TimeUnit.SECONDS);
            if (reading != null) reading.get(3, TimeUnit.SECONDS);
        }
    }

    @Test void concurrentStopsControlTheHandleAndPersistTheTerminalResultOnlyOnce() throws Exception {
        CompletableFuture<CommandResult> result = new CompletableFuture<>();
        CountDownLatch stopEntered = new CountDownLatch(1);
        CountDownLatch releaseStop = new CountDownLatch(1);
        CommandResult cancelled = new CommandResult(137, "stopped", false, false);
        CommandHandler handle = handle(result);
        doAnswer(invocation -> {
            stopEntered.countDown();
            assertTrue(releaseStop.await(10, TimeUnit.SECONDS));
            result.complete(cancelled);
            return new CommandHandler.StopResult(true, cancelled);
        }).when(handle).stop();
        register(205L, handle);
        CompletableFuture<TaskVO> first = CompletableFuture.supplyAsync(() -> manager.stop(10L, 205L));
        CompletableFuture<TaskVO> second = null;
        try {
            assertTrue(stopEntered.await(3, TimeUnit.SECONDS));
            second = CompletableFuture.supplyAsync(() -> manager.stop(10L, 205L));
            releaseStop.countDown();
            assertEquals("CANCELLED", first.get(3, TimeUnit.SECONDS).getStatus());
            assertEquals("CANCELLED", second.get(3, TimeUnit.SECONDS).getStatus());
            verify(handle, times(1)).stop();
            verify(completion, times(1)).save(any(Task.class));
        } finally {
            releaseStop.countDown(); result.complete(cancelled);
            first.get(3, TimeUnit.SECONDS);
            if (second != null) second.get(3, TimeUnit.SECONDS);
        }
    }

    @Test void interruptedStopReleasesCoordinationAndKeepsTheTaskQueryableAndRetryable() throws Exception {
        CompletableFuture<CommandResult> result = new CompletableFuture<>();
        CommandResult cancelled = new CommandResult(137, "stopped", false, false);
        CommandHandler handle = handle(result);
        doThrow(new InterruptedException("interrupted stop"))
                .doAnswer(invocation -> {
                    result.complete(cancelled);
                    return new CommandHandler.StopResult(true, cancelled);
                }).when(handle).stop();
        register(206L, handle);
        AtomicBoolean interrupted = new AtomicBoolean();
        AtomicReference<Throwable> unexpected = new AtomicReference<>();
        Thread caller = Thread.ofVirtual().start(() -> {
            try {
                assertThrows(ClientException.class, () -> manager.stop(10L, 206L));
                interrupted.set(Thread.currentThread().isInterrupted());
            } catch (Throwable failure) { unexpected.set(failure); }
        });
        try {
            caller.join(3000);
            assertFalse(caller.isAlive()); assertNull(unexpected.get()); assertTrue(interrupted.get());
            assertEquals("RUNNING", manager.listTasks(10L).getFirst().getStatus());
            verify(completion, never()).save(any(Task.class));
            assertEquals("CANCELLED", manager.stop(10L, 206L).getStatus());
        } finally { result.complete(cancelled); }
    }

    @Test void slowOutputSnapshotCannotBlockTheListOrReturnStaleOutputAfterCompletion() throws Exception {
        CompletableFuture<CommandResult> result = new CompletableFuture<>();
        CountDownLatch snapshotEntered = new CountDownLatch(1);
        CountDownLatch releaseSnapshot = new CountDownLatch(1);
        CountDownLatch saved = new CountDownLatch(1);
        CommandHandler handle = handle(result);
        doAnswer(invocation -> {
            snapshotEntered.countDown();
            assertTrue(releaseSnapshot.await(10, TimeUnit.SECONDS));
            return "stale partial";
        }).when(handle).outputSnapshot();
        doAnswer(invocation -> { saved.countDown(); return null; }).when(completion).save(any(Task.class));
        register(207L, handle);
        CompletableFuture<TaskVO> snapshot = CompletableFuture.supplyAsync(() -> manager.read(10L, 207L, false));
        try {
            assertTrue(snapshotEntered.await(3, TimeUnit.SECONDS));
            assertEquals("RUNNING", CompletableFuture.supplyAsync(() -> manager.listTasks(10L))
                    .get(1, TimeUnit.SECONDS).getFirst().getStatus());
            result.complete(new CommandResult(0, "final output", false, false));
            assertTrue(saved.await(3, TimeUnit.SECONDS));
            releaseSnapshot.countDown();
            TaskVO view = snapshot.get(3, TimeUnit.SECONDS);
            assertEquals("SUCCESS", view.getStatus());
            assertEquals("final output", view.getOutput());
        } finally {
            releaseSnapshot.countDown(); result.complete(new CommandResult(0, "final output", false, false));
            snapshot.get(3, TimeUnit.SECONDS);
        }
    }

    @Test void aStopCallerWaitingForCoordinationCanBeInterruptedWithoutControllingTheProcess() throws Exception {
        CompletableFuture<CommandResult> result = new CompletableFuture<>();
        CountDownLatch stopEntered = new CountDownLatch(1);
        CountDownLatch releaseStop = new CountDownLatch(1);
        CountDownLatch secondEntered = new CountDownLatch(1);
        AtomicBoolean interrupted = new AtomicBoolean();
        AtomicReference<Throwable> unexpected = new AtomicReference<>();
        CommandResult cancelled = new CommandResult(137, "stopped", false, false);
        CommandHandler handle = handle(result);
        doAnswer(invocation -> {
            stopEntered.countDown();
            assertTrue(releaseStop.await(10, TimeUnit.SECONDS));
            result.complete(cancelled);
            return new CommandHandler.StopResult(true, cancelled);
        }).when(handle).stop();
        register(208L, handle);
        CompletableFuture<TaskVO> first = CompletableFuture.supplyAsync(() -> manager.stop(10L, 208L));
        Thread second = null;
        try {
            assertTrue(stopEntered.await(3, TimeUnit.SECONDS));
            second = Thread.ofVirtual().start(() -> {
                secondEntered.countDown();
                try {
                    assertThrows(ClientException.class, () -> manager.stop(10L, 208L));
                    interrupted.set(Thread.currentThread().isInterrupted());
                } catch (Throwable failure) { unexpected.set(failure); }
            });
            assertTrue(secondEntered.await(3, TimeUnit.SECONDS));
            second.interrupt(); second.join(1000);
            assertFalse(second.isAlive()); assertNull(unexpected.get()); assertTrue(interrupted.get());
            verify(handle, times(1)).stop();
            assertFalse(first.isDone());
        } finally {
            releaseStop.countDown(); result.complete(cancelled);
            first.get(3, TimeUnit.SECONDS);
            if (second != null) second.join(3000);
        }
    }

    private CommandHandler handle(CompletableFuture<CommandResult> result) throws Exception {
        CommandHandler handle = mock(CommandHandler.class);
        when(handle.await()).thenAnswer(invocation -> result.get(10, TimeUnit.SECONDS));
        when(handle.outputSnapshot()).thenReturn("partial");
        when(handle.stop()).thenAnswer(invocation -> {
            CommandResult stopped = new CommandResult(137, "stopped", false, false);
            result.complete(stopped);
            return new CommandHandler.StopResult(true, stopped);
        });
        return handle;
    }

    private void register(long id, CommandHandler handle) {
        Task task = Task.builder().id(id).sessionId(10L).turnId(20L).command("controlled").build();
        records.add(task);
        when(repository.findById(id)).thenReturn(Optional.of(task));
        when(repository.queryPageBySessionId(1, 50, 10L)).thenAnswer(invocation -> new TaskPage(1, 50, records.size(), List.copyOf(records)));
        when(repository.findActiveBySessionId(10L)).thenReturn(List.of());
        manager.registerBackendProcess(new BackendProcess(task, handle));
    }
}
