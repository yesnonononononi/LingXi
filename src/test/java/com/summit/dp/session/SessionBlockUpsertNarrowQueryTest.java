package com.summit.dp.session;

import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
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
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.support.SqlCaptureInterceptor;
import com.summit.dp.shared.vo.block.BlockStatus;
import com.summit.dp.shared.vo.block.ToolBlock;
import com.summit.dp.shared.vo.block.TurnViewVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.infrastructure.persistence.mapper.ToolCallMapper;
import com.summit.dp.toolcall.infrastructure.persistence.repository.ToolCallRepositoryImpl;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.TurnModelSnapshot;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.infrastructure.harness.HarnessExecutionGate;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

import java.time.Instant;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

/**
 * 事件驱动单块的真实 SQL 守卫：{@code session_message} 只发一条带 {@code type} 过滤的窄查询。
 *
 * <p><b>为什么断言 SQL 原文而不只断言「方法被调用」</b>：改造的目标就是少读 CLOB 列。
 * 只要有人把窄查询换回 {@code findByTurnIds}（整轮 {@code IN} 全类型），列宽立刻回到改造前，
 * 而「方法被调用」类的断言完全看不出来。</p>
 */
class SessionBlockUpsertNarrowQueryTest {

    private static final long SESSION_ID = 9301L;
    private static final long TURN_ID = 9401L;
    private static final long EXECUTION_ID = 9501L;
    private static final String TARGET = "call-narrow";
    private static final String SIBLING = "call-narrow-sibling";

    private final ObjectMapper json = new ObjectMapper();

    private H2TestDatabase database;
    private SqlCaptureInterceptor capture;
    private TurnViewService service;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("SessionBlockUpsertNarrowQueryTest");
        capture = new SqlCaptureInterceptor();
        MybatisConfiguration configuration = database.configuration(
                SessionMessageMapper.class, SessionMapper.class, ToolCallMapper.class);
        configuration.addInterceptor(capture);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        MybatisPlusInterceptor plugins = new MybatisPlusInterceptor();
        plugins.addInnerInterceptor(new PaginationInnerInterceptor(DbType.H2));
        factory.setPlugins(plugins);
        SqlSessionFactory sessionFactory = factory.getObject();
        SessionMessageRepositoryImpl messageRepository = new SessionMessageRepositoryImpl(
                H2TestDatabase.sqlSession(sessionFactory).getMapper(SessionMessageMapper.class),
                H2TestDatabase.sqlSession(sessionFactory).getMapper(SessionMapper.class));
        ToolCallRepositoryImpl toolCallRepository = new ToolCallRepositoryImpl(
                H2TestDatabase.sqlSession(sessionFactory).getMapper(ToolCallMapper.class),
                new ObjectMapper(), cardAvailabilityPolicy());
        service = new TurnViewService(messageRepository, mock(ChatTurnRepository.class), toolCallRepository,
                new TurnViewAssembler(json, new ToolBlockStatusResolver(new ToolCallConverter(json))));

        seed(messageRepository, toolCallRepository);
        capture.clear();
    }

    @AfterEach
    void shutdown() {
        if (database != null) {
            database.shutdown();
        }
    }

    @Test
    @DisplayName("单次 BLOCK_UPSERT：session_message 一条带 type 过滤的窄查询，tool_call 一条不含三个 CLOB 的投影")
    void blockUpsertIssuesOnlyNarrowQueries() {
        TurnViewVO view = service.assembleToolBlockView(session(), turn(), 3L,
                new ToolBlockEventFacts(TARGET, "9007199254740993", 0, "read_file", "{\"path\":\"a.txt\"}"))
                .orElseThrow();

        List<String> queries = capture.queries();
        List<String> messageQueries = queries.stream()
                .filter(entry -> SqlCaptureInterceptor.normalize(entry).contains("from session_message")).toList();
        List<String> toolQueries = queries.stream()
                .filter(entry -> SqlCaptureInterceptor.normalize(entry).contains("from tool_call")).toList();

        assertEquals(1, messageQueries.size(), "session_message 只允许一条 SELECT，实际: " + queries);
        String messageSql = SqlCaptureInterceptor.normalize(messageQueries.getFirst());
        assertTrue(messageSql.contains("type ="), "消息查询必须下推 type 过滤，实际: " + messageSql);
        assertFalse(messageSql.contains("turn_id in"), "不得是整轮 IN 全类型查询，实际: " + messageSql);
        assertTrue(messageSql.contains("turn_id ="), "归属必须按单个 turn_id 定位，实际: " + messageSql);

        assertEquals(1, toolQueries.size(), "tool_call 只允许一条 SELECT，实际: " + queries);
        String toolSql = SqlCaptureInterceptor.normalize(toolQueries.getFirst());
        assertTrue(toolSql.contains("raw_output"), "工具块状态依赖 raw_output，实际: " + toolSql);
        for (String clob : List.of("content", "raw_input", "meta_data")) {
            assertFalse(toolSql.contains(clob), "投影不得命中 " + clob + "，实际: " + toolSql);
        }

        assertTrue(queries.size() <= 2, "单块推送全程语句数必须收敛到 2 条以内，实际: " + queries);
        assertEquals(0, capture.updates().size(), "推送是只读路径，不得产生写入，实际: " + capture.updates());

        assertEquals(1, view.blocks().size(), "单块视图只有一个块");
        ToolBlock block = (ToolBlock) view.blocks().getFirst();
        assertEquals(ToolBlock.identity(TARGET), block.getBlockId());
        assertEquals(BlockStatus.TOOL_COMPLETED, block.status());
        assertEquals("问题甲", view.userMessage(), "提问仍必须来自该轮 USER 行");
        assertEquals(11L, view.userMessageId(), "用户消息 id 仍必须来自该轮 USER 行");
    }

    @Test
    @DisplayName("整轮路径（对照）：同一批数据仍发整轮 IN 全类型查询，证明守卫能分辨两条口径")
    void wholeTurnPathStillIssuesWholeTurnQuery() {
        service.assembleTurnView(session(), turn(), 3L).orElseThrow();

        List<String> messageQueries = capture.queries().stream()
                .filter(entry -> SqlCaptureInterceptor.normalize(entry).contains("from session_message")).toList();
        assertEquals(1, messageQueries.size(), "整轮路径同样只有一条查询");
        assertTrue(SqlCaptureInterceptor.normalize(messageQueries.getFirst()).contains("turn_id in"),
                "对照：整轮路径就是被改造掉的那种形态，实际: " + messageQueries);
    }

    private void seed(SessionMessageRepositoryImpl messageRepository, ToolCallRepositoryImpl toolCallRepository) {
        AiMessageEntity ai = new AiMessageEntity();
        ai.setText("正文".repeat(200));
        ai.setToolCalls(List.of(
                new ToolCallRequest(TARGET, "read_file", 0, "{\"path\":\"a.txt\"}"),
                new ToolCallRequest(SIBLING, "command", 1, "{\"command\":\"ls\"}")));
        messageRepository.appendAll(SESSION_ID, SESSION_ID, List.of(
                SessionMessage.builder().id(11L).sessionId(SESSION_ID).turnId(TURN_ID)
                        .type(SessionMessageType.USER).text("问题甲").createTime(Instant.now()).build(),
                SessionMessage.builder().id(12L).sessionId(SESSION_ID).turnId(TURN_ID)
                        .responseId("9007199254740993").type(SessionMessageType.AI)
                        .text(json.valueToTree(ai).toString()).createTime(Instant.now()).build()));
        toolCallRepository.save(heavyRow(TARGET));
        toolCallRepository.save(heavyRow(SIBLING));
    }

    private static ToolCall heavyRow(String toolCallId) {
        String heavy = "内容".repeat(200);
        return ToolCall.builder()
                .id(toolCallId).conversationId(SESSION_ID).executionId(EXECUTION_ID)
                .toolName("read_file").type(ToolCallType.EXECUTE).status(ToolCallStatus.COMPLETED)
                .content("{\"kind\":\"PLAN\",\"text\":\"" + heavy + "\"}")
                .rawInput("{\"args\":{\"path\":\"" + heavy + "\"}}")
                .rawOutput("{\"outcome\":\"SUCCEEDED\",\"output\":\"" + heavy + "\"}")
                .metaData("{\"_meta\":{\"schemaVersion\":1,\"note\":\"" + heavy + "\"}}")
                .version(4L)
                .createdAt(Instant.now()).updatedAt(Instant.now())
                .build();
    }

    private static CardAvailabilityPolicy cardAvailabilityPolicy() {
        return new CardAvailabilityPolicy(
                new HarnessExecutionGate(mock(ObjectProvider.class), mock(ObjectProvider.class)));
    }

    private static Session session() {
        return Session.builder().id(SESSION_ID).rootSessionId(SESSION_ID)
                .contextTokenCount(100L).contextMaxTokens(200).build();
    }

    private static ChatTurn turn() {
        ChatTurn turn = ChatTurn.accept(TURN_ID, SESSION_ID, null,
                TurnModelSnapshot.of("deepseek-chat", "deepseek", null));
        turn.acceptPersistedVersion(3L);
        return turn;
    }
}
