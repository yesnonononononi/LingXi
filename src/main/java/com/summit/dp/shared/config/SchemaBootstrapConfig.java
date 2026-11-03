package com.summit.dp.shared.config;

import com.summit.dp.shared.persistence.schema.SchemaInitializer;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;

import javax.sql.DataSource;

/** 建库必须先于其他启动任务，避免业务读取尚未初始化的表。 */
@Slf4j
@Configuration
public class SchemaBootstrapConfig {

    @Bean
    public SchemaInitializer schemaInitializer() {
        return new H2SchemaInitializer();
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
