package com.summit.dp.shared.config;

import com.summit.dp.shared.persistence.H2ExceptionTranslator;
import com.summit.dp.shared.persistence.SqliteExceptionTranslator;
import com.summit.dp.shared.storage.StorageEngineProperties;
import org.apache.ibatis.session.ExecutorType;
import org.apache.ibatis.session.SqlSessionFactory;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.dao.support.PersistenceExceptionTranslator;

import javax.sql.DataSource;

/**
 * 持久化装配：按引擎挂对应的 JDBC 异常翻译。
 *
 * <p>覆盖 MyBatis-Plus 自动装配的 {@code sqlSessionTemplate}（它带
 * {@code @ConditionalOnMissingBean}），只为挂上异常翻译：约束冲突必须落成
 * {@code DuplicateKeyException} / {@code DataIntegrityViolationException}，
 * 锁冲突必须落成 {@code CannotAcquireLockException}，否则业务侧靠捕获这些异常实现的
 * 「只投一次」「只受理一次」「冲突换事务重试」会静默失效。</p>
 *
 * <p>两个引擎的错误码体系完全不同（SQLite 是 {@code SQLITE_CONSTRAINT=19} 且 SQLState 为空，
 * H2 是 {@code 23505/50200/40001} 且 SQLState 有值），因此翻译器也按引擎分派，
 * 不能共用一个「猜错误码」的实现。</p>
 */
@Configuration
public class StoragePersistenceConfig {

    /**
     * @param sqlSessionFactory MyBatis-Plus 建好的工厂
     * @param dataSource        同一个库的数据源（兜底翻译器要用它分类错误）
     * @param properties        存储引擎开关（缺省 SQLite）
     * @return 挂了对应异常翻译的 SqlSessionTemplate
     */
    @Bean
    public SqlSessionTemplate sqlSessionTemplate(SqlSessionFactory sqlSessionFactory, DataSource dataSource,
                                                StorageEngineProperties properties) {
        PersistenceExceptionTranslator translator = properties != null && properties.isH2()
                ? new H2ExceptionTranslator(dataSource)
                : new SqliteExceptionTranslator(dataSource);
        return new SqlSessionTemplate(sqlSessionFactory, ExecutorType.SIMPLE, translator);
    }
}
