package com.summit.dp.tools.baseTools.sub_agent.delegation;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopMessages;
import com.summit.core.runtime.loop.LoopResult;
import com.summit.dp.workflow.application.input.InputResolver;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation.SubAgentWaitInterceptor;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;

import java.util.ArrayList;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * 本类只验证拦截器自身的契约：先读依赖再查输入、异常不被吞。
 *
 * <p>通道内部的真实查询行为由 {@code InputSourceContractTest}（真实 H2）覆盖，
 * 这里换成 mock 是因为拦截器与通道之间只隔着一层 {@link InputResolver} 的两个方法。</p>
 */
class SubAgentWaitInterceptorTest {
    private final InputResolver inputs = mock(InputResolver.class);
    private final SubAgentWaitInterceptor interceptor = new SubAgentWaitInterceptor(inputs);
    private final Execution execution = Execution.builder().id("100").messages(new ArrayList<>())
            .agentRequest(AgentRequest.builder().runtimeParameters(AgentRuntimeParameters.builder()
                    .attributes(Map.of()).build()).build()).build();
    private final LoopContext context = LoopContext.withCompactionCounter(LoopMessages.builder().execution(execution).build(), new ExecutionControlSignal("100"), () -> 0, null, execution.getMessages()::addAll);

    @Test
    void inputContinuesInTheSameLoopWithoutSuspending() {
        when(inputs.hasPendingItems(execution)).thenReturn(true);
        when(inputs.hasOpenDependency(execution)).thenReturn(true);
        InterceptorResult result = interceptor.onBeforeComplete(context);
        assertFalse(result.next());
        assertEquals(LoopResult.Status.CONTINUE, result.loopResult().status());
    }

    @Test
    void openDependencyOnlyKeepsTheExecutionWaiting() {
        when(inputs.hasOpenDependency(execution)).thenReturn(true);
        assertEquals(LoopResult.Status.SUSPENDED, interceptor.onBeforeComplete(context).loopResult().status());
    }

    @Test
    void noInputAndNoDependencyAllowCompletion() {
        assertTrue(interceptor.onBeforeComplete(context).next());
    }

    @Test
    void dependencyIsReadBeforeInput() {
        interceptor.onBeforeComplete(context);
        InOrder order = inOrder(inputs);
        order.verify(inputs).hasOpenDependency(execution);
        order.verify(inputs).hasPendingItems(execution);
    }

    @Test
    void queryFailureCannotBeMistakenForCompletion() {
        when(inputs.hasPendingItems(execution)).thenThrow(new IllegalStateException("输入读取失败"));
        assertThrows(IllegalStateException.class, () -> interceptor.onBeforeComplete(context));
        assertFalse(interceptor.catchErr());
    }
}
