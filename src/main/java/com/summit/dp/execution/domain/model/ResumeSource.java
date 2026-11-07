package com.summit.dp.execution.domain.model;

import java.util.Locale;

/**
 * 恢复请求的来源（持久化口径）。
 *
 * <p><b>为什么领域层要自己有一份，而不是直接引用 {@code ResumeTriggerType}</b>：
 * 后者是应用层「门禁怎么判」的策略枚举；领域模型若反过来依赖应用层，{@code execution}
 * 与 {@code workflow} 两个包就互为依赖。这里只保留「持久化需要知道」的部分：
 * 能不能升级、是不是人发起的。两边的对应关系由应用层一处映射，并有等价性用例守着。</p>
 *
 * <p><b>wire 值不可改</b>：进程重启后按字面量读回存量行判断准入。</p>
 */
public enum ResumeSource {

    /** 用户手动 {@code /resume}：同步预检 + 同步恢复，允许覆盖暂停。 */
    MANUAL_USER_RESUME("MANUAL_USER_RESUME", true),

    /** 审批 / 多选 / 命令决议落定后的恢复。 */
    APPROVAL_DECISION("APPROVAL_DECISION", true),

    /** 外部输入（邮件 / 后台任务 / 子代理结果）到位的自动唤醒。 */
    AUTO_INPUT_WAKEUP("AUTO_INPUT_WAKEUP", false),

    /** 进程启动时对遗留请求的收口。 */
    STARTUP_RECOVERY("STARTUP_RECOVERY", false);

    private final String dbValue;

    private final boolean humanInitiated;

    ResumeSource(String dbValue, boolean humanInitiated) {
        this.dbValue = dbValue;
        this.humanInitiated = humanInitiated;
    }

    public String dbValue() {
        return dbValue;
    }

    /** 本次恢复是否由人做出：自动轮次上限只拦非人工来源。 */
    public boolean humanInitiated() {
        return humanInitiated;
    }

    /**
     * 遗留行（列不是 NULL 但值不可识别）按 {@link #AUTO_INPUT_WAKEUP} 处理，与 NULL 同口径：
     * 保守方向是多查一道门禁，而不是替人决定。
     *
     * @param raw 库里的字面量；可为 {@code null}
     * @return 解析结果；{@code null} 表示「没有来源」（遗留行），由 {@link ExecutionResumeTask#effectiveTrigger()} 兜底
     */
    public static ResumeSource parse(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String normalized = raw.trim().toUpperCase(Locale.ROOT);
        for (ResumeSource source : values()) {
            if (source.dbValue.equals(normalized)) {
                return source;
            }
        }
        return AUTO_INPUT_WAKEUP;
    }
}
