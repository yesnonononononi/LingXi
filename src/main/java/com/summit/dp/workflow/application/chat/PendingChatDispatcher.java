package com.summit.dp.workflow.application.chat;

import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.execution.domain.model.ExecutionStatus;
import com.summit.dp.session.application.service.SessionTreeDeleted;
import com.summit.dp.workflow.application.chat.impl.ChatServiceImpl;
import com.summit.dp.workflow.infrastructure.lifecycle.ExecutionCoordination;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.transaction.event.TransactionalEventListener;

import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/** 只复查有待发送消息的会话，一个会话收尾慢时不阻塞其他会话。 */
@Slf4j
@Component
@RequiredArgsConstructor
public class PendingChatDispatcher {
    private final PendingChatQueue queue;
    private final ChatServiceImpl chat;
    private final ExecutionQueryService executionStates;
    private final Set<Long> checking = ConcurrentHashMap.newKeySet();
    private final ScheduledExecutorService scanner = Executors.newSingleThreadScheduledExecutor(
            Thread.ofPlatform().daemon().name("pending-chat-scan").factory());
    private final ExecutorService workers = Executors.newVirtualThreadPerTaskExecutor();

    @PostConstruct
    void start() {
        // 提交和控制槽释放可能来自不同线程，复查可覆盖通知早于收尾的窗口。
        scanner.scheduleWithFixedDelay(this::scan, 0, 500, TimeUnit.MILLISECONDS);
    }

    void scan() {
        List<Long> candidates = queue.dispatchableSessions().stream()
                .filter(sessionId -> !checking.contains(sessionId) && !ExecutionCoordination.isResumingSession(sessionId))
                .toList();
        if (candidates.isEmpty()) return;

        Map<Long, List<ExecutionStatus>> states;
        try {
            states = executionStates.latestStatesBySession(candidates);
        } catch (RuntimeException failure) {
            log.warn("批量复查待发送消息失败: sessionCount={}", candidates.size(), failure);
            return;
        }
        for (Long sessionId : candidates) {
            if (states.getOrDefault(sessionId, List.of()).stream().anyMatch(state -> !state.isTerminal())) continue;
            if (!checking.add(sessionId)) continue;
            try {
                workers.execute(() -> check(sessionId));
            } catch (RejectedExecutionException stopping) {
                checking.remove(sessionId);
                if (!workers.isShutdown()) log.warn("提交待发送复查失败: sessionId={}", sessionId, stopping);
            }
        }
    }

    private void check(long sessionId) {
        try {
            chat.dispatchPending(sessionId);
        } catch (RuntimeException failure) {
            log.warn("复查待发送消息失败: sessionId={}", sessionId, failure);
        } finally {
            checking.remove(sessionId);
        }
    }

    @TransactionalEventListener
    public void discardDeleted(SessionTreeDeleted event) {
        for (Long sessionId : event.sessionIds()) {
            synchronized (ExecutionCoordination.monitor("control:" + sessionId)) {
                queue.discard(sessionId);
            }
        }
    }

    @PreDestroy
    void close() {
        scanner.shutdownNow();
        workers.shutdownNow();
    }
}
