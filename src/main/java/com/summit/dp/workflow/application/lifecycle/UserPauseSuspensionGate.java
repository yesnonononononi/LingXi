package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.Execution;
import com.summit.dp.workflow.application.input.InputAutomationPolicy;
import org.springframework.stereotype.Component;

/**
 * 用户暂停与连续自动接续的门禁。
 *
 * <p>{@code USER_PAUSED} 与 {@code AUTO_ROUNDS} 都写在执行属性里，随检查点落库，
 * 所以判定只用执行对象、不查库。</p>
 *
 * <p>只有手动恢复能清这两个标记：它们是「人的意图」与「机器已经自己跑了多少轮」，
 * 自动唤醒替人取消暂停就是「按了暂停它自己又跑起来」。</p>
 */
@Component
public class UserPauseSuspensionGate implements SuspensionGate {

    /** 人的暂停意图优先于一切自动唤醒，排在链首。 */
    @Override
    public int order() {
        return 100;
    }

    @Override
    public GateCheckResult checkResumeReadiness(Execution execution, ResumeTriggerType triggerType) {
        if (triggerType.clearsPauseMarkers()) {
            return GateCheckResult.pass();
        }
        if (Boolean.TRUE.equals(InputAutomationPolicy.attributes(execution).get(InputAutomationPolicy.USER_PAUSED))) {
            return GateCheckResult.blocked("执行已由用户暂停");
        }
        if (InputAutomationPolicy.autoRounds(execution) >= InputAutomationPolicy.MAX_AUTO_ROUNDS) {
            return GateCheckResult.blocked(
                    "连续自动接续已达到 " + InputAutomationPolicy.MAX_AUTO_ROUNDS + " 轮上限");
        }
        return GateCheckResult.pass();
    }

    @Override
    public void clearSuspensionState(Execution execution, ResumeTriggerType triggerType) {
        if (!triggerType.clearsPauseMarkers()) {
            return;
        }
        InputAutomationPolicy.putAttribute(execution, InputAutomationPolicy.USER_PAUSED, null);
        InputAutomationPolicy.putAttribute(execution, InputAutomationPolicy.AUTO_ROUNDS, null);
    }
}
