package com.summit.dp.workflow.infrastructure.lifecycle;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;

/** 子执行失败立即唤醒主理人处置，其余终态在最后一个子执行结束时唤醒；挂起后重放保留唤醒。 */
@Slf4j
@Component
@RequiredArgsConstructor
public class SubExecutionLifecycle {
    private final SessionExecutionRegistry registry;
    private final ExecutionResumeCoordinator resumeCoordinator;
    private final ExecutionLocator executionLocator;
    private final SubAgentCompleteNotifier subAgentCompleteNotifier;

    /** 子登记先落定再重放唤醒，避免新运行被迟到的挂起登记覆盖。 */
    public void onSuspended(Execution execution) {
        Long rootExecutionId = resolveRootExecutionId(execution);
        if (rootExecutionId != null) {
            Long childSessionId = childSessionIdOrNull(execution);
            Long rootSessionId = resolveRootSessionId(childSessionId);
            if (rootSessionId != null) {
                registry.markChildSuspended(rootSessionId, childSessionId);
                log.info("子执行挂起保留登记: rootSessionId={}, childSessionId={}, rootExecutionId={}",
                        rootSessionId, childSessionId, rootExecutionId);
            }
        }
        Long executionId = ExecutionIdentity.numericOrNull(execution.getId());
        if (executionId != null) resumeCoordinator.flushPendingWake(executionId);
    }

    /**
     * 子执行失败或全部结束后唤醒根；根执行终态清理保留唤醒。
     */
    public void onFinished(Execution execution) {
        Long executionId = ExecutionIdentity.numericOrNull(execution.getId());
        if (executionId != null) resumeCoordinator.clearPendingWake(executionId);
        Long rootExecutionId = resolveRootExecutionId(execution);
        if (rootExecutionId == null) return;
        Long childSessionId = childSessionIdOrNull(execution);
        Long rootSessionId = resolveRootSessionId(childSessionId);

        if (rootSessionId == null) {
            return;
        }

        // 先投递再注销，避免根执行在子登记清空后、提醒落库前提前收尾；通知失败仍保留既有唤醒路径。
        try {
            subAgentCompleteNotifier.notifyCommander(execution);
        } catch (RuntimeException error) {
            log.error("投递子执行终结提醒失败: executionId={}, rootExecutionId={}", execution.getId(), rootExecutionId, error);
        }

        boolean becameEmpty = registry.unregisterChild(rootSessionId, childSessionId);

        boolean failed = execution.getExecutionState() == ExecutionState.FAILED;
        if (failed || becameEmpty) {
            log.info("子执行终结唤醒根: rootExecutionId={}, childSessionId={}, failed={}, becameEmpty={}",
                    rootExecutionId, childSessionId, failed, becameEmpty);
            resumeCoordinator.accept(rootExecutionId);
        }
    }

    /**
     * 子执行从未建立执行（落库前失败）的兜底结束事实：移除待启动登记并唤醒根。
     *
     * <p>已开跑的子执行失败走框架 {@code notifyFinished} 链，与这里的兜底可能重叠；二者都是幂等的，
     * 不会重复唤醒出问题。</p>
     */
    public void abandonChild(Long rootSessionId, Long childSessionId, Long rootExecutionId) {
        if (rootSessionId == null || childSessionId == null) {
            return;
        }
        boolean becameEmpty = registry.unregisterChild(rootSessionId, childSessionId);
        if (becameEmpty && rootExecutionId != null) {
            log.info("子执行未建立，兜底移除并唤醒根: rootExecutionId={}, childSessionId={}",
                    rootExecutionId, childSessionId);
            resumeCoordinator.accept(rootExecutionId);
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
