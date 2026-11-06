package com.summit.dp.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.ddd.application.vo.Result;
import com.summit.dp.agent.domain.repository.AgentRepository;
import com.summit.dp.execution.application.service.ExecutionQueryService;
import com.summit.dp.session.application.convert.ToolBlockStatusResolver;
import com.summit.dp.session.application.convert.TurnViewAssembler;
import com.summit.dp.session.application.service.SessionAggregateService;
import com.summit.dp.session.application.service.SessionMessageQueryService;
import com.summit.dp.session.application.service.TurnViewService;
import com.summit.dp.session.application.service.impl.SessionServiceImpl;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.model.CursorResult;
import com.summit.dp.shared.vo.SessionMessagePageVO;
import com.summit.dp.shared.vo.block.TurnViewVO;
import com.summit.dp.team.application.service.TeamService;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.application.convert.ChatTurnConverter;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.TurnModelSnapshot;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workspace.application.service.WorkspaceService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Instant;
import java.util.Collection;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;

/**
 * 历史分页的装配块必须复用当页已查出的消息：{@code messages} 这条路径上一页 N 轮
 * 原先要发 2N 次查询（逐轮 {@code findByTurnIds} + 逐轮 {@code listByIds}）。
 *
 * <p>本类走的是<b>真正的调用方</b>（{@code SessionServiceImpl#messages}），不是装配服务本身 ——
 * 否则把调用方回退成逐轮循环，装配服务上的用例照样全绿，这条回归守卫就形同虚设。</p>
 */
class SessionMessagesBlockViewsTest {

    private static final long SESSION_ID = 6001L;
    private static final long TURN_A = 7001L;
    private static final long TURN_B = 7002L;

    private final SessionAggregateService aggregateService = mock(SessionAggregateService.class);
    private final SessionMessageQueryService messageQueryService = mock(SessionMessageQueryService.class);
    private final ChatTurnService chatTurnService = mock(ChatTurnService.class);
    private final MessageRepository messageRepository = mock(MessageRepository.class);
    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);

    private final SessionServiceImpl sessionService = new SessionServiceImpl(
            aggregateService,
            mock(WorkspaceService.class),
            mock(SessionRepository.class),
            messageQueryService,
            mock(ExecutionQueryService.class),
            mock(TeamService.class),
            mock(AgentRepository.class),
            chatTurnService,
            new ChatTurnConverter(),
            new TurnViewService(messageRepository, mock(ChatTurnRepository.class), toolCallRepository,
                    new TurnViewAssembler(new ObjectMapper(),
                            new ToolBlockStatusResolver(new ToolCallConverter(new ObjectMapper())))));

    @BeforeEach
    void stubPage() {
        when(aggregateService.requireOwned(SESSION_ID))
                .thenReturn(Session.builder().id(SESSION_ID).rootSessionId(0L).historyRevision(1L).build());
        when(aggregateService.messageSlice(SESSION_ID, null, 50)).thenReturn(
                new CursorResult<>(List.of(
                        userRow(1L, TURN_A, "问题甲"),
                        aiRow(2L, TURN_A, new ToolCallRequest("call-a1", "read_file", 0, "{}")),
                        userRow(3L, TURN_B, "问题乙"),
                        aiRow(4L, TURN_B, new ToolCallRequest("call-b1", "read_file", 0, "{}"))), null, false));
        when(messageQueryService.query(any()))
                .thenReturn(new SessionMessageQueryService.SessionMessageQueryResult(List.of(), 0));
        Map<Long, ChatTurn> turns = new LinkedHashMap<>();
        turns.put(TURN_A, turn(TURN_A, 4L));
        turns.put(TURN_B, turn(TURN_B, 6L));
        when(chatTurnService.findByIds(any())).thenReturn(turns);
        when(toolCallRepository.listByIds(any())).thenReturn(List.of(
                completedCall("call-a1"), completedCall("call-b1")));
    }

    @Test
    @DisplayName("一页两轮：不再逐轮回查消息，工具调用只查一次（并集）")
    void pageAssemblyDoesNotReloadPerTurn() {
        Result<SessionMessagePageVO> result = sessionService.messages(SESSION_ID, null, 50);

        Map<String, TurnViewVO> views = result.getData().getTurnViews();
        assertEquals(Set.of(String.valueOf(TURN_A), String.valueOf(TURN_B)), views.keySet());

        verify(messageRepository, never()).findByTurnIds(anyLong(), any());
        @SuppressWarnings("unchecked")
        ArgumentCaptor<Collection<String>> ids = ArgumentCaptor.forClass(Collection.class);
        verify(toolCallRepository, times(1)).listByIds(ids.capture());
        assertEquals(Set.of("call-a1", "call-b1"), new HashSet<>(ids.getValue()));

        // 视图内容仍然正确：两轮各自带自己的工具块，版本号取各自轮次的 version。
        assertEquals(4L, views.get(String.valueOf(TURN_A)).viewVersion());
        assertEquals(6L, views.get(String.valueOf(TURN_B)).viewVersion());
        assertTrue(views.values().stream().allMatch(view -> view.blocks().stream()
                .anyMatch(block -> block.getBlockId().startsWith("tool:"))), "前提：当页两轮都应有工具块");
    }

    private static ChatTurn turn(long turnId, long version) {
        ChatTurn turn = ChatTurn.accept(turnId, SESSION_ID, null,
                TurnModelSnapshot.of("deepseek-chat", "deepseek", null));
        turn.acceptPersistedVersion(version);
        return turn;
    }

    private static ToolCall completedCall(String id) {
        return ToolCall.builder()
                .id(id).conversationId(SESSION_ID).executionId(SESSION_ID * 10)
                .toolName("read_file").type(ToolCallType.EXECUTE).status(ToolCallStatus.COMPLETED)
                .rawOutput("{\"outcome\":\"SUCCEEDED\",\"output\":\"正文\"}")
                .createdAt(Instant.now()).updatedAt(Instant.now())
                .build();
    }

    private static SessionMessage userRow(long id, long turnId, String text) {
        return SessionMessage.builder().id(id).sessionId(SESSION_ID).turnId(turnId)
                .type(SessionMessageType.USER).text(text).createTime(Instant.now()).build();
    }

    private static SessionMessage aiRow(long id, long turnId, ToolCallRequest request) {
        AiMessageEntity ai = new AiMessageEntity();
        ai.setText("正文");
        ai.setToolCalls(List.of(Objects.requireNonNull(request)));
        return SessionMessage.builder().id(id).sessionId(SESSION_ID).turnId(turnId)
                .responseId(String.valueOf(id)).type(SessionMessageType.AI)
                .text(new ObjectMapper().valueToTree(ai).toString()).createTime(Instant.now()).build();
    }
}
