package com.summit.dp.shared.config;

import com.summit.dp.shared.persistence.H2ExceptionTranslator;
import org.apache.ibatis.session.ExecutorType;
import org.apache.ibatis.session.SqlSessionFactory;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import javax.sql.DataSource;

/** 约束与锁冲突必须被正确分类，业务幂等与事务重试才能生效。 */
@Configuration
public class StoragePersistenceConfig {
    @Bean
    public SqlSessionTemplate sqlSessionTemplate(SqlSessionFactory factory, DataSource dataSource) {
        return new SqlSessionTemplate(factory, ExecutorType.SIMPLE, new H2ExceptionTranslator(dataSource));
    }
}
