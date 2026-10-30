package com.summit.dp.shared.config;

import com.summit.dp.shared.persistence.SqliteExceptionTranslator;
import org.apache.ibatis.session.ExecutorType;
import org.apache.ibatis.session.SqlSessionFactory;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;

/**
 * SQLite 持久化装配。
 *
 * <p>覆盖 MyBatis-Plus 自动装配的 {@code sqlSessionTemplate}（它带
 * {@code @ConditionalOnMissingBean}），只为挂上 SQLite 的异常翻译：
 * 约束冲突必须落成 {@code DuplicateKeyException} / {@code DataIntegrityViolationException}，
 * 否则业务侧靠捕获这两个异常实现的「只投一次」「只受理一次」会静默失效。</p>
 */
@Configuration
public class SqlitePersistenceConfig {

    @Bean
    public SqlSessionTemplate sqlSessionTemplate(SqlSessionFactory sqlSessionFactory, DataSource dataSource) {
        return new SqlSessionTemplate(sqlSessionFactory, ExecutorType.SIMPLE,
                new SqliteExceptionTranslator(dataSource));
    }
}
