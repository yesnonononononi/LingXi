package com.summit.dp.workflow.infrastructure.tools.terminal.backend;

import com.summit.core.runtime.CommandHandler;
import com.summit.core.runtime.workspace.WorkspaceCommands.CommandResult;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.task.application.vo.TaskVO;
import com.summit.dp.task.application.service.TaskRuntimeService;
import com.summit.dp.task.application.service.TaskDeletionPolicy;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.domain.model.Task.TaskStatus;
import com.summit.dp.task.domain.repository.TaskRepository;
import jakarta.annotation.PreDestroy;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;
import java.io.IOException;
import java.util.List;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** 进程输出由框架读取，业务只登记句柄并持久化一次终态。 */
@Component
@RequiredArgsConstructor
@Slf4j
public class BackendProcessManager implements TaskRuntimeService {
    private final TaskRepository repository;
    private final BackgroundTaskBroadcaster broadcaster;
    private final BackgroundTaskCompletion completion;
    private final TaskDeletionPolicy deletionPolicy;
    private final ConcurrentHashMap<Long, BackendProcess> processes = new ConcurrentHashMap<>();
    private volatile boolean closed;

    public synchronized void registerBackendProcess(BackendProcess process) {
        Task task = process.getTask();
        throwIf(closed, "后台任务服务正在关闭");
        throwIf(processes.putIfAbsent(task.getId(), process) != null, "后台任务标识已登记");
        try {
            task.transferTo(TaskStatus.RUNNING);
            repository.updateById(task);
            notifyTaskChanged(task);
        } catch (RuntimeException failure) { processes.remove(task.getId(), process); throw failure; }
        Thread.ofVirtual().start(() -> {
            CommandResult result = null;
            Exception executionFailure = null;
            try { result = process.getHandle().await(); }
            catch (Exception failure) { executionFailure = failure; }
            synchronized (process) {
                if (!task.getStatus().isTerminal()) {
                    if (executionFailure == null) {
                        task.finish(result.timedOut() ? TaskStatus.TIMEOUT : result.isSuccess() ? TaskStatus.SUCCESS : TaskStatus.FAILED,
                                result.output(), result.exitCode(), result.truncated());
                    } else {
                        task.finish(TaskStatus.FAILED, "后台任务执行失败：" + executionFailure.getMessage(), null, false);
                    }
                }
            }
            // 落库失败时保留句柄与原始结果，不能把暂时的存储故障改写成命令失败。
            while (!closed) {
                try { persistAndRemove(process); return; }
                catch (RuntimeException failure) {
                    log.warn("保存后台任务终态失败: taskId={}, reason={}", task.getId(), failure.toString());
                    try { Thread.sleep(1000); }
                    catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); return; }
                }
            }
        });
    }





    public void notifyTaskChanged(Task task) { broadcaster.publishChanged(task); }


    @Override
    public TaskVO read(Long sessionId, Long taskId, boolean join) {
        throwIf(sessionId == null || taskId == null, "会话标识和任务标识不能为空");
        BackendProcess process = processes.get(taskId);
        if (process != null) {
            Task task = process.getTask();
            synchronized (process) {
                throwIf(!sessionId.equals(task.getSessionId()), "任务不属于当前会话");
                if (task.getStatus().isTerminal()) return toView(task, task.getOutput());
                if (!join) return toView(task, process.getHandle().outputSnapshot());
            }
            CommandResult result;
            // 等待时释放任务锁，停止请求和完成线程才能正常收口。
            try { result = process.getHandle().await(); }
            catch (InterruptedException failure) {
                Thread.currentThread().interrupt();
                throw new ClientException("等待后台任务结果时被中断，任务仍可查询或停止");
            } catch (IOException failure) {
                throw new ClientException("读取后台任务结果失败：" + failure.getMessage());
            }
            synchronized (process) {
                // 完成线程可能尚未落定；返回的输出、状态和退出码必须来自同一个结果。
                if (!task.getStatus().isTerminal()) {
                    task.finish(result.timedOut() ? TaskStatus.TIMEOUT : result.isSuccess() ? TaskStatus.SUCCESS : TaskStatus.FAILED,
                            result.output(), result.exitCode(), result.truncated());
                }
                persistAndRemove(process);
                return toView(task, task.getOutput());
            }
        }
        Task task = repository.findById(taskId).orElseThrow(ClientException::new);
        throwIf(!sessionId.equals(task.getSessionId()), "任务不属于当前会话");
        return toView(task, task.getOutput());
    }

    public List<TaskVO> listTasks(Long sessionId) {
        throwIf(sessionId == null, "会话标识不能为空");
        Map<Long, Task> tasks = new LinkedHashMap<>();
        repository.queryPageBySessionId(1, 50, sessionId).records().forEach(task -> tasks.put(task.getId(), task));
        // 旧的长任务不能被最近 50 条历史挤掉，否则界面运行计数会漏报。
        repository.findActiveBySessionId(sessionId).forEach(task -> tasks.put(task.getId(), task));
        List<TaskVO> result = new ArrayList<>();
        for (Task task : tasks.values()) {
            BackendProcess process = processes.get(task.getId());
            TaskVO summary;
            if (process == null) summary = toView(task, null);
            else synchronized (process) { summary = toView(process.getTask(), null); }
            if (summary.getCommand().length() > 256) summary.setCommand(summary.getCommand().substring(0, 256) + "…");
            result.add(summary);
        }
        return result;
    }

    public TaskVO stop(Long sessionId, Long taskId) {
        throwIf(sessionId == null || taskId == null, "会话标识和任务标识不能为空");
        BackendProcess process = processes.get(taskId);
        if (process == null) {
            TaskVO current = read(sessionId, taskId, false);
            throwIf("RUNNING".equals(current.getStatus()) || "PENDING".equals(current.getStatus()), "任务当前没有可控制的进程，请刷新状态");
            return current;
        }
        synchronized (process) {
            try {
                Task task = process.getTask();
                throwIf(!sessionId.equals(task.getSessionId()), "任务不属于当前会话");
                if (!task.getStatus().isTerminal()) {
                    CommandHandler.StopResult stopped = process.getHandle().stop();
                    CommandResult result = stopped.result();
                    task.finish(stopped.stopped() ? TaskStatus.CANCELLED : result.timedOut() ? TaskStatus.TIMEOUT
                                    : result.isSuccess() ? TaskStatus.SUCCESS : TaskStatus.FAILED,
                            result.output(), result.exitCode(), result.truncated());
                }
                persistAndRemove(process);
                return toView(task, task.getOutput());
            } catch (IOException failure) { throw new ClientException("未能确认后台任务已停止：" + failure.getMessage()); }
            catch (InterruptedException failure) {
                Thread.currentThread().interrupt();
                throw new ClientException("等待后台任务停止时被中断，尚未确认停止");
            }
        }
    }

    /**
     * 只删已结束的任务：运行中的行还挂着进程句柄，先删记录就再没有收口依据了。
     */
    public void deleteTask(Long sessionId, Long taskId) {
        throwIf(sessionId == null || taskId == null, "会话标识和任务标识不能为空");
        BackendProcess process = processes.get(taskId);
        if (process != null) {
            synchronized (process) {
                Task running = process.getTask();
                throwIf(!sessionId.equals(running.getSessionId()), "任务不属于当前会话");
                throwIf(!running.getStatus().isTerminal(), "任务仍在运行，请先停止再删除");
            }
        }
        Task task = repository.findById(taskId).orElseThrow(ClientException::new);
        throwIf(!sessionId.equals(task.getSessionId()), "任务不属于当前会话");
        deletionPolicy.validate(task);
        repository.delete(task);
        notifyTaskChanged(task);
    }

    @EventListener(ApplicationReadyEvent.class)
    public void recoverUnfinished() {
        for (Task task : repository.findUnfinished()) {
            if (processes.containsKey(task.getId())) continue;
            task.finish(TaskStatus.LOST, "应用已重启，原任务的执行状态无法确认，未自动重放命令", null, false);
            completion.save(task);
            notifyTaskChanged(task);
        }
    }

    @PreDestroy public synchronized void close() {
        closed = true;
        for (BackendProcess process : processes.values()) {
            try { stop(process.getTask().getSessionId(), process.getTask().getId()); }
            catch (RuntimeException failure) { log.warn("关闭后台任务失败: taskId={}, reason={}", process.getTask().getId(), failure.toString()); }
        }
    }

    private void persistAndRemove(BackendProcess process) {
        synchronized (process) {
            if (processes.get(process.getTask().getId()) != process) return;
            completion.save(process.getTask());
            processes.remove(process.getTask().getId(), process);
            notifyTaskChanged(process.getTask());
        }
    }

    private TaskVO toView(Task task, String output) {
        return TaskVO.builder()
                .id(task.getId())
                .sessionId(task.getSessionId())
                .turnId(task.getTurnId())
                .command(task.getCommand())
                .status(task.getStatus().name())
                .output(output)
                .intention(task.getIntention())
                .exitCode(task.getExitCode())
                .truncated(task.isTruncated())
                .createAt(task.getCreateAt())
                .completeAt(task.getCompleteAt())
                .build();
    }
    private void throwIf(boolean condition, String err) { if (condition) throw new ClientException(err); }
}
