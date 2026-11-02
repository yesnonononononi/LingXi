package com.summit.dp.checklist.support;

import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.checklist.application.ChecklistReminderOwnership;
import com.summit.dp.checklist.application.ChecklistService;
import com.summit.dp.checklist.application.service.impl.ChecklistServiceImpl;
import com.summit.dp.checklist.infrastructure.persistence.mapper.ChecklistMapper;
import com.summit.dp.checklist.infrastructure.persistence.mapper.ChecklistStepMapper;
import com.summit.dp.checklist.infrastructure.repository.ChecklistRepositoryImpl;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.shared.persistence.MyBatisTypeHandlers;
import com.summit.dp.shared.support.H2TestDatabase;
import org.apache.ibatis.session.SqlSessionFactory;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/** 使用生产建表脚本及事务代理，避免自动提交掩盖聚合锁与回滚缺陷。 */
public final class ChecklistTestDatabase implements AutoCloseable {

    private final H2TestDatabase database;
    private final ChecklistMapper mapper;
    private final ChecklistRepositoryImpl repository;
    private final ChecklistService service;
    private final DataSourceTransactionManager transactionManager;
    private final ExecutionQueryService executionQueries;

    private ChecklistTestDatabase(H2TestDatabase database, ChecklistMapper mapper,
                                 ChecklistRepositoryImpl repository, ChecklistService service,
                                 DataSourceTransactionManager transactionManager, ExecutionQueryService executionQueries) {
        this.database = database;
        this.mapper = mapper;
        this.repository = repository;
        this.service = service;
        this.transactionManager = transactionManager;
        this.executionQueries = executionQueries;
    }

    /** 独立 H2 文件库避免不同用例互相污染锁与唯一索引。 */
    public static ChecklistTestDatabase start(String namePrefix) {
        try {
            H2TestDatabase database = H2TestDatabase.create(namePrefix);
            MybatisConfiguration configuration = new MybatisConfiguration();
            configuration.setMapUnderscoreToCamelCase(true);

            MyBatisTypeHandlers.registerAll(configuration);
            configuration.addMapper(ChecklistMapper.class);
            configuration.addMapper(ChecklistStepMapper.class);
            MybatisPlusInterceptor plugins = new MybatisPlusInterceptor();
            plugins.addInnerInterceptor(new PaginationInnerInterceptor(DbType.H2));
            MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
            factory.setDataSource(database);
            factory.setConfiguration(configuration);
            factory.setPlugins(plugins);
            SqlSessionFactory sessionFactory = factory.getObject();
            SqlSessionTemplate template = H2TestDatabase.sqlSession(sessionFactory);
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
