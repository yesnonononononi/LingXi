package com.summit.dp.workflow.application.chat;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.session.application.service.ModelContextService;
import com.summit.dp.user_configs.application.policy.AgentAccessMode;
import com.summit.dp.user_configs.application.policy.CommandApprovalPolicy;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

/** 依赖加载错误不能只结束工作线程而让持久化状态永久停在运行中。 */
class PreparedChatExecutorLinkageTest {
    private final AgentWorkflowOrchestrator orchestrator = mock(AgentWorkflowOrchestrator.class);
    private final RequestPreparer preparer = mock(RequestPreparer.class);
    private final ModelContextService modelContext = mock(ModelContextService.class);
    private final SessionExecutionRegistry registry = spy(new SessionExecutionRegistry());
    private final ExecutionControl control = mock(ExecutionControl.class);
    private final PreparedChatExecutor executor = new PreparedChatExecutor(orchestrator, preparer, modelContext, registry, control);
    private final AtomicBoolean failurePublished = new AtomicBoolean();
    private final NoSuchMethodError linkage = new NoSuchMethodError("ContextSqueezeRequest.builder()");
    private Execution execution;
    private RuntimeContext context;

    @BeforeEach
    void setup() {
        execution = Execution.create(AgentRequest.builder().executionId("12")
                .messages(List.of(UserMessageEntity.from("诊断")))
                .runtimeParameters(AgentRuntimeParameters.builder()
                        .attributes(Map.of(ExecutionAttributes.SESSION_ID, "10")).build()).build(), "chatAgent");
        execution.start();
        context = mock(RuntimeContext.class);
        when(context.execution()).thenReturn(execution);
        when(context.executionContext()).thenReturn(ExecutionContext.root(10L, "12", null, null,
                AgentAccessMode.IN_WORKSPACE, CommandApprovalPolicy.DANGEROUS_BLOCK));
        when(orchestrator.execute(context, execution)).thenThrow(linkage);
        when(control.fail(eq(execution), any(Exception.class))).thenAnswer(invocation -> {
            Exception failure = invocation.getArgument(1);
            execution.failChecked(failure.getMessage());
            return (Runnable) () -> failurePublished.set(true);
        });
        registry.beginRoot(10L);
    }

    @AfterEach
    void close() {
        executor.close();
    }

    @Test
    void synchronousLinkageFailureBecomesAnActionableFailedExecution() {
        IllegalStateException failure = assertThrows(IllegalStateException.class, () -> executor.run(context));
        assertSame(linkage, failure.getCause());
        assertTrue(failure.getMessage().contains("依赖版本不兼容"));
        assertEquals(ExecutionState.FAILED, execution.getExecutionState());
        assertTrue(failurePublished.get());
        verify(control).fail(execution, failure);
        verifyNoInteractions(modelContext);
        assertDoesNotThrow(() -> registry.beginRoot(10L));
    }

    @Test
    void asynchronousLinkageFailurePublishesFailureAndReleasesRoot() throws Exception {
        CountDownLatch finished = new CountDownLatch(1);
        doAnswer(invocation -> {
            invocation.callRealMethod();
            finished.countDown();
            return null;
        }).when(registry).finishRoot(10L);

        executor.submitAsync(context);

        assertTrue(finished.await(5, TimeUnit.SECONDS), "异步执行必须收尾");
        assertEquals(ExecutionState.FAILED, execution.getExecutionState());
        assertTrue(failurePublished.get(), "受理后失败必须通知界面");
        verify(control).fail(eq(execution), argThat(failure -> failure.getCause() == linkage));
        verifyNoInteractions(modelContext);
        assertDoesNotThrow(() -> registry.beginRoot(10L));
    }
}
