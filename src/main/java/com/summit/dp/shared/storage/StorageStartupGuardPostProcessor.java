package com.summit.dp.shared.storage;

import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.Ordered;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.util.ClassUtils;

import java.nio.file.InvalidPathException;
import java.nio.file.Path;

/** 设置行先选定目录，随后在连接池创建前拒绝未迁移的数据。 */
@Slf4j
public class StorageStartupGuardPostProcessor implements EnvironmentPostProcessor, Ordered {
    @Override
    public int getOrder() { return Ordered.LOWEST_PRECEDENCE; }

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        String raw = environment.getProperty("lingxi.data.dir", "${user.home}/.lingxi/data");
        try {
            StorageLayout layout = new StorageLayout(Path.of(environment.resolvePlaceholders(raw).trim()));
            new StorageEngineGuard().requireStartable(layout,
                    ClassUtils.isPresent(H2Storage.DRIVER_CLASS_NAME, null));
            log.info("存储目录检查完成: database={}", layout.databaseFile());
            compactBeforeDataSource(environment, layout);
        } catch (InvalidPathException failure) {
            throw new IllegalStateException("数据目录不是合法路径: lingxi.data.dir=" + raw, failure);
        }
    }

    private static void compactBeforeDataSource(ConfigurableEnvironment environment, StorageLayout layout) {
        String datasourceUrl = environment.getProperty("spring.datasource.url", "");
        if (!datasourceUrl.isEmpty() && !datasourceUrl.startsWith("jdbc:h2:file:")) {
            return;
        }
        boolean enabled = environment.getProperty("lingxi.storage.h2-compact-on-startup.enabled", Boolean.class, true);
        long minFileSizeMb = environment.getProperty("lingxi.storage.h2-compact-on-startup.min-file-size-mb", Long.class, 128L);
        int maxFillRatePercent = environment.getProperty("lingxi.storage.h2-compact-on-startup.max-fill-rate-percent", Integer.class, 50);
        int maxCompactTimeMs = environment.getProperty("lingxi.storage.h2-compact-on-startup.max-compact-time-ms", Integer.class, 3000);
        String username = environment.getProperty("spring.datasource.username", "");
        String password = environment.getProperty("spring.datasource.password", "");
        new H2StartupCompactor(layout, username, password, enabled, minFileSizeMb, maxFillRatePercent, maxCompactTimeMs)
                .compactIfNeeded();
    }
}
