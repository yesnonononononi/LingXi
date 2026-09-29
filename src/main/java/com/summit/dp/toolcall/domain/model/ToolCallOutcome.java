package com.summit.dp.toolcall.domain.model;

/**
 * 结论 / 异常判别字段（{@code tool_call.raw_output.outcome}）。
 *
 * <p>这是区分「已批准执行成功」「被拒绝」「已取消」「失败」的**唯一依据**，
 * 替代旧实现基于 {@code [rejected]} 前缀的字符串嗅探。</p>
 */
public enum ToolCallOutcome {

    /** 计划 / 命令：用户批准。 */
    APPROVED,
    /** 用户拒绝（命令未执行 / 计划被否）。 */
    REJECTED,
    /** 提问：用户作答。 */
    ANSWERED,
    /** 会话停止 / 执行取消。 */
    CANCELLED,
    /** 工具执行成功。 */
    SUCCEEDED,
    /** 工具执行失败。 */
    FAILED,
    /** 工具执行超时。 */
    TIMED_OUT;

    /** 数据库 / JSON 字符串取值（即枚举名）。 */
    public String value() {
        return name();
    }

    /** 由框架 {@code ToolCallStatus} 映射而来（框架侧含 STARTED/PROMISED，业务侧不落库）。 */
    public static ToolCallOutcome fromFrameworkStatus(String frameworkStatus) {
        if (frameworkStatus == null) {
            return FAILED;
        }
        return switch (frameworkStatus) {
            case "COMPLETED" -> SUCCEEDED;
            case "TIMED_OUT" -> TIMED_OUT;
            case "CANCELLED" -> CANCELLED;
            case "FAILED", "REJECTED" -> FAILED;
            default -> FAILED;
        };
    }
}
