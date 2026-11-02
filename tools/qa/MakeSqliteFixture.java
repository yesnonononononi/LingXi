import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * 造一个最小可迁移的 SQLite 夹具库（T05 迁移工具变异演练用，M11–M13）。
 *
 * <p><b>为什么要自己造</b>：禁区里的真实库（安装版 574 MB、开发库 708 MB）一律不读不写，
 * 演练只能用 {@code %TEMP%} 下的自造副本。夹具执行的是仓库真源
 * {@code src/test/resources/db/legacy-sqlite/V1__schema.sql}，并塞少量行（含一行大文本），
 * 足以让迁移工具的逐表指纹、identity 起点、导数/校验三条路径都跑到。</p>
 *
 * <p>用法：{@code java -cp sqlite-jdbc.jar tools/qa/MakeSqliteFixture.java <库文件> <V1 脚本> [V2 脚本]}</p>
 */
public final class MakeSqliteFixture {

    private MakeSqliteFixture() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.out.println("用法: MakeSqliteFixture <库文件> <V1 脚本> [V2 脚本]");
            return;
        }
        Path database = Path.of(args[0]);
        Files.createDirectories(database.toAbsolutePath().getParent());
        Files.deleteIfExists(database);
        try (Connection connection = DriverManager.getConnection("jdbc:sqlite:" + database)) {
            applyScript(connection, Path.of(args[1]));
            if (args.length > 2) {
                applyScript(connection, Path.of(args[2]));
            }
            seed(connection);
        }
        System.out.println("FIXTURE=OK path=" + database + " bytes=" + Files.size(database));
    }

    private static void applyScript(Connection connection, Path script) throws Exception {
        String sql = Files.readString(script, StandardCharsets.UTF_8);
        StringBuilder withoutComments = new StringBuilder(sql.length());
        for (String line : sql.split("\n")) {
            String trimmed = line.strip();
            if (trimmed.startsWith("--") || trimmed.isEmpty()) {
                continue;
            }
            withoutComments.append(line).append('\n');
        }
        try (Statement statement = connection.createStatement()) {
            // 触发器里有 BEGIN…END 的语句内分号，按 ';' 硬切会切坏；迁移演练只关心表/列/行，
            // 触发器与迁移无关，先整块剔除再切语句（真实建库走 SchemaScriptLoader，这里不重复实现）。
            String withoutTriggers = withoutComments.toString()
                    .replaceAll("(?s)CREATE\\s+TRIGGER\\b.*?END\\s*;", "");
            for (String single : withoutTriggers.split(";")) {
                if (!single.isBlank()) {
                    statement.execute(single.strip());
                }
            }
        }
    }

    /** 塞最小行集：一张带 CLOB 的表、一张自增表（含 id=1，用于 identity 起点演练）、一张有生成列的表。 */
    private static void seed(Connection connection) throws SQLException {
        try (PreparedStatement session = connection.prepareStatement(
                "INSERT INTO session (id, name, context_ratio) VALUES (?, ?, ?)");
             PreparedStatement context = connection.prepareStatement(
                     "INSERT INTO session_context (session_id, content, version) VALUES (?, ?, 1)");
             PreparedStatement execution = connection.prepareStatement(
                     "INSERT INTO execution (id, version, session_id, status, snapshot_file)"
                             + " VALUES (?, 1, ?, 1, ?)")) {
            // id=1 与 id=100/900 并存：迁移若没把 identity 起点推到 max+1，下一次插入就会撞上 id=1。
            session.setLong(1, 1L);
            session.setString(2, "小号会话");
            session.setDouble(3, 0.5d);
            session.executeUpdate();

            session.setLong(1, 100L);
            session.setString(2, "迁移演练会话");
            session.setDouble(3, 0.09512015503875969d);
            session.executeUpdate();

            context.setLong(1, 100L);
            context.setString(2, "上下文正文-" + "x".repeat(4096));
            context.executeUpdate();

            execution.setLong(1, 1L);
            execution.setLong(2, 1L);
            execution.setString(3, "ck-small");
            execution.executeUpdate();

            execution.setLong(1, 900L);
            execution.setLong(2, 100L);
            execution.setString(3, "ck-1");
            execution.executeUpdate();
        }
    }
}
