package com.summit.dp.device.application.model;

/**
 * 观察模式：要节点、要图，还是都要。
 *
 * <p>为什么必须有这个枚举而不是一个 boolean：真机（ColorOS / Android 16）上第三方应用的节点树会被系统
 * 截断到 1~2 个节点，此时<b>只有截图能说明屏幕上有什么</b>；而本应用自身节点完整，截图纯属浪费。
 * 三种模式的差别不是"多传一个字段"，而是两条完全不同的信息通道。</p>
 *
 * <p>与协议 {@code mode} 一一对应，转换只在这一处，别处不许再写字符串。</p>
 */
public enum ObserveMode {

    /** 只取节点树：便宜、快，节点可读时的默认选择。 */
    NODES("nodes"),

    /** 只取截图：读不到树时用来"看图定位"，不带节点节省 token。 */
    SHOT("shot"),

    /** 节点 + 截图：既能按文本决策，又能看图核对。 */
    BOTH("both");

    private final String wire;

    ObserveMode(String wire) {
        this.wire = wire;
    }

    public String wire() {
        return wire;
    }

    /** 是否需要设备截图。 */
    public boolean wantsScreenshot() {
        return this != NODES;
    }

    /** 是否需要节点树。 */
    public boolean wantsNodes() {
        return this != SHOT;
    }

    /** 协议字符串 → 枚举；未知值返回 null，由调用方明确报错而不是兜底成 nodes。 */
    public static ObserveMode fromWire(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        String normalized = value.trim();
        for (ObserveMode mode : values()) {
            if (mode.wire.equals(normalized)) {
                return mode;
            }
        }
        return null;
    }
}
