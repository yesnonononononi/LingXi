package com.summit.dp.workflow.application.turn;

import com.summit.core.agent.ExecutionState;
import com.summit.dp.shared.support.ObjectProviderStub;
import com.summit.dp.workflow.application.pending.PendingTaskDispatcher;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/**
 * 轮次结束扩展点：按 order 串行、单个失败不牵连后面的监听器，以及「失败 / 被停止不接力」。
 */
class TurnPostEndProcessorTest {

    private static final long SESSION = 500L;

    private static TurnPostEndContext completedContext() {
        return new TurnPostEndContext(SESSION, SESSION, "2105000000000000001", ExecutionState.COMPLETED, null);
    }

    private static TurnPostEndListener recording(int order, List<Integer> seen, int value) {
        return new TurnPostEndListener() {
            @Override
            public int order() {
                return order;
            }

            @Override
            public void onTurnEnded(TurnPostEndContext context) {
                seen.add(value);
            }
        };
    }

    @Test
    void callsListenersInAscendingOrder() {
        List<Integer> seen = new ArrayList<>();
        // 注册顺序与 order 顺序故意相反：并列时只取决于注入顺序，那不可依赖。
        TurnPostEndProcessor processor = new TurnPostEndProcessor(ObjectProviderStub.of(List.of(
                recording(900, seen, 3), recording(-900, seen, 1), recording(0, seen, 2))));

        processor.publish(completedContext());

        assertEquals(List.of(1, 2, 3), seen);
    }

    @Test
    void oneFailingListenerDoesNotStopTheRest() {
        List<Integer> seen = new ArrayList<>();
        TurnPostEndListener exploding = new TurnPostEndListener() {
            @Override
            public int order() {
                return -1000;
            }

            @Override
            public void onTurnEnded(TurnPostEndContext context) {
                throw new IllegalStateException("这个模块崩了");
            }
        };
        TurnPostEndProcessor processor = new TurnPostEndProcessor(ObjectProviderStub.of(List.of(
                exploding, recording(0, seen, 2))));

        assertDoesNotThrow(() -> processor.publish(completedContext()));
        assertEquals(List.of(2), seen, "后置处理跑在已经完成的轮次之后，不该因为其中一个崩了就全停");
    }

    @Test
    void pendingRelayOnlyFiresOnCompletedTurns() {
        PendingTaskDispatcher dispatcher = mock(PendingTaskDispatcher.class);
        PendingTurnPostEndListener listener = new PendingTurnPostEndListener(ObjectProviderStub.of(List.of(dispatcher)));

        listener.onTurnEnded(new TurnPostEndContext(SESSION, SESSION, "e1", ExecutionState.FAILED, "模型调用失败"));
        listener.onTurnEnded(new TurnPostEndContext(SESSION, SESSION, "e1", ExecutionState.COMPLETED, "收尾出错"));
        verifyNoInteractions(dispatcher);

        listener.onTurnEnded(completedContext());
        verify(dispatcher).relay(SESSION);
    }
}
