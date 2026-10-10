package com.summit.dp.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.dp.session.application.convert.ToolBlockStatusResolver;
import com.summit.dp.session.application.convert.TurnViewAssembler;
import com.summit.dp.session.application.service.TurnViewService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
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
import org.junit.jupiter.params.provider.CsvSource;

import java.time.Instant;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 轮次状态必须从 {@link TurnViewService} 透传进装配器，参与 {@code isBody} 判定。
 *
 * <p><b>为什么单列一个用例</b>：{@code TurnViewService} 里 {@code turn.getStatus()} 是唯一把轮次
 * 状态送进 {@link TurnViewAssembler} 的地方。编译只能拦住签名不匹配，拦不住把这行写成
 * {@code ChatTurnStatus.COMPLETED} 硬编码这类<b>语义变异</b> —— 而那正是本轮改造的核心
 * （挂起行必须 {@code false}）。因此这里走真实的 {@code assembleTurnView}，用同一条
 * 「无工具请求的收尾 AI 行」只改轮次状态，钉住「状态确实被透传并决定了 {@code isBody}」。</p>
 */
class TurnViewServiceIsBodyTest {

    private static final long SESSION_ID = 9100L;
    private static final long TURN_ID = 9700L;

    private final ObjectMapper json = new ObjectMapper();
    private final MessageRepository messageRepository = mock(MessageRepository.class);
    private final ChatTurnRepository chatTurnRepository = mock(ChatTurnRepository.class);
    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);
    private final TurnViewService service = new TurnViewService(
            messageRepository,
            chatTurnRepository,
            toolCallRepository,
            new TurnViewAssembler(json, new ToolBlockStatusResolver(new ToolCallConverter(json))));

    /**
     * 同一条无工具请求的收尾 AI 行，只改轮次状态：只有 {@code COMPLETED} 时 {@code isBody} 才为真。
     *
     * <p>{@code WAITING}（曾挂起）尤其关键：它是本改造要挡住的场景 —— 只看「无工具请求」会误判为正文。</p>
     */
    @ParameterizedTest(name = "轮次状态 {0} 时收尾行 isBody={1}")
    @CsvSource({"WAITING, false", "RUNNING, false", "COMPLETED, true"})
    void turnStatusIsPassedThroughToIsBody(ChatTurnStatus status, boolean expectedIsBody) {
        stubSingleConcludingAiRowWithoutTools();

        Optional<TurnViewVO> view = service.assembleTurnView(session(), turn(status), 1L);

        assertTrue(view.isPresent(), "本轮有消息时应装出视图");
        List<Block> blocks = view.get().blocks();
        // 前提：该行无工具请求（否则本用例会被「含工具请求」这一条挡住，测不到状态透传）。
        assertTrue(blocks.stream().noneMatch(block -> block.getType().equals(Block.TYPE_TOOL)),
                "前提：本用例的 AI 行不得含工具请求");
        assertEquals(2, blocks.size(), "应只有思考块与正文块");

        TextBlock text = (TextBlock) blocks.stream()
                .filter(block -> block instanceof TextBlock).findFirst().orElseThrow();
        assertEquals(expectedIsBody, text.isBody(),
                "轮次状态 " + status + " 必须透传进装配器并决定 isBody");
    }

    /** 反向哨兵：确认视图状态本身也来自轮次（同一遍透传的另一处体现），并坐实 isBody 判据非「恒真/恒假」。 */
    @Test
    @DisplayName("同一收尾行：COMPLETED 为正文、WAITING 为非正文，二者必须不同")
    void sameRowDiffersOnlyByTurnStatus() {
        stubSingleConcludingAiRowWithoutTools();

        boolean completedIsBody = bodyOf(service.assembleTurnView(session(), turn(ChatTurnStatus.COMPLETED), 1L));
        boolean waitingIsBody = bodyOf(service.assembleTurnView(session(), turn(ChatTurnStatus.WAITING), 1L));

        assertTrue(completedIsBody, "COMPLETED 的收尾无工具行是正文");
        assertFalse(waitingIsBody, "WAITING（曾挂起）的同一行不是正文");
    }

    // ── 构造助手 ──

    private void stubSingleConcludingAiRowWithoutTools() {
        when(messageRepository.findByTurnIds(anyLong(), anyCollection()))
                .thenReturn(List.of(aiRowWithoutTools("正文")));
        when(toolCallRepository.listByIds(anyCollection())).thenReturn(List.of());
    }

    private static boolean bodyOf(Optional<TurnViewVO> view) {
        List<Block> blocks = view.orElseThrow().blocks();
        return ((TextBlock) blocks.stream()
                .filter(block -> block instanceof TextBlock).findFirst().orElseThrow()).isBody();
    }

    private Session session() {
        return Session.builder().id(SESSION_ID).rootSessionId(SESSION_ID).build();
    }

    private static ChatTurn turn(ChatTurnStatus status) {
        return ChatTurn.builder().id(TURN_ID).sessionId(SESSION_ID).status(status).build();
    }

    private static SessionMessage aiRowWithoutTools(String text) {
        return SessionMessage.builder()
                .id(TURN_ID * 10)
                .sessionId(SESSION_ID)
                .turnId(TURN_ID)
                .responseId(Long.toString(TURN_ID * 10))
                .type(SessionMessageType.AI)
                .text("{\"type\":\"AI\",\"thinking\":\"想一下\",\"text\":\"" + text + "\"}")
                .createTime(Instant.now())
                .build();
    }
}
