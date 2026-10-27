package com.summit.dp.checklist.support;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.service.impl.ChecklistServiceImpl;
import com.summit.dp.checklist.infrastructure.persistence.mapper.ChecklistMapper;
import com.summit.dp.checklist.infrastructure.persistence.mapper.ChecklistStepMapper;
import com.summit.dp.checklist.infrastructure.repository.ChecklistRepositoryImpl;
import org.apache.ibatis.session.SqlSessionFactory;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;

import java.util.UUID;

/**
 * 清单测试夹具：真 H2（MODE=MySQL）+ 仓库根 init.sql + 真 Mapper + 真服务。
 *
 * <p>刻意不用 Spring 容器也不需要手工建表脚本：建表走的就是生产那份 init.sql，
 * 这样「派生列 + 唯一索引真的存在」才有意义——测试自建 schema 恰好会掩盖这类差异。</p>
 *
 * <p>事务边界没有代理：服务上的 {@code @Transactional} 在裸 new 的情况下不生效，
 * 而这正好用来观察单条语句的原子性（CAS 影响行数、唯一索引冲突）。</p>
 */
public final class ChecklistTestDatabase implements AutoCloseable {

    private final EmbeddedDatabase database;
    private final ChecklistMapper mapper;
    private final ChecklistRepositoryImpl repository;
    private final ChecklistService service;

    private ChecklistTestDatabase(EmbeddedDatabase database, ChecklistMapper mapper,
                                 ChecklistRepositoryImpl repository, ChecklistService service) {
        this.database = database;
        this.mapper = mapper;
        this.repository = repository;
        this.service = service;
    }

    /** 起一个独立内存库，避免用例之间互相污染唯一索引。 */
    public static ChecklistTestDatabase start(String namePrefix) {
        try {
            EmbeddedDatabase database = new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.H2)
                    .setName(namePrefix + "-" + UUID.randomUUID() + ";MODE=MySQL;DB_CLOSE_DELAY=-1")
                    .addScript("file:./init.sql").build();
            MybatisConfiguration configuration = new MybatisConfiguration();
            configuration.setMapUnderscoreToCamelCase(true);
            configuration.addMapper(ChecklistMapper.class);
            configuration.addMapper(ChecklistStepMapper.class);
            MybatisPlusInterceptor plugins = new MybatisPlusInterceptor();
            plugins.addInnerInterceptor(new PaginationInnerInterceptor());
            MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
            factory.setDataSource(database);
            factory.setConfiguration(configuration);
            factory.setPlugins(plugins);
            SqlSessionFactory sessionFactory = factory.getObject();
            SqlSessionTemplate template = new SqlSessionTemplate(sessionFactory);
            ChecklistMapper mapper = template.getMapper(ChecklistMapper.class);
            ChecklistRepositoryImpl repository = new ChecklistRepositoryImpl(mapper,
                    template.getMapper(ChecklistStepMapper.class));
            return new ChecklistTestDatabase(database, mapper, repository, new ChecklistServiceImpl(repository));
        } catch (Exception e) {
            throw new IllegalStateException("清单测试库启动失败", e);
        }
    }

    public ChecklistMapper mapper() {
        return mapper;
    }

    public ChecklistRepositoryImpl repository() {
        return repository;
    }

    public ChecklistService service() {
        return service;
    }

    @Override
    public void close() {
        database.shutdown();
    }
}
