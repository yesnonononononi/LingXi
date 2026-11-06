package com.summit.dp.session;

import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.session.application.service.SessionAggregateService;
import com.summit.dp.session.application.service.SessionBootstrapService;
import com.summit.dp.session.application.service.SessionService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.support.SqlCaptureInterceptor;
import com.summit.dp.shared.vo.*;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.infrastructure.persistence.mapper.ToolCallMapper;
import com.summit.dp.toolcall.infrastructure.persistence.repository.ToolCallRepositoryImpl;
import com.summit.dp.turn.application.convert.ChatTurnConverter;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.workflow.infrastructure.harness.HarnessExecutionGate;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.ObjectProvider;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

/**
 * bootstrap 未决卡片：真实 H2 + MyBatis 上验证「一次 IN 查完整棵会话树」。
 *
 * <p>单元用例（{@code SessionBootstrapServiceTest}）把仓储换成了 mock，只能证明调用次数；
 * 本类换成真实的 {@link ToolCallRepositoryImpl}，用 SQL 拦截器证明<b>未决谓词真的下推到了 SQL</b>
 * —— 已完成卡片、树外会话的卡片一条都不能被带出来，否则前端重连后会冒出早已决策过的卡。</p>
 */
class SessionBootstrapH2Test {

    private static final long ROOT_ID = 500L;
    private static final long CHILD_ID = 501L;
    private static final long OUTSIDE_ID = 502L;

    private final SessionService sessionService = mock(SessionService.class);
    private final SessionAggregateService aggregateService = mock(SessionAggregateService.class);
    private final ExecutionQueryService executionQueryService = mock(ExecutionQueryService.class);
    private final ToolCallConverter toolCallConverter = mock(ToolCallConverter.class);
    private final ChatTurnService chatTurnService = mock(ChatTurnService.class);

    private H2TestDatabase database;
    private SqlCaptureInterceptor capture;
    private SessionBootstrapService service;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("SessionBootstrapH2Test");
        capture = new SqlCaptureInterceptor();
        MybatisConfiguration configuration = database.configuration(ToolCallMapper.class);
        configuration.addInterceptor(capture);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        MybatisPlusInterceptor plugins = new MybatisPlusInterceptor();
        plugins.addInnerInterceptor(new PaginationInnerInterceptor(DbType.H2));
        factory.setPlugins(plugins);
        SqlSessionFactory sessionFactory = factory.getObject();
        ToolCallRepositoryImpl repository = new ToolCallRepositoryImpl(
                H2TestDatabase.sqlSession(sessionFactory).getMapper(ToolCallMapper.class),
                new ObjectMapper(), cardAvailabilityPolicy());

        repository.save(card("root-pending", ROOT_ID, 1001L, ToolCallStatus.PENDING));
        repository.save(card("child-preparing", CHILD_ID, 1002L, ToolCallStatus.PREPARING));
        // 已结束与非 PROMISE 都不是未决槽位；树外会话的卡片也不许带出来。
        repository.save(card("root-completed", ROOT_ID, 1003L, ToolCallStatus.COMPLETED));
        repository.save(card("outside-pending", OUTSIDE_ID, 1004L, ToolCallStatus.PENDING));

        service = new SessionBootstrapService(sessionService, aggregateService, executionQueryService,
                repository, toolCallConverter, chatTurnService, new ChatTurnConverter());

        when(aggregateService.requireOwned(ROOT_ID)).thenReturn(
                Session.builder().id(ROOT_ID).historyRevision(7L).build());
        when(aggregateService.sessionTree(ROOT_ID)).thenReturn(new SessionAggregateService.SessionTree(
                ROOT_ID, List.of(Session.builder().id(ROOT_ID).build(),
                        Session.builder().id(CHILD_ID).rootSessionId(ROOT_ID).build())));
        when(sessionService.tree(ROOT_ID)).thenReturn(Result.success(SessionTreeVO.builder()
                .rootSessionId(ROOT_ID)
                .sessions(List.of(SessionVO.builder().id(ROOT_ID).build(),
                        SessionVO.builder().id(CHILD_ID).rootSessionId(ROOT_ID).build()))
                .build()));
        when(sessionService.messages(ROOT_ID, null, 50))
                .thenReturn(Result.success(SessionMessagePageVO.builder().hasMore(false).build()));
        when(chatTurnService.findActiveBySessionIds(any())).thenReturn(List.of());
        when(executionQueryService.activeBySession(any())).thenReturn(List.of());
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("根+子两个会话的未决卡只发一条 tool_call SELECT，排除已完成与树外行")
    void unresolvedCardsComeFromOneInQuery() {
        when(executionQueryService.summariesByIds(any())).thenReturn(Map.of(
                1001L, summary(1001L, "SUSPENDED"),
                1002L, summary(1002L, "RUNNING")));
        when(toolCallConverter.toVO(any(), any())).thenAnswer(call -> ToolCallVO.builder()
                .id(((ToolCall) call.getArgument(0)).getId()).build());

        capture.clear();
        SessionBootstrapVO vo = service.bootstrap(ROOT_ID);

        List<String> toolQueries = capture.queries().stream()
                .filter(entry -> entry.toLowerCase().contains("toolcallmapper"))
                .toList();
        assertEquals(1, toolQueries.size(), "整棵会话树的未决卡片只应查一次，实际: " + toolQueries);
        String sql = SqlCaptureInterceptor.normalize(toolQueries.getFirst());
        assertTrue(sql.contains("in ("), "必须是一次 IN 查询，实际: " + sql);
        assertTrue(sql.contains("status in"), "未决谓词必须下推到 SQL，实际: " + sql);

        assertEquals(List.of("root-pending", "child-preparing"),
                vo.getToolCalls().stream().map(ToolCallVO::getId).toList(),
                "只应有未决槽位：已完成卡与树外会话的卡都必须排除");

        // 闸门仍来自一次批量执行摘要（§8.2），且只取未决卡涉及的执行 id。
        @SuppressWarnings("unchecked")
        ArgumentCaptor<Collection<Long>> idsCaptor = ArgumentCaptor.forClass(Collection.class);
        verify(executionQueryService, times(1)).summariesByIds(idsCaptor.capture());
        assertEquals(List.of(1001L, 1002L), List.copyOf(idsCaptor.getValue()));

        ArgumentCaptor<CardAvailabilityPolicy.ExecutionGate> gates =
                ArgumentCaptor.forClass(CardAvailabilityPolicy.ExecutionGate.class);
        verify(toolCallConverter, times(2)).toVO(any(), gates.capture());
        assertEquals(List.of(CardAvailabilityPolicy.ExecutionGate.SUSPENDED,
                CardAvailabilityPolicy.ExecutionGate.ACTIVE), gates.getAllValues());
    }

    private static CardAvailabilityPolicy cardAvailabilityPolicy() {
        return new CardAvailabilityPolicy(
                new HarnessExecutionGate(mock(ObjectProvider.class), mock(ObjectProvider.class)));
    }

    private static ToolCall card(String id, long conversationId, long executionId, ToolCallStatus status) {
        return ToolCall.builder()
                .id(id).conversationId(conversationId).executionId(executionId)
                .toolName("ask_user").type(ToolCallType.PROMISE).status(status)
                .title("选择")
                .content("{\"kind\":\"CHOICE\",\"question\":\"选一个\"}")
                .rawInput("{\"args\":{}}")
                .createdAt(Instant.now()).updatedAt(Instant.now())
                .build();
    }

    private static ExecutionQueryService.ExecutionSummary summary(long id, String status) {
        return new ExecutionQueryService.ExecutionSummary(id, ROOT_ID, status, null, null);
    }
}
