package com.summit.dp.shared;

import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import com.summit.dp.shared.config.MybatisPlusConfig;
import com.summit.dp.shared.storage.StorageEngine;
import com.summit.dp.shared.storage.StorageEngineProperties;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 分页方言必须跟着存储引擎开关走（设计 §附录D.2 的 M5）。
 *
 * <p><b>为什么这条断言值钱</b>：方言配错不会报错，只会让 {@code selectPage} 生成错误的
 * 分页 SQL（H2 上拿到错的总数或错的行），属于「静默返回错数据」那一类缺陷 ——
 * 只能靠「配置与开关一致」这条断言在测试期钉住，靠人工发现太晚。</p>
 */
class MybatisPlusConfigTest {

    @Test
    @DisplayName("engine=h2 → 分页方言 DbType.H2；engine=sqlite / 未配置 → DbType.SQLITE")
    void paginationDialectFollowsEngineSwitch() {
        assertEquals(DbType.H2, dialectOf(engine(StorageEngine.H2)),
                "H2 引擎下分页方言必须是 DbType.H2（写死 SQLITE 会生成 SQLite 分页语法）");
        assertEquals(DbType.SQLITE, dialectOf(engine(StorageEngine.SQLITE)),
                "默认引擎下分页方言必须仍是 DbType.SQLITE（默认行为逐字不变）");
        assertEquals(DbType.SQLITE, dialectOf(null),
                "没有开关 Bean 时必须回落 SQLITE，不能抛空指针");
    }

    private static StorageEngineProperties engine(StorageEngine engine) {
        StorageEngineProperties properties = new StorageEngineProperties();
        properties.setEngine(engine);
        return properties;
    }

    private static DbType dialectOf(StorageEngineProperties properties) {
        MybatisPlusInterceptor interceptor = new MybatisPlusConfig().mybatisPlusInterceptor(properties);
        List<com.baomidou.mybatisplus.extension.plugins.inner.InnerInterceptor> interceptors =
                interceptor.getInterceptors();
        assertEquals(1, interceptors.size(), "必须恰好注册一个分页拦截器");
        assertTrue(interceptors.get(0) instanceof PaginationInnerInterceptor,
                "注册的拦截器必须是分页拦截器，实际=" + interceptors.get(0).getClass().getName());
        return ((PaginationInnerInterceptor) interceptors.get(0)).getDbType();
    }
}
