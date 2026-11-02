import java.io.IOException;
import java.io.InputStream;
import java.io.Reader;
import java.io.UncheckedIOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Timestamp;
import java.sql.Types;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.SortedMap;
import java.util.TimeZone;
import java.util.TreeMap;
import java.util.UUID;
import java.util.stream.Stream;

/**
 * 一次性数据搬运工具：把 SQLite 库副本整表搬到新建的 H2 文件库，并对两侧做逐表指纹比对。
 *
 * <p>为什么必须是一次性、显式、独立进程的工具：H2 文件库不能热复制（见设计 §14.3 R3），
 * 所以「换引擎」只能发生在两个进程之间——旧进程退出、工具离线搬一次、新引擎启动。
 * 工具本身不做任何自动探测：源与目标都必须由调用方显式给出，路径命中真实数据目录时直接拒绝。</p>
 *
 * <p>为什么搬完之后要算指纹：搬运动作本身很容易「看起来成功」——CLOB 被截断、时间差 8 小时、
 * 少搬一列，都不会报错。所以每张表在源侧与目标侧各算一次规范化指纹（同一份 {@link CanonicalRowCodec}），
 * 任一表行数或指纹不符即判失败，并把清单里的 {@code verified} 置为 {@code false}。</p>
 *
 * <p>用法（JDK 21 单文件源码，先编译或直接用 {@code java -cp ... tools/migrate/SqliteToH2Migration.java}）：</p>
 * <pre>
 * javac -encoding UTF-8 -cp &lt;h2.jar&gt;;&lt;sqlite-jdbc.jar&gt; -d &lt;classes&gt; tools/migrate/SqliteToH2Migration.java
 * java -cp &lt;classes&gt;;&lt;h2.jar&gt;;&lt;sqlite-jdbc.jar&gt; SqliteToH2Migration \
 *      --source &lt;sqlite 副本&gt; --target &lt;空目录&gt; --repo-root &lt;仓库根&gt;
 * java -cp ... SqliteToH2Migration --verify --source &lt;sqlite 副本&gt; --target &lt;已迁移目录&gt;
 * </pre>
 *
 * <p>退出码：{@code 0} 成功；{@code 1} 校验失败（清单已写、目标目录保留）；{@code 2} 参数或前置状态非法；
 * {@code 3} 命中路径禁区（不产生任何文件）。</p>
 */
public final class SqliteToH2Migration {

    /** 工具版本，写入清单的 {@code toolVersion}；语义变更必须同步升版本。 */
    private static final String TOOL_VERSION = "1.0.0";

    /** 退出码：全部校验通过。 */
    private static final int EXIT_SUCCESS = 0;
    /** 退出码：迁移或校验失败（数据层面），清单已落盘供定位。 */
    private static final int EXIT_VERIFICATION_FAILED = 1;
    /** 退出码：参数或前置状态非法，未产生任何文件。 */
    private static final int EXIT_INVALID_ARGUMENT = 2;
    /** 退出码：源/目标命中路径禁区，未产生任何文件。 */
    private static final int EXIT_FORBIDDEN_PATH = 3;

    /** 源库版本表名；不复刻到 H2（H2 侧由初始化器写入自己的版本与 checksum）。 */
    private static final String VERSION_TABLE = "schema_version";

    /** 清单文件名；与设计 §8 第 9 条、{@code StorageEngineGuard} 的读取路径一致。 */
    private static final String MANIFEST_FILE_NAME = "migration-from-sqlite.json";

    /** 推导结构的「禁止用于生产」标记文件名；只在演练模式下写进目标目录。 */
    private static final String DERIVED_MARKER_FILE_NAME = "DERIVED-SCHEMA-NOT-FOR-PRODUCTION.txt";

    /** 演练模式写进清单 {@code failureReason} 的固定说明（清单 {@code verified} 因此恒为 false）。 */
    private static final String DERIVED_DRILL_REASON =
            "derived schema 仅供演练，不可用于生产：本次 H2 结构按 SQLite 源库结构推导，"
                    + "大文本列会变成 VARCHAR(1000000000) 而不是 CLOB，且缺 schema_version 等基线对象；"
                    + "目标目录带 " + DERIVED_MARKER_FILE_NAME + " 标记，该库不得被应用启动使用";

    /** 「单独使用 --derive-schema」时的拒绝理由：说清为什么这不是「顺手加个开关」的事。 */
    private static final String DERIVE_WITHOUT_DRILL_MESSAGE =
            "--derive-schema 必须与 --allow-derived-schema-for-drill 同时使用：按源库结构推导 H2 DDL 会把"
                    + " SQLite 的 TEXT 列推导成 VARCHAR(1000000000) 而不是 CLOB（H2 2.5.252 实测），"
                    + "大文本整段驻留等于精准复刻历史 OOM 事故；因此推导只允许用于演练，"
                    + "且产物清单恒为 verified=false、目标目录会写 " + DERIVED_MARKER_FILE_NAME;

    /** H2 库文件名主干；最终库文件为 {@code <主干>.mv.db}。 */
    private static final String DEFAULT_DATABASE_NAME = "lingxi-h2";

    /** 批大小默认值；CLOB 行不走批处理，按行即时下发。 */
    private static final int DEFAULT_BATCH_SIZE = 500;

    /** 清单 {@code failureReason} 的长度上限，避免把整段异常栈塞进凭据文件。 */
    private static final int FAILURE_REASON_LIMIT = 4000;

    /** 指纹里 CLOB 分块读取用的字符缓冲大小（每块 8K 字符，避免整段驻留）。 */
    private static final int STREAM_CHUNK_CHARS = 8192;

    /** 差异定位时单列值的预览长度。 */
    private static final int PREVIEW_LIMIT = 60;

    /** 设计 §附录A.2 的 CLOB 列清单（表.列，全小写）：这类列在 H2 必须按 CLOB 建，比对时按全文哈希。 */
    private static final Set<String> CLOB_COLUMNS = Set.of(
            "session_context.content",
            "session_message.content",
            "tool_call.content",
            "tool_call.raw_input",
            "tool_call.raw_output",
            "tool_call.meta_data",
            "runtime_config_revision.payload",
            "task.command_text",
            "task.intention",
            "task.output",
            "agent.prompt",
            "agent.tool_list",
            "email_message.content",
            "checklist_step.content",
            "execution_resume_task.error_reason",
            "chat_turn.error_reason");

    /** 时间列规范化格式：UTC 墙钟，毫秒精度（与 SQLite 侧 {@code TimeTextCodec} 的文本格式一致）。 */
    private static final DateTimeFormatter TIMESTAMP_TEXT =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss.SSS", Locale.ROOT).withZone(ZoneOffset.UTC);

    /** 清单里的时间戳格式：ISO-8601 UTC，固定毫秒。 */
    private static final DateTimeFormatter MANIFEST_TIME =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT).withZone(ZoneOffset.UTC);

    /** UTC 日历：写/读 TIMESTAMP 时显式传入，避免 JVM 默认时区把墙钟搬走 8 小时。 */
    private static final Calendar UTC_CALENDAR = Calendar.getInstance(TimeZone.getTimeZone("UTC"));

    private static final String USAGE = String.join(System.lineSeparator(),
            "用法:",
            "  SqliteToH2Migration --source <sqlite 副本> --target <空目录> [选项]",
            "  SqliteToH2Migration --verify --source <sqlite 副本> --target <已迁移目录> [选项]",
            "必填:",
            "  --source <file>             SQLite 库副本（只读打开，PRAGMA query_only=1）",
            "  --target <dir>              目标目录；迁移时必须不存在或为空",
            "  --repo-root <dir>           仓库根目录，用于数据目录禁区判定（缺省会向上找 pom.xml）",
            "可选:",
            "  --checkpoints <dir>         检查点正文目录，默认 <source 父目录>/checkpoints",
            "  --manifest <file>           清单路径，默认 <target>/" + MANIFEST_FILE_NAME,
            "  --batch <n>                 批大小，默认 " + DEFAULT_BATCH_SIZE,
            "  --schema <file>             H2 基线 DDL；缺省按仓库约定路径查找",
            "  --derive-schema             演练：按源库结构推导 H2 DDL；必须与 --allow-derived-schema-for-drill 同时使用，",
            "                              清单 verified 恒为 false 且目标目录写 " + DERIVED_MARKER_FILE_NAME,
            "  --allow-derived-schema-for-drill  确认「我只要演练、产物不用于生产」的硬开关（单独使用无效）",
            "  --database-name <name>      H2 库文件名主干，默认 " + DEFAULT_DATABASE_NAME,
            "  --verify                    只复算并比对，不写业务数据");

    /** 当前调用的参数（一次进程只跑一种模式）。 */
    private MigrationOptions options = null;

    /** 本次要搬运/比对的表计划，由 {@link #buildTablePlans(Connection, Connection)} 填充。 */
    private List<TablePlan> tablePlans = List.of();

    /** 每条指纹对象，供 {@link #restartIdentities(Connection)} 回填 {@code identityRestarted}。 */
    private List<TableFingerprint> tableFingerprints = List.of();

    /** 失败原因累积器；非空即 {@code verified=false}。 */
    private final List<String> failures = new ArrayList<>();

    /** 本次迁移要执行的 H2 结构脚本；{@code null} 表示按源库结构推导（仅演练）。 */
    private Path schemaScript = null;

    /** 是否处于「推导结构演练」模式：此时清单 {@code verified} 恒为 false，并写禁止用于生产的标记文件。 */
    private boolean derivedSchemaDrill = false;

    /** 命令行入口。 */
    public static void main(String[] args) {
        int exitCode = EXIT_SUCCESS;
        try {
            MigrationOptions parsed = MigrationOptions.parse(args);
            new PathGuard(parsed.repoRoot).checkMigrationPaths(parsed);
            SqliteToH2Migration tool = new SqliteToH2Migration();
            MigrationManifest manifest = parsed.verifiedOnly ? tool.verify(parsed) : tool.migrate(parsed);
            System.out.println(manifest.summaryLine());
        } catch (UsageException invalid) {
            System.err.println("参数错误: " + invalid.getMessage());
            System.err.println(USAGE);
            exitCode = EXIT_INVALID_ARGUMENT;
        } catch (ForbiddenPathException forbidden) {
            System.err.println("拒绝执行（路径禁区）: " + forbidden.getMessage());
            exitCode = EXIT_FORBIDDEN_PATH;
        } catch (MigrationFailure failed) {
            System.err.println("迁移校验失败: " + failed.getMessage());
            exitCode = EXIT_VERIFICATION_FAILED;
        } catch (SQLException | IOException unexpected) {
            System.err.println("迁移工具异常终止: " + unexpected.getMessage());
            exitCode = EXIT_VERIFICATION_FAILED;
        }
        System.exit(exitCode);
    }

    // ===== 迁移主流程 =====

    /**
     * 搬运模式：新建 H2 库、灌入全部业务表、校准自增起点、复制检查点正文，并写迁移清单。
     *
     * @param options 命令行参数（源、目标、检查点、清单等）
     * @return 已经落盘的迁移清单
     * @throws SQLException 数据库层面无法恢复的错误（此时若已建库，清单仍会写出）
     * @throws IOException 检查点复制或清单写盘失败
     * @throws ForbiddenPathException 目标目录已存在且非空（设计 §附录C.3 第 3 条）
     * @throws MigrationFailure 任一侧指纹不符等数据层面失败
     */
    public MigrationManifest migrate(MigrationOptions options) throws SQLException, IOException {
        this.options = options;
        Path source = requireSourceFile(options.source);
        Path targetDirectory = options.target.toAbsolutePath().normalize();
        requireEmptyOrAbsent(targetDirectory);
        // 结构脚本先解析：缺脚本/演练开关缺失属于「参数未就绪」，必须在建任何文件之前就以退出码 2 收场。
        schemaScript = resolveSchemaScript();
        Path manifestPath = resolveManifestPath(options, targetDirectory);

        // 源库 SHA-256 在建库之前算完：一旦搬家失败，这个值仍然是最可信的源凭据。
        String sourceSha256 = sha256OfFile(source);
        Files.createDirectories(targetDirectory);
        if (derivedSchemaDrill) {
            // 标记文件在「开库之前」就落盘：即使后面搬运失败，这个目录也不会被误当成可用库。
            writeDerivedSchemaMarker(targetDirectory, source, sourceSha256);
        }
        Path checkpoints = options.checkpoints != null
                ? options.checkpoints.toAbsolutePath().normalize()
                : defaultCheckpointsDirectory(source);

        MigrationManifest manifest = new MigrationManifest(TOOL_VERSION, source, sourceSha256);
        manifest.engine = "h2";
        manifest.schemaMode = derivedSchemaDrill ? "derived" : "baseline";
        manifest.targetDatabaseFile = options.databaseName + ".mv.db";

        try (Connection sourceConnection = openSqliteReadOnly(source);
             Connection targetConnection = openH2(targetDirectory, options.databaseName, false)) {
            configureH2Session(targetConnection);
            applySchema(targetConnection, sourceConnection);
            manifest.sourceSchemaVersion = readSourceSchemaVersion(sourceConnection);
            tablePlans = buildTablePlans(sourceConnection, targetConnection);
            tableFingerprints = copyTables(sourceConnection, targetConnection);
            restartIdentities(targetConnection);
            verifyTargetRowCounts(targetConnection);
            manifest.files = copyCheckpoints(checkpoints, targetDirectory);
            verifyCheckpointReferences(sourceConnection, checkpoints);
        } catch (UsageException | ForbiddenPathException stop) {
            // 参数/路径类问题按退出码 2/3 处理，不写清单也不留半成品。
            throw stop;
        } catch (SQLException | IOException | RuntimeException unexpected) {
            // 失败也要落清单：目标目录保留，{@code failureReason} 里写明原因，便于人工定位。
            failures.add("执行中断: " + describe(unexpected));
        }

        manifest.tables = tableFingerprints;
        manifest.sourceRowCounts = rowCountMap(tableFingerprints);
        manifest.tableFingerprints = fingerprintMap(tableFingerprints);
        return finalizeManifest(manifest, manifestPath, "verified=false");
    }

    /**
     * 校验模式：对已迁移目标复算两侧指纹并比对，只读业务数据，但会刷新清单的 {@code verified}。
     *
     * @param options 命令行参数（源、目标、清单等）
     * @return 刷新后的迁移清单
     * @throws SQLException 数据库层面错误
     * @throws IOException 读文件或写清单失败
     * @throws UsageException 目标库或既有清单缺失
     * @throws MigrationFailure 复算不符
     */
    public MigrationManifest verify(MigrationOptions options) throws SQLException, IOException {
        this.options = options;
        Path source = requireSourceFile(options.source);
        Path targetDirectory = options.target.toAbsolutePath().normalize();
        if (!Files.isDirectory(targetDirectory)) {
            throw new UsageException("--verify 的目标目录不存在: " + targetDirectory);
        }
        Path databaseFile = targetDirectory.resolve(options.databaseName + ".mv.db");
        if (!Files.isRegularFile(databaseFile)) {
            throw new UsageException("--verify 要求目标目录已有 H2 库文件: " + databaseFile);
        }
        Path manifestPath = resolveManifestPath(options, targetDirectory);
        if (!Files.isRegularFile(manifestPath)) {
            throw new UsageException("--verify 要求目标目录已有迁移清单: " + manifestPath);
        }
        // 目标目录带「禁止用于生产」标记 = 演练产物：复算可以照做，但 verified 恒为 false，绝不能被刷新成 true。
        derivedSchemaDrill = Files.isRegularFile(targetDirectory.resolve(DERIVED_MARKER_FILE_NAME));
        Path checkpoints = options.checkpoints != null
                ? options.checkpoints.toAbsolutePath().normalize()
                : defaultCheckpointsDirectory(source);

        String sourceSha256 = sha256OfFile(source);
        MigrationManifest manifest = new MigrationManifest(TOOL_VERSION, source, sourceSha256);
        manifest.engine = "h2";
        manifest.schemaMode = derivedSchemaDrill ? "derived" : "baseline";
        manifest.targetDatabaseFile = options.databaseName + ".mv.db";

        try (Connection sourceConnection = openSqliteReadOnly(source);
             Connection targetConnection = openH2(targetDirectory, options.databaseName, true)) {
            configureH2Session(targetConnection);
            manifest.sourceSchemaVersion = readSourceSchemaVersion(sourceConnection);
            tablePlans = buildTablePlans(sourceConnection, targetConnection);
            // 只读比对：不插一行、不改一列，身份列起点也只读取不重置。
            tableFingerprints = compareTables(sourceConnection, targetConnection);
            manifest.files = verifyCheckpointsAreIdentical(checkpoints, targetDirectory);
            verifyCheckpointReferences(sourceConnection, checkpoints);
        } catch (UsageException | ForbiddenPathException stop) {
            throw stop;
        } catch (SQLException | IOException | RuntimeException unexpected) {
            failures.add("执行中断: " + describe(unexpected));
        }

        manifest.tables = tableFingerprints;
        manifest.sourceRowCounts = rowCountMap(tableFingerprints);
        manifest.tableFingerprints = fingerprintMap(tableFingerprints);
        return finalizeManifest(manifest, manifestPath, "复算不一致");
    }

    /**
     * 收尾：统一决定 {@code verified} 与 {@code failureReason} 并落盘清单。
     *
     * <p>为什么演练模式要在这里强制 {@code verified=false}：{@code StorageEngineGuard} 只认
     * {@code verified=true} 的清单，这是「演练产物不能被应用启动使用」唯一可靠的闸门；
     * 只要指纹都对就把 {@code verified} 放开，等于把推导结构的库放进生产。</p>
     *
     * @param manifest 清单
     * @param manifestPath 清单路径
     * @param prefix 数据层面失败时的错误前缀
     * @return 已落盘的清单
     * @throws IOException 写盘失败
     * @throws MigrationFailure 数据层面失败（指纹/行数/检查点不符，或执行中断）
     */
    private MigrationManifest finalizeManifest(MigrationManifest manifest, Path manifestPath, String prefix)
            throws IOException {
        boolean dataMatched = failures.isEmpty();
        if (derivedSchemaDrill) {
            manifest.verified = false;
            String extra = dataMatched ? "" : " | " + String.join(" | ", failures);
            manifest.failureReason = truncate(DERIVED_DRILL_REASON + extra, FAILURE_REASON_LIMIT);
        } else {
            manifest.verified = dataMatched;
            manifest.failureReason = dataMatched
                    ? null
                    : truncate(String.join(" | ", failures), FAILURE_REASON_LIMIT);
        }
        manifest.write(manifestPath);
        if (!dataMatched) {
            throw new MigrationFailure(prefix + "，原因见 " + manifestPath + " : " + manifest.failureReason);
        }
        if (derivedSchemaDrill) {
            System.out.println("WARNING: 演练模式产物——清单 verified=false，目标目录已写 "
                    + DERIVED_MARKER_FILE_NAME + "，该库不得被应用启动使用");
        }
        return manifest;
    }

    /**
     * 写「推导结构、禁止用于生产」标记文件。
     *
     * <p>为什么需要独立文件而不是只靠清单：目标目录可能被整体拷走再手改清单，
     * 但不会有人顺手删掉一个明晃晃的 txt；它同时也是给运维看的处置说明。</p>
     *
     * @param targetDirectory 目标目录
     * @param source 源库副本路径
     * @param sourceSha256 源库 SHA-256
     * @throws IOException 写文件失败
     */
    private void writeDerivedSchemaMarker(Path targetDirectory, Path source, String sourceSha256)
            throws IOException {
        List<String> lines = List.of(
                "DERIVED-SCHEMA-NOT-FOR-PRODUCTION",
                "=================================",
                "",
                "原因：本次迁移的 H2 结构是按 SQLite 源库结构「推导」出来的，不是 H2 基线 DDL。",
                "      推导会把 SQLite 的 TEXT 列变成 VARCHAR(1000000000) 而不是 CLOB（H2 2.5.252 实测），",
                "      大文本会整段驻留，等于复刻历史 OOM 事故；同时缺 schema_version / checksum 等基线对象。",
                "",
                "生成时间：" + MANIFEST_TIME.format(Instant.now()) + "（UTC）",
                "工具版本：" + TOOL_VERSION,
                "源库：" + source.toAbsolutePath().normalize(),
                "源库 SHA-256：" + sourceSha256,
                "目标库：" + options.databaseName + ".mv.db",
                "",
                "该库不得被应用启动使用。",
                "应用启动期只接受 verified=true 的 migration-from-sqlite.json，",
                "而本目录的清单在演练模式下恒为 verified=false，两者叠加确保它起不来。",
                "",
                "处置：删除整个目标目录，去掉 --derive-schema 与 --allow-derived-schema-for-drill，",
                "      改用真实 H2 基线 DDL 重新迁移（缺脚本请先补 src/main/resources/db/h2/V1__schema.sql）。",
                "");
        Path marker = targetDirectory.resolve(DERIVED_MARKER_FILE_NAME);
        Files.write(marker, String.join(System.lineSeparator(), lines).getBytes(StandardCharsets.UTF_8));
        System.out.println("marker=" + marker + "（该库不得被应用启动使用）");
    }

    /**
     * 逐表搬运：先写目标库，再用同一份 {@link CanonicalRowCodec} 算两侧指纹。
     *
     * @param source 源 SQLite 连接（只读）
     * @param target 目标 H2 连接
     * @return 每张表的行数与指纹
     */
    private List<TableFingerprint> copyTables(Connection source, Connection target) {
        insertAllRows(source, target);
        return compareTables(source, target);
    }

    /**
     * 逐表比对：行数 + 指纹必须同时相等，否则记录失败原因与首个差异位置。
     *
     * @param source 源连接
     * @param target 目标连接
     * @return 每张表的行数与指纹
     */
    private List<TableFingerprint> compareTables(Connection source, Connection target) {
        List<TableFingerprint> fingerprints = new ArrayList<>();
        for (TablePlan plan : tablePlans) {
            if (plan.columns.isEmpty()) {
                failures.add("表 " + plan.table + " 没有可比对的列");
                fingerprints.add(new TableFingerprint(plan.table, -1L, "UNKNOWN", false));
                continue;
            }
            TableDigest sourceDigest;
            TableDigest targetDigest;
            try {
                sourceDigest = fingerprintTable(source, plan);
                targetDigest = fingerprintTable(target, plan);
            } catch (SQLException readFailure) {
                failures.add("表 " + plan.table + " 指纹计算失败: " + readFailure.getMessage());
                fingerprints.add(new TableFingerprint(plan.table, -1L, "ERROR", false));
                continue;
            }
            TableFingerprint fingerprint =
                    new TableFingerprint(plan.table, sourceDigest.rows, sourceDigest.sha256, false);
            fingerprints.add(fingerprint);
            if (sourceDigest.rows != targetDigest.rows) {
                failures.add("表 " + plan.table + " 行数不一致: source=" + sourceDigest.rows
                        + " target=" + targetDigest.rows);
            } else if (!sourceDigest.sha256.equals(targetDigest.sha256)) {
                failures.add("表 " + plan.table + " 指纹不一致: source=" + sourceDigest.sha256
                        + " target=" + targetDigest.sha256 + " " + describeDifference(source, target, plan));
            }
        }
        return fingerprints;
    }

    /**
     * 校准自增起点：显式插入了 id 之后，H2 的 IDENTITY 序列仍停在 1，必须 RESTART 到 max+1。
     *
     * <p>为什么还要做探针插入：{@code ALTER ... RESTART WITH} 是否真的生效无法从元数据读到
     * （H2 2.x 的 {@code INFORMATION_SCHEMA.SEQUENCES} 不含 IDENTITY 序列）。所以在一个
     * 随后回滚的事务里真插一行，断言拿到的生成 id 正好等于 max+1，再重新 RESTART 把探针消耗的那一格还回去。</p>
     *
     * @param target 目标 H2 连接
     * @throws SQLException RESTART 语句本身失败
     */
    private void restartIdentities(Connection target) throws SQLException {
        for (TablePlan plan : tablePlans) {
            if (plan.identityColumn == null) {
                continue;
            }
            String table = plan.table;
            String column = plan.identityColumn;
            long maxId = scalarLong(target, "SELECT COALESCE(MAX(" + column + "), 0) FROM " + table);
            long next = maxId + 1;
            try (Statement statement = target.createStatement()) {
                statement.execute("ALTER TABLE " + table + " ALTER COLUMN " + column + " RESTART WITH " + next);
            }
            Long generated = probeIdentity(target, plan, next);
            if (generated != null && generated != next) {
                failures.add("表 " + table + " 自增起点未生效: 期望下次生成 " + next + "，实测 " + generated);
            }
            // 探针插入虽已回滚，但序列已经被推进；再 RESTART 一次把这一格还回去。
            // 实测 H2 2.5.252 接受「回退型」RESTART（序列 7 时 RESTART WITH 6，下一行就是 6），
            // 所以迁移后的下一个业务插入正好是 max+1，不留 id 缺口。
            try (Statement statement = target.createStatement()) {
                statement.execute("ALTER TABLE " + table + " ALTER COLUMN " + column + " RESTART WITH " + next);
            }
            for (TableFingerprint fingerprint : tableFingerprints) {
                if (fingerprint.table.equals(plan.table)) {
                    fingerprint.identityRestarted = true;
                }
            }
        }
    }

    /**
     * 自增探针：在回滚事务里插一行，只为了读回数据库生成的 id。
     *
     * @param target 目标连接
     * @param plan 表计划
     * @param expected 期望的生成值
     * @return 实际生成的 id；探针不可用时返回 {@code null}（原因已记入失败列表）
     */
    private Long probeIdentity(Connection target, TablePlan plan, long expected) {
        boolean previousAutoCommit = true;
        try {
            previousAutoCommit = target.getAutoCommit();
            target.setAutoCommit(false);
            long generated = insertProbeRow(target, plan, expected);
            target.rollback();
            return generated;
        } catch (SQLException probeFailure) {
            try {
                target.rollback();
            } catch (SQLException ignoredRollback) {
                // 回滚失败无需额外处理：探针行本来就不该留下，后续 RESTART 会覆盖序列状态。
            }
            failures.add("表 " + plan.table + " 自增探针失败: " + probeFailure.getMessage());
            return null;
        } finally {
            try {
                target.setAutoCommit(previousAutoCommit);
            } catch (SQLException ignoredRestore) {
                // 恢复自动提交失败会在后续语句上直接暴露，这里只保留原异常链。
            }
        }
    }

    /**
     * 按 executionId / snapshot_file 复制检查点正文，并逐文件核对 SHA-256。
     *
     * @param sourceDirectory 源检查点根目录（可为空表示源库没有检查点正文）
     * @param targetDirectory 目标数据目录（正文落到其 {@code checkpoints} 子目录）
     * @return 每个文件的相对路径、字节数与 SHA-256
     * @throws IOException 复制失败
     */
    private List<FileFingerprint> copyCheckpoints(Path sourceDirectory, Path targetDirectory)
            throws IOException {
        List<FileFingerprint> fingerprints = new ArrayList<>();
        if (sourceDirectory == null) {
            return fingerprints;
        }
        if (!Files.isDirectory(sourceDirectory)) {
            failures.add("检查点目录不存在: " + sourceDirectory);
            return fingerprints;
        }
        Path targetRoot = targetDirectory.resolve("checkpoints");
        List<Path> files = listFilesSorted(sourceDirectory);
        for (Path file : files) {
            String relativePath = relativePathOf(sourceDirectory, file);
            Path destination = targetRoot.resolve(relativePath.replace('/', java.io.File.separatorChar));
            Files.createDirectories(destination.getParent());
            Files.copy(file, destination, StandardCopyOption.REPLACE_EXISTING);
            String expected = sha256OfFile(file);
            String actual = sha256OfFile(destination);
            if (!expected.equals(actual)) {
                failures.add("检查点复制不一致: " + relativePath);
            }
            fingerprints.add(new FileFingerprint(relativePath, Files.size(file), expected));
        }
        return fingerprints;
    }

    /**
     * 校验模式下的检查点比对：重算源侧清单，再逐文件核对目标侧内容。
     *
     * @param sourceDirectory 源检查点根目录
     * @param targetDirectory 目标数据目录
     * @return 源侧文件指纹（与迁移清单同格式）
     * @throws IOException 读取失败
     */
    private List<FileFingerprint> verifyCheckpointsAreIdentical(Path sourceDirectory, Path targetDirectory)
            throws IOException {
        List<FileFingerprint> fingerprints = new ArrayList<>();
        if (sourceDirectory == null) {
            return fingerprints;
        }
        if (!Files.isDirectory(sourceDirectory)) {
            failures.add("检查点目录不存在: " + sourceDirectory);
            return fingerprints;
        }
        Map<String, Path> sourceFiles = new TreeMap<>();
        for (Path file : listFilesSorted(sourceDirectory)) {
            sourceFiles.put(relativePathOf(sourceDirectory, file), file);
        }
        Map<String, Path> targetFiles = new TreeMap<>();
        Path targetRoot = targetDirectory.resolve("checkpoints");
        if (Files.isDirectory(targetRoot)) {
            for (Path file : listFilesSorted(targetRoot)) {
                targetFiles.put(relativePathOf(targetRoot, file), file);
            }
        }
        for (Map.Entry<String, Path> entry : sourceFiles.entrySet()) {
            String relativePath = entry.getKey();
            Path targetFile = targetFiles.get(relativePath);
            String expected = sha256OfFile(entry.getValue());
            fingerprints.add(new FileFingerprint(relativePath, Files.size(entry.getValue()), expected));
            if (targetFile == null) {
                failures.add("目标缺少检查点正文: " + relativePath);
                continue;
            }
            if (!expected.equals(sha256OfFile(targetFile))) {
                failures.add("检查点正文 SHA-256 不一致: " + relativePath);
            }
        }
        for (String extra : targetFiles.keySet()) {
            if (!sourceFiles.containsKey(extra)) {
                failures.add("目标存在多余的检查点正文: " + extra);
            }
        }
        return fingerprints;
    }

    // ===== 内部实现 =====

    /**
     * 校验源库文件存在；不存在直接按参数错误处理（不创建任何文件）。
     *
     * @param source 源路径
     * @return 规范化后的绝对路径
     */
    private Path requireSourceFile(Path source) {
        if (source == null) {
            throw new UsageException("必须显式给出 --source");
        }
        Path absolute = source.toAbsolutePath().normalize();
        if (!Files.isRegularFile(absolute)) {
            throw new UsageException("源库副本不存在或不是文件: " + absolute);
        }
        return absolute;
    }

    /**
     * 目标目录必须不存在或为空：搬一半的旧目录绝不能被静默覆盖。
     *
     * @param target 目标目录
     */
    private void requireEmptyOrAbsent(Path target) {
        if (!Files.exists(target)) {
            return;
        }
        if (!Files.isDirectory(target)) {
            throw new ForbiddenPathException("目标必须是目录: " + target);
        }
        try (Stream<Path> children = Files.list(target)) {
            if (children.findAny().isPresent()) {
                throw new ForbiddenPathException("目标目录已存在且非空，拒绝覆盖: " + target);
            }
        } catch (IOException listingFailure) {
            throw new ForbiddenPathException("目标目录无法读取: " + target + " (" + listingFailure.getMessage() + ")");
        }
    }

    /**
     * 解析清单路径：显式优先，缺省落在目标目录里（设计 §8 第 9 条要求它在 dataDir 下）。
     *
     * @param options 参数
     * @param targetDirectory 目标数据目录
     * @return 规范化后的清单文件路径
     */
    private Path resolveManifestPath(MigrationOptions options, Path targetDirectory) {
        if (options.manifest != null) {
            return options.manifest.toAbsolutePath().normalize();
        }
        return targetDirectory.resolve(MANIFEST_FILE_NAME);
    }

    /**
     * 缺省检查点目录：与源库同级的 {@code checkpoints}（安装版数据目录就是这个布局）。
     *
     * @param source 源库副本路径
     * @return 检查点目录（可能不存在，由复制阶段报告）
     */
    private Path defaultCheckpointsDirectory(Path source) {
        Path parent = source.getParent();
        return parent == null ? null : parent.resolve("checkpoints").toAbsolutePath().normalize();
    }

    /**
     * 只读打开源库副本。
     *
     * <p>为什么先 {@code PRAGMA query_only=1}：工具只该读副本，静默写成「看起来成功、其实数据被改」
     * 的隐患，所以在连接建立后立刻把写权限关掉（设计 §7 T04 完成判据第 1 条）。</p>
     *
     * @param source 源库文件
     * @return 只读连接
     * @throws SQLException 打不开
     */
    private Connection openSqliteReadOnly(Path source) throws SQLException {
        String url = "jdbc:sqlite:" + source.toString().replace('\\', '/');
        Connection connection = DriverManager.getConnection(url);
        try (Statement statement = connection.createStatement()) {
            statement.execute("PRAGMA query_only=1");
            statement.execute("PRAGMA busy_timeout=5000");
        }
        return connection;
    }

    /**
     * 打开目标 H2 文件库。
     *
     * @param directory 目标目录
     * @param databaseName 库文件名主干
     * @param ifExists {@code true} 表示只允许打开已存在的库（校验模式，绝不新建）
     * @return H2 连接
     * @throws SQLException 打不开
     */
    private Connection openH2(Path directory, String databaseName, boolean ifExists) throws SQLException {
        String base = directory.resolve(databaseName).toString().replace('\\', '/');
        String url = "jdbc:h2:file:" + base + (ifExists ? ";IFEXISTS=TRUE" : ";IFEXISTS=FALSE");
        return DriverManager.getConnection(url, "sa", "");
    }

    /**
     * 会话级时区固定为 UTC：H2 的 {@code TIMESTAMP(3)} 存的是墙钟，默认取 JVM 时区，不设就是 8 小时偏移。
     *
     * @param target 目标连接
     * @throws SQLException 设置失败
     */
    private void configureH2Session(Connection target) throws SQLException {
        try (Statement statement = target.createStatement()) {
            statement.execute("SET TIME ZONE 'UTC'");
        }
    }

    /**
     * 建目标库结构：优先执行 T02 的 H2 基线脚本；只有在显式 {@code --derive-schema} 时才按源库结构推导。
     *
     * @param target 目标连接
     * @param source 源连接（仅在推导模式下使用）
     * @throws SQLException 脚本执行失败
     * @throws IOException 读脚本失败
     */
    private void applySchema(Connection target, Connection source) throws SQLException, IOException {
        if (schemaScript != null) {
            try (Reader reader = Files.newBufferedReader(schemaScript, StandardCharsets.UTF_8)) {
                org.h2.tools.RunScript.execute(target, reader);
            }
            System.out.println("schema=baseline file=" + schemaScript);
            return;
        }
        List<String> statements = deriveH2Ddl(source);
        try (Statement statement = target.createStatement()) {
            for (String ddl : statements) {
                statement.execute(ddl);
            }
        }
        System.out.println("schema=derived statements=" + statements.size()
                + "（演练模式：目标库缺 schema_version 等基线对象、大文本列不是 CLOB，"
                + "清单 verified 恒为 false，且已写 " + DERIVED_MARKER_FILE_NAME + "）");
    }

    /**
     * 解析 H2 基线脚本；只有「显式演练开关 + {@code --derive-schema}」才允许走推导模式。
     *
     * @return 脚本路径；{@code null} 表示走推导演练模式
     * @throws UsageException 缺脚本、参数互斥，或缺少演练硬开关
     */
    private Path resolveSchemaScript() {
        if (options.deriveSchema && options.schema != null) {
            throw new UsageException("--schema 与 --derive-schema 互斥：前者是真实基线，后者是推导演练");
        }
        if (options.deriveSchema) {
            // 双保险：即使 main 里的配对校验被绕过，这里也拒绝「单独 --derive-schema」。
            if (!options.allowDerivedSchemaForDrill) {
                throw new UsageException(DERIVE_WITHOUT_DRILL_MESSAGE);
            }
            derivedSchemaDrill = true;
            return null;
        }
        if (options.schema != null) {
            Path explicit = options.schema.toAbsolutePath().normalize();
            if (!Files.isRegularFile(explicit)) {
                throw new UsageException("指定的 H2 基线脚本不存在: " + explicit);
            }
            return explicit;
        }
        Path discovered = discoverBaselineScript(options.repoRoot);
        if (discovered != null) {
            return discovered;
        }
        throw new UsageException("找不到 H2 基线脚本（试过 src/main/resources/db/h2/V1__schema.sql 与"
                + " db/h2/V1__schema.sql），请用 --schema 显式指定；"
                + "若只是搬运演练，用 --derive-schema --allow-derived-schema-for-drill");
    }

    /**
     * 按仓库约定路径找 H2 基线脚本；两处都没有就返回 {@code null}（由调用方决定报错还是推导）。
     *
     * @param repoRoot 仓库根目录
     * @return 脚本路径或 {@code null}
     */
    private Path discoverBaselineScript(Path repoRoot) {
        if (repoRoot == null) {
            return null;
        }
        List<Path> candidates = List.of(
                repoRoot.resolve("src/main/resources/db/h2/V1__schema.sql"),
                repoRoot.resolve("db/h2/V1__schema.sql"));
        for (Path candidate : candidates) {
            if (Files.isRegularFile(candidate)) {
                return candidate;
            }
        }
        return null;
    }

    /**
     * 从源库结构推导 H2 DDL（仅演练用）。
     *
     * <p>为什么不希望用它：真正的 H2 结构由 T02 的基线脚本定义，推导版没有 checksum 版本表、
     * 没有生成列语义、没有 CHECK 约束，搬出来的库不能被应用直接使用。它存在的唯一理由是
     * 「基线脚本还没合入时也要能把搬运与指纹校验真跑一遍」。</p>
     *
     * @param source 源连接
     * @return 逐条 DDL
     * @throws SQLException 读源库结构失败
     */
    private List<String> deriveH2Ddl(Connection source) throws SQLException {
        List<String> statements = new ArrayList<>();
        for (String table : listSourceTables(source)) {
            List<SourceColumn> columns = readSourceColumns(source, table);
            if (columns.isEmpty()) {
                continue;
            }
            List<String> primaryKey = new ArrayList<>();
            for (SourceColumn column : columns) {
                if (column.primaryKeyOrder > 0) {
                    primaryKey.add(column.name);
                }
            }
            boolean autoIncrement = readSourceTableSql(source, table).toUpperCase(Locale.ROOT)
                    .contains("AUTOINCREMENT");
            boolean identity = autoIncrement && primaryKey.size() == 1;
            StringBuilder ddl = new StringBuilder("CREATE TABLE IF NOT EXISTS ").append(table).append(" (");
            for (int index = 0; index < columns.size(); index++) {
                SourceColumn column = columns.get(index);
                if (index > 0) {
                    ddl.append(", ");
                }
                boolean identityColumn = identity && column.name.equals(primaryKey.get(0));
                ddl.append(column.name).append(' ').append(h2TypeFor(table, column, identityColumn));
                if (column.notNull || identityColumn) {
                    ddl.append(" NOT NULL");
                }
            }
            if (!primaryKey.isEmpty()) {
                ddl.append(", PRIMARY KEY (").append(String.join(", ", primaryKey)).append(')');
            }
            ddl.append(')');
            statements.add(ddl.toString());
            statements.addAll(deriveIndexDdl(source, table));
        }
        return statements;
    }

    /**
     * 推导单表的索引 DDL：唯一索引语义必须保留（并发裁决全靠它）。
     *
     * @param source 源连接
     * @param table 表名
     * @return 逐条索引 DDL
     * @throws SQLException 读索引结构失败
     */
    private List<String> deriveIndexDdl(Connection source, String table) throws SQLException {
        List<String> statements = new ArrayList<>();
        String listSql = "PRAGMA index_list('" + table.replace("'", "''") + "')";
        try (Statement statement = source.createStatement();
             ResultSet indexes = statement.executeQuery(listSql)) {
            while (indexes.next()) {
                String name = indexes.getString("name");
                boolean unique = indexes.getInt("unique") == 1;
                String targetName = name;
                if (name.startsWith("sqlite_autoindex")) {
                    targetName = "uk_" + table + "_auto" + indexes.getInt("seq");
                }
                if (!targetName.matches("[A-Za-z_][A-Za-z0-9_]*")) {
                    System.out.println("跳过无法平移的索引名: " + name + " (table=" + table + ")");
                    continue;
                }
                List<String> indexedColumns = new ArrayList<>();
                String infoSql = "PRAGMA index_xinfo('" + name.replace("'", "''") + "')";
                try (Statement infoStatement = source.createStatement();
                     ResultSet info = infoStatement.executeQuery(infoSql)) {
                    while (info.next()) {
                        if (info.getInt("key") != 1) {
                            continue;
                        }
                        String columnName = info.getString("name");
                        if (columnName == null) {
                            // 表达式索引无法平移：整条索引跳过，绝不改写成等价不了的形状。
                            indexedColumns.clear();
                            break;
                        }
                        indexedColumns.add(columnName + (info.getInt("desc") == 1 ? " DESC" : ""));
                    }
                }
                if (indexedColumns.isEmpty()) {
                    System.out.println("跳过表达式索引: " + name + " (table=" + table + ")");
                    continue;
                }
                statements.add("CREATE " + (unique ? "UNIQUE " : "") + "INDEX IF NOT EXISTS " + targetName
                        + " ON " + table + " (" + String.join(", ", indexedColumns) + ")");
            }
        }
        return statements;
    }

    /**
     * 源列类型映射为 H2 列类型。
     *
     * @param table 表名
     * @param column 源列
     * @param identity 是否是自增主键
     * @return H2 列类型
     */
    private String h2TypeFor(String table, SourceColumn column, boolean identity) {
        if (identity) {
            return "BIGINT GENERATED BY DEFAULT AS IDENTITY";
        }
        String declared = column.declaredType == null ? "" : column.declaredType.toUpperCase(Locale.ROOT);
        if (CLOB_COLUMNS.contains((table + "." + column.name).toLowerCase(Locale.ROOT))
                || declared.contains("CLOB")) {
            return "CLOB";
        }
        if (declared.contains("INT")) {
            return "BIGINT";
        }
        if (declared.contains("DATETIME") || declared.contains("TIMESTAMP")) {
            return "TIMESTAMP(3)";
        }
        if (declared.startsWith("DATE")) {
            return "DATE";
        }
        if (declared.contains("NUMERIC") || declared.contains("DECIMAL")) {
            // 纯 NUMERIC 在 H2 是 DECIMAL(100000,0)：比例列会被抹成整数，所以要么给精度要么给浮点。
            if (declared.contains("(")) {
                return declared;
            }
            return "DOUBLE PRECISION";
        }
        if (declared.contains("REAL") || declared.contains("FLOA") || declared.contains("DOUB")) {
            return "DOUBLE PRECISION";
        }
        if (declared.contains("BLOB") || declared.isEmpty()) {
            return "BLOB";
        }
        return "VARCHAR(1000000)";
    }

    /**
     * 读源库版本号：取版本表最大值；没有版本表时返回 0。
     *
     * @param source 源连接
     * @return {@code sourceSchemaVersion}
     */
    private int readSourceSchemaVersion(Connection source) {
        try (Statement statement = source.createStatement();
             ResultSet rows = statement.executeQuery("SELECT COALESCE(MAX(version), 0) FROM " + VERSION_TABLE)) {
            return rows.next() ? rows.getInt(1) : 0;
        } catch (SQLException noVersionTable) {
            return 0;
        }
    }

    /**
     * 列出源库业务表（排除 {@code sqlite_*} 内部表与版本表）。
     *
     * @param source 源连接
     * @return 表名列表（按名称排序，保证执行顺序稳定）
     * @throws SQLException 查询失败
     */
    private List<String> listSourceTables(Connection source) throws SQLException {
        List<String> tables = new ArrayList<>();
        String sql = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
        try (Statement statement = source.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            while (rows.next()) {
                String name = rows.getString(1);
                if (name.equalsIgnoreCase(VERSION_TABLE)) {
                    continue;
                }
                tables.add(name);
            }
        }
        return tables;
    }

    /**
     * 读源表列（含生成列：{@code table_xinfo} 才看得到它们，生成列的值仍然可以读出来搬运）。
     *
     * @param source 源连接
     * @param table 表名
     * @return 列列表，按 cid 顺序
     * @throws SQLException 查询失败
     */
    private List<SourceColumn> readSourceColumns(Connection source, String table) throws SQLException {
        List<SourceColumn> columns = new ArrayList<>();
        String sql = "PRAGMA table_xinfo('" + table.replace("'", "''") + "')";
        try (Statement statement = source.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            while (rows.next()) {
                int hidden = rows.getInt("hidden");
                if (hidden == 1) {
                    // hidden=1 是虚拟表的隐藏列，不属于表结构。
                    continue;
                }
                columns.add(new SourceColumn(
                        rows.getString("name"),
                        rows.getString("type"),
                        rows.getInt("notnull") == 1,
                        rows.getInt("pk"),
                        hidden));
            }
        }
        return columns;
    }

    /**
     * 读源表的建表语句（用于判断 {@code AUTOINCREMENT}，PRAGMA 不暴露这个信息）。
     *
     * @param source 源连接
     * @param table 表名
     * @return 建表 SQL；查不到时返回空串
     * @throws SQLException 查询失败
     */
    private String readSourceTableSql(Connection source, String table) throws SQLException {
        String sql = "SELECT COALESCE(sql, '') FROM sqlite_master WHERE type='table' AND name=?";
        try (PreparedStatement statement = source.prepareStatement(sql)) {
            statement.setString(1, table);
            try (ResultSet rows = statement.executeQuery()) {
                return rows.next() ? rows.getString(1) : "";
            }
        }
    }

    /**
     * 读目标 H2 表结构（列类型、可空、identity、VARCHAR 长度上限），一切以目标库为准。
     *
     * @param target 目标连接
     * @return 表名（大写）→ 表元信息
     * @throws SQLException 查询失败
     */
    private SortedMap<String, TargetTable> readTargetMetadata(Connection target) throws SQLException {
        String tail = " FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA='PUBLIC'"
                + " ORDER BY TABLE_NAME, ORDINAL_POSITION";
        String withGenerated = "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, IS_IDENTITY,"
                + " IS_GENERATED, CHARACTER_MAXIMUM_LENGTH, ORDINAL_POSITION" + tail;
        String withoutGenerated = "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, IS_NULLABLE, IS_IDENTITY,"
                + " CHARACTER_MAXIMUM_LENGTH, ORDINAL_POSITION" + tail;
        try {
            return readTargetMetadata(target, withGenerated, true);
        } catch (SQLException noGeneratedColumn) {
            // 老版本 H2 没有 IS_GENERATED：退化为「没有生成列」，其余判定不变。
            return readTargetMetadata(target, withoutGenerated, false);
        }
    }

    /**
     * 读目标表结构（指定 SQL 版本）。
     *
     * @param target 目标连接
     * @param sql 元数据查询
     * @param hasGenerated 查询结果里是否包含 {@code IS_GENERATED}
     * @return 表名（大写）→ 表元信息
     * @throws SQLException 查询失败
     */
    private SortedMap<String, TargetTable> readTargetMetadata(Connection target, String sql, boolean hasGenerated)
            throws SQLException {
        SortedMap<String, TargetTable> tables = new TreeMap<>();
        try (Statement statement = target.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            while (rows.next()) {
                String tableName = rows.getString("TABLE_NAME").toUpperCase(Locale.ROOT);
                TargetTable table = tables.computeIfAbsent(tableName, key -> new TargetTable(key));
                long maxLength = rows.getLong("CHARACTER_MAXIMUM_LENGTH");
                if (rows.wasNull()) {
                    maxLength = -1L;
                }
                boolean generated = hasGenerated && "ALWAYS".equalsIgnoreCase(rows.getString("IS_GENERATED"));
                TargetColumn column = new TargetColumn(
                        rows.getString("COLUMN_NAME"),
                        rows.getString("DATA_TYPE").toUpperCase(Locale.ROOT),
                        "YES".equalsIgnoreCase(rows.getString("IS_NULLABLE")),
                        "YES".equalsIgnoreCase(rows.getString("IS_IDENTITY")),
                        generated,
                        maxLength);
                table.columns.put(column.name.toUpperCase(Locale.ROOT), column);
            }
        }
        return tables;
    }

    /**
     * 生成逐表计划：源列顺序 + 目标列类型 + 主键 + identity 列。
     *
     * @param source 源连接
     * @param target 目标连接
     * @return 表计划列表（源表顺序）
     * @throws SQLException 读结构失败
     */
    private List<TablePlan> buildTablePlans(Connection source, Connection target) throws SQLException {
        SortedMap<String, TargetTable> targetTables = readTargetMetadata(target);
        List<TablePlan> plans = new ArrayList<>();
        for (String table : listSourceTables(source)) {
            TargetTable targetTable = targetTables.get(table.toUpperCase(Locale.ROOT));
            if (targetTable == null) {
                failures.add("目标库缺少表 " + table + "（确认 H2 基线脚本已包含该表）");
                continue;
            }
            TablePlan plan = new TablePlan(table);
            for (SourceColumn column : readSourceColumns(source, table)) {
                TargetColumn targetColumn = targetTable.columns.get(column.name.toUpperCase(Locale.ROOT));
                if (targetColumn == null) {
                    failures.add("目标表 " + table + " 缺少列 " + column.name);
                    continue;
                }
                plan.columns.add(new ColumnPlan(column.name, kindOf(targetColumn), targetColumn.nullable,
                        targetColumn.generated, targetColumn.maxLength));
                if (column.primaryKeyOrder > 0) {
                    plan.primaryKey.add(column.name);
                }
                if (targetColumn.identity) {
                    plan.identityColumn = column.name;
                }
            }
            plans.add(plan);
        }
        return plans;
    }

    /**
     * 把 H2 列类型映射成规范化指纹使用的逻辑类型。
     *
     * @param column 目标列
     * @return 逻辑类型
     */
    private ColumnKind kindOf(TargetColumn column) {
        String type = column.dataType;
        if (type.contains("CLOB") || type.contains("CHARACTER LARGE OBJECT")) {
            return ColumnKind.LARGE_TEXT;
        }
        if (type.contains("BLOB") || type.contains("BINARY")) {
            return ColumnKind.BINARY;
        }
        if (type.contains("TIMESTAMP") || type.equals("DATE") || type.contains("TIME")) {
            return ColumnKind.TEMPORAL;
        }
        if (type.contains("CHAR") || type.contains("VARCHAR")) {
            return ColumnKind.TEXT;
        }
        if (type.contains("INT") || type.contains("BOOLEAN")) {
            return ColumnKind.INTEGER;
        }
        return ColumnKind.NUMBER;
    }

    /**
     * 逐表写入：显式列清单 + 主键顺序读取；含 CLOB 的行按行下发（流式，不进批也不驻留整段）。
     *
     * @param source 源连接
     * @param target 目标连接
     */
    private void insertAllRows(Connection source, Connection target) {
        for (TablePlan plan : tablePlans) {
            if (plan.columns.isEmpty()) {
                continue;
            }
            String insertSql = buildInsertSql(plan);
            String selectSql = buildSelectSql(plan, true);
            boolean streaming = plan.hasStreamingColumn();
            long copied = 0L;
            try (Statement select = source.createStatement();
                 ResultSet rows = select.executeQuery(selectSql);
                 PreparedStatement insert = target.prepareStatement(insertSql)) {
                while (rows.next()) {
                    fillInsert(insert, rows, plan);
                    if (streaming) {
                        insert.executeUpdate();
                    } else {
                        insert.addBatch();
                        if (copied % options.batchSize == options.batchSize - 1) {
                            insert.executeBatch();
                        }
                    }
                    copied++;
                }
                if (!streaming) {
                    insert.executeBatch();
                }
            } catch (SQLException writeFailure) {
                failures.add("表 " + plan.table + " 写入失败: " + writeFailure.getMessage());
                continue;
            }
            System.out.println("table=" + plan.table + " copied=" + copied);
        }
    }

    /**
     * 拼 INSERT：显式列出每一列，绝不依赖列顺序。
     *
     * <p>{@code GENERATED ALWAYS AS ...} 的派生列（如 H2 基线里的 {@code checklist.active_session_key}）
     * 由数据库自己算，写它会直接报 90154，所以只跳过写入；指纹比对仍然读它，从而顺带验证
     * 「两侧派生规则一致」。</p>
     *
     * @param plan 表计划
     * @return INSERT 语句
     */
    private String buildInsertSql(TablePlan plan) {
        List<String> names = new ArrayList<>();
        List<String> placeholders = new ArrayList<>();
        for (ColumnPlan column : plan.columns) {
            if (column.generated) {
                continue;
            }
            names.add(column.name);
            placeholders.add("?");
        }
        return "INSERT INTO " + plan.table + " (" + String.join(", ", names) + ") VALUES ("
                + String.join(", ", placeholders) + ")";
    }

    /**
     * 拼 SELECT：有主键按主键排序（两侧必须用同一顺序才能算可比的指纹）。
     *
     * @param plan 表计划
     * @param orderByPrimaryKey {@code true} 时按主键排序
     * @return SELECT 语句
     */
    private String buildSelectSql(TablePlan plan, boolean orderByPrimaryKey) {
        List<String> names = new ArrayList<>();
        for (ColumnPlan column : plan.columns) {
            names.add(column.name);
        }
        String sql = "SELECT " + String.join(", ", names) + " FROM " + plan.table;
        if (orderByPrimaryKey && !plan.primaryKey.isEmpty()) {
            sql = sql + " ORDER BY " + String.join(", ", plan.primaryKey);
        }
        return sql;
    }

    /**
     * 按目标列类型把一行源数据塞进 INSERT 参数。
     *
     * @param insert 目标语句
     * @param rows 源结果集
     * @param plan 表计划
     * @throws SQLException 读写失败（含超长校验失败）
     */
    private void fillInsert(PreparedStatement insert, ResultSet rows, TablePlan plan) throws SQLException {
        int parameter = 0;
        for (int index = 0; index < plan.columns.size(); index++) {
            ColumnPlan column = plan.columns.get(index);
            if (column.generated) {
                // 派生列不写（见 buildInsertSql 的说明）。
                continue;
            }
            parameter++;
            int sqlIndex = index + 1;
            switch (column.kind) {
                case LARGE_TEXT -> {
                    Reader reader = rows.getCharacterStream(sqlIndex);
                    if (reader == null) {
                        insert.setNull(parameter, Types.CLOB);
                    } else {
                        insert.setCharacterStream(parameter, reader);
                    }
                }
                case TEMPORAL -> {
                    Object raw = rows.getObject(sqlIndex);
                    if (raw == null) {
                        insert.setNull(parameter, Types.TIMESTAMP);
                    } else {
                        Instant instant = CanonicalRowCodec.toInstant(raw);
                        insert.setTimestamp(parameter, Timestamp.from(instant), UTC_CALENDAR);
                    }
                }
                case INTEGER -> {
                    Object raw = rows.getObject(sqlIndex);
                    if (raw == null) {
                        insert.setNull(parameter, Types.BIGINT);
                    } else {
                        insert.setLong(parameter, toLong(raw, plan.table, column.name));
                    }
                }
                case NUMBER -> {
                    Object raw = rows.getObject(sqlIndex);
                    if (raw == null) {
                        insert.setNull(parameter, Types.NUMERIC);
                    } else {
                        insert.setBigDecimal(parameter, toBigDecimal(raw, plan.table, column.name));
                    }
                }
                case BINARY -> {
                    InputStream stream = rows.getBinaryStream(sqlIndex);
                    if (stream == null) {
                        insert.setNull(parameter, Types.VARBINARY);
                    } else {
                        insert.setBinaryStream(parameter, stream);
                    }
                }
                default -> {
                    String value = rows.getString(sqlIndex);
                    if (value == null) {
                        insert.setNull(parameter, Types.VARCHAR);
                    } else {
                        checkLength(plan.table, column, value);
                        insert.setString(parameter, value);
                    }
                }
            }
        }
    }

    /**
     * 超长校验：有界列超过目标长度必须失败并报出表/列/实际长度，绝不静默截断。
     *
     * @param table 表名
     * @param column 列计划
     * @param value 值
     * @throws SQLException 超长
     */
    private void checkLength(String table, ColumnPlan column, String value) throws SQLException {
        if (column.maxLength > 0 && value.length() > column.maxLength) {
            throw new SQLException("列超长: table=" + table + " column=" + column.name
                    + " length=" + value.length() + " limit=" + column.maxLength);
        }
    }

    /**
     * 插入一行自增探针（只填 NOT NULL 列），并读回数据库生成的 id。
     *
     * @param target 目标连接
     * @param plan 表计划
     * @param expected 期望值（仅用于错误信息）
     * @return 生成的 id
     * @throws SQLException 插入失败或未返回生成键
     */
    private long insertProbeRow(Connection target, TablePlan plan, long expected) throws SQLException {
        List<ColumnPlan> required = new ArrayList<>();
        for (ColumnPlan column : plan.columns) {
            if (column.generated) {
                continue;
            }
            if (plan.identityColumn.equalsIgnoreCase(column.name)) {
                continue;
            }
            if (!column.nullable) {
                required.add(column);
            }
        }
        String sql;
        if (required.isEmpty()) {
            sql = "INSERT INTO " + plan.table + " (" + plan.identityColumn + ") VALUES (DEFAULT)";
        } else {
            List<String> names = new ArrayList<>();
            List<String> placeholders = new ArrayList<>();
            for (ColumnPlan column : required) {
                names.add(column.name);
                placeholders.add("?");
            }
            sql = "INSERT INTO " + plan.table + " (" + String.join(", ", names) + ") VALUES ("
                    + String.join(", ", placeholders) + ")";
        }
        try (PreparedStatement insert = target.prepareStatement(sql, Statement.RETURN_GENERATED_KEYS)) {
            int parameter = 1;
            for (ColumnPlan column : required) {
                setProbeValue(insert, parameter++, column);
            }
            insert.executeUpdate();
            try (ResultSet keys = insert.getGeneratedKeys()) {
                if (keys.next()) {
                    return keys.getLong(1);
                }
            }
        }
        throw new SQLException("自增探针未返回生成键（expected=" + expected + "）");
    }

    /**
     * 探针行的占位值：类型合法且带随机后缀，避免撞上唯一索引。
     *
     * @param insert 语句
     * @param parameter 参数下标
     * @param column 列计划
     * @throws SQLException 设置失败
     */
    private void setProbeValue(PreparedStatement insert, int parameter, ColumnPlan column) throws SQLException {
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        switch (column.kind) {
            case LARGE_TEXT -> insert.setString(parameter, "identity-probe-" + suffix);
            case TEMPORAL -> insert.setTimestamp(parameter, Timestamp.from(Instant.EPOCH), UTC_CALENDAR);
            case INTEGER -> insert.setLong(parameter, 0L);
            case NUMBER -> insert.setBigDecimal(parameter, BigDecimal.ZERO);
            case BINARY -> insert.setBytes(parameter, new byte[] {0});
            default -> insert.setString(parameter, "identity-probe-" + suffix);
        }
    }

    /**
     * 复核目标行数：自增探针全部回滚之后，行数必须仍然和源侧一致。
     *
     * @param target 目标连接
     */
    private void verifyTargetRowCounts(Connection target) {
        for (TableFingerprint fingerprint : tableFingerprints) {
            if (fingerprint.rows < 0) {
                continue;
            }
            long actual;
            try {
                actual = scalarLong(target, "SELECT COUNT(*) FROM " + fingerprint.table);
            } catch (SQLException countFailure) {
                failures.add("表 " + fingerprint.table + " 行数复核失败: " + countFailure.getMessage());
                continue;
            }
            if (actual != fingerprint.rows) {
                failures.add("表 " + fingerprint.table + " 复核行数不一致: source=" + fingerprint.rows
                        + " target=" + actual);
            }
        }
    }

    /**
     * 检查点正文引用校验：库里的 {@code execution.snapshot_file} 必须在 {@code checkpoints/<executionId>/} 下有正文。
     *
     * @param source 源连接（只读）
     * @param checkpoints 源检查点根目录
     */
    private void verifyCheckpointReferences(Connection source, Path checkpoints) {
        List<String> references = new ArrayList<>();
        String sql = "SELECT id, snapshot_file FROM execution WHERE snapshot_file IS NOT NULL AND snapshot_file <> ''";
        try (Statement statement = source.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            while (rows.next()) {
                // 与正文存储一致：库里保存标识，磁盘文件名还要追加 .json。
                references.add(rows.getLong("id") + "/" + rows.getString("snapshot_file") + ".json");
            }
        } catch (SQLException noExecutionTable) {
            return;
        }
        if (references.isEmpty()) {
            return;
        }
        if (checkpoints == null || !Files.isDirectory(checkpoints)) {
            failures.add("库里有 " + references.size() + " 条检查点引用，但检查点目录不存在: " + checkpoints);
            return;
        }
        for (String reference : references) {
            Path file = checkpoints.resolve(reference.replace('/', java.io.File.separatorChar)).normalize();
            if (!file.startsWith(checkpoints.toAbsolutePath().normalize()) || !Files.isRegularFile(file)) {
                failures.add("检查点正文缺失: " + reference);
            }
        }
    }

    // ===== 指纹、差异定位与通用工具 =====

    /**
     * 算单表指纹：{@code SHA-256("rows=<n>|" + 逐行规范化串流式摘要)}。
     *
     * <p>行按主键排序后逐行喂进摘要，避免把整表读进内存；无主键表退化为「规范化串排序后摘要」，
     * 排序需要缓冲，这类表在真实库里不存在，属于兜底路径。</p>
     *
     * @param connection 连接（源或目标）
     * @param plan 表计划
     * @return 行数与指纹
     * @throws SQLException 读取失败
     */
    private TableDigest fingerprintTable(Connection connection, TablePlan plan) throws SQLException {
        CanonicalRowCodec codec = new CanonicalRowCodec(plan.kinds());
        MessageDigest rowDigest = newSha256();
        long rows = 0L;
        if (plan.primaryKey.isEmpty()) {
            List<String> rendered = new ArrayList<>();
            try (Statement statement = connection.createStatement();
                 ResultSet resultSet = statement.executeQuery(buildSelectSql(plan, false))) {
                while (resultSet.next()) {
                    rendered.add(codec.render(resultSet, plan.columns.size()));
                }
            }
            rendered.sort(Comparator.naturalOrder());
            for (String line : rendered) {
                rowDigest.update(line.getBytes(StandardCharsets.UTF_8));
                rowDigest.update((byte) '\n');
                rows++;
            }
        } else {
            try (Statement statement = connection.createStatement();
                 ResultSet resultSet = statement.executeQuery(buildSelectSql(plan, true))) {
                while (resultSet.next()) {
                    rowDigest.update(codec.render(resultSet, plan.columns.size()).getBytes(StandardCharsets.UTF_8));
                    rowDigest.update((byte) '\n');
                    rows++;
                }
            }
        }
        MessageDigest finalDigest = newSha256();
        finalDigest.update(("rows=" + rows + "|").getBytes(StandardCharsets.UTF_8));
        finalDigest.update(rowDigest.digest());
        return new TableDigest(rows, hex(finalDigest.digest()));
    }

    /**
     * 定位首个差异：给失败清单写出可操作的信息（表、主键、列、两侧预览）。
     *
     * @param source 源连接
     * @param target 目标连接
     * @param plan 表计划
     * @return 差异描述（无法定位时返回说明文字）
     */
    private String describeDifference(Connection source, Connection target, TablePlan plan) {
        if (plan.primaryKey.isEmpty()) {
            return "（无主键表，按行集合比较）";
        }
        CanonicalRowCodec codec = new CanonicalRowCodec(plan.kinds());
        try (Statement sourceStatement = source.createStatement();
             ResultSet sourceRows = sourceStatement.executeQuery(buildSelectSql(plan, true));
             Statement targetStatement = target.createStatement();
             ResultSet targetRows = targetStatement.executeQuery(buildSelectSql(plan, true))) {
            long index = 0L;
            while (sourceRows.next() && targetRows.next()) {
                index++;
                List<String> sourceFields = codec.renderFields(sourceRows, plan.columns.size());
                List<String> targetFields = codec.renderFields(targetRows, plan.columns.size());
                for (int columnIndex = 0; columnIndex < sourceFields.size(); columnIndex++) {
                    if (!sourceFields.get(columnIndex).equals(targetFields.get(columnIndex))) {
                        ColumnPlan column = plan.columns.get(columnIndex);
                        return "首个差异: 行#" + index + " pk=" + primaryKeyOf(sourceRows, plan)
                                + " column=" + column.name
                                + " source=" + preview(sourceFields.get(columnIndex))
                                + " target=" + preview(targetFields.get(columnIndex));
                    }
                }
            }
            return "行数在逐行比对时提前结束（行#" + index + "）";
        } catch (SQLException differenceFailure) {
            return "（差异定位失败: " + differenceFailure.getMessage() + "）";
        }
    }

    /**
     * 读主键值用于差异描述。
     *
     * @param rows 结果集（当前行）
     * @param plan 表计划
     * @return 形如 {@code id=42} 的文本
     */
    private String primaryKeyOf(ResultSet rows, TablePlan plan) {
        List<String> parts = new ArrayList<>();
        for (String key : plan.primaryKey) {
            for (int index = 0; index < plan.columns.size(); index++) {
                if (plan.columns.get(index).name.equalsIgnoreCase(key)) {
                    try {
                        parts.add(key + "=" + rows.getString(index + 1));
                    } catch (SQLException readFailure) {
                        parts.add(key + "=?");
                    }
                    break;
                }
            }
        }
        return String.join(",", parts);
    }

    /**
     * 单列值预览：截断成一行，便于放进 {@code failureReason}。
     *
     * @param value 规范化后的值
     * @return 预览文本
     */
    private String preview(String value) {
        if (value == null) {
            return "null";
        }
        String single = value.replace('\n', ' ').replace('\r', ' ');
        return single.length() <= PREVIEW_LIMIT ? single : single.substring(0, PREVIEW_LIMIT) + "…";
    }

    /**
     * 读单值 long。
     *
     * @param connection 连接
     * @param sql 查询（返回单行单列数值）
     * @return 数值（NULL 视作 0）
     * @throws SQLException 查询失败
     */
    private long scalarLong(Connection connection, String sql) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            return rows.next() ? rows.getLong(1) : 0L;
        }
    }

    /**
     * 把源值规约成 long（兼容 SQLite 的 Integer/Long/Double/文本数字）。
     *
     * @param raw 源值
     * @param table 表名（报错用）
     * @param column 列名（报错用）
     * @return 长整数值
     */
    private long toLong(Object raw, String table, String column) {
        if (raw instanceof Number number) {
            return number.longValue();
        }
        if (raw instanceof Boolean flag) {
            return flag ? 1L : 0L;
        }
        BigDecimal decimal = toBigDecimal(raw, table, column);
        return decimal.longValue();
    }

    /**
     * 把源值规约成 BigDecimal（兼容文本与浮点）。
     *
     * @param raw 源值
     * @param table 表名（报错用）
     * @param column 列名（报错用）
     * @return 十进制值
     */
    private BigDecimal toBigDecimal(Object raw, String table, String column) {
        String text = String.valueOf(raw).trim();
        try {
            return new BigDecimal(text);
        } catch (NumberFormatException invalid) {
            throw new IllegalArgumentException("列值不是合法数字: table=" + table + " column=" + column
                    + " value=" + preview(text));
        }
    }

    // ===== 文件、摘要与清单工具 =====

    /**
     * 列出目录下所有普通文件（按相对路径排序，保证清单顺序稳定）。
     *
     * @param root 根目录
     * @return 文件列表
     * @throws IOException 遍历失败
     */
    private List<Path> listFilesSorted(Path root) throws IOException {
        try (Stream<Path> walk = Files.walk(root)) {
            return walk.filter(Files::isRegularFile).sorted().toList();
        }
    }

    /**
     * 取相对路径并统一成正斜杠（清单跨平台可比）。
     *
     * @param root 根目录
     * @param file 文件
     * @return 正斜杠形式的相对路径
     */
    private String relativePathOf(Path root, Path file) {
        return root.relativize(file).toString().replace('\\', '/');
    }

    /**
     * 计算文件 SHA-256（大写十六进制，与既有脚本口径一致）。
     *
     * @param file 文件
     * @return 摘要
     * @throws IOException 读取失败
     */
    private String sha256OfFile(Path file) throws IOException {
        MessageDigest digest = newSha256();
        try (InputStream stream = Files.newInputStream(file)) {
            byte[] buffer = new byte[65536];
            int read = stream.read(buffer);
            while (read > 0) {
                digest.update(buffer, 0, read);
                read = stream.read(buffer);
            }
        }
        return hex(digest.digest());
    }

    /**
     * 取行数映射（清单字段 {@code sourceRowCounts}）。
     *
     * @param fingerprints 表指纹
     * @return 表名 → 行数
     */
    private Map<String, Long> rowCountMap(List<TableFingerprint> fingerprints) {
        Map<String, Long> counts = new LinkedHashMap<>();
        for (TableFingerprint fingerprint : fingerprints) {
            counts.put(fingerprint.table, Math.max(fingerprint.rows, 0L));
        }
        return counts;
    }

    /**
     * 取指纹映射（清单字段 {@code tableFingerprints}）。
     *
     * @param fingerprints 表指纹
     * @return 表名 → 指纹
     */
    private Map<String, String> fingerprintMap(List<TableFingerprint> fingerprints) {
        Map<String, String> fingerprintsByTable = new LinkedHashMap<>();
        for (TableFingerprint fingerprint : fingerprints) {
            fingerprintsByTable.put(fingerprint.table, fingerprint.sha256);
        }
        return fingerprintsByTable;
    }

    /**
     * 新建 SHA-256 摘要器。
     *
     * @return 摘要器
     */
    private static MessageDigest newSha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("JVM 缺少 SHA-256", impossible);
        }
    }

    /**
     * 字节数组转大写十六进制。
     *
     * @param bytes 字节
     * @return 十六进制串
     */
    private static String hex(byte[] bytes) {
        return HexFormat.of().withUpperCase().formatHex(bytes);
    }

    /**
     * 按上限截断文本。
     *
     * @param value 文本（可空）
     * @param limit 上限
     * @return 截断后的文本（可空）
     */
    private static String truncate(String value, int limit) {
        if (value == null || value.length() <= limit) {
            return value;
        }
        return value.substring(0, limit) + "…(截断)";
    }

    /**
     * 把异常压成一行可读原因。
     *
     * @param failure 异常
     * @return 一行描述
     */
    private static String describe(Throwable failure) {
        String message = failure.getMessage();
        return failure.getClass().getSimpleName() + (message == null ? "" : ": " + message.replace('\n', ' '));
    }

    // ===== 内嵌类型 =====

    /** 参数或前置状态非法（退出码 2）。 */
    private static final class UsageException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        UsageException(String message) {
            super(message);
        }
    }

    /** 命中路径禁区（退出码 3）。 */
    private static final class ForbiddenPathException extends RuntimeException {
        private static final long serialVersionUID = 1L;

        ForbiddenPathException(String message) {
            super(message);
        }
    }

    /** 迁移或校验在数据层面失败（退出码 1，清单已落盘）。 */
    private static final class MigrationFailure extends RuntimeException {
        private static final long serialVersionUID = 1L;

        MigrationFailure(String message) {
            super(message);
        }
    }

    /** 规范化指纹使用的列逻辑类型；两侧共用同一判定，避免「各自格式化导致永远不等」。 */
    public enum ColumnKind {
        /** BIGINT/INTEGER/BOOLEAN 等整数列。 */
        INTEGER,
        /** NUMERIC/DECIMAL/DOUBLE 等小数或高精度列。 */
        NUMBER,
        /** VARCHAR 等有界文本列。 */
        TEXT,
        /** CLOB 大文本列：按「字符数 + 全文 SHA-256」比对。 */
        LARGE_TEXT,
        /** TIMESTAMP/DATE 时间列：按 UTC 毫秒文本比对。 */
        TEMPORAL,
        /** BLOB 二进制列。 */
        BINARY
    }

    /** 目标列在搬运/比对时的计划信息。 */
    private static final class ColumnPlan {
        private final String name;
        private final ColumnKind kind;
        private final boolean nullable;
        private final boolean generated;
        private final long maxLength;

        ColumnPlan(String name, ColumnKind kind, boolean nullable, boolean generated, long maxLength) {
            this.name = name;
            this.kind = kind;
            this.nullable = nullable;
            this.generated = generated;
            this.maxLength = maxLength;
        }
    }

    /** 单表搬运计划。 */
    private static final class TablePlan {
        private final String table;
        private final List<ColumnPlan> columns = new ArrayList<>();
        private final List<String> primaryKey = new ArrayList<>();
        private String identityColumn = null;

        TablePlan(String table) {
            this.table = table;
        }

        /** 行内是否有 CLOB/BLOB 列：有就不能进批处理（流对象只能被消费一次）。 */
        boolean hasStreamingColumn() {
            for (ColumnPlan column : columns) {
                if (column.kind == ColumnKind.LARGE_TEXT || column.kind == ColumnKind.BINARY) {
                    return true;
                }
            }
            return false;
        }

        /** 供 {@link CanonicalRowCodec} 使用的列逻辑类型列表。 */
        List<ColumnKind> kinds() {
            List<ColumnKind> kinds = new ArrayList<>(columns.size());
            for (ColumnPlan column : columns) {
                kinds.add(column.kind);
            }
            return kinds;
        }
    }

    /** 源库列信息（来自 {@code PRAGMA table_xinfo}）。 */
    private static final class SourceColumn {
        private final String name;
        private final String declaredType;
        private final boolean notNull;
        private final int primaryKeyOrder;
        private final int hidden;

        SourceColumn(String name, String declaredType, boolean notNull, int primaryKeyOrder, int hidden) {
            this.name = name;
            this.declaredType = declaredType;
            this.notNull = notNull;
            this.primaryKeyOrder = primaryKeyOrder;
            this.hidden = hidden;
        }
    }

    /** 目标 H2 列元信息（来自 {@code INFORMATION_SCHEMA.COLUMNS}）。 */
    private static final class TargetColumn {
        private final String name;
        private final String dataType;
        private final boolean nullable;
        private final boolean identity;
        private final boolean generated;
        private final long maxLength;

        TargetColumn(String name, String dataType, boolean nullable, boolean identity, boolean generated,
                     long maxLength) {
            this.name = name;
            this.dataType = dataType;
            this.nullable = nullable;
            this.identity = identity;
            this.generated = generated;
            this.maxLength = maxLength;
        }
    }

    /** 目标 H2 表元信息。 */
    private static final class TargetTable {
        private final String name;
        private final Map<String, TargetColumn> columns = new LinkedHashMap<>();

        TargetTable(String name) {
            this.name = name;
        }
    }

    /** 单表指纹计算结果。 */
    private static final class TableDigest {
        private final long rows;
        private final String sha256;

        TableDigest(long rows, String sha256) {
            this.rows = rows;
            this.sha256 = sha256;
        }
    }

    /**
     * 路径禁区守卫：真实数据目录（安装版与本地开发）一律拒绝，且判定基于规范化绝对路径的前后缀关系。
     *
     * <p>为什么要连父目录一起拒：把 {@code --target} 指到 {@code ~/.lingxi} 会在真实数据目录的隔壁
     * 建库，一旦后续有人把目录参数写错就会写进真实数据；宁可多拒一层。</p>
     */
    private static final class PathGuard {

        private final List<Path> banned = new ArrayList<>();

        PathGuard(Path repoRoot) {
            String userHome = System.getProperty("user.home");
            if (userHome != null && !userHome.isBlank()) {
                banned.add(Path.of(userHome, ".lingxi", "data").toAbsolutePath().normalize());
            }
            if (repoRoot != null) {
                banned.add(repoRoot.toAbsolutePath().normalize().resolve(".lingxi").resolve("development")
                        .resolve("data"));
            }
        }

        /**
         * 校验所有参与读写的路径。
         *
         * @param options 参数
         */
        void checkMigrationPaths(MigrationOptions options) {
            check("--source", options.source);
            check("--target", options.target);
            check("--checkpoints", options.checkpoints);
            check("--manifest", options.manifest);
            check("--schema", options.schema);
        }

        /**
         * 单路径判定。
         *
         * @param flag 参数名
         * @param path 路径（可空）
         */
        private void check(String flag, Path path) {
            if (path == null) {
                return;
            }
            Path candidate = path.toAbsolutePath().normalize();
            for (Path forbidden : banned) {
                boolean inside = candidate.startsWith(forbidden);
                boolean ancestorOfForbidden = forbidden.startsWith(candidate)
                        && candidate.getNameCount() > 1;
                if (inside || ancestorOfForbidden) {
                    throw new ForbiddenPathException(flag + "=" + candidate + " 命中禁区 " + forbidden
                            + "（该目录及其父/子目录一律拒绝执行）");
                }
            }
        }
    }

    /** 命令行参数。 */
    public static final class MigrationOptions {
        /** 源 SQLite 副本；必填，绝不自动挑选。 */
        public Path source = null;
        /** 目标数据目录；迁移时必须不存在或为空。 */
        public Path target = null;
        /** 检查点正文目录；缺省为源库同级的 {@code checkpoints}。 */
        public Path checkpoints = null;
        /** 清单路径；缺省为 {@code <target>/migration-from-sqlite.json}。 */
        public Path manifest = null;
        /** 批大小。 */
        public int batchSize = DEFAULT_BATCH_SIZE;
        /** {@code true} 表示只校验不写业务数据（{@code --verify}）。 */
        public boolean verifiedOnly = false;
        /** H2 基线 DDL 脚本；缺省按仓库约定路径查找。 */
        public Path schema = null;
        /** 是否按源库结构推导 H2 DDL；必须与 {@link #allowDerivedSchemaForDrill} 同时为真。 */
        public boolean deriveSchema = false;
        /** 演练硬开关：显式承认「本次产物不用于生产」，缺省即拒绝推导。 */
        public boolean allowDerivedSchemaForDrill = false;
        /** H2 库文件名主干。 */
        public String databaseName = DEFAULT_DATABASE_NAME;
        /** 仓库根目录，用于数据目录禁区判定。 */
        public Path repoRoot = null;

        /**
         * 解析命令行参数。
         *
         * @param args 命令行
         * @return 参数对象
         * @throws UsageException 缺参数、未知参数或取值非法
         */
        static MigrationOptions parse(String[] args) {
            MigrationOptions options = new MigrationOptions();
            if (args == null || args.length == 0) {
                throw new UsageException("没有参数");
            }
            for (int index = 0; index < args.length; index++) {
                String argument = args[index];
                switch (argument) {
                    case "--source" -> options.source = Path.of(requireValue(args, ++index, argument));
                    case "--target" -> options.target = Path.of(requireValue(args, ++index, argument));
                    case "--checkpoints" -> options.checkpoints = Path.of(requireValue(args, ++index, argument));
                    case "--manifest" -> options.manifest = Path.of(requireValue(args, ++index, argument));
                    case "--batch" -> options.batchSize = parseInt(requireValue(args, ++index, argument));
                    case "--schema" -> options.schema = Path.of(requireValue(args, ++index, argument));
                    case "--database-name" -> options.databaseName = requireValue(args, ++index, argument);
                    case "--repo-root" -> options.repoRoot = Path.of(requireValue(args, ++index, argument));
                    case "--derive-schema" -> options.deriveSchema = true;
                    case "--allow-derived-schema-for-drill" -> options.allowDerivedSchemaForDrill = true;
                    case "--verify" -> options.verifiedOnly = true;
                    default -> throw new UsageException("未知参数: " + argument);
                }
            }
            if (options.source == null) {
                throw new UsageException("必须显式给出 --source（禁止自动挑选源目录）");
            }
            if (options.target == null) {
                throw new UsageException("必须显式给出 --target");
            }
            // 硬开关配对校验：单独 --derive-schema 一律当参数错误，理由写在消息里（不是提示，是拒绝）。
            if (options.deriveSchema && !options.allowDerivedSchemaForDrill) {
                throw new UsageException(DERIVE_WITHOUT_DRILL_MESSAGE);
            }
            if (options.allowDerivedSchemaForDrill && !options.deriveSchema) {
                throw new UsageException("--allow-derived-schema-for-drill 必须与 --derive-schema 同时使用："
                        + "它只是演练确认开关，本身不产生任何默认行为（正常迁移请用真实 H2 基线 DDL）");
            }
            if (options.batchSize <= 0) {
                throw new UsageException("--batch 必须大于 0: " + options.batchSize);
            }
            if (!options.databaseName.matches("[A-Za-z0-9_.-]+")) {
                throw new UsageException("--database-name 只允许字母数字与 _ . -: " + options.databaseName);
            }
            if (options.repoRoot == null) {
                options.repoRoot = defaultRepoRoot();
            }
            if (options.repoRoot == null) {
                throw new UsageException("无法定位仓库根目录（向上找不到 pom.xml），请显式给出 --repo-root");
            }
            return options;
        }

        /** 从当前工作目录向上找 {@code pom.xml}：确定性推导，不看任何用户数据目录。 */
        private static Path defaultRepoRoot() {
            Path directory = Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize();
            while (directory != null) {
                if (Files.isRegularFile(directory.resolve("pom.xml"))) {
                    return directory;
                }
                directory = directory.getParent();
            }
            return null;
        }

        private static String requireValue(String[] args, int index, String name) {
            if (index >= args.length) {
                throw new UsageException(name + " 缺少取值");
            }
            return args[index];
        }

        private static int parseInt(String text) {
            try {
                return Integer.parseInt(text.trim());
            } catch (NumberFormatException invalid) {
                throw new UsageException("--batch 不是整数: " + text);
            }
        }
    }

    /** 迁移清单：设计与 {@code StorageEngineGuard} 约定的唯一凭据，字段固定，不可手工伪造。 */
    public static final class MigrationManifest {
        /** 工具版本。 */
        public String toolVersion;
        /** 生成时间（ISO-8601 UTC）。 */
        public Instant generatedAt = Instant.now();
        /** 源库副本路径（仅供人读）。 */
        public Path sourcePath;
        /** 源库文件 SHA-256（大写十六进制）。 */
        public String sourceSha256;
        /** 源库版本表最大值。 */
        public int sourceSchemaVersion = 0;
        /** 目标库引擎标识（清单 JSON 不落这个字段，只作内存语义）。 */
        public String engine = "h2";
        /** 结构来源：{@code baseline} 或 {@code derived}（清单 JSON 不落这个字段，演练与否看 verified 与标记文件）。 */
        public String schemaMode = "baseline";
        /** 逐表行数。 */
        public Map<String, Long> sourceRowCounts = new LinkedHashMap<>();
        /** 逐表指纹。 */
        public Map<String, String> tableFingerprints = new LinkedHashMap<>();
        /** 逐表结构（行数、指纹、自增是否已校准）。 */
        public List<TableFingerprint> tables = new ArrayList<>();
        /** 检查点正文文件指纹。 */
        public List<FileFingerprint> files = new ArrayList<>();
        /** 目标库文件名。 */
        public String targetDatabaseFile = DEFAULT_DATABASE_NAME + ".mv.db";
        /** 是否全量校验通过。 */
        public boolean verified = false;
        /** 失败原因（{@code verified=true} 时必须为 {@code null}）。 */
        public String failureReason = null;

        MigrationManifest(String toolVersion, Path sourcePath, String sourceSha256) {
            this.toolVersion = toolVersion;
            this.sourcePath = sourcePath;
            this.sourceSha256 = sourceSha256;
        }

        /**
         * 写清单（UTF-8 无 BOM，字段顺序与设计 §附录C.6 一致）。
         *
         * @param path 清单路径
         * @throws IOException 写盘失败
         */
        public void write(Path path) throws IOException {
            Path parent = path.toAbsolutePath().normalize().getParent();
            if (parent != null) {
                Files.createDirectories(parent);
            }
            StringBuilder json = new StringBuilder();
            json.append("{\n");
            json.append("  \"toolVersion\": ").append(jsonString(toolVersion)).append(",\n");
            json.append("  \"generatedAt\": ").append(jsonString(MANIFEST_TIME.format(generatedAt))).append(",\n");
            json.append("  \"sourcePath\": ")
                    .append(jsonString(sourcePath == null ? null : sourcePath.toAbsolutePath().normalize().toString()))
                    .append(",\n");
            json.append("  \"sourceSha256\": ").append(jsonString(sourceSha256)).append(",\n");
            json.append("  \"sourceSchemaVersion\": ").append(sourceSchemaVersion).append(",\n");
            json.append("  \"sourceRowCounts\": ").append(jsonObject(sourceRowCounts)).append(",\n");
            json.append("  \"tableFingerprints\": ").append(jsonObject(tableFingerprints)).append(",\n");
            json.append("  \"fileFingerprints\": [");
            for (int index = 0; index < files.size(); index++) {
                FileFingerprint file = files.get(index);
                json.append(index == 0 ? "\n" : ",\n");
                json.append("    { \"relativePath\": ").append(jsonString(file.relativePath))
                        .append(", \"bytes\": ").append(file.bytes)
                        .append(", \"sha256\": ").append(jsonString(file.sha256)).append(" }");
            }
            json.append(files.isEmpty() ? "],\n" : "\n  ],\n");
            json.append("  \"targetDatabaseFile\": ").append(jsonString(targetDatabaseFile)).append(",\n");
            json.append("  \"verified\": ").append(verified).append(",\n");
            json.append("  \"failureReason\": ").append(jsonString(failureReason)).append("\n");
            json.append("}\n");
            Files.writeString(path, json.toString(), StandardCharsets.UTF_8);
            this.writtenTo = path.toAbsolutePath().normalize();
        }

        /** 清单最近一次落盘位置（仅用于摘要输出）。 */
        private Path writtenTo = null;

        /**
         * 一行摘要，便于脚本与日志抓取。
         *
         * @return 摘要文本
         */
        public String summaryLine() {
            return "verified=" + verified
                    + " schemaMode=" + schemaMode
                    + " tables=" + tables.size()
                    + " rows=" + sourceRowCounts.values().stream().mapToLong(Long::longValue).sum()
                    + " files=" + files.size()
                    + " identityRestarted=" + tables.stream().filter(t -> t.identityRestarted).count()
                    + " sourceSchemaVersion=" + sourceSchemaVersion
                    + " sourceSha256=" + sourceSha256
                    + " target=" + targetDatabaseFile
                    + (writtenTo == null ? "" : " manifest=" + writtenTo)
                    + (failureReason == null ? "" : " failureReason=" + failureReason);
        }
    }

    /** 单表指纹条目。 */
    public static final class TableFingerprint {
        /** 表名。 */
        public final String table;
        /** 源侧行数（-1 表示未取到）。 */
        public final long rows;
        /** 规范化指纹。 */
        public final String sha256;
        /** 是否已把自增起点校准到 max+1。 */
        public boolean identityRestarted;

        TableFingerprint(String table, long rows, String sha256, boolean identityRestarted) {
            this.table = table;
            this.rows = rows;
            this.sha256 = sha256;
            this.identityRestarted = identityRestarted;
        }
    }

    /** 检查点正文文件指纹条目。 */
    public static final class FileFingerprint {
        /** 相对 {@code checkpoints/} 的路径（正斜杠）。 */
        public final String relativePath;
        /** 字节数。 */
        public final long bytes;
        /** 文件 SHA-256。 */
        public final String sha256;

        FileFingerprint(String relativePath, long bytes, String sha256) {
            this.relativePath = relativePath;
            this.bytes = bytes;
            this.sha256 = sha256;
        }
    }

    /**
     * 规范化行编码器：同一行数据在 SQLite 与 H2 上必须渲染成完全相同的字符串。
     *
     * <p>规则（设计 §附录C.5）：{@code NULL → "\0"}；{@code TIMESTAMP → UTC yyyy-MM-dd HH:mm:ss.SSS}；
     * {@code CLOB → 字符数:全文 SHA-256}；其余 → 文本；字段之间用 {@code \u001F} 分隔，值里的
     * 反斜杠与控制字符做转义，保证「拼接有歧义」不会变成「假绿」。</p>
     */
    public static final class CanonicalRowCodec {

        private static final char FIELD_SEPARATOR = '\u001F';
        private static final String NULL_SENTINEL = "\u0000";

        private final List<ColumnKind> kinds;

        /**
         * @param kinds 每一列的逻辑类型（顺序与 SELECT 列一致）
         */
        public CanonicalRowCodec(List<ColumnKind> kinds) {
            this.kinds = List.copyOf(kinds);
        }

        /**
         * 渲染整行。
         *
         * @param rows 结果集（当前行）
         * @param columnCount 列数
         * @return 规范化行文本
         * @throws SQLException 读取失败
         */
        public String render(ResultSet rows, int columnCount) throws SQLException {
            return String.join(String.valueOf(FIELD_SEPARATOR), renderFields(rows, columnCount));
        }

        /**
         * 渲染每一列（差异定位需要逐列比较）。
         *
         * @param rows 结果集（当前行）
         * @param columnCount 列数
         * @return 各列规范化文本
         * @throws SQLException 读取失败
         */
        public List<String> renderFields(ResultSet rows, int columnCount) throws SQLException {
            if (columnCount != kinds.size()) {
                throw new IllegalArgumentException("列数与类型表不一致: columnCount=" + columnCount
                        + " kinds=" + kinds.size());
            }
            List<String> fields = new ArrayList<>(columnCount);
            for (int index = 0; index < columnCount; index++) {
                fields.add(renderField(rows, index + 1, kinds.get(index)));
            }
            return fields;
        }

        private static String renderField(ResultSet rows, int index, ColumnKind kind) throws SQLException {
            switch (kind) {
                case LARGE_TEXT -> {
                    Reader reader = rows.getCharacterStream(index);
                    if (reader == null) {
                        return NULL_SENTINEL;
                    }
                    try (Reader closing = reader) {
                        return digestReader(closing);
                    } catch (IOException ioFailure) {
                        throw new UncheckedIOException(ioFailure);
                    }
                }
                case BINARY -> {
                    InputStream stream = rows.getBinaryStream(index);
                    if (stream == null) {
                        return NULL_SENTINEL;
                    }
                    try (InputStream closing = stream) {
                        return digestStream(closing);
                    } catch (IOException ioFailure) {
                        throw new UncheckedIOException(ioFailure);
                    }
                }
                case TEMPORAL -> {
                    Object raw = rows.getObject(index);
                    if (raw == null) {
                        return NULL_SENTINEL;
                    }
                    return TIMESTAMP_TEXT.format(toInstant(raw));
                }
                case INTEGER, NUMBER -> {
                    Object raw = rows.getObject(index);
                    if (raw == null) {
                        return NULL_SENTINEL;
                    }
                    return escape(canonicalNumber(raw));
                }
                default -> {
                    String value = rows.getString(index);
                    return value == null ? NULL_SENTINEL : escape(value);
                }
            }
        }

        /**
         * 解析 SQLite 的时间文本（历史上都是 {@code yyyy-MM-dd HH:mm:ss.SSS} 的 UTC 墙钟）。
         *
         * @param text 时间文本
         * @return UTC 瞬时；入参为空时返回 {@code null}
         * @throws IllegalArgumentException 无法解析
         */
        public static Instant parseTimestamp(String text) {
            if (text == null) {
                return null;
            }
            String value = text.trim();
            if (value.isEmpty()) {
                throw new IllegalArgumentException("时间列为空字符串，无法解析");
            }
            if (value.indexOf('T') > 0 || value.endsWith("Z")) {
                try {
                    return Instant.parse(value);
                } catch (DateTimeParseException ignored) {
                    // 继续尝试带偏移量的形式。
                }
                try {
                    return OffsetDateTime.parse(value).toInstant();
                } catch (DateTimeParseException ignored) {
                    // 继续尝试空格分隔的墙钟形式。
                }
            }
            for (String pattern : List.of(
                    "yyyy-MM-dd HH:mm:ss.SSS",
                    "yyyy-MM-dd HH:mm:ss.SS",
                    "yyyy-MM-dd HH:mm:ss.S",
                    "yyyy-MM-dd HH:mm:ss")) {
                try {
                    return LocalDateTime.parse(value, DateTimeFormatter.ofPattern(pattern, Locale.ROOT))
                            .toInstant(ZoneOffset.UTC);
                } catch (DateTimeParseException ignored) {
                    // 换下一种格式。
                }
            }
            throw new IllegalArgumentException("无法解析时间文本: " + value);
        }

        /**
         * 把 JDBC 读回的时间值统一成 UTC 瞬时（墙钟按 UTC 解释，与 H2 会话时区设置一致）。
         *
         * @param raw 原始值
         * @return UTC 瞬时
         */
        static Instant toInstant(Object raw) {
            if (raw instanceof Timestamp timestamp) {
                return timestamp.toInstant();
            }
            if (raw instanceof Instant instant) {
                return instant;
            }
            if (raw instanceof LocalDateTime localDateTime) {
                return localDateTime.toInstant(ZoneOffset.UTC);
            }
            if (raw instanceof java.time.LocalDate localDate) {
                return localDate.atStartOfDay().toInstant(ZoneOffset.UTC);
            }
            if (raw instanceof OffsetDateTime offsetDateTime) {
                return offsetDateTime.toInstant();
            }
            if (raw instanceof java.util.Date date) {
                return date.toInstant();
            }
            if (raw instanceof CharSequence text) {
                return parseTimestamp(text.toString());
            }
            throw new IllegalArgumentException("无法解析时间值: " + raw.getClass().getName() + "=" + raw);
        }

        /** 数值规范化：去尾零后取普通十进制写法，避免 {@code 0.6200} 与 {@code 0.62} 被判为不同。 */
        private static String canonicalNumber(Object raw) {
            if (raw instanceof Boolean flag) {
                return flag ? "1" : "0";
            }
            BigDecimal decimal;
            if (raw instanceof BigDecimal bigDecimal) {
                decimal = bigDecimal;
            } else if (raw instanceof Double doubleValue) {
                decimal = BigDecimal.valueOf(doubleValue);
            } else if (raw instanceof Float floatValue) {
                decimal = BigDecimal.valueOf(floatValue.doubleValue());
            } else {
                decimal = new BigDecimal(String.valueOf(raw).trim());
            }
            return decimal.stripTrailingZeros().toPlainString();
        }

        /** 值转义：反斜杠、字段分隔符与 NUL 都要转义，NULL 哨兵才不会被真实值冒充。 */
        private static String escape(String value) {
            StringBuilder escaped = new StringBuilder(value.length() + 8);
            for (int index = 0; index < value.length(); index++) {
                char character = value.charAt(index);
                if (character == '\\') {
                    escaped.append("\\\\");
                } else if (character == FIELD_SEPARATOR) {
                    escaped.append("\\u001f");
                } else if (character == '\u0000') {
                    escaped.append("\\u0000");
                } else {
                    escaped.append(character);
                }
            }
            return escaped.toString();
        }

        /** 大文本按块读全文算摘要：字符数 + SHA-256，跨块留一个代理对不会被拆散。 */
        private static String digestReader(Reader reader) throws IOException {
            MessageDigest digest = newSha256();
            char[] buffer = new char[STREAM_CHUNK_CHARS + 2];
            long characters = 0L;
            int carry = 0;
            while (true) {
                int read = reader.read(buffer, carry, STREAM_CHUNK_CHARS);
                if (read <= 0) {
                    break;
                }
                int total = carry + read;
                int emit = total;
                if (Character.isHighSurrogate(buffer[total - 1])) {
                    emit = total - 1;
                }
                if (emit > 0) {
                    digest.update(new String(buffer, 0, emit).getBytes(StandardCharsets.UTF_8));
                    characters += emit;
                }
                carry = total - emit;
                if (carry > 0) {
                    buffer[0] = buffer[total - 1];
                }
            }
            if (carry > 0) {
                digest.update(new String(buffer, 0, carry).getBytes(StandardCharsets.UTF_8));
                characters += carry;
            }
            return characters + ":" + hex(digest.digest());
        }

        /** 二进制按块算摘要。 */
        private static String digestStream(InputStream stream) throws IOException {
            MessageDigest digest = newSha256();
            byte[] buffer = new byte[STREAM_CHUNK_CHARS];
            long bytes = 0L;
            int read = stream.read(buffer);
            while (read > 0) {
                digest.update(buffer, 0, read);
                bytes += read;
                read = stream.read(buffer);
            }
            return bytes + ":" + hex(digest.digest());
        }
    }

    /** JSON 字符串字面量（含引号），只处理 JSON 必需转义。 */
    private static String jsonString(String value) {
        if (value == null) {
            return "null";
        }
        StringBuilder escaped = new StringBuilder(value.length() + 8);
        escaped.append('"');
        for (int index = 0; index < value.length(); index++) {
            char character = value.charAt(index);
            switch (character) {
                case '"' -> escaped.append("\\\"");
                case '\\' -> escaped.append("\\\\");
                case '\n' -> escaped.append("\\n");
                case '\r' -> escaped.append("\\r");
                case '\t' -> escaped.append("\\t");
                default -> {
                    if (character < 0x20) {
                        escaped.append(String.format(Locale.ROOT, "\\u%04x", (int) character));
                    } else {
                        escaped.append(character);
                    }
                }
            }
        }
        escaped.append('"');
        return escaped.toString();
    }

    /** JSON 对象（键为表名，值为行数或指纹）。 */
    private static String jsonObject(Map<String, ?> values) {
        if (values.isEmpty()) {
            return "{}";
        }
        StringBuilder json = new StringBuilder("{\n");
        int index = 0;
        for (Map.Entry<String, ?> entry : values.entrySet()) {
            json.append("    ").append(jsonString(entry.getKey())).append(": ");
            Object value = entry.getValue();
            json.append(value instanceof Number number ? String.valueOf(number.longValue())
                    : jsonString(String.valueOf(value)));
            json.append(++index == values.size() ? "\n" : ",\n");
        }
        return json.append("  }").toString();
    }
}




