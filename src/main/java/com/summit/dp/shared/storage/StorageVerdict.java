package com.summit.dp.shared.storage;

/**
 * 启动期「数据目录形态 × 引擎设置」的判定结果。
 *
 * <p>只有 {@link #FIRST_INSTALL} 与 {@link #READY} 允许启动；其余四种一律在环境期抛错终止，
 * 保证「选错引擎」不会变成「静默建空库」。</p>
 */
public enum StorageVerdict {

    /** 目录不存在或为空：按当前引擎首装建库。 */
    FIRST_INSTALL(true),

    /** 目录里的数据与引擎一致：正常启动。 */
    READY(true),

    /** 只有 SQLite 数据，但引擎是 H2，且没有已验证的迁移凭据。 */
    REJECT_SQLITE_DATA_WITHOUT_MIGRATION(false),

    /** 只有 H2 数据，但引擎是 SQLite。 */
    REJECT_H2_DATA_WITH_SQLITE_ENGINE(false),

    /** 两个库同时存在（或 H2 迁移凭据未通过校验）：歧义，必须先显式清理或重新迁移。 */
    REJECT_AMBIGUOUS_DATA(false),

    /** 选定引擎的驱动不在 classpath：提示缺哪个 jar，不静默回落。 */
    REJECT_MISSING_DRIVER(false);

    private final boolean startable;

    StorageVerdict(boolean startable) {
        this.startable = startable;
    }

    /** 该判定是否允许继续启动。 */
    public boolean isStartable() {
        return startable;
    }
}
