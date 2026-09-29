package com.summit.dp.shared.local;

/** 本地单实例的稳定标识。不是用户 ID，不参与账号语义。 */
public final class LocalInstance {
    private LocalInstance() {}

    /**
     * 稳定的本地实例标识，用作工作空间隔离域（principal）。
     * 约束：必须是 String 且不可是纯数字形式，避免被误当作用户 ID 沿用。
     */
    public static final String ID = "local";

    /** 单实例设置行的固定主键（user_configs 单例行）。 */
    public static final long SETTINGS_ROW_ID = 1L;
}
