package com.summit.dp.turn.infrastructure.listener;

import com.summit.core.conversation.event.ExecutionCancelledEvent;
import com.summit.core.conversation.event.ExecutionCompleteEvent;
import com.summit.core.conversation.event.ExecutionErrorEvent;
import com.summit.core.conversation.event.ExecutionResumedEvent;
import com.summit.core.conversation.event.ExecutionStartEvent;
import com.summit.core.conversation.event.TokenInfo;
import com.summit.core.runtime.RuntimeListener;
import com.summit.dp.turn.application.service.ChatTurnService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * 用运行时事件驱动轮次的「开始执行」与「用量入账」语义。
 *
 * <p><b>职责切分</b>：终态的**状态与结束时间**由 {@link ChatTurnLifecycleListener} 经
 * execution 模块的生命周期端口写（那条路覆盖事件覆盖不到的「取消挂起中的执行」）；
 * 本类只补事件独有的时机 —— 开始时间，以及三个终态事件的**用量**：</p>
 * <ul>
 *   <li>{@code EXECUTION_STARTED} —— 写入首次开始时间。框架的顺序是
 *       「状态转移 → 保存检查点 → 通知」，因此事件到达时 {@code started_at} 所需的一切已就绪；</li>
 *   <li>{@code EXECUTION_RESUMED} —— 恢复执行，**不重置**首次开始时间（总历时从第一次开始算）；</li>
 *   <li>{@code EXECUTION_COMPLETED} / {@code EXECUTION_FAILED} / {@code EXECUTION_CANCELLED}
 *       —— 三个终态事件同形，都带 {@code tokenInfo}（失败/取消带的是**失败前已累计**的部分用量），
 *       统一覆盖写到轮次上。</li>
 * </ul>
 *
 * <p><b>用量为什么挂事件而不是读 execution 表的列</b>：模型与 token 是业务事实，
 * 权威在轮次表 —— 模型由业务受理时解析写入，用量由本回调写入。执行表只留框架自己的
 * 运行记录，同一事实不再两处存放。</p>
 *
 * <p><b>覆盖语义天然幂等</b>：resume 之后再完成会**再发一次** {@code EXECUTION_COMPLETED}
 * （带该执行的最终累计值）。轮次的 {@code refreshUsage} 是覆盖而非累加，
 * 所以重复触发不会把同一执行算两遍。</p>
 *
 * <p><b>{@code tokenInfo} 为 null 一律跳过</b>：那是「未采集到」（例如首轮模型调用之前就失败），
 * 与「确实为 0」严格区分，不猜、不补 0。</p>
 *
 * <p>事件里的 {@code timestamp} 与框架 {@code Execution.startAt} 在同一时刻生成
 * （事件在状态转移之后立刻构造），因此用它作为「开始时间」与实际开始时刻一致到微秒级。</p>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ChatTurnRuntimeListener implements RuntimeListener {

    private static final String LOG_PREFIX = "【chat-turn】";

    private final ChatTurnService chatTurnService;

    @Override
    public void onExecutionStart(ExecutionStartEvent event) {
        if (event == null || event.executionId() == null) {
            return;
        }
        guard("onExecutionStart", event.executionId(),
                () -> chatTurnService.markRunning(event.executionId(), event.timestamp()));
    }

    @Override
    public void onExecutionResumed(ExecutionResumedEvent event) {
        if (event == null || event.executionId() == null) {
            return;
        }
        // 传 null：恢复不是「首次开始」，领域方法只在 startedAt 为空时才赋值。
        guard("onExecutionResumed", event.executionId(),
                () -> chatTurnService.markRunning(event.executionId(), null));
    }

    @Override
    public void onExecutionCompleted(ExecutionCompleteEvent event) {
        if (event == null) {
            return;
        }
        writeUsage(event.executionId(), event.getTokenInfo());
    }

    /** 失败也是终态：带上失败前已累计的用量（首轮之前就失败时为 null，跳过）。 */
    @Override
    public void onExecutionError(ExecutionErrorEvent event) {
        if (event == null) {
            return;
        }
        writeUsage(event.executionId(), event.getTokenInfo());
    }

    /** 取消同理。注意「不活跃的挂起执行被取消」那条路框架不发事件，只有端口 —— 该轮用量保持 null。 */
    @Override
    public void onExecutionCancelled(ExecutionCancelledEvent event) {
        if (event == null) {
            return;
        }
        writeUsage(event.executionId(), event.getTokenInfo());
    }

    /** 三个终态事件的统一用量入口；未采集到（{@code tokenInfo} 为 null）即跳过，不补 0。 */
    private void writeUsage(String executionId, TokenInfo usage) {
        if (executionId == null || usage == null) {
            return;
        }
        guard("refreshUsage", executionId,
                () -> chatTurnService.refreshUsage(executionId,
                        toLong(usage.inputTokenCount()), toLong(usage.outputTokenCount()),
                        toLong(usage.totalTokenCount())));
    }

    /** 框架用量是 {@code Integer}，轮次是 BIGINT（{@code Long}）；null 原样透传，不得当成 0。 */
    private static Long toLong(Integer value) {
        return value == null ? null : value.longValue();
    }

    private void guard(String hook, String executionId, Runnable action) {
        try {
            action.run();
        } catch (RuntimeException e) {
            log.warn("{} {} 失败（不影响执行本身）: executionId={}, error={}",
                    LOG_PREFIX, hook, executionId, e.toString());
        }
    }
}
