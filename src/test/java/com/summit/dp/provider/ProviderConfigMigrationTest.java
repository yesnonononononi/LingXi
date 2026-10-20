package com.summit.dp.provider;

import com.summit.dp.shared.config.H2SchemaInitializer;
import org.junit.jupiter.api.Test;
import org.springframework.boot.DefaultApplicationArguments;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;

import java.sql.Connection;
import java.sql.ResultSet;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 老库升级守卫：model_config 的 provider_config_id 与 provider_config 表都必须被补齐。
 *
 * <p>漏了迁移的症状是运行期 {@code Column "PROVIDER_CONFIG_ID" not found}，
 * 而新库与单测全绿——所以这里直接拿「建于该列之前」的库跑两遍 bootstrap。</p>
 */
class ProviderConfigMigrationTest {

    @Test
    void legacyModelConfigGainsProviderColumnAndProviderTable() throws Exception {
        EmbeddedDatabase database = new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.H2)
                .setName(UUID.randomUUID() + ";MODE=MySQL").addScript("model-vision-legacy.sql").build();
        try {
            assertFalse(hasColumn(database, "model_config", "provider_config_id"));
            assertFalse(hasTable(database, "provider_config"));

            H2SchemaInitializer initializer = new H2SchemaInitializer();
            initializer.h2SchemaBootstrap(database).run(new DefaultApplicationArguments());
            initializer.h2SchemaBootstrap(database).run(new DefaultApplicationArguments());

            assertTrue(hasColumn(database, "model_config", "provider_config_id"));
            assertTrue(hasColumn(database, "model_config", "vision"), "V12 不能被 V13 挤掉");
            assertTrue(hasTable(database, "provider_config"));

            // 重复 bootstrap 是幂等空操作：索引重复创建会让第二次启动直接失败。
            assertTrue(hasIndex(database, "model_config", "idx_model_config_provider"));
        } finally {
            database.shutdown();
        }
    }

    private boolean hasColumn(EmbeddedDatabase database, String table, String column) throws Exception {
        try (Connection connection = database.getConnection();
             ResultSet columns = connection.getMetaData().getColumns(null, null, "%", "%")) {
            while (columns.next()) {
                if (table.equalsIgnoreCase(columns.getString("TABLE_NAME"))
                        && column.equalsIgnoreCase(columns.getString("COLUMN_NAME"))) {
                    return true;
                }
            }
        }
        return false;
    }

    private boolean hasTable(EmbeddedDatabase database, String table) throws Exception {
        try (Connection connection = database.getConnection();
             ResultSet tables = connection.getMetaData().getTables(null, null, "%", new String[]{"TABLE"})) {
            while (tables.next()) {
                if (table.equalsIgnoreCase(tables.getString("TABLE_NAME"))) return true;
            }
        }
        return false;
    }

    /** H2 会把未加引号的表名存成大写，必须先从元数据取真实表名再查索引。 */
    private boolean hasIndex(EmbeddedDatabase database, String table, String indexName) throws Exception {
        try (Connection connection = database.getConnection();
             ResultSet tables = connection.getMetaData().getTables(null, null, "%", new String[]{"TABLE"})) {
            while (tables.next()) {
                String actualTable = tables.getString("TABLE_NAME");
                if (!table.equalsIgnoreCase(actualTable)) continue;
                try (ResultSet indexes = connection.getMetaData()
                        .getIndexInfo(null, null, actualTable, false, false)) {
                    while (indexes.next()) {
                        String name = indexes.getString("INDEX_NAME");
                        if (name != null && name.equalsIgnoreCase(indexName)) return true;
                    }
                }
            }
        }
        return false;
    }
}
