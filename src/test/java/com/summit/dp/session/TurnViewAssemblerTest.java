package com.summit.dp.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.session.application.convert.ToolBlockEventFacts;
import com.summit.dp.session.application.convert.ToolBlockStatusResolver;
import com.summit.dp.session.application.convert.TurnViewAssembler;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.block.*;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallBlockView;
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

import static org.junit.jupiter.api.Assertions.*;

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

    @Test
    void supplementalUserMessagesRemainSeparateFromOriginalQuestionAndOrderedByIdentity() throws Exception {
        SessionMessage original = SessionMessage.builder().id(1L).turnId(TURN_ID).type(SessionMessageType.USER)
                .text(json.writeValueAsString(UserMessageEntity.from("原提问"))).build();
        SessionMessage first = SessionMessage.builder().id(2L).turnId(TURN_ID).type(SessionMessageType.USER)
                .resumeRequestId("first-request-id").text(json.writeValueAsString(UserMessageEntity.from("先别提交"))).build();
        SessionMessage second = SessionMessage.builder().id(3L).turnId(TURN_ID).type(SessionMessageType.USER)
                .resumeRequestId("second-request-id").text(json.writeValueAsString(UserMessageEntity.from("补充验收"))).build();
        SessionMessage foreign = SessionMessage.builder().id(4L).turnId(TURN_ID + 1).type(SessionMessageType.USER)
                .resumeRequestId("foreign-request-id").text(json.writeValueAsString(UserMessageEntity.from("别的轮次"))).build();
        List<SessionMessage> records = List.of(second, foreign, original, first);
        assertEquals("原提问", assembler.resolveUserMessage(TURN_ID, records));
        assertEquals(List.of(2L, 3L), assembler.resolveResumeSupplements(TURN_ID, records).stream()
                .map(ResumeSupplementVO::messageId).toList());
        assertEquals(List.of("先别提交", "补充验收"), assembler.resolveResumeSupplements(TURN_ID, records).stream()
                .map(ResumeSupplementVO::text).toList());
    }

    @Test
    void toolBlockCarriesPersistedVersionIndependentlyFromTurn() {
        SessionMessage ai = aiRow(0, null, null, request("call_a"));
        ToolCall call = toolCall("call_a", ToolCallStatus.COMPLETED, ToolCallOutcome.SUCCEEDED);
        call.acceptPersistedVersion(7L);
        List<Block> blocks = assembler.assembleBlocks(TURN_ID, List.of(ai), Map.of("call_a", call), ChatTurnStatus.RUNNING);
        ToolBlock tool = (ToolBlock) blocks.stream().filter(block -> block instanceof ToolBlock).findFirst().orElseThrow();
        assertEquals(7L, tool.version());
        List<Block> missing = assembler.assembleBlocks(TURN_ID, List.of(ai), Map.of(), ChatTurnStatus.RUNNING);
        ToolBlock unpersisted = (ToolBlock) missing.stream().filter(block -> block instanceof ToolBlock).findFirst().orElseThrow();
        assertNull(unpersisted.version());
    }

    /**
     * 历史装配必须从落库的 {@code _meta.fileEdit} 取回编辑区间：行号只在执行那一刻存在，
     * 没落库就永久丢失（表现就是刷新后 diff 没有行号）。{@code 0} 有语义（该侧不存在），
     * 不能被当成「缺失」丢掉。
     */
    @Test
    void toolBlockCarriesEditRangeFromPersistedMetaData() {
        SessionMessage ai = aiRow(0, null, null, request("call_edit"));
        ToolCall call = ToolCall.builder()
                .id("call_edit").conversationId(SESSION_ID).executionId(900L)
                .toolName("edit_file").type(ToolCallType.EXECUTE).status(ToolCallStatus.COMPLETED)
                .rawOutput("{\"outcome\":\"SUCCEEDED\"}")
                .metaData("{\"_meta\":{\"fileEdit\":{\"oldStartLine\":0,\"oldEndLine\":0,"
                        + "\"newStartLine\":5,\"newEndLine\":7,\"recordId\":\"r-9\"}}}")
                .createdAt(Instant.now()).updatedAt(Instant.now())
                .build();

        List<Block> blocks = assembler.assembleBlocks(TURN_ID, List.of(ai), Map.of("call_edit", call),
                ChatTurnStatus.COMPLETED);
        ToolBlock tool = (ToolBlock) blocks.stream()
                .filter(block -> block instanceof ToolBlock).findFirst().orElseThrow();

        assertEquals(0, tool.oldStartLine(), "0 表示该侧不存在，必须原样保留");
        assertEquals(0, tool.oldEndLine());
        assertEquals(5, tool.newStartLine());
        assertEquals(7, tool.newEndLine());
        assertEquals("r-9", tool.fileRecordId());
        // 执行标识是取差异接口的路径段：没有它，历史里的编辑行连「差异」入口都不显示。
        assertEquals("900", tool.executionId());
    }

    /** 元数据缺失或坏掉时行号为空，但不得因此装配失败（少一列数字不能拖垮整轮历史）。 */
    @Test
    void toolBlockToleratesBrokenMetaData() {
        SessionMessage ai = aiRow(0, null, null, request("call_edit"));
        ToolCall broken = ToolCall.builder()
                .id("call_edit").conversationId(SESSION_ID).executionId(900L)
                .toolName("edit_file").type(ToolCallType.EXECUTE).status(ToolCallStatus.COMPLETED)
                .rawOutput("{\"outcome\":\"SUCCEEDED\"}").metaData("not-json")
                .createdAt(Instant.now()).updatedAt(Instant.now())
                .build();

        List<Block> blocks = assembler.assembleBlocks(TURN_ID, List.of(ai), Map.of("call_edit", broken),
                ChatTurnStatus.COMPLETED);
        ToolBlock tool = (ToolBlock) blocks.stream()
                .filter(block -> block instanceof ToolBlock).findFirst().orElseThrow();

        assertNull(tool.oldStartLine());
        assertNull(tool.fileRecordId());
    }

    /**
     * 单块增量帧必须自带编辑区间：行号只在事件元数据里存在，块帧不带就没有第二次机会
     * （前端拿到一个行号全空的块，会把已有的行号覆盖掉）。
     */
    @Test
    void singleBlockCarriesEditRangeFromEventMetaData() {
        ToolBlockEventFacts facts = new ToolBlockEventFacts("call_edit", RESPONSE_ID, 0, "edit_file", "{}",
                Map.of("fileEdit", Map.of("oldStartLine", 0, "oldEndLine", 0,
                        "newStartLine", 5, "newEndLine", 7, "recordId", "r-9")));

        Block block = assembler.buildSingleToolBlock(facts, blockView()).orElseThrow();

        ToolBlock tool = (ToolBlock) block;
        assertEquals(0, tool.oldStartLine(), "0 表示该侧不存在，不能被当成缺失");
        assertEquals(0, tool.oldEndLine());
        assertEquals(5, tool.newStartLine());
        assertEquals(7, tool.newEndLine());
        assertEquals("r-9", tool.fileRecordId());
        assertEquals("900", tool.executionId(), "执行标识来自只读投影，取差异要靠它");
    }

    /** 事件里没有 fileEdit（读文件、命令等）时行号为空，但块照常产出。 */
    @Test
    void singleBlockWithoutFileEditHasNoEditRange() {
        ToolBlockEventFacts facts = new ToolBlockEventFacts("call_edit", RESPONSE_ID, 0, "edit_file", "{}");

        ToolBlock tool = (ToolBlock) assembler.buildSingleToolBlock(facts, blockView()).orElseThrow();

        assertNull(tool.oldStartLine());
        assertNull(tool.fileRecordId());
        assertEquals("900", tool.executionId());
    }

    /** 事件元数据里的 fileEdit 结构不对时降级为空行号，不能把推送整条炸掉。 */
    @Test
    void singleBlockToleratesBrokenFileEditMetaData() {
        ToolBlockEventFacts facts = new ToolBlockEventFacts("call_edit", RESPONSE_ID, 0, "edit_file", "{}",
                Map.of("fileEdit", "not-a-map"));

        ToolBlock tool = (ToolBlock) assembler.buildSingleToolBlock(facts, blockView()).orElseThrow();

        assertNull(tool.newStartLine());
        assertNull(tool.fileRecordId());
    }

    /**
     * 区间降级规则要逐个分支验证：四个行号与记录标识「全空」才算没有区间，
     * 只带其中任何一个就必须保留（行号 0 也是有效值）。
     *
     * <p>这些用例看似啰嗦，但 {@code fromEventMetaData} 的返回值只经 {@code buildSingleToolBlock}
     * 对外可见，漏掉一个组合就等于让某个短路分支永远没人走 —— 变异测试会如实报出来。</p>
     */
    @Test
    void singleBlockKeepsEditRangeWhenOnlyRecordIdPresent() {
        ToolBlock tool = (ToolBlock) assembler.buildSingleToolBlock(
                factsWithFileEdit(Map.of("recordId", "r-1")), blockView()).orElseThrow();

        assertEquals("r-1", tool.fileRecordId());
        assertNull(tool.oldStartLine());
        assertNull(tool.oldEndLine());
        assertNull(tool.newStartLine());
        assertNull(tool.newEndLine());
    }

    @Test
    void singleBlockKeepsEditRangeWhenOnlyFirstLinePresent() {
        ToolBlock oldStart = (ToolBlock) assembler.buildSingleToolBlock(
                factsWithFileEdit(Map.of("oldStartLine", 4)), blockView()).orElseThrow();
        assertEquals(4, oldStart.oldStartLine());
        assertNull(oldStart.newStartLine());

        ToolBlock oldEnd = (ToolBlock) assembler.buildSingleToolBlock(
                factsWithFileEdit(Map.of("oldEndLine", 6)), blockView()).orElseThrow();
        assertEquals(6, oldEnd.oldEndLine());
        assertNull(oldEnd.oldStartLine());
    }

    @Test
    void singleBlockKeepsEditRangeWhenOnlyNewStartLinePresent() {
        ToolBlock tool = (ToolBlock) assembler.buildSingleToolBlock(
                factsWithFileEdit(Map.of("newStartLine", 8)), blockView()).orElseThrow();

        assertEquals(8, tool.newStartLine());
        assertNull(tool.newEndLine());
        assertNull(tool.oldStartLine());
    }

    @Test
    void singleBlockKeepsEditRangeWhenOnlyLastLinePresent() {
        ToolBlock tool = (ToolBlock) assembler.buildSingleToolBlock(
                factsWithFileEdit(Map.of("newEndLine", 9)), blockView()).orElseThrow();

        assertEquals(9, tool.newEndLine());
        assertNull(tool.oldStartLine());
        assertNull(tool.oldEndLine());
        assertNull(tool.newStartLine());
        assertNull(tool.fileRecordId());
    }

    /** 空 fileEdit 等于没有区间；行号给成字符串也当缺失（只认数值）。 */
    @Test
    void singleBlockTreatsEmptyOrNonNumericFileEditAsNoRange() {
        ToolBlock empty = (ToolBlock) assembler.buildSingleToolBlock(
                factsWithFileEdit(Map.of()), blockView()).orElseThrow();
        assertNull(empty.oldStartLine());
        assertNull(empty.fileRecordId());

        ToolBlock text = (ToolBlock) assembler.buildSingleToolBlock(
                factsWithFileEdit(Map.of("oldStartLine", "12", "recordId", 777)), blockView()).orElseThrow();
        assertNull(text.oldStartLine(), "字符串行号不是行号");
        assertEquals("777", text.fileRecordId(), "记录标识是数字也照转字符串");
    }

    private static ToolBlockEventFacts factsWithFileEdit(Map<String, Object> fileEdit) {
        return new ToolBlockEventFacts("call_edit", RESPONSE_ID, 0, "edit_file", "{}",
                Map.of("fileEdit", fileEdit));
    }

    private static ToolCallBlockView blockView() {
        return new ToolCallBlockView("call_edit", SESSION_ID, "edit_file",
                ToolCallType.EXECUTE, ToolCallStatus.COMPLETED, "{\"outcome\":\"SUCCEEDED\"}", 3L, 900L);
    }

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
