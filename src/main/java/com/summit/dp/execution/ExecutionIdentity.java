package com.summit.dp.execution;

/** 非数字执行标识不能用于业务主键回查。 */
public final class ExecutionIdentity {
    private ExecutionIdentity() { }

    public static Long numericOrNull(String executionId) {
        if (executionId == null || executionId.isBlank()) return null;
        try {
            return Long.parseLong(executionId.trim());
        } catch (NumberFormatException error) {
            return null;
        }
    }
}
