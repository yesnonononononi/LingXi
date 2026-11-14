package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.*;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.dp.execution.ExecutionAttributes;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.toolcall.domain.repo.ToolCallRepository;
import com.summit.dp.workflow.application.input.InputAutomationPolicy;
import com.summit.dp.workflow.application.input.InputWakeupService;
import com.summit.dp.workflow.infrastructure.harness.ExecutionIdentity;
import com.summit.dp.workflow.infrastructure.lifecycle.SessionExecutionRegistry;
import com.summit.dp.workflow.infrastructure.lifecycle.SubAgentCompleteNotifier;
import com.summit.dp.workflow.infrastructure.lifecycle.SubExecutionLifecycle;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.*;

/**
 * 主会话唤醒契约：<b>任一子会话进入终态即唤醒</b>，不需要等其余子会话交付。
 *
 * <p>守的是两条容易回退的判据：①恢复准入不再问「还有没有兄弟子执行在跑」——问它就等于把已到位
 * 的交付压到最后一个子会话结束；②用户补充要求属于人工发起，自动轮次上限不得吞掉它，
 * 但也不得替用户解暂停。</p>
 */
class SubAgentWakeupContractTest {

    private static final long ROOT_SESSION_ID = 700L;
    private static final long CHILD_SESSION_ID = 701L;
    private static final long ROOT_EXECUTION_ID = 900L;

    private final ToolCallRepository toolCalls = mock(ToolCallRepository.class);
    private final SuspensionGateChain gates = new SuspensionGateChain(List.of(
            new UserPauseSuspensionGate(),
            new UnresolvedToolSuspensionGate(toolCalls)));

    @Test
    @DisplayName("契约：兄弟子会话仍在跑，不阻止根执行被自动唤醒")
    void unfinishedSiblingsNoLongerBlockAutomaticWakeup() {
        assertTrue(gates.checkReadiness(rootExecution(Map.of()), ResumeTriggerType.AUTO_INPUT_WAKEUP).allowed(),
                "子代理交付到位就该唤醒根，兄弟子会话是否结束不该是准入门槛");
    }

    @Test
    @DisplayName("契约：用户补充要求立即唤醒，不受自动轮次上限限制")
    void userSupplementWakesRootEvenAtAutoRoundLimit() {
        Execution execution = rootExecution(Map.of(
                InputAutomationPolicy.AUTO_ROUNDS, InputAutomationPolicy.MAX_AUTO_ROUNDS));

        assertTrue(gates.checkReadiness(execution, ResumeTriggerType.USER_SUPPLEMENT).allowed(),
                "人在推进，自动轮次上限只该约束机器自转");
        assertFalse(gates.checkReadiness(execution, ResumeTriggerType.AUTO_INPUT_WAKEUP).allowed(),
                "自动轮次上限对机器自身的接续仍然生效");
    }

    @Test
    @DisplayName("边界：用户补充不替用户撤销暂停")
    void userSupplementNeverClearsUserPause() {
        Execution paused = rootExecution(Map.of(InputAutomationPolicy.USER_PAUSED, true));

        GateCheckResult result = gates.checkReadiness(paused, ResumeTriggerType.USER_SUPPLEMENT);
        assertFalse(result.allowed(), "人暂停了就保持挂起，补充内容已落库，由人自己决定何时继续");
        assertEquals("执行已由用户暂停", result.reason());
    }

    @Test
    @DisplayName("契约：兄弟子会话仍在跑时，子执行终态照样唤醒根")
    void finishedChildWakesRootEvenWhenSiblingsStillRun() {
        InputWakeupService wakeups = mock(InputWakeupService.class);
        SessionExecutionRegistry registry = mock(SessionExecutionRegistry.class);
        ExecutionLocator locator = mock(ExecutionLocator.class);
        SubAgentCompleteNotifier notifier = mock(SubAgentCompleteNotifier.class);
        SubExecutionLifecycle lifecycle = new SubExecutionLifecycle(registry, wakeups, locator, notifier);
        when(locator.resolveRootSessionIdOrNull(CHILD_SESSION_ID)).thenReturn(ROOT_SESSION_ID);
        // 兄弟子会话还没结束：注销后登记表非空。
        when(registry.unregisterChild(ROOT_SESSION_ID, CHILD_SESSION_ID, "901")).thenReturn(false);

        lifecycle.onFinished(childExecution(ExecutionState.COMPLETED));

        verify(notifier).notifyCommander(org.mockito.ArgumentMatchers.any());
        verify(wakeups).resumeIfInputPending(ROOT_EXECUTION_ID);
    }

    @Test
    @DisplayName("边界：子执行暂停（非终态）不算交付，不唤醒根")
    void suspendedChildDoesNotWakeRoot() {
        InputWakeupService wakeups = mock(InputWakeupService.class);
        SessionExecutionRegistry registry = mock(SessionExecutionRegistry.class);
        ExecutionLocator locator = mock(ExecutionLocator.class);
        SubAgentCompleteNotifier notifier = mock(SubAgentCompleteNotifier.class);
        SubExecutionLifecycle lifecycle = new SubExecutionLifecycle(registry, wakeups, locator, notifier);
        when(locator.resolveRootSessionIdOrNull(CHILD_SESSION_ID)).thenReturn(ROOT_SESSION_ID);
        doThrow(new com.summit.dp.shared.exception.ClientException("只有已结束的子执行可以发送终结提醒"))
                .when(notifier).notifyCommander(org.mockito.ArgumentMatchers.any());

        lifecycle.onFinished(childExecution(ExecutionState.SUSPENDED));

        verify(wakeups, never()).resumeIfInputPending(anyLong());
    }

    private static Execution rootExecution(Map<String, Object> extraAttributes) {
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(ExecutionAttributes.SESSION_ID, ROOT_SESSION_ID);
        attributes.putAll(extraAttributes);
        return Execution.builder().id(String.valueOf(ROOT_EXECUTION_ID)).agentId("chatAgent")
                .agentRequest(request(String.valueOf(ROOT_EXECUTION_ID), attributes))
                .executionState(ExecutionState.SUSPENDED).build();
    }

    private static Execution childExecution(ExecutionState state) {
        Map<String, Object> attributes = new HashMap<>();
        attributes.put(ExecutionAttributes.SESSION_ID, CHILD_SESSION_ID);
        attributes.put(ExecutionAttributes.ROOT_EXECUTION_ID, ROOT_EXECUTION_ID);
        Execution execution = Execution.builder().id("901").agentId("subAgent")
                .agentRequest(request("901", attributes)).executionState(state).build();
        assertEquals(CHILD_SESSION_ID, ExecutionIdentity.sessionId(execution), "用例自身的归属属性必须可解析");
        assertNotNull(execution.getAgentRequest());
        return execution;
    }

    private static AgentRequest request(String executionId, Map<String, Object> attributes) {
        return AgentRequest.builder().executionId(executionId)
                .contextSpec(ContextSpec.builder().context(List.of(UserMessageEntity.from("hi"))).build())
                .runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes).build())
                .build();
    }
}
