package com.summit.dp.shared.storage;

/** 只有首装和已就绪目录可以进入建库阶段。 */
public enum StorageVerdict {
    FIRST_INSTALL(true),
    READY(true),
    REJECT_LEGACY_SQLITE_DATA(false),
    REJECT_AMBIGUOUS_DATA(false),
    REJECT_MISSING_DRIVER(false);

    private final boolean startable;

    StorageVerdict(boolean startable) { this.startable = startable; }

    public boolean isStartable() { return startable; }
}
