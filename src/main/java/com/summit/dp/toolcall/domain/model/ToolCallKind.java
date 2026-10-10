package com.summit.dp.toolcall.domain.model;

import java.util.Locale;

/**
 * 卡片形态判别字段（{@code tool_call.content.kind}）。
 *
 * <p>前端据此选择渲染器，是卡片形态的**唯一判别依据**；{@code tool_name} 仅用于展示，
 * 不作判别。{@link #EXECUTE} 对应无卡片载荷的普通工具。</p>
 */
public enum ToolCallKind {
    PLAN,
    CHOICE,
    COMMAND,
    EXECUTE;

    /** 宽松解析；识别不了返回 {@code null}（降级为「状态不可用」，不抛异常）。 */
    public static ToolCallKind fromName(String name) {
        if (name == null || name.isBlank()) {
            return null;
        }
        try {
            return ToolCallKind.valueOf(name.trim().toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
