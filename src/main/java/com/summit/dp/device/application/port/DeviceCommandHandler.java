package com.summit.dp.device.application.port;

import com.summit.dp.device.application.model.DeviceCommand;
import com.summit.dp.device.application.model.DeviceCommandAck;

/**
 * 设备指令的受理端口。
 *
 * <p>端口放在设备模块，实现放在工作流模块：设备模块不该反过来依赖会话编排，
 * 否则 device → workflow → device 绕成一圈，以后谁想单独测设备通道都得拖上整条 agent 链路。</p>
 *
 * <p>实现必须自己决定"要不要受理"（开关、幂等、会话归属），并且**永远返回回执**——
 * 抛异常在这条路径上没有意义：对端是手机，它只会看到一个没有回执的连接。</p>
 */
public interface DeviceCommandHandler {

    DeviceCommandAck handle(String deviceId, DeviceCommand command);
}
