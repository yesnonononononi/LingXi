package com.summit.dp.shared.persistence;

import com.summit.dp.shared.persistence.handler.LargeTextTypeHandler;
import com.summit.dp.shared.persistence.handler.h2.H2InstantTypeHandler;
import com.summit.dp.shared.persistence.handler.h2.H2LocalDateTimeTypeHandler;
import org.apache.ibatis.session.Configuration;

/** 手工创建的测试工厂也必须使用生产的 UTC 时间与大文本处理器。 */
public final class MyBatisTypeHandlers {
    private MyBatisTypeHandlers() {
    }

    public static void registerAll(Configuration configuration) {
        if (configuration == null) {
            return;
        }
        configuration.getTypeHandlerRegistry().register(LargeTextTypeHandler.class);
        configuration.getTypeHandlerRegistry().register(H2InstantTypeHandler.class);
        configuration.getTypeHandlerRegistry().register(H2LocalDateTimeTypeHandler.class);
    }
}
