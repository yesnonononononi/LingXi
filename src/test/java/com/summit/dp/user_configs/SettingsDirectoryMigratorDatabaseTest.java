package com.summit.dp.user_configs;

import com.summit.dp.user_configs.infrastructure.fs.SettingsDirectoryMigrator;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 数据目录迁移的**真实数据库**验证。
 *
 * <p>这里要证的不是「代码调了 BACKUP」，而是两件读代码看不出来的事：
 * ① H2 到底把库文件以什么条目名打进备份 zip（条目名与期望不符 ⇒ 解包会找不到库文件）；
 * ② 从备份还原出来的库能不能被新目录重新打开、原来写进去的数据还在不在。
 * 这两点任一不成立，用户改数据目录之后看到的就是「数据没了」。</p>
 */
class SettingsDirectoryMigratorDatabaseTest {

    @TempDir
    Path tempDir;

    @Test
    @DisplayName("迁移后的库能在新目录打开，且原数据还在")
    void migratedDatabaseOpensAtNewDirectoryWithData() throws Exception {
        Path fromDir = Files.createDirectories(tempDir.resolve("from"));
        Path toDir = tempDir.resolve("to");

        DriverManagerDataSource source = dataSourceOf(fromDir);
        try (Connection connection = source.getConnection();
             Statement statement = connection.createStatement()) {
            statement.execute("CREATE TABLE probe (id INT PRIMARY KEY, note VARCHAR(64))");
            statement.execute("INSERT INTO probe VALUES (1, '搬家前写入的数据')");
        }

        new SettingsDirectoryMigrator(source).migrateDataDir(fromDir.toString(), toDir.toString());

        assertTrue(Files.exists(toDir.resolve("lingxi.mv.db")), "新目录里必须出现库文件");

        try (Connection connection = dataSourceOf(toDir).getConnection();
             Statement statement = connection.createStatement();
             ResultSet rows = statement.executeQuery("SELECT note FROM probe WHERE id = 1")) {
            assertTrue(rows.next(), "迁移后的库里必须还能读到原来的数据");
            assertEquals("搬家前写入的数据", rows.getString(1));
        }
    }

    @Test
    @DisplayName("源目录里还没有库文件：迁移照样成功，新目录是一个可打开的空库")
    void missingSourceDatabaseStillYieldsOpenableTarget() throws Exception {
        Path fromDir = Files.createDirectories(tempDir.resolve("empty-from"));
        Path toDir = tempDir.resolve("to");

        new SettingsDirectoryMigrator(dataSourceOf(fromDir)).migrateDataDir(fromDir.toString(), toDir.toString());

        // 注意这里的真实行为：H2 在建立连接时就把库文件创建出来了（哪怕一行数据都没有），
        // 所以「源目录没有库文件」在生产里基本不会出现，备份出来的是一个空库 —— 结果等价于
        // 全新库，重启后照样能打开。这里断言的是「新目录可用」，不是「没有库文件」。
        try (Connection connection = dataSourceOf(toDir).getConnection();
             Statement statement = connection.createStatement()) {
            assertTrue(statement.executeQuery("SELECT 1").next());
        }
    }

    private static DriverManagerDataSource dataSourceOf(Path directory) {
        DriverManagerDataSource dataSource = new DriverManagerDataSource();
        dataSource.setDriverClassName(org.h2.Driver.class.getName());
        // 与生产同样的形态：file 库 + MySQL 兼容模式。
        dataSource.setUrl("jdbc:h2:file:" + directory.resolve("lingxi").toString().replace('\\', '/') + ";MODE=MySQL");
        dataSource.setUsername("sa");
        dataSource.setPassword("");
        return dataSource;
    }
}
