package com.summit.dp.session;

import com.baomidou.mybatisplus.annotation.DbType;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.extension.plugins.MybatisPlusInterceptor;
import com.baomidou.mybatisplus.extension.plugins.inner.PaginationInnerInterceptor;
import com.baomidou.mybatisplus.extension.spring.MybatisSqlSessionFactoryBean;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.domain.repository.AgentRepository;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.session.application.convert.SessionMessageViewAssembler;
import com.summit.dp.session.application.convert.ToolBlockStatusResolver;
import com.summit.dp.session.application.convert.TurnViewAssembler;
import com.summit.dp.session.application.service.SessionAggregateService;
import com.summit.dp.session.application.service.SessionMessageQueryService;
import com.summit.dp.session.application.service.TurnViewService;
import com.summit.dp.session.application.service.impl.SessionServiceImpl;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.session.infrastructure.persistence.repository.SessionMessageRepositoryImpl;
import com.summit.dp.shared.model.CursorResult;
import com.summit.dp.shared.support.H2TestDatabase;
import com.summit.dp.shared.support.SqlCaptureInterceptor;
import com.summit.dp.shared.vo.SessionMessagePageVO;
import com.summit.dp.shared.vo.SessionMessageVO;
import com.summit.dp.shared.vo.block.Block;
import com.summit.dp.shared.vo.block.BlockStatus;
import com.summit.dp.shared.vo.block.ToolBlock;
import com.summit.dp.shared.vo.block.TurnViewVO;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.application.service.CardAvailabilityPolicy;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.infrastructure.persistence.mapper.ToolCallMapper;
import com.summit.dp.toolcall.infrastructure.persistence.repository.ToolCallRepositoryImpl;
import com.summit.dp.turn.application.convert.ChatTurnConverter;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.TurnModelSnapshot;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workspace.application.service.WorkspaceService;
import com.summit.dp.workflow.infrastructure.harness.HarnessExecutionGate;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;

/**
 * 历史分页的装配块必须复用当页已查出的消息，且同一批工具调用只读一次。
 *
 * <p>本类走的是<b>真正的调用方调用链</b>（{@code SessionServiceImpl#messages} →
 * 真实 {@link SessionMessageQueryService} → 真实 {@link TurnViewService} →
 * 真实 {@link ToolCallRepositoryImpl}（H2）），三者共享同一个仓储实例；只 mock
 * {@code messageSlice} / {@code chatTurnService.findByIds} 这类外部输入。</p>
 *
 * <p>为什么必须用真仓储：把 {@code messageQueryService} 换成 mock 之后，「query 内查一次 +
 * 装配再查一次」的双读照样全绿 —— 假绿。这里的判据是<b>真实下发的 SQL 条数</b>：
 * 单页 {@code tool_call} SELECT 恰好 1 次。</p>
 */
class SessionMessagesBlockViewsTest {

    private static final long SESSION_ID = 6101L;
    private static final long TURN_A = 7101L;
    private static final long TURN_B = 7102L;
    private static final long VERSION_A = 4L;
    private static final long VERSION_B = 9L;

    private final ObjectMapper json = new ObjectMapper();
    private final SessionAggregateService aggregateService = mock(SessionAggregateService.class);
    private final ChatTurnService chatTurnService = mock(ChatTurnService.class);
    /** 消息仓储保持 mock：本路径的消息来自当页切片，任何按轮回查都该被抓到。 */
    private final MessageRepository messageRepository = mock(MessageRepository.class);

    private H2TestDatabase database;
    private SqlCaptureInterceptor capture;
    private ToolCallRepositoryImpl toolCallRepository;
    private SessionServiceImpl sessionService;

    @BeforeEach
    void setup() throws Exception {
        database = H2TestDatabase.create("SessionMessagesBlockViewsTest");
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

        // 真实装配链：三者共享同一个 toolCallRepository（这正是「同一批只读一次」的前提）。
        TurnViewAssembler assembler = new TurnViewAssembler(json,
                new ToolBlockStatusResolver(new ToolCallConverter(json)));
        TurnViewService turnViewService = new TurnViewService(
                messageRepository, mock(ChatTurnRepository.class), toolCallRepository, assembler);
        SessionMessageQueryService queryService = new SessionMessageQueryService(
                new SessionMessageViewAssembler(json, new ToolCallConverter(json)),
                new ToolCallConverter(json), mock(SessionMessageRepositoryImpl.class));
        sessionService = new SessionServiceImpl(
                aggregateService, mock(WorkspaceService.class), mock(SessionRepository.class),
                queryService, mock(ExecutionQueryService.class), mock(TeamService.class),
                mock(AgentRepository.class), chatTurnService, new ChatTurnConverter(), turnViewService);

        toolCallRepository.save(completedCall("call-a1"));
        toolCallRepository.save(runningCall("call-b1"));
        toolCallRepository.save(completedCall("call-o1"));
        stubPage();
    }

    @AfterEach
    void shutdown() {
        database.shutdown();
    }

    @Test
    @DisplayName("单页 tool_call SELECT 恰好一次：消息 VO 挂载与按轮装配共用同一批权威调用")
    void pageLoadsToolCallsExactlyOnce() {
        capture.clear();
        Result<SessionMessagePageVO> result = sessionService.messages(SESSION_ID, null, 50);

        List<String> toolCallQueries = capture.queries().stream()
                .filter(entry -> entry.toLowerCase().contains("toolcallmapper"))
                .toList();
        assertEquals(1, toolCallQueries.size(),
                "单页 tool_call 只能查一次（挂载 + 装配共用），实际: " + toolCallQueries);
        String sql = SqlCaptureInterceptor.normalize(toolCallQueries.getFirst());
        assertTrue(sql.contains(" in ("), "必须是一次 IN 批量查询，实际: " + sql);

        // 本页消息全部来自切片：按轮回查一次都不许发。
        verify(messageRepository, never()).findByTurnIds(anyLong(), any());
        verify(messageRepository, never()).findBySessionId(anyLong());

        SessionMessagePageVO page = result.getData();
        assertEquals(3, page.getToolCallCount(), "三个 TOOL 行（含孤儿行）都必须挂上权威调用");
        assertEquals(List.of("call-a1", "call-b1", "call-o1"), page.getRecords().stream()
                .filter(record -> record.getToolCall() != null)
                .map(SessionMessageVO::getToolCallId).toList());
        assertTrue(page.getRecords().stream()
                        .filter(record -> "call-o1".equals(record.getToolCallId()))
                        .allMatch(record -> record.getToolCall().getRawOutput() != null),
                "孤儿 TOOL 行（turn_id 为 null）也要挂上卡片");
    }

    @Test
    @DisplayName("按轮装配逐字段对照：两轮各带自己的工具块，缺行仍出 TOOL_STARTED，版本号取自身")
    void turnViewsMatchFieldsPerTurn() {
        Result<SessionMessagePageVO> result = sessionService.messages(SESSION_ID, null, 50);
        Map<String, TurnViewVO> views = result.getData().getTurnViews();

        assertEquals(2, views.size(), "孤儿行不构成轮次视图");
        assertEquals(VERSION_A, views.get(String.valueOf(TURN_A)).viewVersion(), "每轮版本号取自身");
        assertEquals(VERSION_B, views.get(String.valueOf(TURN_B)).viewVersion());

        TurnViewVO viewA = views.get(String.valueOf(TURN_A));
        assertEquals("问题甲", viewA.userMessage());
        assertEquals(1L, viewA.userMessageId(), "userMessageId 取该轮最早的 USER 行");
        ToolBlock blockA1 = toolBlock(viewA, "call-a1");
        assertEquals(BlockStatus.TOOL_COMPLETED, blockA1.status());
        assertEquals("read_file", blockA1.toolName(), "工具名以权威行为准");
        assertEquals("{\"path\":\"a\"}", blockA1.arguments(), "参数取模型请求的原文");
        assertTrue(blockA1.output().contains("输出正文"), "完整 raw_output 必须下发");
        assertEquals(toolCallRepository.findById("call-a1").orElseThrow().getVersion(), blockA1.version());

        TurnViewVO viewB = views.get(String.valueOf(TURN_B));
        assertEquals(2, viewB.blocks().stream().filter(block -> block.getBlockId().startsWith("tool:")).count(),
                "该轮两个工具请求都要装出块（其中一个尚无 TOOL 行）");
        ToolBlock blockB1 = toolBlock(viewB, "call-b1");
        assertEquals(BlockStatus.TOOL_STARTED, blockB1.status(), "进行中的工具按「已开始」展示");
        ToolBlock blockB2 = toolBlock(viewB, "call-b2");
        assertEquals(BlockStatus.TOOL_STARTED, blockB2.status(), "仅 AI 请求、无 TOOL 行也必须出块");
        assertEquals("command", blockB2.toolName(), "缺行时工具名回退为模型请求里的名字");
        assertNull(blockB2.output(), "缺行时不得编造输出");
        assertNull(blockB2.version(), "缺行时没有权威版本号");
    }

    private void stubPage() {
        when(aggregateService.requireOwned(SESSION_ID)).thenReturn(
                Session.builder().id(SESSION_ID).rootSessionId(0L).historyRevision(1L).build());
        // 当页：两轮各含 USER / AI / TOOL（第二轮的目标工具尚未落库），外加一条孤儿 TOOL 行。
        when(aggregateService.messageSlice(SESSION_ID, null, 50)).thenReturn(new CursorResult<>(List.of(
                userRow(1L, TURN_A, "问题甲"),
                aiRow(2L, TURN_A, List.of(new ToolCallRequest("call-a1", "read_file", 0, "{\"path\":\"a\"}"))),
                toolRow(3L, TURN_A, "call-a1"),
                userRow(4L, TURN_B, "问题乙"),
                aiRow(5L, TURN_B, List.of(new ToolCallRequest("call-b1", "read_file", 0, "{\"path\":\"b\"}"),
                        new ToolCallRequest("call-b2", "command", 1, "{\"command\":\"ls\"}"))),
                toolRow(6L, TURN_B, "call-b1"),
                toolRow(7L, null, "call-o1")), null, false));
        Map<Long, ChatTurn> turns = new LinkedHashMap<>();
        turns.put(TURN_A, turn(TURN_A, VERSION_A));
        turns.put(TURN_B, turn(TURN_B, VERSION_B));
        when(chatTurnService.findByIds(any())).thenReturn(turns);
    }

    /** 卡片可用性策略：本用例只走装配与 SQL 计数，执行闸门查询用空桩即可。 */
    private static CardAvailabilityPolicy cardAvailabilityPolicy() {
        return new CardAvailabilityPolicy(
                new HarnessExecutionGate(mock(ObjectProvider.class), mock(ObjectProvider.class)));
    }

    /** 不复用待测类的过滤逻辑：直接按 blockId 精确取。 */
    private static ToolBlock toolBlock(TurnViewVO view, String toolCallId) {
        String blockId = ToolBlock.identity(toolCallId);
        return view.blocks().stream()
                .filter(block -> blockId.equals(block.getBlockId()))
                .map(ToolBlock.class::cast)
                .findFirst()
                .orElseThrow(() -> new AssertionError("缺少工具块: " + blockId + "，实际: "
                        + view.blocks().stream().map(Block::getBlockId).toList()));
    }

    private static ChatTurn turn(long turnId, long version) {
        ChatTurn turn = ChatTurn.accept(turnId, SESSION_ID, null,
                TurnModelSnapshot.of("deepseek-chat", "deepseek", null));
        turn.acceptPersistedVersion(version);
        return turn;
    }

    private static ToolCall completedCall(String id) {
        return ToolCall.builder()
                .id(id).conversationId(SESSION_ID).executionId(SESSION_ID * 10)
                .toolName("read_file").type(ToolCallType.EXECUTE).status(ToolCallStatus.COMPLETED)
                .content("{\"kind\":\"PLAN\"}")
                .rawInput("{\"args\":{}}")
                .rawOutput("{\"outcome\":\"SUCCEEDED\",\"output\":\"输出正文\"}")
                .metaData("{\"_meta\":{\"schemaVersion\":1}}")
                .createdAt(Instant.now()).updatedAt(Instant.now())
                .build();
    }

    private static ToolCall runningCall(String id) {
        return ToolCall.builder()
                .id(id).conversationId(SESSION_ID).executionId(SESSION_ID * 10)
                .toolName("read_file").type(ToolCallType.EXECUTE).status(ToolCallStatus.IN_PROGRESS)
                .content("{\"kind\":\"PLAN\"}")
                .rawInput("{\"args\":{}}")
                .createdAt(Instant.now()).updatedAt(Instant.now())
                .build();
    }

    private static SessionMessage userRow(long id, long turnId, String text) {
        return SessionMessage.builder().id(id).sessionId(SESSION_ID).turnId(turnId)
                .type(SessionMessageType.USER).text(text).createTime(Instant.now()).build();
    }

    private static SessionMessage toolRow(long id, Long turnId, String callId) {
        return SessionMessage.builder().id(id).sessionId(SESSION_ID).turnId(turnId)
                .type(SessionMessageType.TOOL).text(callId).createTime(Instant.now()).build();
    }

    private SessionMessage aiRow(long id, long turnId, List<ToolCallRequest> requests) {
        AiMessageEntity ai = new AiMessageEntity();
        ai.setText("正文");
        ai.setToolCalls(requests.stream().map(Objects::requireNonNull).toList());
        return SessionMessage.builder().id(id).sessionId(SESSION_ID).turnId(turnId)
                .responseId(String.valueOf(id)).type(SessionMessageType.AI)
                .text(json.valueToTree(ai).toString()).createTime(Instant.now()).build();
    }
}
