package com.summit.dp.shared.config;

import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
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
     * 分页方言固定 H2 —— 库只有这一种，且 LIMIT 语法与 MySQL 一致，业务无感。
     *
     * <p>刻意不做自动探测：方言配错时分页会静默返回错误结果，显式写死让
     * 「换库忘了改」在启动期就炸出来，而不是等到某次分页查询数据不对。</p>
     */
    @Bean
    public MybatisPlusInterceptor mybatisPlusInterceptor() {
        MybatisPlusInterceptor interceptor = new MybatisPlusInterceptor();
        interceptor.addInnerInterceptor(new PaginationInnerInterceptor(DbType.H2));
        return interceptor;
    }
}
