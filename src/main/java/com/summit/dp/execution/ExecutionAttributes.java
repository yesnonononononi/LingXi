package com.summit.dp.execution;

import java.util.Map;

/** Business identity carried through the framework as opaque request attributes. */
public final class ExecutionAttributes {
    public static final String SESSION_ID = "lingxi.session_id";
    public static final String AGENT_ID = "lingxi.agent_id";
    public static final String MODEL_CONFIG_ID = "lingxi.model_config_id";
    public static final String WORKSPACE_ID = "lingxi.workspace_id";
    public static final String ROOT_EXECUTION_ID = "lingxi.root_execution_id";
    public static final String TEAM_ID = "lingxi.team_id";

    private ExecutionAttributes() { }

    /**
     * 读取属性并转成 {@code Long}。
     *
     * <p>属性值可能是业务侧写入的 {@code String}，也可能是执行快照 JSON 往返后被反序列化成的数值，
     * 因此统一经 {@code String.valueOf} 解析。缺失、空白或不可解析一律返回 {@code null}——
     * 这里只负责解析，是否「跳过」还是「报错」由调用方决定，不在此抛异常。</p>
     *
     * @param attributes 请求/工具执行携带的不透明属性
     * @param key        属性键，见本类常量
     * @return 解析出的 {@code Long}；无法解析返回 {@code null}
     */
    public static Long readLong(Map<String, Object> attributes, String key) {
        if (attributes == null || key == null) {
            return null;
        }
        Object raw = attributes.get(key);
        return raw == null ? null : parseLong(String.valueOf(raw));
    }

    /**
     * 本次协作的根执行 ID。
     *
     * <p>子执行由委派方写入 {@link #ROOT_EXECUTION_ID}，取该属性即为根执行；
     * 根执行自身没有该属性（{@code ExecutionContext.root} 的 rootExecutionId 为 null，
     * 序列化时被跳过），此时回落到当前执行 ID。根执行与子执行由此得到<b>同一个</b>值，
     * 这正是邮箱业务键的一半。</p>
     *
     * @param attributes         请求/循环上下文携带的不透明属性
     * @param currentExecutionId 当前执行 ID
     * @return 协作根执行 ID；无法解析返回 {@code null}
     */
    public static Long workflowExecutionId(Map<String, Object> attributes, String currentExecutionId) {
        Long root = readLong(attributes, ROOT_EXECUTION_ID);
        return root != null ? root : parseLong(currentExecutionId);
    }

    /** 宽松解析：非数字（含 null、空白、雪花 ID 之外的脏值）一律返回 null，不抛异常。 */
    private static Long parseLong(String text) {
        if (text == null) {
            return null;
        }
        String trimmed = text.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        try {
            return Long.valueOf(trimmed);
        } catch (NumberFormatException e) {
            return null;
        }
    }
}
