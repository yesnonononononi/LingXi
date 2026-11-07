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
import com.summit.dp.shared.vo.block.Block;
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
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.function.Supplier;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

/**
 * BLOCK_UPSERT 的基线测量：单轮 30 次工具调用下，两条装配口径的 SQL 次数与耗时。
 *
 * <p><b>为什么要有这条用例</b>：计划书 §6.4 要求 Phase 1 开工前先量出真实数字，
 * 文档里的「300+ 次」是推算。同一批数据、同一次运行内给出两条路径的对照，
 * 改造前后跑同一条用例即可并列比对。</p>
 *
 * <p><b>为什么夹具必须把 CLOB 撑过 256 字符</b>：H2 只有结果集里出现超过该阈值的
 * CLOB 才走临时 LOB 落盘路径。短文本会让「整轮重装」看起来不疼，量出来的数字没有意义。</p>
 *
 * <p><b>为什么耗时只打印不断言</b>：绝对毫秒数随机器负载波动（见 wiki「构建与验证」的
 * CI 时间闸门结论），当断言必然 flaky。这里只作为对照量输出。</p>
 */
class SessionBlockUpsertBaselineTest {

    private static final long SESSION_ID = 9701L;
    private static final long TURN_ID = 9801L;
    private static final long EXECUTION_ID = 9901L;
    private static final String TARGET = "call-baseline-00";
    private static final int TOOL_COUNT = 30;
    /** 预热与计时轮次：只求稳定对照，不做统计显著性推断。 */
    private static final int WARMUP_ROUNDS = 30;
    private static final int MEASURED_ROUNDS = 30;

    private final ObjectMapper json = new ObjectMapper();

    private H2TestDatabase database;
    private SqlCaptureInterceptor capture;
    private SessionMessageRepositoryImpl messageRepository;
    private ToolCallRepositoryImpl toolCallRepository;
    private TurnViewService service;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("SessionBlockUpsertBaselineTest");
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
        messageRepository = new SessionMessageRepositoryImpl(
                H2TestDatabase.sqlSession(sessionFactory).getMapper(SessionMessageMapper.class),
                H2TestDatabase.sqlSession(sessionFactory).getMapper(SessionMapper.class));
        toolCallRepository = new ToolCallRepositoryImpl(
                H2TestDatabase.sqlSession(sessionFactory).getMapper(ToolCallMapper.class),
                new ObjectMapper(), cardAvailabilityPolicy());
        service = new TurnViewService(messageRepository, mock(ChatTurnRepository.class), toolCallRepository,
                new TurnViewAssembler(json, new ToolBlockStatusResolver(new ToolCallConverter(json))));
        seedFixture();
    }

    @AfterEach
    void shutdown() {
        if (database != null) {
            database.shutdown();
        }
    }

    @Test
    @DisplayName("单轮 30 工具：打印两条装配口径的 SQL 次数与耗时基线")
    void measureBothAssemblyPaths() {
        // 前提：夹具确实逼出了 H2 的临时 LOB 路径（四个 CLOB 列都超过 256 字符）。
        ToolCall stored = toolCallRepository.findById(TARGET).orElseThrow();
        for (String column : List.of("content", "raw_input", "raw_output", "meta_data")) {
            assertTrue(clobLength(stored, column) > 256, "前提：tool_call." + column + " 必须超过 256 字符");
        }
        assertEquals(TOOL_COUNT, toolCallRepository.listByConversationId(SESSION_ID).size(),
                "前提：本轮工具调用行数必须是 " + TOOL_COUNT);
        assertTrue(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_ID)).stream()
                .filter(row -> row.getType() == SessionMessageType.AI)
                .findFirst().orElseThrow().getText().length() > 256, "前提：AI 行 JSON 必须是长文本");

        Measurement full = measure("full", () -> service
                .assembleTurnView(session(), turn(), VIEW_VERSION)
                .map(view -> onlyBlock(view, ToolBlock.identity(TARGET))));
        Measurement legacySingle = measure("single-legacy", () -> service
                .assembleToolBlockView(session(), turn(), VIEW_VERSION, TARGET));

        // 两条口径的「改造前」事实：都为整轮装载，消息查询带 turn_id in，工具查询是 30 个 id 的 IN。
        assertEquals(1, full.messageSelects(), "整轮装配只发一条 session_message 查询，实际: " + full.queries());
        assertTrue(full.wholeTurnMessageSelect(), "整轮装配的消息查询是按 turn_id IN 取全类型，实际: " + full.queries());
        assertEquals(1, legacySingle.messageSelects(), "单块（消息版）同样只发一条消息查询，实际: " + legacySingle.queries());
        assertTrue(legacySingle.wholeTurnMessageSelect(),
                "单块（消息版）仍在读整轮消息，实际: " + legacySingle.queries());
        assertEquals(1, full.toolCallSelects(), "整轮装配的工具查询是一次 IN，实际: " + full.queries());
        assertEquals(1, legacySingle.toolCallSelects(), "单块的工具查询是一次主键投影，实际: " + legacySingle.queries());

        // 改造后的单块口径（事件事实驱动）：消息侧只发一条带 type 过滤的窄查询，不再整轮 IN。
        Measurement event = measure("event", () -> service
                .assembleToolBlockView(session(), turn(), VIEW_VERSION, eventFacts()));
        assertEquals(1, event.messageSelects(), "事件驱动单块只允许一条消息查询，实际: " + event.queries());
        assertFalse(event.wholeTurnMessageSelect(), "事件驱动单块不得再整轮 IN 全类型，实际: " + event.queries());
        assertTrue(event.narrowTypeFilter(), "事件驱动单块的消息查询必须下推 type 过滤，实际: " + event.queries());
        assertEquals(1, event.toolCallSelects(), "事件驱动单块只允许一条工具投影，实际: " + event.queries());
        assertTrue(event.queries().size() <= 2, "事件驱动单块的语句数必须收敛在 2 条内，实际: " + event.queries());

        System.out.println("BASELINE fixture=tools=" + TOOL_COUNT
                + " aiJsonChars=" + aiJsonChars()
                + " userRowChars=" + userRowChars());
    }

    private void seedFixture() {
        // 用户行 + 一条 AI 行（含 30 个工具请求），全部走仓储落库。
        AiMessageEntity ai = new AiMessageEntity();
        ai.setText("正文".repeat(200));
        ai.setThinking("思考".repeat(200));
        List<ToolCallRequest> requests = new ArrayList<>();
        for (int index = 0; index < TOOL_COUNT; index++) {
            requests.add(new ToolCallRequest(callId(index), "read_file", index,
                    "{\"path\":\"文件-" + index + ".txt\"}"));
        }
        ai.setToolCalls(requests);

        messageRepository.appendAll(SESSION_ID, SESSION_ID, List.of(
                SessionMessage.builder().id(11_001L).sessionId(SESSION_ID).turnId(TURN_ID)
                        .type(SessionMessageType.USER).text("请把 30 个文件都读一遍")
                        .createTime(Instant.now()).build(),
                SessionMessage.builder().id(11_002L).sessionId(SESSION_ID).turnId(TURN_ID)
                        .responseId("9007199254740993").type(SessionMessageType.AI)
                        .text(json.valueToTree(ai).toString()).createTime(Instant.now()).build()));

        for (int index = 0; index < TOOL_COUNT; index++) {
            toolCallRepository.save(heavyRow(callId(index), index));
        }
    }

    private static ToolCall heavyRow(String toolCallId, int index) {
        String heavy = "内容" + index + "-".repeat(4) + "x".repeat(400);
        return ToolCall.builder()
                .id(toolCallId).conversationId(SESSION_ID).executionId(EXECUTION_ID)
                .toolName("read_file").type(ToolCallType.EXECUTE).status(ToolCallStatus.COMPLETED)
                .content("{\"kind\":\"PLAN\",\"text\":\"" + heavy + "\"}")
                .rawInput("{\"args\":{\"path\":\"" + heavy + "\"}}")
                .rawOutput("{\"outcome\":\"SUCCEEDED\",\"output\":\"" + heavy + "\"}")
                .metaData("{\"_meta\":{\"schemaVersion\":1,\"note\":\"" + heavy + "\"}}")
                .version(1L)
                .createdAt(Instant.now()).updatedAt(Instant.now())
                .build();
    }

    /**
     * 先预热再计时，最后打印一行机器可读摘要。
     *
     * <p>预热与计时都必须 {@code clear()}，否则会把铺数据的语句算进被测路径。</p>
     */
    private Measurement measure(String path, Supplier<Optional<TurnViewVO>> invocation) {
        for (int round = 0; round < WARMUP_ROUNDS; round++) {
            capture.clear();
            assertTrue(invocation.get().isPresent(), "预热轮次必须装出一个视图: path=" + path);
        }
        long[] durationsNanos = new long[MEASURED_ROUNDS];
        for (int round = 0; round < MEASURED_ROUNDS; round++) {
            capture.clear();
            long startedAt = System.nanoTime();
            Optional<TurnViewVO> view = invocation.get();
            durationsNanos[round] = System.nanoTime() - startedAt;
            assertTrue(view.isPresent(), "计时轮次必须装出一个视图: path=" + path);
        }
        List<String> queries = capture.queries();
        Measurement measurement = new Measurement(path, queries,
                countMessageSelects(queries), countToolCallSelects(queries),
                hasWholeTurnMessageSelect(queries), hasNarrowTypeFilter(queries),
                medianMillis(durationsNanos), p95Millis(durationsNanos));
        System.out.println(measurement.summaryLine());
        System.out.println("BASELINE-SQL path=" + path + " " + measurement.queries());
        return measurement;
    }

    private static int countMessageSelects(List<String> queries) {
        return (int) queries.stream()
                .filter(entry -> entry.toLowerCase(Locale.ROOT).contains("sessionmessagemapper")
                        && SqlCaptureInterceptor.normalize(entry).contains("from session_message"))
                .count();
    }

    private static int countToolCallSelects(List<String> queries) {
        return (int) queries.stream()
                .filter(entry -> entry.toLowerCase(Locale.ROOT).contains("toolcallmapper")
                        && SqlCaptureInterceptor.normalize(entry).contains("from tool_call"))
                .count();
    }

    /** 「整轮形态」的判据：消息查询按 {@code turn_id in (...)} 取全类型，而不是带 {@code type} 过滤的窄查询。 */
    private static boolean hasWholeTurnMessageSelect(List<String> queries) {
        return queries.stream()
                .map(SqlCaptureInterceptor::normalize)
                .filter(sql -> sql.contains("from session_message"))
                .anyMatch(sql -> sql.contains("turn_id in"));
    }

    /** 「窄查询形态」的判据：消息查询带 {@code type} 等值过滤。 */
    private static boolean hasNarrowTypeFilter(List<String> queries) {
        return queries.stream()
                .map(SqlCaptureInterceptor::normalize)
                .filter(sql -> sql.contains("from session_message"))
                .anyMatch(sql -> sql.contains("type ="));
    }

    /** 事件驱动单块用的权威事实：与 AI 行 JSON 里第 0 个请求逐字一致。 */
    private static ToolBlockEventFacts eventFacts() {
        return new ToolBlockEventFacts(TARGET, "9007199254740993", 0, "read_file",
                "{\"path\":\"文件-0.txt\"}");
    }

    /** 本轮 AI 行的 JSON 字符数：窄查询不再读它，这个数字说明省掉的是多大一列。 */
    private int aiJsonChars() {
        return messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_ID)).stream()
                .filter(row -> row.getType() == SessionMessageType.AI)
                .map(row -> row.getText() == null ? 0 : row.getText().length())
                .findFirst().orElse(0);
    }

    /** 该轮 USER 行的字符数：窄查询只读这些行。 */
    private int userRowChars() {
        return messageRepository.findUserMessages(SESSION_ID, TURN_ID).stream()
                .mapToInt(row -> row.getText() == null ? 0 : row.getText().length()).sum();
    }

    private static double medianMillis(long[] durationsNanos) {
        long[] sorted = durationsNanos.clone();
        Arrays.sort(sorted);
        return round3(sorted[sorted.length / 2] / 1_000_000.0d);
    }

    private static double p95Millis(long[] durationsNanos) {
        long[] sorted = durationsNanos.clone();
        Arrays.sort(sorted);
        int index = (int) Math.ceil(0.95d * sorted.length) - 1;
        return round3(sorted[Math.max(index, 0)] / 1_000_000.0d);
    }

    private static double round3(double value) {
        return Math.round(value * 1000.0d) / 1000.0d;
    }

    private static int clobLength(ToolCall toolCall, String column) {
        return switch (column) {
            case "content" -> toolCall.getContent() == null ? 0 : toolCall.getContent().length();
            case "raw_input" -> toolCall.getRawInput() == null ? 0 : toolCall.getRawInput().length();
            case "raw_output" -> toolCall.getRawOutput() == null ? 0 : toolCall.getRawOutput().length();
            case "meta_data" -> toolCall.getMetaData() == null ? 0 : toolCall.getMetaData().length();
            default -> 0;
        };
    }

    /** 测试侧的独立过滤实现：不复用待测类的私有方法，避免「用实现验证实现」。 */
    private static TurnViewVO onlyBlock(TurnViewVO view, String blockId) {
        List<Block> filtered = view.blocks().stream()
                .filter(block -> blockId.equals(block.getBlockId())).toList();
        assertFalse(filtered.isEmpty(), "整轮装配里必须存在目标块 " + blockId);
        return new TurnViewVO(view.sessionId(), view.turnId(), view.status(), view.viewVersion(),
                view.userMessage(), view.userImageUrls(), filtered, view.metric(), view.userMessageId(),
                view.resumeSupplements(), view.parentTurnId());
    }

    private static String callId(int index) {
        return String.format("call-baseline-%02d", index);
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
        turn.acceptPersistedVersion(VIEW_VERSION);
        return turn;
    }

    private static final long VIEW_VERSION = 9L;

    /** 一次测量的结果；{@code queries} 保留最后一次运行的原始 SQL 摘要，便于人工核对。 */
    private record Measurement(String path, List<String> queries, int messageSelects, int toolCallSelects,
                               boolean wholeTurnMessageSelect, boolean narrowTypeFilter,
                               double medianMs, double p95Ms) {

        String summaryLine() {
            return "BASELINE path=" + path + " statements=" + queries.size()
                    + " msgSelects=" + messageSelects + " toolSelects=" + toolCallSelects
                    + " wholeTurnMsg=" + wholeTurnMessageSelect + " narrowTypeFilter=" + narrowTypeFilter
                    + " medianMs=" + medianMs + " p95Ms=" + p95Ms;
        }
    }
}

