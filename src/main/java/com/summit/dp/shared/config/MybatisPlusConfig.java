package com.summit.dp.shared.config;

import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import com.summit.dp.shared.storage.StorageEngine;
import com.summit.dp.shared.storage.StorageEngineProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * MyBatis-Plus 插件配置。
 * <p>注册分页内核拦截器，使 {@code BaseMapper#selectPage} 真正生效（SQL 追加 LIMIT 并回填 total）。
 * 缺失该配置时 selectPage 不发 COUNT 也不追加 LIMIT，表现为 total=0 且全量返回。</p>
 */
@Configuration
public class MybatisPlusConfig {

    /**
     * 分页方言由存储引擎开关决定：{@link StorageEngine#SQLITE} → {@code DbType.SQLITE}，
     * {@link StorageEngine#H2} → {@code DbType.H2}。分页插件据此生成 {@code LIMIT ? OFFSET ?} 并回填 total。
     *
     * <p>刻意不做自动探测：方言配错时分页会静默返回错误结果，显式按开关选择让「换库忘了改」在启动期就炸出来，
     * 而不是等到某次分页查询数据不对。</p>
     *
     * @param properties 存储引擎开关（缺省 SQLite）
     * @return 已装配分页拦截器的 MyBatis-Plus 插件集合
     */
    @Bean
    public MybatisPlusInterceptor mybatisPlusInterceptor(StorageEngineProperties properties) {
        StorageEngine engine = properties == null ? StorageEngine.SQLITE : properties.getEngine();
        DbType dbType = engine.isH2() ? DbType.H2 : DbType.SQLITE;
        MybatisPlusInterceptor interceptor = new MybatisPlusInterceptor();
        interceptor.addInnerInterceptor(new PaginationInnerInterceptor(dbType));
        return interceptor;
    }
}
