package com.summit.dp.shared.persistence;

import com.summit.dp.shared.persistence.handler.InstantTextTypeHandler;
import com.summit.dp.shared.persistence.handler.LocalDateTimeTextTypeHandler;
import org.apache.ibatis.session.Configuration;

/**
 * 时间类型处理器的统一登记处。
 *
 * <p>生产的 SqlSessionFactory 由 yaml 的 {@code mybatis-plus.type-handlers-package} 扫描登记；
 * 测试里手搓 {@link Configuration} 的地方（没有 Spring 就没有扫描）必须显式调用本类，
 * 否则 Instant / LocalDateTime 会落回 MyBatis 内置处理器，在 SQLite 上直接抛解析错误。</p>
 */
public final class MyBatisTypeHandlers {

    private MyBatisTypeHandlers() {
    }

    /** 登记全部自定义处理器；重复调用幂等。 */
    public static void registerAll(Configuration configuration) {
        if (configuration == null) {
            return;
        }
        configuration.getTypeHandlerRegistry().register(InstantTextTypeHandler.class);
        configuration.getTypeHandlerRegistry().register(LocalDateTimeTextTypeHandler.class);
    }
}
