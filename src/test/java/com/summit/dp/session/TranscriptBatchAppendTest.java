package com.summit.dp.session;

import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.dp.session.application.convert.TranscriptRecordAssembler;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.session.application.service.TranscriptReplayMatcher;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMapper;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMessageMapper;
import com.summit.dp.session.infrastructure.persistence.repository.SessionMessageRepositoryImpl;
import com.summit.dp.session.infrastructure.persistence.repository.SessionRepositoryImpl;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.support.SqlCaptureInterceptor;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.infrastructure.persistence.mapper.ToolCallMapper;
import com.summit.dp.toolcall.infrastructure.persistence.repository.ToolCallRepositoryImpl;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.workflow.infrastructure.config.JsonConfig;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.summit.dp.workflow.infrastructure.harness.HarnessExecutionGate;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyMap;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;

/**
 * 转录批量写入的真实 SQL 守卫：一轮 30 工具 = 1 条 INSERT + 1 条 UPDATE。
 *
 * <p><b>为什么断言语句条数而不只断言「方法被调用」</b>：改造的收益就是往返次数。
 * 把批量改回逐行循环时，「方法被调用」类的断言照样绿，只有语句条数会变红。</p>
 *
 * <p><b>为什么必须真 H2 真事务</b>：主键是否丢、锚点是否绑对、抛异常时是否整体回滚，
 * 都是数据库侧事实，mock 一个都验不出来。</p>
 */
class TranscriptBatchAppendTest {

    /**
     * 会话主键不再是写死的常量：AGENTS.md 要求夹具的业务数据也走仓储，
     * 而仓储的主键由 identity 生成，所以落库后回填。
     */
    private long sessionId;
    private static final long TURN_ID = 5201L;
    private static final long EXECUTION_ID = 5301L;
    private static final String RESPONSE_ID = "9007199254740993";
    private static final int TOOL_COUNT = 30;

    private H2TestDatabase database;
    private SqlCaptureInterceptor capture;
    private SessionRepositoryImpl sessionRepository;
    private SessionMessageRepositoryImpl messageRepository;
    private ToolCallRepositoryImpl toolCallRepository;
    private ConversationTranscriptService service;
    private TransactionTemplate transaction;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("TranscriptBatchAppendTest");
        capture = new SqlCaptureInterceptor();
        MybatisConfiguration configuration = database.configuration(
                SessionMapper.class, SessionMessageMapper.class, ToolCallMapper.class);
        configuration.addInterceptor(capture);
        MybatisSqlSessionFactoryBean factory = new MybatisSqlSessionFactoryBean();
        factory.setDataSource(database);
        factory.setConfiguration(configuration);
        MybatisPlusInterceptor plugins = new MybatisPlusInterceptor();
        plugins.addInnerInterceptor(new PaginationInnerInterceptor(com.baomidou.mybatisplus.annotation.DbType.H2));
        factory.setPlugins(plugins);
        SqlSessionFactory sessionFactory = factory.getObject();
        SqlSessionTemplate template = H2TestDatabase.sqlSession(sessionFactory);

        SessionMapper sessionMapper = template.getMapper(SessionMapper.class);
        sessionRepository = new SessionRepositoryImpl(sessionMapper);
        messageRepository = new SessionMessageRepositoryImpl(
                template.getMapper(SessionMessageMapper.class), sessionMapper);
        toolCallRepository = new ToolCallRepositoryImpl(template.getMapper(ToolCallMapper.class),
                new ObjectMapper(), cardAvailabilityPolicy());
        JsonConfig jsonConfig = new JsonConfig();
        service = new ConversationTranscriptService(messageRepository, toolCallRepository,
                new TranscriptRecordAssembler(jsonConfig.objectMapper()),
                new TranscriptReplayMatcher(jsonConfig.objectMapper()));

        DataSource dataSource = database;
        transaction = new TransactionTemplate(new DataSourceTransactionManager(dataSource));
        insertSessionRow();
        seedToolCalls();
        capture.clear();
    }

    @AfterEach
    void shutdown() {
        if (database != null) {
            database.shutdown();
        }
    }

    @Test
    @DisplayName("一次 append 30 消息 + 30 锚点：INSERT 1 条、UPDATE 1 条，ID 不丢不重排")
    void appendRoundIssuesOneInsertAndOneBind() {
        appendRound();

        List<String> inserts = statements("insert into session_message");
        List<String> binds = statements("update tool_call");
        assertEquals(1, inserts.size(), "消息必须一次批量插入，实际: " + capture.updates());
        assertEquals(1, binds.size(), "锚点必须一次批量绑定，实际: " + capture.updates());

        List<SessionMessage> stored = messageRepository.findByTurnIds(sessionId, List.of(TURN_ID));
        assertEquals(TOOL_COUNT + 1, stored.size(), "1 条 AI + 30 条 TOOL 必须整批落库");
        assertEquals(SessionMessageType.AI, stored.getFirst().getType(), "按主键升序时 AI 行必须在最前（顺序未重排）");
        for (SessionMessage row : stored) {
            assertNotNull(row.getId(), "主键不得丢失");
            assertEquals(Long.valueOf(sessionId), row.getSessionId());
            assertEquals(TURN_ID, row.getTurnId());
            assertNotNull(row.getCreateTime(), "create_time 不得丢失");
        }
        AiMessageEntity expectedAi = aiMessage();
        assertTrue(stored.getFirst().getText().contains(expectedAi.getText()), "AI 行正文必须落在 content 列");
        List<String> storedCallIds = stored.stream()
                .filter(row -> row.getType() == SessionMessageType.TOOL)
                .map(SessionMessage::getText).toList();
        assertEquals(callIds(), storedCallIds, "TOOL 行顺序与内容必须与输入逐一对应（无列错位）");

        // 锚点指向的必须正是承载该 call id 的那一行：错位会在这里暴露。
        Map<String, Long> messageIdByCallId = new LinkedHashMap<>();
        for (SessionMessage row : stored) {
            if (row.getType() == SessionMessageType.TOOL) {
                messageIdByCallId.put(row.getText(), row.getId());
            }
        }
        for (String callId : callIds()) {
            ToolCall toolCall = toolCallRepository.findById(callId).orElseThrow();
            assertEquals(messageIdByCallId.get(callId), toolCall.getSessionMessageId(),
                    "锚点必须指向同一条 TOOL 行: " + callId);
            assertEquals(2L, toolCall.getVersion(), "绑定必须自增版本号（初值 1 → 2）: " + callId);
        }
    }

    @Test
    @DisplayName("无需更新时 bind 返回 0 行，且只发一条 UPDATE、不发任何查询")
    void secondBindWithoutChangeReturnsZero() {
        appendRound();
        Map<String, Long> currentBindings = currentBindings();

        capture.clear();
        int changed = transaction.execute(status -> toolCallRepository.bindSessionMessagesBatch(currentBindings));

        assertEquals(0, changed, "锚点已存在且相同，不应产生实际更新");
        assertEquals(1, capture.updates().size(), "仍需且仅需一条参数绑定的 UPDATE，实际: " + capture.updates());
        assertTrue(capture.queries().isEmpty(), "批量绑定不得为逐行判断再发查询，实际: " + capture.queries());
    }

    @Test
    @DisplayName("重放同一轮（幂等）：不再插入、再 bind 返回 0，且库内锚点与版本原封不动")
    void replayingSameRoundIsIdempotent() {
        appendRound();
        long before = messageRepository.countBySessionId(sessionId);
        // 第一次绑定后的库内事实：重放必须以它为准，不能被一次「0 行更新」悄悄改写。
        Map<String, Long> anchorAfterFirstBind = currentBindings();
        Map<String, Long> versionAfterFirstBind = currentVersions();

        capture.clear();
        appendRound();

        assertTrue(statements("insert into session_message").isEmpty(), "重放不得再次插入，实际: " + capture.updates());
        assertEquals(before, messageRepository.countBySessionId(sessionId), "重放后行数不变");
        int rebound = transaction.execute(status ->
                toolCallRepository.bindSessionMessagesBatch(anchorAfterFirstBind));
        assertEquals(0, rebound, "重放后的再次绑定应为 0 行");

        // 直接查库：0 行更新的语义是「什么都没改」，不是「又自增了一次版本」。
        for (String callId : callIds()) {
            ToolCall reread = toolCallRepository.findById(callId).orElseThrow();
            assertEquals(anchorAfterFirstBind.get(callId), reread.getSessionMessageId(),
                    "重放后 session_message_id 不得变动: " + callId);
            assertEquals(versionAfterFirstBind.get(callId), reread.getVersion(),
                    "重放后 version 不得自增: " + callId);
            assertEquals(2L, reread.getVersion().longValue(),
                    "版本必须停在第一次绑定后的值（1 → 2），不得因 0 行更新再涨: " + callId);
        }
    }

    @Test
    @DisplayName("持有旧版本的写入方仍能看到冲突（version 不得被放宽）")
    void staleVersionWriterSeesConflict() {
        appendRound();
        String callId = callIds().getFirst();
        ToolCall stale = toolCallRepository.findById(callId).orElseThrow();
        assertEquals(2L, stale.getVersion(), "前提：绑定后版本已是 2");
        Long boundMessageId = stale.getSessionMessageId();
        assertNotNull(boundMessageId, "前提：锚点已绑定");

        // 模拟持有旧快照（version=1）的写入方：条件更新匹配不到行，必须当冲突处理。
        stale.acceptPersistedVersion(1L);
        assertThrows(ClientException.class, () -> transaction.executeWithoutResult(
                status -> toolCallRepository.updateById(stale)), "旧版本写入必须被拒绝，不能静默覆盖");

        ToolCall reloaded = toolCallRepository.findById(callId).orElseThrow();
        assertEquals(2L, reloaded.getVersion(), "被拒绝的更新不得推进版本");
        assertEquals(boundMessageId, reloaded.getSessionMessageId(), "被拒绝的更新不得抹掉锚点");
    }

    @Test
    @DisplayName("事务内抛异常：消息与锚点都不落库")
    void failureInsideTransactionLeavesNothingBehind() {
        long before = messageRepository.countBySessionId(sessionId);

        assertThrows(IllegalStateException.class, () -> transaction.executeWithoutResult(status -> {
            appendRoundInTransaction();
            throw new IllegalStateException("模拟落库后失败");
        }));

        assertEquals(before, messageRepository.countBySessionId(sessionId), "失败后消息行不得残留");
        for (String callId : callIds()) {
            assertNull(toolCallRepository.findById(callId).orElseThrow().getSessionMessageId(),
                    "失败后锚点不得残留: " + callId);
        }
    }

    @Test
    @DisplayName("锚点批量绑定失败：日志仍能定位到具体 callId，而不是只剩条数")
    void bindFailureLogKeepsCallIdLocatability() {
        ToolCallRepository failing = mock(ToolCallRepository.class);
        doThrow(new IllegalStateException("stub-bind-failure"))
                .when(failing).bindSessionMessagesBatch(anyMap());
        JsonConfig jsonConfig = new JsonConfig();
        ConversationTranscriptService lossyService = new ConversationTranscriptService(
                messageRepository, failing,
                new TranscriptRecordAssembler(jsonConfig.objectMapper()),
                new TranscriptReplayMatcher(jsonConfig.objectMapper()));

        Logger logger = (Logger) LoggerFactory.getLogger(ConversationTranscriptService.class);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        logger.addAppender(appender);
        try {
            transaction.executeWithoutResult(status -> lossyService.appendRound(
                    sessionId, sessionId, TURN_ID, aiMessage(), toolMessages(), RESPONSE_ID));
        } finally {
            logger.detachAppender(appender);
        }

        String logged = appender.list.stream()
                .map(ILoggingEvent::getFormattedMessage)
                .filter(text -> text.contains("回填工具消息锚点失败"))
                .findFirst()
                .orElseThrow(() -> new AssertionError("缺少回填失败日志，事件数=" + appender.list.size()));
        assertTrue(logged.contains("条数=" + TOOL_COUNT), "失败日志必须给出条数: " + logged);
        assertTrue(logged.contains("callId=call-batch-00,call-batch-01,call-batch-02,..."),
                "失败日志必须给出前 3 个 callId 并以省略号收尾（排障要能看出是哪个锚点）: " + logged);
    }

    private void appendRound() {
        transaction.executeWithoutResult(status -> appendRoundInTransaction());
    }

    private void appendRoundInTransaction() {
        service.appendRound(sessionId, sessionId, TURN_ID, aiMessage(), toolMessages(), RESPONSE_ID);
    }

    /** 与 {@code statementId :: sql} 记录匹配的写入语句（小写、去空白后包含即可）。 */
    private List<String> statements(String fragment) {
        return capture.updates().stream()
                .filter(entry -> SqlCaptureInterceptor.normalize(entry).contains(fragment))
                .toList();
    }

    private Map<String, Long> currentBindings() {
        Map<String, Long> bindings = new LinkedHashMap<>();
        for (String callId : callIds()) {
            bindings.put(callId, toolCallRepository.findById(callId).orElseThrow().getSessionMessageId());
        }
        return bindings;
    }

    /** 读回库内当前版本号，用于断言「0 行更新」没有顺手改写既有事实。 */
    private Map<String, Long> currentVersions() {
        Map<String, Long> versions = new LinkedHashMap<>();
        for (String callId : callIds()) {
            versions.put(callId, toolCallRepository.findById(callId).orElseThrow().getVersion());
        }
        return versions;
    }

    /**
     * 会话行也走仓储，不再 {@code database.execute} 直写。
     *
     * <p>为什么必须走仓储：AGENTS.md 要求测试里的业务数据准备与查询同样经 Mapper/仓储，
     * 建表脚本由测试框架的脚本执行器加载；直写 SQL 会绕过列映射与主键策略，
     * 一旦表结构变化，夹具会静默脱离生产写入路径。</p>
     */
    private void insertSessionRow() {
        Long created = sessionRepository.saveAndReturnId(Session.builder()
                .rootSessionId(Session.ROOT_SESSION_ID)
                .name("批量写作会话")
                .build());
        assertNotNull(created, "会话落库后必须拿到主键");
        sessionId = created;
    }

    private void seedToolCalls() {
        for (String callId : callIds()) {
            toolCallRepository.save(ToolCall.builder()
                    .id(callId).conversationId(sessionId).executionId(EXECUTION_ID)
                    .toolName("read_file").type(ToolCallType.EXECUTE).status(ToolCallStatus.COMPLETED)
                    .content("{\"kind\":\"PLAN\"}")
                    .rawInput("{\"args\":{\"path\":\"文件.txt\"}}")
                    .rawOutput("{\"outcome\":\"SUCCEEDED\"}")
                    .metaData("{\"_meta\":{\"schemaVersion\":1}}")
                    .version(1L)
                    .createdAt(Instant.now()).updatedAt(Instant.now())
                    .build());
        }
    }

    private static AiMessageEntity aiMessage() {
        AiMessageEntity ai = new AiMessageEntity();
        ai.setText("一次读完 30 个文件");
        List<ToolCallRequest> requests = new ArrayList<>();
        for (int index = 0; index < TOOL_COUNT; index++) {
            requests.add(new ToolCallRequest(callId(index), "read_file", index,
                    "{\"path\":\"文件-" + index + ".txt\"}"));
        }
        ai.setToolCalls(requests);
        return ai;
    }

    private static List<ToolMessageEntity> toolMessages() {
        List<ToolMessageEntity> messages = new ArrayList<>();
        for (int index = 0; index < TOOL_COUNT; index++) {
            messages.add(ToolMessageEntity.builder()
                    .id(callId(index)).name("read_file").toolOutput("第 " + index + " 个文件的内容").build());
        }
        return messages;
    }

    private static List<String> callIds() {
        List<String> ids = new ArrayList<>();
        for (int index = 0; index < TOOL_COUNT; index++) {
            ids.add(callId(index));
        }
        return ids;
    }

    private static String callId(int index) {
        return String.format("call-batch-%02d", index).toLowerCase(Locale.ROOT);
    }

    private static CardAvailabilityPolicy cardAvailabilityPolicy() {
        return new CardAvailabilityPolicy(
                new HarnessExecutionGate(mock(ObjectProvider.class), mock(ObjectProvider.class)));
    }
}
