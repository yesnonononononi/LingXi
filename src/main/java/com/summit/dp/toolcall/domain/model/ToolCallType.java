package com.summit.dp.toolcall.domain.model;

/**
 * 工具调用类型（落库 {@code tool_call.type}）。
 *
 * <p>表达「是否需要人工决策」：{@link #PROMISE} = 人工在环（计划 / 提问 / 命令审批），
 * {@link #EXECUTE} = 框架直通（普通工具）。</p>
 */
public enum ToolCallType {
    /** 人工在环：登记后初始化为 pending，等待用户决策。 */
    PROMISE,
    /** 框架直通：执行期间短暂 in_progress，结束即 completed。 */
    EXECUTE
}
