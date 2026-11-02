package com.summit.dp.user_configs.infrastructure.config;

import com.summit.ddd.infrastructure.repository.json.JsonListCodec;
import com.summit.dp.shared.storage.H2Storage;
import com.summit.dp.user_configs.infrastructure.persistence.po.UserConfigPO;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.Ordered;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.core.env.MapPropertySource;

import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/**
 * 数据目录的启动期解析：设置行里的 {@code dataDir} 优先于 yaml 的 {@code lingxi.data.dir}。
 *
 * <p><b>为什么只能在这一步做</b>：库位置写在 {@code spring.datasource.url} 里，装配数据源时就定死了，
 * 等能拿到 Spring bean 再改已经来不及；只有「环境刚就绪、bean 还没建」这一刻改属性才有效。</p>
 *
 * <p>解析复用仓储同一个 {@link JsonListCodec}：配置文件格式只定义一处，避免这里另写一份解析而漂移。
 * 文件缺失或读坏一律当作「没配置」，回落到 yaml —— 配置读不出来不该让应用起不来。</p>
 */
@Slf4j
public class UserConfigDataDirPostProcessor implements EnvironmentPostProcessor, Ordered {

    private static final String CONFIG_PATH_KEY = "lingxi.config.user-configs.path";
    /** 设置行数据目录键：优先级最高。 */
    private static final String DATA_DIR_KEY = "lingxi.data.dir";

    private static final String DEFAULT_CONFIG_PATH = "${user.home}/.lingxi/config/user-configs.json";
    private static final String DEFAULT_DATA_DIR = "${user.home}/.lingxi/data";

    @Override
    public int getOrder() {
        // 必须晚于 application.yaml 的加载（ConfigData 那一步），否则读不到 lingxi.* 的缺省值。
        // 但必须早于 StorageStartupGuardPostProcessor（LOWEST_PRECEDENCE）：
        // 引擎要拿这里解析出的目录判数据形态，目录后解析就会判错目录。
        return Ordered.LOWEST_PRECEDENCE - 100;
    }

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        String configPath = resolveProperty(environment, CONFIG_PATH_KEY, DEFAULT_CONFIG_PATH);
        String dataDir = readConfiguredDataDir(configPath);
        if (dataDir == null) {
            return;
        }
        String currentDir = resolveProperty(environment, DATA_DIR_KEY, DEFAULT_DATA_DIR);
        if (dataDir.equals(currentDir)) {
            return;
        }
        // addFirst：设置页是唯一真源，命令行与 yaml 只算缺省。
        environment.getPropertySources().addFirst(
                new MapPropertySource("lingxiUserConfigDataDir", Map.of(DATA_DIR_KEY, dataDir)));
        log.info("数据目录取自设置行: dir={}", dataDir);
        warnWhenNoDatabase(dataDir);
    }

    /** 缺省值带占位符，必须自己 resolve —— PropertyResolver 只在「属性确实存在」时解析占位符。 */
    private String resolveProperty(ConfigurableEnvironment environment, String key, String fallback) {
        String value = environment.getProperty(key);
        if (value == null || value.isBlank()) {
            return environment.resolvePlaceholders(fallback);
        }
        return value.trim();
    }

    private String readConfiguredDataDir(String configPath) {
        try {
            Path path = Path.of(configPath);
            if (!Files.exists(path)) {
                return null;
            }
            List<UserConfigPO> rows = new JsonListCodec<>(UserConfigPO.class).read(path);
            return rows.stream()
                    .filter(row -> row != null && row.getDataDir() != null && !row.getDataDir().isBlank())
                    .map(row -> row.getDataDir().trim())
                    .filter(this::isUsablePath)
                    .findFirst()
                    .orElse(null);
        } catch (RuntimeException e) {
            log.warn("读取设置行里的数据目录失败，回落到配置项: path={}", configPath, e);
            return null;
        }
    }

    /** 非法路径当作「没配置」：启动期不该因为一行坏配置就把应用带崩。 */
    private boolean isUsablePath(String value) {
        try {
            Path.of(value);
            return true;
        } catch (InvalidPathException e) {
            log.warn("设置行里的数据目录不是合法路径，已忽略: dir={}", value);
            return false;
        }
    }

    private void warnWhenNoDatabase(String dataDir) {
        Path databaseFile = Path.of(dataDir).resolve(H2Storage.DATABASE_FILE_NAME);
        if (!Files.exists(databaseFile)) {
            log.warn("设置的数据目录缺少 H2 库，启动守卫将继续检查迁移状态: dir={}, expected={}",
                    dataDir, databaseFile.getFileName());
        }
    }
}
