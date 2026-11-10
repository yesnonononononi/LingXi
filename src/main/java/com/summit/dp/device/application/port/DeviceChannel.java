package com.summit.dp.device.application.port;

import com.summit.dp.device.application.model.ActionOutcome;
import com.summit.dp.device.application.model.ActionRequest;
import com.summit.dp.device.application.model.ObserveRequest;
import com.summit.dp.device.application.model.ObserveSnapshot;
import com.summit.dp.device.application.model.StopResult;
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

    /**
     * 观察一次界面：节点数受上限约束，超限必须回传 truncated；模式决定是否附带截图。
     *
     * <p>模式必须一层层如实传下去（工具参数 → 请求 → 协议字段）。桌面端曾经固定发
     * {@code mode=both} 再丢掉截图，设备因此每次都多做一次 300ms 的截屏——请求说一套、
     * 消费做另一套，是最贵的 bug 形态。</p>
     */
    ObserveSnapshot observe(ObserveRequest request);

    /** 只要节点的常见情形，便于调用方少写一个参数。 */
    default ObserveSnapshot observe(int maxNodes) {
        return observe(ObserveRequest.nodes(maxNodes));
    }

    /** 执行一次动作。实现方负责真实的幂等保护，调用方不得假设它一定成功。 */
    ActionOutcome perform(ActionRequest request);

    /**
     * 急停：取消所有未执行的动作。
     *
     * <p>返回结果而不是 void：实现对"停住了"是否有把握，调用方必须知道。</p>
     */
    StopResult stop();

    /**
     * 当前前台应用包名；未知时返回 null。
     *
     * <p>危险判定必须依据它，且只能由设备侧如实上报——让 agent 自己从观察文本里抄包名，
     * 抄错一次就意味着在支付应用里乱点而不自知。</p>
     */
    String foregroundPackage();
}
