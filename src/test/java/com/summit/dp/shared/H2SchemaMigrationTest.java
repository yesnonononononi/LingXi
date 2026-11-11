package com.summit.dp.shared;

import com.summit.dp.shared.config.H2SchemaInitializer;
import com.summit.dp.shared.persistence.schema.SchemaScript;
import com.summit.dp.shared.persistence.schema.SchemaScriptLoader;
import com.summit.dp.shared.storage.H2Storage;
import com.summit.dp.shared.support.H2TestDatabase;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
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
    @DisplayName("只有换行符在 LF/CRLF 之间变化 → 不算脚本被改动，照常启动（工作区被 git/IDE 重写）")
    void lineEndingRewriteIsNotTreatedAsScriptModification() {
        H2TestDatabase database = newDatabase("eol");
        SchemaScript baseline = baselineScript();
        String lf = baseline.content().replace("\r\n", "\n");
        String crlf = lf.replace("\n", "\r\n");
        assertNotEquals(lf, crlf, "基线脚本必须含换行，否则这条用例证明不了任何事");

        assertEquals(1, new H2SchemaInitializer().initialize(database,
                List.of(new SchemaScript(1, baseline.filename(), lf, loader.checksum(lf)))));
        assertEquals(0, new H2SchemaInitializer().initialize(database,
                        List.of(new SchemaScript(1, baseline.filename(), crlf, loader.checksum(crlf)))),
                "正文只差换行符时必须视为同一脚本，不能被指纹守卫拦下");
        assertEquals(0, new H2SchemaInitializer().initialize(database,
                        List.of(new SchemaScript(1, baseline.filename(), lf, loader.checksum(lf)))),
                "反方向（CRLF → LF）同样不能被拦");
    }

    @Test
    @DisplayName("历史库登记的是 raw 口径指纹（按当时原始字节算）→ 升级后仍能启动")
    void legacyRawChecksumStaysAcceptable() {
        H2TestDatabase database = newDatabase("legacy-fingerprint");
        SchemaScript baseline = baselineScript();
        String crlf = baseline.content().replace("\r\n", "\n").replace("\n", "\r\n");
        // 模拟旧版行为：正文带 CRLF，指纹直接对原始字节取 SHA-256（不经规范化）。
        SchemaScript legacy = new SchemaScript(1, baseline.filename(), crlf, rawSha256(crlf));
        assertEquals(1, new H2SchemaInitializer().initialize(database, List.of(legacy)));

        assertEquals(0, new H2SchemaInitializer().initialize(database, List.of(baseline)),
                "库里登记的旧口径指纹必须仍被接受，否则升级即锁死启动");
    }

    @Test
    @DisplayName("历史库登记的是「混用换行符」文件的原始指纹 → 仍能启动（V7 实测就是这个形态）")
    void legacyMixedLineEndingFingerprintStaysAcceptable() {
        H2TestDatabase database = newDatabase("legacy-mixed");
        SchemaScript baseline = baselineScript();
        String[] lines = baseline.content().replace("\r\n", "\n").split("\n", -1);
        StringBuilder mixed = new StringBuilder();
        for (int index = 0; index < lines.length; index++) {
            // 奇数行 CRLF、偶数行 LF：任何「整体换行符变体」都枚举不到这种形态
            mixed.append(lines[index]).append(index % 2 == 0 ? "\r\n" : "\n");
        }
        String mixedContent = mixed.toString();
        assertNotEquals(loader.checksum(mixedContent), rawSha256(mixedContent),
                "混用换行符时两种口径必须不同，否则这条用例没有证明力");

        assertEquals(1, new H2SchemaInitializer().initialize(database,
                List.of(new SchemaScript(1, baseline.filename(), mixedContent, rawSha256(mixedContent)))));
        assertEquals(0, new H2SchemaInitializer().initialize(database,
                        List.of(new SchemaScript(1, baseline.filename(), mixedContent, rawSha256(mixedContent)))),
                "混用换行符的历史指纹必须被接受（按当时原始字节登记，规范化口径复算不出来）");
    }

    @Test
    @DisplayName("改的是一句注释（语义无关但内容变了）→ 仍然拒绝，指纹不是白设的")
    void commentOnlyEditIsStillRejected() {
        H2TestDatabase database = newDatabase("comment-edit");
        SchemaScript baseline = baselineScript();
        assertEquals(1, new H2SchemaInitializer().initialize(database, List.of(baseline)));

        String edited = baseline.content().replace("\n", "\n-- 补一句注释\n");
        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> new H2SchemaInitializer().initialize(database,
                        List.of(new SchemaScript(1, baseline.filename(), edited, loader.checksum(edited)))));
        assertTrue(failure.getMessage().contains("已被修改"),
                "内容变化必须被抓住，实际=" + failure.getMessage());
    }

    @Test
    @DisplayName("规范化：BOM 与 CRLF 都被抹平，且规范化可重复（幂等）")
    void canonicalizeIsIdempotentAndEolAgnostic() {
        String crlf = "-- 注释\r\nCREATE TABLE IF NOT EXISTS mcp (id VARCHAR(36) PRIMARY KEY);\r\n";
        String canonical = SchemaScriptLoader.canonicalize("\uFEFF" + crlf);
        assertEquals(canonical, SchemaScriptLoader.canonicalize(canonical), "规范化必须幂等");
        assertFalse(canonical.contains("\r"), "规范化后不能残留回车");
        assertFalse(canonical.startsWith("\uFEFF"), "规范化后不能残留 BOM");
        assertEquals(loader.checksum("\uFEFF" + crlf), loader.checksum(canonical),
                "指纹必须在 BOM/换行符差异下不变");
        assertTrue(loader.matchesRegistered(rawSha256(crlf), crlf), "旧口径指纹必须被接受");
        assertFalse(loader.matchesRegistered("deadbeef", crlf), "乱写的指纹不能被接受");
        assertFalse(loader.matchesRegistered(null, crlf), "空指纹不能被接受");
        assertEquals(3, loader.acceptedChecksums("-- a\n-- b\n").size(),
                "无 BOM 的两行脚本应给出三个不同口径的指纹");
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
    @DisplayName("脚本含 UTF-8 BOM 且首行为注释时能正常剥除 BOM 并切分执行，不报语法错误")
    void scriptWithUtf8BomAndLeadingCommentIsHandledSafely() {
        String content = "\uFEFF-- 首行注释\nCREATE TABLE IF NOT EXISTS mcp (id VARCHAR(36) PRIMARY KEY);\n";
        SchemaScript script = new SchemaScript(1, "V1__bom.sql", content, loader.checksum(content));
        List<String> statements = loader.splitStatements(script);
        assertEquals(1, statements.size());
        assertTrue(statements.get(0).startsWith("CREATE TABLE IF NOT EXISTS mcp"));
        assertFalse(statements.get(0).contains("\uFEFF"));
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

    @Test
    @DisplayName("脚本按版本号升序执行，且重复版本号必须拒绝（classpath 返回顺序不在契约内）")
    void scriptsAreOrderedByVersionAndDuplicatesRejected() {
        SchemaScript first = new SchemaScript(1, "V1__a.sql", "-- a\n", loader.checksum("-- a\n"));
        SchemaScript second = new SchemaScript(2, "V2__b.sql", "-- b\n", loader.checksum("-- b\n"));
        SchemaScript third = new SchemaScript(10, "V10__c.sql", "-- c\n", loader.checksum("-- c\n"));

        assertEquals(List.of(1, 2, 10),
                loader.orderByVersion(List.of(third, first, second)).stream()
                        .map(SchemaScript::version).toList(),
                "版本号必须升序，10 要排在 2 之后（不能按字符串排）");
        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> loader.orderByVersion(List.of(first, first)));
        assertTrue(failure.getMessage().contains("版本号重复"), "必须点名重复，实际=" + failure.getMessage());
        assertEquals(List.of(1, 2), loader.load(H2Storage.SCHEMA_LOCATION).stream()
                .map(SchemaScript::version).toList().subList(0, 2), "真实脚本集也必须是从 1 开始升序");
    }

    /** 旧口径指纹：直接对给定字符串的 UTF-8 字节取 SHA-256（不经任何规范化）。 */
    private static String rawSha256(String text) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(hash.length * 2);
            for (byte value : hash) {
                hex.append(Character.forDigit((value >> 4) & 0xF, 16));
                hex.append(Character.forDigit(value & 0xF, 16));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("当前 JVM 不支持 SHA-256", e);
        }
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
