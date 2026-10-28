package com.summit.dp.session;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.agent.domain.repository.AgentRepository;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.application.service.ExecutionCheckpointService;
import com.summit.dp.execution.application.service.impl.ExecutionQueryServiceImpl;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.session.application.service.*;
import com.summit.dp.session.application.service.impl.SessionServiceImpl;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.repository.SessionRepositoryImpl;
import com.summit.dp.session.infrastructure.stream.ApplicationEventStream;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.turn.application.convert.ChatTurnConverter;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.workspace.application.service.WorkspaceService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;
import org.springframework.transaction.annotation.EnableTransactionManagement;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.time.Instant;
import java.util.List;
import java.util.ArrayList;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class ApplicationSessionStateTest {
    private AnnotationConfigApplicationContext context;
    private ExecutionCheckpointService checkpoints;
    private SessionReadService reads;
    private SessionRepository sessions;
    private RecordingStream stream;
    private TransactionTemplate transactions;

    @BeforeEach
    void setup() {
        context = new AnnotationConfigApplicationContext(Config.class);
        checkpoints = context.getBean(ExecutionCheckpointService.class);
        reads = context.getBean(SessionReadService.class);
        sessions = context.getBean(SessionRepository.class);
        stream = context.getBean(RecordingStream.class);
        transactions = new TransactionTemplate(context.getBean(DataSourceTransactionManager.class));
        sessions.save(Session.builder().id(11L).name("会话一").build());
        sessions.save(Session.builder().id(22L).name("会话二").build());
        stream.connect();
    }

    @AfterEach
    void close() {
        context.close();
    }

    @Test
    void fourStatesAndReadArePersistedAndBroadcastOnlyAfterCommit() throws Exception {
        save(101L, 11L, ExecutionStatusCodes.CREATED);
        assertState("RUNNING", false);
        long version = sessions.findById(11L).orElseThrow().getVersion();
        reads.read(11L, version);
        assertState("RUNNING", true);

        int delivered = stream.frames.size();
        save(101L, 22L, ExecutionStatusCodes.CREATED);
        assertEquals(delivered, stream.frames.size());
        assertTrue(sessions.findById(11L).orElseThrow().isRead());

        save(101L, 22L, ExecutionStatusCodes.SUSPENDED);
        assertState("WAITING", false);
        assertTrue(sessions.findById(22L).orElseThrow().isRead());
        reads.read(11L, version);
        assertFalse(sessions.findById(11L).orElseThrow().isRead());

        delivered = stream.frames.size();
        transactions.executeWithoutResult(status -> {
            save(101L, null, ExecutionStatusCodes.COMPLETED);
            status.setRollbackOnly();
        });
        assertEquals(delivered, stream.frames.size());
        assertState("WAITING", false);

        save(101L, null, ExecutionStatusCodes.COMPLETED);
        assertState("COMPLETED", false);
        save(102L, 11L, ExecutionStatusCodes.CREATED);
        save(102L, null, ExecutionStatusCodes.FAILED);
        assertState("FAILED", false);

        SessionVO view = context.getBean(SessionService.class).findById(11L).getData();
        JsonNode json = new ObjectMapper().findAndRegisterModules().valueToTree(view);
        assertTrue(json.has("isRead"));
        assertFalse(json.has("read"));
    }

    @Test
    void deletedSessionDoesNotPreventExecutionFromFinishing() {
        save(101L, 11L, ExecutionStatusCodes.CREATED);
        int delivered = stream.frames.size();
        sessions.delSessionTreeByRootSId(11L);

        save(101L, null, ExecutionStatusCodes.COMPLETED);

        assertEquals(ExecutionStatusCodes.COMPLETED, checkpoints.find(101L).orElseThrow().status());
        assertEquals(delivered, stream.frames.size());
    }

    @Test
    void applicationSnapshotIncludesAllRootSessionsBeyondTheSidebarPage() {
        for (long id = 1000L; id < 1105L; id++) {
            sessions.save(Session.builder().id(id).name("会话" + id).build());
        }
        sessions.save(Session.builder().id(2000L).rootSessionId(11L).name("子会话").build());
        List<SessionVO> snapshot = context.getBean(SessionService.class).applicationStates().getData();
        assertEquals(107, snapshot.size());
        assertTrue(snapshot.stream().anyMatch(session -> session.getId() == 1104L));
        assertFalse(snapshot.stream().anyMatch(session -> session.getId() == 2000L));
    }

    @Test
    void rollbackReadAndStaleMetadataCannotClearUnread() {
        save(101L, 11L, ExecutionStatusCodes.CREATED);
        Session stale = sessions.findById(11L).orElseThrow();
        int delivered = stream.frames.size();
        transactions.executeWithoutResult(status -> {
            reads.read(11L, stale.getVersion());
            status.setRollbackOnly();
        });
        assertEquals(delivered, stream.frames.size());
        assertFalse(sessions.findById(11L).orElseThrow().isRead());

        stale.changeRead(true);
        stale.rename("只改名称");
        sessions.updateById(stale);
        assertFalse(sessions.findById(11L).orElseThrow().isRead());
    }

    @Test
    void readWaitingForNewStateCannotAcknowledgeTheNewVersion() throws Exception {
        save(101L, 11L, ExecutionStatusCodes.CREATED);
        long oldVersion = sessions.findById(11L).orElseThrow().getVersion();
        CountDownLatch locked = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);

        try (ExecutorService workers = Executors.newFixedThreadPool(2)) {
            Future<?> transition = workers.submit(() -> transactions.executeWithoutResult(status -> {
                sessions.lockById(11L).orElseThrow();
                save(101L, null, ExecutionStatusCodes.SUSPENDED);
                locked.countDown();
                await(release);
            }));
            assertTrue(locked.await(5, TimeUnit.SECONDS));
            Future<?> read = workers.submit(() -> reads.read(11L, oldVersion));
            release.countDown();
            transition.get(5, TimeUnit.SECONDS);
            read.get(5, TimeUnit.SECONDS);
        }
        assertState("WAITING", false);
    }

    private void save(long id, Long sessionId, int status) {
        checkpoints.save(id, sessionId, status, "{}", Instant.now(), null, null);
    }

    private void assertState(String expected, boolean read) {
        SessionVO state = context.getBean(SessionService.class).findById(11L).getData();
        assertEquals(expected, state.getRenderStatus());
        assertEquals(read, state.isRead());
        assertEquals(read, sessions.findById(11L).orElseThrow().isRead());
        String wire = stream.frames.getLast();
        assertTrue(wire.contains("SESSION_STATE"), wire);
        assertTrue(wire.contains(expected), wire);
    }

    private static void await(CountDownLatch latch) {
        try {
            assertTrue(latch.await(5, TimeUnit.SECONDS));
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw new AssertionError(error);
        }
    }

    static class RecordingStream extends ApplicationEventStream {
        final List<String> frames = new ArrayList<>();

        @Override
        protected SseEmitter newEmitter() {
            SseEmitter emitter = mock(SseEmitter.class);
            try {
                doAnswer(invocation -> {
                    SseEmitter.SseEventBuilder builder = invocation.getArgument(0);
                    StringBuilder wire = new StringBuilder();
                    for (SseEmitter.DataWithMediaType item : builder.build()) wire.append(item.getData());
                    frames.add(wire.toString());
                    return null;
                }).when(emitter).send(any(SseEmitter.SseEventBuilder.class));
            } catch (Exception error) {
                throw new AssertionError(error);
            }
            return emitter;
        }
    }

    @Configuration
    @EnableTransactionManagement
    static class Config {
        @Bean(destroyMethod = "shutdown")
        EmbeddedDatabase database() {
            return new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.H2)
                    .setName(UUID.randomUUID() + ";MODE=MySQL").addScript("init.sql").build();
        }

        @Bean
        DataSourceTransactionManager transactionManager(EmbeddedDatabase database) {
            return new DataSourceTransactionManager(database);
        }

        @Bean
        SqlSessionTemplate sql(EmbeddedDatabase database) throws Exception {
            MybatisConfiguration configuration = new MybatisConfiguration();
            configuration.setMapUnderscoreToCamelCase(true);
            configuration.addMapper(SessionMapper.class);
            configuration.addMapper(ExecutionMapper.class);
            MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
            factory.setDataSource(database);
            factory.setConfiguration(configuration);
            return new SqlSessionTemplate(factory.getObject());
        }

        @Bean
        SessionRepository sessions(SqlSessionTemplate sql) {
            return new SessionRepositoryImpl(sql.getMapper(SessionMapper.class));
        }

        @Bean
        ExecutionRepositoryImpl executions(SqlSessionTemplate sql) {
            return new ExecutionRepositoryImpl(sql.getMapper(ExecutionMapper.class));
        }

        @Bean
        ExecutionCheckpointService checkpoints(ExecutionRepositoryImpl executions, ApplicationEventPublisher events) {
            return new ExecutionCheckpointService(executions, events);
        }

        @Bean
        SessionService service(SessionRepository sessions, ExecutionRepositoryImpl executions) {
            return new SessionServiceImpl(new SessionAggregateService(sessions, null, null, null, null, null),
                    mock(WorkspaceService.class), sessions, mock(SessionMessageQueryService.class),
                    new ExecutionQueryServiceImpl(executions), mock(TeamService.class), mock(AgentRepository.class),
                    mock(ChatTurnService.class), new ChatTurnConverter(), mock(TurnViewService.class));
        }

        @Bean
        SessionReadService reads(SessionRepository sessions, SessionService service, ApplicationEventPublisher events) {
            return new SessionReadService(sessions, service, events);
        }

        @Bean
        RecordingStream stream() {
            return new RecordingStream();
        }
    }
}
