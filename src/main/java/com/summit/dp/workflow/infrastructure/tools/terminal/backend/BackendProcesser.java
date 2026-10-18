package com.summit.dp.workflow.infrastructure.tools.terminal.backend;

import cn.hutool.core.util.IdUtil;
import com.summit.core.runtime.CommandHandler;
import com.summit.core.runtime.workspace.Workspace;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.domain.model.Task.TaskStatus;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import java.io.IOException;
import java.util.concurrent.TimeUnit;

/** 先保存任务身份，再启动命令，失败时保留可查询的执行事实。 */
@Component
@RequiredArgsConstructor
public class BackendProcesser {
    private final TaskRepository repository;
    private final ChatTurnRepository turns;
    private final BackendProcessManager manager;
    private final BackgroundTaskCompletion completion;

    public Long submit(String command, Long sessionId, Long turnId, Long executionId, Workspace workspace, long timeout, long maxChars)
            throws IOException, InterruptedException {
        return submit(command, null, sessionId, turnId, executionId, workspace, timeout, maxChars);
    }

    public Long submit(String command, String intention, Long sessionId, Long turnId, Long executionId,
                       Workspace workspace, long timeout, long maxChars) throws IOException, InterruptedException {
        throwIf(command == null || command.isBlank(), "后台命令不能为空");
        throwIf(intention != null && intention.length() > Task.MAX_INTENTION, "后台任务用途不能超过 " + Task.MAX_INTENTION + " 字符");
        throwIf(sessionId == null || turnId == null || workspace == null, "后台任务缺少会话、轮次或执行环境");
        throwIf(executionId == null || executionId <= 0, "后台任务缺少有效执行标识");
        ChatTurn turn = turns.findById(turnId).orElseThrow(ClientException::new);
        throwIf(!sessionId.equals(turn.getSessionId()), "轮次不属于当前会话");
        Task task = Task.builder().id(IdUtil.getSnowflakeNextId()).sessionId(sessionId).turnId(turnId)
                .executionId(executionId).command(command).intention(intention).build();
        repository.save(task);
        manager.notifyTaskChanged(task);
        CommandHandler handle = null;
        try {
            handle = workspace.bridge().commands().startCommand(command, workspace.workDir(), workspace.runtimeEnvironment().charset(),
                    timeout, TimeUnit.SECONDS, Math.min(maxChars, Task.MAX_OUTPUT));
            manager.registerBackendProcess(new BackendProcess(task, handle));
            return task.getId();
        } catch (IOException | InterruptedException | RuntimeException failure) {
            boolean stopped = true;
            if (handle != null) {
                try { handle.stop(); }
                catch (Exception cleanup) {
                    stopped = false;
                    failure.addSuppressed(cleanup);
                    if (cleanup instanceof InterruptedException) Thread.currentThread().interrupt();
                }
            }
            task.finish(stopped ? TaskStatus.FAILED : TaskStatus.LOST, "后台任务启动登记失败：" + failure.getMessage(), null, false);
            completion.save(task);
            manager.notifyTaskChanged(task);
            if (failure instanceof InterruptedException) Thread.currentThread().interrupt();
            throw failure;
        }
    }
    private void throwIf(boolean condition, String err) { if (condition) throw new ClientException(err); }
}
