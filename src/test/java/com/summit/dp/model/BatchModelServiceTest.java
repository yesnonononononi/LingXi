package com.summit.dp.model;

import com.summit.dp.model.Infrastructure.persistence.mapper.ModelConfigMapper;
import com.summit.dp.model.Infrastructure.repo.ModelConfigRepositoryImpl;
import com.summit.dp.model.application.command.BatchModelCommand;
import com.summit.dp.model.application.service.BatchModelService;
import com.summit.dp.model.application.vo.BatchModelResult;
import com.summit.dp.model.domain.model.ModelConfig;
import com.summit.dp.provider.application.service.ProviderConfigService;
import com.summit.dp.provider.application.vo.ProviderConfigVO;
import com.summit.dp.shared.exception.ClientException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.aop.framework.ProxyFactory;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;
import org.springframework.transaction.annotation.AnnotationTransactionAttributeSource;
import org.springframework.transaction.interceptor.TransactionInterceptor;

import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class BatchModelServiceTest {
    @TempDir Path directory;

    @Test
    void copiesProviderConnectionAndDeduplicatesWithoutTouchingOtherProviders() {
        ModelConfigRepositoryImpl repository = repository();
        repository.save(new ModelConfig(null, "https://old.invalid", "old", "existing", null, 7L, false));
        repository.save(new ModelConfig(null, "https://other.invalid", "other", "new", null, 8L, false));
        BatchModelService service = new BatchModelService(repository, providers());
        BatchModelResult result = service.add(new BatchModelCommand(7L, List.of("existing", " new ", "new", "another"), false));
        assertEquals(2, result.addedCount());
        assertEquals(List.of("existing"), result.skippedNames());
        List<ModelConfig> added = repository.findAll().stream().filter(model -> "saved-secret".equals(model.getApiKey())).toList();
        assertEquals(2, added.size());
        assertTrue(added.stream().allMatch(model -> model.getProviderConfigId().equals(7L)
                && model.getBaseUrl().equals("https://provider.invalid/v1") && !model.isVision()));
        assertThrows(ClientException.class, () -> service.add(new BatchModelCommand(7L, List.of("valid", " "), false)));
        assertEquals(4, repository.findAll().size());
    }

    @Test
    void realTransactionRollsBackEarlierWritesAndSerializesConcurrentBatches() throws Exception {
        EmbeddedDatabase database = new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2).build();
        ExecutorService executor = Executors.newFixedThreadPool(2);
        try {
            ModelConfigRepositoryImpl repository = spy(repository());
            ProxyFactory factory = new ProxyFactory(new BatchModelService(repository, providers()));
            factory.setProxyTargetClass(true);
            factory.addAdvice(new TransactionInterceptor(new DataSourceTransactionManager(database), new AnnotationTransactionAttributeSource()));
            BatchModelService service = (BatchModelService) factory.getProxy();
            doAnswer(invocation -> {
                ModelConfig model = invocation.getArgument(0);
                if (model.getModelName().equals("fail")) throw new IllegalStateException("模拟写入失败");
                return invocation.callRealMethod();
            }).when(repository).save(any(ModelConfig.class));
            assertThrows(IllegalStateException.class, () -> service.add(new BatchModelCommand(7L, List.of("first", "fail"), false)));
            assertTrue(repository.findAll().isEmpty());
            Future<BatchModelResult> first = executor.submit(() -> service.add(new BatchModelCommand(7L, List.of("same"), false)));
            Future<BatchModelResult> second = executor.submit(() -> service.add(new BatchModelCommand(7L, List.of("same"), false)));
            assertEquals(1, first.get().addedCount() + second.get().addedCount());
            assertEquals(1, repository.findAll().size());
            assertEquals(1, repository().findAll().size());
        } finally {
            executor.shutdownNow();
            database.shutdown();
        }
    }

    private ModelConfigRepositoryImpl repository() {
        ModelConfigMapper mapper = mock(ModelConfigMapper.class);
        when(mapper.selectList(any())).thenReturn(List.of());
        return new ModelConfigRepositoryImpl(mapper, directory.resolve("models.json").toString());
    }

    private ProviderConfigService providers() {
        ProviderConfigService service = mock(ProviderConfigService.class);
        when(service.findAllViews()).thenReturn(List.of(ProviderConfigVO.builder().id(7L).name("提供商")
                .baseUrl("https://provider.invalid/v1").build()));
        when(service.findApiKey(7L)).thenReturn(Optional.of("saved-secret"));
        return service;
    }
}
