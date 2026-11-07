package com.summit.dp.session;

import com.summit.core.conversation.event.ToolCallEndEvent;
import com.summit.core.conversation.event.ToolCallStartEvent;
import com.summit.core.tool.ToolCallStatus;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.session.application.convert.ToolBlockEventFacts;
import com.summit.dp.turn.domain.model.ChatTurn;
import com.summit.dp.turn.domain.model.TurnModelSnapshot;
import com.summit.dp.turn.domain.repo.ChatTurnRepository;
import com.summit.dp.workflow.application.projection.TurnBroadcastIdentity;
import com.summit.dp.workflow.application.projection.TurnViewBroadcaster;
import com.summit.dp.workflow.infrastructure.listener.session.BlockUpsertRuntimeListener;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

class BlockUpsertRuntimeListenerTest {

    private final TurnViewBroadcaster broadcaster = mock(TurnViewBroadcaster.class);
    private final ChatTurnRepository turns = mock(ChatTurnRepository.class);
    private final BlockUpsertRuntimeListener listener = new BlockUpsertRuntimeListener(broadcaster, turns);

    @Test
    @DisplayName("事件元数据齐备：把权威归属原样交给广播器，一次反查都不做")
    void metadataCompleteSkipsReverseLookup() {
        listener.onToolCall(new ToolCallStartEvent("command", "800", "execute_command", "{\"cmd\":\"ls\"}",
                "101", metadata(), 2));

        ArgumentCaptor<TurnBroadcastIdentity> identity =
                ArgumentCaptor.forClass(TurnBroadcastIdentity.class);
        verify(broadcaster).broadcastBlockUpsert(identity.capture(), any(ToolBlockEventFacts.class));
        assertEquals(900L, identity.getValue().turnId(), "轮次来自元数据");
        assertEquals(7L, identity.getValue().sessionId(), "会话归属来自元数据");
        assertEquals(70L, identity.getValue().rootSessionId(), "路由根会话来自元数据");
        // 关键守卫：按执行 ID 反查轮次这次查询必须消失，否则等于把权威身份又查一遍。
        verify(turns, never()).findByExecutionId(anyLong());
    }

    @Test
    @DisplayName("元数据缺失（旧检查点）：回退按执行 ID 反查轮次，语义与改造前一致")
    void metadataMissingFallsBackToExecutionLookup() {
        ChatTurn turn = ChatTurn.accept(900L, 7L, null, TurnModelSnapshot.of("model", "provider", null));
        when(turns.findByExecutionId(800L)).thenReturn(Optional.of(turn));

        listener.onToolCall(new ToolCallStartEvent("command", "800", "execute_command", "{\"cmd\":\"ls\"}",
                "101", Map.of(), 2));

        ToolBlockEventFacts facts = captureFactsFromFallback();
        assertEquals("command", facts.toolCallId());
        assertEquals("101", facts.responseId(), "响应身份必须来自框架事件，不再回查 AI 行");
        assertEquals(2, facts.requestIndex(), "请求位置必须来自框架事件，决定块内顺序");
        assertEquals("execute_command", facts.toolName());
        assertEquals("{\"cmd\":\"ls\"}", facts.args(), "原始参数必须来自框架事件");
        verify(turns, times(1)).findByExecutionId(800L);
        verifyNoMoreInteractions(turns);
    }

    /** 捕获回退路径交给广播器的事件事实（Long 重载即回退口径的契约）。 */
    private ToolBlockEventFacts captureFactsFromFallback() {
        ArgumentCaptor<ToolBlockEventFacts> facts = ArgumentCaptor.forClass(ToolBlockEventFacts.class);
        verify(broadcaster).broadcastBlockUpsert(eq(900L), facts.capture());
        return facts.getValue();
    }

    @Test
    @DisplayName("工具结束（非 PROMISED）：元数据齐备时同样走权威身份")
    void completionWithMetadataSkipsReverseLookup() {
        listener.onToolCallOutput(new ToolCallEndEvent("command", "800", "101", "execute_command",
                "{}", "完成", metadata(), ToolCallStatus.COMPLETED, 0));

        ArgumentCaptor<TurnBroadcastIdentity> identity =
                ArgumentCaptor.forClass(TurnBroadcastIdentity.class);
        verify(broadcaster).broadcastBlockUpsert(identity.capture(), any(ToolBlockEventFacts.class));
        assertEquals(900L, identity.getValue().turnId());
        verify(turns, never()).findByExecutionId(anyLong());
    }

    @Test
    @DisplayName("元数据半份（缺根会话）：整份回退反查，不拼半份身份")
    void partialMetadataFallsBack() {
        ChatTurn turn = ChatTurn.accept(900L, 7L, null, TurnModelSnapshot.of("model", "provider", null));
        when(turns.findByExecutionId(800L)).thenReturn(Optional.of(turn));
        Map<String, Object> partial = Map.of(ExecutionEventMetadata.TURN_ID, "900",
                ExecutionEventMetadata.SESSION_ID, "7");

        listener.onToolCall(new ToolCallStartEvent("command", "800", "execute_command", "{}", "101", partial, 0));

        verify(turns).findByExecutionId(800L);
        verify(broadcaster).broadcastBlockUpsert(eq(900L), any(ToolBlockEventFacts.class));
    }

    @Test
    @DisplayName("回退也拿不到归属：跳过推送，不抛异常也不改投")
    void unknownExecutionIsSkipped() {
        when(turns.findByExecutionId(800L)).thenReturn(Optional.empty());

        listener.onToolCall(new ToolCallStartEvent("command", "800", "execute_command", "{}", "101", Map.of(), 0));

        verifyNoInteractions(broadcaster);
    }

    @Test
    @DisplayName("执行 ID 非数值（框架回落 UUID）：静态跳过，不反查也不推送")
    void nonNumericExecutionIdIsSkipped() {
        listener.onToolCall(new ToolCallStartEvent("command", "exec-uuid", "execute_command", "{}", "101",
                Map.of(), 0));

        verifyNoInteractions(broadcaster, turns);
    }

    @Test
    void promisedOutputDoesNotPublishCompetingIntermediateState() {
        listener.onToolCallOutput(new ToolCallEndEvent("command", "800", "101", "execute_command",
                "{}", "等待批准", metadata(), ToolCallStatus.PROMISED, 0));

        verifyNoInteractions(broadcaster, turns);
    }

    /** 归属三键齐备的事件元数据（与生产同源的格式：十进制字符串）。 */
    private static Map<String, Object> metadata() {
        return ExecutionEventMetadata.of(70L, 7L, 900L, null, 1L);
    }
}
