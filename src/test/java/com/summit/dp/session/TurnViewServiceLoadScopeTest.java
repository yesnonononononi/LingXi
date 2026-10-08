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
import com.summit.dp.shared.vo.block.TurnViewVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 装配装载范围必须是**本轮**，而不是整个会话。
 *
 * <p>实时链路每个工具收尾都装配一次；若每次读回全会话再在内存里过滤，代价会随会话总长
 * 线性增长。本用例把「装载范围」钉成不变量：查询按 {@code turn_id IN (本轮)} 下发，
 * 且**不再**调用无 LIMIT 的 {@code findBySessionId}。</p>
 */
class TurnViewServiceLoadScopeTest {

    private static final long SESSION_ID = 9001L;
    private static final long TURN_ID = 9600L;

    private final ObjectMapper json = new ObjectMapper();
    private final MessageRepository messageRepository = mock(MessageRepository.class);
    private final ChatTurnRepository chatTurnRepository = mock(ChatTurnRepository.class);
    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);
    private final TurnViewService service = new TurnViewService(
            messageRepository,
            chatTurnRepository,
            toolCallRepository,
            new TurnViewAssembler(json, new ToolBlockStatusResolver(new ToolCallConverter(json))));

    /** 装载以 turnId 为过滤条件下发；整会话读法（findBySessionId）绝不被调用。 */
    @Test
    void loadsOnlyTheRequestedTurn() {
        SessionMessage ai = aiRow(TURN_ID, "为什么");
        when(messageRepository.findByTurnIds(anyLong(), anyCollection())).thenReturn(List.of(ai));
        when(toolCallRepository.listByIds(anyCollection())).thenReturn(List.of());

        Optional<TurnViewVO> view = service.assembleTurnView(session(), turn(TURN_ID), 3L);

        assertTrue(view.isPresent(), "本轮有消息时应装出视图");
        assertEquals(1, view.get().blocks().size(), "本轮应恰好装出 1 个块");

        @SuppressWarnings("unchecked")
        ArgumentCaptor<Collection<Long>> turnIds = ArgumentCaptor.forClass(Collection.class);
        verify(messageRepository).findByTurnIds(org.mockito.ArgumentMatchers.eq(SESSION_ID), turnIds.capture());
        assertEquals(List.of(TURN_ID), List.copyOf(turnIds.getValue()),
                "装载范围只应包含本轮 turnId");

        verify(messageRepository, never()).findBySessionId(anyLong());
        verify(messageRepository, never()).findOrphanPage(anyLong(), org.mockito.ArgumentMatchers.anyInt());
    }

    /** 其它轮次的行哪怕被仓储（错误地）一并返回，也不会混入本轮的块。 */
    @Test
    void rowsOfOtherTurnsNeverLeakIntoTheView() {
        SessionMessage mine = aiRow(TURN_ID, "本轮");
        SessionMessage other = aiRow(TURN_ID + 1, "别的轮");
        assertTrue(other.getId() != mine.getId(), "前提：两行 id 必须不同，否则该用例无区分度");
        when(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_ID)))
                .thenReturn(List.of(mine, other));
        when(toolCallRepository.listByIds(anyCollection())).thenReturn(List.of());

        Optional<TurnViewVO> view = service.assembleTurnView(session(), turn(TURN_ID), 1L);

        assertTrue(view.isPresent());
        List<Block> blocks = view.get().blocks();
        assertFalse(blocks.isEmpty(), "本轮块不应为空");
        // AI 行同时产出思考块与正文块，故断言「每个块的身份都指向本轮那行」，而非固定块数。
        String ownRowSuffix = "message:" + mine.getId();
        for (Block block : blocks) {
            assertTrue(block.getBlockId().endsWith(ownRowSuffix),
                    "只应有本轮那行(" + mine.getId() + ")的块，实际: " + block.getBlockId());
        }
    }

    private Session session() {
        return Session.builder().id(SESSION_ID).rootSessionId(SESSION_ID).build();
    }

    private static ChatTurn turn(long turnId) {
        return ChatTurn.builder().id(turnId).sessionId(SESSION_ID).build();
    }

    private static SessionMessage aiRow(long turnId, String text) {
        return SessionMessage.builder()
                .id(turnId * 10)
                .sessionId(SESSION_ID)
                .turnId(turnId)
                .responseOrder(0)
                .type(SessionMessageType.AI)
                .text("{\"thinking\":\"想一下\",\"text\":\"" + text + "\"}")
                .createTime(Instant.now())
                .build();
    }
}
