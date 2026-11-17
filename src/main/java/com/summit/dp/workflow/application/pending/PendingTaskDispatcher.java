package com.summit.dp.workflow.application.pending;

import cn.hutool.core.codec.Base64;
import com.summit.core.agent.Image;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.execution.domain.model.ExecutionStatus;
import com.summit.dp.session.application.service.SessionTreeDeleted;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.workflow.application.chat.ChatCommand;
import com.summit.dp.workflow.application.chat.PreparedChatExecutor;
import com.summit.dp.workflow.application.chat.RequestPreparer;
import com.summit.dp.workflow.application.chat.RuntimeContext;
import com.summit.dp.workflow.domain.pending.model.PendingAttachment;
import com.summit.dp.workflow.domain.pending.model.PendingTask;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionalEventListener;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * 待发送任务的接力派发：轮次结束事件为主，500ms 扫描只作兜底。
 *
 * <p><b>为什么主路径要事件驱动</b>：轮询只能保证「迟早会发」，用户看到的是几百毫秒的空窗；
 * 而且每个会话都要扫一遍执行状态。事件在锁外到达，天然知道「上一轮已经收尾」。</p>
 *
 * <p><b>为什么还留轮询</b>：事件只覆盖「正常结束」这一条路。启动遗留、用户点继续、
 * 提交失败后人工恢复都可能让队列停在可派发状态而没有事件 —— 兜底扫描认的是 DB 事实。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class PendingTaskDispatcher {

    private final PendingTaskService pendingTasks;
    private final PendingAttachmentStore attachments;
    private final PendingTaskAdmission admission;
    private final RequestPreparer requestPreparer;
    private final PreparedChatExecutor chatExecutor;
    private final SessionExecutionRegistry sessionExecutionRegistry;
    private final ExecutionQueryService executionStates;
    private final SessionRepository sessionRepository;

    private final Set<Long> checking = ConcurrentHashMap.newKeySet();
    private final ScheduledExecutorService scanner = Executors.newSingleThreadScheduledExecutor(
            Thread.ofPlatform().daemon().name("pending-task-scan").factory());
    private final ExecutorService workers = Executors.newVirtualThreadPerTaskExecutor();

    @PostConstruct
    void start() {
        // 提交与控制槽释放可能来自不同线程，复查要能覆盖「通知早于收尾」的窗口。
        scanner.scheduleWithFixedDelay(this::scan, 0, 500, TimeUnit.MILLISECONDS);
    }

    /**
     * 事件入口：把该会话最早一条可派发任务接上。
     *
     * <p>调用时上一轮的会话锁已经退出；这里仍要自己再取一次 {@code control:} 锁，
     * 因为「用户点继续」「兜底扫描」可能同时进来。</p>
     */
    public void relay(long sessionId) {
        if (sessionExecutionRegistry.isRootRunning(sessionId) || ExecutionCoordination.isResumingSession(sessionId)) {
            return;
        }
        synchronized (ExecutionCoordination.monitor("session:" + sessionId)) {
            if (hasUnfinishedRoot(sessionId)) {
                return;
            }
        }

        PendingTask task;
        RuntimeContext context;
        synchronized (ExecutionCoordination.monitor("control:" + sessionId)) {
            if (sessionExecutionRegistry.isRootRunning(sessionId) || hasUnfinishedRoot(sessionId)
                    || ExecutionCoordination.isResumingSession(sessionId)) {
                return;
            }
            task = pendingTasks.claim(sessionId).orElse(null);
            if (task == null) {
                return;
            }
            try {
                requireQueueSession(sessionId);
                // 无附件走单参入口：多传一个空图片集只会让调用方多一处要适配的重载。
                context = task.getAttachments().isEmpty()
                        ? requestPreparer.prepare(toCommand(task))
                        : requestPreparer.prepare(toCommand(task), loadImages(task));
                sessionExecutionRegistry.beginRoot(sessionId, context.executionContext().executionId());
            } catch (RuntimeException | LinkageError failure) {
                // 运行资格还没拿到，失败只落到任务行上，等用户处理后重来。
                pendingTasks.released(task.getId());
                fail(sessionId, task.getId(), failure);
                return;
            }
        }

        RuntimeContext committed;
        try {
            committed = admission.admit(context, task.getId());
        } catch (RuntimeException | LinkageError failure) {
            pendingTasks.released(task.getId());
            fail(sessionId, task.getId(), failure);
            return;
        }

        // 走到这里事务已提交：行删了、轮次落了，磁盘上的附件此刻才允许删。
        // 消息里的图片是自包含 base64，历史展示不依赖这些文件，删早了不会裂图。
        pendingTasks.released(task.getId());
        attachments.deleteTask(sessionId, task.getId());
        chatExecutor.submitAsync(committed);
    }

    /** 兜底：只复查有可派发任务的会话，一个会话收尾慢不阻塞其他会话。 */
    void scan() {
        try {
            List<Long> candidates = pendingTasks.dispatchableSessions().stream()
                    .filter(sessionId -> !checking.contains(sessionId)
                            && !ExecutionCoordination.isResumingSession(sessionId))
                    .toList();
            if (candidates.isEmpty()) {
                return;
            }
            Map<Long, List<ExecutionStatus>> states;
            try {
                states = executionStates.latestStatesBySession(candidates);
            } catch (RuntimeException failure) {
                log.warn("批量复查待发送任务失败: sessionCount={}", candidates.size(), failure);
                return;
            }
            for (Long sessionId : candidates) {
                if (states.getOrDefault(sessionId, List.of()).stream().anyMatch(state -> !state.isTerminal())) {
                    continue;
                }
                if (!checking.add(sessionId)) {
                    continue;
                }
                try {
                    workers.execute(() -> check(sessionId));
                } catch (RejectedExecutionException stopping) {
                    checking.remove(sessionId);
                    if (!workers.isShutdown()) {
                        log.warn("提交待发送复查失败: sessionId={}", sessionId, stopping);
                    }
                }
            }
        } catch (RuntimeException failure) {
            // 定时任务抛出会被调度器就地静默终止，整个兜底就没了。
            log.error("待发送任务兜底扫描失败", failure);
        }
    }

    private void check(long sessionId) {
        try {
            relay(sessionId);
        } catch (RuntimeException failure) {
            log.warn("复查待发送任务失败: sessionId={}", sessionId, failure);
        } finally {
            checking.remove(sessionId);
        }
    }

    /** 会话树被删：行与磁盘一起清。 */
    @TransactionalEventListener(fallbackExecution = true)
    public void discardDeleted(SessionTreeDeleted event) {
        for (Long sessionId : event.sessionIds()) {
            synchronized (ExecutionCoordination.monitor("control:" + sessionId)) {
                pendingTasks.clear(sessionId);
            }
        }
    }

    @PreDestroy
    void close() {
        scanner.shutdownNow();
        workers.shutdownNow();
    }

    private ChatCommand toCommand(PendingTask task) {
        return new ChatCommand(task.getInput(), task.getSessionId(), task.getModelId(), task.getWorkspaceId(),
                null, task.getAgentId(), task.isRequirePlan(), List.of(), List.of());
    }

    /** 附件从磁盘读成模型图片：入队时就没打算把字节留在内存里。 */
    private List<Image> loadImages(PendingTask task) {
        List<PendingAttachment> stored = task.getAttachments();
        if (stored.isEmpty()) {
            return List.of();
        }
        List<Image> images = new ArrayList<>(stored.size());
        for (PendingAttachment attachment : stored) {
            images.add(Image.from(Base64.encode(attachments.read(attachment)), attachment.mime()));
        }
        return images;
    }

    private void requireQueueSession(long sessionId) {
        Session session = sessionRepository.findById(sessionId).orElseThrow(ClientException::new);
        if (session.isSubSession()) {
            throw new ClientException("请在根会话中管理待发送消息");
        }
    }

    private boolean hasUnfinishedRoot(long sessionId) {
        List<ExecutionStatus> states = executionStates.latestStatesBySession(List.of(sessionId))
                .getOrDefault(sessionId, List.of());
        return states.stream().anyMatch(state -> !state.isTerminal());
    }

    private void fail(long sessionId, long taskId, Throwable failure) {
        String message = failure instanceof ClientException && failure.getMessage() != null
                ? failure.getMessage() : "待发送消息受理失败，请重试";
        pendingTasks.fail(sessionId, taskId, message);
        log.warn("待发送消息受理失败: sessionId={}, taskId={}", sessionId, taskId, failure);
    }
}
