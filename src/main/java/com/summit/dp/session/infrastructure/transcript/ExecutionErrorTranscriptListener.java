package com.summit.dp.session.infrastructure.transcript;

import com.summit.core.conversation.event.ExecutionErrorEvent;
import com.summit.core.runtime.RuntimeListener;
import com.summit.dp.execution.ExecutionIdentity;
import com.summit.dp.session.application.service.ConversationTranscriptService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * 框架 {@code RuntimeListener} 的可观测挂载点：执行抛异常（{@code onExecutionError}）时，
 * 把失败文案追加成一条 {@code session_message} 的 ERROR 行。
 *
 * <p><b>为什么必须落库：</b>失败文案此前只存在于 {@link ExecutionErrorEvent}（SSE 单次推送）与
 * 前端内存里，流一结束前端就与后端做消息级对账并用落库行重建列表，内存态错误随之被抹掉——
 * 表现为错误提示一闪即逝、刷新会话后彻底无痕。落一行 ERROR 后，错误与正文一样有权威来源。</p>
 *
 * <p><b>为什么单独成监听器而不并入 {@code AgentEventListener}：</b>后者职责是「序列化为 JSON
 * 广播给 SSE」，不该做持久化；本类只订阅失败事件，与 toolcall 侧的
 * {@code ToolCallExecutionListener} 同属「运行时事件 → 业务落库」这一层。</p>
 *
 * <p><b>为什么显式 {@link Order}：</b>{@code RuntimeEventPublisher} 按注入顺序逐个回调，
 * 本类必须先于广播者执行，ERROR 行才能在失败事件下发之前提交，前端收到终态后立即可对账到它
 * （否则存在「流已结束但行还没写」的竞态窗口）。</p>
 */
@Slf4j
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
@RequiredArgsConstructor
public class ExecutionErrorTranscriptListener implements RuntimeListener {

    private static final String LOG_PREFIX = "【error-transcript】";
    /** 失败事件两个文案字段都为空时的兜底：宁可写一句模糊的失败，也不让失败不可见。 */
    private static final String FALLBACK_TEXT = "执行异常";

    private final ConversationTranscriptService transcriptService;
    private final ExecutionIdentity executionIdentity;

    @Override
    public void onExecutionError(ExecutionErrorEvent event) {
        if (event == null || event.executionId() == null) {
            return;
        }
        try {
            long sessionId = executionIdentity.sessionId(event.executionId());
            transcriptService.appendError(sessionId, ExecutionIdentity.numericOrNull(event.executionId()),
                    errorTextOf(event));
        } catch (RuntimeException e) {
            // 观测链路不得拖垮主执行流：执行归属不明 / 落库失败只告警，SSE 失败事件照常下发。
            log.warn("{} appendError failed: executionId={}, error={}",
                    LOG_PREFIX, event.executionId(), e.toString());
        }
    }

    /** 主文案取 {@code errMsg}（与前端契约一致），缺失时退 {@code extraDes}，仍为空用兜底常量。 */
    private static String errorTextOf(ExecutionErrorEvent event) {
        String primary = event.getErrMsg() == null ? "" : event.getErrMsg().trim();
        if (!primary.isEmpty()) {
            return primary;
        }
        String supplementary = event.getExtraDes() == null ? "" : event.getExtraDes().trim();
        return supplementary.isEmpty() ? FALLBACK_TEXT : supplementary;
    }
}
