package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.Execution;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

/**
 * 等待子代理门禁：还有子执行在跑时，自动唤醒不能把父执行拉起来。
 *
 * <p><b>为什么手动恢复不受此门禁限制</b>：用户显式点恢复是现行语义，恢复后子代理结果到位
 * 仍然会作为输入补进来；把人的操作拦在「子代理还没回」上，等于把唯一的人工出路也堵了。</p>
 *
 * <p>自动唤醒则必须拦：子执行终结时会先投递交付再注销依赖、最后才唤醒根
 * （{@code SubExecutionLifecycle#onFinished}），门禁在那一刻已经放行 —— 因果顺序是对的，
 * 提前唤醒才会让模型读到不完整的依赖集合。</p>
 */
@Component
@RequiredArgsConstructor
public class SubAgentWaitSuspensionGate implements SuspensionGate {

    /** 子代理依赖是最后一道：前面两道都放行后，它仍可能拦住自动唤醒。 */
    @Override
    public int order() {
        return 300;
    }

    private final SubExecutionDependency dependency;

    @Override
    public GateCheckResult checkResumeReadiness(Execution execution, ResumeTriggerType triggerType) {
        if (triggerType.clearsPauseMarkers()) {
            return GateCheckResult.pass();
        }
        if (dependency.hasUnfinishedSubExecution(execution)) {
            return GateCheckResult.blocked("等待子代理返回结果");
        }
        return GateCheckResult.pass();
    }

    @Override
    public void clearSuspensionState(Execution execution, ResumeTriggerType triggerType) {
        // 子代理依赖由登记表与执行行表达，恢复时没有需要清理的痕迹。
    }
}
