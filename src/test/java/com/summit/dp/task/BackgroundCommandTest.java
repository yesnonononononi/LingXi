package com.summit.dp.task;

import com.summit.dp.workflow.application.input.BackgroundTaskChannel;
import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.Message;
import com.summit.core.runtime.CommandHandler;
import com.summit.core.runtime.RuntimeEnvironment;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopMessages;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.core.runtime.workspace.WorkspaceBridge;
import com.summit.core.runtime.workspace.WorkspaceCommands;
import com.summit.core.runtime.workspace.WorkspaceCommands.CommandResult;
import com.summit.core.tool.ToolDefinition;
import com.summit.core.tool.ToolExecuteResult;
import com.summit.core.tool.ToolExecution;
import com.summit.core.tool.ToolExecutor;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.sandbox_security.application.TerminalSecurityPolicy;
import com.summit.dp.sandbox_security.domain.model.SecurityAction;
import com.summit.dp.sandbox_security.domain.model.SecurityDecision;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.persistence.MyBatisTypeHandlers;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.task.api.controller.BackgroundTaskController;
import com.summit.dp.task.application.service.TaskDeletionPolicy;
import com.summit.dp.task.application.vo.TaskVO;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.domain.model.Task.TaskStatus;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.task.infrastructure.persistence.mapper.TaskMapper;
import com.summit.dp.task.infrastructure.persistence.po.TaskPO;
import com.summit.dp.task.infrastructure.repository.TaskRepositoryImpl;
import com.summit.dp.tools.application.port.ToolCatalog;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.application.input.InputWakeupService;
import com.summit.dp.workflow.infrastructure.tools.config.AnnotatedToolTestDefinitions;
import com.summit.dp.workflow.infrastructure.tools.config.CommonToolConfiguration;
import com.summit.dp.workflow.infrastructure.tools.config.properties.CommandToolProperties;
import com.summit.dp.workflow.infrastructure.tools.terminal.CommandToolDefinitionExecutor;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.*;
import com.summit.runtime.workspace.LocalWorkspace;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class BackgroundCommandTest {
    @TempDir Path temporary;
    private H2TestDatabase database;
    private TaskMapper mapper;
    private TaskRepository repository;
    private BackendProcessManager manager;
    private BackendProcesser submitter;
    private final List<String> changedStatuses = new CopyOnWriteArrayList<>();
    private Workspace workspace;
    private final InputWakeupService coordinator = mock(InputWakeupService.class);
    private final ObjectMapper json = new ObjectMapper().findAndRegisterModules();

    @BeforeEach void setup() throws Exception {
        database = H2TestDatabase.create("BackgroundCommandTest");
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(true);
        MyBatisTypeHandlers.registerAll(configuration);
        configuration.addMapper(TaskMapper.class);
        MybatisPlusInterceptor plugins = new MybatisPlusInterceptor();
        plugins.addInnerInterceptor(new PaginationInnerInterceptor(DbType.H2));
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database); factory.setConfiguration(configuration); factory.setPlugins(plugins);
        SqlSessionFactory sessionFactory = factory.getObject();
        mapper = H2TestDatabase.sqlSession(sessionFactory).getMapper(TaskMapper.class);
        repository = new TaskRepositoryImpl(mapper);
        BackgroundTaskBroadcaster broadcaster = mock(BackgroundTaskBroadcaster.class);
        doAnswer(invocation -> {
            Task task = invocation.getArgument(0);
            assertEquals(task.getStatus(), repository.findById(task.getId()).orElseThrow().getStatus());
            changedStatuses.add(task.getStatus().name());
            return null;
        }).when(broadcaster).publishChanged(any(Task.class));
        manager = new BackendProcessManager(repository, broadcaster, new BackgroundTaskCompletion(repository, coordinator), mock(TaskDeletionPolicy.class));
        ChatTurnRepository turns = mock(ChatTurnRepository.class);
        when(turns.findById(20L)).thenReturn(Optional.of(ChatTurn.builder().id(20L).sessionId(10L).build()));
        submitter = new BackendProcesser(repository, turns, manager, new BackgroundTaskCompletion(repository, coordinator));
        workspace = new LocalWorkspace("background-test", temporary.toString());
        Files.writeString(temporary.resolve("Child.java"), """
                public class Child {
                    public static void main(String[] args) throws Exception {
                        System.out.print("ready:" + ProcessHandle.current().pid() + "\\n"); System.out.flush();
                        Thread.sleep(Long.parseLong(args[0]));
                        System.out.print("done"); System.exit(Integer.parseInt(args[1]));
                    }
                }
                """, StandardCharsets.UTF_8);
    }
    @AfterEach void shutdown() { if (manager != null) manager.close(); if (database != null) database.shutdown(); }

    @Test void backgroundToolReturnsRealIdAndPersistsFailureOutputWithoutBlocking() throws Exception {
        CommandToolDefinitionExecutor executor = new CommandToolDefinitionExecutor(json, null, submitter);
        ToolExecution call = call(executor, Map.of("command", command(1200, 7), "background", true, "intention", "验证后台输出"), 15);
        ToolExecuteResult receipt = assertTimeout(Duration.ofSeconds(3), () -> executor.execute(call));
        assertTrue(receipt.isSuccess(), receipt.toString());
        JsonNode data = json.readTree(receipt.getToolOutput());
        assertTrue(data.get("taskId").isTextual());
        Long id = Long.valueOf(data.get("taskId").asText());
        Task registered = repository.findById(id).orElseThrow();
        assertEquals(10L, registered.getSessionId()); assertEquals(20L, registered.getTurnId());
        assertEquals(1L, registered.getExecutionId());
        assertEquals(command(1200, 7), registered.getCommand());
        assertEquals("验证后台输出", registered.getIntention());
        assertNull(registered.getCompleteAt());
        await(() -> manager.read(10L, id, false).getOutput().contains("ready:"));
        assertEquals("RUNNING", manager.read(10L, id, false).getStatus());
        await(() -> "FAILED".equals(repository.findById(id).orElseThrow().getStatus().name()));
        Task completed = repository.findById(id).orElseThrow();
        assertEquals(7, completed.getExitCode()); assertTrue(completed.getOutput().endsWith("done"));
        assertNotNull(completed.getCompleteAt()); assertNotNull(completed.getCreateAt());
        assertEquals(completed.getOutput(), manager.read(10L, id, false).getOutput());
        assertEquals(7, manager.stop(10L, id).getExitCode());
        assertEquals(1, manager.listTasks(10L).size()); assertTrue(manager.listTasks(99L).isEmpty());
        await(() -> changedStatuses.contains("FAILED"));
        assertEquals(List.of("PENDING", "RUNNING", "FAILED"), changedStatuses);
        verify(coordinator).resumeIfInputPending(1L);
        Execution execution = Execution.builder().id("1").messages(new ArrayList<Message>())
                .agentRequest(AgentRequest.builder().runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, "10")).build()).build()).build();
        BackgroundTaskLoopInterceptor notifications = new BackgroundTaskLoopInterceptor(new BackgroundTaskChannel(repository, new BackgroundTaskNotifications()));
        notifications.onBeforeModelInvoke(LoopContext.builder().loopMessages(LoopMessages.builder().execution(execution).build()).signal(new ExecutionControlSignal("1")).consecutiveCompactTurns(() -> 0).appendMessage(execution.getMessages()::addAll).build());
        assertEquals(1, execution.getMessages().size());
        assertTrue(execution.getMessages().getFirst().text().contains("status=FAILED, exitCode=7"));
        assertTrue(execution.getMessages().getFirst().text().contains("done"));
    }

    @Test void stopConfirmsProcessExitAndDoesNotAllowAnotherSessionToControlIt() throws Exception {
        Long id = submitter.submit(command(60_000, 0), 10L, 20L, 100L, workspace, 80, 4096);
        await(() -> manager.read(10L, id, false).getOutput().contains("ready:"));
        long pid = Long.parseLong(manager.read(10L, id, false).getOutput().strip().substring("ready:".length()));
        assertThrows(ClientException.class, () -> manager.read(99L, id, false));
        assertThrows(ClientException.class, () -> manager.stop(99L, id));
        assertTrue(ProcessHandle.of(pid).orElseThrow().isAlive());
        TaskVO stopped = manager.stop(10L, id);
        assertEquals("CANCELLED", stopped.getStatus());
        assertFalse(ProcessHandle.of(pid).map(ProcessHandle::isAlive).orElse(false));
        Thread.sleep(100);
        assertEquals(TaskStatus.CANCELLED, repository.findById(id).orElseThrow().getStatus());
        assertEquals(stopped.getCompleteAt().toEpochMilli(), manager.stop(10L, id).getCompleteAt().toEpochMilli());
    }

    @Test void timeoutSettlesWithoutPollingOrAwaitingAndCapsRetainedOutput() throws Exception {
        Long id = submitter.submit(command(60_000, 0), 10L, 20L, 100L, workspace, 2, 5);
        // 不用固定 sleep 等墙钟：后台超时靠自己的调度线程结算，机器被并行构建抢占时
        // 3.5 秒可能还不够（实测并发下会假红成 RUNNING）。改成有界轮询等「结算完成」这个事实，
        // 断言内容不变 —— 仍然是「不轮询、不阻塞等待就能结算」。
        await(() -> repository.findById(id).orElseThrow().getStatus() == TaskStatus.TIMEOUT);
        Task task = repository.findById(id).orElseThrow();
        assertEquals(TaskStatus.TIMEOUT, task.getStatus());
        assertEquals(5, task.getOutput().length()); assertTrue(task.isTruncated());
    }

    @Test void configuredBackgroundTimeoutTerminatesBeforeTheForegroundToolDeadline() throws Exception {
        CommandToolProperties properties = new CommandToolProperties();
        properties.setBackgroundTimeout(Duration.ofSeconds(2));
        CommandToolDefinitionExecutor executor = new CommandToolDefinitionExecutor(json, null, submitter, properties);
        ToolExecuteResult receipt = executor.execute(call(executor,
                Map.of("command", command(60_000, 0), "background", true), 30));
        assertTrue(receipt.isSuccess(), receipt.getToolOutput());
        Long taskId = Long.valueOf(json.readTree(receipt.getToolOutput()).get("taskId").asText());
        await(() -> repository.findById(taskId).orElseThrow().getStatus() == TaskStatus.TIMEOUT);
        assertNotNull(repository.findById(taskId).orElseThrow().getCompleteAt());
    }

    @Test void startupFailureIsDurableAndTurnOwnershipIsCheckedBeforeLaunching() throws Exception {
        Workspace failing = mock(Workspace.class);
        WorkspaceBridge bridge = mock(WorkspaceBridge.class);
        WorkspaceCommands commands = mock(WorkspaceCommands.class);
        when(failing.bridge()).thenReturn(bridge); when(bridge.commands()).thenReturn(commands);
        when(failing.workDir()).thenReturn(temporary.toString());
        when(failing.runtimeEnvironment()).thenReturn(RuntimeEnvironment.builder().charset(StandardCharsets.UTF_8).build());
        when(commands.startCommand(anyString(), any(), anyString(), any(), anyLong(), any(), anyLong())).thenThrow(new IOException("spawn failed"));
        assertThrows(ClientException.class, () -> submitter.submit("echo test", 99L, 20L, 100L, failing, 10, 100));
        verifyNoInteractions(commands);
        assertThrows(IOException.class, () -> submitter.submit("echo test", 10L, 20L, 100L, failing, 10, 100));
        List<TaskPO> rows = mapper.selectList(null);
        assertEquals(1, rows.size()); assertEquals("FAILED", rows.getFirst().getStatus());
        assertNotNull(rows.getFirst().getCompleteAt()); assertTrue(rows.getFirst().getOutput().contains("spawn failed"));
    }

    @Test void restartMarksUnfinishedTasksLostWithoutChangingCompletedResults() {
        Task pending = Task.builder().id(100L).sessionId(10L).turnId(20L).command("never replay").build();
        repository.save(pending);
        Task finished = Task.builder().id(101L).sessionId(10L).turnId(20L).command("done").build();
        finished.finish(TaskStatus.FAILED, "保留中文结果", 9, true); repository.save(finished);
        manager.recoverUnfinished(); manager.recoverUnfinished();
        assertEquals(TaskStatus.LOST, repository.findById(100L).orElseThrow().getStatus());
        Task restored = repository.findById(101L).orElseThrow();
        assertEquals(TaskStatus.FAILED, restored.getStatus()); assertEquals("保留中文结果", restored.getOutput());
        assertEquals(9, restored.getExitCode()); assertTrue(restored.isTruncated());
        assertEquals(finished.getCompleteAt().toEpochMilli(), restored.getCompleteAt().toEpochMilli());
    }

    @Test void failedCancellationDoesNotInventCancelledStateAndCanBeRetried() throws Exception {
        CompletableFuture<CommandResult> completion = new CompletableFuture<>();
        CommandHandler handle = mock(CommandHandler.class);
        when(handle.await()).thenAnswer(invocation -> completion.get(10, TimeUnit.SECONDS));
        when(handle.outputSnapshot()).thenReturn("still running");
        when(handle.stop()).thenThrow(new IOException("cancel denied"))
                .thenAnswer(invocation -> { CommandResult result = new CommandResult(137, "stopped", false, false);
                    completion.complete(result); return new CommandHandler.StopResult(true, result); });
        Task task = Task.builder().id(102L).sessionId(10L).turnId(20L).command("controlled").build(); repository.save(task);
        manager.registerBackendProcess(new BackendProcess(task, handle));
        assertThrows(ClientException.class, () -> manager.stop(10L, 102L));
        assertEquals(TaskStatus.RUNNING, repository.findById(102L).orElseThrow().getStatus());
        assertEquals("CANCELLED", manager.stop(10L, 102L).getStatus());
    }

    @Test void transientPersistenceFailureKeepsActualResultUntilItCanBeSaved() throws Exception {
        TaskRepository flaky = spy(repository);
        AtomicInteger failures = new AtomicInteger();
        doAnswer(invocation -> {
            Task task = invocation.getArgument(0);
            if (task.getStatus().isTerminal() && failures.getAndIncrement() == 0) throw new IllegalStateException("db unavailable");
            return invocation.callRealMethod();
        }).when(flaky).updateById(any(Task.class));
        BackendProcessManager retrying = new BackendProcessManager(flaky, mock(BackgroundTaskBroadcaster.class), new BackgroundTaskCompletion(flaky, mock(InputWakeupService.class)), mock(TaskDeletionPolicy.class));
        CommandHandler handle = mock(CommandHandler.class);
        when(handle.await()).thenReturn(new CommandResult(7, "actual failure", false, false));
        Task task = Task.builder().id(103L).sessionId(10L).turnId(20L).command("completed").build(); repository.save(task);
        try {
            retrying.registerBackendProcess(new BackendProcess(task, handle));
            await(() -> failures.get() > 0);
            assertEquals("actual failure", retrying.read(10L, 103L, false).getOutput());
            await(() -> repository.findById(103L).orElseThrow().getStatus().isTerminal());
            assertEquals(7, repository.findById(103L).orElseThrow().getExitCode());
        } finally { retrying.close(); }
    }

    @Test void manageToolRetainsSessionIdentityAndBackgroundStillHonorsSecurityDeny() throws Exception {
        Task task = Task.builder().id(104L).sessionId(99L).turnId(20L).command("private").build(); repository.save(task);
        ManageCommandToolExecutor manage = new ManageCommandToolExecutor(json, manager);
        ToolExecuteResult deniedRead = manage.execute(call(manage, Map.of("action", "read", "taskId", "104"), 10));
        assertFalse(deniedRead.isSuccess());
        TerminalSecurityPolicy security = mock(TerminalSecurityPolicy.class);
        when(security.evaluate(anyString(), any())).thenReturn(new SecurityDecision(SecurityAction.DENY, "policy", "PROGRAM", null));
        BackendProcesser forbidden = mock(BackendProcesser.class);
        CommandToolDefinitionExecutor executor = new CommandToolDefinitionExecutor(json, security, forbidden);
        assertFalse(executor.execute(call(executor, Map.of("command", "echo test", "background", true), 10)).isSuccess());
        verifyNoInteractions(forbidden);
    }

    @Test void terminalStateAndCompletionTimeCannotBeOverwritten() {
        Task task = Task.builder().id(105L).build();
        task.transferTo(TaskStatus.RUNNING); assertNull(task.getCompleteAt());
        task.finish(TaskStatus.FAILED, "first", 7, true);
        task.finish(TaskStatus.SUCCESS, "second", 0, false);
        assertEquals(TaskStatus.FAILED, task.getStatus()); assertEquals("first", task.getOutput());
        assertEquals(7, task.getExitCode()); assertTrue(task.isTruncated());
        assertThrows(ClientException.class, () -> task.transferTo(TaskStatus.RUNNING));
    }

    @Test void taskIdentityIsPersistedBeforeStartingTheCommandAndFastResultsAreRetained() throws Exception {
        Workspace controlled = mock(Workspace.class);
        WorkspaceBridge bridge = mock(WorkspaceBridge.class);
        WorkspaceCommands commands = mock(WorkspaceCommands.class);
        when(controlled.bridge()).thenReturn(bridge); when(bridge.commands()).thenReturn(commands);
        when(controlled.workDir()).thenReturn(temporary.toString());
        when(controlled.runtimeEnvironment()).thenReturn(RuntimeEnvironment.builder().charset(StandardCharsets.UTF_8).build());
        CommandHandler handle = mock(CommandHandler.class);
        when(handle.await()).thenReturn(new CommandResult(8, "already exited", false, false));
        when(commands.startCommand(anyString(), any(), anyString(), any(), anyLong(), any(), anyLong())).thenAnswer(invocation -> {
            List<TaskPO> rows = mapper.selectList(null);
            assertEquals(1, rows.size()); assertEquals("PENDING", rows.getFirst().getStatus());
            assertNotNull(rows.getFirst().getId()); return handle;
        });
        Long id = submitter.submit("echo test", 10L, 20L, 100L, controlled, 10, 100);
        await(() -> repository.findById(id).orElseThrow().getStatus().isTerminal());
        assertEquals(8, repository.findById(id).orElseThrow().getExitCode());
        assertEquals("already exited", manager.read(10L, id, false).getOutput());
        verify(commands, never()).execute(anyString(), any(), anyString(), any(), anyLong(), any(), anyLong());
    }

    @Test void outputSnapshotFailureDoesNotPreventStoppingTheProcess() throws Exception {
        CompletableFuture<CommandResult> completion = new CompletableFuture<>();
        CommandHandler handle = mock(CommandHandler.class);
        when(handle.await()).thenAnswer(invocation -> completion.get(10, TimeUnit.SECONDS));
        when(handle.outputSnapshot()).thenThrow(new IllegalStateException("bad output"));
        when(handle.stop()).thenAnswer(invocation -> {
            CommandResult result = new CommandResult(137, "stopped", false, false);
            completion.complete(result); return new CommandHandler.StopResult(true, result);
        });
        Task task = Task.builder().id(106L).sessionId(10L).turnId(20L).command("controlled").build(); repository.save(task);
        manager.registerBackendProcess(new BackendProcess(task, handle));
        assertEquals("CANCELLED", assertDoesNotThrow(() -> manager.stop(10L, 106L)).getStatus());
        verify(handle, never()).outputSnapshot();
    }

    @Test void runtimeEndpointsAndToolSchemaExposeReadAndStopForPersistedTaskIds() throws Exception {
        Task task = Task.builder().id(107L).sessionId(10L).turnId(20L).command("finished").build();
        task.finish(TaskStatus.FAILED, "output", 7, false); repository.save(task);
        MockMvc mvc = MockMvcBuilders.standaloneSetup(new BackgroundTaskController(manager)).build();
        mvc.perform(get("/task/runtime/107").param("sessionId", "10"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.data.exitCode").value(7));
        mvc.perform(post("/task/runtime/107/stop").param("sessionId", "10"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.data.status").value("FAILED"));
        CommonToolConfiguration configuration = new CommonToolConfiguration();
        ToolDefinition<?> execute = AnnotatedToolTestDefinitions.create(CommandToolDefinitionExecutor.class, new CommandToolDefinitionExecutor(json, null, submitter, new CommandToolProperties()));
        assertTrue(json.readTree(execute.parametersJsonSchema()).path("properties").has("background"));
        assertEquals(ToolCatalog.MANAGE_COMMAND, AnnotatedToolTestDefinitions.create(ManageCommandToolExecutor.class, new ManageCommandToolExecutor(json, manager)).name());
        assertTrue(ToolCatalog.DEFAULT_AGENT_TOOLS.contains(ToolCatalog.MANAGE_COMMAND));
        ManageCommandToolExecutor manage = new ManageCommandToolExecutor(json, manager);
        ToolExecuteResult result = manage.execute(call(manage, Map.of("action", "read", "taskId", "107"), 10));
        assertFalse(manage.requiresWorkspace());
        assertTrue(result.isSuccess(), result.getToolOutput());
        assertEquals(7, json.readTree(result.getToolOutput()).get("exitCode").asInt());
    }

    @Test void completionWorkerDoesNotWriteAgainAfterStopAlreadyPersistedTheFinalResult() throws Exception {
        TaskRepository tracked = spy(repository);
        BackendProcessManager coordinated = new BackendProcessManager(tracked, mock(BackgroundTaskBroadcaster.class), new BackgroundTaskCompletion(tracked, mock(InputWakeupService.class)), mock(TaskDeletionPolicy.class));
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        AtomicReference<Thread> worker = new AtomicReference<>();
        CommandResult result = new CommandResult(137, "stopped", false, false);
        CommandHandler handle = mock(CommandHandler.class);
        when(handle.await()).thenAnswer(invocation -> {
            worker.set(Thread.currentThread()); entered.countDown();
            assertTrue(release.await(5, TimeUnit.SECONDS)); return result;
        });
        when(handle.outputSnapshot()).thenReturn("running");
        when(handle.stop()).thenReturn(new CommandHandler.StopResult(true, result));
        Task task = Task.builder().id(108L).sessionId(10L).turnId(20L).command("controlled").build(); repository.save(task);
        try {
            coordinated.registerBackendProcess(new BackendProcess(task, handle));
            assertTrue(entered.await(3, TimeUnit.SECONDS));
            assertEquals("CANCELLED", coordinated.stop(10L, 108L).getStatus());
            release.countDown(); worker.get().join(3000);
            assertFalse(worker.get().isAlive());
            verify(tracked, times(2)).updateById(any(Task.class));
        } finally { release.countDown(); coordinated.close(); }
    }

    @Test void interruptedStartupPersistsFailureAndRestoresTheInterruptFlag() throws Exception {
        Workspace controlled = mock(Workspace.class);
        WorkspaceBridge bridge = mock(WorkspaceBridge.class);
        WorkspaceCommands commands = mock(WorkspaceCommands.class);
        when(controlled.bridge()).thenReturn(bridge); when(bridge.commands()).thenReturn(commands);
        when(controlled.workDir()).thenReturn(temporary.toString());
        when(controlled.runtimeEnvironment()).thenReturn(RuntimeEnvironment.builder().charset(StandardCharsets.UTF_8).build());
        when(commands.startCommand(anyString(), any(), anyString(), any(), anyLong(), any(), anyLong()))
                .thenThrow(new InterruptedException("interrupted startup"));
        try {
            assertThrows(InterruptedException.class, () -> submitter.submit("echo test", 10L, 20L, 100L, controlled, 10, 100));
            assertTrue(Thread.interrupted());
            List<TaskPO> tasks = mapper.selectList(null);
            assertEquals(1, tasks.size()); assertEquals("FAILED", tasks.getFirst().getStatus());
            assertNotNull(tasks.getFirst().getCompleteAt());
        } finally { Thread.interrupted(); }
    }

    @Test void oldRunningTasksRemainListedEvenAfterFiftyNewerCompletedTasks() {
        repository.save(Task.builder().id(1L).sessionId(10L).turnId(20L).command("long running").build());
        for (long id = 2; id <= 52; id++) {
            Task task = Task.builder().id(id).sessionId(10L).turnId(20L).command("finished").build();
            task.finish(TaskStatus.SUCCESS, "", 0, false); repository.save(task);
        }
        List<TaskVO> tasks = manager.listTasks(10L);
        assertEquals(51, tasks.size());
        assertTrue(tasks.stream().anyMatch(task -> task.getId() == 1L && "PENDING".equals(task.getStatus())));
        assertTrue(tasks.stream().allMatch(task -> task.getOutput() == null));
    }

    @Test void executionTaskQueryChecksBothOwnersAndKeepsAllResultsBeyondTheHistoryPage() {
        for (long id = 1; id <= 55; id++) {
            Task task = Task.builder().id(id).sessionId(10L).turnId(20L).executionId(100L).command("finished").build();
            task.finish(TaskStatus.SUCCESS, "done", 0, false);
            repository.save(task);
        }
        repository.save(Task.builder().id(56L).sessionId(10L).turnId(21L).executionId(101L).command("other execution").build());
        repository.save(Task.builder().id(57L).sessionId(11L).turnId(22L).executionId(100L).command("other session").build());
        assertEquals(55, repository.findByExecutionId(10L, 100L).size());
        assertEquals(List.of(56L), repository.findByExecutionId(10L, 101L).stream().map(Task::getId).toList());
        assertEquals(List.of(57L), repository.findByExecutionId(11L, 100L).stream().map(Task::getId).toList());
        assertEquals(100L, repository.findById(1L).orElseThrow().getExecutionId());
    }

    private ToolExecution call(ToolExecutor executor, Map<String, Object> args, long timeout) throws Exception {
        return ToolExecution.builder().id("call").executionId("1").turnId("1").workspace(workspace)
                .eventMetaData(Map.of(ExecutionEventMetadata.TURN_ID, "20"))
                .attributes(Map.of(ExecutionAttributes.SESSION_ID, 10L)).args(json.writeValueAsString(args))
                .toolDefinition(ToolDefinition.builder().id("terminal-test").name("terminal-test").executor(executor).timeout(timeout).maxOutput(4096).build()).build();
    }
    private String command(long millis, int exit) {
        String java = Path.of(System.getProperty("java.home"), "bin", "java").toString();
        return "\"" + java + "\" \"" + temporary.resolve("Child.java") + "\" " + millis + " " + exit;
    }
    private void await(BooleanSupplier condition) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(12);
        while (!condition.getAsBoolean() && System.nanoTime() < deadline) Thread.sleep(20);
        assertTrue(condition.getAsBoolean(), "等待后台状态超时");
    }
}
