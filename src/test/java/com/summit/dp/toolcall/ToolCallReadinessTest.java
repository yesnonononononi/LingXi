package com.summit.dp.toolcall;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.Execution;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.execution.domain.lifecycle.ExecutionActivity;
import com.summit.dp.execution.domain.lifecycle.ExecutionCoordination;
import com.summit.dp.shared.event.ToolCallEventPublisher;
import com.summit.dp.stream.application.service.EventStreamPublisher;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.ToolCallReadinessService;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.infrastructure.persistence.mapper.ToolCallMapper;
import com.summit.dp.toolcall.infrastructure.persistence.repository.ToolCallRepositoryImpl;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;

class ToolCallReadinessTest {
    private EmbeddedDatabase database;
    private ToolCallRepositoryImpl tools;
    private ToolCallReadinessService readiness;
    private final ExecutionRepository executions = mock(ExecutionRepository.class);
    private final ExecutionActivity activity = mock(ExecutionActivity.class);
    private final ToolCallEventPublisher events = mock(ToolCallEventPublisher.class);
    private final Execution execution = Execution.builder().id("11").agentId("test")
            .agentRequest(AgentRequest.builder().executionId("11").build())
            .executionState(ExecutionState.SUSPENDED).build();

    @BeforeEach
    void setup() throws Exception {
        database = new EmbeddedDatabaseBuilder().generateUniqueName(true).setType(EmbeddedDatabaseType.H2)
                .addScript("tool-call-schema.sql").build();
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(true);
        configuration.addMapper(ToolCallMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        tools = new ToolCallRepositoryImpl(
                new SqlSessionTemplate(factory.getObject()).getMapper(ToolCallMapper.class),
                new ObjectMapper(), ToolCallPersistenceTest.buildCardAvailabilityPolicy());
        ExecutionIdentity identity = mock(ExecutionIdentity.class);
        when(identity.resolveRootSessionId(1L)).thenReturn(1L);
        when(executions.findById("11")).thenReturn(Optional.of(execution));
        doAnswer(invocation -> {
            Runnable notification = invocation.getArgument(0);
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override public void afterCommit() { notification.run(); }
            });
            return null;
        }).when(executions).afterCommit(any());
        readiness = new ToolCallReadinessService(tools, new ToolCallConverter(new ObjectMapper()), identity, events,
                new TransactionTemplate(new DataSourceTransactionManager(database)), provider(executions), provider(activity),
                provider((EventStreamPublisher) null));
    }

    @AfterEach
    void shutdown() { database.shutdown(); }

    @Test
    void preparingStaysClosedUntilSuspendedCheckpointAndSignalRelease() {
        tools.save(preparing("call_plan", "PLAN"));
        execution.setExecutionState(ExecutionState.RUNNING);
        readiness.markReady("11");
        assertEquals(ToolCallStatus.PREPARING, tools.findById("call_plan").orElseThrow().getStatus());
        execution.setExecutionState(ExecutionState.SUSPENDED);
        when(activity.isActive("11")).thenReturn(true);
        readiness.markReady("11");
        verifyNoInteractions(events);
        when(activity.isActive("11")).thenReturn(false);
        readiness.markReady("11");
        ToolCall ready = tools.findById("call_plan").orElseThrow();
        assertEquals(ToolCallStatus.PENDING, ready.getStatus());
        assertEquals(2L, ready.getVersion());
        verify(events).publish(anyLong(), any());
    }

    @Test
    void publicationObservesCommittedStateAndFailureDoesNotRollbackReadiness() {
        tools.save(preparing("call_plan", "PLAN"));
        doAnswer(invocation -> {
            try (ExecutorService workers = Executors.newVirtualThreadPerTaskExecutor()) {
                ToolCall committed = workers.submit(() -> tools.findById("call_plan").orElseThrow()).get(5, TimeUnit.SECONDS);
                assertEquals(ToolCallStatus.PENDING, committed.getStatus());
                assertEquals(2L, committed.getVersion());
            }
            throw new IllegalStateException("模拟断线");
        }).when(events).publish(anyLong(), any());
        assertDoesNotThrow(() -> readiness.markReady("11"));
        assertEquals(ToolCallStatus.PENDING, tools.findById("call_plan").orElseThrow().getStatus());
    }

    @Test
    void concurrentAndRepeatedReadyNeverDowngradeOrIncrementTwice() throws Exception {
        tools.save(preparing("call_choice", "CHOICE"));
        CountDownLatch start = new CountDownLatch(1);
        try (ExecutorService workers = Executors.newVirtualThreadPerTaskExecutor()) {
            Future<?> first = workers.submit(() -> { await(start); readiness.markReady("11"); });
            Future<?> second = workers.submit(() -> { await(start); readiness.markReady("11"); });
            start.countDown();
            first.get(5, TimeUnit.SECONDS);
            second.get(5, TimeUnit.SECONDS);
        }
        readiness.markReady("11");
        assertEquals(2L, tools.findById("call_choice").orElseThrow().getVersion());
        verify(events, times(1)).publish(anyLong(), any());
        ToolCall completed = tools.findById("call_choice").orElseThrow();
        completed.complete("{\"outcome\":\"ANSWERED\"}");
        tools.updateById(completed);
        readiness.markReady("11");
        assertEquals(ToolCallStatus.COMPLETED, tools.findById("call_choice").orElseThrow().getStatus());
    }

    @Test
    void lateReadyLosesCancellationRaceAndNeverRevivesCard() throws Exception {
        tools.save(preparing("call_command", "COMMAND"));
        CountDownLatch entered = new CountDownLatch(1);
        try (ExecutorService workers = Executors.newVirtualThreadPerTaskExecutor()) {
            Future<?> late;
            synchronized (ExecutionCoordination.monitor("11")) {
                late = workers.submit(() -> { entered.countDown(); readiness.markReady("11"); });
                assertTrue(entered.await(5, TimeUnit.SECONDS));
                execution.setExecutionState(ExecutionState.CANCELLED);
                ToolCall current = tools.findById("call_command").orElseThrow();
                current.complete("{\"outcome\":\"CANCELLED\"}");
                tools.updateById(current);
            }
            late.get(5, TimeUnit.SECONDS);
        }
        assertEquals(ToolCallStatus.COMPLETED, tools.findById("call_command").orElseThrow().getStatus());
        verifyNoInteractions(events);
    }

    @Test
    void mixedUnresolvedSlotsIncludeDelegationAndInProgress() {
        tools.save(preparing("call_plan", "PLAN"));
        tools.save(preparing("call_delegate", "DELEGATION").toBuilder().status(ToolCallStatus.PENDING).build());
        tools.save(preparing("call_command", "COMMAND").toBuilder().status(ToolCallStatus.IN_PROGRESS).build());
        tools.save(preparing("call_done", "CHOICE").toBuilder().status(ToolCallStatus.COMPLETED).build());
        assertEquals(3, tools.listUnresolvedByExecutionId(11L).size());
        readiness.markReady("11");
        assertEquals(ToolCallStatus.IN_PROGRESS, tools.findById("call_command").orElseThrow().getStatus());
        assertEquals(ToolCallStatus.PENDING, tools.findById("call_delegate").orElseThrow().getStatus());
        assertEquals(3, tools.listUnresolvedByExecutionId(11L).size());
        assertEquals(List.of("call_plan"), tools.listActionableByExecutionId(11L).stream().map(ToolCall::getId).toList());
    }

    private ToolCall preparing(String id, String kind) {
        return ToolCall.builder().id(id).conversationId(1L).executionId(11L).toolName("test_tool")
                .type(ToolCallType.PROMISE).status(ToolCallStatus.PREPARING)
                .content("{\"kind\":\"" + kind + "\"}").createdAt(Instant.now()).build();
    }

    private static void await(CountDownLatch latch) {
        try { assertTrue(latch.await(5, TimeUnit.SECONDS)); }
        catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new AssertionError(error); }
    }

    private static <T> ObjectProvider<T> provider(T value) {
        ObjectProvider<T> provider = mock(ObjectProvider.class);
        when(provider.getObject()).thenReturn(value);
        return provider;
    }
}
