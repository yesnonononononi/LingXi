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
import com.summit.dp.shared.vo.block.Block;
import com.summit.dp.shared.vo.block.TurnViewVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.TurnModelSnapshot;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Instant;
import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;

/**
 * 历史分页按当页装载装配块：不再逐轮回查消息与工具调用。
 *
 * <p>N 轮的老路径是 2N 次查询（每轮 {@code findByTurnIds} + {@code listByIds}）。
 * 这里钉住两件事：<b>查询次数</b>（消息 0 次、工具调用 1 次），以及<b>等价性</b> ——
 * 批量装配的结果必须与逐轮 {@code assembleTurnView} 逐字段相等，否则只是「查得少」而不是「查得对」。</p>
 */
class TurnViewServiceBatchAssemblyTest {

    private static final long SESSION_ID = 3001L;
    private static final long TURN_A = 4001L;
    private static final long TURN_B = 4002L;

    private final ObjectMapper json = new ObjectMapper();
    private final MessageRepository messageRepository = mock(MessageRepository.class);
    private final ChatTurnRepository chatTurnRepository = mock(ChatTurnRepository.class);
    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);
    private final TurnViewService service = new TurnViewService(
            messageRepository, chatTurnRepository, toolCallRepository,
            new TurnViewAssembler(json, new ToolBlockStatusResolver(new ToolCallConverter(json))),
            mock(com.summit.dp.turn.application.port.TurnFileChangeQuery.class));

    @Test
    @DisplayName("一次页装配：消息 0 次回查、工具调用恰好 1 次 IN（跨轮并集）")
    void pageAssemblyQueriesOnce() {
        List<SessionMessage> page = pageMessages();
        when(toolCallRepository.listByIds(any())).thenReturn(toolCalls());

        Map<String, TurnViewVO> views = service.assembleTurnViews(session(), List.of(turnA(), turnB()), page);

        assertEquals(Set.of(String.valueOf(TURN_A), String.valueOf(TURN_B)), views.keySet());
        verify(messageRepository, never()).findByTurnIds(anyLong(), any());
        @SuppressWarnings("unchecked")
        ArgumentCaptor<Collection<String>> ids = ArgumentCaptor.forClass(Collection.class);
        verify(toolCallRepository, times(1)).listByIds(ids.capture());
        assertEquals(Set.of("call-a1", "call-a2", "call-b1"), new HashSet<>(ids.getValue()),
                "一次 IN 必须覆盖当页所有轮次的工具调用");
    }

    @Test
    @DisplayName("等价性：批量装配与逐轮 assembleTurnView 的结果逐字段相等")
    void batchAssemblyMatchesPerTurnAssembly() {
        List<SessionMessage> page = pageMessages();
        when(toolCallRepository.listByIds(any())).thenReturn(toolCalls());
        // 逐轮基线：每轮各自查自己那一轮的消息（与 findByTurnIds 的真实返回一致）。
        when(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_A))).thenReturn(messagesOf(page, TURN_A));
        when(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_B))).thenReturn(messagesOf(page, TURN_B));

        Map<String, TurnViewVO> batch = service.assembleTurnViews(session(), List.of(turnA(), turnB()), page);
        TurnViewVO baselineA = service.assembleTurnView(session(), turnA(), turnA().getVersion()).orElseThrow();
        TurnViewVO baselineB = service.assembleTurnView(session(), turnB(), turnB().getVersion()).orElseThrow();

        // 前提：两份基线各自真的装出了工具块，否则「相等」可能只是两个空视图。
        assertFalse(blocksOf(baselineA, "tool:").isEmpty(), "前提：轮次 A 必须有工具块");
        assertFalse(blocksOf(baselineB, "tool:").isEmpty(), "前提：轮次 B 必须有工具块");

        assertEquals(baselineA, batch.get(String.valueOf(TURN_A)), "轮次 A 的批量结果必须与逐轮结果完全一致");
        assertEquals(baselineB, batch.get(String.valueOf(TURN_B)), "轮次 B 的批量结果必须与逐轮结果完全一致");
        // 逐字段再点一遍关键项，失败时能直接看出是哪一项漂了。
        assertEquals(baselineA.blocks(), batch.get(String.valueOf(TURN_A)).blocks());
        assertEquals(baselineA.userMessage(), batch.get(String.valueOf(TURN_A)).userMessage());
        assertEquals(baselineA.userMessageId(), batch.get(String.valueOf(TURN_A)).userMessageId());
        assertEquals(baselineA.metric(), batch.get(String.valueOf(TURN_A)).metric());
        assertEquals(baselineA.viewVersion(), batch.get(String.valueOf(TURN_A)).viewVersion());
        assertEquals(baselineA.status(), batch.get(String.valueOf(TURN_A)).status());
    }

    @Test
    @DisplayName("孤儿行（turn_id 为 null）不参与任何一轮，也不影响已有轮次的装配")
    void orphanRowsAreIgnored() {
        List<SessionMessage> page = new java.util.ArrayList<>(pageMessages());
        page.add(SessionMessage.builder().id(1L).sessionId(SESSION_ID).turnId(null)
                .type(SessionMessageType.USER).text("旧消息").build());
        when(toolCallRepository.listByIds(any())).thenReturn(toolCalls());
        when(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_A))).thenReturn(messagesOf(page, TURN_A));

        Map<String, TurnViewVO> batch = service.assembleTurnViews(session(), List.of(turnA()), page);

        assertEquals(service.assembleTurnView(session(), turnA(), turnA().getVersion()).orElseThrow(),
                batch.get(String.valueOf(TURN_A)));
    }

    @Test
    @DisplayName("版本号逐轮取自身 version；空轮次集合直接返回空表，不发查询")
    void viewVersionComesFromEachTurn() {
        long versionA = turnA().getVersion();
        long versionB = turnB().getVersion();
        assertTrue(versionA != versionB, "前提：两轮版本号必须不同，否则「逐轮取自身版本」是等价变异");

        when(toolCallRepository.listByIds(any())).thenReturn(toolCalls());
        Map<String, TurnViewVO> views = service.assembleTurnViews(session(), List.of(turnA(), turnB()), pageMessages());

        assertEquals(versionA, views.get(String.valueOf(TURN_A)).viewVersion());
        assertEquals(versionB, views.get(String.valueOf(TURN_B)).viewVersion());
    }

    @Test
    @DisplayName("空轮次集合：直接返回空表，一次查询都不发")
    void emptyTurnsSkipAllQueries() {
        assertTrue(service.assembleTurnViews(session(), List.of(), pageMessages()).isEmpty());

        verifyNoInteractions(messageRepository, toolCallRepository);
    }

    private static List<Block> blocksOf(TurnViewVO view, String blockIdPrefix) {
        return view.blocks().stream().filter(block -> block.getBlockId().startsWith(blockIdPrefix)).toList();
    }

    private static List<SessionMessage> messagesOf(List<SessionMessage> page, long turnId) {
        return page.stream().filter(message -> Long.valueOf(turnId).equals(message.getTurnId())).toList();
    }

    /** 当页消息：两轮各一条 USER + 一条 AI（AI 行带工具请求）。 */
    private List<SessionMessage> pageMessages() {
        return List.of(
                userRow(11L, TURN_A, "问题甲"),
                aiRow(12L, TURN_A, List.of(new ToolCallRequest("call-a1", "read_file", 0, "{}"),
                        new ToolCallRequest("call-a2", "command", 1, "{}"))),
                userRow(21L, TURN_B, "问题乙"),
                aiRow(22L, TURN_B, List.of(new ToolCallRequest("call-b1", "read_file", 0, "{}"))));
    }

    private static SessionMessage userRow(long id, long turnId, String text) {
        return SessionMessage.builder().id(id).sessionId(SESSION_ID).turnId(turnId)
                .type(SessionMessageType.USER).text(text).createTime(Instant.now()).build();
    }

    private static SessionMessage aiRow(long id, long turnId, List<ToolCallRequest> requests) {
        AiMessageEntity ai = new AiMessageEntity();
        ai.setText("正文");
        ai.setThinking("思考");
        ai.setToolCalls(requests);
        String payload;
        try {
            payload = new ObjectMapper().valueToTree(ai).toString();
        } catch (RuntimeException error) {
            throw new IllegalStateException("构造 AI 行载荷失败", error);
        }
        return SessionMessage.builder().id(id).sessionId(SESSION_ID).turnId(turnId)
                .responseId(String.valueOf(id)).type(SessionMessageType.AI)
                .text(payload).createTime(Instant.now()).build();
    }

    private static ToolCall toolCall(String id, long conversationId) {
        return ToolCall.builder()
                .id(id).conversationId(conversationId).executionId(conversationId * 10)
                .toolName("read_file").type(ToolCallType.EXECUTE).status(ToolCallStatus.COMPLETED)
                .rawOutput("{\"outcome\":\"SUCCEEDED\",\"output\":\"正文\"}")
                .createdAt(Instant.now()).updatedAt(Instant.now())
                .build();
    }

    private static List<ToolCall> toolCalls() {
        return List.of(toolCall("call-a1", SESSION_ID), toolCall("call-a2", SESSION_ID),
                toolCall("call-b1", SESSION_ID));
    }

    private static Session session() {
        return Session.builder().id(SESSION_ID).rootSessionId(SESSION_ID)
                .contextTokenCount(1200L).contextMaxTokens(2400).build();
    }

    private static ChatTurn turnA() {
        ChatTurn turn = ChatTurn.accept(TURN_A, SESSION_ID, 777L, TurnModelSnapshot.of("deepseek-chat", "deepseek", null));
        turn.acceptPersistedVersion(3L);
        return turn;
    }

    private static ChatTurn turnB() {
        ChatTurn turn = ChatTurn.accept(TURN_B, SESSION_ID, null, TurnModelSnapshot.of("deepseek-chat", "deepseek", null));
        turn.acceptPersistedVersion(5L);
        return turn;
    }
}
