package com.summit.dp.checklist.support;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.ChecklistReminderOwnership;
import com.summit.dp.checklist.application.service.impl.ChecklistServiceImpl;
import com.summit.dp.checklist.infrastructure.persistence.mapper.ChecklistMapper;
import com.summit.dp.checklist.infrastructure.persistence.mapper.ChecklistStepMapper;
import com.summit.dp.checklist.infrastructure.repository.ChecklistRepositoryImpl;
import com.summit.dp.shared.config.H2SchemaInitializer;
import org.springframework.boot.DefaultApplicationArguments;
import org.apache.ibatis.session.SqlSessionFactory;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.UUID;
import java.util.List;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.mockito.ArgumentMatchers.any;

/** 使用生产建表脚本及事务代理，避免自动提交掩盖聚合锁与回滚缺陷。 */
public final class ChecklistTestDatabase implements AutoCloseable {

    private final EmbeddedDatabase database;
    private final ChecklistMapper mapper;
    private final ChecklistRepositoryImpl repository;
    private final ChecklistService service;
    private final DataSourceTransactionManager transactionManager;
    private final ExecutionQueryService executionQueries;

    private ChecklistTestDatabase(EmbeddedDatabase database, ChecklistMapper mapper,
                                 ChecklistRepositoryImpl repository, ChecklistService service,
                                 DataSourceTransactionManager transactionManager, ExecutionQueryService executionQueries) {
        this.database = database;
        this.mapper = mapper;
        this.repository = repository;
        this.service = service;
        this.transactionManager = transactionManager;
        this.executionQueries = executionQueries;
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
            DataSourceTransactionManager transactionManager = new DataSourceTransactionManager(database);
            ExecutionQueryService executionQueries = mock(ExecutionQueryService.class);
            when(executionQueries.activeBySession(any())).thenReturn(List.of());
            ChecklistService service = transactionalService(new ChecklistServiceImpl(repository,
                    new ChecklistReminderOwnership(executionQueries)), transactionManager);
            return new ChecklistTestDatabase(database, mapper, repository, service, transactionManager, executionQueries);
        } catch (Exception e) {
            throw new IllegalStateException("清单测试库启动失败", e);
        }
    }

    public ChecklistMapper mapper() {
        return mapper;
    }

    public void bootstrapSchema() throws Exception {
        new H2SchemaInitializer().h2SchemaBootstrap(database).run(new DefaultApplicationArguments());
    }

    public ChecklistRepositoryImpl repository() {
        return repository;
    }

    public ChecklistService service() {
        return service;
    }

    public ChecklistService serviceWithRepository(ChecklistRepositoryImpl replacement) {
        return transactionalService(new ChecklistServiceImpl(replacement,
                new ChecklistReminderOwnership(executionQueries)), transactionManager);
    }

    public TransactionTemplate transaction() {
        return new TransactionTemplate(transactionManager);
    }

    public ExecutionQueryService executionQueries() {
        return executionQueries;
    }

    private static ChecklistService transactionalService(ChecklistService target,
                                                         DataSourceTransactionManager transactionManager) {
        TransactionInterceptor interceptor = new TransactionInterceptor();
        interceptor.setTransactionManager(transactionManager);
        interceptor.setTransactionAttributeSource(new AnnotationTransactionAttributeSource());
        ProxyFactory proxy = new ProxyFactory(target);
        proxy.addAdvice(interceptor);
        return (ChecklistService) proxy.getProxy();
    }

    @Override
    public void close() {
        database.shutdown();
    }
}
