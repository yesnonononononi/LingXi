package com.summit.dp.device.application.model;

/**
 * 一次观察请求：(模式, 节点上限)。
 *
 * <p>把上限与模式放进同一个值对象，是因为它们必须同时生效：曾出现过桌面端固定发
 * {@code mode=both} 却丢弃截图的写法——请求和消费各说各话，设备白白多花 300ms 截一张没人看的图。
 * 一个对象只描述"我想要什么"，谁要谁负责消费。</p>
 */
public record ObserveRequest(int maxNodes, ObserveMode mode) {

    /** 与协议 schema 的节点上限一致。 */
    public static final int HARD_MAX_NODES = 120;

    public ObserveRequest {
        if (maxNodes < 1 || maxNodes > HARD_MAX_NODES) {
            throw new IllegalArgumentException(
                    "maxNodes 必须在 1~" + HARD_MAX_NODES + " 之间，实际=" + maxNodes);
        }
        mode = mode == null ? ObserveMode.NODES : mode;
    }

    /** 只取节点（最常见的默认）。 */
    public static ObserveRequest nodes(int maxNodes) {
        return new ObserveRequest(maxNodes, ObserveMode.NODES);
    }
}
