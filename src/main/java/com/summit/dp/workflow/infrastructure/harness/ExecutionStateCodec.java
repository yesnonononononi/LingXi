package com.summit.dp.workflow.infrastructure.harness;

import com.summit.core.agent.ExecutionState;

import static com.summit.dp.execution.ExecutionStatusCodes.CREATED;
import static com.summit.dp.execution.ExecutionStatusCodes.RUNNING;
import static com.summit.dp.execution.ExecutionStatusCodes.SUSPENDED;
import static com.summit.dp.execution.ExecutionStatusCodes.COMPLETED;
import static com.summit.dp.execution.ExecutionStatusCodes.FAILED;
import static com.summit.dp.execution.ExecutionStatusCodes.CANCELLED;

/** 框架状态转换只在工作流边界进行，业务状态编码不能随框架声明顺序漂移。 */
public final class ExecutionStateCodec {
    private ExecutionStateCodec() { }

    public static boolean isTerminalState(ExecutionState state) {
        return state != null && state.isTerminal();
    }

    public static int encode(ExecutionState state) {
        return switch (state) {
            case CREATED -> CREATED;
            case RUNNING -> RUNNING;
            case SUSPENDED -> SUSPENDED;
            case COMPLETED -> COMPLETED;
            case FAILED -> FAILED;
            case CANCELLED -> CANCELLED;
        };
    }

    public static ExecutionState decode(int status) {
        return switch (status) {
            case CREATED -> ExecutionState.CREATED;
            case RUNNING -> ExecutionState.RUNNING;
            case SUSPENDED -> ExecutionState.SUSPENDED;
            case COMPLETED -> ExecutionState.COMPLETED;
            case FAILED -> ExecutionState.FAILED;
            case CANCELLED -> ExecutionState.CANCELLED;
            default -> throw new IllegalArgumentException("执行状态编码无法识别: status=" + status);
        };
    }
}
