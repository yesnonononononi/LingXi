package com.summit.dp.shared.storage;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * 存储引擎开关（{@code lingxi.storage.*}）。
 *
 * <p>缺省值是 {@link StorageEngine#SQLITE}：不写任何配置时，数据源 URL、驱动、连接池参数、
 * 分页方言、类型处理器、异常翻译全部与引入开关之前逐字一致。</p>
 */
@Component
@ConfigurationProperties(prefix = "lingxi.storage")
public class StorageEngineProperties {

    /** 生效引擎；缺省 SQLite。非法值由环境期守卫先行拦下并给出明确消息。 */
    private StorageEngine engine = StorageEngine.SQLITE;

    public StorageEngine getEngine() {
        return engine;
    }

    public void setEngine(StorageEngine engine) {
        this.engine = engine == null ? StorageEngine.SQLITE : engine;
    }

    /** 是否 H2；只供存储适配层分派用。 */
    public boolean isH2() {
        return engine == StorageEngine.H2;
    }
}
