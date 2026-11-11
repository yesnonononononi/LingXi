package com.summit.dp.workflow.infrastructure.device;

import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * deviceId ↔ sessionId 的双向绑定表。
 *
 * <p><b>为什么要单独一个组件</b>：绑定关系有两个消费者——受理指令时要"这个设备该落到哪个会话"，
 * 回推结果时要"这条会话属于哪台设备"。两边各记一份，迟早会出现"手机发进去的会话，
 * 结果推给了另一台"这种只在多设备场景才炸的故障，而且查起来极其费劲。</p>
 *
 * <p><b>断线不清</b>：重连后追问必须落回同一会话，否则"它现在到哪一步了"永远答不上来。
 * 解绑只能由用户显式操作触发。</p>
 */
@Component
public class DeviceSessionBindings {

    private final Map<String, Long> sessionByDevice = new ConcurrentHashMap<>();
    private final Map<Long, String> deviceBySession = new ConcurrentHashMap<>();

    /**
     * 绑定设备与会话。
     *
     * <p>同一设备改绑新会话时，把旧会话的反向索引一并清掉：留着它，
     * 旧会话下一轮的答复会继续往这台设备推，用户看到的就是"我没问的问题的答案"。</p>
     */
    public void bind(String deviceId, long sessionId) {
        if (deviceId == null || deviceId.isBlank() || sessionId <= 0) {
            return;
        }
        Long previous = sessionByDevice.put(deviceId, sessionId);
        if (previous != null && previous != sessionId) {
            deviceBySession.remove(previous, deviceId);
        }
        deviceBySession.put(sessionId, deviceId);
    }

    public Optional<Long> sessionOf(String deviceId) {
        return deviceId == null ? Optional.empty() : Optional.ofNullable(sessionByDevice.get(deviceId));
    }

    public Optional<String> deviceOf(Long sessionId) {
        return sessionId == null ? Optional.empty() : Optional.ofNullable(deviceBySession.get(sessionId));
    }

    /** 显式解绑：换人用或想开新会话时调用。 */
    public void unbind(String deviceId) {
        if (deviceId == null) {
            return;
        }
        Long sessionId = sessionByDevice.remove(deviceId);
        if (sessionId != null) {
            deviceBySession.remove(sessionId, deviceId);
        }
    }
}
