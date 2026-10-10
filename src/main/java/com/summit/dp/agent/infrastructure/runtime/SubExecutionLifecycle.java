package com.summit.dp.agent.infrastructure.runtime;

import com.summit.core.agent.Execution;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * 子执行「结束事实」协作器：把执行仓储的生命周期通知翻译成「注册表登记变更 + 唤醒根」。
 *
 * <p>根与子共用同一条通知链：子执行进入 SUSPENDED 时保留登记（父侧仍算「未结束」），真正终态时
 * 移除登记并在「最后一个子执行终结」这一原子跃迁上唤醒根；根执行自身进入 SUSPENDED 时重放保留
 * 唤醒（此时控制槽位已释放、检查点已提交，正是「释放后」的唯一时点），进入终态时清理保留唤醒。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class SubExecutionLifecycle {

    private final SessionExecutionRegistry registry;
    private final ExecutionResumeCoordinator resumeCoordinator;
    private final ExecutionIdentity executionIdentity;

    /** 子执行挂起 → 保留登记；根执行挂起 → 重放保留唤醒。 */
    public void onSuspended(Execution execution) {
        Long rootExecutionId = rootExecutionIdOf(execution);
        if (rootExecutionId == null) {
            Long executionId = ExecutionIdentity.numericOrNull(execution.getId());
            if (executionId != null) {
                resumeCoordinator.flushPendingWake(executionId);
            }
            return;
        }
        Long childSessionId = childSessionIdOrNull(execution);
        Long rootSessionId = rootSessionIdOf(childSessionId);
        if (rootSessionId == null) {
            return;
        }
        registry.markChildSuspended(rootSessionId, childSessionId);
        log.info("子执行挂起保留登记: rootSessionId={}, childSessionId={}, rootExecutionId={}",
                rootSessionId, childSessionId, rootExecutionId);
    }

    /** 子执行终态 → 移除登记（成为空则唤醒根）；根执行终态 → 清理保留唤醒。 */
    public void onFinished(Execution execution) {
        Long rootExecutionId = rootExecutionIdOf(execution);
        if (rootExecutionId == null) {
            Long executionId = ExecutionIdentity.numericOrNull(execution.getId());
            if (executionId != null) {
                resumeCoordinator.clearPendingWake(executionId);
            }
            return;
        }
        Long childSessionId = childSessionIdOrNull(execution);
        Long rootSessionId = rootSessionIdOf(childSessionId);
        if (rootSessionId == null) {
            return;
        }
        boolean becameEmpty = registry.unregisterChild(rootSessionId, childSessionId);
        if (becameEmpty) {
            log.info("子执行终结唤醒根: rootExecutionId={}, childSessionId={}, becameEmpty=true",
                    rootExecutionId, childSessionId);
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

    private static Long rootExecutionIdOf(Execution execution) {
        return ExecutionAttributes.readLong(attributesOf(execution), ExecutionAttributes.ROOT_EXECUTION_ID);
    }

    private static Map<String, Object> attributesOf(Execution execution) {
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

    private Long rootSessionIdOf(Long childSessionId) {
        if (childSessionId == null) {
            return null;
        }
        return executionIdentity.resolveRootSessionIdOrNull(childSessionId);
    }
}
