package com.summit.dp.workflow.infrastructure.lifecycle.startup;

import com.summit.dp.email.domain.repository.EmailRepository;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.workflow.application.input.InputWakeupService;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 遗留执行和卡片收口之后只复查一次，不自动重投旧命令。
 *
 * <p><b>为什么从候选集合出发</b>：旧实现先取全部根会话、再逐个查会话树，启动耗时随历史会话数线性
 * 增长（§4.6 的 N+1）。现在反过来：先按「可能还有待处理输入」的事实源取候选会话
 * （仍活跃的执行、待消费邮件、可能未注入的终态任务），再只对候选解析最新执行并复查唤醒。
 * 历史会话再多，只要没有输入就不是候选，语句条数保持不变。</p>
 */
@Component
@RequiredArgsConstructor
public class InputStartupRecheck {
    /** 一次 {@code IN} 查询的候选批量上限：与旧实现的批次同量级，避免超长 SQL。 */
    private static final int BATCH_SIZE = 200;

    private final ExecutionRepository executions;
    private final EmailRepository emails;
    private final TaskRepository tasks;
    private final InputWakeupService wakeups;

    @EventListener(ApplicationReadyEvent.class)
    @Order(1000)
    public void recheck() {
        List<Long> sessionIds = resolveCandidateSessions();
        if (sessionIds.isEmpty()) {
            return;
        }
        for (int offset = 0; offset < sessionIds.size(); offset += BATCH_SIZE) {
            List<Long> ids = sessionIds.subList(offset, Math.min(sessionIds.size(), offset + BATCH_SIZE));
            Map<Long, Execution> latest = new HashMap<>();
            for (Execution execution : executions.findLatestBySessionAndStatus(ids)) {
                latest.merge(execution.getSessionId(), execution,
                        (left, right) -> left.getId() > right.getId() ? left : right);
            }
            latest.values().forEach(execution -> wakeups.resumeIfInputPending(execution.getId()));
        }
    }

    /**
     * 汇总三个事实源的候选会话（去重，保持来源顺序便于排查）。
     *
     * <p>每个来源都只是一条去重查询，不遍历根会话与会话树；三个来源覆盖「仍活跃」「有未消费邮件」
     * 「有终态任务待注入」。子执行输入恒空，不构成唤醒候选，故不作为来源。</p>
     */
    private List<Long> resolveCandidateSessions() {
        Set<Long> candidates = new LinkedHashSet<>();
        candidates.addAll(executions.findUnfinishedSessionIds());
        candidates.addAll(emails.findPendingMailboxSessionIds());
        candidates.addAll(tasks.findSessionIdsWithUnconsumedTerminalTasks());
        return new ArrayList<>(candidates);
    }
}
