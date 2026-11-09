package com.summit.dp.device.application.port;

/**
 * 设备不可用（未连接、掉线、无障碍服务被系统回收）。
 *
 * <p>刻意用不受检异常：设备掉线是常态而不是程序缺陷，逐个方法声明 throws 只会让上层
 * 到处写 try，最终还是统一转成一句给用户看的提示。</p>
 */
public class DeviceUnavailableException extends RuntimeException {

    public DeviceUnavailableException(String message) {
        super(message);
    }

    public DeviceUnavailableException(String message, Throwable cause) {
        super(message, cause);
    }
}
