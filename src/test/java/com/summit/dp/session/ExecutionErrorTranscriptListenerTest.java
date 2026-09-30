package com.summit.dp.session;

import com.summit.core.conversation.event.ExecutionErrorEvent;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import com.summit.dp.session.infrastructure.transcript.ExecutionErrorTranscriptListener;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 执行失败落库回归：{@code onExecutionError} → 追加一条 ERROR 消息到**失败执行所属会话**。
 *
 * <p>这层不变式是「错误不再一闪即逝」的根因修复：失败文案必须有落库来源，前端才能在流结束的
 * 消息级对账与刷新会话后把它读回来。</p>
 */
class ExecutionErrorTranscriptListenerTest {

    private ConversationTranscriptService transcriptService;
    private ExecutionIdentity executionIdentity;
    private ExecutionErrorTranscriptListener listener;

    @BeforeEach
    void setup() {
        transcriptService = mock(ConversationTranscriptService.class);
        executionIdentity = mock(ExecutionIdentity.class);
        listener = new ExecutionErrorTranscriptListener(transcriptService, executionIdentity);
    }

    @Test
    @DisplayName("失败文案写入执行所属会话（子 Agent 执行落其子会话，不串到根会话）")
    void persistsErrMsgIntoOwningSession() {
        when(executionIdentity.sessionId("1001")).thenReturn(77L);

        listener.onExecutionError(new ExecutionErrorEvent("模型服务不可用", "命令审批执行失败", "1001"));

        verify(transcriptService).appendError(77L, 1001L, "模型服务不可用");
    }

    @Test
    @DisplayName("文案兜底：errMsg 缺失取 extraDes，两者皆空取常量，绝不落空行")
    void fallsBackToExtraDesThenConstant() {
        when(executionIdentity.sessionId("1002")).thenReturn(78L);
        listener.onExecutionError(new ExecutionErrorEvent(null, "命令审批执行失败", "1002"));
        verify(transcriptService).appendError(78L, 1002L, "命令审批执行失败");

        when(executionIdentity.sessionId("1003")).thenReturn(79L);
        // NPE 的 getMessage() 为 null 是真实形态：两个字段都空仍要留下可见的失败痕迹。
        listener.onExecutionError(new ExecutionErrorEvent(null, null, "1003"));
        verify(transcriptService).appendError(79L, 1003L, "执行异常");
    }

    @Test
    @DisplayName("观测链路不拖垮主流程：归属解析失败 / 落库失败只吞掉，不向外抛")
    void swallowsResolutionAndPersistenceFailures() {
        when(executionIdentity.sessionId("2001")).thenThrow(new IllegalStateException("Unknown execution"));
        assertDoesNotThrow(() ->
                listener.onExecutionError(new ExecutionErrorEvent("boom", null, "2001")));
        verifyNoInteractions(transcriptService);

        when(executionIdentity.sessionId("2002")).thenReturn(80L);
        doThrow(new IllegalStateException("db down")).when(transcriptService).appendError(80L, 2002L, "boom");
        assertDoesNotThrow(() ->
                listener.onExecutionError(new ExecutionErrorEvent("boom", null, "2002")));
    }

    @Test
    @DisplayName("无执行标识的事件不查库、不落行")
    void ignoresEventWithoutExecutionId() {
        assertDoesNotThrow(() -> listener.onExecutionError(new ExecutionErrorEvent("boom", null, null)));
        verify(executionIdentity, never()).sessionId(anyString());
        verifyNoInteractions(transcriptService);
    }
}
