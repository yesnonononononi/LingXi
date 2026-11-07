package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.Execution;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/**
 * 未决工具门禁：还有没落定结论的槽位就不能恢复。
 *
 * <p>准备中、执行中、委派等待都算未决 —— 只看 {@code pending} 会漏掉它们，
 * 在这些状态下恢复会让 loop 拿到一个还没写回结论的槽位。</p>
 *
 * <p>判定只有这一份：恢复链路与审批链路都从这里取，避免「两处写法慢慢漂移」。</p>
 */
@Component
@RequiredArgsConstructor
public class UnresolvedToolSuspensionGate implements SuspensionGate {

    /** 槽位状态是恢复的前提，排在暂停判定之后、子代理等待之前。 */
    @Override
    public int order() {
        return 200;
    }

    private final ToolCallRepository toolCallRepository;

    /** 该执行是否还有未落定的槽位；审批流程判「能不能现在恢复」也用它。 */
    public boolean hasUnresolvedSlot(Long executionId) {
        if (executionId == null) {
            return false;
        }
        return !toolCallRepository.listUnresolvedByExecutionId(executionId).isEmpty();
    }

    @Override
    public GateCheckResult checkResumeReadiness(Execution execution, ResumeTriggerType triggerType) {
        if (hasUnresolvedSlot(numericId(execution))) {
            // 手动与自动用同一句原因：手动把它当业务错误回给用户，自动只静默保持挂起。
            return GateCheckResult.blocked("请先处理待审批事项");
        }
        return GateCheckResult.pass();
    }

    @Override
    public void clearSuspensionState(Execution execution, ResumeTriggerType triggerType) {
        // 槽位由各自的决策收口，门禁没有需要清理的挂起痕迹。
    }

    /** 执行标识必须可解析；解析不出来说明链路坏了，不能当成「没有未决槽位」。 */
    private Long numericId(Execution execution) {
        if (execution == null || execution.getId() == null || execution.getId().isBlank()) {
            throw new IllegalStateException("待恢复执行缺少标识");
        }
        try {
            return Long.valueOf(execution.getId());
        } catch (NumberFormatException error) {
            throw new IllegalStateException("待恢复执行的标识不是数字: executionId=" + execution.getId(), error);
        }
    }
}
