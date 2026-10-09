package com.summit.dp.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.core.conversation.message.ToolMessageEntity;
import com.summit.dp.session.application.convert.TranscriptRecordAssembler;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.session.application.service.TranscriptReplayMatcher;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.shared.exception.ClientException;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 响应身份的落库语义：身份参与幂等判定，且只挂在 AI 行。
 *
 * <p>这两条是「响应身份」这件事在业务侧的全部可观测后果 —— 身份不写进行、或不参与去重，
 * 框架那边传得再对也没有意义。</p>
 */
class ConversationTranscriptResponseIdTest {

    private static final String RESPONSE_ID = "2b8f4d16-7a35-4e92-b1c8-5f0d3a7e9b24";
    private static final long SESSION_ID = 700L;
    private static final long TURN_ID = 800L;

    private final MessageRepository messages = mock(MessageRepository.class);
    private final ToolCallRepository toolCalls = mock(ToolCallRepository.class);
    private final ObjectMapper json = new ObjectMapper();
    private final ConversationTranscriptService service = new ConversationTranscriptService(
            messages, toolCalls, new TranscriptRecordAssembler(json), new TranscriptReplayMatcher(json));

    /**
     * 身份必须真的写进 AI 行 —— 只做去重判定、不落到记录上，等于身份白传。
     *
     * <p>断言的是 {@code appendAll} 收到的记录本身，而不是「调用过 appendAll」：
     * 后者对「身份没进记录」这种回退完全不敏感。</p>
     */
    @Test
    void responseIdLandsOnTheAiRecord() {
        service.appendRound(SESSION_ID, null, TURN_ID,
                AiMessageEntity.builder().text("answer").build(),
                List.of(ToolMessageEntity.builder().id("call_1").name("read_file").text("内容").build()),
                RESPONSE_ID);

        ArgumentCaptor<List<SessionMessage>> captured = ArgumentCaptor.forClass(List.class);
        verify(messages).appendAll(eq(SESSION_ID), any(), captured.capture());

        List<SessionMessage> records = captured.getValue();
        SessionMessage ai = records.stream().filter(r -> r.getType() == SessionMessageType.AI)
                .findFirst().orElseThrow();
        assertEquals(RESPONSE_ID, ai.getResponseId());

        // 顺序同样只挂 AI 行：工具行靠「排在所属 AI 行之后」定序，各存一份迟早对不上。
        // 断言的是记录里的值，而不是「调用过 countAiMessagesInTurn」—— 后者对「算完没写进记录」不敏感。
        assertEquals(0, ai.getResponseOrder());
        records.stream().filter(r -> r.getType() == SessionMessageType.TOOL)
                .forEach(r -> {
                    // 工具行不得带身份：同一轮的多个工具行共享一个 responseId，都存会撞唯一索引。
                    assertNull(r.getResponseId());
                    assertNull(r.getResponseOrder());
                });
    }

    /**
     * 序号必须来自「该轮已有 AI 行数」，而不是写死的 0。
     *
     * <p>一轮里可以发生多次模型调用（思考 → 工具 → 再思考），第二次调用的序号必须是 1。
     * 若实现退化成常量或「插入后自增」，这条用例变红。</p>
     */
    @Test
    void responseOrderCountsAiRowsAlreadyInTurn() {
        when(messages.countAiMessagesInTurn(SESSION_ID, TURN_ID)).thenReturn(2L);

        service.appendRound(SESSION_ID, null, TURN_ID,
                AiMessageEntity.builder().text("第三轮思考").build(), List.of(), RESPONSE_ID);

        ArgumentCaptor<List<SessionMessage>> captured = ArgumentCaptor.forClass(List.class);
        verify(messages).appendAll(eq(SESSION_ID), any(), captured.capture());

        SessionMessage ai = captured.getValue().stream()
                .filter(r -> r.getType() == SessionMessageType.AI).findFirst().orElseThrow();
        assertEquals(2, ai.getResponseOrder());
    }

    @Test
    void numericResponseDoesNotAllocateSequenceButStillLocksForIdempotency() {
        String responseId = "9007199254740993";
        service.appendRound(SESSION_ID, null, TURN_ID,
                AiMessageEntity.builder().text("新响应").build(), List.of(), responseId);
        ArgumentCaptor<List<SessionMessage>> captured = ArgumentCaptor.forClass(List.class);
        verify(messages).lockSessionForAppend(SESSION_ID);
        verify(messages).findByResponseId(SESSION_ID, responseId);
        verify(messages, never()).countAiMessagesInTurn(SESSION_ID, TURN_ID);
        verify(messages).appendAll(eq(SESSION_ID), any(), captured.capture());
        SessionMessage ai = captured.getValue().getFirst();
        assertEquals(responseId, ai.getResponseId());
        assertNull(ai.getResponseOrder());
    }

    /**
     * 同一会话 + 同一响应身份、且内容一致的重复落库 → 幂等返回，不再追加。
     *
     * <p>这是幂等索引 {@code (session_id, response_id)} 的应用层前置拦截；
     * 少了它，重复落库要么撞唯一索引报错、要么（若身份没传下去）静默产生两条同轮 AI 行。</p>
     *
     * <p>注意：已落库行必须与本次内容**一致**才是重放。内容不一致走
     * {@link #driftingReplayIsRejectedInsteadOfSilentlyDropped()}。</p>
     */
    @Test
    void duplicateResponseIdIsNotAppendedTwice() throws Exception {
        AiMessageEntity ai = AiMessageEntity.builder().text("answer").build();
        when(messages.findByResponseId(SESSION_ID, RESPONSE_ID)).thenReturn(Optional.of(
                SessionMessage.builder().id(1L).sessionId(SESSION_ID).responseId(RESPONSE_ID)
                        .turnId(TURN_ID).type(SessionMessageType.AI)
                        .text(json.writeValueAsString(ai)).build()));

        service.appendRound(SESSION_ID, null, TURN_ID, ai, List.of(), RESPONSE_ID);

        verify(messages, never()).appendAll(anyLong(), any(), any());
    }

    /**
     * 落库前必须先锁会话行，把并发落库串行化。
     *
     * <p>这是 C-1 的修复本体：旧实现只有「查 → 插」，两个并发方会同时通过检查，
     * 再一起去撞唯一索引。回归删除 {@code lockSessionForAppend} 调用即变红。</p>
     */
    @Test
    void appendRoundLocksSessionBeforeIdempotencyCheck() {
        service.appendRound(SESSION_ID, null, TURN_ID,
                AiMessageEntity.builder().text("answer").build(), List.of(), RESPONSE_ID);

        verify(messages).lockSessionForAppend(SESSION_ID);
    }

    /**
     * 同一身份、内容不一致 → 拒绝落库并报错，而不是静默丢弃第二次。
     *
     * <p>内容漂移说明有人的状态算错了。旧实现查到「身份已存在」就 {@code return}，
     * 把漂移静默吞掉 —— 这条用例存在的意义就是让那种实现变红。</p>
     */
    @Test
    void driftingReplayIsRejectedInsteadOfSilentlyDropped() throws Exception {
        AiMessageEntity stored = AiMessageEntity.builder().text("第一次的输出").build();
        when(messages.findByResponseId(SESSION_ID, RESPONSE_ID)).thenReturn(Optional.of(
                SessionMessage.builder().id(1L).sessionId(SESSION_ID).responseId(RESPONSE_ID)
                        .turnId(TURN_ID).type(SessionMessageType.AI)
                        .text(json.writeValueAsString(stored)).build()));

        AiMessageEntity incoming = AiMessageEntity.builder().text("内容变了").build();
        ClientException error = assertThrows(ClientException.class, () ->
                service.appendRound(SESSION_ID, null, TURN_ID, incoming, List.of(), RESPONSE_ID));

        // 报错文案必须带身份，方便定位是哪一轮漂移。
        assertTrue(error.getMessage().contains(RESPONSE_ID.toString()));
        verify(messages, never()).appendAll(anyLong(), any(), any());
    }

    /**
     * 轮次归属不同也算漂移（同一 responseId 不该横跨两轮）。
     */
    @Test
    void differentTurnOwnershipIsTreatedAsDrift() throws Exception {
        AiMessageEntity ai = AiMessageEntity.builder().text("answer").build();
        when(messages.findByResponseId(SESSION_ID, RESPONSE_ID)).thenReturn(Optional.of(
                SessionMessage.builder().id(1L).sessionId(SESSION_ID).responseId(RESPONSE_ID)
                        .turnId(TURN_ID + 1).type(SessionMessageType.AI)
                        .text(json.writeValueAsString(ai)).build()));

        assertThrows(ClientException.class, () ->
                service.appendRound(SESSION_ID, null, TURN_ID, ai, List.of(), RESPONSE_ID));
    }

    /** 身份未知（框架没下发）时不参与去重、不加锁，照常追加 —— 与旧数据口径一致。 */
    @Test
    void unknownResponseIdAlwaysAppends() {
        service.appendRound(SESSION_ID, null, TURN_ID,
                AiMessageEntity.builder().text("answer").build(), List.of());

        verify(messages).appendAll(eq(SESSION_ID), any(), any());
        verify(messages, never()).lockSessionForAppend(anyLong());
        verifyNoInteractions(toolCalls);
    }
}
