package com.summit.dp.shared.storage;

import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.env.EnvironmentPostProcessor;
import org.springframework.core.Ordered;
import org.springframework.core.env.ConfigurableEnvironment;
import org.springframework.util.ClassUtils;

import java.nio.file.InvalidPathException;
import java.nio.file.Path;

/**
 * 存储引擎的启动期解析：读开关 → 校验数据形态 → 按引擎覆写数据源属性。
 *
 * <p><b>为什么必须在环境期做</b>：库位置与驱动写在 {@code spring.datasource.*} 里，
 * 装配连接池那一刻就定死了；只有「环境刚就绪、Bean 还没建」这一步改属性才有效。
 * 这与 {@code UserConfigDataDirPostProcessor} 是同一套机制，区别只在执行顺序：
 * 数据目录必须先被解析出来（它优先级更高，order 更小 100），这里才能据它判形态。</p>
 *
 * <p><b>sqlite 分支刻意什么都不写</b>：yaml 里的 SQLite URL/驱动/池参数原样生效，
 * 从而保证「不设开关时启动行为与引入开关之前逐字一致」。</p>
 */
@Slf4j
public class StorageEngineEnvironmentPostProcessor implements EnvironmentPostProcessor, Ordered {

    /** 引擎开关键；缺省视为 sqlite。 */
    public static final String ENGINE_KEY = "lingxi.storage.engine";

    private static final String DATA_DIR_KEY = "lingxi.data.dir";

    private static final String DEFAULT_DATA_DIR = "${user.home}/.lingxi/data";

    @Override
    public int getOrder() {
        // 必须排在任何"选数据目录"的后处理器之后：目录先行，引擎再从目录判形态。
        return Ordered.LOWEST_PRECEDENCE;
    }

    @Override
    public void postProcessEnvironment(ConfigurableEnvironment environment, SpringApplication application) {
        StorageEngineProperties properties = new StorageEngineProperties();
        properties.setEngine(StorageEngine.fromProperty(environment.getProperty(ENGINE_KEY)));
        StorageEngine engine = properties.getEngine();
        StorageLayout layout = new StorageLayout(resolveDataDir(environment), engine);
        boolean driverPresent = ClassUtils.isPresent(engine.driverClassName(), null);
        // 校验矩阵的唯一实现点：不可启动直接抛错，进程退出，不创建任何库文件。
        new StorageEngineGuard().requireStartable(layout, engine, driverPresent);
        if (engine.isH2()) {
            StorageDataSourceKeys.applyH2(environment, layout);
            log.info("存储引擎=h2，数据源已覆写为 H2 文件库: url={}", StorageDataSourceKeys.h2Url(layout));
            return;
        }
        log.debug("存储引擎=sqlite，数据源沿用配置里的缺省值: dir={}", layout.dataDir());
    }

    /** 数据目录：yaml/命令行/环境变量都可能给值，占位符必须自己 resolve。 */
    private Path resolveDataDir(ConfigurableEnvironment environment) {
        String raw = environment.getProperty(DATA_DIR_KEY);
        String resolved = raw == null || raw.isBlank()
                ? environment.resolvePlaceholders(DEFAULT_DATA_DIR)
                : environment.resolvePlaceholders(raw).trim();
        try {
            return Path.of(resolved);
        } catch (InvalidPathException e) {
            throw new IllegalStateException("数据目录不是合法路径，应用拒绝启动: " + DATA_DIR_KEY
                    + "=" + resolved, e);
        }
    }

    /**
     * 驱动是否在 classpath 上。
     *
     * <p>用 {@code ClassUtils.isPresent}（不触发类初始化）：只要 jar 在，算子就成立；
     * 缺驱动时 {@link StorageEngineGuard} 会给「缺哪个 jar」的明确提示，而不是等到建连接才炸。</p>
     *
     * @param engine 生效引擎
     * @return {@code true} 表示驱动类可加载
     */
    public static boolean isDriverPresent(StorageEngine engine) {
        return engine != null && ClassUtils.isPresent(engine.driverClassName(), null);
    }
}
