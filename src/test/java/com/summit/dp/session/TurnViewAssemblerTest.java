package com.summit.dp.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.session.application.convert.ToolBlockStatusResolver;
import com.summit.dp.session.application.convert.TurnViewAssembler;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.shared.vo.block.Block;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.block.BlockStatus;
import com.summit.dp.shared.vo.block.TextBlock;
import com.summit.dp.shared.vo.block.ThinkingBlock;
import com.summit.dp.shared.vo.block.ToolBlock;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 一轮块装配：顺序、身份、落点、状态必须由后端唯一确定。
 *
 * <p>这些正是历史与实时共用的判据 —— 任何一处后退，前端就得重新自己算。</p>
 */
class TurnViewAssemblerTest {

    private static final long SESSION_ID = 700L;
    private static final long TURN_ID = 800L;
    private static final String RESPONSE_ID = "9007199254740992";

    private final ObjectMapper json = new ObjectMapper();
    private final ToolCallConverter converter = new ToolCallConverter(json);
    private final TurnViewAssembler assembler =
            new TurnViewAssembler(json, new ToolBlockStatusResolver(converter));

    /** 思考 → 正文 → 工具块按此顺序，工具块 order 递增且跟在正文之后。 */
    @Test
    void blocksAreOrderedThinkingThenTextThenTools() {
        SessionMessage ai = aiRow(0, "为什么", "结论前的中途叙述", request("call_a"), request("call_b", 1));

        List<Block> blocks = assembler.assembleBlocks(TURN_ID, List.of(ai), Map.of(), ChatTurnStatus.COMPLETED);

        assertEquals(4, blocks.size());
        assertInstanceOf(ThinkingBlock.class, blocks.get(0));
        assertInstanceOf(TextBlock.class, blocks.get(1));
        assertInstanceOf(ToolBlock.class, blocks.get(2));
        assertInstanceOf(ToolBlock.class, blocks.get(3));
        // 工具块顺序 = 模型请求列表顺序（call_a 在 call_b 前），不是完成顺序。
        assertEquals("call_a", ((ToolBlock) blocks.get(2)).toolCallId());
        assertEquals("call_b", ((ToolBlock) blocks.get(3)).toolCallId());
        for (int i = 1; i < blocks.size(); i++) {
            assertTrue(blocks.get(i).getOrder() > blocks.get(i - 1).getOrder(), "块 order 必须严格递增");
        }
    }

    /**
     * isBody 的完整判据：**无工具请求 + 本轮收尾 + 轮次已完成**，三者缺一不可。
     *
     * <p>含工具请求的行恒为非正文；只有本轮最后一条、无工具请求、且轮次 COMPLETED 的收尾响应才是正文。</p>
     */
    @Test
    void isBodyRequiresNoToolsConcludingAndCompleted() {
        // 中途叙述：含工具请求 → 即使轮次完成也是过程。
        SessionMessage midTurn = aiRow(0, null, "中途叙述", request("call_a"));
        // 收尾结论：本轮最后一条、无工具请求、轮次 COMPLETED。
        SessionMessage finalTurn = aiRow(1, null, "最终结论");

        List<Block> midBlocks = assembler.assembleBlocks(TURN_ID, List.of(midTurn), Map.of(), ChatTurnStatus.COMPLETED);
        List<Block> finalBlocks = assembler.assembleBlocks(TURN_ID, List.of(finalTurn), Map.of(), ChatTurnStatus.COMPLETED);

        assertFalse(textBlock(midBlocks).isBody(), "含工具请求的行不是正文");
        assertTrue(textBlock(finalBlocks).isBody(), "本轮最后一条、无工具请求、COMPLETED 才是正文");
    }

    /** 收尾响应（本轮最后一条、无工具请求、COMPLETED）→ 正文。 */
    @Test
    void concludingResponseOnCompletedTurnIsBody() {
        SessionMessage concluding = aiRow(0, null, "收尾结论");

        List<Block> blocks = assembler.assembleBlocks(TURN_ID, List.of(concluding), Map.of(), ChatTurnStatus.COMPLETED);

        assertTrue(textBlock(blocks).isBody());
    }

    /** 含工具请求的行 → 非正文，无论它是不是本轮收尾。 */
    @Test
    void rowsWithToolRequestsAreNeverBodyEvenWhenConcluding() {
        SessionMessage onlyRow = aiRow(0, null, "带工具的收尾", request("call_a"));

        List<Block> blocks = assembler.assembleBlocks(TURN_ID, List.of(onlyRow), Map.of(), ChatTurnStatus.COMPLETED);

        assertFalse(textBlock(blocks).isBody(), "无工具请求这一条必须显式挡住脏数据");
    }

    /**
     * 曾挂起的无工具请求行 → 非正文，即使轮次已是 COMPLETED。
     *
     * <p>挂起后恢复并完成时同轮有两行：R1(无工具请求, 曾挂起) 与 R2(无工具请求, 收尾)。
     * R1 必须靠「不是该轮最后一条模型响应」排除，不能只看轮次状态。</p>
     */
    @Test
    void suspendedRowStaysProcessEvenWhenTurnCompleted() {
        SessionMessage suspended = aiRow(0, null, "挂起前那条");     // responseId ...992
        SessionMessage concluding = aiRow(1, null, "恢复后的收尾结论"); // responseId ...993

        List<Block> blocks = assembler.assembleBlocks(TURN_ID, List.of(suspended, concluding), Map.of(),
                ChatTurnStatus.COMPLETED);

        TextBlock suspendedText = textBlockOf(blocks, suspended.getResponseId());
        TextBlock concludingText = textBlockOf(blocks, concluding.getResponseId());
        assertFalse(suspendedText.isBody(), "挂起行不是本轮收尾，即便轮次已完成也不是正文");
        assertTrue(concludingText.isBody(), "本轮最后一条、无工具请求、COMPLETED 才是正文");
    }

    /** 轮次未正常完成（RUNNING / WAITING / FAILED / CANCELLED）→ 收尾行也是非正文。 */
    @ParameterizedTest
    @EnumSource(value = ChatTurnStatus.class, names = {"RUNNING", "WAITING", "FAILED", "CANCELLED"})
    void concludingRowIsNotBodyWhenTurnNotCompleted(ChatTurnStatus status) {
        SessionMessage concluding = aiRow(0, null, "收尾结论");

        List<Block> blocks = assembler.assembleBlocks(TURN_ID, List.of(concluding), Map.of(), status);

        assertFalse(textBlock(blocks).isBody(), "只有 COMPLETED 才升级为正文，实际轮次状态: " + status);
    }

    /** 身份：有 responseId 用 `thinking:<responseId>` / `text:<responseId>`；工具用 `tool:<id>`。 */
    @Test
    void blockIdentityUsesResponseId() {
        SessionMessage ai = aiRow(0, "思考", "正文", request("call_a"));

        List<Block> blocks = assembler.assembleBlocks(TURN_ID, List.of(ai), Map.of(), ChatTurnStatus.COMPLETED);

        assertEquals(ThinkingBlock.identity(RESPONSE_ID.toString()), blocks.get(0).getBlockId());
        assertEquals(TextBlock.identity(RESPONSE_ID.toString()), blocks.get(1).getBlockId());
        assertEquals(ToolBlock.identity("call_a"), blocks.get(2).getBlockId());
        // 身份仍来自 toolCallId，responseId 只负责响应位置。
        assertEquals(RESPONSE_ID, blocks.get(2).getResponseId());
    }

    @Test
    void missingResponseIdentityIsRejectedInsteadOfUsingRowIdentity() {
        SessionMessage invalid = SessionMessage.builder().id(42L).turnId(TURN_ID)
                .type(SessionMessageType.AI).text(writeJson(AiMessageEntity.builder().text("正文").build())).build();
        assertThrows(ClientException.class,
                () -> assembler.assembleBlocks(TURN_ID, List.of(invalid), Map.of(), ChatTurnStatus.COMPLETED));
    }

    @Test
    void historicalToolsUseProducerIndexEvenWhenStoredListIsReordered() {
        SessionMessage ai = aiRow(0, null, null, request("second", 1), request("first", 0));
        List<Block> blocks = assembler.assembleBlocks(TURN_ID, List.of(ai), Map.of(), ChatTurnStatus.COMPLETED);
        assertEquals(List.of("tool:first", "tool:second"), blocks.stream().map(Block::getBlockId).toList());
        assertEquals(List.of(2, 3), blocks.stream().map(Block::getOrder).toList());
    }

    /** 工具块状态取权威工具视图：completed + SUCCEEDED → COMPLETED；completed + REJECTED → REJECTED。 */
    @Test
    void toolStatusComesFromAuthoritativeOutcomeNotLifecycle() {
        SessionMessage ai = aiRow(0, null, null, request("call_ok"), request("call_no", 1));

        ToolCall succeeded = toolCall("call_ok", ToolCallStatus.COMPLETED, ToolCallOutcome.SUCCEEDED);
        ToolCall rejected = toolCall("call_no", ToolCallStatus.COMPLETED, ToolCallOutcome.REJECTED);

        List<Block> blocks = assembler.assembleBlocks(TURN_ID, List.of(ai),
                Map.of("call_ok", succeeded, "call_no", rejected), ChatTurnStatus.COMPLETED);

        assertEquals(BlockStatus.TOOL_COMPLETED, blocks.get(0).getStatus());
        assertEquals(BlockStatus.TOOL_REJECTED, blocks.get(1).getStatus(),
                "completed 只表示已收尾：被拒绝的结论必须来自 raw_output.outcome，不能显示成成功");
    }

    /** 工具行尚未落库（实时窗口）按「已开始」展示，不假装成功也不假装失败。 */
    @Test
    void missingToolCallRowFallsBackToStarted() {
        SessionMessage ai = aiRow(0, null, null, request("call_new"));

        List<Block> blocks = assembler.assembleBlocks(TURN_ID, List.of(ai), Map.of(), ChatTurnStatus.COMPLETED);

        assertEquals(BlockStatus.TOOL_STARTED, blocks.get(0).getStatus());
    }

    @Test
    void numericResponseIdentityOrdersWholeResponsesWithoutPersistedSequence() {
        String earlier = "9007199254740992";
        String later = "9007199254740993";
        SessionMessage first = SessionMessage.builder().id(200L).turnId(TURN_ID).responseId(earlier)
                .type(SessionMessageType.AI).text(writeJson(AiMessageEntity.builder().thinking("先思考").text("先读")
                        .toolCalls(List.of(request("call_1"), request("call_2", 1))).build())).build();
        SessionMessage second = SessionMessage.builder().id(100L).turnId(TURN_ID).responseId(later)
                .type(SessionMessageType.AI).text(writeJson(AiMessageEntity.builder().thinking("再思考").text("结论").build())).build();
        List<Block> blocks = assembler.assembleBlocks(TURN_ID, List.of(second, first), Map.of(), ChatTurnStatus.COMPLETED);
        assertEquals(List.of("thinking:" + earlier, "text:" + earlier, "tool:call_1", "tool:call_2",
                "thinking:" + later, "text:" + later), blocks.stream().map(Block::getBlockId).toList());
        assertEquals(List.of(0, 1, 2, 3, 0, 1), blocks.stream().map(Block::getOrder).toList());
        assertEquals(earlier, blocks.get(2).getResponseId());
        assertEquals(earlier, blocks.get(3).getResponseId());
    }

    /** 提问取本轮最早的 USER 行；无 USER 行返回 null。 */
    @Test
    void userMessageComesFromEarliestUserRow() {
        SessionMessage later = userRow(20L, "后一句");
        SessionMessage earlier = userRow(10L, "先一句");

        assertEquals("先一句", assembler.resolveUserMessage(TURN_ID, List.of(later, earlier)));
        assertNull(assembler.resolveUserMessage(TURN_ID, List.of(aiRow(0, null, "无提问"))));
    }

    // ── 构造助手 ──

    /** 取首个正文块（每个用例的块列表里最多一块）。 */
    private static TextBlock textBlock(List<Block> blocks) {
        return (TextBlock) blocks.stream().filter(b -> b instanceof TextBlock).findFirst().orElseThrow();
    }

    /** 取指定响应身份的正文块（同轮多响应场景用）。 */
    private static TextBlock textBlockOf(List<Block> blocks, String responseId) {
        return (TextBlock) blocks.stream()
                .filter(b -> b instanceof TextBlock text && responseId.equals(text.responseId()))
                .findFirst().orElseThrow();
    }

    private SessionMessage aiRow(int round, String thinking, String text, ToolCallRequest... requests) {
        AiMessageEntity message = AiMessageEntity.builder()
                .thinking(thinking)
                .text(text)
                .toolCalls(List.of(requests))
                .build();
        return SessionMessage.builder()
                .id((long) (100 + round))
                .sessionId(SESSION_ID).turnId(TURN_ID).responseId(Long.toString(Long.parseLong(RESPONSE_ID) + round))
                .type(SessionMessageType.AI)
                .text(writeJson(message)).createTime(Instant.now()).build();
    }

    private SessionMessage userRow(long rowId, String text) {
        return SessionMessage.builder()
                .id(rowId).sessionId(SESSION_ID).turnId(TURN_ID)
                .type(SessionMessageType.USER)
                .text(writeJson(UserMessageEntity.from(text))).createTime(Instant.now()).build();
    }

    private static ToolCallRequest request(String id) {
        return request(id, 0);
    }

    private static ToolCallRequest request(String id, int requestIndex) {
        return ToolCallRequest.builder().id(id).name("read_file").requestIndex(requestIndex).arguments("{}").build();
    }

    private static ToolCall toolCall(String id, ToolCallStatus status, ToolCallOutcome outcome) {
        return ToolCall.builder()
                .id(id).conversationId(SESSION_ID).executionId(900L)
                .toolName("read_file").type(ToolCallType.EXECUTE).status(status)
                .rawOutput("{\"outcome\":\"" + outcome.value() + "\"}")
                .createdAt(Instant.now()).updatedAt(Instant.now())
                .build();
    }

    private String writeJson(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
