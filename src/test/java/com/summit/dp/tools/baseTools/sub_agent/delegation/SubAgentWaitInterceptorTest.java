package com.summit.dp.tools.baseTools.sub_agent.delegation;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.runtime.loop.*;
import com.summit.dp.workflow.application.input.InputResolver;
import com.summit.dp.workflow.application.input.InputSource;
import com.summit.dp.workflow.infrastructure.tools.sub_agent.delegation.SubAgentWaitInterceptor;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class SubAgentWaitInterceptorTest {
    @SuppressWarnings("unchecked")
    private final InputSource<String> source = mock(InputSource.class);
    private final SubAgentWaitInterceptor interceptor = new SubAgentWaitInterceptor(
            new InputResolver(List.of(source), new ObjectMapper()));
    private final Execution execution = Execution.builder().id("100").messages(new ArrayList<>())
            .agentRequest(AgentRequest.builder().runtimeParameters(AgentRuntimeParameters.builder().attributes(Map.of()).build()).build()).build();
    private final LoopContext context = LoopContext.withCompactionCounter(LoopMessages.builder().execution(execution).build(),
            new ExecutionControlSignal("100"), () -> 0, execution.getMessages()::addAll);

    @Test void inputContinuesInTheSameLoopWithoutSuspending() {
        when(source.pendingItems(execution)).thenReturn(List.of("new input"));
        when(source.hasOpenDependency(execution)).thenReturn(true);
        InterceptorResult result = interceptor.onBeforeComplete(context);
        assertFalse(result.next());
        assertEquals(LoopResult.Status.CONTINUE, result.loopResult().status());
    }
    @Test void openDependencyOnlyKeepsTheExecutionWaiting() {
        when(source.hasOpenDependency(execution)).thenReturn(true);
        assertEquals(LoopResult.Status.SUSPENDED, interceptor.onBeforeComplete(context).loopResult().status());
    }
    @Test void noInputAndNoDependencyAllowCompletion() {
        assertTrue(interceptor.onBeforeComplete(context).next());
    }
    @Test void dependencyIsReadBeforeInput() {
        interceptor.onBeforeComplete(context);
        InOrder order = inOrder(source);
        order.verify(source).hasOpenDependency(execution);
        order.verify(source).pendingItems(execution);
    }
    @Test void queryFailureCannotBeMistakenForCompletion() {
        when(source.pendingItems(execution)).thenThrow(new IllegalStateException("输入读取失败"));
        assertThrows(IllegalStateException.class, () -> interceptor.onBeforeComplete(context));
        assertFalse(interceptor.catchErr());
    }
}
