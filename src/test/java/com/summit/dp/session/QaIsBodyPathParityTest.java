package com.summit.dp.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.session.application.convert.ToolBlockStatusResolver;
import com.summit.dp.session.application.convert.TurnViewAssembler;
import com.summit.dp.session.application.service.TurnViewBroadcaster;
import com.summit.dp.session.application.service.TurnViewService;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.event.BlockEventType;
import com.summit.dp.shared.event.SseEventPublisher;
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
import org.mockito.ArgumentCaptor;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * B2 独立取证：「历史与实时同规则」是<b>结构保证</b>，不是巧合。
 *
 * <p>本类用<b>同一份</b> turn/消息数据分别驱动两条真实入口，断言产出的 {@code TextBlock.isBody} 完全一致：</p>
 * <ul>
 *   <li><b>历史入口</b>：{@code SessionServiceImpl#buildBlockViews}（SessionServiceImpl.java:227）
 *       → {@code TurnViewService.assembleTurnView(session, turn, viewVersion)}。
 *       这里直接调用同一方法（SessionServiceImpl 的 10 个依赖会引入噪音，且该行为纯透传）。</li>
 *   <li><b>实时入口</b>：{@code TurnViewRuntimeListener#snapshot}（TurnViewRuntimeListener.java:98）
 *       → {@code TurnViewBroadcaster.broadcastSnapshotForExecution} → 同一
 *       {@code assembleTurnView}，再经 {@code SseEventPublisher.publishBusiness} 下发。</li>
 * </ul>
 *
 * <p>两条链路的装配收口点是<b>同一个</b> {@code TurnViewService.assembleTurnView(session, turn, version)}
 * （唯一实现，见 B3）。本测试用真实 {@link TurnViewBroadcaster} + 真实 {@link TurnViewService}
 * 捕获实时下发的 {@link BlockEventType.BlockEventPayload}，与历史直调结果逐块比对 isBody。</p>
 */
class QaIsBodyPathParityTest {

    private static final long SESSION_ID = 8801L;
    private static final long TURN_ID = 8802L;
    private static final long EXECUTION_ID = 8803L;
    private static final String EARLIER = "9007199254740992";
    private static final String CONCLUDING = "9007199254740993";

    private final ObjectMapper json = new ObjectMapper();
    private final TurnViewAssembler assembler =
            new TurnViewAssembler(json, new ToolBlockStatusResolver(new ToolCallConverter(json)));

    private final MessageRepository messageRepository = mock(MessageRepository.class);
    private final ChatTurnRepository chatTurnRepository = mock(ChatTurnRepository.class);
    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);
    private final SseEventPublisher sseEventPublisher = mock(SseEventPublisher.class);
    private final ExecutionIdentity executionIdentity = mock(ExecutionIdentity.class);

    private final TurnViewService turnViewService =
            new TurnViewService(messageRepository, chatTurnRepository, toolCallRepository, assembler);
    private final TurnViewBroadcaster broadcaster =
            new TurnViewBroadcaster(turnViewService, chatTurnRepository, sessionRepository,
                    sseEventPublisher, executionIdentity);

    /** WAITING 一帧：两条无工具行都必须非正文（挂起行与「尚未收尾」行皆 false）。 */
    @Test
    @DisplayName("B2 历史与实时一致 —— WAITING 帧")
    void waitingFrameIsIdenticalAcrossPaths() {
        assertParity(ChatTurnStatus.WAITING, Map.of(EARLIER, false, CONCLUDING, false));
    }

    /** COMPLETED 一帧：仅本轮最后一条无工具行为正文（挂起过的较早行为 false）。 */
    @Test
    @DisplayName("B2 历史与实时一致 —— COMPLETED 帧（挂起行与收尾行区分）")
    void completedFrameIsIdenticalAcrossPaths() {
        assertParity(ChatTurnStatus.COMPLETED, Map.of(EARLIER, false, CONCLUDING, true));
    }

    private void assertParity(ChatTurnStatus status, Map<String, Boolean> expected) {
        List<SessionMessage> rows = List.of(
                aiRow(EARLIER, "曾挂起的响应"),
                aiRow(CONCLUDING, "收尾响应"));
        ChatTurn turn = ChatTurn.builder().id(TURN_ID).sessionId(SESSION_ID).status(status).version(1L).build();

        when(messageRepository.findByTurnIds(anyLong(), anyCollection())).thenReturn(rows);
        when(toolCallRepository.listByIds(anyCollection())).thenReturn(List.of());
        when(chatTurnRepository.findByExecutionId(EXECUTION_ID)).thenReturn(Optional.of(turn));
        // broadcastTurn 内部按 turnId 再取一次轮次（TurnViewBroadcaster.java:64）。
        when(chatTurnRepository.findById(TURN_ID)).thenReturn(Optional.of(turn));
        when(sessionRepository.findById(anyLong())).thenReturn(Optional.empty());
        when(executionIdentity.resolveRootSessionIdOrNull(SESSION_ID)).thenReturn(SESSION_ID);

        // 历史入口（SessionServiceImpl.java:227 调用同一方法）。
        TurnViewVO historyView = turnViewService.assembleTurnView(null, turn, 1L).orElseThrow();

        // 实时入口：走真实广播器 + 真实监听器所调用的方法，捕获下发的载荷。
        broadcaster.broadcastSnapshotForExecution(String.valueOf(EXECUTION_ID));
        ArgumentCaptor<Object> captor = ArgumentCaptor.forClass(Object.class);
        verify(sseEventPublisher).publishBusiness(eq(SESSION_ID), eq(BlockEventType.TURN_SNAPSHOT), captor.capture());
        BlockEventType.BlockEventPayload payload = (BlockEventType.BlockEventPayload) captor.getValue();
        TurnViewVO realtimeView = payload.view();

        // 同一份数据、同一规则：逐 responseId 的 isBody 必须一致。
        Map<String, Boolean> historyBodies = bodiesById(historyView.blocks());
        Map<String, Boolean> realtimeBodies = bodiesById(realtimeView.blocks());
        assertEquals(historyBodies, realtimeBodies,
                "历史与实时对同一份数据的 isBody 必须完全一致（WAITING/COMPLETED 都不例外）");
        // 且与预期一致（坐实上面的一致性不是「两边一起错」）。
        assertEquals(expected, realtimeBodies, "isBody 语义必须符合规则：" + expected);
    }

    private static Map<String, Boolean> bodiesById(List<Block> blocks) {
        Map<String, Boolean> result = new LinkedHashMap<>();
        for (Block block : blocks) {
            if (block instanceof TextBlock text) {
                result.put(text.responseId(), text.isBody());
            }
        }
        return result;
    }

    private SessionMessage aiRow(String responseId, String text) {
        AiMessageEntity message = AiMessageEntity.builder().thinking("想一下").text(text).toolCalls(List.of()).build();
        return SessionMessage.builder()
                .id(100L).sessionId(SESSION_ID).turnId(TURN_ID).responseId(responseId)
                .type(SessionMessageType.AI).text(writeJson(message)).createTime(Instant.now()).build();
    }

    private String writeJson(Object value) {
        try {
            return json.writeValueAsString(value);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
