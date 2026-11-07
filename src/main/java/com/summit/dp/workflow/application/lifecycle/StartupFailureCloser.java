package com.summit.dp.workflow.application.lifecycle;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.core.runtime.loop.ExecutionControl;
import com.summit.dp.workflow.infrastructure.harness.ExecutionStateCodec;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * 「没能起步的执行怎么收口」的唯一实现，按角色分三种口径。
 *
 * <p><b>为什么必须先判状态</b>：框架入口内与 loop 内的失败它已自行 fail 过，
 * {@code Execution.failChecked} 对已终态会抛「非法状态转换」。</p>
 *
 * <p><b>为什么按角色分</b>：挂起态对根会话与子代理是「还能恢复」，对恢复本身却是
 * 「已批准但没起步」—— 后者必须收口，照抄前者的跳过分支就永远收不了口。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class StartupFailureCloser {

    private final ExecutionControl executionControl;

    /** 收口并原样返回是否真的写过终态；收口自身失败只告警，绝不掩盖原始异常。 */
    public boolean closeQuietly(Execution execution, Exception cause, ExecutionLaunchRole role) {
        if (execution == null) {
            return false;
        }
        try {
            ExecutionState state = execution.getExecutionState();
            if (!closeable(state, role)) {
                return false;
            }
            executionControl.fail(execution, cause).run();
            return true;
        } catch (RuntimeException failFailure) {
            log.warn("收口启动失败的执行时出错: executionId={}, cause={}, 收口失败原因={}",
                    execution.getId(), cause.toString(), failFailure.toString());
            return false;
        }
    }

    /**
     * 各角色真正能收口的状态。
     *
     * <p>{@link ExecutionLaunchRole#SUB_AGENT} 只收 {@code CREATED}：子 loop 一旦跑起来，
     * 它内部的失败由框架自己 fail 过，业务侧再补一次会撞上「非法状态转换」。</p>
     *
     * <p>{@link ExecutionLaunchRole#ROOT} 收 {@code CREATED}/{@code RUNNING}：挂起可恢复，
     * 终态已被框架收过，两者都不能碰。</p>
     *
     * <p>{@link ExecutionLaunchRole#RESUME} 连挂起也收：已批准但恢复没起步必须有个终态。</p>
     */
    private boolean closeable(ExecutionState state, ExecutionLaunchRole role) {
        if (ExecutionStateCodec.isTerminalState(state)) {
            return false;
        }
        return switch (role) {
            case ROOT -> state != ExecutionState.SUSPENDED;
            case SUB_AGENT -> state == ExecutionState.CREATED;
            case RESUME -> true;
        };
    }
}
