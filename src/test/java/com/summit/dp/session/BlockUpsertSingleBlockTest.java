package com.summit.dp.session;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.conversation.api.ToolCallRequest;
import com.summit.core.conversation.message.AiMessageEntity;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.session.application.convert.ToolBlockEventFacts;
import com.summit.dp.session.application.convert.ToolBlockStatusResolver;
import com.summit.dp.session.application.convert.TurnViewAssembler;
import com.summit.dp.session.application.service.TurnViewService;
import com.summit.dp.session.domain.model.Session;
import com.summit.dp.session.domain.model.SessionMessage;
import com.summit.dp.session.domain.model.SessionMessageType;
import com.summit.dp.session.domain.repo.MessageRepository;
import com.summit.dp.session.domain.repo.SessionRepository;
import com.summit.dp.shared.event.BlockEventType;
import com.summit.dp.shared.vo.block.Block;
import com.summit.dp.shared.vo.block.BlockStatus;
import com.summit.dp.shared.vo.block.ToolBlock;
import com.summit.dp.shared.vo.block.TurnViewVO;
import com.summit.dp.toolcall.application.convert.ToolCallConverter;
import com.summit.dp.toolcall.domain.model.ToolCall;
import com.summit.dp.toolcall.domain.model.ToolCallBlockView;
import com.summit.dp.toolcall.domain.model.ToolCallStatus;
import com.summit.dp.toolcall.domain.model.ToolCallType;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.TurnModelSnapshot;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.application.projection.TurnBroadcastIdentity;
import com.summit.dp.workflow.application.projection.TurnViewBroadcaster;
import com.summit.dp.workflow.infrastructure.stream.SseEventPublisher;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

/**
 * BLOCK_UPSERT 单块构造：只装目标工具块，且与「整轮装配后过滤」逐字段等价。
 *
 * <p>整轮装配再过滤的代价是「为了一个块，把整轮所有工具调用的 4 个 CLOB 全读一遍」，
 * 工具越多越亏。裁列的前提是<b>等价</b>——所以这里先用等价性锁定输出，再断言它没有
 * 装载兄弟工具。只断言「没调 listByIds」守不住输出正确性。</p>
 */
class BlockUpsertSingleBlockTest {

    private static final long SESSION_ID = 8101L;
    private static final long TURN_ID = 8201L;
    private static final long PARENT_TURN_ID = 8301L;
    private static final String TARGET = "call-a1";
    private static final String SIBLING = "call-a2";
    /** 与归属会话必须不同：这条不变量（推给根、载荷带自身）要靠两者不等才验得出来。 */
    private static final long ROOT_SESSION_ID = 8999L;

    private final ObjectMapper json = new ObjectMapper();
    private final MessageRepository messageRepository = mock(MessageRepository.class);
    private final ChatTurnRepository chatTurnRepository = mock(ChatTurnRepository.class);
    private final ToolCallRepository toolCallRepository = mock(ToolCallRepository.class);
    private final SessionRepository sessionRepository = mock(SessionRepository.class);
    private final SseEventPublisher sseEventPublisher = mock(SseEventPublisher.class);
    private final ExecutionLocator executionLocator = mock(ExecutionLocator.class);
    /** 用 spy 盯住「单块路径不得整轮装配」：只断言「最终只剩一个块」是抓不到整轮装配的。 */
    private final TurnViewAssembler turnViewAssembler = spy(new TurnViewAssembler(json,
            new ToolBlockStatusResolver(new ToolCallConverter(json))));
    private final TurnViewService service = new TurnViewService(
            messageRepository, chatTurnRepository, toolCallRepository, turnViewAssembler);

    @Test
    @DisplayName("等价性：单块结果 == 整轮装配后过滤出的同一块（含全部 VO 字段）")
    void singleBlockMatchesFilteredFullView() {
        when(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_ID))).thenReturn(turnMessages());
        when(messageRepository.findUserMessages(SESSION_ID, TURN_ID)).thenReturn(turnMessages());
        when(toolCallRepository.findForBlockUpsert(TARGET)).thenReturn(Optional.of(blockView(TARGET)));
        when(toolCallRepository.listByIds(any())).thenReturn(List.of(fullToolCall(TARGET), fullToolCall(SIBLING)));

        TurnViewVO single = service.assembleToolBlockView(session(), turn(), turn().getVersion(),
                facts(TARGET, 0)).orElseThrow();
        TurnViewVO full = service.assembleTurnView(session(), turn(), turn().getVersion()).orElseThrow();

        // 前提：整轮里确实有两个工具块，单块只留下其中一个 —— 否则「相等」可能只是两边都空。
        assertEquals(2, full.blocks().stream().filter(block -> block.getBlockId().startsWith("tool:")).count());
        assertEquals(1, single.blocks().size(), "单块视图只能有一个块");

        TurnViewVO expected = onlyBlock(full, ToolBlock.identity(TARGET));
        assertEquals(expected, single, "单块视图必须与整轮装配后过滤的结果完全一致");
        assertEquals(expected.blocks(), single.blocks());
        assertEquals(expected.userMessage(), single.userMessage());
        assertEquals(expected.userImageUrls(), single.userImageUrls());
        assertEquals(expected.metric(), single.metric());
        assertEquals(expected.userMessageId(), single.userMessageId());
        assertEquals(expected.resumeSupplements(), single.resumeSupplements());
        assertEquals(expected.status(), single.status());
        assertEquals(expected.viewVersion(), single.viewVersion());
        assertEquals(PARENT_TURN_ID, single.parentTurnId(), "委派身份必须随单块一起下发");
    }

    @Test
    @DisplayName("工具行尚未落库：两条路径都装出 TOOL_STARTED 的单块，仍然等价")
    void missingToolRowStillMatches() {
        when(messageRepository.findByTurnIds(SESSION_ID, List.of(TURN_ID))).thenReturn(turnMessages());
        when(messageRepository.findUserMessages(SESSION_ID, TURN_ID)).thenReturn(turnMessages());
        when(toolCallRepository.findForBlockUpsert(TARGET)).thenReturn(Optional.empty());
        when(toolCallRepository.listByIds(any())).thenReturn(List.of(fullToolCall(SIBLING)));

        TurnViewVO single = service.assembleToolBlockView(session(), turn(), turn().getVersion(),
                facts(TARGET, 0)).orElseThrow();
        TurnViewVO full = service.assembleTurnView(session(), turn(), turn().getVersion()).orElseThrow();

        assertEquals(onlyBlock(full, ToolBlock.identity(TARGET)), single);
        assertEquals(BlockStatus.TOOL_STARTED, single.blocks().getFirst().getStatus(),
                "行还没落库时状态只能是「已开始」，不得假装成功");
    }

    @Test
    @DisplayName("广播器走单块构造：一次增量推送不装载兄弟工具")
    void broadcasterUsesSingleBlockAssembly() {
        when(messageRepository.findUserMessages(SESSION_ID, TURN_ID)).thenReturn(turnMessages());
        when(toolCallRepository.findForBlockUpsert(TARGET)).thenReturn(Optional.of(blockView(TARGET)));
        when(chatTurnRepository.findById(TURN_ID)).thenReturn(Optional.of(turn()));
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(session()));
        TurnViewBroadcaster broadcaster = new TurnViewBroadcaster(
                service, chatTurnRepository, sessionRepository, sseEventPublisher, executionLocator);

        broadcaster.broadcastBlockUpsert(identity(), facts(TARGET, 0));

        ArgumentCaptor<Object> payload = ArgumentCaptor.forClass(Object.class);
        verify(sseEventPublisher).publishBusiness(eq(ROOT_SESSION_ID), eq(BlockEventType.BLOCK_UPSERT), payload.capture());
        TurnViewVO pushed = ((BlockEventType.BlockEventPayload) payload.getValue()).view();
        assertEquals(1, pushed.blocks().size(), "增量只下发变化的那一个块");
        assertEquals(ToolBlock.identity(TARGET), pushed.blocks().getFirst().getBlockId());
        verify(toolCallRepository, never()).listByIds(any());
        // 身份来自事件：根会话不必再解析一次（这条正是「重复解析根会话」被消除的守卫）。
        verify(executionLocator, never()).resolveRootSessionIdOrNull(anyLong());
    }

    @Test
    @DisplayName("单块路径不装载兄弟工具：findForBlockUpsert 一次、listByIds 零次、整轮装配零次")
    void singleBlockPathNeverLoadsSiblings() {
        when(messageRepository.findUserMessages(SESSION_ID, TURN_ID)).thenReturn(turnMessages());
        when(toolCallRepository.findForBlockUpsert(TARGET)).thenReturn(Optional.of(blockView(TARGET)));

        service.assembleToolBlockView(session(), turn(), 1L, facts(TARGET, 0));

        ArgumentCaptor<String> id = ArgumentCaptor.forClass(String.class);
        verify(toolCallRepository, times(1)).findForBlockUpsert(id.capture());
        assertEquals(TARGET, id.getValue());
        verify(toolCallRepository, never()).listByIds(any());
        verify(toolCallRepository, never()).findById(anyString());
        verify(messageRepository, never()).findBySessionId(anyLong());
        verify(messageRepository, never()).findByTurnIds(anyLong(), any());
        // 该轮 USER 行仍要取一次（提问 / 图片 / 补录 / 用户消息 id 的唯一来源），但只此一次。
        verify(messageRepository, times(1)).findUserMessages(SESSION_ID, TURN_ID);
        // 关键守卫：整轮装配一次都不许调 —— 只要回退成 buildView→assembleBlocks 再过滤，这条立刻红。
        verify(turnViewAssembler, never()).assembleBlocks(any(), any(), any(), any());
    }

    @Test
    @DisplayName("广播器走单块构造时也不整轮装配：不装载兄弟工具、不调 assembleBlocks")
    void broadcasterPathNeverAssemblesWholeTurn() {
        when(messageRepository.findUserMessages(SESSION_ID, TURN_ID)).thenReturn(turnMessages());
        when(toolCallRepository.findForBlockUpsert(TARGET)).thenReturn(Optional.of(blockView(TARGET)));
        when(chatTurnRepository.findById(TURN_ID)).thenReturn(Optional.of(turn()));
        when(sessionRepository.findById(SESSION_ID)).thenReturn(Optional.of(session()));
        TurnViewBroadcaster broadcaster = new TurnViewBroadcaster(
                service, chatTurnRepository, sessionRepository, sseEventPublisher, executionLocator);

        broadcaster.broadcastBlockUpsert(identity(), facts(TARGET, 0));

        verify(turnViewAssembler, never()).assembleBlocks(any(), any(), any(), any());
        verify(toolCallRepository, never()).listByIds(any());
    }

    /** 事件自带的权威归属：轮次、轮次自身会话、路由根会话。 */
    private static TurnBroadcastIdentity identity() {
        return new TurnBroadcastIdentity(TURN_ID, SESSION_ID, ROOT_SESSION_ID);
    }

    /** 工具事件带来的块事实：与 {@link #turnMessages()} 里那条 AI 行的请求逐字段一致。 */
    private static ToolBlockEventFacts facts(String toolCallId, int requestIndex) {
        String args = requestIndex == 0 ? "{\"path\":\"a\"}" : "{\"command\":\"ls\"}";
        String toolName = requestIndex == 0 ? "read_file" : "command";
        return new ToolBlockEventFacts(toolCallId, "12", requestIndex, toolName, args);
    }

    /** 测试侧的独立过滤实现：不复用待测类的私有方法，避免「用实现验证实现」。 */
    private static TurnViewVO onlyBlock(TurnViewVO view, String blockId) {
        List<Block> filtered = view.blocks().stream().filter(block -> blockId.equals(block.getBlockId())).toList();
        return new TurnViewVO(view.sessionId(), view.turnId(), view.status(), view.viewVersion(),
                view.userMessage(), view.userImageUrls(), filtered, view.metric(), view.userMessageId(),
                view.resumeSupplements(), view.parentTurnId());
    }

    private List<SessionMessage> turnMessages() {
        SessionMessage user = SessionMessage.builder().id(11L).sessionId(SESSION_ID).turnId(TURN_ID)
                .type(SessionMessageType.USER).text("问题甲").createTime(Instant.now()).build();
        AiMessageEntity ai = new AiMessageEntity();
        ai.setText("正文");
        ai.setThinking("思考");
        ai.setToolCalls(List.of(new ToolCallRequest(TARGET, "read_file", 0, "{\"path\":\"a\"}"),
                new ToolCallRequest(SIBLING, "command", 1, "{\"command\":\"ls\"}")));
        SessionMessage aiRow = SessionMessage.builder().id(12L).sessionId(SESSION_ID).turnId(TURN_ID)
                .responseId("12").type(SessionMessageType.AI)
                .text(json.valueToTree(ai).toString()).createTime(Instant.now()).build();
        return List.of(user, aiRow);
    }

    private static ToolCall fullToolCall(String id) {
        return ToolCall.builder()
                .id(id).conversationId(SESSION_ID).executionId(SESSION_ID * 10)
                .toolName("read_file").type(ToolCallType.EXECUTE).status(ToolCallStatus.COMPLETED)
                .content("{\"kind\":\"PLAN\",\"content\":\"" + "内容".repeat(500) + "\"}")
                .rawInput("{\"args\":{\"path\":\"" + "x".repeat(500) + "\"}}")
                .rawOutput("{\"outcome\":\"SUCCEEDED\",\"output\":\"" + "输出".repeat(2000) + "\"}")
                .metaData("{\"_meta\":{\"schemaVersion\":1}}")
                .version(3L)
                .createdAt(Instant.now()).updatedAt(Instant.now())
                .build();
    }

    /** 只读投影：与 {@link #fullToolCall} 装配块所需的那几个字段一致（含大 raw_output）。 */
    private static ToolCallBlockView blockView(String id) {
        ToolCall full = fullToolCall(id);
        return new ToolCallBlockView(full.getId(), full.getConversationId(), full.getToolName(),
                full.getType(), full.getStatus(), full.getRawOutput(), full.getVersion(),
                full.getExecutionId());
    }

    private static Session session() {
        return Session.builder().id(SESSION_ID).rootSessionId(SESSION_ID)
                .contextTokenCount(900L).contextMaxTokens(1800).build();
    }

    private static ChatTurn turn() {
        ChatTurn turn = ChatTurn.accept(TURN_ID, SESSION_ID, PARENT_TURN_ID,
                TurnModelSnapshot.of("deepseek-chat", "deepseek", null));
        turn.acceptPersistedVersion(7L);
        return turn;
    }
}
