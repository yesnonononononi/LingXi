package com.summit.dp.workflow.infrastructure.listener;

import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.event.ToolCallStartEvent;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.execution.infrastructure.persistence.mapper.ExecutionMapper;
import com.summit.dp.execution.infrastructure.repository.ExecutionRepositoryImpl;
import com.summit.dp.session.application.convert.ToolBlockEventFacts;
import com.summit.dp.session.application.convert.ToolBlockStatusResolver;
import com.summit.dp.session.application.convert.TurnViewAssembler;
import com.summit.dp.session.application.service.TurnViewService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMessageMapper;
import com.summit.dp.session.infrastructure.persistence.repository.SessionMessageRepositoryImpl;
import com.summit.dp.session.infrastructure.persistence.repository.SessionRepositoryImpl;
import com.summit.dp.shared.event.BlockEventType;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.support.SqlCaptureInterceptor;
import com.summit.dp.shared.vo.block.BlockStatus;
import com.summit.dp.shared.vo.block.ToolBlock;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.infrastructure.persistence.mapper.ToolCallMapper;
import com.summit.dp.toolcall.infrastructure.persistence.repository.ToolCallRepositoryImpl;
import com.summit.dp.turn.infrastructure.persistence.mapper.ChatTurnMapper;
import com.summit.dp.turn.infrastructure.persistence.po.ChatTurnPO;
import com.summit.dp.turn.infrastructure.persistence.repository.ChatTurnRepositoryImpl;
import com.summit.dp.workflow.application.projection.TurnBroadcastIdentity;
import com.summit.dp.workflow.application.projection.TurnViewBroadcaster;
import com.summit.dp.workflow.infrastructure.harness.HarnessExecutionGate;
import com.summit.dp.workflow.infrastructure.listener.session.BlockUpsertRuntimeListener;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mybatis.spring.SqlSessionTemplate;
import org.springframework.beans.factory.ObjectProvider;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 工具事件 → SSE 发布之间的**端到端真实 SQL 守卫**。
 *
 * <p><b>为什么必须端到端数语句</b>：本轮要证明的是「工具事件已经带着权威归属，所以这条路上不该
 * 再有反查」。只断言「某个方法没被调用」守不住 —— 反查可能换个出口（换仓储、换方法、换二次解析）
 * 继续存在，而语句数会立刻暴露它。因此这里从真实框架事件出发，一直走到
 * {@code sseEventPublisher.publishBusiness} 被调用，中间所有 SQL 都由
 * {@link SqlCaptureInterceptor} 记下来逐条分类统计。</p>
 *
 * <p><b>两条口径都必须钉住</b>：元数据齐备时零反查（{@code chat_turn} 按 {@code execution_id} 的反查
 * 0 条、根会话解析 0 条）；元数据缺失（旧检查点）时回退路径的条数与形状必须<b>明确</b>，
 * 不许用「不超过 N 条」含糊过去。</p>
 */
class ToolBlockBroadcastSqlGuardTest {

    private static final long SESSION_ID = 8801L;
    private static final long ROOT_SESSION_ID = 8801L;
    private static final long OTHER_SESSION_ID = 8802L;
    private static final long TURN_ID = 8901L;
    private static final long EXECUTION_ID = 8902L;
    private static final String TARGET = "call-guard";
    private static final String RESPONSE_ID = "9007199254740993";

    private final ObjectMapper json = new ObjectMapper();

    private H2TestDatabase database;
    private SqlCaptureInterceptor capture;
    private SseEventPublisher sseEventPublisher;
    private TurnViewBroadcaster broadcaster;
    private BlockUpsertRuntimeListener listener;
    private SessionMessageRepositoryImpl messageRepository;
    private ToolCallRepositoryImpl toolCallRepository;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("ToolBlockBroadcastSqlGuardTest");
        capture = new SqlCaptureInterceptor();
        MybatisConfiguration configuration = database.configuration(ChatTurnMapper.class, SessionMapper.class,
                SessionMessageMapper.class, ToolCallMapper.class, ExecutionMapper.class);
        configuration.addInterceptor(capture);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        MybatisPlusInterceptor plugins = new MybatisPlusInterceptor();
        plugins.addInnerInterceptor(new PaginationInnerInterceptor(DbType.H2));
        factory.setPlugins(plugins);
        SqlSessionFactory sessionFactory;
        try {
            sessionFactory = factory.getObject();
        } catch (Exception e) {
            throw new IllegalStateException("测试用 SqlSessionFactory 创建失败: " + e.getMessage(), e);
        }
        SqlSessionTemplate template = H2TestDatabase.sqlSession(sessionFactory);

        messageRepository = new SessionMessageRepositoryImpl(
                template.getMapper(SessionMessageMapper.class), template.getMapper(SessionMapper.class));
        toolCallRepository = new ToolCallRepositoryImpl(template.getMapper(ToolCallMapper.class),
                new ObjectMapper(), cardAvailabilityPolicy());
        ChatTurnRepositoryImpl chatTurnRepository =
                new ChatTurnRepositoryImpl(template.getMapper(ChatTurnMapper.class));
        SessionRepositoryImpl sessionRepository = new SessionRepositoryImpl(template.getMapper(SessionMapper.class));
        ExecutionLocator executionLocator = new ExecutionLocator(
                new ExecutionRepositoryImpl(template.getMapper(ExecutionMapper.class)), sessionRepository);

        sseEventPublisher = mock(SseEventPublisher.class);
        TurnViewService turnViewService = new TurnViewService(messageRepository, chatTurnRepository,
                toolCallRepository, new TurnViewAssembler(json,
                new ToolBlockStatusResolver(new ToolCallConverter(json))),
                mock(com.summit.dp.turn.application.port.TurnFileChangeQuery.class));
        broadcaster = new TurnViewBroadcaster(turnViewService, chatTurnRepository, sessionRepository,
                sseEventPublisher, executionLocator);
        listener = new BlockUpsertRuntimeListener(broadcaster, chatTurnRepository);

        seed(sessionRepository, chatTurnRepository, template);
        capture.clear();
    }

    @AfterEach
    void shutdown() {
        if (database != null) {
            database.shutdown();
        }
    }

    @Test
    @DisplayName("元数据齐备：chat_turn 反查 0 条、根会话解析 0 条，全程恰好 4 条语句")
    void metadataCompleteIssuesNoReverseLookup() {
        listener.onToolCall(toolStart(metadata()));

        List<String> queries = capture.queries();
        assertEquals(0, countWhere(queries, "chat_turn", "execution_id"),
                "元数据已带 turnId，不得再按执行 ID 反查轮次，实际: " + queries);
        assertEquals(1, countWhere(queries, "chat_turn", "where id="),
                "轮次行仍是展示版本号/状态/父轮次的唯一来源，只允许一次主键读，实际: " + queries);
        assertEquals(1, countTables(queries, "chat_turn"),
                "chat_turn 上只允许一条语句（主键读），实际: " + queries);
        assertEquals(1, countTables(queries, "session"),
                "根会话来自元数据，不得再解析一次（会话行只用于用量快照），实际: " + queries);
        assertEquals(1, countTables(queries, "session_message"), "USER 行窄查必须保留，实际: " + queries);
        assertEquals(1, countTables(queries, "tool_call"), "工具行只读投影一条，实际: " + queries);
        assertEquals(4, queries.size(), "整条链路必须收敛到 4 条语句，实际: " + queries);

        ArgumentCaptor<Object> payload = ArgumentCaptor.forClass(Object.class);
        verify(sseEventPublisher).publishBusiness(eq(ROOT_SESSION_ID), eq(BlockEventType.BLOCK_UPSERT),
                payload.capture());
        BlockEventType.BlockEventPayload event = (BlockEventType.BlockEventPayload) payload.getValue();
        assertEquals(SESSION_ID, event.sessionId(), "载荷归属是轮次自身会话");
        assertEquals(TURN_ID, event.turnId());
        assertEquals(1, event.view().blocks().size(), "增量只下发变化的那一个块");
        ToolBlock block = (ToolBlock) event.view().blocks().getFirst();
        assertEquals(ToolBlock.identity(TARGET), block.getBlockId());
        assertEquals(BlockStatus.TOOL_COMPLETED, block.status());
    }

    @Test
    @DisplayName("元数据缺失（旧检查点）：回退路径恰好 6 条语句，形状逐条列明")
    void metadataMissingFallsBackWithEnumeratedStatements() {
        listener.onToolCall(toolStart(Map.of()));

        List<String> queries = capture.queries();
        assertEquals(1, countWhere(queries, "chat_turn", "execution_id"),
                "回退必须按执行 ID 反查一次轮次，实际: " + queries);
        assertEquals(2, countTables(queries, "chat_turn"),
                "回退路径读两次 chat_turn（反查 + 主键），实际: " + queries);
        assertEquals(2, countTables(queries, "session"),
                "回退路径读两次会话（解析根会话 + 用量快照），实际: " + queries);
        assertEquals(1, countTables(queries, "session_message"),
                "USER 行窄查在两条路径上都保留，实际: " + queries);
        assertEquals(1, countTables(queries, "tool_call"), "工具行只读投影一条，实际: " + queries);
        assertEquals(6, queries.size(), "回退路径必须收敛到 6 条语句，实际: " + queries);

        verify(sseEventPublisher).publishBusiness(eq(ROOT_SESSION_ID), eq(BlockEventType.BLOCK_UPSERT), any());
    }

    @Test
    @DisplayName("归属拿不到（轮次行不存在）：丢弃，不推送也绝不改投别的会话")
    void unknownTurnIsDropped() {
        long unknownTurnId = TURN_ID + 777L;
        listener.onToolCall(toolStart(ExecutionEventMetadata.of(ROOT_SESSION_ID, SESSION_ID, unknownTurnId,
                null, 1L)));

        verify(sseEventPublisher, never()).publishBusiness(anyLong(), any(), any());
        assertEquals(1, countTables(capture.queries(), "chat_turn"),
                "元数据齐备时只读一次轮次行，查不到即止，不得再走反查，实际: " + capture.queries());
    }

    @Test
    @DisplayName("元数据与轮次行归属冲突：丢弃，不静默改投到任一方会话")
    void conflictingOwnershipIsDropped() {
        listener.onToolCall(toolStart(ExecutionEventMetadata.of(OTHER_SESSION_ID, OTHER_SESSION_ID, TURN_ID,
                null, 1L)));

        verify(sseEventPublisher, never()).publishBusiness(anyLong(), any(), any());
        assertEquals(0, countTables(capture.queries(), "session_message"),
                "归属冲突必须在装配前终止，不得继续读该轮内容，实际: " + capture.queries());
    }

    @Test
    @DisplayName("等价性：元数据齐备与回退两条路径推出来的块逐字段相同")
    void bothPathsProduceSameBlock() {
        listener.onToolCall(toolStart(metadata()));
        ArgumentCaptor<Object> withMetadata = ArgumentCaptor.forClass(Object.class);
        verify(sseEventPublisher).publishBusiness(eq(ROOT_SESSION_ID), eq(BlockEventType.BLOCK_UPSERT),
                withMetadata.capture());

        org.mockito.Mockito.reset(sseEventPublisher);
        listener.onToolCall(toolStart(Map.of()));
        ArgumentCaptor<Object> withFallback = ArgumentCaptor.forClass(Object.class);
        verify(sseEventPublisher).publishBusiness(eq(ROOT_SESSION_ID), eq(BlockEventType.BLOCK_UPSERT),
                withFallback.capture());

        BlockEventType.BlockEventPayload fast = (BlockEventType.BlockEventPayload) withMetadata.getValue();
        BlockEventType.BlockEventPayload slow = (BlockEventType.BlockEventPayload) withFallback.getValue();
        assertEquals(slow.view(), fast.view(), "少读两次库不得改变任何一个字段");
        assertEquals(slow.sessionId(), fast.sessionId());
        assertEquals(slow.turnId(), fast.turnId());
        assertEquals(slow.viewVersion(), fast.viewVersion());
    }

    /** 事件元数据：归属三键齐备（与 {@code ExecutionEventMetadata.of} 同源同格式）。 */
    private static Map<String, Object> metadata() {
        return ExecutionEventMetadata.of(ROOT_SESSION_ID, SESSION_ID, TURN_ID, null, 1L);
    }

    private static ToolCallStartEvent toolStart(Map<String, Object> metadata) {
        return new ToolCallStartEvent(TARGET, Long.toString(EXECUTION_ID), "read_file", "{\"path\":\"a.txt\"}",
                RESPONSE_ID, metadata, 0);
    }

    /**
     * 统计「某表 + WHERE 子句里出现某片段」的语句数。
     *
     * <p><b>只看 WHERE 之后再匹配</b>：{@code chat_turn} 的列清单里本来就有 {@code execution_id}，
     * 若全文匹配列名，主键读也会被算成「按执行 ID 反查」—— 那样这条守卫就永远无法识别真正的回退。</p>
     */
    private static int countWhere(List<String> queries, String table, String whereFragment) {
        int matched = 0;
        for (String query : queries) {
            String sql = SqlCaptureInterceptor.normalize(query);
            int whereIndex = sql.indexOf(" where ");
            if (whereIndex < 0 || !sql.contains("from " + table + " where")) {
                continue;
            }
            if (sql.substring(whereIndex).contains(whereFragment)) {
                matched++;
            }
        }
        return matched;
    }

    /** 统计涉及某张表的语句数；表名后必须是空格，避免 {@code session} 命中 {@code session_message}。 */
    private static int countTables(List<String> queries, String table) {
        int matched = 0;
        for (String query : queries) {
            if (SqlCaptureInterceptor.normalize(query).contains("from " + table + " ")) {
                matched++;
            }
        }
        return matched;
    }

    private void seed(SessionRepositoryImpl sessionRepository, ChatTurnRepositoryImpl chatTurnRepository,
                      SqlSessionTemplate template) {
        sessionRepository.save(Session.builder().id(SESSION_ID).rootSessionId(SESSION_ID)
                .contextTokenCount(120L).contextMaxTokens(400).build());
        sessionRepository.save(Session.builder().id(OTHER_SESSION_ID).rootSessionId(OTHER_SESSION_ID)
                .contextTokenCount(10L).contextMaxTokens(400).build());

        ChatTurnPO turn = ChatTurnPO.builder()
                .id(TURN_ID).sessionId(SESSION_ID).executionId(EXECUTION_ID).status("RUNNING").version(7L)
                .createdAt(Instant.now()).updatedAt(Instant.now())
                .build();
        template.getMapper(ChatTurnMapper.class).insert(turn);

        messageRepository.appendAll(SESSION_ID, ROOT_SESSION_ID, List.of(
                SessionMessage.builder().id(11L).sessionId(SESSION_ID).turnId(TURN_ID)
                        .type(SessionMessageType.USER).text("问题甲").createTime(Instant.now()).build()));
        toolCallRepository.save(toolRow());
        assertTrue(chatTurnRepository.findById(TURN_ID).isPresent(), "前提：轮次行必须落库");
    }

    private static ToolCall toolRow() {
        return ToolCall.builder()
                .id(TARGET).conversationId(SESSION_ID).executionId(EXECUTION_ID)
                .toolName("read_file").type(ToolCallType.EXECUTE).status(ToolCallStatus.COMPLETED)
                .content("{\"kind\":\"PLAN\"}")
                .rawInput("{\"args\":{\"path\":\"a.txt\"}}")
                .rawOutput("{\"outcome\":\"SUCCEEDED\",\"output\":\"读到了\"}")
                .metaData("{\"_meta\":{\"schemaVersion\":1}}")
                .version(3L)
                .createdAt(Instant.now()).updatedAt(Instant.now())
                .build();
    }

    private static CardAvailabilityPolicy cardAvailabilityPolicy() {
        return new CardAvailabilityPolicy(
                new HarnessExecutionGate(mock(ObjectProvider.class), mock(ObjectProvider.class)));
    }
}
