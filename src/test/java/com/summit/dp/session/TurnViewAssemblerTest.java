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
import com.summit.dp.shared.vo.block.BlockStatus;
import com.summit.dp.shared.vo.block.Placement;
import com.summit.dp.shared.vo.block.TextBlock;
import com.summit.dp.shared.vo.block.ThinkingBlock;
import com.summit.dp.shared.vo.block.ToolBlock;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallOutcome;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
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
    private static final UUID RESPONSE_ID = UUID.fromString("1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d");

    private final ObjectMapper json = new ObjectMapper();
    private final ToolCallConverter converter = new ToolCallConverter(json);
    private final TurnViewAssembler assembler =
            new TurnViewAssembler(json, new ToolBlockStatusResolver(converter));

    /** 思考 → 正文 → 工具块按此顺序，工具块 order 递增且跟在正文之后。 */
    @Test
    void blocksAreOrderedThinkingThenTextThenTools() {
        SessionMessage ai = aiRow(0, "为什么", "结论前的中途叙述", request("call_a"), request("call_b"));

        List<Block> blocks = assembler.assembleBlocks(TURN_ID, List.of(ai), Map.of());

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

    /** placement：含工具请求的行是 PROCESS（中途叙述）；不含的转 BODY（结论）。 */
    @Test
    void placementFollowsToolRequestPresence() {
        SessionMessage midTurn = aiRow(0, null, "中途叙述", request("call_a"));
        SessionMessage finalTurn = aiRow(1, null, "最终结论");

        List<Block> midBlocks = assembler.assembleBlocks(TURN_ID, List.of(midTurn), Map.of());
        List<Block> finalBlocks = assembler.assembleBlocks(TURN_ID, List.of(finalTurn), Map.of());

        TextBlock midText = (TextBlock) midBlocks.stream()
                .filter(b -> b instanceof TextBlock).findFirst().orElseThrow();
        TextBlock finalText = (TextBlock) finalBlocks.stream()
                .filter(b -> b instanceof TextBlock).findFirst().orElseThrow();
        assertEquals(Placement.PROCESS, midText.placement());
        assertEquals(Placement.BODY, finalText.placement());
    }

    /** 身份：有 responseId 用 `thinking:<responseId>` / `text:<responseId>`；工具用 `tool:<id>`。 */
    @Test
    void blockIdentityUsesResponseId() {
        SessionMessage ai = aiRow(0, "思考", "正文", request("call_a"));

        List<Block> blocks = assembler.assembleBlocks(TURN_ID, List.of(ai), Map.of());

        assertEquals(ThinkingBlock.identity(RESPONSE_ID.toString()), blocks.get(0).getBlockId());
        assertEquals(TextBlock.identity(RESPONSE_ID.toString()), blocks.get(1).getBlockId());
        assertEquals(ToolBlock.identity("call_a"), blocks.get(2).getBlockId());
        // 工具块 responseId 恒空：身份来自 toolCallId。
        assertNull(blocks.get(2).getResponseId());
    }

    /** 旧数据（无 responseId）身份退化为行 ID，但块仍可稳定定位，且不伪造身份。 */
    @Test
    void legacyRowWithoutResponseIdKeepsStableIdentity() {
        SessionMessage ai = legacyAiRow(42L, "旧思考", "旧正文");

        List<Block> blocks = assembler.assembleBlocks(TURN_ID, List.of(ai), Map.of());

        assertEquals(ThinkingBlock.legacyIdentity(42L), blocks.get(0).getBlockId());
        assertEquals(TextBlock.legacyIdentity(42L), blocks.get(1).getBlockId());
        assertNull(blocks.get(0).getResponseId());
    }

    /** 工具块状态取权威工具视图：completed + SUCCEEDED → COMPLETED；completed + REJECTED → REJECTED。 */
    @Test
    void toolStatusComesFromAuthoritativeOutcomeNotLifecycle() {
        SessionMessage ai = aiRow(0, null, null, request("call_ok"), request("call_no"));

        ToolCall succeeded = toolCall("call_ok", ToolCallStatus.COMPLETED, ToolCallOutcome.SUCCEEDED);
        ToolCall rejected = toolCall("call_no", ToolCallStatus.COMPLETED, ToolCallOutcome.REJECTED);

        List<Block> blocks = assembler.assembleBlocks(TURN_ID, List.of(ai),
                Map.of("call_ok", succeeded, "call_no", rejected));

        assertEquals(BlockStatus.TOOL_COMPLETED, blocks.get(0).getStatus());
        assertEquals(BlockStatus.TOOL_REJECTED, blocks.get(1).getStatus(),
                "completed 只表示已收尾：被拒绝的结论必须来自 raw_output.outcome，不能显示成成功");
    }

    /** 工具行尚未落库（实时窗口）按「已开始」展示，不假装成功也不假装失败。 */
    @Test
    void missingToolCallRowFallsBackToStarted() {
        SessionMessage ai = aiRow(0, null, null, request("call_new"));

        List<Block> blocks = assembler.assembleBlocks(TURN_ID, List.of(ai), Map.of());

        assertEquals(BlockStatus.TOOL_STARTED, blocks.get(0).getStatus());
    }

    /** 同轮多次模型调用：靠 responseOrder 分层，第 2 次调用的块排在第 1 次之后。 */
    @Test
    void multipleResponsesInOneTurnAreLayeredByResponseOrder() {
        SessionMessage first = aiRow(0, null, "第一轮叙述", request("call_1"));
        SessionMessage second = aiRow(1, null, "第二轮叙述", request("call_2"));

        List<Block> blocks = assembler.assembleBlocks(TURN_ID, List.of(first, second), Map.of());

        // 第二轮的所有块 order 必须都大于第一轮。
        int maxFirstRound = blocks.stream().filter(b -> b.getBlockId().contains("call_1"))
                .mapToInt(Block::getOrder).max().orElseThrow();
        int minSecondRound = blocks.stream().filter(b -> b.getBlockId().contains("call_2"))
                .mapToInt(Block::getOrder).min().orElseThrow();
        assertTrue(minSecondRound > maxFirstRound,
                "同一轮第二次模型调用的块必须整体排在第一次之后");
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

    private SessionMessage aiRow(int responseOrder, String thinking, String text, ToolCallRequest... requests) {
        AiMessageEntity message = AiMessageEntity.builder()
                .thinking(thinking)
                .text(text)
                .toolCalls(List.of(requests))
                .build();
        return SessionMessage.builder()
                .id((long) (100 + responseOrder))
                .sessionId(SESSION_ID).turnId(TURN_ID).responseId(RESPONSE_ID)
                .responseOrder(responseOrder).type(SessionMessageType.AI)
                .text(writeJson(message)).createTime(Instant.now()).build();
    }

    private SessionMessage legacyAiRow(long rowId, String thinking, String text) {
        AiMessageEntity message = AiMessageEntity.builder().thinking(thinking).text(text).build();
        return SessionMessage.builder()
                .id(rowId).sessionId(SESSION_ID).turnId(TURN_ID).responseId(null)
                .responseOrder(null).type(SessionMessageType.AI)
                .text(writeJson(message)).createTime(Instant.now()).build();
    }

    private SessionMessage userRow(long rowId, String text) {
        return SessionMessage.builder()
                .id(rowId).sessionId(SESSION_ID).turnId(TURN_ID)
                .type(SessionMessageType.USER)
                .text(writeJson(UserMessageEntity.from(text))).createTime(Instant.now()).build();
    }

    private static ToolCallRequest request(String id) {
        return ToolCallRequest.builder().id(id).name("read_file").arguments("{}").build();
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
