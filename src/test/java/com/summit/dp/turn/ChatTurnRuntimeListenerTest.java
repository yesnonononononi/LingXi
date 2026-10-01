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

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.nullable;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;

/**
 * 三个终态事件的用量是轮次用量（{@code chat_turn.*_token_count}）的唯一来源。
 *
 * <p>模型与 token 是业务事实，权威在轮次表 —— 执行表已不再冗余保存，所以用量只能在这里入账。
 * 完成 / 失败 / 取消三个终态事件同形，都带 {@code tokenInfo}（失败与取消带的是**结束前已累计**
 * 的部分用量）；该字段为 null 表示「未采集到」，保持 null、不补 0。</p>
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

        verify(chatTurnService).refreshUsage("3001", 120L, 30L, 150L);
    }

    @Test
    @DisplayName("失败与取消同样入账：带的是结束前已累计的部分用量")
    void writesUsageFromFailureAndCancelEvents() {
        listener.onExecutionError(new ExecutionErrorEvent("boom", null, "3002", usage(80, 20, 100), null));
        verify(chatTurnService).refreshUsage("3002", 80L, 20L, 100L);

        listener.onExecutionCancelled(new ExecutionCancelledEvent("3003", usage(50, 10, 60), null));
        verify(chatTurnService).refreshUsage("3003", 50L, 10L, 60L);
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

        verifyNoInteractions(chatTurnService);
    }

    @Test
    @DisplayName("部分缺失的用量由服务层逐列判空：null 不覆盖已知值")
    void partialUsageIsPassedThroughAsNull() {
        listener.onExecutionCompleted(new ExecutionCompleteEvent("3007",
                TokenInfo.builder().totalTokenCount(150).build()));

        verify(chatTurnService).refreshUsage("3007", null, null, 150L);
    }

    @Test
    @DisplayName("入账失败只吞掉，不向外抛（观测链路不得拖垮主执行流）")
    void swallowsPersistenceFailures() {
        doThrow(new IllegalStateException("db down")).when(chatTurnService)
                .refreshUsage(anyString(), nullable(Long.class), nullable(Long.class), nullable(Long.class));

        assertDoesNotThrow(() -> listener.onExecutionCompleted(
                new ExecutionCompleteEvent("3008", usage(1, 1, 2))));
        assertDoesNotThrow(() -> listener.onExecutionError(
                new ExecutionErrorEvent("boom", null, "3009", usage(1, 1, 2), null)));
        assertDoesNotThrow(() -> listener.onExecutionCancelled(
                new ExecutionCancelledEvent("3010", usage(1, 1, 2), null)));
    }

    private static TokenInfo usage(int input, int output, int total) {
        return TokenInfo.builder()
                .inputTokenCount(input).outputTokenCount(output).totalTokenCount(total).build();
    }
}
