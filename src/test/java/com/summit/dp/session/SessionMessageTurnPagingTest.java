package com.summit.dp.session;

import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.session.application.service.SessionAggregateService;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.session.domain.repo.SessionContextRepository;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.model.CursorResult;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 历史分页单位从「消息行」改为「完整轮次」的回归守卫。
 *
 * <p><b>为什么这条不变量必须钉住</b>：按消息行分页时，同一轮次的 USER / AI / TOOL 行可能
 * 横跨两页 —— 前端逐页聚合会给同一轮建两个气泡（id 相同、过程各半）。按轮次分页从根上
 * 消除这种跨页，因此「一页内每一轮的行都是完整的」是本契约的核心。</p>
 *
 * <p><b>本用例能因回退变红</b>：若把 {@code messageSlice} 改回按 {@code session_message.id}
 * 游标切页，则「同一轮横跨两页」的构造会立即出现在返回结果里，第一组断言失败。</p>
 */
class SessionMessageTurnPagingTest {

    private static final long SESSION_ID = 900L;

    private final SessionRepository sessionRepository = mock(SessionRepository.class);
    private final MessageRepository messageRepository = mock(MessageRepository.class);
    private final ChatTurnRepository chatTurnRepository = mock(ChatTurnRepository.class);

    private final SessionAggregateService service = new SessionAggregateService(
            sessionRepository, messageRepository, chatTurnRepository,
            mock(ToolCallRepository.class), mock(ModelContextService.class),
            mock(SessionContextRepository.class));

    private static ChatTurn turn(long id) {
        ChatTurn turn = ChatTurn.accept(id, SESSION_ID, null, "deepseek-chat", "deepseek");
        return turn;
    }

    private static SessionMessage row(long id, Long turnId, SessionMessageType type) {
        return SessionMessage.builder()
                .id(id).sessionId(SESSION_ID).turnId(turnId).type(type).text("x").build();
    }

    /** 无归属的旧行不参与轮次分页，恒返回空。 */
    private void stubNoOrphans() {
        when(messageRepository.findOrphanPage(eq(SESSION_ID), anyInt())).thenReturn(List.of());
    }

    @Test
    @DisplayName("同一轮次的全部行必须整组落在同一页（横跨两页的构造不再出现）")
    void wholeTurnIsPagedTogether() {
        // 三张轮次：8003（最新）、8002、8001（最老）。每轮都有一批消息行。
        when(chatTurnRepository.findLatest(eq(SESSION_ID), any(), anyInt()))
                .thenReturn(List.of(turn(8003L), turn(8002L)));
        stubNoOrphans();
        // 关键构造：8002 这一轮有多行 —— 按消息行切页时它会被切成两半。
        when(messageRepository.findByTurnIds(eq(SESSION_ID), any()))
                .thenAnswer(inv -> {
                    Collection<Long> ids = inv.getArgument(1);
                    List<SessionMessage> rows = new ArrayList<>();
                    if (ids.contains(8003L)) {
                        rows.add(row(30L, 8003L, SessionMessageType.USER));
                        rows.add(row(31L, 8003L, SessionMessageType.AI));
                    }
                    if (ids.contains(8002L)) {
                        rows.add(row(20L, 8002L, SessionMessageType.USER));
                        rows.add(row(21L, 8002L, SessionMessageType.AI));
                        rows.add(row(22L, 8002L, SessionMessageType.TOOL));
                    }
                    return rows;
                });

        CursorResult<SessionMessage> slice = service.messageSlice(SESSION_ID, null, 2);

        // 一轮一组：8002 的三行必须全在，不能被切成两页。
        Set<Long> turnIds = new HashSet<>();
        for (SessionMessage message : slice.records()) {
            turnIds.add(message.getTurnId());
        }
        assertEquals(Set.of(8002L, 8003L), turnIds, "一页必须覆盖完整轮次，不能出现半轮");
        long countFor8002 = slice.records().stream().filter(m -> Long.valueOf(8002L).equals(m.getTurnId())).count();
        assertEquals(3L, countFor8002, "8002 一轮的三行必须全部在同一页");
    }

    @Test
    @DisplayName("游标 = 本页最老一轮的 turnId，下一页据此取更早的轮次")
    void nextCursorIsOldestTurnId() {
        when(chatTurnRepository.findLatest(eq(SESSION_ID), any(), anyInt()))
                .thenReturn(List.of(turn(8003L), turn(8002L), turn(8001L)));
        stubNoOrphans();
        when(messageRepository.findByTurnIds(eq(SESSION_ID), any())).thenReturn(List.of(row(20L, 8002L, SessionMessageType.AI)));

        CursorResult<SessionMessage> slice = service.messageSlice(SESSION_ID, null, 2);

        assertTrue(slice.hasMore(), "多取到一条（8001）说明还有更早的一页");
        assertEquals("8002", slice.nextCursor(), "游标是本页最老一轮（8002）的 turnId，不是消息 id");
    }

    @Test
    @DisplayName("游标落到轮次维度：翻页时按 turnId 向更早的一轮取，不再回拼旧的无归属行")
    void cursorConsumedAsTurnIdAndOrphansOnlyOnFirstPage() {
        when(chatTurnRepository.findLatest(eq(SESSION_ID), eq(8002L), anyInt()))
                .thenReturn(List.of(turn(8001L)));
        when(messageRepository.findByTurnIds(eq(SESSION_ID), any())).thenReturn(List.of(row(10L, 8001L, SessionMessageType.AI)));

        CursorResult<SessionMessage> slice = service.messageSlice(SESSION_ID, "8002", 2);

        // 翻页不得再拼无归属旧行（它们已随首屏返回过，重复拼会翻倍）。
        verify(messageRepository, never()).findOrphanPage(anyLong(), anyInt());
        assertEquals(8001L, slice.records().getFirst().getTurnId());
        assertFalse(slice.hasMore());
        assertNull(slice.nextCursor(), "末页无游标");
    }

    @Test
    @DisplayName("首屏才拼无归属旧行，且它们排在轮次消息之前")
    void orphanRowsPrependedOnlyOnFirstPage() {
        when(chatTurnRepository.findLatest(eq(SESSION_ID), any(), anyInt())).thenReturn(List.of(turn(8003L)));
        when(messageRepository.findOrphanPage(eq(SESSION_ID), anyInt()))
                .thenReturn(List.of(row(1L, null, SessionMessageType.USER)));
        when(messageRepository.findByTurnIds(eq(SESSION_ID), any())).thenReturn(List.of(row(30L, 8003L, SessionMessageType.AI)));

        CursorResult<SessionMessage> slice = service.messageSlice(SESSION_ID, null, 50);

        assertEquals(2, slice.records().size());
        assertNull(slice.records().getFirst().getTurnId(), "无归属旧行排在最前");
        assertEquals(8003L, slice.records().getLast().getTurnId());
    }
}
