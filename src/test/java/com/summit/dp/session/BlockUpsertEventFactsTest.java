package com.summit.dp.session;

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
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.block.Block;
import com.summit.dp.shared.vo.block.BlockStatus;
import com.summit.dp.shared.vo.block.ToolBlock;
import com.summit.dp.shared.vo.block.TurnViewVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallBlockView;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.TurnModelSnapshot;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 事件驱动单块（BLOCK_UPSERT 主路径）的等价性守卫。
 *
 * <p><b>为什么必须逐字段比对整轮口径</b>：改造的价值来自「不再读整轮消息」，风险同样来自它 ——
 * 响应身份、请求位置、工具名、参数现在来自框架事件而不是 AI 行。只断言「没调 findByTurnIds」
 * 守不住输出正确性（AGENTS.md：断言必须能因缺陷变红）。</p>
 */
class BlockUpsertEventFactsTest {

    private static final long SESSION_ID = 7101L;
    private static final long TURN_ID = 7201L;
    private static final long PARENT_TURN_ID = 7301L;
    private static final String TARGET = "call-e1";
    private static final String SIBLING = "call-e2";

    private final ObjectMapper json = new ObjectMapper();
    private final MessageRepository messageRepository = mock(MessageRepository.class);
    private final ChatTurnRepository chatTurnRepository = mock(ChatTurnRepository.class);
    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);
    private final TurnViewAssembler assembler = new TurnViewAssembler(json,
            new ToolBlockStatusResolver(new ToolCallConverter(json)));
    private final TurnViewService service = new TurnViewService(
            messageRepository, chatTurnRepository, toolCallRepository, assembler);

    @Test
    @DisplayName("工具行尚未落库（null 投影）：两条路径都装出 TOOL_STARTED，逐字段相等")
    void missingToolRowStillMatches() {
        String args = "{\"path\":\"a.txt\"}";
        Fixture fixture = new Fixture(turnMessages(aiRow(21L, "31", ai("正文", request(TARGET, "read_file", 0, args)))),
                new LinkedHashMap<>());

        ToolBlock block = assertEquivalent(fixture, turn(), facts(TARGET, "31", 0, "read_file", args));

        assertEquals(BlockStatus.TOOL_STARTED, block.status());
        assertEquals(null, block.output(), "工具行缺失时没有结果");
        assertEquals(null, block.version(), "工具行缺失时没有版本号");
    }

    @Test
    @DisplayName("PROMISE 与 EXECUTE 两种形态：两条路径逐字段相等")
    void promiseAndExecuteBothMatch() {
        AiMessageEntity ai = ai("正文", request(TARGET, "ask_user", 0, "{\"q\":\"继续吗\"}"),
                request(SIBLING, "read_file", 1, "{\"path\":\"b.txt\"}"));
        Map<String, ToolCall> tools = new LinkedHashMap<>();
        tools.put(TARGET, toolRow(TARGET, ToolCallType.PROMISE, ToolCallStatus.COMPLETED, "{}"));
        tools.put(SIBLING, toolRow(SIBLING, ToolCallType.EXECUTE, ToolCallStatus.IN_PROGRESS, null));
        Fixture fixture = new Fixture(turnMessages(aiRow(21L, "32", ai)), tools);

        ToolBlock promise = assertEquivalent(fixture, turn(),
                facts(TARGET, "32", 0, "ask_user", "{\"q\":\"继续吗\"}"));
        ToolBlock execute = assertEquivalent(fixture, turn(),
                facts(SIBLING, "32", 1, "read_file", "{\"path\":\"b.txt\"}"));

        assertEquals(ToolCallType.PROMISE.name(), tools.get(TARGET).getType().name(), "前提：夹具里一条是 PROMISE");
        assertTrue(promise.status() != null && execute.status() != null, "两条块都必须有状态");
        assertEquals(2, promise.order(), "order 必须来自请求位置（2 + requestIndex=0）");
        assertEquals(3, execute.order(), "order 必须来自请求位置（2 + requestIndex=1）");
        assertEquals(tools.get(TARGET).getVersion(), promise.version());
        assertEquals(tools.get(SIBLING).getVersion(), execute.version());
    }

    @Test
    @DisplayName("raw_output 是大 CLOB：完整结果与版本号都随块下发，两路径相等")
    void largeRawOutputMatches() {
        String heavy = "{\"outcome\":\"SUCCEEDED\",\"output\":\"" + "输出".repeat(4000) + "\"}";
        Map<String, ToolCall> tools = new LinkedHashMap<>();
        tools.put(TARGET, toolRow(TARGET, ToolCallType.EXECUTE, ToolCallStatus.COMPLETED, heavy));
        Fixture fixture = new Fixture(turnMessages(
                aiRow(21L, "33", ai("正文", request(TARGET, "read_file", 0, "{\"path\":\"c.txt\"}")))),
                tools);

        ToolBlock block = assertEquivalent(fixture, turn(),
                facts(TARGET, "33", 0, "read_file", "{\"path\":\"c.txt\"}"));

        assertTrue(block.output().length() > 256, "前提：raw_output 必须是大字段");
        assertEquals(heavy, block.output());
        assertEquals(7L, block.version(), "工具行版本号必须原样下发");
    }

    @Test
    @DisplayName("工具被本轮非首个 AI 行请求：响应身份取事件给出的那一条，两路径相等")
    void toolRequestedByNonFirstAiRowMatches() {
        String args = "{\"path\":\"d.txt\"}";
        Map<String, ToolCall> tools = new LinkedHashMap<>();
        tools.put(TARGET, toolRow(TARGET, ToolCallType.EXECUTE, ToolCallStatus.COMPLETED, "{\"outcome\":\"SUCCEEDED\"}"));
        List<SessionMessage> messages = turnMessages(
                aiRow(21L, "40", ai("第一段正文")),
                aiRow(22L, "41", ai("第二段正文", request(TARGET, "read_file", 0, args))));
        Fixture fixture = new Fixture(messages, tools);

        ToolBlock block = assertEquivalent(fixture, turn(), facts(TARGET, "41", 0, "read_file", args));

        assertEquals("41", block.responseId(), "响应身份必须来自请求它的那一条响应");
        assertEquals(2, block.order(), "order 仍由请求位置决定，与它落在哪条 AI 行无关");
    }

    @Test
    @DisplayName("本轮多条 AI 行（含收尾响应判定）：块仍逐字段相等")
    void multipleAiRowsIncludingConcludingResponseMatch() {
        Map<String, ToolCall> tools = new LinkedHashMap<>();
        tools.put(TARGET, toolRow(TARGET, ToolCallType.EXECUTE, ToolCallStatus.COMPLETED, "{\"outcome\":\"SUCCEEDED\"}"));
        List<SessionMessage> messages = turnMessages(
                aiRow(21L, "50", ai("带工具", request(TARGET, "read_file", 0, "{}"))),
                aiRow(22L, "51", ai("收尾正文")));
        Fixture fixture = new Fixture(messages, tools);
        ChatTurn completed = turn();
        completed.markCompleted(null, null, null, Instant.now());

        ToolBlock block = assertEquivalent(fixture, completed, facts(TARGET, "50", 0, "read_file", "{}"));

        assertEquals(BlockStatus.TOOL_COMPLETED, block.status(), "工具行已成功，块状态不受收尾判定影响");
        assertEquals("50", block.responseId(), "响应身份是带工具的那一条响应");
    }

    @Test
    @DisplayName("args 含中文、引号与换行：事件参数原样进入块，两路径相等")
    void argumentsWithChineseQuotesAndNewlinesMatch() {
        String args = "{\"path\":\"文件 \\\"甲\\\".txt\",\"note\":\"第一行\\n第二行\"}";
        Map<String, ToolCall> tools = new LinkedHashMap<>();
        tools.put(TARGET, toolRow(TARGET, ToolCallType.EXECUTE, ToolCallStatus.COMPLETED, null));
        Fixture fixture = new Fixture(turnMessages(
                aiRow(21L, "60", ai("正文", request(TARGET, "read_file", 0, args)))), tools);

        ToolBlock block = assertEquivalent(fixture, turn(), facts(TARGET, "60", 0, "read_file", args));

        assertEquals(args, block.arguments(), "原始参数必须逐字下发（含中文、引号、换行）");
    }

    @Test
    @DisplayName("响应身份非数字：两条路径抛同一条 ClientException，禁止静默成功")
    void nonNumericResponseIdRejectedByBothPaths() {
        Fixture fixture = new Fixture(turnMessages(
                aiRow(21L, "not-a-number", ai("正文", request(TARGET, "read_file", 0, "{}")))),
                new LinkedHashMap<>());
        stubRepositories(fixture, facts(TARGET, "not-a-number", 0, "read_file", "{}"));

        ClientException fromFull = assertThrows(ClientException.class,
                () -> service.assembleTurnView(session(), turn(), 1L));
        ClientException fromEvent = assertThrows(ClientException.class,
                () -> service.assembleToolBlockView(session(), turn(), 1L,
                        facts(TARGET, "not-a-number", 0, "read_file", "{}")));

        assertEquals(fromFull.getMessage(), fromEvent.getMessage(), "两条路径必须是同一条拒绝口径");
        assertTrue(fromEvent.getMessage().contains("框架身份"), "拒绝文案必须说清缺什么: " + fromEvent.getMessage());
    }

    /** 断言事件路径与「整轮装配后过滤」逐字段相等，返回事件路径装出的工具块。 */
    private ToolBlock assertEquivalent(Fixture fixture, ChatTurn turn, ToolBlockEventFacts facts) {
        stubRepositories(fixture, facts);

        TurnViewVO full = service.assembleTurnView(session(), turn, turn.getVersion()).orElseThrow();
        TurnViewVO event = service.assembleToolBlockView(session(), turn, turn.getVersion(), facts).orElseThrow();
        TurnViewVO expected = onlyBlock(full, ToolBlock.identity(facts.toolCallId()));

        assertEquals(1, event.blocks().size(), "事件路径只能有一个块");
        assertEquals(expected, event, "事件路径视图必须与整轮装配后过滤的结果完全一致");
        assertEquals(expected.blocks(), event.blocks());
        assertEquals(expected.userMessage(), event.userMessage());
        assertEquals(expected.userImageUrls(), event.userImageUrls());
        assertEquals(expected.resumeSupplements(), event.resumeSupplements());
        assertEquals(expected.userMessageId(), event.userMessageId());
        assertEquals(expected.metric(), event.metric());
        assertEquals(expected.status(), event.status());
        assertEquals(expected.parentTurnId(), event.parentTurnId());

        ToolBlock expectedBlock = (ToolBlock) expected.blocks().getFirst();
        ToolBlock actualBlock = (ToolBlock) event.blocks().getFirst();
        assertEquals(expectedBlock.blockId(), actualBlock.blockId());
        assertEquals(expectedBlock.responseId(), actualBlock.responseId());
        assertEquals(expectedBlock.order(), actualBlock.order());
        assertEquals(expectedBlock.status(), actualBlock.status());
        assertEquals(expectedBlock.toolCallId(), actualBlock.toolCallId());
        assertEquals(expectedBlock.toolName(), actualBlock.toolName());
        assertEquals(expectedBlock.arguments(), actualBlock.arguments());
        assertEquals(expectedBlock.output(), actualBlock.output());
        assertEquals(expectedBlock.version(), actualBlock.version());
        return actualBlock;
    }

    private void stubRepositories(Fixture fixture, ToolBlockEventFacts facts) {
        List<SessionMessage> userRows = fixture.messages().stream()
                .filter(row -> row.getType() == SessionMessageType.USER).toList();
        when(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_ID))).thenReturn(fixture.messages());
        when(messageRepository.findUserMessages(SESSION_ID, TURN_ID)).thenReturn(userRows);
        when(toolCallRepository.listByIds(any())).thenReturn(new ArrayList<>(fixture.tools().values()));
        ToolCallBlockView projection = Optional.ofNullable(fixture.tools().get(facts.toolCallId()))
                .map(BlockUpsertEventFactsTest::blockView).orElse(null);
        when(toolCallRepository.findForBlockUpsert(facts.toolCallId())).thenReturn(Optional.ofNullable(projection));
    }

    /** 测试侧的独立过滤实现：不复用待测类的私有方法，避免「用实现验证实现」。 */
    private static TurnViewVO onlyBlock(TurnViewVO view, String blockId) {
        List<Block> filtered = view.blocks().stream()
                .filter(block -> blockId.equals(block.getBlockId())).toList();
        assertTrue(!filtered.isEmpty(), "整轮装配里必须存在目标块 " + blockId);
        return new TurnViewVO(view.sessionId(), view.turnId(), view.status(), view.viewVersion(),
                view.userMessage(), view.userImageUrls(), filtered, view.metric(), view.userMessageId(),
                view.resumeSupplements(), view.parentTurnId());
    }

    private static ToolBlockEventFacts facts(String toolCallId, String responseId, int requestIndex,
                                             String toolName, String args) {
        return new ToolBlockEventFacts(toolCallId, responseId, requestIndex, toolName, args);
    }

    private static ToolCallRequest request(String id, String name, int index, String args) {
        return new ToolCallRequest(id, name, index, args);
    }

    private static AiMessageEntity ai(String text, ToolCallRequest... requests) {
        AiMessageEntity ai = new AiMessageEntity();
        ai.setText(text);
        ai.setToolCalls(List.of(requests));
        return ai;
    }

    private List<SessionMessage> turnMessages(SessionMessage... aiRows) {
        List<SessionMessage> messages = new ArrayList<>();
        messages.add(SessionMessage.builder().id(11L).sessionId(SESSION_ID).turnId(TURN_ID)
                .type(SessionMessageType.USER).text("问题甲").createTime(Instant.now()).build());
        messages.addAll(List.of(aiRows));
        return messages;
    }

    private SessionMessage aiRow(long id, String responseId, AiMessageEntity ai) {
        return SessionMessage.builder().id(id).sessionId(SESSION_ID).turnId(TURN_ID)
                .responseId(responseId).type(SessionMessageType.AI)
                .text(json.valueToTree(ai).toString()).createTime(Instant.now()).build();
    }

    private static ToolCall toolRow(String id, ToolCallType type, ToolCallStatus status, String rawOutput) {
        return ToolCall.builder()
                .id(id).conversationId(SESSION_ID).executionId(SESSION_ID * 10)
                .toolName("read_file").type(type).status(status)
                .content("{\"kind\":\"PLAN\"}")
                .rawInput("{\"args\":{}}")
                .rawOutput(rawOutput)
                .metaData("{\"_meta\":{\"schemaVersion\":1}}")
                .version(7L)
                .createdAt(Instant.now()).updatedAt(Instant.now())
                .build();
    }

    private static ToolCallBlockView blockView(ToolCall toolCall) {
        return new ToolCallBlockView(toolCall.getId(), toolCall.getConversationId(), toolCall.getToolName(),
                toolCall.getType(), toolCall.getStatus(), toolCall.getRawOutput(), toolCall.getVersion());
    }

    private static Session session() {
        return Session.builder().id(SESSION_ID).rootSessionId(SESSION_ID)
                .contextTokenCount(900L).contextMaxTokens(1800).build();
    }

    private static ChatTurn turn() {
        ChatTurn turn = ChatTurn.accept(TURN_ID, SESSION_ID, PARENT_TURN_ID,
                TurnModelSnapshot.of("deepseek-chat", "deepseek", null));
        turn.acceptPersistedVersion(5L);
        return turn;
    }

    /** 一次场景的夹具：本轮消息 + 已落库的工具行。 */
    private record Fixture(List<SessionMessage> messages, Map<String, ToolCall> tools) {
    }
}
