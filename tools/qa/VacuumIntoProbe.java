import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;

/**
 * 探针：H2 2.5.252 是否支持 {@code VACUUM INTO '<file>'}？
 *
 * <p><b>为什么要测这个</b>：{@code SettingsDirectoryMigrator.vacuumInto} 用 SQLite 的
 * {@code VACUUM INTO} 生成库快照，进而完成「改数据目录」这条链路。H2 引擎下这条语句是否成立，
 * 决定了「改数据目录」是明确失败（配置不切换）还是静默造成数据看起来消失。这里用真实文件库实测。</p>
 *
 * <p>用法：{@code java -cp h2.jar tools/qa/VacuumIntoProbe.java <库前缀绝对路径> <目标文件>}</p>
 */
public final class VacuumIntoProbe {

    private VacuumIntoProbe() {
    }

    public static void main(String[] args) throws SQLException {
        if (args.length < 2) {
            System.out.println("用法: VacuumIntoProbe <库前缀> <目标文件>");
            return;
        }
        try (Connection connection = DriverManager.getConnection(
                "jdbc:h2:file:" + args[0] + ";DB_CLOSE_ON_EXIT=FALSE;TRACE_LEVEL_FILE=0", "sa", "");
             Statement statement = connection.createStatement()) {
            statement.execute("CREATE TABLE IF NOT EXISTS probe_row (id INT)");
            try {
                statement.execute("VACUUM INTO '" + args[1].replace("'", "''") + "'");
                System.out.println("VACUUM_INTO=OK");
            } catch (SQLException failure) {
                System.out.println("VACUUM_INTO=FAILED errorCode=" + failure.getErrorCode()
                        + " sqlState=" + failure.getSQLState()
                        + " message=" + failure.getMessage().replace('\n', ' '));
            }
        }
    }
}
