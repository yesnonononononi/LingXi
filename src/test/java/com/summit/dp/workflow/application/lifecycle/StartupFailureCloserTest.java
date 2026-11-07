package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.AgentRequest;
import com.summit.core.agent.AgentRuntimeParameters;
import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.conversation.message.UserMessageEntity;
import com.summit.core.runtime.loop.ExecutionControl;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * 「没能起步的执行怎么收口」的三种角色口径。
 *
 * <p>这是全仓唯一的收口判据实现，根会话、子代理、恢复启动三个调用点都只声明角色。
 * 判据改错一次就会把「挂起可恢复」收成失败（用户再也恢复不了），或把「已批准但没起步」
 * 永远挂在那里 —— 所以每种角色、每个状态都要有断言。</p>
 */
class StartupFailureCloserTest {

    private static final String EXECUTION_ID = "900";

    private final ExecutionControl executionControl = mock(ExecutionControl.class);
    private final StartupFailureCloser closer = new StartupFailureCloser(executionControl);

    @Test
    @DisplayName("ROOT：CREATED 收口，挂起态不收（挂起可恢复，不是启动失败）")
    void rootRoleClosesCreatedButSkipsSuspended() {
        Execution created = execution(ExecutionState.CREATED);
        when(executionControl.fail(any(), any())).thenReturn(() -> { });

        assertTrue(closer.closeQuietly(created, new IllegalStateException("线程池已满"), ExecutionLaunchRole.ROOT),
                "根会话未运行就失败必须收口，否则会话被单飞锁死");
        verify(executionControl).fail(eq(created), any(IllegalStateException.class));

        Execution suspended = execution(ExecutionState.SUSPENDED);
        assertFalse(closer.closeQuietly(suspended, new IllegalStateException("x"), ExecutionLaunchRole.ROOT),
                "根会话的挂起是可恢复状态，收成失败就等于替用户做了放弃的决定");
        verify(executionControl, never()).fail(eq(suspended), any());
    }

    @Test
    @DisplayName("SUB_AGENT：只收 CREATED，已经跑起来的失败由框架自己 fail 过")
    void subAgentRoleClosesOnlyCreated() {
        Execution created = execution(ExecutionState.CREATED);
        when(executionControl.fail(any(), any())).thenReturn(() -> { });

        assertTrue(closer.closeQuietly(created, new IllegalStateException("落库前失败"), ExecutionLaunchRole.SUB_AGENT));

        for (ExecutionState state : List.of(ExecutionState.RUNNING, ExecutionState.SUSPENDED)) {
            assertFalse(closer.closeQuietly(execution(state), new IllegalStateException("x"),
                            ExecutionLaunchRole.SUB_AGENT),
                    "子 loop 跑起来后的失败已由框架 fail 过，再补一次会撞「非法状态转换」: " + state);
        }
    }

    @Test
    @DisplayName("RESUME：挂起态必须收口（已批准但恢复没起步）")
    void resumeRoleClosesSuspendedExecution() {
        Execution suspended = execution(ExecutionState.SUSPENDED);
        when(executionControl.fail(any(), any())).thenReturn(() -> { });

        assertTrue(closer.closeQuietly(suspended, new IllegalStateException("恢复没起步"), ExecutionLaunchRole.RESUME),
                "已批准但恢复没起步必须有个终态，否则请求永远悬着");
        verify(executionControl).fail(eq(suspended), any(IllegalStateException.class));
    }

    @Test
    @DisplayName("终态一律不收口（框架已 fail 过，重复 fail 会抛非法状态转换）")
    void terminalExecutionIsNeverClosedAgain() {
        for (ExecutionState state : List.of(ExecutionState.FAILED, ExecutionState.COMPLETED, ExecutionState.CANCELLED)) {
            for (ExecutionLaunchRole role : ExecutionLaunchRole.values()) {
                assertFalse(closer.closeQuietly(execution(state), new IllegalStateException("x"), role),
                        "终态不可再收口: state=" + state + ", role=" + role);
            }
        }
        verify(executionControl, never()).fail(any(), any());
    }

    @Test
    @DisplayName("收口自己失败只告警并返回 false，绝不把异常抛给调用方掩盖原始原因")
    void closingFailureIsSwallowedAndReportedAsFalse() {
        Execution execution = execution(ExecutionState.CREATED);
        IllegalStateException original = new IllegalStateException("原始失败");
        when(executionControl.fail(any(), any())).thenThrow(new IllegalStateException("收口也炸了"));

        assertFalse(closer.closeQuietly(execution, original, ExecutionLaunchRole.ROOT),
                "收口失败必须以返回值表达，不能抛 —— 调用方正在抛原始异常的半路上");
    }

    @Test
    @DisplayName("执行对象缺失时无事可收，直接返回 false")
    void nullExecutionIsSkipped() {
        assertFalse(closer.closeQuietly(null, new IllegalStateException("x"), ExecutionLaunchRole.ROOT));
        verify(executionControl, never()).fail(any(), any());
    }

    private static Execution execution(ExecutionState state) {
        AgentRequest request = AgentRequest.builder().executionId(EXECUTION_ID)
                .messages(List.of(UserMessageEntity.from("hi")))
                .runtimeParameters(AgentRuntimeParameters.builder().attributes(new HashMap<>()).build())
                .build();
        return Execution.builder().id(EXECUTION_ID).agentId("chatAgent").agentRequest(request)
                .executionState(state).build();
    }
}
