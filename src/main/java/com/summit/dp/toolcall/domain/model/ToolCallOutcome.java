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

    /**
     * 由框架 {@link com.summit.core.tool.ToolCallStatus} 映射而来
     * （框架侧含 STARTED/PROMISED，业务侧不落库）。
     *
     * <p><b>直接吃枚举而不是字符串</b>：调用方本来就持有框架枚举，先 {@code name()} 再回来
     * 解析等于把已知的合法取值退化成可拼错的字符串；新增框架状态时编译器会在这里报穷尽性缺口。</p>
     */
    public static ToolCallOutcome fromFrameworkStatus(com.summit.core.tool.ToolCallStatus frameworkStatus) {
        if (frameworkStatus == null) {
            return FAILED;
        }
        return switch (frameworkStatus) {
            case COMPLETED -> SUCCEEDED;
            case TIMED_OUT -> TIMED_OUT;
            case CANCELLED -> CANCELLED;
            // REJECTED 仍并入 FAILED：这是既有行为，改成 REJECTED 会变更
            // raw_output.outcome 的取值（wire 值），不在纯重构范围内。
            // 「被拒绝」与「工具报错」应分开的语义问题已单独记录，待确认前端是否消费该字段后再改。
            case REJECTED, FAILED -> FAILED;
            // STARTED / PROMISED 不会走到结论映射（监听器对 PROMISED 提前返回）；
            // 真到了这里说明上游给了非终态，按失败处理而不是猜一个乐观结论。
            case STARTED, PROMISED -> FAILED;
        };
    }
}
