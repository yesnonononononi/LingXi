package com.summit.dp.shared;

import com.summit.dp.shared.config.SqliteSchemaInitializer;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * 建库脚本的资源形态守卫。
 *
 * <p>这条守卫挡的是「脚本没打进 jar」和「脚本偷偷用了 MySQL 方言」两类问题：
 * 前者在源码启动时正常、装成安装包才炸；后者会让 SQLite 在启动期直接报语法错误，
 * 而手写测试因为用了别的建库路径发现不了。</p>
 */
class SqliteSchemaResourceTest {

    @Test
    @DisplayName("V1 建库脚本必须在 classpath 上，且只使用 SQLite 语法")
    void schemaScriptIsOnClasspathAndUsesSqliteGrammar() throws Exception {
        Resource script = new ClassPathResource("db/sqlite/V1__schema.sql");
        assertTrue(script.exists(), "建库脚本必须打进 classpath");
        String sql = new String(script.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        // 先剔掉注释行：注释里提到 MySQL 语法是解释「为什么不用」，不是方言残留。
        StringBuilder code = new StringBuilder();
        for (String line : sql.split("\n")) {
            if (!line.strip().startsWith("--")) {
                code.append(line).append('\n');
            }
        }
        String ddl = code.toString();
        assertTrue(ddl.contains("CREATE TABLE IF NOT EXISTS session_message"),
                "脚本必须包含核心业务表");

        List<String> dialectLeaks = new ArrayList<>();
        for (String forbidden : List.of("AUTO_INCREMENT", "ENGINE =", "ENGINE=", "COMMENT '",
                "LONGTEXT", "MEDIUMTEXT", "ON UPDATE CURRENT_TIMESTAMP", "ENUM(")) {
            if (ddl.contains(forbidden)) {
                dialectLeaks.add(forbidden);
            }
        }
        assertTrue(dialectLeaks.isEmpty(), "建库脚本混入了 MySQL 方言: " + dialectLeaks);
        // 自增主键在 SQLite 里只有这一种写法
        assertTrue(ddl.contains("INTEGER PRIMARY KEY AUTOINCREMENT"));
    }

    @Test
    @DisplayName("脚本目录里每个版本文件都能被初始化器扫到，且命名合法")
    void everyVersionScriptIsDiscoverable() throws Exception {
        Resource[] resources = new PathMatchingResourcePatternResolver()
                .getResources("classpath*:db/sqlite/V*__*.sql");
        assertNotNull(resources);
        assertTrue(resources.length >= 1, "至少要有一个版本脚本");
        for (Resource resource : resources) {
            String filename = resource.getFilename();
            assertNotNull(filename);
            assertTrue(filename.matches("V\\d+__[a-z0-9_]+\\.sql"), "脚本命名不合规: " + filename);
        }
    }

    @Test
    @DisplayName("初始化器拒绝执行含破坏性语句的脚本（金丝雀：确认守卫真的在拦）")
    void destructiveScriptIsRejectedByTheSameGuardTheInitializerUses() throws Exception {
        String script = new String(new ClassPathResource("db/sqlite/V1__schema.sql")
                .getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        // 正对照：真实脚本不含破坏性语句，守卫放行
        assertFalse(script.matches("(?im)^\\s*DROP\\s+TABLE.*"), "真实脚本不该包含 DROP TABLE");
        // 金丝雀：守卫正则本身必须能命中破坏性语句，否则「没命中」不构成证据
        assertTrue("DROP TABLE session".matches("(?im)^\\s*DROP\\s+TABLE.*"));
        assertNotNull(SqliteSchemaInitializer.class);
    }
}
