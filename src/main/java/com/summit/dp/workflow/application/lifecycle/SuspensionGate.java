package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.Execution;

/**
 * 挂起门禁：判定挂起中的执行能否恢复，以及恢复前要清掉哪些挂起痕迹。
 *
 * <p><b>为什么判定要带触发类型</b>：{@code USER_PAUSED} 必须挡住自动唤醒，
 * 却必须放行手动 {@code /resume}（手动恢复本就是来解暂停的）。所以「能不能恢复」
 * 与「谁在请求恢复」是同一个问题的两半，不能拆开。</p>
 *
 * <p><b>同一个实现会被调用两次</b>：入口的同步预检（要把原因回给用户）与队列消费端的
 * 锁内复检（不通过就静默保持挂起）。判定只有一份，差别只在调用方怎么处理结果。</p>
 */
public interface SuspensionGate {

    /** 检查优先级，数值越小越先检查。 */
    int order();

    /**
     * 判定当前执行是否被本门禁阻断。
     *
     * @param execution   待恢复的执行（不要求已经持久化到最新）
     * @param triggerType 恢复触发来源
     * @return 放行，或带原因的阻断
     */
    GateCheckResult checkResumeReadiness(Execution execution, ResumeTriggerType triggerType);

    /**
     * 允许恢复时清理关联的挂起痕迹；在调用底层框架 resume 之前执行。
     *
     * <p>只有 {@link ResumeTriggerType#MANUAL_USER_RESUME} 才允许动暂停标记 ——
     * 自动唤醒把人的暂停意图清掉，就是「按了暂停它自己又跑起来」。</p>
     */
    void clearSuspensionState(Execution execution, ResumeTriggerType triggerType);
}
