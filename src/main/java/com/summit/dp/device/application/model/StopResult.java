package com.summit.dp.device.application.model;

/**
 * 急停结果。
 *
 * <p>为什么要有这个类型，而不是让 stop 返回 void：急停是安全动作，最危险的情形不是
 * "没停住"，而是"我们以为停住了"。设备没回确认时必须如实告诉调用方，让用户和 agent
 * 知道需要人工介入，而不是给一个看起来成功的空返回。</p>
 *
 * @param acknowledged 设备是否明确确认已停止
 * @param pendingCleared 设备侧清理掉的挂起动作数；未确认时为 null
 * @param detail 未确认时的原因说明
 */
public record StopResult(boolean acknowledged, Integer pendingCleared, String detail) {

    public static StopResult acknowledged(Integer pendingCleared) {
        return new StopResult(true, pendingCleared, "设备已确认停止");
    }

    public static StopResult unacknowledged(String detail) {
        return new StopResult(false, null, detail);
    }

    /** 给模型看的文本：未确认要写得足够刺眼，避免被当成成功。 */
    public String toPromptText() {
        if (acknowledged) {
            String cleared = pendingCleared == null ? "未知" : String.valueOf(pendingCleared);
            return "已急停，设备已确认。设备侧清理挂起动作 " + cleared + " 项。";
        }
        return "急停已发出，但设备未确认（" + detail + "）。"
                + "请勿假设已经停住：建议立即人工检查该设备，并在确认后再继续操作。";
    }
}
