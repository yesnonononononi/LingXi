package com.summit.dp.device.interfaces.tool.arguments;

import com.summit.dp.device.application.model.ActionRequest;

import java.util.Map;
import java.util.UUID;

/** device_action 的参数。 */
public record DeviceActionArguments(
        String deviceId,
        String kind,
        Map<String, Object> params,
        String expectFrameHash,
        String actionId,
        String targetText
) {

    /**
     * 转成领域请求。actionId 缺省时自动生成——但重试时必须复用同一个值，
     * 否则幂等台账拦不住第二次执行（工具描述里已写明这一点）。
     */
    public ActionRequest toRequest() {
        String resolvedId = (actionId == null || actionId.isBlank())
                ? "a-" + UUID.randomUUID().toString().substring(0, 8)
                : actionId;
        return new ActionRequest(resolvedId, kind, params, expectFrameHash, targetText);
    }
}
