package com.summit.dp.workflow.application.chat;

import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.shared.support.ObjectProviderStub;
import com.summit.dp.shared.vo.SessionVO;
import com.summit.dp.user_configs.application.policy.AgentPermissionMode;
import com.summit.dp.workflow.application.lifecycle.StartupFailureCloser;
import com.summit.dp.workflow.application.turn.TurnPostEndContext;
import com.summit.dp.workflow.application.turn.TurnPostEndListener;
import com.summit.dp.workflow.application.turn.TurnPostEndProcessor;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import org.junit.jupiter.api.Test;

import java.lang.reflect.Field;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/**
 * 「上一轮结束」事件的发布时机：**必须在释放运行资格、退出会话锁之后**。
 *
 * <p>这条错了不会报错，只会表现成「排队消息永远不发出」—— 下游接力查到
 * {@code isRootRunning} 仍是 true，就把自己静默跳过。所以只能靠断言钉住顺序。</p>
 */
class PreparedChatExecutorTurnPostEndTest {

    private static final long SESSION = 500L;
    private static final String EXECUTION_ID = "2105000000000000001";

    private final SessionExecutionRegistry registry = new SessionExecutionRegistry();
    private final PreparedChatExecutor executor = new PreparedChatExecutor(
            mock(AgentWorkflowOrchestrator.class), mock(RequestPreparer.class),
            mock(ModelContextService.class), registry,
            mock(ExecutionControl.class), mock(StartupFailureCloser.class));

    private static RuntimeContext context() {
        ExecutionContext executionContext = ExecutionContext.root(SESSION, EXECUTION_ID,
                null, 7L, AgentPermissionMode.FULL_ACCESS);
        return new RuntimeContext(executionContext, null, null,
                SessionVO.builder().id(SESSION).build(), List.of(), null, null,
                AgentPermissionMode.FULL_ACCESS, false, null);
    }

    private void installTurnPostEnds(TurnPostEndListener listener) throws ReflectiveOperationException {
        Field field = PreparedChatExecutor.class.getDeclaredField("turnPostEnds");
        field.setAccessible(true);
        field.set(executor, ObjectProviderStub.<TurnPostEndProcessor>of(
                List.of(new TurnPostEndProcessor(ObjectProviderStub.of(List.of(listener))))));
    }

    @Test
    void publishesAfterTheRunSlotIsReleased() throws ReflectiveOperationException {
        AtomicInteger published = new AtomicInteger();
        AtomicBoolean rootRunning = new AtomicBoolean(true);
        installTurnPostEnds(new TurnPostEndListener() {
            @Override
            public int order() {
                return 0;
            }

            @Override
            public void onTurnEnded(TurnPostEndContext context) {
                published.incrementAndGet();
                rootRunning.set(registry.isRootRunning(SESSION));
            }
        });
        registry.beginRoot(SESSION, EXECUTION_ID);

        assertThrows(IllegalStateException.class, () -> executor.run(context()));

        assertEquals(1, published.get(), "一轮结束必须恰好发一次事件");
        assertFalse(rootRunning.get(),
                "事件必须在释放运行资格之后发布：在锁内发布会让接力把自己跳过，排队消息永远发不出去");
    }

    @Test
    void listenerFailureNeverChangesTheRunOutcome() throws ReflectiveOperationException {
        installTurnPostEnds(new TurnPostEndListener() {
            @Override
            public int order() {
                return 0;
            }

            @Override
            public void onTurnEnded(TurnPostEndContext context) {
                throw new IllegalStateException("后置处理崩了");
            }
        });
        registry.beginRoot(SESSION, EXECUTION_ID);

        IllegalStateException failure = assertThrows(IllegalStateException.class, () -> executor.run(context()));

        assertEquals("执行未登记：受理事务必须先创建执行", failure.getMessage(),
                "后置处理失败不能把已经跑完的轮次改写成另一个失败原因");
    }
}
