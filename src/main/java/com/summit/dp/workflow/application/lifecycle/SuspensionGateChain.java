package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.Execution;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.Comparator;
import java.util.List;

/**
 * 门禁链：按 {@link SuspensionGate#order()} 升序求值，第一个阻断即停。
 *
 * <p><b>为什么要一个独立类</b>：恢复有两条调用时机 —— 入口的同步预检（手动）与队列消费端的
 * 锁内复检。顺序与集合必须只有一处定义，否则「预检放行、复检又拦」这类错位迟早出现。</p>
 */
@Component
@RequiredArgsConstructor
public class SuspensionGateChain {

    private final List<SuspensionGate> gates;

    /** 逐个门禁判定；全放行才算可以恢复。 */
    public GateCheckResult checkReadiness(Execution execution, ResumeTriggerType triggerType) {
        if (execution == null) {
            return GateCheckResult.blocked("执行不存在，无法恢复");
        }
        for (SuspensionGate gate : ordered()) {
            GateCheckResult result = gate.checkResumeReadiness(execution, triggerType);
            if (!result.allowed()) {
                return result;
            }
        }
        return GateCheckResult.pass();
    }

    /** 放行后清理各门禁持有的挂起痕迹；顺序同样按 order 升序。 */
    public void clearSuspensionState(Execution execution, ResumeTriggerType triggerType) {
        if (execution == null) {
            return;
        }
        for (SuspensionGate gate : ordered()) {
            gate.clearSuspensionState(execution, triggerType);
        }
    }

    /** 每次现排，避免把 Spring 注入顺序当成契约。 */
    private List<SuspensionGate> ordered() {
        return gates.stream().sorted(Comparator.comparingInt(SuspensionGate::order)).toList();
    }
}
