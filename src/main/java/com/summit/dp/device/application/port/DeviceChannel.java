package com.summit.dp.device.application.port;

import com.summit.dp.device.application.model.ActionOutcome;
import com.summit.dp.device.application.model.ActionRequest;
import com.summit.dp.device.application.model.ObserveSnapshot;
import com.summit.dp.device.domain.Device;

/**
 * 设备通道：把"看"和"做"两件事抽象成端口。
 *
 * <p>M1 只有进程内的假设备实现；M1b 会换成真实 WSS 通道。上层编排与工具定义一行都不用改，
 * 这就是留着这层端口的意义。</p>
 */
public interface DeviceChannel {

    /** 当前设备身份与能力。断线时由注册表负责摘除，这里始终返回已知身份。 */
    Device device();

    /** 观察一次界面；节点数受上限约束，超限必须回传 truncated。 */
    ObserveSnapshot observe(int maxNodes);

    /** 执行一次动作。实现方负责真实的幂等保护，调用方不得假设它一定成功。 */
    ActionOutcome perform(ActionRequest request);

    /** 急停：取消所有未执行的动作。 */
    void stop();

    /**
     * 当前前台应用包名；未知时返回 null。
     *
     * <p>危险判定必须依据它，且只能由设备侧如实上报——让 agent 自己从观察文本里抄包名，
     * 抄错一次就意味着在支付应用里乱点而不自知。</p>
     */
    String foregroundPackage();
}
