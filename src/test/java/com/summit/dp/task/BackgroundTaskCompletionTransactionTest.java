package com.summit.dp.task;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.task.domain.model.Task;
import com.summit.dp.task.domain.model.Task.TaskStatus;
import com.summit.dp.task.domain.repository.TaskRepository;
import com.summit.dp.task.infrastructure.persistence.mapper.TaskMapper;
import com.summit.dp.task.infrastructure.repository.TaskRepositoryImpl;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.infrastructure.tools.terminal.backend.BackgroundTaskCompletion;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;
import org.springframework.test.context.junit.jupiter.SpringJUnitConfig;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.annotation.EnableTransactionManagement;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;

@SpringJUnitConfig(BackgroundTaskCompletionTransactionTest.Config.class)
class BackgroundTaskCompletionTransactionTest {
    @Autowired private TaskRepository repository;
    @Autowired private TaskMapper mapper;
    @Autowired private BackgroundTaskCompletion completion;
    @Autowired private ExecutionResumeCoordinator coordinator;

    @BeforeEach void resetState() {
        mapper.delete(null);
        reset(coordinator);
    }

    @Test void completionAndWakeRequestShareOneTransactionAndDispatchOccursAfterCommit() {
        Task task = task(100L);
        repository.save(task);
        task.finish(TaskStatus.FAILED, "failed", 7, false);
        AtomicBoolean dispatched = new AtomicBoolean();
        when(coordinator.accept(100L)).thenAnswer(invocation -> {
            assertTrue(TransactionSynchronizationManager.isActualTransactionActive());
            assertEquals(TaskStatus.FAILED, repository.findById(1L).orElseThrow().getStatus());
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override public void afterCommit() { dispatched.set(true); }
            });
            assertFalse(dispatched.get());
            return ResumeDisposition.QUEUED;
        });
        completion.save(task);
        assertTrue(dispatched.get());
        assertEquals(7, repository.findById(1L).orElseThrow().getExitCode());
        verify(coordinator).accept(100L);
    }

    @Test void wakeRequestFailureRollsBackTerminalStateSoWorkerCanRetryIt() {
        Task task = task(100L);
        repository.save(task);
        task.finish(TaskStatus.SUCCESS, "done", 0, false);
        when(coordinator.accept(100L)).thenThrow(new ClientException("保存恢复请求失败"));
        assertThrows(ClientException.class, () -> completion.save(task));
        assertEquals(TaskStatus.PENDING, repository.findById(1L).orElseThrow().getStatus());
        reset(coordinator);
        completion.save(task);
        assertEquals(TaskStatus.SUCCESS, repository.findById(1L).orElseThrow().getStatus());
        verify(coordinator).accept(100L);
    }

    @Test void legacyTasksAndIntermediateStatesDoNotInventWakeRecipients() {
        Task legacy = task(null);
        repository.save(legacy);
        legacy.finish(TaskStatus.LOST, "lost", null, false);
        completion.save(legacy);
        Task running = Task.builder().id(2L).sessionId(10L).turnId(20L).executionId(100L).command("running").build();
        repository.save(running);
        completion.save(running);
        verify(coordinator, never()).accept(anyLong());
    }

    private static Task task(Long executionId) {
        return Task.builder().id(1L).sessionId(10L).turnId(20L).executionId(executionId).command("command").build();
    }

    @Configuration
    @EnableTransactionManagement
    static class Config {
        @Bean(destroyMethod = "shutdown") EmbeddedDatabase database() {
            return new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.H2)
                    .setName("terminal-completion-" + UUID.randomUUID() + ";MODE=MySQL")
                    .addScript("file:./init.sql").build();
        }
        @Bean PlatformTransactionManager transactionManager(EmbeddedDatabase database) {
            return new DataSourceTransactionManager(database);
        }
        @Bean TaskMapper taskMapper(EmbeddedDatabase database) throws Exception {
            MybatisConfiguration configuration = new MybatisConfiguration();
            configuration.setMapUnderscoreToCamelCase(true);
            configuration.addMapper(TaskMapper.class);
            MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
            factory.setConfiguration(configuration);
            factory.setDataSource(database);
            return new SqlSessionTemplate(factory.getObject()).getMapper(TaskMapper.class);
        }
        @Bean TaskRepository repository(TaskMapper mapper) { return new TaskRepositoryImpl(mapper); }
        @Bean ExecutionResumeCoordinator coordinator() { return mock(ExecutionResumeCoordinator.class); }
        @Bean BackgroundTaskCompletion completion(TaskRepository repository, ExecutionResumeCoordinator coordinator) {
            return new BackgroundTaskCompletion(repository, coordinator);
        }
    }
}
