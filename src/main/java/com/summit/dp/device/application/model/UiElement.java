package com.summit.dp.device.application.model;

/**
 * 压缩后的界面节点。
 *
 * <p>只保留决策需要的字段：原始 AccessibilityNodeInfo 树上万个字符，喂给模型既贵又噪。
 * idx 是本次观察内的稳定序号，agent 用它指代目标，比让它自己算坐标可靠得多。</p>
 */
public record UiElement(
        int idx,
        String role,
        String text,
        String hint,
        NormalizedBounds bounds,
        boolean clickable,
        boolean enabled,
        boolean editable,
        Boolean checked,
        int depth
) {

    /** 目标的可读描述：优先文本，其次 hint，最后退化为角色+序号。 */
    public String describe() {
        if (text != null && !text.isBlank()) {
            return text;
        }
        if (hint != null && !hint.isBlank()) {
            return hint;
        }
        return role + "#" + idx;
    }
}
