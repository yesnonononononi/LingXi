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
import com.summit.dp.session.domain.repo.MessageRepository;
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

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 单块推送路径的真实 SQL 守卫：一次目标工具 SELECT，且只读 {@code raw_output}。
 *
 * <p>等价性用例（{@code BlockUpsertSingleBlockTest}）证明「装出来一样」，本类证明「读得少」：
 * 走真实的 {@link ToolCallRepositoryImpl}（H2），断言整条单块路径上 {@code tool_call}
 * 只下发一条 SELECT，且 SQL 里<b>不出现</b> {@code content} / {@code raw_input} / {@code meta_data}
 * 三个 CLOB 列 —— 工具越多、输出越大，这三列就是 H2 临时 LOB 写放大的主要来源。</p>
 */
class SessionBlockUpsertSqlGuardTest {

    private static final long SESSION_ID = 9101L;
    private static final long TURN_ID = 9201L;
    private static final String TARGET = "call-target";

    private final ObjectMapper json = new ObjectMapper();
    private final MessageRepository messageRepository = mock(MessageRepository.class);

    private H2TestDatabase database;
    private SqlCaptureInterceptor capture;
    private ToolCallRepositoryImpl toolCallRepository;
    private TurnViewService service;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("SessionBlockUpsertSqlGuardTest");
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
        toolCallRepository = new ToolCallRepositoryImpl(
                H2TestDatabase.sqlSession(sessionFactory).getMapper(ToolCallMapper.class),
                new ObjectMapper(), cardAvailabilityPolicy());
        service = new TurnViewService(messageRepository, mock(ChatTurnRepository.class), toolCallRepository,
                new TurnViewAssembler(json, new ToolBlockStatusResolver(new ToolCallConverter(json))));

        toolCallRepository.save(heavyRow());
        when(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_ID))).thenReturn(turnMessages());
        when(messageRepository.findUserMessages(SESSION_ID, TURN_ID)).thenReturn(turnMessages());
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("单块路径只发一条 tool_call SELECT，且 SQL 不含 content/raw_input/meta_data")
    void singleBlockIssuesOneNarrowSelect() {
        // 前提：三列在库里确实是大字段（否则「没读到 CLOB」的断言没有意义）。
        ToolCall stored = toolCallRepository.findById(TARGET).orElseThrow();
        assertTrue(stored.getContent().length() > 256, "前提：content 必须是大字段");
        assertTrue(stored.getRawInput().length() > 256, "前提：raw_input 必须是大字段");
        assertTrue(stored.getMetaData().length() > 256, "前提：meta_data 必须是大字段");
        assertTrue(stored.getRawOutput().length() > 256, "前提：raw_output 必须是大字段");

        capture.clear();
        TurnViewVO view = service.assembleToolBlockView(session(), turn(), 5L,
                new ToolBlockEventFacts(TARGET, "9007199254740993", 0, "read_file", "{\"path\":\"a\"}"))
                .orElseThrow();

        List<String> toolCallQueries = capture.queries().stream()
                .filter(entry -> entry.toLowerCase().contains("toolcallmapper"))
                .toList();
        assertEquals(1, toolCallQueries.size(), "目标工具行只应查一次，实际: " + toolCallQueries);
        String sql = SqlCaptureInterceptor.normalize(toolCallQueries.getFirst());
        assertTrue(sql.contains("raw_output"), "工具块状态依赖 raw_output，必须保留，实际: " + sql);
        for (String clob : List.of("content", "raw_input", "meta_data")) {
            assertFalse(sql.contains(clob), "投影不得命中 " + clob + "，实际: " + sql);
        }

        assertEquals(1, view.blocks().size(), "单块视图只有一个块");
        ToolBlock block = (ToolBlock) view.blocks().getFirst();
        assertEquals(ToolBlock.identity(TARGET), block.getBlockId());
        assertEquals(BlockStatus.TOOL_COMPLETED, block.getStatus(), "状态仍由 raw_output 的 outcome 判定");
        assertEquals(stored.getRawOutput(), block.output(), "完整 raw_output 必须下发");
        assertEquals(stored.getVersion(), block.version());
        assertEquals(5L, view.viewVersion());
    }

    private static CardAvailabilityPolicy cardAvailabilityPolicy() {
        return new CardAvailabilityPolicy(
                new HarnessExecutionGate(mock(ObjectProvider.class), mock(ObjectProvider.class)));
    }

    private List<SessionMessage> turnMessages() {
        SessionMessage user = SessionMessage.builder().id(11L).sessionId(SESSION_ID).turnId(TURN_ID)
                .type(SessionMessageType.USER).text("问题甲").createTime(Instant.now()).build();
        AiMessageEntity ai = new AiMessageEntity();
        ai.setText("正文");
        ai.setToolCalls(List.of(new ToolCallRequest(TARGET, "read_file", 0, "{\"path\":\"a\"}")));
        SessionMessage aiRow = SessionMessage.builder().id(12L).sessionId(SESSION_ID).turnId(TURN_ID)
                .responseId("12").type(SessionMessageType.AI)
                .text(json.valueToTree(ai).toString()).createTime(Instant.now()).build();
        return List.of(user, aiRow);
    }

    private static ToolCall heavyRow() {
        String heavy = "内容".repeat(2000);
        return ToolCall.builder()
                .id(TARGET).conversationId(SESSION_ID).executionId(SESSION_ID * 10)
                .toolName("read_file").type(ToolCallType.EXECUTE).status(ToolCallStatus.COMPLETED)
                .content("{\"kind\":\"PLAN\",\"text\":\"" + heavy + "\"}")
                .rawInput("{\"args\":{\"path\":\"" + heavy + "\"}}")
                .rawOutput("{\"outcome\":\"SUCCEEDED\",\"output\":\"" + heavy + "\"}")
                .metaData("{\"_meta\":{\"schemaVersion\":1,\"note\":\"" + heavy + "\"}}")
                .version(4L)
                .createdAt(Instant.now()).updatedAt(Instant.now())
                .build();
    }

    private static Session session() {
        return Session.builder().id(SESSION_ID).rootSessionId(SESSION_ID)
                .contextTokenCount(100L).contextMaxTokens(200).build();
    }

    private static ChatTurn turn() {
        ChatTurn turn = ChatTurn.accept(TURN_ID, SESSION_ID, null,
                TurnModelSnapshot.of("deepseek-chat", "deepseek", null));
        turn.acceptPersistedVersion(5L);
        return turn;
    }
}
