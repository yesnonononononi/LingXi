package com.summit.dp.session;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.agent.domain.repository.AgentRepository;
import com.summit.dp.execution.application.service.impl.ExecutionQueryServiceImpl;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.session.application.service.SessionAggregateService;
import com.summit.dp.session.application.service.SessionMessageQueryService;
import com.summit.dp.session.application.service.SessionPinService;
import com.summit.dp.session.application.service.SessionStateChanged;
import com.summit.dp.session.application.service.TurnViewService;
import com.summit.dp.session.application.service.impl.SessionServiceImpl;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionPO;
import com.summit.dp.session.infrastructure.persistence.repository.SessionRepositoryImpl;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.persistence.MyBatisTypeHandlers;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.vo.SessionTreeVO;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.turn.application.convert.ChatTurnConverter;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.workspace.application.service.WorkspaceService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.context.ApplicationEventPublisher;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;

/** 会话置顶：写路径语义（幂等、子会话拒绝、不被旁路写覆盖）与出参口径（JSON 字段名、子会话继承）。 */
class SessionPinTest {
    private H2TestDatabase database;
    private SessionMapper mapper;
    private SessionRepositoryImpl repository;
    private SessionServiceImpl service;
    private SessionAggregateService aggregate;
    private ApplicationEventPublisher events;
    private SessionPinService pins;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("SessionPinTest");
        MybatisConfiguration configuration = new MybatisConfiguration();
        configuration.setMapUnderscoreToCamelCase(true);
        MyBatisTypeHandlers.registerAll(configuration);
        configuration.addMapper(SessionMapper.class);
        configuration.addMapper(ExecutionMapper.class);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        SqlSessionTemplate sql = H2TestDatabase.sqlSession(factory.getObject());
        mapper = sql.getMapper(SessionMapper.class);
        ExecutionMapper executions = sql.getMapper(ExecutionMapper.class);

        repository = new SessionRepositoryImpl(mapper);
        events = mock(ApplicationEventPublisher.class);
        aggregate = new SessionAggregateService(repository, mock(MessageRepository.class), null, null, null, events);
        service = new SessionServiceImpl(aggregate, mock(WorkspaceService.class), repository,
                mock(SessionMessageQueryService.class),
                new ExecutionQueryServiceImpl(new ExecutionRepositoryImpl(executions)),
                mock(TeamService.class), mock(AgentRepository.class), mock(ChatTurnService.class),
                new ChatTurnConverter(), mock(TurnViewService.class));
        pins = new SessionPinService(repository, service, events);
        insertSession(10L, 0L, 1);
        insertSession(20L, 0L, 5);
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("置顶持久化且不刷新 update_time（组内次序靠它，pin 顺手刷时间会让位置再也回不去）")
    void pinPersistsWithoutTouchingUpdateTime() {
        Instant before = mapper.selectById(10L).getUpdateTime();

        assertTrue(pins.setPinned(10L, true).getData().isPinned());

        assertTrue(repository.findById(10L).orElseThrow().isPinned());
        assertEquals(before, mapper.selectById(10L).getUpdateTime(),
                "pin 不得改动 update_time：H2 的 ON UPDATE CURRENT_TIMESTAMP 会被「未显式赋值」的 UPDATE 触发");
    }

    @Test
    @DisplayName("幂等：目标态与当前态一致时只回读，不重复广播")
    void repinIsIdempotentAndBroadcastsOnce() {
        pins.setPinned(10L, true);
        pins.setPinned(10L, true);

        verify(events, times(1)).publishEvent(any(SessionStateChanged.class));
    }

    @Test
    @DisplayName("子会话拒绝单独设置：它跟随所属根会话，不允许出现无人可见的置顶")
    void subSessionCannotBePinned() {
        insertSession(99L, 10L, 9);

        ClientException error = assertThrows(ClientException.class, () -> pins.setPinned(99L, true));

        assertTrue(error.getMessage().contains("子会话"), "异常文案要说清是子会话不能单独设置，实际=" + error.getMessage());
        assertFalse(repository.findById(99L).orElseThrow().isPinned());
    }

    @Test
    @DisplayName("旁路整行回写拿着旧快照也不会把置顶覆盖回 FALSE")
    void aggregateUpdateDoesNotClobberPin() {
        // 快照必须早于 pin：执行终结回写就是拿这种「读出来的旧快照」整行 updateById 的。
        SessionPO stale = mapper.selectById(10L);
        assertFalse(stale.getIsPinned(), "前置条件：种子会话初始未置顶");

        pins.setPinned(10L, true);

        stale.setContextTokenCount(1234L);
        mapper.updateById(stale);
        assertTrue(repository.findById(10L).orElseThrow().isPinned(), "旧快照整行回写把 pin 抹掉了");

        aggregate.saveContextUsage(10L, 4321L, 200000, 0.006D);
        assertEquals(4321L, repository.findById(10L).orElseThrow().getContextTokenCount());
        assertTrue(repository.findById(10L).orElseThrow().isPinned(), "聚合回写把 pin 抹掉了");
    }

    @Test
    @DisplayName("出参 JSON 字段名是 isPinned（默认会序列化成 pinned，前端按 isPinned 读会恒 undefined）")
    void viewExposesIsPinnedPropertyName() {
        pins.setPinned(10L, true);

        JsonNode json = new ObjectMapper().findAndRegisterModules()
                .valueToTree(service.findById(10L).getData());

        assertTrue(json.has("isPinned"));
        assertFalse(json.has("pinned"));
        assertTrue(json.get("isPinned").asBoolean());
    }

    @Test
    @DisplayName("子会话视图继承所属根会话的置顶（二级树里不能父置顶、子不置顶）")
    void subSessionViewInheritsRootPin() {
        insertSession(99L, 10L, 9);
        pins.setPinned(10L, true);

        SessionTreeVO tree = service.tree(10L).getData();
        List<SessionVO> sessions = tree.getSessions();
        Map<Long, Boolean> pinned = sessions.stream()
                .collect(Collectors.toMap(SessionVO::getId, SessionVO::isPinned));
        assertEquals(2, pinned.size(), "会话树只含根会话与它的子会话");
        assertTrue(pinned.get(10L));
        assertTrue(pinned.get(99L), "子会话必须继承根会话的置顶状态");
    }

    private void insertSession(long id, long rootId, int updatedDay) {
        Instant createdAt = Instant.parse("2026-10-01T00:00:00Z");
        mapper.insert(SessionPO.builder().id(id).name("置顶测试").rootSessionId(rootId)
                .createTime(createdAt).updateTime(createdAt.plusSeconds(updatedDay * 86400L)).build());
    }
}
