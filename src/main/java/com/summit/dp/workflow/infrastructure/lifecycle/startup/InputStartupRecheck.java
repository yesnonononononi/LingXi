package com.summit.dp.workflow.infrastructure.lifecycle.startup;

import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.workflow.application.input.InputWakeupService;
import lombok.RequiredArgsConstructor;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;

/** 遗留执行和卡片收口之后只复查一次，不自动重投旧命令。 */
@Component
@RequiredArgsConstructor
public class InputStartupRecheck {
    private final SessionRepository sessions;
    private final ExecutionRepository executions;
    private final InputWakeupService wakeups;

    @EventListener(ApplicationReadyEvent.class)
    @Order(1000)
    public void recheck() {
        List<Session> roots = sessions.findRootSessions();
        List<Long> sessionIds = roots.stream().flatMap(root -> Stream.concat(Stream.of(root.getId()),
                sessions.findSessionTree(root.getId()).stream().map(Session::getId))).distinct().toList();
        for (int offset = 0; offset < sessionIds.size(); offset += 200) {
            List<Long> ids = sessionIds.subList(offset, Math.min(sessionIds.size(), offset + 200));
            Map<Long, Execution> latest = new HashMap<>();
            for (Execution execution : executions.findLatestBySessionAndStatus(ids)) {
                latest.merge(execution.getSessionId(), execution,
                        (left, right) -> left.getId() > right.getId() ? left : right);
            }
            latest.values().forEach(execution -> wakeups.resumeIfInputPending(execution.getId()));
        }
    }
}
