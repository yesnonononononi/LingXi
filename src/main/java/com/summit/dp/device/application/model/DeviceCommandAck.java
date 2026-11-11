package com.summit.dp.device.application.model;

/**
 * 指令受理回执。
 *
 * <p>被拒也必须回执：静默丢弃会让手机端一直转圈，用户分不清是"没连上"还是"电脑端不允许"。</p>
 *
 * @param pendingId 非空表示已受理但还没开跑（会话正忙，进了排队）
 * @param reason    被拒原因；accepted=true 时可空
 */
public record DeviceCommandAck(
        String commandId,
        boolean accepted,
        Long sessionId,
        String pendingId,
        String reason) {

    public static DeviceCommandAck accepted(String commandId, Long sessionId, String pendingId) {
        return new DeviceCommandAck(commandId, true, sessionId, pendingId, null);
    }

    public static DeviceCommandAck rejected(String commandId, String reason) {
        return new DeviceCommandAck(commandId, false, null, null, reason);
    }

    /**
     * 幂等重放的回执：仍然是"已受理"，但要说清楚这次没有再跑一遍。
     *
     * <p>不能把重放当成错误：手机重连后重发是正常行为，
     * 回一个失败会让用户以为刚才那条指令丢了，于是手点第二次——那才是真正的重复执行。</p>
     */
    public DeviceCommandAck duplicate() {
        return new DeviceCommandAck(commandId, accepted, sessionId, pendingId, "该指令此前已受理，未重复执行");
    }
}
