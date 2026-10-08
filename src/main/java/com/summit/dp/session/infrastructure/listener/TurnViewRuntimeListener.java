package com.summit.dp.session.infrastructure.listener;

import com.summit.core.conversation.event.AgentEvent;
import com.summit.core.conversation.event.ExecutionCancelledEvent;
import com.summit.core.conversation.event.ExecutionCompleteEvent;
import com.summit.core.conversation.event.ExecutionErrorEvent;
import com.summit.core.conversation.event.ExecutionResumedEvent;
import com.summit.core.conversation.event.ExecutionStartEvent;
import com.summit.core.conversation.event.ExecutionSuspendedEvent;
import com.summit.core.runtime.RuntimeListener;
import com.summit.dp.session.application.service.TurnViewBroadcaster;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

/**
 * 轮次**状态边界**上的块快照推送：开始 / 挂起 / 恢复 / 终态各推一帧整轮快照。
 *
 * <p><b>为什么这些时点必须推整轮而不是增量</b>：状态边界往往伴随块的**结构性变化**
 * （新一轮模型调用产生新的思考/正文/工具块），增量列表表达不了「多了几块」。
 * 整轮快照由前端按 {@code viewVersion} 整体替换，天然幂等 —— 重复或乱序到达都无害。</p>
 *
 * <p><b>为什么 order 低于 {@code ChatTurnRuntimeListener}</b>：快照读的是
 * {@code chat_turn} 的<b>已落库状态</b>。轮次监听器负责把状态先写进去（它取
 * {@code HIGHEST_PRECEDENCE}），本类必须在它之后跑 —— 否则快照读到的是变更前的状态，
 * 前端会看到「终态事件带的是 RUNNING」。{@link Ordered#LOWEST_PRECEDENCE} 保证本类最后执行。</p>
 *
 * <p><b>为什么 catchErr 的语义在这里是「吞掉」</b>：推送是旁路观测，失败不改业务语义 ——
 * 世界仍然一致（会话状态另有历史接口兜底）。因此每个钩子各自隔离异常，绝不上抛。</p>
 */
@Slf4j
@Component
@Order(Ordered.LOWEST_PRECEDENCE)
@RequiredArgsConstructor
public class TurnViewRuntimeListener implements RuntimeListener {

    private final TurnViewBroadcaster turnViewBroadcaster;

    @Override
    public void onExecutionStart(ExecutionStartEvent event) {
        snapshot(event);
    }

    @Override
    public void onExecutionSuspended(ExecutionSuspendedEvent event) {
        snapshot(event);
    }

    @Override
    public void onExecutionResumed(ExecutionResumedEvent event) {
        snapshot(event);
    }

    @Override
    public void onExecutionCompleted(ExecutionCompleteEvent event) {
        snapshot(event);
    }

    @Override
    public void onExecutionError(ExecutionErrorEvent event) {
        snapshot(event);
    }

    @Override
    public void onExecutionCancelled(ExecutionCancelledEvent event) {
        snapshot(event);
    }

    /** 取执行 ID 推整轮快照；失败只告警，绝不外抛（同步广播链路上一位监听器抛错会跳过后续）。 */
    private void snapshot(AgentEvent event) {
        if (event == null || event.executionId() == null || event.executionId().isBlank()) {
            return;
        }
        try {
            turnViewBroadcaster.broadcastSnapshotForExecution(event.executionId());
        } catch (RuntimeException e) {
            log.warn("推送轮次快照失败（不影响执行本身）: executionId={}, error={}", event.executionId(), e.toString());
        }
    }
}
