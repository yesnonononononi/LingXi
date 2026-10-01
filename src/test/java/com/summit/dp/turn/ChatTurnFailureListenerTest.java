package com.summit.dp.turn;

import com.summit.core.conversation.event.ExecutionErrorEvent;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.infrastructure.listener.ChatTurnFailureListener;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

/**
 * 失败原因观察者：把面向用户的失败原因写到**轮次**上（{@code chat_turn.error_reason}），
 * 不再往消息列表追加 ERROR 行。
 *
 * <p>失败是轮次的属性，不是一轮对话里的一条消息 —— 这里验证「原因落到轮次、不改状态、
 * 观测链路不得拖垮主执行流」。</p>
 */
class ChatTurnFailureListenerTest {

    private ChatTurnService chatTurnService;
    private ChatTurnFailureListener listener;

    @BeforeEach
    void setup() {
        chatTurnService = mock(ChatTurnService.class);
        listener = new ChatTurnFailureListener(chatTurnService);
    }

    @Test
    @DisplayName("失败原因写到轮次上：主文案取 errMsg，归属由服务按 executionId 解析")
    void recordsErrMsgAsFailureReason() {
        listener.onExecutionError(new ExecutionErrorEvent("模型服务不可用", "命令审批执行失败", "1001"));

        verify(chatTurnService).recordFailureReason("1001", "模型服务不可用");
    }

    @Test
    @DisplayName("文案兜底：errMsg 缺失取 extraDes，两者皆空取常量，绝不写空原因")
    void fallsBackToExtraDesThenConstant() {
        listener.onExecutionError(new ExecutionErrorEvent(null, "命令审批执行失败", "1002"));
        verify(chatTurnService).recordFailureReason("1002", "命令审批执行失败");

        // NPE 的 getMessage() 为 null 是真实形态：两个字段都空仍要留下可见的失败痕迹。
        listener.onExecutionError(new ExecutionErrorEvent(null, null, "1003"));
        verify(chatTurnService).recordFailureReason("1003", "执行异常");
    }

    @Test
    @DisplayName("无执行标识的事件不写轮次")
    void ignoresEventWithoutExecutionId() {
        assertDoesNotThrow(() -> listener.onExecutionError(new ExecutionErrorEvent("boom", null, null)));
        verifyNoInteractions(chatTurnService);
    }

    @Test
    @DisplayName("写轮次失败只吞掉，不向外抛（观测链路不得拖垮主执行流）")
    void swallowsPersistenceFailures() {
        org.mockito.Mockito.doThrow(new IllegalStateException("db down"))
                .when(chatTurnService).recordFailureReason("2001", "boom");

        assertDoesNotThrow(() ->
                listener.onExecutionError(new ExecutionErrorEvent("boom", null, "2001")));
    }

    @Test
    @DisplayName("非失败事件不写原因")
    void nonErrorEventsAreIgnored() {
        listener.onExecutionStart(null);
        listener.onExecutionResumed(null);
        listener.onExecutionSuspended(null);
        listener.onExecutionCompleted(null);
        listener.onExecutionCancelled(null);
        listener.onAiMessage(null);
        listener.onContextUpdate(null);
        listener.onApplicationEvent(null);
        listener.onPartialText(null);
        listener.onPartialThinking(null);
        listener.onCompleteText(null);
        listener.onToolCall(null);
        listener.onToolCallOutput(null);

        verify(chatTurnService, never()).recordFailureReason(org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.anyString());
    }
}
