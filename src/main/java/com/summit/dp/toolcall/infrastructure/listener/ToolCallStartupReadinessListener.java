package com.summit.dp.toolcall.infrastructure.listener;

import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.domain.model.Execution;
import com.summit.dp.execution.domain.repository.ExecutionRepository;
import com.summit.dp.toolcall.application.service.ToolCallReadinessService;
import com.summit.dp.toolcall.application.service.ToolCallService;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

import java.util.List;

/** 重启只校准已登记槽位，命令副作用不自动重放。 */
@Component
@RequiredArgsConstructor
@Slf4j
public class ToolCallStartupReadinessListener {
    private final ToolCallRepository tools;
    private final ExecutionRepository executions;
    private final ToolCallReadinessService readiness;
    private final ToolCallService service;
    private final DelegationBackfillListener delegation;

    @EventListener(ApplicationReadyEvent.class)
    @Order(300)
    public void reconcile() {
        List<Long> ids = tools.listUnresolvedExecutionIds();
        if (ids.isEmpty()) return;
        for (Execution execution : executions.findList(ids)) {
            try {
                if (Integer.valueOf(2).equals(execution.getStatus())) {
                    readiness.markReady(String.valueOf(execution.getId()));
                    // 启动校准只补「槽位可审批」这一件事，框架 Execution 在这里没有加载，
                    // 而本回调的实现只用到 executionId（根身份对它是无意义的）。
                    delegation.onExecutionSuspended(String.valueOf(execution.getId()), null);
                } else if (execution.getStatus() != null && execution.getStatus() >= 3) {
                    service.cancelPendingToolCalls(String.valueOf(execution.getId()));
                }
            } catch (RuntimeException error) {
                log.error("启动槽位校准失败: executionId={}", execution.getId(), error);
            }
        }
    }
}
