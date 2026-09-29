package com.summit.dp.toolcall.domain.model;

/**
 * 工具调用生命周期状态（落库 {@code tool_call.status}）。
 *
 * <p>只表达「走到哪一步」：{@code pending} 等待用户、{@code in_progress} 已放行执行中、
 * {@code completed} 已收尾。**失败 / 拒绝 / 取消 / 成功等结论一律写进
 * {@code raw_output.outcome}，不在此枚举里表达**。</p>
 */
public enum ToolCallStatus {

    PENDING("pending"),
    IN_PROGRESS("in_progress"),
    COMPLETED("completed");

    private final String dbValue;

    ToolCallStatus(String dbValue) {
        this.dbValue = dbValue;
    }

    /** 数据库列取值。 */
    public String dbValue() {
        return dbValue;
    }

    /** 宽松解析数据库取值；识别不了回落 {@link #PENDING}（宁可渲染成待处理，也不静默吞掉）。 */
    public static ToolCallStatus parse(String raw) {
        if (raw == null || raw.isBlank()) {
            return PENDING;
        }
        String normalized = raw.trim().toLowerCase();
        for (ToolCallStatus status : values()) {
            if (status.dbValue.equals(normalized)) {
                return status;
            }
        }
        return PENDING;
    }
}
