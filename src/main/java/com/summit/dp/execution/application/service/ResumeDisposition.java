package com.summit.dp.execution.application.service;

/**
 * 决策回执里「恢复意图被怎么处理了」的机器可判别结论。
 *
 * <p><b>为什么不能一律回「正在实施」</b>：批准一张卡片后执行不一定马上跑 ——
 * 可能还有其他未决槽位在等，可能只是入了队列，可能恢复失败了，也可能执行已经结束。
 * 全部显示成「正在实施」会让用户在恢复根本没发生时一直等下去。</p>
 */
public enum ResumeDisposition {

    /** 还有其他未决槽位（其他卡片 / 委派等待），本次决策不触发恢复。 */
    WAITING_OTHER_TOOLS("WAITING_OTHER_TOOLS"),
    /** 无未决槽位且仍挂起：恢复意图已入队，等待 worker 领取。 */
    QUEUED("QUEUED"),
    /** 本次调用期间执行已进入运行态；此刻的唤醒<b>未丢弃</b>，已登记为保留唤醒，待其挂起释放后重放。 */
    RUNNING("RUNNING"),
    /** 恢复意图已受理但派发失败（worker 领取后模型调用起不来）。 */
    FAILED("FAILED"),
    /** 执行已终结，决策落库但不会再恢复。 */
    ENDED("ENDED");

    private final String wireValue;

    ResumeDisposition(String wireValue) {
        this.wireValue = wireValue;
    }

    public String wireValue() {
        return wireValue;
    }
}
