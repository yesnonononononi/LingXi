package com.summit.dp.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.dp.session.application.convert.ToolBlockStatusResolver;
import com.summit.dp.session.application.convert.TurnViewAssembler;
import com.summit.dp.session.application.service.TurnViewService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.shared.vo.block.Block;
import com.summit.dp.shared.vo.block.TextBlock;
import com.summit.dp.shared.vo.block.TurnViewVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import java.lang.reflect.Method;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * QA2 独立验证：{@code isBody} 规则（唯一载体 {@code BodyPlacement.resolve}）的端到端正确性。
 *
 * <p>与实现者的 {@code TurnViewServiceIsBodyTest} 刻意分离：本类一律走<b>真实</b>
 * {@link TurnViewService#assembleTurnView}（即历史读路径的入口），逐一攻击实现者未覆盖的形态：
 * 同轮两行收尾关系、脏数据（收尾行带工具请求）、{@link TurnViewAssembler} 私有收尾计算边界、
 * {@code status == null}、以及<b>全部</b>五个非 {@code COMPLETED} 状态（实现者的 {@code @EnumSource}
 * 漏了 {@code ACCEPTED}）。</p>
 */
class QaBodyPlacementIndependentTest {

    private static final long SESSION_ID = 7411L;
    private static final long TURN_ID = 7422L;

    private static final String EARLIER = "9007199254740992";
    private static final String CONCLUDING = "9007199254740993";

    private final ObjectMapper json = new ObjectMapper();
    private final TurnViewAssembler assembler =
            new TurnViewAssembler(json, new ToolBlockStatusResolver(new ToolCallConverter(json)));

    private final MessageRepository messageRepository = mock(MessageRepository.class);
    private final ChatTurnRepository chatTurnRepository = mock(ChatTurnRepository.class);
    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);
    private final TurnViewService service =
            new TurnViewService(messageRepository, chatTurnRepository, toolCallRepository, assembler);

    // ─────────────────────────── A1 ───────────────────────────

    /**
     * A1（本轮最核心不变量）：同轮两行、皆无工具请求，轮次 COMPLETED。
     * 较早 responseId 的 R1＝曾挂起 → false；收尾 R2 → true。
     */
    @Test
    @DisplayName("A1 同轮两行（皆无工具请求，COMPLETED）：仅收尾行为正文")
    void a1_twoRowsSameTurn_onlyConcludingIsBody() {
        stubMessages(aiRow(EARLIER, "挂起前那条", List.of()), aiRow(CONCLUDING, "恢复后的收尾结论", List.of()));

        List<Block> blocks = assembleViaService(ChatTurnStatus.COMPLETED);

        assertFalse(textOf(blocks, EARLIER).isBody(), "较早的（曾挂起）行不得判为正文");
        assertTrue(textOf(blocks, CONCLUDING).isBody(), "本轮最后一条无工具请求行才是正文");
    }

    // ─────────────────────────── A2 ───────────────────────────

    /** A2：轮次 COMPLETED，但收尾行带工具请求（脏数据）→ 必须 false。 */
    @Test
    @DisplayName("A2 COMPLETED 但收尾行带工具请求（脏数据）：必须为非正文")
    void a2_concludingRowWithToolRequestIsNotBody() {
        stubMessages(aiRow(CONCLUDING, "带工具的收尾", List.of(toolRequest("call_1"))));

        List<Block> blocks = assembleViaService(ChatTurnStatus.COMPLETED);

        assertFalse(textOf(blocks, CONCLUDING).isBody(), "含工具请求的行恒为非正文，即便它是收尾且轮次完成");
    }

    // ─────────────────────────── A3 ───────────────────────────

    /**
     * A3(a)：{@code resolveConcludingResponseId} 遇到非纯数字行必须<b>跳过不抛</b>，
     * 且不因此误判收尾 —— 选出的仍是可解析数字里的 {@link java.math.BigInteger} 最大值。
     *
     * <p>方法为 private，这里用反射直测：因为在公开调用面上非数字行会被
     * {@link TurnViewAssembler#assembleBlocks} 的 {@link ClientException} 拦下（见 A3b），
     * 该方法的行为在「成功装配」路径上不可观测。</p>
     */
    @Test
    @DisplayName("A3(a) 收尾计算：跳过非纯数字行，选数字最大值，不抛")
    void a3_skipNonNumericAndPickMaxNumeric() throws Exception {
        // 非数字行在字典序上“巨大”（'z' > '9'），若按行序/字典序会误判为收尾。
        List<SessionMessage> rows = List.of(
                aiRow("100", "小数字", List.of()),
                aiRow("zzz-not-numeric", "非数字", List.of()),
                aiRow(CONCLUDING, "数字最大值", List.of()));

        assertEquals(CONCLUDING, invokeResolveConcluding(rows),
                "非数字行必须被跳过；收尾必须取 BigInteger 最大值");
    }

    /** A3(a) 边角：本轮只有非数字行 → 无从判定收尾，返回 null（不抛）。 */
    @Test
    @DisplayName("A3(a)-边角 收尾计算：无非数字候选时返回 null，不抛")
    void a3_onlyNonNumericYieldsNullConcluding() throws Exception {
        List<SessionMessage> rows = List.of(
                aiRow("abc", "非数字甲", List.of()),
                aiRow("6f1a1c2e-uuid", "非数字乙", List.of()));

        assertNull(invokeResolveConcluding(rows), "无可解析数字身份时收尾无从判定，应为 null");
    }

    /**
     * A3(b)：「收尾计算跳过」与「该行自身被拒绝」是两件事 —— 公开装配面上，
     * 非数字 AI 行会被 {@link TurnViewAssembler#appendAiBlocks} 以 {@link ClientException} 拒绝，
     * 整个装配中止。故收尾计算的「跳过」在当前唯一调用点<b>不会</b>产生一个“成功但错判”的结果：
     * 要么正常（全数字），要么直接失败。此即当前行为的自洽点。
     */
    @Test
    @DisplayName("A3(b) 非数字 AI 行在装配层被拒绝（ClientException），收尾跳过不可观测")
    void a3b_nonNumericRowRejectedAtAssemblyLevel() {
        SessionMessage bad = aiRow("not-a-number", "正文", List.of());

        assertThrows(ClientException.class,
                () -> assembler.assembleBlocks(TURN_ID, List.of(bad), Map.of(), ChatTurnStatus.COMPLETED),
                "非数字 responseId 的行必须被拒绝，而不是被静默跳过");
    }

    // ─────────────────────────── A4 ───────────────────────────

    /** A4：轮次 status == null（未知/未完成）→ 收尾无工具行必须 false，且不得 NPE（经真实服务透传）。 */
    @Test
    @DisplayName("A4 轮次 status == null：收尾行非正文，且不 NPE")
    void a4_nullStatusIsNotBodyWithoutNpe() {
        stubMessages(aiRow(CONCLUDING, "收尾", List.of()));

        List<Block> blocks = assembleViaService(null);

        assertFalse(textOf(blocks, CONCLUDING).isBody(), "未知/未完成状态不得升级为正文");
    }

    // ─────────────────────────── A5 ───────────────────────────

    /**
     * A5：所有非 {@code COMPLETED} 状态（含实现者 {@code @EnumSource} 遗漏的 {@code ACCEPTED}）
     * 下，收尾无工具行都必须 false。经真实服务透传验证。
     */
    @ParameterizedTest(name = "A5 轮次状态 {0}：收尾行非正文")
    @EnumSource(value = ChatTurnStatus.class, names = {"ACCEPTED", "RUNNING", "WAITING", "FAILED", "CANCELLED"})
    void a5_allNonCompletedStatusesAreNotBody(ChatTurnStatus status) {
        stubMessages(aiRow(CONCLUDING, "收尾", List.of()));

        List<Block> blocks = assembleViaService(status);

        assertFalse(textOf(blocks, CONCLUDING).isBody(), "只有 COMPLETED 才升级为正文，实际: " + status);
    }

    /** A5 反向哨兵：同一行、只把状态换成 COMPLETED 即为正文（坐实判据非恒假）。 */
    @Test
    @DisplayName("A5-反向 同收尾行 COMPLETED 才为正文")
    void a5_completedSentinel() {
        stubMessages(aiRow(CONCLUDING, "收尾", List.of()));

        assertTrue(textOf(assembleViaService(ChatTurnStatus.COMPLETED), CONCLUDING).isBody());
    }

    // ─────────────────────────── 助手 ───────────────────────────

    private List<Block> assembleViaService(ChatTurnStatus status) {
        Optional<TurnViewVO> view = service.assembleTurnView(session(), turn(status), 1L);
        assertTrue(view.isPresent(), "本轮有消息时应装出视图");
        return view.get().blocks();
    }

    private void stubMessages(SessionMessage... rows) {
        when(messageRepository.findByTurnIds(anyLong(), anyCollection())).thenReturn(List.of(rows));
        when(toolCallRepository.listByIds(anyCollection())).thenReturn(List.of());
    }

    private String invokeResolveConcluding(List<SessionMessage> rows) throws Exception {
        Method method = TurnViewAssembler.class
                .getDeclaredMethod("resolveConcludingResponseId", Long.class, List.class);
        method.setAccessible(true);
        return (String) method.invoke(assembler, TURN_ID, rows);
    }

    private static TextBlock textOf(List<Block> blocks, String responseId) {
        return (TextBlock) blocks.stream()
                .filter(block -> block instanceof TextBlock text && responseId.equals(text.responseId()))
                .findFirst().orElseThrow(() -> new AssertionError("缺 responseId=" + responseId + " 的正文块"));
    }

    private static Session session() {
        return Session.builder().id(SESSION_ID).rootSessionId(SESSION_ID).build();
    }

    private static ChatTurn turn(ChatTurnStatus status) {
        return ChatTurn.builder().id(TURN_ID).sessionId(SESSION_ID).status(status).build();
    }

    private SessionMessage aiRow(String responseId, String text, List<ToolCallRequest> requests) {
        AiMessageEntity message = AiMessageEntity.builder()
                .thinking("想一下")
                .text(text)
                .toolCalls(requests)
                .build();
        return SessionMessage.builder()
                .id(100L)
                .sessionId(SESSION_ID)
                .turnId(TURN_ID)
                .responseId(responseId)
                .type(SessionMessageType.AI)
                .text(writeJson(message))
                .createTime(Instant.now())
                .build();
    }

    private static ToolCallRequest toolRequest(String id) {
        return ToolCallRequest.builder().id(id).name("read_file").requestIndex(0).arguments("{}").build();
    }

    private String writeJson(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
