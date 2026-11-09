package com.summit.dp.device.application.model;

import java.util.Map;

/**
 * 一次动作请求。
 *
 * <p>actionId 由调用方生成并保证唯一：它是幂等键，重连重放时被台账拦下的就是它。
 * expectFrameHash 为空表示调用方明确接受"不校验画面是否变化"，只应在调试或停止类动作上出现。</p>
 */
public record ActionRequest(
        String actionId,
        String kind,
        Map<String, Object> params,
        String expectFrameHash,
        String targetText
) {

    public ActionRequest {
        if (actionId == null || actionId.isBlank()) {
            throw new IllegalArgumentException("动作标识不能为空");
        }
        if (kind == null || kind.isBlank()) {
            throw new IllegalArgumentException("动作类型不能为空");
        }
        params = params == null ? Map.of() : Map.copyOf(params);
    }

    /** 目标文本用于危险判定；缺省时从 params 里的 text 兜底读取。 */
    public String targetTextOrParam() {
        if (targetText != null && !targetText.isBlank()) {
            return targetText;
        }
        Object fromParams = params.get("text");
        return fromParams == null ? null : String.valueOf(fromParams);
    }
}
