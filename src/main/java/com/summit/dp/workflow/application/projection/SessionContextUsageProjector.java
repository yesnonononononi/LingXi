package com.summit.dp.workflow.application.projection;

import com.summit.core.agent.Execution;
import com.summit.core.compact.ContextUsageMetric;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.session.application.service.SessionAggregateService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;

/** 用量归属取执行自身会话，缺失采集结果不能伪造为零。 */
@Component
@RequiredArgsConstructor
@Slf4j
public class SessionContextUsageProjector {
    private final SessionAggregateService sessionService;

    public void saveExecutionContextUsage(Execution execution) {
        ContextUsageMetric metric = execution == null ? null : execution.getContextUsageMetric();
        if (metric == null) return;
        Map<String, Object> attributes = execution.getAgentRequest() == null
                ? Map.of() : execution.getAgentRequest().runtimeParametersOrDefault().getAttributes();
        Long sessionId = ExecutionAttributes.readLong(attributes, ExecutionAttributes.SESSION_ID);
        if (sessionId == null) {
            log.warn("保存上下文用量跳过: executionId={}, reason=缺少会话归属", execution.getId());
            return;
        }
        sessionService.saveContextUsage(sessionId, (long) metric.tokenCount(), metric.maxTokens(), metric.ratio());
    }
}
