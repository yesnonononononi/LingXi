package com.summit.dp.shared.storage;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * 数据目录到「实际文件路径」的唯一解析处。
 *
 * <p>数据集合固定为三样东西，永远同进同退：引擎库文件、{@code checkpoints/} 下的检查点正文、
 * 以及迁移凭据 {@code migration-from-sqlite.json}。三者的相对位置只在本类定义一次，
 * 任何地方都不许另拼路径。</p>
 */
public final class StorageLayout {

    /** 检查点正文目录（{@code execution.snapshot_file} 指向其中的文件）。 */
    private static final String CHECKPOINTS_DIRECTORY = "checkpoints";

    /** SQLite→H2 一次性迁移的凭据文件名。 */
    private static final String MIGRATION_MANIFEST = "migration-from-sqlite.json";

    private final Path dataDir;
    private final StorageEngine engine;

    /**
     * @param dataDir 数据目录（会被规范化为绝对路径）
     * @param engine  生效引擎，决定 {@link #databaseFile()} 指向哪个库文件
     */
    public StorageLayout(Path dataDir, StorageEngine engine) {
        if (dataDir == null) {
            throw new IllegalArgumentException("数据目录不能为空");
        }
        if (engine == null) {
            throw new IllegalArgumentException("存储引擎不能为空");
        }
        this.dataDir = dataDir.toAbsolutePath().normalize();
        this.engine = engine;
    }

    /** 数据目录（绝对、已规范化）。 */
    public Path dataDir() {
        return dataDir;
    }

    /** 生效引擎。 */
    public StorageEngine engine() {
        return engine;
    }

    /** 当前引擎的库文件：SQLite 是 {@code lingxi.sqlite}，H2 是 {@code lingxi-h2.mv.db}。 */
    public Path databaseFile() {
        return dataDir.resolve(engine.databaseFileName());
    }

    /** SQLite 库文件（无论当前引擎是什么，都用于形态判定）。 */
    public Path sqliteFile() {
        return dataDir.resolve(StorageEngine.SQLITE.databaseFileName());
    }

    /** H2 库文件（无论当前引擎是什么，都用于形态判定）。 */
    public Path h2File() {
        return dataDir.resolve(StorageEngine.H2.databaseFileName());
    }

    /** 检查点正文目录。 */
    public Path checkpointsDir() {
        return dataDir.resolve(CHECKPOINTS_DIRECTORY);
    }

    /** 迁移凭据文件。 */
    public Path migrationManifest() {
        return dataDir.resolve(MIGRATION_MANIFEST);
    }

    /**
     * 目录里是否躺着 SQLite 数据。
     *
     * <p>除主库文件外还算上 {@code -wal}/{@code -shm} 伴随文件：进程被强杀后可能只剩它们，
     * 那种残骸同样是「这里有 SQLite 数据」的证据，不能当成空目录去建 H2 库。</p>
     */
    public boolean hasSqliteData() {
        Path file = sqliteFile();
        return Files.exists(file)
                || Files.exists(file.resolveSibling(file.getFileName() + "-wal"))
                || Files.exists(file.resolveSibling(file.getFileName() + "-shm"));
    }

    /** 目录里是否躺着 H2 库（数据文件，不含 {@code .trace.db} 之类运行时产物）。 */
    public boolean hasH2Data() {
        return Files.exists(h2File());
    }
}
