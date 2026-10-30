import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.HexFormat;

/**
 * SQLite 一致性快照的**集中维护调用**：开发初始化脚本用它代替「直接复制主文件」。
 *
 * <p>为什么不能直接复制 {@code lingxi.sqlite}：库开了 WAL，最近的提交可能还只在
 * {@code lingxi.sqlite-wal} 里，主文件单独复制就是一份丢提交（甚至自相矛盾）的数据。
 * {@code VACUUM INTO} 由驱动在库侧生成「已提交状态」的单文件快照，WAL 会一并合并进去。</p>
 *
 * <p>用法（JDK 11+ 单文件源码启动，不需要先编译）：</p>
 * <pre>
 * java -cp &lt;sqlite-jdbc.jar&gt; scripts/SqliteSnapshot.java --source &lt;源库文件&gt; --target &lt;目标文件&gt;
 * </pre>
 *
 * <p>成功时在标准输出打印一行 {@code snapshot=... schemaVersion=... sha256=...}，
 * 失败时把原因打到标准错误并以非 0 退出。</p>
 */
public final class SqliteSnapshot {

    /** 版本表名；与后端 {@code SqliteSchemaInitializer} 保持一致。 */
    private static final String VERSION_TABLE = "schema_version";
    private static final int SUCCESS = 0;
    private static final int FAILURE = 1;

    private SqliteSnapshot() { }

    /**
     * 命令行入口。
     *
     * @param args {@code --source <file>} 与 {@code --target <file>}
     */
    public static void main(String[] args) {
        try {
            Path source = null;
            Path target = null;
            for (int index = 0; index < args.length; index++) {
                switch (args[index]) {
                    case "--source" -> source = Path.of(requireValue(args, ++index, "--source"));
                    case "--target" -> target = Path.of(requireValue(args, ++index, "--target"));
                    default -> throw new IllegalArgumentException("未知参数: " + args[index]);
                }
            }
            if (source == null || target == null) {
                throw new IllegalArgumentException("必须同时给出 --source 与 --target");
            }
            String summary = snapshot(source, target);
            System.out.println(summary);
        } catch (RuntimeException | SQLException | IOException failure) {
            System.err.println("SQLite 快照失败: " + failure.getMessage());
            System.exit(FAILURE);
        }
        System.exit(SUCCESS);
    }

    private static String requireValue(String[] args, int index, String name) {
        if (index >= args.length) {
            throw new IllegalArgumentException(name + " 缺少取值");
        }
        return args[index];
    }

    /**
     * 生成一致性快照并做自检。
     *
     * @param source 源库文件（可以带着 -wal，驱动会一并读取）
     * @param target 目标快照文件；必须不存在
     * @return 一行摘要（含快照路径、schema_version、SHA-256）
     */
    private static String snapshot(Path source, Path target) throws SQLException, IOException {
        if (!Files.isRegularFile(source)) {
            throw new IOException("源库文件不存在: " + source);
        }
        Path absoluteTarget = target.toAbsolutePath().normalize();
        Files.createDirectories(absoluteTarget.getParent());
        Files.deleteIfExists(absoluteTarget);
        // VACUUM INTO 只接受单引号字面量：把反斜杠统一成正斜杠，并转义单引号。
        String location = absoluteTarget.toString().replace('\\', '/').replace("'", "''");
        try (Connection connection = open(source);
             Statement statement = connection.createStatement()) {
            statement.execute("VACUUM INTO '" + location + "'");
        }
        int schemaVersion = readSchemaVersion(absoluteTarget);
        String sha256 = sha256Of(absoluteTarget);
        return "snapshot=" + absoluteTarget + " schemaVersion=" + schemaVersion + " sha256=" + sha256;
    }

    /** 以普通连接打开源库；WAL 里的提交由驱动自行合并，这里不需要额外操作。 */
    private static Connection open(Path source) throws SQLException {
        String url = "jdbc:sqlite:" + source.toAbsolutePath().toString().replace('\\', '/')
                + "?busy_timeout=5000";
        return DriverManager.getConnection(url);
    }

    /** 打开快照本身做完整性检查，并读回 schema_version 的最大值（没有版本表时返回 0）。 */
    private static int readSchemaVersion(Path snapshotFile) throws SQLException {
        String url = "jdbc:sqlite:" + snapshotFile.toAbsolutePath().toString().replace('\\', '/');
        try (Connection connection = DriverManager.getConnection(url)) {
            try (Statement statement = connection.createStatement();
                 ResultSet rows = statement.executeQuery("PRAGMA integrity_check")) {
                if (!rows.next() || !"ok".equalsIgnoreCase(rows.getString(1))) {
                    throw new SQLException("快照完整性检查未通过");
                }
            }
            try (Statement statement = connection.createStatement();
                 ResultSet rows = statement.executeQuery("SELECT MAX(version) FROM " + VERSION_TABLE)) {
                return rows.next() ? rows.getInt(1) : 0;
            } catch (SQLException noVersionTable) {
                return 0;
            }
        }
    }

    private static String sha256Of(Path file) throws IOException {
        try (var stream = Files.newInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[8192];
            int read;
            while ((read = stream.read(buffer)) > 0) {
                digest.update(buffer, 0, read);
            }
            return HexFormat.of().withUpperCase().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException impossible) {
            throw new UncheckedIOException(new IOException("JVM 缺少 SHA-256", impossible));
        }
    }
}
