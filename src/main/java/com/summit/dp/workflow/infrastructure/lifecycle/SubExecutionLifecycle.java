package com.summit.dp.workflow.infrastructure.lifecycle;

import com.summit.core.agent.Execution;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.workflow.application.input.InputWakeupService;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;

/** 交付先可读，再解除依赖；通知只触发事实复查。 */
@Slf4j
@Component
@RequiredArgsConstructor
public class SubExecutionLifecycle {
    private final SessionExecutionRegistry registry;
    private final InputWakeupService wakeups;
    private final ExecutionLocator executionLocator;
    private final SubAgentCompleteNotifier subAgentCompleteNotifier;

    /**
     * 交付提交之后解除依赖，再通知根执行复查输入。
     */
    public void onFinished(Execution execution) {
        Long rootExecutionId = resolveRootExecutionId(execution);
        if (rootExecutionId == null) return;
        Long childSessionId = childSessionIdOrNull(execution);
        Long rootSessionId = resolveRootSessionId(childSessionId);

        if (rootSessionId == null) {
            return;
        }

        // 先投递再注销，通知失败保留依赖，避免根执行在结果尚不可读时提前收尾。
        try {
            subAgentCompleteNotifier.notifyCommander(execution);
        } catch (RuntimeException error) {
            log.error("投递子执行终结提醒失败: executionId={}, rootExecutionId={}", execution.getId(), rootExecutionId, error);
            return;
        }

        boolean becameEmpty = registry.unregisterChild(rootSessionId, childSessionId, execution.getId());

        // 每份交付都需要主理人及时处理，剩余子执行只阻止根收尾，不能阻止恢复取信。
        log.info("子执行终结唤醒根: rootExecutionId={}, childSessionId={}, state={}, becameEmpty={}",
                rootExecutionId, childSessionId, execution.getExecutionState(), becameEmpty);
        wakeups.resumeIfInputPending(rootExecutionId);
    }

    /**
     * 子执行从未建立执行（落库前失败）的兜底结束事实：移除待启动登记并唤醒根。
     *
     * <p>已开跑的子执行失败走框架 {@code notifyFinished} 链，与这里的兜底可能重叠；二者都是幂等的，
     * 不会重复唤醒出问题。</p>
     */
    public void abandonChild(Long rootSessionId, Long childSessionId, String executionId, Long rootExecutionId) {
        if (rootSessionId == null || childSessionId == null) {
            return;
        }
        if (rootExecutionId != null) subAgentCompleteNotifier.notifyAbandoned(rootExecutionId, childSessionId);
        registry.unregisterChild(rootSessionId, childSessionId, executionId);
        if (rootExecutionId != null) {
            log.info("子执行未建立，兜底移除并唤醒根: rootExecutionId={}, childSessionId={}",
                    rootExecutionId, childSessionId);
            wakeups.resumeIfInputPending(rootExecutionId);
        }
    }

    private static Long resolveRootExecutionId(Execution execution) {
        return ExecutionAttributes.readLong(resolveAttributes(execution), ExecutionAttributes.ROOT_EXECUTION_ID);
    }

    private static Map<String, Object> resolveAttributes(Execution execution) {
        if (execution == null || execution.getAgentRequest() == null) {
            return Map.of();
        }
        return execution.getAgentRequest().runtimeParametersOrDefault().getAttributes();
    }

    private static Long childSessionIdOrNull(Execution execution) {
        try {
            return ExecutionIdentity.sessionId(execution);
        } catch (RuntimeException error) {
            log.warn("子执行缺少会话归属，跳过生命周期登记: executionId={}", execution.getId());
            return null;
        }
    }

    private Long resolveRootSessionId(Long childSessionId) {
        if (childSessionId == null) {
            return null;
        }
        return executionLocator.resolveRootSessionIdOrNull(childSessionId);
    }

}
