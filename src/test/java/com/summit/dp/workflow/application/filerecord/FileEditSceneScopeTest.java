package com.summit.dp.workflow.application.filerecord;

import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 查看作用域：一个会话 → 它所在整棵会话树的轮次标识。
 *
 * <p>口径是「同一棵树」，所以子会话必须回到根再展开 —— 子 Agent 改的文件也是这个文件的历史。
 * 只查本会话会漏掉子 Agent 刚改完的状态，用户点「最新改动」看到旧内容。</p>
 */
class FileEditSceneScopeTest {

    private final SessionRepository sessions = mock(SessionRepository.class);
    private final ChatTurnRepository turns = mock(ChatTurnRepository.class);
    private final FileEditSceneScope scope = new FileEditSceneScope(sessions, turns);

    @Test
    void subSessionResolvesThroughItsWholeTree() {
        when(sessions.findById(10L)).thenReturn(Optional.of(Session.builder()
                .id(10L).rootSessionId(3L).build()));
        when(sessions.findSessionTree(3L)).thenReturn(List.of(
                Session.builder().id(3L).rootSessionId(Session.ROOT_SESSION_ID).build(),
                Session.builder().id(10L).rootSessionId(3L).build()));
        when(turns.findIdsBySessionIds(List.of(3L, 10L))).thenReturn(List.of(70L, 77L));

        assertEquals(List.of("70", "77"), scope.resolveSceneTurnIds(10L));
    }

    @Test
    void rootSessionIsItsOwnScope() {
        when(sessions.findById(3L)).thenReturn(Optional.of(Session.builder()
                .id(3L).rootSessionId(Session.ROOT_SESSION_ID).build()));
        when(sessions.findSessionTree(3L)).thenReturn(List.of(
                Session.builder().id(3L).rootSessionId(Session.ROOT_SESSION_ID).build()));
        when(turns.findIdsBySessionIds(List.of(3L))).thenReturn(List.of(70L));

        assertEquals(List.of("70"), scope.resolveSceneTurnIds(3L));
    }

    @Test
    void unknownSessionIsRejected() {
        when(sessions.findById(9L)).thenReturn(Optional.empty());

        assertThrows(ClientException.class, () -> scope.resolveSceneTurnIds(9L));
    }
}
