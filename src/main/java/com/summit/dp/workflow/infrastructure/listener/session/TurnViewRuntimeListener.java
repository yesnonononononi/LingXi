package com.summit.dp.workflow.infrastructure.listener.session;

import com.summit.core.conversation.event.*;
import com.summit.core.runtime.RuntimeListener;
import com.summit.dp.workflow.application.projection.TurnViewBroadcaster;
import lombok.RequiredArgsConstructor;
import org.springframework.core.Ordered;
import org.springframework.stereotype.Component;

/**
 * 轮次**状态边界**与**用量变化**上的块快照推送：开始 / 挂起 / 恢复 / 终态 / 上下文用量变化各推一帧整轮快照。
 *
 * <p><b>为什么这些时点必须推整轮而不是增量</b>：状态边界往往伴随块的**结构性变化**
 * （新一轮模型调用产生新的思考/正文/工具块），增量列表表达不了「多了几块」。
 * 整轮快照由前端按 {@code viewVersion} 整体替换，天然幂等 —— 重复或乱序到达都无害。</p>
 *
 * <p><b>为什么用量变化也要推</b>：上下文压缩发生在轮次内部，不触发任何执行状态边界，
 * 但前端需要立即看到用量回落（见 {@link #onContextUpdate}）。</p>
 *
 * <p><b>为什么 order 低于 {@code ChatTurnRuntimeListener}</b>：快照读的是
 * {@code chat_turn} 的<b>已落库状态</b>。轮次监听器负责把状态先写进去（它取
 * {@code HIGHEST_PRECEDENCE}），本类必须在它之后跑 —— 否则快照读到的是变更前的状态，
 * 前端会看到「终态事件带的是 RUNNING」。{@link Ordered#LOWEST_PRECEDENCE} 保证本类最后执行。</p>
 *
 * <p><b>异常隔离由框架负责</b>：{@code RuntimeEventPublisher} 按默认 {@code Behavior.CONTAIN}
 * 逐监听器隔离异常，旁路推送失败不会中断其他监听器或主执行流。</p>
 */
@Component
@RequiredArgsConstructor
public class TurnViewRuntimeListener implements RuntimeListener {

    private final TurnViewBroadcaster turnViewBroadcaster;

    @Override
    public int order() {
        return Ordered.LOWEST_PRECEDENCE;
    }

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

    /**
     * 上下文用量变化也推整轮快照。
     *
     * <p><b>为什么单独挂这一钩子</b>：用量（{@code ContextUsageMetric}）变化<b>不改变执行状态</b> ——
     * 压缩在轮次内部发生，期间不会触发 start/suspend/resume/completed 任一状态边界。
     * 若只挂状态边界，前端在上下文被压缩时看不到用量从「将满」回落到「宽松」，
     * 直到本轮终态才一次性对齐。这里补上，保持「前端看到的用量始终是权威值」。</p>
     *
     * <p>快照读的是已落库的 {@code chat_turn} + {@code session}；用量由
     * {@code TurnViewAssembler#resolveMetric} 从会话快照取。压缩阶段事件本身的 {@code usage}
     * 不入快照 —— 真源仍是会话上的持久化用量，避免「事件里的瞬时值」与「落库值」两套口径。</p>
     */
    @Override
    public void onContextUpdate(ContextUpdateEvent event) {
        snapshot(event);
    }

    /** 取执行 ID 推整轮快照；异常由 {@code RuntimeEventPublisher} 按 {@code Behavior.CONTAIN} 统一隔离。 */
    private void snapshot(AgentEvent event) {
        if (event == null || event.executionId() == null || event.executionId().isBlank()) {
            return;
        }
        turnViewBroadcaster.broadcastSnapshotForExecution(event.executionId());
    }
}
