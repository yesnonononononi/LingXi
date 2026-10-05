package com.summit.dp.turn;

import com.summit.core.conversation.event.ExecutionCancelledEvent;
import com.summit.core.conversation.event.ExecutionCompleteEvent;
import com.summit.core.conversation.event.ExecutionErrorEvent;
import com.summit.core.conversation.event.TokenInfo;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.infrastructure.listener.ChatTurnRuntimeListener;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.nullable;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

/**
 * 运行时事件观察者：开始时间、失败原因与三个终态事件的用量。
 *
 * <p>模型与 token 是业务事实，权威在轮次表 —— 执行表已不再冗余保存，所以用量只能在这里入账。
 * 完成 / 失败 / 取消三个终态事件同形，都带 {@code tokenInfo}（失败与取消带的是**结束前已累计**
 * 的部分用量）；该字段为 null 表示「未采集到」，保持 null、不补 0。</p>
 *
 * <p>失败原因并入本类后，{@code EXECUTION_FAILED} 要按「记录原因 → 刷新用量」两步走，
 * 两步各自隔离异常：任一步失败都不得连累另一步，也不得外抛。</p>
 */
class ChatTurnRuntimeListenerTest {

    private ChatTurnService chatTurnService;
    private ChatTurnRuntimeListener listener;

    @BeforeEach
    void setup() {
        chatTurnService = mock(ChatTurnService.class);
        listener = new ChatTurnRuntimeListener(chatTurnService);
    }

    @Test
    @DisplayName("完成事件的用量覆盖写入轮次：Integer → Long，三列原样透传")
    void writesUsageFromCompletionEvent() {
        listener.onExecutionCompleted(new ExecutionCompleteEvent("3001", usage(120, 30, 150)));

        verify(chatTurnService).refreshUsage("3001", 120L, 30L, 150L, null);
    }

    @Test
    @DisplayName("失败事件：先记原因再入账用量，两件事都做")
    void failureRecordsReasonThenUsage() {
        listener.onExecutionError(new ExecutionErrorEvent("boom", null, "3002", usage(80, 20, 100), null));

        verify(chatTurnService).recordFailureReason("3002", "boom", null);
        verify(chatTurnService).refreshUsage("3002", 80L, 20L, 100L, null);
    }

    @Test
    @DisplayName("取消事件同样入账：带的是结束前已累计的部分用量")
    void writesUsageFromCancelEvent() {
        listener.onExecutionCancelled(new ExecutionCancelledEvent("3003", usage(50, 10, 60), null));

        verify(chatTurnService).refreshUsage("3003", 50L, 10L, 60L, null);
    }

    @Test
    @DisplayName("用量缺失的事件（框架未采集到）不写轮次，绝不补 0")
    void skipsEventsWithoutUsage() {
        // tokenInfo 为 null 是框架在 tokenUsage 缺失时的真实形态：三个终态事件一视同仁。
        listener.onExecutionCompleted(new ExecutionCompleteEvent("3004", null));
        listener.onExecutionError(new ExecutionErrorEvent("boom", null, "3005", null, null));
        listener.onExecutionCancelled(new ExecutionCancelledEvent("3006", null, null));
        // 事件本身缺失同样跳过。
        listener.onExecutionCompleted(null);
        listener.onExecutionError(null);
        listener.onExecutionCancelled(null);
        // 没有执行标识（框架兜底 UUID 路径）也跳过。
        listener.onExecutionCompleted(new ExecutionCompleteEvent(null, usage(1, 2, 3)));

        verify(chatTurnService, never()).refreshUsage(anyString(), any(), any(), any(), any());
    }

    @Test
    @DisplayName("部分缺失的用量由服务层逐列判空：null 不覆盖已知值")
    void partialUsageIsPassedThroughAsNull() {
        listener.onExecutionCompleted(new ExecutionCompleteEvent("3007",
                TokenInfo.builder().totalTokenCount(150).build()));

        verify(chatTurnService).refreshUsage("3007", null, null, 150L, null);
    }

    @Test
    @DisplayName("入账失败只吞掉，不向外抛（观测链路不得拖垮主执行流）")
    void swallowsUsageFailures() {
        doThrow(new IllegalStateException("db down")).when(chatTurnService)
                .refreshUsage(anyString(), nullable(Long.class), nullable(Long.class), nullable(Long.class), nullable(Long.class));

        assertDoesNotThrow(() -> listener.onExecutionCompleted(
                new ExecutionCompleteEvent("3008", usage(1, 1, 2))));
        assertDoesNotThrow(() -> listener.onExecutionError(
                new ExecutionErrorEvent("boom", null, "3009", usage(1, 1, 2), null)));
        assertDoesNotThrow(() -> listener.onExecutionCancelled(
                new ExecutionCancelledEvent("3010", usage(1, 1, 2), null)));
    }

    @Test
    @DisplayName("失败原因写到轮次上：主文案取 errMsg，归属由服务按 executionId 解析")
    void recordsErrMsgAsFailureReason() {
        listener.onExecutionError(new ExecutionErrorEvent("模型服务不可用", "命令审批执行失败", "1001"));

        verify(chatTurnService).recordFailureReason("1001", "模型服务不可用", null);
    }

    @Test
    @DisplayName("文案兜底：errMsg 缺失取 extraDes，两者皆空取常量，绝不写空原因")
    void fallsBackToExtraDesThenConstant() {
        listener.onExecutionError(new ExecutionErrorEvent(null, "命令审批执行失败", "1002"));
        verify(chatTurnService).recordFailureReason("1002", "命令审批执行失败", null);

        // NPE 的 getMessage() 为 null 是真实形态：两个字段都空仍要留下可见的失败痕迹。
        listener.onExecutionError(new ExecutionErrorEvent(null, null, "1003"));
        verify(chatTurnService).recordFailureReason("1003", "执行异常", null);
    }

    @Test
    @DisplayName("无执行标识的事件不写轮次")
    void ignoresEventWithoutExecutionId() {
        assertDoesNotThrow(() -> listener.onExecutionError(new ExecutionErrorEvent("boom", null, null)));

        verify(chatTurnService, never()).recordFailureReason(anyString(), anyString(), any());
    }

    @Test
    @DisplayName("原因写入失败仍尝试入账用量，且不向外抛（两步各自隔离异常）")
    void reasonFailureStillRefreshesUsage() {
        doThrow(new IllegalStateException("db down")).when(chatTurnService)
                .recordFailureReason(anyString(), anyString(), any());

        assertDoesNotThrow(() -> listener.onExecutionError(
                new ExecutionErrorEvent("boom", null, "3011", usage(1, 1, 2), null)));
        verify(chatTurnService).refreshUsage("3011", 1L, 1L, 2L, null);
    }

    @Test
    @DisplayName("非失败事件不写原因")
    void nonErrorEventsDoNotRecordReason() {
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

        verify(chatTurnService, never()).recordFailureReason(anyString(), anyString(), any());
    }

    @Test
    @DisplayName("显式 @Order(HIGHEST_PRECEDENCE)：失败原因写入早于 SSE 广播")
    void failureReasonRunsBeforeBroadcast() {
        Order order = ChatTurnRuntimeListener.class.getAnnotation(Order.class);

        assertNotNull(order, "必须显式声明顺序，否则原因写入与广播的先后不可保证");
        assertEquals(Ordered.HIGHEST_PRECEDENCE, order.value());
    }

    private static TokenInfo usage(int input, int output, int total) {
        return TokenInfo.builder()
                .inputTokenCount(input).outputTokenCount(output).totalTokenCount(total).build();
    }
}
