package com.summit.dp.session;

import com.summit.core.compact.ContextUsageMetric;
import com.summit.core.conversation.event.ContextUpdateEvent;
import com.summit.core.conversation.event.ExecutionStartEvent;
import com.summit.core.conversation.event.ExecutionSuspendedEvent;
import com.summit.dp.session.application.service.TurnViewBroadcaster;
import com.summit.dp.session.infrastructure.listener.TurnViewRuntimeListener;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

/**
 * 快照监听器的**触发点覆盖**：状态边界与用量变化都必须推。
 *
 * <p><b>为什么单测这一条</b>：用量变化不改变执行状态，压缩期间不会触发任何状态边界事件。
 * 若 {@code onContextUpdate} 没接，前端要等到本轮终态才看到用量回落 —— 这是「功能静默缺失」，
 * 删掉一个 override 方法不会有任何编译错误。用本用例把它钉住。</p>
 */
class TurnViewRuntimeListenerTest {

    private static final String EXECUTION_ID = "9001";

    private final TurnViewBroadcaster broadcaster = mock(TurnViewBroadcaster.class);
    private final TurnViewRuntimeListener listener = new TurnViewRuntimeListener(broadcaster);

    @Test
    @DisplayName("上下文用量变化也要推快照（压缩不触发状态边界，别让它成为盲区）")
    void contextUpdateAlsoTriggersSnapshot() {
        listener.onContextUpdate(new ContextUpdateEvent(EXECUTION_ID, ContextUpdateEvent.Phase.UPDATE,
                new ContextUsageMetric(1000, 8000, 0.125), "用量更新"));

        verify(broadcaster).broadcastSnapshotForExecution(EXECUTION_ID);
    }

    @Test
    @DisplayName("状态边界照常推快照（对照组：用量之外的锚点不能丢）")
    void statusBoundariesStillTriggerSnapshot() {
        listener.onExecutionStart(new ExecutionStartEvent(EXECUTION_ID));
        verify(broadcaster).broadcastSnapshotForExecution(EXECUTION_ID);

        listener.onExecutionSuspended(new ExecutionSuspendedEvent(EXECUTION_ID));
        verify(broadcaster, org.mockito.Mockito.times(2)).broadcastSnapshotForExecution(EXECUTION_ID);
    }

    @Test
    @DisplayName("执行 ID 缺失时静默跳过，绝不抛异常（同步广播链上抛错会跳过后续监听器）")
    void blankExecutionIdIsSkipped() {
        listener.onContextUpdate(new ContextUpdateEvent("", ContextUpdateEvent.Phase.UPDATE, null, null));

        verify(broadcaster, never()).broadcastSnapshotForExecution(anyString());
    }
}
