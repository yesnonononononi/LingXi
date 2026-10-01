package com.summit.dp.turn.infrastructure.listener;

import com.summit.core.conversation.event.ExecutionErrorEvent;
import com.summit.core.runtime.RuntimeListener;
import com.summit.dp.turn.application.service.ChatTurnService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * 失败原因观察者：把**面向用户的失败原因**写到轮次上（{@code chat_turn.error_reason}）。
 *
 * <p><b>为什么不再往 session_message 追加 ERROR 行</b>：失败是**轮次的属性**，
 * 不是一轮对话里的一条消息。此前那条 ERROR 行会伪装成运行时消息混进时间轴 ——
 * 既污染消息列表，也让同一个状态同时存在于两处（消息行 + 执行状态）。
 * 现在失败只由 {@code turn.status = 'FAILED'} 与该字段共同渲染，前端挂在回答组上。</p>
 *
 * <p><b>只写原因、不改状态</b>：状态由框架生命周期信号驱动
 * （{@link ChatTurnLifecycleListener} 在执行终结时按已保存的状态置为 FAILED）。
 * 两个来源各管一件事，不会互相覆盖；即便原因先到、状态后到，最终也是 FAILED + 原因。</p>
 *
 * <p><b>为什么显式 {@link Order}：</b>{@code RuntimeEventPublisher} 按注入顺序逐个回调，
 * 本类必须先于广播者执行，原因才能在失败事件下发之前提交，前端收到终态后立即可对账到它
 * （否则存在「流已结束但原因还没写」的竞态窗口）。</p>
 */
@Slf4j
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
@RequiredArgsConstructor
public class ChatTurnFailureListener implements RuntimeListener {

    private static final String LOG_PREFIX = "【chat-turn】";
    /** 两个文案字段都为空时的兜底：宁可写一句模糊的失败，也不让失败不可见。 */
    private static final String FALLBACK_TEXT = "执行异常";

    private final ChatTurnService chatTurnService;

    @Override
    public void onExecutionError(ExecutionErrorEvent event) {
        if (event == null || event.executionId() == null) {
            return;
        }
        try {
            chatTurnService.recordFailureReason(event.executionId(), errorTextOf(event));
        } catch (RuntimeException e) {
            // 观测链路不得拖垮主执行流：归属不明 / 落库失败只告警，SSE 失败事件照常下发。
            log.warn("{} recordFailureReason failed: executionId={}, error={}",
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
