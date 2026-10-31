package com.summit.dp.user_configs.infrastructure.fs;

import com.summit.dp.execution.application.port.ExecutionCheckpointStore;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.storage.StorageEngine;
import com.summit.dp.shared.storage.StorageEngineProperties;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import javax.sql.DataSource;
import java.io.IOException;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.sql.Connection;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;
import java.util.stream.Stream;

/**
 * 设置目录搬迁：改 {@code dataDir} / {@code skillDir} 时把现有内容搬到新目录。
 *
 * <p><b>为什么改配置不能只改动一个字符串</b>：旧目录里躺着真数据（库文件、用户目录下的
 * 检查点正文、用户的 SKILL.md），只改路径会让新目录空空如也 —— 用户看到的现象是「数据没了」。
 * 因此搬迁必须先于落库：搬失败就抛错，配置保持原样，不会出现「配置指向空目录」。</p>
 *
 * <h2>数据目录搬迁按存储引擎分派</h2>
 *
 * <p>数据目录 = 一个集合：<b>当前引擎的库文件 + {@code checkpoints} 目录</b>。库里只存检查点正文的
 * 文件标识，正文在文件系统里；两者不一致就是「库指向不存在的正文」，所以这两样必须在<b>同一段
 * 排除检查点写入的窗口</b>里搬。</p>
 *
 * <ul>
 *   <li><b>SQLite（缺省引擎）</b>：{@code VACUUM INTO} 生成库的一致性快照，再把 checkpoints 整棵复制过去。
 *       用快照而不是文件复制，是因为库正被本进程握着：直接 copy 可能拿到写了一半的页，
 *       还有 {@code -wal} 里未合并的提交。</li>
 *   <li><b>H2</b>：<b>运行期不支持数据目录搬迁</b>，在任何文件操作之前直接拒绝，并指引离线工具。
 *       原因见 {@link #h2RuntimeMigrationUnsupported(Path)}。</li>
 * </ul>
 *
 * <h2>执行顺序（每一步都为「失败也不毁数据」服务）</h2>
 *
 * <ol>
 *   <li>路径规范化；来源与目标相同则直接返回（空操作，不连库也不碰盘）；</li>
 *   <li><b>只读</b>校验目标目录（含异物就拒绝）。此步刻意不建目录、不删文件；</li>
 *   <li>引擎闸门：H2 在此处拒绝 —— 此时目标目录里的任何文件都还没被动过；</li>
 *   <li>快照到<b>临时位置</b>（与库文件同目录，保证可原子替换）；</li>
 *   <li>快照成功后才替换目标库文件并清理陈旧的伴随文件；</li>
 *   <li>最后复制检查点正文。</li>
 * </ol>
 *
 * <p>任何失败路径都只删除本次产生的临时快照，<b>绝不删除</b>目标目录里既有的文件 ——
 * 那里可能正是上一次搬迁留下的、用户还能退回恢复的旧库。</p>
 */
@Component
@Slf4j
public class SettingsDirectoryMigrator {

    /**
     * 库文件名。
     *
     * <p>取自 {@link StorageEngine}（文件名与 JDBC 逻辑名的单一事实源），本类不再自带一份字符串 ——
     * 否则改引擎文件名时这里会静默失配，表现为「搬迁搬了个空目录」。</p>
     */
    private static final String DATABASE_FILE = StorageEngine.SQLITE.databaseFileName();

    /** 快照的临时文件名前缀：与库文件同目录才能原子替换；进程被打断时下次搬迁可识别并清理。 */
    private static final String INCOMING_PREFIX = DATABASE_FILE + ".incoming-";

    /** 库文件的伴随文件后缀：新鲜快照旁边留着旧的 -wal/-shm 会让 SQLite 用错日志。 */
    private static final List<String> DATABASE_COMPANION_SUFFIXES = List.of("-wal", "-shm", "-journal");

    /** 检查点正文目录名：与库文件同属「数据目录」这个集合。 */
    private static final String CHECKPOINT_DIRECTORY = "checkpoints";

    /** 离线迁移工具：写进拒绝消息，让用户能照着做。 */
    private static final String OFFLINE_MIGRATION_TOOL = "scripts/Migrate-SqliteToH2.ps1";

    private final DataSource dataSource;
    private final ExecutionCheckpointStore checkpointStore;
    /**
     * 存储引擎开关的权威来源（Spring 注入）。为 {@code null} 时退回「读数据源元数据判定」，
     * 供测试与工具直接 {@code new} 的场景使用。
     */
    private final StorageEngineProperties storageEngineProperties;

    /**
     * 生产装配：引擎取自存储开关（与启动期守卫、建库、方言同一个事实源）。
     *
     * @param dataSource              当前引擎的数据源
     * @param checkpointStore         检查点正文存储
     * @param storageEngineProperties 存储引擎开关（Spring 注入，不可为 null）
     */
    @Autowired
    public SettingsDirectoryMigrator(DataSource dataSource, ExecutionCheckpointStore checkpointStore,
                                     StorageEngineProperties storageEngineProperties) {
        this.dataSource = dataSource;
        this.checkpointStore = checkpointStore;
        this.storageEngineProperties = storageEngineProperties;
    }

    /**
     * 兼容既有构造方式（测试与工具）：引擎由数据源元数据判定。
     *
     * <p>元数据判定只读 {@code DatabaseMetaData}，不写数据目录；连不上库时按缺省引擎继续，
     * 让后续步骤给出「快照未生成」这种更准确的失败原因，而不是在这里误报引擎错误。</p>
     *
     * @param dataSource      数据源
     * @param checkpointStore 检查点正文存储
     */
    public SettingsDirectoryMigrator(DataSource dataSource, ExecutionCheckpointStore checkpointStore) {
        this(dataSource, checkpointStore, null);
    }

    /**
     * 把「库的一致性快照 + checkpoints 目录」当作一个集合搬到新目录；落库由调用方负责。
     *
     * <p>目标目录必须为空（或只含上一次搬迁留下的库文件、伴随文件与检查点目录），否则用户可能
     * 选错了地方，覆盖掉别的应用的数据 —— 宁可直接拒绝。</p>
     *
     * <p>H2 引擎下本方法在任何文件操作之前就失败（见类注释的顺序第 3 步）：
     * H2 的库文件被本进程独占写入，热复制得到的是损坏的库，运行期没有安全的搬迁手段。</p>
     *
     * @param fromDir 当前数据目录
     * @param toDir   新的数据目录
     * @throws ClientException 目录非法、目标非空、引擎不支持运行期搬迁、快照或复制失败
     */
    public void migrateDataDir(String fromDir, String toDir) {
        Path from = normalize(fromDir, "当前数据目录");
        Path to = normalize(toDir, "新的数据目录");
        if (from.equals(to)) {
            log.info("数据目录未变化，跳过搬迁: dir={}", from);
            return;
        }
        // ①② 只读校验：此步不建目录也不删文件 —— 引擎闸门之前目标目录必须保持原样。
        validateTarget(to);
        requireRuntimeMigrationSupported(to);
        createDirectories(to);

        Path target = to.resolve(DATABASE_FILE);
        Path incoming = to.resolve(INCOMING_PREFIX + UUID.randomUUID());
        ExecutionCheckpointStore.CopyResult files = snapshotThenReplace(target, incoming);

        log.info("数据目录搬迁完成: from={}, to={}, copiedCheckpointFiles={}", from, to,
                files == null ? 0 : files.copiedFiles());
    }

    /**
     * 在「检查点写入静默」窗口内：快照到临时位置 → 成功后替换目标库文件 → 复制检查点正文。
     *
     * <p>三步必须在同一个窗口里，否则中间插进来一次检查点保存，库与正文就对不上了。</p>
     *
     * <p>失败时只清理本次的临时快照：目标目录里既有的库文件/伴随文件一个都不动
     * （旧实现是先删目标残留再做快照，快照一失败就变成「旧的被删、新的没来」）。</p>
     *
     * @param target   目标库文件路径（替换只发生在快照成功之后）
     * @param incoming 本次快照的临时路径（失败时删除，成功时被 move 走）
     * @return 检查点正文的复制结果，可能为 {@code null}（存储实现未回报）
     */
    private ExecutionCheckpointStore.CopyResult snapshotThenReplace(Path target, Path incoming) {
        AtomicReference<ExecutionCheckpointStore.CopyResult> copied = new AtomicReference<>();
        try {
            checkpointStore.withWriteQuiesced(() -> {
                vacuumInto(incoming);
                promote(incoming, target);
                copied.set(checkpointStore.copyTo(target.getParent().toString()));
            });
            return copied.get();
        } catch (IllegalStateException busy) {
            // 拿不到静默窗口：只删本次临时快照，目标目录里既有文件原样保留；
            // 已复制过去的正文只是副本，下次迁移会覆盖或由清理回收。
            deleteQuietly(incoming);
            throw new ClientException(busy.getMessage(), busy);
        } catch (RuntimeException failure) {
            // 快照/替换/复制任一步失败：同样只清理本次临时产物。
            deleteQuietly(incoming);
            throw failure;
        }
    }

    /**
     * 把技能目录整棵树复制到新目录，同名文件以旧目录为准；其它文件保留不动。
     *
     * <p>不做「目标必须为空」的限制：技能目录常是用户自己攒的，清空式搬迁等于删他的文件。
     * 新目录立即生效（{@code SkillRootResolver} 每次解析当前设置），因此无需重启。</p>
     *
     * <p>技能目录是纯文件、与库无关，两个引擎下都照常可用。</p>
     *
     * @param fromDir 当前技能目录（为空表示原来未启用）
     * @param toDir   新的技能目录
     * @throws ClientException 路径非法、目标套在来源内部或复制失败
     */
    public void migrateSkillDir(String fromDir, String toDir) {
        Path to = normalize(toDir, "新的技能目录");
        if (fromDir == null || fromDir.isBlank()) {
            // 原来就没启用 Skill：没有可搬的内容，把新目录建出来即可。
            log.warn("当前未配置技能目录，仅创建新目录: to={}", to);
            createDirectories(to);
            return;
        }
        Path from = normalize(fromDir, "当前技能目录");
        if (from.equals(to)) {
            log.info("技能目录未变化，跳过搬迁: dir={}", from);
            return;
        }
        if (to.startsWith(from)) {
            // 新目录套在旧目录里：边遍历边写入会越套越深。
            throw new ClientException("新的技能目录不能位于当前技能目录内部: " + to);
        }
        createDirectories(to);
        if (!Files.isDirectory(from)) {
            log.warn("当前技能目录不存在，仅创建新目录: from={}", from);
            return;
        }
        try (Stream<Path> paths = Files.walk(from)) {
            List<Path> entries = paths.sorted(Comparator.naturalOrder()).toList();
            for (Path entry : entries) {
                Path destination = to.resolve(from.relativize(entry).toString());
                if (Files.isDirectory(entry)) {
                    Files.createDirectories(destination);
                } else {
                    Files.createDirectories(destination.getParent());
                    Files.copy(entry, destination, StandardCopyOption.REPLACE_EXISTING);
                }
            }
        } catch (IOException e) {
            throw new ClientException("技能目录搬迁失败: " + e.getMessage(), e);
        }
        log.info("技能目录搬迁完成: from={}, to={}", from, to);
    }

    /**
     * 目标数据目录要么不存在，要么是空的，要么只剩上一次搬迁留下的库文件与检查点目录。
     *
     * <p><b>只读</b>：不创建目录、不删除任何文件。校验先于引擎闸门，这样 H2 被拒绝时
     * 目标目录一定还是原样（连目录都不会被建出来）。</p>
     *
     * @param target 目标数据目录
     * @throws ClientException 目标是普通文件、含异物或不可读
     */
    private void validateTarget(Path target) {
        if (Files.isRegularFile(target, LinkOption.NOFOLLOW_LINKS)) {
            throw new ClientException("目标数据目录是一个文件: " + target);
        }
        if (!Files.isDirectory(target, LinkOption.NOFOLLOW_LINKS)) {
            // 目录还不存在：等价于空目录，放行；真正的创建推迟到引擎闸门之后。
            return;
        }
        try (Stream<Path> children = Files.list(target)) {
            List<String> foreign = children
                    .map(path -> path.getFileName().toString())
                    .filter(name -> !isDatabaseArtifact(name))
                    .filter(name -> !isCheckpointDirectory(target.resolve(name)))
                    .toList();
            if (!foreign.isEmpty()) {
                throw new ClientException("目标数据目录非空（含 " + String.join("、", foreign) + "），请选择空目录");
            }
        } catch (IOException e) {
            throw new ClientException("目标数据目录不可读: " + target, e);
        }
    }

    /**
     * 引擎闸门：H2 直接拒绝。
     *
     * @param target 目标数据目录（仅用于把路径写进错误消息）
     * @throws ClientException 当前引擎不支持运行期数据目录搬迁
     */
    private void requireRuntimeMigrationSupported(Path target) {
        if (resolveEngine().isH2()) {
            throw new ClientException(h2RuntimeMigrationUnsupported(target));
        }
    }

    /**
     * H2 引擎下的拒绝文案：点名引擎、说明为什么不能热复制、给出两条可执行的替代路径。
     *
     * <p>以前这里会把 SQLite 专有的 {@code VACUUM INTO} 直接发给 H2，用户看到的是一句
     * {@code Syntax error in SQL statement ... [*]VACUUM INTO ...}（错误码 42000）；
     * 更糟的是旧顺序会先删掉目标目录里的旧库再失败，等于把用户还能退回恢复的数据一起弄没了。</p>
     *
     * @param target 目标数据目录
     * @return 给用户看的完整说明
     */
    private String h2RuntimeMigrationUnsupported(Path target) {
        return "当前存储引擎是 H2，不支持运行期数据目录搬迁：H2 的库文件（"
                + StorageEngine.H2.databaseFileName() + "）正被本进程独占写入，热复制只会得到损坏的库。"
                + "请改用离线方式迁移：先停止应用，执行 " + OFFLINE_MIGRATION_TOOL
                + " 完成 SQLite→H2 的一次性迁移；或者停库后手工把整个数据目录（"
                + StorageEngine.H2.databaseFileName() + " 与 " + CHECKPOINT_DIRECTORY
                + " 目录）复制到新位置，再修改数据目录设置。目标目录=" + target;
    }

    /**
     * 解析当前生效引擎：优先取存储开关，其次读数据源元数据。
     *
     * <p>元数据判定失败（连不上库、测试替身返回 {@code null}）时按缺省引擎继续，
     * 由后续快照步骤给出更准确的失败原因，而不是在这里误判引擎。</p>
     *
     * @return 生效引擎，绝不返回 {@code null}
     */
    private StorageEngine resolveEngine() {
        if (storageEngineProperties != null) {
            return storageEngineProperties.getEngine();
        }
        try (Connection connection = dataSource.getConnection()) {
            if (connection == null) {
                return StorageEngine.SQLITE;
            }
            String product = connection.getMetaData().getDatabaseProductName();
            if (product != null && product.toUpperCase(Locale.ROOT).contains("H2")) {
                return StorageEngine.H2;
            }
            return StorageEngine.SQLITE;
        } catch (SQLException | RuntimeException failure) {
            log.debug("无法从数据源元数据判定存储引擎，按缺省引擎继续: reason={}", failure.getMessage());
            return StorageEngine.SQLITE;
        }
    }

    /** 库文件本体、伴随文件（-wal / -shm / -journal）、以及上次被打断留下的临时快照都算「上一次搬迁的残留」。 */
    private static boolean isDatabaseArtifact(String name) {
        return name.equals(DATABASE_FILE)
                || name.startsWith(DATABASE_FILE + "-")
                || name.startsWith(INCOMING_PREFIX);
    }

    /** 检查点目录是数据集合的另一半，同样是「上一次搬迁的残留」，允许复用。 */
    private static boolean isCheckpointDirectory(Path path) {
        return path.getFileName().toString().equals(CHECKPOINT_DIRECTORY)
                && Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS);
    }

    /**
     * 生成库的一致性快照到临时位置。
     *
     * <p>{@code VACUUM INTO} 只接受单引号里的字面量路径：反斜杠原样传入即可，但要把引号转义掉。
     * 目标文件必须不存在，因此每次都落到一个新的临时名上 —— 目标目录里既有的库文件不受影响。</p>
     *
     * @param incoming 本次快照的临时路径
     * @throws ClientException 快照未生成
     */
    private void vacuumInto(Path incoming) {
        String location = incoming.toAbsolutePath().toString().replace('\\', '/').replace("'", "''");
        try (Connection connection = dataSource.getConnection();
             Statement statement = connection.createStatement()) {
            statement.execute("VACUUM INTO '" + location + "'");
        } catch (SQLException e) {
            throw new ClientException("数据目录迁移失败，数据库快照未生成: " + e.getMessage(), e);
        }
    }

    /**
     * 快照就位：原子替换目标库文件，并清掉陈旧的伴随文件。
     *
     * <p>只有快照真的生成成功才会走到这里，因此这是「替换/清理」的唯一入口 ——
     * 任何失败路径都不会碰目标目录里的既有文件。</p>
     *
     * @param incoming 已生成的快照
     * @param target   目标库文件
     * @throws ClientException 替换失败
     */
    private void promote(Path incoming, Path target) {
        try {
            Files.move(incoming, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (AtomicMoveNotSupportedException notAtomic) {
            // 极少数文件系统不支持原子 move：退回普通替换（仍发生在快照成功之后）。
            log.debug("目标文件系统不支持原子替换，改用普通 move: target={}", target);
            try {
                Files.move(incoming, target, StandardCopyOption.REPLACE_EXISTING);
            } catch (IOException e) {
                throw new ClientException("数据目录迁移失败，库快照未能就位: " + target + "（" + e.getMessage() + "）", e);
            }
        } catch (IOException e) {
            throw new ClientException("数据目录迁移失败，库快照未能就位: " + target + "（" + e.getMessage() + "）", e);
        }
        for (String suffix : DATABASE_COMPANION_SUFFIXES) {
            deleteQuietly(target.resolveSibling(target.getFileName() + suffix));
        }
    }

    private Path normalize(String raw, String label) {
        if (raw == null || raw.isBlank()) {
            throw new ClientException(label + "不能为空");
        }
        try {
            return Path.of(raw.trim()).toAbsolutePath().normalize();
        } catch (InvalidPathException e) {
            throw new ClientException(label + "不是合法路径: " + raw, e);
        }
    }

    private void createDirectories(Path directory) {
        try {
            Files.createDirectories(directory);
        } catch (IOException e) {
            throw new ClientException("目录创建失败: " + directory, e);
        }
    }

    private void deleteQuietly(Path path) {
        try {
            Files.deleteIfExists(path);
        } catch (IOException e) {
            log.warn("临时文件清理失败: path={}", path, e);
        }
    }
}
