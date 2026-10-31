package com.summit.dp.shared.persistence;

import com.summit.dp.shared.persistence.handler.LargeTextTypeHandler;
import com.summit.dp.shared.persistence.handler.h2.H2InstantTypeHandler;
import com.summit.dp.shared.persistence.handler.h2.H2LocalDateTimeTypeHandler;
import com.summit.dp.shared.persistence.handler.sqlite.InstantTextTypeHandler;
import com.summit.dp.shared.persistence.handler.sqlite.LocalDateTimeTextTypeHandler;
import com.summit.dp.shared.storage.StorageEngine;
import org.apache.ibatis.session.Configuration;

/**
 * 类型处理器的统一登记处：公共处理器 + 按引擎分派的时间处理器。
 *
 * <p>生产的 SqlSessionFactory 由 yaml 的 {@code mybatis-plus.type-handlers-package} 扫描登记，
 * 而该值在环境期会被收窄成生效引擎的包（{@code handler.sqlite} / {@code handler.h2}）——
 * 因为 MyBatis 的包扫描是递归的，不收窄就会把两个引擎的 {@code Instant} 处理器同时登记，
 * 谁生效取决于扫描顺序。测试里手搓 {@link Configuration} 的地方（没有 Spring 就没有扫描）
 * 必须显式调用本类，并明确传入引擎。</p>
 */
public final class MyBatisTypeHandlers {

    private MyBatisTypeHandlers() {
    }

    /**
     * 按 SQLite 登记（等价于 {@code registerAll(configuration, StorageEngine.SQLITE)}）。
     *
     * <p>保留这个单参重载是为了不改动既有的 180+ 处测试调用点；这些调用点全都在 SQLite 文件库上跑。</p>
     *
     * @param configuration MyBatis 配置
     */
    public static void registerAll(Configuration configuration) {
        registerAll(configuration, StorageEngine.SQLITE);
    }

    /**
     * 登记公共处理器 + 指定引擎的时间处理器；重复调用幂等。
     *
     * @param configuration MyBatis 配置，可为 {@code null}（此时什么都不做）
     * @param engine        生效引擎；{@code null} 视为 SQLite
     */
    public static void registerAll(Configuration configuration, StorageEngine engine) {
        if (configuration == null) {
            return;
        }
        StorageEngine effective = engine == null ? StorageEngine.SQLITE : engine;
        // 大文本处理器只注册「String + CLOB」这一个组合，不会抢走普通 VARCHAR 列。
        configuration.getTypeHandlerRegistry().register(LargeTextTypeHandler.class);
        if (effective.isH2()) {
            configuration.getTypeHandlerRegistry().register(H2InstantTypeHandler.class);
            configuration.getTypeHandlerRegistry().register(H2LocalDateTimeTypeHandler.class);
            return;
        }
        configuration.getTypeHandlerRegistry().register(InstantTextTypeHandler.class);
        configuration.getTypeHandlerRegistry().register(LocalDateTimeTextTypeHandler.class);
    }
}
