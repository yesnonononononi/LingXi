package com.summit.dp.workflow.application.lifecycle;

/**
 * 挂起门禁的判定结果：放行，或带着中文业务原因阻断。
 *
 * <p>原因文案会被手动恢复直接展示给用户，所以必须是能照着做的业务提示，
 * 不能是「状态不合法」这类无信息量的说法。</p>
 */
public final class GateCheckResult {

    private static final GateCheckResult PASS = new GateCheckResult(null);

    /** 未通过的原因；通过时为 {@code null}。 */
    private final String reason;

    private GateCheckResult(String reason) {
        this.reason = reason;
    }

    /** 放行。 */
    public static GateCheckResult pass() {
        return PASS;
    }

    /** 阻断，并给出用户可读的原因。 */
    public static GateCheckResult blocked(String reason) {
        if (reason == null || reason.isBlank()) {
            throw new IllegalArgumentException("门禁阻断必须给出原因");
        }
        return new GateCheckResult(reason);
    }

    public boolean allowed() {
        return reason == null;
    }

    /** 阻断原因；放行时为 {@code null}。 */
    public String reason() {
        return reason;
    }
}
