package com.summit.dp.shared;

import com.summit.dp.shared.config.H2SchemaInitializer;
import com.summit.dp.shared.persistence.schema.SchemaScript;
import com.summit.dp.shared.persistence.schema.SchemaScriptLoader;
import com.summit.dp.shared.storage.H2Storage;
import com.summit.dp.shared.support.H2TestDatabase;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * H2 建库的幂等/可重入/指纹守卫（全部跑真实 H2 文件库，禁用内存库）。
 *
 * <p>覆盖 T02 的五条完成判据：首装 executed=1、重复启动 executed=0、半途失败可重入补齐、
 * 已登记脚本被改动必须拒绝、期望表清单全存在才算建库完成。外加两条「从 SQLite 抄写法」的
 * 负向守卫（破坏性语句、{@code AUTOINCREMENT}）。</p>
 */
class H2SchemaMigrationTest {

    private final SchemaScriptLoader loader = new SchemaScriptLoader();
    private final List<H2TestDatabase> databases = new ArrayList<>();

    @Test
    void existingBaselineAddsImageSettingsWithoutRewritingItsChecksum() {
        H2TestDatabase database = newDatabase("image-settings-upgrade");
        H2SchemaInitializer initializer = new H2SchemaInitializer();
        assertEquals(1, initializer.initialize(database, List.of(baselineScript())));
        assertEquals(loader.load(H2Storage.SCHEMA_LOCATION).size() - 1, initializer.initialize(database));
        assertEquals("2", database.queryString("SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS"
                + " WHERE TABLE_SCHEMA='PUBLIC' AND TABLE_NAME='USER_CONFIGS'"
                + " AND COLUMN_NAME IN ('IMAGE_MODEL_ID','IMAGE_GENERATION_MAX_CALLS')"));
        assertEquals("10", database.queryString("SELECT COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS"
                + " WHERE TABLE_SCHEMA='PUBLIC' AND TABLE_NAME='USER_CONFIGS'"
                + " AND COLUMN_NAME='IMAGE_GENERATION_MAX_CALLS'"));
        assertEquals(0, initializer.initialize(database));
    }

    @AfterEach
    void cleanUp() {
        for (H2TestDatabase database : databases) {
            database.shutdown();
        }
        databases.clear();
    }

    @Test
    @DisplayName("首装：空目录执行全部版本，业务表齐全并登记脚本与指纹")
    void firstRunCreatesBaselineAndRecordsVersion() {
        H2TestDatabase database = newDatabase("first");
        SchemaScript baseline = baselineScript();

        int executed = new H2SchemaInitializer().initialize(database);

        assertEquals(loader.load(H2Storage.SCHEMA_LOCATION).size(), executed, "空库必须执行全部版本脚本");
        assertEquals(String.valueOf(H2SchemaInitializer.expectedTables().size()),
                database.queryString("SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES"
                        + " WHERE TABLE_SCHEMA = 'PUBLIC' AND TABLE_NAME <> 'SCHEMA_VERSION'"),
                "业务表数量必须与期望清单一致");
        assertEquals(String.valueOf(executed), database.queryString("SELECT COUNT(*) FROM schema_version"),
                "版本表必须登记全部脚本");
        assertEquals(baseline.checksum(),
                database.queryString("SELECT checksum FROM schema_version WHERE version = 1"),
                "登记的指纹必须等于脚本正文的 SHA-256");
        assertEquals(baseline.filename(),
                database.queryString("SELECT script FROM schema_version WHERE version = 1"));
        assertTrue(database.queryString("SELECT applied_at FROM schema_version WHERE version = 1") != null,
                "登记时间必须落库");
        assertTrue(database.databaseFile().toFile().isFile(),
                "必须是真的文件库: " + database.databaseFile());
        System.out.println("[H2-EVIDENCE] dbFile=" + database.databaseFile()
                + " size=" + database.databaseFile().toFile().length()
                + " tables=" + database.queryColumn("SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES"
                + " WHERE TABLE_SCHEMA = 'PUBLIC' AND TABLE_NAME <> 'SCHEMA_VERSION' ORDER BY TABLE_NAME")
                + " schema_version=" + database.queryColumn(
                "SELECT version || '|' || script || '|' || checksum || '|' || CAST(applied_at AS VARCHAR)"
                        + " FROM schema_version"));
    }

    @Test
    @DisplayName("重复启动 executed=0：已登记版本直接跳过")
    void secondRunIsNoOp() {
        H2TestDatabase database = newDatabase("second");
        H2SchemaInitializer initializer = new H2SchemaInitializer();
        assertEquals(loader.load(H2Storage.SCHEMA_LOCATION).size(), initializer.initialize(database));

        assertEquals(0, initializer.initialize(database), "第二次建库必须一条都不执行");
        assertEquals(String.valueOf(loader.load(H2Storage.SCHEMA_LOCATION).size()), database.queryString("SELECT COUNT(*) FROM schema_version"));
    }

    @Test
    @DisplayName("已登记脚本被改动（版本号没升）→ 指纹不符，拒绝启动")
    void changedScriptWithoutVersionBumpIsRejected() {
        H2TestDatabase database = newDatabase("changed");
        SchemaScript baseline = baselineScript();
        assertEquals(1, new H2SchemaInitializer().initialize(database, List.of(baseline)));

        String changedContent = baseline.content() + "\n-- 偷偷改一行\n";
        SchemaScript changed = new SchemaScript(1, baseline.filename(), changedContent,
                loader.checksum(changedContent));

        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> new H2SchemaInitializer().initialize(database, List.of(changed)));
        assertTrue(failure.getMessage().contains("已被修改"),
                "必须明确说脚本被改过，实际=" + failure.getMessage());
    }

    @Test
    @DisplayName("脚本缺一张业务表 → 期望清单校验失败、不登记版本；补齐脚本后重跑成功")
    void missingExpectedTableFailsAndStaysRecoverable() {
        H2TestDatabase database = newDatabase("missing");
        SchemaScript baseline = baselineScript();
        String broken = baseline.content().replaceAll(
                "(?s)CREATE TABLE IF NOT EXISTS team \\(.*?\\n\\);", "");
        assertTrue(broken.length() < baseline.content().length(), "变异必须真的删掉了一段");

        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> new H2SchemaInitializer().initialize(database,
                        List.of(new SchemaScript(1, baseline.filename(), broken, loader.checksum(broken)))));
        assertTrue(failure.getMessage().contains("team"),
                "必须点名缺失的表，实际=" + failure.getMessage());
        assertEquals("0", database.queryString("SELECT COUNT(*) FROM schema_version"),
                "期望表清单没过就绝不能登记版本");

        // 可重入：拿完整脚本再跑一次，缺的表被补齐，版本登记成功。
        assertEquals(loader.load(H2Storage.SCHEMA_LOCATION).size(), new H2SchemaInitializer().initialize(database),
                "半建状态必须能靠重跑幂等脚本补齐");
        assertEquals("1", database.queryString(
                "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'TEAM'"));
    }

    @Test
    @DisplayName("半建状态（部分表已存在）→ 幂等脚本照常补齐，不报错")
    void partialSchemaIsCompletedOnRerun() {
        H2TestDatabase database = newDatabase("partial");
        SchemaScript baseline = baselineScript();
        String mcpTable = loader.splitStatements(baseline).stream()
                .filter(statement -> statement.contains("CREATE TABLE IF NOT EXISTS mcp "))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("基线里找不到 mcp 建表语句"));
        database.execute(mcpTable);

        assertEquals(loader.load(H2Storage.SCHEMA_LOCATION).size(), new H2SchemaInitializer().initialize(database),
                "已有部分表时仍必须执行脚本（幂等）");
        assertEquals(String.valueOf(H2SchemaInitializer.expectedTables().size()),
                database.queryString("SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES"
                        + " WHERE TABLE_SCHEMA = 'PUBLIC' AND TABLE_NAME <> 'SCHEMA_VERSION'"));
    }

    @Test
    @DisplayName("破坏性语句（DROP TABLE）→ 直接拒绝，不执行任何一条")
    void destructiveScriptIsRejected() {
        H2TestDatabase database = newDatabase("destructive");
        String content = "DROP TABLE mcp;\n";
        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> new H2SchemaInitializer().initialize(database,
                        List.of(new SchemaScript(1, "V1__destructive.sql", content, loader.checksum(content)))));
        assertTrue(failure.getMessage().contains("破坏性"),
                "必须说明命中了破坏性语句，实际=" + failure.getMessage());
    }

    @Test
    @DisplayName("把 SQLite 的 AUTOINCREMENT 抄进 H2 脚本 → 拒绝执行并点名写法")
    void sqliteOnlySyntaxIsRejected() {
        H2TestDatabase database = newDatabase("autoincrement");
        String content = "CREATE TABLE IF NOT EXISTS t_auto (id INTEGER PRIMARY KEY AUTOINCREMENT);\n";
        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> new H2SchemaInitializer().initialize(database,
                        List.of(new SchemaScript(1, "V1__auto.sql", content, loader.checksum(content)))));
        assertTrue(failure.getMessage().contains("AUTOINCREMENT"),
                "必须点名不支持的写法，实际=" + failure.getMessage());
    }

    @Test
    @DisplayName("初始化器内置的期望表清单与全部脚本声明的表集合完全一致（防两处漂移）")
    void expectedTablesMatchTheScript() {
        Pattern createTable = Pattern.compile(
                "CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(\\w+)", Pattern.CASE_INSENSITIVE);
        Set<String> declared = new LinkedHashSet<>();
        for (SchemaScript script : loader.load(H2Storage.SCHEMA_LOCATION)) {
            Matcher matcher = createTable.matcher(script.content());
            while (matcher.find()) {
                declared.add(matcher.group(1).toLowerCase(Locale.ROOT));
            }
        }
        assertEquals(declared, new LinkedHashSet<>(H2SchemaInitializer.expectedTables()),
                "期望表清单必须与 db/h2 全部版本脚本声明的表集合一致");
    }

    /** 临时库：只开文件不建表，建库交给被测的初始化器。 */
    private H2TestDatabase newDatabase(String prefix) {
        H2TestDatabase database = H2TestDatabase.createWithoutSchema(prefix);
        databases.add(database);
        return database;
    }

    /** V1 基线单独用于指纹和半建状态检查，后续迁移由完整初始化验证。 */
    private SchemaScript baselineScript() {
        List<SchemaScript> scripts = loader.load(H2Storage.SCHEMA_LOCATION);
        return scripts.stream().filter(script -> script.version() == 1).findFirst().orElseThrow();
    }
}
