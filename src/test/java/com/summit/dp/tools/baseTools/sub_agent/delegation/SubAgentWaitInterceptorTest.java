package com.summit.dp.tools.baseTools.sub_agent.delegation;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.conversation.message.Message;
import com.summit.core.runtime.loop.ExecutionControlSignal;
import com.summit.core.runtime.loop.InterceptorResult;
import com.summit.core.runtime.loop.LoopContext;
import com.summit.core.runtime.loop.LoopMessages;
import com.summit.core.runtime.loop.LoopResult;
import com.summit.core.workspace.WorkspaceSpec;
import com.summit.dp.agent.infrastructure.runtime.SessionExecutionRegistry;
import com.summit.dp.email.application.service.EmailService;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.service.ExecutionResumeCoordinator;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

/**
 * 独立验证：{@code SubAgentWaitInterceptor.onBeforeComplete} 的双判据分支。
 *
 * <p>断言的是「行为契约」而非实现细节：只有「根执行 + 会话归属可解 + 仍有未处理协作输入或无未结束子执行」
 * 同时成立时才返回 SUSPENDED（保留已提交轮次驻留），其余情况放行收尾（NONE）。会话归属解不出是
 * <b>数据不一致</b>，按 {@code catchErr=false} 显式上抛、不做降级放行。</p>
 */
class SubAgentWaitInterceptorTest {

    private static final long ROOT_SESSION_ID = 800L;
    private static final long ROOT_AGENT_ID = 7L;

    private final SessionExecutionRegistry registry = mock(SessionExecutionRegistry.class);
    private final EmailService emailService = mock(EmailService.class);
    private final ExecutionResumeCoordinator resumeCoordinator = mock(ExecutionResumeCoordinator.class);
    private final SubAgentWaitInterceptor interceptor =
            new SubAgentWaitInterceptor(registry, emailService, resumeCoordinator);

    private static final WorkspaceSpec TEST_WORKSPACE = new WorkspaceSpec() {
        @Override
        public String provider() {
            return "test";
        }

        @Override
        public String workDir() {
            return "D:/tmp";
        }
    };

    @Test
    @DisplayName("分支1 子执行：带 ROOT_EXECUTION_ID 属性 → 直接 NONE，不查注册表与邮箱（子执行不负责等更下层）")
    void childExecutionSkipsWithoutTouchingCollaborators() {
        LoopContext context = context("1234", Map.of(
                ExecutionAttributes.SESSION_ID, "555",
                ExecutionAttributes.ROOT_EXECUTION_ID, "900"));

        InterceptorResult result = interceptor.onBeforeComplete(context);

        assertTrue(result.shouldContinue(), "子执行收尾就是它自己的结束，必须放行");
        verifyNoInteractions(registry);
        verifyNoInteractions(emailService);
    }

    @Test
    @DisplayName("分支2 根执行但无会话归属：sessionId 抛异常必须上抛为失败（catchErr=false），不降级放行")
    void rootWithoutSessionOwnershipFailsFast() {
        LoopContext context = context("900", Map.of(ExecutionAttributes.AGENT_ID, String.valueOf(ROOT_AGENT_ID)));

        assertThrows(IllegalArgumentException.class, () -> interceptor.onBeforeComplete(context),
                "解不出会话归属属于数据不一致，必须上抛而不是把会话永久卡在挂起态或静默放行");
        verifyNoInteractions(registry);
        verifyNoInteractions(emailService);
    }

    @Test
    @DisplayName("分支3 根执行：无未处理输入且无未结束子 → NONE，正常迁入 COMPLETED")
    void rootWithoutPendingInputOrChildrenCompletes() {
        when(emailService.hasPending(ROOT_SESSION_ID, ROOT_AGENT_ID)).thenReturn(false);
        when(registry.hasUnfinishedChildren(ROOT_SESSION_ID)).thenReturn(false);

        InterceptorResult result = interceptor.onBeforeComplete(rootContext());

        assertTrue(result.shouldContinue());
        verify(registry).hasUnfinishedChildren(ROOT_SESSION_ID);
        verify(emailService).hasPending(ROOT_SESSION_ID, ROOT_AGENT_ID);
        verify(resumeCoordinator, never()).accept(org.mockito.ArgumentMatchers.anyLong());
    }

    @Test
    @DisplayName("分支4 根执行且仅剩未结束子：返回 SUSPENDED，不自我唤醒（等最后一个子终结的结束事实）")
    void rootWithUnfinishedChildrenSuspendsWithoutSelfWake() {
        when(emailService.hasPending(ROOT_SESSION_ID, ROOT_AGENT_ID)).thenReturn(false);
        when(registry.hasUnfinishedChildren(ROOT_SESSION_ID)).thenReturn(true);

        InterceptorResult result = interceptor.onBeforeComplete(rootContext());

        assertFalse(result.shouldContinue(), "有未结束子代理时必须驻留，不能自然完成");
        assertNotNull(result.loopResult(), "驻留分支必须返回一个非 NONE 的结果");
        assertEquals(LoopResult.Status.SUSPENDED, result.loopResult().status(),
                "只有 SUSPENDED 才可被框架 resume；COMPLETED 会永久锁死邮箱");
        assertNotNull(result.loopResult().message());
        verify(resumeCoordinator, never()).accept(org.mockito.ArgumentMatchers.anyLong());
    }

    @Test
    @DisplayName("分支5 根执行且有未处理协作输入：SUSPENDED 且登记保留唤醒（自我唤醒，恢复后由取信钩子消费）")
    void rootWithPendingInputSuspendsAndRegistersSelfWake() {
        when(emailService.hasPending(ROOT_SESSION_ID, ROOT_AGENT_ID)).thenReturn(true);
        when(registry.hasUnfinishedChildren(ROOT_SESSION_ID)).thenReturn(false);

        InterceptorResult result = interceptor.onBeforeComplete(rootContext());

        assertFalse(result.shouldContinue());
        assertEquals(LoopResult.Status.SUSPENDED, result.loopResult().status());
        verify(resumeCoordinator).accept(900L);
    }

    @Test
    @DisplayName("根执行无绑定 Agent：无法解析收件人 → 视为无未处理输入，只看未结束子")
    void rootWithoutAgentIdSkipsMailboxCheck() {
        when(registry.hasUnfinishedChildren(ROOT_SESSION_ID)).thenReturn(true);

        InterceptorResult result = interceptor.onBeforeComplete(context("900",
                Map.of(ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID))));

        assertFalse(result.shouldContinue());
        verify(emailService, never()).hasPending(org.mockito.ArgumentMatchers.anyLong(),
                org.mockito.ArgumentMatchers.anyLong());
    }

    private static LoopContext rootContext() {
        return context("900", Map.of(
                ExecutionAttributes.SESSION_ID, String.valueOf(ROOT_SESSION_ID),
                ExecutionAttributes.AGENT_ID, String.valueOf(ROOT_AGENT_ID)));
    }

    private static LoopContext context(String executionId, Map<String, Object> attributes) {
        List<Message> appended = new ArrayList<>();
        Execution execution = Execution.builder()
                .id(executionId)
                .agentRequest(AgentRequest.builder()
                        .workspaceSpec(TEST_WORKSPACE)
                        .runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes).build())
                        .build())
                .build();
        LoopMessages loopMessages = LoopMessages.builder().execution(execution).build();
        return new LoopContext(loopMessages, new ExecutionControlSignal(executionId), 0, appended::addAll);
    }
}
