package com.summit.dp.device.application.port;

import com.summit.dp.device.application.model.DeviceScreenshot;

import java.util.Map;
import java.util.Optional;

/**
 * 把设备截图变成"模型下一轮能看见的图"。
 *
 * <p>为什么需要这个端口：工具回执本身只能放文本（框架的限制），像素要靠
 * {@code ImageInjectionInterceptor} 在下一轮模型调用前作为用户消息注入。于是设备侧必须
 * 先把图交给会话图片缓存，并拿到一份注入元数据。设备模块不该知道缓存目录在哪、
 * 会话标识从哪来，所以只声明这个意图，实现放在图片基础设施里。</p>
 *
 * <p><b>返回空表示"图没能进入模型上下文"</b>，且必须让工具回执如实说明——
 * 悄悄丢掉截图，模型会以为自己看到了画面，然后在空节点的基础上瞎点。</p>
 */
public interface ObserveImageAttacher {

    /**
     * @param executionAttributes 执行属性（视觉能力、会话标识等），键由框架与平台约定
     * @param screenshot          设备回传的截图
     * @param label               给模型看的来源说明（例如 "device:com.android.settings"）
     * @return 注入元数据；不具备注入条件（无视觉模型、无会话、无像素）时为空
     */
    Optional<Map<String, Object>> attach(Map<String, Object> executionAttributes,
                                         DeviceScreenshot screenshot,
                                         String label);
}
