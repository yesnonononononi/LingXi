package com.summit.dp.turn.infrastructure.listener;

import com.summit.core.agent.Execution;
import com.summit.core.agent.ExecutionState;
import com.summit.dp.execution.ExecutionEventMetadata;
import com.summit.dp.execution.domain.lifecycle.ExecutionLifecycleListener;
import com.summit.dp.turn.application.service.ChatTurnService;
import com.summit.dp.turn.domain.model.ChatTurnStatus;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * 用 execution 模块的生命周期端口驱动轮次状态：挂起 / 终结。
 *
 * <p><b>为什么用这个端口而不是事件</b>：本端口由 {@code LocalExecutionRepository} 在 loop 边界
 * 广播（{@code unregister} 与「取消一个挂起中的执行」两条路径），它覆盖了事件覆盖不到的一处 ——
 * <b>取消挂起中的执行</b>（{@code requireCancel} 只保存 + 广播本端口，不发事件）。
 * 若不接这里，被用户停掉的等待中轮次会永远停在 WAITING（收尸也不碰 WAITING）。</p>
 *
 * <p><b>终态与结束时间直接取回调传入的已提交 {@link Execution}</b>：广播点刚把执行读回内存，
 * 状态与 {@code completedAt} 都已就绪，无需再查执行摘要。用量不在这里 —— 它由
 * {@link ChatTurnRuntimeListener} 从三个终态事件的 {@code tokenInfo} 覆盖写入；
 * 「取消挂起中的执行」那条路框架不发事件，该轮用量保持 null（未采集到），不猜、不补 0。</p>
 *
 * <p><b>不自行兜异常</b>：广播方 {@code LocalExecutionRepository} 已逐监听器捕获并继续，
 * 这里再包一层只是重复隔离。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ChatTurnLifecycleListener implements ExecutionLifecycleListener {

    private static final String LOG_PREFIX = "【chat-turn】";

    private final ChatTurnService chatTurnService;

    /** 挂起不是终态：只把轮次标为 WAITING，不写结束时间。 */
    @Override
    public void onExecutionSuspended(String executionId, Execution execution) {
        chatTurnService.markWaiting(executionId, resolveRootSessionId(execution));
    }

    @Override
    public void onExecutionFinished(String executionId, Execution execution) {
        ChatTurnStatus status = resolveTerminalStatus(execution);
        if (status == null) {
            // 挂起会走 onExecutionSuspended；这里出现非终态说明调用时序与预期不符，不猜、不改。
            log.debug("{} 终结信号跳过：执行状态不是终态 executionId={}", LOG_PREFIX, executionId);
            return;
        }
        // 用量传 null：它由终态事件单独覆盖写入（本路径也可能在用量已知之后才到达，
        // 而领域的终态写入是「null 不覆盖已知值」，所以先写后写都不会把数字冲掉）。
        chatTurnService.markTerminal(executionId, status, null, null, null, execution.getCompletedAt(),
                resolveRootSessionId(execution));
    }

    /**
     * 已提交执行对象里的根会话身份。
     *
     * <p>端口把 {@code Execution} 一起递过来（广播点本来就已加载），元数据因此是现成的 ——
     * 子执行的根指向发起方，投递才不会落进子会话桶。</p>
     */
    private static Long resolveRootSessionId(Execution execution) {
        return execution == null ? null : ExecutionEventMetadata.parseRootSessionId(execution.eventMetaData());
    }

    /** 框架执行状态 → 业务终态；非终态（含状态缺失）返回 {@code null} 由调用方跳过。 */
    private static ChatTurnStatus resolveTerminalStatus(Execution execution) {
        ExecutionState state = execution == null ? null : execution.getExecutionState();
        if (state == null) {
            return null;
        }
        return switch (state) {
            case COMPLETED -> ChatTurnStatus.COMPLETED;
            case FAILED -> ChatTurnStatus.FAILED;
            case CANCELLED -> ChatTurnStatus.CANCELLED;
            default -> null;
        };
    }
}
