package com.summit.dp.session;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.summit.dp.agent.domain.repository.AgentRepository;
import com.summit.dp.execution.ExecutionStatusCodes;
import com.summit.dp.execution.application.service.impl.ExecutionQueryServiceImpl;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.persistence.po.ExecutionPO;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.session.api.controller.SessionController;
import com.summit.dp.session.application.service.SessionAggregateService;
import com.summit.dp.session.application.service.SessionBootstrapService;
import com.summit.dp.session.application.service.SessionMessageQueryService;
import com.summit.dp.session.application.service.TurnViewService;
import com.summit.dp.session.application.service.impl.SessionServiceImpl;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionPO;
import com.summit.dp.session.infrastructure.persistence.repository.SessionRepositoryImpl;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.turn.application.convert.ChatTurnConverter;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import com.summit.dp.workspace.application.service.WorkspaceService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabase;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseBuilder;
import org.springframework.jdbc.datasource.embedded.EmbeddedDatabaseType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.mock;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class SessionListOrderingTest {
    private EmbeddedDatabase database;
    private SessionMapper sessions;
    private ExecutionMapper executions;
    private SessionServiceImpl service;
    private MockMvc mvc;

    @BeforeEach
    void setup() throws Exception {
        database = new EmbeddedDatabaseBuilder().setType(EmbeddedDatabaseType.H2)
                .setName(UUID.randomUUID() + ";MODE=MySQL").addScript("init.sql").build();
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(true);
        configuration.addMapper(SessionMapper.class);
        configuration.addMapper(ExecutionMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionTemplate sql = new SqlSessionTemplate(factory.getObject());
        sessions = sql.getMapper(SessionMapper.class);
        executions = sql.getMapper(ExecutionMapper.class);
        SessionRepositoryImpl repository = new SessionRepositoryImpl(sessions);
        SessionAggregateService aggregate = new SessionAggregateService(repository, null, null, null, null, null);
        service = new SessionServiceImpl(aggregate, mock(WorkspaceService.class), repository,
                mock(SessionMessageQueryService.class), new ExecutionQueryServiceImpl(new ExecutionRepositoryImpl(executions)),
                mock(TeamService.class), mock(AgentRepository.class), mock(ChatTurnService.class),
                new ChatTurnConverter(), mock(TurnViewService.class));
        mvc = MockMvcBuilders.standaloneSetup(new SessionController(service, mock(SessionBootstrapService.class)))
                .setMessageConverters(new MappingJackson2HttpMessageConverter(new JsonConfig().objectMapper())).build();
    }

    @AfterEach
    void shutdown() { database.shutdown(); }

    @Test
    void runningSessionsReachTheFirstPageBeforeNewerIdleSessions() throws Exception {
        insertSession(90L, 0L, 9);
        insertSession(80L, 0L, 8);
        insertSession(10L, 0L, 1);
        insertSession(20L, 0L, 2);
        insertSession(99L, 10L, 10);
        insertExecution(101L, 10L, ExecutionStatusCodes.RUNNING);
        insertExecution(201L, 20L, ExecutionStatusCodes.CREATED);
        insertExecution(991L, 99L, ExecutionStatusCodes.RUNNING);

        mvc.perform(get("/session/list").param("page", "1").param("pageSize", "1"))
                .andExpect(status().isOk()).andExpect(jsonPath("$.data.total").value("4"))
                .andExpect(jsonPath("$.data.records[0].id").value("20"))
                .andExpect(jsonPath("$.data.records[0].runStatus").value("RUNNING"));
        assertEquals(List.of(10L), loadIds(2, 1));
        assertEquals(List.of(90L, 80L), loadIds(2, 2));
    }

    @Test
    void updateTimeDescendingAndThenIdKeepPaginationStable() {
        insertSession(50L, 0L, 2);
        insertSession(1L, 0L, 3);
        insertSession(2L, 0L, 3);

        assertEquals(List.of(2L, 1L, 50L), loadIds(1, 10));
        assertEquals(List.of(2L), loadIds(1, 1));
        assertEquals(List.of(1L), loadIds(2, 1));
        assertEquals(List.of(50L), loadIds(3, 1));
    }

    @Test
    void sortingUsesTheSameLatestActiveStateAsTheDisplayedStatus() {
        insertSession(10L, 0L, 1);
        insertSession(20L, 0L, 3);
        insertSession(30L, 0L, 2);
        insertSession(40L, 0L, 4);
        insertExecution(100L, 10L, ExecutionStatusCodes.RUNNING);
        insertExecution(101L, 10L, ExecutionStatusCodes.SUSPENDED);
        insertExecution(200L, 20L, ExecutionStatusCodes.SUSPENDED);
        insertExecution(201L, 20L, ExecutionStatusCodes.CREATED);
        insertExecution(299L, 30L, ExecutionStatusCodes.RUNNING);
        insertExecution(300L, 30L, ExecutionStatusCodes.COMPLETED);
        insertExecution(400L, 40L, ExecutionStatusCodes.FAILED);

        List<SessionVO> records = service.list(1, 10).getData().getRecords().stream().toList();
        assertEquals(List.of(20L, 30L, 40L, 10L), records.stream().map(SessionVO::getId).toList());
        assertEquals(List.of("RUNNING", "RUNNING", "IDLE", "SUSPENDED"),
                records.stream().map(SessionVO::getRunStatus).toList());
    }

    @Test
    void completionReturnsTheSessionToItsUpdateTimePosition() {
        insertSession(10L, 0L, 1);
        insertSession(20L, 0L, 2);
        insertExecution(101L, 10L, ExecutionStatusCodes.RUNNING);
        assertEquals(List.of(10L, 20L), loadIds(1, 10));

        ExecutionPO completed = new ExecutionPO();
        completed.setId(101L);
        completed.setStatus(ExecutionStatusCodes.COMPLETED);
        executions.updateById(completed);
        assertEquals(List.of(20L, 10L), loadIds(1, 10));
    }

    private List<Long> loadIds(int page, int size) {
        return service.list(page, size).getData().getRecords().stream().map(SessionVO::getId).toList();
    }

    private void insertSession(long id, long rootId, int updatedDay) {
        Instant createdAt = Instant.parse("2026-10-01T00:00:00Z");
        sessions.insert(SessionPO.builder().id(id).name("排序测试").rootSessionId(rootId)
                .createTime(createdAt).updateTime(createdAt.plusSeconds(updatedDay * 86400L)).build());
    }

    private void insertExecution(long id, long sessionId, int status) {
        ExecutionPO row = new ExecutionPO();
        row.setId(id);
        row.setSessionId(sessionId);
        row.setStatus(status);
        executions.insert(row);
    }
}
