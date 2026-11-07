package com.summit.dp.workflow.application.lifecycle.impl;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.core.runtime.loop.ExecutionRepository;
import com.summit.dp.execution.application.service.ExecutionLocator;
import com.summit.dp.execution.application.service.ResumeDisposition;
import com.summit.dp.workflow.application.input.InputAutomationPolicy;
import com.summit.dp.workflow.application.lifecycle.ExecutionLaunchRole;
import com.summit.dp.workflow.application.lifecycle.ExecutionLaunchSpec;
import com.summit.dp.workflow.application.lifecycle.GateCheckResult;
import com.summit.dp.workflow.application.lifecycle.ResumeAcceptResult;
import com.summit.dp.workflow.application.lifecycle.ResumeRequest;
import com.summit.dp.workflow.application.lifecycle.ResumeTriggerType;
import com.summit.dp.workflow.application.lifecycle.SuspensionGate;
import com.summit.dp.workflow.application.lifecycle.SuspensionGateChain;
import com.summit.dp.workflow.application.lifecycle.UserPauseSuspensionGate;
import com.summit.dp.workflow.application.resume.ExecutionResumeCoordinator;
import com.summit.dp.workflow.application.resume.SuspendedExecutionResumer;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import com.summit.dp.workflow.application.lifecycle.StartupFailureCloser;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

/**
 * 生命周期编排的动作语义回归。
 *
 * <p>守三件事：<b>收口口径按角色分</b>（挂起态对根会话是「可恢复」、对恢复启动是「必须收口」）、
 * <b>手动恢复的顺序</b>（清标记的 save 必须先于 resume，否则控制槽位登记会拒绝）、
 * <b>暂停的竞争容忍</b>（执行刚好结束不算故障）。</p>
 */
class ExecutionLifecycleOrchestratorImplTest {

    private static final String EXECUTION_ID = "900";
    private static final long SESSION_ID = 500L;

    private final ExecutionRepository executionRepository = mock(ExecutionRepository.class);
    private final ExecutionControl executionControl = mock(ExecutionControl.class);
    private final ExecutionLocator executionLocator = mock(ExecutionLocator.class);
    private final SuspendedExecutionResumer resumer = mock(SuspendedExecutionResumer.class);
    private final ExecutionResumeCoordinator resumeCoordinator = mock(ExecutionResumeCoordinator.class);

    private ExecutionLifecycleOrchestratorImpl orchestrator(List<SuspensionGate> gates) {
        return new ExecutionLifecycleOrchestratorImpl(executionRepository, executionControl, executionLocator,
                new SuspensionGateChain(gates), resumer, new StartupFailureCloser(executionControl), resumeCoordinator);
    }

    private ExecutionLifecycleOrchestratorImpl orchestrator() {
        return orchestrator(List.of(new UserPauseSuspensionGate()));
    }

    // ---------------- 启动失败收口 ----------------

    @Test
    @DisplayName("启动失败：按 ROOT 口径收口（终态与挂起态都不覆盖）后原样抛出")
    void submitFailureClosesRootExecutionAndRethrows() {
        Execution execution = execution(ExecutionState.CREATED, new HashMap<>());
        RuntimeException failure = new IllegalStateException("模型调用失败");
        when(executionControl.fail(any(), any())).thenReturn(() -> { });

        RuntimeException thrown = assertThrows(RuntimeException.class, () ->
                orchestrator().submitNewExecution(ExecutionLaunchSpec.create(execution, ExecutionLaunchRole.ROOT,
                        () -> {
                            throw failure;
                        })));

        assertSame(failure, thrown, "原始异常必须原样冒出，不能换成次生异常");
        verify(executionControl).fail(execution, failure);
    }

    @Test
    @DisplayName("启动成功：不安置任何收口")
    void successfulLaunchDoesNotCloseAnything() {
        Execution execution = execution(ExecutionState.RUNNING, new HashMap<>());

        Execution result = orchestrator().submitNewExecution(
                ExecutionLaunchSpec.create(execution, ExecutionLaunchRole.ROOT, () -> execution));

        assertSame(execution, result);
        verify(executionControl, never()).fail(any(), any());
    }

    @Test
    @DisplayName("ROOT 口径：挂起态不收口（挂起可恢复，不是启动失败）")
    void rootRoleSkipsSuspendedExecution() {
        orchestrator().closeFailedStartup(execution(ExecutionState.SUSPENDED, new HashMap<>()),
                new IllegalStateException("x"), ExecutionLaunchRole.ROOT);

        verify(executionControl, never()).fail(any(), any());
    }

    @Test
    @DisplayName("RESUME 口径：挂起态必须收口（已批准但恢复没起步）")
    void resumeRoleClosesSuspendedExecution() {
        Execution execution = execution(ExecutionState.SUSPENDED, new HashMap<>());
        when(executionControl.fail(any(), any())).thenReturn(() -> { });

        orchestrator().closeFailedStartup(execution, new IllegalStateException("x"), ExecutionLaunchRole.RESUME);

        verify(executionControl).fail(eq(execution), any(IllegalStateException.class));
    }

    @Test
    @DisplayName("终态一律不收口（框架已 fail 过，重复 fail 会抛非法状态转换）")
    void terminalExecutionIsNeverClosedAgain() {
        for (ExecutionState state : List.of(ExecutionState.FAILED, ExecutionState.COMPLETED, ExecutionState.CANCELLED)) {
            orchestrator().closeFailedStartup(execution(state, new HashMap<>()),
                    new IllegalStateException("x"), ExecutionLaunchRole.RESUME);
        }

        verify(executionControl, never()).fail(any(), any());
    }

    @Test
    @DisplayName("收口自己失败只告警，绝不掩盖原始异常")
    void closingFailureDoesNotMaskOriginalCause() {
        Execution execution = execution(ExecutionState.CREATED, new HashMap<>());
        IllegalStateException original = new IllegalStateException("原始失败");
        when(executionControl.fail(any(), any())).thenThrow(new IllegalStateException("收口也炸了"));

        RuntimeException thrown = assertThrows(RuntimeException.class, () ->
                orchestrator().submitNewExecution(ExecutionLaunchSpec.create(execution, ExecutionLaunchRole.SUB_AGENT,
                        () -> {
                            throw original;
                        })));

        assertSame(original, thrown);
    }

    // ---------------- 暂停 ----------------

    @Test
    @DisplayName("暂停：执行刚好结束属于正常竞争，不报错，后面的执行照常暂停")
    void pauseToleratesExecutionsThatAlreadyExited() {
        when(executionLocator.activeExecutionIds(SESSION_ID)).thenReturn(List.of("1", "2"));
        doThrow(new IllegalStateException("执行尚未运行或已经结束")).when(executionControl).suspend("1");

        orchestrator().pauseSessionExecution(String.valueOf(SESSION_ID));

        verify(executionControl).suspend("2");
    }

    // ---------------- 手动恢复 ----------------

    @Test
    @DisplayName("手动恢复：门禁阻断时既不 save 也不 resume，原因原样回给调用方")
    void manualResumeStopsAtTheGate() {
        Execution execution = execution(ExecutionState.SUSPENDED,
                new HashMap<>(Map.of(InputAutomationPolicy.USER_PAUSED, true)));
        when(executionRepository.findById(EXECUTION_ID)).thenReturn(Optional.of(execution));
        // 手动触发不会被暂停门禁拦住，这里换成自定义阻断门禁，专测「预检在动任何状态之前」。
        SuspensionGate blocker = alwaysBlocked("请先处理待审批事项");

        ResumeAcceptResult result = orchestrator(List.of(blocker)).requestResume(
                ResumeRequest.create(EXECUTION_ID, SESSION_ID, ResumeTriggerType.MANUAL_USER_RESUME));

        assertTrue(result.blocked());
        assertEquals("请先处理待审批事项", result.reason());
        verify(executionRepository, never()).save(any());
        verify(resumer, never()).resume(any(), anyLong());
    }

    @Test
    @DisplayName("手动恢复：清挂起痕迹的 save 必须先于 resume，且顺带清掉暂停标记")
    void manualResumePersistsClearedMarkersBeforeResume() {
        Execution execution = execution(ExecutionState.SUSPENDED, new HashMap<>(Map.of(
                InputAutomationPolicy.USER_PAUSED, true,
                InputAutomationPolicy.AUTO_ROUNDS, InputAutomationPolicy.MAX_AUTO_ROUNDS)));
        when(executionRepository.findById(EXECUTION_ID)).thenReturn(Optional.of(execution));

        ResumeAcceptResult result = orchestrator().requestResume(
                ResumeRequest.create(EXECUTION_ID, SESSION_ID, ResumeTriggerType.MANUAL_USER_RESUME));

        assertFalse(result.blocked());
        assertEquals(ResumeAcceptResult.ResumeOutcome.RESUMED, result.outcome());
        InOrder order = inOrder(executionRepository, resumer);
        order.verify(executionRepository).save(execution);
        order.verify(resumer).resume(execution, SESSION_ID);
        assertFalse(InputAutomationPolicy.attributes(execution).containsKey(InputAutomationPolicy.USER_PAUSED),
                "手动恢复必须清掉暂停标记，否则控制槽位登记会拒绝");
        assertFalse(InputAutomationPolicy.attributes(execution).containsKey(InputAutomationPolicy.AUTO_ROUNDS));
    }

    @Test
    @DisplayName("手动恢复：非挂起态回明确业务原因，不动状态")
    void manualResumeRequiresSuspendedState() {
        when(executionRepository.findById(EXECUTION_ID))
                .thenReturn(Optional.of(execution(ExecutionState.RUNNING, new HashMap<>())));

        ResumeAcceptResult result = orchestrator().requestResume(
                ResumeRequest.create(EXECUTION_ID, SESSION_ID, ResumeTriggerType.MANUAL_USER_RESUME));

        assertTrue(result.blocked());
        assertEquals("执行不可以恢复", result.reason());
        verify(executionRepository, never()).save(any());
    }

    @Test
    @DisplayName("手动恢复：执行不存在回「没有可恢复的执行」")
    void manualResumeWithoutExecutionIsBlocked() {
        when(executionRepository.findById(EXECUTION_ID)).thenReturn(Optional.empty());

        ResumeAcceptResult result = orchestrator().requestResume(
                ResumeRequest.create(EXECUTION_ID, SESSION_ID, ResumeTriggerType.MANUAL_USER_RESUME));

        assertTrue(result.blocked());
        assertEquals("该会话没有可恢复的执行", result.reason());
    }

    // ---------------- 自动触发 ----------------

    @Test
    @DisplayName("自动触发：入队口径原样映射回执，不在请求线程恢复")
    void automaticTriggerMapsDispositions() {
        when(resumeCoordinator.accept(anyLong())).thenReturn(ResumeDisposition.QUEUED);
        assertEquals(ResumeAcceptResult.ResumeOutcome.QUEUED, orchestrator().requestResume(
                ResumeRequest.create(EXECUTION_ID, SESSION_ID, ResumeTriggerType.AUTO_INPUT_WAKEUP)).outcome());

        when(resumeCoordinator.accept(anyLong())).thenReturn(ResumeDisposition.WAITING_OTHER_TOOLS);
        assertEquals(ResumeAcceptResult.ResumeOutcome.WAITING_UNRESOLVED, orchestrator().requestResume(
                ResumeRequest.create(EXECUTION_ID, SESSION_ID, ResumeTriggerType.AUTO_INPUT_WAKEUP)).outcome());

        when(resumeCoordinator.accept(anyLong())).thenReturn(ResumeDisposition.RUNNING);
        assertEquals(ResumeAcceptResult.ResumeOutcome.RUNNING, orchestrator().requestResume(
                ResumeRequest.create(EXECUTION_ID, SESSION_ID, ResumeTriggerType.AUTO_INPUT_WAKEUP)).outcome());

        when(resumeCoordinator.accept(anyLong())).thenReturn(ResumeDisposition.ENDED);
        assertEquals(ResumeAcceptResult.ResumeOutcome.ENDED, orchestrator().requestResume(
                ResumeRequest.create(EXECUTION_ID, SESSION_ID, ResumeTriggerType.AUTO_INPUT_WAKEUP)).outcome());

        verify(resumer, never()).resume(any(), anyLong());
    }

    private static SuspensionGate alwaysBlocked(String reason) {
        return new SuspensionGate() {
            @Override
            public int order() {
                return 100;
            }

            @Override
            public GateCheckResult checkResumeReadiness(Execution execution, ResumeTriggerType triggerType) {
                return GateCheckResult.blocked(reason);
            }

            @Override
            public void clearSuspensionState(Execution execution, ResumeTriggerType triggerType) {
                // 阻断型门禁没有痕迹要清。
            }
        };
    }

    private static Execution execution(ExecutionState state, Map<String, Object> attributes) {
        AgentRequest request = AgentRequest.builder().executionId(EXECUTION_ID)
                .messages(List.of(UserMessageEntity.from("hi")))
                .runtimeParameters(AgentRuntimeParameters.builder().attributes(attributes).build())
                .build();
        return Execution.builder().id(EXECUTION_ID).agentId("chatAgent").agentRequest(request)
                .executionState(state).build();
    }
}
