package com.summit.dp.session;

import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.infrastructure.persistence.mapper.SessionMessageMapper;
import com.summit.dp.session.infrastructure.persistence.po.SessionMessagePO;
import com.summit.dp.session.infrastructure.persistence.repository.SessionMessageRepositoryImpl;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Instant;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * session_message 的业务轮次归属列往返（2026-10-01：归属彻底换成 turnId）。
 *
 * <p>这一列是前端「回答分组」与「元信息归属」的唯一键，所以「写进去」和「读回来」
 * 都必须真的落到 PO 上；旧数据（该列为 NULL）必须原样读成 {@code null} 而不是报错或补值。</p>
 */
class SessionMessageTurnIdTest {

    private static final long SESSION_ID = 9L;
    private static final long TURN_ID = 5001L;

    private final SessionMessageMapper mapper = mock(SessionMessageMapper.class);
    private final SessionMessageRepositoryImpl repository = new SessionMessageRepositoryImpl(mapper);

    @Test
    @DisplayName("追加消息时把 turnId 写进 PO（而不是只留在领域对象里）")
    void appendPersistsTurnId() {
        repository.appendAll(SESSION_ID, List.of(SessionMessage.builder()
                .id(1001L)
                .sessionId(SESSION_ID)
                .turnId(TURN_ID)
                .type(SessionMessageType.USER)
                .text("你好")
                .createTime(Instant.parse("2026-10-01T10:00:00Z"))
                .build()));

        ArgumentCaptor<SessionMessagePO> inserted = ArgumentCaptor.forClass(SessionMessagePO.class);
        verify(mapper).insert(inserted.capture());
        assertEquals(TURN_ID, inserted.getValue().getTurnId());
        assertEquals(SESSION_ID, inserted.getValue().getSessionId());
    }

    @Test
    @DisplayName("读回来保留 turnId；旧数据（列为 NULL）读成 null，不报错也不补值")
    void readsBackTurnIdAndToleratesLegacyNull() {
        SessionMessagePO withTurn = SessionMessagePO.builder()
                .id(1001L).sessionId(SESSION_ID).turnId(TURN_ID)
                .type(SessionMessageType.AI.name()).content("{}").build();
        SessionMessagePO legacy = SessionMessagePO.builder()
                .id(1002L).sessionId(SESSION_ID).turnId(null)
                .type(SessionMessageType.AI.name()).content("{}").build();
        when(mapper.selectList(any())).thenReturn(List.of(withTurn, legacy));

        List<SessionMessage> loaded = repository.findBySessionId(SESSION_ID);

        assertEquals(TURN_ID, loaded.get(0).getTurnId());
        assertNull(loaded.get(1).getTurnId(), "旧数据归属未知必须是 null，不能伪造一个");
    }
}
