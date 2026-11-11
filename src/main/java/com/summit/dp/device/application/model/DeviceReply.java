package com.summit.dp.device.application.model;

/**
 * 电脑端回推给设备的会话结果。
 *
 * <p>与 {@link DeviceCommandAck} 的分工不能混：回执回答"受没受理"（同步、一次），
 * 本类回答"跑出了什么"（异步、一轮可能多条）。把两者合并，就只能要么让回执等结果，
 * 要么让结果承担受理语义——两种都会让关联关系烂掉。</p>
 *
 * <p>{@code kind} 是可扩展枚举而不是自由字符串：设备侧要按它决定怎么显示（最终/失败/状态），
 * 而自由字符串会让"未知值"一路穿到界面。将来设备以 MCP 工具身份上报时，在这里加一个常量即可，
 * 通道本身不用改。</p>
 *
 * @param sessionId 答复所属会话
 * @param kind      答复种类
 * @param text      给人看的文本；设备端只显示不解析
 * @param commandId 可选：回指引发这条答复的指令
 * @param turnId    可选：本轮业务轮次 ID
 */
public record DeviceReply(long sessionId, Kind kind, String text, String commandId, Long turnId) {

    /** 答复种类。{@code wire()} 与契约 schema 的枚举一一对应。 */
    public enum Kind {
        FINAL("final"),
        ERROR("error"),
        STATUS("status");

        private final String wire;

        Kind(String wire) {
            this.wire = wire;
        }

        public String wire() {
            return wire;
        }
    }

    public DeviceReply {
        if (sessionId <= 0) {
            throw new IllegalArgumentException("会话 ID 非法: " + sessionId);
        }
        if (text == null || text.isBlank()) {
            throw new IllegalArgumentException("答复文本不能为空");
        }
    }

    /** 本轮最终答复。 */
    public static DeviceReply finalReply(long sessionId, String text, String commandId, Long turnId) {
        return new DeviceReply(sessionId, Kind.FINAL, text, commandId, turnId);
    }

    /** 本轮失败。失败也必须回推：只在成功时推，手机会永远停在"已受理"。 */
    public static DeviceReply error(long sessionId, String text, String commandId) {
        return new DeviceReply(sessionId, Kind.ERROR, text, commandId, null);
    }

    /** 过程状态（不做流式逐字渲染，只给里程碑）。 */
    public static DeviceReply status(long sessionId, String text, String commandId) {
        return new DeviceReply(sessionId, Kind.STATUS, text, commandId, null);
    }
}
