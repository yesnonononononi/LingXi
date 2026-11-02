package com.summit.dp.shared.storage;

import java.nio.file.Files;
import java.nio.file.Path;

/** 旧库只用于迁移守卫，运行期只打开 H2；检查点与库必须一起备份。 */
public final class StorageLayout {
    private final Path dataDir;

    public StorageLayout(Path dataDir) {
        if (dataDir == null) {
            throw new IllegalArgumentException("数据目录不能为空");
        }
        this.dataDir = dataDir.toAbsolutePath().normalize();
    }

    public Path dataDir() { return dataDir; }
    public Path databaseFile() { return dataDir.resolve(H2Storage.DATABASE_FILE_NAME); }
    public Path legacySqliteFile() { return dataDir.resolve("lingxi.sqlite"); }
    public Path checkpointsDir() { return dataDir.resolve("checkpoints"); }
    public Path migrationManifest() { return dataDir.resolve("migration-from-sqlite.json"); }

    /** 强退后残留的日志也算旧数据，不能把它当成首装目录。 */
    public boolean hasLegacySqliteData() {
        Path file = legacySqliteFile();
        return Files.exists(file)
                || Files.exists(file.resolveSibling(file.getFileName() + "-wal"))
                || Files.exists(file.resolveSibling(file.getFileName() + "-shm"))
                || Files.exists(file.resolveSibling(file.getFileName() + "-journal"));
    }

    public boolean hasH2Data() { return Files.exists(databaseFile()); }
}
