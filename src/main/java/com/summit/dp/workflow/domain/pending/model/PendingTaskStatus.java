package com.summit.dp.workflow.domain.pending.model;

/**
 * 待发送任务状态。
 *
 * <p>只有 {@link #PENDING} 会被派发：{@link #AWAITING_CONFIRM} 是上次进程遗留、必须由用户点继续，
 * {@link #PAUSED} 是派发失败停在原地。三态都留在库里，重启后用户仍能看到原因。</p>
 */
public enum PendingTaskStatus {
    /** 本进程内入队，可自动派发。 */
    PENDING,
    /** 派发失败，等用户处理（原因在 failure 列）。 */
    PAUSED,
    /** 上次进程遗留，等用户确认后才回到 PENDING。 */
    AWAITING_CONFIRM;

    public static PendingTaskStatus fromName(String name) {
        if (name == null || name.isBlank()) {
            return PENDING;
        }
        return valueOf(name.trim().toUpperCase());
    }
}
