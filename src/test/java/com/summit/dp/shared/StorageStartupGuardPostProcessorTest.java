package com.summit.dp.shared;

import com.summit.dp.shared.storage.H2Storage;
import com.summit.dp.shared.storage.StorageDataSourceKeys;
import com.summit.dp.shared.storage.StorageLayout;
import com.summit.dp.shared.storage.StorageStartupGuardPostProcessor;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.env.YamlPropertySourceLoader;
import org.springframework.core.io.ClassPathResource;
import org.springframework.mock.env.MockEnvironment;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.*;

class StorageStartupGuardPostProcessorTest {
    @TempDir Path directory;

    @Test
    void defaultYamlIsH2AndMatchesTestConnections() throws Exception {
        MockEnvironment environment = new MockEnvironment();
        new YamlPropertySourceLoader().load("application", new ClassPathResource("application.yaml"))
                .forEach(source -> environment.getPropertySources().addLast(source));
        environment.setProperty("lingxi.data.dir", directory.toString().replace('\\', '/'));
        assertEquals(H2Storage.DRIVER_CLASS_NAME, environment.getProperty("spring.datasource.driver-class-name"));
        assertEquals(StorageDataSourceKeys.h2Url(new StorageLayout(directory)),
                environment.getProperty("spring.datasource.url"));
        assertNull(environment.getProperty("lingxi.storage.engine"));
        new StorageStartupGuardPostProcessor().postProcessEnvironment(environment, null);
        assertEquals(StorageDataSourceKeys.SET_TIME_ZONE_UTC,
                environment.getProperty("spring.datasource.druid.connection-init-sqls"));
        assertEquals("8", environment.getProperty("spring.datasource.druid.max-active"));
    }

    @Test
    void legacySettingCannotSelectSqliteOrBypassMigration() throws Exception {
        Files.writeString(directory.resolve("lingxi.sqlite"), "old-data");
        MockEnvironment environment = new MockEnvironment()
                .withProperty("lingxi.data.dir", directory.toString())
                .withProperty("lingxi.storage.engine", "sqlite");
        IllegalStateException failure = assertThrows(IllegalStateException.class,
                () -> new StorageStartupGuardPostProcessor().postProcessEnvironment(environment, null));
        assertTrue(failure.getMessage().contains("未迁移"));
        assertFalse(Files.exists(directory.resolve(H2Storage.DATABASE_FILE_NAME)));
        assertEquals("old-data", Files.readString(directory.resolve("lingxi.sqlite")));
    }
}
