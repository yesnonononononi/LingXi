package com.summit.dp.device.application.model;

/**
 * 设备主动发起的一条指令。
 *
 * <p>这是整条协议里唯一的业务上行入口：手机把用户的一句话交给电脑端的 agent。
 * 信封上的 id 是消息标识，不能兼职业务关联键，所以幂等键 {@code commandId} 必须自带。</p>
 *
 * @param commandId 幂等键。手机重发必须复用同一个值，否则一次网络抖动就变成"再跑一轮任务"
 * @param text      用户原话
 * @param sessionId 可选：指定落到哪个会话；省略时由电脑端按 deviceId 绑定决定
 */
public record DeviceCommand(String commandId, String text, Long sessionId) {
}
