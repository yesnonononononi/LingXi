package com.summit.dp.shared;

import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import com.summit.dp.shared.config.MybatisPlusConfig;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class MybatisPlusConfigTest {
    @Test
    void paginationAlwaysUsesH2() {
        PaginationInnerInterceptor pagination = (PaginationInnerInterceptor)
                new MybatisPlusConfig().mybatisPlusInterceptor().getInterceptors().getFirst();
        assertEquals(DbType.H2, pagination.getDbType());
    }
}
