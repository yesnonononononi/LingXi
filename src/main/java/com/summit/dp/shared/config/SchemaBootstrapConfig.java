package com.summit.dp.shared.config;

import com.summit.dp.shared.persistence.schema.SchemaInitializer;
import com.summit.dp.shared.storage.StorageEngineProperties;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;

import javax.sql.DataSource;

/**
 * 建库装配：按引擎挑一个 {@link SchemaInitializer}，并且只跑一次。
 *
 * <p><b>为什么把 runner 收拢到这里</b>：以前 runner 挂在 SQLite 初始化器自己的 {@code @Configuration} 上，
 * 「谁负责建库」和「怎么建库」绑死在一个类里；引擎一旦可选，就必须有一个与引擎无关的装配点，
 * 否则 H2 与 SQLite 会各自注册一个 runner，谁先跑取决于 bean 名排序。</p>
 */
@Slf4j
@Configuration
public class SchemaBootstrapConfig {

    /**
     * 按引擎装配唯一的建库实现。
     *
     * @param properties 存储引擎开关
     * @return 与生效引擎一致的初始化器
     */
    @Bean
    public SchemaInitializer schemaInitializer(StorageEngineProperties properties) {
        if (properties.isH2()) {
            // H2 基线脚本与初始化器在 T02 落地；此处显式失败而不是回落到 SQLite 建库脚本，
            // 避免「引擎是 h2 却用 SQLite 方言建库」这种更难排查的状态。
            throw new IllegalStateException("lingxi.storage.engine=h2 的建库脚本尚未就绪（db/h2/V1__schema.sql）");
        }
        return new SqliteSchemaInitializer();
    }

    /**
     * 启动期建库：最高优先级，任何依赖数据库的 bean 之后才轮到别的 runner。
     *
     * @param schemaInitializer 唯一建库实现
     * @param dataSource        目标库
     * @return 执行建库的 runner
     */
    @Bean
    @Order(Ordered.HIGHEST_PRECEDENCE)
    public ApplicationRunner schemaBootstrap(SchemaInitializer schemaInitializer, DataSource dataSource) {
        return args -> {
            int executed = schemaInitializer.initialize(dataSource);
            log.info("建库检查完成: engine={}, executed={}", schemaInitializer.engineId(), executed);
        };
    }
}
